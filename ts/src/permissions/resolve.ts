import type { Tool, ToolContext } from '../tools/Tool'
import type { DecisionReason, PermissionDecision } from './types'

/** full(跳过确认)档下,spend 类动作连续自动放行到这个数,之后强制弹卡兜底(防一次 bug 循环烧钱)。 */
export const AUTO_SPEND_LIMIT = 3

export const APPROVAL_PENDING_MSG = (name: string): string =>
  `[待用户确认] 已请求执行「${name}」。请用一两句话把你打算做的事告诉老板、并请他确认,不要假装已经做完或已生成。`
export const PLAN_SKIP_MSG = (name: string): string =>
  `[计划模式] 现在只规划、不动手:「${name}」是会实际操作的步骤,已跳过。请先把完整、分步的计划讲清楚;等老板切到执行模式或确认后再实际做。`
export const DENIAL_FALLBACK_MSG = (name: string): string =>
  `[这个先不做了] 老板已经多次没同意执行「${name}」,就别再反复请求确认了——换个思路,或直接用已有信息回答他。`

function ask(tool: Tool, ctx: ToolContext, input: unknown, reason: DecisionReason): PermissionDecision {
  return {
    behavior: 'ask',
    message: APPROVAL_PENDING_MSG(tool.name),
    approvalClass: tool.approvalClass,
    approvalReason: tool.approvalReasonFor?.(input, ctx),
    reason,
  }
}

/**
 * 权限瀑布(照 cc-haha hasPermissionsToUseToolInner 顺序,按我们红线口径重排):
 *  1. fatal          → deny(硬拒,永不执行)
 *  2. plan + 非只读   → deny(planSkip:只规划不动手)
 *  3. 算 needsApproval;不需要 → allow(Delta A:本机可逆动作/文件读写直接放行)
 *  4. autoApprove:
 *     4a forceConfirm → ask(Delta B:在 mode 之前判,连 full 也拦,旁路免疫)
 *     4b safePrefix   → allow
 *     4c full 档:spend 过闸 → ask,否则 allow
 *     4d auto_files 档:file 类 → allow,否则 ask
 *     4e ask/其它     → ask
 */
function resolvePermissionInner(tool: Tool, input: unknown, ctx: ToolContext): PermissionDecision {
  const mode = ctx.permissionMode ?? 'ask'

  const fatal = tool.fatalReasonFor?.(input, ctx)
  if (fatal) return { behavior: 'deny', message: `拒绝执行:${fatal}`, reason: { type: 'fatal', text: fatal } }

  if (mode === 'plan' && !tool.isReadOnly) {
    return { behavior: 'deny', message: PLAN_SKIP_MSG(tool.name), reason: { type: 'planSkip' } }
  }

  const needsApproval = tool.requiresApproval === true || (tool.requiresApprovalFor?.(input, ctx) ?? false)
  if (!needsApproval) return { behavior: 'allow', reason: { type: 'mode', mode } }

  // —— autoApprove ——
  if (tool.forceConfirm) return ask(tool, ctx, input, { type: 'forceConfirm' })
  if (tool.safePrefixFor?.(input, ctx)) return { behavior: 'allow', reason: { type: 'safePrefix' } }

  if (mode === 'full') {
    if (tool.approvalClass === 'spend' && (ctx.autoSpendCount ?? 0) >= AUTO_SPEND_LIMIT) {
      return ask(tool, ctx, input, { type: 'mode', mode })
    }
    return { behavior: 'allow', reason: { type: 'mode', mode } }
  }
  if (mode === 'auto_files') {
    if (tool.approvalClass === 'file') return { behavior: 'allow', reason: { type: 'mode', mode } }
    return ask(tool, ctx, input, { type: 'mode', mode })
  }
  // ask(默认)/ plan 档下走到这的只读+需审批工具 → 弹卡
  return ask(tool, ctx, input, { type: 'mode', mode })
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
    return {
      behavior: 'ask',
      message: APPROVAL_PENDING_MSG(tool.name),
      reason: { type: 'mode', mode: ctx.permissionMode ?? 'ask' },
    }
  }
}
