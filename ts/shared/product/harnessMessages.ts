export type ProductTextBlock = { type: 'text'; text: string }
export type ProductImageBlock = {
  type: 'image'
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
}
export type ProductToolCallBlock = {
  type: 'tool_call'
  id: string
  name: string
  arguments: Record<string, unknown>
}
export type ProductToolResultBlock = {
  type: 'tool_result'
  tool_call_id: string
  content: string | Array<ProductTextBlock | ProductImageBlock>
  is_error?: boolean
}
export type ProductContentBlock = ProductTextBlock | ProductImageBlock | ProductToolCallBlock | ProductToolResultBlock
export type ProductPrompt = string | Array<ProductTextBlock | ProductImageBlock>

type ProductMessageBase = {
  uuid: string
  timestamp: string
  isMeta?: true
}

export type ProductUserMessage = ProductMessageBase & {
  type: 'user'
  message: { role: 'user'; content: string | ProductContentBlock[] }
}

export type ProductAssistantMessage = ProductMessageBase & {
  type: 'assistant'
  message: {
    id: string
    role: 'assistant'
    content: Array<ProductTextBlock | ProductToolCallBlock>
    model: string
    stop_reason: string | null
    usage: { input_tokens: number; output_tokens: number }
  }
}

export type ProductHarnessMessage = ProductUserMessage | ProductAssistantMessage
export type ProductModelDelta = { type: 'model_delta'; text: string }
export type ProductModelEvent = ProductModelDelta | ProductAssistantMessage

const MAX_BLOCKS = 2_048
const MAX_TEXT_CHARS = 8 * 1024 * 1024
const MAX_IMAGE_CHARS = 28 * 1024 * 1024

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validText(value: unknown, limit = MAX_TEXT_CHARS): value is string {
  return typeof value === 'string' && value.length <= limit
}

function validContentBlock(value: unknown): value is ProductContentBlock {
  const block = record(value)
  if (!block || typeof block.type !== 'string') return false
  if (block.type === 'text') return validText(block.text)
  if (block.type === 'image') {
    return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(block.media_type))
      && validText(block.data, MAX_IMAGE_CHARS)
  }
  if (block.type === 'tool_call') {
    return validText(block.id, 512) && validText(block.name, 256) && record(block.arguments) !== null
  }
  if (block.type === 'tool_result') {
    return validText(block.tool_call_id, 512)
      && (validText(block.content) || (Array.isArray(block.content) && block.content.length <= MAX_BLOCKS && block.content.every(item => {
        const child = record(item)
        return child?.type === 'text' ? validText(child.text) : child?.type === 'image' && validContentBlock(child)
      })))
      && (block.is_error === undefined || typeof block.is_error === 'boolean')
  }
  return false
}

export function parseProductHarnessMessage(value: unknown): ProductHarnessMessage {
  const outer = record(value)
  const message = record(outer?.message)
  if (!outer || !message || !validText(outer.uuid, 512) || !validText(outer.timestamp, 128)) throw new Error('HARNESS_MESSAGE_INVALID')
  if (outer.isMeta !== undefined && outer.isMeta !== true) throw new Error('HARNESS_MESSAGE_INVALID')
  const content = message.content
  if (!(validText(content) || (Array.isArray(content) && content.length <= MAX_BLOCKS && content.every(validContentBlock)))) {
    throw new Error('HARNESS_MESSAGE_INVALID')
  }
  if (outer.type === 'user' && message.role === 'user') return value as ProductUserMessage
  if (
    outer.type === 'assistant'
    && message.role === 'assistant'
    && validText(message.id, 512)
    && validText(message.model, 512)
    && (message.stop_reason === null || validText(message.stop_reason, 128))
    && record(message.usage)
    && Number.isFinite((message.usage as Record<string, unknown>).input_tokens)
    && Number.isFinite((message.usage as Record<string, unknown>).output_tokens)
    && Array.isArray(content)
    && content.every(block => block.type === 'text' || block.type === 'tool_call')
  ) return value as ProductAssistantMessage
  throw new Error('HARNESS_MESSAGE_INVALID')
}

export function parseProductHarnessMessages(value: unknown): ProductHarnessMessage[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error('HARNESS_MESSAGE_INVALID')
  return value.map(parseProductHarnessMessage)
}
