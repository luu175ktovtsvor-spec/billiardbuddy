import { open, stat } from 'node:fs/promises'
import type { ToolContext } from '../tools/Tool'
import { textBlock, type Message } from '../types/message'
import { loadProjectInstructionsForTargets } from '../harness/projectInstructions'

export const DEFAULT_RECENT_FILE_CONTEXT_MAX_FILES = 5
export const DEFAULT_RECENT_FILE_CONTEXT_MAX_BYTES_PER_FILE = 12_000
export const DEFAULT_RECENT_FILE_CONTEXT_MAX_TOTAL_BYTES = 40_000

export interface RecentFileContextOptions {
  maxFiles?: number
  maxBytesPerFile?: number
  maxTotalBytes?: number
}

export async function buildRecentFileContextMessage(
  ctx: ToolContext,
  opts: RecentFileContextOptions = {},
): Promise<Message | null> {
  const entries = Array.from(ctx.fileReads?.entries() ?? [])
  if (!entries.length) return null

  const maxFiles = clampPositive(opts.maxFiles, DEFAULT_RECENT_FILE_CONTEXT_MAX_FILES)
  const maxBytesPerFile = clampPositive(opts.maxBytesPerFile, DEFAULT_RECENT_FILE_CONTEXT_MAX_BYTES_PER_FILE)
  let remaining = clampPositive(opts.maxTotalBytes, DEFAULT_RECENT_FILE_CONTEXT_MAX_TOTAL_BYTES)
  const recent = entries.slice(Math.max(0, entries.length - maxFiles))
  const instructions = await loadProjectInstructionsForTargets(ctx.workspace, recent.map(([abs, snapshot]) => ({
    absPath: abs,
    label: snapshot.path,
  })), {
    includeWorkspaceRoot: false,
    targetLabel: '最近文件上下文',
  })
  const blocks: string[] = []

  for (const [abs, snapshot] of recent) {
    if (remaining <= 0) {
      blocks.push(`<file path="${xmlAttr(snapshot.path)}" skipped="total_limit" />`)
      continue
    }
    try {
      const info = await stat(abs)
      if (!info.isFile()) {
        blocks.push(`<file path="${xmlAttr(snapshot.path)}" skipped="not_a_file" />`)
        continue
      }
      const limit = Math.min(maxBytesPerFile, remaining)
      const { text, bytes } = await readUtf8Prefix(abs, limit)
      remaining -= bytes
      const changed = info.mtimeMs !== snapshot.mtimeMs || info.size !== snapshot.size
      blocks.push([
        `<file path="${xmlAttr(snapshot.path)}" bytes="${bytes}" size="${info.size}" truncated="${bytes < info.size}" changed_since_read="${changed}">`,
        xmlText(text),
        '</file>',
      ].join('\n'))
    } catch (error) {
      blocks.push(`<file path="${xmlAttr(snapshot.path)}" error="${xmlAttr(error instanceof Error ? error.message : String(error))}" />`)
    }
  }

  if (!blocks.length) return null
  return {
    role: 'user',
    content: [textBlock([
      '[压缩后恢复的最近文件上下文]',
      '下面是压缩前本轮最近读过/改过的文件快照。它们用于继续代码修改时保持上下文;若 changed_since_read=true,说明文件在上次读取后已经变化,应重新核对后再编辑。',
      instructions,
      `<recent_file_context count="${blocks.length}" max_files="${maxFiles}">`,
      blocks.join('\n'),
      '</recent_file_context>',
    ].filter(Boolean).join('\n'))],
  }
}

async function readUtf8Prefix(path: string, limit: number): Promise<{ text: string; bytes: number }> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead }
  } finally {
    await handle.close()
  }
}

function clampPositive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
