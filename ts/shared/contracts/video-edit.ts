import { z } from 'zod'

export const videoContentTypeSchema = z.enum([
  'freeform',
  'venue_atmosphere',
  'event_highlight',
  'assistant_daily',
  'coach_tutorial',
  'offer_conversion',
  'customer_experience',
  'recruitment_team',
  'knowledge_live_clip',
])

export const videoStoryGoalSchema = z.enum([
  'exposure',
  'acquisition',
  'interaction',
  'conversion',
  'education',
  'recruitment',
  'other',
])

export const videoOutputChannelSchema = z.enum([
  'douyin',
  'kuaishou',
  'wechat_video',
  'xiaohongshu',
  'moments',
  'local_life',
  'other',
])

export const videoViewSchema = z.enum(['talking', 'ambient'])
export const videoSourceRoleSchema = z.enum([
  'talking_take',
  'venue_entry',
  'space_wide',
  'people_interaction',
  'play_action',
  'event_moment',
  'detail_product',
  'service_process',
  'brand_end',
  'live_longform',
  'unclassified',
])

export const videoBriefSourceAssetSchema = z.object({
  source_id: z.string().min(1).max(160),
  role: videoSourceRoleSchema,
  confidence: z.number().min(0).max(1).optional(),
})

export const videoCreativeBriefSchema = z.object({
  schema_version: z.literal(1).default(1),
  user_request: z.string().min(1).max(6000),
  content_type: videoContentTypeSchema.default('freeform'),
  story_goal: videoStoryGoalSchema.default('other'),
  output_channel: videoOutputChannelSchema.optional(),
  preferred_view: videoViewSchema,
  target_ratio: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
  target_duration_ms: z.number().int().min(3_000).max(1_800_000).optional(),
  source_assets: z.array(videoBriefSourceAssetSchema).max(200).default([]),
  exact_copy: z.array(z.string().min(1).max(500)).max(50).default([]),
  must_preserve: z.array(z.string().min(1).max(500)).max(50).default([]),
  must_avoid: z.array(z.string().min(1).max(500)).max(50).default([]),
  required_story_slots: z.array(z.string().min(1).max(100)).max(30).default([]),
  understanding: z.string().min(1).max(3000),
  compiler_version: z.string().min(1).max(80),
})

export const videoTimeRangeSchema = z.object({
  start_ms: z.number().int().min(0),
  end_ms: z.number().int().positive(),
}).refine(value => value.end_ms > value.start_ms, { message: 'end_ms must be greater than start_ms' })

export const videoSourceRangeSchema = z.object({
  source_id: z.string().min(1).max(160),
  in_ms: z.number().int().min(0),
  out_ms: z.number().int().positive(),
}).refine(value => value.out_ms > value.in_ms, { message: 'out_ms must be greater than in_ms' })

export const videoSourceSchema = z.object({
  id: z.string().min(1).max(160),
  file_uri: z.string().min(1).max(4096),
  name: z.string().min(1).max(500),
  fingerprint: z.string().min(8).max(200),
  duration_ms: z.number().int().min(0).default(0),
  width: z.number().int().min(0).default(0),
  height: z.number().int().min(0).default(0),
  fps: z.number().min(0).max(240).optional(),
  vfr: z.boolean().default(false),
  rotation: z.number().int().min(-360).max(360).default(0),
  color_space: z.string().max(100).optional(),
  has_video: z.boolean().default(true),
  has_audio: z.boolean().optional(),
  missing: z.boolean().default(false),
  excluded: z.boolean().default(false),
  favorite: z.boolean().default(false),
  role: videoSourceRoleSchema.default('unclassified'),
  role_confidence: z.number().min(0).max(1).optional(),
  proxy_status: z.enum(['none', 'queued', 'ready', 'error']).default('none'),
  proxy_url: z.string().max(4096).optional(),
  warnings: z.array(z.string().max(500)).max(30).default([]),
})

