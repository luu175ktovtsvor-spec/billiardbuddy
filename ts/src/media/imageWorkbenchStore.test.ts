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

test('ImageWorkbenchStore serializes autosave and requires explicit portrait confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-workbench-concurrency-'))
  try {
    const store = new ImageWorkbenchStore(root)
    const project = await store.createProject({
      title: '助教形象照',
      image_url: '/uploads/posters/portrait.png',
      width: 320,
      height: 320,
      intent: 'portrait',
      quality: 'standard',
      creative_brief: {
        user_request: '做一张助教形象照',
        scene: 'portrait',
        portrait: { authorization_confirmed: true },
      },
    })
    const input = { current_version_id: project.current_version_id, width: 320, height: 320, text_layers: [], image_layers: [], revision: 0 }
    const outcomes = await Promise.allSettled([store.saveCanvas(project.project_id, input), store.saveCanvas(project.project_id, input)])
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(item => item.status === 'rejected' && String(item.reason).includes('revision conflict'))).toHaveLength(1)
    const saved = await store.getProject(project.project_id)
    expect(saved?.autosave_revision).toBe(1)
    const confirmed = await store.confirmPortrait(project.project_id, { confirmed: true })
    expect(confirmed.versions[0]?.review?.portrait_quality_state).toBe('user_confirmed')
    expect(confirmed.versions[0]?.review?.portrait_user_confirmed).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ImageWorkbenchStore keeps controlled copy and export layout guards at the persistence boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-workbench-export-guards-'))
  try {
    const store = new ImageWorkbenchStore(root)
    const poster = await store.createProject({
      title: '会员日海报',
      image_url: '/uploads/posters/poster.png',
      width: 320,
      height: 240,
      intent: 'poster_text',
      quality: 'standard',
      creative_brief: {
        user_request: '会员日 39.9 元海报',
        poster: { exact_copy: ['会员日', '39.9元'] },
      },
    })
    await expect(store.exportProject(poster.project_id, {
      version_id: poster.current_version_id,
      data_url: pngDataUrl(320, 240),
      width: 320,
      height: 240,
      text_layers: [{ id: 'poster_title', type: 'text', text: '会员日', x: 12, y: 12, font_size: 32 }],
    })).rejects.toThrow(/受控文字层缺少业务信息/)

    const portrait = await store.createProject({
      title: '助教形象照',
      image_url: '/uploads/posters/portrait.png',
      width: 320,
      height: 320,
      intent: 'portrait',
      quality: 'standard',
      creative_brief: {
        user_request: '做一张助教形象照',
        scene: 'portrait',
        portrait: { authorization_confirmed: true },
      },
    })
    const portraitExport = {
      version_id: portrait.current_version_id,
      data_url: pngDataUrl(320, 320),
      width: 320,
      height: 320,
      text_layers: [],
    }
    await expect(store.exportProject(portrait.project_id, portraitExport)).rejects.toThrow(/确认像本人/)
    await store.confirmPortrait(portrait.project_id, { confirmed: true })
    await expect(store.exportProject(portrait.project_id, portraitExport)).resolves.toMatchObject({ asset: { kind: 'export' } })

    const creative = await store.createProject({
      title: '图层校验',
      image_url: '/uploads/posters/creative.png',
      width: 320,
      height: 240,
      intent: 'creative',
      quality: 'standard',
    })
    const logo = await store.uploadAsset({ kind: 'reference', data_url: pngDataUrl(64, 64), width: 64, height: 64 })
    await expect(store.exportProject(creative.project_id, {
      version_id: creative.current_version_id,
      data_url: pngDataUrl(320, 240),
      width: 320,
      height: 240,
      text_layers: [{ id: 'tiny_text', type: 'text', text: '过小', x: 12, y: 12, font_size: 11 }],
    })).rejects.toThrow(/font size is too small/)
    await expect(store.exportProject(creative.project_id, {
      version_id: creative.current_version_id,
      data_url: pngDataUrl(320, 240),
      width: 320,
      height: 240,
      text_layers: [],
      image_layers: [{ id: 'stretched_logo', type: 'logo', asset_id: logo.asset_id, url: logo.url, x: 0, y: 0, width: 128, height: 64 }],
    })).rejects.toThrow(/aspect ratio changed/)
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
