import type { z } from 'zod/v4'
import type { ProductAssistantMessage, ProductHarnessMessage, ProductImageBlock, ProductTextBlock } from '../../../shared/product/harnessMessages.js'
import type { ProductPromptContext } from './productSystemPrompt.js'

export type ProductContentBlock = ProductTextBlock | ProductImageBlock

export type ProductCommand = {
  type: 'prompt'
  name: string
  aliases?: string[]
  description: string
  allowedTools?: string[]
  argumentHint?: string
  whenToUse?: string
  disableModelInvocation?: boolean
  disableNonInteractive?: boolean
  userInvocable?: boolean
  isEnabled?: () => boolean
  isHidden?: boolean
  source: 'builtin' | 'bundled' | 'mcp' | 'plugin' | 'project'
  loadedFrom?: 'bundled' | 'mcp' | 'plugin' | 'skills'
  contentLength: number
  progressMessage: string
  userFacingName?: () => string
  /** Declarative tool routing for an explicit command, preserved across the private Worker boundary. */
  directTool?: { name: string; argument: string }
  getPromptForCommand(args: string, context: ProductToolContext): Promise<ProductContentBlock[]>
}

export type ProductPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'
export type ProductToolPermissionContext = {
  mode: ProductPermissionMode
  isBypassPermissionsModeAvailable: boolean
}

export function emptyProductToolPermissionContext(): ProductToolPermissionContext {
  return { mode: 'default', isBypassPermissionsModeAvailable: false }
}

export type ProductPermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; reason: string }
  | { behavior: 'deny'; message: string; toolUseID?: string; reason: string }
  | { behavior: 'ask'; message: string; reason: string }

export type ProductToolPermissionResult = ProductPermissionDecision | {
  behavior: 'passthrough'
  message: string
}

export type ProductThinkingConfig = { type: 'disabled' | 'adaptive' | 'enabled' }

export type ProductQueuedCommand = {
  mode: 'prompt'
  value: string
  uuid?: string
  isMeta?: boolean
  priority?: 'next' | 'later'
}

export type ProductCommandQueue = {
  snapshot(maxPriority: 'next' | 'later'): ProductQueuedCommand[]
  consume(commands: ProductQueuedCommand[]): void
}

export type ProductToolHooks = {
  before(block: { id: string; name: string; arguments: Record<string, unknown> }, context: ProductToolContext): Promise<{ blocked?: boolean; reason?: string; additionalContext?: string }>
  after(block: { id: string; name: string; arguments: Record<string, unknown> }, result: { success: boolean; content: unknown }, context: ProductToolContext): Promise<{ blocked?: boolean; reason?: string; additionalContext?: string }>
}

export type ProductToolContext = {
  productTaskId?: string
  productPromptContext?: ProductPromptContext
  runProductModel?: unknown
  executeProductTools?: unknown
  options: {
    commands: ProductCommand[]
    mainLoopModel: string
    tools: ProductTools
    thinkingConfig: ProductThinkingConfig
    commandQueue?: ProductCommandQueue
  }
  abortController: AbortController
  permissionContext: ProductToolPermissionContext
  onProductHarnessMessage?: (message: ProductHarnessMessage, parentToolUseId?: string) => void
  messages: ProductHarnessMessage[]
  toolUseId?: string
  toolHooks?: ProductToolHooks
}

export type ProductCanUseTool = (
  tool: ProductTool,
  input: Record<string, unknown>,
  context: ProductToolContext,
  assistantMessage: ProductAssistantMessage,
  toolUseId: string,
  forcedDecision?: ProductPermissionDecision,
) => Promise<ProductPermissionDecision>

export type ProductMappedToolResult = {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
  content: string | ProductContentBlock[]
}

export type ProductToolResult<Output> = {
  data: Output
  contextModifier?: (context: ProductToolContext) => ProductToolContext
  newMessages?: ProductHarnessMessage[]
}

type ObjectSchema = z.ZodType<Record<string, unknown>>

export type ProductTool<Input extends ObjectSchema = ObjectSchema, Output = unknown> = {
  name: string
  aliases?: string[]
  searchHint?: string
  inputSchema: Input
  inputJSONSchema?: Record<string, unknown>
  outputSchema?: z.ZodType<unknown>
  maxResultSizeChars: number
  shouldDefer?: boolean
  alwaysLoad?: boolean
  isMcp?: boolean
  mcpInfo?: { serverName: string; toolName: string }
  description(input: z.infer<Input>, options: { isNonInteractiveSession: boolean; toolPermissionContext: ProductToolPermissionContext; tools: ProductTools }): Promise<string>
  prompt?(options: { tools: ProductTools }): Promise<string>
  call(args: z.infer<Input>, context: ProductToolContext, canUseTool: ProductCanUseTool, parentMessage: ProductAssistantMessage): Promise<ProductToolResult<Output>>
  validateInput?(input: z.infer<Input>, context: ProductToolContext): Promise<{ result: true } | { result: false; message: string; errorCode: number }>
  checkPermissions(input: z.infer<Input>, context: ProductToolContext): Promise<ProductToolPermissionResult>
  isEnabled(): boolean
  isConcurrencySafe(input: z.infer<Input>): boolean
  isReadOnly(input: z.infer<Input>): boolean
  isDestructive(input: z.infer<Input>): boolean
  isOpenWorld(input: z.infer<Input>): boolean
  interruptBehavior?(): 'cancel' | 'block'
  requiresUserInteraction?(): boolean
  toAutoClassifierInput(input: z.infer<Input>): unknown
  userFacingName(input?: Partial<z.infer<Input>>): string
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string): ProductMappedToolResult
}

export type ProductTools = readonly ProductTool[]

type DefaultableKeys = 'isEnabled' | 'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'isOpenWorld' | 'checkPermissions' | 'toAutoClassifierInput' | 'userFacingName'
export type ProductToolDef<Input extends ObjectSchema = ObjectSchema, Output = unknown> = Omit<ProductTool<Input, Output>, DefaultableKeys> & Partial<Pick<ProductTool<Input, Output>, DefaultableKeys>> & {
  [name: `render${string}`]: unknown
}

export function buildProductTool<Input extends ObjectSchema, Output>(definition: ProductToolDef<Input, Output>): ProductTool<Input, Output> {
  return {
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    checkPermissions: async input => ({ behavior: 'allow', updatedInput: input, reason: 'tool-default' }),
    toAutoClassifierInput: () => '',
    userFacingName: () => definition.name,
    ...definition,
  }
}

export function findProductTool(tools: ProductTools, name: string): ProductTool | undefined {
  return tools.find(tool => tool.name === name || tool.aliases?.includes(name))
}
