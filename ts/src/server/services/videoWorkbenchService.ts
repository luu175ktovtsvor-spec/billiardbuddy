import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  addVideoSourceInputSchema,
  acceptTimelineDraftInputSchema,
  applyDeliveryVariantCommandsInputSchema,
  applyEditorialTimelineCommandsInputSchema,
  analyzeVideoProjectInputSchema,
  applyVideoAlternativeInputSchema,
  createDeliveryVariantInputSchema,
  createVideoProjectInputSchema,
  lockVideoSceneInputSchema,
  mediaTaskSchema,
  mediaSafeError,
  previewVideoInputSchema,
  renderVideoInputSchema,
  selectVideoTimelineVersionInputSchema,
  updateVideoTimelineInputSchema,
  videoPreviewTaskResultSchema,
  videoRenderTaskResultSchema,
  videoStudioProjectSchema,
  type AddVideoSourceInput,
  type AcceptTimelineDraftInput,
  type ApplyDeliveryVariantCommandsInput,
  type ApplyEditorialTimelineCommandsInput,
  type AnalyzeVideoProjectInput,
  type ApplyVideoAlternativeInput,
  type CreateVideoProjectInput,
  type CreateDeliveryVariantInput,
  type DeliveryVariant,
  type DeliveryVariantVersion,
  type EditorialTimelineCommand,
  type EditorialTimelineVersion,
  type LockVideoSceneInput,
  type MediaAsset,
  type MediaOwner,
  type PreviewVideoInput,
  type RenderVideoInput,
  type SelectVideoTimelineVersionInput,
  type UpdateVideoTimelineInput,
  type VideoClip,
  type VideoEvidence,
  type VideoScene,
  type VideoSource,
  type VideoStudioProject,
  type VideoTimelineItem,
  type VideoTimelineVersion,
  createRemoteAnalysisConsentInputSchema,
  estimateRemoteAnalysisInputSchema,
  revokeRemoteAnalysisConsentInputSchema,
  type CreateRemoteAnalysisConsentInput,
  type EstimateRemoteAnalysisInput,
  timelineCommandSetSchema,
} from '../../../shared/contracts/media.js'
import {
  defaultVideoProcessRunner,
  buildExecutionPlanRenderCommand,
  buildVideoRenderCommand,
  FALLBACK_VIDEO_ENCODER,
  fastVideoIdentity,
  probeVideoFactSource,
  selectVideoEncoder,
  videoBinary,
  videoFingerprint,
  videoToolchainStatus,
  verifyVideoOutput,
  type VideoProcessRunner,
} from './videoExecution.js'
import {
  createHostedEvidence,
  factBasisHash,
  type CameraShot,
  type EvidenceWindow,
  type TimedTranscript,
  type VideoDerivative,
  type VideoFactEvidence,
  type VideoFactKind,
  type VideoFactSource,
} from '../video/domain/mediaFacts/model.js'
import { DEFAULT_EVIDENCE_WINDOW_BUDGET, contentSegmentsFromCameraShots, fixedIntervalContentSegments, planEvidenceWindows } from '../video/domain/mediaFacts/analysis.js'
import {
  compareRationalTime,
  endOfRange,
  parseInt64,
  rationalTime,
  rescaleRationalTime,
  sourceTimeRange,
  tickRateForTimeBase,
  timeToMilliseconds,
  type SourceTimeRange,
} from '../video/domain/mediaFacts/time.js'
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
  type VideoOperation,
} from './videoWorkbenchRepository.js'
import { JobOrchestrator } from '../media/kernel/operations/jobOrchestrator.js'
import {
  EditorialApplication,
  EditorialValidationError,
  editorialFactsBasisHash,
  type EditorialSourceBounds,
  type EditorialSourceTiming,
} from '../video/domain/editorial/editorialApplication.js'
import { normalizeFunAsrSentences, selectFunAsrRoute, type RemoteAsrSentence } from '../video/infrastructure/providers/funAsrAdapter.js'
import { VideoMediaRelayClient, VideoMediaRelayClientError, videoMediaRelayTransportPolicyFromEnvironment } from '../video/infrastructure/providers/videoMediaRelayClient.js'

