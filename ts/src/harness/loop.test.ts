import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { buildGeneralRegistry } from '../tools/generalTools'
import { buildSystemPrompt } from './systemPrompt'
import { scriptedModel } from './fakeModel'
import { runAgentLoop } from './loop'
import type { AgentEvent } from '../types/events'
import type { AssistantStep, Model } from '../types/model'
import { ToolRegistry } from '../tools/registry'
import { executeApproved, handleReject } from './loop'
import { resetDenialStore } from '../permissions/denialTracking'
import type { Tool } from '../tools/Tool'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

test('runs a multi-step tool task: think -> tool -> feed back -> think -> final', async () => {
  writeFileSync(join(root, 'src.txt'), 'payload')
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', text: '先读源文件', calls: [{ id: '1', name: 'read_file', input: { path: 'src.txt' } }] },
    { kind: 'tool_calls', text: '再写出去', calls: [{ id: '2', name: 'write_file', input: { path: 'out.txt', content: 'payload!' } }] },
    { kind: 'final', text: '完成:已把 src.txt 复制加工到 out.txt' },
  ]
  const model = scriptedModel(steps)
  const events = await collect(runAgentLoop({
    model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
    systemPrompt: 'SYS', userMessage: '把 src.txt 加工写进 out.txt',
  }))
  expect(events.map(e => e.type)).toEqual([
    'thinking', 'tool_call', 'tool_result', 'thinking', 'tool_call', 'tool_result', 'final',
  ])
  expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('payload!')
  // 第 2 次 model.step:system 走独立字段 + 有一条 user 消息含 tool_result 块 content==='payload'
  const second = model.received[1]!
  expect(second.system).toBe('SYS')
  const hasResult = second.messages.some(
    m => m.role === 'user' && m.content.some(b => b.type === 'tool_result' && b.content === 'payload'),
  )
  expect(hasResult).toBe(true)
  // 且没有任何 role:'tool' 消息(Anthropic 格式)
  expect(second.messages.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
})

// 工具错误回灌不崩,且带 <tool_use_error> + is_error
test('a tool error is fed back as tool_use_error, loop keeps going', async () => {
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'read_file', input: { path: 'missing.txt' } }] },
    { kind: 'final', text: '文件不在,我改用别的办法' },
  ]
  const model = scriptedModel(steps)
  const events = await collect(runAgentLoop({
    model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
    systemPrompt: 'SYS', userMessage: 'x',
  }))
  const result = events.find(e => e.type === 'tool_result')
  expect(result && result.type === 'tool_result' && result.output).toContain('错误')
  expect(events.at(-1)).toEqual({ type: 'final', text: '文件不在,我改用别的办法' })
  const errBlock = model.received[1]!.messages
    .flatMap(m => m.content)
    .find(b => b.type === 'tool_result' && b.tool_use_id === '1')
  expect(errBlock && errBlock.type === 'tool_result' && errBlock.is_error).toBe(true)
  expect(errBlock && errBlock.type === 'tool_result' && errBlock.content).toContain('<tool_use_error>')
})

test('an unknown tool is fed back as an error, not a crash', async () => {
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'no_such_tool', input: {} }] },
    { kind: 'final', text: 'ok' },
  ]
  const events = await collect(
    runAgentLoop({
      model: scriptedModel(steps), registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  const result = events.find(e => e.type === 'tool_result')
  expect(result && result.type === 'tool_result' && result.output).toContain('未知工具')
})

test('the <env> block reaches the model via the system field', async () => {
  const model = scriptedModel([{ kind: 'final', text: 'done' }])
  const ws = new Workspace(root)
  const systemPrompt = await buildSystemPrompt(ws)
  await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: ws,
      systemPrompt, userMessage: 'hi',
    }),
  )
  expect(model.received[0]!.system).toContain('<env>')
  expect(model.received[0]!.system).toContain(`Working directory: ${ws.root}`)
})

test('max_turns fallback forces a final and terminates', async () => {
  // 模型每轮都要求工具、永不收敛;maxTurns=2 后强制一次无工具收敛
  const forever: AssistantStep = { kind: 'tool_calls', calls: [{ id: 'x', name: 'list_dir', input: {} }] }
  const model = scriptedModel([forever, forever, { kind: 'final', text: '被迫收尾' }])
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', maxTurns: 2,
    }),
  )
  expect(events.at(-1)?.type).toBe('final')
  // 强制收敛那一步是"无工具"的
  expect(model.received.at(-1)!.tools).toEqual([])
})

// —— 追加到 loop.test.ts:审批闸(顶部按需补 import)——

const SECRET = 'loop-test-secret'

