import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Tool, ToolContext } from './Tool'
import { fileHistoryBackupPath, recordFileSnapshot } from './fileHistory'
import { resolveToolPath } from '../permissions/filePathRules'

export interface FileEditInput {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean | string
}

export interface FileMultiEditInput {
  path: string
  edits: Array<{
    old_string: string
    new_string: string
    replace_all?: boolean | string
  }>
}

export interface FilePatchInput {
  path: string
  patch: string
}

export interface FilePatchManyInput {
  patches: Array<{
    path: string
    patch: string
  }>
}

interface Match {
  start: number
  end: number
  normalized: boolean
}

interface AppliedEdit {
  index: number
  count: number
  normalized: boolean
  start: number
  replacement: string
}

interface PatchLine {
  op: ' ' | '-' | '+'
  text: string
}

interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: PatchLine[]
}

interface AppliedHunk {
  index: number
  startLine: number
  newLines: number
  added: number
  removed: number
}

interface PreparedPatch {
  path: string
  abs: string
  content: string
  next: string
  applied: AppliedHunk[]
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
    const abs = resolveToolPath(ctx, 'edit_file', input.path, 'write')
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
    const snapshot = await recordFileSnapshot(ctx, input.path, abs, 'edit_file')
    const backupPath = fileHistoryBackupPath(ctx, snapshot)
    await ctx.workspace.backup(abs)
    await writeFile(abs, next, 'utf8')

    const info = await stat(abs)
    recordRecentFileRead(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })

    const mode = selected.some(match => match.normalized) ? '（已使用中文标点/引号归一化匹配）' : ''
    return [
      fileChangeTag(input.path, snapshot.id, backupPath),
      `已编辑 ${input.path}:${selected.length} 处${mode}`,
      formatEditSnippet(next, selected[0]!.start, input.new_string),
    ].join('\n')
  },
}

export const fileMultiEditTool: Tool<FileMultiEditInput> = {
  name: 'multi_edit_file',
  description:
    'Apply several string replacements to one UTF-8 text file that was already read in this turn. Edits are applied in order and the file is written once only if every edit matches. Input: { path, edits:[{ old_string, new_string, replace_all? }] }.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: ['boolean', 'string'], description: 'Set true to replace every occurrence for this edit; default replaces exactly one unique occurrence.' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    validateMultiInput(input)
    const abs = resolveToolPath(ctx, 'multi_edit_file', input.path, 'write')
    await assertFreshRead(abs, ctx)

    const content = await readFile(abs, 'utf8')
    let next = content
    const applied: AppliedEdit[] = []
    for (let i = 0; i < input.edits.length; i++) {
      const edit = input.edits[i]!
      const replaceAll = semanticBoolean(edit.replace_all)
      const matches = findMatches(next, edit.old_string)
      if (matches.length === 0) throw new Error(`multi_edit_file 第 ${i + 1} 个 edit 未找到 old_string:${preview(edit.old_string)}`)
      if (!replaceAll && matches.length > 1) {
        throw new Error(`multi_edit_file 第 ${i + 1} 个 edit 找到 ${matches.length} 处匹配;请提供更长 old_string 或设置 replace_all:true`)
      }
      const selected = replaceAll ? matches : [matches[0]!]
      next = applyReplacements(next, selected, edit.new_string)
      applied.push({
        index: i + 1,
        count: selected.length,
        normalized: selected.some(match => match.normalized),
        start: selected[0]!.start,
        replacement: edit.new_string,
      })
    }

    const snapshot = await recordFileSnapshot(ctx, input.path, abs, 'multi_edit_file')
    const backupPath = fileHistoryBackupPath(ctx, snapshot)
    await ctx.workspace.backup(abs)
    await writeFile(abs, next, 'utf8')

    const info = await stat(abs)
    recordRecentFileRead(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })

    const total = applied.reduce((sum, item) => sum + item.count, 0)
    const normalized = applied.some(item => item.normalized) ? '（部分 edit 使用中文标点/引号归一化匹配）' : ''
    return [
      fileChangeTag(input.path, snapshot.id, backupPath),
      `已批量编辑 ${input.path}:${applied.length} 个 edit,${total} 处替换${normalized}`,
      formatMultiEditSnippets(next, applied),
    ].join('\n')
  },
}

