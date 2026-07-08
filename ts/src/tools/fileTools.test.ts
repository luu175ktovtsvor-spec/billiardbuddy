import { test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { PathValidationError } from '../workspace/pathValidation'
import type { ToolContext } from './Tool'
import { fileReadManyTool, fileReadTool } from './fileReadTool'
import { fileEditTool, fileMultiEditTool, filePatchManyTool, filePatchTool } from './fileEditTool'
import { fileWriteTool } from './fileWriteTool'
import { fileHistoryTool, restoreFileTool } from './fileHistoryTool'
import { listDirTool } from './listDirTool'
import { globFilesTool, grepFilesTool } from './searchTools'
import { notebookEditTool } from './notebookEditTool'
import { codeOutlineTool } from './codeOutlineTool'
import { projectDiagnosticsTool } from './projectDiagnosticsTool'
import { projectInstructionsTool } from './projectInstructionsTool'
import { editExcelTool } from './spreadsheetTool'
import { readXlsxSheet, renderMinimalXlsx } from '../server/services/officeDocuments'
import { resolvePermission } from '../permissions/resolve'
import { addAllowedToolsToContext } from '../commands/allowedTools'

let root: string
let ctx: ToolContext
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('read_file reads a file inside the workspace', async () => {
  writeFileSync(join(root, 'a.txt'), 'hello')
  expect(await fileReadTool.execute({ path: 'a.txt' }, ctx)).toBe('hello')
})

test('CC-style path-scoped allowedTools grant external file access per tool alias', async () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'file-rule-')))
  try {
    const externalFile = join(externalRoot, 'outside.txt')
    writeFileSync(externalFile, 'hello external')

    await expect(fileReadTool.execute({ path: externalFile }, ctx)).rejects.toThrow(/越界/)

    addAllowedToolsToContext(ctx, [`Read(${externalRoot}/**)`])
    expect(await fileReadTool.execute({ path: externalFile }, ctx)).toBe('hello external')
    const many = await fileReadManyTool.execute({ paths: [externalFile] }, ctx)
    expect(many).toContain('hello external')
    await expect(fileWriteTool.execute({ path: join(externalRoot, 'read-rule-write.txt'), content: 'no' }, ctx)).rejects.toThrow(/越界/)

    addAllowedToolsToContext(ctx, [`Write(${externalRoot}/**)`])
    await fileWriteTool.execute({ path: join(externalRoot, 'created.txt'), content: 'created' }, ctx)
    expect(readFileSync(join(externalRoot, 'created.txt'), 'utf8')).toBe('created')

    addAllowedToolsToContext(ctx, [`Edit(${externalRoot}/**)`])
    await fileEditTool.execute({ path: externalFile, old_string: 'hello', new_string: 'hi' }, ctx)
    expect(readFileSync(externalFile, 'utf8')).toBe('hi external')

    addAllowedToolsToContext(ctx, [`MultiEdit(${externalRoot}/**)`])
    await fileMultiEditTool.execute({
      path: externalFile,
      edits: [
        { old_string: 'hi', new_string: 'hello' },
        { old_string: 'external', new_string: 'outside' },
      ],
    }, ctx)
    expect(readFileSync(externalFile, 'utf8')).toBe('hello outside')

    await filePatchTool.execute({
      path: externalFile,
      patch: '@@ -1 +1 @@\n-hello outside\n+patched outside',
    }, ctx)
    expect(readFileSync(externalFile, 'utf8')).toBe('patched outside')

    const anotherFile = join(externalRoot, 'another.txt')
    writeFileSync(anotherFile, 'first\n')
    await fileReadManyTool.execute({ paths: [externalFile, anotherFile] }, ctx)
    await filePatchManyTool.execute({
      patches: [
        { path: externalFile, patch: '@@ -1 +1 @@\n-patched outside\n+patched again' },
        { path: anotherFile, patch: '@@ -1 +1 @@\n-first\n+second' },
      ],
    }, ctx)
    expect(readFileSync(externalFile, 'utf8')).toBe('patched again')
    expect(readFileSync(anotherFile, 'utf8')).toBe('second\n')

    const directPatchCtx: ToolContext = { workspace: ctx.workspace }
    const directPatchFile = join(externalRoot, 'direct-patch.txt')
    writeFileSync(directPatchFile, 'direct\n')
    addAllowedToolsToContext(directPatchCtx, [`Read(${externalRoot}/**)`, `patch_file(${externalRoot}/**)`])
    await fileReadTool.execute({ path: directPatchFile }, directPatchCtx)
    await filePatchTool.execute({
      path: directPatchFile,
      patch: '@@ -1 +1 @@\n-direct\n+direct patched',
    }, directPatchCtx)
    expect(readFileSync(directPatchFile, 'utf8')).toBe('direct patched\n')

    const notebookPath = join(externalRoot, 'analysis.ipynb')
    writeFileSync(notebookPath, JSON.stringify({
      cells: [{
        cell_type: 'code',
        execution_count: 1,
        id: 'cell-a',
        metadata: {},
        outputs: [],
        source: ['print("old")'],
      }],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 1))
    addAllowedToolsToContext(ctx, [`NotebookEdit(${externalRoot}/**)`])
    await fileReadTool.execute({ path: notebookPath }, ctx)
    await notebookEditTool.execute({ notebook_path: notebookPath, cell_id: 'cell-a', new_source: 'print("new")' }, ctx)
    expect(JSON.parse(readFileSync(notebookPath, 'utf8')).cells[0].source).toBe('print("new")')

    addAllowedToolsToContext(ctx, [`LS(${externalRoot}/**)`, `Glob(${externalRoot}/**)`, `Grep(${externalRoot}/**)`])
    expect(await listDirTool.execute({ path: externalRoot }, ctx)).toContain('outside.txt')
    expect(await globFilesTool.execute({ path: externalRoot, pattern: '*.txt' }, ctx)).toContain(externalFile)
    expect(await grepFilesTool.execute({ path: externalRoot, pattern: 'patched again' }, ctx)).toContain(`${externalFile}:1:patched again`)
  } finally {
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('read_file ignores PDF-only pages parameter for non-PDF files', async () => {
  writeFileSync(join(root, 'a.txt'), 'hello')
  expect(await fileReadTool.execute({ path: 'a.txt', pages: '0' }, ctx)).toBe('hello')
})

test('read_file can return a focused line range and still unlock safe edits', async () => {
  writeFileSync(join(root, 'a.txt'), [
    'one',
    'two',
    'three',
    'four',
    'five',
    '',
  ].join('\n'))

  const out = await fileReadTool.execute({ path: 'a.txt', start_line: 2, end_line: 4 }, ctx)
  expect(out).toContain('<file_chunk path="a.txt" start_line="2" end_line="4" total_lines="5"')
  expect(out).toContain('truncated_top="true"')
  expect(out).toContain('truncated_bottom="true"')
  expect(out).toContain('two\nthree\nfour\n')
  expect(out).not.toContain('one\n')
  expect(out).not.toContain('five\n')

  const edited = await fileEditTool.execute({
    path: 'a.txt',
    old_string: 'three',
    new_string: 'THREE',
  }, ctx)
  expect(edited).toContain('<file_change')
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toContain('THREE')
})

test('read_file focused reads cap line count and UTF-8 bytes explicitly', async () => {
  writeFileSync(join(root, 'long.txt'), Array.from({ length: 1205 }, (_, i) => `第${i + 1}行 abc`).join('\n'))

  const out = await fileReadTool.execute({ path: 'long.txt', start_line: 1, end_line: 1205, max_bytes: 80 }, ctx)
  expect(out).toContain('end_line="1000"')
  expect(out).toContain('truncated_bottom="true"')
  expect(out).toContain('truncated_bytes="true"')
  expect(out).toContain('truncated_range="true"')
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(700)
})

test('read_many_files batches code context with caps and records read snapshots', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(root, 'src', 'big.ts'), 'x'.repeat(40))

  const out = await fileReadManyTool.execute({
    paths: ['src/a.ts', 'src/b.ts', 'src/big.ts', 'missing.ts'],
    max_bytes_per_file: 12,
    max_total_bytes: 40,
  }, ctx)
  expect(out).toContain('<read_many_files count="4"')
  expect(out).toContain('<file path="src/a.ts" bytes="12" size="19" truncated="true">')
  expect(out).toContain('<file path="src/b.ts" bytes="12" size="19" truncated="true">')
  expect(out).toContain('<file path="src/big.ts" bytes="12" size="40" truncated="true">')
  expect(out).toContain('<file path="missing.ts" error=')
  expect(ctx.fileReads?.size).toBe(3)

  const capped = await fileReadManyTool.execute({
    paths: ['src/a.ts', 'src/b.ts', 'src/big.ts'],
    max_bytes_per_file: 20,
    max_total_bytes: 25,
  }, ctx)
  expect(capped).toContain('<read_many_files count="3" bytes="25" limit="25">')
  expect(capped).toContain('<file path="src/big.ts" skipped="total_limit" />')

  const edited = await fileEditTool.execute({
    path: 'src/a.ts',
    old_string: 'export const a = 1',
    new_string: 'export const a = 10',
  }, ctx)
  expect(edited).toContain('<file_change')
  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 10')
})

