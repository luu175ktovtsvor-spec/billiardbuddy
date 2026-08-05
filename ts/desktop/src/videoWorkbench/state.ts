import type {
  CreateRemoteAnalysisConsentInput,
  MediaSafeError,
  PublicMediaJobEventPage,
  PublicMediaTask,
  PublicVideoFactPage,
  PublicVideoFactSearchPage,
} from '../../../shared/contracts/media.js'
import type {
  VideoBudgetEstimate,
  VideoWorkbenchFactKind,
  VideoWorkbenchPanel,
  VideoWorkbenchPhase,
  VideoWorkbenchSelection,
  VideoWorkbenchSnapshot,
} from './contracts.js'

export type VideoWorkbenchActionKind =
  | 'load_workspace'
  | 'create_project'
  | 'choose_sources'
  | 'add_sources'
  | 'load_facts'
  | 'search_facts'
  | 'create_review_note'
  | 'resolve_review_note'
  | 'create_approval_decision'
  | 'estimate_budget'
  | 'confirm_budget'
  | 'create_quick_draft'
  | 'accept_draft'
  | 'apply_editorial_command_set'
  | 'create_variant'
  | 'apply_variant_command_set'
  | 'create_caption'
  | 'create_caption_translation'
  | 'create_composition_plan'
  | 'create_audio_finishing_plan'
  | 'analyze_beat'
  | 'create_beat_sync_draft'
  | 'analyze_subject_track'
  | 'preflight'
  | 'preview'
  | 'choose_export_destination'
  | 'render'
  | 'confirm_post_render_quality'
  | 'cancel_operation'

export type VideoWorkbenchPendingAction = Readonly<{
  kind: VideoWorkbenchActionKind
  idempotency_key?: string
  operation_id?: string
  started_at: number
}>

export type VideoBudgetConsentDraft = Readonly<{
  purposes: readonly CreateRemoteAnalysisConsentInput['purposes'][number][]
  data_kinds: readonly CreateRemoteAnalysisConsentInput['data_kinds'][number][]
  coverage: CreateRemoteAnalysisConsentInput['coverage']
  estimate?: VideoBudgetEstimate
}>

export type VideoWorkbenchUiState = Readonly<{
  phase: VideoWorkbenchPhase
  panel: VideoWorkbenchPanel
  snapshot?: VideoWorkbenchSnapshot
  selection: VideoWorkbenchSelection
  budget_consent?: VideoBudgetConsentDraft
  pending_action?: VideoWorkbenchPendingAction
  last_error?: MediaSafeError
  last_event_cursor: number
  event_reset_required: boolean
  requires_authoritative_refresh: boolean
  /** Workspace hydration starts at evidence windows; explicit fact reads own this filter. */
  material_fact_kind: VideoWorkbenchFactKind
  material_fact_source_id?: string
  material_search_query?: string
}>

export type VideoWorkbenchUiEvent =
  | Readonly<{ type: 'hydrate'; snapshot: VideoWorkbenchSnapshot }>
  | Readonly<{ type: 'set_panel'; panel: VideoWorkbenchPanel }>
  | Readonly<{ type: 'select'; selection: Partial<VideoWorkbenchSelection> }>
  | Readonly<{ type: 'set_budget_consent'; draft?: VideoBudgetConsentDraft }>
  | Readonly<{ type: 'begin_action'; action: VideoWorkbenchPendingAction }>
  | Readonly<{ type: 'action_cancelled' }>
  | Readonly<{ type: 'action_failed'; error: MediaSafeError }>
  | Readonly<{ type: 'action_completed' }>
  | Readonly<{ type: 'facts_loaded'; kind: VideoWorkbenchFactKind; source_id?: string; append: boolean; page: PublicVideoFactPage }>
  | Readonly<{ type: 'facts_invalidated'; kind: VideoWorkbenchFactKind; source_id?: string }>
  | Readonly<{ type: 'fact_search_loaded'; query: string; append: boolean; page: PublicVideoFactSearchPage }>
  | Readonly<{ type: 'fact_search_invalidated'; query: string }>
  | Readonly<{ type: 'operation_events'; page: PublicMediaJobEventPage }>
  | Readonly<{ type: 'connection_lost' }>
  | Readonly<{ type: 'connection_restored' }>

function emptySelection(): VideoWorkbenchSelection {
  return { draft_item_ids: [], timeline_item_ids: [] }
}

function selectedOrUndefined<Value>(value: Value | undefined, accepted: readonly Value[]): Value | undefined {
  return value !== undefined && accepted.includes(value) ? value : undefined
}