export const filePatchTool: Tool<FilePatchInput> = {
  name: 'patch_file',
  description:
    'Apply a unified diff patch to one UTF-8 text file that was already read in this turn. The patch is applied atomically with exact context matching. Input: { path, patch }.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      patch: { type: 'string', description: 'Unified diff hunks for this file, e.g. @@ -1,2 +1,2 @@ lines with space/-/+ prefixes.' },
    },
    required: ['path', 'patch'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    validatePatchInput(input)
    const abs = resolveToolPath(ctx, 'patch_file', input.path, 'write')
    await assertFreshRead(abs, ctx, 'patch_file')

    const content = await readFile(abs, 'utf8')
    const hunks = parseUnifiedPatch(input.patch)
    const { next, applied } = applyUnifiedPatch(content, hunks)
    if (next === content) throw new Error('patch_file patch 未产生任何变化')

    const snapshot = await recordFileSnapshot(ctx, input.path, abs, 'patch_file')
    const backupPath = fileHistoryBackupPath(ctx, snapshot)
    await ctx.workspace.backup(abs)
    await writeFile(abs, next, 'utf8')

    const info = await stat(abs)
    recordRecentFileRead(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })

    const added = applied.reduce((sum, item) => sum + item.added, 0)
    const removed = applied.reduce((sum, item) => sum + item.removed, 0)
    return [
      fileChangeTag(input.path, snapshot.id, backupPath),
      `已应用 patch ${input.path}:${applied.length} 个 hunk,+${added}/-${removed}`,
      formatPatchSnippets(next, applied),
    ].join('\n')
  },
}

export const filePatchManyTool: Tool<FilePatchManyInput> = {
  name: 'patch_files',
  description:
    'Apply unified diff patches to multiple UTF-8 text files that were already read in this turn. All patches are validated before any file is written; if a write fails, previous writes are rolled back best-effort. Input: { patches:[{ path, patch }] }.',
  inputSchema: {
    type: 'object',
    properties: {
      patches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            patch: { type: 'string', description: 'Unified diff hunks for this file.' },
          },
          required: ['path', 'patch'],
        },
        description: 'Patches for distinct workspace files. Combine hunks for the same file into one patch entry.',
      },
    },
    required: ['patches'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    validatePatchManyInput(input)
    const seenAbsPaths = new Set<string>()
    const prepared: PreparedPatch[] = []
    for (let i = 0; i < input.patches.length; i++) {
      const item = input.patches[i]!
      const abs = resolveToolPath(ctx, 'patch_files', item.path, 'write')
      if (seenAbsPaths.has(abs)) throw new Error(`patch_files 重复路径:${item.path};请把同一文件的 hunks 合并到一个 patch`)
      seenAbsPaths.add(abs)
      await assertFreshRead(abs, ctx, 'patch_files')
      const content = await readFile(abs, 'utf8')
      const hunks = parseUnifiedPatch(item.patch)
      const { next, applied } = applyUnifiedPatch(content, hunks)
      if (next === content) throw new Error(`patch_files 第 ${i + 1} 个文件 patch 未产生任何变化:${item.path}`)
      prepared.push({ path: item.path, abs, content, next, applied })
    }

    const snapshots: Array<{ patch: PreparedPatch; snapshotId: string; backupPath?: string }> = []
    for (const item of prepared) {
      const snapshot = await recordFileSnapshot(ctx, item.path, item.abs, 'patch_files')
      snapshots.push({ patch: item, snapshotId: snapshot.id, backupPath: fileHistoryBackupPath(ctx, snapshot) })
      await ctx.workspace.backup(item.abs)
    }

    const written: PreparedPatch[] = []
    try {
      for (const item of prepared) {
        await writeFile(item.abs, item.next, 'utf8')
        written.push(item)
      }
    } catch (error) {
      await Promise.allSettled(written.map(item => writeFile(item.abs, item.content, 'utf8')))
      throw new Error(`patch_files 写入失败,已尽力回滚已写文件:${error instanceof Error ? error.message : String(error)}`)
    }

    for (const item of prepared) {
      const info = await stat(item.abs)
      recordRecentFileRead(ctx, item.abs, { path: item.path, mtimeMs: info.mtimeMs, size: info.size })
    }

    return [
      `<file_changes count="${prepared.length}">`,
      ...prepared.map((item, index) => {
        const meta = snapshots[index]!
        const added = item.applied.reduce((sum, hunk) => sum + hunk.added, 0)
        const removed = item.applied.reduce((sum, hunk) => sum + hunk.removed, 0)
        return [
          fileChangeTag(item.path, meta.snapshotId, meta.backupPath),
          `已应用 patch ${item.path}:${item.applied.length} 个 hunk,+${added}/-${removed}`,
          formatPatchSnippets(item.next, item.applied),
        ].join('\n')
      }),
      '</file_changes>',
    ].join('\n')
  },
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fileChangeTag(path: string, snapshotId: string, backupPath?: string): string {
  const backup = backupPath ? ` backup_path="${escapeAttr(backupPath)}"` : ''
  return `<file_change path="${escapeAttr(path)}" snapshot_id="${escapeAttr(snapshotId)}"${backup} />`
}

