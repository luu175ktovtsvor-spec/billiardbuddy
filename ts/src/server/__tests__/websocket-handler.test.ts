import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { randomUUID } from 'node:crypto'
import {
  __resetProductTaskWebSocketStateForTests,
  productTaskWebSocket,
  type ProductTaskWebSocketData,
} from '../product/taskWebSocket.js'
import { productTaskService } from '../product/taskService.js'
import { productTaskWorkerRuntimeEvents } from '../product/taskWorkerRuntimeEvents.js'

type TestSocket = ServerWebSocket<ProductTaskWebSocketData> & {
  sent: string[]
  closed: Array<[number, string]>
}

function socket(taskId = `task-${randomUUID()}`): TestSocket {
  const sent: string[] = []
  const closed: Array<[number, string]> = []
  return {
    data: {
      sessionId: `session-${randomUUID()}`,
      productTaskId: taskId,
      connectedAt: Date.now(),
      channel: 'product',
    },
    sent,
    closed,
    send(payload: string) { sent.push(payload); return 0 },
    close(code: number, reason: string) { closed.push([code, reason]) },
  } as unknown as TestSocket
}

function messages(ws: TestSocket): any[] {
  return ws.sent.map(payload => JSON.parse(payload))
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  mock.restore()
  __resetProductTaskWebSocketStateForTests()
})

