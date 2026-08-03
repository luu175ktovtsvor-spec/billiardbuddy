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
export const STANDALONE_MEDIA_OWNER_ID = 'local_workbench'
export const mediaOwnerSchema = z.object({
  kind: z.literal('standalone'),
  owner_id: z.literal(STANDALONE_MEDIA_OWNER_ID),
})
export const mediaAssetSchema = z.object({
  id: mediaIdSchema,
  role: z.enum(['reference', 'mask', 'source', 'result', 'preview', 'export']),
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
  'composite',
])
export const imageLayerSchema = z.object({
  id: mediaIdSchema,
  source_asset_id: mediaIdSchema,
  x: z.number().finite().nonnegative().max(12000),
  y: z.number().finite().nonnegative().max(12000),
  width: z.number().finite().positive().max(12000),
  height: z.number().finite().positive().max(12000),
  opacity: z.number().finite().min(0.05).max(1).default(1),
})
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
  image_layers: z.array(imageLayerSchema).max(20).optional(),
  created_at: mediaIsoDateSchema,
})
export const mediaDeletionReceiptSchema = z.object({
  schema_version: z.literal(1).default(1),
  deletion_id: mediaIdSchema,
  project_id: mediaIdSchema,
  /** Optional for deletion receipts written before the desktop recovery UI existed. */
  project_kind: z.enum(['image', 'video']).optional(),
  project_title: z.string().min(1).max(200).optional(),
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
  /** Media workbenches are independent products and never belong to chat tasks. */
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

export const imageQualityAssessmentResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  summary: z.string().min(1).max(1000),
  issues: z.array(z.string().min(1).max(500)).max(20).default([]),
  suggestions: z.array(z.string().min(1).max(500)).max(20).default([]),
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
  image_layers: z.array(imageLayerSchema).max(20).optional(),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  data_url: z.string().startsWith('data:image/').optional(),
  /** Legacy media assets stay readable; formal image assets use `/api/images/*`. */
  asset_path: z.string().regex(/^\/api\/(?:media\/assets\/|images\/projects\/)/).optional(),
  url: z.string().url().optional(),
  revised_prompt: z.string().max(8000).optional(),
  quality_assessment: imageQualityAssessmentResultSchema.optional(),
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
  image_layers: z.array(imageLayerSchema.extend({
    image_path: z.string().startsWith('/api/images/projects/'),
    mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  })).max(20).default([]),
  quality_assessment: imageQualityAssessmentResultSchema.optional(),
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

export const publicImageProjectReferenceSchema = imageProjectReferenceSchema.extend({
  image_path: z.string().startsWith('/api/images/projects/'),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
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

export const imageBriefOverridesSchema = z.object({
  confirmed_facts: z.array(z.string().min(1).max(500)).max(40).optional(),
  must_preserve: z.array(z.string().min(1).max(500)).max(40).optional(),
  may_change: z.array(z.string().min(1).max(500)).max(40).optional(),
  exact_text: z.array(z.string().min(1).max(500)).max(40).optional(),
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
  /** User-confirmed Brief fields replace generated suggestions and survive later reasoning. */
  brief_overrides: imageBriefOverridesSchema.default({}),
  references: z.array(imageProjectReferenceSchema).max(8).default([]),
  reference_images: z.array(referenceImageDataUrlSchema).max(8).default([]),
  reference_image_assets: z.array(referenceImageAssetNameSchema).max(8).optional(),
  reference_image_count: z.number().int().min(0).max(8).default(0),
  task_id: mediaIdSchema.optional(),
  outputs: z.array(imageWorkbenchOutputSchema).max(1000).default([]),
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
  content_changed: z.boolean().default(false),
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

/**
 * Timeline v2 is intentionally separate from the pre-refactor scene list
 * above.  The latter remains a read-compatible projection while every new
 * editorial write is represented by a typed command set and a v2 version.
 */
export const videoRationalSchema = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
})
export const videoRationalTimeSchema = z.object({
  ticks: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
  tick_rate: videoRationalSchema,
})
export const videoSourceTimeRangeSchema = z.object({
  start: videoRationalTimeSchema,
  duration: videoRationalTimeSchema,
})
export const videoEditorialTimeRangeSchema = videoSourceTimeRangeSchema
/** Source-time consumed for each unit of timeline time. Omitted means 1x. */
export const videoPlaybackSpeedSchema = videoRationalSchema.refine(
  value => value.num <= 100 && value.den <= 100,
  { message: 'playback speed must be between 1/100x and 100x' },
)

export const videoTimelineTrackSchema = z.object({
  id: mediaIdSchema,
  kind: z.enum(['primary_video', 'b_roll', 'source_audio', 'music', 'caption', 'overlay']),
  order: z.number().int().min(0).max(100),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
})

export const videoTimelineAssetBindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('source'),
    source_id: mediaIdSchema,
    source_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    source_range: videoSourceTimeRangeSchema,
  }),
  z.object({
    kind: z.literal('project_asset'),
    asset_id: mediaIdSchema,
    asset_content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    source_range: videoSourceTimeRangeSchema.optional(),
  }),
  z.object({
    kind: z.literal('caption_document'),
    caption_document_id: mediaIdSchema,
    caption_revision_id: mediaIdSchema,
  }),
])

