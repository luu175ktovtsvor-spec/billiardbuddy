import type {
  ImageProjectResponse,
  ImageTaskResponse,
  MediaSafeError,
  SaveImageOutputInput,
  SaveImageOutputResult,
  StartImageOperationInput,
  SubmitImageProjectInput,
  UpdateImageProjectInput,
} from './media.js'
import type {
  AdoptImageCandidateInput,
  CreateCreativePlanInput,
  CreateGenerationRoundInput,
  DecideImageCandidateInput,
  DeriveImageCandidateInput,
  EstimateDeriveImageCandidateInput,
  EstimateGenerationRoundInput,
  ImageCandidateAdoptionResponse,
  ImageCandidateDecisionResponse,
  ImageCandidateDerivationResponse,
  ImageCreativePlanResponse,
  ImageDerivationEstimateResponse,
  ImageGenerationCancelResponse,
  ImageGenerationRoundEstimateResponse,
  ImageGenerationRoundResponse,
  ImageReferenceControlResponse,
  UpdateImageReferenceControlInput,
} from './imageGeneration.js'

export type ImageWorkbenchIpcResponse<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: MediaSafeError }

/**
 * The renderer-visible image workbench boundary.  Inputs and outputs stay in
 * shared contracts so neither Preload nor a renderer can silently degrade to
 * Promise<unknown> as IPC commands evolve.  Expected media failures resolve
 * as a typed error envelope so Electron does not discard their stable code.
 */
export type ImageWorkbenchPreloadBridge = {
  submitProject(projectId: string, confirmUnknownRetry?: SubmitImageProjectInput['confirm_unknown_retry']): Promise<ImageWorkbenchIpcResponse<ImageTaskResponse>>
  startOperation(projectId: string, input: StartImageOperationInput): Promise<ImageWorkbenchIpcResponse<ImageTaskResponse>>
  updateUnknownProject(projectId: string, input: UpdateImageProjectInput): Promise<ImageWorkbenchIpcResponse<ImageProjectResponse>>
  saveOutput(projectId: string, input: SaveImageOutputInput): Promise<ImageWorkbenchIpcResponse<SaveImageOutputResult>>
  createCreativePlan(projectId: string, input: CreateCreativePlanInput): Promise<ImageWorkbenchIpcResponse<ImageCreativePlanResponse>>
  estimateGenerationRound(projectId: string, input: EstimateGenerationRoundInput): Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundEstimateResponse>>
  estimateDerivation(projectId: string, candidateId: string, input: EstimateDeriveImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageDerivationEstimateResponse>>
  createGenerationRound(projectId: string, input: CreateGenerationRoundInput): Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundResponse>>
  decideCandidate(projectId: string, candidateId: string, input: DecideImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageCandidateDecisionResponse>>
  adoptCandidate(projectId: string, candidateId: string, input: AdoptImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageCandidateAdoptionResponse>>
  deriveCandidate(projectId: string, candidateId: string, input: DeriveImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageCandidateDerivationResponse>>
  cancelGenerationOperation(operationId: string): Promise<ImageWorkbenchIpcResponse<ImageGenerationCancelResponse>>
  updateReferenceControl(projectId: string, referenceId: string, input: UpdateImageReferenceControlInput): Promise<ImageWorkbenchIpcResponse<ImageReferenceControlResponse>>
}

export type BilliardBuddyMediaPreloadBridge = {
  images: ImageWorkbenchPreloadBridge
}
