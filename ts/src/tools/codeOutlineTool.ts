import { open, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { Tool } from './Tool'

const MAX_FILES = 20
const DEFAULT_MAX_SYMBOLS = 120
const MAX_SYMBOLS = 300
const MAX_FILE_BYTES = 400_000
const MAX_IMPORTS = 60
const MAX_LINE_CHARS = 220
const DEFAULT_RANGE_CONTEXT = 20
const MAX_RANGE_CONTEXT = 120

export interface CodeOutlineInput {
  path?: string
  paths?: string[]
  max_symbols_per_file?: number
  include_imports?: boolean | string
  ranges?: boolean | string
  range_context?: number | string
}

interface SymbolLine {
  line: number
  kind: string
  name: string
  exported?: boolean
  signature: string
}

export const codeOutlineTool: Tool<CodeOutlineInput> = {
  name: 'code_outline',
  description:
    `Summarize imports and major symbols for one or more code files without dumping full contents. Input: { path? OR paths?, max_symbols_per_file?, include_imports?, ranges?, range_context? }. Use before read_file/read_many_files on large code files; set ranges:true to emit read_many_files-ready symbol windows. Capped at ${MAX_FILES} files.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Single workspace-relative code file path.' },
      paths: { type: 'array', items: { type: 'string' }, description: `Workspace-relative code file paths, capped at ${MAX_FILES}.` },
      max_symbols_per_file: { type: 'number', description: `Maximum symbols per file, capped at ${MAX_SYMBOLS}.` },
      include_imports: { type: ['boolean', 'string'], description: 'Whether to include import/use/from/require lines. Defaults to true.' },
      ranges: { type: ['boolean', 'string'], description: 'Set true to include read_many_files({ranges}) JSON for the shown symbols.' },
      range_context: { type: ['number', 'string'], description: `When ranges:true, lines before/after each symbol to include, default ${DEFAULT_RANGE_CONTEXT}, capped at ${MAX_RANGE_CONTEXT}.` },
    },
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const rawPaths = normalizePaths(input)
    const paths = rawPaths.slice(0, MAX_FILES)
    const maxSymbols = clampNumber(input?.max_symbols_per_file, DEFAULT_MAX_SYMBOLS, MAX_SYMBOLS)
    const includeImports = input?.include_imports === undefined ? true : truthy(input.include_imports)
    const rangeMode = truthy(input?.ranges)
    const rangeContext = clampNumber(input?.range_context, DEFAULT_RANGE_CONTEXT, MAX_RANGE_CONTEXT)
    const root = ctx.workspace.root
    const blocks: string[] = []
    const allRanges: SymbolRange[] = []

    for (const path of paths) {
      try {
        const abs = ctx.workspace.resolve(path, 'read')
        const info = await stat(abs)
        if (!info.isFile()) {
          blocks.push(`<file path="${xmlAttr(path)}" error="not_a_file" />`)
          continue
        }
        const { text, bytes } = await readUtf8Prefix(abs, Math.min(MAX_FILE_BYTES, info.size))
        const rel = relative(root, abs) || path
        const outline = formatOutline({
          path: rel,
          size: info.size,
          bytes,
          truncated: bytes < info.size,
          text,
          maxSymbols,
          includeImports,
          rangeMode,
          rangeContext,
        })
        blocks.push(outline.block)
        allRanges.push(...outline.ranges)
      } catch (err) {
        blocks.push(`<file path="${xmlAttr(path)}" error="${xmlAttr(err instanceof Error ? err.message : String(err))}" />`)
      }
    }

    return [
      `<code_outline files="${paths.length}"${rawPaths.length > paths.length ? ` omitted="${rawPaths.length - paths.length}"` : ''}${rangeMode ? ` range_context="${rangeContext}"` : ''}>`,
      blocks.join('\n'),
      ...(rangeMode && allRanges.length > 0 ? [formatReadManyFilesInput(allRanges)] : []),
      '</code_outline>',
    ].join('\n')
  },
}

function normalizePaths(input: CodeOutlineInput | undefined): string[] {
  const values = Array.isArray(input?.paths) ? input.paths : typeof input?.path === 'string' ? [input.path] : []
  const paths = values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
  if (!paths.length) throw new Error('code_outline 需要 path 或 paths')
  return paths
}

async function readUtf8Prefix(path: string, limit: number): Promise<{ text: string; bytes: number }> {
  if (limit <= 0) return { text: '', bytes: 0 }
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead }
  } finally {
    await handle.close()
  }
}

function formatOutline(opts: {
  path: string
  size: number
  bytes: number
  truncated: boolean
  text: string
  maxSymbols: number
  includeImports: boolean
  rangeMode: boolean
  rangeContext: number
}): { block: string; ranges: SymbolRange[] } {
  const lines = opts.text.split(/\r?\n/)
  const allImports = opts.includeImports ? extractImports(lines) : []
  const imports = allImports.slice(0, MAX_IMPORTS)
  const symbols = extractSymbols(lines)
  const shownSymbols = symbols.slice(0, opts.maxSymbols)
  const ranges = opts.rangeMode
    ? mergeRanges(shownSymbols.map(symbol => ({
      path: opts.path,
      start_line: Math.max(1, symbol.line - opts.rangeContext),
      end_line: Math.min(lines.length, symbol.line + opts.rangeContext),
      symbol: symbol.name,
      line: symbol.line,
    })))
    : []
  const block = [
    `<file path="${xmlAttr(opts.path)}" size="${opts.size}" read_bytes="${opts.bytes}" lines="${lines.length}"${opts.truncated ? ' truncated="true"' : ''}>`,
    opts.includeImports
      ? `<imports count="${imports.length}"${allImports.length > imports.length ? ' truncated="true"' : ''}>\n${imports.map(formatImportLine).join('\n')}\n</imports>`
      : '<imports skipped="true" />',
    `<symbols count="${shownSymbols.length}"${symbols.length > shownSymbols.length ? ' truncated="true"' : ''}>\n${shownSymbols.map(formatSymbolLine).join('\n')}\n</symbols>`,
    '</file>',
  ].join('\n')
  return { block, ranges }
}

function extractImports(lines: string[]): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (
      /^(import|export)\s+.+\s+from\s+['"]/.test(trimmed) ||
      /^import\s+['"]/.test(trimmed) ||
      /^const\s+.+\s*=\s*require\(/.test(trimmed) ||
      /^from\s+[\w.]+\s+import\s+/.test(trimmed) ||
      /^import\s+[\w.,*{}\s]+$/.test(trimmed) ||
      /^use\s+[\w:]+/.test(trimmed)
    ) {
      out.push({ line: i + 1, text: capLine(trimmed) })
    }
  }
  return out
}

function extractSymbols(lines: string[]): SymbolLine[] {
  const out: SymbolLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = stripLineComment(raw)
    const trimmed = line.trim()
    if (!trimmed) continue

    const py = raw.match(/^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)[\w\s,().]*:/)
    if (py) {
      const indent = py[1]!.length
      out.push({ line: i + 1, kind: indent > 0 ? `py-${py[2]}-nested` : `py-${py[2]}`, name: py[3]!, signature: capLine(trimmed) })
      continue
    }
    const tsDecl = trimmed.match(/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/)
    if (tsDecl) {
      out.push({ line: i + 1, kind: tsDecl[4]!, name: tsDecl[5]!, exported: !!tsDecl[1], signature: capLine(trimmed) })
      continue
    }
    const tsVar = trimmed.match(/^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=|\()/)
    if (tsVar) {
      out.push({ line: i + 1, kind: 'var', name: tsVar[2]!, exported: !!tsVar[1], signature: capLine(trimmed) })
      continue
    }
    const rustGo = trimmed.match(/^(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|func|type)\s+([A-Za-z_]\w*)/)
    if (rustGo) {
      out.push({ line: i + 1, kind: rustGo[3]!, name: rustGo[4]!, exported: !!rustGo[1], signature: capLine(trimmed) })
      continue
    }
    const method = raw.match(/^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/)
    if (method && !isControlWord(method[1]!)) {
      out.push({ line: i + 1, kind: 'method', name: method[1]!, signature: capLine(trimmed) })
    }
  }
  return out
}

function formatImportLine(item: { line: number; text: string }): string {
  return `${item.line}: ${xmlText(item.text)}`
}

function formatSymbolLine(symbol: SymbolLine): string {
  return `${symbol.line}:${symbol.kind}:${xmlText(symbol.name)}${symbol.exported ? ':export' : ''} ${xmlText(symbol.signature)}`
}

interface SymbolRange {
  path: string
  start_line: number
  end_line: number
  symbol: string
  line: number
}

function formatReadManyFilesInput(ranges: SymbolRange[]): string {
  const readInput = {
    ranges: ranges.map(({ path, start_line, end_line }) => ({ path, start_line, end_line })),
  }
  return [
    '<read_many_files_input>',
    JSON.stringify(readInput, null, 2),
    '</read_many_files_input>',
    '<symbol_lines>',
    ...ranges.map(range => `${range.path}:${range.line}:${xmlText(range.symbol)}`),
    '</symbol_lines>',
  ].join('\n')
}

function mergeRanges(ranges: SymbolRange[]): SymbolRange[] {
  const sorted = [...ranges].sort((a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line || a.end_line - b.end_line)
  const merged: SymbolRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && last.path === range.path && range.start_line <= last.end_line + 1) {
      last.end_line = Math.max(last.end_line, range.end_line)
      last.symbol = `${last.symbol},${range.symbol}`
      last.line = Math.min(last.line, range.line)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

function stripLineComment(line: string): string {
  const idx = line.indexOf('//')
  return idx >= 0 ? line.slice(0, idx) : line
}

function isControlWord(value: string): boolean {
  return ['if', 'for', 'while', 'switch', 'catch', 'function'].includes(value)
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

function truthy(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value == null) return false
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
