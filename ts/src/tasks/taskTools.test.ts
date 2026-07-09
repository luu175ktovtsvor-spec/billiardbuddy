import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import { Workspace } from '../workspace/workspace'
import type { AgentDefinition } from '../agents/agentLoader'
import { resolvePermission } from '../permissions/resolve'
import type { Model } from '../types/model'
import { textBlock, toolResultBlock, toolUseBlock, userText, type Message } from '../types/message'
import type { Tool } from '../tools/Tool'
import { fileReadTool } from '../tools/fileReadTool'
import { fileWriteTool } from '../tools/fileWriteTool'
import { TaskService } from './taskService'
import type { ToolContext } from '../tools/Tool'
import { createBackgroundAgentTaskTool, createTaskTools, resumeBackgroundAgentTask, sanitizeBackgroundAgentResumeMessages, startBackgroundAgentRun } from './taskTools'
import { getAgentMemoryEntrypoint } from '../agents/agentMemory'
import { createAgentTaskTool } from '../agents/agentTool'
import { ToolRegistry } from '../tools/registry'
import { runAgentLoop } from '../harness/loop'
import { createIsolatedAgentWorktree } from '../tools/worktreeTools'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

async function collectEvents(gen: AsyncGenerator<import('../types/events').AgentEvent>): Promise<import('../types/events').AgentEvent[]> {
  const events: import('../types/events').AgentEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

test('sanitizeBackgroundAgentResumeMessages removes incomplete transcript tails before resume', () => {
  const resolvedAssistant: Message = {
    role: 'assistant',
    content: [textBlock('读取完成'), toolUseBlock({ id: 'ok1', name: 'read_file', input: { path: 'a.ts' } })],
  }
  const resolvedResult: Message = {
    role: 'user',
    content: [toolResultBlock('ok1', 'content')],
  }
  const messages: Message[] = [
    userText('开始'),
    { role: 'assistant', content: [toolUseBlock({ id: 'missing1', name: 'grep_files', input: { pattern: 'x' } })] },
    { role: 'assistant', content: [textBlock('   \n\t')] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden chain' }] },
    resolvedAssistant,
    resolvedResult,
  ]

  expect(sanitizeBackgroundAgentResumeMessages(messages)).toEqual([
    userText('开始'),
    resolvedAssistant,
    resolvedResult,
  ])
})

test('start_background_agent_task runs an isolated agent and read_background_task restores events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const model = scriptedModel([{ kind: 'final', text: '后台结论' }])
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [],
      baseSystemPrompt: 'base prompt',
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c1', permissionMode: 'full' as const }
    const started = await start.execute({ task: '分析数据', title: '后台分析', name: 'parser-auditor' }, ctx)
    expect(started).toContain('<background_task_started')
    expect(started).toContain('name="parser-auditor"')
    expect(started).toContain('agent_id=')

    const done = await waitFor(async () => {
      const list = await tasks.list({ conversationId: 'c1' })
      return list[0]?.status === 'completed' ? list[0] : null
    })
    expect(done.title).toBe('后台分析')
    expect(done.kind).toBe('background_agent')
    expect(done.params).toMatchObject({ agent: 'researcher', name: 'parser-auditor', task: '分析数据', agent_id: done.id })
    expect(await tasks.readBackgroundAgentMetadata(done.id)).toMatchObject({
      taskId: done.id,
      agentId: done.id,
      agent: 'researcher',
      agentType: 'researcher',
      name: 'parser-auditor',
      description: '后台分析',
      task: '分析数据',
      conversationId: 'c1',
    })
    expect(done.result).toBe('后台结论')
    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({ type: 'text', text: '分析数据' })
    const transcript = await tasks.transcript(done.id).load()
    expect(transcript).toEqual([
      userText('分析数据'),
      { role: 'assistant', content: [textBlock('后台结论')] },
    ])

    const [, readTask] = createTaskTools(tasks)
    const restored = await readTask!.execute({ task_id: done.id }, ctx)
    expect(restored).toContain('status="completed"')
    expect(restored).toContain('后台结论')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startBackgroundAgentRun hands off an already backgrounded foreground agent task id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-foreground-handoff-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const registration = await tasks.registerForegroundAgent({
      taskId: 'fg_handoff_1',
      agentId: 'stable_handoff_agent',
      agent: 'researcher',
      title: 'researcher: foreground',
      conversationId: 'handoff-conv',
      workspaceRoot: root,
      task: '前台切后台',
    })
    await registration.requestBackground()
    const handoffMessages: Message[] = [
      userText('前台切后台'),
      { role: 'assistant', content: [toolUseBlock({ id: 'fg-step-1', name: 'read_file', input: { path: 'done.txt' } })] },
      { role: 'user', content: [toolResultBlock('fg-step-1', 'front-result')] },
    ]
    const model = scriptedModel([{ kind: 'final', text: 'handoff done', usage: { input_tokens: 140, output_tokens: 20, cache_creation_input_tokens: 10 } }])

    const { task } = await startBackgroundAgentRun({
      tasks,
      agents: [agent],
      model,
      baseTools: [],
      baseSystemPrompt: 'base prompt',
    }, {
      agent: 'researcher',
      task: '前台切后台',
      title: 'researcher: foreground',
      initialMessages: handoffMessages,
      usageSnapshot: {
        type: 'usage_update',
        input_tokens: 125,
        output_tokens: 12,
        total_tokens: 137,
        last_input_tokens: 125,
        last_output_tokens: 12,
        cache_read_input_tokens: 25,
      },
    }, {
      workspace: new Workspace(root),
      conversationId: 'handoff-conv',
      permissionMode: 'full',
    }, {
      foreground_handoff: true,
      agent_id: 'stable_handoff_agent',
    }, [], [], {
      handoffTaskId: 'fg_handoff_1',
    })

    expect(task.id).toBe('fg_handoff_1')
    expect(task.params).toMatchObject({
      agent: 'researcher',
      agent_id: 'stable_handoff_agent',
      foreground: false,
      is_backgrounded: true,
      foreground_handoff: true,
      handoff_tool_uses: 1,
    })
    expect(task.progress).toBeGreaterThan(0)
    expect(task.stage).toContain('已接续前台进度:read_file 完成')
    const done = await waitFor(async () => {
      const meta = await tasks.get('fg_handoff_1')
      return meta?.status === 'completed' ? meta : null
    })
    expect(done.result).toBe('handoff done')
    expect(done.params?.usage).toMatchObject({
      input_tokens: 150,
      output_tokens: 32,
      total_tokens: 182,
      last_input_tokens: 150,
      last_output_tokens: 20,
      cache_creation_input_tokens: 10,
      tool_uses: 1,
    })
    expect(model.received[0]!.messages.slice(0, 3)).toEqual(handoffMessages)
    expect(model.received[0]!.messages.filter(message =>
      message.role === 'user' &&
      message.content.some(block => block.type === 'text' && block.text === '前台切后台'),
    ).length).toBe(1)
    expect(await tasks.readBackgroundAgentMetadata('fg_handoff_1')).toMatchObject({
      taskId: 'fg_handoff_1',
      agentId: 'stable_handoff_agent',
      agent: 'researcher',
      task: '前台切后台',
      conversationId: 'handoff-conv',
    })
    const taskTools = createTaskTools(tasks)
    const readTask = taskTools[1]!
    const taskOutput = taskTools[3]!
    const restored = await readTask.execute({ task_id: 'fg_handoff_1' }, {
      workspace: new Workspace(root),
      conversationId: 'handoff-conv',
      permissionMode: 'full',
    })
    expect(restored).toContain('<usage>')
    expect(restored).toContain('<total_tokens>182</total_tokens>')
    const detail = await taskOutput!.execute({ task_id: 'fg_handoff_1', block: false }, {
      workspace: new Workspace(root),
      conversationId: 'handoff-conv',
      permissionMode: 'full',
    })
    expect(detail).toContain('<total_tokens>182</total_tokens>')
    expect(detail).toContain('<tool_uses>1</tool_uses>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startBackgroundAgentRun reuses a foreground handoff worktree instead of creating a second one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-handoff-worktree-'))
  try {
    initGitRepo(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
      tools: ['write_file'],
    }
    const registration = await tasks.registerForegroundAgent({
      taskId: 'fg_worktree_handoff_1',
      agentId: 'worktree_handoff_agent',
      agent: 'researcher',
      title: 'researcher: foreground worktree',
      conversationId: 'handoff-worktree-conv',
      workspaceRoot: root,
      task: '前台 worktree 切后台',
    })
    await registration.requestBackground()
    const foregroundWorktree = await createIsolatedAgentWorktree(root, 'worktree_handoff_agent', 'handoff-worktree-conv')
    const handoffMessages: Message[] = [
      userText('前台 worktree 切后台'),
      { role: 'assistant', content: [toolUseBlock({ id: 'fg-worktree-step', name: 'write_file', input: { path: 'foreground.txt', content: 'done in foreground' } })] },
      { role: 'user', content: [toolResultBlock('fg-worktree-step', 'foreground write complete')] },
    ]
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'bg-write', name: 'write_file', input: { path: 'handoff-worker.txt', content: 'continued in same worktree' } }] },
      { kind: 'final', text: 'handoff worktree done' },
    ])

    const { task } = await startBackgroundAgentRun({
      tasks,
      agents: [agent],
      model,
      baseTools: [fileWriteTool],
      baseSystemPrompt: 'base prompt',
    }, {
      agent: 'researcher',
      task: '前台 worktree 切后台',
      title: 'researcher: foreground worktree',
      isolation: 'worktree',
      initialMessages: handoffMessages,
      handoffWorktreeSession: foregroundWorktree.session,
    }, {
      workspace: new Workspace(root),
      conversationId: 'handoff-worktree-conv',
      permissionMode: 'full',
    }, {
      foreground_handoff: true,
      agent_id: 'worktree_handoff_agent',
    }, [], [], {
      handoffTaskId: 'fg_worktree_handoff_1',
    })

    const done = await waitFor(async () => {
      const meta = await tasks.get(task.id)
      return meta?.status === 'completed' ? meta : null
    })
    expect(done.result).toBe('handoff worktree done')
    const worktreePath = foregroundWorktree.session.worktreePath
    expect(existsSync(join(worktreePath, 'handoff-worker.txt'))).toBe(true)
    expect(readFileSync(join(worktreePath, 'handoff-worker.txt'), 'utf8')).toBe('continued in same worktree')
    expect(existsSync(join(root, 'handoff-worker.txt'))).toBe(false)
    const metadata = await tasks.readBackgroundAgentMetadata(task.id)
    expect(metadata?.worktreePath).toBe(worktreePath)
    const notes = (await tasks.loadEvents(task.id)).filter(record => record.event.type === 'context_note').map(record => record.event)
    expect(notes.some(event => event.type === 'context_note' && event.text.includes('continued foreground worktree'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('startBackgroundAgentRun seeds AgentSummary from foreground handoff snapshot before the background loop advances', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-handoff-summary-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const registration = await tasks.registerForegroundAgent({
      taskId: 'fg_summary_handoff_1',
      agentId: 'summary_handoff_agent',
      agent: 'researcher',
      title: 'researcher: foreground summary',
      conversationId: 'handoff-summary-conv',
      workspaceRoot: root,
      task: '前台摘要继承',
    })
    await registration.requestBackground()
    const handoffMessages: Message[] = [
      userText('前台摘要继承'),
      { role: 'assistant', content: [textBlock('checking'), toolUseBlock({ id: 'fg-summary-step', name: 'read_file', input: { path: 'src/app.ts' } })] },
      { role: 'user', content: [toolResultBlock('fg-summary-step', 'front summary result')] },
    ]
    let unblockStart!: () => void
    const startBlocked = new Promise<void>(resolve => { unblockStart = resolve })
    const received: Array<{ system?: string; messages: Message[]; tools: Array<{ name: string }> }> = []
    const model: Model = {
      async step(input) {
        received.push({ system: input.system, messages: input.messages, tools: input.tools.map(tool => ({ name: tool.name })) })
        if (input.messages.at(-1)?.role === 'user' && input.messages.at(-1)?.content.some(block => block.type === 'text' && block.text.includes('Do not use tools'))) {
          return { kind: 'final', text: 'Reading src/app.ts' }
        }
        return { kind: 'final', text: 'background loop advanced' }
      },
    }

    const { task } = await startBackgroundAgentRun({
      tasks,
      agents: [agent],
      model,
      baseTools: [],
      baseSystemPrompt: 'base prompt',
      agentSummaryIntervalMs: 1,
      hooks: {
        rules: [
          { event: 'SubagentStart', matcher: 'researcher', handler: async () => {
            await startBlocked
            return null
          } },
        ],
      },
    }, {
      agent: 'researcher',
      task: '前台摘要继承',
      title: 'researcher: foreground summary',
      initialMessages: handoffMessages,
      summarySnapshot: {
        system: 'FOREGROUND SYSTEM',
        tools: [{ name: 'read_file', description: '', parameters: { type: 'object' } }],
        messages: handoffMessages,
      },
    }, {
      workspace: new Workspace(root),
      conversationId: 'handoff-summary-conv',
      permissionMode: 'full',
    }, {
      foreground_handoff: true,
      agent_id: 'summary_handoff_agent',
    }, [], [], {
      handoffTaskId: 'fg_summary_handoff_1',
    })

    const summarized = await waitFor(async () => {
      const meta = await tasks.get(task.id)
      return meta?.summary === 'Reading src/app.ts' ? meta : null
    })
    expect(summarized.status).toBe('running')
    expect(received.length).toBeGreaterThanOrEqual(1)
    const summaryRequest = received[0]!
    expect(summaryRequest.system).toBe('FOREGROUND SYSTEM')
    expect(summaryRequest.tools.map(tool => tool.name)).toEqual(['read_file'])
    expect(summaryRequest.messages.slice(0, 3)).toEqual(handoffMessages)
    expect(summaryRequest.messages.at(-1)?.content[0]).toMatchObject({ type: 'text' })

    unblockStart()
    const done = await waitFor(async () => {
      const meta = await tasks.get(task.id)
      return meta?.status === 'completed' ? meta : null
    })
    expect(done.summary).toBe('Reading src/app.ts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task run_in_background fork_context starts a background fork with parent system, messages and tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-fork-agent-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '普通 agent prompt 不应该进入 fork child。',
      filePath: join(root, 'researcher.md'),
    }
    const parentModel = scriptedModel([
      { kind: 'tool_calls', text: 'fork background', calls: [{ id: 'fork-bg', name: 'agent_task', input: { task: '后台审计 fork', fork_context: true, run_in_background: true } }] },
      { kind: 'final', text: 'parent done' },
    ])
    const childModel = scriptedModel([{ kind: 'final', text: 'Scope: 后台审计 fork' }])
    const inspectTool: Tool = {
      name: 'inspect_parent_tool',
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute() {
        return 'ok'
      },
    }
    const backgroundOptions = {
      tasks,
      agents: [agent],
      model: childModel,
      baseTools: [inspectTool],
      baseSystemPrompt: 'BACKGROUND BASE',
    }
    const registry = new ToolRegistry([
      createAgentTaskTool({
        agents: [agent],
        model: childModel,
        baseTools: [inspectTool],
        startBackgroundAgent: (input, ctx, forkContext) => startBackgroundAgentRun(backgroundOptions, input, ctx, {}, [], [], forkContext ? { forkContext } : {}),
      }),
      inspectTool,
    ])

    const parentEvents = await collectEvents(runAgentLoop({
      model: parentModel,
      registry,
      workspace: new Workspace(root),
      systemPrompt: 'PARENT SYSTEM',
      userMessage: '父后台任务',
      conversationId: 'fork-bg-parent',
    }))
    expect(parentEvents.some(event =>
      event.type === 'tool_result' &&
      event.output.includes('<background_task_started') &&
      event.output.includes('agent="fork"'),
    )).toBe(true)

    const done = await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'fork-bg-parent' }))[0]
      return task?.status === 'completed' ? task : null
    })
    expect(done.params).toMatchObject({ agent: 'fork', fork_context: true })
    const childFirst = childModel.received[0]!
    expect(childFirst.system).toBe('PARENT SYSTEM')
    expect(childFirst.tools.map(tool => tool.name)).toEqual(['agent_task', 'inspect_parent_tool'])
    expect(childFirst.messages[0]).toEqual({ role: 'user', content: [textBlock('父后台任务')] })
    expect(childFirst.messages[1]).toEqual({
      role: 'assistant',
      content: [
        textBlock('fork background'),
        { type: 'tool_use', id: 'fork-bg', name: 'agent_task', input: { task: '后台审计 fork', fork_context: true, run_in_background: true } },
      ],
    })
    expect(childFirst.messages[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'fork-bg', content: 'Fork started - processing in background' })
    const directive = childFirst.messages[2]?.content[1]
    expect(directive?.type === 'text' ? directive.text : '').toContain('Your directive: 后台审计 fork')

    // fork 类型后台代理 resume:修复前 pickAgent 找不到具名 'fork' 会抛"需要指定 agent";修复后重建合成 fork 定义能续接。
    const resumeModel = scriptedModel([{ kind: 'final', text: 'resumed fork done' }])
    const resumed = await resumeBackgroundAgentTask(
      { ...backgroundOptions, model: resumeModel },
      done, '继续 fork 审计',
      { workspace: new Workspace(root), conversationId: 'fork-bg-parent', permissionMode: 'acceptEdits' } as ToolContext,
    )
    expect(resumed.task.params?.agent).toBe('fork')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task background fork injects a worktree notice for isolated fork workers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-fork-worktree-notice-'))
  try {
    initGitRepo(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const parentModel = scriptedModel([
      { kind: 'tool_calls', text: 'fork worktree', calls: [{ id: 'fork-wt', name: 'agent_task', input: { task: '检查隔离路径', fork_context: true, run_in_background: true, isolation: 'worktree' } }] },
      { kind: 'final', text: 'parent done' },
    ])
    const childModel = scriptedModel([{ kind: 'final', text: 'Scope: 检查隔离路径' }])
    const inspectTool: Tool = {
      name: 'inspect_parent_tool',
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute() {
        return 'ok'
      },
    }
    const backgroundOptions = {
      tasks,
      agents: [agent],
      model: childModel,
      baseTools: [inspectTool],
      baseSystemPrompt: 'BACKGROUND BASE',
    }
    const registry = new ToolRegistry([
      createAgentTaskTool({
        agents: [agent],
        model: childModel,
        baseTools: [inspectTool],
        startBackgroundAgent: (input, ctx, forkContext) => startBackgroundAgentRun(backgroundOptions, input, ctx, {}, [], [], forkContext ? { forkContext } : {}),
      }),
      inspectTool,
    ])

    await collectEvents(runAgentLoop({
      model: parentModel,
      registry,
      workspace: new Workspace(root),
      systemPrompt: 'PARENT SYSTEM',
      userMessage: '父后台 worktree 任务',
      conversationId: 'fork-wt-parent',
    }))

    await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'fork-wt-parent' }))[0]
      return task?.status === 'completed' ? task : null
    })
    const childFirst = childModel.received[0]!
    const directiveIndex = childFirst.messages.findIndex(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('Your directive: 检查隔离路径')),
    )
    const noticeIndex = childFirst.messages.findIndex(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('isolated git worktree')),
    )
    expect(directiveIndex).toBeGreaterThanOrEqual(0)
    expect(noticeIndex).toBeGreaterThan(directiveIndex)
    const noticeBlock = childFirst.messages[noticeIndex]!.content.find(block => block.type === 'text')
    const notice = noticeBlock?.type === 'text' ? noticeBlock.text : ''
    expect(notice).toContain(root)
    expect(notice).toContain(join(root, '.claude', 'worktrees'))
    expect(notice).toContain('translate them to your worktree root')
    expect(notice).toContain('Re-read files before editing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start_background_agent_task rejects recursive launch from fork query source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-fork-query-source-guard-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
    })

    await expect(start.execute({ task: '再开后台任务' }, {
      workspace: new Workspace(root),
      conversationId: 'fork-child',
      permissionMode: 'full',
      querySource: 'agent:builtin:fork',
      messages: [{ role: 'user', content: [textBlock('compressed fork history without boilerplate')] }],
    })).rejects.toThrow('Fork worker 内部不能再次启动 start_background_agent_task')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start_background_agent_task updates task stage from live agent activity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-progress-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    let releaseWait!: () => void
    let waitStarted!: () => void
    const waitStartedPromise = new Promise<void>(resolve => { waitStarted = resolve })
    const waitReleasePromise = new Promise<void>(resolve => { releaseWait = resolve })
    const waitTool: Tool = {
      name: 'wait_gate',
      description: 'Emit progress and wait until the test releases the background tool.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      isReadOnly: false,
      async execute(_, toolCtx) {
        waitStarted()
        toolCtx.progressEmit?.({ stream: 'stdout', chunk: 'reading fixture\n' })
        await waitReleasePromise
        return 'released'
      },
    }
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'wait1', name: 'wait_gate', input: { path: 'src/agent.ts' } }] },
      { kind: 'final', text: '后台进度完成' },
    ])
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [waitTool],
      baseSystemPrompt: 'base prompt',
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-progress', permissionMode: 'full' as const }
    await start.execute({ task: '检查后台进度', title: '后台进度' }, ctx)
    await waitStartedPromise

    const running = await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-progress', status: 'running' }))[0]
      return task?.stage?.includes('wait_gate 进度:reading fixture') ? task : null
    })
    expect(running.progress).toBeGreaterThan(0)
    expect(running.progress).toBeLessThan(100)

    releaseWait()
    const done = await waitFor(async () => {
      const task = await tasks.get(running.id)
      return task?.status === 'completed' ? task : null
    })
    expect(done.progress).toBe(100)
    expect(done.stage).toBe('整理最终结果')
    const events = await waitFor(async () => {
      const records = await tasks.loadEvents(done.id)
      return records.some(record => record.event.type === 'done') ? records : null
    })
    expect(events.map(record => record.event.type)).toEqual(['started', 'tool_call', 'tool_progress', 'tool_result', 'final', 'done'])
    expect(events.some(record => record.event.type === 'context_note' && 'text' in record.event && record.event.text.includes('wait_gate'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start_background_agent_task periodically writes cache-safe progress summaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-summary-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const inspectTool: Tool = {
      name: 'inspect_file',
      description: 'Inspect one file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      isReadOnly: true,
      async execute() {
        return 'inspected taskTools.ts'
      },
    }
    let secondStepStarted!: () => void
    let releaseSecondStep!: () => void
    const secondStepStartedPromise = new Promise<void>(resolve => { secondStepStarted = resolve })
    const releaseSecondStepPromise = new Promise<void>(resolve => { releaseSecondStep = resolve })
    const received: Array<{ system?: string; messages: Message[]; tools: Array<{ name: string }> }> = []
    let call = 0
    const model: Model = {
      async step(input) {
        received.push({ system: input.system, messages: input.messages, tools: input.tools.map(tool => ({ name: tool.name })) })
        call++
        if (call === 1) {
          return { kind: 'tool_calls', text: 'inspect', calls: [{ id: 'inspect1', name: 'inspect_file', input: { path: 'taskTools.ts' } }] }
        }
        if (call === 2) {
          secondStepStarted()
          await releaseSecondStepPromise
          return { kind: 'final', text: '后台摘要完成' }
        }
        return { kind: 'final', text: 'Reading taskTools.ts' }
      },
    }
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [inspectTool],
      baseSystemPrompt: 'base prompt',
      agentSummaryIntervalMs: 1,
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-summary', permissionMode: 'full' as const }
    await start.execute({ task: '检查摘要', title: '后台摘要' }, ctx)
    await secondStepStartedPromise

    const summarized = await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-summary', status: 'running' }))[0]
      return task?.summary === 'Reading taskTools.ts' ? task : null
    })
    expect(summarized.summary).toBe('Reading taskTools.ts')
    expect(received.length).toBeGreaterThanOrEqual(3)
    const mainSecond = received[1]!
    const summaryStep = received[2]!
    expect(summaryStep.system).toBe(mainSecond.system)
    expect(summaryStep.tools.map(tool => tool.name)).toEqual(mainSecond.tools.map(tool => tool.name))
    expect(summaryStep.messages.some(message =>
      message.role === 'assistant' &&
      message.content.some(block => block.type === 'text' && block.text === 'inspect'),
    )).toBe(true)
    expect(summaryStep.messages.some(message =>
      message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'inspect1'),
    )).toBe(true)
    const summaryPrompt = summaryStep.messages.at(-1)?.content[0]
    expect(summaryPrompt).toMatchObject({ type: 'text' })
    expect(summaryPrompt?.type === 'text' ? summaryPrompt.text : '').toContain('Do not use tools')

    releaseSecondStep()
    const done = await waitFor(async () => {
      const task = await tasks.get(summarized.id)
      return task?.status === 'completed' ? task : null
    })
    expect(done.summary).toBe('Reading taskTools.ts')

    const [, readTask] = createTaskTools(tasks)
    const detail = await readTask!.execute({ task_id: done.id }, ctx)
    expect(detail).toContain('<summary>Reading taskTools.ts</summary>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start_background_agent_task drains queued SendMessage-style steering into the running agent loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-steer-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    let releaseWait!: () => void
    let waitStarted!: () => void
    const waitStartedPromise = new Promise<void>(resolve => { waitStarted = resolve })
    const waitReleasePromise = new Promise<void>(resolve => { releaseWait = resolve })
    const waitTool: Tool = {
      name: 'wait_gate',
      description: 'Wait until the test releases the background tool.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute() {
        waitStarted()
        await waitReleasePromise
        return 'released'
      },
    }
    const received: { messages: import('../types/message').Message[] }[] = []
    let calls = 0
    const model: Model = {
      async step(input) {
        received.push({ messages: input.messages.slice() })
        calls++
        if (calls === 1) {
          return { kind: 'tool_calls', text: 'wait', calls: [{ id: 'wait1', name: 'wait_gate', input: {} }] }
        }
        return { kind: 'final', text: 'queued message received' }
      },
    }
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [waitTool],
      baseSystemPrompt: 'base prompt',
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-steer', permissionMode: 'full' as const }
    await start.execute({ task: '初始任务', title: '后台等待' }, ctx)
    await waitStartedPromise
    const running = await waitFor(async () => {
      const list = await tasks.list({ conversationId: 'c-steer', status: 'running' })
      return list[0] ?? null
    })
    expect(await tasks.queueSteerMessage(running.id, '追加检查测试覆盖。')).toBe(true)
    releaseWait()
    const done = await waitFor(async () => {
      const task = await tasks.get(running.id)
      return task?.status === 'completed' ? task : null
    })
    expect(done.result).toBe('queued message received')
    const secondStepText = received[1]!.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(secondStepText).toContain('[用户补充/纠偏] 追加检查测试覆盖。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('background agent isolation=worktree preserves dirty worktree and resume continues in it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-worktree-'))
  try {
    initGitRepo(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
      tools: ['write_file', 'read_file'],
    }
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'write1', name: 'write_file', input: { path: 'worker.txt', content: 'from isolated background agent' } }] },
      { kind: 'final', text: '初始完成' },
      { kind: 'tool_calls', calls: [{ id: 'read1', name: 'read_file', input: { path: 'worker.txt' } }] },
      { kind: 'final', text: '续跑读到文件' },
    ])
    const opts = {
      tasks,
      agents: [agent],
      model,
      baseTools: [fileWriteTool, fileReadTool],
      baseSystemPrompt: 'base prompt',
    }
    const start = createBackgroundAgentTaskTool(opts)
    const ctx = { workspace: new Workspace(root), conversationId: 'c-worktree', permissionMode: 'full' as const }
    await start.execute({ task: '在隔离 worktree 写文件', title: '后台隔离', isolation: 'worktree' }, ctx)

    const first = await waitFor(async () => {
      const list = await tasks.list({ conversationId: 'c-worktree' })
      return list[0]?.status === 'completed' ? list[0] : null
    })
    const metadata = await tasks.readBackgroundAgentMetadata(first.id)
    const worktreePath = metadata?.worktreePath
    expect(worktreePath).toBeTruthy()
    expect(existsSync(join(worktreePath!, 'worker.txt'))).toBe(true)
    expect(readFileSync(join(worktreePath!, 'worker.txt'), 'utf8')).toBe('from isolated background agent')
    expect(existsSync(join(root, 'worker.txt'))).toBe(false)

    await resumeBackgroundAgentTask(opts, first, '继续读取刚才写入的文件', ctx)
    const resumed = await waitFor(async () => {
      const task = await tasks.get(first.id)
      return task?.status === 'completed' && task.result === '续跑读到文件' ? task : null
    })
    const resumedMetadata = await tasks.readBackgroundAgentMetadata(resumed.id)
    expect(resumedMetadata?.worktreePath).toBe(worktreePath)
    expect(resumed.params?.agent_id).toBe(first.id)
    expect(resumedMetadata?.agentId).toBe(first.id)
    const finalModelCall = model.received.at(-1)
    expect(finalModelCall?.messages.some(message => message.content.some(block => block.type === 'tool_result' && typeof block.content === 'string' && block.content.includes('from isolated background agent')))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start_background_agent_task honors agent frontmatter defaults for prompt, permissions, tools and maxTurns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-agent-defaults-'))
  try {
    const tasks = new TaskService(root)
    let seenPermission = ''
    const inspectTool: Tool = {
      name: 'inspect_ctx',
      description: 'Inspect tool context.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_, toolCtx) {
        seenPermission = toolCtx.permissionMode ?? ''
        return 'ok'
      },
    }
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
      tools: ['inspect_ctx', 'write_file'],
      disallowedTools: ['write_file'],
      initialPrompt: '后台 agent 初始提示。',
      permissionMode: 'plan',
      maxTurns: 1,
    }
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'inspect1', name: 'inspect_ctx', input: {} }] },
      { kind: 'final', text: 'max turns fallback should win' },
    ])
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [inspectTool, fileWriteTool],
      baseSystemPrompt: 'base prompt',
    })
    // 父级 default:后台 agent frontmatter 声明的 permissionMode('plan')应被采用。
    const ctx = { workspace: new Workspace(root), conversationId: 'c-agent-defaults', permissionMode: 'default' as const }
    await start.execute({ task: '检查后台默认值', title: '后台默认值' }, ctx)
    const done = await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-agent-defaults' }))[0]
      return task?.status === 'completed' ? task : null
    })

    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'text',
      text: '后台 agent 初始提示。\n\n检查后台默认值',
    })
    expect(model.received[0]!.tools.map(tool => tool.name)).toEqual(['inspect_ctx'])
    expect(seenPermission).toBe('plan')
    expect(model.received[1]!.tools).toEqual([])
    expect(done.result).toBe('max turns fallback should win')
    expect(done.params).toMatchObject({
      agent: 'researcher',
      permission_mode: 'plan',
      max_turns: 1,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('background agent without declared mode falls back to acceptEdits (cc:async agents cannot answer prompts)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-bg-fallback-'))
  try {
    const tasks = new TaskService(root)
    let seenPermission = ''
    const inspectTool: Tool = {
      name: 'inspect_ctx',
      description: 'Inspect tool context.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_, toolCtx) {
        seenPermission = toolCtx.permissionMode ?? ''
        return 'ok'
      },
    }
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
      tools: ['inspect_ctx'],
      maxTurns: 1,
    }
    const start = createBackgroundAgentTaskTool({ tasks, agents: [agent], model: scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'i', name: 'inspect_ctx', input: {} }] },
      { kind: 'final', text: 'done' },
    ]), baseTools: [inspectTool], baseSystemPrompt: 'base' })
    // 父级 default,agent 未声明 permissionMode → 后台任务应兜底到 acceptEdits,而非继承 default(否则写操作卡在无人应答的 ask)
    await start.execute({ task: 't', title: 't' }, { workspace: new Workspace(root), conversationId: 'c-bg-fallback', permissionMode: 'default' })
    await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-bg-fallback' }))[0]
      return task?.status === 'completed' ? task : null
    })
    expect(seenPermission).toBe('acceptEdits')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start_background_agent_task runs agent frontmatter SubagentStart and SubagentStop hooks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-agent-hooks-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
      hooks: {
        rules: [
          { event: 'SubagentStart', matcher: 'researcher', handler: payload => ({ action: 'context', additionalContext: `bg-start:${payload.agentId}:${payload.agentType}` }) },
          { event: 'SubagentStop', matcher: 'researcher', handler: payload => ({ action: 'context', additionalContext: `bg-stop:${payload.agentId}:${payload.output}` }) },
        ],
      },
    }
    const model = scriptedModel([{ kind: 'final', text: '后台 hook 结论' }])
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [],
      baseSystemPrompt: 'base prompt',
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-agent-hooks', permissionMode: 'full' as const }
    await start.execute({ task: '检查后台 hook', title: '后台 hook' }, ctx)
    const done = await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-agent-hooks' }))[0]
      return task?.status === 'completed' ? task : null
    })
    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'text',
      text: `<hook_context event="SubagentStart">\nbg-start:${done.id}:researcher\n</hook_context>`,
    })
    const events = await tasks.loadEvents(done.id)
    const notes = events.map(record => record.event).filter((event): event is Extract<typeof event, { type: 'context_note' }> => event.type === 'context_note')
    expect(notes.some(event => event.text === `bg-start:${done.id}:researcher`)).toBe(true)
    expect(notes.some(event => event.text === `bg-stop:${done.id}:后台 hook 结论`)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start_background_agent_task initializes user memory from snapshot and injects it into system prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-agent-memory-'))
    const oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  try {
    const snapshotDir = join(root, '.claude', 'agent-memory-snapshots', 'researcher')
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify({ updatedAt: '2026-07-08T00:00:00.000Z' }), { flag: 'w' })
    writeFileSync(join(snapshotDir, 'MEMORY.md'), 'snapshot says: always inspect failing tests first\n')
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
      memory: 'user',
    }
    const model = scriptedModel([{ kind: 'final', text: '后台记忆完成' }])
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [],
      baseSystemPrompt: 'base prompt',
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-agent-memory', permissionMode: 'full' as const }
    await start.execute({ task: '检查后台记忆', title: '后台记忆' }, ctx)
    const done = await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-agent-memory' }))[0]
      return task?.status === 'completed' ? task : null
    })

    const memoryPath = getAgentMemoryEntrypoint('researcher', 'user', root)
    expect(readFileSync(memoryPath, 'utf8')).toContain('always inspect failing tests first')
    expect(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'agent-memory', 'researcher', '.snapshot-synced.json'), 'utf8')).toContain('2026-07-08T00:00:00.000Z')
    expect(model.received[0]!.system).toContain('# Persistent Agent Memory')
    expect(model.received[0]!.system).toContain('snapshot says: always inspect failing tests first')
    expect(done.result).toBe('后台记忆完成')
  } finally {
    if (oldClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir
    rmSync(root, { recursive: true, force: true })
  }
})

