import { open, readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Tool } from './Tool'
import type { ImageBlock } from '../types/message'
import { isProjectInstructionPath, loadProjectInstructionsForTarget, loadProjectInstructionsForTargets, projectInstructionScopeKey } from '../harness/projectInstructions'
import { resolveToolPath } from '../permissions/filePathRules'
import { detectEncodingFromBuffer, FULL_READ_MAX_BYTES, isBlockedDevicePath, stripLeadingBom } from './fileIoSafety'
import { isImageExtension, readImageBuffer } from './imageRead'

// 图像整读上限:防超大图 OOM。cc 用原生 sharp 对超预算图缩放,本仓库无重采样能力,只据宽高判定并提示。
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
// vision token 预算(对齐 cc 默认读文件 token 上限量级);超预算的图给出明确提示、不做缩放。
const IMAGE_VISION_TOKEN_BUDGET = 8_000

const MAX_MANY_FILES = 20
const DEFAULT_PER_FILE_BYTES = 80_000
const MAX_PER_FILE_BYTES = 200_000
const DEFAULT_TOTAL_BYTES = 300_000
const MAX_TOTAL_BYTES = 800_000
const DEFAULT_RANGE_LINES = 200
const MAX_RANGE_LINES = 1000
const DEFAULT_RANGE_BYTES = 120_000
const MAX_RANGE_BYTES = 300_000

export interface FileReadInput {
  path: string
  pages?: string
  start_line?: number | string
  end_line?: number | string
  max_bytes?: number | string
}

interface FileReadManyRange {
  path: string
  start_line?: number | string
  end_line?: number | string
  max_bytes?: number | string
}

interface FileReadManyInput {
  paths?: string | string[]
  ranges?: FileReadManyRange | FileReadManyRange[]
  max_bytes_per_file?: number
  max_total_bytes?: number
}

export const fileReadTool: Tool<FileReadInput> = {
  name: 'read_file',
  description:
    `Read a UTF-8 text file inside the workspace. Input: { path, start_line?, end_line?, max_bytes? }. ` +
    `Without range options it returns the full raw file. Use start_line/end_line for focused code context; omitted end_line returns up to ${DEFAULT_RANGE_LINES} lines. The optional pages parameter is ignored for non-PDF files. ` +
    'When a directory-level BILLIARDBUDDY.md applies to the target file, the result includes the applicable instruction block before the file content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      pages: { type: 'string', description: 'PDF page range; ignored for non-PDF files in this TS harness stage.' },
      start_line: { type: ['number', 'string'], description: '1-based first line to read. When provided without end_line, returns a bounded chunk.' },
      end_line: { type: ['number', 'string'], description: `1-based inclusive last line to read. Ranges are capped at ${MAX_RANGE_LINES} lines.` },
      max_bytes: { type: ['number', 'string'], description: `Maximum UTF-8 bytes to return for ranged reads, max ${MAX_RANGE_BYTES}.` },
    },
    required: ['path'],
  },
  isReadOnly: true,
  async execute(input, ctx) {
    if (!input || typeof input.path !== 'string') throw new Error('read_file 需要 string 参数 path')
    const abs = resolveToolPath(ctx, 'read_file', input.path, 'read')
    if (isBlockedDevicePath(abs)) {
      throw new Error(`read_file 拒绝读取:${input.path} 是会阻塞或产生无限输出的设备文件。`)
    }
    const info = await stat(abs)
    if (isImageExtension(extname(input.path))) {
      const { text, imageBlock } = await formatImageRead(abs, input.path, info.size, ctx.signal)
      recordRecentFileRead(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })
      // vision 支持的格式(png/jpeg/gif/webp)把真图像块推进 loop 的 sink,让模型真看到图(loop 组进 tool_result
      // 的块数组);bmp/超大/无法识别 → imageBlock 为 null,仅回元信息文本(向后兼容)。
      if (imageBlock) ctx.imageResultSink?.push(imageBlock)
      return await prependApplicableProjectInstructions(ctx, abs, input.path, text)
    }
    const focused = hasFocusedRead(input)
    if (!focused && info.size > FULL_READ_MAX_BYTES) {
      throw new Error(
        `read_file 文件过大(${info.size} 字节),超过整读上限 ${FULL_READ_MAX_BYTES} 字节:请改用 start_line/end_line 分段读取,或加 max_bytes 限制单次输出。`,
      )
    }
    const buffer = await readFile(abs)
    const encoding = detectEncodingFromBuffer(buffer)
    const content = stripLeadingBom(buffer.toString(encoding))
    recordRecentFileRead(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })
    const body = focused ? formatFocusedRead(input.path, content, info.size, input) : content
    return await prependApplicableProjectInstructions(ctx, abs, input.path, body)
  },
}