/** fixture:一个"对外触达"工具,requiresApproval=true,execute 记录是否真跑过。 */
function outreachTool(spy: { ran: boolean }): Tool<{ msg?: string }> {
  return {
    name: 'send_message', description: '', inputSchema: { type: 'object' },
    isReadOnly: false, requiresApproval: true, approvalClass: 'outreach',
    async execute() { spy.ran = true; return 'SENT' },
  }
}

test('审批闸:requiresApproval 工具 → 吐 approval_request + 回灌待确认,不执行(提案模式)', async () => {
  process.env.SECRET_KEY = SECRET
  resetDenialStore()
  const spy = { ran: false }
  const reg = new ToolRegistry([outreachTool(spy)])
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: 'a', name: 'send_message', input: { msg: 'hi' } }] },
    { kind: 'final', text: '我打算给顾客发条消息,确认下?' },
  ]
  const events = await collect(
    runAgentLoop({ model: scriptedModel(steps), registry: reg, workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', permissionMode: 'ask', conversationId: 'conv1' }),
  )
  const ap = events.find(e => e.type === 'approval_request')
  expect(ap && ap.type === 'approval_request' && ap.tool).toBe('send_message')
  expect(ap && ap.type === 'approval_request' && ap.token.length).toBeGreaterThan(0)
  expect(spy.ran).toBe(false) // 关键:循环里没真发
  const tr = events.find(e => e.type === 'tool_result')
  expect(tr && tr.type === 'tool_result' && tr.output).toContain('待用户确认')
})

test('executeApproved:token 对 → 真执行;token 错 → 校验失败不执行', async () => {
  process.env.SECRET_KEY = SECRET
  resetDenialStore()
  const spy = { ran: false }
  const reg = new ToolRegistry([outreachTool(spy)])
  const ctx = { workspace: new Workspace(root), conversationId: 'conv1' }
  const { signApproval } = await import('../permissions/approval')
  const good = await executeApproved(reg, 'send_message', { msg: 'hi' }, signApproval('send_message', { msg: 'hi' }, SECRET), ctx)
  expect(good.ok).toBe(true)
  expect(good.output).toContain('SENT')
  expect(spy.ran).toBe(true)
  const bad = await executeApproved(reg, 'send_message', { msg: 'TAMPERED' }, signApproval('send_message', { msg: 'hi' }, SECRET), ctx)
  expect(bad.ok).toBe(false)
  expect(bad.output).toContain('校验')
})

test('拒绝 2 次后:同一动作不再弹卡,回灌"先不做了"', async () => {
  process.env.SECRET_KEY = SECRET
  resetDenialStore()
  const spy = { ran: false }
  const reg = new ToolRegistry([outreachTool(spy)])
  const ctx = { workspace: new Workspace(root), conversationId: 'conv2' }
  handleReject('send_message', { msg: 'hi' }, ctx)
  handleReject('send_message', { msg: 'hi' }, ctx)
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: 'a', name: 'send_message', input: { msg: 'hi' } }] },
    { kind: 'final', text: 'ok 不发了' },
  ]
  const events = await collect(
    runAgentLoop({ model: scriptedModel(steps), registry: reg, workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', permissionMode: 'ask', conversationId: 'conv2' }),
  )
  expect(events.some(e => e.type === 'approval_request')).toBe(false) // 不再弹卡
  const tr = events.find(e => e.type === 'tool_result')
  expect(tr && tr.type === 'tool_result' && tr.output).toContain('先不做了')
})

test('Delta A:write_file 在 ask 档仍直接执行、不弹卡', async () => {
  resetDenialStore()
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: 'a', name: 'write_file', input: { path: 'o.txt', content: 'x' } }] },
    { kind: 'final', text: '写好了' },
  ]
  const events = await collect(
    runAgentLoop({ model: scriptedModel(steps), registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', permissionMode: 'ask' }),
  )
  expect(events.some(e => e.type === 'approval_request')).toBe(false)
  expect(readFileSync(join(root, 'o.txt'), 'utf8')).toBe('x')
})

test('审批闸:previewFor 抛错 → 退化成无预览、照样弹卡不崩循环(工具执行永不抛也覆盖预览)', async () => {
  process.env.SECRET_KEY = SECRET
  resetDenialStore()
  const spy = { ran: false }
  const boomTool: Tool<{ msg?: string }> = {
    name: 'send_message', description: '', inputSchema: { type: 'object' },
    isReadOnly: false, requiresApproval: true, approvalClass: 'outreach',
    previewFor() { throw new Error('boom') },
    async execute() { spy.ran = true; return 'SENT' },
  }
  const reg = new ToolRegistry([boomTool])
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: 'a', name: 'send_message', input: { msg: 'hi' } }] },
    { kind: 'final', text: '算预览时崩了,但我还是先请示' },
  ]
  const events = await collect(
    runAgentLoop({ model: scriptedModel(steps), registry: reg, workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', permissionMode: 'ask', conversationId: 'conv3' }),
  )
  const ap = events.find(e => e.type === 'approval_request')
  expect(ap && ap.type === 'approval_request' && ap.tool).toBe('send_message') // (a) 照样弹卡
  expect(ap && ap.type === 'approval_request' && ap.preview).toBeUndefined()   //     预览退化成 undefined
  expect(events.at(-1)?.type).toBe('final')                                    // (b) 循环没崩、走到 final
  expect(spy.ran).toBe(false)                                                  // (c) 仍是提案模式、没执行
})

