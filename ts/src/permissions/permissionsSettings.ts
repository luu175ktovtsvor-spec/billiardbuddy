import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PermissionBehavior, PermissionRule, PermissionRuleSource, PermissionRuleValue, PermissionUpdate } from './types'

const BEHAVIORS: PermissionBehavior[] = ['allow', 'deny', 'ask']

/**
 * 权限规则持久化(对齐 cc permissionsLoader/persistPermissionUpdate):从工作区 .claude/settings.json
 * (projectSettings)与 settings.local.json(localSettings)加载 `permissions.{allow,deny,ask}` 规则,
 * 使"本会话允许"可选升级为跨重启持久化;规则字符串格式 'Bash(npm install)' / 'Read'。
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

const SETTINGS_FILES: Array<{ rel: string; source: PermissionRuleSource }> = [
  { rel: '.claude/settings.json', source: 'projectSettings' },
  { rel: '.claude/settings.local.json', source: 'localSettings' },
]

/** 从工作区 .claude/settings.json + settings.local.json 加载持久化权限规则(跨重启生效)。 */
export async function loadPermissionRules(workspaceRoot: string): Promise<PermissionRule[]> {
  const rules: PermissionRule[] = []
  for (const { rel, source } of SETTINGS_FILES) {
    try {
      const raw = await readFile(join(workspaceRoot, rel), 'utf8')
      rules.push(...rulesFromSettingsObject(JSON.parse(raw) as unknown, source))
    } catch {
      // 文件不存在/坏 JSON → 跳过
    }
  }
  return rules
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

/** 把一条规则持久化到工作区 settings.local.json(localSettings),跨重启生效;已存在则不重复。 */
export async function persistPermissionRule(workspaceRoot: string, behavior: PermissionBehavior, ruleValue: PermissionRuleValue): Promise<void> {
  const path = join(workspaceRoot, '.claude', 'settings.local.json')
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
