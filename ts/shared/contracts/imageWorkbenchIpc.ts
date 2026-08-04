import { z } from 'zod/v4'
import {
  imageProjectResponseSchema,
  publicMediaJobEventPageSchema,
  mediaIdSchema,
} from './media.js'
import {
  imageCanvasCommandResponseSchema,
  imageCanvasPreflightResponseSchema,
  imageCanvasRenderResponseSchema,
  imageCanvasRevisionSchema,
  imageCanvasCommandRequestInputSchema,
  imageCanvasCreateInputSchema,
  imageCanvasPreflightInputSchema,
  imageCanvasRenderInputSchema,
  imageCandidateAdoptionResponseSchema,
  imageCandidateDecisionResponseSchema,
  imageCandidateDerivationResponseSchema,
  imageCreativePlanResponseSchema,
  imageDeliverySetSchema,
  imageDeliverySpecRevisionInputSchema,
  imageDeliverySpecRevisionResponseSchema,
  imageDerivationEstimateResponseSchema,
  imageExportResponseSchema,
  imageExportInputSchema,
  imageGenerationCancelResponseSchema,
  imageGenerationRoundEstimateResponseSchema,
  imageGenerationRoundResponseSchema,
  imageReferenceControlResponseSchema,
  adoptImageCandidateInputSchema,
  createCreativePlanInputSchema,
  createGenerationRoundInputSchema,
  decideImageCandidateInputSchema,
  deriveImageCandidateInputSchema,
  estimateDeriveImageCandidateInputSchema,
  estimateGenerationRoundInputSchema,
  publicImageCandidateGroupSchema,
  updateImageReferenceControlInputSchema,
} from './imageGeneration.js'
import {
  addImageWorkflowReferencesInputSchema,
  applyImageBriefOverridesInputSchema,
  cancelImageCampaignInputSchema,
  compileImageBriefResponseSchema,
  confirmImageCampaignInputSchema,
  createImageAssetGrantInputSchema,
  createImageBrandKitInputSchema,
  createImageCampaignInputSchema,
  createImageTemplateInputSchema,
  deleteImageReusableAggregateInputSchema,
  estimateImageCampaignInputSchema,
  imageAssetGrantListResponseSchema,
  imageAssetGrantResponseSchema,
  imageBrandKitListResponseSchema,
  imageBrandKitResponseSchema,
  imageCandidatePreviewResponseSchema,
  imageCampaignConfirmationResponseSchema,
  imageCampaignEstimateResponseSchema,
  imageCampaignListInputSchema,
  imageCampaignListResponseSchema,
  imageCampaignResponseSchema,
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
  promoteImageInspirationItemInputSchema,
  removeImageWorkflowReferenceInputSchema,
  replaceImageCampaignItemsInputSchema,
  reviseImageBrandKitInputSchema,
  reviseImageTemplateInputSchema,
  revokeImageAssetGrantInputSchema,
  retryImageCampaignItemInputSchema,
  startImageCampaignInputSchema,
  upsertImageInspirationItemsInputSchema,
} from './imageWorkflow.js'

const emptyPayloadSchema = z.object({}).strict()
const projectIdPayloadSchema = z.object({ projectId: mediaIdSchema }).strict()

