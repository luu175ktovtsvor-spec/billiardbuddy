import { expect, test } from 'bun:test'
import { normalizeReasoningEffort, anthropicModelUsesAdaptiveThinking, buildAnthropicThinking, thinkingModeEnvOverride } from './reasoningEffort'

test('normalizeReasoningEffort: max 映射 high,非法值丢弃', () => {
  expect(normalizeReasoningEffort('low')).toBe('low')
  expect(normalizeReasoningEffort('max')).toBe('high')
  expect(normalizeReasoningEffort('extreme')).toBeUndefined()
})

test('anthropicModelUsesAdaptiveThinking: 现代 Claude + MiniMax 走 adaptive,旧族/未知走 budget', () => {
  // 现代 Claude → adaptive(这些模型对 budget_tokens 会 400)
  expect(anthropicModelUsesAdaptiveThinking('claude-opus-4-7')).toBe(true)
  expect(anthropicModelUsesAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
  expect(anthropicModelUsesAdaptiveThinking('claude-opus-4-8')).toBe(true)
  expect(anthropicModelUsesAdaptiveThinking('claude-fable-5')).toBe(true)
  // MiniMax 官方 Anthropic 兼容端点只认 adaptive(不认 budget_tokens)→ adaptive
  expect(anthropicModelUsesAdaptiveThinking('minimax-m3')).toBe(true)
  expect(anthropicModelUsesAdaptiveThinking('MiniMax-M3')).toBe(true)
  // 旧族/非 adaptive → budget_tokens
  expect(anthropicModelUsesAdaptiveThinking('claude-haiku-4-5')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('claude-sonnet-4-5')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('claude-opus-4-5')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('claude-3-5-sonnet')).toBe(false)
  // 未知非 Claude 端点(含 Xiaomi MiMo 的 anthropic 端点,只认 {type:enabled|disabled})→ 保守 budget_tokens
  expect(anthropicModelUsesAdaptiveThinking('mimo-v2.5')).toBe(false)
  expect(anthropicModelUsesAdaptiveThinking('some-domestic-model')).toBe(false)
})

test('thinkingModeEnvOverride: 解析 adaptive/budget/off 及别名,非法值/未设 → undefined', () => {
  expect(thinkingModeEnvOverride({ ANTHROPIC_THINKING_MODE: 'adaptive' })).toBe('adaptive')
  expect(thinkingModeEnvOverride({ ANTHROPIC_THINKING_MODE: 'budget' })).toBe('budget')
  expect(thinkingModeEnvOverride({ ANTHROPIC_THINKING_MODE: 'enabled' })).toBe('budget')
  expect(thinkingModeEnvOverride({ ANTHROPIC_THINKING_MODE: 'OFF' })).toBe('off')
  expect(thinkingModeEnvOverride({ ANTHROPIC_THINKING_MODE: 'disabled' })).toBe('off')
  expect(thinkingModeEnvOverride({ ANTHROPIC_THINKING_MODE: 'bogus' })).toBeUndefined()
  expect(thinkingModeEnvOverride({})).toBeUndefined()
})

test('buildAnthropicThinking: ANTHROPIC_THINKING_MODE 覆盖 per-model 判定', () => {
  // 覆盖成 adaptive:本该 budget 的 haiku 也发 adaptive
  expect(buildAnthropicThinking('high', 'claude-haiku-4-5', 32_000, { ANTHROPIC_THINKING_MODE: 'adaptive' }))
    .toEqual({ type: 'adaptive' })
  // 覆盖成 budget:本该 adaptive 的 minimax 也发 budget_tokens
  expect(buildAnthropicThinking('low', 'minimax-m3', 32_000, { ANTHROPIC_THINKING_MODE: 'budget' }))
    .toEqual({ type: 'enabled', budget_tokens: 2_048 })
  // 覆盖成 off:即便选了深度思考也不带 thinking
  expect(buildAnthropicThinking('high', 'claude-opus-4-7', 32_000, { ANTHROPIC_THINKING_MODE: 'off' }))
    .toBeUndefined()
})

test('buildAnthropicThinking: 未选深度思考 → undefined(不带 thinking)', () => {
  expect(buildAnthropicThinking(undefined, 'claude-opus-4-7', 4096)).toBeUndefined()
})

test('buildAnthropicThinking: 现代 Claude / MiniMax + 深度思考 → adaptive', () => {
  expect(buildAnthropicThinking('high', 'claude-opus-4-7', 4096)).toEqual({ type: 'adaptive' })
  expect(buildAnthropicThinking('low', 'claude-sonnet-4-6', 4096)).toEqual({ type: 'adaptive' })
  // MiniMax:官方 Anthropic 兼容端点只认 adaptive,即便 max_tokens 很小也发 adaptive(不带预算,不会因夹紧被跳过)
  expect(buildAnthropicThinking('high', 'minimax-m3', 4096)).toEqual({ type: 'adaptive' })
})

test('buildAnthropicThinking: budget 模型 → enabled+budget_tokens,按 max_tokens 夹紧(< max_tokens 且留答复空间)', () => {
  // max_tokens 宽裕:effort 有区分度
  expect(buildAnthropicThinking('low', 'claude-haiku-4-5', 32_000)).toEqual({ type: 'enabled', budget_tokens: 2_048 })
  expect(buildAnthropicThinking('medium', 'claude-haiku-4-5', 32_000)).toEqual({ type: 'enabled', budget_tokens: 8_192 })
  expect(buildAnthropicThinking('high', 'claude-haiku-4-5', 32_000)).toEqual({ type: 'enabled', budget_tokens: 16_000 })
  // max_tokens=4096(默认):夹紧到给答复留一半(2048),budget < max_tokens(未知非 Claude 端点走 budget 兜底)
  const t = buildAnthropicThinking('high', 'some-domestic-model', 4096)
  expect(t).toEqual({ type: 'enabled', budget_tokens: 2_048 })
})

test('buildAnthropicThinking: max_tokens 太小放不下 thinking → undefined(避免 400/答复饿死)', () => {
  expect(buildAnthropicThinking('high', 'claude-haiku-4-5', 1_500)).toBeUndefined()
})
