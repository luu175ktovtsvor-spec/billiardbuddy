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
  deriveImageVersionInputSchema,
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
  estimateDeriveImageVersionInputSchema,
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
  imageGenerationPreferencesCatalogResponseSchema,
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
  IMAGE_WORKBENCH_REQUEST_BODY_MAX_BYTES,
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
import {
  ImageUiCapabilityReplayGuard,
  verifyImageUiCapabilityTicket,
} from '../../../shared/product/imageUiCapabilityTicket.js'

/** Image tickets have their own Main-to-sidecar secret; video keeps its legacy capability. */
export function consumeImageUiTicketSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.BB_IMAGE_UI_TICKET_SECRET?.trim() ?? ''
  delete env.BB_IMAGE_UI_TICKET_SECRET
  return secret
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}

const rawRequestBodies = new WeakMap<Request, Promise<string>>()

/**
 * The image workbench receives Base64 uploads in command JSON.  Never use
 * Request.text() here: it can allocate an attacker-controlled body before the
 * parser, ticket verifier, or schema has a chance to reject it.
 */
export async function readImageWorkbenchRequestBody(
  req: Request,
  maxBytes = IMAGE_WORKBENCH_REQUEST_BODY_MAX_BYTES,
): Promise<string> {
  const declaredLength = req.headers.get('content-length')?.trim()
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new ApiError(413, '图片请求体超过安全上限', 'IMAGE_REQUEST_BODY_TOO_LARGE')
  }
  if (!req.body) return ''

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw new ApiError(413, '图片请求体超过安全上限', 'IMAGE_REQUEST_BODY_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function rawRequestBody(req: Request): Promise<string> {
  const existing = rawRequestBodies.get(req)
  if (existing) return existing
  const body = readImageWorkbenchRequestBody(req)
  rawRequestBodies.set(req, body)
  return body
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return JSON.parse(await rawRequestBody(req)) as unknown
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

type ImageTicketAuthorization = { readonly verified: boolean }

class ImageTicketGate {
  readonly #replayGuard = new ImageUiCapabilityReplayGuard()
  readonly #authorizations = new WeakMap<Request, Promise<ImageTicketAuthorization>>()
  readonly #verifiedRequests = new WeakSet<Request>()

  constructor(private readonly secret: string) {}

  isVerified(req: Request): boolean {
    return this.#verifiedRequests.has(req)
  }

  authorize(req: Request, url: URL): Promise<ImageTicketAuthorization> {
    const existing = this.#authorizations.get(req)
    if (existing) return existing
    const authorization = (async () => {
      const ticket = req.headers.get(MEDIA_UI_CAPABILITY_HEADER)?.trim() ?? ''
      if (!ticket) return { verified: false } as const
      let requestUrl: URL
      try {
        requestUrl = new URL(req.url)
      } catch {
        throw new ImageWorkbenchServiceError('图片桌面授权票据无效', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
      }
      // `url` is the sidecar's parsed socket request. Do not trust a caller
      // that hands the handler a different Host/path/origin than Request.url.
      if (requestUrl.origin !== url.origin || requestUrl.pathname !== url.pathname || requestUrl.search !== url.search) {
        throw new ImageWorkbenchServiceError('图片桌面授权票据无效', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
      }
      const host = req.headers.get('host')?.trim() ?? ''
      if (host && host !== url.host) {
        throw new ImageWorkbenchServiceError('图片桌面授权票据无效', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
      }
      const origin = req.headers.get('origin')?.trim() ?? ''
      if (!origin || origin !== url.origin) {
        throw new ImageWorkbenchServiceError('图片桌面授权票据无效', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
      }
      const verified = verifyImageUiCapabilityTicket(this.secret, ticket, {
        method: req.method,
        url,
        body: await rawRequestBody(req),
        range: req.headers.get('range'),
      }, this.#replayGuard)
      if (!verified) {
        throw new ImageWorkbenchServiceError('图片桌面授权票据无效', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
      }
      this.#verifiedRequests.add(req)
      return { verified: true } as const
    })()
    this.#authorizations.set(req, authorization)
    return authorization
  }
}

function requireMediaUiCapability(req: Request, ticketGate: ImageTicketGate): void {
  if (!ticketGate.isVerified(req)) {
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
      ...(version.artboard_id ? { artboard_id: version.artboard_id } : {}),
      ...(version.canvas_id ? { canvas_id: version.canvas_id } : {}),
      ...(version.canvas_revision === undefined ? {} : { canvas_revision: version.canvas_revision }),
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

function createImageWorkbenchApiHandlerWithGate(
  applications: ImageWorkbenchApplications,
  ticketGate: ImageTicketGate,
) {
  const { project, generation, delivery, recovery } = applications
  // Keep the proven route parser call sites compact: this is a verifier
  // object, not the old renderer-readable static bearer.
  const mediaUiCapability = ticketGate
  return async function handleImageWorkbenchApi(
    req: Request,
    url: URL,
    segments: string[],
  ): Promise<Response> {
    try {
      await ticketGate.authorize(req, url)
      if (segments[2] !== 'images' || segments[3] !== 'projects') throw ApiError.notFound('找不到生图接口')
      const projectId = segments[4]
      const action = segments[5]
      if (!projectId) {
        if (req.method === 'GET' && !action) {
          return Response.json(imageWorkbenchProjectListResponseSchema.parse({
            projects: (await project.listProjects()).map(publicImageProject),
          }))
        }
        if (req.method !== 'POST' || action) throw methodNotAllowed(req.method)
        const input = createImageProjectInputSchema.parse(await parseJson(req))
        requireMediaUiCapability(req, mediaUiCapability)
        return Response.json({ project: publicImageProject(await project.createProject(input)) }, { status: 201 })
      }
      if (!action && req.method === 'DELETE') {
        requireMediaUiCapability(req, mediaUiCapability)
        const existingProject = await project.getProject(projectId).catch(error => {
          if (error instanceof ImageWorkbenchServiceError && error.code === 'IMAGE_PROJECT_NOT_FOUND') return null
          throw error
        })
        if (existingProject) await recovery.deleteProject(projectId)
        else if (!(await recovery.hasProjectHistory(projectId))) {
          throw new ImageWorkbenchServiceError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
        }
        return new Response(null, { status: 204 })
      }
      await project.assertProjectOwner(projectId)
      if (!action) {
        if (req.method === 'GET') return Response.json({ project: publicImageProject(await project.getProject(projectId)) })
        if (req.method !== 'PUT') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = updateImageProjectInputSchema.parse(await parseJson(req))
        return Response.json({ project: publicImageProject(await project.updateProject(projectId, input)) })
      }
      if (action === 'references') {
        const referenceId = segments[6]
        if (!referenceId && req.method === 'POST' && !segments[7]) {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = addImageProjectReferencesInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicImageProject(await project.addReferences(projectId, input)) }, { status: 201 })
        }
        if (!referenceId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await delivery.readMediaAsset(projectId, referenceId, 'reference'))
      }
      if (action === 'layer-assets') {
        const assetId = segments[6]
        if (!assetId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await delivery.readMediaAsset(projectId, assetId, 'reference'))
      }
      if (action === 'outputs') {
        const outputId = segments[6]
        if (!outputId) throw ApiError.badRequest('缺少图片结果 ID')
        if (segments[7] === 'content' && !segments[8] && req.method === 'GET') {
          requireMediaUiCapability(req, mediaUiCapability)
          return imageContentResponse(await delivery.readMediaAsset(projectId, outputId, 'result'))
        }
        if (segments[7] === 'save' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageSaveOutputInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), output_id: outputId })
          return Response.json(await delivery.saveOutput(projectId, input))
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'export-assets') {
        const assetId = segments[6]
        if (!assetId || segments[7] !== 'content' || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await delivery.readMediaAsset(projectId, assetId, 'export'))
      }
      if (action === 'operations') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = startImageOperationInputSchema.parse(await parseJson(req))
        return Response.json({ task: publicImageTask(await generation.startOperation(projectId, input)) }, { status: 202 })
      }
      if (action === 'submit') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = submitImageProjectInputSchema.parse(await parseJson(req))
        return Response.json({ task: publicImageTask(await generation.submitProject(projectId, input)) }, { status: 202 })
      }
      if (action === 'versions') {
        const versionId = segments[6]
        const versionAction = segments[7]
        if (!versionId) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = commitImageVersionInputSchema.parse(await parseJson(req))
          return Response.json({ project: publicImageProject(await delivery.commitVersion(projectId, input)) }, { status: 201 })
        }
        if (versionAction === 'content' && !segments[8] && req.method === 'GET') {
          requireMediaUiCapability(req, mediaUiCapability)
          return imageContentResponse(await delivery.readVersionAsset(projectId, versionId))
        }
        if (versionAction === 'select' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = selectImageVersionInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), version_id: versionId })
          return Response.json({ project: publicImageProject(await delivery.selectVersion(projectId, input)) })
        }
        if (versionAction === 'save' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageSaveOutputInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), version_id: versionId })
          return Response.json(await delivery.saveOutput(projectId, input))
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
export function createImageWorkbenchApiHandler(
  applications: ImageWorkbenchApplications,
  imageUiTicketSecret = '',
) {
  return createImageWorkbenchApiHandlerWithGate(applications, new ImageTicketGate(imageUiTicketSecret))
}

export function createImageWorkbenchDomainApiHandler(
  applications: ImageWorkbenchApplications,
  imageUiTicketSecret = '',
) {
  const { project, generation, canvas, delivery, recovery } = applications
  const ticketGate = new ImageTicketGate(imageUiTicketSecret)
  // See createImageWorkbenchApiHandlerWithGate: this local is a ticket gate,
  // retained only while every legacy protected route is mechanically moved.
  const mediaUiCapability = ticketGate
  const projectHandler = createImageWorkbenchApiHandlerWithGate(applications, ticketGate)
  return async function handleImageWorkbenchDomainApi(
    req: Request,
    url: URL,
    segments: string[],
  ): Promise<Response> {
    try {
      await ticketGate.authorize(req, url)
      if (segments[1] !== 'images') throw ApiError.notFound('找不到生图接口')
      const area = segments[2]
      if (area === 'deletions') {
        if (req.method !== 'GET' || segments[3]) throw methodNotAllowed(req.method)
        return Response.json({
          deletions: (await recovery.listDeletions()).map(receipt => publicMediaDeletionReceiptSchema.parse(receipt)),
        })
      }
      if (area === 'operations') {
        const operationId = segments[3]
        if (!operationId) throw ApiError.badRequest('缺少图片操作 ID')
        if (segments[4] === 'commands') {
          if (req.method !== 'POST' || segments[5] !== 'cancel' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          return Response.json(imageGenerationCancelResponseSchema.parse({
            operation: publicGenerationOperation(await generation.cancelGenerationOperation(operationId)),
          }))
        }
        if (segments[4] === 'cancel') {
          if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          return Response.json({ task: publicImageTask(await recovery.cancelOperation(operationId)) })
        }
        if (segments[4] || segments[5]) throw ApiError.badRequest('无效的图片操作')
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        const generationOperation = await generation.findGenerationOperation(operationId)
        if (generationOperation) return Response.json({ operation: publicGenerationOperation(generationOperation) })
        return Response.json({ task: publicImageTask(await recovery.getOperation(operationId)) })
      }
      if (area === 'generation-preferences') {
        if (req.method !== 'GET' || segments[3]) throw methodNotAllowed(req.method)
        return Response.json(imageGenerationPreferencesCatalogResponseSchema.parse({
          generation_preferences: project.generationPreferencesCatalog(),
        }))
      }
      if (area === 'quick-create') {
        if (req.method !== 'POST' || segments[3]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageQuickCreateInputSchema.parse(await parseJson(req))
        // The public desktop entry is intentionally prepare-only.  It creates
        // the durable Project and inputs, then the user reviews non-billable
        // advice and confirms the estimate through the formal Generation
        // Application before any paid Provider boundary is crossed.
        const created = await project.quickCreate(input, { mode: 'prepare' })
        return Response.json(imageQuickCreateResponseSchema.parse({
          mode: created.mode,
          project: publicImageProject(created.project),
          ...(created.mode === 'started'
            ? {
                round: created.round,
                operations: created.operations.map(publicGenerationOperation),
              }
            : {}),
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
            return Response.json(imageCampaignListResponseSchema.parse(await delivery.listCampaigns(input)))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await delivery.createCampaign(input)), { status: 201 })
        }
        if (!segments[4] && req.method === 'GET') {
          return Response.json(imageCampaignResponseSchema.parse(await delivery.getCampaign(campaignId)))
        }
        if (segments[4] === 'estimate' && !segments[5] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = estimateImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignEstimateResponseSchema.parse(await delivery.estimateCampaign(campaignId, input)))
        }
        if (segments[4] === 'commands' && segments[5] === 'confirm' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = confirmImageCampaignInputSchema.parse(await parseJson(req))
          const confirmed = await delivery.confirmCampaign(campaignId, input)
          return Response.json(imageCampaignConfirmationResponseSchema.parse({
            campaign: confirmed.campaign,
            confirmation: confirmed.confirmation,
          }))
        }
        if (segments[4] === 'commands' && segments[5] === 'start' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = startImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await delivery.startCampaign(campaignId, input)), { status: 202 })
        }
        if (segments[4] === 'commands' && segments[5] === 'cancel' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = cancelImageCampaignInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await delivery.cancelCampaign(campaignId, input)))
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
          return Response.json(imageCampaignResponseSchema.parse(await delivery.replaceCampaignItems(campaignId, input)))
        }
        if (segments[4] === 'items' && segments[5] && segments[6] === 'commands' && segments[7] === 'confirm-retry' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = confirmImageCampaignInputSchema.parse(await parseJson(req))
          const confirmed = await delivery.confirmCampaignRetry(campaignId, segments[5], input)
          return Response.json(imageCampaignConfirmationResponseSchema.parse({
            campaign: confirmed.campaign,
            confirmation: confirmed.confirmation,
          }))
        }
        if (segments[4] === 'items' && segments[5] && segments[6] === 'commands' && segments[7] === 'retry' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = retryImageCampaignItemInputSchema.parse(await parseJson(req))
          return Response.json(imageCampaignResponseSchema.parse(await delivery.retryCampaignItem(campaignId, segments[5], input)), { status: 202 })
        }
        throw methodNotAllowed(req.method)
      }
      if (area === 'brand-kits') {
        const brandKitId = segments[3]
        if (!brandKitId) {
          if (req.method === 'GET' && !segments[4]) {
            const includeTrashed = url.searchParams.get('include_trashed') === '1'
            return Response.json(imageBrandKitListResponseSchema.parse({ brand_kits: await project.listBrandKits(includeTrashed) }))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageBrandKitInputSchema.parse(await parseJson(req))
          return Response.json(imageBrandKitResponseSchema.parse(await project.createBrandKit(input)), { status: 201 })
        }
        if (!segments[4] && req.method === 'GET') {
          return Response.json(imageBrandKitResponseSchema.parse(await project.getBrandKit(brandKitId)))
        }
        if (segments[4] === 'revisions' && !segments[5] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = reviseImageBrandKitInputSchema.parse(await parseJson(req))
          return Response.json(imageBrandKitResponseSchema.parse(await project.reviseBrandKit(brandKitId, input)))
        }
        if (segments[4] === 'commands' && segments[5] === 'trash' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = deleteImageReusableAggregateInputSchema.parse(await parseJson(req))
          return Response.json(imageBrandKitResponseSchema.parse(await project.trashBrandKit(brandKitId, input)))
        }
        throw methodNotAllowed(req.method)
      }
      if (area === 'templates') {
        const templateId = segments[3]
        if (!templateId) {
          if (req.method === 'GET' && !segments[4]) {
            const includeTrashed = url.searchParams.get('include_trashed') === '1'
            return Response.json(imageTemplateListResponseSchema.parse({ templates: await project.listTemplates(includeTrashed) }))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageTemplateInputSchema.parse(await parseJson(req))
          return Response.json(imageTemplateResponseSchema.parse(await project.createTemplate(input)), { status: 201 })
        }
        if (!segments[4] && req.method === 'GET') {
          return Response.json(imageTemplateResponseSchema.parse(await project.getTemplate(templateId)))
        }
        if (segments[4] === 'revisions' && !segments[5] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = reviseImageTemplateInputSchema.parse(await parseJson(req))
          return Response.json(imageTemplateResponseSchema.parse(await project.reviseTemplate(templateId, input)))
        }
        if (segments[4] === 'commands' && segments[5] === 'trash' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = deleteImageReusableAggregateInputSchema.parse(await parseJson(req))
          return Response.json(imageTemplateResponseSchema.parse(await project.trashTemplate(templateId, input)))
        }
        throw methodNotAllowed(req.method)
      }
      if (area === 'asset-grants') {
        const grantId = segments[3]
        if (!grantId) {
          if (req.method === 'GET' && !segments[4]) {
            const includeRevoked = url.searchParams.get('include_revoked') === '1'
            return Response.json(imageAssetGrantListResponseSchema.parse({ grants: await project.listAssetGrants(includeRevoked) }))
          }
          if (req.method !== 'POST' || segments[4]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createImageAssetGrantInputSchema.parse(await parseJson(req))
          return Response.json(imageAssetGrantResponseSchema.parse({ grant: await project.createAssetGrant(input) }), { status: 201 })
        }
        if (segments[4] === 'commands' && segments[5] === 'revoke' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = revokeImageAssetGrantInputSchema.parse(await parseJson(req))
          return Response.json(imageAssetGrantResponseSchema.parse({ grant: await project.revokeAssetGrant(grantId, input) }))
        }
        throw methodNotAllowed(req.method)
      }
      if (area !== 'projects') throw ApiError.notFound('找不到生图接口')
      const projectId = segments[3]
      const action = segments[4]
      if (projectId && action === 'projection') {
        if (req.method !== 'GET' || segments[5]) throw methodNotAllowed(req.method)
        const projection = await project.getProjectProjection(projectId)
        return Response.json(imageWorkbenchProjectProjectionSchema.parse({
          project: publicImageProject(projection.project),
          inspiration_board: projection.inspiration_board,
          creative_plans: projection.creative_plans,
          generation_rounds: projection.generation_rounds,
          operations: projection.operations.map(publicGenerationOperation),
          latest_understanding_suggestion: projection.latest_understanding_suggestion,
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
        return Response.json(imageProjectLibrarySchema.parse(await delivery.listProjectLibrary(projectId)))
      }
      if (projectId && action === 'inspiration-board') {
        await project.assertProjectOwner(projectId)
        if (!segments[5] && req.method === 'GET') {
          return Response.json(imageInspirationBoardReadResponseSchema.parse({
            board: await project.getInspirationBoard(projectId),
          }))
        }
        if (segments[5] === 'commands' && segments[6] === 'upsert-items' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = upsertImageInspirationItemsInputSchema.parse(await parseJson(req))
          const saved = await project.upsertInspirationItems(projectId, input)
          return Response.json(imageInspirationBoardResponseSchema.parse({
            project: publicImageProject(saved.project), board: saved.board,
          }))
        }
        if (segments[5] === 'items' && segments[6] && segments[7] === 'commands' && segments[8] === 'promote' && !segments[9] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = promoteImageInspirationItemInputSchema.parse(await parseJson(req))
          const saved = await project.promoteInspirationItem(projectId, segments[6], input)
          return Response.json(imageInspirationBoardResponseSchema.parse({
            project: publicImageProject(saved.project), board: saved.board,
          }))
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'brief') {
        await project.assertProjectOwner(projectId)
        if (segments[5] === 'compile' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const compiled = await project.compileBrief(projectId)
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
            project: publicImageProject(await project.applyBriefOverrides(projectId, input)),
          }))
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'references') {
        await project.assertProjectOwner(projectId)
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
              project: publicImageProject(await project.addWorkflowReferences(projectId, input)),
            }), { status: 201 })
          }
          if (legacyReferences) {
            const input = addImageProjectReferencesInputSchema.parse(raw)
            return Response.json({ project: publicImageProject(await project.addReferences(projectId, input)) }, { status: 201 })
          }
          throw ApiError.badRequest('参考图请求缺少 references 或 reference_images')
        }
        if (referenceId && segments[6] === 'commands' && segments[7] === 'remove' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = removeImageWorkflowReferenceInputSchema.parse(await parseJson(req))
          return Response.json(imageWorkflowProjectResponseSchema.parse({
            project: publicImageProject(await project.removeWorkflowReference(projectId, referenceId, input)),
          }))
        }
      }
      if (projectId && action === 'delivery-spec') {
        if (!segments[5] && req.method === 'GET') {
          const spec = await delivery.currentDeliverySpec(projectId)
          if (!spec) throw new ImageWorkbenchServiceError('交付规格不存在', 404, 'IMAGE_OPERATION_CORRUPT')
          return Response.json({ delivery_spec: spec })
        }
        if (segments[5] === 'revisions' && !segments[6] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageDeliverySpecRevisionInputSchema.parse(await parseJson(req))
          const created = await delivery.createDeliverySpecRevision(projectId, input)
          return Response.json(imageDeliverySpecRevisionResponseSchema.parse({ project: publicImageProject(created.project), delivery_spec: created.spec }), { status: 201 })
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'versions' && !segments[5] && req.method === 'GET') {
        return Response.json({ versions: publicImageProject(await project.getProject(projectId)).version_history })
      }
      if (projectId && action === 'versions' && segments[5] && segments[6] === 'content' && !segments[7] && req.method === 'GET') {
        requireMediaUiCapability(req, mediaUiCapability)
        return imageContentResponse(await delivery.readVersionAsset(projectId, segments[5]))
      }
      if (projectId && action === 'versions' && segments[5] && segments[6] === 'visual-assessments' && !segments[7] && req.method === 'POST') {
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageVisualAssessmentInputSchema.parse(await parseJson(req))
        return Response.json(imageVisualAssessmentResponseSchema.parse({
          assessment: await generation.assessVersionVisual(projectId, segments[5], input),
        }))
      }
      if (projectId && action === 'versions' && segments[5] && segments[6] === 'derivations' && !segments[7] && req.method === 'POST') {
        requireMediaUiCapability(req, mediaUiCapability)
        const input = deriveImageVersionInputSchema.parse(await parseJson(req))
        const derived = await generation.deriveVersion(projectId, segments[5], input)
        return Response.json(imageCandidateDerivationResponseSchema.parse({
          round: derived.round,
          operation: publicGenerationOperation(derived.operation),
        }), { status: 202 })
      }
      if (projectId && action === 'versions' && segments[5] && segments[6] === 'derivations' && segments[7] === 'estimate' && !segments[8] && req.method === 'POST') {
        requireMediaUiCapability(req, mediaUiCapability)
        const input = estimateDeriveImageVersionInputSchema.parse(await parseJson(req))
        return Response.json(imageDerivationEstimateResponseSchema.parse(
          await generation.estimateVersionDerivation(projectId, segments[5], input),
        ))
      }
      if (projectId && action === 'artboards') {
        const artboardId = segments[5]
        if (!artboardId || segments[6] !== 'commands' || segments[7] !== 'select-version' || segments[8] || req.method !== 'POST') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageArtboardSelectVersionInputSchema.parse(await parseJson(req))
        return Response.json(imageArtboardSelectVersionResponseSchema.parse({
          project: publicImageProject(await canvas.selectArtboardVersion(projectId, artboardId, input)),
        }))
      }
      if (projectId && action === 'delivery-specs') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageDeliverySpecRevisionInputSchema.parse(await parseJson(req))
        const created = await delivery.createDeliverySpecRevision(projectId, input)
        return Response.json(imageDeliverySpecRevisionResponseSchema.parse({ project: publicImageProject(created.project), delivery_spec: created.spec }), { status: 201 })
      }
      if (projectId && action === 'canvases') {
        const canvasId = segments[5]
        const canvasAction = segments[6]
        if (!canvasId) {
          if (req.method === 'GET' && !canvasAction) return Response.json({ canvases: await canvas.listCanvases(projectId) })
          if (req.method !== 'POST' || canvasAction) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasCreateInputSchema.parse(await parseJson(req))
          const created = await canvas.createCanvas(projectId, input)
          return Response.json(imageCanvasCommandResponseSchema.parse({ canvas: created.canvas, project_revision: created.project.revision }), { status: 201 })
        }
        if (!canvasAction) {
          if (req.method !== 'GET' || segments[7]) throw methodNotAllowed(req.method)
          const revisionValue = url.searchParams.get('revision')
          const revision = revisionValue === null ? undefined : Number(revisionValue)
          if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw ApiError.badRequest('revision 必须是非负整数')
          return Response.json({ canvas: await canvas.getCanvas(projectId, canvasId, revision) })
        }
        if (canvasAction === 'revisions') {
          const revision = Number(segments[7])
          if (req.method !== 'GET' || segments[8] || !Number.isInteger(revision) || revision < 0) throw methodNotAllowed(req.method)
          return Response.json({ canvas: await canvas.getCanvas(projectId, canvasId, revision) })
        }
        if (canvasAction === 'commands' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasCommandRequestInputSchema.parse(await parseJson(req))
          const changed = await canvas.applyCanvasCommand(projectId, canvasId, input.base_project_revision, input.command)
          return Response.json(imageCanvasCommandResponseSchema.parse({ canvas: changed.canvas, project_revision: changed.project.revision }))
        }
        if ((canvasAction === 'preflight' || canvasAction === 'preflights') && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasPreflightInputSchema.parse(await parseJson(req))
          return Response.json(imageCanvasPreflightResponseSchema.parse({ preflight: await canvas.preflightCanvas(projectId, canvasId, input) }))
        }
        if ((canvasAction === 'render' || canvasAction === 'renders') && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageCanvasRenderInputSchema.parse(await parseJson(req))
          const rendered = await canvas.renderCanvas(projectId, canvasId, input)
          return Response.json(imageCanvasRenderResponseSchema.parse({ operation: publicGenerationOperation(rendered.operation), ...(rendered.version_id ? { version_id: rendered.version_id, render_receipt: rendered.render_receipt, release_check: rendered.release_check } : {}) }), { status: 202 })
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'exports') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageExportInputSchema.parse(await parseJson(req))
        const queued = await delivery.exportDelivery(projectId, input)
        return Response.json(imageExportResponseSchema.parse({ ...queued, operation: publicGenerationOperation(queued.operation) }), { status: 202 })
      }
      if (projectId && action === 'delivery-sets') {
        const deliverySetId = segments[5]
        if (!deliverySetId || req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        return Response.json({ delivery_set: await delivery.getDeliverySet(projectId, deliverySetId) })
      }
      if (projectId && action === 'export-receipts') {
        const receiptId = segments[5]
        if (!receiptId || req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        return Response.json({ export_receipt: await delivery.getExportReceipt(projectId, receiptId) })
      }
      if (projectId && action === 'creative-plans') {
        const planId = segments[5]
        if (!planId) {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createCreativePlanInputSchema.parse(await parseJson(req))
          return Response.json(imageCreativePlanResponseSchema.parse({
            plan: await generation.createCreativePlan(projectId, input),
          }), { status: 201 })
        }
        if (req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        return Response.json({ plan: await generation.getCreativePlan(projectId, planId) })
      }
      if (projectId && action === 'understanding') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = imageUnderstandingInputSchema.parse(await parseJson(req))
        return Response.json(imageUnderstandingResponseSchema.parse({
          suggestion: await generation.understandProject(projectId, input),
        }))
      }
      if (projectId && action === 'references') {
        const referenceId = segments[5]
        if (referenceId && segments[6] === 'commands' && segments[7] === 'update-control' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = updateImageReferenceControlInputSchema.parse(await parseJson(req))
          return Response.json(imageReferenceControlResponseSchema.parse({
            project: publicImageProject(await project.updateReferenceControl(projectId, referenceId, input)),
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
            await generation.estimateGenerationRound(projectId, input),
          ))
        }
        if (!roundId) {
          if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const input = createGenerationRoundInputSchema.parse(await parseJson(req))
          const created = await generation.createGenerationRound(projectId, input)
          return Response.json(imageGenerationRoundResponseSchema.parse({
            round: created.round,
            operations: created.operations.map(publicGenerationOperation),
          }), { status: 202 })
        }
        if (req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        const result = await generation.getGenerationRound(projectId, roundId)
        return Response.json(imageGenerationRoundResponseSchema.parse({
          round: result.round,
          operations: result.operations.map(publicGenerationOperation),
        }))
      }
      if (projectId && action === 'candidate-groups') {
        const groupId = segments[5]
        if (!groupId || req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        const result = await generation.getCandidateGroup(projectId, groupId)
        return Response.json({ candidate_group: publicCandidateGroup(projectId, result.group, result.candidates) })
      }
      if (projectId && action === 'candidates') {
        const candidateId = segments[5]
        const candidateAction = segments[6]
        if (!candidateId) throw ApiError.badRequest('缺少图片候选 ID')
        if (candidateAction === 'content' && !segments[7] && req.method === 'GET') {
          requireMediaUiCapability(req, mediaUiCapability)
          return imageContentResponse(await generation.readCandidateAsset(projectId, candidateId))
        }
        if (candidateAction === 'decisions' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = decideImageCandidateInputSchema.parse(await parseJson(req))
          return Response.json(imageCandidateDecisionResponseSchema.parse({
            decision: await generation.decideCandidate(projectId, candidateId, input),
          }))
        }
        if (candidateAction === 'visual-assessments' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = imageVisualAssessmentInputSchema.parse(await parseJson(req))
          return Response.json(imageVisualAssessmentResponseSchema.parse({
            assessment: await generation.assessCandidateVisual(projectId, candidateId, input),
          }))
        }
        if (candidateAction === 'adoptions' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = adoptImageCandidateInputSchema.parse(await parseJson(req))
          const adopted = await generation.adoptCandidate(projectId, candidateId, input)
          return Response.json(imageCandidateAdoptionResponseSchema.parse({
            project: publicImageProject(adopted.project),
            adoptions: adopted.adoptions,
          }))
        }
        if (candidateAction === 'derivations' && !segments[7] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = deriveImageCandidateInputSchema.parse(await parseJson(req))
          const derived = await generation.deriveCandidate(projectId, candidateId, input)
          return Response.json(imageCandidateDerivationResponseSchema.parse({
            round: derived.round,
            operation: publicGenerationOperation(derived.operation),
          }), { status: 202 })
        }
        if (candidateAction === 'derivations' && segments[7] === 'estimate' && !segments[8] && req.method === 'POST') {
          requireMediaUiCapability(req, mediaUiCapability)
          const input = estimateDeriveImageCandidateInputSchema.parse(await parseJson(req))
          return Response.json(imageDerivationEstimateResponseSchema.parse(
            await generation.estimateDerivation(projectId, candidateId, input),
          ))
        }
        throw methodNotAllowed(req.method)
      }
      if (projectId && action === 'operations' && !segments[5] && req.method === 'GET') {
        return Response.json({ operations: (await generation.listGenerationOperations(projectId)).map(publicGenerationOperation) })
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
          await recovery.waitForOperationEvents(projectId, cursor, limit, waitMs),
        ))
      }
      if (projectId && action === 'restore') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return Response.json({ deletion: publicMediaDeletionReceiptSchema.parse(await recovery.restoreProject(projectId)) })
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
  const events = page.events.map(publicImageEvent)
  const lastEvent = events.at(-1)
  return publicMediaJobEventPageSchema.parse({
    ...page,
    // The shared event envelope now carries an explicit continuation. Image
    // events already expose a durable cursor, so derive the next raw journal
    // position from the actual page rather than inventing a second sequence.
    next_cursor: lastEvent ? lastEvent.cursor + 1 : Math.max(1, page.cursor + 1),
    events,
  })
}
