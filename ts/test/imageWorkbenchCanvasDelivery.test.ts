import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { assertSafeSvg } from '../src/server/services/imageCanvasRenderer.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'

const roots: string[] = []
const timestamp = '2026-08-03T00:00:00.000Z'
const capability = '15-3-canvas-capability-token-0123456789'

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `billiardbuddy-canvas-${label}-`))
  roots.push(value)
  return value
}

async function service(label: string, crashInjector?: ConstructorParameters<typeof ImageWorkbenchService>[0]['crashInjector']): Promise<ImageWorkbenchService> {
  return new ImageWorkbenchService({
    root: await root(label),
    legacyMediaRoot: await root(`${label}-legacy`),
    now: () => new Date(timestamp),
    crashInjector,
  })
}

async function projectWithCanvas(workbench: ImageWorkbenchService) {
  const project = await workbench.createProject({
    title: '15.3 正式画布交付',
    user_request: '创建正式交付画布',
    size: '1024x1024',
    reference_images: [],
    reference_roles: [],
  })
  const delivery = await workbench.repository.currentDeliverySpec(project.id)
  if (!delivery) throw new Error('expected initial delivery specification')
  const current = await workbench.getProject(project.id)
  const canvas = await workbench.createCanvas(project.id, {
    artboard_id: delivery.artboards[0]!.id,
    base_revision: current.revision,
    idempotency_key: 'bb-image-canvas-create-15-3-0001',
  })
  return { project: canvas.project, canvas: canvas.canvas, artboard: delivery.artboards[0]! }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true })))
})

test('15.3 Canvas 命令在同一项目锁事务内重放、冲突并保留独立画板修订', async () => {
  const workbench = await service('commands')
  const setup = await projectWithCanvas(workbench)
  const first = {
    idempotency_key: 'bb-image-canvas-command-15-3-0001',
    base_revision: 0,
    kind: 'add_layer' as const,
    payload: {
      layer: {
        id: 'shape_canvas_0001', kind: 'shape' as const, shape: 'rectangle' as const,
        transform: { x: 20, y: 20, width: 300, height: 200, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
        fill: '#123456', opacity: 1,
      },
    },
  }
  const changed = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, first)
  expect(changed.canvas).toMatchObject({ revision: 1, parent_revision: 0 })
  const replay = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, first)
  expect(replay.canvas).toEqual(changed.canvas)
  await expect(workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    ...first,
    payload: { layer: { ...first.payload.layer, fill: '#654321' } },
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })

  const afterReplay = await workbench.getProject(setup.project.id)
  const concurrent = await Promise.allSettled([
    workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, afterReplay.revision, {
      idempotency_key: 'bb-image-canvas-command-15-3-0002', base_revision: 1, kind: 'add_layer',
      payload: { layer: { ...first.payload.layer, id: 'shape_canvas_0002', fill: '#aabbcc' } },
    }),
    workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, afterReplay.revision, {
      idempotency_key: 'bb-image-canvas-command-15-3-0003', base_revision: 1, kind: 'add_layer',
      payload: { layer: { ...first.payload.layer, id: 'shape_canvas_0003', fill: '#ccbbaa' } },
    }),
  ])
  expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1)
  const latest = await workbench.getCanvas(setup.project.id, setup.canvas.canvas_id)
  expect(latest.revision).toBe(2)
  expect((await workbench.getCanvas(setup.project.id, setup.canvas.canvas_id, 1)).document.layers).toHaveLength(1)
  const beforeSpec = await workbench.getProject(setup.project.id)
  const nextSpec = await workbench.createDeliverySpecRevision(setup.project.id, {
    base_revision: beforeSpec.revision,
    idempotency_key: 'bb-image-canvas-delivery-sync-0001', purpose: 'custom',
    artboards: [{ id: setup.artboard.id, label: '缩放画板', width: 512, height: 512, required: true, output: { format: 'png', transparent: false } }],
  })
  const synced = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, nextSpec.project.revision, {
    idempotency_key: 'bb-image-canvas-sync-command-0001', base_revision: latest.revision, kind: 'sync_delivery_spec',
    payload: { delivery_spec_id: nextSpec.spec.id, delivery_spec_revision: nextSpec.spec.revision, layout_policy: 'fit_safe_area' },
  })
  expect(synced.canvas.document).toMatchObject({ width: 512, height: 512, delivery_spec_revision: nextSpec.spec.revision })
  expect(synced.canvas.document.layers[0]).toMatchObject({ transform: { x: 10, y: 10, width: 150, height: 100 } })
})

