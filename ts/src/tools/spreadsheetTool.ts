import { extname } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Tool, ToolContext } from './Tool'
import { fileHistoryBackupPath, recordFileSnapshot } from './fileHistory'
import { resolveToolPath } from '../permissions/filePathRules'
import { editCsvCell, editXlsxCell, isXlsxPath } from '../utils/officeDocuments'

export interface EditExcelInput {
  path: string
  cell?: string
  value?: string | number | boolean | null
  sheet?: string
  changes?: Array<{
    cell: string
    value: string | number | boolean | null
    sheet?: string
  }>
}

interface NormalizedChange {
  cell: string
  value: string
  sheet?: string
}

export const editExcelTool: Tool<EditExcelInput> = {
  name: 'edit_excel',
  description:
    'Edit cells in a CSV or XLSX spreadsheet inside the workspace. Use for reports, tables, and spreadsheet-like files. Input: { path, cell, value, sheet? } or { path, changes:[{ cell, value, sheet? }] }.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      cell: { type: 'string', description: 'A1 cell reference, e.g. B2.' },
      value: { type: ['string', 'number', 'boolean', 'null'] },
      sheet: { type: 'string', description: 'Optional worksheet name for xlsx.' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cell: { type: 'string' },
            value: { type: ['string', 'number', 'boolean', 'null'] },
            sheet: { type: 'string' },
          },
          required: ['cell', 'value'],
        },
      },
    },
    required: ['path'],
  },
  isReadOnly: false,
  requiresApproval: true,
  approvalClass: 'file',
  approvalReasonFor(input) {
    return {
      what: `编辑表格:${typeof input?.path === 'string' ? input.path : '(未指定)'}`,
      why: '该工具会修改 CSV/XLSX 表格内容。',
      impact: '确认后会写入目标表格;执行前会先尝试记录快照和备份。',
    }
  },
  async execute(input, ctx) {
    const changes = normalizeEditExcelInput(input)
    const abs = resolveToolPath(ctx, 'edit_excel', input.path, 'write')
    assertSupportedSpreadsheet(abs)

    const snapshot = await recordFileSnapshot(ctx, input.path, abs, 'edit_excel')
    const backupPath = fileHistoryBackupPath(ctx, snapshot)
    await ctx.workspace.backup(abs)

    const results = []
    for (const change of changes) {
      const result = isXlsxPath(abs)
        ? await editXlsxCell(abs, change.cell, change.value, change.sheet)
        : await editCsvCell(abs, change.cell, change.value)
      if (!result.ok) throw new Error(result.detail || `edit_excel 无法修改 ${change.cell}`)
      results.push(result)
    }

    const info = await stat(abs)
    ctx.fileReads ??= new Map()
    ctx.fileReads.delete(abs)
    ctx.fileReads.set(abs, { path: input.path, mtimeMs: info.mtimeMs, size: info.size })

    return [
      fileChangeTag(input.path, snapshot.id, backupPath),
      `已修改 ${input.path}:${results.length} 个单元格`,
      ...results.map(result => `${result.sheet}!${result.cell}: ${result.old || '(空)'} -> ${result.new}`),
    ].join('\n')
  },
}

function normalizeEditExcelInput(input: EditExcelInput): NormalizedChange[] {
  if (!input || typeof input !== 'object') throw new Error('edit_excel 需要对象参数')
  if (typeof input.path !== 'string' || !input.path.trim()) throw new Error('edit_excel 需要 string 参数 path')
  const rawChanges = Array.isArray(input.changes) && input.changes.length > 0
    ? input.changes
    : input.cell
      ? [{ cell: input.cell, value: input.value, sheet: input.sheet }]
      : []
  if (rawChanges.length === 0) throw new Error('edit_excel 需要 cell/value 或 changes')
  if (rawChanges.length > 100) throw new Error('edit_excel 一次最多修改 100 个单元格')
  return rawChanges.map((change, index) => {
    if (!change || typeof change !== 'object') throw new Error(`edit_excel 第 ${index + 1} 个 change 需要对象`)
    if (typeof change.cell !== 'string' || !change.cell.trim()) throw new Error(`edit_excel 第 ${index + 1} 个 change 需要 cell`)
    return {
      cell: change.cell,
      value: stringifyCellValue(change.value),
      sheet: typeof change.sheet === 'string' && change.sheet.trim() ? change.sheet : undefined,
    }
  })
}

function stringifyCellValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function assertSupportedSpreadsheet(path: string): void {
  const ext = extname(path).toLowerCase()
  if (ext !== '.csv' && ext !== '.xlsx') throw new Error('edit_excel 仅支持 csv/xlsx 文件')
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
