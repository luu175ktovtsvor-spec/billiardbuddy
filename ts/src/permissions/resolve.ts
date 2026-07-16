import type { Tool, ToolContext } from '../tools/Tool'
import { shellCommandAllowedByPermissionRules, shellCommandMatchesDenyOrAskRule, shellCommandMatchesPermissionRule } from './permissionRules'
import type { ApprovalClass, DecisionReason, PermissionDecision, PermissionRule } from './types'
import { canonicalPermissionMode } from './canonical'
import { autoEditSafetyReason } from './autoEditSafety'
import { fileGlobMatchesPathForRule, fileRuleAppliesToTool, filePathRuleMatchesInput, filePathToolOperation } from './filePathRuleMatch'
import { extractRedirectionWriteTargets, extractReadCommandPaths } from '../tools/dangerousCommand'
import { isSessionPlanFile } from '../harness/plans'
import { isAbsolute, resolve as resolvePath } from 'node:path'

// 计划模式下唯一允许写的文件类工具(对齐 cc checkEditableInternalPath:计划文件靠 FileWrite/FileEdit 写)。
const PLAN_WRITABLE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'multi_edit_file'])

/**
 * 是否「把方案写进本会话计划文件」——计划模式唯一放行的写动作。仅认写/改文件类工具、且入参 path 命中
 * 本会话计划文件路径(见 harness/plans.isSessionPlanFile)。
 */
function isPlanFileWrite(tool: Tool, input: unknown, ctx: ToolContext): boolean {
  if (!PLAN_WRITABLE_TOOL_NAMES.has(tool.name)) return false
  const p = (input as { path?: unknown } | null)?.path
  if (typeof p !== 'string') return false
  return isSessionPlanFile(ctx.workspace.root, p, ctx.conversationId)
}

export const APPROVAL_PENDING_MSG = (name: string): string =>
  `[待用户确认] 已请求执行「${name}」。请用一两句话把你打算做的事告诉老板、并请他确认,不要假装已经做完或已生成。`
export const PLAN_SKIP_MSG = (name: string): string =>
  `[计划模式] 现在只规划、不动手:「${name}」是会实际操作的步骤,已跳过。请先把完整、分步的计划讲清楚;等老板切到执行模式或确认后再实际做。`
export const DENIAL_FALLBACK_MSG = (name: string): string =>
  `[这个先不做了] 老板已经多次没同意执行「${name}」,就别再反复请求确认了——换个思路,或直接用已有信息回答他。`

function ask(tool: Tool, ctx: ToolContext, input: unknown, reason: DecisionReason, approvalClass?: ApprovalClass): PermissionDecision {
  if (canonicalPermissionMode(ctx.permissionMode) === 'dontAsk') return denyForDontAsk(tool)
  return finalizeDecision({
    behavior: 'ask',
    message: APPROVAL_PENDING_MSG(tool.name),
    approvalClass,
    approvalReason: tool.approvalReasonFor?.(input, ctx),
    reason,
  }, ctx)
}

function denyForDontAsk(tool: Tool): PermissionDecision {
  return {
    behavior: 'deny',
    message: `[不询问模式] 当前权限模式不会弹出确认卡,已拒绝执行「${tool.name}」。`,
    reason: { type: 'mode', mode: 'dontAsk' },
  }
}

function finalizeDecision(decision: PermissionDecision, ctx: ToolContext): PermissionDecision {
  if (decision.behavior === 'ask' && canonicalPermissionMode(ctx.permissionMode) === 'dontAsk') {
    return {
      behavior: 'deny',
      message: `[不询问模式] 当前权限模式不会弹出确认卡,已拒绝执行。${decision.message ? ` 原请求:${decision.message}` : ''}`,
      reason: { type: 'mode', mode: 'dontAsk' },
    }
  }
  return decision
}

function sessionAllowsTool(tool: Tool, input: unknown, ctx: ToolContext): boolean {
  if (ctx.sessionAllowedTools?.has('*') === true || ctx.sessionAllowedTools?.has(tool.name) === true) return true
  const commandRules = (ctx.sessionAllowedToolRules ?? []).filter(rule => rule.tool === tool.name)
  if (tool.name === 'run_command' && shellCommandAllowedByPermissionRules(currentCommandInput(input), commandRules.map(rule => rule.ruleContent))) return true
  for (const rule of commandRules) {
    if (rule.tool !== tool.name) continue
    if (tool.name === 'PowerShell' && commandMatchesPattern(input, rule.ruleContent)) return true
  }
  return false
}

