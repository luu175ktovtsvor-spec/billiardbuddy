// 插件管理 REST 边界：发现、启停和从 GitHub 安装插件。

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
      return Response.json({ plugins: await deps.list() })
    }

    if (req.method !== 'POST') return methodNotAllowed()
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    if (url.pathname === '/api/v1/agent/plugins/toggle') {
      return Response.json(await deps.setEnabled(body.name, body.enabled))
    }
    return Response.json(await deps.installFromGithub(body.repo))
  }
}
