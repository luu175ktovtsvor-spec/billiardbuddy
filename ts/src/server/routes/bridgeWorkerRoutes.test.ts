import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from '../../proxy/ProxyModel'
import { BridgePeerRegistry } from '../../tasks/bridgePeerRegistry'
import { BridgeRemoteState } from '../../tasks/bridgeRemoteState'
import { createBridgeWorkerRouteController } from './bridgeWorkerRoutes'

const roots: string[] = []
const controllers: Array<ReturnType<typeof createBridgeWorkerRouteController>> = []

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness(fetchImpl: FetchLike) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-worker-routes-'))
  roots.push(root)
  const state = new BridgeRemoteState(root)
  const peers = new BridgePeerRegistry(root)
  const controller = createBridgeWorkerRouteController({
    state,
    peers,
    stateRoot: root,
    env: {},
    fetchImpl,
    async dispatchInbound() { return { mode: 'stored' } },
    async projectEvent() {},
  })
  controllers.push(controller)
  return { controller, state, peers }
}

async function route(controller: ReturnType<typeof createBridgeWorkerRouteController>, path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`http://127.0.0.1${path}`, init)
  const response = await controller.handle(new URL(request.url), request)
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('bridge worker routes', () => {
  test('ignores unrelated paths and preserves disconnected and method responses', async () => {
    const { controller } = harness(async () => Response.json({}))
    expect(await controller.handle(new URL('http://127.0.0.1/health'), new Request('http://127.0.0.1/health'))).toBeNull()
    expect((await route(controller, '/api/v1/agent/bridge/code-sessions/missing/worker', { method: 'POST' })).status).toBe(404)
    expect((await route(controller, '/api/v1/agent/bridge/code-sessions/missing/worker/event', { method: 'POST' })).status).toBe(409)
    expect((await route(controller, '/api/v1/agent/bridge/code-sessions/missing/worker/refresh')).status).toBe(405)
  })

  test('starts a stored worker and routes uploads without exposing credentials', async () => {
    const calls: Array<{ url: string; method: string; body: any; authorization: string | null }> = []
    const { controller, state, peers } = harness(async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Response.json({})
    })
    await state.storeCredentials('cse_route', {
      workerJwt: 'worker.secret.jwt',
      apiBaseUrl: 'https://session-ingress.example',
      expiresIn: 3600,
      workerEpoch: 9,
    })
    const base = '/api/v1/agent/bridge/code-sessions/bridge%3Acse_route/worker'

    const started = await route(controller, base, {
      method: 'POST',
      body: JSON.stringify({ stream: false, heartbeatIntervalMs: 60_000 }),
    })
    expect(await started.json()).toEqual({
      ok: true,
      sessionId: 'cse_route',
      workerEpoch: 9,
      initStatus: 200,
      stream: false,
      initialSequenceNum: 0,
    })
    const status = await (await route(controller, base)).json() as any
    expect(status).toMatchObject({ sessionId: 'cse_route', connected: true, workerEpoch: 9, stream: null })
    expect(JSON.stringify(status)).not.toContain('worker.secret.jwt')

    await route(controller, `${base}/event`, { method: 'POST', body: JSON.stringify({ type: 'assistant', message: { id: 'msg-1' } }) })
    await route(controller, `${base}/internal-event`, { method: 'POST', body: JSON.stringify({ eventType: 'transcript_entry', payload: { uuid: 'entry-1' } }) })
    await route(controller, `${base}/state`, { method: 'POST', body: JSON.stringify({ state: 'requires_action', details: { toolName: 'Write', requestId: 'req-1' } }) })
    await route(controller, `${base}/metadata`, { method: 'POST', body: JSON.stringify({ metadata: { source: 'desktop' } }) })
    await route(controller, `${base}/delivery`, { method: 'POST', body: JSON.stringify({ eventId: 'evt-1', status: 'processed' }) })
    await route(controller, `${base}/heartbeat`, { method: 'POST' })
    await route(controller, `${base}/flush`, { method: 'POST' })

    expect(calls.every(call => call.authorization === 'Bearer worker.secret.jwt')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker/events') && call.body.events[0].payload.type === 'assistant')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker/internal-events') && call.body.events[0].payload.type === 'transcript_entry')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker') && call.body.worker_status === 'requires_action')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker') && call.body.external_metadata.source === 'desktop')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker/events/delivery') && call.body.updates[0].event_id === 'evt-1')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker/heartbeat'))).toBe(true)
    expect(await peers.get('cse_route')).toMatchObject({ status: 'connected', inboundEnabled: true })

    expect((await route(controller, base, { method: 'DELETE' })).status).toBe(200)
    expect(await peers.get('cse_route')).toMatchObject({ status: 'outbound_only' })
    expect((await (await route(controller, base)).json() as any).connected).toBe(false)
  })

  test('manually refreshes credentials before replacing the worker transport', async () => {
    const calls: string[] = []
    const { controller } = harness(async input => {
      calls.push(String(input))
      if (String(input).endsWith('/bridge')) {
        return Response.json({
          worker_jwt: 'refreshed.jwt',
          api_base_url: 'https://session-ingress.example',
          expires_in: 7200,
          worker_epoch: 12,
        })
      }
      return Response.json({})
    })
    const refreshed = await route(controller, '/api/v1/agent/bridge/code-sessions/cse_refresh/worker/refresh', {
      method: 'POST',
      body: JSON.stringify({
        stream: false,
        bridgeRemoteBaseUrl: 'https://remote.example',
        bridgeRemoteToken: 'oauth-token',
      }),
    })
    expect(await refreshed.json()).toMatchObject({
      ok: true,
      sessionId: 'cse_refresh',
      workerEpoch: 12,
      refreshStatus: 200,
      stream: false,
    })
    expect(calls).toEqual([
      'https://remote.example/v1/code/sessions/cse_refresh/bridge',
      'https://session-ingress.example/v1/code/sessions/cse_refresh/worker',
    ])
  })
})