test('read_many_files accepts a single paths string', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'single.ts'), 'export const single = true\n')

  const out = await fileReadManyTool.execute({ paths: 'src/single.ts' }, ctx)

  expect(out).toContain('<read_many_files count="1"')
  expect(out).toContain('<file path="src/single.ts"')
  expect(out).toContain('export const single = true')
  expect(ctx.fileReads?.size).toBe(1)
})

test('read_many_files can batch focused line ranges after grep impact scans', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), [
    'const before = 1',
    'export function targetA() {',
    '  return before',
    '}',
    'const after = 2',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'b.ts'), [
    'const before = 1',
    'export function targetB() {',
    '  return before',
    '}',
    'const after = 2',
    '',
  ].join('\n'))

  const out = await fileReadManyTool.execute({
    ranges: [
      { path: 'src/a.ts', start_line: 2, end_line: 4 },
      { path: 'src/a.ts', start_line: 2, end_line: 4 },
      { path: 'src/b.ts', start_line: 2, end_line: 3 },
    ],
  }, ctx)
  expect(out).toContain('<read_many_files count="2" duplicates_omitted="1"')
  expect(out).toContain('<file_chunk path="src/a.ts" start_line="2" end_line="4"')
  expect(out).toContain('export function targetA()')
  expect(out).toContain('<file_chunk path="src/b.ts" start_line="2" end_line="3"')
  expect(out).toContain('export function targetB()')
  expect(out).not.toContain('const after = 2')
  expect(ctx.fileReads?.size).toBe(2)

  const edited = await fileEditTool.execute({
    path: 'src/a.ts',
    old_string: 'targetA',
    new_string: 'renamedA',
  }, ctx)
  expect(edited).toContain('<file_change')
  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('renamedA')
})

test('read_many_files accepts a single range object', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'one.ts'), [
    'line 1',
    'line 2',
    'line 3',
    '',
  ].join('\n'))

  const out = await fileReadManyTool.execute({
    ranges: { path: 'src/one.ts', start_line: 2, end_line: 2 },
  }, ctx)

  expect(out).toContain('<read_many_files count="1"')
  expect(out).toContain('<file_chunk path="src/one.ts" start_line="2" end_line="2"')
  expect(out).toContain('line 2')
  expect(out).not.toContain('line 1')
})

test('read_many_files merges overlapping focused ranges for the same file', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), [
    'line 1',
    'line 2',
    'line 3',
    'line 4',
    'line 5',
    'line 6',
    '',
  ].join('\n'))

  const out = await fileReadManyTool.execute({
    ranges: [
      { path: 'src/a.ts', start_line: 2, end_line: 4 },
      { path: 'src/a.ts', start_line: 4, end_line: 6 },
    ],
  }, ctx)

  expect(out).toContain('<read_many_files count="1" ranges_merged="1"')
  expect(out).toContain('<file_chunk path="src/a.ts" start_line="2" end_line="6"')
  expect(out.match(/<file_chunk path="src\/a\.ts"/g)).toHaveLength(1)
  expect(out).toContain('line 2')
  expect(out).toContain('line 6')
  expect(ctx.fileReads?.size).toBe(1)
})

test('read_file includes applicable directory project instructions before code content', async () => {
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })
  writeFileSync(join(root, 'packages', 'AGENTS.md'), 'Use package-local typecheck.')
  writeFileSync(join(root, 'packages', 'app', 'index.ts'), 'export const value = 1\n')

  const out = await fileReadTool.execute({ path: 'packages/app/index.ts' }, ctx)

  expect(out).toContain('# 项目指令')
  expect(out).toContain('<project_instruction file="packages/AGENTS.md" truncated="false">')
  expect(out).toContain('Use package-local typecheck.')
  expect(out).toContain('export const value = 1')

  const edited = await fileEditTool.execute({
    path: 'packages/app/index.ts',
    old_string: 'value = 1',
    new_string: 'value = 2',
  }, ctx)
  expect(edited).toContain('<file_change')
  expect(readFileSync(join(root, 'packages', 'app', 'index.ts'), 'utf8')).toContain('value = 2')
})

test('read_many_files includes shared directory project instructions once', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'AGENTS.md'), 'Use bun run typecheck for src changes.')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n')

  const out = await fileReadManyTool.execute({ paths: ['src/a.ts', 'src/b.ts'] }, ctx)
  expect(out).toContain('<project_instruction file="src/AGENTS.md" truncated="false">')
  expect(out.match(/Use bun run typecheck for src changes/g)?.length).toBe(1)
  expect(out).toContain('<read_many_files count="2"')
})

