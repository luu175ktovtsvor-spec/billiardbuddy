import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Workspace } from '../workspace/workspace'
import { MEMORY_MAIN_FILE } from './memoryNames'

// 白标铁律:运行时读用户文件夹只认 BILLIARDBUDDY.md(名字集中在 memoryNames.ts),
// 不再兼容 AGENTS.md/CLAUDE.md(暴露底层来源 + 跟用户装的 Claude Code 打架)。
export const PROJECT_INSTRUCTION_FILES = [MEMORY_MAIN_FILE] as const
export const MAX_PROJECT_INSTRUCTION_FILE_BYTES = 24_000
export const MAX_PROJECT_INSTRUCTION_TOTAL_BYTES = 36_000
const MAX_PROJECT_INSTRUCTION_BLOCKS = 16

export interface ProjectInstructionBlock {
  file: string
  content: string
  truncated: boolean
}

export interface ProjectInstructionFileSummary {
  file: string
  truncated: boolean
}

export interface ProjectInstructionSummary {
  files: ProjectInstructionFileSummary[]
  count: number
  truncated: boolean
}

export interface ProjectInstructionLoadOptions {
  targetLabel?: string
  includeWorkspaceRoot?: boolean
  maxFileBytes?: number
  maxTotalBytes?: number
}

export async function loadWorkspaceProjectInstructions(workspace: Workspace): Promise<string | null> {
  const blocks = await collectProjectInstructionBlocks(workspace, [workspace.root], {
    includeWorkspaceRoot: true,
  })
  return formatProjectInstructions(blocks)
}

export async function summarizeWorkspaceProjectInstructions(workspace: Workspace): Promise<ProjectInstructionSummary> {
  const blocks = await collectProjectInstructionBlocks(workspace, [workspace.root], {
    includeWorkspaceRoot: true,
  })
  return {
    files: blocks.map(block => ({ file: block.file, truncated: block.truncated })),
    count: blocks.length,
    truncated: blocks.some(block => block.truncated),
  }
}

export async function loadProjectInstructionsForTarget(
  workspace: Workspace,
  targetAbsPath: string,
  opts: ProjectInstructionLoadOptions = {},
): Promise<string | null> {
  const dirs = instructionDirsForTarget(workspace.root, targetAbsPath, opts.includeWorkspaceRoot ?? true)
  const blocks = await collectProjectInstructionBlocks(workspace, dirs, opts)
  return formatProjectInstructions(blocks, opts.targetLabel)
}

export async function loadProjectInstructionsForTargets(
  workspace: Workspace,
  targets: Array<{ absPath: string; label?: string }>,
  opts: ProjectInstructionLoadOptions = {},
): Promise<string | null> {
  const seenDirs = new Set<string>()
  const dirs: string[] = []
  for (const target of targets) {
    for (const dir of instructionDirsForTarget(workspace.root, target.absPath, opts.includeWorkspaceRoot ?? true)) {
      if (seenDirs.has(dir)) continue
      seenDirs.add(dir)
      dirs.push(dir)
    }
  }
  const blocks = await collectProjectInstructionBlocks(workspace, dirs, opts)
  const label = opts.targetLabel ?? targets.map(target => target.label).filter(Boolean).join(', ')
  return formatProjectInstructions(blocks, label || undefined)
}

export function isProjectInstructionPath(path: string): boolean {
  return PROJECT_INSTRUCTION_FILES.includes(basename(path) as (typeof PROJECT_INSTRUCTION_FILES)[number])
}

export function projectInstructionScopeKey(workspace: Workspace, targetAbsPath: string): string | null {
  const safeRoot = resolve(workspace.root)
  const target = resolve(targetAbsPath)
  if (!isInside(safeRoot, target)) return null
  const parent = isProjectInstructionPath(target) ? dirname(dirname(target)) : dirname(target)
  if (!isInside(safeRoot, parent)) return null
  return normalizeRelativePath(relative(safeRoot, parent) || '.')
}

async function collectProjectInstructionBlocks(
  workspace: Workspace,
  dirs: string[],
  opts: ProjectInstructionLoadOptions,
): Promise<ProjectInstructionBlock[]> {
  const maxFileBytes = clampPositive(opts.maxFileBytes, MAX_PROJECT_INSTRUCTION_FILE_BYTES)
  let remainingTotal = clampPositive(opts.maxTotalBytes, MAX_PROJECT_INSTRUCTION_TOTAL_BYTES)
  const blocks: ProjectInstructionBlock[] = []
  const seenFiles = new Set<string>()

  for (const dir of dirs) {
    for (const name of PROJECT_INSTRUCTION_FILES) {
      if (blocks.length >= MAX_PROJECT_INSTRUCTION_BLOCKS || remainingTotal <= 0) return blocks
      const abs = join(dir, name)
      if (seenFiles.has(abs) || !existsSync(abs)) continue
      seenFiles.add(abs)
      const info = await stat(abs).catch(() => null)
      if (!info?.isFile()) continue

      const limit = Math.min(maxFileBytes, remainingTotal)
      const raw = await readFile(abs).catch(() => null)
      if (!raw) continue
      const bytes = Math.min(raw.length, limit)
      const content = raw.subarray(0, bytes).toString('utf8').trim()
      remainingTotal -= bytes
      if (!content) continue
      blocks.push({
        file: normalizeRelativePath(relative(workspace.root, abs) || name),
        content,
        truncated: raw.length > bytes,
      })
    }
  }
  return blocks
}

function instructionDirsForTarget(root: string, targetAbsPath: string, includeRoot: boolean): string[] {
  const safeRoot = resolve(root)
  const target = resolve(targetAbsPath)
  if (!isInside(safeRoot, target)) return []
  const parent = isProjectInstructionPath(target) ? dirname(dirname(target)) : dirname(target)
  if (!isInside(safeRoot, parent)) return includeRoot ? [safeRoot] : []
  const rel = relative(safeRoot, parent)
  const segments = rel ? rel.split(/[\\/]+/).filter(Boolean) : []
  const dirs: string[] = includeRoot ? [safeRoot] : []
  let current = safeRoot
  for (const segment of segments) {
    current = join(current, segment)
    dirs.push(current)
  }
  return dirs
}

function formatProjectInstructions(blocks: ProjectInstructionBlock[], targetLabel?: string): string | null {
  if (!blocks.length) return null
  return [
    '# Project instructions',
    targetLabel
      ? `The following project or directory instructions apply to ${targetLabel}. Merge them from top to bottom; later files are closer to the target path and therefore more specific. Preserve each file's original language and follow the instructions according to their scope and precedence.`
      : 'The following project instructions apply to the current working directory. Preserve their original language and follow them according to their scope and precedence.',
    ...blocks.map(block => [
      `<project_instruction file="${xmlAttr(block.file)}" truncated="${block.truncated}">`,
      xmlText(block.content),
      '</project_instruction>',
    ].join('\n')),
  ].join('\n')
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function clampPositive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

export function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
