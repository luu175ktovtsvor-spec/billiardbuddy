// Provider 与模型状态 REST 边界。配置存储、连通性测试和健康状态编排由注入服务负责。

import { toPublicProviderView } from '../../model/publicModelNames'
import type { FetchLike } from '../../proxy/ProxyModel'
import type { ProviderService } from '../services/providerService'
import { jsonError } from '../middleware/http'
import { providerStatusFor } from '../providerRuntime'
import { stringArray } from '../requestParams'

type ProviderRouteService = Pick<
  ProviderService,
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'activate'
  | 'clearActive'
  | 'setEnabled'
  | 'reorder'
  | 'testProvider'
  | 'testProviderConfig'
>

type ModelStatus = { ok: boolean } & Record<string, unknown>

interface ProviderRouteDependencies {
  providers: ProviderRouteService
  currentModelStatus: () => Promise<ModelStatus>
  clearModelHealth: (body: Record<string, unknown>) => Promise<unknown>
  fetchImpl?: FetchLike
}

function providerPath(url: URL): { matched: boolean; segments: string[] } {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] === 'providers') return { matched: true, segments: segments.slice(1) }
  if (segments[0] === 'api' && segments[1] === 'providers') return { matched: true, segments: segments.slice(2) }
  return { matched: false, segments: [] }
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

export function createProviderRouteHandler(deps: ProviderRouteDependencies) {
  return async function handleProviderRoute(url: URL, req: Request): Promise<Response | null> {
    if (url.pathname === '/model/health/clear' || url.pathname === '/api/model/health/clear') {
      if (req.method !== 'POST') return methodNotAllowed()
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      try {
        return Response.json(await deps.clearModelHealth(body))
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
      }
    }

    if (url.pathname === '/model' || url.pathname === '/api/model') {
      if (req.method === 'GET') {
        const status = await deps.currentModelStatus()
        return Response.json(status, { status: status.ok ? 200 : 503 })
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const providerId = typeof body.providerId === 'string'
          ? body.providerId.trim()
          : typeof body.id === 'string'
            ? body.id.trim()
            : ''
        try {
          if (!providerId || providerId === 'env' || providerId === 'default') await deps.providers.clearActive()
          else await deps.providers.activate(providerId)
          const status = await deps.currentModelStatus()
          return Response.json(status, { status: status.ok ? 200 : 503 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }
      return methodNotAllowed()
    }

    const providerRoute = providerPath(url)
    if (!providerRoute.matched) return null

    try {
      const [id, action] = providerRoute.segments

      if (!id) {
        if (req.method === 'GET') {
          const listed = await deps.providers.list()
          return Response.json({ activeId: listed.activeId, providers: listed.providers.map(toPublicProviderView) })
        }
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json({ provider: await deps.providers.create(body) }, { status: 201 })
        }
        return methodNotAllowed()
      }

      if (id === 'reorder' && !action && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const ids = stringArray(body.ids ?? body.providerIds ?? body.order)
        return Response.json(await deps.providers.reorder(ids))
      }

      if (id === 'active' && action === 'clear' && req.method === 'POST') {
        await deps.providers.clearActive()
        return Response.json({ ok: true })
      }

      if (action === 'clear-health' && req.method === 'POST') {
        return Response.json(await deps.clearModelHealth({ providerId: id }))
      }

      if (id === 'test' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json({ result: await deps.providers.testProviderConfig(body, { fetchImpl: deps.fetchImpl }) })
      }

      if (action === 'activate' && req.method === 'POST') {
        return Response.json({ provider: await deps.providers.activate(id) })
      }

      if ((action === 'enable' || action === 'disable') && req.method === 'POST') {
        return Response.json({ provider: await deps.providers.setEnabled(id, action === 'enable') })
      }

      if (action === 'enabled' && (req.method === 'POST' || req.method === 'PATCH')) {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json({ provider: await deps.providers.setEnabled(id, body.enabled !== false) })
      }

      if (action === 'test' && req.method === 'POST') {
        return Response.json({ result: await deps.providers.testProvider(id, { fetchImpl: deps.fetchImpl }) })
      }

      if (!action && req.method === 'GET') {
        const provider = await deps.providers.get(id)
        if (!provider) return jsonError('provider not found', 404)
        return Response.json({ provider })
      }
      if (!action && (req.method === 'PUT' || req.method === 'PATCH')) {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json({ provider: await deps.providers.update(id, body) })
      }
      if (!action && req.method === 'DELETE') {
        await deps.providers.delete(id)
        return Response.json({ ok: true })
      }

      return methodNotAllowed()
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
    }
  }
}
