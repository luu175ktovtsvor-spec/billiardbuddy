import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import { Workspace } from '../workspace/workspace'
import { fileReadTool } from '../tools/fileReadTool'
import { fileWriteTool } from '../tools/fileWriteTool'
import type { Tool } from '../tools/Tool'
import { ToolRegistry } from '../tools/registry'
import { createAgentTaskSidechainTools, createAgentTaskTool } from './agentTool'
import type { AgentDefinition } from './agentLoader'
import { getAgentMemoryEntrypoint } from './agentMemory'
import { handleReject, runAgentLoop } from '../harness/loop'
import { buildChildMessage } from './forkSubagent'
import { textBlock, type Message } from '../types/message'
import { TEAM_LEAD_NAME, TeamService } from '../tasks/teamService'
import { createTeamTools } from '../tasks/teamTools'
import { TaskService } from '../tasks/taskService'
import { startBackgroundAgentRun, type BackgroundAgentTaskOptions } from '../tasks/taskTools'

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

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitUntil timeout')
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

test('agent_task registers foreground task lifecycle for synchronous subagents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-foreground-'))
  try {
    const model = scriptedModel([{ kind: 'final', text: '前台子代理完成' }])
    const calls: Array<{ input: unknown; agentId: string; forkContext: unknown }> = []
    const cancelled: string[] = []
    const unregistered: Array<{ taskId: string; ctxConversation?: string }> = []
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['mark_step'] })],
      model,
      baseTools: [],
      sidechainRoot: join(root, 'sidechains'),
      registerForegroundAgent: async (input, _ctx, forkContext) => {
        calls.push({ input, agentId: input.agentId, forkContext })
        return {
          task: { id: 'fg_task_1', title: input.title, params: { agent_id: input.agentId } },
          backgroundSignal: new Promise<void>(() => {}),
          cancelAutoBackground: () => cancelled.push(input.agentId),
        }
      },
      unregisterForegroundAgent: async (taskId, ctx) => {
        unregistered.push({ taskId, ctxConversation: ctx.conversationId })
      },
    })

    const out = await tool.execute({
      task: '整理迁移报告',
      context: '重点看 AgentTool',
      name: 'fg-researcher',
    }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_conv',
    })

    expect(calls.length).toBe(1)
    expect(calls[0]!.input).toEqual({
      agent: 'researcher',
      agentId: calls[0]!.agentId,
      task: '整理迁移报告',
      context: '重点看 AgentTool',
      name: 'fg-researcher',
      title: 'researcher: 整理迁移报告',
    })
    expect(calls[0]!.agentId).toStartWith('agent_parent_conv_researcher_')
    expect(calls[0]!.forkContext).toBeUndefined()
    expect(cancelled).toEqual([calls[0]!.agentId])
    expect(unregistered).toEqual([{ taskId: 'fg_task_1', ctxConversation: 'parent_conv' }])
    expect(out).toContain('<agent_task agent="researcher" agent_id="agent_parent_conv_researcher_')
    expect(out).toContain('前台子代理完成')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task unregisters foreground task when synchronous subagent fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-foreground-fail-'))
  try {
    const cancelled: string[] = []
    const unregistered: string[] = []
    const tool = createAgentTaskTool({
      agents: [agent()],
      model: scriptedModel([]),
      baseTools: [],
      registerForegroundAgent: async (input) => ({
        task: { id: 'fg_task_fail', title: input.title, params: { agent_id: input.agentId } },
        backgroundSignal: new Promise<void>(() => {}),
        cancelAutoBackground: () => cancelled.push(input.agentId),
      }),
      unregisterForegroundAgent: async taskId => {
        unregistered.push(taskId)
      },
    })

    await expect(tool.execute({ task: '会失败的子代理' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
    })).rejects.toThrow('步骤用尽')

    expect(cancelled.length).toBe(1)
    expect(unregistered).toEqual(['fg_task_fail'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task hands off foreground registration when background signal wins the sync loop race', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-foreground-race-'))
  try {
    let releaseModel!: () => void
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'step-1', name: 'mark_step', input: { value: 'done-once' } }], usage: { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 25 } },
      { kind: 'final', text: 'should not be returned synchronously' },
    ])
    const originalStep = model.step
    model.step = async (input) => {
      if (model.received.length === 0) return originalStep(input)
      await new Promise<void>(resolve => { releaseModel = resolve })
      return originalStep(input)
    }
    const markStepCalls: unknown[] = []
    const markStepTool: Tool<{ value: string }> = {
      name: 'mark_step',
      description: '',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      isReadOnly: true,
      async execute(input) {
        markStepCalls.push(input)
        return `marked:${input.value}`
      },
    }
    let resolveBackground!: () => void
    const cancelled: string[] = []
    const unregistered: string[] = []
    const handoffs: Array<{ taskId: string; input: unknown }> = []
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['mark_step'] })],
      model,
      baseTools: [markStepTool],
      registerForegroundAgent: async (input) => ({
        task: { id: 'fg_handoff_agent', title: input.title, params: { agent_id: input.agentId } },
        backgroundSignal: new Promise<void>(resolve => { resolveBackground = resolve }),
        cancelAutoBackground: () => cancelled.push(input.agentId),
      }),
      handoffForegroundAgent: async (registration, input) => {
        handoffs.push({ taskId: registration.task.id, input })
        return {
          task: {
            id: registration.task.id,
            title: input.title,
            params: {
              agent_id: input.agentId,
              name: input.name,
              is_backgrounded: true,
            },
          },
          agent: agent({ name: input.agent }),
        }
      },
      unregisterForegroundAgent: async taskId => {
        unregistered.push(taskId)
      },
    })

    const pending = tool.execute({
      task: '切到后台继续',
      name: 'handoff-worker',
    }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'handoff-parent',
    })
    await waitUntil(() => typeof releaseModel === 'function')
    resolveBackground()
    const out = await pending
    releaseModel()

    expect(out).toContain('<background_task_started id="fg_handoff_agent" agent="researcher" name="handoff-worker"')
    expect(out).toContain('agent_id="handoff-parent_researcher"')
    expect(out).toContain('status="running"')
    expect(handoffs.length).toBe(1)
    expect(handoffs[0]!.taskId).toBe('fg_handoff_agent')
    expect(handoffs[0]!.input).toMatchObject({
      agent: 'researcher',
      agentId: 'handoff-parent_researcher',
      task: '切到后台继续',
      name: 'handoff-worker',
      title: 'researcher: 切到后台继续',
    })
    const initialMessages = (handoffs[0]!.input as { initialMessages?: Message[] }).initialMessages
    expect(initialMessages?.[0]).toEqual({ role: 'user', content: [textBlock('切到后台继续')] })
    // toMatchObject:发起工具调用的 assistant 消息额外带 provenance uuid(file-history messageId),只校验 role/content。
    expect(initialMessages?.[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'step-1', name: 'mark_step', input: { value: 'done-once' } }],
    })
    expect(initialMessages?.[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'step-1', content: 'marked:done-once' }],
    })
    expect((handoffs[0]!.input as { contentReplacementState?: unknown }).contentReplacementState).toBeTruthy()
    const summarySnapshot = (handoffs[0]!.input as { summarySnapshot?: { system?: string; messages?: Message[]; tools?: Array<{ name: string }> } }).summarySnapshot
    expect(summarySnapshot).toBeTruthy()
    expect(summarySnapshot?.messages).toEqual(initialMessages)
    expect(summarySnapshot?.tools?.map(tool => tool.name)).toEqual(['mark_step'])
    expect(summarySnapshot?.system).toContain('<subagent name="researcher">')
    expect((handoffs[0]!.input as { usageSnapshot?: unknown }).usageSnapshot).toMatchObject({
      type: 'usage_update',
      input_tokens: 125,
      output_tokens: 12,
      total_tokens: 137,
      cache_read_input_tokens: 25,
    })
    expect(markStepCalls).toEqual([{ value: 'done-once' }])
    expect(cancelled).toEqual(['handoff-parent_researcher'])
    expect(unregistered).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task closes foreground MCP runtime before starting a foreground handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-foreground-mcp-handoff-'))
  try {
    let releaseModel!: () => void
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'step-1', name: 'mark_step', input: { value: 'done-once' } }] },
      { kind: 'final', text: 'should continue in background' },
    ])
    const originalStep = model.step
    model.step = async (input) => {
      if (model.received.length === 0) return originalStep(input)
      await new Promise<void>(resolve => { releaseModel = resolve })
      return originalStep(input)
    }
    const markStepTool: Tool<{ value: string }> = {
      name: 'mark_step',
      description: '',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      isReadOnly: true,
      async execute(input) {
        return `marked:${input.value}`
      },
    }
    let resolveBackground!: () => void
    let closeResolved = false
    const order: string[] = []
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['mark_step'] })],
      model,
      baseTools: [markStepTool],
      loadAgentMcpRuntime: async input => ({
        tools: input.baseTools,
        warnings: [],
        close: async () => {
          order.push('mcp-close-start')
          await new Promise(resolve => setTimeout(resolve, 20))
          closeResolved = true
          order.push('mcp-close-end')
        },
      }),
      registerForegroundAgent: async (input) => ({
        task: { id: 'fg_handoff_mcp_agent', title: input.title, params: { agent_id: input.agentId } },
        backgroundSignal: new Promise<void>(resolve => { resolveBackground = resolve }),
        cancelAutoBackground: () => undefined,
      }),
      handoffForegroundAgent: async (registration, input) => {
        order.push(`handoff-close-resolved:${closeResolved}`)
        return {
          task: {
            id: registration.task.id,
            title: input.title,
            params: {
              agent_id: input.agentId,
              is_backgrounded: true,
            },
          },
          agent: agent({ name: input.agent }),
        }
      },
      unregisterForegroundAgent: async () => undefined,
    })

    const pending = tool.execute({ task: '关闭前台 MCP 后切后台' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'handoff-mcp-parent',
    })
    await waitUntil(() => typeof releaseModel === 'function')
    resolveBackground()
    const out = await pending
    releaseModel()

    expect(out).toContain('<background_task_started id="fg_handoff_mcp_agent"')
    expect(order).toEqual(['mcp-close-start', 'mcp-close-end', 'handoff-close-resolved:true'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task includes the foreground worktree session when handing off to background', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-worktree-handoff-'))
  try {
    initGitRepo(root)
    let releaseModel!: () => void
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'write-fg', name: 'write_file', input: { path: 'foreground-worker.txt', content: 'before handoff' } }] },
      { kind: 'final', text: 'should continue in background' },
    ])
    const originalStep = model.step
    model.step = async (input) => {
      if (model.received.length === 0) return originalStep(input)
      await new Promise<void>(resolve => { releaseModel = resolve })
      return originalStep(input)
    }
    let resolveBackground!: () => void
    const handoffs: Array<{ taskId: string; input: unknown }> = []
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['write_file'] })],
      model,
      baseTools: [fileWriteTool],
      registerForegroundAgent: async (input) => ({
        task: { id: 'fg_worktree_agent', title: input.title, params: { agent_id: input.agentId } },
        backgroundSignal: new Promise<void>(resolve => { resolveBackground = resolve }),
        cancelAutoBackground: () => undefined,
      }),
      handoffForegroundAgent: async (registration, input) => {
        handoffs.push({ taskId: registration.task.id, input })
        return {
          task: {
            id: registration.task.id,
            title: input.title,
            params: {
              agent_id: input.agentId,
              is_backgrounded: true,
            },
          },
          agent: agent({ name: input.agent }),
        }
      },
      unregisterForegroundAgent: async () => undefined,
    })

    const pending = tool.execute({
      task: '切后台继续写文件',
      isolation: 'worktree',
    }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'handoff-worktree-parent',
    })
    await waitUntil(() => typeof releaseModel === 'function')
    resolveBackground()
    const out = await pending
    releaseModel()

    expect(out).toContain('<background_task_started id="fg_worktree_agent"')
    const session = (handoffs[0]!.input as { handoffWorktreeSession?: { worktreePath?: string; originalRoot?: string } }).handoffWorktreeSession
    expect(session?.originalRoot ? realpathSync(session.originalRoot) : '').toBe(realpathSync(root))
    expect(session?.worktreePath).toBeTruthy()
    expect(existsSync(join(session!.worktreePath!, 'foreground-worker.txt'))).toBe(true)
    expect(existsSync(join(root, 'foreground-worker.txt'))).toBe(false)
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
    expect(tool.description).toContain('When to fork')
    expect(tool.description).toContain('do not read or tail its output')
    expect(tool.description).toContain('all agent_task launches run in the background')

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