export const imageWorkbenchIpcPayloadSchemas = {
  listProjects: emptyPayloadSchema,
  getProject: projectIdPayloadSchema,
  getProjectProjection: projectIdPayloadSchema,
  listOperationEvents: z.object({
    projectId: mediaIdSchema,
    cursor: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200).optional(),
    waitMs: z.number().int().min(0).max(25_000).optional(),
  }).strict(),
  quickCreate: z.object({ input: imageQuickCreateInputSchema }).strict(),
  compileBrief: projectIdPayloadSchema,
  applyBriefOverrides: z.object({
    projectId: mediaIdSchema,
    briefId: mediaIdSchema,
    input: applyImageBriefOverridesInputSchema,
  }).strict(),
  getInspirationBoard: projectIdPayloadSchema,
  upsertInspirationItems: z.object({ projectId: mediaIdSchema, input: upsertImageInspirationItemsInputSchema }).strict(),
  promoteInspirationItem: z.object({
    projectId: mediaIdSchema,
    inspirationItemId: mediaIdSchema,
    input: promoteImageInspirationItemInputSchema,
  }).strict(),
  addReferences: z.object({ projectId: mediaIdSchema, input: addImageWorkflowReferencesInputSchema }).strict(),
  removeReference: z.object({
    projectId: mediaIdSchema,
    referenceId: mediaIdSchema,
    input: removeImageWorkflowReferenceInputSchema,
  }).strict(),
  updateReferenceControl: z.object({
    projectId: mediaIdSchema,
    referenceId: mediaIdSchema,
    input: updateImageReferenceControlInputSchema,
  }).strict(),
  createCreativePlan: z.object({ projectId: mediaIdSchema, input: createCreativePlanInputSchema }).strict(),
  estimateGenerationRound: z.object({ projectId: mediaIdSchema, input: estimateGenerationRoundInputSchema }).strict(),
  createGenerationRound: z.object({ projectId: mediaIdSchema, input: createGenerationRoundInputSchema }).strict(),
  getCandidateGroup: z.object({ projectId: mediaIdSchema, candidateGroupId: mediaIdSchema }).strict(),
  getCandidatePreview: z.object({ projectId: mediaIdSchema, candidateId: mediaIdSchema }).strict(),
  decideCandidate: z.object({ projectId: mediaIdSchema, candidateId: mediaIdSchema, input: decideImageCandidateInputSchema }).strict(),
  estimateCandidateDerivation: z.object({ projectId: mediaIdSchema, candidateId: mediaIdSchema, input: estimateDeriveImageCandidateInputSchema }).strict(),
  deriveCandidate: z.object({ projectId: mediaIdSchema, candidateId: mediaIdSchema, input: deriveImageCandidateInputSchema }).strict(),
  adoptCandidate: z.object({ projectId: mediaIdSchema, candidateId: mediaIdSchema, input: adoptImageCandidateInputSchema }).strict(),
  cancelOperation: z.object({ projectId: mediaIdSchema, operationId: mediaIdSchema }).strict(),
  listCanvases: projectIdPayloadSchema,
  getCanvas: z.object({ projectId: mediaIdSchema, canvasId: mediaIdSchema, revision: z.number().int().nonnegative().optional() }).strict(),
  createCanvas: z.object({ projectId: mediaIdSchema, input: imageCanvasCreateInputSchema }).strict(),
  applyCanvasCommand: z.object({ projectId: mediaIdSchema, canvasId: mediaIdSchema, input: imageCanvasCommandRequestInputSchema }).strict(),
  preflightCanvas: z.object({ projectId: mediaIdSchema, canvasId: mediaIdSchema, input: imageCanvasPreflightInputSchema }).strict(),
  renderCanvas: z.object({ projectId: mediaIdSchema, canvasId: mediaIdSchema, input: imageCanvasRenderInputSchema }).strict(),
  createDeliverySpec: z.object({ projectId: mediaIdSchema, input: imageDeliverySpecRevisionInputSchema }).strict(),
  exportDelivery: z.object({ projectId: mediaIdSchema, input: imageExportInputSchema }).strict(),
  getDeliverySet: z.object({ projectId: mediaIdSchema, deliverySetId: mediaIdSchema }).strict(),
  getProjectLibrary: projectIdPayloadSchema,
  listBrandKits: emptyPayloadSchema,
  getBrandKit: z.object({ brandKitId: mediaIdSchema }).strict(),
  createBrandKit: z.object({ input: createImageBrandKitInputSchema }).strict(),
  reviseBrandKit: z.object({ brandKitId: mediaIdSchema, input: reviseImageBrandKitInputSchema }).strict(),
  deleteBrandKit: z.object({ brandKitId: mediaIdSchema, input: deleteImageReusableAggregateInputSchema }).strict(),
  listTemplates: emptyPayloadSchema,
  getTemplate: z.object({ templateId: mediaIdSchema }).strict(),
  createTemplate: z.object({ input: createImageTemplateInputSchema }).strict(),
  reviseTemplate: z.object({ templateId: mediaIdSchema, input: reviseImageTemplateInputSchema }).strict(),
  deleteTemplate: z.object({ templateId: mediaIdSchema, input: deleteImageReusableAggregateInputSchema }).strict(),
  createAssetGrant: z.object({ input: createImageAssetGrantInputSchema }).strict(),
  revokeAssetGrant: z.object({ grantId: mediaIdSchema, input: revokeImageAssetGrantInputSchema }).strict(),
  listAssetGrants: emptyPayloadSchema,
  listCampaigns: z.object({ input: imageCampaignListInputSchema.optional() }).strict(),
  getCampaign: z.object({ campaignId: mediaIdSchema }).strict(),
  createCampaign: z.object({ input: createImageCampaignInputSchema }).strict(),
  replaceCampaignItems: z.object({ campaignId: mediaIdSchema, input: replaceImageCampaignItemsInputSchema }).strict(),
  estimateCampaign: z.object({ campaignId: mediaIdSchema, input: estimateImageCampaignInputSchema }).strict(),
  confirmCampaign: z.object({ campaignId: mediaIdSchema, input: confirmImageCampaignInputSchema }).strict(),
  confirmCampaignRetry: z.object({ campaignId: mediaIdSchema, itemId: mediaIdSchema, input: confirmImageCampaignInputSchema }).strict(),
  startCampaign: z.object({ campaignId: mediaIdSchema, input: startImageCampaignInputSchema }).strict(),
  cancelCampaign: z.object({ campaignId: mediaIdSchema, input: cancelImageCampaignInputSchema }).strict(),
  retryCampaignItem: z.object({ campaignId: mediaIdSchema, itemId: mediaIdSchema, input: retryImageCampaignItemInputSchema }).strict(),
} as const

