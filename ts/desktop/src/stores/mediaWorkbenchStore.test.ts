import { beforeEach, describe, expect, it, vi } from 'vitest'

const mediaApiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getToolchain: vi.fn(),
  createImageProject: vi.fn(),
  updateImageProject: vi.fn(),
  submitImageProject: vi.fn(),
  createVideoProject: vi.fn(),
  addVideoSource: vi.fn(),
  updateVideoTimeline: vi.fn(),
  renderVideo: vi.fn(),
  cancelTask: vi.fn(),
  deleteProject: vi.fn(),
  getTask: vi.fn(),
}))

vi.mock('../api/media', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/media')>()),
  mediaApi: mediaApiMock,
}))

import type { ImageWorkbenchProject, MediaTask } from '../api/media'
import { ApiError } from '../api/client'
import { useMediaWorkbenchStore } from './mediaWorkbenchStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function image(id: string, prompt = '活动海报'): ImageWorkbenchProject {
  return {
    schema_version: 1,
    id,
    kind: 'image',
    title: prompt,
    revision: 0,
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: '2026-07-18T00:00:00.000Z',
    state: 'draft',
    mode: 'generate',
    prompt,
    size: '1024x1024',
    count: 1,
    reference_images: [],
    reference_image_count: 0,
    outputs: [],
  }
}

function task(
  id: string,
  status: MediaTask['status'],
  progress: number,
): MediaTask {
  return {
    schema_version: 1,
    id,
    project_id: 'img_task001',
    kind: 'image.generate',
    status,
    progress,
    stage: status === 'succeeded' ? '已完成' : '生成中',
    created_at: '2026-07-18T00:00:00.000Z',
    updated_at: status === 'succeeded'
      ? '2026-07-18T00:01:00.000Z'
      : '2026-07-18T00:00:30.000Z',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mediaApiMock.listProjects.mockResolvedValue({ projects: [] })
  useMediaWorkbenchStore.setState({
    imageProjects: [],
    videoProjects: [],
    tasks: {},
    toolchain: null,
    activeImageId: null,
    activeVideoId: null,
    loading: false,
    error: null,
  })
})

