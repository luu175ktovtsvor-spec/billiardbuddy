import { z } from 'zod/v4'
import {
  imageGenerationModelSchema,
  mediaAssetSchema,
  mediaIdSchema,
  mediaIsoDateSchema,
  mediaOwnerSchema,
  publicImageWorkbenchProjectSchema,
  saveImageOutputResultSchema,
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
  price_upper_bound: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/), amount_minor: z.number().int().nonnegative(),
    pricing_revision: z.string().min(1).max(120),
  }).strict().optional(),
  /** Durable local work descriptor.  It lets startup resume the exact Canvas
   * revision or frozen export map without asking a renderer to re-submit. */
  local_delivery: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('canvas_render'), canvas_id: mediaIdSchema, canvas_revision: z.number().int().nonnegative(), expected_current_version_id: mediaIdSchema.optional(), activate_on_success: z.boolean() }).strict(),
    z.object({ kind: z.literal('export'), version_ids_by_artboard: z.record(mediaIdSchema, mediaIdSchema) }).strict(),
  ]).optional(),
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

/** A short-lived, server-persisted price/occupancy quote for one paid command. */
export const imageGenerationEstimateSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  kind: z.enum(['generation_round', 'derivation']),
  creative_plan_id: mediaIdSchema.optional(),
  candidate_id: mediaIdSchema.optional(),
  direction_ids: z.array(mediaIdSchema).min(1).max(8),
  request_hash: imageHashSchema,
  estimate_hash: imageHashSchema,
  project_revision: z.number().int().nonnegative(),
  paid_operation_count: z.number().int().positive().max(8),
  candidate_count_per_operation: z.number().int().positive().max(4),
  concurrency: z.number().int().positive().max(8),
  /** A quote is expressed in the provider's declared minor unit; it is never a UI-only estimate. */
  price_upper_bound: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount_minor: z.number().int().nonnegative(),
    per_operation_amount_minor: z.number().int().nonnegative(),
    pricing_revision: z.string().min(1).max(120),
    usage_upper_bound: z.object({
      requests: z.number().int().positive().max(8),
      input_bytes: z.number().int().nonnegative(),
      output_images: z.number().int().positive().max(32),
    }).strict(),
  }).strict(),
  expires_at: mediaIsoDateSchema,
  created_at: mediaIsoDateSchema,
}).strict().superRefine((estimate, context) => {
  if (estimate.kind === 'generation_round' && !estimate.creative_plan_id) {
    context.addIssue({ code: 'custom', message: 'generation round estimate requires creative_plan_id' })
  }
  if (estimate.kind === 'derivation' && !estimate.candidate_id) {
    context.addIssue({ code: 'custom', message: 'derivation estimate requires candidate_id' })
  }
})

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
  local_delivery: true,
}).extend({
  safe_error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(500) }).strict().optional(),
})
export const publicImageCandidateSchema = imageCandidateSchema.extend({
  image_path: z.string().startsWith('/api/images/projects/'),
})
export const publicImageCandidateGroupSchema = imageCandidateGroupSchema.extend({
  candidates: z.array(publicImageCandidateSchema).max(4),
})

const imageEstimateResponseFields = {
  estimate_hash: imageHashSchema,
  paid_operation_count: z.number().int().positive().max(8),
  candidate_count_per_operation: z.number().int().positive().max(4),
  concurrency: z.number().int().positive().max(8),
  price_upper_bound: imageGenerationEstimateSchema.shape.price_upper_bound,
  expires_at: mediaIsoDateSchema,
}

/** Public API and desktop bridge response contracts for 15.2 paid commands. */
export const imageCreativePlanResponseSchema = z.object({
  plan: imageCreativePlanSchema,
}).strict()
export const imageGenerationRoundEstimateResponseSchema = z.object({
  ...imageEstimateResponseFields,
  direction_count: z.number().int().positive().max(8),
}).strict()
export const imageDerivationEstimateResponseSchema = z.object(imageEstimateResponseFields).strict()
export const imageGenerationRoundResponseSchema = z.object({
  round: imageGenerationRoundSchema,
  operations: z.array(publicImageOperationV2Schema).min(1).max(8),
}).strict()
export const imageCandidateDecisionResponseSchema = z.object({
  decision: imageCandidateDecisionSchema,
}).strict()
export const imageCandidateAdoptionResponseSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
  adoptions: z.array(imageCandidateAdoptionSchema).min(1).max(32),
}).strict()
export const imageCandidateDerivationResponseSchema = z.object({
  round: imageGenerationRoundSchema,
  operation: publicImageOperationV2Schema,
}).strict()
export const imageGenerationCancelResponseSchema = z.object({
  operation: publicImageOperationV2Schema,
}).strict()
export const imageReferenceControlResponseSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
}).strict()

