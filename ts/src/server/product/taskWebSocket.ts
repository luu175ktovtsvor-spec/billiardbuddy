import type { ServerWebSocket } from 'bun'
import { diagnosticsService } from '../services/diagnosticsService.js'
import { parseProductTaskInboundMessage } from './taskInboundPolicy.js'
import { productTaskService } from './taskService.js'
import { productTaskWorkerRuntimeEvents } from './taskWorkerRuntimeEvents.js'

export type ProductTaskWebSocketData = {
  sessionId: string
  productTaskId: string
  connectedAt: number
  channel: 'product'
  handoff: 'awaiting_resume' | 'replaying' | 'live'
  pending_live_events: string[]
}

const activeProductSockets = new Map<string, Set<ServerWebSocket<ProductTaskWebSocketData>>>()
const MAX_PENDING_LIVE_EVENTS = 4_096

export function __resetProductTaskWebSocketStateForTests(): void {
  activeProductSockets.clear()
}

productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
  const encoded = JSON.stringify(event)
  for (const socket of activeProductSockets.get(taskId) ?? []) {
    if (socket.data.handoff === 'live') {
      socket.send(encoded)
      continue
    }
    if (socket.data.pending_live_events.length >= MAX_PENDING_LIVE_EVENTS) {
      socket.close(1013, 'Product task resume backlog exceeded')
      continue
    }
    socket.data.pending_live_events.push(encoded)
  }
})

export const productTaskWebSocket = {
  open(ws: ServerWebSocket<ProductTaskWebSocketData>) {
    const taskId = ws.data.productTaskId
    const sockets = activeProductSockets.get(taskId) ?? new Set<ServerWebSocket<ProductTaskWebSocketData>>()
    sockets.add(ws)
    activeProductSockets.set(taskId, sockets)
    ws.send(JSON.stringify({ type: 'connected' }))
  },

  message(ws: ServerWebSocket<ProductTaskWebSocketData>, rawMessage: string | Buffer) {
    try {
      const parsed = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()) as unknown
      const cursor = productResumeCursor(parsed)
      if (cursor !== null) {
        if (ws.data.handoff !== 'awaiting_resume') return sendProtocolError(ws, 'task_unavailable')
        ws.data.handoff = 'replaying'
        void replayDurableProductEvents(ws, cursor)
        return
      }
      if (isRetiredRawProductMessage(parsed)) {
        sendProtocolError(ws, 'attachment_ingest_unavailable')
        return
      }
      const message = parseProductTaskInboundMessage(parsed)
      if (ws.data.handoff !== 'live') return sendProtocolError(ws, 'task_unavailable')
      void handleProductMessage(ws, message).catch(error => {
        void diagnosticsService.recordEvent({
          type: 'ws_product_message_failed',
          severity: 'error',
          sessionId: ws.data.sessionId,
          summary: error instanceof Error ? error.message : String(error),
          details: error,
        })
        sendProtocolError(ws, 'task_unavailable')
      })
    } catch {
      sendProtocolError(ws, 'task_unavailable')
    }
  },

  close(ws: ServerWebSocket<ProductTaskWebSocketData>) {
    const taskId = ws.data.productTaskId
    const sockets = activeProductSockets.get(taskId)
    sockets?.delete(ws)
    if (sockets?.size === 0) activeProductSockets.delete(taskId)
  },

  drain(_ws: ServerWebSocket<ProductTaskWebSocketData>) {},
}

async function handleProductMessage(
  ws: ServerWebSocket<ProductTaskWebSocketData>,
  message: ReturnType<typeof parseProductTaskInboundMessage>,
): Promise<void> {
  if (!message) return sendProtocolError(ws, 'task_unavailable')
  const taskId = ws.data.productTaskId
  if (message.type === 'permission_response' && productTaskWorkerRuntimeEvents.ownsApproval(taskId, message.requestId)) {
    if (await productTaskService.respondToTaskApproval(taskId, message.requestId, message.allowed)) return
  }
  if (message.type === 'ask_user_question_response' && productTaskWorkerRuntimeEvents.ownsApproval(taskId, message.requestId)) {
    if (await productTaskService.respondToTaskQuestion(taskId, message.requestId, message.answers)) return
  }
  if (message.type === 'stop_generation') {
    await productTaskService.stopActiveTaskRun(taskId)
    return
  }
  if (message.type === 'ping') return
  sendProtocolError(ws, 'task_unavailable')
}

