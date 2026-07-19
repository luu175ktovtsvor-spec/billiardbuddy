import { describe, expect, test } from 'bun:test'
import { parseThinkingMode, sawReasoningInSse } from './real-loadtest'

describe('real upstream loadtest thinking-mode guard', () => {
  test('allows only the two documented DeepSeek thinking values', () => {
    expect(parseThinkingMode(undefined)).toBeUndefined()
    expect(parseThinkingMode('enabled')).toBe('enabled')
    expect(parseThinkingMode('disabled')).toBe('disabled')
    expect(() => parseThinkingMode('adaptive')).toThrow('--thinking must be enabled or disabled')
  })

  test('counts only the reasoning protocol field and never parses or emits its value', () => {
    expect(sawReasoningInSse('data: {"choices":[{"delta":{"reasoning_content":"private"}}]}')).toBe(true)
    expect(sawReasoningInSse('data: {"choices":[{"delta":{"content":"OK"}}]}')).toBe(false)
  })
})
