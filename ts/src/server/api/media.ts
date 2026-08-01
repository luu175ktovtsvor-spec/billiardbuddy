import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod/v4'
import {
  addImageProjectReferencesInputSchema,
  addVideoSourceInputSchema,
  analyzeVideoProjectInputSchema,
  applyVideoAlternativeInputSchema,
  commitImageVersionInputSchema,
  createImageProjectInputSchema,
  createVideoProjectInputSchema,
  mediaSafeError,
  mediaSafeErrorForServiceError,
  publicMediaProjectSchema,
  publicMediaDeletionReceiptSchema,
  publicMediaJobEventPageSchema,
  publicMediaTaskSchema,
  lockVideoSceneInputSchema,
  previewVideoInputSchema,
  renderVideoInputSchema,
  saveImageOutputInputSchema,
  selectImageVersionInputSchema,
  selectVideoTimelineVersionInputSchema,
  startImageOperationInputSchema,
  submitImageProjectInputSchema,
  updateImageProjectInputSchema,
  updateVideoTimelineInputSchema,
  MEDIA_UI_CAPABILITY_HEADER,
  type MediaProject,
  type MediaJobEvent,
  type MediaTask,
  type PublicMediaProject,
  type PublicMediaTask,
} from '../../../shared/contracts/media.js'
import { errorResponse, ApiError } from '../middleware/errorHandler.js'
import { MediaProjectService, MediaServiceError } from '../services/mediaProjectService.js'

const STANDALONE_MEDIA_OWNER = {
  kind: 'standalone' as const,
  owner_id: 'local_workbench' as const,
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw ApiError.badRequest('请求体不是合法 JSON')
  }
}

function mediaErrorResponse(error: unknown): Response {
  if (error instanceof MediaServiceError) {
    const safe = mediaSafeErrorForServiceError(error.code, error.status)
    return Response.json(
      { error: safe.code, message: safe.message },
      { status: error.status },
    )
  }
  if (error instanceof z.ZodError) {
    const safe = mediaSafeError('MEDIA_INVALID_REQUEST')
    return Response.json(
      { error: safe.code, message: safe.message },
      { status: 400 },
    )
  }
  if (error instanceof ApiError) {
    const safe = mediaSafeErrorForServiceError(error.code, error.statusCode)
    return Response.json(
      { error: safe.code, message: safe.message },
      { status: error.statusCode },
    )
  }
  // Keep the complete failure in internal diagnostics, but media routes always
  // return the stable product envelope instead of the generic server wording.
  errorResponse(error)
  const safe = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
  return Response.json({ error: safe.code, message: safe.message }, { status: 500 })
}

