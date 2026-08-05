import { mediaSafeError, type AnalyzeVideoBeatInput, type AnalyzeVideoProjectInput, type AnalyzeVideoSubjectTrackInput, type CreateDeliveryVariantInput, type CreateRemoteAnalysisConsentInput, type CreateVideoAudioFinishingPlanInput, type CreateVideoBeatSyncDraftInput, type CreateVideoCaptionDraftInput, type CreateVideoCaptionRevisionInput, type CreateVideoCaptionTranslationInput, type CreateVideoCompositionPlanInput, type DeliveryVariantCommand, type EditorialTimelineCommand, type PublicMediaTask } from '../../../shared/contracts/media.js'
import {
  buildDeliveryVariantCommandRequest,
  buildEditorialCommandRequest,
  buildPartialDraftAcceptance,
} from './commandSet.js'
import type { VideoBudgetConsentDraft, VideoWorkbenchActionKind, VideoWorkbenchPendingAction, VideoWorkbenchUiEvent, VideoWorkbenchUiState } from './state.js'
import { createBudgetConsentInput, createVideoWorkbenchUiState, reduceVideoWorkbenchUiState } from './state.js'
import type { VideoExportDestinationGrant, VideoFactPageRequest, VideoFactSearchRequest, VideoPostRenderQualityConfirmationResult, VideoWorkbenchBridge, VideoWorkbenchFactKind, VideoWorkbenchResult } from './contracts.js'
import { pendingPostRenderQualityConfirmation, type VideoPendingPostRenderQualityConfirmation } from './qualityConfirmation.js'

export type VideoWorkbenchStateListener = (state: VideoWorkbenchUiState) => void

function nowAction(kind: VideoWorkbenchActionKind, idempotencyKey?: string, operationId?: string): VideoWorkbenchPendingAction {
  return {
    kind,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(operationId ? { operation_id: operationId } : {}),
    started_at: Date.now(),
  }
}

/**
 * An injected Main-IPC controller. It contains no direct fetch, filesystem,
 * Relay, or Electron imports, which makes the renderer safe to construct
 * before the shared Main/preload ownership window opens.
 */
export class VideoWorkbenchController {
  private state: VideoWorkbenchUiState
  private readonly listeners = new Set<VideoWorkbenchStateListener>()

  constructor(
    readonly projectId: string,
    private readonly bridge: VideoWorkbenchBridge,
    initialState: VideoWorkbenchUiState = createVideoWorkbenchUiState(),
  ) {
    this.state = initialState
  }

  getState(): VideoWorkbenchUiState {
    return this.state
  }

