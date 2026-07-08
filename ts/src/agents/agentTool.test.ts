import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import { Workspace } from '../workspace/workspace'
import { fileReadTool } from '../tools/fileReadTool'
import { fileWriteTool } from '../tools/fileWriteTool'
import { ToolRegistry } from '../tools/registry'
import { createAgentTaskSidechainTools, createAgentTaskTool } from './agentTool'
import type { AgentDefinition } from './agentLoader'
import { getAgentMemoryEntrypoint } from './agentMemory'
import { handleReject, runAgentLoop } from '../harness/loop'
import { buildChildMessage } from './forkSubagent'
import { textBlock, type Message } from '../types/message'

function agent(partial: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'researcher',
    description: '研究代理',
    prompt: '你只做研究。',
    filePath: '/agents/researcher.md',
    tools: ['read_file'],
    ...partial,
  }
}

async function collect(gen: AsyncGenerator<import('../types/events').AgentEvent>): Promise<import('../types/events').AgentEvent[]> {
  const out: import('../types/events').AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

test('agent_task runs an isolated subagent loop and returns only final text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    writeFileSync(join(root, 'data.txt'), 'payload')
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: '1', name: 'read_file', input: { path: 'data.txt' } }] },
      { kind: 'final', text: '子代理结论:payload' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent()],
      model,
      baseTools: [fileReadTool, fileWriteTool],
      baseSystemPrompt: 'BASE',
      sidechainRoot: join(root, 'sidechains'),
    })
    const progress: string[] = []
    const out = await tool.execute({ task: '读 data.txt' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      progressEmit: event => progress.push(event.chunk),
    })
    expect(out).toContain('<agent_task agent="researcher" agent_id="agent_')
    expect(out).toContain('\n子代理结论:payload\n</agent_task>')
    expect(progress.join('')).toContain('子代理 researcher 开始:读 data.txt')
    expect(progress.join('')).toContain('子代理 researcher 调用 read_file: data.txt')
    expect(progress.join('')).toContain('子代理 researcher 结论:子代理结论:payload')
    expect(model.received[0]!.system).toContain('BASE')
    expect(model.received[0]!.system).toContain('<subagent name="researcher">')
    expect(model.received[0]!.tools.map(t => t.name)).toEqual(['read_file'])
    expect(model.received[1]!.messages.some(m => m.content.some(b => b.type === 'tool_result' && b.content === 'payload'))).toBe(true)
    const transcriptDir = join(root, 'sidechains', 'transcripts')
    const transcriptFile = readdirSync(transcriptDir).find(name => name.endsWith('.jsonl') && !name.includes('content-replacements'))
    expect(transcriptFile).toBeTruthy()
    const transcriptText = readFileSync(join(transcriptDir, transcriptFile!), 'utf8')
    expect(transcriptText).toContain('读 data.txt')
    expect(transcriptText).toContain('子代理结论:payload')
    const metadataText = readFileSync(join(transcriptDir, transcriptFile!.replace(/\.jsonl$/, '.meta.json')), 'utf8')
    expect(metadataText).toContain('"agentType": "researcher"')
    expect(metadataText).toContain('"parentConversationId"')
    const agentId = out.match(/agent_id="([^"]+)"/)?.[1]
    expect(agentId).toBeTruthy()
    const readSidechain = createAgentTaskSidechainTools(join(root, 'sidechains')).find(t => t.name === 'read_agent_task_sidechain')!
    const sidechainOutput = await readSidechain.execute({ agent_id: agentId }, { workspace: new Workspace(root) })
    expect(sidechainOutput).toContain(`<agent_task_sidechain id="${agentId}" status="ok"`)
    expect(sidechainOutput).toContain('<tool_result tool_use_id="1">payload</tool_result>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task rejects recursive launch inside a fork child conversation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-fork-guard-'))
  try {
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'nested-agent', name: 'agent_task', input: { task: '再开一个子代理' } }] },
      { kind: 'final', text: '已改为直接执行' },
    ])
    const registry = new ToolRegistry([
      createAgentTaskTool({
        agents: [agent()],
        model,
        baseTools: [],
        sidechainRoot: join(root, 'sidechains'),
      }),
    ])

    const events = await collect(runAgentLoop({
      model,
      registry,
      workspace: new Workspace(root),
      systemPrompt: 'SYS',
      userMessage: '继续 fork child 任务',
      initialMessages: [{ role: 'user', content: [textBlock(buildChildMessage('检查 parser'))] }],
    }))

    const result = events.find(event => event.type === 'tool_result')
    expect(result && result.type === 'tool_result' ? result.output : '').toContain('Fork worker 内部不能再次启动 agent_task')
    const feedback = model.received[1]!.messages
      .flatMap(message => message.content)
      .find(block => block.type === 'tool_result')
    expect(feedback && feedback.type === 'tool_result' ? feedback.is_error : false).toBe(true)
    expect(feedback && feedback.type === 'tool_result' ? feedback.content : '').toContain('Fork worker 内部不能再次启动 agent_task')
    expect(events.at(-1)).toEqual({ type: 'final', text: '已改为直接执行' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task rejects recursive launch when fork query source survives without boilerplate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-fork-query-source-guard-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent()],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
      sidechainRoot: join(root, 'sidechains'),
    })

    await expect(tool.execute({ task: '再开一个子代理' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      querySource: 'agent:builtin:fork',
      messages: [{ role: 'user', content: [textBlock('compressed fork history without boilerplate')] }],
    })).rejects.toThrow('Fork worker 内部不能再次启动 agent_task')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task fork_context runs a child with parent system, messages and exact tool pool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-fork-context-'))
  try {
    const parentModel = scriptedModel([
      { kind: 'tool_calls', text: 'forking now', calls: [{ id: 'fork-parent', name: 'agent_task', input: { task: '审计 fork runtime', fork_context: true } }] },
      { kind: 'final', text: 'parent done' },
    ])
    const childModel = scriptedModel([{ kind: 'final', text: 'Scope: 审计 fork runtime' }])
    const inspectTool: import('../tools/Tool').Tool = {
      name: 'inspect_parent_tool',
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute() {
        return 'parent tool ok'
      },
    }
    const registry = new ToolRegistry([
      createAgentTaskTool({
        agents: [agent()],
        model: childModel,
        baseTools: [inspectTool],
        sidechainRoot: join(root, 'sidechains'),
      }),
      inspectTool,
    ])

    const events = await collect(runAgentLoop({
      model: parentModel,
      registry,
      workspace: new Workspace(root),
      systemPrompt: 'PARENT SYSTEM',
      userMessage: '父任务',
      conversationId: 'fork-parent-rendered-system',
      hooks: {
        rules: [
          { event: 'SessionStart', handler: payload => ({ action: 'context', additionalContext: `父级动态上下文:${payload.sessionId}` }) },
        ],
      },
    }))

    expect(events.some(event => event.type === 'final' && event.text === 'parent done')).toBe(true)
    const childFirst = childModel.received[0]!
    expect(childFirst.system).toContain('PARENT SYSTEM')
    expect(childFirst.system).toContain('<hook_context event="SessionStart">')
    expect(childFirst.system).toContain('父级动态上下文:fork-parent-rendered-system')
    expect(childFirst.tools.map(tool => tool.name)).toEqual(['agent_task', 'inspect_parent_tool'])
    expect(childFirst.messages[0]).toEqual({ role: 'user', content: [textBlock('父任务')] })
    expect(childFirst.messages[1]).toEqual({
      role: 'assistant',
      content: [
        textBlock('forking now'),
        { type: 'tool_use', id: 'fork-parent', name: 'agent_task', input: { task: '审计 fork runtime', fork_context: true } },
      ],
    })
    expect(childFirst.messages[2]?.role).toBe('user')
    expect(childFirst.messages[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'fork-parent', content: 'Fork started - processing in background' })
    const directive = childFirst.messages[2]?.content[1]
    expect(directive?.type === 'text' ? directive.text : '').toContain('Your directive: 审计 fork runtime')
    expect(childFirst.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('<subagent name=')),
    )).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task keeps existing single-agent default when fork gate is off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-fork-gate-off-'))
  try {
    const model = scriptedModel([{ kind: 'final', text: '普通子代理仍然默认选唯一 agent' }])
    const tool = createAgentTaskTool({
      agents: [agent()],
      model,
      baseTools: [],
      sidechainRoot: join(root, 'sidechains'),
      env: {},
    })

    const out = await tool.execute({ task: '默认 agent' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
    })

    expect(out).toContain('<agent_task agent="researcher"')
    expect(out).toContain('普通子代理仍然默认选唯一 agent')
    expect(model.received[0]!.system).toContain('<subagent name="researcher">')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task implicit fork gate hides agent fields and forks when agent is omitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-implicit-fork-'))
  try {
    let capturedInput: unknown
    let capturedFork: unknown
    const tool = createAgentTaskTool({
      agents: [agent()],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
      env: { DESKTOP_AGENT_FORK_SUBAGENT: '1' },
      startBackgroundAgent: async (input, _ctx, forkContext) => {
        capturedInput = input
        capturedFork = forkContext
        return {
          task: {
            id: 'implicit_fork_1',
            title: `${input.agent}: ${input.task}`,
            params: { agent_id: 'implicit_fork_1', fork_context: true },
          },
          agent: agent({ name: input.agent ?? 'fork' }),
        }
      },
    })
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['context', 'isolation', 'task'])

    const parentMessages = [
      { role: 'user' as const, content: [textBlock('父请求')] },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'implicit-call', name: 'agent_task', input: { task: '隐式 fork' } }] },
    ]
    const out = await tool.execute({ task: '隐式 fork' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      systemPrompt: 'PARENT SYS',
      messages: parentMessages,
      registry: new ToolRegistry([tool]),
    })

    expect(capturedInput).toEqual({
      agent: 'fork',
      task: '隐式 fork',
      title: 'fork: 隐式 fork',
    })
    expect((capturedFork as { systemPrompt?: string } | undefined)?.systemPrompt).toBe('PARENT SYS')
    expect((capturedFork as { initialMessages?: Message[] } | undefined)?.initialMessages?.[0]).toEqual(parentMessages[0])
    expect((capturedFork as { initialMessages?: Message[] } | undefined)?.initialMessages?.[1]).toEqual(parentMessages[1])
    expect((capturedFork as { initialMessages?: Message[] } | undefined)?.initialMessages?.[2]?.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'implicit-call',
      content: 'Fork started - processing in background',
    })
    expect(out).toContain('<background_task_started id="implicit_fork_1" agent="fork" agent_id="implicit_fork_1" status="queued">')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task sidechain stores aggregate replacements for large subagent tool batches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    const outputA = `A-HEAD\n${'a'.repeat(130_000)}\nA-TAIL`
    const outputB = `B-HEAD\n${'b'.repeat(90_000)}\nB-TAIL`
    const logTool = (name: string, output: string): import('../tools/Tool').Tool => ({
      name,
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute() {
        return output
      },
    })
    const model = scriptedModel([
      {
        kind: 'tool_calls',
        calls: [
          { id: 'log-a', name: 'log_a', input: {} },
          { id: 'log-b', name: 'log_b', input: {} },
        ],
      },
      { kind: 'final', text: '子代理完成大日志分析' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['log_a', 'log_b'] })],
      model,
      baseTools: [logTool('log_a', outputA), logTool('log_b', outputB)],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '分析两份大日志' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_conv',
    })

    expect(out).toContain('子代理完成大日志分析')
    const transcriptDir = join(root, 'sidechains', 'transcripts')
    const transcriptFile = readdirSync(transcriptDir).find(name => name.endsWith('.jsonl') && !name.includes('content-replacements'))
    expect(transcriptFile).toBeTruthy()
    const transcriptId = transcriptFile!.replace(/\.jsonl$/, '')
    const replacementsText = readFileSync(join(transcriptDir, `${transcriptId}.content-replacements.jsonl`), 'utf8')
    expect(replacementsText).toContain('"kind":"tool-result"')
    expect(replacementsText).toContain('<stored_tool_result')
    const transcriptText = readFileSync(join(transcriptDir, transcriptFile!), 'utf8')
    expect(transcriptText).toContain('<stored_tool_result')
    expect(transcriptText).not.toContain('a'.repeat(80_000))
    const toolResultDir = join(root, 'sidechains', 'tool-results', transcriptId)
    const storedFiles = readdirSync(toolResultDir)
    expect(storedFiles.length).toBe(1)
    const readStoredResult = createAgentTaskSidechainTools(join(root, 'sidechains')).find(t => t.name === 'read_agent_task_stored_result')!
    const storedOutput = await readStoredResult.execute({ agent_id: transcriptId, path: storedFiles[0], tail: true, max_bytes: 64 }, { workspace: new Workspace(root) })
    expect(storedOutput).toContain('<stored_tool_result_read status="completed"')
    expect(storedOutput).toContain(`agent_id="${transcriptId}"`)
    expect(storedOutput).toContain('A-TAIL')
    expect(storedOutput).not.toContain('A-HEAD')
    const rejected = await readStoredResult.execute({ agent_id: transcriptId, path: join(root, 'outside.txt') }, { workspace: new Workspace(root) })
    expect(rejected).toContain('status="rejected"')
    const listSidechains = createAgentTaskSidechainTools(join(root, 'sidechains')).find(t => t.name === 'list_agent_task_sidechains')!
    const listOutput = await listSidechains.execute({ parent_conversation_id: 'parent_conv' }, { workspace: new Workspace(root) })
    expect(listOutput).toContain(`id="${transcriptId}"`)
    expect(listOutput).toContain('<task>分析两份大日志</task>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task isolation=worktree runs tools in an isolated git worktree and keeps dirty work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-worktree-'))
  try {
    initGitRepo(root)
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'w1', name: 'write_file', input: { path: 'worker.txt', content: 'from subagent' } }] },
      { kind: 'final', text: '写入完成' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['write_file'] })],
      model,
      baseTools: [fileWriteTool],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '写 worker.txt', isolation: 'worktree' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_conv',
    })

    expect(out).toContain('<agent_worktree status="kept"')
    const worktreePath = out.match(/<agent_worktree status="kept" path="([^"]+)"/)?.[1]
    expect(worktreePath).toBeTruthy()
    expect(existsSync(join(worktreePath!, 'worker.txt'))).toBe(true)
    expect(existsSync(join(root, 'worker.txt'))).toBe(false)
    const transcriptDir = join(root, 'sidechains', 'transcripts')
    const metadataFile = readdirSync(transcriptDir).find(name => name.endsWith('.meta.json'))
    expect(metadataFile).toBeTruthy()
    expect(readFileSync(join(transcriptDir, metadataFile!), 'utf8')).toContain(`"worktreePath": "${worktreePath}"`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task honors agent frontmatter defaults for prompt, permissions, maxTurns and worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-defaults-'))
  try {
    initGitRepo(root)
    let seenPermission = ''
    let seenWorkspace = ''
    const inspectTool: import('../tools/Tool').Tool = {
      name: 'inspect_ctx',
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute(_, ctx) {
        seenPermission = ctx.permissionMode ?? ''
        seenWorkspace = ctx.workspace.root
        return 'ok'
      },
    }
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'i1', name: 'inspect_ctx', input: {} }] },
      { kind: 'final', text: 'fallback final should not be used when maxTurns=1' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({
        tools: ['inspect_ctx', 'write_file'],
        disallowedTools: ['write_file'],
        initialPrompt: '先遵守 agent 初始提示。',
        permissionMode: 'plan',
        maxTurns: 1,
        isolation: 'worktree',
      })],
      model,
      baseTools: [inspectTool, fileWriteTool],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '检查默认值' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_defaults',
    })

    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'text',
      text: '先遵守 agent 初始提示。\n\n检查默认值',
    })
    expect(model.received[0]!.tools.map(t => t.name)).toEqual(['inspect_ctx'])
    expect(seenPermission).toBe('plan')
    expect(seenWorkspace).toContain(join(root, '.claude', 'worktrees'))
    expect(model.received[1]!.tools).toEqual([])
    expect(out).toContain('fallback final should not be used when maxTurns=1')
    expect(out).toContain('<agent_worktree status="removed_clean">')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task uses local denial tracking instead of inheriting parent rejections', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-local-denial-'))
  try {
    const parentCtx = { workspace: new Workspace(root), conversationId: 'parent_denied' }
    handleReject('send_message', { msg: 'hi' }, parentCtx)
    handleReject('send_message', { msg: 'hi' }, parentCtx)
    const guardedTool: import('../tools/Tool').Tool = {
      name: 'send_message',
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: false,
      requiresApproval: true,
      approvalClass: 'outreach',
      async execute() {
        return 'SENT'
      },
    }
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['send_message'] })],
      model: scriptedModel([
        { kind: 'tool_calls', calls: [{ id: 's1', name: 'send_message', input: { msg: 'hi' } }] },
        { kind: 'final', text: '已请求确认' },
      ]),
      baseTools: [guardedTool],
      sidechainRoot: join(root, 'sidechains'),
    })
    const progress: string[] = []
    const out = await tool.execute({ task: '给用户发消息' }, {
      workspace: new Workspace(root),
      permissionMode: 'ask',
      conversationId: 'parent_denied',
      progressEmit: event => progress.push(event.chunk),
    })
    expect(out).toContain('已请求确认')
    expect(progress.join('')).toContain('子代理 researcher 等待确认 send_message')
    expect(progress.join('')).not.toContain('先不做了')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task runs agent frontmatter SubagentStart and Stop as SubagentStop hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-hooks-'))
  try {
    const model = scriptedModel([{ kind: 'final', text: 'hooked final' }])
    const tool = createAgentTaskTool({
      agents: [agent({
        hooks: {
          rules: [
            { event: 'SubagentStart', matcher: 'researcher', handler: payload => ({ action: 'context', additionalContext: `start:${payload.agentId}:${payload.agentType}` }) },
            { event: 'SubagentStop', matcher: 'researcher', handler: payload => ({ action: 'context', additionalContext: `stop:${payload.agentId}:${payload.output}` }) },
          ],
        },
      })],
      model,
      baseTools: [],
      sidechainRoot: join(root, 'sidechains'),
    })
    const progress: string[] = []
    const out = await tool.execute({ task: '跑 hook' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent-hooks',
      progressEmit: event => progress.push(event.chunk),
    })
    const agentId = out.match(/agent_id="([^"]+)"/)?.[1]
    expect(agentId).toBeTruthy()
    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'text',
      text: `<hook_context event="SubagentStart">\nstart:${agentId}:researcher\n</hook_context>`,
    })
    expect(progress.join('')).toContain(`子代理 researcher hook:start:${agentId}:researcher`)
    expect(progress.join('')).toContain(`子代理 researcher 提醒:stop:${agentId}:hooked final`)
    expect(out).toContain('hooked final')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task loads persistent agent memory and allows writing to the memory dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-memory-'))
  const oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  try {
    const memoryPath = getAgentMemoryEntrypoint('researcher', 'user', root)
    mkdirSync(dirname(memoryPath), { recursive: true })
    writeFileSync(memoryPath, 'remember preferred formatter: bun fmt\n', { flag: 'w' })
    const topicPath = join(dirname(memoryPath), 'testing.md')
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'mem-write', name: 'write_file', input: { path: topicPath, content: 'remember test command: bun test\n' } }] },
      { kind: 'final', text: '记忆已更新' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({ memory: 'user', tools: ['read_file'] })],
      model,
      baseTools: [fileReadTool, fileWriteTool],
      baseSystemPrompt: 'BASE',
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '更新长期记忆' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
    })

    expect(model.received[0]!.system).toContain('# Persistent Agent Memory')
    expect(model.received[0]!.system).toContain('remember preferred formatter: bun fmt')
    expect(model.received[0]!.tools.map(tool => tool.name).sort()).toEqual(['read_file', 'write_file'])
    expect(readFileSync(topicPath, 'utf8')).toContain('remember test command: bun test')
    expect(out).toContain('记忆已更新')
  } finally {
    if (oldClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir
    rmSync(root, { recursive: true, force: true })
  }
})

