import { randomBytes } from 'node:crypto'
import { extname } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Tool, ToolContext } from './Tool'
import { fileHistoryBackupPath, recordFileSnapshot } from './fileHistory'

type NotebookEditMode = 'replace' | 'insert' | 'delete'
type NotebookCellType = 'code' | 'markdown'

interface NotebookEditInput {
  notebook_path?: string
  path?: string
  cell_id?: string
  cellId?: string
  new_source?: string
  newSource?: string
  cell_type?: NotebookCellType
  cellType?: NotebookCellType
  edit_mode?: NotebookEditMode
  editMode?: NotebookEditMode
}

interface NotebookCell {
  id?: string
  cell_type: NotebookCellType | string
  source: string | string[]
  metadata?: Record<string, unknown>
  execution_count?: number | null
  outputs?: unknown[]
  [key: string]: unknown
}

interface NotebookContent {
  cells: NotebookCell[]
  metadata?: {
    language_info?: { name?: string }
    [key: string]: unknown
  }
  nbformat?: number
  nbformat_minor?: number
  [key: string]: unknown
}

interface NormalizedNotebookEditInput {
  path: string
  cellId?: string
  newSource: string
  cellType?: NotebookCellType
  editMode: NotebookEditMode
}

interface CellTarget {
  index: number
  cell?: NotebookCell
}

export const notebookEditTool: Tool<NotebookEditInput> = {
  name: 'NotebookEdit',
  description:
    'Edit a Jupyter notebook (.ipynb) cell that was already read in this turn. Supports replace, insert, and delete. Input: { notebook_path, cell_id?, new_source, cell_type?, edit_mode? }.',
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Path to the .ipynb notebook. Absolute paths inside the workspace are accepted.' },
      path: { type: 'string', description: 'Alias for notebook_path.' },
      cell_id: { type: 'string', description: 'Notebook cell id or synthetic cell-N index. Required for replace/delete; optional for insert.' },
      new_source: { type: 'string', description: 'New source text for replace/insert. Ignored for delete.' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type. Required for insert; optional for replace.' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'replace, insert, or delete. Defaults to replace.' },
    },
    required: ['notebook_path', 'new_source'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    const args = normalizeInput(input)
    const abs = ctx.workspace.resolve(args.path, 'write')
    if (extname(abs) !== '.ipynb') throw new Error('NotebookEdit only edits .ipynb files')
    await assertFreshRead(abs, ctx)

    const original = await readFile(abs, 'utf8')
    const notebook = parseNotebook(original)
    const mode = args.editMode
    const target = resolveCellTarget(notebook, args.cellId, mode)
    const language = notebook.metadata?.language_info?.name ?? 'python'
    let editedCellId = args.cellId
    let editedCellType: NotebookCellType

    if (mode === 'delete') {
      const cell = target.cell
      if (!cell) throw new Error('NotebookEdit cell not found')
      editedCellType = normalizeCellType(cell.cell_type)
      editedCellId = cell.id ?? `cell-${target.index}`
      notebook.cells.splice(target.index, 1)
    } else if (mode === 'insert') {
      const cellType = args.cellType
      if (!cellType) throw new Error('NotebookEdit insert requires cell_type')
      editedCellType = cellType
      editedCellId = shouldEmitCellIds(notebook) ? newCellId() : undefined
      notebook.cells.splice(target.index, 0, createCell(cellType, args.newSource, editedCellId))
    } else {
      const cell = target.cell
      if (!cell) throw new Error('NotebookEdit cell not found')
      editedCellType = args.cellType ?? normalizeCellType(cell.cell_type)
      editedCellId = cell.id ?? `cell-${target.index}`
      cell.source = args.newSource
      cell.cell_type = editedCellType
      if (editedCellType === 'code') {
        cell.execution_count = null
        cell.outputs = []
      } else {
        delete cell.execution_count
        delete cell.outputs
      }
    }

    const updated = `${JSON.stringify(notebook, null, 1)}\n`
    if (updated === original) throw new Error('NotebookEdit did not change the notebook')
    const snapshot = await recordFileSnapshot(ctx, args.path, abs, 'NotebookEdit')
    const backupPath = fileHistoryBackupPath(ctx, snapshot)
    await ctx.workspace.backup(abs)
    await writeFile(abs, updated, 'utf8')
    const info = await stat(abs)
    recordRecentFileRead(ctx, abs, { path: args.path, mtimeMs: info.mtimeMs, size: info.size })

    return [
      fileChangeTag(args.path, snapshot.id, backupPath),
      `<notebook_edit path="${xmlAttr(args.path)}" mode="${mode}" cell_id="${xmlAttr(editedCellId ?? '')}" cell_type="${editedCellType}" language="${xmlAttr(language)}" />`,
      notebookEditSummary(mode, editedCellId, editedCellType, args.newSource),
    ].join('\n')
  },
}

