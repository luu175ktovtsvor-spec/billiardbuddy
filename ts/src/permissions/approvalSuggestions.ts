import { dirname, isAbsolute, resolve } from 'node:path'
import type { ToolContext } from '../tools/Tool'
import type { ApprovalClass, PermissionUpdate } from './types'
import { canonicalPermissionMode } from './canonical'
import { additionalWorkingDirectoryAllows } from './filePathRules'
import { splitShellCommandsForPermission, stripSafeShellWrappers } from './permissionRules'
import { normalizeRequestedPathForValidation } from '../workspace/pathValidation'
import { WorkspaceBoundaryError } from '../workspace/pathBoundary'

export function transientPermissionUpdatesForApproval(toolName: string, input: unknown, ctx: ToolContext): PermissionUpdate[] {
  const directories = externalDirectoriesForInput(toolName, input, ctx)
  return directories.length > 0
    ? [{ type: 'addDirectories', destination: 'session', directories }]
    : []
}

export function rememberedPermissionUpdatesForApproval(
  toolName: string,
  input: unknown,
  ctx: ToolContext,
  approvalClass: ApprovalClass | undefined,
): PermissionUpdate[] {
  if (approvalClass !== 'file') return []

  const updates: PermissionUpdate[] = []
  if (toolName === 'run_command') {
    const command = stringField(input, 'command')
    const ruleContent = command ? shellRuleSuggestion(command) : ''
    if (ruleContent) {
      updates.push({
        type: 'addRules',
        destination: 'session',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent }],
      })
    }
  } else {
    const mode = canonicalPermissionMode(ctx.permissionMode)
    if (mode === 'default' || mode === 'plan') {
      updates.push({ type: 'setMode', destination: 'session', mode: 'acceptEdits' })
    }
  }

  const directories = externalDirectoriesForInput(toolName, input, ctx)
  if (directories.length > 0) {
    updates.push({ type: 'addDirectories', destination: 'session', directories })
  }
  return dedupePermissionUpdates(updates)
}

function externalDirectoriesForInput(toolName: string, input: unknown, ctx: ToolContext): string[] {
  const directories = new Set<string>()
  if (toolName === 'run_command') {
    const cwd = stringField(input, 'cwd')
    if (cwd) addExternalDirectory(directories, ctx, cwd, 'read', true)
    return [...directories]
  }

  for (const path of filePathsForTool(toolName, input)) {
    addExternalDirectory(directories, ctx, path, 'write', false)
  }
  return [...directories]
}

function addExternalDirectory(
  out: Set<string>,
  ctx: ToolContext,
  requested: string,
  operation: 'read' | 'write',
  directoryInput: boolean,
): void {
  const target = resolveRequestedPath(ctx, requested, operation)
  const directory = directoryInput ? target : dirname(target)
  if (!isOutsideWorkspace(ctx, directory, operation)) return
  out.add(directory)
}

function isOutsideWorkspace(ctx: ToolContext, target: string, operation: 'read' | 'write'): boolean {
  try {
    ctx.workspace.resolve(target, operation)
    return false
  } catch (err) {
    if (!(err instanceof WorkspaceBoundaryError)) return false
    return !additionalWorkingDirectoryAllows(ctx, target)
  }
}

function resolveRequestedPath(ctx: ToolContext, requested: string, operation: 'read' | 'write'): string {
  const cleaned = normalizeRequestedPathForValidation(requested, { operation })
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(ctx.workspace.root, cleaned)
}

function filePathsForTool(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const record = input as Record<string, unknown>
  if (toolName === 'patch_files') {
    if (!Array.isArray(record.patches)) return []
    const paths: string[] = []
    for (const item of record.patches) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const path = (item as Record<string, unknown>).path
      if (typeof path === 'string' && path.trim()) paths.push(path)
    }
    return paths
  }
  const path = stringField(input, 'path')
  if (path) return [path]
  const notebookPath = stringField(input, 'notebook_path')
  return notebookPath ? [notebookPath] : []
}

function stringField(input: unknown, key: string): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

// cc bashPermissions.ts BARE_SHELL_PREFIXES:解释器 / exec 包装器 / 提权前缀。
// 这些命令首 token 若被拿去生成 `xxx:*` 会话放行规则,等价于近乎无限的任意代码执行放行
// (如 `bash -c:*`、`sudo rm:*`、`env FOO=x:*`),因此这类命令不生成任何"本会话允许"规则。
const BARE_SHELL_PREFIXES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'cmd', 'powershell', 'pwsh',
  'env', 'xargs', 'nice', 'stdbuf', 'nohup', 'timeout', 'time',
  'sudo', 'doas', 'pkexec',
])

function shellRuleSuggestion(command: string): string {
  const normalized = command.trim()
  if (!normalized) return ''
  const parts = splitShellCommandsForPermission(normalized)
  if (parts.length !== 1) return normalized
  const stripped = stripSafeShellWrappers(parts[0] ?? normalized).trim()
  if (!stripped || stripped.includes('\n') || stripped.includes('<<')) return stripped || normalized
  const tokens = stripped.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return stripped
  if (!/^[A-Za-z0-9_.:/+-]+$/.test(tokens[0]!)) return stripped
  // 危险前缀:不生成会话放行规则(返回空 → 调用方 rememberedPermissionUpdatesForApproval 跳过 addRules)。
  if (BARE_SHELL_PREFIXES.has(tokens[0]!.toLowerCase())) return ''
  const prefix = tokens.slice(0, Math.min(2, tokens.length)).join(' ')
  return prefix ? `${prefix}:*` : stripped
}

function dedupePermissionUpdates(updates: PermissionUpdate[]): PermissionUpdate[] {
  const seen = new Set<string>()
  const out: PermissionUpdate[] = []
  for (const update of updates) {
    const key = JSON.stringify(update)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(update)
  }
  return out
}
