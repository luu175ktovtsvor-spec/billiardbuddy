import { z } from 'zod/v4'
import {
  MEDIA_UI_CAPABILITY_HEADER,
  deliveryVariantSchema,
  deliveryVariantVersionSchema,
  editorialTimelineVersionSchema,
  mediaSafeError,
  mediaSafeErrorResponseSchema,
  publicMediaJobEventPageSchema,
  publicMediaTaskSchema,
  publicVideoFactPageSchema,
  publicVideoFactSearchPageSchema,
  publicVideoFactSummarySchema,
  publicVideoStudioProjectSchema,
  remoteAnalysisConsentSchema,
  timelineDraftSchema,
  videoAudioFinishingPlanSchema,
  videoCaptionDocumentRevisionSchema,
  videoCaptionDocumentSchema,
  videoCompositionPlanSchema,
  videoExecutionPlanSchema,
  videoQualityAcknowledgementSchema,
  videoQualityReportSchema,
  videoRemoteBudgetSchema,
  videoWorkbenchWorkspaceSnapshotSchema,
  type AnalyzeVideoBeatInput,
  type AnalyzeVideoProjectInput,
  type AnalyzeVideoSubjectTrackInput,
  type ApplyDeliveryVariantCommandsInput,
  type ApplyEditorialTimelineCommandsInput,
  type ConfirmVideoPostRenderQualityInput,
  type CreateDeliveryVariantInput,
  type CreateRemoteAnalysisConsentInput,
  type CreateVideoAudioFinishingPlanInput,
  type CreateVideoBeatSyncDraftInput,
  type CreateVideoCaptionDraftInput,
  type CreateVideoCaptionRevisionInput,
  type CreateVideoCaptionTranslationInput,
  type CreateVideoCompositionPlanInput,
  type MediaSafeErrorCode,
  type PreflightVideoVariantInput,
  type PreviewVideoVariantInput,
  type RenderVideoVariantInput,
} from '../../../shared/contracts/media.js'
import type {
  VideoAudioFinishingPlanResult,
  VideoBeatSyncDraftResult,
  VideoCaptionDraftResult,
  VideoCaptionRevisionResult,
  VideoCompositionPlanResult,
  VideoDeliveryVariantProjection,
  VideoFactPageRequest,
  VideoFactSearchRequest,
  VideoPostRenderQualityConfirmationResult,
  VideoPreflightVariantResult,
  VideoSubjectTrackResult,
  VideoWorkbenchProjectCreateInput,
  VideoWorkbenchProjectProjection,
  VideoWorkbenchSnapshot,
} from '../../../shared/contracts/videoWorkbenchPreload.js'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ResponseSchema<T> = { parse(value: unknown): T }

const projectListResponseSchema = z.object({ projects: z.array(publicVideoStudioProjectSchema) }).strict()
const projectResponseSchema = z.object({ project: publicVideoStudioProjectSchema }).strict()
const taskResponseSchema = z.object({ task: publicMediaTaskSchema }).strict()
const editorialCommandResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  timeline: editorialTimelineVersionSchema,
  reused: z.boolean(),
}).strict()
const deliveryVariantResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  variant: deliveryVariantSchema,
  version: deliveryVariantVersionSchema,
  reused: z.boolean(),
}).strict()
const deliveryVariantCommandResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  version: deliveryVariantVersionSchema,
  reused: z.boolean(),
}).strict()
const captionDraftResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  document: videoCaptionDocumentSchema,
  revision: videoCaptionDocumentRevisionSchema,
  task: publicMediaTaskSchema,
}).strict()
const captionRevisionResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  revision: videoCaptionDocumentRevisionSchema,
  task: publicMediaTaskSchema,
}).strict()
const compositionPlanResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  plan: videoCompositionPlanSchema,
  task: publicMediaTaskSchema,
}).strict()
const audioPlanResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  plan: videoAudioFinishingPlanSchema,
  task: publicMediaTaskSchema,
}).strict()
const beatSyncResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  draft: timelineDraftSchema,
  task: publicMediaTaskSchema,
}).strict()
const subjectTrackResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  evidence: publicVideoFactSummarySchema,
  task: publicMediaTaskSchema,
}).strict()
const preflightResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  plan: videoExecutionPlanSchema,
  report: videoQualityReportSchema,
  task: publicMediaTaskSchema,
}).strict()
const acknowledgementResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  acknowledgement: videoQualityAcknowledgementSchema,
  task: publicMediaTaskSchema,
  reused: z.boolean(),
}).strict()
const estimateResponseSchema = z.object({ estimate: videoRemoteBudgetSchema }).strict()
const consentResponseSchema = z.object({
  project: publicVideoStudioProjectSchema,
  consent: remoteAnalysisConsentSchema,
}).strict()
const variantReadResponseSchema = z.object({
  variant: deliveryVariantSchema,
  version: deliveryVariantVersionSchema,
}).strict()

