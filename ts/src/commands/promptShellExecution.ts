import { isDangerousCommand } from '../tools/dangerousCommand'
import { runCommandTool, spawnShellChild, killChildTree } from '../tools/runCommandTool'
import { resolvePermission } from '../permissions/resolve'
import type { ToolContext } from '../tools/Tool'
import { addAllowedToolsToContext } from './allowedTools'

/**
 * 命令/技能正文的动态注入(对齐 cc `src/utils/promptShellExecution.ts` + `loadSkillsDir.ts:344-398`):
 * - `` !`command` `` 内联 与 ```! command ``` 代码块:现场执行 shell、把输出回填进 prompt;
 * - `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` 模板变量替换(兼容按 cc 语法写的技能,变量会被
 *   替换掉、不进入模型可见文本,不构成白标泄漏)。
 * 安全门与 cc 一致:MCP 来源的命令/技能是远程不可信内容,**绝不执行**其正文内嵌 shell(调用方按
 * source==='mcp' 跳过);嵌入命令逐条过权限瀑布,非 allow 一律抛错(展开发生在人机回合之外,
 * 不能弹审批卡)——技能 frontmatter 的 allowedTools 会临时并入权限上下文(cc 同款 always-allow 合并)。
 */

// 代码块语法:```! command ```(对齐 cc BLOCK_PATTERN)
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

// 内联语法:!`command`,前面必须是行首或空白(对齐 cc INLINE_PATTERN 的 lookbehind:
// 防止匹配到行内代码 span 里的 `!!`、相邻 span 的 `foo`!`bar`、shell 变量 $! 等)。
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm

/** 单条嵌入命令的执行上限:30s、输出 64KB(嵌入命令是"取个值填进 prompt",不该长跑)。 */
const EMBEDDED_COMMAND_TIMEOUT_MS = 30_000
const EMBEDDED_COMMAND_MAX_OUTPUT = 64_000

export interface PromptTemplateVars {
  /** 技能自身目录(替换 ${CLAUDE_SKILL_DIR};Windows 反斜杠归一为正斜杠防 shell 转义,对齐 cc)。 */
  skillDir?: string
  /** 会话 id(替换 ${CLAUDE_SESSION_ID})。 */
  sessionId?: string
}

/** 模板变量替换(对齐 cc loadSkillsDir.ts:356-369)。缺值的变量原样保留(不吞成空串,便于排查)。 */
export function substitutePromptTemplateVars(text: string, vars: PromptTemplateVars): string {
  let out = text
  if (vars.skillDir) {
    const dir = process.platform === 'win32' ? vars.skillDir.replace(/\\/g, '/') : vars.skillDir
    out = out.replace(/\$\{CLAUDE_SKILL_DIR\}/g, dir)
  }
  if (vars.sessionId) {
    out = out.replace(/\$\{CLAUDE_SESSION_ID\}/g, vars.sessionId)
  }
  return out
}

export interface ExecuteShellCommandsOptions {
  /** 命令/技能 frontmatter 的 allowedTools:执行嵌入命令前临时并入权限上下文(不污染真实会话 ctx)。 */
  allowedTools?: string[]
}

interface ShellRunResult {
  stdout: string
  stderr: string
}

/** 精简 shell 执行(嵌入命令专用):复用 run_command 的 spawn/杀树底座,但返回裸 stdout/stderr
 *  (cc 用 BashTool.call 拿 data.{stdout,stderr};我们的 run_command.execute 返回带元信息的
 *  格式化文本,不适合回填 prompt)。非零退出码抛错(对齐 cc ShellError → MalformedCommandError)。 */
