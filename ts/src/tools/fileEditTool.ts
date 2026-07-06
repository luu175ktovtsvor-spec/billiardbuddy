import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Tool, ToolContext } from './Tool'
import { recordFileSnapshot } from './fileHistory'

export interface FileEditInput {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean | string
}

interface Match {
  start: number
  end: number
  normalized: boolean
}

const PUNCT_EQUIV: Record<string, string> = {
  '，': ',',
  '。': '.',
  '：': ':',
  '；': ';',
  '！': '!',
  '？': '?',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '｛': '{',
  '｝': '}',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '、': ',',
}

export const fileEditTool: Tool<FileEditInput> = {
  name: 'edit_file',
  description:
    'Edit a UTF-8 text file that was already read in this turn. Replaces old_string with new_string; old_string must match exactly or by Chinese punctuation/quote normalization. Input: { path, old_string, new_string, replace_all? }.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: ['boolean', 'string'], description: 'Set true to replace every occurrence; default replaces exactly one unique occurrence.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    validateInput(input)
    const abs = ctx.workspace.resolve(input.path, 'write')
    await assertFreshRead(abs, ctx)

    const content = await readFile(abs, 'utf8')
    const replaceAll = semanticBoolean(input.replace_all)
    const matches = findMatches(content, input.old_string)
    if (matches.length === 0) {
      throw new Error(`edit_file 未找到 old_string:${preview(input.old_string)}`)
    }
    if (!replaceAll && matches.length > 1) {
      throw new Error(`edit_file 找到 ${matches.length} 处匹配;请提供更长 old_string 或设置 replace_all:true`)
    }

    const selected = replaceAll ? matches : [matches[0]!]
    const next = applyReplacements(content, selected, input.new_string)
    await recordFileSnapshot(ctx, input.path, abs, 'edit_file')
    await ctx.workspace.backup(abs)
    await writeFile(abs, next, 'utf8')

    const info = await stat(abs)
    ctx.fileReads ??= new Map()
    ctx.fileReads.set(abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })

    const mode = selected.some(match => match.normalized) ? '（已使用中文标点/引号归一化匹配）' : ''
    return [
      `已编辑 ${input.path}:${selected.length} 处${mode}`,
      formatEditSnippet(next, selected[0]!.start, input.new_string),
    ].join('\n')
  },
}

function validateInput(input: unknown): asserts input is FileEditInput {
  if (!input || typeof input !== 'object') throw new Error('edit_file 需要对象参数')
  const record = input as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('edit_file 需要 string 参数 path')
  if (typeof record.old_string !== 'string' || record.old_string.length === 0) throw new Error('edit_file 需要非空 old_string')
  if (typeof record.new_string !== 'string') throw new Error('edit_file 需要 string 参数 new_string')
  if (record.old_string === record.new_string) throw new Error('edit_file old_string 与 new_string 相同')
}

async function assertFreshRead(abs: string, ctx: ToolContext): Promise<void> {
  const snapshot = ctx.fileReads?.get(abs)
  if (!snapshot) throw new Error('edit_file 拒绝修改:请先 read_file 读取该文件')
  const info = await stat(abs)
  if (info.mtimeMs !== snapshot.mtimeMs || info.size !== snapshot.size) {
    throw new Error('edit_file 拒绝修改:文件在读取后已变化,请重新 read_file 后再改')
  }
}

function semanticBoolean(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value == null) return false
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

function normalizeForMatch(value: string): string {
  let out = ''
  for (const ch of value) out += PUNCT_EQUIV[ch] ?? ch
  return out
}

function findAll(haystack: string, needle: string, normalized: boolean): Match[] {
  const matches: Match[] = []
  let from = 0
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    matches.push({ start: idx, end: idx + needle.length, normalized })
    from = idx + Math.max(needle.length, 1)
  }
  return matches
}

function findMatches(content: string, oldString: string): Match[] {
  const exact = findAll(content, oldString, false)
  if (exact.length > 0) return exact

  const normalizedContent = normalizeForMatch(content)
  const normalizedOld = normalizeForMatch(oldString)
  if (normalizedContent === content && normalizedOld === oldString) return []
  return findAll(normalizedContent, normalizedOld, true)
}

function applyReplacements(content: string, matches: Match[], replacement: string): string {
  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += content.slice(cursor, match.start)
    out += replacement
    cursor = match.end
  }
  out += content.slice(cursor)
  return out
}

function preview(value: string): string {
  return JSON.stringify(value.length > 120 ? `${value.slice(0, 117)}...` : value)
}

function formatEditSnippet(content: string, changedStart: number, replacement: string): string {
  const before = content.slice(0, changedStart)
  const changedLine = before.split('\n').length
  const replacementLines = Math.max(1, replacement.split('\n').length)
  const lines = content.split('\n')
  const startLine = Math.max(1, changedLine - 2)
  const endLine = Math.min(lines.length, changedLine + replacementLines + 1)
  const width = String(endLine).length
  const body: string[] = []
  for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
    body.push(`${String(lineNo).padStart(width, ' ')}| ${lines[lineNo - 1] ?? ''}`)
  }
  return `<edit_context>\n${body.join('\n')}\n</edit_context>`
}