function productResumeCursor(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return record.type === 'resume'
    && Object.keys(record).length === 2
    && Number.isSafeInteger(record.cursor)
    && (record.cursor as number) >= 0
    ? record.cursor as number
    : null
}

function isRetiredRawProductMessage(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).type === 'user_message'
}

function sendProtocolError(
  ws: ServerWebSocket<ProductTaskWebSocketData>,
  code: 'attachment_ingest_unavailable' | 'task_unavailable',
): void {
  ws.send(JSON.stringify({ type: 'error', code, retryable: false }))
}

async function replayDurableProductEvents(
  ws: ServerWebSocket<ProductTaskWebSocketData>,
  afterEventSequence: number,
): Promise<void> {
  try {
    let cursor = afterEventSequence
    let hasMore = true
    while (hasMore) {
      const page = await productTaskService.listTaskEvents(ws.data.productTaskId, cursor, 200)
      for (const event of page.events) {
        if (event.type === 'user_text') ws.send(JSON.stringify({ type: 'user_text', ...(event.item_id ? { id: event.item_id } : {}), text: event.text, replayed: true, event_sequence: event.event_sequence, ...(event.attachments?.length ? { attachments: event.attachments } : {}), ...(event.reference_entry_ids?.length ? { referenceEntryIds: event.reference_entry_ids } : {}) }))
        else if (event.type === 'assistant_text') ws.send(JSON.stringify({ type: 'assistant_text', id: event.item_id, text: event.text, replayed: true, event_sequence: event.event_sequence }))
        else if (event.type === 'activity') ws.send(JSON.stringify({ type: 'activity', id: event.item_id, ...(event.parent_item_id ? { parentId: event.parent_item_id } : {}), kind: event.kind, phase: event.phase, summary: event.summary, ...(event.progress ? { progress: event.progress } : {}), replayed: true, event_sequence: event.event_sequence }))
        else if (event.type === 'queue_updated') ws.send(JSON.stringify({ type: 'queue_updated', item: { id: event.queue_item_id, text: event.text, state: event.phase, createdAt: event.created_at, attachmentCount: event.attachment_count, ...(event.target_run_id ? { targetRunId: event.target_run_id } : {}) }, replayed: true, event_sequence: event.event_sequence }))
        else if (event.type === 'context_compaction') ws.send(JSON.stringify({ type: 'context_compaction', item: { id: event.item_id, phase: event.phase, source: event.source, generation: event.generation }, replayed: true, event_sequence: event.event_sequence }))
        else if (event.type === 'run_terminal') ws.send(JSON.stringify({ type: 'run_terminal', id: event.item_id, state: event.state, ...(event.failure ? { failure: event.failure } : {}), replayed: true, event_sequence: event.event_sequence }))
      }
      cursor = page.cursor
      hasMore = page.has_more === true
    }
    if (ws.data.handoff !== 'replaying') return
    ws.send(JSON.stringify({ type: 'run_snapshot', ...productTaskWorkerRuntimeEvents.snapshot(ws.data.productTaskId) }))
    await replayPendingWorkerApproval(ws)
    ws.send(JSON.stringify({ type: 'resume_cursor', cursor }))
    ws.data.handoff = 'live'
    const pending = ws.data.pending_live_events.splice(0)
    for (const event of pending) ws.send(event)
  } catch {
    ws.data.pending_live_events.splice(0)
    sendProtocolError(ws, 'task_unavailable')
    ws.close(1011, 'Product task replay failed')
  }
}

async function replayPendingWorkerApproval(ws: ServerWebSocket<ProductTaskWebSocketData>): Promise<void> {
  const approval = await productTaskService.readPendingTaskApproval(ws.data.productTaskId).catch(() => null)
  if (!approval) return
  productTaskWorkerRuntimeEvents.rememberApproval(ws.data.productTaskId, approval)
  ws.send(JSON.stringify(approval))
}
