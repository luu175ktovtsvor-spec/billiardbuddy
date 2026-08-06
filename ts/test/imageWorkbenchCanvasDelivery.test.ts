import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { assertSafeSvg, ImageCanvasRendererError, verifyRenderedQrManifest } from '../src/server/services/imageCanvasRenderer.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import { imageTicketRequest } from './helpers/imageUiTicket.js'

const roots: string[] = []
const timestamp = '2026-08-03T00:00:00.000Z'
const capability = '15-3-canvas-capability-token-0123456789'

function signedImageRequest(url: string | URL, init: RequestInit = {}): Request {
  return imageTicketRequest(new URL(url), init)
}

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

async function projectWithCanvasAssets(workbench: ImageWorkbenchService, referenceImages: Buffer[]) {
  const project = await workbench.createProject({
    title: '受控素材画布', user_request: '验证确定性图层合成', size: '1024x1024',
    reference_images: referenceImages.map(bytes => `data:image/png;base64,${bytes.toString('base64')}`),
    reference_roles: referenceImages.map((_, index) => index === 0 ? 'subject' : 'style'),
  })
  const delivery = await workbench.repository.currentDeliverySpec(project.id)
  if (!delivery) throw new Error('expected delivery specification')
  const canvas = await workbench.createCanvas(project.id, {
    artboard_id: delivery.artboards[0]!.id, base_revision: project.revision, idempotency_key: 'bb-image-canvas-asset-create-0001', background: { kind: 'transparent' },
  })
  return { project: canvas.project, canvas: canvas.canvas, artboard: delivery.artboards[0]! }
}

async function completedRender(workbench: ImageWorkbenchService, projectId: string, canvasId: string, input: Parameters<ImageWorkbenchService['renderCanvas']>[2]) {
  const queued = await workbench.renderCanvas(projectId, canvasId, input)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await workbench.applications.recovery.recoverInterruptedOperations()
    const operation = await workbench.getGenerationOperation(projectId, queued.operation.id)
    if (operation.result?.kind === 'rendered_version') {
      return {
        operation,
        version_id: operation.result.version_id,
        render_receipt: await workbench.repository.getRenderReceipt(projectId, operation.result.render_receipt_id),
      }
    }
    await Bun.sleep(5)
  }
  throw new Error('canvas render did not complete')
}

async function waitForCompletedExport(workbench: ImageWorkbenchService, projectId: string, operationId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await workbench.applications.recovery.recoverInterruptedOperations()
    const operation = await workbench.getGenerationOperation(projectId, operationId)
    if (operation.result?.kind === 'export_receipts') {
      const receipts = await Promise.all(operation.result.export_receipt_ids.map(async id => await workbench.repository.getExportReceipt(projectId, id)))
      return { operation, export_receipts: receipts, delivery_set: operation.result.delivery_set_id ? await workbench.repository.getDeliverySet(projectId, operation.result.delivery_set_id) : undefined }
    }
    await Bun.sleep(5)
  }
  throw new Error('export did not complete')
}

async function completedExport(workbench: ImageWorkbenchService, projectId: string, input: Parameters<ImageWorkbenchService['exportDelivery']>[1]) {
  const queued = await workbench.applications.delivery.exportDelivery(projectId, input)
  return await waitForCompletedExport(workbench, projectId, queued.operation.id)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true })))
})

test('15.3 Canvas 命令在同一项目锁事务内重放、冲突并保留独立画板修订', async () => {
  const workbench = await service('commands')
  const setup = await projectWithCanvas(workbench)
  const canvasApplication = workbench.applications.canvas
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
  const changed = await canvasApplication.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, first)
  expect(changed.canvas).toMatchObject({ revision: 1, parent_revision: 0 })
  const replay = await canvasApplication.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, first)
  expect(replay.canvas).toEqual(changed.canvas)
  await expect(canvasApplication.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    ...first,
    payload: { layer: { ...first.payload.layer, fill: '#654321' } },
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })

  const afterReplay = await workbench.getProject(setup.project.id)
  const concurrent = await Promise.allSettled([
    canvasApplication.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, afterReplay.revision, {
      idempotency_key: 'bb-image-canvas-command-15-3-0002', base_revision: 1, kind: 'add_layer',
      payload: { layer: { ...first.payload.layer, id: 'shape_canvas_0002', fill: '#aabbcc' } },
    }),
    canvasApplication.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, afterReplay.revision, {
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
  const synced = await canvasApplication.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, nextSpec.project.revision, {
    idempotency_key: 'bb-image-canvas-sync-command-0001', base_revision: latest.revision, kind: 'sync_delivery_spec',
    payload: { delivery_spec_id: nextSpec.spec.id, delivery_spec_revision: nextSpec.spec.revision, layout_policy: 'fit_safe_area' },
  })
  expect(synced.canvas.document).toMatchObject({ width: 512, height: 512, delivery_spec_revision: nextSpec.spec.revision })
  expect(synced.canvas.document.layers[0]).toMatchObject({ transform: { x: 10, y: 10, width: 150, height: 100 } })
})

test('15.3 Canvas Render 在项目升版后拒绝陈旧受理，并允许原幂等键重放已受理任务', async () => {
  const workbench = await service('render-project-revision')
  const setup = await projectWithCanvas(workbench)
  const changed = await workbench.updateProject(setup.project.id, {
    revision: setup.project.revision,
    user_request: '项目升版后的新需求',
    size: '1024x1024',
  })
  await expect(workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: setup.project.revision,
    idempotency_key: 'bb-image-canvas-stale-project-revision-0001',
    canvas_revision: setup.canvas.revision,
    activate_on_success: true,
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
  expect(await workbench.repository.listGenerationOperations(setup.project.id)).toHaveLength(0)

  const queued = await workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: changed.revision,
    idempotency_key: 'bb-image-canvas-replay-project-revision-0001',
    canvas_revision: setup.canvas.revision,
    activate_on_success: true,
  })
  const replay = await workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: changed.revision,
    idempotency_key: 'bb-image-canvas-replay-project-revision-0001',
    canvas_revision: setup.canvas.revision,
    activate_on_success: true,
  })
  expect(replay.operation.id).toBe(queued.operation.id)
})

