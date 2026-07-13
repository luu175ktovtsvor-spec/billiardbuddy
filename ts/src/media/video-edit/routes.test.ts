import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
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

test('v2 route leaves legacy project endpoints untouched until a project.json exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-routes-legacy-'))
  const service = new VideoEditingService({ stateRoot: root, tasks: new TaskService(root) })
  const handler = createVideoEditRouteHandler(service)
  expect(await handler(new URL('http://127.0.0.1/api/v1/video-edit/projects/legacy'), request('/api/v1/video-edit/projects/legacy'))).toBeNull()
  expect(await handler(new URL('http://127.0.0.1/api/v1/video-edit/projects/legacy/ops'), request('/api/v1/video-edit/projects/legacy/ops', 'POST', { operations: [] }))).toBeNull()
})
