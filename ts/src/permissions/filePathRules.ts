import { isAbsolute, relative, resolve } from 'node:path'
import type { ToolContext } from '../tools/Tool'
import type { FileOperation } from '../workspace/pathValidation'
import { normalizeRequestedPathForValidation } from '../workspace/pathValidation'
import { WorkspaceBoundaryError } from '../workspace/pathBoundary'

const GLOB_CHARS_RE = /[*?\[\]{}]/

export function resolveToolPath(ctx: ToolContext, toolName: string, requested: string, operation: FileOperation): string {
  try {
    return ctx.workspace.resolve(requested, operation)
  } catch (err) {
    if (!(err instanceof WorkspaceBoundaryError)) throw err
    const target = resolveRequestedPath(ctx.workspace.root, requested, operation)
    if (sessionPathRuleAllows(ctx, toolName, target, operation)) return target
    throw err
  }
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
