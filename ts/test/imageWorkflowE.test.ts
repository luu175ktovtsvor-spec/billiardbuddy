import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imageWorkbenchIpcResponse } from '../desktop/electron/ipc/imageResponse.js'
import { ElectronImageActions } from '../desktop/electron/services/imageActions.js'
import {
  createElectronImageWorkbenchClient,
  unwrapImageWorkbenchClientResult,
} from '../desktop/src/image-workbench/api/imageWorkbenchClient.js'
import { imageWorkbenchIpcResponseSchemas, parseImageWorkbenchIpcRequest } from '../shared/contracts/imageWorkbenchIpc.js'
import type {
  ImageWorkbenchIpcMethod,
  ImageWorkbenchIpcPayloadByMethod,
  ImageWorkbenchIpcValueByMethod,
} from '../shared/contracts/imageWorkbenchIpc.js'
import type { ImageWorkbenchPreloadBridge } from '../shared/contracts/imageWorkbenchPreload.js'
import { publicMediaJobEventPageSchema } from '../shared/contracts/media.js'
import { imageWorkbenchProjectProjectionSchema } from '../shared/contracts/imageWorkflow.js'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { handleApiRequest } from '../src/server/router.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import { imageTicketRequest } from './helpers/imageUiTicket.js'
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
const ticketSecret = '15-5e-image-workflow-ticket-secret-0123456789'
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
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ProductionPathPreloadBridge = Pick<
  ImageWorkbenchPreloadBridge,
  | 'quickCreate'
  | 'getProjectProjection'
  | 'listOperationEvents'
  | 'getCandidatePreview'
  | 'getVersionPreview'
  | 'estimateDerivation'
  | 'deriveCandidate'
  | 'estimateVersionDerivation'
  | 'deriveVersion'
  | 'adoptCandidate'
  | 'getCanvas'
  | 'createDeliverySpecRevision'
  | 'createBrandKit'
  | 'reviseBrandKit'
  | 'createAssetGrant'
  | 'listAssetGrants'
  | 'createTemplate'
  | 'applyCanvasCommand'
  | 'preflightCanvas'
  | 'renderCanvas'
  | 'exportDelivery'
  | 'getDeliverySet'
  | 'getExportReceipt'
  | 'getProjectLibrary'
>

type LocalSocketCall = {
  path: string
  method: string
  ticket: string | null
  status: number
}

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
  return await handler(imageTicketRequest(url, init), url, url.pathname.split('/').filter(Boolean))
}

const headers = {
  'Content-Type': 'application/json',
  'X-BilliardBuddy-Media-Capability': ticketSecret,
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

/** A strict Relay-shaped fixture: submission is queued, then ordinary polling commits three candidates. */
function successfulGateway(png: string): { calls: GatewayCall[]; fetchImpl: FetchLike } {
  const calls: GatewayCall[] = []
  const tasks = new Map<string, { id: string; status: 'queued' | 'succeeded' }>()
  const receipt = 'e'.repeat(64)

  const fetchImpl: FetchLike = async (input, init) => {
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
    throw new Error(`unexpected strict Relay fixture request: ${method} ${url.pathname}`)
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

/**
 * This is the narrow portion of the actual Preload bridge used by the
 * renderer journey below.  It mirrors `invokeImageWorkbench`: the request is
 * validated by the shared IPC schema, Main's `ElectronImageActions` performs
 * the real socket request, and the response is parsed by the same schema
 * before it reaches the renderer client.
 */
function createProductionPathPreloadBridge(actions: ElectronImageActions): ProductionPathPreloadBridge {
  async function invoke<Method extends ImageWorkbenchIpcMethod>(
    method: Method,
    payload: ImageWorkbenchIpcPayloadByMethod[Method],
  ) {
    return await imageWorkbenchIpcResponse(async () => {
      const request = parseImageWorkbenchIpcRequest({ method, payload })
      const value = await actions.invokeWorkbench(request)
      return imageWorkbenchIpcResponseSchemas[method].parse(value) as ImageWorkbenchIpcValueByMethod[Method]
    })
  }

  return {
    quickCreate: input => invoke('quickCreate', { input }),
    getProjectProjection: projectId => invoke('getProjectProjection', { projectId }),
    listOperationEvents: input => invoke('listOperationEvents', input),
    getCandidatePreview: input => invoke('getCandidatePreview', input),
    getVersionPreview: input => invoke('getVersionPreview', input),
    estimateDerivation: (projectId, candidateId, input) => invoke('estimateCandidateDerivation', { projectId, candidateId, input }),
    deriveCandidate: (projectId, candidateId, input) => invoke('deriveCandidate', { projectId, candidateId, input }),
    estimateVersionDerivation: (projectId, versionId, input) => invoke('estimateVersionDerivation', { projectId, versionId, input }),
    deriveVersion: (projectId, versionId, input) => invoke('deriveVersion', { projectId, versionId, input }),
    adoptCandidate: (projectId, candidateId, input) => invoke('adoptCandidate', { projectId, candidateId, input }),
    getCanvas: input => invoke('getCanvas', input),
    createDeliverySpecRevision: (projectId, input) => invoke('createDeliverySpec', { projectId, input }),
    createBrandKit: input => invoke('createBrandKit', { input }),
    reviseBrandKit: input => invoke('reviseBrandKit', input),
    createAssetGrant: input => invoke('createAssetGrant', { input }),
    listAssetGrants: () => invoke('listAssetGrants', {}),
    createTemplate: input => invoke('createTemplate', { input }),
    applyCanvasCommand: (projectId, canvasId, input) => invoke('applyCanvasCommand', { projectId, canvasId, input }),
    preflightCanvas: (projectId, canvasId, input) => invoke('preflightCanvas', { projectId, canvasId, input }),
    renderCanvas: (projectId, canvasId, input) => invoke('renderCanvas', { projectId, canvasId, input }),
    exportDelivery: (projectId, input) => invoke('exportDelivery', { projectId, input }),
    getDeliverySet: input => invoke('getDeliverySet', input),
    getExportReceipt: input => invoke('getExportReceipt', input),
    getProjectLibrary: projectId => invoke('getProjectLibrary', { projectId }),
  }
}

function createProductionPathClient(socketUrl: string) {
  const actions = new ElectronImageActions({
    getServerUrl: async () => socketUrl,
    ticketSecret,
  })
  // The renderer client only touches the explicit methods above. The cast keeps
  // the production client unchanged while each reachable bridge method stays
  // compile-time checked against the shared Preload contract.
  return createElectronImageWorkbenchClient(
    createProductionPathPreloadBridge(actions) as ImageWorkbenchPreloadBridge,
  )
}

function startProductionPathSocket(service: ImageWorkbenchService): {
  server: ReturnType<typeof Bun.serve>
  url: string
  calls: LocalSocketCall[]
} {
  const calls: LocalSocketCall[] = []
  const images = createImageWorkbenchDomainApiHandler(service.applications, ticketSecret)
  const unavailable = async () => Response.json({ error: 'Not Found' }, { status: 404 })
  // Let the kernel allocate an ephemeral loopback port. A randomly chosen
  // range is still racy under Bun's parallel file runner and can exhaust a
  // constrained test sandbox before this E2E begins.
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      const url = new URL(req.url)
      const response = await handleApiRequest(req, url, {
        media: unavailable,
        images,
        videos: unavailable,
        product: unavailable,
      })
      calls.push({
        path: url.pathname,
        method: req.method,
        ticket: req.headers.get('X-BilliardBuddy-Media-Capability'),
        status: response.status,
      })
      return response
    },
  })
  return { server, url: server.url.origin, calls }
}