function writeFixtureMcpServer(root: string): string {
  const file = join(root, 'agent-fixture-mcp-server.ts')
  writeFileSync(file, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'agent-fixture', version: '1.0.0' })
server.registerTool('agent_echo', {
  description: 'Echo from an agent-scoped MCP server',
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({
  content: [{ type: 'text', text: 'agent-mcp:' + text }],
}))
await server.connect(new StdioServerTransport())
`)
  return file
}

test('agent_task connects agent frontmatter mcpServers and injects MCP tools', async () => {
  const root = mkdtempSync(join(process.cwd(), '.agent-tool-mcp-'))
  try {
    const fixture = writeFixtureMcpServer(root)
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'mcp1', name: 'mcp__agent_fixture__agent_echo', input: { text: 'hello' } }] },
      { kind: 'final', text: 'MCP 子代理完成' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({
        tools: ['mcp__agent_fixture__agent_echo'],
        mcpServers: [{ 'agent fixture': { command: process.execPath, args: [fixture] } }],
        requiredMcpServers: ['agent fixture'],
      })],
      model,
      baseTools: [],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '调用 agent MCP' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
    })

    expect(model.received[0]!.tools.map(tool => tool.name)).toContain('mcp__agent_fixture__agent_echo')
    expect(model.received[1]!.messages.some(message =>
      message.content.some(block => block.type === 'tool_result' && block.content.includes('agent-mcp:hello')),
    )).toBe(true)
    expect(out).toContain('MCP 子代理完成')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task rejects agents whose required MCP servers are unavailable', async () => {
  const root = mkdtempSync(join(process.cwd(), '.agent-tool-mcp-required-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent({ requiredMcpServers: ['missing-server'] })],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
    })
    await expect(tool.execute({ task: '需要 MCP' }, { workspace: new Workspace(root) }))
      .rejects.toThrow(/requires MCP servers matching: missing-server/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task launches background task when agent definition has background true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-background-default-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent({ background: true, isolation: 'worktree' })],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
      startBackgroundAgent: async (input) => ({
        task: { id: 'bg_agent_1', title: `${input.agent}: ${input.task}`, params: { agent_id: 'bg_agent_1' } },
        agent: agent({ name: input.agent ?? 'researcher' }),
      }),
    })
    const out = await tool.execute({ task: '后台默认执行' }, { workspace: new Workspace(root) })
    expect(out).toContain('<background_task_started id="bg_agent_1" agent="researcher" agent_id="bg_agent_1" status="queued">')
    expect(out).toContain('researcher: 后台默认执行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task supports CC-Haha run_in_background and named SendMessage targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-background-param-'))
  try {
    let capturedInput: unknown
    const tool = createAgentTaskTool({
      agents: [agent()],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
      startBackgroundAgent: async (input) => {
        capturedInput = input
        return {
          task: {
            id: 'bg_agent_param_1',
            title: `${input.agent}: ${input.task}`,
            params: { name: input.name, agent_id: 'stable_bg_agent_1' },
          },
          agent: agent({ name: input.agent ?? 'researcher' }),
        }
      },
    })
    const out = await tool.execute({
      task: '后台研究索引',
      name: 'indexer',
      run_in_background: true,
      isolation: 'worktree',
    }, { workspace: new Workspace(root) })
    expect(capturedInput).toEqual({
      agent: 'researcher',
      name: 'indexer',
      task: '后台研究索引',
      title: 'researcher: 后台研究索引',
      isolation: 'worktree',
    })
    expect(out).toContain('<background_task_started id="bg_agent_param_1" agent="researcher" name="indexer" agent_id="stable_bg_agent_1" status="queued">')
    expect(out).toContain('researcher: 后台研究索引')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task requires agent name when multiple agents are available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent({ name: 'a' }), agent({ name: 'b' })],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
    })
    await expect(tool.execute({ task: 'x' }, { workspace: new Workspace(root) })).rejects.toThrow(/需要指定 agent/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task rejects unknown agent and validates task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent()],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
    })
    await expect(tool.execute({ agent: 'missing', task: 'x' }, { workspace: new Workspace(root) })).rejects.toThrow(/需要指定 agent/)
    // @ts-expect-error 故意传非法入参
    await expect(tool.execute({ agent: 'researcher' }, { workspace: new Workspace(root) })).rejects.toThrow(/task/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function initGitRepo(cwd: string): void {
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'codex@example.test'])
  git(cwd, ['config', 'user.name', 'Codex Test'])
  writeFileSync(join(cwd, 'README.md'), 'hello\n')
  git(cwd, ['add', 'README.md'])
  git(cwd, ['commit', '-m', 'initial'])
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    },
  })
}
