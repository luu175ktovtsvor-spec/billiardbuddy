import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'

const roots: string[] = []
const workbenches: ImageWorkbenchService[] = []
const timestamp = '2026-08-05T00:00:00.000Z'
const capability = '15-5c-image-workflow-capability-0123456789'

type PublicProject = {
  id: string
  revision: number
  references: Array<{ asset_id: string }>
}

type BrandResponse = {
  brand_kit: { id: string; revision: number; current_revision_id: string; state: 'active' | 'trashed' }
  revision: { id: string; revision: number; logo_asset_ids: string[] }
}

type TemplateResponse = {
  template: { id: string; revision: number; current_revision_id: string; state: 'active' | 'trashed' }
  revision: { id: string; revision: number }
}

type GrantResponse = {
  grant: { id: string; asset_id: string; revoked_at?: string; to_owner: { kind: string; id: string } }
}

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `billiardbuddy-image-workflow-c-${label}-`))
  roots.push(value)
  return value
}

async function fixtureDataUrl(): Promise<string> {
  const encoded = await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.base64'), 'utf8')
  return `data:image/png;base64,${encoded.trim()}`
}

async function workbench(label: string): Promise<ImageWorkbenchService> {
  const value = new ImageWorkbenchService({
    root: await root(label),
    legacyMediaRoot: await root(`${label}-legacy`),
    now: () => new Date(timestamp),
  })
  workbenches.push(value)
  return value
}

async function request(
  handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(path, 'http://127.0.0.1:3456')
  return await handler(new Request(url, init), url, url.pathname.split('/').filter(Boolean))
}

const headers = {
  'Content-Type': 'application/json',
  'X-BilliardBuddy-Media-Capability': capability,
}

function emptyBrandRevision() {
  return {
    logo_asset_ids: [],
    font_asset_ids: [],
    color_tokens: { primary: '#174c80' },
    required_text: [],
  }
}

function emptyTemplateRevision() {
  return {
    blueprint: {
      schema_version: 1,
      artboard: { width: 1024, height: 1024 },
      background: { kind: 'solid', color: '#ffffff' },
      layers: [],
    },
    slots: [],
    schema_version: 1,
  }
}

function templateRevisionWithAsset(assetId: string) {
  return {
    blueprint: {
      schema_version: 1,
      artboard: { width: 1024, height: 1024 },
      background: { kind: 'solid', color: '#ffffff' },
      layers: [{
        id: 'raster_workflow_c_0001',
        kind: 'raster',
        source_asset_id: assetId,
        transform: { x: 80, y: 80, width: 320, height: 320, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
        opacity: 1,
        blend_mode: 'normal',
      }],
    },
    slots: [],
    schema_version: 1,
  }
}

afterEach(async () => {
  for (const value of workbenches.splice(0)) value.repository.close()
  await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true })))
})