function preserveSelection(selection: VideoWorkbenchSelection, snapshot: VideoWorkbenchSnapshot): VideoWorkbenchSelection {
  const sourceIds = snapshot.project.sources.map(source => source.id)
  const factIds = snapshot.facts.items.map(fact => fact.id)
  const draftIds = snapshot.timeline_drafts.map(draft => draft.id)
  const variantIds = snapshot.variants.map(variant => variant.variant.id)
  const reportIds = snapshot.quality_reports.map(report => report.id)
  const reviewNoteIds = snapshot.project.review_notes.map(note => note.id)
  const operationIds = snapshot.operations.map(operation => operation.id)
  const draftItemIds = new Set(snapshot.timeline_drafts.flatMap(draft => draft.items.map(item => item.id)))
  const timelineItemIds = new Set(snapshot.current_timeline?.items.map(item => item.id) ?? [])
  return {
    source_id: selectedOrUndefined(selection.source_id, sourceIds),
    fact_id: selectedOrUndefined(selection.fact_id, factIds),
    timeline_draft_id: selectedOrUndefined(selection.timeline_draft_id, draftIds),
    draft_item_ids: selection.draft_item_ids.filter(itemId => draftItemIds.has(itemId)),
    timeline_item_ids: selection.timeline_item_ids.filter(itemId => timelineItemIds.has(itemId)),
    variant_id: selectedOrUndefined(selection.variant_id, variantIds),
    quality_report_id: selectedOrUndefined(selection.quality_report_id, reportIds),
    review_note_id: selectedOrUndefined(selection.review_note_id, reviewNoteIds),
    operation_id: selectedOrUndefined(selection.operation_id, operationIds),
  }
}

function phaseForSnapshot(snapshot: VideoWorkbenchSnapshot): VideoWorkbenchPhase {
  if (snapshot.project.error_code || snapshot.project.state === 'failed') return 'failed'
  if (!snapshot.project.sources.length) return 'empty'
  if (snapshot.project.sources.some(source => source.missing)) return 'missing'
  if (snapshot.project.sources.some(source => source.content_changed)) return 'stale'
  if (snapshot.operations.some(operation => operation.outcome_unknown)) return 'needs_user_decision'
  if (snapshot.project.state === 'rendering') return 'partial'
  if (snapshot.operations.some(operation => operation.status === 'running' || operation.status === 'queued' || operation.status === 'committing')) return 'partial'
  return 'ready'
}

function isTerminal(operation: PublicMediaTask): boolean {
  return operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'cancelled'
}