export const videoTimelineItemSchema = z.object({
  id: mediaIdSchema,
  /** Stable bridge for read-only v1 scenes while v2 is the only writer. */
  legacy_scene_id: mediaIdSchema.optional(),
  track_id: mediaIdSchema,
  kind: z.enum(['video', 'audio', 'caption', 'overlay']),
  timeline_range: videoEditorialTimeRangeSchema,
  binding: videoTimelineAssetBindingSchema,
  /** Required whenever a source range and timeline range have different duration. */
  speed: videoPlaybackSpeedSchema.optional(),
  linked_camera_shot_ids: z.array(mediaIdSchema).max(200).default([]),
  linked_content_segment_ids: z.array(mediaIdSchema).max(200).default([]),
  locked: z.boolean().default(false),
  evidence_ids: z.array(mediaIdSchema).max(500).default([]),
})

export const editorialTimelineVersionSchema = z.object({
  schema_version: z.literal(2),
  id: mediaIdSchema,
  parent_version_id: mediaIdSchema.optional(),
  project_revision: z.number().int().nonnegative(),
  source_fingerprint_set_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  facts_basis_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  tick_rate: videoRationalSchema,
  tracks: z.array(videoTimelineTrackSchema).min(1).max(100),
  items: z.array(videoTimelineItemSchema).max(2000),
  created_by_command_set_id: mediaIdSchema,
  created_at: mediaIsoDateSchema,
})

export const timelineDraftSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  facts_basis_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  base_timeline_version_id: mediaIdSchema.optional(),
  plan_ids: z.array(mediaIdSchema).max(200).default([]),
  tracks: z.array(videoTimelineTrackSchema).min(1).max(100),
  items: z.array(videoTimelineItemSchema).max(2000),
  status: z.enum(['proposed', 'accepted', 'rejected', 'stale']),
  accepted_command_set_id: mediaIdSchema.optional(),
  created_at: mediaIsoDateSchema,
})

const videoTransformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scale: z.number().positive().max(100),
  rotation: z.number().finite().min(-3600).max(3600),
  opacity: z.number().min(0).max(1),
})
const videoKeyframeSchema = <T extends z.ZodType>(value: T) => z.object({
  at: videoRationalTimeSchema,
  value,
  interpolation: z.enum(['hold', 'linear', 'bezier']),
})

export const videoDeliveryItemOverrideSchema = z.object({
  item_id: mediaIdSchema,
  transform_keyframes: z.array(videoKeyframeSchema(videoTransformSchema)).max(1000).optional(),
  volume_keyframes: z.array(videoKeyframeSchema(z.number().min(0).max(4))).max(1000).optional(),
  fade_in: videoRationalTimeSchema.optional(),
  fade_out: videoRationalTimeSchema.optional(),
  caption_style_id: mediaIdSchema.optional(),
})

export const initialEncodingProfileSchema = z.union([
  z.object({
    container: z.enum(['mp4', 'mov']),
    video: z.object({
      codec: z.literal('h264'),
      quality: z.object({ mode: z.literal('crf'), value: z.number().int().min(16).max(28), preset: z.enum(['fast', 'medium', 'slow']) }),
    }),
    audio: z.object({ codec: z.literal('aac_lc'), sample_rate: z.literal(48_000), channels: z.union([z.literal(1), z.literal(2)]) }),
    output_color: z.object({ range: z.literal('sdr_bt709'), pixel_format: z.literal('yuv420p') }),
  }),
  z.object({
    container: z.literal('mov'),
    video: z.object({ codec: z.literal('prores_422'), quality: z.object({ mode: z.literal('prores_profile'), profile: z.enum(['standard', 'hq']) }) }),
    audio: z.object({ codec: z.literal('pcm_s16le'), sample_rate: z.literal(48_000), channels: z.union([z.literal(1), z.literal(2)]) }),
    output_color: z.object({ range: z.literal('sdr_bt709'), pixel_format: z.literal('yuv422p10le') }),
  }),
])

export const videoExportProfileRevisionSchema = z.object({
  id: mediaIdSchema,
  profile_id: mediaIdSchema,
  revision: z.number().int().positive(),
  target: z.enum(['custom', 'horizontal_video', 'vertical_short', 'square_social']),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  frame_rate: videoRationalSchema,
  encoding: initialEncodingProfileSchema,
  hdr_input_policy: z.enum(['tone_map_to_sdr', 'reject']),
  caption_mode: z.enum(['none', 'burn_in', 'sidecar']),
  sidecar_caption_format: z.enum(['srt', 'vtt']).optional(),
  audio_policy: z.enum(['source_only', 'music_with_source', 'music_only']),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  created_at: mediaIsoDateSchema,
})

export const videoExportProfileSchema = z.object({
  id: mediaIdSchema,
  scope: z.enum(['product_preset', 'project_custom']),
  current_revision_id: mediaIdSchema,
  created_at: mediaIsoDateSchema,
})

export const deliveryVariantVersionSchema = z.object({
  id: mediaIdSchema,
  variant_id: mediaIdSchema,
  parent_version_id: mediaIdSchema.optional(),
  editorial_timeline_version_id: mediaIdSchema,
  export_profile_revision_id: mediaIdSchema,
  export_profile_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  composition_plan_id: mediaIdSchema.optional(),
  caption_revision_id: mediaIdSchema.optional(),
  audio_finishing_plan_id: mediaIdSchema.optional(),
  item_overrides: z.array(videoDeliveryItemOverrideSchema).max(2000),
  created_by_command_set_id: mediaIdSchema,
  created_at: mediaIsoDateSchema,
})

