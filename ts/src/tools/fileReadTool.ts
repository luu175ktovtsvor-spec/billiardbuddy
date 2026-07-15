import { open, readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Tool } from './Tool'
import type { ImageBlock } from '../types/message'
import { isProjectInstructionPath, loadProjectInstructionsForTarget, loadProjectInstructionsForTargets, projectInstructionScopeKey } from '../harness/projectInstructions'
import { resolveToolPath } from '../permissions/filePathRules'
import { detectEncodingFromBuffer, FULL_READ_MAX_BYTES, hasBinaryExtension, isBlockedDevicePath, looksBinaryBuffer, stripLeadingBom } from './fileIoSafety'
import { isImageExtension, readImageBuffer } from './imageRead'
import { detectPdf, isPdfExtension, PDF_MAX_BYTES, readPdfBuffer } from './pdfRead'

// 图像整读上限:防超大图 OOM。上限内的大图由 imageRead 生成受限视觉预览，原文件不改。
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
// vision token 预算(对齐 cc 默认读文件 token 上限量级)。
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
    `Read a file inside the workspace. Input: { path, start_line?, end_line?, max_bytes? }. ` +
    `Text files return raw UTF-8 content. Images (png/jpg/gif/webp) and PDFs are read natively: the model sees the image/PDF visually, not as garbled text — so this is the right tool for reading a contract PDF or a screenshot. Other binary files (archives, executables, Office docs, databases) return a clear error instead of mojibake. ` +
    `Without range options a text file returns fully. Use start_line/end_line for focused code context; omitted end_line returns up to ${DEFAULT_RANGE_LINES} lines. The pages parameter is currently ignored (PDFs are sent whole as a visual document). ` +
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
    const ext = extname(input.path)
    // PDF → 文档视觉通道(对齐 cc):把 PDF 作为 document content-block 喂给模型"看",而不是当 UTF-8 读成乱码。
    if (isPdfExtension(ext)) {
      const text = await formatPdfRead(ctx, abs, input.path, info.size, ctx.signal)
      recordRecentFileRead(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })
      return await prependApplicableProjectInstructions(ctx, abs, input.path, text)
    }
    // 已知二进制扩展名(非 PDF/图片)→ 友好报错,绝不当文本硬读吐乱码(对齐 cc hasBinaryExtension 拦截)。
    if (hasBinaryExtension(input.path)) {
      throw new Error(binaryReadError(input.path, ext))
    }
    const focused = hasFocusedRead(input)
    if (!focused && info.size > FULL_READ_MAX_BYTES) {
      throw new Error(
        `read_file 文件过大(${info.size} 字节),超过整读上限 ${FULL_READ_MAX_BYTES} 字节:请改用 start_line/end_line 分段读取,或加 max_bytes 限制单次输出。`,
      )
    }
    const buffer = await readFile(abs)
    // 内容嗅探:扩展名伪装/无扩展名的文件——其实是 PDF 的走文档通道,其它二进制给友好报错(不吐乱码)。
    if (detectPdf(buffer)) {
      const text = formatPdfReadFromBuffer(ctx, buffer, input.path, info.size)
      recordRecentFileRead(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })
      return await prependApplicableProjectInstructions(ctx, abs, input.path, text)
    }
    if (looksBinaryBuffer(buffer)) {
      throw new Error(binaryReadError(input.path, ext))
    }
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
        // read_many 是批量文本读:二进制(含 PDF/图片)当文本读会吐乱码。PDF/图片请单独用 read_file 走视觉/文档通道。
        if (hasBinaryExtension(path)) {
          blocks.push(`<file path="${xmlAttr(path)}" error="${isPdfExtension(extname(path)) ? 'pdf_use_read_file' : 'binary_file'}" />`)
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
// 超 vision 预算时本地生成受限预览；生成失败则只返回元信息，绝不把超大原图塞进模型请求。
// 二进制读错文案:统一给"别当文本读会乱码 + 该怎么办"的可执行提示,替代原来直接吐乱码的行为。
function binaryReadError(path: string, ext: string): string {
  const what = ext ? `看起来是 ${ext} 二进制文件` : '内容看起来是二进制'
  return (
    `read_file 无法把二进制文件当文本读:${path}(${what})。这类文件按 UTF-8 读会变成乱码。` +
    `若是 PDF 请确认扩展名为 .pdf(会自动走文档视觉通道让模型查看);图片用 .png/.jpg/.gif/.webp(走视觉通道);` +
    `其它二进制(压缩包/可执行/数据库/Office 文档等)请改用对应的专门工具处理。`
  )
}

// PDF 分支(按扩展名):按 PDF_MAX_BYTES 限流,超限给友好报错文本(不 throw、不吐乱码);否则读整份转文档块。
// 与 formatImageRead 对称:返回给模型的是元信息文本(向后兼容),真 document 块走 ctx.documentResultSink 由 loop
// 组进随 tool_result 尾随的 user 消息(顶层块)。cc 用 poppler 还能把每页转图像块降级;本仓库无依赖,只走文档块。
async function formatPdfRead(ctx: Parameters<typeof fileReadTool.execute>[1], abs: string, label: string, size: number, signal?: AbortSignal): Promise<string> {
  if (size > PDF_MAX_BYTES) return pdfTooLargeText(label, size)
  const buffer = await readFile(abs, signal ? { signal } : undefined)
  return formatPdfReadFromBuffer(ctx, buffer, label, size)
}

// PDF 分支(按已读缓冲):供"扩展名伪装的 PDF"复用同一套文档块生成 + 元信息文本。
function formatPdfReadFromBuffer(ctx: Parameters<typeof fileReadTool.execute>[1], buffer: Buffer, label: string, size: number): string {
  if (buffer.length > PDF_MAX_BYTES) return pdfTooLargeText(label, buffer.length)
  const result = readPdfBuffer(buffer)
  // 有文档通道 → 推真 document 块给模型看;无(脱离 loop 单测/旧 reader)→ 只回元信息文本(向后兼容)。
  ctx.documentResultSink?.push(result.documentBlock)
  const pagesAttr = result.pageCountEstimate !== null ? ` pages~="${result.pageCountEstimate}"` : ''
  const note = ctx.documentResultSink
    ? 'PDF 已作为文档(document 视觉块)随本次结果发送给模型查看,请据其内容作答;这不是文本抽取,无法按行号定位。'
    : 'PDF 已识别但当前无文档通道回灌(仅返回元信息)。'
  return `<file_pdf path="${xmlAttr(label)}" bytes="${result.byteSize}" size="${size}"${pagesAttr}>\n${note}\n</file_pdf>`
}

function pdfTooLargeText(label: string, size: number): string {
  return (
    `<file_pdf path="${xmlAttr(label)}" size="${size}" error="too_large">\n` +
    `PDF 过大(${size} 字节,超过 ${PDF_MAX_BYTES} 字节文档上限),无法整份作为视觉文档发送。` +
    `请先拆分/压缩该 PDF,或改用能抽取文本的专门工具处理后再读。\n</file_pdf>`
  )
}

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
  const originalTokens = result.estimatedVisionTokens
  const previewTokens = estimatePreviewTokens(result.previewDimensions)
  const overBudget = originalTokens !== null && originalTokens > IMAGE_VISION_TOKEN_BUDGET
  const attrs = [
    `path="${xmlAttr(label)}"`,
    `format="${result.format}"`,
    `dimensions="${dims}"`,
    `bytes="${result.byteSize}"`,
    `vision_supported="${result.visionSupported}"`,
    ...(originalTokens !== null ? [`original_est_vision_tokens="${originalTokens}"`] : []),
    ...(previewTokens !== null ? [`est_vision_tokens="${previewTokens}"`] : []),
    ...(result.previewDimensions ? [`preview_dimensions="${result.previewDimensions.width}x${result.previewDimensions.height}"`] : []),
    ...(result.previewByteSize !== null ? [`preview_bytes="${result.previewByteSize}"`] : []),
    ...(result.previewResized ? ['preview_resized="true"'] : []),
    ...(overBudget ? ['over_vision_budget="true"'] : []),
  ].join(' ')
  const notes: string[] = []
  if (!result.visionSupported) notes.push(`格式 ${result.format} 不是 vision 支持的图片类型(仅 png/jpeg/gif/webp),无法作为图像输入。`)
  if (result.previewResized) notes.push('原图较大，已在本地生成受限预览供模型查看；原文件没有修改。')
  if (overBudget && !result.imageBlock) notes.push(`原图估算 vision token(${originalTokens})超过预算 ${IMAGE_VISION_TOKEN_BUDGET}，且无法生成安全预览；本次只返回元信息。`)
  if (result.previewOmittedReason) notes.push(result.previewOmittedReason)
  const body = notes.length ? `\n${notes.join('\n')}\n` : '\n'
  return {
    text: `<file_image ${attrs}>${body}</file_image>`,
    imageBlock: result.imageBlock,
  }
}

function estimatePreviewTokens(dimensions: { width: number; height: number } | null): number | null {
  if (!dimensions) return null
  return Math.ceil((dimensions.width * dimensions.height) / 750)
}