// —— 追加:steering(顶部补 import:`import type { Model } from '../types/model'`;Message/AssistantStep/collect/scriptedModel/buildGeneralRegistry/Workspace/root W4a 的 loop.test.ts 已备)——

test('steering:模型想收尾但收件箱有插话 → 不收尾、灌进去接着跑、吐 steering 事件', async () => {
  // 自定义 model:第 1 步就想 final;但我们在它被调用后往共享 inbox 塞一条插话,模拟老板中途说话。
  const inbox: string[] = []
  let calls = 0
  const model: Model = {
    async step() {
      calls++
      if (calls === 1) {
        inbox.push('等一下,改成蓝色') // 老板在第 1 步后插话
        return { kind: 'final', text: '好了(第一版)' }
      }
      return { kind: 'final', text: '改成蓝色了(第二版)' }
    },
  }
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: '做个东西', steerInbox: inbox,
    }),
  )
  // 第一版没直接 final;吐了 steering;最终是第二版
  expect(events.some(e => e.type === 'steering' && e.content === '等一下,改成蓝色')).toBe(true)
  expect(events.at(-1)).toEqual({ type: 'final', text: '改成蓝色了(第二版)' })
  // 模型第 2 次 step 时确实看到了 [用户补充/纠偏] 消息
  // (calls===2 时 messages 已含 steering user 消息)
  expect(calls).toBe(2)
})

test('steering:每批工具后 drain,插话在下一次 model.step 前进 messages', async () => {
  const inbox: string[] = []
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'list_dir', input: {} }] },
    { kind: 'final', text: 'done' },
  ]
  let i = 0
  const received: { messages: import('../types/message').Message[] }[] = []
  const model: Model = {
    async step(input) {
      received.push({ messages: input.messages.slice() })
      if (i === 0) inbox.push('顺便看看 src') // 第 1 步(出工具)后插话
      return steps[i++]!
    },
  }
  await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', steerInbox: inbox,
    }),
  )
  // 第 2 次 step 的 messages 里有一条 user 消息、其中一个 text 块含 [用户补充/纠偏] 顺便看看 src
  expect(
    received[1]!.messages.some(
      m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('[用户补充/纠偏] 顺便看看 src')),
    ),
  ).toBe(true)
})

test('无 steering 时行为不回归(W4a 收尾照常)', async () => {
  const events = await collect(
    runAgentLoop({
      model: scriptedModel([{ kind: 'final', text: '直接收尾' }]),
      registry: buildGeneralRegistry(), workspace: new Workspace(root), systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  expect(events).toEqual([{ type: 'final', text: '直接收尾' }])
})

// —— 追加:todo 发射 + 进度提醒 + plan 提醒 ——
test('todo_write 调用后吐 todo_update 事件', async () => {
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'todo_write', input: { todos: ['一', '二'] } }] },
    { kind: 'final', text: 'ok' },
  ]
  const events = await collect(
    runAgentLoop({
      model: scriptedModel(steps), registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  const tu = events.find(e => e.type === 'todo_update')
  expect(tu && tu.type === 'todo_update' && tu.content).toContain('共 2 步')
})

test('task_progress 内联清单被剥离 + 更新 todos + 吐 todo_update(工具本身照跑)', async () => {
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'list_dir', input: { path: '.', task_progress: '- [x] 建目录\n- [ ] 写文件' } }] },
    { kind: 'final', text: 'ok' },
  ]
  const model: Model = {
    async step() {
      // 记录第 2 次 step 前 list_dir 实际收到的入参(task_progress 应已被剥掉)
      return steps.shift()!
    },
  }
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root), systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  const tu = events.find(e => e.type === 'todo_update')
  expect(tu && tu.type === 'todo_update' && tu.content).toContain('已完成 1 步')
  // list_dir 仍成功执行(有 tool_result、不是"参数非法")
  const tr = events.find(e => e.type === 'tool_result' && e.tool === 'list_dir')
  expect(tr && tr.type === 'tool_result' && tr.output).not.toContain('错误')
})

