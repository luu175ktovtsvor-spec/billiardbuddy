import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * 路径的 symlink/realpath 解析(对齐 cc `fsOperations.ts::getPathsForPermissionCheck`),
 * 供工作区主边界与额外授权目录的越界判定共用——两处都必须解析 symlink,否则"区内 symlink 指向区外"
 * 会在纯字符串边界检查下逃逸。返回该路径的所有可能真实落点(原路径 + symlink 链 + realpath;
 * 新建文件按最深已存在祖先解析父级 symlink)。
 */

export function normalizePath(path: string): string {
  return resolve(path).replaceAll('\\', '/').replace(/\/+$/, '')
}

export function getPathsForPermissionCheck(path: string): string[] {
  const absolutePath = normalizePath(path)
  const paths = new Set<string>([absolutePath])
  if (absolutePath.startsWith('//') || absolutePath.startsWith('\\\\')) return [...paths]

  try {
    let current = absolutePath
    const visited = new Set<string>()
    for (let depth = 0; depth < 40; depth++) {
      if (visited.has(current)) break
      visited.add(current)
      if (!existsSync(current)) {
        if (current === absolutePath) {
          const resolved = resolveDeepestExistingAncestor(absolutePath)
          if (resolved) paths.add(normalizePath(resolved))
        }
        break
      }

      const stats = lstatSync(current)
      if (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) break
      if (!stats.isSymbolicLink()) break

      const target = readlinkSync(current)
      const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(current), target)
      paths.add(normalizePath(absoluteTarget))
      current = absoluteTarget
    }
  } catch {
    // Keep the original path if filesystem probing fails.
  }

  try {
    const resolved = normalizePath(realpathSync(absolutePath))
    if (resolved !== absolutePath) paths.add(resolved)
  } catch {
    // Missing files are handled by resolveDeepestExistingAncestor above.
  }

  return [...paths]
}

function resolveDeepestExistingAncestor(absolutePath: string): string | undefined {
  let dir = absolutePath
  const segments: string[] = []
  while (dir !== dirname(dir)) {
    try {
      const stats = lstatSync(dir)
      if (stats.isSymbolicLink()) {
        const target = readlinkSync(dir)
        const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(dir), target)
        return segments.length === 0 ? absoluteTarget : join(absoluteTarget, ...segments)
      }
      const resolved = realpathSync(dir)
      if (normalizePath(resolved) !== normalizePath(dir)) {
        return segments.length === 0 ? resolved : join(resolved, ...segments)
      }
      return undefined
    } catch {
      segments.unshift(basename(dir))
      dir = dirname(dir)
    }
  }
  return undefined
}

export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const normalizedPath = normalizeForComparison(path)
  const normalizedWorkingPath = normalizeForComparison(workingPath)
  const rel = relative(normalizedWorkingPath, normalizedPath)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export function normalizeForComparison(path: string): string {
  return normalizePath(path)
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
    .toLowerCase()
}

/**
 * target 的真实落点是否全部落在 root(的真实落点)之内。false = 存在通过 symlink 逃出 root 的路径。
 * 用于工作区主边界与额外授权目录判定。
 */
export function pathContainedInRoots(targetPath: string, rootPaths: string[]): boolean {
  const targetPaths = getPathsForPermissionCheck(targetPath)
  const resolvedRoots = rootPaths.flatMap(getPathsForPermissionCheck)
  return targetPaths.every(t => resolvedRoots.some(rp => pathInWorkingPath(t, rp)))
}
