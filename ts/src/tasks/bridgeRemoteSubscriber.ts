import type { BridgePeerRegistry } from './bridgePeerRegistry'
import type { BridgeRemoteState } from './bridgeRemoteState'
import type { FetchLike } from '../proxy/ProxyModel'
import { resolveInboundUserMessage, type BridgeResolvedInboundMessage } from './bridgeInboundMessages'

export interface BridgeRemoteSubscriberConfig {
  baseUrl: string
  token: string
  orgUuid?: string
  reconnectDelayMs?: number
  maxReconnectAttempts?: number
  maxSessionNotFoundRetries?: number
  pingIntervalMs?: number
  WebSocketCtor?: BridgeRemoteWebSocketConstructor
}

export interface BridgeRemoteSubscriberEvents {
  onConnected?: () => void
  onReconnecting?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

export interface BridgeRemoteSubscriberDeps {
  state: BridgeRemoteState
  peers?: BridgePeerRegistry
  inbound?: {
    stateRoot: string
    fetchImpl?: FetchLike
    timeoutMs?: number
    onResolved?: (resolved: BridgeResolvedInboundMessage, payload: Record<string, unknown>) => void | Promise<void>
  }
  onEvent?: (payload: Record<string, unknown>, event: { seq: number }) => void | Promise<void>
}

type WebSocketState = 'connecting' | 'connected' | 'closed'

export type BridgeRemoteWebSocketConstructor = new (url: string, protocols?: string | string[] | WebSocketInitLike) => WebSocketLike

interface WebSocketInitLike {
  headers?: Record<string, string>
  [key: string]: unknown
}

interface WebSocketLike {
  close(): void
  send(data: string): void
  ping?(): void
  addEventListener?(type: 'open' | 'message' | 'error' | 'close' | 'pong', listener: (event: any) => void): void
  on?(type: 'open' | 'message' | 'error' | 'close' | 'pong', listener: (...args: any[]) => void): void
}

const DEFAULT_RECONNECT_DELAY_MS = 2000
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5
const DEFAULT_MAX_SESSION_NOT_FOUND_RETRIES = 3
const DEFAULT_PING_INTERVAL_MS = 30_000
const PERMANENT_CLOSE_CODES = new Set([4003])

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('bridge remote baseUrl is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'))) {
    throw new Error('bridge remote baseUrl must use HTTPS or localhost HTTP')
  }
  return trimmed
}

function websocketBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (normalized.startsWith('https://')) return `wss://${normalized.slice('https://'.length)}`
  if (normalized.startsWith('http://')) return `ws://${normalized.slice('http://'.length)}`
  return normalized
}

function isSessionMessage(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string'
}

function closeCodeFrom(args: any[]): number {
  const first = args[0]
  if (typeof first === 'number') return first
  if (first && typeof first === 'object' && typeof first.code === 'number') return first.code
  return 1006
}

function messageDataFrom(args: any[]): string {
  const first = args[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object' && 'data' in first) {
    const data = (first as { data?: unknown }).data
    return typeof data === 'string' ? data : String(data ?? '')
  }
  if (first instanceof Uint8Array) return new TextDecoder().decode(first)
  return String(first ?? '')
}

