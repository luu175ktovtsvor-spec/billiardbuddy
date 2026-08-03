import { z } from 'zod/v4'
import {
  MEDIA_UI_CAPABILITY_HEADER,
  mediaSafeError,
  publicImageWorkbenchProjectSchema,
  publicMediaTaskSchema,
  saveImageOutputResultSchema,
  type PublicImageWorkbenchProject as ImageWorkbenchProject,
  type PublicMediaTask as ImageOperation,
  type SaveImageOutputInput,
  type SaveImageOutputResult,
  type StartImageOperationInput,
  type UpdateImageProjectInput,
} from '../../../shared/contracts/media'
import {
  imageCandidateAdoptionResponseSchema,
  imageCandidateDecisionResponseSchema,
  imageCandidateDerivationResponseSchema,
  imageCreativePlanResponseSchema,
  imageDerivationEstimateResponseSchema,
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
} from '../../../shared/contracts/imageGeneration'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ResponseSchema<T> = { parse(value: unknown): T }

const imageTaskResponseSchema = z.object({ task: publicMediaTaskSchema }).strict()
const imageProjectResponseSchema = z.object({ project: publicImageWorkbenchProjectSchema }).strict()

export type ElectronImageActionsOptions = {
  getServerUrl: () => Promise<string>
  capability: string
  fetchImpl?: FetchLike
}

/** Main-process-only bridge for image operations that need the desktop nonce. */
export class ElectronImageActions {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: ElectronImageActionsOptions) {
    if (options.capability.length < 32) throw new Error('Image UI capability is too short')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  submitProject(projectId: string, confirmUnknownRetry = false): Promise<{ task: ImageOperation }> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/submit`, {
      confirm_unknown_retry: confirmUnknownRetry,
    }, imageTaskResponseSchema)
  }

  startOperation(projectId: string, input: StartImageOperationInput): Promise<{ task: ImageOperation }> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/operations`, input, imageTaskResponseSchema)
  }

  updateUnknownProject(
    projectId: string,
    input: UpdateImageProjectInput,
  ): Promise<{ project: ImageWorkbenchProject }> {
    return this.request(`/api/images/projects/${encodeURIComponent(projectId)}`, 'PUT', input, imageProjectResponseSchema)
  }

  saveOutput(projectId: string, input: SaveImageOutputInput): Promise<SaveImageOutputResult> {
    const resultId = input.version_id ?? input.output_id
    if (!resultId) throw new Error(mediaSafeError('MEDIA_INVALID_REQUEST').message)
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
      throw new Error(mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE').message)
    }
    const payload: unknown = await response.json().catch(() => ({}))
    const errorPayload = z.object({ error: z.unknown().optional() }).passthrough().safeParse(payload)
    if (!response.ok) throw new Error(mediaSafeError(errorPayload.success ? errorPayload.data.error : undefined).message)
    try {
      return responseSchema.parse(payload)
    } catch {
      throw new Error(mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE').message)
    }
  }
}