export type ElectronVideoWorkbenchActionsOptions = Readonly<{
  getServerUrl: () => Promise<string>
  capability: string
  fetchImpl?: FetchLike
}>

/** Main-only stable error mapping for the typed Video Workbench preload surface. */
export class ElectronVideoWorkbenchActionError extends Error {
  readonly code: MediaSafeErrorCode

  constructor(code: unknown) {
    const safe = mediaSafeError(code)
    super(safe.message)
    this.name = 'ElectronVideoWorkbenchActionError'
    this.code = safe.code
  }
}

/**
 * Main-process HTTP broker for the public `/api/videos` surface. The renderer
 * never receives its Sidecar URL, media capability, or a filesystem location.
 */
export class ElectronVideoWorkbenchActions {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: ElectronVideoWorkbenchActionsOptions) {
    if (options.capability.length < 32) throw new Error('Media UI capability is too short')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async listProjects(): Promise<readonly VideoWorkbenchProjectProjection[]> {
    return (await this.get('/api/videos/projects', projectListResponseSchema)).projects
  }

  async createProject(input: VideoWorkbenchProjectCreateInput): Promise<VideoWorkbenchProjectProjection> {
    return (await this.post('/api/videos/projects', input, projectResponseSchema)).project
  }

  async loadWorkspace(projectId: string, eventCursor: number): Promise<VideoWorkbenchSnapshot> {
    return await this.get(`/api/videos/projects/${encodeURIComponent(projectId)}/workspace`, videoWorkbenchWorkspaceSnapshotSchema, {
      event_cursor: String(eventCursor),
    })
  }

  async loadOperationEvents(projectId: string, cursor: number) {
    return await this.get(`/api/videos/projects/${encodeURIComponent(projectId)}/events`, publicMediaJobEventPageSchema, {
      cursor: String(cursor),
      limit: '100',
      wait_ms: '25000',
    })
  }

