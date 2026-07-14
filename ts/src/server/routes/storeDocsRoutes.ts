// 门店资料 REST 边界：资料目录状态、索引重建与带来源检索。

import type { DesktopDataStore } from '../services/desktopDataStore'
import type { StoreDocsService } from '../services/storeDocsService'

interface StoreDocsRouteDependencies {
  store: Pick<DesktopDataStore, 'getStoreDocs'>
  service: Pick<StoreDocsService, 'setFolder' | 'clear' | 'reindex' | 'search'>
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createStoreDocsRouteHandler(deps: StoreDocsRouteDependencies) {
  return async function handleStoreDocsRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/store-docs')) return null

    if (url.pathname === '/api/v1/store-docs') {
      if (req.method === 'GET') return Response.json(await deps.store.getStoreDocs())
      if (req.method === 'PUT') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await deps.service.setFolder(typeof body.folder_path === 'string' ? body.folder_path : null))
      }
      if (req.method === 'DELETE') return Response.json(await deps.service.clear())
      return methodNotAllowed()
    }

    if (url.pathname === '/api/v1/store-docs/reindex') {
      if (req.method !== 'POST') return methodNotAllowed()
      return Response.json(await deps.service.reindex())
    }

    if (url.pathname === '/api/v1/store-docs/search') {
      if (req.method !== 'POST') return methodNotAllowed()
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      const query = typeof body.query === 'string' ? body.query : ''
      const top = typeof body.top === 'number' ? body.top : 5
      const paths = Array.isArray(body.paths)
        ? body.paths.filter((item): item is string => typeof item === 'string')
        : typeof body.path === 'string'
          ? body.path
          : undefined
      return Response.json({ hits: await deps.service.search(query, top, { paths }) })
    }

    return null
  }
}
