import type { ProductAssistantMessage, ProductHarnessMessage, ProductPrompt, ProductToolCallBlock, ProductToolResultBlock } from '../../../shared/product/harnessMessages.js'
import { createProductUserMessage } from './productMessages.js'
import { runProductModel, type ProductModelRunner } from './productModelRuntime.js'
import { runProductTools, type ProductToolMessageUpdate } from './productToolExecution.js'
import { buildProductSystemPrompt, type ProductPromptContext } from './productSystemPrompt.js'
import type { ProductCanUseTool, ProductCommand, ProductQueuedCommand, ProductToolContext, ProductToolHooks, ProductTools } from './productTool.js'
import { productDefaultTextModel } from '../product/productGatewayRuntime.js'

const MAX_MODEL_TOOL_ITERATIONS = 128

export type ProductAgentLoopEvent =
  | ProductHarnessMessage
  | { type: 'model_delta'; text: string }
  | { type: 'result'; subtype: 'success'; is_error: false; result: string }

type ProductCommandQueue = {
  snapshot(maxPriority: 'next' | 'later'): ProductQueuedCommand[]
  consume(commands: ProductQueuedCommand[]): void
}

export type ProductAgentLoopInput = {
  commands: ProductCommand[]
  prompt: ProductPrompt
  tools: ProductTools
  toolUseContext: ProductToolContext
  canUseTool: ProductCanUseTool
  mutableMessages?: ProductHarnessMessage[]
  onMessageState?: (messages: readonly ProductHarnessMessage[]) => Promise<void>
  commandQueue?: ProductCommandQueue
  model?: string
  runModel?: ProductModelRunner
  executeTools?: (
    toolUseMessages: ProductToolCallBlock[],
    assistantMessages: ProductAssistantMessage[],
    canUseTool: ProductCanUseTool,
    context: ProductToolContext,
  ) => AsyncGenerator<ProductToolMessageUpdate, void>
  toolHooks?: ProductToolHooks
  promptContext: ProductPromptContext
}

function assistantText(message: ProductAssistantMessage): string {
  return message.message.content
    .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function expandPromptCommand(
  prompt: ProductPrompt,
  commands: readonly ProductCommand[],
  context: ProductToolContext,
): Promise<ProductPrompt> {
  if (typeof prompt !== 'string') return prompt
  const match = prompt.trim().match(/^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return prompt
  const name = match[1]!
  const command = commands.find(candidate => candidate.name === name
    || candidate.userFacingName?.() === name
    || candidate.aliases?.includes(name))
  if (!command) throw new Error('PRODUCT_COMMAND_NOT_FOUND')
  if (command.type !== 'prompt' || command.userInvocable === false || command.disableNonInteractive) {
    throw new Error('PRODUCT_COMMAND_UNAVAILABLE')
  }
  return command.getPromptForCommand(match[2] ?? '', context)
}

function toolUseBlocks(messages: readonly ProductAssistantMessage[]): ProductToolCallBlock[] {
  return messages.flatMap(message => message.message.content.filter(
    (block): block is ProductToolCallBlock => block.type === 'tool_call',
  ))
}

function queuedFollowUps(queue: ProductCommandQueue | undefined): ProductQueuedCommand[] {
  if (!queue) return []
  return queue.snapshot('next').filter(command => command.mode === 'prompt' && command.value.trim())
}

function productToolResult(message: ProductHarnessMessage, toolUseId: string): ProductToolResultBlock | undefined {
  const content = message.message.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block.type === 'tool_result' && block.tool_call_id === toolUseId) return block as ProductToolResultBlock
  }
  return undefined
}

function hookContextMessage(context: string, phase: 'PreToolUse' | 'PostToolUse'): ProductHarnessMessage {
  return createProductUserMessage({
    content: `<project_hook_context event="${phase}">\n${context.slice(0, 20_000)}\n</project_hook_context>`,
    isMeta: true,
  })
}