test('agent_task fork gate forces explicit specialized agents into the background', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-fork-force-async-'))
  try {
    let capturedInput: unknown
    let capturedFork: unknown = 'not-called'
    const model = scriptedModel([{ kind: 'final', text: 'should not run synchronously' }])
    const tool = createAgentTaskTool({
      agents: [agent()],
      model,
      baseTools: [],
      env: { DESKTOP_AGENT_FORK_SUBAGENT: '1' },
      startBackgroundAgent: async (input, _ctx, forkContext) => {
        capturedInput = input
        capturedFork = forkContext
        return {
          task: {
            id: 'explicit_agent_bg_1',
            title: `${input.agent}: ${input.task}`,
            params: { agent_id: 'explicit_agent_bg_1' },
          },
          agent: agent({ name: input.agent ?? 'researcher' }),
        }
      },
    })

    const out = await tool.execute({ agent: 'researcher', task: '显式 agent 也后台' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      systemPrompt: 'PARENT SYS',
      messages: [{ role: 'user', content: [textBlock('父请求')] }],
    })

    expect(capturedInput).toEqual({
      agent: 'researcher',
      task: '显式 agent 也后台',
      title: 'researcher: 显式 agent 也后台',
    })
    expect(capturedFork).toBeUndefined()
    expect(model.received).toHaveLength(0)
    expect(out).toContain('<background_task_started id="explicit_agent_bg_1" agent="researcher" agent_id="explicit_agent_bg_1" status="queued">')
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
      // 父级 default:此时子代理 frontmatter 声明的 permissionMode('plan')应被采用。
      permissionMode: 'default',
      conversationId: 'parent_defaults',
    })

    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'text',
      text: '先遵守 agent 初始提示。\n\n检查默认值',
    })
    expect(model.received[0]!.tools.map(t => t.name)).toEqual(['inspect_ctx'])
    expect(seenPermission).toBe('plan')
    expect(seenWorkspace).toContain(join(root, '.claude', 'worktrees'))
    // maxTurns=1:第 1 个工具步后即命中上限,loop 只 yield max_turns_reached 后 return(不再强制多打一步无工具收尾)。
    // 只有 1 次 model.step,脚本里的 final 从不被消费;子代理拿不到 final,由调用方(agentTool)兜底合成最终答复。
    expect(model.received.length).toBe(1)
    expect(out).not.toContain('fallback final should not be used when maxTurns=1')
    expect(out).toContain('已达最大轮次,未能收敛')
    expect(out).toContain('<agent_worktree status="removed_clean">')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('parent bypassPermissions takes precedence over agent frontmatter permissionMode (cc runAgent inheritance)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-parent-mode-'))
  try {
    let seenPermission = ''
    const inspectTool: import('../tools/Tool').Tool = {
      name: 'inspect_ctx',
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute(_, ctx) {
        seenPermission = ctx.permissionMode ?? ''
        return 'ok'
      },
    }
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'i1', name: 'inspect_ctx', input: {} }] },
      { kind: 'final', text: 'done' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['inspect_ctx'], permissionMode: 'plan' })],
      model,
      baseTools: [inspectTool],
      sidechainRoot: join(root, 'sidechains'),
    })
    // 父级已 full(=bypassPermissions):子代理声明的更窄 plan 不应把它降级
    await tool.execute({ task: '检查父级优先' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_bypass',
    })
    expect(seenPermission).toBe('full')
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
  const oldConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
  process.env.BILLIARDBUDDY_CONFIG_DIR = join(root, 'config')
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
    if (oldConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = oldConfigDir
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
      message.content.some(block => block.type === 'tool_result' && typeof block.content === 'string' && block.content.includes('agent-mcp:hello')),
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

// Real-path helper matching how server/index.ts actually wires createAgentTaskTool's
// startBackgroundAgent option: an in-memory TaskService driving the real startBackgroundAgentRun,
// not a hand-rolled mock that hardcodes agent_id. A hardcoded agent_id across repeated calls is
// exactly the "假绿" bug the review caught (R2-uds-sidecar.md C1) — production agent_id is always
// a fresh task.id per call, so a mock that pins it to a constant can't exercise the real dedup path.
function realTeamAgentHarness(root: string, teams: TeamService, agentDef: AgentDefinition) {
  const tasks = new TaskService(root)
  const backgroundOpts: BackgroundAgentTaskOptions = {
    tasks,
    agents: [agentDef],
    model: scriptedModel([
      { kind: 'final', text: 'run 1' },
      { kind: 'final', text: 'run 2' },
      { kind: 'final', text: 'run 3' },
      { kind: 'final', text: 'run 4' },
    ]),
    baseTools: [],
    baseSystemPrompt: 'base',
  }
  const tool = createAgentTaskTool({
    agents: [agentDef],
    model: scriptedModel([{ kind: 'final', text: 'foreground unused' }, { kind: 'final', text: 'foreground unused 2' }]),
    baseTools: [],
    teams,
    sidechainRoot: join(root, 'sidechains'),
    startBackgroundAgent: (input, toolCtx, forkContext) =>
      startBackgroundAgentRun(backgroundOpts, input, toolCtx, {}, [], [], forkContext ? { forkContext } : {}),
  })
  return { tasks, tool }
}

test('agent_task real path: same name+team spawned twice is renamed (researcher, researcher-2) per cc generateUniqueTeammateName, not duplicated or silently dropped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-team-'))
  try {
    const teams = new TeamService(root)
    await teams.createTeam({ teamName: 'squad', cwd: root, conversationId: 'lead-conv' })
    const { tool } = realTeamAgentHarness(root, teams, agent())
    const ctx = { workspace: new Workspace(root), conversationId: 'lead-conv' }

    // No run_in_background flag at all — team_name + name alone must be enough to
    // both background the spawn and register it as a teammate (cc AgentTool.tsx:
    // "Spawn is triggered when team_name is set ... and name is provided").
    const out1 = await tool.execute({ task: '帮我盯着这块代码', name: 'researcher', team_name: 'squad' }, ctx)
    expect(out1).toContain('name="researcher"')

    // Re-run with the exact same name + team, exactly like the production scenario the review
    // caught: the real background task's own agent_id is always a fresh task.id per call, never a
    // stable dedup key on its own. cc resolves the name collision by renaming to `${name}-2`
    // (spawnMultiAgent.ts:generateUniqueTeammateName) rather than silently no-op-ing the roster
    // push, so the roster must end up with two distinct, addressable teammates.
    const out2 = await tool.execute({ task: '第二次同名同 team', name: 'researcher', team_name: 'squad' }, ctx)
    expect(out2).toContain('name="researcher-2"')

    const team = await teams.readTeam('squad')
    expect(team?.members.map(m => m.name)).toEqual([TEAM_LEAD_NAME, 'researcher', 'researcher-2'])
    expect(team?.members.filter(m => m.name === 'researcher' || m.name === 'researcher-2').map(m => m.agentId)).toEqual([
      'researcher@squad',
      'researcher-2@squad',
    ])
    for (const member of team!.members) {
      if (member.name === TEAM_LEAD_NAME) continue
      expect(member).toMatchObject({ agentType: 'researcher', backendType: 'in-process', isActive: true })
    }

    const listPeers = createTeamTools(teams).find(t => t.name === 'ListPeers')!
    const peersOutput = await listPeers.execute({}, { workspace: new Workspace(root) })
    expect(peersOutput).toContain('name="researcher"')
    expect(peersOutput).toContain('name="researcher-2"')
    expect(peersOutput).toContain('"local_peer_count": 3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task real path: an unrelated conversation without team_name never joins another conversation\'s active team and stays synchronous', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-team-cross-session-'))
  try {
    // Exactly how server/index.ts wires it: one TeamService instance for the whole backend-sidecar
    // process, shared across every conversationId that hits this server (R2-uds-sidecar.md C2).
    const teams = new TeamService(root)
    const researcherAgent = agent()

    // Conversation A: deliberately creates and joins a team.
    await teams.createTeam({ teamName: 'session-a-team', cwd: root, conversationId: 'conversation-A' })
    const { tool: toolForA } = realTeamAgentHarness(root, teams, researcherAgent)
    const outA = await toolForA.execute(
      { task: 'A 在盯这块代码', name: 'a-helper', team_name: 'session-a-team' },
      { workspace: new Workspace(root), conversationId: 'conversation-A' },
    )
    expect(outA).toContain('<background_task_started')

    // Conversation B: a totally different, unrelated conversation on the SAME server process. It
    // never called TeamCreate and never passed team_name — an ordinary name-only agent_task call.
    const { tool: toolForB } = realTeamAgentHarness(root, teams, researcherAgent)
    const outB = await toolForB.execute(
      { task: 'B 只是要个普通后台助手,不涉及任何 team', name: 'b-helper' },
      { workspace: new Workspace(root), conversationId: 'conversation-B' },
    )

    // Conversation B's call must NOT be silently pulled into conversation A's team: it should run
    // its ordinary synchronous foreground path (an <agent_task> sidechain result), not a forced
    // <background_task_started>.
    expect(outB).toContain('<agent_task')
    expect(outB).not.toContain('<background_task_started')

    const team = await teams.readTeam('session-a-team')
    expect(team?.members.map(m => m.name)).toEqual([TEAM_LEAD_NAME, 'a-helper'])
    expect(team?.members.some(m => m.name === 'b-helper')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task inherits the active team from context when team_name is omitted but name is set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-team-inherit-'))
  try {
    const teams = new TeamService(root)
    await teams.createTeam({ teamName: 'inherited-team', cwd: root })
    const tool = createAgentTaskTool({
      agents: [agent()],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
      teams,
      startBackgroundAgent: async input => ({
        task: { id: 'bg_teammate_2', title: `${input.agent}: ${input.task}`, params: { name: input.name, agent_id: 'helper@inherited-team' } },
        agent: agent({ name: input.agent ?? 'researcher' }),
      }),
    })
    await tool.execute({ task: '帮忙', name: 'helper' }, { workspace: new Workspace(root) })
    const team = await teams.readTeam('inherited-team')
    expect(team?.members.some(m => m.name === 'helper')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task with a teams service but no active team and no team_name runs synchronously as before (no forced backgrounding)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-team-none-'))
  try {
    const teams = new TeamService(root)
    const model = scriptedModel([{ kind: 'final', text: '同步完成' }])
    const tool = createAgentTaskTool({
      agents: [agent()],
      model,
      baseTools: [],
      teams,
      sidechainRoot: join(root, 'sidechains'),
    })
    const out = await tool.execute({ task: '普通任务', name: 'solo' }, { workspace: new Workspace(root) })
    expect(out).toContain('同步完成')
    expect(await teams.getActiveTeam()).toBeNull()
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
