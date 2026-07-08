import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool, ToolContext } from './Tool'
import { fileHistoryBackupPath, recordFileSnapshot } from './fileHistory'
import { loadProjectInstructionsForTarget, projectInstructionScopeKey } from '../harness/projectInstructions'
import { resolveToolPath } from '../permissions/filePathRules'

export const fileWriteTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file inside the workspace (an existing file is backed up first). Input: { path, content }.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    if (!input || typeof input.path !== 'string' || typeof input.content !== 'string') {
      throw new Error('write_file 需要 string 参数 path 和 content')
    }
    const abs = resolveToolPath(ctx, 'write_file', input.path, 'write')
    await assertProjectInstructionsSeen(input.path, abs, ctx)
    await assertFreshOverwrite(input.path, abs, ctx)
    const snapshot = await recordFileSnapshot(ctx, input.path, abs, 'write_file')
    const backupPath = fileHistoryBackupPath(ctx, snapshot)
    await ctx.workspace.backup(abs) // 红线:改文件前自动备份
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')
    const info = await stat(abs)
    recordRecentFileWrite(ctx, abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })
    return [
      fileChangeTag(input.path, snapshot.id, backupPath),
      `已写入 ${input.path}（${input.content.length} 字符）`,
    ].join('\n')
  },
}

async function assertFreshOverwrite(path: string, abs: string, ctx: ToolContext): Promise<void> {
  const info = await stat(abs).catch(() => null)
  if (!info) return
  if (!info.isFile()) throw new Error(`write_file 拒绝覆盖:${path} 不是普通文件`)
  const snapshot = ctx.fileReads?.get(abs)
  if (!snapshot) throw new Error('write_file 拒绝覆盖:目标文件已存在,请先 read_file 读取该文件')
  if (info.mtimeMs !== snapshot.mtimeMs || info.size !== snapshot.size) {
    throw new Error('write_file 拒绝覆盖:文件在读取后已变化,请重新 read_file 后再写')
  }
}

async function assertProjectInstructionsSeen(path: string, abs: string, ctx: ToolContext): Promise<void> {
  const scope = projectInstructionScopeKey(ctx.workspace, abs)
  if (!scope || ctx.projectInstructionScopes?.has(scope)) return
  const instructions = await loadProjectInstructionsForTarget(ctx.workspace, abs, {
    targetLabel: path,
    includeWorkspaceRoot: false,
  })
  if (!instructions) return
  ctx.projectInstructionScopes ??= new Set()
  ctx.projectInstructionScopes.add(scope)
  throw new Error([
    'write_file 目标目录存在项目指令,本次写入已暂停。先按下面指令核对后,用相同 path/content 重试。',
    instructions,
  ].join('\n\n'))
}

function recordRecentFileWrite(ctx: ToolContext, abs: string, snapshot: { path: string; mtimeMs: number; size: number }): void {
  ctx.fileReads ??= new Map()
  ctx.fileReads.delete(abs)
  ctx.fileReads.set(abs, snapshot)
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