export const deliveryVariantSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  name: z.string().trim().min(1).max(160),
  current_version_id: mediaIdSchema,
  created_at: mediaIsoDateSchema,
})

export const editorialTimelineCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('insert'), track_id: mediaIdSchema, item: videoTimelineItemSchema }),
  z.object({ kind: z.literal('trim'), item_id: mediaIdSchema, source_range: videoSourceTimeRangeSchema, timeline_range: videoEditorialTimeRangeSchema, speed: videoPlaybackSpeedSchema.optional() }),
  z.object({ kind: z.literal('split'), item_id: mediaIdSchema, at: videoRationalTimeSchema }),
  z.object({ kind: z.literal('reorder'), item_id: mediaIdSchema, track_id: mediaIdSchema, timeline_start: videoRationalTimeSchema }),
  z.object({ kind: z.literal('replace'), item_id: mediaIdSchema, replacement: videoTimelineItemSchema }),
  z.object({ kind: z.literal('ripple_delete'), item_ids: z.array(mediaIdSchema).min(1).max(1000), close_gap: z.boolean() }),
  z.object({ kind: z.literal('set_track_state'), track_id: mediaIdSchema, locked: z.boolean().optional(), muted: z.boolean().optional() }).refine(value => value.locked !== undefined || value.muted !== undefined, { message: 'track state is required' }),
  z.object({ kind: z.literal('lock'), item_ids: z.array(mediaIdSchema).min(1).max(1000), locked: z.boolean() }),
])

export const deliveryVariantCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_caption_revision'), caption_document_id: mediaIdSchema, caption_revision_id: mediaIdSchema }),
  z.object({ kind: z.literal('set_transform_keyframes'), item_id: mediaIdSchema, keyframes: z.array(videoKeyframeSchema(videoTransformSchema)).min(1).max(1000) }),
  z.object({ kind: z.literal('set_volume_keyframes'), item_id: mediaIdSchema, keyframes: z.array(videoKeyframeSchema(z.number().min(0).max(4))).min(1).max(1000) }),
  z.object({ kind: z.literal('set_audio_fades'), item_id: mediaIdSchema, fade_in: videoRationalTimeSchema.optional(), fade_out: videoRationalTimeSchema.optional() }).refine(value => value.fade_in || value.fade_out, { message: 'audio fade is required' }),
  z.object({ kind: z.literal('set_caption_style'), item_id: mediaIdSchema, caption_style_id: mediaIdSchema }),
  z.object({ kind: z.literal('set_export_profile'), export_profile_revision_id: mediaIdSchema, expected_profile_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
])

export const timelineCommandSetSchema = z.union([
  z.object({
    id: mediaIdSchema,
    project_id: mediaIdSchema,
    actor_id: z.string().trim().min(1).max(160),
    idempotency_key: z.string().min(16).max(160),
    created_at: mediaIsoDateSchema,
    target: z.object({ kind: z.literal('editorial'), base_timeline_version_id: mediaIdSchema }),
    commands: z.array(editorialTimelineCommandSchema).min(1).max(1000),
  }),
  z.object({
    id: mediaIdSchema,
    project_id: mediaIdSchema,
    actor_id: z.string().trim().min(1).max(160),
    idempotency_key: z.string().min(16).max(160),
    created_at: mediaIsoDateSchema,
    target: z.object({ kind: z.literal('delivery_variant'), variant_id: mediaIdSchema, base_variant_version_id: mediaIdSchema }),
    commands: z.array(deliveryVariantCommandSchema).min(1).max(1000),
  }),
])

export const editorialCommandReceiptSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  command_set_id: mediaIdSchema,
  request_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  target_kind: z.enum(['editorial', 'delivery_variant']),
  created_version_id: mediaIdSchema,
  created_at: mediaIsoDateSchema,
})

export const deliveryVariantCreationReceiptSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  request_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  variant_id: mediaIdSchema,
  /** The immutable version created by the original create request. */
  version_id: mediaIdSchema.optional(),
  created_at: mediaIsoDateSchema,
})

