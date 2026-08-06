import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { createRelayFetch } from '../../relay/app.ts'
import {
  imageWorkbenchProjectSchema,
  mediaDeletionReceiptSchema,
  mediaJobEventJournalSchema,
  mediaSafeError,
  mediaSafeErrorForServiceError,
  mediaTaskSchema,
} from '../shared/contracts/media.js'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { createMediaApiHandler } from '../src/server/api/media.js'
import { handleApiRequest } from '../src/server/router.js'
import { createMediaRuntime } from '../src/server/media/runtime/createMediaRuntime.js'
import { ImageRecoveryApplication } from '../src/server/media/image/application/imageRecoveryApplication.js'
import type { ImageRecoveryApplicationPort } from '../src/server/media/image/runtime/imageApplicationPorts.js'
import { MediaProjectService } from '../src/server/services/mediaProjectService.js'
import { productGatewayTarget, productImageRelayTarget } from '../src/server/product/productGatewayRuntime.js'
import {
  ImageWorkbenchService,
  type ImageWorkbenchApplications,
} from '../src/server/services/imageWorkbenchService.js'
import type { ImageOperation } from '../src/server/services/imageWorkbenchRepository.js'
import { imageTicketRequest } from './helpers/imageUiTicket.js'

const roots: string[] = []
const at = '2026-08-03T00:00:00.000Z'
const gatewayUrl = 'https://gateway.example.test/gw'
const imageRelayUrl = 'https://images.example.test/image-generation'
const gatewayToken = 'baseline-gateway-token-0123456789abcdef'

test('Image Relay 缺失稳定投影为图片能力不可用', () => {
  expect(mediaSafeErrorForServiceError('IMAGE_RELAY_NOT_CONFIGURED', 503))
    .toEqual(mediaSafeError('MEDIA_IMAGE_UNAVAILABLE'))
})

test('MediaRuntime 仅公开五个 Application，不泄露兼容 façade 或 raw runtime', async () => {
  const root = await testRoot('application-composition')
  const legacyMediaRoot = await testRoot('application-composition-legacy')
  const media = createMediaRuntime({
    imageWorkbench: { root, legacyMediaRoot, now: () => new Date(at) },
  })

  expect(media).not.toHaveProperty('imageRuntime')
  expect(media).not.toHaveProperty('imageWorkbench')
  expect(media).not.toHaveProperty('imageProject')
  expect(media.imageApplications.project).not.toHaveProperty('port')
  expect(media.imageApplications.project).not.toHaveProperty('repository')
  expect(media.imageApplications.project).not.toHaveProperty('renderCanvas')
  expect(media.imageApplications.generation).not.toHaveProperty('exportDelivery')
  expect(media.imageApplications.canvas).not.toHaveProperty('recoverInterruptedOperations')
  expect(media.imageApplications.delivery).not.toHaveProperty('createCreativePlan')
  expect(media.imageApplications.recovery).not.toHaveProperty('createProject')

  const project = await media.imageApplications.project.createProject({
    title: 'Application 组合项目',
    user_request: '验证 MediaRuntime 唯一 writer',
    size: '1024x1024',
    reference_images: [],
    reference_roles: [],
  })
  expect((await media.imageApplications.project.getProject(project.id)).id).toBe(project.id)

  const handler = createImageWorkbenchDomainApiHandler(media.imageApplications)
  const url = new URL('/api/images/projects', 'http://127.0.0.1:3456')
  const response = await handler(new Request(url), url, ['api', 'images', 'projects'])
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ projects: [{ id: project.id }] })

  const preferencesUrl = new URL('/api/images/generation-preferences', 'http://127.0.0.1:3456')
  const preferencesResponse = await handler(new Request(preferencesUrl), preferencesUrl, ['api', 'images', 'generation-preferences'])
  expect(preferencesResponse.status).toBe(200)
  const preferences = await preferencesResponse.json() as { generation_preferences: { models: Array<{ id: string }>; output_presets: Array<{ id: string }> } }
  expect(preferences.generation_preferences.models.map(model => model.id)).toEqual([
    'auto', 'gpt-image-2', 'doubao-seedream-4-5-251128',
  ])
  expect(preferences.generation_preferences.output_presets.map(preset => preset.id)).toEqual([
    'square', 'social_landscape', 'social_portrait', 'story', 'presentation', 'wide_banner',
  ])
  expect(JSON.stringify(preferences)).not.toMatch(/\b\d{3,5}x\d{3,5}\b/u)
})

test('Recovery Application 固定取消、远端、Canvas/Export、Qwen ACK、Campaign 的重启顺序', async () => {
  const calls: string[] = []
  const transport = { id: 'task_recovery_order_0001', status: 'committing' } as ImageOperation
  const generation = { id: 'op_recovery_order_0001' }
  const canvas = { id: 'op_recovery_canvas_0001', local_delivery: { kind: 'canvas_render' } }
  const exportOperation = { id: 'op_recovery_export_0001', local_delivery: { kind: 'export' } }
  const receipt = { id: 'receipt_recovery_advice_0001' }
  const unused = async () => undefined
  const port = {
    listDeletions: async () => [],
    hasProjectHistory: async () => false,
    hasOperationHistory: async () => false,
    deleteProject: unused,
    restoreProject: unused,
    getOperation: async () => transport,
    listOperationEvents: async () => ({ events: [], next_cursor: 0 }),
    waitForOperationEvents: async () => ({ events: [], next_cursor: 0 }),
    migrateLegacyMediaStore: async () => ({ migrated_project_ids: [], skipped_project_ids: [] }),
    cancelOperation: async () => transport,
    reconcileCampaignItemProjectBinding: unused,
    recovery: {
      recoverPreparedCampaignCancellations: async () => { calls.push('campaign-cancellation') },
      listTransportOperations: async () => { calls.push('transport-list'); return [transport] },
      fenceInterruptedSubmission: async () => { calls.push('transport-fence'); return transport },
      findGenerationOperationByTransportTask: async () => { calls.push('formal-lookup'); return generation },
      resumeUnpostedGenerationOperation: async () => { calls.push('transport-resume'); return transport },
      recoverOutcomeUnknownOperation: async () => { calls.push('outcome-lookup'); return transport },
      refreshPersistedOperation: async () => { calls.push('committing-refresh'); return transport },
      acknowledgeRemoteResult: async () => { calls.push('remote-ack'); return transport },
      syncGenerationOperationFromTransport: async () => { calls.push('formal-sync'); return generation },
      listRecoverableLocalDeliveryOperations: async () => { calls.push('local-list'); return [canvas, exportOperation] },
      resumeCanvasRender: async () => { calls.push('canvas-resume') },
      resumeExportDelivery: async () => { calls.push('export-resume') },
      listUnacknowledgedGatewayAdviceReceipts: async () => { calls.push('advice-list'); return [receipt] },
      acknowledgeQwenGatewayResult: async () => { calls.push('advice-ack'); return receipt },
      recoverCampaigns: async () => { calls.push('campaign-recover') },
    },
  } as unknown as ImageRecoveryApplicationPort

  await new ImageRecoveryApplication(port).recoverInterruptedOperations()
  expect(calls).toEqual([
    'campaign-cancellation',
    'transport-list',
    'transport-fence',
    'formal-lookup',
    'transport-resume',
    'outcome-lookup',
    'committing-refresh',
    'remote-ack',
    'formal-lookup',
    'formal-sync',
    'local-list',
    'canvas-resume',
    'export-resume',
    'advice-list',
    'advice-ack',
    'campaign-recover',
  ])
})

test('正式图片 API 按用例 Application 分派，不重新合并成通用 service', async () => {
  const service = await createService('application-route-dispatch')
  const project = await createProject(service)
  const referenceProject = await service.applications.project.createProject({
    title: 'Reference Control 应用路由',
    user_request: '为主体参考图设置明确控制规则',
    size: '1024x1024',
    reference_images: [await dataUrl()],
    reference_roles: ['subject'],
  })
  const traced = traceApplications(service.applications)
  const capability = 'applicationroutedispatchcapability0000'
  const handler = createImageWorkbenchDomainApiHandler(traced.applications, capability)

  await expect(request(handler, '/api/images/projects')).resolves.toMatchObject({ status: 200 })
  expect(traced.calls).toEqual(['project.listProjects'])

  traced.calls.splice(0)
  await expect(request(handler, '/api/images/deletions')).resolves.toMatchObject({ status: 200 })
  expect(traced.calls).toEqual(['recovery.listDeletions'])

  traced.calls.splice(0)
  await expect(request(handler, `/api/images/projects/${project.id}/library`)).resolves.toMatchObject({ status: 200 })
  expect(traced.calls).toEqual(['delivery.listProjectLibrary'])

  traced.calls.splice(0)
  await expect(request(handler, `/api/images/projects/${project.id}/canvases`)).resolves.toMatchObject({ status: 200 })
  expect(traced.calls).toEqual(['canvas.listCanvases'])

  traced.calls.splice(0)
  await expect(request(handler, `/api/images/projects/${project.id}/operations`)).resolves.toMatchObject({ status: 200 })
  expect(traced.calls).toEqual(['generation.listGenerationOperations'])

  traced.calls.splice(0)
  const planResponse = await request(handler, `/api/images/projects/${project.id}/creative-plans`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BilliardBuddy-Media-Capability': capability,
    },
    body: JSON.stringify({
      base_revision: project.revision,
      idempotency_key: 'bb-image-generation-application-plan-route-0001',
    }),
  })
  expect(planResponse.status).toBe(201)
  expect(traced.calls).toEqual(['generation.createCreativePlan'])

  const delivery = await service.repository.currentDeliverySpec(project.id)
  if (!delivery) throw new Error('expected initial delivery specification')
  traced.calls.splice(0)
  const exportResponse = await request(handler, `/api/images/projects/${project.id}/exports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BilliardBuddy-Media-Capability': capability,
    },
    body: JSON.stringify({
      base_revision: project.revision,
      idempotency_key: 'bb-image-delivery-application-export-route-0001',
      // The acceptance route must be testable without rendering a real
      // version; the worker will deterministically close this invalid job.
      version_ids_by_artboard: { [delivery.artboards[0]!.id]: 'ver_export_route_missing_0001' },
    }),
  })
  expect(exportResponse.status).toBe(202)
  expect(traced.calls).toEqual(['delivery.exportDelivery'])

  const referenceId = `ref_${createHash('sha256').update([referenceProject.id, referenceProject.references[0]!.asset_id].join('\0')).digest('hex').slice(0, 32)}`
  traced.calls.splice(0)
  const referenceResponse = await request(handler, `/api/images/projects/${referenceProject.id}/references/${referenceId}/commands/update-control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BilliardBuddy-Media-Capability': capability,
    },
    body: JSON.stringify({
      base_revision: referenceProject.revision,
      idempotency_key: 'bb-image-project-application-reference-control-0001',
      role: 'subject',
      influence_strength: 'high',
      preservation: 'must_preserve',
      priority: 100,
    }),
  })
  expect(referenceResponse.status).toBe(200)
  expect(traced.calls).toEqual(['project.assertProjectOwner', 'project.updateReferenceControl'])
})

test('Reference Control 由 Project Application 重放并补回中断前缺失的 generation header', async () => {
  const service = await createService('reference-control-header-replay')
  const project = await service.applications.project.createProject({
    title: 'Reference Control header 回放',
    user_request: '先修改参考图控制，再验证本地 header 恢复',
    size: '1024x1024',
    reference_images: [await dataUrl()],
    reference_roles: ['subject'],
  })
  const referenceId = `ref_${createHash('sha256').update([project.id, project.references[0]!.asset_id].join('\0')).digest('hex').slice(0, 32)}`
  const input = {
    base_revision: project.revision,
    idempotency_key: 'bb-image-project-application-header-replay-0001',
    role: 'product' as const,
    influence_strength: 'high' as const,
    preservation: 'must_preserve' as const,
    priority: 88,
  }
  const controlled = await service.applications.project.updateReferenceControl(project.id, referenceId, input)
  expect(controlled.current_brief_id).toMatch(/^brf_/)
  expect(controlled.current_delivery_spec_id).toMatch(/^dsp_/)

  const headerLost = await service.repository.saveProject({
    ...controlled,
    current_brief_id: undefined,
    current_delivery_spec_id: undefined,
    current_delivery_spec_revision: undefined,
    revision: controlled.revision + 1,
  })
  const replayed = await service.applications.project.updateReferenceControl(project.id, referenceId, input)

  expect(replayed.revision).toBe(headerLost.revision + 1)
  expect(replayed.current_brief_id).toMatch(/^brf_/)
  expect(replayed.current_delivery_spec_id).toMatch(/^dsp_/)
  expect(replayed.references[0]).toMatchObject({
    role: 'product', influence_strength: 'high', preservation: 'must_preserve', priority: 88,
  })
})

test('旧 /api/media 在调用 writer、恢复或 Relay 前拒绝全部图片项目路径', async () => {
  const root = await testRoot('retired-generic-image-route')
  const project = imageWorkbenchProjectSchema.parse(await fixtureJson('legacy/project.json'))
  const task = mediaTaskSchema.parse(await fixtureJson('legacy/operation.json')) as ImageOperation
  const deletion = mediaDeletionReceiptSchema.parse({
    schema_version: 1,
    deletion_id: 'del_legacy_image_route',
    project_id: project.id,
    project_kind: 'image',
    project_title: project.title,
    owner: project.owner,
    status: 'deleted',
    deleted_at: at,
    purge_after: '2026-09-03T00:00:00.000Z',
    task_ids: [task.id],
    managed_asset_count: 0,
    managed_asset_bytes: 0,
    trash_key: 'del_legacy_image_route',
  })
  await Promise.all([
    mkdir(join(root, 'projects'), { recursive: true }),
    mkdir(join(root, 'tasks'), { recursive: true }),
    mkdir(join(root, 'deletions'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'projects', `${project.id}.json`), JSON.stringify(project)),
    writeFile(join(root, 'tasks', `${task.id}.json`), JSON.stringify(task)),
    writeFile(join(root, 'deletions', `${deletion.deletion_id}.json`), JSON.stringify(deletion)),
  ])
  const beforeProject = await readFile(join(root, 'projects', `${project.id}.json`), 'utf8')
  const beforeTask = await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')
  const beforeDeletion = await readFile(join(root, 'deletions', `${deletion.deletion_id}.json`), 'utf8')
  let relayCalls = 0
  const service = new MediaProjectService({
    root,
    fetchImpl: async () => {
      relayCalls += 1
      throw new Error('generic image route must not reach Relay')
    },
  })
  const media = createMediaApiHandler(service)
  const request = async (path: string, init: RequestInit = {}) => {
    const url = new URL(path, 'http://127.0.0.1:3456')
    return await handleApiRequest(new Request(url, init), url, {
      media,
      images: async () => new Response('unexpected images route', { status: 500 }),
      videos: async () => new Response('unexpected videos route', { status: 500 }),
      product: async () => new Response('unexpected product route', { status: 500 }),
    })
  }

  for (const [path, init] of [
    ['/api/media/images', {}],
    ['/api/media/projects?kind=image', {}],
    [`/api/media/projects/${project.id}/events`, {}],
    [`/api/media/assets/${project.id}/legacy.png`, {}],
    [`/api/media/project/${project.id}`, {}],
    [`/api/media/project/${project.id}`, { method: 'DELETE' }],
    [`/api/media/project/${project.id}/restore`, { method: 'POST' }],
    [`/api/media/tasks/${task.id}`, {}],
    [`/api/media/tasks/${task.id}/cancel`, { method: 'POST' }],
  ] as const) {
    const response = await request(path, init)
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
  }

  expect((await request('/api/media/projects')).status).toBe(200)
  expect(await (await request('/api/media/projects')).json()).toEqual({ projects: [] })
  expect(await (await request('/api/media/deletions')).json()).toEqual({ deletions: [] })
  expect(await readFile(join(root, 'projects', `${project.id}.json`), 'utf8')).toBe(beforeProject)
  expect(await readFile(join(root, 'tasks', `${task.id}.json`), 'utf8')).toBe(beforeTask)
  expect(await readFile(join(root, 'deletions', `${deletion.deletion_id}.json`), 'utf8')).toBe(beforeDeletion)
  await expect(stat(join(root, 'locks'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(relayCalls).toBe(0)
})

test('兼容图片项目缺省候选数量固定为单张且旧项目数量不会抬高新请求', async () => {
  const service = new MediaProjectService({ root: await testRoot('legacy-image-output-count') })
  const source = imageWorkbenchProjectSchema.parse(await fixtureJson('legacy/project.json'))
  const { count: _count, ...withoutCount } = source
  const defaulted = imageWorkbenchProjectSchema.parse(withoutCount)
  const newDefaults = imageWorkbenchProjectSchema.parse({ ...source, count: undefined, candidate_count: undefined })
  const compatibility = service as unknown as {
    imageSubmissionPayload(project: typeof defaulted): Promise<{ n?: number }>
  }

  expect((await compatibility.imageSubmissionPayload(defaulted)).n).toBe(1)
  expect((await compatibility.imageSubmissionPayload({ ...source, count: 4 })).n).toBe(1)
  expect(newDefaults).toMatchObject({ count: 1, candidate_count: 1 })
})

async function testRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `billiardbuddy-image-${label}-`))
  roots.push(root)
  return root
}