function validateInput(input: unknown): asserts input is FileEditInput {
  if (!input || typeof input !== 'object') throw new Error('edit_file 需要对象参数')
  const record = input as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('edit_file 需要 string 参数 path')
  if (typeof record.old_string !== 'string' || record.old_string.length === 0) throw new Error('edit_file 需要非空 old_string')
  if (typeof record.new_string !== 'string') throw new Error('edit_file 需要 string 参数 new_string')
  if (record.old_string === record.new_string) throw new Error('edit_file old_string 与 new_string 相同')
}

function validateMultiInput(input: unknown): asserts input is FileMultiEditInput {
  if (!input || typeof input !== 'object') throw new Error('multi_edit_file 需要对象参数')
  const record = input as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('multi_edit_file 需要 string 参数 path')
  if (!Array.isArray(record.edits) || record.edits.length === 0) throw new Error('multi_edit_file 需要非空 edits 数组')
  if (record.edits.length > 50) throw new Error('multi_edit_file 一次最多 50 个 edit')
  for (let i = 0; i < record.edits.length; i++) {
    const edit = record.edits[i]
    if (!edit || typeof edit !== 'object') throw new Error(`multi_edit_file 第 ${i + 1} 个 edit 需要对象`)
    const item = edit as Record<string, unknown>
    if (typeof item.old_string !== 'string' || item.old_string.length === 0) throw new Error(`multi_edit_file 第 ${i + 1} 个 edit 需要非空 old_string`)
    if (typeof item.new_string !== 'string') throw new Error(`multi_edit_file 第 ${i + 1} 个 edit 需要 string new_string`)
    if (item.old_string === item.new_string) throw new Error(`multi_edit_file 第 ${i + 1} 个 edit old_string 与 new_string 相同`)
  }
}

function validatePatchInput(input: unknown): asserts input is FilePatchInput {
  if (!input || typeof input !== 'object') throw new Error('patch_file 需要对象参数')
  const record = input as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path.trim()) throw new Error('patch_file 需要 string 参数 path')
  if (typeof record.patch !== 'string' || !record.patch.trim()) throw new Error('patch_file 需要非空 patch')
  if (record.patch.length > 500_000) throw new Error('patch_file patch 过大,请拆成更小 patch')
}

