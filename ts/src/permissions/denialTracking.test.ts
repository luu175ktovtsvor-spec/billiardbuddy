import { afterEach, describe, expect, test } from 'bun:test'
import {
  actionKey,
  clearLocalDenial,
  createDenialTrackingState,
  DENIAL_FALLBACK,
  recordLocalApproval,
  recordLocalDenial,
  clearDenial,
  recordDenial,
  resetDenialStore,
  shouldLocalAutoApprove,
  shouldLocalStopAsking,
  shouldStopAsking,
} from './denialTracking'

afterEach(() => resetDenialStore())

describe('denialTracking', () => {
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

  test('同一动作连续拒 2 次 → shouldStopAsking', () => {
    const k = actionKey('publish', { id: 1 })
    expect(shouldStopAsking('c1', k)).toBe(false)
    recordDenial('c1', k)
    expect(shouldStopAsking('c1', k)).toBe(false) // 拒 1 次还没到
    recordDenial('c1', k)
    expect(shouldStopAsking('c1', k)).toBe(true) // 拒 2 次到阈值
  })

  test('全局累计 20 次(换参数接着烦)→ 对新动作也 stop', () => {
    for (let i = 0; i < DENIAL_FALLBACK.global; i++) recordDenial('c2', actionKey('publish', { i }))
    expect(shouldStopAsking('c2', actionKey('publish', { i: 999 }))).toBe(true)
  })

  test('确认成功 clearDenial → 该动作 + 全局都清零', () => {
    const k = actionKey('publish', { id: 1 })
    recordDenial('c3', k)
    recordDenial('c3', k)
    expect(shouldStopAsking('c3', k)).toBe(true)
    clearDenial('c3', k)
    expect(shouldStopAsking('c3', k)).toBe(false)
    // 全局也归零:凑够 19 次后再一次不应触发全局(因为 clear 把 total 清了)
    for (let i = 0; i < 19; i++) recordDenial('c3', actionKey('x', { i }))
    expect(shouldStopAsking('c3', actionKey('y', {}))).toBe(false)
  })

  test('会话隔离 + 未知会话 → false', () => {
    const k = actionKey('publish', {})
    recordDenial('c4', k)
    recordDenial('c4', k)
    expect(shouldStopAsking('c4', k)).toBe(true)
    expect(shouldStopAsking('c5', k)).toBe(false) // 别的会话不受影响
    expect(shouldStopAsking(undefined, k)).toBe(false)
  })

  test('local state keeps subagent denial and approval memory isolated', () => {
    const k = actionKey('publish', { id: 1 })
    const localA = createDenialTrackingState()
    const localB = createDenialTrackingState()
    recordDenial('parent', k)
    recordDenial('parent', k)

    expect(shouldLocalStopAsking(localA, k)).toBe(false)
    recordLocalDenial(localA, k)
    recordLocalDenial(localA, k)
    expect(shouldLocalStopAsking(localA, k)).toBe(true)
    expect(shouldLocalStopAsking(localB, k)).toBe(false)
    expect(shouldStopAsking('parent', k)).toBe(true)

    clearLocalDenial(localA, k)
    expect(shouldLocalStopAsking(localA, k)).toBe(false)
    recordLocalApproval(localA, k)
    expect(shouldLocalAutoApprove(localA, k)).toBe(true)
    expect(shouldLocalAutoApprove(localB, k)).toBe(false)
  })
})
