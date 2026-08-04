import type {
  ImageProjectResponse,
  MediaSafeError,
  PublicMediaJobEventPage,
} from '../../../../shared/contracts/media.js'
import type {
  AdoptImageCandidateInput,
  CreateCreativePlanInput,
  CreateGenerationRoundInput,
  DecideImageCandidateInput,
  DeriveImageCandidateInput,
  EstimateDeriveImageCandidateInput,
  EstimateGenerationRoundInput,
  ImageCanvasCommandRequestInput,
  ImageCanvasCommandResponse,
  ImageCanvasCreateInput,
  ImageCanvasPreflightInput,
  ImageCanvasPreflightResponse,
  ImageCanvasRenderInput,
  ImageCanvasRenderResponse,
  ImageCanvasRevision,
  ImageCandidateAdoptionResponse,
  ImageCandidateDecisionResponse,
  ImageCandidateDerivationResponse,
  ImageCreativePlanResponse,
  ImageDeliverySet,
  ImageDeliverySpecRevisionInput,
  ImageDeliverySpecRevisionResponse,
  ImageDerivationEstimateResponse,
  ImageExportInput,
  ImageExportResponse,
  ImageGenerationCancelResponse,
  ImageGenerationRoundEstimateResponse,
  ImageGenerationRoundResponse,
  ImageReferenceControlResponse,
  PublicImageCandidateGroup,
  UpdateImageReferenceControlInput,
} from '../../../../shared/contracts/imageGeneration.js'
import type {
  AddImageWorkflowReferencesInput,
  ApplyImageBriefOverridesInput,
  CancelImageCampaignInput,
  CompileImageBriefResponse,
  ConfirmImageCampaignInput,
  CreateImageAssetGrantInput,
  CreateImageBrandKitInput,
  CreateImageCampaignInput,
  CreateImageTemplateInput,
  EstimateImageCampaignInput,
  ImageAssetGrantListResponse,
  ImageAssetGrantResponse,
  ImageBrandKitListResponse,
  ImageBrandKitResponse,
  ImageCampaignConfirmationResponse,
  ImageCampaignEstimateResponse,
  ImageCampaignListInput,
  ImageCampaignListResponse,
  ImageCampaignResponse,
  ImageCandidatePreviewResponse,
  ImageInspirationBoardReadResponse,
  ImageInspirationBoardResponse,
  ImageProjectLibrary,
  ImageQuickCreateInput,
  ImageQuickCreateResponse,
  ImageTemplateListResponse,
  ImageTemplateResponse,
  ImageWorkbenchProjectListResponse,
  ImageWorkbenchProjectProjection,
  ImageWorkflowProjectResponse,
  PromoteImageInspirationItemInput,
  ReplaceImageCampaignItemsInput,
  ReviseImageBrandKitInput,
  ReviseImageTemplateInput,
  RetryImageCampaignItemInput,
  StartImageCampaignInput,
  UpsertImageInspirationItemsInput,
} from '../../../../shared/contracts/imageWorkflow.js'

export type { ImageWorkbenchProjectProjection } from '../../../../shared/contracts/imageWorkflow.js'

/**
 * The public renderer boundary deliberately uses a typed envelope.  An
 * adapter may later be backed by Main/Preload, but this interface never falls
 * back to an untyped Electron value or a renderer-owned HTTP call.
 */
export type ImageWorkbenchClientResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: MediaSafeError }

export class ImageWorkbenchClientFailure extends Error {
  readonly error: MediaSafeError

  constructor(error: MediaSafeError) {
    super(error.message)
    this.name = 'ImageWorkbenchClientFailure'
    this.error = error
  }
}

export function unwrapImageWorkbenchClientResult<Value>(
  result: ImageWorkbenchClientResult<Value>,
): Value {
  if (!result.ok) throw new ImageWorkbenchClientFailure(result.error)
  return result.value
}

export type ImageProjectIdentifier = { project_id: string }
export type ImageCandidateIdentifier = ImageProjectIdentifier & { candidate_id: string }
export type ImageCanvasIdentifier = ImageProjectIdentifier & { canvas_id: string }
export type ImageReferenceIdentifier = ImageProjectIdentifier & { reference_id: string }
export type ImageOperationIdentifier = ImageProjectIdentifier & { operation_id: string }

