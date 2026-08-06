import {
  videoDeliveryFormatSchema,
  videoAudioPolicySchema,
  videoOutputPresetSchema,
} from '../../../shared/contracts/media.js'
import type {
  AnalyzeVideoProjectInput,
  CreateRemoteAnalysisConsentInput,
  DeliveryVariantCommand,
  EditorialTimelineCommand,
  TimelineDraft,
  VideoTimelineItem,
  VideoTimelineTrack,
  VideoCaptionCue,
} from '../../../shared/contracts/media.js'
import type { VideoCreativeDirection } from '../../../shared/contracts/media.js'
import type { VideoWorkbenchProjectCreateInput } from './contracts.js'
import type {
  VideoWorkbenchActionInput,
  VideoWorkbenchActionInputRequest,
} from './product.js'
import { videoMediaKindLabel } from './viewModel.js'

export type VideoWorkbenchFormOption = Readonly<{ value: string; label: string; disabled?: boolean }>

export type VideoWorkbenchFormField = Readonly<{
  name: string
  label: string
  kind: 'text' | 'textarea' | 'number' | 'select' | 'choices' | 'checkbox'
  required?: boolean
  defaultValue?: string | number | boolean | readonly string[]
  placeholder?: string
  min?: number
  max?: number
  step?: number
  options?: readonly VideoWorkbenchFormOption[]
  help?: string
}>

export type VideoWorkbenchFormSpec = Readonly<{
  title: string
  description?: string
  confirmLabel: string
  fields: readonly VideoWorkbenchFormField[]
  destructive?: boolean
}>

export type VideoWorkbenchFormValues = Readonly<Record<string, string | boolean | readonly string[] | undefined>>

export type VideoWorkbenchFormResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; message: string }>

const remotePurposes = [
  ['visual_evidence', '视觉证据'],
  ['planning', '剪辑规划'],
  ['caption_translation', '字幕翻译'],
  ['asr', '语音转写'],
  ['semantic_search', '语义检索'],
] as const

const remoteDataKinds = [
  ['audio_extract', '音频提取'],
  ['keyframes', '关键帧'],
  ['proxy_video', '低清代理视频'],
  ['transcript', '已有转写文本'],
] as const

const remotePurposeSet = new Set<CreateRemoteAnalysisConsentInput['purposes'][number]>(remotePurposes.map(([value]) => value))
const remoteDataKindSet = new Set<CreateRemoteAnalysisConsentInput['data_kinds'][number]>(remoteDataKinds.map(([value]) => value))

const audioPolicyChoices = [
  ['source_only', '只保留原声'],
  ['music_with_source', '原声 + 音乐'],
  ['music_only', '只使用音乐'],
  ['voice_over_with_source', '旁白 + 原声'],
  ['voice_over_only', '只使用旁白'],
  ['music_with_voice_over', '旁白 + 音乐'],
  ['source_music_with_voice_over', '原声 + 音乐 + 旁白'],
] as const

const creativeDirectionChoices = {
  narrative_voice: [
    ['plainspoken', '直白自然'],
    ['observational', '观察式'],
    ['intimate', '亲近克制'],
    ['confident', '自信有力'],
    ['playful', '轻松俏皮'],
    ['cinematic', '电影感'],
  ],
  emotional_arc: [
    ['clarity', '清楚明白'],
    ['curiosity', '引发好奇'],
    ['warmth', '温暖陪伴'],
    ['energy', '节奏有能量'],
    ['tension_release', '先紧后松'],
    ['none', '不设情绪弧'],
  ],
  audio_mode: [
    ['preserve_source', '保留原始声音'],
    ['source_plus_music', '原声加音乐'],
    ['music_only', '只用音乐'],
    ['narration_after_review', '旁白（先审核）'],
    ['silent', '静音'],
  ],
  voiceover_persona: [
    ['none', '不使用旁白'],
    ['calm_guide', '平静引导'],
    ['warm_friend', '温暖朋友'],
    ['confident_host', '自信主持'],
    ['playful_commentator', '俏皮解说'],
  ],
  caption_strategy: [
    ['spoken_rhythm', '跟随说话节奏'],
    ['minimal_emphasis', '少量重点强调'],
    ['kinetic_keywords', '关键词动效'],
    ['full_transcript', '完整转写'],
    ['none', '不加字幕'],
  ],
} as const

const creationBriefChoices = {
  use_case: [
    ['auto_highlight', '自动高光'],
    ['social_short', '社交短视频'],
    ['talking_head', '口播'],
    ['interview', '访谈'],
    ['tutorial', '教程'],
    ['product_demo', '产品演示'],
    ['event_recap', '活动回顾'],
    ['sports_highlight', '体育高光'],
    ['podcast_clip', '播客切片'],
    ['custom', '自定义'],
  ],
  distribution: [
    ['vertical_short', '竖屏短视频'],
    ['horizontal_video', '横屏视频'],
    ['square_social', '方形社交媒体'],
    ['presentation', '演示/汇报'],
    ['custom', '自定义'],
  ],
  tone: [
    ['clear', '清楚直接'],
    ['energetic', '有能量'],
    ['warm', '温暖'],
    ['professional', '专业'],
    ['cinematic', '电影感'],
    ['playful', '轻松俏皮'],
  ],
  pace: [
    ['calm', '舒缓'],
    ['balanced', '均衡'],
    ['fast', '紧凑'],
  ],
  caption_preference: [
    ['auto', '自动判断'],
    ['burn_in', '烧录字幕'],
    ['sidecar', '外挂字幕文件'],
    ['none', '不加字幕'],
  ],
  hook_strategy: [
    ['auto', '自动选择'],
    ['strongest_moment', '最精彩片段开场'],
    ['chronological', '按时间顺序'],
    ['custom', '自定义'],
  ],
  story_structure: [
    ['auto', '自动安排'],
    ['chronological', '时间顺序'],
    ['hook_value_payoff', '钩子-价值-回收'],
    ['problem_solution', '问题-解决'],
    ['how_to', '步骤教程'],
    ['highlight_reel', '高光集锦'],
  ],
  selection_focus: [
    ['auto', '自动判断'],
    ['speech', '说话内容'],
    ['action', '动作/事件'],
    ['visual', '画面变化'],
    ['people', '人物'],
    ['product', '产品/物件'],
  ],
  coverage_preference: [
    ['highlights', '只保留重点'],
    ['balanced', '重点与过程平衡'],
    ['complete_when_feasible', '条件允许时完整保留'],
  ],
  editing_strategy: [
    ['manual', '按人工范围'],
    ['speech_story', '按说话内容组织'],
    ['highlights', '按高光组织'],
    ['beat_sync', '按节拍组织'],
    ['mixed', '综合判断'],
  ],
} as const

const creativeDirectionDefaults: VideoCreativeDirection = {
  narrative_voice: 'plainspoken',
  emotional_arc: 'clarity',
  audio_mode: 'preserve_source',
  voiceover_persona: 'none',
  caption_strategy: 'spoken_rhythm',
  keep_natural_pauses: true,
  human_notes: '',
}

function currentCreativeDirection(request: VideoWorkbenchActionInputRequest): VideoCreativeDirection {
  return { ...creativeDirectionDefaults, ...request.project.creation_brief?.creative_direction }
}

function creativeChoice(
  values: VideoWorkbenchFormValues,
  name: keyof typeof creativeDirectionChoices,
  fallback: string,
): string | undefined {
  if (values[name] === undefined) return fallback
  const candidate = value(values, name)
  return candidate && creativeDirectionChoices[name].some(([option]) => option === candidate) ? candidate : undefined
}

