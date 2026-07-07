// 非流式 OpenAI-compatible chat 响应 → AccumulatedResponse(与流式同构)。
// 这是给不合规上游兜底的冷路径(05 清单②③同款不崩):流式那边畸形分片能靠"按行 try/catch 跳过"续命,
// 非流式只有一整个响应体、没有"跳过一行"的边界,必须逐字段自扛——message 整体缺失/tool_calls 缺 function/
// thinking_blocks 塞 null,任一个字段畸形都不该拖累整轮 agent turn 崩溃(见 openaiChatToAnthropic.test.ts)。
import type { OpenAIChatResponse } from './types'
import type { ToolCall } from '../types/message'
import type { AccumulatedResponse } from './streamAccumulate'
import { parseOpenAIToolArguments } from './toolArguments'
import { openaiUsageToAnthropic } from './usage'

let ID_SEQ = 0
const defaultIdFactory = (index: number): string => `call_${index}_${(ID_SEQ++).toString(36)}`

export function openaiChatResponseToAccumulated(
  resp: OpenAIChatResponse,
  opts: { idFactory?: (index: number) => string } = {},
): AccumulatedResponse {
  const idFactory = opts.idFactory ?? defaultIdFactory
  const usage = resp.usage ? openaiUsageToAnthropic(resp.usage) : undefined
  const choice = resp.choices?.[0]
  if (!choice) return { text: '', thinking: '', toolCalls: [], finishReason: null, usage }

  const message = choice.message
  if (!message) return { text: '', thinking: '', toolCalls: [], finishReason: choice.finish_reason ?? null, usage }

  const m = message as Record<string, unknown>
  let thinking = ''
  if (typeof m.reasoning_content === 'string' && m.reasoning_content) thinking = m.reasoning_content
  else if (typeof m.reasoning === 'string' && m.reasoning) thinking = m.reasoning
  else if (Array.isArray(m.thinking_blocks)) {
    for (const tb of m.thinking_blocks as unknown[]) {
      if (typeof tb !== 'object' || tb === null) continue // 坏形状(null/非对象)跳过,不解引用崩
      const rec = tb as Record<string, unknown>
      if (rec.type === 'thinking' && typeof rec.thinking === 'string') thinking += rec.thinking
    }
  }

  const text = typeof message.content === 'string' ? message.content : ''

  const rawToolCalls = message.tool_calls ?? []
  const toolCalls: ToolCall[] = []
  for (let i = 0; i < rawToolCalls.length; i++) {
    const tc = rawToolCalls[i]
    const fn = tc?.function
    const name = fn?.name
    if (!tc || !fn || !name) continue // 缺 function/name 的碎片丢弃(不是有效工具调用),同 streamAccumulate 对无 name 碎片的处理
    toolCalls.push({ id: tc.id || idFactory(i), name, input: parseOpenAIToolArguments(fn.arguments) })
  }

  return { text, thinking, toolCalls, finishReason: choice.finish_reason, usage }
}
