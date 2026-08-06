import { randomUUID } from 'node:crypto'
import {
  createRemoteAnalysisConsentInputSchema,
  estimateRemoteAnalysisInputSchema,
  revokeRemoteAnalysisConsentInputSchema,
  videoStudioProjectSchema,
  type CreateRemoteAnalysisConsentInput,
  type EstimateRemoteAnalysisInput,
  type VideoStudioProject,
} from '../../../../shared/contracts/media.js'
import { factBasisHash, type VideoFactKind } from '../domain/mediaFacts/model.js'
import {
  estimatedTextAmountMicros,
  estimatedTextTokens,
  VIDEO_REMOTE_MODEL_BINDINGS,
  VIDEO_REMOTE_USAGE_POLICY,
  VIDEO_SEMANTIC_EMBEDDING_MODEL,
} from './remoteUsage.js'
import type { VideoProjectStore } from '../runtime/videoProjectStore.js'
import type {
  ActiveVideoExecutionHandle,
  AnalysisIndexCommandPort,
  VideoWorkbenchApplicationErrors,
} from '../runtime/videoWorkbenchApplicationPorts.js'

/** Process-local handles only. The durable Operation and Facts rows remain
 * the recovery authority after restart. */
export class VideoAnalysisOperationState {
  readonly activeAnalyses = new Map<string, ActiveVideoExecutionHandle>()
  readonly activeFingerprints = new Map<string, Promise<void>>()
}

/**
 * Owns source facts, remote-analysis scope, budget/consent and durable
 * analysis operations. Timeline and delivery writes stay outside this module.
 */
export class AnalysisIndex {
  constructor(
    private readonly commands: AnalysisIndexCommandPort,
    readonly projectStore: VideoProjectStore,
    readonly operationState: VideoAnalysisOperationState,
    private readonly errors: VideoWorkbenchApplicationErrors,
    private readonly now: () => Date,
  ) {}

