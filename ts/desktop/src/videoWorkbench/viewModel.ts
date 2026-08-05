import type {
  DeliveryVariantVersion,
  PublicMediaTask,
  PublicVideoFactSummary,
  VideoOutputVerification,
  VideoQualityReport,
  VideoTimelineItem,
} from '../../../shared/contracts/media.js'
import { draftIsPartiallyAcceptable } from './commandSet.js'
import { VIDEO_WORKBENCH_PANELS, type VideoWorkbenchFactKind, type VideoWorkbenchPanel, type VideoWorkbenchPhase } from './contracts.js'
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

export type VideoOperationRecoveryModel = Readonly<{
  id: string
  kind: string
  status: PublicMediaTask['status']
  stage: string
  progress: number
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
  project_home: Readonly<{
    source_count: number
    missing_source_count: number
    changed_source_count: number
    current_timeline_id?: string
    variant_count: number
    operation_count: number
    recovery_required: boolean
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
    drafts: readonly Readonly<{
      id: string
      status: string
      item_count: number
      partially_acceptable: boolean
      selected: boolean
      items: readonly Readonly<{ id: string; kind: string; selected: boolean }>[]
    }>[]
    can_create_draft: VideoWorkbenchActionAvailability
    can_accept_selection: VideoWorkbenchActionAvailability
  }>
  editorial: Readonly<{
    timeline_id?: string
    tracks: readonly Readonly<{ id: string; kind: string; locked: boolean; muted: boolean; item_count: number }>[]
    items: readonly Readonly<{ id: string; track_id: string; kind: string; locked: boolean; selected: boolean }>[]
    selected_item_count: number
    command_set: VideoWorkbenchActionAvailability
  }>
  finishing: Readonly<{
    variants: readonly Readonly<{ id: string; name: string; version_id: string; target: string; caption_mode: string; preflight: 'passed' | 'blocked' | 'needs_user_decision' | 'missing'; selected: boolean }>[]
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
  import_scope: '导入与范围',
  material_browser: '素材',
  quick_create: '快速创建',
  editorial: '编辑',
  finishing: '完成与变体',
  review_delivery: '审阅与交付',
  operation_center: '操作中心',
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
  const canRetry = operation.status === 'failed' || operation.status === 'cancelled'
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    stage: operation.stage,
    progress: operation.progress,
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
      quick_create: { drafts: [], can_create_draft: unavailable('项目尚未加载。'), can_accept_selection: unavailable('项目尚未加载。') },
      editorial: { tracks: [], items: [], selected_item_count: 0, command_set: unavailable('项目尚未加载。') },
      finishing: {
        variants: [], caption_revision_count: 0, composition_plan_count: 0, audio_finishing_plan_count: 0, can_create_variant: unavailable('项目尚未加载。'),
        can_create_caption: unavailable('项目尚未加载。'),
        can_apply_variant_commands: unavailable('项目尚未加载。'),
        can_translate_captions: unavailable('项目尚未加载。'),
        can_track_subject: unavailable('项目尚未加载。'),
        can_analyze_beat: unavailable('项目尚未加载。'),
        can_create_beat_sync_draft: unavailable('项目尚未加载。'),
      },
      review_delivery: { quality_reports: [], pending_quality_confirmations: [], output_verification: { state: 'missing' }, preflight: unavailable('项目尚未加载。'), preview: unavailable('项目尚未加载。'), render: unavailable('项目尚未加载。') },
      operation_center: { event_cursor: state.last_event_cursor, reset_required: state.event_reset_required, requires_refresh: state.requires_authoritative_refresh, poll_operations: unavailable('项目尚未加载。'), operations: [] },
    }
  }

  const uncovered = allUncovered(state)
  const timeline = snapshot.current_timeline
  const trackCounts = groupItemsByTrack(timeline?.items ?? [])
  const selectedDraft = snapshot.timeline_drafts.find(draft => draft.id === state.selection.timeline_draft_id)
  const selectedVariant = snapshot.variants.find(variant => variant.variant.id === state.selection.variant_id)
  const selectedPreflight = selectedVariant ? qualityState(snapshot.quality_reports, selectedVariant.version) : 'missing'
  const output = deliveryVerification(snapshot.output_verification)
  const sourceNames = new Map(snapshot.project.sources.map(source => [source.id, source.name]))
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
    project_home: {
      source_count: snapshot.project.sources.length,
      missing_source_count: snapshot.project.sources.filter(source => source.missing).length,
      changed_source_count: snapshot.project.sources.filter(source => source.content_changed).length,
      ...(timeline ? { current_timeline_id: timeline.id } : {}),
      variant_count: snapshot.variants.length,
      operation_count: snapshot.operations.length,
      recovery_required: state.event_reset_required || snapshot.operations.some(operation => operation.outcome_unknown),
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
        ? readyAction()
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
      drafts: snapshot.timeline_drafts.map(draft => ({
        id: draft.id,
        status: draft.status,
        item_count: draft.items.length,
        partially_acceptable: draftIsPartiallyAcceptable(draft, timeline?.id),
        selected: state.selection.timeline_draft_id === draft.id,
        items: draft.items.map(item => ({
          id: item.id,
          kind: item.kind,
          selected: state.selection.timeline_draft_id === draft.id && state.selection.draft_item_ids.includes(item.id),
        })),
      })),
      can_accept_selection: action.enabled && selectedDraft && draftIsPartiallyAcceptable(selectedDraft, timeline?.id) && state.selection.draft_item_ids.length
        ? readyAction()
        : unavailable('请选择与当前时间线一致的草稿条目。'),
      can_create_draft: action.enabled && snapshot.project.sources.length
        ? readyAction()
        : unavailable('先导入可用素材并确认项目状态。'),
    },
    editorial: {
      ...(timeline ? { timeline_id: timeline.id } : {}),
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
      caption_revision_count: snapshot.caption_revisions.length,
      composition_plan_count: snapshot.composition_plans.length,
      audio_finishing_plan_count: snapshot.audio_finishing_plans.length,
      can_create_variant: action,
      can_create_caption: timeline ? action : unavailable('先创建或选择编辑时间线。'),
      can_apply_variant_commands: selectedVariant ? action : unavailable('先选择一个交付变体。'),
      can_translate_captions: snapshot.caption_documents.length && snapshot.caption_revisions.length && timeline
        ? action
        : unavailable('先选择带锚点的字幕版本和当前编辑时间线。'),
      can_track_subject: state.selection.source_id ? action : unavailable('先选择一个素材来源。'),
      can_analyze_beat: state.selection.source_id ? action : unavailable('先选择一个带音频的素材来源。'),
      can_create_beat_sync_draft: state.selection.source_id && timeline
        ? action
        : unavailable('先选择素材、节拍证据和当前编辑时间线。'),
    },
    review_delivery: {
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