/**
 * The only BilliardBuddy model-tool loop.
 *
 * ProductTask owns the durable Turn/Item/Event ledger. This function owns only
 * the private model trajectory for that Turn: sample, execute host tools,
 * append structured results, accept queued steer input, and sample again.
 */
export async function* runProductAgentLoop(input: ProductAgentLoopInput): AsyncGenerator<ProductAgentLoopEvent, void> {
  const messages = input.mutableMessages ?? []
  let context = input.toolUseContext
  const persist = async () => input.onMessageState?.(messages)
  const prompt = await expandPromptCommand(input.prompt, input.commands, context)
  const userMessage = createProductUserMessage({ content: prompt })
  messages.push(userMessage)
  await persist()
  yield userMessage

  const systemPrompt = buildProductSystemPrompt(input.promptContext)
  let finalText = ''

  for (let iteration = 0; iteration < MAX_MODEL_TOOL_ITERATIONS; iteration += 1) {
    if (context.abortController.signal.aborted) throw new Error('PRODUCT_AGENT_LOOP_ABORTED')
    const assistantMessages: ProductAssistantMessage[] = []
    for await (const event of (input.runModel ?? runProductModel)({
      messages: [...messages],
      systemPrompt,
      thinkingConfig: context.options.thinkingConfig,
      tools: input.tools,
      signal: context.abortController.signal,
      options: {
        model: input.model ?? productDefaultTextModel(),
      },
      toolPermissionContext: context.permissionContext,
    })) {
      yield event
      if (event.type !== 'assistant') continue
      assistantMessages.push(event)
      messages.push(event)
      const text = assistantText(event)
      if (text) finalText = text
      await persist()
    }

    if (assistantMessages.length === 0) throw new Error('PRODUCT_MODEL_EMPTY_RESPONSE')
    const blocks = toolUseBlocks(assistantMessages)
    if (blocks.length > 0) {
      for (const block of blocks) {
        const preHook = await input.toolHooks?.before(block, context)
        if (preHook?.blocked) {
          const message = createProductUserMessage({ content: [{
            type: 'tool_result',
            tool_call_id: block.id,
            is_error: true,
            content: `PreToolUse Hook blocked ${block.name}: ${preHook.reason ?? 'project automation rule'}`.slice(0, 8_000),
          }] })
          messages.push(message)
          await persist()
          yield message
          continue
        }
        let observedResult: { success: boolean; content: unknown } | undefined
        for await (const update of (input.executeTools ?? runProductTools)([block], assistantMessages, input.canUseTool, context)) {
          context = update.newContext
          if (!update.message) continue
          const result = productToolResult(update.message, block.id) as { is_error?: boolean; content?: unknown } | undefined
          if (result) observedResult = { success: result.is_error !== true, content: result.content }
          messages.push(update.message)
          await persist()
          yield update.message
        }
        if (!observedResult) throw new Error('PRODUCT_TOOL_RESULT_MISSING')
        const postHook = await input.toolHooks?.after(block, observedResult, context)
        const hookContexts = [preHook?.additionalContext, postHook?.additionalContext, postHook?.blocked ? postHook.reason ?? 'Project PostToolUse Hook reported a failure' : undefined].filter(Boolean)
        if (hookContexts.length) {
          const message = hookContextMessage(hookContexts.join('\n\n'), 'PostToolUse')
          messages.push(message)
          await persist()
          yield message
        }
      }
    }

    const followUps = queuedFollowUps(input.commandQueue)
    if (followUps.length > 0) {
      input.commandQueue!.consume(followUps)
      for (const followUp of followUps) {
        const message = createProductUserMessage({ content: followUp.value, ...(followUp.isMeta ? { isMeta: true as const } : {}) })
        messages.push(message)
        await persist()
        yield message
      }
    }

    if (blocks.length === 0 && followUps.length === 0) {
      yield { type: 'result', subtype: 'success', is_error: false, result: finalText }
      return
    }
  }

  throw new Error('PRODUCT_AGENT_LOOP_LIMIT')
}
