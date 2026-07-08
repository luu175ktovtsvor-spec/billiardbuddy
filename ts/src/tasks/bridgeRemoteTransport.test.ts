import { expect, test } from 'bun:test'
import { bridgeRemoteConfigFromEnv, createBridgeRemoteTransport } from './bridgeRemoteTransport'
import type { BridgeRemoteOutboxItem } from './bridgeRemoteState'

test('BridgeRemoteTransport posts user messages using Sessions API event shape', async () => {
  const calls: Array<{ input: string; init?: RequestInit; body: any; headers: Record<string, string> }> = []
  const transport = createBridgeRemoteTransport({
    baseUrl: 'https://remote.example',
    token: 'secret-token',
    orgUuid: 'org_123',
    fetchImpl: async (input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      calls.push({ input: String(input), init, body: JSON.parse(String(init?.body)), headers })
      return new Response('{}', { status: 201 })
    },
  })

  const result = await transport.sendUserMessage('session_abc', 'hello remote', { uuid: 'uuid_1' })
  expect(result).toEqual({ ok: true, status: 201 })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.input).toBe('https://remote.example/v1/sessions/session_abc/events')
  expect(calls[0]!.headers).toMatchObject({
    authorization: 'Bearer secret-token',
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': 'org_123',
  })
  expect(calls[0]!.body).toEqual({
    events: [{
      uuid: 'uuid_1',
      session_id: 'session_abc',
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'hello remote' },
    }],
  })
})

test('BridgeRemoteTransport posts permission control_response outbox items', async () => {
  let body: any
  const transport = createBridgeRemoteTransport({
    baseUrl: 'http://127.0.0.1:9999/',
    token: 'worker-jwt',
    betaHeader: '',
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return new Response('', { status: 204 })
    },
  })
  const item: BridgeRemoteOutboxItem = {
    id: 'out_1',
    sessionId: 'session_perm',
    requestId: 'req_1',
    kind: 'control_response',
    payload: {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req_1',
        response: { behavior: 'deny', message: 'no' },
      },
    },
    status: 'queued',
    createdAt: new Date().toISOString(),
  }

  expect(await transport.sendOutboxItem(item)).toEqual({ ok: true, status: 204 })
  expect(body).toEqual({ events: [item.payload] })
})

test('BridgeRemoteTransport reports remote and local configuration failures', async () => {
  const badStatus = createBridgeRemoteTransport({
    baseUrl: 'https://remote.example',
    token: 'secret-token',
    fetchImpl: async () => new Response('bad request', { status: 400 }),
  })
  expect(await badStatus.sendUserMessage('session_abc', 'hello')).toEqual({
    ok: false,
    status: 400,
    error: 'Remote Control event POST failed 400: bad request',
  })

  const insecure = createBridgeRemoteTransport({
    baseUrl: 'http://remote.example',
    token: 'secret-token',
    fetchImpl: async () => new Response('', { status: 200 }),
  })
  expect(await insecure.sendUserMessage('session_abc', 'hello')).toMatchObject({
    ok: false,
    error: 'bridge remote baseUrl must use HTTPS or localhost HTTP',
  })
})

test('bridgeRemoteConfigFromEnv accepts explicit bridge remote settings', () => {
  expect(bridgeRemoteConfigFromEnv({
    BRIDGE_REMOTE_BASE_URL: 'https://remote.example',
    BRIDGE_REMOTE_TOKEN: 'token',
    BRIDGE_REMOTE_ORG_UUID: 'org_1',
    BRIDGE_REMOTE_TIMEOUT_MS: '1234',
  })).toEqual({
    baseUrl: 'https://remote.example',
    token: 'token',
    orgUuid: 'org_1',
    betaHeader: undefined,
    timeoutMs: 1234,
  })
  expect(bridgeRemoteConfigFromEnv({})).toBeNull()
})