async function dataUrl(name = 'valid-1x1.png.base64'): Promise<string> {
  const encoded = await readFile(join(import.meta.dir, 'fixtures', 'image', name), 'utf8')
  return `data:image/png;base64,${encoded.trim()}`
}

async function imageBytes(): Promise<Buffer> {
  const encoded = await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.base64'), 'utf8')
  return Buffer.from(encoded.trim(), 'base64')
}

async function imageHash(): Promise<`sha256:${string}`> {
  return (await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.sha256'), 'utf8')).trim() as `sha256:${string}`
}

async function fixtureJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(import.meta.dir, 'fixtures', 'image', path), 'utf8'))
}

async function brokenDataUrl(): Promise<string> {
  const bytes = await readFile(join(import.meta.dir, 'fixtures', 'image', 'invalid-image.bin'))
  return `data:image/png;base64,${bytes.toString('base64')}`
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

type GatewayCall = { origin: string; path: string; method: string; headers: Headers; body: unknown }

function gatewayFixture(
  png: string,
  options: { onAck?: () => Promise<void> | void; ackResponse?: () => Promise<Response> | Response } = {},
): { calls: GatewayCall[]; fetchImpl: typeof fetch } {
  const calls: GatewayCall[] = []
  const receipt = 'a'.repeat(64)
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const headers = new Headers(init?.headers)
    calls.push({ origin: url.origin, path: url.pathname, method, headers, body })
    if (url.pathname === '/image-generation/v1/images/tasks' && method === 'POST') {
      return Response.json({
        task_id: 'relay_task_0001',
        status: 'queued',
        poll_after_seconds: 1,
        provider_receipt_hash: receipt,
      })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_0001' && method === 'GET') {
      return Response.json({
        task_id: 'relay_task_0001',
        status: 'succeeded',
        provider_receipt_hash: receipt,
        result_urls: [0].map(index => `${imageRelayUrl}/v1/images/results/result.${receipt}/${index}`),
      })
    }
    if (url.pathname.startsWith('/image-generation/v1/images/results/')) {
      return Response.json({ data: [{ b64_json: png, mime_type: 'image/png' }] })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_0001/ack' && method === 'POST') {
      await options.onAck?.()
      return await options.ackResponse?.() ?? Response.json({ result_acknowledged: true })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_0001/cancel' && method === 'POST') {
      return Response.json({ status: 'cancelled' })
    }
    // Current visual quality reasoning is deliberately non-blocking.  The
    // production fixture records its failure without changing candidate facts.
    if (url.pathname.endsWith('/v1/image/reasoning')) return Response.json({ error: 'unavailable' }, { status: 503 })
    return Response.json({ error: 'unexpected image gateway fixture request' }, { status: 500 })
  }
  return { calls, fetchImpl }
}

async function createService(label: string, fetchImpl: typeof fetch = fetch): Promise<ImageWorkbenchService> {
  return new ImageWorkbenchService({
    root: await testRoot(label),
    legacyMediaRoot: await testRoot(`${label}-legacy`),
    now: () => new Date(at),
    fetchImpl,
  })
}

function traceApplications(applications: ImageWorkbenchApplications): {
  applications: ImageWorkbenchApplications
  calls: string[]
} {
  const calls: string[] = []
  const trace = <Application extends object>(name: string, application: Application): Application => new Proxy(application, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push(`${name}.${String(property)}`)
        return Reflect.apply(value, target, args)
      }
    },
  })
  return {
    calls,
    applications: {
      project: trace('project', applications.project),
      generation: trace('generation', applications.generation),
      canvas: trace('canvas', applications.canvas),
      delivery: trace('delivery', applications.delivery),
      recovery: trace('recovery', applications.recovery),
    },
  }
}

async function createProject(service: ImageWorkbenchService) {
  return await service.createProject({
    title: '图片基线项目',
    user_request: '一张用于当前行为基线的产品宣传图',
    size: '1024x1024',
    reference_images: [],
    reference_roles: [],
  })
}

/** Build a formal Version through the existing Candidate adoption path. */
async function createFormalVersion(service: ImageWorkbenchService): Promise<{
  project: Awaited<ReturnType<ImageWorkbenchService['getProject']>>
  version_id: string
  asset_hash: `sha256:${string}`
}> {
  const project = await createProject(service)
  const submitted = await service.submitProject(project.id)
  const completed = await service.getOperation(submitted.id)
  const generation = await service.findGenerationOperation(completed.operation_id!)
  if (!generation?.result || generation.result.kind !== 'candidate_group') throw new Error('expected formal source Candidate Group')
  const group = await service.getCandidateGroup(project.id, generation.result.candidate_group_id)
  const current = await service.getProject(project.id)
  const delivery = await service.repository.currentDeliverySpec(project.id)
  if (!delivery) throw new Error('expected delivery specification')
  const adopted = await service.adoptCandidate(project.id, group.candidates[0]!.id, {
    base_revision: current.revision,
    idempotency_key: 'bb-image-version-derivation-source-adopt-0001',
    adoptions: [{ artboard_id: delivery.artboards[0]!.id, placement: { fit: 'cover', focus_x: 0.5, focus_y: 0.5 } }],
  })
  const versionId = adopted.adoptions[0]!.version_id
  const asset = adopted.project.assets.find(item => item.id === group.candidates[0]!.asset_id)
  if (!asset?.content_hash) throw new Error('expected formal Version result asset')
  return { project: adopted.project, version_id: versionId, asset_hash: asset.content_hash as `sha256:${string}` }
}

function operation(projectId: string): ImageOperation {
  return {
    schema_version: 1,
    id: 'task_00000001',
    operation_id: 'op_00000001',
    project_id: projectId,
    owner: { kind: 'standalone', owner_id: 'local_workbench' },
    kind: 'image.generate',
    status: 'queued',
    status_sequence: 0,
    progress: 1,
    stage: '提交中断基线',
    idempotency_key: 'bb-image-baseline-idempotency-key',
    remote_submission_started_at: at,
    image_operation: { kind: 'generate', model: 'gpt-image-2', output_count: 3 },
    created_at: at,
    updated_at: at,
  }
}

