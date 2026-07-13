import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPlugins, setPluginEnabled } from '../../plugins/pluginLoader'
import { createPluginRouteHandler } from './pluginRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-routes-'))
  roots.push(root)
  const installCalls: unknown[] = []
  const handler = createPluginRouteHandler({
    list: () => listPlugins([root]),
    setEnabled: (name, enabled) => setPluginEnabled(name, enabled, [root]),
    installFromGithub: async repo => {
      installCalls.push(repo)
      return { ok: typeof repo === 'string', ...(repo === undefined ? {} : { repo }) }
    },
  })
  return { root, installCalls, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createPluginRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('plugin routes', () => {
  test('ignores unrelated paths and preserves method errors', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/api/v1/agent/plugin'), request('/api/v1/agent/plugin'))).toBeNull()
    expect((await route(handler, '/api/v1/agent/plugins', { method: 'POST' })).status).toBe(405)
    expect((await route(handler, '/api/v1/agent/plugins/toggle')).status).toBe(405)
    expect((await route(handler, '/api/v1/agent/plugins/install')).status).toBe(405)
  })

  test('lists plugins and persists enablement changes through the plugin loader', async () => {
    const { root, handler } = createHarness()
    const pluginDir = join(root, 'demo')
    mkdirSync(join(pluginDir, 'skills'), { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'demo', description: 'Demo plugin' }))
    writeFileSync(join(pluginDir, 'skills', 'demo.md'), '# Demo')

    const listed = await (await route(handler, '/api/v1/agent/plugins')).json() as any
    expect(listed.plugins).toEqual([
      expect.objectContaining({
        name: 'demo',
        enabled: true,
        description: 'Demo plugin',
        components: expect.objectContaining({ skills: 1 }),
      }),
    ])

    const toggled = await (await route(handler, '/api/v1/agent/plugins/toggle', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', enabled: false }),
    })).json() as any
    expect(toggled).toMatchObject({ ok: true })
    expect(JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'))).toMatchObject({ name: 'demo', enabled: false })

    const relisted = await (await route(handler, '/api/v1/agent/plugins')).json() as any
    expect(relisted.plugins[0]).toMatchObject({ name: 'demo', enabled: false })
  })

  test('keeps malformed JSON fallback and forwards install requests unchanged', async () => {
    const { installCalls, handler } = createHarness()
    const malformedToggle = await (await route(handler, '/api/v1/agent/plugins/toggle', {
      method: 'POST',
      body: '{bad',
    })).json() as any
    expect(malformedToggle).toMatchObject({ ok: false })

    const installed = await (await route(handler, '/api/v1/agent/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ repo: 'owner/repo' }),
    })).json()
    expect(installed).toEqual({ ok: true, repo: 'owner/repo' })

    const malformedInstall = await (await route(handler, '/api/v1/agent/plugins/install', {
      method: 'POST',
      body: '{bad',
    })).json()
    expect(malformedInstall).toEqual({ ok: false })
    expect(installCalls).toEqual(['owner/repo', undefined])
  })
})
