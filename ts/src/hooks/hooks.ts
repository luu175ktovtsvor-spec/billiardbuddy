import type { ToolContext } from '../tools/Tool'
import type { PermissionDecision } from '../permissions/types'

/**
 * hook 事件全集 = cc-haha 全部 27 个(对齐 entrypoints/sdk/coreTypes.ts:25-53 HOOK_EVENTS,一个不少)。
 * 配置文件声明任何一个都不会被静默吞(normalizeHookRegistry 的 HOOK_EVENTS 同步收全)。
 * 派发点分三档(与 cc 的 fire 位置一一对应,见各 apply* 派发器注释):
 * - 已接线:PreToolUse / PostToolUse / PostToolUseFailure / UserPromptSubmit / SessionStart / SessionEnd /
 *   SubagentStart / SubagentStop / Stop / StopFailure / PreCompact / PostCompact / Notification /
 *   PermissionRequest / PermissionDenied(loop 权限闸) / TaskCreated / TaskCompleted(结构化任务工具) /
 *   WorktreeCreate / WorktreeRemove(worktree 工具) / Elicitation / ElicitationResult(MCP 桥) /
 *   ConfigChange(create_skill 写盘,source:'skills';settings 写回点待接)。
 * - 派发器就绪、call site 待宿主运行时出现对应场景时接:Setup(cc=init/maintenance 流程)、
 *   TeammateIdle(cc=队友即将闲置)、CwdChanged(cc=会话中切换 cwd)、
 *   InstructionsLoaded(需 buildSystemPrompt 把已加载记忆文件清单暴露出来,cc=getMemoryFiles 内 fire)。
 * - FileChanged:需文件监听基建(cc watchPaths 管线),派发器就绪、watcher 未建(登记在案,不装死)。
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'StopFailure'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'Notification'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'

export type HookDecision =
  | { action: 'allow'; message?: string }
  | { action: 'ask'; message?: string }
  | { action: 'deny'; message: string }
  | { action: 'modify'; updatedInput: unknown; message?: string }
  | { action: 'context'; additionalContext: string }
  /** Elicitation/ElicitationResult 专用:hook 代答 MCP elicitation(对齐 cc hookSpecificOutput action/content)。 */
  | { action: 'elicitation'; elicitationAction: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

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
  /** PreCompact/PostCompact:压缩触发方式(auto=自动阈值触发,manual=强制/用户显式)。对齐 cc trigger。 */
  compactTrigger?: 'auto' | 'manual'
  /** PreCompact:自定义压缩指令(本项目暂不接入摘要指令注入,恒 null;字段留给命令 hook 载荷对齐 cc custom_instructions)。 */
  compactCustomInstructions?: string | null
  /** PostCompact:本轮压缩产出的摘要文本(对齐 cc compact_summary)。 */
  compactSummary?: string
  /** Notification:通知正文/标题/类型(对齐 cc message/title/notification_type)。 */
  notificationMessage?: string
  notificationTitle?: string
  notificationType?: string
  /** SessionEnd:结束原因(对齐 cc reason,如 clear/resume/logout/other)。 */
  sessionEndReason?: string
  /** PostToolUseFailure/StopFailure:错误文本(对齐 cc error)。 */
  errorMessage?: string
  /** 工具调用 id(PostToolUseFailure 等,对齐 cc tool_use_id)。 */
  toolUseId?: string
  /** PermissionDenied:拒绝原因(对齐 cc reason)。 */
  permissionReason?: string
  /** PermissionRequest:审批建议("始终允许"候选,对齐 cc permission_suggestions)。 */
  permissionSuggestions?: unknown[]
  /** Setup:触发方式(对齐 cc trigger,init=初始化/maintenance=维护)。 */
  setupTrigger?: 'init' | 'maintenance'
  /** TeammateIdle/TaskCreated/TaskCompleted:队友名/团队名(对齐 cc teammate_name/team_name)。 */
  teammateName?: string
  teamName?: string
  /** TaskCreated/TaskCompleted:任务三元组(对齐 cc task_id/task_subject/task_description)。 */
  taskId?: string
  taskSubject?: string
  taskDescription?: string
  /** Elicitation/ElicitationResult:MCP elicitation 载荷(对齐 cc mcp_server_name/message/mode/url/elicitation_id/requested_schema/action/content)。 */
  mcpServerName?: string
  elicitationMessage?: string
  elicitationMode?: 'form' | 'url'
  elicitationUrl?: string
  elicitationId?: string
  elicitationRequestedSchema?: Record<string, unknown>
  elicitationAction?: 'accept' | 'decline' | 'cancel'
  elicitationContent?: Record<string, unknown>
  /** ConfigChange:变更源(对齐 cc source:user_settings/project_settings/local_settings/skills)。 */
  configSource?: string
  /** ConfigChange/InstructionsLoaded/FileChanged:涉及的文件路径(对齐 cc file_path)。 */
  filePath?: string
  /** InstructionsLoaded:记忆层/加载原因/条件 glob/触发与父文件(对齐 cc memory_type/load_reason/globs/trigger_file_path/parent_file_path)。 */
  memoryType?: string
  loadReason?: string
  instructionGlobs?: string[]
  triggerFilePath?: string
  parentFilePath?: string
  /** WorktreeCreate/WorktreeRemove:worktree 名/路径(对齐 cc name/worktree_path)。 */
  worktreeName?: string
  worktreePath?: string
  /** CwdChanged:旧/新工作目录(对齐 cc old_cwd/new_cwd)。 */
  oldCwd?: string
  newCwd?: string
  /** FileChanged:文件事件类型(对齐 cc event)。 */
  fileEvent?: 'change' | 'add' | 'unlink'
}