export const videoExecutionPlanSchema = z.object({
  id: mediaIdSchema,
  editorial_timeline_version_id: mediaIdSchema,
  delivery_variant_version_id: mediaIdSchema,
  /** Compiler input order and timeline placement; source inputs alone lose both. */
  timeline_items: z.array(z.object({
    order: z.number().int().nonnegative(),
    item_id: mediaIdSchema,
    track_id: mediaIdSchema,
    track_kind: z.enum(['primary_video', 'b_roll', 'source_audio', 'music', 'voice_over', 'caption', 'overlay']),
    kind: z.enum(['video', 'audio', 'caption', 'overlay']),
    timeline_range: videoEditorialTimeRangeSchema,
    binding: videoTimelineAssetBindingSchema,
    speed: videoPlaybackSpeedSchema.optional(),
  })).max(2000),
  inputs: z.array(z.object({ source_id: mediaIdSchema, source_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/), source_start: videoRationalTimeSchema, source_range: videoSourceTimeRangeSchema })).max(2000),
  filters: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('scale_pad'), width: z.number().int().positive(), height: z.number().int().positive() }),
    z.object({ kind: z.literal('transform'), item_id: mediaIdSchema, keyframes: z.array(videoKeyframeSchema(videoTransformSchema)).max(1000) }),
    z.object({ kind: z.literal('volume'), item_id: mediaIdSchema, keyframes: z.array(videoKeyframeSchema(z.number().min(0).max(4))).max(1000) }),
    z.object({ kind: z.literal('audio_fade'), item_id: mediaIdSchema, fade_in: videoRationalTimeSchema.optional(), fade_out: videoRationalTimeSchema.optional() }).refine(value => value.fade_in || value.fade_out, { message: 'audio fade is required' }),
  ])).max(4000),
  maps: z.array(z.object({ track_id: mediaIdSchema, output: z.enum(['video', 'audio', 'caption']) })).max(100),
  encoder: videoExportProfileRevisionSchema,
  color_pipeline: z.object({ output: z.literal('sdr_bt709'), hdr_input_policy: z.enum(['tone_map_to_sdr', 'reject']) }),
  audio_pipeline: z.object({ policy: z.enum(['source_only', 'music_with_source', 'music_only']), sample_rate: z.literal(48_000), channels: z.union([z.literal(1), z.literal(2)]) }),
  output_target: z.object({ kind: z.literal('managed'), locator: z.string().regex(/^execution-plans\/[a-z0-9_-]+$/) }),
  compiler_version: z.literal('editorial-compiler-v1'),
  basis_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  created_at: mediaIsoDateSchema,
})

export const videoPreviewSchema = z.object({
  timeline_version_id: mediaIdSchema,
  asset_id: mediaIdSchema,
  asset_path: z.string().regex(/^\/api\/(?:media\/assets\/|videos\/projects\/)/),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  created_at: mediaIsoDateSchema,
})

export const videoOutputVerificationSchema = z.object({
  timeline_version_id: mediaIdSchema,
  byte_size: z.number().int().positive(),
  file_mtime_ms: z.number().finite().nonnegative().optional(),
  duration_ms: z.number().int().positive(),
  video_stream_count: z.number().int().positive(),
  audio_stream_count: z.number().int().nonnegative(),
  width: z.number().int().positive().max(12000).optional(),
  height: z.number().int().positive().max(12000).optional(),
  fps: z.number().positive().max(240).optional(),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  verified_at: mediaIsoDateSchema,
})

const remoteAnalysisRangeSchema = z.object({
  source_id: mediaIdSchema,
  ranges: z.array(videoSourceTimeRangeSchema).min(1).max(2_000),
})
export const remoteAnalysisConsentSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  revision: z.number().int().positive(),
  state: z.enum(['active', 'revoked']),
  provider: z.literal('aliyun_bailian'),
  region: z.literal('cn-beijing'),
  purposes: z.array(z.enum(['visual_evidence', 'planning', 'caption_translation', 'asr', 'semantic_search'])).min(1).max(5),
  data_kinds: z.array(z.enum(['audio_extract', 'keyframes', 'proxy_video', 'transcript'])).min(1).max(4),
  coverage: z.array(remoteAnalysisRangeSchema).min(1).max(200),
  acknowledged_estimate_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  granted_by_actor_id: z.string().min(1).max(160),
  granted_at: mediaIsoDateSchema,
  revoked_at: mediaIsoDateSchema.optional(),
})
export const videoRemoteBudgetSchema = z.object({
  id: mediaIdSchema,
  estimate_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  state: z.enum(['estimated', 'reserved', 'settled', 'released', 'outcome_unknown']),
  requests: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  input_bytes: z.number().int().nonnegative(),
  visual_frames: z.number().int().nonnegative(),
  proxy_seconds: z.number().nonnegative(),
  asr_seconds: z.number().nonnegative(),
  estimated_amount_micros: z.number().int().nonnegative(),
  /** One immutable entry per Relay receipt; aggregate fields above remain the
   * user-approved estimate rather than being overwritten by the last call. */
  settlements: z.array(z.object({
    operation_id: mediaIdSchema,
    receipt_id: mediaIdSchema,
    capability: z.enum(['visual_evidence', 'media_reasoning', 'speech_transcription', 'semantic_embedding']),
    requests: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    input_bytes: z.number().int().nonnegative(),
    visual_frames: z.number().int().nonnegative(),
    proxy_seconds: z.number().nonnegative(),
    asr_seconds: z.number().nonnegative(),
    estimated_amount_micros: z.number().int().nonnegative(),
    settled_at: mediaIsoDateSchema,
  })).max(10_000).default([]),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
})
export const createRemoteAnalysisConsentInputSchema = remoteAnalysisConsentSchema.pick({ purposes: true, data_kinds: true, coverage: true, acknowledged_estimate_hash: true }).extend({ granted_by_actor_id: z.string().min(1).max(160).optional() })
export const revokeRemoteAnalysisConsentInputSchema = z.object({ revision: z.number().int().positive() })
export const estimateRemoteAnalysisInputSchema = z.object({ purposes: z.array(z.enum(['visual_evidence', 'planning', 'caption_translation', 'asr', 'semantic_search'])).min(1).max(5), source_ids: z.array(mediaIdSchema).min(1).max(200) })

