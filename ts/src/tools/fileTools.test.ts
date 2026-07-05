import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { PathValidationError } from '../workspace/pathValidation'
import type { ToolContext } from './Tool'
import { fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { listDirTool } from './listDirTool'

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

test('write_file creates a file and backs up an existing one on overwrite', async () => {
  await fileWriteTool.execute({ path: 'note.txt', content: 'v1' }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v1')
  await fileWriteTool.execute({ path: 'note.txt', content: 'v2' }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v2')
  const backups = readdirSync(join(root, '.backups'))
  expect(backups.length).toBe(1) // 覆盖前备份了 v1
})

test('list_dir lists the workspace root by default', async () => {
  writeFileSync(join(root, 'a.txt'), '')
  writeFileSync(join(root, 'b.txt'), '')
  const out = await listDirTool.execute({}, ctx)
  expect(out.split('\n')).toEqual(['a.txt', 'b.txt'])
})

test('file tools reject a path that escapes the workspace', async () => {
  await expect(fileReadTool.execute({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(/越界/)
  await expect(fileWriteTool.execute({ path: '../evil.txt', content: 'x' }, ctx)).rejects.toThrow(/越界/)
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
