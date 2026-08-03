import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { ContentAddressedStore } from '../src/server/media/kernel/assets/contentAddressedStore.js'
import { PayloadCommitProtocol } from '../src/server/media/kernel/storage/payloadCommitProtocol.js'
import { SqliteUnitOfWork, SqliteUnitOfWorkError } from '../src/server/media/kernel/storage/sqliteUnitOfWork.js'
import { analyzeVideoEvidence, planVideoTimeline } from '../src/server/services/videoAnalysis.js'
import { VideoWorkbenchRepository } from '../src/server/services/videoWorkbenchRepository.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import {
  type MediaTask,
  type VideoEvidence,
  type VideoSource,
  type VideoStudioProject,
} from '../shared/contracts/media.js'

const roots: string[] = []
const at = '2026-08-03T00:00:00.000Z'

async function testRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `billiardbuddy-${label}-`))
  roots.push(root)
  return root
}

function mediaProcessRunner(command: string[]) {
  if (command.includes('-version') || command.includes('-encoders')) {
    return Promise.resolve({ exitCode: 0, stdout: 'mpeg4', stderr: '' })
  }
  if (command.includes('-show_format') && command.includes('-show_streams')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        format: { duration: '2.000' },
        streams: [
          { codec_type: 'video', width: 640, height: 360, avg_frame_rate: '30/1' },
          { codec_type: 'audio' },
        ],
      }),
      stderr: '',
    })
  }
  const output = command.at(-1)
  if (!output) return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'missing output' })
  return mkdir(join(output, '..'), { recursive: true })
    .then(async () => await writeFile(output, 'simulated-media-output'))
    .then(() => ({ exitCode: 0, stdout: '', stderr: '' }))
}

async function waitForTerminalOperation(service: VideoWorkbenchService, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await service.getOperation(operationId)
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return operation
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`operation ${operationId} did not settle`)
}

function project(id = 'vid_00000001'): VideoStudioProject {
  return {
    schema_version: 1,
    id,
    kind: 'video',
    title: '测试项目',
    owner: { kind: 'standalone', owner_id: 'local_workbench' },
    writer_fence: `fence_${'0'.repeat(32)}`,
    assets: [],
    versions: [],
    revision: 0,
    created_at: at,
    updated_at: at,
    state: 'draft',
    sources: [],
    timeline: [],
    evidence: [],
    timeline_versions: [],
    alternatives: [],
    output: { width: 1080, height: 1920, fps: 30 },
  }
}

