import { expect, test } from 'bun:test'
import {
  getBuiltInModelContextWindow,
  getConfiguredOrBuiltInModelContextWindow,
  getModelContextWindowFromEnvValue,
  normalizeModelContextKey,
} from './modelContextWindows'

test('normalizeModelContextKey 去掉 1m 标记并小写', () => {
  expect(normalizeModelContextKey('Anthropic/Claude-Opus-4.7[1m]')).toBe('anthropic/claude-opus-4.7')
})

test('配置窗口优先于内置窗口,且支持后缀匹配', () => {
  const raw = JSON.stringify({ 'mimo-v2.5': 123456, 'qwen3-coder-plus': 999999 })
  expect(getModelContextWindowFromEnvValue('gateway/mimo-v2.5', raw)).toBe(123456)
  expect(getConfiguredOrBuiltInModelContextWindow('qwen/qwen3-coder-plus', { CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: raw })).toBe(999999)
})

test('内置窗口覆盖当前默认模型', () => {
  expect(getBuiltInModelContextWindow('mimo-v2.5')).toBe(1_000_000)
  expect(getBuiltInModelContextWindow('openai/gpt-5.1')).toBe(400_000)
})