export const fileReadManyTool: Tool<FileReadManyInput> = {
  name: 'read_many_files',
  description: `Read several UTF-8 text files or focused line ranges in one tool call. Input: { paths?, ranges?, max_bytes_per_file?, max_total_bytes? }. paths accepts a string or string[]; ranges accepts an object or array. Use ranges:[{path,start_line?,end_line?}] after grep_files when you need several nearby code windows; capped at ${MAX_MANY_FILES} files/chunks and a bounded total output.`,
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: ['array', 'string'], items: { type: 'string' }, description: `Workspace-relative file path(s). Only the first ${MAX_MANY_FILES} files/chunks are read.` },
      ranges: {
        type: ['array', 'object'],
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            start_line: { type: ['number', 'string'], description: '1-based first line to read.' },
            end_line: { type: ['number', 'string'], description: `1-based inclusive last line to read. Each range is capped at ${MAX_RANGE_LINES} lines.` },
            max_bytes: { type: ['number', 'string'], description: `Maximum UTF-8 bytes for this range, also bounded by max_bytes_per_file/max_total_bytes.` },
          },
          required: ['path'],
        },
        description: 'Focused chunks to read. When provided, paths is ignored so impact scans can fetch exact windows in one call.',
      },
      max_bytes_per_file: { type: 'number', description: `Optional per-file byte cap, max ${MAX_PER_FILE_BYTES}.` },
      max_total_bytes: { type: 'number', description: `Optional total byte cap, max ${MAX_TOTAL_BYTES}.` },
    },
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const targetInfo = normalizeManyReadTargets(input)
    if (!targetInfo.rawCount) throw new Error('read_many_files 需要 paths 数组或 ranges 数组')
    const targets = targetInfo.targets.slice(0, MAX_MANY_FILES)
    const perFileLimit = clampBytes(input?.max_bytes_per_file, DEFAULT_PER_FILE_BYTES, MAX_PER_FILE_BYTES)
    const totalLimit = clampBytes(input?.max_total_bytes, DEFAULT_TOTAL_BYTES, MAX_TOTAL_BYTES)
    const blocks: string[] = []
    const resolvedTargets: Array<{ absPath: string; label: string }> = []
    let used = 0

    for (const target of targets) {
      const path = target.path
      if (used >= totalLimit) {
        blocks.push(`<file path="${xmlAttr(path)}" skipped="total_limit" />`)
        continue
      }
      const remaining = totalLimit - used
      const readLimit = Math.max(0, Math.min(perFileLimit, remaining))
      try {
        const abs = resolveToolPath(ctx, 'read_many_files', path, 'read')
        if (isBlockedDevicePath(abs)) {
          blocks.push(`<file path="${xmlAttr(path)}" error="blocked_device_path" />`)
          continue
        }
        const info = await stat(abs)
        if (!info.isFile()) {
          blocks.push(`<file path="${xmlAttr(path)}" error="not_a_file" />`)
          continue
        }
        let text: string
        let bytes: number
        if (hasFocusedRead(target)) {
          const content = await readFile(abs, 'utf8')
          const chunk = buildFocusedRead(path, content, info.size, {
            ...target,
            max_bytes: Math.min(readLimit, clampBytes(target.max_bytes, DEFAULT_RANGE_BYTES, MAX_RANGE_BYTES)),
          })
          text = chunk.text
          bytes = chunk.bytes
        } else {
          const prefix = await readUtf8Prefix(abs, readLimit)
          text = prefix.text
          bytes = prefix.bytes
        }
        used += bytes
        if (!isProjectInstructionPath(abs)) resolvedTargets.push({ absPath: abs, label: path })
        recordRecentFileRead(ctx, abs, { path, mtimeMs: info.mtimeMs, size: info.size })
        if (hasFocusedRead(target)) blocks.push(text)
        else {
          const truncated = bytes < info.size
          blocks.push([
            `<file path="${xmlAttr(path)}" bytes="${bytes}" size="${info.size}"${truncated ? ' truncated="true"' : ''}>`,
            text,
            '</file>',
          ].join('\n'))
        }
      } catch (err) {
        blocks.push(`<file path="${xmlAttr(path)}" error="${xmlAttr(err instanceof Error ? err.message : String(err))}" />`)
      }
    }

    const omitted = targetInfo.targets.length - targets.length
    const body = [
      `<read_many_files count="${targets.length}"${omitted > 0 ? ` omitted="${omitted}"` : ''}${targetInfo.duplicatesOmitted > 0 ? ` duplicates_omitted="${targetInfo.duplicatesOmitted}"` : ''}${targetInfo.rangesMerged > 0 ? ` ranges_merged="${targetInfo.rangesMerged}"` : ''} bytes="${used}" limit="${totalLimit}">`,
      blocks.join('\n'),
      '</read_many_files>',
    ].join('\n')
    const instructions = await loadProjectInstructionsForTargets(ctx.workspace, resolvedTargets, {
      includeWorkspaceRoot: false,
    })
    if (instructions) {
      for (const target of resolvedTargets) markProjectInstructionsSeen(ctx, target.absPath)
    }
    return instructions ? `${instructions}\n\n${body}` : body
  },
}