  subscribe(listener: VideoWorkbenchStateListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  dispatch(event: VideoWorkbenchUiEvent): VideoWorkbenchUiState {
    this.state = reduceVideoWorkbenchUiState(this.state, event)
    for (const listener of this.listeners) listener(this.state)
    return this.state
  }

  async refresh(): Promise<VideoWorkbenchResult<void>> {
    try {
      const response = await this.bridge.loadWorkspace(this.projectId, this.state.last_event_cursor)
      if ('error' in response) {
        this.dispatch({ type: 'action_failed', error: response.error })
        return { ok: false, error: response.error }
      }
      this.dispatch({ type: 'hydrate', snapshot: response.value })
      return { ok: true, value: undefined }
    } catch {
      const error = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
  }

  async pollOperationEvents(): Promise<VideoWorkbenchResult<void>> {
    try {
      const response = await this.bridge.loadOperationEvents(this.projectId, this.state.last_event_cursor)
      if ('error' in response) {
        this.dispatch({ type: 'connection_lost' })
        this.dispatch({ type: 'action_failed', error: response.error })
        return { ok: false, error: response.error }
      }
      this.dispatch({ type: 'connection_restored' })
      this.dispatch({ type: 'operation_events', page: response.value })
      if (this.state.requires_authoritative_refresh) return await this.refresh()
      return { ok: true, value: undefined }
    } catch {
      const error = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
      this.dispatch({ type: 'connection_lost' })
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
  }

  private async run<Value>(
    kind: VideoWorkbenchActionKind,
    idempotencyKey: string | undefined,
    call: () => Promise<VideoWorkbenchResult<Value>>,
  ): Promise<VideoWorkbenchResult<Value>> {
    if (this.state.event_reset_required || this.state.requires_authoritative_refresh) return this.staleSnapshot()
    this.dispatch({ type: 'begin_action', action: nowAction(kind, idempotencyKey) })
    try {
      const response = await call()
      if ('error' in response) {
        this.dispatch({ type: 'action_failed', error: response.error })
        return response
      }
      this.dispatch({ type: 'action_completed' })
      await this.refresh()
      return response
    } catch {
      const error = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
  }

  async chooseAndAddSources(idempotencyKey: string): Promise<VideoWorkbenchResult<readonly PublicMediaTask[]>> {
    if (this.state.event_reset_required || this.state.requires_authoritative_refresh) return this.staleSnapshot()
    this.dispatch({ type: 'begin_action', action: nowAction('choose_sources') })
    try {
      const picked = await this.bridge.chooseSources(this.projectId)
      if ('error' in picked) {
        this.dispatch({ type: 'action_failed', error: picked.error })
        return { ok: false, error: picked.error }
      }
      this.dispatch({ type: 'action_cancelled' })
      if (!picked.value.length) return { ok: true, value: [] }
      return await this.run('add_sources', idempotencyKey, async () => await this.bridge.addSources(this.projectId, picked.value.map(selection => selection.selection_id), idempotencyKey))
    } catch {
      const error = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
  }

  async loadFacts(kind: VideoWorkbenchFactKind, request: VideoFactPageRequest = {}): Promise<VideoWorkbenchResult<void>> {
    this.dispatch({ type: 'begin_action', action: nowAction('load_facts') })
    try {
      const response = await this.bridge.loadFacts(this.projectId, kind, request)
      if ('error' in response) {
        this.dispatch({ type: 'action_failed', error: response.error })
        if (request.cursor && response.error.code === 'MEDIA_INVALID_REQUEST') {
          this.dispatch({ type: 'facts_invalidated', kind, ...(request.source_id ? { source_id: request.source_id } : {}) })
          return await this.loadFacts(kind, request.source_id ? { source_id: request.source_id } : {})
        }
        return { ok: false, error: response.error }
      }
      this.dispatch({
        type: 'facts_loaded',
        kind,
        ...(request.source_id ? { source_id: request.source_id } : {}),
        append: Boolean(request.cursor),
        page: response.value,
      })
      return { ok: true, value: undefined }
    } catch {
      const error = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
  }

  async loadMoreFacts(): Promise<VideoWorkbenchResult<void>> {
    const cursor = this.state.snapshot?.facts.next_cursor
    if (!cursor) return this.invalidRequest()
    return await this.loadFacts(this.state.material_fact_kind, {
      ...(this.state.material_fact_source_id ? { source_id: this.state.material_fact_source_id } : {}),
      cursor,
    })
  }

  async searchFacts(query: string, request: VideoFactSearchRequest = {}): Promise<VideoWorkbenchResult<void>> {
    const normalizedQuery = query.trim()
    if (!normalizedQuery || normalizedQuery.length > 1_000) return this.invalidRequest()
    if (request.cursor && this.state.material_search_query !== normalizedQuery) return this.invalidRequest()
    this.dispatch({ type: 'begin_action', action: nowAction('search_facts') })
    try {
      const response = await this.bridge.searchFacts(this.projectId, normalizedQuery, request)
      if ('error' in response) {
        this.dispatch({ type: 'action_failed', error: response.error })
        // A search index generation may advance between pages.  The old page
        // can no longer be appended, so retry the same read from its head.
        if (request.cursor && response.error.code === 'MEDIA_INVALID_REQUEST') {
          this.dispatch({ type: 'fact_search_invalidated', query: normalizedQuery })
          return await this.searchFacts(normalizedQuery)
        }
        return { ok: false, error: response.error }
      }
      this.dispatch({ type: 'fact_search_loaded', query: normalizedQuery, append: Boolean(request.cursor), page: response.value })
      return { ok: true, value: undefined }
    } catch {
      const error = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
  }

  async loadMoreFactSearch(): Promise<VideoWorkbenchResult<void>> {
    const query = this.state.material_search_query
    const cursor = this.state.snapshot?.fact_search?.next_cursor
    if (!query || !cursor) return this.invalidRequest()
    return await this.searchFacts(query, { cursor })
  }

  async estimateBudget(
    idempotencyKey: string,
    purposes: readonly CreateRemoteAnalysisConsentInput['purposes'][number][],
    sourceIds: readonly string[],
    draft: Omit<VideoBudgetConsentDraft, 'estimate' | 'purposes'>,
  ): Promise<VideoWorkbenchResult<VideoBudgetConsentDraft['estimate']>> {
    const response = await this.run('estimate_budget', idempotencyKey, async () => await this.bridge.estimateRemoteAnalysis(this.projectId, {
      idempotency_key: idempotencyKey,
      input: { purposes, source_ids: sourceIds },
    }))
    if (!response.ok) return response
    const consent: VideoBudgetConsentDraft = {
      purposes,
      data_kinds: draft.data_kinds,
      coverage: draft.coverage,
      estimate: response.value,
    }
    this.dispatch({ type: 'set_budget_consent', draft: consent })
    return { ok: true, value: response.value }
  }

  async confirmBudget(idempotencyKey: string): Promise<VideoWorkbenchResult<unknown>> {
    const draft = this.state.budget_consent
    if (!draft) {
      const error = mediaSafeError('MEDIA_INVALID_REQUEST')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
    let input: CreateRemoteAnalysisConsentInput
    try {
      input = createBudgetConsentInput(draft)
    } catch {
      const error = mediaSafeError('MEDIA_INVALID_REQUEST')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
    return await this.run('confirm_budget', idempotencyKey, async () => await this.bridge.grantRemoteAnalysisConsent(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async createQuickDraft(idempotencyKey: string, input: AnalyzeVideoProjectInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_quick_draft', idempotencyKey, async () => await this.bridge.createQuickDraft(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async acceptSelectedDraft(idempotencyKey: string): Promise<VideoWorkbenchResult<unknown>> {
    const snapshot = this.state.snapshot
    const draftId = this.state.selection.timeline_draft_id
    if (!snapshot || !draftId) return this.invalidRequest()
    try {
      const input = buildPartialDraftAcceptance(snapshot, draftId, this.state.selection.draft_item_ids)
      return await this.run('accept_draft', idempotencyKey, async () => await this.bridge.applyEditorialCommandSet(this.projectId, { idempotency_key: idempotencyKey, input }))
    } catch {
      return this.invalidRequest()
    }
  }

  async applyEditorialCommands(idempotencyKey: string, commands: readonly EditorialTimelineCommand[]): Promise<VideoWorkbenchResult<unknown>> {
    const snapshot = this.state.snapshot
    if (!snapshot) return this.invalidRequest()
    try {
      const input = buildEditorialCommandRequest(snapshot, commands)
      return await this.run('apply_editorial_command_set', idempotencyKey, async () => await this.bridge.applyEditorialCommandSet(this.projectId, { idempotency_key: idempotencyKey, input }))
    } catch {
      return this.invalidRequest()
    }
  }

  async createVariant(idempotencyKey: string, input: CreateDeliveryVariantInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_variant', idempotencyKey, async () => await this.bridge.createDeliveryVariant(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async applyVariantCommands(idempotencyKey: string, variantId: string, commands: readonly DeliveryVariantCommand[]): Promise<VideoWorkbenchResult<unknown>> {
    const snapshot = this.state.snapshot
    if (!snapshot) return this.invalidRequest()
    try {
      const input = buildDeliveryVariantCommandRequest(snapshot, variantId, commands)
      return await this.run('apply_variant_command_set', idempotencyKey, async () => await this.bridge.applyDeliveryVariantCommandSet(this.projectId, variantId, { idempotency_key: idempotencyKey, input }))
    } catch {
      return this.invalidRequest()
    }
  }

  async createCaptionDraft(idempotencyKey: string, input: CreateVideoCaptionDraftInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_caption', idempotencyKey, async () => await this.bridge.createCaptionDraft(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async createCaptionRevision(idempotencyKey: string, documentId: string, input: CreateVideoCaptionRevisionInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_caption', idempotencyKey, async () => await this.bridge.createCaptionRevision(this.projectId, documentId, { idempotency_key: idempotencyKey, input }))
  }

  async createCaptionTranslation(idempotencyKey: string, documentId: string, input: CreateVideoCaptionTranslationInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_caption_translation', idempotencyKey, async () => await this.bridge.createCaptionTranslation(this.projectId, documentId, { idempotency_key: idempotencyKey, input }))
  }

  async createCompositionPlan(idempotencyKey: string, input: CreateVideoCompositionPlanInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_composition_plan', idempotencyKey, async () => await this.bridge.createCompositionPlan(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async createAudioFinishingPlan(idempotencyKey: string, input: CreateVideoAudioFinishingPlanInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_audio_finishing_plan', idempotencyKey, async () => await this.bridge.createAudioFinishingPlan(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async analyzeBeat(idempotencyKey: string, input: AnalyzeVideoBeatInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('analyze_beat', idempotencyKey, async () => await this.bridge.analyzeBeat(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async createBeatSyncDraft(idempotencyKey: string, input: CreateVideoBeatSyncDraftInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('create_beat_sync_draft', idempotencyKey, async () => await this.bridge.createBeatSyncDraft(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async analyzeSubjectTrack(idempotencyKey: string, input: AnalyzeVideoSubjectTrackInput): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('analyze_subject_track', idempotencyKey, async () => await this.bridge.analyzeSubjectTrack(this.projectId, { idempotency_key: idempotencyKey, input }))
  }

  async preflight(idempotencyKey: string, variantId: string): Promise<VideoWorkbenchResult<unknown>> {
    const input = this.variantRevisionInput(variantId)
    if (!input) return this.invalidRequest()
    return await this.run('preflight', idempotencyKey, async () => await this.bridge.preflightVariant(this.projectId, variantId, { idempotency_key: idempotencyKey, input }))
  }

  async preview(idempotencyKey: string, variantId: string): Promise<VideoWorkbenchResult<unknown>> {
    const input = this.variantRevisionInput(variantId)
    if (!input) return this.invalidRequest()
    return await this.run('preview', idempotencyKey, async () => await this.bridge.previewVariant(this.projectId, variantId, { idempotency_key: idempotencyKey, input }))
  }

  async render(idempotencyKey: string, variantId: string): Promise<VideoWorkbenchResult<unknown>> {
    if (this.state.event_reset_required || this.state.requires_authoritative_refresh) return this.staleSnapshot()
    const input = this.variantRevisionInput(variantId)
    if (!input) return this.invalidRequest()
    this.dispatch({ type: 'begin_action', action: nowAction('choose_export_destination', idempotencyKey) })
    try {
      const destination = await this.bridge.chooseExportDestination(this.projectId, variantId)
      if ('error' in destination) {
        this.dispatch({ type: 'action_failed', error: destination.error })
        return { ok: false, error: destination.error }
      }
      this.dispatch({ type: 'action_cancelled' })
      const selectedDestination = destination.value
      if (!selectedDestination) return { ok: true, value: undefined }
      return await this.run('render', idempotencyKey, async () => await this.bridge.renderVariant(this.projectId, variantId, selectedDestination, { idempotency_key: idempotencyKey, input }))
    } catch {
      const error = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
      this.dispatch({ type: 'action_failed', error })
      return { ok: false, error }
    }
  }

  /**
   * This is deliberately not called by refresh or event polling.  A person
   * must initiate this method after seeing the immutable warning list.  The
   * renderer derives the binding from the current authoritative snapshot so it
   * cannot confirm a different report, output hash, or subset of warnings.
   */
  pendingPostRenderQualityConfirmation(operationId: string): VideoPendingPostRenderQualityConfirmation | undefined {
    const snapshot = this.state.snapshot
    const operation = snapshot?.operations.find(candidate => candidate.id === operationId)
    return snapshot && operation ? pendingPostRenderQualityConfirmation(snapshot, operation) : undefined
  }

  async confirmPostRenderQuality(idempotencyKey: string, operationId: string): Promise<VideoWorkbenchResult<VideoPostRenderQualityConfirmationResult>> {
    const pending = this.pendingPostRenderQualityConfirmation(operationId)
    if (!pending) return this.invalidRequest()
    return await this.run('confirm_post_render_quality', idempotencyKey, async () => await this.bridge.confirmPostRenderQuality(this.projectId, operationId, {
      idempotency_key: idempotencyKey,
      input: {
        report_id: pending.report_id,
        output_content_hash: pending.output_content_hash,
        accepted_check_ids: [...pending.accepted_check_ids],
      },
    }))
  }

  async cancelOperation(operationId: string): Promise<VideoWorkbenchResult<unknown>> {
    return await this.run('cancel_operation', undefined, async () => await this.bridge.cancelOperation(operationId))
  }

  private variantRevisionInput(variantId: string): { base_revision: number; base_variant_version_id: string } | undefined {
    const snapshot = this.state.snapshot
    const variant = snapshot?.variants.find(candidate => candidate.variant.id === variantId)
    if (!snapshot || !variant) return undefined
    return { base_revision: snapshot.project.revision, base_variant_version_id: variant.version.id }
  }

  private invalidRequest<Value>(): VideoWorkbenchResult<Value> {
    const error = mediaSafeError('MEDIA_INVALID_REQUEST')
    this.dispatch({ type: 'action_failed', error })
    return { ok: false, error }
  }

  private staleSnapshot<Value>(): VideoWorkbenchResult<Value> {
    const error = mediaSafeError('MEDIA_STATE_CONFLICT')
    this.dispatch({ type: 'action_failed', error })
    return { ok: false, error }
  }
}

/** Keeps destination grants opaque at the controller seam. */
export function selectedExportDestination(destination: VideoExportDestinationGrant): VideoExportDestinationGrant {
  return destination
}
