// 招聘业务契约:候选人漏斗、跟进、话术草稿与岗位缺口的单一事实源 Schema。
// 第一版走「人工交接连接器」:Agent 只负责准备(草稿/队列/记录),发送由用户在 BOSS 官方产品内完成;
// 草稿标记为 sent 必须携带读回证据(evidence),没有证据只能是 uncertain——这是确定性业务闸,不靠提示词。

import { z } from 'zod'

/** 招聘漏斗阶段(球房真实流程:沟通→回复→加微信/留资→邀约→到店→录取→入职;closed=流失/关闭)。 */
export const recruitmentStageSchema = z.enum([
  'contacted',
  'replied',
  'wechat_added',
  'invited',
  'visited',
  'offered',
  'hired',
  'closed',
])

export const recruitmentStageLabels: Record<z.infer<typeof recruitmentStageSchema>, string> = {
  contacted: '已沟通',
  replied: '已回复',
  wechat_added: '已加微信',
  invited: '已邀约',
  visited: '已到店',
  offered: '已录取',
  hired: '已入职',
  closed: '已关闭',
}

export const recruitmentStageEventSchema = z.object({
  stage: recruitmentStageSchema,
  at: z.string(),
  note: z.string().max(2_000).optional(),
})

export const recruitmentCandidateSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  position: z.string().min(1).max(80),
  /** 来源渠道(boss/referral/walk-in…),自由字符串,默认 boss。 */
  source: z.string().min(1).max(40).default('boss'),
  /** 外部平台可区分引用(如「姓名+当前岗位+关键经历」或列表序号),同名候选人靠它区分。 */
  externalRef: z.string().max(400).optional(),
  stage: recruitmentStageSchema,
  notes: z.string().max(4_000).optional(),
  nextAction: z.string().max(400).optional(),
  /** 下一步截止时间(ISO);逾期未跟进 = 今日队列的核心判据。 */
  nextActionDue: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stageHistory: z.array(recruitmentStageEventSchema),
})

export const recruitmentDraftStatusSchema = z.enum(['drafted', 'approved', 'sent', 'uncertain', 'discarded'])

export const recruitmentDraftSchema = z.object({
  id: z.string().min(1).max(128),
  candidateId: z.string().min(1).max(128),
  content: z.string().min(1).max(4_000),
  status: recruitmentDraftStatusSchema,
  /** status=sent 的读回证据(用户在官方产品里看到的已发送内容/回执描述);sent 必须非空。 */
  evidence: z.string().max(2_000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const recruitmentPositionSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(80),
  /** 缺口人数(还差几个),0 = 已招满但保留记录。 */
  openings: z.number().int().min(0).max(999),
  notes: z.string().max(2_000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** 持久化文件形状(<stateRoot>/recruitment/recruitment.json)。 */
export const recruitmentStateSchema = z.object({
  revision: z.number().int().min(0),
  positions: z.array(recruitmentPositionSchema),
  candidates: z.array(recruitmentCandidateSchema),
  drafts: z.array(recruitmentDraftSchema),
})

export const recruitmentFunnelReportSchema = z.object({
  generatedAt: z.string(),
  totalCandidates: z.number().int().min(0),
  stageCounts: z.record(recruitmentStageSchema, z.number().int().min(0)),
  overdueFollowups: z.number().int().min(0),
  positions: z.array(z.object({
    title: z.string(),
    openings: z.number().int().min(0),
    hired: z.number().int().min(0),
  })),
})

export const recruitmentCandidateListResponseSchema = z.object({
  candidates: z.array(recruitmentCandidateSchema),
})

export const recruitmentDraftListResponseSchema = z.object({
  drafts: z.array(recruitmentDraftSchema),
})

export const recruitmentPositionListResponseSchema = z.object({
  positions: z.array(recruitmentPositionSchema),
})

export type RecruitmentStage = z.infer<typeof recruitmentStageSchema>
export type RecruitmentStageEvent = z.infer<typeof recruitmentStageEventSchema>
export type RecruitmentCandidate = z.infer<typeof recruitmentCandidateSchema>
export type RecruitmentDraftStatus = z.infer<typeof recruitmentDraftStatusSchema>
export type RecruitmentDraft = z.infer<typeof recruitmentDraftSchema>
export type RecruitmentPosition = z.infer<typeof recruitmentPositionSchema>
export type RecruitmentState = z.infer<typeof recruitmentStateSchema>
export type RecruitmentFunnelReport = z.infer<typeof recruitmentFunnelReportSchema>
