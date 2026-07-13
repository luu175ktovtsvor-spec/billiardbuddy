// 插件管理 REST 边界：发现、启停和从 GitHub 安装插件。

import {
  extensionMutationResultSchema,
  pluginInstallRequestSchema,
  pluginListResponseSchema,
  pluginToggleRequestSchema,
} from '../../../shared/contracts/extensions'
import { jsonError } from '../middleware/http'

interface PluginRouteDependencies {
  list: () => Promise<unknown[]>
  setEnabled: (name: unknown, enabled: unknown) => Promise<unknown>
  installFromGithub: (repo: unknown) => Promise<unknown>
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createPluginRouteHandler(deps: PluginRouteDependencies) {
  return async function handlePluginRoute(url: URL, req: Request): Promise<Response | null> {
    if (
      url.pathname !== '/api/v1/agent/plugins' &&
      url.pathname !== '/api/v1/agent/plugins/toggle' &&
      url.pathname !== '/api/v1/agent/plugins/install'
    ) return null

    if (url.pathname === '/api/v1/agent/plugins') {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json(pluginListResponseSchema.parse({ plugins: await deps.list() }))
    }

    if (req.method !== 'POST') return methodNotAllowed()
    if (url.pathname === '/api/v1/agent/plugins/toggle') {
      const body = pluginToggleRequestSchema.safeParse(await req.json().catch(() => null))
      if (!body.success) return jsonError('插件启停请求格式不正确', 400)
      return Response.json(extensionMutationResultSchema.parse(await deps.setEnabled(body.data.name, body.data.enabled)))
    }
    const body = pluginInstallRequestSchema.safeParse(await req.json().catch(() => null))
    if (!body.success) return jsonError('插件安装请求格式不正确', 400)
    return Response.json(extensionMutationResultSchema.parse(await deps.installFromGithub(body.data.repo)))
  }
}
