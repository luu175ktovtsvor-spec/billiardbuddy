import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MEMORY_DOT_DIR, getUserConfigHomeDir } from '../harness/memoryNames'
import type { PermissionBehavior, PermissionRule, PermissionRuleSource, PermissionRuleValue, PermissionUpdate } from './types'

const BEHAVIORS: PermissionBehavior[] = ['allow', 'deny', 'ask']

/**
 * 权限规则持久化(对齐 cc permissionsLoader/persistPermissionUpdate):从用户级 ~/.billiardbuddy/settings.json
 * (userSettings)与工作区 .billiardbuddy/settings.json(projectSettings)、settings.local.json(localSettings)
 * 加载 `permissions.{allow,deny,ask}` 规则,使"本会话允许"可选升级为跨重启持久化;规则字符串格式
 * 'Bash(npm install)' / 'Read'。
 *
 * ⚠️ 白标铁律:目录名走 `src/harness/memoryNames.ts` 的 MEMORY_DOT_DIR(.billiardbuddy)/ getUserConfigHomeDir
 * (~/.billiardbuddy),**绝不硬编码 .claude / ~/.claude**(那是 Claude 品牌目录、且与用户已装的 Claude Code 抢读)。
 *
 * ⚠️ 安全:工作区级 `allow` 规则是 RCE 攻击面(恶意仓库提交 allow:['Bash(*)'],用户一打开该目录就静默放行、
 * 绕过审批闸)。故 loadPermissionRules 内置**信任门**(applyPermissionTrustGate):未受信工作区丢弃工作区级
 * allow;deny/ask 只收紧、始终生效;用户级/managed 是用户自己的、不受此限。详见下方 configurePermissionTrust。
 */

/** 'Bash(npm install)' → {toolName:'Bash', ruleContent:'npm install'};'Read' → {toolName:'Read'}。 */
export function parsePermissionRuleString(raw: string): PermissionRuleValue | null {
  const s = raw.trim()
  if (!s) return null
  const open = s.indexOf('(')
  if (open === -1) return { toolName: s }
  if (!s.endsWith(')')) return { toolName: s } // 括号不闭合 → 当纯工具名
  const toolName = s.slice(0, open).trim()
  if (!toolName) return null
  const ruleContent = s.slice(open + 1, -1).replace(/\\([()])/g, '$1') // 反转义 \( \)
  return ruleContent ? { toolName, ruleContent } : { toolName }
}

/** {toolName:'Bash', ruleContent:'npm install'} → 'Bash(npm install)';内容里的括号转义。 */
export function permissionRuleValueToString(v: PermissionRuleValue): string {
  if (!v.ruleContent) return v.toolName
  return `${v.toolName}(${v.ruleContent.replace(/([()])/g, '\\$1')})`
}

function rulesFromSettingsObject(obj: unknown, source: PermissionRuleSource): PermissionRule[] {
  if (!obj || typeof obj !== 'object') return []
  const permissions = (obj as { permissions?: unknown }).permissions
  if (!permissions || typeof permissions !== 'object') return []
  const out: PermissionRule[] = []
  for (const behavior of BEHAVIORS) {
    const arr = (permissions as Record<string, unknown>)[behavior]
    if (!Array.isArray(arr)) continue
    for (const entry of arr) {
      if (typeof entry !== 'string') continue
      const ruleValue = parsePermissionRuleString(entry)
      if (ruleValue) out.push({ source, ruleBehavior: behavior, ruleValue })
    }
  }
  return out
}