test('write_file creates a file and backs up an existing one on overwrite', async () => {
  const first = await fileWriteTool.execute({ path: 'note.txt', content: 'v1' }, ctx)
  expect(first).toContain('<file_change')
  expect(first).not.toContain('backup_path=')
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v1')
  expect(ctx.fileReads?.get(join(root, 'note.txt'))?.path).toBe('note.txt')
  const second = await fileWriteTool.execute({ path: 'note.txt', content: 'v2' }, ctx)
  expect(second).toContain('<file_change')
  expect(second).toContain('backup_path=')
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v2')
  expect(ctx.fileReads?.get(join(root, 'note.txt'))?.size).toBe(2)
  const backups = readdirSync(join(root, '.backups'))
  expect(backups.length).toBe(1) // 覆盖前备份了 v1
})

test('write_file requires a fresh read before overwriting an existing file', async () => {
  writeFileSync(join(root, 'existing.txt'), 'old')

  await expect(fileWriteTool.execute({ path: 'existing.txt', content: 'new' }, ctx)).rejects.toThrow(/先 read_file/)
  expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('old')

  await fileReadTool.execute({ path: 'existing.txt' }, ctx)
  const out = await fileWriteTool.execute({ path: 'existing.txt', content: 'new' }, ctx)
  expect(out).toContain('<file_change')
  expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('new')
})

test('write_file refuses stale reads before overwriting', async () => {
  writeFileSync(join(root, 'stale.txt'), 'old')
  await fileReadTool.execute({ path: 'stale.txt' }, ctx)
  writeFileSync(join(root, 'stale.txt'), 'changed elsewhere')

  await expect(fileWriteTool.execute({ path: 'stale.txt', content: 'new' }, ctx)).rejects.toThrow(/重新 read_file/)
  expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('changed elsewhere')
})

test('write_file pauses once when target directory has unseen project instructions', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'AGENTS.md'), 'New files must export named symbols.')

  let message = ''
  try {
    await fileWriteTool.execute({ path: 'src/new.ts', content: 'export const value = 1\n' }, ctx)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).toContain('write_file 目标目录存在项目指令')
  expect(message).toContain('<project_instruction file="src/AGENTS.md" truncated="false">')
  expect(message).toContain('New files must export named symbols.')
  expect(() => readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toThrow()

  const out = await fileWriteTool.execute({ path: 'src/new.ts', content: 'export const value = 1\n' }, ctx)
  expect(out).toContain('<file_change')
  expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toContain('value = 1')
})

test('list_project_instructions previews new-file directory rules and unlocks write_file for that scope', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'AGENTS.md'), 'New files must export named symbols.')

  const instructions = await projectInstructionsTool.execute({ path: 'src/new.ts' }, ctx)
  expect(instructions).toContain('# 项目指令')
  expect(instructions).toContain('<project_instruction file="src/AGENTS.md" truncated="false">')
  expect(instructions).toContain('New files must export named symbols.')
  expect(ctx.projectInstructionScopes?.has('src')).toBe(true)

  const written = await fileWriteTool.execute({ path: 'src/new.ts', content: 'export const value = 1\n' }, ctx)
  expect(written).toContain('已写入 src/new.ts')
  expect(readFileSync(join(root, 'src', 'new.ts'), 'utf8')).toContain('value = 1')
})

test('list_project_instructions can include root instructions when requested', async () => {
  writeFileSync(join(root, 'AGENTS.md'), 'Root rule')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'AGENTS.md'), 'Src rule')

  const instructions = await projectInstructionsTool.execute({ path: 'src/new.ts', include_workspace_root: true }, ctx)
  expect(instructions.indexOf('file="AGENTS.md"')).toBeLessThan(instructions.indexOf('file="src/AGENTS.md"'))
  expect(instructions).toContain('Root rule')
  expect(instructions).toContain('Src rule')
})

test('file_history records write snapshots and restore_file restores the latest snapshot', async () => {
  ctx.conversationId = 'file-history-write'
  await fileWriteTool.execute({ path: 'note.txt', content: 'v1\n' }, ctx)
  await fileWriteTool.execute({ path: 'note.txt', content: 'v2\n' }, ctx)

  const history = await fileHistoryTool.execute({ path: 'note.txt' }, ctx)
  expect(history).toContain('op:write_file')
  expect(history).toContain('seq:2')
  expect(history).toContain('prev:')
  expect(history).toContain('size:3')

  const historyWithDiff = await fileHistoryTool.execute({ path: 'note.txt', limit: 1, include_diff: true }, ctx)
  expect(historyWithDiff).toContain('<snapshot_diff')
  expect(historyWithDiff).toContain('-v2')
  expect(historyWithDiff).toContain('+v1')

  const preview = await restoreFileTool.execute({ path: 'note.txt', dry_run: true }, ctx)
  expect(preview).toContain('<restore_preview')
  expect(preview).toContain('-v2')
  expect(preview).toContain('+v1')
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v2\n')

  const restored = await restoreFileTool.execute({ path: 'note.txt' }, ctx)
  expect(restored).toContain('<restore_file')
  expect(restored).toContain('backup_path=')
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v1\n')
  expect(ctx.fileReads?.get(join(root, 'note.txt'))?.size).toBe(3)
})

test('edit_excel updates csv cells and records file history', async () => {
  ctx.conversationId = 'spreadsheet-csv'
  writeFileSync(join(root, 'sheet.csv'), '姓名,分数\n小王,8')

  const out = await editExcelTool.execute({ path: 'sheet.csv', cell: 'B2', value: 9 }, ctx)

  expect(out).toContain('<file_change')
  expect(out).toContain('Sheet1!B2: 8 -> 9')
  expect(readFileSync(join(root, 'sheet.csv'), 'utf8')).toBe('姓名,分数\n小王,9')
  expect(ctx.fileReads?.get(join(root, 'sheet.csv'))?.path).toBe('sheet.csv')
  const history = await fileHistoryTool.execute({ path: 'sheet.csv' }, ctx)
  expect(history).toContain('op:edit_excel')
})

test('edit_excel updates xlsx cells and supports changes array', async () => {
  ctx.conversationId = 'spreadsheet-xlsx'
  const xlsxPath = join(root, 'score.xlsx')
  writeFileSync(xlsxPath, Buffer.from(renderMinimalXlsx('姓名,分数\n小王,8')))

  const out = await editExcelTool.execute({
    path: 'score.xlsx',
    changes: [
      { cell: 'B2', value: 9 },
      { cell: 'C2', value: '已复核' },
    ],
  }, ctx)

  expect(out).toContain('Sheet1!B2: 8 -> 9')
  expect(out).toContain('Sheet1!C2: (空) -> 已复核')
  const sheet = await readXlsxSheet(xlsxPath)
  const firstSheet = sheet.sheets[0]
  expect(firstSheet).toBeDefined()
  expect(firstSheet!.rows[1]).toEqual(['小王', '9', '已复核'])
  const history = await fileHistoryTool.execute({ path: 'score.xlsx' }, ctx)
  expect(history).toContain('op:edit_excel')
})

