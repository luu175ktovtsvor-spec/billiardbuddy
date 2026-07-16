import { z } from 'zod'

export const imageWorkbenchIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const imageWorkbenchIsoDateSchema = z.string().datetime()
export const imageWorkbenchUrlSchema = z.string().min(1).max(4096)
export const imageWorkbenchRatioSchema = z.string().min(1).max(16).default('3:4')

const imageBrandPackFields = {
  name: z.string().max(120).nullable().optional(),
  brand_style: z.string().max(120).nullable().optional(),
  brand_color: z.string().max(64).nullable().optional(),
  logo_url: imageWorkbenchUrlSchema.nullable().optional(),
  logo_asset_id: imageWorkbenchIdSchema.nullable().optional(),
  logo_width: z.number().int().positive().max(12000).nullable().optional(),
  logo_height: z.number().int().positive().max(12000).nullable().optional(),
  qrcode_url: imageWorkbenchUrlSchema.nullable().optional(),
  qrcode_asset_id: imageWorkbenchIdSchema.nullable().optional(),
  qrcode_width: z.number().int().positive().max(12000).nullable().optional(),
  qrcode_height: z.number().int().positive().max(12000).nullable().optional(),
  brand_reference_images: z.array(imageWorkbenchUrlSchema).max(16).optional(),
} as const

// Store records predate the image workbench and contain unrelated fields.
// Passthrough keeps those records readable while this contract owns brand data.
export const imageBrandPackSchema = z.object({
  ...imageBrandPackFields,
  brand_reference_images: imageBrandPackFields.brand_reference_images.default([]),
}).passthrough()
export const imageBrandPackPatchSchema = z.object(imageBrandPackFields).partial().passthrough()

export const imageIntentSchema = z.enum([
  'poster_text',
  'portrait',
  'creative',
  'edit_content',
  'inpaint',
])

export const imageQualitySchema = z.enum(['draft', 'standard', 'final']).default('standard')

export const imageReferenceRoleSchema = z.enum([
  'identity_primary',
  'identity_supporting',
  'style_reference',
  'environment_reference',
  'brand_reference',
  'logo',
  'qrcode',
  'mask',
  'source',
])

export const imageAssetReferenceSchema = z.object({
  asset_id: imageWorkbenchIdSchema,
  role: imageReferenceRoleSchema,
  label: z.string().max(120).optional(),
  // Asset URLs are local workbench uploads only. They let a reopened project
  // show the same approved reference without exposing any provider details.
  url: imageWorkbenchUrlSchema.optional(),
})

export const posterTemplateIdSchema = z.enum([
  // Existing projects retain their original type. `custom_poster` keeps the
  // primary path freeform instead of forcing a starter category.
  'custom_poster',
  'opening_anniversary',
  'membership_recharge',
  'weekend_bundle',
  'tournament_signup',
  'recruitment_role',
  // Legacy value kept so projects created before the category wording was
  // corrected remain readable. New creation flows do not emit this value.
  'coach_booking',
  'daily_social',
  // Legacy value kept for projects that used the former holiday shortcut.
  'holiday_moments',
])

export const posterBriefSchema = z.object({
  template_id: posterTemplateIdSchema.default('custom_poster'),
  title: z.string().max(200).default(''),
  offer: z.string().max(200).default(''),
  price: z.string().max(80).default(''),
  date: z.string().max(120).default(''),
  time: z.string().max(120).default(''),
  address: z.string().max(240).default(''),
  phone: z.string().max(80).default(''),
  cta: z.string().max(120).default(''),
  exact_copy: z.array(z.string().max(200)).max(20).default([]),
  brand_asset_ids: z.array(imageWorkbenchIdSchema).max(16).default([]),
  reserved_regions: z.array(z.enum(['title', 'price', 'details', 'contact', 'logo', 'qrcode'])).max(12).default([
    'title',
    'price',
    'details',
    'contact',
    'logo',
    'qrcode',
  ]),
})

export const portraitBriefSchema = z.object({
  subject_role: z.string().max(120).default('本人'),
  change: z.array(z.string().max(240)).max(20).default([]),
  preserve: z.array(z.string().max(240)).max(20).default([
    '面部可辨识特征',
    '肤色与年龄观感',
    '体型比例',
    '人物数量为一人',
  ]),
  authorization_confirmed: z.boolean().default(false),
  primary_reference_asset_id: imageWorkbenchIdSchema.optional(),
})

