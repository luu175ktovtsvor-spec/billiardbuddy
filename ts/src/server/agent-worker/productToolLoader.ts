import type { ProductToolPermissionContext, ProductTools } from './productTool.js'
import { createProductSkillTool } from './productSkillTool.js'
import type { ProductCommand } from './productTool.js'
import { ProductBashTool } from './productBashTool.js'
import {
  ProductAskUserQuestionTool,
  ProductEditTool,
  ProductGlobTool,
  ProductGrepTool,
  ProductNotebookEditTool,
  ProductReadTool,
  ProductTodoWriteTool,
  ProductWebFetchTool,
  ProductWebSearchTool,
  ProductWriteTool,
} from './productWorkspaceTools.js'

const PRODUCT_TOOLS: ProductTools = [
  ProductBashTool,
  ProductReadTool,
  ProductEditTool,
  ProductWriteTool,
  ProductGlobTool,
  ProductGrepTool,
  ProductNotebookEditTool,
  ProductWebFetchTool,
  ProductWebSearchTool,
  ProductTodoWriteTool,
  ProductAskUserQuestionTool,
]

export function loadProductAgentTools(_permissionContext: ProductToolPermissionContext, commands: readonly ProductCommand[] = []): ProductTools {
  const tools = PRODUCT_TOOLS.filter(tool => tool.isEnabled())
  return commands.some(command => command.type === 'prompt' && !command.disableModelInvocation)
    ? [...tools, createProductSkillTool(commands)]
    : tools
}
