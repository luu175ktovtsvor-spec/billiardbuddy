import type { Message } from '../types/message'
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
 * 取空 steerInbox 的积压插话,作 [用户补充/纠偏] 用户消息 append 到 messages 尾部,返回取出的原文。
 * 原地 splice(路由持同一数组引用);空则不动 messages。只在安全点(批配对完/收尾)调用。
 */
export function drainSteering(messages: Message[], ctx: ToolContext): string[] {
  const inbox = ctx.steerInbox
  if (!inbox || inbox.length === 0) return []
  const drained = inbox.splice(0)
  for (const m of drained) messages.push({ role: 'user', content: `${STEER_MARK} ${m}` })
  return drained
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