async function request(
  handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(path, 'http://127.0.0.1:3456')
  return await handler(imageTicketRequest(url, init), url, url.pathname.split('/').filter(Boolean))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

test('fixed legacy Project, Operation/Event and hash fixtures import idempotently while keeping writer fencing and CAS bytes reproducible', async () => {
  const legacyProject = imageWorkbenchProjectSchema.parse(await fixtureJson('legacy/project.json'))
  const legacyOperation = mediaTaskSchema.parse(await fixtureJson('legacy/operation.json')) as ImageOperation
  const originalJournal = mediaJobEventJournalSchema.parse(await fixtureJson('legacy/event-journal.json'))
  const secondLegacyOperation = mediaTaskSchema.parse({
    ...legacyOperation,
    id: 'task_legacy_second',
    operation_id: 'op_legacy_second',
    idempotency_key: 'bb-image-legacy-second-key',
    status: 'failed',
    status_sequence: 7,
    stage: '固定历史第二个操作',
  }) as ImageOperation
  const legacyJournal = mediaJobEventJournalSchema.parse({
    ...originalJournal,
    next_cursor: 9,
    events: [
      ...originalJournal.events,
      {
        ...originalJournal.events[0],
        cursor: 7,
        task_id: secondLegacyOperation.id,
        operation_id: secondLegacyOperation.operation_id!,
        status_sequence: secondLegacyOperation.status_sequence,
        task: secondLegacyOperation,
      },
    ],
  })
  const expectedBytes = await imageBytes()
  const expectedHash = await imageHash()
  expect(createHash('sha256').update(expectedBytes).digest('hex')).toBe(expectedHash.slice('sha256:'.length))
  expect(legacyJournal.events).toHaveLength(2)
  expect(legacyJournal.events[0]?.task).toMatchObject({ id: legacyOperation.id, operation_id: legacyOperation.operation_id })

  const targetRoot = await testRoot('legacy-target')
  const legacyRoot = await testRoot('legacy-store')
  await Promise.all([
    mkdir(join(legacyRoot, 'projects'), { recursive: true }),
    mkdir(join(legacyRoot, 'tasks'), { recursive: true }),
    mkdir(join(legacyRoot, 'events'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(legacyRoot, 'projects', `${legacyProject.id}.json`), `${JSON.stringify(legacyProject)}\n`),
    writeFile(join(legacyRoot, 'tasks', `${legacyOperation.id}.json`), `${JSON.stringify(legacyOperation)}\n`),
    writeFile(join(legacyRoot, 'tasks', `${secondLegacyOperation.id}.json`), `${JSON.stringify(secondLegacyOperation)}\n`),
    writeFile(join(legacyRoot, 'events', `${legacyProject.id}.json`), `${JSON.stringify(legacyJournal)}\n`),
  ])
  const target = new ImageWorkbenchService({ root: targetRoot, legacyMediaRoot: legacyRoot, now: () => new Date(at) })

  const firstImport = await target.migrateLegacyMediaStore()
  expect(firstImport.migrated_project_ids).toEqual([legacyProject.id])
  expect((await stat(join(targetRoot, 'metadata', 'metadata.sqlite'))).isFile()).toBeTrue()
  await expect(readFile(join(targetRoot, 'projects', `${legacyProject.id}.json`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await target.listProjects()).toHaveLength(1)
  expect(await target.assertProjectOwner(legacyProject.id)).toMatchObject({ owner: { kind: 'standalone', owner_id: 'local_workbench' } })
  expect(await target.getOperation(legacyOperation.id)).toMatchObject({ status: 'succeeded', operation_id: legacyOperation.operation_id })
  expect(await target.getOperation(secondLegacyOperation.id)).toMatchObject({ status: 'failed', operation_id: secondLegacyOperation.operation_id })
  expect((await target.repository.listOperations(legacyProject.id)).map(operation => operation.id).sort()).toEqual([
    legacyOperation.id,
    secondLegacyOperation.id,
  ].sort())
  expect((await target.listOperationEvents(legacyProject.id, 0, 100)).events.map(event => event.cursor)).toEqual([1, 7])
  expect((await target.migrateLegacyMediaStore()).skipped_project_ids).toEqual([legacyProject.id])
  expect((await target.repository.migrationReceipt('image-legacy-json-v1'))?.source_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(await target.repository.projectMigrationReceipt('generic-media-json-v1', legacyProject.id)).toMatchObject({
    operation_count: 2,
    journal_next_cursor: 9,
    version_count: legacyProject.versions.length,
    current_version_id: legacyProject.current_version_id ?? null,
    status: 'complete',
  })

  const imported = await target.getProject(legacyProject.id)
  expect(imported).toMatchObject({
    id: legacyProject.id,
    title: legacyProject.title,
    revision: legacyProject.revision,
  })
  expect(imported.versions).toEqual(legacyProject.versions)
  expect(imported.current_version_id).toBe(legacyProject.current_version_id)
  const importedAsset = imported.assets.find(asset => asset.id === 'out_legacy_fixture')
  expect(importedAsset?.content_hash).toBe(expectedHash)
  expect((await target.assets.readVerified(importedAsset!)).bytes.equals(expectedBytes)).toBeTrue()

  const firstWrite = await target.repository.saveProject(imported)
  const secondWrite = await target.repository.saveProject({ ...firstWrite, title: '更新后的基线项目' })
  await expect(target.repository.saveProject({ ...firstWrite, title: '过期写入' })).rejects.toMatchObject({
    code: 'IMAGE_WRITER_FENCE_CONFLICT',
  })
  expect(secondWrite.writer_fence).not.toBe(firstWrite.writer_fence)
  const afterJournal = await target.repository.saveOperation({
    ...operation(legacyProject.id),
    id: 'task_legacy_after',
    operation_id: 'op_legacy_after',
    idempotency_key: 'bb-image-legacy-after-journal-key',
  })
  expect(afterJournal.id).toBe('task_legacy_after')
  expect((await target.listOperationEvents(legacyProject.id, 0, 100)).events.map(event => event.cursor)).toEqual([1, 7, 9])
})

test('15.1 SQLite metadata enforces one project writer, foreign project ownership and idempotency request hash', async () => {
  const root = await testRoot('sqlite-constraints')
  const service = new ImageWorkbenchService({ root, now: () => new Date(at) })
  const project = await createProject(service)
  const first = await service.repository.saveOperation(operation(project.id))
  const replay = await service.repository.saveProjectAndOperation({
    ...project,
    title: '不能在幂等冲突后写入',
    revision: project.revision + 1,
  }, {
    ...first,
    id: 'task_00000002',
    operation_id: 'op_00000002',
    status_sequence: 0,
  })
  expect(replay.operation.id).toBe(first.id)
  expect((await service.getProject(project.id)).title).toBe(project.title)
  const inspected = new Database(join(root, 'metadata', 'metadata.sqlite'), { readonly: true })
  try {
    const stored = inspected.query('SELECT request_hash FROM image_operations WHERE id=?').get(first.id) as { request_hash: string }
    expect(stored.request_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
  } finally {
    inspected.close()
  }
  await expect(service.repository.saveProjectAndOperation({
    ...project,
    title: '不同请求不能复用幂等键',
    revision: project.revision + 1,
  }, {
    ...first,
    id: 'task_00000003',
    operation_id: 'op_00000003',
    image_operation: { ...first.image_operation, output_count: 2 },
    status_sequence: 0,
  })).rejects.toMatchObject({ status: 409, code: 'IMAGE_STORAGE_INVALID' })
  expect((await service.getProject(project.id)).title).toBe(project.title)
  await expect(service.repository.saveOperation({
    ...operation('img_missing_0001'),
    id: 'task_00000004',
    operation_id: 'op_00000004',
    idempotency_key: 'bb-image-missing-project-idempotency-key',
  })).rejects.toMatchObject({ status: 404, code: 'IMAGE_PROJECT_NOT_FOUND' })
  expect((await service.repository.listOperationEvents(project.id, 0, 10)).events).toMatchObject([
    { operation_id: first.operation_id, status_sequence: 1 },
  ])
})

test('15.1 imports the pre-existing image JSON root before safe CAS orphan collection can remove it', async () => {
  const root = await testRoot('current-image-json-import')
  const oldMediaRoot = await testRoot('empty-old-media')
  let nowMs = Date.parse(at)
  const legacyProject = imageWorkbenchProjectSchema.parse(await fixtureJson('legacy/project.json'))
  const legacyOperation = mediaTaskSchema.parse(await fixtureJson('legacy/operation.json')) as ImageOperation
  const legacyJournal = mediaJobEventJournalSchema.parse(await fixtureJson('legacy/event-journal.json'))
  const bytes = await imageBytes()
  const hash = await imageHash()
  const orphanBytes = Buffer.from('orphan created before legacy migration')
  const orphanHash = createHash('sha256').update(orphanBytes).digest('hex')
  await Promise.all([
    mkdir(join(root, 'projects'), { recursive: true }),
    mkdir(join(root, 'operations'), { recursive: true }),
    mkdir(join(root, 'events'), { recursive: true }),
    mkdir(join(root, 'cas', 'sha256'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'projects', `${legacyProject.id}.json`), JSON.stringify(legacyProject)),
    writeFile(join(root, 'operations', `${legacyOperation.id}.json`), JSON.stringify(legacyOperation)),
    writeFile(join(root, 'events', `${legacyProject.id}.json`), JSON.stringify(legacyJournal)),
    writeFile(join(root, 'cas', 'sha256', hash.slice('sha256:'.length)), bytes),
    writeFile(join(root, 'cas', 'sha256', orphanHash), orphanBytes),
  ])
  const service = new ImageWorkbenchService({
    root,
    legacyMediaRoot: oldMediaRoot,
    now: () => new Date(nowMs),
    casOrphanRetentionMs: 1_000,
  })
  await expect(readFile(join(root, 'cas', 'sha256', orphanHash))).resolves.toEqual(orphanBytes)
  expect((await service.migrateLegacyMediaStore()).migrated_project_ids).toEqual([legacyProject.id])
  await expect(readFile(join(root, 'cas', 'sha256', orphanHash))).resolves.toEqual(orphanBytes)
  nowMs += 1_001
  await service.repository.reconcileCasAfterLegacyMigration()
  await expect(readFile(join(root, 'cas', 'sha256', orphanHash))).rejects.toMatchObject({ code: 'ENOENT' })
  const imported = await service.getProject(legacyProject.id)
  const asset = imported.assets.find(candidate => candidate.id === 'out_legacy_fixture')
  expect((await service.assets.readVerified(asset!)).bytes.equals(bytes)).toBeTrue()
  expect((await service.listOperationEvents(legacyProject.id)).events).toMatchObject([{ cursor: 1, operation_id: legacyOperation.operation_id }])
  const changedOrphanBytes = Buffer.from('orphan must survive a changed migration source')
  const changedOrphanHash = createHash('sha256').update(changedOrphanBytes).digest('hex')
  await writeFile(join(root, 'cas', 'sha256', changedOrphanHash), changedOrphanBytes)
  await writeFile(join(root, 'events', `${legacyProject.id}.json`), JSON.stringify({ ...legacyJournal, next_cursor: 8 }))
  service.repository.close()

  const sourceChanged = new ImageWorkbenchService({ root, legacyMediaRoot: oldMediaRoot, now: () => new Date(nowMs) })
  await sourceChanged.listProjects()
  await expect(readFile(join(root, 'cas', 'sha256', changedOrphanHash))).resolves.toEqual(changedOrphanBytes)
  expect(await sourceChanged.repository.projectMigrationReceipt('image-workbench-json-v1', legacyProject.id)).toBeNull()
  expect(await sourceChanged.repository.projectMigrationInvalidation('image-workbench-json-v1', legacyProject.id)).toMatchObject({
    source_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    previous_source_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  })
  await expect(sourceChanged.migrateLegacyMediaStore()).rejects.toMatchObject({ code: 'IMAGE_LEGACY_SOURCE_CHANGED' })
  expect(await sourceChanged.repository.projectMigrationReceipt('image-workbench-json-v1', legacyProject.id)).toBeNull()
  sourceChanged.repository.close()
})

test('15.1 generic-media 迁移源变化会在冷启动 CAS 对账前失效收据并阻断回收', async () => {
  const root = await testRoot('generic-media-source-change')
  const legacyRoot = await testRoot('generic-media-source-change-legacy')
  let nowMs = Date.parse(at)
  const legacyProject = imageWorkbenchProjectSchema.parse(await fixtureJson('legacy/project.json'))
  const legacyOperation = mediaTaskSchema.parse(await fixtureJson('legacy/operation.json')) as ImageOperation
  const legacyJournal = mediaJobEventJournalSchema.parse(await fixtureJson('legacy/event-journal.json'))
  const orphanBytes = Buffer.from('generic source change must block CAS orphan GC')
  const orphanHash = createHash('sha256').update(orphanBytes).digest('hex')
  await Promise.all([
    mkdir(join(root, 'cas', 'sha256'), { recursive: true }),
    mkdir(join(legacyRoot, 'projects'), { recursive: true }),
    mkdir(join(legacyRoot, 'tasks'), { recursive: true }),
    mkdir(join(legacyRoot, 'events'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(root, 'cas', 'sha256', orphanHash), orphanBytes),
    writeFile(join(legacyRoot, 'projects', `${legacyProject.id}.json`), JSON.stringify(legacyProject)),
    writeFile(join(legacyRoot, 'tasks', `${legacyOperation.id}.json`), JSON.stringify(legacyOperation)),
    writeFile(join(legacyRoot, 'events', `${legacyProject.id}.json`), JSON.stringify(legacyJournal)),
  ])
  const imported = new ImageWorkbenchService({
    root,
    legacyMediaRoot: legacyRoot,
    now: () => new Date(nowMs),
    casOrphanRetentionMs: 1_000,
  })
  await expect(readFile(join(root, 'cas', 'sha256', orphanHash))).resolves.toEqual(orphanBytes)
  expect((await imported.migrateLegacyMediaStore()).migrated_project_ids).toEqual([legacyProject.id])
  imported.repository.close()

  nowMs += 1_001
  await writeFile(join(legacyRoot, 'events', `${legacyProject.id}.json`), JSON.stringify({
    ...legacyJournal,
    next_cursor: legacyJournal.next_cursor + 1,
  }))
  const restarted = new ImageWorkbenchService({
    root,
    legacyMediaRoot: legacyRoot,
    now: () => new Date(nowMs),
    casOrphanRetentionMs: 1_000,
  })
  await restarted.listProjects()
  await expect(readFile(join(root, 'cas', 'sha256', orphanHash))).resolves.toEqual(orphanBytes)
  expect(await restarted.repository.projectMigrationReceipt('generic-media-json-v1', legacyProject.id)).toBeNull()
  expect(await restarted.repository.projectMigrationInvalidation('generic-media-json-v1', legacyProject.id)).toMatchObject({
    source_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    previous_source_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  })
  await expect(restarted.migrateLegacyMediaStore()).rejects.toMatchObject({ code: 'IMAGE_LEGACY_SOURCE_CHANGED' })
  restarted.repository.close()
})

test('15.1 CAS orphan GC requires retention plus a second scan before physical deletion', async () => {
  const root = await testRoot('cas-orphan-retention')
  let nowMs = Date.parse(at)
  const service = new ImageWorkbenchService({
    root,
    now: () => new Date(nowMs),
    casOrphanRetentionMs: 60_000,
  })
  await service.listProjects()
  const orphanBytes = Buffer.from('retained orphan')
  const orphanHash = createHash('sha256').update(orphanBytes).digest('hex')
  const orphanPath = join(root, 'cas', 'sha256', orphanHash)
  await writeFile(orphanPath, orphanBytes)

  expect(await service.repository.reconcileCasAfterLegacyMigration()).toBeTrue()
  const inspect = new Database(join(root, 'metadata', 'metadata.sqlite'), { readonly: true })
  try {
    expect(inspect.query('SELECT scan_count FROM image_cas_orphan_observations WHERE content_hash=?')
      .get(`sha256:${orphanHash}`)).toEqual({ scan_count: 1 })
  } finally {
    inspect.close()
  }
  nowMs += 30_000
  expect(await service.repository.reconcileCasAfterLegacyMigration()).toBeTrue()
  await expect(readFile(orphanPath)).resolves.toEqual(orphanBytes)
  const secondInspect = new Database(join(root, 'metadata', 'metadata.sqlite'), { readonly: true })
  try {
    expect(secondInspect.query('SELECT scan_count FROM image_cas_orphan_observations WHERE content_hash=?')
      .get(`sha256:${orphanHash}`)).toEqual({ scan_count: 2 })
  } finally {
    secondInspect.close()
  }
  nowMs += 30_001
  expect(await service.repository.reconcileCasAfterLegacyMigration()).toBeTrue()
  await expect(readFile(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
  service.repository.close()
})

test('15.1 CAS orphan GC protects bytes while an image submission is in flight', async () => {
  const root = await testRoot('cas-orphan-inflight')
  let nowMs = Date.parse(at)
  const service = new ImageWorkbenchService({
    root,
    now: () => new Date(nowMs),
    casOrphanRetentionMs: 1_000,
  })
  await service.listProjects()
  const orphanBytes = Buffer.from('in-flight protected orphan')
  const orphanHash = createHash('sha256').update(orphanBytes).digest('hex')
  const orphanPath = join(root, 'cas', 'sha256', orphanHash)
  await writeFile(orphanPath, orphanBytes)
  expect(await service.repository.reconcileCasAfterLegacyMigration()).toBeTrue()

  const project = await createProject(service)
  const inFlight = await service.repository.saveOperation({
    ...operation(project.id),
    status: 'committing',
    remote_task_id: 'relay_task_inflight',
  })
  nowMs += 2_000
  expect(await service.repository.reconcileCasAfterLegacyMigration()).toBeTrue()
  await expect(readFile(orphanPath)).resolves.toEqual(orphanBytes)

  await service.repository.saveOperation({
    ...inFlight,
    status: 'failed',
    stage: '已结束，可执行对账',
  })
  expect(await service.repository.reconcileCasAfterLegacyMigration()).toBeTrue()
  await expect(readFile(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' })
  service.repository.close()
})

test('15.1 resumes each legacy project after a partial import without dropping Operations, journal next_cursor, Version or current pointer', async () => {
  const root = await testRoot('migration-resume-target')
  const legacyRoot = await testRoot('migration-resume-source')
  const legacyProject = imageWorkbenchProjectSchema.parse(await fixtureJson('legacy/project.json'))
  const legacyOperation = mediaTaskSchema.parse(await fixtureJson('legacy/operation.json')) as ImageOperation
  const secondOperation = mediaTaskSchema.parse({
    ...legacyOperation,
    id: 'task_legacy_resume',
    operation_id: 'op_legacy_resume',
    idempotency_key: 'bb-image-legacy-resume-key',
    status: 'queued',
    status_sequence: 4,
    stage: '等待迁移恢复',
    result: undefined,
  }) as ImageOperation
  const originalJournal = mediaJobEventJournalSchema.parse(await fixtureJson('legacy/event-journal.json'))
  const journal = mediaJobEventJournalSchema.parse({
    ...originalJournal,
    next_cursor: 6,
    events: [
      ...originalJournal.events,
      {
        ...originalJournal.events[0],
        cursor: 4,
        task_id: secondOperation.id,
        operation_id: secondOperation.operation_id!,
        status_sequence: secondOperation.status_sequence,
        task: secondOperation,
      },
    ],
  })
  await Promise.all([
    mkdir(join(legacyRoot, 'projects'), { recursive: true }),
    mkdir(join(legacyRoot, 'tasks'), { recursive: true }),
    mkdir(join(legacyRoot, 'events'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(legacyRoot, 'projects', `${legacyProject.id}.json`), JSON.stringify(legacyProject)),
    writeFile(join(legacyRoot, 'tasks', `${legacyOperation.id}.json`), JSON.stringify(legacyOperation)),
    writeFile(join(legacyRoot, 'tasks', `${secondOperation.id}.json`), JSON.stringify(secondOperation)),
    writeFile(join(legacyRoot, 'events', `${legacyProject.id}.json`), JSON.stringify(journal)),
  ])
  let crashOnce = true
  const interrupted = new ImageWorkbenchService({
    root,
    legacyMediaRoot: legacyRoot,
    now: () => new Date(at),
    crashInjector: point => {
      if (point === 'after_project_migration_before_operations' && crashOnce) {
        crashOnce = false
        throw new Error('INJECTED_PROJECT_MIGRATION_CRASH')
      }
    },
  })
  await expect(interrupted.migrateLegacyMediaStore()).rejects.toThrow('INJECTED_PROJECT_MIGRATION_CRASH')
  const partiallyImported = await interrupted.getProject(legacyProject.id)
  expect(partiallyImported).toMatchObject({
    revision: legacyProject.revision,
  })
  expect(partiallyImported.versions).toEqual(legacyProject.versions)
  expect(partiallyImported.current_version_id).toBe(legacyProject.current_version_id)
  expect(await interrupted.repository.listOperations(legacyProject.id)).toHaveLength(0)
  expect(await interrupted.repository.projectMigrationReceipt('generic-media-json-v1', legacyProject.id)).toBeNull()
  interrupted.repository.close()

  const resumed = new ImageWorkbenchService({ root, legacyMediaRoot: legacyRoot, now: () => new Date(at) })
  expect((await resumed.migrateLegacyMediaStore()).migrated_project_ids).toEqual([legacyProject.id])
  expect((await resumed.repository.listOperations(legacyProject.id)).map(operation => operation.id).sort()).toEqual([
    legacyOperation.id,
    secondOperation.id,
  ].sort())
  expect((await resumed.listOperationEvents(legacyProject.id)).events.map(event => event.cursor)).toEqual([1, 4])
  expect(await resumed.repository.projectMigrationReceipt('generic-media-json-v1', legacyProject.id)).toMatchObject({
    operation_count: 2,
    journal_next_cursor: 6,
    version_count: legacyProject.versions.length,
    current_version_id: legacyProject.current_version_id ?? null,
  })
  const afterJournal = await resumed.repository.saveOperation({
    ...operation(legacyProject.id),
    id: 'task_resume_after',
    operation_id: 'op_resume_after',
    idempotency_key: 'bb-image-resume-after-key',
  })
  expect(afterJournal.id).toBe('task_resume_after')
  expect((await resumed.listOperationEvents(legacyProject.id)).events.map(event => event.cursor)).toEqual([1, 4, 6])
  resumed.repository.close()
})

test('15.1 injects a crash after CAS publication, then restarts by refetching the same remote task without resubmitting', async () => {
  const root = await testRoot('cas-db-crash')
  const legacyRoot = await testRoot('cas-db-crash-legacy')
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  let crashOnce = true
  const first = new ImageWorkbenchService({
    root,
    legacyMediaRoot: legacyRoot,
    now: () => new Date(at),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_cas_publish_before_db_commit' && crashOnce) {
        crashOnce = false
        throw new Error('INJECTED_CAS_TO_DB_CRASH')
      }
    },
  })
  await withGateway(async () => {
    const project = await createProject(first)
    const submitted = await first.submitProject(project.id)
    await expect(first.getOperation(submitted.id)).rejects.toThrow('INJECTED_CAS_TO_DB_CRASH')
    expect(await first.repository.getOperation(submitted.id)).toMatchObject({ status: 'committing' })
    expect((await first.getProject(project.id)).outputs).toHaveLength(0)
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot: legacyRoot, now: () => new Date(at), fetchImpl: gateway.fetchImpl })
    await recovered.applications.recovery.recoverInterruptedOperations()
    expect(await recovered.getOperation(submitted.id)).toMatchObject({
      status: 'succeeded',
      remote_result_acknowledged_at: at,
    })
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks/relay_task_0001' && call.method === 'GET')).toHaveLength(2)
    expect(gateway.calls.filter(call => call.path.endsWith('/ack'))).toHaveLength(1)
    recovered.repository.close()
  })
})

test('15.2 injects a crash after Candidate Group transaction and retries only Relay ACK on restart', async () => {
  const root = await testRoot('db-ack-crash')
  const legacyRoot = await testRoot('db-ack-crash-legacy')
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  let crashOnce = true
  const first = new ImageWorkbenchService({
    root,
    legacyMediaRoot: legacyRoot,
    now: () => new Date(at),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_db_commit_before_relay_ack' && crashOnce) {
        crashOnce = false
        throw new Error('INJECTED_DB_TO_ACK_CRASH')
      }
    },
  })
  await withGateway(async () => {
    const project = await createProject(first)
    const submitted = await first.submitProject(project.id)
    await expect(first.getOperation(submitted.id)).rejects.toThrow('INJECTED_DB_TO_ACK_CRASH')
    const committedBeforeAck = await first.repository.getOperation(submitted.id)
    expect(committedBeforeAck.status).toBe('succeeded')
    expect(committedBeforeAck.remote_result_acknowledged_at).toBeUndefined()
    const formal = await first.repository.findGenerationOperation(committedBeforeAck.operation_id!)
    expect(formal?.result).toMatchObject({ kind: 'candidate_group', valid_count: 1 })
    expect(gateway.calls.filter(call => call.path.endsWith('/ack'))).toHaveLength(0)
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot: legacyRoot, now: () => new Date(at), fetchImpl: gateway.fetchImpl })
    await recovered.applications.recovery.recoverInterruptedOperations()
    expect(await recovered.getOperation(submitted.id)).toMatchObject({ status: 'succeeded', remote_result_acknowledged_at: at })
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks/relay_task_0001' && call.method === 'GET')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path.endsWith('/ack'))).toHaveLength(1)
    recovered.repository.close()
  })
})

test('15.2 Image Relay contract commits a Candidate Group before ACK and never auto-adopts it', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const expectedBytes = await imageBytes()
  const expectedHash = await imageHash()
  let projectId = ''
  let service: ImageWorkbenchService
  const gateway = gatewayFixture(png, {
    onAck: async () => {
      const persisted = await service.getProject(projectId)
      expect(persisted.outputs).toHaveLength(0)
      expect(persisted.versions).toHaveLength(0)
      const resultAsset = persisted.assets.find(asset => asset.role === 'result')
      expect(resultAsset?.content_hash).toBe(expectedHash)
      const verified = await service.assets.readVerified(resultAsset!)
      expect(verified.bytes.equals(expectedBytes)).toBeTrue()
      expect(verified.content_hash).toBe(expectedHash)
      const casBytes = await readFile(join(
        service.repository.paths().root,
        'cas',
        'sha256',
        expectedHash.slice('sha256:'.length),
      ))
      expect(casBytes.equals(expectedBytes)).toBeTrue()
    },
  })
  service = await createService('gateway-relay', gateway.fetchImpl)
  await withGateway(async () => {
    expect(productGatewayTarget()?.baseUrl).toBe(gatewayUrl)
    expect(productImageRelayTarget()?.baseUrl).toBe(imageRelayUrl)
    const created = await createProject(service)
    projectId = created.id
    const submitted = await service.submitProject(created.id)
    expect(submitted.remote_task_id).toBe('relay_task_0001')
    const completed = await service.getOperation(submitted.id)
    expect(completed.status).toBe('succeeded')
    expect(completed.remote_result_acknowledged_at).toBe(at)

    const project = await service.getProject(created.id)
    expect(project.outputs).toHaveLength(0)
    expect(project.versions).toHaveLength(0)
    expect(project.current_version_id).toBeUndefined()
    expect(project.current_versions_by_artboard).toEqual({})
    const formal = await service.findGenerationOperation(completed.operation_id!)
    expect(formal?.result).toMatchObject({ kind: 'candidate_group', expected_count: 1, valid_count: 1, invalid: [] })
    const executionReceipt = await service.repository.getExecutionReceipt(project.id, formal!.execution_receipt_id!)
    expect(executionReceipt).toMatchObject({
      capability: 'image_generation',
      registry_capability: 'ImageGeneration',
      idempotency_key: formal!.idempotency_key,
      request_hash: formal!.request_hash,
      input_asset_hashes: [],
      completed_at: at,
      output_asset_hashes: [expectedHash],
    })
    const group = await service.getCandidateGroup(project.id, formal!.result!.kind === 'candidate_group' ? formal.result.candidate_group_id : '')
    expect(group.candidates).toHaveLength(1)
    const page = await service.listOperationEvents(project.id, 0, 100)
    expect(page.events.map(event => event.cursor)).toEqual(page.events.map((_event, index) => index + 1))
    expect(page.events.at(-1)?.operation.status).toBe('succeeded')

    const post = gateway.calls.find(call => call.path === '/image-generation/v1/images/tasks')
    const poll = gateway.calls.find(call => call.path === '/image-generation/v1/images/tasks/relay_task_0001' && call.method === 'GET')
    const ack = gateway.calls.find(call => call.path.endsWith('/ack'))
    expect(post?.origin).toBe(new URL(imageRelayUrl).origin)
    expect(post?.headers.get('idempotency-key')).toMatch(/^bb-image-/)
    expect(post?.body).toMatchObject({ mode: 'generate', n: 1, size: '1024x1024' })
    expect(poll?.headers.get('x-bb-media-result-handoff')).toBe('direct-v1')
    const resultDownloads = gateway.calls.filter(call => call.path.startsWith('/image-generation/v1/images/results/'))
    expect(resultDownloads).toHaveLength(1)
    expect(resultDownloads.every(call => call.headers.get('authorization') === `Bearer ${gatewayToken}`)).toBeTrue()
    expect(ack?.method).toBe('POST')

    const compatibilityReplay = await service.submitProject(created.id)
    expect(compatibilityReplay.id).toBe(submitted.id)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)

    const delivery = await service.repository.currentDeliverySpec(project.id)
    const decisionCapability = 'fedcba9876543210fedcba9876543210'
    const decisionHandler = createImageWorkbenchDomainApiHandler(service.applications, decisionCapability)
    const decisionInput = {
      base_revision: project.revision,
      idempotency_key: 'bb-image-decision-project-upgrade-replay-0001',
      decision: 'kept' as const,
    }
    const concurrentDecisions = await Promise.all(Array.from({ length: 8 }, async () => await service.decideCandidate(
      project.id,
      group.candidates[0]!.id,
      decisionInput,
    )))
    expect(new Set(concurrentDecisions.map(decision => decision.id)).size).toBe(1)
    const decisionDatabase = new Database(join(service.repository.paths().root, 'metadata', 'metadata.sqlite'))
    try {
      const row = decisionDatabase.query(`SELECT COUNT(*) AS count FROM image_candidate_decisions
        WHERE project_id=? AND idempotency_key=?`).get(project.id, decisionInput.idempotency_key) as { count: number }
      expect(row.count).toBe(1)
    } finally {
      decisionDatabase.close()
    }
    const firstDecision = await request(decisionHandler, `/api/images/projects/${project.id}/candidates/${group.candidates[0]!.id}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': decisionCapability },
      body: JSON.stringify(decisionInput),
    })
    expect(firstDecision.status).toBe(200)
    const firstDecisionPayload = await firstDecision.json() as { decision: { id: string } }
    const adopted = await service.adoptCandidate(project.id, group.candidates[0]!.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-adopt-gateway-contract-0001',
      adoptions: [{ artboard_id: delivery!.artboards[0]!.id, placement: { fit: 'cover', focus_x: 0.5, focus_y: 0.5 } }],
    })
    expect(adopted.project.current_versions_by_artboard).toEqual({ [delivery!.artboards[0]!.id]: adopted.adoptions[0]!.version_id })
    const replayDecision = await request(decisionHandler, `/api/images/projects/${project.id}/candidates/${group.candidates[0]!.id}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': decisionCapability },
      body: JSON.stringify(decisionInput),
    })
    expect(replayDecision.status).toBe(200)
    expect(await replayDecision.json()).toMatchObject({ decision: { id: firstDecisionPayload.decision.id, decision: 'kept' } })
    await expect(service.decideCandidate(project.id, group.candidates[0]!.id, {
      ...decisionInput,
      decision: 'rejected',
    })).rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    const idempotencyConflict = await request(decisionHandler, `/api/images/projects/${project.id}/candidates/${group.candidates[0]!.id}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': decisionCapability },
      body: JSON.stringify({ ...decisionInput, decision: 'rejected' }),
    })
    expect(idempotencyConflict.status).toBe(409)
    expect(await idempotencyConflict.json()).toEqual({
      error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT',
      message: mediaSafeError('MEDIA_IMAGE_IDEMPOTENCY_CONFLICT').message,
    })
    await expect(service.decideCandidate(project.id, group.candidates[0]!.id, {
      ...decisionInput,
      idempotency_key: 'bb-image-decision-stale-revision-0001',
    })).rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    const revisionConflict = await request(decisionHandler, `/api/images/projects/${project.id}/candidates/${group.candidates[0]!.id}/decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': decisionCapability },
      body: JSON.stringify({
        ...decisionInput,
        idempotency_key: 'bb-image-decision-stale-revision-api-0001',
      }),
    })
    expect(revisionConflict.status).toBe(409)
    expect(await revisionConflict.json()).toEqual({
      error: 'MEDIA_IMAGE_REVISION_CONFLICT',
      message: mediaSafeError('MEDIA_IMAGE_REVISION_CONFLICT').message,
    })
    await expect(service.adoptCandidate(project.id, group.candidates[0]!.id, {
      base_revision: adopted.project.revision,
      idempotency_key: 'bb-image-adopt-gateway-contract-conflict-0001',
      adoptions: [{ artboard_id: delivery!.artboards[0]!.id, placement: { fit: 'cover', focus_x: 0.5, focus_y: 0.5 } }],
    })).rejects.toMatchObject({ status: 409 })
    const receipt = await service.deleteProject(project.id)
    expect(receipt.status).toBe('deleted')
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: 'IMAGE_PROJECT_NOT_FOUND' })
    expect((await service.restoreProject(project.id)).status).toBe('restored')
    expect((await service.getProject(project.id)).current_versions_by_artboard).toEqual({ [delivery!.artboards[0]!.id]: adopted.adoptions[0]!.version_id })
  })
})