export type HookHandler = (payload: HookPayload, ctx: ToolContext) => HookDecision | HookDecision[] | null | undefined | Promise<HookDecision | HookDecision[] | null | undefined>

/**
 * hook 规则来源。对齐 cc-haha 的 hook 源分层(managed/user/project/local/plugin/session)裁剪版:
 * - `managed`(默认,`source` 省略):内核/应用自身注册的可信 hook(域包 createDomainPackHookRegistry、
 *   目标 hook、技能/子代理内置注册),不来自被打开的用户仓库,信任门恒放行(除非 disableAllHooks)。
 * - `user`:用户级全局 hook 配置(`~/.billiardbuddy/settings.json` 的 `hooks` 字段,对齐同仓库
 *   `permissions/permissionsSettings.ts` 的 userSettings 源)。这是用户自己机器上的配置、不来自被打开的
 *   工作区,非 RCE 攻击面——与 `plugin` 同一档:受 disableAllHooks 与 allowManagedHooksOnly 约束(机构策略
 *   要求"仅托管"时,用户自定义的全局 hook 也该被锁掉),但**不**过 workspace trust 闸。
 * - `plugin`:已启用插件贡献的 hook(loadPluginHookRegistry,来自 ~/.billiardbuddy 或 library 里用户**主动装的**
 *   插件包,与插件 .mcp.json 同属"app 级可信、不来自被打开的工作区")。信任门:受 disableAllHooks 与
 *   allowManagedHooksOnly 约束(装的插件也是扩展、不是内核托管),但**不**过 workspace trust 闸(插件不在被打开的
 *   工作区里、非 RCE 攻击面)——与"插件 .mcp.json 直接加载不走工作区信任闸"的既有产品口径一致。
 * - `local`:从工作区 `.billiardbuddy/settings*.json` 风格文件(loadHookRegistryFile/loadWorkspaceHookRegistry)
 *   加载的**任意命令 hook**——即本安全缺口所指的攻击面(涵盖 projectSettings 与 localSettings 两级,二者
 *   信任语义相同,不再细分)。信任门对它套用 allowManagedHooksOnly + workspace trust 两道闸。
 */
