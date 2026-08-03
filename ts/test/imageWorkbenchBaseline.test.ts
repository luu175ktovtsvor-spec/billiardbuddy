import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  imageWorkbenchProjectSchema,
  mediaJobEventJournalSchema,
  mediaTaskSchema,
} from '../shared/contracts/media.js'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import type { ImageOperation } from '../src/server/services/imageWorkbenchRepository.js'

const roots: string[] = []
const at = '2026-08-03T00:00:00.000Z'
const gatewayUrl = 'https://gateway.example.test/gw'
const gatewayToken = 'baseline-gateway-token-0123456789abcdef'

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
  const previousToken = process.env.BB_GATEWAY_TOKEN
  process.env.BB_GATEWAY_URL = gatewayUrl
  process.env.BB_GATEWAY_TOKEN = gatewayToken
  try {
    return await action()
  } finally {
    if (previousUrl === undefined) delete process.env.BB_GATEWAY_URL
    else process.env.BB_GATEWAY_URL = previousUrl
    if (previousToken === undefined) delete process.env.BB_GATEWAY_TOKEN
    else process.env.BB_GATEWAY_TOKEN = previousToken
  }
}

type GatewayCall = { path: string; method: string; headers: Headers; body: unknown }

function gatewayFixture(
  png: string,
  options: { onAck?: () => Promise<void> | void } = {},
): { calls: GatewayCall[]; fetchImpl: typeof fetch } {
  const calls: GatewayCall[] = []
  const receipt = 'a'.repeat(64)
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const headers = new Headers(init?.headers)
    calls.push({ path: url.pathname, method, headers, body })
    if (url.pathname === '/gw/v1/images/tasks' && method === 'POST') {
      return Response.json({
        task_id: 'relay_task_0001',
        status: 'queued',
        poll_after_seconds: 1,
        provider_receipt_hash: receipt,
      })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_0001' && method === 'GET') {
      return Response.json({
        task_id: 'relay_task_0001',
        status: 'succeeded',
        provider_receipt_hash: receipt,
        data: [
          { b64_json: png, mime_type: 'image/png' },
          { b64_json: png, mime_type: 'image/png' },
          { b64_json: png, mime_type: 'image/png' },
        ],
      })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_0001/ack' && method === 'POST') {
      await options.onAck?.()
      return Response.json({ result_acknowledged: true })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_0001/cancel' && method === 'POST') {
      return Response.json({ status: 'cancelled' })
    }
    // Current visual quality reasoning is deliberately non-blocking.  The
    // production fixture records its failure without changing candidate facts.
    if (url.pathname.endsWith('/v1/media/reasoning')) return Response.json({ error: 'unavailable' }, { status: 503 })
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

async function createProject(service: ImageWorkbenchService) {
  return await service.createProject({
    title: '图片基线项目',
    user_request: '一张用于当前行为基线的产品宣传图',
    size: '1024x1024',
    reference_images: [],
    reference_roles: [],
  })
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
  return await handler(new Request(url, init), url, url.pathname.split('/').filter(Boolean))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

test('fixed legacy Project, Operation/Event and hash fixtures import idempotently while keeping writer fencing and CAS bytes reproducible', async () => {
  const legacyProject = imageWorkbenchProjectSchema.parse(await fixtureJson('legacy/project.json'))
  const legacyOperation = mediaTaskSchema.parse(await fixtureJson('legacy/operation.json')) as ImageOperation
  const legacyJournal = mediaJobEventJournalSchema.parse(await fixtureJson('legacy/event-journal.json'))
  const expectedBytes = await imageBytes()
  const expectedHash = await imageHash()
  expect(createHash('sha256').update(expectedBytes).digest('hex')).toBe(expectedHash.slice('sha256:'.length))
  expect(legacyJournal.events).toHaveLength(1)
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
    writeFile(join(legacyRoot, 'events', `${legacyProject.id}.json`), `${JSON.stringify(legacyJournal)}\n`),
  ])
  const target = new ImageWorkbenchService({ root: targetRoot, legacyMediaRoot: legacyRoot, now: () => new Date(at) })

  const firstImport = await target.migrateLegacyMediaStore()
  expect(firstImport.migrated_project_ids).toEqual([legacyProject.id])
  expect(await target.listProjects()).toHaveLength(1)
  expect(await target.assertProjectOwner(legacyProject.id)).toMatchObject({ owner: { kind: 'standalone', owner_id: 'local_workbench' } })
  expect(await target.getOperation(legacyOperation.id)).toMatchObject({ status: 'succeeded', operation_id: legacyOperation.operation_id })
  expect((await target.listOperationEvents(legacyProject.id, 0, 100)).events).toMatchObject([{ cursor: 1, operation_id: legacyOperation.operation_id }])
  expect((await target.migrateLegacyMediaStore()).skipped_project_ids).toEqual([legacyProject.id])

  const imported = await target.getProject(legacyProject.id)
  const importedAsset = imported.assets.find(asset => asset.id === 'out_legacy_fixture')
  expect(importedAsset?.content_hash).toBe(expectedHash)
  expect((await target.assets.readVerified(importedAsset!)).bytes.equals(expectedBytes)).toBeTrue()

  const firstWrite = await target.repository.saveProject(imported)
  const secondWrite = await target.repository.saveProject({ ...firstWrite, title: '更新后的基线项目' })
  await expect(target.repository.saveProject({ ...firstWrite, title: '过期写入' })).rejects.toMatchObject({
    code: 'IMAGE_WRITER_FENCE_CONFLICT',
  })
  expect(secondWrite.writer_fence).not.toBe(firstWrite.writer_fence)
})

