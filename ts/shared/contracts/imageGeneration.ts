import { z } from 'zod/v4'
import {
  imageGenerationModelSchema,
  mediaAssetSchema,
  mediaIdSchema,
  mediaIsoDateSchema,
  mediaOwnerSchema,
} from './media.js'

export const imageHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const imageReferenceInfluenceSchema = z.enum(['low', 'medium', 'high'])
export const imageReferencePreservationSchema = z.enum(['may_change', 'prefer_preserve', 'must_preserve', 'exact'])
export const imageReferenceRoleV2Schema = z.enum([
  'unclassified', 'subject', 'product', 'character', 'style', 'composition', 'environment', 'brand', 'logo', 'qrcode',
])

export const imageReferenceRuleSchema = z.object({
  reference_id: mediaIdSchema,
  role: imageReferenceRoleV2Schema,
  influence_strength: imageReferenceInfluenceSchema,
  preservation: imageReferencePreservationSchema,
  priority: z.number().int().min(0).max(1_000),
}).strict()

export const imageReferenceV2Schema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  asset_id: mediaIdSchema,
  source_inspiration_item_id: mediaIdSchema.optional(),
  role: imageReferenceRoleV2Schema,
  label: z.string().min(1).max(120).optional(),
  content_hash: imageHashSchema,
  influence_strength: imageReferenceInfluenceSchema,
  preservation: imageReferencePreservationSchema,
  priority: z.number().int().min(0).max(1_000),
  created_at: mediaIsoDateSchema,
}).strict()

export const exactTextRequirementSchema = z.object({
  id: mediaIdSchema,
  text: z.string().min(1).max(500),
  role: z.enum(['title', 'subtitle', 'price', 'date', 'address', 'contact', 'body']),
  required: z.boolean(),
}).strict()

export const imageBriefSnapshotSchema = z.object({
  schema_version: z.literal(2),
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  user_request: z.string().min(1).max(8_000),
  confirmed_facts: z.array(z.string().min(1).max(500)).max(40),
  must_preserve: z.array(z.string().min(1).max(500)).max(40),
  may_change: z.array(z.string().min(1).max(500)).max(40),
  missing_information: z.array(z.string().min(1).max(500)).max(20),
  exact_text: z.array(exactTextRequirementSchema).max(40),
  reference_rules: z.array(imageReferenceRuleSchema).max(8),
  generation_canvas: z.object({
    width: z.number().int().positive().max(12_000),
    height: z.number().int().positive().max(12_000),
    color_space: z.literal('srgb'),
  }).optional(),
  compiler_name: z.literal('image-brief'),
  compiler_version: z.string().min(1).max(120),
  reasoning_receipt_id: mediaIdSchema.optional(),
  snapshot_hash: imageHashSchema,
  created_at: mediaIsoDateSchema,
}).strict()

/** 15.2 owns output-size authority without introducing Canvas editing early. */
const imageSafeAreaSchema = z.object({
  top: z.number().int().nonnegative(),
  right: z.number().int().nonnegative(),
  bottom: z.number().int().nonnegative(),
  left: z.number().int().nonnegative(),
}).strict()

const imageDeliveryOutputSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('png'), transparent: z.boolean() }).strict(),
  z.object({ format: z.literal('jpeg'), quality: z.number().int().min(1).max(100), background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }).strict(),
  z.object({ format: z.literal('webp'), quality: z.number().int().min(1).max(100), transparent: z.boolean() }).strict(),
])

const imageDeliveryArtboardSchema = z.object({
  id: mediaIdSchema,
  label: z.string().min(1).max(120),
  width: z.number().int().positive().max(12_000),
  height: z.number().int().positive().max(12_000),
  required: z.boolean(),
  safe_area: imageSafeAreaSchema.optional(),
  output: imageDeliveryOutputSchema,
}).strict().superRefine((artboard, context) => {
  const safe = artboard.safe_area
  if (!safe) return
  if (safe.left + safe.right > artboard.width || safe.top + safe.bottom > artboard.height) {
    context.addIssue({ code: 'custom', message: 'safe_area must fit within the artboard' })
  }
})

