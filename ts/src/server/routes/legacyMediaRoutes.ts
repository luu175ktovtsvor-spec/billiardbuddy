// /api/v1/studio/* 与 /api/v1/video-edit/* 的 legacy 路由:
// 生图工作台/剪辑 v2 处理器优先接管,其余按"本地实现优先、媒体后端代理兜底"处理。

import { getDefaultWorkspaceDir } from '../../harness/desktopEnvNames'
import type { MediaJobService } from '../../media/mediaJobs'
import { localStoryboard } from '../../media/studioFallbacks'
import { VideoEditError, type VideoEditProjectStore } from '../../media/video-edit/legacyTimeline'
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

function videoEditError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  const status = error instanceof VideoEditError ? error.status : 500
  return jsonDetailError(message, status)
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

export function createLegacyVideoEditRouteHandler(deps: {
  media: MediaJobService
  videoEdits: VideoEditProjectStore
  videoEditV2Route: RouteHandler
}) {
  const { media, videoEdits } = deps
  return async function handleVideoEditRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/video-edit/')) return null
    const v2Response = await deps.videoEditV2Route(url, req.clone() as unknown as Request)
    if (v2Response) return v2Response
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, unknown>
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : undefined
    const workspaceRoot = stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir())

    if (url.pathname === '/api/v1/video-edit/localfile' && req.method === 'GET') {
      return await videoEdits.localFileResponse(url.searchParams.get('path'), req.headers.get('range'))
    }

    if (url.pathname === '/api/v1/video-edit/inventory' && req.method === 'POST') {
      const project = typeof body.project === 'string' ? body.project : undefined
      return Response.json(await media.startVideoJob('video_inventory', '/api/v1/video-edit/inventory', body, {
        conversationId,
        workspaceRoot,
        project,
        title: '视频素材理解',
      }))
    }
    const renderMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)\/(render|render_v2)$/)
    if (renderMatch && req.method === 'POST') {
      const project = decodeURIComponent(renderMatch[1]!)
      const action = renderMatch[2]!
      return Response.json(await media.startVideoJob('video_render', `/api/v1/video-edit/projects/${encodeURIComponent(project)}/${action}`, body, {
        conversationId,
        workspaceRoot,
        project,
        title: action === 'render_v2' ? 'V2 视频出片' : '视频出片',
      }))
    }

    const projectActionMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)(?:\/([^/]+))?$/)
    if (projectActionMatch) {
      const project = decodeURIComponent(projectActionMatch[1]!)
      const action = projectActionMatch[2] ? decodeURIComponent(projectActionMatch[2]) : ''
      if (media.hasBackend) {
        return Response.json(await media.proxyJson(url.pathname, req.method === 'GET' ? undefined : body, req.method))
      }
      try {
        if (!action && req.method === 'GET') {
          return Response.json(await videoEdits.getProject(project))
        }
        if (action === 'ops' && req.method === 'POST') {
          return Response.json(await videoEdits.applyOperations(project, body.operations))
        }
        if (action === 'auto_caption' && req.method === 'POST') {
          return Response.json(await videoEdits.autoCaption(project, body.track))
        }
        if (action === 'recaption' && req.method === 'POST') {
          return Response.json(await videoEdits.recaption(project, body.tonality))
        }
        if (action === 'edit_feedback' && req.method === 'POST') {
          return Response.json(await videoEdits.editFeedback(project, body.feedback))
        }
      } catch (error) {
        return videoEditError(error)
      }
    }

    if (media.hasBackend) {
      return Response.json(await media.proxyJson(url.pathname, req.method === 'GET' ? undefined : body, req.method))
    }
    return await mediaUnavailable()
  }
}
