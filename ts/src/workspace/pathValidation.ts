import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { resolveInWorkspace } from './pathBoundary'

export type FileOperation = 'read' | 'write' | 'create'

const GLOB_PATTERN_REGEX = /[*?[\]{}]/
const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/

// UNC 检测:按安全行为要求拦截高风险网络共享路径,实现放在我们自己的 workspace 边界里。
// \\server\share · //server/share(排除 URL 的 (?<!:)) · 混合分隔 /\\server · \\/server
const UNC_PATTERNS: RegExp[] = [
  /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
  /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
  /\/\\{2,}[^\s\\/]/,
  /\\{2,}\/[^\s\\/]/,
]

export class PathValidationError extends Error {
  constructor(
    readonly requested: string,
    readonly reason: string,
  ) {
    super(`路径校验失败：${reason}（${requested}）`)
    this.name = 'PathValidationError'
  }
}

/** 展开开头的 ~ 和 ~/(win 还含 ~\)到 home;~user/~+/~- 不展开(留待 validatePath 拒)。 */
export function expandTilde(
  path: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (path === '~' || path.startsWith('~/') || (platform === 'win32' && path.startsWith('~\\'))) {
    return home + path.slice(1)
  }
  return path
}

/** Windows UNC 路径(可致凭据外泄);UNC 是 Windows 概念,非 win 平台恒 false。 */
export function isVulnerableUncPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  return UNC_PATTERNS.some(re => re.test(path))
}

/** 灾难级删除目标:根 / 盘符根 / home / 根直接子级 / 盘符直接子级 / `*` / `…/*`。 */
export function isDangerousRemovalPath(resolvedPath: string, home: string = homedir()): boolean {
  const fwd = resolvedPath.replace(/[\\/]+/g, '/')
  if (fwd === '*' || fwd.endsWith('/*')) return true
  const norm = fwd === '/' ? fwd : fwd.replace(/\/$/, '')
  if (norm === '/') return true
  if (WINDOWS_DRIVE_ROOT_REGEX.test(norm)) return true
  if (norm === home.replace(/[\\/]+/g, '/')) return true
  if (dirname(norm) === '/') return true
  if (WINDOWS_DRIVE_CHILD_REGEX.test(norm)) return true
  return false
}

/**
 * 应用层 TOCTOU 护栏:在 resolveInWorkspace 边界判定之前,
 * 先挡掉 shell 执行时会"变身"的输入,消除"校验路径 A、执行读/写路径 B"的缺口。
 * 通过 → 返回工作区内绝对路径;TOCTOU 违规 → PathValidationError;逃出工作区 → WorkspaceBoundaryError。
 */
export function validatePath(
  requested: string,
  opts: { root: string; operation: FileOperation; platform?: NodeJS.Platform; home?: string },
): string {
  return resolveInWorkspace(opts.root, normalizeRequestedPathForValidation(requested, opts))
}

export function normalizeRequestedPathForValidation(
  requested: string,
  opts: { operation: FileOperation; platform?: NodeJS.Platform; home?: string },
): string {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()
  const cleaned = expandTilde(requested.replace(/^['"]|['"]$/g, ''), home, platform)

  if (isVulnerableUncPath(cleaned, platform)) {
    throw new PathValidationError(requested, 'UNC 网络路径需人工确认')
  }
  // expandTilde 已把 ~ / ~/ 变成绝对路径,残留以 ~ 开头的只剩 ~user/~+/~- 变体
  if (cleaned.startsWith('~')) {
    throw new PathValidationError(requested, '~user/~+/~- 波浪号变体需人工确认')
  }
  if (cleaned.includes('$') || cleaned.includes('%') || cleaned.startsWith('=')) {
    throw new PathValidationError(requested, 'shell 展开语法（$ % =）需人工确认')
  }
  if ((opts.operation === 'write' || opts.operation === 'create') && GLOB_PATTERN_REGEX.test(cleaned)) {
    throw new PathValidationError(requested, '写操作不允许 glob 通配，请给确切路径')
  }
  return cleaned
}
