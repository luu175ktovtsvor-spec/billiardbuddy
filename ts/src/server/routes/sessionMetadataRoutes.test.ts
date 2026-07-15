import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from '../services/sessionService'
import { createSessionMetadataRouteHandler } from './sessionMetadataRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'session-metadata-routes-'))
  roots.push(root)
  const sessions = new SessionService(root)
  const handler = createSessionMetadataRouteHandler({ sessions, defaultWorkspaceRoot: () => '/default/workspace' })
  return { handler, sessions }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createSessionMetadataRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('session metadata routes', () => {
  test('ignores unrelated paths and session content operations', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example'), request('/sessions/example'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example/events'), request('/sessions/example/events'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example/fork'), request('/sessions/example/fork'))).toBeNull()
  })

  test('creates, lists, filters and aggregates project sessions', async () => {
    const { handler } = createHarness()
    for (const id of ['project-1', 'project-2']) {
      const created = await (await route(handler, '/sessions', {
        method: 'POST',
        body: JSON.stringify({ id, title: id, workspaceRoot: '/workspace/project' }),
      })).json() as { session: Record<string, unknown> }
      expect(created.session).toMatchObject({ id, workspaceRoot: '/workspace/project' })
    }

    const filtered = await (await route(handler, `/sessions?workspaceRoot=${encodeURIComponent('/workspace/project')}`)).json() as { sessions: Array<{ id: string }> }
    expect(filtered.sessions.map(session => session.id).sort()).toEqual(['project-1', 'project-2'])
    const projects = await (await route(handler, '/sessions/projects?limit=20')).json() as { projects: Array<Record<string, unknown>> }
    expect(projects.projects[0]).toMatchObject({ workspaceRoot: '/workspace/project', sessionCount: 2 })

    const fallback = await (await route(handler, '/sessions', { method: 'POST', body: '{bad' })).json() as { session: Record<string, unknown> }
    expect(fallback.session).toMatchObject({ workspaceRoot: '/default/workspace', title: '新会话' })
  })

  test('patches and deletes existing sessions while preserving missing-session errors', async () => {
    const { handler, sessions } = createHarness()
    await sessions.create({ id: 'managed', title: '原始标题', workspaceRoot: '/workspace/project' })

    const patched = await (await route(handler, '/sessions/managed', {
      method: 'PATCH',
      body: JSON.stringify({ title: '  新标题  ', pinned: true, archived: true }),
    })).json() as { session: Record<string, unknown> }
    expect(patched.session).toMatchObject({ title: '新标题', pinned: true, archived: true })

    const keptTitle = await (await route(handler, '/sessions/managed', {
      method: 'PATCH',
      body: JSON.stringify({ title: '   ', pinned: false }),
    })).json() as { session: Record<string, unknown> }
    expect(keptTitle.session).toMatchObject({ title: '新标题', pinned: false, archived: true })

    expect(await (await route(handler, '/sessions/managed', { method: 'DELETE' })).json()).toEqual({ ok: true })
    expect((await route(handler, '/sessions/managed', { method: 'DELETE' })).status).toBe(404)
    expect((await route(handler, '/sessions/missing', { method: 'PATCH', body: '{}' })).status).toBe(404)
  })

  test('refuses to archive or permanently delete a running session', async () => {
    const { handler, sessions } = createHarness()
    await sessions.create({ id: 'running', title: '执行中', workspaceRoot: '/workspace/project' })
    await sessions.touch('running', { status: 'running' })

    expect((await route(handler, '/sessions/running', {
      method: 'PATCH',
      body: JSON.stringify({ archived: true }),
    })).status).toBe(409)
    expect((await route(handler, '/sessions/running', { method: 'DELETE' })).status).toBe(409)
    expect(await sessions.get('running')).toMatchObject({ status: 'running' })
  })

  test('forks a session and keeps malformed or missing sources compatible', async () => {
    const { handler, sessions } = createHarness()
    await sessions.create({ id: 'source', title: '源会话', workspaceRoot: '/workspace/project' })

    const forked = await (await route(handler, '/sessions/source/fork', {
      method: 'POST',
      body: JSON.stringify({ title: '副本' }),
    })).json() as { session: Record<string, unknown> }
    expect(forked.session).toMatchObject({ title: '副本', workspaceRoot: '/workspace/project' })
    expect(forked.session.id).not.toBe('source')

    const defaultTitle = await (await route(handler, '/sessions/source/fork', { method: 'POST', body: '{bad' })).json() as { session: Record<string, unknown> }
    expect(defaultTitle.session.title).toBe('源会话(副本)')
    expect((await route(handler, '/sessions/missing/fork', { method: 'POST', body: '{}' })).status).toBe(404)
  })
})