/**
 * 工作区级权限信任门(对齐本仓库 hooks.ts configureHookTrust 同一套路,复用 McpTrustStore 同一信任源)。
 *
 * 恶意仓库若提交 <workspaceRoot>/.billiardbuddy/settings.json 里 permissions.allow=['Bash(*)','Read(**)'],
 * 用户用文件夹选择器一打开该目录,仓库内预置的 allow 规则就会直接生效,绕过用户自己的权限设置。
 * 我们对 .mcp.json 有 McpTrustStore 信任门、对 hooks 有信任门,这里给权限 allow 规则补上同一道门。
 *
 * 门的口径(对齐 cc folder trust 的安全意图,裁剪到"无 trust 弹窗 UI"的现状):
 * - 工作区级(projectSettings/localSettings)的 **allow** 规则:仅当该工作区受信才生效(未受信 → 丢弃,仍需审批)。
 * - 工作区级 **deny/ask**:只会收紧,**始终生效**(未受信也保留)。
 * - **用户级(userSettings,~/.billiardbuddy)与 managed(policySettings)**:那是用户/机构自己的配置,**不受工作区信任门约束**。
 *
 * cc 的对应机制:folder trust 是会话启动前的**硬阻断弹窗**(checkHasTrustDialogAccepted / TrustDialog),
 * 未受信文件夹在用户点"信任"前根本跑不起来、届时 project/local settings 才生效。本产品**尚无 trust 授予 UI**
 * (仅 POST /api/v1/agent/mcp/trust),故采用与 hooks 同款的"定向门"——只挡真正的 RCE 面(工作区 allow),
 * 不做全会话阻断(避免默认未受信下把产品跑死且零安全收益)。
 *
 * 宿主(server/index.ts、Electron 壳)在启动时调用
 *   configurePermissionTrust({ interactive: true, isWorkspaceTrusted: root => mcpTrust.isTrusted(root) })
 * 即接通与 hooks 同一个 McpTrustStore 的工作区信任判定,激活本门。未注入时缺省 alwaysTrusted(不 gate),
 * 保持无宿主/测试/SDK 路径行为不变(等价隐式信任)。
 */
export interface PermissionTrustPolicy {
  /** 交互会话:未受信工作区的工作区级 allow 不生效;非交互(SDK/headless)时 trust 隐式成立、不 gate。 */
  interactive: boolean
  /** 工作区是否受信(接 McpTrustStore.isTrusted)。 */
  isWorkspaceTrusted: (workspaceRoot: string) => boolean
}

const alwaysTrusted = (): boolean => true

/** 宿主注入的信任策略覆盖(部分字段);字段级覆盖优先于默认。 */
let permissionTrustOverride: Partial<PermissionTrustPolicy> | null = null

/** 注入/合并宿主信任策略;传 null 清空(等价 resetPermissionTrust)。 */
export function configurePermissionTrust(policy: Partial<PermissionTrustPolicy> | null): void {
  permissionTrustOverride = policy && Object.keys(policy).length > 0 ? { ...policy } : null
}

/** 复位信任策略到默认(供测试与会话结束清理)。 */
export function resetPermissionTrust(): void {
  permissionTrustOverride = null
}

/**
 * 解析当前生效的信任策略:override 字段 > 安全默认。
 * 默认 interactive=true 是纵深防御(即便宿主只注入 isWorkspaceTrusted、忘了 interactive,门仍生效);
 * 未接线时 isWorkspaceTrusted 缺省 alwaysTrusted → 不 gate,兼容无宿主/测试路径不改行为。
 */
export function resolvePermissionTrustPolicy(): PermissionTrustPolicy {
  const override = permissionTrustOverride
  return {
    interactive: override?.interactive ?? true,
    isWorkspaceTrusted: override?.isWorkspaceTrusted ?? alwaysTrusted,
  }
}

/** 工作区级来源(随被打开的仓库文件而来,是 RCE 攻击面);userSettings/policySettings 是用户/机构自己的,不算。 */
function isWorkspaceLevelSource(source: PermissionRuleSource): boolean {
  return source === 'projectSettings' || source === 'localSettings'
}

/**
 * 信任门过滤:未受信工作区里丢弃**工作区级 allow** 规则(仍需审批);deny/ask 保留(只收紧);
 * 用户级/managed 一律保留。受信任、非交互、或 policy 缺省 alwaysTrusted → 原样返回。
 */