test('15.5C Brand Kit、Template、素材授权和项目素材库都走 capability API，并保留回收与撤销边界', async () => {
  const service = await workbench('workflow')
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  const sourceResponse = await request(handler, '/api/images/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: '15.5C 来源项目',
      user_request: '保存可复用的产品 Logo 素材',
      size: '1024x1024',
      reference_images: [await fixtureDataUrl()],
      reference_roles: ['product'],
    }),
  })
  expect(sourceResponse.status).toBe(201)
  const source = (await sourceResponse.json() as { project: PublicProject }).project
  const sourceAssetId = source.references[0]?.asset_id
  expect(sourceAssetId).toMatch(/^ref_/)
  if (!sourceAssetId) throw new Error('expected source project reference asset')

  const libraryResponse = await request(handler, `/api/images/projects/${source.id}/library`)
  expect(libraryResponse.status).toBe(200)
  expect(await libraryResponse.json()).toMatchObject({
    project_id: source.id,
    entries: [expect.objectContaining({
      asset_id: sourceAssetId,
      origin: 'user_upload',
      source_project_id: source.id,
    })],
  })

  const brandCreate = {
    idempotency_key: 'bb-image-15-5c-brand-create-0001',
    name: '赛事品牌包',
    revision: emptyBrandRevision(),
  }
  const deniedBrand = await request(handler, '/api/images/brand-kits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(brandCreate),
  })
  expect(deniedBrand.status).toBe(403)
  expect(await deniedBrand.json()).toMatchObject({ error: 'MEDIA_ACTION_NOT_ALLOWED' })

  const firstBrand = await request(handler, '/api/images/brand-kits', {
    method: 'POST', headers, body: JSON.stringify(brandCreate),
  })
  expect(firstBrand.status).toBe(201)
  const brand = await firstBrand.json() as BrandResponse
  expect(brand).toMatchObject({ brand_kit: { revision: 0, state: 'active' }, revision: { revision: 0, logo_asset_ids: [] } })

  const replayBrand = await request(handler, '/api/images/brand-kits', {
    method: 'POST', headers, body: JSON.stringify(brandCreate),
  })
  expect(replayBrand.status).toBe(201)
  expect((await replayBrand.json() as BrandResponse).brand_kit.id).toBe(brand.brand_kit.id)
  const conflictingBrand = await request(handler, '/api/images/brand-kits', {
    method: 'POST', headers, body: JSON.stringify({ ...brandCreate, name: '同键不同品牌名' }),
  })
  expect(conflictingBrand.status).toBe(409)
  expect(await conflictingBrand.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })

  const ungantedBrandRevision = {
    base_revision: brand.brand_kit.revision,
    idempotency_key: 'bb-image-15-5c-brand-revise-unganted-0001',
    revision: { ...emptyBrandRevision(), logo_asset_ids: [sourceAssetId] },
  }
  const deniedRevision = await request(handler, `/api/images/brand-kits/${brand.brand_kit.id}/revisions`, {
    method: 'POST', headers, body: JSON.stringify(ungantedBrandRevision),
  })
  expect(deniedRevision.status).toBe(403)
  expect(await deniedRevision.json()).toMatchObject({ error: 'MEDIA_ACTION_NOT_ALLOWED' })

  const brandGrantInput = {
    idempotency_key: 'bb-image-15-5c-brand-grant-0001',
    asset_id: sourceAssetId,
    to_owner: { kind: 'brand_kit', id: brand.brand_kit.id },
    purpose: 'render',
  }
  const brandGrantResponse = await request(handler, '/api/images/asset-grants', {
    method: 'POST', headers, body: JSON.stringify(brandGrantInput),
  })
  expect(brandGrantResponse.status).toBe(201)
  const brandGrant = await brandGrantResponse.json() as GrantResponse
  expect(brandGrant.grant).toMatchObject({ asset_id: sourceAssetId, to_owner: brandGrantInput.to_owner })
  const replayBrandGrant = await request(handler, '/api/images/asset-grants', {
    method: 'POST', headers, body: JSON.stringify(brandGrantInput),
  })
  expect(replayBrandGrant.status).toBe(201)
  expect((await replayBrandGrant.json() as GrantResponse).grant.id).toBe(brandGrant.grant.id)

  const brandRevisionInput = {
    ...ungantedBrandRevision,
    idempotency_key: 'bb-image-15-5c-brand-revise-0001',
  }
  const revisedBrandResponse = await request(handler, `/api/images/brand-kits/${brand.brand_kit.id}/revisions`, {
    method: 'POST', headers, body: JSON.stringify(brandRevisionInput),
  })
  expect(revisedBrandResponse.status).toBe(200)
  const revisedBrand = await revisedBrandResponse.json() as BrandResponse
  expect(revisedBrand).toMatchObject({ brand_kit: { revision: 1 }, revision: { revision: 1, logo_asset_ids: [sourceAssetId] } })
  const replayBrandRevision = await request(handler, `/api/images/brand-kits/${brand.brand_kit.id}/revisions`, {
    method: 'POST', headers, body: JSON.stringify(brandRevisionInput),
  })
  expect(replayBrandRevision.status).toBe(200)
  expect((await replayBrandRevision.json() as BrandResponse).revision.id).toBe(revisedBrand.revision.id)
  const staleBrandRevision = await request(handler, `/api/images/brand-kits/${brand.brand_kit.id}/revisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...brandRevisionInput, idempotency_key: 'bb-image-15-5c-brand-revise-stale-0001' }),
  })
  expect(staleBrandRevision.status).toBe(409)
  expect(await staleBrandRevision.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

  const templateCreate = {
    idempotency_key: 'bb-image-15-5c-template-create-0001',
    name: '赛事海报模板',
    revision: emptyTemplateRevision(),
  }
  const templateResponse = await request(handler, '/api/images/templates', {
    method: 'POST', headers, body: JSON.stringify(templateCreate),
  })
  expect(templateResponse.status).toBe(201)
  const template = await templateResponse.json() as TemplateResponse
  expect(template).toMatchObject({ template: { revision: 0, state: 'active' }, revision: { revision: 0 } })

  const invalidTemplateStructure = await request(handler, '/api/images/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5c-template-invalid-structure-0001',
      name: '重复 Slot 目标模板',
      revision: {
        blueprint: {
          schema_version: 1,
          artboard: { width: 1024, height: 1024 },
          background: { kind: 'solid', color: '#ffffff' },
          layers: [{
            id: 'text_workflow_c_invalid_0001', kind: 'text', text: '占位', font_family: 'BilliardBuddy Builtin CJK', font_asset_id: 'font_builtin_0001',
            font_size: 48, font_weight: 400, font_style: 'normal', line_height: 1.2, letter_spacing: 0, fill: '#000000', position: { x: 10, y: 10 },
            rotation_degrees: 0, overflow: 'error', locale: 'zh-CN', align: 'left', opacity: 1,
          }],
        },
        slots: [
          { id: 'title_one', layer_id: 'text_workflow_c_invalid_0001', kind: 'text', required: false },
          { id: 'title_two', layer_id: 'text_workflow_c_invalid_0001', kind: 'text', required: false },
        ],
        schema_version: 1,
      },
    }),
  })
  expect(invalidTemplateStructure.status).toBe(400)

  const invalidGrantPurpose = await request(handler, '/api/images/asset-grants', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5c-template-render-grant-invalid-0001',
      asset_id: sourceAssetId,
      to_owner: { kind: 'template', id: template.template.id },
      purpose: 'render',
    }),
  })
  expect(invalidGrantPurpose.status).toBe(400)

  const ungrantedTemplateRevision = {
    base_revision: template.template.revision,
    idempotency_key: 'bb-image-15-5c-template-revise-unganted-0001',
    revision: templateRevisionWithAsset(sourceAssetId),
  }
  const deniedTemplateRevision = await request(handler, `/api/images/templates/${template.template.id}/revisions`, {
    method: 'POST', headers, body: JSON.stringify(ungrantedTemplateRevision),
  })
  expect(deniedTemplateRevision.status).toBe(403)

  const templateGrantResponse = await request(handler, '/api/images/asset-grants', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5c-template-grant-0001',
      asset_id: sourceAssetId,
      to_owner: { kind: 'template', id: template.template.id },
      purpose: 'template_use',
    }),
  })
  expect(templateGrantResponse.status).toBe(201)
  const templateGrant = await templateGrantResponse.json() as GrantResponse

  const activeGrants = await request(handler, '/api/images/asset-grants')
  expect(activeGrants.status).toBe(200)
  expect(await activeGrants.json()).toMatchObject({
    grants: expect.arrayContaining([
      expect.objectContaining({ id: brandGrant.grant.id }),
      expect.objectContaining({ id: templateGrant.grant.id }),
    ]),
  })

  const templateRevisionInput = {
    ...ungrantedTemplateRevision,
    idempotency_key: 'bb-image-15-5c-template-revise-0001',
  }
  const revisedTemplateResponse = await request(handler, `/api/images/templates/${template.template.id}/revisions`, {
    method: 'POST', headers, body: JSON.stringify(templateRevisionInput),
  })
  expect(revisedTemplateResponse.status).toBe(200)
  const revisedTemplate = await revisedTemplateResponse.json() as TemplateResponse
  expect(revisedTemplate).toMatchObject({ template: { revision: 1 }, revision: { revision: 1 } })
  const staleTemplateRevision = await request(handler, `/api/images/templates/${template.template.id}/revisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...templateRevisionInput, idempotency_key: 'bb-image-15-5c-template-revise-stale-0001' }),
  })
  expect(staleTemplateRevision.status).toBe(409)
  expect(await staleTemplateRevision.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

  const targetResponse = await request(handler, '/api/images/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: '15.5C 复用目标项目',
      user_request: '验证素材复用必须持有可撤销授权',
      size: '1024x1024',
      reference_images: [await fixtureDataUrl()],
      reference_roles: ['product'],
    }),
  })
  expect(targetResponse.status).toBe(201)
  const target = (await targetResponse.json() as { project: PublicProject }).project
  const targetOwnedAssetId = target.references[0]?.asset_id
  if (!targetOwnedAssetId) throw new Error('expected target-owned reference asset')
  const deliveryResponse = await request(handler, `/api/images/projects/${target.id}/delivery-spec`)
  expect(deliveryResponse.status).toBe(200)
  const delivery = await deliveryResponse.json() as { delivery_spec: { artboards: Array<{ id: string }> } }
  const artboardId = delivery.delivery_spec.artboards[0]?.id
  if (!artboardId) throw new Error('expected target delivery artboard')
  const canvasResponse = await request(handler, `/api/images/projects/${target.id}/canvases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      artboard_id: artboardId,
      base_revision: target.revision,
      idempotency_key: 'bb-image-15-5c-target-canvas-0001',
    }),
  })
  expect(canvasResponse.status).toBe(201)
  const canvas = await canvasResponse.json() as { canvas: { canvas_id: string; revision: number }; project_revision: number }

  const projectGrantInput = {
    idempotency_key: 'bb-image-15-5c-project-grant-0001',
    asset_id: sourceAssetId,
    to_owner: { kind: 'project', id: target.id },
    purpose: 'project_reuse',
  }
  const projectGrantResponse = await request(handler, '/api/images/asset-grants', {
    method: 'POST', headers, body: JSON.stringify(projectGrantInput),
  })
  expect(projectGrantResponse.status).toBe(201)
  const projectGrant = await projectGrantResponse.json() as GrantResponse

  const renderGrantResponse = await request(handler, '/api/images/asset-grants', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5c-project-render-grant-0001',
      asset_id: sourceAssetId,
      to_owner: { kind: 'project', id: target.id },
      purpose: 'render',
    }),
  })
  expect(renderGrantResponse.status).toBe(201)
  const renderGrant = await renderGrantResponse.json() as GrantResponse

  const targetLibraryResponse = await request(handler, `/api/images/projects/${target.id}/library`)
  expect(targetLibraryResponse.status).toBe(200)
  const targetLibrary = await targetLibraryResponse.json() as {
    project_id: string
    entries: Array<{ asset_id: string; project_id: string; grant_id?: string; origin: string; source_project_id?: string }>
  }
  expect(targetLibrary.project_id).toBe(target.id)
  const targetOwnedEntry = targetLibrary.entries.find(entry => entry.asset_id === targetOwnedAssetId)
  expect(targetOwnedEntry).toMatchObject({ asset_id: targetOwnedAssetId, project_id: target.id, origin: 'user_upload' })
  expect(targetOwnedEntry?.grant_id).toBeUndefined()
  const grantedEntries = targetLibrary.entries.filter(entry => entry.asset_id === sourceAssetId)
  expect(grantedEntries).toHaveLength(1)
  expect(grantedEntries[0]).toMatchObject({
    asset_id: sourceAssetId,
    project_id: source.id,
    grant_id: projectGrant.grant.id,
    origin: 'user_upload',
    source_project_id: source.id,
  })

  const fixedTemplateCanvas = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_project_revision: canvas.project_revision,
      command: {
        idempotency_key: 'bb-image-15-5c-apply-active-template-0001',
        base_revision: canvas.canvas.revision,
        kind: 'apply_template',
        payload: { template_id: template.template.id, template_revision_id: revisedTemplate.revision.id, slot_bindings: [] },
      },
    }),
  })
  expect(fixedTemplateCanvas.status).toBe(200)
  const fixedTemplate = await fixedTemplateCanvas.json() as { canvas: { revision: number; document: { template_id?: string; template_revision_id?: string } }; project_revision: number }
  expect(fixedTemplate.canvas.document).toMatchObject({ template_id: template.template.id, template_revision_id: revisedTemplate.revision.id })

  const firstReuse = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_project_revision: fixedTemplate.project_revision,
      command: {
        idempotency_key: 'bb-image-15-5c-project-reuse-0001',
        base_revision: fixedTemplate.canvas.revision,
        kind: 'add_layer',
        payload: {
          layer: {
            id: 'raster_workflow_c_reuse_0001', kind: 'raster', source_asset_id: sourceAssetId,
            transform: { x: 0, y: 0, width: 256, height: 256, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
            opacity: 1, blend_mode: 'normal',
          },
        },
      },
    }),
  })
  expect(firstReuse.status).toBe(200)
  const reused = await firstReuse.json() as { canvas: { revision: number }; project_revision: number }

  const revokedProjectGrant = await request(handler, `/api/images/asset-grants/${projectGrant.grant.id}/commands/revoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ idempotency_key: 'bb-image-15-5c-project-grant-revoke-0001' }),
  })
  expect(revokedProjectGrant.status).toBe(200)
  expect((await revokedProjectGrant.json() as GrantResponse).grant.revoked_at).toBe(timestamp)
  const replayRevoke = await request(handler, `/api/images/asset-grants/${projectGrant.grant.id}/commands/revoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ idempotency_key: 'bb-image-15-5c-project-grant-revoke-0001' }),
  })
  expect(replayRevoke.status).toBe(200)
  expect((await replayRevoke.json() as GrantResponse).grant.revoked_at).toBe(timestamp)

  const libraryAfterProjectReuseRevoke = await request(handler, `/api/images/projects/${target.id}/library`)
  expect(libraryAfterProjectReuseRevoke.status).toBe(200)
  const libraryWithRenderOnly = await libraryAfterProjectReuseRevoke.json() as {
    entries: Array<{ asset_id: string; grant_id?: string }>
  }
  expect(libraryWithRenderOnly.entries.filter(entry => entry.asset_id === sourceAssetId)).toEqual([
    expect.objectContaining({ asset_id: sourceAssetId, grant_id: renderGrant.grant.id }),
  ])

  const revokedRenderGrant = await request(handler, `/api/images/asset-grants/${renderGrant.grant.id}/commands/revoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ idempotency_key: 'bb-image-15-5c-project-render-grant-revoke-0001' }),
  })
  expect(revokedRenderGrant.status).toBe(200)
  expect((await revokedRenderGrant.json() as GrantResponse).grant.revoked_at).toBe(timestamp)

  const libraryAfterAllProjectGrantsRevoked = await request(handler, `/api/images/projects/${target.id}/library`)
  expect(libraryAfterAllProjectGrantsRevoked.status).toBe(200)
  const libraryWithoutSourceGrant = await libraryAfterAllProjectGrantsRevoked.json() as {
    entries: Array<{ asset_id: string; project_id: string; grant_id?: string }>
  }
  expect(libraryWithoutSourceGrant.entries.some(entry => entry.asset_id === sourceAssetId)).toBe(false)
  expect(libraryWithoutSourceGrant.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ asset_id: targetOwnedAssetId, project_id: target.id }),
  ]))

  const deniedReuseAfterRevoke = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_project_revision: reused.project_revision,
      command: {
        idempotency_key: 'bb-image-15-5c-project-reuse-after-revoke-0001',
        base_revision: reused.canvas.revision,
        kind: 'add_layer',
        payload: {
          layer: {
            id: 'raster_workflow_c_reuse_0002', kind: 'raster', source_asset_id: sourceAssetId,
            transform: { x: 300, y: 0, width: 256, height: 256, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
            opacity: 1, blend_mode: 'normal',
          },
        },
      },
    }),
  })
  expect(deniedReuseAfterRevoke.status).toBe(403)

  // A Template that inherits a Brand's logo/font inputs must re-check the
  // Brand grant for every new Canvas write.  A successful old command still
  // replays its immutable receipt without treating revocation as history loss.
  const brandBoundTemplateResponse = await request(handler, '/api/images/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5c-brand-bound-template-create-0001',
      name: '品牌绑定赛事模板',
      revision: {
        ...emptyTemplateRevision(),
        brand_kit_id: brand.brand_kit.id,
        brand_kit_revision_id: revisedBrand.revision.id,
      },
    }),
  })
  expect(brandBoundTemplateResponse.status).toBe(201)
  const brandBoundTemplate = await brandBoundTemplateResponse.json() as TemplateResponse
  const brandBoundApplyInput = {
    base_project_revision: reused.project_revision,
    command: {
      idempotency_key: 'bb-image-15-5c-brand-bound-template-apply-0001',
      base_revision: reused.canvas.revision,
      kind: 'apply_template',
      payload: {
        template_id: brandBoundTemplate.template.id,
        template_revision_id: brandBoundTemplate.revision.id,
        slot_bindings: [],
      },
    },
  }
  const brandBoundApply = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST', headers, body: JSON.stringify(brandBoundApplyInput),
  })
  expect(brandBoundApply.status).toBe(200)
  const brandBoundCanvas = await brandBoundApply.json() as { canvas: { revision: number }; project_revision: number }

  const alternateBrandResponse = await request(handler, '/api/images/brand-kits', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5c-brand-lock-alternate-0001',
      name: '不可覆盖的替代品牌',
      revision: emptyBrandRevision(),
    }),
  })
  expect(alternateBrandResponse.status).toBe(201)
  const alternateBrand = await alternateBrandResponse.json() as BrandResponse
  const deniedTemplateLockedBrand = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_project_revision: brandBoundCanvas.project_revision,
      command: {
        idempotency_key: 'bb-image-15-5c-template-brand-lock-0001',
        base_revision: brandBoundCanvas.canvas.revision,
        kind: 'apply_brand_kit',
        payload: { brand_kit_id: alternateBrand.brand_kit.id, brand_kit_revision_id: alternateBrand.revision.id },
      },
    }),
  })
  expect(deniedTemplateLockedBrand.status).toBe(409)
  expect(await deniedTemplateLockedBrand.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

  const revokedBrandGrant = await request(handler, `/api/images/asset-grants/${brandGrant.grant.id}/commands/revoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ idempotency_key: 'bb-image-15-5c-brand-grant-revoke-0001' }),
  })
  expect(revokedBrandGrant.status).toBe(200)
  expect((await revokedBrandGrant.json() as GrantResponse).grant.revoked_at).toBe(timestamp)
  const visibleGrantsAfterRevoke = await request(handler, '/api/images/asset-grants')
  expect(visibleGrantsAfterRevoke.status).toBe(200)
  expect((await visibleGrantsAfterRevoke.json() as { grants: Array<{ id: string }> }).grants.some(grant => grant.id === brandGrant.grant.id)).toBeFalse()
  const allGrantsAfterRevoke = await request(handler, '/api/images/asset-grants?include_revoked=1')
  expect(allGrantsAfterRevoke.status).toBe(200)
  expect(await allGrantsAfterRevoke.json()).toMatchObject({
    grants: expect.arrayContaining([expect.objectContaining({ id: brandGrant.grant.id, revoked_at: timestamp })]),
  })

  const replayBrandBoundApply = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST', headers, body: JSON.stringify(brandBoundApplyInput),
  })
  expect(replayBrandBoundApply.status).toBe(200)
  expect(await replayBrandBoundApply.json()).toMatchObject({ canvas: { revision: brandBoundCanvas.canvas.revision } })

  const deniedBrandBoundApply = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_project_revision: brandBoundCanvas.project_revision,
      command: {
        ...brandBoundApplyInput.command,
        idempotency_key: 'bb-image-15-5c-brand-bound-template-after-revoke-0001',
        base_revision: brandBoundCanvas.canvas.revision,
      },
    }),
  })
  expect(deniedBrandBoundApply.status).toBe(403)

  const trashedTemplate = await request(handler, `/api/images/templates/${template.template.id}/commands/trash`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base_revision: revisedTemplate.template.revision, idempotency_key: 'bb-image-15-5c-template-trash-0001' }),
  })
  expect(trashedTemplate.status).toBe(200)
  expect((await trashedTemplate.json() as TemplateResponse).template.state).toBe('trashed')
  const historicalCanvas = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/revisions/${fixedTemplate.canvas.revision}`)
  expect(historicalCanvas.status).toBe(200)
  expect(await historicalCanvas.json()).toMatchObject({
    canvas: {
      revision: fixedTemplate.canvas.revision,
      document: { template_id: template.template.id, template_revision_id: revisedTemplate.revision.id },
    },
  })
  const applyTrashedTemplate = await request(handler, `/api/images/projects/${target.id}/canvases/${canvas.canvas.canvas_id}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_project_revision: brandBoundCanvas.project_revision,
      command: {
        idempotency_key: 'bb-image-15-5c-apply-trashed-template-0001',
        base_revision: brandBoundCanvas.canvas.revision,
        kind: 'apply_template',
        payload: { template_id: template.template.id, template_revision_id: revisedTemplate.revision.id, slot_bindings: [] },
      },
    }),
  })
  expect(applyTrashedTemplate.status).toBe(409)

  const activeTemplates = await request(handler, '/api/images/templates')
  expect(await activeTemplates.json()).toMatchObject({
    templates: [expect.objectContaining({ id: brandBoundTemplate.template.id, state: 'active' })],
  })
  const allTemplates = await request(handler, '/api/images/templates?include_trashed=1')
  expect(await allTemplates.json()).toMatchObject({
    templates: expect.arrayContaining([
      expect.objectContaining({ id: template.template.id, state: 'trashed' }),
      expect.objectContaining({ id: brandBoundTemplate.template.id, state: 'active' }),
    ]),
  })
  expect(templateGrant.grant.revoked_at).toBeUndefined()
})