export const imageDeliverySpecSchema = z.object({
  schema_version: z.literal(1),
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  revision: z.number().int().nonnegative(),
  purpose: z.enum(['social_cover', 'product_marketing', 'poster', 'custom']),
  artboards: z.array(imageDeliveryArtboardSchema).min(1).max(32),
  created_at: mediaIsoDateSchema,
}).strict().superRefine((spec, context) => {
  if (new Set(spec.artboards.map(artboard => artboard.id)).size !== spec.artboards.length) {
    context.addIssue({ code: 'custom', message: 'artboard ids must be unique within a delivery spec revision' })
  }
})

export const imageProviderCapabilitySchema = z.enum([
  'image_generation', 'image_editing', 'image_understanding', 'image_visual_assessment',
])
export const providerExecutionReceiptSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  owner: mediaOwnerSchema,
  capability: imageProviderCapabilitySchema,
  registry_capability: z.enum(['ImageGeneration', 'VisualEvidence']),
  provider: z.string().min(1).max(120),
  model_id: imageGenerationModelSchema,
  model_snapshot: z.string().min(1).max(500).optional(),
  policy_revision: z.string().min(1).max(120),
  prompt_compiler_version: z.string().min(1).max(120),
  provider_request_id: z.string().min(1).max(256).optional(),
  idempotency_key: z.string().min(16).max(160),
  request_hash: imageHashSchema,
  input_asset_hashes: z.array(imageHashSchema).max(16),
  output_asset_hashes: z.array(imageHashSchema).max(8).optional(),
  refusal: z.object({ category: z.string().min(1).max(120), safe_message: z.string().min(1).max(500) }).strict().optional(),
  submitted_at: mediaIsoDateSchema,
  completed_at: mediaIsoDateSchema.optional(),
  usage: z.object({
    input_bytes: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    image_count: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict()

export const imageOperationResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('candidate_group'), candidate_group_id: mediaIdSchema,
    expected_count: z.number().int().positive().max(4), valid_count: z.number().int().nonnegative().max(4),
    invalid: z.array(z.object({ index: z.number().int().nonnegative().max(3), safe_error_code: z.string().min(1).max(120) }).strict()).max(4),
  }).strict(),
  z.object({ kind: z.literal('visual_assessment'), assessment_id: mediaIdSchema }).strict(),
  z.object({ kind: z.literal('rendered_version'), version_id: mediaIdSchema, render_receipt_id: mediaIdSchema }).strict(),
  z.object({ kind: z.literal('export_receipts'), export_receipt_ids: z.array(mediaIdSchema).max(32), delivery_set_id: mediaIdSchema.optional() }).strict(),
])

export const imageOperationV2Schema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  owner: mediaOwnerSchema,
  kind: z.enum(['generate', 'edit', 'inpaint', 'assess', 'canvas_render', 'export']),
  status: z.enum(['queued', 'running', 'cancelling', 'committing', 'succeeded', 'failed', 'cancelled', 'blocked_by_policy', 'outcome_unknown']),
  idempotency_key: z.string().min(16).max(160),
  request_hash: imageHashSchema,
  logical_attempt: z.number().int().positive(),
  base_version_id: mediaIdSchema.optional(),
  base_candidate_id: mediaIdSchema.optional(),
  mask_asset_id: mediaIdSchema.optional(),
  instruction: z.string().min(1).max(8_000).optional(),
  input_refs: z.object({
    project_revision: z.number().int().nonnegative(),
    brief_snapshot_hash: imageHashSchema.optional(),
    delivery_spec_revision: z.number().int().nonnegative().optional(),
    canvas_revision: z.number().int().nonnegative().optional(),
    execution_policy_revision: z.string().min(1).max(120),
    asset_hashes: z.array(imageHashSchema).max(16),
  }).strict(),
  transport_task_id: mediaIdSchema.optional(),
  remote_task_id: z.string().min(1).max(256).optional(),
  execution_receipt_id: mediaIdSchema.optional(),
  result: imageOperationResultSchema.optional(),
  completion_freshness: z.enum(['current', 'stale']).optional(),
  safe_error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(500) }).strict().optional(),
  cancellation: z.object({
    requested_at: mediaIsoDateSchema,
    remote_state: z.enum(['pending', 'confirmed', 'unsupported', 'too_late']),
    late_result_policy: z.enum(['retain_as_unadopted', 'discard_after_receipt']),
  }).strict().optional(),
  cost_state: z.enum(['not_submitted', 'submitted_charge_possible', 'usage_recorded']),
  submitted_at: mediaIsoDateSchema.optional(),
  completed_at: mediaIsoDateSchema.optional(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).strict()

