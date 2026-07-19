import { afterEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getThread: vi.fn(),
}))
const socketMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
}))

vi.mock('../api/tasks', () => ({
  productTasksApi: {
    getThread: apiMocks.getThread,
  },
}))

vi.mock('../api/taskSocket', () => ({
  productTaskSocket: socketMocks,
}))

import {
  canSendProductTaskText,
  useProductTaskRuntimeStore,
} from './productTaskRuntimeStore'

let eventHandler: ((event: any) => void) | null = null

describe('product task runtime store', () => {
  afterEach(() => {
    useProductTaskRuntimeStore.setState({ tasks: {} })
    apiMocks.getThread.mockReset()
    socketMocks.connect.mockReset()
    socketMocks.disconnect.mockReset()
    socketMocks.send.mockReset()
    eventHandler = null
  })

  it('loads a product thread and applies only task-safe live events', async () => {
    apiMocks.getThread.mockResolvedValue({
      taskId: 'task-1',
      entries: [{
        id: 'thread-history-1',
        type: 'assistant_text',
        text: '历史回复',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    })
    socketMocks.connect.mockImplementation((_taskId: string, handler: (event: any) => void) => {
      eventHandler = handler
      return () => {}
    })

    await useProductTaskRuntimeStore.getState().connectTask('task-1')
    eventHandler?.({ type: 'connected' })
    eventHandler?.({ type: 'assistant_text_start' })
    eventHandler?.({ type: 'assistant_text_delta', text: '实时回复' })
    eventHandler?.({ type: 'activity', kind: 'workspace', phase: 'completed' })

    const runtime = useProductTaskRuntimeStore.getState().tasks['task-1']!
    expect(runtime.connectionState).toBe('connected')
    expect(runtime.historyStatus).toBe('ready')
    expect(runtime.entries.map((entry) => entry.type)).toEqual([
      'assistant_text',
      'assistant_text',
      'activity',
    ])
    expect(runtime.entries[1]).toEqual(expect.objectContaining({ text: '实时回复' }))
    expect(runtime.entries[2]).toEqual(expect.objectContaining({ kind: 'workspace', phase: 'completed' }))
  })

  it('queues real task text and never treats an empty composer as a send', () => {
    const store = useProductTaskRuntimeStore.getState()

    expect(store.sendText('task-2', '   ')).toBe(false)
    expect(socketMocks.send).not.toHaveBeenCalled()

    expect(store.sendText('task-2', '  /skill ball-hall-daily-review 整理今天订单  ')).toBe(true)
    expect(socketMocks.send).toHaveBeenCalledWith('task-2', {
      type: 'user_message',
      content: '/skill ball-hall-daily-review 整理今天订单',
    })
    expect(useProductTaskRuntimeStore.getState().tasks['task-2']?.entries).toEqual([
      expect.objectContaining({ type: 'user_text', text: '/skill ball-hall-daily-review 整理今天订单' }),
    ])
  })

  it('matches the product text boundary before creating optimistic task state', () => {
    expect(canSendProductTaskText('普通任务内容')).toBe(true)
    expect(canSendProductTaskText('  /Agent 研究下周活动方案')).toBe(true)
    expect(canSendProductTaskText('x'.repeat(32_001))).toBe(false)
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
})
