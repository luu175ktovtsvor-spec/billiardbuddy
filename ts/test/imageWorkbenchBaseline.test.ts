import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayFetch } from '../../relay/app.ts'
import {
  imageWorkbenchProjectSchema,
  mediaJobEventJournalSchema,
  mediaSafeError,
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
    expect(formal?.result).toMatchObject({ kind: 'candidate_group', valid_count: 3 })
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

test('15.2 Gateway to Relay contract commits a Candidate Group before ACK and never auto-adopts it', async () => {
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
    expect(formal?.result).toMatchObject({ kind: 'candidate_group', expected_count: 3, valid_count: 3, invalid: [] })
    const executionReceipt = await service.repository.getExecutionReceipt(project.id, formal!.execution_receipt_id!)
    expect(executionReceipt).toMatchObject({
      capability: 'image_generation',
      registry_capability: 'ImageGeneration',
      idempotency_key: formal!.idempotency_key,
      request_hash: formal!.request_hash,
      input_asset_hashes: [],
      completed_at: at,
      output_asset_hashes: [expectedHash, expectedHash, expectedHash],
    })
    const group = await service.getCandidateGroup(project.id, formal!.result!.kind === 'candidate_group' ? formal.result.candidate_group_id : '')
    expect(group.candidates).toHaveLength(3)
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

    const compatibilityReplay = await service.submitProject(created.id)
    expect(compatibilityReplay.id).toBe(submitted.id)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)

    const delivery = await service.repository.currentDeliverySpec(project.id)
    const decisionCapability = 'fedcba9876543210fedcba9876543210'
    const decisionHandler = createImageWorkbenchDomainApiHandler(service, decisionCapability)
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
    const submitted = gateway.calls.find(call => call.path === '/gw/v1/images/tasks' && call.method === 'POST')
    expect(submitted?.body).toMatchObject({ mode: 'edit', n: 3, size: '1024x1024' })
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
      RELAY_TOKEN: 'relay-reference-control-token',
      RELAY_OPENAI_KEY: 'openai-reference-control-key',
      RELAY_OPENAI_BASE: 'https://provider.example.test/v1',
      RELAY_IMG_CONC: '1',
      RELAY_IMG_USER_CONC: '1',
    },
    fetchImpl: async (_input, init) => {
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      prompts.push(String(form.get('prompt')))
      resolveUpstream?.()
      return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
    },
  })
  const response = await relay(new Request('http://relay.example.test/images/tasks', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer relay-reference-control-token',
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

test('15.2 rejects capability gaps before paid submission, permits partial candidates, replays a Round and atomically adopts one Candidate to two Artboards', async () => {
  let paidPosts = 0
  const png = (await dataUrl()).split(',', 2)[1]!
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/gw/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: 'relay_task_partial', status: 'queued', provider_receipt_hash: 'b'.repeat(64) })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_partial' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({
        task_id: 'relay_task_partial',
        status: 'succeeded',
        provider_receipt_hash: 'b'.repeat(64),
        data: [
          { b64_json: png, mime_type: 'image/png' },
          { b64_json: 'not-valid-base64***', mime_type: 'image/png' },
        ],
      })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_partial/ack' && init?.method === 'POST') {
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
    const plan = await service.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-partial-plan-0001',
    })
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
    expect(completed.result).toMatchObject({ kind: 'candidate_group', expected_count: 3, valid_count: 1 })
    if (completed.result?.kind !== 'candidate_group') throw new Error('expected Candidate Group result')
    expect(completed.result.invalid).toHaveLength(2)
    const replay = await service.createGenerationRound(project.id, command)
    expect(replay.round.id).toBe(created.round.id)
    expect(paidPosts).toBe(1)

    const group = await service.getCandidateGroup(project.id, completed.result.candidate_group_id)
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
    if (url.pathname === '/gw/v1/images/tasks' && init?.method === 'POST') {
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
    if (url.pathname === '/gw/v1/images/tasks' && init?.method === 'POST') {
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
    expect(calls.filter(call => call.path === '/gw/v1/images/tasks' && call.method === 'POST')).toHaveLength(0)

    const roundId = `rnd_${createHash('sha256').update([project.id, command.idempotency_key].join('\0')).digest('hex').slice(0, 32)}`
    const round = await first.repository.getGenerationRound(project.id, roundId)
    const formal = await first.repository.getGenerationOperation(project.id, round.direction_operations[0]!.operation_id)
    const transport = await first.repository.getOperation(formal.transport_task_id!)
    expect(formal).toMatchObject({ status: 'queued', idempotency_key: transport.idempotency_key })
    expect(transport.remote_task_id).toBeUndefined()
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot, now: () => new Date(at), fetchImpl: gateway })
    await recovered.recoverInterruptedOperations()
    const resumed = await recovered.repository.getGenerationOperation(project.id, formal.id)
    const resumedTransport = await recovered.repository.getOperation(resumed.transport_task_id!)
    expect(resumed).toMatchObject({ status: 'queued', remote_task_id: 'relay_task_after_restart' })
    expect(resumedTransport.remote_task_id).toBe('relay_task_after_restart')
    const posts = calls.filter(call => call.path === '/gw/v1/images/tasks' && call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.headers.get('idempotency-key')).toBe(transport.idempotency_key)
    recovered.repository.close()
  })
})

