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
  /** frontmatter `disable-model-invocation`:true = 模型看不到也调不了(不进模型发现清单、use_ 拒绝);用户敲斜杠仍可。对齐 cc。 */
  disableModelInvocation?: boolean
  /** frontmatter `user-invocable`(默认 true):false = 不进用户斜杠清单(前端 typeahead);模型仍可调(除非同时 disableModelInvocation)。对齐 cc。 */
  userInvocable?: boolean
  /** frontmatter `aliases`:命令/技能别名,byName 索引额外登记(不覆盖真实主名)。对齐 cc。 */
  aliases?: string[]
  /** frontmatter `paths`(条件披露):非空即"条件技能"——默认不进模型发现清单,碰到命中路径的文件时才现身;仍可 by-name 调。对齐 cc parseSkillPaths。 */
  paths?: string[]
  source: 'skills' | 'commands' | 'plugin' | 'builtin' | 'mcp'
  /** 技能落点层(bundled=随包内置/user=用户自建/workspace=工作区),前端斜杠浮层据此显示「系统/个人/项目」作用域。 */
  skillLayer?: 'bundled' | 'user' | 'workspace'
  filePath: string
  baseDir: string
  contentLength: number
  getPrompt(args: string, ctx: ToolContext): Promise<string>
}
