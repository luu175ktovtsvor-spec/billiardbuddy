import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import type { Tool, ToolContext } from './Tool'

type LspOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls'

interface LspInput {
  operation?: LspOperation
  filePath?: string
  path?: string
  line?: number | string
  character?: number | string
  query?: string
  max_results?: number | string
}

interface SymbolEntry {
  path: string
  line: number
  character: number
  kind: string
  name: string
  signature: string
  container?: string
  exported?: boolean
}

interface ReferenceEntry {
  path: string
  line: number
  character: number
  text: string
}

const LSP_TOOL_NAME = 'LSP'
const MAX_FILE_SIZE_BYTES = 10_000_000
const MAX_READ_BYTES = 700_000
const MAX_WORKSPACE_FILES = 220
const DEFAULT_MAX_RESULTS = 80
const MAX_RESULTS = 300
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
  '.swift', '.kt', '.kts', '.rb', '.php', '.vue', '.svelte',
])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.venv', 'venv', '__pycache__'])
const IDENT_RE = /[A-Za-z_$][\w$]*|[\w$'!]+|[+\-*/%&|^~<>=]+/g

export const lspTool: Tool<LspInput> = {
  name: LSP_TOOL_NAME,
  description: [
    'Interact with code intelligence features using the CC-Haha LSP tool protocol.',
    'Supported operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls.',
    'Input uses 1-based editor positions: { operation, filePath, line, character, query?, max_results? }.',
    'This build uses a local symbol fallback when no language-server manager is available.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls'],
        description: 'The LSP operation to perform.',
      },
      filePath: { type: 'string', description: 'Absolute or workspace-relative file path.' },
      path: { type: 'string', description: 'Alias for filePath.' },
      line: { type: ['number', 'string'], description: '1-based line number.' },
      character: { type: ['number', 'string'], description: '1-based character offset.' },
      query: { type: 'string', description: 'Optional symbol query for workspaceSymbol fallback.' },
      max_results: { type: ['number', 'string'], description: `Maximum results, capped at ${MAX_RESULTS}.` },
    },
    required: ['operation', 'filePath', 'line', 'character'],
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const operation = normalizeOperation(input?.operation)
    const rawPath = input?.filePath ?? input?.path
    if (!rawPath) throw new Error('LSP requires filePath')
    const line = positiveInt(input?.line, 'line')
    const character = positiveInt(input?.character, 'character')
    const maxResults = clampNumber(input?.max_results, DEFAULT_MAX_RESULTS, MAX_RESULTS)
    const abs = ctx.workspace.resolve(rawPath, 'read')
    const rel = relativePath(ctx, abs)
    const info = await stat(abs)
    if (!info.isFile()) return formatOutput(operation, rel, 'Path is not a file.', 0, 0)
    if (info.size > MAX_FILE_SIZE_BYTES) {
      return formatOutput(operation, rel, `File too large for LSP analysis (${Math.ceil(info.size / 1_000_000)}MB exceeds 10MB limit).`, 0, 0)
    }
    const text = await readFilePrefix(abs, Math.min(MAX_READ_BYTES, info.size))
    const lines = text.split(/\r?\n/)
    const symbol = symbolAtPosition(lines, line, character)

    if (operation === 'documentSymbol') {
      const symbols = extractSymbols(text, rel)
      return formatOutput(operation, rel, formatDocumentSymbols(symbols, maxResults), Math.min(symbols.length, maxResults), 1)
    }

    if (operation === 'workspaceSymbol') {
      const symbols = await workspaceSymbols(ctx, input?.query ?? symbol ?? '', maxResults)
      return formatOutput(operation, rel, formatWorkspaceSymbols(symbols), symbols.length, new Set(symbols.map(s => s.path)).size)
    }

    if (!symbol) {
      return formatOutput(operation, rel, `No symbol found at ${rel}:${line}:${character}.`, 0, 0)
    }

    if (operation === 'hover') {
      const defs = await findDefinitions(ctx, symbol, maxResults)
      const localLine = lineText(lines, line)
      return formatOutput(operation, rel, formatHover(symbol, rel, line, character, localLine, defs), defs.length, new Set(defs.map(d => d.path)).size)
    }

    if (operation === 'goToDefinition' || operation === 'goToImplementation') {
      const defs = await findDefinitions(ctx, symbol, maxResults)
      return formatOutput(operation, rel, formatDefinitions(operation, symbol, defs), defs.length, new Set(defs.map(d => d.path)).size)
    }

    if (operation === 'findReferences') {
      const refs = await findReferences(ctx, symbol, maxResults)
      return formatOutput(operation, rel, formatReferences(symbol, refs), refs.length, new Set(refs.map(r => r.path)).size)
    }

    if (operation === 'prepareCallHierarchy') {
      const defs = await findDefinitions(ctx, symbol, maxResults)
      return formatOutput(operation, rel, formatPrepareCallHierarchy(symbol, defs), defs.length, new Set(defs.map(d => d.path)).size)
    }

    if (operation === 'incomingCalls') {
      const refs = (await findReferences(ctx, symbol, maxResults)).filter(ref => !(ref.path === rel && ref.line === line))
      return formatOutput(operation, rel, formatIncomingCalls(symbol, refs), refs.length, new Set(refs.map(r => r.path)).size)
    }

    const outgoing = outgoingCalls(lines, line, rel).slice(0, maxResults)
    return formatOutput(operation, rel, formatOutgoingCalls(symbol, outgoing), outgoing.length, 1)
  },
}

