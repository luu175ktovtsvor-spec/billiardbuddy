import { describe, expect, test } from 'bun:test'
import type { MediaProject, MediaTask } from '../../../shared/contracts/media.js'
import { MediaServiceError } from '../services/mediaProjectService.js'
import { ProductTaskMediaService } from './taskMediaService.js'

const TASK_ID = 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb'
const OTHER_TASK_ID = 'task_0123456789abcdef'

const mediaTask: MediaTask = {
  schema_version: 1,
  id: 'task_12345678',
  project_id: 'img_12345678',
  kind: 'image.generate',
  status: 'succeeded',
  progress: 100,
  stage: '生成完成',
  error: 'private upstream detail',
  created_at: '2026-07-19T00:00:00.000Z',
  updated_at: '2026-07-19T00:00:00.000Z',
}

function imageProject(owner: string | undefined, id = 'img_12345678'): MediaProject {
  return {
    schema_version: 1,
    id,
    kind: 'image',
    title: '会员日海报',
    workspace_root: '/private/workspace',
    ...(owner ? { product_task_id: owner } : {}),
    revision: 0,
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
    state: 'ready',
    mode: 'generate',
    model: 'gpt-image-2',
    prompt: 'private prompt',
    size: '1024x1024',
    count: 1,
    reference_images: [],
    reference_image_count: 0,
    task_id: mediaTask.id,
    outputs: [{
      id: 'out_12345678',
      mime_type: 'image/png',
      asset_path: `/api/media/assets/${id}/out_12345678.png`,
    }],
    error: 'private project error',
  }
}

function draftImageProject(id = 'img_87654321'): MediaProject {
  const project = imageProject(undefined, id)
  if (project.kind !== 'image') throw new Error('wrong project kind')
  return {
    ...project,
    state: 'draft',
    task_id: undefined,
    outputs: [],
    error: undefined,
  }
}

function ownerApi(shouldReject = false) {
  const calls: string[] = []
  return {
    calls,
    api: {
      getTask: async (taskId: string) => {
        calls.push(taskId)
        if (shouldReject) throw new Error('task missing')
        return {
          id: taskId,
          coreSessionId: 'core-session-private',
        }
      },
    },
  }
}