test('restore_file can revert a file creation snapshot by deleting the file', async () => {
  ctx.conversationId = 'file-history-delete'
  await fileWriteTool.execute({ path: 'new.txt', content: 'created' }, ctx)
  expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('created')

  await restoreFileTool.execute({ path: 'new.txt' }, ctx)
  expect(() => readFileSync(join(root, 'new.txt'), 'utf8')).toThrow()
  expect(ctx.fileReads?.has(join(root, 'new.txt'))).toBe(false)
})

test('restore_file dry_run is read-only but real restore still force-confirms', () => {
  expect(resolvePermission(restoreFileTool, { path: 'note.txt', dry_run: true }, { ...ctx, permissionMode: 'plan' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(restoreFileTool, { path: 'note.txt', dry_run: 'true' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(restoreFileTool, { path: 'note.txt' }, { ...ctx, permissionMode: 'full' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
    reason: { type: 'forceConfirm' },
  })
})

test('edit_file requires a prior fresh read before modifying', async () => {
  writeFileSync(join(root, 'note.txt'), 'hello world')
  await expect(fileEditTool.execute({
    path: 'note.txt',
    old_string: 'world',
    new_string: 'agent',
  }, ctx)).rejects.toThrow(/先 read_file/)

  await fileReadTool.execute({ path: 'note.txt' }, ctx)
  const out = await fileEditTool.execute({
    path: 'note.txt',
    old_string: 'world',
    new_string: 'agent',
  }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hello agent')
  expect(out).toContain('<file_change')
  expect(out).toContain('backup_path=')
  expect(out).toContain('<edit_context>')
  expect(readdirSync(join(root, '.backups')).length).toBe(1)
})

test('edit_file snapshots previous content so restore_file can roll back', async () => {
  ctx.conversationId = 'file-history-edit'
  writeFileSync(join(root, 'copy.txt'), 'before')
  await fileReadTool.execute({ path: 'copy.txt' }, ctx)
  await fileEditTool.execute({
    path: 'copy.txt',
    old_string: 'before',
    new_string: 'after',
  }, ctx)
  expect(readFileSync(join(root, 'copy.txt'), 'utf8')).toBe('after')

  await restoreFileTool.execute({ path: 'copy.txt' }, ctx)
  expect(readFileSync(join(root, 'copy.txt'), 'utf8')).toBe('before')
})

test('edit_file refuses stale reads when the file changed outside the tool', async () => {
  writeFileSync(join(root, 'note.txt'), 'v1')
  await fileReadTool.execute({ path: 'note.txt' }, ctx)
  writeFileSync(join(root, 'note.txt'), 'v2')
  await expect(fileEditTool.execute({
    path: 'note.txt',
    old_string: 'v2',
    new_string: 'v3',
  }, ctx)).rejects.toThrow(/已变化/)
})

test('edit_file enforces unique replacement unless replace_all is true', async () => {
  writeFileSync(join(root, 'note.txt'), 'foo\nfoo\nbar')
  await fileReadTool.execute({ path: 'note.txt' }, ctx)
  await expect(fileEditTool.execute({
    path: 'note.txt',
    old_string: 'foo',
    new_string: 'baz',
  }, ctx)).rejects.toThrow(/2 处匹配/)

  const out = await fileEditTool.execute({
    path: 'note.txt',
    old_string: 'foo',
    new_string: 'baz',
    replace_all: 'true',
  }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('baz\nbaz\nbar')
  expect(out).toContain('2 处')
})

test('edit_file matches Chinese punctuation and quotes by normalization', async () => {
  writeFileSync(join(root, 'copy.txt'), '标题：“会员充值，送球时。”')
  await fileReadTool.execute({ path: 'copy.txt' }, ctx)
  const out = await fileEditTool.execute({
    path: 'copy.txt',
    old_string: '标题:"会员充值,送球时."',
    new_string: '标题：“会员充值，送练球券。”',
  }, ctx)
  expect(readFileSync(join(root, 'copy.txt'), 'utf8')).toBe('标题：“会员充值，送练球券。”')
  expect(out).toContain('归一化匹配')
})

test('multi_edit_file applies several edits with one snapshot and can roll back', async () => {
  ctx.conversationId = 'multi-edit'
  writeFileSync(join(root, 'app.ts'), [
    'const name = "old"',
    'const count = 1',
    'console.log(name, count)',
    '',
  ].join('\n'))
  await fileReadTool.execute({ path: 'app.ts' }, ctx)
  const out = await fileMultiEditTool.execute({
    path: 'app.ts',
    edits: [
      { old_string: 'const name = "old"', new_string: 'const name = "new"' },
      { old_string: 'const count = 1', new_string: 'const count = 2' },
    ],
  }, ctx)
  expect(out).toContain('<file_change')
  expect(out).toContain('已批量编辑 app.ts:2 个 edit,2 处替换')
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toContain('const name = "new"')
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toContain('const count = 2')

  const history = await fileHistoryTool.execute({ path: 'app.ts' }, ctx)
  expect(history).toContain('op:multi_edit_file')
  await restoreFileTool.execute({ path: 'app.ts' }, ctx)
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toContain('const name = "old"')
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toContain('const count = 1')
})

test('multi_edit_file is atomic when a later edit fails', async () => {
  writeFileSync(join(root, 'app.ts'), 'alpha\nbeta\n')
  await fileReadTool.execute({ path: 'app.ts' }, ctx)
  await expect(fileMultiEditTool.execute({
    path: 'app.ts',
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'missing', new_string: 'MISSING' },
    ],
  }, ctx)).rejects.toThrow(/第 2 个 edit 未找到/)
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('alpha\nbeta\n')
  await expect(fileHistoryTool.execute({ path: 'app.ts' }, ctx)).resolves.toContain('没有文件历史')
})

test('patch_file applies a unified diff with one snapshot and can roll back', async () => {
  ctx.conversationId = 'patch-edit'
  writeFileSync(join(root, 'app.ts'), [
    'const a = 1',
    'const b = 2',
    'console.log(a + b)',
    '',
  ].join('\n'))
  await fileReadTool.execute({ path: 'app.ts' }, ctx)
  const out = await filePatchTool.execute({
    path: 'app.ts',
    patch: [
      '--- a/app.ts',
      '+++ b/app.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '-const b = 2',
      '-console.log(a + b)',
      '+const b = 3',
      '+const c = a + b',
      '+console.log(c)',
      '',
    ].join('\n'),
  }, ctx)

  expect(out).toContain('<file_change')
  expect(out).toContain('已应用 patch app.ts:1 个 hunk,+3/-2')
  expect(out).toContain('<patch_context')
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe([
    'const a = 1',
    'const b = 3',
    'const c = a + b',
    'console.log(c)',
    '',
  ].join('\n'))
  const history = await fileHistoryTool.execute({ path: 'app.ts' }, ctx)
  expect(history).toContain('op:patch_file')
  await restoreFileTool.execute({ path: 'app.ts' }, ctx)
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toContain('console.log(a + b)')
})

test('patch_files applies multi-file unified diffs atomically and records snapshots', async () => {
  ctx.conversationId = 'patch-many'
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n')
  await fileReadManyTool.execute({ paths: ['src/a.ts', 'src/b.ts'] }, ctx)

  const out = await filePatchManyTool.execute({
    patches: [
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-export const a = 1\n+export const a = 10' },
      { path: 'src/b.ts', patch: '@@ -1 +1 @@\n-export const b = 2\n+export const b = 20' },
    ],
  }, ctx)

  expect(out).toContain('<file_changes count="2">')
  expect(out.match(/<file_change path=/g)?.length).toBe(2)
  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 10\n')
  expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 20\n')
  const history = await fileHistoryTool.execute({ path: 'src/a.ts' }, ctx)
  expect(history).toContain('op:patch_files')
  const multiHistory = await fileHistoryTool.execute({ paths: ['src/a.ts', 'src/b.ts'] }, ctx)
  expect(multiHistory).toContain('path:src/a.ts')
  expect(multiHistory).toContain('path:src/b.ts')
  const pathArrayHistory = await fileHistoryTool.execute({ path: ['src/a.ts', 'src/b.ts'] }, ctx)
  expect(pathArrayHistory).toContain('path:src/a.ts')
  expect(pathArrayHistory).toContain('path:src/b.ts')
  await restoreFileTool.execute({ path: 'src/a.ts' }, ctx)
  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

test('patch_files validates every file before writing any file', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n')
  await fileReadManyTool.execute({ paths: ['src/a.ts', 'src/b.ts'] }, ctx)

  await expect(filePatchManyTool.execute({
    patches: [
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-export const a = 1\n+export const a = 10' },
      { path: 'src/b.ts', patch: '@@ -1 +1 @@\n-export const missing = 2\n+export const b = 20' },
    ],
  }, ctx)).rejects.toThrow(/上下文不匹配/)

  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 2\n')
})

test('patch_files rejects duplicate resolved paths before writing', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await fileReadManyTool.execute({ paths: ['src/a.ts'] }, ctx)

  await expect(filePatchManyTool.execute({
    patches: [
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-export const a = 1\n+export const a = 10' },
      { path: 'src/../src/a.ts', patch: '@@ -1 +1 @@\n-export const a = 1\n+export const a = 20' },
    ],
  }, ctx)).rejects.toThrow(/重复路径/)

  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

test('patch_file is atomic when context does not match', async () => {
  writeFileSync(join(root, 'app.ts'), 'alpha\nbeta\n')
  await fileReadTool.execute({ path: 'app.ts' }, ctx)
  let message = ''
  try {
    await filePatchTool.execute({
      path: 'app.ts',
      patch: [
        '@@ -1,2 +1,2 @@',
        ' alpha',
        '-missing',
        '+MISSING',
        '',
      ].join('\n'),
    }, ctx)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).toContain('上下文不匹配')
  expect(message).toContain('请重新 read_file { "start_line": 1, "end_line": 2 }')
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('alpha\nbeta\n')
  await expect(fileHistoryTool.execute({ path: 'app.ts' }, ctx)).resolves.toContain('没有文件历史')
})

test('patch_file mismatch diagnostics point to exact candidate lines elsewhere', async () => {
  writeFileSync(join(root, 'app.ts'), 'alpha\nbeta\nmiddle\nbeta\n')
  await fileReadTool.execute({ path: 'app.ts' }, ctx)

  let message = ''
  try {
    await filePatchTool.execute({
      path: 'app.ts',
      patch: [
        '@@ -1,1 +1,1 @@',
        '-beta',
        '+BETA',
        '',
      ].join('\n'),
    }, ctx)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }

  expect(message).toContain('上下文不匹配')
  expect(message).toContain('期望行在文件其他位置:第 2 行,第 4 行')
  expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('alpha\nbeta\nmiddle\nbeta\n')
})

test('list_dir lists the workspace root by default', async () => {
  writeFileSync(join(root, 'a.txt'), '')
  writeFileSync(join(root, 'b.txt'), '')
  const out = await listDirTool.execute({}, ctx)
  expect(out.split('\n')).toEqual(['a.txt', 'b.txt'])
})

test('list_dir caps large directories with a clear truncation note', async () => {
  writeFileSync(join(root, 'a.txt'), '')
  writeFileSync(join(root, 'b.txt'), '')
  writeFileSync(join(root, 'c.txt'), '')
  const out = await listDirTool.execute({ limit: 2 }, ctx)
  expect(out.split('\n')).toEqual([
    'a.txt',
    'b.txt',
    '…[已截断:目录共有 3 项,只显示前 2 项;请传更具体 path 或提高 limit]',
  ])
})

test('list_dir can return a bounded recursive project tree and skip heavy directories', async () => {
  mkdirSync(join(root, 'src', 'lib'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = true\n')
  writeFileSync(join(root, 'src', 'lib', 'util.ts'), 'export const util = true\n')
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '')

  const out = await listDirTool.execute({ recursive: true, max_depth: 3 }, ctx)
  expect(out.split('\n')).toEqual([
    'node_modules/ [skipped]',
    'package.json',
    'src/',
    'src/app.ts',
    'src/lib/',
    'src/lib/util.ts',
  ])

  const shallow = await listDirTool.execute({ recursive: true, max_depth: 1 }, ctx)
  expect(shallow).toContain('src/')
  expect(shallow).not.toContain('src/app.ts')
})

test('list_dir recursive tree is bounded by the total entry limit', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), '')
  writeFileSync(join(root, 'src', 'b.ts'), '')
  writeFileSync(join(root, 'src', 'c.ts'), '')

  const out = await listDirTool.execute({ recursive: true, max_depth: 2, limit: 2 }, ctx)
  expect(out.split('\n')).toEqual([
    'src/',
    'src/a.ts',
    '…[已截断:目录树超过 2 项,已省略 2 项;请传更具体 path、降低 max_depth 或提高 limit]',
  ])
})

test('glob_files finds files by pattern and skips heavy/sensitive directories', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'src', 'agent.ts'), 'export const agent = true')
  writeFileSync(join(root, 'src', 'agent.test.ts'), 'test("agent", () => {})')
  writeFileSync(join(root, 'node_modules', 'pkg', 'hidden.ts'), 'ignore')
  writeFileSync(join(root, '.env'), 'API_KEY=secret')

  const out = await globFilesTool.execute({ pattern: '**/*.ts' }, ctx)
  expect(out.split('\n')).toEqual(['src/agent.test.ts', 'src/agent.ts'])
})

test('glob_files reports truncation when the result limit is reached', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), '')
  writeFileSync(join(root, 'src', 'b.ts'), '')
  writeFileSync(join(root, 'src', 'c.ts'), '')
  const out = await globFilesTool.execute({ pattern: 'src/*.ts', limit: 2 }, ctx)
  const lines = out.split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toMatch(/^src\/[abc]\.ts$/)
  expect(lines[1]).toMatch(/^src\/[abc]\.ts$/)
  expect(lines[0]).not.toBe(lines[1])
  expect(lines[2]).toBe('…[已截断:匹配文件超过 2 个,请缩小 pattern/path 或提高 limit]')
})

