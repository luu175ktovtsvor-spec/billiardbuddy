import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod/v4'
import {
  addVideoSourceInputSchema,
  analyzeVideoBeatInputSchema,
  createVideoBeatSyncDraftInputSchema,
  analyzeVideoSubjectTrackInputSchema,
  createVideoAudioFinishingPlanInputSchema,
  createVideoCaptionDraftInputSchema,
  createVideoCaptionRevisionInputSchema,
  createVideoCaptionTranslationInputSchema,
  createVideoCompositionPlanInputSchema,
  confirmVideoPostRenderQualityInputSchema,
  preflightVideoVariantInputSchema,
  previewVideoVariantInputSchema,
  renderVideoVariantInputSchema,
  acceptTimelineDraftInputSchema,
  applyDeliveryVariantCommandsInputSchema,
  applyEditorialTimelineCommandsInputSchema,
  analyzeVideoProjectInputSchema,
  applyVideoAlternativeInputSchema,
  acceptVideoCreativeProposalInputSchema,
  createVideoCreativeSessionInputSchema,
  createVideoReviewNoteInputSchema,
  createVideoApprovalDecisionInputSchema,
  createVideoEditorialPlanInputSchema,
  createVideoSourceRangeDecisionInputSchema,
  createDeliveryVariantInputSchema,
  createVideoProjectInputSchema,
  createRemoteAnalysisConsentInputSchema,
  estimateRemoteAnalysisInputSchema,
  revokeRemoteAnalysisConsentInputSchema,
  lockVideoSceneInputSchema,
  mediaSafeError,
  mediaSafeErrorForServiceError,
  MEDIA_UI_CAPABILITY_HEADER,
  publicMediaDeletionReceiptSchema,
  publicMediaJobEventPageSchema,
  publicMediaTaskSchema,
  publicVideoFactPageSchema,
  publicVideoFactSearchPageSchema,
  publicVideoFactSummarySchema,
  publicVideoStudioProjectSchema,
  videoWorkbenchWorkspaceSnapshotSchema,
  selectVideoTimelineVersionInputSchema,
  deliveryVariantSchema,
  deliveryVariantVersionSchema,
  videoCaptionDocumentRevisionSchema,
  videoCaptionDocumentSchema,
  videoCompositionPlanSchema,
  videoAudioFinishingPlanSchema,
  videoQualityReportSchema,
  videoQualityAcknowledgementSchema,
  videoExecutionPlanSchema,
  editorialTimelineVersionSchema,
  timelineDraftSchema,
  updateVideoTimelineInputSchema,
  upsertVideoDeliveryIntentInputSchema,
  postVideoCreativeMessageInputSchema,
  resolveVideoReviewNoteInputSchema,
  quickCreateVideoInputSchema,
  videoCreativeProposalSchema,
  videoCreativeResponseSchema,
  videoCreativeSessionSchema,
  videoDeliveryIntentSchema,
  videoDurationFeasibilitySchema,
  videoEditorialPlanSchema,
  videoSourceRangeDecisionSchema,
  videoQuickCreateBatchSchema,
  videoReviewNoteSchema,
  videoApprovalDecisionSchema,
  type PublicMediaTask,
  type PublicVideoStudioProject,
  type VideoStudioProject,
} from '../../../shared/contracts/media.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { VideoWorkbenchRepositoryError, type VideoOperation, type VideoOperationEvent } from '../services/videoWorkbenchRepository.js'
import { VideoWorkbenchService, VideoWorkbenchServiceError } from '../services/videoWorkbenchService.js'
import { factKind, factSourceRange, type VideoFact, type VideoFactKind } from '../video/domain/mediaFacts/model.js'
import { materializeVideoReviewNotes } from '../video/domain/editorial/review.js'
import { VideoFactsRepositoryError } from '../video/infrastructure/sqliteMediaFactsRepository.js'

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}

async function parseJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw ApiError.badRequest('请求体不是合法 JSON')
  }
}

function requireMediaUiCapability(req: Request, expected: string): void {
  const presented = req.headers.get(MEDIA_UI_CAPABILITY_HEADER)?.trim() ?? ''
  const expectedBytes = Buffer.from(expected)
  const presentedBytes = Buffer.from(presented)
  if (
    expectedBytes.length < 32
    || expectedBytes.length !== presentedBytes.length
    || !timingSafeEqual(expectedBytes, presentedBytes)
  ) {
    throw new VideoWorkbenchServiceError('此操作只能从 BilliardBuddy 桌面工作台确认', 403, 'MEDIA_UI_CONFIRMATION_REQUIRED')
  }
}

function isVideoWriteMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

function requireIdempotencyKey(req: Request): string {
  return z.string().trim().min(16).max(160).parse(req.headers.get('Idempotency-Key') ?? '')
}

