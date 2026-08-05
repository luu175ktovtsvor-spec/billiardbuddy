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
  selectImageVersionInputSchema,
  startImageOperationInputSchema,
  submitImageProjectInputSchema,
  updateImageProjectInputSchema,
  MEDIA_UI_CAPABILITY_HEADER,
  type ImageWorkbenchProject,
  type PublicImageWorkbenchProject,
  type PublicMediaTask,
} from '../../../shared/contracts/media.js'
import {
  adoptImageCandidateInputSchema,
  imageArtboardSelectVersionInputSchema,
  imageArtboardSelectVersionResponseSchema,
  imageCanvasCommandInputSchema,
  imageCanvasCommandRequestInputSchema,
  imageCanvasCommandResponseSchema,
  imageCanvasCreateInputSchema,
  imageCanvasPreflightInputSchema,
  imageCanvasPreflightResponseSchema,
  imageCanvasRenderInputSchema,
  imageCanvasRenderResponseSchema,
  imageDeliverySpecRevisionInputSchema,
  imageDeliverySpecRevisionResponseSchema,
  imageExportInputSchema,
  imageExportResponseSchema,
  imageUnderstandingInputSchema,
  imageUnderstandingResponseSchema,
  imageVisualAssessmentInputSchema,
  imageVisualAssessmentResponseSchema,
  imageSaveOutputInputSchema,
  createCreativePlanInputSchema,
  createGenerationRoundInputSchema,
  decideImageCandidateInputSchema,
  deriveImageCandidateInputSchema,
  imageCandidateAdoptionResponseSchema,
  imageCandidateDecisionResponseSchema,
  imageCandidateDerivationResponseSchema,
  imageCreativePlanResponseSchema,
  imageDerivationEstimateResponseSchema,
  imageGenerationCancelResponseSchema,
  imageGenerationRoundEstimateResponseSchema,
  imageGenerationRoundResponseSchema,
  imageReferenceControlResponseSchema,
  estimateDeriveImageCandidateInputSchema,
  estimateGenerationRoundInputSchema,
  publicImageCandidateGroupSchema,
  publicImageCandidateSchema,
  publicImageOperationV2Schema,
  updateImageReferenceControlInputSchema,
  type ImageCandidate,
  type ImageCandidateGroup,
  type ImageOperationV2,
} from '../../../shared/contracts/imageGeneration.js'
import {
  addImageWorkflowReferencesInputSchema,
  applyImageBriefOverridesInputSchema,
  compileImageBriefResponseSchema,
  createImageAssetGrantInputSchema,
  createImageBrandKitInputSchema,
  createImageCampaignInputSchema,
  createImageTemplateInputSchema,
  cancelImageCampaignInputSchema,
  confirmImageCampaignInputSchema,
  deleteImageReusableAggregateInputSchema,
  estimateImageCampaignInputSchema,
  imageAssetGrantListResponseSchema,
  imageAssetGrantResponseSchema,
  imageBrandKitListResponseSchema,
  imageBrandKitResponseSchema,
  imageCampaignConfirmationResponseSchema,
  imageCampaignEstimateResponseSchema,
  imageCampaignListInputSchema,
  imageCampaignListResponseSchema,
  imageCampaignResponseSchema,
  imageInspirationBoardReadResponseSchema,
  imageInspirationBoardResponseSchema,
  imageProjectLibrarySchema,
  imageQuickCreateInputSchema,
  imageQuickCreateResponseSchema,
  imageTemplateListResponseSchema,
  imageTemplateResponseSchema,
  imageWorkbenchProjectListResponseSchema,
  imageWorkbenchProjectProjectionSchema,
  imageWorkflowProjectResponseSchema,
  promoteImageInspirationItemInputSchema,
  removeImageWorkflowReferenceInputSchema,
  replaceImageCampaignItemsInputSchema,
  reviseImageBrandKitInputSchema,
  reviseImageTemplateInputSchema,
  revokeImageAssetGrantInputSchema,
  retryImageCampaignItemInputSchema,
  startImageCampaignInputSchema,
  upsertImageInspirationItemsInputSchema,
} from '../../../shared/contracts/imageWorkflow.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  ImageWorkbenchServiceError,
  type ImageWorkbenchApplications,
} from '../services/imageWorkbenchService.js'
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

