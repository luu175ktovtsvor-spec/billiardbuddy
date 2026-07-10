import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../tools/Tool'
import { getPlanFilePath } from './plans'
import {
  collectReminders,
  drainSteering,
  extendTurns,
  PLAN_MODE_REMINDER,
  PROGRESS_REMIND_EVERY,
  steerBlock,
  STEER_MARK,
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
  test('drainSteering 清空 inbox 并返回原文(不碰 messages)', () => {
    const c = baseCtx({ steerInbox: ['改成蓝色', '再大一号'] })
    expect(drainSteering(c)).toEqual(['改成蓝色', '再大一号'])
    expect(c.steerInbox).toEqual([])
  })
  test('drainSteering 空 inbox 返回空数组', () => {
    expect(drainSteering(baseCtx())).toEqual([])
    expect(drainSteering(baseCtx({ steerInbox: [] }))).toEqual([])
  })
})

describe('steerBlock', () => {
  test('steerBlock 把插话包成带标记的 text 块', () => {
    expect(steerBlock('改蓝色')).toEqual({ type: 'text', text: `${STEER_MARK} 改蓝色` })
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
  test('plan 档(无工作区 root)→ 退回基础 plan 提醒', () => {
    const rs = collectReminders(baseCtx({ permissionMode: 'plan' }))
    expect(rs).toEqual([{ kind: 'plan', text: PLAN_MODE_REMINDER }])
  })
  test('plan 档(有工作区 root)→ plan 提醒带计划文件路径 + 工作流(唯一可编辑=计划文件、ExitPlanMode 收尾)', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-remind-'))
    try {
      const convId = 'reminder-plan'
      const planFilePath = getPlanFilePath(root, convId)
      const rs = collectReminders(baseCtx({
        permissionMode: 'plan',
        workspace: { root } as ToolContext['workspace'],
        conversationId: convId,
      }))
      const plan = rs.find(r => r.kind === 'plan')
      expect(plan?.text).toContain('计划模式')
      expect(plan?.text).toContain(planFilePath) // 系统提醒里含具体计划文件路径
      expect(plan?.text).toContain('ExitPlanMode') // 工作流:以 ExitPlanMode 收尾
      expect(plan?.text).toContain('write_file') // 唯一可编辑=计划文件、用 write_file/edit_file 写
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
