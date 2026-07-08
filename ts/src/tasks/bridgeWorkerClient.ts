import { randomUUID } from 'node:crypto'
import type { FetchLike } from '../proxy/ProxyModel'
import type { BridgeRemoteCredentialRecord } from './bridgeRemoteState'
import { BridgeRetryableUploadError, BridgeSerialBatchUploader, BridgeWorkerStateUploader } from './bridgeWorkerUploaders'

export type BridgeWorkerSessionState = 'idle' | 'running' | 'requires_action'
export type BridgeWorkerDeliveryStatus = 'received' | 'processing' | 'processed'

export interface BridgeWorkerActionDetails {
  tool_name: string
  action_description: string
  tool_use_id?: string
  request_id: string
  input?: Record<string, unknown>
}

export interface BridgeWorkerClientConfig {
  sessionId: string
  credentials: Pick<BridgeRemoteCredentialRecord, 'workerJwt' | 'apiBaseUrl' | 'workerEpoch'>
  heartbeatIntervalMs?: number
  heartbeatJitterFraction?: number
  fetchImpl?: FetchLike
  onEpochMismatch?: () => void
}

export type BridgeWorkerMessage = Record<string, unknown> & { type: string; uuid?: string }

export interface BridgeWorkerRequestLog {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  status?: number
  ok: boolean
}

type RequestResult = { ok: true; status: number; data?: unknown } | { ok: false; status?: number; retryAfterMs?: number; error?: string }
type StreamAccumulatorState = {
  byMessage: Map<string, string[][]>
  scopeToMessage: Map<string, string>
}
type TextDeltaStreamEvent = BridgeWorkerMessage & {
  type: 'stream_event'
  session_id: string
  parent_tool_use_id: string | null
  event: {
    type: 'content_block_delta'
    index: number
    delta: { type: 'text_delta'; text: string }
  }
}
type MessageStartStreamEvent = BridgeWorkerMessage & {
  type: 'stream_event'
  session_id: string
  parent_tool_use_id: string | null
  event: {
    type: 'message_start'
    message: { id: string }
  }
}
type AssistantMessage = BridgeWorkerMessage & {
  type: 'assistant'
  session_id: string
  parent_tool_use_id: string | null
  message: { id: string }
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000
const STREAM_EVENT_FLUSH_INTERVAL_MS = 100

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('bridge worker apiBaseUrl is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'))) {
    throw new Error('bridge worker apiBaseUrl must use HTTPS or localhost HTTP')
  }
  return trimmed
}

function normalizeSessionId(value: string): string {
  const raw = value.trim()
  const sessionId = raw.startsWith('bridge:') ? raw.slice('bridge:'.length) : raw
  if (!sessionId) throw new Error('sessionId is required')
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(sessionId)) throw new Error('sessionId contains unsupported characters')
  return sessionId
}