export const videoEvidenceKindSchema = z.enum(['transcript', 'shot', 'visual', 'audio', 'music', 'source_role'])
export const videoEvidenceRefSchema = z.object({
  id: z.string().min(1).max(200),
  kind: videoEvidenceKindSchema,
  source_id: z.string().min(1).max(160),
  path: z.string().min(1).max(4096),
  provider: z.string().min(1).max(100),
  provider_version: z.string().min(1).max(100),
  source_fingerprint: z.string().min(8).max(200),
  created_at: z.string().datetime(),
  status: z.enum(['ready', 'warning', 'error']).default('ready'),
  warning: z.string().max(1000).optional(),
})

export const videoShotEvidenceSchema = z.object({
  source_id: z.string().min(1).max(160),
  shots: z.array(z.object({
    index: z.number().int().min(0),
    start_ms: z.number().int().min(0),
    end_ms: z.number().int().positive(),
    quality_score: z.number().min(0).max(1),
    keep: z.boolean(),
    avg_luma: z.number().optional(),
    avg_motion: z.number().optional(),
    warning: z.string().max(500).optional(),
  })).max(1000),
})

export const videoVisualEvidenceSchema = z.object({
  source_id: z.string().min(1).max(160),
  local_only: z.boolean(),
  shots: z.array(z.object({
    index: z.number().int().min(0),
    suggested_role: videoSourceRoleSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })).max(1000),
})

export const videoAudioEvidenceSchema = z.object({
  source_id: z.string().min(1).max(160),
  has_audio: z.boolean().optional(),
  transcript_available: z.boolean(),
  speech_ranges: z.array(videoTimeRangeSchema).max(5000).default([]),
  action_peaks_ms: z.array(z.number().int().min(0)).max(5000).default([]),
  warnings: z.array(z.string().max(500)).max(30).default([]),
})

export const videoMusicEvidenceSchema = z.object({
  source_id: z.string().min(1).max(160),
  license_id: z.string().min(1).max(500),
  fingerprint: z.string().min(8).max(200),
  tempo: z.number().positive().optional(),
  beats_ms: z.array(z.number().int().min(0)).max(20_000).default([]),
  sections: z.array(z.object({ label: z.enum(['intro', 'build', 'peak', 'resolve']), range: videoTimeRangeSchema })).max(20).default([]),
})

export const videoSourceRoleEvidenceSchema = z.object({
  source_id: z.string().min(1).max(160),
  selected_role: videoSourceRoleSchema,
  suggestions: z.array(z.object({
    role: videoSourceRoleSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })).max(5),
})

export const videoGainPointSchema = z.object({
  at_ms: z.number().int().min(0),
  gain: z.number().min(0).max(4),
})

export const videoAudioLayerSchema = z.object({
  id: z.string().min(1).max(160),
  role: z.enum(['speech', 'ambience', 'music', 'sfx']),
  source_range: videoSourceRangeSchema.optional(),
  owner: z.boolean().default(false),
  gain_envelope: z.array(videoGainPointSchema).max(100).default([]),
  fade_in_ms: z.number().int().min(0).max(10_000).default(0),
  fade_out_ms: z.number().int().min(0).max(10_000).default(0),
  enabled: z.boolean().default(true),
})

export const videoCropSchema = z.object({
  x: z.number().min(0).max(1).default(0),
  y: z.number().min(0).max(1).default(0),
  width: z.number().positive().max(1).default(1),
  height: z.number().positive().max(1).default(1),
  fit: z.enum(['contain', 'cover']).default('contain'),
  subject_ref: z.string().max(200).optional(),
  focal_x: z.number().min(0).max(1).optional(),
  focal_y: z.number().min(0).max(1).optional(),
}).refine(value => value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001, {
  message: 'crop must stay inside normalized bounds',
})

export const videoLayerSchema = z.object({
  id: z.string().min(1).max(160),
  role: z.enum(['primary', 'broll', 'overlay']),
  source_range: videoSourceRangeSchema,
  crop: videoCropSchema.default({ x: 0, y: 0, width: 1, height: 1, fit: 'contain' }),
  speed: z.number().min(0.25).max(4).default(1),
  opacity: z.number().min(0).max(1).default(1),
  enabled: z.boolean().default(true),
})

