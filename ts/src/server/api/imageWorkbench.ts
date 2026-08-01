import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod/v4'
import {
  addImageProjectReferencesInputSchema,
  commitImageVersionInputSchema,
  createImageProjectInputSchema,
  mediaSafeError,
  mediaSafeErrorForServiceError,
  publicMediaDeletionReceiptSchema,
  publicImageWorkbenchProjectSchema,
  publicMediaJobEventPageSchema,
  publicMediaTaskSchema,
  saveImageOutputInputSchema,
  selectImageVersionInputSchema,
  startImageOperationInputSchema,
  submitImageProjectInputSchema,
  updateImageProjectInputSchema,
  MEDIA_UI_CAPABILITY_HEADER,
  type ImageWorkbenchProject,
  type PublicImageWorkbenchProject,
  type PublicMediaTask,
} from '../../../shared/contracts/media.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { ImageWorkbenchService, ImageWorkbenchServiceError } from '../services/imageWorkbenchService.js'
import { ImageAssetStoreError } from '../services/imageAssetStore.js'
import { ImageWorkbenchRepositoryError, type ImageOperation, type ImageOperationEvent } from '../services/imageWorkbenchRepository.js'

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

function requireMediaUiCapability(req: Request, expected: string): void {
  const presented = req.headers.get(MEDIA_UI_CAPABILITY_HEADER)?.trim() ?? ''
  const expectedBytes = Buffer.from(expected)
  const presentedBytes = Buffer.from(presented)
  if (
    expectedBytes.length < 32
    || expectedBytes.length !== presentedBytes.length
    || !timingSafeEqual(expectedBytes, presentedBytes)
  ) {
    throw new ImageWorkbenchServiceError('此操作只能从 BilliardBuddy 桌面工作台确认', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
  }
}

function apiErrorResponse(error: unknown): Response {
  if (error instanceof ImageWorkbenchServiceError || error instanceof ImageAssetStoreError || error instanceof ImageWorkbenchRepositoryError) {
    const safe = mediaSafeErrorForServiceError(error.code, error.status)
    return Response.json({ error: safe.code, message: safe.message }, { status: error.status })
  }
  if (error instanceof z.ZodError) {
    const safe = mediaSafeError('MEDIA_INVALID_REQUEST')
    return Response.json({ error: safe.code, message: safe.message }, { status: 400 })
  }
  if (error instanceof ApiError) {
    const safe = mediaSafeErrorForServiceError(error.code, error.statusCode)
    return Response.json({ error: safe.code, message: safe.message }, { status: error.statusCode })
  }
  errorResponse(error)
  const safe = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
  return Response.json({ error: safe.code, message: safe.message }, { status: 500 })
}

function imageMime(value: unknown): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' ? value : null
}

export function publicImageProject(project: ImageWorkbenchProject): PublicImageWorkbenchProject {
  const references = project.references.flatMap(reference => {
    const asset = project.assets.find(candidate => candidate.id === reference.asset_id && candidate.role === 'reference')
    const mimeType = imageMime(asset?.mime_type)
    if (!asset || !mimeType) return []
    return [{
      ...reference,
      image_path: `/api/images/projects/${project.id}/references/${reference.asset_id}/content`,
      mime_type: mimeType,
    }]
  })
  const versionHistory = project.versions.flatMap(version => {
    const asset = version.asset_ids.length === 1
      ? project.assets.find(candidate => candidate.id === version.asset_ids[0] && candidate.role === 'result')
      : undefined
    const output = asset ? project.outputs.find(candidate => candidate.id === asset.id) : undefined
    const mimeType = imageMime(asset?.mime_type)
    if (!asset || !output || !mimeType) return []
    const imageLayers = (version.image_layers ?? output.image_layers ?? []).flatMap(layer => {
      const source = project.assets.find(candidate => candidate.id === layer.source_asset_id && candidate.role === 'reference')
      const sourceMime = imageMime(source?.mime_type)
      if (!source || !sourceMime) return []
      return [{
        ...layer,
        image_path: `/api/images/projects/${project.id}/layer-assets/${source.id}/content`,
        mime_type: sourceMime,
      }]
    })
    return [{
      id: version.id,
      parent_version_id: version.parent_version_id,
      kind: version.kind ?? output.version_kind ?? 'generated',
      operation_id: version.operation_id ?? output.operation_id,
      asset_id: asset.id,
      // The asset id and project ownership are the durable facts. Never reuse
      // an old public URL from a migrated record as this workbench's source.
      image_path: `/api/images/projects/${project.id}/outputs/${asset.id}/content`,
      mime_type: mimeType,
      width: version.width ?? output.width,
      height: version.height ?? output.height,
      text_layers: version.text_layers ?? output.text_layers ?? [],
      image_layers: imageLayers,
      quality_assessment: output.quality_assessment,
      created_at: version.created_at,
    }]
  })
  const {
    owner: _owner,
    writer_fence: _writerFence,
    assets: _assets,
    versions: _versions,
    model: _model,
    prompt: _prompt,
    count: _count,
    outputs: _outputs,
    reference_images: _referenceImages,
    reference_image_assets: _referenceImageAssets,
    error: rawError,
    error_code: errorCode,
    ...safeProject
  } = project
  const failure = rawError ? mediaSafeError(errorCode ?? 'MEDIA_IMAGE_UNAVAILABLE') : null
  return publicImageWorkbenchProjectSchema.parse({
    ...safeProject,
    references,
    reference_image_count: references.length,
    version_history: versionHistory,
    ...(failure ? { error: failure.message, error_code: failure.code } : {}),
  })
}

