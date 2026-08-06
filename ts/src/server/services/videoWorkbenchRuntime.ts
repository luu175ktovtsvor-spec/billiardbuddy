import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  analyzeVideoBeatInputSchema,
  createVideoBeatSyncDraftInputSchema,
  analyzeVideoSubjectTrackInputSchema,
  acceptTimelineDraftInputSchema,
  applyDeliveryVariantCommandsInputSchema,
  analyzeVideoProjectInputSchema,
  acceptVideoCreativeProposalInputSchema,
  createVideoCreativeSessionInputSchema,
  createVideoReviewNoteInputSchema,
  createVideoApprovalDecisionInputSchema,
  createVideoEditorialPlanInputSchema,
  createVideoSourceRangeDecisionInputSchema,
  createDeliveryVariantInputSchema,
  createVideoAudioFinishingPlanInputSchema,
  createVideoCaptionDraftInputSchema,
  createVideoCaptionRevisionInputSchema,
  createVideoCaptionTranslationInputSchema,
  createVideoCompositionPlanInputSchema,
  confirmVideoPostRenderQualityInputSchema,
  mediaJobEventJournalSchema,
  mediaTaskSchema,
  mediaSafeError,
  previewVideoInputSchema,
  previewVideoVariantInputSchema,
  preflightVideoVariantInputSchema,
  renderVideoInputSchema,
  renderVideoVariantInputSchema,
  upsertVideoCreationBriefInputSchema,
  upsertVideoDeliveryIntentInputSchema,
  postVideoCreativeMessageInputSchema,
  resolveVideoReviewNoteInputSchema,
  quickCreateVideoInputSchema,
  videoPreviewTaskResultSchema,
  videoRenderTaskResultSchema,
  videoCaptionDocumentRevisionSchema,
  videoCaptionTranslationResultSchema,
  videoCreationBriefSchema,
  videoCreativeDirectionSchema,
  videoStudioProjectSchema,
  videoPlanningWorkflowSchema,
  type AnalyzeVideoBeatInput,
  type CreateVideoBeatSyncDraftInput,
  type AnalyzeVideoSubjectTrackInput,
  type AcceptTimelineDraftInput,
  type ApplyDeliveryVariantCommandsInput,
  type AnalyzeVideoProjectInput,
  type AcceptVideoCreativeProposalInput,
  type CreateVideoCreativeSessionInput,
  type CreateVideoReviewNoteInput,
  type CreateVideoApprovalDecisionInput,
  type CreateVideoEditorialPlanInput,
  type CreateVideoSourceRangeDecisionInput,
  type CreateVideoProjectInput,
  type CreateDeliveryVariantInput,
  type CreateVideoAudioFinishingPlanInput,
  type CreateVideoCaptionDraftInput,
  type CreateVideoCaptionRevisionInput,
  type CreateVideoCaptionTranslationInput,
  type CreateVideoCompositionPlanInput,
  type ConfirmVideoPostRenderQualityInput,
  type DeliveryVariant,
  type DeliveryVariantVersion,
  type EditorialTimelineVersion,
  type MediaAsset,
  type MediaOwner,
  type PreviewVideoInput,
  type PreviewVideoVariantInput,
  type PreflightVideoVariantInput,
  type RenderVideoInput,
  type RenderVideoVariantInput,
  type UpsertVideoDeliveryIntentInput,
  type UpsertVideoCreationBriefInput,
  type PostVideoCreativeMessageInput,
  type ResolveVideoReviewNoteInput,
  type QuickCreateVideoInput,
  type VideoCreativeContextAnchor,
  type VideoCreationBrief,
  type VideoReviewAnchor,
  type VideoCreativeProposal,
  type VideoApprovalDecision,
  type VideoReviewNote,
  type VideoDurationFeasibility,
  type VideoEditorialPlan,
  type VideoQuickCreateBatch,
  type VideoSourceRangeDecision,
  type VideoClip,
  type VideoCaptionDocumentRevision,
  type VideoEvidence,
  type VideoExecutionPlan,
  type VideoExportProfileRevision,
  type VideoFinishingReceipt,
  type VideoOutputVerification,
  type VideoRenderTaskResult,
  type VideoPlanningWorkflow,
  type VideoQualityAcknowledgement,
  type VideoQualityReport,
  type VideoScene,
  type VideoSource,
  type VideoStudioProject,
  type VideoTimelineItem,
  type VideoTimelineVersion,
  type TimelineDraft,
  createRemoteAnalysisConsentInputSchema,
  estimateRemoteAnalysisInputSchema,
  revokeRemoteAnalysisConsentInputSchema,
  type CreateRemoteAnalysisConsentInput,
  type EstimateRemoteAnalysisInput,
  timelineCommandSetSchema,
  timelineDraftSchema,
} from '../../../shared/contracts/media.js'
import {
  defaultVideoProcessRunner,
  buildExecutionPlanRenderCommand,
  buildVideoRenderCommand,
  FALLBACK_VIDEO_ENCODER,
  fastVideoIdentity,
  probeVideoFactSource,
  probeManagedProjectAsset,
  selectVideoEncoder,
  selectDeliveryVideoEncoder,
  videoBinary,
  videoFingerprint,
  videoToolchainStatus,
  verifyDeliveryVideoOutput,
  verifyVideoOutput,
  writeExecutionPlanCaption,
  type ExecutionPlanProjectAsset,
  type VideoProcessRunner,
} from './videoExecution.js'
import {
  createHostedEvidence,
  factBasisHash,
  factKind,
  factSourceRange,
  type CameraShot,
  type EvidenceWindow,
  type TimedTranscript,
  type VideoDerivative,
  type VideoFactEvidence,
  type VideoFact,
  type VideoFactKind,
  type VideoFactSource,
  type TranscriptRevision,
} from '../video/domain/mediaFacts/model.js'
import { materializeTranscriptRevision } from '../video/domain/mediaFacts/transcript.js'
import { DEFAULT_EVIDENCE_WINDOW_BUDGET, contentSegmentsFromCameraShots, fixedIntervalContentSegments, planEvidenceWindows } from '../video/domain/mediaFacts/analysis.js'
import {
  compareRationalTime,
  endOfRange,
  parseInt64,
  rationalTime,
  rationalTimeFromDecimalSeconds,
  rescaleRationalTime,
  sourceTimeRange,
  tickRateForTimeBase,
  timeToMilliseconds,
  type RationalTime,
  type SourceTimeRange,
} from '../video/domain/mediaFacts/time.js'
import { estimatedTextAmountMicros, estimatedTextTokens, VIDEO_REMOTE_MODEL_BINDINGS, VIDEO_REMOTE_USAGE_POLICY, VIDEO_SEMANTIC_EMBEDDING_MODEL } from '../video/application/remoteUsage.js'
import {
  analyzeVideoEvidence,
  compileVideoBrief,
  planVideoTimelineFromRelay,
  planVideoTimeline,
  VideoAnalysisError,
  type VideoAnalysisFrame,
  type VideoPlanDraft,
} from './videoAnalysis.js'
import {
  VideoWorkbenchRepository,
  VideoWorkbenchRepositoryError,
  type VideoLegacyEventJournal,
  type VideoLegacyMigrationSnapshot,
  type VideoOperation,
} from './videoWorkbenchRepository.js'
import { JobOrchestrator } from '../media/kernel/operations/jobOrchestrator.js'
import {
  EditorialApplication,
  EditorialValidationError,
  editorialFactsBasisHash,
  validateEditorialTimeline,
  type EditorialSourceBounds,
  type EditorialSourceTiming,
} from '../video/domain/editorial/editorialApplication.js'
import { materializeVideoReviewNotes, nextVideoReviewEventSequence } from '../video/domain/editorial/review.js'
import {
  FinishingDeliveryApplication,
  FinishingDeliveryValidationError,
  type AudioMeasurement,
  type AudioTranscriptAnchor,
} from '../video/domain/finishingDelivery/finishingDeliveryApplication.js'
import { detectBeatGridFromPcmChunks } from '../video/domain/finishingDelivery/beatDetector.js'
import { trackSubject } from '../video/domain/finishingDelivery/subjectTracker.js'
import { normalizeFunAsrSentences, selectFunAsrRoute, type RemoteAsrSentence } from '../video/infrastructure/providers/funAsrAdapter.js'
import { VideoMediaRelayClient, VideoMediaRelayClientError, videoMediaRelayTransportPolicyFromEnvironment } from '../video/infrastructure/providers/videoMediaRelayClient.js'
import { VideoProjectStore } from '../video/runtime/videoProjectStore.js'
import { projectAssetMimeType, videoMimeType } from '../video/runtime/videoMime.js'
import { VideoAnalysisOperationState } from '../video/application/analysisIndex.js'
import { FinishingDeliveryOperationState } from '../video/application/finishingDelivery.js'

const STANDALONE_VIDEO_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`
/** This is deliberately the same reviewed face copied by the Video Relay
 * image. Burn-in never falls back to a host font with a similar name. */
const CONTROLLED_CAPTION_FONT_FAMILY = 'Noto Sans CJK SC'
const CONTROLLED_CAPTION_FONT_FILE = 'NotoSansCJKSC-Regular.ttc'

function planningWorkflow(input: Omit<VideoPlanningWorkflow, 'clarifications'> & { clarifications?: readonly string[] }): VideoPlanningWorkflow {
  return videoPlanningWorkflowSchema.parse({
    ...input,
    clarifications: [...new Set(input.clarifications ?? [])].slice(0, 20),
  })
}

export type ActiveVideoExecution = {
  controller: AbortController
  completion: Promise<void>
  output_path: string
  /** A queued render can be cancelled before it reaches the serialized encoder. */
  started?: boolean
  cancelledBeforeStart?: boolean
}

type PcmDecodeResult = {
  chunks: AsyncIterable<Uint8Array<ArrayBufferLike>>
  completion: Promise<{ exitCode: number; stderr: string }>
}

/** A narrow local port keeps BeatGrid API contracts independent from FFmpeg. */
export type LocalPcmDecoder = (input: {
  sourcePath: string
  audioStreamIndex: number
  sampleRate: number
  /** Exact primary-video intersection, measured from the selected audio PTS. */
  startSeconds: number
  durationSeconds: number
  signal: AbortSignal
}) => PcmDecodeResult | Promise<PcmDecodeResult>

export type VideoWorkbenchRuntimeOptions = Readonly<{
  root?: string
  now?: () => Date
  runProcess?: VideoProcessRunner
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  legacyMediaRoot?: string
  pcmDecoder?: LocalPcmDecoder
  projectStore?: VideoProjectStore
  analysisState?: VideoAnalysisOperationState
  finishingState?: FinishingDeliveryOperationState
  editorialRules?: EditorialApplication
  finishingRules?: FinishingDeliveryApplication
}>

type ExtractedVideoAnalysisInputs = {
  frames: VideoAnalysisFrame[]
  transcripts: VideoEvidence[]
  relay_acknowledgements: PendingRelayAcknowledgement[]
  gaps: string[]
  source_facts: Map<string, VideoFactSource>
  evidence_windows: Map<string, EvidenceWindow>
}

type PendingRelayAcknowledgement = VideoStudioProject['pending_relay_acknowledgements'][number]

type PendingPostRenderQuality = {
  result: VideoRenderTaskResult
  report: VideoQualityReport
  plan: VideoExecutionPlan
}

/** A paid planning result is first staged in the durable local Operation.
 * It is intentionally separate from the public Project projection: a restart
 * can finish the projection without re-downloading or re-submitting it. */
type StagedRemotePlanningResult = {
  base_revision: number
  base_timeline_version_id?: string
  evidence_revision?: string
  user_goal: string
  analysis_gaps: string[]
  raw_plan: unknown
  acknowledgement: PendingRelayAcknowledgement
  timeline_draft_id: string
}

/** A caption translation is staged as the complete immutable candidate before
 * its Project projection or Relay ACK. Restart recovery can therefore finish
 * one paid request without regenerating Cue ids or re-submitting the model. */
type CaptionTranslationOperationInput = {
  document_id: string
  base_revision_id: string
  editorial_timeline_version_id: string
  language: string
  style_id?: string
}

type StagedRemoteCaptionTranslationResult = CaptionTranslationOperationInput & {
  revision: VideoCaptionDocumentRevision
  acknowledgement: PendingRelayAcknowledgement
}

/** Kept on the parent local Video Operation, rather than in a process-local
 * Promise. Once remote_submission_started_at is present, recovery may only
 * read the recorded Relay operation; it must never upload or submit again. */
type AsrPollCheckpoint = {
  source_id: string
  local_operation_id: string
  state: 'uploading' | 'submitting' | 'submitted' | 'running' | 'cancel_pending' | 'result_pending' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' | 'expired'
  object_ref?: string
  relay_operation_id?: string
  provider_task_id?: string
  remote_submission_started_at?: string
  next_poll_at?: string
  updated_at: string
}

type RemoteTranscriptResult = {
  evidence: VideoEvidence[]
  acknowledgements: PendingRelayAcknowledgement[]
}

type RemoteVisualEvidenceResult = {
  evidence: Array<{
    kind: 'visual'
    source_id: string
    in_ms: number
    out_ms: number
    text: string
    confidence: number
    warnings: string[]
    provider_receipt_id?: string
    relay_operation_id?: string
    relay_result_hashes?: string[]
    id?: string
  }>
  acknowledgements: PendingRelayAcknowledgement[]
}

type RemoteCapability = 'visual_evidence' | 'media_reasoning' | 'speech_transcription' | 'semantic_embedding'
type RemoteUsage = {
  requests: number
  total_tokens: number
  input_bytes: number
  visual_frames: number
  proxy_seconds: number
  asr_seconds: number
  estimated_amount_micros: number
}
/** A signed consent envelope is intentionally refreshed at transport time.
 * It is not part of the durable paid-operation fingerprint. */
type RelayOperationRequest = Omit<Parameters<VideoMediaRelayClient['createOperation']>[0], 'remote_consent_claim'>
type AuthorizedRelayOperationRequest = Parameters<VideoMediaRelayClient['createOperation']>[0]
type RelayOperationProjection = Awaited<ReturnType<VideoMediaRelayClient['createOperation']>>

/** The local task owns this submission journal before the Relay POST. It is
 * intentionally compact: recovery reconstructs the request from immutable
 * project facts, then verifies this full-request fingerprint and allocation
 * before any network call can leave the Sidecar. */
type RemoteOperationRecoveryCheckpoint = {
  state: 'submitting' | 'outcome_unknown'
  local_operation_id: string
  request_fingerprint: `sha256:${string}`
  request_hash: `sha256:${string}`
  budget_id: string
  capability: RemoteCapability
  usage: RemoteUsage
  updated_at: string
}

type StagedSemanticQueryResult = {
  generation: number
  query_hash: `sha256:${string}`
  query_vector: number[]
  acknowledgement: PendingRelayAcknowledgement
}

type PlanningCandidate = {
  id: string
  source_id: string
  source_fingerprint: `sha256:${string}`
  range: SourceTimeRange
  /** Evidence is optional for migrated projects. Its absence is a reason to
   * preserve chronology, never permission to infer a more exciting moment. */
  evidence_ids: string[]
  evidence_text: string
  evidence_kinds: string[]
  evidence_confidence: number
}

type RankedPlanningCandidate = PlanningCandidate & {
  selection_rank: number
  selection_score: number
  selection_reasons: string[]
  story_role: VideoScene['story_role']
}

type StoryStructure = Exclude<VideoCreationBrief['story_structure'], 'auto'>
type SelectionFocus = VideoCreationBrief['selection_focus']

function planningEvidenceText(fact: VideoFactEvidence): string {
  switch (fact.kind) {
    case 'transcript': return fact.payload.text
    case 'visual': return [fact.payload.summary, ...fact.payload.subjects, fact.payload.setting, fact.payload.camera_motion].filter(Boolean).join(' ')
    case 'ocr': return fact.payload.blocks.map(item => item.text).join(' ')
    case 'object': return fact.payload.label
    case 'action': return [fact.payload.label, fact.payload.phase].filter(Boolean).join(' ')
    case 'quality': return fact.payload.metric
    case 'beat_grid': return 'beat_grid'
    case 'subject_track': return 'subject_track'
  }
}

/** Extracts stable, explainable matching terms. Chinese does not have spaces,
 * so contiguous Han text becomes two-to-six character shingles; Latin/numeric
 * tokens use ordinary word fragments. These terms only rank existing facts. */
function planningTerms(text: string): string[] {
  const normalized = text.toLocaleLowerCase().replace(/\s+/g, '')
  const terms = new Set<string>()
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let width = 2; width <= Math.min(6, run.length); width += 1) {
      for (let offset = 0; offset + width <= run.length; offset += 1) terms.add(run.slice(offset, offset + width))
    }
  }
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) terms.add(word)
  return [...terms].sort((left, right) => right.length - left.length || left.localeCompare(right)).slice(0, 120)
}

function id(prefix: 'vid' | 'src' | 'clip' | 'task' | 'timeline' | 'draft' | 'evidence' | 'alternative' | 'consent' | 'budget' | 'feasibility' | 'duration_variant' | 'creation_brief' | 'delivery_intent' | 'range_decision' | 'chapter' | 'plan' | 'creative_session' | 'creative_message' | 'creative_response' | 'creative_proposal' | 'review_note' | 'review_resolution' | 'approval' | 'scene' | 'quick_batch' | 'quick_candidate' | 'planning_update' | 'av_group'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

/** Escape one FFmpeg filter option value. The shell is never involved, but
 * colons and quotes remain syntax inside the subtitles filter itself. */
function ffmpegFilterValue(value: string): string {
  return value.replace(/([\\':,;\[\]])/g, '\\$1')
}

const MICROSECOND_TICK_RATE = { num: 1_000_000, den: 1 }

/** Use a common integer time base before converting the exact Source PTS delta to FFmpeg seconds. */
function rationalSecondsBetween(start: RationalTime, end: RationalTime): number {
  const startUs = parseInt64(rescaleRationalTime(start, MICROSECOND_TICK_RATE, 'nearest').ticks)
  const endUs = parseInt64(rescaleRationalTime(end, MICROSECOND_TICK_RATE, 'nearest').ticks)
  const delta = endUs - startUs
  if (delta < 0n || delta > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('媒体时间戳超出可执行范围')
  return Number(delta) / MICROSECOND_TICK_RATE.num
}

/** Convert FFmpeg's analysis-relative seconds back into the immutable source
 * PTS range selected for this receipt.  Invalid/truncated log events are
 * ignored instead of inventing a semantic-cut range. */
function sourceRangeFromAnalysisSeconds(
  selected: SourceTimeRange,
  startSeconds: number,
  endSeconds: number,
): SourceTimeRange | null {
  const selectedDuration = rationalSecondsBetween(selected.start, endOfRange(selected))
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) return null
  const start = Math.max(0, Math.min(selectedDuration, startSeconds))
  const end = Math.max(start, Math.min(selectedDuration, endSeconds))
  if (end <= start) return null
  const toTicks = (seconds: number) => rescaleRationalTime(
    rationalTime(BigInt(Math.round(seconds * MICROSECOND_TICK_RATE.num)), MICROSECOND_TICK_RATE),
    selected.start.tick_rate,
    'nearest',
  )
  const offsetStart = toTicks(start)
  const offsetEnd = toTicks(end)
  const startTicks = parseInt64(selected.start.ticks) + parseInt64(offsetStart.ticks)
  const durationTicks = parseInt64(offsetEnd.ticks) - parseInt64(offsetStart.ticks)
  if (durationTicks <= 0n) return null
  return sourceTimeRange(
    rationalTime(startTicks, selected.start.tick_rate),
    rationalTime(durationTicks, selected.start.tick_rate),
  )
}

function silencedetectRanges(raw: string, selected: SourceTimeRange): SourceTimeRange[] {
  const events = [...raw.matchAll(/\bsilence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)/gi)]
  const selectedDuration = rationalSecondsBetween(selected.start, endOfRange(selected))
  const ranges: SourceTimeRange[] = []
  let start: number | undefined
  for (const event of events) {
    const seconds = Number(event[2])
    if (!Number.isFinite(seconds) || seconds < 0) continue
    if (event[1]!.toLowerCase() === 'start') {
      start = seconds
      continue
    }
    if (start === undefined) continue
    const range = sourceRangeFromAnalysisSeconds(selected, start, seconds)
    if (range) ranges.push(range)
    start = undefined
  }
  if (start !== undefined) {
    const range = sourceRangeFromAnalysisSeconds(selected, start, selectedDuration)
    if (range) ranges.push(range)
  }
  return ranges
}

function sourceRangeCoveredBy(coverage: readonly SourceTimeRange[], target: SourceTimeRange): boolean {
  const targetEnd = endOfRange(target)
  let cursor = target.start
  const ordered = [...coverage].sort((left, right) => compareRationalTime(left.start, right.start))
  for (const range of ordered) {
    const rangeEnd = endOfRange(range)
    if (compareRationalTime(rangeEnd, cursor) <= 0) continue
    if (compareRationalTime(range.start, cursor) > 0) return false
    cursor = rangeEnd
    if (compareRationalTime(cursor, targetEnd) >= 0) return true
  }
  return false
}

function planningSourcesForConsent(
  project: VideoStudioProject,
  consent: VideoStudioProject['remote_analysis_consents'][number],
): VideoSource[] {
  const sourceIds = new Set(consent.coverage.map(item => item.source_id))
  return project.sources.filter(source => sourceIds.has(source.id))
}

function planningEvidenceForConsent(
  project: VideoStudioProject,
  consent: VideoStudioProject['remote_analysis_consents'][number],
): VideoEvidence[] {
  const sourceById = new Map(project.sources.map(source => [source.id, source]))
  const coverageBySource = new Map<string, SourceTimeRange[]>()
  for (const coverage of consent.coverage) {
    const existing = coverageBySource.get(coverage.source_id) ?? []
    coverageBySource.set(coverage.source_id, [...existing, ...coverage.ranges.map(range => sourceTimeRange(range.start, range.duration))])
  }
  return project.evidence.filter(item => {
    const source = sourceById.get(item.source_id)
    if (!source || source.missing || source.content_changed || !source.fingerprint || item.source_fingerprint !== source.fingerprint) return false
    const dataKind = item.kind === 'transcript'
      ? 'transcript'
      : item.kind === 'visual' || item.kind === 'shot'
        ? 'keyframes'
        : null
    if (!dataKind || !consent.data_kinds.includes(dataKind)) return false
    const coverage = coverageBySource.get(item.source_id)
    if (!coverage) return false
    const range = sourceTimeRange(
      rationalTime(String(item.in_ms), { num: 1_000, den: 1 }),
      rationalTime(String(item.out_ms - item.in_ms), { num: 1_000, den: 1 }),
    )
    return sourceRangeCoveredBy(coverage, range)
  })
}

function planningSourceProjection(source: VideoSource) {
  if (source.missing || source.content_changed || !source.fingerprint || source.fps === undefined || source.duration_ms <= 0 || source.width <= 0 || source.height <= 0) {
    throw new VideoWorkbenchServiceError('远程规划素材事实不完整，拒绝提交模型请求', 409, 'VIDEO_ANALYSIS_STALE')
  }
  return {
    id: source.id,
    name: source.name,
    fingerprint: source.fingerprint,
    duration_ms: source.duration_ms,
    width: source.width,
    height: source.height,
    fps: source.fps,
    rotation: source.rotation,
    has_audio: source.has_audio,
  }
}

/** User constraints travel as non-citable context. They are kept in one
 * deterministic projection so first submission and restart recovery hash and
 * prompt the same logical request. */
function planningConstraintEvidence(project: VideoStudioProject): Array<{ id: string; kind: 'delivery_intent'; text: string }> {
  const constraints: Array<{ id: string; kind: 'delivery_intent'; text: string }> = []
  if (project.creation_brief) {
    const brief = project.creation_brief
    constraints.push({
      id: brief.id,
      kind: 'delivery_intent',
      text: JSON.stringify({
        schema: 'bb.video-creation-brief.v1',
        use_case: brief.use_case,
        user_request: brief.user_request,
        audience: brief.audience,
        distribution: brief.distribution,
        tone: brief.tone,
        pace: brief.pace,
        caption_preference: brief.caption_preference,
        hook_strategy: brief.hook_strategy,
        story_structure: brief.story_structure,
        selection_focus: brief.selection_focus,
        must_preserve: brief.must_preserve,
        creative_direction: brief.creative_direction,
        revision: brief.revision,
      }),
    })
  }
  if (project.delivery_intent) {
    const intent = project.delivery_intent
    constraints.push({
      id: intent.id,
      kind: 'delivery_intent',
      text: JSON.stringify({
        schema: 'bb.video-delivery-intent.v1',
        goal: intent.goal,
        duration_mode: intent.duration_mode,
        target_duration: intent.target_duration,
        target_min_duration: intent.target_min_duration,
        target_max_duration: intent.target_max_duration,
        exact_tolerance: intent.exact_tolerance,
        coverage_preference: intent.coverage_preference,
        editing_strategy: intent.editing_strategy,
        revision: intent.revision,
      }),
    })
  }
  return constraints
}

function planningRelayEvidence(
  project: VideoStudioProject,
  evidence: readonly VideoEvidence[],
): Array<{ id: string; kind: 'transcript' | 'visual_fact' | 'delivery_intent'; source_id?: string; in_ms?: number; out_ms?: number; text: string; confidence?: number }> {
  return [
    ...evidence.slice(0, 1_998).map(item => ({
      id: item.id,
      kind: item.kind === 'transcript' ? 'transcript' as const : 'visual_fact' as const,
      source_id: item.source_id,
      in_ms: item.in_ms,
      out_ms: item.out_ms,
      text: item.text,
      confidence: item.confidence,
    })),
    ...planningConstraintEvidence(project),
  ]
}

function beatSplitPoints(
  item: VideoTimelineItem,
  beatTimes: readonly RationalTime[],
  minimumCutIntervalMs: number,
): RationalTime[] {
  if (item.binding.kind !== 'source' || item.speed) return []
  const range = item.binding.source_range
  const end = endOfRange(range)
  const selected: RationalTime[] = []
  let previous = range.start
  for (const beat of beatTimes) {
    const at = rescaleRationalTime(beat, range.start.tick_rate, 'nearest')
    if (compareRationalTime(at, range.start) <= 0 || compareRationalTime(at, end) >= 0) continue
    if (rationalSecondsBetween(previous, at) * 1000 < minimumCutIntervalMs) continue
    if (rationalSecondsBetween(at, end) * 1000 < 500) continue
    selected.push(at)
    previous = at
  }
  return selected
}

function beatSyncAvLinkKey(item: VideoTimelineItem): string | null {
  if (item.binding.kind !== 'source') return null
  const range = item.timeline_range
  const start = range.start
  const duration = range.duration
  const speed = item.speed ? `${item.speed.num}/${item.speed.den}` : '1/1'
  return `${item.binding.source_id}:${item.binding.source_fingerprint}:${start.ticks}/${start.tick_rate.num}/${start.tick_rate.den}:${duration.ticks}/${duration.tick_rate.num}/${duration.tick_rate.den}:${speed}`
}

/** Map cuts chosen on the primary-video PTS into the paired audio stream's
 * PTS.  Each stream owns its start timestamp, while the elapsed media time
 * and resulting timeline boundaries remain identical. */
function pairedAudioBeatSplitPoints(
  video: VideoTimelineItem,
  audio: VideoTimelineItem,
  videoCutPoints: readonly RationalTime[],
): RationalTime[] {
  if (video.binding.kind !== 'source' || audio.binding.kind !== 'source' || video.speed || audio.speed) return []
  const audioRate = audio.binding.source_range.start.tick_rate
  const videoStart = rescaleRationalTime(video.binding.source_range.start, audioRate, 'nearest')
  const audioStart = audio.binding.source_range.start
  const audioEnd = endOfRange(audio.binding.source_range)
  return videoCutPoints.flatMap(cut => {
    const cutAtAudioRate = rescaleRationalTime(cut, audioRate, 'nearest')
    const offset = parseInt64(cutAtAudioRate.ticks) - parseInt64(videoStart.ticks)
    if (offset <= 0n) return []
    const translated = rationalTime(parseInt64(audioStart.ticks) + offset, audioRate)
    return compareRationalTime(translated, audioStart) > 0 && compareRationalTime(translated, audioEnd) < 0
      ? [translated]
      : []
  })
}

function splitItemOnBeats(
  item: VideoTimelineItem,
  cutPoints: readonly RationalTime[],
  linkedGroupIds: readonly string[] = [],
): VideoTimelineItem[] {
  if (item.binding.kind !== 'source' || item.speed || !cutPoints.length) return [structuredClone(item)]
  const sourceRange = item.binding.source_range
  const sourceEnd = endOfRange(sourceRange)
  const sourceBoundaries = [sourceRange.start, ...cutPoints, sourceEnd]
  const timelineRate = item.timeline_range.start.tick_rate
  const originalTimelineEnd = endOfRange(item.timeline_range)
  const sourceStartAtTimelineRate = rescaleRationalTime(sourceRange.start, timelineRate, 'nearest')
  const timelineBoundaries = sourceBoundaries.map((at, index) => {
    if (index === 0) return item.timeline_range.start
    if (index === sourceBoundaries.length - 1) return originalTimelineEnd
    const atTimelineRate = rescaleRationalTime(at, timelineRate, 'nearest')
    return rationalTime(
      parseInt64(item.timeline_range.start.ticks) + parseInt64(atTimelineRate.ticks) - parseInt64(sourceStartAtTimelineRate.ticks),
      timelineRate,
    )
  })
  return sourceBoundaries.slice(0, -1).flatMap((start, index) => {
    const finish = sourceBoundaries[index + 1]!
    const timelineStart = timelineBoundaries[index]!
    const timelineEnd = timelineBoundaries[index + 1]!
    const sourceDuration = parseInt64(finish.ticks) - parseInt64(start.ticks)
    const timelineDuration = parseInt64(timelineEnd.ticks) - parseInt64(timelineStart.ticks)
    if (sourceDuration <= 0n || timelineDuration <= 0n) return []
    return [{
      ...structuredClone(item),
      id: id('clip'),
      ...(linkedGroupIds[index] ? { linked_av_group_id: linkedGroupIds[index] } : {}),
      timeline_range: {
        start: timelineStart,
        duration: rationalTime(timelineDuration, timelineRate),
      },
      binding: {
        ...item.binding,
        source_range: sourceTimeRange(start, rationalTime(sourceDuration, start.tick_rate)),
      },
    }]
  })
}

function evidenceRevision(evidence: VideoEvidence[]): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(evidence.map(item => ({
    id: item.id,
    kind: item.kind,
    source_id: item.source_id,
    source_fingerprint: item.source_fingerprint,
    in_ms: item.in_ms,
    out_ms: item.out_ms,
    text: item.text,
  })))).digest('hex')}`
}

function scenesFromClips(clips: VideoClip[], evidence: VideoEvidence[]): VideoScene[] {
  return clips.map((clip, index) => ({
    id: clip.id,
    source_id: clip.source_id,
    in_ms: clip.in_ms,
    out_ms: clip.out_ms,
    story_role: index === 0 ? 'hook' as const : index === clips.length - 1 ? 'result' as const : 'action' as const,
    evidence_ids: evidence
      .filter(item => item.source_id === clip.source_id && item.in_ms < clip.out_ms && item.out_ms > clip.in_ms)
      .map(item => item.id),
    rationale: '按当前用户时间线保留真实素材范围',
    needs_review: true,
    locked: false,
  }))
}

function sameOwner(left: MediaOwner, right: MediaOwner): boolean {
  return left.kind === right.kind && left.owner_id === right.owner_id
}

export class VideoWorkbenchServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'VIDEO_WORKBENCH_ERROR',
  ) {
    super(message)
    this.name = 'VideoWorkbenchServiceError'
  }
}

/** Relay keeps raw transport codes so recovery can make correct payment
 * decisions. At the local product boundary, only the two daily hosted-video
 * quota codes become a user-visible capability limit; queue/lease pressure is
 * still retryable service availability. */
function videoHostedQuotaError(error: unknown): VideoWorkbenchServiceError | null {
  if (!(error instanceof VideoMediaRelayClientError) || error.status !== 429) return null
  if (!['owner_daily_quota_exceeded', 'account_daily_quota_exceeded'].includes(error.code)) return null
  return new VideoWorkbenchServiceError(
    '今日托管视频额度已用完，请在额度重置后重试。',
    429,
    'VIDEO_PLATFORM_QUOTA_EXHAUSTED',
  )
}

/**
 * Shared local runtime for the composed video applications. It owns one
 * repository and the process-local execution handles required to resume or
 * cancel durable operations. Product APIs are exposed by the composition root,
 * never by this implementation detail directly.
 */
export class VideoWorkbenchRuntime {
  readonly repository: VideoWorkbenchRepository
  readonly projectStore: VideoProjectStore
  private readonly now: () => Date
  private readonly runProcess: VideoProcessRunner
  private readonly fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly env: Record<string, string | undefined>
  private readonly platform: NodeJS.Platform
  private readonly legacyMediaRoot: string
  private readonly pcmDecoder?: LocalPcmDecoder
  private readonly editorial: EditorialApplication
  private readonly finishing: FinishingDeliveryApplication
  private readonly analysisState: VideoAnalysisOperationState
  private readonly finishingState: FinishingDeliveryOperationState
  /**
   * Encoding is intentionally serialized in this desktop runtime. Rendering
   * several timelines at once makes the machine unusable and, more
   * importantly, makes cancellation/recovery order ambiguous. The persisted
   * operation remains queued while it waits on this in-memory tail.
   */
  constructor(options: VideoWorkbenchRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.editorial = options.editorialRules ?? new EditorialApplication(this.now)
    this.finishing = options.finishingRules ?? new FinishingDeliveryApplication(this.now)
    this.projectStore = options.projectStore ?? new VideoProjectStore({ root: options.root, now: this.now })
    this.analysisState = options.analysisState ?? new VideoAnalysisOperationState()
    this.finishingState = options.finishingState ?? new FinishingDeliveryOperationState()
    this.repository = this.projectStore.repository
    this.runProcess = options.runProcess ?? defaultVideoProcessRunner
    this.fetchImpl = options.fetchImpl
    this.env = options.env
      ? {
          ...options.env,
          ...(options.env.BB_VIDEO_REMOTE_CONSENT_SIGNING_KEY === undefined && process.env.BB_VIDEO_REMOTE_CONSENT_SIGNING_KEY
            ? { BB_VIDEO_REMOTE_CONSENT_SIGNING_KEY: process.env.BB_VIDEO_REMOTE_CONSENT_SIGNING_KEY }
            : {}),
        }
      : process.env
    this.platform = options.platform ?? process.platform
    this.pcmDecoder = options.pcmDecoder
    this.legacyMediaRoot = options.legacyMediaRoot
      ?? join(this.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'media')
  }

  private get activePreviews(): Map<string, ActiveVideoExecution> {
    return this.finishingState.activePreviews
  }

  private get activeRenders(): Map<string, ActiveVideoExecution> {
    return this.finishingState.activeRenders
  }

  private get activeAnalyses(): Map<string, ActiveVideoExecution> {
    return this.analysisState.activeAnalyses
  }

  private get activeFingerprints(): Map<string, Promise<void>> {
    return this.analysisState.activeFingerprints
  }

  private get renderTail(): Promise<void> {
    return this.finishingState.renderTail
  }

  private set renderTail(value: Promise<void>) {
    this.finishingState.renderTail = value
  }

  private iso(): string {
    return this.now().toISOString()
  }

  /** Installation bearer stays in Sidecar memory; Renderer never constructs this client. */
  private videoMediaRelay(signal?: AbortSignal): VideoMediaRelayClient | null {
    const baseUrl = this.env.BB_VIDEO_MEDIA_RELAY_URL?.trim() ?? ''
    const accessToken = this.env.BB_GATEWAY_TOKEN?.trim() ?? ''
    return baseUrl && accessToken ? new VideoMediaRelayClient({
      baseUrl,
      accessToken,
      fetchImpl: this.fetchImpl,
      signal,
      now: this.now,
      remoteConsentSigningKey: this.env.BB_VIDEO_REMOTE_CONSENT_SIGNING_KEY,
      ...videoMediaRelayTransportPolicyFromEnvironment(this.env),
    }) : null
  }

  private consentScopeHash(consent: VideoStudioProject['remote_analysis_consents'][number]): `sha256:${string}` {
    return factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds })
  }

  private remoteConsentClaim(
    project: VideoStudioProject,
    consent: VideoStudioProject['remote_analysis_consents'][number],
    relay: VideoMediaRelayClient,
    purpose: 'visual_evidence' | 'planning' | 'caption_translation' | 'asr' | 'semantic_search',
  ): string {
    if (consent.project_id !== project.id || consent.state !== 'active' || consent.region !== 'cn-beijing' || !consent.purposes.includes(purpose)) {
      throw new VideoWorkbenchServiceError('远程授权当前不可用于该能力', 409, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
    }
    const sourceIds = [...new Set(consent.coverage.map(item => item.source_id))].sort()
    if (!sourceIds.length) throw new VideoWorkbenchServiceError('远程授权缺少素材范围', 409, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
    return relay.createRemoteConsentClaim({
      project_id: project.id,
      source_ids: sourceIds,
      purpose,
      consent_revision_id: consent.id,
      consent_scope_hash: this.consentScopeHash(consent),
      region: 'cn-beijing',
    })
  }

  private async authorizeRelayOperation(
    projectId: string,
    relay: VideoMediaRelayClient,
    request: RelayOperationRequest,
  ): Promise<AuthorizedRelayOperationRequest> {
    const project = await this.requireVideoProject(projectId)
    const purpose = request.application_role === 'shot_evidence'
      ? 'visual_evidence'
      : request.application_role === 'planning'
        ? 'planning'
        : request.application_role === 'caption_translation'
          ? 'caption_translation'
          : request.application_role === 'asr'
            ? 'asr'
            : 'semantic_search'
    const consent = project.remote_analysis_consents.find(item => item.id === request.consent_revision_id)
    if (!consent || this.consentScopeHash(consent) !== request.consent_scope_hash) {
      throw new VideoWorkbenchServiceError('远程请求不匹配已确认授权范围', 409, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
    }
    return { ...request, remote_consent_claim: this.remoteConsentClaim(project, consent, relay, purpose) } as AuthorizedRelayOperationRequest
  }

  private appendPendingRelayAcknowledgements(
    project: VideoStudioProject,
    acknowledgements: PendingRelayAcknowledgement[],
  ): PendingRelayAcknowledgement[] {
    const merged = [...project.pending_relay_acknowledgements]
    for (const acknowledgement of acknowledgements) {
      if (project.acknowledged_relay_operations.includes(acknowledgement.relay_operation_id) || project.retired_relay_operations.includes(acknowledgement.relay_operation_id)) continue
      const existing = merged.find(item => item.relay_operation_id === acknowledgement.relay_operation_id)
      if (existing) {
        if (existing.receipt_id !== acknowledgement.receipt_id || JSON.stringify(existing.result_hashes) !== JSON.stringify(acknowledgement.result_hashes)) {
          throw new VideoWorkbenchServiceError('远程结果 ACK 回执不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
        }
        continue
      }
      merged.push(acknowledgement)
    }
    return merged
  }

  /** Result facts and project projections are committed before this method is
   * invoked. An ACK failure deliberately leaves the durable entry untouched so
   * restart recovery performs only the idempotent ACK, never another model
   * request or result download. */
  private async flushPendingRelayAcknowledgements(projectId: string): Promise<void> {
    const relay = this.videoMediaRelay()
    if (!relay) return
    const project = await this.requireVideoProject(projectId)
    for (const acknowledgement of project.pending_relay_acknowledgements) {
      try {
        await relay.acknowledge(acknowledgement.relay_operation_id, {
          result_hashes: acknowledgement.result_hashes as Array<`sha256:${string}`>,
          receipt_id: acknowledgement.receipt_id,
        })
      } catch (error) {
        const retired = error instanceof VideoMediaRelayClientError && [404, 410].includes(error.status)
        if (!retired || !await this.hasDurableRelayResult(projectId, acknowledgement)) {
        // Preserve the outbox entry; result cleanup is retried at next Sidecar
        // start or later successful project work.
        continue
        }
        // A Relay 404/410 is a terminal statement about its temporary object,
        // not a reason to retry forever. This is allowed only after the same
        // receipt/hashes have been verified in a local Fact or staged Plan.
        await this.mutateProject(projectId, async () => {
          const latest = await this.requireVideoProject(projectId)
          if (!latest.pending_relay_acknowledgements.some(item => item.relay_operation_id === acknowledgement.relay_operation_id)) return
          await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            pending_relay_acknowledgements: latest.pending_relay_acknowledgements.filter(item => item.relay_operation_id !== acknowledgement.relay_operation_id),
            retired_relay_operations: [...new Set([...latest.retired_relay_operations, acknowledgement.relay_operation_id])],
          }))
        })
        continue
      }
      await this.mutateProject(projectId, async () => {
        const latest = await this.requireVideoProject(projectId)
        if (!latest.pending_relay_acknowledgements.some(item => item.relay_operation_id === acknowledgement.relay_operation_id)) return
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          pending_relay_acknowledgements: latest.pending_relay_acknowledgements.filter(item => item.relay_operation_id !== acknowledgement.relay_operation_id),
          acknowledged_relay_operations: [...new Set([...latest.acknowledged_relay_operations, acknowledgement.relay_operation_id])],
        }))
      })
    }
    // Document embeddings are not represented by a Fact payload. Their
    // separate SQLite outbox is committed in the same transaction as the
    // vectors, so a 5xx/crash here can retry only this ACK on startup or later
    // search work without re-running the embedding model.
    for (const acknowledgement of await this.repository.listPendingFactEmbeddingRelayAcknowledgements(projectId)) {
      try {
        await relay.acknowledge(acknowledgement.relay_operation_id, {
          result_hashes: acknowledgement.result_hashes,
          receipt_id: acknowledgement.receipt_id,
        })
      } catch (error) {
        const retired = error instanceof VideoMediaRelayClientError && [404, 410].includes(error.status)
        if (!retired || !await this.repository.hasFactEmbeddingRelayAcknowledgement(projectId, acknowledgement)) continue
        await this.repository.resolveFactEmbeddingRelayAcknowledgement(projectId, acknowledgement.relay_operation_id, 'retired')
        continue
      }
      await this.repository.resolveFactEmbeddingRelayAcknowledgement(projectId, acknowledgement.relay_operation_id, 'acknowledged')
    }
  }

  /** Only a local immutable Fact or a staged Plan payload may retire an ACK
   * after the Relay reports its temporary object gone. A forged/stale pending
   * entry therefore remains retryable instead of suppressing cleanup. */
  private async hasDurableRelayResult(projectId: string, acknowledgement: PendingRelayAcknowledgement): Promise<boolean> {
    const same = (receiptId: string | undefined, relayId: string | undefined, hashes: string[] | undefined): boolean => (
      receiptId === acknowledgement.receipt_id
      && relayId === acknowledgement.relay_operation_id
      && JSON.stringify(hashes) === JSON.stringify(acknowledgement.result_hashes)
    )
    const transcripts = await this.repository.listFacts('transcript', projectId)
    if (transcripts.some(fact => 'segments' in fact && same(fact.model_receipt_id, fact.relay_operation_id, fact.relay_result_hashes))) return true
    const evidence = await this.repository.listFacts('evidence', projectId)
    if (evidence.some(fact => 'payload' in fact && same(fact.provider_receipt_id, fact.relay_operation_id, fact.relay_result_hashes))) return true
    const operations = await this.repository.listOperations(projectId)
    if (operations.some(operation => {
      const staged = this.stagedRemotePlanningResult(operation)
      const semantic = this.stagedSemanticQueryResult(operation)
      const captionTranslation = this.stagedCaptionTranslationResult(operation)
      return Boolean(
        (staged && same(staged.acknowledgement.receipt_id, staged.acknowledgement.relay_operation_id, staged.acknowledgement.result_hashes))
        || (semantic && same(semantic.acknowledgement.receipt_id, semantic.acknowledgement.relay_operation_id, semantic.acknowledgement.result_hashes))
        || (captionTranslation && same(captionTranslation.acknowledgement.receipt_id, captionTranslation.acknowledgement.relay_operation_id, captionTranslation.acknowledgement.result_hashes)),
      )
    })) return true
    return await this.repository.hasFactEmbeddingRelayAcknowledgement(projectId, {
      relay_operation_id: acknowledgement.relay_operation_id,
      receipt_id: acknowledgement.receipt_id,
      result_hashes: acknowledgement.result_hashes as `sha256:${string}`[],
    })
  }

  /** The Fact payload is the durable local copy of a remote result. If a
   * crash happens after Fact publication but before the Project ACK outbox
   * write, rebuild only that outbox from the immutable Fact metadata. No
   * provider call, result download, upload or task re-submission is involved.
   * This is the recovery half of the Fact -> Project durable commit protocol. */
  private async rebuildRelayAcknowledgementsFromFacts(projectId: string): Promise<void> {
    const project = await this.requireVideoProject(projectId)
    const acknowledgements: PendingRelayAcknowledgement[] = []
    const transcripts = await this.repository.listFacts('transcript', projectId)
    for (const fact of transcripts) {
      if (!('segments' in fact) || !fact.relay_operation_id || !fact.relay_result_hashes) continue
      acknowledgements.push(this.acknowledgementFor(fact.id, fact.relay_operation_id, fact.model_receipt_id, fact.relay_result_hashes))
    }
    const evidence = await this.repository.listFacts('evidence', projectId)
    for (const fact of evidence) {
      if (!('payload' in fact) || !fact.relay_operation_id || !fact.relay_result_hashes || !fact.provider_receipt_id) continue
      acknowledgements.push(this.acknowledgementFor(fact.id, fact.relay_operation_id, fact.provider_receipt_id, fact.relay_result_hashes))
    }
    if (!acknowledgements.length) return
    await this.mutateProject(projectId, async () => {
      const latest = await this.requireVideoProject(projectId)
      const pending = this.appendPendingRelayAcknowledgements(latest, acknowledgements)
      if (pending.length === latest.pending_relay_acknowledgements.length) return
      await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...latest,
        pending_relay_acknowledgements: pending,
        revision: latest.revision + 1,
      }))
    })
  }

  private acknowledgementFor(
    operationId: string,
    relayOperationId: string,
    receiptId: string,
    resultHashes: string[],
  ): PendingRelayAcknowledgement {
    return { operation_id: operationId, relay_operation_id: relayOperationId, receipt_id: receiptId, result_hashes: resultHashes, created_at: this.iso() }
  }

  private stagedRemotePlanningResult(operation: VideoOperation): StagedRemotePlanningResult | null {
    const result = operation.result
    if (!result || typeof result !== 'object') return null
    const value = result as Record<string, unknown>
    const acknowledgement = value.relay_acknowledgement
    if (
      !Number.isSafeInteger(value.base_revision)
      || typeof value.user_goal !== 'string'
      || !value.user_goal.trim()
      || !Array.isArray(value.analysis_gaps)
      || !value.analysis_gaps.every(item => typeof item === 'string')
      || !Object.hasOwn(value, 'raw_plan')
      || typeof value.timeline_draft_id !== 'string'
      || !acknowledgement
      || typeof acknowledgement !== 'object'
    ) return null
    const ack = acknowledgement as Record<string, unknown>
    if (
      typeof ack.operation_id !== 'string'
      || typeof ack.relay_operation_id !== 'string'
      || typeof ack.receipt_id !== 'string'
      || !Array.isArray(ack.result_hashes)
      || !ack.result_hashes.every(item => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/.test(item))
      || typeof ack.created_at !== 'string'
    ) return null
    return {
      base_revision: value.base_revision as number,
      ...(typeof value.base_timeline_version_id === 'string' ? { base_timeline_version_id: value.base_timeline_version_id } : {}),
      ...(typeof value.evidence_revision === 'string' ? { evidence_revision: value.evidence_revision } : {}),
      user_goal: value.user_goal,
      analysis_gaps: value.analysis_gaps,
      raw_plan: value.raw_plan,
      acknowledgement: ack as PendingRelayAcknowledgement,
      timeline_draft_id: value.timeline_draft_id,
    }
  }

  private captionTranslationInput(operation: VideoOperation): CaptionTranslationOperationInput | null {
    const value = operation.result?.caption_translation
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const parsed = createVideoCaptionTranslationInputSchema.safeParse(record)
    if (!parsed.success || typeof record.document_id !== 'string') return null
    return { document_id: record.document_id, ...parsed.data }
  }

  private stagedCaptionTranslationResult(operation: VideoOperation): StagedRemoteCaptionTranslationResult | null {
    const input = this.captionTranslationInput(operation)
    const result = operation.result
    if (!input || !result || typeof result !== 'object') return null
    const revision = videoCaptionDocumentRevisionSchema.safeParse(result.caption_translation_revision)
    const acknowledgement = result.relay_acknowledgement
    if (!revision.success || !acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) return null
    const ack = acknowledgement as Record<string, unknown>
    if (
      typeof ack.operation_id !== 'string'
      || typeof ack.relay_operation_id !== 'string'
      || typeof ack.receipt_id !== 'string'
      || !Array.isArray(ack.result_hashes)
      || !ack.result_hashes.every(item => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/.test(item))
      || typeof ack.created_at !== 'string'
      || ack.operation_id !== operation.id
      || revision.data.document_id !== input.document_id
      || revision.data.parent_revision_id !== input.base_revision_id
      || revision.data.editorial_timeline_version_id !== input.editorial_timeline_version_id
      || revision.data.language !== input.language
      || (input.style_id !== undefined && revision.data.style_id !== input.style_id)
    ) return null
    return { ...input, revision: revision.data, acknowledgement: ack as PendingRelayAcknowledgement }
  }

  /** A staged Remote result is not trusted merely because it parses. This
   * rechecks the immutable parent mapping before a crash-recovery projection
   * can make the candidate visible on a Project. */
  private assertCaptionTranslationCandidate(
    project: VideoStudioProject,
    parent: VideoCaptionDocumentRevision,
    staged: StagedRemoteCaptionTranslationResult,
  ): void {
    const revision = staged.revision
    if (
      revision.project_id !== project.id
      || revision.document_id !== staged.document_id
      || revision.parent_revision_id !== parent.id
      || revision.editorial_timeline_version_id !== staged.editorial_timeline_version_id
      || revision.transcript_id !== parent.transcript_id
      || revision.transcript_revision_id !== parent.transcript_revision_id
      || revision.style_id !== (staged.style_id ?? parent.style_id)
      || revision.cues.length !== parent.cues.length
    ) throw new VideoWorkbenchServiceError('字幕翻译候选与不可变父修订不一致', 502, 'VIDEO_FINISHING_INVALID')
    const parentByCueId = new Map(parent.cues.map(cue => [cue.id, cue]))
    const translatedParentIds = new Set<string>()
    for (const cue of revision.cues) {
      const parentCue = cue.translation_of_cue_id ? parentByCueId.get(cue.translation_of_cue_id) : undefined
      if (
        !parentCue
        || translatedParentIds.has(parentCue.id)
        || JSON.stringify(cue.source_anchor) !== JSON.stringify(parentCue.source_anchor)
        || JSON.stringify(cue.timeline_range) !== JSON.stringify(parentCue.timeline_range)
      ) throw new VideoWorkbenchServiceError('字幕翻译候选包含错版或被拉伸的 Cue', 502, 'VIDEO_FINISHING_INVALID')
      translatedParentIds.add(parentCue.id)
    }
    if (translatedParentIds.size !== parent.cues.length) {
      throw new VideoWorkbenchServiceError('字幕翻译候选未覆盖完整父修订', 502, 'VIDEO_FINISHING_INVALID')
    }
  }

  /** Persist the fully validated candidate before exposing it on the Project.
   * The parent Operation remains the only recovery authority for the paid
   * Relay submission until this checkpoint is durably present. */
  private async stageCaptionTranslationResult(
    operationId: string,
    revision: VideoCaptionDocumentRevision,
    acknowledgement: PendingRelayAcknowledgement,
  ): Promise<VideoOperation> {
    const operation = await this.repository.getOperation(operationId)
    return await this.mutateProject(operation.project_id, async () => {
      const current = await this.repository.getOperation(operationId)
      const input = this.captionTranslationInput(current)
      if (!input) throw new VideoWorkbenchServiceError('字幕翻译恢复记录缺少原始输入', 502, 'VIDEO_FINISHING_INVALID')
      const existing = this.stagedCaptionTranslationResult(current)
      if (existing) {
        if (
          existing.revision.id !== revision.id
          || existing.revision.basis_hash !== revision.basis_hash
          || existing.acknowledgement.relay_operation_id !== acknowledgement.relay_operation_id
          || existing.acknowledgement.receipt_id !== acknowledgement.receipt_id
          || JSON.stringify(existing.acknowledgement.result_hashes) !== JSON.stringify(acknowledgement.result_hashes)
        ) throw new VideoWorkbenchServiceError('字幕翻译恢复记录与远程结果不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
        return current
      }
      if (
        revision.document_id !== input.document_id
        || revision.parent_revision_id !== input.base_revision_id
        || revision.editorial_timeline_version_id !== input.editorial_timeline_version_id
        || revision.language !== input.language
        || (input.style_id !== undefined && revision.style_id !== input.style_id)
      ) throw new VideoWorkbenchServiceError('字幕翻译候选版本与原始请求不一致', 502, 'VIDEO_FINISHING_INVALID')
      const { remote_recovery: _remoteRecovery, ...result } = current.result ?? {}
      return await this.repository.saveOperation(this.operation({
        ...current,
        status: 'committing',
        progress: 85,
        stage: '字幕翻译结果已持久化，正在生成候选版本',
        outcome_unknown: false,
        result: {
          ...result,
          caption_translation_revision: revision,
          relay_acknowledgement: acknowledgement,
        },
      }))
    })
  }

  /** Project projection is deliberately separate from the staging write. A
   * crash after the paid response can only finalize this exact candidate and
   * ACK, never ask the provider to translate again. */
  private async finalizeStagedCaptionTranslationResult(
    operation: VideoOperation,
  ): Promise<{ project: VideoStudioProject; revision: VideoCaptionDocumentRevision; task: VideoOperation }> {
    const staged = this.stagedCaptionTranslationResult(operation)
    if (!staged) throw new VideoWorkbenchServiceError('字幕翻译恢复记录无效', 502, 'VIDEO_FINISHING_INVALID')
    let completed: { project: VideoStudioProject; revision: VideoCaptionDocumentRevision; task: VideoOperation } | undefined
    await this.mutateProject(operation.project_id, async () => {
      const latest = await this.requireVideoProject(operation.project_id)
      const current = await this.repository.getOperation(operation.id)
      const currentStaged = this.stagedCaptionTranslationResult(current)
      if (!currentStaged || currentStaged.revision.id !== staged.revision.id || currentStaged.revision.basis_hash !== staged.revision.basis_hash) {
        throw new VideoWorkbenchServiceError('字幕翻译恢复记录已变化', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      }
      const document = latest.caption_documents.find(candidate => candidate.id === staged.document_id)
      const parent = latest.caption_document_revisions.find(candidate => candidate.id === staged.base_revision_id)
      const timeline = latest.editorial_timeline_versions.find(candidate => candidate.id === staged.editorial_timeline_version_id)
      if (
        !document
        || !parent
        || !timeline
        || document.project_id !== latest.id
        || parent.project_id !== latest.id
        || parent.document_id !== document.id
        || document.current_revision_id !== parent.id
        || latest.current_editorial_timeline_version_id !== timeline.id
      ) throw new VideoWorkbenchServiceError('字幕翻译基础版本已变化，已拒绝写入候选', 409, 'VIDEO_FINISHING_STALE')
      this.assertCaptionTranslationCandidate(latest, parent, currentStaged)
      const existing = latest.caption_document_revisions.find(candidate => candidate.id === staged.revision.id)
      if (existing && (
        existing.project_id !== latest.id
        || existing.document_id !== document.id
        || existing.parent_revision_id !== parent.id
        || existing.basis_hash !== staged.revision.basis_hash
        || JSON.stringify(existing.cues) !== JSON.stringify(staged.revision.cues)
      )) throw new VideoWorkbenchServiceError('字幕翻译候选 ID 已被其他版本占用', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      const requestHash = typeof current.result?.request_hash === 'string' ? current.result.request_hash as `sha256:${string}` : null
      if (!requestHash) throw new VideoWorkbenchServiceError('字幕翻译恢复记录缺少请求摘要', 502, 'VIDEO_FINISHING_INVALID')
      if (!current.idempotency_key) throw new VideoWorkbenchServiceError('字幕翻译恢复记录缺少幂等键', 502, 'VIDEO_FINISHING_INVALID')
      const receipt = latest.finishing_receipts.find(candidate => candidate.kind === 'caption_translation' && candidate.idempotency_key === current.idempotency_key)
      if (receipt && (receipt.request_hash !== requestHash || receipt.resource_ids.length !== 1 || receipt.resource_ids[0] !== staged.revision.id)) {
        throw new VideoWorkbenchServiceError('字幕翻译幂等记录与候选版本不一致', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
      }
      const pending = this.appendPendingRelayAcknowledgements(latest, [staged.acknowledgement])
      const changed = !existing || !receipt || pending.length !== latest.pending_relay_acknowledgements.length
      const project = changed
        ? await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            caption_document_revisions: existing ? latest.caption_document_revisions : [...latest.caption_document_revisions, staged.revision],
            finishing_receipts: receipt
              ? latest.finishing_receipts
              : [...latest.finishing_receipts, this.finishingReceipt('caption_translation', current.idempotency_key, requestHash, [staged.revision.id])],
            pending_relay_acknowledgements: pending,
            revision: latest.revision + 1,
            updated_at: this.iso(),
          }))
        : latest
      const task = current.status === 'succeeded'
        ? current
        : await this.completeFinishingOperation(current, '字幕翻译候选已生成，等待应用', {
            caption_document_id: document.id,
            caption_revision_id: staged.revision.id,
            caption_style_id: staged.revision.style_id,
          })
      completed = { project, revision: existing ?? staged.revision, task }
    })
    await this.flushPendingRelayAcknowledgements(operation.project_id)
    if (!completed) throw new VideoWorkbenchServiceError('字幕翻译候选未完成持久化', 502, 'VIDEO_FINISHING_INVALID')
    return completed
  }

  private stagedSemanticQueryResult(operation: VideoOperation): StagedSemanticQueryResult | null {
    const result = operation.result
    if (!result || typeof result !== 'object') return null
    const acknowledgement = result.relay_acknowledgement
    if (
      !Number.isSafeInteger(result.search_generation)
      || typeof result.query_hash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(result.query_hash)
      || !Array.isArray(result.query_vector)
      || result.query_vector.length !== 768
      || !result.query_vector.every(value => typeof value === 'number' && Number.isFinite(value))
      || !acknowledgement
      || typeof acknowledgement !== 'object'
    ) return null
    const ack = acknowledgement as Record<string, unknown>
    if (
      typeof ack.operation_id !== 'string'
      || typeof ack.relay_operation_id !== 'string'
      || typeof ack.receipt_id !== 'string'
      || !Array.isArray(ack.result_hashes)
      || !ack.result_hashes.every(item => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/.test(item))
      || typeof ack.created_at !== 'string'
    ) return null
    return {
      generation: result.search_generation as number,
      query_hash: result.query_hash as `sha256:${string}`,
      query_vector: result.query_vector as number[],
      acknowledgement: ack as PendingRelayAcknowledgement,
    }
  }

  /** The vector is durable before Relay ACK. Replacing remote_recovery and
   * staging the vector happen in one Operation save, so a crash can either
   * replay the exact paid request or reuse the local vector, never neither. */
  private async stageSemanticQueryResult(
    operationId: string,
    generation: number,
    queryHash: `sha256:${string}`,
    queryVector: number[],
    acknowledgement: PendingRelayAcknowledgement,
  ): Promise<VideoOperation> {
    const operation = await this.repository.getOperation(operationId)
    const existing = this.stagedSemanticQueryResult(operation)
    if (existing) {
      if (existing.generation !== generation || existing.query_hash !== queryHash) {
        throw new VideoWorkbenchServiceError('语义查询恢复记录与当前索引不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      }
      return operation
    }
    const { remote_recovery: _remoteRecovery, ...result } = operation.result ?? {}
    return await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'committing',
      progress: 90,
      stage: '查询向量已持久化，正在确认远程结果',
      outcome_unknown: false,
      result: {
        ...result,
        search_generation: generation,
        query_hash: queryHash,
        query_vector: queryVector,
        relay_acknowledgement: acknowledgement,
      },
    }))
  }

  private async finalizeStagedSemanticQueryResult(operation: VideoOperation): Promise<number[]> {
    const staged = this.stagedSemanticQueryResult(operation)
    if (!staged) throw new VideoWorkbenchServiceError('语义查询恢复记录无效', 502, 'VIDEO_ANALYSIS_INVALID')
    await this.mutateProject(operation.project_id, async () => {
      const latest = await this.requireVideoProject(operation.project_id)
      const current = await this.repository.getOperation(operation.id)
      const currentStaged = this.stagedSemanticQueryResult(current)
      if (!currentStaged || currentStaged.query_hash !== staged.query_hash || currentStaged.generation !== staged.generation) {
        throw new VideoWorkbenchServiceError('语义查询恢复记录已变化', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      }
      const pending = this.appendPendingRelayAcknowledgements(latest, [currentStaged.acknowledgement])
      if (pending.length !== latest.pending_relay_acknowledgements.length) {
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          pending_relay_acknowledgements: pending,
        }))
      }
      if (current.status !== 'succeeded') {
        await this.repository.saveOperation(this.operation({
          ...current,
          status: 'succeeded',
          progress: 100,
          stage: '查询向量已就绪',
          outcome_unknown: false,
          error: undefined,
          error_code: undefined,
        }))
      }
    })
    await this.flushPendingRelayAcknowledgements(operation.project_id)
    return staged.query_vector
  }

  private async stageRemotePlanningResult(
    task: VideoOperation,
    input: { userGoal: string; analysisGaps: string[] },
    rawPlan: unknown,
    acknowledgement: PendingRelayAcknowledgement,
  ): Promise<VideoOperation> {
    const draftId = id('draft')
    return await this.mutateProject(task.project_id, async () => {
      const current = await this.repository.getOperation(task.id)
      const existing = this.stagedRemotePlanningResult(current)
      if (existing) return current
      const { remote_recovery: _remoteRecovery, ...result } = current.result ?? {}
      return await this.repository.saveOperation(this.operation({
        ...current,
        status: 'committing',
        progress: 85,
        stage: '已持久化远程规划，正在生成草稿',
        outcome_unknown: false,
        result: {
          ...result,
          user_goal: input.userGoal,
          analysis_gaps: input.analysisGaps,
          raw_plan: rawPlan,
          relay_acknowledgement: acknowledgement,
          timeline_draft_id: draftId,
          planning_origin: 'provider',
          workflow: planningWorkflow({
            phase: 'drafting_candidates',
            completed_units: 3,
            total_units: 4,
            next_action: 'wait_for_analysis',
            interpreted_goal: input.userGoal,
            clarifications: input.analysisGaps,
          }),
        },
      }))
    })
  }

  /** Finish a locally staged Relay planning result. This never contacts the
   * Relay: after a crash, it validates the persisted result against the
   * current immutable facts, writes the Project projection plus ACK outbox,
   * then lets the normal outbox flusher perform cleanup. */
  private async finalizeStagedRemotePlanningResult(operation: VideoOperation): Promise<void> {
    const staged = this.stagedRemotePlanningResult(operation)
    if (!staged) throw new VideoWorkbenchServiceError('远程规划恢复记录无效', 502, 'VIDEO_ANALYSIS_INVALID')
    await this.mutateProject(operation.project_id, async () => {
      const latest = await this.requireVideoProject(operation.project_id)
      const currentScenes = latest.timeline_versions.find(version => version.id === latest.current_timeline_version_id)?.scenes ?? []
      const hasDraft = latest.timeline_drafts.some(draft => draft.id === staged.timeline_draft_id)
      const matchesBasis = (
        latest.revision === staged.base_revision
        && latest.evidence_revision === staged.evidence_revision
        && latest.current_timeline_version_id === staged.base_timeline_version_id
      )
      if (hasDraft) {
        const hasAcknowledgement = latest.pending_relay_acknowledgements.some(item => item.relay_operation_id === staged.acknowledgement.relay_operation_id)
        const project = !hasAcknowledgement && latest.task_id === undefined
          ? latest
          : await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            pending_relay_acknowledgements: this.appendPendingRelayAcknowledgements(latest, [staged.acknowledgement]),
            task_id: undefined,
            revision: latest.revision + 1,
          }))
        await this.repository.saveOperation(this.operation({
          ...operation,
          status: 'succeeded',
          progress: 100,
          stage: '剪辑草稿已生成，等待用户接受',
          result: {
            ...operation.result,
            timeline_draft_id: staged.timeline_draft_id,
            project_revision: project.revision,
            alternative_count: 0,
            planning_origin: 'provider',
            workflow: planningWorkflow({
              phase: 'awaiting_confirmation',
              completed_units: 4,
              total_units: 4,
              next_action: 'review_suggestions',
              interpreted_goal: staged.user_goal,
              clarifications: staged.analysis_gaps,
            }),
          },
          error: undefined,
          error_code: undefined,
        }))
        return
      }
      if (!matchesBasis) {
        const project = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          pending_relay_acknowledgements: this.appendPendingRelayAcknowledgements(latest, [staged.acknowledgement]),
          revision: latest.revision + 1,
        }))
        const failure = mediaSafeError('MEDIA_STATE_CONFLICT')
        await this.repository.saveOperation(this.operation({
          ...operation,
          status: 'failed',
          progress: 0,
          stage: '方案已过期',
          result: { ...operation.result, project_revision: project.revision },
          error: failure.message,
          error_code: failure.code,
        }))
        return
      }
      const input = {
        sources: latest.sources,
        evidence: latest.evidence,
        currentScenes,
        userGoal: staged.user_goal,
        analysisGaps: staged.analysis_gaps,
        ...(latest.creation_brief ? { creationBrief: latest.creation_brief } : {}),
        ...(latest.delivery_intent ? { deliveryIntent: latest.delivery_intent } : {}),
      }
      const plan = planVideoTimelineFromRelay(input, staged.raw_plan)
      const proposed = this.materializeVideoScenes(latest, plan.scenes, latest.evidence)
      const scenes = this.preserveLockedVideoScenes(currentScenes, proposed)
      const editorialProject = await this.ensureEditorialState(latest)
      const timelineDraft = this.editorial.createDraft(
        editorialProject,
        scenes,
        await this.editorialTimings(editorialProject),
        [],
        await this.editorialSourceBounds(editorialProject),
        staged.timeline_draft_id,
        'provider',
      )
      const completed = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...editorialProject,
        brief: compileVideoBrief(staged.user_goal, { ...plan.brief, gaps: [...new Set([...plan.brief.gaps, ...staged.analysis_gaps])].slice(0, 20) }),
        timeline_drafts: [...editorialProject.timeline_drafts, timelineDraft],
        alternatives: [],
        pending_relay_acknowledgements: this.appendPendingRelayAcknowledgements(editorialProject, [staged.acknowledgement]),
        state: 'ready',
        task_id: undefined,
        revision: editorialProject.revision + 1,
      }))
      await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'succeeded',
        progress: 100,
        stage: '剪辑草稿已生成，等待用户接受',
        result: {
          ...operation.result,
          timeline_draft_id: timelineDraft.id,
          project_revision: completed.revision,
          alternative_count: 0,
          planning_origin: 'provider',
          workflow: planningWorkflow({
            phase: 'awaiting_confirmation',
            completed_units: 4,
            total_units: 4,
            next_action: 'review_suggestions',
            interpreted_goal: staged.user_goal,
            clarifications: [...staged.analysis_gaps, ...plan.brief.gaps],
          }),
        },
        error: undefined,
        error_code: undefined,
      }))
    })
    await this.flushPendingRelayAcknowledgements(operation.project_id)
  }

  /** Resume only the already-fenced planning command. The immutable project
   * basis reconstructs its body; fenceRemoteOperation compares that body with
   * the journal written before the first POST, so recovery cannot drift to a
   * different goal, facts revision, budget or allocation. */
  private async recoverRemotePlanningOperation(operation: VideoOperation): Promise<void> {
    const result = operation.result ?? {}
    const userGoal = typeof result.user_goal === 'string' ? result.user_goal : ''
    const analysisGaps = Array.isArray(result.analysis_gaps) && result.analysis_gaps.every(item => typeof item === 'string')
      ? result.analysis_gaps as string[]
      : null
    const baseRevision = Number.isSafeInteger(result.base_revision) ? result.base_revision as number : null
    const baseTimelineVersionId = typeof result.base_timeline_version_id === 'string' ? result.base_timeline_version_id : undefined
    const evidenceRevisionValue = typeof result.evidence_revision === 'string' ? result.evidence_revision : undefined
    if (!userGoal.trim() || !analysisGaps || baseRevision === null) {
      throw new VideoWorkbenchServiceError('远程规划恢复记录缺少原始输入', 502, 'VIDEO_ANALYSIS_INVALID')
    }
    const project = await this.requireVideoProject(operation.project_id)
    if (
      project.revision !== baseRevision
      || project.current_timeline_version_id !== baseTimelineVersionId
      || project.evidence_revision !== evidenceRevisionValue
    ) {
      throw new VideoWorkbenchServiceError('远程规划恢复基础已变化', 409, 'VIDEO_ANALYSIS_STALE')
    }
    const consent = project.remote_analysis_consents.find(item => item.state === 'active' && item.purposes.includes('planning'))
    const budget = consent && project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
    const relay = this.videoMediaRelay()
    if (!consent || !budget || !relay) {
      throw new VideoWorkbenchServiceError('远程规划恢复所需授权或服务不可用', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
    }
    const scopedSources = planningSourcesForConsent(project, consent)
    const scopedSourceIds = new Set(scopedSources.map(source => source.id))
    const currentScenes = (project.timeline_versions.find(version => version.id === project.current_timeline_version_id)?.scenes ?? [])
      .filter(scene => scopedSourceIds.has(scene.source_id))
    const scopedEvidence = planningEvidenceForConsent(project, consent)
    const relayInput = {
      object_refs: [],
      sources: scopedSources.map(planningSourceProjection),
      facts_basis_hash: project.evidence_revision ?? factBasisHash({ evidence: scopedEvidence }),
      evidence: planningRelayEvidence(project, scopedEvidence),
      user_goal: userGoal,
      analysis_gaps: analysisGaps,
      language: 'zh',
      output_schema_version: 1,
    }
    const requestHash = factBasisHash({ capability: 'media_reasoning', application_role: 'planning', model: VIDEO_REMOTE_MODEL_BINDINGS.mediaReasoning, input: relayInput })
    const serializedRelayInput = JSON.stringify(relayInput)
    const planningInputTokens = estimatedTextTokens(serializedRelayInput) + VIDEO_REMOTE_USAGE_POLICY.planningContextTokenReserve
    const usage = {
      requests: 1,
      total_tokens: planningInputTokens + VIDEO_REMOTE_USAGE_POLICY.planningOutputTokenReserve,
      input_bytes: Buffer.byteLength(serializedRelayInput, 'utf8'),
      visual_frames: 0,
      proxy_seconds: 0,
      asr_seconds: 0,
      estimated_amount_micros: estimatedTextAmountMicros(planningInputTokens + VIDEO_REMOTE_USAGE_POLICY.planningOutputTokenReserve),
    }
    const request: RelayOperationRequest = {
      local_operation_id: operation.id,
      consent_revision_id: consent.id,
      consent_scope_hash: factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds }),
      local_budget_reservation_id: budget.id,
      request_hash: requestHash,
      capability: 'media_reasoning',
      application_role: 'planning',
      input: relayInput,
    }
    let stagedOperation: VideoOperation | undefined
    await this.reserveAndRunRemote(project.id, budget.id, 'media_reasoning', usage, relay, request, async (activeRelay, remote) => {
      if (remote.state !== 'succeeded' || !remote.provider_receipt) throw new VideoMediaRelayClientError(remote.state === 'outcome_unknown' ? 503 : 422, 'relay_operation_not_succeeded')
      await this.settleRemoteBudget(project.id, budget.id, operation.id, remote.provider_receipt)
      const downloaded = await activeRelay.downloadResult<{ kind: string; plan: unknown }>(remote)
      if (downloaded.result.kind !== 'planning') throw new VideoWorkbenchServiceError('远程规划结果类型无效', 502, 'VIDEO_ANALYSIS_INVALID')
      stagedOperation = await this.stageRemotePlanningResult(
        operation,
        { userGoal, analysisGaps },
        downloaded.result.plan,
        this.acknowledgementFor(operation.id, remote.id, remote.provider_receipt.id, downloaded.hashes),
      )
    }, { parentOperationId: operation.id })
    const staged = stagedOperation ?? await this.repository.getOperation(operation.id)
    if (!this.stagedRemotePlanningResult(staged)) throw new VideoWorkbenchServiceError('远程规划恢复未产生结果', 502, 'VIDEO_ANALYSIS_INVALID')
    await this.finalizeStagedRemotePlanningResult(staged)
  }

  /** Recover only the fenced caption request recorded on the local Operation.
   * The document head and Editorial Version are rechecked before the staged
   * candidate can become visible, so a late provider answer never attaches to
   * a newer caption edit. */
  private async recoverCaptionTranslationOperation(operation: VideoOperation): Promise<void> {
    const input = this.captionTranslationInput(operation)
    if (!input) throw new VideoWorkbenchServiceError('字幕翻译恢复记录缺少原始输入', 502, 'VIDEO_FINISHING_INVALID')
    const { document_id: documentId, ...rawInput } = input
    const expectedRequestHash = factBasisHash({
      kind: 'caption_translation',
      model: VIDEO_REMOTE_MODEL_BINDINGS.mediaReasoning,
      prompt_version: 'caption-translation-v1',
      document_id: documentId,
      input: rawInput,
    })
    if (operation.result?.request_hash !== expectedRequestHash) {
      throw new VideoWorkbenchServiceError('字幕翻译恢复记录与原始请求不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
    }
    const project = await this.requireVideoProject(operation.project_id)
    const document = project.caption_documents.find(candidate => candidate.id === input.document_id)
    const parent = project.caption_document_revisions.find(candidate => candidate.id === input.base_revision_id)
    const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === input.editorial_timeline_version_id)
    if (!document || !parent || !timeline) {
      throw new VideoWorkbenchServiceError('字幕翻译恢复基础不存在', 409, 'VIDEO_FINISHING_STALE')
    }
    await this.executeCaptionTranslation(project, document, parent, timeline, input, operation)
  }

  private remoteRecoveryCheckpoint(operation: VideoOperation): RemoteOperationRecoveryCheckpoint | null {
    const value = operation.result?.remote_recovery
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const checkpoint = value as Record<string, unknown>
    const usage = checkpoint.usage
    if (
      !['submitting', 'outcome_unknown'].includes(String(checkpoint.state))
      || typeof checkpoint.local_operation_id !== 'string'
      || typeof checkpoint.request_fingerprint !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(checkpoint.request_fingerprint)
      || typeof checkpoint.request_hash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(checkpoint.request_hash)
      || typeof checkpoint.budget_id !== 'string'
      || !['visual_evidence', 'media_reasoning', 'speech_transcription', 'semantic_embedding'].includes(String(checkpoint.capability))
      || !usage
      || typeof usage !== 'object'
      || Array.isArray(usage)
      || typeof checkpoint.updated_at !== 'string'
    ) return null
    const allocation = usage as Record<string, unknown>
    if (
      !Number.isSafeInteger(allocation.requests)
      || !Number.isSafeInteger(allocation.total_tokens)
      || !Number.isSafeInteger(allocation.input_bytes)
      || !Number.isSafeInteger(allocation.visual_frames)
      || typeof allocation.proxy_seconds !== 'number'
      || typeof allocation.asr_seconds !== 'number'
      || !Number.isSafeInteger(allocation.estimated_amount_micros)
    ) return null
    return checkpoint as unknown as RemoteOperationRecoveryCheckpoint
  }

  private sameRemoteUsage(left: RemoteUsage, right: RemoteUsage): boolean {
    return left.requests === right.requests
      && left.total_tokens === right.total_tokens
      && left.input_bytes === right.input_bytes
      && left.visual_frames === right.visual_frames
      && left.proxy_seconds === right.proxy_seconds
      && left.asr_seconds === right.asr_seconds
      && left.estimated_amount_micros === right.estimated_amount_micros
  }

  /** Persist the exact recovery authority before a generic Relay POST. A task
   * that already owns a different request or allocation fails before network
   * I/O, rather than silently changing the meaning of an outcome-unknown call. */
  private async fenceRemoteOperation(
    projectId: string,
    parentOperationId: string,
    budgetId: string,
    capability: RemoteCapability,
    usage: RemoteUsage,
    request: RelayOperationRequest,
  ): Promise<void> {
    await this.mutateProject(projectId, async () => {
      const operation = await this.repository.getOperation(parentOperationId)
      if (operation.project_id !== projectId || !['video.analyze', 'video.plan', 'video.index', 'video.caption_translation'].includes(operation.kind)) {
        throw new VideoWorkbenchServiceError('远程恢复父任务无效', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      }
      const requestFingerprint = factBasisHash(request) as `sha256:${string}`
      const existing = this.remoteRecoveryCheckpoint(operation)
      if (existing && (
        existing.local_operation_id !== request.local_operation_id
        || existing.request_fingerprint !== requestFingerprint
        || existing.request_hash !== request.request_hash
        || existing.budget_id !== budgetId
        || existing.capability !== capability
        || !this.sameRemoteUsage(existing.usage, usage)
      )) {
        throw new VideoWorkbenchServiceError('远程恢复请求与已持久化栅栏不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      }
      const checkpoint: RemoteOperationRecoveryCheckpoint = {
        state: existing?.state ?? 'submitting',
        local_operation_id: request.local_operation_id,
        request_fingerprint: requestFingerprint,
        request_hash: request.request_hash as `sha256:${string}`,
        budget_id: budgetId,
        capability,
        usage,
        updated_at: this.iso(),
      }
      await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'running',
        remote_submission_started_at: operation.remote_submission_started_at ?? this.iso(),
        outcome_unknown: checkpoint.state === 'outcome_unknown',
        result: { ...operation.result, remote_recovery: checkpoint },
      }))
    })
  }

  private async updateRemoteOperationRecovery(parentOperationId: string, state: 'submitting' | 'outcome_unknown' | 'cleared'): Promise<void> {
    const operation = await this.repository.getOperation(parentOperationId).catch(() => null)
    if (!operation) return
    await this.mutateProject(operation.project_id, async () => {
      const current = await this.repository.getOperation(parentOperationId)
      const checkpoint = this.remoteRecoveryCheckpoint(current)
      if (!checkpoint) return
      const { remote_recovery: _remoteRecovery, ...result } = current.result ?? {}
      await this.repository.saveOperation(this.operation({
        ...current,
        outcome_unknown: state === 'outcome_unknown',
        result: state === 'cleared'
          ? result
          : { ...result, remote_recovery: { ...checkpoint, state, updated_at: this.iso() } },
      }))
    })
  }

  private asrCheckpoint(operation: VideoOperation, sourceId: string): AsrPollCheckpoint | null {
    const entries = operation.result?.asr_checkpoints
    if (!Array.isArray(entries)) return null
    const value = entries.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).source_id === sourceId)
    if (!value || typeof value !== 'object') return null
    const checkpoint = value as Record<string, unknown>
    const states = new Set<AsrPollCheckpoint['state']>(['uploading', 'submitting', 'submitted', 'running', 'cancel_pending', 'result_pending', 'succeeded', 'failed', 'cancelled', 'outcome_unknown', 'expired'])
    if (
      typeof checkpoint.local_operation_id !== 'string'
      || typeof checkpoint.state !== 'string'
      || !states.has(checkpoint.state as AsrPollCheckpoint['state'])
      || typeof checkpoint.updated_at !== 'string'
    ) return null
    return {
      source_id: sourceId,
      local_operation_id: checkpoint.local_operation_id,
      state: checkpoint.state as AsrPollCheckpoint['state'],
      ...(typeof checkpoint.object_ref === 'string' ? { object_ref: checkpoint.object_ref } : {}),
      ...(typeof checkpoint.relay_operation_id === 'string' ? { relay_operation_id: checkpoint.relay_operation_id } : {}),
      ...(typeof checkpoint.provider_task_id === 'string' ? { provider_task_id: checkpoint.provider_task_id } : {}),
      ...(typeof checkpoint.remote_submission_started_at === 'string' ? { remote_submission_started_at: checkpoint.remote_submission_started_at } : {}),
      ...(typeof checkpoint.next_poll_at === 'string' ? { next_poll_at: checkpoint.next_poll_at } : {}),
      updated_at: checkpoint.updated_at,
    }
  }

  private async saveAsrCheckpoint(parentOperationId: string, sourceId: string, patch: Omit<Partial<AsrPollCheckpoint>, 'source_id' | 'updated_at'>): Promise<AsrPollCheckpoint | null> {
    try {
      return await this.mutateProject((await this.repository.getOperation(parentOperationId)).project_id, async () => {
        const operation = await this.repository.getOperation(parentOperationId)
        const existing = this.asrCheckpoint(operation, sourceId)
        const hasPatch = (key: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, key)
        const localOperationId = hasPatch('local_operation_id') ? patch.local_operation_id : existing?.local_operation_id
        const objectRef = hasPatch('object_ref') ? patch.object_ref : existing?.object_ref
        const relayOperationId = hasPatch('relay_operation_id') ? patch.relay_operation_id : existing?.relay_operation_id
        const providerTaskId = hasPatch('provider_task_id') ? patch.provider_task_id : existing?.provider_task_id
        const submissionStartedAt = hasPatch('remote_submission_started_at') ? patch.remote_submission_started_at : existing?.remote_submission_started_at
        const nextPollAt = hasPatch('next_poll_at') ? patch.next_poll_at : existing?.next_poll_at
        const checkpoint: AsrPollCheckpoint = {
          source_id: sourceId,
          local_operation_id: localOperationId ?? `${parentOperationId}_asr_${sourceId}`,
          state: patch.state ?? existing?.state ?? 'uploading',
          ...(typeof objectRef === 'string' ? { object_ref: objectRef } : {}),
          ...(typeof relayOperationId === 'string' ? { relay_operation_id: relayOperationId } : {}),
          ...(typeof providerTaskId === 'string' ? { provider_task_id: providerTaskId } : {}),
          ...(typeof submissionStartedAt === 'string' ? { remote_submission_started_at: submissionStartedAt } : {}),
          ...(typeof nextPollAt === 'string' ? { next_poll_at: nextPollAt } : {}),
          updated_at: this.iso(),
        }
        const prior = Array.isArray(operation.result?.asr_checkpoints) ? operation.result!.asr_checkpoints : []
        const checkpoints = [...prior.filter(item => !(item && typeof item === 'object' && (item as Record<string, unknown>).source_id === sourceId)), checkpoint]
        await this.repository.saveOperation(this.operation({
          ...operation,
          result: { ...operation.result, asr_checkpoints: checkpoints },
        }))
        return checkpoint
      })
    } catch (error) {
      if (error instanceof VideoWorkbenchRepositoryError) return null
      throw error
    }
  }

  private async waitForAsrPoll(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(done, delayMs)
      const cancelled = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', cancelled)
        reject(new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED'))
      }
      function done() {
        signal.removeEventListener('abort', cancelled)
        resolve()
      }
      signal.addEventListener('abort', cancelled, { once: true })
    })
  }

  private async finalizeAsrTerminalBudget(
    projectId: string,
    localOperationId: string,
    projection: RelayOperationProjection,
    terminal: 'failed' | 'expired' | 'cancelled' | 'late_cancelled_result',
  ): Promise<void> {
    const project = await this.requireVideoProject(projectId)
    const budget = project.remote_analysis_budgets.find(item => (
      item.settlements.some(entry => entry.operation_id === localOperationId)
      || item.reservations.some(entry => entry.operation_id === localOperationId)
    ))
    if (!budget || budget.settlements.some(entry => entry.operation_id === localOperationId)) return
    if (projection.provider_receipt) {
      await this.settleRemoteBudget(projectId, budget.id, localOperationId, projection.provider_receipt)
      return
    }
    if (terminal === 'cancelled') {
      // Relay can confirm a pre-provider cancellation without a receipt. That
      // is the only terminal path that proves the reservation was never spent.
      await this.finalizeRemoteBudgetFailure(
        projectId,
        budget.id,
        localOperationId,
        new VideoMediaRelayClientError(422, 'provider_cancelled_before_start'),
        { submissionFenced: true, allowOutcomeUnknownRelease: true },
      )
      return
    }
    // A failed/expired/late terminal projection without a receipt cannot prove
    // zero spend. Retain the exact allocation instead of releasing it.
    await this.finalizeRemoteBudgetFailure(
      projectId,
      budget.id,
      localOperationId,
      new VideoMediaRelayClientError(503, `provider_${terminal}_receipt_missing`),
      { submissionFenced: true },
    )
  }

  /** Persist cancellation intent before contacting Relay, then use a fresh
   * client that is deliberately not bound to the already-aborted analysis
   * signal. Only Relay's cancelled projection is authoritative; every failure
   * leaves cancel_pending for startup reconciliation. */
  private async requestAsrCancellation(parentOperationId: string, sourceId: string, relayOperationId: string): Promise<RelayOperationProjection | null> {
    const pending = await this.saveAsrCheckpoint(parentOperationId, sourceId, {
      state: 'cancel_pending',
      relay_operation_id: relayOperationId,
    })
    if (!pending) return null
    const controlRelay = this.videoMediaRelay()
    if (!controlRelay) return null
    // One immediate bounded retry absorbs a transient Relay/network failure
    // without turning cancellation into an unbounded in-process loop. Both
    // attempts use the same Relay idempotency key; startup remains the durable
    // retry boundary if neither attempt obtains explicit cancellation proof.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const projection = await controlRelay.cancel(relayOperationId)
        if (projection.state !== 'cancelled') return null
        const cancelled = await this.saveAsrCheckpoint(parentOperationId, sourceId, {
          state: 'cancelled',
          relay_operation_id: relayOperationId,
          ...(projection.provider_task_id ? { provider_task_id: projection.provider_task_id } : {}),
        })
        if (cancelled?.state !== 'cancelled') return null
        const operation = await this.repository.getOperation(parentOperationId)
        await this.finalizeAsrTerminalBudget(operation.project_id, pending.local_operation_id, projection, 'cancelled')
        return projection
      } catch (error) {
        const retryable = !(error instanceof VideoMediaRelayClientError) || error.status >= 500
        if (!retryable || attempt === 1) return null
        await new Promise<void>(resolve => setTimeout(resolve, 50))
      }
    }
    return null
  }

  /** A budget is admitted per local Operation before the Relay is called.
   * Reservations and receipts are two states of the same allocation: adding a
   * receipt must never make a previously admitted operation spend twice. */
  private async reserveRemoteBudget(projectId: string, budgetId: string, operationId: string, capability: RemoteCapability, usage: RemoteUsage): Promise<void> {
    if (!Number.isSafeInteger(usage.estimated_amount_micros) || usage.estimated_amount_micros <= 0) {
      throw new VideoWorkbenchServiceError('远程操作缺少正数费用预留', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
    }
    await this.mutateProject(projectId, async () => {
      const project = await this.requireVideoProject(projectId)
      const budget = project.remote_analysis_budgets.find(item => item.id === budgetId)
      if (!budget || budget.state !== 'reserved') throw new VideoWorkbenchServiceError('远程预算 reservation 不可使用', 409, 'VIDEO_REMOTE_ESTIMATE_REQUIRED')
      const settled = budget.settlements.find(item => item.operation_id === operationId)
      const existing = budget.reservations.find(item => item.operation_id === operationId)
      if (settled) return
      if (existing) {
        const sameAllocation = existing.capability === capability
          && existing.requests === usage.requests
          && existing.total_tokens === usage.total_tokens
          && existing.input_bytes === usage.input_bytes
          && existing.visual_frames === usage.visual_frames
          && existing.proxy_seconds === usage.proxy_seconds
          && existing.asr_seconds === usage.asr_seconds
          && existing.estimated_amount_micros === usage.estimated_amount_micros
        if (!sameAllocation) {
          throw new VideoWorkbenchServiceError('远程预算操作预留不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
        }
        // An outcome-unknown reservation is deliberately retained. The same
        // deterministic local Operation and byte-for-byte allocation may use
        // Relay's owner-scoped idempotency record to recover; it must not
        // reserve a second unit of budget. A different allocation failed the
        // comparison above before any Relay request can leave this process.
        if (existing.state === 'reserved' || existing.state === 'outcome_unknown') return
        // A failure proven to have happened before the provider submission
        // may retry the same deterministic local Operation. Replace its
        // released allocation rather than accumulating another reservation.
        const revived = { operation_id: operationId, capability, state: 'reserved' as const, ...usage, reserved_at: this.iso() }
        const totals = [...budget.settlements, ...budget.reservations.filter(item => item.operation_id !== operationId && item.state !== 'released'), revived].reduce((value, item) => ({
          requests: value.requests + item.requests,
          total_tokens: value.total_tokens + item.total_tokens,
          input_bytes: value.input_bytes + item.input_bytes,
          visual_frames: value.visual_frames + item.visual_frames,
          proxy_seconds: value.proxy_seconds + item.proxy_seconds,
          asr_seconds: value.asr_seconds + item.asr_seconds,
          estimated_amount_micros: value.estimated_amount_micros + item.estimated_amount_micros,
        }), { requests: 0, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 })
        if (totals.requests > budget.requests || totals.total_tokens > budget.total_tokens || totals.input_bytes > budget.input_bytes || totals.visual_frames > budget.visual_frames || totals.proxy_seconds > budget.proxy_seconds || totals.asr_seconds > budget.asr_seconds || totals.estimated_amount_micros > budget.estimated_amount_micros) {
          throw new VideoWorkbenchServiceError('远程预算已耗尽，拒绝启动未预留操作', 429, 'VIDEO_PROJECT_BUDGET_EXCEEDED')
        }
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          remote_analysis_budgets: project.remote_analysis_budgets.map(item => item.id === budgetId
            ? { ...item, reservations: item.reservations.map(entry => entry.operation_id === operationId ? revived : entry), updated_at: this.iso() }
            : item),
        }))
        return
      }
      const next = { operation_id: operationId, capability, state: 'reserved' as const, ...usage, reserved_at: this.iso() }
      const totals = [...budget.settlements, ...budget.reservations.filter(item => item.state !== 'released'), next].reduce((value, item) => ({
        requests: value.requests + item.requests,
        total_tokens: value.total_tokens + item.total_tokens,
        input_bytes: value.input_bytes + item.input_bytes,
        visual_frames: value.visual_frames + item.visual_frames,
        proxy_seconds: value.proxy_seconds + item.proxy_seconds,
        asr_seconds: value.asr_seconds + item.asr_seconds,
        estimated_amount_micros: value.estimated_amount_micros + item.estimated_amount_micros,
      }), { requests: 0, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 })
      if (totals.requests > budget.requests || totals.total_tokens > budget.total_tokens || totals.input_bytes > budget.input_bytes || totals.visual_frames > budget.visual_frames || totals.proxy_seconds > budget.proxy_seconds || totals.asr_seconds > budget.asr_seconds || totals.estimated_amount_micros > budget.estimated_amount_micros) {
        throw new VideoWorkbenchServiceError('远程预算已耗尽，拒绝启动未预留操作', 429, 'VIDEO_PROJECT_BUDGET_EXCEEDED')
      }
      await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        remote_analysis_budgets: project.remote_analysis_budgets.map(item => item.id === budgetId ? { ...item, reservations: [...item.reservations, next], updated_at: this.iso() } : item),
      }))
    })
  }

  private async settleRemoteBudget(projectId: string, budgetId: string, operationId: string, receipt: {
    id: string
    capability: RemoteCapability
    usage: RemoteUsage
  }): Promise<void> {
    await this.mutateProject(projectId, async () => {
      const project = await this.requireVideoProject(projectId)
      const budget = project.remote_analysis_budgets.find(item => item.id === budgetId)
      if (!budget || budget.state !== 'reserved') throw new VideoWorkbenchServiceError('远程预算 reservation 不可结算', 409, 'VIDEO_REMOTE_ESTIMATE_REQUIRED')
      const existing = budget.settlements.find(item => item.operation_id === operationId)
      if (existing) {
        if (existing.receipt_id !== receipt.id) throw new VideoWorkbenchServiceError('远程预算操作回执不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
        return
      }
      const reservation = budget.reservations.find(item => item.operation_id === operationId)
      // A transport loss after the Relay accepted a task fences the local
      // reservation as outcome_unknown. If a later read-only poll returns the
      // same receipt, that exact reservation is safely settled rather than
      // forcing a duplicate submission or leaving spend permanently orphaned.
      if (!reservation || !['reserved', 'outcome_unknown'].includes(reservation.state) || reservation.capability !== receipt.capability) throw new VideoWorkbenchServiceError('远程操作缺少调用前预算预留', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      const next = {
        operation_id: operationId,
        receipt_id: receipt.id,
        capability: receipt.capability,
        ...receipt.usage,
        settled_at: this.iso(),
      }
      const totals = [...budget.settlements, ...budget.reservations.filter(item => item.operation_id !== operationId && item.state !== 'released'), next].reduce((value, item) => ({
        requests: value.requests + item.requests,
        total_tokens: value.total_tokens + item.total_tokens,
        input_bytes: value.input_bytes + item.input_bytes,
        visual_frames: value.visual_frames + item.visual_frames,
        proxy_seconds: value.proxy_seconds + item.proxy_seconds,
        asr_seconds: value.asr_seconds + item.asr_seconds,
        estimated_amount_micros: value.estimated_amount_micros + item.estimated_amount_micros,
      }), { requests: 0, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 })
      if (
        totals.requests > budget.requests
        || totals.total_tokens > budget.total_tokens
        || totals.input_bytes > budget.input_bytes
        || totals.visual_frames > budget.visual_frames
        || totals.proxy_seconds > budget.proxy_seconds
        || totals.asr_seconds > budget.asr_seconds
        || totals.estimated_amount_micros > budget.estimated_amount_micros
      ) throw new VideoWorkbenchServiceError('远程预算已耗尽，拒绝未预估的回执', 429, 'VIDEO_PROJECT_BUDGET_EXCEEDED')
      await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        remote_analysis_budgets: project.remote_analysis_budgets.map(item => item.id === budgetId
          ? { ...item, reservations: item.reservations.filter(reserved => reserved.operation_id !== operationId), settlements: [...item.settlements, next], updated_at: this.iso() }
          : item),
      }))
    })
  }

  /** A terminal Relay projection may carry a provider receipt even when the
   * provider rejected, expired, or cancelled the task. The receipt is still
   * the authoritative usage record and must settle the one admitted local
   * Operation before its error is surfaced to the caller. */
  private async settleRemoteBudgetReceipt(
    projectId: string,
    budgetId: string,
    operationId: string,
    projection: RelayOperationProjection,
  ): Promise<boolean> {
    if (!projection.provider_receipt || !['succeeded', 'failed', 'expired', 'cancelled'].includes(projection.state)) return false
    await this.settleRemoteBudget(projectId, budgetId, operationId, projection.provider_receipt)
    return true
  }

  /** A provider failure belongs to the one local Operation that was admitted.
   * Do not revoke a whole project estimate merely because one call failed. */
  private async finalizeRemoteBudgetFailure(
    projectId: string,
    budgetId: string,
    operationId: string,
    error: unknown,
    options: { submissionFenced?: boolean; allowProviderNotStartedRelease?: boolean; allowOutcomeUnknownRelease?: boolean } = {},
  ): Promise<void> {
    // The Relay may use a 503 transport status for a saturated/closing local
    // admission gate while still proving that its durable provider submission
    // fence was never crossed. That exact machine code is authoritative: it is
    // safe to release even though a generic 5xx remains outcome-unknown.
    const providerNotStarted = options.allowProviderNotStartedRelease !== false
      && error instanceof VideoMediaRelayClientError
      && error.status === 503
      && error.code === 'provider_not_started'
    // After the local submission fence, a caller-side 499 only proves that
    // the response was abandoned. Relay/Provider acceptance may still have
    // happened, so this one 4xx must remain outcome-unknown.
    const fencedCancellation = options.submissionFenced && error instanceof VideoMediaRelayClientError && error.status === 499
    // A 409 can mean an existing idempotency/local-operation record already
    // owns this logical submission. Releasing its allocation would ignore a
    // Provider task that may be running; recovery must resolve that record.
    const fencedConflict = options.submissionFenced && error instanceof VideoMediaRelayClientError && error.status === 409
    const outcomeUnknown = !providerNotStarted && (fencedCancellation || fencedConflict || !(error instanceof VideoMediaRelayClientError) || error.status >= 500)
    const safeErrorCode = error instanceof VideoMediaRelayClientError ? error.code : 'provider_outcome_unknown'
    await this.mutateProject(projectId, async () => {
      const project = await this.requireVideoProject(projectId)
      const budget = project.remote_analysis_budgets.find(item => item.id === budgetId)
      if (!budget || budget.state !== 'reserved' || budget.settlements.some(item => item.operation_id === operationId)) return
      const reservation = budget.reservations.find(item => item.operation_id === operationId)
      if (!reservation || (
        reservation.state !== 'reserved'
        && !((providerNotStarted || options.allowOutcomeUnknownRelease) && reservation.state === 'outcome_unknown')
      )) return
      await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        remote_analysis_budgets: project.remote_analysis_budgets.map(item => item.id === budgetId
          ? {
              ...item,
              reservations: item.reservations.map(entry => entry.operation_id === operationId
                ? { ...entry, state: outcomeUnknown ? 'outcome_unknown' as const : 'released' as const, safe_error_code: safeErrorCode, finalized_at: this.iso() }
                : entry),
              updated_at: this.iso(),
            }
          : item),
      }))
    })
  }

  /** Execute one deterministic Relay Operation under one durable allocation.
   *
   * Every current caller builds `request` once, so recovery uses the exact
   * same local_operation_id, request_hash and payload. After a transport loss,
   * the unbound control client first proves the operation exists through the
   * formal local id index, then repeats the same POST. That POST is not a new
   * provider call: Relay's durable idempotency record either returns the same
   * operation or rejects a changed fingerprint with 409. A healthy 404 is the
   * only proof that no provider submission exists and releases the allocation.
   */
  private async reserveAndRunRemote<T>(
    projectId: string,
    budgetId: string,
    capability: RemoteCapability,
    usage: RemoteUsage,
    relay: VideoMediaRelayClient,
    request: RelayOperationRequest,
    consume: (client: VideoMediaRelayClient, operation: RelayOperationProjection) => Promise<T>,
    options: { parentOperationId?: string } = {},
  ): Promise<T> {
    const operationId = request.local_operation_id
    if (request.capability !== capability || request.local_budget_reservation_id !== budgetId) {
      throw new VideoWorkbenchServiceError('远程请求与本地预算预留不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
    }
    await this.reserveRemoteBudget(projectId, budgetId, operationId, capability, usage)
    if (options.parentOperationId) {
      try {
        await this.fenceRemoteOperation(projectId, options.parentOperationId, budgetId, capability, usage, request)
      } catch (error) {
        await this.finalizeRemoteBudgetFailure(projectId, budgetId, operationId, new VideoMediaRelayClientError(422, 'local_submission_fence_failed'))
        throw error
      }
    }
    let accepted: RelayOperationProjection | undefined
    try {
      accepted = await relay.createOperation(await this.authorizeRelayOperation(projectId, relay, request))
      const value = await consume(relay, accepted)
      // A caller with a parent Operation clears/replaces its fence only inside
      // `consume`, together with a durable local result (Fact, staged Plan, or
      // staged query vector). Clearing here would create a paid-result crash
      // window between this return and the caller's later persistence step.
      return value
    } catch (error) {
      // Any provider receipt is authoritative, including failed/expired/
      // cancelled terminal projections. Callers normally settle succeeded
      // results before local projection, but this idempotent settlement also
      // covers a rejected terminal result and a local failure before that
      // caller-side settlement. Never release a paid Operation as a generic
      // 4xx merely because the provider did not produce a usable result.
      const acceptedReceiptSettled = accepted
        ? await this.settleRemoteBudgetReceipt(projectId, budgetId, operationId, accepted)
        : false
      if (acceptedReceiptSettled && accepted) {
        if (options.parentOperationId) await this.updateRemoteOperationRecovery(
          options.parentOperationId,
          accepted.state === 'succeeded'
            ? error instanceof VideoWorkbenchServiceError ? 'cleared' : 'outcome_unknown'
            : accepted.state === 'failed' || accepted.state === 'expired' || accepted.state === 'cancelled'
              ? 'cleared'
              : 'outcome_unknown',
        )
        throw error
      }
      await this.finalizeRemoteBudgetFailure(projectId, budgetId, operationId, error, { submissionFenced: true })
      const outcomeUnknown = !(
        error instanceof VideoMediaRelayClientError
        && (error.status < 500 && error.status !== 409 && error.status !== 499)
      ) && !(error instanceof VideoMediaRelayClientError && error.status === 503 && error.code === 'provider_not_started')
      if (!outcomeUnknown) {
        if (options.parentOperationId) await this.updateRemoteOperationRecovery(
          options.parentOperationId,
          error instanceof VideoMediaRelayClientError && error.code === 'provider_not_started' ? 'submitting' : 'cleared',
        )
        throw videoHostedQuotaError(error) ?? error
      }
      if (options.parentOperationId) await this.updateRemoteOperationRecovery(options.parentOperationId, 'outcome_unknown')
      const recoveryRelay = this.videoMediaRelay()
      if (!recoveryRelay) throw error
      let replayed: RelayOperationProjection | undefined
      try {
        const existing = await recoveryRelay.operationByLocalOperationId(operationId)
        if (!existing) {
          const absent = new VideoMediaRelayClientError(503, 'provider_not_started')
          await this.finalizeRemoteBudgetFailure(projectId, budgetId, operationId, absent, { submissionFenced: true })
          if (options.parentOperationId) await this.updateRemoteOperationRecovery(options.parentOperationId, 'submitting')
          throw videoHostedQuotaError(absent) ?? absent
        }
        // Lookup is read-only recovery; this strict replay is the fingerprint
        // authority. A changed request can only fail 409, never reach Provider.
        replayed = await recoveryRelay.createOperation(await this.authorizeRelayOperation(projectId, recoveryRelay, request))
        if (replayed.id !== existing.id) throw new VideoMediaRelayClientError(409, 'local_operation_projection_conflict')
        const value = await consume(recoveryRelay, replayed)
        return value
      } catch (recoveryError) {
        const replayedReceiptSettled = replayed
          ? await this.settleRemoteBudgetReceipt(projectId, budgetId, operationId, replayed)
          : false
        if (replayedReceiptSettled && replayed) {
          // Recovery can discover a terminal provider failure that the first
          // POST did not return. Settle its real usage before surfacing the
          // deterministic failure; replay must never release the reservation.
          if (options.parentOperationId) await this.updateRemoteOperationRecovery(
            options.parentOperationId,
            replayed.state === 'succeeded'
              ? recoveryError instanceof VideoWorkbenchServiceError ? 'cleared' : 'outcome_unknown'
              : replayed.state === 'failed' || replayed.state === 'expired' || replayed.state === 'cancelled'
                ? 'cleared'
                : 'outcome_unknown',
          )
          throw recoveryError
        }
        // A failed lookup is not an absence proof, and once lookup found an
        // operation even a contradictory provider_not_started response cannot
        // release its allocation. Only the explicit null branch above may do
        // that during recovery.
        await this.finalizeRemoteBudgetFailure(projectId, budgetId, operationId, recoveryError, { submissionFenced: true, allowProviderNotStartedRelease: false })
        throw videoHostedQuotaError(recoveryError) ?? recoveryError
      }
    }
  }

  private renderQueueLimit(): number {
    const configured = Number(this.env.BB_VIDEO_RENDER_QUEUE_LIMIT ?? '3')
    return Number.isSafeInteger(configured) ? Math.max(1, Math.min(10, configured)) : 3
  }

  private enqueueRender(action: () => Promise<void>): Promise<void> {
    const completion = this.renderTail.catch(() => undefined).then(action)
    this.renderTail = completion.catch(() => undefined)
    return completion
  }

  private async project(projectId: string): Promise<VideoStudioProject> {
    try {
      return await this.repository.getProject(projectId)
    } catch (error) {
      if (error instanceof VideoWorkbenchRepositoryError) {
        throw new VideoWorkbenchServiceError(error.message, error.status, error.code)
      }
      throw error
    }
  }

  private async mutateProject<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    return await this.projectStore.mutate(projectId, action)
  }

  private timelineVersion(
    project: VideoStudioProject,
    scenes: VideoScene[],
    revision = project.evidence_revision ?? evidenceRevision(project.evidence),
    projectRevision = project.revision + 1,
  ): VideoTimelineVersion {
    return {
      id: id('timeline'),
      parent_version_id: project.current_timeline_version_id,
      project_revision: projectRevision,
      evidence_revision: revision,
      scenes,
      created_at: this.iso(),
    }
  }

  private operation(value: VideoOperation): VideoOperation {
    return {
      ...value,
      owner: value.owner ?? STANDALONE_VIDEO_OWNER,
      updated_at: value.updated_at ?? this.iso(),
    }
  }

  private finishingReplay(
    project: VideoStudioProject,
    kind: VideoFinishingReceipt['kind'],
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
  ): string[] | null {
    const receipt = project.finishing_receipts.find(candidate => candidate.kind === kind && candidate.idempotency_key === idempotencyKey)
    if (!receipt) return null
    if (receipt.request_hash !== requestHash) {
      throw new VideoWorkbenchServiceError('同一幂等键不能提交不同的完成层请求', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
    }
    return [...receipt.resource_ids]
  }

  private finishingReceipt(
    kind: VideoFinishingReceipt['kind'],
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
    resourceIds: string[],
  ): VideoFinishingReceipt {
    return {
      kind,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      resource_ids: resourceIds,
      created_at: this.iso(),
    }
  }

  private editorialMutationReplay(
    project: VideoStudioProject,
    kind: VideoStudioProject['editorial_mutation_receipts'][number]['kind'],
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
  ): string[] | null {
    const receipt = project.editorial_mutation_receipts.find(item => item.kind === kind && item.idempotency_key === idempotencyKey)
    if (!receipt) return null
    if (receipt.request_hash !== requestHash) {
      throw new VideoWorkbenchServiceError('同一幂等键不能提交不同的编辑请求', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
    }
    return [...receipt.resource_ids]
  }

  private editorialMutationReceipt(
    kind: VideoStudioProject['editorial_mutation_receipts'][number]['kind'],
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
    resourceIds: string[],
  ): VideoStudioProject['editorial_mutation_receipts'][number] {
    return { kind, idempotency_key: idempotencyKey, request_hash: requestHash, resource_ids: resourceIds, created_at: this.iso() }
  }

  private async startFinishingOperation(
    project: VideoStudioProject,
    kind: 'video.caption_draft' | 'video.caption_translation' | 'video.composition_plan' | 'video.audio_finish_plan' | 'video.quality_preflight' | 'video.subject_track' | 'video.beat_sync_draft',
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
    stage: string,
  ): Promise<VideoOperation> {
    const existing = (await this.repository.listOperations(project.id)).find(candidate => candidate.kind === kind && candidate.idempotency_key === idempotencyKey)
    if (existing) {
      if (existing.result?.request_hash !== requestHash) {
        throw new VideoWorkbenchServiceError('同一幂等键不能提交不同的完成层请求', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
      }
      return existing
    }
    const queued = await this.repository.saveOperation(this.operation({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      kind,
      status: 'queued',
      progress: 0,
      stage: `等待${stage}`,
      idempotency_key: idempotencyKey,
      result: { request_hash: requestHash },
      created_at: this.iso(),
      updated_at: this.iso(),
    } as unknown as VideoOperation))
    return await this.repository.saveOperation(this.operation({
      ...queued,
      status: 'running',
      progress: 10,
      stage: `正在${stage}`,
    }))
  }

  private async completeFinishingOperation(operation: VideoOperation, stage: string, result: Record<string, unknown>): Promise<VideoOperation> {
    return await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'succeeded',
      progress: 100,
      stage,
      result: { ...(operation.result ?? {}), ...result },
      error: undefined,
      error_code: undefined,
    }))
  }

  async listProjects(owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<VideoStudioProject[]> {
    return await this.repository.listProjects(owner)
  }

  async getProject(projectId: string): Promise<VideoStudioProject> {
    return await this.project(projectId)
  }

  /**
   * Read-side only snapshot for the desktop after startup or an event-cursor
   * reset.  It never makes a Relay/Provider request and deliberately returns
   * raw domain values only to the API projector, not to Renderer callers.
   */
  async getWorkspaceSnapshotData(projectId: string, eventCursor: number) {
    const snapshot = await this.repository.getWorkspaceSnapshot(projectId, eventCursor)
    if (snapshot.project.kind !== 'video') throw new VideoWorkbenchServiceError('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return snapshot
  }

  private editorialError(error: unknown): never {
    if (error instanceof EditorialValidationError) {
      const status = error.code === 'VIDEO_EDITORIAL_STALE'
        || error.code === 'VIDEO_EDITORIAL_LOCKED'
        || error.code === 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT'
        || error.code === 'VIDEO_SOURCE_FINGERPRINT_PENDING'
        ? 409
        : 400
      throw new VideoWorkbenchServiceError(error.message, status, error.code)
    }
    throw error
  }

  private finishingError(error: unknown): never {
    if (error instanceof FinishingDeliveryValidationError) {
      const status = error.code === 'VIDEO_FINISHING_STALE' ? 409
        : error.code === 'VIDEO_QUALITY_BLOCKED' ? 409
          : error.code === 'VIDEO_FINISHING_UNAVAILABLE' ? 422
            : 400
      throw new VideoWorkbenchServiceError(error.message, status, error.code)
    }
    throw error
  }

  private async editorialTimings(project: VideoStudioProject): Promise<Map<string, EditorialSourceTiming>> {
    const timings = new Map<string, EditorialSourceTiming>()
    for (const source of project.sources) {
      const fact = await this.repository.getFact('source', source.id).catch(() => null)
      if (!fact || !('fast_identity' in fact)) continue
      timings.set(source.id, {
        tick_rate: tickRateForTimeBase(fact.primary_video_stream.time_base),
        start_ticks: fact.primary_video_stream.start_time.ticks,
      })
    }
    return timings
  }

  async editorialSourceBounds(project: VideoStudioProject): Promise<Map<string, EditorialSourceBounds>> {
    const bounds = new Map<string, EditorialSourceBounds>()
    for (const source of project.sources) {
      let fact: Awaited<ReturnType<VideoWorkbenchRepository['getFact']>>
      try {
        fact = await this.repository.getFact('source', source.id)
      } catch {
        throw new VideoWorkbenchServiceError('无法读取素材时间事实，已拒绝编辑以避免越界', 503, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      if (!('fast_identity' in fact) || !fact.primary_video_stream.duration) {
        throw new VideoWorkbenchServiceError('素材原始视频时长缺失，不能安全验证剪辑范围', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      const audio = fact.audio_tracks.find(track => track.disposition_default) ?? fact.audio_tracks[0]
      if (source.has_audio && (!audio || !audio.duration)) {
        throw new VideoWorkbenchServiceError('素材原始音频流范围缺失，不能安全编译 A/V 时间线', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      bounds.set(source.id, {
        video_stream_index: fact.primary_video_stream.stream_index,
        start: fact.primary_video_stream.start_time,
        // Presentation duration can include discontinuities or stream
        // alignment. Editorial source ranges are bounded by the primary
        // video stream that the compiler will actually read.
        duration: fact.primary_video_stream.duration,
        video_color: {
          hdr_kind: fact.primary_video_stream.hdr_kind,
          ...(fact.primary_video_stream.color_space ? { color_space: fact.primary_video_stream.color_space } : {}),
          ...(fact.primary_video_stream.color_transfer ? { color_transfer: fact.primary_video_stream.color_transfer } : {}),
          ...(fact.primary_video_stream.color_primaries ? { color_primaries: fact.primary_video_stream.color_primaries } : {}),
          ...(fact.primary_video_stream.color_range ? { color_range: fact.primary_video_stream.color_range } : {}),
          ...(fact.primary_video_stream.pixel_format ? { pixel_format: fact.primary_video_stream.pixel_format } : {}),
        },
        ...(audio?.duration ? {
          audio: {
            stream_index: audio.stream_index,
            start: audio.start_time,
            duration: audio.duration,
            sample_rate: audio.sample_rate,
            channels: audio.channels,
          },
        } : {}),
      })
    }
    return bounds
  }

  private async ensureEditorialState(project: VideoStudioProject): Promise<VideoStudioProject> {
    try {
      const [timing, sourceBounds] = await Promise.all([
        this.editorialTimings(project),
        this.editorialSourceBounds(project),
      ])
      const next = this.editorial.ensureState(project, timing, sourceBounds)
      return next === project ? project : await this.repository.saveProject(videoStudioProjectSchema.parse(next))
    } catch (error) {
      return this.editorialError(error)
    }
  }

  async prepareEditorialProject(projectId: string): Promise<VideoStudioProject> {
    const current = await this.requireVideoProject(projectId)
    const checked = await this.assertSourcesUnchanged(current)
    return await this.ensureEditorialState(checked)
  }

  private async isBeatSyncDraftCurrent(project: VideoStudioProject, draft: TimelineDraft): Promise<boolean> {
    const beatSync = draft.beat_sync
    if (!beatSync) return true
    const source = project.sources.find(candidate => candidate.id === beatSync.source_id)
    if (!source || source.fingerprint !== beatSync.source_fingerprint || source.missing || source.content_changed) return false
    const evidence = await this.repository.getFact('evidence', beatSync.evidence_id).catch(() => null)
    if (!evidence || !('payload' in evidence) || evidence.kind !== 'beat_grid') return false
    if (evidence.source_id !== beatSync.source_id
      || evidence.source_fingerprint !== beatSync.source_fingerprint
      || evidence.basis_hash !== beatSync.facts_basis_hash
      || evidence.payload.analyzer_version !== beatSync.analyzer_version
      || evidence.payload.confidence < 0.65) return false
    const beats = evidence.payload.beats.length ? evidence.payload.beats.map(point => point.at) : evidence.payload.beat_times
    if (beats.length < 4 || !evidence.payload.coverage.length) return false
    const tracks = new Map(draft.tracks.map(track => [track.id, track]))
    const ranges = draft.items.flatMap(item => item.binding.kind === 'source'
      && item.binding.source_id === beatSync.source_id
      && tracks.get(item.track_id)?.kind === 'primary_video'
      ? [item.binding.source_range]
      : [])
    return ranges.length > 0 && ranges.every(range => sourceRangeCoveredBy(
      evidence.payload.coverage,
      sourceTimeRange(range.start, range.duration),
    ))
  }

  private deliveryVariantContext(
    project: VideoStudioProject,
    variantId: string,
    expectedVersionId?: string,
  ): { variant: DeliveryVariant; version: DeliveryVariantVersion; timeline: EditorialTimelineVersion; profile: VideoStudioProject['export_profile_revisions'][number] } {
    const variant = project.delivery_variants.find(candidate => candidate.id === variantId)
    const version = variant && project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)
    if (!variant || !version) throw new VideoWorkbenchServiceError('交付变体不存在', 404, 'VIDEO_DELIVERY_VARIANT_NOT_FOUND')
    if (expectedVersionId && version.id !== expectedVersionId) {
      throw new VideoWorkbenchServiceError('交付变体已更新，请刷新后重试', 409, 'VIDEO_FINISHING_STALE')
    }
    const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)
    const profile = project.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)
    if (!timeline || !profile || profile.content_hash !== version.export_profile_hash) {
      throw new VideoWorkbenchServiceError('交付变体引用的时间线或导出规格已变化', 409, 'VIDEO_FINISHING_STALE')
    }
    const profileOwner = project.export_profiles.find(candidate => candidate.id === profile.profile_id)
    if (project.current_editorial_timeline_version_id !== timeline.id || profileOwner?.current_revision_id !== profile.id) {
      throw new VideoWorkbenchServiceError('交付变体引用的时间线或导出规格已不是当前版本，请重新创建交付版本并预检', 409, 'VIDEO_FINISHING_STALE')
    }
    return { variant, version, timeline, profile }
  }

  private async captionTranscript(
    projectId: string,
    transcriptId?: string,
    revisionId?: string,
  ): Promise<{ transcript: TimedTranscript; revision?: TranscriptRevision }> {
    const transcripts = (await this.repository.listFacts('transcript', projectId))
      .filter((fact): fact is TimedTranscript => 'segments' in fact)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
    const transcript = transcriptId ? transcripts.find(candidate => candidate.id === transcriptId) : transcripts[0]
    if (!transcript) throw new VideoWorkbenchServiceError('没有可用于字幕的带时间码转写', 422, 'VIDEO_FINISHING_UNAVAILABLE')
    let requested: Awaited<ReturnType<VideoWorkbenchRepository['getFact']>> | undefined
    if (revisionId) {
      try {
        requested = await this.repository.getFact('transcript_revision', revisionId)
      } catch {
        // A caller selected a concrete immutable revision. Falling back to the
        // active head would silently generate captions from different text.
        throw new VideoWorkbenchServiceError('指定的字幕转写修订不存在或不可读取', 409, 'VIDEO_FINISHING_STALE')
      }
    }
    let active: Awaited<ReturnType<VideoWorkbenchRepository['facts']['activeTranscriptRevision']>> | undefined
    try {
      active = requested ?? await this.repository.facts.activeTranscriptRevision(transcript.id)
    } catch {
      throw new VideoWorkbenchServiceError('无法读取字幕转写修订，已拒绝生成候选字幕', 503, 'VIDEO_FINISHING_UNAVAILABLE')
    }
    if (active && (!('transcript_id' in active) || active.transcript_id !== transcript.id || active.project_id !== projectId)) {
      throw new VideoWorkbenchServiceError('字幕转写修订不属于当前项目', 400, 'VIDEO_FINISHING_INVALID')
    }
    return { transcript, ...(active ? { revision: active as TranscriptRevision } : {}) }
  }

  /** Consent is checked against immutable transcript source time, never a
   * caller-provided Cue display range. Full source segments are used when a
   * Cue has word anchors so translation cannot leak the unanchored remainder
   * of a synthetic projection by mistake. */
  private captionTranslationSourceRanges(
    transcript: TimedTranscript,
    revision: VideoCaptionDocumentRevision,
  ): SourceTimeRange[] {
    const segments = new Map(transcript.segments.map(segment => [segment.id, segment]))
    const ranges: SourceTimeRange[] = []
    for (const cue of revision.cues) {
      if (cue.source_anchor.transcript_id !== transcript.id) {
        throw new VideoWorkbenchServiceError('字幕翻译 Cue 引用了其他转写', 400, 'VIDEO_FINISHING_INVALID')
      }
      const selected = cue.source_anchor.segment_ids.map(segmentId => segments.get(segmentId))
      if (selected.some(segment => !segment)) {
        throw new VideoWorkbenchServiceError('字幕翻译 Cue 引用了不存在的转写片段', 400, 'VIDEO_FINISHING_INVALID')
      }
      const first = selected[0]!
      let start = first.start
      let finish = endOfRange(first)
      const words = new Map(selected.flatMap(segment => segment!.words).map(word => [word.id, word]))
      if (cue.source_anchor.word_ids.length && cue.source_anchor.word_ids.some(wordId => !words.has(wordId))) {
        throw new VideoWorkbenchServiceError('字幕翻译 Cue 的词级锚点不属于其转写片段', 400, 'VIDEO_FINISHING_INVALID')
      }
      for (const segment of selected.slice(1)) {
        if (compareRationalTime(segment!.start, start) < 0) start = segment!.start
        const end = endOfRange(segment!)
        if (compareRationalTime(end, finish) > 0) finish = end
      }
      const endAtStartRate = rescaleRationalTime(finish, start.tick_rate, 'ceil')
      const duration = parseInt64(endAtStartRate.ticks) - parseInt64(start.ticks)
      if (duration <= 0n) throw new VideoWorkbenchServiceError('字幕翻译 Cue 的源时间范围无效', 400, 'VIDEO_FINISHING_INVALID')
      ranges.push(sourceTimeRange(start, rationalTime(duration, start.tick_rate)))
    }
    return ranges
  }

  private async captionTranslationRemoteRequest(
    project: VideoStudioProject,
    document: VideoStudioProject['caption_documents'][number],
    parent: VideoCaptionDocumentRevision,
    timeline: EditorialTimelineVersion,
    input: CreateVideoCaptionTranslationInput,
    operation: VideoOperation,
  ): Promise<{ budgetId: string; relay: VideoMediaRelayClient; request: RelayOperationRequest; usage: RemoteUsage }> {
    if (
      document.project_id !== project.id
      || parent.project_id !== project.id
      || parent.document_id !== document.id
      || parent.editorial_timeline_version_id !== timeline.id
      || document.current_revision_id !== parent.id
      || project.current_editorial_timeline_version_id !== timeline.id
      || parent.cues.length === 0
      || parent.cues.length > 2_000
    ) throw new VideoWorkbenchServiceError('字幕翻译基础版本无效或已变化', 409, 'VIDEO_FINISHING_STALE')
    const { transcript, revision } = await this.captionTranscript(project.id, parent.transcript_id, parent.transcript_revision_id)
    if (
      transcript.id !== parent.transcript_id
      || (parent.transcript_revision_id && revision?.id !== parent.transcript_revision_id)
      || transcript.source_fingerprint !== project.sources.find(source => source.id === transcript.source_id)?.fingerprint
    ) throw new VideoWorkbenchServiceError('字幕翻译转写基础无效或不属于当前素材', 409, 'VIDEO_FINISHING_STALE')
    const sourceRanges = this.captionTranslationSourceRanges(transcript, parent)
    const consent = project.remote_analysis_consents.find(item => (
      item.state === 'active'
      && item.purposes.includes('caption_translation')
      && item.data_kinds.includes('transcript')
    ))
    const budget = consent && project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
    const relay = this.videoMediaRelay()
    if (!consent || !budget) throw new VideoWorkbenchServiceError('字幕翻译需要已确认的转写授权和预算', 409, 'VIDEO_REMOTE_ESTIMATE_REQUIRED')
    if (!relay) throw new VideoWorkbenchServiceError('字幕翻译远程服务不可用', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
    const coverage = consent.coverage.find(item => item.source_id === transcript.source_id)
    const consentRanges = coverage?.ranges.map(range => sourceTimeRange(range.start, range.duration)) ?? []
    if (!coverage || sourceRanges.some(range => !sourceRangeCoveredBy(consentRanges, range))) {
      throw new VideoWorkbenchServiceError('字幕翻译超出已确认的转写范围', 422, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
    }
    const evidence = parent.cues.map(cue => ({
      id: cue.id,
      kind: 'transcript' as const,
      text: cue.text,
      source_range_id: cue.source_anchor.segment_ids[0],
      confidence: cue.alignment_confidence,
    }))
    const factsBasisHash = factBasisHash({
      kind: 'caption_translation',
      document_id: document.id,
      parent_revision_id: parent.id,
      parent_basis_hash: parent.basis_hash,
      editorial_timeline_version_id: timeline.id,
      transcript_id: transcript.id,
      transcript_revision_id: parent.transcript_revision_id ?? null,
      language: input.language,
      cues: parent.cues.map(cue => ({ id: cue.id, text: cue.text, source_anchor: cue.source_anchor, timeline_range: cue.timeline_range })),
    })
    const serializedEvidence = JSON.stringify(evidence)
    const captionInputTokens = estimatedTextTokens(serializedEvidence)
    const usage: RemoteUsage = {
      requests: 1,
      total_tokens: captionInputTokens + VIDEO_REMOTE_USAGE_POLICY.captionTranslationOutputTokenReserve,
      input_bytes: Buffer.byteLength(serializedEvidence, 'utf8'),
      visual_frames: 0,
      proxy_seconds: 0,
      asr_seconds: 0,
      estimated_amount_micros: estimatedTextAmountMicros(captionInputTokens + VIDEO_REMOTE_USAGE_POLICY.captionTranslationOutputTokenReserve, VIDEO_REMOTE_USAGE_POLICY.captionTranslationFixedMicros),
    }
    const request: RelayOperationRequest = {
      local_operation_id: operation.id,
      consent_revision_id: consent.id,
      consent_scope_hash: factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds }),
      local_budget_reservation_id: budget.id,
      request_hash: factsBasisHash,
      capability: 'media_reasoning',
      application_role: 'caption_translation',
      input: {
        object_refs: [],
        facts_basis_hash: factsBasisHash,
        evidence,
        language: input.language,
        output_schema_version: 1,
      },
    }
    return { budgetId: budget.id, relay, request, usage }
  }

  async createCaptionDraft(
    projectId: string,
    raw: CreateVideoCaptionDraftInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; document: VideoStudioProject['caption_documents'][number]; revision: VideoStudioProject['caption_document_revisions'][number]; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoCaptionDraftInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'caption_draft', input })
      const replay = this.finishingReplay(project, 'caption_draft', idempotencyKey, requestHash)
      if (replay) {
        const document = project.caption_documents.find(candidate => candidate.id === replay[0])
        const revision = project.caption_document_revisions.find(candidate => candidate.id === replay[1])
        if (!document || !revision) throw new VideoWorkbenchServiceError('字幕幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        const task = await this.startFinishingOperation(project, 'video.caption_draft', idempotencyKey, requestHash, '生成字幕草稿')
        return {
          project,
          document,
          revision,
          task: task.status === 'succeeded' ? task : await this.completeFinishingOperation(task, '字幕草稿已按幂等请求复用', {
            caption_document_id: document.id,
            caption_revision_id: revision.id,
            caption_style_id: revision.style_id,
          }),
        }
      }
      const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === input.editorial_timeline_version_id)
      if (!timeline) throw new VideoWorkbenchServiceError('编辑时间线版本不存在', 404, 'VIDEO_TIMELINE_MISSING')
      const operation = await this.startFinishingOperation(project, 'video.caption_draft', idempotencyKey, requestHash, '生成字幕草稿')
      try {
        const { transcript, revision: activeRevision } = await this.captionTranscript(project.id, input.transcript_id, input.transcript_revision_id)
        const created = this.finishing.createCaptionDraft(project, timeline, transcript, activeRevision, input)
        const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          caption_styles: [...project.caption_styles, created.style],
          caption_documents: [...project.caption_documents, created.document],
          caption_document_revisions: [...project.caption_document_revisions, created.revision],
          finishing_receipts: [...project.finishing_receipts, this.finishingReceipt('caption_draft', idempotencyKey, requestHash, [created.document.id, created.revision.id])],
          revision: project.revision + 1,
          updated_at: this.iso(),
        }))
        const task = await this.completeFinishingOperation(operation, '字幕草稿已生成', {
          caption_document_id: created.document.id,
          caption_revision_id: created.revision.id,
          caption_style_id: created.style.id,
        })
        return { project: saved, document: created.document, revision: created.revision, task }
      } catch (error) {
        await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '字幕草稿生成失败').catch(() => undefined)
        return this.finishingError(error)
      }
    })
  }

  async createCaptionRevision(
    projectId: string,
    documentId: string,
    raw: CreateVideoCaptionRevisionInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; revision: VideoStudioProject['caption_document_revisions'][number]; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoCaptionRevisionInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'caption_revision', document_id: documentId, input })
      const replay = this.finishingReplay(project, 'caption_revision', idempotencyKey, requestHash)
      if (replay) {
        const revision = project.caption_document_revisions.find(candidate => candidate.id === replay[0])
        if (!revision) throw new VideoWorkbenchServiceError('字幕修订幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        const task = await this.startFinishingOperation(project, 'video.caption_draft', idempotencyKey, requestHash, '保存字幕修订')
        return {
          project,
          revision,
          task: task.status === 'succeeded' ? task : await this.completeFinishingOperation(task, '字幕修订已按幂等请求复用', {
            caption_document_id: documentId,
            caption_revision_id: revision.id,
            caption_style_id: revision.style_id,
          }),
        }
      }
      const document = project.caption_documents.find(candidate => candidate.id === documentId)
      const parent = document && project.caption_document_revisions.find(candidate => candidate.id === document.current_revision_id)
      const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === input.editorial_timeline_version_id)
      if (!document || !parent || !timeline) throw new VideoWorkbenchServiceError('字幕文档、修订或编辑时间线不存在', 404, 'VIDEO_FINISHING_INVALID')
      if (input.base_revision_id !== parent.id) throw new VideoWorkbenchServiceError('字幕修订已更新，请刷新后重试', 409, 'VIDEO_FINISHING_STALE')
      const operation = await this.startFinishingOperation(project, 'video.caption_draft', idempotencyKey, requestHash, '保存字幕修订')
      try {
        const { transcript } = await this.captionTranscript(project.id, parent.transcript_id, parent.transcript_revision_id)
        const revision = this.finishing.createCaptionRevision(project, document, parent, timeline, transcript, input)
        const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          caption_documents: project.caption_documents.map(candidate => candidate.id === document.id ? { ...candidate, current_revision_id: revision.id } : candidate),
          caption_document_revisions: [...project.caption_document_revisions, revision],
          finishing_receipts: [...project.finishing_receipts, this.finishingReceipt('caption_revision', idempotencyKey, requestHash, [revision.id])],
          revision: project.revision + 1,
          updated_at: this.iso(),
        }))
        const task = await this.completeFinishingOperation(operation, '字幕修订已保存', {
          caption_document_id: document.id,
          caption_revision_id: revision.id,
          caption_style_id: revision.style_id,
        })
        return { project: saved, revision, task }
      } catch (error) {
        await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '字幕修订保存失败').catch(() => undefined)
        return this.finishingError(error)
      }
    })
  }

  private async executeCaptionTranslation(
    project: VideoStudioProject,
    document: VideoStudioProject['caption_documents'][number],
    parent: VideoCaptionDocumentRevision,
    timeline: EditorialTimelineVersion,
    input: CreateVideoCaptionTranslationInput,
    operation: VideoOperation,
  ): Promise<{ project: VideoStudioProject; revision: VideoCaptionDocumentRevision; task: VideoOperation }> {
    const staged = this.stagedCaptionTranslationResult(operation)
    if (staged) return await this.finalizeStagedCaptionTranslationResult(operation)
    const remoteInput = await this.captionTranslationRemoteRequest(project, document, parent, timeline, input, operation)
    let stagedOperation: VideoOperation | undefined
    await this.reserveAndRunRemote(project.id, remoteInput.budgetId, 'media_reasoning', remoteInput.usage, remoteInput.relay, remoteInput.request, async (activeRelay, remote) => {
      if (remote.state !== 'succeeded' || !remote.provider_receipt) {
        throw new VideoMediaRelayClientError(remote.state === 'outcome_unknown' ? 503 : 422, 'relay_operation_not_succeeded')
      }
      await this.settleRemoteBudget(project.id, remoteInput.budgetId, operation.id, remote.provider_receipt)
      const downloaded = await activeRelay.downloadResult<unknown>(remote)
      if (!downloaded.result || typeof downloaded.result !== 'object' || Array.isArray(downloaded.result)) {
        throw new VideoWorkbenchServiceError('远程字幕翻译结果类型无效', 502, 'VIDEO_FINISHING_INVALID')
      }
      const remoteResult = downloaded.result as Record<string, unknown>
      if (remoteResult.kind !== 'caption_translation') {
        throw new VideoWorkbenchServiceError('远程字幕翻译结果类型无效', 502, 'VIDEO_FINISHING_INVALID')
      }
      const translated = videoCaptionTranslationResultSchema.safeParse({ translations: remoteResult.translations })
      if (!translated.success) {
        throw new VideoWorkbenchServiceError('远程字幕翻译结果结构无效', 502, 'VIDEO_FINISHING_INVALID')
      }
      const byCueId = new Map<string, string>()
      for (const item of translated.data.translations) {
        if (byCueId.has(item.cue_id)) {
          throw new VideoWorkbenchServiceError('远程字幕翻译包含重复 Cue', 502, 'VIDEO_FINISHING_INVALID')
        }
        byCueId.set(item.cue_id, item.text)
      }
      if (
        byCueId.size !== parent.cues.length
        || parent.cues.some(cue => !byCueId.has(cue.id))
      ) throw new VideoWorkbenchServiceError('远程字幕翻译未覆盖当前字幕修订的全部 Cue', 502, 'VIDEO_FINISHING_INVALID')
      const { transcript } = await this.captionTranscript(project.id, parent.transcript_id, parent.transcript_revision_id)
      const revision = this.finishing.createCaptionRevision(project, document, parent, timeline, transcript, {
        language: input.language,
        ...(input.style_id ? { style_id: input.style_id } : {}),
        cues: parent.cues.map(cue => ({
          source_anchor: cue.source_anchor,
          // The finishing layer deliberately discards this client/Relay echo
          // and reprojects it from the immutable source anchor.
          timeline_range: cue.timeline_range,
          text: byCueId.get(cue.id)!,
          translation_of_cue_id: cue.id,
          alignment_confidence: cue.alignment_confidence,
          alignment_state: cue.alignment_state,
        })),
      })
      stagedOperation = await this.stageCaptionTranslationResult(
        operation.id,
        revision,
        this.acknowledgementFor(operation.id, remote.id, remote.provider_receipt.id, downloaded.hashes),
      )
    }, { parentOperationId: operation.id })
    const ready = stagedOperation ?? await this.repository.getOperation(operation.id)
    if (!this.stagedCaptionTranslationResult(ready)) {
      throw new VideoWorkbenchServiceError('远程字幕翻译未形成可恢复候选', 502, 'VIDEO_FINISHING_INVALID')
    }
    return await this.finalizeStagedCaptionTranslationResult(ready)
  }

  async createCaptionTranslation(
    projectId: string,
    documentId: string,
    raw: CreateVideoCaptionTranslationInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; revision: VideoCaptionDocumentRevision; task: VideoOperation }> {
    const setup = await this.mutateProject(projectId, async () => {
      const input = createVideoCaptionTranslationInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'caption_translation', model: VIDEO_REMOTE_MODEL_BINDINGS.mediaReasoning, prompt_version: 'caption-translation-v1', document_id: documentId, input })
      const replay = this.finishingReplay(project, 'caption_translation', idempotencyKey, requestHash)
      if (replay) {
        const revision = project.caption_document_revisions.find(candidate => candidate.id === replay[0])
        if (!revision || revision.document_id !== documentId) {
          throw new VideoWorkbenchServiceError('字幕翻译幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        }
        const task = await this.startFinishingOperation(project, 'video.caption_translation', idempotencyKey, requestHash, '生成字幕翻译候选')
        return { replay: true as const, project, revision, task }
      }
      const document = project.caption_documents.find(candidate => candidate.id === documentId)
      const parent = document && project.caption_document_revisions.find(candidate => candidate.id === input.base_revision_id)
      const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === input.editorial_timeline_version_id)
      if (!document || !parent || !timeline) throw new VideoWorkbenchServiceError('字幕文档、修订或编辑时间线不存在', 404, 'VIDEO_FINISHING_INVALID')
      if (
        document.project_id !== project.id
        || parent.project_id !== project.id
        || parent.document_id !== document.id
        || document.current_revision_id !== parent.id
        || parent.editorial_timeline_version_id !== timeline.id
        || project.current_editorial_timeline_version_id !== timeline.id
      ) throw new VideoWorkbenchServiceError('字幕翻译基础版本已更新，请刷新后重试', 409, 'VIDEO_FINISHING_STALE')
      if (input.style_id && !project.caption_styles.some(style => style.id === input.style_id)) {
        throw new VideoWorkbenchServiceError('字幕翻译指定的样式不存在', 400, 'VIDEO_FINISHING_INVALID')
      }
      const initial = await this.startFinishingOperation(project, 'video.caption_translation', idempotencyKey, requestHash, '生成字幕翻译候选')
      const context: CaptionTranslationOperationInput = {
        document_id: document.id,
        base_revision_id: parent.id,
        editorial_timeline_version_id: timeline.id,
        language: input.language,
        ...(input.style_id ? { style_id: input.style_id } : {}),
      }
      const persisted = this.captionTranslationInput(initial)
      if (persisted && JSON.stringify(persisted) !== JSON.stringify(context)) {
        throw new VideoWorkbenchServiceError('字幕翻译任务与幂等请求不一致', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
      }
      const operation = persisted
        ? initial
        : await this.repository.saveOperation(this.operation({
            ...initial,
            result: { ...(initial.result ?? {}), caption_translation: context },
          }))
      return { replay: false as const, project, document, parent, timeline, input, operation, requestHash }
    })
    if (setup.replay) {
      const task = setup.task.status === 'succeeded'
        ? setup.task
        : await this.completeFinishingOperation(setup.task, '字幕翻译候选已按幂等请求复用', {
            caption_document_id: documentId,
            caption_revision_id: setup.revision.id,
            caption_style_id: setup.revision.style_id,
          })
      return { project: setup.project, revision: setup.revision, task }
    }
    try {
      return await this.executeCaptionTranslation(
        setup.project,
        setup.document,
        setup.parent,
        setup.timeline,
        setup.input,
        setup.operation,
      )
    } catch (error) {
      const current = await this.repository.getOperation(setup.operation.id).catch(() => null)
      // A surviving submission fence or staged candidate is the only authority
      // after an uncertain transport outcome. Leave it enumerable for startup
      // recovery instead of marking it failed and allowing a new paid call.
      if (current && !this.remoteRecoveryCheckpoint(current) && !this.stagedCaptionTranslationResult(current) && current.status !== 'succeeded') {
        await this.failOperation(current, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '字幕翻译候选生成失败').catch(() => undefined)
      }
      return this.finishingError(error)
    }
  }

  async createCompositionPlan(
    projectId: string,
    raw: CreateVideoCompositionPlanInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; plan: VideoStudioProject['composition_plans'][number]; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoCompositionPlanInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'composition_plan', input })
      const replay = this.finishingReplay(project, 'composition_plan', idempotencyKey, requestHash)
      if (replay) {
        const plan = project.composition_plans.find(candidate => candidate.id === replay[0])
        if (!plan) throw new VideoWorkbenchServiceError('构图计划幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        const task = await this.startFinishingOperation(project, 'video.composition_plan', idempotencyKey, requestHash, '生成构图计划')
        return {
          project,
          plan,
          task: task.status === 'succeeded' ? task : await this.completeFinishingOperation(task, '构图计划已按幂等请求复用', { composition_plan_id: plan.id }),
        }
      }
      const context = this.deliveryVariantContext(project, input.variant_id, input.base_variant_version_id)
      const operation = await this.startFinishingOperation(project, 'video.composition_plan', idempotencyKey, requestHash, '生成构图计划')
      try {
        const evidence = (await this.repository.listFacts('evidence', project.id))
          .filter((fact): fact is VideoFactEvidence => 'payload' in fact)
        const plan = this.finishing.createCompositionPlan(project, context.variant, context.version, context.timeline, context.profile, evidence)
        const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          composition_plans: [...project.composition_plans, plan],
          finishing_receipts: [...project.finishing_receipts, this.finishingReceipt('composition_plan', idempotencyKey, requestHash, [plan.id])],
          revision: project.revision + 1,
          updated_at: this.iso(),
        }))
        const task = await this.completeFinishingOperation(operation, '构图计划已生成', { composition_plan_id: plan.id })
        return { project: saved, plan, task }
      } catch (error) {
        await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '构图计划生成失败').catch(() => undefined)
        return this.finishingError(error)
      }
    })
  }

  /** Audio suggestions are anchored only to the current, immutable Transcript
   * projection.  A repository/read error is deliberately propagated so an
   * unavailable fact cannot turn into an unreviewable semantic recommendation. */
  private async audioTranscriptAnchors(project: VideoStudioProject): Promise<AudioTranscriptAnchor[]> {
    const transcripts = (await this.repository.listFacts('transcript', project.id))
      .filter((fact): fact is TimedTranscript => 'segments' in fact)
    const anchors: AudioTranscriptAnchor[] = []
    for (const transcript of transcripts) {
      const source = project.sources.find(candidate => candidate.id === transcript.source_id)
      if (!source || source.fingerprint !== transcript.source_fingerprint || source.missing || source.content_changed) continue
      const active = await this.repository.facts.activeTranscriptRevision(transcript.id)
      if (active && (!('transcript_id' in active) || !('edits' in active)
        || active.project_id !== project.id || active.transcript_id !== transcript.id)) {
        throw new FinishingDeliveryValidationError('活动 Transcript Revision 不属于当前项目，拒绝生成语义音频建议', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const projection = materializeTranscriptRevision(transcript, active as TranscriptRevision | undefined)
      for (const segment of projection.segments) {
        const transcriptAnchorIds = [...new Set([...segment.anchor_segment_ids, ...segment.word_ids])]
        if (!transcriptAnchorIds.length) continue
        anchors.push({
          transcript_id: transcript.id,
          source_id: transcript.source_id,
          source_range: sourceTimeRange(segment.start, segment.duration),
          transcript_anchor_ids: transcriptAnchorIds,
          text: segment.text,
        })
      }
    }
    return anchors
  }

  /** Frozen filters must exist locally; execution never substitutes a best-effort approximation. */
  private async assertExecutionFiltersSupported(
    filters: ReadonlyArray<{ kind: string }>,
    needsHdrToneMap = false,
    needsBurnInSubtitles = false,
  ): Promise<void> {
    const needsDenoise = filters.some(filter => filter.kind === 'set_audio_denoise' || filter.kind === 'audio_denoise')
    if (!needsDenoise && !needsHdrToneMap && !needsBurnInSubtitles) return
    let listed: { exitCode: number; stdout: string; stderr: string }
    try {
      listed = await this.runProcess([videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-filters'])
    } catch {
      throw new FinishingDeliveryValidationError('无法确认 FFmpeg 完成滤镜能力，拒绝编译正式交付', 'VIDEO_FINISHING_UNAVAILABLE')
    }
    const available = `${listed.stdout}\n${listed.stderr}`
    if (listed.exitCode !== 0 || (needsDenoise && !/\bafftdn\b/i.test(available))) {
      throw new FinishingDeliveryValidationError('当前 FFmpeg 不支持冻结音频计划所需的 afftdn 降噪滤镜', 'VIDEO_FINISHING_UNAVAILABLE')
    }
    if (needsHdrToneMap && (!/\bzscale\b/i.test(available) || !/\btonemap\b/i.test(available))) {
      throw new FinishingDeliveryValidationError('当前 FFmpeg 不支持 HDR 转 SDR 所需的 zscale/tonemap 滤镜', 'VIDEO_FINISHING_UNAVAILABLE')
    }
    if (needsBurnInSubtitles && !/\bsubtitles\b/i.test(available)) {
      throw new FinishingDeliveryValidationError('当前 FFmpeg 不支持烧录字幕所需的 subtitles 滤镜', 'VIDEO_FINISHING_UNAVAILABLE')
    }
    if (needsBurnInSubtitles) await this.assertControlledCaptionBurnInRuntime()
  }

  /**
   * The Relay image proves its own startup environment before it serves
   * requests, but a Sidecar may execute the frozen plan on another machine.
   * Check the executor that will actually burn the subtitles instead of
   * treating Gateway or Relay readiness as a local renderer capability.
   */
  private async assertControlledCaptionBurnInRuntime(): Promise<void> {
    const fontDirectory = this.controlledCaptionFontDirectory()
    const fontFile = join(fontDirectory, CONTROLLED_CAPTION_FONT_FILE)
    let probeDirectory: string | undefined
    try {
      const [directory, font] = await Promise.all([
        stat(fontDirectory),
        stat(fontFile),
      ])
      if (!directory.isDirectory() || !font.isFile() || font.size <= 0) {
        throw new FinishingDeliveryValidationError('受控字幕字体目录或字体文件不可用，不能安全烧录字幕', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      let scanned: { exitCode: number; stdout: string; stderr: string }
      try {
        // Inspect the reviewed file itself rather than asking fontconfig to
        // resolve a family from a host-wide registry, which can hide a wrong
        // font behind a same-name fallback.
        scanned = await this.runProcess(['fc-scan', '-f', '%{family}\n', fontFile])
      } catch {
        throw new FinishingDeliveryValidationError('无法确认受控字幕字体族，不能安全烧录字幕', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const families = `${scanned.stdout}\n${scanned.stderr}`.split(/\r?\n/).map(value => value.trim())
      if (scanned.exitCode !== 0 || !families.includes(CONTROLLED_CAPTION_FONT_FAMILY)) {
        throw new FinishingDeliveryValidationError('受控字幕字体族与交付计划不匹配，不能安全烧录字幕', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      probeDirectory = await mkdtemp(join(tmpdir(), 'billiardbuddy-caption-runtime-'))
      const subtitlePath = join(probeDirectory, 'probe.srt')
      await writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:00,040\n中文字幕测试\n', { mode: 0o600 })
      const rendered = await this.runProcess([
        videoBinary('ffmpeg', this.env, this.platform),
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25:d=0.04',
        '-vf', `subtitles=filename='${ffmpegFilterValue(subtitlePath)}':fontsdir='${ffmpegFilterValue(fontDirectory)}':force_style='FontName=${CONTROLLED_CAPTION_FONT_FAMILY},FontSize=24,Alignment=2'`,
        '-frames:v', '1', '-f', 'null', '-',
      ])
      if (rendered.exitCode !== 0) {
        throw new FinishingDeliveryValidationError('受控字幕字体无法由当前 FFmpeg 实际烧录，不能安全交付', 'VIDEO_FINISHING_UNAVAILABLE')
      }
    } catch (error) {
      if (error instanceof FinishingDeliveryValidationError || error instanceof VideoWorkbenchServiceError) throw error
      throw new FinishingDeliveryValidationError('无法验证受控字幕烧录运行时，不能安全交付', 'VIDEO_FINISHING_UNAVAILABLE')
    } finally {
      if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** A frozen afftdn command must be executable by the local FFmpeg, never silently dropped. */
  async assertAudioFiltersSupported(filters: ReadonlyArray<{ kind: string }>): Promise<void> {
    await this.assertExecutionFiltersSupported(filters)
  }

  private async assertExecutionPlanFiltersSupported(plan: VideoExecutionPlan): Promise<void> {
    const needsHdrToneMap = plan.inputs.some(input => input.video_color?.hdr_kind === 'pq' || input.video_color?.hdr_kind === 'hlg')
    await this.assertExecutionFiltersSupported(plan.filters, needsHdrToneMap, plan.caption?.mode === 'burn_in')
  }

  private async audioMeasurements(project: VideoStudioProject, timeline: EditorialTimelineVersion): Promise<AudioMeasurement[]> {
    const measurements: AudioMeasurement[] = []
    const seen = new Set<string>()
    for (const item of timeline.items) {
      const binding = item.binding
      if (item.kind !== 'audio' || binding.kind !== 'source' || seen.has(item.id)) continue
      seen.add(item.id)
      const source = project.sources.find(candidate => candidate.id === binding.source_id)
      if (!source?.has_audio || source.missing || source.content_changed) continue
      let sourceFact: Awaited<ReturnType<VideoWorkbenchRepository['getFact']>>
      try {
        sourceFact = await this.repository.getFact('source', source.id)
      } catch {
        throw new FinishingDeliveryValidationError('无法读取源音频流事实，已拒绝响度分析', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      if (!('fast_identity' in sourceFact)
        || sourceFact.id !== source.id
        || sourceFact.project_id !== project.id) {
        throw new FinishingDeliveryValidationError('源音频流事实缺失或无效，已拒绝响度分析', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const audio = sourceFact.audio_tracks.find(track => track.disposition_default) ?? sourceFact.audio_tracks[0]
      if (!audio?.duration
        || compareRationalTime(binding.source_range.start, audio.start_time) < 0
        || compareRationalTime(endOfRange(binding.source_range), endOfRange({ start: audio.start_time, duration: audio.duration })) > 0) {
        throw new FinishingDeliveryValidationError('源音频轨范围无法验证，已拒绝响度分析', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const startSeconds = rationalSecondsBetween(audio.start_time, binding.source_range.start)
      const durationSeconds = rationalSecondsBetween(binding.source_range.start, endOfRange(binding.source_range))
      if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new FinishingDeliveryValidationError('源音频轨时间戳无效，已拒绝响度分析', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const seekAt = Number(parseInt64(rescaleRationalTime(binding.source_range.start, MICROSECOND_TICK_RATE, 'nearest').ticks)) / MICROSECOND_TICK_RATE.num
      if (!Number.isFinite(seekAt) || seekAt < 0) {
        throw new FinishingDeliveryValidationError('源音频 PTS 不能安全映射为本地分析 seek 位置', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const base = [videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-nostdin', '-ss', seekAt.toFixed(6), '-t', durationSeconds.toFixed(6), '-i', source.path, '-map', `0:${audio.stream_index}`]
      const [loudness, silence] = await Promise.all([
        this.runProcess([...base, '-filter:a', 'ebur128=peak=true', '-f', 'null', '-']),
        this.runProcess([...base, '-af', 'silencedetect=noise=-45dB:d=0.30', '-f', 'null', '-']),
      ])
      if (loudness.exitCode !== 0 || silence.exitCode !== 0) {
        throw new FinishingDeliveryValidationError('无法完成本地响度或静音分析', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const lufs = [...loudness.stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/gi)].at(-1)?.[1]
      const peak = [...loudness.stderr.matchAll(/\b(?:Peak|True peak):\s*(-?\d+(?:\.\d+)?)/gi)].at(-1)?.[1]
      const silentSeconds = [...silence.stderr.matchAll(/silence_duration:\s*(\d+(?:\.\d+)?)/gi)]
        .reduce((total, match) => total + Number(match[1] ?? 0), 0)
      const sourceRange = sourceTimeRange(binding.source_range.start, binding.source_range.duration)
      measurements.push({
        item_id: item.id,
        source_id: source.id,
        audio_stream_index: audio.stream_index,
        source_range: sourceRange,
        receipt_id: `audio_receipt_${randomUUID().replaceAll('-', '')}`,
        ...(lufs && Number.isFinite(Number(lufs)) ? { integrated_lufs: Number(lufs) } : {}),
        ...(peak && Number.isFinite(Number(peak)) ? { true_peak_db: Number(peak) } : {}),
        silence_ratio: Math.max(0, Math.min(1, silentSeconds / durationSeconds)),
        silence_ranges: silencedetectRanges(`${silence.stdout}\n${silence.stderr}`, sourceRange),
      })
    }
    return measurements
  }

  async createAudioFinishingPlan(
    projectId: string,
    raw: CreateVideoAudioFinishingPlanInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; plan: VideoStudioProject['audio_finishing_plans'][number]; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoAudioFinishingPlanInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'audio_finishing_plan', input })
      const replay = this.finishingReplay(project, 'audio_finishing_plan', idempotencyKey, requestHash)
      if (replay) {
        const plan = project.audio_finishing_plans.find(candidate => candidate.id === replay[0])
        if (!plan) throw new VideoWorkbenchServiceError('音频完成计划幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        const task = await this.startFinishingOperation(project, 'video.audio_finish_plan', idempotencyKey, requestHash, '生成音频完成计划')
        return {
          project,
          plan,
          task: task.status === 'succeeded' ? task : await this.completeFinishingOperation(task, '音频完成计划已按幂等请求复用', { audio_finishing_plan_id: plan.id }),
        }
      }
      const context = this.deliveryVariantContext(project, input.variant_id, input.base_variant_version_id)
      const operation = await this.startFinishingOperation(project, 'video.audio_finish_plan', idempotencyKey, requestHash, '生成音频完成计划')
      try {
        const plan = this.finishing.createAudioFinishingPlan(
          project,
          context.variant,
          context.version,
          context.timeline,
          await this.audioMeasurements(project, context.timeline),
          await this.audioTranscriptAnchors(project),
        )
        await this.assertAudioFiltersSupported(plan.proposed_commands)
        const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          audio_finishing_plans: [...project.audio_finishing_plans, plan],
          finishing_receipts: [...project.finishing_receipts, this.finishingReceipt('audio_finishing_plan', idempotencyKey, requestHash, [plan.id])],
          revision: project.revision + 1,
          updated_at: this.iso(),
        }))
        const task = await this.completeFinishingOperation(operation, '音频完成计划已生成', { audio_finishing_plan_id: plan.id })
        return { project: saved, plan, task }
      } catch (error) {
        await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '音频完成计划生成失败').catch(() => undefined)
        return this.finishingError(error)
      }
    })
  }

  async preflightDeliveryVariant(
    projectId: string,
    variantId: string,
    raw: PreflightVideoVariantInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; plan: VideoStudioProject['execution_plans'][number]; report: VideoQualityReport; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = preflightVideoVariantInputSchema.parse(raw)
      let project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'quality_preflight', variant_id: variantId, input })
      const replay = this.finishingReplay(project, 'quality_preflight', idempotencyKey, requestHash)
      if (replay) {
        const context = this.deliveryVariantContext(project, variantId, input.base_variant_version_id)
        const plan = project.execution_plans.find(candidate => candidate.id === replay[0])
        const report = project.quality_reports.find(candidate => candidate.id === replay[1])
        if (!plan || !report) throw new VideoWorkbenchServiceError('预检幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        if (report.kind !== 'preflight'
          || report.editorial_timeline_version_id !== context.timeline.id
          || report.delivery_variant_version_id !== context.version.id
          || report.export_profile_revision_id !== context.profile.id
          || plan.editorial_timeline_version_id !== context.timeline.id
          || plan.delivery_variant_version_id !== context.version.id
          || plan.encoder.id !== context.profile.id
          || plan.encoder.content_hash !== context.profile.content_hash) {
          throw new VideoWorkbenchServiceError('预检幂等记录引用的交付版本已过期，请重新预检', 409, 'VIDEO_FINISHING_STALE')
        }
        const task = await this.startFinishingOperation(project, 'video.quality_preflight', idempotencyKey, requestHash, '交付预检')
        return {
          project,
          plan,
          report,
          task: task.status === 'succeeded' ? task : await this.completeFinishingOperation(task, '交付预检已按幂等请求复用', {
            execution_plan_id: plan.id,
            report_id: report.id,
            report,
          }),
        }
      }
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再预检', 409, 'VIDEO_REVISION_CONFLICT')
      const context = this.deliveryVariantContext(project, variantId, input.base_variant_version_id)
      const operation = await this.startFinishingOperation(project, 'video.quality_preflight', idempotencyKey, requestHash, '交付预检')
      try {
        const compiled = this.editorial.compile(project, context.variant.id, await this.editorialSourceBounds(project))
        await this.assertExecutionPlanFiltersSupported(compiled.plan)
        const projectAssets = await this.deliveryProjectAssets(compiled.project, compiled.plan)
        let encoder: Awaited<ReturnType<typeof selectDeliveryVideoEncoder>>
        try {
          // Preflight must verify the exact frozen delivery Profile.  The
          // legacy MPEG-4 fallback is valid only for old previews and would
          // otherwise defer a missing libx264/prores_ks error until render.
          encoder = await selectDeliveryVideoEncoder(this.runProcess, this.env, this.platform, compiled.plan.encoder)
        } catch (error) {
          throw new FinishingDeliveryValidationError(
            error instanceof Error ? error.message : '无法确认正式交付编码器能力',
            'VIDEO_FINISHING_UNAVAILABLE',
          )
        }
        // Build argv during preflight as a fail-closed compiler validation.
        // No process is launched and no output path is accepted from clients.
        buildExecutionPlanRenderCommand(
          videoBinary('ffmpeg', this.env, this.platform),
          compiled.project,
          compiled.plan,
          join(this.repository.paths().root, '.preflight-validation-output'),
          encoder,
          {
            ...(compiled.plan.caption?.mode === 'burn_in' ? { burnInCaptionPath: 'frozen-caption.srt' } : {}),
            ...(compiled.plan.caption?.mode === 'burn_in' ? { burnInCaptionFontDirectory: this.controlledCaptionFontDirectory() } : {}),
            ...(projectAssets.size ? { projectAssets } : {}),
          },
        )
        const report = this.finishing.createPreflightReport({
          project: compiled.project,
          version: context.version,
          timeline: context.timeline,
          profile: context.profile,
          executionPlanId: compiled.plan.id,
        })
        project = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...compiled.project,
          quality_reports: [...compiled.project.quality_reports, report],
          finishing_receipts: [...compiled.project.finishing_receipts, this.finishingReceipt('quality_preflight', idempotencyKey, requestHash, [compiled.plan.id, report.id])],
          revision: project.revision + 1,
          updated_at: this.iso(),
        }))
        const task = await this.completeFinishingOperation(operation, report.state === 'passed' ? '交付预检通过' : '交付预检需要处理', {
          execution_plan_id: compiled.plan.id,
          report_id: report.id,
          report,
        })
        return { project, plan: compiled.plan, report, task }
      } catch (error) {
        await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '交付预检失败').catch(() => undefined)
        if (error instanceof FinishingDeliveryValidationError) return this.finishingError(error)
        return this.editorialError(error)
      }
    })
  }

  async getQualityReport(projectId: string, reportId: string): Promise<VideoQualityReport> {
    const project = await this.requireVideoProject(projectId)
    const report = project.quality_reports.find(candidate => candidate.id === reportId)
    if (!report) throw new VideoWorkbenchServiceError('质量报告不存在', 404, 'VIDEO_QUALITY_REPORT_NOT_FOUND')
    return report
  }

  /** Decode only a mono PCM stream and feed the local detector incrementally. */
  async analyzeVideoBeat(
    projectId: string,
    raw: AnalyzeVideoBeatInput,
    idempotencyKey: string,
  ): Promise<VideoOperation> {
    return await this.mutateProject(projectId, async () => {
      const input = analyzeVideoBeatInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'beat_analyze', input })
      const existing = (await this.repository.listOperations(project.id))
        .find(candidate => candidate.kind === 'video.beat_analyze' && candidate.idempotency_key === idempotencyKey)
      if (existing) {
        if (existing.result?.request_hash !== requestHash) {
          throw new VideoWorkbenchServiceError('同一幂等键不能分析不同的节拍素材', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
        }
        return existing
      }
      const source = project.sources.find(candidate => candidate.id === input.source_id)
      if (!source || source.missing || source.content_changed) throw new VideoWorkbenchServiceError('节拍分析素材不可用', 404, 'VIDEO_SOURCE_NOT_FOUND')
      const sourceFact = await this.repository.getFact('source', source.id).catch(() => null)
      if (!sourceFact || !('fast_identity' in sourceFact) || !sourceFact.fingerprint) {
        throw new VideoWorkbenchServiceError('素材原始流事实未就绪，不能安全分析节拍', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      if (!sourceFact.primary_video_stream.duration) {
        throw new VideoWorkbenchServiceError('素材原始视频流时长缺失，不能安全分析节拍', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      const defaultAudio = sourceFact.audio_tracks.find(track => track.disposition_default) ?? sourceFact.audio_tracks[0]
      const audioStreamIndex = input.audio_stream_index ?? defaultAudio?.stream_index
      if (!Number.isSafeInteger(audioStreamIndex) || !sourceFact.audio_tracks.some(track => track.stream_index === audioStreamIndex)) {
        throw new VideoWorkbenchServiceError('所选素材没有可分析的音频轨', 422, 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const sourceCacheKey = factBasisHash({
        analyzer_version: 'local-energy-v2',
        source_id: source.id,
        source_fingerprint: sourceFact.fingerprint,
        audio_stream_index: audioStreamIndex,
        primary_video_range: sourceTimeRange(sourceFact.primary_video_stream.start_time, sourceFact.primary_video_stream.duration),
        sample_rate: 22_050,
      })
      const cached = (await this.repository.listFacts('evidence', project.id))
        .find((fact): fact is Extract<VideoFactEvidence, { kind: 'beat_grid' }> => 'payload' in fact
          && fact.kind === 'beat_grid'
          && fact.source_id === source.id
          && fact.source_fingerprint === sourceFact.fingerprint
          && fact.payload.source_cache_key === sourceCacheKey)
      if (cached) {
        return await this.repository.saveOperation(this.operation({
          schema_version: 1,
          id: id('task'),
          project_id: project.id,
          kind: 'video.beat_analyze',
          status: 'succeeded',
          progress: 100,
          stage: '已复用相同素材的本地节拍网格',
          idempotency_key: idempotencyKey,
          result: {
            request_hash: requestHash,
            source_id: source.id,
            audio_stream_index: audioStreamIndex,
            evidence_id: cached.id,
            confidence: cached.payload.confidence,
            ...(cached.payload.bpm ? { bpm: cached.payload.bpm } : {}),
          },
          created_at: this.iso(),
          updated_at: this.iso(),
        } as unknown as VideoOperation))
      }
      const operation = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.beat_analyze',
        status: 'queued',
        progress: 0,
        stage: '等待本地节拍分析',
        idempotency_key: idempotencyKey,
        result: { request_hash: requestHash, source_id: source.id, audio_stream_index: audioStreamIndex },
        created_at: this.iso(),
        updated_at: this.iso(),
      } as unknown as VideoOperation))
      const controller = new AbortController()
      const active: ActiveVideoExecution = { controller, completion: Promise.resolve(), output_path: '' }
      const readySource = sourceFact as VideoFactSource & { fingerprint: `sha256:${string}` }
      active.completion = Promise.resolve().then(async () => await this.runBeatAnalysis(project, operation, readySource, audioStreamIndex, controller.signal))
      this.activeAnalyses.set(operation.id, active)
      return operation
    })
  }

  /**
   * Turn trusted local BeatGrid evidence into a reviewable TimelineDraft.
   * It only adds edit boundaries; it never deletes footage or commits a new
   * Timeline Version until the user accepts the normal CommandSet flow.
   */
  async createBeatSyncTimelineDraft(
    projectId: string,
    raw: CreateVideoBeatSyncDraftInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; draft: TimelineDraft; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoBeatSyncDraftInputSchema.parse(raw)
      let project = await this.prepareEditorialProject(projectId)
      const current = this.editorial.currentTimeline(project)
      if (current.id !== input.base_timeline_version_id) {
        throw new VideoWorkbenchServiceError('编辑时间线已更新，请基于当前版本重新生成 Beat Sync 草稿', 409, 'VIDEO_EDITORIAL_STALE')
      }
      if (current.tracks.some(track => track.locked) || current.items.some(item => item.locked)) {
        throw new VideoWorkbenchServiceError('时间线含有锁定轨道或条目，不能生成会替换结构的 Beat Sync 草稿', 409, 'VIDEO_EDITORIAL_LOCKED')
      }
      const requestHash = factBasisHash({ kind: 'beat_sync_draft', input })
      const replay = this.finishingReplay(project, 'beat_sync_draft', idempotencyKey, requestHash)
      if (replay) {
        const draft = project.timeline_drafts.find(candidate => candidate.id === replay[0])
        if (!draft) throw new VideoWorkbenchServiceError('Beat Sync 草稿幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        if (!await this.isBeatSyncDraftCurrent(project, draft) || draft.base_timeline_version_id !== current.id) {
          throw new VideoWorkbenchServiceError('原 BeatGrid 或时间线已过期，请重新生成 Beat Sync 草稿', 409, 'VIDEO_EDITORIAL_STALE')
        }
        const task = await this.startFinishingOperation(project, 'video.beat_sync_draft', idempotencyKey, requestHash, '生成 Beat Sync 草稿')
        return {
          project,
          draft,
          task: task.status === 'succeeded'
            ? task
            : await this.completeFinishingOperation(task, 'Beat Sync 草稿已按幂等请求复用', { timeline_draft_id: draft.id, evidence_id: input.beat_evidence_id }),
        }
      }
      const source = project.sources.find(candidate => candidate.id === input.source_id)
      if (!source || source.missing || source.content_changed || !source.fingerprint) {
        throw new VideoWorkbenchServiceError('Beat Sync 素材不可用', 404, 'VIDEO_SOURCE_NOT_FOUND')
      }
      const rawEvidence = await this.repository.getFact('evidence', input.beat_evidence_id).catch(() => null)
      if (!rawEvidence || !('payload' in rawEvidence) || rawEvidence.kind !== 'beat_grid'
        || rawEvidence.source_id !== source.id || rawEvidence.source_fingerprint !== source.fingerprint) {
        throw new VideoWorkbenchServiceError('BeatGrid 不属于当前素材或不存在', 422, 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const beatEvidence = rawEvidence
      const beatTimes = beatEvidence.payload.beats.length
        ? beatEvidence.payload.beats.map(point => point.at)
        : beatEvidence.payload.beat_times
      if (beatEvidence.payload.confidence < 0.65 || beatTimes.length < 4 || !beatEvidence.payload.coverage.length) {
        throw new VideoWorkbenchServiceError('BeatGrid 置信度或覆盖不足，已降级为普通剪辑，不能生成 Beat Sync 草稿', 422, 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const tracks = new Map(current.tracks.map(track => [track.id, track]))
      const affected = current.items.filter(item => item.binding.kind === 'source'
        && item.binding.source_id === source.id
        && (tracks.get(item.track_id)?.kind === 'primary_video' || tracks.get(item.track_id)?.kind === 'source_audio'))
      const primaryItems = affected.filter(item => tracks.get(item.track_id)?.kind === 'primary_video')
      // Beat evidence is measured in the primary-video PTS domain.  Audio
      // may legitimately begin at another PTS and is paired from timeline
      // cuts below, so requiring its absolute range here rejects valid media.
      if (!primaryItems.length || primaryItems.some(item => item.binding.kind !== 'source' || !sourceRangeCoveredBy(
        beatEvidence.payload.coverage,
        sourceTimeRange(item.binding.source_range.start, item.binding.source_range.duration),
      ))) {
        throw new VideoWorkbenchServiceError('BeatGrid 未覆盖当前 A/V 剪辑范围，不能安全生成 Beat Sync 草稿', 422, 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const operation = await this.startFinishingOperation(project, 'video.beat_sync_draft', idempotencyKey, requestHash, '生成 Beat Sync 草稿')
      try {
        const orderedBeats = [...beatTimes].sort((left, right) => compareRationalTime(left, right))
        let cutCount = 0
        const cutsByPrimaryLink = new Map<string, RationalTime[]>()
        const linkedGroupsByPrimaryLink = new Map<string, string[]>()
        for (const item of primaryItems) {
          const key = beatSyncAvLinkKey(item)
          if (!key) continue
          const cuts = beatSplitPoints(item, orderedBeats, input.minimum_cut_interval_ms)
          cutsByPrimaryLink.set(key, cuts)
          if (cuts.length) linkedGroupsByPrimaryLink.set(key, Array.from({ length: cuts.length + 1 }, () => id('av_group')))
          cutCount += cuts.length
        }
        const items = current.items.flatMap(item => {
          if (item.binding.kind !== 'source' || item.binding.source_id !== source.id) return [structuredClone(item)]
          const track = tracks.get(item.track_id)
          if (track?.kind !== 'primary_video' && track?.kind !== 'source_audio') return [structuredClone(item)]
          const key = beatSyncAvLinkKey(item)
          const primaryCuts = key ? cutsByPrimaryLink.get(key) : undefined
          const linkedGroups = key ? linkedGroupsByPrimaryLink.get(key) : undefined
          if (track.kind === 'primary_video') return splitItemOnBeats(item, primaryCuts ?? [], linkedGroups)
          const pairedVideo = primaryItems.find(candidate => beatSyncAvLinkKey(candidate) === key)
          if (!pairedVideo || !primaryCuts) {
            throw new FinishingDeliveryValidationError('Beat Sync 找不到源音频对应的主视频 A/V link', 'VIDEO_FINISHING_UNAVAILABLE')
          }
          return splitItemOnBeats(item, pairedAudioBeatSplitPoints(pairedVideo, item, primaryCuts), linkedGroups)
        })
        if (!cutCount) {
          throw new FinishingDeliveryValidationError('当前时间线没有能在可信节拍处增加的剪辑边界', 'VIDEO_FINISHING_UNAVAILABLE')
        }
        const draft = timelineDraftSchema.parse({
          id: id('draft'),
          project_id: project.id,
          facts_basis_hash: editorialFactsBasisHash(project),
          base_timeline_version_id: current.id,
          planning_origin: 'local_conservative',
          plan_ids: [beatEvidence.id],
          beat_sync: {
            evidence_id: beatEvidence.id,
            source_id: source.id,
            source_fingerprint: source.fingerprint,
            analyzer_version: beatEvidence.payload.analyzer_version,
            facts_basis_hash: beatEvidence.basis_hash,
          },
          tracks: structuredClone(current.tracks),
          items,
          status: 'proposed',
          created_at: this.iso(),
        })
        validateEditorialTimeline(project, { ...current, tracks: draft.tracks, items: draft.items }, await this.editorialSourceBounds(project))
        project = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          timeline_drafts: [...project.timeline_drafts, draft],
          finishing_receipts: [...project.finishing_receipts, this.finishingReceipt('beat_sync_draft', idempotencyKey, requestHash, [draft.id])],
          revision: project.revision + 1,
          updated_at: this.iso(),
        }))
        const task = await this.completeFinishingOperation(operation, 'Beat Sync 草稿已生成，等待用户接受', {
          timeline_draft_id: draft.id,
          evidence_id: beatEvidence.id,
          confidence: beatEvidence.payload.confidence,
          cut_count: cutCount,
        })
        return { project, draft, task }
      } catch (error) {
        await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', 'Beat Sync 草稿生成失败').catch(() => undefined)
        return this.finishingError(error)
      }
    })
  }

  private async decodeMonoPcm(input: {
    sourcePath: string
    audioStreamIndex: number
    sampleRate: number
    startSeconds: number
    durationSeconds: number
    signal: AbortSignal
  }): Promise<PcmDecodeResult> {
    if (this.pcmDecoder) return await this.pcmDecoder(input)
    const child = Bun.spawn([
      videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-nostdin', '-v', 'error',
      '-ss', input.startSeconds.toFixed(6), '-t', input.durationSeconds.toFixed(6),
      '-i', input.sourcePath,
      '-map', `0:${input.audioStreamIndex}`,
      '-ac', '1', '-ar', String(input.sampleRate), '-f', 'f32le', 'pipe:1',
    ], { stdout: 'pipe', stderr: 'pipe', signal: input.signal })
    const chunks = async function* (): AsyncGenerator<Uint8Array<ArrayBufferLike>> {
      const reader = child.stdout.getReader()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) return
          if (next.value) yield next.value
        }
      } finally {
        reader.releaseLock()
      }
    }
    return {
      chunks: chunks(),
      completion: Promise.all([new Response(child.stderr).text(), child.exited])
        .then(([stderr, exitCode]) => ({ stderr, exitCode })),
    }
  }

  private async runBeatAnalysis(
    project: VideoStudioProject,
    operation: VideoOperation,
    source: VideoFactSource & { fingerprint: `sha256:${string}` },
    audioStreamIndex: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const sourceDuration = source.primary_video_stream.duration
      if (!sourceDuration) throw new VideoWorkbenchServiceError('素材原始视频流时长缺失，不能安全分析节拍', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      const audio = source.audio_tracks.find(track => track.stream_index === audioStreamIndex)
      if (!audio?.duration) throw new VideoWorkbenchServiceError('所选音频轨时间范围缺失，不能安全分析节拍', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      const videoRange = sourceTimeRange(source.primary_video_stream.start_time, sourceDuration)
      const audioRange = sourceTimeRange(audio.start_time, audio.duration)
      const decodeStart = compareRationalTime(videoRange.start, audioRange.start) >= 0 ? videoRange.start : audioRange.start
      const videoEnd = endOfRange(videoRange)
      const audioEnd = endOfRange(audioRange)
      const decodeEnd = compareRationalTime(videoEnd, audioEnd) <= 0 ? videoEnd : audioEnd
      if (compareRationalTime(decodeEnd, decodeStart) <= 0) {
        throw new VideoWorkbenchServiceError('所选音频轨与主视频原始 PTS 没有交集，不能安全分析节拍', 422, 'VIDEO_FINISHING_UNAVAILABLE')
      }
      const decodeRange = sourceTimeRange(
        decodeStart,
        rationalTime(
          parseInt64(rescaleRationalTime(decodeEnd, decodeStart.tick_rate, 'nearest').ticks)
            - parseInt64(decodeStart.ticks),
          decodeStart.tick_rate,
        ),
      )
      const startSeconds = rationalSecondsBetween(audio.start_time, decodeRange.start)
      const durationSeconds = rationalSecondsBetween(decodeRange.start, endOfRange(decodeRange))
      const running = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'running',
        progress: 10,
        stage: '正在解码本地音频并检测节拍',
      }))
      const sampleRate = 22_050
      const decoded = await this.decodeMonoPcm({
        sourcePath: source.path,
        audioStreamIndex,
        sampleRate,
        startSeconds,
        durationSeconds,
        signal,
      })
      const [grid, outcome] = await Promise.all([
        detectBeatGridFromPcmChunks(decoded.chunks, sampleRate, decodeRange.start),
        decoded.completion,
      ])
      const { stderr, exitCode } = outcome
      if (exitCode !== 0 || signal.aborted) throw new Error(stderr || 'beat analysis interrupted')
      const evidence = createHostedEvidence({
        kind: 'beat_grid',
        projectId: project.id,
        source,
        range: decodeRange,
        payload: {
          ...grid,
          created_by_operation_id: operation.id,
          source_cache_key: factBasisHash({
            analyzer_version: grid.analyzer_version,
            source_id: source.id,
          source_fingerprint: source.fingerprint,
          audio_stream_index: audioStreamIndex,
          primary_video_range: videoRange,
          sample_rate: grid.sample_rate,
          }),
          cache_key: factBasisHash({
            analyzer_version: grid.analyzer_version,
            source_id: source.id,
            source_fingerprint: source.fingerprint,
            audio_stream_index: audioStreamIndex,
            sample_rate: grid.sample_rate,
            source_range: decodeRange,
            pcm_hash: grid.pcm_hash,
          }),
        },
        promptVersion: grid.analyzer_version,
        createdAt: this.iso(),
        confidence: grid.confidence,
      })
      await this.repository.saveFact(evidence)
      await this.repository.saveOperation(this.operation({
        ...running,
        status: 'succeeded',
        progress: 100,
        stage: grid.confidence >= 0.65 ? '本地节拍网格已就绪' : '节拍置信度不足，已降级为普通剪辑',
        result: { ...(running.result ?? {}), evidence_id: evidence.id, confidence: grid.confidence, ...(grid.bpm ? { bpm: grid.bpm } : {}) },
      }))
    } catch {
      await this.failOperation(operation, signal.aborted ? 'MEDIA_VIDEO_ANALYSIS_INTERRUPTED' : 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE', signal.aborted ? '节拍分析已取消' : '节拍分析失败').catch(() => undefined)
    } finally {
      this.activeAnalyses.delete(operation.id)
    }
  }

  /**
   * Build a conservative local track from already validated object evidence.
   * This operation never calls a remote model and never fills a long evidence
   * gap with an invented position; callers get a typed unavailable result when
   * the factual anchors are insufficient for a usable track.
   */
  async analyzeVideoSubjectTrack(
    projectId: string,
    raw: AnalyzeVideoSubjectTrackInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; evidence: Extract<VideoFactEvidence, { kind: 'subject_track' }>; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = analyzeVideoSubjectTrackInputSchema.parse(raw)
      let project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'subject_track', input })
      const replay = this.finishingReplay(project, 'subject_track', idempotencyKey, requestHash)
      if (replay) {
        const evidence = await this.repository.getFact('evidence', replay[0]!).catch(() => null)
        if (!evidence || !('payload' in evidence) || evidence.kind !== 'subject_track') {
          throw new VideoWorkbenchServiceError('主体轨迹幂等记录损坏', 500, 'VIDEO_FINISHING_INVALID')
        }
        const task = await this.startFinishingOperation(project, 'video.subject_track', idempotencyKey, requestHash, '生成主体轨迹')
        return {
          project,
          evidence,
          task: task.status === 'succeeded'
            ? task
            : await this.completeFinishingOperation(task, '主体轨迹已按幂等请求复用', { evidence_id: evidence.id, subject_id: input.subject_id }),
        }
      }
      const source = project.sources.find(candidate => candidate.id === input.source_id)
      if (!source || source.missing || source.content_changed) {
        throw new VideoWorkbenchServiceError('主体轨迹素材不可用', 404, 'VIDEO_SOURCE_NOT_FOUND')
      }
      const sourceFact = await this.repository.getFact('source', source.id).catch(() => null)
      if (!sourceFact || !('fast_identity' in sourceFact) || !sourceFact.fingerprint || !sourceFact.primary_video_stream.start_time || !sourceFact.primary_video_stream.duration) {
        throw new VideoWorkbenchServiceError('素材原始视频流事实未就绪，不能安全生成主体轨迹', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      const primaryVideoStart = sourceFact.primary_video_stream.start_time
      const primaryVideoDuration = sourceFact.primary_video_stream.duration
      const readySource = sourceFact as VideoFactSource & { fingerprint: `sha256:${string}` }
      const fullRange = sourceTimeRange(primaryVideoStart, primaryVideoDuration)
      const requestedRange = input.source_range
        ? sourceTimeRange(input.source_range.start, input.source_range.duration)
        : fullRange
      if (
        compareRationalTime(requestedRange.start, fullRange.start) < 0
        || compareRationalTime(endOfRange(requestedRange), endOfRange(fullRange)) > 0
      ) {
        throw new VideoWorkbenchServiceError('主体轨迹范围超出素材原始视频流边界', 422, 'VIDEO_EDITORIAL_INVALID')
      }
      const operation = await this.startFinishingOperation(project, 'video.subject_track', idempotencyKey, requestHash, '生成主体轨迹')
      try {
        const objectEvidence = (await this.repository.listFacts('evidence', project.id))
          .filter((fact): fact is Extract<VideoFactEvidence, { kind: 'object' }> => 'payload' in fact
            && fact.kind === 'object'
            && fact.source_id === readySource.id
            && fact.source_fingerprint === readySource.fingerprint
            && fact.payload.subject_id === input.subject_id
            && Boolean(fact.payload.normalized_box)
            && (fact.confidence ?? 0) >= 0.65)
          .map(fact => ({
            evidence_id: fact.id,
            range: fact.range,
            confidence: fact.confidence ?? 0,
            box: fact.payload.normalized_box!,
          }))
        const tracked = trackSubject(requestedRange, objectEvidence)
        if (!tracked.points.length || !tracked.anchor_evidence_ids.length) {
          throw new FinishingDeliveryValidationError('当前范围没有足够可信的主体证据，已保留原构图', 'VIDEO_FINISHING_UNAVAILABLE')
        }
        const evidence = createHostedEvidence({
          kind: 'subject_track',
          projectId: project.id,
          source: readySource,
          range: requestedRange,
          payload: {
            subject_id: input.subject_id,
            analyzer_version: tracked.analyzer_version,
            anchor_evidence_ids: tracked.anchor_evidence_ids,
            points: tracked.points,
            unresolved_ranges: tracked.unresolved_ranges,
            created_by_operation_id: operation.id,
          },
          promptVersion: tracked.analyzer_version,
          createdAt: this.iso(),
          confidence: tracked.confidence,
        })
        await this.repository.saveFact(evidence)
        project = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          finishing_receipts: [...project.finishing_receipts, this.finishingReceipt('subject_track', idempotencyKey, requestHash, [evidence.id])],
          revision: project.revision + 1,
          updated_at: this.iso(),
        }))
        const task = await this.completeFinishingOperation(operation, '主体轨迹已生成', {
          source_id: source.id,
          evidence_id: evidence.id,
          subject_id: input.subject_id,
          confidence: tracked.confidence,
        })
        return { project, evidence, task }
      } catch (error) {
        await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '主体轨迹生成失败').catch(() => undefined)
        return this.finishingError(error)
      }
    })
  }

  async assertProjectOwner(projectId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<VideoStudioProject> {
    const project = await this.project(projectId)
    if (!sameOwner(project.owner, owner)) {
      throw new VideoWorkbenchServiceError('视频项目不属于当前工作台', 403, 'VIDEO_PROJECT_FORBIDDEN')
    }
    return project
  }

  async getOperation(operationId: string): Promise<VideoOperation> {
    return await this.repository.getOperation(operationId)
  }

  async pageMediaFacts(projectId: string, kind: VideoFactKind, options?: { sourceId?: string; cursor?: string; limit?: number }) {
    await this.requireVideoProject(projectId)
    return await this.repository.pageCurrentFacts(kind, projectId, options)
  }

  async searchMediaFacts(projectId: string, query: string, options?: { cursor?: string; limit?: number }) {
    const project = await this.requireVideoProject(projectId)
    const consent = project.remote_analysis_consents.find(item => item.state === 'active' && item.purposes.includes('semantic_search') && item.data_kinds.includes('transcript'))
    const budget = consent && project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
    const relay = this.videoMediaRelay()
    const cursorKind = options?.cursor ? await this.repository.searchFactsCursorKind(options.cursor) : undefined
    const semanticRoute = Boolean(consent && budget && relay)
    if (cursorKind === 'hybrid' && !semanticRoute) {
      throw new VideoWorkbenchServiceError('语义检索上下文已失效，请从第一页重新查询', 400, 'VIDEO_FACTS_INVALID')
    }
    if (semanticRoute) await this.repository.ensureSearchEmbeddingBasis(projectId, VIDEO_REMOTE_MODEL_BINDINGS.semanticEmbedding, 'video-facts-v1')
    // Hybrid cursors paginate the fused result set, so lexical lookup must
    // start from the same generation without attempting to decode that cursor.
    const lexical = await this.repository.searchFactsPage(projectId, query, cursorKind === 'hybrid' ? { limit: options?.limit } : options)
    if (!consent || !budget || !relay) return lexical
    // This attempts only durable ACK retries. It does not submit, download or
    // otherwise re-run a document embedding whose vectors already committed.
    await this.flushPendingRelayAcknowledgements(projectId)
    const scopeHash = factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds })
    const candidates = await this.repository.listCurrentSearchCandidates(projectId)
    const eligible = candidates.filter(item => item.kind === 'transcript' && consent.coverage.some(coverage => coverage.source_id === item.source_id && coverage.ranges.some(range => compareRationalTime(item.range.start, range.start) >= 0 && compareRationalTime(endOfRange(item.range), endOfRange(range)) <= 0)))
    if (!eligible.length) {
      if (cursorKind === 'hybrid') throw new VideoWorkbenchServiceError('语义检索上下文已失效，请从第一页重新查询', 400, 'VIDEO_FACTS_INVALID')
      return lexical
    }
    // A page cursor changes only the local result window. It must not change
    // the durable query Operation or charge the Provider for the same vector.
    const nonce = createHash('sha256').update(JSON.stringify({ projectId, generation: lexical.generation, query, model: VIDEO_REMOTE_MODEL_BINDINGS.semanticEmbedding, instruction_version: 'video-facts-v1' })).digest('hex').slice(0, 24)
    const allDocumentItems = eligible.map((item, index) => ({ id: `embed_${nonce.slice(0, 12)}${index.toString(16).padStart(4, '0')}`, text: item.text, entry_id: item.kind === 'transcript' ? `${item.id}\u001f${item.segment_ids.join(',')}` : item.id }))
    try {
      const missing = await this.repository.missingSearchEmbeddingEntries(projectId, allDocumentItems.map(item => item.entry_id))
      const documentItems = allDocumentItems.filter(item => missing.has(item.entry_id))
      for (let offset = 0; offset < documentItems.length; offset += VIDEO_REMOTE_USAGE_POLICY.semanticDocumentBatchSize) {
        const batch = documentItems.slice(offset, offset + VIDEO_REMOTE_USAGE_POLICY.semanticDocumentBatchSize)
        const documentOperationId = `task_${nonce}d${String(offset / VIDEO_REMOTE_USAGE_POLICY.semanticDocumentBatchSize).padStart(2, '0')}`
        const documentTokens = batch.reduce((sum, item) => sum + estimatedTextTokens(item.text), 0)
        const documentBody = JSON.stringify({ model: VIDEO_SEMANTIC_EMBEDDING_MODEL, input: batch.map(item => item.text), dimensions: 768 })
        const documentUsage = {
          requests: 1, total_tokens: documentTokens, input_bytes: Buffer.byteLength(documentBody, 'utf8'), visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: estimatedTextAmountMicros(documentTokens),
        }
        const documentRequest = { local_operation_id: documentOperationId, consent_revision_id: consent.id, consent_scope_hash: scopeHash, local_budget_reservation_id: budget.id, request_hash: factBasisHash({ model: VIDEO_REMOTE_MODEL_BINDINGS.semanticEmbedding, instruction_version: 'video-facts-v1', generation: lexical.generation, documents: batch.map(item => ({ id: item.entry_id, text: item.text })) }), capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'document' as const, items: batch.map(item => ({ id: item.id, text: item.text })), model: VIDEO_SEMANTIC_EMBEDDING_MODEL as 'text-embedding-v4', dimension: 768 as const, instruction_version: 'video-facts-v1' } }
        await this.reserveAndRunRemote(projectId, budget.id, 'semantic_embedding', documentUsage, relay, documentRequest, async (activeRelay, documents) => {
          if (documents.state !== 'succeeded' || !documents.provider_receipt) throw new VideoMediaRelayClientError(documents.state === 'outcome_unknown' ? 503 : 422, 'relay_operation_not_succeeded')
          await this.settleRemoteBudget(projectId, budget.id, documentOperationId, documents.provider_receipt)
          const downloadedDocuments = await activeRelay.downloadResult<{ kind: string; vectors: Array<{ id: string; vector: number[] }> }>(documents)
          if (downloadedDocuments.result.kind !== 'embedding') throw new VideoWorkbenchServiceError('Embedding 结果类型无效', 502, 'VIDEO_ANALYSIS_INVALID')
          const vectorById = new Map(downloadedDocuments.result.vectors.map(item => [item.id, item.vector]))
          const acknowledgement = this.acknowledgementFor(documentOperationId, documents.id, documents.provider_receipt.id, downloadedDocuments.hashes)
          await this.repository.saveFactEmbeddingsWithRelayAcknowledgement(
            projectId,
            batch.map(item => ({ entry_id: item.entry_id, vector: vectorById.get(item.id) ?? [], model_snapshot: documents.provider_receipt!.model_snapshot, instruction_version: 'video-facts-v1', content_hash: `sha256:${createHash('sha256').update(JSON.stringify(vectorById.get(item.id) ?? [])).digest('hex')}` })),
            { ...acknowledgement, local_operation_id: documentOperationId, result_hashes: acknowledgement.result_hashes as `sha256:${string}`[] },
          )
          await this.flushPendingRelayAcknowledgements(projectId)
        })
      }
      const queryLocalOperationId = `task_${nonce}q`
      const queryTokens = estimatedTextTokens(query)
      const queryBody = JSON.stringify({ model: VIDEO_SEMANTIC_EMBEDDING_MODEL, input: [query], dimensions: 768 })
      const queryUsage = {
        requests: 1, total_tokens: Math.max(queryTokens, VIDEO_REMOTE_USAGE_POLICY.semanticQueryTokenReserve), input_bytes: Buffer.byteLength(queryBody, 'utf8'), visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: estimatedTextAmountMicros(Math.max(queryTokens, VIDEO_REMOTE_USAGE_POLICY.semanticQueryTokenReserve)),
      }
      const queryHash = factBasisHash({ model: VIDEO_REMOTE_MODEL_BINDINGS.semanticEmbedding, instruction_version: 'video-facts-v1', generation: lexical.generation, query })
      const queryRequest = { local_operation_id: queryLocalOperationId, consent_revision_id: consent.id, consent_scope_hash: scopeHash, local_budget_reservation_id: budget.id, request_hash: queryHash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: `embed_${nonce}`, text: query }], model: VIDEO_SEMANTIC_EMBEDDING_MODEL as 'text-embedding-v4', dimension: 768 as const, instruction_version: 'video-facts-v1' } }
      let queryTask = await this.repository.getOperation(queryLocalOperationId).catch(() => null)
      if (queryTask && (
        queryTask.project_id !== projectId
        || queryTask.kind !== 'video.index'
        || queryTask.result?.query_hash !== queryHash
        || queryTask.result?.search_generation !== lexical.generation
      )) throw new VideoWorkbenchServiceError('语义查询幂等记录与当前请求不一致', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      if (!queryTask) {
        queryTask = await this.repository.saveOperation(this.operation({
          schema_version: 1,
          id: queryLocalOperationId,
          project_id: projectId,
          kind: 'video.index',
          status: 'running',
          progress: 10,
          stage: '正在生成语义查询向量',
          result: { search_generation: lexical.generation, query_hash: queryHash, query, cursor: options?.cursor ?? null },
          created_at: this.iso(),
          updated_at: this.iso(),
        } as unknown as VideoOperation))
      }
      const durableQuery = this.stagedSemanticQueryResult(queryTask)
      let queryVector: number[]
      if (durableQuery) {
        queryVector = await this.finalizeStagedSemanticQueryResult(queryTask)
      } else {
        if (!['queued', 'running'].includes(queryTask.status)) throw new VideoWorkbenchServiceError('语义查询任务没有可恢复结果', 409, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
        queryVector = await this.reserveAndRunRemote(projectId, budget.id, 'semantic_embedding', queryUsage, relay, queryRequest, async (activeRelay, queryOperation) => {
          if (queryOperation.state !== 'succeeded' || !queryOperation.provider_receipt) throw new VideoMediaRelayClientError(queryOperation.state === 'outcome_unknown' ? 503 : 422, 'relay_operation_not_succeeded')
          await this.settleRemoteBudget(projectId, budget.id, queryLocalOperationId, queryOperation.provider_receipt)
          const downloadedQuery = await activeRelay.downloadResult<{ kind: string; vectors: Array<{ id: string; vector: number[] }> }>(queryOperation)
          const vector = downloadedQuery.result.vectors[0]?.vector
          if (downloadedQuery.result.kind !== 'embedding' || !vector || vector.length !== 768 || vector.some(value => !Number.isFinite(value))) {
            throw new VideoWorkbenchServiceError('Embedding 查询结果无效', 502, 'VIDEO_ANALYSIS_INVALID')
          }
          await this.stageSemanticQueryResult(
            queryTask!.id,
            lexical.generation,
            queryHash,
            vector,
            this.acknowledgementFor(queryLocalOperationId, queryOperation.id, queryOperation.provider_receipt.id, downloadedQuery.hashes),
          )
          return vector
        }, { parentOperationId: queryTask.id })
        queryTask = await this.repository.getOperation(queryTask.id)
        queryVector = await this.finalizeStagedSemanticQueryResult(queryTask)
      }
      return await this.repository.hybridSearchFactsPage(projectId, query, queryVector, options)
    } catch (error) { throw error }
  }

  async reclaimDerivativeCache(projectId: string, maxEvictions: number): Promise<string[]> {
    await this.requireVideoProject(projectId)
    return await this.repository.reclaimLeastRecentlyUsedDerivatives(projectId, maxEvictions)
  }

  async waitForOperationEvents(projectId: string, cursor: number, limit: number, waitMs: number) {
    const page = await this.repository.listOperationEvents(projectId, cursor, limit)
    if (page.events.length || page.reset_required || waitMs <= 0) return page
    await this.repository.waitForOperationEvent(projectId, cursor, waitMs)
    return await this.repository.listOperationEvents(projectId, cursor, limit)
  }

  async toolchainStatus() {
    return await videoToolchainStatus(this.runProcess, this.env, this.platform)
  }

  async listDeletions(owner: MediaOwner = STANDALONE_VIDEO_OWNER) {
    return await this.repository.listDeletions(owner)
  }

  async hasProjectHistory(projectId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<boolean> {
    return await this.repository.hasProjectHistory(projectId, owner)
  }

  async hasOperationHistory(operationId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<boolean> {
    return await this.repository.hasOperationHistory(operationId, owner)
  }

  async deleteProject(projectId: string) {
    await this.assertProjectOwner(projectId)
    return await this.repository.deleteProject(projectId)
  }

  async restoreProject(projectId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER) {
    return await this.repository.restoreProject(projectId, owner)
  }

  private videoContentType(path: string): string {
    return videoMimeType(path)
  }

  private isWithinManagedRoot(root: string, candidate: string): boolean {
    const relativePath = relative(resolve(root), resolve(candidate))
    return relativePath !== ''
      && relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
  }

  private async videoFileResponse(path: string, request: Request): Promise<Response> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new VideoWorkbenchServiceError('视频素材不可用', 404, 'VIDEO_ASSET_NOT_FOUND')
    const range = request.headers.get('range')
    const etag = `W/\"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}\"`
    const headers = {
      'Content-Type': this.videoContentType(path),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    }
    const ifNoneMatch = request.headers.get('if-none-match')
    if (ifNoneMatch && (ifNoneMatch.trim() === '*' || ifNoneMatch.split(',').some(value => value.trim() === etag))) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Last-Modified': headers['Last-Modified'] } })
    }
    if (!range) return new Response(Bun.file(path), { headers: { ...headers, 'Content-Length': String(info.size) } })
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!match || info.size <= 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
    const suffixRequest = !match[1]
    const suffix = suffixRequest ? Number(match[2]) : 0
    if (suffixRequest && (!Number.isInteger(suffix) || suffix <= 0)) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
    }
    const start = suffix > 0 ? Math.max(0, info.size - suffix) : match[1] ? Number(match[1]) : 0
    const end = suffix > 0 ? info.size - 1 : match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= info.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
    }
    return new Response(Bun.file(path).slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${info.size}` },
    })
  }

  private async captionFileResponse(path: string): Promise<Response> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new VideoWorkbenchServiceError('视频预览字幕不可用', 404, 'VIDEO_ASSET_NOT_FOUND')
    const contentType = extname(path).toLowerCase() === '.vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8'
    return new Response(Bun.file(path), { headers: { 'Content-Type': contentType, 'Content-Length': String(info.size) } })
  }

  async sourceResponse(projectId: string, sourceId: string, request: Request): Promise<Response> {
    const project = await this.requireVideoProject(projectId)
    const source = project.sources.find(candidate => candidate.id === sourceId)
    if (!source) throw new VideoWorkbenchServiceError('找不到视频素材', 404, 'VIDEO_SOURCE_NOT_FOUND')
    return await this.videoFileResponse(source.path, request)
  }

  async previewResponse(projectId: string, assetId: string, request: Request): Promise<Response> {
    const project = await this.requireVideoProject(projectId)
    const asset = project.assets.find(candidate => candidate.id === assetId && candidate.role === 'preview')
    const locator = asset?.storage.kind === 'managed' ? asset.storage.locator : undefined
    const managedPreviewLocator = locator && ['.mp4', '.mov'].some(extension => locator === join(project.id, `${assetId}${extension}`))
    if (!asset || asset.storage.kind !== 'managed' || !managedPreviewLocator) {
      throw new VideoWorkbenchServiceError('找不到视频预览', 404, 'VIDEO_ASSET_NOT_FOUND')
    }
    const root = resolve(this.repository.paths().assets)
    const path = resolve(root, locator)
    if (!this.isWithinManagedRoot(root, path)) throw new VideoWorkbenchServiceError('视频预览地址无效', 404, 'VIDEO_ASSET_NOT_FOUND')
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || info.size !== asset.byte_size) throw new VideoWorkbenchServiceError('视频预览内容已变化', 409, 'VIDEO_ASSET_NOT_FOUND')
    return await this.videoFileResponse(path, request)
  }

  async previewSidecarResponse(projectId: string, assetId: string): Promise<Response> {
    const project = await this.requireVideoProject(projectId)
    const preview = project.preview
    if (!preview || preview.asset_id !== assetId || !preview.sidecar_caption) {
      throw new VideoWorkbenchServiceError('找不到视频预览字幕', 404, 'VIDEO_ASSET_NOT_FOUND')
    }
    const root = resolve(this.repository.paths().assets)
    const locator = join(project.id, `${assetId}.${preview.sidecar_caption.format}`)
    const path = resolve(root, locator)
    if (!this.isWithinManagedRoot(root, path) || await videoFingerprint(path).catch(() => null) !== preview.sidecar_caption.content_hash) {
      throw new VideoWorkbenchServiceError('视频预览字幕不可用', 404, 'VIDEO_ASSET_NOT_FOUND')
    }
    return await this.captionFileResponse(path)
  }

  /**
   * One-way, crash-resumable copy from the retired generic media store. Its
   * directories are a strictly read-only source: SQLite is the only writer
   * after import, while source hashes and repository reconciliation retain the
   * evidence needed before a separately approved reader-retirement change.
   */
  async migrateLegacyMediaStore(): Promise<{ migrated_project_ids: string[]; skipped_project_ids: string[] }> {
    const projectsDir = join(this.legacyMediaRoot, 'projects')
    const tasksDir = join(this.legacyMediaRoot, 'tasks')
    const eventsDir = join(this.legacyMediaRoot, 'events')
    const normalize = (raw: unknown): unknown => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
      const record = { ...(raw as Record<string, unknown>) }
      const legacyOwner = 'product_task_id' in record
        || (record.owner && typeof record.owner === 'object' && !Array.isArray(record.owner)
          && (record.owner as Record<string, unknown>).kind === 'product_task')
      if (legacyOwner) record.owner = STANDALONE_VIDEO_OWNER
      delete record.product_task_id
      delete record.data_egress_consent
      return record
    }
    const readJsonFiles = async (directory: string, label: string) => {
      const names = (await readdir(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
        throw error
      })).filter(name => name.endsWith('.json')).sort()
      return await Promise.all(names.map(async name => {
        const path = join(directory, name)
        let text: string
        let value: unknown
        try {
          text = await readFile(path, 'utf8')
          value = JSON.parse(text)
        } catch {
          throw new VideoWorkbenchServiceError(`旧通用媒体${label}损坏，无法安全迁移`, 500, 'VIDEO_STORAGE_INVALID')
        }
        return { name, text, value }
      }))
    }
    const [projectFiles, taskFiles, eventFiles] = await Promise.all([
      readJsonFiles(projectsDir, '项目'),
      readJsonFiles(tasksDir, '任务'),
      readJsonFiles(eventsDir, '操作日志'),
    ])
    const eventFileByName = new Map(eventFiles.map(item => [item.name, item]))
    const tasksByProject = new Map<string, Array<{ name: string; text: string; operation: VideoOperation }>>()
    for (const item of taskFiles) {
      const normalized = normalize(item.value)
      const kind = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
        ? (normalized as Record<string, unknown>).kind
        : undefined
      if (typeof kind !== 'string' || !kind.startsWith('video.')) continue
      const parsed = mediaTaskSchema.safeParse(normalized)
      if (!parsed.success) throw new VideoWorkbenchServiceError('旧通用媒体视频任务损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      const operation = parsed.data as VideoOperation
      tasksByProject.set(operation.project_id, [...(tasksByProject.get(operation.project_id) ?? []), {
        name: item.name,
        text: item.text,
        operation,
      }])
    }

    const migratedProjectIds: string[] = []
    const skippedProjectIds: string[] = []
    for (const item of projectFiles) {
      const normalized = normalize(item.value)
      const kind = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
        ? (normalized as Record<string, unknown>).kind
        : undefined
      if (kind !== 'video') continue
      const parsed = videoStudioProjectSchema.safeParse(normalized)
      if (!parsed.success) throw new VideoWorkbenchServiceError('旧通用媒体视频项目损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      const legacy = parsed.data
      if (item.name !== `${legacy.id}.json`) {
        throw new VideoWorkbenchServiceError('旧通用媒体视频项目文件名与内容不匹配', 500, 'VIDEO_STORAGE_INVALID')
      }
      const taskEntries = tasksByProject.get(legacy.id) ?? []
      const eventFile = eventFileByName.get(`${legacy.id}.json`)
      let journal: VideoLegacyEventJournal | null = null
      if (eventFile) {
        const rawJournal = eventFile.value && typeof eventFile.value === 'object' && !Array.isArray(eventFile.value)
          ? {
            ...(eventFile.value as Record<string, unknown>),
            events: Array.isArray((eventFile.value as Record<string, unknown>).events)
              ? (eventFile.value as { events: unknown[] }).events.map(event => {
                if (!event || typeof event !== 'object' || Array.isArray(event)) return event
                const record = event as Record<string, unknown>
                return { ...record, task: normalize(record.task) }
              })
              : (eventFile.value as Record<string, unknown>).events,
          }
          : eventFile.value
        const parsedJournal = mediaJobEventJournalSchema.safeParse(rawJournal)
        if (!parsedJournal.success) {
          throw new VideoWorkbenchServiceError('旧通用媒体视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
        }
        const events = parsedJournal.data.events.map(event => {
          if (!event.task.kind.startsWith('video.') || event.project_id !== legacy.id || event.task.project_id !== legacy.id || event.task_id !== event.task.id) {
            throw new VideoWorkbenchServiceError('旧通用媒体视频操作日志与项目不匹配', 500, 'VIDEO_STORAGE_INVALID')
          }
          return {
            schema_version: 1 as const,
            cursor: event.cursor,
            project_id: legacy.id,
            operation_id: event.operation_id,
            status_sequence: event.status_sequence,
            occurred_at: event.occurred_at,
            operation: {
              ...event.task,
              operation_id: event.operation_id,
            } as VideoOperation,
          }
        })
        journal = { next_cursor: parsedJournal.data.next_cursor, events }
      }
      const knownTaskIds = new Set([
        ...taskEntries.map(entry => entry.operation.id),
        ...(journal?.events.map(event => event.operation.id) ?? []),
      ])
      const previewAsset = legacy.preview
        ? legacy.assets.find(asset => asset.id === legacy.preview!.asset_id && asset.role === 'preview')
        : undefined
      const legacyPreviewName = legacy.preview ? basename(legacy.preview.asset_path) : ''
      const canImportPreview = Boolean(
        legacy.preview
        && previewAsset
        && /^[a-z0-9][a-z0-9_.-]{2,120}\.mp4$/.test(legacyPreviewName)
        && legacyPreviewName.startsWith(`${legacy.preview.asset_id}.`),
      )
      let preview: VideoStudioProject['preview']
      let assets = legacy.assets.filter(asset => asset.role !== 'preview')
      if (canImportPreview && legacy.preview && previewAsset) {
        const source = join(this.legacyMediaRoot, 'assets', legacy.id, legacyPreviewName)
        const info = await stat(source).catch(() => null)
        if (info?.isFile() && info.size > 0) {
          const target = join(this.repository.paths().assets, legacy.id, `${legacy.preview.asset_id}.mp4`)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await copyFile(source, target)
          const hash = await videoFingerprint(target)
          assets = [...assets, {
            id: legacy.preview.asset_id,
            role: 'preview' as const,
            version_id: legacy.preview.timeline_version_id,
            storage: { kind: 'managed' as const, locator: join(legacy.id, `${legacy.preview.asset_id}.mp4`) },
            mime_type: 'video/mp4',
            byte_size: info.size,
            content_hash: hash,
            created_at: legacy.preview.created_at,
          }]
          preview = {
            timeline_version_id: legacy.preview.timeline_version_id,
            asset_id: legacy.preview.asset_id,
            asset_path: `/api/videos/projects/${legacy.id}/previews/${legacy.preview.asset_id}/content`,
            content_hash: hash,
            created_at: legacy.preview.created_at,
          }
        }
      }
      const imported = videoStudioProjectSchema.parse({
        ...legacy,
        owner: STANDALONE_VIDEO_OWNER,
        writer_fence: INITIAL_WRITER_FENCE,
        assets,
        preview,
        task_id: legacy.task_id && knownTaskIds.has(legacy.task_id) ? legacy.task_id : undefined,
        preview_task_id: legacy.preview_task_id && knownTaskIds.has(legacy.preview_task_id) ? legacy.preview_task_id : undefined,
      })
      const hash = createHash('sha256')
        .update(item.text)
        .update('\0')
      for (const task of taskEntries.sort((left, right) => left.name.localeCompare(right.name))) hash.update(task.name).update('\0').update(task.text).update('\0')
      if (eventFile) hash.update(eventFile.name).update('\0').update(eventFile.text).update('\0')
      const snapshot: VideoLegacyMigrationSnapshot = {
        source_id: 'generic_media',
        source_hash: `sha256:${hash.digest('hex')}`,
        project: imported,
        operations: taskEntries.map(entry => entry.operation),
        journal,
      }
      const result = await this.repository.importLegacyMediaSnapshot(snapshot)
      if (result.state === 'imported') migratedProjectIds.push(legacy.id)
      else skippedProjectIds.push(legacy.id)
    }
    return { migrated_project_ids: migratedProjectIds, skipped_project_ids: skippedProjectIds }
  }

  private async requireVideoProject(projectId: string): Promise<VideoStudioProject> {
    const project = await this.project(projectId)
    if (project.kind !== 'video') throw new VideoWorkbenchServiceError('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return project
  }

  /** Narrow ProjectAssets infrastructure port. Probe facts are persisted by
   * the application; Runtime retains only FFprobe process configuration. */
  async probeSourceFact(input: {
    id: string
    project_id: string
    path: string
    name: string
    now: string
  }): Promise<VideoFactSource> {
    return await probeVideoFactSource({
      id: input.id,
      projectId: input.project_id,
      path: input.path,
      name: input.name,
      now: input.now,
      runProcess: this.runProcess,
      ffprobe: videoBinary('ffprobe', this.env, this.platform),
    })
  }

  /** Secondary project inputs use the same FFprobe boundary as the primary
   * source, but retain only their independently attested stream facts. */
  async probeProjectAsset(input: {
    path: string
    asset_kind: 'music' | 'voice_over' | 'b_roll' | 'overlay'
  }) {
    return await probeManagedProjectAsset({
      path: input.path,
      assetKind: input.asset_kind,
      mimeType: projectAssetMimeType(input.path, input.asset_kind),
      runProcess: this.runProcess,
      ffprobe: videoBinary('ffprobe', this.env, this.platform),
    })
  }

  /** The in-memory handle is rebuilt from the durable fingerprint Operation
   * during recovery; it is not a second Project or operation journal. */
  startSourceFingerprint(operation: VideoOperation, sourceId: string): void {
    this.startFingerprint(operation, sourceId)
  }

  /** Planning operates only on durable facts and explicit curation choices.
   * It deliberately has no access to source paths, provider prompts or the
   * mutable legacy Timeline projection. */
  private async planningCandidates(project: VideoStudioProject): Promise<PlanningCandidate[]> {
    const [segments, allEvidence] = await Promise.all([
      this.repository.listFacts('content_segment', project.id),
      this.repository.listFacts('evidence', project.id),
    ])
    const evidence = allEvidence.flatMap(item => 'payload' in item ? [item as VideoFactEvidence] : [])
    const evidenceForSegment = (segment: { id: string; source_id: string; source_fingerprint: string; range: SourceTimeRange }): VideoFactEvidence[] => {
      const segmentEnd = endOfRange(segment.range)
      return evidence.filter(item => item.source_id === segment.source_id
        && item.source_fingerprint === segment.source_fingerprint
        && (item.content_segment_id === segment.id || (
          compareRationalTime(item.range.start, segmentEnd) < 0
          && compareRationalTime(segment.range.start, endOfRange(item.range)) < 0
        )))
    }
    const factual = segments.flatMap(item => {
      if (!('segmentation_source' in item)) return []
      const linked = evidenceForSegment(item)
      const confidence = linked.flatMap(candidate => candidate.confidence === undefined ? [] : [candidate.confidence])
      return [{
        id: item.id,
        source_id: item.source_id,
        source_fingerprint: item.source_fingerprint as `sha256:${string}`,
        range: item.range,
        evidence_ids: linked.map(candidate => candidate.id),
        evidence_text: linked.map(planningEvidenceText).filter(Boolean).join(' '),
        evidence_kinds: [...new Set(linked.map(candidate => candidate.kind))],
        evidence_confidence: confidence.length ? confidence.reduce((sum, value) => sum + value, 0) / confidence.length : 0,
      }]
    })
    if (factual.length) return factual
    // Projects upgraded from the old scene planner can still make a truthful
    // feasibility assessment from persisted evidence. No source duration is
    // invented and no unbounded presentation duration is substituted here.
    return project.evidence.flatMap(item => {
      const source = project.sources.find(candidate => candidate.id === item.source_id)
      if (!source?.fingerprint || source.missing || source.content_changed) return []
      return [{
        id: item.id,
        source_id: item.source_id,
        source_fingerprint: source.fingerprint as `sha256:${string}`,
        range: sourceTimeRange(
          rationalTime(String(item.in_ms), { num: 1_000, den: 1 }),
          rationalTime(String(item.out_ms - item.in_ms), { num: 1_000, den: 1 }),
        ),
        evidence_ids: [item.id],
        evidence_text: item.text,
        evidence_kinds: [item.kind],
        evidence_confidence: item.confidence,
      }]
    })
  }

  private planningBasis(
    project: VideoStudioProject,
    candidates: ReadonlyArray<PlanningCandidate>,
  ): `sha256:${string}` {
    const locked = project.current_editorial_timeline_version_id
      ? project.editorial_timeline_versions.find(item => item.id === project.current_editorial_timeline_version_id)
        ?.items.filter(item => item.locked).map(item => ({ id: item.id, binding: item.binding, range: item.timeline_range })) ?? []
      : []
    return factBasisHash({
      candidates: candidates.map(item => ({ id: item.id, source_id: item.source_id, source_fingerprint: item.source_fingerprint, range: item.range }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      decisions: project.source_range_decisions.map(item => ({ id: item.id, source_id: item.source_id, source_fingerprint: item.source_fingerprint, range: item.range, decision: item.decision }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      creation_brief: project.creation_brief ? {
        id: project.creation_brief.id,
        revision: project.creation_brief.revision,
        use_case: project.creation_brief.use_case,
        user_request: project.creation_brief.user_request,
        audience: project.creation_brief.audience,
        distribution: project.creation_brief.distribution,
        tone: project.creation_brief.tone,
        pace: project.creation_brief.pace,
        hook_strategy: project.creation_brief.hook_strategy,
        story_structure: project.creation_brief.story_structure,
        selection_focus: project.creation_brief.selection_focus,
        must_preserve: project.creation_brief.must_preserve,
        creative_direction: project.creation_brief.creative_direction,
      } : undefined,
      locked,
    })
  }

  private decisionForCandidate(
    project: VideoStudioProject,
    candidate: Pick<PlanningCandidate, 'source_id' | 'source_fingerprint' | 'range'>,
  ): VideoSourceRangeDecision['decision'] | undefined {
    const sameRange = (left: SourceTimeRange, right: SourceTimeRange) => compareRationalTime(left.start, right.start) === 0
      && compareRationalTime(left.duration, right.duration) === 0
    const matching = project.source_range_decisions
      .filter(item => item.source_id === candidate.source_id
        && item.source_fingerprint === candidate.source_fingerprint
        && sameRange(item.range as SourceTimeRange, candidate.range))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id))
    return matching[0]?.decision
  }

  /** The public product selects a storytelling job, not a camera-cut
   * primitive. A user may still explicitly ask for chronology. */
  private storyStructure(project: VideoStudioProject): StoryStructure {
    const explicit = project.creation_brief?.story_structure
    if (explicit && explicit !== 'auto') return explicit
    switch (project.creation_brief?.use_case) {
      case 'tutorial': return 'how_to'
      case 'product_demo': return 'problem_solution'
      case 'event_recap':
      case 'sports_highlight': return 'highlight_reel'
      case 'talking_head':
      case 'interview':
      case 'podcast_clip':
      case 'social_short':
      case 'auto_highlight': return 'hook_value_payoff'
      default: return 'chronological'
    }
  }

  private selectionFocus(project: VideoStudioProject): SelectionFocus {
    const explicit = project.creation_brief?.selection_focus
    if (explicit && explicit !== 'auto') return explicit
    switch (project.creation_brief?.use_case) {
      case 'talking_head':
      case 'interview':
      case 'tutorial':
      case 'podcast_clip': return 'speech'
      case 'sports_highlight': return 'action'
      case 'product_demo': return 'product'
      case 'event_recap': return 'visual'
      default: return 'auto'
    }
  }

  private storyRoleForPosition(structure: StoryStructure, index: number, count: number): VideoScene['story_role'] {
    if (count <= 1) return 'hook'
    if (index === 0) return 'hook'
    if (index === count - 1) return structure === 'hook_value_payoff' ? 'cta' : 'result'
    if (structure === 'chronological') return index === 1 ? 'context' : 'action'
    if (structure === 'how_to') return index === 1 ? 'context' : 'action'
    if (structure === 'problem_solution') return index === 1 ? 'context' : index === count - 2 ? 'result' : 'action'
    if (structure === 'highlight_reel') return 'action'
    return 'action'
  }

  private chronologicalCandidates<T extends PlanningCandidate>(candidates: readonly T[]): T[] {
    return [...candidates].sort((left, right) => left.source_id.localeCompare(right.source_id)
      || compareRationalTime(left.range.start, right.range.start)
      || left.id.localeCompare(right.id))
  }

  /** This is deliberately a small, deterministic ranker. It uses only the
   * creator's declared job, explicit keep decisions and durable Fact evidence.
   * It does not call something a "best scene" unless the evidence supports a
   * transparent ranking signal. */
  private rankPlanningCandidates(project: VideoStudioProject, candidates: readonly PlanningCandidate[]): RankedPlanningCandidate[] {
    const structure = this.storyStructure(project)
    const focus = this.selectionFocus(project)
    const terms = planningTerms([
      project.creation_brief?.user_request ?? '',
      ...(project.creation_brief?.must_preserve ?? []),
    ].join(' '))
    const ranked = this.chronologicalCandidates(candidates).map(candidate => {
      const decision = this.decisionForCandidate(project, candidate)
      const reasons: string[] = []
      let score = 0
      if (decision === 'required') {
        score += 10_000
        reasons.push('用户标记为必须保留。')
      } else if (decision === 'pick') {
        score += 5_000
        reasons.push('用户明确挑选此范围。')
      }
      const normalizedEvidence = candidate.evidence_text.toLocaleLowerCase()
      const matchedTerms = terms.filter(term => normalizedEvidence.includes(term)).slice(0, 3)
      if (matchedTerms.length) {
        score += matchedTerms.length * 120
        reasons.push(`与创作诉求匹配：${matchedTerms.map(term => `“${term}”`).join('、')}。`)
      }
      const focusKinds: Record<Exclude<SelectionFocus, 'auto'>, readonly string[]> = {
        speech: ['transcript'],
        action: ['action'],
        visual: ['visual', 'ocr', 'object'],
        people: ['subject_track', 'object', 'visual'],
        product: ['object', 'ocr', 'visual'],
      }
      if (focus !== 'auto' && candidate.evidence_kinds.some(kind => focusKinds[focus].includes(kind))) {
        score += 60
        reasons.push(`有可锚定的${focus === 'speech' ? '转写' : focus === 'action' ? '动作' : focus === 'people' ? '人物' : focus === 'product' ? '产品' : '视觉'}事实。`)
      }
      if (candidate.evidence_confidence > 0) score += Math.round(candidate.evidence_confidence * 20)
      if (!reasons.length) reasons.push('缺少可用于语义排序的证据，按素材时间顺序保守处理。')
      return { ...candidate, selection_score: score, selection_reasons: reasons }
    })
    const ordered = structure === 'chronological'
      ? ranked
      : ranked.sort((left, right) => right.selection_score - left.selection_score
        || left.source_id.localeCompare(right.source_id)
        || compareRationalTime(left.range.start, right.range.start)
        || left.id.localeCompare(right.id))
    return ordered.map((candidate, index) => ({
      ...candidate,
      selection_rank: index + 1,
      story_role: this.storyRoleForPosition(structure, index, ordered.length),
    }))
  }

  private withStoryRoles(structure: StoryStructure, candidates: readonly RankedPlanningCandidate[]): RankedPlanningCandidate[] {
    return candidates.map((candidate, index) => ({
      ...candidate,
      story_role: this.storyRoleForPosition(structure, index, candidates.length),
    }))
  }

  private storyOrder(project: VideoStudioProject, candidates: readonly RankedPlanningCandidate[]): RankedPlanningCandidate[] {
    const structure = this.storyStructure(project)
    const ordered = structure === 'chronological'
      ? this.chronologicalCandidates(candidates)
      : [...candidates].sort((left, right) => left.selection_rank - right.selection_rank)
    return this.withStoryRoles(structure, ordered)
  }

  private primaryStorySelection(project: VideoStudioProject, ranked: readonly RankedPlanningCandidate[]): RankedPlanningCandidate[] {
    const intent = project.delivery_intent
    if (!intent || intent.coverage_preference === 'complete_when_feasible') return this.storyOrder(project, ranked)
    const required = ranked.filter(candidate => this.decisionForCandidate(project, candidate) === 'required')
    const selected = [...required]
    const target = this.durationTarget(intent)
    for (const candidate of ranked) {
      if (selected.some(item => item.id === candidate.id)) continue
      if (!target || compareRationalTime(this.planningDuration(selected), target) < 0) selected.push(candidate)
    }
    return this.storyOrder(project, selected)
  }

  private planningDuration(candidates: ReadonlyArray<Pick<PlanningCandidate, 'range'>>): RationalTime {
    const rate = { num: 90_000, den: 1 }
    const ticks = candidates.reduce((total, candidate) => total + parseInt64(rescaleRationalTime(candidate.range.duration, rate, 'floor').ticks), 0n)
    return rationalTime(ticks, rate)
  }

  private durationTarget(intent: NonNullable<VideoStudioProject['delivery_intent']>): RationalTime | undefined {
    if (intent.duration_mode === 'natural') return undefined
    return intent.target_duration ?? intent.target_max_duration ?? intent.target_min_duration
  }

  private async calculateDurationFeasibility(project: VideoStudioProject): Promise<VideoDurationFeasibility> {
    const intent = project.delivery_intent
    if (!intent) throw new VideoWorkbenchServiceError('请先确认交付意图后再评估时长', 409, 'VIDEO_DELIVERY_INTENT_REQUIRED')
    const candidates = await this.planningCandidates(project)
    const basis = this.planningBasis(project, candidates)
    const active = candidates.filter(candidate => this.decisionForCandidate(project, candidate) !== 'reject')
    const required = active.filter(candidate => this.decisionForCandidate(project, candidate) === 'required')
    const natural = { min: this.planningDuration(required), max: this.planningDuration(active) }
    const target = this.durationTarget(intent)
    const targetAtPlanRate = target ? rescaleRationalTime(target, natural.max.tick_rate, 'nearest') : undefined
    const tolerance = intent.exact_tolerance
      ? rescaleRationalTime(intent.exact_tolerance, natural.max.tick_rate, 'ceil')
      : rationalTime('0', natural.max.tick_rate)
    const timeline = project.current_editorial_timeline_version_id
      ? project.editorial_timeline_versions.find(item => item.id === project.current_editorial_timeline_version_id)
      : undefined
    let lockedRejected = false
    for (const item of timeline?.items ?? []) {
      if (!item.locked || item.binding.kind !== 'source') continue
      const binding = item.binding
      for (const candidate of candidates) {
        if (this.decisionForCandidate(project, candidate) !== 'reject'
          || candidate.source_id !== binding.source_id
          || candidate.source_fingerprint !== binding.source_fingerprint
          || compareRationalTime(candidate.range.start, endOfRange(binding.source_range)) >= 0
          || compareRationalTime(binding.source_range.start, endOfRange(candidate.range)) >= 0) continue
        lockedRejected = true
        break
      }
      if (lockedRejected) break
    }
    let fitStatus: VideoDurationFeasibility['fit_status'] = 'fit'
    const warnings: string[] = []
    if (!active.length) {
      fitStatus = 'insufficient_material'
      warnings.push('没有可用的 Content Segment 或可锚定 Evidence，不能虚构时长可行性。')
    } else if (lockedRejected) {
      fitStatus = 'required_conflict'
      warnings.push('已锁定的时间线条目与 reject 范围冲突，必须先由用户解除冲突。')
    } else if (targetAtPlanRate && parseInt64(natural.max.ticks) < parseInt64(targetAtPlanRate.ticks) - parseInt64(tolerance.ticks)) {
      fitStatus = 'insufficient_material'
      warnings.push('可用且未拒绝的素材不足以达到目标时长。')
    } else if (targetAtPlanRate && parseInt64(natural.min.ticks) > parseInt64(targetAtPlanRate.ticks) + parseInt64(tolerance.ticks)) {
      fitStatus = 'required_conflict'
      warnings.push('required 范围的时长已超过目标，不能靠自动变速或冻结素材凑时长。')
    } else if (targetAtPlanRate && parseInt64(natural.max.ticks) > parseInt64(targetAtPlanRate.ticks) + parseInt64(tolerance.ticks)) {
      fitStatus = 'excess_material'
      warnings.push('存在可省略素材；候选会明确列出 omission，而不会静默丢弃。')
    }
    // The public contract accepts up to 2,000 candidate ids. Do not impose a
    // smaller hidden cap on ordinary/balanced coverage; any remaining items
    // are still reported explicitly as omissions below.
    const included = active.slice(0, intent.coverage_preference === 'highlights' ? 1 : 2_000).map(item => item.id)
    const omissions = active.filter(item => !included.includes(item.id)).map(item => ({
      target_id: item.id,
      reason: intent.coverage_preference === 'highlights' ? 'highlights 策略只保留最高优先级的可用片段。' : '当前推荐变体未纳入该可选片段。',
    }))
    return {
      id: id('feasibility'),
      project_id: project.id,
      intent_revision: intent.revision,
      facts_basis_hash: basis,
      natural_duration_range: natural,
      recommended_variants: active.length ? [{
        id: id('duration_variant'),
        label: intent.duration_mode === 'natural' ? '自然时长建议' : '目标时长建议',
        estimated_duration: targetAtPlanRate ?? natural.max,
        coverage: intent.coverage_preference,
        included_segment_ids: included,
        omissions,
      }] : [],
      fit_status: fitStatus,
      warnings,
      created_at: this.iso(),
    }
  }

  /**
   * Consumer presets deliberately compile to the same DeliveryIntent that the
   * editorial planner already understands.  A preset never writes a Timeline;
   * it only gives the later evidence-bound planner a realistic starting
   * duration, coverage and editing strategy.  Advanced users can still replace
   * this intent through the explicit delivery-intent endpoint.
   */
  private deliveryIntentForCreationBrief(
    brief: VideoCreationBrief,
    planning?: AnalyzeVideoProjectInput['planning'],
  ): Omit<UpsertVideoDeliveryIntentInput, 'base_revision'> {
    const profile = {
      auto_highlight: { seconds: 60, coverage: 'highlights' as const, strategy: 'mixed' as const },
      social_short: { seconds: 45, coverage: 'highlights' as const, strategy: 'mixed' as const },
      talking_head: { seconds: 90, coverage: 'balanced' as const, strategy: 'speech_story' as const },
      interview: { seconds: 180, coverage: 'balanced' as const, strategy: 'speech_story' as const },
      tutorial: { seconds: 180, coverage: 'complete_when_feasible' as const, strategy: 'speech_story' as const },
      product_demo: { seconds: 75, coverage: 'highlights' as const, strategy: 'mixed' as const },
      event_recap: { seconds: 60, coverage: 'highlights' as const, strategy: 'mixed' as const },
      sports_highlight: { seconds: 45, coverage: 'highlights' as const, strategy: 'highlights' as const },
      podcast_clip: { seconds: 75, coverage: 'highlights' as const, strategy: 'speech_story' as const },
      custom: { seconds: 90, coverage: 'balanced' as const, strategy: 'mixed' as const },
    }[brief.use_case]
    const targetSeconds = planning?.target_duration_seconds ?? profile.seconds
    const targetDuration = Number.isInteger(targetSeconds)
      ? rationalTime(String(targetSeconds), { num: 1, den: 1 })
      : (() => {
        const text = targetSeconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
        const fractionDigits = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0
        const tickRate = { num: 10 ** fractionDigits, den: 1 }
        return rationalTimeFromDecimalSeconds(text, tickRate, 'nearest')
          ?? rationalTime(String(Math.round(targetSeconds * tickRate.num)), tickRate)
      })()
    return {
      goal: brief.user_request,
      duration_mode: 'target',
      target_duration: targetDuration,
      coverage_preference: planning?.coverage_preference ?? profile.coverage,
      editing_strategy: planning?.editing_strategy ?? profile.strategy,
    }
  }

  /** Persist the explicit choices collected by the quick-create form before
   * analysis starts.  This updates only the consumer Brief/derived Intent;
   * it never creates a Timeline, Draft, Version, Preview or Render result. */
  private async persistAnalyzeCreativeDirection(
    project: VideoStudioProject,
    input: AnalyzeVideoProjectInput,
    now: string,
  ): Promise<VideoStudioProject> {
    const currentBrief = project.creation_brief
    const creativeDirection = videoCreativeDirectionSchema.parse({
      ...(currentBrief?.creative_direction ?? {}),
      ...(input.creative_direction ?? {}),
    })
    const briefOverrides = input.brief ?? {}
    const briefBase = {
      id: currentBrief?.id ?? id('creation_brief'),
      project_id: project.id,
      use_case: briefOverrides.use_case ?? currentBrief?.use_case ?? 'custom',
      user_request: input.user_goal,
      audience: briefOverrides.audience ?? currentBrief?.audience ?? '大众观众',
      distribution: briefOverrides.distribution ?? currentBrief?.distribution ?? 'vertical_short',
      tone: briefOverrides.tone ?? currentBrief?.tone ?? 'clear',
      pace: briefOverrides.pace ?? currentBrief?.pace ?? 'balanced',
      caption_preference: briefOverrides.caption_preference ?? currentBrief?.caption_preference ?? 'auto',
      hook_strategy: briefOverrides.hook_strategy ?? currentBrief?.hook_strategy ?? 'auto',
      story_structure: briefOverrides.story_structure ?? currentBrief?.story_structure ?? 'auto',
      selection_focus: briefOverrides.selection_focus ?? currentBrief?.selection_focus ?? 'auto',
      must_preserve: briefOverrides.must_preserve ?? currentBrief?.must_preserve ?? [],
      creative_direction: creativeDirection,
      revision: (currentBrief?.revision ?? 0) + 1,
      created_at: currentBrief?.created_at ?? now,
      updated_at: now,
    }
    const currentIntent = project.delivery_intent
    const autoCompiled = !currentIntent || (
      currentBrief?.compiled_delivery_intent?.id === currentIntent.id
      && currentBrief.compiled_delivery_intent.revision === currentIntent.revision
    )
    const intent = autoCompiled
      ? {
        id: currentIntent?.id ?? id('delivery_intent'),
        project_id: project.id,
        ...this.deliveryIntentForCreationBrief(briefBase as VideoCreationBrief, input.planning),
        revision: (currentIntent?.revision ?? 0) + 1,
        created_at: currentIntent?.created_at ?? now,
        updated_at: now,
      }
      : currentIntent
    const brief = videoCreationBriefSchema.parse({
      ...briefBase,
      ...(autoCompiled ? { compiled_delivery_intent: { id: intent.id, revision: intent.revision } } : currentBrief?.compiled_delivery_intent ? { compiled_delivery_intent: currentBrief.compiled_delivery_intent } : {}),
    })
    const preliminary = videoStudioProjectSchema.parse({ ...project, creation_brief: brief, delivery_intent: intent })
    const feasibility = await this.calculateDurationFeasibility(preliminary)
    return videoStudioProjectSchema.parse({
      ...preliminary,
      duration_feasibility: feasibility,
      revision: project.revision + 1,
      updated_at: now,
    })
  }

  /**
   * The creation brief is the consumer-facing entrance to the workbench.  It
   * persists an explicit creator outcome and compiles a conservative formal
   * DeliveryIntent in the same atomic Project revision, so Quick Create and
   * remote planning do not need a hidden set of UI defaults.
   */
  async updateCreationBrief(projectId: string, raw: UpsertVideoCreationBriefInput): Promise<{
    project: VideoStudioProject
    brief: VideoCreationBrief
    intent: NonNullable<VideoStudioProject['delivery_intent']>
    feasibility: VideoDurationFeasibility
  }> {
    return await this.mutateProject(projectId, async () => {
      const input = upsertVideoCreationBriefInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('项目已更新，请刷新后重新确认创作 Brief', 409, 'VIDEO_REVISION_CONFLICT')
      const now = this.iso()
      const { base_revision: _baseRevision, ...fields } = input
      const currentBrief = project.creation_brief
      const briefBase = {
        id: currentBrief?.id ?? id('creation_brief'),
        project_id: project.id,
        ...fields,
        revision: (currentBrief?.revision ?? 0) + 1,
        created_at: currentBrief?.created_at ?? now,
        updated_at: now,
      } satisfies Omit<VideoCreationBrief, 'compiled_delivery_intent'>
      const currentIntent = project.delivery_intent
      const autoCompiled = !currentIntent || (
        currentBrief?.compiled_delivery_intent?.id === currentIntent.id
        && currentBrief.compiled_delivery_intent.revision === currentIntent.revision
      )
      let intent: NonNullable<VideoStudioProject['delivery_intent']>
      if (autoCompiled) {
        const delivery = this.deliveryIntentForCreationBrief(briefBase as VideoCreationBrief)
        intent = {
          id: currentIntent?.id ?? id('delivery_intent'),
          project_id: project.id,
          ...delivery,
          revision: (currentIntent?.revision ?? 0) + 1,
          created_at: currentIntent?.created_at ?? now,
          updated_at: now,
        }
      } else {
        // A separately saved DeliveryIntent is the advanced user's explicit
        // choice. Preserve it even when they refine audience/tone in Brief.
        intent = currentIntent
      }
      const brief: VideoCreationBrief = {
        ...briefBase,
        ...(autoCompiled
          ? { compiled_delivery_intent: { id: intent.id, revision: intent.revision } }
          : currentBrief?.compiled_delivery_intent ? { compiled_delivery_intent: currentBrief.compiled_delivery_intent } : {}),
      }
      const preliminary = videoStudioProjectSchema.parse({ ...project, creation_brief: brief, delivery_intent: intent })
      const feasibility = await this.calculateDurationFeasibility(preliminary)
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...preliminary,
        duration_feasibility: feasibility,
        revision: project.revision + 1,
        updated_at: now,
      }))
      return { project: saved, brief, intent, feasibility }
    })
  }

  async updateDeliveryIntent(projectId: string, raw: UpsertVideoDeliveryIntentInput): Promise<{
    project: VideoStudioProject
    intent: NonNullable<VideoStudioProject['delivery_intent']>
    feasibility: VideoDurationFeasibility
  }> {
    return await this.mutateProject(projectId, async () => {
      const input = upsertVideoDeliveryIntentInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('项目已更新，请刷新后重新确认交付意图', 409, 'VIDEO_REVISION_CONFLICT')
      const now = this.iso()
      const current = project.delivery_intent
      const intent = {
        id: current?.id ?? id('delivery_intent'),
        project_id: project.id,
        goal: input.goal,
        duration_mode: input.duration_mode,
        ...(input.target_duration ? { target_duration: input.target_duration } : {}),
        ...(input.target_min_duration ? { target_min_duration: input.target_min_duration } : {}),
        ...(input.target_max_duration ? { target_max_duration: input.target_max_duration } : {}),
        ...(input.exact_tolerance ? { exact_tolerance: input.exact_tolerance } : {}),
        coverage_preference: input.coverage_preference,
        editing_strategy: input.editing_strategy,
        revision: (current?.revision ?? 0) + 1,
        created_at: current?.created_at ?? now,
        updated_at: now,
      } as NonNullable<VideoStudioProject['delivery_intent']>
      const preliminary = videoStudioProjectSchema.parse({ ...project, delivery_intent: intent })
      const feasibility = await this.calculateDurationFeasibility(preliminary)
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...preliminary,
        duration_feasibility: feasibility,
        revision: project.revision + 1,
        updated_at: now,
      }))
      return { project: saved, intent, feasibility }
    })
  }

  async getDurationFeasibility(projectId: string): Promise<VideoDurationFeasibility> {
    return await this.mutateProject(projectId, async () => {
      const project = await this.requireVideoProject(projectId)
      const feasibility = project.duration_feasibility
      if (!feasibility || feasibility.intent_revision !== project.delivery_intent?.revision) {
        throw new VideoWorkbenchServiceError('时长可行性尚未生成或已过期，请重新确认交付意图', 409, 'VIDEO_DURATION_FEASIBILITY_STALE')
      }
      const candidates = await this.planningCandidates(project)
      if (feasibility.facts_basis_hash !== this.planningBasis(project, candidates)) {
        throw new VideoWorkbenchServiceError('素材或范围决定已变化，请重新确认交付意图', 409, 'VIDEO_DURATION_FEASIBILITY_STALE')
      }
      return feasibility
    })
  }

  async createSourceRangeDecision(projectId: string, raw: CreateVideoSourceRangeDecisionInput, idempotencyKey: string): Promise<{
    project: VideoStudioProject
    decision: VideoSourceRangeDecision
    feasibility?: VideoDurationFeasibility
    reused: boolean
  }> {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoSourceRangeDecisionInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const requestHash = factBasisHash({ kind: 'source_range_decision', input })
      const replay = this.editorialMutationReplay(project, 'source_range_decision', idempotencyKey, requestHash)
      if (replay) {
        const decision = project.source_range_decisions.find(item => item.id === replay[0])
        if (!decision) throw new VideoWorkbenchServiceError('范围决定幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, decision, ...(project.duration_feasibility ? { feasibility: project.duration_feasibility } : {}), reused: true }
      }
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('项目已更新，请刷新后再标记范围', 409, 'VIDEO_REVISION_CONFLICT')
      const source = project.sources.find(item => item.id === input.source_id)
      if (!source || !source.fingerprint || source.fingerprint !== input.source_fingerprint || source.missing || source.content_changed) {
        throw new VideoWorkbenchServiceError('范围决定引用的素材不可用或已变化', 409, 'VIDEO_SOURCE_FINGERPRINT_PENDING')
      }
      const sourceFact = await this.repository.getFact('source', source.id).catch(() => null)
      if (!sourceFact || !('primary_video_stream' in sourceFact) || !sourceFact.primary_video_stream.duration) {
        throw new VideoWorkbenchServiceError('缺少主视频流事实，不能接受范围决定', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      const end = endOfRange(input.range)
      const sourceEnd = endOfRange(sourceTimeRange(sourceFact.primary_video_stream.start_time, sourceFact.primary_video_stream.duration))
      if (compareRationalTime(input.range.start, sourceFact.primary_video_stream.start_time) < 0 || compareRationalTime(end, sourceEnd) > 0) {
        throw new VideoWorkbenchServiceError('范围决定超出原始主视频流时长', 400, 'VIDEO_EDITORIAL_INVALID')
      }
      const now = this.iso()
      const decision: VideoSourceRangeDecision = {
        id: id('range_decision'),
        project_id: project.id,
        source_id: input.source_id,
        source_fingerprint: input.source_fingerprint,
        range: input.range as SourceTimeRange,
        decision: input.decision,
        ...(input.reason ? { reason: input.reason } : {}),
        created_at: now,
        updated_at: now,
      }
      const preliminary = videoStudioProjectSchema.parse({ ...project, source_range_decisions: [...project.source_range_decisions, decision] })
      const feasibility = preliminary.delivery_intent ? await this.calculateDurationFeasibility(preliminary) : undefined
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...preliminary,
        ...(feasibility ? { duration_feasibility: feasibility } : {}),
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.editorialMutationReceipt('source_range_decision', idempotencyKey, requestHash, [decision.id])],
        revision: project.revision + 1,
        updated_at: now,
      }))
      return { project: saved, decision, ...(feasibility ? { feasibility } : {}), reused: false }
    })
  }

  async createEditorialPlans(projectId: string, raw: CreateVideoEditorialPlanInput, idempotencyKey: string): Promise<{
    project: VideoStudioProject
    plans: VideoEditorialPlan[]
    feasibility: VideoDurationFeasibility
    reused: boolean
  }> {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoEditorialPlanInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const requestHash = factBasisHash({ kind: 'editorial_plan', input })
      const replay = this.editorialMutationReplay(project, 'editorial_plan', idempotencyKey, requestHash)
      if (replay) {
        const plans = replay.map(id => project.editorial_plans.find(item => item.id === id)).filter((plan): plan is VideoEditorialPlan => Boolean(plan))
        if (plans.length !== replay.length || !project.duration_feasibility) throw new VideoWorkbenchServiceError('规划幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, plans, feasibility: project.duration_feasibility, reused: true }
      }
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('项目已更新，请刷新后重新规划', 409, 'VIDEO_REVISION_CONFLICT')
      const intent = project.delivery_intent
      if (!intent || (input.delivery_intent_id && input.delivery_intent_id !== intent.id)) {
        throw new VideoWorkbenchServiceError('交付意图不存在或已变化', 409, 'VIDEO_DELIVERY_INTENT_REQUIRED')
      }
      const feasibility = await this.calculateDurationFeasibility(project)
      if (feasibility.fit_status === 'required_conflict') {
        throw new VideoWorkbenchServiceError('required、reject 或锁定内容存在冲突，不能安全生成规划', 409, 'VIDEO_DURATION_REQUIRED_CONFLICT')
      }
      if (feasibility.fit_status === 'insufficient_material') {
        throw new VideoWorkbenchServiceError('可用素材不足，不能伪造剪辑规划', 409, 'VIDEO_DURATION_INSUFFICIENT_MATERIAL')
      }
      const candidates = (await this.planningCandidates(project)).filter(candidate => this.decisionForCandidate(project, candidate) !== 'reject')
      const basis = this.planningBasis(project, candidates)
      const now = this.iso()
      const target = this.durationTarget(intent)
      const ranked = this.rankPlanningCandidates(project, candidates)
      const structure = this.storyStructure(project)
      const focus = this.selectionFocus(project)
      const roleLabel: Record<VideoScene['story_role'], string> = {
        hook: '开场钩子', context: '背景铺垫', action: '核心内容', result: '结果回收', cta: '结尾行动', b_roll: '补充画面',
      }
      const chapters = ranked.slice(0, 200).map(candidate => ({
        id: id('chapter'),
        label: `${roleLabel[candidate.story_role]} · 素材片段 ${candidate.id.slice(-8)}`,
        segment_ids: [candidate.id],
        evidence_ids: candidate.evidence_ids.slice(0, 100),
        ...(target ? { target_duration: target } : {}),
        story_role: candidate.story_role,
        selection_rank: candidate.selection_rank,
        selection_score: candidate.selection_score,
        selection_reasons: candidate.selection_reasons,
      }))
      const outline: VideoEditorialPlan = {
        id: id('plan'), project_id: project.id, project_revision: project.revision, facts_basis_hash: basis,
        delivery_intent_id: intent.id, intent_revision: intent.revision, origin: 'local_conservative', provider_receipt_ids: [],
        ...(target ? { target_duration: target } : {}), kind: 'outline',
        selection_model: {
          version: 'storyboard-selection-v1',
          story_structure: structure,
          selection_focus: focus,
          ordering: structure === 'chronological' ? 'chronological' : 'narrative',
        },
        chapters,
        created_at: now,
      }
      const chapterPlans: VideoEditorialPlan[] = chapters.map(chapter => ({
        id: id('plan'), project_id: project.id, project_revision: project.revision, facts_basis_hash: basis,
        delivery_intent_id: intent.id, intent_revision: intent.revision, origin: 'local_conservative', provider_receipt_ids: [],
        ...(target ? { target_duration: target } : {}), kind: 'chapter', outline_plan_id: outline.id, chapter_id: chapter.id,
        candidate_segment_ids: chapter.segment_ids,
        omissions: [],
        story_role: chapter.story_role,
        selection_rank: chapter.selection_rank,
        selection_score: chapter.selection_score,
        selection_reasons: chapter.selection_reasons,
        created_at: now,
      }))
      const review: VideoEditorialPlan = {
        id: id('plan'), project_id: project.id, project_revision: project.revision, facts_basis_hash: basis,
        delivery_intent_id: intent.id, intent_revision: intent.revision, origin: 'local_conservative', provider_receipt_ids: [],
        ...(target ? { target_duration: target } : {}), kind: 'global_review', outline_plan_id: outline.id,
        chapter_plan_ids: chapterPlans.map(item => item.id),
        conflicts: project.creation_brief?.hook_strategy === 'strongest_moment' && !ranked.some(candidate => candidate.evidence_text)
          ? ['未获得可用于“最强时刻”排序的证据；候选仅按用户范围与素材时间顺序保守排列。']
          : [],
        omissions: feasibility.recommended_variants.flatMap(item => item.omissions), created_at: now,
      }
      const plans = [outline, ...chapterPlans, review]
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        duration_feasibility: feasibility,
        editorial_plans: [...project.editorial_plans, ...plans],
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.editorialMutationReceipt('editorial_plan', idempotencyKey, requestHash, plans.map(plan => plan.id))],
        revision: project.revision + 1,
        updated_at: now,
      }))
      return { project: saved, plans, feasibility, reused: false }
    })
  }

  private quickCreateSelections(
    project: VideoStudioProject,
    candidates: readonly PlanningCandidate[],
    maximum: number,
  ): Array<{ label: string; explanation: string; candidates: RankedPlanningCandidate[] }> {
    const ranked = this.rankPlanningCandidates(project, candidates)
    const sourceOrdered = this.withStoryRoles('chronological', this.chronologicalCandidates(ranked))
    const selected: Array<{ label: string; explanation: string; candidates: RankedPlanningCandidate[] }> = []
    const add = (label: string, explanation: string, next: RankedPlanningCandidate[]) => {
      if (!next.length || selected.length >= maximum) return
      const key = next.map(item => item.id).sort().join('\0')
      if (selected.some(item => item.candidates.map(candidate => candidate.id).sort().join('\0') === key)) return
      selected.push({ label, explanation, candidates: next })
    }
    const primary = this.primaryStorySelection(project, ranked)
    const required = this.storyOrder(project, ranked.filter(item => this.decisionForCandidate(project, item) === 'required'))
    const picked = this.storyOrder(project, ranked.filter(item => ['required', 'pick'].includes(this.decisionForCandidate(project, item) ?? 'maybe')))
    const narrative = this.storyStructure(project)
    add(
      narrative === 'chronological' ? '时间顺序候选' : '推荐叙事候选',
      narrative === 'chronological'
        ? '按未拒绝的真实素材时间顺序生成；不会覆盖任何已接受的正式时间线。'
        : `按“${narrative}”结构排序，优先采用用户保留决定和可锚定事实；没有事实的片段不会被宣称为高光。`,
      primary,
    )
    if (sourceOrdered.map(item => item.id).join('\0') !== primary.map(item => item.id).join('\0')) {
      add('完整时间顺序候选', '保留全部未拒绝片段的原始时间顺序，便于和推荐叙事方案比较。', sourceOrdered)
    }
    if (required.length && required.length < sourceOrdered.length) {
      add('必留范围候选', '仅包含用户标记为 required 的范围，便于与完整覆盖候选比较。', required)
    }
    if (picked.length && picked.length < sourceOrdered.length) {
      add('精选范围候选', '包含 required 与 pick 范围，省略 maybe 范围且在接受前保持草稿。', picked)
    }
    return selected
  }

  private async quickCreateScenes(project: VideoStudioProject, candidates: readonly RankedPlanningCandidate[]): Promise<VideoScene[]> {
    const sourceFacts = new Map<string, VideoFactSource>()
    for (const candidate of candidates) {
      if (sourceFacts.has(candidate.source_id)) continue
      const fact = await this.repository.getFact('source', candidate.source_id).catch(() => null)
      if (!fact || !('primary_video_stream' in fact) || fact.project_id !== project.id
        || fact.fingerprint_state !== 'ready' || !fact.fingerprint
        || fact.fingerprint !== candidate.source_fingerprint
        || !fact.primary_video_stream.duration) {
        throw new VideoWorkbenchServiceError('生成快速草稿所需的主视频流事实不可用', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      sourceFacts.set(candidate.source_id, fact)
    }
    return candidates.map(candidate => {
      const source = sourceFacts.get(candidate.source_id)!
      const rate = source.primary_video_stream.start_time.tick_rate
      const start = rescaleRationalTime(candidate.range.start, rate, 'nearest')
      const duration = rescaleRationalTime(candidate.range.duration, rate, 'nearest')
      const sourceStart = source.primary_video_stream.start_time
      const sourceEnd = endOfRange(sourceTimeRange(sourceStart, source.primary_video_stream.duration!))
      const rangeEnd = endOfRange(sourceTimeRange(start, duration))
      if (compareRationalTime(start, sourceStart) < 0 || compareRationalTime(rangeEnd, sourceEnd) > 0 || parseInt64(duration.ticks) <= 0n) {
        throw new VideoWorkbenchServiceError('快速草稿范围超出原始主视频流', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      const inMs = timeToMilliseconds(rationalTime(parseInt64(start.ticks) - parseInt64(sourceStart.ticks), rate))
      const durationMs = timeToMilliseconds(duration)
      const outMs = inMs + durationMs
      if (inMs < 0 || durationMs <= 0 || !Number.isSafeInteger(outMs)) {
        throw new VideoWorkbenchServiceError('快速草稿时间范围不可安全转换', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
      }
      const evidenceIds = project.evidence
        .filter(item => item.source_id === candidate.source_id && item.in_ms < outMs && item.out_ms > inMs)
        .map(item => item.id)
        .slice(0, 100)
      return {
        id: id('scene'),
        source_id: candidate.source_id,
        in_ms: inMs,
        out_ms: outMs,
        story_role: candidate.story_role,
        evidence_ids: evidenceIds,
        content_segment_ids: [candidate.id],
        rationale: `基于 Content Segment ${candidate.id} 生成。${candidate.selection_reasons.join('')}`,
        needs_review: this.storyStructure(project) !== 'chronological',
        locked: false,
      }
    })
  }

  /** Quick Create is intentionally a Draft producer. Its response may expose
   * one conservative candidate when no real curation difference exists, but
   * it never advances the formal Editorial Timeline head. */
  async quickCreate(
    projectId: string,
    raw: QuickCreateVideoInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; batch: VideoQuickCreateBatch; drafts: TimelineDraft[]; reused: boolean }> {
    const input = quickCreateVideoInputSchema.parse(raw)
    const initial = await this.requireVideoProject(projectId)
    const existingBatch = initial.quick_create_batches.find(item => item.idempotency_key === idempotencyKey)
    if (existingBatch) {
      if (existingBatch.base_revision !== input.base_revision || existingBatch.max_candidates !== input.max_candidates) {
        throw new VideoWorkbenchServiceError('同一幂等键不能生成不同快速草稿', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
      }
      const drafts = existingBatch.candidates.map(candidate => initial.timeline_drafts.find(draft => draft.id === candidate.draft_id)).filter((draft): draft is TimelineDraft => Boolean(draft))
      if (drafts.length !== existingBatch.candidates.length) throw new VideoWorkbenchServiceError('快速草稿幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
      return { project: initial, batch: existingBatch, drafts, reused: true }
    }
    if (initial.revision !== input.base_revision) {
      throw new VideoWorkbenchServiceError('项目已更新，请刷新后重新生成快速草稿', 409, 'VIDEO_REVISION_CONFLICT')
    }
    const initialCandidates = await this.planningCandidates(initial)
    const initialBasis = this.planningBasis(initial, initialCandidates)
    const intent = initial.delivery_intent
    if (!intent) throw new VideoWorkbenchServiceError('请先确认交付意图后再快速创建', 409, 'VIDEO_DELIVERY_INTENT_REQUIRED')
    const existingPlan = initial.editorial_plans.find(plan => plan.kind === 'global_review'
      && plan.delivery_intent_id === intent.id
      && plan.intent_revision === intent.revision
      && plan.facts_basis_hash === initialBasis)
    if (!existingPlan) {
      await this.createEditorialPlans(projectId, { base_revision: initial.revision, delivery_intent_id: intent.id }, `quick-create-plan-${factBasisHash({ project_id: projectId, intent_id: intent.id, basis: initialBasis }).slice(-32)}`)
    }
    return await this.mutateProject(projectId, async () => {
      const project = await this.prepareEditorialProject(projectId)
      const currentIntent = project.delivery_intent
      if (!currentIntent) throw new VideoWorkbenchServiceError('交付意图已变化，请重新确认后再快速创建', 409, 'VIDEO_DELIVERY_INTENT_REQUIRED')
      const candidates = (await this.planningCandidates(project)).filter(item => this.decisionForCandidate(project, item) !== 'reject')
      const basis = this.planningBasis(project, candidates)
      const planIds = project.editorial_plans
        .filter(plan => plan.delivery_intent_id === currentIntent.id && plan.intent_revision === currentIntent.revision && plan.facts_basis_hash === basis)
        .map(plan => plan.id)
      if (!planIds.length) throw new VideoWorkbenchServiceError('规划基础已变化，请先重新生成 Outline/Chapter/Global Review', 409, 'VIDEO_DURATION_FEASIBILITY_STALE')
      const requestHash = factBasisHash({ kind: 'quick_create', intent_revision: currentIntent.revision, facts_basis_hash: basis, plan_ids: planIds, max_candidates: input.max_candidates })
      const prior = project.quick_create_batches.find(item => item.idempotency_key === idempotencyKey)
      if (prior) {
        if (prior.base_revision !== input.base_revision || prior.max_candidates !== input.max_candidates) {
          throw new VideoWorkbenchServiceError('同一幂等键不能生成不同快速草稿', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
        }
        const drafts = prior.candidates.map(candidate => project.timeline_drafts.find(draft => draft.id === candidate.draft_id)).filter((draft): draft is TimelineDraft => Boolean(draft))
        if (drafts.length !== prior.candidates.length) throw new VideoWorkbenchServiceError('快速草稿幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, batch: prior, drafts, reused: true }
      }
      const feasibility = await this.calculateDurationFeasibility(project)
      if (feasibility.fit_status === 'required_conflict' || feasibility.fit_status === 'insufficient_material') {
        throw new VideoWorkbenchServiceError('范围、锁定项或素材数量不能安全生成快速草稿', 409, feasibility.fit_status === 'required_conflict' ? 'VIDEO_DURATION_REQUIRED_CONFLICT' : 'VIDEO_DURATION_INSUFFICIENT_MATERIAL')
      }
      const current = this.editorial.currentTimeline(project)
      if (current.tracks.some(track => track.locked) || current.items.some(item => item.locked)) {
        throw new VideoWorkbenchServiceError('快速草稿不能重排已有锁定条目；请先手工编辑或解除锁定。', 409, 'VIDEO_LOCKED_SCENE_CONFLICT')
      }
      const selectionOptions = this.quickCreateSelections(project, candidates, 3)
      const selections = selectionOptions.slice(0, input.max_candidates)
      if (!selections.length) throw new VideoWorkbenchServiceError('没有可用范围可以生成快速草稿', 409, 'VIDEO_DURATION_INSUFFICIENT_MATERIAL')
      const timings = await this.editorialTimings(project)
      const sourceBounds = await this.editorialSourceBounds(project)
      const allIds = new Set(candidates.map(item => item.id))
      const drafts: TimelineDraft[] = []
      const batchCandidates: VideoQuickCreateBatch['candidates'] = []
      for (const selection of selections) {
        const scenes = await this.quickCreateScenes(project, selection.candidates)
        const draft = this.editorial.createDraft(project, scenes, timings, planIds, sourceBounds)
        const included = new Set(selection.candidates.map(item => item.id))
        drafts.push(draft)
        batchCandidates.push({
          id: id('quick_candidate'),
          draft_id: draft.id,
          label: selection.label,
          explanation: selection.explanation,
          estimated_duration: this.planningDuration(selection.candidates),
          included_segment_ids: selection.candidates.map(item => item.id),
          omissions: [...allIds].filter(item => !included.has(item)).map(item => ({ target_id: item, reason: '该候选采用不同的范围取舍，保留为可比较 omission。' })),
        })
      }
      const explanation = selectionOptions.length === 1
        ? '当前范围决定没有形成第二个可验证的剪辑取舍，因此只提供一个保守候选。'
        : selectionOptions.length > batchCandidates.length
          ? `当前请求最多返回 ${input.max_candidates} 个候选；其余可验证取舍未在本批次创建。`
          : '候选基于不同的显式 required/pick/maybe 范围；均保持为 Draft，等待用户比较或放弃。'
      const batch: VideoQuickCreateBatch = {
        id: id('quick_batch'),
        project_id: project.id,
        idempotency_key: idempotencyKey,
        base_revision: input.base_revision,
        max_candidates: input.max_candidates,
        request_hash: requestHash,
        intent_revision: currentIntent.revision,
        facts_basis_hash: basis,
        editorial_plan_ids: planIds,
        candidates: batchCandidates,
        explanation,
        created_at: this.iso(),
      }
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        duration_feasibility: feasibility,
        timeline_drafts: [...project.timeline_drafts, ...drafts],
        quick_create_batches: [...project.quick_create_batches, batch],
        revision: project.revision + 1,
        updated_at: this.iso(),
      }))
      return { project: saved, batch, drafts, reused: false }
    })
  }

  private async assertCreativeAnchors(project: VideoStudioProject, anchors: readonly VideoCreativeContextAnchor[]): Promise<void> {
    for (const anchor of anchors) {
      if (anchor.kind === 'project') continue
      if (anchor.kind === 'source') {
        if (!project.sources.some(source => source.id === anchor.source_id)) throw new VideoWorkbenchServiceError('创作上下文引用了不存在的素材', 400, 'VIDEO_CREATIVE_ANCHOR_INVALID')
        continue
      }
      if (anchor.kind === 'camera_shot' || anchor.kind === 'content_segment' || anchor.kind === 'evidence_window') {
        const factId = anchor.kind === 'camera_shot'
          ? anchor.camera_shot_id
          : anchor.kind === 'content_segment'
            ? anchor.content_segment_id
            : anchor.evidence_window_id
        const fact = await this.repository.getFact(anchor.kind, factId).catch(() => null)
        if (!fact || !('project_id' in fact) || fact.project_id !== project.id) throw new VideoWorkbenchServiceError('创作上下文不能跨项目引用媒体事实', 400, 'VIDEO_CREATIVE_ANCHOR_INVALID')
        continue
      }
      if (anchor.kind === 'transcript_range') {
        const transcript = await this.repository.getFact('transcript', anchor.transcript_id).catch(() => null)
        if (!transcript || factKind(transcript) !== 'transcript' || transcript.project_id !== project.id) throw new VideoWorkbenchServiceError('创作上下文不能跨项目引用转写', 400, 'VIDEO_CREATIVE_ANCHOR_INVALID')
        continue
      }
      if (anchor.kind === 'timeline_range' || anchor.kind === 'timeline_item') {
        const timeline = project.editorial_timeline_versions.find(item => item.id === anchor.editorial_timeline_version_id)
        if (!timeline || (anchor.kind === 'timeline_item' && !timeline.items.some(item => item.id === anchor.item_id))) {
          throw new VideoWorkbenchServiceError('创作上下文引用的时间线已不存在', 400, 'VIDEO_CREATIVE_ANCHOR_INVALID')
        }
        continue
      }
      if (!project.delivery_variant_versions.some(item => item.id === anchor.variant_version_id)) {
        throw new VideoWorkbenchServiceError('创作上下文引用的交付变体已不存在', 400, 'VIDEO_CREATIVE_ANCHOR_INVALID')
      }
    }
  }

  async createCreativeSession(projectId: string, raw: CreateVideoCreativeSessionInput, idempotencyKey: string) {
    return await this.mutateProject(projectId, async () => {
      const input = createVideoCreativeSessionInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const requestHash = factBasisHash({ kind: 'creative_session', input })
      const replay = this.editorialMutationReplay(project, 'creative_session', idempotencyKey, requestHash)
      if (replay) {
        const session = project.creative_sessions.find(item => item.id === replay[0])
        if (!session) throw new VideoWorkbenchServiceError('创作会话幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, session, reused: true }
      }
      const session = { id: id('creative_session'), project_id: project.id, title: input.title, ...(input.recipe_id ? { recipe_id: input.recipe_id } : {}), created_at: this.iso() }
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        creative_sessions: [...project.creative_sessions, session],
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.editorialMutationReceipt('creative_session', idempotencyKey, requestHash, [session.id])],
        revision: project.revision + 1,
        updated_at: this.iso(),
      }))
      return { project: saved, session, reused: false }
    })
  }

  async postCreativeMessage(projectId: string, sessionId: string, raw: PostVideoCreativeMessageInput, idempotencyKey: string) {
    return await this.mutateProject(projectId, async () => {
      const input = postVideoCreativeMessageInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const session = project.creative_sessions.find(item => item.id === sessionId && !item.archived_at)
      if (!session) throw new VideoWorkbenchServiceError('创作会话不存在或已归档', 404, 'VIDEO_CREATIVE_SESSION_NOT_FOUND')
      const requestHash = factBasisHash({ kind: 'creative_message', session_id: sessionId, input })
      const replay = this.editorialMutationReplay(project, 'creative_message', idempotencyKey, requestHash)
      if (replay) {
        const message = project.creative_messages.find(item => item.id === replay[0])
        const response = project.creative_responses.find(item => item.id === replay[1])
        const proposal = replay[2] ? project.creative_proposals.find(item => item.id === replay[2]) : undefined
        if (!message || !response || (replay[2] && !proposal)) throw new VideoWorkbenchServiceError('创作消息幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, message, response, ...(proposal ? { proposal } : {}), reused: true }
      }
      await this.assertCreativeAnchors(project, input.anchors)
      const now = this.iso()
      const userMessageId = id('creative_message')
      const creatorBrief = project.creation_brief
      const response = {
        id: id('creative_response'), project_id: project.id, session_id: session.id, kind: 'answer' as const,
        anchors: input.anchors, evidence_ids: [],
        text: creatorBrief
          ? `已保存为创作备注。当前 Brief 是“${creatorBrief.use_case} / ${creatorBrief.distribution} / ${creatorBrief.pace}”；这条回复未调用模型，也没有修改时间线。要生成受素材证据约束的草稿，请使用分析入口；任何改动仍须接受带版本基准的 Proposal。`
          : '已保存为创作备注。这条回复未调用模型，也没有修改时间线；请先确认 Creation Brief，再使用分析入口生成受素材证据约束的草稿。任何改动仍须接受带版本基准的 Proposal。',
        created_at: now,
      }
      let proposal: VideoCreativeProposal | undefined
      if (input.proposal) {
        const candidate = input.proposal.proposed_command_set
        const proposalDraft = input.proposal.proposed_timeline_draft_id
          ? project.timeline_drafts.find(item => item.id === input.proposal!.proposed_timeline_draft_id)
          : undefined
        if (candidate && candidate.project_id !== project.id) throw new VideoWorkbenchServiceError('Proposal CommandSet 不属于当前项目', 400, 'VIDEO_CREATIVE_PROPOSAL_INVALID')
        if (input.proposal.proposed_timeline_draft_id && !proposalDraft) {
          throw new VideoWorkbenchServiceError('Proposal 引用的时间线草稿不存在', 400, 'VIDEO_CREATIVE_PROPOSAL_INVALID')
        }
        if (!candidate && !input.proposal.proposed_timeline_draft_id) {
          throw new VideoWorkbenchServiceError('可接受 Proposal 必须包含 Timeline Draft 或 typed CommandSet', 400, 'VIDEO_CREATIVE_PROPOSAL_INVALID')
        }
        proposal = {
          id: id('creative_proposal'), project_id: project.id, session_id: session.id, created_by_message_id: userMessageId,
          base_project_revision: project.revision, facts_basis_hash: editorialFactsBasisHash(project),
          ...(candidate?.target.kind === 'editorial' ? { base_timeline_version_id: candidate.target.base_timeline_version_id } : {}),
          ...(candidate?.target.kind === 'delivery_variant' ? { base_variant_version_id: candidate.target.base_variant_version_id } : {}),
          ...(!candidate && proposalDraft ? { base_timeline_version_id: proposalDraft.base_timeline_version_id } : {}),
          anchors: input.anchors, kind: input.proposal.kind, summary: input.proposal.summary, rationale: input.proposal.rationale,
          evidence_ids: input.proposal.evidence_ids,
          ...(input.proposal.proposed_timeline_draft_id ? { proposed_timeline_draft_id: input.proposal.proposed_timeline_draft_id } : {}),
          ...(candidate ? { proposed_command_set: candidate } : {}),
          ...(input.proposal.estimated_duration ? { estimated_duration: input.proposal.estimated_duration } : {}),
          ...(input.proposal.quality_report_id ? { quality_report_id: input.proposal.quality_report_id } : {}),
          provider_receipt_ids: input.proposal.provider_receipt_ids,
          actual_cost: input.proposal.actual_cost,
          status: 'proposed', created_at: now,
        }
      }
      const user = { id: userMessageId, project_id: project.id, session_id: session.id, role: 'user' as const, text: input.text, anchors: input.anchors, response_ids: [response.id], proposal_ids: proposal ? [proposal.id] : [], created_at: now }
      const assistant = { id: id('creative_message'), project_id: project.id, session_id: session.id, role: 'assistant' as const, text: response.text, anchors: input.anchors, response_ids: [response.id], proposal_ids: proposal ? [proposal.id] : [], created_at: now }
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        creative_messages: [...project.creative_messages, user, assistant],
        creative_responses: [...project.creative_responses, response],
        creative_proposals: proposal ? [...project.creative_proposals, proposal] : project.creative_proposals,
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.editorialMutationReceipt('creative_message', idempotencyKey, requestHash, [user.id, response.id, ...(proposal ? [proposal.id] : [])])],
        revision: project.revision + 1,
        updated_at: now,
      }))
      return { project: saved, message: user, response, ...(proposal ? { proposal } : {}), reused: false }
    })
  }

  async getCreativeProposal(projectId: string, proposalId: string): Promise<VideoCreativeProposal> {
    const project = await this.requireVideoProject(projectId)
    const proposal = project.creative_proposals.find(item => item.id === proposalId)
    if (!proposal) throw new VideoWorkbenchServiceError('创作 Proposal 不存在', 404, 'VIDEO_CREATIVE_PROPOSAL_NOT_FOUND')
    return proposal
  }

  async rejectCreativeProposal(projectId: string, proposalId: string, idempotencyKey: string): Promise<{ project: VideoStudioProject; proposal: VideoCreativeProposal; reused: boolean }> {
    return await this.mutateProject(projectId, async () => {
      const project = await this.requireVideoProject(projectId)
      const proposal = project.creative_proposals.find(item => item.id === proposalId)
      if (!proposal) throw new VideoWorkbenchServiceError('创作 Proposal 不存在', 404, 'VIDEO_CREATIVE_PROPOSAL_NOT_FOUND')
      const requestHash = factBasisHash({ kind: 'creative_proposal_rejection', proposal_id: proposalId })
      const replay = this.editorialMutationReplay(project, 'creative_proposal_rejection', idempotencyKey, requestHash)
      if (replay) {
        const persisted = project.creative_proposals.find(item => item.id === replay[0])
        if (!persisted) throw new VideoWorkbenchServiceError('Proposal 拒绝幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, proposal: persisted, reused: true }
      }
      if (proposal.status !== 'proposed') throw new VideoWorkbenchServiceError('创作 Proposal 已有最终决定', 409, 'VIDEO_CREATIVE_PROPOSAL_FINAL')
      const next = { ...proposal, status: 'rejected' as const }
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        creative_proposals: project.creative_proposals.map(item => item.id === proposal.id ? next : item),
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.editorialMutationReceipt('creative_proposal_rejection', idempotencyKey, requestHash, [proposal.id])],
        revision: project.revision + 1,
        updated_at: this.iso(),
      }))
      return { project: saved, proposal: next, reused: false }
    })
  }

  async acceptCreativeProposal(
    projectId: string,
    proposalId: string,
    raw: AcceptVideoCreativeProposalInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; proposal: VideoCreativeProposal; version: EditorialTimelineVersion | DeliveryVariantVersion; reused: boolean }> {
    return await this.mutateProject(projectId, async () => {
      const input = acceptVideoCreativeProposalInputSchema.parse(raw)
      let project = await this.prepareEditorialProject(projectId)
      const proposal = project.creative_proposals.find(item => item.id === proposalId)
      if (!proposal) throw new VideoWorkbenchServiceError('创作 Proposal 不存在', 404, 'VIDEO_CREATIVE_PROPOSAL_NOT_FOUND')
      if (proposal.status !== 'proposed') {
        const receipt = project.editorial_command_receipts.find(item => item.idempotency_key === idempotencyKey)
        const version = receipt && (receipt.target_kind === 'editorial'
          ? project.editorial_timeline_versions.find(item => item.id === receipt.created_version_id)
          : project.delivery_variant_versions.find(item => item.id === receipt.created_version_id))
        if (version && ['accepted', 'partially_accepted'].includes(proposal.status)) {
          return { project, proposal, version, reused: true }
        }
        throw new VideoWorkbenchServiceError('创作 Proposal 已有最终决定', 409, 'VIDEO_CREATIVE_PROPOSAL_FINAL')
      }
      if (proposal.facts_basis_hash !== editorialFactsBasisHash(project)) {
        if (proposal.status === 'proposed') {
          project = await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...project,
            creative_proposals: project.creative_proposals.map(item => item.id === proposal.id ? { ...item, status: 'stale' as const } : item),
            revision: project.revision + 1,
            updated_at: this.iso(),
          }))
        }
        throw new VideoWorkbenchServiceError('Proposal 的素材事实已变化，请重新生成建议', 409, 'VIDEO_CREATIVE_PROPOSAL_STALE')
      }
      let commandSet = proposal.proposed_command_set
      if (!commandSet && proposal.proposed_timeline_draft_id) {
        const draft = project.timeline_drafts.find(item => item.id === proposal.proposed_timeline_draft_id)
        const current = this.editorial.currentTimeline(project)
        if (!draft || draft.status !== 'proposed' || draft.base_timeline_version_id !== current.id || draft.facts_basis_hash !== editorialFactsBasisHash(project)) {
          throw new VideoWorkbenchServiceError('Proposal 中的时间线草稿已过期', 409, 'VIDEO_CREATIVE_PROPOSAL_STALE')
        }
        commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: STANDALONE_VIDEO_OWNER.owner_id,
          idempotency_key: idempotencyKey,
          created_at: this.iso(),
          target: { kind: 'editorial', base_timeline_version_id: current.id },
          commands: [
            ...(current.items.length ? [{ kind: 'ripple_delete' as const, item_ids: current.items.map(item => item.id), close_gap: false }] : []),
            ...draft.items.map(item => ({ kind: 'insert' as const, track_id: item.track_id, item })),
          ],
        })
      }
      if (!commandSet) throw new VideoWorkbenchServiceError('该 Proposal 只有只读回答，不能被接受', 409, 'VIDEO_CREATIVE_PROPOSAL_NOT_ACCEPTABLE')
      let commands: unknown = commandSet.commands
      const indexes = input.command_indexes
      if (indexes) {
        if (new Set(indexes).size !== indexes.length || indexes.some(index => index >= commandSet!.commands.length)) {
          throw new VideoWorkbenchServiceError('部分接受包含无效的 CommandSet 序号', 400, 'VIDEO_CREATIVE_PROPOSAL_INVALID')
        }
        commands = indexes.map(index => commandSet!.commands[index]!)
      }
      if (!Array.isArray(commands) || !commands.length) throw new VideoWorkbenchServiceError('至少选择一条 Proposal CommandSet 命令', 400, 'VIDEO_CREATIVE_PROPOSAL_INVALID')
      if (commandSet.target.kind === 'editorial' && proposal.base_timeline_version_id !== commandSet.target.base_timeline_version_id) {
        throw new VideoWorkbenchServiceError('Proposal 的编辑版本基准不一致', 409, 'VIDEO_CREATIVE_PROPOSAL_STALE')
      }
      if (commandSet.target.kind === 'delivery_variant' && proposal.base_variant_version_id !== commandSet.target.base_variant_version_id) {
        throw new VideoWorkbenchServiceError('Proposal 的交付版本基准不一致', 409, 'VIDEO_CREATIVE_PROPOSAL_STALE')
      }
      const acceptedCommandSet = timelineCommandSetSchema.parse({
        ...commandSet,
        id: `command_${randomUUID().replaceAll('-', '')}`,
        project_id: project.id,
        actor_id: STANDALONE_VIDEO_OWNER.owner_id,
        idempotency_key: idempotencyKey,
        created_at: this.iso(),
        commands,
      })
      let applied: ReturnType<EditorialApplication['applyCommandSet']>
      try {
        applied = this.editorial.applyCommandSet(project, acceptedCommandSet, await this.editorialSourceBounds(project))
      } catch (error) {
        return this.editorialError(error)
      }
      const nextProposal: VideoCreativeProposal = {
        ...proposal,
        status: indexes && indexes.length < commandSet.commands.length ? 'partially_accepted' : 'accepted',
      }
      const next = videoStudioProjectSchema.parse({
        ...applied.project,
        creative_proposals: applied.project.creative_proposals.map(item => item.id === proposal.id ? nextProposal : item),
        ...(applied.reused ? { revision: project.revision + 1, updated_at: this.iso() } : {}),
      })
      const saved = await this.repository.saveProject(next)
      return { project: saved, proposal: nextProposal, version: applied.version, reused: applied.reused }
    })
  }

  /** Decode audio locally and stream the temporary WAV to the Relay's object
   * capability.  The host stores only the returned immutable transcript. */
  private async remoteTranscriptEvidence(
    project: VideoStudioProject,
    source: VideoSource,
    sourceFact: VideoFactSource,
    directory: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<RemoteTranscriptResult | null> {
    if (!source.has_audio || sourceFact.fingerprint_state !== 'ready' || !sourceFact.fingerprint) return null
    const localOperationId = `${operationId}_asr_${source.id}`
    // A transcript fact is committed before the Relay result is ACKed. On a
    // restart it is therefore the authoritative recovery point: do not send
    // audio again merely because the project-level analysis has not yet
    // materialized its summary projection.
    const persisted = (await this.repository.listFacts('transcript', project.id, source.id))
      .filter((fact): fact is TimedTranscript => 'segments' in fact)
      .find(fact => fact.source_fingerprint === sourceFact.fingerprint)
    if (persisted) return {
      evidence: this.transcriptEvidence(persisted),
      acknowledgements: persisted.relay_operation_id
        && persisted.relay_result_hashes
        && !persisted.segments.every(segment => project.evidence.some(item => item.id === segment.id))
        ? [this.acknowledgementFor(localOperationId, persisted.relay_operation_id, persisted.model_receipt_id, persisted.relay_result_hashes)]
        : [],
    }
    const consent = project.remote_analysis_consents.find(item => item.state === 'active' && item.purposes.includes('asr') && item.data_kinds.includes('audio_extract'))
    const budget = consent && project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
    const relay = this.videoMediaRelay(signal)
    const primaryDuration = sourceFact.primary_video_stream.duration
    if (!primaryDuration) throw new VideoWorkbenchServiceError('素材缺少原始视频流时长，拒绝发送 ASR', 502, 'VIDEO_ANALYSIS_INVALID')
    const sourceRange = { start: sourceFact.primary_video_stream.start_time, duration: primaryDuration }
    const covered = consent?.coverage.find(item => item.source_id === source.id)?.ranges.some(range => (
      compareRationalTime(sourceRange.start, range.start) >= 0
      && compareRationalTime(endOfRange(sourceRange), endOfRange(range)) <= 0
    ))
    if (!consent || !budget || !relay || !covered) return null

    let checkpoint = await this.saveAsrCheckpoint(operationId, source.id, {})
    let remote: Awaited<ReturnType<VideoMediaRelayClient['operation']>> | undefined
    let cancellationRequested = checkpoint?.state === 'cancel_pending' || signal.aborted
    if (checkpoint?.relay_operation_id) {
      // Restart path: only the recorded Relay id may be polled. It never
      // re-opens a media lease, re-uploads audio, or re-submits to Fun-ASR.
      try {
        const control = cancellationRequested ? this.videoMediaRelay() : relay
        if (!control) throw new VideoMediaRelayClientError(503, 'relay_control_unavailable')
        remote = await control.operation(checkpoint.relay_operation_id)
      } catch (error) {
        if (signal.aborted) {
          cancellationRequested = true
          await this.saveAsrCheckpoint(operationId, source.id, { state: 'cancel_pending', relay_operation_id: checkpoint.relay_operation_id })
          const control = this.videoMediaRelay()
          if (control) {
            try {
              remote = await control.operation(checkpoint.relay_operation_id)
            } catch {
              throw error
            }
          }
        }
        if (!remote) throw error
      }
    } else if (checkpoint?.remote_submission_started_at) {
      // The local fence may commit immediately before the Relay POST response
      // (and therefore its id) is lost. Resolve only through Relay's durable
      // local_operation_id index. A healthy 404 proves provider_not_started;
      // transport/5xx remains fenced and must never blind-submit again.
      try {
        const control = cancellationRequested ? this.videoMediaRelay() : relay
        if (!control) throw new VideoMediaRelayClientError(503, 'relay_control_unavailable')
        remote = await control.operationByLocalOperationId(localOperationId) ?? undefined
      } catch (error) {
        await this.saveAsrCheckpoint(operationId, source.id, { state: cancellationRequested ? 'cancel_pending' : 'outcome_unknown' })
        throw error
      }
      if (remote) {
        checkpoint = await this.saveAsrCheckpoint(operationId, source.id, {
          state: cancellationRequested
            ? 'cancel_pending'
            : remote.state === 'succeeded'
              ? 'result_pending'
              : remote.state === 'running' ? 'running' : remote.state === 'submitted' || remote.state === 'accepted' ? 'submitted' : remote.state,
          relay_operation_id: remote.id,
          ...(remote.provider_task_id ? { provider_task_id: remote.provider_task_id } : {}),
        }) ?? checkpoint
      } else {
        // Relay's authoritative absence proof releases even a prior
        // outcome_unknown allocation; reserveRemoteBudget then revives exactly
        // the same allocation for the deterministic idempotent replay.
        await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, new VideoMediaRelayClientError(503, 'provider_not_started'))
        if (cancellationRequested) {
          await this.saveAsrCheckpoint(operationId, source.id, { state: 'cancelled' })
          throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
        }
      }
    }
    if (!remote) {
      if (checkpoint?.remote_submission_started_at && !checkpoint.object_ref) {
        await this.saveAsrCheckpoint(operationId, source.id, { state: 'outcome_unknown' })
        throw new VideoWorkbenchServiceError('ASR 提交栅栏缺少已持久化对象引用', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
      }
      const audioPath = join(directory, `${source.id}-asr.wav`)
      const extraction = await this.runProcess([
        videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-loglevel', 'error', '-i', source.path,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', audioPath,
      ], { signal })
      const audio = await stat(audioPath).catch(() => null)
      if (extraction.exitCode !== 0 || !audio?.isFile() || audio.size <= 44) {
        throw new VideoWorkbenchServiceError('本地音轨提取失败，拒绝提交不完整 ASR 输入', 502, 'VIDEO_ANALYSIS_INVALID')
      }
      const contentHash = await videoFingerprint(audioPath)
      const scopeHash = factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds })
      const route = selectFunAsrRoute({ sourceDurationMs: source.duration_ms, needsSpeakerDiarization: false, hotwords: [] })
      const reservedUsage = {
        requests: 1, total_tokens: 0, input_bytes: audio.size, visual_frames: 0, proxy_seconds: 0, asr_seconds: timeToMilliseconds(primaryDuration) / 1000, estimated_amount_micros: Math.max(1, Math.ceil(timeToMilliseconds(primaryDuration) / 1000 * VIDEO_REMOTE_USAGE_POLICY.asrSecondMicros)),
      }
      await this.reserveRemoteBudget(project.id, budget.id, localOperationId, 'speech_transcription', reservedUsage)
      let objectRef = checkpoint?.object_ref
      if (!objectRef) {
        try {
          objectRef = await relay.uploadObjectStream({
            local_operation_id: localOperationId, purpose: 'audio_for_asr', content_hash: contentHash, byte_size: audio.size, content_type: 'audio/wav',
            consent_revision_id: consent.id, consent_scope_hash: scopeHash,
            remote_consent_claim: this.remoteConsentClaim(project, consent, relay, 'asr'),
          }, () => Readable.toWeb(createReadStream(audioPath)) as unknown as ReadableStream<Uint8Array>)
          const uploaded = await this.saveAsrCheckpoint(operationId, source.id, { object_ref: objectRef, state: 'uploading' })
          if (!uploaded?.object_ref) throw new VideoWorkbenchServiceError('ASR 对象检查点持久化失败，已拒绝远程提交', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
          checkpoint = uploaded
        } catch (error) {
          // No provider submission can have happened in this phase. Release
          // the local allocation with a known-safe classification so the same
          // deterministic upload/Operation may resume without outcome_unknown.
          const quotaError = videoHostedQuotaError(error)
          await this.finalizeRemoteBudgetFailure(
            project.id,
            budget.id,
            localOperationId,
            quotaError ? error : new VideoMediaRelayClientError(422, 'relay_upload_failed_before_submission'),
          )
          throw quotaError ?? error
        }
      }
      if (!checkpoint?.remote_submission_started_at) {
        try {
          // This is the last durable write before the sole Relay operation
          // POST. A crash after it recovers only by lookup/idempotent replay.
          const fenced = await this.saveAsrCheckpoint(operationId, source.id, {
            object_ref: objectRef,
            state: 'submitting',
            remote_submission_started_at: this.iso(),
          })
          if (!fenced?.remote_submission_started_at || fenced.object_ref !== objectRef) {
            throw new VideoWorkbenchServiceError('ASR 提交栅栏持久化失败，已拒绝远程提交', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
          }
          checkpoint = fenced
        } catch (error) {
          await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, new VideoMediaRelayClientError(422, 'local_submission_fence_failed'))
          throw error
        }
      }
      const asrRequest: RelayOperationRequest = {
        local_operation_id: localOperationId, consent_revision_id: consent.id, consent_scope_hash: scopeHash, local_budget_reservation_id: budget.id,
        request_hash: factBasisHash({ model: route === 'long_async' ? VIDEO_REMOTE_MODEL_BINDINGS.longAsr : VIDEO_REMOTE_MODEL_BINDINGS.shortAsr, source_id: source.id, source_fingerprint: sourceFact.fingerprint, audio_hash: contentHash, source_range: sourceRange, route }),
        capability: 'speech_transcription', application_role: 'asr',
        input: { mode: route, audio_object_ref: objectRef, source_offset: sourceFact.primary_video_stream.start_time, language: 'zh', hotwords: [], speaker_diarization: false, sentence_timestamps: true, word_timestamps: true },
      }
      try {
        remote = await relay.createOperation(await this.authorizeRelayOperation(project.id, relay, asrRequest))
      } catch (error) {
        const quotaError = videoHostedQuotaError(error)
        if (quotaError) {
          await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, error, { submissionFenced: true })
          await this.saveAsrCheckpoint(operationId, source.id, {
            state: 'failed',
            object_ref: objectRef,
            relay_operation_id: undefined,
            provider_task_id: undefined,
            remote_submission_started_at: undefined,
            next_poll_at: undefined,
          })
          throw quotaError
        }
        await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, error, { submissionFenced: true })
        cancellationRequested ||= signal.aborted
        checkpoint = await this.saveAsrCheckpoint(operationId, source.id, {
          state: cancellationRequested ? 'cancel_pending' : 'outcome_unknown',
          object_ref: objectRef,
        }) ?? checkpoint
        // Resolve the post-fence response-loss window immediately through the
        // owner-scoped index. A healthy 404 is the sole authority to retry the
        // exact persisted request; transport failure leaves the parent running.
        const control = this.videoMediaRelay()
        if (!control) throw error
        let existing: RelayOperationProjection | null
        try {
          existing = await control.operationByLocalOperationId(localOperationId)
        } catch {
          throw error
        }
        if (existing) {
          remote = existing
        } else {
          await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, new VideoMediaRelayClientError(503, 'provider_not_started'))
          if (cancellationRequested) {
            await this.saveAsrCheckpoint(operationId, source.id, { state: 'cancelled' })
            throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
          }
          await this.reserveRemoteBudget(project.id, budget.id, localOperationId, 'speech_transcription', reservedUsage)
          try {
            remote = await control.createOperation(await this.authorizeRelayOperation(project.id, control, asrRequest))
          } catch (retryError) {
            const quotaError = videoHostedQuotaError(retryError)
            if (quotaError) {
              await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, retryError, { submissionFenced: true })
              await this.saveAsrCheckpoint(operationId, source.id, {
                state: 'failed',
                object_ref: objectRef,
                relay_operation_id: undefined,
                provider_task_id: undefined,
                remote_submission_started_at: undefined,
                next_poll_at: undefined,
              })
              throw quotaError
            }
            await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, retryError, { submissionFenced: true })
            await this.saveAsrCheckpoint(operationId, source.id, { state: 'outcome_unknown', object_ref: objectRef })
            throw retryError
          }
        }
      }
      checkpoint = await this.saveAsrCheckpoint(operationId, source.id, {
        state: cancellationRequested
          ? 'cancel_pending'
          : remote.state === 'succeeded'
            ? 'result_pending'
            : remote.state === 'running' ? 'running' : remote.state === 'submitted' || remote.state === 'accepted' ? 'submitted' : remote.state,
        relay_operation_id: remote.id,
        ...(remote.provider_task_id ? { provider_task_id: remote.provider_task_id } : {}),
      }) ?? checkpoint
    }
    if (!remote) throw new VideoWorkbenchServiceError('ASR 远程操作恢复失败', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
    while (remote.state === 'submitted' || remote.state === 'running' || remote.state === 'accepted') {
      if (signal.aborted && !cancellationRequested) {
        cancellationRequested = true
        checkpoint = await this.saveAsrCheckpoint(operationId, source.id, { state: 'cancel_pending', relay_operation_id: remote.id }) ?? checkpoint
      }
      if (cancellationRequested) {
        const cancelled = await this.requestAsrCancellation(operationId, source.id, remote.id)
        if (cancelled) {
          remote = cancelled
          break
        }
      }
      // The Relay supplies its own backoff. Respect a short positive value in
      // tests and bounded deployments; when omitted, retain the 1s default.
      const delay = Math.max(1, Math.min(60_000, remote.retry_after_ms ?? 1_000))
      checkpoint = await this.saveAsrCheckpoint(operationId, source.id, {
        state: cancellationRequested ? 'cancel_pending' : remote.state === 'running' ? 'running' : 'submitted',
        relay_operation_id: remote.id,
        ...(remote.provider_task_id ? { provider_task_id: remote.provider_task_id } : {}),
        next_poll_at: new Date(this.now().getTime() + delay).toISOString(),
      }) ?? checkpoint
      try {
        await this.waitForAsrPoll(delay, cancellationRequested ? new AbortController().signal : signal)
      } catch (error) {
        if (signal.aborted) {
          cancellationRequested = true
          checkpoint = await this.saveAsrCheckpoint(operationId, source.id, { state: 'cancel_pending', relay_operation_id: remote.id }) ?? checkpoint
          continue
        }
        throw error
      }
      try {
        const control = cancellationRequested ? this.videoMediaRelay() : relay
        if (!control) throw new VideoMediaRelayClientError(503, 'relay_control_unavailable')
        remote = await control.operation(remote.id)
      } catch (error) {
        // While cancellation is pending, every wait and control request is
        // bounded but a transient failure does not discard the durable intent.
        if (cancellationRequested) continue
        throw error
      }
      checkpoint = await this.saveAsrCheckpoint(operationId, source.id, {
        state: cancellationRequested
          ? 'cancel_pending'
          : remote.state === 'succeeded'
            ? 'result_pending'
            : remote.state === 'running' ? 'running' : remote.state === 'submitted' || remote.state === 'accepted' ? 'submitted' : remote.state,
        relay_operation_id: remote.id,
        ...(remote.provider_task_id ? { provider_task_id: remote.provider_task_id } : {}),
      }) ?? checkpoint
    }
    cancellationRequested ||= signal.aborted
    if (cancellationRequested) {
      await this.finalizeAsrTerminalBudget(
        project.id,
        localOperationId,
        remote,
        remote.state === 'cancelled' ? 'cancelled' : 'late_cancelled_result',
      )
      await this.saveAsrCheckpoint(operationId, source.id, { state: 'cancelled', relay_operation_id: remote.id })
      throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
    }
    if (remote.state === 'cancelled') {
      await this.finalizeAsrTerminalBudget(project.id, localOperationId, remote, 'cancelled')
      await this.saveAsrCheckpoint(operationId, source.id, { state: 'cancelled', relay_operation_id: remote.id })
      throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
    }
    if (remote.state === 'expired') {
      await this.finalizeAsrTerminalBudget(project.id, localOperationId, remote, 'expired')
      await this.saveAsrCheckpoint(operationId, source.id, { state: 'expired', relay_operation_id: remote.id })
      throw new VideoWorkbenchServiceError('ASR 结果保留期已过期', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
    }
    if (remote.state !== 'succeeded' || !remote.provider_receipt) {
      if (remote.state === 'failed') await this.finalizeAsrTerminalBudget(project.id, localOperationId, remote, 'failed')
      await this.saveAsrCheckpoint(operationId, source.id, {
        state: remote.state === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
        relay_operation_id: remote.id,
      })
      throw new VideoMediaRelayClientError(remote.state === 'outcome_unknown' ? 503 : 422, 'relay_operation_not_succeeded')
    }
    // The provider accepted and accounted for this operation. Persist the
    // receipt before parsing its result so a local post-processing fault can
    // never silently release a real ASR charge.
    await this.settleRemoteBudget(project.id, budget.id, localOperationId, remote.provider_receipt)
    await this.saveAsrCheckpoint(operationId, source.id, {
      state: 'result_pending',
      relay_operation_id: remote.id,
      ...(remote.provider_task_id ? { provider_task_id: remote.provider_task_id } : {}),
    })
    const downloaded = await relay.downloadResult<{ kind: string; sentences: unknown }>(remote)
    if (downloaded.result.kind !== 'asr' || !Array.isArray(downloaded.result.sentences)) {
      await this.saveAsrCheckpoint(operationId, source.id, { state: 'failed', relay_operation_id: remote.id })
      throw new VideoWorkbenchServiceError('ASR 返回的时间戳结果无效', 502, 'VIDEO_ANALYSIS_INVALID')
    }
    const sentences = downloaded.result.sentences.flatMap((item): RemoteAsrSentence[] => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      const words = Array.isArray(value.words) ? value.words.flatMap(word => {
        if (!word || typeof word !== 'object') return []
        const row = word as Record<string, unknown>
        return typeof row.text === 'string' && typeof row.begin_time === 'number' && typeof row.end_time === 'number'
          ? [{ text: row.text, begin_time: row.begin_time, end_time: row.end_time, ...(typeof row.confidence === 'number' ? { confidence: row.confidence } : {}) }]
          : []
      }) : []
      return typeof value.text === 'string' && typeof value.begin_time === 'number' && typeof value.end_time === 'number'
        ? [{ text: value.text, begin_time: value.begin_time, end_time: value.end_time, ...(typeof value.speaker_id === 'string' ? { speaker_id: value.speaker_id } : {}), words }]
        : []
    })
    const segments = normalizeFunAsrSentences(sentences, sourceFact.primary_video_stream.start_time)
    if (!segments.length) {
      await this.saveAsrCheckpoint(operationId, source.id, { state: 'failed', relay_operation_id: remote.id })
      throw new VideoWorkbenchServiceError('ASR 未返回可验证的句级时间戳', 502, 'VIDEO_ANALYSIS_INVALID')
    }
    const transcript: TimedTranscript = {
      id: id('evidence'), project_id: project.id, source_id: source.id, source_fingerprint: sourceFact.fingerprint!,
      model_receipt_id: remote.provider_receipt.id,
      relay_operation_id: remote.id,
      relay_result_hashes: downloaded.hashes,
      source_offset: sourceFact.primary_video_stream.start_time,
      language: 'zh', segments: segments.map(segment => ({ ...segment, source_id: source.id })), created_at: this.iso(),
    }
    await this.repository.saveFact(transcript)
    await this.saveAsrCheckpoint(operationId, source.id, {
      state: 'succeeded',
      relay_operation_id: remote.id,
      ...(remote.provider_task_id ? { provider_task_id: remote.provider_task_id } : {}),
    })
    return {
      evidence: this.transcriptEvidence(transcript),
      acknowledgements: [this.acknowledgementFor(localOperationId, remote.id, remote.provider_receipt.id, downloaded.hashes)],
    }
  }

  /** Projects retain a compact transcript projection, while the immutable Fact
   * is the recovery authority and carries original-source PTS. */
  private transcriptEvidence(transcript: TimedTranscript): VideoEvidence[] {
    const origin = parseInt64(transcript.source_offset.ticks)
    return transcript.segments.map(segment => ({
      // A segment id is immutable within its transcript Fact, so the compact
      // Project projection can be recovered without inventing a second id.
      id: segment.id, kind: 'transcript' as const, source_id: transcript.source_id, source_fingerprint: transcript.source_fingerprint,
      in_ms: Math.max(0, timeToMilliseconds(rationalTime(parseInt64(segment.start.ticks) - origin, segment.start.tick_rate))),
      out_ms: Math.max(1, timeToMilliseconds(rationalTime(parseInt64(endOfRange({ start: segment.start, duration: segment.duration }).ticks) - origin, segment.start.tick_rate))),
      text: segment.text, confidence: 1, warnings: [], created_at: this.iso(),
    }))
  }

  private async extractVideoAnalysisInputs(
    project: VideoStudioProject,
    operationId: string,
    signal: AbortSignal,
  ): Promise<ExtractedVideoAnalysisInputs> {
    const directory = join(this.repository.paths().root, 'analysis', operationId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const frames: VideoAnalysisFrame[] = []
    const transcripts: VideoEvidence[] = []
    const acknowledgements: PendingRelayAcknowledgement[] = []
    const gaps: string[] = []
    const sourceFacts = new Map<string, VideoFactSource>()
    for (const source of project.sources) {
      const fact = await this.repository.getFact('source', source.id).catch(() => null)
      if (fact && 'fast_identity' in fact) sourceFacts.set(source.id, fact)
    }
    const evidenceWindows = new Map(
      (await this.repository.listFacts('evidence_window', project.id) as EvidenceWindow[])
        .map(window => [window.id, window]),
    )
    try {
      for (const source of project.sources) {
        if (signal.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
        const sourceFact = sourceFacts.get(source.id)
        if (!sourceFact) continue
        const transcript = await this.remoteTranscriptEvidence(project, source, sourceFact, directory, operationId, signal)
        if (transcript) {
          transcripts.push(...transcript.evidence)
          acknowledgements.push(...transcript.acknowledgements)
        }
        else if (source.has_audio) gaps.push(`${source.name} 没有覆盖完整原始音频的 ASR 授权、预算或 Relay；未发送音频。`)
        const windows = [...evidenceWindows.values()].filter(window => (
          window.source_id === source.id
          && window.source_fingerprint === sourceFact.fingerprint
        ))
        if (!windows.length) {
          gaps.push(`${source.name} 没有可用 Evidence Window，未向视觉模型发送素材。`)
          continue
        }
        let extractedFrames = 0
        for (const window of windows) {
          const sampling = this.evidenceWindowSampling(sourceFact, source, window)
          if (!sampling) {
            gaps.push(window.sample_strategy === 'short_proxy'
              ? `${source.name} 的 Evidence Window 仅允许短代理；当前没有可用代理解码器。`
              : `${source.name} 的 Evidence Window 需要关键帧变化点；当前没有可用 keyframe derivative。`)
            continue
          }
          for (const [frameIndex, frameTimeMs] of sampling.times.entries()) {
            if (signal.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
            const framePath = join(directory, `${source.id}-${window.id}-${frameIndex}.jpg`)
            const frame = await this.runProcess([
              videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-loglevel', 'error',
              '-ss', (frameTimeMs / 1000).toFixed(3), '-i', source.path,
              '-frames:v', '1', '-vf', 'scale=1280:-2:force_original_aspect_ratio=decrease',
              '-q:v', '3', '-y', framePath,
            ], { signal }).catch(() => null)
            const bytes = frame?.exitCode === 0 ? await readFile(framePath).catch(() => null) : null
            if (!bytes?.length) continue
            frames.push({
              source_id: source.id,
              in_ms: frameTimeMs,
              range_end_ms: sampling.end_ms,
              evidence_window_id: window.id,
              data_url: `data:image/jpeg;base64,${bytes.toString('base64')}`,
            })
            extractedFrames += 1
          }
        }
        if (extractedFrames === 0) gaps.push(`${source.name} 未能抽取画面证据。`)
      }

      // Legacy projects without a Media Facts source remain readable during the
      // migration window. This compatibility reader is intentionally isolated:
      // all newly imported sources above must have an Evidence Window first.
      const legacySources = project.sources.filter(source => !sourceFacts.has(source.id))
      for (const source of legacySources) {
        const frameTimes = [...new Set([0.1, 0.5, 0.9].map(position => (
          Math.max(0, Math.min(source.duration_ms - 1, Math.floor(source.duration_ms * position)))
        )))]
        let extractedFrames = 0
        for (const [frameIndex, frameTimeMs] of frameTimes.entries()) {
          if (signal.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
          const framePath = join(directory, `${source.id}-legacy-${frameIndex}.jpg`)
          const frame = await this.runProcess([
            videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-loglevel', 'error',
            '-ss', (frameTimeMs / 1000).toFixed(3), '-i', source.path,
            '-frames:v', '1', '-vf', 'scale=1280:-2:force_original_aspect_ratio=decrease',
            '-q:v', '3', '-y', framePath,
          ], { signal }).catch(() => null)
          const bytes = frame?.exitCode === 0 ? await readFile(framePath).catch(() => null) : null
          if (!bytes?.length) continue
          frames.push({ source_id: source.id, in_ms: frameTimeMs, data_url: `data:image/jpeg;base64,${bytes.toString('base64')}` })
          extractedFrames += 1
        }
        if (extractedFrames === 0) gaps.push(`${source.name} 未能抽取画面证据。`)
        else if (extractedFrames < frameTimes.length) gaps.push(`${source.name} 仅抽取到 ${extractedFrames}/${frameTimes.length} 个画面采样点。`)
        if (source.has_audio) {
          // Legacy projects remain readable, but new remote submissions may
          // never re-enter the product-voice Gateway. A Relay-backed ASR
          // operation is scheduled only after the project records Consent.
          gaps.push(`${source.name} 的历史音频未重新发送；请确认远程分析范围后通过 Video Media Relay 转写。`)
        }
      }
      return { frames, transcripts, relay_acknowledgements: acknowledgements, gaps, source_facts: sourceFacts, evidence_windows: evidenceWindows }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private evidenceWindowSampling(
    sourceFact: VideoFactSource,
    source: VideoSource,
    window: EvidenceWindow,
  ): { times: number[]; end_ms: number } | null {
    const sourceRate = sourceFact.primary_video_stream.start_time.tick_rate
    const rangeStart = rescaleRationalTime(window.range.start, sourceRate, 'floor')
    const rangeEnd = rescaleRationalTime(endOfRange(window.range), sourceRate, 'ceil')
    const sourceStart = parseInt64(sourceFact.primary_video_stream.start_time.ticks)
    const startMs = Math.max(0, timeToMilliseconds(rationalTime(parseInt64(rangeStart.ticks) - sourceStart, sourceRate)))
    const endMs = Math.max(startMs + 1, Math.min(source.duration_ms, timeToMilliseconds(rationalTime(parseInt64(rangeEnd.ticks) - sourceStart, sourceRate))))
    if (window.sample_strategy === 'short_proxy' || window.sample_strategy === 'visual_change_points') return null
    const duration = Math.max(1, endMs - startMs)
    const at = (ratio: number) => Math.max(startMs, Math.min(endMs - 1, startMs + Math.floor(duration * ratio)))
    const times = window.sample_strategy === 'representative_frame'
      ? [at(0.5)]
      : [at(0), at(0.5), at(1)]
    return { times: [...new Set(times)], end_ms: endMs }
  }

  private sourceRangeFromDisplayMilliseconds(source: VideoFactSource, inMs: number, outMs: number): SourceTimeRange {
    const rate = source.primary_video_stream.start_time.tick_rate
    const startOffset = rescaleRationalTime(rationalTime(String(inMs), { num: 1000, den: 1 }), rate, 'floor')
    const endOffset = rescaleRationalTime(rationalTime(String(outMs), { num: 1000, den: 1 }), rate, 'ceil')
    const start = parseInt64(source.primary_video_stream.start_time.ticks) + parseInt64(startOffset.ticks)
    const end = parseInt64(source.primary_video_stream.start_time.ticks) + parseInt64(endOffset.ticks)
    return sourceTimeRange(rationalTime(start, rate), rationalTime(end - start, rate))
  }

  private materializeVideoEvidence(
    project: VideoStudioProject,
    drafts: Awaited<ReturnType<typeof analyzeVideoEvidence>>['evidence'],
  ): VideoEvidence[] {
    const sources = new Map(project.sources.map(source => [source.id, source]))
    return drafts.map(draft => {
      const source = sources.get(draft.source_id)
      if (!source?.fingerprint || draft.out_ms > source.duration_ms) {
        throw new VideoWorkbenchServiceError('分析引用了不存在的素材时间', 502, 'VIDEO_ANALYSIS_INVALID')
      }
      return { id: id('evidence'), ...draft, source_fingerprint: source.fingerprint, created_at: this.iso() }
    })
  }

  /**
   * New visual analysis uploads only a bounded, window-authorized keyframe via
   * an object lease.  The provider response is treated as untrusted evidence
   * and is re-bound to the Host-selected source range before it can enter
   * SQLite or the project projection.
   */
  private async remoteVisualEvidence(
    project: VideoStudioProject,
    operationId: string,
    extracted: ExtractedVideoAnalysisInputs,
    signal: AbortSignal,
  ): Promise<RemoteVisualEvidenceResult | null> {
    const consent = project.remote_analysis_consents.find(item => item.state === 'active' && item.purposes.includes('visual_evidence') && item.data_kinds.includes('keyframes'))
    const budget = consent && project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
    const relay = this.videoMediaRelay(signal)
    if (!consent || !budget || !relay) return null
    const scopeHash = factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds })
    const output: RemoteVisualEvidenceResult['evidence'] = []
    const acknowledgements: PendingRelayAcknowledgement[] = []
    for (const [index, frame] of extracted.frames.entries()) {
      if (!frame.evidence_window_id) continue
      const source = extracted.source_facts.get(frame.source_id)
      const window = extracted.evidence_windows.get(frame.evidence_window_id)
      if (!source || !window || source.fingerprint_state !== 'ready' || !source.fingerprint) continue
      const range = this.sourceRangeFromDisplayMilliseconds(source, frame.in_ms, frame.range_end_ms ?? frame.in_ms + 1)
      const coverage = consent.coverage.find(item => item.source_id === frame.source_id)
      if (!coverage || !coverage.ranges.some(item => compareRationalTime(range.start, item.start) >= 0 && compareRationalTime(endOfRange(range), endOfRange(item)) <= 0)) {
        throw new VideoWorkbenchServiceError('远程视觉分析超出已确认素材范围', 422, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
      }
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(frame.data_url)
      if (!match) throw new VideoWorkbenchServiceError('本地关键帧格式无效', 502, 'VIDEO_ANALYSIS_INVALID')
      const bytes = Buffer.from(match[2]!, 'base64')
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new VideoWorkbenchServiceError('远程关键帧大小无效', 413, 'VIDEO_ANALYSIS_INVALID')
      const frameOperationId = `${operationId}_frame_${index}`
      const persisted = (await this.repository.listFacts('evidence', project.id, frame.source_id))
        .filter((fact): fact is Extract<VideoFactEvidence, { kind: 'visual' }> => 'payload' in fact && fact.kind === 'visual')
        .find(fact => (
          fact.evidence_window_id === window.id
          && fact.source_fingerprint === source.fingerprint
          && compareRationalTime(fact.range.start, range.start) === 0
          && compareRationalTime(endOfRange(fact.range), endOfRange(range)) === 0
        ))
      if (persisted) {
        if (!window.evidence_ids.includes(persisted.id)) {
          await this.repository.saveFact({ ...window, evidence_ids: [...window.evidence_ids, persisted.id] })
        }
        const parent = await this.repository.getOperation(operationId).catch(() => null)
        if (parent && this.remoteRecoveryCheckpoint(parent)?.local_operation_id === frameOperationId) {
          await this.updateRemoteOperationRecovery(operationId, 'cleared')
        }
        output.push({
          id: persisted.id,
          kind: 'visual', source_id: frame.source_id, in_ms: frame.in_ms, out_ms: frame.range_end_ms ?? frame.in_ms + 1,
          text: persisted.payload.summary,
          confidence: persisted.confidence ?? 0.5,
          warnings: persisted.payload.warnings.slice(0, 20),
          ...(persisted.provider_receipt_id ? { provider_receipt_id: persisted.provider_receipt_id } : {}),
          ...(persisted.relay_operation_id ? { relay_operation_id: persisted.relay_operation_id } : {}),
          ...(persisted.relay_result_hashes ? { relay_result_hashes: persisted.relay_result_hashes } : {}),
        })
        if (
          persisted.provider_receipt_id
          && persisted.relay_operation_id
          && persisted.relay_result_hashes
          && !project.evidence.some(item => item.id === persisted.id)
        ) acknowledgements.push(this.acknowledgementFor(frameOperationId, persisted.relay_operation_id, persisted.provider_receipt_id, persisted.relay_result_hashes))
        continue
      }
      const frameUsage = {
        requests: 1,
        total_tokens: VIDEO_REMOTE_USAGE_POLICY.visualOutputTokenReserve,
        input_bytes: bytes.byteLength,
        visual_frames: 1,
        proxy_seconds: 0,
        asr_seconds: 0,
        estimated_amount_micros: estimatedTextAmountMicros(VIDEO_REMOTE_USAGE_POLICY.visualOutputTokenReserve, VIDEO_REMOTE_USAGE_POLICY.visualFrameMicros),
      }
      await this.reserveRemoteBudget(project.id, budget.id, frameOperationId, 'visual_evidence', frameUsage)
      const contentHash: `sha256:${string}` = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      let objectRef: string
      try {
        objectRef = await relay.uploadObject({
          local_operation_id: frameOperationId,
          purpose: 'visual_frames', content_hash: contentHash, byte_size: bytes.byteLength, content_type: match[1]!,
          consent_revision_id: consent.id, consent_scope_hash: scopeHash,
          remote_consent_claim: this.remoteConsentClaim(project, consent, relay, 'visual_evidence'),
        }, bytes)
      } catch (error) {
        // Object transfer precedes the Provider submission. A reserved call
        // can normally be released. A caller-side 499 or identity/content 409
        // remains fenced, however: the client cannot prove which durable Relay
        // lease state won, and a changed object fingerprint must fail closed.
        const uncertainTransfer = error instanceof VideoMediaRelayClientError && (error.status === 499 || error.status === 409)
        const quotaError = videoHostedQuotaError(error)
        await this.finalizeRemoteBudgetFailure(
          project.id,
          budget.id,
          frameOperationId,
          uncertainTransfer || quotaError ? error : new VideoMediaRelayClientError(422, 'relay_upload_failed_before_submission'),
          { submissionFenced: uncertainTransfer },
        )
        throw quotaError ?? error
      }
      const frameRequest = {
        local_operation_id: frameOperationId, consent_revision_id: consent.id, consent_scope_hash: scopeHash, local_budget_reservation_id: budget.id,
        request_hash: factBasisHash({ model: VIDEO_REMOTE_MODEL_BINDINGS.visualEvidence, source_id: frame.source_id, window_id: window.id, range, content_hash: contentHash }),
        capability: 'visual_evidence' as const, application_role: 'shot_evidence' as const,
        input: { object_refs: [objectRef], evidence_window_id: window.id, facts_basis_hash: project.evidence_revision ?? factBasisHash({ project: project.id }), language: 'zh', output_schema_version: 1 },
      }
      await this.reserveAndRunRemote(project.id, budget.id, 'visual_evidence', frameUsage, relay, frameRequest, async (activeRelay, remote) => {
        if (remote.state !== 'succeeded' || !remote.provider_receipt) throw new VideoMediaRelayClientError(remote.state === 'outcome_unknown' ? 503 : 422, 'relay_operation_not_succeeded')
        await this.settleRemoteBudget(project.id, budget.id, frameOperationId, remote.provider_receipt)
        const downloaded = await activeRelay.downloadResult<{ kind: string; evidence: unknown }>(remote)
        const evidence = downloaded.result.evidence as Record<string, unknown> | undefined
        const summary = typeof evidence?.summary === 'string' ? evidence.summary.trim() : typeof evidence?.text === 'string' ? evidence.text.trim() : ''
        if (!summary || summary.length > 8000) throw new VideoWorkbenchServiceError('远程视觉证据结果无效', 502, 'VIDEO_ANALYSIS_INVALID')
        const confidence = typeof evidence?.confidence === 'number' && evidence.confidence >= 0 && evidence.confidence <= 1 ? evidence.confidence : 0.5
        const warnings = Array.isArray(evidence?.warnings) ? evidence.warnings.filter((item): item is string => typeof item === 'string').slice(0, 20) : []
        const hosted = createHostedEvidence({
          kind: 'visual',
          projectId: project.id,
          source: source as VideoFactSource & { fingerprint: `sha256:${string}` },
          range,
          evidenceWindowId: window.id,
          promptVersion: 'video-relay-visual-v1',
          createdAt: this.iso(),
          confidence,
          id: `evidence_${createHash('sha256').update(frameOperationId).digest('hex').slice(0, 32)}`,
          providerReceiptId: remote.provider_receipt.id,
          relayOperationId: remote.id,
          relayResultHashes: downloaded.hashes,
          payload: { summary, subjects: [], warnings },
        })
        // The immutable Fact is the durable result authority. Only after it
        // and its Evidence Window link exist may the parent submission fence
        // be cleared; startup can rebuild the ACK outbox from this Fact.
        await this.repository.saveFact(hosted)
        await this.repository.saveFact({ ...window, evidence_ids: [...new Set([...window.evidence_ids, hosted.id])] })
        await this.updateRemoteOperationRecovery(operationId, 'cleared')
        output.push({
          id: hosted.id,
          kind: 'visual', source_id: frame.source_id, in_ms: frame.in_ms, out_ms: frame.range_end_ms ?? frame.in_ms + 1,
          text: summary,
          confidence,
          warnings,
          provider_receipt_id: remote.provider_receipt.id,
          relay_operation_id: remote.id,
          relay_result_hashes: downloaded.hashes,
        })
        acknowledgements.push(this.acknowledgementFor(frameOperationId, remote.id, remote.provider_receipt.id, downloaded.hashes))
      }, { parentOperationId: operationId })
    }
    return output.length ? { evidence: output, acknowledgements } : null
  }

  private async persistWindowBoundVisualFacts(
    project: VideoStudioProject,
    extracted: ExtractedVideoAnalysisInputs,
    generated: VideoEvidence[],
  ): Promise<void> {
    const frames = new Map(extracted.frames
      .filter(frame => frame.evidence_window_id)
      .map(frame => [`${frame.source_id}\0${frame.in_ms}`, frame]))
    const additions = new Map<string, string[]>()
    for (const evidence of generated) {
      if (evidence.kind !== 'visual') continue
      const frame = frames.get(`${evidence.source_id}\0${evidence.in_ms}`)
      if (!frame?.evidence_window_id) continue
      const window = extracted.evidence_windows.get(frame.evidence_window_id)
      const source = extracted.source_facts.get(evidence.source_id)
      if (!window || !source || source.fingerprint_state !== 'ready' || !source.fingerprint) {
        throw new VideoWorkbenchServiceError('视觉证据缺少稳定的事实窗口或完整素材指纹', 502, 'VIDEO_ANALYSIS_INVALID')
      }
      const range = this.sourceRangeFromDisplayMilliseconds(source, evidence.in_ms, evidence.out_ms)
      if (
        compareRationalTime(range.start, window.range.start) < 0
        || compareRationalTime(endOfRange(range), endOfRange(window.range)) > 0
      ) throw new VideoWorkbenchServiceError('视觉证据超出授权 Evidence Window', 502, 'VIDEO_ANALYSIS_INVALID')
      const fact = createHostedEvidence({
        kind: 'visual',
        projectId: project.id,
        source: source as VideoFactSource & { fingerprint: `sha256:${string}` },
        range,
        evidenceWindowId: window.id,
        promptVersion: evidence.provider_receipt_id ? 'video-relay-visual-v1' : 'legacy-gateway-visual-v1',
        createdAt: this.iso(),
        confidence: evidence.confidence,
        id: evidence.id,
        ...(evidence.provider_receipt_id ? { providerReceiptId: evidence.provider_receipt_id } : {}),
        ...(evidence.relay_operation_id ? { relayOperationId: evidence.relay_operation_id } : {}),
        ...(evidence.relay_result_hashes ? { relayResultHashes: evidence.relay_result_hashes as Array<`sha256:${string}`> } : {}),
        payload: {
          summary: evidence.text,
          subjects: [],
          warnings: evidence.warnings,
        },
      })
      await this.repository.saveFact(fact)
      additions.set(window.id, [...(additions.get(window.id) ?? []), fact.id])
    }
    for (const [windowId, evidenceIds] of additions) {
      const window = extracted.evidence_windows.get(windowId)
      if (!window) continue
      await this.repository.saveFact({
        ...window,
        evidence_ids: [...new Set([...window.evidence_ids, ...evidenceIds])],
      })
    }
  }

  private materializeVideoScenes(
    project: VideoStudioProject,
    drafts: VideoPlanDraft['scenes'],
    evidence: VideoEvidence[],
  ): VideoScene[] {
    const sources = new Map(project.sources.map(source => [source.id, source]))
    const evidenceById = new Map(evidence.map(item => [item.id, item]))
    return drafts.map(draft => {
      const source = sources.get(draft.source_id)
      if (!source || draft.out_ms > source.duration_ms) {
        throw new VideoWorkbenchServiceError('视频方案引用了不存在的素材时间', 502, 'VIDEO_ANALYSIS_INVALID')
      }
      for (const evidenceId of draft.evidence_ids) {
        const item = evidenceById.get(evidenceId)
        if (!item || item.source_id !== draft.source_id || item.out_ms <= draft.in_ms || item.in_ms >= draft.out_ms) {
          throw new VideoWorkbenchServiceError('视频方案包含无效证据引用', 502, 'VIDEO_ANALYSIS_INVALID')
        }
      }
      return { id: id('clip'), ...draft, locked: false }
    })
  }

  private preserveLockedVideoScenes(current: VideoScene[], proposed: VideoScene[]): VideoScene[] {
    const locked = current.filter(scene => scene.locked)
    const overlapsLocked = (scene: VideoScene) => locked.some(candidate => (
      candidate.source_id === scene.source_id && candidate.in_ms < scene.out_ms && candidate.out_ms > scene.in_ms
    ))
    const available = proposed.filter(scene => !overlapsLocked(scene))
    const result: VideoScene[] = []
    let cursor = 0
    for (const scene of current) {
      if (scene.locked) result.push(scene)
      else if (available[cursor]) result.push(available[cursor++]!)
    }
    return [...result, ...available.slice(cursor)]
  }

  async analyzeVideoProject(
    projectId: string,
    raw: AnalyzeVideoProjectInput,
    options: Readonly<{ idempotencyKey?: string; creativeSessionId?: string }> = {},
  ): Promise<VideoOperation> {
    const input = analyzeVideoProjectInputSchema.parse(raw)
    const requestHash = factBasisHash({
      kind: 'video_analysis',
      input,
      ...(options.creativeSessionId ? { creative_session_id: options.creativeSessionId } : {}),
    })
    const launch = await this.mutateProject(projectId, async () => {
      let project = await this.requireVideoProject(projectId)
      if (options.idempotencyKey) {
        const existing = (await this.repository.listOperations(project.id)).find(candidate => (
          candidate.kind === 'video.analyze' && candidate.idempotency_key === options.idempotencyKey
        ))
        if (existing) {
          if (existing.result?.request_hash !== requestHash) {
            throw new VideoWorkbenchServiceError('同一幂等键不能提交不同的分析请求', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
          }
          return { project, task: existing, userGoal: input.user_goal, reused: true }
        }
      }
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再分析', 409, 'VIDEO_REVISION_CONFLICT')
      if (!project.sources.length) throw new VideoWorkbenchServiceError('请先导入视频素材', 409, 'VIDEO_SOURCE_NOT_FOUND')
      if (project.state === 'rendering') throw new VideoWorkbenchServiceError('正在导出，暂时不能分析', 409, 'VIDEO_RENDER_ACTIVE')
      const active = project.task_id ? await this.repository.getOperation(project.task_id).catch(() => null) : null
      if (active && ['queued', 'running', 'committing'].includes(active.status)) {
        throw new VideoWorkbenchServiceError('当前已有视频操作在运行', 409, 'VIDEO_OPERATION_ACTIVE')
      }
      project = await this.assertSourcesUnchanged(project)
      const now = this.iso()
      if (input.creative_direction || input.brief || input.planning) project = await this.persistAnalyzeCreativeDirection(project, input, now)
      const task = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.analyze',
        status: 'running',
        progress: 5,
        stage: '正在提取素材证据',
        ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
        // Persist the intent needed to re-enter analysis after a local Sidecar
        // restart. Long Fun-ASR itself is reconciled through the Relay's
        // deterministic local_operation_id and persisted provider task id.
        result: {
          request_hash: requestHash,
          base_revision: project.revision,
          base_timeline_version_id: project.current_timeline_version_id,
          user_goal: input.user_goal,
          ...(options.creativeSessionId ? { creative_session_id: options.creativeSessionId } : {}),
          workflow: planningWorkflow({
            phase: 'collecting_evidence',
            completed_units: 0,
            total_units: 4,
            next_action: 'wait_for_analysis',
            interpreted_goal: input.user_goal,
          }),
        },
        created_at: now,
        updated_at: now,
      } as unknown as VideoOperation))
      await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, task_id: task.id }))
      return { project, task, userGoal: input.user_goal, reused: false }
    })
    const controller = new AbortController()
    const active: ActiveVideoExecution = { controller, completion: Promise.resolve(), output_path: '' }
    if (!launch.reused) {
      active.completion = Promise.resolve().then(() => this.runVideoAnalysis(launch.project, launch.task, launch.userGoal, controller.signal))
      this.activeAnalyses.set(launch.task.id, active)
    }
    return launch.task
  }

  /**
   * Chat remains a durable note stream. This explicit action is the only chat
   * adjacent path that invokes the Director: it starts the same evidence-bound
   * analysis Operation as the normal Analyze button and leaves Version writes
   * behind the existing Draft acceptance boundary.
   */
  async requestCreativeSuggestion(
    projectId: string,
    sessionId: string,
    raw: AnalyzeVideoProjectInput,
    idempotencyKey: string,
  ): Promise<VideoOperation> {
    const project = await this.requireVideoProject(projectId)
    const session = project.creative_sessions.find(item => item.id === sessionId && !item.archived_at)
    if (!session) throw new VideoWorkbenchServiceError('创作会话不存在或已归档', 404, 'VIDEO_CREATIVE_SESSION_NOT_FOUND')
    return await this.analyzeVideoProject(projectId, raw, { idempotencyKey, creativeSessionId: session.id })
  }

  private async runVideoAnalysis(
    baseProject: VideoStudioProject,
    analyzeTask: VideoOperation,
    userGoal: string,
    signal: AbortSignal,
  ): Promise<void> {
    let activeTask = analyzeTask
    try {
      const extracted = await this.extractVideoAnalysisInputs(baseProject, analyzeTask.id, signal)
      await this.repository.saveOperation(this.operation({
        ...analyzeTask,
        progress: 45,
        stage: '正在分析画面与语音证据',
        result: {
          ...(analyzeTask.result ?? {}),
          workflow: planningWorkflow({
            phase: 'interpreting_goal',
            completed_units: 1,
            total_units: 4,
            next_action: 'wait_for_analysis',
            interpreted_goal: userGoal,
          }),
        },
      }))
      const retainedEvidenceIds = new Set(baseProject.timeline_versions
        .find(version => version.id === baseProject.current_timeline_version_id)
        ?.scenes.filter(scene => scene.locked).flatMap(scene => scene.evidence_ids) ?? [])
      const retained = baseProject.evidence.filter(item => item.kind === 'source_role' || retainedEvidenceIds.has(item.id))
      const remoteVisual = await this.remoteVisualEvidence(baseProject, analyzeTask.operation_id ?? analyzeTask.id, extracted, signal)
      const draft = remoteVisual ? { evidence: remoteVisual.evidence, gaps: [] } : await analyzeVideoEvidence({
        sources: baseProject.sources,
        existingEvidence: retained,
        transcriptEvidence: extracted.transcripts,
        frames: extracted.frames,
        userGoal,
        extractionGaps: extracted.gaps,
      }, {
        operationId: `${analyzeTask.operation_id ?? analyzeTask.id}-evidence`,
        signal,
        fetchImpl: this.fetchImpl,
        env: this.env,
        allowLegacyGateway: false,
      })
      const generated = this.materializeVideoEvidence(baseProject, draft.evidence)
      const next = await this.mutateProject(baseProject.id, async () => {
        const latest = await this.requireVideoProject(baseProject.id)
        if (
          latest.revision !== baseProject.revision
          || latest.current_timeline_version_id !== baseProject.current_timeline_version_id
          || JSON.stringify(latest.sources.map(source => source.fingerprint)) !== JSON.stringify(baseProject.sources.map(source => source.fingerprint))
        ) throw new VideoWorkbenchServiceError('视频项目已更新，本次分析结果未写入', 409, 'VIDEO_ANALYSIS_STALE')
        await this.persistWindowBoundVisualFacts(latest, extracted, generated)
        const evidence = [...retained, ...extracted.transcripts, ...generated]
        const revision = evidenceRevision(evidence)
        const evidenceProject = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          evidence,
          evidence_revision: revision,
          pending_relay_acknowledgements: this.appendPendingRelayAcknowledgements(latest, [
            ...extracted.relay_acknowledgements,
            ...(remoteVisual?.acknowledgements ?? []),
          ]),
          revision: latest.revision + 1,
        }))
        const now = this.iso()
        const planTask = await this.repository.saveOperation(this.operation({
          schema_version: 1,
          id: id('task'),
          project_id: latest.id,
          kind: 'video.plan',
          status: 'running',
          progress: 60,
          stage: '正在编译剪辑方案',
          result: {
            base_revision: evidenceProject.revision,
            base_timeline_version_id: evidenceProject.current_timeline_version_id,
            evidence_revision: revision,
            user_goal: userGoal,
            analysis_gaps: [...extracted.gaps, ...draft.gaps],
            workflow: planningWorkflow({
              phase: 'drafting_candidates',
              completed_units: 2,
              total_units: 4,
              next_action: 'wait_for_analysis',
              interpreted_goal: userGoal,
              clarifications: [...extracted.gaps, ...draft.gaps],
            }),
          },
          created_at: now,
          updated_at: now,
        } as unknown as VideoOperation))
        await this.repository.saveProject(videoStudioProjectSchema.parse({ ...evidenceProject, task_id: planTask.id }))
        await this.repository.saveOperation(this.operation({
          ...analyzeTask,
          status: 'succeeded',
          progress: 100,
          stage: '证据分析完成',
          result: {
            ...(analyzeTask.result ?? {}),
            evidence_revision: revision,
            evidence_count: evidence.length,
            next_task_id: planTask.id,
            workflow: planningWorkflow({
              phase: 'drafting_candidates',
              completed_units: 2,
              total_units: 4,
              next_action: 'wait_for_analysis',
              interpreted_goal: userGoal,
              clarifications: [...extracted.gaps, ...draft.gaps],
            }),
          },
        }))
        return { project: evidenceProject, planTask, evidence, gaps: [...extracted.gaps, ...draft.gaps] }
      })
      await this.flushPendingRelayAcknowledgements(baseProject.id)
      const active = this.activeAnalyses.get(analyzeTask.id)
      this.activeAnalyses.delete(analyzeTask.id)
      if (active) this.activeAnalyses.set(next.planTask.id, active)
      activeTask = next.planTask
      const currentScenes = next.project.timeline_versions.find(version => version.id === next.project.current_timeline_version_id)?.scenes ?? []
      const localPlanningInput = {
        sources: next.project.sources,
        evidence: next.evidence,
        currentScenes,
        userGoal,
        analysisGaps: next.gaps,
        ...(next.project.creation_brief ? { creationBrief: next.project.creation_brief } : {}),
        ...(next.project.delivery_intent ? { deliveryIntent: next.project.delivery_intent } : {}),
      }
      const consent = next.project.remote_analysis_consents.find(item => item.state === 'active' && item.purposes.includes('planning'))
      const budget = consent && next.project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
      let plan: VideoPlanDraft
      let stagedPlanningOperation: VideoOperation | undefined
      const relay = this.videoMediaRelay(signal)
      if (consent && budget && relay) {
        const scopedSources = planningSourcesForConsent(next.project, consent)
        const scopedSourceIds = new Set(scopedSources.map(source => source.id))
        const scopedEvidence = planningEvidenceForConsent(next.project, consent)
        const planningInput = {
          sources: scopedSources,
          evidence: scopedEvidence.slice(0, 1_998),
          currentScenes: currentScenes.filter(scene => scopedSourceIds.has(scene.source_id)),
          userGoal,
          analysisGaps: next.gaps,
          ...(next.project.creation_brief ? { creationBrief: next.project.creation_brief } : {}),
          ...(next.project.delivery_intent ? { deliveryIntent: next.project.delivery_intent } : {}),
        }
        const relayEvidence = planningRelayEvidence(next.project, scopedEvidence)
        const relayInput = {
          object_refs: [],
          sources: scopedSources.map(planningSourceProjection),
          facts_basis_hash: next.project.evidence_revision ?? factBasisHash({ evidence: scopedEvidence }),
          evidence: relayEvidence,
          user_goal: userGoal,
          analysis_gaps: next.gaps,
          language: next.project.creation_brief?.distribution === 'presentation' ? 'zh-CN' : 'zh',
          output_schema_version: 1,
        }
        const requestHash = factBasisHash({ capability: 'media_reasoning', application_role: 'planning', model: VIDEO_REMOTE_MODEL_BINDINGS.mediaReasoning, input: relayInput })
        const serializedRelayInput = JSON.stringify(relayInput)
        const planningInputTokens = estimatedTextTokens(serializedRelayInput) + VIDEO_REMOTE_USAGE_POLICY.planningContextTokenReserve
        const planningUsage = {
          requests: 1,
          total_tokens: planningInputTokens + VIDEO_REMOTE_USAGE_POLICY.planningOutputTokenReserve,
          input_bytes: Buffer.byteLength(serializedRelayInput, 'utf8'),
          visual_frames: 0,
          proxy_seconds: 0,
          asr_seconds: 0,
          estimated_amount_micros: estimatedTextAmountMicros(planningInputTokens + VIDEO_REMOTE_USAGE_POLICY.planningOutputTokenReserve),
        }
        const planningRequest = {
          local_operation_id: next.planTask.id,
          consent_revision_id: consent.id,
          consent_scope_hash: factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds }),
          local_budget_reservation_id: budget.id,
          request_hash: requestHash,
          capability: 'media_reasoning' as const,
          application_role: 'planning' as const,
          input: relayInput,
        }
        await this.reserveAndRunRemote(baseProject.id, budget.id, 'media_reasoning', planningUsage, relay, planningRequest, async (activeRelay, remote) => {
          if (remote.state !== 'succeeded' || !remote.provider_receipt) throw new VideoMediaRelayClientError(remote.state === 'outcome_unknown' ? 503 : 422, 'relay_operation_not_succeeded')
          await this.settleRemoteBudget(baseProject.id, budget.id, next.planTask.id, remote.provider_receipt)
          const downloaded = await activeRelay.downloadResult<{ kind: string; plan: unknown }>(remote)
          if (downloaded.result.kind !== 'planning') throw new VideoWorkbenchServiceError('远程规划结果类型无效', 502, 'VIDEO_ANALYSIS_INVALID')
          plan = planVideoTimelineFromRelay(planningInput, downloaded.result.plan)
          stagedPlanningOperation = await this.stageRemotePlanningResult(
            next.planTask,
            { userGoal, analysisGaps: next.gaps },
            downloaded.result.plan,
            this.acknowledgementFor(next.planTask.id, remote.id, remote.provider_receipt.id, downloaded.hashes),
          )
        }, { parentOperationId: next.planTask.id })
      } else {
        plan = await planVideoTimeline(localPlanningInput, { operationId: `${next.planTask.operation_id ?? next.planTask.id}-timeline`, signal, fetchImpl: this.fetchImpl, env: this.env, allowLegacyGateway: false })
      }
      if (stagedPlanningOperation) {
        const staged = stagedPlanningOperation
        activeTask = staged
        await this.finalizeStagedRemotePlanningResult(staged)
        return
      }
      await this.mutateProject(baseProject.id, async () => {
        const latest = await this.requireVideoProject(baseProject.id)
        if (
          latest.revision !== next.project.revision
          || latest.evidence_revision !== next.project.evidence_revision
          || latest.current_timeline_version_id !== next.project.current_timeline_version_id
        ) throw new VideoWorkbenchServiceError('视频项目已更新，本次剪辑方案未写入', 409, 'VIDEO_ANALYSIS_STALE')
        const proposed = this.materializeVideoScenes(latest, plan.scenes, next.evidence)
        const scenes = this.preserveLockedVideoScenes(currentScenes, proposed)
        const editorialProject = await this.ensureEditorialState(latest)
        const timelineDraft = this.editorial.createDraft(
          editorialProject,
          scenes,
          await this.editorialTimings(editorialProject),
          [],
          await this.editorialSourceBounds(editorialProject),
          undefined,
          'local_conservative',
        )
        const completed = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...editorialProject,
          brief: compileVideoBrief(userGoal, { ...plan.brief, gaps: [...new Set([...plan.brief.gaps, ...next.gaps])].slice(0, 20) }),
          timeline_drafts: [...editorialProject.timeline_drafts, timelineDraft],
          // The prior scene timeline remains the old API projection. Analysis
          // may only create a proposed draft; user accept/CommandSet is the
          // sole path that creates an Editorial Timeline Version.
          alternatives: [],
          pending_relay_acknowledgements: editorialProject.pending_relay_acknowledgements,
          state: 'ready',
          task_id: undefined,
          revision: editorialProject.revision + 1,
        }))
        await this.repository.saveOperation(this.operation({
          ...next.planTask,
          status: 'succeeded',
          progress: 100,
          stage: '剪辑草稿已生成，等待用户接受',
          result: {
            timeline_draft_id: timelineDraft.id,
            project_revision: completed.revision,
            alternative_count: 0,
            planning_origin: 'local_conservative',
            workflow: planningWorkflow({
              phase: 'awaiting_confirmation',
              completed_units: 4,
              total_units: 4,
              next_action: 'review_suggestions',
              interpreted_goal: userGoal,
              clarifications: [...next.gaps, ...plan.brief.gaps],
            }),
          },
        }))
      })
      await this.flushPendingRelayAcknowledgements(baseProject.id)
    } catch (error) {
      const interruptedAnalysis = await this.repository.getOperation(analyzeTask.id).catch(() => null)
      const interruptedActive = activeTask.id === analyzeTask.id
        ? interruptedAnalysis
        : await this.repository.getOperation(activeTask.id).catch(() => null)
      const asrRecovery = interruptedAnalysis?.result?.asr_checkpoints
      const recoverableAsrStates = new Set(['submitting', 'submitted', 'running', 'cancel_pending', 'result_pending', 'outcome_unknown'])
      const hasRecoverableAsr = Array.isArray(asrRecovery)
        && asrRecovery.some(item => item && typeof item === 'object' && recoverableAsrStates.has(String((item as Record<string, unknown>).state)))
      const hasGenericRecovery = Boolean(interruptedActive && this.remoteRecoveryCheckpoint(interruptedActive))
      if (
        interruptedActive
        && (hasRecoverableAsr || hasGenericRecovery)
      ) {
        // A fenced submission or cancel intent is still owned by this exact
        // parent id. Keep it startup-enumerable; failing it here would let the
        // user create a fresh paid local_operation_id around the fence.
        await this.repository.saveOperation(this.operation({
          ...interruptedActive,
          status: 'running',
          stage: hasRecoverableAsr ? '正在恢复远程媒体操作' : '正在恢复远程规划',
          error: undefined,
          error_code: undefined,
        })).catch(() => undefined)
        return
      }
      const cancelled = signal.aborted || (error instanceof VideoAnalysisError && error.code === 'VIDEO_ANALYSIS_CANCELLED')
      const stale = error instanceof VideoWorkbenchServiceError && error.code === 'VIDEO_ANALYSIS_STALE'
      const platformQuota = error instanceof VideoWorkbenchServiceError && error.code === 'VIDEO_PLATFORM_QUOTA_EXHAUSTED'
      const projectBudget = error instanceof VideoWorkbenchServiceError && error.code === 'VIDEO_PROJECT_BUDGET_EXCEEDED'
      const failure = mediaSafeError(cancelled
        ? 'MEDIA_VIDEO_ANALYSIS_CANCELLED'
        : stale ? 'MEDIA_STATE_CONFLICT'
          : platformQuota ? 'MEDIA_VIDEO_PLATFORM_QUOTA_EXHAUSTED'
            : projectBudget ? 'MEDIA_VIDEO_PROJECT_BUDGET_EXCEEDED'
              : 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE')
      const failureTask = activeTask.id === analyzeTask.id && interruptedAnalysis ? interruptedAnalysis : activeTask
      await this.repository.saveOperation(this.operation({
        ...failureTask,
        status: cancelled ? 'cancelled' : 'failed',
        progress: 0,
        stage: cancelled ? '已取消' : stale ? '方案已过期' : platformQuota ? '托管视频额度已用完' : projectBudget ? '项目远程预算已用完' : '视频分析失败',
        result: {
          ...(failureTask.result ?? {}),
          workflow: planningWorkflow({
            phase: 'failed',
            completed_units: 0,
            total_units: 4,
            next_action: stale ? 'refresh_project' : 'retry_analysis',
            interpreted_goal: userGoal,
          }),
        },
        error: failure.message,
        error_code: failure.code,
      })).catch(() => undefined)
    } finally {
      this.activeAnalyses.delete(analyzeTask.id)
      this.activeAnalyses.delete(activeTask.id)
    }
  }

  private startFingerprint(operation: VideoOperation, sourceId: string): void {
    const completion = Promise.resolve().then(async () => await this.runFullFingerprint(operation, sourceId))
    this.activeFingerprints.set(operation.id, completion)
    void completion.catch(() => undefined).finally(() => this.activeFingerprints.delete(operation.id))
  }

  private async runFullFingerprint(operation: VideoOperation, sourceId: string): Promise<void> {
    let running = operation
    try {
      running = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'running',
        progress: 10,
        stage: '正在计算完整指纹',
      }))
      const stored = await this.repository.getFact('source', sourceId)
      if (!('fast_identity' in stored)) throw new Error('视频素材事实类型错误')
      const before = stored as VideoFactSource
      let fingerprint: `sha256:${string}`
      try {
        fingerprint = await videoFingerprint(before.path)
      } catch {
        const observed = await fastVideoIdentity(before.path).catch(() => null)
        if (observed) await this.markSourceChanged(before, observed)
        throw new Error('完整指纹计算期间素材不可稳定读取')
      }
      const after = await fastVideoIdentity(before.path)
      if (!this.sameFastIdentity(before.fast_identity, after)) {
        await this.markSourceChanged(before, after)
        throw new Error('素材在完整指纹计算期间发生变化')
      }
      const sourceFact = await this.repository.saveFact({
        ...before,
        fast_identity: after,
        fingerprint,
        fingerprint_state: 'ready',
        state: 'ready',
        updated_at: this.iso(),
      }) as VideoFactSource
      const readySource = sourceFact as VideoFactSource & { fingerprint: `sha256:${string}` }
      const localFacts = await this.createInitialLocalMediaFacts(readySource, running)
      const contentSegments = localFacts.cameraShots.length
        ? contentSegmentsFromCameraShots({ source: readySource, shots: localFacts.cameraShots, createdAt: this.iso() })
        : fixedIntervalContentSegments({ source: readySource, createdAt: this.iso() })
      for (const segment of contentSegments) await this.repository.saveFact(segment)
      const initialWindows = planEvidenceWindows({
        source: readySource,
        segments: contentSegments,
        analysisDepth: 'summary',
        samplingReceiptId: operation.id,
        createdAt: this.iso(),
        budget: DEFAULT_EVIDENCE_WINDOW_BUDGET,
      })
      for (const window of initialWindows.windows) await this.repository.saveFact(window)
      await this.mutateProject(operation.project_id, async () => {
        const project = await this.requireVideoProject(operation.project_id)
        const source = project.sources.find(item => item.id === sourceId)
        if (!source) return
        const sourceEvidence: VideoEvidence = {
          id: id('evidence'),
          kind: 'source_role',
          source_id: sourceId,
          source_fingerprint: sourceFact.fingerprint!,
          in_ms: 0,
          out_ms: source.duration_ms,
          text: `真实视频素材：${source.name}，${source.width}×${source.height}，${source.duration_ms}ms${source.has_audio ? '，含音轨' : '，无音轨'}`,
          confidence: 1,
          warnings: [],
          created_at: this.iso(),
        }
        const evidence = [
          ...project.evidence.filter(item => !(item.kind === 'source_role' && item.source_id === sourceId)),
          sourceEvidence,
        ]
        const nextEvidenceRevision = evidenceRevision(evidence)
        const planningUpdate = project.editorial_plans.length
          ? {
              id: id('planning_update'),
              project_id: project.id,
              source_id: sourceId,
              // Fingerprint completion creates only the local summary facts
              // above. Deeper analysis still requires its own active consent.
              authorized_depth: 'summary' as const,
              plan_ids: project.editorial_plans.map(plan => plan.id),
              reason: '新素材已完成本地摘要，已有规划可重新生成；不会自动改写已接受时间线。',
              created_at: this.iso(),
            }
          : undefined
        const persisted = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          sources: project.sources.map(item => item.id === sourceId
            ? { ...item, fingerprint: sourceFact.fingerprint, missing: false, content_changed: false }
            : item),
          assets: project.assets.map(asset => asset.id === sourceId ? { ...asset, content_hash: sourceFact.fingerprint } : asset),
          evidence,
          evidence_revision: nextEvidenceRevision,
          ...(planningUpdate ? { planning_updates: [...project.planning_updates, planningUpdate] } : {}),
          revision: project.revision + 1,
        }))
        // The legacy scene list remains readable for the compatibility API.
        // Completing a fingerprint may initialise v2 once, but never writes a
        // new editorial version or rewrites an accepted user timeline.
        await this.ensureEditorialState(persisted)
      })
      await this.repository.saveOperation(this.operation({
        ...running,
        status: 'succeeded',
        progress: 100,
        stage: '完整指纹已就绪',
        result: {
          ...(running.result ?? {}),
          source_id: sourceId,
          media_facts: {
            derivative_ids: localFacts.derivatives.map(item => item.id),
            camera_shot_ids: localFacts.cameraShots.map(item => item.id),
            content_segment_ids: contentSegments.map(item => item.id),
            evidence_window_ids: initialWindows.windows.map(item => item.id),
            coverage: initialWindows.coverage,
            gaps: localFacts.gaps,
          },
        },
      }))
    } catch {
      const failure = mediaSafeError('MEDIA_VIDEO_SOURCE_UNREADABLE')
      await this.repository.saveOperation(this.operation({
        ...running,
        status: 'failed',
        progress: 0,
        stage: '完整指纹计算失败',
        error: failure.message,
        error_code: failure.code,
      })).catch(() => undefined)
    }
  }

  private localFactId(prefix: 'derivative' | 'camera', ...parts: string[]): string {
    return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
  }

  private detectedCameraShotCuts(
    source: VideoFactSource & { fingerprint: `sha256:${string}` },
    output: string,
  ): bigint[] {
    const duration = source.primary_video_stream.duration
    if (!duration) return []
    const rate = source.primary_video_stream.start_time.tick_rate
    const start = parseInt64(source.primary_video_stream.start_time.ticks)
    const end = start + parseInt64(duration.ticks)
    const cuts = new Set<string>()
    for (const match of output.matchAll(/pts_time\s*[:=]\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g)) {
      const seconds = Number(match[1])
      if (!Number.isFinite(seconds)) continue
      const direct = BigInt(Math.round(seconds * Number(rate.num) / Number(rate.den)))
      const ticks = direct >= start && direct < end ? direct : start + direct
      if (ticks > start && ticks < end) cuts.add(ticks.toString())
    }
    return [...cuts].map(value => BigInt(value)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  }

  /**
   * Local media facts are generated from the source itself: one thumbnail and
   * one persisted scene-map derivative, plus Camera Shots only for detector
   * cuts. A detector with no cut never fabricates a Camera Shot.
   */
  private async createInitialLocalMediaFacts(
    source: VideoFactSource & { fingerprint: `sha256:${string}` },
    operation: VideoOperation,
  ): Promise<{ derivatives: VideoDerivative[]; cameraShots: CameraShot[]; gaps: string[] }> {
    const derivatives: VideoDerivative[] = []
    const cameraShots: CameraShot[] = []
    const gaps: string[] = []
    const operationId = operation.operation_id ?? operation.id
    const fingerprintToken = source.fingerprint.slice('sha256:'.length, 'sha256:'.length + 16)
    const directory = join(this.repository.paths().assets, source.project_id, 'derivatives')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const createDerivative = async (input: {
      id: string
      kind: VideoDerivative['kind']
      path: string
      mimeType: string
      parameters: Record<string, unknown>
    }): Promise<VideoDerivative | null> => {
      const info = await stat(input.path).catch(() => null)
      if (!info?.isFile() || info.size <= 0) return null
      const contentHash = await videoFingerprint(input.path)
      const derivative: VideoDerivative = {
        id: input.id,
        project_id: source.project_id,
        source_id: source.id,
        source_fingerprint: source.fingerprint,
        kind: input.kind,
        asset: {
          id: this.localFactId('derivative', source.id, source.fingerprint, input.kind, 'asset'),
          role: 'source',
          version_id: this.localFactId('derivative', source.id, source.fingerprint, input.kind, 'version'),
          storage: { kind: 'managed', locator: join(source.project_id, 'derivatives', basename(input.path)) },
          mime_type: input.mimeType,
          content_hash: contentHash,
          byte_size: info.size,
          created_at: this.iso(),
        },
        content_hash: contentHash,
        byte_size: info.size,
        generator_name: 'ffmpeg-local-media-facts',
        generator_version: '1',
        parameters_hash: factBasisHash(input.parameters),
        created_by_operation_id: operationId,
        created_at: this.iso(),
        state: 'ready',
      }
      await this.repository.saveFact(derivative)
      derivatives.push(derivative)
      return derivative
    }

    const primaryDuration = source.primary_video_stream.duration
    const thumbnailPath = join(directory, `${source.id}-${fingerprintToken}-thumbnail.jpg`)
    if (!primaryDuration) {
      gaps.push(`${source.name} 缺少原始视频流时长，已拒绝基于展示时长生成派生物。`)
    } else {
      const midpoint = Math.max(0, Math.floor(timeToMilliseconds(primaryDuration) / 2))
      try {
        const result = await this.runProcess([
          videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-loglevel', 'error',
          '-ss', (midpoint / 1000).toFixed(3), '-i', source.path,
          '-frames:v', '1', '-vf', 'scale=1280:-2:force_original_aspect_ratio=decrease', '-q:v', '3', '-y', thumbnailPath,
        ])
        if (result.exitCode !== 0 || !await createDerivative({
          id: this.localFactId('derivative', source.id, source.fingerprint, 'thumbnail'),
          kind: 'thumbnail',
          path: thumbnailPath,
          mimeType: 'image/jpeg',
          parameters: { kind: 'thumbnail', midpoint_ms: midpoint, width: 1280, quality: 3 },
        })) gaps.push(`${source.name} 未能生成缩略图派生物。`)
      } catch {
        gaps.push(`${source.name} 未能生成缩略图派生物。`)
      }
    }

    let detectorOutput = ''
    const detectorOutputPath = join(directory, `${source.id}-${fingerprintToken}-scene-detect.null`)
    try {
      const result = await this.runProcess([
        videoBinary('ffmpeg', this.env, this.platform), '-hide_banner', '-copyts', '-i', source.path,
        '-vf', "select='gt(scene,0.35)',metadata=print", '-an', '-f', 'null', detectorOutputPath,
      ])
      if (result.exitCode !== 0) throw new Error(result.stderr)
      detectorOutput = `${result.stdout}\n${result.stderr}`
    } catch {
      gaps.push(`${source.name} 未能完成本地镜头切换检测。`)
    } finally {
      await rm(detectorOutputPath, { force: true }).catch(() => undefined)
    }
    const cuts = this.detectedCameraShotCuts(source, detectorOutput)
    const sceneMapPath = join(directory, `${source.id}-${fingerprintToken}-scene-map.json`)
    try {
      await writeFile(sceneMapPath, JSON.stringify({
        schema_version: 1,
        source_id: source.id,
        source_fingerprint: source.fingerprint,
        detector: { name: 'ffmpeg-scene', threshold: 0.35, copyts: true },
        cut_pts_ticks: cuts.map(cut => cut.toString()),
      }), { mode: 0o600 })
      if (!await createDerivative({
        id: this.localFactId('derivative', source.id, source.fingerprint, 'scene_map'),
        kind: 'scene_map',
        path: sceneMapPath,
        mimeType: 'application/json',
        parameters: { kind: 'scene_map', detector: 'ffmpeg-scene', threshold: 0.35, copyts: true },
      })) gaps.push(`${source.name} 未能持久化镜头检测派生物。`)
    } catch {
      gaps.push(`${source.name} 未能持久化镜头检测派生物。`)
    }

    const start = parseInt64(source.primary_video_stream.start_time.ticks)
    if (!primaryDuration) {
      gaps.push(`${source.name} 缺少原始视频流时长，已拒绝生成镜头边界。`)
      return { derivatives, cameraShots, gaps }
    }
    const end = start + parseInt64(primaryDuration.ticks)
    const bounds = [start, ...cuts, end]
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const lower = bounds[index]!
      const upper = bounds[index + 1]!
      if (upper <= lower || cuts.length === 0) continue
      const shot: CameraShot = {
        id: this.localFactId('camera', source.id, source.fingerprint, String(index), lower.toString(), upper.toString()),
        project_id: source.project_id,
        source_id: source.id,
        source_fingerprint: source.fingerprint,
        range: sourceTimeRange(rationalTime(lower, source.primary_video_stream.start_time.tick_rate), rationalTime(upper - lower, source.primary_video_stream.start_time.tick_rate)),
        boundary_source: 'scene_detect',
        created_at: this.iso(),
      }
      await this.repository.saveFact(shot)
      cameraShots.push(shot)
    }
    return { derivatives, cameraShots, gaps }
  }

  private sameFastIdentity(left: VideoFactSource['fast_identity'], right: VideoFactSource['fast_identity']): boolean {
    return left.byte_size === right.byte_size
      && left.mtime_ms === right.mtime_ms
      && left.file_id === right.file_id
      && left.head_tail_hash === right.head_tail_hash
  }

  private async markSourceChanged(source: VideoFactSource, observed: VideoFactSource['fast_identity']): Promise<void> {
    const { fingerprint: _fingerprint, ...withoutFingerprint } = source
    await this.repository.saveFact({
      ...withoutFingerprint,
      fast_identity: observed,
      fingerprint_state: 'failed',
      state: 'changed',
      updated_at: this.iso(),
    })
    const derivatives = await this.repository.listFacts('derivative', source.project_id, source.id) as VideoDerivative[]
    await Promise.all(derivatives
      .filter(item => item.state !== 'stale')
      .map(async item => await this.repository.saveFact({ ...item, state: 'stale' })))
  }

  private async assertSourcesUnchanged(project: VideoStudioProject): Promise<VideoStudioProject> {
    const sources = [] as VideoStudioProject['sources']
    let changed = false
    for (const source of project.sources) {
      const info = await stat(source.path).catch(() => null)
      if (!info?.isFile()) {
        if (!source.missing) {
          await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...project,
            sources: project.sources.map(candidate => candidate.id === source.id ? { ...candidate, missing: true } : candidate),
          }))
        }
        throw new VideoWorkbenchServiceError('视频素材已不可用', 404, 'VIDEO_SOURCE_MISSING')
      }
      const sourceFact = await this.repository.getFact('source', source.id).catch(() => null)
      if (sourceFact && 'fast_identity' in sourceFact) {
        if (sourceFact.state === 'changed') {
          throw new VideoWorkbenchServiceError('视频素材内容已经变化，请重新导入', 409, 'VIDEO_SOURCE_CHANGED')
        }
        if (sourceFact.fingerprint_state !== 'ready' || !sourceFact.fingerprint) {
          throw new VideoWorkbenchServiceError('素材完整指纹尚未就绪，请稍后再试', 409, 'VIDEO_SOURCE_FINGERPRINT_PENDING')
        }
        const observed = await fastVideoIdentity(source.path)
        if (!this.sameFastIdentity(sourceFact.fast_identity, observed)) {
          await this.markSourceChanged(sourceFact, observed)
          if (!source.content_changed) {
            await this.repository.saveProject(videoStudioProjectSchema.parse({
              ...project,
              sources: project.sources.map(candidate => candidate.id === source.id
                ? { ...candidate, missing: false, content_changed: true }
                : candidate),
            }))
          }
          throw new VideoWorkbenchServiceError('视频素材内容已经变化，请重新导入', 409, 'VIDEO_SOURCE_CHANGED')
        }
      }
      let fingerprint: `sha256:${string}`
      try {
        fingerprint = await videoFingerprint(source.path)
      } catch {
        if (sourceFact && 'fast_identity' in sourceFact) {
          const observed = await fastVideoIdentity(source.path).catch(() => null)
          if (observed) await this.markSourceChanged(sourceFact, observed)
        }
        throw new VideoWorkbenchServiceError('视频素材内容已经变化，请重新导入', 409, 'VIDEO_SOURCE_CHANGED')
      }
      if (source.fingerprint && source.fingerprint !== fingerprint) {
        if (sourceFact && 'fast_identity' in sourceFact) await this.markSourceChanged(sourceFact, await fastVideoIdentity(source.path))
        if (!source.content_changed) {
          await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...project,
            sources: project.sources.map(candidate => candidate.id === source.id
              ? { ...candidate, missing: false, content_changed: true }
              : candidate),
          }))
        }
        throw new VideoWorkbenchServiceError('视频素材内容已经变化，请重新导入', 409, 'VIDEO_SOURCE_CHANGED')
      }
      changed ||= !source.fingerprint || source.missing || source.content_changed
      sources.push({ ...source, fingerprint, missing: false, content_changed: false })
    }
    return changed
      ? await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, sources }))
      : project
  }

  private previewProject(project: VideoStudioProject): VideoStudioProject {
    const scale = Math.min(1, 960 / Math.max(project.output.width, project.output.height))
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
    return videoStudioProjectSchema.parse({
      ...project,
      output: {
        width: even(project.output.width * scale),
        height: even(project.output.height * scale),
        fps: Math.min(24, project.output.fps),
      },
    })
  }

  private projectForLegacyTimelineVersion(project: VideoStudioProject, timeline: VideoTimelineVersion): VideoStudioProject {
    return {
      ...project,
      timeline: timeline.scenes.map(scene => ({
        id: scene.id,
        source_id: scene.source_id,
        in_ms: scene.in_ms,
        out_ms: scene.out_ms,
      })),
    }
  }

  /**
   * The fallback copy must have a deterministic, operation-private witness.
   * Keeping it until the whole group has committed lets recovery prove that a
   * cross-device destination came from this publish, rather than deleting a
   * same-named user file after a crash.
   */
  private publicationWitnessPath(source: string, destination: string): string {
    const identity = createHash('sha256')
      .update(`${resolve(source)}\u0000${resolve(destination)}`)
      .digest('hex')
    return join(dirname(destination), `.${basename(destination)}.publishing-${identity}`)
  }

  private outputExistsError(): VideoWorkbenchServiceError {
    return new VideoWorkbenchServiceError(
      '导出位置已有文件，正式发布不会覆盖它',
      409,
      'VIDEO_OUTPUT_EXISTS',
    )
  }

  private async publicationSourceHash(source: string, expectedHash?: string): Promise<string> {
    const actual = await videoFingerprint(source).catch(() => null)
    if (!actual) {
      throw new VideoWorkbenchServiceError('交付临时文件已丢失，不能继续发布', 409, 'VIDEO_OUTPUT_UNAVAILABLE')
    }
    if (expectedHash && actual !== expectedHash) {
      throw new VideoWorkbenchServiceError('交付临时文件校验失败，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
    }
    return expectedHash ?? actual
  }

  private async samePublishedFile(left: string, right: string): Promise<boolean> {
    const [leftInfo, rightInfo] = await Promise.all([
      stat(left).catch(() => null),
      stat(right).catch(() => null),
    ])
    return Boolean(
      leftInfo?.isFile()
      && rightInfo?.isFile()
      && leftInfo.dev === rightInfo.dev
      && leftInfo.ino === rightInfo.ino,
    )
  }

  private async removeOwnedPublishedDestination(
    source: string | undefined,
    destination: string,
  ): Promise<void> {
    const destinationHash = await videoFingerprint(destination).catch(() => null)
    if (!destinationHash) return
    const witnesses = [
      source,
      ...(source ? [this.publicationWitnessPath(source, destination)] : []),
    ].filter((candidate): candidate is string => Boolean(candidate))
    for (const witness of witnesses) {
      if (await videoFingerprint(witness).catch(() => null) !== destinationHash) continue
      // The final name is removable only when it is still the byte sequence
      // linked from our managed temporary source or fallback witness.
      if (await this.samePublishedFile(witness, destination)) {
        await rm(destination, { force: true }).catch(() => undefined)
        return
      }
    }
  }

  private async clearPublicationArtifacts(files: ReadonlyArray<{
    source?: string
    destination: string
  }>, cleanup: { removeDestinations: boolean; removeSources: boolean }): Promise<void> {
    await Promise.all(files.map(async file => {
      if (cleanup.removeDestinations) {
        await this.removeOwnedPublishedDestination(file.source, file.destination)
      }
      if (cleanup.removeSources && file.source) {
        await rm(file.source, { force: true }).catch(() => undefined)
        await rm(this.publicationWitnessPath(file.source, file.destination), { force: true }).catch(() => undefined)
      }
    }))
  }

  /**
   * Create a destination without ever replacing an existing user file. A
   * hard-link is atomic on the common same-volume path. For cross-device
   * sources the private witness remains until the complete group succeeds.
   */
  private async linkPublishedFile(source: string, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    try {
      await link(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw this.outputExistsError()
      if (code !== 'EXDEV') throw error
    }
    const staging = this.publicationWitnessPath(source, destination)
    let createdStaging = false
    try {
      try {
        await copyFile(source, staging, fsConstants.COPYFILE_EXCL)
        createdStaging = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const [sourceHash, stagingHash] = await Promise.all([
          videoFingerprint(source).catch(() => null),
          videoFingerprint(staging).catch(() => null),
        ])
        if (!sourceHash || stagingHash !== sourceHash) {
          throw new VideoWorkbenchServiceError('交付发布见证文件不匹配，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
        }
      }
      try {
        await link(staging, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw this.outputExistsError()
        throw error
      }
    } catch (error) {
      if (createdStaging) await rm(staging, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async publishFiles(files: ReadonlyArray<{
    source: string
    destination: string
    content_hash?: string
  }>): Promise<void> {
    if (!files.length || new Set(files.map(file => file.destination)).size !== files.length) {
      throw new VideoWorkbenchServiceError('交付发布文件组无效', 409, 'VIDEO_FINISHING_STALE')
    }
    const prepared: Array<{ source: string; destination: string; content_hash: string }> = []
    for (const file of files) {
      prepared.push({ ...file, content_hash: await this.publicationSourceHash(file.source, file.content_hash) })
    }
    const published: typeof prepared = []
    try {
      for (const file of prepared) {
        await this.linkPublishedFile(file.source, file.destination)
        published.push(file)
        if (await videoFingerprint(file.destination).catch(() => null) !== file.content_hash) {
          throw new VideoWorkbenchServiceError('交付发布文件校验失败，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
        }
      }
    } catch (error) {
      // Only destinations linked by this invocation have a managed witness,
      // so rollback cannot erase a competing user file with identical bytes.
      await this.clearPublicationArtifacts(published, { removeDestinations: true, removeSources: false })
      await Promise.all(prepared.map(async file => {
        await rm(this.publicationWitnessPath(file.source, file.destination), { force: true }).catch(() => undefined)
      }))
      throw error
    }
    await this.clearPublicationArtifacts(prepared, { removeDestinations: false, removeSources: true })
  }

  /**
   * Recovery may see a first destination from the same group already linked.
   * It accepts that destination only when its verified hash matches exactly,
   * then links the missing members from retained managed bytes. No existing
   * destination is ever replaced.
   */
  private async resumePublishedFiles(files: ReadonlyArray<{
    source?: string
    destination: string
    content_hash: string
  }>): Promise<void> {
    if (!files.length || new Set(files.map(file => file.destination)).size !== files.length) {
      throw new VideoWorkbenchServiceError('交付发布文件组无效', 409, 'VIDEO_FINISHING_STALE')
    }
    for (const file of files) {
      const destinationHash = await videoFingerprint(file.destination).catch(() => null)
      if (destinationHash) {
        if (destinationHash !== file.content_hash) throw this.outputExistsError()
        continue
      }
      if (!file.source) {
        throw new VideoWorkbenchServiceError('交付临时文件已丢失，不能继续发布', 409, 'VIDEO_OUTPUT_UNAVAILABLE')
      }
      const sourceHash = await videoFingerprint(file.source).catch(() => null)
      if (sourceHash === file.content_hash) {
        try {
          await this.linkPublishedFile(file.source, file.destination)
        } catch (error) {
          // A second recovery worker can race the first link. It is still an
          // idempotent continuation only when the newly visible bytes match
          // the frozen receipt exactly.
          if (!(error instanceof VideoWorkbenchServiceError
            && error.code === 'VIDEO_OUTPUT_EXISTS'
            && await videoFingerprint(file.destination).catch(() => null) === file.content_hash)) {
            throw error
          }
        }
      } else {
        const witness = this.publicationWitnessPath(file.source, file.destination)
        if (await videoFingerprint(witness).catch(() => null) !== file.content_hash) {
          throw new VideoWorkbenchServiceError('交付临时文件校验失败，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
        }
        try {
          await link(witness, file.destination)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST'
            && await videoFingerprint(file.destination).catch(() => null) === file.content_hash) {
            continue
          }
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw this.outputExistsError()
          throw error
        }
      }
      if (await videoFingerprint(file.destination).catch(() => null) !== file.content_hash) {
        throw new VideoWorkbenchServiceError('交付发布文件校验失败，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
      }
    }
    await this.clearPublicationArtifacts(files, { removeDestinations: false, removeSources: true })
  }

  private async movePublishedFile(source: string, destination: string): Promise<void> {
    await this.publishFiles([{ source, destination }])
  }

  private renderPublicationFiles(result: VideoRenderTaskResult): Array<{
    source?: string
    destination: string
    content_hash: string
  }> {
    if (!result.output_path || !result.output_content_hash || !result.output_verification) {
      throw new VideoWorkbenchServiceError('交付发布记录不完整，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
    }
    const files = [{
      source: result.temporary_output,
      destination: result.output_path,
      content_hash: result.output_content_hash,
    }]
    const sidecar = result.output_verification.sidecar_caption
    if (sidecar) {
      if (!result.sidecar_caption_path) {
        throw new VideoWorkbenchServiceError('字幕交付文件记录不完整，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
      }
      files.push({
        source: result.temporary_sidecar_path,
        destination: result.sidecar_caption_path,
        content_hash: sidecar.content_hash,
      })
    }
    return files
  }

  private deliveryPreflight(
    project: VideoStudioProject,
    variantId: string,
    expectedVersionId: string,
  ): {
    context: ReturnType<VideoWorkbenchRuntime['deliveryVariantContext']>
    plan: VideoExecutionPlan
    report: VideoQualityReport
  } {
    const context = this.deliveryVariantContext(project, variantId, expectedVersionId)
    const report = [...project.quality_reports]
      .reverse()
      .find(candidate => candidate.kind === 'preflight'
        && candidate.editorial_timeline_version_id === context.timeline.id
        && candidate.delivery_variant_version_id === context.version.id
        && candidate.export_profile_revision_id === context.profile.id)
    if (!report?.execution_plan_id) {
      throw new VideoWorkbenchServiceError('请先对当前交付变体完成预检', 409, 'VIDEO_QUALITY_BLOCKED')
    }
    const plan = project.execution_plans.find(candidate => candidate.id === report.execution_plan_id)
    if (!plan
      || plan.editorial_timeline_version_id !== context.timeline.id
      || plan.delivery_variant_version_id !== context.version.id
      || plan.encoder.id !== context.profile.id
      || plan.encoder.content_hash !== context.profile.content_hash) {
      throw new VideoWorkbenchServiceError('预检执行计划已经过期，请重新预检', 409, 'VIDEO_FINISHING_STALE')
    }
    if (report.state !== 'passed') {
      throw new VideoWorkbenchServiceError('当前交付变体尚未通过预检', 409, 'VIDEO_QUALITY_BLOCKED')
    }
    return { context, plan, report }
  }

  private executionPlanDurationMs(plan: VideoExecutionPlan): number {
    const duration = plan.timeline_items.reduce((latest, item) => {
      const end = timeToMilliseconds(endOfRange(item.timeline_range))
      return Math.max(latest, end)
    }, 0)
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw new VideoWorkbenchServiceError('执行计划没有可验证的交付时长', 409, 'VIDEO_FINISHING_INVALID')
    }
    return duration
  }

  private deliveryOutputExtension(profile: VideoExportProfileRevision): '.mp4' | '.mov' {
    return profile.encoding.container === 'mp4' ? '.mp4' : '.mov'
  }

  private deliveryOutputMime(profile: VideoExportProfileRevision): 'video/mp4' | 'video/quicktime' {
    return profile.encoding.container === 'mp4' ? 'video/mp4' : 'video/quicktime'
  }

  /**
   * Encoding always targets a path derived from the immutable plan. The user
   * selected destination is a publication target only, so it cannot alter the
   * bytes reviewed by preflight or make a stale plan write outside storage.
   */
  private executionPlanStagingBase(plan: VideoExecutionPlan): string {
    if (plan.output_target.kind !== 'managed' || plan.output_target.locator !== `execution-plans/${plan.id}`) {
      throw new VideoWorkbenchServiceError('执行计划输出目标不是该冻结计划的受管 locator', 409, 'VIDEO_FINISHING_STALE')
    }
    const root = resolve(this.repository.paths().exports)
    const base = resolve(root, plan.output_target.locator)
    if (!this.isWithinManagedRoot(root, base)) {
      throw new VideoWorkbenchServiceError('执行计划输出目标越过受管目录', 409, 'VIDEO_FINISHING_STALE')
    }
    return base
  }

  private executionPlanTemporaryOutput(
    plan: VideoExecutionPlan,
    operationId: string,
    extension: '.mp4' | '.mov',
  ): string {
    return `${this.executionPlanStagingBase(plan)}${extension}.partial-${operationId}${extension}`
  }

  private executionPlanTemporarySidecar(
    plan: VideoExecutionPlan,
    operationId: string,
    format: 'srt' | 'vtt',
  ): string {
    return `${this.executionPlanStagingBase(plan)}.partial-${operationId}.${format}`
  }

  /**
   * Resolve only managed, attested project assets.  The immutable Timeline
   * carries an id/hash pair; a path is deliberately resolved here at the
   * server boundary and never accepted from a CommandSet or Renderer.
   */
  private async deliveryProjectAssets(
    project: VideoStudioProject,
    plan: VideoExecutionPlan,
  ): Promise<Map<string, ExecutionPlanProjectAsset>> {
    const root = resolve(this.repository.paths().assets)
    const resolved = new Map<string, ExecutionPlanProjectAsset>()
    for (const item of plan.timeline_items) {
      if (item.binding.kind !== 'project_asset') continue
      const binding = item.binding
      const existing = resolved.get(binding.asset_id)
      if (existing) {
        if (existing.content_hash !== binding.asset_content_hash) {
          throw new VideoWorkbenchServiceError('同一项目资产在执行计划中出现冲突内容哈希', 409, 'VIDEO_FINISHING_STALE')
        }
        continue
      }
      const asset = project.assets.find(candidate => candidate.id === binding.asset_id)
      if (!asset || asset.storage.kind !== 'managed' || !asset.content_hash || asset.content_hash !== binding.asset_content_hash) {
        throw new VideoWorkbenchServiceError('执行计划引用的受管项目资产不可用或已变化', 409, 'VIDEO_FINISHING_STALE')
      }
      if (!project.video_asset_attestations.some(attestation => attestation.asset_id === asset.id && attestation.license_attestation.trim())) {
        throw new VideoWorkbenchServiceError('执行计划引用的项目资产缺少来源或许可声明', 409, 'VIDEO_FINISHING_INVALID')
      }
      const path = resolve(root, asset.storage.locator)
      if (!this.isWithinManagedRoot(root, path)) {
        throw new VideoWorkbenchServiceError('受管项目资产定位符无效', 409, 'VIDEO_FINISHING_INVALID')
      }
      const contentHash = await videoFingerprint(path).catch(() => null)
      if (!contentHash || contentHash !== binding.asset_content_hash) {
        throw new VideoWorkbenchServiceError('受管项目资产字节校验失败', 409, 'VIDEO_FINISHING_STALE')
      }
      resolved.set(asset.id, {
        path,
        content_hash: contentHash,
        ...(asset.mime_type ? { mime_type: asset.mime_type } : {}),
      })
    }
    return resolved
  }

  private async runDeliveryExecution(
    project: VideoStudioProject,
    plan: VideoExecutionPlan,
    outputPath: string,
    signal: AbortSignal,
    burnInCaptionPath?: string,
  ): Promise<ReturnType<typeof selectDeliveryVideoEncoder> extends Promise<infer T> ? T : never> {
    await this.assertExecutionPlanFiltersSupported(plan)
    const projectAssets = await this.deliveryProjectAssets(project, plan)
    const executionOptions = {
      ...(burnInCaptionPath ? { burnInCaptionPath } : {}),
      ...(burnInCaptionPath ? { burnInCaptionFontDirectory: this.controlledCaptionFontDirectory() } : {}),
      ...(projectAssets.size ? { projectAssets } : {}),
    }
    let encoder = await selectDeliveryVideoEncoder(this.runProcess, this.env, this.platform, plan.encoder)
    let result = await this.runProcess(
      buildExecutionPlanRenderCommand(
        videoBinary('ffmpeg', this.env, this.platform),
        project,
        plan,
        outputPath,
        encoder,
        executionOptions,
      ),
      { signal },
    )
    const isHardware = encoder.name === 'h264_videotoolbox' || encoder.name === 'h264_mf'
    if (result.exitCode !== 0 && !signal.aborted && !this.env.BB_FFMPEG_VIDEO_ENCODER?.trim() && isHardware) {
      const failedEncoder = encoder.name === 'h264_videotoolbox' ? 'h264_videotoolbox' : 'h264_mf'
      await rm(outputPath, { force: true }).catch(() => undefined)
      encoder = await selectDeliveryVideoEncoder(this.runProcess, this.env, this.platform, plan.encoder, {
        forceSoftware: true,
        fallbackFrom: failedEncoder,
      })
      result = await this.runProcess(
        buildExecutionPlanRenderCommand(
          videoBinary('ffmpeg', this.env, this.platform),
          project,
          plan,
          outputPath,
          encoder,
          executionOptions,
        ),
        { signal },
      )
    }
    if (result.exitCode !== 0 || signal.aborted) {
      throw new Error(result.stderr || 'delivery execution interrupted')
    }
    return encoder
  }

  /** Relay's startup probe owns the matching font face; no host fallback is valid for burn-in. */
  private controlledCaptionFontDirectory(): string {
    const directory = this.env.VIDEO_MEDIA_SUBTITLE_FONT_DIR?.trim()
    if (!directory || !isAbsolute(directory)) {
      throw new VideoWorkbenchServiceError('受控字幕字体目录未配置，不能安全烧录字幕', 503, 'VIDEO_FINISHING_UNAVAILABLE')
    }
    return directory
  }

  private findOperationReplay(
    operations: VideoOperation[],
    kind: 'video.preview' | 'video.render',
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
  ): VideoOperation | null {
    const existing = operations.find(candidate => candidate.kind === kind && candidate.idempotency_key === idempotencyKey)
    if (!existing) return null
    if (existing.result?.request_hash !== requestHash) {
      throw new VideoWorkbenchServiceError('同一幂等键不能提交不同的预览或导出请求', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
    }
    return existing
  }

  private async failOperation(
    operation: VideoOperation,
    code:
      | 'MEDIA_VIDEO_SOURCE_UNREADABLE'
      | 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE'
      | 'MEDIA_VIDEO_FINISHING_UNAVAILABLE'
      | 'MEDIA_VIDEO_PROBE_INTERRUPTED'
      | 'MEDIA_VIDEO_ANALYSIS_INTERRUPTED'
      | 'MEDIA_VIDEO_PREVIEW_FAILED'
      | 'MEDIA_VIDEO_PREVIEW_CANCELLED'
      | 'MEDIA_VIDEO_PREVIEW_INTERRUPTED'
      | 'MEDIA_VIDEO_EXPORT_FAILED'
      | 'MEDIA_VIDEO_EXPORT_CANCELLED'
      | 'MEDIA_VIDEO_EXPORT_INTERRUPTED'
      | 'MEDIA_VIDEO_QUALITY_BLOCKED',
    stage: string,
  ): Promise<VideoOperation> {
    const failure = mediaSafeError(code)
    return await this.repository.saveOperation(this.operation({
      ...operation,
      status: code.endsWith('_CANCELLED') ? 'cancelled' : 'failed',
      progress: 0,
      stage,
      error: failure.message,
      error_code: failure.code,
    }))
  }

  /**
   * A same-process failure can happen after publication but before the
   * recovery receipt is accepted. Do not leave the Project's preview/render
   * task permanently in `committing`; recovery on the next restart remains a
   * fallback, not the only way for the user to retry immediately.
   *
   * Published bytes are deliberately not deleted here. Preview files are
   * managed artifacts and formal output paths may be user-owned; publication
   * cleanup already refuses unsafe deletion of an unrelated file.
   */
  private async failPublishedDelivery(operation: VideoOperation, kind: 'preview' | 'render'): Promise<void> {
    const code = kind === 'preview' ? 'MEDIA_VIDEO_PREVIEW_FAILED' : 'MEDIA_VIDEO_EXPORT_FAILED'
    const failure = mediaSafeError(code)
    const project = await this.project(operation.project_id).catch(() => null)
    if (project) {
      if (kind === 'preview' && project.preview_task_id === operation.id) {
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          preview_task_id: undefined,
        })).catch(() => undefined)
      }
      if (kind === 'render' && project.task_id === operation.id) {
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          state: 'ready',
          task_id: undefined,
          error: failure.message,
          error_code: failure.code,
        })).catch(() => undefined)
      }
    }
    const current = await this.repository.getOperation(operation.id).catch(() => operation)
    await this.failOperation(
      current,
      code,
      kind === 'preview' ? '交付预览发布失败' : '交付导出发布失败',
    ).catch(() => undefined)
  }

  /** Legacy v1 Timeline rendering is permanently retired from the public API. */
  async previewVideo(_projectId: string, _raw: PreviewVideoInput): Promise<never> {
    throw new VideoWorkbenchServiceError('旧时间线预览已退役，请创建交付变体并执行预检后再生成预览', 410, 'VIDEO_LEGACY_RENDER_RETIRED')
  }

  private async previewLegacyTimeline(projectId: string, raw: PreviewVideoInput): Promise<VideoOperation> {
    return await this.mutateProject(projectId, async () => {
      const input = previewVideoInputSchema.parse(raw)
      let project = await this.requireVideoProject(projectId)
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再生成预览', 409, 'VIDEO_REVISION_CONFLICT')
      if (project.current_timeline_version_id !== input.timeline_version_id) {
        throw new VideoWorkbenchServiceError('视频时间线已更新，请刷新后再生成预览', 409, 'VIDEO_TIMELINE_CONFLICT')
      }
      const timeline = project.timeline_versions.find(version => version.id === input.timeline_version_id)
      if (!timeline) throw new VideoWorkbenchServiceError('视频时间线版本不存在', 404, 'VIDEO_TIMELINE_MISSING')
      if (!timeline.scenes.length) throw new VideoWorkbenchServiceError('时间线还是空的', 409, 'VIDEO_TIMELINE_EMPTY')
      project = await this.assertSourcesUnchanged(project)
      const existing = project.preview_task_id ? await this.repository.getOperation(project.preview_task_id).catch(() => null) : null
      if (existing && ['queued', 'running', 'committing'].includes(existing.status)) return existing
      const toolchain = await this.toolchainStatus()
      if (!toolchain.ffmpeg.available || !toolchain.ffprobe.available) {
        throw new VideoWorkbenchServiceError(mediaSafeError('MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE').message, 503, 'VIDEO_TOOLCHAIN_UNAVAILABLE')
      }
      const now = this.iso()
      const assetId = `preview_${randomUUID().replaceAll('-', '')}`
      const outputPath = join(this.repository.paths().assets, project.id, `${assetId}.mp4`)
      const assetPath = `/api/videos/projects/${project.id}/previews/${assetId}/content`
      const operation = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.preview',
        status: 'queued',
        progress: 0,
        stage: '等待生成预览',
        result: {
          preview_revision: project.revision,
          timeline_version_id: timeline.id,
          asset_id: assetId,
          asset_path: assetPath,
        },
        created_at: now,
        updated_at: now,
      } as unknown as VideoOperation))
      await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        preview_task_id: operation.id,
        error: undefined,
        error_code: undefined,
      }))
      const controller = new AbortController()
      const executionProject = this.projectForLegacyTimelineVersion(project, timeline)
      const completion = Promise.resolve().then(() => this.runPreview(executionProject, operation, outputPath, controller.signal))
      this.activePreviews.set(operation.id, { controller, completion, output_path: outputPath })
      return operation
    })
  }

  private async runPreview(
    project: VideoStudioProject,
    operation: VideoOperation,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const temporary = `${outputPath}.partial-${operation.id}.mp4`
    try {
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
      const running = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'running',
        progress: 10,
        stage: '正在生成预览',
        result: { ...(operation.result ?? {}), temporary_output: temporary },
      }))
      const result = await this.runProcess(
        buildVideoRenderCommand(
          videoBinary('ffmpeg', this.env, this.platform),
          this.previewProject(project),
          temporary,
          { name: 'mpeg4', args: ['-q:v', '5'] },
        ),
        { signal },
      )
      if (result.exitCode !== 0 || signal.aborted) throw new Error(result.stderr || 'preview interrupted')
      await this.assertSourcesUnchanged(project)
      const verified = await verifyVideoOutput(temporary, this.runProcess, videoBinary('ffprobe', this.env, this.platform))
      const committing = await this.repository.saveOperation(this.operation({
        ...running,
        status: 'committing',
        progress: 95,
        stage: '正在发布预览',
        result: { ...(running.result ?? {}), temporary_output: temporary, content_hash: verified.content_hash },
      }))
      const parsed = videoPreviewTaskResultSchema.parse(committing.result)
      const expectedSidecarAssetPath = `/api/videos/projects/${project.id}/previews/${parsed.asset_id}/sidecar`
      if (parsed.sidecar_caption && parsed.sidecar_caption.asset_path !== expectedSidecarAssetPath) {
        throw new VideoWorkbenchServiceError('预览字幕资源记录不匹配，不能发布', 409, 'VIDEO_PREVIEW_STALE')
      }
      await this.mutateProject(project.id, async () => {
        const latest = await this.requireVideoProject(project.id)
        if (
          latest.revision !== parsed.preview_revision
          || latest.current_timeline_version_id !== parsed.timeline_version_id
          || latest.preview_task_id !== operation.id
        ) throw new VideoWorkbenchServiceError('视频时间线已更新，本次预览不再发布', 409, 'VIDEO_PREVIEW_STALE')
        await this.movePublishedFile(temporary, outputPath)
        const asset: MediaAsset = {
          id: parsed.asset_id,
          role: 'preview',
          version_id: parsed.timeline_version_id,
          storage: { kind: 'managed', locator: join(project.id, basename(outputPath)) },
          mime_type: 'video/mp4',
          byte_size: verified.byte_size,
          content_hash: verified.content_hash,
          created_at: this.iso(),
        }
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          assets: [...latest.assets.filter(candidate => candidate.role !== 'preview'), asset],
          preview_task_id: undefined,
          preview: {
            timeline_version_id: parsed.timeline_version_id,
            asset_id: parsed.asset_id,
            asset_path: parsed.asset_path,
            content_hash: verified.content_hash,
            created_at: this.iso(),
          },
        }))
      })
      await this.repository.saveOperation(this.operation({
        ...committing,
        status: 'succeeded',
        progress: 100,
        stage: '预览已就绪',
        result: { ...(committing.result ?? {}), temporary_output: undefined, content_hash: verified.content_hash },
      }))
    } catch {
      await this.mutateProject(project.id, async () => {
        const latest = await this.requireVideoProject(project.id)
        if (latest.preview_task_id !== operation.id) return
        await this.repository.saveProject(videoStudioProjectSchema.parse({ ...latest, preview_task_id: undefined }))
      }).catch(() => undefined)
      await this.failOperation(operation, signal.aborted ? 'MEDIA_VIDEO_PREVIEW_CANCELLED' : 'MEDIA_VIDEO_PREVIEW_FAILED', signal.aborted ? '已取消' : '预览生成失败').catch(() => undefined)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      this.activePreviews.delete(operation.id)
    }
  }

  /**
   * Formal previews never project legacy scenes.  They execute the exact
   * immutable Variant Version and ExecutionPlan that passed preflight.
   */
  async previewDeliveryVariant(
    projectId: string,
    variantId: string,
    raw: PreviewVideoVariantInput,
    idempotencyKey: string,
  ): Promise<VideoOperation> {
    return await this.mutateProject(projectId, async () => {
      const input = previewVideoVariantInputSchema.parse(raw)
      let project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'preview_delivery_variant', variant_id: variantId, input })
      const replay = this.findOperationReplay(await this.repository.listOperations(project.id), 'video.preview', idempotencyKey, requestHash)
      if (replay) return replay
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再生成预览', 409, 'VIDEO_REVISION_CONFLICT')
      const { context, plan, report } = this.deliveryPreflight(project, variantId, input.base_variant_version_id)
      const existing = project.preview_task_id ? await this.repository.getOperation(project.preview_task_id).catch(() => null) : null
      if (existing && ['queued', 'running', 'committing'].includes(existing.status)) {
        throw new VideoWorkbenchServiceError('请先等待当前预览完成或取消', 409, 'VIDEO_PREVIEW_ACTIVE')
      }
      const toolchain = await this.toolchainStatus()
      if (!toolchain.ffmpeg.available || !toolchain.ffprobe.available) {
        throw new VideoWorkbenchServiceError(mediaSafeError('MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE').message, 503, 'VIDEO_TOOLCHAIN_UNAVAILABLE')
      }
      const assetId = `preview_${randomUUID().replaceAll('-', '')}`
      const extension = this.deliveryOutputExtension(context.profile)
      const outputPath = join(this.repository.paths().assets, project.id, `${assetId}${extension}`)
      const operation = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.preview',
        status: 'queued',
        progress: 0,
        stage: '等待按冻结交付版本生成预览',
        idempotency_key: idempotencyKey,
        result: {
          request_hash: requestHash,
          preview_revision: project.revision,
          timeline_version_id: context.timeline.id,
          delivery_variant_version_id: context.version.id,
          execution_plan_id: plan.id,
          preflight_report_id: report.id,
          asset_id: assetId,
          asset_path: `/api/videos/projects/${project.id}/previews/${assetId}/content`,
        },
        created_at: this.iso(),
        updated_at: this.iso(),
      } as unknown as VideoOperation))
      project = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        preview_task_id: operation.id,
        error: undefined,
        error_code: undefined,
      }))
      const controller = new AbortController()
      const active: ActiveVideoExecution = { controller, completion: Promise.resolve(), output_path: outputPath }
      active.completion = Promise.resolve().then(async () => await this.runDeliveryPreview(project, operation, plan, outputPath, controller.signal))
      this.activePreviews.set(operation.id, active)
      return operation
    })
  }

  private async runDeliveryPreview(
    project: VideoStudioProject,
    operation: VideoOperation,
    plan: VideoExecutionPlan,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const outputExtension = extname(outputPath) as '.mp4' | '.mov'
    const temporary = this.executionPlanTemporaryOutput(plan, operation.id, outputExtension)
    const captionPath = plan.caption?.mode === 'burn_in' ? `${temporary}.captions.srt` : undefined
    const sidecarPath = plan.caption?.mode === 'sidecar'
      ? `${outputPath.slice(0, -outputExtension.length)}.${plan.caption.sidecar_format ?? 'srt'}`
      : undefined
    const temporarySidecarPath = sidecarPath
      ? this.executionPlanTemporarySidecar(plan, operation.id, plan.caption?.sidecar_format ?? 'srt')
      : undefined
    let published = false
    try {
      await mkdir(dirname(temporary), { recursive: true, mode: 0o700 })
      const running = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'running',
        progress: 10,
        stage: '正在按冻结交付版本生成预览',
        result: {
          ...(operation.result ?? {}),
          temporary_output: temporary,
          ...(temporarySidecarPath ? { temporary_sidecar_path: temporarySidecarPath } : {}),
        },
      }))
      if (captionPath) await writeExecutionPlanCaption(plan, captionPath, 'srt')
      const sidecar = temporarySidecarPath && plan.caption
        ? await writeExecutionPlanCaption(plan, temporarySidecarPath, plan.caption.sidecar_format ?? 'srt')
        : null
      const encoder = await this.runDeliveryExecution(project, plan, temporary, signal, captionPath)
      await this.assertSourcesUnchanged(project)
      const verified = await verifyVideoOutput(temporary, this.runProcess, videoBinary('ffprobe', this.env, this.platform))
      const committing = await this.repository.saveOperation(this.operation({
        ...running,
        status: 'committing',
        progress: 95,
        stage: '正在发布交付预览',
        result: {
          ...(running.result ?? {}),
          temporary_output: temporary,
          content_hash: verified.content_hash,
          video_encoder: encoder.name,
          ...(encoder.fallback_from ? { encoder_fallback_from: encoder.fallback_from } : {}),
          ...(sidecar && plan.caption ? {
            sidecar_caption: {
              format: plan.caption.sidecar_format ?? 'srt',
              asset_path: `/api/videos/projects/${project.id}/previews/${basename(outputPath, outputExtension)}/sidecar`,
              byte_size: sidecar.byte_size,
              content_hash: sidecar.content_hash,
              caption_basis_hash: plan.caption.basis_hash,
            },
          } : {}),
        },
      }))
      const parsed = videoPreviewTaskResultSchema.parse(committing.result)
      await this.mutateProject(project.id, async () => {
        const latest = await this.requireVideoProject(project.id)
        const variant = parsed.delivery_variant_version_id
          ? latest.delivery_variants.find(candidate => latest.delivery_variant_versions.some(version => version.id === parsed.delivery_variant_version_id && version.variant_id === candidate.id))
          : undefined
        if (
          latest.revision !== parsed.preview_revision
          || !variant
          || variant.current_version_id !== parsed.delivery_variant_version_id
          || latest.preview_task_id !== operation.id
        ) throw new VideoWorkbenchServiceError('交付变体已更新，本次预览不再发布', 409, 'VIDEO_PREVIEW_STALE')
        await this.publishFiles([
          { source: temporary, destination: outputPath, content_hash: verified.content_hash },
          ...(temporarySidecarPath && sidecarPath && parsed.sidecar_caption
            ? [{ source: temporarySidecarPath, destination: sidecarPath, content_hash: parsed.sidecar_caption.content_hash }]
            : []),
        ])
        published = true
        const profile = plan.encoder
        const asset: MediaAsset = {
          id: parsed.asset_id,
          role: 'preview',
          version_id: plan.delivery_variant_version_id,
          storage: { kind: 'managed', locator: join(project.id, basename(outputPath)) },
          mime_type: this.deliveryOutputMime(profile),
          byte_size: verified.byte_size,
          content_hash: verified.content_hash,
          created_at: this.iso(),
        }
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          assets: [...latest.assets.filter(candidate => candidate.role !== 'preview'), asset],
          preview_task_id: undefined,
          preview: {
            timeline_version_id: plan.editorial_timeline_version_id,
            delivery_variant_version_id: plan.delivery_variant_version_id,
            execution_plan_id: plan.id,
            asset_id: parsed.asset_id,
            asset_path: parsed.asset_path,
            content_hash: verified.content_hash,
            ...(parsed.sidecar_caption ? { sidecar_caption: parsed.sidecar_caption } : {}),
            created_at: this.iso(),
          },
        }))
      })
      await this.repository.saveOperation(this.operation({
        ...committing,
        status: 'succeeded',
        progress: 100,
        stage: '交付预览已就绪',
        result: { ...(committing.result ?? {}), temporary_output: undefined, temporary_sidecar_path: undefined, content_hash: verified.content_hash },
      }))
    } catch {
      if (published) {
        const current = await this.repository.getOperation(operation.id).catch(() => null)
        if (current && await this.recoverCommittedPreview(current).catch(() => false)) return
        await this.failPublishedDelivery(current ?? operation, 'preview')
      }
      if (!published) {
        await this.mutateProject(project.id, async () => {
          const latest = await this.requireVideoProject(project.id)
          if (latest.preview_task_id !== operation.id) return
          await this.repository.saveProject(videoStudioProjectSchema.parse({ ...latest, preview_task_id: undefined }))
        }).catch(() => undefined)
        await this.failOperation(operation, signal.aborted ? 'MEDIA_VIDEO_PREVIEW_CANCELLED' : 'MEDIA_VIDEO_PREVIEW_FAILED', signal.aborted ? '已取消' : '交付预览生成失败').catch(() => undefined)
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      if (captionPath) await rm(captionPath, { force: true }).catch(() => undefined)
      if (temporarySidecarPath) await rm(temporarySidecarPath, { force: true }).catch(() => undefined)
      this.activePreviews.delete(operation.id)
    }
  }

  /** Legacy v1 Timeline rendering is permanently retired from the public API. */
  async renderVideo(_projectId: string, _raw: RenderVideoInput): Promise<never> {
    throw new VideoWorkbenchServiceError('旧时间线导出已退役，请创建交付变体并执行预检后再导出', 410, 'VIDEO_LEGACY_RENDER_RETIRED')
  }

  private async renderLegacyTimeline(projectId: string, raw: RenderVideoInput): Promise<VideoOperation> {
    return await this.mutateProject(projectId, async () => {
      const input = renderVideoInputSchema.parse(raw)
      let project = await this.requireVideoProject(projectId)
      if (project.state === 'rendering') {
        const existing = project.task_id ? await this.repository.getOperation(project.task_id).catch(() => null) : null
        if (existing && ['queued', 'running', 'committing'].includes(existing.status)) return existing
        throw new VideoWorkbenchServiceError('导出状态异常，请刷新后重试', 409, 'VIDEO_RENDER_STATE_CONFLICT')
      }
      if (project.preview_task_id) {
        const preview = await this.repository.getOperation(project.preview_task_id).catch(() => null)
        if (preview && ['queued', 'running', 'committing'].includes(preview.status)) {
          throw new VideoWorkbenchServiceError('请先等待视频预览完成或取消预览', 409, 'VIDEO_PREVIEW_ACTIVE')
        }
      }
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再导出', 409, 'VIDEO_REVISION_CONFLICT')
      const timelineVersionId = input.timeline_version_id ?? project.current_timeline_version_id
      if (project.current_timeline_version_id !== timelineVersionId || !timelineVersionId) {
        throw new VideoWorkbenchServiceError('视频时间线已更新，请刷新后再导出', 409, 'VIDEO_TIMELINE_CONFLICT')
      }
      const timeline = project.timeline_versions.find(version => version.id === timelineVersionId)
      if (!timeline) {
        throw new VideoWorkbenchServiceError('视频时间线版本不存在', 409, 'VIDEO_TIMELINE_MISSING')
      }
      if (!timeline.scenes.length) throw new VideoWorkbenchServiceError('时间线还是空的', 409, 'VIDEO_TIMELINE_EMPTY')
      project = await this.assertSourcesUnchanged(project)
      if (!isAbsolute(input.output_path)) throw new VideoWorkbenchServiceError('导出路径必须是绝对路径', 400, 'VIDEO_OUTPUT_PATH_INVALID')
      if (!['.mp4', '.mov'].includes(extname(input.output_path).toLowerCase())) {
        throw new VideoWorkbenchServiceError('视频只能导出为 MP4 或 MOV', 400, 'VIDEO_OUTPUT_FORMAT_INVALID')
      }
      const normalizedOutput = resolve(input.output_path)
      if (project.sources.some(source => resolve(source.path) === normalizedOutput)) {
        throw new VideoWorkbenchServiceError('导出位置不能覆盖原始视频素材', 409, 'VIDEO_OUTPUT_OVERWRITES_SOURCE')
      }
      const toolchain = await this.toolchainStatus()
      if (!toolchain.ffmpeg.available || !toolchain.ffprobe.available) {
        throw new VideoWorkbenchServiceError(mediaSafeError('MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE').message, 503, 'VIDEO_TOOLCHAIN_UNAVAILABLE')
      }
      if (this.activeRenders.size >= this.renderQueueLimit()) {
        throw new VideoWorkbenchServiceError('视频导出队列已满，请等待当前导出完成后再试', 429, 'VIDEO_RENDER_QUEUE_FULL')
      }
      const now = this.iso()
      const operation = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.render',
        status: 'queued',
        progress: 0,
        stage: '等待导出',
        result: {
          render_revision: project.revision,
          timeline_version_id: timelineVersionId,
          output_path: normalizedOutput,
        },
        created_at: now,
        updated_at: now,
      } as unknown as VideoOperation))
      await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        state: 'rendering',
        task_id: operation.id,
        output_path: normalizedOutput,
        output_asset_id: undefined,
        output_content_hash: undefined,
        output_verification: undefined,
        error: undefined,
        error_code: undefined,
      }))
      const controller = new AbortController()
      const active: ActiveVideoExecution = {
        controller,
        completion: Promise.resolve(),
        output_path: normalizedOutput,
      }
      active.completion = this.enqueueRender(async () => {
        active.started = true
        if (active.cancelledBeforeStart) return
        await this.runRender(this.projectForLegacyTimelineVersion(project, timeline), operation, normalizedOutput, controller.signal)
      })
      this.activeRenders.set(operation.id, active)
      return operation
    })
  }

  private async runRender(
    project: VideoStudioProject,
    operation: VideoOperation,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const extension = extname(outputPath).toLowerCase() || '.mp4'
    const temporary = join(dirname(outputPath), `${basename(outputPath, extension)}.partial-${operation.id}${extension}`)
    let published = false
    try {
      if (signal.aborted) throw new Error('render cancelled before start')
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
      const running = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'running',
        progress: 10,
        stage: '正在导出',
        result: { ...(operation.result ?? {}), temporary_output: temporary },
      }))
      let encoder = await selectVideoEncoder(this.runProcess, this.env, this.platform)
      let result = await this.runProcess(
        buildVideoRenderCommand(videoBinary('ffmpeg', this.env, this.platform), project, temporary, encoder),
        { signal },
      )
      if (
        result.exitCode !== 0
        && !signal.aborted
        && !this.env.BB_FFMPEG_VIDEO_ENCODER?.trim()
        && encoder.name !== FALLBACK_VIDEO_ENCODER.name
      ) {
        await rm(temporary, { force: true }).catch(() => undefined)
        encoder = FALLBACK_VIDEO_ENCODER
        result = await this.runProcess(
          buildVideoRenderCommand(videoBinary('ffmpeg', this.env, this.platform), project, temporary, encoder),
          { signal },
        )
      }
      if (result.exitCode !== 0 || signal.aborted) throw new Error(result.stderr || 'render interrupted')
      await this.assertSourcesUnchanged(project)
      const inspection = await verifyVideoOutput(temporary, this.runProcess, videoBinary('ffprobe', this.env, this.platform))
      const verification = {
        timeline_version_id: project.current_timeline_version_id!,
        byte_size: inspection.byte_size,
        file_mtime_ms: inspection.file_mtime_ms,
        duration_ms: inspection.duration_ms,
        video_stream_count: inspection.video_stream_count,
        audio_stream_count: inspection.audio_stream_count,
        ...(inspection.width ? { width: inspection.width } : {}),
        ...(inspection.height ? { height: inspection.height } : {}),
        ...(inspection.fps ? { fps: inspection.fps } : {}),
        content_hash: inspection.content_hash,
        verified_at: this.iso(),
      }
      const outputAssetId = `out_${randomUUID().replaceAll('-', '')}`
      const committing = await this.repository.saveOperation(this.operation({
        ...running,
        status: 'committing',
        progress: 95,
        stage: '正在完成导出',
        result: {
          ...(running.result ?? {}),
          temporary_output: temporary,
          output_asset_id: outputAssetId,
          output_content_hash: verification.content_hash,
          output_verification: verification,
        },
      }))
      const parsed = videoRenderTaskResultSchema.parse(committing.result)
      await this.mutateProject(project.id, async () => {
        const latest = await this.requireVideoProject(project.id)
        if (
          latest.revision !== parsed.render_revision
          || latest.current_timeline_version_id !== parsed.timeline_version_id
          || latest.task_id !== operation.id
        ) throw new VideoWorkbenchServiceError('视频项目已更新，本次导出结果不再发布', 409, 'VIDEO_RENDER_STALE')
        await this.movePublishedFile(temporary, outputPath)
        published = true
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          state: 'complete',
          task_id: undefined,
          output_path: outputPath,
          output_asset_id: outputAssetId,
          output_content_hash: verification.content_hash,
          output_verification: verification,
          error: undefined,
          error_code: undefined,
        }))
      })
      await this.repository.saveOperation(this.operation({
        ...committing,
        status: 'succeeded',
        progress: 100,
        stage: '导出完成',
        result: {
          ...(committing.result ?? {}),
          temporary_output: undefined,
          output_path: outputPath,
          output_asset_id: outputAssetId,
          output_content_hash: verification.content_hash,
          output_verification: verification,
          video_encoder: encoder.name,
        },
      }))
    } catch {
      if (!published) {
        const latest = await this.project(project.id).catch(() => null)
        if (latest?.task_id === operation.id) {
          const failure = mediaSafeError(signal.aborted ? 'MEDIA_VIDEO_EXPORT_CANCELLED' : 'MEDIA_VIDEO_EXPORT_FAILED')
          await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            state: signal.aborted ? 'ready' : 'failed',
            task_id: undefined,
            error: failure.message,
            error_code: failure.code,
          })).catch(() => undefined)
        }
        await this.failOperation(operation, signal.aborted ? 'MEDIA_VIDEO_EXPORT_CANCELLED' : 'MEDIA_VIDEO_EXPORT_FAILED', signal.aborted ? '已取消' : '导出失败').catch(() => undefined)
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      this.activeRenders.delete(operation.id)
    }
  }

  /** Formal export follows the same frozen Variant/Plan path as preview. */
  async renderDeliveryVariant(
    projectId: string,
    variantId: string,
    raw: RenderVideoVariantInput,
    idempotencyKey: string,
  ): Promise<VideoOperation> {
    return await this.mutateProject(projectId, async () => {
      const input = renderVideoVariantInputSchema.parse(raw)
      let project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash({ kind: 'render_delivery_variant', variant_id: variantId, input })
      const replay = this.findOperationReplay(await this.repository.listOperations(project.id), 'video.render', idempotencyKey, requestHash)
      if (replay) return replay
      if (project.state === 'rendering') {
        throw new VideoWorkbenchServiceError('已有交付导出正在运行，请先等待或取消', 409, 'VIDEO_RENDER_STATE_CONFLICT')
      }
      if (project.preview_task_id) {
        const preview = await this.repository.getOperation(project.preview_task_id).catch(() => null)
        if (preview && ['queued', 'running', 'committing'].includes(preview.status)) {
          throw new VideoWorkbenchServiceError('请先等待当前预览完成或取消', 409, 'VIDEO_PREVIEW_ACTIVE')
        }
      }
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再导出', 409, 'VIDEO_REVISION_CONFLICT')
      const { context, plan, report } = this.deliveryPreflight(project, variantId, input.base_variant_version_id)
      if (!isAbsolute(input.output_path)) throw new VideoWorkbenchServiceError('导出路径必须是绝对路径', 400, 'VIDEO_OUTPUT_PATH_INVALID')
      const outputPath = resolve(input.output_path)
      const extension = extname(outputPath).toLowerCase()
      if (extension !== this.deliveryOutputExtension(context.profile)) {
        throw new VideoWorkbenchServiceError('导出文件扩展名必须与冻结的交付规格一致', 400, 'VIDEO_OUTPUT_FORMAT_INVALID')
      }
      if (project.sources.some(source => resolve(source.path) === outputPath)) {
        throw new VideoWorkbenchServiceError('导出位置不能覆盖原始视频素材', 409, 'VIDEO_OUTPUT_OVERWRITES_SOURCE')
      }
      if (await stat(outputPath).then(() => true).catch(() => false)) {
        throw new VideoWorkbenchServiceError('导出位置已有文件，正式导出不会覆盖它', 409, 'VIDEO_OUTPUT_EXISTS')
      }
      const sidecarPath = plan.caption?.mode === 'sidecar'
        ? `${outputPath.slice(0, -extension.length)}.${plan.caption.sidecar_format ?? 'srt'}`
        : undefined
      if (sidecarPath && await stat(sidecarPath).then(() => true).catch(() => false)) {
        throw new VideoWorkbenchServiceError('字幕输出位置已有文件，正式导出不会覆盖它', 409, 'VIDEO_OUTPUT_EXISTS')
      }
      const toolchain = await this.toolchainStatus()
      if (!toolchain.ffmpeg.available || !toolchain.ffprobe.available) {
        throw new VideoWorkbenchServiceError(mediaSafeError('MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE').message, 503, 'VIDEO_TOOLCHAIN_UNAVAILABLE')
      }
      if (this.activeRenders.size >= this.renderQueueLimit()) {
        throw new VideoWorkbenchServiceError('视频导出队列已满，请等待当前导出完成后再试', 429, 'VIDEO_RENDER_QUEUE_FULL')
      }
      const operation = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.render',
        status: 'queued',
        progress: 0,
        stage: '等待按冻结交付版本导出',
        idempotency_key: idempotencyKey,
        result: {
          request_hash: requestHash,
          render_revision: project.revision,
          timeline_version_id: context.timeline.id,
          delivery_variant_version_id: context.version.id,
          execution_plan_id: plan.id,
          preflight_report_id: report.id,
          output_path: outputPath,
          ...(sidecarPath ? { sidecar_caption_path: sidecarPath } : {}),
        },
        created_at: this.iso(),
        updated_at: this.iso(),
      } as unknown as VideoOperation))
      project = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        state: 'rendering',
        task_id: operation.id,
        output_path: outputPath,
        output_asset_id: undefined,
        output_content_hash: undefined,
        output_verification: undefined,
        error: undefined,
        error_code: undefined,
      }))
      const controller = new AbortController()
      const active: ActiveVideoExecution = { controller, completion: Promise.resolve(), output_path: outputPath }
      active.completion = this.enqueueRender(async () => {
        active.started = true
        if (active.cancelledBeforeStart) return
        await this.runDeliveryRender(project, operation, plan, outputPath, controller.signal)
      })
      this.activeRenders.set(operation.id, active)
      return operation
    })
  }

  private async runDeliveryRender(
    project: VideoStudioProject,
    operation: VideoOperation,
    plan: VideoExecutionPlan,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const extension = this.deliveryOutputExtension(plan.encoder)
    const temporary = this.executionPlanTemporaryOutput(plan, operation.id, extension)
    const burnInCaptionPath = plan.caption?.mode === 'burn_in' ? `${temporary}.captions.srt` : undefined
    const sidecarPath = plan.caption?.mode === 'sidecar'
      ? `${outputPath.slice(0, -extension.length)}.${plan.caption.sidecar_format ?? 'srt'}`
      : undefined
    const temporarySidecarPath = sidecarPath
      ? this.executionPlanTemporarySidecar(plan, operation.id, plan.caption?.sidecar_format ?? 'srt')
      : undefined
    let published = false
    let retainTemporaryOutput = false
    // After the parent records a quality wait, that receipt owns the
    // temporary bytes. Later projection writes are recoverable and must not
    // overwrite the parent back to a stale queued state or delete the bytes.
    let durableQualityWait = false
    try {
      if (signal.aborted) throw new Error('render cancelled before start')
      await mkdir(dirname(temporary), { recursive: true, mode: 0o700 })
      const running = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'running',
        progress: 10,
        stage: '正在按冻结交付版本导出',
        result: {
          ...(operation.result ?? {}),
          temporary_output: temporary,
          ...(temporarySidecarPath ? { temporary_sidecar_path: temporarySidecarPath } : {}),
        },
      }))
      if (burnInCaptionPath) await writeExecutionPlanCaption(plan, burnInCaptionPath, 'srt')
      const sidecar = temporarySidecarPath && plan.caption
        ? await writeExecutionPlanCaption(plan, temporarySidecarPath, plan.caption.sidecar_format ?? 'srt')
        : null
      const encoder = await this.runDeliveryExecution(project, plan, temporary, signal, burnInCaptionPath)
      await this.assertSourcesUnchanged(project)
      const verificationOperation = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.output_verify',
        status: 'running',
        progress: 30,
        stage: '正在校验实际导出文件',
        result: { parent_operation_id: operation.id, execution_plan_id: plan.id, output_path: temporary },
        created_at: this.iso(),
        updated_at: this.iso(),
      } as unknown as VideoOperation))
      let inspected: Awaited<ReturnType<typeof verifyDeliveryVideoOutput>>
      try {
        inspected = await verifyDeliveryVideoOutput({
          path: temporary,
          runProcess: this.runProcess,
          ffmpeg: videoBinary('ffmpeg', this.env, this.platform),
          ffprobe: videoBinary('ffprobe', this.env, this.platform),
          expected_duration_ms: this.executionPlanDurationMs(plan),
          expected_profile: plan.encoder,
        })
        await this.repository.saveOperation(this.operation({
          ...verificationOperation,
          status: 'succeeded',
          progress: 100,
          stage: '实际导出文件校验通过',
          result: { ...(verificationOperation.result ?? {}), output_verification: inspected },
        }))
      } catch (error) {
        await this.failOperation(verificationOperation, 'MEDIA_VIDEO_EXPORT_FAILED', '实际导出文件校验失败').catch(() => undefined)
        throw error
      }
      const verification: VideoOutputVerification = {
        timeline_version_id: plan.editorial_timeline_version_id,
        delivery_variant_version_id: plan.delivery_variant_version_id,
        execution_plan_id: plan.id,
        ...inspected,
        ...(sidecar && plan.caption ? {
          sidecar_caption: {
            format: plan.caption.sidecar_format ?? 'srt',
            byte_size: sidecar.byte_size,
            content_hash: sidecar.content_hash,
            caption_basis_hash: plan.caption.basis_hash,
          },
        } : {}),
        verified_at: this.iso(),
      }
      const variantId = project.delivery_variant_versions.find(candidate => candidate.id === plan.delivery_variant_version_id)?.variant_id
      if (!variantId) throw new VideoWorkbenchServiceError('执行计划引用的交付变体已不存在', 409, 'VIDEO_FINISHING_STALE')
      const context = this.deliveryVariantContext(project, variantId, plan.delivery_variant_version_id)
      const report = this.finishing.createPostRenderReport({
        project,
        version: context.version,
        timeline: context.timeline,
        profile: context.profile,
        executionPlanId: plan.id,
        output: verification,
      })
      const outputAssetId = `out_${randomUUID().replaceAll('-', '')}`
      let waitingForQuality: VideoOperation | undefined
      if (report.state === 'needs_user_decision') {
        // Persist the recovery authority before its denormalized projections.
        // A restart can reconstruct the Project report from this exact receipt.
        waitingForQuality = await this.repository.saveOperation(this.operation({
          ...running,
          status: 'committing',
          progress: 90,
          stage: '导出后质量报告等待人工确认',
          result: {
            ...(running.result ?? {}),
            temporary_output: temporary,
            ...(temporarySidecarPath ? { temporary_sidecar_path: temporarySidecarPath } : {}),
            output_asset_id: outputAssetId,
            output_content_hash: verification.content_hash,
            output_verification: verification,
            post_render_report_id: report.id,
            post_render_report: report,
            awaiting_quality_confirmation: true,
            video_encoder: encoder.name,
            ...(encoder.fallback_from ? { encoder_fallback_from: encoder.fallback_from } : {}),
            ...(sidecarPath ? { sidecar_caption_path: sidecarPath } : {}),
          },
        }))
        durableQualityWait = true
        retainTemporaryOutput = true
        videoRenderTaskResultSchema.parse(waitingForQuality.result)
      }
      const qualityOperation = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.quality_post_render',
        status: 'running',
        progress: 50,
        stage: '正在生成导出后质量报告',
        result: { parent_operation_id: operation.id, execution_plan_id: plan.id, report_id: report.id },
        created_at: this.iso(),
        updated_at: this.iso(),
      } as unknown as VideoOperation))
      await this.repository.saveOperation(this.operation({
        ...qualityOperation,
        status: report.state === 'blocked' ? 'failed' : 'succeeded',
        progress: 100,
        stage: report.state === 'passed'
          ? '导出后质量报告通过'
          : report.state === 'needs_user_decision'
            ? '导出后质量报告等待人工确认'
            : '导出后质量报告阻止交付',
        result: { ...(qualityOperation.result ?? {}), report },
        ...(report.state === 'blocked' ? { error: mediaSafeError('MEDIA_VIDEO_QUALITY_BLOCKED').message, error_code: 'MEDIA_VIDEO_QUALITY_BLOCKED' } : {}),
      }))
      if (report.state === 'blocked') {
        await this.mutateProject(project.id, async () => {
          const latest = await this.requireVideoProject(project.id)
          if (latest.task_id !== operation.id) return
          const failure = mediaSafeError('MEDIA_VIDEO_QUALITY_BLOCKED')
          await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            state: 'ready',
            task_id: undefined,
            quality_reports: [...latest.quality_reports, report],
            error: failure.message,
            error_code: failure.code,
          }))
        })
        throw new VideoWorkbenchServiceError('导出文件未通过质量报告，未发布到目标位置', 409, 'VIDEO_QUALITY_BLOCKED')
      }
      if (report.state === 'needs_user_decision') {
        if (!waitingForQuality) {
          throw new VideoWorkbenchServiceError('质量确认等待状态未能持久化', 503, 'VIDEO_FINISHING_UNAVAILABLE')
        }
        await this.persistPendingPostRenderQualityReport(project.id, waitingForQuality)
        return
      }
      const committing = await this.repository.saveOperation(this.operation({
        ...running,
        status: 'committing',
        progress: 95,
        stage: '正在发布已验证的交付文件',
        result: {
          ...(running.result ?? {}),
          temporary_output: temporary,
          ...(temporarySidecarPath ? { temporary_sidecar_path: temporarySidecarPath } : {}),
          output_asset_id: outputAssetId,
          output_content_hash: verification.content_hash,
          output_verification: verification,
          post_render_report_id: report.id,
          post_render_report: report,
          video_encoder: encoder.name,
          ...(encoder.fallback_from ? { encoder_fallback_from: encoder.fallback_from } : {}),
          ...(sidecarPath ? { sidecar_caption_path: sidecarPath } : {}),
        },
      }))
      const parsed = videoRenderTaskResultSchema.parse(committing.result)
      await this.mutateProject(project.id, async () => {
        const latest = await this.requireVideoProject(project.id)
        const variant = parsed.delivery_variant_version_id
          ? latest.delivery_variants.find(candidate => candidate.current_version_id === parsed.delivery_variant_version_id)
          : undefined
        if (
          latest.revision !== parsed.render_revision
          || !variant
          || latest.task_id !== operation.id
        ) throw new VideoWorkbenchServiceError('交付变体已更新，本次导出结果不再发布', 409, 'VIDEO_RENDER_STALE')
        await this.publishFiles([
          { source: temporary, destination: outputPath, content_hash: verification.content_hash },
          ...(temporarySidecarPath && sidecarPath && verification.sidecar_caption
            ? [{ source: temporarySidecarPath, destination: sidecarPath, content_hash: verification.sidecar_caption.content_hash }]
            : []),
        ])
        published = true
        const asset: MediaAsset = {
          id: outputAssetId,
          role: 'export',
          version_id: plan.delivery_variant_version_id,
          storage: { kind: 'external', locator: outputPath },
          mime_type: this.deliveryOutputMime(plan.encoder),
          byte_size: verification.byte_size,
          content_hash: verification.content_hash,
          created_at: this.iso(),
        }
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...latest,
          assets: [...latest.assets.filter(candidate => candidate.role !== 'export'), asset],
          state: 'complete',
          task_id: undefined,
          output_path: outputPath,
          output_asset_id: outputAssetId,
          output_content_hash: verification.content_hash,
          output_verification: verification,
          quality_reports: [...latest.quality_reports, report],
          error: undefined,
          error_code: undefined,
        }))
      })
      await this.repository.saveOperation(this.operation({
        ...committing,
        status: 'succeeded',
        progress: 100,
        stage: '交付导出完成',
        result: { ...(committing.result ?? {}), temporary_output: undefined, temporary_sidecar_path: undefined },
      }))
    } catch (error) {
      if (published) {
        const current = await this.repository.getOperation(operation.id).catch(() => null)
        if (current && await this.recoverCommittedRender(current).catch(() => false)) return
        await this.failPublishedDelivery(current ?? operation, 'render')
      }
      if (!published && !durableQualityWait) {
        const qualityBlocked = error instanceof VideoWorkbenchServiceError && error.code === 'VIDEO_QUALITY_BLOCKED'
        const latest = await this.project(project.id).catch(() => null)
        if (latest?.task_id === operation.id) {
          const failure = mediaSafeError(qualityBlocked ? 'MEDIA_VIDEO_QUALITY_BLOCKED' : signal.aborted ? 'MEDIA_VIDEO_EXPORT_CANCELLED' : 'MEDIA_VIDEO_EXPORT_FAILED')
          await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            state: signal.aborted ? 'ready' : 'failed',
            task_id: undefined,
            error: failure.message,
            error_code: failure.code,
          })).catch(() => undefined)
        }
        await this.failOperation(
          operation,
          qualityBlocked ? 'MEDIA_VIDEO_QUALITY_BLOCKED' : signal.aborted ? 'MEDIA_VIDEO_EXPORT_CANCELLED' : 'MEDIA_VIDEO_EXPORT_FAILED',
          qualityBlocked ? '导出后质量报告未通过' : signal.aborted ? '已取消' : '交付导出失败',
        ).catch(() => undefined)
      }
    } finally {
      if (!retainTemporaryOutput) await rm(temporary, { force: true }).catch(() => undefined)
      if (burnInCaptionPath) await rm(burnInCaptionPath, { force: true }).catch(() => undefined)
      if (!retainTemporaryOutput && temporarySidecarPath) await rm(temporarySidecarPath, { force: true }).catch(() => undefined)
      this.activeRenders.delete(operation.id)
    }
  }

  private pendingPostRenderQuality(
    project: VideoStudioProject,
    operation: VideoOperation,
  ): PendingPostRenderQuality {
    const parsed = videoRenderTaskResultSchema.safeParse(operation.result)
    if (
      !parsed.success
      || !parsed.data.execution_plan_id
      || !parsed.data.delivery_variant_version_id
      || !parsed.data.output_asset_id
      || !parsed.data.output_content_hash
      || !parsed.data.output_verification
      || !parsed.data.post_render_report_id
      || !parsed.data.post_render_report
    ) {
      throw new VideoWorkbenchServiceError('等待确认的导出记录不完整，不能发布文件', 409, 'VIDEO_FINISHING_STALE')
    }
    const result = parsed.data
    const report = result.post_render_report!
    const outputVerification = result.output_verification!
    const plan = project.execution_plans.find(candidate => candidate.id === result.execution_plan_id)
    const version = project.delivery_variant_versions.find(candidate => candidate.id === result.delivery_variant_version_id)
    const variant = version && project.delivery_variants.find(candidate => candidate.id === version.variant_id)
    const storedReport = project.quality_reports.find(candidate => candidate.id === report.id)
    if (
      operation.kind !== 'video.render'
      || report.id !== result.post_render_report_id
      || report.kind !== 'post_render'
      || report.state !== 'needs_user_decision'
      || report.project_id !== project.id
      || report.execution_plan_id !== result.execution_plan_id
      || report.delivery_variant_version_id !== result.delivery_variant_version_id
      || report.output_verification?.content_hash !== result.output_content_hash
      || outputVerification.content_hash !== result.output_content_hash
      || outputVerification.execution_plan_id !== result.execution_plan_id
      || outputVerification.delivery_variant_version_id !== result.delivery_variant_version_id
      || !plan
      || plan.delivery_variant_version_id !== result.delivery_variant_version_id
      || plan.encoder.id !== report.export_profile_revision_id
      || !version
      || variant?.current_version_id !== version.id
      || project.revision !== result.render_revision
      || !storedReport
      || JSON.stringify(storedReport) !== JSON.stringify(report)
      || report.checks.some(check => check.state === 'blocked')
    ) {
      throw new VideoWorkbenchServiceError('后渲染质量报告或冻结交付版本已变化，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
    }
    return { result, report, plan }
  }

  /**
   * The parent render Operation is written before this denormalized Project
   * projection.  Rebuild the projection from that immutable parent receipt on
   * retry/startup, rather than making a process stop between the two writes
   * discard a verified output that is waiting for a human decision.
   */
  private async persistPendingPostRenderQualityReport(
    projectId: string,
    operation: VideoOperation,
  ): Promise<VideoStudioProject> {
    const parsed = videoRenderTaskResultSchema.safeParse(operation.result)
    if (
      !parsed.success
      || operation.kind !== 'video.render'
      || operation.status !== 'committing'
      || parsed.data.awaiting_quality_confirmation !== true
      || !parsed.data.execution_plan_id
      || !parsed.data.delivery_variant_version_id
      || !parsed.data.output_asset_id
      || !parsed.data.output_content_hash
      || !parsed.data.output_verification
      || !parsed.data.post_render_report_id
      || !parsed.data.post_render_report
    ) {
      throw new VideoWorkbenchServiceError('等待确认的导出记录不完整，不能恢复质量报告', 409, 'VIDEO_FINISHING_STALE')
    }
    const result = parsed.data
    const report = result.post_render_report!
    const outputVerification = result.output_verification!
    return await this.mutateProject(projectId, async () => {
      const latest = await this.requireVideoProject(projectId)
      const plan = latest.execution_plans.find(candidate => candidate.id === result.execution_plan_id)
      const version = latest.delivery_variant_versions.find(candidate => candidate.id === result.delivery_variant_version_id)
      const variant = version && latest.delivery_variants.find(candidate => candidate.id === version.variant_id)
      if (
        latest.task_id !== operation.id
        || latest.revision !== result.render_revision
        || !plan
        || plan.delivery_variant_version_id !== result.delivery_variant_version_id
        || !version
        || variant?.current_version_id !== version.id
        || report.id !== result.post_render_report_id
        || report.kind !== 'post_render'
        || report.state !== 'needs_user_decision'
        || report.project_id !== latest.id
        || report.editorial_timeline_version_id !== plan.editorial_timeline_version_id
        || report.delivery_variant_version_id !== result.delivery_variant_version_id
        || report.execution_plan_id !== result.execution_plan_id
        || report.export_profile_revision_id !== plan.encoder.id
        || report.output_verification?.content_hash !== result.output_content_hash
        || outputVerification.content_hash !== result.output_content_hash
        || outputVerification.execution_plan_id !== result.execution_plan_id
        || outputVerification.delivery_variant_version_id !== result.delivery_variant_version_id
        || report.checks.some(check => check.state === 'blocked')
      ) {
        throw new VideoWorkbenchServiceError('后渲染质量报告或冻结交付版本已变化，不能恢复确认状态', 409, 'VIDEO_FINISHING_STALE')
      }
      const stored = latest.quality_reports.find(candidate => candidate.id === report.id)
      if (stored) {
        if (JSON.stringify(stored) !== JSON.stringify(report)) {
          throw new VideoWorkbenchServiceError('已保存的质量报告与渲染收据不一致，不能恢复确认状态', 409, 'VIDEO_FINISHING_STALE')
        }
        return latest
      }
      return await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...latest,
        state: 'rendering',
        task_id: operation.id,
        quality_reports: [...latest.quality_reports, report],
        error: undefined,
        error_code: undefined,
      }))
    })
  }

  private qualityWarningCheckIds(report: VideoQualityReport): string[] {
    const ids = report.checks
      .filter(check => check.state === 'needs_user_decision')
      .map(check => check.id)
      .sort()
    if (!ids.length) {
      throw new VideoWorkbenchServiceError('该后渲染质量报告没有可确认的告警项', 409, 'VIDEO_QUALITY_BLOCKED')
    }
    return ids
  }

  private assertExactQualityAcknowledgement(
    report: VideoQualityReport,
    acceptedCheckIds: string[],
  ): void {
    const expected = this.qualityWarningCheckIds(report)
    const accepted = [...acceptedCheckIds].sort()
    if (
      accepted.length !== expected.length
      || accepted.some((checkId, index) => checkId !== expected[index])
    ) {
      throw new VideoWorkbenchServiceError('必须精确确认本报告中全部且仅有的人工决策项', 409, 'VIDEO_QUALITY_BLOCKED')
    }
  }

  private assertQualityAcknowledgementBinding(
    pending: PendingPostRenderQuality,
    operation: VideoOperation,
    acknowledgement: VideoQualityAcknowledgement,
  ): void {
    if (
      acknowledgement.project_id !== operation.project_id
      || acknowledgement.render_operation_id !== operation.id
      || acknowledgement.report_id !== pending.report.id
      || acknowledgement.execution_plan_id !== pending.plan.id
      || acknowledgement.delivery_variant_version_id !== pending.result.delivery_variant_version_id
      || acknowledgement.output_content_hash !== pending.result.output_content_hash
    ) {
      throw new VideoWorkbenchServiceError('质量确认记录未绑定当前交付文件，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
    }
    this.assertExactQualityAcknowledgement(pending.report, acknowledgement.accepted_check_ids)
  }

  private async assertPendingQualityOutput(result: VideoRenderTaskResult): Promise<void> {
    if (!result.temporary_output || !result.output_content_hash || !result.output_verification) {
      throw new VideoWorkbenchServiceError('临时交付文件记录不完整，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
    }
    const info = await stat(result.temporary_output).catch(() => null)
    if (!info?.isFile() || info.size !== result.output_verification.byte_size) {
      throw new VideoWorkbenchServiceError('待确认的临时交付文件不可用，不能发布', 409, 'VIDEO_OUTPUT_UNAVAILABLE')
    }
    const hash = await videoFingerprint(result.temporary_output).catch(() => null)
    if (hash !== result.output_content_hash || hash !== result.output_verification.content_hash) {
      throw new VideoWorkbenchServiceError('待确认的临时交付文件校验失败，不能发布', 409, 'VIDEO_OUTPUT_UNAVAILABLE')
    }
    const sidecar = result.output_verification.sidecar_caption
    if (!sidecar) return
    if (!result.temporary_sidecar_path) {
      throw new VideoWorkbenchServiceError('待确认的字幕交付文件记录不完整，不能发布', 409, 'VIDEO_FINISHING_STALE')
    }
    const sidecarInfo = await stat(result.temporary_sidecar_path).catch(() => null)
    const sidecarHash = await videoFingerprint(result.temporary_sidecar_path).catch(() => null)
    if (!sidecarInfo?.isFile() || sidecarInfo.size !== sidecar.byte_size || sidecarHash !== sidecar.content_hash) {
      throw new VideoWorkbenchServiceError('待确认的字幕交付文件校验失败，不能发布', 409, 'VIDEO_OUTPUT_UNAVAILABLE')
    }
  }

  private async assertPublishedQualityOutput(result: VideoRenderTaskResult): Promise<void> {
    if (!result.output_path || !result.output_content_hash || !result.output_verification) {
      throw new VideoWorkbenchServiceError('交付文件记录不完整，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
    }
    const info = await stat(result.output_path).catch(() => null)
    const hash = await videoFingerprint(result.output_path).catch(() => null)
    if (
      !info?.isFile()
      || info.size !== result.output_verification.byte_size
      || hash !== result.output_content_hash
      || hash !== result.output_verification.content_hash
    ) {
      throw new VideoWorkbenchServiceError('交付文件校验失败，不能完成发布', 409, 'VIDEO_OUTPUT_UNAVAILABLE')
    }
    const sidecar = result.output_verification.sidecar_caption
    if (!sidecar) return
    if (!result.sidecar_caption_path) {
      throw new VideoWorkbenchServiceError('字幕交付文件记录不完整，不能完成发布', 409, 'VIDEO_FINISHING_STALE')
    }
    const sidecarInfo = await stat(result.sidecar_caption_path).catch(() => null)
    const sidecarHash = await videoFingerprint(result.sidecar_caption_path).catch(() => null)
    if (!sidecarInfo?.isFile() || sidecarInfo.size !== sidecar.byte_size || sidecarHash !== sidecar.content_hash) {
      throw new VideoWorkbenchServiceError('字幕交付文件校验失败，不能完成发布', 409, 'VIDEO_OUTPUT_UNAVAILABLE')
    }
  }

  private async publishQualityAcknowledgedRender(
    project: VideoStudioProject,
    operation: VideoOperation,
    pending: PendingPostRenderQuality,
    acknowledgement: VideoQualityAcknowledgement,
    allowAlreadyPublished: boolean,
  ): Promise<{ project: VideoStudioProject; task: VideoOperation }> {
    this.assertQualityAcknowledgementBinding(pending, operation, acknowledgement)
    const result = pending.result
    if (!result.output_path || !result.output_asset_id || !result.output_content_hash || !result.output_verification) {
      throw new VideoWorkbenchServiceError('质量确认的交付记录不完整，不能发布', 409, 'VIDEO_FINISHING_STALE')
    }
    const files = this.renderPublicationFiles(result)
    const existingOutput = await stat(result.output_path).catch(() => null)
    if (allowAlreadyPublished) {
      // A restart can be between the primary and sidecar links. Resume only
      // exact-hash destinations and retain no temporary bytes on success.
      try {
        await this.resumePublishedFiles(files)
      } catch (error) {
        await this.clearPublicationArtifacts(files, { removeDestinations: true, removeSources: true })
        throw error
      }
      await this.assertPublishedQualityOutput(result)
    } else {
      if (existingOutput) {
        throw new VideoWorkbenchServiceError('导出位置已有文件，确认不会覆盖它', 409, 'VIDEO_OUTPUT_EXISTS')
      }
      await this.assertPendingQualityOutput(result)
      if (result.sidecar_caption_path && await stat(result.sidecar_caption_path).then(() => true).catch(() => false)) {
        throw new VideoWorkbenchServiceError('字幕输出位置已有文件，确认不会覆盖它', 409, 'VIDEO_OUTPUT_EXISTS')
      }
      await this.publishFiles(files.map(file => {
        if (!file.source) {
          throw new VideoWorkbenchServiceError('临时交付文件记录不完整，不能继续发布', 409, 'VIDEO_FINISHING_STALE')
        }
        return { ...file, source: file.source }
      }))
      await this.assertPublishedQualityOutput(result)
    }
    const current = await this.requireVideoProject(project.id)
    if (current.task_id !== operation.id || current.revision !== result.render_revision) {
      throw new VideoWorkbenchServiceError('项目或交付变体已更新，确认结果不能发布', 409, 'VIDEO_RENDER_STALE')
    }
    const asset: MediaAsset = {
      id: result.output_asset_id,
      role: 'export',
      version_id: result.delivery_variant_version_id ?? operation.id,
      storage: { kind: 'external', locator: result.output_path },
      mime_type: this.deliveryOutputMime(pending.plan.encoder),
      byte_size: result.output_verification.byte_size,
      content_hash: result.output_content_hash,
      created_at: this.iso(),
    }
    const savedProject = await this.repository.saveProject(videoStudioProjectSchema.parse({
      ...current,
      assets: [...current.assets.filter(candidate => candidate.id !== asset.id && candidate.role !== 'export'), asset],
      state: 'complete',
      task_id: undefined,
      output_path: result.output_path,
      output_asset_id: result.output_asset_id,
      output_content_hash: result.output_content_hash,
      output_verification: result.output_verification,
      quality_reports: current.quality_reports.some(candidate => candidate.id === pending.report.id)
        ? current.quality_reports
        : [...current.quality_reports, pending.report],
      quality_acknowledgements: current.quality_acknowledgements.some(candidate => candidate.id === acknowledgement.id)
        ? current.quality_acknowledgements
        : [...current.quality_acknowledgements, acknowledgement],
      error: undefined,
      error_code: undefined,
    }))
    const task = await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'succeeded',
      progress: 100,
      stage: '质量告警已确认，交付导出完成',
      result: {
        ...result,
        awaiting_quality_confirmation: false,
        quality_acknowledgement: acknowledgement,
        temporary_output: undefined,
        temporary_sidecar_path: undefined,
      },
      error: undefined,
      error_code: undefined,
    }))
    if (result.temporary_output) await rm(result.temporary_output, { force: true }).catch(() => undefined)
    if (result.temporary_sidecar_path) await rm(result.temporary_sidecar_path, { force: true }).catch(() => undefined)
    return { project: savedProject, task }
  }

  /**
   * The Project and Operation payloads commit independently.  If a process
   * stops after the published Project commit but before the terminal Operation
   * event, the durable acknowledgement plus output hash is enough to finish
   * that same Operation without asking the user to approve again.
   */
  private async completeAlreadyPublishedQualityRender(
    project: VideoStudioProject,
    operation: VideoOperation,
    pending: PendingPostRenderQuality,
    acknowledgement: VideoQualityAcknowledgement,
  ): Promise<VideoOperation | null> {
    this.assertQualityAcknowledgementBinding(pending, operation, acknowledgement)
    const result = pending.result
    if (
      project.state !== 'complete'
      || project.output_path !== result.output_path
      || project.output_asset_id !== result.output_asset_id
      || project.output_content_hash !== result.output_content_hash
      || project.output_verification?.content_hash !== result.output_content_hash
      || !project.quality_acknowledgements.some(candidate => candidate.id === acknowledgement.id)
      || !project.assets.some(asset => asset.id === result.output_asset_id && asset.role === 'export' && asset.content_hash === result.output_content_hash)
    ) return null
    await this.assertPublishedQualityOutput(result)
    return await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'succeeded',
      progress: 100,
      stage: '质量告警已确认，交付导出完成',
      result: {
        ...result,
        awaiting_quality_confirmation: false,
        quality_acknowledgement: acknowledgement,
        temporary_output: undefined,
        temporary_sidecar_path: undefined,
      },
      error: undefined,
      error_code: undefined,
    }))
  }

  async confirmPostRenderQuality(
    projectId: string,
    operationId: string,
    raw: ConfirmVideoPostRenderQualityInput,
  ): Promise<{ project: VideoStudioProject; acknowledgement: VideoQualityAcknowledgement; task: VideoOperation; reused: boolean }> {
    return await this.mutateProject(projectId, async () => {
      const input = confirmVideoPostRenderQualityInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const operation = await this.repository.getOperation(operationId)
      if (operation.project_id !== project.id || operation.kind !== 'video.render') {
        throw new VideoWorkbenchServiceError('质量确认引用的导出任务不存在', 404, 'VIDEO_OPERATION_NOT_FOUND')
      }
      const pending = this.pendingPostRenderQuality(project, operation)
      if (input.report_id !== pending.report.id || input.output_content_hash !== pending.result.output_content_hash) {
        throw new VideoWorkbenchServiceError('质量确认未绑定当前后渲染报告或输出文件', 409, 'VIDEO_FINISHING_STALE')
      }
      this.assertExactQualityAcknowledgement(pending.report, input.accepted_check_ids)
      const persisted = pending.result.quality_acknowledgement
        ?? project.quality_acknowledgements.find(candidate => candidate.render_operation_id === operation.id
          && candidate.report_id === pending.report.id
          && candidate.output_content_hash === pending.result.output_content_hash)
      if (persisted) {
        this.assertQualityAcknowledgementBinding(pending, operation, persisted)
        if (operation.status === 'succeeded') {
          return { project, acknowledgement: persisted, task: operation, reused: true }
        }
        const alreadyPublished = await this.completeAlreadyPublishedQualityRender(project, operation, pending, persisted)
        if (alreadyPublished) {
          return { project, acknowledgement: persisted, task: alreadyPublished, reused: true }
        }
        if (operation.status !== 'committing') {
          throw new VideoWorkbenchServiceError('质量确认对应的导出任务不再可发布', 409, 'VIDEO_FINISHING_STALE')
        }
        const completed = await this.publishQualityAcknowledgedRender(project, operation, pending, persisted, true)
        return { ...completed, acknowledgement: persisted, reused: true }
      }
      if (operation.status !== 'committing' || !pending.result.awaiting_quality_confirmation) {
        throw new VideoWorkbenchServiceError('该导出任务当前不等待质量确认', 409, 'VIDEO_QUALITY_BLOCKED')
      }
      await this.assertPendingQualityOutput(pending.result)
      await this.assertSourcesUnchanged(project)
      const acknowledgement: VideoQualityAcknowledgement = {
        id: `quality_ack_${randomUUID().replaceAll('-', '')}`,
        project_id: project.id,
        render_operation_id: operation.id,
        report_id: pending.report.id,
        execution_plan_id: pending.plan.id,
        delivery_variant_version_id: pending.result.delivery_variant_version_id!,
        output_content_hash: pending.result.output_content_hash!,
        accepted_check_ids: [...input.accepted_check_ids].sort(),
        acknowledged_at: this.iso(),
      }
      const confirming = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'committing',
        progress: 95,
        stage: '正在根据质量确认发布交付文件',
        result: {
          ...pending.result,
          awaiting_quality_confirmation: false,
          quality_acknowledgement: acknowledgement,
        },
      }))
      const confirmed = this.pendingPostRenderQuality(project, confirming)
      const completed = await this.publishQualityAcknowledgedRender(project, confirming, confirmed, acknowledgement, false)
      return { ...completed, acknowledgement, reused: false }
    })
  }

  async cancelOperation(operationId: string): Promise<VideoOperation> {
    const operation = await this.repository.getOperation(operationId)
    if (!['queued', 'running', 'committing'].includes(operation.status)) {
      throw new VideoWorkbenchServiceError('当前视频操作不能取消', 409, 'VIDEO_OPERATION_NOT_CANCELLABLE')
    }
    const active = operation.kind === 'video.preview'
      ? this.activePreviews.get(operation.id)
      : operation.kind === 'video.render'
        ? this.activeRenders.get(operation.id)
        : operation.kind === 'video.analyze' || operation.kind === 'video.plan' || operation.kind === 'video.beat_analyze'
          ? this.activeAnalyses.get(operation.id)
          : undefined
    if (!active) throw new VideoWorkbenchServiceError('当前视频操作不能安全取消', 409, 'VIDEO_OPERATION_NOT_CANCELLABLE')
    active.controller.abort(new Error('video operation cancelled'))

    // A render that has not reached the serialized encoder has no child
    // process to wait for. Persist its cancellation now so a user is never
    // held behind unrelated long-running exports. Its queued completion will
    // later reach the queue head and exit without starting FFmpeg.
    if (operation.kind === 'video.render' && !active.started) {
      active.cancelledBeforeStart = true
      const project = await this.project(operation.project_id).catch(() => null)
      if (project?.task_id === operation.id) {
        const failure = mediaSafeError('MEDIA_VIDEO_EXPORT_CANCELLED')
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          state: 'ready',
          task_id: undefined,
          error: failure.message,
          error_code: failure.code,
        }))
      }
      const cancelled = await this.failOperation(operation, 'MEDIA_VIDEO_EXPORT_CANCELLED', '已取消')
      this.activeRenders.delete(operation.id)
      return cancelled
    }

    await active.completion
    return await this.repository.getOperation(operation.id)
  }

  async recoverInterruptedOperations(): Promise<void> {
    // Relay result bytes are already represented by immutable Facts or a
    // committed Project projection. Recovery starts by retrying that cleanup
    // protocol only; it never replays a paid provider request for an ACK.
    // Startup recovery must not fan out unbounded Relay ACK/introspection work
    // across every local project before the Sidecar is ready. Sequential work
    // keeps it below the same installation-level network/capacity envelope.
    for (const project of await this.repository.listProjects()) {
      await this.rebuildRelayAcknowledgementsFromFacts(project.id)
      await this.flushPendingRelayAcknowledgements(project.id)
    }
    const orchestrator = new JobOrchestrator(
      async () => (await this.repository.listOperations())
        .filter(operation => ['queued', 'running', 'committing'].includes(operation.status)),
      async operation => await this.recoverInterruptedOperation(operation),
    )
    await orchestrator.recover()
  }

  private async recoverInterruptedOperation(operation: VideoOperation): Promise<void> {
    if (operation.kind === 'video.index' && operation.status === 'committing' && this.stagedSemanticQueryResult(operation)) {
      await this.finalizeStagedSemanticQueryResult(operation)
      return
    }
    if (operation.kind === 'video.index' && operation.status === 'running') {
      const query = typeof operation.result?.query === 'string' ? operation.result.query : null
      const cursor = typeof operation.result?.cursor === 'string' ? operation.result.cursor : undefined
      if (query) {
        try {
          await this.searchMediaFacts(operation.project_id, query, { ...(cursor ? { cursor } : {}) })
        } catch {
          const current = await this.repository.getOperation(operation.id).catch(() => null)
          // Keep the deterministic query task enumerable while its exact Relay
          // fence survives. A later startup or the same user query resumes it.
          if (current && this.remoteRecoveryCheckpoint(current)) return
          await this.failOperation(operation, 'MEDIA_VIDEO_ANALYSIS_INTERRUPTED', '语义查询恢复失败')
        }
        return
      }
    }
    if (operation.kind === 'video.plan' && operation.status === 'committing' && this.stagedRemotePlanningResult(operation)) {
      await this.finalizeStagedRemotePlanningResult(operation)
      return
    }
    if (operation.kind === 'video.plan' && operation.status === 'running' && this.remoteRecoveryCheckpoint(operation)) {
      try {
        await this.recoverRemotePlanningOperation(operation)
      } catch {
        const current = await this.repository.getOperation(operation.id).catch(() => null)
        // A surviving journal is the durable retry authority. Keep this task
        // enumerable for the next bounded startup pass; never fall through to
        // the generic interrupted-task failure that would permit a new id.
        if (current && this.remoteRecoveryCheckpoint(current)) return
        await this.failOperation(operation, 'MEDIA_VIDEO_ANALYSIS_INTERRUPTED', '远程规划恢复失败')
      }
      return
    }
    if (operation.kind === 'video.caption_translation' && (this.stagedCaptionTranslationResult(operation) || this.remoteRecoveryCheckpoint(operation))) {
      try {
        await this.recoverCaptionTranslationOperation(operation)
      } catch {
        const current = await this.repository.getOperation(operation.id).catch(() => null)
        // Keep only a surviving submission fence retryable. A durable staged
        // candidate that no longer matches its caption/timeline basis fails
        // closed instead of attaching to a later document head.
        if (current && this.remoteRecoveryCheckpoint(current)) return
        await this.failOperation(current ?? operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '远程字幕翻译恢复失败')
      }
      return
    }
    if (operation.kind === 'video.fingerprint') {
      const sourceId = typeof operation.result?.source_id === 'string' ? operation.result.source_id : null
      if (!sourceId) {
        await this.failOperation(operation, 'MEDIA_VIDEO_PROBE_INTERRUPTED', '完整指纹任务缺少素材标识')
        return
      }
      await this.runFullFingerprint(operation, sourceId)
      return
    }
    if (operation.kind === 'video.analyze') {
      const userGoal = typeof operation.result?.user_goal === 'string' ? operation.result.user_goal : null
      const project = await this.project(operation.project_id).catch(() => null)
      if (userGoal && project?.task_id === operation.id && this.videoMediaRelay()) {
        const controller = new AbortController()
        const active: ActiveVideoExecution = { controller, completion: Promise.resolve(), output_path: '' }
        active.completion = this.runVideoAnalysis(project, operation, userGoal, controller.signal)
        this.activeAnalyses.set(operation.id, active)
        await active.completion
        return
      }
    }
    if (operation.kind === 'video.beat_analyze') {
      const sourceId = typeof operation.result?.source_id === 'string' ? operation.result.source_id : null
      const audioStreamIndex = typeof operation.result?.audio_stream_index === 'number' ? operation.result.audio_stream_index : null
      const project = await this.project(operation.project_id).catch(() => null)
      const source = sourceId ? await this.repository.getFact('source', sourceId).catch(() => null) : null
      if (project && source && 'fast_identity' in source && source.fingerprint && Number.isSafeInteger(audioStreamIndex)) {
        const controller = new AbortController()
        const active: ActiveVideoExecution = { controller, completion: Promise.resolve(), output_path: '' }
        active.completion = this.runBeatAnalysis(project, operation, source as VideoFactSource & { fingerprint: `sha256:${string}` }, audioStreamIndex!, controller.signal)
        this.activeAnalyses.set(operation.id, active)
        await active.completion
        return
      }
    }
    if (operation.kind === 'video.caption_draft' || operation.kind === 'video.caption_translation' || operation.kind === 'video.composition_plan' || operation.kind === 'video.audio_finish_plan' || operation.kind === 'video.quality_preflight' || operation.kind === 'video.subject_track' || operation.kind === 'video.beat_sync_draft') {
      const requestHash = typeof operation.result?.request_hash === 'string' ? operation.result.request_hash : null
      const project = await this.project(operation.project_id).catch(() => null)
      const receipt = project && requestHash
        ? project.finishing_receipts.find(candidate => candidate.idempotency_key === operation.idempotency_key && candidate.request_hash === requestHash)
        : undefined
      if (project && receipt) {
        const captionRevision = operation.kind === 'video.caption_translation'
          ? project.caption_document_revisions.find(candidate => candidate.id === receipt.resource_ids[0])
          : undefined
        const captionDocument = captionRevision
          ? project.caption_documents.find(candidate => candidate.id === captionRevision.document_id)
          : undefined
        const captionParent = captionRevision?.parent_revision_id
          ? project.caption_document_revisions.find(candidate => candidate.id === captionRevision.parent_revision_id)
          : undefined
        if (operation.kind === 'video.caption_translation' && (
          !captionRevision
          || !captionDocument
          || !captionParent
          || captionDocument.project_id !== project.id
          || captionRevision.project_id !== project.id
          || captionParent.project_id !== project.id
          || captionParent.document_id !== captionDocument.id
        )) {
          await this.failOperation(operation, 'MEDIA_VIDEO_FINISHING_UNAVAILABLE', '字幕翻译回执缺少可验证的候选版本')
          return
        }
        const completion = operation.kind === 'video.caption_draft' || operation.kind === 'video.caption_translation'
          ? {
              caption_document_id: operation.kind === 'video.caption_translation'
                ? captionRevision?.document_id
                : receipt.resource_ids.length > 1 ? receipt.resource_ids[0] : undefined,
              caption_revision_id: operation.kind === 'video.caption_translation'
                ? captionRevision?.id
                : receipt.resource_ids.at(-1),
              ...(operation.kind === 'video.caption_translation' && captionRevision
                ? { caption_style_id: captionRevision.style_id }
                : {}),
            }
          : operation.kind === 'video.composition_plan'
            ? { composition_plan_id: receipt.resource_ids[0] }
            : operation.kind === 'video.audio_finish_plan'
              ? { audio_finishing_plan_id: receipt.resource_ids[0] }
              : operation.kind === 'video.subject_track'
                ? { evidence_id: receipt.resource_ids[0] }
                : operation.kind === 'video.beat_sync_draft'
                  ? { timeline_draft_id: receipt.resource_ids[0] }
                  : { execution_plan_id: receipt.resource_ids[0], report_id: receipt.resource_ids[1] }
        await this.completeFinishingOperation(operation, '完成层结果已在重启后对账恢复', completion)
        return
      }
    }
    if (operation.kind === 'video.preview' && await this.recoverCommittedPreview(operation)) return
    if (operation.kind === 'video.render' && await this.recoverCommittedRender(operation)) return
    const code = operation.kind === 'video.preview'
      ? 'MEDIA_VIDEO_PREVIEW_INTERRUPTED'
      : operation.kind === 'video.render'
        ? 'MEDIA_VIDEO_EXPORT_INTERRUPTED'
        : operation.kind === 'video.caption_draft' || operation.kind === 'video.caption_translation' || operation.kind === 'video.composition_plan' || operation.kind === 'video.audio_finish_plan' || operation.kind === 'video.quality_preflight' || operation.kind === 'video.subject_track' || operation.kind === 'video.beat_sync_draft'
          ? 'MEDIA_VIDEO_FINISHING_UNAVAILABLE'
        : operation.kind === 'video.analyze' || operation.kind === 'video.plan' || operation.kind === 'video.beat_analyze'
          ? 'MEDIA_VIDEO_ANALYSIS_INTERRUPTED'
          : 'MEDIA_VIDEO_PROBE_INTERRUPTED'
    const stage = operation.kind === 'video.preview'
      ? '预览已中断'
      : operation.kind === 'video.render'
        ? '导出已中断'
        : operation.kind === 'video.caption_draft' || operation.kind === 'video.caption_translation' || operation.kind === 'video.composition_plan' || operation.kind === 'video.audio_finish_plan' || operation.kind === 'video.quality_preflight' || operation.kind === 'video.subject_track' || operation.kind === 'video.beat_sync_draft'
          ? '完成层任务已中断'
        : operation.kind === 'video.analyze' || operation.kind === 'video.plan' || operation.kind === 'video.beat_analyze'
          ? '分析已中断'
          : '素材读取已中断'
    const previewResult = operation.kind === 'video.preview'
      ? videoPreviewTaskResultSchema.safeParse(operation.result)
      : undefined
    const renderResult = operation.kind === 'video.render'
      ? videoRenderTaskResultSchema.safeParse(operation.result)
      : undefined
    const temporary = operation.kind === 'video.preview'
      ? previewResult?.data?.temporary_output
      : operation.kind === 'video.render'
        ? renderResult?.data?.temporary_output
        : undefined
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
    const temporarySidecar = operation.kind === 'video.preview'
      ? previewResult?.data?.temporary_sidecar_path
      : operation.kind === 'video.render'
        ? renderResult?.data?.temporary_sidecar_path
      : undefined
    if (temporarySidecar) await rm(temporarySidecar, { force: true }).catch(() => undefined)
    const project = await this.project(operation.project_id).catch(() => null)
    if (operation.kind === 'video.render' && project?.task_id === operation.id) {
      const failure = mediaSafeError(code)
      await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, state: 'ready', task_id: undefined, error: failure.message, error_code: failure.code }))
    }
    if (operation.kind === 'video.preview' && project?.preview_task_id === operation.id) {
      await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, preview_task_id: undefined }))
    }
    await this.failOperation(operation, code, stage)
  }

  /**
   * A crash can happen after the atomic file publication but before the task
   * terminal event is written. The persisted verification proof lets us
   * distinguish that case from a genuinely interrupted encoder without
   * rerunning FFmpeg or trusting a file merely because it exists.
   */
  private async recoverCommittedRender(operation: VideoOperation): Promise<boolean> {
    if (operation.status !== 'committing') return false
    const result = videoRenderTaskResultSchema.safeParse(operation.result)
    if (!result.success || !result.data.output_path || !result.data.output_content_hash || !result.data.output_verification || !result.data.output_asset_id) {
      return false
    }
    const outputVerification = result.data.output_verification
    const project = await this.project(operation.project_id).catch(() => null)
    if (!project) return false
    const projectOwnsOutput = project.output_path === result.data.output_path
      && project.output_asset_id === result.data.output_asset_id
      && project.output_content_hash === result.data.output_content_hash
      && project.assets.some(asset => asset.id === result.data.output_asset_id
        && asset.role === 'export'
        && asset.content_hash === result.data.output_content_hash)
    if (project.task_id !== operation.id) {
      if (result.data.quality_acknowledgement && result.data.post_render_report?.state === 'needs_user_decision') {
        try {
          const pending = this.pendingPostRenderQuality(project, operation)
          return Boolean(await this.completeAlreadyPublishedQualityRender(
            project,
            operation,
            pending,
            result.data.quality_acknowledgement,
          ))
        } catch {
          return false
        }
      }
      if (!projectOwnsOutput) return false
    }
    if (result.data.awaiting_quality_confirmation) {
      try {
        const recoveredProject = await this.persistPendingPostRenderQualityReport(project.id, operation)
        const pending = this.pendingPostRenderQuality(recoveredProject, operation)
        await this.assertPendingQualityOutput(pending.result)
        // This is an intentional, durable user-decision state.  Recovery must
        // keep the verified temporary output instead of treating it as an
        // interrupted encoder and silently discarding it.
        return true
      } catch {
        return false
      }
    }
    if (result.data.quality_acknowledgement && result.data.post_render_report?.state === 'needs_user_decision') {
      try {
        const pending = this.pendingPostRenderQuality(project, operation)
        await this.publishQualityAcknowledgedRender(
          project,
          operation,
          pending,
          result.data.quality_acknowledgement,
          true,
        )
        return true
      } catch {
        return false
      }
    }
    const publicationFiles = [{
      source: result.data.temporary_output,
      destination: result.data.output_path,
      content_hash: result.data.output_content_hash,
    }, ...(outputVerification.sidecar_caption && result.data.sidecar_caption_path
      ? [{
          source: result.data.temporary_sidecar_path,
          destination: result.data.sidecar_caption_path,
          content_hash: outputVerification.sidecar_caption.content_hash,
        }]
      : [])]
    const cleanupIncompletePublication = async (): Promise<void> => {
      await this.clearPublicationArtifacts(publicationFiles, { removeDestinations: true, removeSources: true })
      // A prior Project commit is an additional ownership receipt. This keeps
      // the existing "lost verification receipt" recovery fail-closed while
      // still refusing to delete an arbitrary same-named user destination.
      if (projectOwnsOutput && await videoFingerprint(result.data.output_path).catch(() => null) === result.data.output_content_hash) {
        await rm(result.data.output_path, { force: true }).catch(() => undefined)
      }
      if (outputVerification.sidecar_caption && !result.data.sidecar_caption_path && result.data.temporary_sidecar_path) {
        await rm(result.data.temporary_sidecar_path, { force: true }).catch(() => undefined)
      }
    }
    const formalVersionId = result.data.delivery_variant_version_id
    let formalPlan: VideoExecutionPlan | undefined
    let formalReport: VideoQualityReport | undefined
    if (formalVersionId) {
      if (!result.data.execution_plan_id || !result.data.post_render_report || result.data.post_render_report.state !== 'passed') {
        await cleanupIncompletePublication()
        return false
      }
      formalPlan = project.execution_plans.find(candidate => candidate.id === result.data.execution_plan_id)
      const variant = project.delivery_variant_versions.find(candidate => candidate.id === formalVersionId)
      const variantHead = variant && project.delivery_variants.find(candidate => candidate.id === variant.variant_id)
      if (!formalPlan
        || formalPlan.delivery_variant_version_id !== formalVersionId
        || formalPlan.editorial_timeline_version_id !== result.data.output_verification.timeline_version_id
        // Once the Project owns the verified output, a later user edit may
        // legitimately move the Variant head before the terminal Operation
        // event is written. That new head must not invalidate the already
        // committed bytes; before Project ownership is recorded it remains a
        // stale publish and must fail closed.
        || (!projectOwnsOutput && variantHead?.current_version_id !== formalVersionId)
        || result.data.post_render_report.delivery_variant_version_id !== formalVersionId
        || result.data.post_render_report.execution_plan_id !== formalPlan.id) {
        await cleanupIncompletePublication()
        return false
      }
      const operations = await this.repository.listOperations(project.id)
      const outputVerify = operations.find(candidate => candidate.kind === 'video.output_verify'
        && candidate.status === 'succeeded'
        && candidate.result?.parent_operation_id === operation.id
        && candidate.result?.execution_plan_id === formalPlan!.id)
      const outputReceipt = outputVerify?.result?.output_verification
      const receipt = outputReceipt && typeof outputReceipt === 'object'
        ? outputReceipt as Record<string, unknown>
        : undefined
      const receiptHasFullEvidence = receipt
        && receipt.content_hash === outputVerification.content_hash
        && receipt.decoded === true
        && receipt.packet_timestamps_monotonic === true
        && receipt.video_stream_count === 1
        && receipt.audio_stream_count === 1
        && typeof receipt.expected_duration_ms === 'number' && receipt.expected_duration_ms > 0
        && typeof receipt.duration_delta_ms === 'number' && receipt.duration_delta_ms >= 0
        && typeof receipt.audio_video_duration_delta_ms === 'number' && receipt.audio_video_duration_delta_ms >= 0
        && typeof receipt.black_duration_ms === 'number' && receipt.black_duration_ms >= 0
        && typeof receipt.black_ratio === 'number' && receipt.black_ratio >= 0 && receipt.black_ratio <= 1
        && typeof receipt.silence_duration_ms === 'number' && receipt.silence_duration_ms >= 0
        && typeof receipt.silence_ratio === 'number' && receipt.silence_ratio >= 0 && receipt.silence_ratio <= 1
      const requiredQualityChecks = new Set([
        'output_verification_receipt',
        'output_stream_layout',
        'decode_scan',
        'packet_timestamps',
        'duration_tolerance',
        'av_duration_tolerance',
        'profile_integrity',
        'black_frame_scan',
        'silence_scan',
      ])
      const qualityPostRender = operations.find(candidate => candidate.kind === 'video.quality_post_render'
        && candidate.status === 'succeeded'
        && candidate.result?.parent_operation_id === operation.id
        && candidate.result?.execution_plan_id === formalPlan!.id
        && candidate.result?.report_id === result.data.post_render_report!.id)
      const qualityReceipt = qualityPostRender?.result?.report
      const qualityReceiptRecord = qualityReceipt && typeof qualityReceipt === 'object'
        ? qualityReceipt as Record<string, unknown>
        : undefined
      const qualityChecks = Array.isArray(qualityReceiptRecord?.checks)
        ? qualityReceiptRecord.checks as unknown[]
        : []
      const completedQualityChecks = new Set(qualityChecks.flatMap(check => {
        if (!check || typeof check !== 'object') return []
        const entry = check as Record<string, unknown>
        return entry.state === 'passed' && requiredQualityChecks.has(String(entry.code)) ? [String(entry.code)] : []
      }))
      const reportHasFullEvidence = qualityReceiptRecord
        && qualityReceiptRecord.id === result.data.post_render_report.id
        && qualityReceiptRecord.state === 'passed'
        && completedQualityChecks.size === requiredQualityChecks.size
        && result.data.post_render_report.output_verification?.content_hash === outputVerification.content_hash
      if (!receiptHasFullEvidence || !reportHasFullEvidence) {
        await cleanupIncompletePublication()
        return false
      }
      formalReport = result.data.post_render_report
    }
    if (outputVerification.sidecar_caption && !result.data.sidecar_caption_path) {
      await cleanupIncompletePublication()
      return false
    }
    try {
      await this.resumePublishedFiles(publicationFiles)
    } catch {
      await cleanupIncompletePublication()
      return false
    }
    const info = await stat(result.data.output_path).catch(() => null)
    if (!info?.isFile() || info.size <= 0) {
      await cleanupIncompletePublication()
      return false
    }
    const hash = await videoFingerprint(result.data.output_path).catch(() => null)
    if (hash !== result.data.output_content_hash || hash !== result.data.output_verification.content_hash) {
      await cleanupIncompletePublication()
      return false
    }
    if (outputVerification.sidecar_caption) {
      if (!result.data.sidecar_caption_path) {
        await cleanupIncompletePublication()
        return false
      }
      const sidecarHash = await videoFingerprint(result.data.sidecar_caption_path).catch(() => null)
      if (sidecarHash !== outputVerification.sidecar_caption.content_hash) {
        await cleanupIncompletePublication()
        return false
      }
    }
    const recoveredAsset: MediaAsset = {
      id: result.data.output_asset_id,
      role: 'export',
      version_id: formalVersionId ?? result.data.timeline_version_id ?? operation.id,
      storage: { kind: 'external', locator: result.data.output_path },
      ...(formalPlan ? { mime_type: this.deliveryOutputMime(formalPlan.encoder) } : {}),
      byte_size: result.data.output_verification.byte_size,
      content_hash: result.data.output_content_hash,
      created_at: this.iso(),
    }
    const terminalProject = await this.repository.saveProject(videoStudioProjectSchema.parse({
      ...project,
      assets: [...project.assets.filter(asset => asset.id !== recoveredAsset.id && asset.role !== 'export'), recoveredAsset],
      state: 'complete',
      task_id: undefined,
      output_path: result.data.output_path,
      output_asset_id: result.data.output_asset_id,
      output_content_hash: result.data.output_content_hash,
      output_verification: result.data.output_verification,
      ...(formalReport && !project.quality_reports.some(report => report.id === formalReport!.id)
        ? { quality_reports: [...project.quality_reports, formalReport] }
        : {}),
      error: undefined,
      error_code: undefined,
    }))
    await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'succeeded',
      progress: 100,
      stage: '导出完成',
      result: { ...result.data, temporary_output: undefined, temporary_sidecar_path: undefined },
      error: undefined,
      error_code: undefined,
    }))
    return terminalProject.state === 'complete'
  }

  /**
   * A formal preview publishes its managed bytes before projecting the
   * Project and before writing the terminal Operation event.  Reconcile both
   * crash windows from the immutable preview receipt, including ProRes/MOV
   * previews and an optional sidecar caption.
   */
  private async recoverCommittedPreview(operation: VideoOperation): Promise<boolean> {
    if (operation.status !== 'committing') return false
    const parsed = videoPreviewTaskResultSchema.safeParse(operation.result)
    if (!parsed.success || !parsed.data.content_hash) return false
    const result = parsed.data
    const contentHash = result.content_hash
    if (!contentHash) return false
    const project = await this.project(operation.project_id).catch(() => null)
    if (!project) return false

    const plan = result.execution_plan_id
      ? project.execution_plans.find(candidate => candidate.id === result.execution_plan_id)
      : undefined
    if (result.execution_plan_id && !plan) return false
    if (plan && (
      plan.editorial_timeline_version_id !== result.timeline_version_id
      || (result.delivery_variant_version_id && plan.delivery_variant_version_id !== result.delivery_variant_version_id)
    )) return false

    const existingAsset = project.assets.find(candidate => candidate.id === result.asset_id && candidate.role === 'preview')
    const existingLocator = existingAsset?.storage.kind === 'managed' ? existingAsset.storage.locator : undefined
    const extension = existingLocator
      ? extname(existingLocator).toLowerCase()
      : result.temporary_output
        ? extname(result.temporary_output).toLowerCase()
        : plan
          ? this.deliveryOutputExtension(plan.encoder)
          : '.mp4'
    if (extension !== '.mp4' && extension !== '.mov') return false
    const assetsRoot = resolve(this.repository.paths().assets)
    const outputPath = resolve(assetsRoot, project.id, `${result.asset_id}${extension}`)
    if (!this.isWithinManagedRoot(assetsRoot, outputPath)) return false

    const sidecar = result.sidecar_caption
    const expectedSidecarAssetPath = `/api/videos/projects/${project.id}/previews/${result.asset_id}/sidecar`
    if (sidecar && sidecar.asset_path !== expectedSidecarAssetPath) return false
    const sidecarPath = sidecar
      ? join(assetsRoot, project.id, `${result.asset_id}.${sidecar.format}`)
      : undefined
    const publicationFiles = [
      { source: result.temporary_output, destination: outputPath, content_hash: contentHash },
      ...(sidecar && sidecarPath
        ? [{ source: result.temporary_sidecar_path, destination: sidecarPath, content_hash: sidecar.content_hash }]
        : []),
    ]
    const projectOwnsPreview = project.preview?.asset_id === result.asset_id
      && project.preview.asset_path === result.asset_path
      && project.preview.content_hash === contentHash
      && Boolean(existingAsset && existingAsset.content_hash === contentHash)
    if (!projectOwnsPreview) {
      if (project.preview_task_id !== operation.id) return false
      if (project.revision !== result.preview_revision) return false
      if (project.current_editorial_timeline_version_id !== result.timeline_version_id
        && project.current_timeline_version_id !== result.timeline_version_id) return false
      if (result.delivery_variant_version_id) {
        const version = project.delivery_variant_versions.find(candidate => candidate.id === result.delivery_variant_version_id)
        const variant = version && project.delivery_variants.find(candidate => candidate.id === version.variant_id)
        if (!version || !variant || variant.current_version_id !== version.id) return false
      }
    }

    try {
      await this.resumePublishedFiles(publicationFiles)
    } catch {
      await this.clearPublicationArtifacts(publicationFiles, { removeDestinations: true, removeSources: true })
      return false
    }

    if (!projectOwnsPreview) {
      const asset: MediaAsset = {
        id: result.asset_id,
        role: 'preview',
        version_id: result.delivery_variant_version_id ?? result.timeline_version_id,
        storage: { kind: 'managed', locator: join(project.id, basename(outputPath)) },
        mime_type: plan ? this.deliveryOutputMime(plan.encoder) : extension === '.mov' ? 'video/quicktime' : 'video/mp4',
        byte_size: (await stat(outputPath)).size,
        content_hash: contentHash,
        created_at: this.iso(),
      }
      await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        assets: [...project.assets.filter(candidate => candidate.role !== 'preview'), asset],
        preview_task_id: undefined,
        preview: {
          timeline_version_id: result.timeline_version_id,
          ...(result.delivery_variant_version_id ? { delivery_variant_version_id: result.delivery_variant_version_id } : {}),
          ...(result.execution_plan_id ? { execution_plan_id: result.execution_plan_id } : {}),
          asset_id: result.asset_id,
          asset_path: result.asset_path,
          content_hash: contentHash,
          ...(sidecar ? { sidecar_caption: sidecar } : {}),
          created_at: this.iso(),
        },
      }))
    } else if (project.preview_task_id === operation.id) {
      await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, preview_task_id: undefined }))
    }
    await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'succeeded',
      progress: 100,
      stage: '交付预览已就绪（已恢复）',
      result: { ...result, temporary_output: undefined, temporary_sidecar_path: undefined },
      error: undefined,
      error_code: undefined,
    }))
    return true
  }
}