  private async requireVideoProject(projectId: string): Promise<VideoStudioProject> {
    let project: VideoStudioProject
    try {
      project = await this.projectStore.repository.getProject(projectId)
    } catch (error) {
      return this.errors.rethrowRepository(error)
    }
    if (project.kind !== 'video') throw this.errors.create('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return project
  }

  async getWorkspaceSnapshotData(projectId: string, eventCursor: number) {
    const snapshot = await this.projectStore.repository.getWorkspaceSnapshot(projectId, eventCursor)
    if (snapshot.project.kind !== 'video') throw this.errors.create('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return snapshot
  }

  /** The persisted estimate is the only value an analysis consent may later
   * acknowledge. Its upper bounds are admission facts, never UI guesses. */
  async estimateRemoteAnalysis(projectId: string, raw: EstimateRemoteAnalysisInput) {
    return await this.projectStore.mutate(projectId, async () => {
      const input = estimateRemoteAnalysisInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const selected = project.sources.filter(source => input.source_ids.includes(source.id))
      if (selected.length !== input.source_ids.length) throw this.errors.create('预算估算引用了不存在的素材', 404, 'VIDEO_SOURCE_NOT_FOUND')
      const seconds = selected.reduce((total, source) => total + source.duration_ms / 1000, 0)
      const asrRequests = input.purposes.includes('asr') ? selected.length : 0
      const visualFrames = input.purposes.includes('visual_evidence') ? Math.ceil(seconds / 5) : 0
      const asrSeconds = input.purposes.includes('asr') ? seconds : 0
      const captionInputTokens = input.purposes.includes('caption_translation')
        ? Math.max(4_000, Math.ceil(seconds * 200))
        : 0
      const selectedSourceIds = new Set(input.source_ids)
      const planningEvidence = input.purposes.includes('planning')
        ? project.evidence.filter(item => selectedSourceIds.has(item.source_id)).slice(0, 1_998)
        : []
      const planningBody = input.purposes.includes('planning')
          ? JSON.stringify({
            sources: selected.map(source => ({ id: source.id, name: source.name, fingerprint: source.fingerprint, duration_ms: source.duration_ms, width: source.width, height: source.height, fps: source.fps, rotation: source.rotation, has_audio: source.has_audio })),
            evidence: planningEvidence.map(item => ({ id: item.id, kind: item.kind, source_id: item.source_id, in_ms: item.in_ms, out_ms: item.out_ms, text: item.text, confidence: item.confidence })),
            current_scenes: [],
            user_goal: '',
            analysis_gaps: [],
            creation_brief: project.creation_brief ?? null,
            delivery_intent: project.delivery_intent ?? null,
          })
        : ''
      const planningInputTokens = planningBody
        ? estimatedTextTokens(planningBody) + VIDEO_REMOTE_USAGE_POLICY.planningContextTokenReserve + VIDEO_REMOTE_USAGE_POLICY.planningOutputTokenReserve
        : 0
      let semanticDocumentRequests = 0
      let semanticDocumentTokens = 0
      let semanticDocumentBytes = 0
      if (input.purposes.includes('semantic_search')) {
        const candidates = (await this.projectStore.repository.listCurrentSearchCandidates(project.id))
          .filter(item => item.kind === 'transcript' && selectedSourceIds.has(item.source_id))
          .slice(0, VIDEO_REMOTE_USAGE_POLICY.semanticDocumentMaxItems)
        semanticDocumentRequests = Math.ceil(candidates.length / VIDEO_REMOTE_USAGE_POLICY.semanticDocumentBatchSize)
        semanticDocumentTokens = candidates.reduce((sum, item) => sum + estimatedTextTokens(item.text), 0)
        semanticDocumentBytes = Buffer.byteLength(JSON.stringify({ model: VIDEO_SEMANTIC_EMBEDDING_MODEL, input: candidates.map(item => item.text), dimensions: 768 }), 'utf8')
      }
      const semanticQueryText = 'x'.repeat(1_000)
      const semanticQueryTokens = input.purposes.includes('semantic_search')
        ? Math.max(VIDEO_REMOTE_USAGE_POLICY.semanticQueryTokenReserve, estimatedTextTokens(semanticQueryText))
        : 0
      const semanticQueryBytes = input.purposes.includes('semantic_search')
        ? Buffer.byteLength(JSON.stringify({ model: VIDEO_SEMANTIC_EMBEDDING_MODEL, input: [semanticQueryText], dimensions: 768 }), 'utf8')
        : 0
      const captionTranslationTokens = input.purposes.includes('caption_translation')
        ? captionInputTokens + VIDEO_REMOTE_USAGE_POLICY.captionTranslationOutputTokenReserve
        : 0
      const totalTokens = planningInputTokens
        + captionTranslationTokens
        + semanticDocumentTokens
        + semanticQueryTokens
        + visualFrames * VIDEO_REMOTE_USAGE_POLICY.visualOutputTokenReserve
      const inputBytes = Math.ceil(asrSeconds * 32_000)
        + asrRequests * 44
        + visualFrames * 10 * 1024 * 1024
        + (planningBody ? Buffer.byteLength(planningBody, 'utf8') : 0)
        + (input.purposes.includes('caption_translation') ? captionInputTokens * 4 : 0)
        + semanticDocumentBytes
        + semanticQueryBytes
        + (visualFrames + asrRequests + (input.purposes.includes('planning') ? 1 : 0) + (input.purposes.includes('caption_translation') ? 1 : 0) + (input.purposes.includes('semantic_search') ? semanticDocumentRequests + 1 : 0)) * VIDEO_REMOTE_USAGE_POLICY.requestOverheadBytes
      const createdAt = this.now().toISOString()
      const estimate = {
        id: `budget_${randomUUID().replaceAll('-', '')}`,
        estimate_hash: factBasisHash({
          project_id: project.id,
          usage_policy_revision: VIDEO_REMOTE_USAGE_POLICY.revision,
          model_bindings: VIDEO_REMOTE_MODEL_BINDINGS,
          purposes: [...input.purposes].sort(),
          source_basis: selected.map(source => ({ id: source.id, fingerprint: source.fingerprint ?? null, duration_ms: source.duration_ms, width: source.width, height: source.height, fps: source.fps ?? null, has_audio: source.has_audio })).sort((left, right) => left.id.localeCompare(right.id)),
          evidence_revision: project.evidence_revision ?? null,
          creation_brief_revision: project.creation_brief?.revision ?? null,
          delivery_intent_revision: project.delivery_intent?.revision ?? null,
          seconds,
          visualFrames,
          asrSeconds,
          inputBytes,
        }),
        estimate_scope: {
          purposes: [...input.purposes],
          source_ids: [...input.source_ids],
          usage_policy_revision: VIDEO_REMOTE_USAGE_POLICY.revision,
          model_bindings: VIDEO_REMOTE_MODEL_BINDINGS,
        },
        state: 'estimated' as const,
        requests: visualFrames + asrRequests
          + (input.purposes.includes('planning') ? 1 : 0)
          + (input.purposes.includes('caption_translation') ? 1 : 0)
          + (input.purposes.includes('semantic_search') ? semanticDocumentRequests + 1 : 0),
        total_tokens: totalTokens,
        input_bytes: inputBytes,
        visual_frames: visualFrames,
        proxy_seconds: input.purposes.includes('visual_evidence') ? seconds : 0,
        asr_seconds: asrSeconds,
        estimated_amount_micros: Math.max(1, Math.ceil(asrSeconds * VIDEO_REMOTE_USAGE_POLICY.asrSecondMicros + visualFrames * VIDEO_REMOTE_USAGE_POLICY.visualFrameMicros + totalTokens * VIDEO_REMOTE_USAGE_POLICY.textTokenMicros + (input.purposes.includes('caption_translation') ? VIDEO_REMOTE_USAGE_POLICY.captionTranslationFixedMicros : 0))),
        created_at: createdAt,
        updated_at: createdAt,
      }
      await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        remote_analysis_budgets: [...project.remote_analysis_budgets, estimate],
      }))
      return estimate
    })
  }

  async grantRemoteAnalysisConsent(projectId: string, raw: CreateRemoteAnalysisConsentInput) {
    return await this.projectStore.mutate(projectId, async () => {
      const input = createRemoteAnalysisConsentInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const estimate = project.remote_analysis_budgets.find(item => item.estimate_hash === input.acknowledged_estimate_hash && item.state === 'estimated')
      if (!estimate) throw this.errors.create('远程分析同意必须确认当前项目的预算估算', 409, 'VIDEO_REMOTE_ESTIMATE_REQUIRED')
      const estimateScope = estimate.estimate_scope
      if (
        !estimateScope
        || estimateScope.usage_policy_revision !== VIDEO_REMOTE_USAGE_POLICY.revision
        || JSON.stringify(estimateScope.model_bindings) !== JSON.stringify(VIDEO_REMOTE_MODEL_BINDINGS)
      ) throw this.errors.create('远程分析预算已过期，请重新估算后再授权', 409, 'VIDEO_REMOTE_ESTIMATE_REQUIRED')
      const estimatedPurposes = new Set(estimateScope.purposes)
      if (input.purposes.some(purpose => !estimatedPurposes.has(purpose))) {
        throw this.errors.create('授权用途超出已确认的远程分析预算', 422, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
      }
      const estimatedSources = new Set(estimateScope.source_ids)
      if (input.coverage.some(coverage => !estimatedSources.has(coverage.source_id))) {
        throw this.errors.create('授权素材超出已确认的远程分析预算', 422, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
      }
      const requiredDataKinds: Record<typeof input.purposes[number], readonly string[]> = {
        visual_evidence: ['keyframes'],
        planning: ['transcript', 'keyframes'],
        caption_translation: ['transcript'],
        asr: ['audio_extract'],
        semantic_search: ['transcript'],
      }
      for (const purpose of input.purposes) {
        if (!requiredDataKinds[purpose].some(kind => input.data_kinds.includes(kind as typeof input.data_kinds[number]))) {
          throw this.errors.create('授权数据类型与远程分析用途不匹配', 422, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
        }
      }
      for (const coverage of input.coverage) {
        const source = project.sources.find(candidate => candidate.id === coverage.source_id)
        if (!source || coverage.ranges.some(range => Number(range.start.ticks) < 0 || Number(range.duration.ticks) <= 0)) {
          throw this.errors.create('远程分析范围无效', 422, 'VIDEO_REMOTE_CONSENT_SCOPE_INVALID')
        }
      }
      const createdAt = this.now().toISOString()
      const consent = {
        id: `consent_${randomUUID().replaceAll('-', '')}`,
        project_id: project.id,
        revision: Math.max(0, ...project.remote_analysis_consents.map(item => item.revision)) + 1,
        state: 'active' as const,
        provider: 'aliyun_bailian' as const,
        region: 'cn-beijing' as const,
        purposes: input.purposes,
        data_kinds: input.data_kinds,
        coverage: input.coverage,
        acknowledged_estimate_hash: input.acknowledged_estimate_hash,
        granted_by_actor_id: input.granted_by_actor_id ?? 'local_workbench',
        granted_at: createdAt,
      }
      const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        remote_analysis_consents: [...project.remote_analysis_consents.map(item => item.state === 'active' ? { ...item, state: 'revoked' as const, revoked_at: createdAt } : item), consent],
        remote_analysis_budgets: project.remote_analysis_budgets.map(item => item.id === estimate.id ? { ...item, state: 'reserved' as const, updated_at: createdAt } : item),
      }))
      return { project: saved, consent }
    })
  }

  async revokeRemoteAnalysisConsent(projectId: string, raw: { revision: number }) {
    return await this.projectStore.mutate(projectId, async () => {
      const input = revokeRemoteAnalysisConsentInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const current = project.remote_analysis_consents.find(item => item.revision === input.revision)
      if (!current) throw this.errors.create('远程分析同意不存在', 404, 'VIDEO_REMOTE_CONSENT_NOT_FOUND')
      if (current.state === 'revoked') return project
      const revokedAt = this.now().toISOString()
      return await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        remote_analysis_consents: project.remote_analysis_consents.map(item => item.id === current.id ? { ...item, state: 'revoked' as const, revoked_at: revokedAt } : item),
      }))
    })
  }

  async pageMediaFacts(projectId: string, kind: VideoFactKind, options?: { sourceId?: string; cursor?: string; limit?: number }) {
    await this.requireVideoProject(projectId)
    return await this.projectStore.repository.pageCurrentFacts(kind, projectId, options)
  }

  readonly searchMediaFacts = (...args: Parameters<AnalysisIndexCommandPort['searchMediaFacts']>) => this.commands.searchMediaFacts(...args)

  async reclaimDerivativeCache(projectId: string, maxEvictions: number): Promise<string[]> {
    await this.requireVideoProject(projectId)
    return await this.projectStore.repository.reclaimLeastRecentlyUsedDerivatives(projectId, maxEvictions)
  }

  async waitForOperationEvents(projectId: string, cursor: number, limit: number, waitMs: number) {
    const page = await this.projectStore.repository.listOperationEvents(projectId, cursor, limit)
    if (page.events.length || page.reset_required || waitMs <= 0) return page
    await this.projectStore.repository.waitForOperationEvent(projectId, cursor, waitMs)
    return await this.projectStore.repository.listOperationEvents(projectId, cursor, limit)
  }

  readonly analyzeVideoProject = (...args: Parameters<AnalysisIndexCommandPort['analyzeVideoProject']>) => this.commands.analyzeVideoProject(...args)
  readonly analyzeVideoBeat = (...args: Parameters<AnalysisIndexCommandPort['analyzeVideoBeat']>) => this.commands.analyzeVideoBeat(...args)
  readonly createBeatSyncTimelineDraft = (...args: Parameters<AnalysisIndexCommandPort['createBeatSyncTimelineDraft']>) => this.commands.createBeatSyncTimelineDraft(...args)
  readonly analyzeVideoSubjectTrack = (...args: Parameters<AnalysisIndexCommandPort['analyzeVideoSubjectTrack']>) => this.commands.analyzeVideoSubjectTrack(...args)
}