export type HookSource = 'managed' | 'user' | 'plugin' | 'local'

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
  // managed(省略 source)= app 内置可信内核,只受 ① disableAllHooks 约束。
  if (rule.source === undefined || rule.source === 'managed') return true
  // allowManagedHooksOnly:只跑 managed → 挡 user/plugin/local(用户全局配置/装的插件/工作区文件都算非托管扩展)。
  if (policy.allowManagedHooksOnly) return false
  // user(用户级全局 settings.json)/plugin(用户主动装的插件贡献):都非工作区攻击面,
  // 不过 workspace trust 闸,过了 ①② 即放行。
  if (rule.source === 'user' || rule.source === 'plugin') return true
  // local(工作区文件源):交互模式下 workspace 未受信则挡(非交互/SDK 时 trust 隐式成立)。
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
    // cc PermissionRequest 格式:hookSpecificOutput.decision = {behavior:'allow',updatedInput?} | {behavior:'deny',message?}
    // (types/hooks.ts:120-134)。allow+updatedInput 折成 [modify,allow] 语义由消费方聚合,这里单值返回:
    // 有 updatedInput 时返回 modify(消费方 applyPermissionRequestHooks 把 modify 视作 allow+改参)。
    if (isRecord(hso) && hso.hookEventName === 'PermissionRequest' && isRecord(hso.decision)) {
      const d = hso.decision
      if (d.behavior === 'deny') return { action: 'deny', message: typeof d.message === 'string' ? d.message : 'PermissionRequest hook 拒绝' }
      if (d.behavior === 'allow') {
        if ('updatedInput' in d && d.updatedInput !== undefined) return { action: 'modify', updatedInput: d.updatedInput }
        return { action: 'allow' }
      }
    }
    // cc PermissionDenied 格式:hookSpecificOutput.retry:boolean(types/hooks.ts:112-115)→ retry 折成 allow
    // (消费方 applyPermissionDeniedHooks 把 allow 读作 retryRequested)。
    if (isRecord(hso) && hso.hookEventName === 'PermissionDenied' && hso.retry === true) {
      return { action: 'allow' }
    }
    // cc Elicitation/ElicitationResult 格式:hookSpecificOutput.action(accept/decline/cancel)+ content
    // (types/hooks.ts:135-144)→ 专用 elicitation 决策,消费方转成 MCP elicitation 代答。
    if (isRecord(hso) && (hso.hookEventName === 'Elicitation' || hso.hookEventName === 'ElicitationResult')) {
      const action = hso.action
      if (action === 'accept' || action === 'decline' || action === 'cancel') {
        return { action: 'elicitation', elicitationAction: action, content: isRecord(hso.content) ? hso.content : undefined }
      }
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

/**
 * 每事件的 matcher 匹配键(对齐 cc executeHooks 各 fire 点的 matchQuery):
 * 工具类事件按 toolName、子代理类按 agentType、Notification 按 notification_type、Setup 按 trigger、
 * ConfigChange 按 source、StopFailure 按 error、InstructionsLoaded 按 load_reason、
 * Elicitation/ElicitationResult 按 mcp_server_name、PreCompact/PostCompact 按 trigger、SessionEnd 按 reason。
 * 无匹配键的事件(TeammateIdle/TaskCreated/TaskCompleted/两个 Worktree 事件/Cwd/FileChanged 等)cc 也
 * 不传 matchQuery → 回落 toolName/agentType(通常 undefined,即只有无 matcher 的规则命中)。
 */
function matchTarget(payload: HookPayload): string | undefined {
  switch (payload.event) {
    case 'Notification': return payload.notificationType ?? payload.toolName
    case 'Setup': return payload.setupTrigger
    case 'ConfigChange': return payload.configSource
    case 'StopFailure': return payload.errorMessage
    case 'InstructionsLoaded': return payload.loadReason
    case 'Elicitation':
    case 'ElicitationResult': return payload.mcpServerName
    case 'PreCompact':
    case 'PostCompact': return payload.compactTrigger
    case 'SessionEnd': return payload.sessionEndReason
    default: return payload.toolName ?? payload.agentType
  }
}

function matches(rule: HookRule, payload: HookPayload): boolean {
  if (rule.event !== payload.event) return false
  if (!rule.matcher || rule.matcher === '*') return true
  return matchesToolMatcher(rule.matcher, matchTarget(payload))
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
  /**
   * cc PreToolUse permissionDecision:'allow' → hook 明确要求跳过审批弹窗直接放行(对齐 cc
   * resolveHookPermissionDecision,src/services/tools/toolHooks.ts:333-435)。是否真的生效由调用方
   * 用 `hookAllowBypassesAsk` 结合 `resolvePermission()` 的结果判定——deny 总覆盖(已在本函数内提前
   * return)、ask 优先于 allow(`askRequested` 同时为真时不生效)、且不越过显式 ask 规则/工具自身强制
   * 交互闸(见 hookAllowBypassesAsk 的取舍说明)。
   */
  allowRequested?: boolean
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
  let allowRequested = false
  const decisions = await runHookEvent(registry, { event: 'PreToolUse', toolName, input }, ctx)
  // 对齐 cc(utils/hooks.ts 聚合区):全部决策跑完再统一返回——deny 仍最高优先,但**不在循环里短路**,
  // 否则排在 deny 之后的 hook 贡献的 additionalContext 会被丢(2026-07-12 审计发现的真分叉,首个 deny 的 message 生效)。
  let denied = false
  let deniedMessage: string | undefined
  for (const decision of decisions) {
    if (decision.action === 'deny') { if (!denied) { denied = true; deniedMessage = decision.message } }
    if (decision.action === 'ask') { askRequested = true; askMessage = decision.message ?? askMessage }
    // deny>ask>allow 聚合优先级(对齐 cc):allow 独立记录,谁赢由消费方(hookAllowBypassesAsk)判——
    // ask 与 allow 同时出现时消费方按 askRequested 优先丢弃 allow 的效力。
    if (decision.action === 'allow') allowRequested = true
    if (decision.action === 'modify') nextInput = decision.updatedInput
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
  }
  if (denied) return { input: nextInput, deniedMessage, additionalContext }
  return {
    input: nextInput,
    additionalContext,
    ...(askRequested ? { askRequested, askMessage } : {}),
    ...(allowRequested ? { allowRequested } : {}),
  }
}

/**
 * 消费 PreToolUse hook 的显式 allow 决策(对齐 cc resolveHookPermissionDecision,
 * `src/services/tools/toolHooks.ts:333-435`):hook allow 只跳过"当前权限档位默认该弹窗确认"这一层,
 * **不**越过:
 *  - deny(调用方在 `applyPreToolUseHooks` 已提前 return,这里不会走到);
 *  - 显式 ask 规则(`decision.reason.type === 'rule'`,cc `checkRuleBasedPermissions` 的 ask 分支);
 *  - 工具自身强制交互闸(`forceConfirm`/`requiresUserInteraction`,产品红线:连 bypassPermissions
 *    也拦,hook 更不该能绕过——对应 cc `requiresInteraction` 守卫,始终优先于 hook 结果);
 *  - acceptEdits 安全检查(`safetyCheck`,.git/mcp 配置等敏感路径退回询问的加固闸)。
 * 只有 `decision.reason.type === 'mode'`(纯粹因为默认权限档位要问、没有任何规则/安全闸参与,对应 cc
 * `checkRuleBasedPermissions` 返回 null 的情形)才被 hook allow 豁免。
 *
 * 用法(供 harness/loop.ts 在 `resolvePermission()` 之后接线,本次改动未接线到 loop——见调用方接线说明):
 *   const hookResult = await applyPreToolUseHooks(hooks, call.name, call.input, ctx)
 *   const decision = resolvePermission(tool, hookResult.input, ctx)
 *   if (decision.behavior === 'ask' && hookAllowBypassesAsk(hookResult, decision)) {
 *     // 跳过审批弹窗,直接按 allow 执行
 *   }
 */
export function hookAllowBypassesAsk(
  hookResult: Pick<PreToolUseResult, 'askRequested' | 'allowRequested'>,
  decision: Pick<PermissionDecision, 'behavior' | 'reason'>,
): boolean {
  if (!hookResult.allowRequested) return false
  if (hookResult.askRequested) return false // deny>ask>allow:ask 赢
  if (decision.behavior !== 'ask') return false
  return decision.reason?.type === 'mode'
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

/** 通用"上下文型"事件派发:收 context/把 deny 折成警告文,不阻断(与 PostToolUse/SessionStart 同款语义)。 */
async function collectContextHooks(registry: HookRegistry | undefined, payload: HookPayload, ctx: ToolContext, warnLabel: string): Promise<HookContextResult> {
  const additionalContext: string[] = []
  const decisions = await runHookEvent(registry, payload, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') additionalContext.push(`[${warnLabel} hook 警告] ${decision.message}`)
  }
  return { additionalContext }
}

/**
 * PreCompact:压缩流程即将执行时触发(对齐 cc compact.ts:445 executePreCompactHooks,fire 在真压缩前)。
 * 本项目暂不把 customInstructions 回注摘要请求,故只收 additionalContext 作压缩通知/上下文补充。
 */
export async function applyPreCompactHooks(
  registry: HookRegistry | undefined,
  trigger: 'auto' | 'manual',
  ctx: ToolContext,
  customInstructions: string | null = null,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'PreCompact',
    compactTrigger: trigger,
    compactCustomInstructions: customInstructions,
    sessionId: ctx.conversationId,
  }, ctx, 'PreCompact')
}

