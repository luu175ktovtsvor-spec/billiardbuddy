import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgePeerRegistry } from '../../tasks/bridgePeerRegistry'
import { BridgeRemoteState } from '../../tasks/bridgeRemoteState'
import { createBridgeSessionRouteController } from './bridgeSessionRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-session-routes-'))
  roots.push(root)
  const dispatched: Array<{ body: Record<string, unknown>; text: unknown }> = []
  const projected: Record<string, unknown>[] = []
  const controller = createBridgeSessionRouteController({
    state: new BridgeRemoteState(root),
    peers: new BridgePeerRegistry(root),
    stateRoot: root,
    env: {},
    async dispatchInbound(body, resolved) {
      dispatched.push({ body, text: resolved.content })
      return { mode: 'task', task_id: 'task-1' }
    },
    async projectEvent(_body, payload) {
      projected.push(payload)
    },
  })
  return { root, controller, dispatched, projected }
}

async function route(controller: ReturnType<typeof harness>['controller'], path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`http://127.0.0.1${path}`, init)
  const response = await controller.handle(new URL(request.url), request)
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('bridge session routes', () => {
  test('ignores unrelated paths and preserves method handling', async () => {
    const { controller } = harness()
    expect(await controller.handle(new URL('http://127.0.0.1/health'), new Request('http://127.0.0.1/health'))).toBeNull()
    expect((await route(controller, '/api/v1/agent/bridge/sessions/demo/events', { method: 'DELETE' })).status).toBe(405)
    expect((await route(controller, '/api/v1/agent/bridge/subscribers', { method: 'POST' })).status).toBe(405)
    controller.close()
  })

  test('persists events and returns cursor-filtered lists', async () => {
    const { controller } = harness()
    const created = await route(controller, '/api/v1/agent/bridge/sessions/demo/events', {
      method: 'POST',
      body: JSON.stringify({ event: { type: 'assistant', uuid: 'msg-1', message: { role: 'assistant', content: [] } } }),
    })
    expect(created.status).toBe(201)
    const listed = await (await route(controller, '/api/v1/agent/bridge/sessions/demo/events?after=0&limit=10')).json() as any
    expect(listed.events).toEqual([expect.objectContaining({ sessionId: 'demo', seq: 1, type: 'assistant' })])
  })

  test('resolves, stores and dispatches inbound user messages with bridge context', async () => {
    const { controller, dispatched } = harness()
    const response = await route(controller, '/api/v1/agent/bridge/sessions/demo/inbound/resolve', {
      method: 'POST',
      body: JSON.stringify({
        autoRun: true,
        conversationId: 'conv-1',
        event: { type: 'user', uuid: 'user-1', message: { role: 'user', content: [{ type: 'text', text: '检查项目' }] } },
      }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      resolved: { content: [{ type: 'text', text: '检查项目' }], bridgeOrigin: true, skipSlashCommands: true },
      message: { sessionId: 'demo' },
      dispatch: { mode: 'task', task_id: 'task-1' },
    })
    expect(dispatched).toEqual([expect.objectContaining({
      body: expect.objectContaining({ bridgeSessionId: 'demo' }),
      text: [{ type: 'text', text: '检查项目' }],
    })])
  })

  test('responds to permissions and exposes queued and sent outbox states', async () => {
    const { controller } = harness()
    await route(controller, '/api/v1/agent/bridge/sessions/demo/events', {
      method: 'POST',
      body: JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'tool-1', input: { path: 'a.ts' } },
      }),
    })
    const pending = await (await route(controller, '/api/v1/agent/bridge/sessions/demo/permissions?status=pending')).json() as any
    expect(pending.permissions).toHaveLength(1)

    const responded = await route(controller, '/api/v1/agent/bridge/sessions/demo/permissions/req-1/respond', {
      method: 'POST',
      body: JSON.stringify({ behavior: 'allow', updatedInput: { path: 'b.ts' } }),
    })
    expect(await responded.json()).toMatchObject({ permission: { status: 'allowed' }, outbox: { status: 'queued' } })

    const queued = await (await route(controller, '/api/v1/agent/bridge/sessions/demo/outbox?status=queued')).json() as any
    const outboxId = queued.outbox[0].id as string
    const marked = await route(controller, `/api/v1/agent/bridge/sessions/demo/outbox/${encodeURIComponent(outboxId)}/sent`, { method: 'POST' })
    expect(await marked.json()).toMatchObject({ outbox: { status: 'sent' } })
  })
})