/**
 * A renderer-safe candidate preview.  The future Main/Preload adapter must
 * resolve the protected media capability and return bytes through the typed
 * bridge; the renderer must never turn a protected API path into an <img> URL.
 */
export type ImageCommandEnvelope = {
  idempotency_key: string
  base_revision: number
}

export type ImageCandidateGroupResponse = {
  candidate_group: PublicImageCandidateGroup
}

export type ImageCanvasListResponse = {
  canvases: readonly ImageCanvasRevision[]
}

export type ImageCanvasResponse = {
  canvas: ImageCanvasRevision
}

export type ImageOperationEventCursorInput = ImageProjectIdentifier & {
  cursor: number
  limit?: number
  wait_ms?: number
}

export type ImageBriefOverrideCommand = ImageProjectIdentifier & {
  brief_id: string
  input: ApplyImageBriefOverridesInput
}

export type ImageInspirationUpsertCommand = ImageProjectIdentifier & {
  input: UpsertImageInspirationItemsInput
}

export type ImageInspirationPromoteCommand = ImageProjectIdentifier & {
  inspiration_item_id: string
  input: PromoteImageInspirationItemInput
}

export type ImageReferenceAddCommand = ImageProjectIdentifier & {
  input: AddImageWorkflowReferencesInput
}

export type ImageReferenceRemoveCommand = ImageReferenceIdentifier & {
  input: ImageCommandEnvelope
}

export type ImageReferenceControlCommand = ImageReferenceIdentifier & {
  input: UpdateImageReferenceControlInput
}

export type ImageCreativePlanCommand = ImageProjectIdentifier & {
  input: CreateCreativePlanInput
}

export type ImageGenerationRoundEstimateCommand = ImageProjectIdentifier & {
  input: EstimateGenerationRoundInput
}

export type ImageGenerationRoundCommand = ImageProjectIdentifier & {
  input: CreateGenerationRoundInput
}

export type ImageCandidateDecisionCommand = ImageCandidateIdentifier & {
  input: DecideImageCandidateInput
}

export type ImageCandidateDerivationEstimateCommand = ImageCandidateIdentifier & {
  input: EstimateDeriveImageCandidateInput
}

export type ImageCandidateDerivationCommand = ImageCandidateIdentifier & {
  input: DeriveImageCandidateInput
}

export type ImageCandidateAdoptionCommand = ImageCandidateIdentifier & {
  input: AdoptImageCandidateInput
}

export type ImageCanvasCreateCommand = ImageProjectIdentifier & {
  input: ImageCanvasCreateInput
}

export type ImageCanvasCommand = ImageCanvasIdentifier & {
  input: ImageCanvasCommandRequestInput
}

export type ImageCanvasPreflightCommand = ImageCanvasIdentifier & {
  input: ImageCanvasPreflightInput
}

export type ImageCanvasRenderCommand = ImageCanvasIdentifier & {
  input: ImageCanvasRenderInput
}

export type ImageDeliverySpecCommand = ImageProjectIdentifier & {
  input: ImageDeliverySpecRevisionInput
}

export type ImageExportCommand = ImageProjectIdentifier & {
  input: ImageExportInput
}

export type ImageBrandKitRevisionCommand = {
  brand_kit_id: string
  input: ReviseImageBrandKitInput
}

export type ImageTemplateRevisionCommand = {
  template_id: string
  input: ReviseImageTemplateInput
}

export type ImageReusableDeleteCommand = {
  idempotency_key: string
  base_revision: number
}

export type ImageAssetGrantCreateCommand = {
  input: CreateImageAssetGrantInput
}

export type ImageAssetGrantRevokeCommand = {
  grant_id: string
  input: { idempotency_key: string }
}

export type ImageCampaignIdentifier = { campaign_id: string }

export type ImageCampaignItemsCommand = ImageCampaignIdentifier & {
  input: ReplaceImageCampaignItemsInput
}

export type ImageCampaignEstimateCommand = ImageCampaignIdentifier & {
  input: EstimateImageCampaignInput
}

export type ImageCampaignConfirmCommand = ImageCampaignIdentifier & {
  input: ConfirmImageCampaignInput
}

export type ImageCampaignRetryConfirmCommand = ImageCampaignIdentifier & {
  item_id: string
  input: ConfirmImageCampaignInput
}

export type ImageCampaignStartCommand = ImageCampaignIdentifier & {
  input: StartImageCampaignInput
}

