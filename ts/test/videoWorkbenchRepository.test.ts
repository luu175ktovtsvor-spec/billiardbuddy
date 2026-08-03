import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { PayloadCommitProtocol } from '../src/server/media/kernel/storage/payloadCommitProtocol.js'
import { SqliteUnitOfWork } from '../src/server/media/kernel/storage/sqliteUnitOfWork.js'
import { VideoWorkbenchRepository } from '../src/server/services/videoWorkbenchRepository.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import {
  type MediaTask,
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

function operation(projectId: string, status: MediaTask['status'] = 'queued'): MediaTask {
  return {
    schema_version: 1,
    id: 'task_00000001',
    operation_id: 'op_00000001',
    project_id: projectId,
    kind: 'video.probe',
    status,
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

test('prepared payload is published after a process crash and never becomes visible before commit', async () => {
  const root = await testRoot('payload-recovery')
  const first = new SqliteUnitOfWork(root)
  const protocol = new PayloadCommitProtocol(root, first, () => new Date(at))
  const staged = await protocol.stage({
    entityKind: 'test_payload',
    aggregateId: 'aggregate',
    finalLocator: 'projects/vid_00000001/payloads/testing/payload.json',
    schema: 'test-v1',
    version: 1,
    value: { hello: 'world' },
  })
  const prepared = protocol.prepare(staged.id, () => undefined)
  expect(await Bun.file(protocol.pathFor(prepared.final_locator)).exists()).toBeFalse()
  first.close()

  const restarted = new SqliteUnitOfWork(root)
  const recoveredProtocol = new PayloadCommitProtocol(root, restarted, () => new Date(at))
  const recovery = await recoveredProtocol.recover()
  expect(recovery.readyToCommit.map(intent => intent.id)).toEqual([prepared.id])
  expect(await Bun.file(recoveredProtocol.pathFor(prepared.final_locator)).text()).toContain('"hello":"world"')
  restarted.close()
})

test('legacy JSON is imported once, then archived while the SQLite reader remains available', async () => {
  const root = await testRoot('legacy')
  await Promise.all([
    mkdir(join(root, 'projects'), { recursive: true }),
    mkdir(join(root, 'operations'), { recursive: true }),
    mkdir(join(root, 'events'), { recursive: true }),
  ])
  const legacyProject = project()
  const legacyOperation = operation(legacyProject.id, 'succeeded')
  await writeFile(join(root, 'projects', `${legacyProject.id}.json`), JSON.stringify(legacyProject))
  await writeFile(join(root, 'operations', `${legacyOperation.id}.json`), JSON.stringify(legacyOperation))
  await writeFile(join(root, 'events', `${legacyProject.id}.json`), JSON.stringify({
    schema_version: 1,
    next_cursor: 2,
    events: [{
      schema_version: 1,
      cursor: 1,
      project_id: legacyProject.id,
      operation_id: legacyOperation.operation_id,
      status_sequence: 1,
      occurred_at: at,
      operation: legacyOperation,
    }],
  }))

  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  expect((await repository.getProject(legacyProject.id)).id).toBe(legacyProject.id)
  expect((await repository.getOperation(legacyOperation.id)).status).toBe('succeeded')
  expect((await repository.listOperationEvents(legacyProject.id, 0, 10)).events).toHaveLength(1)
  expect(await Bun.file(join(root, 'legacy-import', 'projects', `${legacyProject.id}.json`)).exists()).toBeTrue()
  expect(await Bun.file(join(root, 'projects', `${legacyProject.id}.json`)).exists()).toBeFalse()
  repository.close()
})

test('legacy deleted project migrates from the old trash layout and can be restored', async () => {
  const root = await testRoot('legacy-trash')
  const legacyProject = project()
  const legacyOperation = operation(legacyProject.id, 'succeeded')
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
    next_cursor: 2,
    events: [{
      schema_version: 1,
      cursor: 1,
      project_id: legacyProject.id,
      operation_id: legacyOperation.operation_id,
      status_sequence: 1,
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
  expect(await Bun.file(join(root, 'legacy-import', 'trash', deletion.trash_key, 'project.json')).exists()).toBeTrue()
  repository.close()
})

test('project deletion and restore retain one SQLite history with recoverable file moves', async () => {
  const root = await testRoot('deletion')
  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  const created = await repository.saveProject(project())
  const deletion = await repository.deleteProject(created.id)
  expect(deletion.status).toBe('deleted')
  expect(await repository.listProjects()).toEqual([])
  expect((await stat(join(root, 'trash', deletion.trash_key, 'project'))).isDirectory()).toBeTrue()

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
  await expect(service.analyzeVideoProject(imported.project.id, {
    base_revision: imported.project.revision - 1,
    user_goal: '不应以过期版本分析',
  })).rejects.toMatchObject({ code: 'VIDEO_REVISION_CONFLICT' })

  const edited = await service.updateTimeline(imported.project.id, {
    base_revision: imported.project.revision,
    base_timeline_version_id: imported.project.current_timeline_version_id,
    clips: imported.project.timeline,
  })
  const selected = await service.selectTimelineVersion(imported.project.id, {
    revision: edited.revision,
    version_id: imported.project.current_timeline_version_id!,
  })
  expect(selected.current_timeline_version_id).toBe(imported.project.current_timeline_version_id)

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