test('15.3 后端渲染、QR 解码、陈旧完成、可验证导出和崩溃重跑都不接受 Renderer PNG', async () => {
  const workbench = await service('renderer')
  const setup = await projectWithCanvas(workbench)
  const shape = {
    idempotency_key: 'bb-image-canvas-render-shape-0001', base_revision: 0, kind: 'add_layer' as const,
    payload: { layer: {
      id: 'shape_render_0001', kind: 'shape' as const, shape: 'ellipse' as const,
      transform: { x: 40, y: 40, width: 300, height: 300, rotation_degrees: 0, scale_x: 1, scale_y: 1 }, fill: '#3377cc', opacity: 1,
    } },
  }
  const changed = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, shape)
  const qrProject = await workbench.getProject(setup.project.id)
  const qr = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, qrProject.revision, {
    idempotency_key: 'bb-image-canvas-render-qr-0001', base_revision: 1, kind: 'add_layer',
    payload: { layer: {
      id: 'qrcode_render_0001', kind: 'qrcode', source: { kind: 'payload', value: 'https://example.test/delivery/15-3' },
      transform: { x: 700, y: 700, width: 240, height: 240, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
      error_correction: 'H', quiet_zone_modules: 4, verify_after_render: true,
    } },
  })
  const firstRender = await workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: qr.project.revision,
    idempotency_key: 'bb-image-canvas-render-old-0001',
    canvas_revision: changed.canvas.revision,
    activate_on_success: true,
  })
  const firstOutputHash = firstRender.render_receipt.output_hash
  expect(firstRender.render_receipt).toMatchObject({ canvas_revision: 1, output_hash: expect.stringMatching(/^sha256:/) })
  const secondProject = await workbench.getProject(setup.project.id)
  const secondRender = await workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: secondProject.revision,
    idempotency_key: 'bb-image-canvas-render-current-0001',
    canvas_revision: qr.canvas.revision,
    activate_on_success: true,
    expected_current_version_id: firstRender.version_id,
  })
  expect(secondRender.operation.completion_freshness).toBe('current')
  const staleProject = await workbench.getProject(setup.project.id)
  const staleRender = await workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: staleProject.revision,
    idempotency_key: 'bb-image-canvas-render-stale-0001',
    canvas_revision: changed.canvas.revision,
    activate_on_success: true,
    expected_current_version_id: firstRender.version_id,
  })
  expect(staleRender.operation.completion_freshness).toBe('stale')
  expect(staleRender.render_receipt.output_hash).toBe(firstOutputHash)
  const exportProject = await workbench.getProject(setup.project.id)
  const exported = await workbench.exportDelivery(setup.project.id, {
    base_revision: exportProject.revision,
    idempotency_key: 'bb-image-canvas-export-15-3-0001',
    version_ids_by_artboard: { [setup.artboard.id]: secondRender.version_id },
  })
  expect(exported.delivery_set?.version_ids_by_artboard[setup.artboard.id]).toBe(secondRender.version_id)
  expect(exported.export_receipts[0]).toMatchObject({ width: setup.artboard.width, height: setup.artboard.height, output_hash: expect.stringMatching(/^sha256:/) })

  const handler = createImageWorkbenchDomainApiHandler(workbench, capability)
  const response = await handler(new Request(`http://127.0.0.1/api/images/projects/${setup.project.id}/canvases/${setup.canvas.canvas_id}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({ base_project_revision: (await workbench.getProject(setup.project.id)).revision, command: { ...shape, payload: { layer: { ...shape.payload.layer, fill: '#ffeeaa' } } } }),
  }), new URL(`http://127.0.0.1/api/images/projects/${setup.project.id}/canvases/${setup.canvas.canvas_id}/commands`), ['api', 'images', 'projects', setup.project.id, 'canvases', setup.canvas.canvas_id, 'commands'])
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })
  expect(() => assertSafeSvg('<svg><script>alert(1)</script></svg>')).toThrow('SVG')
})

test('15.3 正式字体会验证 CJK 字形并在预检中阻止缺失字形', async () => {
  const workbench = await service('cjk-font')
  const setup = await projectWithCanvas(workbench)
  const text = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    idempotency_key: 'bb-image-canvas-cjk-text-0001', base_revision: 0, kind: 'add_layer',
    payload: { layer: {
      id: 'text_canvas_cjk_0001', kind: 'text', text: '台球夏季冠军赛', font_family: 'PingFang SC', font_asset_id: 'font_builtin_0001',
      font_size: 72, min_font_size: 48, font_weight: 700, font_style: 'normal', line_height: 1.2, letter_spacing: 0,
      fill: '#ffffff', position: { x: 80, y: 120 }, rotation_degrees: 0, max_width: 800, max_height: 180, overflow: 'shrink_to_fit', locale: 'zh-CN', align: 'left', opacity: 1,
    } },
  })
  const valid = await workbench.preflightCanvas(setup.project.id, setup.canvas.canvas_id, { revision: text.canvas.revision })
  expect(valid.passed).toBeTrue()
  const rendered = await workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: text.project.revision, idempotency_key: 'bb-image-canvas-cjk-render-0001', canvas_revision: text.canvas.revision, activate_on_success: true,
  })
  expect(rendered.render_receipt.font_asset_hashes).toHaveLength(1)
  const invalidProject = await workbench.getProject(setup.project.id)
  const invalid = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, invalidProject.revision, {
    idempotency_key: 'bb-image-canvas-missing-glyph-0001', base_revision: text.canvas.revision, kind: 'add_layer',
    payload: { layer: {
      id: 'text_canvas_missing_0001', kind: 'text', text: '\u{10ffff}', font_family: 'PingFang SC', font_asset_id: 'font_builtin_0001',
      font_size: 24, font_weight: 400, font_style: 'normal', line_height: 1, letter_spacing: 0,
      fill: '#ffffff', position: { x: 20, y: 20 }, rotation_degrees: 0, overflow: 'error', locale: 'zh-CN', align: 'left', opacity: 1,
    } },
  })
  const invalidPreflight = await workbench.preflightCanvas(setup.project.id, setup.canvas.canvas_id, { revision: invalid.canvas.revision })
  expect(invalidPreflight.passed).toBeFalse()
  expect(invalidPreflight.checks.find(check => check.id === 'font-and-text-bounds')).toMatchObject({ status: 'fail' })
})