export const videoStudioProjectSchema = mediaProjectBaseSchema.extend({
  kind: z.literal('video'),
  state: z.enum(['draft', 'ready', 'rendering', 'complete', 'failed']),
  sources: z.array(videoSourceSchema).max(200).default([]),
  timeline: z.array(videoClipSchema).max(500).default([]),
  output: videoOutputSettingsSchema.default({ width: 1080, height: 1920, fps: 30 }),
  evidence: z.array(videoEvidenceSchema).max(5000).default([]),
  evidence_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  remote_analysis_consents: z.array(remoteAnalysisConsentSchema).max(200).default([]),
  remote_analysis_budgets: z.array(videoRemoteBudgetSchema).max(10_000).default([]),
  brief: videoBriefSchema.optional(),
  /** Legacy scene versions remain readable; all new writes use Editorial v2 below. */
  timeline_versions: z.array(videoTimelineVersionSchema).max(1000).default([]),
  current_timeline_version_id: mediaIdSchema.optional(),
  alternatives: z.array(videoAlternativeSchema).max(3).default([]),
  editorial_timeline_versions: z.array(editorialTimelineVersionSchema).max(1000).default([]),
  current_editorial_timeline_version_id: mediaIdSchema.optional(),
  timeline_drafts: z.array(timelineDraftSchema).max(1000).default([]),
  delivery_variants: z.array(deliveryVariantSchema).max(1000).default([]),
  delivery_variant_versions: z.array(deliveryVariantVersionSchema).max(2000).default([]),
  export_profiles: z.array(videoExportProfileSchema).max(200).default([]),
  export_profile_revisions: z.array(videoExportProfileRevisionSchema).max(1000).default([]),
  editorial_command_receipts: z.array(editorialCommandReceiptSchema).max(5000).default([]),
  delivery_variant_creation_receipts: z.array(deliveryVariantCreationReceiptSchema).max(1000).default([]),
  execution_plans: z.array(videoExecutionPlanSchema).max(2000).default([]),
  task_id: mediaIdSchema.optional(),
  preview_task_id: mediaIdSchema.optional(),
  preview: videoPreviewSchema.optional(),
  output_path: z.string().min(1).max(4096).optional(),
  output_asset_id: mediaIdSchema.optional(),
  output_content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  output_verification: videoOutputVerificationSchema.optional(),
  error: z.string().max(2000).optional(),
  error_code: mediaSafeErrorCodeSchema.optional(),
})

export const mediaProjectSchema = z.discriminatedUnion('kind', [
  imageWorkbenchProjectSchema,
  videoStudioProjectSchema,
])

const persistedMediaProjectFields = {
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
  references: z.array(publicImageProjectReferenceSchema).max(8).default([]),
  version_history: z.array(publicImageVersionSchema).max(1000).default([]),
})
export const publicVideoStudioProjectSchema = videoStudioProjectSchema.omit({
  ...persistedMediaProjectFields,
  editorial_command_receipts: true,
  delivery_variant_creation_receipts: true,
  editorial_timeline_versions: true,
  timeline_drafts: true,
  delivery_variant_versions: true,
  execution_plans: true,
}).extend({
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
  kind: z.enum(['image.generate', 'video.probe', 'video.fingerprint', 'video.analyze', 'video.plan', 'video.transcribe', 'video.understand', 'video.index', 'video.preview', 'video.render']),
  status: mediaTaskStatusSchema,
  /** Monotonic sequence for user-visible changes to this persisted job. */
  status_sequence: z.number().int().nonnegative().default(0),
  progress: z.number().min(0).max(100),
  stage: z.string().max(160),
  remote_task_id: z.string().min(1).max(256).optional(),
  /** Server-provided status polling backoff for asynchronous image work. */
  poll_after_seconds: z.number().int().min(1).max(3600).optional(),
  idempotency_key: z.string().min(16).max(160).optional(),
  /** Persisted before the first remote submission attempt; absent means no request has left this process. */
  remote_submission_started_at: mediaIsoDateSchema.optional(),
  outcome_unknown: z.boolean().optional(),
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
  poll_after_seconds: true,
  remote_submission_started_at: true,
  remote_result_acknowledged_at: true,
})

export const mediaJobEventSchema = z.object({
  schema_version: z.literal(1),
  cursor: z.number().int().positive(),
  project_id: mediaIdSchema,
  task_id: mediaIdSchema,
  operation_id: mediaIdSchema,
  status_sequence: z.number().int().nonnegative(),
  occurred_at: mediaIsoDateSchema,
  task: mediaTaskSchema,
})

export const mediaJobEventJournalSchema = z.object({
  schema_version: z.literal(1),
  next_cursor: z.number().int().positive(),
  events: z.array(mediaJobEventSchema).max(2000),
})

export const publicMediaJobEventSchema = mediaJobEventSchema.omit({ task: true }).extend({
  task: publicMediaTaskSchema,
})

export const publicMediaJobEventPageSchema = z.object({
  events: z.array(publicMediaJobEventSchema).max(200),
  cursor: z.number().int().nonnegative(),
  reset_required: z.boolean(),
})

const publicMediaFactTimeSchema = z.object({
  ticks: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
  tick_rate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
})

export const publicVideoFactRangeSchema = z.object({
  start: publicMediaFactTimeSchema,
  duration: publicMediaFactTimeSchema,
})

