import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool } from './Tool'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
const DEFAULT_MAX_DEPTH = 2
const MAX_DEPTH = 5
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.agent-state',
  '.backups',
  '.agent-file-history',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'desktop/binaries',
])

export const listDirTool: Tool<{ path?: string; limit?: number; recursive?: boolean | string; max_depth?: number | string }> = {
  name: 'list_dir',
  description: `List entries of a directory inside the workspace. Input: { path?, limit?, recursive?, max_depth? } (default path = workspace root, default limit ${DEFAULT_LIMIT}). Use recursive:true with a small max_depth to inspect project structure without many tool calls.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      limit: { type: 'number', description: `Maximum entries to return, capped at ${MAX_LIMIT}.` },
      recursive: { type: ['boolean', 'string'], description: 'Set true to return a bounded recursive tree instead of only direct children.' },
      max_depth: { type: ['number', 'string'], description: `Recursive depth below path, default ${DEFAULT_MAX_DEPTH}, capped at ${MAX_DEPTH}.` },
    },
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const abs = ctx.workspace.resolve(input?.path ?? '.', 'read')
    const limit = clampLimit(input?.limit)
    if (semanticBoolean(input?.recursive)) {
      const maxDepth = clampDepth(input?.max_depth)
      const tree = await listTree(abs, { limit, maxDepth })
      return [
        ...tree.lines,
        ...(tree.omitted > 0 ? [`…[已截断:目录树超过 ${limit} 项,已省略 ${tree.omitted} 项;请传更具体 path、降低 max_depth 或提高 limit]`] : []),
      ].join('\n')
    }
    const entries = await readdir(abs, { withFileTypes: true })
    const names = entries
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
    const shown = names.slice(0, limit)
    const omitted = names.length - shown.length
    return [
      ...shown,
      ...(omitted > 0 ? [`…[已截断:目录共有 ${names.length} 项,只显示前 ${shown.length} 项;请传更具体 path 或提高 limit]`] : []),
    ]
      .join('\n')
  },
}

async function listTree(root: string, opts: { limit: number; maxDepth: number }): Promise<{ lines: string[]; omitted: number }> {
  const lines: string[] = []
  let omitted = 0

  async function visit(dir: string, prefix: string, depth: number): Promise<void> {
    if (lines.length >= opts.limit) {
      omitted++
      return
    }
    const entries = await readdir(dir, { withFileTypes: true })
    const sorted = entries
      .map(entry => ({ entry, label: entry.isDirectory() ? `${entry.name}/` : entry.name }))
      .sort((a, b) => a.label.localeCompare(b.label))
    for (const item of sorted) {
      if (lines.length >= opts.limit) {
        omitted++
        continue
      }
      const rel = `${prefix}${item.label}`
      if (item.entry.isDirectory() && shouldSkipDir(rel)) {
        lines.push(`${rel} [skipped]`)
        continue
      }
      lines.push(rel)
      if (item.entry.isDirectory() && depth < opts.maxDepth) {
        await visit(join(dir, item.entry.name), rel, depth + 1)
      }
    }
  }

  await visit(root, '', 1)
  return { lines, omitted }
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
}

function clampDepth(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_DEPTH
  return Math.max(1, Math.min(MAX_DEPTH, Math.floor(n)))
}

function semanticBoolean(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value == null) return false
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

function shouldSkipDir(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '')
  return [...SKIP_DIRS].some(segment => normalized === segment || normalized.startsWith(`${segment}/`) || normalized.includes(`/${segment}/`))
}