function validatePatchManyInput(input: unknown): asserts input is FilePatchManyInput {
  if (!input || typeof input !== 'object') throw new Error('patch_files 需要对象参数')
  const record = input as Record<string, unknown>
  if (!Array.isArray(record.patches) || record.patches.length === 0) throw new Error('patch_files 需要非空 patches 数组')
  if (record.patches.length > 20) throw new Error('patch_files 一次最多 20 个文件 patch')
  let totalPatchLength = 0
  for (let i = 0; i < record.patches.length; i++) {
    const item = record.patches[i]
    if (!item || typeof item !== 'object') throw new Error(`patch_files 第 ${i + 1} 个 patch 需要对象`)
    const patch = item as Record<string, unknown>
    if (typeof patch.path !== 'string' || !patch.path.trim()) throw new Error(`patch_files 第 ${i + 1} 个 patch 需要 string path`)
    if (typeof patch.patch !== 'string' || !patch.patch.trim()) throw new Error(`patch_files 第 ${i + 1} 个 patch 需要非空 patch`)
    totalPatchLength += patch.patch.length
  }
  if (totalPatchLength > 1_000_000) throw new Error('patch_files patch 总量过大,请拆成更小批次')
}

async function assertFreshRead(abs: string, ctx: ToolContext, toolName = 'edit_file'): Promise<void> {
  const snapshot = ctx.fileReads?.get(abs)
  if (!snapshot) throw new Error(`${toolName} 拒绝修改:请先 read_file 读取该文件`)
  const info = await stat(abs)
  if (info.mtimeMs !== snapshot.mtimeMs || info.size !== snapshot.size) {
    throw new Error(`${toolName} 拒绝修改:文件在读取后已变化,请重新 read_file 后再改`)
  }
}

function recordRecentFileRead(ctx: ToolContext, abs: string, snapshot: { path: string; mtimeMs: number; size: number }): void {
  ctx.fileReads ??= new Map()
  ctx.fileReads.delete(abs)
  ctx.fileReads.set(abs, snapshot)
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

function parseUnifiedPatch(patch: string): PatchHunk[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const hunks: PatchHunk[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]!
    const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (!match) {
      i++
      continue
    }
    const hunk: PatchHunk = {
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      lines: [],
    }
    i++
    while (i < lines.length && !lines[i]!.startsWith('@@ ')) {
      const raw = lines[i]!
      if (raw.startsWith('\\ No newline')) {
        i++
        continue
      }
      const op = raw[0]
      if (op !== ' ' && op !== '-' && op !== '+') throw new Error(`patch_file 非法 hunk 行:${preview(raw)}`)
      hunk.lines.push({ op, text: raw.slice(1) })
      i++
    }
    validateHunkCounts(hunk, hunks.length + 1)
    hunks.push(hunk)
  }
  if (!hunks.length) throw new Error('patch_file 未找到 unified diff hunk')
  return hunks
}

function validateHunkCounts(hunk: PatchHunk, index: number): void {
  const oldCount = hunk.lines.filter(line => line.op !== '+').length
  const newCount = hunk.lines.filter(line => line.op !== '-').length
  if (oldCount !== hunk.oldLines || newCount !== hunk.newLines) {
    throw new Error(`patch_file 第 ${index} 个 hunk 行数与 header 不一致:old ${oldCount}/${hunk.oldLines},new ${newCount}/${hunk.newLines}`)
  }
}

