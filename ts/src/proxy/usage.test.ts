import { test, expect } from 'bun:test'
import { openaiUsageToAnthropic } from './usage'

test('undefined → 0/0', () => {
  expect(openaiUsageToAnthropic(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 })
})
test('chat 字段 prompt/completion 映射', () => {
  expect(openaiUsageToAnthropic({ prompt_tokens: 100, completion_tokens: 20 }))
    .toEqual({ input_tokens: 100, output_tokens: 20 })
})
test('cache 命中从 input 扣除保持 Anthropic 不变式', () => {
  const u = openaiUsageToAnthropic({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } })
  expect(u).toEqual({ input_tokens: 70, output_tokens: 5, cache_read_input_tokens: 30 })
})