test('15.3 Canvas Render 在预检与入队之间项目升版时不会接受陈旧操作', async () => {
  const workbench = await service('render-acceptance-race')
  const setup = await projectWithCanvas(workbench)
  const repository = workbench.repository
  const originalSave = repository.saveGenerationOperation.bind(repository)
  let raced = false
  repository.saveGenerationOperation = async operation => {
    if (!raced) {
      raced = true
      const current = await workbench.getProject(setup.project.id)
      await workbench.updateProject(setup.project.id, {
        revision: current.revision,
        user_request: '预检完成后项目发生升版',
        size: current.size,
      })
    }
    return await originalSave(operation)
  }

  await expect(workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: setup.project.revision,
    idempotency_key: 'bb-image-canvas-acceptance-race-0001',
    canvas_revision: setup.canvas.revision,
    activate_on_success: true,
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
  expect(raced).toBe(true)
  expect(await repository.listGenerationOperations(setup.project.id)).toHaveLength(0)
})

test('15.5 Canvas Application 的 API 命令路由保持重放、幂等冲突和同项目并发原子性', async () => {
  const workbench = await service('canvas-application-api')
  const setup = await projectWithCanvas(workbench)
  const handler = createImageWorkbenchDomainApiHandler(workbench.applications, capability)
  const url = `http://127.0.0.1/api/images/projects/${setup.project.id}/canvases/${setup.canvas.canvas_id}/commands`
  const segments = ['api', 'images', 'projects', setup.project.id, 'canvases', setup.canvas.canvas_id, 'commands']
  const request = (baseProjectRevision: number, command: object) => signedImageRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({ base_project_revision: baseProjectRevision, command }),
  })
  const invoke = async (baseProjectRevision: number, command: object) => await handler(
    request(baseProjectRevision, command),
    new URL(url),
    segments,
  )
  const first = {
    idempotency_key: 'bb-image-canvas-application-api-0001', base_revision: 0, kind: 'add_layer' as const,
    payload: { layer: {
      id: 'shape_canvas_application_api_0001', kind: 'shape' as const, shape: 'rectangle' as const,
      transform: { x: 40, y: 40, width: 200, height: 120, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
      fill: '#224466', opacity: 1,
    } },
  }
  const created = await invoke(setup.project.revision, first)
  expect(created.status).toBe(200)
  const createdBody = await created.json() as { canvas: { revision: number }; project_revision: number }
  expect(createdBody).toMatchObject({ canvas: { revision: 1 }, project_revision: setup.project.revision + 1 })

  const replay = await invoke(setup.project.revision, first)
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual(createdBody)

  const collision = await invoke(createdBody.project_revision, {
    ...first,
    payload: { layer: { ...first.payload.layer, fill: '#cc8844' } },
  })
  expect(collision.status).toBe(409)
  expect(await collision.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })

  const commandProject = await workbench.getProject(setup.project.id)
  const commandCanvas = await workbench.getCanvas(setup.project.id, setup.canvas.canvas_id)
  const [left, right] = await Promise.all([
    invoke(commandProject.revision, {
      idempotency_key: 'bb-image-canvas-application-api-0002', base_revision: commandCanvas.revision, kind: 'add_layer',
      payload: { layer: { ...first.payload.layer, id: 'shape_canvas_application_api_0002', fill: '#338855' } },
    }),
    invoke(commandProject.revision, {
      idempotency_key: 'bb-image-canvas-application-api-0003', base_revision: commandCanvas.revision, kind: 'add_layer',
      payload: { layer: { ...first.payload.layer, id: 'shape_canvas_application_api_0003', fill: '#885533' } },
    }),
  ])
  const statuses = [left.status, right.status].sort((a, b) => a - b)
  expect(statuses).toEqual([200, 409])
  expect((await workbench.getCanvas(setup.project.id, setup.canvas.canvas_id)).revision).toBe(commandCanvas.revision + 1)
})

test('15.3 在入 CAS 前完整解码图片，拒绝只有合法 PNG 头的截断字节', async () => {
  const workbench = await service('complete-decode')
  const encoded = await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.base64'), 'utf8')
  const bytes = Buffer.from(encoded.trim(), 'base64')
  await expect(workbench.assets.verify(bytes.subarray(0, 60))).rejects.toMatchObject({ code: 'IMAGE_ASSET_INVALID' })
  await expect(workbench.assets.verify(bytes)).resolves.toMatchObject({ width: 1, height: 1, mime_type: 'image/png' })
})

test('15.3 Raster opacity 与同级 Mask 在正式 Canvas 像素路径中相乘', async () => {
  const workbench = await service('mask-opacity')
  const [source, mask] = await Promise.all([
    sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(),
    sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } } }).png().toBuffer(),
  ])
  const setup = await projectWithCanvasAssets(workbench, [source, mask])
  const project = await workbench.getProject(setup.project.id)
  const raster = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, project.revision, {
    idempotency_key: 'bb-image-mask-raster-0001', base_revision: 0, kind: 'add_layer',
    payload: { layer: { id: 'raster_mask_target_0001', kind: 'raster', source_asset_id: project.assets[0]!.id, transform: { x: 0, y: 0, width: 1024, height: 1024, rotation_degrees: 0, scale_x: 1, scale_y: 1 }, opacity: 0.5, blend_mode: 'normal' } },
  })
  const masked = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, raster.project.revision, {
    idempotency_key: 'bb-image-mask-layer-0001', base_revision: raster.canvas.revision, kind: 'add_layer',
    payload: { layer: { id: 'mask_layer_0001', kind: 'mask', source_asset_id: project.assets[1]!.id, target_layer_id: 'raster_mask_target_0001', mode: 'alpha' } },
  })
  const rendered = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: masked.project.revision, idempotency_key: 'bb-image-mask-render-0001', canvas_revision: masked.canvas.revision, activate_on_success: true,
  })
  const completed = await workbench.getProject(setup.project.id)
  const version = completed.versions.find(item => item.id === rendered.version_id)
  const output = version && completed.assets.find(asset => asset.id === version.asset_ids[0])
  if (!output) throw new Error('expected rendered Canvas asset')
  const pixels = await sharp((await workbench.assets.readVerified(output)).bytes)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  expect(pixels.data[(512 * pixels.info.width + 512) * 4 + 3]).toBeGreaterThanOrEqual(62)
  expect(pixels.data[(512 * pixels.info.width + 512) * 4 + 3]).toBeLessThanOrEqual(66)
})

