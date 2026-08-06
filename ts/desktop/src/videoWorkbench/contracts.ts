import type {
  ApplyDeliveryVariantCommandsInput,
  ApplyEditorialTimelineCommandsInput,
  AnalyzeVideoProjectInput,
  AnalyzeVideoBeatInput,
  AnalyzeVideoSubjectTrackInput,
  CreateDeliveryVariantInput,
  CreateVideoProjectInput,
  CreateRemoteAnalysisConsentInput,
  CreateVideoAudioFinishingPlanInput,
  CreateVideoCaptionDraftInput,
  CreateVideoCaptionRevisionInput,
  CreateVideoCaptionTranslationInput,
  CreateVideoBeatSyncDraftInput,
  CreateVideoCompositionPlanInput,
  CreateVideoReviewNoteInput,
  CreateVideoApprovalDecisionInput,
  ConfirmVideoPostRenderQualityInput,
  DeliveryVariant,
  DeliveryVariantVersion,
  EditorialTimelineVersion,
  MediaSafeError,
  PreflightVideoVariantInput,
  PreviewVideoVariantInput,
  PublicMediaJobEventPage,
  PublicMediaTask,
  PublicVideoFactPage,
  PublicVideoFactSearchPage,
  PublicVideoFactSummary,
  PublicVideoStudioProject,
  RenderVideoVariantInput,
  ResolveVideoReviewNoteInput,
  TimelineDraft,
  VideoAudioFinishingPlan,
  VideoCaptionDocument,
  VideoCaptionDocumentRevision,
  VideoCompositionPlan,
  VideoExecutionPlan,
  VideoOutputVerification,
  VideoPreview,
  VideoQualityReport,
  VideoQualityAcknowledgement,
  VideoReviewNote,
  VideoApprovalDecision,
} from '../../../shared/contracts/media.js'

/**
 * These panels map directly to the Gate 6 information architecture. The
 * renderer may change layout later, but it must not drop a product result by
 * silently collapsing one of these domains into a generic chat surface.
 */
export const VIDEO_WORKBENCH_PANELS = [
  'project_home',
  'import_scope',
  'material_browser',
  'quick_create',
  'editorial',
  'finishing',
  'review_delivery',
  'operation_center',
] as const

export type VideoWorkbenchPanel = typeof VIDEO_WORKBENCH_PANELS[number]

export const VIDEO_WORKBENCH_PHASES = [
  'loading',
  'empty',
  'ready',
  'partial',
  'stale',
  'conflict',
  'offline',
  'missing',
  'failed',
  'needs_user_decision',
] as const

export type VideoWorkbenchPhase = typeof VIDEO_WORKBENCH_PHASES[number]

/** Matches the public facts endpoint exactly. Detail payloads stay behind the
 * Sidecar; the Renderer only receives safe summaries and search hits. */
export const VIDEO_WORKBENCH_FACT_KINDS = [
  'source',
  'derivative',
  'transcript',
  'transcript_revision',
  'camera_shot',
  'content_segment',
  'evidence_window',
  'evidence',
] as const

export type VideoWorkbenchFactKind = typeof VIDEO_WORKBENCH_FACT_KINDS[number]

export type VideoFactPageRequest = Readonly<{
  source_id?: string
  cursor?: string
  limit?: number
}>

export type VideoFactSearchRequest = Readonly<{
  cursor?: string
  limit?: number
}>

/** A public current-head projection; historical versions remain immutable. */
export type VideoDeliveryVariantProjection = Readonly<{
  variant: DeliveryVariant
  version: DeliveryVariantVersion
}>

/**
 * The generic project compatibility DTO still carries legacy local fields.
 * The video renderer refuses both, forcing the later Main broker to project
 * a safe value instead of accidentally forwarding a filesystem location.
 */
export type VideoWorkbenchProjectProjection = Omit<PublicVideoStudioProject, 'workspace_root' | 'output_path'>

/** Project roots are server/Main-owned.  The Renderer may title a project and
 * choose public output settings, but it can never submit a local directory. */
export type VideoWorkbenchProjectCreateInput = Omit<CreateVideoProjectInput, 'workspace_root'>

/**
 * This is the complete renderer query projection. It deliberately contains
 * no local source path, Relay URL, prompt, or credential. Main will provide
 * it through typed IPC after its shared files are available to change.
 */
export type VideoWorkbenchSnapshot = Readonly<{
  project: VideoWorkbenchProjectProjection
  current_timeline?: EditorialTimelineVersion
  timeline_drafts: readonly TimelineDraft[]
  variants: readonly VideoDeliveryVariantProjection[]
  facts: PublicVideoFactPage
  fact_search?: PublicVideoFactSearchPage
  caption_documents: readonly VideoCaptionDocument[]
  caption_revisions: readonly VideoCaptionDocumentRevision[]
  composition_plans: readonly VideoCompositionPlan[]
  audio_finishing_plans: readonly VideoAudioFinishingPlan[]
  execution_plans: readonly VideoExecutionPlan[]
  quality_reports: readonly VideoQualityReport[]
  preview?: VideoPreview
  output_verification?: VideoOutputVerification
  operations: readonly PublicMediaTask[]
  events: PublicMediaJobEventPage
}>

