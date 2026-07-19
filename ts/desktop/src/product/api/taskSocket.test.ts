import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  baseUrl: 'http://127.0.0.1:3456',
}))

vi.mock('../../api/client', () => ({
  getBaseUrl: () => clientMocks.baseUrl,
}))

import {
  buildProductTaskWebSocketUrl,
  ProductTaskSocketManager,
} from './taskSocket'

type SocketHandler = (() => void) | ((event: { data: string }) => void)

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: SocketHandler | null = null
  onmessage: SocketHandler | null = null
  onclose: SocketHandler | null = null
  onerror: SocketHandler | null = null
  sent: string[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    ;(this.onclose as (() => void) | null)?.()
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    ;(this.onopen as (() => void) | null)?.()
  }

  receive(data: unknown): void {
    ;(this.onmessage as ((event: { data: string }) => void) | null)?.({ data: JSON.stringify(data) })
  }

  fail(): void {
    this.readyState = FakeWebSocket.CLOSED
    ;(this.onclose as (() => void) | null)?.()
  }
}

describe('ProductTaskSocketManager', () => {
  const originalWebSocket = globalThis.WebSocket
  let manager: ProductTaskSocketManager

  beforeEach(() => {
    vi.useFakeTimers()
    clientMocks.baseUrl = 'http://127.0.0.1:3456'
    FakeWebSocket.instances = []
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    manager = new ProductTaskSocketManager()
  })

  afterEach(() => {
    manager.disconnectAll()
    globalThis.WebSocket = originalWebSocket
    vi.useRealTimers()
  })

  it('uses the product task websocket route and forwards only product events', () => {
    const events: unknown[] = []
    manager.connect('task 1', (event) => events.push(event))
    const socket = FakeWebSocket.instances[0]!

    expect(socket.url).toBe('ws://127.0.0.1:3456/ws/product/tasks/task%201')
    socket.open()
    socket.receive({ type: 'status', state: 'working' })
    socket.receive({ type: 'thinking', text: 'must be ignored' })
    socket.receive({ type: 'status', state: 'raw_core_state' })
    socket.receive({ type: 'assistant_text_delta', text: { raw: 'must be ignored' } })
    socket.receive({ type: 'error', code: 'raw_core_error', retryable: true })
    socket.receive({ type: 'status', state: 'working', sessionId: 'must be ignored' })

    expect(events).toEqual([{ type: 'status', state: 'working' }])
  })

  it('reports lifecycle transitions and marks a recovered connection', async () => {
    const lifecycle: unknown[] = []
    manager.connect('task-1', () => {}, (event) => lifecycle.push(event))
    const first = FakeWebSocket.instances[0]!

    expect(lifecycle).toEqual([{ type: 'connecting' }])
    first.open()
    expect(lifecycle.at(-1)).toEqual({ type: 'connected', reconnected: false })

    first.fail()
    expect(lifecycle).toContainEqual({ type: 'disconnected', willReconnect: true })
    expect(lifecycle.at(-1)).toEqual({ type: 'reconnecting' })

    await vi.advanceTimersByTimeAsync(1_000)
    const second = FakeWebSocket.instances[1]!
    second.open()
    expect(lifecycle.at(-1)).toEqual({ type: 'connected', reconnected: true })
  })

  it('queues real task commands until the product socket reconnects', async () => {
    manager.connect('task-1', () => {})
    const first = FakeWebSocket.instances[0]!
    first.open()
    manager.send('task-1', { type: 'user_message', content: '整理今天的订单' })
    expect(first.sent).toEqual([JSON.stringify({ type: 'user_message', content: '整理今天的订单' })])

    first.fail()
    manager.send('task-1', { type: 'stop_generation' })
    await vi.advanceTimersByTimeAsync(1_000)

    const second = FakeWebSocket.instances[1]!
    second.open()
    expect(second.sent).toEqual([JSON.stringify({ type: 'stop_generation' })])
  })

  it('serializes only product attachment and approval envelopes', () => {
    manager.connect('task-1', () => {})
    const socket = FakeWebSocket.instances[0]!
    socket.open()

    manager.send('task-1', {
      type: 'user_message',
      content: '',
      attachments: [{
        type: 'image',
        name: '球台.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,QQ==',
      }],
    })
    manager.send('task-1', {
      type: 'permission_response',
      requestId: 'permission-1',
      allowed: true,
    })
    manager.send('task-1', {
      type: 'ask_user_question_response',
      requestId: 'question-1',
      answers: ['方案 A'],
    })
    manager.send('task-1', {
      type: 'computer_use_permission_response',
      requestId: 'computer-use-1',
      allowed: false,
    })

    expect(socket.sent).toEqual([
      JSON.stringify({
        type: 'user_message',
        content: '',
        attachments: [{
          type: 'image',
          name: '球台.png',
          mimeType: 'image/png',
          data: 'data:image/png;base64,QQ==',
        }],
      }),
      JSON.stringify({ type: 'permission_response', requestId: 'permission-1', allowed: true }),
      JSON.stringify({ type: 'ask_user_question_response', requestId: 'question-1', answers: ['方案 A'] }),
      JSON.stringify({ type: 'computer_use_permission_response', requestId: 'computer-use-1', allowed: false }),
    ])
  })

  it('preserves reverse-proxy subpaths and upgrades secure URLs', () => {
    clientMocks.baseUrl = 'https://example.test/app'
    expect(buildProductTaskWebSocketUrl('task-1')).toBe(
      'wss://example.test/app/ws/product/tasks/task-1',
    )
  })
})
