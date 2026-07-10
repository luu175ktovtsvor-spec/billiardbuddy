// 定时任务的「排程模型 → cron 表达式 → 下次触发时间」。
//
// 面板存的是对用户友好的 schedule_kind + schedule_spec(不是裸 cron),这里把它翻成 5 段 cron,
// 再用 cronExpression.ts(照搬 cc-haha 的 cron 引擎)算下次触发。cc-haha 的 frequencyToCron
// 只有 manual/hourly/daily/weekdays/weekly;我们在同一思路上加 monthly/once/cron(裸表达式逃生口),
// 覆盖「每天 9 点出日报」「每周一发周报」「每月 1 号盘点」「某个时刻跑一次」等常见球房场景。

import { computeNextCronRun, nextCronRunMs, parseCronExpression } from './cronExpression'

/** 面板支持的排程类型。 */
export type ScheduleKind =
  | 'manual' // 只手动「立即运行」,不自动触发
  | 'hourly' // 每小时
  | 'daily' // 每天
  | 'weekdays' // 工作日(周一到周五)
  | 'weekly' // 每周某天
  | 'monthly' // 每月某天
  | 'once' // 指定时刻跑一次
  | 'cron' // 裸 cron 表达式(高级逃生口)

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function spec(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

/**
 * schedule_kind + schedule_spec → 5 段 cron 字符串。
 * 无法用 cron 表达(manual / once / 非法)返回 null——调用方据此走「不自动触发」或「一次性时刻」分支。
 */
export function scheduleToCron(kind: string, scheduleSpec: unknown): string | null {
  const s = spec(scheduleSpec)
  const minute = clamp(num(s.minute, 0), 0, 59)
  const hour = clamp(num(s.hour, 9), 0, 23)

  switch (kind) {
    case 'hourly':
      return `${minute} * * * *`
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`
    case 'weekly': {
      // weekday 0=周日..6=周六,默认周一
      const weekday = clamp(num(s.weekday ?? s.day_of_week ?? s.dayOfWeek, 1), 0, 6)
      return `${minute} ${hour} * * ${weekday}`
    }
    case 'monthly': {
      // day 1..31,默认 1 号
      const day = clamp(num(s.day ?? s.day_of_month ?? s.dayOfMonth, 1), 1, 31)
      return `${minute} ${hour} ${day} * *`
    }
    case 'cron': {
      const expr = typeof s.expression === 'string' ? s.expression.trim() : ''
      return expr && parseCronExpression(expr) ? expr : null
    }
    case 'manual':
    case 'once':
    default:
      return null
  }
}

/** 解析 once 类型的目标时刻(epoch ms);非法返回 null。 */
function onceTargetMs(scheduleSpec: unknown): number | null {
  const s = spec(scheduleSpec)
  const raw = s.at ?? s.run_at ?? s.datetime ?? s.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw.trim())
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * 计算某个任务在 `fromMs` 之后的下次触发时间(ISO 字符串)。
 * - 周期任务(daily/weekly/…/cron):走 cron 引擎算严格晚于 fromMs 的下一刻。
 * - once:目标时刻晚于 fromMs 则返回它,否则 null(已过 → 不再触发)。
 * - manual / 非法:返回 null(不自动触发)。
 */
export function computeNextRunAt(
  task: { schedule_kind?: unknown; schedule_spec?: unknown },
  fromMs: number = Date.now(),
): string | null {
  const kind = typeof task.schedule_kind === 'string' ? task.schedule_kind : 'daily'

  if (kind === 'once') {
    const target = onceTargetMs(task.schedule_spec)
    return target !== null && target > fromMs ? new Date(target).toISOString() : null
  }

  const cron = scheduleToCron(kind, task.schedule_spec)
  if (!cron) return null
  const nextMs = nextCronRunMs(cron, fromMs)
  return nextMs !== null ? new Date(nextMs).toISOString() : null
}

/** once 任务触发后不再重排(一次性)。其余(有 cron)可周期重排。 */
export function isRecurringSchedule(task: { schedule_kind?: unknown; schedule_spec?: unknown }): boolean {
  const kind = typeof task.schedule_kind === 'string' ? task.schedule_kind : 'daily'
  if (kind === 'once' || kind === 'manual') return false
  return scheduleToCron(kind, task.schedule_spec) !== null
}

// 供测试/未来面板复用:导出底层引擎能力。
export { computeNextCronRun, parseCronExpression }
