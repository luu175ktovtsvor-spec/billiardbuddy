import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { inspectPosterHardGate } from './posterQuality'

test('poster hard gate accepts a real image with exact controlled copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'poster-gate-'))
  const path = join(root, 'poster.png')
  const png = new PNG({ width: 320, height: 240 })
  writeFileSync(path, PNG.sync.write(png))
  try {
    const result = await inspectPosterHardGate({ path, width: 320, height: 240, requiredCopy: ['会员日'], textLayers: [{ id: 't', type: 'text', text: '会员日', x: 1, y: 1, scale_x: 1, scale_y: 1, angle: 0, fill: '#fff', font_family: 'sans', font_size: 32, text_align: 'center', stroke_width: 0, opacity: 1 }] })
    expect(result).toMatchObject({ state: 'passed', passed: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('poster hard gate blocks missing or wrong dimensions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'poster-gate-risk-'))
  const path = join(root, 'poster.png')
  const png = new PNG({ width: 320, height: 240 })
  writeFileSync(path, PNG.sync.write(png))
  try {
    const result = await inspectPosterHardGate({ path, width: 1024, height: 1024, requiredCopy: ['价格'], textLayers: [] })
    expect(result.passed).toBe(false)
    expect(result.warnings.join(' ')).toContain('尺寸')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