export const imageCreativeBriefSchema = z.object({
  schema_version: z.literal(1).default(1),
  scene: z.enum(['poster', 'portrait']).default('poster'),
  user_request: z.string().min(1).max(8000),
  output_use: z.enum(['moments', 'group', 'poster', 'rollup', 'profile', 'photo', 'other']).default('poster'),
  ratio: imageWorkbenchRatioSchema,
  quality: imageQualitySchema,
  reference_assets: z.array(imageAssetReferenceSchema).max(16).default([]),
  visual_direction: z.object({
    subject: z.string().max(400).optional(),
    action: z.string().max(400).optional(),
    environment: z.string().max(400).optional(),
    style: z.string().max(400).optional(),
    color: z.string().max(240).optional(),
    lighting: z.string().max(240).optional(),
    composition: z.string().max(400).optional(),
  }).default({}),
  must_preserve: z.array(z.string().max(240)).max(40).default([]),
  must_avoid: z.array(z.string().max(240)).max(40).default([]),
  poster: posterBriefSchema.optional(),
  portrait: portraitBriefSchema.optional(),
  understanding: z.string().max(1000).optional(),
  compiler_version: z.string().max(40).default('image-brief-v1'),
})

export const imageQualityStateSchema = z.enum(['blocked', 'risk', 'recommended', 'user_confirmed', 'unchecked'])

export const imageQualityDecisionSchema = z.object({
  state: imageQualityStateSchema,
  hard_gate_passed: z.boolean().default(false),
  auto_checked: z.boolean().default(false),
  warnings: z.array(z.string().max(500)).max(80).default([]),
  message: z.string().max(2000).default(''),
})

export const imageWorkbenchImageLayerSchema = z.object({
  id: imageWorkbenchIdSchema,
  type: z.enum(['logo', 'qrcode', 'reference_image']),
  asset_id: imageWorkbenchIdSchema,
  url: imageWorkbenchUrlSchema.optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
  scale_x: z.number().positive().default(1),
  scale_y: z.number().positive().default(1),
  angle: z.number().finite().default(0),
  locked: z.boolean().default(true),
  visible: z.boolean().default(true),
})

export const imageCapabilityStatusSchema = z.enum(['accepted', 'unsupported', 'unknown', 'not_requested'])
export const imageInputFidelitySchema = z.enum(['high', 'standard']).default('high')
export const imageCapabilitySchema = z.object({
  input_fidelity_requested: imageInputFidelitySchema.optional(),
  input_fidelity_status: imageCapabilityStatusSchema.default('not_requested'),
  risk: z.string().max(500).optional(),
})

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
  image_layers: z.array(imageWorkbenchImageLayerSchema).max(24).default([]),
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
  poster_quality_state: imageQualityStateSchema.optional(),
  poster_hard_gate_passed: z.boolean().optional(),
  poster_hard_gate_warnings: z.array(z.string().max(500)).max(80).optional(),
  portrait_qc_status: z.string().max(80).optional(),
  portrait_qc_auto_checked: z.boolean().optional(),
  portrait_qc_message: z.string().max(2000).optional(),
  portrait_qc_warnings: z.array(z.string().max(500)).max(80).optional(),
  portrait_quality_state: imageQualityStateSchema.optional(),
  portrait_consistency_status: z.enum(['preserved', 'uncertain', 'drifted', 'not_checked']).optional(),
  input_qc_status: z.string().max(80).optional(),
  input_qc_warnings: z.array(z.string().max(500)).max(80).optional(),
  commercial_ready: z.boolean().optional(),
  quality_decision: imageQualityDecisionSchema.optional(),
  portrait_user_confirmed: z.boolean().optional().default(false),
  input_fidelity: imageCapabilitySchema.optional(),
  input_fidelity_risk: z.string().max(500).optional(),
  risk_messages: z.array(z.string().max(500)).max(80).optional(),
}).default({ portrait_user_confirmed: false })

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
  conversation_id: z.string().max(256).optional(),
  working_dir: z.string().min(1).max(4096).optional(),
  source_generation_id: z.string().min(1).max(256).optional(),
  current_version_id: imageWorkbenchIdSchema,
  prompt: z.string().max(8000).optional(),
  user_request: z.string().max(8000).optional(),
  creative_brief: imageCreativeBriefSchema.optional(),
  brief_understanding: z.string().max(1000).optional(),
  compiler_version: z.string().max(40).optional(),
  intent: imageIntentSchema.default('poster_text'),
  quality: imageQualitySchema,
  ratio: z.string().min(1).max(16).optional(),
  quantity: z.number().int().positive().max(4).default(3),
  reference_asset_ids: z.array(imageWorkbenchIdSchema).max(16).default([]),
  reference_assets: z.array(imageAssetReferenceSchema).max(16).default([]),
  autosave_revision: z.number().int().nonnegative().default(0),
  save_status: z.enum(['saved', 'saving', 'failed']).default('saved'),
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
  local_preview: z.boolean().optional(),
  portrait_quality_state: imageQualityStateSchema.optional(),
  portrait_consistency_status: z.enum(['preserved', 'uncertain', 'drifted', 'not_checked']).optional(),
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

