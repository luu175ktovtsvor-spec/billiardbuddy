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
  DeriveImageVersionInput,
  EstimateDeriveImageCandidateInput,
  EstimateDeriveImageVersionInput,
  EstimateGenerationRoundInput,
  ImageCanvasCommandRequestInput,
  ImageCanvasCommandResponse,
  ImageCanvasCreateInput,
  ImageCanvasPreflightInput,
  ImageCanvasPreflightResponse,
  ImageCanvasRenderInput,
  ImageCanvasRenderResponse,
  ImageCanvasRevision,
  ImageArtboardSelectVersionInput,
  ImageArtboardSelectVersionResponse,
  ImageCandidateAdoptionResponse,
  ImageCandidateDecisionResponse,
  ImageCandidateDerivationResponse,
  ImageCreativePlanResponse,
  ImageDeliverySet,
  ImageExportReceipt,
  ImageDeliverySpecRevisionInput,
  ImageDeliverySpecRevisionResponse,
  ImageDestinationGrant,
  ImageDestinationGrantRequest,
  ImageDerivationEstimateResponse,
  ImageExportInput,
  ImageExportResponse,
  ImageGenerationCancelResponse,
  ImageGenerationRoundEstimateResponse,
  ImageGenerationRoundResponse,
  ImageReferenceControlResponse,
  ImageSaveOutputInput,
  ImageSaveOutputResponse,
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
  ImageVersionPreviewResponse,
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
import type { ImageWorkbenchPreloadBridge } from '../../../../shared/contracts/imageWorkbenchPreload.js'

// Keep the exhaustive Preload type assertions on the renderer's compiled
// dependency path. This exports types only, so it cannot create a runtime
// bridge or grant the renderer any additional capability.
export type { ImageWorkbenchPreloadTypeContract } from '../../imageWorkbenchPreloadContract.js'

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
export type ImageVersionIdentifier = ImageProjectIdentifier & { version_id: string }
export type ImageExportReceiptIdentifier = ImageProjectIdentifier & { export_receipt_id: string }
export type ImageCanvasIdentifier = ImageProjectIdentifier & { canvas_id: string }
export type ImageReferenceIdentifier = ImageProjectIdentifier & { reference_id: string }
export type ImageOperationIdentifier = ImageProjectIdentifier & { operation_id: string }

/**
 * A renderer-safe candidate preview resolved by Main/Preload into a bounded
 * data URL; the renderer never turns a protected API path into an <img> URL.
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

export type ImageVersionDerivationEstimateCommand = ImageVersionIdentifier & {
  input: EstimateDeriveImageVersionInput
}

export type ImageVersionDerivationCommand = ImageVersionIdentifier & {
  input: DeriveImageVersionInput
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

export type ImageArtboardVersionSelectionCommand = ImageProjectIdentifier & {
  artboard_id: string
  input: ImageArtboardSelectVersionInput
}

export type ImageDeliverySpecCommand = ImageProjectIdentifier & {
  input: ImageDeliverySpecRevisionInput
}

export type ImageExportCommand = ImageProjectIdentifier & {
  input: ImageExportInput
}

/**
 * The native save dialog returns an opaque destination grant. The renderer
 * may only pass that grant back to Main together with the result to save.
 */
