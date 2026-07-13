import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textBlock, type Message } from '../../types/message'
import type { ToolContext } from '../../tools/Tool'
import { recordFileSnapshot } from '../../tools/fileHistory'
import { Workspace } from '../../workspace/workspace'
import { SessionService, TurnRegistry } from '../services/sessionService'
import { SessionRewindService } from '../services/sessionRewindService'
import { createSessionRewindRouteHandler } from './sessionRewindRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'session-rewind-routes-'))
  roots.push(root)
  const sessions = new SessionService(root)
  const turns = new TurnRegistry()
  const rewind = new SessionRewindService(sessions, turns, root)
  const handler = createSessionRewindRouteHandler({ sessions, rewind })
  return { root, sessions, handler }
}

async function createSeededHarness() {
  const harness = createHarness()
  const { root, sessions } = harness
  await sessions.create({ id: 'rw-route', title: '回退路由测试', workspaceRoot: root })
  const transcript = sessions.transcript('rw-route', root)

  const u1: Message = { role: 'user', content: [textBlock('u1')] }
  const a1: Message = { role: 'assistant', content: [textBlock('a1')], uuid: 'route-msg-a1' }
  const u2: Message = { role: 'user', content: [textBlock('u2')] }
  const a2: Message = { role: 'assistant', content: [textBlock('a2')], uuid: 'route-msg-a2' }
  await transcript.append([u1, a1, u2, a2])

  const ctx1: ToolContext = { workspace: new Workspace(root), conversationId: 'rw-route', stateRoot: root, messageId: 'route-msg-a1' }
  await recordFileSnapshot(ctx1, 'note.txt', join(root, 'note.txt'), 'write_file')
  writeFileSync(join(root, 'note.txt'), 'v1\n')
  const ctx2: ToolContext = { ...ctx1, messageId: 'route-msg-a2' }
  await recordFileSnapshot(ctx2, 'note.txt', join(root, 'note.txt'), 'write_file')
  writeFileSync(join(root, 'note.txt'), 'v2\n')

  const history = await transcript.loadFullHistoryStamped()
  const targetUserMessageId = history.find(record => (record.message.content[0] as { text?: string })?.text === 'u2')!.uuid
  return { ...harness, targetUserMessageId }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createSessionRewindRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('session rewind routes', () => {
  test('ignores unrelated, archive and invalid session paths', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example/archive'), request('/sessions/example/archive', { method: 'POST' }))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/bad.id/rewind'), request('/sessions/bad.id/rewind', { method: 'POST' }))).toBeNull()
  })

  test('preserves missing-session, method and malformed selector errors', async () => {
    const { handler, sessions, root } = createHarness()
    expect((await route(handler, '/sessions/missing/turn-checkpoints')).status).toBe(404)
    expect((await route(handler, '/api/sessions/missing/turn-checkpoints')).status).toBe(404)
    expect((await route(handler, '/api/sessions/missing/rewind', { method: 'POST', body: JSON.stringify({ userMessageIndex: 0 }) })).status).toBe(404)

    await sessions.create({ id: 'empty', workspaceRoot: root })
    expect((await route(handler, '/sessions/empty/turn-checkpoints', { method: 'POST' })).status).toBe(405)
    expect((await route(handler, '/sessions/empty/rewind')).status).toBe(405)
    expect((await route(handler, '/sessions/empty/rewind', { method: 'POST', body: '{bad' })).status).toBe(400)
  })

  test('lists both compatible checkpoint paths, previews without side effects and executes a real rewind', async () => {
    const { handler, sessions, root, targetUserMessageId } = await createSeededHarness()

    const checkpoints = await (await route(handler, '/sessions/rw-route/turn-checkpoints')).json() as any
    expect(checkpoints.checkpoints).toHaveLength(2)
    expect(checkpoints.checkpoints[0].code.filesChanged).toEqual([join(root, 'note.txt')])

    const checkpointsApi = await (await route(handler, '/api/sessions/rw-route/turn-checkpoints')).json() as any
    expect(checkpointsApi.checkpoints).toHaveLength(2)

    const preview = await (await route(handler, '/api/sessions/rw-route/rewind', {
      method: 'POST',
      body: JSON.stringify({ targetUserMessageId, dryRun: true }),
    })).json() as any
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([join(root, 'note.txt')])
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v2\n')

    const executed = await (await route(handler, '/sessions/rw-route/rewind', {
      method: 'POST',
      body: JSON.stringify({ targetUserMessageId }),
    })).json() as any
    expect(executed.conversation.removedMessageIds).toHaveLength(2)
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v1\n')
    expect(await sessions.transcript('rw-route', root).load()).toHaveLength(2)
  })
})
