import type {
  DeliveryVariantVersion,
  EditorialTimelineVersion,
  PublicMediaTask,
  PublicVideoFactSummary,
  VideoOutputVerification,
  VideoQualityReport,
  VideoTimelineItem,
  VideoPlanningWorkflow,
} from '../../../shared/contracts/media.js'
import { videoPlanningWorkflowSchema } from '../../../shared/contracts/media.js'
import { draftIsPartiallyAcceptable } from './commandSet.js'
import { VIDEO_WORKBENCH_PANELS, type VideoWorkbenchFactKind, type VideoWorkbenchPanel, type VideoWorkbenchPhase, type VideoWorkbenchProjectProjection } from './contracts.js'
import { pendingPostRenderQualityConfirmations } from './qualityConfirmation.js'
import type { VideoWorkbenchUiState } from './state.js'

export type VideoWorkbenchActionAvailability = Readonly<{
  enabled: boolean
  reason?: string
}>

export type VideoWorkbenchPanelModel = Readonly<{
  id: VideoWorkbenchPanel
  label: string
  state: VideoWorkbenchPhase
  count?: number
  attention?: boolean
}>

export type VideoWorkbenchJourneyStepId = 'import' | 'plan' | 'edit' | 'finish' | 'deliver'
export type VideoWorkbenchJourneyStepState = 'complete' | 'current' | 'upcoming' | 'blocked'
export type VideoWorkbenchJourneyActionKind =
  | 'refresh'
  | 'choose_sources'
  | 'estimate_budget'
  | 'poll_operations'
  | 'create_quick_draft'
  | 'accept_draft'
  | 'create_variant'
  | 'preflight'
  | 'preview'
  | 'render'
  | 'confirm_post_render_quality'

export type VideoWorkbenchJourney = Readonly<{
  current_step: VideoWorkbenchJourneyStepId
  completed: boolean
  title: string
  description: string
  steps: readonly Readonly<{
    id: VideoWorkbenchJourneyStepId
    label: string
    state: VideoWorkbenchJourneyStepState
  }>[]
  action?: Readonly<{
    label: string
    panel: VideoWorkbenchPanel
    action?: VideoWorkbenchJourneyActionKind
    target_id?: string
    availability: VideoWorkbenchActionAvailability
  }>
}>

export type VideoOperationRecoveryModel = Readonly<{
  id: string
  kind: string
  label: string
  status_label: string
  detail: string
  status: PublicMediaTask['status']
  stage: string
  progress: number
  workflow_phase?: VideoPlanningWorkflow['phase']
  completed_units?: number
  total_units?: number
  next_action?: VideoPlanningWorkflow['next_action']
  interpreted_goal?: string
  clarifications: readonly string[]
  outcome_unknown: boolean
  can_cancel: boolean
  can_retry: boolean
  selected: boolean
}>

export type VideoWorkbenchViewModel = Readonly<{
  phase: VideoWorkbenchPhase
  active_panel: VideoWorkbenchPanel
  title: string
  status_message: string
  failure_recovery?: Readonly<{
    code: string
    label: string
    action: 'refresh' | 'choose_sources' | 'estimate_budget' | 'poll_operations'
  }>
  action_pending: boolean
  panels: readonly VideoWorkbenchPanelModel[]
  journey: VideoWorkbenchJourney
  project_home: Readonly<{
    source_count: number
    missing_source_count: number
    changed_source_count: number
    current_timeline_id?: string
    variant_count: number
    operation_count: number
    recovery_required: boolean
    creation_brief?: Readonly<{
      use_case: string
      user_request: string
      audience: string
      distribution: string
      tone: string
      pace: string
      caption_preference: string
      hook_strategy: string
      story_structure: string
      selection_focus: string
      must_preserve: readonly string[]
      creative_direction: Readonly<{
        narrative_voice: string
        emotional_arc: string
        audio_mode: string
        voiceover_persona: string
        caption_strategy: string
        keep_natural_pauses: boolean
        human_notes: string
      }>
    }>
    can_import_sources: VideoWorkbenchActionAvailability
  }>
  import_scope: Readonly<{
    sources: readonly Readonly<{ id: string; name: string; duration: string; state: 'ready' | 'missing' | 'changed'; selected: boolean }>[]
    active_budget?: Readonly<{
      estimate_hash: string
      requests: number
      estimated_amount_micros: number
      asr_seconds: number
      visual_frames: number
      state: string
    }>
    uncovered: readonly Readonly<{ fact_id: string; reason: string; range: string }>[]
    confirm_budget: VideoWorkbenchActionAvailability
    estimate_budget: VideoWorkbenchActionAvailability
  }>
  material_browser: Readonly<{
    fact_kind: VideoWorkbenchFactKind
    source_options: readonly Readonly<{ id: string; name: string }>[]
    source_id?: string
    facts: readonly Readonly<{ id: string; kind: string; source_id?: string; source_name?: string; segment_id?: string; range?: string; state: string; coverage_state?: string; selected: boolean }>[]
    search_query?: string
    search_results: readonly Readonly<{ id: string; kind: string; source_id: string; source_name?: string; segment_id?: string; range: string; text: string; selected: boolean }>[]
    search_generation?: number
    search_count: number
    next_fact_cursor?: string
    next_search_cursor?: string
    uncovered_count: number
    read_facts: VideoWorkbenchActionAvailability
    load_more_facts: VideoWorkbenchActionAvailability
    search: VideoWorkbenchActionAvailability
    load_more_search: VideoWorkbenchActionAvailability
  }>
  quick_create: Readonly<{
    interpreted_goal?: string
    clarifications: readonly string[]
    rationale: readonly string[]
    planning_source: 'provider' | 'local_conservative' | 'mixed' | 'unknown'
    suggestions: readonly Readonly<{
      id: string
      draft_id: string
      label: string
      explanation: string
      estimated_duration?: string
      included_count: number
      omission_count: number
      omission_reasons: readonly string[]
      selected: boolean
    }>[]
    drafts: readonly Readonly<{
      id: string
      status: string
      item_count: number
      partially_acceptable: boolean
      selected: boolean
      items: readonly Readonly<{ id: string; kind: string; range: string; source_name?: string; selected: boolean }>[]
    }>[]
    can_create_draft: VideoWorkbenchActionAvailability
    can_accept_selection: VideoWorkbenchActionAvailability
  }>
  editorial: Readonly<{
    timeline_id?: string
    timeline_duration_ms: number
    tracks: readonly Readonly<{ id: string; kind: string; locked: boolean; muted: boolean; item_count: number }>[]
    items: readonly Readonly<{
      id: string
      track_id: string
      kind: string
      source_id?: string
      source_name?: string
      source_range?: string
      timeline_range: string
      timeline_start_ms: number
      timeline_duration_ms: number
      timeline_left_percent: number
      timeline_width_percent: number
      linked_av_group_id?: string
      linked_item_ids: readonly string[]
      locked: boolean
      selected: boolean
    }>[]
    selected_item_count: number
    command_set: VideoWorkbenchActionAvailability
  }>
  finishing: Readonly<{
    variants: readonly Readonly<{ id: string; name: string; version_id: string; target: string; caption_mode: string; preflight: 'passed' | 'blocked' | 'needs_user_decision' | 'missing'; selected: boolean }>[]
    audio_policy: string
    music_asset_count: number
    voiceover_asset_count: number
    voiceover_ready: boolean
    caption_revision_count: number
    composition_plan_count: number
    audio_finishing_plan_count: number
    can_create_variant: VideoWorkbenchActionAvailability
    can_create_caption: VideoWorkbenchActionAvailability
    can_apply_variant_commands: VideoWorkbenchActionAvailability
    can_translate_captions: VideoWorkbenchActionAvailability
    can_track_subject: VideoWorkbenchActionAvailability
    can_analyze_beat: VideoWorkbenchActionAvailability
    can_create_beat_sync_draft: VideoWorkbenchActionAvailability
  }>
  review_delivery: Readonly<{
    preview_asset?: Readonly<{
      asset_id: string
      asset_path: string
      content_hash: string
    }>
    review_notes: readonly Readonly<{
      id: string
      status: 'open' | 'addressed' | 'dismissed'
      actor_id: string
      body: string
      selected: boolean
      resolve: VideoWorkbenchActionAvailability
    }>[]
    approval_decisions: readonly Readonly<{ id: string; state: 'approved' | 'changes_requested'; actor_id: string; note_count: number }>[]
    create_review_note: VideoWorkbenchActionAvailability
    create_approval_decision: VideoWorkbenchActionAvailability
    quality_reports: readonly Readonly<{ id: string; kind: string; state: string; check_count: number; selected: boolean }>[]
    pending_quality_confirmations: readonly Readonly<{
      operation_id: string
      report_id: string
      checks: readonly Readonly<{ id: string; code: string; message: string; severity: string }>[]
      confirm: VideoWorkbenchActionAvailability
    }>[]
    output_verification: Readonly<{ state: 'passed' | 'blocked' | 'missing'; detail?: string }>
    preflight: VideoWorkbenchActionAvailability
    preview: VideoWorkbenchActionAvailability
    render: VideoWorkbenchActionAvailability
  }>
  operation_center: Readonly<{
    event_cursor: number
    reset_required: boolean
    requires_refresh: boolean
    poll_operations: VideoWorkbenchActionAvailability
    operations: readonly VideoOperationRecoveryModel[]
  }>
}>

