import type {
  ImageProjectResponse,
  ImageTaskResponse,
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

/**
 * The renderer-visible image workbench boundary.  Inputs and outputs stay in
 * shared contracts so neither Preload nor a renderer can silently degrade to
 * Promise<unknown> as IPC commands evolve.
 */
export type ImageWorkbenchPreloadBridge = {
  submitProject(projectId: string, confirmUnknownRetry?: SubmitImageProjectInput['confirm_unknown_retry']): Promise<ImageTaskResponse>
  startOperation(projectId: string, input: StartImageOperationInput): Promise<ImageTaskResponse>
  updateUnknownProject(projectId: string, input: UpdateImageProjectInput): Promise<ImageProjectResponse>
  saveOutput(projectId: string, input: SaveImageOutputInput): Promise<SaveImageOutputResult>
  createCreativePlan(projectId: string, input: CreateCreativePlanInput): Promise<ImageCreativePlanResponse>
  estimateGenerationRound(projectId: string, input: EstimateGenerationRoundInput): Promise<ImageGenerationRoundEstimateResponse>
  estimateDerivation(projectId: string, candidateId: string, input: EstimateDeriveImageCandidateInput): Promise<ImageDerivationEstimateResponse>
  createGenerationRound(projectId: string, input: CreateGenerationRoundInput): Promise<ImageGenerationRoundResponse>
  decideCandidate(projectId: string, candidateId: string, input: DecideImageCandidateInput): Promise<ImageCandidateDecisionResponse>
  adoptCandidate(projectId: string, candidateId: string, input: AdoptImageCandidateInput): Promise<ImageCandidateAdoptionResponse>
  deriveCandidate(projectId: string, candidateId: string, input: DeriveImageCandidateInput): Promise<ImageCandidateDerivationResponse>
  cancelGenerationOperation(operationId: string): Promise<ImageGenerationCancelResponse>
  updateReferenceControl(projectId: string, referenceId: string, input: UpdateImageReferenceControlInput): Promise<ImageReferenceControlResponse>
}

export type BilliardBuddyMediaPreloadBridge = {
  images: ImageWorkbenchPreloadBridge
}