test('15.3 Template 以受控叠加层填充 Slot，保留既有 Candidate Raster 并以锁定 Brand revision 渲染', async () => {
  const workbench = await service('template-brand')
  const candidateBytes = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).png().toBuffer()
  const setup = await projectWithCanvasAssets(workbench, [candidateBytes])
  const projectWithCandidate = await workbench.getProject(setup.project.id)
  const candidateRaster = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, projectWithCandidate.revision, {
    idempotency_key: 'bb-image-template-preserved-candidate-0001', base_revision: setup.canvas.revision, kind: 'add_layer',
    // Deliberately collide with the Template source ID. The applied Template
    // must namespace its controlled layers instead of replacing this Raster.
    payload: { layer: {
      id: 'text_template_slot_0001', kind: 'raster', source_asset_id: projectWithCandidate.assets[0]!.id,
      transform: { x: 0, y: 0, width: 1024, height: 1024, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
      opacity: 1, blend_mode: 'normal', clip_to_artboard: true,
    } },
  })
  const createdBrand = await workbench.createBrandKit({
    idempotency_key: 'bb-image-template-brand-create-0001',
    name: '画布测试品牌包',
    revision: {
      logo_asset_ids: [],
      font_asset_ids: ['font_builtin_0001'],
      color_tokens: { primary: '#d02020' },
      required_text: [{ id: 'req_canvas_0001', value: '台球夏季冠军赛', purpose: 'slogan' }],
    },
  })
  const brand = createdBrand.revision
  const createdTemplate = await workbench.createTemplate({
    idempotency_key: 'bb-image-template-canvas-create-0001',
    name: '画布测试模板',
    revision: {
      brand_kit_id: createdBrand.brand_kit.id,
      brand_kit_revision_id: brand.id,
      blueprint: { schema_version: 1, artboard: { width: 1024, height: 1024 }, background: { kind: 'solid', color: 'brand.primary' }, layers: [{
        id: 'text_template_slot_0001', kind: 'text', text: 'placeholder', font_family: 'BilliardBuddy Builtin CJK', font_asset_id: 'font_builtin_0001', font_size: 72, min_font_size: 48,
        font_weight: 700, font_style: 'normal', line_height: 1.2, letter_spacing: 0, fill: 'brand.primary', position: { x: 80, y: 160 }, rotation_degrees: 0,
        max_width: 820, max_height: 160, overflow: 'shrink_to_fit', locale: 'zh-CN', align: 'left', opacity: 1,
      }] },
      slots: [{ id: 'slot_title_0001', layer_id: 'text_template_slot_0001', kind: 'text', required: true }],
      schema_version: 1,
    },
  })
  const template = createdTemplate.revision
  const revisedTemplate = await workbench.reviseTemplate(createdTemplate.template.id, {
    base_revision: createdTemplate.template.revision,
    idempotency_key: 'bb-image-template-canvas-revise-0001',
    revision: {
      brand_kit_id: brand.brand_kit_id,
      brand_kit_revision_id: brand.id,
      blueprint: template.blueprint,
      slots: template.slots,
      schema_version: template.schema_version,
    },
  })
  expect(revisedTemplate.template.current_revision_id).not.toBe(template.id)
  const applyInitialRevision = {
    idempotency_key: 'bb-image-template-apply-0001', base_revision: candidateRaster.canvas.revision, kind: 'apply_template',
    payload: { template_id: template.template_id, template_revision_id: template.id, slot_bindings: [{ slot_id: 'slot_title_0001', text: '台球夏季冠军赛' }] },
  } as const
  const applied = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, candidateRaster.project.revision, applyInitialRevision)
  expect(applied.canvas.document).toMatchObject({ template_id: template.template_id, template_revision_id: template.id, brand_kit_id: brand.brand_kit_id, brand_kit_revision_id: brand.id })
  expect(applied.canvas.document.layers[0]).toMatchObject({ id: 'text_template_slot_0001', kind: 'raster', source_asset_id: projectWithCandidate.assets[0]!.id })
  const overlay = applied.canvas.document.layers.at(-1)
  if (!overlay || overlay.kind !== 'group') throw new Error('expected controlled Template overlay group')
  const overlayId = overlay.id
  expect(overlay).toMatchObject({ id: expect.stringMatching(/^tplov_/), children: [{ kind: 'text', text: '台球夏季冠军赛', fill: 'brand.primary' }] })
  expect(overlay.children[0]?.id).toMatch(/^tplay_/)
  expect(overlay.children[0]?.id).not.toBe('text_template_slot_0001')
  await expect(workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, applied.project.revision, {
    idempotency_key: 'bb-image-template-overlay-remove-0001', base_revision: applied.canvas.revision, kind: 'remove_layer',
    payload: { layer_id: overlayId },
  })).rejects.toMatchObject({ status: 400, code: 'IMAGE_STORAGE_INVALID' })
  await expect(workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, applied.project.revision, {
    idempotency_key: 'bb-image-template-overlay-mask-0001', base_revision: applied.canvas.revision, kind: 'add_layer',
    payload: { layer: {
      id: 'mask_template_overlay_target_0001', kind: 'mask', source_asset_id: projectWithCandidate.assets[0]!.id,
      target_layer_id: overlay.children[0]!.id, mode: 'alpha',
    } },
  })).rejects.toMatchObject({ status: 400, code: 'IMAGE_STORAGE_INVALID' })
  const afterUserEdit = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, applied.project.revision, {
    idempotency_key: 'bb-image-template-overlay-user-edit-0001', base_revision: applied.canvas.revision, kind: 'add_layer',
    payload: { layer: {
      id: 'shape_template_overlay_user_0001', kind: 'shape', shape: 'rectangle',
      transform: { x: 0, y: 0, width: 8, height: 8, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
      fill: '#ffffff', opacity: 1,
    } },
  })
  expect(afterUserEdit.canvas.document.layers.at(-1)?.id).toBe(overlayId)
  expect((await workbench.preflightCanvas(setup.project.id, setup.canvas.canvas_id, { revision: afterUserEdit.canvas.revision })).passed).toBeTrue()
  const rendered = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: afterUserEdit.project.revision, idempotency_key: 'bb-image-template-render-0001', canvas_revision: afterUserEdit.canvas.revision, activate_on_success: true,
  })
  expect(rendered.render_receipt).toMatchObject({ brand_kit_revision_id: brand.id, template_revision_id: template.id })
  const completed = await workbench.getProject(setup.project.id)
  const version = completed.versions.find(item => item.id === rendered.version_id)
  const output = version && completed.assets.find(asset => asset.id === version.asset_ids[0])
  if (!output) throw new Error('expected rendered Template Canvas asset')
  const pixels = await sharp((await workbench.assets.readVerified(output)).bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const center = (512 * pixels.info.width + 512) * 4
  expect([...pixels.data.subarray(center, center + 4)]).toEqual([12, 34, 56, 255])
  const replayAfterRevision = await workbench.applyCanvasCommand(
    setup.project.id, setup.canvas.canvas_id, candidateRaster.project.revision, applyInitialRevision,
  )
  expect(replayAfterRevision.canvas.revision).toBe(applied.canvas.revision)
  await workbench.trashTemplate(createdTemplate.template.id, {
    base_revision: revisedTemplate.template.revision,
    idempotency_key: 'bb-image-template-canvas-trash-0001',
  })
  const replayAfterTrash = await workbench.applyCanvasCommand(
    setup.project.id, setup.canvas.canvas_id, candidateRaster.project.revision, applyInitialRevision,
  )
  expect(replayAfterTrash.canvas.revision).toBe(applied.canvas.revision)
  const latest = await workbench.getProject(setup.project.id)
  await expect(workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, latest.revision, {
    ...applyInitialRevision,
    idempotency_key: 'bb-image-template-apply-after-trash-0001',
    base_revision: applied.canvas.revision,
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_STORAGE_INVALID' })
}, 15_000)

test('15.5C 未锁定 Brand 的 background Token 会在预检阶段失败', async () => {
  const workbench = await service('background-brand-token')
  const setup = await projectWithCanvas(workbench)
  const template = await workbench.createTemplate({
    idempotency_key: 'bb-image-background-token-template-create-0001',
    name: '无品牌背景 Token 模板',
    revision: {
      blueprint: {
        schema_version: 1,
        artboard: { width: 1024, height: 1024 },
        background: { kind: 'solid', color: 'brand.primary' },
        layers: [],
      },
      slots: [],
      schema_version: 1,
    },
  })
  const applied = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    idempotency_key: 'bb-image-background-token-template-apply-0001', base_revision: setup.canvas.revision, kind: 'apply_template',
    payload: { template_id: template.template.id, template_revision_id: template.revision.id, slot_bindings: [] },
  })
  const preflight = await workbench.preflightCanvas(setup.project.id, setup.canvas.canvas_id, { revision: applied.canvas.revision })
  expect(preflight.passed).toBeFalse()
  expect(preflight.checks.find(check => check.id === 'brand-revision')).toMatchObject({
    status: 'fail',
    evidence: expect.stringContaining('brand.*'),
  })
})