export type VideoBudgetEstimate = PublicVideoStudioProject['remote_analysis_budgets'][number]
export type VideoBudgetConsent = PublicVideoStudioProject['remote_analysis_consents'][number]

/** Renderer-owned selection only. It is safe to lose on restart. */
export type VideoWorkbenchSelection = Readonly<{
  source_id?: string
  fact_id?: string
  timeline_draft_id?: string
  draft_item_ids: readonly string[]
  timeline_item_ids: readonly string[]
  variant_id?: string
  quality_report_id?: string
  review_note_id?: string
  operation_id?: string
}>

/** Never expose an absolute source path to Renderer. */
export type VideoSourceSelection = Readonly<{
  selection_id: string
  display_name: string
  size_bytes?: number
}>

/** Main owns the native save dialogue and only exposes this opaque grant. */
export type VideoExportDestinationGrant = Readonly<{
  destination_grant_id: string
  display_name: string
}>

export type VideoWorkbenchResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: MediaSafeError }>

export type VideoCommandEnvelope<Input> = Readonly<{
  input: Input
  idempotency_key: string
}>

/** These mirror the public API response bodies rather than dropping durable
 * operation IDs that the Operation Center must subsequently reconcile. */
export type VideoCaptionDraftResult = Readonly<{
  document: VideoCaptionDocument
  revision: VideoCaptionDocumentRevision
  task: PublicMediaTask
}>

export type VideoCaptionRevisionResult = Readonly<{
  revision: VideoCaptionDocumentRevision
  task: PublicMediaTask
}>

export type VideoCaptionTranslationResult = VideoCaptionRevisionResult

export type VideoCompositionPlanResult = Readonly<{
  plan: VideoCompositionPlan
  task: PublicMediaTask
}>

export type VideoAudioFinishingPlanResult = Readonly<{
  plan: VideoAudioFinishingPlan
  task: PublicMediaTask
}>

export type VideoPreflightVariantResult = Readonly<{
  plan: VideoExecutionPlan
  report: VideoQualityReport
  task: PublicMediaTask
}>

export type VideoBeatSyncDraftResult = Readonly<{
  draft: TimelineDraft
  task: PublicMediaTask
}>

export type VideoSubjectTrackResult = Readonly<{
  evidence: PublicVideoFactSummary
  task: PublicMediaTask
}>

/** The acknowledgement receipt is returned only after the server has bound it
 * to the frozen post-render artefact.  The Renderer never supplies a path. */
export type VideoPostRenderQualityConfirmationResult = Readonly<{
  acknowledgement: VideoQualityAcknowledgement
  task: PublicMediaTask
  reused: boolean
}>

export type VideoReviewNoteResult = Readonly<{
  note: VideoReviewNote
  reused: boolean
}>

export type VideoApprovalDecisionResult = Readonly<{
  decision: VideoApprovalDecision
  reused: boolean
}>

/**
 * Renderer-facing future IPC port. This file is intentionally local until
 * the shared Main/preload registration can be synchronized with its owner.
 * Every mutable call is envelope-bound to an idempotency key; chosen files
 * and output destinations are Main-issued opaque tokens rather than paths.
 */
