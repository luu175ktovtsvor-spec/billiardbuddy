// 招聘业务事实源(领域服务):候选人漏斗、跟进队列、话术草稿与岗位缺口。
// - 聊天工具、REST 工作台和定时任务复用同一份状态(单一事实源,原子 JSON 落盘 + 追加审计日志)。
// - 文件损坏时失败关闭:不静默清空业务数据,读写都报错,原文件留给用户处理。
// - 发送不是本服务的能力:草稿标记 sent 必须携带读回证据,否则拒绝——确定性业务闸。

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  recruitmentStageLabels,
  recruitmentStateSchema,
  type RecruitmentCandidate,
  type RecruitmentDraft,
  type RecruitmentDraftStatus,
  type RecruitmentFunnelReport,
  type RecruitmentPosition,
  type RecruitmentStage,
  type RecruitmentState,
} from '../../shared/contracts/recruitment'

const ACTIVE_STAGE_EXCLUDES: ReadonlySet<RecruitmentStage> = new Set(['hired', 'closed'])

export interface AddCandidateInput {
  name: string
  position: string
  source?: string
  externalRef?: string
  stage?: RecruitmentStage
  notes?: string
  nextAction?: string
  nextActionDue?: string
}

export interface AddCandidatesResult {
  added: RecruitmentCandidate[]
  duplicates: Array<{ name: string; position: string; existingId: string }>
}

export interface CandidateListFilter {
  stage?: RecruitmentStage
  dueOnly?: boolean
}

export class RecruitmentDataCorruptedError extends Error {
  constructor(path: string) {
    super(`招聘数据文件损坏,已停止读写以保护原文件:${path}。请人工检查或恢复备份后重试。`)
  }
}

export class RecruitmentService {
  private readonly statePath: string
  private readonly auditPath: string
  private writeQueue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number

  constructor(stateRoot: string, opts: { now?: () => number } = {}) {
    this.statePath = join(stateRoot, 'recruitment', 'recruitment.json')
    this.auditPath = join(stateRoot, 'recruitment', 'recruitment-audit.jsonl')
    this.now = opts.now ?? (() => Date.now())
  }

  // ─── 候选人 ─────────────────────────────────────────────────────

