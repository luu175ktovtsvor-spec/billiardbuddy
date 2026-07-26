import type { ProductAssistantMessage, ProductHarnessMessage, ProductToolCallBlock, ProductToolResultBlock } from '../../../shared/product/harnessMessages.js'
import { createProductUserMessage } from './productMessages.js'
import { findProductTool, type ProductCanUseTool, type ProductToolContext } from './productTool.js'

export type ProductToolMessageUpdate = {
  message?: ProductHarnessMessage
  newContext: ProductToolContext
}

function errorBlock(toolUseId: string, message: string): ProductToolResultBlock {
  return { type: 'tool_result', tool_call_id: toolUseId, is_error: true, content: message.slice(0, 8_000) }
}

function assistantForToolUse(messages: ProductAssistantMessage[], id: string): ProductAssistantMessage | undefined {
  return messages.find(message => message.message.content.some(block => block.type === 'tool_call' && block.id === id))
}

function toolResultMessage(block: ProductToolResultBlock): ProductHarnessMessage {
  return createProductUserMessage({ content: [block] })
}

function truncateMiddle(value: string, limit: number): string {
  if (!Number.isFinite(limit) || value.length <= limit) return value
  if (limit < 80) return value.slice(0, Math.max(0, limit))
  const marker = '\n[tool result truncated]\n'
  const available = Math.max(0, limit - marker.length)
  const head = Math.ceil(available * 0.7)
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`
}

function boundedContent(content: ProductToolResultBlock['content'], limit: number): ProductToolResultBlock['content'] {
  if (!Number.isFinite(limit)) return content
  const budget = Math.max(0, Math.floor(limit))
  if (typeof content === 'string') return truncateMiddle(content, budget)
  const output: typeof content = []
  let remaining = budget
  for (const block of content) {
    if (remaining <= 0) break
    if (block.type === 'text') {
      const text = truncateMiddle(block.text, remaining)
      output.push({ type: 'text', text })
      remaining -= text.length
      continue
    }
    if (block.data.length <= remaining) {
      output.push(block)
      remaining -= block.data.length
      continue
    }
    const omitted = `[tool image omitted: encoded content exceeds the ${budget}-character result limit]`
    if (omitted.length <= remaining) {
      output.push({ type: 'text', text: omitted })
      remaining -= omitted.length
    }
  }
  if (output.length === 0 && budget > 0) output.push({ type: 'text', text: truncateMiddle('[tool result omitted by size limit]', budget) })
  return output
}

/** Validate, authorize and execute model tool calls through the Host contract. */
export async function* runProductTools(
  blocks: ProductToolCallBlock[],
  assistantMessages: ProductAssistantMessage[],
  canUseTool: ProductCanUseTool,
  initialContext: ProductToolContext,
): AsyncGenerator<ProductToolMessageUpdate, void> {
  let context = initialContext
  for (const block of blocks) {
    if (context.abortController.signal.aborted) throw new Error('PRODUCT_TOOL_EXECUTION_ABORTED')
    const tool = findProductTool(context.options.tools, block.name)
    if (!tool) {
      yield { message: toolResultMessage(errorBlock(block.id, `Unknown tool: ${block.name}`)), newContext: context }
      continue
    }
    const parsed = await tool.inputSchema.safeParseAsync(block.arguments)
    if (!parsed.success) {
      yield { message: toolResultMessage(errorBlock(block.id, `Invalid input for ${tool.name}: ${parsed.error.message}`)), newContext: context }
      continue
    }
    const assistant = assistantForToolUse(assistantMessages, block.id)
    if (!assistant) {
      yield { message: toolResultMessage(errorBlock(block.id, 'Tool call has no owning assistant message')), newContext: context }
      continue
    }
    try {
      const permission = await canUseTool(tool, parsed.data, context, assistant, block.id)
      if (permission.behavior !== 'allow') {
        const reason = permission.behavior === 'deny' ? permission.message : 'Tool permission was not resolved by the Host'
        yield { message: toolResultMessage(errorBlock(block.id, reason)), newContext: context }
        continue
      }
      const approvedInput = permission.updatedInput
      const validation = await tool.validateInput?.(approvedInput, context)
      if (validation?.result === false) {
        yield { message: toolResultMessage(errorBlock(block.id, validation.message)), newContext: context }
        continue
      }
      const executionContext = { ...context, toolUseId: block.id }
      const result = await tool.call(approvedInput, executionContext, canUseTool, assistant)
      if (tool.outputSchema) {
        const output = await tool.outputSchema.safeParseAsync(result.data)
        if (!output.success) throw new Error(`Invalid output from ${tool.name}`)
      }
      const mapped = tool.mapToolResultToToolResultBlockParam(result.data, block.id)
      const productResult: ProductToolResultBlock = {
        type: 'tool_result',
        tool_call_id: block.id,
        ...(mapped.is_error ? { is_error: true } : {}),
        content: boundedContent(typeof mapped.content === 'string'
          ? mapped.content
          : mapped.content, tool.maxResultSizeChars),
      }
      if (result.contextModifier) context = result.contextModifier(context)
      yield { message: toolResultMessage(productResult), newContext: context }
      for (const next of result.newMessages ?? []) yield { message: next, newContext: context }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Tool execution failed'
      yield { message: toolResultMessage(errorBlock(block.id, reason)), newContext: context }
    }
  }
}