test('15.3 Template 叠加不会静默突破 Canvas 图层上限', async () => {
  const workbench = await service('template-overlay-budget')
  const setup = await projectWithCanvas(workbench)
  const template = await workbench.createTemplate({
    idempotency_key: 'bb-image-template-overlay-budget-create-0001',
    name: '图层预算模板',
    revision: {
      blueprint: {
        schema_version: 1,
        artboard: { width: 1024, height: 1024 },
        background: { kind: 'transparent' },
        layers: [{
          id: 'shape_template_budget_0001', kind: 'shape', shape: 'rectangle',
          transform: { x: 100, y: 100, width: 200, height: 200, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
          fill: '#112233', opacity: 1,
        }],
      },
      slots: [],
      schema_version: 1,
    },
  })
  const saturated = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    idempotency_key: 'bb-image-template-overlay-budget-fill-0001', base_revision: setup.canvas.revision, kind: 'add_layer',
    payload: {
      layer: {
        id: 'group_canvas_budget_0001', kind: 'group', children: Array.from({ length: 78 }, (_, index) => ({
          id: `shape_canvas_budget_${String(index).padStart(4, '0')}`,
          kind: 'shape' as const,
          shape: 'rectangle' as const,
          transform: { x: index, y: index, width: 1, height: 1, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
          fill: '#000000', opacity: 1,
        })),
      },
    },
  })
  await expect(workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, saturated.project.revision, {
    idempotency_key: 'bb-image-template-overlay-budget-apply-0001', base_revision: saturated.canvas.revision, kind: 'apply_template',
    payload: { template_id: template.template.id, template_revision_id: template.revision.id, slot_bindings: [] },
  })).rejects.toMatchObject({ status: 400, code: 'IMAGE_STORAGE_INVALID' })
})

