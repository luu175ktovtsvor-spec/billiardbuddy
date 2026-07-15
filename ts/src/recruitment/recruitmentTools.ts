// 招聘窄工具:Agent 只能通过这些参数明确的动作读写招聘事实源,不暴露任意数据库写入。
// 发送不在工具能力内(人工交接):save_draft 只存草稿;update_draft 标记 sent 时由服务层强制要求读回证据。
// 所有写入都是本地可审计的业务记录(JSON + 审计日志),与文件/命令工具的权限语义无关。

import { z } from 'zod'
import {
  recruitmentDraftStatusSchema,
  recruitmentStageLabels,
  recruitmentStageSchema,
  type RecruitmentCandidate,
} from '../../shared/contracts/recruitment'
import type { Tool } from '../tools/Tool'
import type { RecruitmentService } from './recruitmentService'

const STAGE_VALUES = recruitmentStageSchema.options
const STAGE_HELP = STAGE_VALUES.map(stage => `${stage}=${recruitmentStageLabels[stage]}`).join(', ')

const addCandidatesInput = z.object({
  candidates: z.array(z.object({
    name: z.string().min(1).max(80),
    position: z.string().min(1).max(80),
    source: z.string().min(1).max(40).optional(),
    external_ref: z.string().max(400).optional(),
    stage: recruitmentStageSchema.optional(),
    notes: z.string().max(4_000).optional(),
    next_action: z.string().max(400).optional(),
    next_action_due: z.string().optional(),
  })).min(1).max(50),
})

const listCandidatesInput = z.object({
  stage: recruitmentStageSchema.optional(),
  due_today: z.boolean().optional(),
})

const updateStageInput = z.object({
  candidate_id: z.string().min(1),
  stage: recruitmentStageSchema,
  note: z.string().max(2_000).optional(),
  next_action: z.string().max(400).optional(),
  next_action_due: z.string().optional(),
})

const setFollowupInput = z.object({
  candidate_id: z.string().min(1),
  next_action: z.string().min(1).max(400),
  due_at: z.string().optional(),
})

const saveDraftInput = z.object({
  candidate_id: z.string().min(1),
  content: z.string().min(1).max(4_000),
})

const updateDraftInput = z.object({
  draft_id: z.string().min(1),
  status: recruitmentDraftStatusSchema,
  evidence: z.string().max(2_000).optional(),
})

const listDraftsInput = z.object({
  candidate_id: z.string().optional(),
})

const upsertPositionInput = z.object({
  title: z.string().min(1).max(80),
  openings: z.number().int().min(0).max(999),
  notes: z.string().max(2_000).optional(),
})

function parseInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const result = schema.safeParse(input ?? {})
  if (!result.success) {
    throw new Error(`${toolName} 参数不合法:${result.error.issues[0]?.message ?? 'invalid input'}`)
  }
  return result.data
}

function candidateSummary(candidate: RecruitmentCandidate): Record<string, unknown> {
  return {
    id: candidate.id,
    name: candidate.name,
    position: candidate.position,
    stage: candidate.stage,
    stage_label: recruitmentStageLabels[candidate.stage],
    next_action: candidate.nextAction,
    next_action_due: candidate.nextActionDue,
    external_ref: candidate.externalRef,
    notes: candidate.notes,
  }
}

