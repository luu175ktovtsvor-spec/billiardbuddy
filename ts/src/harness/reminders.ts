import { textBlock, type TextBlock } from '../types/message'
import type { ToolContext } from '../tools/Tool'

export const STEER_MARK = '[用户补充/纠偏]'
export const STEER_EXTRA_TURNS = 2
export const PROGRESS_REMIND_EVERY = 6
export const PLAN_MODE_REMINDER =
  '你现在处于【计划模式】:只规划、不动手。用只读工具去探索,把完整、分步的计划讲清楚给老板;会实际改动的步骤先别做,等老板切到执行档或确认后再做。'

/** cc-haha 式系统提醒包壳:系统提示已告诉模型 <system-reminder> 是系统自动加的、不是老板说的话。 */
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

/** 本轮该注入哪些系统提醒(进度提醒 + plan 说明)。纯读——进度计数清零由循环负责(见 Task 4)。 */
export function collectReminders(ctx: ToolContext): Array<{ kind: 'progress' | 'plan'; text: string }> {
  const out: Array<{ kind: 'progress' | 'plan'; text: string }> = []
  if ((ctx.requestsSinceProgress ?? 0) >= PROGRESS_REMIND_EVERY) {
    const todos = ctx.todos ?? []
    const pct = todos.length ? Math.round((todos.filter(t => t.status === 'done').length / todos.length) * 100) : 0
    out.push({
      kind: 'progress',
      text: `你已经连着调了 ${PROGRESS_REMIND_EVERY} 次工具没更新任务清单。若在做多步任务,记得用 todo_write 更新进度(当前约 ${pct}%),别让老板和你自己跟丢了。`,
    })
  }
  if (ctx.permissionMode === 'plan') {
    out.push({ kind: 'plan', text: PLAN_MODE_REMINDER })
  }
  return out
}
