import { randomUUID } from 'node:crypto'
import {
  acceptTimelineDraftInputSchema,
  applyEditorialTimelineCommandsInputSchema,
  applyVideoAlternativeInputSchema,
  createVideoApprovalDecisionInputSchema,
  createVideoReviewNoteInputSchema,
  lockVideoSceneInputSchema,
  resolveVideoReviewNoteInputSchema,
  selectVideoTimelineVersionInputSchema,
  timelineCommandSetSchema,
  updateVideoTimelineInputSchema,
  videoStudioProjectSchema,
  type AcceptTimelineDraftInput,
  type ApplyEditorialTimelineCommandsInput,
  type ApplyVideoAlternativeInput,
  type CreateVideoApprovalDecisionInput,
  type CreateVideoReviewNoteInput,
  type EditorialTimelineCommand,
  type EditorialTimelineVersion,
  type LockVideoSceneInput,
  type ResolveVideoReviewNoteInput,
  type SelectVideoTimelineVersionInput,
  type VideoApprovalDecision,
  type VideoReviewAnchor,
  type VideoReviewNote,
  type VideoStudioProject,
  type VideoTimelineItem,
  type UpdateVideoTimelineInput,
  type TimelineDraft,
} from '../../../../shared/contracts/media.js'
import { factBasisHash } from '../domain/mediaFacts/model.js'
import { compareRationalTime, endOfRange, rationalTime, sourceTimeRange, tickRateForTimeBase, type SourceTimeRange } from '../domain/mediaFacts/time.js'
import { materializeVideoReviewNotes, nextVideoReviewEventSequence } from '../domain/editorial/review.js'
import { EditorialValidationError, editorialFactsBasisHash, type EditorialApplication, type EditorialSourceTiming } from '../domain/editorial/editorialApplication.js'
import type { VideoProjectStore } from '../runtime/videoProjectStore.js'
import type { EditorialCommandPort, VideoWorkbenchApplicationErrors } from '../runtime/videoWorkbenchApplicationPorts.js'

