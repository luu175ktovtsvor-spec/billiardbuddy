import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageWorkbenchProjectProjectionSchema } from '../shared/contracts/imageWorkflow.js'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import {
  createImageWorkbenchViewState,
  imageWorkbenchSelectionIndex,
  planImageWorkbenchRestore,
  reconcileImageWorkbenchViewState,
  reduceImageWorkbenchViewState,
  serializeImageWorkbenchViewState,
} from '../desktop/src/image-workbench/state/imageWorkbenchViewState.js'

const roots: string[] = []
const services: ImageWorkbenchService[] = []
const capability = '15-5e-image-workflow-capability-0123456789'
const gatewayUrl = 'https://gateway.example.test/gw'
const imageRelayUrl = 'https://images.example.test/image-generation'
const gatewayToken = '15-5e-image-gateway-token-0123456789'

type GatewayCall = {
  path: string
  method: string
  headers: Headers
  body: unknown
}

type PublicProjection = ReturnType<typeof imageWorkbenchProjectProjectionSchema.parse>

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `billiardbuddy-image-workflow-e-${label}-`))
  roots.push(value)
  return value
}

async function fixtureDataUrl(): Promise<string> {
  const encoded = await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.base64'), 'utf8')
  return `data:image/png;base64,${encoded.trim()}`
}

async function fixturePng(): Promise<string> {
  return (await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.base64'), 'utf8')).trim()
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

async function withGateway<T>(action: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.BB_GATEWAY_URL
  const previousImageRelayUrl = process.env.BB_IMAGE_RELAY_URL
  const previousToken = process.env.BB_GATEWAY_TOKEN
  process.env.BB_GATEWAY_URL = gatewayUrl
  process.env.BB_IMAGE_RELAY_URL = imageRelayUrl
  process.env.BB_GATEWAY_TOKEN = gatewayToken
  try {
    return await action()
  } finally {
    if (previousUrl === undefined) delete process.env.BB_GATEWAY_URL
    else process.env.BB_GATEWAY_URL = previousUrl
    if (previousImageRelayUrl === undefined) delete process.env.BB_IMAGE_RELAY_URL
    else process.env.BB_IMAGE_RELAY_URL = previousImageRelayUrl
    if (previousToken === undefined) delete process.env.BB_GATEWAY_TOKEN
    else process.env.BB_GATEWAY_TOKEN = previousToken
  }
}

/** A Relay-shaped fixture: submission is queued, then ordinary polling commits three candidates. */
function successfulGateway(png: string): { calls: GatewayCall[]; fetchImpl: typeof fetch } {
  const calls: GatewayCall[] = []
  const tasks = new Map<string, { id: string; status: 'queued' | 'succeeded' }>()
  const receipt = 'e'.repeat(64)

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    const requestHeaders = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ path: url.pathname, method, headers: requestHeaders, body })

    if (url.pathname === '/image-generation/v1/images/tasks' && method === 'POST') {
      const idempotencyKey = requestHeaders.get('Idempotency-Key') ?? ''
      const existing = tasks.get(idempotencyKey)
      if (existing) {
        return Response.json({
          task_id: existing.id,
          status: existing.status,
          reused: true,
          poll_after_seconds: 1,
          provider_receipt_hash: receipt,
        })
      }
      const task = { id: `relay_workflow_e_${String(tasks.size + 1).padStart(4, '0')}`, status: 'queued' as const }
      tasks.set(idempotencyKey, task)
      return Response.json({ task_id: task.id, status: task.status, poll_after_seconds: 1, provider_receipt_hash: receipt })
    }
    const taskMatch = /^\/image-generation\/v1\/images\/tasks\/([^/]+)(?:\/(ack))?$/.exec(url.pathname)
    if (taskMatch) {
      const task = [...tasks.values()].find(candidate => candidate.id === decodeURIComponent(taskMatch[1]!))
      if (!task) return Response.json({ error: 'unknown task' }, { status: 404 })
      if (taskMatch[2] === 'ack' && method === 'POST') return Response.json({ result_acknowledged: true })
      if (method === 'GET') {
        task.status = 'succeeded'
        return Response.json({
          task_id: task.id,
          status: task.status,
          provider_receipt_hash: receipt,
          result_urls: [0, 1, 2].map(index => `${imageRelayUrl}/v1/images/results/result.${receipt}/${index}`),
        })
      }
    }
    if (url.pathname.startsWith('/image-generation/v1/images/results/') && method === 'GET') {
      return Response.json({ data: [{ b64_json: png, mime_type: 'image/png' }] })
    }
    // Quality reasoning is non-blocking and must not alter image facts when unavailable.
    if (url.pathname.endsWith('/v1/image/reasoning')) return Response.json({ error: 'unavailable' }, { status: 503 })
    if (url.pathname.includes('/by-idempotency/') && method === 'GET') return Response.json({ error: 'no task' }, { status: 404 })
    return Response.json({ error: `unexpected fixture request: ${method} ${url.pathname}` }, { status: 500 })
  }

  return { calls, fetchImpl }
}

