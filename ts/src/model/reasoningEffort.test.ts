import { expect, test } from 'bun:test'
import { normalizeReasoningEffort, anthropicModelUsesAdaptiveThinking, buildAnthropicThinking } from './reasoningEffort'

test('normalizeReasoningEffort: max 映射 high,非法值丢弃', () => {
  expect(normalizeReasoningEffort('low')).toBe('low')
  expect(normalizeReasoningEffort('max')).toBe('high')
  expect(normalizeReasoningEffort('extreme')).toBeUndefined()
})

test('anthropicModelUsesAdaptiveThinking: 现代 Claude 走 adaptive,旧族/minimax/未知走 budget', () => {
  // 现代 Claude → adaptive(这些模型对 budget_tokens 会 400)
  expect(anthropicModelUsesAdaptiveThinking('claude-opus-4-7')).toBe(true)
  expect(anthropicModelUsesAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
  expect(anthropicModelUsesAdaptiveThinking('claude-opus-4-8')).toBe(true)
  expect(anthropicModelUsesAdaptiveThinking('claude-fable-5')).toBe(true)
  // 旧族/非 adaptive → budget_tokens
  expect(anthropicModelUsesAdaptiveThinking('claude-haiku-4-5')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('claude-sonnet-4-5')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('claude-opus-4-5')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('claude-3-5-sonnet')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('minimax-m3')).toBe(false)
  // 未知非 Claude 端点 → 保守 budget_tokens
  expect(anthropicModelUsesAdaptiveThinking('some-domestic-model')).toBe(false)
})

test('buildAnthropicThinking: 未选深度思考 → undefined(不带 thinking)', () => {
  expect(buildAnthropicThinking(undefined, 'claude-opus-4-7', 4096)).toBeUndefined()
})

test('buildAnthropicThinking: 现代 Claude + 深度思考 → adaptive', () => {
  expect(buildAnthropicThinking('high', 'claude-opus-4-7', 4096)).toEqual({ type: 'adaptive' })
  expect(buildAnthropicThinking('low', 'claude-sonnet-4-6', 4096)).toEqual({ type: 'adaptive' })
})

test('buildAnthropicThinking: budget 模型 → enabled+budget_tokens,按 max_tokens 夹紧(< max_tokens 且留答复空间)', () => {
  // max_tokens 宽裕:effort 有区分度
  expect(buildAnthropicThinking('low', 'claude-haiku-4-5', 32_000)).toEqual({ type: 'enabled', budget_tokens: 2_048 })
  expect(buildAnthropicThinking('medium', 'claude-haiku-4-5', 32_000)).toEqual({ type: 'enabled', budget_tokens: 8_192 })
  expect(buildAnthropicThinking('high', 'claude-haiku-4-5', 32_000)).toEqual({ type: 'enabled', budget_tokens: 16_000 })
  // max_tokens=4096(默认):夹紧到给答复留一半(2048),budget < max_tokens
  const t = buildAnthropicThinking('high', 'minimax-m3', 4096)
  expect(t).toEqual({ type: 'enabled', budget_tokens: 2_048 })
})

test('buildAnthropicThinking: max_tokens 太小放不下 thinking → undefined(避免 400/答复饿死)', () => {
  expect(buildAnthropicThinking('high', 'claude-haiku-4-5', 1_500)).toBeUndefined()
})
