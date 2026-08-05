import {
  MEDIA_UI_CAPABILITY_HEADER,
  imageProjectResponseSchema,
  imageTaskResponseSchema,
  mediaSafeError,
  mediaSafeErrorResponseSchema,
  saveImageOutputResultSchema,
  type MediaSafeErrorCode,
  type ImageProjectResponse,
  type ImageTaskResponse,
  type SaveImageOutputInput,
  type SaveImageOutputResult,
  type StartImageOperationInput,
  type UpdateImageProjectInput,
} from '../../../shared/contracts/media'
import {
  imageCandidateAdoptionResponseSchema,
  imageCanvasCommandResponseSchema,
  imageArtboardSelectVersionResponseSchema,
  imageCanvasPreflightResponseSchema,
  imageCanvasRenderResponseSchema,
  imageCandidateDecisionResponseSchema,
  imageCandidateDerivationResponseSchema,
  imageCreativePlanResponseSchema,
  imageDerivationEstimateResponseSchema,
  imageDeliverySpecRevisionResponseSchema,
  imageExportResponseSchema,
  imageGenerationCancelResponseSchema,
  imageGenerationRoundEstimateResponseSchema,
  imageGenerationRoundResponseSchema,
  imageReferenceControlResponseSchema,
  imageUnderstandingResponseSchema,
  imageVisualAssessmentResponseSchema,
} from '../../../shared/contracts/imageGeneration'
import {
  imageWorkbenchIpcResponseSchemas,
  type ImageWorkbenchIpcRequest,
  type ImageWorkbenchIpcMethod,
  type ImageWorkbenchIpcValueByMethod,
} from '../../../shared/contracts/imageWorkbenchIpc'
import {
  imageCandidatePreviewResponseSchema,
  imageVersionPreviewResponseSchema,
  type ImageCandidatePreviewResponse,
  type ImageVersionPreviewResponse,
} from '../../../shared/contracts/imageWorkflow'
import { createHash } from 'node:crypto'
import { issueImageUiCapabilityTicket } from '../../../shared/product/imageUiCapabilityTicket'
import type {
  AdoptImageCandidateInput,
  ImageCandidateAdoptionResponse,
  ImageCandidateDecisionResponse,
  ImageCandidateDerivationResponse,
  ImageCreativePlanResponse,
  ImageDerivationEstimateResponse,
  ImageGenerationCancelResponse,
  ImageGenerationRoundEstimateResponse,
  ImageGenerationRoundResponse,
  ImageReferenceControlResponse,
  CreateCreativePlanInput,
  CreateGenerationRoundInput,
  DecideImageCandidateInput,
  DeriveImageCandidateInput,
  DeriveImageVersionInput,
  EstimateDeriveImageCandidateInput,
  EstimateDeriveImageVersionInput,
  EstimateGenerationRoundInput,
  UpdateImageReferenceControlInput,
  ImageCanvasCommandRequestInput,
  ImageArtboardSelectVersionInput,
  ImageArtboardSelectVersionResponse,
  ImageCanvasCommandResponse,
  ImageCanvasCreateInput,
  ImageCanvasPreflightInput,
  ImageCanvasPreflightResponse,
  ImageCanvasRenderInput,
  ImageCanvasRenderResponse,
  ImageDeliverySpecRevisionInput,
  ImageDeliverySpecRevisionResponse,
  ImageExportInput,
  ImageExportResponse,
  ImageUnderstandingInput,
  ImageUnderstandingResponse,
  ImageVisualAssessmentInput,
  ImageVisualAssessmentResponse,
} from '../../../shared/contracts/imageGeneration'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ResponseSchema<T> = { parse(value: unknown): T }
const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024

export type ElectronImageActionsOptions = {
  getServerUrl: () => Promise<string>
  /** Main-only HMAC key. It is never forwarded as a bearer header. */
  ticketSecret: string
  fetchImpl?: FetchLike
}

/** An HTTP media failure projected into an Electron-safe stable error code. */
export class ElectronImageActionError extends Error {
  readonly code: MediaSafeErrorCode

  constructor(code: unknown) {
    const safe = mediaSafeError(code)
    super(safe.message)
    this.name = 'ElectronImageActionError'
    this.code = safe.code
  }
}

/** Main-process-only bridge for image operations that need the desktop nonce. */
export class ElectronImageActions {
  private readonly fetchImpl: FetchLike
  private readonly ticketSecret: string

