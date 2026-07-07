import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { Tool, ToolContext } from './Tool'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_GREP_FILES = 5000
const MAX_GREP_FILE_BYTES = 1024 * 1024
const MAX_GREP_LINE_CHARS = 2000
const GREP_CONCURRENCY = 16
const DEFAULT_RANGE_CONTEXT = 20
const MAX_RANGE_CONTEXT = 80
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
    const scan = await scanGlob(base, pattern, limit)
    const matches = scan.files
    if (matches.length === 0) return '未找到匹配文件'
    return [
      ...matches.map(file => relative(root, file) || '.'),
      ...(scan.truncated ? [`…[已截断:匹配文件超过 ${limit} 个,请缩小 pattern/path 或提高 limit]`] : []),
    ].join('\n')
  },
}

export const grepFilesTool: Tool<{
  pattern: string
  path?: string | string[]
  paths?: string[]
  include?: string
  case_sensitive?: boolean
  literal?: boolean | string
  files_only?: boolean | string
  ranges?: boolean | string
  context?: number
  range_context?: number | string
  limit?: number
}> = {
  name: 'grep_files',
  description: 'Search text inside workspace files with a regex pattern or literal text. Input: { pattern, path?, paths?, include?, case_sensitive?, literal?, files_only?, ranges?, context?, range_context?, limit? }. path/paths may point to files or directories. Use files_only:true to first identify affected files with low context cost; use ranges:true to return read_many_files-ready line ranges.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex source by default. Set literal:true to search exact text; invalid regex also falls back to literal text.' },
      path: { type: ['string', 'array'], items: { type: 'string' }, description: 'Optional workspace-relative file/directory or list of files/directories to search from. Defaults to workspace root.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional workspace-relative files/directories to search from. Merged with path when both are provided.' },
      include: { type: 'string', description: 'Optional file glob, default "**/*". Example: "**/*.{ts,tsx}".' },
      case_sensitive: { type: 'boolean' },
      literal: { type: ['boolean', 'string'], description: 'Set true to treat pattern as plain text instead of regex.' },
      files_only: { type: ['boolean', 'string'], description: 'Set true to return only matching file paths, one per file, instead of matching lines.' },
      ranges: { type: ['boolean', 'string'], description: 'Set true to return JSON ranges that can be passed to read_many_files({ranges}) for focused code windows.' },
      context: { type: 'number', description: 'Context lines before/after each match, capped at 3.' },
      range_context: { type: ['number', 'string'], description: `When ranges:true, lines before/after each match to include, default ${DEFAULT_RANGE_CONTEXT}, capped at ${MAX_RANGE_CONTEXT}.` },
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
    const root = ctx.workspace.root
    const literal = semanticBoolean(input.literal)
    const rangeMode = semanticBoolean(input.ranges)
    const filesOnly = !rangeMode && semanticBoolean(input.files_only)
    const limit = clampLimit(input.limit)
    const context = Math.max(0, Math.min(3, Math.floor(input.context ?? 0)))
    const rangeContext = clampRangeContext(input.range_context)
    const scan = await resolveGrepScope(ctx, input.path, input.paths, include, MAX_GREP_FILES)
    const files = scan.files
    const out: string[] = []
    const rangeHits: GrepRange[] = []

    for (let start = 0; start < files.length && resultCount(out, rangeHits, rangeMode) < limit; start += GREP_CONCURRENCY) {
      const batch = files.slice(start, start + GREP_CONCURRENCY)
      const batchResults = await Promise.all(batch.map(file => grepOneFile(file, {
        root,
        pattern: input.pattern,
        caseSensitive: input.case_sensitive === true,
        literal,
        context: filesOnly ? 0 : context,
        ranges: rangeMode,
        rangeContext,
        limit: filesOnly ? 1 : limit,
      })))
      for (const result of batchResults) {
        if (rangeMode) {
          for (const range of result.ranges) {
            if (rangeHits.length >= limit) break
            rangeHits.push(range)
          }
        } else {
          const lines = filesOnly && result.lines.length > 0 ? [relative(root, result.file) || '.'] : result.lines
          for (const line of lines) {
            if (out.length >= limit) break
            out.push(line)
          }
        }
        if (resultCount(out, rangeHits, rangeMode) >= limit) break
      }
    }

    if (rangeMode) {
      if (rangeHits.length === 0) return '未找到匹配内容'
      return formatRangesOutput(rangeHits, {
        limit,
        rangeContext,
        matchLimitHit: rangeHits.length >= limit,
        scanTruncated: scan.truncated,
      })
    }
    if (out.length === 0) return '未找到匹配内容'
    return [
      ...out,
      ...(out.length >= limit ? [`…[已截断:匹配${filesOnly ? '文件' : '行'}达到 limit=${limit};请缩小 pattern/path/include]`] : []),
      ...(scan.truncated ? [`…[文件扫描已达上限 ${MAX_GREP_FILES},结果可能不完整;请传更具体 path/include]`] : []),
    ].join('\n')
  },
}

async function scanGlob(base: string, pattern: string, limit: number): Promise<{ files: string[]; truncated: boolean }> {
  const glob = new Bun.Glob(pattern)
  const matches: string[] = []
  let truncated = false
  for await (const entry of glob.scan({ cwd: base, onlyFiles: true, dot: true, absolute: true })) {
    const rel = relative(base, entry)
    if (shouldSkipRelativePath(rel)) continue
    if (matches.length >= limit) {
      truncated = true
      break
    }
    matches.push(entry)
  }
  return { files: matches.sort(), truncated }
}

