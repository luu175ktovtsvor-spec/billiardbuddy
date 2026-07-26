import { z } from 'zod/v4'
import { buildProductTool, type ProductToolContext, type ProductToolDef } from './productTool.js'
import type { ProductHarnessMessage } from '../../../shared/product/harnessMessages.js'
import { runProductAgentLoop } from './productAgentLoop.js'

const inputSchema = z.strictObject({
  prompt: z.string().min(1).max(100_000).describe('A bounded independent subtask to solve'),
  description: z.string().min(1).max(160).describe('Short description of the subtask'),
})

export const ProductSubtaskTool = buildProductTool({
  name: 'Subtask',
  maxResultSizeChars: 100_000,
  inputSchema,
  async description() { return 'Run a bounded child model-tool loop with inherited workspace and permissions' },
  async prompt() { return 'Delegate one independent bounded subtask. The child inherits the current Turn permissions and cannot create another Subtask.' },
  isReadOnly() { return false },
  isConcurrencySafe() { return false },
  userFacingName() { return 'Subtask' },
  toAutoClassifierInput(input) { return input.description },
  async call({ prompt }, context, canUseTool) {
    if (!context.productPromptContext) throw new Error('SUBTASK_CONTEXT_MISSING')
    const messages: ProductHarnessMessage[] = []
    const childTools = context.options.tools.filter(tool => tool.name !== 'Subtask')
    const childContext: ProductToolContext = {
      ...context,
      options: { ...context.options, tools: childTools, commandQueue: undefined },
      messages,
    }
    let result = ''
    for await (const event of runProductAgentLoop({
      commands: context.options.commands,
      prompt,
      tools: childTools,
      toolUseContext: childContext,
      canUseTool,
      mutableMessages: messages,
      promptContext: context.productPromptContext,
      runModel: context.runProductModel as Parameters<typeof runProductAgentLoop>[0]['runModel'],
      executeTools: context.executeProductTools as Parameters<typeof runProductAgentLoop>[0]['executeTools'],
      toolHooks: context.toolHooks,
    })) {
      if (event.type === 'result') result = event.result
      else if (event.type !== 'model_delta') context.onProductHarnessMessage?.(event, context.toolUseId)
    }
    if (!result.trim()) throw new Error('SUBTASK_EMPTY_RESULT')
    return { data: result }
  },
  mapToolResultToToolResultBlockParam(result, toolUseID) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: result }
  },
  renderToolUseMessage() { return null },
  renderToolUseProgressMessage() { return null },
  renderToolUseQueuedMessage() { return null },
  renderToolUseRejectedMessage() { return null },
  renderToolResultMessage() { return null },
  renderToolUseErrorMessage() { return null },
} satisfies ProductToolDef<typeof inputSchema, string>)