  constructor(private readonly options: ElectronImageActionsOptions) {
    this.ticketSecret = options.ticketSecret
    if (this.ticketSecret.length < 32) throw new Error('Image UI ticket secret is too short')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  submitProject(projectId: string, confirmUnknownRetry = false): Promise<ImageTaskResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/submit`, {
      confirm_unknown_retry: confirmUnknownRetry,
    }, imageTaskResponseSchema)
  }

  startOperation(projectId: string, input: StartImageOperationInput): Promise<ImageTaskResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/operations`, input, imageTaskResponseSchema)
  }

  updateUnknownProject(
    projectId: string,
    input: UpdateImageProjectInput,
  ): Promise<ImageProjectResponse> {
    return this.request(`/api/images/projects/${encodeURIComponent(projectId)}`, 'PUT', input, imageProjectResponseSchema)
  }

  saveOutput(projectId: string, input: SaveImageOutputInput): Promise<SaveImageOutputResult> {
    const resultId = input.version_id ?? input.output_id
    if (!resultId) throw new ElectronImageActionError('MEDIA_INVALID_REQUEST')
    return this.post(
      input.version_id
        ? `/api/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(input.version_id)}/save`
        : `/api/images/projects/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(resultId)}/save`,
      { output_path: input.output_path },
      saveImageOutputResultSchema,
    )
  }

  createCreativePlan(projectId: string, input: CreateCreativePlanInput): Promise<ImageCreativePlanResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/creative-plans`, input, imageCreativePlanResponseSchema)
  }

  understandProject(projectId: string, input: ImageUnderstandingInput): Promise<ImageUnderstandingResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/understanding`, input, imageUnderstandingResponseSchema)
  }

  estimateGenerationRound(projectId: string, input: EstimateGenerationRoundInput): Promise<ImageGenerationRoundEstimateResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/generation-rounds/estimate`, input, imageGenerationRoundEstimateResponseSchema)
  }

  estimateDerivation(projectId: string, candidateId: string, input: EstimateDeriveImageCandidateInput): Promise<ImageDerivationEstimateResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/derivations/estimate`, input, imageDerivationEstimateResponseSchema)
  }

  estimateVersionDerivation(projectId: string, versionId: string, input: EstimateDeriveImageVersionInput): Promise<ImageDerivationEstimateResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/derivations/estimate`, input, imageDerivationEstimateResponseSchema)
  }

  createGenerationRound(projectId: string, input: CreateGenerationRoundInput): Promise<ImageGenerationRoundResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/generation-rounds`, input, imageGenerationRoundResponseSchema)
  }

  decideCandidate(projectId: string, candidateId: string, input: DecideImageCandidateInput): Promise<ImageCandidateDecisionResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/decisions`, input, imageCandidateDecisionResponseSchema)
  }

  assessCandidateVisual(projectId: string, candidateId: string, input: ImageVisualAssessmentInput): Promise<ImageVisualAssessmentResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/visual-assessments`, input, imageVisualAssessmentResponseSchema)
  }

  assessVersionVisual(projectId: string, versionId: string, input: ImageVisualAssessmentInput): Promise<ImageVisualAssessmentResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/visual-assessments`, input, imageVisualAssessmentResponseSchema)
  }

  adoptCandidate(projectId: string, candidateId: string, input: AdoptImageCandidateInput): Promise<ImageCandidateAdoptionResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/adoptions`, input, imageCandidateAdoptionResponseSchema)
  }

  deriveCandidate(projectId: string, candidateId: string, input: DeriveImageCandidateInput): Promise<ImageCandidateDerivationResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/derivations`, input, imageCandidateDerivationResponseSchema)
  }

  deriveVersion(projectId: string, versionId: string, input: DeriveImageVersionInput): Promise<ImageCandidateDerivationResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/derivations`, input, imageCandidateDerivationResponseSchema)
  }

  cancelGenerationOperation(operationId: string): Promise<ImageGenerationCancelResponse> {
    return this.post(`/api/images/operations/${encodeURIComponent(operationId)}/commands/cancel`, undefined, imageGenerationCancelResponseSchema)
  }

  updateReferenceControl(projectId: string, referenceId: string, input: UpdateImageReferenceControlInput): Promise<ImageReferenceControlResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(referenceId)}/commands/update-control`, input, imageReferenceControlResponseSchema)
  }

  createDeliverySpecRevision(projectId: string, input: ImageDeliverySpecRevisionInput): Promise<ImageDeliverySpecRevisionResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/delivery-spec/revisions`, input, imageDeliverySpecRevisionResponseSchema)
  }

  createCanvas(projectId: string, input: ImageCanvasCreateInput): Promise<ImageCanvasCommandResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/canvases`, input, imageCanvasCommandResponseSchema)
  }

  applyCanvasCommand(projectId: string, canvasId: string, input: ImageCanvasCommandRequestInput): Promise<ImageCanvasCommandResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/commands`, input, imageCanvasCommandResponseSchema)
  }

  preflightCanvas(projectId: string, canvasId: string, input: ImageCanvasPreflightInput): Promise<ImageCanvasPreflightResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/preflights`, input, imageCanvasPreflightResponseSchema)
  }

  renderCanvas(projectId: string, canvasId: string, input: ImageCanvasRenderInput): Promise<ImageCanvasRenderResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}/renders`, input, imageCanvasRenderResponseSchema)
  }

  exportDelivery(projectId: string, input: ImageExportInput): Promise<ImageExportResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/exports`, input, imageExportResponseSchema)
  }

  selectArtboardVersion(projectId: string, artboardId: string, input: ImageArtboardSelectVersionInput): Promise<ImageArtboardSelectVersionResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/artboards/${encodeURIComponent(artboardId)}/commands/select-version`, input, imageArtboardSelectVersionResponseSchema)
  }

  /** Main-only dispatcher for the typed 15.5 renderer workbench bridge. */
  async invokeWorkbench(request: ImageWorkbenchIpcRequest): Promise<ImageWorkbenchIpcValueByMethod[ImageWorkbenchIpcMethod]> {
    switch (request.method) {
      case 'listProjects':
        return this.get('/api/images/projects', imageWorkbenchIpcResponseSchemas.listProjects)
      case 'getProject':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}`, imageWorkbenchIpcResponseSchemas.getProject)
      case 'getProjectProjection':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/projection`, imageWorkbenchIpcResponseSchemas.getProjectProjection)
      case 'listOperationEvents': {
        const query = new URLSearchParams({
          cursor: String(request.payload.cursor),
          limit: String(request.payload.limit ?? 200),
          wait_ms: String(request.payload.waitMs ?? 25_000),
        })
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/events?${query.toString()}`, imageWorkbenchIpcResponseSchemas.listOperationEvents)
      }
      case 'quickCreate':
        return this.post('/api/images/quick-create', request.payload.input, imageWorkbenchIpcResponseSchemas.quickCreate)
      case 'compileBrief':
        return this.post(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/brief/compile`, undefined, imageWorkbenchIpcResponseSchemas.compileBrief)
      case 'applyBriefOverrides':
        return this.post(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/brief/commands/apply-overrides`, request.payload.input, imageWorkbenchIpcResponseSchemas.applyBriefOverrides)
      case 'getInspirationBoard':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/inspiration-board`, imageWorkbenchIpcResponseSchemas.getInspirationBoard)
      case 'upsertInspirationItems':
        return this.post(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/inspiration-board/commands/upsert-items`, request.payload.input, imageWorkbenchIpcResponseSchemas.upsertInspirationItems)
      case 'promoteInspirationItem':
        return this.post(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/inspiration-board/items/${encodeURIComponent(request.payload.inspirationItemId)}/commands/promote`, request.payload.input, imageWorkbenchIpcResponseSchemas.promoteInspirationItem)
      case 'addReferences':
        return this.post(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/references`, request.payload.input, imageWorkbenchIpcResponseSchemas.addReferences)
      case 'removeReference':
        return this.post(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/references/${encodeURIComponent(request.payload.referenceId)}/commands/remove`, request.payload.input, imageWorkbenchIpcResponseSchemas.removeReference)
      case 'updateReferenceControl':
        return this.updateReferenceControl(request.payload.projectId, request.payload.referenceId, request.payload.input)
      case 'createCreativePlan':
        return this.createCreativePlan(request.payload.projectId, request.payload.input)
      case 'estimateGenerationRound':
        return this.estimateGenerationRound(request.payload.projectId, request.payload.input)
      case 'createGenerationRound':
        return this.createGenerationRound(request.payload.projectId, request.payload.input)
      case 'getCandidateGroup':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/candidate-groups/${encodeURIComponent(request.payload.candidateGroupId)}`, imageWorkbenchIpcResponseSchemas.getCandidateGroup)
      case 'getCandidatePreview':
        return this.downloadCandidatePreview(request.payload.projectId, request.payload.candidateId)
      case 'getVersionPreview':
        return this.downloadVersionPreview(request.payload.projectId, request.payload.versionId)
      case 'decideCandidate':
        return this.decideCandidate(request.payload.projectId, request.payload.candidateId, request.payload.input)
      case 'estimateCandidateDerivation':
        return this.estimateDerivation(request.payload.projectId, request.payload.candidateId, request.payload.input)
      case 'deriveCandidate':
        return this.deriveCandidate(request.payload.projectId, request.payload.candidateId, request.payload.input)
      case 'estimateVersionDerivation':
        return this.estimateVersionDerivation(request.payload.projectId, request.payload.versionId, request.payload.input)
      case 'deriveVersion':
        return this.deriveVersion(request.payload.projectId, request.payload.versionId, request.payload.input)
      case 'adoptCandidate':
        return this.adoptCandidate(request.payload.projectId, request.payload.candidateId, request.payload.input)
      case 'cancelOperation':
        return this.cancelGenerationOperation(request.payload.operationId)
      case 'listCanvases':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/canvases`, imageWorkbenchIpcResponseSchemas.listCanvases)
      case 'getCanvas': {
        const suffix = request.payload.revision === undefined ? '' : `?revision=${encodeURIComponent(String(request.payload.revision))}`
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/canvases/${encodeURIComponent(request.payload.canvasId)}${suffix}`, imageWorkbenchIpcResponseSchemas.getCanvas)
      }
      case 'createCanvas':
        return this.createCanvas(request.payload.projectId, request.payload.input)
      case 'applyCanvasCommand':
        return this.applyCanvasCommand(request.payload.projectId, request.payload.canvasId, request.payload.input)
      case 'preflightCanvas':
        return this.preflightCanvas(request.payload.projectId, request.payload.canvasId, request.payload.input)
      case 'renderCanvas':
        return this.renderCanvas(request.payload.projectId, request.payload.canvasId, request.payload.input)
      case 'createDeliverySpec':
        return this.createDeliverySpecRevision(request.payload.projectId, request.payload.input)
      case 'exportDelivery':
        return this.exportDelivery(request.payload.projectId, request.payload.input)
      case 'getDeliverySet':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/delivery-sets/${encodeURIComponent(request.payload.deliverySetId)}`, imageWorkbenchIpcResponseSchemas.getDeliverySet)
      case 'getExportReceipt':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/export-receipts/${encodeURIComponent(request.payload.receiptId)}`, imageWorkbenchIpcResponseSchemas.getExportReceipt)
      case 'getProjectLibrary':
        return this.get(`/api/images/projects/${encodeURIComponent(request.payload.projectId)}/library`, imageWorkbenchIpcResponseSchemas.getProjectLibrary)
      case 'listBrandKits':
        return this.get('/api/images/brand-kits', imageWorkbenchIpcResponseSchemas.listBrandKits)
      case 'getBrandKit':
        return this.get(`/api/images/brand-kits/${encodeURIComponent(request.payload.brandKitId)}`, imageWorkbenchIpcResponseSchemas.getBrandKit)
      case 'createBrandKit':
        return this.post('/api/images/brand-kits', request.payload.input, imageWorkbenchIpcResponseSchemas.createBrandKit)
      case 'reviseBrandKit':
        return this.post(`/api/images/brand-kits/${encodeURIComponent(request.payload.brandKitId)}/revisions`, request.payload.input, imageWorkbenchIpcResponseSchemas.reviseBrandKit)
      case 'deleteBrandKit':
        return this.post(`/api/images/brand-kits/${encodeURIComponent(request.payload.brandKitId)}/commands/trash`, request.payload.input, imageWorkbenchIpcResponseSchemas.deleteBrandKit)
      case 'listTemplates':
        return this.get('/api/images/templates', imageWorkbenchIpcResponseSchemas.listTemplates)
      case 'getTemplate':
        return this.get(`/api/images/templates/${encodeURIComponent(request.payload.templateId)}`, imageWorkbenchIpcResponseSchemas.getTemplate)
      case 'createTemplate':
        return this.post('/api/images/templates', request.payload.input, imageWorkbenchIpcResponseSchemas.createTemplate)
      case 'reviseTemplate':
        return this.post(`/api/images/templates/${encodeURIComponent(request.payload.templateId)}/revisions`, request.payload.input, imageWorkbenchIpcResponseSchemas.reviseTemplate)
      case 'deleteTemplate':
        return this.post(`/api/images/templates/${encodeURIComponent(request.payload.templateId)}/commands/trash`, request.payload.input, imageWorkbenchIpcResponseSchemas.deleteTemplate)
      case 'createAssetGrant':
        return this.post('/api/images/asset-grants', request.payload.input, imageWorkbenchIpcResponseSchemas.createAssetGrant)
      case 'revokeAssetGrant':
        return this.post(`/api/images/asset-grants/${encodeURIComponent(request.payload.grantId)}/commands/revoke`, request.payload.input, imageWorkbenchIpcResponseSchemas.revokeAssetGrant)
      case 'listAssetGrants':
        return this.get('/api/images/asset-grants', imageWorkbenchIpcResponseSchemas.listAssetGrants)
      case 'listCampaigns': {
        const query = new URLSearchParams()
        if (request.payload.input?.cursor !== undefined) query.set('cursor', String(request.payload.input.cursor))
        if (request.payload.input?.limit !== undefined) query.set('limit', String(request.payload.input.limit))
        const suffix = query.size > 0 ? `?${query.toString()}` : ''
        return this.get(`/api/images/campaigns${suffix}`, imageWorkbenchIpcResponseSchemas.listCampaigns)
      }
      case 'getCampaign':
        return this.get(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}`, imageWorkbenchIpcResponseSchemas.getCampaign)
      case 'createCampaign':
        return this.post('/api/images/campaigns', request.payload.input, imageWorkbenchIpcResponseSchemas.createCampaign)
      case 'replaceCampaignItems':
        return this.post(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}/commands/replace-items`, request.payload.input, imageWorkbenchIpcResponseSchemas.replaceCampaignItems)
      case 'estimateCampaign':
        return this.post(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}/estimate`, request.payload.input, imageWorkbenchIpcResponseSchemas.estimateCampaign)
      case 'confirmCampaign':
        return this.post(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}/commands/confirm`, request.payload.input, imageWorkbenchIpcResponseSchemas.confirmCampaign)
      case 'confirmCampaignRetry':
        return this.post(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}/items/${encodeURIComponent(request.payload.itemId)}/commands/confirm-retry`, request.payload.input, imageWorkbenchIpcResponseSchemas.confirmCampaignRetry)
      case 'startCampaign':
        return this.post(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}/commands/start`, request.payload.input, imageWorkbenchIpcResponseSchemas.startCampaign)
      case 'cancelCampaign':
        return this.post(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}/commands/cancel`, request.payload.input, imageWorkbenchIpcResponseSchemas.cancelCampaign)
      case 'retryCampaignItem':
        return this.post(`/api/images/campaigns/${encodeURIComponent(request.payload.campaignId)}/items/${encodeURIComponent(request.payload.itemId)}/commands/retry`, request.payload.input, imageWorkbenchIpcResponseSchemas.retryCampaignItem)
    }
  }

  async downloadVersion(
    projectId: string,
    versionId: string,
    maximumBytes?: number,
  ): Promise<{ bytes: Buffer; verification: SaveImageOutputResult['verification'] }> {
    const baseUrl = (await this.options.getServerUrl()).replace(/\/+$/, '')
    const path = `/api/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/content`
    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      headers: this.ticketHeaders(baseUrl, path, 'GET', ''),
    }).catch(() => { throw new ElectronImageActionError('MEDIA_TEMPORARILY_UNAVAILABLE') })
    if (!response.ok) throw new ElectronImageActionError((await response.json().catch(() => ({})) as { error?: unknown }).error)
    const declaredByteSize = Number(response.headers.get('content-length'))
    if (maximumBytes !== undefined && Number.isFinite(declaredByteSize) && declaredByteSize > maximumBytes) {
      throw new ElectronImageActionError('MEDIA_RESOURCE_UNAVAILABLE')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (maximumBytes !== undefined && bytes.byteLength > maximumBytes) {
      throw new ElectronImageActionError('MEDIA_RESOURCE_UNAVAILABLE')
    }
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const expectedHash = response.headers.get('X-BilliardBuddy-Media-Hash')
    const width = Number(response.headers.get('X-BilliardBuddy-Media-Width'))
    const height = Number(response.headers.get('X-BilliardBuddy-Media-Height'))
    const mime_type = response.headers.get('content-type')?.split(';')[0]
    if (expectedHash !== contentHash || !Number.isInteger(width) || !Number.isInteger(height)
      || (mime_type !== 'image/png' && mime_type !== 'image/jpeg' && mime_type !== 'image/webp')) {
      throw new ElectronImageActionError('MEDIA_RESOURCE_UNAVAILABLE')
    }
    return { bytes, verification: { byte_size: bytes.byteLength, mime_type, width, height, content_hash: contentHash, verified_at: new Date().toISOString() } }
  }

  /**
   * The Renderer receives a bounded data URL only after Main has verified the
   * protected Version response's content hash, dimensions and MIME type.
   */
  private async downloadVersionPreview(projectId: string, versionId: string): Promise<ImageVersionPreviewResponse> {
    const downloaded = await this.downloadVersion(projectId, versionId, MAX_IMAGE_PREVIEW_BYTES)
    return imageVersionPreviewResponseSchema.parse({
      version_id: versionId,
      data_url: `data:${downloaded.verification.mime_type};base64,${downloaded.bytes.toString('base64')}`,
    })
  }

  private async downloadCandidatePreview(projectId: string, candidateId: string): Promise<ImageCandidatePreviewResponse> {
    const baseUrl = (await this.options.getServerUrl()).replace(/\/+$/, '')
    const path = `/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/content`
    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        headers: this.ticketHeaders(baseUrl, path, 'GET', ''),
      })
    } catch {
      throw new ElectronImageActionError('MEDIA_TEMPORARILY_UNAVAILABLE')
    }
    if (!response.ok) {
      const error = mediaSafeErrorResponseSchema.safeParse(await response.json().catch(() => undefined))
      throw new ElectronImageActionError(error.success ? error.data.error : undefined)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_PREVIEW_BYTES) throw new ElectronImageActionError('MEDIA_RESOURCE_UNAVAILABLE')
    const mimeType = response.headers.get('content-type')?.split(';')[0]
    const expectedHash = response.headers.get('X-BilliardBuddy-Media-Hash')
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const width = Number(response.headers.get('X-BilliardBuddy-Media-Width'))
    const height = Number(response.headers.get('X-BilliardBuddy-Media-Height'))
    if (expectedHash !== contentHash || !Number.isInteger(width) || !Number.isInteger(height)
      || (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp')) {
      throw new ElectronImageActionError('MEDIA_RESOURCE_UNAVAILABLE')
    }
    return imageCandidatePreviewResponseSchema.parse({
      candidate_id: candidateId,
      data_url: `data:${mimeType};base64,${bytes.toString('base64')}`,
    })
  }

  private async post<T>(path: string, body: unknown, responseSchema: ResponseSchema<T>): Promise<T> {
    return await this.request(path, 'POST', body, responseSchema)
  }

  private async get<T>(path: string, responseSchema: ResponseSchema<T>): Promise<T> {
    return await this.request(path, 'GET', undefined, responseSchema)
  }

  private async request<T>(path: string, method: 'GET' | 'POST' | 'PUT', body: unknown, responseSchema: ResponseSchema<T>): Promise<T> {
    const baseUrl = (await this.options.getServerUrl()).replace(/\/+$/, '')
    const rawBody = body === undefined ? '' : JSON.stringify(body)
    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...this.ticketHeaders(baseUrl, path, method, rawBody),
        },
        body: body === undefined ? undefined : rawBody,
      })
    } catch {
      throw new ElectronImageActionError('MEDIA_TEMPORARILY_UNAVAILABLE')
    }
    const payload: unknown = await response.json().catch(() => ({}))
    const errorPayload = mediaSafeErrorResponseSchema.safeParse(payload)
    if (!response.ok) throw new ElectronImageActionError(errorPayload.success ? errorPayload.data.error : undefined)
    try {
      return responseSchema.parse(payload)
    } catch {
      throw new ElectronImageActionError('MEDIA_TEMPORARILY_UNAVAILABLE')
    }
  }

  private ticketHeaders(baseUrl: string, path: string, method: 'GET' | 'POST' | 'PUT', body: string, range = ''): Record<string, string> {
    const url = new URL(path, `${baseUrl}/`)
    return {
      Origin: url.origin,
      [MEDIA_UI_CAPABILITY_HEADER]: issueImageUiCapabilityTicket(this.ticketSecret, {
        method,
        url,
        body,
        range,
      }),
    }
  }
}
