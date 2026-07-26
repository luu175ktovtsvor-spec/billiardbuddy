import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductTaskSocketLifecycleEvent } from '../api/taskSocket'

const apiMocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  getQueue: vi.fn(),
  mutateQueue: vi.fn(),
  steerQueue: vi.fn(),
  resumeQueue: vi.fn(),
  list: vi.fn(),
  currentLineage: vi.fn(),
  submitRun: vi.fn(),
  createDraft: vi.fn(),
  ingestAttachment: vi.fn(),
}))
const socketMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
}))

vi.mock('../api/tasks', () => ({
  productTasksApi: {
    getThread: apiMocks.getThread,
    getQueue: apiMocks.getQueue,
    mutateQueue: apiMocks.mutateQueue,
    steerQueue: apiMocks.steerQueue,
    resumeQueue: apiMocks.resumeQueue,
    list: apiMocks.list,
  },
  productConversationLineageApi: {
    current: apiMocks.currentLineage,
  },
  productTaskRunSubmitApi: {
    submit: apiMocks.submitRun,
  },
  productComposerDraftApi: {
    create: apiMocks.createDraft,
  },
  productAttachmentIngestApi: {
    ingest: apiMocks.ingestAttachment,
  },
}))

vi.mock('../api/taskSocket', () => ({
  productTaskSocket: socketMocks,
}))

import {
  canSendProductTaskMessage,
  canSendProductTaskText,
  useProductTaskRuntimeStore,
} from './productTaskRuntimeStore'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from './productTaskStore'
import { useTabStore } from '../../stores/tabStore'
import type { ProductTaskRecord } from '../domain/types'

let eventHandler: ((event: any) => void) | null = null
let lifecycleHandler: ((event: ProductTaskSocketLifecycleEvent) => void) | null = null

function wireTaskSocket(): void {
  socketMocks.connect.mockImplementation((
    _taskId: string,
    handler: (event: any) => void,
    lifecycle: (event: ProductTaskSocketLifecycleEvent) => void,
  ) => {
    eventHandler = handler
    lifecycleHandler = lifecycle
    return () => {}
  })
}