  async loadFacts(projectId: string, kind: string, request: VideoFactPageRequest = {}) {
    return await this.get(`/api/videos/projects/${encodeURIComponent(projectId)}/facts/${encodeURIComponent(kind)}`, publicVideoFactPageSchema, {
      ...(request.source_id ? { source_id: request.source_id } : {}),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.limit ? { limit: String(request.limit) } : {}),
    })
  }

  async searchFacts(projectId: string, query: string, request: VideoFactSearchRequest = {}) {
    return await this.get(`/api/videos/projects/${encodeURIComponent(projectId)}/search`, publicVideoFactSearchPageSchema, {
      q: query,
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.limit ? { limit: String(request.limit) } : {}),
    })
  }

  async assertProject(projectId: string): Promise<void> {
    await this.get(`/api/videos/projects/${encodeURIComponent(projectId)}`, projectResponseSchema)
  }

  async addSources(projectId: string, paths: readonly string[]): Promise<readonly ReturnType<typeof publicMediaTaskSchema.parse>[]> {
    const tasks: ReturnType<typeof publicMediaTaskSchema.parse>[] = []
    for (const path of paths) {
      tasks.push((await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/sources`, { path }, z.object({
        project: publicVideoStudioProjectSchema,
        task: publicMediaTaskSchema,
      }).strict())).task)
    }
    return tasks
  }

  async estimateRemoteAnalysis(projectId: string, input: { purposes: readonly CreateRemoteAnalysisConsentInput['purposes'][number][]; source_ids: readonly string[] }) {
    return (await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/analysis-estimates`, input, estimateResponseSchema)).estimate
  }

  async grantRemoteAnalysisConsent(projectId: string, input: CreateRemoteAnalysisConsentInput) {
    return (await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/remote-analysis-consent`, input, consentResponseSchema)).consent
  }

  async createQuickDraft(projectId: string, input: AnalyzeVideoProjectInput, idempotencyKey: string) {
    return (await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/analyze`, input, taskResponseSchema, idempotencyKey)).task
  }

  async applyEditorialCommandSet(projectId: string, input: ApplyEditorialTimelineCommandsInput, idempotencyKey: string) {
    const response = await this.post(
      `/api/videos/projects/${encodeURIComponent(projectId)}/timelines/${encodeURIComponent(input.base_timeline_version_id)}/commands`,
      { commands: input.commands },
      editorialCommandResponseSchema,
      idempotencyKey,
    )
    return response.timeline
  }

  async createDeliveryVariant(projectId: string, input: CreateDeliveryVariantInput, idempotencyKey: string): Promise<VideoDeliveryVariantProjection> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/delivery-variants`, input, deliveryVariantResponseSchema, idempotencyKey)
    return { variant: response.variant, version: response.version }
  }

  async applyDeliveryVariantCommandSet(projectId: string, variantId: string, input: ApplyDeliveryVariantCommandsInput, idempotencyKey: string) {
    return (await this.post(
      `/api/videos/projects/${encodeURIComponent(projectId)}/delivery-variants/${encodeURIComponent(variantId)}/commands`,
      input,
      deliveryVariantCommandResponseSchema,
      idempotencyKey,
    )).version
  }

  async createCaptionDraft(projectId: string, input: CreateVideoCaptionDraftInput, idempotencyKey: string): Promise<VideoCaptionDraftResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/captions/drafts`, input, captionDraftResponseSchema, idempotencyKey)
    return { document: response.document, revision: response.revision, task: response.task }
  }

  async createCaptionRevision(projectId: string, documentId: string, input: CreateVideoCaptionRevisionInput, idempotencyKey: string): Promise<VideoCaptionRevisionResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/captions/${encodeURIComponent(documentId)}/revisions`, input, captionRevisionResponseSchema, idempotencyKey)
    return { revision: response.revision, task: response.task }
  }

  async createCaptionTranslation(projectId: string, documentId: string, input: CreateVideoCaptionTranslationInput, idempotencyKey: string): Promise<VideoCaptionRevisionResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/captions/${encodeURIComponent(documentId)}/translations`, input, captionRevisionResponseSchema, idempotencyKey)
    return { revision: response.revision, task: response.task }
  }

  async createCompositionPlan(projectId: string, input: CreateVideoCompositionPlanInput, idempotencyKey: string): Promise<VideoCompositionPlanResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/composition-plans`, input, compositionPlanResponseSchema, idempotencyKey)
    return { plan: response.plan, task: response.task }
  }

  async createAudioFinishingPlan(projectId: string, input: CreateVideoAudioFinishingPlanInput, idempotencyKey: string): Promise<VideoAudioFinishingPlanResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/audio-finishing-plans`, input, audioPlanResponseSchema, idempotencyKey)
    return { plan: response.plan, task: response.task }
  }

  async analyzeBeat(projectId: string, input: AnalyzeVideoBeatInput, idempotencyKey: string) {
    return (await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/beat-analysis`, input, taskResponseSchema, idempotencyKey)).task
  }

  async createBeatSyncDraft(projectId: string, input: CreateVideoBeatSyncDraftInput, idempotencyKey: string): Promise<VideoBeatSyncDraftResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/beat-sync-drafts`, input, beatSyncResponseSchema, idempotencyKey)
    return { draft: response.draft, task: response.task }
  }

  async analyzeSubjectTrack(projectId: string, input: AnalyzeVideoSubjectTrackInput, idempotencyKey: string): Promise<VideoSubjectTrackResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/subject-tracks`, input, subjectTrackResponseSchema, idempotencyKey)
    return { evidence: response.evidence, task: response.task }
  }

  async preflightVariant(projectId: string, variantId: string, input: PreflightVideoVariantInput, idempotencyKey: string): Promise<VideoPreflightVariantResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/delivery-variants/${encodeURIComponent(variantId)}/preflight`, input, preflightResponseSchema, idempotencyKey)
    return { plan: response.plan, report: response.report, task: response.task }
  }

  async previewVariant(projectId: string, variantId: string, input: PreviewVideoVariantInput, idempotencyKey: string) {
    return (await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/delivery-variants/${encodeURIComponent(variantId)}/preview`, input, taskResponseSchema, idempotencyKey)).task
  }

  async renderVariant(projectId: string, variantId: string, input: RenderVideoVariantInput, idempotencyKey: string) {
    return (await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/delivery-variants/${encodeURIComponent(variantId)}/render`, input, taskResponseSchema, idempotencyKey)).task
  }

  async confirmPostRenderQuality(projectId: string, operationId: string, input: ConfirmVideoPostRenderQualityInput, idempotencyKey: string): Promise<VideoPostRenderQualityConfirmationResult> {
    const response = await this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(operationId)}/quality-confirmation`, input, acknowledgementResponseSchema, idempotencyKey)
    return { acknowledgement: response.acknowledgement, task: response.task, reused: response.reused }
  }

  async cancelOperation(operationId: string) {
    return (await this.post(`/api/videos/operations/${encodeURIComponent(operationId)}/cancel`, undefined, taskResponseSchema)).task
  }

  async exportDestination(projectId: string, variantId: string): Promise<Readonly<{ mimeType: 'video/mp4' | 'video/quicktime'; extension: 'mp4' | 'mov'; defaultName: string }>> {
    const [workspace, variant] = await Promise.all([
      this.loadWorkspace(projectId, 0),
      this.get(`/api/videos/projects/${encodeURIComponent(projectId)}/delivery-variants/${encodeURIComponent(variantId)}`, variantReadResponseSchema),
    ])
    const profile = workspace.project.export_profile_revisions.find(candidate => candidate.id === variant.version.export_profile_revision_id)
    if (!profile) throw new ElectronVideoWorkbenchActionError('MEDIA_RESOURCE_UNAVAILABLE')
    const isQuickTime = profile.encoding.container === 'mov'
    const extension = isQuickTime ? 'mov' : 'mp4'
    return {
      mimeType: isQuickTime ? 'video/quicktime' : 'video/mp4',
      extension,
      defaultName: `video-delivery-${variantId}.${extension}`,
    }
  }

  private async get<T>(path: string, schema: ResponseSchema<T>, query: Record<string, string> = {}): Promise<T> {
    const queryString = new URLSearchParams(query).toString()
    return await this.request(`${path}${queryString ? `?${queryString}` : ''}`, 'GET', undefined, schema)
  }

  private async post<T>(path: string, body: unknown, schema: ResponseSchema<T>, idempotencyKey?: string): Promise<T> {
    return await this.request(path, 'POST', body, schema, idempotencyKey)
  }

  private async request<T>(path: string, method: 'GET' | 'POST', body: unknown, schema: ResponseSchema<T>, idempotencyKey?: string): Promise<T> {
    const baseUrl = (await this.options.getServerUrl()).replace(/\/+$/, '')
    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          [MEDIA_UI_CAPABILITY_HEADER]: this.options.capability,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new ElectronVideoWorkbenchActionError('MEDIA_TEMPORARILY_UNAVAILABLE')
    }
    const payload: unknown = await response.json().catch(() => ({}))
    const errorPayload = mediaSafeErrorResponseSchema.safeParse(payload)
    if (!response.ok) throw new ElectronVideoWorkbenchActionError(errorPayload.success ? errorPayload.data.error : undefined)
    try {
      return schema.parse(payload)
    } catch {
      throw new ElectronVideoWorkbenchActionError('MEDIA_TEMPORARILY_UNAVAILABLE')
    }
  }
}