function id(prefix: 'review_note' | 'review_resolution' | 'approval'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function sourceRangeCoveredBy(coverage: readonly SourceTimeRange[], target: SourceTimeRange): boolean {
  const targetEnd = endOfRange(target)
  const ordered = [...coverage].sort((left, right) => compareRationalTime(left.start, right.start))
  let cursor = target.start
  for (const range of ordered) {
    if (compareRationalTime(endOfRange(range), cursor) <= 0) continue
    if (compareRationalTime(range.start, cursor) > 0) return false
    const end = endOfRange(range)
    if (compareRationalTime(end, cursor) > 0) cursor = end
    if (compareRationalTime(cursor, targetEnd) >= 0) return true
  }
  return compareRationalTime(cursor, targetEnd) >= 0
}

/**
 * Owns the CommandSet-only editorial version chain and versioned review
 * history. Legacy endpoints reach the same application so they cannot create
 * an alternate Timeline writer. Review resolutions and approval decisions are
 * immutable append-only facts; this class never edits a Timeline or Variant.
 */
export class Editorial {
  constructor(
    private readonly commands: EditorialCommandPort,
    readonly projectStore: VideoProjectStore,
    readonly rules: EditorialApplication,
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

  private mutationReplay(
    project: VideoStudioProject,
    kind: VideoStudioProject['editorial_mutation_receipts'][number]['kind'],
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
  ): string[] | null {
    const receipt = project.editorial_mutation_receipts.find(item => item.kind === kind && item.idempotency_key === idempotencyKey)
    if (!receipt) return null
    if (receipt.request_hash !== requestHash) {
      throw this.errors.create('同一幂等键不能提交不同的编辑请求', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
    }
    return [...receipt.resource_ids]
  }

  private mutationReceipt(
    kind: VideoStudioProject['editorial_mutation_receipts'][number]['kind'],
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
    resourceIds: string[],
    createdAt: string,
  ): VideoStudioProject['editorial_mutation_receipts'][number] {
    return { kind, idempotency_key: idempotencyKey, request_hash: requestHash, resource_ids: resourceIds, created_at: createdAt }
  }

  private editorialError(error: unknown): never {
    if (error instanceof EditorialValidationError) {
      const status = error.code === 'VIDEO_EDITORIAL_STALE'
        || error.code === 'VIDEO_EDITORIAL_LOCKED'
        || error.code === 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT'
        || error.code === 'VIDEO_SOURCE_FINGERPRINT_PENDING'
        ? 409
        : 400
      throw this.errors.create(error.message, status, error.code)
    }
    throw error
  }

  private async editorialTimings(project: VideoStudioProject): Promise<Map<string, EditorialSourceTiming>> {
    const timings = new Map<string, EditorialSourceTiming>()
    for (const source of project.sources) {
      const fact = await this.projectStore.repository.getFact('source', source.id).catch(() => null)
      if (!fact || !('fast_identity' in fact)) continue
      timings.set(source.id, {
        tick_rate: tickRateForTimeBase(fact.primary_video_stream.time_base),
        start_ticks: fact.primary_video_stream.start_time.ticks,
      })
    }
    return timings
  }

  private sameLegacyProjectionItem(current: VideoTimelineItem, desired: VideoTimelineItem): boolean {
    return current.legacy_scene_id === desired.legacy_scene_id
      && current.kind === desired.kind
      && current.track_id === desired.track_id
      && JSON.stringify(current.timeline_range) === JSON.stringify(desired.timeline_range)
      && JSON.stringify(current.binding) === JSON.stringify(desired.binding)
  }

  /** Legacy projections are read-compatible inputs only. The resulting state
   * transition is one CommandSet, which preserves locked items and tracks. */
  private legacyProjectionCommandSet(
    project: VideoStudioProject,
    desired: VideoTimelineItem[],
    idempotencyKey: string,
  ) {
    const current = this.rules.currentTimeline(project)
    const lockedTrackIds = new Set(current.tracks.filter(track => track.locked).map(track => track.id))
    const locked = current.items.filter(item => item.locked || lockedTrackIds.has(item.track_id))
    const retainedDesiredIds = new Set<string>()
    for (const lockedItem of locked) {
      const match = desired.find(candidate => this.sameLegacyProjectionItem(lockedItem, candidate))
      if (!match) throw this.errors.create('备选时间线不能覆盖锁定场景', 409, 'VIDEO_LOCKED_SCENE_CONFLICT')
      retainedDesiredIds.add(match.id)
    }
    const deletable = current.items.filter(item => !item.locked && !lockedTrackIds.has(item.track_id))
    const commands: EditorialTimelineCommand[] = [
      ...(deletable.length ? [{ kind: 'ripple_delete' as const, item_ids: deletable.map(item => item.id), close_gap: false }] : []),
      ...desired.filter(item => !retainedDesiredIds.has(item.id)).map(item => ({ kind: 'insert' as const, track_id: item.track_id, item })),
    ]
    if (!commands.length) {
      const track = current.tracks[0]
      if (!track) throw this.errors.create('编辑时间线轨道不存在', 409, 'VIDEO_TIMELINE_MISSING')
      commands.push({ kind: 'set_track_state', track_id: track.id, locked: track.locked })
    }
    return timelineCommandSetSchema.parse({
      id: `command_${randomUUID().replaceAll('-', '')}`,
      project_id: project.id,
      actor_id: 'local_workbench',
      idempotency_key: idempotencyKey,
      created_at: this.now().toISOString(),
      target: { kind: 'editorial', base_timeline_version_id: current.id },
      commands,
    })
  }

  private async isBeatSyncDraftCurrent(project: VideoStudioProject, draft: TimelineDraft): Promise<boolean> {
    const beatSync = draft.beat_sync
    if (!beatSync) return true
    const source = project.sources.find(candidate => candidate.id === beatSync.source_id)
    if (!source || source.fingerprint !== beatSync.source_fingerprint || source.missing || source.content_changed) return false
    const evidence = await this.projectStore.repository.getFact('evidence', beatSync.evidence_id).catch(() => null)
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

  private assertReviewAnchor(project: VideoStudioProject, timelineVersionId: string, anchor: VideoReviewAnchor): void {
    const timeline = project.editorial_timeline_versions.find(item => item.id === timelineVersionId)
    if (!timeline) throw this.errors.create('Review Note 的时间线版本不存在', 404, 'VIDEO_REVIEW_TIMELINE_NOT_FOUND')
    const item = (itemId: string) => timeline.items.find(candidate => candidate.id === itemId)
    if (anchor.kind === 'timeline_range') {
      if (anchor.editorial_timeline_version_id !== timelineVersionId || !timeline.items.length) {
        throw this.errors.create('Review Note 必须锚定目标时间线的实际内容', 400, 'VIDEO_REVIEW_ANCHOR_INVALID')
      }
      const zero = rationalTime(0n, anchor.range.start.tick_rate)
      const timelineEnd = timeline.items.reduce((latest, candidate) => {
        const end = endOfRange(candidate.timeline_range)
        return compareRationalTime(end, latest) > 0 ? end : latest
      }, zero)
      if (compareRationalTime(anchor.range.start, zero) < 0 || compareRationalTime(endOfRange(anchor.range), timelineEnd) > 0) {
        throw this.errors.create('Review Note 时间锚点超出冻结时间线范围', 400, 'VIDEO_REVIEW_ANCHOR_INVALID')
      }
      return
    }
    if (anchor.kind === 'timeline_item') {
      if (anchor.editorial_timeline_version_id !== timelineVersionId || !item(anchor.item_id)) {
        throw this.errors.create('Review Note 锚定的时间线条目不存在', 400, 'VIDEO_REVIEW_ANCHOR_INVALID')
      }
      return
    }
    const variant = project.delivery_variant_versions.find(candidate => candidate.id === anchor.variant_version_id)
    if (!variant || variant.editorial_timeline_version_id !== timelineVersionId || !item(anchor.item_id)) {
      throw this.errors.create('Review Note 的交付变体或时间锚点不属于目标时间线版本', 400, 'VIDEO_REVIEW_ANCHOR_INVALID')
    }
  }

  async getReviewNotes(projectId: string, timelineVersionId: string): Promise<VideoReviewNote[]> {
    const project = await this.requireVideoProject(projectId)
    if (!project.editorial_timeline_versions.some(item => item.id === timelineVersionId)) {
      throw this.errors.create('Review Note 的时间线版本不存在', 404, 'VIDEO_REVIEW_TIMELINE_NOT_FOUND')
    }
    return materializeVideoReviewNotes(project).filter(note => note.timeline_version_id === timelineVersionId)
  }

  async createReviewNote(
    projectId: string,
    timelineVersionId: string,
    raw: CreateVideoReviewNoteInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; note: VideoReviewNote; reused: boolean }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = createVideoReviewNoteInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const requestHash = factBasisHash({ kind: 'review_note', timeline_version_id: timelineVersionId, input })
      const replay = this.mutationReplay(project, 'review_note', idempotencyKey, requestHash)
      if (replay) {
        const note = materializeVideoReviewNotes(project).find(item => item.id === replay[0])
        if (!note) throw this.errors.create('Review Note 幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, note, reused: true }
      }
      this.assertReviewAnchor(project, timelineVersionId, input.anchor)
      const createdAt = this.now().toISOString()
      const note: VideoReviewNote = {
        id: id('review_note'), project_id: project.id, timeline_version_id: timelineVersionId,
        anchor: input.anchor, body: input.body, status: 'open', actor_id: input.actor_id,
        event_sequence: nextVideoReviewEventSequence(project), created_at: createdAt,
      }
      const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        review_notes: [...project.review_notes, note],
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.mutationReceipt('review_note', idempotencyKey, requestHash, [note.id], createdAt)],
        revision: project.revision + 1,
        updated_at: createdAt,
      }))
      return { project: saved, note, reused: false }
    })
  }

  async resolveReviewNote(
    projectId: string,
    timelineVersionId: string,
    reviewNoteId: string,
    raw: ResolveVideoReviewNoteInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; note: VideoReviewNote; reused: boolean }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = resolveVideoReviewNoteInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      const note = materializeVideoReviewNotes(project).find(item => item.id === reviewNoteId && item.timeline_version_id === timelineVersionId)
      if (!note) throw this.errors.create('Review Note 不存在', 404, 'VIDEO_REVIEW_NOTE_NOT_FOUND')
      const requestHash = factBasisHash({ kind: 'review_resolution', timeline_version_id: timelineVersionId, review_note_id: reviewNoteId, input })
      const replay = this.mutationReplay(project, 'review_resolution', idempotencyKey, requestHash)
      if (replay) {
        const persisted = materializeVideoReviewNotes(project).find(item => item.id === reviewNoteId)
        if (!persisted) throw this.errors.create('Review Resolution 幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, note: persisted, reused: true }
      }
      if (note.status !== 'open') throw this.errors.create('Review Note 已有最终处理结果', 409, 'VIDEO_REVIEW_NOTE_FINAL')
      if (input.resolution_proposal_id && !project.creative_proposals.some(item => item.id === input.resolution_proposal_id)) {
        throw this.errors.create('Review Resolution 引用了不存在的 Proposal', 400, 'VIDEO_REVIEW_RESOLUTION_INVALID')
      }
      if (input.resolved_by_timeline_version_id && (
        input.resolved_by_timeline_version_id === timelineVersionId
        || !project.editorial_timeline_versions.some(item => item.id === input.resolved_by_timeline_version_id)
      )) {
        throw this.errors.create('Review Resolution 必须引用新的有效时间线版本', 400, 'VIDEO_REVIEW_RESOLUTION_INVALID')
      }
      if (input.resolved_by_variant_version_id) {
        const variant = project.delivery_variant_versions.find(item => item.id === input.resolved_by_variant_version_id)
        if (!variant || variant.editorial_timeline_version_id !== timelineVersionId) {
          throw this.errors.create('Review Resolution 引用了不匹配的交付变体版本', 400, 'VIDEO_REVIEW_RESOLUTION_INVALID')
        }
      }
      const createdAt = this.now().toISOString()
      const resolution = {
        id: id('review_resolution'), project_id: project.id, review_note_id: note.id,
        state: input.state, actor_id: input.actor_id, event_sequence: nextVideoReviewEventSequence(project),
        ...(input.resolution_proposal_id ? { resolution_proposal_id: input.resolution_proposal_id } : {}),
        ...(input.resolved_by_timeline_version_id ? { resolved_by_timeline_version_id: input.resolved_by_timeline_version_id } : {}),
        ...(input.resolved_by_variant_version_id ? { resolved_by_variant_version_id: input.resolved_by_variant_version_id } : {}),
        created_at: createdAt,
      }
      const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        review_resolutions: [...project.review_resolutions, resolution],
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.mutationReceipt('review_resolution', idempotencyKey, requestHash, [resolution.id], createdAt)],
        revision: project.revision + 1,
        updated_at: createdAt,
      }))
      const resolved = materializeVideoReviewNotes(saved).find(item => item.id === note.id)
      if (!resolved) throw this.errors.create('Review Resolution 保存后缺失', 409, 'VIDEO_EDITORIAL_INVALID')
      return { project: saved, note: resolved, reused: false }
    })
  }

  async createApprovalDecision(
    projectId: string,
    timelineVersionId: string,
    raw: CreateVideoApprovalDecisionInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; decision: VideoApprovalDecision; reused: boolean }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = createVideoApprovalDecisionInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      if (!project.editorial_timeline_versions.some(item => item.id === timelineVersionId)) {
        throw this.errors.create('审批的时间线版本不存在', 404, 'VIDEO_REVIEW_TIMELINE_NOT_FOUND')
      }
      const requestHash = factBasisHash({ kind: 'approval_decision', timeline_version_id: timelineVersionId, input })
      const replay = this.mutationReplay(project, 'approval_decision', idempotencyKey, requestHash)
      if (replay) {
        const decision = project.approval_decisions.find(item => item.id === replay[0])
        if (!decision) throw this.errors.create('审批幂等记录已损坏', 409, 'VIDEO_EDITORIAL_INVALID')
        return { project, decision, reused: true }
      }
      const notes = materializeVideoReviewNotes(project)
      if (input.state === 'changes_requested' && input.note_ids.length === 0) {
        throw this.errors.create('请求修改必须关联至少一条 Review Note', 400, 'VIDEO_REVIEW_APPROVAL_INVALID')
      }
      const attached = input.note_ids.map(noteId => notes.find(item => item.id === noteId && item.timeline_version_id === timelineVersionId))
      if (attached.some(note => !note) || (input.state === 'changes_requested' && attached.some(note => note?.status !== 'open'))) {
        throw this.errors.create('审批引用了不属于目标版本或已处理的 Review Note', 400, 'VIDEO_REVIEW_APPROVAL_INVALID')
      }
      const createdAt = this.now().toISOString()
      const decision: VideoApprovalDecision = {
        id: id('approval'), project_id: project.id, timeline_version_id: timelineVersionId,
        state: input.state, actor_id: input.actor_id, event_sequence: nextVideoReviewEventSequence(project),
        note_ids: input.note_ids, created_at: createdAt,
      }
      const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
        ...project,
        approval_decisions: [...project.approval_decisions, decision],
        editorial_mutation_receipts: [...project.editorial_mutation_receipts, this.mutationReceipt('approval_decision', idempotencyKey, requestHash, [decision.id], createdAt)],
        revision: project.revision + 1,
        updated_at: createdAt,
      }))
      return { project: saved, decision, reused: false }
    })
  }

  async getEditorialTimeline(projectId: string, versionId: string): Promise<EditorialTimelineVersion> {
    const project = await this.commands.prepareEditorialProject(projectId)
    const version = project.editorial_timeline_versions.find(candidate => candidate.id === versionId)
    if (!version) throw this.errors.create('编辑时间线版本不存在', 404, 'VIDEO_TIMELINE_MISSING')
    return version
  }

  async getTimelineDraft(projectId: string, draftId: string): Promise<TimelineDraft> {
    const project = await this.commands.prepareEditorialProject(projectId)
    const draft = project.timeline_drafts.find(candidate => candidate.id === draftId)
    if (!draft) throw this.errors.create('时间线草稿不存在', 404, 'VIDEO_TIMELINE_DRAFT_NOT_FOUND')
    return draft
  }

  /** The only formal Timeline mutation path. Every accepted change becomes a
   * new immutable CommandSet version through the shared SQLite coordinator. */
  async applyEditorialTimelineCommands(
    projectId: string,
    raw: ApplyEditorialTimelineCommandsInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; version: EditorialTimelineVersion; reused: boolean }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = applyEditorialTimelineCommandsInputSchema.parse(raw)
      const project = await this.commands.prepareEditorialProject(projectId)
      try {
        const commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: 'local_workbench',
          idempotency_key: idempotencyKey,
          created_at: this.now().toISOString(),
          target: { kind: 'editorial', base_timeline_version_id: input.base_timeline_version_id },
          commands: input.commands,
        })
        const applied = this.rules.applyCommandSet(project, commandSet, await this.commands.editorialSourceBounds(project))
        const saved = applied.reused ? project : await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse(applied.project))
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
    return await this.projectStore.mutate(projectId, async () => {
      const input = acceptTimelineDraftInputSchema.parse(raw)
      let project = await this.commands.prepareEditorialProject(projectId)
      const draft = project.timeline_drafts.find(candidate => candidate.id === draftId)
      if (!draft) throw this.errors.create('时间线草稿不存在', 404, 'VIDEO_TIMELINE_DRAFT_NOT_FOUND')
      const current = this.rules.currentTimeline(project)
      if (draft.status === 'accepted' && draft.accepted_command_set_id) {
        const receipt = project.editorial_command_receipts.find(candidate => candidate.command_set_id === draft.accepted_command_set_id && candidate.idempotency_key === idempotencyKey)
        const version = receipt && project.editorial_timeline_versions.find(candidate => candidate.id === receipt.created_version_id)
        if (version) return { project, version, reused: true }
      }
      if (!await this.isBeatSyncDraftCurrent(project, draft)) {
        if (draft.status === 'proposed') {
          project = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
            ...project,
            timeline_drafts: project.timeline_drafts.map(candidate => candidate.id === draft.id ? { ...candidate, status: 'stale' } : candidate),
            revision: project.revision + 1,
            updated_at: this.now().toISOString(),
          }))
        }
        throw this.errors.create('节拍证据或素材已经变化，请重新生成 Beat Sync 草稿', 409, 'VIDEO_EDITORIAL_STALE')
      }
      if (
        draft.status !== 'proposed'
        || draft.facts_basis_hash !== editorialFactsBasisHash(project)
        || draft.base_timeline_version_id !== current.id
        || (input.base_timeline_version_id && input.base_timeline_version_id !== current.id)
      ) {
        if (draft.status === 'proposed' && draft.facts_basis_hash !== editorialFactsBasisHash(project)) {
          project = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
            ...project,
            timeline_drafts: project.timeline_drafts.map(candidate => candidate.id === draft.id ? { ...candidate, status: 'stale' } : candidate),
          }))
        }
        throw this.errors.create('时间线草稿已经过期，请重新生成', 409, 'VIDEO_EDITORIAL_STALE')
      }
      if (JSON.stringify(draft.tracks) !== JSON.stringify(current.tracks)) {
        throw this.errors.create('时间线草稿的轨道结构已变化，请重新生成', 409, 'VIDEO_EDITORIAL_STALE')
      }
      try {
        const commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: 'local_workbench',
          idempotency_key: idempotencyKey,
          created_at: this.now().toISOString(),
          target: { kind: 'editorial', base_timeline_version_id: current.id },
          commands: [
            ...(current.items.length ? [{ kind: 'ripple_delete' as const, item_ids: current.items.map(item => item.id), close_gap: false }] : []),
            ...draft.items.map(item => ({ kind: 'insert' as const, track_id: item.track_id, item })),
          ],
        })
        const applied = this.rules.applyCommandSet(project, commandSet, await this.commands.editorialSourceBounds(project))
        const next = applied.reused ? project : {
          ...applied.project,
          timeline_drafts: applied.project.timeline_drafts.map(candidate => candidate.id === draft.id
            ? { ...candidate, status: 'accepted', accepted_command_set_id: commandSet.id }
            : candidate),
        }
        const saved = applied.reused ? project : await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse(next))
        return { project: saved, version: applied.version as EditorialTimelineVersion, reused: applied.reused }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async updateTimeline(projectId: string, raw: UpdateVideoTimelineInput): Promise<VideoStudioProject> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = updateVideoTimelineInputSchema.parse(raw)
      const project = await this.commands.prepareEditorialProject(projectId)
      try {
        if (project.state === 'rendering') throw this.errors.create('正在导出，暂时不能修改时间线', 409, 'VIDEO_RENDER_ACTIVE')
        if (project.revision !== input.base_revision) throw this.errors.create('视频项目已更新，请刷新后再编辑', 409, 'VIDEO_REVISION_CONFLICT')
        const current = this.rules.currentTimeline(project)
        const baseVersionId = input.base_timeline_version_id
        if (baseVersionId && baseVersionId !== current.id && baseVersionId !== project.current_timeline_version_id) {
          throw this.errors.create('视频时间线已更新，请刷新后再编辑', 409, 'VIDEO_TIMELINE_CONFLICT')
        }
        const [timing, sourceBounds] = await Promise.all([this.editorialTimings(project), this.commands.editorialSourceBounds(project)])
        const items = this.rules.itemsFromLegacyClips(project, input.clips, current.tracks, timing, sourceBounds)
        const commandSet = this.legacyProjectionCommandSet(
          project,
          items,
          `legacy-update-${factBasisHash({ base_revision: input.base_revision, base_timeline_version_id: baseVersionId ?? current.id, clips: input.clips })}`,
        )
        const applied = this.rules.applyCommandSet(project, commandSet, sourceBounds)
        if (applied.reused) return project
        return await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
          ...applied.project,
          alternatives: [],
          state: input.clips.length ? 'ready' : 'draft',
        }))
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async selectTimelineVersion(projectId: string, raw: SelectVideoTimelineVersionInput): Promise<VideoStudioProject> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = selectVideoTimelineVersionInputSchema.parse(raw)
      const project = await this.commands.prepareEditorialProject(projectId)
      try {
        if (project.state === 'rendering') throw this.errors.create('正在导出，暂时不能恢复时间线', 409, 'VIDEO_RENDER_ACTIVE')
        if (project.revision !== input.revision) throw this.errors.create('视频项目已更新，请刷新后再选择版本', 409, 'VIDEO_REVISION_CONFLICT')
        const current = this.rules.currentTimeline(project)
        const [timing, sourceBounds] = await Promise.all([this.editorialTimings(project), this.commands.editorialSourceBounds(project)])
        const formal = project.editorial_timeline_versions.find(candidate => candidate.id === input.version_id)
        const legacy = project.timeline_versions.find(candidate => candidate.id === input.version_id)
        if (!formal && !legacy) throw this.errors.create('视频时间线版本不存在', 404, 'VIDEO_TIMELINE_MISSING')
        const items = formal
          ? structuredClone(formal.items)
          : this.rules.itemsFromLegacyScenes(project, legacy!.scenes, current.tracks, timing, sourceBounds)
        const applied = this.rules.applyCommandSet(
          project,
          this.legacyProjectionCommandSet(project, items, `legacy-select-${factBasisHash({ revision: input.revision, version_id: input.version_id })}`),
          sourceBounds,
        )
        if (applied.reused) return project
        return await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
          ...applied.project,
          alternatives: [],
          state: items.length ? 'ready' : 'draft',
        }))
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async lockScene(projectId: string, sceneId: string, raw: LockVideoSceneInput): Promise<VideoStudioProject> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = lockVideoSceneInputSchema.parse(raw)
      const project = await this.commands.prepareEditorialProject(projectId)
      try {
        if (project.state === 'rendering') throw this.errors.create('正在导出，暂时不能修改时间线', 409, 'VIDEO_RENDER_ACTIVE')
        if (project.revision !== input.base_revision) throw this.errors.create('视频项目已更新，请刷新后再编辑', 409, 'VIDEO_TIMELINE_CONFLICT')
        const current = this.rules.currentTimeline(project)
        if (input.timeline_version_id !== current.id && input.timeline_version_id !== project.current_timeline_version_id) {
          throw this.errors.create('视频时间线已更新，请刷新后再编辑', 409, 'VIDEO_TIMELINE_CONFLICT')
        }
        const itemIds = current.items.filter(item => item.id === sceneId || item.legacy_scene_id === sceneId).map(item => item.id)
        if (!itemIds.length) throw this.errors.create('场景尚未迁移到编辑时间线', 409, 'VIDEO_TIMELINE_MISSING')
        const commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: 'local_workbench',
          idempotency_key: `legacy-lock-${factBasisHash({ base_revision: input.base_revision, timeline_version_id: input.timeline_version_id, scene_id: sceneId, locked: input.locked })}`,
          created_at: this.now().toISOString(),
          target: { kind: 'editorial', base_timeline_version_id: current.id },
          commands: [{ kind: 'lock', item_ids: itemIds, locked: input.locked }],
        })
        const applied = this.rules.applyCommandSet(project, commandSet, await this.commands.editorialSourceBounds(project))
        return applied.reused ? project : await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse(applied.project))
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async applyAlternative(projectId: string, raw: ApplyVideoAlternativeInput): Promise<VideoStudioProject> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = applyVideoAlternativeInputSchema.parse(raw)
      const project = await this.commands.prepareEditorialProject(projectId)
      try {
        if (project.state === 'rendering') throw this.errors.create('正在导出，暂时不能修改时间线', 409, 'VIDEO_RENDER_ACTIVE')
        if (project.revision !== input.base_revision) throw this.errors.create('视频项目已更新，请刷新后再编辑', 409, 'VIDEO_REVISION_CONFLICT')
        const alternative = project.alternatives.find(candidate => candidate.id === input.alternative_id)
        if (!alternative) throw this.errors.create('备选方案不存在', 404, 'VIDEO_ALTERNATIVE_NOT_FOUND')
        if (alternative.base_timeline_version_id !== project.current_timeline_version_id && alternative.base_timeline_version_id !== project.current_editorial_timeline_version_id) {
          throw this.errors.create('备选方案已经过期，请重新分析', 409, 'VIDEO_ALTERNATIVE_STALE')
        }
        const current = this.rules.currentTimeline(project)
        const [timing, sourceBounds] = await Promise.all([this.editorialTimings(project), this.commands.editorialSourceBounds(project)])
        const items = this.rules.itemsFromLegacyScenes(project, alternative.scenes, current.tracks, timing, sourceBounds)
        const applied = this.rules.applyCommandSet(
          project,
          this.legacyProjectionCommandSet(project, items, `legacy-alternative-${factBasisHash({ base_revision: input.base_revision, alternative_id: alternative.id })}`),
          sourceBounds,
        )
        if (applied.reused) return project
        return await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
          ...applied.project,
          alternatives: [],
          state: alternative.scenes.length ? 'ready' : 'draft',
        }))
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  readonly updateDeliveryIntent = (...args: Parameters<EditorialCommandPort['updateDeliveryIntent']>) => this.commands.updateDeliveryIntent(...args)
  readonly getDurationFeasibility = (...args: Parameters<EditorialCommandPort['getDurationFeasibility']>) => this.commands.getDurationFeasibility(...args)
  readonly createSourceRangeDecision = (...args: Parameters<EditorialCommandPort['createSourceRangeDecision']>) => this.commands.createSourceRangeDecision(...args)
  readonly createEditorialPlans = (...args: Parameters<EditorialCommandPort['createEditorialPlans']>) => this.commands.createEditorialPlans(...args)
  readonly quickCreate = (...args: Parameters<EditorialCommandPort['quickCreate']>) => this.commands.quickCreate(...args)
  readonly createCreativeSession = (...args: Parameters<EditorialCommandPort['createCreativeSession']>) => this.commands.createCreativeSession(...args)
  readonly postCreativeMessage = (...args: Parameters<EditorialCommandPort['postCreativeMessage']>) => this.commands.postCreativeMessage(...args)
  readonly getCreativeProposal = (...args: Parameters<EditorialCommandPort['getCreativeProposal']>) => this.commands.getCreativeProposal(...args)
  readonly acceptCreativeProposal = (...args: Parameters<EditorialCommandPort['acceptCreativeProposal']>) => this.commands.acceptCreativeProposal(...args)
  readonly rejectCreativeProposal = (...args: Parameters<EditorialCommandPort['rejectCreativeProposal']>) => this.commands.rejectCreativeProposal(...args)
}