export const imageBriefCompileRequestSchema = z.object({
  prompt: z.string().min(1).max(8000),
  scene: z.enum(['poster', 'portrait']).optional(),
  intent: imageIntentSchema.optional(),
  ratio: imageWorkbenchRatioSchema,
  quality: imageQualitySchema,
  poster_text: z.record(z.string(), z.unknown()).optional(),
  scene_template_id: z.string().max(80).optional(),
  reference_assets: z.array(imageAssetReferenceSchema).max(16).default([]),
  portrait_authorization_confirmed: z.boolean().default(false),
})

export const imageBriefCompileResponseSchema = z.object({
  brief: imageCreativeBriefSchema,
  understanding: z.string().max(1000),
})

export const studioGenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(8000),
  user_request: z.string().max(8000).optional(),
  creative_brief: imageCreativeBriefSchema.optional(),
  image_prompt: z.string().max(8000).optional(),
  style: z.string().max(2000).optional(),
  poster_text: z.record(z.string(), z.unknown()).optional(),
  print_mode: z.boolean().optional(),
  portrait_consent: z.boolean().optional(),
  portrait_authorization_confirmed: z.boolean().optional(),
  scene_template_id: z.string().max(80).optional(),
  ratio: imageWorkbenchRatioSchema,
  count: z.number().int().min(1).max(4).default(3),
  intent: imageIntentSchema.default('poster_text'),
  quality: imageQualitySchema,
  reference_image_paths: z.array(z.string().min(1).max(4096)).max(8).optional(),
  reference_assets: z.array(imageAssetReferenceSchema).max(16).optional(),
  reference_generation_ids: z.array(z.string().min(1).max(256)).max(8).optional(),
  input_fidelity: imageInputFidelitySchema.optional(),
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
  user_request: z.string().max(4000).optional(),
  creative_brief: imageCreativeBriefSchema.optional(),
  image_prompt: z.string().max(4000).optional(),
  ratio: z.string().max(16).optional(),
  reference_assets: z.array(imageAssetReferenceSchema).max(16).optional(),
  reference_image_paths: z.array(z.string().min(1).max(4096)).max(8).optional(),
  reference_generation_ids: z.array(z.string().min(1).max(256)).max(8).optional(),
  input_fidelity: imageInputFidelitySchema.optional(),
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
  conversation_id: z.string().max(256).optional(),
  working_dir: z.string().min(1).max(4096).optional(),
  source_generation_id: z.string().min(1).max(256).optional(),
  image_url: imageWorkbenchUrlSchema,
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  ratio: z.string().max(16).optional(),
  prompt: z.string().max(8000).optional(),
  user_request: z.string().max(8000).optional(),
  creative_brief: imageCreativeBriefSchema.optional(),
  brief_understanding: z.string().max(1000).optional(),
  compiler_version: z.string().max(40).optional(),
  intent: imageIntentSchema.default('poster_text'),
  quality: imageQualitySchema,
  quantity: z.number().int().positive().max(4).default(3),
  reference_asset_ids: z.array(imageWorkbenchIdSchema).max(16).default([]),
  reference_assets: z.array(imageAssetReferenceSchema).max(16).default([]),
  text_layers: z.array(imageWorkbenchTextLayerSchema).max(80).default([]),
  image_layers: z.array(imageWorkbenchImageLayerSchema).max(24).default([]),
  review: imageWorkbenchReviewSchema.optional(),
})

