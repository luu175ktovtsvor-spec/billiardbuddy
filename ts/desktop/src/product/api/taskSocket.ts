import { getBaseUrl } from '../../api/client'
import type { ProductTaskEvent } from '../domain/types'

export type ProductTaskClientMessage =
  | { type: 'user_message'; content: string }
  | { type: 'stop_generation' }
  | { type: 'ping' }

export type ProductTaskEventHandler = (event: ProductTaskEvent) => void

type Connection = {
  ws: WebSocket
  handlers: Set<ProductTaskEventHandler>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  pingInterval: ReturnType<typeof setInterval> | null
  intentionalClose: boolean
  pendingMessages: ProductTaskClientMessage[]
}

const PRODUCT_TASK_EVENT_TYPES = new Set<ProductTaskEvent['type']>([
  'connected',
  'user_text',
  'assistant_text_start',
  'assistant_text_delta',
  'status',
  'activity',
  'approval_required',
  'turn_complete',
  'error',
  'title_updated',
])

function isProductTaskEvent(value: unknown): value is ProductTaskEvent {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    typeof (value as { type?: unknown }).type === 'string' &&
    PRODUCT_TASK_EVENT_TYPES.has((value as { type: ProductTaskEvent['type'] }).type),
  )
}

export class ProductTaskSocketManager {
  private connections = new Map<string, Connection>()

  connect(taskId: string, handler: ProductTaskEventHandler): () => void {
    let connection = this.connections.get(taskId)
    if (!connection || connection.intentionalClose) {
      connection = this.createConnection(taskId, connection)
    }
    connection.handlers.add(handler)
    return () => {
      const current = this.connections.get(taskId)
      current?.handlers.delete(handler)
    }
  }

  disconnect(taskId: string): void {
    const connection = this.connections.get(taskId)
    if (!connection) return

    connection.intentionalClose = true
    this.stopPingLoop(connection)
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer)
      connection.reconnectTimer = null
    }
    connection.pendingMessages = []
    connection.ws.close()
    this.connections.delete(taskId)
  }

  disconnectAll(): void {
    for (const taskId of [...this.connections.keys()]) {
      this.disconnect(taskId)
    }
  }

  send(taskId: string, message: ProductTaskClientMessage): void {
    let connection = this.connections.get(taskId)
    if (!connection || connection.intentionalClose) {
      connection = this.createConnection(taskId, connection)
    }

    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(message))
      return
    }

    connection.pendingMessages.push(message)
    if (
      connection.ws.readyState === WebSocket.CLOSED ||
      connection.ws.readyState === WebSocket.CLOSING
    ) {
      this.scheduleReconnect(taskId, connection)
    }
  }

  private createConnection(taskId: string, previous?: Connection): Connection {
    const ws = new WebSocket(buildProductTaskWebSocketUrl(taskId))
    const connection: Connection = {
      ws,
      handlers: previous?.handlers ?? new Set(),
      reconnectTimer: null,
      reconnectAttempt: previous?.reconnectAttempt ?? 0,
      pingInterval: null,
      intentionalClose: false,
      pendingMessages: previous?.pendingMessages ?? [],
    }
    this.connections.set(taskId, connection)

    ws.onopen = () => {
      connection.reconnectAttempt = 0
      this.startPingLoop(taskId, connection)
      while (connection.pendingMessages.length > 0) {
        const message = connection.pendingMessages.shift()!
        ws.send(JSON.stringify(message))
      }
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as unknown
        if (!isProductTaskEvent(message)) return
        for (const handler of connection.handlers) handler(message)
      } catch {
        // Invalid payloads are never promoted into product task state.
      }
    }

    ws.onclose = () => {
      this.stopPingLoop(connection)
      if (!connection.intentionalClose && this.connections.get(taskId) === connection) {
        this.scheduleReconnect(taskId, connection)
      }
    }

    ws.onerror = () => {
      // The browser follows errors with close; reconnect scheduling lives there.
    }

    return connection
  }

  private startPingLoop(taskId: string, connection: Connection): void {
    this.stopPingLoop(connection)
    connection.pingInterval = setInterval(() => {
      this.send(taskId, { type: 'ping' })
    }, 30_000)
  }

  private stopPingLoop(connection: Connection): void {
    if (!connection.pingInterval) return
    clearInterval(connection.pingInterval)
    connection.pingInterval = null
  }

  private scheduleReconnect(taskId: string, connection: Connection): void {
    if (connection.intentionalClose || connection.reconnectTimer) return
    const delay = Math.min(1_000 * 2 ** connection.reconnectAttempt, 30_000)
    connection.reconnectAttempt += 1
    connection.reconnectTimer = setTimeout(() => {
      if (this.connections.get(taskId) !== connection || connection.intentionalClose) return
      connection.reconnectTimer = null
      this.createConnection(taskId, connection)
    }, delay)
  }
}

export function buildProductTaskWebSocketUrl(taskId: string): string {
  const url = new URL(getBaseUrl())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  url.pathname = `${basePath}/ws/product/tasks/${encodeURIComponent(taskId)}`
  return url.toString()
}

export const productTaskSocket = new ProductTaskSocketManager()