export const videoGraphicSchema = z.object({
  id: z.string().min(1).max(160),
  intent: z.string().min(1).max(300),
  role: z.enum(['subtitle', 'title', 'lower_third', 'emphasis', 'logo', 'cta']),
  text: z.string().max(1000).optional(),
  asset_id: z.string().max(160).optional(),
  anchor: z.enum(['top', 'upper', 'center', 'lower', 'bottom', 'safe_corner']),
  enter_ms: z.number().int().min(0),
  hold_ms: z.number().int().min(0),
  exit_ms: z.number().int().min(0),
  priority: z.number().int().min(0).max(100),
  exclusive_group: z.string().max(100).optional(),
  safe_regions: z.array(z.enum(['top', 'upper', 'center', 'lower', 'bottom', 'corner'])).max(6).default([]),
  style_token: z.string().min(1).max(100).default('neutral-readable'),
  hidden_reason: z.string().max(500).optional(),
})

export const videoDialogueSchema = z.object({
  origin: z.enum(['transcript', 'narration']).default('transcript'),
  transcript_ref: z.string().max(200).optional(),
  original_text: z.string().max(5000).default(''),
  semantic_text: z.string().max(5000).default(''),
  display_text: z.string().max(5000).default(''),
  state: z.enum(['kept', 'deleted']).default('kept'),
  take_id: z.string().max(160).optional(),
  take_options: z.array(z.object({
    id: z.string().min(1).max(160),
    source_range: videoSourceRangeSchema,
    label: z.string().min(1).max(200),
    warning: z.string().max(500).optional(),
  })).max(20).default([]),
  suspected_issue: z.string().max(500).optional(),
})

export const videoTransitionSchema = z.object({
  kind: z.enum(['cut', 'dissolve', 'brand']).default('cut'),
  duration_ms: z.number().int().min(0).max(2_000).default(0),
  reason: z.string().max(500).optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== 'cut' && !value.reason?.trim()) {
    ctx.addIssue({ code: 'custom', message: 'non-cut transition requires a reason' })
  }
})

export const videoReplacementCandidateSchema = z.object({
  id: z.string().min(1).max(160),
  source_range: videoSourceRangeSchema,
  rationale: z.string().min(1).max(500),
  score: z.number().min(0).max(1).optional(),
  evidence_refs: z.array(z.string().min(1).max(200)).max(30).default([]),
})

export const videoSceneSchema = z.object({
  id: z.string().min(1).max(160),
  order: z.number().int().min(0),
  story_role: z.enum(['hook', 'explain', 'proof', 'atmosphere', 'offer', 'cta']),
  edit_clock: z.enum(['dialogue', 'music', 'action']),
  visual_role: z.enum(['talking_head', 'wide', 'detail', 'action', 'broll', 'brand']),
  source_ranges: z.array(videoSourceRangeSchema).min(1).max(20),
  output_range: videoTimeRangeSchema,
  dialogue: videoDialogueSchema.optional(),
  video_layers: z.array(videoLayerSchema).min(1).max(20),
  audio_layers: z.array(videoAudioLayerSchema).max(30).default([]),
  graphics: z.array(videoGraphicSchema).max(30).default([]),
  transition_in: videoTransitionSchema.default({ kind: 'cut', duration_ms: 0 }),
  attention_owner: z.enum(['person', 'action', 'space', 'information', 'cta']),
  evidence_refs: z.array(z.string().min(1).max(200)).max(100).default([]),
  rationale: z.string().min(1).max(1000),
  needs_review: z.array(z.string().min(1).max(500)).max(30).default([]),
  replacement_candidates: z.array(videoReplacementCandidateSchema).max(3).default([]),
  locked_by_user: z.boolean().default(false),
  deleted: z.boolean().default(false),
}).superRefine((scene, ctx) => {
  const owners = scene.audio_layers.filter(layer => layer.enabled && layer.owner)
  if (owners.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['audio_layers'], message: 'a Scene can have at most one enabled audio owner' })
    return
  }
  const owner = owners[0]
  if (!owner) return
  const valid = scene.edit_clock === 'dialogue'
    ? owner.role === 'speech'
    : scene.edit_clock === 'music'
      ? owner.role === 'music'
      : owner.role === 'ambience' || owner.role === 'sfx'
  if (!valid) ctx.addIssue({ code: 'custom', path: ['audio_layers'], message: 'audio owner must match the Scene edit clock' })
})