export const publicVideoFactKindSchema = z.enum([
  'source',
  'derivative',
  'transcript',
  'transcript_revision',
  'camera_shot',
  'content_segment',
  'evidence_window',
  'evidence',
])

const publicEvidenceWindowCoverageSchema = z.object({
  generation: z.number().int().nonnegative(),
  request_budget: z.object({
    max_windows: z.number().int().positive(),
    max_visual_requests: z.number().int().positive(),
    max_frames: z.number().int().positive(),
    max_proxy_seconds: z.number().int().nonnegative(),
    max_input_tokens: z.number().int().positive(),
    max_covered_ticks: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
  }),
  request_usage: z.object({
    windows: z.number().int().nonnegative(),
    visual_requests: z.number().int().nonnegative(),
    frames: z.number().int().nonnegative(),
    proxy_seconds: z.number().int().nonnegative(),
    estimated_input_tokens: z.number().int().nonnegative(),
    covered_ticks: z.string().regex(/^-?(?:0|[1-9]\d*)$/),
  }),
  uncovered: z.array(z.object({
    range: publicVideoFactRangeSchema,
    reason: z.enum(['max_windows', 'max_visual_requests', 'max_frames', 'max_proxy_seconds', 'max_input_tokens', 'max_covered_ticks']),
  })).max(20_000),
})

/** Summary-only projection: no local paths, managed locators, prompts or provider credentials. */
export const publicVideoFactSummarySchema = z.object({
  id: mediaIdSchema,
  kind: publicVideoFactKindSchema,
  source_id: mediaIdSchema.optional(),
  source_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  segment_id: mediaIdSchema.optional(),
  range: publicVideoFactRangeSchema.optional(),
  state: z.enum(['ready', 'stale', 'missing', 'changed', 'probing', 'unsupported']).optional(),
  fingerprint_state: z.enum(['pending', 'ready', 'failed']).optional(),
  sample_strategy: z.enum(['representative_frame', 'start_middle_end', 'visual_change_points', 'transcript_signal', 'short_proxy']).optional(),
  analysis_depth: z.enum(['summary', 'standard', 'deep']).optional(),
  coverage: publicEvidenceWindowCoverageSchema.optional(),
  created_at: mediaIsoDateSchema,
})

export const publicVideoFactPageSchema = z.object({
  schema_version: z.literal(1),
  items: z.array(publicVideoFactSummarySchema).max(200),
  next_cursor: z.string().min(1).max(2048).optional(),
})

export const publicVideoFactSearchResultSchema = z.object({
  id: mediaIdSchema,
  source_id: mediaIdSchema,
  kind: publicVideoFactKindSchema,
  segment_id: mediaIdSchema.optional(),
  segment_ids: z.array(mediaIdSchema).max(10_000).default([]),
  range: publicVideoFactRangeSchema,
  text: z.string().min(1).max(32_000),
})

export const publicVideoFactSearchPageSchema = z.object({
  schema_version: z.literal(1),
  generation: z.number().int().nonnegative(),
  items: z.array(publicVideoFactSearchResultSchema).max(100),
  next_cursor: z.string().min(1).max(2048).optional(),
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
  output_verification: videoOutputVerificationSchema.optional(),
  temporary_output: z.string().min(1).max(4096).optional(),
  video_encoder: z.enum(['h264_videotoolbox', 'h264_mf', 'mpeg4']).optional(),
})

export const videoPreviewTaskResultSchema = z.object({
  preview_revision: z.number().int().nonnegative(),
  timeline_version_id: mediaIdSchema,
  asset_id: mediaIdSchema,
  asset_path: z.string().regex(/^\/api\/(?:media\/assets\/|videos\/projects\/)/),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  temporary_output: z.string().min(1).max(4096).optional(),
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
  brief_overrides: imageBriefOverridesSchema.optional(),
  references: z.array(imageProjectReferenceSchema).max(8).optional(),
  new_reference_images: z.array(referenceImageDataUrlSchema).max(8).default([]),
  new_reference_roles: z.array(imageReferenceRoleSchema).max(8).default([]),
  /** Explicitly reopen a completed project for one new candidate operation. */
  start_new_generation_round: z.boolean().default(false),
  confirm_unknown_retry: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.references?.some(reference => reference.role === 'unclassified')) {
    context.addIssue({ code: 'custom', path: ['references'], message: 'reference image roles must be confirmed' })
  }
  if (value.references && new Set(value.references.map(reference => reference.asset_id)).size !== value.references.length) {
    context.addIssue({ code: 'custom', path: ['references'], message: 'reference image ids must be unique' })
  }
  if (value.new_reference_images.length !== value.new_reference_roles.length) {
    context.addIssue({ code: 'custom', path: ['new_reference_roles'], message: 'every new reference image needs one explicit role' })
  }
  if (value.new_reference_roles.includes('unclassified')) {
    context.addIssue({ code: 'custom', path: ['new_reference_roles'], message: 'new reference image roles must be confirmed' })
  }
  if ((value.references?.length ?? 0) + value.new_reference_images.length > 8) {
    context.addIssue({ code: 'custom', path: ['new_reference_images'], message: 'an image project accepts at most eight references' })
  }
  const newBytes = value.new_reference_images.reduce((total, image) => total + approximateDataUrlBytes(image), 0)
  if (newBytes > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
    context.addIssue({ code: 'custom', path: ['new_reference_images'], message: 'new reference images exceed the total size limit' })
  }
})

