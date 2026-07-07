// OpenAI input 含 cache、Anthropic input 排除 → 扣减保不变式。
import type { OpenAICompatibleUsage, AnthropicUsage } from './types'

export function openaiUsageToAnthropic(usage: OpenAICompatibleUsage | undefined): AnthropicUsage {
  if (!usage) return { input_tokens: 0, output_tokens: 0 }
  const input = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? 0
  const cacheCreation = usage.cache_creation_input_tokens ?? 0
  const result: AnthropicUsage = {
    input_tokens: cacheRead > 0 || cacheCreation > 0 ? Math.max(0, input - cacheRead - cacheCreation) : input,
    output_tokens: output,
  }
  if (cacheRead > 0) result.cache_read_input_tokens = cacheRead
  if (cacheCreation > 0) result.cache_creation_input_tokens = cacheCreation
  return result
}
