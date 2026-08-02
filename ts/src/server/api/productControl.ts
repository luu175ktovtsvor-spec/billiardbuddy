/**
 * Shared local Product API after the legacy ProductTask Agent backend was
 * retired. Agent Threads, turns, tools, approvals and execution now belong to
 * the native Codex sidecar, not this TypeScript control surface.
 */

import type { ProductRecentProjectList } from '../../../shared/product/domain.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { ProductCapabilitySnapshotService } from '../services/productCapabilitySnapshot.js'
import { handleProductSettingsApi } from './productSettings.js'
import { handleProductVoiceApi } from './productVoice.js'

const LEGACY_AGENT_BACKEND_RETIRED = 'LEGACY_AGENT_BACKEND_RETIRED'

type ProductControlDependencies = {
  capabilitySnapshots: Pick<ProductCapabilitySnapshotService, 'snapshot'>
  listRecentProjects: (limit: number) => Promise<ProductRecentProjectList>
}

function recentProjectLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null || !raw.trim()) return 10
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 10
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    { error: 'METHOD_NOT_ALLOWED', message: `不支持 ${method} 请求` },
    { status: 405 },
  )
}

function retiredAgentResponse(): Response {
  return Response.json(
    {
      error: LEGACY_AGENT_BACKEND_RETIRED,
      message: '旧版 Agent 后端已退役；请使用原生 Codex 会话接口。',
    },
    { status: 410 },
  )
}

export function legacyAgentBackendRetiredResponse(): Response {
  return retiredAgentResponse()
}

export async function handleProductControlApi(
  req: Request,
  url: URL,
  segments: string[],
  deps: ProductControlDependencies,
): Promise<Response> {
  try {
    if (segments[2] === 'voice') {
      return await handleProductVoiceApi(req, segments)
    }

    if (segments[2] === 'settings') {
      return await handleProductSettingsApi(req, url, segments)
    }

    if (segments[2] === 'capabilities') {
      if (segments[3]) throw ApiError.notFound('未知产品能力资源')
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json(await deps.capabilitySnapshots.snapshot())
    }

    if (segments[2] === 'projects') {
      if (segments[3] !== 'recent' || segments[4]) {
        throw ApiError.notFound('未知产品项目资源')
      }
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json(await deps.listRecentProjects(recentProjectLimit(url)))
    }

    return retiredAgentResponse()
  } catch (error) {
    return errorResponse(error)
  }
}