test('plan 档:每轮注入 plan system-reminder(模型能在 messages 里看到)', async () => {
  const received: { messages: import('../types/message').Message[] }[] = []
  const model: Model = {
    async step(input) {
      received.push({ messages: input.messages.slice() })
      return received.length === 1
        ? { kind: 'tool_calls', calls: [{ id: '1', name: 'list_dir', input: {} }] }
        : { kind: 'final', text: 'ok' }
    },
  }
  await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', permissionMode: 'plan',
    }),
  )
  // 第 2 次 step 的 messages 里有一条 user 消息、其中一个 text 块含 <system-reminder> 包壳的计划模式说明
  expect(
    received[1]!.messages.some(
      m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('<system-reminder>') && b.text.includes('计划模式')),
    ),
  ).toBe(true)
})

test('连调 PROGRESS_REMIND_EVERY 次工具没更新进度 → 注入进度提醒', async () => {
  // 6 次 list_dir 再 final(maxTurns 放大到能跑完)
  const steps: AssistantStep[] = [
    ...Array.from({ length: 6 }, (_, k) => ({ kind: 'tool_calls' as const, calls: [{ id: `${k}`, name: 'list_dir', input: {} }] })),
    { kind: 'final' as const, text: 'ok' },
  ]
  const received: { messages: import('../types/message').Message[] }[] = []
  const model: Model = { async step(input) { received.push({ messages: input.messages.slice() }); return steps.shift()! } }
  await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', maxTurns: 8,
    }),
  )
  // 最后一次 step 前,messages 里出现一条 user 消息、含进度提醒 text 块
  const last = received.at(-1)!
  expect(
    last.messages.some(
      m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text.includes('<system-reminder>') && b.text.includes('更新进度')),
    ),
  ).toBe(true)
})

// —— 追加:thinking 白标契约(不回灌模型)—— tool_calls 分支(合并展示)与 final 分支(单独展示)都验一遍
test('thinking 只展示、不进 assistant 历史(白标:reasoning 不回灌模型)——tool_calls 分支', async () => {
  // 注:用会 .slice() 快照 messages 的自定义 model,而非 scriptedModel——scriptedModel.received[i].messages
  // 存的是 loop 内部那个持续 push 的活引用,循环跑完后所有下标都会指向同一个"最终态"数组,不能拿来做
  // "第 2 次调用时看到什么"的精确断言(其余用到 received[] 精确断言的用例也都遵循这个 .slice() 惯例)。
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', text: '正文', thinking: '内心戏A', calls: [{ id: '1', name: 'list_dir', input: {} }] },
    { kind: 'final', text: '收尾' },
  ]
  const received: { messages: import('../types/message').Message[] }[] = []
  const model: Model = { async step(input) { received.push({ messages: input.messages.slice() }); return steps.shift()! } }
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  // thinking + 正文合并成一条 thinking 事件(展示用)
  expect(events.some(e => e.type === 'thinking' && e.text === '内心戏A\n\n正文')).toBe(true)
  // 第 2 次 step 看到的历史里,step1 的 assistant 消息只有 text+tool_use,没有 thinking 类型块/字样
  const assistantMsgs = received[1]!.messages.filter(m => m.role === 'assistant')
  expect(assistantMsgs).toEqual([{
    role: 'assistant',
    content: [
      { type: 'text', text: '正文' },
      { type: 'tool_use', id: '1', name: 'list_dir', input: {} },
    ],
  }])
})

test('thinking 只展示、不进 assistant 历史(白标:reasoning 不回灌模型)——final 分支', async () => {
  // 自定义 model:第 1 步 final 但带 thinking;紧接着插一条话逼出第 2 次 step,好观察第 1 版的 assistant 历史。
  const inbox: string[] = []
  const received: { messages: import('../types/message').Message[] }[] = []
  let calls = 0
  const model: Model = {
    async step(input) {
      received.push({ messages: input.messages.slice() })
      calls++
      if (calls === 1) {
        inbox.push('再想想')
        return { kind: 'final', text: '第一版', thinking: '内心戏-final' }
      }
      return { kind: 'final', text: '第二版' }
    },
  }
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', steerInbox: inbox,
    }),
  )
  // final 分支的 thinking 单独吐一条事件(不跟 text 合并,照 loop.ts 的 final 分支逻辑)
  expect(events.some(e => e.type === 'thinking' && e.text === '内心戏-final')).toBe(true)
  // 第 2 次 step 看到的历史里,第一版的 assistant 消息只有 text 块、没有 thinking 块/字样
  const assistantMsgs = received[1]!.messages.filter(m => m.role === 'assistant')
  expect(assistantMsgs).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '第一版' }] }])
})