test('15.3 交付集会锁定全部 required Artboard 并逐份复核 PNG、JPEG、WebP 哈希', async () => {
  const workbench = await service('multi-format-export')
  const project = await workbench.createProject({
    title: '多格式交付', user_request: '输出三种可验证格式', size: '1024x1024', reference_images: [], reference_roles: [],
  })
  const specification = await workbench.createDeliverySpecRevision(project.id, {
    base_revision: project.revision,
    idempotency_key: 'bb-image-delivery-spec-multi-format-0001',
    purpose: 'custom',
    artboards: [
      { id: 'art_export_png_0001', label: 'PNG', width: 320, height: 240, required: true, output: { format: 'png', transparent: false } },
      { id: 'art_export_jpeg_0001', label: 'JPEG', width: 320, height: 240, required: true, output: { format: 'jpeg', quality: 90, background_color: '#ffffff' } },
      { id: 'art_export_webp_0001', label: 'WebP', width: 320, height: 240, required: true, output: { format: 'webp', quality: 90, transparent: false } },
    ],
  })
  const versions: Record<string, string> = {}
  let current = specification.project
  for (const artboard of specification.spec.artboards) {
    const canvas = await workbench.createCanvas(project.id, {
      artboard_id: artboard.id, base_revision: current.revision,
      idempotency_key: `bb-image-multi-format-canvas-${artboard.output.format}-0001`,
    })
    const rendered = await workbench.renderCanvas(project.id, canvas.canvas.canvas_id, {
      base_revision: canvas.project.revision,
      idempotency_key: `bb-image-multi-format-render-${artboard.output.format}-0001`, canvas_revision: 0, activate_on_success: true,
    })
    versions[artboard.id] = rendered.version_id
    current = await workbench.getProject(project.id)
  }
  const exported = await workbench.exportDelivery(project.id, {
    base_revision: current.revision, idempotency_key: 'bb-image-multi-format-export-0001', version_ids_by_artboard: versions,
  })
  expect(exported.delivery_set?.version_ids_by_artboard).toEqual(versions)
  expect(exported.export_receipts.map(receipt => receipt.output_format).sort()).toEqual(['jpeg', 'png', 'webp'])
  const completed = await workbench.getProject(project.id)
  for (const receipt of exported.export_receipts) {
    const asset = completed.assets.find(candidate => candidate.id === receipt.output_asset_id)
    if (!asset) throw new Error('missing exported CAS asset')
    const verified = await workbench.assets.readVerified(asset)
    expect(verified.content_hash).toBe(receipt.output_hash)
    expect([verified.width, verified.height]).toEqual([receipt.width, receipt.height])
    expect((await workbench.exportAssetResponse(project.id, receipt.output_asset_id)).headers.get('content-type')).toBe(asset.mime_type)
  }
})

test('15.3 在 CAS 落盘后数据库提交前崩溃可由同一 Canvas Render 幂等键恢复', async () => {
  let shouldCrash = true
  const storageRoot = await root('render-crash')
  const legacyRoot = await root('render-crash-legacy')
  const crashed = new ImageWorkbenchService({ root: storageRoot, legacyMediaRoot: legacyRoot, now: () => new Date(timestamp), crashInjector: point => {
    if (point === 'after_canvas_render_cas_before_db_commit' && shouldCrash) { shouldCrash = false; throw new Error('injected canvas crash') }
  } })
  const setup = await projectWithCanvas(crashed)
  const prepared = await crashed.getProject(setup.project.id)
  await expect(crashed.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: prepared.revision, idempotency_key: 'bb-image-canvas-crash-replay-0001', canvas_revision: 0, activate_on_success: true,
  })).rejects.toThrow('injected canvas crash')
  const recovered = new ImageWorkbenchService({ root: storageRoot, legacyMediaRoot: legacyRoot, now: () => new Date(timestamp) })
  const rendered = await recovered.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: (await recovered.getProject(setup.project.id)).revision, idempotency_key: 'bb-image-canvas-crash-replay-0001', canvas_revision: 0, activate_on_success: true,
  })
  expect(rendered.operation.result).toMatchObject({ kind: 'rendered_version', version_id: rendered.version_id })
})