test('15.2 recovers an outcome_unknown Generation Round through the original idempotency key', async () => {
  const root = await testRoot('round-outcome-unknown')
  const legacyMediaRoot = await testRoot('round-outcome-unknown-legacy')
  const calls: GatewayCall[] = []
  let submitCount = 0
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    calls.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    })
    if (url.pathname === '/gw/v1/images/tasks' && init?.method === 'POST') {
      submitCount += 1
      if (submitCount === 1) throw new Error('connection dropped after provider accepted the request')
      return Response.json({ task_id: 'relay_task_idempotent_recovery', status: 'queued', reused: true, provider_receipt_hash: 'e'.repeat(64) })
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
    expect(created.operations[0]).toMatchObject({ status: 'outcome_unknown' })
    const transport = await first.repository.getOperation(created.operations[0]!.transport_task_id!)
    expect(transport.outcome_unknown).toBeTrue()
    expect(transport.remote_task_id).toBeUndefined()
    first.repository.close()

    const recovered = new ImageWorkbenchService({ root, legacyMediaRoot, now: () => new Date(at), fetchImpl: gateway })
    await recovered.recoverInterruptedOperations()
    const resumed = await recovered.repository.getGenerationOperation(project.id, created.operations[0]!.id)
    expect(resumed).toMatchObject({ status: 'queued', remote_task_id: 'relay_task_idempotent_recovery' })
    const posts = calls.filter(call => call.path === '/gw/v1/images/tasks' && call.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]!.headers.get('idempotency-key')).toBe(posts[0]!.headers.get('idempotency-key'))
    recovered.repository.close()
  })
})

test('15.2 expires estimates and requires an explicit paid derivation confirmation', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  let now = new Date(at)
  let paidPosts = 0
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/gw/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: paidPosts === 1 ? 'relay_task_source' : 'relay_task_derivation', status: 'queued', provider_receipt_hash: 'f'.repeat(64) })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_source' && (init?.method ?? 'GET') === 'GET') {
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
  expect(estimate.price_upper_bound).toMatchObject({ currency: 'USD', amount_minor: expect.any(Number), usage_upper_bound: { requests: 1, output_images: 3 } })
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
    if (url.pathname === '/gw/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: paidPosts === 1 ? 'relay_task_conflict_source' : 'relay_task_conflict_derive', status: 'queued', provider_receipt_hash: '1'.repeat(64) })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_conflict_source' && (init?.method ?? 'GET') === 'GET') {
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
    const commandHandler = createImageWorkbenchDomainApiHandler(service, commandCapability)
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
    const plan = await service.createCreativePlan(initial.id, planCommand)
    expect((await service.createCreativePlan(initial.id, planCommand)).id).toBe(plan.id)
    const planIdempotencyConflict = {
      ...planCommand,
      directions: [{
        label: '冲突方向',
        rationale: '同一幂等键不能替换已有创作方向',
        generation_intent: { composition_goal: '产品居中', visual_tone: '冷色商业感' },
        preservation_rules: [],
      }],
    }
    await expect(service.createCreativePlan(initial.id, planIdempotencyConflict))
      .rejects.toMatchObject({ status: 409, code: 'IMAGE_IDEMPOTENCY_CONFLICT' })
    await expectPublicCommandConflict(`${projectPath}/creative-plans`, planIdempotencyConflict, 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT')
    const planRevisionConflict = {
      ...planCommand,
      base_revision: initial.revision,
      idempotency_key: 'bb-image-plan-revision-0001',
    }
    await expect(service.createCreativePlan(initial.id, planRevisionConflict))
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

test('15.2 retains a late successful result after a confirmed queued cancellation without auto-adopting it', async () => {
  const png = (await dataUrl()).split(',', 2)[1]!
  let paidPosts = 0
  let cancelled = false
  const gateway: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/gw/v1/images/tasks' && init?.method === 'POST') {
      paidPosts += 1
      return Response.json({ task_id: 'relay_task_cancel_late', status: 'queued', provider_receipt_hash: '3'.repeat(64) })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_cancel_late' && (init?.method ?? 'GET') === 'GET') {
      return Response.json(cancelled
        ? {
            task_id: 'relay_task_cancel_late',
            status: 'succeeded',
            provider_receipt_hash: '3'.repeat(64),
            data: [
              { b64_json: png, mime_type: 'image/png' },
              { b64_json: png, mime_type: 'image/png' },
              { b64_json: png, mime_type: 'image/png' },
            ],
          }
        : { task_id: 'relay_task_cancel_late', status: 'queued', provider_receipt_hash: '3'.repeat(64) })
    }
    if (url.pathname === '/gw/v1/images/tasks/relay_task_cancel_late/cancel' && init?.method === 'POST') {
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
    expect(completedLate).toMatchObject({ status: 'succeeded', result: { kind: 'candidate_group', valid_count: 3 } })
    if (completedLate.result?.kind !== 'candidate_group') throw new Error('expected retained Candidate Group')
    const retained = await service.getCandidateGroup(project.id, completedLate.result.candidate_group_id)
    expect(retained.candidates).toHaveLength(3)
    expect((await service.getProject(project.id)).current_versions_by_artboard).toEqual({})
    expect(paidPosts).toBe(1)
  })
})

test('15.2 API schema rejects invalid fixture and exposes only capability-gated, prompt-safe generation commands', async () => {
  const service = await createService('api')
  const capability = '0123456789abcdef0123456789abcdef'
  const handler = createImageWorkbenchDomainApiHandler(service, capability)

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
