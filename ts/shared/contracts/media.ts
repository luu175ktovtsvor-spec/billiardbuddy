import { z } from 'zod/v4'
import { MEDIA_SAFE_ERROR_CODES } from './mediaErrors.js'

export { MEDIA_SAFE_ERROR_CODES, MEDIA_SAFE_ERROR_MESSAGES, isMediaSafeErrorCode, isMediaSafeErrorMessage, mediaSafeError, mediaSafeErrorForServiceError } from './mediaErrors.js'
export type { MediaSafeError, MediaSafeErrorCode } from './mediaErrors.js'

export const MEDIA_UI_CAPABILITY_HEADER = 'X-BilliardBuddy-Media-Capability'
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_REFERENCE_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_IMAGE_DATA_URL_CHARS = Math.ceil(MAX_REFERENCE_IMAGE_BYTES * 4 / 3) + 128
const referenceImageDataUrlSchema = z.string()
  .max(MAX_REFERENCE_IMAGE_DATA_URL_CHARS)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)

export const referenceImageAssetNameSchema = z.string()
  .regex(/^ref_[a-z0-9]{32}\.(?:png|jpg|webp)$/)

function approximateDataUrlBytes(value: string): number {
  const payload = value.slice(value.indexOf(',') + 1)
  return Math.floor(payload.length * 3 / 4)
}

export const mediaIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{7,79}$/)
export const mediaIsoDateSchema = z.string().datetime()
/**
 * A product task reference is intentionally distinct from an Agent Core
 * session id. It accepts both the current UUID form and the one-time legacy
 * import form used by the product task registry.
 */
export const productTaskOwnerIdSchema = z.string().regex(
  /^task_(?:[a-f0-9]{16}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/,
)
export const STANDALONE_MEDIA_OWNER_ID = 'local_workbench'
export const mediaOwnerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('standalone'),
    owner_id: z.literal(STANDALONE_MEDIA_OWNER_ID),
  }),
  z.object({
    kind: z.literal('product_task'),
    owner_id: productTaskOwnerIdSchema,
  }),
])
export const mediaAssetSchema = z.object({
  id: mediaIdSchema,
  role: z.enum(['reference', 'mask', 'source', 'result', 'export']),
  version_id: mediaIdSchema,
  storage: z.object({
    kind: z.enum(['cas', 'managed', 'external', 'remote']),
    locator: z.string().min(1).max(4096),
  }),
  mime_type: z.string().min(1).max(160).optional(),
  byte_size: z.number().int().nonnegative().optional(),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  created_at: mediaIsoDateSchema,
})
export const imageVersionKindSchema = z.enum([
  'generated',
  'edit',
  'inpaint',
  'upscale',
  'text_layout',
])
export const imageTextLayerSchema = z.object({
  id: mediaIdSchema,
  text: z.string().min(1).max(2000),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  max_width: z.number().finite().positive().max(12000).optional(),
  fill: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#ffffff'),
  font_family: z.string().min(1).max(120).default('PingFang SC'),
  font_size: z.number().finite().min(12).max(512).default(64),
  font_weight: z.enum(['normal', 'bold']).default('bold'),
  text_align: z.enum(['left', 'center', 'right']).default('left'),
})
export const mediaVersionSchema = z.object({
  id: mediaIdSchema,
  parent_version_id: mediaIdSchema.optional(),
  project_revision: z.number().int().nonnegative(),
  asset_ids: z.array(mediaIdSchema).max(1000),
  /** Image-only metadata; generic media versions remain valid without it. */
  kind: imageVersionKindSchema.optional(),
  operation_id: mediaIdSchema.optional(),
  width: z.number().int().positive().max(12000).optional(),
  height: z.number().int().positive().max(12000).optional(),
  text_layers: z.array(imageTextLayerSchema).max(80).optional(),
  created_at: mediaIsoDateSchema,
})
export const mediaDeletionReceiptSchema = z.object({
  schema_version: z.literal(1).default(1),
  deletion_id: mediaIdSchema,
  project_id: mediaIdSchema,
  owner: mediaOwnerSchema,
  status: z.enum(['pending', 'deleted', 'restoring', 'restored', 'purged']),
  deleted_at: mediaIsoDateSchema,
  purge_after: mediaIsoDateSchema,
  restored_at: mediaIsoDateSchema.optional(),
  purged_at: mediaIsoDateSchema.optional(),
  task_ids: z.array(mediaIdSchema).max(1000),
  managed_asset_count: z.number().int().nonnegative(),
  managed_asset_bytes: z.number().int().nonnegative(),
  trash_key: mediaIdSchema,
})
export const publicMediaDeletionReceiptSchema = mediaDeletionReceiptSchema.omit({
  schema_version: true,
  owner: true,
  trash_key: true,
})
export const mediaTaskStatusSchema = z.enum([
  'queued',
  'running',
  'committing',
  'succeeded',
  'failed',
  'cancelled',
])
export const mediaSafeErrorCodeSchema = z.enum(MEDIA_SAFE_ERROR_CODES)

