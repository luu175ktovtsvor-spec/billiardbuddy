import type { ToolContext } from '../tools/Tool'

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'UserPromptSubmit' | 'SessionStart' | 'SubagentStart' | 'SubagentStop'

export type HookDecision =
  | { action: 'allow'; message?: string }
  | { action: 'ask'; message?: string }
  | { action: 'deny'; message: string }
  | { action: 'modify'; updatedInput: unknown; message?: string }
  | { action: 'context'; additionalContext: string }

export interface HookPayload {
  event: HookEvent
  toolName?: string
  input?: unknown
  output?: string
  userPrompt?: string
  sessionId?: string
  agentId?: string
  agentType?: string
  stopHookActive?: boolean
}

export type HookHandler = (payload: HookPayload, ctx: ToolContext) => HookDecision | HookDecision[] | null | undefined | Promise<HookDecision | HookDecision[] | null | undefined>

export interface HookRule {
  event: HookEvent
  matcher?: string
  handler: HookHandler
}

export interface HookRegistry {
  rules: HookRule[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseHookDecisionJSON(text: string): HookDecision | null {
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw)) return null
    // cc 官方格式:PreToolUse hook 用 hookSpecificOutput.permissionDecision(allow/deny/ask)+ ...Reason。
    const hso = raw.hookSpecificOutput
    if (isRecord(hso) && typeof hso.permissionDecision === 'string') {
      const reason = typeof hso.permissionDecisionReason === 'string' ? hso.permissionDecisionReason : undefined
      if (hso.permissionDecision === 'allow') return { action: 'allow', message: reason }
      if (hso.permissionDecision === 'ask') return { action: 'ask', message: reason }
      if (hso.permissionDecision === 'deny') return { action: 'deny', message: reason ?? 'hook 拒绝' }
    }
    // cc 旧格式:decision:'block' + reason(PostToolUse/Stop/UserPromptSubmit;PreToolUse 已弃用但仍兼容)→ deny。
    if (raw.decision === 'block') return { action: 'deny', message: typeof raw.reason === 'string' ? raw.reason : 'hook 阻断' }
    // 本项目扁平格式(向后兼容)
    if (raw.action === 'allow') return { action: 'allow', message: typeof raw.message === 'string' ? raw.message : undefined }
    if (raw.action === 'ask') return { action: 'ask', message: typeof raw.message === 'string' ? raw.message : undefined }
    if (raw.action === 'deny' && typeof raw.message === 'string') return { action: 'deny', message: raw.message }
    if (raw.action === 'modify' && 'updatedInput' in raw) {
      return { action: 'modify', updatedInput: raw.updatedInput, message: typeof raw.message === 'string' ? raw.message : undefined }
    }
    if (raw.action === 'context' && typeof raw.additionalContext === 'string') {
      return { action: 'context', additionalContext: raw.additionalContext }
    }
    return null
  } catch {
    return null
  }
}

/** cc:matcher 作为正则测工具名(支持 `Edit|Write` 交替、`mcp__.*` 前缀)。锚定避免子串误匹配(`Edit` 不误配 `MultiEdit`);非法正则退化为精确匹配。 */
export function matchesToolMatcher(matcher: string | undefined, target: string | undefined): boolean {
  if (!matcher || matcher === '*') return true
  if (!target) return false
  if (matcher === target) return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(target)
  } catch {
    return false
  }
}

function matches(rule: HookRule, payload: HookPayload): boolean {
  if (rule.event !== payload.event) return false
  if (!rule.matcher || rule.matcher === '*') return true
  return matchesToolMatcher(rule.matcher, payload.toolName ?? payload.agentType)
}

export function mergeHookRegistries(...registries: Array<HookRegistry | undefined>): HookRegistry | undefined {
  const rules = registries.flatMap(registry => registry?.rules ?? [])
  return rules.length > 0 ? { rules } : undefined
}

export async function runHookEvent(registry: HookRegistry | undefined, payload: HookPayload, ctx: ToolContext): Promise<HookDecision[]> {
  if (!registry) return []
  const out: HookDecision[] = []
  for (const rule of registry.rules) {
    if (!matches(rule, payload)) continue
    try {
      const result = await rule.handler(payload, ctx)
      if (Array.isArray(result)) out.push(...result)
      else if (result) out.push(result)
    } catch (err) {
      out.push({ action: 'deny', message: `hook ${payload.event} 执行失败:${err instanceof Error ? err.message : String(err)}` })
    }
  }
  return out
}

