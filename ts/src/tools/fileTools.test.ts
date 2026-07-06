import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { PathValidationError } from '../workspace/pathValidation'
import type { ToolContext } from './Tool'
import { fileReadTool } from './fileReadTool'
import { fileEditTool } from './fileEditTool'
import { fileWriteTool } from './fileWriteTool'
import { fileHistoryTool, restoreFileTool } from './fileHistoryTool'
import { listDirTool } from './listDirTool'
import { globFilesTool, grepFilesTool } from './searchTools'

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

test('read_file ignores PDF-only pages parameter for non-PDF files', async () => {
  writeFileSync(join(root, 'a.txt'), 'hello')
  expect(await fileReadTool.execute({ path: 'a.txt', pages: '0' }, ctx)).toBe('hello')
})

test('write_file creates a file and backs up an existing one on overwrite', async () => {
  await fileWriteTool.execute({ path: 'note.txt', content: 'v1' }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v1')
  await fileWriteTool.execute({ path: 'note.txt', content: 'v2' }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v2')
  const backups = readdirSync(join(root, '.backups'))
  expect(backups.length).toBe(1) // 覆盖前备份了 v1
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
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v1\n')
})

test('restore_file can revert a file creation snapshot by deleting the file', async () => {
  ctx.conversationId = 'file-history-delete'
  await fileWriteTool.execute({ path: 'new.txt', content: 'created' }, ctx)
  expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('created')

  await restoreFileTool.execute({ path: 'new.txt' }, ctx)
  expect(() => readFileSync(join(root, 'new.txt'), 'utf8')).toThrow()
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

test('list_dir lists the workspace root by default', async () => {
  writeFileSync(join(root, 'a.txt'), '')
  writeFileSync(join(root, 'b.txt'), '')
  const out = await listDirTool.execute({}, ctx)
  expect(out.split('\n')).toEqual(['a.txt', 'b.txt'])
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
