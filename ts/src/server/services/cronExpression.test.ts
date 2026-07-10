import { describe, expect, test } from 'bun:test'
import {
  computeNextCronRun,
  cronMatches,
  nextCronRunMs,
  parseCronExpression,
} from './cronExpression'

describe('parseCronExpression', () => {
  test('parses standard 5-field expressions', () => {
    expect(parseCronExpression('0 9 * * *')).toEqual({
      minute: [0],
      hour: [9],
      dayOfMonth: Array.from({ length: 31 }, (_, i) => i + 1),
      month: Array.from({ length: 12 }, (_, i) => i + 1),
      dayOfWeek: [0, 1, 2, 3, 4, 5, 6],
    })
  })

  test('expands step, range and list', () => {
    expect(parseCronExpression('*/15 * * * *')!.minute).toEqual([0, 15, 30, 45])
    expect(parseCronExpression('0 9 * * 1-5')!.dayOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parseCronExpression('0 9,12,18 * * *')!.hour).toEqual([9, 12, 18])
  })

  test('accepts 7 as Sunday alias', () => {
    expect(parseCronExpression('0 9 * * 7')!.dayOfWeek).toEqual([0])
    expect(parseCronExpression('0 9 * * 5-7')!.dayOfWeek).toEqual([0, 5, 6])
  })

  test('rejects malformed / out-of-range', () => {
    expect(parseCronExpression('0 9 * *')).toBeNull() // 4 fields
    expect(parseCronExpression('60 9 * * *')).toBeNull() // minute out of range
    expect(parseCronExpression('0 24 * * *')).toBeNull() // hour out of range
    expect(parseCronExpression('0 9 * * abc')).toBeNull()
    expect(parseCronExpression('')).toBeNull()
  })
})

describe('cronMatches', () => {
  test('daily 9am matches only at 9:00', () => {
    expect(cronMatches('0 9 * * *', new Date(2026, 6, 10, 9, 0, 0))).toBe(true)
    expect(cronMatches('0 9 * * *', new Date(2026, 6, 10, 9, 1, 0))).toBe(false)
    expect(cronMatches('0 9 * * *', new Date(2026, 6, 10, 10, 0, 0))).toBe(false)
  })

  test('weekday range 1-5 excludes weekend', () => {
    // 2026-07-10 is a Friday (dow 5), 2026-07-11 Saturday (dow 6)
    expect(cronMatches('0 9 * * 1-5', new Date(2026, 6, 10, 9, 0, 0))).toBe(true)
    expect(cronMatches('0 9 * * 1-5', new Date(2026, 6, 11, 9, 0, 0))).toBe(false)
  })

  test('OR semantics when both day-of-month and day-of-week constrained', () => {
    // "0 9 13 * 5" fires on the 13th OR on Fridays
    expect(cronMatches('0 9 13 * 5', new Date(2026, 6, 13, 9, 0, 0))).toBe(true) // 13th (Monday)
    expect(cronMatches('0 9 13 * 5', new Date(2026, 6, 10, 9, 0, 0))).toBe(true) // Friday, not 13th
    expect(cronMatches('0 9 13 * 5', new Date(2026, 6, 14, 9, 0, 0))).toBe(false) // neither
  })

  test('invalid expression never matches', () => {
    expect(cronMatches('nope', new Date())).toBe(false)
  })
})

describe('computeNextCronRun', () => {
  test('daily 9am rolls to next day when already past', () => {
    const from = new Date(2026, 6, 10, 10, 0, 0) // 10:00, past 9am
    const next = computeNextCronRun(parseCronExpression('0 9 * * *')!, from)!
    expect(next.getFullYear()).toBe(2026)
    expect(next.getMonth()).toBe(6)
    expect(next.getDate()).toBe(11)
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
  })

  test('daily 9am same day when before', () => {
    const from = new Date(2026, 6, 10, 8, 0, 0)
    const next = computeNextCronRun(parseCronExpression('0 9 * * *')!, from)!
    expect(next.getDate()).toBe(10)
    expect(next.getHours()).toBe(9)
  })

  test('is strictly after `from` (never returns the same minute)', () => {
    const from = new Date(2026, 6, 10, 9, 0, 0)
    const next = computeNextCronRun(parseCronExpression('0 9 * * *')!, from)!
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getDate()).toBe(11)
  })

  test('weekly Monday finds the next Monday', () => {
    const from = new Date(2026, 6, 10, 9, 30, 0) // Friday
    const next = computeNextCronRun(parseCronExpression('0 9 * * 1')!, from)!
    expect(next.getDay()).toBe(1) // Monday
    expect(next.getDate()).toBe(13)
  })

  test('nextCronRunMs returns null for invalid cron', () => {
    expect(nextCronRunMs('bad expr', Date.now())).toBeNull()
  })
})