test('grep_files searches code with regex, context and sensitive-file redaction', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'agent.ts'), [
    'const first = 1',
    'export function runAgent() {',
    '  return first',
    '}',
  ].join('\n'))
  writeFileSync(join(root, '.env'), 'RUN_AGENT_SECRET=leak')

  const out = await grepFilesTool.execute({ pattern: 'runAgent', include: '**/*.ts', context: 1 }, ctx)
  expect(out).toContain('src/agent.ts-1:const first = 1')
  expect(out).toContain('src/agent.ts:2:export function runAgent() {')
  expect(out).toContain('src/agent.ts-3:  return first')
  expect(out).not.toContain('RUN_AGENT_SECRET')
})

test('grep_files can search literal text that contains regex metacharacters', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'agent.ts'), [
    'const exact = "foo.bar"',
    'const regexWouldAlsoMatch = "fooXbar"',
    '',
  ].join('\n'))

  const out = await grepFilesTool.execute({ pattern: 'foo.bar', include: '**/*.ts', literal: true }, ctx)
  expect(out).toContain('src/agent.ts:1:const exact = "foo.bar"')
  expect(out).not.toContain('fooXbar')
})

test('grep_files can search an explicit file path scope', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'const needle = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'const needle = 2\n')

  const out = await grepFilesTool.execute({ pattern: 'needle', path: 'src/a.ts' }, ctx)

  expect(out).toContain('src/a.ts:1:const needle = 1')
  expect(out).not.toContain('src/b.ts')
})