export function publicImageTask(operation: ImageOperation): PublicMediaTask {
  const {
    owner: _owner,
    attempt: _attempt,
    image_operation: _imageOperation,
    remote_submission_started_at: _remoteSubmissionStartedAt,
    remote_result_acknowledged_at: _remoteResultAcknowledgedAt,
    poll_after_seconds: _pollAfterSeconds,
    result,
    error: rawError,
    error_code: errorCode,
    ...safeOperation
  } = operation
  const failure = rawError ? mediaSafeError(errorCode ?? 'MEDIA_IMAGE_UNAVAILABLE') : null
  const safeResult = result ? Object.fromEntries([
    'output_count',
    'input_fidelity_requested',
    'input_fidelity_status',
    'input_fidelity_risk',
  ].flatMap(key => result[key] === undefined ? [] : [[key, result[key]]])) : undefined
  return publicMediaTaskSchema.parse({
    ...safeOperation,
    ...(safeResult ? { result: safeResult } : {}),
    ...(failure ? { error: failure.message, error_code: failure.code } : {}),
  })
}

function publicImageEvent(event: ImageOperationEvent) {
  return {
    schema_version: event.schema_version,
    cursor: event.cursor,
    project_id: event.project_id,
    task_id: event.operation.id,
    operation_id: event.operation_id,
    status_sequence: event.status_sequence,
    occurred_at: event.occurred_at,
    task: publicImageTask(event.operation),
  }
}

export function createImageWorkbenchApiHandler(
  service: ImageWorkbenchService,
  mediaUiCapability = '',
) {
  return async function handleImageWorkbenchApi(
    req: Request,
    url: URL,
    segments: string[],
  ): Promise<Response> {
    try {
      if (segments[2] !== 'images' || segments[3] !== 'projects') throw ApiError.notFound('找不到生图接口')
      const projectId = segments[4]
      const action = segments[5]
      if (!projectId) {
        if (req.method === 'GET' && !action) {
          return Response.json({ projects: (await service.listProjects()).map(publicImageProject) })
        }
        if (req.method !== 'POST' || action) throw methodNotAllowed(req.method)
        const input = createImageProjectInputSchema.parse(await parseJson(req))
        return Response.json({ project: publicImageProject(await service.createProject(input)) }, { status: 201 })
      }
      if (!action && req.method === 'DELETE') {
        const project = await service.getProject(projectId).catch(error => {
          if (error instanceof ImageWorkbenchServiceError && error.code === 'IMAGE_PROJECT_NOT_FOUND') return null
          throw error
        })
        if (project) await service.deleteProject(projectId)
        else if (!(await service.hasProjectHistory(projectId))) {
          throw new ImageWorkbenchServiceError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
        }
        return new Response(null, { status: 204 })
      }
      await service.assertProjectOwner(projectId)
      if (!action) {
        if (req.method === 'GET') return Response.json({ project: publicImageProject(await service.getProject(projectId)) })
        if (req.method !== 'PUT') throw methodNotAllowed(req.method)
        const input = updateImageProjectInputSchema.parse(await parseJson(req))
        if (input.confirm_unknown_retry) requireMediaUiCapability(req, mediaUiCapability)
        return Response.json({ project: publicImageProject(await service.updateProject(projectId, input)) })
      }
      if (action === 'references') {
        const referenceId = segments[6]
        if (!referenceId && req.method === 'POST' && !segments[7]) {
          const input = addImageProjectReferencesInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicImageProject(await service.addReferences(projectId, input)) }, { status: 201 })
        }
        if (!referenceId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        return await service.referenceResponse(projectId, referenceId)
      }
      if (action === 'layer-assets') {
        const assetId = segments[6]
        if (!assetId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        return await service.layerAssetResponse(projectId, assetId)
      }
      if (action === 'outputs') {
        const outputId = segments[6]
        if (!outputId) throw ApiError.badRequest('缺少图片结果 ID')
        if (segments[7] === 'content' && !segments[8] && req.method === 'GET') return await service.outputResponse(projectId, outputId)
        if (segments[7] === 'save' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = saveImageOutputInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), output_id: outputId })
          return Response.json(await service.saveOutput(projectId, input))
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'operations') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = startImageOperationInputSchema.parse(await parseJson(req))
        return Response.json({ task: publicImageTask(await service.startOperation(projectId, input)) }, { status: 202 })
      }
      if (action === 'submit') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = submitImageProjectInputSchema.parse(await parseJson(req))
        return Response.json({ task: publicImageTask(await service.submitProject(projectId, input)) }, { status: 202 })
      }
      if (action === 'versions') {
        const versionId = segments[6]
        const versionAction = segments[7]
        if (!versionId) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const input = commitImageVersionInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicImageProject(await service.commitVersion(projectId, input)) }, { status: 201 })
        }
        if (versionAction === 'select' && !segments[8] && req.method === 'POST') {
          const input = selectImageVersionInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), version_id: versionId })
          return Response.json({ project: publicImageProject(await service.selectVersion(projectId, input)) })
        }
        if (versionAction === 'save' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = saveImageOutputInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), version_id: versionId })
          return Response.json(await service.saveOutput(projectId, input))
        }
        throw methodNotAllowed(req.method)
      }
      throw ApiError.notFound('找不到生图接口')
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/**
 * The image workbench owns its public HTTP surface.  Its internal route
 * parser predates the split and is deliberately kept private behind this
 * adapter, so no renderer or server composition path needs `/api/media` to
 * reach image state, operations, assets or event replay.
 */