function threadEntry(
  id: string,
  type: 'user_text' | 'assistant_text',
  text: string,
) {
  return {
    id,
    type,
    text,
    createdAt: '2026-07-19T00:00:00.000Z',
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('product task runtime store', () => {
  beforeEach(() => {
    socketMocks.send.mockReturnValue(true)
  })

  afterEach(() => {
    for (const taskId of Object.keys(useProductTaskRuntimeStore.getState().tasks)) {
      useProductTaskRuntimeStore.getState().disconnectTask(taskId)
    }
    useProductTaskRuntimeStore.setState({ tasks: {} })
    useProductTaskStore.setState({
      index: EMPTY_PRODUCT_TASK_INDEX,
      isLoading: false,
      error: null,
      mutations: {},
    })
    useTabStore.setState({ tabs: [], activeTabId: null })
    apiMocks.getThread.mockReset()
    apiMocks.getQueue.mockReset()
    apiMocks.mutateQueue.mockReset()
    apiMocks.steerQueue.mockReset()
    apiMocks.resumeQueue.mockReset()
    apiMocks.list.mockReset()
    apiMocks.currentLineage.mockReset()
    apiMocks.submitRun.mockReset()
    apiMocks.createDraft.mockReset()
    apiMocks.ingestAttachment.mockReset()
    socketMocks.connect.mockReset()
    socketMocks.disconnect.mockReset()
    socketMocks.send.mockReset()
    eventHandler = null
    lifecycleHandler = null
  })

  it('loads a product thread and applies only task-safe live events', async () => {
    const activityId = `activity_${'a'.repeat(32)}`
    apiMocks.getThread.mockResolvedValue({
      taskId: 'task-1',
      entries: [{
        id: 'thread-history-1',
        type: 'assistant_text',
        text: '历史回复',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    })
    apiMocks.getQueue.mockResolvedValue({ items: [] })
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-1')
    eventHandler?.({ type: 'connected' })
    eventHandler?.({ type: 'assistant_text_start' })
    eventHandler?.({ type: 'assistant_text_delta', text: '实时回复' })
    eventHandler?.({
      type: 'activity',
      id: activityId,
      kind: 'workspace',
      phase: 'completed',
      summary: '已整理工作内容',
    })

    const runtime = useProductTaskRuntimeStore.getState().tasks['task-1']!
    expect(runtime.connectionState).toBe('connected')
    expect(runtime.historyStatus).toBe('ready')
    expect(runtime.entries.map((entry) => entry.type)).toEqual([
      'assistant_text',
      'assistant_text',
    ])
    expect(runtime.entries[1]).toEqual(expect.objectContaining({ text: '实时回复' }))
    expect(runtime.runActivities).toEqual([
      expect.objectContaining({ id: activityId, kind: 'workspace', phase: 'completed' }),
    ])
  })

  it('disconnects and forgets the transcript projection after durable task deletion', async () => {
    apiMocks.getThread.mockResolvedValue({ taskId: 'task-delete', entries: [] })
    apiMocks.getQueue.mockResolvedValue({ items: [] })
    wireTaskSocket()
    await useProductTaskRuntimeStore.getState().connectTask('task-delete')

    useProductTaskRuntimeStore.getState().forgetTask('task-delete')

    expect(socketMocks.disconnect).toHaveBeenCalledWith('task-delete')
    expect(useProductTaskRuntimeStore.getState().tasks).not.toHaveProperty('task-delete')
  })

  it('restores queued input and removes it only after durable assignment', async () => {
    const queued = {
      id: 'queue_123e4567-e89b-42d3-a456-426614174000',
      text: '请补充风险说明',
      state: 'queued' as const,
      createdAt: '2026-07-26T00:00:00.000Z',
      attachmentCount: 0,
    }
    apiMocks.getThread.mockResolvedValue({ taskId: 'task-queue', entries: [] })
    apiMocks.getQueue.mockResolvedValue({ items: [queued] })
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-queue')
    expect(useProductTaskRuntimeStore.getState().tasks['task-queue']?.queuedInputs).toEqual([queued])

    eventHandler?.({
      type: 'queue_updated',
      item: { ...queued, state: 'injected', targetRunId: 'run_123e4567-e89b-42d3-a456-426614174000' },
      event_sequence: 3,
    })
    expect(useProductTaskRuntimeStore.getState().tasks['task-queue']?.queuedInputs).toEqual([])
  })

  it('keeps only the latest public phase for each compact item', () => {
    const store = useProductTaskRuntimeStore.getState()
    const id = `compact_${'c'.repeat(32)}`
    store.handleEvent('task-compact', { type: 'context_compaction', item: { id, phase: 'started', source: 'automatic', generation: 1 }, event_sequence: 2 })
    store.handleEvent('task-compact', { type: 'context_compaction', item: { id, phase: 'completed', source: 'automatic', generation: 1 }, event_sequence: 3 })
    expect(useProductTaskRuntimeStore.getState().tasks['task-compact']?.contextCompactions).toEqual([{ id, phase: 'completed', source: 'automatic', generation: 1 }])
  })

  it('reconciles durable assistant and terminal replay with the canonical thread', async () => {
    apiMocks.list.mockResolvedValue(EMPTY_PRODUCT_TASK_INDEX)
    apiMocks.getThread.mockResolvedValue({
      taskId: 'task-replay',
      entries: [threadEntry('thread_0123456789abcdef0123', 'assistant_text', '重连后的答案')],
    })
    const store = useProductTaskRuntimeStore.getState()
    store.handleEvent('task-replay', { type: 'assistant_text', id: 'thread_0123456789abcdef0123', text: '重连后的答案', replayed: true, event_sequence: 4 })
    store.handleEvent('task-replay', { type: 'run_terminal', id: `turn_${'a'.repeat(32)}`, state: 'completed', replayed: true, event_sequence: 5 })
    await flushMicrotasks()
    const runtime = useProductTaskRuntimeStore.getState().tasks['task-replay']!
    expect(runtime.runState).toBe('idle')
    expect(runtime.recoveryRequired).toBe(false)
    expect(runtime.entries).toEqual([threadEntry('thread_0123456789abcdef0123', 'assistant_text', '重连后的答案')])
  })

  it('keeps a bounded opaque run activity tree separate from the message transcript', async () => {
    const store = useProductTaskRuntimeStore.getState()
    const parentId = `activity_${'a'.repeat(32)}`
    const childId = `activity_${'b'.repeat(32)}`

    store.handleEvent('task-run-tree', {
      type: 'activity',
      id: parentId,
      kind: 'workspace',
      phase: 'started',
      summary: '正在整理任务计划',
    })
    store.handleEvent('task-run-tree', {
      type: 'activity',
      id: childId,
      parentId,
      kind: 'subtask',
      phase: 'running',
      summary: '正在协同处理事项',
      progress: { completed: 1, total: 2 },
    })
    store.handleEvent('task-run-tree', {
      type: 'activity',
      id: childId,
      parentId,
      kind: 'subtask',
      phase: 'completed',
      summary: '已完成协同事项',
      progress: { completed: 2, total: 2 },
    })

    const runtime = useProductTaskRuntimeStore.getState().tasks['task-run-tree']!
    expect(runtime.runActivities).toEqual([
      expect.objectContaining({ id: parentId, summary: '正在整理任务计划', phase: 'started' }),
      expect.objectContaining({
        id: childId,
        parentId,
        summary: '已完成协同事项',
        progress: { completed: 2, total: 2 },
      }),
    ])
    expect(runtime.entries).toEqual([])

    await expect(store.sendText('task-run-tree', '开始下一项')).resolves.toBe(false)
    expect(useProductTaskRuntimeStore.getState().tasks['task-run-tree']?.runActivities).toHaveLength(2)
  })

  it('replaces stale run state with a snapshot and accepts later activity updates', () => {
    const store = useProductTaskRuntimeStore.getState()
    const staleId = `activity_${'a'.repeat(32)}`
    const parentId = `activity_${'b'.repeat(32)}`
    const activeId = `activity_${'c'.repeat(32)}`

    store.handleEvent('task-run-snapshot', {
      type: 'activity',
      id: staleId,
      kind: 'command',
      phase: 'running',
      summary: '正在处理任务操作',
    })
    store.handleEvent('task-run-snapshot', {
      type: 'approval_required',
      requestId: 'stale-approval',
      kind: 'action',
    })
    expect(store.respondToApproval('task-run-snapshot', true)).toBe(true)

    store.handleEvent('task-run-snapshot', {
      type: 'run_snapshot',
      state: 'working',
      activities: [
        {
          id: parentId,
          kind: 'workspace',
          phase: 'completed',
          summary: '已整理任务计划',
        },
        {
          id: activeId,
          parentId,
          kind: 'subtask',
          phase: 'running',
          summary: '正在协同处理事项',
          progress: { completed: 1, total: 2 },
        },
      ],
    })

    let runtime = useProductTaskRuntimeStore.getState().tasks['task-run-snapshot']!
    expect(runtime).toEqual(expect.objectContaining({
      runState: 'working',
      runActivities: [
        expect.objectContaining({ id: parentId, phase: 'completed' }),
        expect.objectContaining({ id: activeId, parentId, phase: 'running' }),
      ],
      activeActivity: {
        kind: 'subtask',
        phase: 'running',
        summary: '正在协同处理事项',
      },
      pendingApproval: null,
      approvalResponsePending: false,
    }))
    expect(runtime.runActivities.some((activity) => activity.id === staleId)).toBe(false)

    store.handleEvent('task-run-snapshot', {
      type: 'activity',
      id: activeId,
      parentId,
      kind: 'subtask',
      phase: 'completed',
      summary: '已完成协同事项',
      progress: { completed: 2, total: 2 },
    })
    store.handleEvent('task-run-snapshot', {
      type: 'approval_required',
      requestId: 'replayed-approval',
      kind: 'action',
    })

    runtime = useProductTaskRuntimeStore.getState().tasks['task-run-snapshot']!
    expect(runtime.runActivities).toEqual([
      expect.objectContaining({ id: parentId, phase: 'completed' }),
      expect.objectContaining({
        id: activeId,
        phase: 'completed',
        summary: '已完成协同事项',
        progress: { completed: 2, total: 2 },
      }),
    ])
    expect(runtime.pendingApproval).toEqual({ requestId: 'replayed-approval', kind: 'action' })
    expect(runtime.approvalResponsePending).toBe(false)
  })

  it('keeps a socket run snapshot when the concurrent history request resolves', async () => {
    const pendingThread = deferred<unknown>()
    const activeId = `activity_${'d'.repeat(32)}`
    apiMocks.getThread.mockReturnValue(pendingThread.promise)
    wireTaskSocket()

    const connecting = useProductTaskRuntimeStore.getState().connectTask('task-snapshot-history')
    eventHandler?.({
      type: 'run_snapshot',
      state: 'working',
      activities: [{
        id: activeId,
        kind: 'workspace',
        phase: 'running',
        summary: '正在整理工作内容',
      }],
    })
    pendingThread.resolve({
      taskId: 'task-snapshot-history',
      entries: [threadEntry('thread-history', 'assistant_text', '历史内容')],
    })
    await connecting

    expect(useProductTaskRuntimeStore.getState().tasks['task-snapshot-history']).toEqual(
      expect.objectContaining({
        historyStatus: 'ready',
        entries: [threadEntry('thread-history', 'assistant_text', '历史内容')],
        runState: 'working',
        runActivities: [expect.objectContaining({ id: activeId, phase: 'running' })],
        activeActivity: {
          kind: 'workspace',
          phase: 'running',
          summary: '正在整理工作内容',
        },
      }),
    )
  })

  it('keeps completed historical activity in the canonical thread snapshot', async () => {
    const activityId = `activity_${'e'.repeat(32)}`
    apiMocks.list.mockResolvedValue(EMPTY_PRODUCT_TASK_INDEX)
    apiMocks.getThread
      .mockResolvedValueOnce({ taskId: 'task-complete', entries: [] })
      .mockResolvedValueOnce({
        taskId: 'task-complete',
        entries: [
          threadEntry('thread-user', 'user_text', '整理今天订单'),
          threadEntry('thread-assistant', 'assistant_text', '已整理完成'),
          {
            id: 'thread-activity',
            type: 'activity',
            kind: 'workspace',
            phase: 'completed',
            createdAt: '2026-07-19T00:00:01.000Z',
          },
        ],
      })
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-complete')
    const store = useProductTaskRuntimeStore.getState()
    store.sendText('task-complete', '整理今天订单')
    eventHandler?.({ type: 'assistant_text_start' })
    eventHandler?.({ type: 'assistant_text_delta', text: '已整理完成' })
    eventHandler?.({
      type: 'activity',
      id: activityId,
      kind: 'workspace',
      phase: 'completed',
      summary: '已整理工作内容',
    })
    eventHandler?.({ type: 'turn_complete' })
    await flushMicrotasks()

    expect(apiMocks.list).toHaveBeenCalledOnce()

    expect(useProductTaskRuntimeStore.getState().tasks['task-complete']?.entries).toEqual([
      threadEntry('thread-user', 'user_text', '整理今天订单'),
      threadEntry('thread-assistant', 'assistant_text', '已整理完成'),
      {
        id: 'thread-activity',
        type: 'activity',
        kind: 'workspace',
        phase: 'completed',
        createdAt: '2026-07-19T00:00:01.000Z',
      },
    ])
  })

  it('hydrates the latest thread after a socket reconnection', async () => {
    apiMocks.getThread
      .mockResolvedValueOnce({
        taskId: 'task-reconnect',
        entries: [threadEntry('thread-before', 'assistant_text', '断线前')],
      })
      .mockResolvedValueOnce({
        taskId: 'task-reconnect',
        entries: [
          threadEntry('thread-before', 'assistant_text', '断线前'),
          threadEntry('thread-user', 'user_text', '断线期间完成'),
          threadEntry('thread-after', 'assistant_text', '已完成'),
        ],
      })
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-reconnect')
    useProductTaskRuntimeStore.getState().sendText('task-reconnect', '断线期间完成')
    eventHandler?.({ type: 'assistant_text_start' })
    eventHandler?.({ type: 'assistant_text_delta', text: '已完成' })
    lifecycleHandler?.({ type: 'disconnected', willReconnect: true })
    expect(useProductTaskRuntimeStore.getState().tasks['task-reconnect']?.connectionState).toBe('disconnected')

    lifecycleHandler?.({ type: 'reconnecting' })
    expect(useProductTaskRuntimeStore.getState().tasks['task-reconnect']?.connectionState).toBe('connecting')

    lifecycleHandler?.({ type: 'connected', reconnected: true })
    await flushMicrotasks()

    const runtime = useProductTaskRuntimeStore.getState().tasks['task-reconnect']!
    expect(runtime.connectionState).toBe('connected')
    expect(runtime.entries).toEqual([
      threadEntry('thread-before', 'assistant_text', '断线前'),
      threadEntry('thread-user', 'user_text', '断线期间完成'),
      threadEntry('thread-after', 'assistant_text', '已完成'),
    ])
    expect(apiMocks.getThread).toHaveBeenCalledTimes(2)
  })

  it('restores a durable recovery blocker after reconnect instead of showing a stale working run', async () => {
    apiMocks.getThread
      .mockResolvedValueOnce({ taskId: 'task-recovery-reconnect', entries: [] })
      .mockResolvedValueOnce({ taskId: 'task-recovery-reconnect', entries: [], recoveryRequired: true })
    wireTaskSocket()
    await useProductTaskRuntimeStore.getState().connectTask('task-recovery-reconnect')
    eventHandler?.({ type: 'run_snapshot', state: 'working', activities: [] })
    lifecycleHandler?.({ type: 'connected', reconnected: true })
    await flushMicrotasks()
    expect(useProductTaskRuntimeStore.getState().tasks['task-recovery-reconnect']).toEqual(expect.objectContaining({ recoveryRequired: true, runState: 'idle', stopRequested: false }))
  })

  it('fences late assistant content after stop until the terminal refresh', async () => {
    apiMocks.getThread
      .mockResolvedValueOnce({ taskId: 'task-stop', entries: [] })
      .mockResolvedValueOnce({
        taskId: 'task-stop',
        entries: [threadEntry('thread-stopped', 'assistant_text', '停止前内容')],
      })
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-stop')
    eventHandler?.({ type: 'status', state: 'working' })
    eventHandler?.({ type: 'assistant_text_start' })
    eventHandler?.({ type: 'assistant_text_delta', text: '停止前内容' })
    useProductTaskRuntimeStore.getState().stopTask('task-stop')
    eventHandler?.({ type: 'assistant_text_delta', text: '不应出现的晚到内容' })

    expect(socketMocks.send).toHaveBeenCalledWith('task-stop', { type: 'stop_generation' })
    expect(useProductTaskRuntimeStore.getState().tasks['task-stop']?.entries.at(-1)).toEqual(
      expect.objectContaining({ text: '停止前内容' }),
    )

    eventHandler?.({ type: 'turn_complete' })
    await flushMicrotasks()
    expect(useProductTaskRuntimeStore.getState().tasks['task-stop']).toMatchObject({
      runState: 'idle',
      stopRequested: false,
      entries: [expect.objectContaining({ text: '停止前内容' })],
    })
  })

  it('does not apply an in-flight history response after task disconnect', async () => {
    const pendingThread = deferred<unknown>()
    apiMocks.getThread.mockReturnValue(pendingThread.promise)
    wireTaskSocket()

    const connecting = useProductTaskRuntimeStore.getState().connectTask('task-disconnect')
    useProductTaskRuntimeStore.getState().disconnectTask('task-disconnect')
    pendingThread.resolve({
      taskId: 'task-disconnect',
      entries: [threadEntry('thread-stale', 'assistant_text', '不应写入')],
    })
    await connecting

    const runtime = useProductTaskRuntimeStore.getState().tasks['task-disconnect']!
    expect(runtime.connectionState).toBe('disconnected')
    expect(runtime.historyStatus).toBe('idle')
    expect(runtime.entries).toEqual([])
  })

  it('rejects an invalid or cross-task transcript before it reaches task state', async () => {
    apiMocks.getThread.mockResolvedValue({
      taskId: 'other-task',
      entries: [threadEntry('thread-other', 'assistant_text', '不应显示')],
    })
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-invalid-thread')

    const runtime = useProductTaskRuntimeStore.getState().tasks['task-invalid-thread']!
    expect(runtime.historyStatus).toBe('error')
    expect(runtime.entries).toEqual([])
  })

  it('rejects malformed transcript entries before they reach task state', async () => {
    apiMocks.getThread.mockResolvedValue({
      taskId: 'task-malformed-thread',
      entries: [{
        id: 'thread-malformed',
        type: 'assistant_text',
        text: { raw: 'must not render' },
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    })
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-malformed-thread')

    const runtime = useProductTaskRuntimeStore.getState().tasks['task-malformed-thread']!
    expect(runtime.historyStatus).toBe('error')
    expect(runtime.entries).toEqual([])
  })

  it('submits text through the durable run API without turning the socket into a second transport', async () => {
    const store = useProductTaskRuntimeStore.getState()

    await expect(store.sendText('task-2', '   ')).resolves.toBe(false)
    expect(socketMocks.send).not.toHaveBeenCalled()

    useProductTaskStore.setState({
      index: {
        ...EMPTY_PRODUCT_TASK_INDEX,
        tasks: [{
          id: 'task-2',
          revision: 3,
          current_lineage_id: 'lineage-2',
          projectId: 'project-2',
          directoryId: 'directory-2',
          workDir: '/workspace/two',
          title: '整理订单',
          lifecycle: 'active',
          kind: 'main',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
          worktreeState: 'not_requested',
          actions: [],
        }],
        total: 1,
      },
    })
    apiMocks.currentLineage.mockResolvedValue({
      lineage: {
        lineage_id: 'lineage-2',
        product_task_id: 'task-2',
        revision: 2,
        compact_generation: 0,
        state: 'active',
        created_at: '2026-07-19T00:00:00.000Z',
        updated_at: '2026-07-19T00:00:00.000Z',
      },
    })
    apiMocks.submitRun.mockResolvedValue({
      receipt: {
        outcome: 'accepted',
        authority_revision: 9,
        result: {
          task_id: 'task-2',
          run_id: 'run-2',
          entry_id: 'entry-2',
          dispatch_generation: 1,
        },
      },
    })
    apiMocks.list.mockResolvedValue(useProductTaskStore.getState().index)

    await expect(store.sendText('task-2', '  /skill ball-hall-daily-review 整理今天订单  ')).resolves.toBe(true)
    expect(socketMocks.send).not.toHaveBeenCalled()
    expect(apiMocks.submitRun).toHaveBeenCalledWith('task-2', expect.objectContaining({
      expected_task_revision: 3,
      expected_lineage_revision: 2,
      text: '/skill ball-hall-daily-review 整理今天订单',
      attachment_ids: [],
    }))
    expect(useProductTaskRuntimeStore.getState().tasks['task-2']).toMatchObject({
      runState: 'working',
      entries: [expect.objectContaining({ type: 'user_text', text: '/skill ball-hall-daily-review 整理今天订单' })],
    })
  })

  it('accepts a durable follow-up queue item without pretending it is already in the Turn', async () => {
    const task: ProductTaskRecord = {
      id: 'task-queue', revision: 4, current_lineage_id: 'lineage-queue', projectId: 'project', directoryId: 'directory', workDir: '/workspace', title: '排队任务', lifecycle: 'active', kind: 'main', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z', worktreeState: 'not_requested', actions: [],
    }
    useProductTaskStore.setState({ index: { ...EMPTY_PRODUCT_TASK_INDEX, tasks: [task], total: 1 } })
    useProductTaskRuntimeStore.getState().handleEvent(task.id, { type: 'status', state: 'working' })
    apiMocks.currentLineage.mockResolvedValue({ lineage: { lineage_id: 'lineage-queue', product_task_id: task.id, revision: 3 } })
    apiMocks.submitRun.mockResolvedValue({ receipt: { outcome: 'accepted', authority_revision: 10, result: { task_id: task.id, queue_item_id: 'queue_123e4567-e89b-42d3-a456-426614174000', entry_id: 'entry-queued', delivery: 'queued' } } })
    apiMocks.list.mockResolvedValue(useProductTaskStore.getState().index)
    apiMocks.getQueue.mockResolvedValue({ items: [{ id: 'queue_123e4567-e89b-42d3-a456-426614174000', text: '接着整理下一批订单', state: 'queued', createdAt: '2026-07-26T00:00:00.000Z', attachmentCount: 0 }] })

    await expect(useProductTaskRuntimeStore.getState().sendText(task.id, '接着整理下一批订单')).resolves.toBe(true)
    expect(apiMocks.submitRun).toHaveBeenCalledWith(task.id, expect.objectContaining({ expected_task_revision: 4, expected_lineage_revision: 3, text: '接着整理下一批订单' }))
    expect(useProductTaskRuntimeStore.getState().tasks[task.id]).toMatchObject({
      runState: 'working',
      entries: [],
      queuedInputs: [expect.objectContaining({ id: 'queue_123e4567-e89b-42d3-a456-426614174000', text: '接着整理下一批订单' })],
    })
  })

  it('applies authoritative queue edits and explicit steer snapshots', async () => {
    const task: ProductTaskRecord = {
      id: 'task-manage-queue', revision: 4, current_lineage_id: 'lineage-queue', projectId: 'project', directoryId: 'directory', workDir: '/workspace', title: '管理队列', lifecycle: 'active', kind: 'main', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z', worktreeState: 'not_requested', actions: [],
    }
    const queued = { id: 'queue_123e4567-e89b-42d3-a456-426614174000', text: '原始内容', state: 'queued' as const, createdAt: '2026-07-26T00:00:00.000Z', attachmentCount: 0 }
    useProductTaskStore.setState({ index: { ...EMPTY_PRODUCT_TASK_INDEX, tasks: [task], total: 1 } })
    useProductTaskRuntimeStore.setState({ tasks: { [task.id]: { ...useProductTaskRuntimeStore.getState().tasks[task.id], connectionState: 'connected', historyStatus: 'ready', runState: 'working', entries: [], queuedInputs: [queued], activeActivity: null, runActivities: [], contextCompactions: [], pendingApproval: null, approvalResponsePending: false, error: null, streamingEntryId: null, stopRequested: false, recoveryRequired: false } } })
    apiMocks.list.mockResolvedValue({ ...EMPTY_PRODUCT_TASK_INDEX, tasks: [task], total: 1 })
    apiMocks.mutateQueue.mockResolvedValue({ outcome: 'accepted', task_revision: 5, items: [{ ...queued, text: '修改后的内容' }] })

    await expect(useProductTaskRuntimeStore.getState().editQueuedInput(task.id, queued.id, '修改后的内容')).resolves.toBe(true)
    expect(apiMocks.mutateQueue).toHaveBeenCalledWith(task.id, expect.objectContaining({ action: 'edit', queue_item_id: queued.id, text: '修改后的内容', expected_task_revision: 4 }))
    expect(useProductTaskRuntimeStore.getState().tasks[task.id]?.queuedInputs).toEqual([{ ...queued, text: '修改后的内容' }])

    apiMocks.steerQueue.mockResolvedValue({ outcome: 'accepted', task_revision: 5, delivery: 'steer', items: [{ ...queued, text: '修改后的内容', targetRunId: 'run_123e4567-e89b-42d3-a456-426614174111' }] })
    await expect(useProductTaskRuntimeStore.getState().steerQueuedInput(task.id, queued.id)).resolves.toBe(true)
    expect(apiMocks.steerQueue).toHaveBeenCalledWith(task.id, expect.objectContaining({ queue_item_id: queued.id, expected_task_revision: 4 }))
    expect(useProductTaskRuntimeStore.getState().tasks[task.id]?.queuedInputs[0]).toMatchObject({ id: queued.id, targetRunId: 'run_123e4567-e89b-42d3-a456-426614174111' })
  })

  it('matches the product text boundary before creating optimistic task state', () => {
    expect(canSendProductTaskText('普通任务内容')).toBe(true)
    expect(canSendProductTaskText('  /Agent 研究下周活动方案')).toBe(true)
    expect(canSendProductTaskText('x'.repeat(32_001))).toBe(false)
    expect(canSendProductTaskMessage('', [{
      type: 'image',
      name: '球台.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,QQ==',
    }])).toBe(true)
  })

  it('ingests attachments under a composer draft before submitting only their ids', async () => {
    const task: ProductTaskRecord = {
      id: 'task-attachment-submit', revision: 1, current_lineage_id: 'lineage-attachment',
      projectId: 'project', directoryId: 'directory', workDir: '/workspace', title: '附件任务',
      lifecycle: 'active', kind: 'main', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
      worktreeState: 'not_requested', actions: [],
    }
    useProductTaskStore.setState({ index: { ...EMPTY_PRODUCT_TASK_INDEX, tasks: [task], total: 1 } })
    apiMocks.currentLineage.mockResolvedValue({ lineage: { lineage_id: 'lineage-attachment', product_task_id: task.id, revision: 4 } })
    apiMocks.createDraft.mockResolvedValue({ draft: { draft_id: 'draft-attachment', revision: 0 } })
    apiMocks.ingestAttachment.mockResolvedValue({ attachment: { attachment_id: 'attachment-ready', attachment_revision: 2, authority_revision: 8, outcome: 'accepted' } })
    apiMocks.submitRun.mockResolvedValue({ receipt: { outcome: 'accepted', authority_revision: 9, result: { task_id: task.id, run_id: 'run', entry_id: 'entry', dispatch_generation: 1 } } })
    apiMocks.list.mockResolvedValue(useProductTaskStore.getState().index)
    const attachment = { type: 'image' as const, name: '球台.png', mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }

    await expect(useProductTaskRuntimeStore.getState().sendMessage(task.id, '', [attachment])).resolves.toBe(true)

    expect(apiMocks.ingestAttachment).toHaveBeenCalledWith('draft-attachment', expect.objectContaining({
      type: 'image', name: '球台.png', mime_type: 'image/png', data: attachment.data,
    }))
    expect(apiMocks.submitRun).toHaveBeenCalledWith(task.id, expect.objectContaining({
      text: '请分析这个附件。', draft_id: 'draft-attachment', expected_draft_revision: 0, attachment_ids: ['attachment-ready'],
    }))
    expect(JSON.stringify(apiMocks.submitRun.mock.calls)).not.toContain('base64')
  })

  it('sends only the narrow approval and question response envelopes', () => {
    const store = useProductTaskRuntimeStore.getState()
    store.handleEvent('task-approval', {
      type: 'approval_required',
      requestId: 'permission-1',
      kind: 'action',
    })

    expect(store.respondToApproval('task-approval', true)).toBe(true)
    expect(socketMocks.send).toHaveBeenCalledWith('task-approval', {
      type: 'permission_response',
      requestId: 'permission-1',
      allowed: true,
    })

    store.handleEvent('task-question', {
      type: 'approval_required',
      requestId: 'question-1',
      kind: 'question',
      questions: [{ question: '选择方案', options: [{ label: '方案 A' }] }],
    })

    expect(store.respondToQuestions('task-question', ['方案 A'])).toBe(true)
    expect(socketMocks.send).toHaveBeenCalledWith('task-question', {
      type: 'ask_user_question_response',
      requestId: 'question-1',
      answers: ['方案 A'],
    })
    expect(store.respondToQuestions('task-question', ['方案 A'])).toBe(false)

  })

  it('records a safe error code instead of a raw runtime error message', () => {
    useProductTaskRuntimeStore.getState().handleEvent('task-3', {
      type: 'error',
      code: 'temporarily_unavailable',
      retryable: true,
    })

    expect(useProductTaskRuntimeStore.getState().tasks['task-3']?.error).toEqual({
      code: 'temporarily_unavailable',
      retryable: true,
    })
  })

  it('synchronizes a streamed title to the product index and product task tab only', () => {
    const task: ProductTaskRecord = {
      id: 'task-title',
      projectId: 'project-title',
      directoryId: 'directory-title',
      workDir: '/workspace/billiard',
      title: '旧任务标题',
      lifecycle: 'active',
      kind: 'main',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      worktreeState: 'not_requested',
      actions: ['rename', 'archive'],
    }
    useProductTaskStore.setState({
      index: {
        schemaVersion: 2,
        projects: [],
        directories: [],
        tasks: [task],
        total: 1,
        capabilities: { createTask: true },
      },
    })
    useTabStore.setState({
      tabs: [
        {
          sessionId: '__product_task__task-title',
          title: task.title,
          type: 'product-task',
          taskId: task.id,
        },
        {
          sessionId: '__product_task__task-other',
          title: '另一个任务标题',
          type: 'product-task',
          taskId: 'task-other',
        },
      ],
      activeTabId: '__product_task__task-title',
    })

    useProductTaskRuntimeStore.getState().handleEvent(task.id, {
      type: 'title_updated',
      title: '自动整理开球训练',
    })

    expect(useProductTaskStore.getState().index.tasks[0]?.title).toBe('自动整理开球训练')
    expect(useTabStore.getState().tabs).toEqual([
      expect.objectContaining({ type: 'product-task', title: '自动整理开球训练' }),
      expect.objectContaining({ taskId: 'task-other', title: '另一个任务标题' }),
    ])
  })

  it('returns a terminally failed task to an actionable idle state', () => {
    const store = useProductTaskRuntimeStore.getState()
    store.handleEvent('task-terminal-error', {
      type: 'activity',
      id: `activity_${'f'.repeat(32)}`,
      kind: 'workspace',
      phase: 'running',
      summary: '正在整理工作内容',
    })
    store.handleEvent('task-terminal-error', {
      type: 'approval_required',
      requestId: 'approval-terminal',
      kind: 'action',
    })
    store.handleEvent('task-terminal-error', {
      type: 'error',
      code: 'task_failed',
      retryable: false,
    })

    expect(useProductTaskRuntimeStore.getState().tasks['task-terminal-error']).toEqual(
      expect.objectContaining({
        runState: 'idle',
        activeActivity: null,
        pendingApproval: null,
        approvalResponsePending: false,
        error: { code: 'task_failed', retryable: false },
      }),
    )
  })

  it('keeps a retryable run failure terminal and recoverable after durable replay', () => {
    const store = useProductTaskRuntimeStore.getState()
    store.handleEvent('task-network-failure', {
      type: 'run_terminal',
      id: `turn_${'e'.repeat(32)}`,
      state: 'recovery_required',
      failure: { code: 'task_network_unavailable', retryable: true },
      replayed: true,
      event_sequence: 7,
    })

    expect(useProductTaskRuntimeStore.getState().tasks['task-network-failure']).toEqual(
      expect.objectContaining({
        runState: 'idle',
        recoveryRequired: true,
        error: { code: 'task_network_unavailable', retryable: true },
      }),
    )
  })

  it('does not collapse a later attachment-only message into a same-text history snapshot', async () => {
    const pendingThread = deferred<unknown>()
    const firstAttachment = {
      type: 'image' as const,
      name: 'earlier.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
    }
    const laterAttachment = {
      type: 'image' as const,
      name: 'later.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,d29ybGQ=',
    }
    apiMocks.getThread
      .mockResolvedValueOnce({ taskId: 'task-attachment-signature', entries: [] })
      .mockReturnValueOnce(pendingThread.promise)
    wireTaskSocket()

    await useProductTaskRuntimeStore.getState().connectTask('task-attachment-signature')
    const refreshing = useProductTaskRuntimeStore.getState().refreshThread('task-attachment-signature')
    useProductTaskRuntimeStore.getState().sendMessage(
      'task-attachment-signature',
      '同一说明',
      [laterAttachment],
    )
    pendingThread.resolve({
      taskId: 'task-attachment-signature',
      entries: [{
        ...threadEntry('thread-earlier-attachment', 'user_text', '同一说明'),
        attachments: [{
          type: 'image',
          name: firstAttachment.name,
          mimeType: firstAttachment.mimeType,
        }],
      }],
    })
    await refreshing

    const entries = useProductTaskRuntimeStore.getState().tasks['task-attachment-signature']?.entries
    expect(entries).toEqual([
      {
        ...threadEntry('thread-earlier-attachment', 'user_text', '同一说明'),
        attachments: [{
          type: 'image',
          name: 'earlier.png',
          mimeType: 'image/png',
        }],
      },
    ])
    expect(JSON.stringify(entries)).not.toContain('data:image')
  })
})