function operation(projectId: string, status: MediaTask['status'] = 'queued', statusSequence = 0): MediaTask {
  return {
    schema_version: 1,
    id: 'task_00000001',
    operation_id: 'op_00000001',
    project_id: projectId,
    kind: 'video.probe',
    status,
    status_sequence: statusSequence,
    progress: status === 'succeeded' ? 100 : 0,
    stage: status === 'succeeded' ? '完成' : '等待处理',
    created_at: at,
    updated_at: at,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

test('Video Repository uses SQLite as the only new writer and publishes durable events', async () => {
  const root = await testRoot('repository')
  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  const created = await repository.saveProject(project())
  expect(created.writer_fence).not.toBe(project().writer_fence)
  expect(await Bun.file(join(root, 'metadata.sqlite')).exists()).toBeTrue()
  expect(await Bun.file(join(root, 'projects', `${created.id}.json`)).exists()).toBeFalse()
  await expect(repository.saveProject({ ...project(), title: '过期写入' })).rejects.toMatchObject({
    code: 'VIDEO_WRITER_FENCE_CONFLICT',
  })

  const queued = await repository.saveOperation(operation(created.id))
  const succeeded = await repository.saveOperation({ ...queued, status: 'succeeded', progress: 100, stage: '完成' })
  const events = await repository.listOperationEvents(created.id, 0, 10)
  expect(events.reset_required).toBeFalse()
  expect(events.events.map(event => event.operation.status)).toEqual(['queued', 'succeeded'])
  expect(events.events.map(event => event.status_sequence)).toEqual([1, 2])
  expect(succeeded.operation_id).toBe('op_00000001')
  repository.close()

  const reopened = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  expect((await reopened.getProject(created.id)).title).toBe('测试项目')
  expect((await reopened.getOperation(queued.id)).status).toBe('succeeded')
  expect((await reopened.listOperationEvents(created.id, 0, 10)).events).toHaveLength(2)
  reopened.close()
})

test('payload protocol recovers every durable crash point without exposing uncommitted data', async () => {
  const stages: Array<{ label: string; state: 'staging' | 'payload_ready' | 'prepared' | 'published' | 'committed'; expectsReady: boolean; expectsAbandoned: boolean }> = [
    { label: 'staging-row-before-file', state: 'staging', expectsReady: false, expectsAbandoned: true },
    { label: 'payload-ready-before-prepare', state: 'payload_ready', expectsReady: false, expectsAbandoned: true },
    { label: 'prepared-before-publish', state: 'prepared', expectsReady: true, expectsAbandoned: false },
    { label: 'published-before-sqlite-commit', state: 'published', expectsReady: true, expectsAbandoned: false },
    { label: 'sqlite-commit-complete', state: 'committed', expectsReady: false, expectsAbandoned: false },
  ]
  for (const stage of stages) {
    const root = await testRoot(`payload-${stage.label}`)
    const first = new SqliteUnitOfWork(root)
    const protocol = new PayloadCommitProtocol(root, first, () => new Date(at))
    const staged = await protocol.stage({
      entityKind: 'test_payload',
      aggregateId: stage.label,
      finalLocator: `projects/vid_00000001/payloads/testing/${stage.label}.json`,
      schema: 'test-v1',
      version: 1,
      value: { stage: stage.label },
    })
    let intent = staged
    if (stage.state === 'staging') {
      first.transaction(() => first.database.query("UPDATE media_commit_intents SET state='staging' WHERE id=?").run(intent.id))
    }
    if (['prepared', 'published', 'committed'].includes(stage.state)) intent = protocol.prepare(intent.id, () => undefined)
    if (['published', 'committed'].includes(stage.state)) await protocol.publish(intent)
    if (stage.state === 'committed') first.transaction(() => protocol.markCommitted(intent.id))
    const finalPath = protocol.pathFor(intent.final_locator)
    if (stage.state !== 'published' && stage.state !== 'committed') expect(await Bun.file(finalPath).exists()).toBeFalse()
    first.close()

    const restarted = new SqliteUnitOfWork(root)
    const recovered = new PayloadCommitProtocol(root, restarted, () => new Date(at))
    const recovery = await recovered.recover()
    expect(recovery.readyToCommit.map(candidate => candidate.id)).toEqual(stage.expectsReady ? [intent.id] : [])
    expect(recovery.abandoned.map(candidate => candidate.id)).toEqual(stage.expectsAbandoned ? [intent.id] : [])
    expect(await Bun.file(recovered.pathFor(intent.final_locator)).exists()).toBe(stage.expectsReady || stage.state === 'committed')
    restarted.close()
  }
})

test('SQLite corruption and an interrupted schema migration fail closed without advancing the schema marker', async () => {
  const corruptRoot = await testRoot('sqlite-corrupt')
  await writeFile(join(corruptRoot, 'metadata.sqlite'), 'not a sqlite database')
  let corruptError: unknown
  try {
    new SqliteUnitOfWork(corruptRoot)
  } catch (error) {
    corruptError = error
  }
  expect(corruptError).toBeInstanceOf(SqliteUnitOfWorkError)
  expect((corruptError as SqliteUnitOfWorkError).code).toBe('MEDIA_SQLITE_CORRUPT')

  const migrationRoot = await testRoot('sqlite-migration-failure')
  const seed = new Database(join(migrationRoot, 'metadata.sqlite'))
  seed.exec(`CREATE TABLE media_kernel_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO media_kernel_schema_migrations(version,applied_at) VALUES(1, '${at}');
    CREATE TABLE media_outbox_events(cursor INTEGER PRIMARY KEY, intent_id TEXT);
    CREATE TABLE media_outbox_events_v1(conflict INTEGER);`)
  seed.close()
  let migrationError: unknown
  try {
    new SqliteUnitOfWork(migrationRoot)
  } catch (error) {
    migrationError = error
  }
  expect(migrationError).toBeInstanceOf(SqliteUnitOfWorkError)
  expect((migrationError as SqliteUnitOfWorkError).code).toBe('MEDIA_SQLITE_UNAVAILABLE')
  const inspected = new Database(join(migrationRoot, 'metadata.sqlite'), { readonly: true })
  expect(inspected.query('SELECT version FROM media_kernel_schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }])
  inspected.close()
})

test('ContentAddressedStore inspects a large file with a streaming SHA-256', async () => {
  const root = await testRoot('streaming-cas')
  const file = join(root, 'large-video.bin')
  const bytes = Buffer.alloc(9 * 1024 * 1024, 0x5a)
  await writeFile(file, bytes)
  const inspected = await new ContentAddressedStore().inspect(file)
  expect(inspected).toEqual({
    content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byte_size: bytes.byteLength,
  })
})

test('legacy JSON keeps Timeline and formal Export, status_sequence and cursor/next_cursor while the reader stays read-only', async () => {
  const root = await testRoot('legacy')
  await Promise.all([
    mkdir(join(root, 'projects'), { recursive: true }),
    mkdir(join(root, 'operations'), { recursive: true }),
    mkdir(join(root, 'events'), { recursive: true }),
  ])
  const sourceFingerprint = `sha256:${'a'.repeat(64)}`
  const outputFingerprint = `sha256:${'b'.repeat(64)}`
  const legacyProject = {
    ...project(),
    sources: [{
      id: 'source_00000001',
      path: '/legacy/source.mp4',
      name: 'source.mp4',
      duration_ms: 2_000,
      width: 640,
      height: 360,
      has_audio: true,
      fingerprint: sourceFingerprint,
    }],
    timeline: [{ id: 'clip_00000001', source_id: 'source_00000001', in_ms: 100, out_ms: 1_900 }],
    timeline_versions: [{
      id: 'timeline_00000001',
      project_revision: 7,
      evidence_revision: sourceFingerprint,
      scenes: [{
        id: 'scene_00000001',
        source_id: 'source_00000001',
        in_ms: 100,
        out_ms: 1_900,
        story_role: 'hook' as const,
        evidence_ids: [],
        rationale: '旧时间线',
        needs_review: false,
        locked: false,
      }],
      created_at: at,
    }],
    current_timeline_version_id: 'timeline_00000001',
    output_path: '/legacy/export.mp4',
    output_asset_id: 'asset_00000001',
    output_content_hash: outputFingerprint,
    output_verification: {
      timeline_version_id: 'timeline_00000001',
      byte_size: 123,
      duration_ms: 1_800,
      video_stream_count: 1,
      audio_stream_count: 1,
      content_hash: outputFingerprint,
      verified_at: at,
    },
  } satisfies VideoStudioProject
  const legacyOperation = operation(legacyProject.id, 'succeeded', 7)
  await writeFile(join(root, 'projects', `${legacyProject.id}.json`), JSON.stringify(legacyProject))
  await writeFile(join(root, 'operations', `${legacyOperation.id}.json`), JSON.stringify(legacyOperation))
  await writeFile(join(root, 'events', `${legacyProject.id}.json`), JSON.stringify({
    schema_version: 1,
    next_cursor: 43,
    events: [{
      schema_version: 1,
      cursor: 42,
      project_id: legacyProject.id,
      operation_id: legacyOperation.operation_id,
      status_sequence: 7,
      occurred_at: at,
      operation: legacyOperation,
    }],
  }))

  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  const migratedProject = await repository.getProject(legacyProject.id)
  expect(migratedProject.timeline).toEqual(legacyProject.timeline)
  expect(migratedProject.timeline_versions).toEqual(legacyProject.timeline_versions)
  expect(migratedProject.current_timeline_version_id).toBe(legacyProject.current_timeline_version_id)
  expect(migratedProject.output_verification).toEqual(legacyProject.output_verification)
  expect(migratedProject.output_content_hash).toBe(outputFingerprint)
  expect((await repository.getOperation(legacyOperation.id)).status_sequence).toBe(7)
  expect(await repository.listOperationEvents(legacyProject.id, 41, 10)).toMatchObject({
    cursor: 42,
    reset_required: false,
    events: [{ cursor: 42, status_sequence: 7 }],
  })
  expect(await repository.listOperationEvents(legacyProject.id, 0, 10)).toEqual({
    events: [],
    cursor: 42,
    reset_required: true,
  })
  const advanced = await repository.saveOperation({
    ...legacyOperation,
    status: 'failed',
    progress: 100,
    stage: '失败',
  })
  expect(advanced.status_sequence).toBe(8)
  expect(await repository.listOperationEvents(legacyProject.id, 42, 10)).toMatchObject({
    cursor: 43,
    reset_required: false,
    events: [{ cursor: 43, status_sequence: 8 }],
  })
  expect(repository.paths().operations).toBe(join(root, 'operations'))
  expect(repository.paths().events).toBe(join(root, 'events'))
  expect(await Bun.file(join(root, 'projects', `${legacyProject.id}.json`)).exists()).toBeTrue()
  expect(await Bun.file(join(root, 'operations', `${legacyOperation.id}.json`)).exists()).toBeTrue()
  expect(await Bun.file(join(root, 'events', `${legacyProject.id}.json`)).exists()).toBeTrue()
  repository.close()

  const reopened = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  expect((await reopened.getProject(legacyProject.id)).current_timeline_version_id).toBe('timeline_00000001')
  expect((await reopened.listOperationEvents(legacyProject.id, 42, 10)).events[0]?.cursor).toBe(43)
  reopened.close()
})

test('existing Gateway visual evidence and media reasoning features retain their protocol contract', async () => {
  const source: VideoSource = {
    id: 'source_00000001',
    path: '/legacy/source.mp4',
    name: 'source.mp4',
    duration_ms: 2_000,
    width: 640,
    height: 360,
    has_audio: true,
    fingerprint: `sha256:${'c'.repeat(64)}`,
    rotation: 0,
    video_stream_count: 1,
    audio_stream_count: 1,
    missing: false,
    content_changed: false,
  }
  const visualRequests: Array<{ url: string; headers: Headers }> = []
  const evidenceDraft = await analyzeVideoEvidence({
    sources: [source],
    existingEvidence: [],
    transcriptEvidence: [],
    frames: [{ source_id: source.id, in_ms: 100, data_url: 'data:image/png;base64,AA==' }],
    userGoal: '保留当前网关行为',
    extractionGaps: [],
  }, {
    operationId: 'op_00000001',
    env: { BB_GATEWAY_URL: 'https://gateway.example.test/', BB_GATEWAY_TOKEN: 'gateway-test-token' },
    fetchImpl: async (input, init) => {
      visualRequests.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({
        schema: 'bb.visual-evidence-batch.v1',
        evidence: [{
          schema: 'bb.visual-evidence.v1', ocr: '记分牌', objects: ['球桌'], layout: '', ui: [], alerts: [], observations: [],
        }],
      })
    },
  })
  expect(evidenceDraft.evidence).toHaveLength(1)
  expect(visualRequests).toHaveLength(1)
  expect(visualRequests[0]?.url).toBe('https://gateway.example.test/v1/visual/evidence')
  expect(visualRequests[0]?.headers.get('Authorization')).toBe('Bearer gateway-test-token')
  expect(visualRequests[0]?.headers.get('X-BB-Operation-ID')).toBe('op_00000001')

  const evidence: VideoEvidence = {
    id: 'evidence_00000001',
    kind: 'visual',
    source_id: source.id,
    source_fingerprint: source.fingerprint!,
    in_ms: 100,
    out_ms: 1_100,
    text: '记分牌和球桌',
    confidence: 0.8,
    created_at: at,
    warnings: [],
  }
  const reasoningRequests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const planned = await planVideoTimeline({
    sources: [source],
    evidence: [evidence],
    currentScenes: [],
    userGoal: '保留当前网关行为',
    analysisGaps: [],
  }, {
    operationId: 'op_00000002',
    env: { BB_GATEWAY_URL: 'https://gateway.example.test/', BB_GATEWAY_TOKEN: 'gateway-test-token' },
    fetchImpl: async (input, init) => {
      reasoningRequests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        brief: {
          content_type: '练球片段', output_channel: '短视频', must_preserve_text: [], recommended_direction: '保留开球', rationale: ['真实证据'], gaps: [],
        },
        scenes: [{
          source_id: source.id, in_ms: 100, out_ms: 1_100, story_role: 'hook', evidence_ids: [evidence.id], rationale: '真实证据', needs_review: false,
        }],
        alternatives: [],
      }) } }] })
    },
  })
  expect(planned.scenes).toHaveLength(1)
  expect(reasoningRequests[0]?.url).toBe('https://gateway.example.test/v1/media/reasoning')
  expect(reasoningRequests[0]?.headers.get('X-BB-Operation-ID')).toBe('op_00000002')
  expect(reasoningRequests[0]?.body.stream).toBeFalse()
})

