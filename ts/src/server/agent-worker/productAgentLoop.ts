import { randomUUID } from 'node:crypto'
import { productHarnessMessageOperationReceipts, type ProductAssistantMessage, type ProductHarnessMessage, type ProductModelOperationReceipt, type ProductPrompt, type ProductToolCallBlock, type ProductToolResultBlock } from '../../../shared/product/harnessMessages.js'
import { createProductUserMessage } from './productMessages.js'
import type { ProductAgentModelRunner } from './agentModelPort.js'
import { buildProductSystemPrompt, type ProductPromptContext } from './productSystemPrompt.js'
import { findProductTool, type ProductCanUseTool, type ProductCommand, type ProductQueuedCommand, type ProductToolContext, type ProductToolHooks, type ProductTools } from './productTool.js'

const MAX_MODEL_TOOL_ITERATIONS = 128
const MAX_PARALLEL_LOCAL_READS = 8

export type ProductAgentLoopEvent =
  | ProductHarnessMessage
  | { type: 'model_delta'; text: string }
  | { type: 'result'; subtype: 'success'; is_error: false; result: string }

type ProductCommandQueue = {
  snapshot(maxPriority: 'next' | 'later'): ProductQueuedCommand[]
  consume(commands: ProductQueuedCommand[]): void
}

export type ProductAgentToolExecutionUpdate = {
  message?: ProductHarnessMessage
  newContext: ProductToolContext
}