describe('mediaWorkbenchStore', () => {
  it('keeps a newly created image project when an older refresh finishes last', async () => {
    const older = image('img_older001', '旧快照')
    const newer = image('img_newer001', '最新草稿')
    const firstResponse = deferred<{ projects: ImageWorkbenchProject[] }>()
    mediaApiMock.listProjects.mockReturnValueOnce(firstResponse.promise)
    mediaApiMock.createImageProject.mockResolvedValue({ project: newer })

    const firstLoad = useMediaWorkbenchStore.getState().loadProjects('image')
    await useMediaWorkbenchStore.getState().createImage({ prompt: newer.prompt })
    expect(useMediaWorkbenchStore.getState()).toMatchObject({
      imageProjects: [newer],
      activeImageId: newer.id,
    })

    firstResponse.resolve({ projects: [older] })
    await firstLoad
    expect(useMediaWorkbenchStore.getState()).toMatchObject({
      imageProjects: [newer],
      activeImageId: newer.id,
      loading: false,
    })
  })

  it('stays loading until overlapping project lists for different workbenches finish', async () => {
    const imageResponse = deferred<{ projects: ImageWorkbenchProject[] }>()
    const videoResponse = deferred<{ projects: ImageWorkbenchProject[] }>()
    mediaApiMock.listProjects
      .mockReturnValueOnce(imageResponse.promise)
      .mockReturnValueOnce(videoResponse.promise)

    const imageLoad = useMediaWorkbenchStore.getState().loadProjects('image')
    const videoLoad = useMediaWorkbenchStore.getState().loadProjects('video')
    expect(useMediaWorkbenchStore.getState().loading).toBe(true)

    imageResponse.resolve({ projects: [] })
    await imageLoad
    expect(useMediaWorkbenchStore.getState().loading).toBe(true)

    videoResponse.resolve({ projects: [] })
    await videoLoad
    expect(useMediaWorkbenchStore.getState().loading).toBe(false)
  })

  it('saves an editable image draft and selects the next project after deletion', async () => {
    const first = image('img_first001')
    const second = image('img_second01', '第二张')
    const edited = { ...first, prompt: '修改后的海报' }
    const saved = { ...edited, revision: 1 }
    mediaApiMock.updateImageProject.mockResolvedValue({ project: saved })
    mediaApiMock.deleteProject.mockResolvedValue(undefined)
    useMediaWorkbenchStore.setState({ imageProjects: [first, second], activeImageId: first.id })

    await useMediaWorkbenchStore.getState().saveImageDraft(edited)
    expect(mediaApiMock.updateImageProject).toHaveBeenCalledWith(first.id, {
      revision: edited.revision,
      prompt: edited.prompt,
      size: edited.size,
      count: edited.count,
      confirm_unknown_retry: false,
    })

    await useMediaWorkbenchStore.getState().deleteProject(first.id, 'image')
    expect(useMediaWorkbenchStore.getState()).toMatchObject({
      imageProjects: [second],
      activeImageId: second.id,
    })
  })

  it('keeps terminal task evidence and refreshes the owning project list', async () => {
    const failedProject = { ...image('img_failed001'), state: 'failed' as const, error: '上游失败' }
    const task: MediaTask = {
      schema_version: 1,
      id: 'task_failed01',
      project_id: failedProject.id,
      kind: 'image.generate',
      status: 'failed',
      progress: 0,
      stage: '生成失败',
      error: '上游失败',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:01:00.000Z',
    }
    mediaApiMock.getTask.mockResolvedValue({ task })
    mediaApiMock.listProjects.mockResolvedValue({ projects: [failedProject] })

    await useMediaWorkbenchStore.getState().refreshTask(task.id)
    expect(useMediaWorkbenchStore.getState().tasks[task.id]).toEqual(task)
    expect(useMediaWorkbenchStore.getState().imageProjects).toEqual([failedProject])
  })

  it('keeps the newest task refresh response when a poll finishes after a manual refresh', async () => {
    const older = task('task_refresh01', 'running', 40)
    const newer = task(older.id, 'succeeded', 100)
    const olderResponse = deferred<{ task: MediaTask }>()
    const newerResponse = deferred<{ task: MediaTask }>()
    mediaApiMock.getTask
      .mockReturnValueOnce(olderResponse.promise)
      .mockReturnValueOnce(newerResponse.promise)

    const poll = useMediaWorkbenchStore.getState().refreshTask(older.id)
    const manualRefresh = useMediaWorkbenchStore.getState().refreshTask(older.id)

    newerResponse.resolve({ task: newer })
    await manualRefresh
    olderResponse.resolve({ task: older })
    await poll

    expect(useMediaWorkbenchStore.getState().tasks[older.id]).toEqual(newer)
  })

  it('reloads the persisted project revision when image submission has an unknown outcome', async () => {
    const draft = image('img_unknown01')
    const rawDetail = 'gateway status lost token=private-token'
    const safeMessage = '暂时无法确认图片任务是否已提交，可能已经产生费用。请确认后再试。'
    const failed = {
      ...draft,
      revision: 1,
      state: 'failed' as const,
      task_id: 'task_unknown1',
      error: safeMessage,
      error_code: 'MEDIA_IMAGE_OUTCOME_UNKNOWN' as const,
    }
    mediaApiMock.submitImageProject.mockRejectedValue(new ApiError(502, {
      error: 'MEDIA_IMAGE_OUTCOME_UNKNOWN',
      message: rawDetail,
    }))
    mediaApiMock.listProjects.mockResolvedValue({ projects: [failed] })
    mediaApiMock.getTask.mockResolvedValue({
      task: {
        schema_version: 1,
        id: 'task_unknown1',
        project_id: failed.id,
        kind: 'image.generate',
        status: 'failed',
        progress: 20,
        stage: '结果待确认',
        remote_task_id: 'remote-unknown',
        outcome_unknown: true,
        created_at: '2026-07-18T00:00:00.000Z',
        updated_at: '2026-07-18T00:01:00.000Z',
      },
    })
    useMediaWorkbenchStore.setState({ imageProjects: [draft], activeImageId: draft.id })

    await expect(useMediaWorkbenchStore.getState().submitImage(draft.id, true)).rejects.toThrow(safeMessage)
    expect(mediaApiMock.submitImageProject).toHaveBeenCalledWith(draft.id, true)
    expect(useMediaWorkbenchStore.getState()).toMatchObject({
      imageProjects: [failed],
      activeImageId: failed.id,
      error: safeMessage,
    })
    expect(useMediaWorkbenchStore.getState().tasks.task_unknown1).toMatchObject({
      outcome_unknown: true,
      remote_task_id: 'remote-unknown',
    })
  })
})