function apiErrorResponse(error: unknown): Response {
  if (error instanceof VideoWorkbenchServiceError || error instanceof VideoWorkbenchRepositoryError) {
    const safe = mediaSafeErrorForServiceError(error.code, error.status)
    return Response.json({ error: safe.code, message: safe.message }, { status: error.status })
  }
  if (error instanceof VideoFactsRepositoryError) {
    const status = error.code === 'VIDEO_FACTS_INVALID' ? 400 : error.code === 'VIDEO_FACTS_NOT_FOUND' ? 404 : 500
    const safe = error.code === 'VIDEO_FACTS_INVALID'
      ? mediaSafeError('MEDIA_INVALID_REQUEST')
      : error.code === 'VIDEO_FACTS_NOT_FOUND'
        ? mediaSafeError('MEDIA_RESOURCE_UNAVAILABLE')
        : mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
    return Response.json({ error: safe.code, message: safe.message }, { status })
  }
  if (error instanceof z.ZodError) {
    const safe = mediaSafeError('MEDIA_INVALID_REQUEST')
    return Response.json({ error: safe.code, message: safe.message }, { status: 400 })
  }
  if (error instanceof ApiError) {
    const safe = mediaSafeErrorForServiceError(error.code, error.statusCode)
    return Response.json({ error: safe.code, message: safe.message }, { status: error.statusCode })
  }
  errorResponse(error)
  const safe = mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE')
  return Response.json({ error: safe.code, message: safe.message }, { status: 500 })
}

export function publicVideoProject(project: VideoStudioProject): PublicVideoStudioProject {
  const {
    owner: _owner,
    writer_fence: _writerFence,
    assets: _assets,
    versions: _versions,
    output_path: _outputPath,
    workspace_root: _workspaceRoot,
    error: rawError,
    error_code: errorCode,
    ...safeProject
  } = project
  const failure = rawError ? mediaSafeError(errorCode ?? 'MEDIA_VIDEO_EXPORT_FAILED') : null
  return publicVideoStudioProjectSchema.parse({
    ...safeProject,
    review_notes: materializeVideoReviewNotes(project),
    ...(failure ? { error: failure.message, error_code: failure.code } : {}),
  })
}

export function publicVideoTask(operation: VideoOperation): PublicMediaTask {
  const { owner: _owner, attempt: _attempt, result, error: rawError, error_code: errorCode, ...safeOperation } = operation
  const fallback = operation.kind === 'video.probe'
    ? 'MEDIA_VIDEO_SOURCE_UNREADABLE'
    : operation.kind === 'video.fingerprint'
      ? 'MEDIA_VIDEO_SOURCE_UNREADABLE'
    : operation.kind === 'video.analyze' || operation.kind === 'video.plan' || operation.kind === 'video.beat_analyze'
      ? 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE'
    : operation.kind === 'video.caption_draft' || operation.kind === 'video.caption_translation' || operation.kind === 'video.composition_plan' || operation.kind === 'video.audio_finish_plan' || operation.kind === 'video.subject_track' || operation.kind === 'video.beat_sync_draft'
        ? 'MEDIA_VIDEO_FINISHING_UNAVAILABLE'
        : operation.kind === 'video.quality_preflight' || operation.kind === 'video.quality_post_render'
          ? 'MEDIA_VIDEO_QUALITY_BLOCKED'
      : operation.kind === 'video.preview'
        ? 'MEDIA_VIDEO_PREVIEW_FAILED'
        : 'MEDIA_VIDEO_EXPORT_FAILED'
  const failure = rawError ? mediaSafeError(errorCode ?? fallback) : null
  const allowedKeys = operation.kind === 'video.probe'
    ? ['source_id']
    : operation.kind === 'video.fingerprint'
      ? ['source_id', 'media_facts']
      : operation.kind === 'video.analyze'
        ? ['evidence_revision', 'evidence_count', 'next_task_id']
        : operation.kind === 'video.plan'
      ? ['timeline_draft_id', 'project_revision', 'alternative_count']
          : operation.kind === 'video.beat_analyze'
            ? ['source_id', 'audio_stream_index', 'evidence_id', 'confidence', 'bpm']
            : operation.kind === 'video.subject_track'
              ? ['source_id', 'subject_id', 'evidence_id', 'confidence']
              : operation.kind === 'video.beat_sync_draft'
                ? ['timeline_draft_id', 'evidence_id', 'confidence', 'cut_count']
            : operation.kind === 'video.caption_draft' || operation.kind === 'video.caption_translation'
              ? ['caption_document_id', 'caption_revision_id', 'caption_style_id']
              : operation.kind === 'video.composition_plan'
                ? ['composition_plan_id']
                : operation.kind === 'video.audio_finish_plan'
                  ? ['audio_finishing_plan_id']
                  : operation.kind === 'video.quality_preflight'
                    ? ['execution_plan_id', 'report_id', 'report']
                    : operation.kind === 'video.output_verify'
                      ? ['parent_operation_id', 'execution_plan_id', 'output_verification']
                      : operation.kind === 'video.quality_post_render'
                        ? ['parent_operation_id', 'execution_plan_id', 'report_id', 'report']
        : operation.kind === 'video.preview'
          ? ['preview_revision', 'timeline_version_id', 'delivery_variant_version_id', 'execution_plan_id', 'preflight_report_id', 'asset_id', 'asset_path', 'content_hash', 'sidecar_caption', 'video_encoder', 'encoder_fallback_from']
          : ['render_revision', 'timeline_version_id', 'delivery_variant_version_id', 'execution_plan_id', 'preflight_report_id', 'post_render_report_id', 'output_asset_id', 'output_content_hash', 'output_verification', 'post_render_report', 'awaiting_quality_confirmation', 'quality_acknowledgement', 'video_encoder', 'encoder_fallback_from']
  const safeResult = result ? Object.fromEntries(allowedKeys.flatMap(key => result[key] === undefined ? [] : [[key, result[key]]])) : undefined
  return publicMediaTaskSchema.parse({
    ...safeOperation,
    ...(safeResult ? { result: safeResult } : {}),
    ...(failure ? { error: failure.message, error_code: failure.code } : {}),
  })
}

