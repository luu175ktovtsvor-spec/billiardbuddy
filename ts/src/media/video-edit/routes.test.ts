import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from '../../tasks/taskService'
import { createVideoEditRouteHandler } from './routes'
import { VideoEditingService } from './service'

function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

test('v2 route parses shared contracts and persists atomic operations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-routes-'))
  const source = join(root, 'source.mp4')
  writeFileSync(source, 'video')
  const service = new VideoEditingService({ stateRoot: root, tasks: new TaskService(root), env: { PATH: '', FFMPEG_BIN: '/missing', FFPROBE_BIN: '/missing', WHISPER_CLI: '/missing' } })
  const handler = createVideoEditRouteHandler(service)
  const createdResponse = await handler(new URL('http://127.0.0.1/api/v1/video-edit/projects'), request('/api/v1/video-edit/projects', 'POST', { video_paths: [source], source_roles: { [source]: 'space_wide' } }))
  expect(createdResponse?.status).toBe(201)
  const created = await createdResponse!.json() as any
  const id = created.project.project_id
  const compileResponse = await handler(new URL(`http://127.0.0.1/api/v1/video-edit/projects/${id}/brief/compile`), request(`/api/v1/video-edit/projects/${id}/brief/compile`, 'POST', { user_request: '展示真实环境', preferred_view: 'ambient' }))
  expect(compileResponse?.status).toBe(200)
  const current = await service.store.load(id)
  const opsResponse = await handler(new URL(`http://127.0.0.1/api/v1/video-edit/projects/${id}/ops`), request(`/api/v1/video-edit/projects/${id}/ops`, 'POST', {
    base_revision: current.revision,
    operations: [{ type: 'project.set_view', goal: 'talking' }],
  }))
  const ops = await opsResponse!.json() as any
  expect(ops.project.goal).toBe('talking')
  expect(ops.operation_id).toBeTruthy()
  const invalid = await handler(new URL(`http://127.0.0.1/api/v1/video-edit/projects/${id}/ops`), request(`/api/v1/video-edit/projects/${id}/ops`, 'POST', { base_revision: ops.project.revision, operations: [{ type: 'project.replace', project: {} }] }))
  expect(invalid?.status).toBe(400)
})

test('v2 project list migrates legacy projects before the renderer opens them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-routes-legacy-'))
  const source = join(root, 'source.mp4')
  writeFileSync(source, 'legacy-video')
  const dir = join(root, 'uploads', 'edits', 'legacy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify({
    version: 1, width: 1080, height: 1920, fps: 30,
    media: { m1: { src: source, duration: 2, kind: 'video', has_audio: true } },
    tracks: { v1: { kind: 'video', order: 0 } },
    clips: { c1: { track: 'v1', order: 0, media: 'm1', src_in: 0, src_out: 2 } },
  }))
  const service = new VideoEditingService({ stateRoot: root, tasks: new TaskService(root) })
  const handler = createVideoEditRouteHandler(service)
  const listed = await handler(new URL('http://127.0.0.1/api/v1/video-edit/projects'), request('/api/v1/video-edit/projects'))
  expect(await listed!.json()).toMatchObject({ projects: [expect.objectContaining({ project_id: 'legacy', schema_version: 2, migrated_from_v1: true })] })
  const opened = await handler(new URL('http://127.0.0.1/api/v1/video-edit/projects/legacy'), request('/api/v1/video-edit/projects/legacy'))
  expect(await opened!.json()).toMatchObject({ project: { project_id: 'legacy', schema_version: 2 } })
  expect(await handler(new URL('http://127.0.0.1/api/v1/video-edit/projects/missing'), request('/api/v1/video-edit/projects/missing'))).toBeNull()
})
