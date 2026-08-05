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
  ImageUnderstandingInput,
  ImageUnderstandingResponse,
  ImageVisualAssessmentInput,
  ImageVisualAssessmentResponse,
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
import type {
  ImageWorkbenchIpcMethod,
  ImageWorkbenchIpcPayloadByMethod,
  ImageWorkbenchIpcValueByMethod,
} from './imageWorkbenchIpc.js'

export type ImageWorkbenchIpcResponse<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: MediaSafeError }

export type ImageWorkbenchIpcMethodResponse<Method extends ImageWorkbenchIpcMethod> =
  ImageWorkbenchIpcResponse<ImageWorkbenchIpcValueByMethod[Method]>

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
  understandProject(projectId: string, input: ImageUnderstandingInput): Promise<ImageWorkbenchIpcResponse<ImageUnderstandingResponse>>
  estimateGenerationRound(projectId: string, input: EstimateGenerationRoundInput): Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundEstimateResponse>>
  estimateDerivation(projectId: string, candidateId: string, input: EstimateDeriveImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageDerivationEstimateResponse>>
  createGenerationRound(projectId: string, input: CreateGenerationRoundInput): Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundResponse>>
  decideCandidate(projectId: string, candidateId: string, input: DecideImageCandidateInput): Promise<ImageWorkbenchIpcResponse<ImageCandidateDecisionResponse>>
  assessCandidateVisual(projectId: string, candidateId: string, input: ImageVisualAssessmentInput): Promise<ImageWorkbenchIpcResponse<ImageVisualAssessmentResponse>>
  assessVersionVisual(projectId: string, versionId: string, input: ImageVisualAssessmentInput): Promise<ImageWorkbenchIpcResponse<ImageVisualAssessmentResponse>>
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
  listProjects(): Promise<ImageWorkbenchIpcMethodResponse<'listProjects'>>
  getProject(projectId: string): Promise<ImageWorkbenchIpcMethodResponse<'getProject'>>
  getProjectProjection(projectId: string): Promise<ImageWorkbenchIpcMethodResponse<'getProjectProjection'>>
  listOperationEvents(input: ImageWorkbenchIpcPayloadByMethod['listOperationEvents']): Promise<ImageWorkbenchIpcMethodResponse<'listOperationEvents'>>
  quickCreate(input: ImageWorkbenchIpcPayloadByMethod['quickCreate']['input']): Promise<ImageWorkbenchIpcMethodResponse<'quickCreate'>>
  compileBrief(projectId: string): Promise<ImageWorkbenchIpcMethodResponse<'compileBrief'>>
  applyBriefOverrides(input: ImageWorkbenchIpcPayloadByMethod['applyBriefOverrides']): Promise<ImageWorkbenchIpcMethodResponse<'applyBriefOverrides'>>
  getInspirationBoard(projectId: string): Promise<ImageWorkbenchIpcMethodResponse<'getInspirationBoard'>>
  upsertInspirationItems(input: ImageWorkbenchIpcPayloadByMethod['upsertInspirationItems']): Promise<ImageWorkbenchIpcMethodResponse<'upsertInspirationItems'>>
  promoteInspirationItem(input: ImageWorkbenchIpcPayloadByMethod['promoteInspirationItem']): Promise<ImageWorkbenchIpcMethodResponse<'promoteInspirationItem'>>
  addReferences(input: ImageWorkbenchIpcPayloadByMethod['addReferences']): Promise<ImageWorkbenchIpcMethodResponse<'addReferences'>>
  removeReference(input: ImageWorkbenchIpcPayloadByMethod['removeReference']): Promise<ImageWorkbenchIpcMethodResponse<'removeReference'>>
  getCandidateGroup(input: ImageWorkbenchIpcPayloadByMethod['getCandidateGroup']): Promise<ImageWorkbenchIpcMethodResponse<'getCandidateGroup'>>
  getCandidatePreview(input: ImageWorkbenchIpcPayloadByMethod['getCandidatePreview']): Promise<ImageWorkbenchIpcMethodResponse<'getCandidatePreview'>>
  getVersionPreview(input: ImageWorkbenchIpcPayloadByMethod['getVersionPreview']): Promise<ImageWorkbenchIpcMethodResponse<'getVersionPreview'>>
  estimateVersionDerivation(projectId: string, versionId: string, input: ImageWorkbenchIpcPayloadByMethod['estimateVersionDerivation']['input']): Promise<ImageWorkbenchIpcMethodResponse<'estimateVersionDerivation'>>
  deriveVersion(projectId: string, versionId: string, input: ImageWorkbenchIpcPayloadByMethod['deriveVersion']['input']): Promise<ImageWorkbenchIpcMethodResponse<'deriveVersion'>>
  listCanvases(projectId: string): Promise<ImageWorkbenchIpcMethodResponse<'listCanvases'>>
  getCanvas(input: ImageWorkbenchIpcPayloadByMethod['getCanvas']): Promise<ImageWorkbenchIpcMethodResponse<'getCanvas'>>
  getDeliverySet(input: ImageWorkbenchIpcPayloadByMethod['getDeliverySet']): Promise<ImageWorkbenchIpcMethodResponse<'getDeliverySet'>>
  getExportReceipt(input: ImageWorkbenchIpcPayloadByMethod['getExportReceipt']): Promise<ImageWorkbenchIpcMethodResponse<'getExportReceipt'>>
  getProjectLibrary(projectId: string): Promise<ImageWorkbenchIpcMethodResponse<'getProjectLibrary'>>
  listBrandKits(): Promise<ImageWorkbenchIpcMethodResponse<'listBrandKits'>>
  getBrandKit(brandKitId: string): Promise<ImageWorkbenchIpcMethodResponse<'getBrandKit'>>
  createBrandKit(input: ImageWorkbenchIpcPayloadByMethod['createBrandKit']['input']): Promise<ImageWorkbenchIpcMethodResponse<'createBrandKit'>>
  reviseBrandKit(input: ImageWorkbenchIpcPayloadByMethod['reviseBrandKit']): Promise<ImageWorkbenchIpcMethodResponse<'reviseBrandKit'>>
  deleteBrandKit(input: ImageWorkbenchIpcPayloadByMethod['deleteBrandKit']): Promise<ImageWorkbenchIpcMethodResponse<'deleteBrandKit'>>
  listTemplates(): Promise<ImageWorkbenchIpcMethodResponse<'listTemplates'>>
  getTemplate(templateId: string): Promise<ImageWorkbenchIpcMethodResponse<'getTemplate'>>
  createTemplate(input: ImageWorkbenchIpcPayloadByMethod['createTemplate']['input']): Promise<ImageWorkbenchIpcMethodResponse<'createTemplate'>>
  reviseTemplate(input: ImageWorkbenchIpcPayloadByMethod['reviseTemplate']): Promise<ImageWorkbenchIpcMethodResponse<'reviseTemplate'>>
  deleteTemplate(input: ImageWorkbenchIpcPayloadByMethod['deleteTemplate']): Promise<ImageWorkbenchIpcMethodResponse<'deleteTemplate'>>
  createAssetGrant(input: ImageWorkbenchIpcPayloadByMethod['createAssetGrant']['input']): Promise<ImageWorkbenchIpcMethodResponse<'createAssetGrant'>>
  revokeAssetGrant(input: ImageWorkbenchIpcPayloadByMethod['revokeAssetGrant']): Promise<ImageWorkbenchIpcMethodResponse<'revokeAssetGrant'>>
  listAssetGrants(): Promise<ImageWorkbenchIpcMethodResponse<'listAssetGrants'>>
  listCampaigns(input?: ImageWorkbenchIpcPayloadByMethod['listCampaigns']['input']): Promise<ImageWorkbenchIpcMethodResponse<'listCampaigns'>>
  getCampaign(campaignId: string): Promise<ImageWorkbenchIpcMethodResponse<'getCampaign'>>
  createCampaign(input: ImageWorkbenchIpcPayloadByMethod['createCampaign']['input']): Promise<ImageWorkbenchIpcMethodResponse<'createCampaign'>>
  replaceCampaignItems(input: ImageWorkbenchIpcPayloadByMethod['replaceCampaignItems']): Promise<ImageWorkbenchIpcMethodResponse<'replaceCampaignItems'>>
  estimateCampaign(input: ImageWorkbenchIpcPayloadByMethod['estimateCampaign']): Promise<ImageWorkbenchIpcMethodResponse<'estimateCampaign'>>
  confirmCampaign(input: ImageWorkbenchIpcPayloadByMethod['confirmCampaign']): Promise<ImageWorkbenchIpcMethodResponse<'confirmCampaign'>>
  confirmCampaignRetry(input: ImageWorkbenchIpcPayloadByMethod['confirmCampaignRetry']): Promise<ImageWorkbenchIpcMethodResponse<'confirmCampaignRetry'>>
  startCampaign(input: ImageWorkbenchIpcPayloadByMethod['startCampaign']): Promise<ImageWorkbenchIpcMethodResponse<'startCampaign'>>
  cancelCampaign(input: ImageWorkbenchIpcPayloadByMethod['cancelCampaign']): Promise<ImageWorkbenchIpcMethodResponse<'cancelCampaign'>>
  retryCampaignItem(input: ImageWorkbenchIpcPayloadByMethod['retryCampaignItem']): Promise<ImageWorkbenchIpcMethodResponse<'retryCampaignItem'>>
}

export type BilliardBuddyMediaPreloadBridge = {
  images: ImageWorkbenchPreloadBridge
}