/** 15.3 Canvas facts. Coordinates are artboard pixels with a top-left origin. */
/** A brand token is resolved by the locked Brand Kit revision at render time. */
export const imageCanvasColorSchema = z.string().regex(/^(?:#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?|brand\.[a-z][a-z0-9_]{0,63})$/)
export const imageCanvasTransformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive().max(12_000),
  height: z.number().finite().positive().max(12_000),
  rotation_degrees: z.number().finite().min(-360).max(360),
  scale_x: z.number().finite().positive().max(100),
  scale_y: z.number().finite().positive().max(100),
}).strict()
export const imageCanvasCropSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive().max(12_000),
  height: z.number().finite().positive().max(12_000),
}).strict()
export const imageCanvasBackgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('solid'), color: imageCanvasColorSchema }).strict(),
  z.object({ kind: z.literal('transparent') }).strict(),
])

type ImageCanvasLayerBase = { id: string }
export type ImageCanvasLayer = ImageCanvasLayerBase & (
  | {
      kind: 'raster'
      source_asset_id: string
      transform: { x: number; y: number; width: number; height: number; rotation_degrees: number; scale_x: number; scale_y: number }
      source_crop?: { x: number; y: number; width: number; height: number }
      opacity: number
      blend_mode: 'normal' | 'multiply' | 'screen'
      clip_to_artboard?: boolean
    }
  | {
      kind: 'text'
      requirement_id?: string
      text: string
      font_family: string
      font_asset_id: string
      font_size: number
      min_font_size?: number
      font_weight: number
      font_style: 'normal' | 'italic'
      line_height: number
      letter_spacing: number
      fill: string
      stroke?: string
      position: { x: number; y: number }
      rotation_degrees: number
      max_width?: number
      max_height?: number
      overflow: 'error' | 'shrink_to_fit' | 'clip'
      locale: string
      align: 'left' | 'center' | 'right'
      opacity: number
    }
  | {
      kind: 'logo'
      source_asset_id: string
      transform: { x: number; y: number; width: number; height: number; rotation_degrees: number; scale_x: number; scale_y: number }
      preserve_exact_source: true
      render_mode: 'vector_exact' | 'raster_exact'
    }
  | {
      kind: 'qrcode'
      source: { kind: 'asset'; asset_id: string } | { kind: 'payload'; value: string }
      transform: { x: number; y: number; width: number; height: number; rotation_degrees: number; scale_x: number; scale_y: number }
      error_correction: 'M' | 'Q' | 'H'
      quiet_zone_modules: number
      verify_after_render: true
    }
  | {
      kind: 'shape'
      shape: 'rectangle' | 'ellipse' | 'line'
      transform: { x: number; y: number; width: number; height: number; rotation_degrees: number; scale_x: number; scale_y: number }
      fill?: string
      stroke?: string
      stroke_width?: number
      opacity: number
    }
  | { kind: 'group'; children: ImageCanvasLayer[] }
  | { kind: 'mask'; source_asset_id: string; target_layer_id: string; mode: 'alpha' | 'luminance' }
)