/** PostCompact:压缩完成后触发(对齐 cc compact.ts:755 executePostCompactHooks),载荷带摘要文本。 */
export async function applyPostCompactHooks(
  registry: HookRegistry | undefined,
  trigger: 'auto' | 'manual',
  compactSummary: string,
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'PostCompact',
    compactTrigger: trigger,
    compactSummary,
    sessionId: ctx.conversationId,
  }, ctx, 'PostCompact')
}

/**
 * SessionEnd:会话结束/清空/退出时触发(对齐 cc SessionEnd,reason=clear/resume/logout/other…)。
 * 派发器就绪;call site 在宿主壳/服务器的会话关停处接线(见本任务返回说明)。
 */
export async function applySessionEndHooks(
  registry: HookRegistry | undefined,
  reason: string,
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'SessionEnd',
    sessionEndReason: reason,
    sessionId: ctx.conversationId,
  }, ctx, 'SessionEnd')
}

/**
 * Notification:向用户发通知时触发(对齐 cc Notification,message/title/notification_type)。
 * 派发器就绪;call site 在宿主发通知处接线(权限待确认/空闲/任务完成等)。
 */
export async function applyNotificationHooks(
  registry: HookRegistry | undefined,
  notification: { message: string; title?: string; notificationType?: string },
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'Notification',
    notificationMessage: notification.message,
    notificationTitle: notification.title,
    notificationType: notification.notificationType ?? 'generic',
    sessionId: ctx.conversationId,
  }, ctx, 'Notification')
}

