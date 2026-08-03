import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  options: { onAck?: () => Promise<void> | void; ackResponse?: () => Promise<Response> | Response } = {},
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
      return await options.ackResponse?.() ?? Response.json({ result_acknowledged: true })
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
    await recovered.recoverInterruptedOperations()
    expect(await recovered.getOperation(submitted.id)).toMatchObject({
      status: 'succeeded',
      remote_result_acknowledged_at: at,
    })
    expect(gateway.calls.filter(call => call.path === '/gw/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/images/tasks/relay_task_0001' && call.method === 'GET')).toHaveLength(2)
    expect(gateway.calls.filter(call => call.path.endsWith('/ack'))).toHaveLength(1)
    recovered.repository.close()
  })
})

test('15.1 injects a crash after SQLite commit and retries only Relay ACK on restart', async () => {
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
    expect((await first.getProject(project.id)).outputs).toHaveLength(3)
    expect(gateway.calls.filter(call => call.path.endsWith('/ack'))).toHaveLength(0)
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot: legacyRoot, now: () => new Date(at), fetchImpl: gateway.fetchImpl })
    await recovered.recoverInterruptedOperations()
    expect(await recovered.getOperation(submitted.id)).toMatchObject({ status: 'succeeded', remote_result_acknowledged_at: at })
    expect(gateway.calls.filter(call => call.path === '/gw/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/images/tasks/relay_task_0001' && call.method === 'GET')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path.endsWith('/ack'))).toHaveLength(1)
    recovered.repository.close()
  })
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
