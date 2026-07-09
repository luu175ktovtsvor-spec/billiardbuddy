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

/**
 * hook 规则来源。对齐 cc-haha 的 hook 源分层(managed/user/project/local/plugin/session)裁剪版:
 * - `managed`(默认,`source` 省略):内核/应用自身注册的可信 hook(域包 createDomainPackHookRegistry、
 *   目标 hook、技能/子代理内置注册),不来自被打开的用户仓库,信任门恒放行(除非 disableAllHooks)。
 * - `local`:从工作区 `.claude/settings` 风格文件(loadHookRegistryFile)加载的**任意命令 hook**——
 *   即本安全缺口所指的攻击面。信任门对它套用 allowManagedHooksOnly + workspace trust 两道闸。
 */
export type HookSource = 'managed' | 'local'

export interface HookRule {
  event: HookEvent
  matcher?: string
  handler: HookHandler
  /** 省略即视为 managed(可信内核源);`local` = 工作区文件加载的不可信 hook,受信任门约束。 */
  source?: HookSource
}

export interface HookRegistry {
  rules: HookRule[]
}

/**
 * hook 执行前的信任策略。对齐 cc-haha(src/utils/hooks.ts)在跑 command/http/prompt/agent hook 前的三道闸:
 * - `disableAllHooks` ← cc `shouldDisableAllHooksIncludingManaged()`(managed/policy 级 disableAllHooks):
 *   跳过**所有** hook(含 managed)。
 * - `allowManagedHooksOnly` ← cc `shouldAllowManagedHooksOnly()`:只跑 managed 源,`local` 源不跑。
 * - `interactive` + `isWorkspaceTrusted` ← cc `shouldSkipHookDueToTrust()`(config.ts
 *   `checkHasTrustDialogAccepted()`):交互模式下 `local` hook 必须 workspace 受信才跑;非交互(SDK/headless)
 *   时 trust 隐式成立、不校验(cc `getIsNonInteractiveSession()` 分支)。
 */
export interface HookTrustPolicy {
  disableAllHooks: boolean
  allowManagedHooksOnly: boolean
  interactive: boolean
  isWorkspaceTrusted: (workspaceRoot: string) => boolean
}

const alwaysTrusted = (): boolean => true

/**
 * 宿主注入的信任策略覆盖(部分字段)。宿主(server/index.ts、Electron 壳)在打开工作区时调用
 * configureHookTrust({ interactive: true, isWorkspaceTrusted: root => mcpTrust.isTrusted(root) })
 * 即接通 McpTrustStore 的工作区信任判定,激活对 local hook 的信任门。未注入时按下方 env/默认解析。
 */
let hookTrustOverride: Partial<HookTrustPolicy> | null = null

function hookEnvTruthy(name: string): boolean {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/** 注入/合并宿主信任策略;传 null 清空(等价 resetHookTrust)。字段级覆盖优先于 env/默认。 */
export function configureHookTrust(policy: Partial<HookTrustPolicy> | null): void {
  hookTrustOverride = policy && Object.keys(policy).length > 0 ? { ...policy } : null
}

/** 复位信任策略到 env/默认(供测试与会话结束清理)。 */
export function resetHookTrust(): void {
  hookTrustOverride = null
}

/**
 * 解析当前生效的信任策略:override 字段 > env > 安全默认。
 * env:CLAUDE_CODE_DISABLE_ALL_HOOKS(禁用全部)、CLAUDE_CODE_ALLOW_MANAGED_HOOKS_ONLY(仅托管)、
 *     CLAUDE_CODE_HOOKS_TRUST_IMPLICIT(转非交互/隐式信任,SDK/headless 用)。
 * 安全默认 interactive=true(对齐 cc 交互会话"信任必需"):未接线时 isWorkspaceTrusted 仍缺省 alwaysTrusted,
 * 故 local hook 依旧放行(等价 SDK 隐式信任,兼容无宿主/测试路径不改行为);宿主一旦
 * configureHookTrust({ isWorkspaceTrusted: root => mcpTrust.isTrusted(root) }) 注入真实信任源,
 * 未受信工作区的 local hook 即被门挡(不 spawn)。interactive 默认 true 是纵深防御:即便宿主只注入
 * isWorkspaceTrusted、忘了 interactive,门仍生效(不会退回"永久非交互跳过信任"的旧缺口)。
 */
export function resolveHookTrustPolicy(): HookTrustPolicy {
  const override = hookTrustOverride
  return {
    disableAllHooks: override?.disableAllHooks ?? hookEnvTruthy('CLAUDE_CODE_DISABLE_ALL_HOOKS'),
    allowManagedHooksOnly: override?.allowManagedHooksOnly ?? hookEnvTruthy('CLAUDE_CODE_ALLOW_MANAGED_HOOKS_ONLY'),
    interactive: override?.interactive ?? !hookEnvTruthy('CLAUDE_CODE_HOOKS_TRUST_IMPLICIT'),
    isWorkspaceTrusted: override?.isWorkspaceTrusted ?? alwaysTrusted,
  }
}

/**
 * 单条 hook 规则是否放行执行。三道闸:
 * ① disableAllHooks → 全挡(含 managed);② allowManagedHooksOnly → 挡 local;
 * ③ 交互模式 workspace 未受信 → 挡 local(非交互/SDK 时 trust 隐式,不挡)。
 *
 * ⚠️ 与 cc 的一处**有意分叉**(见 rework 报告):cc 的 trust 门是 source 之上的"全或无"前置过滤——
 * 交互未受信时连 managed 一起挡(shouldSkipHookDueToTrust 在 source 分层前就 return)。本实现让
 * **managed 源仅受 ① 约束**、trust 门(②③)只挡 local。理由:
 *  - cc 的 "managed" = 企业策略 hook,且 cc 有 trust 弹窗让文件夹被快速受信,挡掉 managed 只是短暂;
 *  - 本产品的 "managed" = **app 二进制自带的内置 hook**(域包 createDomainPackHookRegistry、目标
 *    createGoalHookRegistry、app 内置技能/子代理 frontmatter),构造即可信、不来自被打开的工作区、非攻击面;
 *  - 且当前**尚无 trust 授予 UI**(仅 POST /api/v1/agent/mcp/trust)。若严格照搬"连 managed 一起挡",
 *    默认未受信下会把 app 自有的目标/域包 hook 全部静默停用——破坏产品功能且零安全收益。
 * 真正的 RCE 攻击面 = **工作区来源的 local hook**(.claude/hooks.json,及未来若接入的工作区
 * .claude/agents / .claude/skills frontmatter),已被 ②③ 挡住。managed 若要整体关停走 ①(disableAllHooks)。
 */
export function shouldRunHookRule(rule: HookRule, workspaceRoot: string, policy: HookTrustPolicy = resolveHookTrustPolicy()): boolean {
  if (policy.disableAllHooks) return false
  if (rule.source !== 'local') return true
  if (policy.allowManagedHooksOnly) return false
  if (policy.interactive && !policy.isWorkspaceTrusted(workspaceRoot)) return false
  return true
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
  // SECURITY(对齐 cc-haha):跑任何 command/http/prompt/agent hook 前先过信任门。
  // disableAllHooks 时整体短路(含 managed);逐条按 source 过 allowManagedHooksOnly + workspace trust。
  const policy = resolveHookTrustPolicy()
  if (policy.disableAllHooks) return []
  const out: HookDecision[] = []
  for (const rule of registry.rules) {
    if (!matches(rule, payload)) continue
    if (!shouldRunHookRule(rule, ctx.workspace.root, policy)) continue
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