describe('ProductTaskMediaService', () => {
  test('validates the public task first and returns only its owned safe artifact projection', async () => {
    const owner = ownerApi()
    const owned = imageProject(TASK_ID)
    const other = imageProject(OTHER_TASK_ID, 'img_87654321')
    let listProjectsCalls = 0
    const taskReads: unknown[][] = []
    const service = new ProductTaskMediaService(owner.api as never, {
      listProjects: async () => {
        listProjectsCalls += 1
        return [other, owned]
      },
      getProject: async () => owned,
      getTask: async (...args) => {
        taskReads.push(args)
        return mediaTask
      },
      attachProjectToProductTask: async () => owned,
      availableImageOutputAssetPath: async (_projectId, path) => path,
    } as never)

    const result = await service.listForTask(TASK_ID)

    expect(owner.calls).toEqual([TASK_ID])
    expect(listProjectsCalls).toBe(1)
    expect(result).toEqual({
      taskId: TASK_ID,
      projects: [{
        id: owned.id,
        kind: 'image',
        title: owned.title,
        state: 'ready',
        updatedAt: owned.updated_at,
        mediaTask: {
          status: 'succeeded',
          progress: 100,
          stage: '生成完成',
          outcomeUnknown: false,
        },
        assets: [{
          id: 'out_12345678',
          kind: 'image',
          mimeType: 'image/png',
          url: `/api/product/tasks/${TASK_ID}/media/projects/${owned.id}/assets/out_12345678`,
        }],
      }],
    })
    expect(taskReads).toEqual([[mediaTask.id, true]])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('core-session-private')
    expect(serialized).not.toContain('/private/workspace')
    expect(serialized).not.toContain('/api/media/assets/')
    expect(serialized).not.toContain('private prompt')
    expect(serialized).not.toContain('private upstream detail')
  })

  test('does not enumerate media projects for an unknown task', async () => {
    const owner = ownerApi(true)
    let listProjectsCalls = 0
    const service = new ProductTaskMediaService(owner.api as never, {
      listProjects: async () => {
        listProjectsCalls += 1
        return []
      },
      getTask: async () => mediaTask,
      attachProjectToProductTask: async () => imageProject(TASK_ID),
      availableImageOutputAssetPath: async () => null,
    } as never)

    await expect(service.listForTask('task_ffffffffffffffff')).rejects.toThrow('task missing')
    expect(owner.calls).toEqual(['task_ffffffffffffffff'])
    expect(listProjectsCalls).toBe(0)
  })

  test('lists only unowned drafts as minimal explicit attach candidates', async () => {
    const owner = ownerApi()
    const draft = draftImageProject()
    const owned = imageProject(TASK_ID)
    const processedStandalone = imageProject(undefined, 'img_abcdefgh')
    const service = new ProductTaskMediaService(owner.api as never, {
      listProjects: async () => [owned, processedStandalone, draft],
      getTask: async () => mediaTask,
      attachProjectToProductTask: async () => draft,
      availableImageOutputAssetPath: async () => null,
    } as never)

    const result = await service.listAttachableForTask(TASK_ID)

    expect(result).toEqual({
      taskId: TASK_ID,
      projects: [{
        id: draft.id,
        kind: 'image',
        title: draft.title,
        state: 'draft',
        updatedAt: draft.updated_at,
      }],
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('/private/workspace')
    expect(serialized).not.toContain('private prompt')
    expect(serialized).not.toContain('out_12345678')
  })

  test('attaches through a validated public task id and still projects no local paths', async () => {
    const owner = ownerApi()
    const project = imageProject(TASK_ID)
    const attachCalls: Array<[string, string]> = []
    const service = new ProductTaskMediaService(owner.api as never, {
      listProjects: async () => [project],
      getProject: async () => project,
      getTask: async () => mediaTask,
      attachProjectToProductTask: async (projectId, taskId) => {
        attachCalls.push([projectId, taskId])
        return project
      },
      availableImageOutputAssetPath: async () => null,
    } as never)

    const result = await service.attachProject(TASK_ID, project.id)

    expect(owner.calls).toEqual([TASK_ID])
    expect(attachCalls).toEqual([[project.id, TASK_ID]])
    expect(result.assets).toEqual([])
    expect(JSON.stringify(result)).not.toContain('/private/workspace')
  })

  test('maps attachment conflicts to a safe product error without exposing media internals', async () => {
    const owner = ownerApi()
    const service = new ProductTaskMediaService(owner.api as never, {
      listProjects: async () => [],
      getTask: async () => mediaTask,
      attachProjectToProductTask: async () => {
        throw new MediaServiceError('/private/export/project.json is owned', 409, 'PROJECT_ALREADY_ATTACHED')
      },
      availableImageOutputAssetPath: async () => null,
    } as never)

    await expect(service.attachProject(TASK_ID, 'img_12345678')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: '媒体项目已关联到另一项任务',
    })
  })

  test('streams an image only through its matching task-owned project', async () => {
    const owner = ownerApi()
    const owned = imageProject(TASK_ID)
    const outputCalls: string[][] = []
    const service = new ProductTaskMediaService(owner.api as never, {
      listProjects: async () => [owned],
      getProject: async () => owned,
      getTask: async () => mediaTask,
      attachProjectToProductTask: async () => owned,
      availableImageOutputAssetPath: async () => null,
      imageOutputResponse: async (...args: string[]) => {
        outputCalls.push(args)
        return new Response('image-bytes', { headers: { 'Content-Type': 'image/png' } })
      },
    } as never)

    const response = await service.assetResponse(
      TASK_ID,
      owned.id,
      'out_12345678',
      new Request('http://localhost/media'),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('image-bytes')
    expect(outputCalls).toEqual([[owned.id, 'out_12345678']])
    await expect(service.assetResponse(
      OTHER_TASK_ID,
      owned.id,
      'out_12345678',
      new Request('http://localhost/media'),
    )).rejects.toMatchObject({ statusCode: 404, message: '找不到任务媒体产物' })
  })

  test('projects and streams a completed video without exposing its local output path', async () => {
    const owner = ownerApi()
    const video: MediaProject = {
      schema_version: 1,
      id: 'vid_12345678',
      kind: 'video',
      title: '活动集锦',
      workspace_root: '/private/workspace',
      product_task_id: TASK_ID,
      revision: 1,
      created_at: '2026-07-19T00:00:00.000Z',
      updated_at: '2026-07-19T00:01:00.000Z',
      state: 'complete',
      sources: [],
      timeline: [],
      output: { width: 1080, height: 1920, fps: 30 },
      output_path: '/private/export/activity.mov',
    }
    const service = new ProductTaskMediaService(owner.api as never, {
      listProjects: async () => [video],
      getProject: async () => video,
      getTask: async () => mediaTask,
      attachProjectToProductTask: async () => video,
      availableImageOutputAssetPath: async () => null,
      availableVideoOutputMimeType: async () => 'video/quicktime',
      videoOutputResponse: async (_projectId, request) => new Response('video-bytes', {
        status: request.headers.has('range') ? 206 : 200,
        headers: { 'Content-Type': 'video/quicktime' },
      }),
    } as never)

    const result = await service.listForTask(TASK_ID)

    expect(result.projects[0]?.assets).toEqual([{
      id: 'export',
      kind: 'video',
      mimeType: 'video/quicktime',
      url: `/api/product/tasks/${TASK_ID}/media/projects/${video.id}/assets/export`,
    }])
    expect(JSON.stringify(result)).not.toContain('/private/export/activity.mov')

    const response = await service.assetResponse(
      TASK_ID,
      video.id,
      'export',
      new Request('http://localhost/media', { headers: { Range: 'bytes=0-3' } }),
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Type')).toBe('video/quicktime')
    expect(await response.text()).toBe('video-bytes')
    await expect(service.assetResponse(
      OTHER_TASK_ID,
      video.id,
      'export',
      new Request('http://localhost/media'),
    )).rejects.toMatchObject({ statusCode: 404, message: '找不到任务媒体产物' })
  })
})