test('15.3 未显式 CAS 指针的后续 Canvas revision 会在受理时锁定 current pointer 并正常激活', async () => {
  const workbench = await service('late-revision-activation')
  const setup = await projectWithCanvas(workbench)
  const firstEdit = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    idempotency_key: 'bb-image-late-activation-edit-0001', base_revision: 0, kind: 'add_layer',
    payload: { layer: { id: 'shape_late_activation_0001', kind: 'shape', shape: 'rectangle', transform: { x: 30, y: 30, width: 400, height: 200, rotation_degrees: 0, scale_x: 1, scale_y: 1 }, fill: '#113355', opacity: 1 } },
  })
  const first = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: firstEdit.project.revision, idempotency_key: 'bb-image-late-activation-render-0001', canvas_revision: firstEdit.canvas.revision, activate_on_success: true,
  })
  expect((await workbench.getProject(setup.project.id)).current_versions_by_artboard[setup.artboard.id]).toBe(first.version_id)
  const nextProject = await workbench.getProject(setup.project.id)
  const secondEdit = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, nextProject.revision, {
    idempotency_key: 'bb-image-late-activation-edit-0002', base_revision: firstEdit.canvas.revision, kind: 'add_layer',
    payload: { layer: { id: 'shape_late_activation_0002', kind: 'shape', shape: 'ellipse', transform: { x: 500, y: 500, width: 160, height: 160, rotation_degrees: 0, scale_x: 1, scale_y: 1 }, fill: '#cc8844', opacity: 1 } },
  })
  const second = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: secondEdit.project.revision, idempotency_key: 'bb-image-late-activation-render-0002', canvas_revision: secondEdit.canvas.revision, activate_on_success: true,
  })
  expect(second.operation.completion_freshness).toBe('current')
  expect((await workbench.getProject(setup.project.id)).current_versions_by_artboard[setup.artboard.id]).toBe(second.version_id)
}, 15_000)

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
  const firstRender = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: qr.project.revision,
    idempotency_key: 'bb-image-canvas-render-old-0001',
    canvas_revision: changed.canvas.revision,
    activate_on_success: true,
  })
  const firstOutputHash = firstRender.render_receipt.output_hash
  expect(firstRender.render_receipt).toMatchObject({ canvas_revision: 1, output_hash: expect.stringMatching(/^sha256:/) })
  const secondProject = await workbench.getProject(setup.project.id)
  const secondRender = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: secondProject.revision,
    idempotency_key: 'bb-image-canvas-render-current-0001',
    canvas_revision: qr.canvas.revision,
    activate_on_success: true,
  })
  expect(secondRender.operation.completion_freshness).toBe('current')
  const staleProject = await workbench.getProject(setup.project.id)
  const staleRender = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: staleProject.revision,
    idempotency_key: 'bb-image-canvas-render-stale-0001',
    canvas_revision: changed.canvas.revision,
    activate_on_success: true,
    expected_current_version_id: secondRender.version_id,
  })
  expect(staleRender.operation.completion_freshness).toBe('stale')
  expect(staleRender.render_receipt.output_hash).toBe(firstOutputHash)
  const exportProject = await workbench.getProject(setup.project.id)
  const exported = await completedExport(workbench, setup.project.id, {
    base_revision: exportProject.revision,
    idempotency_key: 'bb-image-canvas-export-15-3-0001',
    version_ids_by_artboard: { [setup.artboard.id]: secondRender.version_id },
  })
  expect(exported.delivery_set?.version_ids_by_artboard[setup.artboard.id]).toBe(secondRender.version_id)
  expect(exported.export_receipts[0]).toMatchObject({ width: setup.artboard.width, height: setup.artboard.height, output_hash: expect.stringMatching(/^sha256:/) })

  const handler = createImageWorkbenchDomainApiHandler(workbench.applications, capability)
  const projectUrl = new URL(`http://127.0.0.1/api/images/projects/${setup.project.id}`)
  const projected = await handler(new Request(projectUrl), projectUrl, ['api', 'images', 'projects', setup.project.id])
  expect(projected.status).toBe(200)
  const publicProject = await projected.json() as { project: { version_history: Array<Record<string, unknown>> } }
  expect(publicProject.project.version_history.find(version => version.id === secondRender.version_id)).toMatchObject({
    id: secondRender.version_id,
    kind: 'canvas',
    artboard_id: setup.artboard.id,
    canvas_id: setup.canvas.canvas_id,
    canvas_revision: qr.canvas.revision,
  })
  const commandUrl = new URL(`http://127.0.0.1/api/images/projects/${setup.project.id}/canvases/${setup.canvas.canvas_id}/commands`)
  const response = await handler(signedImageRequest(commandUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({ base_project_revision: (await workbench.getProject(setup.project.id)).revision, command: { ...shape, payload: { layer: { ...shape.payload.layer, fill: '#ffeeaa' } } } }),
  }), commandUrl, ['api', 'images', 'projects', setup.project.id, 'canvases', setup.canvas.canvas_id, 'commands'])
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })
  expect(() => assertSafeSvg('<svg><script>alert(1)</script></svg>')).toThrow('SVG')

  const protectedUrl = `http://127.0.0.1/api/images/projects/${setup.project.id}/versions/${secondRender.version_id}/content`
  const denied = await handler(new Request(protectedUrl), new URL(protectedUrl), ['api', 'images', 'projects', setup.project.id, 'versions', secondRender.version_id, 'content'])
  expect(denied.status).toBe(403)
  const allowed = await handler(signedImageRequest(protectedUrl, { headers: { 'X-BilliardBuddy-Media-Capability': capability } }), new URL(protectedUrl), ['api', 'images', 'projects', setup.project.id, 'versions', secondRender.version_id, 'content'])
  expect(allowed.status).toBe(200)
  expect(allowed.headers.get('x-billiardbuddy-media-hash')).toMatch(/^sha256:/)
  const receiptUrl = `http://127.0.0.1/api/images/projects/${setup.project.id}/export-receipts/${exported.export_receipts[0]!.id}`
  const receiptResponse = await handler(signedImageRequest(receiptUrl, {
    headers: { 'X-BilliardBuddy-Media-Capability': capability },
  }), new URL(receiptUrl), ['api', 'images', 'projects', setup.project.id, 'export-receipts', exported.export_receipts[0]!.id])
  expect(receiptResponse.status).toBe(200)
  expect(await receiptResponse.json()).toMatchObject({
    export_receipt: {
      id: exported.export_receipts[0]!.id,
      output_hash: exported.export_receipts[0]!.output_hash,
      byte_size: exported.export_receipts[0]!.byte_size,
      created_at: exported.export_receipts[0]!.created_at,
    },
  })
}, 15_000)

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
  const rendered = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
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

test('15.3 预检以旋转后的真实像素边界拒绝越过 Delivery Spec 安全区的二维码', async () => {
  const workbench = await service('safe-area-mask')
  const setup = await projectWithCanvas(workbench)
  const spec = await workbench.createDeliverySpecRevision(setup.project.id, {
    base_revision: setup.project.revision, idempotency_key: 'bb-image-safe-area-spec-0001', purpose: 'custom',
    artboards: [{ ...setup.artboard, safe_area: { top: 80, right: 80, bottom: 80, left: 80 } }],
  })
  const synced = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, spec.project.revision, {
    idempotency_key: 'bb-image-safe-area-sync-0001', base_revision: 0, kind: 'sync_delivery_spec',
    payload: { delivery_spec_id: spec.spec.id, delivery_spec_revision: spec.spec.revision, layout_policy: 'preserve_position' },
  })
  const withQr = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, synced.project.revision, {
    idempotency_key: 'bb-image-safe-area-qr-0001', base_revision: synced.canvas.revision, kind: 'add_layer',
    payload: { layer: { id: 'qrcode_safe_0001', kind: 'qrcode', source: { kind: 'payload', value: 'https://example.test/safe' }, transform: { x: 80, y: 80, width: 160, height: 160, rotation_degrees: 45, scale_x: 1, scale_y: 1 }, error_correction: 'H', quiet_zone_modules: 4, verify_after_render: true } },
  })
  const preflight = await workbench.preflightCanvas(setup.project.id, setup.canvas.canvas_id, { revision: withQr.canvas.revision })
  expect(preflight.checks.find(check => check.id === 'required-safe-area')).toMatchObject({ status: 'fail', waivable: false, evidence: '必填文字、Logo 或二维码越过交付安全区：qrcode_safe_0001=47,47,226×226' })
})