function publicVideoEvent(event: VideoOperationEvent) {
  return {
    schema_version: event.schema_version,
    cursor: event.cursor,
    project_id: event.project_id,
    task_id: event.operation.id,
    operation_id: event.operation_id,
    status_sequence: event.status_sequence,
    occurred_at: event.occurred_at,
    task: publicVideoTask(event.operation),
  }
}

export function publicVideoEventPage(page: Awaited<ReturnType<VideoWorkbenchService['waitForOperationEvents']>>) {
  return publicMediaJobEventPageSchema.parse({ ...page, events: page.events.map(publicVideoEvent) })
}

function publicVideoFactSummary(value: VideoFact) {
  const kind = factKind(value)
  const sourceId = 'fast_identity' in value ? value.id : 'source_id' in value ? value.source_id : undefined
  const sourceFingerprint = 'source_fingerprint' in value ? value.source_fingerprint : 'fingerprint' in value ? value.fingerprint : undefined
  return publicVideoFactSummarySchema.parse({
    id: value.id,
    kind,
    ...(sourceId ? { source_id: sourceId } : {}),
    ...(sourceFingerprint ? { source_fingerprint: sourceFingerprint } : {}),
    ...('content_segment_id' in value && value.content_segment_id
      ? { segment_id: value.content_segment_id }
      : kind === 'content_segment' ? { segment_id: value.id } : {}),
    ...(factSourceRange(value) ? { range: factSourceRange(value) } : {}),
    ...('state' in value ? { state: value.state } : {}),
    ...('fingerprint_state' in value ? { fingerprint_state: value.fingerprint_state } : {}),
    ...('sample_strategy' in value ? { sample_strategy: value.sample_strategy } : {}),
    ...('analysis_depth' in value ? { analysis_depth: value.analysis_depth } : {}),
    ...('coverage' in value ? { coverage: value.coverage } : {}),
    created_at: value.created_at,
  })
}

function factKindParameter(value: string | undefined): VideoFactKind {
  const allowed: VideoFactKind[] = ['source', 'derivative', 'transcript', 'transcript_revision', 'camera_shot', 'content_segment', 'evidence_window', 'evidence']
  if (!value || !allowed.includes(value as VideoFactKind)) throw ApiError.badRequest('视频事实类型无效')
  return value as VideoFactKind
}

function boundedQueryInteger(value: string | null, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw ApiError.badRequest(`${label} 必须在 ${minimum} 到 ${maximum} 之间`)
  return parsed
}

