import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopDataStore } from '../services/desktopDataStore'
import { StoreDocsService } from '../services/storeDocsService'
import { createStoreDocsRouteHandler } from './storeDocsRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'store-docs-routes-'))
  roots.push(root)
  const docsDir = join(root, 'docs')
  mkdirSync(docsDir)
  const store = new DesktopDataStore(root)
  const service = new StoreDocsService(store, root)
  const handler = createStoreDocsRouteHandler({ store, service })
  return { docsDir, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createStoreDocsRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('store docs routes', () => {
  test('ignores unrelated and unknown store-doc paths', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/api/v1/store-docs/unknown'), request('/api/v1/store-docs/unknown'))).toBeNull()
  })

  test('indexes, reads and clears a selected local document folder', async () => {
    const { docsDir, handler } = createHarness()
    writeFileSync(join(docsDir, '价目表.txt'), '黄金档台费 68 元一小时。')
    writeFileSync(join(docsDir, '排班.csv'), '姓名,班次\n小王,周五晚班\n')

    const indexed = await (await route(handler, '/api/v1/store-docs', {
      method: 'PUT',
      body: JSON.stringify({ folder_path: docsDir }),
    })).json() as Record<string, unknown>
    expect(indexed).toMatchObject({ folder_path: docsDir, status: 'ready', indexed_file_count: 2 })

    expect(await (await route(handler, '/api/v1/store-docs')).json()).toMatchObject(indexed)
    expect(await (await route(handler, '/api/v1/store-docs', { method: 'DELETE' })).json()).toMatchObject({
      folder_path: null,
      status: 'idle',
      indexed_file_count: 0,
    })
  })

  test('reindexes and searches with legacy path and paths scopes', async () => {
    const { docsDir, handler } = createHarness()
    writeFileSync(join(docsDir, '价目表.txt'), '黄金档台费 68 元一小时。会员充值满 1000 送 120。')
    writeFileSync(join(docsDir, '排班.txt'), '周五晚班由小王负责。')
    await route(handler, '/api/v1/store-docs', {
      method: 'PUT',
      body: JSON.stringify({ folder_path: docsDir }),
    })

    expect(await (await route(handler, '/api/v1/store-docs/reindex', { method: 'POST' })).json()).toMatchObject({ status: 'ready' })
    const hits = await (await route(handler, '/api/v1/store-docs/search', {
      method: 'POST',
      body: JSON.stringify({ query: '黄金档台费', top: 3 }),
    })).json() as { hits: Array<Record<string, unknown>> }
    expect(hits.hits[0]).toMatchObject({ file_name: '价目表.txt' })

    for (const scope of [{ path: '排班.txt' }, { paths: ['排班.txt'] }]) {
      const scoped = await (await route(handler, '/api/v1/store-docs/search', {
        method: 'POST',
        body: JSON.stringify({ query: '黄金档台费', top: 3, ...scope }),
      })).json() as { hits: unknown[] }
      expect(scoped.hits).toEqual([])
    }
  })

  test('preserves malformed JSON fallbacks and method errors', async () => {
    const { handler } = createHarness()
    expect(await (await route(handler, '/api/v1/store-docs', { method: 'PUT', body: '{bad' })).json()).toMatchObject({ status: 'idle' })
    expect(await (await route(handler, '/api/v1/store-docs/search', { method: 'POST', body: '{bad' })).json()).toEqual({ hits: [] })
    expect((await route(handler, '/api/v1/store-docs', { method: 'POST', body: '{}' })).status).toBe(405)
    expect((await route(handler, '/api/v1/store-docs/reindex')).status).toBe(405)
    expect((await route(handler, '/api/v1/store-docs/search')).status).toBe(405)
  })
})
