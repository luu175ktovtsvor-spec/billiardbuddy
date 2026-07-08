/**
 * 内核消息格式 = Anthropic content-block:tool_use/tool_result 块、无 role:'tool'、system 单列。
 * 出方向由 ts/src/proxy 翻译成 OpenAI chat 喂国产模型;内部只认这套块。
 */
export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
export interface ImageBlock { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock | ToolResultBlock

/** 内部消息:content 恒为块数组(不用 string|Block[] 双态);role 只有 user/assistant,system 单列。 */
export type Message =
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] }

export const textBlock = (text: string): TextBlock => ({ type: 'text', text })

export const toolUseBlock = (call: ToolCall): ToolUseBlock =>
  ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })

export const toolResultBlock = (toolUseId: string, content: string, isError = false): ToolResultBlock =>
  isError
    ? { type: 'tool_result', tool_use_id: toolUseId, content, is_error: true }
    : { type: 'tool_result', tool_use_id: toolUseId, content }

export const userText = (text: string): Message => ({ role: 'user', content: [textBlock(text)] })