function applyUnifiedPatch(content: string, hunks: PatchHunk[]): { next: string; applied: AppliedHunk[] } {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const finalNewline = content.endsWith('\n')
  const lines = content.split(/\r?\n/)
  if (finalNewline) lines.pop()
  const applied: AppliedHunk[] = []
  let offset = 0

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!
    const index = (hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1) + offset
    if (index < 0 || index > lines.length) throw new Error(`patch_file 第 ${i + 1} 个 hunk 起点越界`)
    let cursor = index
    const replacement: string[] = []
    let added = 0
    let removed = 0
    for (const line of hunk.lines) {
      if (line.op === ' ') {
        assertPatchLine(lines, cursor, line.text, i + 1)
        replacement.push(line.text)
        cursor++
      } else if (line.op === '-') {
        assertPatchLine(lines, cursor, line.text, i + 1)
        cursor++
        removed++
      } else {
        replacement.push(line.text)
        added++
      }
    }
    const removeCount = cursor - index
    lines.splice(index, removeCount, ...replacement)
    offset += replacement.length - removeCount
    applied.push({ index: i + 1, startLine: index + 1, newLines: replacement.length, added, removed })
  }

  return { next: lines.join(newline) + (finalNewline ? newline : ''), applied }
}

function assertPatchLine(lines: string[], index: number, expected: string, hunkIndex: number): void {
  const actual = lines[index]
  if (actual !== expected) {
    throw new Error(formatPatchMismatch(lines, index, expected, actual, hunkIndex))
  }
}

function formatPatchMismatch(lines: string[], index: number, expected: string, actual: string | undefined, hunkIndex: number): string {
  const lineNo = index + 1
  const rereadStart = Math.max(1, lineNo - 4)
  const rereadEnd = Math.min(Math.max(lines.length, 1), lineNo + 4)
  const exact = findLineCandidates(lines, expected, index, false)
  const trimmed = exact.length > 0 ? [] : findLineCandidates(lines, expected, index, true)
  const exactHint = exact.length > 0 ? `;期望行在文件其他位置:${exact.map(n => `第 ${n} 行`).join(',')}` : ''
  const trimmedHint = trimmed.length > 0 ? `;仅空白差异候选:${trimmed.map(n => `第 ${n} 行`).join(',')}` : ''
  return [
    `patch_file 第 ${hunkIndex} 个 hunk 上下文不匹配:第 ${lineNo} 行期望 ${preview(expected)},实际 ${preview(actual ?? '<EOF>')}`,
    `${exactHint}${trimmedHint};请重新 read_file { "start_line": ${rereadStart}, "end_line": ${rereadEnd} } 后重算 patch`,
  ].join('')
}

function findLineCandidates(lines: string[], expected: string, index: number, trim: boolean): number[] {
  const needle = trim ? expected.trim() : expected
  if (trim && !needle) return []
  const candidates: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === index) continue
    const value = trim ? lines[i]!.trim() : lines[i]!
    if (value === needle) candidates.push(i + 1)
  }
  return candidates
    .sort((a, b) => Math.abs(a - (index + 1)) - Math.abs(b - (index + 1)))
    .slice(0, 3)
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

function formatMultiEditSnippets(content: string, edits: AppliedEdit[]): string {
  const snippets = edits.slice(0, 3).map(edit => {
    const snippet = formatEditSnippet(content, edit.start, edit.replacement)
      .replace('<edit_context>', `<edit_context edit="${edit.index}" replacements="${edit.count}">`)
    return snippet
  })
  if (edits.length > 3) snippets.push(`<edit_context omitted="${edits.length - 3}" />`)
  return snippets.join('\n')
}

function formatPatchSnippets(content: string, hunks: AppliedHunk[]): string {
  const lines = content.split('\n')
  const snippets = hunks.slice(0, 3).map(hunk => {
    const startLine = Math.max(1, hunk.startLine - 2)
    const endLine = Math.min(lines.length, hunk.startLine + Math.max(hunk.newLines, 1) + 1)
    const width = String(endLine).length
    const body: string[] = []
    for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
      body.push(`${String(lineNo).padStart(width, ' ')}| ${lines[lineNo - 1] ?? ''}`)
    }
    return `<patch_context hunk="${hunk.index}" added="${hunk.added}" removed="${hunk.removed}">\n${body.join('\n')}\n</patch_context>`
  })
  if (hunks.length > 3) snippets.push(`<patch_context omitted="${hunks.length - 3}" />`)
  return snippets.join('\n')
}