export class BridgeRemoteSubscriber {
  private ws: WebSocketLike | null = null
  private state: WebSocketState = 'closed'
  private reconnectAttempts = 0
  private sessionNotFoundRetries = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly sessionId: string,
    private readonly config: BridgeRemoteSubscriberConfig,
    private readonly deps: BridgeRemoteSubscriberDeps,
    private readonly events: BridgeRemoteSubscriberEvents = {},
  ) {}

  connect(): void {
    if (this.state === 'connecting' || this.state === 'connected') return
    this.state = 'connecting'
    void this.deps.peers?.register({
      sessionId: this.sessionId,
      status: 'connecting',
      inboundEnabled: false,
    }).catch(() => undefined)

    let url: string
    try {
      url = `${websocketBaseUrl(this.config.baseUrl)}/v1/sessions/ws/${encodeURIComponent(this.sessionId)}/subscribe`
      if (this.config.orgUuid) url += `?organization_uuid=${encodeURIComponent(this.config.orgUuid)}`
    } catch (err) {
      this.state = 'closed'
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const Ctor = this.config.WebSocketCtor ?? globalThis.WebSocket
    const ws = new Ctor(url, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'anthropic-version': '2023-06-01',
      },
    } as WebSocketInitLike)
    this.ws = ws
    this.attach(ws)
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  close(): void {
    this.state = 'closed'
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    void this.deps.peers?.updateStatus(this.sessionId, 'disconnected').catch(() => undefined)
  }

  reconnect(): void {
    this.reconnectAttempts = 0
    this.sessionNotFoundRetries = 0
    this.close()
    this.state = 'closed'
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 10)
  }

  sendControlResponse(payload: Record<string, unknown>): boolean {
    if (!this.ws || this.state !== 'connected') return false
    this.ws.send(JSON.stringify(payload))
    return true
  }

  private attach(ws: WebSocketLike): void {
    const onOpen = () => this.handleOpen()
    const onMessage = (...args: any[]) => void this.handleMessage(messageDataFrom(args))
    const onError = (err?: unknown) => this.handleError(err)
    const onClose = (...args: any[]) => this.handleClose(closeCodeFrom(args))
    if (ws.addEventListener) {
      ws.addEventListener('open', onOpen)
      ws.addEventListener('message', event => onMessage(event))
      ws.addEventListener('error', event => onError(event))
      ws.addEventListener('close', event => onClose(event))
      return
    }
    ws.on?.('open', onOpen)
    ws.on?.('message', data => onMessage(data))
    ws.on?.('error', error => onError(error))
    ws.on?.('close', (code: number) => onClose(code))
  }

  private handleOpen(): void {
    this.state = 'connected'
    this.reconnectAttempts = 0
    this.sessionNotFoundRetries = 0
    this.startPing()
    void this.deps.peers?.register({
      sessionId: this.sessionId,
      status: 'connected',
      inboundEnabled: true,
    }).catch(() => undefined)
    this.events.onConnected?.()
  }

  private async handleMessage(data: string): Promise<void> {
    try {
      const parsed = JSON.parse(data) as unknown
      if (!isSessionMessage(parsed)) return
      const ingested = await this.deps.state.ingestEvent(this.sessionId, parsed)
      await this.deps.onEvent?.(parsed, { seq: ingested.event.seq })
      if (parsed.type === 'user' && this.deps.inbound) {
        const resolved = await resolveInboundUserMessage(parsed, {
          sessionId: this.sessionId,
          stateRoot: this.deps.inbound.stateRoot,
          baseUrl: this.config.baseUrl,
          token: this.config.token,
          fetchImpl: this.deps.inbound.fetchImpl,
          timeoutMs: this.deps.inbound.timeoutMs,
        })
        if (resolved) {
          await this.deps.state.storeInboundMessage(this.sessionId, resolved, { eventSeq: ingested.event.seq })
          await this.deps.inbound.onResolved?.(resolved, parsed)
        }
      }
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private handleError(err: unknown): void {
    this.events.onError?.(err instanceof Error ? err : new Error('Bridge Remote WebSocket error'))
  }

  private handleClose(closeCode: number): void {
    this.stopPing()
    if (this.state === 'closed') return
    const previousState = this.state
    this.ws = null
    this.state = 'closed'

    if (PERMANENT_CLOSE_CODES.has(closeCode)) {
      void this.deps.peers?.updateStatus(this.sessionId, 'error', `permanent close ${closeCode}`).catch(() => undefined)
      this.events.onDisconnected?.()
      return
    }

    if (closeCode === 4001) {
      this.sessionNotFoundRetries++
      if (this.sessionNotFoundRetries > (this.config.maxSessionNotFoundRetries ?? DEFAULT_MAX_SESSION_NOT_FOUND_RETRIES)) {
        void this.deps.peers?.updateStatus(this.sessionId, 'disconnected', `session not found ${closeCode}`).catch(() => undefined)
        this.events.onDisconnected?.()
        return
      }
      this.scheduleReconnect((this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS) * this.sessionNotFoundRetries)
      return
    }

    if (previousState === 'connected' && this.reconnectAttempts < (this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS)) {
      this.reconnectAttempts++
      this.scheduleReconnect(this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS)
      return
    }

    void this.deps.peers?.updateStatus(this.sessionId, 'disconnected', `closed ${closeCode}`).catch(() => undefined)
    this.events.onDisconnected?.()
  }

  private scheduleReconnect(delayMs: number): void {
    void this.deps.peers?.updateStatus(this.sessionId, 'connecting').catch(() => undefined)
    this.events.onReconnecting?.()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delayMs)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.ping?.()
      } catch {
        // Close/error handlers own connection recovery.
      }
    }, this.config.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (!this.pingTimer) return
    clearInterval(this.pingTimer)
    this.pingTimer = null
  }
}