export const IMAGE_GENERATION_MODELS = [
  'gpt-image-2',
  'doubao-seedream-4-5-251128',
] as const
export const imageGenerationModelSchema = z.enum(IMAGE_GENERATION_MODELS)
export const IMAGE_DATA_EGRESS_POLICY_REVISION = 'bb-04e-image-v1'

export const imageDataEgressAcknowledgementSchema = z.object({
  policy_revision: z.literal(IMAGE_DATA_EGRESS_POLICY_REVISION),
  acknowledged: z.literal(true),
  acknowledged_at: mediaIsoDateSchema,
})

export const imageDataEgressConsentReceiptSchema = z.object({
  receipt_id: z.string().regex(/^[a-f0-9]{64}$/),
  policy_revision: z.literal(IMAGE_DATA_EGRESS_POLICY_REVISION),
  purpose: z.literal('image_generation'),
  capability: z.literal('ImageGeneration'),
  receiver: z.enum(['OpenAI', 'ByteDance Ark']),
  relay_region: z.literal('United States'),
  retention: z.literal('input-until-terminal;result-up-to-7-days'),
  billable: z.literal(true),
  granted_at: mediaIsoDateSchema,
  revocable_until: z.literal('provider_submission'),
})

export const GPT_IMAGE_CANVAS_SIZES = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840',
] as const
export const SEEDREAM_IMAGE_CANVAS_SIZES = [
  '2048x2048',
  '2304x1728',
  '1728x2304',
  '2848x1600',
  '1600x2848',
  '2496x1664',
  '1664x2496',
  '3136x1344',
  '4096x4096',
  '4704x3520',
  '3520x4704',
  '5504x3040',
  '3040x5504',
  '4992x3328',
  '3328x4992',
  '6240x2656',
  // Kept for projects created by the earlier Seedream picker. These sizes also
  // satisfy Seedream 4.5's documented pixel-count and aspect-ratio constraints.
  '2352x1568',
  '1568x2352',
  '1680x2240',
  '2240x1680',
  '1536x2736',
  '2736x1536',
  '1216x3040',
  '3040x1216',
] as const
export const IMAGE_CANVAS_SIZES = [
  ...GPT_IMAGE_CANVAS_SIZES,
  ...SEEDREAM_IMAGE_CANVAS_SIZES,
] as const
export const imageCanvasSizeSchema = z.enum(IMAGE_CANVAS_SIZES)

export type ImageGenerationModel = z.infer<typeof imageGenerationModelSchema>
export type ImageCanvasSize = z.infer<typeof imageCanvasSizeSchema>

export function imageSizeSupportedByModel(
  model: ImageGenerationModel,
  size: ImageCanvasSize,
): boolean {
  return model === 'gpt-image-2'
    ? (GPT_IMAGE_CANVAS_SIZES as readonly string[]).includes(size)
    : (SEEDREAM_IMAGE_CANVAS_SIZES as readonly string[]).includes(size)
}