function requireMediaUiCapability(req: Request, expected: string): void {
  const presented = req.headers.get(MEDIA_UI_CAPABILITY_HEADER)?.trim() ?? ''
  const expectedBytes = Buffer.from(expected)
  const presentedBytes = Buffer.from(presented)
  if (
    expectedBytes.length < 32
    || expectedBytes.length !== presentedBytes.length
    || !timingSafeEqual(expectedBytes, presentedBytes)
  ) {
    throw new MediaServiceError('此操作只能从 BilliardBuddy 桌面工作台确认', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
  }
}

export function consumeMediaUiCapability(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const capability = env.BB_MEDIA_UI_CAPABILITY?.trim() ?? ''
  delete env.BB_MEDIA_UI_CAPABILITY
  return capability
}

function publicProject(project: MediaProject): PublicMediaProject {
  const {
    owner: _owner,
    writer_fence: _writerFence,
    assets: _assets,
    versions: _versions,
    error: _rawError,
    error_code: persistedErrorCode,
    ...safeProject
  } = project
  const failure = _rawError
    ? mediaSafeError(persistedErrorCode ?? (project.kind === 'image'
      ? 'MEDIA_IMAGE_UNAVAILABLE'
      : 'MEDIA_VIDEO_EXPORT_FAILED'))
    : null
  const projected = publicMediaProjectSchema.parse({
    ...safeProject,
    ...(project.kind === 'image' ? {
      references: (project.references ?? []).flatMap(reference => {
        const asset = (project.assets ?? []).find(candidate => candidate.id === reference.asset_id && candidate.role === 'reference')
        if (
          !asset
          || (asset.mime_type !== 'image/png'
            && asset.mime_type !== 'image/jpeg'
            && asset.mime_type !== 'image/webp')
        ) return []
        const fileName = project.reference_image_assets?.find(candidate => candidate.startsWith(`${reference.asset_id}.`))
        if (!fileName) return []
        return [{
          ...reference,
          image_path: `/api/media/images/projects/${project.id}/references/${reference.asset_id}/content`,
          mime_type: asset.mime_type,
        }]
      }),
      version_history: (project.versions ?? []).flatMap(version => {
        const asset = version.asset_ids.length === 1
          ? (project.assets ?? []).find(candidate => candidate.id === version.asset_ids[0] && candidate.role === 'result')
          : undefined
        const output = asset ? (project.outputs ?? []).find(candidate => candidate.id === asset.id) : undefined
        const imagePath = output?.asset_path ?? output?.url
        if (!asset || !imagePath || !asset.mime_type || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime_type)) return []
        return [{
          id: version.id,
          parent_version_id: version.parent_version_id,
          kind: version.kind ?? output?.version_kind ?? 'generated',
          operation_id: version.operation_id ?? output?.operation_id,
          asset_id: asset.id,
          image_path: imagePath,
          mime_type: asset.mime_type,
          width: version.width ?? output?.width,
          height: version.height ?? output?.height,
          text_layers: version.text_layers ?? output?.text_layers ?? [],
          image_layers: (version.image_layers ?? output?.image_layers ?? []).flatMap(layer => {
            const source = (project.assets ?? []).find(candidate => (
              candidate.id === layer.source_asset_id
              && candidate.role === 'reference'
              && (candidate.storage.kind === 'managed' || candidate.storage.kind === 'cas')
            ))
            if (!source) return []
            if (source.storage.kind === 'managed') {
              const prefix = `${project.id}/references/`
              if (!source.storage.locator.startsWith(prefix)) return []
            }
            if (!source.mime_type || !['image/png', 'image/jpeg', 'image/webp'].includes(source.mime_type)) return []
            return [{
              ...layer,
              image_path: `/api/media/images/projects/${project.id}/layer-assets/${source.id}/content`,
              mime_type: source.mime_type,
            }]
          }),
          quality_assessment: output?.quality_assessment,
          created_at: version.created_at,
        }]
      }),
    } : {}),
    ...(failure ? { error: failure.message, error_code: failure.code } : {}),
  })
  if (projected.kind !== 'image') return projected
  return publicMediaProjectSchema.parse({
    ...projected,
    reference_image_count: projected.reference_images.length
      || projected.reference_image_assets?.length
      || projected.reference_image_count,
    reference_images: [],
    reference_image_assets: [],
  })
}

function publicTask(task: MediaTask): PublicMediaTask {
  const {
    owner: _owner,
    attempt: _attempt,
    image_operation: _imageOperation,
    remote_submission_started_at: _remoteSubmissionStartedAt,
    result: persistedResult,
    error: _rawError,
    error_code: persistedErrorCode,
    ...safeTask
  } = task
  const fallback = task.kind === 'image.generate'
    ? 'MEDIA_IMAGE_UNAVAILABLE'
    : task.kind === 'video.probe'
      ? 'MEDIA_VIDEO_SOURCE_UNREADABLE'
      : task.kind === 'video.analyze' || task.kind === 'video.plan'
        ? 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE'
        : task.kind === 'video.preview'
          ? 'MEDIA_VIDEO_PREVIEW_FAILED'
          : 'MEDIA_VIDEO_EXPORT_FAILED'
  const failure = _rawError ? mediaSafeError(persistedErrorCode ?? fallback) : null
  const safeResult = task.kind === 'image.generate' && persistedResult
    ? Object.fromEntries([
        'output_count',
        'input_fidelity_requested',
        'input_fidelity_status',
        'input_fidelity_risk',
      ].flatMap(key => persistedResult[key] === undefined ? [] : [[key, persistedResult[key]]]))
    : persistedResult
  return publicMediaTaskSchema.parse({
    ...safeTask,
    ...(safeResult ? { result: safeResult } : {}),
    ...(failure ? { error: failure.message, error_code: failure.code } : {}),
  })
}