export function buildBridgeWorkerSessionUrl(apiBaseUrl: string, sessionId: string): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/v1/code/sessions/${encodeURIComponent(normalizeSessionId(sessionId))}`
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
}

function asClientEvent(message: BridgeWorkerMessage): { payload: BridgeWorkerMessage } {
  return {
    payload: {
      ...message,
      uuid: typeof message.uuid === 'string' && message.uuid ? message.uuid : randomUUID(),
    },
  }
}

function createStreamAccumulator(): StreamAccumulatorState {
  return { byMessage: new Map(), scopeToMessage: new Map() }
}

function scopeKey(message: { session_id: string; parent_tool_use_id: string | null }): string {
  return `${message.session_id}:${message.parent_tool_use_id ?? ''}`
}

function isMessageStart(value: BridgeWorkerMessage): value is MessageStartStreamEvent {
  const event = value.event as Record<string, unknown> | undefined
  const message = event?.message as Record<string, unknown> | undefined
  return value.type === 'stream_event' &&
    event?.type === 'message_start' &&
    typeof message?.id === 'string' &&
    typeof value.session_id === 'string'
}

function isTextDelta(value: BridgeWorkerMessage): value is TextDeltaStreamEvent {
  const event = value.event as Record<string, unknown> | undefined
  const delta = event?.delta as Record<string, unknown> | undefined
  return value.type === 'stream_event' &&
    event?.type === 'content_block_delta' &&
    typeof event.index === 'number' &&
    delta?.type === 'text_delta' &&
    typeof delta.text === 'string' &&
    typeof value.session_id === 'string'
}

function isAssistantMessage(value: BridgeWorkerMessage): value is AssistantMessage {
  const message = value.message as Record<string, unknown> | undefined
  return value.type === 'assistant' &&
    typeof value.session_id === 'string' &&
    typeof message?.id === 'string'
}

function accumulateStreamEvents(buffer: BridgeWorkerMessage[], state: StreamAccumulatorState): BridgeWorkerMessage[] {
  const out: BridgeWorkerMessage[] = []
  const touched = new Map<string[], TextDeltaStreamEvent>()
  for (const message of buffer) {
    if (isMessageStart(message)) {
      const id = message.event.message.id
      const previousId = state.scopeToMessage.get(scopeKey(message))
      if (previousId) state.byMessage.delete(previousId)
      state.scopeToMessage.set(scopeKey(message), id)
      state.byMessage.set(id, [])
      out.push(message)
      continue
    }
    if (!isTextDelta(message)) {
      out.push(message)
      continue
    }
    const messageId = state.scopeToMessage.get(scopeKey(message))
    const blocks = messageId ? state.byMessage.get(messageId) : undefined
    if (!blocks) {
      out.push(message)
      continue
    }
    const chunks = (blocks[message.event.index] ??= [])
    chunks.push(message.event.delta.text)
    const existing = touched.get(chunks)
    if (existing) {
      existing.event.delta.text = chunks.join('')
      continue
    }
    const snapshot: TextDeltaStreamEvent = {
      ...message,
      event: {
        type: 'content_block_delta',
        index: message.event.index,
        delta: { type: 'text_delta', text: chunks.join('') },
      },
    }
    touched.set(chunks, snapshot)
    out.push(snapshot)
  }
  return out
}

function clearStreamAccumulatorForMessage(state: StreamAccumulatorState, message: AssistantMessage): void {
  state.byMessage.delete(message.message.id)
  const scope = scopeKey(message)
  if (state.scopeToMessage.get(scope) === message.message.id) state.scopeToMessage.delete(scope)
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number.parseInt(raw, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export class BridgeWorkerClient {
  private readonly sessionId: string
  private readonly sessionUrl: string
  private readonly token: string
  private readonly workerEpoch: number
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatJitterFraction: number
  private readonly fetchImpl: FetchLike
  private readonly onEpochMismatch?: () => void
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatInFlight = false
  private closed = false
  private currentState: BridgeWorkerSessionState | null = null
  private streamEventBuffer: BridgeWorkerMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null
  private streamTextAccumulator = createStreamAccumulator()
  readonly requests: BridgeWorkerRequestLog[] = []

  private readonly stateUploader = new BridgeWorkerStateUploader({
    send: body => this.request('PUT', '/worker', { worker_epoch: this.workerEpoch, ...body }, 'PUT worker').then(result => result.ok),
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    jitterMs: 500,
  })

  private readonly eventUploader = new BridgeSerialBatchUploader<{ payload: BridgeWorkerMessage }>({
    maxBatchSize: 100,
    maxBatchBytes: 10 * 1024 * 1024,
    maxQueueSize: 100_000,
    send: async batch => {
      const result = await this.request('POST', '/worker/events', { worker_epoch: this.workerEpoch, events: batch }, 'client events')
      if (!result.ok) throw new BridgeRetryableUploadError('client event POST failed', result.retryAfterMs)
    },
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    jitterMs: 500,
  })

  private readonly internalEventUploader = new BridgeSerialBatchUploader<{ payload: BridgeWorkerMessage; is_compaction?: boolean; agent_id?: string }>({
    maxBatchSize: 100,
    maxBatchBytes: 10 * 1024 * 1024,
    maxQueueSize: 200,
    send: async batch => {
      const result = await this.request('POST', '/worker/internal-events', { worker_epoch: this.workerEpoch, events: batch }, 'internal events')
      if (!result.ok) throw new BridgeRetryableUploadError('internal event POST failed', result.retryAfterMs)
    },
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    jitterMs: 500,
  })

  private readonly deliveryUploader = new BridgeSerialBatchUploader<{ eventId: string; status: BridgeWorkerDeliveryStatus }>({
    maxBatchSize: 64,
    maxQueueSize: 64,
    send: async batch => {
      const result = await this.request('POST', '/worker/events/delivery', {
        worker_epoch: this.workerEpoch,
        updates: batch.map(item => ({ event_id: item.eventId, status: item.status })),
      }, 'delivery batch')
      if (!result.ok) throw new BridgeRetryableUploadError('delivery POST failed', result.retryAfterMs)
    },
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    jitterMs: 500,
  })

  constructor(config: BridgeWorkerClientConfig) {
    this.sessionId = normalizeSessionId(config.sessionId)
    this.sessionUrl = buildBridgeWorkerSessionUrl(config.credentials.apiBaseUrl, this.sessionId)
    this.token = config.credentials.workerJwt
    this.workerEpoch = config.credentials.workerEpoch
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatJitterFraction = config.heartbeatJitterFraction ?? 0
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.onEpochMismatch = config.onEpochMismatch
    if (!this.token.trim()) throw new Error('workerJwt is required')
    if (!Number.isSafeInteger(this.workerEpoch) || this.workerEpoch < 0) throw new Error('workerEpoch must be a non-negative safe integer')
  }

  async initialize(): Promise<RequestResult> {
    const result = await this.request('PUT', '/worker', {
      worker_status: 'idle',
      worker_epoch: this.workerEpoch,
      external_metadata: {
        pending_action: null,
        task_summary: null,
      },
    }, 'PUT worker init')
    if (result.ok) {
      this.currentState = 'idle'
      this.startHeartbeat()
    }
    return result
  }

  reportState(state: BridgeWorkerSessionState, details?: BridgeWorkerActionDetails): void {
    if (state === this.currentState && !details) return
    this.currentState = state
    this.stateUploader.enqueue({
      worker_status: state,
      requires_action_details: details
        ? {
            tool_name: details.tool_name,
            action_description: details.action_description,
            request_id: details.request_id,
          }
        : null,
      external_metadata: state === 'requires_action' && details ? { pending_action: details } : { pending_action: null },
    })
  }

  reportMetadata(metadata: Record<string, unknown>): void {
    this.stateUploader.enqueue({ external_metadata: metadata })
  }

  async writeEvent(message: BridgeWorkerMessage): Promise<void> {
    if (message.type === 'stream_event') {
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(() => void this.flushStreamEventBuffer(), STREAM_EVENT_FLUSH_INTERVAL_MS)
      }
      return
    }
    await this.flushStreamEventBuffer()
    if (isAssistantMessage(message)) clearStreamAccumulatorForMessage(this.streamTextAccumulator, message)
    await this.eventUploader.enqueue(asClientEvent(message))
  }

  async writeInternalEvent(eventType: string, payload: Record<string, unknown>, opts: { isCompaction?: boolean; agentId?: string } = {}): Promise<void> {
    await this.internalEventUploader.enqueue({
      payload: {
        type: eventType,
        ...payload,
        uuid: typeof payload.uuid === 'string' ? payload.uuid : randomUUID(),
      },
      ...(opts.isCompaction ? { is_compaction: true } : {}),
      ...(opts.agentId ? { agent_id: opts.agentId } : {}),
    })
  }

  reportDelivery(eventId: string, status: BridgeWorkerDeliveryStatus): void {
    void this.deliveryUploader.enqueue({ eventId, status })
  }

  async sendHeartbeatNow(): Promise<RequestResult> {
    return this.sendHeartbeat()
  }

  async flush(): Promise<void> {
    await this.flushStreamEventBuffer()
    await this.eventUploader.flush()
    await this.internalEventUploader.flush()
    await this.deliveryUploader.flush()
    await this.stateUploader.flush()
  }

  close(): void {
    this.closed = true
    this.stopHeartbeat()
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    this.stateUploader.close()
    this.eventUploader.close()
    this.internalEventUploader.close()
    this.deliveryUploader.close()
  }

  getWorkerEpoch(): number {
    return this.workerEpoch
  }

  get internalEventsPending(): number {
    return this.internalEventUploader.pendingCount
  }

  private async flushStreamEventBuffer(): Promise<void> {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    if (this.streamEventBuffer.length === 0) return
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    await this.eventUploader.enqueue(accumulateStreamEvents(buffered, this.streamTextAccumulator).map(message => asClientEvent(message)))
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const schedule = () => {
      const jitter = this.heartbeatIntervalMs * this.heartbeatJitterFraction * (2 * Math.random() - 1)
      this.heartbeatTimer = setTimeout(tick, Math.max(0, this.heartbeatIntervalMs + jitter))
    }
    const tick = () => {
      void this.sendHeartbeat()
      if (this.heartbeatTimer === null) return
      schedule()
    }
    schedule()
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return
    clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private async sendHeartbeat(): Promise<RequestResult> {
    if (this.heartbeatInFlight) return { ok: false, error: 'heartbeat already in flight' }
    this.heartbeatInFlight = true
    try {
      return await this.request('POST', '/worker/heartbeat', {
        session_id: this.sessionId,
        worker_epoch: this.workerEpoch,
      }, 'heartbeat', { timeoutMs: 5000 })
    } finally {
      this.heartbeatInFlight = false
    }
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, _label: string, opts: { timeoutMs?: number } = {}): Promise<RequestResult> {
    if (this.closed) return { ok: false, error: 'closed' }
    const controller = new AbortController()
    const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null
    try {
      const response = await this.fetchImpl(`${this.sessionUrl}${path}`, {
        method,
        headers: authHeaders(this.token),
        body: method === 'GET' ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const ok = response.status >= 200 && response.status < 300
      this.requests.push({ method, path, status: response.status, ok })
      if (ok) {
        const data = response.headers.get('content-type')?.includes('application/json')
          ? await response.json().catch(() => undefined)
          : undefined
        return { ok: true, status: response.status, data }
      }
      if (response.status === 409) this.onEpochMismatch?.()
      return {
        ok: false,
        status: response.status,
        retryAfterMs: response.status === 429 ? retryAfterMs(response.headers) : undefined,
        error: await response.text().catch(() => ''),
      }
    } catch (err) {
      this.requests.push({ method, path, ok: false })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