function normalizeOperation(value: unknown): LspOperation {
  const op = typeof value === 'string' ? value : ''
  const allowed: LspOperation[] = ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy', 'incomingCalls', 'outgoingCalls']
  if (allowed.includes(op as LspOperation)) return op as LspOperation
  throw new Error(`Invalid LSP operation: ${op || '<missing>'}`)
}

function positiveInt(value: unknown, name: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`LSP ${name} must be a positive 1-based integer`)
  return n
}

async function readFilePrefix(path: string, limit: number): Promise<string> {
  const buffer = await readFile(path)
  return buffer.subarray(0, limit).toString('utf8')
}

function symbolAtPosition(lines: string[], line: number, character: number): string | null {
  const text = lines[line - 1]
  if (!text) return null
  const pos = Math.max(0, Math.min(text.length - 1, character - 1))
  let match: RegExpExecArray | null
  IDENT_RE.lastIndex = 0
  while ((match = IDENT_RE.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (pos >= start && pos < end) return match[0].slice(0, 80)
  }
  return null
}

function lineText(lines: string[], line: number): string {
  return (lines[line - 1] ?? '').trim().slice(0, 240)
}

async function workspaceFiles(ctx: ToolContext): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    if (files.length >= MAX_WORKSPACE_FILES) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_WORKSPACE_FILES) return
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (entry.name !== '.github') continue
      }
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs)
        continue
      }
      if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) files.push(abs)
    }
  }
  await walk(ctx.workspace.root)
  return files
}

async function findDefinitions(ctx: ToolContext, symbol: string, limit: number): Promise<SymbolEntry[]> {
  const matches: SymbolEntry[] = []
  for (const file of await workspaceFiles(ctx)) {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile() || info.size > MAX_READ_BYTES) continue
    const text = await readFile(file, 'utf8').catch(() => '')
    const rel = relativePath(ctx, file)
    for (const entry of extractSymbols(text, rel)) {
      if (entry.name === symbol) {
        matches.push(entry)
        if (matches.length >= limit) return matches
      }
    }
  }
  return matches
}

async function findReferences(ctx: ToolContext, symbol: string, limit: number): Promise<ReferenceEntry[]> {
  const refs: ReferenceEntry[] = []
  const needle = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g')
  for (const file of await workspaceFiles(ctx)) {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile() || info.size > MAX_READ_BYTES) continue
    const text = await readFile(file, 'utf8').catch(() => '')
    const lines = text.split(/\r?\n/)
    const rel = relativePath(ctx, file)
    for (let i = 0; i < lines.length; i++) {
      needle.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = needle.exec(lines[i]!)) !== null) {
        refs.push({ path: rel, line: i + 1, character: match.index + 1, text: lines[i]!.trim().slice(0, 240) })
        if (refs.length >= limit) return refs
      }
    }
  }
  return refs
}