test('15.3 安全区预检以 Text 缩放旋转和 Logo 旋转后的真实边界判定', async () => {
  const textWorkbench = await service('safe-area-transformed-text')
  const textSetup = await projectWithCanvas(textWorkbench)
  const textSpec = await textWorkbench.createDeliverySpecRevision(textSetup.project.id, {
    base_revision: textSetup.project.revision, idempotency_key: 'bb-image-safe-area-text-spec-0001', purpose: 'custom',
    artboards: [{ ...textSetup.artboard, safe_area: { top: 80, right: 80, bottom: 80, left: 80 } }],
  })
  const textSynced = await textWorkbench.applyCanvasCommand(textSetup.project.id, textSetup.canvas.canvas_id, textSpec.project.revision, {
    idempotency_key: 'bb-image-safe-area-text-sync-0001', base_revision: 0, kind: 'sync_delivery_spec',
    payload: { delivery_spec_id: textSpec.spec.id, delivery_spec_revision: textSpec.spec.revision, layout_policy: 'preserve_position' },
  })
  const text = await textWorkbench.applyCanvasCommand(textSetup.project.id, textSetup.canvas.canvas_id, textSynced.project.revision, {
    idempotency_key: 'bb-image-safe-area-text-layer-0001', base_revision: textSynced.canvas.revision, kind: 'add_layer',
    payload: { layer: {
      id: 'text_safe_transformed_0001', kind: 'text', text: '台球冠军赛', font_family: 'BilliardBuddy Builtin CJK', font_asset_id: 'font_builtin_0001',
      font_size: 48, font_weight: 400, font_style: 'normal', line_height: 1.2, letter_spacing: 0, fill: '#ffffff', position: { x: 80, y: 80 },
      rotation_degrees: 45, scale_x: 1.5, scale_y: 1.25, max_width: 160, max_height: 100, overflow: 'error', locale: 'zh-CN', align: 'left', opacity: 1,
    } },
  })
  expect((await textWorkbench.preflightCanvas(textSetup.project.id, textSetup.canvas.canvas_id, { revision: text.canvas.revision })).checks.find(check => check.id === 'required-safe-area')).toMatchObject({ status: 'fail', waivable: false })

  const logoWorkbench = await service('safe-area-transformed-logo')
  const source = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer()
  const logoSetup = await projectWithCanvasAssets(logoWorkbench, [source])
  const logoSpec = await logoWorkbench.createDeliverySpecRevision(logoSetup.project.id, {
    base_revision: logoSetup.project.revision, idempotency_key: 'bb-image-safe-area-logo-spec-0001', purpose: 'custom',
    artboards: [{ ...logoSetup.artboard, safe_area: { top: 80, right: 80, bottom: 80, left: 80 } }],
  })
  const logoSynced = await logoWorkbench.applyCanvasCommand(logoSetup.project.id, logoSetup.canvas.canvas_id, logoSpec.project.revision, {
    idempotency_key: 'bb-image-safe-area-logo-sync-0001', base_revision: 0, kind: 'sync_delivery_spec',
    payload: { delivery_spec_id: logoSpec.spec.id, delivery_spec_revision: logoSpec.spec.revision, layout_policy: 'preserve_position' },
  })
  const logoProject = await logoWorkbench.getProject(logoSetup.project.id)
  const logo = await logoWorkbench.applyCanvasCommand(logoSetup.project.id, logoSetup.canvas.canvas_id, logoSynced.project.revision, {
    idempotency_key: 'bb-image-safe-area-logo-layer-0001', base_revision: logoSynced.canvas.revision, kind: 'add_layer',
    payload: { layer: { id: 'logo_safe_transformed_0001', kind: 'logo', source_asset_id: logoProject.assets[0]!.id, transform: { x: 80, y: 80, width: 160, height: 160, rotation_degrees: 45, scale_x: 1, scale_y: 1 }, preserve_exact_source: true, render_mode: 'raster_exact' } },
  })
  expect((await logoWorkbench.preflightCanvas(logoSetup.project.id, logoSetup.canvas.canvas_id, { revision: logo.canvas.revision })).checks.find(check => check.id === 'required-safe-area')).toMatchObject({ status: 'fail', waivable: false, evidence: expect.stringContaining('logo_safe_transformed_0001=47,47,226×226') })
})

test('15.3 交付集会锁定全部 required Artboard，并逐份解码 QR、复核 PNG、JPEG、WebP 哈希', async () => {
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
    const withQr = await workbench.applyCanvasCommand(project.id, canvas.canvas.canvas_id, canvas.project.revision, {
      idempotency_key: `bb-image-multi-format-qr-${artboard.output.format}-0001`, base_revision: 0, kind: 'add_layer',
      payload: { layer: {
        id: `qrcode_export_${artboard.output.format}_0001`, kind: 'qrcode', source: { kind: 'payload', value: `https://example.test/export/${artboard.output.format}` },
        transform: { x: 40, y: 40, width: 180, height: 180, rotation_degrees: 0, scale_x: 1, scale_y: 1 }, error_correction: 'H', quiet_zone_modules: 4, verify_after_render: true,
      } },
    })
    const rendered = await completedRender(workbench, project.id, canvas.canvas.canvas_id, {
      base_revision: withQr.project.revision,
      idempotency_key: `bb-image-multi-format-render-${artboard.output.format}-0001`, canvas_revision: withQr.canvas.revision, activate_on_success: true,
    })
    versions[artboard.id] = rendered.version_id
    current = await workbench.getProject(project.id)
  }
  const exported = await completedExport(workbench, project.id, {
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
    expect((await workbench.deliveryApplication.readMediaAsset(project.id, receipt.output_asset_id, 'export')).mime_type).toBe(asset.mime_type)
    const version = completed.versions.find(candidate => candidate.id === receipt.version_id)
    if (!version?.render_receipt_id) throw new Error('missing render receipt')
    const renderReceipt = await workbench.repository.getRenderReceipt(project.id, version.render_receipt_id)
    expect(renderReceipt.qr_manifest).toHaveLength(1)
    await expect(verifyRenderedQrManifest(verified.bytes, renderReceipt.qr_manifest)).resolves.toBeUndefined()
  }
})