export type ImageCampaignCancelCommand = ImageCampaignIdentifier & {
  input: CancelImageCampaignInput
}

export type ImageCampaignRetryItemCommand = ImageCampaignIdentifier & {
  item_id: string
  input: RetryImageCampaignItemInput
}

/**
 * This is a contract only.  A Main/Preload adapter is intentionally not
 * constructed here, so the renderer cannot silently bypass the shared IPC
 * capability gate or issue direct HTTP/Provider requests.
 */
export interface ImageWorkbenchClient {
  listProjects(): Promise<ImageWorkbenchClientResult<ImageWorkbenchProjectListResponse>>
  getProject(input: ImageProjectIdentifier): Promise<ImageWorkbenchClientResult<ImageProjectResponse>>
  getProjectProjection(input: ImageProjectIdentifier): Promise<ImageWorkbenchClientResult<ImageWorkbenchProjectProjection>>
  listOperationEvents(input: ImageOperationEventCursorInput): Promise<ImageWorkbenchClientResult<PublicMediaJobEventPage>>

  quickCreate(input: ImageQuickCreateInput): Promise<ImageWorkbenchClientResult<ImageQuickCreateResponse>>
  compileBrief(input: ImageProjectIdentifier): Promise<ImageWorkbenchClientResult<CompileImageBriefResponse>>
  applyBriefOverrides(command: ImageBriefOverrideCommand): Promise<ImageWorkbenchClientResult<ImageWorkflowProjectResponse>>
  getInspirationBoard(input: ImageProjectIdentifier): Promise<ImageWorkbenchClientResult<ImageInspirationBoardReadResponse>>
  upsertInspirationItems(command: ImageInspirationUpsertCommand): Promise<ImageWorkbenchClientResult<ImageInspirationBoardResponse>>
  promoteInspirationItem(command: ImageInspirationPromoteCommand): Promise<ImageWorkbenchClientResult<ImageInspirationBoardResponse>>
  addReferences(command: ImageReferenceAddCommand): Promise<ImageWorkbenchClientResult<ImageProjectResponse>>
  removeReference(command: ImageReferenceRemoveCommand): Promise<ImageWorkbenchClientResult<ImageProjectResponse>>
  updateReferenceControl(command: ImageReferenceControlCommand): Promise<ImageWorkbenchClientResult<ImageReferenceControlResponse>>

  createCreativePlan(command: ImageCreativePlanCommand): Promise<ImageWorkbenchClientResult<ImageCreativePlanResponse>>
  estimateGenerationRound(command: ImageGenerationRoundEstimateCommand): Promise<ImageWorkbenchClientResult<ImageGenerationRoundEstimateResponse>>
  createGenerationRound(command: ImageGenerationRoundCommand): Promise<ImageWorkbenchClientResult<ImageGenerationRoundResponse>>
  getCandidateGroup(input: ImageProjectIdentifier & { candidate_group_id: string }): Promise<ImageWorkbenchClientResult<ImageCandidateGroupResponse>>
  decideCandidate(command: ImageCandidateDecisionCommand): Promise<ImageWorkbenchClientResult<ImageCandidateDecisionResponse>>
  estimateCandidateDerivation(command: ImageCandidateDerivationEstimateCommand): Promise<ImageWorkbenchClientResult<ImageDerivationEstimateResponse>>
  deriveCandidate(command: ImageCandidateDerivationCommand): Promise<ImageWorkbenchClientResult<ImageCandidateDerivationResponse>>
  adoptCandidate(command: ImageCandidateAdoptionCommand): Promise<ImageWorkbenchClientResult<ImageCandidateAdoptionResponse>>
  cancelOperation(input: ImageOperationIdentifier): Promise<ImageWorkbenchClientResult<ImageGenerationCancelResponse>>
  /** Optional until the shared Main/Preload media bridge lands. */
  getCandidatePreview?(input: ImageCandidateIdentifier): Promise<ImageWorkbenchClientResult<ImageCandidatePreviewResponse>>

