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

test('media API migrates a legacy task-owned project into the standalone workbench', async () => {
  root = await mkdtemp(join(tmpdir(), 'billiardbuddy-media-api-'))
  const service = new MediaProjectService({ root })
  const handler = createMediaApiHandler(service)
  const project = await service.createImageProject({ prompt: '任务海报' })
  await writeFile(join(root, 'projects', `${project.id}.json`), `${JSON.stringify({
    ...project,
    product_task_id: 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb',
    owner: {
      kind: 'product_task',
      owner_id: 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb',
    },
  }, null, 2)}\n`)

  const response = await route(handler, `/api/media/project/${project.id}`)
  const body = await response.json() as { project?: { id: string } }
  const listed = await route(handler, '/api/media/projects')
  const listedBody = await listed.json() as { projects: Array<{ id: string }> }

  expect(response.status).toBe(200)
  expect(body.project?.id).toBe(project.id)
  expect(listedBody.projects).toContainEqual(expect.objectContaining({ id: project.id }))
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
  const createdBody = await created.json() as {
    project: {
      id: string
      revision: number
      reference_images: string[]
      reference_image_count: number
      references: Array<{ asset_id: string; role: string; image_path: string; mime_type: string }>
    }
  }
  expect(createdBody.project.reference_images).toEqual([])
  expect(createdBody.project.reference_image_count).toBe(1)
  expect(createdBody.project.references).toEqual([expect.objectContaining({
    role: 'subject',
    image_path: expect.stringMatching(new RegExp(`^/api/media/images/projects/${createdBody.project.id}/references/ref_.+/content$`)),
    mime_type: 'image/png',
  })])
  const referenceResponse = await route(handler, createdBody.project.references[0]!.image_path)
  expect(referenceResponse.status).toBe(200)
  expect(Buffer.from(await referenceResponse.arrayBuffer()).toString()).toBe('reference-bytes')

  const listed = await route(handler, '/api/media/projects?kind=image')
  expect(JSON.stringify(await listed.json())).not.toContain('reference-bytes')

  const updated = await route(handler, `/api/media/images/projects/${createdBody.project.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: createdBody.project.revision,
      user_request: '修改后的海报',
      size: '1024x1536',
      references: [{
        asset_id: createdBody.project.references[0]!.asset_id,
        role: 'style',
      }],
      new_reference_images: [`data:image/png;base64,${Buffer.from('new-reference-bytes').toString('base64')}`],
      new_reference_roles: ['brand'],
    }),
  })
  const updatedBody = await updated.json() as {
    project: { revision: number; references: Array<{ role: string; image_path: string }> }
  }
  expect(updatedBody.project.references.map(referenceItem => referenceItem.role)).toEqual(['style', 'brand'])
  const addedReference = updatedBody.project.references.find(referenceItem => referenceItem.role === 'brand')
  expect(addedReference).toBeDefined()
  expect(updatedBody).toMatchObject({
    project: {
      brief: { user_request: '修改后的海报' },
      size: '1024x1536',
      candidate_count: 3,
      reference_image_count: 2,
      references: [
        expect.objectContaining({ role: 'style' }),
        expect.objectContaining({ role: 'brand' }),
      ],
    },
  })
  expect(Buffer.from(await (await route(handler, addedReference!.image_path)).arrayBuffer()).toString()).toBe('new-reference-bytes')

  const removed = await route(handler, `/api/media/images/projects/${createdBody.project.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: updatedBody.project.revision,
      user_request: '不再使用参考素材',
      size: '1024x1536',
      references: [],
    }),
  })
  expect(await removed.json()).toMatchObject({
    project: { reference_image_count: 0, references: [], mode: 'generate' },
  })
  expect((await route(handler, createdBody.project.references[0]!.image_path)).status).toBe(404)
  expect((await route(handler, addedReference!.image_path)).status).toBe(404)

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

