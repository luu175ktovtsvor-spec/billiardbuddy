import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import {
  imageCanvasDocumentSchema,
  type ImageCanvasDocument,
} from '../shared/contracts/imageGeneration.js'
import { DeterministicImageCanvasRenderer, verifyRenderedQrManifest } from '../src/server/services/imageCanvasRenderer.js'

const fixture: ImageCanvasDocument = imageCanvasDocumentSchema.parse({
  schema_version: 1,
  id: 'canvas_golden_0001',
  project_id: 'img_golden_0001',
  artboard_id: 'art_golden_0001',
  delivery_spec_id: 'dsp_golden_0001',
  delivery_spec_revision: 0,
  width: 512,
  height: 384,
  color_space: 'srgb',
  background: { kind: 'solid', color: '#ffffff' },
  created_at: '2026-08-04T00:00:00.000Z',
  layers: [
    {
      id: 'shape_golden_0001', kind: 'shape', shape: 'rectangle', fill: '#1261a0', opacity: 0.9,
      transform: { x: 34, y: 42, width: 96, height: 52, rotation_degrees: 17, scale_x: 1.75, scale_y: 1.25 },
    },
    {
      id: 'qrcode_golden_0001', kind: 'qrcode', source: { kind: 'payload', value: 'https://example.test/golden/windows-x64' },
      transform: { x: 326, y: 56, width: 120, height: 120, rotation_degrees: 90, scale_x: 1.25, scale_y: 1.25 },
      error_correction: 'H', quiet_zone_modules: 4, verify_after_render: true,
    },
    {
      id: 'text_golden_0001', kind: 'text', text: '台球冠军赛', font_family: 'BilliardBuddy Builtin CJK', font_asset_id: 'font_builtin_0001',
      font_size: 48, min_font_size: 32, font_weight: 400, font_style: 'normal', line_height: 1.1, letter_spacing: 1,
      fill: '#17233c', position: { x: 72, y: 214 }, rotation_degrees: -9, scale_x: 1.2, scale_y: 0.9,
      max_width: 260, max_height: 110, overflow: 'shrink_to_fit', locale: 'zh-CN', align: 'left', opacity: 1,
    },
  ],
})

const GOLDEN_SHA256 = 'sha256:16708fae6655fb3af8c99b49705b8e60e9f2de95c5a2a97a4e79f06407f9c1ab'

test('15.3 Canvas golden 固定 Shape/QR/Text 变换、布局收据与跨平台 canonical PNG', async () => {
  const output = await new DeterministicImageCanvasRenderer().render(fixture, [])
  const hash = `sha256:${createHash('sha256').update(output.bytes).digest('hex')}`
  const shapePixels = await (await import('sharp')).default(output.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  // scale_x=1.75 makes this pixel visible; without the real shape transform it is transparent.
  expect(shapePixels.data[(72 * shapePixels.info.width + 176) * 4 + 3]).toBeGreaterThan(0)
  expect(output.text_layout_manifest[0]).toMatchObject({
    id: 'text_golden_0001', overflow: 'fit', pixel_bounds: { empty: false },
  })
  expect(output.text_layout_manifest[0]?.runs[0]?.glyphs.length).toBeGreaterThan(0)
  await expect(verifyRenderedQrManifest(output.bytes, output.qr_manifest)).resolves.toBeUndefined()
  if (process.env.BB_IMAGE_GOLDEN_REPORT) {
    await writeFile(process.env.BB_IMAGE_GOLDEN_REPORT, `${JSON.stringify({
      fixture: 'image-canvas-15.3-transform-v1', platform: process.platform, arch: process.arch, canonical_png_hash: hash,
      renderer_version: output.renderer_version, text_layout_engine_version: output.text_layout_engine_version,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  expect(hash).toBe(GOLDEN_SHA256)
})
