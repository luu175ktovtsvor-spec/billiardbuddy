import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { ImageWorkbenchStore } from './imageWorkbenchStore'

test('ImageWorkbenchStore persists versions, rollback, mask assets, export and library entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-workbench-store-'))
  try {
    const store = new ImageWorkbenchStore(root)
    const project = await store.createProject({
      title: '会员日海报',
      source_generation_id: 'direct-source',
      image_url: '/uploads/posters/source.png',
      width: 320,
      height: 240,
      ratio: '4:3',
      prompt: '会员日',
      intent: 'poster_text',
      quality: 'standard',
      quantity: 3,
      review: { text_quality_status: 'pending_ocr', text_quality_warning: true },
    })

    expect(project.versions[0]?.review?.text_quality_status).toBe('pending_ocr')

    const mask = await store.uploadAsset({
      kind: 'mask',
      data_url: pngDataUrl(320, 240, (png) => {
        for (let y = 40; y < 80; y++) {
          for (let x = 20; x < 60; x++) {
            const idx = (png.width * y + x) << 2
            png.data[idx + 3] = 0
          }
        }
      }),
      width: 320,
      height: 240,
    })
    expect(mask.url).toContain('/uploads/workbench/assets/mask/')
    const maskPath = store.uploadPathForUrl(mask.url)
    expect(maskPath && existsSync(maskPath)).toBe(true)
    const savedMask = PNG.sync.read(readFileSync(maskPath!))
    expect(savedMask.width).toBe(320)
    expect(savedMask.height).toBe(240)
    expect(savedMask.data[((320 * 50 + 30) << 2) + 3]).toBe(0)
    expect(savedMask.data[((320 * 10 + 10) << 2) + 3]).toBe(255)

    await expect(store.uploadAsset({
      kind: 'mask',
      data_url: 'data:image/jpeg;base64,' + Buffer.from('not-a-png').toString('base64'),
      width: 1,
      height: 1,
    })).rejects.toThrow(/must be PNG/)
    expect(store.uploadPathForUrl('/uploads/../secret.png')).toBeNull()

    const withEdit = await store.addVersion(project.project_id, {
      kind: 'inpaint',
      parent_version_id: project.current_version_id,
      image_url: '/uploads/posters/edit.png',
      width: 320,
      height: 240,
      mask: { asset_id: mask.asset_id, url: mask.url, width: 320, height: 240, mode: 'alpha_transparent_edit' },
      review: { commercial_ready: false },
      set_current: true,
    })
    expect(withEdit.versions).toHaveLength(2)
    expect(withEdit.current_version_id).not.toBe(project.current_version_id)

    const rolledBack = await store.rollback(project.project_id, { version_id: project.current_version_id })
    expect(rolledBack.current_version_id).toBe(project.current_version_id)

    const exported = await store.exportProject(project.project_id, {
      version_id: rolledBack.current_version_id,
      data_url: pngDataUrl(320, 240),
      width: 320,
      height: 240,
      text_layers: [{
        id: 'text_layer_1',
        type: 'text',
        text: '会员日',
        x: 10,
        y: 20,
        font_size: 32,
      }],
    })
    expect(exported.asset.kind).toBe('export')
    expect(exported.project.versions.at(-1)?.kind).toBe('text_export')

    const library = await store.saveToLibrary(project.project_id, {
      export_asset_id: exported.asset.asset_id,
      title: '可投放海报',
    })
    expect(library.title).toBe('可投放海报')
    expect(library.url).toContain('/uploads/library/images/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function pngDataUrl(width: number, height: number, mutate?: (png: PNG) => void): string {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 20
    png.data[i + 1] = 40
    png.data[i + 2] = 80
    png.data[i + 3] = 255
  }
  mutate?.(png)
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`
}
