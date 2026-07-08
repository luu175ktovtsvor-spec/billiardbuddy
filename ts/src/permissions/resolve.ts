import type { Tool, ToolContext } from '../tools/Tool'
import { shellCommandAllowedByPermissionRules, shellCommandMatchesPermissionRule } from './permissionRules'
import type { ApprovalClass, DecisionReason, PermissionDecision, PermissionRule } from './types'
import { canonicalPermissionMode } from './canonical'

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

function ruleMatchesInput(rule: PermissionRule, tool: Tool, input: unknown): boolean {
  if (!ruleMatchesToolName(rule, tool)) return false
  const content = rule.ruleValue.ruleContent
  if (content === undefined) return true
  if (tool.name === 'run_command' || tool.name === 'PowerShell') return commandMatchesPattern(input, content)
  return false
}

function matchingRule(ctx: ToolContext, tool: Tool, input: unknown, behavior: PermissionRule['ruleBehavior']): PermissionRule | null {
  return (ctx.permissionRules ?? []).find(rule => rule.ruleBehavior === behavior && ruleMatchesInput(rule, tool, input)) ?? null
}

/**
 * 权限瀑布(按我们红线口径排序):
 *  1. fatal          → deny(硬拒,永不执行)
 *  2. plan + 非只读   → deny(planSkip:只规划不动手)
 *  3. deny/ask/allow 规则按 cc-haha source/behavior 进入同一瀑布
 *  4. 算 needsApproval;不需要 → allow
 *  5. autoApprove:
 *     5a forceConfirm → ask(Delta B:在 mode 之前判,连 bypassPermissions 也拦,旁路免疫)
 *     5b requiresUserInteraction → ask(连 bypassPermissions 也拦)
 *     5c bypassPermissions → allow(但不越过 fatal/forceConfirm/userInteraction)
 *     5d safePrefix   → allow
 *     5e acceptEdits 下 file 类本机动作 → allow
 *     5f default/acceptEdits → ask(非 file 类仍问)
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
    return { behavior: 'deny', message: PLAN_SKIP_MSG(tool.name), reason: { type: 'planSkip' } }
  }

  const approvalClass = tool.approvalClassFor?.(input, ctx) ?? tool.approvalClass
  const needsApproval = tool.requiresApproval === true || (tool.requiresApprovalFor?.(input, ctx) ?? false)

  // —— autoApprove ——
  if (tool.forceConfirm || (tool.forceConfirmFor?.(input, ctx) ?? false)) return ask(tool, ctx, input, { type: 'forceConfirm' }, approvalClass)
  if (tool.requiresUserInteraction || (tool.requiresUserInteractionFor?.(input, ctx) ?? false)) {
    return ask(tool, ctx, input, { type: 'requiresUserInteraction' }, approvalClass)
  }

  const askRule = matchingRule(ctx, tool, input, 'ask')
  if (askRule && mode !== 'bypassPermissions') return ask(tool, ctx, input, { type: 'rule', rule: askRule }, approvalClass)

  if (sessionAllowsTool(tool, input, ctx)) {
    return { behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: tool.name } }
  }
  if (mode === 'bypassPermissions') {
    return { behavior: 'allow', reason: { type: 'mode', mode } }
  }
  if (tool.safePrefixFor?.(input, ctx)) return { behavior: 'allow', reason: { type: 'safePrefix' } }

  const allowRule = matchingRule(ctx, tool, input, 'allow')
  if (allowRule) return { behavior: 'allow', reason: { type: 'rule', rule: allowRule } }

  if (!needsApproval) return { behavior: 'allow', reason: { type: 'mode', mode } }

  if (approvalClass === 'file' && mode === 'acceptEdits') {
    return { behavior: 'allow', reason: { type: 'mode', mode } }
  }

  // default/acceptEdits 档下走到这的只读+需审批或对外/不可逆工具 → 弹卡
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