test('15.3 CJK 换行与 shrink 使用锁定字体度量，并把可复核 layout manifest 写入每个收据', async () => {
  const workbench = await service('cjk-layout')
  const setup = await projectWithCanvas(workbench)
  const changed = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    idempotency_key: 'bb-image-cjk-layout-command-0001', base_revision: 0, kind: 'add_layer',
    payload: { layer: {
      id: 'text_cjk_layout_0001', kind: 'text', text: '台球夏季冠军赛正式交付海报邀请函', font_family: 'BilliardBuddy Builtin CJK', font_asset_id: 'font_builtin_0001',
      font_size: 72, min_font_size: 36, font_weight: 400, font_style: 'normal', line_height: 1.1, letter_spacing: 0,
      fill: '#112233', position: { x: 40, y: 40 }, rotation_degrees: 0, max_width: 280, max_height: 170, overflow: 'shrink_to_fit', locale: 'zh-CN', align: 'left', opacity: 1,
    } },
  })
  const first = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: changed.project.revision, idempotency_key: 'bb-image-cjk-layout-render-0001', canvas_revision: changed.canvas.revision, activate_on_success: true,
  })
  const second = await completedRender(workbench, setup.project.id, setup.canvas.canvas_id, {
    base_revision: (await workbench.getProject(setup.project.id)).revision, idempotency_key: 'bb-image-cjk-layout-render-0002', canvas_revision: changed.canvas.revision, activate_on_success: false,
  })
  const layout = first.render_receipt.text_layout_manifest[0]
  if (!layout) throw new Error('expected CJK layout manifest')
  expect(Number(layout.font_size)).toBeLessThan(72)
  expect(layout.id).toBe('text_cjk_layout_0001')
  expect(layout.lines.length).toBeGreaterThan(1)
  expect(second.render_receipt.text_layout_manifest).toEqual(first.render_receipt.text_layout_manifest)
  expect(second.render_receipt.text_manifest_hash).toBe(first.render_receipt.text_manifest_hash)
  expect(second.render_receipt.output_hash).toBe(first.render_receipt.output_hash)
}, 15_000)

test('15.3 Canvas 与 Export 的可预期永久失败都会收敛为 failed，重启恢复不再重试', async () => {
  const failingRenderer = {
    render: async () => { throw new ImageCanvasRendererError('画布内容永久无效', 'CANVAS_RENDER_INVALID') },
  } as unknown as ConstructorParameters<typeof ImageWorkbenchService>[0]['canvasRenderer']
  const workbench = new ImageWorkbenchService({
    root: await root('terminal-local'), legacyMediaRoot: await root('terminal-local-legacy'), now: () => new Date(timestamp), canvasRenderer: failingRenderer,
  })
  const setup = await projectWithCanvas(workbench)
  const render = await workbench.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: setup.project.revision, idempotency_key: 'bb-image-terminal-canvas-0001', canvas_revision: 0, activate_on_success: true,
  })
  const exportJob = await workbench.applications.delivery.exportDelivery(setup.project.id, {
    base_revision: setup.project.revision, idempotency_key: 'bb-image-terminal-export-0001', version_ids_by_artboard: { [setup.artboard.id]: 'ver_missing_terminal_0001' },
  })
  await Bun.sleep(10)
  await workbench.applications.recovery.recoverInterruptedOperations()
  const [failedRender, failedExport] = await Promise.all([
    workbench.getGenerationOperation(setup.project.id, render.operation.id),
    workbench.getGenerationOperation(setup.project.id, exportJob.operation.id),
  ])
  expect(failedRender).toMatchObject({ status: 'failed', safe_error: { code: 'CANVAS_RENDER_INVALID' } })
  expect(failedExport).toMatchObject({ status: 'failed', safe_error: { code: 'IMAGE_VERSION_NOT_FOUND' } })
  await workbench.applications.recovery.recoverInterruptedOperations()
  expect((await workbench.getGenerationOperation(setup.project.id, render.operation.id)).status).toBe('failed')
  expect((await workbench.getGenerationOperation(setup.project.id, exportJob.operation.id)).status).toBe('failed')
})

test('15.3 fit_safe_area 会把受控内容等比放进目标安全区，而不是只缩放整张画板', async () => {
  const workbench = await service('fit-safe-area')
  const setup = await projectWithCanvas(workbench)
  const withQr = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, setup.project.revision, {
    idempotency_key: 'bb-image-fit-safe-area-layer-0001', base_revision: 0, kind: 'add_layer',
    payload: { layer: { id: 'qrcode_fit_safe_0001', kind: 'qrcode', source: { kind: 'payload', value: 'https://example.test/fit-safe-area' }, transform: { x: 0, y: 0, width: 256, height: 256, rotation_degrees: 0, scale_x: 1, scale_y: 1 }, error_correction: 'H', quiet_zone_modules: 4, verify_after_render: true } },
  })
  const specification = await workbench.createDeliverySpecRevision(setup.project.id, {
    base_revision: withQr.project.revision, idempotency_key: 'bb-image-fit-safe-area-spec-0001', purpose: 'custom',
    artboards: [{ ...setup.artboard, width: 1200, height: 800, safe_area: { top: 100, right: 200, bottom: 100, left: 200 } }],
  })
  const synced = await workbench.applyCanvasCommand(setup.project.id, setup.canvas.canvas_id, specification.project.revision, {
    idempotency_key: 'bb-image-fit-safe-area-sync-0001', base_revision: withQr.canvas.revision, kind: 'sync_delivery_spec',
    payload: { delivery_spec_id: specification.spec.id, delivery_spec_revision: specification.spec.revision, layout_policy: 'fit_safe_area' },
  })
  const qr = synced.canvas.document.layers.find(layer => layer.id === 'qrcode_fit_safe_0001')
  expect(qr).toMatchObject({ kind: 'qrcode', transform: { x: 300, y: 100, width: 150, height: 150 } })
  expect((await workbench.preflightCanvas(setup.project.id, setup.canvas.canvas_id, { revision: synced.canvas.revision })).checks.find(check => check.id === 'required-safe-area')).toMatchObject({ status: 'pass' })
})