export function createRecruitmentTools(service: RecruitmentService): Tool[] {
  const listCandidates: Tool = {
    name: 'recruitment_list_candidates',
    description: `List recruitment candidates from the venue recruitment record. Set due_today=true for today's follow-up queue (due or overdue, excluding hired/closed). Stages: ${STAGE_HELP}.`,
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: [...STAGE_VALUES], description: 'Filter by funnel stage.' },
        due_today: { type: 'boolean', description: 'Only candidates whose next action is due today or overdue.' },
      },
    },
    isReadOnly: true,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(listCandidatesInput, input, 'recruitment_list_candidates')
      const candidates = await service.listCandidates({ stage: body.stage, dueOnly: body.due_today === true })
      return JSON.stringify({ count: candidates.length, candidates: candidates.map(candidateSummary) }, null, 2)
    },
  }

  const addCandidates: Tool = {
    name: 'recruitment_add_candidates',
    description: 'Register candidates into the venue recruitment record (deduplicates by name + position among non-closed candidates). Only record facts the user or the platform page actually provided; never invent contact info or experience.',
    inputSchema: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          description: 'Candidates to register.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              position: { type: 'string', description: 'Position title, e.g. 助教/店长/服务员.' },
              source: { type: 'string', description: 'Channel, default boss.' },
              external_ref: { type: 'string', description: 'Distinguishing platform reference (name + current job + key experience, or list index).' },
              stage: { type: 'string', enum: [...STAGE_VALUES] },
              notes: { type: 'string' },
              next_action: { type: 'string' },
              next_action_due: { type: 'string', description: 'ISO datetime for the next follow-up deadline.' },
            },
            required: ['name', 'position'],
          },
        },
      },
      required: ['candidates'],
    },
    isReadOnly: false,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(addCandidatesInput, input, 'recruitment_add_candidates')
      const result = await service.addCandidates(body.candidates.map(candidate => ({
        name: candidate.name,
        position: candidate.position,
        source: candidate.source,
        externalRef: candidate.external_ref,
        stage: candidate.stage,
        notes: candidate.notes,
        nextAction: candidate.next_action,
        nextActionDue: candidate.next_action_due,
      })))
      return JSON.stringify({
        added: result.added.map(candidateSummary),
        duplicates: result.duplicates,
      }, null, 2)
    },
  }

  const updateStage: Tool = {
    name: 'recruitment_update_stage',
    description: `Move a candidate to a funnel stage (history is kept). Stages: ${STAGE_HELP}. Optionally set the next follow-up action/deadline in the same call.`,
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string' },
        stage: { type: 'string', enum: [...STAGE_VALUES] },
        note: { type: 'string', description: 'Why the stage changed (evidence, user statement).' },
        next_action: { type: 'string' },
        next_action_due: { type: 'string' },
      },
      required: ['candidate_id', 'stage'],
    },
    isReadOnly: false,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(updateStageInput, input, 'recruitment_update_stage')
      const candidate = await service.updateStage(body.candidate_id, body.stage, {
        note: body.note,
        nextAction: body.next_action,
        nextActionDue: body.next_action_due,
      })
      return JSON.stringify(candidateSummary(candidate), null, 2)
    },
  }

  const setFollowup: Tool = {
    name: 'recruitment_set_followup',
    description: 'Set or update the next follow-up action and deadline for a candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string' },
        next_action: { type: 'string' },
        due_at: { type: 'string', description: 'ISO datetime deadline.' },
      },
      required: ['candidate_id', 'next_action'],
    },
    isReadOnly: false,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(setFollowupInput, input, 'recruitment_set_followup')
      const candidate = await service.setFollowUp(body.candidate_id, body.next_action, body.due_at)
      return JSON.stringify(candidateSummary(candidate), null, 2)
    },
  }

  const saveDraft: Tool = {
    name: 'recruitment_save_draft',
    description: 'Save an outreach message draft for a candidate. Drafts are NOT sent by this product: the user sends them in the official platform app. Never claim a draft was sent.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string' },
        content: { type: 'string', description: 'The full draft message text.' },
      },
      required: ['candidate_id', 'content'],
    },
    isReadOnly: false,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(saveDraftInput, input, 'recruitment_save_draft')
      const draft = await service.saveDraft(body.candidate_id, body.content)
      return JSON.stringify({ id: draft.id, candidate_id: draft.candidateId, status: draft.status }, null, 2)
    },
  }

  const updateDraft: Tool = {
    name: 'recruitment_update_draft',
    description: 'Record what happened to a draft after the user handled it in the official platform app. status=sent REQUIRES evidence the user read back from the platform (the tool rejects sent without evidence); if the outcome is unverified use status=uncertain and stop.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: { type: 'string' },
        status: { type: 'string', enum: [...recruitmentDraftStatusSchema.options] },
        evidence: { type: 'string', description: 'Read-back evidence from the official app (e.g. the sent message as displayed). Required for status=sent.' },
      },
      required: ['draft_id', 'status'],
    },
    isReadOnly: false,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(updateDraftInput, input, 'recruitment_update_draft')
      const draft = await service.updateDraftStatus(body.draft_id, body.status, body.evidence)
      return JSON.stringify({ id: draft.id, candidate_id: draft.candidateId, status: draft.status, evidence: draft.evidence }, null, 2)
    },
  }

  const listDrafts: Tool = {
    name: 'recruitment_list_drafts',
    description: 'List saved outreach drafts (optionally for one candidate), newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string' },
      },
    },
    isReadOnly: true,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(listDraftsInput, input, 'recruitment_list_drafts')
      const drafts = await service.listDrafts(body.candidate_id)
      return JSON.stringify({
        count: drafts.length,
        drafts: drafts.map(draft => ({
          id: draft.id,
          candidate_id: draft.candidateId,
          status: draft.status,
          content: draft.content,
          evidence: draft.evidence,
          updated_at: draft.updatedAt,
        })),
      }, null, 2)
    },
  }

  const upsertPosition: Tool = {
    name: 'recruitment_upsert_position',
    description: 'Create or update a position headcount gap (position title is the business key). openings = how many people are still needed.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        openings: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['title', 'openings'],
    },
    isReadOnly: false,
    async execute(input: unknown): Promise<string> {
      const body = parseInput(upsertPositionInput, input, 'recruitment_upsert_position')
      const position = await service.upsertPosition(body.title, body.openings, body.notes)
      return JSON.stringify(position, null, 2)
    },
  }

  const funnelReport: Tool = {
    name: 'recruitment_funnel_report',
    description: 'Generate the recruitment funnel report: per-stage counts, overdue follow-ups, and hired-vs-openings per position. Numbers come from the recruitment record only.',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    async execute(): Promise<string> {
      const report = await service.funnelReport()
      const labeled = Object.fromEntries(Object.entries(report.stageCounts)
        .map(([stage, count]) => [`${stage}(${recruitmentStageLabels[stage as keyof typeof recruitmentStageLabels]})`, count]))
      return JSON.stringify({ ...report, stageCounts: labeled }, null, 2)
    },
  }

  return [listCandidates, addCandidates, updateStage, setFollowup, saveDraft, updateDraft, listDrafts, upsertPosition, funnelReport]
}
