import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEDIA_UI_CAPABILITY_HEADER } from '../../../shared/contracts/media.js'
import { consumeMediaUiCapability, createMediaApiHandler } from './media.js'
import { MediaProjectService, MediaServiceError } from '../services/mediaProjectService.js'

let root: string | null = null
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

function route(handler: ReturnType<typeof createMediaApiHandler>, path: string, init?: RequestInit) {
  const url = new URL(`http://local${path}`)
  return handler(new Request(url, init), url, url.pathname.split('/').filter(Boolean))
}

test('media API creates and lists image/video projects without invoking upstreams', async () => {
  root = await mkdtemp(join(tmpdir(), 'billiardbuddy-media-api-'))
  const handler = createMediaApiHandler(new MediaProjectService({ root }))
  const image = await route(handler, '/api/media/images/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '会员日海报' }),
  })
  expect(image.status).toBe(201)
  const imageBody = await image.json() as { project: Record<string, unknown> }
  expect(imageBody.project).toMatchObject({
    candidate_count: 3,
    brief: { user_request: '会员日海报' },
  })
  expect(imageBody.project).not.toHaveProperty('model')
  expect(imageBody.project).not.toHaveProperty('prompt')
  expect(imageBody.project).not.toHaveProperty('count')
  expect(imageBody.project).not.toHaveProperty('outputs')
  expect(imageBody.project).toMatchObject({ version_history: [] })
  const video = await route(handler, '/api/media/videos/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '活动集锦' }),
  })
  expect(video.status).toBe(201)
  const listed = await route(handler, '/api/media/projects')
  const body = await listed.json() as { projects: Array<{ kind: string }> }
  expect(body.projects.map(project => project.kind).sort()).toEqual(['image', 'video'])
  expect(JSON.stringify(body)).not.toContain('writer_fence')
  expect(JSON.stringify(body)).not.toContain('local_workbench')
})