const mediaProjectBaseSchema = z.object({
  schema_version: z.literal(1),
  id: mediaIdSchema,
  title: z.string().min(1).max(160),
  workspace_root: z.string().min(1).max(4096).optional(),
  /** Optional so standalone and legacy media projects remain valid. */
  product_task_id: productTaskOwnerIdSchema.optional(),
  /** Canonical owner. product_task_id remains a read-compatible projection. */
  owner: mediaOwnerSchema.default({
    kind: 'standalone',
    owner_id: STANDALONE_MEDIA_OWNER_ID,
  }),
  /** Compare-and-swap token changed after every durable project write. */
  writer_fence: z.string().regex(/^fence_[a-f0-9]{32}$/).default(`fence_${'0'.repeat(32)}`),
  /** Immutable records discovered from legacy outputs/sources during migration. */
  assets: z.array(mediaAssetSchema).max(1000).default([]),
  versions: z.array(mediaVersionSchema).max(1000).default([]),
  revision: z.number().int().nonnegative(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
})

export const imageWorkbenchOutputSchema = z.object({
  id: mediaIdSchema,
  /** All candidates from one paid request share this stable operation id. */
  operation_id: mediaIdSchema.optional(),
  /** Each candidate is an independent immutable branch in the project history. */
  version_id: mediaIdSchema.optional(),
  version_kind: imageVersionKindSchema.optional(),
  parent_version_id: mediaIdSchema.optional(),
  width: z.number().int().positive().max(12000).optional(),
  height: z.number().int().positive().max(12000).optional(),
  text_layers: z.array(imageTextLayerSchema).max(80).optional(),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  data_url: z.string().startsWith('data:image/').optional(),
  asset_path: z.string().startsWith('/api/media/assets/').optional(),
  url: z.string().url().optional(),
  revised_prompt: z.string().max(8000).optional(),
}).refine(value => Boolean(value.data_url || value.asset_path || value.url), {
  message: 'an image output needs data_url, asset_path or url',
})

export const publicImageVersionSchema = z.object({
  id: mediaIdSchema,
  parent_version_id: mediaIdSchema.optional(),
  kind: imageVersionKindSchema,
  operation_id: mediaIdSchema.optional(),
  asset_id: mediaIdSchema,
  image_path: z.string().min(1).max(4096),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive().max(12000).optional(),
  height: z.number().int().positive().max(12000).optional(),
  text_layers: z.array(imageTextLayerSchema).max(80).default([]),
  created_at: mediaIsoDateSchema,
})

export const imageReferenceRoleSchema = z.enum([
  'unclassified',
  'subject',
  'style',
  'environment',
  'brand',
  'logo',
  'qrcode',
])

export const imageProjectReferenceSchema = z.object({
  asset_id: mediaIdSchema,
  role: imageReferenceRoleSchema,
  label: z.string().min(1).max(120).optional(),
})

export const imageCreativeBriefSchema = z.object({
  schema_version: z.literal(1),
  user_request: z.string().min(1).max(8000),
  confirmed_facts: z.array(z.string().min(1).max(500)).max(40).default([]),
  must_preserve: z.array(z.string().min(1).max(500)).max(40).default([]),
  may_change: z.array(z.string().min(1).max(500)).max(40).default([]),
  missing_information: z.array(z.string().min(1).max(500)).max(20).default([]),
  exact_text: z.array(z.string().min(1).max(500)).max(40).default([]),
  compiler_version: z.literal('image-brief-v1'),
})

export const imageWorkbenchProjectSchema = mediaProjectBaseSchema.extend({
  kind: z.literal('image'),
  state: z.enum(['draft', 'queued', 'generating', 'ready', 'failed']),
  mode: z.enum(['generate', 'edit']).default('generate'),
  model: imageGenerationModelSchema.default('gpt-image-2'),
  prompt: z.string().min(1).max(8000),
  size: imageCanvasSizeSchema.default('1024x1024'),
  count: z.number().int().min(1).max(4).default(1),
  /** New provider-neutral projects always request one three-candidate operation. */
  candidate_count: z.literal(3).default(3),
  /** Selecting or rolling back changes only this pointer; Version history is immutable. */
  current_version_id: mediaIdSchema.optional(),
  brief: imageCreativeBriefSchema.optional(),
  references: z.array(imageProjectReferenceSchema).max(8).default([]),
  reference_images: z.array(referenceImageDataUrlSchema).max(8).default([]),
  reference_image_assets: z.array(referenceImageAssetNameSchema).max(8).optional(),
  reference_image_count: z.number().int().min(0).max(8).default(0),
  task_id: mediaIdSchema.optional(),
  outputs: z.array(imageWorkbenchOutputSchema).max(16).default([]),
  notice: z.string().max(2000).optional(),
  error: z.string().max(2000).optional(),
  error_code: mediaSafeErrorCodeSchema.optional(),
})

export const videoSourceSchema = z.object({
  id: mediaIdSchema,
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(500),
  duration_ms: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  fps: z.number().nonnegative().max(240).optional(),
  has_audio: z.boolean(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  rotation: z.number().int().min(-360).max(360).default(0),
  video_stream_count: z.number().int().nonnegative().default(1),
  audio_stream_count: z.number().int().nonnegative().default(0),
  missing: z.boolean().default(false),
})

export const publicVideoSourceSchema = videoSourceSchema.omit({ path: true })

export const videoClipSchema = z.object({
  id: mediaIdSchema,
  source_id: mediaIdSchema,
  in_ms: z.number().int().nonnegative(),
  out_ms: z.number().int().positive(),
}).refine(value => value.out_ms > value.in_ms, {
  message: 'out_ms must be greater than in_ms',
})

export const videoOutputSettingsSchema = z.object({
  width: z.number().int().min(320).max(3840).default(1080),
  height: z.number().int().min(320).max(3840).default(1920),
  fps: z.number().int().min(12).max(60).default(30),
})

export const videoEvidenceSchema = z.object({
  id: mediaIdSchema,
  kind: z.enum(['source_role', 'transcript', 'visual', 'audio', 'shot']),
  source_id: mediaIdSchema,
  source_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  in_ms: z.number().int().nonnegative(),
  out_ms: z.number().int().positive(),
  text: z.string().min(1).max(8000),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string().min(1).max(500)).max(20).default([]),
  created_at: mediaIsoDateSchema,
}).refine(value => value.out_ms > value.in_ms, {
  message: 'evidence out_ms must be greater than in_ms',
})

export const videoBriefSchema = z.object({
  schema_version: z.literal(1),
  user_goal: z.string().min(1).max(8000),
  content_type: z.string().min(1).max(160),
  output_channel: z.string().min(1).max(160),
  must_preserve_text: z.array(z.string().min(1).max(500)).max(40).default([]),
  recommended_direction: z.string().min(1).max(2000),
  rationale: z.array(z.string().min(1).max(500)).max(20),
  gaps: z.array(z.string().min(1).max(500)).max(20).default([]),
  compiler_version: z.literal('video-brief-v1'),
})

export const videoSceneSchema = z.object({
  id: mediaIdSchema,
  source_id: mediaIdSchema,
  in_ms: z.number().int().nonnegative(),
  out_ms: z.number().int().positive(),
  story_role: z.enum(['hook', 'context', 'action', 'result', 'cta', 'b_roll']),
  evidence_ids: z.array(mediaIdSchema).max(100),
  rationale: z.string().min(1).max(1000),
  needs_review: z.boolean().default(false),
  locked: z.boolean().default(false),
}).refine(value => value.out_ms > value.in_ms, {
  message: 'scene out_ms must be greater than in_ms',
})

export const videoAlternativeSchema = z.object({
  id: mediaIdSchema,
  base_timeline_version_id: mediaIdSchema,
  label: z.string().min(1).max(160),
  tradeoff: z.string().min(1).max(1000),
  scenes: z.array(videoSceneSchema).min(1).max(500),
})

export const videoTimelineVersionSchema = z.object({
  id: mediaIdSchema,
  parent_version_id: mediaIdSchema.optional(),
  project_revision: z.number().int().nonnegative(),
  evidence_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  scenes: z.array(videoSceneSchema).max(500),
  created_at: mediaIsoDateSchema,
})

export const videoStudioProjectSchema = mediaProjectBaseSchema.extend({
  kind: z.literal('video'),
  state: z.enum(['draft', 'ready', 'rendering', 'complete', 'failed']),
  sources: z.array(videoSourceSchema).max(200).default([]),
  timeline: z.array(videoClipSchema).max(500).default([]),
  output: videoOutputSettingsSchema.default({ width: 1080, height: 1920, fps: 30 }),
  evidence: z.array(videoEvidenceSchema).max(5000).default([]),
  evidence_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  brief: videoBriefSchema.optional(),
  timeline_versions: z.array(videoTimelineVersionSchema).max(1000).default([]),
  current_timeline_version_id: mediaIdSchema.optional(),
  alternatives: z.array(videoAlternativeSchema).max(3).default([]),
  task_id: mediaIdSchema.optional(),
  output_path: z.string().min(1).max(4096).optional(),
  output_asset_id: mediaIdSchema.optional(),
  output_content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  error: z.string().max(2000).optional(),
  error_code: mediaSafeErrorCodeSchema.optional(),
})

export const mediaProjectSchema = z.discriminatedUnion('kind', [
  imageWorkbenchProjectSchema,
  videoStudioProjectSchema,
])

const persistedMediaProjectFields = {
  product_task_id: true,
  owner: true,
  writer_fence: true,
  assets: true,
  versions: true,
} as const
export const publicImageWorkbenchProjectSchema = imageWorkbenchProjectSchema.omit({
  ...persistedMediaProjectFields,
  /** Provider routing and the compiled provider prompt stay server-owned. */
  model: true,
  prompt: true,
  count: true,
  /** Legacy result projection remains persisted for migration but is not a UI authority. */
  outputs: true,
}).extend({
  version_history: z.array(publicImageVersionSchema).max(1000).default([]),
})
export const publicVideoStudioProjectSchema = videoStudioProjectSchema.omit(persistedMediaProjectFields).extend({
  sources: z.array(publicVideoSourceSchema).max(200),
})
export const publicMediaProjectSchema = z.discriminatedUnion('kind', [
  publicImageWorkbenchProjectSchema,
  publicVideoStudioProjectSchema,
])

export const mediaTaskSchema = z.object({
  schema_version: z.literal(1),
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  /** One logical operation can be recovered while this id remains the job id. */
  operation_id: mediaIdSchema.optional(),
  owner: mediaOwnerSchema.optional(),
  attempt: z.number().int().positive().default(1),
  kind: z.enum(['image.generate', 'video.probe', 'video.analyze', 'video.plan', 'video.render']),
  status: mediaTaskStatusSchema,
  progress: z.number().min(0).max(100),
  stage: z.string().max(160),
  remote_task_id: z.string().min(1).max(256).optional(),
  /** Server-provided status polling backoff for asynchronous image work. */
  poll_after_seconds: z.number().int().min(1).max(3600).optional(),
  idempotency_key: z.string().min(16).max(160).optional(),
  outcome_unknown: z.boolean().optional(),
  data_egress_consent: imageDataEgressConsentReceiptSchema.optional(),
  provider_receipt_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Relay result blob was deleted only after the local Version/Asset commit succeeded. */
  remote_result_acknowledged_at: mediaIsoDateSchema.optional(),
  image_operation: z.object({
    kind: z.enum(['generate', 'edit', 'inpaint']),
    base_version_id: mediaIdSchema.optional(),
    instruction: z.string().min(1).max(4000).optional(),
    mask_asset_id: mediaIdSchema.optional(),
    model: imageGenerationModelSchema,
    output_count: z.number().int().min(1).max(3),
  }).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(2000).optional(),
  error_code: mediaSafeErrorCodeSchema.optional(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
})
export const publicMediaTaskSchema = mediaTaskSchema.omit({
  owner: true,
  attempt: true,
  image_operation: true,
  remote_result_acknowledged_at: true,
})

export const imageGenerationTaskResultSchema = z.object({
  output_count: z.number().int().nonnegative(),
  outputs: z.array(imageWorkbenchOutputSchema).max(16).default([]),
  input_fidelity_requested: z.string().optional(),
  input_fidelity_status: z.enum(['accepted', 'unsupported']).optional(),
  input_fidelity_risk: z.string().max(2000).optional(),
})

export const videoRenderTaskResultSchema = z.object({
  render_revision: z.number().int().nonnegative(),
  timeline_version_id: mediaIdSchema.optional(),
  output_path: z.string().min(1).max(4096),
  output_asset_id: mediaIdSchema.optional(),
  output_content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  temporary_output: z.string().min(1).max(4096).optional(),
  video_encoder: z.enum(['h264_videotoolbox', 'h264_mf', 'mpeg4']).optional(),
})

export const createImageProjectInputSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  user_request: z.string().min(1).max(8000).optional(),
  /** One-release compatibility for Core callers created before the Brief contract. */
  prompt: z.string().min(1).max(8000).optional(),
  workspace_root: z.string().min(1).max(4096).optional(),
  size: imageCanvasSizeSchema.default('1024x1024'),
  reference_images: z.array(referenceImageDataUrlSchema).max(8).default([]),
  reference_roles: z.array(imageReferenceRoleSchema).max(8).default([]),
}).superRefine((value, context) => {
  if (!value.user_request?.trim() && !value.prompt?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['user_request'],
      message: 'user_request is required',
    })
  }
  if (value.reference_images.length > 0 && value.reference_roles.length !== value.reference_images.length) {
    context.addIssue({ code: 'custom', path: ['reference_roles'], message: 'every reference image needs one explicit role' })
  }
  if (value.reference_roles.includes('unclassified')) {
    context.addIssue({ code: 'custom', path: ['reference_roles'], message: 'reference image roles must be confirmed' })
  }
  const totalBytes = value.reference_images.reduce(
    (total, image) => total + approximateDataUrlBytes(image),
    0,
  )
  if (totalBytes > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['reference_images'],
      message: 'reference images exceed the total size limit',
    })
  }
}).transform(value => ({
  ...value,
  user_request: (value.user_request ?? value.prompt)!,
}))

