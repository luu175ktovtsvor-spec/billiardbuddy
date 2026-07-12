import { z } from 'zod'

export const imageWorkbenchIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const imageWorkbenchIsoDateSchema = z.string().datetime()
export const imageWorkbenchUrlSchema = z.string().min(1).max(4096)
export const imageWorkbenchRatioSchema = z.string().min(1).max(16).default('3:4')

export const imageIntentSchema = z.enum([
  'poster_text',
  'portrait',
  'creative',
  'edit_content',
  'inpaint',
])

export const imageQualitySchema = z.enum(['draft', 'standard', 'final']).default('standard')

export const imageWorkbenchTextLayerSchema = z.object({
  id: imageWorkbenchIdSchema,
  type: z.literal('text'),
  text: z.string().max(2000),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  scale_x: z.number().positive().default(1),
  scale_y: z.number().positive().default(1),
  angle: z.number().finite().default(0),
  fill: z.string().max(64).default('#111111'),
  font_family: z.string().max(120).default('PingFang SC'),
  font_size: z.number().positive().max(512).default(64),
  font_weight: z.string().max(32).optional(),
  font_style: z.string().max(32).optional(),
  text_align: z.enum(['left', 'center', 'right', 'justify']).default('center'),
  stroke: z.string().max(64).optional(),
  stroke_width: z.number().nonnegative().max(64).default(0),
  opacity: z.number().min(0).max(1).default(1),
})

export const imageWorkbenchCanvasSchema = z.object({
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  text_layers: z.array(imageWorkbenchTextLayerSchema).max(80).default([]),
  updated_at: imageWorkbenchIsoDateSchema,
})

export const imageWorkbenchMaskSchema = z.object({
  asset_id: imageWorkbenchIdSchema,
  url: imageWorkbenchUrlSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mode: z.enum(['alpha_transparent_edit']).default('alpha_transparent_edit'),
})

export const imageWorkbenchReviewSchema = z.object({
  text_quality_status: z.string().max(80).optional(),
  text_quality_warning: z.boolean().optional(),
  text_quality_warning_message: z.string().max(2000).optional(),
  text_quality_missing: z.array(z.string().max(200)).max(80).optional(),
  portrait_qc_status: z.string().max(80).optional(),
  portrait_qc_auto_checked: z.boolean().optional(),
  portrait_qc_message: z.string().max(2000).optional(),
  portrait_qc_warnings: z.array(z.string().max(500)).max(80).optional(),
  input_qc_status: z.string().max(80).optional(),
  input_qc_warnings: z.array(z.string().max(500)).max(80).optional(),
  commercial_ready: z.boolean().optional(),
  risk_messages: z.array(z.string().max(500)).max(80).optional(),
}).default({})

export const imageWorkbenchVersionKindSchema = z.enum([
  'generated',
  'imported',
  'edit',
  'inpaint',
  'text_export',
  'upscale',
])

export const imageWorkbenchVersionSchema = z.object({
  id: imageWorkbenchIdSchema,
  parent_version_id: imageWorkbenchIdSchema.nullable().optional(),
  kind: imageWorkbenchVersionKindSchema,
  image_url: imageWorkbenchUrlSchema,
  generation_id: z.string().min(1).max(256).optional(),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  ratio: z.string().min(1).max(16).optional(),
  prompt: z.string().max(8000).optional(),
  instruction: z.string().max(4000).optional(),
  job_id: z.string().max(256).optional(),
  mask: imageWorkbenchMaskSchema.optional(),
  review: imageWorkbenchReviewSchema.optional(),
  created_at: imageWorkbenchIsoDateSchema,
})

export const imageWorkbenchProjectSchema = z.object({
  schema_version: z.literal(1),
  project_id: imageWorkbenchIdSchema,
  title: z.string().min(1).max(120),
  source_generation_id: z.string().min(1).max(256).optional(),
  current_version_id: imageWorkbenchIdSchema,
  prompt: z.string().max(8000).optional(),
  intent: imageIntentSchema.default('poster_text'),
  quality: imageQualitySchema,
  ratio: z.string().min(1).max(16).optional(),
  quantity: z.number().int().positive().max(4).default(3),
  reference_asset_ids: z.array(imageWorkbenchIdSchema).max(16).default([]),
  canvas: imageWorkbenchCanvasSchema,
  versions: z.array(imageWorkbenchVersionSchema).min(1).max(500),
  created_at: imageWorkbenchIsoDateSchema,
  updated_at: imageWorkbenchIsoDateSchema,
})

