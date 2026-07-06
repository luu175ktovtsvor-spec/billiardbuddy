// 逻辑照 cc-haha src/server/proxy/transform/anthropicToOpenaiChat.ts,行为对齐。出方向:内核 Anthropic 块 → OpenAI chat 请求。
import type { Message, ContentBlock } from '../types/message'
import type { ToolSpec } from '../tools/Tool'
import type { OpenAIChatRequest, OpenAIChatMessage, OpenAIChatContentPart, OpenAIToolCall } from './types'

export type OpenAIChatImageContentMode = 'vision' | 'text_only'

export interface ProxyRequestInput {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolSpec[]
  stream?: boolean
  imageContentMode?: OpenAIChatImageContentMode
}

const OMITTED_IMAGE_TEXT = '[Image omitted: this OpenAI-compatible chat endpoint only supports text content.]'

export function toOpenAiChatRequest(input: ProxyRequestInput): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = []
  if (input.system) messages.push({ role: 'system', content: input.system })

  const imageMode = input.imageContentMode ?? 'vision'
  for (const msg of input.messages) convertMessage(msg, messages, imageMode)

  const result: OpenAIChatRequest = { model: input.model, messages, stream: input.stream === true }
  if (result.stream) result.stream_options = { include_usage: true }
  // max_tokens 故意不带:CC 会塞很大值,超多数国产上游上限;交由上游默认(照 cc-haha 注释)。

  if (input.tools && input.tools.length > 0) {
    result.tools = input.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> },
    }))
  }
  return result
}

function convertMessage(msg: Message, output: OpenAIChatMessage[], imageMode: OpenAIChatImageContentMode): void {
  const content = msg.content
  if (!Array.isArray(content) || content.length === 0) {
    output.push({ role: msg.role, content: '' })
    return
  }
  if (msg.role === 'user') convertUserMessage(content, output, imageMode)
  else convertAssistantMessage(content, output)
}

function convertUserMessage(blocks: ContentBlock[], output: OpenAIChatMessage[], imageMode: OpenAIChatImageContentMode): void {
  const contentParts: OpenAIChatContentPart[] = []
  const textOnlyParts: string[] = []

  for (const block of blocks) {
    if (block.type === 'text') {
      if (imageMode === 'text_only') textOnlyParts.push(block.text)
      else contentParts.push({ type: 'text', text: block.text })
    } else if ((block as { type: string }).type === 'image') {
      // 内核暂不产 image 块;为将来多模态留通路(照 cc-haha)。text_only 模式替占位。
      if (imageMode === 'text_only') {
        textOnlyParts.push(OMITTED_IMAGE_TEXT)
      } else {
        const src = (block as unknown as { source: { media_type: string; data: string } }).source
        contentParts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } })
      }
    } else if (block.type === 'tool_result') {
      // tool_result → 独立 tool 消息(OpenAI 无 is_error 字段;报错信号靠 content 里的 <tool_use_error> 文本)。
      output.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
    }
    // thinking 块在 user 侧不该出现,忽略。
  }

  if (imageMode === 'text_only') {
    const joined = textOnlyParts.filter(Boolean).join('\n')
    if (joined) output.push({ role: 'user', content: joined })
  } else if (contentParts.length > 0) {
    output.push({
      role: 'user',
      content: contentParts.length === 1 && contentParts[0]!.type === 'text' ? contentParts[0]!.text : contentParts,
    })
  }
}

function convertAssistantMessage(blocks: ContentBlock[], output: OpenAIChatMessage[]): void {
  let textContent = ''
  const toolCalls: OpenAIToolCall[] = []
  for (const block of blocks) {
    if (block.type === 'text') textContent += block.text
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input) },
      })
    }
    // thinking:默认不回灌(display-only,无 signature),照 cc-haha roundTripReasoningContent=false。
  }
  const m: OpenAIChatMessage = { role: 'assistant', content: textContent || null }
  if (toolCalls.length > 0) m.tool_calls = toolCalls
  output.push(m)
}
