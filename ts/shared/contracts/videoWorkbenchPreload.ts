import type {
  AnalyzeVideoBeatInput,
  AnalyzeVideoProjectInput,
  AnalyzeVideoSubjectTrackInput,
  ApplyDeliveryVariantCommandsInput,
  ApplyEditorialTimelineCommandsInput,
  ConfirmVideoPostRenderQualityInput,
  CreateDeliveryVariantInput,
  CreateRemoteAnalysisConsentInput,
  CreateVideoAudioFinishingPlanInput,
  CreateVideoBeatSyncDraftInput,
  CreateVideoCaptionDraftInput,
  CreateVideoCaptionRevisionInput,
  CreateVideoCaptionTranslationInput,
  CreateVideoCompositionPlanInput,
  CreateVideoReviewNoteInput,
  CreateVideoApprovalDecisionInput,
  CreateVideoProjectInput,
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
  VideoQualityAcknowledgement,
  VideoQualityReport,
  VideoReviewNote,
  VideoApprovalDecision,
} from './media.js'

/** Expected public media failures cross Electron as an explicit safe envelope. */
export type VideoWorkbenchIpcResponse<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: MediaSafeError }>

/** The public project schema already omits local runtime paths; keep that true at IPC. */
export type VideoWorkbenchProjectProjection = Omit<PublicVideoStudioProject, 'workspace_root' | 'output_path'>
export type VideoWorkbenchProjectCreateInput = Omit<CreateVideoProjectInput, 'workspace_root'>

export type VideoDeliveryVariantProjection = Readonly<{
  variant: DeliveryVariant
  version: DeliveryVariantVersion
}>
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

export type VideoFactPageRequest = Readonly<{
  source_id?: string
  cursor?: string
  limit?: number
}>

export type VideoFactSearchRequest = Readonly<{
  cursor?: string
  limit?: number
}>

/** Renderer receives only a Main-issued opaque selection handle and public display metadata. */
export type VideoSourceSelection = Readonly<{
  selection_id: string
  display_name: string
  size_bytes?: number
}>

/** Renderer receives only a Main-issued opaque save destination handle. */
export type VideoExportDestinationGrant = Readonly<{
  destination_grant_id: string
  display_name: string
}>

export type VideoCommandEnvelope<Input> = Readonly<{
  input: Input
  idempotency_key: string
}>

export type VideoCaptionDraftResult = Readonly<{
  document: VideoCaptionDocument
  revision: VideoCaptionDocumentRevision
  task: PublicMediaTask
}>

export type VideoCaptionRevisionResult = Readonly<{
  revision: VideoCaptionDocumentRevision
  task: PublicMediaTask
}>

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
 * The only video capability exposed by Preload. It is deliberately typed in
 * shared code so a future UI cannot regress to an unbounded Promise<unknown>
 * or reintroduce source and destination paths.
 */
