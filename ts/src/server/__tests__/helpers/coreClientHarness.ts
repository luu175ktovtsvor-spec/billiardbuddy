import { handleWebSocket, type WebSocketData } from '../../ws/handler.js'

type HandlerSocket = Parameters<typeof handleWebSocket.open>[0]
type MessageListener = ((event: { data: string }) => void) | null
type EventListener = ((event: Event) => void) | null

/**
 * Test-only Core client transport. It exercises the same handler and spawned
 * SDK connection as the former `/ws/:sessionId` browser route, without
 * retaining that route as a public server surface.
 */
class DirectCoreClient {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = DirectCoreClient.CONNECTING
  onopen: EventListener = null
  onerror: EventListener = null
  onclose: EventListener = null

  private messageListener: MessageListener = null
  private readonly queuedMessages: string[] = []
  private readonly queuedClientPayloads: string[] = []
  private opened = false
  private closed = false
  private readonly socket: HandlerSocket

  constructor(url: string) {
    this.url = url
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 2 || segments[0] !== 'ws' || !segments[1]) {
      throw new TypeError('DirectCoreClient only supports a legacy Core session URL')
    }

    const sessionId = decodeURIComponent(segments[1])
    const serverPort = Number.parseInt(
      parsed.port || (parsed.protocol === 'wss:' ? '443' : '80'),
      10,
    )
    this.socket = {
      data: {
        sessionId,
        connectedAt: Date.now(),
        channel: 'client',
        sdkToken: null,
        serverPort,
        serverHost: parsed.hostname,
      } satisfies WebSocketData,
      send: (payload: string) => {
        this.receive(payload)
      },
      close: (code = 1000, reason = '') => {
        this.finish(code, reason, false)
      },
    } as HandlerSocket

    queueMicrotask(() => this.open())
  }

  get onmessage(): MessageListener {
    return this.messageListener
  }

  set onmessage(listener: MessageListener) {
    this.messageListener = listener
    this.flushMessages()
  }

  send(payload: string): void {
    if (this.closed) return
    if (!this.opened) {
      this.queuedClientPayloads.push(payload)
      return
    }
    queueMicrotask(() => {
      if (!this.closed) handleWebSocket.message(this.socket, payload)
    })
  }

  close(code = 1000, reason = ''): void {
    this.finish(code, reason, true)
  }

  private open(): void {
    if (this.closed) return
    try {
      this.opened = true
      this.readyState = DirectCoreClient.OPEN
      handleWebSocket.open(this.socket)
      this.onopen?.(new Event('open'))
      for (const payload of this.queuedClientPayloads.splice(0)) {
        this.send(payload)
      }
    } catch {
      this.emitError()
    }
  }

  private receive(payload: string): void {
    if (this.closed) return
    this.queuedMessages.push(payload)
    this.flushMessages()
  }

  private flushMessages(): void {
    if (!this.messageListener || this.closed) return
    for (const payload of this.queuedMessages.splice(0)) {
      queueMicrotask(() => {
        if (!this.closed) this.messageListener?.({ data: payload })
      })
    }
  }

  private finish(code: number, reason: string, notifyHandler: boolean): void {
    if (this.closed) return
    this.closed = true
    this.readyState = DirectCoreClient.CLOSED
    if (notifyHandler && this.opened) {
      handleWebSocket.close(this.socket, code, reason)
    }
    queueMicrotask(() => this.onclose?.(new Event('close')))
  }

  private emitError(): void {
    if (this.closed) return
    this.readyState = DirectCoreClient.CLOSED
    this.closed = true
    queueMicrotask(() => this.onerror?.(new Event('error')))
  }
}

/**
 * Kept constructable so legacy integration cases can shadow `WebSocket` in
 * their describe block without changing their individual scenario code.
 */
export function createDirectCoreClient(url: string): WebSocket {
  return new DirectCoreClient(url) as unknown as WebSocket
}