function normalizeManyReadTargets(input: FileReadManyInput | undefined): { targets: FileReadManyRange[]; rawCount: number; duplicatesOmitted: number; rangesMerged: number } {
  const inputRanges = normalizeRangeList(input?.ranges)
  const rangeMode = Array.isArray(inputRanges) && inputRanges.length > 0
  const rawTargets: FileReadManyRange[] = rangeMode
    ? inputRanges
      .filter((item): item is FileReadManyRange => !!item && typeof item.path === 'string' && item.path.trim().length > 0)
      .map(item => ({ ...item, path: item.path.trim() }))
    : normalizePathList(input?.paths)
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map(path => ({ path: path.trim() }))

  const seen = new Set<string>()
  const targets: FileReadManyRange[] = []
  for (const target of rawTargets) {
    const key = [
      target.path,
      target.start_line ?? '',
      target.end_line ?? '',
      target.max_bytes ?? '',
    ].join('\0')
    if (seen.has(key)) continue
    seen.add(key)
    targets.push(target)
  }
  const mergedTargets = rangeMode ? mergeLineRanges(targets) : targets
  return {
    targets: mergedTargets,
    rawCount: rawTargets.length,
    duplicatesOmitted: rawTargets.length - targets.length,
    rangesMerged: targets.length - mergedTargets.length,
  }
}

function normalizePathList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

function normalizeRangeList(value: unknown): FileReadManyRange[] {
  if (Array.isArray(value)) return value.filter((item): item is FileReadManyRange => !!item && typeof item === 'object')
  if (value && typeof value === 'object') return [value as FileReadManyRange]
  return []
}