export const videoCanvasSchema = z.object({
  width: z.number().int().positive().max(7680).default(1080),
  height: z.number().int().positive().max(7680).default(1920),
  fps: z.number().positive().max(120).default(30),
  pixel_aspect_ratio: z.number().positive().max(10).default(1),
  ratio: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
  safe_inset: z.object({ top: z.number().min(0).max(0.4), right: z.number().min(0).max(0.4), bottom: z.number().min(0).max(0.4), left: z.number().min(0).max(0.4) }).default({ top: 0.08, right: 0.06, bottom: 0.14, left: 0.06 }),
})

export const videoBrandSchema = z.object({
  logo_asset_id: z.string().max(160).optional(),
  logo_path: z.string().max(4096).optional(),
  primary_color: z.string().max(80).optional(),
  font_family: z.string().max(200).optional(),
  cta_text: z.string().max(500).optional(),
  preset: z.enum(['neutral', 'clean', 'energetic']).default('neutral'),
}).default({ preset: 'neutral' })

export const videoMusicSchema = z.object({
  source_id: z.string().max(160).optional(),
  path: z.string().max(4096).optional(),
  license_id: z.string().max(500).optional(),
  fingerprint: z.string().max(200).optional(),
  segment: videoTimeRangeSchema.optional(),
  energy: z.enum(['calm', 'natural', 'lively', 'crisp']).default('natural'),
  enabled: z.boolean().default(false),
}).default({ energy: 'natural', enabled: false })

export const videoAlternativeSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
  tradeoff: z.string().min(1).max(1000),
  base_revision: z.number().int().min(0),
  scenes: z.array(videoSceneSchema).min(1).max(1000),
  changed_scene_ids: z.array(z.string().min(1).max(160)).max(1000).default([]),
  created_at: z.string().datetime(),
})

export const videoProjectStatusSchema = z.object({
  phase: z.enum(['empty', 'preparing', 'analyzing', 'draft_ready', 'editing', 'rendering', 'ready', 'error']).default('empty'),
  save_state: z.enum(['saved', 'saving', 'conflict', 'error']).default('saved'),
  warnings: z.array(z.string().max(1000)).max(100).default([]),
  missing_coverage: z.array(z.string().max(200)).max(30).default([]),
  last_job_id: z.string().max(160).optional(),
  last_error: z.object({ code: z.string().max(100), message: z.string().max(1000), retryable: z.boolean() }).optional(),
})

export const videoProjectSchema = z.object({
  schema_version: z.literal(2),
  project_id: z.string().min(1).max(160),
  name: z.string().min(1).max(500),
  conversation_id: z.string().max(200).optional(),
  working_dir: z.string().min(1).max(4096).optional(),
  revision: z.number().int().min(0),
  updated_at: z.string().datetime(),
  goal: videoViewSchema,
  creative_brief: videoCreativeBriefSchema.optional(),
  canvas: videoCanvasSchema,
  sources: z.array(videoSourceSchema).max(200),
  evidence: z.array(videoEvidenceRefSchema).max(5000).default([]),
  scenes: z.array(videoSceneSchema).max(1000).default([]),
  brand: videoBrandSchema,
  music: videoMusicSchema,
  alternatives: z.array(videoAlternativeSchema).max(3).default([]),
  status: videoProjectStatusSchema,
  migrated_from_v1: z.boolean().default(false),
})