function writeFixtureMcpServer(root: string): string {
  const file = join(root, 'background-agent-fixture-mcp-server.ts')
  writeFileSync(file, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'background-agent-fixture', version: '1.0.0' })
server.registerTool('agent_echo', {
  description: 'Echo from a background agent-scoped MCP server',
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({
  content: [{ type: 'text', text: 'background-agent-mcp:' + text }],
}))
await server.connect(new StdioServerTransport())
`)
  return file
}

test('start_background_agent_task connects agent frontmatter mcpServers and injects MCP tools', async () => {
  const root = mkdtempSync(join(process.cwd(), '.task-tools-agent-mcp-'))
  try {
    const tasks = new TaskService(root)
    const fixture = writeFixtureMcpServer(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
      tools: ['mcp__background_agent_fixture__agent_echo'],
      mcpServers: [{ 'background agent fixture': { command: process.execPath, args: [fixture] } }],
      requiredMcpServers: ['background agent fixture'],
    }
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'mcp-bg-1', name: 'mcp__background_agent_fixture__agent_echo', input: { text: 'hello' } }] },
      { kind: 'final', text: '后台 MCP 完成' },
    ])
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [],
      baseSystemPrompt: 'base prompt',
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-agent-mcp', permissionMode: 'full' as const }
    await start.execute({ task: '调用后台 agent MCP', title: '后台 MCP' }, ctx)
    const done = await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-agent-mcp' }))[0]
      return task?.status === 'completed' ? task : null
    })

    expect(done.result).toBe('后台 MCP 完成')
    expect(model.received[0]!.tools.map(tool => tool.name)).toContain('mcp__background_agent_fixture__agent_echo')
    expect(model.received[1]!.messages.some(message =>
      message.content.some(block => block.type === 'tool_result' && typeof block.content === 'string' && block.content.includes('background-agent-mcp:hello')),
    )).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskOutput reads completed background task output and supports non-blocking running status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-output-'))
  try {
    const tasks = new TaskService(root)
    const task = await tasks.create({ title: '后台分析', kind: 'background_agent', conversationId: 'c2' })
    await tasks.touch(task.id, { status: 'completed', result: '任务结论' })
    await tasks.appendEvent(task.id, { type: 'final', text: '任务结论' })
    const taskOutput = createTaskTools(tasks).find(tool => tool.name === 'TaskOutput')!
    const ctx = { workspace: new Workspace(root), conversationId: 'c2', permissionMode: 'ask' as const }

    const completed = await taskOutput.execute({ task_id: task.id, block: false }, ctx)
    expect(completed).toContain('<retrieval_status>success</retrieval_status>')
    expect(completed).toContain('<task_id>')
    expect(completed).toContain('任务结论')

    const running = await tasks.create({ title: '长任务', kind: 'background_agent', conversationId: 'c2' })
    await tasks.touch(running.id, { status: 'running' })
    const notReady = await taskOutput.execute({ task_id: running.id, block: false }, ctx)
    expect(notReady).toContain('<retrieval_status>not_ready</retrieval_status>')
    expect(notReady).toContain('<status>running</status>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskOutput exposes CC-Haha AgentOutputTool and BashOutputTool aliases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-output-aliases-'))
  try {
    const tasks = new TaskService(root)
    const task = await tasks.create({ title: '后台输出 alias', kind: 'background_agent', conversationId: 'c-output-alias' })
    await tasks.touch(task.id, { status: 'completed', result: 'alias output ok' })
    await tasks.appendEvent(task.id, { type: 'final', text: 'alias output ok' })

    const tools = createTaskTools(tasks)
    const taskOutput = tools.find(tool => tool.name === 'TaskOutput')!
    const agentOutput = tools.find(tool => tool.name === 'AgentOutputTool')!
    const bashOutput = tools.find(tool => tool.name === 'BashOutputTool')!
    const ctx = { workspace: new Workspace(root), conversationId: 'c-output-alias', permissionMode: 'ask' as const }

    expect(await agentOutput.execute({ task_id: task.id, block: false }, ctx)).toBe(await taskOutput.execute({ task_id: task.id, block: false }, ctx))
    expect(await bashOutput.execute({ task_id: task.id, block: false }, ctx)).toContain('alias output ok')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskOutput can block until a running task completes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-output-block-'))
  try {
    const tasks = new TaskService(root)
    const task = await tasks.create({ title: '等待任务', kind: 'background_agent', conversationId: 'c3' })
    tasks.start(task.id, async ctx => {
      await new Promise(resolve => setTimeout(resolve, 20))
      await ctx.emit({ type: 'final', text: '稍后完成' })
      return '稍后完成'
    })
    const taskOutput = createTaskTools(tasks).find(tool => tool.name === 'TaskOutput')!
    const ctx = { workspace: new Workspace(root), conversationId: 'c3', permissionMode: 'ask' as const }

    const output = await taskOutput.execute({ task_id: task.id, block: true, timeout: 1000 }, ctx)
    expect(output).toContain('<retrieval_status>success</retrieval_status>')
    expect(output).toContain('稍后完成')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskOutput and read_background_task resolve old background agent ids to the latest resumed descendant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-output-chain-'))
  try {
    const tasks = new TaskService(root)
    const original = await tasks.create({
      id: 'chain_root',
      title: 'researcher: root',
      kind: 'background_agent',
      conversationId: 'c-chain-output',
      params: { agent: 'researcher', name: 'chain-reader', task: '初始任务' },
    })
    await tasks.touch(original.id, { status: 'completed', result: '旧结论' })
    await tasks.appendEvent(original.id, { type: 'final', text: '旧结论' })
    const latest = await tasks.create({
      id: 'chain_latest',
      title: 'researcher: latest',
      kind: 'background_agent',
      conversationId: 'c-chain-output',
      params: { agent: 'researcher', name: 'chain-reader', task: '续跑任务', resumed_from: original.id },
    })
    await tasks.touch(latest.id, { status: 'completed', result: '最新结论' })
    await tasks.appendEvent(latest.id, { type: 'final', text: '最新结论' })

    const tools = createTaskTools(tasks)
    const readTask = tools.find(tool => tool.name === 'read_background_task')!
    const taskOutput = tools.find(tool => tool.name === 'TaskOutput')!
    const ctx = { workspace: new Workspace(root), conversationId: 'c-chain-output', permissionMode: 'ask' as const }

    const events = await readTask.execute({ task_id: original.id }, ctx)
    expect(events).toContain(`id="${latest.id}"`)
    expect(events).toContain(`requested_id="${original.id}"`)
    expect(events).toContain('最新结论')
    expect(events).not.toContain('旧结论')

    const output = await taskOutput.execute({ task_id: original.id, block: false }, ctx)
    expect(output).toContain(`<requested_task_id>${original.id}</requested_task_id>`)
    expect(output).toContain(`<task_id>${latest.id}</task_id>`)
    expect(output).toContain('最新结论')
    expect(output).not.toContain('旧结论')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskOutput and read_background_task resolve stable background agent ids to the latest run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-output-stable-id-'))
  try {
    const tasks = new TaskService(root)
    const original = await tasks.create({
      id: 'stable_output_root',
      title: 'researcher: root',
      kind: 'background_agent',
      conversationId: 'c-stable-output',
      params: { agent_id: 'stable_agent_output', agent: 'researcher', name: 'stable-output', task: '初始任务' },
    })
    await tasks.touch(original.id, { status: 'completed', result: '旧结论' })
    const latest = await tasks.create({
      id: 'stable_output_latest',
      title: 'researcher: latest',
      kind: 'background_agent',
      conversationId: 'c-stable-output',
      params: { agent_id: 'stable_agent_output', agent: 'researcher', name: 'stable-output', task: '续跑任务', resumed_from: original.id },
    })
    await tasks.touch(latest.id, { status: 'completed', result: '最新结论' })
    await tasks.appendEvent(latest.id, { type: 'final', text: '最新结论' })

    const tools = createTaskTools(tasks)
    const readTask = tools.find(tool => tool.name === 'read_background_task')!
    const taskOutput = tools.find(tool => tool.name === 'TaskOutput')!
    const ctx = { workspace: new Workspace(root), conversationId: 'c-stable-output', permissionMode: 'ask' as const }

    const events = await readTask.execute({ task_id: 'stable_agent_output' }, ctx)
    expect(events).toContain(`id="${latest.id}"`)
    expect(events).toContain('requested_id="stable_agent_output"')
    expect(events).toContain('agent_id="stable_agent_output"')
    expect(events).toContain('最新结论')

    const output = await taskOutput.execute({ task_id: 'stable_agent_output', block: false }, ctx)
    expect(output).toContain('<requested_task_id>stable_agent_output</requested_task_id>')
    expect(output).toContain(`<task_id>${latest.id}</task_id>`)
    expect(output).toContain('<agent_id>stable_agent_output</agent_id>')
    expect(output).toContain('最新结论')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('list_background_tasks collapses resumed background agent chains to their latest leaves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-list-chain-'))
  try {
    const tasks = new TaskService(root)
    const original = await tasks.create({
      id: 'tool_list_root',
      title: 'researcher: root',
      kind: 'background_agent',
      conversationId: 'c-tool-list-chain',
      params: { agent: 'researcher', name: 'tool-list-chain', task: '初始任务' },
    })
    await tasks.touch(original.id, { status: 'completed', result: '旧结论' })
    const latest = await tasks.create({
      id: 'tool_list_latest',
      title: 'researcher: latest',
      kind: 'background_agent',
      conversationId: 'c-tool-list-chain',
      params: { agent: 'researcher', name: 'tool-list-chain', task: '续跑任务', resumed_from: original.id },
    })
    await tasks.touch(latest.id, { status: 'running' })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-tool-list-chain', permissionMode: 'ask' as const }
    const listTasks = createTaskTools(tasks).find(tool => tool.name === 'list_background_tasks')!

    const all = await listTasks.execute({}, ctx)
    expect(all).toContain(latest.id)
    expect(all).not.toContain(original.id)

    const completed = await listTasks.execute({ status: 'completed' }, ctx)
    expect(completed).toBe('当前没有后台任务。')
    const running = await listTasks.execute({ status: 'running' }, ctx)
    expect(running).toContain(latest.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskStop and cancel_background_task resolve old background agent ids to running descendants', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-stop-chain-'))
  try {
    const tasks = new TaskService(root)
    const ctx = { workspace: new Workspace(root), conversationId: 'c-chain-stop', permissionMode: 'full' as const }
    const tools = createTaskTools(tasks)
    const cancelTask = tools.find(tool => tool.name === 'cancel_background_task')!
    const taskStop = tools.find(tool => tool.name === 'TaskStop')!

    const cancelRoot = await tasks.create({
      id: 'cancel_root',
      title: 'researcher: cancel root',
      kind: 'background_agent',
      conversationId: 'c-chain-stop',
      params: { agent: 'researcher', name: 'cancel-chain', task: '初始取消任务' },
    })
    await tasks.touch(cancelRoot.id, { status: 'completed', result: '旧任务完成' })
    const cancelRunning = await tasks.create({
      id: 'cancel_running',
      title: 'researcher: cancel running',
      kind: 'background_agent',
      conversationId: 'c-chain-stop',
      params: { agent: 'researcher', name: 'cancel-chain', task: '运行中取消任务', resumed_from: cancelRoot.id },
    })
    tasks.start(cancelRunning.id, async taskCtx => {
      await new Promise<void>(resolve => taskCtx.signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    await waitFor(async () => (await tasks.get(cancelRunning.id))?.status === 'running' ? cancelRunning : null)
    const cancelled = await cancelTask.execute({ task_id: cancelRoot.id }, ctx)
    expect(cancelled).toContain(cancelRunning.id)
    expect(cancelled).toContain(`requested:${cancelRoot.id}`)
    await waitFor(async () => (await tasks.get(cancelRunning.id))?.status === 'cancelled' ? cancelRunning : null)

    const stopRoot = await tasks.create({
      id: 'stop_root',
      title: 'researcher: stop root',
      kind: 'background_agent',
      conversationId: 'c-chain-stop',
      params: { agent: 'researcher', name: 'stop-chain', task: '初始停止任务' },
    })
    await tasks.touch(stopRoot.id, { status: 'completed', result: '旧任务完成' })
    const stopRunning = await tasks.create({
      id: 'stop_running',
      title: 'researcher: stop running',
      kind: 'background_agent',
      conversationId: 'c-chain-stop',
      params: { agent: 'researcher', name: 'stop-chain', task: '运行中停止任务', resumed_from: stopRoot.id },
    })
    tasks.start(stopRunning.id, async taskCtx => {
      await new Promise<void>(resolve => taskCtx.signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    await waitFor(async () => (await tasks.get(stopRunning.id))?.status === 'running' ? stopRunning : null)
    const stopped = await taskStop.execute({ task_id: stopRoot.id }, ctx)
    expect(stopped).toContain(`<requested_task_id>${stopRoot.id}</requested_task_id>`)
    expect(stopped).toContain(`<task_id>${stopRunning.id}</task_id>`)
    await waitFor(async () => (await tasks.get(stopRunning.id))?.status === 'cancelled' ? stopRunning : null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskStop force-confirms and cancels a running background task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-stop-'))
  try {
    const tasks = new TaskService(root)
    const task = await tasks.create({ title: '可取消任务', kind: 'background_agent', conversationId: 'c4' })
    tasks.start(task.id, async ctx => {
      await new Promise<void>(resolve => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return 'cancelled'
    })
    await waitFor(async () => {
      const current = await tasks.get(task.id)
      return current?.status === 'running' ? current : null
    })
    const taskStop = createTaskTools(tasks).find(tool => tool.name === 'TaskStop')!
    const ctx = { workspace: new Workspace(root), conversationId: 'c4', permissionMode: 'full' as const }

    const decision = resolvePermission(taskStop, { task_id: task.id }, ctx)
    expect(decision.behavior).toBe('ask')
    const output = await taskStop.execute({ task_id: task.id }, ctx)
    expect(output).toContain('<task_stopped>')
    expect(output).toContain(task.id)
    const stopped = await tasks.get(task.id)
    expect(stopped?.status).toBe('cancelled')
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