export type ImageSaveOutputCommand = ImageProjectIdentifier & {
  input: ImageSaveOutputInput
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
 * The adapter below is the sole renderer entry point. It only forwards typed
 * calls to the shared Main/Preload bridge and never constructs a server URL.
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
  estimateVersionDerivation(command: ImageVersionDerivationEstimateCommand): Promise<ImageWorkbenchClientResult<ImageDerivationEstimateResponse>>
  deriveVersion(command: ImageVersionDerivationCommand): Promise<ImageWorkbenchClientResult<ImageCandidateDerivationResponse>>
  adoptCandidate(command: ImageCandidateAdoptionCommand): Promise<ImageWorkbenchClientResult<ImageCandidateAdoptionResponse>>
  cancelOperation(input: ImageOperationIdentifier): Promise<ImageWorkbenchClientResult<ImageGenerationCancelResponse>>
  getCandidatePreview(input: ImageCandidateIdentifier): Promise<ImageWorkbenchClientResult<ImageCandidatePreviewResponse>>
  getVersionPreview(input: ImageVersionIdentifier): Promise<ImageWorkbenchClientResult<ImageVersionPreviewResponse>>

  listCanvases(input: ImageProjectIdentifier): Promise<ImageWorkbenchClientResult<ImageCanvasListResponse>>
  getCanvas(input: ImageCanvasIdentifier & { revision?: number }): Promise<ImageWorkbenchClientResult<ImageCanvasResponse>>
  createCanvas(command: ImageCanvasCreateCommand): Promise<ImageWorkbenchClientResult<ImageCanvasCommandResponse>>
  applyCanvasCommand(command: ImageCanvasCommand): Promise<ImageWorkbenchClientResult<ImageCanvasCommandResponse>>
  preflightCanvas(command: ImageCanvasPreflightCommand): Promise<ImageWorkbenchClientResult<ImageCanvasPreflightResponse>>
  renderCanvas(command: ImageCanvasRenderCommand): Promise<ImageWorkbenchClientResult<ImageCanvasRenderResponse>>
  selectArtboardVersion(command: ImageArtboardVersionSelectionCommand): Promise<ImageWorkbenchClientResult<ImageArtboardSelectVersionResponse>>
  createDeliverySpec(command: ImageDeliverySpecCommand): Promise<ImageWorkbenchClientResult<ImageDeliverySpecRevisionResponse>>
  exportDelivery(command: ImageExportCommand): Promise<ImageWorkbenchClientResult<ImageExportResponse>>
  getDeliverySet(input: ImageProjectIdentifier & { delivery_set_id: string }): Promise<ImageWorkbenchClientResult<{ delivery_set: ImageDeliverySet }>>
  getExportReceipt(input: ImageExportReceiptIdentifier): Promise<ImageWorkbenchClientResult<{ export_receipt: ImageExportReceipt }>>
  requestDestination(input: ImageDestinationGrantRequest): Promise<ImageWorkbenchClientResult<ImageDestinationGrant>>
  saveOutput(command: ImageSaveOutputCommand): Promise<ImageWorkbenchClientResult<ImageSaveOutputResponse>>

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

/**
 * Renderer adapter for the complete image workbench. Every protected read or
 * write remains a typed Main/Preload call; no renderer HTTP client is needed.
 */
export function createElectronImageWorkbenchClient(
  bridge: ImageWorkbenchPreloadBridge,
): ImageWorkbenchClient {
  return {
    listProjects: () => bridge.listProjects(),
    getProject: input => bridge.getProject(input.project_id),
    getProjectProjection: input => bridge.getProjectProjection(input.project_id),
    listOperationEvents: input => bridge.listOperationEvents({
      projectId: input.project_id,
      cursor: input.cursor,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.wait_ms === undefined ? {} : { waitMs: input.wait_ms }),
    }),
    quickCreate: input => bridge.quickCreate(input),
    compileBrief: input => bridge.compileBrief(input.project_id),
    applyBriefOverrides: command => bridge.applyBriefOverrides({
      projectId: command.project_id,
      briefId: command.brief_id,
      input: command.input,
    }),
    getInspirationBoard: input => bridge.getInspirationBoard(input.project_id),
    upsertInspirationItems: command => bridge.upsertInspirationItems({
      projectId: command.project_id,
      input: command.input,
    }),
    promoteInspirationItem: command => bridge.promoteInspirationItem({
      projectId: command.project_id,
      inspirationItemId: command.inspiration_item_id,
      input: command.input,
    }),
    addReferences: command => bridge.addReferences({
      projectId: command.project_id,
      input: command.input,
    }),
    removeReference: command => bridge.removeReference({
      projectId: command.project_id,
      referenceId: command.reference_id,
      input: command.input,
    }),
    updateReferenceControl: command => bridge.updateReferenceControl(command.project_id, command.reference_id, command.input),
    createCreativePlan: command => bridge.createCreativePlan(command.project_id, command.input),
    estimateGenerationRound: command => bridge.estimateGenerationRound(command.project_id, command.input),
    createGenerationRound: command => bridge.createGenerationRound(command.project_id, command.input),
    getCandidateGroup: input => bridge.getCandidateGroup({
      projectId: input.project_id,
      candidateGroupId: input.candidate_group_id,
    }),
    decideCandidate: command => bridge.decideCandidate(command.project_id, command.candidate_id, command.input),
    estimateCandidateDerivation: command => bridge.estimateDerivation(command.project_id, command.candidate_id, command.input),
    deriveCandidate: command => bridge.deriveCandidate(command.project_id, command.candidate_id, command.input),
    estimateVersionDerivation: command => bridge.estimateVersionDerivation(command.project_id, command.version_id, command.input),
    deriveVersion: command => bridge.deriveVersion(command.project_id, command.version_id, command.input),
    adoptCandidate: command => bridge.adoptCandidate(command.project_id, command.candidate_id, command.input),
    cancelOperation: input => bridge.cancelGenerationOperation(input.operation_id),
    getCandidatePreview: input => bridge.getCandidatePreview({
      projectId: input.project_id,
      candidateId: input.candidate_id,
    }),
    getVersionPreview: input => bridge.getVersionPreview({
      projectId: input.project_id,
      versionId: input.version_id,
    }),
    listCanvases: input => bridge.listCanvases(input.project_id),
    getCanvas: input => bridge.getCanvas({
      projectId: input.project_id,
      canvasId: input.canvas_id,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    }),
    createCanvas: command => bridge.createCanvas(command.project_id, command.input),
    applyCanvasCommand: command => bridge.applyCanvasCommand(command.project_id, command.canvas_id, command.input),
    preflightCanvas: command => bridge.preflightCanvas(command.project_id, command.canvas_id, command.input),
    renderCanvas: command => bridge.renderCanvas(command.project_id, command.canvas_id, command.input),
    selectArtboardVersion: command => bridge.selectArtboardVersion(command.project_id, command.artboard_id, command.input),
    createDeliverySpec: command => bridge.createDeliverySpecRevision(command.project_id, command.input),
    exportDelivery: command => bridge.exportDelivery(command.project_id, command.input),
    getDeliverySet: input => bridge.getDeliverySet({
      projectId: input.project_id,
      deliverySetId: input.delivery_set_id,
    }),
    getExportReceipt: input => bridge.getExportReceipt({
      projectId: input.project_id,
      receiptId: input.export_receipt_id,
    }),
    requestDestination: input => bridge.requestDestination(input),
    saveOutput: command => bridge.saveOutput(command.project_id, command.input),
    getProjectLibrary: input => bridge.getProjectLibrary(input.project_id),
    listBrandKits: () => bridge.listBrandKits(),
    getBrandKit: input => bridge.getBrandKit(input.brand_kit_id),
    createBrandKit: input => bridge.createBrandKit(input),
    reviseBrandKit: command => bridge.reviseBrandKit({
      brandKitId: command.brand_kit_id,
      input: command.input,
    }),
    deleteBrandKit: input => bridge.deleteBrandKit({
      brandKitId: input.brand_kit_id,
      input: input.input,
    }),
    listTemplates: () => bridge.listTemplates(),
    getTemplate: input => bridge.getTemplate(input.template_id),
    createTemplate: input => bridge.createTemplate(input),
    reviseTemplate: command => bridge.reviseTemplate({
      templateId: command.template_id,
      input: command.input,
    }),
    deleteTemplate: input => bridge.deleteTemplate({
      templateId: input.template_id,
      input: input.input,
    }),
    createAssetGrant: command => bridge.createAssetGrant(command.input),
    revokeAssetGrant: command => bridge.revokeAssetGrant({
      grantId: command.grant_id,
      input: command.input,
    }),
    listAssetGrants: () => bridge.listAssetGrants(),
    listCampaigns: input => bridge.listCampaigns(input),
    getCampaign: input => bridge.getCampaign(input.campaign_id),
    createCampaign: input => bridge.createCampaign(input),
    replaceCampaignItems: command => bridge.replaceCampaignItems({
      campaignId: command.campaign_id,
      input: command.input,
    }),
    estimateCampaign: command => bridge.estimateCampaign({
      campaignId: command.campaign_id,
      input: command.input,
    }),
    confirmCampaign: command => bridge.confirmCampaign({
      campaignId: command.campaign_id,
      input: command.input,
    }),
    confirmCampaignRetry: command => bridge.confirmCampaignRetry({
      campaignId: command.campaign_id,
      itemId: command.item_id,
      input: command.input,
    }),
    startCampaign: command => bridge.startCampaign({
      campaignId: command.campaign_id,
      input: command.input,
    }),
    cancelCampaign: command => bridge.cancelCampaign({
      campaignId: command.campaign_id,
      input: command.input,
    }),
    retryCampaignItem: command => bridge.retryCampaignItem({
      campaignId: command.campaign_id,
      itemId: command.item_id,
      input: command.input,
    }),
  }
}
