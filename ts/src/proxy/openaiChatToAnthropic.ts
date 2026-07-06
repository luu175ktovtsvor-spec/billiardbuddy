// 逻辑照 cc-haha src/server/proxy/transform/openaiChatToAnthropic.ts。非流式 chat 响应 → AccumulatedResponse(与流式同构)。
import type { OpenAIChatResponse } from './types'
import type { ToolCall } from '../types/message'
import type { AccumulatedResponse } from './streamAccumulate'
import { parseOpenAIToolArguments } from './toolArguments'
import { openaiUsageToAnthropic } from './usage'

export function openaiChatResponseToAccumulated(resp: OpenAIChatResponse): AccumulatedResponse {
  const usage = openaiUsageToAnthropic(resp.usage)
  const choice = resp.choices?.[0]
  if (!choice) return { text: '', thinking: '', toolCalls: [], finishReason: null, usage }

  const m = choice.message as Record<string, unknown>
  let thinking = ''
  if (typeof m.reasoning_content === 'string' && m.reasoning_content) thinking = m.reasoning_content
  else if (typeof m.reasoning === 'string' && m.reasoning) thinking = m.reasoning
  else if (Array.isArray(m.thinking_blocks)) {
    for (const tb of m.thinking_blocks as Array<Record<string, unknown>>) {
      if (tb.type === 'thinking' && typeof tb.thinking === 'string') thinking += tb.thinking
    }
  }

  const text = typeof choice.message.content === 'string' ? choice.message.content : ''
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: parseOpenAIToolArguments(tc.function.arguments),
  }))

  return { text, thinking, toolCalls, finishReason: choice.finish_reason, usage }
}