export const imageWorkbenchUpdateCanvasRequestSchema = z.object({
  current_version_id: imageWorkbenchIdSchema.optional(),
  width: z.number().int().positive().max(12000),
  height: z.number().int().positive().max(12000),
  text_layers: z.array(imageWorkbenchTextLayerSchema).max(80).default([]),
  image_layers: z.array(imageWorkbenchImageLayerSchema).max(24).default([]),
  revision: z.number().int().nonnegative().optional(),
  /** 调用方当前工作区(门店文件夹),存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
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
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
  set_current: z.boolean().default(true),
})

export const imageWorkbenchRollbackRequestSchema = z.object({
  version_id: imageWorkbenchIdSchema,
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
})

export const imageWorkbenchPortraitConfirmRequestSchema = z.object({
  version_id: imageWorkbenchIdSchema.optional(),
  confirmed: z.literal(true),
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
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
  image_layers: z.array(imageWorkbenchImageLayerSchema).max(24).optional(),
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
})

export const imageWorkbenchSaveToLibraryRequestSchema = z.object({
  version_id: imageWorkbenchIdSchema.optional(),
  export_asset_id: imageWorkbenchIdSchema.optional(),
  title: z.string().min(1).max(120).optional(),
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
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
export type ImageBrandPack = z.infer<typeof imageBrandPackSchema>
export type ImageBrandPackPatch = z.input<typeof imageBrandPackPatchSchema>
export type ImageQuality = z.infer<typeof imageQualitySchema>
export type ImageReferenceRole = z.infer<typeof imageReferenceRoleSchema>
export type ImageAssetReference = z.infer<typeof imageAssetReferenceSchema>
export type PosterBrief = z.infer<typeof posterBriefSchema>
export type PortraitBrief = z.infer<typeof portraitBriefSchema>
export type ImageCreativeBrief = z.infer<typeof imageCreativeBriefSchema>
export type ImageQualityState = z.infer<typeof imageQualityStateSchema>
export type ImageQualityDecision = z.infer<typeof imageQualityDecisionSchema>
export type ImageWorkbenchImageLayer = z.infer<typeof imageWorkbenchImageLayerSchema>
export type ImageCapability = z.infer<typeof imageCapabilitySchema>
export type ImageWorkbenchReview = z.infer<typeof imageWorkbenchReviewSchema>
export type ImageWorkbenchTextLayer = z.infer<typeof imageWorkbenchTextLayerSchema>
export type ImageWorkbenchCanvas = z.infer<typeof imageWorkbenchCanvasSchema>
export type ImageWorkbenchVersion = z.infer<typeof imageWorkbenchVersionSchema>
export type ImageWorkbenchProject = z.infer<typeof imageWorkbenchProjectSchema>
export type StudioImage = z.infer<typeof studioImageSchema>
export type MediaJob = z.infer<typeof mediaJobSchema>
export type MediaJobStartResponse = z.infer<typeof mediaJobStartResponseSchema>
export type ImageBriefCompileRequest = z.input<typeof imageBriefCompileRequestSchema>
export type ImageBriefCompileResponse = z.infer<typeof imageBriefCompileResponseSchema>
export type StudioGenerateRequest = z.input<typeof studioGenerateRequestSchema>
export type StudioEditRequest = z.input<typeof studioEditRequestSchema>
export type StudioUpscaleRequest = z.input<typeof studioUpscaleRequestSchema>
export type ImageWorkbenchCreateProjectRequest = z.input<typeof imageWorkbenchCreateProjectRequestSchema>
export type ImageWorkbenchUpdateCanvasRequest = z.input<typeof imageWorkbenchUpdateCanvasRequestSchema>
export type ImageWorkbenchAddVersionRequest = z.input<typeof imageWorkbenchAddVersionRequestSchema>
export type ImageWorkbenchPortraitConfirmRequest = z.input<typeof imageWorkbenchPortraitConfirmRequestSchema>
export type ImageWorkbenchUploadAssetRequest = z.input<typeof imageWorkbenchUploadAssetRequestSchema>
export type ImageWorkbenchAsset = z.infer<typeof imageWorkbenchAssetSchema>
export type ImageWorkbenchLibraryItem = z.infer<typeof imageWorkbenchLibraryItemSchema>
