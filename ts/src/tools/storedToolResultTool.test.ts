import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './Tool'
import { readStoredToolResultTool } from './storedToolResultTool'
import { Workspace } from '../workspace/workspace'

let root: string
let workspaceRoot: string
let ctx: ToolContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stored-result-tool-'))
  workspaceRoot = mkdtempSync(join(tmpdir(), 'stored-result-ws-'))
  ctx = { workspace: new Workspace(workspaceRoot), toolResultStoreDir: root }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
})

test('read_stored_tool_result reads a bounded window from the session result store', async () => {
  const path = join(root, 'big.txt')
  writeFileSync(path, `HEAD\n${'x'.repeat(80)}\nTAIL`)

  const out = await readStoredToolResultTool.execute({ path, max_bytes: 12 }, ctx)
  expect(out).toContain('<stored_tool_result_read status="completed"')
  expect(out).toContain('offset="0"')
  expect(out).toContain('truncated_bottom="true"')
  expect(out).toContain('HEAD')
  expect(out).not.toContain('TAIL')
})

test('read_stored_tool_result supports tail windows and relative filenames', async () => {
  writeFileSync(join(root, 'big.txt'), `HEAD\n${'x'.repeat(80)}\nTAIL`)

  const out = await readStoredToolResultTool.execute({ path: 'big.txt', tail: true, max_bytes: 12 }, ctx)
  expect(out).toContain('truncated_top="true"')
  expect(out).toContain('TAIL')
  expect(out).not.toContain('HEAD')
})

test('read_stored_tool_result strips ansi control sequences from stored windows', async () => {
  writeFileSync(join(root, 'ansi.txt'), 'HEAD\n\x1B[31mRED\x1B[0m\nTAIL')

  const out = await readStoredToolResultTool.execute({ path: 'ansi.txt', max_bytes: 80 }, ctx)
  expect(out).toContain('RED')
  expect(out).not.toContain('\x1B')
  expect(out).not.toContain('[31m')
})

test('read_stored_tool_result rejects files outside the session store, including symlinks', async () => {
  const outside = join(workspaceRoot, 'outside.txt')
  writeFileSync(outside, 'secret')
  symlinkSync(outside, join(root, 'link.txt'))

  const direct = await readStoredToolResultTool.execute({ path: outside }, ctx)
  expect(direct).toContain('status="rejected"')

  const link = await readStoredToolResultTool.execute({ path: 'link.txt' }, ctx)
  expect(link).toContain('status="rejected"')
})

test('read_stored_tool_result reports missing store dir', async () => {
  const out = await readStoredToolResultTool.execute({ path: 'big.txt' }, { workspace: new Workspace(workspaceRoot) })
  expect(out).toContain('status="missing_store_dir"')
})
