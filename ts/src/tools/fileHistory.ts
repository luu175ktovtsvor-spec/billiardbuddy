import { createHash, randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { structuredPatch } from 'diff'
import type { ToolContext } from './Tool'

export type FileHistoryOperation = 'write_file' | 'edit_file' | 'edit_excel' | 'multi_edit_file' | 'patch_file' | 'patch_files' | 'NotebookEdit' | 'restore_file'

export interface FileHistoryRecord {
  id: string
  ts: string
  conversationId: string
  path: string
  operation: FileHistoryOperation
  existed: boolean
  sequence?: number
  previousId?: string
  backupRel?: string
  size?: number
  sha256?: string
  skippedReason?: string
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
const HISTORY_DIR = '.agent-file-history'

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function shortHash(value: string): string {
  return hash(value).slice(0, 10)
}

function safeConversationId(value: string | undefined): string {
  const raw = value?.trim() || 'default'
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'default'
  return `${clean}-${shortHash(raw)}`
}

function historyRoot(ctx: ToolContext): string {
  return join(ctx.workspace.root, HISTORY_DIR, safeConversationId(ctx.conversationId))
}

function indexPath(ctx: ToolContext): string {
  return join(historyRoot(ctx), 'index.jsonl')
}

function relativePath(ctx: ToolContext, abs: string): string {
  return relative(ctx.workspace.root, abs) || '.'
}

function backupRel(recordId: string, filePath: string): string {
  return join('objects', `${recordId}-${shortHash(filePath)}.bak`)
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}

async function appendRecord(ctx: ToolContext, record: FileHistoryRecord): Promise<void> {
  await mkdir(dirname(indexPath(ctx)), { recursive: true })
  await appendFile(indexPath(ctx), `${JSON.stringify(record)}\n`, 'utf8')
}

export async function recordFileSnapshot(ctx: ToolContext, inputPath: string, absPath: string, operation: FileHistoryOperation): Promise<FileHistoryRecord> {
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const conversationId = ctx.conversationId ?? 'default'
  const path = relativePath(ctx, absPath)
  const previous = (await loadFileHistory(ctx).catch(() => []))
    .filter(record => record.path === path)
    .at(-1)
  const base: FileHistoryRecord = {
    id,
    ts: new Date().toISOString(),
    conversationId,
    path,
    operation,
    existed: false,
    sequence: (previous?.sequence ?? 0) + 1,
    previousId: previous?.id,
  }

  try {
    const info = await stat(absPath)
    if (!info.isFile()) {
      const record = { ...base, existed: true, skippedReason: 'not a regular file' }
      await appendRecord(ctx, record)
      return record
    }
    if (info.size > MAX_SNAPSHOT_BYTES) {
      const record = { ...base, existed: true, size: info.size, skippedReason: `file is larger than ${MAX_SNAPSHOT_BYTES} bytes` }
      await appendRecord(ctx, record)
      return record
    }
    const rel = backupRel(id, inputPath)
    const dest = join(historyRoot(ctx), rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(absPath, dest)
    const content = await readFile(absPath)
    const record = {
      ...base,
      existed: true,
      backupRel: rel,
      size: info.size,
      sha256: hash(content.toString('utf8')),
    }
    await appendRecord(ctx, record)
    return record
  } catch (err) {
    if (!isEnoent(err)) throw err
    await appendRecord(ctx, base)
    return base
  }
}

export async function loadFileHistory(ctx: ToolContext): Promise<FileHistoryRecord[]> {
  try {
    const raw = await readFile(indexPath(ctx), 'utf8')
    const out: FileHistoryRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as FileHistoryRecord
        if (parsed && typeof parsed.id === 'string' && typeof parsed.path === 'string') out.push(parsed)
      } catch {
        // 忽略坏行,保留其余历史。
      }
    }
    return out
  } catch (err) {
    if (isEnoent(err)) return []
    throw err
  }
}

export async function listFileHistory(ctx: ToolContext, opts: { path?: string | string[]; paths?: string[]; limit?: number } = {}): Promise<FileHistoryRecord[]> {
  const records = await loadFileHistory(ctx)
  const normalizedPaths = normalizePathFilters(ctx, opts)
  const filtered = normalizedPaths ? records.filter(record => normalizedPaths.has(record.path)) : records
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20))
  return filtered.slice(-limit).reverse()
}

