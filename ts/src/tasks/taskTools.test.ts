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
import { createBackgroundAgentTaskTool, createTaskTools, resumeBackgroundAgentTask, sanitizeBackgroundAgentResumeMessages, startBackgroundAgentRun } from './taskTools'
import { getAgentMemoryEntrypoint } from '../agents/agentMemory'
import { createAgentTaskTool } from '../agents/agentTool'
import { ToolRegistry } from '../tools/registry'
import { runAgentLoop } from '../harness/loop'

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
    const model = scriptedModel([{ kind: 'final', text: 'handoff done' }])

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
    })
    const done = await waitFor(async () => {
      const meta = await tasks.get('fg_handoff_1')
      return meta?.status === 'completed' ? meta : null
    })
    expect(done.result).toBe('handoff done')
    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({ type: 'text', text: '前台切后台' })
    expect(await tasks.readBackgroundAgentMetadata('fg_handoff_1')).toMatchObject({
      taskId: 'fg_handoff_1',
      agentId: 'stable_handoff_agent',
      agent: 'researcher',
      task: '前台切后台',
      conversationId: 'handoff-conv',
    })
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
    const events = await tasks.loadEvents(done.id)
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
    expect(finalModelCall?.messages.some(message => message.content.some(block => block.type === 'tool_result' && block.content.includes('from isolated background agent')))).toBe(true)
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
    const ctx = { workspace: new Workspace(root), conversationId: 'c-agent-defaults', permissionMode: 'full' as const }
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
      message.content.some(block => block.type === 'tool_result' && block.content.includes('background-agent-mcp:hello')),
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