export const videoOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scene.move'), scene_id: z.string().min(1), to_index: z.number().int().min(0) }),
  z.object({ type: z.literal('scene.split'), scene_id: z.string().min(1), at_source_ms: z.number().int().positive() }),
  z.object({ type: z.literal('scene.merge'), scene_id: z.string().min(1), next_scene_id: z.string().min(1) }),
  z.object({ type: z.literal('scene.delete'), scene_id: z.string().min(1) }),
  z.object({ type: z.literal('scene.restore'), scene_id: z.string().min(1) }),
  z.object({ type: z.literal('scene.set_story_role'), scene_id: z.string().min(1), story_role: z.enum(['hook', 'explain', 'proof', 'atmosphere', 'offer', 'cta']) }),
  z.object({ type: z.literal('scene.set_clock'), scene_id: z.string().min(1), edit_clock: z.enum(['dialogue', 'music', 'action']) }),
  z.object({ type: z.literal('scene.set_transition'), scene_id: z.string().min(1), transition: videoTransitionSchema }),
  z.object({ type: z.literal('scene.set_crop'), scene_id: z.string().min(1), layer_id: z.string().min(1), crop: videoCropSchema }),
  z.object({ type: z.literal('scene.set_speed'), scene_id: z.string().min(1), layer_id: z.string().min(1), speed: z.number().min(0.25).max(4) }),
  z.object({ type: z.literal('scene.set_locked'), scene_id: z.string().min(1), locked: z.boolean() }),
  z.object({ type: z.literal('scene.replace_source'), scene_id: z.string().min(1), source_range: videoSourceRangeSchema }),
  z.object({ type: z.literal('scene.set_broll'), scene_id: z.string().min(1), source_range: videoSourceRangeSchema.optional() }),
  z.object({ type: z.literal('scene.add_narration'), scene_id: z.string().min(1), text: z.string().min(1).max(5000), source_range: videoSourceRangeSchema.optional() }),
  z.object({ type: z.literal('scene.remove_narration'), scene_id: z.string().min(1) }),
  z.object({ type: z.literal('scene.set_graphics'), scene_id: z.string().min(1), graphics: z.array(videoGraphicSchema).max(30) }),
  z.object({ type: z.literal('dialogue.set_state'), scene_id: z.string().min(1), state: z.enum(['kept', 'deleted']) }),
  z.object({ type: z.literal('dialogue.set_semantic'), scene_id: z.string().min(1), semantic_text: z.string().max(5000) }),
  z.object({ type: z.literal('dialogue.set_display'), scene_id: z.string().min(1), display_text: z.string().max(5000) }),
  z.object({ type: z.literal('dialogue.select_take'), scene_id: z.string().min(1), take_id: z.string().min(1) }),
  z.object({ type: z.literal('source.set_role'), source_id: z.string().min(1), role: videoSourceRoleSchema }),
  z.object({ type: z.literal('source.set_excluded'), source_id: z.string().min(1), excluded: z.boolean() }),
  z.object({ type: z.literal('source.set_favorite'), source_id: z.string().min(1), favorite: z.boolean() }),
  z.object({ type: z.literal('source.relocate'), source_id: z.string().min(1), file_uri: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('project.set_name'), name: z.string().min(1).max(500) }),
  z.object({ type: z.literal('project.set_view'), goal: videoViewSchema }),
  z.object({ type: z.literal('project.set_canvas'), ratio: z.enum(['9:16', '1:1', '16:9']) }),
  z.object({ type: z.literal('project.set_audio_intent'), energy: z.enum(['calm', 'natural', 'lively', 'crisp']), music_enabled: z.boolean().optional() }),
  z.object({ type: z.literal('project.set_music'), music: videoMusicSchema }),
  z.object({ type: z.literal('project.set_brand'), brand: videoBrandSchema }),
])

export const videoCreateProjectRequestSchema = z.object({
  name: z.string().max(500).optional(),
  video_paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
  goal: videoViewSchema.optional(),
  user_request: z.string().max(6000).optional(),
  content_type: videoContentTypeSchema.optional(),
  ratio: z.enum(['9:16', '1:1', '16:9']).default('9:16'),
  target_duration_ms: z.number().int().min(3_000).max(1_800_000).optional(),
  source_roles: z.record(z.string(), videoSourceRoleSchema).optional(),
  conversation_id: z.string().max(200).optional(),
  working_dir: z.string().max(4096).optional(),
})

