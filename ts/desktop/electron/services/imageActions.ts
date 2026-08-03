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
} from '../../../shared/contracts/imageGeneration'
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
  EstimateDeriveImageCandidateInput,
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
} from '../../../shared/contracts/imageGeneration'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ResponseSchema<T> = { parse(value: unknown): T }

export type ElectronImageActionsOptions = {
  getServerUrl: () => Promise<string>
  capability: string
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

  constructor(private readonly options: ElectronImageActionsOptions) {
    if (options.capability.length < 32) throw new Error('Image UI capability is too short')
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

  estimateGenerationRound(projectId: string, input: EstimateGenerationRoundInput): Promise<ImageGenerationRoundEstimateResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/generation-rounds/estimate`, input, imageGenerationRoundEstimateResponseSchema)
  }

  estimateDerivation(projectId: string, candidateId: string, input: EstimateDeriveImageCandidateInput): Promise<ImageDerivationEstimateResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/derivations/estimate`, input, imageDerivationEstimateResponseSchema)
  }

  createGenerationRound(projectId: string, input: CreateGenerationRoundInput): Promise<ImageGenerationRoundResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/generation-rounds`, input, imageGenerationRoundResponseSchema)
  }

  decideCandidate(projectId: string, candidateId: string, input: DecideImageCandidateInput): Promise<ImageCandidateDecisionResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/decisions`, input, imageCandidateDecisionResponseSchema)
  }

  adoptCandidate(projectId: string, candidateId: string, input: AdoptImageCandidateInput): Promise<ImageCandidateAdoptionResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/adoptions`, input, imageCandidateAdoptionResponseSchema)
  }

  deriveCandidate(projectId: string, candidateId: string, input: DeriveImageCandidateInput): Promise<ImageCandidateDerivationResponse> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/candidates/${encodeURIComponent(candidateId)}/derivations`, input, imageCandidateDerivationResponseSchema)
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

  private async post<T>(path: string, body: unknown, responseSchema: ResponseSchema<T>): Promise<T> {
    return await this.request(path, 'POST', body, responseSchema)
  }

  private async request<T>(path: string, method: 'POST' | 'PUT', body: unknown, responseSchema: ResponseSchema<T>): Promise<T> {
    const baseUrl = (await this.options.getServerUrl()).replace(/\/+$/, '')
    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          [MEDIA_UI_CAPABILITY_HEADER]: this.options.capability,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
}