test('grep_files can search multiple file and directory scopes', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'const shared = 1\n')
  writeFileSync(join(root, 'src', 'skip.ts'), 'const shared = 2\n')
  writeFileSync(join(root, 'packages', 'app', 'b.ts'), 'const shared = 3\n')

  const out = await grepFilesTool.execute({
    pattern: 'shared',
    path: ['src/a.ts'],
    paths: ['packages/app'],
    include: '**/*.ts',
    files_only: true,
  }, ctx)

  expect(out.split('\n')).toEqual(['packages/app/b.ts', 'src/a.ts'])
})

test('grep_files can return matching files only for low-context impact scans', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const shared = 1\nexport const again = shared\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export function useShared() { return "shared" }\n')
  writeFileSync(join(root, 'src', 'c.ts'), 'export const other = 3\n')

  const out = await grepFilesTool.execute({ pattern: 'shared', include: 'src/*.ts', files_only: true }, ctx)
  expect(out.split('\n')).toEqual(['src/a.ts', 'src/b.ts'])
  expect(out).not.toContain(':1:')
  expect(out).not.toContain('again')

  const limited = await grepFilesTool.execute({ pattern: 'shared', include: 'src/*.ts', files_only: true, limit: 1 }, ctx)
  expect(limited.split('\n')).toEqual([
    'src/a.ts',
    '…[已截断:匹配文件达到 limit=1;请缩小 pattern/path/include]',
  ])
})

test('grep_files can return read_many_files-ready ranges for focused code windows', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), [
    'line 1',
    'line 2',
    'function target() {',
    '  return targetHelper()',
    '}',
    'line 6',
    'line 7',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'b.ts'), [
    'before',
    'const targetValue = 1',
    'after',
    '',
  ].join('\n'))

  const out = await grepFilesTool.execute({
    pattern: 'target',
    include: 'src/*.ts',
    ranges: true,
    range_context: 1,
  }, ctx)
  expect(out).toContain('<grep_ranges matches="3" ranges="2" range_context="1">')
  expect(out).toContain('<read_many_files_input>')
  expect(out).toContain('"path": "src/a.ts"')
  expect(out).toContain('"start_line": 2')
  expect(out).toContain('"end_line": 5')
  expect(out).toContain('"path": "src/b.ts"')
  expect(out).toContain('"start_line": 1')
  expect(out).toContain('"end_line": 3')
  expect(out).toContain('src/a.ts:3')
  expect(out).toContain('src/a.ts:4')
  expect(out).not.toContain('function target()')

  const readInput = JSON.parse(out.match(/<read_many_files_input>\n([\s\S]*?)\n<\/read_many_files_input>/)?.[1] || '{}')
  const readOut = await fileReadManyTool.execute(readInput, ctx)
  expect(readOut).toContain('<read_many_files count="2"')
  expect(readOut).toContain('function target()')
  expect(readOut).toContain('const targetValue = 1')
})

test('grep_files caps long lines and reports match truncation', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), `const match = "${'x'.repeat(2100)}"\n`)
  writeFileSync(join(root, 'src', 'b.ts'), 'const match = "second"\n')
  const out = await grepFilesTool.execute({ pattern: 'match', include: 'src/*.ts', limit: 1 }, ctx)
  expect(out).toContain('src/a.ts:1:const match = "')
  expect(out).toContain('本行过长,已截断')
  expect(out).toContain('…[已截断:匹配行达到 limit=1;请缩小 pattern/path/include]')
  expect(out).not.toContain('second')
})

test('code_outline summarizes imports and major symbols without recording editable reads', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), [
    "import { helper } from './helper'",
    'export interface Config {',
    '  enabled: boolean',
    '}',
    'export class Runner {',
    '  run() {',
    '    return helper()',
    '  }',
    '}',
    'export async function main() {',
    '  return new Runner().run()',
    '}',
    'const localValue = 1',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'worker.py'), [
    'import os',
    'class Worker:',
    '    def run(self):',
    '        return os.getcwd()',
    '',
  ].join('\n'))

  const out = await codeOutlineTool.execute({ paths: ['src/app.ts', 'src/worker.py'] }, ctx)
  expect(out).toContain('<code_outline files="2">')
  expect(out).toContain('1: import { helper } from')
  expect(out).toContain('2:interface:Config:export')
  expect(out).toContain('5:class:Runner:export')
  expect(out).toContain('6:method:run')
  expect(out).toContain('10:function:main:export')
  expect(out).toContain('13:var:localValue')
  expect(out).toContain('2:py-class:Worker')
  expect(out).toContain('3:py-def-nested:run')
  expect(ctx.fileReads?.size ?? 0).toBe(0)
})