function creativeDirectionInput(
  request: VideoWorkbenchActionInputRequest,
  values: VideoWorkbenchFormValues,
): VideoWorkbenchFormResult<VideoCreativeDirection | undefined> {
  const current = currentCreativeDirection(request)
  const narrativeVoice = creativeChoice(values, 'narrative_voice', current.narrative_voice)
  const emotionalArc = creativeChoice(values, 'emotional_arc', current.emotional_arc)
  const audioMode = creativeChoice(values, 'audio_mode', current.audio_mode)
  const voiceoverPersona = creativeChoice(values, 'voiceover_persona', current.voiceover_persona)
  const captionStrategy = creativeChoice(values, 'caption_strategy', current.caption_strategy)
  if (!narrativeVoice || !emotionalArc || !audioMode || !voiceoverPersona || !captionStrategy) return inputError('创作方向选项无效，请重新选择。')
  const keepNaturalPauses = values.keep_natural_pauses === undefined ? current.keep_natural_pauses : checked(values, 'keep_natural_pauses')
  const humanNotes = values.human_notes === undefined ? current.human_notes : (value(values, 'human_notes') ?? '')
  const hasInput = ['narrative_voice', 'emotional_arc', 'audio_mode', 'voiceover_persona', 'caption_strategy', 'keep_natural_pauses', 'human_notes']
    .some(name => values[name] !== undefined)
  return {
    ok: true,
    value: hasInput || request.project.creation_brief?.creative_direction
      ? { narrative_voice: narrativeVoice as VideoCreativeDirection['narrative_voice'], emotional_arc: emotionalArc as VideoCreativeDirection['emotional_arc'], audio_mode: audioMode as VideoCreativeDirection['audio_mode'], voiceover_persona: voiceoverPersona as VideoCreativeDirection['voiceover_persona'], caption_strategy: captionStrategy as VideoCreativeDirection['caption_strategy'], keep_natural_pauses: keepNaturalPauses, human_notes: humanNotes }
      : undefined,
  }
}