export const createVideoProjectInputSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  workspace_root: z.string().min(1).max(4096).optional(),
  output: videoOutputSettingsSchema.optional(),
})

export const updateImageProjectInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  user_request: z.string().min(1).max(8000),
  size: imageCanvasSizeSchema,
  confirm_unknown_retry: z.boolean().default(false),
})

export const submitImageProjectInputSchema = z.object({
  confirm_unknown_retry: z.boolean().default(false),
  data_egress_consent: imageDataEgressAcknowledgementSchema.optional(),
})

const imagePngDataUrlSchema = z.string()
  .max(Math.ceil(32 * 1024 * 1024 * 4 / 3) + 128)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)

export const startImageOperationInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  base_version_id: mediaIdSchema,
  kind: z.enum(['edit', 'inpaint']),
  instruction: z.string().min(1).max(4000),
  mask_data_url: imagePngDataUrlSchema.optional(),
  confirm_unknown_retry: z.boolean().default(false),
  data_egress_consent: imageDataEgressAcknowledgementSchema.optional(),
}).superRefine((value, context) => {
  if (value.kind === 'inpaint' && !value.mask_data_url) {
    context.addIssue({ code: 'custom', path: ['mask_data_url'], message: 'inpaint requires a PNG mask' })
  }
  if (value.kind === 'edit' && value.mask_data_url) {
    context.addIssue({ code: 'custom', path: ['mask_data_url'], message: 'edit does not accept a mask' })
  }
})