const panelLabels: Record<VideoWorkbenchPanel, string> = {
  project_home: '项目',
  import_scope: '素材与目标',
  material_browser: '素材浏览',
  quick_create: '生成方案',
  editorial: '时间线',
  finishing: '字幕与画面',
  review_delivery: '预览与导出',
  operation_center: '后台任务',
}

const journeyStepLabels: Record<VideoWorkbenchJourneyStepId, string> = {
  import: '导入素材',
  plan: '生成方案',
  edit: '确认时间线',
  finish: '字幕与画面',
  deliver: '预览与导出',
}

const journeyStepOrder: readonly VideoWorkbenchJourneyStepId[] = ['import', 'plan', 'edit', 'finish', 'deliver']

const operationLabels: Partial<Record<PublicMediaTask['kind'], string>> = {
  'video.probe': '检查素材',
  'video.fingerprint': '确认素材指纹',
  'video.analyze': '分析素材并生成剪辑建议',
  'video.plan': '整理故事结构与候选片段',
  'video.transcribe': '整理语音转写',
  'video.understand': '理解画面内容',
  'video.index': '建立素材检索索引',
  'video.beat_analyze': '分析音乐节拍',
  'video.beat_sync_draft': '生成节拍同步草稿',
  'video.subject_track': '跟踪画面主体',
  'video.caption_draft': '整理字幕',
  'video.caption_translation': '生成字幕翻译建议',
  'video.composition_plan': '规划构图',
  'video.audio_finish_plan': '整理声音',
  'video.quality_preflight': '检查交付条件',
  'video.timeline_compile': '写入正式时间线',
  'video.preview': '生成预览',
  'video.render': '渲染正式成片',
  'video.output_verify': '验证导出文件',
  'video.quality_post_render': '生成后渲染质量报告',
}

