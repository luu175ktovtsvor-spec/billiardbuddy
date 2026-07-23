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

function validateImageModelSize(
  value: { model: ImageGenerationModel, size: ImageCanvasSize },
  context: z.RefinementCtx,
): void {
  if (!imageSizeSupportedByModel(value.model, value.size)) {
    context.addIssue({
      code: 'custom',
      path: ['size'],
      message: 'the selected image size is not supported by this model',
    })
  }
}

const mediaProjectBaseSchema = z.object({
  schema_version: z.literal(1),
  id: mediaIdSchema,
  title: z.string().min(1).max(160),
  workspace_root: z.string().min(1).max(4096).optional(),
  /** Optional so standalone and legacy media projects remain valid. */
  product_task_id: productTaskOwnerIdSchema.optional(),
  revision: z.number().int().nonnegative(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
})

export const imageWorkbenchOutputSchema = z.object({
  id: mediaIdSchema,
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  data_url: z.string().startsWith('data:image/').optional(),
  asset_path: z.string().startsWith('/api/media/assets/').optional(),
  url: z.string().url().optional(),
  revised_prompt: z.string().max(8000).optional(),
}).refine(value => Boolean(value.data_url || value.asset_path || value.url), {
  message: 'an image output needs data_url, asset_path or url',
})

export const imageWorkbenchProjectSchema = mediaProjectBaseSchema.extend({
  kind: z.literal('image'),
  state: z.enum(['draft', 'queued', 'generating', 'ready', 'failed']),
  mode: z.enum(['generate', 'edit']).default('generate'),
  model: imageGenerationModelSchema.default('gpt-image-2'),
  prompt: z.string().min(1).max(8000),
  size: imageCanvasSizeSchema.default('1024x1024'),
  count: z.number().int().min(1).max(4).default(1),
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
})

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

export const videoStudioProjectSchema = mediaProjectBaseSchema.extend({
  kind: z.literal('video'),
  state: z.enum(['draft', 'ready', 'rendering', 'complete', 'failed']),
  sources: z.array(videoSourceSchema).max(200).default([]),
  timeline: z.array(videoClipSchema).max(500).default([]),
  output: videoOutputSettingsSchema.default({ width: 1080, height: 1920, fps: 30 }),
  task_id: mediaIdSchema.optional(),
  output_path: z.string().min(1).max(4096).optional(),
  error: z.string().max(2000).optional(),
  error_code: mediaSafeErrorCodeSchema.optional(),
})

export const mediaProjectSchema = z.discriminatedUnion('kind', [
  imageWorkbenchProjectSchema,
  videoStudioProjectSchema,
])

export const mediaTaskSchema = z.object({
  schema_version: z.literal(1),
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  kind: z.enum(['image.generate', 'video.probe', 'video.render']),
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
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(2000).optional(),
  error_code: mediaSafeErrorCodeSchema.optional(),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
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
  output_path: z.string().min(1).max(4096),
  temporary_output: z.string().min(1).max(4096).optional(),
  video_encoder: z.enum(['h264_videotoolbox', 'h264_mf', 'mpeg4']).optional(),
})

export const createImageProjectInputSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  prompt: z.string().min(1).max(8000),
  workspace_root: z.string().min(1).max(4096).optional(),
  mode: z.enum(['generate', 'edit']).default('generate'),
  model: imageGenerationModelSchema.default('gpt-image-2'),
  size: imageCanvasSizeSchema.default('1024x1024'),
  count: z.number().int().min(1).max(4).default(1),
  reference_images: z.array(referenceImageDataUrlSchema).max(8).default([]),
}).superRefine((value, context) => {
  validateImageModelSize(value, context)
  if (value.mode === 'edit' && value.reference_images.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['reference_images'],
      message: 'edit mode requires at least one reference image',
    })
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
})

export const createVideoProjectInputSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  workspace_root: z.string().min(1).max(4096).optional(),
  output: videoOutputSettingsSchema.optional(),
})

export const updateImageProjectInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  prompt: z.string().min(1).max(8000),
  model: imageGenerationModelSchema,
  size: imageCanvasSizeSchema,
  count: z.number().int().min(1).max(4),
  confirm_unknown_retry: z.boolean().default(false),
}).superRefine(validateImageModelSize)

export const submitImageProjectInputSchema = z.object({
  confirm_unknown_retry: z.boolean().default(false),
  data_egress_consent: imageDataEgressAcknowledgementSchema.optional(),
})

export const addVideoSourceInputSchema = z.object({
  path: z.string().min(1).max(4096),
})

export const updateVideoTimelineInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  clips: z.array(videoClipSchema).max(500),
})

export const renderVideoInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  output_path: z.string().min(1).max(4096),
})

export const saveImageOutputInputSchema = z.object({
  output_id: mediaIdSchema,
  output_path: z.string().min(1).max(4096),
})

export type MediaProject = z.infer<typeof mediaProjectSchema>
export type ImageWorkbenchProject = z.infer<typeof imageWorkbenchProjectSchema>
export type VideoStudioProject = z.infer<typeof videoStudioProjectSchema>
export type MediaTask = z.infer<typeof mediaTaskSchema>
export type VideoSource = z.infer<typeof videoSourceSchema>
export type VideoClip = z.infer<typeof videoClipSchema>
export type CreateImageProjectInput = z.input<typeof createImageProjectInputSchema>
export type CreateVideoProjectInput = z.input<typeof createVideoProjectInputSchema>
export type UpdateImageProjectInput = z.input<typeof updateImageProjectInputSchema>
export type SubmitImageProjectInput = z.input<typeof submitImageProjectInputSchema>
export type AddVideoSourceInput = z.input<typeof addVideoSourceInputSchema>
export type UpdateVideoTimelineInput = z.input<typeof updateVideoTimelineInputSchema>
export type RenderVideoInput = z.input<typeof renderVideoInputSchema>
export type SaveImageOutputInput = z.input<typeof saveImageOutputInputSchema>
export type ImageGenerationTaskResult = z.infer<typeof imageGenerationTaskResultSchema>
export type VideoRenderTaskResult = z.infer<typeof videoRenderTaskResultSchema>