const imageCanvasRasterLayerSchema = z.object({
  id: mediaIdSchema, kind: z.literal('raster'), source_asset_id: mediaIdSchema,
  transform: imageCanvasTransformSchema, source_crop: imageCanvasCropSchema.optional(),
  opacity: z.number().min(0).max(1), blend_mode: z.enum(['normal', 'multiply', 'screen']),
  clip_to_artboard: z.boolean().optional(),
}).strict()
const imageCanvasTextLayerSchema = z.object({
  id: mediaIdSchema, kind: z.literal('text'), requirement_id: mediaIdSchema.optional(), text: z.string().min(1).max(2_000),
  font_family: z.string().min(1).max(120), font_asset_id: mediaIdSchema, font_size: z.number().finite().positive().max(1_024),
  min_font_size: z.number().finite().positive().max(1_024).optional(), font_weight: z.number().int().min(100).max(900),
  font_style: z.enum(['normal', 'italic']), line_height: z.number().finite().positive().max(20), letter_spacing: z.number().finite().min(-200).max(200),
  fill: imageCanvasColorSchema, stroke: imageCanvasColorSchema.optional(), position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  rotation_degrees: z.number().finite().min(-360).max(360), max_width: z.number().finite().positive().max(12_000).optional(),
  max_height: z.number().finite().positive().max(12_000).optional(), overflow: z.enum(['error', 'shrink_to_fit', 'clip']),
  locale: z.string().min(2).max(35), align: z.enum(['left', 'center', 'right']), opacity: z.number().min(0).max(1),
}).strict().superRefine((layer, context) => {
  if (layer.overflow === 'shrink_to_fit' && !layer.min_font_size) {
    context.addIssue({ code: 'custom', message: 'shrink_to_fit requires min_font_size' })
  }
})
const imageCanvasLogoLayerSchema = z.object({
  id: mediaIdSchema, kind: z.literal('logo'), source_asset_id: mediaIdSchema, transform: imageCanvasTransformSchema,
  preserve_exact_source: z.literal(true), render_mode: z.enum(['vector_exact', 'raster_exact']),
}).strict()
const imageCanvasQrLayerSchema = z.object({
  id: mediaIdSchema, kind: z.literal('qrcode'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('asset'), asset_id: mediaIdSchema }).strict(),
    z.object({ kind: z.literal('payload'), value: z.string().min(1).max(2_048) }).strict(),
  ]),
  transform: imageCanvasTransformSchema, error_correction: z.enum(['M', 'Q', 'H']),
  quiet_zone_modules: z.number().int().min(1).max(16), verify_after_render: z.literal(true),
}).strict()
const imageCanvasShapeLayerSchema = z.object({
  id: mediaIdSchema, kind: z.literal('shape'), shape: z.enum(['rectangle', 'ellipse', 'line']), transform: imageCanvasTransformSchema,
  fill: imageCanvasColorSchema.optional(), stroke: imageCanvasColorSchema.optional(), stroke_width: z.number().finite().positive().max(1_024).optional(),
  opacity: z.number().min(0).max(1),
}).strict()
const imageCanvasMaskLayerSchema = z.object({
  id: mediaIdSchema, kind: z.literal('mask'), source_asset_id: mediaIdSchema, target_layer_id: mediaIdSchema, mode: z.enum(['alpha', 'luminance']),
}).strict()
export const imageCanvasLayerSchema: z.ZodType<ImageCanvasLayer> = z.lazy(() => z.discriminatedUnion('kind', [
  imageCanvasRasterLayerSchema,
  imageCanvasTextLayerSchema,
  imageCanvasLogoLayerSchema,
  imageCanvasQrLayerSchema,
  imageCanvasShapeLayerSchema,
  z.object({ id: mediaIdSchema, kind: z.literal('group'), children: z.array(imageCanvasLayerSchema).max(80) }).strict(),
  imageCanvasMaskLayerSchema,
]))

export const imageCanvasDocumentSchema = z.object({
  schema_version: z.literal(1), id: mediaIdSchema, project_id: mediaIdSchema, artboard_id: mediaIdSchema,
  delivery_spec_id: mediaIdSchema, delivery_spec_revision: z.number().int().nonnegative(),
  brand_kit_id: mediaIdSchema.optional(), brand_kit_revision_id: mediaIdSchema.optional(), template_id: mediaIdSchema.optional(), template_revision_id: mediaIdSchema.optional(),
  width: z.number().int().positive().max(12_000), height: z.number().int().positive().max(12_000), color_space: z.literal('srgb'),
  background: imageCanvasBackgroundSchema, layers: z.array(imageCanvasLayerSchema).max(80), created_at: mediaIsoDateSchema,
}).strict().superRefine((value, context) => {
  if (Boolean(value.brand_kit_id) !== Boolean(value.brand_kit_revision_id)) context.addIssue({ code: 'custom', message: 'canvas brand id and revision must be paired' })
  if (Boolean(value.template_id) !== Boolean(value.template_revision_id)) context.addIssue({ code: 'custom', message: 'canvas template id and revision must be paired' })
})
export const imageCanvasRevisionSchema = z.object({
  canvas_id: mediaIdSchema, revision: z.number().int().nonnegative(), document_hash: imageHashSchema,
  document: imageCanvasDocumentSchema, parent_revision: z.number().int().nonnegative().optional(), created_at: mediaIsoDateSchema,
}).strict()

const imageBrandColorTokensSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/))
const imageBrandRequiredTextSchema = z.object({ id: mediaIdSchema, value: z.string().min(1).max(2_000), purpose: z.enum(['legal', 'contact', 'slogan']) }).strict()
export const imageBrandKitRevisionSchema = z.object({
  id: mediaIdSchema, brand_kit_id: mediaIdSchema, revision: z.number().int().nonnegative(), owner: mediaOwnerSchema,
  logo_asset_ids: z.array(mediaIdSchema).max(32), font_asset_ids: z.array(mediaIdSchema).max(32), color_tokens: imageBrandColorTokensSchema,
  required_text: z.array(imageBrandRequiredTextSchema).max(80), created_at: mediaIsoDateSchema,
}).strict()
export const imageCanvasBlueprintSchema = z.object({
  schema_version: z.literal(1), artboard: z.object({ width: z.number().int().positive().max(12_000), height: z.number().int().positive().max(12_000) }).strict(),
  background: imageCanvasBackgroundSchema, layers: z.array(imageCanvasLayerSchema).max(80),
}).strict()
export const imageTemplateRevisionSchema = z.object({
  id: mediaIdSchema, template_id: mediaIdSchema, revision: z.number().int().nonnegative(), owner: mediaOwnerSchema,
  brand_kit_id: mediaIdSchema.optional(), brand_kit_revision_id: mediaIdSchema.optional(), blueprint: imageCanvasBlueprintSchema,
  slots: z.array(z.object({ id: z.string().min(1).max(120), layer_id: mediaIdSchema, kind: z.enum(['raster', 'text', 'logo', 'qrcode']), required: z.boolean() }).strict()).max(80),
  schema_version: z.literal(1), created_at: mediaIsoDateSchema,
}).strict().superRefine((value, context) => {
  if (Boolean(value.brand_kit_id) !== Boolean(value.brand_kit_revision_id)) context.addIssue({ code: 'custom', message: 'template brand id and revision must be paired' })
  const layers = new Map<string, ImageCanvasLayer>()
  const walk = (items: ImageCanvasLayer[]) => items.forEach(layer => { layers.set(layer.id, layer); if (layer.kind === 'group') walk(layer.children) })
  walk(value.blueprint.layers)
  const slots = new Set<string>()
  for (const slot of value.slots) {
    if (slots.has(slot.id)) context.addIssue({ code: 'custom', message: 'template slot id must be unique' })
    slots.add(slot.id)
    if (layers.get(slot.layer_id)?.kind !== slot.kind) context.addIssue({ code: 'custom', message: 'template slot kind must match its layer' })
  }
})