export const studioImageSchema = z.object({
  generation_id: z.string().min(1),
  poster_url: imageWorkbenchUrlSchema,
  source_url: imageWorkbenchUrlSchema.optional(),
  revised_prompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  ratio: z.string().optional(),
}).catchall(z.unknown())

export const mediaJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  progress: z.number().optional(),
  stage: z.string().nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
})

export const mediaJobStartResponseSchema = z.object({
  job_id: z.string().min(1),
})

export const studioGenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(8000),
  image_prompt: z.string().max(8000).optional(),
  style: z.string().max(2000).optional(),
  poster_text: z.record(z.string(), z.unknown()).optional(),
  print_mode: z.boolean().optional(),
  portrait_consent: z.boolean().optional(),
  scene_template_id: z.string().max(80).optional(),
  ratio: imageWorkbenchRatioSchema,
  count: z.number().int().min(1).max(4).default(3),
  intent: imageIntentSchema.default('poster_text'),
  quality: imageQualitySchema,
  reference_image_paths: z.array(z.string().min(1).max(4096)).max(8).optional(),
  reference_generation_ids: z.array(z.string().min(1).max(256)).max(8).optional(),
  logo_path: z.string().min(1).max(4096).optional(),
  qr_path: z.string().min(1).max(4096).optional(),
  qrcode_text: z.string().max(4096).optional(),
  qrcode_content: z.string().max(4096).optional(),
  qr_content: z.string().max(4096).optional(),
  conversation_id: z.string().max(256).optional(),
  workspaceRoot: z.string().max(4096).optional(),
  working_dir: z.string().max(4096).optional(),
})

export const studioEditRequestSchema = z.object({
  source_generation_id: z.string().min(1).max(256).optional(),
  source_image_path: z.string().min(1).max(4096).optional(),
  prompt: z.string().min(1).max(4000),
  image_prompt: z.string().max(4000).optional(),
  ratio: z.string().max(16).optional(),
  mask_path: z.string().min(1).max(4096).optional(),
  intent: z.enum(['edit_content', 'inpaint']).default('edit_content'),
  quality: imageQualitySchema,
  conversation_id: z.string().max(256).optional(),
  workspaceRoot: z.string().max(4096).optional(),
  working_dir: z.string().max(4096).optional(),
}).refine(value => !!value.source_generation_id || !!value.source_image_path, {
  message: 'source_generation_id or source_image_path is required',
})

export const studioUpscaleRequestSchema = z.object({
  source_generation_id: z.string().min(1).max(256).optional(),
  source_image_path: z.string().min(1).max(4096).optional(),
  scale: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(4),
  conversation_id: z.string().max(256).optional(),
  workspaceRoot: z.string().max(4096).optional(),
  working_dir: z.string().max(4096).optional(),
}).refine(value => !!value.source_generation_id || !!value.source_image_path, {
  message: 'source_generation_id or source_image_path is required',
})

export const imageWorkbenchCreateProjectRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  source_generation_id: z.string().min(1).max(256).optional(),
  image_url: imageWorkbenchUrlSchema,
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  ratio: z.string().max(16).optional(),
  prompt: z.string().max(8000).optional(),
  intent: imageIntentSchema.default('poster_text'),
  quality: imageQualitySchema,
  quantity: z.number().int().positive().max(4).default(3),
  reference_asset_ids: z.array(imageWorkbenchIdSchema).max(16).default([]),
  review: imageWorkbenchReviewSchema.optional(),
})

export const imageWorkbenchUpdateCanvasRequestSchema = z.object({
  current_version_id: imageWorkbenchIdSchema.optional(),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  text_layers: z.array(imageWorkbenchTextLayerSchema).max(80).default([]),
})

export const imageWorkbenchAddVersionRequestSchema = z.object({
  parent_version_id: imageWorkbenchIdSchema.optional(),
  kind: imageWorkbenchVersionKindSchema,
  image_url: imageWorkbenchUrlSchema,
  generation_id: z.string().min(1).max(256).optional(),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  ratio: z.string().max(16).optional(),
  prompt: z.string().max(8000).optional(),
  instruction: z.string().max(4000).optional(),
  job_id: z.string().max(256).optional(),
  mask: imageWorkbenchMaskSchema.optional(),
  review: imageWorkbenchReviewSchema.optional(),
  set_current: z.boolean().default(true),
})