function value(values: VideoWorkbenchFormValues, name: string): string | undefined {
  const candidate = values[name]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

function numeric(values: VideoWorkbenchFormValues, name: string): number | undefined {
  const raw = value(values, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function checked(values: VideoWorkbenchFormValues, name: string): boolean {
  return values[name] === true
}

function selected(values: VideoWorkbenchFormValues, name: string): readonly string[] {
  const candidate = values[name]
  if (Array.isArray(candidate)) return candidate.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
  const single = typeof candidate === 'string' && candidate.trim() ? [candidate.trim()] : []
  return single
}

function selectedSource(request: VideoWorkbenchActionInputRequest): string | undefined {
  return request.selection.source_id
    ?? (request.snapshot.project.sources.length === 1 ? request.snapshot.project.sources[0]?.id : undefined)
}

function selectedVariant(request: VideoWorkbenchActionInputRequest) {
  return request.snapshot.variants.find(item => item.variant.id === request.selection.variant_id)
    ?? (request.snapshot.variants.length === 1 ? request.snapshot.variants[0] : undefined)
}

function sourceOptions(request: VideoWorkbenchActionInputRequest): readonly VideoWorkbenchFormOption[] {
  return request.snapshot.project.sources.map(source => ({
    value: source.id,
    label: `${source.name} (${Math.round(source.duration_ms / 1000)} 秒)`,
    disabled: source.missing || source.content_changed,
  }))
}

function currentCaptionRevision(request: VideoWorkbenchActionInputRequest) {
  const document = request.snapshot.caption_documents[request.snapshot.caption_documents.length - 1]
  const revision = document
    ? request.snapshot.caption_revisions.find(candidate => candidate.id === document.current_revision_id)
    : undefined
  return document && revision ? { document, revision } : undefined
}

function currentTimeline(request: VideoWorkbenchActionInputRequest) {
  return request.snapshot.current_timeline
}

function rationalTime(ticks: number, tickRate: { num: number; den: number }) {
  return { ticks: String(Math.round(ticks)), tick_rate: tickRate }
}

function videoTimeToMilliseconds(time: { ticks: string; tick_rate: { num: number; den: number } }): number {
  const ticks = Number(time.ticks)
  if (!Number.isFinite(ticks) || time.tick_rate.num <= 0 || time.tick_rate.den <= 0) return 0
  return (ticks * time.tick_rate.den * 1000) / time.tick_rate.num
}

function choiceOptions(values: readonly (readonly [string, string])[]): readonly VideoWorkbenchFormOption[] {
  return values.map(([value, label]) => ({ value, label }))
}

function optionalChoice(
  values: VideoWorkbenchFormValues,
  name: string,
  choices: readonly (readonly [string, string])[],
): string | null | undefined {
  if (values[name] === undefined) return undefined
  const candidate = value(values, name)
  return candidate && choices.some(([option]) => option === candidate) ? candidate : null
}

function commaSeparatedValues(values: VideoWorkbenchFormValues, name: string): readonly string[] | undefined {
  if (values[name] === undefined) return undefined
  const candidate = typeof values[name] === 'string' ? values[name] : ''
  return [...new Set(candidate.split(/[\n,，、]/).map(item => item.trim()).filter(Boolean))]
}

function targetDurationSeconds(request: VideoWorkbenchActionInputRequest): number | undefined {
  const target = request.project.delivery_intent?.target_duration
  if (!target) return undefined
  const milliseconds = videoTimeToMilliseconds(target)
  return milliseconds > 0 ? Math.round(milliseconds / 100) / 10 : undefined
}

function inputError(message: string): VideoWorkbenchFormResult<never> {
  return { ok: false, message }
}

function timelineItemOptions(
  timeline: NonNullable<ReturnType<typeof currentTimeline>>,
  predicate: (item: VideoTimelineItem) => boolean = () => true,
): readonly VideoWorkbenchFormOption[] {
  return timeline.items.map((item, index) => {
    const trackIndex = timeline.tracks.findIndex(track => track.id === item.track_id)
    const track = timeline.tracks[trackIndex]
    return {
      value: item.id,
      label: `${videoMediaKindLabel(item.kind)} ${index + 1} · ${track ? `${videoMediaKindLabel(track.kind)}轨道 ${trackIndex + 1}` : '未关联轨道'}${item.locked || track?.locked ? ' · 已锁定' : ''}`,
      disabled: !predicate(item) || item.locked || track?.locked,
    }
  })
}

function compatibleTrackOptions(
  timeline: NonNullable<ReturnType<typeof currentTimeline>>,
  item: VideoTimelineItem | undefined,
): readonly VideoWorkbenchFormOption[] {
  return timeline.tracks.map((track, index) => ({
    value: track.id,
    label: `${videoMediaKindLabel(track.kind)}轨道 ${index + 1}${track.locked ? ' · 已锁定' : ''}`,
    disabled: Boolean(track.locked || !trackAcceptsItem(track, item)),
  }))
}

function trackAcceptsItem(track: VideoTimelineTrack, item: VideoTimelineItem | undefined): boolean {
  if (!item) return false
  if (item.kind === 'video') return track.kind === 'primary_video' || track.kind === 'b_roll'
  if (item.kind === 'audio') return track.kind === 'source_audio' || track.kind === 'music' || track.kind === 'voice_over'
  if (item.kind === 'caption') return track.kind === 'caption'
  if (item.kind === 'overlay') return track.kind === 'overlay'
  return false
}

function timelineItemSourceRange(item: VideoTimelineItem): { start: number; end: number } | undefined {
  if (item.binding.kind !== 'source') return undefined
  const start = videoTimeToMilliseconds(item.binding.source_range.start)
  return { start, end: start + videoTimeToMilliseconds(item.binding.source_range.duration) }
}

function timelineItemRange(item: VideoTimelineItem): { start: number; end: number } {
  const start = videoTimeToMilliseconds(item.timeline_range.start)
  return { start, end: start + videoTimeToMilliseconds(item.timeline_range.duration) }
}

function rationalMilliseconds(milliseconds: number, tickRate = { num: 1_000, den: 1 }) {
  return rationalTime(milliseconds, tickRate)
}

function proposedDraftItemOptions(
  request: VideoWorkbenchActionInputRequest,
  predicate: (item: VideoTimelineItem) => boolean = () => true,
): readonly VideoWorkbenchFormOption[] {
  const existingIds = new Set(request.snapshot.current_timeline?.items.map(item => item.id) ?? [])
  return request.snapshot.timeline_drafts
    .filter(draft => draft.status === 'proposed')
    .flatMap((draft: TimelineDraft, draftIndex) => draft.items
      .filter(item => !existingIds.has(item.id) && predicate(item))
      .map((item, itemIndex) => ({
        value: item.id,
        label: `${videoMediaKindLabel(item.kind)} · 草稿 ${draftIndex + 1} 条目 ${itemIndex + 1}${item.binding.kind === 'source' ? ` · ${item.binding.source_id}` : ''}`,
      })))
}

function selectedTimelineItem(
  request: VideoWorkbenchActionInputRequest,
  timeline: NonNullable<ReturnType<typeof currentTimeline>>,
): VideoTimelineItem | undefined {
  return timeline.items.find(item => request.selection.timeline_item_ids.includes(item.id)) ?? timeline.items[0]
}

function selectedTimelineItemSourceRange(
  request: VideoWorkbenchActionInputRequest,
  timeline: NonNullable<ReturnType<typeof currentTimeline>>,
): { start: number; end: number } | undefined {
  const item = selectedTimelineItem(request, timeline)
  return item ? timelineItemSourceRange(item) : undefined
}

function selectedTimelineItemRange(
  request: VideoWorkbenchActionInputRequest,
  timeline: NonNullable<ReturnType<typeof currentTimeline>>,
): { start: number; end: number } | undefined {
  const item = selectedTimelineItem(request, timeline)
  return item ? timelineItemRange(item) : undefined
}

function selectedTimelineItemMidpoint(
  request: VideoWorkbenchActionInputRequest,
  timeline: NonNullable<ReturnType<typeof currentTimeline>>,
): number | undefined {
  const range = selectedTimelineItemRange(request, timeline)
  return range ? Math.round((range.start + range.end) / 2) : undefined
}

function indexedLabel(label: string, index: number, detail?: string): string {
  return `${label} ${index + 1}${detail ? ` · ${detail}` : ''}`
}

export function createProjectForm(): VideoWorkbenchFormSpec {
  return {
    title: '新建视频项目',
    description: '项目名称只用于工作台显示；输出规格决定默认画幅，之后仍可在交付变体中选择字幕、音频和编码 Profile。',
    confirmLabel: '创建项目',
    fields: [
      { name: 'title', label: '项目名称', kind: 'text', required: true, placeholder: '例如：8 月赛事集锦' },
      {
        name: 'output_preset',
        label: '默认输出规格',
        kind: 'select',
        options: [
          { value: 'vertical_1080', label: '竖屏 1080p（1080×1920）' },
          { value: 'horizontal_1080', label: '横屏 1080p（1920×1080）' },
          { value: 'vertical_4k', label: '竖屏 UHD 4K（2160×3840）' },
          { value: 'horizontal_4k', label: '横屏 UHD 4K（3840×2160）' },
        ],
        defaultValue: 'vertical_1080',
        help: '这是默认 Profile；字幕模式、音频策略和后续交付变体仍可单独选择。',
      },
      {
        name: 'delivery_format',
        label: '导出格式',
        kind: 'select',
        options: [
          { value: 'mp4_h264_aac', label: 'MP4 · H.264 + AAC（通用推荐）' },
          { value: 'mov_prores_422_pcm', label: 'MOV · ProRes 422 + PCM（专业母版）' },
          { value: 'mov_prores_422_hq_pcm', label: 'MOV · ProRes 422 HQ + PCM（高质量母版）' },
        ],
        defaultValue: 'mp4_h264_aac',
        help: '素材原始容器和编码由系统探测；这里选择最终交付文件的容器与编码。',
      },
    ],
  }
}

export function createProjectInput(values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchProjectCreateInput> {
  const title = value(values, 'title')
  if (!title) return inputError('请填写项目名称。')
  const preset = value(values, 'output_preset')
  const deliveryFormat = value(values, 'delivery_format')
  const parsedPreset = preset ? videoOutputPresetSchema.safeParse(preset) : undefined
  if (parsedPreset && !parsedPreset.success) return inputError('请选择有效的输出规格。')
  const parsedFormat = deliveryFormat ? videoDeliveryFormatSchema.safeParse(deliveryFormat) : undefined
  if (parsedFormat && !parsedFormat.success) return inputError('请选择有效的导出格式。')
  return {
    ok: true,
    value: {
      title,
      ...(parsedPreset?.success ? { output_preset: parsedPreset.data } : {}),
      ...(parsedFormat?.success ? { delivery_format: parsedFormat.data } : {}),
    },
  }
}

/** Declares fields only. The dialog host remains ephemeral and the snapshot
 * remains authoritative while a form is visible. */
export function createVideoWorkbenchActionForm(request: VideoWorkbenchActionInputRequest): VideoWorkbenchFormSpec | undefined {
  const timeline = currentTimeline(request)
  const sourceId = selectedSource(request)
  const variant = selectedVariant(request)
  switch (request.action) {
    case 'estimate_budget': {
      const source = request.snapshot.project.sources.find(candidate => candidate.id === sourceId)
      return {
        title: '远程分析范围与预算',
        description: '仅在先完成估算、再明确确认后，才会向远端发送所选范围。取消或关闭不会产生远端调用。',
        confirmLabel: '估算预算',
        fields: [
          { name: 'source_id', label: '素材', kind: 'select', required: true, options: sourceOptions(request), defaultValue: source?.id },
          { name: 'start_ms', label: '起始时间（毫秒）', kind: 'number', required: true, defaultValue: 0, min: 0, step: 1 },
          { name: 'end_ms', label: '结束时间（毫秒）', kind: 'number', required: true, defaultValue: source?.duration_ms ?? 0, min: 1, step: 1 },
          { name: 'purposes', label: '远程用途', kind: 'choices', required: true, options: choiceOptions(remotePurposes), defaultValue: ['asr'] },
          { name: 'data_kinds', label: '发送的数据', kind: 'choices', required: true, options: choiceOptions(remoteDataKinds), defaultValue: ['audio_extract'] },
        ],
      }
    }
    case 'create_quick_draft': {
      const brief = request.project.creation_brief
      const intent = request.project.delivery_intent
      const direction = currentCreativeDirection(request)
      return {
        title: '让 AI 先给出剪辑建议',
        description: brief
          ? `当前已确认目标：${brief.user_request}。可以调整用途、平台、时长和取材重点；AI 只会提出可检查的草稿，逐项确认后才写入正式时间线。`
          : '先说明你想做什么，再选择用途、平台、时长和声音/字幕方向；AI 只会基于当前素材事实提出可检查的草稿，逐项确认后才会写入正式时间线。',
        confirmLabel: '生成建议草稿',
        fields: [
          { name: 'user_goal', label: '你想做成什么视频', kind: 'textarea', required: true, defaultValue: brief?.user_request, placeholder: '例如：做一条 30 秒的产品介绍，开头直接进入重点，保留关键演示并配中文字幕。' },
          { name: 'use_case', label: '视频用途', kind: 'select', required: true, defaultValue: brief?.use_case ?? 'custom', options: choiceOptions(creationBriefChoices.use_case) },
          { name: 'audience', label: '给谁看', kind: 'text', required: true, defaultValue: brief?.audience ?? '大众观众', placeholder: '例如：第一次看台球视频的观众' },
          { name: 'distribution', label: '发布平台/画幅', kind: 'select', required: true, defaultValue: brief?.distribution ?? 'vertical_short', options: choiceOptions(creationBriefChoices.distribution) },
          { name: 'target_duration_seconds', label: '目标时长（秒）', kind: 'number', min: 1, max: 3_600, step: 0.1, defaultValue: targetDurationSeconds(request), help: '留空则按视频用途使用保守默认时长；这是规划约束，不会直接截断素材。' },
          { name: 'coverage_preference', label: '保留程度', kind: 'select', defaultValue: intent?.coverage_preference ?? 'highlights', options: choiceOptions(creationBriefChoices.coverage_preference) },
          { name: 'editing_strategy', label: '组织方式', kind: 'select', defaultValue: intent?.editing_strategy ?? 'mixed', options: choiceOptions(creationBriefChoices.editing_strategy) },
          { name: 'tone', label: '整体语气', kind: 'select', defaultValue: brief?.tone ?? 'clear', options: choiceOptions(creationBriefChoices.tone) },
          { name: 'pace', label: '节奏', kind: 'select', defaultValue: brief?.pace ?? 'balanced', options: choiceOptions(creationBriefChoices.pace) },
          { name: 'caption_preference', label: '字幕方式', kind: 'select', defaultValue: brief?.caption_preference ?? 'auto', options: choiceOptions(creationBriefChoices.caption_preference) },
          { name: 'hook_strategy', label: '开场方式', kind: 'select', defaultValue: brief?.hook_strategy ?? 'auto', options: choiceOptions(creationBriefChoices.hook_strategy) },
          { name: 'story_structure', label: '叙事结构', kind: 'select', defaultValue: brief?.story_structure ?? 'auto', options: choiceOptions(creationBriefChoices.story_structure) },
          { name: 'selection_focus', label: '优先找什么', kind: 'select', defaultValue: brief?.selection_focus ?? 'auto', options: choiceOptions(creationBriefChoices.selection_focus) },
          { name: 'must_preserve', label: '必须保留', kind: 'textarea', defaultValue: brief?.must_preserve.join('、'), placeholder: '可填写多个重点，用逗号或换行分隔' },
          { name: 'narrative_voice', label: '叙事语气', kind: 'select', required: true, defaultValue: direction.narrative_voice, options: choiceOptions(creativeDirectionChoices.narrative_voice) },
          { name: 'emotional_arc', label: '情绪走向', kind: 'select', required: true, defaultValue: direction.emotional_arc, options: choiceOptions(creativeDirectionChoices.emotional_arc) },
          { name: 'audio_mode', label: '声音策略', kind: 'select', required: true, defaultValue: direction.audio_mode, options: choiceOptions(creativeDirectionChoices.audio_mode), help: '默认保留原始声音；选择旁白只表示先进入审核，不会自动生成或覆盖原声。' },
          { name: 'voiceover_persona', label: '旁白人格', kind: 'select', required: true, defaultValue: direction.voiceover_persona, options: choiceOptions(creativeDirectionChoices.voiceover_persona), help: '只有明确选择旁白并完成脚本、声音和费用审核后，才允许进入执行。' },
          { name: 'caption_strategy', label: '字幕节奏', kind: 'select', required: true, defaultValue: direction.caption_strategy, options: choiceOptions(creativeDirectionChoices.caption_strategy) },
          { name: 'keep_natural_pauses', label: '保留自然停顿', kind: 'checkbox', defaultValue: direction.keep_natural_pauses },
          { name: 'human_notes', label: '补充创作备注', kind: 'textarea', defaultValue: direction.human_notes, placeholder: '例如：保留现场击球声，不要用模板化口播盖住原声。' },
        ],
      }
    }
    case 'open_editor':
      return timeline ? {
        title: '编辑时间线',
        description: '本次操作会生成一个新的正式 Timeline Version。可以删除、修剪、切分、移动、插入或替换条目；锁定条目和锁定轨道会被客户端和服务端共同拒绝。',
        confirmLabel: '应用 CommandSet',
        fields: [
          {
            name: 'editorial_kind',
            label: '编辑动作',
            kind: 'select',
            required: true,
            defaultValue: 'ripple_delete',
            options: [
              { value: 'ripple_delete', label: '删除所选条目并关闭空隙' },
              { value: 'trim', label: '修剪素材范围' },
              { value: 'split', label: '在时间线上切分' },
              { value: 'reorder', label: '移动到其他轨道或时间位置' },
              { value: 'insert', label: '插入已确认草稿片段' },
              { value: 'replace', label: '替换为已确认草稿片段' },
              { value: 'lock', label: '锁定或解锁所选条目' },
              { value: 'set_track_state', label: '设置轨道锁定或静音' },
            ],
          },
          {
            name: 'item_ids',
            label: '时间线条目',
            kind: 'choices',
            options: timelineItemOptions(timeline),
            defaultValue: request.selection.timeline_item_ids,
            help: '删除或锁定动作需要至少选择一个未锁定条目。',
          },
          {
            name: 'edit_item_id',
            label: '编辑条目',
            kind: 'select',
            options: timelineItemOptions(timeline, item => item.binding.kind === 'source'),
            defaultValue: selectedTimelineItem(request, timeline)?.id,
            help: '修剪、切分、移动和替换只允许选择有明确素材绑定的条目。',
          },
          { name: 'source_start_ms', label: '素材起点（毫秒）', kind: 'number', min: 0, step: 1, defaultValue: selectedTimelineItemSourceRange(request, timeline)?.start },
          { name: 'source_end_ms', label: '素材终点（毫秒）', kind: 'number', min: 1, step: 1, defaultValue: selectedTimelineItemSourceRange(request, timeline)?.end },
          { name: 'timeline_start_ms', label: '时间线起点（毫秒）', kind: 'number', min: 0, step: 1, defaultValue: selectedTimelineItemRange(request, timeline)?.start },
          { name: 'timeline_end_ms', label: '时间线终点（毫秒）', kind: 'number', min: 1, step: 1, defaultValue: selectedTimelineItemRange(request, timeline)?.end },
          { name: 'split_at_ms', label: '切分位置（毫秒）', kind: 'number', min: 1, step: 1, defaultValue: selectedTimelineItemMidpoint(request, timeline) },
          {
            name: 'replacement_item_id',
            label: '草稿替换片段',
            kind: 'select',
            options: proposedDraftItemOptions(request, item => item.kind === selectedTimelineItem(request, timeline)?.kind),
            help: '替换会保留目标条目的时间线位置；草稿片段必须来自当前项目且尚未写入时间线。',
          },
          { name: 'lock_value', label: '设为锁定', kind: 'checkbox', defaultValue: true, help: '取消勾选表示解锁所选条目。' },
          {
            name: 'track_id',
            label: '轨道',
            kind: 'select',
            options: compatibleTrackOptions(timeline, selectedTimelineItem(request, timeline)),
            defaultValue: selectedTimelineItem(request, timeline)?.track_id,
            help: '移动或插入时只能选择与条目类型匹配、且未锁定的轨道。',
          },
          { name: 'insert_item_id', label: '草稿插入片段', kind: 'select', options: proposedDraftItemOptions(request), help: '插入只接受当前项目中尚未写入正式时间线的候选片段。' },
          { name: 'track_locked', label: '轨道锁定', kind: 'checkbox', defaultValue: false },
          { name: 'track_muted', label: '轨道静音', kind: 'checkbox', defaultValue: false },
        ],
      } : undefined
    case 'open_variant_editor':
      return variant ? {
        title: '完成与交付设置',
        description: '每次应用都会生成新的 Delivery Variant Version，预览和导出只使用冻结版本。',
        confirmLabel: '应用 CommandSet',
        fields: [
          {
            name: 'delivery_kind',
            label: '交付动作',
            kind: 'select',
            required: true,
            defaultValue: 'set_caption_revision',
            options: [
              { value: 'set_caption_revision', label: '选择字幕修订' },
              { value: 'set_composition_plan', label: '选择构图计划' },
              { value: 'set_audio_finishing_plan', label: '选择音频完成计划' },
              { value: 'set_audio_policy', label: '选择声音组合' },
              { value: 'set_export_profile', label: '选择导出规格' },
            ],
          },
          { name: 'caption_revision_id', label: '字幕修订', kind: 'select', options: request.snapshot.caption_revisions.map((revision, index) => ({ value: revision.id, label: indexedLabel(`${revision.language} 字幕修订`, index) })) },
          { name: 'composition_plan_id', label: '构图计划', kind: 'select', options: request.snapshot.composition_plans.map((plan, index) => ({ value: plan.id, label: indexedLabel('构图计划', index) })) },
          { name: 'audio_finishing_plan_id', label: '音频完成计划', kind: 'select', options: request.snapshot.audio_finishing_plans.map((plan, index) => ({ value: plan.id, label: indexedLabel('音频计划', index) })) },
          {
            name: 'audio_policy',
            label: '声音组合',
            kind: 'select',
            defaultValue: request.snapshot.project.export_profile_revisions.find(profile => profile.id === variant.version.export_profile_revision_id)?.audio_policy ?? 'source_only',
            options: choiceOptions(audioPolicyChoices),
            help: '这里选择实际输出保留哪些音轨。旁白必须先作为已确认的 voice_over 项目资产进入当前时间线；当前版本不伪造 TTS 音色。',
          },
          { name: 'export_profile_revision_id', label: '导出规格', kind: 'select', options: request.snapshot.project.export_profile_revisions.map(profile => ({ value: profile.id, label: `${profile.target} · ${profile.width}x${profile.height}` })) },
        ],
      } : undefined
    case 'create_variant':
      return timeline ? {
        title: '新建交付变体',
        description: '同一时间线可以生成不同平台或后期用途的正式版本；每个变体会冻结自己的画幅、分辨率和编码 Profile。',
        confirmLabel: '创建变体',
        fields: [
          { name: 'name', label: '变体名称', kind: 'text', required: true, placeholder: '例如：竖版短视频' },
          {
            name: 'output_preset',
            label: '输出规格',
            kind: 'select',
            required: true,
            defaultValue: request.project.output.width > request.project.output.height ? 'horizontal_1080' : 'vertical_1080',
            options: [
              { value: 'vertical_1080', label: '竖屏 1080p（1080×1920）' },
              { value: 'horizontal_1080', label: '横屏 1080p（1920×1080）' },
              { value: 'vertical_4k', label: '竖屏 UHD 4K（2160×3840）' },
              { value: 'horizontal_4k', label: '横屏 UHD 4K（3840×2160）' },
            ],
          },
          {
            name: 'delivery_format',
            label: '导出格式',
            kind: 'select',
            required: true,
            defaultValue: request.project.delivery_format,
            options: [
              { value: 'mp4_h264_aac', label: 'MP4 · H.264 + AAC（通用推荐）' },
              { value: 'mov_prores_422_pcm', label: 'MOV · ProRes 422 + PCM（专业母版）' },
              { value: 'mov_prores_422_hq_pcm', label: 'MOV · ProRes 422 HQ + PCM（高质量母版）' },
            ],
          },
        ],
      } : undefined
    case 'create_caption':
      return timeline ? {
        title: '生成字幕草稿',
        confirmLabel: '生成字幕',
        fields: [
          { name: 'language', label: '字幕语言', kind: 'text', required: true, defaultValue: 'zh', placeholder: 'zh' },
          { name: 'font_size', label: '字号', kind: 'number', defaultValue: 48, min: 12, max: 128, step: 1 },
        ],
      } : undefined
    case 'create_caption_revision': {
      const caption = currentCaptionRevision(request)
      return caption && timeline ? {
        title: '编辑字幕修订',
        description: '锚点和时间范围来自不可变的当前字幕修订；这里只允许修改文本和语言。',
        confirmLabel: '保存字幕修订',
        fields: [
          { name: 'language', label: '字幕语言', kind: 'text', required: true, defaultValue: caption.revision.language },
          ...caption.revision.cues.map(cue => ({ name: `cue:${cue.id}`, label: `${Math.round(videoTimeToMilliseconds(cue.timeline_range.start))} ms`, kind: 'textarea' as const, required: true, defaultValue: cue.text })),
        ],
      } : undefined
    }
    case 'create_caption_translation':
      return currentCaptionRevision(request) && timeline ? {
        title: '翻译字幕',
        description: '翻译请求仍受已确认范围、预算和远端授权约束。',
        confirmLabel: '创建翻译任务',
        fields: [{ name: 'language', label: '目标语言', kind: 'text', required: true, defaultValue: 'en', placeholder: 'en' }],
      } : undefined
    case 'create_composition_plan':
      return variant ? { title: '生成构图计划', confirmLabel: '生成计划', fields: [] } : undefined
    case 'create_audio_finishing_plan':
      return variant ? { title: '生成音频完成计划', confirmLabel: '生成计划', fields: [] } : undefined
    case 'analyze_beat':
      return {
        title: '分析节拍',
        confirmLabel: '开始分析',
        fields: [{ name: 'source_id', label: '素材', kind: 'select', required: true, options: sourceOptions(request), defaultValue: sourceId }],
      }
    case 'create_beat_sync_draft':
      return sourceId && timeline ? {
        title: '创建节拍同步草稿',
        confirmLabel: '创建草稿',
        fields: [{ name: 'beat_evidence_id', label: '节拍证据', kind: 'select', required: true, options: request.snapshot.facts.items.filter(item => item.source_id === sourceId).map((item, index) => ({ value: item.id, label: indexedLabel(videoMediaKindLabel(item.kind), index, item.state) })) }],
      } : undefined
    case 'analyze_subject_track':
      return {
        title: '分析主体轨迹',
        confirmLabel: '开始分析',
        fields: [
          { name: 'source_id', label: '素材', kind: 'select', required: true, options: sourceOptions(request), defaultValue: sourceId },
          { name: 'subject_id', label: '主体名称或编号', kind: 'text', required: true, placeholder: '例如：选手 A' },
        ],
      }
    case 'create_review_note':
      return timeline ? {
        title: '新增版本化反馈',
        description: '反馈会固定关联到当前不可变 Timeline Version。后续处理只能追加新的处理事件，不能改写原反馈。',
        confirmLabel: '保存反馈',
        fields: [
          { name: 'actor_id', label: '反馈人', kind: 'text', required: true, defaultValue: 'local_creator' },
          { name: 'start_ms', label: '起始时间（毫秒）', kind: 'number', required: true, defaultValue: 0, min: 0, step: 1 },
          { name: 'end_ms', label: '结束时间（毫秒）', kind: 'number', required: true, defaultValue: 1_000, min: 1, step: 1 },
          { name: 'body', label: '反馈内容', kind: 'textarea', required: true, placeholder: '说明需要调整的内容和依据。' },
        ],
      } : undefined
    case 'resolve_review_note': {
      const review = request.snapshot.project.review_notes.find(note => note.id === request.target_id)
      return review?.status === 'open' ? {
        title: '处理版本化反馈',
        description: '已处理必须关联一个新的不可变 Timeline Version；驳回不会伪造替代版本。',
        confirmLabel: '追加处理事件',
        fields: [
          { name: 'actor_id', label: '处理人', kind: 'text', required: true, defaultValue: 'local_creator' },
          {
            name: 'state',
            label: '处理结果',
            kind: 'select',
            required: true,
            defaultValue: 'dismissed',
            options: [
              { value: 'addressed', label: '已处理（关联当前新版本）', disabled: timeline?.id === review.timeline_version_id },
              { value: 'dismissed', label: '驳回（保留原反馈）' },
            ],
          },
        ],
      } : undefined
    }
    case 'create_approval_decision':
      return timeline ? {
        title: '提交审批决定',
        description: '审批决定会追加到当前 Timeline Version；要求修改时必须明确关联尚未处理的反馈。',
        confirmLabel: '保存审批决定',
        fields: [
          { name: 'actor_id', label: '审批人', kind: 'text', required: true, defaultValue: 'local_creator' },
          {
            name: 'state',
            label: '审批决定',
            kind: 'select',
            required: true,
            defaultValue: 'approved',
            options: [
              { value: 'approved', label: '通过' },
              { value: 'changes_requested', label: '要求修改' },
            ],
          },
          {
            name: 'note_ids',
            label: '关联反馈',
            kind: 'choices',
            options: request.snapshot.project.review_notes
              .filter(note => note.timeline_version_id === timeline.id && note.status === 'open')
              .map(note => ({ value: note.id, label: `${note.body.slice(0, 72)} · ${note.actor_id}` })),
            help: '“要求修改”必须至少选择一条当前版本未处理的反馈。',
          },
        ],
      } : undefined
    case 'confirm_post_render_quality':
      return request.pending_quality ? {
        title: '确认后渲染质量报告',
        description: `将确认当前报告的 ${request.pending_quality.accepted_check_ids.length} 项人工决策，并发布与其绑定的输出。`,
        confirmLabel: '确认并发布',
        destructive: true,
        fields: [{ name: 'confirmed', label: '我已审阅全部待确认项', kind: 'checkbox', required: true }],
      } : undefined
  }
}

function selectedRemoteValues<Value extends string>(
  values: VideoWorkbenchFormValues,
  name: string,
  allowed: ReadonlySet<Value>,
): readonly Value[] | undefined {
  const entries = [...new Set(selected(values, name))]
  return entries.length && entries.every((item): item is Value => allowed.has(item as Value)) ? entries : undefined
}

function captionRevisionInput(request: VideoWorkbenchActionInputRequest, values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const caption = currentCaptionRevision(request)
  const timeline = currentTimeline(request)
  const language = value(values, 'language')
  if (!caption || !timeline || !language) return inputError('当前字幕修订已变化，请刷新后重新编辑。')
  const cues = caption.revision.cues.map(cue => {
    const text = value(values, `cue:${cue.id}`)
    if (!text) return undefined
    const { id: _id, ...inputCue } = cue
    return { ...inputCue, text }
  })
  if (cues.some(cue => !cue)) return inputError('每条字幕都必须保留文本。')
  return {
    ok: true,
    value: {
      action: 'create_caption_revision',
      caption_document_id: caption.document.id,
      input: {
        base_revision_id: caption.revision.id,
        editorial_timeline_version_id: timeline.id,
        language,
        style_id: caption.revision.style_id,
        cues: cues as Omit<VideoCaptionCue, 'id'>[],
      },
    },
  }
}

function editorialCommandInput(request: VideoWorkbenchActionInputRequest, values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const timeline = currentTimeline(request)
  const kind = value(values, 'editorial_kind')
  if (!timeline || !kind) return inputError('当前时间线已变化，请刷新后重新编辑。')
  const editItem = timeline.items.find(item => item.id === value(values, 'edit_item_id'))
  const targetTrack = timeline.tracks.find(track => track.id === value(values, 'track_id'))
  let commands: readonly EditorialTimelineCommand[]
  if (kind === 'ripple_delete') {
    const itemIds = selected(values, 'item_ids')
    if (!itemIds.length) return inputError('请至少选择一个时间线条目。')
    commands = [{ kind: 'ripple_delete', item_ids: [...itemIds], close_gap: true }]
  } else if (kind === 'trim') {
    const sourceStart = numeric(values, 'source_start_ms')
    const sourceEnd = numeric(values, 'source_end_ms')
    const timelineStart = numeric(values, 'timeline_start_ms')
    const timelineEnd = numeric(values, 'timeline_end_ms')
    if (!editItem || editItem.binding.kind !== 'source' || sourceStart === undefined || sourceEnd === undefined || timelineStart === undefined || timelineEnd === undefined) {
      return inputError('请选择有素材绑定的条目，并填写完整的修剪范围。')
    }
    if (sourceStart < 0 || sourceEnd <= sourceStart || timelineStart < 0 || timelineEnd <= timelineStart) {
      return inputError('修剪范围必须是正向且终点晚于起点。')
    }
    commands = [{
      kind: 'trim',
      item_id: editItem.id,
      source_range: {
        start: rationalMilliseconds(sourceStart, editItem.binding.source_range.start.tick_rate),
        duration: rationalMilliseconds(sourceEnd - sourceStart, editItem.binding.source_range.start.tick_rate),
      },
      timeline_range: {
        start: rationalMilliseconds(timelineStart, editItem.timeline_range.start.tick_rate),
        duration: rationalMilliseconds(timelineEnd - timelineStart, editItem.timeline_range.start.tick_rate),
      },
      ...(editItem.speed ? { speed: editItem.speed } : {}),
    }]
  } else if (kind === 'split') {
    const splitAt = numeric(values, 'split_at_ms')
    if (!editItem || editItem.binding.kind !== 'source' || splitAt === undefined) return inputError('请选择有素材绑定的条目，并填写切分位置。')
    const currentRange = timelineItemRange(editItem)
    if (editItem.speed) return inputError('变速素材必须先还原为 1x 后再切分。')
    if (splitAt <= currentRange.start || splitAt >= currentRange.end) return inputError('切分位置必须位于当前条目内部。')
    commands = [{ kind: 'split', item_id: editItem.id, at: rationalMilliseconds(splitAt, editItem.timeline_range.start.tick_rate) }]
  } else if (kind === 'reorder') {
    const timelineStart = numeric(values, 'timeline_start_ms')
    if (!editItem || !targetTrack || timelineStart === undefined) return inputError('请选择要移动的条目、目标轨道和时间位置。')
    if (!trackAcceptsItem(targetTrack, editItem)) return inputError('目标轨道与条目类型不匹配。')
    commands = [{ kind: 'reorder', item_id: editItem.id, track_id: targetTrack.id, timeline_start: rationalMilliseconds(timelineStart, editItem.timeline_range.start.tick_rate) }]
  } else if (kind === 'insert') {
    const insertItemId = value(values, 'insert_item_id')
    const draftItem = request.snapshot.timeline_drafts.flatMap(draft => draft.status === 'proposed' ? draft.items : []).find(item => item.id === insertItemId)
    if (!draftItem || !targetTrack) return inputError('请选择要插入的草稿片段和目标轨道。')
    if (!trackAcceptsItem(targetTrack, draftItem)) return inputError('目标轨道与草稿片段类型不匹配。')
    commands = [{ kind: 'insert', track_id: targetTrack.id, item: { ...draftItem, track_id: targetTrack.id } }]
  } else if (kind === 'replace') {
    const replacementItemId = value(values, 'replacement_item_id')
    const replacementItem = request.snapshot.timeline_drafts.flatMap(draft => draft.status === 'proposed' ? draft.items : []).find(item => item.id === replacementItemId)
    if (!editItem || !replacementItem) return inputError('请选择要替换的条目和草稿片段。')
    if (editItem.linked_av_group_id) return inputError('成对音视频条目的替换需要同时确认两条轨道，当前请先使用删除并插入。')
    const currentTrack = timeline.tracks.find(track => track.id === editItem.track_id)
    if (!currentTrack || !trackAcceptsItem(currentTrack, replacementItem)) return inputError('替换片段类型与目标轨道不匹配。')
    commands = [{
      kind: 'replace',
      item_id: editItem.id,
      replacement: {
        ...replacementItem,
        id: editItem.id,
        track_id: editItem.track_id,
        timeline_range: editItem.timeline_range,
        locked: false,
      },
    }]
  } else if (kind === 'lock') {
    const itemIds = selected(values, 'item_ids')
    if (!itemIds.length) return inputError('请至少选择一个时间线条目。')
    commands = [{ kind: 'lock', item_ids: [...itemIds], locked: checked(values, 'lock_value') }]
  } else if (kind === 'set_track_state') {
    const trackId = value(values, 'track_id')
    if (!trackId) return inputError('请选择需要设置的轨道。')
    commands = [{ kind: 'set_track_state', track_id: trackId, locked: checked(values, 'track_locked'), muted: checked(values, 'track_muted') }]
  } else {
    return inputError('不支持该编辑动作。')
  }
  return { ok: true, value: { action: 'open_editor', commands } }
}

function deliveryCommandInput(request: VideoWorkbenchActionInputRequest, values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const kind = value(values, 'delivery_kind')
  const variant = selectedVariant(request)
  if (!kind || !variant) return inputError('当前交付变体已变化，请刷新后重试。')
  let command: DeliveryVariantCommand
  if (kind === 'set_caption_revision') {
    const revisionId = value(values, 'caption_revision_id')
    const revision = request.snapshot.caption_revisions.find(candidate => candidate.id === revisionId)
    const document = revision ? request.snapshot.caption_documents.find(candidate => candidate.current_revision_id === revision.id) : undefined
    if (!revision || !document) return inputError('请选择当前可用的字幕修订。')
    command = { kind, caption_document_id: document.id, caption_revision_id: revision.id }
  } else if (kind === 'set_composition_plan') {
    const compositionPlanId = value(values, 'composition_plan_id')
    if (!compositionPlanId) return inputError('请选择构图计划。')
    command = { kind, composition_plan_id: compositionPlanId }
  } else if (kind === 'set_audio_finishing_plan') {
    const audioPlanId = value(values, 'audio_finishing_plan_id')
    if (!audioPlanId) return inputError('请选择音频完成计划。')
    command = { kind, audio_finishing_plan_id: audioPlanId }
  } else if (kind === 'set_audio_policy') {
    const policy = value(values, 'audio_policy')
    const parsed = policy ? videoAudioPolicySchema.safeParse(policy) : undefined
    if (!parsed?.success) return inputError('请选择有效的声音组合。')
    command = { kind, policy: parsed.data }
  } else if (kind === 'set_export_profile') {
    const profileId = value(values, 'export_profile_revision_id')
    const profile = request.snapshot.project.export_profile_revisions.find(candidate => candidate.id === profileId)
    if (!profile) return inputError('请选择导出规格。')
    command = { kind, export_profile_revision_id: profile.id, expected_profile_hash: profile.content_hash }
  } else {
    return inputError('不支持该交付动作。')
  }
  return { ok: true, value: { action: 'open_variant_editor', commands: [command] } }
}

/** Converts only declared form values into typed UI input. It never accepts a
 * path, URL, capability, provider prompt, credential, or arbitrary JSON. */
export function createVideoWorkbenchActionInput(
  request: VideoWorkbenchActionInputRequest,
  values: VideoWorkbenchFormValues,
): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const timeline = currentTimeline(request)
  const variant = selectedVariant(request)
  switch (request.action) {
    case 'estimate_budget': {
      const sourceId = value(values, 'source_id')
      const source = request.snapshot.project.sources.find(candidate => candidate.id === sourceId)
      const purposes = selectedRemoteValues(values, 'purposes', remotePurposeSet)
      const dataKinds = selectedRemoteValues(values, 'data_kinds', remoteDataKindSet)
      const startMs = numeric(values, 'start_ms')
      const endMs = numeric(values, 'end_ms')
      if (!source || !purposes || !dataKinds || startMs === undefined || endMs === undefined || startMs < 0 || endMs <= startMs || endMs > source.duration_ms) {
        return inputError('请选择可用素材、范围、用途和发送数据。')
      }
      return {
        ok: true,
        value: {
          action: 'estimate_budget',
          purposes,
          source_ids: [source.id],
          data_kinds: dataKinds,
          coverage: [{
            source_id: source.id,
            ranges: [{
              start: rationalTime(startMs, { num: 1_000, den: 1 }),
              duration: rationalTime(endMs - startMs, { num: 1_000, den: 1 }),
            }],
          }],
        },
      }
    }
    case 'create_quick_draft': {
      const userGoal = value(values, 'user_goal')
      if (!userGoal) return inputError('请说明剪辑目标。')
      const direction = creativeDirectionInput(request, values)
      if (!direction.ok) return direction
      const briefChoices = {
        use_case: optionalChoice(values, 'use_case', creationBriefChoices.use_case),
        distribution: optionalChoice(values, 'distribution', creationBriefChoices.distribution),
        tone: optionalChoice(values, 'tone', creationBriefChoices.tone),
        pace: optionalChoice(values, 'pace', creationBriefChoices.pace),
        caption_preference: optionalChoice(values, 'caption_preference', creationBriefChoices.caption_preference),
        hook_strategy: optionalChoice(values, 'hook_strategy', creationBriefChoices.hook_strategy),
        story_structure: optionalChoice(values, 'story_structure', creationBriefChoices.story_structure),
        selection_focus: optionalChoice(values, 'selection_focus', creationBriefChoices.selection_focus),
      }
      if (Object.values(briefChoices).some(candidate => candidate === null)) return inputError('创作目标选项无效，请重新选择。')
      const audience = values.audience === undefined ? undefined : value(values, 'audience')
      if (values.audience !== undefined && !audience) return inputError('请填写受众。')
      const mustPreserve = commaSeparatedValues(values, 'must_preserve')
      if (mustPreserve && mustPreserve.length > 40) return inputError('最多填写 40 项必须保留内容。')
      const rawTargetDuration = values.target_duration_seconds === undefined ? undefined : value(values, 'target_duration_seconds')
      const targetDuration = numeric(values, 'target_duration_seconds')
      if (rawTargetDuration !== undefined && (targetDuration === undefined || targetDuration <= 0 || targetDuration > 3_600)) {
        return inputError('目标时长必须是 1 到 3600 秒之间的数字。')
      }
      const coveragePreference = optionalChoice(values, 'coverage_preference', creationBriefChoices.coverage_preference)
      const editingStrategy = optionalChoice(values, 'editing_strategy', creationBriefChoices.editing_strategy)
      if (coveragePreference === null || editingStrategy === null) return inputError('规划选项无效，请重新选择。')
      const brief = {
        ...(briefChoices.use_case ? { use_case: briefChoices.use_case } : {}),
        ...(audience ? { audience } : {}),
        ...(briefChoices.distribution ? { distribution: briefChoices.distribution } : {}),
        ...(briefChoices.tone ? { tone: briefChoices.tone } : {}),
        ...(briefChoices.pace ? { pace: briefChoices.pace } : {}),
        ...(briefChoices.caption_preference ? { caption_preference: briefChoices.caption_preference } : {}),
        ...(briefChoices.hook_strategy ? { hook_strategy: briefChoices.hook_strategy } : {}),
        ...(briefChoices.story_structure ? { story_structure: briefChoices.story_structure } : {}),
        ...(briefChoices.selection_focus ? { selection_focus: briefChoices.selection_focus } : {}),
        ...(mustPreserve ? { must_preserve: mustPreserve } : {}),
      } as NonNullable<AnalyzeVideoProjectInput['brief']>
      const planning = {
        ...(targetDuration !== undefined ? { target_duration_seconds: targetDuration } : {}),
        ...(coveragePreference ? { coverage_preference: coveragePreference } : {}),
        ...(editingStrategy ? { editing_strategy: editingStrategy } : {}),
      } as NonNullable<AnalyzeVideoProjectInput['planning']>
      return {
        ok: true,
        value: {
          action: 'create_quick_draft',
          input: {
            base_revision: request.snapshot.project.revision,
            user_goal: userGoal,
            ...(direction.value ? { creative_direction: direction.value } : {}),
            ...(Object.keys(brief).length ? { brief } : {}),
            ...(Object.keys(planning).length ? { planning } : {}),
          },
        },
      }
    }
    case 'open_editor':
      return editorialCommandInput(request, values)
    case 'open_variant_editor':
      return deliveryCommandInput(request, values)
    case 'create_variant': {
      const name = value(values, 'name')
      const outputPreset = value(values, 'output_preset')
      const deliveryFormat = value(values, 'delivery_format')
      const parsedOutputPreset = outputPreset ? videoOutputPresetSchema.safeParse(outputPreset) : undefined
      const parsedDeliveryFormat = deliveryFormat ? videoDeliveryFormatSchema.safeParse(deliveryFormat) : undefined
      if (parsedOutputPreset && !parsedOutputPreset.success) return inputError('请选择有效的变体输出规格。')
      if (parsedDeliveryFormat && !parsedDeliveryFormat.success) return inputError('请选择有效的变体导出格式。')
      return name && timeline && parsedOutputPreset?.success && parsedDeliveryFormat?.success
        ? { ok: true, value: { action: 'create_variant', input: { name, editorial_timeline_version_id: timeline.id, output_preset: parsedOutputPreset.data, delivery_format: parsedDeliveryFormat.data } } }
        : inputError('请填写变体名称并选择输出规格与导出格式。')
    }
    case 'create_caption': {
      const language = value(values, 'language')
      const fontSize = numeric(values, 'font_size') ?? 48
      return language && timeline ? {
        ok: true,
        value: {
          action: 'create_caption',
          input: {
            editorial_timeline_version_id: timeline.id,
            language,
            style: { name: '默认字幕', font_family: 'Noto Sans CJK SC', font_size: fontSize, fill: '#FFFFFF', outline_fill: '#000000', outline_width: 2, bottom_safe_area: 0.08, max_width: 0.9 },
          },
        },
      } : inputError('当前时间线已变化，请刷新后重新生成字幕。')
    }
    case 'create_caption_revision':
      return captionRevisionInput(request, values)
    case 'create_caption_translation': {
      const caption = currentCaptionRevision(request)
      const language = value(values, 'language')
      return caption && timeline && language ? {
        ok: true,
        value: {
          action: 'create_caption_translation',
          caption_document_id: caption.document.id,
          input: { base_revision_id: caption.revision.id, editorial_timeline_version_id: timeline.id, language, style_id: caption.revision.style_id },
        },
      } : inputError('当前字幕修订已变化，请刷新后重试。')
    }
    case 'create_composition_plan':
      return variant ? { ok: true, value: { action: 'create_composition_plan', input: { variant_id: variant.variant.id, base_variant_version_id: variant.version.id } } } : inputError('请选择交付变体。')
    case 'create_audio_finishing_plan':
      return variant ? { ok: true, value: { action: 'create_audio_finishing_plan', input: { variant_id: variant.variant.id, base_variant_version_id: variant.version.id } } } : inputError('请选择交付变体。')
    case 'analyze_beat': {
      const sourceId = value(values, 'source_id')
      return sourceId ? { ok: true, value: { action: 'analyze_beat', input: { source_id: sourceId } } } : inputError('请选择素材。')
    }
    case 'create_beat_sync_draft': {
      const sourceId = selectedSource(request)
      const beatEvidenceId = value(values, 'beat_evidence_id')
      return sourceId && timeline && beatEvidenceId
        ? { ok: true, value: { action: 'create_beat_sync_draft', input: { source_id: sourceId, beat_evidence_id: beatEvidenceId, base_timeline_version_id: timeline.id } } }
        : inputError('请选择节拍证据。')
    }
    case 'analyze_subject_track': {
      const sourceId = value(values, 'source_id')
      const subjectId = value(values, 'subject_id')
      return sourceId && subjectId ? { ok: true, value: { action: 'analyze_subject_track', input: { source_id: sourceId, subject_id: subjectId } } } : inputError('请选择素材并填写主体。')
    }
    case 'create_review_note': {
      const actorId = value(values, 'actor_id')
      const body = value(values, 'body')
      const startMs = numeric(values, 'start_ms')
      const endMs = numeric(values, 'end_ms')
      if (!timeline || !actorId || !body || startMs === undefined || endMs === undefined || startMs < 0 || endMs <= startMs) {
        return inputError('请填写反馈人、有效时间范围和反馈内容。')
      }
      return {
        ok: true,
        value: {
          action: 'create_review_note',
          input: {
            actor_id: actorId,
            anchor: {
              kind: 'timeline_range',
              editorial_timeline_version_id: timeline.id,
              range: {
                start: rationalTime(startMs, { num: 1_000, den: 1 }),
                duration: rationalTime(endMs - startMs, { num: 1_000, den: 1 }),
              },
            },
            body,
          },
        },
      }
    }
    case 'resolve_review_note': {
      const review = request.snapshot.project.review_notes.find(note => note.id === request.target_id)
      const actorId = value(values, 'actor_id')
      const state = value(values, 'state')
      if (!review || review.status !== 'open' || !request.target_id || !actorId || (state !== 'addressed' && state !== 'dismissed')) {
        return inputError('当前反馈已变化，请刷新后重试。')
      }
      if (state === 'dismissed') {
        return { ok: true, value: { action: 'resolve_review_note', review_note_id: review.id, input: { actor_id: actorId, state } } }
      }
      if (!timeline || timeline.id === review.timeline_version_id) {
        return inputError('请先通过编辑 CommandSet 创建新的 Timeline Version，再标记反馈已处理。')
      }
      return {
        ok: true,
        value: {
          action: 'resolve_review_note',
          review_note_id: review.id,
          input: { actor_id: actorId, state, resolved_by_timeline_version_id: timeline.id },
        },
      }
    }
    case 'create_approval_decision': {
      const actorId = value(values, 'actor_id')
      const state = value(values, 'state')
      const noteIds = selected(values, 'note_ids')
      if (!timeline || !actorId || (state !== 'approved' && state !== 'changes_requested')) {
        return inputError('请填写审批人和审批决定。')
      }
      if (state === 'changes_requested' && !noteIds.length) return inputError('要求修改时必须关联至少一条反馈。')
      const validNoteIds = new Set(request.snapshot.project.review_notes
        .filter(note => note.timeline_version_id === timeline.id && note.status === 'open')
        .map(note => note.id))
      if (!noteIds.every(noteId => validNoteIds.has(noteId))) return inputError('只能关联当前版本尚未处理的反馈。')
      return { ok: true, value: { action: 'create_approval_decision', input: { actor_id: actorId, state, note_ids: [...noteIds] } } }
    }
    case 'confirm_post_render_quality':
      return checked(values, 'confirmed') ? { ok: true, value: { action: 'confirm_post_render_quality', confirmed: true } } : inputError('请明确确认全部待确认项。')
  }
}
