// MCP 管理 REST 边界：状态、预设、工作区信任和本地配置写入。

import type { McpTrustStore } from '../../mcp/mcpTrust'
import { jsonError } from '../middleware/http'
import { stringOr } from '../requestParams'

interface McpRouteDependencies {
  presets: readonly unknown[]
  listStatus: (workspaceRoot: string | undefined) => Promise<unknown>
  trust: Pick<McpTrustStore, 'list' | 'trust' | 'revoke'>
  add: (body: Record<string, unknown>) => Promise<unknown>
  remove: (name: unknown) => Promise<unknown>
  setDisabled: (name: unknown, disabled: unknown) => Promise<unknown>
}

const MCP_ROUTE_PATHS = new Set([
  '/api/v1/agent/mcp',
  '/api/v1/agent/mcp/presets',
  '/api/v1/agent/mcp/trust',
  '/api/v1/agent/mcp/add',
  '/api/v1/agent/mcp/remove',
  '/api/v1/agent/mcp/toggle',
])

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createMcpRouteHandler(deps: McpRouteDependencies) {
  return async function handleMcpRoute(url: URL, req: Request): Promise<Response | null> {
    if (!MCP_ROUTE_PATHS.has(url.pathname)) return null

    if (url.pathname === '/api/v1/agent/mcp') {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json(await deps.listStatus(url.searchParams.get('workspaceRoot') ?? undefined))
    }

    if (url.pathname === '/api/v1/agent/mcp/presets') {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json({ presets: deps.presets })
    }

    if (url.pathname === '/api/v1/agent/mcp/trust') {
      if (req.method === 'GET') return Response.json({ approved_workspace_roots: deps.trust.list() })
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const root = stringOr(body.workspaceRoot ?? body.working_dir, '')
      if (!root) return jsonError('缺少 workspaceRoot', 400)
      if (req.method === 'DELETE') {
        deps.trust.revoke(root)
        return Response.json({ ok: true, trusted: false, approved_workspace_roots: deps.trust.list() })
      }
      if (req.method !== 'POST') return methodNotAllowed()
      deps.trust.trust(root)
      return Response.json({ ok: true, trusted: true, approved_workspace_roots: deps.trust.list() })
    }

    if (req.method !== 'POST') return methodNotAllowed()
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (url.pathname === '/api/v1/agent/mcp/add') return Response.json(await deps.add(body))
    if (url.pathname === '/api/v1/agent/mcp/remove') return Response.json(await deps.remove(body.name))
    return Response.json(await deps.setDisabled(body.name, body.disabled))
  }
}