export type VideoWorkbenchBridge = Readonly<{
  listProjects(): Promise<VideoWorkbenchResult<readonly VideoWorkbenchProjectProjection[]>>
  createProject(input: VideoWorkbenchProjectCreateInput): Promise<VideoWorkbenchResult<VideoWorkbenchProjectProjection>>
  loadWorkspace(projectId: string, eventCursor: number): Promise<VideoWorkbenchResult<VideoWorkbenchSnapshot>>
  loadOperationEvents(projectId: string, cursor: number): Promise<VideoWorkbenchResult<PublicMediaJobEventPage>>
  loadFacts(projectId: string, kind: VideoWorkbenchFactKind, request?: VideoFactPageRequest): Promise<VideoWorkbenchResult<PublicVideoFactPage>>
  searchFacts(projectId: string, query: string, request?: VideoFactSearchRequest): Promise<VideoWorkbenchResult<PublicVideoFactSearchPage>>
  loadReviewNotes(projectId: string, timelineVersionId: string): Promise<VideoWorkbenchResult<readonly VideoReviewNote[]>>
  createReviewNote(projectId: string, timelineVersionId: string, command: VideoCommandEnvelope<CreateVideoReviewNoteInput>): Promise<VideoWorkbenchResult<VideoReviewNoteResult>>
  resolveReviewNote(projectId: string, timelineVersionId: string, reviewNoteId: string, command: VideoCommandEnvelope<ResolveVideoReviewNoteInput>): Promise<VideoWorkbenchResult<VideoReviewNoteResult>>
  createApprovalDecision(projectId: string, timelineVersionId: string, command: VideoCommandEnvelope<CreateVideoApprovalDecisionInput>): Promise<VideoWorkbenchResult<VideoApprovalDecisionResult>>
  /** Main binds each native selection to the active project before exposing its opaque token. */
  chooseSources(projectId: string): Promise<VideoWorkbenchResult<readonly VideoSourceSelection[]>>
  addSources(projectId: string, selections: readonly string[], idempotencyKey: string): Promise<VideoWorkbenchResult<readonly PublicMediaTask[]>>
  estimateRemoteAnalysis(projectId: string, command: VideoCommandEnvelope<{ purposes: readonly CreateRemoteAnalysisConsentInput['purposes'][number][]; source_ids: readonly string[] }>): Promise<VideoWorkbenchResult<VideoBudgetEstimate>>
  grantRemoteAnalysisConsent(projectId: string, command: VideoCommandEnvelope<CreateRemoteAnalysisConsentInput>): Promise<VideoWorkbenchResult<VideoBudgetConsent>>
  createQuickDraft(projectId: string, command: VideoCommandEnvelope<AnalyzeVideoProjectInput>): Promise<VideoWorkbenchResult<PublicMediaTask>>
  applyEditorialCommandSet(projectId: string, command: VideoCommandEnvelope<ApplyEditorialTimelineCommandsInput>): Promise<VideoWorkbenchResult<EditorialTimelineVersion>>
  createDeliveryVariant(projectId: string, command: VideoCommandEnvelope<CreateDeliveryVariantInput>): Promise<VideoWorkbenchResult<VideoDeliveryVariantProjection>>
  applyDeliveryVariantCommandSet(projectId: string, variantId: string, command: VideoCommandEnvelope<ApplyDeliveryVariantCommandsInput>): Promise<VideoWorkbenchResult<DeliveryVariantVersion>>
  createCaptionDraft(projectId: string, command: VideoCommandEnvelope<CreateVideoCaptionDraftInput>): Promise<VideoWorkbenchResult<VideoCaptionDraftResult>>
  createCaptionRevision(projectId: string, captionDocumentId: string, command: VideoCommandEnvelope<CreateVideoCaptionRevisionInput>): Promise<VideoWorkbenchResult<VideoCaptionRevisionResult>>
  createCaptionTranslation(projectId: string, captionDocumentId: string, command: VideoCommandEnvelope<CreateVideoCaptionTranslationInput>): Promise<VideoWorkbenchResult<VideoCaptionTranslationResult>>
  createCompositionPlan(projectId: string, command: VideoCommandEnvelope<CreateVideoCompositionPlanInput>): Promise<VideoWorkbenchResult<VideoCompositionPlanResult>>
  createAudioFinishingPlan(projectId: string, command: VideoCommandEnvelope<CreateVideoAudioFinishingPlanInput>): Promise<VideoWorkbenchResult<VideoAudioFinishingPlanResult>>
  analyzeBeat(projectId: string, command: VideoCommandEnvelope<AnalyzeVideoBeatInput>): Promise<VideoWorkbenchResult<PublicMediaTask>>
  createBeatSyncDraft(projectId: string, command: VideoCommandEnvelope<CreateVideoBeatSyncDraftInput>): Promise<VideoWorkbenchResult<VideoBeatSyncDraftResult>>
  analyzeSubjectTrack(projectId: string, command: VideoCommandEnvelope<AnalyzeVideoSubjectTrackInput>): Promise<VideoWorkbenchResult<VideoSubjectTrackResult>>
  preflightVariant(projectId: string, variantId: string, command: VideoCommandEnvelope<PreflightVideoVariantInput>): Promise<VideoWorkbenchResult<VideoPreflightVariantResult>>
  previewVariant(projectId: string, variantId: string, command: VideoCommandEnvelope<PreviewVideoVariantInput>): Promise<VideoWorkbenchResult<PublicMediaTask>>
  /** A native save-dialog cancel is an intentional no-op, never a transport error. */
  chooseExportDestination(projectId: string, variantId: string): Promise<VideoWorkbenchResult<VideoExportDestinationGrant | undefined>>
  renderVariant(projectId: string, variantId: string, destination: VideoExportDestinationGrant, command: VideoCommandEnvelope<Omit<RenderVideoVariantInput, 'output_path'>>): Promise<VideoWorkbenchResult<PublicMediaTask>>
  confirmPostRenderQuality(projectId: string, operationId: string, command: VideoCommandEnvelope<ConfirmVideoPostRenderQualityInput>): Promise<VideoWorkbenchResult<VideoPostRenderQualityConfirmationResult>>
  cancelOperation(operationId: string): Promise<VideoWorkbenchResult<PublicMediaTask>>
}>