async function workspaceSymbols(ctx: ToolContext, query: string, limit: number): Promise<SymbolEntry[]> {
  const q = query.trim().toLowerCase()
  const symbols: SymbolEntry[] = []
  for (const file of await workspaceFiles(ctx)) {
    const info = await stat(file).catch(() => null)
    if (!info?.isFile() || info.size > MAX_READ_BYTES) continue
    const text = await readFile(file, 'utf8').catch(() => '')
    const rel = relativePath(ctx, file)
    for (const entry of extractSymbols(text, rel)) {
      if (!q || entry.name.toLowerCase().includes(q)) {
        symbols.push(entry)
        if (symbols.length >= limit) return symbols
      }
    }
  }
  return symbols
}

function extractSymbols(text: string, path: string): SymbolEntry[] {
  const out: SymbolEntry[] = []
  const lines = text.split(/\r?\n/)
  const containerStack: Array<{ indent: number; name: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = stripLineComment(raw).trim()
    if (!trimmed) continue
    const indent = raw.length - raw.trimStart().length
    while (containerStack.length && indent <= containerStack.at(-1)!.indent) containerStack.pop()
    const container = containerStack.at(-1)?.name
    const entry = parseSymbolLine(trimmed, i + 1, path, container)
    if (!entry) continue
    out.push(entry)
    if (['class', 'interface', 'struct', 'trait', 'impl', 'object', 'namespace'].includes(entry.kind) || entry.kind.startsWith('py-class')) {
      containerStack.push({ indent, name: entry.name })
    }
  }
  return out
}

function parseSymbolLine(trimmed: string, line: number, path: string, container?: string): SymbolEntry | null {
  const tsDecl = trimmed.match(/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/)
  if (tsDecl) return symbol(path, line, trimmed.indexOf(tsDecl[5]!) + 1, tsDecl[4]!, tsDecl[5]!, trimmed, container, !!tsDecl[1])
  const tsVar = trimmed.match(/^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::|=|\()/)
  if (tsVar) return symbol(path, line, trimmed.indexOf(tsVar[2]!) + 1, 'variable', tsVar[2]!, trimmed, container, !!tsVar[1])
  const method = trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/)
  if (method && !isControlWord(method[1]!)) return symbol(path, line, trimmed.indexOf(method[1]!) + 1, 'method', method[1]!, trimmed, container)
  const py = trimmed.match(/^(async\s+def|def|class)\s+([A-Za-z_]\w*)/)
  if (py) return symbol(path, line, trimmed.indexOf(py[2]!) + 1, `py-${py[1]}`, py[2]!, trimmed, container)
  const rustGo = trimmed.match(/^(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|func|type)\s+([A-Za-z_]\w*)/)
  if (rustGo) return symbol(path, line, trimmed.indexOf(rustGo[4]!) + 1, rustGo[3]!, rustGo[4]!, trimmed, container, !!rustGo[1])
  return null
}

function symbol(path: string, line: number, character: number, kind: string, name: string, signature: string, container?: string, exported?: boolean): SymbolEntry {
  return { path, line, character, kind, name, signature: signature.slice(0, 240), container, exported }
}

function outgoingCalls(lines: string[], line: number, path: string): ReferenceEntry[] {
  const start = Math.max(1, line - 5)
  const end = Math.min(lines.length, line + 80)
  const refs: ReferenceEntry[] = []
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g
  for (let i = start; i <= end; i++) {
    const text = stripLineComment(lines[i - 1] ?? '')
    let match: RegExpExecArray | null
    while ((match = callRe.exec(text)) !== null) {
      if (!isControlWord(match[1]!)) refs.push({ path, line: i, character: match.index + 1, text: text.trim().slice(0, 240) })
    }
  }
  return refs
}

function formatDocumentSymbols(symbols: SymbolEntry[], limit: number): string {
  if (!symbols.length) return 'No symbols found in document. This may occur if the file is empty or not supported by the fallback parser.'
  return [
    'Document symbols:',
    ...symbols.slice(0, limit).map(s => `  ${s.name} (${kindName(s.kind)}) - Line ${s.line}${s.container ? ` in ${s.container}` : ''}`),
    ...(symbols.length > limit ? [`  ... ${symbols.length - limit} more symbols omitted`] : []),
  ].join('\n')
}