export const videoBriefCompileRequestSchema = z.object({
  base_revision: z.number().int().min(0).optional(),
  user_request: z.string().min(1).max(6000),
  content_type: videoContentTypeSchema.optional(),
  story_goal: videoStoryGoalSchema.optional(),
  output_channel: videoOutputChannelSchema.optional(),
  preferred_view: videoViewSchema.optional(),
  ratio: z.enum(['9:16', '1:1', '16:9']).optional(),
  target_duration_ms: z.number().int().min(3_000).max(1_800_000).optional(),
  exact_copy: z.array(z.string().min(1).max(500)).max(50).optional(),
  must_preserve: z.array(z.string().min(1).max(500)).max(50).optional(),
  must_avoid: z.array(z.string().min(1).max(500)).max(50).optional(),
  source_roles: z.record(z.string(), videoSourceRoleSchema).optional(),
  /** 调用方当前工作区(门店文件夹),存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
})

export const videoBriefCompileResponseSchema = z.object({
  brief: videoCreativeBriefSchema,
  recommendation_reason: z.string().min(1).max(1000),
  missing_facts: z.array(z.string().max(500)).max(30).default([]),
  missing_coverage: z.array(z.string().max(200)).max(30).default([]),
})

export const videoOpsRequestSchema = z.object({
  base_revision: z.number().int().min(0),
  operations: z.array(videoOperationSchema).min(1).max(100),
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
})

export const videoOpsResponseSchema = z.object({
  project: videoProjectSchema,
  affected_scene_ids: z.array(z.string()).default([]),
  operation_id: z.string().min(1),
})

export const videoAnalyzeRequestSchema = z.object({
  source_ids: z.array(z.string().min(1).max(160)).max(200).optional(),
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
})

export const videoAlternativeApplyRequestSchema = z.object({
  base_revision: z.number().int().min(0),
  scope: z.enum(['whole', 'scene']),
  scene_id: z.string().min(1).optional(),
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
}).superRefine((value, ctx) => {
  if (value.scope === 'scene' && !value.scene_id) ctx.addIssue({ code: 'custom', message: 'scene scope requires scene_id' })
})

export const videoRenderRequestSchema = z.object({
  revision: z.number().int().min(0).optional(),
  preview: z.boolean().default(false),
  scene_id: z.string().min(1).max(160).optional(),
  include_subtitles: z.boolean().default(true),
  include_music: z.boolean().default(true),
  /** 调用方当前工作区,存在时校验目标项目确实属于这个工作区,防跨门店误改。 */
  working_dir: z.string().max(4096).optional(),
})

export const videoJobKindSchema = z.enum(['probe', 'analyze', 'drafts', 'render'])
export const videoJobStatusSchema = z.enum([
  'queued',
  'preparing',
  'analyzing',
  'planning',
  'rendering',
  'blocked',
  'cancelled',
  'interrupted',
  'error',
  'done',
  'done_with_warnings',
])

export const videoJobSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  kind: videoJobKindSchema,
  status: videoJobStatusSchema,
  progress: z.number().min(0).max(100),
  stage: z.string().max(500).default(''),
  checkpoint: z.record(z.string(), z.unknown()).default({}),
  retry_of: z.string().optional(),
  retryable: z.boolean().default(false),
  affected_source_ids: z.array(z.string()).default([]),
  warnings: z.array(z.string().max(1000)).default([]),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export const videoJobStartResponseSchema = z.object({ job_id: z.string().min(1), project_id: z.string().min(1) })
