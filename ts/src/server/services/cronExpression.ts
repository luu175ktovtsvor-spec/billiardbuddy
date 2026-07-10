// 5 段 cron 表达式解析 + 下次触发时间计算。
//
// 直接照搬 cc-haha `src/utils/cron.ts`(白标),行为对齐 = 唯一验收硬闸:
//   字段 = 分 时 日 月 周,支持 `*`、`N`、`*/N`(步进)、`N-M`(范围)、`N,M`(列表)、`N-M/S`。
//   不支持 L/W/?/名称别名。全部按进程本地时区解释("0 9 * * *" = 运行机器所在时区的每天 9 点)。
//
// 标准 cron 语义:当「日」和「周」都被限定(都不是全通配)时,某天命中 = 二者任一命中(OR 语义)。

export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number }

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek(0=周日;7 作为周日别名接受)
]

/**
 * 把单个 cron 字段展开成排序后的命中值数组。
 * 支持:通配、步进(星号斜杠N)、范围(N-M)、范围步进(N-M斜杠S)、逗号列表(N,M)。非法返回 null。
 */
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range
  const out = new Set<number>()

  for (const part of field.split(',')) {
    // `*` 或 `*/N`
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/)
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1
      if (step < 1) return null
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }

    // `N-M` 或 `N-M/S`
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10)
      const hi = parseInt(rangeMatch[2]!, 10)
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      // 周字段:范围里接受 7 作周日别名(如 5-7 = 五六日 → [5,6,0])
      const isDow = min === 0 && max === 6
      const effMax = isDow ? 7 : max
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i)
      }
      continue
    }

    // 纯数字 N
    const singleMatch = part.match(/^\d+$/)
    if (singleMatch) {
      let n = parseInt(part, 10)
      // 周字段:7 作周日别名 → 0
      if (min === 0 && max === 6 && n === 7) n = 0
      if (n < min || n > max) return null
      out.add(n)
      continue
    }

    return null
  }

  if (out.size === 0) return null
  return Array.from(out).sort((a, b) => a - b)
}

/** 解析 5 段 cron 表达式为展开后的数字数组。非法/不支持语法返回 null。 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    const result = expandField(parts[i]!, FIELD_RANGES[i]!)
    if (!result) return null
    expanded.push(result)
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  }
}

/** 某个具体日期是否命中 cron 字段(与 computeNextCronRun 同套 OR 日/周语义)。 */
export function cronFieldsMatch(fields: CronFields, date: Date): boolean {
  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7
  const dom = date.getDate()
  const dow = date.getDay()
  const dayMatches =
    domWild && dowWild
      ? true
      : domWild
        ? fields.dayOfWeek.includes(dow)
        : dowWild
          ? fields.dayOfMonth.includes(dom)
          : fields.dayOfMonth.includes(dom) || fields.dayOfWeek.includes(dow)
  return (
    fields.minute.includes(date.getMinutes()) &&
    fields.hour.includes(date.getHours()) &&
    dayMatches &&
    fields.month.includes(date.getMonth() + 1)
  )
}

/** 便捷:某个具体日期是否命中 cron 字符串。非法表达式 → false。 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = parseCronExpression(expr)
  return fields ? cronFieldsMatch(fields, date) : false
}

/**
 * 计算严格晚于 `from` 的、命中 cron 字段的下一个 Date(本地时区)。逐分钟前推,
 * 上界 366 天;无命中(合法 cron 不会发生,仅满足类型)返回 null。
 *
 * DST:定时(固定小时)cron 若指向春季前跳的缺口时刻,会跳过当天(缺口小时在本地时间不出现);
 * 通配小时 cron 在缺口后的首个合法分钟触发。与 vixie-cron 行为一致。
 */
export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
  const minuteSet = new Set(fields.minute)
  const hourSet = new Set(fields.hour)
  const domSet = new Set(fields.dayOfMonth)
  const monthSet = new Set(fields.month)
  const dowSet = new Set(fields.dayOfWeek)

  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7

  // 上取整到下一个整分钟(严格晚于 from)
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  const maxIter = 366 * 24 * 60
  for (let i = 0; i < maxIter; i++) {
    const month = t.getMonth() + 1
    if (!monthSet.has(month)) {
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    const dom = t.getDate()
    const dow = t.getDay()
    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(dow)
          : dowWild
            ? domSet.has(dom)
            : domSet.has(dom) || dowSet.has(dow)

    if (!dayMatches) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!hourSet.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!minuteSet.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1)
      continue
    }

    return t
  }

  return null
}

/**
 * cron 字符串在 `fromMs` 之后的下一次触发(epoch ms)。非法或 366 天内无命中返回 null。
 * 照搬 cc-haha cronTasks.ts `nextCronRunMs`。
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron)
  if (!fields) return null
  const next = computeNextCronRun(fields, new Date(fromMs))
  return next ? next.getTime() : null
}
