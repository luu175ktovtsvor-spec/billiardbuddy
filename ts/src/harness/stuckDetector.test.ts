import { describe, expect, test } from 'bun:test'
import { toolResultBlock, toolUseBlock, userText, type Message } from '../types/message'
import { callKey, detectStuck, MAX_TOTAL_TOOL_CALLS_NO_PROGRESS, sameCallGuardMessage } from './stuckDetector'

function pair(id: string, name: string, input: unknown, result = 'ok'): Message[] {
  return [
    { role: 'assistant', content: [toolUseBlock({ id, name, input })] },
    { role: 'user', content: [toolResultBlock(id, result)] },
  ]
}

describe('stuckDetector', () => {
  test('callKey 对 args 键序稳定', () => {
    expect(callKey('x', { b: 2, a: 1 })).toBe(callKey('x', { a: 1, b: 2 }))
  })

  test('连续 action_observation 触发软推', () => {
    const messages: Message[] = [
      userText('start'),
      ...pair('1', 'read_file', { path: 'a' }),
      ...pair('2', 'read_file', { path: 'a' }),
      ...pair('3', 'read_file', { path: 'a' }),
      ...pair('4', 'read_file', { path: 'a' }),
    ]
    const stuck = detectStuck(messages)
    expect(stuck?.pattern).toBe('action_observation')
    expect(stuck?.message).toContain('重复')
  })

  test('总工具调用超过 40 还没进展触发软推', () => {
    const stuck = detectStuck([userText('start')], { totalToolCallsNoProgress: MAX_TOTAL_TOOL_CALLS_NO_PROGRESS })
    expect(stuck?.pattern).toBe('too_many_tools')
  })

  test('sameCallGuardMessage 是硬拦回灌文本', () => {
    expect(sameCallGuardMessage('read_file')).toContain('连续重复调用 read_file')
  })
})