test('legacy deleted project migrates from the old trash layout and can be restored', async () => {
  const root = await testRoot('legacy-trash')
  const legacyProject = project()
  const legacyOperation = operation(legacyProject.id, 'succeeded', 7)
  const deletion = {
    deletion_id: 'del_00000001',
    project_id: legacyProject.id,
    project_kind: 'video' as const,
    project_title: legacyProject.title,
    owner: legacyProject.owner,
    status: 'deleted' as const,
    deleted_at: at,
    purge_after: '2026-09-02T00:00:00.000Z',
    task_ids: [legacyOperation.id],
    managed_asset_count: 0,
    managed_asset_bytes: 0,
    trash_key: 'del_00000001',
  }
  await Promise.all([
    mkdir(join(root, 'trash', deletion.trash_key, 'operations'), { recursive: true }),
    mkdir(join(root, 'deletions'), { recursive: true }),
  ])
  await writeFile(join(root, 'trash', deletion.trash_key, 'project.json'), JSON.stringify(legacyProject))
  await writeFile(join(root, 'trash', deletion.trash_key, 'operations', `${legacyOperation.id}.json`), JSON.stringify(legacyOperation))
  await writeFile(join(root, 'trash', deletion.trash_key, 'events.json'), JSON.stringify({
    schema_version: 1,
    next_cursor: 43,
    events: [{
      schema_version: 1,
      cursor: 42,
      project_id: legacyProject.id,
      operation_id: legacyOperation.operation_id,
      status_sequence: 7,
      occurred_at: at,
      operation: legacyOperation,
    }],
  }))
  await writeFile(join(root, 'deletions', `${deletion.deletion_id}.json`), JSON.stringify(deletion))

  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  expect(await repository.listProjects()).toEqual([])
  expect((await repository.listDeletions())[0]?.deletion_id).toBe(deletion.deletion_id)
  const restored = await repository.restoreProject(legacyProject.id, legacyProject.owner)
  expect(restored.status).toBe('restored')
  expect((await repository.getProject(legacyProject.id)).id).toBe(legacyProject.id)
  expect(await Bun.file(join(root, 'trash', deletion.trash_key, 'project.json')).exists()).toBeTrue()
  expect(await Bun.file(join(root, 'trash', deletion.trash_key, 'operations', `${legacyOperation.id}.json`)).exists()).toBeTrue()
  expect((await repository.listOperationEvents(legacyProject.id, 41, 10)).events[0]?.cursor).toBe(42)
  repository.close()
})

