import { expect, test } from 'bun:test'
import { createBridgeCodeSessionClient } from './bridgeCodeSessionClient'

test('BridgeCodeSessionClient creates code sessions with bridge runner body', async () => {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const client = createBridgeCodeSessionClient({
    baseUrl: 'https://remote.example/',
    token: 'oauth-token',
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      return Response.json({ session: { id: 'cse_123' } }, { status: 201 })
    },
  })

  expect(await client.createCodeSession({ title: 'Desk session', tags: ['desktop', 'bridge'] })).toEqual({
    ok: true,
    value: 'cse_123',
    status: 201,
  })
  expect(calls).toEqual([{
    url: 'https://remote.example/v1/code/sessions',
    body: { title: 'Desk session', bridge: {}, tags: ['desktop', 'bridge'] },
    headers: expect.objectContaining({
      authorization: 'Bearer oauth-token',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }),
  }])
})

test('BridgeCodeSessionClient fetches worker credentials from code session bridge endpoint', async () => {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const client = createBridgeCodeSessionClient({
    baseUrl: 'http://127.0.0.1:8850',
    token: 'oauth-token',
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      return Response.json({
        worker_jwt: 'worker.jwt',
        api_base_url: 'https://session-ingress.example/sdk/cse_123',
        expires_in: 3600,
        worker_epoch: '42',
      })
    },
  })

  expect(await client.fetchRemoteCredentials('cse_123', 'trusted-device')).toEqual({
    ok: true,
    value: {
      workerJwt: 'worker.jwt',
      apiBaseUrl: 'https://session-ingress.example/sdk/cse_123',
      expiresIn: 3600,
      workerEpoch: 42,
    },
    status: 200,
  })
  expect(calls).toEqual([{
    url: 'http://127.0.0.1:8850/v1/code/sessions/cse_123/bridge',
    body: {},
    headers: expect.objectContaining({
      authorization: 'Bearer oauth-token',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-trusted-device-token': 'trusted-device',
    }),
  }])
})

test('BridgeCodeSessionClient rejects malformed sessions, credentials, and unsafe base URLs', async () => {
  const badSession = createBridgeCodeSessionClient({
    baseUrl: 'https://remote.example',
    token: 'token',
    fetchImpl: async () => Response.json({ session: { id: 'bad_123' } }),
  })
  expect(await badSession.createCodeSession({ title: 'x' })).toMatchObject({
    ok: false,
    status: 200,
    error: 'Code session create response missing cse_* session.id',
  })

  const badBridge = createBridgeCodeSessionClient({
    baseUrl: 'https://remote.example',
    token: 'token',
    fetchImpl: async () => Response.json({ worker_jwt: 'jwt', api_base_url: 'https://remote.example', expires_in: 60, worker_epoch: 'not-number' }),
  })
  expect(await badBridge.fetchRemoteCredentials('cse_123')).toMatchObject({
    ok: false,
    status: 200,
    error: 'Code session bridge response missing worker_jwt, api_base_url, expires_in, or worker_epoch',
  })

  const insecure = createBridgeCodeSessionClient({
    baseUrl: 'http://remote.example',
    token: 'token',
    fetchImpl: async () => Response.json({}),
  })
  expect(await insecure.createCodeSession({ title: 'x' })).toMatchObject({
    ok: false,
    error: 'bridge code session baseUrl must use HTTPS or localhost HTTP',
  })
})