test('15.2 sends only Provider-eligible multi-references and keeps exact Logo/QR source bytes local', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const service = await createService('provider-reference-boundary', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await service.createProject({
      title: '多参考图边界',
      user_request: '为产品做宣传图，Logo 留给后续确定性叠加',
      size: '1024x1024',
      reference_images: [await dataUrl(), await dataUrl()],
      reference_roles: ['subject', 'logo'],
    })
    const subjectReferenceId = `ref_${createHash('sha256').update([project.id, project.references[0]!.asset_id].join('\0')).digest('hex').slice(0, 32)}`
    const controlled = await service.updateReferenceControl(project.id, subjectReferenceId, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-provider-reference-control-0001',
      role: 'brand',
      influence_strength: 'medium',
      preservation: 'prefer_preserve',
      priority: 37,
      label: '瓶身品牌标识',
    })
    const plan = await service.createCreativePlan(project.id, {
      base_revision: controlled.revision,
      idempotency_key: 'bb-image-provider-reference-plan-0001',
    })
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: controlled.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    await service.createGenerationRound(project.id, {
      base_revision: controlled.revision,
      idempotency_key: 'bb-image-provider-reference-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    const submitted = gateway.calls.find(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
    expect(submitted?.body).toMatchObject({ mode: 'edit', n: 1, size: '1024x1024' })
    const submittedImages = (submitted?.body as { images?: unknown[] } | undefined)?.images
    expect(submittedImages).toHaveLength(1)
    expect((submitted?.body as { reference_controls?: unknown } | undefined)?.reference_controls).toEqual([{
      image_index: 0,
      role: 'brand',
      influence_strength: 'medium',
      preservation: 'prefer_preserve',
      priority: 37,
      label: '瓶身品牌标识',
    }])
    expect((submitted?.body as { prompt?: string } | undefined)?.prompt).toContain('Logo')
  })
})

test('15.2 Relay compiles every reference control into the actual Provider request', async () => {
  let resolveUpstream: (() => void) | undefined
  const upstreamRequested = new Promise<void>(resolve => { resolveUpstream = resolve })
  const prompts: string[] = []
  const relay = createRelayFetch({
    env: {
      RELAY_OPENAI_KEY: 'openai-reference-control-key',
      RELAY_OPENAI_BASE: 'https://provider.example.test/v1',
      RELAY_IMG_CONC: '1',
      RELAY_IMG_USER_CONC: '1',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: 'image-relay-service-token-123456789012345',
      IMAGE_RELAY_PUBLIC_BASE: imageRelayUrl,
      IMAGE_RELAY_RESULT_SIGNING_KEY: 'result-signing-key-that-is-longer-than-thirty-two-bytes',
    },
    identityFetchImpl: async () => Response.json({
      active: true,
      principal_id: `installation:${'a'.repeat(32)}`,
      installation_id: 'desktop-installation-a',
      session_id: 'a'.repeat(24),
      expires_at: Date.now() + 60_000,
      owner: `installation:${'a'.repeat(32)}:desktop-installation-a`,
    }),
    fetchImpl: async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      prompts.push(String(form.get('prompt')))
      resolveUpstream?.()
      return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
    },
  })
  const response = await relay(new Request('http://relay.example.test/v1/images/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer installation-access-token',
      'Content-Type': 'application/json',
      'X-Relay-Owner': 'desktop-owner',
      'X-BB-Provider-Protocol': 'bb-provider-gateway/1.0',
      'Idempotency-Key': 'bb-image-relay-reference-controls-0001',
    },
    body: JSON.stringify({
      mode: 'edit',
      model: 'gpt-image-2',
      prompt: '制作两张参考图融合的商品图',
      n: 1,
      size: '1024x1024',
      images: [await dataUrl(), await dataUrl()],
      reference_controls: [
        { image_index: 0, role: 'product', influence_strength: 'high', preservation: 'exact', priority: 90, label: '商品主体' },
        { image_index: 1, role: 'style', influence_strength: 'medium', preservation: 'prefer_preserve', priority: 35, label: '光影风格' },
      ],
    }),
  }))
  expect(response.status).toBe(202)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      upstreamRequested,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Relay did not issue the expected Provider request')), 250)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('制作两张参考图融合的商品图')
  expect(prompts[0]).toContain('参考图 1; role=product; influence=high; preservation=exact; priority=90; label=商品主体')
  expect(prompts[0]).toContain('参考图 2; role=style; influence=medium; preservation=prefer_preserve; priority=35; label=光影风格')
})

test('Provider 明确拒绝且没有远端 receipt 时不占用本地可能扣费', async () => {
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      return Response.json({ error: 'provider rejected before execution' }, { status: 400 })
    }
    return Response.json({ error: 'unexpected image gateway call' }, { status: 500 })
  }
  const service = await createService('generation-known-rejection', gateway)
  await withGateway(async () => {
    const project = await createProject(service)
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-known-rejection-plan-0001',
    })
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const created = await service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-known-rejection-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    expect(created.operations[0]).toMatchObject({ status: 'failed', cost_state: 'not_submitted' })
    expect(created.operations[0]?.remote_task_id).toBeUndefined()
  })
})

