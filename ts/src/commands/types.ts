import type { ToolContext } from '../tools/Tool'
import type { HookRegistry } from '../hooks/hooks'

export interface PromptCommand {
  type: 'prompt'
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]
  allowedToolRules?: string[]
  /** frontmatter `argument-hint`:未展开的参数提示文案,如 "[目标目录] [文件名]"。 */
  argumentHint?: string
  /** frontmatter `arguments`:具名参数列表,按顺序映射到 $1/$2.. 位置参数,供 $name 占位符替换。 */
  argNames?: string[]
  model?: string
  context?: 'inline' | 'fork'
  agent?: string
  hooks?: HookRegistry
  source: 'skills' | 'commands' | 'plugin' | 'builtin' | 'mcp'
  /** 技能落点层(bundled=随包内置/user=用户自建/workspace=工作区),前端斜杠浮层据此显示「系统/个人/项目」作用域。 */
  skillLayer?: 'bundled' | 'user' | 'workspace'
  filePath: string
  baseDir: string
  contentLength: number
  getPrompt(args: string, ctx: ToolContext): Promise<string>
}
