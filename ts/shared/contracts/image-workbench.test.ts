import { expect, test } from 'bun:test'
import {
  imageCreativeBriefSchema,
  imageWorkbenchProjectSchema,
  imageWorkbenchPortraitConfirmRequestSchema,
  studioEditRequestSchema,
  studioGenerateRequestSchema,
} from './image-workbench'

test('studio generate contract keeps renderer on capability intent and strips provider fields', () => {
  const parsed = studioGenerateRequestSchema.parse({
    prompt: '做一张会员日海报',
    image_provider: 'seedream',
    image_model: 'real-model-name',
  })

  expect(parsed.count).toBe(3)
  expect(parsed.quality).toBe('standard')
  expect(parsed.intent).toBe('poster_text')
  expect('image_provider' in parsed).toBe(false)
  expect('image_model' in parsed).toBe(false)
})

test('studio generate contract preserves legacy print-mode fields without exposing provider control', () => {
  const parsed = studioGenerateRequestSchema.parse({
    prompt: '做一张印刷海报',
    print_mode: true,
    poster_text: { title: '会员日特惠' },
    logo_path: '/uploads/store/logo.png',
    qrcode_text: 'https://example.com/qr',
    image_provider: 'seedream',
  })

  expect(parsed.print_mode).toBe(true)
  expect(parsed.poster_text).toEqual({ title: '会员日特惠' })
  expect(parsed.logo_path).toBe('/uploads/store/logo.png')
  expect(parsed.qrcode_text).toContain('example.com')
  expect('image_provider' in parsed).toBe(false)
})

test('studio edit contract requires a source image and accepts inpaint intent', () => {
  expect(() => studioEditRequestSchema.parse({ prompt: '把桌布换成绿色' })).toThrow()
  const parsed = studioEditRequestSchema.parse({
    source_image_path: '/uploads/posters/source.png',
    prompt: '只重绘选区',
    mask_path: '/uploads/workbench/assets/mask/mask_1.png',
    intent: 'inpaint',
  })
  expect(parsed.intent).toBe('inpaint')
  expect(parsed.quality).toBe('standard')
})

test('workbench project contract persists controlled review fields on versions', () => {
  const project = imageWorkbenchProjectSchema.parse({
    schema_version: 1,
    project_id: 'wb_contract',
    title: '会员日',
    current_version_id: 'v_contract',
    quality: 'standard',
    canvas: { width: 1024, height: 1024, text_layers: [], updated_at: '2026-07-13T00:00:00.000Z' },
    versions: [{
      id: 'v_contract',
      kind: 'generated',
      image_url: '/uploads/posters/a.png',
      width: 1024,
      height: 1024,
      review: {
        text_quality_status: 'pending_ocr',
        text_quality_warning: true,
        commercial_ready: false,
      },
      created_at: '2026-07-13T00:00:00.000Z',
    }],
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
  })

  expect(project.versions[0]?.review?.text_quality_status).toBe('pending_ocr')
  expect(project.versions[0]?.review?.commercial_ready).toBe(false)
})

test('legacy project format receives safe defaults for brief, image layers and revision', () => {
  const project = imageWorkbenchProjectSchema.parse({
    schema_version: 1,
    project_id: 'legacy_project',
    title: '旧项目',
    current_version_id: 'legacy_version',
    quality: 'standard',
    canvas: { width: 320, height: 240, text_layers: [], updated_at: '2026-07-13T00:00:00.000Z' },
    versions: [{ id: 'legacy_version', kind: 'imported', image_url: '/uploads/legacy.png', width: 320, height: 240, created_at: '2026-07-13T00:00:00.000Z' }],
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
  })
  expect(project.canvas.image_layers).toEqual([])
  expect(project.reference_assets).toEqual([])
  expect(project.autosave_revision).toBe(0)
  expect(project.save_status).toBe('saved')
})

test('brief and portrait confirmation contracts keep provider details out of the user boundary', () => {
  const brief = imageCreativeBriefSchema.parse({ user_request: '做一张助教形象照', scene: 'portrait', portrait: { authorization_confirmed: true } })
  expect(brief.portrait?.authorization_confirmed).toBe(true)
  expect(imageWorkbenchPortraitConfirmRequestSchema.parse({ confirmed: true }).confirmed).toBe(true)
})

test('custom poster type is compatible with legacy briefs', () => {
  const legacy = imageCreativeBriefSchema.parse({
    user_request: '做一张会员日海报',
    poster: { template_id: 'membership_recharge', title: '会员日' },
  })
  const current = imageCreativeBriefSchema.parse({
    user_request: '做一张自由设计的门店海报',
    poster: {
      template_id: 'custom_poster',
    },
  })

  expect(legacy.poster?.template_id).toBe('membership_recharge')
  expect(current.poster?.template_id).toBe('custom_poster')
})

test('photo output use keeps person-photo edits distinct from a profile template', () => {
  const brief = imageCreativeBriefSchema.parse({
    user_request: '把这张已授权实拍照片变得自然好看',
    scene: 'portrait',
    output_use: 'photo',
  })

  expect(brief.output_use).toBe('photo')
})
