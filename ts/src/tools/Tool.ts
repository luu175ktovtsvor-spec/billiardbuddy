import type { Workspace } from '../workspace/workspace'

export type JSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

export interface ToolContext {
  workspace: Workspace
  signal?: AbortSignal
}

/** 模型可见的工具描述(function-calling 线上格式)。 */
export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
}

/** W2 最小 Tool——name/description/JSON schema/执行函数 + isReadOnly(播种 W4 权限心智)。 */
export interface Tool<Input = unknown> {
  name: string
  description: string
  inputSchema: JSONSchema
  isReadOnly: boolean
  execute(input: Input, ctx: ToolContext): Promise<string>
}
