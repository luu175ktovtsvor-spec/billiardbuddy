import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from '../../harness/fakeModel'
import { clearInvokedSkills } from '../../skills/invokedSkills'
import { userText } from '../../types/message'
import type { ModelStepInput } from '../../types/model'
import { SessionArchiveError, SessionArchiveService } from '../services/sessionArchiveService'
import { SessionService } from '../services/sessionService'
import { createSessionArchiveRouteHandler } from './sessionArchiveRoutes'

const roots: string[] = []

afterEach(() => {
  clearInvokedSkills()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness(options: { resolverError?: Error; summaryError?: Error } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'session-archive-routes-'))
  roots.push(root)
  const sessions = new SessionService(root)
  const model = options.summaryError
    ? {
        received: [] as ModelStepInput[],
        async step(input: ModelStepInput): Promise<never> {
          this.received.push(input)
          throw options.summaryError
        },
      }
    : scriptedModel([{ kind: 'final', text: '旧对话摘要' }])
  const archive = new SessionArchiveService({
    sessions,
    archiveRoot: join(root, 'transcript-archives'),
    resolveModel: async () => {
      if (options.resolverError) throw options.resolverError
      return model
    },
  })
  const handler = createSessionArchiveRouteHandler({ archive })
  return { root, sessions, model, archive, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createSessionArchiveRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('session archive routes', () => {
  test('ignores unrelated, invalid-id and non-POST paths', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/bad.id/archive'), request('/sessions/bad.id/archive', { method: 'POST' }))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/sessions/example/archive'), request('/sessions/example/archive'))).toBeNull()
  })

  test('maps missing, running and provider setup failures to the existing status codes', async () => {
    const missing = createHarness()
    expect((await route(missing.handler, '/sessions/missing/archive', { method: 'POST', body: '{}' })).status).toBe(404)

    const running = createHarness()
    await running.sessions.create({ id: 'running', workspaceRoot: running.root })
    await running.sessions.touch('running', { status: 'running' })
    expect((await route(running.handler, '/sessions/running/archive', { method: 'POST', body: '{}' })).status).toBe(409)
    expect(running.model.received).toHaveLength(0)

    const unavailable = createHarness({ resolverError: new SessionArchiveError('model provider not configured', 503) })
    await unavailable.sessions.create({ id: 'unavailable', workspaceRoot: unavailable.root })
    const response = await route(unavailable.handler, '/sessions/unavailable/archive', { method: 'POST', body: '{}' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'model provider not configured' })
  })

  test('returns archived false without writing when the transcript is too short or summary fails', async () => {
    const short = createHarness()
    await short.sessions.create({ id: 'short', workspaceRoot: short.root })
    await short.sessions.transcript('short', short.root).save([userText('只有一条')])
    const shortBody = await (await route(short.handler, '/sessions/short/archive', { method: 'POST', body: '{bad' })).json() as any
    expect(shortBody).toEqual({ ok: false, archived: false, reason: 'not enough transcript messages to archive', messages: 1 })
    expect(existsSync(join(short.root, 'transcript-archives'))).toBe(false)

    const failed = createHarness({ summaryError: new Error('model failed') })
    await failed.sessions.create({ id: 'failed', workspaceRoot: failed.root })
    await failed.sessions.transcript('failed', failed.root).save([userText('旧 1'), userText('旧 2'), userText('最近')])
    const before = await failed.sessions.loadTranscript('failed')
    const response = await route(failed.handler, '/sessions/failed/archive', { method: 'POST', body: JSON.stringify({ keepRecentMessages: 1 }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, archived: false, reason: 'not enough transcript messages to archive', messages: 3 })
    expect(await failed.sessions.loadTranscript('failed')).toEqual(before)
    expect(existsSync(join(failed.root, 'transcript-archives'))).toBe(false)
  })

  test('backs up the original JSONL and saves the summary plus recent messages', async () => {
    const { root, sessions, model, handler } = createHarness()
    await sessions.create({ id: 'arch1', title: '归档会话', workspaceRoot: root })
    await sessions.transcript('arch1', root).save([
      userText('旧消息 1'),
      userText('旧消息 2'),
      userText('旧消息 3'),
      userText('旧消息 4'),
      userText('最近消息'),
    ])

    const response = await route(handler, '/sessions/arch1/archive', {
      method: 'POST',
      body: JSON.stringify({ keep_recent_messages: 1, min_old_messages: 1 }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({ ok: true, archived: true, beforeMessages: 5, afterMessages: 2 })
    expect(existsSync(body.archivePath)).toBe(true)
    expect(readFileSync(body.archivePath, 'utf8')).toContain('旧消息 1')

    const messages = await sessions.loadTranscript('arch1')
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages[0])).toContain('旧对话摘要')
    expect(JSON.stringify(messages[1])).toContain('最近消息')
    expect(await sessions.get('arch1')).toMatchObject({ status: 'idle' })
    expect(model.received).toHaveLength(1)
  })
})
