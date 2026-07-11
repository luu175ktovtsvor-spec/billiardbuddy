import { afterEach, describe, expect, test } from 'bun:test'
import {
  actionKey,
  clearApproval,
  clearLocalApproval,
  createDenialTrackingState,
  recordApproval,
  recordLocalApproval,
  resetDenialStore,
  shouldAutoApprove,
  shouldLocalAutoApprove,
} from './denialTracking'

// 2026-07-12 对齐 cc 移除"拒绝计数/静默拒答"后,本模块只剩「本次对话都允许」的正向记忆。
afterEach(() => resetDenialStore())

describe('denialTracking(仅「本次对话都允许」记忆)', () => {
  test('actionKey 对 args 键序不敏感(同参→同 key)', () => {
    expect(actionKey('t', { a: 1, b: 2 })).toBe(actionKey('t', { b: 2, a: 1 }))
    expect(actionKey('t', { a: 1 })).not.toBe(actionKey('t', { a: 2 }))
  })

  test('actionKey 故障安全:循环引用 args 不抛,返稳定回退', () => {
    const c: any = {}
    c.self = c // 循环引用 → stableStringify 递归爆栈
    expect(() => actionKey('t', c as unknown)).not.toThrow()
    expect(actionKey('t', c as unknown)).toBe('t:<unserializable>')
  })

  test('本次对话都允许:记一次 → 同参自动放行;清掉 → 恢复要问', () => {
    const k = actionKey('publish', { id: 1 })
    expect(shouldAutoApprove('c1', k)).toBe(false)
    recordApproval('c1', k)
    expect(shouldAutoApprove('c1', k)).toBe(true)
    clearApproval('c1', k)
    expect(shouldAutoApprove('c1', k)).toBe(false)
  })

  test('会话隔离 + 未知会话 → false', () => {
    const k = actionKey('publish', {})
    recordApproval('c4', k)
    expect(shouldAutoApprove('c4', k)).toBe(true)
    expect(shouldAutoApprove('c5', k)).toBe(false) // 别的会话不受影响
    expect(shouldAutoApprove(undefined, k)).toBe(false)
  })

  test('子代理 local state 的审批记忆与父会话隔离', () => {
    const k = actionKey('publish', { id: 1 })
    const localA = createDenialTrackingState()
    const localB = createDenialTrackingState()
    recordLocalApproval(localA, k)
    expect(shouldLocalAutoApprove(localA, k)).toBe(true)
    expect(shouldLocalAutoApprove(localB, k)).toBe(false)
    expect(shouldAutoApprove('parent', k)).toBe(false) // 父会话进程内存储不受 local 影响
    clearLocalApproval(localA, k)
    expect(shouldLocalAutoApprove(localA, k)).toBe(false)
  })
})
