import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textBlock } from '../../types/message'
import { SessionService, TurnRegistry } from '../services/sessionService'
import { createSessionActivityRouteHandler } from './sessionActivityRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'session-activity-routes-'))
  roots.push(root)
  const sessions = new SessionService(root)
  const turns = new TurnRegistry()
  const handler = createSessionActivityRouteHandler({ sessions, turns })
  return { handler, sessions, turns }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createSessionActivityRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('session activity routes', () => {
  test('ignores unrelated, archive, rewind and unsupported method routes', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/bad.id'), request('/sessions/bad.id'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example/archive'), request('/sessions/example/archive', { method: 'POST' }))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example/rewind'), request('/sessions/example/rewind', { method: 'POST' }))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example/events'), request('/sessions/example/events', { method: 'POST' }))).toBeNull()
  })

  test('returns session details with optional messages and events', async () => {
    const { handler, sessions } = createHarness()
    const session = await sessions.create({ id: 'details', title: '详情', workspaceRoot: '/workspace/project' })
    await sessions.transcript(session.id, session.workspaceRoot).save([
      { role: 'user', content: [textBlock('你好')] },
      { role: 'assistant', content: [textBlock('完成')] },
    ])
    await sessions.appendEvent(session.id, { type: 'user_prompt', text: '你好' })

    const full = await (await route(handler, '/sessions/details?includeEvents=1')).json() as Record<string, unknown>
    expect(full.session).toMatchObject({ id: 'details', title: '详情' })
    expect(full.messages).toHaveLength(2)
    expect(full.events).toHaveLength(1)

    const metaOnly = await (await route(handler, '/sessions/details?includeMessages=0')).json() as Record<string, unknown>
    expect(metaOnly.session).toMatchObject({ id: 'details' })
    expect('messages' in metaOnly).toBe(false)
    expect('events' in metaOnly).toBe(false)
    expect((await route(handler, '/sessions/missing')).status).toBe(404)
  })

  test('paginates transcript messages and preserves missing-session errors', async () => {
    const { handler, sessions } = createHarness()
    const session = await sessions.create({ id: 'messages', workspaceRoot: '/workspace/project' })
    await sessions.transcript(session.id, session.workspaceRoot).save([
      { role: 'user', content: [textBlock('第一条')] },
      { role: 'assistant', content: [textBlock('第二条')] },
      { role: 'user', content: [textBlock('第三条')] },
    ])

    const first = await (await route(handler, '/sessions/messages/messages?limit=2')).json() as any
    expect(first.messages.map((record: any) => record.seq)).toEqual([1, 2])
    expect(first).toMatchObject({ nextSeq: 2, hasMore: true })

    const second = await (await route(handler, '/sessions/messages/messages?after=2&limit=10')).json() as any
    expect(second.messages.map((record: any) => record.seq)).toEqual([3])
    expect(second).toMatchObject({ nextSeq: 3, hasMore: false })
    expect((await route(handler, '/sessions/missing/messages')).status).toBe(404)
  })

  test('filters event cursors and emits the existing SSE replay format', async () => {
    const { handler, sessions } = createHarness()
    await sessions.create({ id: 'events', workspaceRoot: '/workspace/project' })
    await sessions.appendEvent('events', { type: 'user_prompt', text: '开始' })
    await sessions.appendEvent('events', { type: 'context_note', text: '处理中' })
    await sessions.appendEvent('events', { type: 'done' })

    const after = await (await route(handler, '/sessions/events/events?after=1&limit=1')).json() as any
    expect(after.events.map((record: any) => record.event.type)).toEqual(['context_note'])
    expect(after.nextSeq).toBe(2)

    const empty = await (await route(handler, '/sessions/events/events?after=99')).json() as any
    expect(empty).toEqual({ events: [], nextSeq: 99 })

    const replay = await route(handler, '/sessions/events/events?after=1&format=sse')
    expect(replay.headers.get('content-type')).toContain('text/event-stream')
    expect(replay.headers.get('cache-control')).toBe('no-cache')
    expect(await replay.text()).toBe(
      'id: 2\nevent: context_note\ndata: {"type":"context_note","text":"处理中"}\n\n' +
      'id: 3\nevent: done\ndata: {"type":"done"}\n\n',
    )
    expect((await route(handler, '/sessions/missing/events')).status).toBe(404)
  })

  test('interrupts a running turn once and records the existing status and context event', async () => {
    const { handler, sessions, turns } = createHarness()
    await sessions.create({ id: 'running', workspaceRoot: '/workspace/project' })
    const controller = turns.start('running')

    const interrupted = await (await route(handler, '/sessions/running/interrupt', { method: 'POST' })).json()
    expect(interrupted).toEqual({ ok: true, interrupted: true })
    expect(controller.signal.aborted).toBe(true)
    expect(await sessions.get('running')).toMatchObject({ status: 'interrupted' })
    expect((await sessions.loadEvents('running')).map(record => record.event)).toEqual([
      { type: 'context_note', text: '任务已请求中断' },
    ])

    const repeated = await (await route(handler, '/sessions/running/interrupt', { method: 'POST' })).json()
    expect(repeated).toEqual({ ok: true, interrupted: false })
    expect((await sessions.loadEvents('running')).map(record => record.event)).toHaveLength(1)

    const missing = await (await route(handler, '/sessions/missing/interrupt', { method: 'POST' })).json()
    expect(missing).toEqual({ ok: true, interrupted: false })
    expect(await sessions.get('missing')).toBeNull()
  })
})