/**
 * PostToolUseFailure:工具执行抛错时触发(对齐 cc PostToolUseFailure,error+tool_name+tool_input)。
 * 非阻断:只把 hook 追加的上下文回灌,不改变"错误已回灌让模型自救"的既有失败路径。
 */
export async function applyPostToolUseFailureHooks(
  registry: HookRegistry | undefined,
  toolName: string,
  input: unknown,
  errorMessage: string,
  ctx: ToolContext,
  toolUseId?: string,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'PostToolUseFailure',
    toolName,
    input,
    errorMessage,
    toolUseId,
    sessionId: ctx.conversationId,
  }, ctx, 'PostToolUseFailure')
}

/**
 * StopFailure:Stop 流程/收尾出错时触发(对齐 cc StopFailure)。派发器就绪;call site 由宿主错误收尾处接线。
 */
export async function applyStopFailureHooks(
  registry: HookRegistry | undefined,
  errorMessage: string,
  ctx: ToolContext,
  opts: { finalText?: string; subagent?: { agentId: string; agentType: string } } = {},
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'StopFailure',
    errorMessage,
    output: opts.finalText,
    agentId: opts.subagent?.agentId,
    agentType: opts.subagent?.agentType,
    sessionId: ctx.conversationId,
  }, ctx, 'StopFailure')
}

/** registry 里是否声明了某事件的规则(供"有 hook 才走 hook 路"的消费方判断,如 WorktreeCreate provider)。 */
export function hasHookForEvent(registry: HookRegistry | undefined, event: HookEvent): boolean {
  return !!registry?.rules.some(rule => rule.event === event)
}

export interface PermissionRequestHookResult {
  /** hook 程序化裁决:allow=跳过审批卡直接放行,deny=直接拒绝;undefined=无裁决,照常弹审批卡。 */
  behavior?: 'allow' | 'deny'
  message?: string
  /** allow 附带的改参(cc decision.updatedInput)。 */
  updatedInput?: unknown
  additionalContext: string[]
}

/**
 * PermissionRequest:审批卡即将弹给用户时触发(对齐 cc executePermissionRequestHooks,
 * utils/hooks.ts:4176-4211,matchQuery=toolName)。hook 可程序化 allow/deny 免弹窗。
 * 聚合:deny 短路优先 > allow;modify 视作 allow+改参(cc decision.behavior:'allow'+updatedInput)。
 * call site:harness/loop.ts gateOneCall 的 ask 分支,yield approval_request 之前。
 */