export const addImageProjectReferencesInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  reference_images: z.array(referenceImageDataUrlSchema).min(1).max(8),
  reference_roles: z.array(imageReferenceRoleSchema).min(1).max(8),
}).superRefine((value, context) => {
  if (value.reference_images.length !== value.reference_roles.length) {
    context.addIssue({ code: 'custom', path: ['reference_roles'], message: 'every reference image needs one explicit role' })
  }
  if (value.reference_roles.includes('unclassified')) {
    context.addIssue({ code: 'custom', path: ['reference_roles'], message: 'reference image roles must be confirmed' })
  }
  const bytes = value.reference_images.reduce((total, image) => total + approximateDataUrlBytes(image), 0)
  if (bytes > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
    context.addIssue({ code: 'custom', path: ['reference_images'], message: 'reference images exceed the total size limit' })
  }
})

export const submitImageProjectInputSchema = z.object({
  confirm_unknown_retry: z.boolean().default(false),
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
  kind: z.enum(['upscale', 'text_layout', 'composite']),
  rendered_image: imagePngDataUrlSchema,
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  scale: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  text_layers: z.array(imageTextLayerSchema).max(80).default([]),
  image_layers: z.array(imageLayerSchema).max(20).default([]),
}).superRefine((value, context) => {
  if (value.kind === 'upscale' && !value.scale) {
    context.addIssue({ code: 'custom', path: ['scale'], message: 'upscale requires a scale' })
  }
  if (value.kind !== 'upscale' && value.scale) {
    context.addIssue({ code: 'custom', path: ['scale'], message: `${value.kind} does not accept a scale` })
  }
  if (value.kind === 'composite' && value.image_layers.length === 0) {
    context.addIssue({ code: 'custom', path: ['image_layers'], message: 'composite requires at least one image layer' })
  }
  if (value.kind !== 'composite' && value.image_layers.length > 0) {
    context.addIssue({ code: 'custom', path: ['image_layers'], message: `${value.kind} does not accept image layers` })
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

export const selectVideoTimelineVersionInputSchema = z.object({
  revision: z.number().int().nonnegative(),
  version_id: mediaIdSchema,
})

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

export const previewVideoInputSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  timeline_version_id: mediaIdSchema,
})

export const applyEditorialTimelineCommandsInputSchema = z.object({
  base_timeline_version_id: mediaIdSchema,
  commands: z.array(editorialTimelineCommandSchema).min(1).max(1000),
})

export const createDeliveryVariantInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  editorial_timeline_version_id: mediaIdSchema.optional(),
  export_profile_revision_id: mediaIdSchema.optional(),
})

export const applyDeliveryVariantCommandsInputSchema = z.object({
  base_variant_version_id: mediaIdSchema,
  commands: z.array(deliveryVariantCommandSchema).min(1).max(1000),
})

export const acceptTimelineDraftInputSchema = z.object({
  base_timeline_version_id: mediaIdSchema.optional(),
})

export const saveImageOutputInputSchema = z.object({
  version_id: mediaIdSchema.optional(),
  /** One-release compatibility for callers that still address legacy outputs. */
  output_id: mediaIdSchema.optional(),
  output_path: z.string().min(1).max(4096),
}).refine(value => Boolean(value.version_id || value.output_id), {
  message: 'version_id is required',
})

/** Evidence returned only after the chosen local export has been re-read. */
export const imageOutputVerificationSchema = z.object({
  byte_size: z.number().int().positive(),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  verified_at: mediaIsoDateSchema,
})

export const saveImageOutputResultSchema = z.object({
  path: z.string().min(1).max(4096),
  verification: imageOutputVerificationSchema,
})

