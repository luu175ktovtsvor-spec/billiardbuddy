import { z } from 'zod/v4'
import {
  imageBriefOverridesSchema,
  mediaAssetSchema,
  mediaIdSchema,
  mediaIsoDateSchema,
  mediaOwnerSchema,
  publicImageWorkbenchProjectSchema,
} from './media.js'
import {
  imageBrandKitRevisionSchema,
  imageCanvasRevisionSchema,
  imageCreativePlanSchema,
  imageDeliverySpecSchema,
  imageGenerationRoundSchema,
  imageHashSchema,
  imageReferenceInfluenceSchema,
  imageReferencePreservationSchema,
  imageReferenceRoleV2Schema,
  imageTemplateRevisionSchema,
  publicImageCandidateGroupSchema,
  publicImageOperationV2Schema,
} from './imageGeneration.js'

const MAX_IMAGE_DATA_URL_CHARS = Math.ceil(8 * 1024 * 1024 * 4 / 3) + 128
const imageDataUrlSchema = z.string()
  .max(MAX_IMAGE_DATA_URL_CHARS)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)

const commandFields = {
  idempotency_key: z.string().min(16).max(160),
  base_revision: z.number().int().nonnegative(),
}

const imageReferenceRoleForInputSchema = imageReferenceRoleV2Schema.exclude(['unclassified'])

export const imageWorkflowAssetOwnerSchema = z.object({
  kind: z.enum(['project', 'brand_kit', 'template']),
  id: mediaIdSchema,
}).strict()

/**
 * Shared Main/Preload contract for protected candidate bytes.  This remains a
 * bounded data URL because a renderer cannot attach a media capability token
 * to an image element itself.
 */
export const imageCandidatePreviewInputSchema = z.object({
  project_id: mediaIdSchema,
  candidate_id: mediaIdSchema,
}).strict()

export const imageCandidatePreviewResponseSchema = z.object({
  candidate_id: mediaIdSchema,
  data_url: imageDataUrlSchema,
}).strict()

/**
 * Main resolves a rendered Version through the protected content route and
 * returns only bounded, verified pixels to the Renderer. The Renderer must
 * never turn a Version path into a directly loadable URL.
 */
export const imageVersionPreviewInputSchema = z.object({
  project_id: mediaIdSchema,
  version_id: mediaIdSchema,
}).strict()

export const imageVersionPreviewResponseSchema = z.object({
  version_id: mediaIdSchema,
  data_url: imageDataUrlSchema,
}).strict()

export const imageAssetProvenanceSchema = z.object({
  asset_id: mediaIdSchema,
  owner: imageWorkflowAssetOwnerSchema,
  origin: z.enum(['user_upload', 'generated', 'derived', 'template']),
  source_asset_ids: z.array(mediaIdSchema).max(32),
  source_project_id: mediaIdSchema.optional(),
  source_version_id: mediaIdSchema.optional(),
  user_rights_note: z.string().min(1).max(1_000).optional(),
  retention: z.enum(['project', 'brand_kit', 'template']),
  created_at: mediaIsoDateSchema,
}).strict()

export const imageAssetGrantSchema = z.object({
  id: mediaIdSchema,
  asset_id: mediaIdSchema,
  from_owner: imageWorkflowAssetOwnerSchema,
  to_owner: imageWorkflowAssetOwnerSchema,
  purpose: z.enum(['render', 'template_use', 'project_reuse']),
  granted_by: mediaOwnerSchema,
  created_at: mediaIsoDateSchema,
  revoked_at: mediaIsoDateSchema.optional(),
}).strict()