const imageCanvasCommandBaseSchema = z.object({
  idempotency_key: z.string().min(16).max(160), base_revision: z.number().int().nonnegative(),
}).strict()
export const imageCanvasCommandInputSchema = z.discriminatedUnion('kind', [
  imageCanvasCommandBaseSchema.extend({ kind: z.literal('add_layer'), payload: z.object({ parent_group_id: mediaIdSchema.optional(), layer: imageCanvasLayerSchema, index: z.number().int().nonnegative().optional() }).strict() }),
  imageCanvasCommandBaseSchema.extend({ kind: z.literal('replace_layer'), payload: z.object({ layer: imageCanvasLayerSchema }).strict() }),
  imageCanvasCommandBaseSchema.extend({ kind: z.literal('remove_layer'), payload: z.object({ layer_id: mediaIdSchema }).strict() }),
  imageCanvasCommandBaseSchema.extend({ kind: z.literal('reorder_layers'), payload: z.object({ parent_group_id: mediaIdSchema.optional(), ordered_layer_ids: z.array(mediaIdSchema).min(1).max(80) }).strict() }),
  imageCanvasCommandBaseSchema.extend({ kind: z.literal('apply_template'), payload: z.object({ template_id: mediaIdSchema, template_revision_id: mediaIdSchema, slot_bindings: z.array(z.object({ slot_id: z.string().min(1).max(120), asset_id: mediaIdSchema.optional(), text: z.string().min(1).max(2_000).optional(), qr_payload: z.string().min(1).max(2_048).optional() }).strict()).max(80) }).strict() }),
  imageCanvasCommandBaseSchema.extend({ kind: z.literal('apply_brand_kit'), payload: z.object({ brand_kit_id: mediaIdSchema, brand_kit_revision_id: mediaIdSchema }).strict() }),
  imageCanvasCommandBaseSchema.extend({ kind: z.literal('sync_delivery_spec'), payload: z.object({ delivery_spec_id: mediaIdSchema, delivery_spec_revision: z.number().int().nonnegative(), layout_policy: z.enum(['preserve_position', 'fit_safe_area']) }).strict() }),
])
export const imageCanvasCreateInputSchema = z.object({
  artboard_id: mediaIdSchema, base_revision: z.number().int().nonnegative(), idempotency_key: z.string().min(16).max(160),
  background: imageCanvasBackgroundSchema.optional(),
}).strict()
export const imageCanvasPreflightInputSchema = z.object({ revision: z.number().int().nonnegative() }).strict()
export const imageCanvasRenderInputSchema = z.object({
  base_revision: z.number().int().nonnegative(), idempotency_key: z.string().min(16).max(160), canvas_revision: z.number().int().nonnegative(),
  activate_on_success: z.boolean(), expected_current_version_id: mediaIdSchema.optional(),
}).strict()
export const imageCanvasCommandRequestInputSchema = z.object({
  base_project_revision: z.number().int().nonnegative(),
  command: imageCanvasCommandInputSchema,
}).strict()
export const imageDeliverySpecRevisionInputSchema = z.object({
  base_revision: z.number().int().nonnegative(), idempotency_key: z.string().min(16).max(160),
  purpose: z.enum(['social_cover', 'product_marketing', 'poster', 'custom']),
  artboards: imageDeliverySpecSchema.shape.artboards,
}).strict()
export const imageExportInputSchema = z.object({
  base_revision: z.number().int().nonnegative(), idempotency_key: z.string().min(16).max(160),
  version_ids_by_artboard: z.record(mediaIdSchema, mediaIdSchema),
}).strict()
export const imageArtboardSelectVersionInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  idempotency_key: z.string().min(16).max(160),
  version_id: mediaIdSchema,
}).strict()
export const imageSaveOutputInputSchema = z.object({
  version_id: mediaIdSchema.optional(),
  output_id: mediaIdSchema.optional(),
  destination_grant_id: mediaIdSchema,
}).strict().refine(value => Boolean(value.version_id || value.output_id), { message: 'version_id or output_id is required' })
export const imageDestinationGrantRequestSchema = z.object({ suggested_name: z.string().min(1).max(180).optional() }).strict()
export const imageDestinationGrantSchema = z.object({ destination_grant_id: mediaIdSchema, expires_at: mediaIsoDateSchema }).strict()

