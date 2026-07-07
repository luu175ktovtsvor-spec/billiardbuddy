import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Tool } from './Tool'
import { stripAnsiControlSequences } from './outputSanitize'

const DEFAULT_MAX_BYTES = 120_000
const MAX_BYTES = 500_000

export interface ReadStoredToolResultInput {
  path?: string
  offset?: number | string
  max_bytes?: number | string
  tail?: boolean | string
}

export const readStoredToolResultTool: Tool<ReadStoredToolResultInput> = {
  name: 'read_stored_tool_result',
  description:
    'Read a bounded window from an oversized stored tool result path returned by <stored_tool_result>. Input: { path, offset?, max_bytes?, tail? }. Only paths inside the current session tool-result store are allowed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path from the <stored_tool_result path="..."> attribute, or a filename inside the session tool-result store.' },
      offset: { type: ['number', 'string'], description: 'Byte offset to start reading from. Ignored when tail is true.' },
      max_bytes: { type: ['number', 'string'], description: `Maximum bytes to read, default ${DEFAULT_MAX_BYTES}, max ${MAX_BYTES}.` },
      tail: { type: ['boolean', 'string'], description: 'Set true to read the tail window instead of from offset.' },
    },
    required: ['path'],
  },
  isReadOnly: true,
  fatalReasonFor(input) {
    if (!input?.path || typeof input.path !== 'string' || !input.path.trim()) return 'read_stored_tool_result 需要 path'
    return null
  },
  async execute(input, ctx) {
    if (!ctx.toolResultStoreDir) {
      return '<stored_tool_result_read status="missing_store_dir">\n当前会话没有可回读的大工具结果目录。\n</stored_tool_result_read>'
    }
    const requested = input.path!.trim()
    const base = resolve(ctx.toolResultStoreDir)
    const target = isAbsolute(requested) ? resolve(requested) : resolve(base, requested)
    const allowed = await isInsideRealPath(base, target)
    if (!allowed) {
      return `<stored_tool_result_read status="rejected" path="${xmlAttr(requested)}">\n只能读取当前会话工具结果目录里的文件。\n</stored_tool_result_read>`
    }

    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(target)
    } catch (error) {
      return `<stored_tool_result_read status="missing" path="${xmlAttr(requested)}">\n${xmlText(errorMessage(error))}\n</stored_tool_result_read>`
    }
    if (!info.isFile()) {
      return `<stored_tool_result_read status="not_file" path="${xmlAttr(requested)}" />`
    }

    const maxBytes = clampNumber(input.max_bytes, DEFAULT_MAX_BYTES, MAX_BYTES)
    const size = info.size
    const offset = semanticBoolean(input.tail)
      ? Math.max(0, size - maxBytes)
      : Math.min(size, clampNumber(input.offset, 0, Number.MAX_SAFE_INTEGER))
    const bytesToRead = Math.min(maxBytes, Math.max(0, size - offset))
    const body = bytesToRead > 0 ? await readWindow(target, offset, bytesToRead) : Buffer.alloc(0)
    const text = stripAnsiControlSequences(body.toString('utf8'))
    return [
      `<stored_tool_result_read status="completed" path="${xmlAttr(requested)}" size="${size}" offset="${offset}" bytes="${body.length}" limit="${maxBytes}" truncated_top="${offset > 0 ? 'true' : 'false'}" truncated_bottom="${offset + body.length < size ? 'true' : 'false'}">`,
      xmlText(text),
      '</stored_tool_result_read>',
    ].join('\n')
  },
}

export async function isInsideRealPath(base: string, target: string): Promise<boolean> {
  try {
    const [baseReal, targetReal] = await Promise.all([realpath(base), realpath(target)])
    const rel = relative(baseReal, targetReal)
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    const rel = relative(base, target)
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
  }
}

export async function readWindow(path: string, offset: number, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const result = await handle.read(buf, 0, bytes, offset)
    return buf.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

export function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.max(0, Math.min(max, Math.floor(n)))
}

export function semanticBoolean(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value == null) return false
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

export function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