test('15.2 rejects capability gaps before paid submission, permits partial candidates, replays a Round and atomically adopts one Candidate to two Artboards', async () => {
  let paidPosts = 0
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: 'relay_task_partial', status: 'queued', provider_receipt_hash: 'b'.repeat(64) })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_partial' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        task_id: 'relay_task_partial',
        status: 'succeeded',
        provider_receipt_hash: 'b'.repeat(64),
        expected_count: 1,
        valid_count: 1,
        partial_outcome_unknown: true,
        invalid: [],
        data: [
          { candidate_index: 0, b64_json: png, mime_type: 'image/png' },
        ],
      })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_partial/ack' && init?.method === 'POST') {
      return Response.json({ result_acknowledged: true })
    }
    return Response.json({ error: 'unexpected image gateway call' }, { status: 500 })
  }
  const service = await createService('generation-round', gateway)
  await withGateway(async () => {
    const gapProject = await service.createProject({
      title: '能力缺口',
      user_request: '保留产品外观',
      size: '1024x1024',
      reference_images: [await dataUrl()],
      reference_roles: ['subject'],
    })
    const unclassified = await service.repository.saveProject({
      ...gapProject,
      references: gapProject.references.map(reference => ({ ...reference, role: 'unclassified' as const })),
      revision: gapProject.revision + 1,
    })
    const gapPlan = await service.createCreativePlan(unclassified.id, {
      base_revision: unclassified.revision,
      idempotency_key: 'bb-image-capability-gap-plan-0001',
    })
    await expect(service.estimateGenerationRound(unclassified.id, {
      base_revision: unclassified.revision,
      creative_plan_id: gapPlan.id,
    })).rejects.toMatchObject({ status: 422, code: 'IMAGE_CAPABILITY_GAP' })
    expect(paidPosts).toBe(0)

    const project = await createProject(service)
    const delivery = await service.repository.saveDeliverySpec({
      schema_version: 1,
      id: 'dsp_generation_round_two_artboards',
      project_id: project.id,
      revision: 1,
      purpose: 'product_marketing',
      artboards: [
        {
          id: 'art_generation_round_square',
          label: '方图',
          width: 1024,
          height: 1024,
          required: true,
          safe_area: { top: 48, right: 48, bottom: 48, left: 48 },
          output: { format: 'png', transparent: false },
        },
        {
          id: 'art_generation_round_vertical',
          label: '竖图',
          width: 1024,
          height: 1536,
          required: true,
          output: { format: 'webp', quality: 90, transparent: false },
        },
      ],
      created_at: at,
    })
    const planCommand = {
      base_revision: project.revision,
      idempotency_key: 'bb-image-partial-plan-0001',
    }
    const plan = await service.createCreativePlan(project.id, planCommand)
    const legacyPlanDatabase = new Database(join(service.repository.paths().root, 'metadata', 'metadata.sqlite'))
    try {
      legacyPlanDatabase.query('UPDATE image_creative_plans SET request_hash=\'\' WHERE id=?').run(plan.id)
    } finally {
      legacyPlanDatabase.close()
    }
    expect(await service.createCreativePlan(project.id, planCommand)).toEqual(plan)
    const reboundPlanDatabase = new Database(join(service.repository.paths().root, 'metadata', 'metadata.sqlite'), { readonly: true })
    try {
      const rebound = reboundPlanDatabase.query('SELECT request_hash FROM image_creative_plans WHERE id=?').get(plan.id) as { request_hash: string }
      expect(rebound.request_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    } finally {
      reboundPlanDatabase.close()
    }
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const command = {
      base_revision: project.revision,
      idempotency_key: 'bb-image-partial-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true as const,
    }
    const created = await service.createGenerationRound(project.id, command)
    expect(paidPosts).toBe(1)
    const completed = await service.getGenerationOperation(project.id, created.operations[0]!.id)
    expect(completed.result).toMatchObject({ kind: 'candidate_group', expected_count: 1, valid_count: 1 })
    expect(completed.result).toMatchObject({ partial_outcome_unknown: true })
    expect(completed.cost_state).toBe('submitted_charge_possible')
    if (completed.result?.kind !== 'candidate_group') throw new Error('expected Candidate Group result')
    expect(completed.result.invalid).toEqual([])
    const replay = await service.createGenerationRound(project.id, command)
    expect(replay.round.id).toBe(created.round.id)
    expect(paidPosts).toBe(1)
    const legacyRoundDatabase = new Database(join(service.repository.paths().root, 'metadata', 'metadata.sqlite'))
    try {
      legacyRoundDatabase.query('UPDATE image_generation_rounds SET request_hash=\'\' WHERE id=?').run(created.round.id)
    } finally {
      legacyRoundDatabase.close()
    }
    const legacyRoundReplay = await service.createGenerationRound(project.id, command)
    expect(legacyRoundReplay.round.id).toBe(created.round.id)
    expect(paidPosts).toBe(1)
    const reboundRoundDatabase = new Database(join(service.repository.paths().root, 'metadata', 'metadata.sqlite'), { readonly: true })
    try {
      const rebound = reboundRoundDatabase.query('SELECT request_hash FROM image_generation_rounds WHERE id=?').get(created.round.id) as { request_hash: string }
      expect(rebound.request_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    } finally {
      reboundRoundDatabase.close()
    }

    const group = await service.getCandidateGroup(project.id, completed.result.candidate_group_id)
    expect(group.candidates[0]?.candidate_index).toBe(0)
    const beforeAdopt = await service.getProject(project.id)
    expect(beforeAdopt.current_versions_by_artboard).toEqual({})
    const adoptionInput = {
      base_revision: beforeAdopt.revision,
      idempotency_key: 'bb-image-partial-adopt-0001',
      adoptions: delivery.artboards.map(artboard => ({
        artboard_id: artboard.id,
        placement: { fit: 'contain' as const, focus_x: 0.5, focus_y: 0.5 },
      })),
    }
    const adopted = await service.adoptCandidate(project.id, group.candidates[0]!.id, adoptionInput)
    expect(Object.keys(adopted.project.current_versions_by_artboard)).toEqual(delivery.artboards.map(artboard => artboard.id).sort())
    const replayedAdoption = await service.adoptCandidate(project.id, group.candidates[0]!.id, adoptionInput)
    expect(replayedAdoption.adoptions).toEqual(adopted.adoptions)
    expect((await service.getProject(project.id)).versions).toHaveLength(2)
    expect((await service.repository.listCanvasRevisions(project.id)).map(canvas => ({
      artboard_id: canvas.document.artboard_id,
      revision: canvas.revision,
      source_asset_id: canvas.document.layers[0]?.kind === 'raster' ? canvas.document.layers[0].source_asset_id : undefined,
    }))).toEqual(delivery.artboards.map(artboard => ({
      artboard_id: artboard.id,
      revision: 0,
      source_asset_id: group.candidates[0]!.asset_id,
    })))
  })
})

test('15.2 records a Provider policy refusal as a blocked Operation and a safe execution receipt', async () => {
  const service = await createService('policy-refusal', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      return Response.json({
        status: 'blocked_by_policy',
        refusal: { category: 'content_safety', safe_message: '请求不符合图片内容政策' },
        provider_receipt_hash: 'c'.repeat(64),
      }, { status: 422 })
    }
    return Response.json({ error: 'unexpected policy refusal call' }, { status: 500 })
  })
  await withGateway(async () => {
    const project = await createProject(service)
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-policy-refusal-plan-0001',
    })
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const created = await service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-policy-refusal-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    const operation = created.operations[0]!
    expect(operation).toMatchObject({ status: 'blocked_by_policy', cost_state: 'not_submitted' })
    const receipt = await service.repository.getExecutionReceipt(project.id, operation.execution_receipt_id!)
    expect(receipt.refusal).toEqual({ category: 'content_safety', safe_message: '请求不符合图片内容政策' })
  })
})

test('15.2 projects a hosted Image Relay quota refusal without marking another capability unavailable', async () => {
  const service = await createService('hosted-image-quota', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      return Response.json({
        error: '今日托管图片额度已用完',
        code: 'image_owner_quota_exhausted',
        capability: 'image_generation',
        scope: 'owner',
        resets_at: '2026-08-04T00:00:00.000Z',
      }, { status: 429 })
    }
    return Response.json({ error: 'unexpected image quota call' }, { status: 500 })
  })
  await withGateway(async () => {
    const project = await createProject(service)
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-hosted-quota-plan-0001',
    })
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const created = await service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-hosted-quota-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    expect(created.operations[0]).toMatchObject({
      status: 'failed',
      cost_state: 'not_submitted',
      safe_error: { code: 'MEDIA_IMAGE_QUOTA_EXHAUSTED' },
    })
    expect(mediaSafeErrorForServiceError('IMAGE_QUOTA_EXHAUSTED', 429)).toEqual(
      mediaSafeError('MEDIA_IMAGE_QUOTA_EXHAUSTED'),
    )
    expect(mediaSafeError('MEDIA_IMAGE_QUOTA_EXHAUSTED').message).toContain('Agent 和视频功能不受影响')
  })
})

test('current recovery fences an interrupted remote submission as outcome_unknown without resubmitting it', async () => {
  const calls: GatewayCall[] = []
  const service = await createService('interrupted-submission', async (input, init) => {
    calls.push({
      path: new URL(input instanceof Request ? input.url : input.toString()).pathname,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    return Response.json({ error: 'recovery must not submit' }, { status: 500 })
  })
  await withGateway(async () => {
    const project = await createProject(service)
    const saved = await service.repository.saveOperation(operation(project.id))
    await service.repository.saveProject({
      ...project,
      task_id: saved.id,
      state: 'queued',
      revision: project.revision + 1,
    })

    await service.recoverInterruptedOperations()
    const recovered = await service.getOperation(saved.id)
    expect(recovered).toMatchObject({ status: 'failed', outcome_unknown: true, error_code: 'MEDIA_IMAGE_OUTCOME_UNKNOWN' })
    // An ambiguous remote submission is probed through the Relay's read-only
    // owner/idempotency lookup.  A 404 does not permit a second paid POST.
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      // Recovery and the subsequent status read are both read-only
      // reconciliation. Neither path is allowed to fall back to POST.
      'GET /image-generation/v1/images/tasks/by-idempotency/bb-image-baseline-idempotency-key',
      'GET /image-generation/v1/images/tasks/by-idempotency/bb-image-baseline-idempotency-key',
    ])
  })
})

test('15.2 retries only the read-only idempotency lookup after a temporary miss', async () => {
  const calls: GatewayCall[] = []
  let lookupCount = 0
  const service = await createService('outcome-unknown-read-only-recovery', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    calls.push({
      path: url.pathname,
      method,
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    if (url.pathname.startsWith('/image-generation/v1/images/tasks/by-idempotency/')) {
      lookupCount += 1
      if (lookupCount === 1) return Response.json({ status: 'not_found' }, { status: 404 })
      return Response.json({
        task_id: 'relay_task_appeared_after_lookup',
        status: 'queued',
        reused: true,
        provider_receipt_hash: 'f'.repeat(64),
      })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_appeared_after_lookup') {
      return Response.json({
        task_id: 'relay_task_appeared_after_lookup',
        status: 'queued',
        provider_receipt_hash: 'f'.repeat(64),
      })
    }
    if (url.pathname === '/image-generation/v1/images/tasks' && method === 'POST') {
      throw new Error('read-only recovery must never submit again')
    }
    return Response.json({ error: 'unexpected read-only recovery request' }, { status: 500 })
  })
  await withGateway(async () => {
    const project = await createProject(service)
    const saved = await service.repository.saveOperation({
      ...operation(project.id),
      status: 'failed',
      progress: 0,
      stage: '提交结果未知',
      outcome_unknown: true,
      error: '图片提交结果未知',
      error_code: 'MEDIA_IMAGE_OUTCOME_UNKNOWN',
    })
    await service.repository.saveProject({ ...project, task_id: saved.id, state: 'queued', revision: project.revision + 1 })

    const first = await service.getOperation(saved.id)
    expect(first).toMatchObject({ status: 'failed', outcome_unknown: true })
    const second = await service.getOperation(saved.id)
    expect(second).toMatchObject({ status: 'queued', outcome_unknown: false, remote_task_id: 'relay_task_appeared_after_lookup' })
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
    expect(calls.filter(call => call.path.startsWith('/image-generation/v1/images/tasks/by-idempotency/'))).toHaveLength(2)
  })
})

test('15.2 persists a Round before POST and resumes it after a process crash with the original idempotency key', async () => {
  const root = await testRoot('round-before-post')
  const legacyMediaRoot = await testRoot('round-before-post-legacy')
  const calls: GatewayCall[] = []
  let crashOnce = true
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      return Response.json({ task_id: 'relay_task_after_restart', status: 'queued', provider_receipt_hash: 'd'.repeat(64) })
    }
    return Response.json({ error: 'unexpected Round recovery request' }, { status: 500 })
  }
  const first = new ImageWorkbenchService({
    root,
    legacyMediaRoot,
    now: () => new Date(at),
    fetchImpl: gateway,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && crashOnce) {
        crashOnce = false
        throw new Error('INJECTED_ROUND_BEFORE_POST_CRASH')
      }
    },
  })
  await withGateway(async () => {
    const project = await createProject(first)
    const plan = await first.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-round-before-post-plan-0001',
    })
    const estimate = await first.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const command = {
      base_revision: project.revision,
      idempotency_key: 'bb-image-round-before-post-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true as const,
    }
    await expect(first.createGenerationRound(project.id, command)).rejects.toThrow('INJECTED_ROUND_BEFORE_POST_CRASH')
    expect(calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(0)

    const roundId = `rnd_${createHash('sha256').update([project.id, command.idempotency_key].join('\0')).digest('hex').slice(0, 32)}`
    const round = await first.repository.getGenerationRound(project.id, roundId)
    const formal = await first.repository.getGenerationOperation(project.id, round.direction_operations[0]!.operation_id)
    const transport = await first.repository.getOperation(formal.transport_task_id!)
    expect(formal).toMatchObject({ status: 'queued', idempotency_key: transport.idempotency_key })
    expect(transport.remote_task_id).toBeUndefined()
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot, now: () => new Date(at), fetchImpl: gateway })
    await recovered.applications.recovery.recoverInterruptedOperations()
    const resumed = await recovered.repository.getGenerationOperation(project.id, formal.id)
    const resumedTransport = await recovered.repository.getOperation(resumed.transport_task_id!)
    expect(resumed).toMatchObject({ status: 'queued', remote_task_id: 'relay_task_after_restart' })
    expect(resumedTransport.remote_task_id).toBe('relay_task_after_restart')
    const posts = calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.headers.get('idempotency-key')).toBe(transport.idempotency_key)
    recovered.repository.close()
  })
})

test('15.2 resolves a lost submit response immediately through idempotency lookup without a second POST', async () => {
  const root = await testRoot('round-outcome-unknown')
  const legacyMediaRoot = await testRoot('round-outcome-unknown-legacy')
  const calls: GatewayCall[] = []
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      throw new Error('connection dropped after provider accepted the request')
    }
    if (url.pathname.startsWith('/image-generation/v1/images/tasks/by-idempotency/') && (init?.method ?? 'GET') === 'GET') {
      return Response.json({ task_id: 'relay_task_idempotent_recovery', status: 'queued', reused: true, provider_receipt_hash: 'e'.repeat(64) })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_idempotent_recovery' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({ task_id: 'relay_task_idempotent_recovery', status: 'queued', provider_receipt_hash: 'e'.repeat(64) })
    }
    return Response.json({ error: 'unexpected unknown-outcome recovery request' }, { status: 500 })
  }
  const first = new ImageWorkbenchService({ root, legacyMediaRoot, now: () => new Date(at), fetchImpl: gateway })
  await withGateway(async () => {
    const project = await createProject(first)
    const plan = await first.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-round-unknown-plan-0001',
    })
    const estimate = await first.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const created = await first.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-round-unknown-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    expect(created.operations[0]).toMatchObject({ status: 'queued', remote_task_id: 'relay_task_idempotent_recovery' })
    const transport = await first.repository.getOperation(created.operations[0]!.transport_task_id!)
    expect(transport.outcome_unknown).not.toBeTrue()
    expect(transport.remote_task_id).toBe('relay_task_idempotent_recovery')
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot, now: () => new Date(at), fetchImpl: gateway })
    await recovered.applications.recovery.recoverInterruptedOperations()
    const resumed = await recovered.repository.getGenerationOperation(project.id, created.operations[0]!.id)
    expect(resumed).toMatchObject({ status: 'queued', remote_task_id: 'relay_task_idempotent_recovery' })
    const posts = calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
    expect(posts).toHaveLength(1)
    const lookups = calls.filter(call => call.path.startsWith('/image-generation/v1/images/tasks/by-idempotency/') && call.method === 'GET')
    expect(lookups).toHaveLength(1)
    expect(decodeURIComponent(lookups[0]!.path.split('/').at(-1)!)).toBe(transport.idempotency_key)
    recovered.repository.close()
  })
})