async function resolveGrepScope(
  ctx: ToolContext,
  pathInput: unknown,
  pathsInput: unknown,
  include: string,
  limit: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const scopes = normalizeScopeInputs(pathInput, pathsInput)
  const requestedScopes = scopes.length ? scopes : ['.']
  const seen = new Set<string>()
  const files: string[] = []
  let truncated = false

  for (const scope of requestedScopes) {
    if (files.length >= limit) {
      truncated = true
      break
    }
    const abs = ctx.workspace.resolve(scope, 'read')
    const info = await stat(abs).catch(() => null)
    if (!info) continue
    if (info.isFile()) {
      const rel = relative(ctx.workspace.root, abs)
      if (!shouldSkipRelativePath(rel) && !seen.has(abs)) {
        seen.add(abs)
        files.push(abs)
      }
      continue
    }
    if (!info.isDirectory()) continue
    const remaining = Math.max(0, limit - files.length)
    const scan = await scanGlob(abs, include, remaining)
    if (scan.truncated) truncated = true
    for (const file of scan.files) {
      if (files.length >= limit) {
        truncated = true
        break
      }
      if (seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
  }
  return { files: files.sort(), truncated }
}

function normalizeScopeInputs(pathInput: unknown, pathsInput: unknown): string[] {
  const items = [
    ...(Array.isArray(pathInput) ? pathInput : typeof pathInput === 'string' ? [pathInput] : []),
    ...(Array.isArray(pathsInput) ? pathsInput : []),
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

async function grepOneFile(
  file: string,
  opts: { root: string; pattern: string; caseSensitive: boolean; literal: boolean; context: number; ranges: boolean; rangeContext: number; limit: number },
): Promise<{ file: string; lines: string[]; ranges: GrepRange[] }> {
  if (isSensitiveRelativePath(relative(opts.root, file))) return { file, lines: [], ranges: [] }
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size > MAX_GREP_FILE_BYTES) return { file, lines: [], ranges: [] }
  const text = await readFile(file, 'utf8').catch(() => '')
  if (!text || looksBinary(text)) return { file, lines: [], ranges: [] }
  const regex = compileSearchRegex(opts.pattern, opts.caseSensitive, opts.literal)
  const lines = text.split(/\r?\n/)
  const matched = new Set<number>()
  const out: string[] = []
  const ranges: GrepRange[] = []
  for (let i = 0; i < lines.length && (opts.ranges ? ranges.length : out.length) < opts.limit; i++) {
    regex.lastIndex = 0
    if (!regex.test(lines[i]!)) continue
    if (opts.ranges) {
      const matchedLine = i + 1
      ranges.push({
        path: relative(opts.root, file) || '.',
        start_line: Math.max(1, matchedLine - opts.rangeContext),
        end_line: Math.min(lines.length, matchedLine + opts.rangeContext),
        matched_lines: [matchedLine],
      })
      continue
    }
    for (let j = Math.max(0, i - opts.context); j <= Math.min(lines.length - 1, i + opts.context); j++) {
      const prefix = j === i ? ':' : '-'
      const key = j + 1
      if (matched.has(key)) continue
      matched.add(key)
      out.push(`${relative(opts.root, file)}${prefix}${j + 1}:${capLine(lines[j]!)}`)
      if (out.length >= opts.limit) break
    }
  }
  return { file, lines: out, ranges }
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

function clampRangeContext(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RANGE_CONTEXT
  return Math.max(0, Math.min(MAX_RANGE_CONTEXT, Math.floor(n)))
}

interface GrepRange {
  path: string
  start_line: number
  end_line: number
  matched_lines: number[]
}

function resultCount(out: string[], ranges: GrepRange[], rangeMode: boolean): number {
  return rangeMode ? ranges.length : out.length
}

function formatRangesOutput(
  ranges: GrepRange[],
  opts: { limit: number; rangeContext: number; matchLimitHit: boolean; scanTruncated: boolean },
): string {
  const merged = mergeRanges(ranges)
  const readInput = {
    ranges: merged.map(({ path, start_line, end_line }) => ({ path, start_line, end_line })),
  }
  return [
    `<grep_ranges matches="${ranges.length}" ranges="${merged.length}" range_context="${opts.rangeContext}">`,
    '<read_many_files_input>',
    JSON.stringify(readInput, null, 2),
    '</read_many_files_input>',
    '<matched_lines>',
    ...ranges.map(range => `${range.path}:${range.matched_lines.join(',')}`),
    '</matched_lines>',
    ...(opts.matchLimitHit ? [`…[已截断:匹配行达到 limit=${opts.limit};请缩小 pattern/path/include]`] : []),
    ...(opts.scanTruncated ? [`…[文件扫描已达上限 ${MAX_GREP_FILES},结果可能不完整;请传更具体 path/include]`] : []),
    '</grep_ranges>',
  ].join('\n')
}

function mergeRanges(ranges: GrepRange[]): GrepRange[] {
  const sorted = [...ranges].sort((a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line || a.end_line - b.end_line)
  const merged: GrepRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && last.path === range.path && range.start_line <= last.end_line + 1) {
      last.end_line = Math.max(last.end_line, range.end_line)
      last.matched_lines.push(...range.matched_lines)
      continue
    }
    merged.push({ ...range, matched_lines: [...range.matched_lines] })
  }
  return merged
}

function semanticBoolean(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value == null) return false
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
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

function compileSearchRegex(pattern: string, caseSensitive: boolean, literal = false): RegExp {
  if (literal) return new RegExp(escapeRegExp(pattern), caseSensitive ? 'g' : 'gi')
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

function capLine(line: string): string {
  if (line.length <= MAX_GREP_LINE_CHARS) return line
  return `${line.slice(0, MAX_GREP_LINE_CHARS)}…[本行过长,已截断 ${line.length - MAX_GREP_LINE_CHARS} 字符]`
}
