// 会话元数据 REST 边界：项目聚合、列表、创建、管理与 fork。

import type { SessionService } from '../services/sessionService'
import { jsonDetailError } from '../middleware/http'
import { numberFrom, stringOr } from '../requestParams'

interface SessionMetadataRouteDependencies {
  sessions: Pick<SessionService, 'recentProjects' | 'list' | 'create' | 'get' | 'remove' | 'touch' | 'fork'>
  defaultWorkspaceRoot: () => string
}

export function createSessionMetadataRouteHandler(deps: SessionMetadataRouteDependencies) {
  return async function handleSessionMetadataRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/sessions')) return null

    if (url.pathname === '/sessions/projects' && req.method === 'GET') {
      const limit = numberFrom(url.searchParams.get('limit') ?? undefined, 20)
      return Response.json({ projects: await deps.sessions.recentProjects(limit) })
    }

    if (url.pathname === '/sessions') {
      if (req.method === 'GET') {
        const workspaceRoot = url.searchParams.get('workspaceRoot') ?? undefined
        return Response.json({ sessions: await deps.sessions.list(workspaceRoot ? { workspaceRoot } : undefined) })
      }
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const session = await deps.sessions.create({
          id: typeof body.id === 'string' ? body.id : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          workspaceRoot: stringOr(body.workspaceRoot, deps.defaultWorkspaceRoot()),
        })
        return Response.json({ session })
      }
      return null
    }

    const sessionIdMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
    if (sessionIdMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const id = decodeURIComponent(sessionIdMatch[1]!)
      const existing = await deps.sessions.get(id).catch(() => null)
      if (!existing) return jsonDetailError('session not found', 404)
      if (req.method === 'DELETE') {
        if (existing.status === 'running') return jsonDetailError('session is running', 409)
        return Response.json({ ok: await deps.sessions.remove(id) })
      }
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (body.archived === true && existing.status === 'running') return jsonDetailError('session is running', 409)
      const patch: { title?: string; pinned?: boolean; archived?: boolean } = {}
      if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim()
      if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
      if (typeof body.archived === 'boolean') patch.archived = body.archived
      return Response.json({ session: await deps.sessions.touch(id, patch) })
    }

    const sessionForkMatch = url.pathname.match(/^\/sessions\/([^/]+)\/fork$/)
    if (sessionForkMatch && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      try {
        const session = await deps.sessions.fork(decodeURIComponent(sessionForkMatch[1]!), {
          title: typeof body.title === 'string' ? body.title : undefined,
        })
        return Response.json({ session })
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
      }
    }

    return null
  }
}