export const imageWorkbenchIpcPayloadSchema = z.object({
  method: z.string().min(1).max(80),
  payload: z.unknown(),
}).strict()

export function parseImageWorkbenchIpcRequest(value: unknown): ImageWorkbenchIpcRequest {
  const envelope = imageWorkbenchIpcPayloadSchema.parse(value)
  if (!Object.prototype.hasOwnProperty.call(imageWorkbenchIpcPayloadSchemas, envelope.method)) {
    throw new Error('未知的图片工作台 IPC 方法')
  }
  const method = envelope.method as ImageWorkbenchIpcMethod
  return {
    method,
    payload: imageWorkbenchIpcPayloadSchemas[method].parse(envelope.payload),
  } as ImageWorkbenchIpcRequest
}

export const imageWorkbenchIpcResponseSchemas = {
  listProjects: imageWorkbenchProjectListResponseSchema,
  getProject: imageProjectResponseSchema,
  getProjectProjection: imageWorkbenchProjectProjectionSchema,
  listOperationEvents: publicMediaJobEventPageSchema,
  quickCreate: imageQuickCreateResponseSchema,
  compileBrief: compileImageBriefResponseSchema,
  applyBriefOverrides: imageWorkflowProjectResponseSchema,
  getInspirationBoard: imageInspirationBoardReadResponseSchema,
  upsertInspirationItems: imageInspirationBoardResponseSchema,
  promoteInspirationItem: imageInspirationBoardResponseSchema,
  addReferences: imageWorkflowProjectResponseSchema,
  removeReference: imageWorkflowProjectResponseSchema,
  updateReferenceControl: imageReferenceControlResponseSchema,
  createCreativePlan: imageCreativePlanResponseSchema,
  estimateGenerationRound: imageGenerationRoundEstimateResponseSchema,
  createGenerationRound: imageGenerationRoundResponseSchema,
  getCandidateGroup: z.object({ candidate_group: publicImageCandidateGroupSchema }).strict(),
  getCandidatePreview: imageCandidatePreviewResponseSchema,
  decideCandidate: imageCandidateDecisionResponseSchema,
  estimateCandidateDerivation: imageDerivationEstimateResponseSchema,
  deriveCandidate: imageCandidateDerivationResponseSchema,
  adoptCandidate: imageCandidateAdoptionResponseSchema,
  cancelOperation: imageGenerationCancelResponseSchema,
  listCanvases: z.object({ canvases: z.array(imageCanvasRevisionSchema).max(512) }).strict(),
  getCanvas: z.object({ canvas: imageCanvasRevisionSchema }).strict(),
  createCanvas: imageCanvasCommandResponseSchema,
  applyCanvasCommand: imageCanvasCommandResponseSchema,
  preflightCanvas: imageCanvasPreflightResponseSchema,
  renderCanvas: imageCanvasRenderResponseSchema,
  createDeliverySpec: imageDeliverySpecRevisionResponseSchema,
  exportDelivery: imageExportResponseSchema,
  getDeliverySet: z.object({ delivery_set: imageDeliverySetSchema }).strict(),
  getProjectLibrary: imageProjectLibrarySchema,
  listBrandKits: imageBrandKitListResponseSchema,
  getBrandKit: imageBrandKitResponseSchema,
  createBrandKit: imageBrandKitResponseSchema,
  reviseBrandKit: imageBrandKitResponseSchema,
  deleteBrandKit: imageBrandKitResponseSchema,
  listTemplates: imageTemplateListResponseSchema,
  getTemplate: imageTemplateResponseSchema,
  createTemplate: imageTemplateResponseSchema,
  reviseTemplate: imageTemplateResponseSchema,
  deleteTemplate: imageTemplateResponseSchema,
  createAssetGrant: imageAssetGrantResponseSchema,
  revokeAssetGrant: imageAssetGrantResponseSchema,
  listAssetGrants: imageAssetGrantListResponseSchema,
  listCampaigns: imageCampaignListResponseSchema,
  getCampaign: imageCampaignResponseSchema,
  createCampaign: imageCampaignResponseSchema,
  replaceCampaignItems: imageCampaignResponseSchema,
  estimateCampaign: imageCampaignEstimateResponseSchema,
  confirmCampaign: imageCampaignConfirmationResponseSchema,
  confirmCampaignRetry: imageCampaignConfirmationResponseSchema,
  startCampaign: imageCampaignResponseSchema,
  cancelCampaign: imageCampaignResponseSchema,
  retryCampaignItem: imageCampaignResponseSchema,
} as const