test('project deletion and restore retain one SQLite history with recoverable file moves', async () => {
  const root = await testRoot('deletion')
  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  const created = await repository.saveProject(project())
  const deletion = await repository.deleteProject(created.id)
  expect(deletion.status).toBe('deleted')
  expect(await repository.listProjects()).toEqual([])
  expect((await stat(join(root, 'projects', created.id))).isDirectory()).toBeTrue()

  const restored = await repository.restoreProject(created.id, created.owner)
  expect(restored.status).toBe('restored')
  expect((await repository.getProject(created.id)).title).toBe('测试项目')
  repository.close()
})

test('restart recovery uses the durable operation store instead of in-memory execution state', async () => {
  const root = await testRoot('operation-recovery')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at) })
  const created = await service.repository.saveProject(project())
  const queued = await service.repository.saveOperation(operation(created.id))
  await service.recoverInterruptedOperations()
  expect((await service.getOperation(queued.id)).status).toBe('failed')
  expect((await service.listProjects())[0]?.id).toBe(created.id)
  service.repository.close()
})

test('existing import, timeline, preview and render paths stay durable through the SQLite repository', async () => {
  const root = await testRoot('video-production-path')
  const sourcePath = join(root, 'source.mp4')
  const outputPath = join(root, 'result.mp4')
  await writeFile(sourcePath, 'simulated-source')
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: mediaProcessRunner,
  })
  const created = await service.createProject({ title: '完整路径' })
  const imported = await service.addVideoSource(created.id, { path: sourcePath })
  expect(imported.task.status).toBe('succeeded')
  expect(imported.project.timeline).toHaveLength(1)
  const fingerprintTask = (await service.repository.listOperations(imported.project.id)).find(task => task.kind === 'video.fingerprint')
  expect(fingerprintTask).toBeDefined()
  expect((await waitForTerminalOperation(service, fingerprintTask!.id)).status).toBe('succeeded')
  const fingerprinted = await service.getProject(imported.project.id)
  expect(fingerprinted.sources[0]?.fingerprint).toMatch(/^sha256:/)
  await expect(service.analyzeVideoProject(imported.project.id, {
    base_revision: imported.project.revision - 1,
    user_goal: '不应以过期版本分析',
  })).rejects.toMatchObject({ code: 'VIDEO_REVISION_CONFLICT' })

  const edited = await service.updateTimeline(imported.project.id, {
    base_revision: fingerprinted.revision,
    base_timeline_version_id: fingerprinted.current_timeline_version_id,
    clips: fingerprinted.timeline,
  })
  expect(edited.current_editorial_timeline_version_id).not.toBe(fingerprinted.current_editorial_timeline_version_id)
  const selected = await service.selectTimelineVersion(imported.project.id, {
    revision: edited.revision,
    version_id: fingerprinted.current_timeline_version_id!,
  })
  expect(selected.current_timeline_version_id).toBe(fingerprinted.current_timeline_version_id)

  const preview = await service.previewVideo(selected.id, {
    base_revision: selected.revision,
    timeline_version_id: selected.current_timeline_version_id!,
  })
  expect((await waitForTerminalOperation(service, preview.id)).status).toBe('succeeded')
  const afterPreview = await service.getProject(selected.id)
  expect(afterPreview.preview?.asset_id).toBeDefined()

  const render = await service.renderVideo(afterPreview.id, {
    base_revision: afterPreview.revision,
    timeline_version_id: afterPreview.current_timeline_version_id,
    output_path: outputPath,
  })
  expect((await waitForTerminalOperation(service, render.id)).status).toBe('succeeded')
  expect(await Bun.file(outputPath).exists()).toBeTrue()
  expect((await service.getProject(selected.id)).state).toBe('complete')
  service.repository.close()
})

test('video API create path reaches the SQLite-backed repository', async () => {
  const root = await testRoot('api')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at) })
  const handler = createVideoWorkbenchDomainApiHandler(service)
  const request = new Request('http://localhost/api/videos/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '从 API 创建' }),
  })
  const response = await handler(request, new URL(request.url), ['api', 'videos', 'projects'])
  expect(response.status).toBe(201)
  const body = await response.json() as { project: { id: string; title: string } }
  expect(body.project.title).toBe('从 API 创建')
  expect((await service.getProject(body.project.id)).id).toBe(body.project.id)
  service.repository.close()
})