export const imageInspirationItemSchema = z.object({
  id: mediaIdSchema,
  board_id: mediaIdSchema,
  project_id: mediaIdSchema,
  asset_id: mediaIdSchema,
  note: z.string().min(1).max(2_000).optional(),
  promoted_reference_asset_id: mediaIdSchema.optional(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).strict()

export const imageInspirationBoardSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  revision: z.number().int().nonnegative(),
  items: z.array(imageInspirationItemSchema).max(64),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).strict()

const inspirationItemInputSchema = z.object({
  id: mediaIdSchema.optional(),
  data_url: imageDataUrlSchema.optional(),
  note: z.string().min(1).max(2_000).optional(),
}).strict().superRefine((value, context) => {
  if (!value.id && !value.data_url) {
    context.addIssue({ code: 'custom', message: 'new inspiration items require data_url' })
  }
})

export const upsertImageInspirationItemsInputSchema = z.object({
  ...commandFields,
  items: z.array(inspirationItemInputSchema).min(1).max(32),
}).strict()

export const promoteImageInspirationItemInputSchema = z.object({
  ...commandFields,
  role: imageReferenceRoleForInputSchema,
  influence_strength: imageReferenceInfluenceSchema,
  preservation: imageReferencePreservationSchema,
  priority: z.number().int().min(0).max(1_000),
  label: z.string().min(1).max(120).optional(),
}).strict()

export const imageReferenceInputSchema = z.object({
  data_url: imageDataUrlSchema,
  role: imageReferenceRoleForInputSchema,
  influence_strength: imageReferenceInfluenceSchema,
  preservation: imageReferencePreservationSchema,
  priority: z.number().int().min(0).max(1_000),
  label: z.string().min(1).max(120).optional(),
}).strict()

export const addImageWorkflowReferencesInputSchema = z.object({
  ...commandFields,
  references: z.array(imageReferenceInputSchema).min(1).max(8),
}).strict()

export const removeImageWorkflowReferenceInputSchema = z.object({
  ...commandFields,
}).strict()

export const applyImageBriefOverridesInputSchema = z.object({
  ...commandFields,
  overrides: imageBriefOverridesSchema,
}).strict()

export const compileImageBriefResponseSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
  brief_id: mediaIdSchema,
  snapshot_hash: imageHashSchema,
}).strict()

export const imageWorkflowProjectResponseSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
}).strict()

export const imageWorkbenchProjectListResponseSchema = z.object({
  projects: z.array(publicImageWorkbenchProjectSchema).max(1_000),
}).strict()

export const imageInspirationBoardResponseSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
  board: imageInspirationBoardSchema,
}).strict()

export const imageInspirationBoardReadResponseSchema = z.object({
  board: imageInspirationBoardSchema.nullable(),
}).strict()

export const imageQuickCreateInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  prompt: z.string().min(1).max(8_000),
  title: z.string().min(1).max(160).optional(),
  output_preset: z.enum(['square', 'landscape', 'portrait', 'auto']),
  /**
   * Optional full Intake supplied before Quick Create persists its first
   * paid Round. These user-confirmed facts must therefore be part of the
   * command hash, Project snapshot and provider request from the outset.
   */
  brief_overrides: imageBriefOverridesSchema.optional(),
  reference_inputs: z.array(z.object({
    data_url: imageDataUrlSchema,
    role: imageReferenceRoleForInputSchema,
  }).strict()).max(8).default([]),
  budget_limit: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount_minor: z.number().int().positive().max(2_000_000_000),
  }).strict().optional(),
}).strict()

export const imageQuickCreateResponseSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
  round: imageGenerationRoundSchema,
  operations: z.array(publicImageOperationV2Schema).min(1).max(1),
}).strict()

export const imageLibraryEntrySchema = z.object({
  asset_id: mediaIdSchema,
  project_id: mediaIdSchema,
  role: mediaAssetSchema.shape.role,
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  byte_size: z.number().int().nonnegative().optional(),
  content_hash: imageHashSchema.optional(),
  origin: z.enum(['user_upload', 'generated', 'derived', 'template']),
  source_asset_ids: z.array(mediaIdSchema).max(32),
  source_project_id: mediaIdSchema.optional(),
  source_version_id: mediaIdSchema.optional(),
  grant_id: mediaIdSchema.optional(),
  created_at: mediaIsoDateSchema,
}).strict()

export const imageProjectLibrarySchema = z.object({
  project_id: mediaIdSchema,
  entries: z.array(imageLibraryEntrySchema).max(1_000),
}).strict()

/**
 * Immutable Campaign context for an ordinary child Project.  It deliberately
 * contains Canvas-ready slot bindings rather than a prompt suffix: a user
 * still adopts a Candidate and then invokes the normal Canvas command.
 */