export type VideoWorkbenchPreloadBridge = Readonly<{
  listProjects(): Promise<VideoWorkbenchIpcResponse<readonly VideoWorkbenchProjectProjection[]>>
  createProject(input: VideoWorkbenchProjectCreateInput): Promise<VideoWorkbenchIpcResponse<VideoWorkbenchProjectProjection>>
  loadWorkspace(projectId: string, eventCursor: number): Promise<VideoWorkbenchIpcResponse<VideoWorkbenchSnapshot>>
  loadOperationEvents(projectId: string, cursor: number): Promise<VideoWorkbenchIpcResponse<PublicMediaJobEventPage>>
  loadFacts(projectId: string, kind: string, request?: VideoFactPageRequest): Promise<VideoWorkbenchIpcResponse<PublicVideoFactPage>>
  searchFacts(projectId: string, query: string, request?: VideoFactSearchRequest): Promise<VideoWorkbenchIpcResponse<PublicVideoFactSearchPage>>
  loadReviewNotes(projectId: string, timelineVersionId: string): Promise<VideoWorkbenchIpcResponse<readonly VideoReviewNote[]>>
  createReviewNote(projectId: string, timelineVersionId: string, command: VideoCommandEnvelope<CreateVideoReviewNoteInput>): Promise<VideoWorkbenchIpcResponse<VideoReviewNoteResult>>
  resolveReviewNote(projectId: string, timelineVersionId: string, reviewNoteId: string, command: VideoCommandEnvelope<ResolveVideoReviewNoteInput>): Promise<VideoWorkbenchIpcResponse<VideoReviewNoteResult>>
  createApprovalDecision(projectId: string, timelineVersionId: string, command: VideoCommandEnvelope<CreateVideoApprovalDecisionInput>): Promise<VideoWorkbenchIpcResponse<VideoApprovalDecisionResult>>
  chooseSources(projectId: string): Promise<VideoWorkbenchIpcResponse<readonly VideoSourceSelection[]>>
  addSources(projectId: string, selectionIds: readonly string[], idempotencyKey: string): Promise<VideoWorkbenchIpcResponse<readonly PublicMediaTask[]>>
  estimateRemoteAnalysis(projectId: string, command: VideoCommandEnvelope<{ purposes: readonly CreateRemoteAnalysisConsentInput['purposes'][number][]; source_ids: readonly string[] }>): Promise<VideoWorkbenchIpcResponse<PublicVideoStudioProject['remote_analysis_budgets'][number]>>
  grantRemoteAnalysisConsent(projectId: string, command: VideoCommandEnvelope<CreateRemoteAnalysisConsentInput>): Promise<VideoWorkbenchIpcResponse<PublicVideoStudioProject['remote_analysis_consents'][number]>>
  createQuickDraft(projectId: string, command: VideoCommandEnvelope<AnalyzeVideoProjectInput>): Promise<VideoWorkbenchIpcResponse<PublicMediaTask>>
  applyEditorialCommandSet(projectId: string, command: VideoCommandEnvelope<ApplyEditorialTimelineCommandsInput>): Promise<VideoWorkbenchIpcResponse<EditorialTimelineVersion>>
  createDeliveryVariant(projectId: string, command: VideoCommandEnvelope<CreateDeliveryVariantInput>): Promise<VideoWorkbenchIpcResponse<VideoDeliveryVariantProjection>>
  applyDeliveryVariantCommandSet(projectId: string, variantId: string, command: VideoCommandEnvelope<ApplyDeliveryVariantCommandsInput>): Promise<VideoWorkbenchIpcResponse<DeliveryVariantVersion>>
  createCaptionDraft(projectId: string, command: VideoCommandEnvelope<CreateVideoCaptionDraftInput>): Promise<VideoWorkbenchIpcResponse<VideoCaptionDraftResult>>
  createCaptionRevision(projectId: string, captionDocumentId: string, command: VideoCommandEnvelope<CreateVideoCaptionRevisionInput>): Promise<VideoWorkbenchIpcResponse<VideoCaptionRevisionResult>>
  createCaptionTranslation(projectId: string, captionDocumentId: string, command: VideoCommandEnvelope<CreateVideoCaptionTranslationInput>): Promise<VideoWorkbenchIpcResponse<VideoCaptionRevisionResult>>
  createCompositionPlan(projectId: string, command: VideoCommandEnvelope<CreateVideoCompositionPlanInput>): Promise<VideoWorkbenchIpcResponse<VideoCompositionPlanResult>>
  createAudioFinishingPlan(projectId: string, command: VideoCommandEnvelope<CreateVideoAudioFinishingPlanInput>): Promise<VideoWorkbenchIpcResponse<VideoAudioFinishingPlanResult>>
  analyzeBeat(projectId: string, command: VideoCommandEnvelope<AnalyzeVideoBeatInput>): Promise<VideoWorkbenchIpcResponse<PublicMediaTask>>
  createBeatSyncDraft(projectId: string, command: VideoCommandEnvelope<CreateVideoBeatSyncDraftInput>): Promise<VideoWorkbenchIpcResponse<VideoBeatSyncDraftResult>>
  analyzeSubjectTrack(projectId: string, command: VideoCommandEnvelope<AnalyzeVideoSubjectTrackInput>): Promise<VideoWorkbenchIpcResponse<VideoSubjectTrackResult>>
  preflightVariant(projectId: string, variantId: string, command: VideoCommandEnvelope<PreflightVideoVariantInput>): Promise<VideoWorkbenchIpcResponse<VideoPreflightVariantResult>>
  previewVariant(projectId: string, variantId: string, command: VideoCommandEnvelope<PreviewVideoVariantInput>): Promise<VideoWorkbenchIpcResponse<PublicMediaTask>>
  chooseExportDestination(projectId: string, variantId: string): Promise<VideoWorkbenchIpcResponse<VideoExportDestinationGrant | undefined>>
  renderVariant(projectId: string, variantId: string, destinationGrantId: string, command: VideoCommandEnvelope<Omit<RenderVideoVariantInput, 'output_path'>>): Promise<VideoWorkbenchIpcResponse<PublicMediaTask>>
  confirmPostRenderQuality(projectId: string, operationId: string, command: VideoCommandEnvelope<ConfirmVideoPostRenderQualityInput>): Promise<VideoWorkbenchIpcResponse<VideoPostRenderQualityConfirmationResult>>
  cancelOperation(operationId: string): Promise<VideoWorkbenchIpcResponse<PublicMediaTask>>
}>