test('15.2 treats a Relay 5xx after reservation as unknown and reconciles without a paid retry', async () => {
  const root = await testRoot('round-5xx-outcome-unknown')
  const legacyMediaRoot = await testRoot('round-5xx-outcome-unknown-legacy')
  const calls: GatewayCall[] = []
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      return Response.json({ error: 'relay response lost after reservation' }, { status: 503 })
    }
    if (url.pathname.startsWith('/image-generation/v1/images/tasks/by-idempotency/') && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        task_id: 'relay_task_after_503',
        status: 'queued',
        reused: true,
        provider_receipt_hash: '9'.repeat(64),
      })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_after_503' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({ task_id: 'relay_task_after_503', status: 'queued', provider_receipt_hash: '9'.repeat(64) })
    }
    return Response.json({ error: 'unexpected 5xx recovery request' }, { status: 500 })
  }
  const service = new ImageWorkbenchService({ root, legacyMediaRoot, now: () => new Date(at), fetchImpl: gateway })
  await withGateway(async () => {
    const project = await createProject(service)
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-round-5xx-plan-0001',
    })
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const created = await service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-round-5xx-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    expect(created.operations[0]).toMatchObject({ status: 'queued', remote_task_id: 'relay_task_after_503' })
    expect(calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
    expect(calls.filter(call => call.path.startsWith('/image-generation/v1/images/tasks/by-idempotency/') && call.method === 'GET')).toHaveLength(1)
  })
})

test('15.2 expires estimates and requires an explicit paid derivation confirmation', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  let now = new Date(at)
  let paidPosts = 0
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: paidPosts === 1 ? 'relay_task_source' : 'relay_task_derivation', status: 'queued', provider_receipt_hash: 'f'.repeat(64) })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_source' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        task_id: 'relay_task_source',
        status: 'succeeded',
        provider_receipt_hash: 'f'.repeat(64),
        data: [
          { b64_json: png, mime_type: 'image/png' },
          { b64_json: png, mime_type: 'image/png' },
          { b64_json: png, mime_type: 'image/png' },
        ],
      })
    }
    if (url.pathname.endsWith('/ack') && init?.method === 'POST') return Response.json({ result_acknowledged: true })
    return Response.json({ error: 'unexpected estimate or derivation request' }, { status: 500 })
  }
  const service = new ImageWorkbenchService({
    root: await testRoot('estimate-and-derivation-confirmation'),
    legacyMediaRoot: await testRoot('estimate-and-derivation-confirmation-legacy'),
    now: () => now,
    fetchImpl: gateway,
  })
  await withGateway(async () => {
    const project = await createProject(service)
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-expiry-plan-0001',
    })
    const expired = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    now = new Date(Date.parse(expired.expires_at) + 1)
    await expect(service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-expiry-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: expired.estimate_hash,
      confirm: true,
    })).rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    expect(paidPosts).toBe(0)

    now = new Date(at)
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const source = await service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-derivation-source-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    const completedSource = await service.getGenerationOperation(project.id, source.operations[0]!.id)
    if (completedSource.result?.kind !== 'candidate_group') throw new Error('expected source Candidate Group')
    const sourceCandidate = (await service.getCandidateGroup(project.id, completedSource.result.candidate_group_id)).candidates[0]!
    const current = await service.getProject(project.id)

    await expect(service.deriveCandidate(project.id, sourceCandidate.id, {
      base_revision: current.revision,
      idempotency_key: 'bb-image-derivation-without-confirmation-0001',
      instruction: '仅调整背景光线',
    } as never)).rejects.toThrow()
    expect(paidPosts).toBe(1)

    const derivationEstimate = await service.estimateDerivation(project.id, sourceCandidate.id, {
      base_revision: current.revision,
      instruction: '仅调整背景光线',
    })
    now = new Date(Date.parse(derivationEstimate.expires_at) + 1)
    await expect(service.deriveCandidate(project.id, sourceCandidate.id, {
      base_revision: current.revision,
      idempotency_key: 'bb-image-derivation-expired-estimate-0001',
      instruction: '仅调整背景光线',
      estimate_hash: derivationEstimate.estimate_hash,
      confirm: true,
    })).rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    expect(paidPosts).toBe(1)

    const renewedDerivationEstimate = await service.estimateDerivation(project.id, sourceCandidate.id, {
      base_revision: current.revision,
      instruction: '仅调整背景光线',
    })
    await expect(service.deriveCandidate(project.id, sourceCandidate.id, {
      base_revision: current.revision,
      idempotency_key: 'bb-image-derivation-confirm-false-0001',
      instruction: '仅调整背景光线',
      estimate_hash: renewedDerivationEstimate.estimate_hash,
      confirm: false,
    } as never)).rejects.toThrow()
    expect(paidPosts).toBe(1)

    const derived = await service.deriveCandidate(project.id, sourceCandidate.id, {
      base_revision: current.revision,
      idempotency_key: 'bb-image-derivation-confirmed-0001',
      instruction: '仅调整背景光线',
      estimate_hash: renewedDerivationEstimate.estimate_hash,
      confirm: true,
    })
    expect(derived.operation).toMatchObject({ kind: 'edit', status: 'queued', base_candidate_id: sourceCandidate.id })
    expect(paidPosts).toBe(2)
  })
})

test('15.2 returns a versioned price and usage ceiling, then rejects a paid Round above the project budget', async () => {
  const service = new ImageWorkbenchService({ root: await testRoot('priced-budget'), legacyMediaRoot: await testRoot('priced-budget-legacy'), now: () => new Date(at) })
  const project = await service.createProject({
    title: '预算上界', user_request: '生成一张活动海报', size: '1024x1024', reference_images: [], reference_roles: [],
    budget_limit: { currency: 'USD', amount_minor: 1 },
  })
  const current = await service.getProject(project.id)
  const plan = await service.createCreativePlan(project.id, { base_revision: current.revision, idempotency_key: 'bb-image-price-plan-0001' })
  const estimate = await service.estimateGenerationRound(project.id, { base_revision: current.revision, creative_plan_id: plan.id })
  expect(estimate.price_upper_bound).toMatchObject({ currency: 'USD', amount_minor: expect.any(Number), usage_upper_bound: { requests: 1, output_images: 1 } })
  await expect(service.createGenerationRound(project.id, {
    base_revision: current.revision, idempotency_key: 'bb-image-price-budget-reject-0001', creative_plan_id: plan.id,
    direction_ids: [plan.directions[0]!.id], estimate_hash: estimate.estimate_hash, confirm: true,
  })).rejects.toMatchObject({ status: 422, code: 'IMAGE_BUDGET_EXCEEDED' })
})

test('15.2 projects every Command idempotency and revision conflict through stable API errors', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  let paidPosts = 0
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: paidPosts === 1 ? 'relay_task_conflict_source' : 'relay_task_conflict_derive', status: 'queued', provider_receipt_hash: '1'.repeat(64) })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_conflict_source' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        task_id: 'relay_task_conflict_source',
        status: 'succeeded',
        provider_receipt_hash: '1'.repeat(64),
        data: [
          { b64_json: png, mime_type: 'image/png' },
          { b64_json: png, mime_type: 'image/png' },
          { b64_json: png, mime_type: 'image/png' },
        ],
      })
    }
    if (url.pathname.endsWith('/ack') && init?.method === 'POST') return Response.json({ result_acknowledged: true })
    return Response.json({ error: 'unexpected idempotency conflict request' }, { status: 500 })
  }
  const service = await createService('complete-idempotency-conflicts', gateway)
  await withGateway(async () => {
    const initial = await service.createProject({
      title: '完整幂等冲突',
      user_request: '创建可验证的候选图',
      size: '1024x1024',
      reference_images: [await dataUrl()],
      reference_roles: ['subject'],
    })
    const commandCapability = 'fedcba9876543210fedcba9876543210'
    const commandHandler = createImageWorkbenchDomainApiHandler(service.applications, commandCapability)
    const expectPublicCommandConflict = async (
      path: string,
      body: unknown,
      error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' | 'MEDIA_IMAGE_REVISION_CONFLICT',
    ) => {
      const response = await request(commandHandler, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': commandCapability },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error, message: mediaSafeError(error).message })
    }
    const projectPath = `/api/images/projects/${initial.id}`
    const referenceId = `ref_${createHash('sha256').update([initial.id, initial.references[0]!.asset_id].join('\0')).digest('hex').slice(0, 32)}`
    const referenceCommand = {
      base_revision: initial.revision,
      idempotency_key: 'bb-image-reference-control-conflict-0001',
      role: 'subject' as const,
      influence_strength: 'high' as const,
      preservation: 'must_preserve' as const,
      priority: 80,
    }
    const controlled = await service.updateReferenceControl(initial.id, referenceId, referenceCommand)
    const referenceReplay = await service.updateReferenceControl(initial.id, referenceId, referenceCommand)
    expect(referenceReplay.revision).toBe(controlled.revision)
    const referenceIdempotencyConflict = {
      ...referenceCommand,
      base_revision: controlled.revision,
      priority: 60,
    }
    await expect(service.updateReferenceControl(initial.id, referenceId, referenceIdempotencyConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/references/${referenceId}/commands/update-control`, referenceIdempotencyConflict, 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT')
    const referenceRevisionConflict = {
      ...referenceCommand,
      idempotency_key: 'bb-image-reference-control-revision-0001',
      priority: 70,
    }
    await expect(service.updateReferenceControl(initial.id, referenceId, referenceRevisionConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/references/${referenceId}/commands/update-control`, referenceRevisionConflict, 'MEDIA_IMAGE_REVISION_CONFLICT')

    const planCommand = {
      base_revision: controlled.revision,
      idempotency_key: 'bb-image-plan-conflict-0001',
    }
    const generation = service.applications.generation
    const plan = await generation.createCreativePlan(initial.id, planCommand)
    expect((await generation.createCreativePlan(initial.id, planCommand)).id).toBe(plan.id)
    const planIdempotencyConflict = {
      ...planCommand,
      directions: [{
        label: '冲突方向',
        rationale: '同一幂等键不能替换已有创作方向',
        generation_intent: { composition_goal: '产品居中', visual_tone: '冷色商业感' },
        preservation_rules: [],
      }],
    }
    await expect(generation.createCreativePlan(initial.id, planIdempotencyConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/creative-plans`, planIdempotencyConflict, 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT')
    const planRevisionConflict = {
      ...planCommand,
      base_revision: initial.revision,
      idempotency_key: 'bb-image-plan-revision-0001',
    }
    await expect(generation.createCreativePlan(initial.id, planRevisionConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/creative-plans`, planRevisionConflict, 'MEDIA_IMAGE_REVISION_CONFLICT')

    const estimate = await service.estimateGenerationRound(initial.id, {
      base_revision: controlled.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const roundCommand = {
      base_revision: controlled.revision,
      idempotency_key: 'bb-image-round-conflict-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true as const,
    }
    const source = await service.createGenerationRound(initial.id, roundCommand)
    expect((await service.createGenerationRound(initial.id, roundCommand)).round.id).toBe(source.round.id)
    const roundIdempotencyConflict = {
      ...roundCommand,
      estimate_hash: `sha256:${'2'.repeat(64)}`,
    }
    await expect(service.createGenerationRound(initial.id, roundIdempotencyConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/generation-rounds`, roundIdempotencyConflict, 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT')
    const roundRevisionConflict = {
      ...roundCommand,
      idempotency_key: 'bb-image-round-revision-0001',
    }
    await expect(service.createGenerationRound(initial.id, roundRevisionConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/generation-rounds`, roundRevisionConflict, 'MEDIA_IMAGE_REVISION_CONFLICT')
    const completedSource = await service.getGenerationOperation(initial.id, source.operations[0]!.id)
    if (completedSource.result?.kind !== 'candidate_group') throw new Error('expected source Candidate Group')
    const candidate = (await service.getCandidateGroup(initial.id, completedSource.result.candidate_group_id)).candidates[0]!
    const sourceProject = await service.getProject(initial.id)
    const decisionCommand = {
      base_revision: sourceProject.revision,
      idempotency_key: 'bb-image-decision-conflict-0001',
      decision: 'kept' as const,
    }
    await service.decideCandidate(initial.id, candidate.id, decisionCommand)
    const decisionIdempotencyConflict = { ...decisionCommand, decision: 'rejected' as const }
    await expect(service.decideCandidate(initial.id, candidate.id, decisionIdempotencyConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/candidates/${candidate.id}/decisions`, decisionIdempotencyConflict, 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT')
    const decisionRevisionConflict = {
      ...decisionCommand,
      base_revision: controlled.revision,
      idempotency_key: 'bb-image-decision-revision-0001',
    }
    await expect(service.decideCandidate(initial.id, candidate.id, decisionRevisionConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/candidates/${candidate.id}/decisions`, decisionRevisionConflict, 'MEDIA_IMAGE_REVISION_CONFLICT')
    const delivery = await service.repository.currentDeliverySpec(initial.id)
    if (!delivery) throw new Error('expected delivery spec')
    const adoptionCommand = {
      base_revision: sourceProject.revision,
      idempotency_key: 'bb-image-adoption-conflict-0001',
      adoptions: [{ artboard_id: delivery.artboards[0]!.id, placement: { fit: 'cover' as const, focus_x: 0.5, focus_y: 0.5 } }],
    }
    await service.adoptCandidate(initial.id, candidate.id, adoptionCommand)
    const adoptionIdempotencyConflict = {
      ...adoptionCommand,
      adoptions: [{ artboard_id: delivery.artboards[0]!.id, placement: { fit: 'cover' as const, focus_x: 0.25, focus_y: 0.5 } }],
    }
    await expect(service.adoptCandidate(initial.id, candidate.id, adoptionIdempotencyConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/candidates/${candidate.id}/adoptions`, adoptionIdempotencyConflict, 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT')
    const adoptionRevisionConflict = {
      ...adoptionCommand,
      idempotency_key: 'bb-image-adoption-revision-0001',
    }
    await expect(service.adoptCandidate(initial.id, candidate.id, adoptionRevisionConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/candidates/${candidate.id}/adoptions`, adoptionRevisionConflict, 'MEDIA_IMAGE_REVISION_CONFLICT')
    const current = await service.getProject(initial.id)
    const derivationEstimate = await service.estimateDerivation(initial.id, candidate.id, {
      base_revision: current.revision,
      instruction: '提高产品边缘对比度',
    })
    const derivationCommand = {
      base_revision: current.revision,
      idempotency_key: 'bb-image-derivation-conflict-0001',
      instruction: '提高产品边缘对比度',
      estimate_hash: derivationEstimate.estimate_hash,
      confirm: true as const,
    }
    const derived = await service.deriveCandidate(initial.id, candidate.id, derivationCommand)
    expect((await service.deriveCandidate(initial.id, candidate.id, derivationCommand)).round.id).toBe(derived.round.id)
    const derivationIdempotencyConflict = {
      ...derivationCommand,
      instruction: '提高背景亮度',
    }
    await expect(service.deriveCandidate(initial.id, candidate.id, derivationIdempotencyConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/candidates/${candidate.id}/derivations`, derivationIdempotencyConflict, 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT')
    const derivationRevisionConflict = {
      ...derivationCommand,
      idempotency_key: 'bb-image-derivation-revision-0001',
    }
    await expect(service.deriveCandidate(initial.id, candidate.id, derivationRevisionConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_REVISION_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/candidates/${candidate.id}/derivations`, derivationRevisionConflict, 'MEDIA_IMAGE_REVISION_CONFLICT')
    expect(paidPosts).toBe(2)
  })
})

test('15.2 keeps the queued-only Relay cancel contract and records a terminal cancellation event', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const service = await createService('cancel', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await createProject(service)
    const submitted = await service.submitProject(project.id)
    const cancelled = await service.cancelOperation(submitted.id)
    expect(cancelled.status).toBe('cancelled')
    expect((await service.getProject(project.id)).state).toBe('queued')
    expect((await service.listOperationEvents(project.id, 0, 100)).events.at(-1)?.operation.status).toBe('cancelled')
    expect(gateway.calls.find(call => call.path.endsWith('/cancel'))?.headers.get('authorization')).toBe(`Bearer ${gatewayToken}`)
  })
})

test('15.2 未跨过远端提交边界的 queued Generation Operation 可原子取消且不会在恢复时首发', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  let crashOnce = true
  const service = new ImageWorkbenchService({
    root: await testRoot('cancel-unposted'),
    legacyMediaRoot: await testRoot('cancel-unposted-legacy'),
    now: () => new Date(at),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && crashOnce) {
        crashOnce = false
        throw new Error('INJECTED_CANCEL_BEFORE_POST')
      }
    },
  })
  await withGateway(async () => {
    const project = await createProject(service)
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-cancel-unposted-plan-0001',
    })
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    await expect(service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-cancel-unposted-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })).rejects.toThrow('INJECTED_CANCEL_BEFORE_POST')
    const round = (await service.repository.listGenerationRounds(project.id))[0]
    if (!round) throw new Error('expected persisted generation round')
    const operation = await service.repository.getGenerationOperation(project.id, round.direction_operations[0]!.operation_id)
    const cancelled = await service.cancelGenerationOperation(operation.id)
    expect(cancelled).toMatchObject({ status: 'cancelled', cost_state: 'not_submitted' })
    expect((await service.repository.getOperation(operation.transport_task_id!)).status).toBe('cancelled')
    await service.recoverInterruptedOperations()
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(0)
  })
})