function formatWorkspaceSymbols(symbols: SymbolEntry[]): string {
  if (!symbols.length) return 'No symbols found in workspace. This may occur if the workspace is empty or not supported by the fallback parser.'
  const grouped = groupByPath(symbols)
  const lines = [`Found ${symbols.length} symbols in workspace:`]
  for (const [path, items] of grouped) {
    lines.push(`\n${path}:`)
    for (const s of items) lines.push(`  ${s.name} (${kindName(s.kind)}) - Line ${s.line}${s.container ? ` in ${s.container}` : ''}`)
  }
  return lines.join('\n')
}

function formatDefinitions(operation: LspOperation, symbol: string, defs: SymbolEntry[]): string {
  if (!defs.length) return `No ${operation === 'goToImplementation' ? 'implementation' : 'definition'} found for ${symbol}.`
  if (defs.length === 1) return `Defined in ${location(defs[0]!)}`
  return `Found ${defs.length} definitions for ${symbol}:\n${defs.map(d => `  ${location(d)} ${d.signature}`).join('\n')}`
}

function formatReferences(symbol: string, refs: ReferenceEntry[]): string {
  if (!refs.length) return `No references found for ${symbol}.`
  if (refs.length === 1) return `Found 1 reference:\n  ${location(refs[0]!)} ${refs[0]!.text}`
  const grouped = groupByPath(refs)
  const lines = [`Found ${refs.length} references across ${grouped.size} files:`]
  for (const [path, items] of grouped) {
    lines.push(`\n${path}:`)
    for (const ref of items) lines.push(`  Line ${ref.line}:${ref.character} ${ref.text}`)
  }
  return lines.join('\n')
}

function formatHover(symbolName: string, path: string, line: number, character: number, currentLine: string, defs: SymbolEntry[]): string {
  const def = defs[0]
  return [
    `Hover info at ${line}:${character}:`,
    '',
    `symbol: ${symbolName}`,
    `current: ${path}:${line} ${currentLine}`,
    def ? `definition: ${location(def)} ${def.signature}` : 'definition: not found by fallback parser',
  ].join('\n')
}

function formatPrepareCallHierarchy(symbolName: string, defs: SymbolEntry[]): string {
  if (!defs.length) return `No call hierarchy item found at ${symbolName}`
  return defs.length === 1
    ? `Call hierarchy item: ${defs[0]!.name} (${kindName(defs[0]!.kind)}) - ${location(defs[0]!)}`
    : `Found ${defs.length} call hierarchy items:\n${defs.map(d => `  ${d.name} (${kindName(d.kind)}) - ${location(d)}`).join('\n')}`
}

function formatIncomingCalls(symbolName: string, refs: ReferenceEntry[]): string {
  if (!refs.length) return `No incoming calls found for ${symbolName}.`
  return `Found ${refs.length} incoming calls/references:\n${refs.map(ref => `  ${location(ref)} ${ref.text}`).join('\n')}`
}

function formatOutgoingCalls(symbolName: string, refs: ReferenceEntry[]): string {
  if (!refs.length) return `No outgoing calls found near ${symbolName}.`
  return `Found ${refs.length} outgoing call candidates near ${symbolName}:\n${refs.map(ref => `  ${location(ref)} ${ref.text}`).join('\n')}`
}

function formatOutput(operation: LspOperation, filePath: string, result: string, resultCount: number, fileCount: number): string {
  return [
    `<lsp operation="${operation}" file="${xmlAttr(filePath)}" result_count="${resultCount}" file_count="${fileCount}" mode="fallback">`,
    xmlText(result),
    '</lsp>',
  ].join('\n')
}

function groupByPath<T extends { path: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const existing = map.get(item.path)
    if (existing) existing.push(item)
    else map.set(item.path, [item])
  }
  return map
}

function relativePath(ctx: ToolContext, abs: string): string {
  return relative(ctx.workspace.root, abs).replaceAll('\\', '/') || basename(abs)
}

function location(item: { path: string; line: number; character: number }): string {
  return `${item.path}:${item.line}:${item.character}`
}

function kindName(kind: string): string {
  return kind.replace(/^py-/, '').replace(/^async\s+/, '')
}

function stripLineComment(line: string): string {
  const idx = line.indexOf('//')
  return idx >= 0 ? line.slice(0, idx) : line
}

function isControlWord(value: string): boolean {
  return ['if', 'for', 'while', 'switch', 'catch', 'function', 'return'].includes(value)
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
