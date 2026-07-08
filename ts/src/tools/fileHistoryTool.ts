import type { Tool } from './Tool'
import { listFileHistory, previewRestore, restoreFileFromHistory } from './fileHistory'

function truthy(value: unknown): boolean {
  if (value === true) return true
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

function isDryRun(input: unknown): boolean {
  return !!input && typeof input === 'object' && truthy((input as { dry_run?: unknown }).dry_run)
}

export const fileHistoryTool: Tool<{ path?: string | string[]; paths?: string[]; limit?: number; include_diff?: boolean | string }> = {
  name: 'file_history',
  description: 'List recent file snapshots recorded before write_file/edit_file/edit_excel/NotebookEdit/restore_file changes in this conversation. Input: { path?, paths?, limit?, include_diff? }. path may be a string or string[].',
  inputSchema: {
    type: 'object',
    properties: {
      path: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      paths: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
      include_diff: { type: ['boolean', 'string'] },
    },
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const records = await listFileHistory(ctx, {
      path: typeof input?.path === 'string' || Array.isArray(input?.path) ? input.path : undefined,
      paths: Array.isArray(input?.paths) ? input.paths : undefined,
      limit: typeof input?.limit === 'number' ? input.limit : undefined,
    })
    if (records.length === 0) return '没有文件历史快照。'
    const includeDiff = truthy(input?.include_diff)
    const lines: string[] = []
    for (const record of records) {
      lines.push([
        `- id:${record.id}`,
        `path:${record.path}`,
        `op:${record.operation}`,
        `seq:${record.sequence ?? 1}`,
        record.previousId ? `prev:${record.previousId}` : '',
        `time:${record.ts}`,
        record.existed ? `size:${record.size ?? 0}` : 'before:missing',
        record.skippedReason ? `skipped:${record.skippedReason}` : '',
      ].filter(Boolean).join(' '))
      if (includeDiff && !record.skippedReason) {
        try {
          lines.push(`<snapshot_diff id="${record.id}" path="${record.path}">\n${await previewRestore(ctx, { path: record.path, snapshot_id: record.id })}\n</snapshot_diff>`)
        } catch (err) {
          lines.push(`<snapshot_diff_error id="${record.id}">${err instanceof Error ? err.message : String(err)}</snapshot_diff_error>`)
        }
      }
    }
    return lines.join('\n')
  },
}

export const restoreFileTool: Tool<{ path: string; snapshot_id?: string; dry_run?: boolean | string }> = {
  name: 'restore_file',
  description: 'Restore a file to a previous snapshot from file_history. Input: { path, snapshot_id?, dry_run? }. Omitting snapshot_id restores the latest snapshot for that path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      snapshot_id: { type: 'string' },
      dry_run: { type: ['boolean', 'string'] },
    },
    required: ['path'],
  },
  isReadOnly: false,
  isReadOnlyFor(input) {
    return isDryRun(input)
  },
  requiresApprovalFor(input) {
    return !isDryRun(input)
  },
  approvalClassFor(input) {
    return isDryRun(input) ? undefined : 'destructive'
  },
  forceConfirmFor(input) {
    return !isDryRun(input)
  },
  async previewFor(input, ctx) {
    if (!input || typeof input.path !== 'string') return null
    return await previewRestore(ctx, input)
  },
  async execute(input, ctx) {
    return await restoreFileFromHistory(ctx, input)
  },
}
