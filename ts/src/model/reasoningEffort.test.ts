import { expect, test } from 'bun:test'
import { normalizeReasoningEffort } from './reasoningEffort'

test('normalizeReasoningEffort: max 映射 high,非法值丢弃', () => {
  expect(normalizeReasoningEffort('low')).toBe('low')
  expect(normalizeReasoningEffort('max')).toBe('high')
  expect(normalizeReasoningEffort('extreme')).toBeUndefined()
})
