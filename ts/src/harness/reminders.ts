import { textBlock, type TextBlock } from '../types/message'
import type { ToolContext } from '../tools/Tool'
import { getPlanFilePath } from './plans'

export const STEER_MARK = '[用户补充/纠偏]'
export const STEER_EXTRA_TURNS = 2
export const PROGRESS_REMIND_EVERY = 6
export const VERIFY_PLAN_REMIND_EVERY = 3
/** plan 模式提醒节流:每 N 个工具批次注入一次(对齐 cc TURNS_BETWEEN_ATTACHMENTS=5),不再每批必发。 */
export const PLAN_REMIND_EVERY = 5
export const PLAN_MODE_REMINDER =
  'You are in plan mode. Research and design the solution without implementing it. Use read-only tools to explore, produce a complete step-by-step plan, and wait for approval before making implementation changes.'

/**
 * 计划模式系统提醒(对齐 cc getPlanModeV2Instructions:每轮以 system-reminder 注入)。带上**计划文件路径 +
 * 工作流**——"唯一可编辑=计划文件、其余只读探索、以 ExitPlanMode 收尾"。planFilePath 为空(脱离工作区的
 * 单测场景)时退回基础提醒。
 */
export function planModeReminder(planFilePath?: string): string {
  if (!planFilePath) return PLAN_MODE_REMINDER
  return [
    PLAN_MODE_REMINDER,
    `Plan file: ${planFilePath}. This is the only file you may edit in plan mode. Create it with write_file and update it with edit_file; keep all other exploration read-only.`,
    'When the plan is complete, call ExitPlanMode to request approval. ExitPlanMode reads the plan directly from this file and does not accept the plan body as an argument.',
  ].join('\n')
}
export const VERIFY_PLAN_REMINDER =
  'You have started executing an approved plan. After implementation, call VerifyPlanExecution with reproducible evidence such as command output, diagnostics, file reads, screenshots, or manual checks. Do not substitute a summary for verification.'

/** 系统提醒包壳:系统提示已告诉模型 <system-reminder> 是系统自动加的、不是老板说的话。 */
export function wrapReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}

/**
 * 取空 steerInbox 的积压插话,返回取出的原文(FIFO)。**不再改 messages**——由循环决定把它作 text 块
 * 拼进 tool_result 那条 user 消息(批内),或作独立 user 消息(收尾)。只在安全点调用。
 */
export function drainSteering(ctx: ToolContext): string[] {
  const inbox = ctx.steerInbox
  if (!inbox || inbox.length === 0) return []
  return inbox.splice(0)
}

/** 把一条插话包成带 [用户补充/纠偏] 标记的 text 块。 */
export function steerBlock(m: string): TextBlock {
  return textBlock(`${STEER_MARK} ${m}`)
}

/** steering 续命:每批插话给 turnsLimit 加 STEER_EXTRA_TURNS,封顶 maxTurns + floor(maxTurns/2)。 */
export function extendTurns(turnsLimit: number, maxTurns: number, batches: number): number {
  const cap = maxTurns + Math.floor(maxTurns / 2)
  return Math.min(cap, turnsLimit + STEER_EXTRA_TURNS * batches)
}

/** 本轮该注入哪些系统提醒(进度提醒 + plan/验证说明)。纯读——计数清零由循环负责。 */
export function collectReminders(ctx: ToolContext): Array<{ kind: 'progress' | 'plan' | 'verify_plan'; text: string }> {
  const out: Array<{ kind: 'progress' | 'plan' | 'verify_plan'; text: string }> = []
  if ((ctx.requestsSinceProgress ?? 0) >= PROGRESS_REMIND_EVERY) {
    const todos = ctx.todos ?? []
    const pct = todos.length ? Math.round((todos.filter(t => t.status === 'done').length / todos.length) * 100) : 0
    out.push({
      kind: 'progress',
      text: `You have made ${PROGRESS_REMIND_EVERY} consecutive tool calls without updating the task list. For multi-step work, use todo_write to update progress (currently about ${pct}%) so the user and you can track the remaining work.`,
    })
  }
  // plan 提醒节流(对齐 cc,不再每批必发):首批(count=0)必发,之后每 PLAN_REMIND_EVERY 批一次。
  // count 由循环每批递增(planModeTurnCount),取模 0 = 该发。
  if (ctx.permissionMode === 'plan' && (ctx.planModeTurnCount ?? 0) % PLAN_REMIND_EVERY === 0) {
    const root = ctx.workspace?.root
    const planFilePath = root ? getPlanFilePath(root, ctx.conversationId) : undefined
    out.push({ kind: 'plan', text: planModeReminder(planFilePath) })
  }
  // verify_plan 提醒节流(对齐 cc TURNS_BETWEEN_REMINDERS 取模,不再跨阈值后每批无限重复):
  // toolCallsSinceApproval 到 N、2N、3N… 各发一次,而非 ≥N 就每批发(乙审计发现的无限重复 bug)。
  const pending = ctx.pendingPlanVerification
  const sinceApproval = pending?.toolCallsSinceApproval ?? 0
  if (pending && !pending.verificationCompleted && sinceApproval > 0 && sinceApproval % VERIFY_PLAN_REMIND_EVERY === 0) {
    out.push({ kind: 'verify_plan', text: VERIFY_PLAN_REMINDER })
  }
  return out
}
