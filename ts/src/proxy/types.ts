/**
 * OpenAI Chat Completions 协议类型:只保留当前 proxy 层需要的字段。
 * Anthropic 块类型复用 ../types/message,不在这里重造。
 */
export type OpenAIChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  // PDF 文档输入:OpenAI 兼容端点用 { type:'file', file:{ filename, file_data:'data:application/pdf;base64,...' } }
  // 承载 PDF(见 https://developers.openai.com/api/docs/guides/file-inputs)。内核 document 块由 proxy 翻成它。
  | { type: 'file'; file: { filename: string; file_data: string } }

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: unknown }
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIChatContentPart[] | null
  name?: string
  reasoning_content?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAITool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  tools?: OpenAITool[]
  tool_choice?: unknown
  reasoning_effort?: 'low' | 'medium' | 'high'
}

export interface OpenAICompatibleUsage {
  input_tokens?: number
  output_tokens?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface OpenAIChatResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    // message 整体、tool_calls[].id/.function、thinking_blocks 元素都按"不可信上游"松绑成 optional——
    // 非流式响应跟流式分片一样可能畸形,运行时守卫见 openaiChatToAnthropic.ts。
    message?: {
      role: string
      content?: string | null
      reasoning_content?: string
      reasoning?: string
      thinking_blocks?: unknown[]
      annotations?: unknown[]
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: unknown } }>
    }
    finish_reason: string | null
  }>
  usage?: OpenAICompatibleUsage
}

export interface OpenAIChatStreamChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      reasoning_content?: string
      reasoning?: string
      thinking_blocks?: Array<Record<string, unknown>>
      annotations?: unknown[]
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: unknown } }>
    }
    finish_reason: string | null
  }>
  usage?: OpenAICompatibleUsage
}

/** Anthropic usage 语义(input 排除 cache 命中)。 */
export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