export async function applyPermissionRequestHooks(
  registry: HookRegistry | undefined,
  toolName: string,
  input: unknown,
  ctx: ToolContext,
  opts: { toolUseId?: string; permissionSuggestions?: unknown[] } = {},
): Promise<PermissionRequestHookResult> {
  const additionalContext: string[] = []
  let behavior: 'allow' | 'deny' | undefined
  let message: string | undefined
  let updatedInput: unknown
  const decisions = await runHookEvent(registry, {
    event: 'PermissionRequest',
    toolName,
    input,
    toolUseId: opts.toolUseId,
    permissionSuggestions: opts.permissionSuggestions,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'deny') return { behavior: 'deny', message: decision.message, additionalContext }
    if (decision.action === 'allow') { behavior = 'allow'; message = decision.message ?? message }
    if (decision.action === 'modify') { behavior = 'allow'; updatedInput = decision.updatedInput }
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
  }
  return { behavior, message, updatedInput, additionalContext }
}

export interface PermissionDeniedHookResult extends HookContextResult {
  /** cc hookSpecificOutput.retry:hook 要求重试该工具调用(parseHookDecisionJSON 把 retry:true 折成 allow)。 */
  retryRequested?: boolean
}

/**
 * PermissionDenied:权限被拒后触发(对齐 cc executePermissionDeniedHooks,utils/hooks.ts:3549-3581,
 * matchQuery=toolName,载荷带拒绝 reason)。call site:harness/loop.ts 的 deny 回灌分支。
 */
export async function applyPermissionDeniedHooks(
  registry: HookRegistry | undefined,
  toolName: string,
  input: unknown,
  reason: string,
  ctx: ToolContext,
  toolUseId?: string,
): Promise<PermissionDeniedHookResult> {
  const additionalContext: string[] = []
  let retryRequested = false
  const decisions = await runHookEvent(registry, {
    event: 'PermissionDenied',
    toolName,
    input,
    permissionReason: reason,
    toolUseId,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'allow') retryRequested = true
    if (decision.action === 'deny') additionalContext.push(`[PermissionDenied hook 警告] ${decision.message}`)
  }
  return retryRequested ? { additionalContext, retryRequested } : { additionalContext }
}

/**
 * Setup:初始化/维护流程触发(对齐 cc executeSetupHooks,matchQuery=trigger)。
 * 派发器就绪;call site 待宿主初始化/维护流程出现时接(本产品暂无 cc `--setup` 对应流程)。
 */
export async function applySetupHooks(
  registry: HookRegistry | undefined,
  trigger: 'init' | 'maintenance',
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'Setup',
    setupTrigger: trigger,
    sessionId: ctx.conversationId,
  }, ctx, 'Setup')
}

/**
 * TeammateIdle:队友代理即将闲置时触发(对齐 cc executeTeammateIdleHooks,utils/hooks.ts:3728-3748)。
 * deny = 阻断闲置(队友应继续干活),走 blockingFeedback 语义。
 * 派发器就绪;call site 待 team 运行时出现"即将闲置"节点时接。
 */