export const imageCreativeDirectionSchema = z.object({
  id: mediaIdSchema,
  label: z.string().min(1).max(120),
  rationale: z.string().min(1).max(500),
  generation_intent: z.object({
    composition_goal: z.string().min(1).max(500),
    visual_tone: z.string().min(1).max(500),
    text_space_goal: z.string().min(1).max(500).optional(),
  }).strict(),
  preservation_rules: z.array(z.string().min(1).max(500)).max(40),
}).strict()

export const imageCreativePlanSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, brief_snapshot_hash: imageHashSchema,
  directions: z.array(imageCreativeDirectionSchema).min(1).max(8),
  source: z.enum(['deterministic', 'qwen_suggestion']), suggestion_receipt_id: mediaIdSchema.optional(), created_at: mediaIsoDateSchema,
}).strict()

export const imageGenerationRoundSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, creative_plan_id: mediaIdSchema,
  direction_operations: z.array(z.object({ direction_id: mediaIdSchema, operation_id: mediaIdSchema }).strict()).min(1).max(8),
  estimate_hash: imageHashSchema, confirmed_at: mediaIsoDateSchema, created_at: mediaIsoDateSchema,
}).strict()

export const imageCandidateSchema = z.object({
  id: mediaIdSchema, asset_id: mediaIdSchema, candidate_index: z.number().int().nonnegative().max(3),
  derived_from_candidate_id: mediaIdSchema.optional(), creative_direction_id: mediaIdSchema.optional(), content_hash: imageHashSchema,
  width: z.number().int().positive().max(12_000), height: z.number().int().positive().max(12_000),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']), created_at: mediaIsoDateSchema,
}).strict()

export const imageCandidateGroupSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, operation_id: mediaIdSchema, brief_snapshot_hash: imageHashSchema,
  creative_plan_id: mediaIdSchema.optional(), creative_direction_id: mediaIdSchema.optional(), generation_round_id: mediaIdSchema,
  base_version_id: mediaIdSchema.optional(), candidate_ids: z.array(mediaIdSchema).min(1).max(4), created_at: mediaIsoDateSchema,
}).strict()

export const imageCandidateDecisionSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, candidate_id: mediaIdSchema, decision: z.enum(['kept', 'rejected']),
  supersedes_decision_id: mediaIdSchema.optional(), actor: mediaOwnerSchema, idempotency_key: z.string().min(16).max(160),
  request_hash: imageHashSchema, created_at: mediaIsoDateSchema,
}).strict()

export const imageCandidatePlacementSchema = z.object({
  fit: z.enum(['cover', 'contain']), focus_x: z.number().min(0).max(1), focus_y: z.number().min(0).max(1),
}).strict()

export const imageCandidateAdoptionSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, candidate_id: mediaIdSchema, artboard_id: mediaIdSchema,
  version_id: mediaIdSchema, canvas_id: mediaIdSchema, canvas_revision: z.number().int().nonnegative(),
  placement: imageCandidatePlacementSchema, actor: mediaOwnerSchema, idempotency_key: z.string().min(16).max(160),
  request_hash: imageHashSchema, created_at: mediaIsoDateSchema,
}).strict()

export const publicImageOperationV2Schema = imageOperationV2Schema.omit({
  owner: true,
  idempotency_key: true,
  request_hash: true,
  input_refs: true,
  transport_task_id: true,
  remote_task_id: true,
  execution_receipt_id: true,
  submitted_at: true,
}).extend({
  safe_error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(500) }).strict().optional(),
})
export const publicImageCandidateSchema = imageCandidateSchema.extend({
  image_path: z.string().startsWith('/api/images/projects/'),
})
export const publicImageCandidateGroupSchema = imageCandidateGroupSchema.extend({
  candidates: z.array(publicImageCandidateSchema).max(4),
})