function normalizePathFilters(ctx: ToolContext, opts: { path?: string | string[]; paths?: string[] }): Set<string> | undefined {
  const raw = [
    ...(Array.isArray(opts.path) ? opts.path : opts.path ? [opts.path] : []),
    ...(Array.isArray(opts.paths) ? opts.paths : []),
  ]
  const out = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue
    out.add(relativePath(ctx, ctx.workspace.resolve(item, 'read')))
  }
  return out.size > 0 ? out : undefined
}

function parseBool(value: unknown): boolean {
  if (value === true) return true
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function fileHistoryBackupPath(ctx: ToolContext, record: FileHistoryRecord): string | undefined {
  if (!record.backupRel) return undefined
  const root = historyRoot(ctx)
  const abs = resolve(root, record.backupRel)
  const resolvedRoot = resolve(root)
  if (abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}/`)) throw new Error('file history backup path escaped history root')
  return abs
}

async function readTextIfExists(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return ''
    throw err
  }
}

export async function previewRestore(ctx: ToolContext, input: { path: string; snapshot_id?: string }): Promise<string> {
  const abs = ctx.workspace.resolve(input.path, 'write')
  const record = await pickRestoreRecord(ctx, input)
  if (record.skippedReason) throw new Error(`restore_file 无法使用该快照:${record.skippedReason}`)
  const current = await readTextIfExists(abs)
  const backup = fileHistoryBackupPath(ctx, record)
  if (record.existed && !backup) throw new Error('restore_file 快照内容不存在,无法回滚')
  const target = record.existed ? await readTextIfExists(backup!) : ''
  const patch = structuredPatch(record.path, record.path, current, target, 'current', 'restore', { context: 3 })
  const hunks = patch.hunks.map(hunk => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ].join('\n'))
  return hunks.length > 0 ? hunks.join('\n') : '无文件差异'
}

export async function pickRestoreRecord(ctx: ToolContext, input: { path: string; snapshot_id?: string }): Promise<FileHistoryRecord> {
  if (!input || typeof input.path !== 'string' || !input.path.trim()) throw new Error('restore_file 需要 string 参数 path')
  const normalized = relativePath(ctx, ctx.workspace.resolve(input.path, 'write'))
  const records = (await loadFileHistory(ctx)).filter(record => record.path === normalized)
  const record = input.snapshot_id
    ? records.find(item => item.id === input.snapshot_id)
    : records.at(-1)
  if (!record) throw new Error(`restore_file 没有找到 ${input.path} 的历史快照`)
  return record
}

export async function restoreFileFromHistory(ctx: ToolContext, input: { path: string; snapshot_id?: string; dry_run?: boolean | string }): Promise<string> {
  const abs = ctx.workspace.resolve(input.path, 'write')
  const record = await pickRestoreRecord(ctx, input)
  const diff = await previewRestore(ctx, input)
  if (parseBool(input.dry_run)) {
    return `<restore_preview snapshot_id="${escapeAttr(record.id)}" path="${escapeAttr(record.path)}">\n${diff}\n</restore_preview>`
  }

  const currentSnapshot = await recordFileSnapshot(ctx, record.path, abs, 'restore_file')
  const currentBackupPath = fileHistoryBackupPath(ctx, currentSnapshot)
  if (record.existed) {
    const backup = fileHistoryBackupPath(ctx, record)
    if (!backup || !existsSync(backup)) throw new Error('restore_file 快照内容不存在,无法回滚')
    await mkdir(dirname(abs), { recursive: true })
    await copyFile(backup, abs)
    const info = await stat(abs)
    recordRecentFileSnapshot(ctx, abs, { path: record.path, mtimeMs: info.mtimeMs, size: info.size })
  } else {
    await rm(abs, { force: true })
    ctx.fileReads?.delete(abs)
  }
  const backupAttr = currentBackupPath ? ` backup_path="${escapeAttr(currentBackupPath)}"` : ''
  return `<restore_file snapshot_id="${escapeAttr(record.id)}" path="${escapeAttr(record.path)}"${backupAttr}>\n${diff}\n</restore_file>`
}

function recordRecentFileSnapshot(ctx: ToolContext, abs: string, snapshot: { path: string; mtimeMs: number; size: number }): void {
  ctx.fileReads ??= new Map()
  ctx.fileReads.delete(abs)
  ctx.fileReads.set(abs, snapshot)
}