function commandMatchesPattern(input: unknown, pattern: string): boolean {
  const command = currentCommandInput(input)
  if (!command) return false
  return shellCommandMatchesPermissionRule(command, pattern)
}

function currentCommandInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const command = (input as Record<string, unknown>).command
  return typeof command === 'string' ? command.trim() : ''
}

/** 命令的写/读目标里,是否有路径命中该文件路径规则的 glob。相对路径按命令 cwd(input.cwd 优先,否则工作区根)解析。 */
function commandTargetsMatchFileRule(ctx: ToolContext, rule: PermissionRule, content: string, targets: string[], input: unknown): boolean {
  if (targets.length === 0) return false
  const wsRoot = ctx.workspace?.root ?? process.cwd()
  const rawCwd = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).cwd : undefined
  const cwd = typeof rawCwd === 'string' && rawCwd.trim() ? rawCwd : wsRoot
  return targets.some(t => {
    const cleaned = t.replace(/^['"]|['"]$/g, '')
    if (!cleaned) return false
    const abs = isAbsolute(cleaned) ? cleaned : resolvePath(cwd, cleaned)
    return fileGlobMatchesPathForRule(wsRoot, abs, content, rule.source)
  })
}

const TOOL_RULE_ALIASES: Record<string, string[]> = {
  run_command: ['run_command', 'Bash'],
  read_file: ['read_file', 'Read'],
  read_many_files: ['read_many_files', 'Read'],
  write_file: ['write_file', 'Write'],
  edit_file: ['edit_file', 'Edit'],
  list_dir: ['list_dir', 'LS'],
  grep_files: ['grep_files', 'Grep'],
  glob_files: ['glob_files', 'Glob'],
  agent_task: ['agent_task', 'Task'],
  todo_write: ['todo_write', 'TodoWrite'],
  PowerShell: ['PowerShell'],
  NotebookEdit: ['NotebookEdit'],
}

function ruleMatchesToolName(rule: PermissionRule, tool: Tool): boolean {
  const candidates = TOOL_RULE_ALIASES[tool.name] ?? [tool.name]
  return rule.ruleValue.toolName === '*' || candidates.includes(rule.ruleValue.toolName)
}

function ruleMatchesInput(ctx: ToolContext, rule: PermissionRule, tool: Tool, input: unknown): boolean {
  const content = rule.ruleValue.ruleContent

  // 命令类工具:ruleContent 作为命令模式匹配。
  if (tool.name === 'run_command' || tool.name === 'PowerShell') {
    // 文件路径规则(Edit/Write/Read)也作用于命令的写/读目标(对齐 cc getPatternsByRoot
    // 「Apply Edit tool rules to any tool editing files」):deny Edit(.env) 要拦 `echo x > .env`,
    // 否则文件规则被 run_command 绕过(审计甲#1 同族工具绕过)。只对 deny/ask 生效(allow 保持命令语义更严)。
    if (content !== undefined && !ruleMatchesToolName(rule, tool) && (rule.ruleBehavior === 'deny' || rule.ruleBehavior === 'ask')) {
      const command = currentCommandInput(input)
      if (!command) return false
      if (fileRuleAppliesToTool(rule, 'write') && commandTargetsMatchFileRule(ctx, rule, content, extractRedirectionWriteTargets(command), input)) return true
      if (fileRuleAppliesToTool(rule, 'read') && commandTargetsMatchFileRule(ctx, rule, content, extractReadCommandPaths(command), input)) return true
      return false
    }
    if (!ruleMatchesToolName(rule, tool)) return false
    if (content === undefined) return true
    // SECURITY(对齐 cc): deny/ask 规则必须拆子命令逐条匹配,否则复合命令能绕过红线——
    // deny(rm:*) 要能拦住 `true && rm x`、`env FOO=1 rm x`、`sudo rm x`、`echo hi | xargs rm`。
    // allow 规则保持更严的整条语义(不给复合命令放行),仍走 shellCommandMatchesPermissionRule。
    if (rule.ruleBehavior === 'deny' || rule.ruleBehavior === 'ask') {
      const command = currentCommandInput(input)
      return command ? shellCommandMatchesDenyOrAskRule(command, content) : false
    }
    return commandMatchesPattern(input, content)
  }

  // 文件类工具(Read/Write/Edit 家族):ruleContent 作为路径 glob 匹配入参文件路径。
  // 对齐 cc filesystem.matchingRuleForInput —— 否则路径作用域 deny/ask/allow 对文件工具全失效,
  // .env / **/secrets/** 被静默放读(本次修复的核心缺口)。
  const op = filePathToolOperation(tool)
  if (op !== null) {
    if (!fileRuleAppliesToTool(rule, op)) return false
    if (content === undefined) return true // 裸 Read/Edit/Write 规则 → 覆盖该家族全部文件
    return filePathRuleMatchesInput(ctx, rule, tool, input)
  }

  // 其它工具:只认工具名级(无 ruleContent)规则。
  if (!ruleMatchesToolName(rule, tool)) return false
  return content === undefined
}

function matchingRule(ctx: ToolContext, tool: Tool, input: unknown, behavior: PermissionRule['ruleBehavior']): PermissionRule | null {
  return (ctx.permissionRules ?? []).find(rule => rule.ruleBehavior === behavior && ruleMatchesInput(ctx, rule, tool, input)) ?? null
}

/**
 * 权限瀑布(对齐 cc-haha 档位语义):
 *  1. fatal          → deny(硬拒,永不执行;仅 SSRF/file:// 等安全漏洞防护,危险命令已不在此列)
 *  2. plan + 非只读   → ask(planSkip:对齐 cc 不硬 deny;计划文件写豁免 allow)
 *  3. deny/ask/allow 规则按 cc-haha source/behavior 进入同一瀑布
 *  4. 算 needsApproval;不需要 → allow
 *  5. autoApprove:
 *     5a requiresUserInteraction → ask(真正需要用户选择的交互不能自动代答)
 *     5b bypassPermissions → allow(跳过普通审批与 forceConfirm,但不越过 fatal/deny/userInteraction)
 *     5c forceConfirm → ask(仅 default/acceptEdits 等非完全访问档生效)
 *     5d dangerous    → ask(危险命令:bypass 上面已放行;其余档 ask,且优先于 allow 规则/safePrefix,对齐 cc)
 *     5e safePrefix   → allow
 *     5f acceptEdits 下 file 类本机动作 → allow
 *     5g default/acceptEdits → ask(非 file 类仍问)
 *  6. dontAsk 把所有 ask 结果转换为 deny,不弹确认卡
 */
function resolvePermissionInner(tool: Tool, input: unknown, ctx: ToolContext): PermissionDecision {
  const mode = canonicalPermissionMode(ctx.permissionMode)

  const fatal = tool.fatalReasonFor?.(input, ctx)
  if (fatal) return { behavior: 'deny', message: `拒绝执行:${fatal}`, reason: { type: 'fatal', text: fatal } }

  const denyRule = matchingRule(ctx, tool, input, 'deny')
  if (denyRule) {
    return {
      behavior: 'deny',
      message: `Permission to use ${tool.name} has been denied.`,
      reason: { type: 'rule', rule: denyRule },
    }
  }

  const readOnly = tool.isReadOnly || (tool.isReadOnlyFor?.(input, ctx) ?? false)
  if (mode === 'plan' && !readOnly) {
    // 计划模式唯一放行的写:把方案写进本会话计划文件(对齐 cc checkEditableInternalPath 的 plan 文件豁免)。
    // 不豁免 → 计划模式提示「用 write_file 写计划文件」会变成点了没反应的死路(违反反逻辑铁律)。
    if (isPlanFileWrite(tool, input, ctx)) {
      return { behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: tool.name } }
    }
    // 对齐 cc:plan 模式不硬 deny 非只读工具——cc 靠系统提示词约束模型只调只读工具(permission pipeline 无 plan-deny 分支)。
    // 我方对接的国产模型自律性不及 Claude,故非只读工具退成 ask(弹卡问,不放任也不硬拒),模型万一不自律仍由用户闸住。
    return ask(tool, ctx, input, { type: 'planSkip' }, tool.approvalClassFor?.(input, ctx) ?? tool.approvalClass)
  }

  const approvalClass = tool.approvalClassFor?.(input, ctx) ?? tool.approvalClass
  const needsApproval = tool.requiresApproval === true || (tool.requiresApprovalFor?.(input, ctx) ?? false)

  // —— autoApprove ——
  if (tool.requiresUserInteraction || (tool.requiresUserInteractionFor?.(input, ctx) ?? false)) {
    return ask(tool, ctx, input, { type: 'requiresUserInteraction' }, approvalClass)
  }

  // D2:无人值守(定时任务/工作流,headless)场景下,即使完全访问档位放行一切,危险命令
  // (rm -rf 根、mkfs、format 等)也不能悄悄执行——没有人在场确认、也没人能在出事时立刻发现。
  // 危险判定挪到 bypassPermissions 短路之前,只在 ctx.shouldAvoidPermissionPrompts 为真时生效;
  // ask() 的结果在 headless 上下文会被 loop 自动拒绝(见 loop.ts shouldAvoidPermissionPrompts 分支),
  // 不会挂起等一个不存在的人。有人在场的交互式 bypass 会话维持原语义不变(cc 对齐:bypass 忽略 ask)。
  if (mode === 'bypassPermissions' && ctx.shouldAvoidPermissionPrompts) {
    const dangerous = tool.dangerousReasonFor?.(input, ctx)
    if (dangerous) return ask(tool, ctx, input, { type: 'dangerous', text: dangerous }, approvalClass)
  }

  // 合并 Codex Full access + Claude bypassPermissions 的用户语义：不逐次审批。
  // fatal 与显式 deny 已在上方失败关闭；必须让用户做决定的交互也已保留。
  if (mode === 'bypassPermissions') {
    return { behavior: 'allow', reason: { type: 'mode', mode } }
  }

  if (tool.forceConfirm || (tool.forceConfirmFor?.(input, ctx) ?? false)) return ask(tool, ctx, input, { type: 'forceConfirm' }, approvalClass)

  const askRule = matchingRule(ctx, tool, input, 'ask')
  if (askRule) return ask(tool, ctx, input, { type: 'rule', rule: askRule }, approvalClass)

  if (sessionAllowsTool(tool, input, ctx)) {
    return { behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: tool.name } }
  }
  // 危险命令(rm -rf 根/format c:/mkfs 等):完全访问档已在上面放行(对齐 cc:bypass 忽略 ask);其余档一律 ask,
  // 且排在 allow 规则/safePrefix 之前——即用户配了 allow run_command(*) 也不能让危险命令免审批(对齐 cc
  // checkDangerousRemovalPaths「cannot be auto-allowed by permission rules」)。deny 规则仍在上面优先拦。
  const dangerous = tool.dangerousReasonFor?.(input, ctx)
  if (dangerous) return ask(tool, ctx, input, { type: 'dangerous', text: dangerous }, approvalClass)
  if (tool.safePrefixFor?.(input, ctx)) return { behavior: 'allow', reason: { type: 'safePrefix' } }

  const allowRule = matchingRule(ctx, tool, input, 'allow')
  if (allowRule) return { behavior: 'allow', reason: { type: 'rule', rule: allowRule } }

  if (!needsApproval) return { behavior: 'allow', reason: { type: 'mode', mode } }

  if (approvalClass === 'file' && mode === 'acceptEdits') {
    // cc 对齐:acceptEdits 自动放行文件编辑前过安全闸——.git/.vscode/.idea/.claude 目录、
    // shell/git/mcp 配置文件、含 Windows 规范化绕过特征的路径不能被自动接受,退回询问。
    const unsafe = autoEditSafetyReason(tool.name, input, ctx)
    if (unsafe) return ask(tool, ctx, input, { type: 'safetyCheck', reason: unsafe.message, classifierApprovable: unsafe.classifierApprovable }, approvalClass)
    return { behavior: 'allow', reason: { type: 'mode', mode } }
  }

  // default/acceptEdits 档下走到这里的受控工具显示确认卡。
  return ask(tool, ctx, input, { type: 'mode', mode }, approvalClass)
}

/**
 * 公开入口:包一层 try/catch。fatalReasonFor/requiresApprovalFor/safePrefixFor/approvalReasonFor
 * 都是工具作者自带代码、可能抛异常(读文件/算逻辑出错)——抛了就算不出权限,失败关闭到"问人"
 * (绝不静默放行 allow),守本模块「gate 路永不崩 + 不静默放行」红线。
 */
export function resolvePermission(tool: Tool, input: unknown, ctx: ToolContext): PermissionDecision {
  try {
    return resolvePermissionInner(tool, input, ctx)
  } catch {
    if (canonicalPermissionMode(ctx.permissionMode) === 'dontAsk') return denyForDontAsk(tool)
    return {
      behavior: 'ask',
      message: APPROVAL_PENDING_MSG(tool.name),
      reason: { type: 'mode', mode: canonicalPermissionMode(ctx.permissionMode) },
    }
  }
}