const operationStatusLabels: Record<PublicMediaTask['status'], string> = {
  queued: '等待开始',
  running: '处理中',
  committing: '正在保存结果',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const briefLabels: Record<string, string> = {
  auto_highlight: '自动高光',
  social_short: '社交短视频',
  talking_head: '口播',
  interview: '访谈',
  tutorial: '教程',
  product_demo: '产品演示',
  event_recap: '活动回顾',
  sports_highlight: '体育高光',
  podcast_clip: '播客切片',
  custom: '自定义',
  vertical_short: '竖屏短视频',
  horizontal_video: '横屏视频',
  square_social: '方形社交视频',
  presentation: '演示文稿',
  clear: '清晰',
  energetic: '有活力',
  warm: '温暖',
  professional: '专业',
  cinematic: '电影感',
  playful: '轻松',
  calm: '舒缓',
  balanced: '均衡',
  fast: '快速',
  auto: '自动',
  burn_in: '烧录字幕',
  sidecar: '外挂字幕',
  none: '无字幕',
  chronological: '按时间顺序',
  strongest_moment: '最强时刻开场',
  hook_value_payoff: '钩子-价值-回收',
  problem_solution: '问题-解决',
  how_to: '教程步骤',
  highlight_reel: '高光集锦',
  speech: '对白',
  action: '动作',
  visual: '画面',
  people: '人物',
  product: '产品',
  source_only: '只保留原声',
  music_with_source: '原声 + 音乐',
  music_only: '只使用音乐',
  voice_over_with_source: '旁白 + 原声',
  voice_over_only: '只使用旁白',
  music_with_voice_over: '旁白 + 音乐',
  source_music_with_voice_over: '原声 + 音乐 + 旁白',
}

function briefLabel(value: string): string {
  return briefLabels[value] ?? value
}

export function videoMediaKindLabel(kind: string): string {
  switch (kind) {
    case 'primary_video': return '主视频'
    case 'primary_audio': return '主音频'
    case 'source_audio': return '源音频'
    case 'b_roll': return '补充画面'
    case 'caption': return '字幕'
    case 'overlay': return '叠加画面'
    case 'music': return '音乐'
    case 'voice_over': return '旁白'
    case 'sfx': return '音效'
    case 'video': return '视频'
    case 'audio': return '音频'
    case 'evidence_window': return '证据窗口'
    case 'beat_grid': return '节拍证据'
    case 'content_segment': return '内容片段'
    case 'camera_shot': return '镜头'
    case 'transcript': return '转写'
    case 'transcript_revision': return '转写修订'
    default: return kind
  }
}

function creationBriefModel(project: VideoWorkbenchProjectProjection): VideoWorkbenchViewModel['project_home']['creation_brief'] {
  const brief = project.creation_brief
  if (!brief) return undefined
  return {
    use_case: briefLabel(brief.use_case),
    user_request: brief.user_request,
    audience: brief.audience,
    distribution: briefLabel(brief.distribution),
    tone: briefLabel(brief.tone),
    pace: briefLabel(brief.pace),
    caption_preference: briefLabel(brief.caption_preference),
    hook_strategy: briefLabel(brief.hook_strategy),
    story_structure: briefLabel(brief.story_structure),
    selection_focus: briefLabel(brief.selection_focus),
    must_preserve: brief.must_preserve,
    creative_direction: {
      narrative_voice: briefLabel(brief.creative_direction.narrative_voice),
      emotional_arc: briefLabel(brief.creative_direction.emotional_arc),
      audio_mode: briefLabel(brief.creative_direction.audio_mode),
      voiceover_persona: briefLabel(brief.creative_direction.voiceover_persona),
      caption_strategy: briefLabel(brief.creative_direction.caption_strategy),
      keep_natural_pauses: brief.creative_direction.keep_natural_pauses,
      human_notes: brief.creative_direction.human_notes,
    },
  }
}

function quickCreateSuggestions(
  project: VideoWorkbenchProjectProjection,
  drafts: readonly Readonly<{ id: string; items: readonly unknown[] }>[],
  selectedDraftId?: string,
): VideoWorkbenchViewModel['quick_create']['suggestions'] {
  const batches = project.quick_create_batches ?? []
  const latestBatch = batches.length ? batches[batches.length - 1] : undefined
  if (latestBatch) {
    return latestBatch.candidates.map(candidate => ({
      id: candidate.id,
      draft_id: candidate.draft_id,
      label: candidate.label,
      explanation: candidate.explanation,
      estimated_duration: durationText(candidate.estimated_duration.ticks, candidate.estimated_duration.tick_rate),
      included_count: candidate.included_segment_ids.length,
      omission_count: candidate.omissions.length,
      omission_reasons: candidate.omissions.slice(0, 3).map(item => item.reason),
      selected: selectedDraftId === candidate.draft_id,
    }))
  }
  const direction = project.brief?.recommended_direction
  return drafts.map((draft, index) => ({
    id: draft.id,
    draft_id: draft.id,
    label: `建议方案 ${index + 1}`,
    explanation: direction ?? '基于当前已验证素材事实生成，等待你逐项确认。',
    included_count: draft.items.length,
    omission_count: 0,
    omission_reasons: [],
    selected: selectedDraftId === draft.id,
  }))
}

function planningSource(
  drafts: readonly Readonly<{ planning_origin?: 'provider' | 'local_conservative' | 'unknown' }>[],
): VideoWorkbenchViewModel['quick_create']['planning_source'] {
  const origins = new Set(drafts.map(draft => draft.planning_origin ?? 'unknown'))
  if (!origins.size) return 'unknown'
  if (origins.has('unknown')) return origins.size === 1 ? 'unknown' : 'mixed'
  if (origins.size > 1) return 'mixed'
  return origins.has('provider') ? 'provider' : 'local_conservative'
}

function operationPresentation(operation: PublicMediaTask): Readonly<{ label: string; status_label: string; detail: string }> {
  return {
    label: operationLabels[operation.kind] ?? '处理视频任务',
    status_label: operationStatusLabels[operation.status],
    detail: operation.stage.trim() || operationStatusLabels[operation.status],
  }
}

function operationWorkflow(operation: PublicMediaTask): VideoPlanningWorkflow | undefined {
  if (operation.kind !== 'video.analyze' && operation.kind !== 'video.plan') return undefined
  const parsed = videoPlanningWorkflowSchema.safeParse(operation.result?.workflow)
  return parsed.success ? parsed.data : undefined
}

const workflowNextActionLabels: Record<VideoPlanningWorkflow['next_action'], string> = {
  wait_for_analysis: '等待后台分析',
  review_suggestions: '等待你查看建议',
  accept_draft: '等待你确认方案',
  retry_analysis: '可重新分析',
  refresh_project: '先刷新项目状态',
}

function workflowDetail(workflow: VideoPlanningWorkflow | undefined): string | undefined {
  if (!workflow) return undefined
  const units = `阶段 ${workflow.completed_units}/${workflow.total_units}`
  return `${units} · ${workflowNextActionLabels[workflow.next_action]}`
}

function journeySteps(currentStep: VideoWorkbenchJourneyStepId, blocked: boolean, completed: boolean): VideoWorkbenchJourney['steps'] {
  const currentIndex = journeyStepOrder.indexOf(currentStep)
  return journeyStepOrder.map((id, index) => ({
    id,
    label: journeyStepLabels[id],
    state: completed || index < currentIndex
      ? 'complete'
      : index === currentIndex
        ? blocked ? 'blocked' : 'current'
        : 'upcoming',
  }))
}

function journeyActionAvailability(state: VideoWorkbenchUiState): VideoWorkbenchActionAvailability {
  if (!state.snapshot) return unavailable('项目尚未加载。')
  if (state.pending_action) return unavailable('当前操作仍在提交或等待服务端确认。')
  return readyAction()
}

function journeyForNoSnapshot(state: VideoWorkbenchUiState): VideoWorkbenchJourney {
  return {
    current_step: 'import',
    completed: false,
    title: state.phase === 'loading' ? '正在读取项目' : '先打开一个视频项目',
    description: state.phase === 'loading' ? '项目状态确认后，这里会给出唯一的下一步。' : '打开项目后，从素材和剪辑目标开始。',
    steps: journeySteps('import', false, false),
  }
}

function milliseconds(time: { ticks: string; tick_rate: { num: number; den: number } }): bigint {
  return (BigInt(time.ticks) * BigInt(1_000) * BigInt(time.tick_rate.den)) / BigInt(time.tick_rate.num)
}

function durationText(ticks: string, tickRate: { num: number; den: number }): string {
  try {
    const milliseconds = (BigInt(ticks) * BigInt(1000) * BigInt(tickRate.den)) / BigInt(tickRate.num)
    const seconds = Number(milliseconds) / 1000
    if (!Number.isFinite(seconds)) return '时间过长'
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds - minutes * 60
    return minutes > 0 ? `${minutes}:${remainder.toFixed(1).padStart(4, '0')}` : `${remainder.toFixed(1)} 秒`
  } catch {
    return '时间未知'
  }
}

function rangeText(range: { start: { ticks: string; tick_rate: { num: number; den: number } }; duration: { ticks: string; tick_rate: { num: number; den: number } } }): string {
  try {
    const start = milliseconds(range.start)
    const end = start + milliseconds(range.duration)
    return `${durationText(start.toString(), { num: 1_000, den: 1 })} 至 ${durationText(end.toString(), { num: 1_000, den: 1 })}`
  } catch {
    return '时间未知'
  }
}

function sourceState(source: { missing: boolean; content_changed: boolean }): 'ready' | 'missing' | 'changed' {
  if (source.missing) return 'missing'
  if (source.content_changed) return 'changed'
  return 'ready'
}

function operationModel(operation: PublicMediaTask, selected: boolean, actionsEnabled: boolean): VideoOperationRecoveryModel {
  const canCancel = actionsEnabled && (operation.status === 'queued' || operation.status === 'running' || operation.status === 'committing')
  // Unknown remote outcomes need reconciliation before another paid call.
  const canRetry = !operation.outcome_unknown && (operation.status === 'failed' || operation.status === 'cancelled')
  const presentation = operationPresentation(operation)
  const workflow = operationWorkflow(operation)
  return {
    id: operation.id,
    kind: operation.kind,
    ...presentation,
    status: operation.status,
    stage: operation.stage,
    progress: operation.progress,
    ...(workflow ? {
      workflow_phase: workflow.phase,
      completed_units: workflow.completed_units,
      total_units: workflow.total_units,
      next_action: workflow.next_action,
      ...(workflow.interpreted_goal ? { interpreted_goal: workflow.interpreted_goal } : {}),
      clarifications: workflow.clarifications,
    } : { clarifications: [] }),
    outcome_unknown: Boolean(operation.outcome_unknown),
    can_cancel: canCancel,
    can_retry: canRetry,
    selected,
  }
}

function qualityState(reports: readonly VideoQualityReport[], version: DeliveryVariantVersion): 'passed' | 'blocked' | 'needs_user_decision' | 'missing' {
  const matching = reports.filter(candidate => candidate.kind === 'preflight' && candidate.delivery_variant_version_id === version.id)
  const report = matching[matching.length - 1]
  return report?.state ?? 'missing'
}

function deliveryVerification(verification: VideoOutputVerification | undefined): VideoWorkbenchViewModel['review_delivery']['output_verification'] {
  if (!verification) return { state: 'missing' }
  const allChecksPassed = verification.decoded === true
    && verification.packet_timestamps_monotonic === true
    && verification.duration_delta_ms !== undefined
    && verification.audio_video_duration_delta_ms !== undefined
  if (!allChecksPassed) return { state: 'blocked', detail: '输出尚未通过完整解码、时间戳或音视频时长验证。' }
  return { state: 'passed', detail: `${verification.byte_size} 字节，${verification.duration_ms} ms` }
}

function statusMessage(state: VideoWorkbenchUiState): string {
  if (state.last_error) return state.last_error.message
  if (state.phase === 'loading') return '正在读取项目状态'
  if (state.phase === 'offline') return '无法连接本地媒体服务'
  if (state.phase === 'missing') return '有素材需要重新关联'
  if (state.phase === 'stale') return '有素材内容已变化，需重新确认'
  if (state.phase === 'needs_user_decision') return '有远程操作结果需要人工确认'
  if (state.phase === 'partial') return '项目中仍有进行中的操作'
  if (state.phase === 'failed') return '项目需要处理失败项'
  if (state.requires_authoritative_refresh) return '状态已变化，正在等待服务端快照确认'
  return '项目状态已同步'
}

/** A safe error must leave the person with one concrete next step. These
 * actions reuse existing typed workbench commands and never fabricate retry
 * endpoints or bypass an expired native grant. */
function failureRecovery(state: VideoWorkbenchUiState): VideoWorkbenchViewModel['failure_recovery'] {
  if (state.event_reset_required || state.requires_authoritative_refresh) {
    return { code: 'MEDIA_STATE_CONFLICT', label: '重新读取权威项目快照', action: 'refresh' }
  }
  switch (state.last_error?.code) {
    case 'MEDIA_STATE_CONFLICT':
      return { code: state.last_error.code, label: '刷新项目状态', action: 'refresh' }
    case 'MEDIA_VIDEO_SOURCE_UNREADABLE':
    case 'MEDIA_VIDEO_SOURCE_CHANGED':
    case 'MEDIA_VIDEO_PROBE_INTERRUPTED':
    case 'MEDIA_RESOURCE_UNAVAILABLE':
      return { code: state.last_error.code, label: '重新选择素材', action: 'choose_sources' }
    case 'MEDIA_VIDEO_PROJECT_BUDGET_EXCEEDED':
    case 'MEDIA_VIDEO_PLATFORM_QUOTA_EXHAUSTED':
      return { code: state.last_error.code, label: '调整范围并重新估算', action: 'estimate_budget' }
    case 'MEDIA_TEMPORARILY_UNAVAILABLE':
    case 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE':
    case 'MEDIA_VIDEO_FINISHING_UNAVAILABLE':
    case 'MEDIA_VIDEO_PREVIEW_INTERRUPTED':
    case 'MEDIA_VIDEO_EXPORT_INTERRUPTED':
      return { code: state.last_error.code, label: '续读操作状态', action: 'poll_operations' }
    default:
      return undefined
  }
}

function unavailable(reason: string): VideoWorkbenchActionAvailability {
  return { enabled: false, reason }
}

function readyAction(): VideoWorkbenchActionAvailability {
  return { enabled: true }
}

function actionForWorkspace(state: VideoWorkbenchUiState): VideoWorkbenchActionAvailability {
  if (!state.snapshot) return unavailable('项目尚未加载。')
  if (state.event_reset_required || state.requires_authoritative_refresh) return unavailable('操作事件或项目状态已变化，必须先重新读取权威项目快照。')
  if (state.pending_action) return unavailable('当前操作仍在提交或等待服务端确认。')
  if (state.phase === 'offline') return unavailable('本地媒体服务暂不可用。')
  if (state.phase === 'missing') return unavailable('先重新关联缺失素材。')
  if (state.phase === 'stale') return unavailable('先处理内容已变化的素材。')
  if (state.phase === 'failed') return unavailable('先处理项目失败状态。')
  return readyAction()
}

function operationReadAvailability(state: VideoWorkbenchUiState): VideoWorkbenchActionAvailability {
  if (!state.snapshot) return unavailable('项目尚未加载。')
  if (state.pending_action) return unavailable('当前操作仍在提交或等待服务端确认。')
  return readyAction()
}

function currentPreviewMatchesVariant(snapshot: VideoWorkbenchUiState['snapshot'], variant: DeliveryVariantVersion | undefined): boolean {
  if (!snapshot?.preview || !variant) return false
  return snapshot.preview.delivery_variant_version_id === variant.id
    && snapshot.preview.timeline_version_id === variant.editorial_timeline_version_id
}

function currentOutputMatchesVariant(state: VideoWorkbenchUiState, variant: DeliveryVariantVersion | undefined): boolean {
  if (!state.snapshot?.output_verification || !variant) return false
  const verification = state.snapshot.output_verification
  return verification.delivery_variant_version_id === variant.id
    && verification.timeline_version_id === variant.editorial_timeline_version_id
    && deliveryVerification(verification).state === 'passed'
}

function journeyForWorkspace(
  state: VideoWorkbenchUiState,
  action: VideoWorkbenchActionAvailability,
): VideoWorkbenchJourney {
  const snapshot = state.snapshot
  if (!snapshot) return journeyForNoSnapshot(state)

  const sources = snapshot.project.sources
  const sourceIssue = sources.some(source => source.missing || source.content_changed)
  const chooseSources = journeyActionAvailability(state)
  const stepsFor = (currentStep: VideoWorkbenchJourneyStepId, blocked: boolean, completed = false) => journeySteps(currentStep, blocked, completed)
  const pendingQuality = pendingPostRenderQualityConfirmations(snapshot)
  const selectedDraft = snapshot.timeline_drafts.find(draft => draft.id === state.selection.timeline_draft_id)
  const selectedVariant = snapshot.variants.find(variant => variant.variant.id === state.selection.variant_id)
  const selectedPreflight = selectedVariant ? qualityState(snapshot.quality_reports, selectedVariant.version) : 'missing'
  const baseStep: VideoWorkbenchJourneyStepId = !snapshot.current_timeline
    ? 'plan'
    : snapshot.variants.length
      ? 'deliver'
      : 'finish'

  if (!sources.length) {
    return {
      current_step: 'import',
      completed: false,
      title: '先导入素材',
      description: '选择要剪辑的素材，系统会先建立转写、镜头和片段事实，再开始生成方案。',
      steps: stepsFor('import', false),
      action: { label: '导入素材', panel: 'import_scope', action: 'choose_sources', availability: chooseSources },
    }
  }

  if (sourceIssue) {
    return {
      current_step: 'import',
      completed: false,
      title: '先重新确认素材',
      description: '有素材缺失或内容已变化，继续剪辑可能会引用旧内容；重新关联后再生成方案。',
      steps: stepsFor('import', true),
      action: { label: '重新选择素材', panel: 'import_scope', action: 'choose_sources', availability: chooseSources },
    }
  }

  if (state.event_reset_required || state.requires_authoritative_refresh) {
    const recovery = failureRecovery(state)
    if (recovery) {
      const panel = recovery.action === 'poll_operations'
        ? 'operation_center'
        : recovery.action === 'estimate_budget'
          ? 'import_scope'
          : 'project_home'
      return {
        current_step: baseStep,
        completed: false,
        title: '先同步项目状态',
        description: '服务端状态或操作游标发生变化，先读取权威快照，避免在旧状态上继续编排。',
        steps: stepsFor(baseStep, true),
        action: { label: recovery.label, panel, action: recovery.action, availability: journeyActionAvailability(state) },
      }
    }
  }

  if (pendingQuality.length) {
    const confirmation = pendingQuality[0]!
    return {
      current_step: 'deliver',
      completed: false,
      title: '确认导出质量告警',
      description: '导出文件已经生成，系统发现需要人工判断的质量提示；确认后才会作为正式交付结果。',
      steps: stepsFor('deliver', true),
      action: {
        label: '确认并发布',
        panel: 'review_delivery',
        action: 'confirm_post_render_quality',
        target_id: confirmation.operation_id,
        availability: action,
      },
    }
  }

  const activeOperation = snapshot.operations.find(operation =>
    operation.status === 'queued' || operation.status === 'running' || operation.status === 'committing',
  )
  if (activeOperation) {
    const presentation = operationPresentation(activeOperation)
    const progressDetail = workflowDetail(operationWorkflow(activeOperation))
    return {
      current_step: baseStep,
      completed: false,
      title: `正在${presentation.label}`,
      description: `${presentation.detail}，当前已完成 ${activeOperation.progress}%。${progressDetail ? `${progressDetail}。` : ''}处理完成后会回到这条编排路径，现在不用重复点击。`,
      steps: stepsFor(baseStep, true),
      action: { label: '刷新处理进度', panel: 'operation_center', action: 'poll_operations', availability: operationReadAvailability(state) },
    }
  }

  if (!snapshot.current_timeline && !snapshot.timeline_drafts.length) {
    return {
      current_step: 'plan',
      completed: false,
      title: '告诉我你想剪成什么样',
      description: '用一句话描述用途、时长或节奏，先生成一版可检查的方案；原始素材不会被直接改写。',
      steps: stepsFor('plan', false),
      action: { label: '生成第一版方案', panel: 'quick_create', action: 'create_quick_draft', availability: action },
    }
  }

  if (!snapshot.current_timeline) {
    const canAccept = Boolean(selectedDraft && draftIsPartiallyAcceptable(selectedDraft, undefined) && state.selection.draft_item_ids.length)
    return {
      current_step: 'plan',
      completed: false,
      title: '从方案中选一个起点',
      description: canAccept
        ? '当前已选条目可以写入新的时间线版本。确认后仍可继续用 CommandSet 编辑，不会改写素材。'
        : '先在候选方案中选择要保留的片段，再把它们作为正式时间线起点。',
      steps: stepsFor('plan', false),
      action: canAccept
        ? { label: '采用所选方案', panel: 'quick_create', action: 'accept_draft', availability: action }
        : { label: '查看候选方案', panel: 'quick_create', availability: journeyActionAvailability(state) },
    }
  }

  if (!snapshot.variants.length) {
    return {
      current_step: 'finish',
      completed: false,
      title: '时间线已准备好',
      description: '下一步创建一个交付版本，再按平台设置字幕、构图和音频；这些设置不会污染编辑时间线。',
      steps: stepsFor('finish', false),
      action: { label: '创建交付版本', panel: 'finishing', action: 'create_variant', availability: action },
    }
  }

  if (!selectedVariant) {
    return {
      current_step: 'finish',
      completed: false,
      title: '选择一个交付版本',
      description: '不同平台比例、字幕策略和音频处理可以独立保存；先选中要预览或导出的版本。',
      steps: stepsFor('finish', false),
      action: { label: '查看交付版本', panel: 'finishing', availability: journeyActionAvailability(state) },
    }
  }

  if (selectedPreflight !== 'passed') {
    const preflightNeedsAttention = selectedPreflight === 'blocked' || selectedPreflight === 'needs_user_decision'
    return {
      current_step: 'deliver',
      completed: false,
      title: preflightNeedsAttention ? '先处理预检提示' : '先检查当前版本',
      description: preflightNeedsAttention
        ? '当前版本还有阻断项或需要人工判断的提示，处理后才能继续预览和导出。'
        : '预检会检查素材范围、时间线、字幕、音频和输出规格，确保后面的预览使用正式版本。',
      steps: stepsFor('deliver', preflightNeedsAttention),
      ...(preflightNeedsAttention
        ? { action: { label: '查看预检结果', panel: 'review_delivery', availability: journeyActionAvailability(state) } }
        : { action: { label: '运行预检', panel: 'review_delivery', action: 'preflight', availability: action } }),
    }
  }

  if (currentOutputMatchesVariant(state, selectedVariant.version)) {
    return {
      current_step: 'deliver',
      completed: true,
      title: '已完成并验证',
      description: '当前交付版本已经渲染，并通过输出文件验证；如需其他平台版本，可以回到字幕与画面继续创建变体。',
      steps: stepsFor('deliver', false, true),
    }
  }

  if (!currentPreviewMatchesVariant(snapshot, selectedVariant.version)) {
    return {
      current_step: 'deliver',
      completed: false,
      title: '先看一遍当前版本',
      description: '预览会使用当前正式交付版本，确认画面、字幕和声音后再开始耗时渲染。',
      steps: stepsFor('deliver', false),
      action: { label: '生成预览', panel: 'review_delivery', action: 'preview', availability: action },
    }
  }

  return {
    current_step: 'deliver',
    completed: false,
    title: snapshot.output_verification ? '重新渲染并验证' : '开始正式渲染',
    description: snapshot.output_verification
      ? '上一次输出还没有通过当前版本的完整校验，重新渲染会以当前交付版本为输入。'
      : '预览已准备好；正式渲染会生成交付文件，并在完成后自动做解码、时间戳和音视频时长验证。',
    steps: stepsFor('deliver', false),
    action: { label: snapshot.output_verification ? '重新渲染' : '开始渲染', panel: 'review_delivery', action: 'render', availability: action },
  }
}

function panelState(panel: VideoWorkbenchPanel, state: VideoWorkbenchUiState): VideoWorkbenchPhase {
  const snapshot = state.snapshot
  if (!snapshot) return state.phase
  if (panel === 'operation_center' && (state.event_reset_required || snapshot.operations.some(operation => operation.outcome_unknown))) return 'needs_user_decision'
  if (panel === 'import_scope' && snapshot.project.sources.some(source => source.missing)) return 'missing'
  if (panel === 'material_browser' && snapshot.facts.items.some(fact => fact.state === 'stale' || fact.state === 'changed')) return 'stale'
  if (panel === 'review_delivery' && snapshot.quality_reports.some(report => report.state === 'blocked')) return 'failed'
  return state.phase
}

function factModel(fact: PublicVideoFactSummary, sourceNames: ReadonlyMap<string, string>) {
  return {
    id: fact.id,
    kind: fact.kind,
    ...(fact.source_id ? { source_id: fact.source_id } : {}),
    ...(fact.source_id && sourceNames.get(fact.source_id) ? { source_name: sourceNames.get(fact.source_id) } : {}),
    ...(fact.segment_id ? { segment_id: fact.segment_id } : {}),
    ...(fact.range ? { range: rangeText(fact.range) } : {}),
    state: fact.state ?? 'ready',
    ...(fact.coverage ? { coverage_state: fact.coverage.uncovered.length ? 'partial' : 'covered' } : {}),
  }
}

function allUncovered(state: VideoWorkbenchUiState): readonly Readonly<{ fact_id: string; reason: string; range: string }>[] {
  const facts = state.snapshot?.facts.items ?? []
  return facts.flatMap(fact => fact.coverage?.uncovered.map(uncovered => ({
    fact_id: fact.id,
    reason: uncovered.reason,
    range: rangeText(uncovered.range),
  })) ?? [])
}

function groupItemsByTrack(items: readonly VideoTimelineItem[]): Map<string, number> {
  const count = new Map<string, number>()
  for (const item of items) count.set(item.track_id, (count.get(item.track_id) ?? 0) + 1)
  return count
}

function timelineDurationMilliseconds(timeline: EditorialTimelineVersion | undefined): number {
  if (!timeline || !timeline.items.length) return 0
  return Math.max(...timeline.items.map(item => {
    const start = Number(milliseconds(item.timeline_range.start))
    const duration = Number(milliseconds(item.timeline_range.duration))
    return start + duration
  }))
}

export function createVideoWorkbenchViewModel(state: VideoWorkbenchUiState): VideoWorkbenchViewModel {
  const snapshot = state.snapshot
  const action = actionForWorkspace(state)
  const panels: VideoWorkbenchPanelModel[] = VIDEO_WORKBENCH_PANELS.map(id => ({
    id,
    label: panelLabels[id],
    state: panelState(id, state),
    ...(id === 'operation_center' && snapshot ? { count: snapshot.operations.length, attention: state.event_reset_required || snapshot.operations.some(item => item.outcome_unknown) } : {}),
  }))
  if (!snapshot) {
    return {
      phase: state.phase,
      active_panel: state.panel,
      title: '视频工作台',
      status_message: statusMessage(state),
      ...(failureRecovery(state) ? { failure_recovery: failureRecovery(state) } : {}),
      action_pending: Boolean(state.pending_action),
      panels,
      journey: journeyForNoSnapshot(state),
      project_home: { source_count: 0, missing_source_count: 0, changed_source_count: 0, variant_count: 0, operation_count: 0, recovery_required: false, can_import_sources: unavailable('项目尚未加载。') },
      import_scope: { sources: [], uncovered: [], confirm_budget: unavailable('项目尚未加载。'), estimate_budget: unavailable('项目尚未加载。') },
      material_browser: {
        fact_kind: 'evidence_window',
        source_options: [],
        facts: [],
        search_results: [],
        search_count: 0,
        uncovered_count: 0,
        read_facts: unavailable('项目尚未加载。'),
        load_more_facts: unavailable('项目尚未加载。'),
        search: unavailable('项目尚未加载。'),
        load_more_search: unavailable('项目尚未加载。'),
      },
      quick_create: { planning_source: 'unknown', clarifications: [], rationale: [], suggestions: [], drafts: [], can_create_draft: unavailable('项目尚未加载。'), can_accept_selection: unavailable('项目尚未加载。') },
      editorial: { timeline_duration_ms: 0, tracks: [], items: [], selected_item_count: 0, command_set: unavailable('项目尚未加载。') },
      finishing: {
        variants: [], audio_policy: '未选择', music_asset_count: 0, voiceover_asset_count: 0, voiceover_ready: false,
        caption_revision_count: 0, composition_plan_count: 0, audio_finishing_plan_count: 0, can_create_variant: unavailable('项目尚未加载。'),
        can_create_caption: unavailable('项目尚未加载。'),
        can_apply_variant_commands: unavailable('项目尚未加载。'),
        can_translate_captions: unavailable('项目尚未加载。'),
        can_track_subject: unavailable('项目尚未加载。'),
        can_analyze_beat: unavailable('项目尚未加载。'),
        can_create_beat_sync_draft: unavailable('项目尚未加载。'),
      },
      review_delivery: {
        preview_asset: undefined,
        review_notes: [],
        approval_decisions: [],
        create_review_note: unavailable('项目尚未加载。'),
        create_approval_decision: unavailable('项目尚未加载。'),
        quality_reports: [],
        pending_quality_confirmations: [],
        output_verification: { state: 'missing' },
        preflight: unavailable('项目尚未加载。'),
        preview: unavailable('项目尚未加载。'),
        render: unavailable('项目尚未加载。'),
      },
      operation_center: { event_cursor: state.last_event_cursor, reset_required: state.event_reset_required, requires_refresh: state.requires_authoritative_refresh, poll_operations: unavailable('项目尚未加载。'), operations: [] },
    }
  }

  const uncovered = allUncovered(state)
  const timeline = snapshot.current_timeline
  const timelineDurationMs = timelineDurationMilliseconds(timeline)
  const trackCounts = groupItemsByTrack(timeline?.items ?? [])
  const selectedDraft = snapshot.timeline_drafts.find(draft => draft.id === state.selection.timeline_draft_id)
  const selectedVariant = snapshot.variants.find(variant => variant.variant.id === state.selection.variant_id)
  const selectedPreflight = selectedVariant ? qualityState(snapshot.quality_reports, selectedVariant.version) : 'missing'
  const output = deliveryVerification(snapshot.output_verification)
  const hasUsableSource = snapshot.project.sources.some(source => !source.missing && !source.content_changed)
  const sourceNames = new Map(snapshot.project.sources.map(source => [source.id, source.name]))
  const linkedItems = new Map<string, string[]>()
  for (const item of timeline?.items ?? []) {
    if (!item.linked_av_group_id) continue
    const group = linkedItems.get(item.linked_av_group_id) ?? []
    group.push(item.id)
    linkedItems.set(item.linked_av_group_id, group)
  }
  const pendingQuality = pendingPostRenderQualityConfirmations(snapshot)
  const qualityConfirmation = state.event_reset_required || state.requires_authoritative_refresh
    ? unavailable('先重新读取权威项目快照，再确认当前交付文件。')
    : action
  const canRender = action.enabled
    ? selectedVariant
      ? selectedPreflight === 'passed'
        ? readyAction()
        : unavailable('先通过当前交付变体版本的预检。')
      : unavailable('请选择一个交付变体。')
    : action

  return {
    phase: state.phase,
    active_panel: state.panel,
    title: snapshot.project.title,
    status_message: statusMessage(state),
    ...(failureRecovery(state) ? { failure_recovery: failureRecovery(state) } : {}),
    action_pending: Boolean(state.pending_action),
    panels,
    journey: journeyForWorkspace(state, action),
    project_home: {
      source_count: snapshot.project.sources.length,
      missing_source_count: snapshot.project.sources.filter(source => source.missing).length,
      changed_source_count: snapshot.project.sources.filter(source => source.content_changed).length,
      ...(timeline ? { current_timeline_id: timeline.id } : {}),
      variant_count: snapshot.variants.length,
      operation_count: snapshot.operations.length,
      recovery_required: state.event_reset_required || snapshot.operations.some(operation => operation.outcome_unknown),
      ...(creationBriefModel(snapshot.project) ? { creation_brief: creationBriefModel(snapshot.project) } : {}),
      can_import_sources: action,
    },
    import_scope: {
      sources: snapshot.project.sources.map(source => ({
        id: source.id,
        name: source.name,
        duration: `${(source.duration_ms / 1000).toFixed(1)} 秒`,
        state: sourceState(source),
        selected: state.selection.source_id === source.id,
      })),
      ...(state.budget_consent?.estimate ? { active_budget: {
        estimate_hash: state.budget_consent.estimate.estimate_hash,
        requests: state.budget_consent.estimate.requests,
        estimated_amount_micros: state.budget_consent.estimate.estimated_amount_micros,
        asr_seconds: state.budget_consent.estimate.asr_seconds,
        visual_frames: state.budget_consent.estimate.visual_frames,
        state: state.budget_consent.estimate.state,
      } } : {}),
      uncovered,
      confirm_budget: state.budget_consent?.estimate && state.budget_consent.coverage.length
        ? action
        : unavailable('先选择范围并取得当前预算估算。'),
      estimate_budget: action.enabled && snapshot.project.sources.length
        ? hasUsableSource
          ? readyAction()
          : unavailable('当前素材已丢失或内容发生变化，先重新选择素材。')
        : action.enabled ? unavailable('先导入可用素材。') : action,
    },
    material_browser: {
      fact_kind: state.material_fact_kind,
      source_options: snapshot.project.sources.map(source => ({ id: source.id, name: source.name })),
      ...(state.material_fact_source_id ? { source_id: state.material_fact_source_id } : {}),
      facts: snapshot.facts.items.map(fact => ({ ...factModel(fact, sourceNames), selected: state.selection.fact_id === fact.id })),
      ...(state.material_search_query ? { search_query: state.material_search_query } : {}),
      search_results: (snapshot.fact_search?.items ?? []).map(result => ({
        id: result.id,
        kind: result.kind,
        source_id: result.source_id,
        ...(sourceNames.get(result.source_id) ? { source_name: sourceNames.get(result.source_id) } : {}),
        ...(result.segment_id ? { segment_id: result.segment_id } : {}),
        range: rangeText(result.range),
        text: result.text,
        selected: state.selection.fact_id === result.id,
      })),
      ...(snapshot.fact_search ? { search_generation: snapshot.fact_search.generation, search_count: snapshot.fact_search.items.length, ...(snapshot.fact_search.next_cursor ? { next_search_cursor: snapshot.fact_search.next_cursor } : {}) } : { search_count: 0 }),
      ...(snapshot.facts.next_cursor ? { next_fact_cursor: snapshot.facts.next_cursor } : {}),
      uncovered_count: uncovered.length,
      read_facts: action,
      load_more_facts: snapshot.facts.next_cursor ? action : unavailable('当前事实页没有后续结果。'),
      search: action,
      load_more_search: snapshot.fact_search?.next_cursor ? action : unavailable('当前检索页没有后续结果。'),
    },
    quick_create: {
      ...(snapshot.project.brief?.user_goal ? { interpreted_goal: snapshot.project.brief.user_goal } : {}),
      planning_source: planningSource(snapshot.timeline_drafts),
      clarifications: snapshot.project.brief?.gaps ?? [],
      rationale: snapshot.project.brief?.rationale ?? [],
      suggestions: quickCreateSuggestions(snapshot.project, snapshot.timeline_drafts, state.selection.timeline_draft_id),
      drafts: snapshot.timeline_drafts.map(draft => ({
        id: draft.id,
        status: draft.status,
        item_count: draft.items.length,
        partially_acceptable: draftIsPartiallyAcceptable(draft, timeline?.id),
        selected: state.selection.timeline_draft_id === draft.id,
        items: draft.items.map(item => {
          const sourceId = item.binding.kind === 'source' ? item.binding.source_id : undefined
          const sourceRange = item.binding.kind === 'source' ? item.binding.source_range : item.timeline_range
          return {
            id: item.id,
            kind: item.kind,
            range: rangeText(sourceRange),
            ...(sourceId && sourceNames.get(sourceId) ? { source_name: sourceNames.get(sourceId) } : {}),
            selected: state.selection.timeline_draft_id === draft.id && state.selection.draft_item_ids.includes(item.id),
          }
        }),
      })),
      can_accept_selection: action.enabled && selectedDraft && draftIsPartiallyAcceptable(selectedDraft, timeline?.id) && state.selection.draft_item_ids.length
        ? readyAction()
        : unavailable('请选择与当前时间线一致的草稿条目。'),
      can_create_draft: action.enabled && hasUsableSource
        ? readyAction()
        : unavailable('先导入未丢失且未变化的素材，再生成建议草稿。'),
    },
    editorial: {
      ...(timeline ? { timeline_id: timeline.id } : {}),
      timeline_duration_ms: timelineDurationMs,
      tracks: (timeline?.tracks ?? []).map(track => ({
        id: track.id,
        kind: track.kind,
        locked: track.locked,
        muted: track.muted,
        item_count: trackCounts.get(track.id) ?? 0,
      })),
      items: (timeline?.items ?? []).map(item => ({
        id: item.id,
        track_id: item.track_id,
        kind: item.kind,
        ...(item.binding.kind === 'source' ? {
          source_id: item.binding.source_id,
          ...(sourceNames.get(item.binding.source_id) ? { source_name: sourceNames.get(item.binding.source_id) } : {}),
          source_range: rangeText(item.binding.source_range),
        } : {}),
        timeline_range: rangeText(item.timeline_range),
        timeline_start_ms: Number(milliseconds(item.timeline_range.start)),
        timeline_duration_ms: Number(milliseconds(item.timeline_range.duration)),
        timeline_left_percent: timelineDurationMs > 0 ? Math.max(0, Math.min(100, Number(milliseconds(item.timeline_range.start)) / timelineDurationMs * 100)) : 0,
        timeline_width_percent: timelineDurationMs > 0 ? Math.max(1, Math.min(100, Number(milliseconds(item.timeline_range.duration)) / timelineDurationMs * 100)) : 100,
        ...(item.linked_av_group_id ? { linked_av_group_id: item.linked_av_group_id, linked_item_ids: linkedItems.get(item.linked_av_group_id) ?? [item.id] } : { linked_item_ids: [] }),
        locked: item.locked,
        selected: state.selection.timeline_item_ids.includes(item.id),
      })),
      selected_item_count: state.selection.timeline_item_ids.length,
      command_set: timeline ? action : unavailable('当前项目尚无可编辑时间线。'),
    },
    finishing: {
      variants: snapshot.variants.map(projection => ({
        id: projection.variant.id,
        name: projection.variant.name,
        version_id: projection.version.id,
        target: projection.version.export_profile_revision_id,
        caption_mode: snapshot.project.export_profile_revisions.find(profile => profile.id === projection.version.export_profile_revision_id)?.caption_mode ?? 'unknown',
        preflight: qualityState(snapshot.quality_reports, projection.version),
        selected: state.selection.variant_id === projection.variant.id,
      })),
      audio_policy: (() => {
        const activeVariant = selectedVariant ?? snapshot.variants[0]
        const profile = activeVariant
          ? snapshot.project.export_profile_revisions.find(candidate => candidate.id === activeVariant.version.export_profile_revision_id)
          : undefined
        return profile?.audio_policy ? briefLabel(profile.audio_policy) : '未选择'
      })(),
      music_asset_count: (snapshot.project.project_assets ?? []).filter(asset => asset.asset_kind === 'music').length,
      voiceover_asset_count: (snapshot.project.project_assets ?? []).filter(asset => asset.asset_kind === 'voice_over').length,
      voiceover_ready: (snapshot.project.project_assets ?? []).some(asset => asset.asset_kind === 'voice_over')
        && Boolean(timeline?.items.some(item => {
          const track = timeline.tracks.find(candidate => candidate.id === item.track_id)
          return track?.kind === 'voice_over' && item.binding.kind === 'project_asset'
        })),
      caption_revision_count: snapshot.caption_revisions.length,
      composition_plan_count: snapshot.composition_plans.length,
      audio_finishing_plan_count: snapshot.audio_finishing_plans.length,
      can_create_variant: timeline
        ? action
        : unavailable('先确认一条正式编辑时间线，再创建交付变体。'),
      can_create_caption: timeline ? action : unavailable('先创建或选择编辑时间线。'),
      can_apply_variant_commands: selectedVariant ? action : unavailable('先选择一个交付变体。'),
      can_translate_captions: snapshot.caption_documents.length && snapshot.caption_revisions.length && timeline
        ? action
        : unavailable('先选择带锚点的字幕版本和当前编辑时间线。'),
      can_track_subject: state.selection.source_id && hasUsableSource ? action : unavailable('先选择一个未变化且可用的素材来源。'),
      can_analyze_beat: state.selection.source_id && hasUsableSource ? action : unavailable('先选择一个未变化且带音频的素材来源。'),
      can_create_beat_sync_draft: state.selection.source_id && hasUsableSource && timeline
        ? action
        : unavailable('先选择素材、节拍证据和当前编辑时间线。'),
    },
    review_delivery: {
      ...(snapshot.preview ? { preview_asset: {
        asset_id: snapshot.preview.asset_id,
        asset_path: snapshot.preview.asset_path,
        content_hash: snapshot.preview.content_hash,
      } } : {}),
      review_notes: snapshot.project.review_notes.map(note => ({
        id: note.id,
        status: note.status,
        actor_id: note.actor_id,
        body: note.body,
        selected: state.selection.review_note_id === note.id,
        resolve: action.enabled && note.status === 'open'
          ? readyAction()
          : action.enabled ? unavailable('该反馈已有最终处理结果。') : action,
      })),
      approval_decisions: snapshot.project.approval_decisions.map(decision => ({
        id: decision.id,
        state: decision.state,
        actor_id: decision.actor_id,
        note_count: decision.note_ids.length,
      })),
      create_review_note: timeline ? action : unavailable('先创建或选择编辑时间线。'),
      create_approval_decision: timeline ? action : unavailable('先创建或选择编辑时间线。'),
      quality_reports: snapshot.quality_reports.map(report => ({
        id: report.id,
        kind: report.kind,
        state: report.state,
        check_count: report.checks.length,
        selected: state.selection.quality_report_id === report.id,
      })),
      pending_quality_confirmations: pendingQuality.map(pending => ({
        operation_id: pending.operation_id,
        report_id: pending.report_id,
        checks: pending.checks,
        confirm: qualityConfirmation,
      })),
      output_verification: output,
      preflight: selectedVariant ? action : unavailable('请选择一个交付变体。'),
      preview: selectedVariant && selectedPreflight === 'passed' ? action : selectedVariant ? unavailable('先通过当前交付变体版本的预检。') : unavailable('请选择一个交付变体。'),
      render: canRender,
    },
    operation_center: {
      event_cursor: state.last_event_cursor,
      reset_required: state.event_reset_required,
      requires_refresh: state.requires_authoritative_refresh,
      poll_operations: operationReadAvailability(state),
      operations: snapshot.operations.map(operation => operationModel(operation, state.selection.operation_id === operation.id, action.enabled)),
    },
  }
}