test('media API exposes owner-scoped cursor events without provider polling hints or private task fields', async () => {
  const now = '2026-07-26T00:00:00.000Z'
  const service = {
    async assertProjectOwner(projectId: string) {
      expect(projectId).toBe('img_events001')
    },
    async waitForJobEvents(
      projectId: string,
      cursor: number,
      limit: number,
      waitMs: number,
      signal: AbortSignal,
    ) {
      expect({ projectId, cursor, limit, waitMs, aborted: signal.aborted }).toEqual({
        projectId: 'img_events001', cursor: 7, limit: 25, waitMs: 0, aborted: false,
      })
      return {
        cursor: 8,
        reset_required: false,
        events: [{
          schema_version: 1 as const,
          cursor: 8,
          project_id: projectId,
          task_id: 'task_events001',
          operation_id: 'op_events000001',
          status_sequence: 3,
          occurred_at: now,
          task: {
            schema_version: 1 as const,
            id: 'task_events001',
            project_id: projectId,
            operation_id: 'op_events000001',
            owner: { kind: 'standalone' as const, owner_id: 'local_workbench' as const },
            attempt: 2,
            kind: 'image.generate' as const,
            status: 'running' as const,
            status_sequence: 3,
            progress: 40,
            stage: '生成中',
            poll_after_seconds: 30,
            image_operation: { kind: 'generate' as const, model: 'gpt-image-2' as const, output_count: 3 },
            created_at: now,
            updated_at: now,
          },
        }],
      }
    },
  } as unknown as MediaProjectService
  const handler = createMediaApiHandler(service)
  const response = await route(handler, '/api/media/projects/img_events001/events?cursor=7&limit=25&wait_ms=0')
  const body = await response.json() as Record<string, unknown>

  expect(response.status).toBe(200)
  expect(body).toMatchObject({
    cursor: 8,
    reset_required: false,
    events: [{ task: { status: 'running', status_sequence: 3, progress: 40 } }],
  })
  expect(JSON.stringify(body)).not.toContain('local_workbench')
  expect(JSON.stringify(body)).not.toContain('poll_after_seconds')
  expect(JSON.stringify(body)).not.toContain('image_operation')
  expect(JSON.stringify(body)).not.toContain('attempt')
})

test('media API starts an owner-scoped video preview without exposing private task fields', async () => {
  const calls: unknown[] = []
  const handler = createMediaApiHandler({
    async assertProjectOwner(projectId: string) {
      expect(projectId).toBe('vid_preview01')
      return {} as never
    },
    async previewVideo(projectId: string, input: unknown) {
      calls.push({ projectId, input })
      return {
        schema_version: 1,
        id: 'task_preview01',
        project_id: projectId,
        operation_id: 'op_preview00001',
        owner: { kind: 'standalone', owner_id: 'local_workbench' },
        attempt: 1,
        kind: 'video.preview',
        status: 'queued',
        status_sequence: 1,
        progress: 0,
        stage: '等待生成预览',
        result: {
          preview_revision: 3,
          timeline_version_id: 'timeline_preview01',
          asset_id: 'preview_asset001',
          asset_path: '/api/media/assets/vid_preview01/preview_asset001.mp4',
        },
        created_at: '2026-07-26T00:00:00.000Z',
        updated_at: '2026-07-26T00:00:00.000Z',
      }
    },
  } as unknown as MediaProjectService)
  const response = await route(handler, '/api/media/videos/projects/vid_preview01/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_revision: 3, timeline_version_id: 'timeline_preview01' }),
  })
  const body = await response.json() as { task: Record<string, unknown> }
  expect(response.status).toBe(202)
  expect(calls).toEqual([{ projectId: 'vid_preview01', input: { base_revision: 3, timeline_version_id: 'timeline_preview01' } }])
  expect(body.task).toMatchObject({ kind: 'video.preview', status: 'queued' })
  expect(body.task).not.toHaveProperty('owner')
  expect(body.task).not.toHaveProperty('attempt')
})

test('remote media actions, local source import, and final export require the Electron-owned UI capability', async () => {
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
  const deniedSource = await route(handler, '/api/media/videos/projects/vid_project01/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/tmp/source.mp4' }),
  })
  expect(deniedSource.status).toBe(403)
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