export async function applyTeammateIdleHooks(
  registry: HookRegistry | undefined,
  teammateName: string,
  teamName: string,
  ctx: ToolContext,
): Promise<HookContextResult> {
  const additionalContext: string[] = []
  const blockingFeedback: string[] = []
  const decisions = await runHookEvent(registry, {
    event: 'TeammateIdle',
    teammateName,
    teamName,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') blockingFeedback.push(`TeammateIdle hook feedback:\n${decision.message}`)
  }
  return blockingFeedback.length > 0 ? { additionalContext, blockingFeedback } : { additionalContext }
}

export interface TaskLifecycleHookInfo {
  taskId: string
  taskSubject: string
  taskDescription?: string
  teammateName?: string
  teamName?: string
}

/**
 * TaskCreated/TaskCompleted:任务创建/完成时触发(对齐 cc executeTaskCreatedHooks/executeTaskCompletedHooks,
 * utils/hooks.ts:3764-3836)。deny = 阻止创建/完成(deniedMessage 回给调用方展示/回灌)。
 * call site:tasks/taskListService 的 create 与 completed 状态切换。
 */
export async function applyTaskLifecycleHooks(
  registry: HookRegistry | undefined,
  event: 'TaskCreated' | 'TaskCompleted',
  info: TaskLifecycleHookInfo,
  ctx: ToolContext,
): Promise<HookContextResult> {
  const additionalContext: string[] = []
  const decisions = await runHookEvent(registry, {
    event,
    taskId: info.taskId,
    taskSubject: info.taskSubject,
    taskDescription: info.taskDescription,
    teammateName: info.teammateName,
    teamName: info.teamName,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') return { additionalContext, deniedMessage: decision.message }
  }
  return { additionalContext }
}

export interface ElicitationHookInfo {
  serverName: string
  message: string
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
  requestedSchema?: Record<string, unknown>
}

export interface ElicitationHookResult extends HookContextResult {
  /** hook 代答(accept/decline/cancel + content),有值即不再问用户(对齐 cc elicitationResponse)。 */
  response?: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
}

/**
 * Elicitation:MCP 服务器发起 elicitation、即将问用户之前触发(对齐 cc executeElicitationHooks,
 * utils/hooks.ts:4489-4542,matchQuery=serverName)。hook 可代答(elicitation 决策)或阻断(deny)。
 * call site:mcp elicitation 桥(问用户之前)。
 */
export async function applyElicitationHooks(
  registry: HookRegistry | undefined,
  info: ElicitationHookInfo,
  ctx: ToolContext,
): Promise<ElicitationHookResult> {
  const additionalContext: string[] = []
  let response: ElicitationHookResult['response']
  let deniedMessage: string | undefined
  const decisions = await runHookEvent(registry, {
    event: 'Elicitation',
    mcpServerName: info.serverName,
    elicitationMessage: info.message,
    elicitationMode: info.mode,
    elicitationUrl: info.url,
    elicitationId: info.elicitationId,
    elicitationRequestedSchema: info.requestedSchema,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') deniedMessage = decision.message
    if (decision.action === 'elicitation') {
      response = { action: decision.elicitationAction, content: decision.content }
      // 对齐 cc parseElicitationHookOutput:decline 代答同时视作阻断(带原因)。
      if (decision.elicitationAction === 'decline') deniedMessage = deniedMessage ?? 'Elicitation denied by hook'
    }
  }
  return { response, deniedMessage, additionalContext }
}

/**
 * ElicitationResult:用户(或 hook)对 elicitation 作答之后触发(对齐 cc executeElicitationResultHooks,
 * utils/hooks.ts:4544-4594)。deny/decline = 阻断该结果继续送回服务器。
 * call site:mcp elicitation 桥(拿到回答之后、回给服务器之前)。
 */
export async function applyElicitationResultHooks(
  registry: HookRegistry | undefined,
  info: { serverName: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown>; mode?: 'form' | 'url'; elicitationId?: string },
  ctx: ToolContext,
): Promise<ElicitationHookResult> {
  const additionalContext: string[] = []
  let response: ElicitationHookResult['response']
  let deniedMessage: string | undefined
  const decisions = await runHookEvent(registry, {
    event: 'ElicitationResult',
    mcpServerName: info.serverName,
    elicitationAction: info.action,
    elicitationContent: info.content,
    elicitationMode: info.mode,
    elicitationId: info.elicitationId,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context') additionalContext.push(decision.additionalContext)
    if (decision.action === 'deny') deniedMessage = decision.message
    if (decision.action === 'elicitation') {
      response = { action: decision.elicitationAction, content: decision.content }
      if (decision.elicitationAction === 'decline') deniedMessage = deniedMessage ?? 'Elicitation result blocked by hook'
    }
  }
  return { response, deniedMessage, additionalContext }
}

/**
 * ConfigChange:配置文件在会话期间变更时触发(对齐 cc executeConfigChangeHooks,utils/hooks.ts:4233-4258,
 * matchQuery=source;审计用途)。call site:create_skill 写盘(source:'skills')、权限规则持久化写回
 * (source:'local_settings')等配置写入点。
 */
export async function applyConfigChangeHooks(
  registry: HookRegistry | undefined,
  source: 'user_settings' | 'project_settings' | 'local_settings' | 'skills',
  filePath: string | undefined,
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'ConfigChange',
    configSource: source,
    filePath,
    sessionId: ctx.conversationId,
  }, ctx, 'ConfigChange')
}

/**
 * InstructionsLoaded:项目指令/记忆文件被载入上下文时触发(对齐 cc executeInstructionsLoadedHooks,
 * utils/hooks.ts:4354-4388,matchQuery=load_reason;纯观测,不支持阻断)。
 * call site:harness/claudemd.ts 记忆注入加载处(fire-and-forget)。
 */
export async function applyInstructionsLoadedHooks(
  registry: HookRegistry | undefined,
  info: { filePath: string; memoryType: string; loadReason: string; globs?: string[]; triggerFilePath?: string; parentFilePath?: string },
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'InstructionsLoaded',
    filePath: info.filePath,
    memoryType: info.memoryType,
    loadReason: info.loadReason,
    instructionGlobs: info.globs,
    triggerFilePath: info.triggerFilePath,
    parentFilePath: info.parentFilePath,
    sessionId: ctx.conversationId,
  }, ctx, 'InstructionsLoaded')
}