  async listCandidates(filter: CandidateListFilter = {}): Promise<RecruitmentCandidate[]> {
    const state = await this.readState()
    let candidates = [...state.candidates]
    if (filter.stage) candidates = candidates.filter(candidate => candidate.stage === filter.stage)
    if (filter.dueOnly) {
      const cutoff = endOfDayIso(this.now())
      candidates = candidates
        .filter(candidate => !ACTIVE_STAGE_EXCLUDES.has(candidate.stage))
        .filter(candidate => !!candidate.nextActionDue && candidate.nextActionDue <= cutoff)
        .sort((a, b) => (a.nextActionDue ?? '').localeCompare(b.nextActionDue ?? ''))
      return candidates
    }
    return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async getCandidate(id: string): Promise<RecruitmentCandidate | null> {
    const state = await this.readState()
    return state.candidates.find(candidate => candidate.id === id) ?? null
  }

  /** 批量登记候选人。去重规则:同名 + 同岗位且未关闭的既有候选人视为重复,不新建。 */
  async addCandidates(inputs: AddCandidateInput[]): Promise<AddCandidatesResult> {
    const result: AddCandidatesResult = { added: [], duplicates: [] }
    await this.mutate(state => {
      for (const input of inputs) {
        const name = input.name.trim()
        const position = input.position.trim()
        if (!name || !position) throw new Error('候选人必须有姓名和岗位')
        const existing = state.candidates.find(candidate =>
          candidate.stage !== 'closed' &&
          normalize(candidate.name) === normalize(name) &&
          normalize(candidate.position) === normalize(position))
        if (existing) {
          result.duplicates.push({ name, position, existingId: existing.id })
          continue
        }
        const timestamp = this.iso()
        const stage = input.stage ?? 'contacted'
        const candidate: RecruitmentCandidate = {
          id: crypto.randomUUID(),
          name,
          position,
          source: input.source?.trim() || 'boss',
          externalRef: input.externalRef?.trim() || undefined,
          stage,
          notes: input.notes?.trim() || undefined,
          nextAction: input.nextAction?.trim() || undefined,
          nextActionDue: input.nextActionDue?.trim() || undefined,
          createdAt: timestamp,
          updatedAt: timestamp,
          stageHistory: [{ stage, at: timestamp }],
        }
        state.candidates.push(candidate)
        result.added.push(candidate)
      }
    }, { op: 'add_candidates', count: inputs.length })
    return result
  }

  /** 阶段流转:追加 stageHistory,可同步更新下一步。任何方向的流转都允许(现实优先),但全部留痕。 */
  async updateStage(id: string, stage: RecruitmentStage, opts: { note?: string; nextAction?: string; nextActionDue?: string } = {}): Promise<RecruitmentCandidate> {
    let updated: RecruitmentCandidate | null = null
    await this.mutate(state => {
      const candidate = state.candidates.find(item => item.id === id)
      if (!candidate) throw new Error(`候选人不存在:${id}`)
      const timestamp = this.iso()
      candidate.stage = stage
      candidate.stageHistory.push({ stage, at: timestamp, note: opts.note?.trim() || undefined })
      if (opts.nextAction !== undefined) candidate.nextAction = opts.nextAction.trim() || undefined
      if (opts.nextActionDue !== undefined) candidate.nextActionDue = opts.nextActionDue.trim() || undefined
      candidate.updatedAt = timestamp
      updated = candidate
    }, { op: 'update_stage', candidateId: id, stage })
    return updated!
  }

  async setFollowUp(id: string, nextAction: string, nextActionDue?: string): Promise<RecruitmentCandidate> {
    let updated: RecruitmentCandidate | null = null
    await this.mutate(state => {
      const candidate = state.candidates.find(item => item.id === id)
      if (!candidate) throw new Error(`候选人不存在:${id}`)
      candidate.nextAction = nextAction.trim()
      candidate.nextActionDue = nextActionDue?.trim() || undefined
      candidate.updatedAt = this.iso()
      updated = candidate
    }, { op: 'set_followup', candidateId: id })
    return updated!
  }

  // ─── 话术草稿(人工交接:只存草稿与结果回填,不发送) ───────────────

  async listDrafts(candidateId?: string): Promise<RecruitmentDraft[]> {
    const state = await this.readState()
    return state.drafts
      .filter(draft => !candidateId || draft.candidateId === candidateId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async saveDraft(candidateId: string, content: string): Promise<RecruitmentDraft> {
    let created: RecruitmentDraft | null = null
    await this.mutate(state => {
      if (!state.candidates.some(candidate => candidate.id === candidateId)) {
        throw new Error(`候选人不存在:${candidateId}`)
      }
      const trimmed = content.trim()
      if (!trimmed) throw new Error('草稿内容不能为空')
      const timestamp = this.iso()
      created = {
        id: crypto.randomUUID(),
        candidateId,
        content: trimmed,
        status: 'drafted',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      state.drafts.push(created)
    }, { op: 'save_draft', candidateId })
    return created!
  }

  /**
   * 回填草稿状态。确定性业务闸:status=sent 必须携带非空 evidence(用户从官方产品读回的发送证据);
   * 没有证据只能记 uncertain。该规则在代码层强制,不依赖模型自觉。
   */
  async updateDraftStatus(id: string, status: RecruitmentDraftStatus, evidence?: string): Promise<RecruitmentDraft> {
    let updated: RecruitmentDraft | null = null
    await this.mutate(state => {
      const draft = state.drafts.find(item => item.id === id)
      if (!draft) throw new Error(`草稿不存在:${id}`)
      const trimmedEvidence = evidence?.trim() || undefined
      if (status === 'sent' && !trimmedEvidence) {
        throw new Error('没有读回证据不能标记为已发送;请提供官方产品中看到的发送证据,或改用 uncertain。')
      }
      draft.status = status
      if (trimmedEvidence) draft.evidence = trimmedEvidence
      draft.updatedAt = this.iso()
      updated = draft
    }, { op: 'update_draft_status', draftId: id, status })
    return updated!
  }

  // ─── 岗位缺口 ───────────────────────────────────────────────────

  async listPositions(): Promise<RecruitmentPosition[]> {
    return (await this.readState()).positions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 按岗位名 upsert(岗位名是业务主键;重复登记同名岗位 = 更新缺口)。 */
  async upsertPosition(title: string, openings: number, notes?: string): Promise<RecruitmentPosition> {
    let saved: RecruitmentPosition | null = null
    await this.mutate(state => {
      const trimmedTitle = title.trim()
      if (!trimmedTitle) throw new Error('岗位名不能为空')
      if (!Number.isInteger(openings) || openings < 0) throw new Error('缺口人数必须是非负整数')
      const timestamp = this.iso()
      const existing = state.positions.find(position => normalize(position.title) === normalize(trimmedTitle))
      if (existing) {
        existing.openings = openings
        if (notes !== undefined) existing.notes = notes.trim() || undefined
        existing.updatedAt = timestamp
        saved = existing
      } else {
        saved = {
          id: crypto.randomUUID(),
          title: trimmedTitle,
          openings,
          notes: notes?.trim() || undefined,
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        state.positions.push(saved)
      }
    }, { op: 'upsert_position', title })
    return saved!
  }

  // ─── 漏斗统计 ───────────────────────────────────────────────────

  async funnelReport(): Promise<RecruitmentFunnelReport> {
    const state = await this.readState()
    const stageCounts = Object.fromEntries(
      (Object.keys(recruitmentStageLabels) as RecruitmentStage[]).map(stage => [stage, 0]),
    ) as Record<RecruitmentStage, number>
    for (const candidate of state.candidates) {
      stageCounts[candidate.stage] += 1
    }
    const cutoff = endOfDayIso(this.now())
    const overdueFollowups = state.candidates
      .filter(candidate => !ACTIVE_STAGE_EXCLUDES.has(candidate.stage))
      .filter(candidate => !!candidate.nextActionDue && candidate.nextActionDue <= cutoff)
      .length
    return {
      generatedAt: this.iso(),
      totalCandidates: state.candidates.length,
      stageCounts,
      overdueFollowups,
      positions: state.positions.map(position => ({
        title: position.title,
        openings: position.openings,
        hired: state.candidates.filter(candidate =>
          candidate.stage === 'hired' && normalize(candidate.position) === normalize(position.title)).length,
      })),
    }
  }

  // ─── 持久化(原子写 + 失败关闭 + 审计) ────────────────────────────

  private async readState(): Promise<RecruitmentState> {
    let raw = ''
    try {
      raw = await readFile(this.statePath, 'utf8')
    } catch {
      return { revision: 0, positions: [], candidates: [], drafts: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new RecruitmentDataCorruptedError(this.statePath)
    }
    const result = recruitmentStateSchema.safeParse(parsed)
    if (!result.success) throw new RecruitmentDataCorruptedError(this.statePath)
    return result.data
  }

  private async mutate(mutator: (state: RecruitmentState) => void, audit: Record<string, unknown>): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const state = await this.readState()
      mutator(state)
      state.revision += 1
      const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`
      await mkdir(dirname(this.statePath), { recursive: true })
      await writeFile(tmp, `${JSON.stringify(recruitmentStateSchema.parse(state), null, 2)}\n`, 'utf8')
      await rename(tmp, this.statePath)
      await appendFile(this.auditPath, `${JSON.stringify({ ts: this.iso(), revision: state.revision, ...audit })}\n`, 'utf8')
        .catch(() => undefined) // 审计尾巴失败不阻断业务写入
    })
    this.writeQueue = run.catch(() => undefined)
    await run
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }
}

function normalize(text: string): string {
  return text.trim().toLowerCase()
}

/** 当天 23:59:59.999(本地时区)的 ISO——「今天到期 + 已逾期」的统一判据。 */
function endOfDayIso(nowMs: number): string {
  const end = new Date(nowMs)
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}