export const imageWorkbenchRollbackRequestSchema = z.object({
  version_id: imageWorkbenchIdSchema,
})

export const imageWorkbenchAssetKindSchema = z.enum(['reference', 'mask', 'export', 'library'])

export const imageWorkbenchUploadAssetRequestSchema = z.object({
  kind: imageWorkbenchAssetKindSchema,
  data_url: z.string().min(32),
  filename: z.string().max(160).optional(),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
})

export const imageWorkbenchAssetSchema = z.object({
  asset_id: imageWorkbenchIdSchema,
  kind: imageWorkbenchAssetKindSchema,
  url: imageWorkbenchUrlSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  created_at: imageWorkbenchIsoDateSchema,
})

export const imageWorkbenchExportRequestSchema = z.object({
  version_id: imageWorkbenchIdSchema.optional(),
  data_url: z.string().min(32),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  text_layers: z.array(imageWorkbenchTextLayerSchema).max(80).optional(),
})

export const imageWorkbenchSaveToLibraryRequestSchema = z.object({
  version_id: imageWorkbenchIdSchema.optional(),
  export_asset_id: imageWorkbenchIdSchema.optional(),
  title: z.string().min(1).max(120).optional(),
})

export const imageWorkbenchProjectResponseSchema = z.object({
  project: imageWorkbenchProjectSchema,
})

export const imageWorkbenchProjectListResponseSchema = z.object({
  projects: z.array(imageWorkbenchProjectSchema),
})

export const imageWorkbenchAssetResponseSchema = z.object({
  asset: imageWorkbenchAssetSchema,
})

export const imageWorkbenchExportResponseSchema = z.object({
  asset: imageWorkbenchAssetSchema,
  project: imageWorkbenchProjectSchema,
})

export const imageWorkbenchLibraryItemSchema = z.object({
  id: imageWorkbenchIdSchema,
  project_id: imageWorkbenchIdSchema,
  version_id: imageWorkbenchIdSchema.optional(),
  title: z.string(),
  url: imageWorkbenchUrlSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  created_at: imageWorkbenchIsoDateSchema,
})

export const imageWorkbenchLibraryResponseSchema = z.object({
  item: imageWorkbenchLibraryItemSchema,
})

export type ImageIntent = z.infer<typeof imageIntentSchema>
export type ImageQuality = z.infer<typeof imageQualitySchema>
export type ImageWorkbenchReview = z.infer<typeof imageWorkbenchReviewSchema>
export type ImageWorkbenchTextLayer = z.infer<typeof imageWorkbenchTextLayerSchema>
export type ImageWorkbenchCanvas = z.infer<typeof imageWorkbenchCanvasSchema>
export type ImageWorkbenchVersion = z.infer<typeof imageWorkbenchVersionSchema>
export type ImageWorkbenchProject = z.infer<typeof imageWorkbenchProjectSchema>
export type StudioImage = z.infer<typeof studioImageSchema>
export type MediaJob = z.infer<typeof mediaJobSchema>
export type MediaJobStartResponse = z.infer<typeof mediaJobStartResponseSchema>
export type StudioGenerateRequest = z.input<typeof studioGenerateRequestSchema>
export type StudioEditRequest = z.input<typeof studioEditRequestSchema>
export type StudioUpscaleRequest = z.input<typeof studioUpscaleRequestSchema>
export type ImageWorkbenchCreateProjectRequest = z.input<typeof imageWorkbenchCreateProjectRequestSchema>
export type ImageWorkbenchUpdateCanvasRequest = z.input<typeof imageWorkbenchUpdateCanvasRequestSchema>
export type ImageWorkbenchAddVersionRequest = z.input<typeof imageWorkbenchAddVersionRequestSchema>
export type ImageWorkbenchUploadAssetRequest = z.input<typeof imageWorkbenchUploadAssetRequestSchema>
export type ImageWorkbenchAsset = z.infer<typeof imageWorkbenchAssetSchema>
export type ImageWorkbenchLibraryItem = z.infer<typeof imageWorkbenchLibraryItemSchema>
