import { getBaseUrl } from '../../api/client'
import type { ProductTaskEvent } from '../domain/types'
import { parseProductTaskEvent } from './taskProtocol'

export type ProductTaskAttachment = {
  type: 'file' | 'image'
  name?: string
  data: string
  mimeType: string
}

export type ProductTaskClientMessage =
  | { type: 'resume'; cursor: number }
  | { type: 'permission_response'; requestId: string; allowed: boolean }
  | { type: 'ask_user_question_response'; requestId: string; answers: string[] }
  | { type: 'computer_use_permission_response'; requestId: string; allowed: boolean }
  | { type: 'stop_generation' }
  | { type: 'ping' }

export type ProductTaskEventHandler = (event: ProductTaskEvent) => void

export type ProductTaskSocketLifecycleEvent =
  | { type: 'connecting' }
  | { type: 'reconnecting' }
  | { type: 'connected'; reconnected: boolean }
  | { type: 'disconnected'; willReconnect: boolean }

export type ProductTaskSocketLifecycleHandler = (
  event: ProductTaskSocketLifecycleEvent,
) => void

type Connection = {
  ws: WebSocket
  handlers: Set<ProductTaskEventHandler>
  lifecycleHandlers: Set<ProductTaskSocketLifecycleHandler>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  pingInterval: ReturnType<typeof setInterval> | null
  intentionalClose: boolean
  pendingMessages: ProductTaskClientMessage[]
  hasOpened: boolean
  lifecycleEvent: ProductTaskSocketLifecycleEvent
  resumeCursor: number
}

export class ProductTaskSocketManager {
  private connections = new Map<string, Connection>()

  connect(
    taskId: string,
    handler: ProductTaskEventHandler,
    lifecycleHandler?: ProductTaskSocketLifecycleHandler,
  ): () => void {
    let connection = this.connections.get(taskId)
    if (!connection || connection.intentionalClose) {
      connection = this.createConnection(taskId, connection)
    }
    connection.handlers.add(handler)
    if (lifecycleHandler) {
      connection.lifecycleHandlers.add(lifecycleHandler)
      this.notifyLifecycleHandler(lifecycleHandler, connection.lifecycleEvent)
    }
    return () => {
      const current = this.connections.get(taskId)
      current?.handlers.delete(handler)
      if (lifecycleHandler) current?.lifecycleHandlers.delete(lifecycleHandler)
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
    this.publishLifecycle(connection, { type: 'disconnected', willReconnect: false })
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
      lifecycleHandlers: previous?.lifecycleHandlers ?? new Set(),
      reconnectTimer: null,
      reconnectAttempt: previous?.reconnectAttempt ?? 0,
      pingInterval: null,
      intentionalClose: false,
      pendingMessages: previous?.pendingMessages ?? [],
      hasOpened: previous?.hasOpened ?? false,
      lifecycleEvent: previous?.hasOpened
        ? { type: 'reconnecting' }
        : { type: 'connecting' },
      resumeCursor: previous?.resumeCursor ?? 0,
    }
    this.connections.set(taskId, connection)

    if (previous) this.publishLifecycle(connection, { type: 'reconnecting' })

    ws.onopen = () => {
      if (this.connections.get(taskId) !== connection || connection.intentionalClose) {
        ws.close()
        return
      }
      const reconnected = connection.hasOpened
      connection.hasOpened = true
      connection.reconnectAttempt = 0
      this.startPingLoop(taskId, connection)
      this.publishLifecycle(connection, { type: 'connected', reconnected })
      ws.send(JSON.stringify({ type: 'resume', cursor: connection.resumeCursor }))
      while (connection.pendingMessages.length > 0) {
        const message = connection.pendingMessages.shift()!
        ws.send(JSON.stringify(message))
      }
    }

    ws.onmessage = (event) => {
      try {
        if (this.connections.get(taskId) !== connection || connection.intentionalClose) return
        const message = JSON.parse(event.data as string) as unknown
        const productEvent = parseProductTaskEvent(message)
        if (!productEvent) return
        if (productEvent.type === 'resume_cursor') {
          connection.resumeCursor = Math.max(connection.resumeCursor, productEvent.cursor)
        } else if (productEvent.type === 'user_text' && productEvent.event_sequence !== undefined) {
          connection.resumeCursor = Math.max(connection.resumeCursor, productEvent.event_sequence)
        }
        for (const handler of connection.handlers) {
          try {
            handler(productEvent)
          } catch {
            // One product subscriber must not starve the other subscribers.
          }
        }
      } catch {
        // Invalid payloads are never promoted into product task state.
      }
    }

    ws.onclose = () => {
      this.stopPingLoop(connection)
      if (!connection.intentionalClose && this.connections.get(taskId) === connection) {
        this.publishLifecycle(connection, { type: 'disconnected', willReconnect: true })
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
    this.publishLifecycle(connection, { type: 'reconnecting' })
    const delay = Math.min(1_000 * 2 ** connection.reconnectAttempt, 30_000)
    connection.reconnectAttempt += 1
    connection.reconnectTimer = setTimeout(() => {
      if (this.connections.get(taskId) !== connection || connection.intentionalClose) return
      connection.reconnectTimer = null
      this.createConnection(taskId, connection)
    }, delay)
  }

  private publishLifecycle(
    connection: Connection,
    event: ProductTaskSocketLifecycleEvent,
  ): void {
    connection.lifecycleEvent = event
    for (const handler of connection.lifecycleHandlers) {
      this.notifyLifecycleHandler(handler, event)
    }
  }

  private notifyLifecycleHandler(
    handler: ProductTaskSocketLifecycleHandler,
    event: ProductTaskSocketLifecycleEvent,
  ): void {
    try {
      handler(event)
    } catch {
      // Lifecycle observers are UI concerns and must not disrupt transport recovery.
    }
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