export const imageCanvasPreflightSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, canvas_id: mediaIdSchema, canvas_revision: z.number().int().nonnegative(),
  document_hash: imageHashSchema, passed: z.boolean(), checks: z.array(z.object({ id: z.string().min(1).max(120), status: z.enum(['pass', 'warn', 'fail']), evidence: z.string().min(1).max(500), waivable: z.boolean() }).strict()).max(120),
  created_at: mediaIsoDateSchema,
}).strict()
export const imageRenderReceiptSchema = z.object({
  id: mediaIdSchema, version_id: mediaIdSchema, canvas_id: mediaIdSchema, canvas_revision: z.number().int().nonnegative(), document_hash: imageHashSchema,
  delivery_spec_id: mediaIdSchema, delivery_spec_revision: z.number().int().nonnegative(), brand_kit_revision_id: mediaIdSchema.optional(), template_revision_id: mediaIdSchema.optional(),
  renderer_version: z.string().min(1).max(120), text_layout_engine_version: z.string().min(1).max(120), dependency_asset_hashes: z.array(imageHashSchema).max(80),
  font_asset_hashes: z.array(imageHashSchema).max(32), output_hash: imageHashSchema, text_manifest_hash: imageHashSchema, created_at: mediaIsoDateSchema,
}).strict()
export const imageReleaseCheckResultSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, version_id: mediaIdSchema, export_asset_id: mediaIdSchema,
  checks: z.array(z.object({ id: z.string().min(1).max(120), name: z.string().min(1).max(120), status: z.enum(['pass', 'warn', 'fail']), waivable: z.boolean(), evidence: z.string().min(1).max(500), evidence_hash: imageHashSchema }).strict()).max(120),
  accepted_warning_receipt_ids: z.array(mediaIdSchema).max(120), passed: z.boolean(), created_at: mediaIsoDateSchema,
}).strict()
export const imageExportReceiptSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, artboard_id: mediaIdSchema, version_id: mediaIdSchema, source_hash: imageHashSchema,
  output_asset_id: mediaIdSchema, output_format: z.enum(['png', 'jpeg', 'webp']), output_hash: imageHashSchema,
  width: z.number().int().positive().max(12_000), height: z.number().int().positive().max(12_000), byte_size: z.number().int().positive(),
  release_check_result_id: mediaIdSchema, created_at: mediaIsoDateSchema,
}).strict()
export const imageDeliverySetSchema = z.object({
  id: mediaIdSchema, project_id: mediaIdSchema, delivery_spec_id: mediaIdSchema, delivery_spec_revision: z.number().int().nonnegative(),
  version_ids_by_artboard: z.record(mediaIdSchema, mediaIdSchema), export_receipt_ids_by_artboard: z.record(mediaIdSchema, mediaIdSchema), created_at: mediaIsoDateSchema,
}).strict()
export const imageCanvasCommandResponseSchema = z.object({ canvas: imageCanvasRevisionSchema, project_revision: z.number().int().nonnegative() }).strict()
export const imageDeliverySpecRevisionResponseSchema = z.object({
  project: publicImageWorkbenchProjectSchema,
  delivery_spec: imageDeliverySpecSchema,
}).strict()
export const imageCanvasPreflightResponseSchema = z.object({ preflight: imageCanvasPreflightSchema }).strict()
export const imageCanvasRenderResponseSchema = z.object({
  operation: publicImageOperationV2Schema,
  version_id: mediaIdSchema.optional(), render_receipt: imageRenderReceiptSchema.optional(), release_check: imageReleaseCheckResultSchema.optional(),
}).strict()
export const imageExportResponseSchema = z.object({
  operation: publicImageOperationV2Schema,
  export_receipts: z.array(imageExportReceiptSchema).min(1).max(32).optional(), delivery_set: imageDeliverySetSchema.optional(), project_revision: z.number().int().nonnegative(),
}).strict()
export const imageArtboardSelectVersionResponseSchema = z.object({ project: publicImageWorkbenchProjectSchema }).strict()
export const imageSaveOutputResponseSchema = saveImageOutputResultSchema.extend({ destination_grant_id: mediaIdSchema }).strict()

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
  estimate_hash: imageHashSchema,
  confirm: z.literal(true),
}).strict()
export const estimateDeriveImageCandidateInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
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
export type ImageGenerationEstimate = z.infer<typeof imageGenerationEstimateSchema>
export type ImageCandidate = z.infer<typeof imageCandidateSchema>
export type ImageCandidateGroup = z.infer<typeof imageCandidateGroupSchema>
export type ImageCandidateDecision = z.infer<typeof imageCandidateDecisionSchema>
export type ImageCandidateAdoption = z.infer<typeof imageCandidateAdoptionSchema>
export type PublicImageOperationV2 = z.infer<typeof publicImageOperationV2Schema>
export type PublicImageCandidate = z.infer<typeof publicImageCandidateSchema>
export type PublicImageCandidateGroup = z.infer<typeof publicImageCandidateGroupSchema>
export type ImageCreativePlanResponse = z.infer<typeof imageCreativePlanResponseSchema>
export type ImageGenerationRoundEstimateResponse = z.infer<typeof imageGenerationRoundEstimateResponseSchema>
export type ImageDerivationEstimateResponse = z.infer<typeof imageDerivationEstimateResponseSchema>
export type ImageGenerationRoundResponse = z.infer<typeof imageGenerationRoundResponseSchema>
export type ImageCandidateDecisionResponse = z.infer<typeof imageCandidateDecisionResponseSchema>
export type ImageCandidateAdoptionResponse = z.infer<typeof imageCandidateAdoptionResponseSchema>
export type ImageCandidateDerivationResponse = z.infer<typeof imageCandidateDerivationResponseSchema>
export type ImageGenerationCancelResponse = z.infer<typeof imageGenerationCancelResponseSchema>
export type ImageReferenceControlResponse = z.infer<typeof imageReferenceControlResponseSchema>
export type ImageCanvasDocument = z.infer<typeof imageCanvasDocumentSchema>
export type ImageCanvasRevision = z.infer<typeof imageCanvasRevisionSchema>
export type ImageBrandKitRevision = z.infer<typeof imageBrandKitRevisionSchema>
export type ImageTemplateRevision = z.infer<typeof imageTemplateRevisionSchema>
export type ImageCanvasCommandInput = z.input<typeof imageCanvasCommandInputSchema>
export type ImageCanvasCommandRequestInput = z.input<typeof imageCanvasCommandRequestInputSchema>
export type ImageCanvasCreateInput = z.input<typeof imageCanvasCreateInputSchema>
export type ImageCanvasPreflightInput = z.input<typeof imageCanvasPreflightInputSchema>
export type ImageCanvasRenderInput = z.input<typeof imageCanvasRenderInputSchema>
export type ImageDeliverySpecRevisionInput = z.input<typeof imageDeliverySpecRevisionInputSchema>
export type ImageExportInput = z.input<typeof imageExportInputSchema>
export type ImageArtboardSelectVersionInput = z.input<typeof imageArtboardSelectVersionInputSchema>
export type ImageSaveOutputInput = z.input<typeof imageSaveOutputInputSchema>
export type ImageDestinationGrantRequest = z.input<typeof imageDestinationGrantRequestSchema>
export type ImageDestinationGrant = z.infer<typeof imageDestinationGrantSchema>
export type ImageCanvasPreflight = z.infer<typeof imageCanvasPreflightSchema>
export type ImageRenderReceipt = z.infer<typeof imageRenderReceiptSchema>
export type ImageReleaseCheckResult = z.infer<typeof imageReleaseCheckResultSchema>
export type ImageExportReceipt = z.infer<typeof imageExportReceiptSchema>
export type ImageDeliverySet = z.infer<typeof imageDeliverySetSchema>
export type ImageCanvasCommandResponse = z.infer<typeof imageCanvasCommandResponseSchema>
export type ImageDeliverySpecRevisionResponse = z.infer<typeof imageDeliverySpecRevisionResponseSchema>
export type ImageCanvasPreflightResponse = z.infer<typeof imageCanvasPreflightResponseSchema>
export type ImageCanvasRenderResponse = z.infer<typeof imageCanvasRenderResponseSchema>
export type ImageExportResponse = z.infer<typeof imageExportResponseSchema>
export type ImageArtboardSelectVersionResponse = z.infer<typeof imageArtboardSelectVersionResponseSchema>
export type ImageSaveOutputResponse = z.infer<typeof imageSaveOutputResponseSchema>
export type CreateCreativePlanInput = z.input<typeof createCreativePlanInputSchema>
export type UpdateImageReferenceControlInput = z.input<typeof updateImageReferenceControlInputSchema>
export type EstimateGenerationRoundInput = z.input<typeof estimateGenerationRoundInputSchema>
export type CreateGenerationRoundInput = z.input<typeof createGenerationRoundInputSchema>
export type DecideImageCandidateInput = z.input<typeof decideImageCandidateInputSchema>
export type AdoptImageCandidateInput = z.input<typeof adoptImageCandidateInputSchema>
export type DeriveImageCandidateInput = z.input<typeof deriveImageCandidateInputSchema>
export type EstimateDeriveImageCandidateInput = z.input<typeof estimateDeriveImageCandidateInputSchema>

/** The only binary fact exposed to the 15.2 repository transaction. */
export const imageCandidateAssetSchema = mediaAssetSchema.extend({ role: z.literal('result') })