export const imageCampaignTemplateSlotBindingSchema = z.object({
  slot_id: z.string().min(1).max(120),
  text: z.string().min(1).max(2_000).optional(),
  qr_payload: z.string().min(1).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.text) === Boolean(value.qr_payload)) {
    context.addIssue({ code: 'custom', message: 'campaign slot binding must contain exactly one value' })
  }
})

export const imageCampaignProjectIntentSchema = z.object({
  project_id: mediaIdSchema,
  campaign_id: mediaIdSchema,
  campaign_revision: z.number().int().nonnegative(),
  item_id: mediaIdSchema,
  attempt: z.number().int().positive(),
  brand_kit_id: mediaIdSchema.optional(),
  brand_kit_revision_id: mediaIdSchema.optional(),
  template_id: mediaIdSchema.optional(),
  template_revision_id: mediaIdSchema.optional(),
  slot_bindings: z.array(imageCampaignTemplateSlotBindingSchema).max(80),
}).strict().superRefine((value, context) => {
  if (Boolean(value.brand_kit_id) !== Boolean(value.brand_kit_revision_id)) {
    context.addIssue({ code: 'custom', message: 'campaign intent brand id and revision must be paired' })
  }
  if (Boolean(value.template_id) !== Boolean(value.template_revision_id)) {
    context.addIssue({ code: 'custom', message: 'campaign intent template id and revision must be paired' })
  }
  if (!value.template_id && value.slot_bindings.length > 0) {
    context.addIssue({ code: 'custom', message: 'campaign intent slot bindings require a template' })
  }
  const seen = new Set<string>()
  for (const binding of value.slot_bindings) {
    if (seen.has(binding.slot_id)) context.addIssue({ code: 'custom', message: 'campaign intent slot ids must be unique' })
    seen.add(binding.slot_id)
  }
})

/**
 * The sole persisted-business-state reload payload for the image renderer.
 * It intentionally contains only public project/operation facts; selection,
 * panel expansion and in-progress dragging remain renderer-local state.
 */
export const imageWorkbenchProjectProjectionSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
  inspiration_board: imageInspirationBoardSchema.nullable(),
  creative_plans: z.array(imageCreativePlanSchema).max(512),
  generation_rounds: z.array(imageGenerationRoundSchema).max(512),
  operations: z.array(publicImageOperationV2Schema).max(2_000),
  candidate_groups: z.array(publicImageCandidateGroupSchema).max(2_000),
  canvases: z.array(imageCanvasRevisionSchema).max(512),
  delivery_spec: imageDeliverySpecSchema.nullable(),
  library: imageProjectLibrarySchema,
  campaign_intent: imageCampaignProjectIntentSchema.nullable(),
}).strict()

export const imageBrandKitSchema = z.object({
  id: mediaIdSchema,
  owner: mediaOwnerSchema,
  name: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  current_revision_id: mediaIdSchema,
  state: z.enum(['active', 'trashed']),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).strict()

export const imageTemplateSchema = z.object({
  id: mediaIdSchema,
  owner: mediaOwnerSchema,
  name: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  current_revision_id: mediaIdSchema,
  state: z.enum(['active', 'trashed']),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).strict()

const brandRevisionDraftSchema = imageBrandKitRevisionSchema.omit({
  id: true,
  brand_kit_id: true,
  revision: true,
  owner: true,
  created_at: true,
})

// Zod 4 intentionally rejects `.omit()` on a refined object. The complete
// revision is parsed again after the service supplies identity/owner fields,
// where imageTemplateRevisionSchema retains its slot/layer refinement.
const templateRevisionDraftSchema = z.object({
  brand_kit_id: imageTemplateRevisionSchema.shape.brand_kit_id,
  brand_kit_revision_id: imageTemplateRevisionSchema.shape.brand_kit_revision_id,
  blueprint: imageTemplateRevisionSchema.shape.blueprint,
  slots: imageTemplateRevisionSchema.shape.slots,
  schema_version: imageTemplateRevisionSchema.shape.schema_version,
}).strict()

export const createImageBrandKitInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  name: z.string().min(1).max(160),
  revision: brandRevisionDraftSchema,
}).strict()

