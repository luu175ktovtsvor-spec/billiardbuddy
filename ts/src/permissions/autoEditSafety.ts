import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import type { ToolContext } from '../tools/Tool'
import { normalizeRequestedPathForValidation } from '../workspace/pathValidation'

/**
 * acceptEdits 档自动放行文件编辑前的安全闸(移植 cc-haha
 * `src/utils/permissions/filesystem.ts` 的 checkPathSafetyForAutoEdit)。
 *
 * cc 的语义:default 档所有文件写改都要问;acceptEdits 才对"工作区内文件类动作"自动放行。
 * 但即使 acceptEdits,也不能自动去写 .git/.vscode/.idea/.claude 目录里的文件、
 * shell/git/mcp/claude 配置文件,或带 Windows 路径规范化绕过特征的路径——这些一律退回询问,
 * 防止通过自动接受编辑去做 git 数据外泄/代码执行/配置篡改。bypassPermissions(yolo)不受此闸约束,
 * 与 cc 一致。
 *
 * ⚠️ 危险清单严格按 cc 当前源码移植,不擅自增删(cc 的清单里没有 .env/.ssh——那属于命令层
 * 敏感路径处理,不在自动编辑闸内;若产品要另加是单独的差异决策)。
 */

// 对齐 cc DANGEROUS_FILES
export const DANGEROUS_AUTO_EDIT_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
] as const

// 对齐 cc DANGEROUS_DIRECTORIES
export const DANGEROUS_AUTO_EDIT_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude'] as const

export interface AutoEditSafetyUnsafe {
  safe: false
  message: string
  classifierApprovable: boolean
}
export type AutoEditSafetyResult = { safe: true } | AutoEditSafetyUnsafe

function lower(value: string): string {
  return value.toLowerCase()
}

function isUncPath(path: string): boolean {
  return path.startsWith('\\\\') || path.startsWith('//')
}

/** 危险目录段(大小写不敏感)+ 危险配置文件名 + UNC。对齐 cc isDangerousFilePathToAutoEdit。 */
function isDangerousFilePathToAutoEdit(absPath: string, allowUncPath: boolean): boolean {
  if (isUncPath(absPath) && !allowUncPath) return true

  const segments = absPath.split(sep)
  for (let i = 0; i < segments.length; i++) {
    const segment = lower(segments[i] ?? '')
    for (const dir of DANGEROUS_AUTO_EDIT_DIRECTORIES) {
      if (segment !== lower(dir)) continue
      // cc 例外:.claude/worktrees/ 是 Claude 存放 git worktree 的结构性路径,不当危险目录;
      // worktree 内嵌套的其它 .claude 仍拦。
      if (dir === '.claude' && lower(segments[i + 1] ?? '') === 'worktrees') break
      return true
    }
  }

  const fileName = segments.at(-1)
  if (fileName) {
    const normalized = lower(fileName)
    if ((DANGEROUS_AUTO_EDIT_FILES as readonly string[]).some(f => lower(f) === normalized)) return true
  }
  return false
}

/**
 * Windows 路径规范化绕过特征(NTFS ADS、8.3 短名、长路径前缀、尾随点/空格、DOS 设备名、
 * 三连点路径段、UNC)。对齐 cc hasSuspiciousWindowsPathPattern。
 * 全平台检测(NTFS 可挂到 Linux/macOS);ADS 冒号仅 Windows/WSL 内核解释,故按平台门控。
 */
function hasSuspiciousPathPattern(path: string, allowUncPath: boolean): boolean {
  const isWindowsLike = process.platform === 'win32'
  if (isWindowsLike) {
    // 跳过盘符冒号(C:\),position 2 之后的冒号视为 ADS
    if (path.indexOf(':', 2) !== -1) return true
  }
  if (/~\d/.test(path)) return true
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\') || path.startsWith('//?/') || path.startsWith('//./')) return true
  if (/[.\s]+$/.test(path)) return true
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) return true
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) return true
  if (!allowUncPath && isUncPath(path)) return true
  return false
}

/** 收集 requested 的待检路径:解析后的绝对路径 + 尽力求得的 realpath(防 symlink 指向危险目标)。 */
function pathsToCheck(absPath: string): string[] {
  const out = new Set<string>([absPath])
  try {
    out.add(realpathSync(absPath))
  } catch {
    // 新建文件本身不存在,退而 realpath 其存在的父目录再拼回文件名
    try {
      out.add(join(realpathSync(dirname(absPath)), basename(absPath)))
    } catch {
      // 父目录也不存在:仅检查字面绝对路径
    }
  }
  return [...out]
}

/**
 * acceptEdits 下某个待写路径是否安全可自动放行。unsafe 时返回原因(供退回询问 + 日志/UI)。
 * allowUncPath:仅当 Windows 且目标已在工作区内时放宽 UNC(与 cc 一致)。
 */
export function checkPathSafetyForAutoEdit(absPath: string, allowUncPath = false): AutoEditSafetyResult {
  for (const candidate of pathsToCheck(absPath)) {
    if (hasSuspiciousPathPattern(candidate, allowUncPath)) {
      return {
        safe: false,
        message: `请求自动写入 ${absPath},该路径含可疑的路径规范化特征,需人工确认。`,
        classifierApprovable: false,
      }
    }
  }
  for (const candidate of pathsToCheck(absPath)) {
    if (isDangerousFilePathToAutoEdit(candidate, allowUncPath)) {
      return {
        safe: false,
        message: `请求自动编辑 ${absPath},该路径是敏感文件/目录(.git/.vscode/.idea/.claude 或 shell/git/mcp 配置),需人工确认。`,
        classifierApprovable: true,
      }
    }
  }
  return { safe: true }
}

/** 各文件类工具的目标写入路径提取(工具名→输入字段)。对齐各工具的 input 形状。 */
export function autoEditTargetPaths(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  if (toolName === 'patch_files') {
    if (!Array.isArray(record.patches)) return []
    const paths: string[] = []
    for (const item of record.patches) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const p = (item as Record<string, unknown>).path
      if (typeof p === 'string' && p.trim()) paths.push(p.trim())
    }
    return paths
  }
  const path = typeof record.path === 'string' ? record.path.trim() : ''
  if (path) return [path]
  const notebookPath = typeof record.notebook_path === 'string' ? record.notebook_path.trim() : ''
  return notebookPath ? [notebookPath] : []
}

function resolveAbs(root: string, requested: string): string {
  const cleaned = normalizeRequestedPathForValidation(requested, { operation: 'write' })
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned)
}

/**
 * acceptEdits 自动放行文件类动作前的总闸:任一目标路径不安全就返回原因(→ 退回询问)。
 * 全部安全或工具没有可识别写入路径 → 返回 null(允许自动放行)。
 */
export function autoEditSafetyReason(toolName: string, input: unknown, ctx: ToolContext): AutoEditSafetyUnsafe | null {
  const requestedPaths = autoEditTargetPaths(toolName, input)
  for (const requested of requestedPaths) {
    let abs: string
    try {
      abs = resolveAbs(ctx.workspace.root, requested)
    } catch {
      // 解析不出绝对路径:失败关闭到"问人",不静默放行
      return { safe: false, message: `无法解析写入路径 ${requested},需人工确认。`, classifierApprovable: false }
    }
    const result = checkPathSafetyForAutoEdit(abs)
    if (!result.safe) return result
  }
  return null
}