const STANDALONE_VIDEO_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`

type ActiveVideoExecution = {
  controller: AbortController
  completion: Promise<void>
  output_path: string
  /** A queued render can be cancelled before it reaches the serialized encoder. */
  started?: boolean
  cancelledBeforeStart?: boolean
}

type ExtractedVideoAnalysisInputs = {
  frames: VideoAnalysisFrame[]
  transcripts: VideoEvidence[]
  relay_acknowledgements: PendingRelayAcknowledgement[]
  gaps: string[]
  source_facts: Map<string, VideoFactSource>
  evidence_windows: Map<string, EvidenceWindow>
}

type PendingRelayAcknowledgement = VideoStudioProject['pending_relay_acknowledgements'][number]

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
type RelayOperationRequest = Parameters<VideoMediaRelayClient['createOperation']>[0]
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

function id(prefix: 'vid' | 'src' | 'clip' | 'task' | 'timeline' | 'draft' | 'evidence' | 'alternative' | 'consent' | 'budget'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
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
 * The video domain owns projects, source evidence, timeline versions and local
 * operation records. FFprobe/FFmpeg are replaceable executors: they receive a
 * durable snapshot but never decide whether a project has completed.
 */
export class VideoWorkbenchService {
  readonly repository: VideoWorkbenchRepository
  private readonly now: () => Date
  private readonly runProcess: VideoProcessRunner
  private readonly fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly env: Record<string, string | undefined>
  private readonly platform: NodeJS.Platform
  private readonly legacyMediaRoot: string
  private readonly editorial: EditorialApplication
  private readonly projectMutations = new Map<string, Promise<unknown>>()
  private readonly activePreviews = new Map<string, ActiveVideoExecution>()
  private readonly activeRenders = new Map<string, ActiveVideoExecution>()
  private readonly activeAnalyses = new Map<string, ActiveVideoExecution>()
  private readonly activeFingerprints = new Map<string, Promise<void>>()
  /**
   * Encoding is intentionally serialized in this desktop runtime. Rendering
   * several timelines at once makes the machine unusable and, more
   * importantly, makes cancellation/recovery order ambiguous. The persisted
   * operation remains queued while it waits on this in-memory tail.
   */
  private renderTail: Promise<void> = Promise.resolve()

  constructor(options: {
    root?: string
    now?: () => Date
    runProcess?: VideoProcessRunner
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    env?: Record<string, string | undefined>
    platform?: NodeJS.Platform
    legacyMediaRoot?: string
  } = {}) {
    this.now = options.now ?? (() => new Date())
    this.editorial = new EditorialApplication(this.now)
    this.repository = new VideoWorkbenchRepository({ root: options.root, now: this.now })
    this.runProcess = options.runProcess ?? defaultVideoProcessRunner
    this.fetchImpl = options.fetchImpl
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.legacyMediaRoot = options.legacyMediaRoot
      ?? join(this.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'media')
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
      ...videoMediaRelayTransportPolicyFromEnvironment(this.env),
    }) : null
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
      return Boolean(
        (staged && same(staged.acknowledgement.receipt_id, staged.acknowledgement.relay_operation_id, staged.acknowledgement.result_hashes))
        || (semantic && same(semantic.acknowledgement.receipt_id, semantic.acknowledgement.relay_operation_id, semantic.acknowledgement.result_hashes)),
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
        const project = latest.pending_relay_acknowledgements.some(item => item.relay_operation_id === staged.acknowledgement.relay_operation_id)
          ? latest
          : await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            pending_relay_acknowledgements: this.appendPendingRelayAcknowledgements(latest, [staged.acknowledgement]),
            revision: latest.revision + 1,
          }))
        await this.repository.saveOperation(this.operation({
          ...operation,
          status: 'succeeded',
          progress: 100,
          stage: '剪辑草稿已生成，等待用户接受',
          result: { ...operation.result, timeline_draft_id: staged.timeline_draft_id, project_revision: project.revision, alternative_count: 0 },
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
      )
      const completed = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...editorialProject,
        brief: compileVideoBrief(staged.user_goal, { ...plan.brief, gaps: [...new Set([...plan.brief.gaps, ...staged.analysis_gaps])].slice(0, 20) }),
        timeline_drafts: [...editorialProject.timeline_drafts, timelineDraft],
        alternatives: [],
        pending_relay_acknowledgements: this.appendPendingRelayAcknowledgements(editorialProject, [staged.acknowledgement]),
        state: 'ready',
        revision: editorialProject.revision + 1,
      }))
      await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'succeeded',
        progress: 100,
        stage: '剪辑草稿已生成，等待用户接受',
        result: { ...operation.result, timeline_draft_id: timelineDraft.id, project_revision: completed.revision, alternative_count: 0 },
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
    const currentScenes = project.timeline_versions.find(version => version.id === project.current_timeline_version_id)?.scenes ?? []
    const planningInput = { sources: project.sources, evidence: project.evidence, currentScenes, userGoal, analysisGaps }
    const requestHash = factBasisHash(planningInput)
    const usage = {
      requests: 1,
      total_tokens: Math.ceil(JSON.stringify(planningInput).length / 4),
      input_bytes: Buffer.byteLength(JSON.stringify(planningInput), 'utf8'),
      visual_frames: 0,
      proxy_seconds: 0,
      asr_seconds: 0,
      estimated_amount_micros: Math.max(1, Math.ceil(JSON.stringify(planningInput).length / 4) * 10),
    }
    const request: RelayOperationRequest = {
      local_operation_id: operation.id,
      consent_revision_id: consent.id,
      consent_scope_hash: factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds }),
      local_budget_reservation_id: budget.id,
      request_hash: requestHash,
      capability: 'media_reasoning',
      application_role: 'planning',
      input: {
        object_refs: [],
        facts_basis_hash: project.evidence_revision ?? requestHash,
        evidence: project.evidence.map(item => ({ id: item.id, kind: item.kind === 'transcript' ? 'transcript' as const : 'visual_fact' as const, text: item.text, confidence: item.confidence })),
        language: 'zh',
        output_schema_version: 1,
      },
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
      if (operation.project_id !== projectId || !['video.analyze', 'video.plan', 'video.index'].includes(operation.kind)) {
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
        const checkpoint: AsrPollCheckpoint = {
          source_id: sourceId,
          local_operation_id: existing?.local_operation_id ?? `${parentOperationId}_asr_${sourceId}`,
          state: patch.state ?? existing?.state ?? 'uploading',
          ...(existing?.object_ref ? { object_ref: existing.object_ref } : {}),
          ...(existing?.relay_operation_id ? { relay_operation_id: existing.relay_operation_id } : {}),
          ...(existing?.provider_task_id ? { provider_task_id: existing.provider_task_id } : {}),
          ...(existing?.remote_submission_started_at ? { remote_submission_started_at: existing.remote_submission_started_at } : {}),
          ...(existing?.next_poll_at ? { next_poll_at: existing.next_poll_at } : {}),
          ...patch,
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
      accepted = await relay.createOperation(request)
      const value = await consume(relay, accepted)
      // A caller with a parent Operation clears/replaces its fence only inside
      // `consume`, together with a durable local result (Fact, staged Plan, or
      // staged query vector). Clearing here would create a paid-result crash
      // window between this return and the caller's later persistence step.
      return value
    } catch (error) {
      // The Relay has already supplied a terminal receipt. Parsing or local
      // projection failures after that point are not provider-outcome unknown;
      // the caller has settled the one receipt and may fail normally.
      if (accepted?.state === 'succeeded' && accepted.provider_receipt) {
        if (options.parentOperationId) await this.updateRemoteOperationRecovery(
          options.parentOperationId,
          error instanceof VideoWorkbenchServiceError ? 'cleared' : 'outcome_unknown',
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
        replayed = await recoveryRelay.createOperation(request)
        if (replayed.id !== existing.id) throw new VideoMediaRelayClientError(409, 'local_operation_projection_conflict')
        const value = await consume(recoveryRelay, replayed)
        return value
      } catch (recoveryError) {
        if (
          replayed?.state === 'succeeded'
          && replayed.provider_receipt
          && recoveryError instanceof VideoWorkbenchServiceError
        ) {
          // A deterministic local validation rejected a known terminal result.
          // Do not schedule another consume/replay of the same invalid payload.
          if (options.parentOperationId) await this.updateRemoteOperationRecovery(options.parentOperationId, 'cleared')
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
    const previous = this.projectMutations.get(projectId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const current = previous.catch(() => undefined).then(() => gate)
    this.projectMutations.set(projectId, current)
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
      if (this.projectMutations.get(projectId) === current) this.projectMutations.delete(projectId)
    }
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

  async listProjects(owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<VideoStudioProject[]> {
    return await this.repository.listProjects(owner)
  }

  async getProject(projectId: string): Promise<VideoStudioProject> {
    return await this.project(projectId)
  }

  /** A persisted estimate is the only value a Consent may acknowledge. */
  async estimateRemoteAnalysis(projectId: string, raw: EstimateRemoteAnalysisInput) {
    return await this.mutateProject(projectId, async () => {
      const input = estimateRemoteAnalysisInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const selected = project.sources.filter(source => input.source_ids.includes(source.id))
      if (selected.length !== input.source_ids.length) throw new VideoWorkbenchServiceError('预算估算引用了不存在的素材', 404, 'VIDEO_SOURCE_NOT_FOUND')
      const seconds = selected.reduce((total, source) => total + source.duration_ms / 1000, 0)
      // Each source yields one immutable ASR operation irrespective of the
      // provider's short/long route. Visual evidence is charged per frame;
      // semantic search always needs a document and a query embedding.
      const asrRequests = input.purposes.includes('asr') ? selected.length : 0
      const visualFrames = input.purposes.includes('visual_evidence') ? Math.ceil(seconds / 5) : 0
      const asrSeconds = input.purposes.includes('asr') ? seconds : 0
      // The local ASR extraction is 16 kHz mono PCM S16LE (two bytes per
      // sample), not a 16 KB/s compressed estimate. Visual frames are bounded
      // at 10 MiB before upload, so reserve their declared maximum as well.
      const inputBytes = Math.ceil(asrSeconds * 32_000) + asrRequests * 44 + visualFrames * 10 * 1024 * 1024
      const totalTokens = Math.ceil(seconds * 8) + (input.purposes.includes('planning') ? 4_000 : 0)
      // These are the approved upper-bound units used for admission before a
      // paid request. Provider receipts later replace them with upstream cost.
      const estimatedAmountMicros = Math.ceil(asrSeconds * 120 + visualFrames * 250 + totalTokens * 10)
      const estimate = {
        id: id('budget'),
        estimate_hash: factBasisHash({ project_id: project.id, purposes: [...input.purposes].sort(), source_ids: [...input.source_ids].sort(), seconds, visualFrames, asrSeconds, inputBytes }),
        state: 'estimated' as const,
        requests: visualFrames + asrRequests
          + (input.purposes.includes('planning') ? 1 : 0)
          + (input.purposes.includes('caption_translation') ? 1 : 0)
          // A generation can contain 10,000 entries and Relay accepts 2,000
          // document embeddings per operation, plus the query vector.
          + (input.purposes.includes('semantic_search') ? 6 : 0),
        total_tokens: totalTokens,
        input_bytes: inputBytes,
        visual_frames: visualFrames,
        proxy_seconds: input.purposes.includes('visual_evidence') ? seconds : 0,
        asr_seconds: asrSeconds,
        estimated_amount_micros: estimatedAmountMicros,
        created_at: this.iso(),
        updated_at: this.iso(),
      }
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, remote_analysis_budgets: [...project.remote_analysis_budgets, estimate] }))
      return estimate
    })
  }

  async grantRemoteAnalysisConsent(projectId: string, raw: CreateRemoteAnalysisConsentInput) {
    return await this.mutateProject(projectId, async () => {
      const input = createRemoteAnalysisConsentInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const estimate = project.remote_analysis_budgets.find(item => item.estimate_hash === input.acknowledged_estimate_hash && item.state === 'estimated')
      if (!estimate) throw new VideoWorkbenchServiceError('远程分析同意必须确认当前项目的预算估算', 409, 'VIDEO_REMOTE_ESTIMATE_REQUIRED')
      for (const coverage of input.coverage) {
        const source = project.sources.find(candidate => candidate.id === coverage.source_id)
        if (!source || coverage.ranges.some(range => Number(range.start.ticks) < 0 || Number(range.duration.ticks) <= 0)) {
          throw new VideoWorkbenchServiceError('远程分析范围无效', 422, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
        }
      }
      const revision = Math.max(0, ...project.remote_analysis_consents.map(consent => consent.revision)) + 1
      const consent = {
        id: id('consent'), project_id: project.id, revision, state: 'active' as const,
        provider: 'aliyun_bailian' as const, region: 'cn-beijing' as const,
        purposes: input.purposes, data_kinds: input.data_kinds, coverage: input.coverage,
        acknowledged_estimate_hash: input.acknowledged_estimate_hash,
        granted_by_actor_id: input.granted_by_actor_id ?? STANDALONE_VIDEO_OWNER.owner_id,
        granted_at: this.iso(),
      }
      const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        remote_analysis_consents: [...project.remote_analysis_consents.map(item => item.state === 'active' ? { ...item, state: 'revoked' as const, revoked_at: this.iso() } : item), consent],
        remote_analysis_budgets: project.remote_analysis_budgets.map(item => item.id === estimate.id ? { ...item, state: 'reserved' as const, updated_at: this.iso() } : item),
      }))
      return { project: saved, consent }
    })
  }

  async revokeRemoteAnalysisConsent(projectId: string, raw: { revision: number }) {
    return await this.mutateProject(projectId, async () => {
      const input = revokeRemoteAnalysisConsentInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const current = project.remote_analysis_consents.find(item => item.revision === input.revision)
      if (!current) throw new VideoWorkbenchServiceError('远程分析同意不存在', 404, 'VIDEO_REMOTE_CONSENT_NOT_FOUND')
      if (current.state === 'revoked') return project
      return await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, remote_analysis_consents: project.remote_analysis_consents.map(item => item.id === current.id ? { ...item, state: 'revoked' as const, revoked_at: this.iso() } : item) }))
    })
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

  private async editorialSourceBounds(project: VideoStudioProject): Promise<Map<string, EditorialSourceBounds>> {
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
      bounds.set(source.id, {
        start: fact.primary_video_stream.start_time,
        // Presentation duration can include discontinuities or stream
        // alignment. Editorial source ranges are bounded by the primary
        // video stream that the compiler will actually read.
        duration: fact.primary_video_stream.duration,
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

  private async prepareEditorialProject(projectId: string): Promise<VideoStudioProject> {
    const current = await this.requireVideoProject(projectId)
    const checked = await this.assertSourcesUnchanged(current)
    return await this.ensureEditorialState(checked)
  }

  private sameLegacyProjectionItem(current: VideoTimelineItem, desired: VideoTimelineItem): boolean {
    return current.legacy_scene_id === desired.legacy_scene_id
      && current.kind === desired.kind
      && current.track_id === desired.track_id
      && JSON.stringify(current.timeline_range) === JSON.stringify(desired.timeline_range)
      && JSON.stringify(current.binding) === JSON.stringify(desired.binding)
  }

  /**
   * v1 actions may choose a read-compatible scene projection, but the actual
   * state transition is always one v2 CommandSet. Locked v2 items are retained
   * verbatim and must be represented by the requested legacy projection.
   */
  private legacyProjectionCommandSet(
    project: VideoStudioProject,
    desired: VideoTimelineItem[],
    idempotencyKey: string,
  ) {
    const current = this.editorial.currentTimeline(project)
    const lockedTrackIds = new Set(current.tracks.filter(track => track.locked).map(track => track.id))
    const locked = current.items.filter(item => item.locked || lockedTrackIds.has(item.track_id))
    const retainedDesiredIds = new Set<string>()
    for (const lockedItem of locked) {
      const match = desired.find(candidate => this.sameLegacyProjectionItem(lockedItem, candidate))
      if (!match) {
        throw new VideoWorkbenchServiceError('备选时间线不能覆盖锁定场景', 409, 'VIDEO_LOCKED_SCENE_CONFLICT')
      }
      retainedDesiredIds.add(match.id)
    }
    const deletable = current.items.filter(item => !item.locked && !lockedTrackIds.has(item.track_id))
    const inserts = desired.filter(item => !retainedDesiredIds.has(item.id))
    const commands: EditorialTimelineCommand[] = [
      ...(deletable.length ? [{ kind: 'ripple_delete' as const, item_ids: deletable.map(item => item.id), close_gap: false }] : []),
      ...inserts.map(item => ({ kind: 'insert' as const, track_id: item.track_id, item })),
    ]
    // A CommandSet is also the durable audit marker for a no-op empty legacy
    // projection. Preserve the current track state instead of making a hidden
    // v1 write.
    if (!commands.length) {
      const track = current.tracks[0]
      if (!track) throw new VideoWorkbenchServiceError('编辑时间线轨道不存在', 409, 'VIDEO_TIMELINE_MISSING')
      commands.push({ kind: 'set_track_state' as const, track_id: track.id, locked: track.locked })
    }
    return timelineCommandSetSchema.parse({
      id: `command_${randomUUID().replaceAll('-', '')}`,
      project_id: project.id,
      actor_id: STANDALONE_VIDEO_OWNER.owner_id,
      idempotency_key: idempotencyKey,
      created_at: this.iso(),
      target: { kind: 'editorial', base_timeline_version_id: current.id },
      commands,
    })
  }

  async getEditorialTimeline(projectId: string, versionId: string): Promise<EditorialTimelineVersion> {
    return await this.mutateProject(projectId, async () => {
      const project = await this.prepareEditorialProject(projectId)
      const version = project.editorial_timeline_versions.find(candidate => candidate.id === versionId)
      if (!version) throw new VideoWorkbenchServiceError('编辑时间线版本不存在', 404, 'VIDEO_TIMELINE_MISSING')
      return version
    })
  }

  async getTimelineDraft(projectId: string, draftId: string) {
    return await this.mutateProject(projectId, async () => {
      const project = await this.prepareEditorialProject(projectId)
      const draft = project.timeline_drafts.find(candidate => candidate.id === draftId)
      if (!draft) throw new VideoWorkbenchServiceError('时间线草稿不存在', 404, 'VIDEO_TIMELINE_DRAFT_NOT_FOUND')
      return draft
    })
  }

  async getDeliveryVariant(projectId: string, variantId: string): Promise<{ variant: DeliveryVariant; version: DeliveryVariantVersion }> {
    return await this.mutateProject(projectId, async () => {
      const project = await this.prepareEditorialProject(projectId)
      const variant = project.delivery_variants.find(candidate => candidate.id === variantId)
      const version = variant && project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)
      if (!variant || !version) throw new VideoWorkbenchServiceError('交付变体不存在', 404, 'VIDEO_DELIVERY_VARIANT_NOT_FOUND')
      return { variant, version }
    })
  }

  async applyEditorialTimelineCommands(
    projectId: string,
    raw: ApplyEditorialTimelineCommandsInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; version: EditorialTimelineVersion; reused: boolean }> {
    return await this.mutateProject(projectId, async () => {
      const input = applyEditorialTimelineCommandsInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      try {
        const commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: STANDALONE_VIDEO_OWNER.owner_id,
          idempotency_key: idempotencyKey,
          created_at: this.iso(),
          target: { kind: 'editorial', base_timeline_version_id: input.base_timeline_version_id },
          commands: input.commands,
        })
        const applied = this.editorial.applyCommandSet(project, commandSet, await this.editorialSourceBounds(project))
        const saved = applied.reused ? project : await this.repository.saveProject(videoStudioProjectSchema.parse(applied.project))
        return { project: saved, version: applied.version as EditorialTimelineVersion, reused: applied.reused }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async acceptTimelineDraft(
    projectId: string,
    draftId: string,
    raw: AcceptTimelineDraftInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; version: EditorialTimelineVersion; reused: boolean }> {
    return await this.mutateProject(projectId, async () => {
      const input = acceptTimelineDraftInputSchema.parse(raw)
      let project = await this.prepareEditorialProject(projectId)
      const draft = project.timeline_drafts.find(candidate => candidate.id === draftId)
      if (!draft) throw new VideoWorkbenchServiceError('时间线草稿不存在', 404, 'VIDEO_TIMELINE_DRAFT_NOT_FOUND')
      const current = this.editorial.currentTimeline(project)
      if (draft.status === 'accepted' && draft.accepted_command_set_id) {
        const receipt = project.editorial_command_receipts.find(candidate => candidate.command_set_id === draft.accepted_command_set_id && candidate.idempotency_key === idempotencyKey)
        const version = receipt && project.editorial_timeline_versions.find(candidate => candidate.id === receipt.created_version_id)
        if (version) return { project, version, reused: true }
      }
      if (
        draft.status !== 'proposed'
        || draft.facts_basis_hash !== editorialFactsBasisHash(project)
        || draft.base_timeline_version_id !== current.id
        || (input.base_timeline_version_id && input.base_timeline_version_id !== current.id)
      ) {
        if (draft.status === 'proposed' && draft.facts_basis_hash !== editorialFactsBasisHash(project)) {
          project = await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...project,
            timeline_drafts: project.timeline_drafts.map(candidate => candidate.id === draft.id ? { ...candidate, status: 'stale' } : candidate),
          }))
        }
        throw new VideoWorkbenchServiceError('时间线草稿已经过期，请重新生成', 409, 'VIDEO_EDITORIAL_STALE')
      }
      if (JSON.stringify(draft.tracks) !== JSON.stringify(current.tracks)) {
        throw new VideoWorkbenchServiceError('时间线草稿的轨道结构已变化，请重新生成', 409, 'VIDEO_EDITORIAL_STALE')
      }
      try {
        const commandSet = timelineCommandSetSchema.parse({
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
        const applied = this.editorial.applyCommandSet(project, commandSet, await this.editorialSourceBounds(project))
        const next = applied.reused ? project : {
          ...applied.project,
          timeline_drafts: applied.project.timeline_drafts.map(candidate => candidate.id === draft.id
            ? { ...candidate, status: 'accepted', accepted_command_set_id: commandSet.id }
            : candidate),
        }
        const saved = applied.reused ? project : await this.repository.saveProject(videoStudioProjectSchema.parse(next))
        return { project: saved, version: applied.version as EditorialTimelineVersion, reused: applied.reused }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async createDeliveryVariant(
    projectId: string,
    raw: CreateDeliveryVariantInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; variant: DeliveryVariant; version: DeliveryVariantVersion; reused: boolean }> {
    return await this.mutateProject(projectId, async () => {
      const input = createDeliveryVariantInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      const requestHash = factBasisHash(input)
      const existing = project.delivery_variant_creation_receipts.find(receipt => receipt.idempotency_key === idempotencyKey)
      if (existing) {
        if (existing.request_hash !== requestHash) throw new VideoWorkbenchServiceError('同一幂等键不能创建不同交付变体', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
        const variant = project.delivery_variants.find(candidate => candidate.id === existing.variant_id)
        if (!existing.version_id) throw new VideoWorkbenchServiceError('交付变体幂等记录缺少首次版本，不能安全重放', 500, 'VIDEO_EDITORIAL_INVALID')
        const version = project.delivery_variant_versions.find(candidate => candidate.id === existing.version_id)
        if (!variant || !version) throw new VideoWorkbenchServiceError('交付变体幂等记录损坏', 500, 'VIDEO_EDITORIAL_INVALID')
        return { project, variant, version, reused: true }
      }
      try {
        const created = this.editorial.createDeliveryVariant(project, input, `command_${randomUUID().replaceAll('-', '')}`)
        const saved = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...created.project,
          delivery_variant_creation_receipts: [...created.project.delivery_variant_creation_receipts, {
            idempotency_key: idempotencyKey,
            request_hash: requestHash,
            variant_id: created.variant.id,
            version_id: created.version.id,
            created_at: this.iso(),
          }],
        }))
        return { project: saved, variant: created.variant, version: created.version, reused: false }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async applyDeliveryVariantCommands(
    projectId: string,
    variantId: string,
    raw: ApplyDeliveryVariantCommandsInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; version: DeliveryVariantVersion; reused: boolean }> {
    return await this.mutateProject(projectId, async () => {
      const input = applyDeliveryVariantCommandsInputSchema.parse(raw)
      const project = await this.prepareEditorialProject(projectId)
      try {
        const commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: STANDALONE_VIDEO_OWNER.owner_id,
          idempotency_key: idempotencyKey,
          created_at: this.iso(),
          target: { kind: 'delivery_variant', variant_id: variantId, base_variant_version_id: input.base_variant_version_id },
          commands: input.commands,
        })
        const applied = this.editorial.applyCommandSet(project, commandSet, await this.editorialSourceBounds(project))
        const saved = applied.reused ? project : await this.repository.saveProject(videoStudioProjectSchema.parse(applied.project))
        return { project: saved, version: applied.version as DeliveryVariantVersion, reused: applied.reused }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async compileDeliveryVariant(projectId: string, variantId: string) {
    return await this.mutateProject(projectId, async () => {
      const project = await this.prepareEditorialProject(projectId)
      try {
        const compiled = this.editorial.compile(project, variantId, await this.editorialSourceBounds(project))
        // Compilation is not merely a persisted description: construct the
        // exact FFmpeg command now so unsupported tracks/effects fail before
        // the immutable plan is published to callers.
        buildExecutionPlanRenderCommand(
          videoBinary('ffmpeg', this.env, this.platform),
          compiled.project,
          compiled.plan,
          join(this.repository.paths().root, 'execution-plans', `${compiled.plan.id}.mp4`),
        )
        const saved = await this.repository.saveProject(videoStudioProjectSchema.parse(compiled.project))
        return { project: saved, plan: compiled.plan }
      } catch (error) {
        return this.editorialError(error)
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
    const lexical = await this.repository.searchFactsPage(projectId, query, options)
    const consent = project.remote_analysis_consents.find(item => item.state === 'active' && item.purposes.includes('semantic_search') && item.data_kinds.includes('transcript'))
    const budget = consent && project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
    const relay = this.videoMediaRelay()
    if (!consent || !budget || !relay) return lexical
    // This attempts only durable ACK retries. It does not submit, download or
    // otherwise re-run a document embedding whose vectors already committed.
    await this.flushPendingRelayAcknowledgements(projectId)
    const scopeHash = factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds })
    const candidates = await this.repository.listCurrentSearchCandidates(projectId)
    const eligible = candidates.filter(item => item.kind === 'transcript' && consent.coverage.some(coverage => coverage.source_id === item.source_id && coverage.ranges.some(range => compareRationalTime(item.range.start, range.start) >= 0 && compareRationalTime(endOfRange(item.range), endOfRange(range)) <= 0)))
    if (!eligible.length) return lexical
    const nonce = createHash('sha256').update(JSON.stringify({ projectId, generation: lexical.generation, query, cursor: options?.cursor })).digest('hex').slice(0, 24)
    const allDocumentItems = eligible.map((item, index) => ({ id: `embed_${nonce.slice(0, 12)}${index.toString(16).padStart(4, '0')}`, text: item.text, entry_id: item.kind === 'transcript' ? `${item.id}\u001f${item.segment_ids.join(',')}` : item.id }))
    try {
      const missing = await this.repository.missingSearchEmbeddingEntries(projectId, allDocumentItems.map(item => item.entry_id))
      const documentItems = allDocumentItems.filter(item => missing.has(item.entry_id))
      for (let offset = 0; offset < documentItems.length; offset += 2_000) {
        const batch = documentItems.slice(offset, offset + 2_000)
        const documentOperationId = `task_${nonce}d${String(offset / 2_000).padStart(2, '0')}`
        const documentUsage = {
          requests: 1, total_tokens: batch.reduce((sum, item) => sum + Math.ceil(item.text.length / 4), 0), input_bytes: Buffer.byteLength(JSON.stringify(batch), 'utf8'), visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: Math.max(1, batch.reduce((sum, item) => sum + Math.ceil(item.text.length / 4), 0) * 10),
        }
        const documentRequest = { local_operation_id: documentOperationId, consent_revision_id: consent.id, consent_scope_hash: scopeHash, local_budget_reservation_id: budget.id, request_hash: factBasisHash({ generation: lexical.generation, documents: batch.map(item => ({ id: item.entry_id, text: item.text })) }), capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'document' as const, items: batch.map(item => ({ id: item.id, text: item.text })), model: 'text-embedding-v4' as const, dimension: 768 as const, instruction_version: 'video-facts-v1' } }
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
      const queryUsage = {
        requests: 1, total_tokens: Math.ceil(query.length / 4), input_bytes: Buffer.byteLength(query, 'utf8'), visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: Math.max(1, Math.ceil(query.length / 4) * 10),
      }
      const queryHash = factBasisHash({ generation: lexical.generation, query })
      const queryRequest = { local_operation_id: queryLocalOperationId, consent_revision_id: consent.id, consent_scope_hash: scopeHash, local_budget_reservation_id: budget.id, request_hash: queryHash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: `embed_${nonce}`, text: query }], model: 'text-embedding-v4' as const, dimension: 768 as const, instruction_version: 'video-facts-v1' } }
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
    return extname(path).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4'
  }

  private async videoFileResponse(path: string, request: Request): Promise<Response> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new VideoWorkbenchServiceError('视频素材不可用', 404, 'VIDEO_ASSET_NOT_FOUND')
    const range = request.headers.get('range')
    const headers = { 'Content-Type': this.videoContentType(path), 'Accept-Ranges': 'bytes' }
    if (!range) return new Response(Bun.file(path), { headers: { ...headers, 'Content-Length': String(info.size) } })
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!match || info.size <= 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
    const suffix = !match[1] && match[2] ? Number(match[2]) : 0
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

  async sourceResponse(projectId: string, sourceId: string, request: Request): Promise<Response> {
    const project = await this.requireVideoProject(projectId)
    const source = project.sources.find(candidate => candidate.id === sourceId)
    if (!source) throw new VideoWorkbenchServiceError('找不到视频素材', 404, 'VIDEO_SOURCE_NOT_FOUND')
    return await this.videoFileResponse(source.path, request)
  }

  async previewResponse(projectId: string, assetId: string, request: Request): Promise<Response> {
    const project = await this.requireVideoProject(projectId)
    const asset = project.assets.find(candidate => candidate.id === assetId && candidate.role === 'preview')
    const expectedLocator = join(project.id, `${assetId}.mp4`)
    if (!asset || asset.storage.kind !== 'managed' || asset.storage.locator !== expectedLocator) {
      throw new VideoWorkbenchServiceError('找不到视频预览', 404, 'VIDEO_ASSET_NOT_FOUND')
    }
    const root = resolve(this.repository.paths().assets)
    const path = resolve(root, asset.storage.locator)
    if (!path.startsWith(`${root}/`)) throw new VideoWorkbenchServiceError('视频预览地址无效', 404, 'VIDEO_ASSET_NOT_FOUND')
    return await this.videoFileResponse(path, request)
  }

  /**
   * One-way, idempotent import from the former generic media store. The old
   * files are retained as recovery evidence; after a project is imported the
   * video workbench is its sole writer and its preview cache lives below the
   * new video root. No import asks MediaProjectService to keep ownership.
   */
  async migrateLegacyMediaStore(): Promise<{ migrated_project_ids: string[]; skipped_project_ids: string[] }> {
    const projectsDir = join(this.legacyMediaRoot, 'projects')
    const tasksDir = join(this.legacyMediaRoot, 'tasks')
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
    const taskNames = await readdir(tasksDir).catch(() => [])
    const tasksByProject = new Map<string, VideoOperation[]>()
    for (const name of taskNames.filter(name => name.endsWith('.json'))) {
      const raw = await readFile(join(tasksDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      const parsed = mediaTaskSchema.safeParse(normalize(JSON.parse(raw)))
      if (!parsed.success || !parsed.data.kind.startsWith('video.')) continue
      const operation = parsed.data as VideoOperation
      tasksByProject.set(operation.project_id, [...(tasksByProject.get(operation.project_id) ?? []), operation])
    }

    const migratedProjectIds: string[] = []
    const skippedProjectIds: string[] = []
    const projectNames = await readdir(projectsDir).catch(() => [])
    for (const name of projectNames.filter(name => name.endsWith('.json')).sort()) {
      const raw = await readFile(join(projectsDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      const parsed = videoStudioProjectSchema.safeParse(normalize(JSON.parse(raw)))
      if (!parsed.success) continue
      const legacy = parsed.data
      const existing = await this.repository.getProject(legacy.id).catch(error => {
        if (error instanceof VideoWorkbenchRepositoryError && error.code === 'VIDEO_PROJECT_NOT_FOUND') return null
        throw error
      })
      if (existing) {
        skippedProjectIds.push(legacy.id)
        continue
      }

      const legacyTasks = tasksByProject.get(legacy.id) ?? []
      const knownTaskIds = new Set(legacyTasks.map(task => task.id))
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
      await this.repository.saveProject(imported)
      for (const task of legacyTasks) await this.repository.saveOperation(task)
      migratedProjectIds.push(legacy.id)
    }
    return { migrated_project_ids: migratedProjectIds, skipped_project_ids: skippedProjectIds }
  }

  async createProject(raw: CreateVideoProjectInput): Promise<VideoStudioProject> {
    const input = createVideoProjectInputSchema.parse(raw)
    const now = this.iso()
    return await this.repository.saveProject(videoStudioProjectSchema.parse({
      schema_version: 1,
      id: id('vid'),
      kind: 'video',
      title: input.title ?? '新视频',
      workspace_root: input.workspace_root,
      owner: STANDALONE_VIDEO_OWNER,
      writer_fence: INITIAL_WRITER_FENCE,
      assets: [],
      versions: [],
      revision: 0,
      created_at: now,
      updated_at: now,
      state: 'draft',
      sources: [],
      timeline: [],
      evidence: [],
      timeline_versions: [],
      alternatives: [],
      output: input.output,
    }))
  }

  private async requireVideoProject(projectId: string): Promise<VideoStudioProject> {
    const project = await this.project(projectId)
    if (project.kind !== 'video') throw new VideoWorkbenchServiceError('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return project
  }

  async addVideoSource(projectId: string, raw: AddVideoSourceInput): Promise<{ project: VideoStudioProject; task: VideoOperation }> {
    return await this.mutateProject(projectId, async () => {
      const input = addVideoSourceInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      if (project.state === 'rendering') throw new VideoWorkbenchServiceError('正在导出，暂时不能添加素材', 409, 'VIDEO_RENDER_ACTIVE')
      if (!isAbsolute(input.path)) throw new VideoWorkbenchServiceError('视频素材必须使用绝对路径', 400, 'SOURCE_PATH_NOT_ABSOLUTE')
      const now = this.iso()
      let task = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.probe',
        status: 'running',
        progress: 20,
        stage: '正在读取素材',
        created_at: now,
        updated_at: now,
      } as VideoOperation))
      try {
        const sourceId = id('src')
        const sourceFact = await probeVideoFactSource({
          id: sourceId,
          projectId: project.id,
          path: input.path,
          name: basename(input.path),
          now,
          runProcess: this.runProcess,
          ffprobe: videoBinary('ffprobe', this.env, this.platform),
        })
        await this.repository.saveFact(sourceFact)
        const durationMs = Math.max(1, timeToMilliseconds(sourceFact.presentation_duration))
        const averageRate = sourceFact.primary_video_stream.average_frame_rate
        const source = {
          id: sourceId,
          path: input.path,
          name: basename(input.path),
          duration_ms: durationMs,
          width: sourceFact.primary_video_stream.width,
          height: sourceFact.primary_video_stream.height,
          ...(averageRate ? { fps: averageRate.num / averageRate.den } : {}),
          has_audio: sourceFact.audio_tracks.length > 0,
          rotation: sourceFact.primary_video_stream.rotation,
          video_stream_count: 1,
          audio_stream_count: sourceFact.audio_tracks.length,
          missing: false,
          content_changed: false,
        }
        const clip: VideoClip = {
          id: id('clip'),
          source_id: sourceId,
          in_ms: 0,
          out_ms: source.duration_ms,
        }
        // A source role is only evidence after the independent full fingerprint
        // has completed. The fast probe remains useful for UI and local edits.
        const evidence: VideoEvidence[] = project.evidence
        const nextEvidenceRevision = evidenceRevision(evidence)
        const activeVersion = project.timeline_versions.find(version => version.id === project.current_timeline_version_id)
        const nextScenes = [...(activeVersion?.scenes ?? scenesFromClips(project.timeline, project.evidence)), scenesFromClips([clip], evidence)[0]!]
        const version = this.timelineVersion({ ...project, evidence, evidence_revision: nextEvidenceRevision }, nextScenes, nextEvidenceRevision)
        const asset: MediaAsset = {
          id: sourceId,
          role: 'source',
          version_id: sourceId,
          storage: { kind: 'external', locator: input.path },
          mime_type: 'video/mp4',
          created_at: now,
        }
        const next = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          state: 'ready',
          sources: [...project.sources, source],
          assets: [...project.assets, asset],
          timeline: [...project.timeline, clip],
          evidence,
          evidence_revision: nextEvidenceRevision,
          timeline_versions: [...project.timeline_versions, version],
          current_timeline_version_id: version.id,
          alternatives: [],
          revision: project.revision + 1,
          error: undefined,
          error_code: undefined,
        }))
        task = await this.repository.saveOperation(this.operation({
          ...task,
          status: 'succeeded',
          progress: 100,
          stage: '素材已加入',
          result: { source_id: sourceId },
        }))
        const fingerprintTask = await this.repository.saveOperation(this.operation({
          schema_version: 1,
          id: id('task'),
          project_id: project.id,
          kind: 'video.fingerprint',
          status: 'queued',
          progress: 0,
          stage: '等待计算完整指纹',
          result: { source_id: sourceId },
          created_at: now,
          updated_at: now,
        } as unknown as VideoOperation))
        this.startFingerprint(fingerprintTask, sourceId)
        return { project: next, task }
      } catch (error) {
        const failure = mediaSafeError('MEDIA_VIDEO_SOURCE_UNREADABLE')
        task = await this.repository.saveOperation(this.operation({
          ...task,
          status: 'failed',
          progress: 0,
          stage: '读取失败',
          error: failure.message,
          error_code: failure.code,
        }))
        if (error instanceof VideoWorkbenchServiceError) throw error
        throw new VideoWorkbenchServiceError(failure.message, 422, 'VIDEO_PROBE_FAILED')
      }
    })
  }

  async updateTimeline(projectId: string, raw: UpdateVideoTimelineInput): Promise<VideoStudioProject> {
    return await this.mutateProject(projectId, async () => {
      const input = updateVideoTimelineInputSchema.parse(raw)
      const legacyProject = await this.requireVideoProject(projectId)
      if (legacyProject.state === 'rendering') throw new VideoWorkbenchServiceError('正在导出，暂时不能修改时间线', 409, 'VIDEO_RENDER_ACTIVE')
      if (legacyProject.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再编辑', 409, 'VIDEO_REVISION_CONFLICT')
      const baseVersionId = input.base_timeline_version_id ?? legacyProject.current_timeline_version_id
      if (legacyProject.current_timeline_version_id !== baseVersionId) {
        throw new VideoWorkbenchServiceError('视频时间线已更新，请刷新后再编辑', 409, 'VIDEO_TIMELINE_CONFLICT')
      }
      if (!legacyProject.timeline_versions.some(version => version.id === baseVersionId)) {
        throw new VideoWorkbenchServiceError('视频时间线版本不存在', 409, 'VIDEO_TIMELINE_MISSING')
      }
      const project = await this.prepareEditorialProject(projectId)
      try {
        const current = this.editorial.currentTimeline(project)
        const items = this.editorial.itemsFromLegacyClips(project, input.clips, current.tracks, await this.editorialTimings(project))
        const commandSet = this.legacyProjectionCommandSet(
          project,
          items,
          `legacy-update-${factBasisHash({ base_revision: input.base_revision, base_timeline_version_id: baseVersionId, clips: input.clips })}`,
        )
        const applied = this.editorial.applyCommandSet(project, commandSet, await this.editorialSourceBounds(project))
        if (applied.reused) return project
        // The formal v1 Version is a read-only projection of the accepted
        // CommandSet target. Preview/Render consume this exact projection, so
        // the legacy version ID can never describe different clip contents.
        const formalVersion = this.timelineVersion(
          applied.project,
          scenesFromClips(input.clips, applied.project.evidence),
          applied.project.evidence_revision ?? evidenceRevision(applied.project.evidence),
          applied.project.revision,
        )
        return await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...applied.project,
          timeline: input.clips,
          timeline_versions: [...applied.project.timeline_versions, formalVersion],
          current_timeline_version_id: formalVersion.id,
          alternatives: [],
          state: input.clips.length ? 'ready' : 'draft',
        }))
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async selectTimelineVersion(projectId: string, raw: SelectVideoTimelineVersionInput): Promise<VideoStudioProject> {
    return await this.mutateProject(projectId, async () => {
      const input = selectVideoTimelineVersionInputSchema.parse(raw)
      const legacyProject = await this.requireVideoProject(projectId)
      if (legacyProject.state === 'rendering') throw new VideoWorkbenchServiceError('正在导出，暂时不能恢复时间线', 409, 'VIDEO_RENDER_ACTIVE')
      if (legacyProject.revision !== input.revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再选择版本', 409, 'VIDEO_REVISION_CONFLICT')
      const version = legacyProject.timeline_versions.find(candidate => candidate.id === input.version_id)
      if (!version) throw new VideoWorkbenchServiceError('视频时间线版本不存在', 404, 'VIDEO_TIMELINE_MISSING')
      const project = await this.prepareEditorialProject(projectId)
      try {
        const current = this.editorial.currentTimeline(project)
        const items = this.editorial.itemsFromLegacyScenes(project, version.scenes, current.tracks, await this.editorialTimings(project))
        const commandSet = this.legacyProjectionCommandSet(
          project,
          items,
          `legacy-select-${factBasisHash({ revision: input.revision, version_id: version.id })}`,
        )
        const applied = this.editorial.applyCommandSet(project, commandSet, await this.editorialSourceBounds(project))
        if (applied.reused) return project
        return await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...applied.project,
          // Kept only for the formal v1 preview/export reader; this is a
          // projection of the CommandSet target, not a new timeline version.
          timeline: version.scenes.map(scene => ({ id: scene.id, source_id: scene.source_id, in_ms: scene.in_ms, out_ms: scene.out_ms })),
          current_timeline_version_id: version.id,
          alternatives: [],
          state: version.scenes.length ? 'ready' : 'draft',
        }))
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async lockScene(projectId: string, sceneId: string, raw: LockVideoSceneInput): Promise<VideoStudioProject> {
    return await this.mutateProject(projectId, async () => {
      const input = lockVideoSceneInputSchema.parse(raw)
      const legacyProject = await this.requireVideoProject(projectId)
      if (legacyProject.state === 'rendering') throw new VideoWorkbenchServiceError('正在导出，暂时不能修改时间线', 409, 'VIDEO_RENDER_ACTIVE')
      if (legacyProject.revision !== input.base_revision || legacyProject.current_timeline_version_id !== input.timeline_version_id) {
        throw new VideoWorkbenchServiceError('视频时间线已更新，请刷新后再编辑', 409, 'VIDEO_TIMELINE_CONFLICT')
      }
      const legacyCurrent = legacyProject.timeline_versions.find(version => version.id === input.timeline_version_id)
      if (!legacyCurrent || !legacyCurrent.scenes.some(scene => scene.id === sceneId)) {
        throw new VideoWorkbenchServiceError('场景不存在', 404, 'VIDEO_SCENE_NOT_FOUND')
      }
      const project = await this.prepareEditorialProject(projectId)
      try {
        const current = this.editorial.currentTimeline(project)
        const itemIds = current.items.filter(item => item.legacy_scene_id === sceneId).map(item => item.id)
        if (!itemIds.length) throw new VideoWorkbenchServiceError('场景尚未迁移到编辑时间线', 409, 'VIDEO_TIMELINE_MISSING')
        const commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: STANDALONE_VIDEO_OWNER.owner_id,
          idempotency_key: `legacy-lock-${factBasisHash({ base_revision: input.base_revision, timeline_version_id: input.timeline_version_id, scene_id: sceneId, locked: input.locked })}`,
          created_at: this.iso(),
          target: { kind: 'editorial', base_timeline_version_id: current.id },
          commands: [{ kind: 'lock', item_ids: itemIds, locked: input.locked }],
        })
        const applied = this.editorial.applyCommandSet(project, commandSet, await this.editorialSourceBounds(project))
        return applied.reused ? project : await this.repository.saveProject(videoStudioProjectSchema.parse(applied.project))
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async applyAlternative(projectId: string, raw: ApplyVideoAlternativeInput): Promise<VideoStudioProject> {
    return await this.mutateProject(projectId, async () => {
      const input = applyVideoAlternativeInputSchema.parse(raw)
      const legacyProject = await this.requireVideoProject(projectId)
      if (legacyProject.state === 'rendering') throw new VideoWorkbenchServiceError('正在导出，暂时不能修改时间线', 409, 'VIDEO_RENDER_ACTIVE')
      if (legacyProject.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再编辑', 409, 'VIDEO_REVISION_CONFLICT')
      const alternative = legacyProject.alternatives.find(candidate => candidate.id === input.alternative_id)
      if (!alternative) throw new VideoWorkbenchServiceError('备选方案不存在', 404, 'VIDEO_ALTERNATIVE_NOT_FOUND')
      if (alternative.base_timeline_version_id !== legacyProject.current_timeline_version_id) {
        throw new VideoWorkbenchServiceError('备选方案已经过期，请重新分析', 409, 'VIDEO_ALTERNATIVE_STALE')
      }
      const project = await this.prepareEditorialProject(projectId)
      try {
        const current = this.editorial.currentTimeline(project)
        const items = this.editorial.itemsFromLegacyScenes(project, alternative.scenes, current.tracks, await this.editorialTimings(project))
        const commandSet = this.legacyProjectionCommandSet(
          project,
          items,
          `legacy-alternative-${factBasisHash({ base_revision: input.base_revision, alternative_id: alternative.id })}`,
        )
        const applied = this.editorial.applyCommandSet(project, commandSet, await this.editorialSourceBounds(project))
        if (applied.reused) return project
        const formalVersion = this.timelineVersion(
          applied.project,
          alternative.scenes,
          applied.project.evidence_revision ?? evidenceRevision(applied.project.evidence),
          applied.project.revision,
        )
        return await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...applied.project,
          timeline: alternative.scenes.map(scene => ({ id: scene.id, source_id: scene.source_id, in_ms: scene.in_ms, out_ms: scene.out_ms })),
          timeline_versions: [...applied.project.timeline_versions, formalVersion],
          current_timeline_version_id: formalVersion.id,
          alternatives: [],
          state: alternative.scenes.length ? 'ready' : 'draft',
        }))
      } catch (error) {
        return this.editorialError(error)
      }
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
        requests: 1, total_tokens: 0, input_bytes: audio.size, visual_frames: 0, proxy_seconds: 0, asr_seconds: timeToMilliseconds(primaryDuration) / 1000, estimated_amount_micros: Math.max(1, Math.ceil(timeToMilliseconds(primaryDuration) / 1000 * 120)),
      }
      await this.reserveRemoteBudget(project.id, budget.id, localOperationId, 'speech_transcription', reservedUsage)
      let objectRef = checkpoint?.object_ref
      if (!objectRef) {
        try {
          objectRef = await relay.uploadObjectStream({
            local_operation_id: localOperationId, purpose: 'audio_for_asr', content_hash: contentHash, byte_size: audio.size, content_type: 'audio/wav',
            consent_revision_id: consent.id, consent_scope_hash: scopeHash,
          }, () => Readable.toWeb(createReadStream(audioPath)) as unknown as ReadableStream<Uint8Array>)
          const uploaded = await this.saveAsrCheckpoint(operationId, source.id, { object_ref: objectRef, state: 'uploading' })
          if (!uploaded?.object_ref) throw new VideoWorkbenchServiceError('ASR 对象检查点持久化失败，已拒绝远程提交', 503, 'VIDEO_REMOTE_OPERATION_UNAVAILABLE')
          checkpoint = uploaded
        } catch (error) {
          // No provider submission can have happened in this phase. Release
          // the local allocation with a known-safe classification so the same
          // deterministic upload/Operation may resume without outcome_unknown.
          await this.finalizeRemoteBudgetFailure(project.id, budget.id, localOperationId, new VideoMediaRelayClientError(422, 'relay_upload_failed_before_submission'))
          throw error
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
        request_hash: factBasisHash({ source_id: source.id, source_fingerprint: sourceFact.fingerprint, audio_hash: contentHash, source_range: sourceRange, route }),
        capability: 'speech_transcription', application_role: 'asr',
        input: { mode: route, audio_object_ref: objectRef, source_offset: sourceFact.primary_video_stream.start_time, language: 'zh', hotwords: [], speaker_diarization: false, sentence_timestamps: true, word_timestamps: true },
      }
      try {
        remote = await relay.createOperation(asrRequest)
      } catch (error) {
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
            remote = await control.createOperation(asrRequest)
          } catch (retryError) {
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
      const legacySources = project.sources.filter(source => !sourceFacts.has(source.id)).slice(0, 4)
      if (project.sources.filter(source => !sourceFacts.has(source.id)).length > legacySources.length) {
        gaps.push(`旧项目仅抽取前 ${legacySources.length} 个未迁移素材；其余素材保留来源证据。`)
      }
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
        requests: 1, total_tokens: 0, input_bytes: bytes.byteLength, visual_frames: 1, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 250,
      }
      await this.reserveRemoteBudget(project.id, budget.id, frameOperationId, 'visual_evidence', frameUsage)
      const contentHash: `sha256:${string}` = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      let objectRef: string
      try {
        objectRef = await relay.uploadObject({
          local_operation_id: frameOperationId,
          purpose: 'visual_frames', content_hash: contentHash, byte_size: bytes.byteLength, content_type: match[1]!,
          consent_revision_id: consent.id, consent_scope_hash: scopeHash,
        }, bytes)
      } catch (error) {
        // Object transfer precedes the Provider submission. A reserved call
        // can normally be released. A caller-side 499 or identity/content 409
        // remains fenced, however: the client cannot prove which durable Relay
        // lease state won, and a changed object fingerprint must fail closed.
        const uncertainTransfer = error instanceof VideoMediaRelayClientError && (error.status === 499 || error.status === 409)
        await this.finalizeRemoteBudgetFailure(
          project.id,
          budget.id,
          frameOperationId,
          uncertainTransfer ? error : new VideoMediaRelayClientError(422, 'relay_upload_failed_before_submission'),
          { submissionFenced: uncertainTransfer },
        )
        throw error
      }
      const frameRequest = {
        local_operation_id: frameOperationId, consent_revision_id: consent.id, consent_scope_hash: scopeHash, local_budget_reservation_id: budget.id,
        request_hash: factBasisHash({ source_id: frame.source_id, window_id: window.id, range, content_hash: contentHash }),
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

  async analyzeVideoProject(projectId: string, raw: AnalyzeVideoProjectInput): Promise<VideoOperation> {
    const input = analyzeVideoProjectInputSchema.parse(raw)
    const launch = await this.mutateProject(projectId, async () => {
      let project = await this.requireVideoProject(projectId)
      if (project.revision !== input.base_revision) throw new VideoWorkbenchServiceError('视频项目已更新，请刷新后再分析', 409, 'VIDEO_REVISION_CONFLICT')
      if (!project.sources.length) throw new VideoWorkbenchServiceError('请先导入视频素材', 409, 'VIDEO_SOURCE_NOT_FOUND')
      if (project.state === 'rendering') throw new VideoWorkbenchServiceError('正在导出，暂时不能分析', 409, 'VIDEO_RENDER_ACTIVE')
      const active = project.task_id ? await this.repository.getOperation(project.task_id).catch(() => null) : null
      if (active && ['queued', 'running', 'committing'].includes(active.status)) {
        throw new VideoWorkbenchServiceError('当前已有视频操作在运行', 409, 'VIDEO_OPERATION_ACTIVE')
      }
      project = await this.assertSourcesUnchanged(project)
      const now = this.iso()
      const task = await this.repository.saveOperation(this.operation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.analyze',
        status: 'running',
        progress: 5,
        stage: '正在提取素材证据',
        // Persist the intent needed to re-enter analysis after a local Sidecar
        // restart. Long Fun-ASR itself is reconciled through the Relay's
        // deterministic local_operation_id and persisted provider task id.
        result: { base_revision: project.revision, base_timeline_version_id: project.current_timeline_version_id, user_goal: input.user_goal },
        created_at: now,
        updated_at: now,
      } as unknown as VideoOperation))
      await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, task_id: task.id }))
      return { project, task, userGoal: input.user_goal }
    })
    const controller = new AbortController()
    const active: ActiveVideoExecution = { controller, completion: Promise.resolve(), output_path: '' }
    active.completion = Promise.resolve().then(() => this.runVideoAnalysis(launch.project, launch.task, launch.userGoal, controller.signal))
    this.activeAnalyses.set(launch.task.id, active)
    return launch.task
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
      await this.repository.saveOperation(this.operation({ ...analyzeTask, progress: 45, stage: '正在分析画面与语音证据' }))
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
          result: { evidence_revision: revision, evidence_count: evidence.length, next_task_id: planTask.id },
        }))
        return { project: evidenceProject, planTask, evidence, gaps: [...extracted.gaps, ...draft.gaps] }
      })
      await this.flushPendingRelayAcknowledgements(baseProject.id)
      const active = this.activeAnalyses.get(analyzeTask.id)
      this.activeAnalyses.delete(analyzeTask.id)
      if (active) this.activeAnalyses.set(next.planTask.id, active)
      activeTask = next.planTask
      const currentScenes = next.project.timeline_versions.find(version => version.id === next.project.current_timeline_version_id)?.scenes ?? []
      const planningInput = {
        sources: next.project.sources,
        evidence: next.evidence,
        currentScenes,
        userGoal,
        analysisGaps: next.gaps,
      }
      const consent = next.project.remote_analysis_consents.find(item => item.state === 'active' && item.purposes.includes('planning'))
      const budget = consent && next.project.remote_analysis_budgets.find(item => item.estimate_hash === consent.acknowledged_estimate_hash && item.state === 'reserved')
      let plan: VideoPlanDraft
      let stagedPlanningOperation: VideoOperation | undefined
      const relay = this.videoMediaRelay(signal)
      if (consent && budget && relay) {
        const requestHash = factBasisHash(planningInput)
        const planningUsage = {
          requests: 1, total_tokens: Math.ceil(JSON.stringify(planningInput).length / 4), input_bytes: Buffer.byteLength(JSON.stringify(planningInput), 'utf8'), visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: Math.max(1, Math.ceil(JSON.stringify(planningInput).length / 4) * 10),
        }
        const planningRequest = {
          local_operation_id: next.planTask.id,
          consent_revision_id: consent.id,
          consent_scope_hash: factBasisHash({ revision: consent.revision, coverage: consent.coverage, purposes: consent.purposes, data_kinds: consent.data_kinds }),
          local_budget_reservation_id: budget.id,
          request_hash: requestHash,
          capability: 'media_reasoning' as const,
          application_role: 'planning' as const,
          input: { object_refs: [], facts_basis_hash: next.project.evidence_revision ?? requestHash, evidence: next.evidence.map(item => ({ id: item.id, kind: item.kind === 'transcript' ? 'transcript' as const : 'visual_fact' as const, text: item.text, confidence: item.confidence })), language: 'zh', output_schema_version: 1 },
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
        plan = await planVideoTimeline(planningInput, { operationId: `${next.planTask.operation_id ?? next.planTask.id}-timeline`, signal, fetchImpl: this.fetchImpl, env: this.env, allowLegacyGateway: false })
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
          revision: editorialProject.revision + 1,
        }))
        await this.repository.saveOperation(this.operation({
          ...next.planTask,
          status: 'succeeded',
          progress: 100,
          stage: '剪辑草稿已生成，等待用户接受',
          result: { timeline_draft_id: timelineDraft.id, project_revision: completed.revision, alternative_count: 0 },
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
        const persisted = await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          sources: project.sources.map(item => item.id === sourceId
            ? { ...item, fingerprint: sourceFact.fingerprint, missing: false, content_changed: false }
            : item),
          assets: project.assets.map(asset => asset.id === sourceId ? { ...asset, content_hash: sourceFact.fingerprint } : asset),
          evidence,
          evidence_revision: nextEvidenceRevision,
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

  private detectedCameraShotCuts(source: VideoFactSource & { fingerprint: `sha256:${string}` }, output: string): bigint[] {
    const rate = source.primary_video_stream.start_time.tick_rate
    const start = parseInt64(source.primary_video_stream.start_time.ticks)
    const end = start + parseInt64(source.presentation_duration.ticks)
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

    const thumbnailPath = join(directory, `${source.id}-${fingerprintToken}-thumbnail.jpg`)
    const midpoint = Math.max(0, Math.floor(source.presentation_duration.ticks === '0'
      ? 0
      : Number(parseInt64(source.presentation_duration.ticks) * 1000n * BigInt(source.presentation_duration.tick_rate.den) / BigInt(source.presentation_duration.tick_rate.num) / 2n)))
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
    const end = start + parseInt64(source.presentation_duration.ticks)
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

  private async movePublishedFile(source: string, destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    try {
      await rename(source, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await copyFile(source, destination)
      await rm(source, { force: true })
    }
  }

  private async failOperation(
    operation: VideoOperation,
    code:
      | 'MEDIA_VIDEO_SOURCE_UNREADABLE'
      | 'MEDIA_VIDEO_PROBE_INTERRUPTED'
      | 'MEDIA_VIDEO_ANALYSIS_INTERRUPTED'
      | 'MEDIA_VIDEO_PREVIEW_FAILED'
      | 'MEDIA_VIDEO_PREVIEW_CANCELLED'
      | 'MEDIA_VIDEO_PREVIEW_INTERRUPTED'
      | 'MEDIA_VIDEO_EXPORT_FAILED'
      | 'MEDIA_VIDEO_EXPORT_CANCELLED'
      | 'MEDIA_VIDEO_EXPORT_INTERRUPTED',
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

  async previewVideo(projectId: string, raw: PreviewVideoInput): Promise<VideoOperation> {
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
      await this.failOperation(operation, signal.aborted ? 'MEDIA_VIDEO_PREVIEW_CANCELLED' : 'MEDIA_VIDEO_PREVIEW_FAILED', signal.aborted ? '已取消' : '预览生成失败').catch(() => undefined)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      this.activePreviews.delete(operation.id)
    }
  }

  async renderVideo(projectId: string, raw: RenderVideoInput): Promise<VideoOperation> {
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
        await this.failOperation(operation, signal.aborted ? 'MEDIA_VIDEO_EXPORT_CANCELLED' : 'MEDIA_VIDEO_EXPORT_FAILED', signal.aborted ? '已取消' : '导出失败').catch(() => undefined)
        const latest = await this.project(project.id).catch(() => null)
        if (latest?.task_id === operation.id) {
          const failure = mediaSafeError(signal.aborted ? 'MEDIA_VIDEO_EXPORT_CANCELLED' : 'MEDIA_VIDEO_EXPORT_FAILED')
          await this.repository.saveProject(videoStudioProjectSchema.parse({
            ...latest,
            state: signal.aborted ? 'ready' : 'failed',
            error: failure.message,
            error_code: failure.code,
          })).catch(() => undefined)
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
      this.activeRenders.delete(operation.id)
    }
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
        : operation.kind === 'video.analyze' || operation.kind === 'video.plan'
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
      const cancelled = await this.failOperation(operation, 'MEDIA_VIDEO_EXPORT_CANCELLED', '已取消')
      const project = await this.project(operation.project_id).catch(() => null)
      if (project?.task_id === operation.id) {
        const failure = mediaSafeError('MEDIA_VIDEO_EXPORT_CANCELLED')
        await this.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          state: 'ready',
          error: failure.message,
          error_code: failure.code,
        }))
      }
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
    if (operation.kind === 'video.render' && await this.recoverCommittedRender(operation)) return
    const code = operation.kind === 'video.preview'
      ? 'MEDIA_VIDEO_PREVIEW_INTERRUPTED'
      : operation.kind === 'video.render'
        ? 'MEDIA_VIDEO_EXPORT_INTERRUPTED'
        : operation.kind === 'video.analyze' || operation.kind === 'video.plan'
          ? 'MEDIA_VIDEO_ANALYSIS_INTERRUPTED'
          : 'MEDIA_VIDEO_PROBE_INTERRUPTED'
    const stage = operation.kind === 'video.preview'
      ? '预览已中断'
      : operation.kind === 'video.render'
        ? '导出已中断'
        : operation.kind === 'video.analyze' || operation.kind === 'video.plan'
          ? '分析已中断'
          : '素材读取已中断'
    await this.failOperation(operation, code, stage)
    const temporary = operation.kind === 'video.preview'
      ? videoPreviewTaskResultSchema.safeParse(operation.result).data?.temporary_output
      : operation.kind === 'video.render'
        ? videoRenderTaskResultSchema.safeParse(operation.result).data?.temporary_output
        : undefined
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
    const project = await this.project(operation.project_id).catch(() => null)
    if (!project) return
    if (operation.kind === 'video.render' && project.task_id === operation.id) {
      const failure = mediaSafeError(code)
      await this.repository.saveProject(videoStudioProjectSchema.parse({ ...project, state: 'ready', error: failure.message, error_code: failure.code }))
    }
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
    const project = await this.project(operation.project_id).catch(() => null)
    if (!project || project.task_id !== operation.id) return false
    const info = await stat(result.data.output_path).catch(() => null)
    if (!info?.isFile() || info.size <= 0) return false
    const hash = await videoFingerprint(result.data.output_path).catch(() => null)
    if (hash !== result.data.output_content_hash || hash !== result.data.output_verification.content_hash) return false
    const terminalProject = await this.repository.saveProject(videoStudioProjectSchema.parse({
      ...project,
      state: 'complete',
      output_path: result.data.output_path,
      output_asset_id: result.data.output_asset_id,
      output_content_hash: result.data.output_content_hash,
      output_verification: result.data.output_verification,
      error: undefined,
      error_code: undefined,
    }))
    await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'succeeded',
      progress: 100,
      stage: '导出完成',
      result: { ...result.data, temporary_output: undefined },
      error: undefined,
      error_code: undefined,
    }))
    return terminalProject.state === 'complete'
  }
}