test('15.2 retains a late successful result after a confirmed queued cancellation without auto-adopting it', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  let paidPosts = 0
  let cancelled = false
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/image-generation/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: 'relay_task_cancel_late', status: 'queued', provider_receipt_hash: '3'.repeat(64) })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_cancel_late' && (init?.method ?? 'GET') === 'GET') {
      return Response.json(cancelled
        ? {
            task_id: 'relay_task_cancel_late',
            status: 'succeeded',
            provider_receipt_hash: '3'.repeat(64),
            data: [{ b64_json: png, mime_type: 'image/png' }],
          }
        : { task_id: 'relay_task_cancel_late', status: 'queued', provider_receipt_hash: '3'.repeat(64) })
    }
    if (url.pathname === '/image-generation/v1/images/tasks/relay_task_cancel_late/cancel' && init?.method === 'POST') {
      cancelled = true
      return Response.json({ status: 'cancelled' })
    }
    if (url.pathname.endsWith('/ack') && init?.method === 'POST') return Response.json({ result_acknowledged: true })
    return Response.json({ error: 'unexpected late cancellation request' }, { status: 500 })
  }
  const service = await createService('cancel-late-result', gateway)
  await withGateway(async () => {
    const project = await createProject(service)
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-cancel-late-plan-0001',
    })
    const estimate = await service.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const created = await service.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-cancel-late-round-0001',
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    const cancelledOperation = await service.cancelGenerationOperation(created.operations[0]!.id)
    expect(cancelledOperation).toMatchObject({ status: 'cancelled', cancellation: { late_result_policy: 'retain_as_unadopted' } })

    const completedLate = await service.getGenerationOperation(project.id, created.operations[0]!.id)
    expect(completedLate).toMatchObject({ status: 'succeeded', result: { kind: 'candidate_group', valid_count: 1 } })
    if (completedLate.result?.kind !== 'candidate_group') throw new Error('expected retained Candidate Group')
    const retained = await service.getCandidateGroup(project.id, completedLate.result.candidate_group_id)
    expect(retained.candidates).toHaveLength(1)
    expect((await service.getProject(project.id)).current_versions_by_artboard).toEqual({})
    expect(paidPosts).toBe(1)
  })
})

test('15.2 API schema rejects invalid fixture and exposes only capability-gated, prompt-safe generation commands', async () => {
  const service = await createService('api')
  const capability = '0123456789abcdef0123456789abcdef'
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  const invalidFixture = await request(handler, '/api/images/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({
      user_request: '损坏 fixture 必须失败',
      reference_images: [await brokenDataUrl()],
      reference_roles: ['subject'],
    }),
  })
  expect(invalidFixture.status).toBe(400)

  const created = await request(handler, '/api/images/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({
      user_request: 'API 合同基线',
      owner: { kind: 'forged', owner_id: 'not-accepted' },
    }),
  })
  expect(created.status).toBe(201)
  const payload = await created.json() as { project: { id: string; revision: number; owner?: unknown; prompt?: unknown; model?: unknown } }
  expect(payload.project.owner).toBeUndefined()
  expect(payload.project.prompt).toBeUndefined()
  expect(payload.project.model).toBeUndefined()

  const missingCapability = await request(handler, `/api/images/projects/${payload.project.id}/creative-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: payload.project.revision, idempotency_key: 'bb-image-api-plan-unauthorised-0001' }),
  })
  expect(missingCapability.status).toBe(403)
  const planResponse = await request(handler, `/api/images/projects/${payload.project.id}/creative-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({ base_revision: payload.project.revision, idempotency_key: 'bb-image-api-plan-authorised-0001' }),
  })
  expect(planResponse.status).toBe(201)
  const plan = await planResponse.json() as { plan: { id: string; directions: Array<{ id: string }>; provider_prompt?: unknown } }
  expect(plan.plan.provider_prompt).toBeUndefined()
  const estimate = await request(handler, `/api/images/projects/${payload.project.id}/generation-rounds/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({
      base_revision: payload.project.revision,
      creative_plan_id: plan.plan.id,
      direction_ids: [plan.plan.directions[0]!.id],
    }),
  })
  expect(estimate.status).toBe(200)
  expect(await estimate.json()).toMatchObject({ paid_operation_count: 1, expires_at: at.replace('00:00:00.000Z', '00:05:00.000Z') })

  const unconfirmedDerivation = await request(handler, `/api/images/projects/${payload.project.id}/candidates/cand_00000001/derivations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
    body: JSON.stringify({
      base_revision: payload.project.revision,
      idempotency_key: 'bb-image-api-derivation-unconfirmed-0001',
      instruction: '不应触发付费提交',
    }),
  })
  expect(unconfirmedDerivation.status).toBe(400)

  const unauthorised = await request(handler, `/api/images/projects/${payload.project.id}/submit`, { method: 'POST' })
  expect(unauthorised.status).toBe(403)
  const malformedCursor = await request(handler, `/api/images/projects/${payload.project.id}/events?cursor=-1`)
  expect(malformedCursor.status).toBe(400)
})

test('15.5A Quick Create reserves one formal Project and paid Direction across replay and restart recovery', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const capability = '15aquickcreatecapability000000000000'
  const input = {
    idempotency_key: 'bb-image-15a-quick-create-replay-0001',
    prompt: '为新品制作一张有清晰产品主体的横版宣传图',
    title: '15.5A 快速建项',
    output_preset: 'landscape' as const,
    reference_inputs: [{ data_url: await dataUrl(), role: 'product' as const }],
  }
  const service = await createService('15a-quick-create', gateway.fetchImpl)
  await withGateway(async () => {
    const firstPayload = await service.quickCreate(input, { mode: 'start' })
    expect(firstPayload.mode).toBe('started')
    expect(firstPayload.project.generation_preferences).toEqual({ output_preset: 'landscape', model_selection: 'auto' })
    expect(firstPayload.operations).toHaveLength(1)
    expect(firstPayload.operations[0]?.status).toBe('queued')
    const posts = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({ mode: 'edit', n: 1, size: '1536x1024' })
    expect((posts[0]?.body as { reference_controls?: unknown[] }).reference_controls).toEqual([{
      image_index: 0,
      role: 'product',
      influence_strength: 'high',
      preservation: 'must_preserve',
      priority: 0,
    }])

    const replayPayload = await service.quickCreate(input, { mode: 'start' })
    expect(replayPayload.mode).toBe('started')
    expect(replayPayload.project.id).toBe(firstPayload.project.id)
    expect(replayPayload.round.id).toBe(firstPayload.round.id)
    expect(replayPayload.operations.map(operation => operation.id)).toEqual(firstPayload.operations.map(operation => operation.id))
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
  })
  service.repository.close()

  const crashRoot = await testRoot('15a-quick-create-crash')
  const crashLegacyRoot = await testRoot('15a-quick-create-crash-legacy')
  let crashOnce = true
  const interrupted = new ImageWorkbenchService({
    root: crashRoot,
    legacyMediaRoot: crashLegacyRoot,
    now: () => new Date(at),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && crashOnce) {
        crashOnce = false
        throw new Error('INJECTED_QUICK_CREATE_BEFORE_POST')
      }
    },
  })
  await withGateway(async () => {
    await expect(interrupted.quickCreate({
      ...input,
      idempotency_key: 'bb-image-15a-quick-create-recovery-0001',
    })).rejects.toThrow('INJECTED_QUICK_CREATE_BEFORE_POST')
    const postsBeforeRecovery = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').length
    interrupted.repository.close()
    const recovered = new ImageWorkbenchService({
      root: crashRoot,
      legacyMediaRoot: crashLegacyRoot,
      now: () => new Date(at),
      fetchImpl: gateway.fetchImpl,
    })
    await recovered.recoverInterruptedOperations()
    const replayed = await recovered.quickCreate({
      ...input,
      idempotency_key: 'bb-image-15a-quick-create-recovery-0001',
    })
    expect(replayed.operations).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(postsBeforeRecovery + 1)
    recovered.repository.close()
  })
})

test('公开 Quick Create 只持久化建项与输入，未确认建议前不会产生 Provider POST', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const capability = 'public-quick-create-prepare-capability-0001'
  const service = await createService('public-quick-create-prepare', gateway.fetchImpl)
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  const input = {
    idempotency_key: 'bb-image-public-quick-create-prepare-0001',
    prompt: '只建立一个待确认的图片项目，不应立即扣费。',
    output_preset: 'square' as const,
    model_selection: 'gpt-image-2' as const,
    reference_inputs: [],
  }
  await withGateway(async () => {
    const first = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
      body: JSON.stringify(input),
    })
    expect(first.status).toBe(202)
    const prepared = await first.json() as { mode: string; project: { id: string; generation_preferences: unknown } }
    expect(prepared).toMatchObject({ mode: 'prepared', project: { generation_preferences: { model_selection: 'gpt-image-2' } } })
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(0)

    const replay = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
      body: JSON.stringify(input),
    })
    expect(replay.status).toBe(202)
    expect((await replay.json() as { mode: string; project: { id: string } }).project.id).toBe(prepared.project.id)

    const conflict = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
      body: JSON.stringify({ ...input, prompt: '同一个幂等键不能换需求。' }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })
  })
  service.repository.close()
})

test('15.5A Quick Create 的并发同键请求重放同一 Project 且只提交一次付费任务', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const service = await createService('15a-quick-create-concurrent', gateway.fetchImpl)
  const input = {
    idempotency_key: 'bb-image-15-a-quick-create-concurrent-0001',
    prompt: '并发重试仍只创建一个图片项目',
    output_preset: 'square' as const,
    reference_inputs: [{ data_url: await dataUrl(), role: 'product' as const }],
  }

  await withGateway(async () => {
    const results = await Promise.allSettled([service.quickCreate(input), service.quickCreate(input)])
    const fulfilled = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    expect(fulfilled).toHaveLength(2)
    expect(new Set(fulfilled.map(result => result.project.id))).toHaveLength(1)
    expect(new Set(fulfilled.map(result => result.round.id))).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
  })
})

test('用途档位映射到所选模型原生规格，且不偷偷改写用户的模型选择', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const capability = 'image-preference-capability-000000000'
  const service = await createService('generation-preferences', gateway.fetchImpl)
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  await withGateway(async () => {
    const selected = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
      body: JSON.stringify({
        idempotency_key: 'bb-image-preference-seedream-portrait-0001',
        prompt: '为门店赛事制作中文竖版宣传图。',
        output_preset: 'social_portrait',
        model_selection: 'doubao-seedream-4-5-251128',
        reference_inputs: [],
      }),
    })
    expect(selected.status).toBe(202)
    const payload = await selected.json() as { project: Record<string, unknown> }
    expect(payload.project.generation_preferences).toEqual({
      output_preset: 'social_portrait', model_selection: 'doubao-seedream-4-5-251128',
    })
    expect(payload.project).not.toHaveProperty('size')
    expect(payload.project).not.toHaveProperty('model')
    const selectedStarted = await service.quickCreate({
      idempotency_key: 'bb-image-preference-seedream-portrait-start-0001',
      prompt: '为门店赛事制作中文竖版宣传图。',
      output_preset: 'social_portrait',
      model_selection: 'doubao-seedream-4-5-251128',
      reference_inputs: [],
    }, { mode: 'start' })
    expect(selectedStarted.mode).toBe('started')
    const post = gateway.calls.find(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
    expect(post?.body).toMatchObject({ model: 'doubao-seedream-4-5-251128', size: '1728x2304', mode: 'generate' })

    const inferred = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
      body: JSON.stringify({
        idempotency_key: 'bb-image-preference-auto-landscape-0001',
        prompt: '制作一张横版海报，用于公众号头图。',
        output_preset: 'auto',
        model_selection: 'gpt-image-2',
        reference_inputs: [],
      }),
    })
    expect(inferred.status).toBe(202)
    const inferredStarted = await service.quickCreate({
      idempotency_key: 'bb-image-preference-auto-landscape-start-0001',
      prompt: '制作一张横版海报，用于公众号头图。',
      output_preset: 'auto',
      model_selection: 'gpt-image-2',
      reference_inputs: [],
    }, { mode: 'start' })
    expect(inferredStarted.mode).toBe('started')
    const inferredPost = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')[1]
    expect(inferredPost?.body).toMatchObject({ model: 'gpt-image-2', size: '1536x1024', mode: 'generate' })

    const selectedWithProductReference = await request(handler, '/api/images/quick-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
      body: JSON.stringify({
        idempotency_key: 'bb-image-preference-seedream-product-0001',
        prompt: '严格保持这个产品的外观，制作商品主图。',
        output_preset: 'square',
        model_selection: 'doubao-seedream-4-5-251128',
        reference_inputs: [{ data_url: await dataUrl(), role: 'product' }],
      }),
    })
    expect(selectedWithProductReference.status).toBe(202)
    const selectedWithProductStarted = await service.quickCreate({
      idempotency_key: 'bb-image-preference-seedream-product-start-0001',
      prompt: '严格保持这个产品的外观，制作商品主图。',
      output_preset: 'square',
      model_selection: 'doubao-seedream-4-5-251128',
      reference_inputs: [{ data_url: await dataUrl(), role: 'product' }],
    }, { mode: 'start' })
    expect(selectedWithProductStarted.mode).toBe('started')
    const selectedWithProductPost = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')[2]
    expect(selectedWithProductPost?.body).toMatchObject({
      model: 'doubao-seedream-4-5-251128',
      size: '2048x2048',
      mode: 'edit',
    })
    expect((selectedWithProductPost?.body as { reference_controls?: unknown[] } | undefined)?.reference_controls).toEqual([{
      image_index: 0,
      role: 'product',
      influence_strength: 'high',
      preservation: 'must_preserve',
      priority: 0,
    }])
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(3)
  })
  service.repository.close()
})

