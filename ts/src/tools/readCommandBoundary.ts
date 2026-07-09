import { isAbsolute, resolve } from 'node:path'
import type { ToolContext } from './Tool'
import { resolvePathWithAdditionalWorkingDirectories } from '../permissions/filePathRules'
import { extractReadCommandPaths } from './dangerousCommand'

/**
 * 读命令(cat/ls/grep/find/head/tail/sed/diff/stat/... 见 dangerousCommand.ts 的
 * extractReadCommandPaths)若读取工作区(+ 已授权外部目录 / full-disk-access)之外的路径,需要审批——
 * 不再当纯只读命令自动放行。对齐 cc-haha src/tools/BashTool/pathValidation.ts 的
 * checkPathConstraints/validateCommandPaths:每个读命令的路径参数都要落在允许的工作目录内,否则 ask。
 *
 * 复用 resolvePathWithAdditionalWorkingDirectories——跟 read_file/read_many_files 同一套边界判定:
 * workspace.root / Workspace 自带的 allowedPaths / full-disk-access / ctx.additionalWorkingDirectories
 * 一次性全覆盖,顺带拿到既有的 UNC(win 专属,与 cc containsVulnerableUncPath 对齐——非 win 平台恒
 * false)/ ~user 波浪号变体 / `..` 穿越保护,不重复造轮子。工作区内 symlink 指向区外由该函数内部的
 * pathContainedInRoots 兜底,这里不重复处理。
 */
export function shellExternalReadNeedsApproval(command: string, cwd: string, ctx: ToolContext): boolean {
  return extractReadCommandPaths(command).some(token => readPathTokenIsOutsideWorkspace(token, cwd, ctx))
}

function readPathTokenIsOutsideWorkspace(raw: string, cwd: string, ctx: ToolContext): boolean {
  const cleaned = raw.replace(/^['"]|['"]$/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return false
  // ~ / ~user 波浪号变体、shell 展开语法交给 resolvePathWithAdditionalWorkingDirectories 内部的
  // normalizeRequestedPathForValidation 处理;只有"确定是相对路径"时才手动接到 cwd(不是 workspace.root)
  // 上——命令实际执行时的 cwd 可能是工作区子目录或已批准的外部目录,不能一律按 root 展开。
  const candidate = cleaned.startsWith('~') || isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned)
  try {
    resolvePathWithAdditionalWorkingDirectories(ctx, candidate, 'read')
    return false
  } catch {
    // 任何解析失败(越界 WorkspaceBoundaryError / UNC·波浪号变体·展开语法 PathValidationError /
    // 其它异常输入)一律保守当"需要审批"——这是安全闸,宁可多问一次也不能静默放行。
    return true
  }
}