export function createVideoWorkbenchApiHandler(
  service: VideoWorkbenchService,
  mediaUiCapability = '',
) {
  return async function handleVideoWorkbenchApi(req: Request, url: URL, segments: string[]): Promise<Response> {
    try {
      if (segments[2] !== 'videos') throw ApiError.notFound('找不到视频接口')
      // All state-changing video routes are desktop-confirmed.  Keep this at
      // the route boundary so legacy compatibility endpoints cannot become a
      // second unguarded writer when they are revived or moved.
      if (isVideoWriteMethod(req.method)) requireMediaUiCapability(req, mediaUiCapability)
      if (segments[3] === 'toolchain') {
        if (req.method !== 'GET' || segments[4]) throw methodNotAllowed(req.method)
        const status = await service.toolchainStatus()
        return Response.json({ ffmpeg: { available: status.ffmpeg.available }, ffprobe: { available: status.ffprobe.available } })
      }
      if (segments[3] !== 'projects') throw ApiError.notFound('找不到视频接口')
      const projectId = segments[4]
      const action = segments[5]
      if (!projectId) {
        if (req.method === 'GET' && !action) return Response.json({ projects: (await service.listProjects()).map(publicVideoProject) })
        if (req.method !== 'POST' || action) throw methodNotAllowed(req.method)
        const input = createVideoProjectInputSchema.parse(await parseJson(req))
        return Response.json({ project: publicVideoProject(await service.createProject(input)) }, { status: 201 })
      }
      await service.assertProjectOwner(projectId)
      if (!action) {
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({ project: publicVideoProject(await service.getProject(projectId)) })
      }
      if (action === 'workspace') {
        if (req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        const eventCursor = boundedQueryInteger(url.searchParams.get('event_cursor'), 0, 0, Number.MAX_SAFE_INTEGER, 'event_cursor')
        const snapshot = await service.getWorkspaceSnapshotData(projectId, eventCursor)
        const currentTimeline = snapshot.project.current_editorial_timeline_version_id
          ? snapshot.project.editorial_timeline_versions.find(candidate => candidate.id === snapshot.project.current_editorial_timeline_version_id)
          : undefined
        if (snapshot.project.current_editorial_timeline_version_id && !currentTimeline) {
          throw new VideoWorkbenchServiceError('当前编辑时间线引用已损坏，无法提供工作台快照', 409, 'VIDEO_EDITORIAL_STALE')
        }
        const variants = snapshot.project.delivery_variants.map(variant => {
          const version = snapshot.project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)
          if (!version) throw new VideoWorkbenchServiceError('交付变体版本引用已损坏，无法提供工作台快照', 409, 'VIDEO_FINISHING_STALE')
          return { variant, version }
        })
        return Response.json(videoWorkbenchWorkspaceSnapshotSchema.parse({
          project: publicVideoProject(snapshot.project),
          ...(currentTimeline ? { current_timeline: editorialTimelineVersionSchema.parse(currentTimeline) } : {}),
          timeline_drafts: snapshot.project.timeline_drafts,
          variants,
          facts: publicVideoFactPageSchema.parse({
            schema_version: 1,
            items: snapshot.facts.items.map(publicVideoFactSummary),
            ...(snapshot.facts.next_cursor ? { next_cursor: snapshot.facts.next_cursor } : {}),
          }),
          caption_documents: snapshot.project.caption_documents,
          caption_revisions: snapshot.project.caption_document_revisions,
          composition_plans: snapshot.project.composition_plans,
          audio_finishing_plans: snapshot.project.audio_finishing_plans,
          execution_plans: snapshot.project.execution_plans,
          quality_reports: snapshot.project.quality_reports,
          ...(snapshot.project.preview ? { preview: snapshot.project.preview } : {}),
          ...(snapshot.project.output_verification ? { output_verification: snapshot.project.output_verification } : {}),
          operations: snapshot.operations.map(publicVideoTask),
          events: publicVideoEventPage(snapshot.events),
        }))
      }
      if (action === 'sources') {
        const sourceId = segments[6]
        if (sourceId && segments[7] === 'content' && !segments[8] && req.method === 'GET') {
          return await service.sourceResponse(projectId, sourceId, req)
        }
        if (req.method !== 'POST' || sourceId) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = addVideoSourceInputSchema.parse(await parseJson(req))
        const result = await service.addVideoSource(projectId, input)
        return Response.json({ project: publicVideoProject(result.project), task: publicVideoTask(result.task) }, { status: 201 })
      }
      if (action === 'facts') {
        if (req.method !== 'GET' || !segments[6] || segments[7]) throw methodNotAllowed(req.method)
        const kind = factKindParameter(segments[6])
        const sourceId = url.searchParams.get('source_id')
        if (sourceId !== null) z.string().regex(/^[a-z0-9][a-z0-9_-]{7,79}$/).parse(sourceId)
        const cursor = url.searchParams.get('cursor')
        if (cursor !== null && (!cursor || cursor.length > 2048)) throw ApiError.badRequest('视频事实分页游标无效')
        const page = await service.pageMediaFacts(projectId, kind, {
          ...(sourceId ? { sourceId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: boundedQueryInteger(url.searchParams.get('limit'), 50, 1, 200, 'limit'),
        })
        return Response.json(publicVideoFactPageSchema.parse({
          schema_version: 1,
          items: page.items.map(publicVideoFactSummary),
          ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        }))
      }
      if (action === 'search') {
        if (req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        const query = z.string().trim().min(1).max(1000).parse(url.searchParams.get('q') ?? '')
        const cursor = url.searchParams.get('cursor')
        if (cursor !== null && (!cursor || cursor.length > 2048)) throw ApiError.badRequest('视频事实搜索游标无效')
        const page = await service.searchMediaFacts(projectId, query, {
          ...(cursor ? { cursor } : {}),
          limit: boundedQueryInteger(url.searchParams.get('limit'), 50, 1, 100, 'limit'),
        })
        return Response.json(publicVideoFactSearchPageSchema.parse({ schema_version: 1, ...page }))
      }
      if (action === 'timelines') {
        const versionId = segments[6]
        if (!versionId) throw ApiError.badRequest('缺少编辑时间线版本 ID')
        if (!segments[7]) {
          if (req.method !== 'GET') throw methodNotAllowed(req.method)
          return Response.json({ timeline: editorialTimelineVersionSchema.parse(await service.getEditorialTimeline(projectId, versionId)) })
        }
        if (segments[7] === 'review-notes') {
          const noteId = segments[8]
          if (!noteId) {
            if (req.method === 'GET' && !segments[8]) {
              return Response.json({ notes: (await service.getReviewNotes(projectId, versionId)).map(note => videoReviewNoteSchema.parse(note)) })
            }
            if (req.method !== 'POST' || segments[8]) throw methodNotAllowed(req.method)
            const result = await service.createReviewNote(
              projectId,
              versionId,
              createVideoReviewNoteInputSchema.parse(await parseJson(req)),
              requireIdempotencyKey(req),
            )
            return Response.json({
              project: publicVideoProject(result.project),
              note: videoReviewNoteSchema.parse(result.note),
              reused: result.reused,
            }, { status: result.reused ? 200 : 201 })
          }
          if (segments[9] === 'resolve' && !segments[10]) {
            if (req.method !== 'POST') throw methodNotAllowed(req.method)
            const result = await service.resolveReviewNote(
              projectId,
              versionId,
              noteId,
              resolveVideoReviewNoteInputSchema.parse(await parseJson(req)),
              requireIdempotencyKey(req),
            )
            return Response.json({
              project: publicVideoProject(result.project),
              note: videoReviewNoteSchema.parse(result.note),
              reused: result.reused,
            }, { status: result.reused ? 200 : 201 })
          }
          throw methodNotAllowed(req.method)
        }
        if (segments[7] === 'approval' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.createApprovalDecision(
            projectId,
            versionId,
            createVideoApprovalDecisionInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({
            project: publicVideoProject(result.project),
            decision: videoApprovalDecisionSchema.parse(result.decision),
            reused: result.reused,
          }, { status: result.reused ? 200 : 201 })
        }
        if (segments[7] === 'commands' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const input = applyEditorialTimelineCommandsInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), base_timeline_version_id: versionId })
          const result = await service.applyEditorialTimelineCommands(projectId, input, requireIdempotencyKey(req))
          return Response.json({ project: publicVideoProject(result.project), timeline: editorialTimelineVersionSchema.parse(result.version), reused: result.reused })
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'timeline-drafts') {
        const draftId = segments[6]
        if (!draftId) throw ApiError.badRequest('缺少时间线草稿 ID')
        if (!segments[7]) {
          if (req.method !== 'GET') throw methodNotAllowed(req.method)
          return Response.json({ draft: timelineDraftSchema.parse(await service.getTimelineDraft(projectId, draftId)) })
        }
        if (segments[7] === 'accept' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.acceptTimelineDraft(
            projectId,
            draftId,
            acceptTimelineDraftInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({ project: publicVideoProject(result.project), timeline: editorialTimelineVersionSchema.parse(result.version), reused: result.reused })
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'delivery-intent') {
        if (req.method !== 'PUT' || segments[6]) throw methodNotAllowed(req.method)
        const result = await service.updateDeliveryIntent(
          projectId,
          upsertVideoDeliveryIntentInputSchema.parse(await parseJson(req)),
        )
        return Response.json({
          project: publicVideoProject(result.project),
          intent: videoDeliveryIntentSchema.parse(result.intent),
          feasibility: videoDurationFeasibilitySchema.parse(result.feasibility),
        })
      }
      if (action === 'duration-feasibility') {
        if (req.method !== 'GET' || segments[6]) throw methodNotAllowed(req.method)
        return Response.json({ feasibility: videoDurationFeasibilitySchema.parse(await service.getDurationFeasibility(projectId)) })
      }
      if (action === 'range-decisions') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        const result = await service.createSourceRangeDecision(
          projectId,
          createVideoSourceRangeDecisionInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )
        return Response.json({
          project: publicVideoProject(result.project),
          decision: videoSourceRangeDecisionSchema.parse(result.decision),
          ...(result.feasibility ? { feasibility: videoDurationFeasibilitySchema.parse(result.feasibility) } : {}),
          reused: result.reused,
        }, { status: result.reused ? 200 : 201 })
      }
      if (action === 'editorial-plans') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        const result = await service.createEditorialPlans(
          projectId,
          createVideoEditorialPlanInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )
        return Response.json({
          project: publicVideoProject(result.project),
          plans: result.plans.map(plan => videoEditorialPlanSchema.parse(plan)),
          feasibility: videoDurationFeasibilitySchema.parse(result.feasibility),
          reused: result.reused,
        }, { status: result.reused ? 200 : 201 })
      }
      if (action === 'quick-create') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        const result = await service.quickCreate(
          projectId,
          quickCreateVideoInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )
        return Response.json({
          project: publicVideoProject(result.project),
          batch: videoQuickCreateBatchSchema.parse(result.batch),
          drafts: result.drafts.map(draft => timelineDraftSchema.parse(draft)),
          reused: result.reused,
        }, { status: result.reused ? 200 : 201 })
      }
      if (action === 'creative-sessions') {
        const sessionId = segments[6]
        if (!sessionId) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.createCreativeSession(
            projectId,
            createVideoCreativeSessionInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({ project: publicVideoProject(result.project), session: videoCreativeSessionSchema.parse(result.session), reused: result.reused }, { status: result.reused ? 200 : 201 })
        }
        if (segments[7] === 'messages' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.postCreativeMessage(
            projectId,
            sessionId,
            postVideoCreativeMessageInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({
            project: publicVideoProject(result.project),
            response: videoCreativeResponseSchema.parse(result.response),
            ...(result.proposal ? { proposal: videoCreativeProposalSchema.parse(result.proposal) } : {}),
            reused: result.reused,
          }, { status: result.reused ? 200 : 201 })
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'creative-proposals') {
        const proposalId = segments[6]
        if (!proposalId) throw ApiError.badRequest('缺少创作 Proposal ID')
        if (!segments[7]) {
          if (req.method !== 'GET') throw methodNotAllowed(req.method)
          return Response.json({ proposal: videoCreativeProposalSchema.parse(await service.getCreativeProposal(projectId, proposalId)) })
        }
        if (segments[7] === 'accept' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.acceptCreativeProposal(
            projectId,
            proposalId,
            acceptVideoCreativeProposalInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({
            project: publicVideoProject(result.project),
            proposal: videoCreativeProposalSchema.parse(result.proposal),
            ...(result.version && 'tracks' in result.version
              ? { timeline: editorialTimelineVersionSchema.parse(result.version) }
              : { variant_version: deliveryVariantVersionSchema.parse(result.version) }),
            reused: result.reused,
          })
        }
        if (segments[7] === 'reject' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.rejectCreativeProposal(projectId, proposalId, requireIdempotencyKey(req))
          return Response.json({ project: publicVideoProject(result.project), proposal: videoCreativeProposalSchema.parse(result.proposal), reused: result.reused })
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'captions') {
        if (segments[6] === 'drafts' && !segments[7]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const result = await service.createCaptionDraft(
            projectId,
            createVideoCaptionDraftInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({
            project: publicVideoProject(result.project),
            document: videoCaptionDocumentSchema.parse(result.document),
            revision: videoCaptionDocumentRevisionSchema.parse(result.revision),
            task: publicVideoTask(result.task),
          }, { status: 201 })
        }
        const documentId = segments[6]
        if (documentId && segments[7] === 'translations' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const result = await service.createCaptionTranslation(
            projectId,
            documentId,
            createVideoCaptionTranslationInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({
            project: publicVideoProject(result.project),
            revision: videoCaptionDocumentRevisionSchema.parse(result.revision),
            task: publicVideoTask(result.task),
          }, { status: 201 })
        }
        if (documentId && segments[7] === 'revisions' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const result = await service.createCaptionRevision(
            projectId,
            documentId,
            createVideoCaptionRevisionInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({ project: publicVideoProject(result.project), revision: videoCaptionDocumentRevisionSchema.parse(result.revision), task: publicVideoTask(result.task) }, { status: 201 })
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'composition-plans') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const result = await service.createCompositionPlan(
          projectId,
          createVideoCompositionPlanInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )
        return Response.json({ project: publicVideoProject(result.project), plan: videoCompositionPlanSchema.parse(result.plan), task: publicVideoTask(result.task) }, { status: 201 })
      }
      if (action === 'audio-finishing-plans') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const result = await service.createAudioFinishingPlan(
          projectId,
          createVideoAudioFinishingPlanInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )
        return Response.json({ project: publicVideoProject(result.project), plan: videoAudioFinishingPlanSchema.parse(result.plan), task: publicVideoTask(result.task) }, { status: 201 })
      }
      if (action === 'beat-analysis') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return Response.json({ task: publicVideoTask(await service.analyzeVideoBeat(
          projectId,
          analyzeVideoBeatInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )) }, { status: 202 })
      }
      if (action === 'beat-sync-drafts') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const result = await service.createBeatSyncTimelineDraft(
          projectId,
          createVideoBeatSyncDraftInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )
        return Response.json({
          project: publicVideoProject(result.project),
          draft: timelineDraftSchema.parse(result.draft),
          task: publicVideoTask(result.task),
        }, { status: 201 })
      }
      if (action === 'subject-tracks') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const result = await service.analyzeVideoSubjectTrack(
          projectId,
          analyzeVideoSubjectTrackInputSchema.parse(await parseJson(req)),
          requireIdempotencyKey(req),
        )
        return Response.json({
          project: publicVideoProject(result.project),
          evidence: publicVideoFactSummary(result.evidence),
          task: publicVideoTask(result.task),
        }, { status: 201 })
      }
      if (action === 'quality-reports') {
        const reportId = segments[6]
        if (!reportId || segments[7] || req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({ report: videoQualityReportSchema.parse(await service.getQualityReport(projectId, reportId)) })
      }
      if (action === 'renders') {
        const operationId = segments[6]
        if (!operationId || segments[7] !== 'quality-confirmation' || segments[8] || req.method !== 'POST') throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        // Keep the final publication acknowledgement on the same desktop
        // command boundary as every other video mutation.  The service itself
        // makes the acknowledgement idempotent against the frozen render,
        // while this header prevents an untracked write path from appearing
        // when the Electron broker is wired in.
        requireIdempotencyKey(req)
        const result = await service.confirmPostRenderQuality(
          projectId,
          operationId,
          confirmVideoPostRenderQualityInputSchema.parse(await parseJson(req)),
        )
        return Response.json({
          project: publicVideoProject(result.project),
          acknowledgement: videoQualityAcknowledgementSchema.parse(result.acknowledgement),
          task: publicVideoTask(result.task),
          reused: result.reused,
        }, { status: result.reused ? 200 : 201 })
      }
      if (action === 'delivery-variants') {
        const variantId = segments[6]
        if (!variantId) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.createDeliveryVariant(
            projectId,
            createDeliveryVariantInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({ project: publicVideoProject(result.project), variant: deliveryVariantSchema.parse(result.variant), version: deliveryVariantVersionSchema.parse(result.version), reused: result.reused }, { status: result.reused ? 200 : 201 })
        }
        if (!segments[7]) {
          if (req.method !== 'GET') throw methodNotAllowed(req.method)
          const result = await service.getDeliveryVariant(projectId, variantId)
          return Response.json({ variant: deliveryVariantSchema.parse(result.variant), version: deliveryVariantVersionSchema.parse(result.version) })
        }
        if (segments[7] === 'commands' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const result = await service.applyDeliveryVariantCommands(
            projectId,
            variantId,
            applyDeliveryVariantCommandsInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({ project: publicVideoProject(result.project), version: deliveryVariantVersionSchema.parse(result.version), reused: result.reused })
        }
        if (segments[7] === 'preflight' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          const result = await service.preflightDeliveryVariant(
            projectId,
            variantId,
            preflightVideoVariantInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )
          return Response.json({ project: publicVideoProject(result.project), plan: videoExecutionPlanSchema.parse(result.plan), report: videoQualityReportSchema.parse(result.report), task: publicVideoTask(result.task) }, { status: 201 })
        }
        if (segments[7] === 'preview' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          return Response.json({ task: publicVideoTask(await service.previewDeliveryVariant(
            projectId,
            variantId,
            previewVideoVariantInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )) }, { status: 202 })
        }
        if (segments[7] === 'render' && !segments[8]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          return Response.json({ task: publicVideoTask(await service.renderDeliveryVariant(
            projectId,
            variantId,
            renderVideoVariantInputSchema.parse(await parseJson(req)),
            requireIdempotencyKey(req),
          )) }, { status: 202 })
        }
        if (segments[7] === 'compile' && !segments[8]) {
          throw ApiError.notFound('交付编译由预检与执行任务内部完成')
        }
        throw methodNotAllowed(req.method)
      }
      if (action === 'timeline') {
        if (segments[6] === 'versions' && segments[7] && segments[8] === 'select' && !segments[9]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          const input = selectVideoTimelineVersionInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), version_id: segments[7] })
          return Response.json({ project: publicVideoProject(await service.selectTimelineVersion(projectId, input)) })
        }
        if (req.method !== 'PUT' || segments[6]) throw methodNotAllowed(req.method)
        const input = updateVideoTimelineInputSchema.parse(await parseJson(req))
        return Response.json({ project: publicVideoProject(await service.updateTimeline(projectId, input)) })
      }
      if (action === 'analyze') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const input = analyzeVideoProjectInputSchema.parse(await parseJson(req))
        return Response.json({ task: publicVideoTask(await service.analyzeVideoProject(projectId, input)) }, { status: 202 })
      }
      if (action === 'analysis-estimates') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        return Response.json({ estimate: await service.estimateRemoteAnalysis(projectId, estimateRemoteAnalysisInputSchema.parse(await parseJson(req))) }, { status: 201 })
      }
      if (action === 'remote-analysis-consent') {
        if (segments[6] === 'revoke' && !segments[7]) {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          requireMediaUiCapability(req, mediaUiCapability)
          return Response.json({ project: publicVideoProject(await service.revokeRemoteAnalysisConsent(projectId, revokeRemoteAnalysisConsentInputSchema.parse(await parseJson(req)))) })
        }
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        requireMediaUiCapability(req, mediaUiCapability)
        const result = await service.grantRemoteAnalysisConsent(projectId, createRemoteAnalysisConsentInputSchema.parse(await parseJson(req)))
        return Response.json({ project: publicVideoProject(result.project), consent: result.consent }, { status: 201 })
      }
      if (action === 'scenes') {
        const sceneId = segments[6]
        if (!sceneId || segments[7] !== 'lock' || segments[8] || req.method !== 'POST') throw methodNotAllowed(req.method)
        const input = lockVideoSceneInputSchema.parse(await parseJson(req))
        return Response.json({ project: publicVideoProject(await service.lockScene(projectId, sceneId, input)) })
      }
      if (action === 'alternatives') {
        const alternativeId = segments[6]
        if (!alternativeId || segments[7] !== 'apply' || segments[8] || req.method !== 'POST') throw methodNotAllowed(req.method)
        const input = applyVideoAlternativeInputSchema.parse({ ...(await parseJson(req) as Record<string, unknown>), alternative_id: alternativeId })
        return Response.json({ project: publicVideoProject(await service.applyAlternative(projectId, input)) })
      }
      if (action === 'preview') {
        if (segments[6] === 'content') throw ApiError.notFound('找不到视频预览')
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        throw ApiError.notFound('旧时间线预览已退役，请先对交付变体预检后调用 /delivery-variants/:id/preview')
      }
      if (action === 'previews') {
        const assetId = segments[6]
        if (!assetId || segments[8] || req.method !== 'GET') throw methodNotAllowed(req.method)
        if (segments[7] === 'content') return await service.previewResponse(projectId, assetId, req)
        if (segments[7] === 'sidecar') return await service.previewSidecarResponse(projectId, assetId)
        throw methodNotAllowed(req.method)
      }
      if (action === 'render') {
        if (req.method !== 'POST' || segments[6]) throw methodNotAllowed(req.method)
        throw ApiError.notFound('旧时间线导出已退役，请先对交付变体预检后调用 /delivery-variants/:id/render')
      }
      throw ApiError.notFound('找不到视频接口')
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/**
 * The video workbench owns its public HTTP surface. Its prior parser remains
 * private behind this adapter while callers use `/api/videos/*` directly.
 */
export function createVideoWorkbenchDomainApiHandler(
  service: VideoWorkbenchService,
  mediaUiCapability = '',
) {
  const projectHandler = createVideoWorkbenchApiHandler(service, mediaUiCapability)
  return async function handleVideoWorkbenchDomainApi(
    req: Request,
    url: URL,
    segments: string[],
  ): Promise<Response> {
    try {
      if (segments[1] !== 'videos') throw ApiError.notFound('找不到视频接口')
      // This wrapper owns delete/restore/cancel before delegating to the
      // project handler, so it needs the same fail-closed capability gate.
      if (isVideoWriteMethod(req.method)) requireMediaUiCapability(req, mediaUiCapability)
      const area = segments[2]
      if (area === 'deletions') {
        if (req.method !== 'GET' || segments[3]) throw methodNotAllowed(req.method)
        return Response.json({
          deletions: (await service.listDeletions()).map(receipt => publicMediaDeletionReceiptSchema.parse(receipt)),
        })
      }
      if (area === 'operations') {
        const operationId = segments[3]
        if (!operationId || segments[5]) throw ApiError.badRequest('缺少视频操作 ID')
        const operation = await service.getOperation(operationId)
        await service.assertProjectOwner(operation.project_id)
        if (segments[4] === 'cancel') {
          if (req.method !== 'POST') throw methodNotAllowed(req.method)
          return Response.json({ task: publicVideoTask(await service.cancelOperation(operationId)) })
        }
        if (segments[4]) throw ApiError.badRequest('无效的视频操作')
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({ task: publicVideoTask(operation) })
      }
      if (area !== 'projects') throw ApiError.notFound('找不到视频接口')
      const projectId = segments[3]
      const action = segments[4]
      if (projectId && action === 'events') {
        if (req.method !== 'GET' || segments[5]) throw methodNotAllowed(req.method)
        const cursor = Number(url.searchParams.get('cursor') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 100)
        const waitMs = Number(url.searchParams.get('wait_ms') ?? 25_000)
        if (!Number.isInteger(cursor) || cursor < 0) throw ApiError.badRequest('cursor 必须是非负整数')
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw ApiError.badRequest('limit 必须在 1 到 200 之间')
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) throw ApiError.badRequest('wait_ms 必须在 0 到 25000 之间')
        await service.assertProjectOwner(projectId)
        return Response.json(publicVideoEventPage(
          await service.waitForOperationEvents(projectId, cursor, limit, waitMs),
        ))
      }
      if (projectId && action === 'restore') {
        if (req.method !== 'POST' || segments[5]) throw methodNotAllowed(req.method)
        return Response.json({ deletion: publicMediaDeletionReceiptSchema.parse(await service.restoreProject(projectId)) })
      }
      if (projectId && !action && req.method === 'DELETE') {
        if (segments[4]) throw ApiError.badRequest('无效的视频项目操作')
        await service.deleteProject(projectId)
        return new Response(null, { status: 204 })
      }
      // Preserve the existing request validation while exposing only the
      // video-owned route to renderer and Electron callers.
      return await projectHandler(req, url, ['api', 'media', 'videos', ...segments.slice(2)])
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}
