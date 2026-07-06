/**
 * OpenAI Chat Completions SSE 流 → 内部块累积(不崩心脏)。
 * 逻辑照 cc-haha src/server/proxy/streaming/openaiChatStreamToAnthropic.ts 的分片累积/reasoning 归一,
 * 但目标是把结果累积成我们的 AssistantStep 素材(text/thinking/toolCalls),不 emit Anthropic SSE。
 * 不崩要点(05 清单②③):按 index 累 tool_call 分片、缺 id 收尾自造、reasoning 三方言归一、坏行跳过。
 */
import type { ToolCall } from '../types/message'
import type { OpenAIChatStreamChunk, AnthropicUsage } from './types'
import { parseOpenAIToolArguments, stringifyOpenAIToolArguments } from './toolArguments'
import { openaiUsageToAnthropic } from './usage'

export interface AccumulatedResponse {
  text: string
  thinking: string
  toolCalls: ToolCall[]
  finishReason: string | null
  usage: AnthropicUsage
}

type ToolFrag = { id: string; name: string; argsBuffer: string; order: number }

let ID_SEQ = 0
const defaultIdFactory = (index: number): string => `call_${index}_${(ID_SEQ++).toString(36)}`

/** reasoning 多方言归一:reasoning_content(MiMo/豆包)/reasoning(GLM)/thinking_blocks(o系)。 */
function extractReasoning(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return delta.reasoning_content
  if (typeof delta.reasoning === 'string' && delta.reasoning) return delta.reasoning
  const tb = delta.thinking_blocks as Array<Record<string, unknown>> | undefined
  if (Array.isArray(tb) && tb.length > 0 && tb[0]!.type === 'thinking' && typeof tb[0]!.thinking === 'string') {
    return tb[0]!.thinking as string
  }
  return ''
}

export async function accumulateOpenAiStream(
  stream: ReadableStream<Uint8Array>,
  opts: { idFactory?: (index: number) => string } = {},
): Promise<AccumulatedResponse> {
  const idFactory = opts.idFactory ?? defaultIdFactory
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''

  let text = ''
  let thinking = ''
  let finishReason: string | null = null
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }
  const tools = new Map<number, ToolFrag>()
  let orderSeq = 0

  const handleChunk = (chunk: OpenAIChatStreamChunk): void => {
    if (chunk.usage) usage = openaiUsageToAnthropic(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice) return
    const delta = (choice.delta ?? {}) as Record<string, unknown>

    if (typeof delta.content === 'string' && delta.content) text += delta.content
    thinking += extractReasoning(delta)

    const toolCalls = delta.tool_calls as OpenAIChatStreamChunk['choices'][number]['delta']['tool_calls']
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        let frag = tools.get(tc.index)
        if (!frag) { frag = { id: '', name: '', argsBuffer: '', order: orderSeq++ }; tools.set(tc.index, frag) }
        if (tc.id) frag.id = tc.id
        if (tc.function?.name) frag.name += tc.function.name
        const argDelta = stringifyOpenAIToolArguments(tc.function?.arguments)
        if (argDelta) frag.argsBuffer += argDelta
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  const processLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) return
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(trimmed.indexOf(':') + 1).trim()
    if (payload === '[DONE]') return
    try {
      handleChunk(JSON.parse(payload) as OpenAIChatStreamChunk)
    } catch {
      return // 坏行 / 坏形状(valid JSON 但结构不对)一律跳过、不崩:单块畸形不该丢掉整段累积
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    }
    if (buffer) processLine(buffer)
  } finally {
    reader.releaseLock()
  }

  // 收尾:按到达顺序还原工具调用;缺 id 自造(有 name 就当有效工具,别静默丢)。
  const toolCalls: ToolCall[] = [...tools.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .filter(([, f]) => f.name) // 无 name 的碎片丢弃(不是有效工具调用)
    .map(([index, f]) => ({ id: f.id || idFactory(index), name: f.name, input: parseOpenAIToolArguments(f.argsBuffer) }))

  return { text, thinking, toolCalls, finishReason, usage }
}
