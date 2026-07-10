import { isAbsolute, relative, resolve } from 'node:path'
import type { ToolContext } from '../tools/Tool'
import type { FileOperation } from '../workspace/pathValidation'
import { normalizeRequestedPathForValidation } from '../workspace/pathValidation'
import { WorkspaceBoundaryError } from '../workspace/pathBoundary'
import { getPathsForPermissionCheck, normalizePath, pathInWorkingPath } from '../workspace/symlinkResolve'
import type { PermissionRule } from './types'

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

/**
 * app 层已授权的工作区外目录(ctx.additionalWorkingDirectories,/add-dir 等价物)的裸路径列表,
 * 供 run_command/run_command_background 把它们并进 OS 沙箱 allowWrite(否则 shell 命令写这些目录
 * 仍会被默认开的 OS 沙箱拦下,即使 file 工具在 app 层已经放行——对齐 cc sandbox-adapter.ts 的处理)。
 */
export function additionalWorkingDirectoryPaths(ctx: ToolContext): string[] {
  return [...(ctx.additionalWorkingDirectories?.values() ?? [])].map(directory => directory.path)
}

export function sessionPathRuleAllows(ctx: ToolContext, toolName: string, absPath: string, operation: FileOperation): boolean {
  const rules = [
    ...(ctx.sessionAllowedToolRules ?? [])
      .filter(rule => rule.tool === toolName && rule.ruleContent.trim())
      .map(rule => rule.ruleContent.trim()),
    ...(ctx.permissionRules ?? [])
      .filter(rule => rule.ruleBehavior === 'allow' && pathRuleMatchesTool(rule, toolName) && rule.ruleValue.ruleContent?.trim())
      .map(rule => rule.ruleValue.ruleContent!.trim()),
  ]
  if (rules.length === 0) return false
  return rules.some(rule => pathMatchesRule(ctx.workspace.root, absPath, rule, operation))
}

function pathRuleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  const aliases = PATH_RULE_TOOL_ALIASES[rule.ruleValue.toolName] ?? [rule.ruleValue.toolName]
  return rule.ruleValue.toolName === '*' || aliases.includes(toolName)
}

const PATH_RULE_TOOL_ALIASES: Record<string, string[]> = {
  Edit: ['edit_file', 'edit_excel', 'patch_file', 'patch_files'],
  MultiEdit: ['multi_edit_file'],
  NotebookEdit: ['NotebookEdit'],
  Read: ['read_file', 'read_many_files'],
  Write: ['write_file'],
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