test('15.5A keeps Inspiration local until explicit promote and exposes typed Brief and Reference commands', async () => {
  const service = await createService('15a-inspiration')
  const capability = '15ainspirationcapability000000000000'
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  const project = await createProject(service)
  const headers = { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability }
  const inspirationInput = {
    base_revision: project.revision,
    idempotency_key: 'bb-image-15a-inspiration-upsert-0001',
    items: [{ data_url: await dataUrl(), note: '仅供灵感比较，不发送给模型' }],
  }
  const upsert = await request(handler, `/api/images/projects/${project.id}/inspiration-board/commands/upsert-items`, {
    method: 'POST', headers, body: JSON.stringify(inspirationInput),
  })
  expect(upsert.status).toBe(200)
  const upsertPayload = await upsert.json() as { project: { revision: number }; board: { id: string; items: Array<{ id: string; asset_id: string; data_url?: unknown }> } }
  expect(upsertPayload.board.items).toHaveLength(1)
  expect(upsertPayload.board.items[0]?.data_url).toBeUndefined()
  const boardReplay = await request(handler, `/api/images/projects/${project.id}/inspiration-board/commands/upsert-items`, {
    method: 'POST', headers, body: JSON.stringify(inspirationInput),
  })
  expect(boardReplay.status).toBe(200)
  expect((await boardReplay.json() as { board: { items: unknown[] } }).board.items).toHaveLength(1)
  expect((await service.getProject(project.id)).references).toHaveLength(0)

  const promote = await request(handler, `/api/images/projects/${project.id}/inspiration-board/items/${upsertPayload.board.items[0]!.id}/commands/promote`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_revision: upsertPayload.project.revision,
      idempotency_key: 'bb-image-15a-inspiration-promote-0001',
      role: 'style',
      influence_strength: 'medium',
      preservation: 'prefer_preserve',
      priority: 7,
      label: '纸张与光线风格',
    }),
  })
  expect(promote.status).toBe(200)
  const promotePayload = await promote.json() as { project: { revision: number; references: Array<{ asset_id: string; role: string; influence_strength: string; preservation: string; priority: number }> }; board: { items: Array<{ promoted_reference_asset_id?: string }> } }
  expect(promotePayload.project.references).toEqual([{
    asset_id: upsertPayload.board.items[0]!.asset_id,
    role: 'style',
    influence_strength: 'medium',
    preservation: 'prefer_preserve',
    priority: 7,
    label: '纸张与光线风格',
    image_path: expect.any(String),
    mime_type: 'image/png',
  }])
  expect(promotePayload.board.items[0]?.promoted_reference_asset_id).toBe(upsertPayload.board.items[0]?.asset_id)

  const compiled = await request(handler, `/api/images/projects/${project.id}/brief/compile`, { method: 'POST', headers })
  expect(compiled.status).toBe(200)
  expect(await compiled.json()).toMatchObject({ brief_id: expect.stringMatching(/^brf_/), snapshot_hash: expect.stringMatching(/^sha256:/) })
  const overridden = await request(handler, `/api/images/projects/${project.id}/brief/commands/apply-overrides`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_revision: promotePayload.project.revision,
      idempotency_key: 'bb-image-15a-brief-overrides-0001',
      overrides: { exact_text: ['新品上市'] },
    }),
  })
  expect(overridden.status).toBe(200)
  const overriddenPayload = await overridden.json() as { project: { revision: number } }

  const added = await request(handler, `/api/images/projects/${project.id}/references`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_revision: overriddenPayload.project.revision,
      idempotency_key: 'bb-image-15a-add-reference-0001',
      references: [{
        data_url: await dataUrl(),
        role: 'product',
        influence_strength: 'high',
        preservation: 'must_preserve',
        priority: 1,
        label: '真实产品',
      }],
    }),
  })
  expect(added.status).toBe(201)
  const addedPayload = await added.json() as { project: { revision: number; references: Array<{ asset_id: string; role: string }> } }
  expect(addedPayload.project.references).toHaveLength(2)
  const removed = await request(handler, `/api/images/projects/${project.id}/references/${addedPayload.project.references.find(reference => reference.role === 'product')!.asset_id}/commands/remove`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_revision: addedPayload.project.revision,
      idempotency_key: 'bb-image-15a-remove-reference-0001',
    }),
  })
  expect(removed.status).toBe(200)
  expect((await removed.json() as { project: { references: Array<{ role: string }> } }).project.references).toHaveLength(1)
  service.repository.close()
})

test('15.5B Inpaint stays on the formal Candidate -> Estimate -> Round path and binds a verified mask to the Provider request', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const service = await createService('15b-inpaint', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await createProject(service)
    const submitted = await service.submitProject(project.id)
    const completed = await service.getOperation(submitted.id)
    const formal = await service.findGenerationOperation(completed.operation_id!)
    if (!formal?.result || formal.result.kind !== 'candidate_group') throw new Error('expected candidate group')
    const group = await service.getCandidateGroup(project.id, formal.result.candidate_group_id)
    const current = await service.getProject(project.id)
    const mask = await dataUrl()
    const estimate = await service.estimateDerivation(current.id, group.candidates[0]!.id, {
      base_revision: current.revision,
      instruction: '只替换背景为干净的摄影棚渐变，不修改产品本体',
      kind: 'inpaint',
      mask_data_url: mask,
    })
    const derived = await service.deriveCandidate(current.id, group.candidates[0]!.id, {
      base_revision: current.revision,
      idempotency_key: 'bb-image-15b-inpaint-derive-0001',
      instruction: '只替换背景为干净的摄影棚渐变，不修改产品本体',
      kind: 'inpaint',
      mask_data_url: mask,
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    expect(derived.operation.kind).toBe('inpaint')
    expect(derived.operation.mask_asset_id).toMatch(/^mask_/)
    expect(derived.operation.input_refs.asset_hashes).toContain(await imageHash())
    const latestPost = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').at(-1)
    expect(latestPost?.body).toMatchObject({
      mode: 'edit',
      n: 1,
      mask,
    })
    const persisted = await service.repository.getGenerationOperation(current.id, derived.operation.id)
    expect(persisted).toMatchObject({
      kind: 'inpaint',
      base_candidate_id: group.candidates[0]!.id,
      mask_asset_id: derived.operation.mask_asset_id,
    })
    const replay = await service.deriveCandidate(current.id, group.candidates[0]!.id, {
      base_revision: current.revision,
      idempotency_key: 'bb-image-15b-inpaint-derive-0001',
      instruction: '只替换背景为干净的摄影棚渐变，不修改产品本体',
      kind: 'inpaint',
      mask_data_url: mask,
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    expect(replay.operation.id).toBe(derived.operation.id)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(2)
    await expect(service.estimateDerivation(current.id, group.candidates[0]!.id, {
      base_revision: current.revision,
      instruction: '缺少蒙版必须拒绝',
      kind: 'inpaint',
    })).rejects.toThrow('inpaint requires a PNG mask')
  })
  service.repository.close()
})

test('兼容图片编辑入口一次提交单张候选并保持 Relay 载荷一致', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const service = await createService('compat-start-operation-single-candidate', gateway.fetchImpl)
  await withGateway(async () => {
    const source = await createFormalVersion(service)
    const submitted = await service.startOperation(source.project.id, {
      revision: source.project.revision,
      base_version_id: source.version_id,
      kind: 'edit',
      instruction: '只替换背景，不修改主体与品牌信息',
    })
    expect(submitted.status).toBe('queued')
    const operation = await service.getOperation(submitted.id)
    expect(operation.status).toBe('succeeded')
    expect(operation.image_operation?.output_count).toBe(1)
    expect(operation.result).toMatchObject({ output_count: 1 })
    const post = gateway.calls
      .filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
      .at(-1)
    expect(post?.body).toMatchObject({ mode: 'edit', n: 1, size: '1024x1024' })
  })
  service.repository.close()
})

test('15.5B Version -> Edit/Inpaint reuses the formal Round path with source-bound estimates and relay recovery facts', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  let now = new Date(at)
  const gateway = gatewayFixture(png)
  const service = new ImageWorkbenchService({
    root: await testRoot('15b-version-derivation'),
    legacyMediaRoot: await testRoot('15b-version-derivation-legacy'),
    now: () => now,
    fetchImpl: gateway.fetchImpl,
  })
  const capability = '15bversionderivationcapability000000000'
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  await withGateway(async () => {
    const source = await createFormalVersion(service)
    const path = `/api/images/projects/${source.project.id}/versions/${source.version_id}/derivations`
    const headers = { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability }
    const unauthorisedUrl = new URL(`${path}/estimate`, 'http://127.0.0.1:3456')
    const unauthorised = await handler(new Request(unauthorisedUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }), unauthorisedUrl, unauthorisedUrl.pathname.split('/').filter(Boolean))
    expect(unauthorised.status).toBe(403)
    const mismatchedMask = `data:image/png;base64,${(await sharp({
      create: { width: 2, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    }).png().toBuffer()).toString('base64')}`
    const invalidMask = await request(handler, `${path}/estimate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: source.project.revision,
        instruction: '仅替换背景',
        kind: 'inpaint',
        mask_data_url: mismatchedMask,
      }),
    })
    expect(invalidMask.status).toBe(400)

    const expiringEstimateResponse = await request(handler, `${path}/estimate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_revision: source.project.revision, instruction: '将背景改为浅灰色', kind: 'edit' }),
    })
    expect(expiringEstimateResponse.status).toBe(200)
    const expiringEstimate = await expiringEstimateResponse.json() as { estimate_hash: string; expires_at: string }
    now = new Date(Date.parse(expiringEstimate.expires_at) + 1)
    const expired = await request(handler, path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: source.project.revision,
        idempotency_key: 'bb-image-version-derive-expired-estimate-0001',
        instruction: '将背景改为浅灰色',
        kind: 'edit',
        estimate_hash: expiringEstimate.estimate_hash,
        confirm: true,
      }),
    })
    expect(expired.status).toBe(409)
    expect(await expired.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

    now = new Date(at)
    const estimateResponse = await request(handler, `${path}/estimate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_revision: source.project.revision, instruction: '将背景改为浅灰色', kind: 'edit' }),
    })
    expect(estimateResponse.status).toBe(200)
    const estimate = await estimateResponse.json() as { estimate_hash: string }
    const staleRevision = await request(handler, path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: source.project.revision - 1,
        idempotency_key: 'bb-image-version-derive-stale-revision-0001',
        instruction: '将背景改为浅灰色',
        kind: 'edit',
        estimate_hash: estimate.estimate_hash,
        confirm: true,
      }),
    })
    expect(staleRevision.status).toBe(409)
    expect(await staleRevision.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })
    const tampered = await request(handler, path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: source.project.revision,
        idempotency_key: 'bb-image-version-derive-tampered-estimate-0001',
        instruction: '改为夜景背景',
        kind: 'edit',
        estimate_hash: estimate.estimate_hash,
        confirm: true,
      }),
    })
    expect(tampered.status).toBe(409)
    expect(await tampered.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

    const command = {
      base_revision: source.project.revision,
      idempotency_key: 'bb-image-version-derive-edit-0001',
      instruction: '将背景改为浅灰色',
      kind: 'edit' as const,
      estimate_hash: estimate.estimate_hash,
      confirm: true as const,
    }
    const derivedResponse = await request(handler, path, { method: 'POST', headers, body: JSON.stringify(command) })
    expect(derivedResponse.status).toBe(202)
    const derived = await derivedResponse.json() as { round: { id: string }; operation: { id: string; base_version_id?: string; base_candidate_id?: string } }
    expect(derived.operation).toMatchObject({ base_version_id: source.version_id })
    expect(derived.operation.base_candidate_id).toBeUndefined()
    const persisted = await service.repository.getGenerationOperation(source.project.id, derived.operation.id)
    expect(persisted).toMatchObject({ base_version_id: source.version_id, kind: 'edit' })
    expect(persisted.base_candidate_id).toBeUndefined()
    expect(persisted.input_refs.asset_hashes).toContain(source.asset_hash)
    const transport = await service.repository.getOperation(persisted.transport_task_id!)
    expect(transport.image_operation).toMatchObject({ kind: 'edit', base_version_id: source.version_id })
    expect(transport.image_operation.base_candidate_asset_id).toBeUndefined()
    const editPost = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').at(-1)
    expect(editPost?.body).toMatchObject({ mode: 'edit', n: 1, images: [await dataUrl()] })
    const postsBeforeReplay = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').length
    const replay = await request(handler, path, { method: 'POST', headers, body: JSON.stringify(command) })
    expect(replay.status).toBe(202)
    expect((await replay.json() as { round: { id: string }; operation: { id: string } })).toMatchObject({ round: { id: derived.round.id }, operation: { id: derived.operation.id } })
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(postsBeforeReplay)
    const idempotencyConflict = await request(handler, path, {
      method: 'POST', headers, body: JSON.stringify({ ...command, instruction: '将背景改为深灰色' }),
    })
    expect(idempotencyConflict.status).toBe(409)
    expect(await idempotencyConflict.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(postsBeforeReplay)

    const completed = await service.getGenerationOperation(source.project.id, derived.operation.id)
    if (!completed.result || completed.result.kind !== 'candidate_group') throw new Error('expected Version derivation Candidate Group')
    const group = await service.getCandidateGroup(source.project.id, completed.result.candidate_group_id)
    expect(group.group.base_version_id).toBe(source.version_id)
    expect(group.candidates.every(candidate => candidate.derived_from_candidate_id === undefined)).toBeTrue()

    const current = await service.getProject(source.project.id)
    const mask = await dataUrl()
    const inpaintEstimateResponse = await request(handler, `${path}/estimate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: current.revision,
        instruction: '仅局部替换背景',
        kind: 'inpaint',
        mask_data_url: mask,
      }),
    })
    expect(inpaintEstimateResponse.status).toBe(200)
    const inpaintEstimate = await inpaintEstimateResponse.json() as { estimate_hash: string }
    const inpaint = await request(handler, path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: current.revision,
        idempotency_key: 'bb-image-version-derive-inpaint-0001',
        instruction: '仅局部替换背景',
        kind: 'inpaint',
        mask_data_url: mask,
        estimate_hash: inpaintEstimate.estimate_hash,
        confirm: true,
      }),
    })
    expect(inpaint.status).toBe(202)
    const inpaintPayload = await inpaint.json() as { operation: { id: string; base_version_id?: string; mask_asset_id?: string } }
    expect(inpaintPayload.operation).toMatchObject({ base_version_id: source.version_id, mask_asset_id: expect.stringMatching(/^mask_/) })
    const inpaintPost = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').at(-1)
    expect(inpaintPost?.body).toMatchObject({ mode: 'edit', n: 1, images: [await dataUrl()], mask })
  })
  service.repository.close()
})

test('15.5B Version derivation recovers a persisted-before-POST Round once without re-submission', async () => {
  const root = await testRoot('15b-version-derivation-recovery')
  const legacyMediaRoot = await testRoot('15b-version-derivation-recovery-legacy')
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  let crashAfterVersionRound = false
  const first = new ImageWorkbenchService({
    root,
    legacyMediaRoot,
    now: () => new Date(at),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && crashAfterVersionRound) {
        crashAfterVersionRound = false
        throw new Error('INJECTED_VERSION_DERIVATION_BEFORE_POST')
      }
    },
  })
  await withGateway(async () => {
    const source = await createFormalVersion(first)
    const estimate = await first.estimateVersionDerivation(source.project.id, source.version_id, {
      base_revision: source.project.revision,
      instruction: '恢复后仍应只提交同一个正式版本编辑请求',
      kind: 'edit',
    })
    const command = {
      base_revision: source.project.revision,
      idempotency_key: 'bb-image-version-derive-recovery-0001',
      instruction: '恢复后仍应只提交同一个正式版本编辑请求',
      kind: 'edit' as const,
      estimate_hash: estimate.estimate_hash,
      confirm: true as const,
    }
    const postsBeforeCrash = gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').length
    crashAfterVersionRound = true
    await expect(first.deriveVersion(source.project.id, source.version_id, command)).rejects.toThrow('INJECTED_VERSION_DERIVATION_BEFORE_POST')
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(postsBeforeCrash)
    const roundId = `rnd_${createHash('sha256').update([source.project.id, 'derive', command.idempotency_key].join('\0')).digest('hex').slice(0, 32)}`
    const round = await first.repository.getGenerationRound(source.project.id, roundId)
    const pending = await first.repository.getGenerationOperation(source.project.id, round.direction_operations[0]!.operation_id)
    const pendingTransport = await first.repository.getOperation(pending.transport_task_id!)
    expect(pending).toMatchObject({ status: 'queued', base_version_id: source.version_id })
    expect(pendingTransport.image_operation).toMatchObject({ base_version_id: source.version_id })
    expect(pendingTransport.remote_task_id).toBeUndefined()
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot, now: () => new Date(at), fetchImpl: gateway.fetchImpl })
    await recovered.applications.recovery.recoverInterruptedOperations()
    const resumed = await recovered.repository.getGenerationOperation(source.project.id, pending.id)
    expect(resumed).toMatchObject({ status: 'queued', base_version_id: source.version_id, remote_task_id: 'relay_task_0001' })
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(postsBeforeCrash + 1)
    await recovered.applications.recovery.recoverInterruptedOperations()
    const replay = await recovered.deriveVersion(source.project.id, source.version_id, command)
    expect(replay.operation.id).toBe(pending.id)
    expect(gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(postsBeforeCrash + 1)
    recovered.repository.close()
  })
})
