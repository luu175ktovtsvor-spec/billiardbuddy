import type { ToolContext } from '../tools/Tool'

export interface PromptCommand {
  type: 'prompt'
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]
  allowedToolRules?: string[]
  model?: string
  context?: 'inline' | 'fork'
  agent?: string
  source: 'skills' | 'commands' | 'plugin' | 'builtin' | 'mcp'
  filePath: string
  baseDir: string
  contentLength: number
  getPrompt(args: string, ctx: ToolContext): Promise<string>
}