function publicJobEvent(event: MediaJobEvent) {
  return {
    ...event,
    task: publicTask(event.task),
  }
}

function publicToolchainStatus(status: Awaited<ReturnType<MediaProjectService['toolchainStatus']>>) {
  return {
    ffmpeg: { available: status.ffmpeg.available },
    ffprobe: { available: status.ffprobe.available },
  }
}

export function createMediaApiHandler(
  service = new MediaProjectService(),
  mediaUiCapability = '',
) {
  return async function handleMediaApi(
    req: Request,
    url: URL,
    segments: string[],
  ): Promise<Response> {
    try {
      const area = segments[2]

      if (area === 'projects') {
        const projectId = segments[3]
        if (projectId) {
          if (segments[4] !== 'events' || segments[5]) throw ApiError.badRequest('无效的媒体项目操作')
          if (req.method !== 'GET') throw methodNotAllowed(req.method)
          await service.assertProjectOwner(projectId, STANDALONE_MEDIA_OWNER)
          const cursor = Number(url.searchParams.get('cursor') ?? 0)
          const limit = Number(url.searchParams.get('limit') ?? 100)
          const waitMs = Number(url.searchParams.get('wait_ms') ?? 25_000)
          if (!Number.isInteger(cursor) || cursor < 0) throw ApiError.badRequest('cursor 必须是非负整数')
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw ApiError.badRequest('limit 必须在 1 到 200 之间')
          if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) throw ApiError.badRequest('wait_ms 必须在 0 到 25000 之间')
          const page = await service.waitForJobEvents(projectId, cursor, limit, waitMs, req.signal)
          return Response.json(publicMediaJobEventPageSchema.parse({
            ...page,
            events: page.events.map(publicJobEvent),
          }))
        }
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        const requestedKind = url.searchParams.get('kind')
        if (requestedKind !== null && requestedKind !== 'image' && requestedKind !== 'video') {
          throw ApiError.badRequest('kind 只能是 image 或 video')
        }
        const kind = requestedKind === 'image' || requestedKind === 'video' ? requestedKind : undefined
        return Response.json({
          projects: (await service.listProjectsForOwner(STANDALONE_MEDIA_OWNER, kind)).map(publicProject),
        })
      }

      if (area === 'assets') {
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        const projectId = segments[3]
        const fileName = segments[4]
        if (!projectId || !fileName || segments[5]) throw ApiError.badRequest('无效的媒体资产地址')
        await service.assertProjectOwner(projectId, STANDALONE_MEDIA_OWNER)
        return await service.assetResponse(projectId, fileName, req)
      }

      if (area === 'deletions') {
        if (req.method !== 'GET' || segments[3]) throw methodNotAllowed(req.method)
        const deletions = await service.listDeletionsForOwner(STANDALONE_MEDIA_OWNER)
        return Response.json({
          deletions: deletions.map(receipt => publicMediaDeletionReceiptSchema.parse(receipt)),
        })
      }

      if (area === 'project') {
        const projectId = segments[3]
        if (!projectId) throw ApiError.badRequest('缺少媒体项目 ID')
        const action = segments[4]
        if (action === 'restore') {
          if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
          const receipt = publicMediaDeletionReceiptSchema.parse(
            await service.restoreProject(projectId, STANDALONE_MEDIA_OWNER),
          )
          return Response.json({ deletion: receipt })
        }
        if (action) throw ApiError.badRequest('无效的媒体项目操作')
        await service.assertProjectOwner(projectId, STANDALONE_MEDIA_OWNER)
        if (req.method === 'DELETE') {
          await service.deleteProject(projectId)
          return new Response(null, { status: 204 })
        }
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({ project: publicProject(await service.getProject(projectId)) })
      }

      if (area === 'tasks') {
        const taskId = segments[3]
        if (!taskId) throw ApiError.badRequest('缺少媒体任务 ID')
        await service.assertTaskOwner(taskId, STANDALONE_MEDIA_OWNER)
        if (segments[4] === 'cancel') {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          return Response.json({ task: publicTask(await service.cancelTask(taskId)) })
        }
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({ task: publicTask(await service.getTask(taskId)) })
      }

      if (area === 'images' && segments[3] === 'projects') {
        const projectId = segments[4]
        const action = segments[5]
        if (!projectId) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const input = createImageProjectInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicProject(await service.createImageProject(input)) }, { status: 201 })
        }
        await service.assertProjectOwner(projectId, STANDALONE_MEDIA_OWNER)
        if (action === 'references') {
          const referenceId = segments[6]
          if (!referenceId && req.method === 'POST' && !segments[7]) {
            const input = addImageProjectReferencesInputSchema.parse(await parseJson(req))
            return Response.json({ project: publicProject(await service.addImageProjectReferences(projectId, input)) }, { status: 201 })
          }
          if (!referenceId || segments[7] !== 'content' || segments[8]) {
            throw ApiError.badRequest('无效的图片参考素材地址')
          }
          if (req.method !== 'GET') throw methodNotAllowed(req.method)
          return await service.imageReferenceResponse(projectId, referenceId, req)
        }
        if (action === 'layer-assets') {
          const assetId = segments[6]
          if (!assetId || segments[7] !== 'content' || segments[8]) {
            throw ApiError.badRequest('无效的图片图层素材地址')
          }
          if (req.method !== 'GET') throw methodNotAllowed(req.method)
          return await service.imageLayerAssetResponse(projectId, assetId, req)
        }
        if (!action && req.method === 'PUT') {
          const input = updateImageProjectInputSchema.parse(await parseJson(req))
          if (input.confirm_unknown_retry) {
            requireMediaUiCapability(req, mediaUiCapability)
          }
          return Response.json({ project: publicProject(await service.updateImageProject(projectId, input)) })
        }
        if (action === 'operations') {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = startImageOperationInputSchema.parse(await parseJson(req))
          return Response.json({ task: publicTask(await service.startImageOperation(projectId, input)) }, { status: 202 })
        }
        if (action === 'versions') {
          const versionId = segments[6]
          const versionAction = segments[7]
          if (versionId && versionAction === 'select') {
            if (req.method !== 'POST' || segments[8]) throw methodNotAllowed(req.method)
            const input = selectImageVersionInputSchema.parse({
              ...(await parseJson(req) as Record<string, unknown>),
              version_id: versionId,
            })
            return Response.json({ project: publicProject(await service.selectImageVersion(projectId, input)) })
          }
          if (versionId && versionAction === 'save') {
            if (req.method !== 'POST' || segments[8]) throw methodNotAllowed(req.method)
            requireMediaUiCapability(req, mediaUiCapability)
            const input = saveImageOutputInputSchema.parse({
              ...(await parseJson(req) as Record<string, unknown>),
              version_id: versionId,
            })
            return Response.json(await service.saveImageOutput(projectId, input))
          }
          if (req.method !== 'POST' || versionId) throw methodNotAllowed(req.method)
          const input = commitImageVersionInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicProject(await service.commitImageVersion(projectId, input)) }, { status: 201 })
        }
        if (action === 'outputs' && segments[7] === 'save') {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const outputId = segments[6]
          if (!outputId || segments[8]) throw ApiError.badRequest('无效的图片结果地址')
          requireMediaUiCapability(req, mediaUiCapability)
          const input = saveImageOutputInputSchema.parse({
            ...(await parseJson(req) as Record<string, unknown>),
            output_id: outputId,
          })
          return Response.json(await service.saveImageOutput(projectId, input))
        }
        if (action === 'submit') {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = submitImageProjectInputSchema.parse(await parseJson(req))
          return Response.json({ task: publicTask(await service.submitImageProject(projectId, input)) }, { status: 202 })
        }
      }

      if (area === 'videos' && segments[3] === 'toolchain') {
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json(publicToolchainStatus(await service.toolchainStatus()))
      }

      if (area === 'videos' && segments[3] === 'projects') {
        const projectId = segments[4]
        const action = segments[5]
        if (!projectId) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const input = createVideoProjectInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicProject(await service.createVideoProject(input)) }, { status: 201 })
        }
        await service.assertProjectOwner(projectId, STANDALONE_MEDIA_OWNER)
        if (action === 'sources') {
          const sourceId = segments[6]
          const sourceAction = segments[7]
          if (sourceId && sourceAction === 'content') {
            if (req.method !== 'GET') throw methodNotAllowed(req.method)
            return await service.videoSourceResponse(projectId, sourceId, req)
          }
          if (req.method !== 'POST' || sourceId) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = addVideoSourceInputSchema.parse(await parseJson(req))
          const result = await service.addVideoSource(projectId, input)
          return Response.json({ ...result, project: publicProject(result.project), task: publicTask(result.task) }, { status: 201 })
        }
        if (action === 'timeline') {
          const timelineArea = segments[6]
          const versionId = segments[7]
          const versionAction = segments[8]
          if (timelineArea === 'versions' && versionId && versionAction === 'select') {
            if (req.method !== 'POST' || segments[9]) throw methodNotAllowed(req.method)
            const input = selectVideoTimelineVersionInputSchema.parse({
              ...(await parseJson(req) as Record<string, unknown>),
              version_id: versionId,
            })
            return Response.json({ project: publicProject(await service.selectVideoTimelineVersion(projectId, input)) })
          }
          if (req.method !== 'PUT' || timelineArea) throw methodNotAllowed(req.method)
          const input = updateVideoTimelineInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicProject(await service.updateVideoTimeline(projectId, input)) })
        }
        if (action === 'analyze') {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = analyzeVideoProjectInputSchema.parse(await parseJson(req))
          return Response.json({ task: publicTask(await service.analyzeVideoProject(projectId, input)) }, { status: 202 })
        }
        if (action === 'scenes') {
          const sceneId = segments[6]
          if (!sceneId || segments[7] !== 'lock' || segments[8] || req.method !== 'POST') throw methodNotAllowed(req.method)
          const input = lockVideoSceneInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicProject(await service.lockVideoScene(projectId, sceneId, input)) })
        }
        if (action === 'alternatives') {
          const alternativeId = segments[6]
          if (!alternativeId || segments[7] !== 'apply' || segments[8] || req.method !== 'POST') throw methodNotAllowed(req.method)
          const input = applyVideoAlternativeInputSchema.parse({
            ...(await parseJson(req) as Record<string, unknown>),
            alternative_id: alternativeId,
          })
          return Response.json({ project: publicProject(await service.applyVideoAlternative(projectId, input)) })
        }
        if (action === 'render') {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = renderVideoInputSchema.parse(await parseJson(req))
          return Response.json({ task: publicTask(await service.renderVideo(projectId, input)) }, { status: 202 })
        }
        if (action === 'preview') {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          const input = previewVideoInputSchema.parse(await parseJson(req))
          return Response.json({ task: publicTask(await service.previewVideo(projectId, input)) }, { status: 202 })
        }
      }

      throw ApiError.notFound('找不到媒体接口')
    } catch (error) {
      return mediaErrorResponse(error)
    }
  }
}

export const handleMediaApi = createMediaApiHandler()
