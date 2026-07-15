import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ImageBlock } from '../types/message'
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

function writeBmp(name: string, width: number, height: number): void {
  const b = Buffer.alloc(26)
  b[0] = 0x42
  b[1] = 0x4d
  b.writeInt32LE(width, 18)
  b.writeInt32LE(height, 22)
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

test('read_file pushes a real vision image block into ctx.imageResultSink (png)', async () => {
  writePng('shot.png', 100, 80)
  const imageResultSink: ImageBlock[] = []
  const out = await fileReadTool.execute({ path: 'shot.png' }, { ...ctx, imageResultSink })
  // 返回值仍是元信息文本(向后兼容);真图像块走 sink 给 loop 组进 tool_result content。
  expect(typeof out).toBe('string')
  expect(out).toContain('<file_image')
  expect(imageResultSink).toHaveLength(1)
  expect(imageResultSink[0]!.type).toBe('image')
  expect(imageResultSink[0]!.source.type).toBe('base64')
  expect(imageResultSink[0]!.source.media_type).toBe('image/png')
  expect(imageResultSink[0]!.source.data.length).toBeGreaterThan(0)
})

test('read_file omits an over-budget image when a safe preview cannot be generated', async () => {
  writePng('huge.png', 4000, 4000)
  const imageResultSink: ImageBlock[] = []
  const out = await fileReadTool.execute({ path: 'huge.png' }, { ...ctx, imageResultSink })
  expect(out).toContain('over_vision_budget="true"')
  expect(out).toContain('无法生成安全预览')
  expect(imageResultSink).toHaveLength(0)
})

test('read_file does not push a vision block for non-vision formats (bmp)', async () => {
  writeBmp('x.bmp', 10, 10)
  const imageResultSink: ImageBlock[] = []
  const out = await fileReadTool.execute({ path: 'x.bmp' }, { ...ctx, imageResultSink })
  expect(out).toContain('vision_supported="false"')
  expect(imageResultSink).toHaveLength(0)
})

test('read_file image branch works without a sink (backward compatible)', async () => {
  writePng('nosink.png', 32, 32)
  const out = await fileReadTool.execute({ path: 'nosink.png' }, ctx)
  expect(out).toContain('<file_image')
  expect(out).toContain('format="png"')
})