function normalizeInput(input: NotebookEditInput | undefined): NormalizedNotebookEditInput {
  if (!input || typeof input !== 'object') throw new Error('NotebookEdit requires an object input')
  const path = typeof input.notebook_path === 'string' ? input.notebook_path : typeof input.path === 'string' ? input.path : ''
  if (!path.trim()) throw new Error('NotebookEdit requires notebook_path')
  const editMode = normalizeEditMode(input.edit_mode ?? input.editMode)
  const cellId = typeof input.cell_id === 'string' ? input.cell_id : typeof input.cellId === 'string' ? input.cellId : undefined
  const newSource = typeof input.new_source === 'string' ? input.new_source : typeof input.newSource === 'string' ? input.newSource : ''
  if (editMode !== 'delete' && typeof newSource !== 'string') throw new Error('NotebookEdit requires new_source')
  const cellType = normalizeOptionalCellType(input.cell_type ?? input.cellType)
  return {
    path: path.trim(),
    cellId: cellId?.trim() || undefined,
    newSource,
    cellType,
    editMode,
  }
}

function normalizeEditMode(value: unknown): NotebookEditMode {
  if (value === undefined || value === null || value === '') return 'replace'
  if (value === 'replace' || value === 'insert' || value === 'delete') return value
  throw new Error('NotebookEdit edit_mode must be replace, insert, or delete')
}

function normalizeOptionalCellType(value: unknown): NotebookCellType | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'code' || value === 'markdown') return value
  throw new Error('NotebookEdit cell_type must be code or markdown')
}

function normalizeCellType(value: unknown): NotebookCellType {
  return value === 'markdown' ? 'markdown' : 'code'
}

function parseNotebook(content: string): NotebookContent {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Notebook is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as NotebookContent).cells)) {
    throw new Error('Notebook JSON must contain a cells array')
  }
  return parsed as NotebookContent
}

function parseCellIndex(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/)
  if (!match?.[1]) return undefined
  const index = Number.parseInt(match[1], 10)
  return Number.isFinite(index) ? index : undefined
}

function resolveCellTarget(notebook: NotebookContent, cellId: string | undefined, mode: NotebookEditMode): CellTarget {
  if (!cellId) {
    if (mode === 'insert') return { index: 0 }
    throw new Error('NotebookEdit requires cell_id for replace/delete')
  }
  let index = notebook.cells.findIndex(cell => cell.id === cellId)
  if (index < 0) {
    const parsed = parseCellIndex(cellId)
    if (parsed !== undefined) index = parsed
  }
  if (index < 0 || index >= notebook.cells.length) throw new Error(`NotebookEdit cell not found: ${cellId}`)
  if (mode === 'insert') return { index: index + 1 }
  return { index, cell: notebook.cells[index] }
}

function shouldEmitCellIds(notebook: NotebookContent): boolean {
  const major = typeof notebook.nbformat === 'number' ? notebook.nbformat : 4
  const minor = typeof notebook.nbformat_minor === 'number' ? notebook.nbformat_minor : 0
  return major > 4 || (major === 4 && minor >= 5)
}

function newCellId(): string {
  return randomBytes(8).toString('hex')
}

function createCell(cellType: NotebookCellType, source: string, id: string | undefined): NotebookCell {
  if (cellType === 'markdown') {
    return { cell_type: 'markdown', ...(id ? { id } : {}), source, metadata: {} }
  }
  return {
    cell_type: 'code',
    ...(id ? { id } : {}),
    source,
    metadata: {},
    execution_count: null,
    outputs: [],
  }
}

async function assertFreshRead(abs: string, ctx: ToolContext): Promise<void> {
  const snapshot = ctx.fileReads?.get(abs)
  if (!snapshot) throw new Error('NotebookEdit refused to modify: read_file the notebook first')
  const info = await stat(abs)
  if (info.mtimeMs !== snapshot.mtimeMs || info.size !== snapshot.size) {
    throw new Error('NotebookEdit refused to modify: notebook changed after read_file')
  }
}

function recordRecentFileRead(ctx: ToolContext, abs: string, snapshot: { path: string; mtimeMs: number; size: number }): void {
  ctx.fileReads ??= new Map()
  ctx.fileReads.delete(abs)
  ctx.fileReads.set(abs, snapshot)
}

function notebookEditSummary(mode: NotebookEditMode, cellId: string | undefined, cellType: NotebookCellType, source: string): string {
  if (mode === 'delete') return `Deleted notebook cell ${cellId ?? '(new)'}`
  if (mode === 'insert') return `Inserted ${cellType} notebook cell ${cellId ?? '(new)'} with ${source.length} chars`
  return `Updated ${cellType} notebook cell ${cellId ?? '(unknown)'} with ${source.length} chars`
}

function fileChangeTag(path: string, snapshotId: string, backupPath?: string): string {
  const backup = backupPath ? ` backup_path="${xmlAttr(backupPath)}"` : ''
  return `<file_change path="${xmlAttr(path)}" snapshot_id="${xmlAttr(snapshotId)}"${backup} />`
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
