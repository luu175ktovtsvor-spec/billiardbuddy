import type { FetchLike } from '../proxy/ProxyModel'
import type { BridgeRemoteState } from './bridgeRemoteState'
import type { BridgeWorkerClient } from './bridgeWorkerClient'

export type BridgeWorkerStreamState = 'idle' | 'connected' | 'reconnecting' | 'closing' | 'closed'

export interface BridgeWorkerStreamEvent {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
}

export interface BridgeWorkerStreamConfig {
  sessionId: string
  apiBaseUrl: string
  workerJwt: string
  initialSequenceNum?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectGiveUpMs?: number
  livenessTimeoutMs?: number
  fetchImpl?: FetchLike
}

export interface BridgeWorkerStreamDeps {
  state: BridgeRemoteState
  worker?: Pick<BridgeWorkerClient, 'reportDelivery'>
}

type SseFrame = {
  event?: string
  id?: string
  data?: string
  comment?: boolean
}

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1000
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000
const DEFAULT_RECONNECT_GIVE_UP_MS = 600_000
const DEFAULT_LIVENESS_TIMEOUT_MS = 45_000
const PERMANENT_HTTP_CODES = new Set([401, 403, 404])

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('bridge worker stream apiBaseUrl is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'))) {
    throw new Error('bridge worker stream apiBaseUrl must use HTTPS or localhost HTTP')
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

export function parseBridgeSseFrames(buffer: string): { frames: SseFrame[]; remaining: string } {
  const frames: SseFrame[] = []
  let pos = 0
  let idx: number
  while ((idx = buffer.indexOf('\n\n', pos)) !== -1) {
    const rawFrame = buffer.slice(pos, idx)
    pos = idx + 2
    if (!rawFrame.trim()) continue
    const frame: SseFrame = {}
    let comment = false
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) {
        comment = true
        continue
      }
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const field = line.slice(0, colonIdx)
      const value = line[colonIdx + 1] === ' ' ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1)
      if (field === 'event') frame.event = value
      else if (field === 'id') frame.id = value
      else if (field === 'data') frame.data = frame.data ? `${frame.data}\n${value}` : value
    }
    if (frame.data || comment) frames.push({ ...frame, ...(comment ? { comment: true } : {}) })
  }
  return { frames, remaining: buffer.slice(pos) }
}

export function buildBridgeWorkerStreamUrl(apiBaseUrl: string, sessionId: string): string {
  return `${normalizeBaseUrl(apiBaseUrl)}/v1/code/sessions/${encodeURIComponent(normalizeSessionId(sessionId))}/worker/events/stream`
}

export class BridgeWorkerStream {
  private readonly sessionId: string
  private readonly streamUrl: string
  private readonly workerJwt: string
  private readonly fetchImpl: FetchLike
  private readonly reconnectBaseDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly reconnectGiveUpMs: number
  private readonly livenessTimeoutMs: number
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private reconnectStartTime: number | null = null
  private livenessTimer: ReturnType<typeof setTimeout> | null = null
  private seenSequenceNums = new Set<number>()
  private lastSequenceNum = 0
  private state: BridgeWorkerStreamState = 'idle'

  constructor(
    config: BridgeWorkerStreamConfig,
    private readonly deps: BridgeWorkerStreamDeps,
    private readonly events: {
      onClose?: (code?: number) => void
      onEvent?: (event: BridgeWorkerStreamEvent) => void
      onError?: (error: Error) => void
    } = {},
  ) {
    this.sessionId = normalizeSessionId(config.sessionId)
    this.streamUrl = buildBridgeWorkerStreamUrl(config.apiBaseUrl, this.sessionId)
    this.workerJwt = config.workerJwt
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.reconnectBaseDelayMs = config.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS
    this.reconnectMaxDelayMs = config.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
    this.reconnectGiveUpMs = config.reconnectGiveUpMs ?? DEFAULT_RECONNECT_GIVE_UP_MS
    this.livenessTimeoutMs = config.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS
    this.lastSequenceNum = config.initialSequenceNum ?? 0
    if (!this.workerJwt.trim()) throw new Error('workerJwt is required')
  }

  connect(): void {
    if (this.state !== 'idle' && this.state !== 'reconnecting') return
    void this.open()
  }

