import { randomUUID } from 'node:crypto'
import {
  createVideoApprovalDecisionInputSchema,
  createVideoReviewNoteInputSchema,
  resolveVideoReviewNoteInputSchema,
  videoStudioProjectSchema,
  type CreateVideoApprovalDecisionInput,
  type CreateVideoReviewNoteInput,
  type ResolveVideoReviewNoteInput,
  type VideoApprovalDecision,
  type VideoReviewAnchor,
  type VideoReviewNote,
  type VideoStudioProject,
} from '../../../../shared/contracts/media.js'
import { factBasisHash } from '../domain/mediaFacts/model.js'
import { compareRationalTime, endOfRange, rationalTime } from '../domain/mediaFacts/time.js'
import { materializeVideoReviewNotes, nextVideoReviewEventSequence } from '../domain/editorial/review.js'
import type { EditorialApplication } from '../domain/editorial/editorialApplication.js'
import type { VideoProjectStore } from '../runtime/videoProjectStore.js'
import type { EditorialCommandPort, VideoWorkbenchApplicationErrors } from '../runtime/videoWorkbenchApplicationPorts.js'

function id(prefix: 'review_note' | 'review_resolution' | 'approval'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
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

  readonly getEditorialTimeline = (...args: Parameters<EditorialCommandPort['getEditorialTimeline']>) => this.commands.getEditorialTimeline(...args)
  readonly getTimelineDraft = (...args: Parameters<EditorialCommandPort['getTimelineDraft']>) => this.commands.getTimelineDraft(...args)
  readonly applyEditorialTimelineCommands = (...args: Parameters<EditorialCommandPort['applyEditorialTimelineCommands']>) => this.commands.applyEditorialTimelineCommands(...args)
  readonly acceptTimelineDraft = (...args: Parameters<EditorialCommandPort['acceptTimelineDraft']>) => this.commands.acceptTimelineDraft(...args)
  readonly updateTimeline = (...args: Parameters<EditorialCommandPort['updateTimeline']>) => this.commands.updateTimeline(...args)
  readonly selectTimelineVersion = (...args: Parameters<EditorialCommandPort['selectTimelineVersion']>) => this.commands.selectTimelineVersion(...args)
  readonly lockScene = (...args: Parameters<EditorialCommandPort['lockScene']>) => this.commands.lockScene(...args)
  readonly applyAlternative = (...args: Parameters<EditorialCommandPort['applyAlternative']>) => this.commands.applyAlternative(...args)
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
