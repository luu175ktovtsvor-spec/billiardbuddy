import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { fileReadTool } from './fileReadTool'
import { fileHistoryTool, restoreFileTool } from './fileHistoryTool'
import { notebookEditTool } from './notebookEditTool'

function notebook(cells: unknown[]) {
  return {
    cells,
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
}

function codeCell(id: string, source: string, outputs: unknown[] = [{ output_type: 'stream', text: 'old' }]) {
  return {
    id,
    cell_type: 'code',
    source,
    metadata: {},
    execution_count: 12,
    outputs,
  }
}

function markdownCell(id: string, source: string) {
  return {
    id,
    cell_type: 'markdown',
    source,
    metadata: {},
  }
}

function ctx(root: string): ToolContext {
  return { workspace: new Workspace(root), conversationId: 'notebook-test' }
}

async function readFirst(context: ToolContext, path: string) {
  await fileReadTool.execute({ path }, context)
}

function load(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('NotebookEdit replaces a code cell, clears outputs, and records a file snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-edit-'))
  try {
    const path = join(root, 'analysis.ipynb')
    writeFileSync(path, JSON.stringify(notebook([codeCell('abc', 'print("old")')]), null, 1))
    const context = ctx(root)
    await readFirst(context, 'analysis.ipynb')

    const out = await notebookEditTool.execute({
      notebook_path: 'analysis.ipynb',
      cell_id: 'abc',
      new_source: 'print("new")',
    }, context)
    expect(out).toContain('<file_change path="analysis.ipynb"')
    expect(out).toContain('Updated code notebook cell abc')
    const updated = load(path)
    expect(updated.cells[0].source).toBe('print("new")')
    expect(updated.cells[0].execution_count).toBeNull()
    expect(updated.cells[0].outputs).toEqual([])
    expect(context.fileReads?.get(path)?.size).toBeGreaterThan(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NotebookEdit snapshots can be inspected and restored through file history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-edit-'))
  try {
    const path = join(root, 'analysis.ipynb')
    writeFileSync(path, JSON.stringify(notebook([codeCell('abc', 'print("old")')]), null, 1))
    const context = ctx(root)
    await readFirst(context, 'analysis.ipynb')

    await notebookEditTool.execute({
      notebook_path: 'analysis.ipynb',
      cell_id: 'abc',
      new_source: 'print("new")',
    }, context)
    const history = await fileHistoryTool.execute({ path: 'analysis.ipynb', include_diff: true }, context)
    expect(history).toContain('op:NotebookEdit')
    expect(history).toContain('snapshot_diff')

    await restoreFileTool.execute({ path: 'analysis.ipynb' }, context)
    const restored = load(path)
    expect(restored.cells[0].source).toBe('print("old")')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NotebookEdit inserts after a cell id and deletes by synthetic cell index', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-edit-'))
  try {
    const path = join(root, 'analysis.ipynb')
    writeFileSync(path, JSON.stringify(notebook([
      markdownCell('intro', '# Intro'),
      codeCell('calc', '1 + 1', []),
    ]), null, 1))
    const context = ctx(root)
    await readFirst(context, 'analysis.ipynb')

    await notebookEditTool.execute({
      notebook_path: 'analysis.ipynb',
      cell_id: 'intro',
      edit_mode: 'insert',
      cell_type: 'markdown',
      new_source: 'Inserted notes',
    }, context)
    let updated = load(path)
    expect(updated.cells.map((cell: any) => cell.source)).toEqual(['# Intro', 'Inserted notes', '1 + 1'])
    expect(updated.cells[1].cell_type).toBe('markdown')

    await notebookEditTool.execute({
      notebook_path: 'analysis.ipynb',
      cell_id: 'cell-1',
      edit_mode: 'delete',
      new_source: '',
    }, context)
    updated = load(path)
    expect(updated.cells.map((cell: any) => cell.source)).toEqual(['# Intro', '1 + 1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('NotebookEdit enforces read-before-edit, stale reads, and .ipynb extension', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-edit-'))
  try {
    const path = join(root, 'analysis.ipynb')
    writeFileSync(path, JSON.stringify(notebook([codeCell('abc', 'print("old")')]), null, 1))
    const context = ctx(root)

    await expect(notebookEditTool.execute({
      notebook_path: 'analysis.ipynb',
      cell_id: 'abc',
      new_source: 'print("new")',
    }, context)).rejects.toThrow('read_file')

    await readFirst(context, 'analysis.ipynb')
    writeFileSync(path, JSON.stringify(notebook([codeCell('abc', 'external')]), null, 1))
    await expect(notebookEditTool.execute({
      notebook_path: 'analysis.ipynb',
      cell_id: 'abc',
      new_source: 'print("new")',
    }, context)).rejects.toThrow('changed after read_file')

    writeFileSync(join(root, 'notes.txt'), 'not a notebook')
    const textContext = ctx(root)
    await fileReadTool.execute({ path: 'notes.txt' }, textContext)
    await expect(notebookEditTool.execute({
      notebook_path: 'notes.txt',
      cell_id: 'abc',
      new_source: 'x',
    }, textContext)).rejects.toThrow('.ipynb')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
