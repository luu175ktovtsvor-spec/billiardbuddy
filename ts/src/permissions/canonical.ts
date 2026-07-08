/** 稳定序列化:递归按键排序 + 紧凑,保证同一值恒等字符串(actionKey 与 HMAC 规范化共用)。 */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(sort)
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sort(o[k])
    return out
  }
  return JSON.stringify(sort(value))
}

export const CANONICAL_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'] as const
export const LEGACY_PERMISSION_MODE_ALIASES = ['ask', 'auto_files', 'full'] as const

export type CanonicalPermissionMode = typeof CANONICAL_PERMISSION_MODES[number]
export type LegacyPermissionMode = typeof LEGACY_PERMISSION_MODE_ALIASES[number]
export type PermissionModeLike = CanonicalPermissionMode | LegacyPermissionMode

const LEGACY_TO_CANONICAL: Record<LegacyPermissionMode, CanonicalPermissionMode> = {
  ask: 'default',
  auto_files: 'acceptEdits',
  full: 'bypassPermissions',
}

export function parsePermissionMode(value: unknown): PermissionModeLike | undefined {
  if (typeof value !== 'string') return undefined
  const mode = value.trim()
  if ((CANONICAL_PERMISSION_MODES as readonly string[]).includes(mode)) return mode as CanonicalPermissionMode
  if ((LEGACY_PERMISSION_MODE_ALIASES as readonly string[]).includes(mode)) return mode as LegacyPermissionMode
  return undefined
}

export function canonicalPermissionMode(value: unknown): CanonicalPermissionMode {
  const parsed = parsePermissionMode(value)
  if (!parsed) return 'default'
  if ((LEGACY_PERMISSION_MODE_ALIASES as readonly string[]).includes(parsed)) {
    return LEGACY_TO_CANONICAL[parsed as LegacyPermissionMode]
  }
  return parsed as CanonicalPermissionMode
}

export function isPermissionMode(value: unknown): value is PermissionModeLike {
  return parsePermissionMode(value) !== undefined
}

/**
 * 子代理/后台任务的权限模式继承(对齐 cc AgentTool.tsx / runAgent.ts):
 * - 父级已放开(bypassPermissions/acceptEdits)时,始终优先,不被子代理 frontmatter 声明的更窄模式降级
 *   (用户把整个会话设成完全信任,子代理不应重新引入审批打断)。
 * - 否则用子代理自己声明的 permissionMode。
 * - 都没有时:后台/异步子代理用 acceptEdits 兜底(它们没法弹 UI 应答审批,继承 default/plan 会让写操作
 *   卡在无人应答的 ask);前台内联子代理沿用父级模式(审批仍可冒泡回父级 UI)。
 */
export function resolveSubagentPermissionMode(
  parentMode: PermissionModeLike | undefined,
  agentMode: PermissionModeLike | undefined,
  opts: { background: boolean },
): PermissionModeLike | undefined {
  const parentCanon = canonicalPermissionMode(parentMode)
  if (parentCanon === 'bypassPermissions' || parentCanon === 'acceptEdits') return parentMode
  if (agentMode) return agentMode
  return opts.background ? 'acceptEdits' : parentMode
}