export interface PreToolUseResult {
  input: unknown
  deniedMessage?: string
  /** cc PreToolUse permissionDecision:'ask' → 强制该次调用走审批闸(无视当前 permissionMode 的自动放行)。 */
  askMessage?: string
  askRequested?: boolean
  additionalContext: string[]
}

export interface HookContextResult {
  deniedMessage?: string
  additionalContext: string[]
  blockingFeedback?: string[]
}

export interface UserPromptSubmitResult extends HookContextResult {
  userPrompt: string
}

export async function applyPreToolUseHooks(
  registry: HookRegistry | undefined,
  toolName: string,
  input: unknown,
  ctx: ToolContext,
): Promise<PreToolUseResult> {
  let nextInput = input
  const additionalContext: string[] = []
  let askRequested = false
  let askMessage: string | undefined
  const decisions = await runHookEvent(registry, { event: 'PreToolUse', toolName, input }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'deny') return { input: nextInput, deniedMessage: decision.message, additionalContext }
    if (decision.action === 'ask') { askRequested = true; askMessage = decision.message ?? askMessage }
    if (decision.action === 'modify') nextInput = decision.updatedInput
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
  }
  return { input: nextInput, additionalContext, ...(askRequested ? { askRequested, askMessage } : {}) }
}

export async function applySessionStartHooks(
  registry: HookRegistry | undefined,
  ctx: ToolContext,
): Promise<HookContextResult> {
  const additionalContext: string[] = []
  const decisions = await runHookEvent(registry, {
    event: 'SessionStart',
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') additionalContext.push(`[SessionStart hook 警告] ${decision.message}`)
  }
  return { additionalContext }
}

export async function applySubagentStartHooks(
  registry: HookRegistry | undefined,
  agentId: string,
  agentType: string,
  ctx: ToolContext,
): Promise<HookContextResult> {
  const additionalContext: string[] = []
  const decisions = await runHookEvent(registry, {
    event: 'SubagentStart',
    sessionId: ctx.conversationId,
    agentId,
    agentType,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') additionalContext.push(`[SubagentStart hook 警告] ${decision.message}`)
  }
  return { additionalContext }
}

export async function applyUserPromptSubmitHooks(
  registry: HookRegistry | undefined,
  userPrompt: string,
  ctx: ToolContext,
): Promise<UserPromptSubmitResult> {
  let nextPrompt = userPrompt
  const additionalContext: string[] = []
  const decisions = await runHookEvent(registry, {
    event: 'UserPromptSubmit',
    userPrompt,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'deny') return { userPrompt: nextPrompt, deniedMessage: decision.message, additionalContext }
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'modify') {
      if (typeof decision.updatedInput === 'string') nextPrompt = decision.updatedInput
      else if (
        decision.updatedInput &&
        typeof decision.updatedInput === 'object' &&
        typeof (decision.updatedInput as { userPrompt?: unknown }).userPrompt === 'string'
      ) {
        nextPrompt = (decision.updatedInput as { userPrompt: string }).userPrompt
      }
    }
  }
  return { userPrompt: nextPrompt, additionalContext }
}

export async function applyPostToolUseHooks(
  registry: HookRegistry | undefined,
  toolName: string,
  input: unknown,
  output: string,
  ctx: ToolContext,
): Promise<HookContextResult> {
  const additionalContext: string[] = []
  const decisions = await runHookEvent(registry, {
    event: 'PostToolUse',
    toolName,
    input,
    output,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') additionalContext.push(`[PostToolUse hook 警告] ${decision.message}`)
  }
  return { additionalContext }
}

export async function applyStopHooks(
  registry: HookRegistry | undefined,
  finalText: string,
  ctx: ToolContext,
  subagent?: { agentId: string; agentType: string },
  opts: { stopHookActive?: boolean } = {},
): Promise<HookContextResult> {
  const additionalContext: string[] = []
  const blockingFeedback: string[] = []
  const eventName = subagent ? 'SubagentStop' : 'Stop'
  const decisions = await runHookEvent(registry, {
    event: eventName,
    output: finalText,
    sessionId: ctx.conversationId,
    agentId: subagent?.agentId,
    agentType: subagent?.agentType,
    stopHookActive: opts.stopHookActive,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') blockingFeedback.push(`${eventName} hook feedback:\n${decision.message}`)
  }
  return blockingFeedback.length > 0 ? { additionalContext, blockingFeedback } : { additionalContext }
}
