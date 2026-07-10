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

// —— 掰回 cc 分叉:thinking 默认开、与 reasoningEffort 解耦(对齐 cc claude.ts:1653-1736)——

test('buildAnthropicThinking: 默认(无 disable env)→ 发 thinking(不再由是否选深度思考决定)', () => {
  // adaptive 模型:默认就发 adaptive(过去要 reasoningEffort 才发,现在默认开)
  expect(buildAnthropicThinking('claude-opus-4-7', 4096)).toEqual({ type: 'adaptive' })
  // budget 模型:默认就发模型默认预算(= maxTokens-1)
  expect(buildAnthropicThinking('some-domestic-model', 32_000)).toEqual({ type: 'enabled', budget_tokens: 31_999 })
})

test('buildAnthropicThinking: CLAUDE_CODE_DISABLE_THINKING 真值 → 不发 thinking(等价 cc 关闭闸)', () => {
  expect(buildAnthropicThinking('claude-opus-4-7', 4096, { CLAUDE_CODE_DISABLE_THINKING: '1' })).toBeUndefined()
  expect(buildAnthropicThinking('claude-opus-4-7', 4096, { CLAUDE_CODE_DISABLE_THINKING: 'true' })).toBeUndefined()
  expect(buildAnthropicThinking('some-domestic-model', 32_000, { CLAUDE_CODE_DISABLE_THINKING: 'yes' })).toBeUndefined()
  // 非真值(如空串/0/随意字符串)不关闭 → 仍默认发 thinking
  expect(buildAnthropicThinking('claude-opus-4-7', 4096, { CLAUDE_CODE_DISABLE_THINKING: '0' })).toEqual({ type: 'adaptive' })
  expect(buildAnthropicThinking('claude-opus-4-7', 4096, { CLAUDE_CODE_DISABLE_THINKING: '' })).toEqual({ type: 'adaptive' })
})

test('buildAnthropicThinking: ANTHROPIC_THINKING_MODE=off(别名 disabled/none)→ 不发 thinking', () => {
  expect(buildAnthropicThinking('claude-opus-4-7', 32_000, { ANTHROPIC_THINKING_MODE: 'off' })).toBeUndefined()
  expect(buildAnthropicThinking('claude-opus-4-7', 32_000, { ANTHROPIC_THINKING_MODE: 'disabled' })).toBeUndefined()
  expect(buildAnthropicThinking('some-domestic-model', 32_000, { ANTHROPIC_THINKING_MODE: 'none' })).toBeUndefined()
})

test('buildAnthropicThinking: adaptive 模型发 adaptive、budget 模型发默认预算(maxTokens-1)', () => {
  // adaptive:现代 Claude,不带预算,即便 max_tokens 很小也发 adaptive(不因夹紧被跳过)
  expect(buildAnthropicThinking('claude-opus-4-7', 4096)).toEqual({ type: 'adaptive' })
  expect(buildAnthropicThinking('claude-sonnet-4-6', 500)).toEqual({ type: 'adaptive' })
  // budget:旧 Claude 族/未知端点 → 模型默认预算 = maxTokens-1(对齐 cc getMaxThinkingTokensForModel + Math.min 夹紧)
  expect(buildAnthropicThinking('claude-haiku-4-5', 32_000)).toEqual({ type: 'enabled', budget_tokens: 31_999 })
  expect(buildAnthropicThinking('claude-haiku-4-5', 4096)).toEqual({ type: 'enabled', budget_tokens: 4_095 })
  expect(buildAnthropicThinking('some-domestic-model', 4096)).toEqual({ type: 'enabled', budget_tokens: 4_095 })
})

test('buildAnthropicThinking: minimax 仍 adaptive(官方端点只认 adaptive,保留 commit 52a19a2)', () => {
  expect(buildAnthropicThinking('minimax-m3', 4096)).toEqual({ type: 'adaptive' })
  expect(buildAnthropicThinking('MiniMax-M3', 32_000)).toEqual({ type: 'adaptive' })
})

test('buildAnthropicThinking: ANTHROPIC_THINKING_MODE 覆盖 per-model 判定(adaptive/budget)', () => {
  // 覆盖成 adaptive:本该 budget 的 haiku 也发 adaptive
  expect(buildAnthropicThinking('claude-haiku-4-5', 32_000, { ANTHROPIC_THINKING_MODE: 'adaptive' }))
    .toEqual({ type: 'adaptive' })
  // 覆盖成 budget:本该 adaptive 的 minimax 也发 budget_tokens(= maxTokens-1)
  expect(buildAnthropicThinking('minimax-m3', 32_000, { ANTHROPIC_THINKING_MODE: 'budget' }))
    .toEqual({ type: 'enabled', budget_tokens: 31_999 })
})

test('buildAnthropicThinking: max_tokens 太小放不下 thinking(budget < 1024)→ undefined(避免 400)', () => {
  // budget 模型 + maxTokens<=1024:预算 = maxTokens-1 < 1024 → 跳过,免 400
  expect(buildAnthropicThinking('claude-haiku-4-5', 1_000)).toBeUndefined()
  expect(buildAnthropicThinking('claude-haiku-4-5', 1_024)).toBeUndefined()
  // 恰好放得下(1025-1=1024)→ 发
  expect(buildAnthropicThinking('claude-haiku-4-5', 1_025)).toEqual({ type: 'enabled', budget_tokens: 1_024 })
})