describe('ProductTask websocket', () => {
  test('projects only task-scoped worker state and matching live events', async () => {
    const taskId = `task-${randomUUID()}`
    const otherTaskId = `task-${randomUUID()}`
    const ws = socket(taskId)
    spyOn(productTaskService, 'readPendingTaskApproval').mockResolvedValue(null)

    productTaskWebSocket.open(ws)
    productTaskWorkerRuntimeEvents.publish(otherTaskId, { type: 'assistant_text_delta', text: 'other' })
    productTaskWorkerRuntimeEvents.publish(taskId, { type: 'assistant_text_delta', text: 'matching' })

    expect(messages(ws)).toEqual([
      { type: 'connected' },
      { type: 'run_snapshot', state: 'idle', activities: [] },
      { type: 'assistant_text_delta', text: 'matching' },
    ])
  })

  test('reconnect snapshot retains the current safe activity tree and pending approval', async () => {
    const taskId = `task-${randomUUID()}`
    const requestId = `action-${randomUUID()}`
    const activityId = `activity_${'a'.repeat(32)}`
    productTaskWorkerRuntimeEvents.publish(taskId, { type: 'status', state: 'working' })
    productTaskWorkerRuntimeEvents.publish(taskId, {
      type: 'activity',
      id: activityId,
      kind: 'file_read',
      phase: 'started',
      summary: '正在读取工作区内容',
    })
    productTaskWorkerRuntimeEvents.publish(taskId, {
      type: 'approval_required',
      requestId,
      kind: 'action',
      action: { what: '修改文件', scope: '当前工作区', consequence: '文件内容会发生变化' },
    })
    spyOn(productTaskService, 'readPendingTaskApproval').mockResolvedValue({
      type: 'approval_required',
      requestId,
      kind: 'action',
      action: { what: '修改文件', scope: '当前工作区', consequence: '文件内容会发生变化' },
    })
    const ws = socket(taskId)

    productTaskWebSocket.open(ws)
    await settle()

    expect(messages(ws)).toEqual([
      { type: 'connected' },
      {
        type: 'run_snapshot',
        state: 'awaiting_approval',
        activities: [{
          id: activityId,
          kind: 'file_read',
          phase: 'started',
          summary: '正在读取工作区内容',
        }],
      },
      {
        type: 'approval_required',
        requestId,
        kind: 'action',
        action: { what: '修改文件', scope: '当前工作区', consequence: '文件内容会发生变化' },
      },
    ])
  })

  test('replays durable events from a cursor and returns the authoritative cursor', async () => {
    const ws = socket()
    spyOn(productTaskService, 'listTaskEvents').mockResolvedValue({
      events: [{
        type: 'activity',
        task_id: ws.data.productTaskId!,
        run_id: 'run-1',
        dispatch_generation: 1,
        item_id: `activity_${'b'.repeat(32)}`,
        parent_item_id: `activity_${'a'.repeat(32)}`,
        kind: 'file_read',
        phase: 'running',
        summary: '正在读取工作区内容',
        progress: { completed: 1, total: 3 },
        event_sequence: 8,
        created_at: new Date(0).toISOString(),
      }],
      cursor: 8,
      has_more: false,
    } as any)

    productTaskWebSocket.message(ws, JSON.stringify({ type: 'resume', cursor: 7 }))
    await settle()

    expect(productTaskService.listTaskEvents).toHaveBeenCalledWith(ws.data.productTaskId, 7, 200)
    expect(messages(ws)).toEqual([
      {
        type: 'activity',
        id: `activity_${'b'.repeat(32)}`,
        parentId: `activity_${'a'.repeat(32)}`,
        kind: 'file_read',
        phase: 'running',
        summary: '正在读取工作区内容',
        progress: { completed: 1, total: 3 },
        replayed: true,
        event_sequence: 8,
      },
      { type: 'resume_cursor', cursor: 8 },
    ])
  })

  test('routes action approvals and structured question answers only to the pending worker request', async () => {
    const ws = socket()
    const taskId = ws.data.productTaskId!
    const actionRequest = `action-${randomUUID()}`
    productTaskWorkerRuntimeEvents.rememberApproval(taskId, { type: 'approval_required', requestId: actionRequest, kind: 'action' })
    const approve = spyOn(productTaskService, 'respondToTaskApproval').mockResolvedValue(true)
    productTaskWebSocket.message(ws, JSON.stringify({ type: 'permission_response', requestId: actionRequest, allowed: true }))
    await settle()
    expect(approve).toHaveBeenCalledWith(taskId, actionRequest, true)

    const questionRequest = `question-${randomUUID()}`
    productTaskWorkerRuntimeEvents.rememberApproval(taskId, {
      type: 'approval_required',
      requestId: questionRequest,
      kind: 'question',
      questions: [{ header: '范围', question: '选择范围', options: [{ label: '本周', description: '只处理本周' }, { label: '全部', description: '处理全部' }] }],
    })
    const answer = spyOn(productTaskService, 'respondToTaskQuestion').mockResolvedValue(true)
    productTaskWebSocket.message(ws, JSON.stringify({ type: 'ask_user_question_response', requestId: questionRequest, answers: ['本周'] }))
    await settle()
    expect(answer).toHaveBeenCalledWith(taskId, questionRequest, ['本周'])

  })

  test('keeps submit on durable HTTP while preserving stop and ping controls', async () => {
    const ws = socket()
    const stop = spyOn(productTaskService, 'stopActiveTaskRun').mockResolvedValue(true)

    productTaskWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'bypass' }))
    productTaskWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
    productTaskWebSocket.message(ws, JSON.stringify({ type: 'ping' }))
    await settle()

    expect(stop).toHaveBeenCalledWith(ws.data.productTaskId)
    expect(messages(ws)).toEqual([{ type: 'error', code: 'attachment_ingest_unavailable', retryable: false }])
  })

  test('disconnect removes only the presentation subscriber and never stops the worker', () => {
    const ws = socket()
    const stop = spyOn(productTaskService, 'stopActiveTaskRun')
    spyOn(productTaskService, 'readPendingTaskApproval').mockResolvedValue(null)
    productTaskWebSocket.open(ws)
    productTaskWebSocket.close(ws)
    productTaskWorkerRuntimeEvents.publish(ws.data.productTaskId!, { type: 'assistant_text_delta', text: 'late' })
    expect(stop).not.toHaveBeenCalled()
    expect(messages(ws).some(message => message.text === 'late')).toBeFalse()
  })
})