export type ProductAgentLoopInput = {
  commands: ProductCommand[]
  prompt: ProductPrompt
  tools: ProductTools
  toolUseContext: ProductToolContext
  canUseTool: ProductCanUseTool
  mutableMessages?: ProductHarnessMessage[]
  onMessageState?: (messages: readonly ProductHarnessMessage[]) => Promise<void>
  /** Runs only after model receipts have entered a durable private message. */
  onOperationReceiptsPersisted?: (receipts: readonly ProductModelOperationReceipt[], signal: AbortSignal) => Promise<void>
  commandQueue?: ProductCommandQueue
  model: string
  runModel: ProductAgentModelRunner
  executeTools: (
    toolUseMessages: ProductToolCallBlock[],
    assistantMessages: ProductAssistantMessage[],
    canUseTool: ProductCanUseTool,
    context: ProductToolContext,
  ) => AsyncGenerator<ProductAgentToolExecutionUpdate, void>
  toolHooks?: ProductToolHooks
  promptContext: ProductPromptContext
  /** Continue a persisted Turn without appending its original user input again. */
  resume?: boolean
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
): Promise<{ prompt: ProductPrompt; directToolCall?: ProductToolCallBlock }> {
  if (typeof prompt !== 'string') return { prompt }
  const match = prompt.trim().match(/^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return { prompt }
  const name = match[1]!
  const command = commands.find(candidate => candidate.name === name
    || candidate.userFacingName?.() === name
    || candidate.aliases?.includes(name))
  if (!command) throw new Error('PRODUCT_COMMAND_NOT_FOUND')
  if (command.type !== 'prompt' || command.userInvocable === false || command.disableNonInteractive) {
    throw new Error('PRODUCT_COMMAND_UNAVAILABLE')
  }
  const args = match[2] ?? ''
  const expanded = await command.getPromptForCommand(args, context)
  return {
    prompt: expanded,
    ...(command.directTool ? {
      directToolCall: {
        type: 'tool_call' as const,
        id: `command_${randomUUID()}`,
        name: command.directTool.name,
        arguments: { [command.directTool.argument]: args.trim() },
      },
    } : {}),
  }
}

function directToolAssistant(block: ProductToolCallBlock): ProductAssistantMessage {
  const uuid = randomUUID()
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      id: uuid,
      role: 'assistant',
      content: [block],
      model: 'billiardbuddy-command-router',
      stop_reason: 'tool_call',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

function toolUseBlocks(messages: readonly ProductAssistantMessage[]): ProductToolCallBlock[] {
  return messages.flatMap(message => message.message.content.filter(
    (block): block is ProductToolCallBlock => block.type === 'tool_call',
  ))
}

function truncatedToolUseIds(messages: readonly ProductAssistantMessage[]): Set<string> {
  return new Set(messages.flatMap(message => {
    if (message.message.stop_reason !== 'length' && message.message.stop_reason !== 'max_tokens') return []
    return message.message.content.flatMap(block => block.type === 'tool_call' ? [block.id] : [])
  }))
}

function truncatedToolResult(block: ProductToolCallBlock): ProductHarnessMessage {
  return createProductUserMessage({ content: [{
    type: 'tool_result',
    tool_call_id: block.id,
    is_error: true,
    content: 'The model output reached its token limit before this tool call was complete. The tool was not executed. Reissue the tool call with complete arguments.',
  }] })
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

function operationReceipts(messages: readonly ProductHarnessMessage[]): ProductModelOperationReceipt[] {
  const receipts = new Map<string, ProductModelOperationReceipt>()
  for (const message of messages) {
    for (const receipt of productHarnessMessageOperationReceipts(message)) receipts.set(`${receipt.source}:${receipt.operation_id}`, receipt)
  }
  return [...receipts.values()]
}

function hookContextMessage(context: string, phase: 'PreToolUse' | 'PostToolUse'): ProductHarnessMessage {
  return createProductUserMessage({
    content: `<project_hook_context event="${phase}">\n${context.slice(0, 20_000)}\n</project_hook_context>`,
    isMeta: true,
  })
}

function unresolvedPersistedToolCalls(messages: readonly ProductHarnessMessage[]): ProductToolCallBlock[] {
  const completed = new Set(messages.flatMap(message => {
    const content = message.message.content
    return Array.isArray(content)
      ? content.flatMap(block => block.type === 'tool_result' ? [block.tool_call_id] : [])
      : []
  }))
  const seen = new Set<string>()
  return messages.flatMap(message => {
    if (message.type !== 'assistant') return []
    return message.message.content.flatMap(block => {
      if (block.type !== 'tool_call' || completed.has(block.id) || seen.has(block.id)) return []
      seen.add(block.id)
      return [block]
    })
  })
}

function resumableCompletedText(messages: readonly ProductHarnessMessage[]): string | undefined {
  const last = messages.at(-1)
  if (last?.type !== 'assistant' || last.message.content.some(block => block.type === 'tool_call')) return undefined
  if (last.message.stop_reason === 'length' || last.message.stop_reason === 'max_tokens') return undefined
  const text = assistantText(last)
  return text || undefined
}

async function isParallelLocalRead(
  block: ProductToolCallBlock,
  tools: ProductTools,
): Promise<boolean> {
  const tool = findProductTool(tools, block.name)
  if (!tool || tool.isMcp || tool.requiresUserInteraction?.()) return false
  try {
    const parsed = await tool.inputSchema.safeParseAsync(block.arguments)
    return parsed.success
      && tool.isConcurrencySafe(parsed.data)
      && tool.isReadOnly(parsed.data)
      && !tool.isOpenWorld(parsed.data)
  } catch {
    return false
  }
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
  const acknowledgePersisted = async (persisted: readonly ProductHarnessMessage[]) => {
    const receipts = operationReceipts(persisted)
    if (receipts.length) await input.onOperationReceiptsPersisted?.(receipts, context.abortController.signal)
  }
  let pendingDirectAssistant: ProductAssistantMessage | undefined
  const unresolved = unresolvedPersistedToolCalls(messages)
  for (const block of unresolved) {
    const message = createProductUserMessage({ content: [{
      type: 'tool_result',
      tool_call_id: block.id,
      is_error: true,
      content: 'The previous BilliardBuddy turn ended before this tool result was durably recorded. The prior execution outcome is unknown. Inspect the current state before deciding whether to issue a new tool call; do not assume the operation did or did not happen.',
    }] })
    messages.push(message)
    await persist()
    yield message
  }
  if (input.resume) {
    if (messages.length === 0) throw new Error('PRODUCT_AGENT_RESUME_EMPTY')
    const completedText = unresolved.length === 0 ? resumableCompletedText(messages) : undefined
    if (completedText) {
      await acknowledgePersisted(messages)
      yield { type: 'result', subtype: 'success', is_error: false, result: completedText }
      return
    }
  } else {
    const expanded = await expandPromptCommand(input.prompt, input.commands, context)
    const userMessage = createProductUserMessage({ content: expanded.prompt })
    messages.push(userMessage)
    await persist()
    yield userMessage
    pendingDirectAssistant = expanded.directToolCall ? directToolAssistant(expanded.directToolCall) : undefined
  }

  const systemPrompt = buildProductSystemPrompt(input.promptContext)
  let finalText = ''

  for (let iteration = 0; iteration < MAX_MODEL_TOOL_ITERATIONS; iteration += 1) {
    if (context.abortController.signal.aborted) throw new Error('PRODUCT_AGENT_LOOP_ABORTED')
    const assistantMessages: ProductAssistantMessage[] = []
    if (pendingDirectAssistant) {
      const event = pendingDirectAssistant
      pendingDirectAssistant = undefined
      assistantMessages.push(event)
      messages.push(event)
      await persist()
      yield event
    } else {
      for await (const event of input.runModel({
        messages: [...messages],
        systemPrompt,
        thinkingConfig: context.options.thinkingConfig,
        tools: input.tools,
        signal: context.abortController.signal,
        options: {
          model: input.model,
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
        await acknowledgePersisted([event])
      }
    }

    if (assistantMessages.length === 0) throw new Error('PRODUCT_MODEL_EMPTY_RESPONSE')
    const blocks = toolUseBlocks(assistantMessages)
    const truncatedIds = truncatedToolUseIds(assistantMessages)
    if (blocks.length > 0) {
      const collectExecution = async (block: ProductToolCallBlock, executionContext: ProductToolContext) => {
        const updates: ProductHarnessMessage[] = []
        let nextContext = executionContext
        let observedResult: { success: boolean; content: unknown } | undefined
        for await (const update of input.executeTools([block], assistantMessages, input.canUseTool, executionContext)) {
          nextContext = update.newContext
          if (!update.message) continue
          const result = productToolResult(update.message, block.id) as { is_error?: boolean; content?: unknown } | undefined
          if (result) observedResult = { success: result.is_error !== true, content: result.content }
          updates.push(update.message)
        }
        if (!observedResult) throw new Error('PRODUCT_TOOL_RESULT_MISSING')
        return { updates, nextContext, observedResult }
      }
      const persistUpdates = async (updates: readonly ProductHarnessMessage[]) => {
        for (const message of updates) {
          messages.push(message)
          await persist()
          await acknowledgePersisted([message])
        }
      }
      const postToolMessages = async (
        block: ProductToolCallBlock,
        preHook: Awaited<ReturnType<ProductToolHooks['before']>> | undefined,
        observedResult: { success: boolean; content: unknown },
        hookContext: ProductToolContext,
      ): Promise<ProductHarnessMessage[]> => {
        const postHook = await input.toolHooks?.after(block, observedResult, hookContext)
        const hookContexts = [preHook?.additionalContext, postHook?.additionalContext, postHook?.blocked ? postHook.reason ?? 'Project PostToolUse Hook reported a failure' : undefined].filter(Boolean)
        return hookContexts.length ? [hookContextMessage(hookContexts.join('\n\n'), 'PostToolUse')] : []
      }

      for (let blockIndex = 0; blockIndex < blocks.length;) {
        const block = blocks[blockIndex]!
        if (truncatedIds.has(block.id)) {
          const message = truncatedToolResult(block)
          messages.push(message)
          await persist()
          yield message
          blockIndex += 1
          continue
        }

        const parallelLocalRead = await isParallelLocalRead(block, input.tools)
        const group = [block]
        if (parallelLocalRead) {
          while (group.length < MAX_PARALLEL_LOCAL_READS && blockIndex + group.length < blocks.length) {
            const candidate = blocks[blockIndex + group.length]!
            if (truncatedIds.has(candidate.id) || !(await isParallelLocalRead(candidate, input.tools))) break
            group.push(candidate)
          }
        }

        const executable: Array<{
          block: ProductToolCallBlock
          preHook: Awaited<ReturnType<ProductToolHooks['before']>> | undefined
        }> = []
        for (const candidate of group) {
          const preHook = await input.toolHooks?.before(candidate, context)
          if (preHook?.blocked) {
            const message = createProductUserMessage({ content: [{
              type: 'tool_result',
              tool_call_id: candidate.id,
              is_error: true,
              content: `PreToolUse Hook blocked ${candidate.name}: ${preHook.reason ?? 'project automation rule'}`.slice(0, 8_000),
            }] })
            messages.push(message)
            await persist()
            yield message
          } else {
            executable.push({ block: candidate, preHook })
          }
        }

        if (parallelLocalRead && executable.length > 1) {
          const sharedContext = context
          const completed = await Promise.all(executable.map(item => collectExecution(item.block, sharedContext)))
          if (completed.some(item => item.nextContext !== sharedContext)) {
            throw new Error('PRODUCT_CONCURRENT_TOOL_CONTEXT_MUTATION')
          }
          for (let index = 0; index < executable.length; index += 1) {
            const item = executable[index]!
            const result = completed[index]!
            await persistUpdates(result.updates)
            for (const message of result.updates) yield message
            const hookMessages = await postToolMessages(item.block, item.preHook, result.observedResult, sharedContext)
            await persistUpdates(hookMessages)
            for (const message of hookMessages) yield message
          }
        } else {
          for (const item of executable) {
            const result = await collectExecution(item.block, context)
            context = result.nextContext
            await persistUpdates(result.updates)
            for (const message of result.updates) yield message
            const hookMessages = await postToolMessages(item.block, item.preHook, result.observedResult, context)
            await persistUpdates(hookMessages)
            for (const message of hookMessages) yield message
          }
        }
        blockIndex += group.length
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