function mergeLineRanges(targets: FileReadManyRange[]): FileReadManyRange[] {
  const mergeable = targets
    .filter(canMergeLineRange)
    .map(target => ({ ...target, ...effectiveLineRange(target) }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line || a.end_line - b.end_line)
  const passthrough = targets.filter(target => !canMergeLineRange(target))
  const merged: Array<FileReadManyRange & { start_line: number; end_line: number }> = []
  for (const target of mergeable) {
    const last = merged.at(-1)
    if (last && last.path === target.path && target.start_line <= last.end_line + 1) {
      last.end_line = Math.max(last.end_line, target.end_line)
      continue
    }
    merged.push(target)
  }
  return [...merged, ...passthrough]
}

function canMergeLineRange(target: FileReadManyRange): boolean {
  if (target.max_bytes !== undefined) return false
  return target.start_line !== undefined || target.end_line !== undefined
}

function effectiveLineRange(target: FileReadManyRange): { start_line: number; end_line: number } {
  const start = parsePositiveInt(target.start_line, 1)
  const requestedEnd = target.end_line === undefined
    ? start + DEFAULT_RANGE_LINES - 1
    : Math.max(start, parsePositiveInt(target.end_line, start))
  return {
    start_line: start,
    end_line: Math.min(requestedEnd, start + MAX_RANGE_LINES - 1),
  }
}

async function prependApplicableProjectInstructions(
  ctx: Parameters<typeof fileReadTool.execute>[1],
  abs: string,
  label: string,
  body: string,
): Promise<string> {
  if (isProjectInstructionPath(abs)) return body
  const instructions = await loadProjectInstructionsForTarget(ctx.workspace, abs, {
    targetLabel: label,
    includeWorkspaceRoot: false,
  })
  if (instructions) markProjectInstructionsSeen(ctx, abs)
  return instructions ? `${instructions}\n\n${body}` : body
}

function markProjectInstructionsSeen(ctx: Parameters<typeof fileReadTool.execute>[1], abs: string): void {
  const scope = projectInstructionScopeKey(ctx.workspace, abs)
  if (!scope) return
  ctx.projectInstructionScopes ??= new Set()
  ctx.projectInstructionScopes.add(scope)
}

function recordRecentFileRead(
  ctx: Parameters<typeof fileReadTool.execute>[1],
  abs: string,
  snapshot: { path: string; mtimeMs: number; size: number },
): void {
  ctx.fileReads ??= new Map()
  ctx.fileReads.delete(abs)
  ctx.fileReads.set(abs, snapshot)
}

function clampBytes(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

function hasFocusedRead(input: Pick<FileReadInput, 'start_line' | 'end_line' | 'max_bytes'>): boolean {
  return input.start_line !== undefined || input.end_line !== undefined || input.max_bytes !== undefined
}

function formatFocusedRead(path: string, content: string, size: number, input: FileReadInput): string {
  return buildFocusedRead(path, content, size, input).text
}

function buildFocusedRead(path: string, content: string, size: number, input: Pick<FileReadInput, 'start_line' | 'end_line' | 'max_bytes'>): { text: string; bytes: number } {
  const lines = splitLinesPreserveEndings(content)
  const totalLines = lines.length
  const hasStart = input.start_line !== undefined
  const hasEnd = input.end_line !== undefined
  const maxBytes = clampBytes(input.max_bytes, DEFAULT_RANGE_BYTES, MAX_RANGE_BYTES)
  const startLine = Math.min(parsePositiveInt(input.start_line, 1), Math.max(totalLines, 1))
  let requestedEnd = hasEnd ? parsePositiveInt(input.end_line, startLine) : totalLines
  if (hasStart && !hasEnd) requestedEnd = startLine + DEFAULT_RANGE_LINES - 1
  requestedEnd = Math.max(startLine, requestedEnd)

  const lineCap = hasStart || hasEnd
  const cappedEnd = lineCap ? Math.min(requestedEnd, startLine + MAX_RANGE_LINES - 1) : requestedEnd
  const endLine = Math.min(cappedEnd, totalLines)
  const selected = totalLines === 0 || startLine > totalLines ? '' : lines.slice(startLine - 1, endLine).join('')
  const { text: chunkBody, truncated: byteTruncated } = sliceUtf8(selected, maxBytes)
  const bytes = Buffer.byteLength(chunkBody, 'utf8')
  const truncatedTop = startLine > 1
  const truncatedByRange = lineCap && requestedEnd > cappedEnd
  const truncatedBottom = endLine < totalLines || byteTruncated || truncatedByRange

  const text = [
    `<file_chunk path="${xmlAttr(path)}" start_line="${startLine}" end_line="${endLine}" total_lines="${totalLines}" size="${size}" bytes="${bytes}"` +
      `${truncatedTop ? ' truncated_top="true"' : ''}` +
      `${truncatedBottom ? ' truncated_bottom="true"' : ''}` +
      `${byteTruncated ? ' truncated_bytes="true"' : ''}` +
      `${truncatedByRange ? ' truncated_range="true"' : ''}>`,
    chunkBody,
    '</file_chunk>',
  ].join('\n')
  return { text, bytes }
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

function splitLinesPreserveEndings(content: string): string[] {
  if (!content) return []
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function sliceUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  return { text: text.slice(0, low), truncated: true }
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

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// 图像分支:解码格式/宽高、按 vision 预算估 token、base64 生成 image content-block(见 imageRead.ts)。
// 返回 { text, imageBlock }:text 是给模型看的图像元信息(格式/宽高/估算 token/超预算提示),imageBlock 是
// vision 支持格式(png/jpeg/gif/webp)的真图像块——由 loop 组进 tool_result content,让模型真看到图。
// bmp/超大/无法识别 → imageBlock 为 null(仅回文本,避免把图当 UTF-8 读成乱码)。
// 超 vision 预算:cc 会用原生 sharp 降采样后再送;本仓库无重采样能力,故仍把原图送进去(模型看得到)+ 文本
// 标注 over_vision_budget 让上层知情,不因估算超预算就把图吞掉(那会使 4K 截图等常见图失去 vision)。
async function formatImageRead(abs: string, label: string, size: number, signal?: AbortSignal): Promise<{ text: string; imageBlock: ImageBlock | null }> {
  if (size > IMAGE_MAX_BYTES) {
    return {
      text: `<file_image path="${xmlAttr(label)}" size="${size}" error="too_large">\n图片过大(${size} 字节,超过 ${IMAGE_MAX_BYTES} 字节整读上限),请先裁剪/压缩后再读。\n</file_image>`,
      imageBlock: null,
    }
  }
  const buffer = await readFile(abs, signal ? { signal } : undefined)
  const result = readImageBuffer(buffer)
  if (!result) {
    return {
      text: `<file_image path="${xmlAttr(label)}" size="${size}" error="unrecognized">\n无法识别的图片数据(扩展名像图片但魔数不匹配)。\n</file_image>`,
      imageBlock: null,
    }
  }
  const dims = result.dimensions ? `${result.dimensions.width}x${result.dimensions.height}` : 'unknown'
  const estTokens = result.estimatedVisionTokens
  const overBudget = estTokens !== null && estTokens > IMAGE_VISION_TOKEN_BUDGET
  const attrs = [
    `path="${xmlAttr(label)}"`,
    `format="${result.format}"`,
    `dimensions="${dims}"`,
    `bytes="${result.byteSize}"`,
    `vision_supported="${result.visionSupported}"`,
    ...(estTokens !== null ? [`est_vision_tokens="${estTokens}"`] : []),
    ...(overBudget ? ['over_vision_budget="true"'] : []),
  ].join(' ')
  const notes: string[] = []
  if (!result.visionSupported) notes.push(`格式 ${result.format} 不是 vision 支持的图片类型(仅 png/jpeg/gif/webp),无法作为图像输入。`)
  if (overBudget) notes.push(`估算 vision token(${estTokens})超过预算 ${IMAGE_VISION_TOKEN_BUDGET};图较大(已随结果附上原图,未缩放),必要时先缩放再读。`)
  const body = notes.length ? `\n${notes.join('\n')}\n` : '\n'
  return {
    text: `<file_image ${attrs}>${body}</file_image>`,
    imageBlock: result.imageBlock,
  }
}
