import {
  mediaSafeError,
  type AnalyzeVideoBeatInput,
  type AnalyzeVideoProjectInput,
  type AnalyzeVideoSubjectTrackInput,
  type CreateDeliveryVariantInput,
  type CreateRemoteAnalysisConsentInput,
  type CreateVideoAudioFinishingPlanInput,
  type CreateVideoBeatSyncDraftInput,
  type CreateVideoCaptionDraftInput,
  type CreateVideoCaptionRevisionInput,
  type CreateVideoCaptionTranslationInput,
  type CreateVideoCompositionPlanInput,
  type DeliveryVariantCommand,
  type EditorialTimelineCommand,
} from '../../../shared/contracts/media.js'
import type { VideoWorkbenchBridge, VideoWorkbenchFactKind, VideoWorkbenchProjectCreateInput, VideoWorkbenchProjectProjection, VideoWorkbenchSelection, VideoWorkbenchSnapshot } from './contracts.js'
import { VideoWorkbenchController } from './controller.js'
import type { VideoPendingPostRenderQualityConfirmation } from './qualityConfirmation.js'
import {
  renderVideoWorkbenchProjectPicker,
  renderVideoWorkbenchSurface,
  type VideoWorkbenchSurfaceAction,
} from './surface.js'
import type { VideoWorkbenchUiState } from './state.js'
import { createVideoWorkbenchViewModel } from './viewModel.js'

export type VideoWorkbenchInputAction =
  | 'estimate_budget'
  | 'create_quick_draft'
  | 'open_editor'
  | 'open_variant_editor'
  | 'create_variant'
  | 'create_caption'
  | 'create_caption_revision'
  | 'create_caption_translation'
  | 'create_composition_plan'
  | 'create_audio_finishing_plan'
  | 'analyze_beat'
  | 'create_beat_sync_draft'
  | 'analyze_subject_track'
  | 'confirm_post_render_quality'

/**
 * Inputs that require choices beyond the current authoritative snapshot.  The
 * eventual Electron surface can implement this with dialogs or controls, but
 * this Renderer layer keeps them typed and deliberately does not invent
 * defaults such as a source path, destination, prompt, or remote consent.
 */
export type VideoWorkbenchActionInput =
  | Readonly<{
    action: 'estimate_budget'
    purposes: readonly CreateRemoteAnalysisConsentInput['purposes'][number][]
    source_ids: readonly string[]
    data_kinds: readonly CreateRemoteAnalysisConsentInput['data_kinds'][number][]
    coverage: CreateRemoteAnalysisConsentInput['coverage']
  }>
  | Readonly<{ action: 'create_quick_draft'; input: AnalyzeVideoProjectInput }>
  | Readonly<{ action: 'open_editor'; commands: readonly EditorialTimelineCommand[] }>
  | Readonly<{ action: 'open_variant_editor'; commands: readonly DeliveryVariantCommand[] }>
  | Readonly<{ action: 'create_variant'; input: CreateDeliveryVariantInput }>
  | Readonly<{ action: 'create_caption'; input: CreateVideoCaptionDraftInput }>
  | Readonly<{ action: 'create_caption_revision'; caption_document_id: string; input: CreateVideoCaptionRevisionInput }>
  | Readonly<{ action: 'create_caption_translation'; caption_document_id: string; input: CreateVideoCaptionTranslationInput }>
  | Readonly<{ action: 'create_composition_plan'; input: CreateVideoCompositionPlanInput }>
  | Readonly<{ action: 'create_audio_finishing_plan'; input: CreateVideoAudioFinishingPlanInput }>
  | Readonly<{ action: 'analyze_beat'; input: AnalyzeVideoBeatInput }>
  | Readonly<{ action: 'create_beat_sync_draft'; input: CreateVideoBeatSyncDraftInput }>
  | Readonly<{ action: 'analyze_subject_track'; input: AnalyzeVideoSubjectTrackInput }>
  /** The provider must collect an explicit affirmative action.  Check ids and
   * the output hash stay controller-derived to prevent stale acknowledgements. */
  | Readonly<{ action: 'confirm_post_render_quality'; confirmed: true }>