test('code_outline can emit read_many_files-ready symbol ranges without unlocking edits', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), [
    "import { helper } from './helper'",
    'export class Runner {',
    '  run() {',
    '    return helper()',
    '  }',
    '}',
    'export function main() {',
    '  return new Runner().run()',
    '}',
    '',
  ].join('\n'))

  const out = await codeOutlineTool.execute({
    path: 'src/app.ts',
    ranges: true,
    range_context: 1,
  }, ctx)
  expect(out).toContain('<code_outline files="1" range_context="1">')
  expect(out).toContain('<read_many_files_input>')
  expect(out).toContain('"path": "src/app.ts"')
  expect(out).toContain('"start_line": 1')
  expect(out).toContain('"end_line": 4')
  expect(out).toContain('"start_line": 6')
  expect(out).toContain('"end_line": 8')
  expect(out).toContain('<symbol_lines>')
  expect(out).toContain('src/app.ts:2:Runner')
  expect(ctx.fileReads?.size ?? 0).toBe(0)

  const readInput = JSON.parse(out.match(/<read_many_files_input>\n([\s\S]*?)\n<\/read_many_files_input>/)?.[1] || '{}')
  const readOut = await fileReadManyTool.execute(readInput, ctx)
  expect(readOut).toContain('<read_many_files count="2"')
  expect(readOut).toContain('export class Runner')
  expect(readOut).toContain('export function main()')
  expect(ctx.fileReads?.size).toBe(1)
})

test('code_outline caps files and symbols with clear metadata', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'many.ts'), [
    "import x from 'x'",
    'export const first = 1',
    'export const second = 2',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'extra.ts'), 'export const extra = 1\n')
  const out = await codeOutlineTool.execute({
    paths: ['src/many.ts', 'src/extra.ts', ...Array.from({ length: 25 }, (_, i) => `missing-${i}.ts`)],
    max_symbols_per_file: 1,
    include_imports: false,
  }, ctx)
  expect(out).toContain('<code_outline files="20" omitted="7">')
  expect(out).toContain('<imports skipped="true" />')
  expect(out).toContain('<symbols count="1" truncated="true">')
  expect(out).toContain('2:var:first:export')
})

test('project_diagnostics auto runs the nearest safe typecheck script with bounded output', async () => {
  mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true })
  writeFileSync(join(root, 'packages', 'app', 'bun.lock'), '')
  writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo diagnostic-ok',
      test: 'echo test-ok',
    },
  }))
  writeFileSync(join(root, 'packages', 'app', 'src', 'index.ts'), 'export const ok = true\n')

  const out = await projectDiagnosticsTool.execute({ path: 'packages/app/src/index.ts', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('package="packages/app/package.json"')
  expect(out).toContain('check="typecheck"')
  expect(out).toContain('script="typecheck"')
  expect(out).toContain('manager="bun"')
  expect(out).toContain('exit_code="0"')
  expect(out).toContain('diagnostic-ok')
})

test('project_diagnostics suggests nearby focused tests without running them', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo diagnostic-ok',
      test: 'echo should-not-run',
    },
  }))
  writeFileSync(join(root, 'src', 'widget.ts'), 'export const widget = true\n')
  writeFileSync(join(root, 'src', 'widget.test.ts'), 'import "./widget"\n')

  const out = await projectDiagnosticsTool.execute({ path: 'src/widget.ts', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('<test_suggestions count="1">')
  expect(out).toContain('path="src/widget.test.ts"')
  expect(out).toContain('command="bun run test -- src/widget.test.ts"')
  expect(out).toContain('diagnostic-ok')
  expect(out).not.toContain('should-not-run')
})

test('project_diagnostics suggests nearby python test files', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo diagnostic-ok',
      test: 'echo should-not-run',
    },
  }))
  writeFileSync(join(root, 'src', 'worker.py'), 'VALUE = 1\n')
  writeFileSync(join(root, 'src', 'test_worker.py'), 'from worker import VALUE\n')

  const out = await projectDiagnosticsTool.execute({ path: 'src/worker.py', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<test_suggestions count="1">')
  expect(out).toContain('path="src/test_worker.py"')
  expect(out).toContain('command="bun run test -- src/test_worker.py"')
  expect(out).not.toContain('should-not-run')
})

test('project_diagnostics runs explicit focused test paths through the package test script', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      test: 'echo test-targets',
    },
  }))
  writeFileSync(join(root, 'src', 'widget.test.ts'), 'test("ok", () => {})\n')

  const out = await projectDiagnosticsTool.execute({ check: 'test', test_paths: 'src/widget.test.ts', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('check="test"')
  expect(out).toContain('<command>bun run test -- src/widget.test.ts</command>')
  expect(out).toContain('<test_targets count="1">')
  expect(out).toContain('<target path="src/widget.test.ts" />')
  expect(out).toContain('test-targets src/widget.test.ts')
})

test('project_diagnostics approval preview shows focused test command without running it', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      test: 'echo should-not-run-preview',
    },
  }))
  writeFileSync(join(root, 'src', 'widget.test.ts'), 'test("ok", () => {})\n')

  const preview = await projectDiagnosticsTool.previewFor?.({
    check: 'test',
    test_paths: 'src/widget.test.ts',
    timeout_ms: 1000,
    max_output_bytes: 2000,
  }, ctx)

  expect(preview).toContain('<project_diagnostics_preview status="ready">')
  expect(preview).toContain('package: package.json')
  expect(preview).toContain('cwd: .')
  expect(preview).toContain('check: test')
  expect(preview).toContain('command: bun run test -- src/widget.test.ts')
  expect(preview).toContain('test_targets:\n- src/widget.test.ts')
  expect(preview).toContain('timeout_ms: 1000')
  expect(preview).toContain('max_output_bytes: 2000')
  expect(preview).not.toContain('should-not-run-preview src/widget.test.ts')
})

test('project_diagnostics rejects focused test paths outside the selected package', async () => {
  mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({
    scripts: {
      test: 'echo test-targets',
    },
  }))
  writeFileSync(join(root, 'outside.test.ts'), 'test("outside", () => {})\n')

  const out = await projectDiagnosticsTool.execute({ path: 'packages/app/src/index.ts', check: 'test', test_paths: 'outside.test.ts' }, ctx)
  expect(out).toContain('status="invalid_test_path"')
  expect(out).toContain('测试路径不在 package 内')
  expect(out).not.toContain('test-targets')
})

