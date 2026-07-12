// WebSocket 管理器(交互机制抄 cc api/websocket:每会话一条 WS + ping 心跳 + 指数退避重连 + 离线队列)。
// ⚠️ 唯一改动 = URL 构造对齐我们后端:ws://host/agent/ws?conversationId=<id>&after=<n>(单端点,conversationId 走 query),
//    不是 cc 的 /ws/<sessionId>。消息信封见 types/chat.ts。
import { parseServerMessage, type ClientMessage, type ServerMessage } from '../types/chat'
import { getBaseUrl } from './client'

type MessageHandler = (msg: ServerMessage) => void

interface Connection {
  ws: WebSocket
  handlers: Set<MessageHandler>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempt: number
  pingInterval: ReturnType<typeof setInterval> | null
  intentionalClose: boolean
  pendingMessages: ClientMessage[]
}

/** 我们后端:ws://host/agent/ws?conversationId=<id>&after=<n>。after 用于断线重连时补投历史事件。 */
export function buildConversationWebSocketUrl(conversationId: string, after = 0): string {
  const url = new URL(getBaseUrl())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/agent/ws'
  url.searchParams.set('conversationId', conversationId)
  if (after > 0) url.searchParams.set('after', String(after))
  return url.toString()
}

class WebSocketManager {
  private connections = new Map<string, Connection>()

  isConnected(id: string): boolean {
    return this.connections.get(id)?.ws.readyState === WebSocket.OPEN
  }

  connect(conversationId: string) {
    const existing = this.connections.get(conversationId)
    if (
      existing &&
      !existing.intentionalClose &&
      (existing.ws.readyState === WebSocket.OPEN ||
        existing.ws.readyState === WebSocket.CONNECTING ||
        existing.reconnectTimer !== null)
    ) {
      return
    }

    const ws = new WebSocket(buildConversationWebSocketUrl(conversationId))
    const conn: Connection = {
      ws,
      handlers: existing?.handlers ?? new Set(),
      reconnectTimer: null,
      reconnectAttempt: existing?.reconnectAttempt ?? 0,
      pingInterval: null,
      intentionalClose: false,
      pendingMessages: existing?.pendingMessages ?? [],
    }
    this.connections.set(conversationId, conn)

    ws.onopen = () => {
      conn.reconnectAttempt = 0
      this.startPingLoop(conversationId)
      while (conn.pendingMessages.length > 0) {
        const msg = conn.pendingMessages.shift()
        if (msg) ws.send(JSON.stringify(msg))
      }
    }
    ws.onmessage = (event) => {
      try {
        const msg = parseServerMessage(JSON.parse(event.data as string))
        for (const handler of conn.handlers) handler(msg)
      } catch {
        // 忽略坏消息
      }
    }
    ws.onclose = () => {
      this.stopPingLoop(conversationId)
      if (!conn.intentionalClose && this.connections.get(conversationId) === conn) {
        this.scheduleReconnect(conversationId, conn)
      }
    }
    ws.onerror = () => {
      // onclose 会随后触发,统一在那里重连
    }
  }

  disconnect(conversationId: string) {
    const conn = this.connections.get(conversationId)
    if (!conn) return
    conn.intentionalClose = true
    this.stopPingLoop(conversationId)
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    conn.pendingMessages = []
    conn.ws.close()
    this.connections.delete(conversationId)
  }

  disconnectAll() {
    for (const id of [...this.connections.keys()]) this.disconnect(id)
  }

  send(conversationId: string, message: ClientMessage) {
    let conn = this.connections.get(conversationId)
    if (!conn) {
      this.connect(conversationId)
      conn = this.connections.get(conversationId)
      if (!conn) return
    }
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message))
      return
    }
    conn.pendingMessages.push(message)
    if (conn.ws.readyState === WebSocket.CLOSED || conn.ws.readyState === WebSocket.CLOSING) {
      if (!conn.intentionalClose && !conn.reconnectTimer) this.scheduleReconnect(conversationId, conn)
    }
  }

  onMessage(conversationId: string, handler: MessageHandler): () => void {
    let conn = this.connections.get(conversationId)
    if (!conn) {
      this.connect(conversationId)
      conn = this.connections.get(conversationId)
    }
    if (!conn) return () => {}
    conn.handlers.add(handler)
    return () => conn?.handlers.delete(handler)
  }

  private startPingLoop(conversationId: string) {
    this.stopPingLoop(conversationId)
    const conn = this.connections.get(conversationId)
    if (!conn) return
    conn.pingInterval = setInterval(() => this.send(conversationId, { type: 'ping', ts: Date.now() }), 25_000)
  }

  private stopPingLoop(conversationId: string) {
    const conn = this.connections.get(conversationId)
    if (conn?.pingInterval) {
      clearInterval(conn.pingInterval)
      conn.pingInterval = null
    }
  }

  private scheduleReconnect(conversationId: string, conn: Connection) {
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
    const delay = Math.min(1000 * 2 ** conn.reconnectAttempt, 30_000)
    conn.reconnectAttempt++
    conn.reconnectTimer = setTimeout(() => {
      if (this.connections.get(conversationId) === conn && !conn.intentionalClose) {
        conn.reconnectTimer = null
        this.connect(conversationId)
      }
    }, delay)
  }
}

export const wsManager = new WebSocketManager()
