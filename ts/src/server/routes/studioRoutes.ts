// /api/v1/studio/* 图片生成、编辑与工作台兼容路由。

import { getDefaultWorkspaceDir } from '../../harness/desktopEnvNames'
import type { MediaJobService } from '../../media/mediaJobs'
import { localStoryboard } from '../../media/studioFallbacks'
import {
  imageBriefCompileRequestSchema,
  imageBriefCompileResponseSchema,
  studioEditRequestSchema,
  studioGenerateRequestSchema,
  studioUpscaleRequestSchema,
} from '../../../shared/contracts/image-workbench'
import { jsonDetailError } from '../middleware/http'
import { stringOr } from '../requestParams'

type RouteHandler = (url: URL, req: Request) => Promise<Response | null>

async function mediaUnavailable() {
  return Response.json({ ok: false, detail: '媒体后端未配置' }, { status: 503 })
}

export function createStudioRouteHandler(deps: { media: MediaJobService; imageWorkbenchRoute: RouteHandler }) {
  const { media } = deps
  return async function handleStudioRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/studio/')) return null
    const workbenchResponse = await deps.imageWorkbenchRoute(url, req)
    if (workbenchResponse) return workbenchResponse
    const action = url.pathname.slice('/api/v1/studio/'.length)
    const generationMatch = action.match(/^generation\/(.+)$/)
    if (generationMatch && req.method === 'GET') {
      const local = media.localGeneration(decodeURIComponent(generationMatch[1]!))
      if (local) return Response.json(local)
      if (media.hasBackend) return Response.json(await media.proxyJson(url.pathname, undefined, 'GET'))
      return Response.json({ ok: false, detail: '没找到这张本地预览成品' }, { status: 404 })
    }
    if (action === 'brief/compile' && req.method === 'POST') {
      try {
        const body = imageBriefCompileRequestSchema.parse(await req.json().catch(() => ({})))
        const brief = await media.compileBriefWithModel(body as Record<string, unknown>)
        return Response.json(imageBriefCompileResponseSchema.parse({ brief, understanding: brief.understanding ?? brief.user_request }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'generate' && req.method === 'POST') {
      try {
        const rawBody = studioGenerateRequestSchema.parse(await req.json().catch(() => ({})))
        const trusted = rawBody.reference_image_paths ?? []
        const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
        return Response.json(await media.startStudioGenerate(body, {
          conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
          workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir()),
        }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'edit' && req.method === 'POST') {
      try {
        const rawBody = studioEditRequestSchema.parse(await req.json().catch(() => ({})))
        const trusted = [rawBody.mask_path, rawBody.source_image_path].filter((item): item is string => typeof item === 'string')
        const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
        return Response.json(await media.startStudioEdit(body, {
          conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
          workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir()),
        }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'upscale' && req.method === 'POST') {
      try {
        const rawBody = studioUpscaleRequestSchema.parse(await req.json().catch(() => ({})))
        const trusted = typeof rawBody.source_image_path === 'string' ? [rawBody.source_image_path] : []
        const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
        return Response.json(await media.startUpscale(body, {
          conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
          workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir()),
        }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'expand' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (media.hasBackend) return Response.json(await media.proxyJson('/api/v1/studio/expand', body))
      return Response.json({ image_prompt: stringOr(body.prompt, '') })
    }
    if (action === 'storyboard' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (media.hasBackend) return Response.json(await media.proxyJson('/api/v1/studio/storyboard', body))
      return Response.json(localStoryboard(body))
    }
    if (media.hasBackend) {
      const body = req.method === 'GET' ? undefined : await req.json().catch(() => ({})) as Record<string, unknown>
      return Response.json(await media.proxyJson(url.pathname, body, req.method))
    }
    return await mediaUnavailable()
  }
}