test('project_diagnostics omits test suggestions when the test script is unsafe', async () => {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo diagnostic-ok',
      test: 'vitest --watch',
    },
  }))
  writeFileSync(join(root, 'src', 'widget.ts'), 'export const widget = true\n')
  writeFileSync(join(root, 'src', 'widget.test.ts'), 'import "./widget"\n')

  const out = await projectDiagnosticsTool.execute({ path: 'src/widget.ts', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).not.toContain('<test_suggestions')
})

test('project_diagnostics strips ansi output and escapes xml text', async () => {
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: `node --version && node -e "process.stdout.write('\\x1b[31mdiagnostic-red\\x1b[0m & clean')"`,
    },
  }))

  const out = await projectDiagnosticsTool.execute({ check: 'typecheck', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('diagnostic-red &amp; clean')
  expect(out).not.toContain('\x1B')
})

test('project_diagnostics emits live progress while diagnostics run', async () => {
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo live-diagnostic-ok',
    },
  }))
  const chunks: string[] = []

  const out = await projectDiagnosticsTool.execute({ check: 'typecheck', max_output_bytes: 1000 }, {
    ...ctx,
    progressEmit: ev => chunks.push(`${ev.tool}:${ev.chunk}`),
  })

  expect(out).toContain('live-diagnostic-ok')
  expect(chunks.join('')).toContain('project_diagnostics:正在运行诊断')
  expect(chunks.join('')).toContain('project_diagnostics:live-diagnostic-ok')
})

test('project_diagnostics resolves nearest package for not-yet-created file paths', async () => {
  mkdirSync(join(root, 'packages', 'app'), { recursive: true })
  writeFileSync(join(root, 'packages', 'app', 'bun.lock'), '')
  writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo new-file-diagnostic-ok',
    },
  }))

  const out = await projectDiagnosticsTool.execute({ path: 'packages/app/src/new-file.ts', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('package="packages/app/package.json"')
  expect(out).toContain('new-file-diagnostic-ok')
})

test('project_diagnostics inherits workspace lockfile package manager for nested packages', async () => {
  mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo inherited-manager-ok',
    },
  }))

  const out = await projectDiagnosticsTool.execute({ path: 'packages/app/src/index.ts', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('package="packages/app/package.json"')
  expect(out).toContain('manager="bun"')
  expect(out).toContain('inherited-manager-ok')
})

test('project_diagnostics falls back to an ancestor package script in monorepos', async () => {
  mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true })
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo root-diagnostic-ok',
    },
  }))
  writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({
    scripts: {
      build: 'echo app-build',
    },
  }))

  const out = await projectDiagnosticsTool.execute({ path: 'packages/app/src/index.ts', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('package="package.json"')
  expect(out).toContain('cwd="."')
  expect(out).toContain('manager="bun"')
  expect(out).toContain('root-diagnostic-ok')
})

test('project_diagnostics accepts package-manager delegated typecheck scripts', async () => {
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'bun run typecheck:inner',
      'typecheck:inner': 'echo delegated-typecheck-ok',
    },
  }))

  const out = await projectDiagnosticsTool.execute({ check: 'typecheck', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('script="typecheck"')
  expect(out).toContain('manager="bun"')
  expect(out).toContain('delegated-typecheck-ok')
})

test('project_diagnostics accepts package-manager delegated lint scripts', async () => {
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      lint: 'bun run lint:inner',
      'lint:inner': 'echo delegated-lint-ok',
    },
  }))

  const out = await projectDiagnosticsTool.execute({ check: 'lint', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('script="lint"')
  expect(out).toContain('manager="bun"')
  expect(out).toContain('delegated-lint-ok')
})

test('project_diagnostics reports invalid package json without throwing', async () => {
  mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true })
  writeFileSync(join(root, 'packages', 'app', 'package.json'), '{ "scripts": ')
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo root-should-not-run',
    },
  }))

  const out = await projectDiagnosticsTool.execute({ path: 'packages/app/src/index.ts' }, ctx)
  expect(out).toContain('status="invalid_package_json"')
  expect(out).toContain('package="packages/app/package.json"')
  expect(out).not.toContain('root-should-not-run')
})

test('project_diagnostics allows common Next.js lint scripts', async () => {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true })
  const nextBin = join(root, 'node_modules', '.bin', 'next')
  writeFileSync(nextBin, '#!/bin/sh\necho next-lint-ok\n')
  chmodSync(nextBin, 0o755)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      lint: 'next lint',
    },
  }))

  const out = await projectDiagnosticsTool.execute({ check: 'auto', max_output_bytes: 1000 }, ctx)
  expect(out).toContain('<project_diagnostics status="completed"')
  expect(out).toContain('check="lint"')
  expect(out).toContain('script="lint"')
  expect(out).toContain('next-lint-ok')
})

test('project_diagnostics rejects scripts with obvious write/fix side effects', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'echo "<bad>" > dist',
      lint: 'eslint . --fix',
    },
  }))

  const typecheck = await projectDiagnosticsTool.execute({ check: 'typecheck' }, ctx)
  expect(typecheck).toContain('status="rejected"')
  expect(typecheck).toContain('输出重定向')
  expect(typecheck).toContain('echo "&lt;bad&gt;" &gt; dist')

  const lint = await projectDiagnosticsTool.execute({ check: 'lint' }, ctx)
  expect(lint).toContain('status="rejected"')
  expect(lint).toContain('fix/write/update/watch')
})

test('project_diagnostics treats explicit tests as file-class actions', () => {
  expect(resolvePermission(projectDiagnosticsTool, { check: 'typecheck' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(projectDiagnosticsTool, { check: 'test' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({ behavior: 'deny' })
  expect(resolvePermission(projectDiagnosticsTool, { check: 'test' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({ behavior: 'allow' })
})

test('file tools reject a path that escapes the workspace', async () => {
  await expect(fileReadTool.execute({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(/越界/)
  await expect(fileWriteTool.execute({ path: '../evil.txt', content: 'x' }, ctx)).rejects.toThrow(/越界/)
  await expect(fileEditTool.execute({ path: '../evil.txt', old_string: 'x', new_string: 'y' }, ctx)).rejects.toThrow(/越界/)
})

test('write_file throws on invalid input (missing content)', async () => {
  // @ts-expect-error 故意传非法入参,验证工具自校验抛错(主循环会把它回灌)
  await expect(fileWriteTool.execute({ path: 'x.txt' }, ctx)).rejects.toThrow()
})

test('write_file 拒 $ 展开路径(TOCTOU)', async () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-ft-'))))
  const ctx = { workspace: ws }
  await expect(fileWriteTool.execute({ path: '$HOME/evil.txt', content: 'x' }, ctx)).rejects.toThrow(
    PathValidationError,
  )
})
