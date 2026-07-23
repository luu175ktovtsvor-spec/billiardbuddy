import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductTaskSocketLifecycleEvent } from '../api/taskSocket'

const apiMocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  list: vi.fn(),
  currentLineage: vi.fn(),
  submitRun: vi.fn(),
}))
const socketMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
}))

vi.mock('../api/tasks', () => ({
  productTasksApi: {
    getThread: apiMocks.getThread,
    list: apiMocks.list,
  },
  productConversationLineageApi: {
    current: apiMocks.currentLineage,
  },
  productTaskRunSubmitApi: {
    submit: apiMocks.submitRun,
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
    apiMocks.list.mockReset()
    apiMocks.currentLineage.mockReset()
    apiMocks.submitRun.mockReset()
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

    store.handleEvent('task-computer-use', {
      type: 'approval_required',
      requestId: 'computer-use-1',
      kind: 'computer_use',
      computerUse: {
        apps: [{ name: '记分牌', tier: 'click', alreadyAuthorized: false }],
        capabilities: ['clipboard_read'],
      },
    })

    expect(store.respondToComputerUseApproval('task-computer-use', true)).toBe(true)
    expect(socketMocks.send).toHaveBeenCalledWith('task-computer-use', {
      type: 'computer_use_permission_response',
      requestId: 'computer-use-1',
      allowed: true,
    })
    expect(store.respondToComputerUseApproval('task-computer-use', false)).toBe(false)
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