function mergePageItems<Item extends { id: string }>(
  existing: readonly Item[],
  incoming: readonly Item[],
): Item[] {
  const byId = new Map(existing.map(item => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()]
}

function mergeOperationEvents(
  snapshot: VideoWorkbenchSnapshot,
  page: PublicMediaJobEventPage,
): VideoWorkbenchSnapshot {
  const byId = new Map(snapshot.operations.map(operation => [operation.id, operation]))
  for (const event of page.events) {
    const current = byId.get(event.task.id)
    if (!current || event.status_sequence >= current.status_sequence) byId.set(event.task.id, event.task)
  }
  return { ...snapshot, operations: [...byId.values()], events: page }
}

function continuationCursor(page: PublicMediaJobEventPage): number {
  return Math.max(0, page.next_cursor - 1)
}

export function createVideoWorkbenchUiState(panel: VideoWorkbenchPanel = 'project_home'): VideoWorkbenchUiState {
  return {
    phase: 'loading',
    panel,
    selection: emptySelection(),
    last_event_cursor: 0,
    event_reset_required: false,
    requires_authoritative_refresh: false,
    material_fact_kind: 'evidence_window',
  }
}

/**
 * This reducer never optimistically writes a project, timeline, draft, or
 * variant. A completed command stays pending until a loaded snapshot or a
 * durable operation event proves what the Sidecar actually committed.
 */
export function reduceVideoWorkbenchUiState(
  state: VideoWorkbenchUiState,
  event: VideoWorkbenchUiEvent,
): VideoWorkbenchUiState {
  switch (event.type) {
    case 'hydrate':
      // Repository snapshots are writer-fenced, but merge a non-reset page as
      // defense in depth: an Operation event always carries the newest durable
      // status sequence and must not be discarded while its cursor advances.
      {
        const snapshot = event.snapshot.events.reset_required
          ? event.snapshot
          : mergeOperationEvents(event.snapshot, event.snapshot.events)
      return {
        ...state,
        phase: phaseForSnapshot(snapshot),
        snapshot,
        selection: preserveSelection(state.selection, snapshot),
        pending_action: undefined,
        last_error: undefined,
        last_event_cursor: continuationCursor(snapshot.events),
        // loadWorkspace is a complete authoritative operation/project query.
        // It is precisely the recovery action required after an event reset.
        event_reset_required: false,
        requires_authoritative_refresh: false,
        material_fact_kind: 'evidence_window',
        material_fact_source_id: undefined,
        material_search_query: undefined,
      }
      }
    case 'set_panel':
      return { ...state, panel: event.panel }
    case 'select': {
      const draftItemIds = event.selection.draft_item_ids
        ? [...new Set(event.selection.draft_item_ids)]
        : state.selection.draft_item_ids
      const timelineItemIds = event.selection.timeline_item_ids
        ? [...new Set(event.selection.timeline_item_ids)]
        : state.selection.timeline_item_ids
      return { ...state, selection: { ...state.selection, ...event.selection, draft_item_ids: draftItemIds, timeline_item_ids: timelineItemIds } }
    }
    case 'set_budget_consent':
      return { ...state, budget_consent: event.draft }
    case 'begin_action':
      return { ...state, pending_action: event.action, last_error: undefined }
    case 'action_cancelled':
      return { ...state, pending_action: undefined, last_error: undefined }
    case 'action_failed':
      return { ...state, pending_action: undefined, last_error: event.error }
    case 'action_completed':
      return {
        ...state,
        pending_action: undefined,
        // A command response is not a replacement for the complete snapshot.
        requires_authoritative_refresh: true,
      }
    case 'facts_loaded': {
      if (!state.snapshot) return { ...state, pending_action: undefined, last_error: undefined }
      const items = event.append
        ? mergePageItems(state.snapshot.facts.items, event.page.items)
        : [...event.page.items]
      const snapshot = { ...state.snapshot, facts: { ...event.page, items } }
      return {
        ...state,
        phase: phaseForSnapshot(snapshot),
        snapshot,
        selection: {
          ...state.selection,
          fact_id: selectedOrUndefined(state.selection.fact_id, items.map(item => item.id)),
        },
        material_fact_kind: event.kind,
        material_fact_source_id: event.source_id,
        pending_action: undefined,
        last_error: undefined,
      }
    }
    case 'facts_invalidated': {
      if (!state.snapshot) return { ...state, pending_action: undefined }
      return {
        ...state,
        snapshot: { ...state.snapshot, facts: { schema_version: 1, items: [] } },
        selection: { ...state.selection, fact_id: undefined },
        material_fact_kind: event.kind,
        material_fact_source_id: event.source_id,
        pending_action: undefined,
      }
    }
    case 'fact_search_loaded': {
      if (!state.snapshot) return { ...state, pending_action: undefined, last_error: undefined }
      const sameGeneration = state.snapshot.fact_search?.generation === event.page.generation
      const items = event.append && state.material_search_query === event.query && sameGeneration
        ? mergePageItems(state.snapshot.fact_search?.items ?? [], event.page.items)
        : [...event.page.items]
      const snapshot = { ...state.snapshot, fact_search: { ...event.page, items } }
      return {
        ...state,
        snapshot,
        material_search_query: event.query,
        pending_action: undefined,
        last_error: undefined,
      }
    }
    case 'fact_search_invalidated': {
      if (!state.snapshot) return { ...state, pending_action: undefined }
      const { fact_search: _factSearch, ...snapshot } = state.snapshot
      return {
        ...state,
        snapshot,
        material_search_query: event.query,
        pending_action: undefined,
      }
    }
    case 'operation_events': {
      if (!state.snapshot) return {
        ...state,
        last_event_cursor: continuationCursor(event.page),
        event_reset_required: event.page.reset_required,
        requires_authoritative_refresh: state.requires_authoritative_refresh || event.page.reset_required,
      }
      if (event.page.reset_required) {
        return {
          ...state,
          last_event_cursor: continuationCursor(event.page),
          event_reset_required: true,
          requires_authoritative_refresh: true,
        }
      }
      const snapshot = mergeOperationEvents(state.snapshot, event.page)
      const eventFinishedAction = state.pending_action?.operation_id
        ? snapshot.operations.find(operation => operation.id === state.pending_action?.operation_id)
        : undefined
      return {
        ...state,
        snapshot,
        phase: phaseForSnapshot(snapshot),
        pending_action: eventFinishedAction && isTerminal(eventFinishedAction) ? undefined : state.pending_action,
        last_event_cursor: Math.max(state.last_event_cursor, continuationCursor(event.page), ...event.page.events.map(item => item.cursor)),
        event_reset_required: false,
        requires_authoritative_refresh: state.requires_authoritative_refresh || Boolean(eventFinishedAction && isTerminal(eventFinishedAction)),
      }
    }
    case 'connection_lost':
      return { ...state, phase: 'offline' }
    case 'connection_restored':
      return { ...state, phase: state.snapshot ? phaseForSnapshot(state.snapshot) : 'loading' }
  }
}

export function createBudgetConsentInput(draft: VideoBudgetConsentDraft): CreateRemoteAnalysisConsentInput {
  if (!draft.estimate) throw new VideoWorkbenchBudgetError('当前没有可确认的预算估算。')
  return {
    purposes: [...draft.purposes],
    data_kinds: [...draft.data_kinds],
    coverage: draft.coverage,
    acknowledged_estimate_hash: draft.estimate.estimate_hash,
  }
}

export class VideoWorkbenchBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoWorkbenchBudgetError'
  }
}
