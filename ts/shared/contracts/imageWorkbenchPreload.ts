import type {
  ImageProjectResponse,
  ImageTaskResponse,
  MediaSafeError,
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
  ImageCanvasCommandRequestInput,
  ImageCanvasCommandResponse,
  ImageCanvasCreateInput,
  ImageCanvasPreflightInput,
  ImageCanvasPreflightResponse,
  ImageCanvasRenderInput,
  ImageCanvasRenderResponse,
  ImageDeliverySpecRevisionInput,
  ImageExportInput,
  ImageExportResponse,
  ImageArtboardSelectVersionInput,
  ImageArtboardSelectVersionResponse,
  ImageDeliverySpecRevisionResponse,
  ImageDestinationGrantRequest,
  ImageDestinationGrant,
  ImageSaveOutputInput,
  ImageSaveOutputResponse,
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
  saveOutput(projectId: string, input: ImageSaveOutputInput): Promise<ImageWorkbenchIpcResponse<ImageSaveOutputResponse>>
  requestDestination(input: ImageDestinationGrantRequest): Promise<ImageWorkbenchIpcResponse<ImageDestinationGrant>>
  createCreativePlan(projectId: string, input: CreateCreativePlanInput): Promise<ImageWorkbenchIpcResponse<ImageCreativePlanResponse>>
  estimateGenerationRound(projectId: string, input: EstimateGenerationRoundInput): Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundEstimateResponse>>
  estimateDerivation(projectId: string, candidateId: string, input: EstimateDeriveImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageDerivationEstimateResponse>>
  createGenerationRound(projectId: string, input: CreateGenerationRoundInput): Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundResponse>>
  decideCandidate(projectId: string, candidateId: string, input: DecideImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageCandidateDecisionResponse>>
  adoptCandidate(projectId: string, candidateId: string, input: AdoptImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageCandidateAdoptionResponse>>
  deriveCandidate(projectId: string, candidateId: string, input: DeriveImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageCandidateDerivationResponse>>
  cancelGenerationOperation(operationId: string): Promise<ImageWorkbenchIpcResponse<ImageGenerationCancelResponse>>
  updateReferenceControl(projectId: string, referenceId: string, input: UpdateImageReferenceControlInput): Promise<ImageWorkbenchIpcResponse<ImageReferenceControlResponse>>
  createDeliverySpecRevision(projectId: string, input: ImageDeliverySpecRevisionInput): Promise<ImageWorkbenchIpcResponse<ImageDeliverySpecRevisionResponse>>
  createCanvas(projectId: string, input: ImageCanvasCreateInput): Promise<ImageWorkbenchIpcResponse<ImageCanvasCommandResponse>>
  applyCanvasCommand(projectId: string, canvasId: string, input: ImageCanvasCommandRequestInput): Promise<ImageWorkbenchIpcResponse<ImageCanvasCommandResponse>>
  preflightCanvas(projectId: string, canvasId: string, input: ImageCanvasPreflightInput): Promise<ImageWorkbenchIpcResponse<ImageCanvasPreflightResponse>>
  renderCanvas(projectId: string, canvasId: string, input: ImageCanvasRenderInput): Promise<ImageWorkbenchIpcResponse<ImageCanvasRenderResponse>>
  exportDelivery(projectId: string, input: ImageExportInput): Promise<ImageWorkbenchIpcResponse<ImageExportResponse>>
  selectArtboardVersion(projectId: string, artboardId: string, input: ImageArtboardSelectVersionInput): Promise<ImageWorkbenchIpcResponse<ImageArtboardSelectVersionResponse>>
}

export type BilliardBuddyMediaPreloadBridge = {
  images: ImageWorkbenchPreloadBridge
}
