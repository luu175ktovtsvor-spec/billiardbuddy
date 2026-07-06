import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { Tool } from './Tool'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_GREP_FILES = 5000
const MAX_GREP_FILE_BYTES = 1024 * 1024
const SKIP_SEGMENTS = new Set([
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

export const globFilesTool: Tool<{ pattern: string; path?: string; limit?: number }> = {
  name: 'glob_files',
  description: 'Find files by glob pattern inside the workspace. Input: { pattern, path?, limit? }. Use this before reading many files.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob such as "**/*.ts" or "src/**/*.tsx". Absolute paths and ../ are rejected.' },
      path: { type: 'string', description: 'Optional directory to search from. Defaults to workspace root.' },
      limit: { type: 'number', description: `Maximum results, capped at ${MAX_LIMIT}.` },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const pattern = normalizePattern(input?.pattern)
    const base = ctx.workspace.resolve(input?.path ?? '.', 'read')
    const root = ctx.workspace.root
    const limit = clampLimit(input?.limit)
    const matches = await scanGlob(base, pattern, limit)
    if (matches.length === 0) return '未找到匹配文件'
    return matches.map(file => relative(root, file) || '.').join('\n')
  },
}

export const grepFilesTool: Tool<{
  pattern: string
  path?: string
  include?: string
  case_sensitive?: boolean
  context?: number
  limit?: number
}> = {
  name: 'grep_files',
  description: 'Search text inside workspace files with a regex pattern. Input: { pattern, path?, include?, case_sensitive?, context?, limit? }.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex source. Invalid regex is treated as literal text.' },
      path: { type: 'string', description: 'Optional directory to search from. Defaults to workspace root.' },
      include: { type: 'string', description: 'Optional file glob, default "**/*". Example: "**/*.{ts,tsx}".' },
      case_sensitive: { type: 'boolean' },
      context: { type: 'number', description: 'Context lines before/after each match, capped at 3.' },
      limit: { type: 'number', description: `Maximum matches, capped at ${MAX_LIMIT}.` },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  async execute(input, ctx) {
    if (!input || typeof input.pattern !== 'string' || !input.pattern.trim()) {
      throw new Error('grep_files 需要 string 参数 pattern')
    }
    const include = normalizePattern(input.include || '**/*')
    const base = ctx.workspace.resolve(input.path ?? '.', 'read')
    const root = ctx.workspace.root
    const regex = compileSearchRegex(input.pattern, input.case_sensitive === true)
    const limit = clampLimit(input.limit)
    const context = Math.max(0, Math.min(3, Math.floor(input.context ?? 0)))
    const files = await scanGlob(base, include, MAX_GREP_FILES)
    const out: string[] = []

    for (const file of files) {
      if (out.length >= limit) break
      if (isSensitiveRelativePath(relative(base, file))) continue
      const info = await stat(file).catch(() => null)
      if (!info?.isFile() || info.size > MAX_GREP_FILE_BYTES) continue
      const text = await readFile(file, 'utf8').catch(() => '')
      if (!text || looksBinary(text)) continue
      const lines = text.split(/\r?\n/)
      const matched = new Set<number>()
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        regex.lastIndex = 0
        if (!regex.test(lines[i]!)) continue
        for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
          const prefix = j === i ? ':' : '-'
          const key = j + 1
          if (matched.has(key)) continue
          matched.add(key)
          out.push(`${relative(root, file)}${prefix}${j + 1}:${lines[j]}`)
          if (out.length >= limit) break
        }
      }
    }

    if (out.length === 0) return '未找到匹配内容'
    return out.join('\n')
  },
}

async function scanGlob(base: string, pattern: string, limit: number): Promise<string[]> {
  const glob = new Bun.Glob(pattern)
  const matches: string[] = []
  for await (const entry of glob.scan({ cwd: base, onlyFiles: true, dot: true, absolute: true })) {
    const rel = relative(base, entry)
    if (shouldSkipRelativePath(rel)) continue
    matches.push(entry)
    if (matches.length >= limit) break
  }
  return matches.sort()
}

function normalizePattern(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('glob pattern required')
  const pattern = value.trim()
  if (pattern.includes('\0') || isAbsolute(pattern) || /^[A-Za-z]:[\\/]/.test(pattern)) throw new Error('glob pattern 不能是绝对路径')
  if (pattern.split(/[\\/]+/).includes('..')) throw new Error('glob pattern 不能包含 ..')
  return pattern
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.floor(n))
}

function shouldSkipRelativePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  if (isSensitiveRelativePath(normalized)) return true
  return [...SKIP_SEGMENTS].some(segment => normalized === segment || normalized.startsWith(`${segment}/`) || normalized.includes(`/${segment}/`))
}

function isSensitiveRelativePath(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (name === '.env' || name.startsWith('.env.')) return true
  if (/\.(pem|key|p12|pfx|crt|cer)$/i.test(name)) return true
  return /(secret|credential|token|password|api[_-]?key)/i.test(name)
}

function compileSearchRegex(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? 'g' : 'gi')
  } catch {
    return new RegExp(escapeRegExp(pattern), caseSensitive ? 'g' : 'gi')
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function looksBinary(value: string): boolean {
  return value.includes('\0')
}
