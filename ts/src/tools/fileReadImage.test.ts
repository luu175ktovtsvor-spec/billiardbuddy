import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { fileReadTool } from './fileReadTool'

let root: string
let ctx: ToolContext
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fri-')))
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function writePng(name: string, width: number, height: number): void {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  writeFileSync(join(root, name), b)
}

test('read_file returns image metadata (not UTF-8 mojibake) for image files', async () => {
  writePng('shot.png', 640, 480)
  const out = await fileReadTool.execute({ path: 'shot.png' }, ctx)
  expect(out).toContain('<file_image')
  expect(out).toContain('format="png"')
  expect(out).toContain('dimensions="640x480"')
  expect(out).toContain('vision_supported="true"')
  expect(out).toContain(`est_vision_tokens="${Math.ceil((640 * 480) / 750)}"`)
})

test('read_file flags images that exceed the vision token budget', async () => {
  writePng('huge.png', 4000, 4000)
  const out = await fileReadTool.execute({ path: 'huge.png' }, ctx)
  expect(out).toContain('over_vision_budget="true"')
})

test('read_file text reads are unchanged by the image branch', async () => {
  writeFileSync(join(root, 'note.txt'), 'plain text content')
  const out = await fileReadTool.execute({ path: 'note.txt' }, ctx)
  expect(out).toContain('plain text content')
  expect(out).not.toContain('<file_image')
})
