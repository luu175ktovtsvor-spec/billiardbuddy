import { resolve } from 'node:path'
import { ZodError } from 'zod'
import {
  videoAnalyzeRequestSchema,
  videoAlternativeApplyRequestSchema,
  videoAlternativeApplyResponseSchema,
  videoBriefCompileRequestSchema,
  videoCreateProjectResponseSchema,
  videoCreateProjectRequestSchema,
  videoErrorSchema,
  videoJobResponseSchema,
  videoJobStartResponseSchema,
  videoMutationResponseSchema,
  videoOpsRequestSchema,
  videoOpsResponseSchema,
  videoProjectListResponseSchema,
  videoProjectResponseSchema,
  videoRenderRequestSchema,
} from '../../../shared/contracts/video-edit'
import { VideoProjectError } from './projectStore'
import type { VideoEditingService } from './service'

interface VideoEditRouteOptions {
  defaultWorkspaceRoot?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function sameWorkingDir(left: string | undefined, right: string | undefined): boolean {
  if (!left?.trim() || !right?.trim()) return false
  return resolve(left) === resolve(right)
}

function errorResponse(error: unknown): Response {
  if (error instanceof VideoProjectError) {
    return Response.json(videoErrorSchema.parse({ error: { code: error.code, message: error.message, retryable: error.status >= 500, ...error.detail } }), { status: error.status })
  }
  if (error instanceof ZodError) {
    return Response.json(videoErrorSchema.parse({ error: { code: 'invalid_request', message: error.issues[0]?.message ?? '请求格式不正确', retryable: false } }), { status: 400 })
  }
  return Response.json(videoErrorSchema.parse({ error: { code: 'video_internal_error', message: error instanceof Error ? error.message : String(error), retryable: true } }), { status: 500 })
}

async function json(req: Request): Promise<unknown> {
  return await req.json().catch(() => ({}))
}

export function createVideoEditRouteHandler(service: VideoEditingService, options: VideoEditRouteOptions = {}) {
  // D1:brief/compile、analyze、drafts、ops、undo、redo、render(_v2)、alternatives/apply 这些改数据的
  // 端点之前只裸调 service.store.load(projectId),不比对 working_dir——只有 auto_plan 一个端点接了
  // loadForWorkspace 校验。前端状态串线(切换门店工作区后某组件还带旧 project_id)就能悄悄改错门店的
  // 视频项目。这里在每个动作分发前统一跑一次校验,复用已经验证过的 loadForWorkspace,不改 service
  // 内部实现。对齐 auto_plan 既有口径:只在调用方**显式**带 working_dir 时才校验,不回退到
  // defaultWorkspaceRoot——这是"这个项目是否属于调用方声称的工作区"的校验,不是"没说就假定当前
  // 桌面会话默认目录"的场景(那是 create/list 的既有语义,互不相干)。
  const assertWorkspace = async (projectId: string, workingDir: string | undefined): Promise<void> => {
    const resolved = workingDir?.trim()
    if (resolved) await service.store.loadForWorkspace(projectId, resolved)
  }
  return async (url: URL, req: Request): Promise<Response | null> => {
    if (!url.pathname.startsWith('/api/v1/video-edit/')) return null
    try {
      if ((url.pathname === '/api/v1/video-edit/auto_plan' || url.pathname === '/api/v1/video-edit/auto_plan_v2') && req.method === 'POST') {
        const body = record(await json(req))
        const projectId = text(body.project) || undefined
        const paths = strings(body.video_paths)
        if (!projectId && paths.length === 0) return Response.json({ detail: 'video_paths required' }, { status: 400 })
        const userRequest = text(body.goal ?? body.user_request, '根据用户提供的真实素材剪成一条完整、自然的视频')
        const preferredView: 'talking' | 'ambient' | undefined = body.mode === 'speech' ? 'talking' : body.mode === 'ambient' ? 'ambient' : undefined
        const ratio: '9:16' | '1:1' | '16:9' = body.ratio === '1:1' || body.ratio === '16:9' ? body.ratio : '9:16'
        const targetDurationMs = Number.isFinite(Number(body.target_duration_ms))
          ? Number(body.target_duration_ms)
          : Number.isFinite(Number(body.target_duration)) ? Math.round(Number(body.target_duration) * 1000) : undefined
        const conversationId = text(body.conversation_id) || undefined
        const workspaceRoot = text(body.workspaceRoot ?? body.working_dir, options.defaultWorkspaceRoot)
        const brief = { user_request: userRequest, preferred_view: preferredView, ratio, target_duration_ms: targetDurationMs }
        if (projectId) {
          if (workspaceRoot) await service.store.loadForWorkspace(projectId, workspaceRoot)
          else await service.store.load(projectId)
          await service.compileBrief(projectId, brief)
          const started = await service.startDrafts(projectId, { conversationId, workspaceRoot })
          return Response.json({ job_id: started.job_id, project: projectId, project_id: projectId })
        }
        const planned = await service.createPlannedProject({
          video_paths: paths,
          user_request: userRequest,
          goal: preferredView,
          ratio,
          target_duration_ms: targetDurationMs,
          conversation_id: conversationId,
          working_dir: workspaceRoot,
        }, brief)
        return Response.json({ job_id: planned.job.job_id, project: planned.project.project_id, project_id: planned.project.project_id })
      }

      if (url.pathname === '/api/v1/video-edit/projects') {
        if (req.method === 'POST') {
          const raw = record(await json(req))
          const body = videoCreateProjectRequestSchema.parse({ ...raw, working_dir: raw.working_dir ?? options.defaultWorkspaceRoot })
          return Response.json(videoCreateProjectResponseSchema.parse(await service.createProject(body)), { status: 201 })
        }
        if (req.method === 'GET') {
          const workingDir = url.searchParams.get('working_dir')?.trim() || options.defaultWorkspaceRoot
          return Response.json(videoProjectListResponseSchema.parse({
            projects: await service.store.list({
              workingDir,
              includeUnscoped: sameWorkingDir(workingDir, options.defaultWorkspaceRoot),
            }),
          }))
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const jobMatch = url.pathname.match(/^\/api\/v1\/video-edit\/jobs\/([^/]+)(?:\/(cancel|retry))?$/)
      if (jobMatch) {
        const id = decodeURIComponent(jobMatch[1]!)
        const action = jobMatch[2]
        if (!action && req.method === 'GET') {
          const job = await service.getJob(id)
          return job ? Response.json(videoJobResponseSchema.parse({ job })) : errorResponse(new VideoProjectError('找不到视频任务', 'job_not_found', 404))
        }
        if (action === 'cancel' && req.method === 'POST') return Response.json(videoJobResponseSchema.parse({ job: await service.cancelJob(id) }))
        if (action === 'retry' && req.method === 'POST') return Response.json(videoJobStartResponseSchema.parse(await service.retryJob(id)), { status: 202 })
        return new Response('Method not allowed', { status: 405 })
      }

      const sourceMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)\/sources\/([^/]+)$/)
      if (sourceMatch && req.method === 'GET') return await service.sourceResponse(decodeURIComponent(sourceMatch[1]!), decodeURIComponent(sourceMatch[2]!), req)
      const logoMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)\/brand\/logo$/)
      if (logoMatch && req.method === 'GET') return await service.brandLogoResponse(decodeURIComponent(logoMatch[1]!), req)
      const exportMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)\/exports\/([^/]+)$/)
      if (exportMatch && req.method === 'GET') return await service.exportResponse(decodeURIComponent(exportMatch[1]!), decodeURIComponent(exportMatch[2]!), req)

      const alternativeMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)\/alternatives\/([^/]+)\/apply$/)
      if (alternativeMatch && req.method === 'POST') {
        const projectId = decodeURIComponent(alternativeMatch[1]!)
        const alternativeId = decodeURIComponent(alternativeMatch[2]!)
        const input = videoAlternativeApplyRequestSchema.parse(await json(req))
        await assertWorkspace(projectId, input.working_dir)
        return Response.json(videoAlternativeApplyResponseSchema.parse({ project: await service.store.applyAlternative(projectId, alternativeId, input.base_revision, input.scope, input.scene_id) }))
      }

      const projectMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)(?:\/(brief\/compile|analyze|drafts|ops|undo|redo|render|render_v2))?$/)
      if (!projectMatch) return null
      const projectId = decodeURIComponent(projectMatch[1]!)
      const action = projectMatch[2] ?? ''

      // A legacy-only project continues through the old compatibility handler until it is explicitly opened by v2 migration.
      if (!service.store.hasV2Project(projectId) && action !== '') return null
      if (!action && req.method === 'GET') {
        if (!service.store.hasV2Project(projectId)) return null
        const workingDir = url.searchParams.get('working_dir')?.trim()
        return Response.json(videoProjectResponseSchema.parse({ project: workingDir ? await service.store.loadForWorkspace(projectId, workingDir) : await service.store.load(projectId) }))
      }
      if (action === 'brief/compile' && req.method === 'POST') {
        const input = videoBriefCompileRequestSchema.parse(await json(req))
        await assertWorkspace(projectId, input.working_dir)
        return Response.json(await service.compileBrief(projectId, input))
      }
      if (action === 'analyze' && req.method === 'POST') {
        const input = videoAnalyzeRequestSchema.parse(await json(req))
        await assertWorkspace(projectId, input.working_dir)
        return Response.json(videoJobStartResponseSchema.parse(await service.startAnalyze(projectId, { sourceIds: input.source_ids })), { status: 202 })
      }
      if (action === 'drafts' && req.method === 'POST') {
        const raw = record(await json(req))
        await assertWorkspace(projectId, text(raw.working_dir) || undefined)
        return Response.json(videoJobStartResponseSchema.parse(await service.startDrafts(projectId)), { status: 202 })
      }
      if (action === 'ops' && req.method === 'POST') {
        const raw = await json(req)
        if (!raw || typeof raw !== 'object' || !('base_revision' in raw)) return null
        const input = videoOpsRequestSchema.parse(raw)
        await assertWorkspace(projectId, input.working_dir)
        const result = await service.store.apply(projectId, input.base_revision, input.operations)
        return Response.json(videoOpsResponseSchema.parse({ project: result.project, affected_scene_ids: result.affectedSceneIds, operation_id: result.operationId }))
      }
      if (action === 'undo' && req.method === 'POST') {
        const input = await json(req) as { base_revision?: unknown; working_dir?: unknown }
        if (!Number.isInteger(input.base_revision)) throw new VideoProjectError('撤销需要 base_revision', 'invalid_revision')
        await assertWorkspace(projectId, text(input.working_dir) || undefined)
        return Response.json(videoMutationResponseSchema.parse({ project: await service.store.undo(projectId, Number(input.base_revision)) }))
      }
      if (action === 'redo' && req.method === 'POST') {
        const input = await json(req) as { base_revision?: unknown; working_dir?: unknown }
        if (!Number.isInteger(input.base_revision)) throw new VideoProjectError('重做需要 base_revision', 'invalid_revision')
        await assertWorkspace(projectId, text(input.working_dir) || undefined)
        return Response.json(videoMutationResponseSchema.parse({ project: await service.store.redo(projectId, Number(input.base_revision)) }))
      }
      if ((action === 'render' || action === 'render_v2') && req.method === 'POST') {
        const input = videoRenderRequestSchema.parse(await json(req))
        await assertWorkspace(projectId, input.working_dir)
        return Response.json(videoJobStartResponseSchema.parse(await service.startRender(projectId, input)), { status: 202 })
      }
      return new Response('Method not allowed', { status: 405 })
    } catch (error) {
      return errorResponse(error)
    }
  }
}