async function readyForSocket(service: ImageWorkbenchService): Promise<void> {
  // Avoid closing a still-initializing SQLite repository if a socket fails to
  // bind. This also matches the sidecar's normal ready-before-listen order.
  await service.applications.project.listProjects()
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (condition()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function waitForProjectProjection(
  client: ReturnType<typeof createProductionPathClient>,
  projectId: string,
  condition: (projection: PublicProjection) => boolean,
  description: string,
): Promise<PublicProjection> {
  let latest: PublicProjection | undefined
  for (let attempt = 0; attempt < 600; attempt += 1) {
    latest = unwrapImageWorkbenchClientResult(await client.getProjectProjection({ project_id: projectId }))
    if (condition(latest)) return latest
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${description}; last projection had ${latest?.operations.length ?? 0} operations`)
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
  const handler = createImageWorkbenchDomainApiHandler(service.applications, ticketSecret)
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
        brief_overrides: {
          confirmed_facts: ['赛事时间为 2026 年 8 月'],
          must_preserve: ['门店赛事主题'],
          may_change: ['背景光线'],
          exact_text: ['夏季冠军赛'],
        },
      }),
    })
    expect(withoutReference.status).toBe(202)
    const quickCreated = await withoutReference.json() as {
      project: { references: unknown[]; brief: { confirmed_facts: string[]; must_preserve: string[]; exact_text: string[] } }
    }
    expect(quickCreated.project.references).toEqual([])
    expect(quickCreated.project.brief).toMatchObject({
      confirmed_facts: ['赛事时间为 2026 年 8 月'],
      must_preserve: ['门店赛事主题'],
      exact_text: ['夏季冠军赛'],
    })
    expect(paidSubmissions()).toHaveLength(1)
    expect(paidSubmissions()[0]?.body).toMatchObject({
      mode: 'generate',
      prompt: expect.stringContaining('赛事时间为 2026 年 8 月'),
    })

    const changedReplay = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idempotency_key: 'bb-image-15-5e-quick-create-empty-reference-0001',
        prompt: '为台球赛事制作一张门店宣传图。',
        output_preset: 'square',
        brief_overrides: { confirmed_facts: ['不能替换同一 Quick Create 的完整 Brief'] },
      }),
    })
    expect(changedReplay.status).toBe(409)
    expect(await changedReplay.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })
    expect(paidSubmissions()).toHaveLength(1)

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
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, ticketSecret)

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
    const eventPage = publicMediaJobEventPageSchema.parse(await firstEvents.json())
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
    const restartedHandler = createImageWorkbenchDomainApiHandler(restarted.applications, ticketSecret)
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

test('15.5E 真实侧车 socket 经 Main/Preload 类型桥接完成完整图片工作流及 CAS→DB 崩溃恢复', async () => {
  const rootPath = await root('production-path-socket')
  const legacyRoot = await root('production-path-socket-legacy')
  const relay = successfulGateway(await fixturePng())
  const socketCallSets: LocalSocketCall[][] = []
  let runningServer: ReturnType<typeof Bun.serve> | undefined
  let runningService: ImageWorkbenchService | undefined

  const closeRunning = (): void => {
    runningServer?.stop(true)
    runningServer = undefined
    runningService?.repository.close()
    runningService = undefined
  }

  try {
    await withGateway(async () => {
      let canvasCrashObserved = false
      runningService = new ImageWorkbenchService({
        root: rootPath,
        legacyMediaRoot: legacyRoot,
        now: () => new Date('2026-08-05T00:00:00.000Z'),
        fetchImpl: relay.fetchImpl,
        crashInjector: point => {
          if (point !== 'after_canvas_render_cas_before_db_commit') return
          canvasCrashObserved = true
          throw new Error('15.5E simulate canvas CAS-before-DB process interruption')
        },
      })
      await readyForSocket(runningService)
      const firstSocket = startProductionPathSocket(runningService)
      runningServer = firstSocket.server
      socketCallSets.push(firstSocket.calls)
      const firstClient = createProductionPathClient(firstSocket.url)

      const productReference = await fixtureDataUrl()
      const styleReference = await fixtureDataUrl()
      const logoReferenceData = await fixtureDataUrl()
      const quickCreate = unwrapImageWorkbenchClientResult(await firstClient.quickCreate({
        idempotency_key: 'bb-image-15-5e-production-path-quick-create-0001',
        title: '15.5E 真实侧车链路海报',
        prompt: '为台球门店夏季冠军赛制作一张专业宣传图。',
        output_preset: 'square',
        brief_overrides: {
          confirmed_facts: ['赛事于 2026 年 8 月举行'],
          must_preserve: ['产品主体轮廓', '品牌 Logo'],
          may_change: ['背景灯光与装饰元素'],
        },
        reference_inputs: [
          { data_url: productReference, role: 'product' },
          { data_url: styleReference, role: 'style' },
          { data_url: logoReferenceData, role: 'logo' },
        ],
      }))
      const projectId = quickCreate.project.id
      const quickCreatePlanId = quickCreate.round.creative_plan_id
      const quickCreateRoundId = quickCreate.round.id
      const quickCreateEstimateHash = quickCreate.round.estimate_hash
      const quickCreateConfirmedAt = quickCreate.round.confirmed_at
      const logoReference = quickCreate.project.references.find(reference => reference.role === 'logo')
      if (!logoReference) throw new Error('expected Logo reference to be persisted on the Project')
      expect(quickCreate.project.references.map(reference => reference.role)).toEqual(['product', 'style', 'logo'])
      expect(quickCreate.project.brief).toMatchObject({
        confirmed_facts: ['赛事于 2026 年 8 月举行'],
        must_preserve: ['产品主体轮廓', '品牌 Logo'],
        may_change: ['背景灯光与装饰元素'],
      })
      expect(quickCreatePlanId).toEqual(expect.any(String))
      expect(quickCreateEstimateHash).toMatch(/^sha256:/)
      expect(quickCreateConfirmedAt).toEqual(expect.any(String))
      expect(quickCreate.operations).toHaveLength(1)

      // The ordinary Renderer refresh observes the Round's durable Candidate
      // Group only after the strict fake Relay has returned bytes and the
      // sidecar has committed/ACKed them.
      const candidateProjection = await waitForProjectProjection(
        firstClient,
        projectId,
        projection => projection.operations.some(operation => operation.id === quickCreate.operations[0]!.id && operation.status === 'succeeded')
          && projection.candidate_groups.some(group => group.operation_id === quickCreate.operations[0]!.id),
        'Quick Create Candidate Group',
      )
      expect(candidateProjection.creative_plans.some(plan => plan.id === quickCreatePlanId)).toBeTrue()
      expect(candidateProjection.generation_rounds.some(round => round.id === quickCreateRoundId && round.estimate_hash === quickCreateEstimateHash)).toBeTrue()
      const sourceCandidate = candidateProjection.candidate_groups.find(group => group.operation_id === quickCreate.operations[0]!.id)?.candidates[0]
      if (!sourceCandidate) throw new Error('expected initial Candidate from the persisted Quick Create Round')

      const preview = unwrapImageWorkbenchClientResult(await firstClient.getCandidatePreview({
        project_id: projectId,
        candidate_id: sourceCandidate.id,
      }))
      expect(preview).toMatchObject({ candidate_id: sourceCandidate.id, data_url: expect.stringMatching(/^data:image\/png;base64,/) })

      const initialProviderRequest = relay.calls.find(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')?.body as {
        mode?: string
        images?: string[]
        reference_controls?: Array<{ image_index: number; role: string; influence_strength: string; preservation: string; priority: number }>
      } | undefined
      expect(initialProviderRequest).toMatchObject({
        mode: 'edit',
        images: [productReference, styleReference],
        reference_controls: [
          { image_index: 0, role: 'product', influence_strength: 'high', preservation: 'must_preserve', priority: 0 },
          { image_index: 1, role: 'style', influence_strength: 'medium', preservation: 'prefer_preserve', priority: 1 },
        ],
      })
      // Logo remains an exact local Canvas input rather than an unbounded
      // Provider reference, while Product and Style controls reach the Relay.
      expect(initialProviderRequest?.images).toHaveLength(2)
      expect(initialProviderRequest?.reference_controls?.map(control => control.role)).not.toContain('logo')

      const maskDataUrl = await fixtureDataUrl()
      const derivationEstimate = unwrapImageWorkbenchClientResult(await firstClient.estimateCandidateDerivation({
        project_id: projectId,
        candidate_id: sourceCandidate.id,
        input: {
          base_revision: candidateProjection.project.revision,
          instruction: '仅替换背景为干净的赛事灯光，不改变产品主体。',
          kind: 'inpaint',
          mask_data_url: maskDataUrl,
        },
      }))
      const derivationEstimateHash = derivationEstimate.estimate_hash
      expect(derivationEstimate.paid_operation_count).toBe(1)
      expect(derivationEstimate.candidate_count_per_operation).toBe(3)
      expect(derivationEstimateHash).toMatch(/^sha256:/)
      const derivation = unwrapImageWorkbenchClientResult(await firstClient.deriveCandidate({
        project_id: projectId,
        candidate_id: sourceCandidate.id,
        input: {
          base_revision: candidateProjection.project.revision,
          idempotency_key: 'bb-image-15-5e-production-path-inpaint-derive-0001',
          instruction: '仅替换背景为干净的赛事灯光，不改变产品主体。',
          kind: 'inpaint',
          mask_data_url: maskDataUrl,
          estimate_hash: derivationEstimateHash,
          confirm: true,
        },
      }))
      const derivationOperationId = derivation.operation.id
      expect(derivation.operation.kind).toBe('inpaint')
      expect(derivation.operation.status).toBe('queued')
      const persistedDerivation = await runningService.repository.getGenerationOperation(projectId, derivationOperationId)
      expect(persistedDerivation).toMatchObject({
        kind: 'inpaint',
        base_candidate_id: sourceCandidate.id,
        mask_asset_id: expect.stringMatching(/^mask_/),
      })

      const derivedProjection = await waitForProjectProjection(
        firstClient,
        projectId,
        projection => projection.candidate_groups.some(group => group.operation_id === derivationOperationId),
        'inpaint Candidate Group',
      )
      const derivedCandidate = derivedProjection.candidate_groups
        .find(group => group.operation_id === derivationOperationId)
        ?.candidates.find(candidate => candidate.derived_from_candidate_id === sourceCandidate.id)
      if (!derivedCandidate) throw new Error('expected inpaint Candidate to preserve its immutable source Candidate')
      const derivedProviderRequest = relay.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').at(-1)?.body as {
        mode?: string
        images?: string[]
        mask?: string
        reference_controls?: Array<{ image_index: number; role: string; influence_strength: string; preservation: string; priority: number }>
      } | undefined
      expect(derivedProviderRequest).toMatchObject({
        mode: 'edit',
        mask: maskDataUrl,
        reference_controls: [
          { image_index: 1, role: 'product', influence_strength: 'high', preservation: 'must_preserve', priority: 0 },
          { image_index: 2, role: 'style', influence_strength: 'medium', preservation: 'prefer_preserve', priority: 1 },
        ],
      })
      expect(derivedProviderRequest?.images).toHaveLength(3)

      const artboards = [
        {
          id: 'art_workflow_e_png_0001',
          label: '方形 PNG 海报',
          width: 256,
          height: 256,
          required: true,
          safe_area: { top: 12, right: 12, bottom: 12, left: 12 },
          output: { format: 'png' as const, transparent: false },
        },
        {
          id: 'art_workflow_e_jpeg_0001',
          label: '方形 JPEG 海报',
          width: 256,
          height: 256,
          required: true,
          safe_area: { top: 12, right: 12, bottom: 12, left: 12 },
          output: { format: 'jpeg' as const, quality: 90, background_color: '#ffffff' },
        },
      ]
      const deliverySpec = unwrapImageWorkbenchClientResult(await firstClient.createDeliverySpec({
        project_id: projectId,
        input: {
          base_revision: derivedProjection.project.revision,
          idempotency_key: 'bb-image-15-5e-production-path-delivery-spec-0001',
          purpose: 'poster',
          artboards,
        },
      }))
      expect(deliverySpec.delivery_spec.artboards.map(artboard => artboard.id)).toEqual(artboards.map(artboard => artboard.id))

      const adopted = unwrapImageWorkbenchClientResult(await firstClient.adoptCandidate({
        project_id: projectId,
        candidate_id: derivedCandidate.id,
        input: {
          base_revision: deliverySpec.project.revision,
          idempotency_key: 'bb-image-15-5e-production-path-adopt-both-artboards-0001',
          adoptions: artboards.map(artboard => ({
            artboard_id: artboard.id,
            placement: { fit: 'contain' as const, focus_x: 0.5, focus_y: 0.5 },
          })),
        },
      }))
      expect(adopted.adoptions).toHaveLength(2)
      expect(adopted.adoptions.map(adoption => adoption.artboard_id).sort()).toEqual(artboards.map(artboard => artboard.id).sort())
      const adoptedProjection = unwrapImageWorkbenchClientResult(await firstClient.getProjectProjection({ project_id: projectId }))
      const primaryCanvas = adoptedProjection.canvases.find(canvas => canvas.document.artboard_id === artboards[0]!.id)
      const secondaryCanvas = adoptedProjection.canvases.find(canvas => canvas.document.artboard_id === artboards[1]!.id)
      if (!primaryCanvas || !secondaryCanvas) throw new Error('multi-artboard adoption must create one Canvas per required Artboard')

      const emptyBrand = unwrapImageWorkbenchClientResult(await firstClient.createBrandKit({
        idempotency_key: 'bb-image-15-5e-production-path-brand-create-0001',
        name: '15.5E 台球赛事品牌包',
        revision: {
          logo_asset_ids: [],
          font_asset_ids: ['font_builtin_0001'],
          color_tokens: { primary: '#f5f5f5', ink: '#101820' },
          required_text: [{ id: 'req_workflow_e_text_0001', value: '台球夏季冠军赛', purpose: 'slogan' }],
        },
      }))
      const assetGrant = unwrapImageWorkbenchClientResult(await firstClient.createAssetGrant({
        input: {
          idempotency_key: 'bb-image-15-5e-production-path-logo-grant-0001',
          asset_id: logoReference.asset_id,
          to_owner: { kind: 'brand_kit', id: emptyBrand.brand_kit.id },
          purpose: 'template_use',
        },
      }))
      const branded = unwrapImageWorkbenchClientResult(await firstClient.reviseBrandKit({
        brand_kit_id: emptyBrand.brand_kit.id,
        input: {
          base_revision: emptyBrand.brand_kit.revision,
          idempotency_key: 'bb-image-15-5e-production-path-brand-revise-0001',
          revision: {
            logo_asset_ids: [logoReference.asset_id],
            font_asset_ids: ['font_builtin_0001'],
            color_tokens: { primary: '#f5f5f5', ink: '#101820' },
            required_text: [{ id: 'req_workflow_e_text_0001', value: '台球夏季冠军赛', purpose: 'slogan' }],
          },
        },
      }))
      expect(branded.revision.logo_asset_ids).toEqual([logoReference.asset_id])
      expect(unwrapImageWorkbenchClientResult(await firstClient.listAssetGrants()).grants).toContainEqual(
        expect.objectContaining({ id: assetGrant.grant.id, asset_id: logoReference.asset_id, to_owner: { kind: 'brand_kit', id: emptyBrand.brand_kit.id } }),
      )

      const template = unwrapImageWorkbenchClientResult(await firstClient.createTemplate({
        idempotency_key: 'bb-image-15-5e-production-path-template-create-0001',
        name: '15.5E 台球赛事标准模板',
        revision: {
          brand_kit_id: branded.brand_kit.id,
          brand_kit_revision_id: branded.revision.id,
          blueprint: {
            schema_version: 1,
            artboard: { width: 256, height: 256 },
            background: { kind: 'solid', color: 'brand.primary' },
            layers: [
              {
                id: 'logo_workflow_e_0001',
                kind: 'logo',
                source_asset_id: logoReference.asset_id,
                transform: { x: 16, y: 16, width: 28, height: 28, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
                preserve_exact_source: true,
                render_mode: 'raster_exact',
              },
              {
                id: 'text_workflow_e_title_0001',
                kind: 'text',
                requirement_id: 'req_workflow_e_text_0001',
                text: '台球夏季冠军赛',
                font_family: 'BilliardBuddy Builtin CJK',
                font_asset_id: 'font_builtin_0001',
                font_size: 24,
                min_font_size: 14,
                font_weight: 700,
                font_style: 'normal',
                line_height: 1.2,
                letter_spacing: 0,
                fill: 'brand.ink',
                position: { x: 16, y: 64 },
                rotation_degrees: 0,
                max_width: 224,
                max_height: 56,
                overflow: 'shrink_to_fit',
                locale: 'zh-CN',
                align: 'left',
                opacity: 1,
              },
            ],
          },
          slots: [{ id: 'slot_workflow_e_title', layer_id: 'text_workflow_e_title_0001', kind: 'text', required: true }],
          schema_version: 1,
        },
      }))
      const primaryTemplate = unwrapImageWorkbenchClientResult(await firstClient.applyCanvasCommand({
        project_id: projectId,
        canvas_id: primaryCanvas.canvas_id,
        input: {
          base_project_revision: adopted.project.revision,
          command: {
            idempotency_key: 'bb-image-15-5e-production-path-template-primary-0001',
            base_revision: primaryCanvas.revision,
            kind: 'apply_template',
            payload: {
              template_id: template.template.id,
              template_revision_id: template.revision.id,
              slot_bindings: [{ slot_id: 'slot_workflow_e_title', text: '台球夏季冠军赛' }],
            },
          },
        },
      }))
      const secondaryTemplate = unwrapImageWorkbenchClientResult(await firstClient.applyCanvasCommand({
        project_id: projectId,
        canvas_id: secondaryCanvas.canvas_id,
        input: {
          base_project_revision: primaryTemplate.project_revision,
          command: {
            idempotency_key: 'bb-image-15-5e-production-path-template-secondary-0001',
            base_revision: secondaryCanvas.revision,
            kind: 'apply_template',
            payload: {
              template_id: template.template.id,
              template_revision_id: template.revision.id,
              slot_bindings: [{ slot_id: 'slot_workflow_e_title', text: '台球夏季冠军赛' }],
            },
          },
        },
      }))
      expect(primaryTemplate.canvas.document).toMatchObject({
        brand_kit_id: branded.brand_kit.id,
        brand_kit_revision_id: branded.revision.id,
        template_id: template.template.id,
        template_revision_id: template.revision.id,
      })
      expect(secondaryTemplate.canvas.document.layers.some(layer => layer.kind === 'group')).toBeTrue()

      for (const canvas of [primaryTemplate.canvas, secondaryTemplate.canvas]) {
        const preflight = unwrapImageWorkbenchClientResult(await firstClient.preflightCanvas({
          project_id: projectId,
          canvas_id: canvas.canvas_id,
          input: { revision: canvas.revision },
        }))
        expect(preflight.preflight.passed).toBeTrue()
        expect(preflight.preflight.checks.find(check => check.id === 'font-and-text-bounds')).toMatchObject({ status: 'pass' })
        expect(preflight.preflight.checks.find(check => check.id === 'required-safe-area')).toMatchObject({ status: 'pass' })
      }

      const queuedPrimaryRender = unwrapImageWorkbenchClientResult(await firstClient.renderCanvas({
        project_id: projectId,
        canvas_id: primaryTemplate.canvas.canvas_id,
        input: {
          base_revision: secondaryTemplate.project_revision,
          idempotency_key: 'bb-image-15-5e-production-path-render-primary-0001',
          canvas_revision: primaryTemplate.canvas.revision,
          activate_on_success: true,
        },
      }))
      expect(queuedPrimaryRender.operation.status).toBe('queued')
      await waitForCondition(() => canvasCrashObserved, 'Canvas CAS-before-DB interruption')
      expect((await runningService.applications.generation.getGenerationOperation(projectId, queuedPrimaryRender.operation.id)).status).toBe('queued')
      expect((await readdir(join(rootPath, 'cas', 'sha256'))).length).toBeGreaterThan(0)

      // Stop the real sidecar listener and SQLite writer. The next process
      // resumes this durable local operation; the renderer does not submit a
      // second Render command for the same Canvas revision.
      closeRunning()

      let exportCrashObserved = false
      runningService = new ImageWorkbenchService({
        root: rootPath,
        legacyMediaRoot: legacyRoot,
        now: () => new Date('2026-08-05T00:00:00.000Z'),
        fetchImpl: relay.fetchImpl,
        crashInjector: point => {
          if (point !== 'after_export_cas_before_db_commit') return
          exportCrashObserved = true
          throw new Error('15.5E simulate export CAS-before-DB process interruption')
        },
      })
      await readyForSocket(runningService)
      const secondSocket = startProductionPathSocket(runningService)
      runningServer = secondSocket.server
      socketCallSets.push(secondSocket.calls)
      const secondClient = createProductionPathClient(secondSocket.url)
      await runningService.recoveryApplication.recoverInterruptedOperations()

      const primaryRenderedProjection = await waitForProjectProjection(
        secondClient,
        projectId,
        projection => {
          const versionId = projection.project.current_versions_by_artboard[artboards[0]!.id]
          return Boolean(versionId && projection.project.version_history.some(version =>
            version.id === versionId && version.kind === 'canvas' && version.artboard_id === artboards[0]!.id))
        },
        'recovered primary Canvas Version',
      )
      const primaryVersionId = primaryRenderedProjection.project.current_versions_by_artboard[artboards[0]!.id]
      if (!primaryVersionId) throw new Error('restarted local Canvas operation did not activate its primary Version')
      expect(primaryRenderedProjection.project.version_history.find(version => version.id === primaryVersionId)).toMatchObject({
        id: primaryVersionId,
        kind: 'canvas',
        artboard_id: artboards[0]!.id,
        canvas_id: primaryTemplate.canvas.canvas_id,
        canvas_revision: primaryTemplate.canvas.revision,
      })
      const primaryPreview = unwrapImageWorkbenchClientResult(await secondClient.getVersionPreview({
        project_id: projectId,
        version_id: primaryVersionId,
      }))
      expect(primaryPreview.version_id).toBe(primaryVersionId)
      expect(primaryPreview.data_url).toStartWith('data:image/png;base64,')

      // A formal Canvas Version is a first-class Edit source. The exact same
      // Renderer -> Preload -> Main Action -> ticketed Sidecar path must
      // produce a source-bound paid quote and a recoverable Round, without
      // overwriting the immutable Version or issuing a second submission.
      const versionDerivationEstimateResult = await secondClient.estimateVersionDerivation({
        project_id: projectId,
        version_id: primaryVersionId,
        input: {
          base_revision: primaryRenderedProjection.project.revision,
          instruction: '只调整正式成品的背景亮度，保留全部文字和二维码。',
          kind: 'edit',
        },
      })
      if (!versionDerivationEstimateResult.ok) {
        const trace = socketCallSets.flat().filter(call => call.path.endsWith('/derivations/estimate')).at(-1)
        throw new Error(`Version derivation estimate failed: ${JSON.stringify({ error: versionDerivationEstimateResult.error, trace })}`)
      }
      const versionDerivationEstimate = versionDerivationEstimateResult.value
      expect(versionDerivationEstimate).toMatchObject({ paid_operation_count: 1 })
      const versionDerivation = unwrapImageWorkbenchClientResult(await secondClient.deriveVersion({
        project_id: projectId,
        version_id: primaryVersionId,
        input: {
          base_revision: primaryRenderedProjection.project.revision,
          idempotency_key: 'bb-image-15-5e-production-path-version-edit-0001',
          instruction: '只调整正式成品的背景亮度，保留全部文字和二维码。',
          kind: 'edit',
          estimate_hash: versionDerivationEstimate.estimate_hash,
          confirm: true,
        },
      }))
      expect(versionDerivation.operation).toMatchObject({ kind: 'edit', base_version_id: primaryVersionId })
      expect(versionDerivation.operation).not.toHaveProperty('base_candidate_id')
      const versionDerivedProjection = await waitForProjectProjection(
        secondClient,
        projectId,
        projection => projection.candidate_groups.some(group => group.operation_id === versionDerivation.operation.id),
        'Version Edit Candidate Group',
      )
      expect(versionDerivedProjection.candidate_groups.find(group => group.operation_id === versionDerivation.operation.id)).toMatchObject({
        base_version_id: primaryVersionId,
      })
      const versionDerivedOperation = await runningService.applications.generation.getGenerationOperation(projectId, versionDerivation.operation.id)
      expect(versionDerivedOperation).toMatchObject({
        kind: 'edit', base_version_id: primaryVersionId,
      })
      expect(versionDerivedOperation).not.toHaveProperty('base_candidate_id')

      const recoveredSecondaryCanvas = versionDerivedProjection.canvases.find(canvas => canvas.canvas_id === secondaryTemplate.canvas.canvas_id)
      if (!recoveredSecondaryCanvas) throw new Error('expected secondary Canvas after restart')
      const queuedSecondaryRender = unwrapImageWorkbenchClientResult(await secondClient.renderCanvas({
        project_id: projectId,
        canvas_id: recoveredSecondaryCanvas.canvas_id,
        input: {
          base_revision: versionDerivedProjection.project.revision,
          idempotency_key: 'bb-image-15-5e-production-path-render-secondary-0001',
          canvas_revision: recoveredSecondaryCanvas.revision,
          activate_on_success: true,
        },
      }))
      expect(queuedSecondaryRender.operation.status).toBe('queued')
      const fullyRenderedProjection = await waitForProjectProjection(
        secondClient,
        projectId,
        projection => {
          const versionId = projection.project.current_versions_by_artboard[artboards[1]!.id]
          return Boolean(versionId && projection.project.version_history.some(version =>
            version.id === versionId && version.kind === 'canvas' && version.artboard_id === artboards[1]!.id))
        },
        'secondary Canvas Version',
      )
      const secondaryVersionId = fullyRenderedProjection.project.current_versions_by_artboard[artboards[1]!.id]
      if (!secondaryVersionId) throw new Error('expected secondary Canvas Render to activate a Version')

      const queuedExport = unwrapImageWorkbenchClientResult(await secondClient.exportDelivery({
        project_id: projectId,
        input: {
          base_revision: fullyRenderedProjection.project.revision,
          idempotency_key: 'bb-image-15-5e-production-path-export-both-artboards-0001',
          version_ids_by_artboard: {
            [artboards[0]!.id]: primaryVersionId,
            [artboards[1]!.id]: secondaryVersionId,
          },
        },
      }))
      expect(queuedExport.operation.status).toBe('queued')
      let exportState = 'queued'
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (exportCrashObserved) break
        const operation = await runningService.applications.generation.getGenerationOperation(projectId, queuedExport.operation.id)
        exportState = operation.status
        if (operation.status === 'failed' || operation.status === 'succeeded' || operation.status === 'cancelled') {
          throw new Error(`Export reached terminal state before the CAS→DB crash injection: ${JSON.stringify({ status: operation.status, safe_error: operation.safe_error })}`)
        }
        await Bun.sleep(20)
      }
      expect(exportCrashObserved, `timed out waiting for Export CAS-before-DB interruption; last state=${exportState}`).toBeTrue()
      expect((await runningService.applications.generation.getGenerationOperation(projectId, queuedExport.operation.id)).status).toBe('queued')

      closeRunning()

      runningService = new ImageWorkbenchService({
        root: rootPath,
        legacyMediaRoot: legacyRoot,
        now: () => new Date('2026-08-05T00:00:00.000Z'),
        fetchImpl: relay.fetchImpl,
      })
      await readyForSocket(runningService)
      const thirdSocket = startProductionPathSocket(runningService)
      runningServer = thirdSocket.server
      socketCallSets.push(thirdSocket.calls)
      const thirdClient = createProductionPathClient(thirdSocket.url)
      await runningService.recoveryApplication.recoverInterruptedOperations()

      const completedProjection = await waitForProjectProjection(
        thirdClient,
        projectId,
        projection => Boolean(projection.project.latest_delivery_set_id),
        'recovered Delivery Set',
      )
      const deliverySetId = completedProjection.project.latest_delivery_set_id
      if (!deliverySetId) throw new Error('restarted Export did not commit its Delivery Set')
      const delivery = unwrapImageWorkbenchClientResult(await thirdClient.getDeliverySet({
        project_id: projectId,
        delivery_set_id: deliverySetId,
      }))
      expect(delivery.delivery_set.version_ids_by_artboard).toEqual({
        [artboards[0]!.id]: primaryVersionId,
        [artboards[1]!.id]: secondaryVersionId,
      })
      expect(Object.values(delivery.delivery_set.export_receipt_ids_by_artboard)).toHaveLength(2)
      const persistedProject = await runningService.applications.project.getProject(projectId)
      for (const artboard of artboards) {
        const receiptId = delivery.delivery_set.export_receipt_ids_by_artboard[artboard.id]
        if (!receiptId) throw new Error(`Delivery Set did not retain the Export receipt for ${artboard.id}`)
        const receipt = unwrapImageWorkbenchClientResult(await thirdClient.getExportReceipt({
          project_id: projectId,
          export_receipt_id: receiptId,
        })).export_receipt
        const exportedAsset = persistedProject.assets.find(asset => asset.id === receipt.output_asset_id)
        if (!exportedAsset) throw new Error('export receipt did not point at a persisted CAS asset')
        const verified = await runningService.assets.readVerified(exportedAsset)
        expect(verified.content_hash).toBe(receipt.output_hash)
        expect(receipt.created_at).toMatch(/^2026-08-05T/)
        expect(receipt.output_format).toBe(artboard.output.format)
      }
      expect((await stat(join(rootPath, 'metadata', 'metadata.sqlite'))).isFile()).toBeTrue()
      expect((await readdir(join(rootPath, 'cas', 'sha256'))).length).toBeGreaterThan(0)

      const library = unwrapImageWorkbenchClientResult(await thirdClient.getProjectLibrary({ project_id: projectId }))
      expect(library.entries).toContainEqual(expect.objectContaining({ asset_id: derivedCandidate.asset_id, role: 'result' }))
      const events = publicMediaJobEventPageSchema.parse(unwrapImageWorkbenchClientResult(await thirdClient.listOperationEvents({
        project_id: projectId,
        cursor: 0,
        limit: 200,
        wait_ms: 0,
      })))
      expect(events.reset_required).toBeFalse()
      expect(events.events.length).toBeGreaterThanOrEqual(8)
      expect(events.events.map(event => event.cursor)).toEqual([...events.events.map(event => event.cursor)].sort((left, right) => left - right))
      const exhaustedEvents = publicMediaJobEventPageSchema.parse(unwrapImageWorkbenchClientResult(await thirdClient.listOperationEvents({
        project_id: projectId,
        cursor: events.cursor,
        limit: 200,
        wait_ms: 0,
      })))
      expect(exhaustedEvents).toMatchObject({ events: [], cursor: events.cursor, reset_required: false })

      expect(relay.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(3)
      const protectedPaths = [
        '/api/images/quick-create',
        `/api/images/projects/${projectId}/candidates/${sourceCandidate.id}/content`,
        `/api/images/projects/${projectId}/candidates/${sourceCandidate.id}/derivations/estimate`,
        `/api/images/projects/${projectId}/candidates/${sourceCandidate.id}/derivations`,
        `/api/images/projects/${projectId}/delivery-spec/revisions`,
        `/api/images/projects/${projectId}/candidates/${derivedCandidate.id}/adoptions`,
        '/api/images/brand-kits',
        '/api/images/asset-grants',
        `/api/images/brand-kits/${branded.brand_kit.id}/revisions`,
        '/api/images/templates',
        `/api/images/projects/${projectId}/canvases/${primaryTemplate.canvas.canvas_id}/commands`,
        `/api/images/projects/${projectId}/canvases/${primaryTemplate.canvas.canvas_id}/preflights`,
        `/api/images/projects/${projectId}/canvases/${primaryTemplate.canvas.canvas_id}/renders`,
        `/api/images/projects/${projectId}/canvases/${secondaryTemplate.canvas.canvas_id}/renders`,
        `/api/images/projects/${projectId}/versions/${primaryVersionId}/content`,
        `/api/images/projects/${projectId}/versions/${primaryVersionId}/derivations/estimate`,
        `/api/images/projects/${projectId}/versions/${primaryVersionId}/derivations`,
        `/api/images/projects/${projectId}/exports`,
        `/api/images/projects/${projectId}/delivery-sets/${deliverySetId}`,
        ...Object.values(delivery.delivery_set.export_receipt_ids_by_artboard).map(receiptId => `/api/images/projects/${projectId}/export-receipts/${receiptId}`),
        `/api/images/projects/${projectId}/library`,
        `/api/images/projects/${projectId}/events`,
      ]
      const socketCalls = socketCallSets.flat()
      for (const path of protectedPaths) {
        const matching = socketCalls.find(call => call.path === path)
        expect(matching?.ticket).toMatch(/^bbimg1\./)
        expect(matching?.ticket).not.toBe(ticketSecret)
      }
      expect(socketCalls.find(call => call.path === `/api/images/projects/${projectId}/versions/${primaryVersionId}/derivations/estimate`)).toMatchObject({
        method: 'POST', status: 200,
      })
      expect(socketCalls.find(call => call.path === `/api/images/projects/${projectId}/versions/${primaryVersionId}/derivations`)).toMatchObject({
        method: 'POST', status: 202,
      })
      const issuedTickets = socketCalls.map(call => call.ticket).filter((ticket): ticket is string => Boolean(ticket))
      expect(issuedTickets).toHaveLength(socketCalls.length)
      expect(new Set(issuedTickets).size).toBe(issuedTickets.length)
    })
  } finally {
    closeRunning()
  }
}, 90_000)