export const videoProjectResponseSchema = z.object({ project: videoProjectSchema })
export const videoProjectListResponseSchema = z.object({ projects: z.array(videoProjectSchema) })
export const videoCreateProjectResponseSchema = z.object({
  project: videoProjectSchema,
  analysis_job: videoJobStartResponseSchema,
})
export const videoJobResponseSchema = z.object({ job: videoJobSchema })
export const videoMutationResponseSchema = z.object({ project: videoProjectSchema })
export const videoAlternativeApplyResponseSchema = videoMutationResponseSchema
export const videoPlanStartResponseSchema = z.object({
  project: videoProjectSchema,
  brief: videoBriefCompileResponseSchema,
  job: videoJobStartResponseSchema,
})

export const videoErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().default(false),
    current_revision: z.number().int().min(0).optional(),
    replayable_operations: z.array(videoOperationSchema).optional(),
  }),
})

export const legacyTimelineV1Schema = z.object({
  version: z.literal(1).or(z.number().int()),
  fps: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  media: z.record(z.string(), z.object({
    src: z.string(),
    duration: z.number().optional(),
    kind: z.string().optional(),
    has_audio: z.boolean().optional(),
  }).passthrough()).default({}),
  tracks: z.record(z.string(), z.object({ kind: z.string(), order: z.number().optional() }).passthrough()).default({}),
  clips: z.record(z.string(), z.object({
    track: z.string(),
    order: z.number().optional(),
    media: z.string().nullable().optional(),
    src_in: z.number().optional(),
    src_out: z.number().optional(),
    text: z.string().nullable().optional(),
    start: z.number().nullable().optional(),
    end: z.number().nullable().optional(),
  }).passthrough()).default({}),
  music: z.string().nullable().optional(),
}).passthrough()

export type VideoContentType = z.infer<typeof videoContentTypeSchema>
export type VideoSourceRole = z.infer<typeof videoSourceRoleSchema>
export type VideoCreativeBrief = z.infer<typeof videoCreativeBriefSchema>
export type VideoSource = z.infer<typeof videoSourceSchema>
export type VideoSourceRange = z.infer<typeof videoSourceRangeSchema>
export type VideoEvidenceRef = z.infer<typeof videoEvidenceRefSchema>
export type VideoShotEvidence = z.infer<typeof videoShotEvidenceSchema>
export type VideoVisualEvidence = z.infer<typeof videoVisualEvidenceSchema>
export type VideoAudioEvidence = z.infer<typeof videoAudioEvidenceSchema>
export type VideoMusicEvidence = z.infer<typeof videoMusicEvidenceSchema>
export type VideoSourceRoleEvidence = z.infer<typeof videoSourceRoleEvidenceSchema>
export type VideoAudioLayer = z.infer<typeof videoAudioLayerSchema>
export type VideoGraphic = z.infer<typeof videoGraphicSchema>
export type VideoReplacementCandidate = z.infer<typeof videoReplacementCandidateSchema>
export type VideoScene = z.infer<typeof videoSceneSchema>
export type VideoAlternative = z.infer<typeof videoAlternativeSchema>
export type VideoProject = z.infer<typeof videoProjectSchema>
export type VideoOperation = z.infer<typeof videoOperationSchema>
export type VideoCreateProjectInput = z.input<typeof videoCreateProjectRequestSchema>
export type VideoCreateProjectRequest = z.infer<typeof videoCreateProjectRequestSchema>
export type VideoBriefCompileInput = z.input<typeof videoBriefCompileRequestSchema>
export type VideoBriefCompileRequest = z.infer<typeof videoBriefCompileRequestSchema>
export type VideoOpsRequest = z.infer<typeof videoOpsRequestSchema>
export type VideoAnalyzeRequest = z.infer<typeof videoAnalyzeRequestSchema>
export type VideoRenderInput = z.input<typeof videoRenderRequestSchema>
export type VideoRenderRequest = z.infer<typeof videoRenderRequestSchema>
export type VideoJob = z.infer<typeof videoJobSchema>
export type VideoProjectListResponse = z.infer<typeof videoProjectListResponseSchema>
export type VideoCreateProjectResponse = z.infer<typeof videoCreateProjectResponseSchema>
export type VideoBriefCompileResponse = z.infer<typeof videoBriefCompileResponseSchema>
export type VideoJobStartResponse = z.infer<typeof videoJobStartResponseSchema>