export type MediaProject = z.infer<typeof mediaProjectSchema>
export type ImageWorkbenchProject = z.infer<typeof imageWorkbenchProjectSchema>
export type VideoStudioProject = z.infer<typeof videoStudioProjectSchema>
export type MediaTask = z.infer<typeof mediaTaskSchema>
export type MediaTaskInput = z.input<typeof mediaTaskSchema>
export type PublicMediaProject = z.infer<typeof publicMediaProjectSchema>
export type PublicImageWorkbenchProject = z.infer<typeof publicImageWorkbenchProjectSchema>
export type PublicVideoStudioProject = z.infer<typeof publicVideoStudioProjectSchema>
export type PublicMediaTask = z.infer<typeof publicMediaTaskSchema>
export type MediaJobEvent = z.infer<typeof mediaJobEventSchema>
export type MediaJobEventJournal = z.infer<typeof mediaJobEventJournalSchema>
export type PublicMediaJobEvent = z.infer<typeof publicMediaJobEventSchema>
export type PublicMediaJobEventPage = z.infer<typeof publicMediaJobEventPageSchema>
export type PublicVideoFactSummary = z.infer<typeof publicVideoFactSummarySchema>
export type PublicVideoFactPage = z.infer<typeof publicVideoFactPageSchema>
export type PublicVideoFactSearchPage = z.infer<typeof publicVideoFactSearchPageSchema>
export type MediaOwner = z.infer<typeof mediaOwnerSchema>
export type MediaAsset = z.infer<typeof mediaAssetSchema>
export type MediaVersion = z.infer<typeof mediaVersionSchema>
export type PublicImageVersion = z.infer<typeof publicImageVersionSchema>
export type ImageVersionKind = z.infer<typeof imageVersionKindSchema>
export type ImageTextLayer = z.infer<typeof imageTextLayerSchema>
export type ImageLayer = z.infer<typeof imageLayerSchema>
export type ImageCreativeBrief = z.infer<typeof imageCreativeBriefSchema>
export type ImageBriefOverrides = z.infer<typeof imageBriefOverridesSchema>
export type ImageReferenceRole = z.infer<typeof imageReferenceRoleSchema>
export type ImageProjectReference = z.infer<typeof imageProjectReferenceSchema>
export type PublicImageProjectReference = z.infer<typeof publicImageProjectReferenceSchema>
export type MediaDeletionReceipt = z.infer<typeof mediaDeletionReceiptSchema>
export type PublicMediaDeletionReceipt = z.infer<typeof publicMediaDeletionReceiptSchema>
export type VideoSource = z.infer<typeof videoSourceSchema>
export type VideoClip = z.infer<typeof videoClipSchema>
export type VideoEvidence = z.infer<typeof videoEvidenceSchema>
export type VideoBrief = z.infer<typeof videoBriefSchema>
export type VideoScene = z.infer<typeof videoSceneSchema>
export type VideoAlternative = z.infer<typeof videoAlternativeSchema>
export type VideoTimelineVersion = z.infer<typeof videoTimelineVersionSchema>
export type VideoTimelineTrack = z.infer<typeof videoTimelineTrackSchema>
export type VideoTimelineItem = z.infer<typeof videoTimelineItemSchema>
export type EditorialTimelineVersion = z.infer<typeof editorialTimelineVersionSchema>
export type TimelineDraft = z.infer<typeof timelineDraftSchema>
export type VideoExportProfile = z.infer<typeof videoExportProfileSchema>
export type VideoExportProfileRevision = z.infer<typeof videoExportProfileRevisionSchema>
export type DeliveryVariant = z.infer<typeof deliveryVariantSchema>
export type DeliveryVariantVersion = z.infer<typeof deliveryVariantVersionSchema>
export type EditorialTimelineCommand = z.infer<typeof editorialTimelineCommandSchema>
export type DeliveryVariantCommand = z.infer<typeof deliveryVariantCommandSchema>
export type TimelineCommandSet = z.infer<typeof timelineCommandSetSchema>
export type VideoExecutionPlan = z.infer<typeof videoExecutionPlanSchema>
export type VideoPreview = z.infer<typeof videoPreviewSchema>
export type VideoOutputVerification = z.infer<typeof videoOutputVerificationSchema>
export type ImageOutputVerification = z.infer<typeof imageOutputVerificationSchema>
export type SaveImageOutputResult = z.infer<typeof saveImageOutputResultSchema>
export type CreateImageProjectInput = z.input<typeof createImageProjectInputSchema>
export type CreateVideoProjectInput = z.input<typeof createVideoProjectInputSchema>
export type UpdateImageProjectInput = z.input<typeof updateImageProjectInputSchema>
export type AddImageProjectReferencesInput = z.input<typeof addImageProjectReferencesInputSchema>
export type SubmitImageProjectInput = z.input<typeof submitImageProjectInputSchema>
export type StartImageOperationInput = z.input<typeof startImageOperationInputSchema>
export type CommitImageVersionInput = z.input<typeof commitImageVersionInputSchema>
export type SelectImageVersionInput = z.input<typeof selectImageVersionInputSchema>
export type AddVideoSourceInput = z.input<typeof addVideoSourceInputSchema>
export type UpdateVideoTimelineInput = z.input<typeof updateVideoTimelineInputSchema>
export type SelectVideoTimelineVersionInput = z.input<typeof selectVideoTimelineVersionInputSchema>
export type AnalyzeVideoProjectInput = z.input<typeof analyzeVideoProjectInputSchema>
export type CreateRemoteAnalysisConsentInput = z.input<typeof createRemoteAnalysisConsentInputSchema>
export type EstimateRemoteAnalysisInput = z.input<typeof estimateRemoteAnalysisInputSchema>
export type LockVideoSceneInput = z.input<typeof lockVideoSceneInputSchema>
export type ApplyVideoAlternativeInput = z.input<typeof applyVideoAlternativeInputSchema>
export type RenderVideoInput = z.input<typeof renderVideoInputSchema>
export type PreviewVideoInput = z.input<typeof previewVideoInputSchema>
export type ApplyEditorialTimelineCommandsInput = z.input<typeof applyEditorialTimelineCommandsInputSchema>
export type CreateDeliveryVariantInput = z.input<typeof createDeliveryVariantInputSchema>
export type ApplyDeliveryVariantCommandsInput = z.input<typeof applyDeliveryVariantCommandsInputSchema>
export type AcceptTimelineDraftInput = z.input<typeof acceptTimelineDraftInputSchema>
export type SaveImageOutputInput = z.input<typeof saveImageOutputInputSchema>
export type ImageGenerationTaskResult = z.infer<typeof imageGenerationTaskResultSchema>
export type VideoRenderTaskResult = z.infer<typeof videoRenderTaskResultSchema>
export type VideoPreviewTaskResult = z.infer<typeof videoPreviewTaskResultSchema>