export function createImageWorkbenchDomainApiHandler(
  service: ImageWorkbenchService,
  mediaUiCapability = '',
) {
  const projectHandler = createImageWorkbenchApiHandler(service, mediaUiCapability)
  return async function handleImageWorkbenchDomainApi(
    req: Request,
    url: URL,
    segments: string[],
  ): Promise<Response> {
    try {
      if (segments[1] !== 'images') throw ApiError.notFound('找不到生图接口')
      const area = segments[2]
      if (area === 'deletions') {
        if (req.method !== 'GET' || segments[3]) throw methodNotAllowed(req.method)
        return Response.json({
          deletions: (await service.listDeletions()).map(receipt => publicMediaDeletionReceiptSchema.parse(receipt)),
        })
      }
      if (area === 'operations') {
        const operationId = segments[3]
        if (!operationId || segments[5]) throw ApiError.badRequest('缺少图片操作 ID')
        if (segments[4] === 'cancel') {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          return Response.json({ task: publicImageTask(await service.cancelOperation(operationId)) })
        }
        if (segments[4]) throw ApiError.badRequest('无效的图片操作')
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({ task: publicImageTask(await service.getOperation(operationId)) })
      }
      if (area !== 'projects') throw ApiError.notFound('找不到生图接口')
      const projectId = segments[3]
      const action = segments[4]
      if (projectId && action === 'events') {
        if (req.method !== 'GET' || segments[5]) throw methodNotAllowed(req.method)
        const cursor = Number(url.searchParams.get('cursor') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 100)
        const waitMs = Number(url.searchParams.get('wait_ms') ?? 25_000)
        if (!Number.isInteger(cursor) || cursor < 0) throw ApiError.badRequest('cursor 必须是非负整数')
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw ApiError.badRequest('limit 必须在 1 到 200 之间')
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) throw ApiError.badRequest('wait_ms 必须在 0 到 25000 之间')
        return Response.json(publicImageEventPage(
          await service.waitForOperationEvents(projectId, cursor, limit, waitMs),
        ))
      }
      if (projectId && action === 'restore') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        return Response.json({ deletion: publicMediaDeletionReceiptSchema.parse(await service.restoreProject(projectId)) })
      }
      // Preserve the parser's proven request validation while presenting the
      // image-owned route to callers: /api/images/projects/*.
      return await projectHandler(req, url, ['api', 'media', 'images', ...segments.slice(2)])
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export function publicImageEventPage(page: Awaited<ReturnType<ImageWorkbenchService['waitForOperationEvents']>>) {
  return publicMediaJobEventPageSchema.parse({
    ...page,
    events: page.events.map(publicImageEvent),
  })
}
