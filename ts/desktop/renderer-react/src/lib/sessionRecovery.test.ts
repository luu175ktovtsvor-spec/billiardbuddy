// 会话自恢复选择逻辑:上次活跃(仍在列表)优先 → 否则最近更新的一条 → 都没有则 null(开新会话)。
import { expect, test } from 'bun:test'
import { pickSessionToRestore } from './sessionRecovery'
import type { SessionSummary } from '../types/chat'

const s = (id: string, updatedAt: number): SessionSummary => ({ id, updatedAt, title: `t-${id}` })

// 约定:入参已按 updatedAt 降序(后端 /sessions 保证)。
const sessions: SessionSummary[] = [s('recent', 300), s('mid', 200), s('old', 100)]

test('上次活跃会话仍在列表 → 恢复它(即便不是最近更新的)', () => {
  expect(pickSessionToRestore(sessions, 'mid')?.id).toBe('mid')
})

test('上次活跃会话已不在列表 → 回退到最近更新的一条', () => {
  expect(pickSessionToRestore(sessions, 'gone')?.id).toBe('recent')
})

test('没有上次活跃记录 → 回退到最近更新的一条', () => {
  expect(pickSessionToRestore(sessions, null)?.id).toBe('recent')
})

test('列表为空 → null(交给调用方开新会话)', () => {
  expect(pickSessionToRestore([], 'mid')).toBeNull()
  expect(pickSessionToRestore(null, null)).toBeNull()
  expect(pickSessionToRestore(undefined, 'x')).toBeNull()
})