const commandEnvelopeFields = {
  idempotency_key: z.string().min(16).max(160),
  base_revision: z.number().int().nonnegative(),
}

export const createCreativePlanInputSchema = z.object({
  ...commandEnvelopeFields,
  directions: z.array(imageCreativeDirectionSchema.omit({ id: true })).min(1).max(8).optional(),
}).strict()
export const updateImageReferenceControlInputSchema = z.object({
  ...commandEnvelopeFields,
  role: imageReferenceRoleV2Schema,
  influence_strength: imageReferenceInfluenceSchema,
  preservation: imageReferencePreservationSchema,
  priority: z.number().int().min(0).max(1_000),
  label: z.string().min(1).max(120).optional(),
}).strict()
export const estimateGenerationRoundInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  creative_plan_id: mediaIdSchema,
  direction_ids: z.array(mediaIdSchema).min(1).max(8).optional(),
}).strict()
export const createGenerationRoundInputSchema = z.object({
  ...commandEnvelopeFields,
  creative_plan_id: mediaIdSchema,
  direction_ids: z.array(mediaIdSchema).min(1).max(8),
  estimate_hash: imageHashSchema,
  confirm: z.literal(true),
}).strict()
export const decideImageCandidateInputSchema = z.object({
  ...commandEnvelopeFields,
  decision: z.enum(['kept', 'rejected']),
}).strict()
export const adoptImageCandidateInputSchema = z.object({
  ...commandEnvelopeFields,
  adoptions: z.array(z.object({ artboard_id: mediaIdSchema, placement: imageCandidatePlacementSchema }).strict()).min(1).max(32),
}).strict()
export const deriveImageCandidateInputSchema = z.object({
  ...commandEnvelopeFields,
  instruction: z.string().min(1).max(4_000),
}).strict()

export type ImageReferenceV2 = z.infer<typeof imageReferenceV2Schema>
export type ImageBriefSnapshot = z.infer<typeof imageBriefSnapshotSchema>
export type ImageDeliverySpec = z.infer<typeof imageDeliverySpecSchema>
export type ProviderExecutionReceipt = z.infer<typeof providerExecutionReceiptSchema>
export type ImageOperationV2 = z.infer<typeof imageOperationV2Schema>
export type ImageOperationResult = z.infer<typeof imageOperationResultSchema>
export type ImageCreativePlan = z.infer<typeof imageCreativePlanSchema>
export type ImageCreativeDirection = z.infer<typeof imageCreativeDirectionSchema>
export type ImageGenerationRound = z.infer<typeof imageGenerationRoundSchema>
export type ImageCandidate = z.infer<typeof imageCandidateSchema>
export type ImageCandidateGroup = z.infer<typeof imageCandidateGroupSchema>
export type ImageCandidateDecision = z.infer<typeof imageCandidateDecisionSchema>
export type ImageCandidateAdoption = z.infer<typeof imageCandidateAdoptionSchema>
export type PublicImageOperationV2 = z.infer<typeof publicImageOperationV2Schema>
export type PublicImageCandidate = z.infer<typeof publicImageCandidateSchema>
export type PublicImageCandidateGroup = z.infer<typeof publicImageCandidateGroupSchema>
export type CreateCreativePlanInput = z.input<typeof createCreativePlanInputSchema>
export type UpdateImageReferenceControlInput = z.input<typeof updateImageReferenceControlInputSchema>
export type EstimateGenerationRoundInput = z.input<typeof estimateGenerationRoundInputSchema>
export type CreateGenerationRoundInput = z.input<typeof createGenerationRoundInputSchema>
export type DecideImageCandidateInput = z.input<typeof decideImageCandidateInputSchema>
export type AdoptImageCandidateInput = z.input<typeof adoptImageCandidateInputSchema>
export type DeriveImageCandidateInput = z.input<typeof deriveImageCandidateInputSchema>

/** The only binary fact exposed to the 15.2 repository transaction. */
export const imageCandidateAssetSchema = mediaAssetSchema.extend({ role: z.literal('result') })
