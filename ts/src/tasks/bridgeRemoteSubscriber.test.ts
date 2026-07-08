import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgePeerRegistry } from './bridgePeerRegistry'
import { BridgeRemoteState } from './bridgeRemoteState'
import { BridgeRemoteSubscriber } from './bridgeRemoteSubscriber'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly listeners = new Map<string, Array<(...args: any[]) => void>>()
  readonly sent: string[] = []
  closed = false

  constructor(readonly url: string, readonly init?: any) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (...args: any[]) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  ping(): void {
    this.sent.push('__ping__')
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function resetFakeWebSockets(): void {
  FakeWebSocket.instances = []
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('BridgeRemoteSubscriber connects to Sessions WebSocket and stores SDK/control messages', async () => {
  resetFakeWebSockets()
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-subscriber-'))
  let subscriber: BridgeRemoteSubscriber | undefined
  try {
    const state = new BridgeRemoteState(root)
    const peers = new BridgePeerRegistry(root)
    const connected: string[] = []
    subscriber = new BridgeRemoteSubscriber('session_ws', {
      baseUrl: 'https://remote.example',
      token: 'oauth-token',
      orgUuid: 'org_1',
      WebSocketCtor: FakeWebSocket as any,
      pingIntervalMs: 60_000,
    }, { state, peers }, { onConnected: () => connected.push('yes') })

    subscriber.connect()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]!
    expect(ws.url).toBe('wss://remote.example/v1/sessions/ws/session_ws/subscribe?organization_uuid=org_1')
    expect(ws.init.headers).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'anthropic-version': '2023-06-01',
    })
    ws.emit('open')
    expect(subscriber.isConnected()).toBe(true)
    expect(connected).toEqual(['yes'])
    const peer = await waitFor(async () => {
      const current = await peers.get('session_ws')
      return current?.status === 'connected' ? current : null
    })
    expect(peer).toMatchObject({ status: 'connected', inboundEnabled: true })

    ws.emit('message', { data: JSON.stringify({ type: 'assistant', uuid: 'msg_1', message: { content: [] } }) })
    ws.emit('message', { data: JSON.stringify({
      type: 'control_request',
      request_id: 'req_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        input: { command: 'pwd' },
      },
    }) })
    const events = await waitFor(async () => {
      const current = await state.listEvents('session_ws')
      return current.length === 2 ? current : null
    })
    expect(events).toEqual([
      expect.objectContaining({ type: 'assistant', kind: 'sdk_message' }),
      expect.objectContaining({ type: 'control_request', kind: 'control_request' }),
    ])
    const pending = await waitFor(async () => {
      const current = await state.listPermissions('session_ws', 'pending')
      return current.length === 1 ? current : null
    })
    expect(pending).toEqual([
      expect.objectContaining({ requestId: 'req_1', toolName: 'Bash', status: 'pending' }),
    ])
  } finally {
    subscriber?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgeRemoteSubscriber retries transient closes and stops on permanent close', async () => {
  resetFakeWebSockets()
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-retry-'))
  let subscriber: BridgeRemoteSubscriber | undefined
  try {
    const state = new BridgeRemoteState(root)
    const peers = new BridgePeerRegistry(root)
    const reconnecting: string[] = []
    const disconnected: string[] = []
    subscriber = new BridgeRemoteSubscriber('session_retry', {
      baseUrl: 'http://127.0.0.1:8850',
      token: 'token',
      reconnectDelayMs: 1,
      maxSessionNotFoundRetries: 1,
      WebSocketCtor: FakeWebSocket as any,
      pingIntervalMs: 60_000,
    }, { state, peers }, {
      onReconnecting: () => reconnecting.push('yes'),
      onDisconnected: () => disconnected.push('yes'),
    })

    subscriber.connect()
    FakeWebSocket.instances[0]!.emit('open')
    FakeWebSocket.instances[0]!.emit('close', { code: 4001 })
    expect(reconnecting).toEqual(['yes'])
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]!.url).toBe('ws://127.0.0.1:8850/v1/sessions/ws/session_retry/subscribe')

    FakeWebSocket.instances[1]!.emit('open')
    FakeWebSocket.instances[1]!.emit('close', { code: 4003 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disconnected).toEqual(['yes'])
    expect(await peers.get('session_retry')).toMatchObject({
      status: 'error',
      inboundEnabled: false,
      lastError: 'permanent close 4003',
    })
  } finally {
    subscriber?.close()
    subscriberCleanup(FakeWebSocket.instances)
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgeRemoteSubscriber sends control responses only while connected', async () => {
  resetFakeWebSockets()
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-send-control-'))
  try {
    const subscriber = new BridgeRemoteSubscriber('session_control', {
      baseUrl: 'https://remote.example',
      token: 'token',
      WebSocketCtor: FakeWebSocket as any,
      pingIntervalMs: 60_000,
    }, { state: new BridgeRemoteState(root) })

    subscriber.connect()
    const ws = FakeWebSocket.instances[0]!
    expect(subscriber.sendControlResponse({ type: 'control_response' })).toBe(false)
    ws.emit('open')
    expect(subscriber.sendControlResponse({ type: 'control_response', response: { subtype: 'success' } })).toBe(true)
    expect(ws.sent).toContain(JSON.stringify({ type: 'control_response', response: { subtype: 'success' } }))
    subscriber.close()
    expect(ws.closed).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function subscriberCleanup(items: FakeWebSocket[]): void {
  for (const item of items) item.close()
}
