// 会话回退 REST 边界：轮次 checkpoint 查询、dry-run 预览与正式恢复。

import type { SessionService } from '../services/sessionService'
import type { RewindTargetSelector, SessionRewindService } from '../services/sessionRewindService'

interface SessionRewindRouteDependencies {
  sessions: Pick<SessionService, 'get'>
  rewind: Pick<SessionRewindService, 'listTurnCheckpoints' | 'previewRewind' | 'executeRewind'>
}

export function createSessionRewindRouteHandler(deps: SessionRewindRouteDependencies) {
  return async function handleSessionRewindRoute(url: URL, req: Request): Promise<Response | null> {
    const match = url.pathname.match(/^(?:\/api)?\/sessions\/([A-Za-z0-9_-]{1,128})\/(turn-checkpoints|rewind)$/)
    if (!match) return null

    const id = match[1]!
    const action = match[2]
    const session = await deps.sessions.get(id)
    if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })

    if (action === 'turn-checkpoints') {
      if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      try {
        return Response.json({ checkpoints: await deps.rewind.listTurnCheckpoints(id) })
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
      }
    }

    if (action === 'rewind' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const selector: RewindTargetSelector = {
        targetUserMessageId: typeof body.targetUserMessageId === 'string' ? body.targetUserMessageId : undefined,
        userMessageIndex: typeof body.userMessageIndex === 'number' ? body.userMessageIndex : undefined,
        expectedContent: typeof body.expectedContent === 'string' ? body.expectedContent : undefined,
      }
      if (!selector.targetUserMessageId && !Number.isInteger(selector.userMessageIndex)) {
        return Response.json({ ok: false, error: 'targetUserMessageId or userMessageIndex is required' }, { status: 400 })
      }
      try {
        const result = body.dryRun === true
          ? await deps.rewind.previewRewind(id, selector)
          : await deps.rewind.executeRewind(id, selector)
        return Response.json(result)
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
      }
    }

    return new Response('Method not allowed', { status: 405 })
  }
}