export const reviseImageBrandKitInputSchema = z.object({
  ...commandFields,
  revision: brandRevisionDraftSchema,
}).strict()

export const imageBrandKitResponseSchema = z.object({
  brand_kit: imageBrandKitSchema,
  revision: imageBrandKitRevisionSchema,
}).strict()

export const imageBrandKitListResponseSchema = z.object({
  brand_kits: z.array(imageBrandKitSchema).max(1_000),
}).strict()

export const createImageTemplateInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  name: z.string().min(1).max(160),
  revision: templateRevisionDraftSchema,
}).strict()

export const reviseImageTemplateInputSchema = z.object({
  ...commandFields,
  revision: templateRevisionDraftSchema,
}).strict()

export const imageTemplateResponseSchema = z.object({
  template: imageTemplateSchema,
  revision: imageTemplateRevisionSchema,
}).strict()

export const imageTemplateListResponseSchema = z.object({
  templates: z.array(imageTemplateSchema).max(1_000),
}).strict()

export const deleteImageReusableAggregateInputSchema = z.object({
  ...commandFields,
}).strict()

export const createImageAssetGrantInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  asset_id: mediaIdSchema,
  to_owner: imageWorkflowAssetOwnerSchema,
  purpose: z.enum(['render', 'template_use', 'project_reuse']),
}).strict().superRefine((value, context) => {
  const allowedPurposes = value.to_owner.kind === 'project'
    ? new Set(['render', 'project_reuse'])
    : value.to_owner.kind === 'brand_kit'
      ? new Set(['render', 'template_use'])
      : new Set(['template_use'])
  if (!allowedPurposes.has(value.purpose)) {
    context.addIssue({
      code: 'custom',
      message: `grant purpose ${value.purpose} is not valid for ${value.to_owner.kind}`,
      path: ['purpose'],
    })
  }
})

export const revokeImageAssetGrantInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
}).strict()

export const imageAssetGrantResponseSchema = z.object({
  grant: imageAssetGrantSchema,
}).strict()

export const imageAssetGrantListResponseSchema = z.object({
  grants: z.array(imageAssetGrantSchema).max(1_000),
}).strict()

export const imageCampaignVariableValueSchema = z.object({
  slot_id: z.string().min(1).max(120),
  value: z.string().min(1).max(2_000),
}).strict()

