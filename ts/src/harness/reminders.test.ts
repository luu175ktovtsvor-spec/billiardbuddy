import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message'
import type { ToolContext } from '../tools/Tool'
import {
  collectReminders,
  drainSteering,
  extendTurns,
  PLAN_MODE_REMINDER,
  PROGRESS_REMIND_EVERY,
  wrapReminder,
} from './reminders'

const baseCtx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ workspace: {} as ToolContext['workspace'], ...over }) as ToolContext

describe('wrapReminder', () => {
  test('XML 包壳', () => {
    expect(wrapReminder('嗨')).toBe('<system-reminder>\n嗨\n</system-reminder>')
  })
})

describe('drainSteering', () => {
  test('取空 inbox、append [用户补充/纠偏] 用户消息、返回原文', () => {
    const messages: Message[] = []
    const ctx = baseCtx({ steerInbox: ['先别删', '改成蓝色'] })
    const drained = drainSteering(messages, ctx)
    expect(drained).toEqual(['先别删', '改成蓝色'])
    expect(ctx.steerInbox).toEqual([]) // 原地取空(路由持同一引用)
    expect(messages).toEqual([
      { role: 'user', content: '[用户补充/纠偏] 先别删' },
      { role: 'user', content: '[用户补充/纠偏] 改成蓝色' },
    ])
  })
  test('空 inbox → 不动 messages、返回 []', () => {
    const messages: Message[] = []
    expect(drainSteering(messages, baseCtx({ steerInbox: [] }))).toEqual([])
    expect(drainSteering(messages, baseCtx())).toEqual([])
    expect(messages).toEqual([])
  })
})

describe('extendTurns', () => {
  test('每批 +2,封顶 maxTurns + floor(maxTurns/2)', () => {
    expect(extendTurns(12, 12, 1)).toBe(14)
    expect(extendTurns(17, 12, 1)).toBe(18) // 封顶 12+6=18
    expect(extendTurns(18, 12, 1)).toBe(18)
  })
})

describe('collectReminders', () => {
  test('进度到阈值 → progress 提醒(含百分比),纯读不清零', () => {
    const ctx = baseCtx({
      requestsSinceProgress: PROGRESS_REMIND_EVERY,
      todos: [
        { task: 'a', status: 'done' },
        { task: 'b', status: 'pending' },
      ],
    })
    const rs = collectReminders(ctx)
    expect(rs.some(r => r.kind === 'progress' && r.text.includes('50%'))).toBe(true)
    expect(ctx.requestsSinceProgress).toBe(PROGRESS_REMIND_EVERY) // collect 不清零(循环做)
  })
  test('未到阈值 + 非 plan 档 → 空', () => {
    expect(collectReminders(baseCtx({ requestsSinceProgress: 1 }))).toEqual([])
  })
  test('plan 档 → plan 提醒', () => {
    const rs = collectReminders(baseCtx({ permissionMode: 'plan' }))
    expect(rs).toEqual([{ kind: 'plan', text: PLAN_MODE_REMINDER }])
  })
})