function parseProjection(value: unknown): PublicProjection {
  return imageWorkbenchProjectProjectionSchema.parse(value)
}

async function projectProjection(
  handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>,
  projectId: string,
): Promise<PublicProjection> {
  const response = await request(handler, `/api/images/projects/${projectId}/projection`)
  expect(response.status).toBe(200)
  return parseProjection(await response.json())
}

afterEach(async () => {
  for (const service of services.splice(0)) service.repository.close()
  await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true })))
})

test('15.5E Quick Create 首轮参考图在付费 Round 前持久化，并拒绝错误 role 或图片文件', async () => {
  const rootPath = await root('quick-create-first-reference')
  const legacyRoot = await root('quick-create-first-reference-legacy')
  const gateway = successfulGateway(await fixturePng())
  const service = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
  })
  services.push(service)
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  const paidSubmissions = () => gateway.calls.filter(call =>
    call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')

  await withGateway(async () => {
    const withoutReference = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotency_key: 'bb-image-15-5e-quick-create-empty-reference-0001',
        prompt: '为台球赛事制作一张门店宣传图。',
        output_preset: 'square',
      }),
    })
    expect(withoutReference.status).toBe(202)
    expect((await withoutReference.json() as { project: { references: unknown[] } }).project.references).toEqual([])
    expect(paidSubmissions()).toHaveLength(1)
    expect(paidSubmissions()[0]?.body).toMatchObject({ mode: 'generate' })

    const firstReference = await fixtureDataUrl()
    const withReference = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotency_key: 'bb-image-15-5e-quick-create-product-reference-0001',
        prompt: '为台球赛事制作一张带产品主体的门店宣传图。',
        output_preset: 'square',
        reference_inputs: [{ data_url: firstReference, role: 'product' }],
      }),
    })
    expect(withReference.status).toBe(202)
    expect((await withReference.json() as { project: { references: Array<{ role: string }> } }).project.references)
      .toEqual([expect.objectContaining({ role: 'product' })])
    expect(paidSubmissions()).toHaveLength(2)
    expect(paidSubmissions()[1]?.body).toMatchObject({
      mode: 'edit',
      reference_controls: [{
        image_index: 0,
        role: 'product',
        influence_strength: 'high',
        preservation: 'must_preserve',
        priority: 0,
      }],
    })

    const invalidRole = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotency_key: 'bb-image-15-5e-quick-create-invalid-role-0001',
        prompt: '错误角色不能创建付费 Round。',
        output_preset: 'square',
        reference_inputs: [{ data_url: firstReference, role: 'unclassified' }],
      }),
    })
    expect(invalidRole.status).toBe(400)
    expect(await invalidRole.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
    expect(paidSubmissions()).toHaveLength(2)

    const invalidFile = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotency_key: 'bb-image-15-5e-quick-create-invalid-file-0001',
        prompt: '错误图片字节不能创建付费 Round。',
        output_preset: 'square',
        reference_inputs: [{ data_url: 'data:image/png;base64,AAAA', role: 'product' }],
      }),
    })
    expect(invalidFile.status).toBe(400)
    expect(await invalidFile.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
    expect(paidSubmissions()).toHaveLength(2)
  })
})

