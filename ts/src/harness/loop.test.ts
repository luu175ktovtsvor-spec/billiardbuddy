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
  const events = await collect(
    runAgentLoop({
      model,
      registry: buildGeneralRegistry(),
      workspace: new Workspace(root),
      systemPrompt: 'SYS',
      userMessage: '把 src.txt 加工写进 out.txt',
    }),
  )
  expect(events.map(e => e.type)).toEqual([
    'thinking', 'tool_call', 'tool_result', 'thinking', 'tool_call', 'tool_result', 'final',
  ])
  expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('payload!')
  // 工具结果真的回灌进了 messages(第 2 次 model.step 应看到 role:tool 消息)
  const secondCallMessages = model.received[1]!.messages
  expect(secondCallMessages.some(m => m.role === 'tool' && m.content === 'payload')).toBe(true)
})

test('a tool error is fed back as text, the loop keeps going (does not crash)', async () => {
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'read_file', input: { path: 'missing.txt' } }] },
    { kind: 'final', text: '文件不在,我改用别的办法' },
  ]
  const model = scriptedModel(steps)
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  const result = events.find(e => e.type === 'tool_result')
  expect(result && result.type === 'tool_result' && result.output).toContain('错误')
  expect(events.at(-1)).toEqual({ type: 'final', text: '文件不在,我改用别的办法' })
  // 模型在下一步确实收到了错误文本回灌
  const fedBack = model.received[1]!.messages.some(m => m.role === 'tool' && m.content.includes('错误'))
  expect(fedBack).toBe(true)
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

test('the <env> block reaches the model in the system message', async () => {
  const model = scriptedModel([{ kind: 'final', text: 'done' }])
  const ws = new Workspace(root)
  const systemPrompt = await buildSystemPrompt(ws)
  await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: ws,
      systemPrompt, userMessage: 'hi',
    }),
  )
  const firstMessages = model.received[0]!.messages
  const system = firstMessages.find(m => m.role === 'system')
  expect(system?.content).toContain('<env>')
  expect(system?.content).toContain(`Working directory: ${ws.root}`)
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
  // 第 2 次 step 的 messages 里有 [用户补充/纠偏] 顺便看看 src
  expect(received[1]!.messages.some(m => m.role === 'user' && m.content.includes('[用户补充/纠偏] 顺便看看 src'))).toBe(true)
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
