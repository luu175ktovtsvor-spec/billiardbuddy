// 会话活动 REST 边界：详情、消息分页、事件回放与运行中断。

import type { SessionService, TurnRegistry } from '../services/sessionService'
import { sseReplayLine } from '../sse'

interface SessionActivityRouteDependencies {
  sessions: Pick<SessionService, 'get' | 'loadTranscript' | 'loadTranscriptPage' | 'loadEvents' | 'touch' | 'appendEvent'>
  turns: Pick<TurnRegistry, 'interrupt'>
}

export function createSessionActivityRouteHandler(deps: SessionActivityRouteDependencies) {
  return async function handleSessionActivityRoute(url: URL, req: Request): Promise<Response | null> {
    const match = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/(interrupt|events|messages))?$/)
    if (!match) return null

    const id = match[1]!
    const action = match[2]
    if (!action && req.method === 'GET') {
      const session = await deps.sessions.get(id)
      if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
      const includeEvents = url.searchParams.get('includeEvents') === '1'
      const includeMessages = url.searchParams.get('includeMessages') !== '0'
      return Response.json({
        session,
        ...(includeMessages ? { messages: await deps.sessions.loadTranscript(id) } : {}),
        ...(includeEvents ? { events: await deps.sessions.loadEvents(id, { limit: 100 }) } : {}),
      })
    }

    if (action === 'messages' && req.method === 'GET') {
      const session = await deps.sessions.get(id)
      if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
      return Response.json(await deps.sessions.loadTranscriptPage(id, { after, limit }))
    }

    if (action === 'events' && req.method === 'GET') {
      const session = await deps.sessions.get(id)
      if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
      const events = await deps.sessions.loadEvents(id, { after, limit })
      if (url.searchParams.get('format') === 'sse') {
        const body = events.map(record => sseReplayLine(record.seq, record.event)).join('')
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }
      return Response.json({
        events,
        nextSeq: events.at(-1)?.seq ?? (Number.isFinite(after) ? Math.max(0, after) : 0),
      })
    }

    if (action === 'interrupt' && req.method === 'POST') {
      const interrupted = deps.turns.interrupt(id)
      if (interrupted) {
        await deps.sessions.touch(id, { status: 'interrupted' })
        await deps.sessions.appendEvent(id, { type: 'context_note', text: '任务已请求中断' }).catch(() => undefined)
      }
      return Response.json({ ok: true, interrupted })
    }

    return null
  }
}