export const commitImageVersionInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  base_version_id: mediaIdSchema,
  kind: z.enum(['upscale', 'text_layout']),
  rendered_image: imagePngDataUrlSchema,
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  scale: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  text_layers: z.array(imageTextLayerSchema).max(80).default([]),
}).superRefine((value, context) => {
  if (value.kind === 'upscale' && !value.scale) {
    context.addIssue({ code: 'custom', path: ['scale'], message: 'upscale requires a scale' })
  }
  if (value.kind === 'text_layout' && value.scale) {
    context.addIssue({ code: 'custom', path: ['scale'], message: 'text layout does not accept a scale' })
  }
})

export const selectImageVersionInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  version_id: mediaIdSchema,
})

export const addVideoSourceInputSchema = z.object({
  path: z.string().min(1).max(4096),
})

export const updateVideoTimelineInputSchema = z.object({
  base_revision: z.number().int().nonnegative().optional(),
  /** One-release compatibility for pre-Version callers; new UI always sends base_revision. */
  revision: z.number().int().nonnegative().optional(),
  base_timeline_version_id: mediaIdSchema.optional(),
  clips: z.array(videoClipSchema).max(500),
}).refine(value => value.base_revision !== undefined || value.revision !== undefined, {
  message: 'base_revision is required',
}).transform(value => ({ ...value, base_revision: value.base_revision ?? value.revision! }))