  close(code?: number): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearLivenessTimer()
    this.state = 'closing'
    this.abortController?.abort()
    this.abortController = null
    this.state = 'closed'
    this.events.onClose?.(code)
  }

  getLastSequenceNum(): number {
    return this.lastSequenceNum
  }

  getState(): BridgeWorkerStreamState {
    return this.state
  }

  private async open(): Promise<void> {
    this.state = 'reconnecting'
    const url = new URL(this.streamUrl)
    if (this.lastSequenceNum > 0) url.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.workerJwt}`,
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      ...(this.lastSequenceNum > 0 ? { 'Last-Event-ID': String(this.lastSequenceNum) } : {}),
    }
    this.abortController = new AbortController()
    try {
      const response = await this.fetchImpl(url, { headers, signal: this.abortController.signal })
      if (!response.ok) {
        if (PERMANENT_HTTP_CODES.has(response.status)) {
          this.state = 'closed'
          this.events.onClose?.(response.status)
          return
        }
        this.handleConnectionError()
        return
      }
      if (!response.body) {
        this.handleConnectionError()
        return
      }
      this.state = 'connected'
      this.reconnectAttempts = 0
      this.reconnectStartTime = null
      this.resetLivenessTimer()
      await this.readStream(response.body)
    } catch (err) {
      if (this.abortController?.signal.aborted) return
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
      this.handleConnectionError()
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { frames, remaining } = parseBridgeSseFrames(buffer)
        buffer = remaining
        for (const frame of frames) {
          this.resetLivenessTimer()
          this.trackSequence(frame.id)
          if (frame.event && frame.data) await this.handleSseFrame(frame.event, frame.data)
        }
      }
    } catch (err) {
      if (!this.abortController?.signal.aborted) this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
    } finally {
      reader.releaseLock()
    }
    if (this.state !== 'closing' && this.state !== 'closed') this.handleConnectionError()
  }

  private trackSequence(rawId: string | undefined): void {
    if (!rawId) return
    const seq = Number.parseInt(rawId, 10)
    if (!Number.isFinite(seq)) return
    if (!this.seenSequenceNums.has(seq)) {
      this.seenSequenceNums.add(seq)
      if (this.seenSequenceNums.size > 1000) {
        const threshold = this.lastSequenceNum - 200
        for (const item of this.seenSequenceNums) {
          if (item < threshold) this.seenSequenceNums.delete(item)
        }
      }
    }
    if (seq > this.lastSequenceNum) this.lastSequenceNum = seq
  }

  private async handleSseFrame(eventType: string, data: string): Promise<void> {
    if (eventType !== 'client_event') return
    let event: BridgeWorkerStreamEvent
    try {
      event = JSON.parse(data) as BridgeWorkerStreamEvent
    } catch {
      return
    }
    if (!event || typeof event !== 'object' || !event.payload || typeof event.payload.type !== 'string') return
    this.deps.worker?.reportDelivery(event.event_id, 'received')
    await this.deps.state.ingestEvent(this.sessionId, event.payload)
    this.deps.worker?.reportDelivery(event.event_id, 'processed')
    this.events.onEvent?.(event)
  }

  private handleConnectionError(): void {
    this.clearLivenessTimer()
    if (this.state === 'closing' || this.state === 'closed') return
    this.abortController?.abort()
    this.abortController = null
    const now = Date.now()
    if (!this.reconnectStartTime) this.reconnectStartTime = now
    const elapsed = now - this.reconnectStartTime
    if (elapsed >= this.reconnectGiveUpMs) {
      this.state = 'closed'
      this.events.onClose?.()
      return
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.state = 'reconnecting'
    this.reconnectAttempts++
    const baseDelay = Math.min(this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1), this.reconnectMaxDelayMs)
    const delay = Math.max(0, baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private resetLivenessTimer(): void {
    this.clearLivenessTimer()
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null
      this.abortController?.abort()
      this.handleConnectionError()
    }, this.livenessTimeoutMs)
  }

  private clearLivenessTimer(): void {
    if (!this.livenessTimer) return
    clearTimeout(this.livenessTimer)
    this.livenessTimer = null
  }
}
