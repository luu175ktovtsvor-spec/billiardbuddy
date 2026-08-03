import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  type VideoDerivative,
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
  gaps: string[]
  source_facts: Map<string, VideoFactSource>
  evidence_windows: Map<string, EvidenceWindow>
}

function id(prefix: 'vid' | 'src' | 'clip' | 'task' | 'timeline' | 'evidence' | 'alternative' | 'consent' | 'budget'): string {
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
      const visualFrames = input.purposes.includes('visual_evidence') ? Math.ceil(seconds / 5) : 0
      const asrSeconds = input.purposes.includes('asr') ? seconds : 0
      const estimate = {
        id: id('budget'),
        estimate_hash: factBasisHash({ project_id: project.id, purposes: [...input.purposes].sort(), source_ids: [...input.source_ids].sort(), seconds, visualFrames, asrSeconds }),
        state: 'estimated' as const,
        requests: (visualFrames ? 1 : 0) + (asrSeconds ? 1 : 0) + input.purposes.filter(purpose => ['planning', 'caption_translation', 'semantic_search'].includes(purpose)).length,
        total_tokens: Math.ceil(seconds * 8) + (input.purposes.includes('planning') ? 4_000 : 0),
        input_bytes: Math.ceil(seconds * 16_000),
        visual_frames: visualFrames,
        proxy_seconds: input.purposes.includes('visual_evidence') ? seconds : 0,
        asr_seconds: asrSeconds,
        estimated_amount_micros: Math.ceil(seconds * 120 + visualFrames * 250),
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
    await this.requireVideoProject(projectId)
    return await this.repository.searchFactsPage(projectId, query, options)
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

  private async extractVideoAnalysisInputs(
    project: VideoStudioProject,
    operationId: string,
    signal: AbortSignal,
  ): Promise<ExtractedVideoAnalysisInputs> {
    const directory = join(this.repository.paths().root, 'analysis', operationId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const frames: VideoAnalysisFrame[] = []
    const transcripts: VideoEvidence[] = []
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
        if (source.has_audio) gaps.push(`${source.name} 的新视频转写等待 Video Media Relay，未调用旧产品语音路径。`)
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
      return { frames, transcripts, gaps, source_facts: sourceFacts, evidence_windows: evidenceWindows }
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
        promptVersion: 'legacy-gateway-visual-v1',
        createdAt: this.iso(),
        confidence: evidence.confidence,
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
        result: { base_revision: project.revision, base_timeline_version_id: project.current_timeline_version_id },
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
      const extracted = await this.extractVideoAnalysisInputs(baseProject, analyzeTask.operation_id ?? analyzeTask.id, signal)
      await this.repository.saveOperation(this.operation({ ...analyzeTask, progress: 45, stage: '正在分析画面与语音证据' }))
      const retainedEvidenceIds = new Set(baseProject.timeline_versions
        .find(version => version.id === baseProject.current_timeline_version_id)
        ?.scenes.filter(scene => scene.locked).flatMap(scene => scene.evidence_ids) ?? [])
      const retained = baseProject.evidence.filter(item => item.kind === 'source_role' || retainedEvidenceIds.has(item.id))
      const draft = await analyzeVideoEvidence({
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
          result: { base_revision: evidenceProject.revision, base_timeline_version_id: evidenceProject.current_timeline_version_id, evidence_revision: revision },
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
      const active = this.activeAnalyses.get(analyzeTask.id)
      this.activeAnalyses.delete(analyzeTask.id)
      if (active) this.activeAnalyses.set(next.planTask.id, active)
      activeTask = next.planTask
      const currentScenes = next.project.timeline_versions.find(version => version.id === next.project.current_timeline_version_id)?.scenes ?? []
      const plan = await planVideoTimeline({
        sources: next.project.sources,
        evidence: next.evidence,
        currentScenes,
        userGoal,
        analysisGaps: next.gaps,
      }, {
        operationId: `${next.planTask.operation_id ?? next.planTask.id}-timeline`,
        signal,
        fetchImpl: this.fetchImpl,
        env: this.env,
        allowLegacyGateway: false,
      })
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
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof VideoAnalysisError && error.code === 'VIDEO_ANALYSIS_CANCELLED')
      const stale = error instanceof VideoWorkbenchServiceError && error.code === 'VIDEO_ANALYSIS_STALE'
      const failure = mediaSafeError(cancelled
        ? 'MEDIA_VIDEO_ANALYSIS_CANCELLED'
        : stale ? 'MEDIA_STATE_CONFLICT' : 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE')
      await this.repository.saveOperation(this.operation({
        ...activeTask,
        status: cancelled ? 'cancelled' : 'failed',
        progress: 0,
        stage: cancelled ? '已取消' : stale ? '方案已过期' : '视频分析失败',
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
    const orchestrator = new JobOrchestrator(
      async () => (await this.repository.listOperations())
        .filter(operation => ['queued', 'running', 'committing'].includes(operation.status)),
      async operation => await this.recoverInterruptedOperation(operation),
    )
    await orchestrator.recover()
  }

  private async recoverInterruptedOperation(operation: VideoOperation): Promise<void> {
    if (operation.kind === 'video.fingerprint') {
      const sourceId = typeof operation.result?.source_id === 'string' ? operation.result.source_id : null
      if (!sourceId) {
        await this.failOperation(operation, 'MEDIA_VIDEO_PROBE_INTERRUPTED', '完整指纹任务缺少素材标识')
        return
      }
      await this.runFullFingerprint(operation, sourceId)
      return
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
