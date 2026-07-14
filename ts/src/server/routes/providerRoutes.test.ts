import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from '../../proxy/ProxyModel'
import { ProviderService } from '../services/providerService'
import { createProviderRouteHandler } from './providerRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function providerInput(id: string) {
  return {
    id,
    name: `${id} provider`,
    apiFormat: 'openai_chat',
    baseUrl: `https://${id}.example/v1`,
    apiKey: `${id}-secret`,
    model: `${id}-model`,
  }
}

function createHarness(fetchImpl?: FetchLike) {
  const root = mkdtempSync(join(tmpdir(), 'provider-routes-'))
  roots.push(root)
  const providers = new ProviderService(root)
  const clearCalls: Array<Record<string, unknown>> = []
  const currentModelStatus = async () => {
    const [listed, runtime] = await Promise.all([
      providers.list(),
      providers.resolveRuntimeConfig({}),
    ])
    return {
      ok: !!runtime,
      activeId: listed.activeId,
      runtime: runtime ? { source: runtime.source, providerId: runtime.providerId } : null,
    }
  }
  const clearModelHealth = async (body: Record<string, unknown>) => {
    const providerId = typeof body.providerId === 'string' ? body.providerId : ''
    const source = typeof body.source === 'string' ? body.source : ''
    if (body.all !== true && !providerId && !source) throw new Error('providerId/source required')
    if (providerId === 'missing') throw new Error('provider runtime not found')
    clearCalls.push(body)
    return { ok: true, cleared: 1, status: await currentModelStatus() }
  }
  const handler = createProviderRouteHandler({ providers, currentModelStatus, clearModelHealth, fetchImpl })
  return { providers, clearCalls, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createProviderRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

async function createProvider(handler: ReturnType<typeof createProviderRouteHandler>, id: string): Promise<Response> {
  return route(handler, '/providers', { method: 'POST', body: JSON.stringify(providerInput(id)) })
}

describe('provider routes', () => {
  test('ignores unrelated paths and preserves method handling', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect((await route(handler, '/providers', { method: 'PUT' })).status).toBe(405)
    expect((await route(handler, '/providers/saved/unknown')).status).toBe(405)
    expect((await route(handler, '/model', { method: 'DELETE' })).status).toBe(405)
    expect((await route(handler, '/api/model/health/clear')).status).toBe(405)
  })

  test('creates, lists, reads, updates and deletes providers without leaking secrets', async () => {
    const { handler } = createHarness()
    const created = await createProvider(handler, 'saved')
    expect(created.status).toBe(201)
    const createdBody = await created.json() as any
    expect(createdBody.provider).toMatchObject({ id: 'saved', hasApiKey: true })
    expect(JSON.stringify(createdBody)).not.toContain('saved-secret')

    const listed = await (await route(handler, '/api/providers')).json() as any
    expect(listed.activeId).toBe('saved')
    expect(listed.providers[0]).toMatchObject({ id: 'saved', name: 'saved provider', hasApiKey: true })
    expect(listed.providers[0]).not.toHaveProperty('baseUrl')
    expect(listed.providers[0]).not.toHaveProperty('model')
    expect(JSON.stringify(listed)).not.toContain('saved-secret')

    const detail = await (await route(handler, '/providers/saved')).json() as any
    expect(detail.provider).toMatchObject({ id: 'saved', baseUrl: 'https://saved.example/v1', model: 'saved-model' })
    expect(JSON.stringify(detail)).not.toContain('saved-secret')

    const updated = await (await route(handler, '/api/providers/saved', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'updated provider' }),
    })).json() as any
    expect(updated.provider).toMatchObject({ id: 'saved', name: 'updated provider', hasApiKey: true })

    expect((await createProvider(handler, 'saved')).status).toBe(409)
    expect((await route(handler, '/providers/missing')).status).toBe(404)
    expect((await route(handler, '/providers/bad.id')).status).toBe(400)
    expect((await route(handler, '/providers', { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await route(handler, '/providers/saved', { method: 'DELETE' })).status).toBe(409)

    expect((await route(handler, '/providers/active/clear', { method: 'POST' })).status).toBe(200)
    expect(await (await route(handler, '/providers/saved', { method: 'DELETE' })).json()).toEqual({ ok: true })
  })

  test('reorders and enables provider candidates through every compatibility form', async () => {
    const { handler } = createHarness()
    for (const id of ['primary', 'backup', 'slow']) expect((await createProvider(handler, id)).status).toBe(201)

    const reordered = await (await route(handler, '/api/providers/reorder', {
      method: 'POST',
      body: JSON.stringify({ providerIds: ['primary', 'slow', 'backup'] }),
    })).json() as any
    expect(reordered.providers.map((provider: any) => provider.id)).toEqual(['primary', 'slow', 'backup'])
    expect(JSON.stringify(reordered)).not.toContain('slow-secret')

    const disabled = await (await route(handler, '/providers/primary/disable', { method: 'POST' })).json() as any
    expect(disabled.provider).toMatchObject({ id: 'primary', enabled: false })
    expect((await route(handler, '/providers/primary/activate', { method: 'POST' })).status).toBe(409)

    const patched = await (await route(handler, '/providers/backup/enabled', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })).json() as any
    expect(patched.provider).toMatchObject({ id: 'backup', enabled: false })

    const enabled = await (await route(handler, '/providers/primary/enable', { method: 'POST' })).json() as any
    expect(enabled.provider).toMatchObject({ id: 'primary', enabled: true })
    expect((await route(handler, '/providers/primary/activate', { method: 'POST' })).status).toBe(200)
  })

  test('tests saved and unsaved provider configurations through the injected upstream', async () => {
    const requestedUrls: string[] = []
    const fetchImpl: FetchLike = async (input) => {
      requestedUrls.push(String(input))
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\n`))
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const { handler } = createHarness(fetchImpl)
    await createProvider(handler, 'saved')

    const saved = await (await route(handler, '/providers/saved/test', { method: 'POST' })).json() as any
    expect(saved.result).toMatchObject({ ok: true, textSample: 'OK' })

    const unsaved = await (await route(handler, '/api/providers/test', {
      method: 'POST',
      body: JSON.stringify(providerInput('draft')),
    })).json() as any
    expect(unsaved.result).toMatchObject({ ok: true, textSample: 'OK' })
    expect(JSON.stringify([saved, unsaved])).not.toContain('saved-secret')
    expect(JSON.stringify([saved, unsaved])).not.toContain('draft-secret')
    expect(requestedUrls).toEqual([
      'https://saved.example/v1/chat/completions',
      'https://draft.example/v1/chat/completions',
    ])
  })

  test('reads and switches model status through both compatible prefixes', async () => {
    const { handler } = createHarness()
    expect((await route(handler, '/model')).status).toBe(503)
    await createProvider(handler, 'saved')

    const active = await route(handler, '/api/model')
    expect(active.status).toBe(200)
    expect(await active.json()).toMatchObject({ ok: true, activeId: 'saved', runtime: { providerId: 'saved' } })

    const cleared = await route(handler, '/model', { method: 'POST', body: JSON.stringify({ providerId: 'env' }) })
    expect(cleared.status).toBe(503)
    expect(await cleared.json()).toMatchObject({ ok: false, activeId: null, runtime: null })

    const restored = await route(handler, '/api/model', { method: 'PATCH', body: JSON.stringify({ id: 'saved' }) })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ ok: true, activeId: 'saved' })
    expect((await route(handler, '/model', { method: 'POST', body: JSON.stringify({ providerId: 'missing' }) })).status).toBe(404)
  })

  test('routes global and per-provider health clears with compatible errors', async () => {
    const { clearCalls, handler } = createHarness()
    await createProvider(handler, 'saved')

    const global = await route(handler, '/api/model/health/clear', {
      method: 'POST',
      body: JSON.stringify({ all: true }),
    })
    expect(global.status).toBe(200)
    expect(await global.json()).toMatchObject({ ok: true, cleared: 1 })

    const provider = await route(handler, '/api/providers/saved/clear-health', { method: 'POST' })
    expect(provider.status).toBe(200)
    expect(await provider.json()).toMatchObject({ ok: true, cleared: 1 })
    expect(clearCalls).toEqual([{ all: true }, { providerId: 'saved' }])

    expect((await route(handler, '/model/health/clear', { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await route(handler, '/providers/missing/clear-health', { method: 'POST' })).status).toBe(404)
  })
})