export function applyPermissionTrustGate(
  rules: PermissionRule[],
  workspaceRoot: string,
  policy: PermissionTrustPolicy = resolvePermissionTrustPolicy(),
): PermissionRule[] {
  if (!policy.interactive) return rules
  if (policy.isWorkspaceTrusted(workspaceRoot)) return rules
  return rules.filter(rule => !(rule.ruleBehavior === 'allow' && isWorkspaceLevelSource(rule.source)))
}

/** 工作区级设置文件(白标:.billiardbuddy/,不用 .claude)。 */
const WORKSPACE_SETTINGS_FILES: Array<{ rel: string; source: PermissionRuleSource }> = [
  { rel: join(MEMORY_DOT_DIR, 'settings.json'), source: 'projectSettings' },
  { rel: join(MEMORY_DOT_DIR, 'settings.local.json'), source: 'localSettings' },
]

/**
 * 用户级权限规则:~/.billiardbuddy/settings.json(userSettings 源,白标目录 getUserConfigHomeDir 派生)。
 * 那是用户自己的全局配置,**不受工作区信任门约束**,对所有工作区生效。
 */
export async function loadUserPermissionRules(): Promise<PermissionRule[]> {
  try {
    const raw = await readFile(join(getUserConfigHomeDir(), 'settings.json'), 'utf8')
    return rulesFromSettingsObject(JSON.parse(raw) as unknown, 'userSettings')
  } catch {
    return [] // 文件不存在/坏 JSON → 跳过
  }
}

/**
 * 加载持久化权限规则(跨重启生效):用户级 ~/.billiardbuddy/settings.json + 工作区
 * .billiardbuddy/settings.json + settings.local.json,末尾套**信任门**(未受信工作区丢弃工作区级 allow)。
 */
export async function loadPermissionRules(workspaceRoot: string): Promise<PermissionRule[]> {
  const rules: PermissionRule[] = [...(await loadUserPermissionRules())]
  for (const { rel, source } of WORKSPACE_SETTINGS_FILES) {
    try {
      const raw = await readFile(join(workspaceRoot, rel), 'utf8')
      rules.push(...rulesFromSettingsObject(JSON.parse(raw) as unknown, source))
    } catch {
      // 文件不存在/坏 JSON → 跳过
    }
  }
  return applyPermissionTrustGate(rules, workspaceRoot)
}

/** 已加载的持久化规则 → PermissionUpdate[](按 behavior 分组 addRules),供 applyPermissionUpdates 塞进 ctx.permissionRules。 */
export function permissionUpdatesFromRules(rules: PermissionRule[]): PermissionUpdate[] {
  const byBehavior = new Map<PermissionBehavior, PermissionRuleValue[]>()
  for (const rule of rules) {
    const list = byBehavior.get(rule.ruleBehavior) ?? []
    list.push(rule.ruleValue)
    byBehavior.set(rule.ruleBehavior, list)
  }
  return [...byBehavior.entries()].map(([behavior, values]) => ({
    type: 'addRules',
    destination: 'localSettings',
    behavior,
    rules: values,
  }))
}

/** 把一条规则持久化到工作区 .billiardbuddy/settings.local.json(localSettings),跨重启生效;已存在则不重复。 */
export async function persistPermissionRule(workspaceRoot: string, behavior: PermissionBehavior, ruleValue: PermissionRuleValue): Promise<void> {
  const path = join(workspaceRoot, MEMORY_DOT_DIR, 'settings.local.json')
  let settings: { permissions?: Record<string, string[]> } = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') settings = parsed as typeof settings
  } catch {
    // 新建
  }
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {}
  const list = Array.isArray(settings.permissions[behavior]) ? settings.permissions[behavior]! : (settings.permissions[behavior] = [])
  const str = permissionRuleValueToString(ruleValue)
  if (!list.includes(str)) list.push(str)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}
