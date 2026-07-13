// 会话归档 REST 边界：保持现有 POST 路径、错误结构和状态码。

import { SessionArchiveError, type SessionArchiveService } from '../services/sessionArchiveService'

interface SessionArchiveRouteDependencies {
  archive: Pick<SessionArchiveService, 'archive'>
}

export function createSessionArchiveRouteHandler(deps: SessionArchiveRouteDependencies) {
  return async function handleSessionArchiveRoute(url: URL, req: Request): Promise<Response | null> {
    const match = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{1,128})\/archive$/)
    if (!match || req.method !== 'POST') return null

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    try {
      return Response.json(await deps.archive.archive(match[1]!, body))
    } catch (err) {
      const status = err instanceof SessionArchiveError ? err.status : 500
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
    }
  }
}