function hasOwnField(value: unknown, field: string): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, field)
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

type ImageWorkbenchApiPort = ImageWorkbenchApplications['project']
  & ImageWorkbenchApplications['generation']
  & ImageWorkbenchApplications['canvas']
  & ImageWorkbenchApplications['delivery']
  & ImageWorkbenchApplications['recovery']

/** The API only sees the five application surfaces, never Repository/CAS/runtime. */
function imageApiPort(applications: ImageWorkbenchApplications): ImageWorkbenchApiPort {
  return Object.assign(
    {},
    applications.project,
    applications.generation,
    applications.canvas,
    applications.delivery,
    applications.recovery,
  ) as ImageWorkbenchApiPort
}

function imageContentResponse(value: {
  bytes: Uint8Array
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  content_hash: `sha256:${string}`
}): Response {
  // Copy into an ordinary ArrayBuffer-backed view before crossing the Fetch
  // boundary: Node's Buffer may be typed as ArrayBufferLike/SharedArrayBuffer.
  return new Response(new Blob([Uint8Array.from(value.bytes)]), {
    headers: {
      'Content-Type': value.mime_type,
      'X-BilliardBuddy-Media-Hash': value.content_hash,
      'X-BilliardBuddy-Media-Width': String(value.width),
      'X-BilliardBuddy-Media-Height': String(value.height),
    },
  })
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
    if (!asset || !mimeType) return []
    const imageLayers = (version.image_layers ?? output?.image_layers ?? []).flatMap(layer => {
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
      kind: version.kind ?? output?.version_kind ?? 'generated',
      operation_id: version.operation_id ?? output?.operation_id,
      asset_id: asset.id,
      // The asset id and project ownership are the durable facts. Never reuse
      // an old public URL from a migrated record as this workbench's source.
      image_path: `/api/images/projects/${project.id}/outputs/${asset.id}/content`,
      mime_type: mimeType,
      width: version.width ?? output?.width,
      height: version.height ?? output?.height,
      text_layers: version.text_layers ?? output?.text_layers ?? [],
      image_layers: imageLayers,
      quality_assessment: output?.quality_assessment,
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

function publicGenerationOperation(operation: ImageOperationV2) {
  const {
    owner: _owner,
    idempotency_key: _idempotencyKey,
    request_hash: _requestHash,
    input_refs: _inputRefs,
    transport_task_id: _transportTaskId,
    remote_task_id: _remoteTaskId,
    execution_receipt_id: _executionReceiptId,
    submitted_at: _submittedAt,
    local_delivery: _localDelivery,
    ...safeOperation
  } = operation
  return publicImageOperationV2Schema.parse(safeOperation)
}

function publicCandidate(projectId: string, candidate: ImageCandidate) {
  return publicImageCandidateSchema.parse({
    ...candidate,
    image_path: `/api/images/projects/${projectId}/candidates/${candidate.id}/content`,
  })
}

function publicCandidateGroup(projectId: string, group: ImageCandidateGroup, candidates: ImageCandidate[]) {
  return publicImageCandidateGroupSchema.parse({
    ...group,
    candidates: candidates.map(candidate => publicCandidate(projectId, candidate)),
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
  applications: ImageWorkbenchApplications,
  mediaUiCapability = '',
) {
  const service = imageApiPort(applications)
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
          return Response.json(imageWorkbenchProjectListResponseSchema.parse({
            projects: (await service.listProjects()).map(publicImageProject),
          }))
        }
        if (req.method !== 'POST' || action) throw methodNotAllowed(req.method)
        const input = createImageProjectInputSchema.parse(await parseJson(req))
        requireMediaUiCapability(req, mediaUiCapability)
        return Response.json({ project: publicImageProject(await service.createProject(input)) }, { status: 201 })
      }
      if (!action && req.method === 'DELETE') {
        requireMediaUiCapability(req, mediaUiCapability)
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
        requireMediaUiCapability(req, mediaUiCapability)
        const input = updateImageProjectInputSchema.parse(await parseJson(req))
        return Response.json({ project: publicImageProject(await service.updateProject(projectId, input)) })
      }
      if (action === 'references') {
        const referenceId = segments[6]
        if (!referenceId && req.method === 'POST' && !segments[7]) {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = addImageProjectReferencesInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicImageProject(await service.addReferences(projectId, input)) }, { status: 201 })
        }
        if (!referenceId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await service.readMediaAsset(projectId, referenceId, 'reference'))
      }
      if (action === 'layer-assets') {
        const assetId = segments[6]
        if (!assetId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await service.readMediaAsset(projectId, assetId, 'reference'))
      }
      if (action === 'outputs') {
        const outputId = segments[6]
        if (!outputId) throw ApiError.badRequest('缺少图片结果 ID')
        if (segments[7] === 'content' && !segments[8] && req.method === 'GET') {
          requireMediaUiCapability(req, mediaUiCapability)
          return imageContentResponse(await service.readMediaAsset(projectId, outputId, 'result'))
        }
        if (segments[7] === 'save' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageSaveOutputInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), output_id: outputId })
          return Response.json(await service.saveOutput(projectId, input))
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'export-assets') {
        const assetId = segments[6]
        if (!assetId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await service.readMediaAsset(projectId, assetId, 'export'))
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
          requireMediaUiCapability(req, mediaUiCapability)
          const input = commitImageVersionInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicImageProject(await service.commitVersion(projectId, input)) }, { status: 201 })
        }
        if (versionAction === 'content' && !segments[8] && req.method === 'GET') {
          requireMediaUiCapability(req, mediaUiCapability)
          return imageContentResponse(await service.readVersionAsset(projectId, versionId))
        }
        if (versionAction === 'select' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = selectImageVersionInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), version_id: versionId })
          return Response.json({ project: publicImageProject(await service.selectVersion(projectId, input)) })
        }
        if (versionAction === 'save' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageSaveOutputInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), version_id: versionId })
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
  applications: ImageWorkbenchApplications,
  mediaUiCapability = '',
) {
  const service = imageApiPort(applications)
  const projectHandler = createImageWorkbenchApiHandler(applications, mediaUiCapability)
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
        if (!operationId) throw ApiError.badRequest('缺少图片操作 ID')
        if (segments[4] === 'commands') {
          if (req.method !== 'POST' || segments[5] !== 'cancel' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          return Response.json(imageGenerationCancelResponseSchema.parse({
            operation: publicGenerationOperation(await service.cancelGenerationOperation(operationId)),
          }))
        }
        if (segments[4] === 'cancel') {
          if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          return Response.json({ task: publicImageTask(await service.cancelOperation(operationId)) })
        }
        if (segments[4] || segments[5]) throw ApiError.badRequest('无效的图片操作')
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        const generation = await service.findGenerationOperation(operationId)
        if (generation) return Response.json({ operation: publicGenerationOperation(generation) })
        return Response.json({ task: publicImageTask(await service.getOperation(operationId)) })
      }
      if (area === 'quick-create') {
        if (req.method !== 'POST' || segments[3]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageQuickCreateInputSchema.parse(await parseJson(req))
        const created = await service.quickCreate(input)
        return Response.json(imageQuickCreateResponseSchema.parse({
          project: publicImageProject(created.project),
          round: created.round,
          operations: created.operations.map(publicGenerationOperation),
        }), { status: 202 })
      }
      if (area === 'campaigns') {
        const campaignId = segments[3]
        if (!campaignId) {
          if (req.method === 'GET' && !segments[4]) {
            const rawCursor = url.searchParams.get('cursor')
            const rawLimit = url.searchParams.get('limit')
            const input = imageCampaignListInputSchema.parse({
              ...(rawCursor === null ? {} : { cursor: Number(rawCursor) }),
              ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
            })
            return Response.json(imageCampaignListResponseSchema.parse(await service.listCampaigns(input)))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await service.createCampaign(input)), { status: 201 })
        }
        if (!segments[4] && req.method === 'GET') {
          return Response.json(imageCampaignResponseSchema.parse(await service.getCampaign(campaignId)))
        }
        if (segments[4] === 'estimate' && !segments[5] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = estimateImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignEstimateResponseSchema.parse(await service.estimateCampaign(campaignId, input)))
        }
        if (segments[4] === 'commands' && segments[5] === 'confirm' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = confirmImageCampaignInputSchema.parse(await parseJson(req))
          const confirmed = await service.confirmCampaign(campaignId, input)
          return Response.json(imageCampaignConfirmationResponseSchema.parse({
            campaign: confirmed.campaign,
            confirmation: confirmed.confirmation,
          }))
        }
        if (segments[4] === 'commands' && segments[5] === 'start' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = startImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await service.startCampaign(campaignId, input)), { status: 202 })
        }
        if (segments[4] === 'commands' && segments[5] === 'cancel' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = cancelImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await service.cancelCampaign(campaignId, input)))
        }
        if (
          (
            (segments[4] === 'commands' && segments[5] === 'replace-items' && !segments[6])
            || (segments[4] === 'items' && segments[5] === 'commands' && segments[6] === 'replace' && !segments[7])
          )
          && req.method === 'POST'
        ) {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = replaceImageCampaignItemsInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await service.replaceCampaignItems(campaignId, input)))
        }
        if (segments[4] === 'items' && segments[5] && segments[6] === 'commands' && segments[7] === 'confirm-retry' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = confirmImageCampaignInputSchema.parse(await parseJson(req))
          const confirmed = await service.confirmCampaignRetry(campaignId, segments[5], input)
          return Response.json(imageCampaignConfirmationResponseSchema.parse({
            campaign: confirmed.campaign,
            confirmation: confirmed.confirmation,
          }))
        }
        if (segments[4] === 'items' && segments[5] && segments[6] === 'commands' && segments[7] === 'retry' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = retryImageCampaignItemInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await service.retryCampaignItem(campaignId, segments[5], input)), { status: 202 })
        }
        throw methodNotAllowed(req.method)
      }
      if (area === 'brand-kits') {
        const brandKitId = segments[3]
        if (!brandKitId) {
          if (req.method === 'GET' && !segments[4]) {
            const includeTrashed = url.searchParams.get('include_trashed') === '1'
            return Response.json(imageBrandKitListResponseSchema.parse({ brand_kits: await service.listBrandKits(includeTrashed) }))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageBrandKitInputSchema.parse(await parseJson(req))
          return Response.json(imageBrandKitResponseSchema.parse(await service.createBrandKit(input)), { status: 201 })
        }
        if (!segments[4] && req.method === 'GET') {
          return Response.json(imageBrandKitResponseSchema.parse(await service.getBrandKit(brandKitId)))
        }
        if (segments[4] === 'revisions' && !segments[5] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = reviseImageBrandKitInputSchema.parse(await parseJson(req))
          return Response.json(imageBrandKitResponseSchema.parse(await service.reviseBrandKit(brandKitId, input)))
        }
        if (segments[4] === 'commands' && segments[5] === 'trash' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = deleteImageReusableAggregateInputSchema.parse(await parseJson(req))
          return Response.json(imageBrandKitResponseSchema.parse(await service.trashBrandKit(brandKitId, input)))
        }
        throw methodNotAllowed(req.method)
      }
      if (area === 'templates') {
        const templateId = segments[3]
        if (!templateId) {
          if (req.method === 'GET' && !segments[4]) {
            const includeTrashed = url.searchParams.get('include_trashed') === '1'
            return Response.json(imageTemplateListResponseSchema.parse({ templates: await service.listTemplates(includeTrashed) }))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageTemplateInputSchema.parse(await parseJson(req))
          return Response.json(imageTemplateResponseSchema.parse(await service.createTemplate(input)), { status: 201 })
        }
        if (!segments[4] && req.method === 'GET') {
          return Response.json(imageTemplateResponseSchema.parse(await service.getTemplate(templateId)))
        }
        if (segments[4] === 'revisions' && !segments[5] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = reviseImageTemplateInputSchema.parse(await parseJson(req))
          return Response.json(imageTemplateResponseSchema.parse(await service.reviseTemplate(templateId, input)))
        }
        if (segments[4] === 'commands' && segments[5] === 'trash' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = deleteImageReusableAggregateInputSchema.parse(await parseJson(req))
          return Response.json(imageTemplateResponseSchema.parse(await service.trashTemplate(templateId, input)))
        }
        throw methodNotAllowed(req.method)
      }
      if (area === 'asset-grants') {
        const grantId = segments[3]
        if (!grantId) {
          if (req.method === 'GET' && !segments[4]) {
            const includeRevoked = url.searchParams.get('include_revoked') === '1'
            return Response.json(imageAssetGrantListResponseSchema.parse({ grants: await service.listAssetGrants(includeRevoked) }))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageAssetGrantInputSchema.parse(await parseJson(req))
          return Response.json(imageAssetGrantResponseSchema.parse({ grant: await service.createAssetGrant(input) }), { status: 201 })
        }
        if (segments[4] === 'commands' && segments[5] === 'revoke' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = revokeImageAssetGrantInputSchema.parse(await parseJson(req))
          return Response.json(imageAssetGrantResponseSchema.parse({ grant: await service.revokeAssetGrant(grantId, input) }))
        }
        throw methodNotAllowed(req.method)
      }
      if (area !== 'projects') throw ApiError.notFound('找不到生图接口')
      const projectId = segments[3]
      const action = segments[4]
      if (projectId && action === 'projection') {
        if (req.method !== 'GET' || segments[5]) throw methodNotAllowed(req.method)
        const projection = await service.getProjectProjection(projectId)
        return Response.json(imageWorkbenchProjectProjectionSchema.parse({
          project: publicImageProject(projection.project),
          inspiration_board: projection.inspiration_board,
          creative_plans: projection.creative_plans,
          generation_rounds: projection.generation_rounds,
          operations: projection.operations.map(publicGenerationOperation),
          candidate_groups: projection.candidate_groups.map(({ group, candidates }) =>
            publicCandidateGroup(projectId, group, candidates)),
          canvases: projection.canvases,
          delivery_spec: projection.delivery_spec,
          library: projection.library,
          campaign_intent: projection.campaign_intent,
        }))
      }
      if (projectId && action === 'library') {
        if (req.method !== 'GET' || segments[5]) throw methodNotAllowed(req.method)
        return Response.json(imageProjectLibrarySchema.parse(await service.listProjectLibrary(projectId)))
      }
      if (projectId && action === 'inspiration-board') {
        await service.assertProjectOwner(projectId)
        if (!segments[5] && req.method === 'GET') {
          return Response.json(imageInspirationBoardReadResponseSchema.parse({
            board: await service.getInspirationBoard(projectId),
          }))
        }
        if (segments[5] === 'commands' && segments[6] === 'upsert-items' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = upsertImageInspirationItemsInputSchema.parse(await parseJson(req))
          const saved = await service.upsertInspirationItems(projectId, input)
          return Response.json(imageInspirationBoardResponseSchema.parse({
            project: publicImageProject(saved.project), board: saved.board,
          }))
        }
        if (segments[5] === 'items' && segments[6] && segments[7] === 'commands' && segments[8] === 'promote' && !segments[9] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = promoteImageInspirationItemInputSchema.parse(await parseJson(req))
          const saved = await service.promoteInspirationItem(projectId, segments[6], input)
          return Response.json(imageInspirationBoardResponseSchema.parse({
            project: publicImageProject(saved.project), board: saved.board,
          }))
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'brief') {
        await service.assertProjectOwner(projectId)
        if (segments[5] === 'compile' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const compiled = await service.compileBrief(projectId)
          return Response.json(compileImageBriefResponseSchema.parse({
            project: publicImageProject(compiled.project),
            brief_id: compiled.brief.id,
            snapshot_hash: compiled.brief.snapshot_hash,
          }))
        }
        if (segments[5] === 'commands' && segments[6] === 'apply-overrides' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = applyImageBriefOverridesInputSchema.parse(await parseJson(req))
          return Response.json(imageWorkflowProjectResponseSchema.parse({
            project: publicImageProject(await service.applyBriefOverrides(projectId, input)),
          }))
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'references') {
        await service.assertProjectOwner(projectId)
        const referenceId = segments[5]
        if (!referenceId && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const raw = await parseJson(req)
          const workflowReferences = hasOwnField(raw, 'references')
          const legacyReferences = hasOwnField(raw, 'reference_images')
          if (workflowReferences && legacyReferences) {
            throw ApiError.badRequest('参考图请求不能同时使用 references 与 reference_images')
          }
          if (workflowReferences) {
            const input = addImageWorkflowReferencesInputSchema.parse(raw)
            return Response.json(imageWorkflowProjectResponseSchema.parse({
              project: publicImageProject(await service.addWorkflowReferences(projectId, input)),
            }), { status: 201 })
          }
          if (legacyReferences) {
            const input = addImageProjectReferencesInputSchema.parse(raw)
            return Response.json({ project: publicImageProject(await service.addReferences(projectId, input)) }, { status: 201 })
          }
          throw ApiError.badRequest('参考图请求缺少 references 或 reference_images')
        }
        if (referenceId && segments[6] === 'commands' && segments[7] === 'remove' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = removeImageWorkflowReferenceInputSchema.parse(await parseJson(req))
          return Response.json(imageWorkflowProjectResponseSchema.parse({
            project: publicImageProject(await service.removeWorkflowReference(projectId, referenceId, input)),
          }))
        }
      }
      if (projectId && action === 'delivery-spec') {
        if (!segments[5] && req.method === 'GET') {
          const spec = await service.currentDeliverySpec(projectId)
          if (!spec) throw new ImageWorkbenchServiceError('交付规格不存在', 404, 'IMAGE_OPERATION_CORRUPT')
          return Response.json({ delivery_spec: spec })
        }
        if (segments[5] === 'revisions' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageDeliverySpecRevisionInputSchema.parse(await parseJson(req))
          const created = await service.createDeliverySpecRevision(projectId, input)
          return Response.json(imageDeliverySpecRevisionResponseSchema.parse({ project: publicImageProject(created.project), delivery_spec: created.spec }), { status: 201 })
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'versions' && !segments[5] && req.method === 'GET') {
        return Response.json({ versions: publicImageProject(await service.getProject(projectId)).version_history })
      }
      if (projectId && action === 'versions' && segments[5] && segments[6] === 'content' && !segments[7] && req.method === 'GET') {
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await service.readVersionAsset(projectId, segments[5]))
      }
      if (projectId && action === 'versions' && segments[5] && segments[6] === 'visual-assessments' && !segments[7] && req.method === 'POST') {
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageVisualAssessmentInputSchema.parse(await parseJson(req))
        return Response.json(imageVisualAssessmentResponseSchema.parse({
          assessment: await service.assessVersionVisual(projectId, segments[5], input),
        }))
      }
      if (projectId && action === 'artboards') {
        const artboardId = segments[5]
        if (!artboardId || segments[6] !== 'commands' || segments[7] !== 'select-version' || segments[8] || req.method !== 'POST') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageArtboardSelectVersionInputSchema.parse(await parseJson(req))
        return Response.json(imageArtboardSelectVersionResponseSchema.parse({
          project: publicImageProject(await service.selectArtboardVersion(projectId, artboardId, input)),
        }))
      }
      if (projectId && action === 'delivery-specs') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageDeliverySpecRevisionInputSchema.parse(await parseJson(req))
        const created = await service.createDeliverySpecRevision(projectId, input)
        return Response.json(imageDeliverySpecRevisionResponseSchema.parse({ project: publicImageProject(created.project), delivery_spec: created.spec }), { status: 201 })
      }
      if (projectId && action === 'canvases') {
        const canvasId = segments[5]
        const canvasAction = segments[6]
        if (!canvasId) {
          if (req.method === 'GET' && !canvasAction) return Response.json({ canvases: await service.listCanvases(projectId) })
          if (req.method !== 'POST' || canvasAction) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasCreateInputSchema.parse(await parseJson(req))
          const created = await service.createCanvas(projectId, input)
          return Response.json(imageCanvasCommandResponseSchema.parse({ canvas: created.canvas, project_revision: created.project.revision }), { status: 201 })
        }
        if (!canvasAction) {
          if (req.method !== 'GET' || segments[7]) throw methodNotAllowed(req.method)
          const revisionValue = url.searchParams.get('revision')
          const revision = revisionValue === null ? undefined : Number(revisionValue)
          if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw ApiError.badRequest('revision 必须是非负整数')
          return Response.json({ canvas: await service.getCanvas(projectId, canvasId, revision) })
        }
        if (canvasAction === 'revisions') {
          const revision = Number(segments[7])
          if (req.method !== 'GET' || segments[8] || !Number.isInteger(revision) || revision < 0) throw methodNotAllowed(req.method)
          return Response.json({ canvas: await service.getCanvas(projectId, canvasId, revision) })
        }
        if (canvasAction === 'commands' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasCommandRequestInputSchema.parse(await parseJson(req))
          const changed = await service.applyCanvasCommand(projectId, canvasId, input.base_project_revision, input.command)
          return Response.json(imageCanvasCommandResponseSchema.parse({ canvas: changed.canvas, project_revision: changed.project.revision }))
        }
        if ((canvasAction === 'preflight' || canvasAction === 'preflights') && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasPreflightInputSchema.parse(await parseJson(req))
          return Response.json(imageCanvasPreflightResponseSchema.parse({ preflight: await service.preflightCanvas(projectId, canvasId, input) }))
        }
        if ((canvasAction === 'render' || canvasAction === 'renders') && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasRenderInputSchema.parse(await parseJson(req))
          const rendered = await service.renderCanvas(projectId, canvasId, input)
          return Response.json(imageCanvasRenderResponseSchema.parse({ operation: publicGenerationOperation(rendered.operation), ...(rendered.version_id ? { version_id: rendered.version_id, render_receipt: rendered.render_receipt, release_check: rendered.release_check } : {}) }), { status: 202 })
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'exports') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageExportInputSchema.parse(await parseJson(req))
        const queued = await service.exportDelivery(projectId, input)
        return Response.json(imageExportResponseSchema.parse({ ...queued, operation: publicGenerationOperation(queued.operation) }), { status: 202 })
      }
      if (projectId && action === 'delivery-sets') {
        const deliverySetId = segments[5]
        if (!deliverySetId || req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        return Response.json({ delivery_set: await service.getDeliverySet(projectId, deliverySetId) })
      }
      if (projectId && action === 'export-receipts') {
        const receiptId = segments[5]
        if (!receiptId || req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        return Response.json({ export_receipt: await service.getExportReceipt(projectId, receiptId) })
      }
      if (projectId && action === 'creative-plans') {
        const planId = segments[5]
        if (!planId) {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createCreativePlanInputSchema.parse(await parseJson(req))
          return Response.json(imageCreativePlanResponseSchema.parse({
            plan: await service.createCreativePlan(projectId, input),
          }), { status: 201 })
        }
        if (req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        return Response.json({ plan: await service.getCreativePlan(projectId, planId) })
      }
      if (projectId && action === 'understanding') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageUnderstandingInputSchema.parse(await parseJson(req))
        return Response.json(imageUnderstandingResponseSchema.parse({
          suggestion: await service.understandProject(projectId, input),
        }))
      }
      if (projectId && action === 'references') {
        const referenceId = segments[5]
        if (referenceId && segments[6] === 'commands' && segments[7] === 'update-control' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = updateImageReferenceControlInputSchema.parse(await parseJson(req))
          return Response.json(imageReferenceControlResponseSchema.parse({
            project: publicImageProject(await service.updateReferenceControl(projectId, referenceId, input)),
          }))
        }
      }
      if (projectId && action === 'generation-rounds') {
        const roundId = segments[5]
        if (roundId === 'estimate') {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = estimateGenerationRoundInputSchema.parse(await parseJson(req))
          return Response.json(imageGenerationRoundEstimateResponseSchema.parse(
            await service.estimateGenerationRound(projectId, input),
          ))
        }
        if (!roundId) {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createGenerationRoundInputSchema.parse(await parseJson(req))
          const created = await service.createGenerationRound(projectId, input)
          return Response.json(imageGenerationRoundResponseSchema.parse({
            round: created.round,
            operations: created.operations.map(publicGenerationOperation),
          }), { status: 202 })
        }
        if (req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        const result = await service.getGenerationRound(projectId, roundId)
        return Response.json(imageGenerationRoundResponseSchema.parse({
          round: result.round,
          operations: result.operations.map(publicGenerationOperation),
        }))
      }
      if (projectId && action === 'candidate-groups') {
        const groupId = segments[5]
        if (!groupId || req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        const result = await service.getCandidateGroup(projectId, groupId)
        return Response.json({ candidate_group: publicCandidateGroup(projectId, result.group, result.candidates) })
      }
      if (projectId && action === 'candidates') {
        const candidateId = segments[5]
        const candidateAction = segments[6]
        if (!candidateId) throw ApiError.badRequest('缺少图片候选 ID')
        if (candidateAction === 'content' && !segments[7] && req.method === 'GET') {
          requireMediaUiCapability(req, mediaUiCapability)
          return imageContentResponse(await service.readCandidateAsset(projectId, candidateId))
        }
        if (candidateAction === 'decisions' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = decideImageCandidateInputSchema.parse(await parseJson(req))
          return Response.json(imageCandidateDecisionResponseSchema.parse({
            decision: await service.decideCandidate(projectId, candidateId, input),
          }))
        }
        if (candidateAction === 'visual-assessments' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageVisualAssessmentInputSchema.parse(await parseJson(req))
          return Response.json(imageVisualAssessmentResponseSchema.parse({
            assessment: await service.assessCandidateVisual(projectId, candidateId, input),
          }))
        }
        if (candidateAction === 'adoptions' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = adoptImageCandidateInputSchema.parse(await parseJson(req))
          const adopted = await service.adoptCandidate(projectId, candidateId, input)
          return Response.json(imageCandidateAdoptionResponseSchema.parse({
            project: publicImageProject(adopted.project),
            adoptions: adopted.adoptions,
          }))
        }
        if (candidateAction === 'derivations' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = deriveImageCandidateInputSchema.parse(await parseJson(req))
          const derived = await service.deriveCandidate(projectId, candidateId, input)
          return Response.json(imageCandidateDerivationResponseSchema.parse({
            round: derived.round,
            operation: publicGenerationOperation(derived.operation),
          }), { status: 202 })
        }
        if (candidateAction === 'derivations' && segments[7] === 'estimate' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = estimateDeriveImageCandidateInputSchema.parse(await parseJson(req))
          return Response.json(imageDerivationEstimateResponseSchema.parse(
            await service.estimateDerivation(projectId, candidateId, input),
          ))
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'operations' && !segments[5] && req.method === 'GET') {
        return Response.json({ operations: (await service.listGenerationOperations(projectId)).map(publicGenerationOperation) })
      }
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
        requireMediaUiCapability(req, mediaUiCapability)
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

export function publicImageEventPage(page: Awaited<ReturnType<ImageWorkbenchApplications['recovery']['waitForOperationEvents']>>) {
  return publicMediaJobEventPageSchema.parse({
    ...page,
    events: page.events.map(publicImageEvent),
  })
}
