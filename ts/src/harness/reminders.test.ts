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
      expect(plan?.text).toContain('plan mode')
      expect(plan?.text).toContain(planFilePath) // 系统提醒里含具体计划文件路径
      expect(plan?.text).toContain('ExitPlanMode') // 工作流:以 ExitPlanMode 收尾
      expect(plan?.text).toContain('write_file') // 唯一可编辑=计划文件、用 write_file/edit_file 写
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('plan 提醒节流(对齐 cc):首批(count=0)发,非整数倍批次不发,每 5 批一次', () => {
    const at = (planModeTurnCount: number) =>
      collectReminders(baseCtx({ permissionMode: 'plan', planModeTurnCount })).some(r => r.kind === 'plan')
    expect(at(0)).toBe(true)   // 首批必发
    expect(at(1)).toBe(false)  // 非整数倍 → 不发(不再每批必发)
    expect(at(3)).toBe(false)
    expect(at(5)).toBe(true)   // 每 5 批一次
    expect(at(10)).toBe(true)
  })

  test('verify_plan 提醒节流(对齐 cc):到 N/2N/3N 各发一次,不再跨阈值后每批无限重复', () => {
    const at = (toolCallsSinceApproval: number) =>
      collectReminders(baseCtx({ pendingPlanVerification: { verificationCompleted: false, toolCallsSinceApproval } as ToolContext['pendingPlanVerification'] }))
        .some(r => r.kind === 'verify_plan')
    expect(at(1)).toBe(false)  // 未到阈值
    expect(at(3)).toBe(true)   // 到 N → 发
    expect(at(4)).toBe(false)  // N+1 → 不再每批发(旧 bug:≥N 每批无限重复)
    expect(at(5)).toBe(false)
    expect(at(6)).toBe(true)   // 2N → 再发
  })
})