test('current Gateway to Relay contract persists candidates before ACK, exposes event cursors and keeps generated candidates unselected', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const expectedBytes = await imageBytes()
  const expectedHash = await imageHash()
  let projectId = ''
  let service: ImageWorkbenchService
  const gateway = gatewayFixture(png, {
    onAck: async () => {
      const persisted = await service.getProject(projectId)
      expect(persisted.outputs).toHaveLength(3)
      expect(persisted.versions).toHaveLength(3)
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
    const created = await createProject(service)
    projectId = created.id
    const submitted = await service.submitProject(created.id)
    expect(submitted.remote_task_id).toBe('relay_task_0001')
    const completed = await service.getOperation(submitted.id)
    expect(completed.status).toBe('succeeded')
    expect(completed.remote_result_acknowledged_at).toBe(at)

    const project = await service.getProject(created.id)
    expect(project.outputs).toHaveLength(3)
    expect(project.versions).toHaveLength(3)
    expect(project.current_version_id).toBeUndefined()
    const page = await service.listOperationEvents(project.id, 0, 100)
    expect(page.events.map(event => event.cursor)).toEqual(page.events.map((_event, index) => index + 1))
    expect(page.events.at(-1)?.operation.status).toBe('succeeded')

    const post = gateway.calls.find(call => call.path === '/gw/v1/images/tasks')
    const poll = gateway.calls.find(call => call.path === '/gw/v1/images/tasks/relay_task_0001' && call.method === 'GET')
    const ack = gateway.calls.find(call => call.path.endsWith('/ack'))
    expect(post?.headers.get('idempotency-key')).toMatch(/^bb-image-/)
    expect(post?.body).toMatchObject({ mode: 'generate', n: 3, size: '1024x1024' })
    expect(poll?.headers.get('x-bb-media-result-handoff')).toBe('direct-v1')
    expect(ack?.method).toBe('POST')

    const adopted = await service.selectVersion(project.id, {
      revision: project.revision,
      version_id: project.versions[0]!.id,
    })
    expect(adopted.current_version_id).toBe(project.versions[0]!.id)
    const receipt = await service.deleteProject(project.id)
    expect(receipt.status).toBe('deleted')
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: 'IMAGE_PROJECT_NOT_FOUND' })
    expect((await service.restoreProject(project.id)).status).toBe('restored')
    expect((await service.getProject(project.id)).current_version_id).toBe(project.versions[0]!.id)
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
    expect(calls).toEqual([])
  })
})

test('current queued operation uses the Relay cancel contract and records a terminal cancellation event', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway = gatewayFixture(png)
  const service = await createService('cancel', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await createProject(service)
    const submitted = await service.submitProject(project.id)
    const cancelled = await service.cancelOperation(submitted.id)
    expect(cancelled.status).toBe('cancelled')
    // This preserves the current projection as a characteristic, not a target
    // state-machine decision for the later ImageOperation redesign.
    expect((await service.getProject(project.id)).state).toBe('failed')
    expect((await service.listOperationEvents(project.id, 0, 100)).events.at(-1)?.operation.status).toBe('cancelled')
    expect(gateway.calls.find(call => call.path.endsWith('/cancel'))?.headers.get('authorization')).toBe(`Bearer ${gatewayToken}`)
  })
})

test('current API schema rejects invalid fixture, forged owner fields, unauthorised paid submit and malformed event cursor', async () => {
  const service = await createService('api')
  const capability = '0123456789abcdef0123456789abcdef'
  const handler = createImageWorkbenchDomainApiHandler(service, capability)

  const invalidFixture = await request(handler, '/api/images/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_request: '损坏 fixture 必须失败',
      reference_images: [await brokenDataUrl()],
      reference_roles: ['subject'],
    }),
  })
  expect(invalidFixture.status).toBe(400)

  const created = await request(handler, '/api/images/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_request: 'API 合同基线',
      owner: { kind: 'forged', owner_id: 'not-accepted' },
    }),
  })
  expect(created.status).toBe(201)
  const payload = await created.json() as { project: { id: string; owner?: unknown; prompt?: unknown; model?: unknown } }
  expect(payload.project.owner).toBeUndefined()
  expect(payload.project.prompt).toBeUndefined()
  expect(payload.project.model).toBeUndefined()

  const unauthorised = await request(handler, `/api/images/projects/${payload.project.id}/submit`, { method: 'POST' })
  expect(unauthorised.status).toBe(403)
  const malformedCursor = await request(handler, `/api/images/projects/${payload.project.id}/events?cursor=-1`)
  expect(malformedCursor.status).toBe(400)
})