test('media API keeps a product task owner private to task-scoped product routes', async () => {
  root = await mkdtemp(join(tmpdir(), 'billiardbuddy-media-api-'))
  const service = new MediaProjectService({ root })
  const handler = createMediaApiHandler(service)
  const project = await service.createImageProject({ prompt: '任务海报' })
  await service.attachProjectToProductTask(project.id, 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb')

  const response = await route(handler, `/api/media/project/${project.id}`)
  const body = await response.json() as { error?: string }
  const listed = await route(handler, '/api/media/projects')
  const listedBody = await listed.json() as { projects: Array<{ id: string }> }

  expect(response.status).toBe(404)
  expect(body.error).toBe('MEDIA_RESOURCE_UNAVAILABLE')
  expect(listedBody.projects).not.toContainEqual(expect.objectContaining({ id: project.id }))
  expect(JSON.stringify(body)).not.toContain('task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb')
})

test('media API returns structured validation errors', async () => {
  root = await mkdtemp(join(tmpdir(), 'billiardbuddy-media-api-'))
  const handler = createMediaApiHandler(new MediaProjectService({ root }))
  const response = await route(handler, '/api/media/images/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '' }),
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
})

test('media API projects persisted and thrown implementation errors into safe media failures', async () => {
  root = await mkdtemp(join(tmpdir(), 'billiardbuddy-media-api-'))
  const service = new MediaProjectService({ root })
  const handler = createMediaApiHandler(service)
  const rawDetail = 'gateway provider rejected token=private-token for /private/ffmpeg.log'
  const project = await service.createImageProject({ prompt: '安全错误投影' })
  await mkdir(join(root, 'tasks'), { recursive: true })
  await writeFile(join(root, 'projects', `${project.id}.json`), `${JSON.stringify({
    ...project,
    state: 'failed',
    error: rawDetail,
  })}\n`)
  await writeFile(join(root, 'tasks', 'task_rawerror.json'), `${JSON.stringify({
    schema_version: 1,
    id: 'task_rawerror',
    project_id: project.id,
    kind: 'video.render',
    status: 'failed',
    progress: 0,
    stage: '导出失败',
    error: rawDetail,
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
  })}\n`)

  const projectResponse = await route(handler, `/api/media/project/${project.id}`)
  const projectBody = await projectResponse.json() as { project: { error?: string; error_code?: string } }
  expect(projectResponse.status).toBe(200)
  expect(projectBody.project).toMatchObject({
    error: '图片生成暂时不可用，请稍后重试。',
    error_code: 'MEDIA_IMAGE_UNAVAILABLE',
  })
  expect(JSON.stringify(projectBody)).not.toContain(rawDetail)

  const taskResponse = await route(handler, '/api/media/tasks/task_rawerror')
  const taskBody = await taskResponse.json() as { task: { error?: string; error_code?: string } }
  expect(taskResponse.status).toBe(200)
  expect(taskBody.task).toMatchObject({
    error: '视频导出失败，请检查素材和导出位置后重试。',
    error_code: 'MEDIA_VIDEO_EXPORT_FAILED',
  })
  expect(JSON.stringify(taskBody)).not.toContain(rawDetail)

  const failingHandler = createMediaApiHandler({
    async assertProjectOwner() {
      throw new MediaServiceError(rawDetail, 503, 'GATEWAY_NOT_CONFIGURED')
    },
  } as unknown as MediaProjectService)
  const failingResponse = await route(failingHandler, '/api/media/project/img_project01')
  const failingBody = await failingResponse.json() as { error?: string; message?: string }
  expect(failingResponse.status).toBe(503)
  expect(failingBody).toEqual({
    error: 'MEDIA_IMAGE_UNAVAILABLE',
    message: '图片生成暂时不可用，请稍后重试。',
  })
  expect(JSON.stringify(failingBody)).not.toContain(rawDetail)
})

test('media API redacts reference image bytes, updates drafts, and deletes projects', async () => {
  root = await mkdtemp(join(tmpdir(), 'billiardbuddy-media-api-'))
  const handler = createMediaApiHandler(new MediaProjectService({ root }))
  const reference = `data:image/png;base64,${Buffer.from('reference-bytes').toString('base64')}`
  const created = await route(handler, '/api/media/images/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_request: '参考图海报', reference_images: [reference], reference_roles: ['subject'] }),
  })
  const createdBody = await created.json() as { project: { id: string; revision: number; reference_images: string[]; reference_image_count: number } }
  expect(createdBody.project.reference_images).toEqual([])
  expect(createdBody.project.reference_image_count).toBe(1)

  const listed = await route(handler, '/api/media/projects?kind=image')
  expect(JSON.stringify(await listed.json())).not.toContain('reference-bytes')

  const updated = await route(handler, `/api/media/images/projects/${createdBody.project.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: createdBody.project.revision,
      user_request: '修改后的海报',
      size: '1024x1536',
    }),
  })
  expect(await updated.json()).toMatchObject({
    project: {
      brief: { user_request: '修改后的海报' },
      size: '1024x1536',
      candidate_count: 3,
      reference_image_count: 1,
    },
  })

  const deleted = await route(handler, `/api/media/project/${createdBody.project.id}`, { method: 'DELETE' })
  expect(deleted.status).toBe(204)
  expect((await route(handler, `/api/media/project/${createdBody.project.id}`)).status).toBe(404)
  const deletionList = await route(handler, '/api/media/deletions')
  expect(await deletionList.json()).toMatchObject({
    deletions: [expect.objectContaining({ project_id: createdBody.project.id, status: 'deleted' })],
  })
  const restored = await route(handler, `/api/media/project/${createdBody.project.id}/restore`, { method: 'POST' })
  expect(restored.status).toBe(200)
  expect(await restored.json()).toMatchObject({ deletion: { status: 'restored' } })
  expect((await route(handler, `/api/media/project/${createdBody.project.id}`)).status).toBe(200)
})

test('media API reports toolchain availability without disclosing executable paths', async () => {
  const handler = createMediaApiHandler({
    async toolchainStatus() {
      return {
        ffmpeg: { available: true, command: '/Applications/BilliardBuddy.app/Contents/Resources/ffmpeg' },
        ffprobe: { available: false, command: '/private/var/folders/internal/ffprobe' },
      }
    },
  } as unknown as MediaProjectService)

  const response = await route(handler, '/api/media/videos/toolchain')
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toEqual({
    ffmpeg: { available: true },
    ffprobe: { available: false },
  })
  expect(JSON.stringify(body)).not.toContain('/Applications')
  expect(JSON.stringify(body)).not.toContain('/private')
})

test('paid image submission and final render require the Electron-owned UI capability', async () => {
  const capability = 'c'.repeat(43)
  const sidecarEnv = { BB_MEDIA_UI_CAPABILITY: capability }
  const capturedCapability = consumeMediaUiCapability(sidecarEnv)
  expect(sidecarEnv.BB_MEDIA_UI_CAPABILITY).toBeUndefined()
  const calls: string[] = []
  const now = '2026-07-24T00:00:00.000Z'
  const task = (id: string, projectId: string, kind: 'image.generate' | 'video.render') => ({
    schema_version: 1 as const,
    id,
    project_id: projectId,
    operation_id: `op_${'1'.repeat(32)}`,
    attempt: 1,
    kind,
    status: 'queued' as const,
    progress: 0,
    stage: '等待处理',
    created_at: now,
    updated_at: now,
  })
  const service = {
    async assertProjectOwner() {},
    async submitImageProject(projectId: string, input: { confirm_unknown_retry?: boolean }) {
      expect(input.confirm_unknown_retry).toBe(true)
      calls.push(`submit:${projectId}`)
      return task('task_image001', projectId, 'image.generate')
    },
    async startImageOperation(projectId: string) {
      calls.push(`operate:${projectId}`)
      return {
        ...task('task_image002', projectId, 'image.generate'),
        image_operation: {
          kind: 'edit', model: 'gpt-image-2', output_count: 1,
          base_version_id: 'ver_base0001', instruction: '只调整背景色',
        },
        result: {
          output_count: 1,
          outputs: [{ revised_prompt: 'private provider prompt' }],
        },
      }
    },
    async updateImageProject(projectId: string, input: { confirm_unknown_retry?: boolean }) {
      expect(input.confirm_unknown_retry).toBe(true)
      calls.push(`update:${projectId}`)
      return {
        schema_version: 1,
        id: projectId,
        kind: 'image',
        title: '图片项目',
        revision: 1,
        created_at: now,
        updated_at: now,
        state: 'draft',
        mode: 'generate',
        model: 'gpt-image-2',
        prompt: 'updated prompt',
        size: '1024x1024',
        count: 1,
        reference_images: [],
        reference_image_count: 0,
        outputs: [],
      }
    },
    async renderVideo(projectId: string) {
      calls.push(`render:${projectId}`)
      return task('task_video001', projectId, 'video.render')
    },
    async analyzeVideoProject(projectId: string) {
      calls.push(`analyze:${projectId}`)
      return task('task_analyze01', projectId, 'video.analyze')
    },
    async saveImageOutput(projectId: string, input: { output_id?: string; version_id?: string; output_path: string }) {
      calls.push(`save:${projectId}:${input.version_id ?? input.output_id}:${input.output_path}`)
      return { path: input.output_path }
    },
  } as unknown as MediaProjectService
  const handler = createMediaApiHandler(service, capturedCapability)

  const deniedSubmit = await route(handler, '/api/media/images/projects/img_project01/submit', { method: 'POST' })
  expect(deniedSubmit.status).toBe(403)
  expect(await deniedSubmit.json()).toMatchObject({ error: 'MEDIA_ACTION_NOT_ALLOWED' })
  const deniedRender = await route(handler, '/api/media/videos/projects/vid_project01/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 0, output_path: '/tmp/final.mp4' }),
  })
  expect(deniedRender.status).toBe(403)
  expect((await route(handler, '/api/media/videos/projects/vid_project01/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_revision: 0, user_goal: '剪成活动短片' }),
  })).status).toBe(403)
  const deniedOperation = await route(handler, '/api/media/images/projects/img_project01/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: 1,
      base_version_id: 'ver_base0001',
      kind: 'edit',
      instruction: '只调整背景色',
    }),
  })
  expect(deniedOperation.status).toBe(403)
  const deniedSave = await route(handler, '/api/media/images/projects/img_project01/outputs/out_result001/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ output_path: '/tmp/final.png' }),
  })
  expect(deniedSave.status).toBe(403)
  expect((await route(handler, '/api/media/images/projects/img_project01/versions/ver_result001/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ output_path: '/tmp/final.png' }),
  })).status).toBe(403)
  expect(calls).toEqual([])

  const deniedUnknownUpdate = await route(handler, '/api/media/images/projects/img_project01', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: 0,
      user_request: 'updated prompt',
      size: '1024x1024',
      confirm_unknown_retry: true,
    }),
  })
  expect(deniedUnknownUpdate.status).toBe(403)
  expect(await deniedUnknownUpdate.json()).toMatchObject({ error: 'MEDIA_ACTION_NOT_ALLOWED' })

  const headers = { [MEDIA_UI_CAPABILITY_HEADER]: capability }
  expect((await route(handler, '/api/media/images/projects/img_project01/submit', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm_unknown_retry: true }),
  })).status).toBe(202)
  const operationResponse = await route(handler, '/api/media/images/projects/img_project01/operations', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: 1,
      base_version_id: 'ver_base0001',
      kind: 'edit',
      instruction: '只调整背景色',
    }),
  })
  expect(operationResponse.status).toBe(202)
  const operationBody = await operationResponse.json()
  expect(operationBody).not.toHaveProperty('task.image_operation')
  expect(operationBody).not.toHaveProperty('task.result.outputs')
  expect(operationBody).toMatchObject({ task: { result: { output_count: 1 } } })
  expect((await route(handler, '/api/media/images/projects/img_project01', {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: 0,
      user_request: 'updated prompt',
      size: '1024x1024',
      confirm_unknown_retry: true,
    }),
  })).status).toBe(200)
  expect((await route(handler, '/api/media/videos/projects/vid_project01/render', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 0, output_path: '/tmp/final.mp4' }),
  })).status).toBe(202)
  expect((await route(handler, '/api/media/videos/projects/vid_project01/analyze', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ base_revision: 0, user_goal: '剪成活动短片' }),
  })).status).toBe(202)
  expect((await route(handler, '/api/media/images/projects/img_project01/outputs/out_result001/save', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ output_path: '/tmp/final.png' }),
  })).status).toBe(200)
  expect((await route(handler, '/api/media/images/projects/img_project01/versions/ver_result001/save', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ output_path: '/tmp/version.png' }),
  })).status).toBe(200)
  expect(calls).toEqual([
    'submit:img_project01',
    'operate:img_project01',
    'update:img_project01',
    'render:vid_project01',
    'analyze:vid_project01',
    'save:img_project01:out_result001:/tmp/final.png',
    'save:img_project01:ver_result001:/tmp/version.png',
  ])
})
