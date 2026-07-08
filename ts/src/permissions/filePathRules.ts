import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolContext } from '../tools/Tool'
import type { FileOperation } from '../workspace/pathValidation'
import { normalizeRequestedPathForValidation } from '../workspace/pathValidation'
import { WorkspaceBoundaryError } from '../workspace/pathBoundary'

const GLOB_CHARS_RE = /[*?\[\]{}]/

export function resolveToolPath(ctx: ToolContext, toolName: string, requested: string, operation: FileOperation): string {
  try {
    return resolvePathWithAdditionalWorkingDirectories(ctx, requested, operation)
  } catch (err) {
    if (!(err instanceof WorkspaceBoundaryError)) throw err
    const target = resolveRequestedPath(ctx.workspace.root, requested, operation)
    if (sessionPathRuleAllows(ctx, toolName, target, operation)) return target
    throw err
  }
}

export function resolvePathWithAdditionalWorkingDirectories(ctx: ToolContext, requested: string, operation: FileOperation): string {
  try {
    return ctx.workspace.resolve(requested, operation)
  } catch (err) {
    if (!(err instanceof WorkspaceBoundaryError)) throw err
    const target = resolveRequestedPath(ctx.workspace.root, requested, operation)
    if (additionalWorkingDirectoryAllows(ctx, target)) return target
    throw err
  }
}

export function additionalWorkingDirectoryAllows(ctx: ToolContext, absPath: string): boolean {
  const directories = [...(ctx.additionalWorkingDirectories?.values() ?? [])]
  if (directories.length === 0) return false
  const targetPaths = getPathsForPermissionCheck(absPath)
  const workingPaths = directories.flatMap(directory => getPathsForPermissionCheck(directory.path))
  return targetPaths.every(target =>
    workingPaths.some(workingPath => pathInWorkingPath(target, workingPath)),
  )
}

export function sessionPathRuleAllows(ctx: ToolContext, toolName: string, absPath: string, operation: FileOperation): boolean {
  const rules = (ctx.sessionAllowedToolRules ?? [])
    .filter(rule => rule.tool === toolName && rule.ruleContent.trim())
    .map(rule => rule.ruleContent.trim())
  if (rules.length === 0) return false
  return rules.some(rule => pathMatchesRule(ctx.workspace.root, absPath, rule, operation))
}

function resolveRequestedPath(root: string, requested: string, operation: FileOperation): string {
  const cleaned = normalizeRequestedPathForValidation(requested, { operation })
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned)
}

function pathMatchesRule(root: string, absPath: string, ruleContent: string, operation: FileOperation): boolean {
  const cleanedRule = ruleContent.replace(/^['"]|['"]$/g, '')
  if (!cleanedRule || cleanedRule === '*') return true
  const rulePath = resolveRulePath(root, cleanedRule, operation)
  const normalizedTarget = normalizePath(absPath)
  if (!GLOB_CHARS_RE.test(rulePath)) return normalizedTarget === normalizePath(rulePath)
  return globToRegex(normalizePath(rulePath)).test(normalizedTarget)
}

function resolveRulePath(root: string, ruleContent: string, operation: FileOperation): string {
  const validationTarget = stripGlobSuffix(ruleContent)
  const normalizedBase = normalizeRequestedPathForValidation(validationTarget || '.', { operation: operation === 'read' ? 'read' : 'write' })
  const resolvedBase = isAbsolute(normalizedBase) ? resolve(normalizedBase) : resolve(root, normalizedBase)
  if (validationTarget === ruleContent) return resolvedBase
  const suffix = validationTarget === '.' && !ruleContent.startsWith('.')
    ? `/${ruleContent}`
    : ruleContent.slice(validationTarget.length)
  return `${resolvedBase}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

function stripGlobSuffix(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/')
  const firstGlob = normalized.search(GLOB_CHARS_RE)
  if (firstGlob === -1) return pattern
  const slash = normalized.lastIndexOf('/', firstGlob)
  return slash === -1 ? '.' : normalized.slice(0, slash)
}

function normalizePath(path: string): string {
  return resolve(path).replaceAll('\\', '/').replace(/\/+$/, '')
}

function getPathsForPermissionCheck(path: string): string[] {
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

function pathInWorkingPath(path: string, workingPath: string): boolean {
  const normalizedPath = normalizeForComparison(path)
  const normalizedWorkingPath = normalizeForComparison(workingPath)
  const rel = relative(normalizedWorkingPath, normalizedPath)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function normalizeForComparison(path: string): string {
  return normalizePath(path)
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
    .toLowerCase()
}

function globToRegex(pattern: string): RegExp {
  if (pattern.endsWith('/**')) {
    const base = escapeRegex(pattern.slice(0, -3).replace(/\/+$/, ''))
    return new RegExp(`^${base}(?:/.*)?$`)
  }
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += escapeRegex(char)
  }
  return new RegExp(`${out}$`)
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

export function relativeToWorkspace(root: string, absPath: string): string {
  const rel = relative(root, absPath)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absPath
}
