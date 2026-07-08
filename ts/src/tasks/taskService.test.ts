import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService, type TaskMeta } from './taskService'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('TaskService starts async runner, persists metadata and event log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-'))
  try {
    const tasks = new TaskService(root)
    const task = await tasks.create({ id: 't1', title: '后台研究', conversationId: 'c1', workspaceRoot: root })
    expect(task.status).toBe('queued')

    tasks.start('t1', async ctx => {
      await ctx.emit({ type: 'thinking', text: '研究中' })
      await ctx.emit({ type: 'final', text: '研究完成' })
      return '研究完成'
    })

    const done = await waitFor(async () => {
      const meta = await tasks.get('t1')
      return meta?.status === 'completed' ? meta : null
    })
    expect(done.result).toBe('研究完成')
    expect((await tasks.list({ conversationId: 'c1' })).map(t => t.id)).toEqual(['t1'])
    expect((await tasks.loadEvents('t1')).map(e => e.event.type)).toEqual(['started', 'thinking', 'final', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService persists task summary updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-summary-'))
  try {
    const tasks = new TaskService(root)
    await tasks.create({ id: 'summary_task_1', title: '后台摘要', kind: 'background_agent' })
    const updated = await tasks.touch('summary_task_1', { summary: 'Reading taskTools.ts', stage: '调用 read_file' })

    expect(updated.summary).toBe('Reading taskTools.ts')
    const reloaded = new TaskService(root)
    expect(await reloaded.get('summary_task_1')).toMatchObject({
      summary: 'Reading taskTools.ts',
      stage: '调用 read_file',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService can cancel a running task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-cancel-'))
  try {
    const tasks = new TaskService(root)
    await tasks.create({ id: 't1', title: '长任务' })
    tasks.start('t1', async ctx => {
      await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
    })

    await waitFor(async () => (await tasks.get('t1'))?.status === 'running' ? { ok: true } : null)
    expect(await tasks.cancel('t1')).toBe(true)
    const cancelled = await waitFor(async () => {
      const meta = await tasks.get('t1')
      return meta?.status === 'cancelled' ? meta : null
    })
    expect(cancelled.status).toBe('cancelled')
    expect((await tasks.loadEvents('t1')).some(e => e.event.type === 'context_note')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService registers foreground agents and signals background handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-foreground-handoff-'))
  try {
    const tasks = new TaskService(root)
    const registration = await tasks.registerForegroundAgent({
      taskId: 'fg_agent_1',
      agentId: 'stable_fg_1',
      agent: 'researcher',
      title: 'researcher: foreground',
      conversationId: 'c-fg',
      workspaceRoot: root,
      task: '检查 parser',
    })
    let signalled = false
    void registration.backgroundSignal.then(() => { signalled = true })

    expect(registration.task).toMatchObject({
      id: 'fg_agent_1',
      status: 'queued',
      kind: 'background_agent',
      conversationId: 'c-fg',
      params: {
        agent: 'researcher',
        agent_id: 'stable_fg_1',
        task: '检查 parser',
        foreground: true,
      },
    })

    const backgrounded = await registration.requestBackground()
    expect(backgrounded.status).toBe('running')
    expect(backgrounded.params).toMatchObject({ foreground: false, is_backgrounded: true })
    await waitFor(async () => signalled ? { ok: true } : null)
    const events = await tasks.loadEvents('fg_agent_1')
    expect(events.some(record => record.event.type === 'context_note' && 'text' in record.event && record.event.text.includes('切换到后台'))).toBe(true)
    await expect(tasks.requestForegroundAgentBackground('fg_agent_1')).rejects.toThrow('not registered')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService unregisters foreground agents that finish without handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-foreground-finish-'))
  try {
    const tasks = new TaskService(root)
    await tasks.registerForegroundAgent({
      taskId: 'fg_agent_done',
      agent: 'researcher',
      title: 'researcher: foreground done',
      task: '同步完成',
    })

    await tasks.unregisterForegroundAgent('fg_agent_done')
    const done = await tasks.get('fg_agent_done')
    expect(done).toMatchObject({
      status: 'completed',
      progress: 100,
      params: { agent: 'researcher', task: '同步完成', foreground: false },
    })
    await expect(tasks.requestForegroundAgentBackground('fg_agent_done')).rejects.toThrow('not registered')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService notifies settled tasks after the done event is persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-settled-'))
  try {
    let tasks!: TaskService
    let notified: { task: TaskMeta; eventTypes: string[] } | null = null
    tasks = new TaskService(root, {
      onSettled: async task => {
        notified = {
          task,
          eventTypes: (await tasks.loadEvents(task.id)).map(record => record.event.type),
        }
      },
    })
    await tasks.create({ id: 't1', title: '后台研究', kind: 'background_agent' })
    tasks.start('t1', async ctx => {
      await ctx.emit({ type: 'final', text: '研究完成' })
      return '研究完成'
    })

    const done = await waitFor(async () => notified)
    expect(done.task.status).toBe('completed')
    expect(done.task.result).toBe('研究完成')
    expect(done.eventTypes.at(-1)).toBe('done')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService persists background agent metadata sidecars and resolves targets from them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-agent-meta-'))
  try {
    const tasks = new TaskService(root)
    const task = await tasks.create({
      id: 'agent_meta_1',
      title: 'metadata-only agent',
      kind: 'background_agent',
      conversationId: 'c-meta',
      workspaceRoot: root,
    })
    const metadata = await tasks.writeBackgroundAgentMetadata(task.id, {
      agent: 'researcher',
      name: 'parser-auditor',
      description: 'metadata-only agent',
      conversationId: 'c-meta',
      workspaceRoot: root,
      task: '检查解析器',
      context: '保留原始上下文',
    })

    expect(metadata).toMatchObject({
      taskId: task.id,
      agent: 'researcher',
      agentType: 'researcher',
      name: 'parser-auditor',
      task: '检查解析器',
    })
    expect(await tasks.readBackgroundAgentMetadata(task.id)).toMatchObject({
      taskId: task.id,
      agent: 'researcher',
      name: 'parser-auditor',
    })
    expect((await tasks.resolveBackgroundAgentTarget('parser-auditor', { conversationId: 'c-meta' })).task?.id).toBe(task.id)
    expect((await tasks.resolveBackgroundAgentTarget('researcher', { conversationId: 'c-meta' })).task?.id).toBe(task.id)

    writeFileSync(tasks.backgroundAgentMetadataPath(task.id), '{bad json', 'utf8')
    expect(await tasks.readBackgroundAgentMetadata(task.id)).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService resolves orphaned background agents from metadata sidecars without tasks index entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-agent-orphan-meta-'))
  try {
    const tasks = new TaskService(root)
    await tasks.writeBackgroundAgentMetadata('orphan_agent_1', {
      agent: 'researcher',
      name: 'orphan-parser',
      description: 'orphan parser task',
      conversationId: 'c-orphan',
      workspaceRoot: root,
      task: '恢复孤儿 metadata',
      context: 'tasks.json 里没有这个任务',
    })

    expect(await tasks.list()).toEqual([])
    expect((await tasks.listBackgroundAgentMetadata()).map(meta => meta.taskId)).toEqual(['orphan_agent_1'])
    const byName = await tasks.resolveBackgroundAgentTarget('orphan-parser', {
      conversationId: 'c-orphan',
      statuses: ['completed', 'failed', 'cancelled'],
    })
    expect(byName.task).toMatchObject({
      id: 'orphan_agent_1',
      title: 'orphan parser task',
      status: 'completed',
      kind: 'background_agent',
      conversationId: 'c-orphan',
      workspaceRoot: root,
      params: {
        agent: 'researcher',
        name: 'orphan-parser',
        recovered_from_metadata: true,
      },
    })
    expect((await tasks.resolveBackgroundAgentTarget('orphan-parser', {
      conversationId: 'c-orphan',
      statuses: ['running'],
    })).task).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService resolves an old background task id to its latest resumed descendant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-agent-resume-chain-'))
  try {
    const tasks = new TaskService(root)
    const original = await tasks.create({
      id: 'chain_root',
      title: 'researcher: chain root',
      kind: 'background_agent',
      conversationId: 'c-chain',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'chain-agent', task: '初始任务' },
    })
    await tasks.touch(original.id, { status: 'completed', result: '初始完成' })
    const running = await tasks.create({
      id: 'chain_running',
      title: 'researcher: resumed running',
      kind: 'background_agent',
      conversationId: 'c-chain',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'chain-agent', task: '继续任务', resumed_from: original.id },
    })
    await tasks.touch(running.id, { status: 'running' })

    expect((await tasks.resolveBackgroundAgentTarget(original.id, {
      conversationId: 'c-chain',
      statuses: ['running'],
    })).task?.id).toBe(running.id)

    await tasks.touch(running.id, { status: 'completed', result: '继续完成' })
    expect((await tasks.resolveBackgroundAgentTarget(original.id, {
      conversationId: 'c-chain',
      statuses: ['completed', 'failed', 'cancelled'],
    })).task?.id).toBe(running.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService resolves a stable background agent id to the latest run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-agent-stable-id-'))
  try {
    const tasks = new TaskService(root)
    const original = await tasks.create({
      id: 'stable_root',
      title: 'researcher: stable root',
      kind: 'background_agent',
      conversationId: 'c-stable',
      workspaceRoot: root,
      params: { agent_id: 'agent_stable_1', agent: 'researcher', name: 'stable-agent', task: '初始任务' },
    })
    await tasks.writeBackgroundAgentMetadata(original.id, {
      agentId: 'agent_stable_1',
      agent: 'researcher',
      name: 'stable-agent',
      conversationId: 'c-stable',
      workspaceRoot: root,
      task: '初始任务',
    })
    await tasks.touch(original.id, { status: 'completed', result: '初始完成' })
    const latest = await tasks.create({
      id: 'stable_latest',
      title: 'researcher: stable latest',
      kind: 'background_agent',
      conversationId: 'c-stable',
      workspaceRoot: root,
      params: { agent_id: 'agent_stable_1', agent: 'researcher', name: 'stable-agent', task: '继续任务', resumed_from: original.id },
    })
    await tasks.writeBackgroundAgentMetadata(latest.id, {
      agentId: 'agent_stable_1',
      agent: 'researcher',
      name: 'stable-agent',
      conversationId: 'c-stable',
      workspaceRoot: root,
      task: '继续任务',
    })
    await tasks.touch(latest.id, { status: 'running' })

    expect((await tasks.resolveBackgroundAgentTarget('agent_stable_1', {
      conversationId: 'c-stable',
      statuses: ['running'],
    })).task?.id).toBe(latest.id)
    expect((await tasks.resolveBackgroundAgentTarget('agent_stable_1', {
      conversationId: 'c-stable',
      statuses: ['completed'],
    })).task?.id).toBe(original.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService can list background agents as collapsed resume-chain leaves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-agent-list-chain-'))
  try {
    const tasks = new TaskService(root)
    const original = await tasks.create({
      id: 'list_chain_root',
      title: 'researcher: chain root',
      kind: 'background_agent',
      conversationId: 'c-list-chain',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'list-chain', task: '初始任务' },
    })
    await tasks.touch(original.id, { status: 'completed', result: '初始完成' })
    const latest = await tasks.create({
      id: 'list_chain_latest',
      title: 'researcher: latest',
      kind: 'background_agent',
      conversationId: 'c-list-chain',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'list-chain', task: '继续任务', resumed_from: original.id },
    })
    await tasks.touch(latest.id, { status: 'running' })
    const standalone = await tasks.create({
      id: 'list_standalone',
      title: 'media job',
      kind: 'media',
      conversationId: 'c-list-chain',
    })
    await tasks.touch(standalone.id, { status: 'completed' })

    expect((await tasks.list({ conversationId: 'c-list-chain' })).map(task => task.id).sort()).toEqual([
      original.id,
      latest.id,
      standalone.id,
    ].sort())
    expect((await tasks.list({ conversationId: 'c-list-chain', collapseResumedBackgroundAgents: true })).map(task => task.id).sort()).toEqual([
      latest.id,
      standalone.id,
    ].sort())
    expect((await tasks.list({ conversationId: 'c-list-chain', status: 'completed', collapseResumedBackgroundAgents: true })).map(task => task.id)).toEqual([
      standalone.id,
    ])
    expect((await tasks.list({ conversationId: 'c-list-chain', status: 'running', collapseResumedBackgroundAgents: true })).map(task => task.id)).toEqual([
      latest.id,
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
