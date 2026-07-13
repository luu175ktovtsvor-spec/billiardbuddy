import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { UserSettingsStore } from '../services/userSettings'
import { createWorkspaceRouteHandler } from './workspaceRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-routes-'))
  roots.push(root)
  const stateRoot = join(root, 'state')
  const defaultRoot = join(root, 'default')
  mkdirSync(defaultRoot, { recursive: true })
  const settings = new UserSettingsStore(stateRoot)
  const handler = createWorkspaceRouteHandler({ settings, defaultWorkspaceRoot: () => defaultRoot })
  return { root, stateRoot, defaultRoot, settings, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createWorkspaceRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('workspace routes', () => {
  test('ignores unrelated paths and preserves method errors', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/api/v1/workspaces'), request('/api/v1/workspaces'))).toBeNull()
    expect((await route(handler, '/api/v1/workspace', { method: 'PUT' })).status).toBe(405)
    expect((await route(handler, '/api/v1/workspace/create')).status).toBe(405)
    expect((await route(handler, '/api/v1/workspace/base')).status).toBe(405)
  })

  test('returns defaults, persists a selected directory and falls back when it disappears', async () => {
    const { root, stateRoot, defaultRoot, handler } = createHarness()
    const initial = await (await route(handler, '/api/v1/workspace')).json() as any
    expect(initial).toEqual({ default: defaultRoot, base: defaultRoot, persisted: null, current: defaultRoot, exists: true })

    const picked = join(root, 'picked')
    const selected = await (await route(handler, '/api/v1/workspace', {
      method: 'POST',
      body: JSON.stringify({ path: picked }),
    })).json() as any
    expect(selected).toMatchObject({ persisted: picked, current: picked, exists: true })
    expect(existsSync(picked)).toBe(true)
    expect((await new UserSettingsStore(stateRoot).get()).lastWorkspaceRoot).toBe(picked)

    rmSync(picked, { recursive: true, force: true })
    const stale = await (await route(handler, '/api/v1/workspace')).json() as any
    expect(stale).toMatchObject({ persisted: picked, current: defaultRoot, exists: true })
  })

  test('normalizes relative selections and rejects empty or non-directory paths', async () => {
    const { root, handler } = createHarness()
    expect((await route(handler, '/api/v1/workspace', { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await route(handler, '/api/v1/workspace', { method: 'POST', body: '{bad' })).status).toBe(400)

    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'file', 'utf8')
    expect((await route(handler, '/api/v1/workspace', {
      method: 'POST',
      body: JSON.stringify({ path: file }),
    })).status).toBe(400)

    const target = join(root, 'relative-target')
    const relativeTarget = relative(process.cwd(), target)
    const selected = await (await route(handler, '/api/v1/workspace', {
      method: 'POST',
      body: JSON.stringify({ path: relativeTarget }),
    })).json() as any
    expect(selected.current).toBe(target)
    expect(existsSync(target)).toBe(true)
  })

  test('creates and persists the default workspace base directory', async () => {
    const { root, settings, handler } = createHarness()
    expect((await route(handler, '/api/v1/workspace/base', { method: 'POST', body: '{}' })).status).toBe(400)

    const file = join(root, 'base-file')
    writeFileSync(file, 'file', 'utf8')
    expect((await route(handler, '/api/v1/workspace/base', {
      method: 'POST',
      body: JSON.stringify({ path: file }),
    })).status).toBe(400)

    const base = join(root, 'workspace-base')
    const response = await route(handler, '/api/v1/workspace/base', {
      method: 'POST',
      body: JSON.stringify({ path: base }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ base, exists: true })
    expect(existsSync(base)).toBe(true)
    expect((await settings.get()).workspaceBaseDir).toBe(base)
  })

  test('creates initialized workspaces, suffixes duplicates and blocks unsafe names', async () => {
    const { root, settings, handler } = createHarness()
    const base = join(root, 'workspace-base')
    await route(handler, '/api/v1/workspace/base', {
      method: 'POST',
      body: JSON.stringify({ path: base }),
    })

    const first = await (await route(handler, '/api/v1/workspace/create', {
      method: 'POST',
      body: JSON.stringify({ name: '新店' }),
    })).json() as any
    expect(first).toMatchObject({ path: join(base, '新店'), current: join(base, '新店') })
    expect(existsSync(join(first.path, 'BILLIARDBUDDY.md'))).toBe(true)
    expect(existsSync(join(first.path, '.billiardbuddy'))).toBe(true)
    expect((await settings.get()).lastWorkspaceRoot).toBe(first.path)

    const second = await (await route(handler, '/api/v1/workspace/create', {
      method: 'POST',
      body: JSON.stringify({ name: '新店' }),
    })).json() as any
    expect(second.path).toBe(join(base, '新店-2'))

    expect((await route(handler, '/api/v1/workspace/create', {
      method: 'POST',
      body: JSON.stringify({ name: '../逃逸' }),
    })).status).toBe(400)
    expect((await route(handler, '/api/v1/workspace/create', { method: 'POST', body: '{bad' })).status).toBe(400)

    const unusableBase = join(root, 'unusable-base')
    writeFileSync(unusableBase, 'file', 'utf8')
    await settings.update({ workspaceBaseDir: unusableBase })
    expect((await route(handler, '/api/v1/workspace/create', {
      method: 'POST',
      body: JSON.stringify({ name: '失败目录' }),
    })).status).toBe(500)
  })
})