test('15.3 遗留图片写接口只能由 Main 持有 capability 后调用', async () => {
  const workbench = await service('legacy-write-gate')
  const handler = createImageWorkbenchDomainApiHandler(workbench.applications, capability)
  const createUrl = 'http://127.0.0.1/api/images/projects'
  const createPayload = { title: '旧写接口门禁', user_request: '仅允许 Main 调用', size: '1024x1024', reference_images: [], reference_roles: [] }
  const deniedCreate = await handler(new Request(createUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createPayload) }), new URL(createUrl), ['api', 'images', 'projects'])
  expect(deniedCreate.status).toBe(403)
  const project = await workbench.createProject({ title: '旧写接口门禁', user_request: '仅允许 Main 调用', size: '1024x1024', reference_images: [], reference_roles: [] })
  const url = `http://127.0.0.1/api/images/projects/${project.id}/references`
  const reference = `data:image/png;base64,${(await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer()).toString('base64')}`
  const request = () => new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: project.revision, reference_images: [reference], reference_roles: ['subject'] }),
  })
  const denied = await handler(request(), new URL(url), ['api', 'images', 'projects', project.id, 'references'])
  expect(denied.status).toBe(403)
  const deniedWorkflow = await handler(new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotency_key: 'bb-image-workflow-reference-denied-0001',
      base_revision: project.revision,
      references: [{
        data_url: reference, role: 'subject', influence_strength: 'medium', preservation: 'prefer_preserve', priority: 100,
      }],
    }),
  }), new URL(url), ['api', 'images', 'projects', project.id, 'references'])
  expect(deniedWorkflow.status).toBe(403)
  const allowed = await handler(signedImageRequest(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({ revision: project.revision, reference_images: [reference], reference_roles: ['subject'] }),
  }), new URL(url), ['api', 'images', 'projects', project.id, 'references'])
  expect(allowed.status).toBe(201)
  expect(await allowed.json()).toMatchObject({ project: { references: [expect.objectContaining({ role: 'subject' })] } })
  const afterLegacyReference = await workbench.getProject(project.id)
  const workflowReference = await handler(signedImageRequest(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({
      idempotency_key: 'bb-image-workflow-reference-gate-0001',
      base_revision: afterLegacyReference.revision,
      references: [{
        data_url: reference,
        role: 'subject',
        influence_strength: 'medium',
        preservation: 'prefer_preserve',
        priority: 100,
      }],
    }),
  }), new URL(url), ['api', 'images', 'projects', project.id, 'references'])
  expect(workflowReference.status).toBe(201)
  expect(await workflowReference.json()).toMatchObject({
    project: { references: expect.arrayContaining([expect.objectContaining({ influence_strength: 'medium', preservation: 'prefer_preserve', priority: 100 })]) },
  })
  const ambiguous = await handler(signedImageRequest(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({
      revision: afterLegacyReference.revision,
      reference_images: [reference], reference_roles: ['subject'],
      idempotency_key: 'bb-image-reference-ambiguous-0001', base_revision: afterLegacyReference.revision,
      references: [{
        data_url: reference, role: 'subject', influence_strength: 'medium', preservation: 'prefer_preserve', priority: 100,
      }],
    }),
  }), new URL(url), ['api', 'images', 'projects', project.id, 'references'])
  expect(ambiguous.status).toBe(400)
  expect(await ambiguous.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
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
  const queued = await crashed.renderCanvas(setup.project.id, setup.canvas.canvas_id, {
    base_revision: prepared.revision, idempotency_key: 'bb-image-canvas-crash-replay-0001', canvas_revision: 0, activate_on_success: true,
  })
  await Bun.sleep(5)
  expect((await crashed.getGenerationOperation(setup.project.id, queued.operation.id)).status).toBe('queued')
  const recovered = new ImageWorkbenchService({ root: storageRoot, legacyMediaRoot: legacyRoot, now: () => new Date(timestamp) })
  const rendered = await completedRender(recovered, setup.project.id, setup.canvas.canvas_id, {
    base_revision: prepared.revision, idempotency_key: 'bb-image-canvas-crash-replay-0001', canvas_revision: 0, activate_on_success: true,
  })
  expect(rendered.operation.result).toMatchObject({ kind: 'rendered_version', version_id: rendered.version_id })
})

test('15.5 Delivery Application 在 CAS 落盘后崩溃仍以冻结 Version map 重放并恢复', async () => {
  const storageRoot = await root('export-crash')
  const legacyRoot = await root('export-crash-legacy')
  const crashed = new ImageWorkbenchService({ root: storageRoot, legacyMediaRoot: legacyRoot, now: () => new Date(timestamp), crashInjector: point => {
    if (point === 'after_export_cas_before_db_commit') throw new Error('injected export crash')
  } })
  const setup = await projectWithCanvas(crashed)
  const rendered = await completedRender(crashed, setup.project.id, setup.canvas.canvas_id, {
    base_revision: setup.project.revision, idempotency_key: 'bb-image-export-crash-render-0001', canvas_revision: 0, activate_on_success: true,
  })
  const beforeExport = await crashed.getProject(setup.project.id)
  const input = {
    base_revision: beforeExport.revision, idempotency_key: 'bb-image-export-crash-0001', version_ids_by_artboard: { [setup.artboard.id]: rendered.version_id },
  }
  const queued = await crashed.applications.delivery.exportDelivery(setup.project.id, input)
  await Bun.sleep(5)
  expect((await crashed.getGenerationOperation(setup.project.id, queued.operation.id)).status).toBe('queued')
  const acceptedOperation = await crashed.repository.getGenerationOperation(setup.project.id, queued.operation.id)
  expect(acceptedOperation.local_delivery).toMatchObject({
    kind: 'export',
    delivery_spec_id: setup.project.current_delivery_spec_id,
    delivery_spec_revision: setup.project.current_delivery_spec_revision,
  })
  const replayed = await crashed.applications.delivery.exportDelivery(setup.project.id, input)
  expect(replayed).toMatchObject({ operation: { id: queued.operation.id, status: 'queued' } })
  await expect(crashed.applications.delivery.exportDelivery(setup.project.id, {
    ...input,
    version_ids_by_artboard: { [setup.artboard.id]: 'ver_export_replay_conflict_0001' },
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
  await expect(crashed.applications.delivery.exportDelivery(setup.project.id, {
    ...input,
    base_revision: beforeExport.revision + 1,
    idempotency_key: 'bb-image-export-revision-conflict-0001',
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
  const changedProject = await crashed.getProject(setup.project.id)
  const changedSpec = await crashed.createDeliverySpecRevision(setup.project.id, {
    base_revision: changedProject.revision,
    idempotency_key: 'bb-image-export-crash-change-spec-0001',
    purpose: 'custom',
    artboards: [{
      id: setup.artboard.id,
      label: '后来修改的规格',
      width: 512,
      height: 512,
      required: true,
      output: { format: 'png', transparent: false },
    }],
  })
  expect(changedSpec.spec.revision).toBe(setup.project.current_delivery_spec_revision + 1)
  const recovered = new ImageWorkbenchService({ root: storageRoot, legacyMediaRoot: legacyRoot, now: () => new Date(timestamp) })
  // No client retry is required after restart: recovery reuses the accepted
  // queued Operation and its frozen local_delivery map.
  const exported = await waitForCompletedExport(recovered, setup.project.id, queued.operation.id)
  expect(exported.delivery_set?.version_ids_by_artboard).toEqual({ [setup.artboard.id]: rendered.version_id })
  expect(exported.delivery_set?.delivery_spec_revision).toBe(setup.project.current_delivery_spec_revision)
  const completedProject = await recovered.getProject(setup.project.id)
  const completedReplay = await recovered.applications.delivery.exportDelivery(setup.project.id, input)
  expect(completedReplay).toMatchObject({ operation: { id: queued.operation.id, status: 'succeeded' }, project_revision: completedProject.revision })
})
