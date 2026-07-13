import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpTrustStore } from '../../mcp/mcpTrust'
import { createMcpRouteHandler } from './mcpRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-routes-'))
  roots.push(root)
  const trust = new McpTrustStore(join(root, 'mcp-trust.json'))
  const calls = {
    status: [] as Array<string | undefined>,
    add: [] as Array<Record<string, unknown>>,
    remove: [] as unknown[],
    toggle: [] as Array<[unknown, unknown]>,
  }
  const handler = createMcpRouteHandler({
    presets: [{ id: 'demo' }],
    trust,
    listStatus: async workspaceRoot => {
      calls.status.push(workspaceRoot)
      return { servers: [], ...(workspaceRoot ? { workspaceRoot } : {}) }
    },
    add: async body => {
      calls.add.push(body)
      return { ok: Object.keys(body).length > 0 }
    },
    remove: async name => {
      calls.remove.push(name)
      return { ok: typeof name === 'string' }
    },
    setDisabled: async (name, disabled) => {
      calls.toggle.push([name, disabled])
      return { ok: typeof name === 'string', disabled: disabled === true }
    },
  })
  return { root, trust, calls, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createMcpRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('MCP routes', () => {
  test('ignores unrelated paths and preserves method errors', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/api/v1/agent/mcps'), request('/api/v1/agent/mcps'))).toBeNull()
    expect((await route(handler, '/api/v1/agent/mcp', { method: 'POST' })).status).toBe(405)
    expect((await route(handler, '/api/v1/agent/mcp/presets', { method: 'POST' })).status).toBe(405)
    expect((await route(handler, '/api/v1/agent/mcp/add')).status).toBe(405)
    expect((await route(handler, '/api/v1/agent/mcp/remove')).status).toBe(405)
    expect((await route(handler, '/api/v1/agent/mcp/toggle')).status).toBe(405)
  })

  test('lists status and presets without broadening query compatibility', async () => {
    const { calls, handler } = createHarness()
    const status = await (await route(handler, '/api/v1/agent/mcp?workspaceRoot=%2Fworkspace&working_dir=%2Fignored')).json()
    expect(status).toEqual({ servers: [], workspaceRoot: '/workspace' })
    expect(calls.status).toEqual(['/workspace'])

    expect(await (await route(handler, '/api/v1/agent/mcp/presets')).json()).toEqual({ presets: [{ id: 'demo' }] })
  })

  test('persists trust and revoke operations with both accepted root field names', async () => {
    const { root, trust, handler } = createHarness()
    const workspaceRoot = join(root, 'workspace')
    expect(await (await route(handler, '/api/v1/agent/mcp/trust')).json()).toEqual({ approved_workspace_roots: [] })

    const trusted = await (await route(handler, '/api/v1/agent/mcp/trust', {
      method: 'POST',
      body: JSON.stringify({ working_dir: workspaceRoot }),
    })).json() as any
    expect(trusted).toMatchObject({ ok: true, trusted: true, approved_workspace_roots: [resolve(workspaceRoot)] })
    expect(new McpTrustStore(join(root, 'mcp-trust.json')).isTrusted(workspaceRoot)).toBe(true)

    const revoked = await (await route(handler, '/api/v1/agent/mcp/trust', {
      method: 'DELETE',
      body: JSON.stringify({ workspaceRoot }),
    })).json() as any
    expect(revoked).toEqual({ ok: true, trusted: false, approved_workspace_roots: [] })
    expect(trust.isTrusted(workspaceRoot)).toBe(false)
  })

  test('keeps trust validation before unsupported method handling', async () => {
    const { handler } = createHarness()
    expect((await route(handler, '/api/v1/agent/mcp/trust', { method: 'POST', body: '{bad' })).status).toBe(400)
    expect((await route(handler, '/api/v1/agent/mcp/trust', { method: 'PUT', body: '{}' })).status).toBe(400)
    expect((await route(handler, '/api/v1/agent/mcp/trust', {
      method: 'PUT',
      body: JSON.stringify({ workspaceRoot: '/workspace' }),
    })).status).toBe(405)
  })

  test('forwards config mutations and preserves malformed JSON fallbacks', async () => {
    const { calls, handler } = createHarness()
    expect(await (await route(handler, '/api/v1/agent/mcp/add', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', command: 'node' }),
    })).json()).toEqual({ ok: true })
    expect(await (await route(handler, '/api/v1/agent/mcp/add', { method: 'POST', body: '{bad' })).json()).toEqual({ ok: false })
    expect(await (await route(handler, '/api/v1/agent/mcp/remove', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo' }),
    })).json()).toEqual({ ok: true })
    expect(await (await route(handler, '/api/v1/agent/mcp/toggle', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', disabled: true }),
    })).json()).toEqual({ ok: true, disabled: true })

    expect(calls.add).toEqual([{ name: 'demo', command: 'node' }, {}])
    expect(calls.remove).toEqual(['demo'])
    expect(calls.toggle).toEqual([['demo', true]])
  })
})