export type ImageWorkbenchIpcMethod = keyof typeof imageWorkbenchIpcPayloadSchemas
export type ImageWorkbenchIpcPayloadByMethod = {
  [Method in ImageWorkbenchIpcMethod]: z.input<(typeof imageWorkbenchIpcPayloadSchemas)[Method]>
}
export type ImageWorkbenchIpcValueByMethod = {
  [Method in ImageWorkbenchIpcMethod]: z.infer<(typeof imageWorkbenchIpcResponseSchemas)[Method]>
}
export type ImageWorkbenchIpcRequest = {
  [Method in ImageWorkbenchIpcMethod]: {
    method: Method
    payload: ImageWorkbenchIpcPayloadByMethod[Method]
  }
}[ImageWorkbenchIpcMethod]

export function parseImageWorkbenchIpcPayload<Method extends ImageWorkbenchIpcMethod>(
  method: Method,
  payload: unknown,
): ImageWorkbenchIpcPayloadByMethod[Method] {
  return imageWorkbenchIpcPayloadSchemas[method].parse(payload) as ImageWorkbenchIpcPayloadByMethod[Method]
}

export function parseImageWorkbenchIpcValue<Method extends ImageWorkbenchIpcMethod>(
  method: Method,
  value: unknown,
): ImageWorkbenchIpcValueByMethod[Method] {
  return imageWorkbenchIpcResponseSchemas[method].parse(value) as ImageWorkbenchIpcValueByMethod[Method]
}

export type {
  ImageWorkbenchIpcPayloadByMethod as ImageWorkbenchIpcInputs,
  ImageWorkbenchIpcValueByMethod as ImageWorkbenchIpcOutputs,
}