async function runEmbeddedShell(command: string, ctx: ToolContext): Promise<ShellRunResult> {
  if (isDangerousCommand(command)) throw new Error(`拒绝执行危险命令：${command}`)
  const wrapped = ctx.sandbox
    ? await ctx.sandbox.wrapCommand(command, { signal: ctx.signal })
    : null
  const child = spawnShellChild(command, ctx.workspace.root, wrapped)
  return await new Promise<ShellRunResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
    }, EMBEDDED_COMMAND_TIMEOUT_MS)
    const onAbort = () => killChildTree(child)
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < EMBEDDED_COMMAND_MAX_OUTPUT) stdout += String(d) })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < EMBEDDED_COMMAND_MAX_OUTPUT) stderr += String(d) })
    child.on('error', err => finish(() => reject(new Error(`命令启动失败：${err.message}`))))
    child.on('close', code => finish(() => {
      if (timedOut) reject(new Error(`[Command timed out after ${Math.round(EMBEDDED_COMMAND_TIMEOUT_MS / 1000)}s]`))
      else if (ctx.signal?.aborted) reject(new Error('[Command interrupted]'))
      else if (code && code !== 0) reject(new Error(formatShellOutput(stdout, stderr) || `exit ${code}`))
      else resolve({ stdout, stderr })
    }))
  })
}

/** 输出格式(对齐 cc formatBashOutput):stdout 为主,stderr 追加 [stderr] 段。 */
function formatShellOutput(stdout: string, stderr: string): string {
  const parts: string[] = []
  if (stdout.trim()) parts.push(stdout.trim())
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
  return parts.join('\n')
}

/**
 * 解析 prompt 文本并执行内嵌 shell 命令(对齐 cc executeShellCommandsInPrompt)。
 * 权限:逐条过 resolvePermission 瀑布,行为不是 allow 一律抛错——只读命令(git status 等)靠
 * 动态只读判定自动放行,其余须被 frontmatter allowedTools / 会话 allow 规则覆盖(cc 同款模型:
 * 技能作者用 allowedTools 声明它要跑什么,用户装技能即授权)。
 * 失败语义对齐 cc:权限拒绝/执行失败/超时/中断都抛错让整次命令展开失败,绝不静默留空。
 */
export async function executeShellCommandsInPrompt(
  text: string,
  ctx: ToolContext,
  slashCommandName: string,
  opts: ExecuteShellCommandsOptions = {},
): Promise<string> {
  // 便宜的子串门(对齐 cc:93% 的技能没有内嵌命令,别为它们扫昂贵的 lookbehind 正则)。
  const blockMatches = [...text.matchAll(BLOCK_PATTERN)]
  const inlineMatches = text.includes('!`') ? [...text.matchAll(INLINE_PATTERN)] : []
  const matches = [...blockMatches, ...inlineMatches]
  if (matches.length === 0) return text

  // 克隆权限上下文并临时并入 frontmatter allowedTools(对齐 cc:alwaysAllowRules.command=allowedTools),
  // 不污染真实会话 ctx。
  const expansionCtx: ToolContext = {
    ...ctx,
    sessionAllowedTools: new Set(ctx.sessionAllowedTools ?? []),
    sessionAllowedToolRules: [...(ctx.sessionAllowedToolRules ?? [])],
  }
  if (opts.allowedTools?.length) addAllowedToolsToContext(expansionCtx, opts.allowedTools)

  let result = text
  await Promise.all(matches.map(async match => {
    const command = match[1]?.trim()
    if (!command) return
    const decision = resolvePermission(runCommandTool, { command }, expansionCtx)
    if (decision.behavior !== 'allow') {
      const reason = decision.behavior === 'deny'
        ? decision.message
        : `该命令需要人工确认,不能嵌在 ${slashCommandName} 正文里自动执行;请把它加进 frontmatter allowedTools 或改成让模型显式调用 run_command`
      throw new Error(`Shell command permission check failed for pattern "${match[0]}": ${reason}`)
    }
    let output: string
    try {
      const run = await runEmbeddedShell(command, expansionCtx)
      output = formatShellOutput(run.stdout, run.stderr)
    } catch (err) {
      throw new Error(`Shell command failed for pattern "${match[0]}": ${err instanceof Error ? err.message : String(err)}`)
    }
    // 函数式 replacer(对齐 cc):String.replace 的字符串替换会解释 $$/$&/$` 等,shell 输出是任意数据,裸字符串会被腐蚀。
    result = result.replace(match[0], () => output)
  }))
  return result
}
