import { describe, expect, test } from 'bun:test'
import { toolResultBlock, toolUseBlock, userText, type Message } from '../types/message'
import {
  callKey,
  CORE_SAME_CALL_LIMIT,
  detectStuck,
  EXTENSION_SAME_CALL_LIMIT,
  MAX_TOTAL_TOOL_CALLS_NO_PROGRESS,
  sameCallLimitForTool,
} from './stuckDetector'

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

  test('核心工具低阈值,扩展/MCP 工具高阈值', () => {
    expect(sameCallLimitForTool('read_file')).toBe(CORE_SAME_CALL_LIMIT)
    expect(sameCallLimitForTool('run_command')).toBe(CORE_SAME_CALL_LIMIT)
    expect(sameCallLimitForTool('mcp__fixture__import_many')).toBe(EXTENSION_SAME_CALL_LIMIT)
    expect(sameCallLimitForTool('custom_batch_tool')).toBe(EXTENSION_SAME_CALL_LIMIT)
  })

  test('扩展工具不会在核心工具阈值处误触发', () => {
    const early = [
      userText('start'),
      ...Array.from({ length: CORE_SAME_CALL_LIMIT }, (_, i) => pair(String(i), 'mcp__fixture__import_many', { batch: 1 })).flat(),
    ]
    expect(detectStuck(early)).toBeNull()

    const enough = [
      userText('start'),
      ...Array.from({ length: EXTENSION_SAME_CALL_LIMIT }, (_, i) => pair(String(i), 'mcp__fixture__import_many', { batch: 1 })).flat(),
    ]
    expect(detectStuck(enough)?.pattern).toBe('action_observation')
  })

  test('总工具调用超过 40 还没进展触发软推', () => {
    const stuck = detectStuck([userText('start')], { totalToolCallsNoProgress: MAX_TOTAL_TOOL_CALLS_NO_PROGRESS })
    expect(stuck?.pattern).toBe('too_many_tools')
  })
})