export const imageCampaignItemSchema = z.object({
  id: mediaIdSchema,
  campaign_id: mediaIdSchema,
  ordinal: z.number().int().nonnegative().max(10_000),
  variable_values: z.array(imageCampaignVariableValueSchema).max(80),
  project_id: mediaIdSchema.optional(),
  state: z.enum(['draft', 'queued', 'running', 'ready', 'failed', 'cancelled']),
  attempt: z.number().int().positive(),
  /** Durable proof of the separately confirmed paid retry attempt. */
  retry_estimate_hash: imageHashSchema.optional(),
  retry_confirmation_receipt_id: mediaIdSchema.optional(),
  safe_error_code: z.string().min(1).max(120).optional(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).strict().superRefine((value, context) => {
  const hasRetryReceipt = Boolean(value.retry_estimate_hash) || Boolean(value.retry_confirmation_receipt_id)
  if (Boolean(value.retry_estimate_hash) !== Boolean(value.retry_confirmation_receipt_id)) {
    context.addIssue({ code: 'custom', message: 'retry estimate and confirmation receipt must be paired' })
  }
  if (value.attempt === 1 && hasRetryReceipt) {
    context.addIssue({ code: 'custom', message: 'initial campaign attempt cannot carry a retry receipt' })
  }
})

export const imageCampaignSharedBriefSchema = z.object({
  user_request: z.string().min(1).max(8_000),
  confirmed_facts: z.array(z.string().min(1).max(500)).max(40),
  must_preserve: z.array(z.string().min(1).max(500)).max(40),
}).strict()

export const imageCampaignSchema = z.object({
  id: mediaIdSchema,
  owner: mediaOwnerSchema,
  name: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  state: z.enum(['draft', 'confirmed', 'running', 'completed', 'cancelled']),
  brand_kit_id: mediaIdSchema.optional(),
  brand_kit_revision_id: mediaIdSchema.optional(),
  template_id: mediaIdSchema.optional(),
  template_revision_id: mediaIdSchema.optional(),
  shared_brief: imageCampaignSharedBriefSchema,
  output_preset: z.enum(['square', 'landscape', 'portrait']),
  planned_item_count: z.number().int().nonnegative().max(256),
  estimated_paid_operations: z.number().int().nonnegative().max(256),
  estimate_hash: imageHashSchema.optional(),
  confirmation_receipt_id: mediaIdSchema.optional(),
  budget_limit: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount_minor: z.number().int().positive() }).strict().optional(),
  confirmed_at: mediaIsoDateSchema.optional(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).strict().superRefine((value, context) => {
  if (Boolean(value.brand_kit_id) !== Boolean(value.brand_kit_revision_id)) {
    context.addIssue({ code: 'custom', message: 'campaign brand id and revision must be paired' })
  }
  if (Boolean(value.template_id) !== Boolean(value.template_revision_id)) {
    context.addIssue({ code: 'custom', message: 'campaign template id and revision must be paired' })
  }
})

export const imageCampaignEstimateSchema = z.object({
  id: mediaIdSchema,
  campaign_id: mediaIdSchema,
  campaign_revision: z.number().int().nonnegative(),
  purpose: z.enum(['start', 'retry']).default('start'),
  item_id: mediaIdSchema.optional(),
  /** The explicit new Item attempt covered by a retry quote. */
  attempt: z.number().int().positive().optional(),
  estimate_hash: imageHashSchema,
  paid_operation_count: z.number().int().nonnegative().max(256),
  concurrency: z.number().int().positive().max(32),
  price_upper_bound: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount_minor: z.number().int().nonnegative(),
    pricing_revision: z.string().min(1).max(120),
    usage_upper_bound: z.object({
      requests: z.number().int().nonnegative(),
      input_bytes: z.number().int().nonnegative(),
      output_images: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  expires_at: mediaIsoDateSchema,
  created_at: mediaIsoDateSchema,
}).strict().superRefine((value, context) => {
  const hasRetryIdentity = Boolean(value.item_id) || value.attempt !== undefined
  if (value.purpose === 'retry' && (!value.item_id || value.attempt === undefined)) {
    context.addIssue({ code: 'custom', message: 'retry estimate requires item_id and attempt' })
  }
  if (value.purpose === 'start' && hasRetryIdentity) {
    context.addIssue({ code: 'custom', message: 'start estimate cannot target a campaign item' })
  }
})

export const imageCampaignConfirmationReceiptSchema = z.object({
  id: mediaIdSchema,
  campaign_id: mediaIdSchema,
  campaign_revision: z.number().int().nonnegative(),
  purpose: z.enum(['start', 'retry']).default('start'),
  item_id: mediaIdSchema.optional(),
  attempt: z.number().int().positive().optional(),
  estimate_hash: imageHashSchema,
  confirmed_at: mediaIsoDateSchema,
}).strict().superRefine((value, context) => {
  const hasRetryIdentity = Boolean(value.item_id) || value.attempt !== undefined
  if (value.purpose === 'retry' && (!value.item_id || value.attempt === undefined)) {
    context.addIssue({ code: 'custom', message: 'retry confirmation requires item_id and attempt' })
  }
  if (value.purpose === 'start' && hasRetryIdentity) {
    context.addIssue({ code: 'custom', message: 'start confirmation cannot target a campaign item' })
  }
})

/**
 * A retry quote and its confirmation remain visible until the corresponding
 * next attempt is created or its quote expires.  This is a read projection,
 * not a second retry command: callers still submit its two identifiers to the
 * normal retry endpoint.
 */
export const imageCampaignPendingRetryConfirmationSchema = z.object({
  item_id: mediaIdSchema,
  attempt: z.number().int().positive(),
  estimate_hash: imageHashSchema,
  confirmation_receipt_id: mediaIdSchema,
  expires_at: mediaIsoDateSchema,
}).strict()

const campaignItemDraftSchema = z.object({
  variable_values: z.array(imageCampaignVariableValueSchema).max(80),
}).strict()

export const createImageCampaignInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  name: z.string().min(1).max(160),
  brand_kit_id: mediaIdSchema.optional(),
  brand_kit_revision_id: mediaIdSchema.optional(),
  template_id: mediaIdSchema.optional(),
  template_revision_id: mediaIdSchema.optional(),
  shared_brief: imageCampaignSharedBriefSchema,
  output_preset: z.enum(['square', 'landscape', 'portrait']),
  budget_limit: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount_minor: z.number().int().positive() }).strict().optional(),
  items: z.array(campaignItemDraftSchema).min(1).max(256),
}).strict().superRefine((value, context) => {
  if (Boolean(value.brand_kit_id) !== Boolean(value.brand_kit_revision_id)) context.addIssue({ code: 'custom', message: 'campaign brand id and revision must be paired' })
  if (Boolean(value.template_id) !== Boolean(value.template_revision_id)) context.addIssue({ code: 'custom', message: 'campaign template id and revision must be paired' })
})