test('15.5E 从建项、受控参考、候选采纳到画布和素材库均可通过公开投影恢复', async () => {
  const rootPath = await root('full-flow')
  const legacyRoot = await root('full-flow-legacy')
  const gateway = successfulGateway(await fixturePng())
  const first = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
  })
  services.push(first)
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, capability)

  await withGateway(async () => {
    const quickCreate = await request(firstHandler, '/api/images/quick-create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotency_key: 'bb-image-15-5e-quick-create-0001',
        title: '15.5E 全流程海报',
        prompt: '为台球赛事制作一张清晰、专业的门店宣传图。',
        output_preset: 'square',
        reference_inputs: [{ data_url: await fixtureDataUrl(), role: 'product' }],
      }),
    })
    expect(quickCreate.status).toBe(202)
    const created = await quickCreate.json() as { project: { id: string; references: Array<{ role: string }> }; operations: Array<{ id: string }> }
    expect(created.project.references).toEqual([expect.objectContaining({ role: 'product' })])
    expect(created.operations).toHaveLength(1)

    // This is the normal UI reconciliation clock: polling the public operation
    // transitions the remote task and durably commits the candidates before ACK.
    const operations = await request(firstHandler, `/api/images/projects/${created.project.id}/operations`)
    expect(operations.status).toBe(200)
    expect(await operations.json()).toMatchObject({ operations: [expect.objectContaining({ id: created.operations[0]!.id, status: 'succeeded' })] })

    const beforeAdoption = await projectProjection(firstHandler, created.project.id)
    expect(beforeAdoption).toMatchObject({
      project: { id: created.project.id, references: [expect.objectContaining({ role: 'product' })] },
      inspiration_board: null,
      creative_plans: [expect.objectContaining({ project_id: created.project.id })],
      generation_rounds: [expect.objectContaining({ project_id: created.project.id })],
      operations: [expect.objectContaining({ id: created.operations[0]!.id, status: 'succeeded' })],
      canvases: [],
      library: { project_id: created.project.id },
    })
    expect(beforeAdoption.candidate_groups).toHaveLength(1)
    expect(beforeAdoption.candidate_groups[0]?.candidates).toHaveLength(3)
    expect(JSON.stringify(beforeAdoption)).not.toContain('remote_task_id')
    expect(JSON.stringify(beforeAdoption)).not.toContain('idempotency_key')

    const candidate = beforeAdoption.candidate_groups[0]?.candidates[0]
    const artboard = beforeAdoption.delivery_spec?.artboards[0]
    if (!candidate || !artboard) throw new Error('expected a publicly projected candidate and artboard')
    const adoption = await request(firstHandler, `/api/images/projects/${created.project.id}/candidates/${candidate.id}/adoptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: beforeAdoption.project.revision,
        idempotency_key: 'bb-image-15-5e-adopt-candidate-0001',
        adoptions: [{ artboard_id: artboard.id, placement: { fit: 'contain', focus_x: 0.5, focus_y: 0.5 } }],
      }),
    })
    expect(adoption.status).toBe(200)
    expect(await adoption.json()).toMatchObject({ adoptions: [expect.objectContaining({ candidate_id: candidate.id, artboard_id: artboard.id })] })

    const afterAdoption = await projectProjection(firstHandler, created.project.id)
    expect(afterAdoption.canvases).toHaveLength(1)
    expect(afterAdoption.canvases[0]).toMatchObject({
      document: { artboard_id: artboard.id, layers: [expect.objectContaining({ kind: 'raster', source_asset_id: candidate.asset_id })] },
    })
    expect(afterAdoption.library.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ asset_id: candidate.asset_id, origin: 'generated', source_project_id: created.project.id }),
    ]))

    const firstEvents = await request(firstHandler, `/api/images/projects/${created.project.id}/events?cursor=0&limit=200&wait_ms=0`)
    expect(firstEvents.status).toBe(200)
    const eventPage = await firstEvents.json() as { cursor: number; events: Array<{ cursor: number }>; reset_required: boolean }
    expect(eventPage.events.length).toBeGreaterThan(0)
    expect(eventPage.events.map(event => event.cursor)).toEqual([...eventPage.events].map(event => event.cursor).sort((left, right) => left - right))

    // Only selections and the cursor survive the desktop restart. Server facts
    // are reloaded from /projection and reconciled against its current IDs.
    let local = createImageWorkbenchViewState()
    local = reduceImageWorkbenchViewState(local, { kind: 'select-project', project_id: created.project.id })
    local = reduceImageWorkbenchViewState(local, { kind: 'select-candidate', candidate_id: candidate.id })
    local = reduceImageWorkbenchViewState(local, { kind: 'select-canvas', canvas_id: afterAdoption.canvases[0]!.canvas_id })
    const restore = planImageWorkbenchRestore(local, created.project.id, eventPage)
    expect(restore.reload_projection).toBeTrue()
    expect(JSON.parse(serializeImageWorkbenchViewState(restore.view_state))).not.toHaveProperty('project')

    first.repository.close()
    services.splice(services.indexOf(first), 1)
    const restarted = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(restarted)
    const restartedHandler = createImageWorkbenchDomainApiHandler(restarted.applications, capability)
    await restarted.recoverInterruptedOperations()

    const recoveredProjection = await projectProjection(restartedHandler, created.project.id)
    expect(recoveredProjection.project.id).toBe(created.project.id)
    expect(recoveredProjection.project.revision).toBe(afterAdoption.project.revision)
    expect(recoveredProjection.candidate_groups[0]?.candidates.some(item => item.id === candidate.id)).toBeTrue()
    expect(recoveredProjection.canvases.some(canvas => canvas.canvas_id === afterAdoption.canvases[0]!.canvas_id)).toBeTrue()
    const reconciled = reconcileImageWorkbenchViewState(restore.view_state, imageWorkbenchSelectionIndex(recoveredProjection))
    expect(reconciled).toMatchObject({
      selected_project_id: created.project.id,
      selected_candidate_id: candidate.id,
      selected_canvas_id: afterAdoption.canvases[0]!.canvas_id,
      event_cursors: { [created.project.id]: eventPage.cursor },
    })

    const delta = await request(restartedHandler, `/api/images/projects/${created.project.id}/events?cursor=${eventPage.cursor}&limit=200&wait_ms=0`)
    expect(delta.status).toBe(200)
    expect(await delta.json()).toMatchObject({ events: [], cursor: eventPage.cursor, reset_required: false })

    // Campaign remains a batch coordinator, not a second asset or candidate
    // store: its queued item becomes another ordinary Project that has the
    // same public projection and recovery path.
    const campaignCreate = await request(restartedHandler, '/api/images/campaigns', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotency_key: 'bb-image-15-5e-campaign-create-0001',
        name: '15.5E 门店 Campaign',
        shared_brief: {
          user_request: '为台球门店的夏季赛事制作统一的宣传图。',
          confirmed_facts: ['赛事面向本地门店用户'],
          must_preserve: ['画面保留清晰标题区域'],
        },
        output_preset: 'square',
        items: [{ variable_values: [] }],
      }),
    })
    expect(campaignCreate.status).toBe(201)
    const campaign = await campaignCreate.json() as { campaign: { id: string; revision: number } }
    const campaignEstimate = await request(restartedHandler, `/api/images/campaigns/${campaign.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: campaign.campaign.revision }),
    })
    expect(campaignEstimate.status).toBe(200)
    const estimate = await campaignEstimate.json() as { estimate: { estimate_hash: string } }
    const campaignConfirm = await request(restartedHandler, `/api/images/campaigns/${campaign.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: campaign.campaign.revision,
        idempotency_key: 'bb-image-15-5e-campaign-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(campaignConfirm.status).toBe(200)
    const confirmed = await campaignConfirm.json() as { campaign: { revision: number }; confirmation: { id: string } }
    const campaignStart = await request(restartedHandler, `/api/images/campaigns/${campaign.campaign.id}/commands/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: confirmed.campaign.revision,
        idempotency_key: 'bb-image-15-5e-campaign-start-0001',
        estimate_hash: estimate.estimate.estimate_hash,
        confirmation_receipt_id: confirmed.confirmation.id,
      }),
    })
    expect(campaignStart.status).toBe(202)
    const started = await campaignStart.json() as { items: Array<{ project_id?: string }> }
    const campaignProjectId = started.items[0]?.project_id
    if (!campaignProjectId) throw new Error('expected Campaign item to bind its ordinary Quick Create project')
    const campaignProjection = await projectProjection(restartedHandler, campaignProjectId)
    expect(campaignProjection.project.id).toBe(campaignProjectId)
    expect(campaignProjection.operations).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(2)
  })
})