export type VideoWorkbenchActionInputRequest = Readonly<{
  action: VideoWorkbenchInputAction
  project: VideoWorkbenchProjectProjection
  snapshot: VideoWorkbenchSnapshot
  selection: VideoWorkbenchSelection
  pending_quality?: VideoPendingPostRenderQualityConfirmation
}>

export type VideoWorkbenchActionInputProvider = Readonly<{
  requestProject(context: Readonly<{ projects: readonly VideoWorkbenchProjectProjection[] }>): Promise<VideoWorkbenchProjectCreateInput | undefined>
  requestAction(request: VideoWorkbenchActionInputRequest): Promise<VideoWorkbenchActionInput | undefined>
}>

export type VideoWorkbenchProductState = Readonly<{
  projects: readonly VideoWorkbenchProjectProjection[]
  selected_project_id?: string
  showing_project_picker: boolean
  loading_projects: boolean
  last_error?: ReturnType<typeof mediaSafeError>
  workspace?: VideoWorkbenchUiState
}>

export type VideoWorkbenchProductListener = (state: VideoWorkbenchProductState) => void
export type VideoWorkbenchIdempotencyKeyFactory = () => string

function defaultIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
  return `video-ui-${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

/**
 * Renderer-only product coordinator.  Main injects a narrow bridge and an
 * input provider later; this class never imports Electron, performs fetches,
 * or holds native file handles, credentials, or capability tokens.
 */
export class VideoWorkbenchProductController {
  private state: VideoWorkbenchProductState = {
    projects: [],
    showing_project_picker: true,
    loading_projects: false,
  }
  private workspace?: VideoWorkbenchController
  private unsubscribeWorkspace?: () => void
  private readonly listeners = new Set<VideoWorkbenchProductListener>()
  private creatingProject = false
  private actionInFlight = false
  private materialQueryInFlight = false

  constructor(
    private readonly bridge: VideoWorkbenchBridge,
    private readonly inputs: VideoWorkbenchActionInputProvider,
    private readonly idempotencyKey: VideoWorkbenchIdempotencyKeyFactory = defaultIdempotencyKey,
  ) {}

  getState(): VideoWorkbenchProductState {
    return this.state
  }

  subscribe(listener: VideoWorkbenchProductListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribeWorkspace?.()
    this.unsubscribeWorkspace = undefined
    this.listeners.clear()
  }

  async start(): Promise<void> {
    await this.refreshProjects()
  }

  async refreshProjects(): Promise<void> {
    this.update({ loading_projects: true, last_error: undefined })
    try {
      const response = await this.bridge.listProjects()
      if (!response.ok) {
        this.update({ loading_projects: false, last_error: response.error })
        return
      }
      const selected = response.value.some(project => project.id === this.state.selected_project_id)
        ? this.state.selected_project_id
        : undefined
      if (!selected && this.state.selected_project_id) {
        this.unsubscribeWorkspace?.()
        this.unsubscribeWorkspace = undefined
        this.workspace = undefined
        this.update({ projects: response.value, selected_project_id: undefined, workspace: undefined, showing_project_picker: true, loading_projects: false })
        return
      }
      this.update({ projects: response.value, selected_project_id: selected, loading_projects: false })
    } catch {
      this.update({ loading_projects: false, last_error: mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE') })
    }
  }

  showProjectPicker(): void {
    this.update({ showing_project_picker: true, last_error: undefined })
  }

  async selectProject(projectId: string): Promise<void> {
    const project = this.state.projects.find(candidate => candidate.id === projectId)
    if (!project) {
      this.update({ last_error: mediaSafeError('MEDIA_INVALID_REQUEST') })
      return
    }
    if (this.workspace?.projectId === projectId) {
      this.update({ selected_project_id: projectId, showing_project_picker: false, last_error: undefined })
      await this.workspace.refresh()
      return
    }
    this.unsubscribeWorkspace?.()
    const workspace = new VideoWorkbenchController(projectId, this.bridge)
    this.workspace = workspace
    this.unsubscribeWorkspace = workspace.subscribe(state => this.update({ workspace: state }))
    this.update({ selected_project_id: projectId, showing_project_picker: false, last_error: undefined })
    await workspace.refresh()
  }

  async createProject(): Promise<void> {
    if (this.creatingProject) return
    this.creatingProject = true
    this.update({ loading_projects: true, last_error: undefined })
    try {
      const input = await this.inputs.requestProject({ projects: this.state.projects })
      if (!input) return
      const response = await this.bridge.createProject(input)
      if (!response.ok) {
        this.update({ loading_projects: false, last_error: response.error })
        return
      }
      const projects = [...this.state.projects.filter(project => project.id !== response.value.id), response.value]
      this.update({ projects, loading_projects: false })
      await this.selectProject(response.value.id)
    } catch {
      this.update({ loading_projects: false, last_error: mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE') })
    } finally {
      this.creatingProject = false
      if (this.state.loading_projects) this.update({ loading_projects: false })
    }
  }

  select(selection: Partial<VideoWorkbenchSelection>): void {
    this.workspace?.dispatch({ type: 'select', selection })
  }

  workspacePanel(panel: VideoWorkbenchUiState['panel']): void {
    this.workspace?.dispatch({ type: 'set_panel', panel })
  }

  async loadFacts(kind: VideoWorkbenchFactKind, sourceId?: string): Promise<void> {
    await this.withMaterialQuery(async workspace => await workspace.loadFacts(kind, sourceId ? { source_id: sourceId } : {}))
  }

  async loadMoreFacts(): Promise<void> {
    await this.withMaterialQuery(async workspace => await workspace.loadMoreFacts())
  }

  async searchFacts(query: string): Promise<void> {
    await this.withMaterialQuery(async workspace => await workspace.searchFacts(query))
  }

  async loadMoreFactSearch(): Promise<void> {
    await this.withMaterialQuery(async workspace => await workspace.loadMoreFactSearch())
  }

  toggleDraftItem(draftId: string, itemId: string): void {
    const state = this.workspace?.getState()
    if (!state?.snapshot) return
    const draft = state.snapshot.timeline_drafts.find(candidate => candidate.id === draftId)
    if (!draft?.items.some(item => item.id === itemId)) return
    const selected = state.selection.timeline_draft_id === draftId
      ? state.selection.draft_item_ids
      : []
    const next = selected.includes(itemId)
      ? selected.filter(candidate => candidate !== itemId)
      : [...selected, itemId]
    this.workspace?.dispatch({ type: 'select', selection: { timeline_draft_id: draftId, draft_item_ids: next } })
  }

  toggleTimelineItem(itemId: string): void {
    const state = this.workspace?.getState()
    if (!state?.snapshot?.current_timeline?.items.some(item => item.id === itemId)) return
    const current = state.selection.timeline_item_ids
    const next = current.includes(itemId)
      ? current.filter(candidate => candidate !== itemId)
      : [...current, itemId]
    this.workspace?.dispatch({ type: 'select', selection: { timeline_item_ids: next } })
  }

  async perform(action: VideoWorkbenchSurfaceAction, targetId?: string): Promise<void> {
    if (this.actionInFlight) return
    this.actionInFlight = true
    try {
      if (action === 'switch_project') return this.showProjectPicker()
      if (action === 'create_project') return await this.createProject()
      const workspace = this.workspace
      if (!workspace) {
        this.update({ last_error: mediaSafeError('MEDIA_INVALID_REQUEST') })
        return
      }
      switch (action) {
        case 'refresh': return await workspace.refresh().then(() => undefined)
        case 'choose_sources': return await workspace.chooseAndAddSources(this.idempotencyKey()).then(() => undefined)
        case 'estimate_budget': {
          const input = await this.requestInput('estimate_budget')
          if (!input || input.action !== 'estimate_budget') return
          return await workspace.estimateBudget(this.idempotencyKey(), input.purposes, input.source_ids, {
            data_kinds: input.data_kinds,
            coverage: input.coverage,
          }).then(() => undefined)
        }
        case 'confirm_budget': return await workspace.confirmBudget(this.idempotencyKey()).then(() => undefined)
        case 'create_quick_draft': {
          const input = await this.requestInput('create_quick_draft')
          if (!input || input.action !== 'create_quick_draft') return
          return await workspace.createQuickDraft(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'accept_draft': return await workspace.acceptSelectedDraft(this.idempotencyKey()).then(() => undefined)
        case 'open_editor': {
          const input = await this.requestInput('open_editor')
          if (!input || input.action !== 'open_editor') return
          return await workspace.applyEditorialCommands(this.idempotencyKey(), input.commands).then(() => undefined)
        }
        case 'open_variant_editor': {
          const variantId = workspace.getState().selection.variant_id
          const input = await this.requestInput('open_variant_editor')
          if (!variantId || !input || input.action !== 'open_variant_editor') return this.rejectInput()
          return await workspace.applyVariantCommands(this.idempotencyKey(), variantId, input.commands).then(() => undefined)
        }
        case 'create_variant': {
          const input = await this.requestInput('create_variant')
          if (!input || input.action !== 'create_variant') return
          return await workspace.createVariant(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'create_caption': {
          const input = await this.requestInput('create_caption')
          if (!input || input.action !== 'create_caption') return
          return await workspace.createCaptionDraft(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'create_caption_revision': {
          const input = await this.requestInput('create_caption_revision')
          if (!input || input.action !== 'create_caption_revision') return
          return await workspace.createCaptionRevision(this.idempotencyKey(), input.caption_document_id, input.input).then(() => undefined)
        }
        case 'create_caption_translation': {
          const input = await this.requestInput('create_caption_translation')
          if (!input || input.action !== 'create_caption_translation') return
          return await workspace.createCaptionTranslation(this.idempotencyKey(), input.caption_document_id, input.input).then(() => undefined)
        }
        case 'create_composition_plan': {
          const input = await this.requestInput('create_composition_plan')
          if (!input || input.action !== 'create_composition_plan') return
          return await workspace.createCompositionPlan(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'create_audio_finishing_plan': {
          const input = await this.requestInput('create_audio_finishing_plan')
          if (!input || input.action !== 'create_audio_finishing_plan') return
          return await workspace.createAudioFinishingPlan(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'analyze_beat': {
          const input = await this.requestInput('analyze_beat')
          if (!input || input.action !== 'analyze_beat') return
          return await workspace.analyzeBeat(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'create_beat_sync_draft': {
          const input = await this.requestInput('create_beat_sync_draft')
          if (!input || input.action !== 'create_beat_sync_draft') return
          return await workspace.createBeatSyncDraft(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'analyze_subject_track': {
          const input = await this.requestInput('analyze_subject_track')
          if (!input || input.action !== 'analyze_subject_track') return
          return await workspace.analyzeSubjectTrack(this.idempotencyKey(), input.input).then(() => undefined)
        }
        case 'preflight': return await this.withSelectedVariant(variantId => workspace.preflight(this.idempotencyKey(), variantId))
        case 'preview': return await this.withSelectedVariant(variantId => workspace.preview(this.idempotencyKey(), variantId))
        case 'render': return await this.withSelectedVariant(variantId => workspace.render(this.idempotencyKey(), variantId))
        case 'poll_operations': return await workspace.pollOperationEvents().then(() => undefined)
        case 'confirm_post_render_quality': {
          if (!targetId) return this.rejectInput()
          const pending = workspace.pendingPostRenderQualityConfirmation(targetId)
          if (!pending) return this.rejectInput()
          const input = await this.requestInput('confirm_post_render_quality', pending)
          if (!input || input.action !== 'confirm_post_render_quality' || input.confirmed !== true) return
          return await workspace.confirmPostRenderQuality(this.idempotencyKey(), targetId).then(() => undefined)
        }
        case 'cancel_operation': {
          if (!targetId) return this.rejectInput()
          return await workspace.cancelOperation(targetId).then(() => undefined)
        }
      }
    } finally {
      this.actionInFlight = false
    }
  }

  private async withSelectedVariant(call: (variantId: string) => Promise<unknown>): Promise<void> {
    const variantId = this.workspace?.getState().selection.variant_id
    if (!variantId) return this.rejectInput()
    await call(variantId)
  }

  private async withMaterialQuery(call: (workspace: VideoWorkbenchController) => Promise<unknown>): Promise<void> {
    if (this.materialQueryInFlight) return
    const workspace = this.workspace
    if (!workspace) {
      this.update({ last_error: mediaSafeError('MEDIA_INVALID_REQUEST') })
      return
    }
    this.materialQueryInFlight = true
    try {
      await call(workspace)
    } finally {
      this.materialQueryInFlight = false
    }
  }

  private async requestInput(
    action: VideoWorkbenchInputAction,
    pendingQuality?: VideoPendingPostRenderQualityConfirmation,
  ): Promise<VideoWorkbenchActionInput | undefined> {
    const state = this.workspace?.getState()
    const snapshot = state?.snapshot
    if (!snapshot) {
      this.rejectInput()
      return undefined
    }
    try {
      const input = await this.inputs.requestAction({
        action,
        project: snapshot.project,
        snapshot,
        selection: state.selection,
        ...(pendingQuality ? { pending_quality: pendingQuality } : {}),
      })
      if (input && input.action !== action) {
        this.rejectInput()
        return undefined
      }
      return input
    } catch {
      this.workspace?.dispatch({ type: 'action_failed', error: mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE') })
      return undefined
    }
  }

  private rejectInput(): void {
    this.workspace?.dispatch({ type: 'action_failed', error: mediaSafeError('MEDIA_INVALID_REQUEST') })
  }

  private update(next: Partial<VideoWorkbenchProductState>): void {
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener(this.state)
  }
}

/** Mounts the isolated product surface.  Electron registration is intentionally
 * deferred; callers must inject the later Main/preload bridge themselves. */
export function mountVideoWorkbenchProduct(
  root: HTMLElement,
  product: VideoWorkbenchProductController,
): () => void {
  const render = (state: VideoWorkbenchProductState) => {
    if (state.showing_project_picker || !state.workspace) {
      renderVideoWorkbenchProjectPicker(root, {
        projects: state.projects,
        selected_project_id: state.selected_project_id,
        loading: state.loading_projects,
        ...(state.last_error ? { error_message: state.last_error.message } : {}),
      }, {
        onSelectProject: projectId => { void product.selectProject(projectId) },
        onCreateProject: () => { void product.createProject() },
        onRefreshProjects: () => { void product.refreshProjects() },
      })
      return
    }
    renderVideoWorkbenchSurface(root, createVideoWorkbenchViewModel(state.workspace), {
      onPanel: panel => product.workspacePanel(panel),
      onAction: (action, targetId) => { void product.perform(action, targetId) },
      onSelection: selection => product.select(selection),
      onToggleDraftItem: (draftId, itemId) => product.toggleDraftItem(draftId, itemId),
      onToggleTimelineItem: itemId => product.toggleTimelineItem(itemId),
      onLoadFacts: (kind, sourceId) => { void product.loadFacts(kind, sourceId) },
      onLoadMoreFacts: () => { void product.loadMoreFacts() },
      onSearchFacts: query => { void product.searchFacts(query) },
      onLoadMoreFactSearch: () => { void product.loadMoreFactSearch() },
    })
  }
  const unsubscribe = product.subscribe(render)
  void product.start()
  return () => {
    unsubscribe()
    product.dispose()
  }
}