  listCanvases(input: ImageProjectIdentifier): Promise<ImageWorkbenchClientResult<ImageCanvasListResponse>>
  getCanvas(input: ImageCanvasIdentifier & { revision?: number }): Promise<ImageWorkbenchClientResult<ImageCanvasResponse>>
  createCanvas(command: ImageCanvasCreateCommand): Promise<ImageWorkbenchClientResult<ImageCanvasCommandResponse>>
  applyCanvasCommand(command: ImageCanvasCommand): Promise<ImageWorkbenchClientResult<ImageCanvasCommandResponse>>
  preflightCanvas(command: ImageCanvasPreflightCommand): Promise<ImageWorkbenchClientResult<ImageCanvasPreflightResponse>>
  renderCanvas(command: ImageCanvasRenderCommand): Promise<ImageWorkbenchClientResult<ImageCanvasRenderResponse>>
  createDeliverySpec(command: ImageDeliverySpecCommand): Promise<ImageWorkbenchClientResult<ImageDeliverySpecRevisionResponse>>
  exportDelivery(command: ImageExportCommand): Promise<ImageWorkbenchClientResult<ImageExportResponse>>
  getDeliverySet(input: ImageProjectIdentifier & { delivery_set_id: string }): Promise<ImageWorkbenchClientResult<{ delivery_set: ImageDeliverySet }>>

  getProjectLibrary(input: ImageProjectIdentifier): Promise<ImageWorkbenchClientResult<ImageProjectLibrary>>
  listBrandKits(): Promise<ImageWorkbenchClientResult<ImageBrandKitListResponse>>
  getBrandKit(input: { brand_kit_id: string }): Promise<ImageWorkbenchClientResult<ImageBrandKitResponse>>
  createBrandKit(input: CreateImageBrandKitInput): Promise<ImageWorkbenchClientResult<ImageBrandKitResponse>>
  reviseBrandKit(command: ImageBrandKitRevisionCommand): Promise<ImageWorkbenchClientResult<ImageBrandKitResponse>>
  deleteBrandKit(input: { brand_kit_id: string; input: ImageReusableDeleteCommand }): Promise<ImageWorkbenchClientResult<ImageBrandKitResponse>>
  listTemplates(): Promise<ImageWorkbenchClientResult<ImageTemplateListResponse>>
  getTemplate(input: { template_id: string }): Promise<ImageWorkbenchClientResult<ImageTemplateResponse>>
  createTemplate(input: CreateImageTemplateInput): Promise<ImageWorkbenchClientResult<ImageTemplateResponse>>
  reviseTemplate(command: ImageTemplateRevisionCommand): Promise<ImageWorkbenchClientResult<ImageTemplateResponse>>
  deleteTemplate(input: { template_id: string; input: ImageReusableDeleteCommand }): Promise<ImageWorkbenchClientResult<ImageTemplateResponse>>
  createAssetGrant(command: ImageAssetGrantCreateCommand): Promise<ImageWorkbenchClientResult<ImageAssetGrantResponse>>
  revokeAssetGrant(command: ImageAssetGrantRevokeCommand): Promise<ImageWorkbenchClientResult<ImageAssetGrantResponse>>
  listAssetGrants(): Promise<ImageWorkbenchClientResult<ImageAssetGrantListResponse>>

  listCampaigns(input?: ImageCampaignListInput): Promise<ImageWorkbenchClientResult<ImageCampaignListResponse>>
  getCampaign(input: ImageCampaignIdentifier): Promise<ImageWorkbenchClientResult<ImageCampaignResponse>>
  createCampaign(input: CreateImageCampaignInput): Promise<ImageWorkbenchClientResult<ImageCampaignResponse>>
  replaceCampaignItems(command: ImageCampaignItemsCommand): Promise<ImageWorkbenchClientResult<ImageCampaignResponse>>
  estimateCampaign(command: ImageCampaignEstimateCommand): Promise<ImageWorkbenchClientResult<ImageCampaignEstimateResponse>>
  confirmCampaign(command: ImageCampaignConfirmCommand): Promise<ImageWorkbenchClientResult<ImageCampaignConfirmationResponse>>
  confirmCampaignRetry(command: ImageCampaignRetryConfirmCommand): Promise<ImageWorkbenchClientResult<ImageCampaignConfirmationResponse>>
  startCampaign(command: ImageCampaignStartCommand): Promise<ImageWorkbenchClientResult<ImageCampaignResponse>>
  cancelCampaign(command: ImageCampaignCancelCommand): Promise<ImageWorkbenchClientResult<ImageCampaignResponse>>
  retryCampaignItem(command: ImageCampaignRetryItemCommand): Promise<ImageWorkbenchClientResult<ImageCampaignResponse>>
}