export const analyzeVideoProjectInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  user_goal: z.string().trim().min(1).max(8000),
})

export const lockVideoSceneInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  timeline_version_id: mediaIdSchema,
  locked: z.boolean(),
})

export const applyVideoAlternativeInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  alternative_id: mediaIdSchema,
})

export const renderVideoInputSchema = z.object({
  base_revision: z.number().int().nonnegative().optional(),
  /** One-release compatibility for pre-Version callers; new UI always sends base_revision. */
  revision: z.number().int().nonnegative().optional(),
  timeline_version_id: mediaIdSchema.optional(),
  output_path: z.string().min(1).max(4096),
}).refine(value => value.base_revision !== undefined || value.revision !== undefined, {
  message: 'base_revision is required',
}).transform(value => ({ ...value, base_revision: value.base_revision ?? value.revision! }))

export const saveImageOutputInputSchema = z.object({
  version_id: mediaIdSchema.optional(),
  /** One-release compatibility for callers that still address legacy outputs. */
  output_id: mediaIdSchema.optional(),
  output_path: z.string().min(1).max(4096),
}).refine(value => Boolean(value.version_id || value.output_id), {
  message: 'version_id is required',
})

export type MediaProject = z.infer<typeof mediaProjectSchema>
export type ImageWorkbenchProject = z.infer<typeof imageWorkbenchProjectSchema>
export type VideoStudioProject = z.infer<typeof videoStudioProjectSchema>
export type MediaTask = z.infer<typeof mediaTaskSchema>
export type PublicMediaProject = z.infer<typeof publicMediaProjectSchema>
export type PublicImageWorkbenchProject = z.infer<typeof publicImageWorkbenchProjectSchema>
export type PublicVideoStudioProject = z.infer<typeof publicVideoStudioProjectSchema>
export type PublicMediaTask = z.infer<typeof publicMediaTaskSchema>
export type MediaOwner = z.infer<typeof mediaOwnerSchema>
export type MediaAsset = z.infer<typeof mediaAssetSchema>
export type MediaVersion = z.infer<typeof mediaVersionSchema>
export type PublicImageVersion = z.infer<typeof publicImageVersionSchema>
export type ImageVersionKind = z.infer<typeof imageVersionKindSchema>
export type ImageTextLayer = z.infer<typeof imageTextLayerSchema>
export type ImageCreativeBrief = z.infer<typeof imageCreativeBriefSchema>
export type ImageReferenceRole = z.infer<typeof imageReferenceRoleSchema>
export type ImageProjectReference = z.infer<typeof imageProjectReferenceSchema>
export type MediaDeletionReceipt = z.infer<typeof mediaDeletionReceiptSchema>
export type PublicMediaDeletionReceipt = z.infer<typeof publicMediaDeletionReceiptSchema>
export type VideoSource = z.infer<typeof videoSourceSchema>
export type VideoClip = z.infer<typeof videoClipSchema>
export type VideoEvidence = z.infer<typeof videoEvidenceSchema>
export type VideoBrief = z.infer<typeof videoBriefSchema>
export type VideoScene = z.infer<typeof videoSceneSchema>
export type VideoAlternative = z.infer<typeof videoAlternativeSchema>
export type VideoTimelineVersion = z.infer<typeof videoTimelineVersionSchema>
export type CreateImageProjectInput = z.input<typeof createImageProjectInputSchema>
export type CreateVideoProjectInput = z.input<typeof createVideoProjectInputSchema>
export type UpdateImageProjectInput = z.input<typeof updateImageProjectInputSchema>
export type SubmitImageProjectInput = z.input<typeof submitImageProjectInputSchema>
export type StartImageOperationInput = z.input<typeof startImageOperationInputSchema>
export type CommitImageVersionInput = z.input<typeof commitImageVersionInputSchema>
export type SelectImageVersionInput = z.input<typeof selectImageVersionInputSchema>
export type AddVideoSourceInput = z.input<typeof addVideoSourceInputSchema>
export type UpdateVideoTimelineInput = z.input<typeof updateVideoTimelineInputSchema>
export type AnalyzeVideoProjectInput = z.input<typeof analyzeVideoProjectInputSchema>
export type LockVideoSceneInput = z.input<typeof lockVideoSceneInputSchema>
export type ApplyVideoAlternativeInput = z.input<typeof applyVideoAlternativeInputSchema>
export type RenderVideoInput = z.input<typeof renderVideoInputSchema>
export type SaveImageOutputInput = z.input<typeof saveImageOutputInputSchema>
export type ImageGenerationTaskResult = z.infer<typeof imageGenerationTaskResultSchema>
export type VideoRenderTaskResult = z.infer<typeof videoRenderTaskResultSchema>
