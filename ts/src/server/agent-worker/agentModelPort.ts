import type { ProductHarnessMessage, ProductModelEvent } from '../../../shared/product/harnessMessages.js'
import type { ProductThinkingConfig, ProductToolPermissionContext, ProductTools } from './productTool.js'

export type ProductAgentModelRunner = (input: {
  messages: ProductHarnessMessage[]
  systemPrompt: readonly string[]
  thinkingConfig: ProductThinkingConfig
  tools: ProductTools
  signal: AbortSignal
  options: { model: string }
  toolPermissionContext?: ProductToolPermissionContext
}) => AsyncGenerator<ProductModelEvent, void>