export const replaceImageCampaignItemsInputSchema = z.object({
  ...commandFields,
  items: z.array(campaignItemDraftSchema).min(1).max(256),
}).strict()

export const estimateImageCampaignInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  /** Omit for the initial Campaign start quote; include for one retry attempt. */
  item_id: mediaIdSchema.optional(),
}).strict()

export const confirmImageCampaignInputSchema = z.object({
  ...commandFields,
  estimate_hash: imageHashSchema,
}).strict()

export const startImageCampaignInputSchema = z.object({
  ...commandFields,
  estimate_hash: imageHashSchema,
  confirmation_receipt_id: mediaIdSchema,
}).strict()

export const cancelImageCampaignInputSchema = z.object({
  ...commandFields,
}).strict()

export const retryImageCampaignItemInputSchema = z.object({
  ...commandFields,
  estimate_hash: imageHashSchema,
  confirmation_receipt_id: mediaIdSchema,
}).strict()

export const imageCampaignResponseSchema = z.object({
  campaign: imageCampaignSchema,
  items: z.array(imageCampaignItemSchema).max(256),
  pending_retry_confirmations: z.array(imageCampaignPendingRetryConfirmationSchema).max(256).default([]),
}).strict()

export const imageCampaignListInputSchema = z.object({
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict()

export const imageCampaignListResponseSchema = z.object({
  campaigns: z.array(imageCampaignSchema).max(50),
  next_cursor: z.number().int().positive().optional(),
}).strict()

export const imageCampaignEstimateResponseSchema = z.object({
  campaign: imageCampaignSchema,
  estimate: imageCampaignEstimateSchema,
}).strict()

export const imageCampaignConfirmationResponseSchema = z.object({
  campaign: imageCampaignSchema,
  confirmation: imageCampaignConfirmationReceiptSchema,
}).strict()

export type ImageWorkflowAssetOwner = z.infer<typeof imageWorkflowAssetOwnerSchema>
export type ImageCandidatePreviewInput = z.infer<typeof imageCandidatePreviewInputSchema>
export type ImageCandidatePreviewResponse = z.infer<typeof imageCandidatePreviewResponseSchema>
export type ImageVersionPreviewInput = z.infer<typeof imageVersionPreviewInputSchema>
export type ImageVersionPreviewResponse = z.infer<typeof imageVersionPreviewResponseSchema>
export type ImageAssetProvenance = z.infer<typeof imageAssetProvenanceSchema>
export type ImageAssetGrant = z.infer<typeof imageAssetGrantSchema>
export type ImageInspirationBoard = z.infer<typeof imageInspirationBoardSchema>
export type ImageInspirationItem = z.infer<typeof imageInspirationItemSchema>
export type UpsertImageInspirationItemsInput = z.input<typeof upsertImageInspirationItemsInputSchema>
export type PromoteImageInspirationItemInput = z.input<typeof promoteImageInspirationItemInputSchema>
export type AddImageWorkflowReferencesInput = z.input<typeof addImageWorkflowReferencesInputSchema>
export type RemoveImageWorkflowReferenceInput = z.input<typeof removeImageWorkflowReferenceInputSchema>
export type ApplyImageBriefOverridesInput = z.input<typeof applyImageBriefOverridesInputSchema>
export type CompileImageBriefResponse = z.infer<typeof compileImageBriefResponseSchema>
export type ImageWorkflowProjectResponse = z.infer<typeof imageWorkflowProjectResponseSchema>
export type ImageWorkbenchProjectListResponse = z.infer<typeof imageWorkbenchProjectListResponseSchema>
export type ImageInspirationBoardResponse = z.infer<typeof imageInspirationBoardResponseSchema>
export type ImageInspirationBoardReadResponse = z.infer<typeof imageInspirationBoardReadResponseSchema>
export type ImageQuickCreateInput = z.input<typeof imageQuickCreateInputSchema>
export type ImageQuickCreateResponse = z.infer<typeof imageQuickCreateResponseSchema>
export type ImageLibraryEntry = z.infer<typeof imageLibraryEntrySchema>
export type ImageProjectLibrary = z.infer<typeof imageProjectLibrarySchema>
export type ImageCampaignTemplateSlotBinding = z.infer<typeof imageCampaignTemplateSlotBindingSchema>
export type ImageCampaignProjectIntent = z.infer<typeof imageCampaignProjectIntentSchema>
export type ImageWorkbenchProjectProjection = z.infer<typeof imageWorkbenchProjectProjectionSchema>
export type ImageBrandKit = z.infer<typeof imageBrandKitSchema>
export type ImageTemplate = z.infer<typeof imageTemplateSchema>
export type ImageBrandKitResponse = z.infer<typeof imageBrandKitResponseSchema>
export type ImageBrandKitListResponse = z.infer<typeof imageBrandKitListResponseSchema>
export type ImageTemplateResponse = z.infer<typeof imageTemplateResponseSchema>
export type ImageTemplateListResponse = z.infer<typeof imageTemplateListResponseSchema>
export type CreateImageBrandKitInput = z.input<typeof createImageBrandKitInputSchema>
export type ReviseImageBrandKitInput = z.input<typeof reviseImageBrandKitInputSchema>
export type CreateImageTemplateInput = z.input<typeof createImageTemplateInputSchema>
export type ReviseImageTemplateInput = z.input<typeof reviseImageTemplateInputSchema>
export type CreateImageAssetGrantInput = z.input<typeof createImageAssetGrantInputSchema>
export type ImageAssetGrantResponse = z.infer<typeof imageAssetGrantResponseSchema>
export type ImageAssetGrantListResponse = z.infer<typeof imageAssetGrantListResponseSchema>
export type ImageCampaign = z.infer<typeof imageCampaignSchema>
export type ImageCampaignListInput = z.input<typeof imageCampaignListInputSchema>
export type ImageCampaignItem = z.infer<typeof imageCampaignItemSchema>
export type ImageCampaignEstimate = z.infer<typeof imageCampaignEstimateSchema>
export type ImageCampaignConfirmationReceipt = z.infer<typeof imageCampaignConfirmationReceiptSchema>
export type ImageCampaignPendingRetryConfirmation = z.infer<typeof imageCampaignPendingRetryConfirmationSchema>
export type CreateImageCampaignInput = z.input<typeof createImageCampaignInputSchema>
export type ReplaceImageCampaignItemsInput = z.input<typeof replaceImageCampaignItemsInputSchema>
export type EstimateImageCampaignInput = z.input<typeof estimateImageCampaignInputSchema>
export type ConfirmImageCampaignInput = z.input<typeof confirmImageCampaignInputSchema>
export type StartImageCampaignInput = z.input<typeof startImageCampaignInputSchema>
export type CancelImageCampaignInput = z.input<typeof cancelImageCampaignInputSchema>
export type RetryImageCampaignItemInput = z.input<typeof retryImageCampaignItemInputSchema>
export type ImageCampaignResponse = z.infer<typeof imageCampaignResponseSchema>
export type ImageCampaignListResponse = z.infer<typeof imageCampaignListResponseSchema>
export type ImageCampaignEstimateResponse = z.infer<typeof imageCampaignEstimateResponseSchema>
export type ImageCampaignConfirmationResponse = z.infer<typeof imageCampaignConfirmationResponseSchema>