export interface WorktreeCreateHookResult extends HookContextResult {
  /** hook 产出的 worktree 路径(cc:hook stdout 即路径;我们取第一条非空 context 决策文本)。 */
  worktreePath?: string
}

/**
 * WorktreeCreate:创建 worktree 时触发(对齐 cc executeWorktreeCreateHook,utils/hooks.ts:4947-4977)。
 * 这是"提供者"hook:配置了它就由 hook 决定 worktree 路径(stdout=路径),取代默认 git worktree 创建。
 * 消费方先用 hasHookForEvent 判有没有配置;配置了但没产出路径 → deniedMessage 报失败(对齐 cc throw)。
 * call site:tools/worktreeTools.ts EnterWorktree / agents createIsolatedAgentWorktree。
 */
export async function applyWorktreeCreateHooks(
  registry: HookRegistry | undefined,
  name: string,
  ctx: ToolContext,
): Promise<WorktreeCreateHookResult> {
  const additionalContext: string[] = []
  let worktreePath: string | undefined
  let deniedMessage: string | undefined
  const decisions = await runHookEvent(registry, {
    event: 'WorktreeCreate',
    worktreeName: name,
    sessionId: ctx.conversationId,
  }, ctx)
  for (const decision of decisions) {
    if (decision.action === 'context' && !worktreePath) {
      const text = decision.additionalContext.trim()
      if (text) worktreePath = text.split('\n')[0]?.trim()
    }
    if (decision.action === 'deny') deniedMessage = decision.message
  }
  if (!worktreePath && hasHookForEvent(registry, 'WorktreeCreate')) {
    deniedMessage = deniedMessage ?? 'WorktreeCreate hook failed: no successful output'
  }
  return { worktreePath, deniedMessage, additionalContext }
}

/**
 * WorktreeRemove:移除 worktree 时触发(对齐 cc executeWorktreeRemoveHook,utils/hooks.ts:4986-5022;
 * 失败只记日志不阻断)。call site:tools/worktreeTools.ts ExitWorktree / worktree 清理。
 */
export async function applyWorktreeRemoveHooks(
  registry: HookRegistry | undefined,
  worktreePath: string,
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'WorktreeRemove',
    worktreePath,
    sessionId: ctx.conversationId,
  }, ctx, 'WorktreeRemove')
}

/**
 * CwdChanged:会话工作目录切换时触发(对齐 cc executeCwdChangedHooks,utils/hooks.ts:4279-4295)。
 * cc 的 watchPaths 返回值管线(喂 FileChanged watcher)未建,先收 context;派发器就绪,
 * call site 待宿主"会话中切换工作区"流程接。
 */
export async function applyCwdChangedHooks(
  registry: HookRegistry | undefined,
  oldCwd: string,
  newCwd: string,
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'CwdChanged',
    oldCwd,
    newCwd,
    sessionId: ctx.conversationId,
  }, ctx, 'CwdChanged')
}

/**
 * FileChanged:被监听文件变更时触发(对齐 cc executeFileChangedHooks,utils/hooks.ts:4297-4313)。
 * ⚠️ 需要文件监听基建(cc:SessionStart/CwdChanged hook 返回 watchPaths → sessionEnvironment watcher),
 * 本项目 watcher 未建——派发器就绪、call site 登记待建,事件可声明不再被吞。
 */
export async function applyFileChangedHooks(
  registry: HookRegistry | undefined,
  filePath: string,
  event: 'change' | 'add' | 'unlink',
  ctx: ToolContext,
): Promise<HookContextResult> {
  return collectContextHooks(registry, {
    event: 'FileChanged',
    filePath,
    fileEvent: event,
    sessionId: ctx.conversationId,
  }, ctx, 'FileChanged')
}
