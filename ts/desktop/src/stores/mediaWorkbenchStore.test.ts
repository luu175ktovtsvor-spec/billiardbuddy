import { beforeEach, describe, expect, it, vi } from 'vitest'

const mediaApiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getToolchain: vi.fn(),
  createImageProject: vi.fn(),
  updateImageProject: vi.fn(),
  submitImageProject: vi.fn(),
  startImageOperation: vi.fn(),
  commitImageVersion: vi.fn(),
  selectImageVersion: vi.fn(),
  createVideoProject: vi.fn(),
  addVideoSource: vi.fn(),
  updateVideoTimeline: vi.fn(),
  previewVideo: vi.fn(),
  renderVideo: vi.fn(),
  cancelTask: vi.fn(),
  deleteProject: vi.fn(),
  getTask: vi.fn(),
  waitForProjectEvents: vi.fn(),
}))

vi.mock('../api/media', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/media')>()),
  mediaApi: mediaApiMock,
}))

import type { ImageWorkbenchProject, MediaTask, VideoStudioProject } from '../api/media'
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
    size: '1024x1024',
    candidate_count: 3,
  brief: {
      schema_version: 1,
      user_request: prompt,
      confirmed_facts: [],
      must_preserve: [],
      may_change: [],
      missing_information: [],
      exact_text: [],
    compiler_version: 'image-brief-v1',
  },
  brief_overrides: {},
  references: [],
    reference_images: [],
    reference_image_count: 0,
    version_history: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mediaApiMock.listProjects.mockResolvedValue({ projects: [] })
  useMediaWorkbenchStore.setState({
    imageProjects: [],
    videoProjects: [],
    tasks: {},
    eventCursors: {},
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
    await useMediaWorkbenchStore.getState().createImage({ user_request: newer.brief!.user_request })
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

  it('loads the independent preview task together with the primary video task', async () => {
    const video: VideoStudioProject = {
      schema_version: 1,
      id: 'vid_preview01',
      kind: 'video',
      title: '预览项目',
      revision: 2,
      created_at: '2026-07-26T00:00:00.000Z',
      updated_at: '2026-07-26T00:01:00.000Z',
      state: 'ready',
      sources: [], timeline: [], evidence: [], timeline_versions: [], alternatives: [],
      output: { width: 1080, height: 1920, fps: 30 },
      task_id: 'task_primary01',
      preview_task_id: 'task_preview01',
    }
    const task = (id: string, kind: MediaTask['kind']): MediaTask => ({
      schema_version: 1,
      id,
      project_id: video.id,
      kind,
      status: 'succeeded',
      status_sequence: 1,
      progress: 100,
      stage: '完成',
      created_at: video.created_at,
      updated_at: video.updated_at,
    })
    mediaApiMock.listProjects.mockResolvedValue({ projects: [video] })
    mediaApiMock.getTask.mockImplementation(async (taskId: string) => ({
      task: task(taskId, taskId === video.preview_task_id ? 'video.preview' : 'video.plan'),
    }))

    await useMediaWorkbenchStore.getState().loadProjects('video')
    expect(mediaApiMock.getTask).toHaveBeenCalledTimes(2)
    expect(useMediaWorkbenchStore.getState().tasks).toMatchObject({
      task_primary01: { kind: 'video.plan' },
      task_preview01: { kind: 'video.preview' },
    })
  })

  it('saves an editable image draft and selects the next project after deletion', async () => {
    const first = image('img_first001')
    const second = image('img_second01', '第二张')
    const edited = { ...first, brief: { ...first.brief!, user_request: '修改后的海报' } }
    const saved = { ...edited, revision: 1 }
    mediaApiMock.updateImageProject.mockResolvedValue({ project: saved })
    mediaApiMock.deleteProject.mockResolvedValue(undefined)
    useMediaWorkbenchStore.setState({ imageProjects: [first, second], activeImageId: first.id })

    await useMediaWorkbenchStore.getState().saveImageDraft(edited)
    expect(mediaApiMock.updateImageProject).toHaveBeenCalledWith(first.id, {
      revision: edited.revision,
      user_request: edited.brief.user_request,
      size: edited.size,
      brief_overrides: edited.brief_overrides,
      references: edited.references,
      new_reference_images: [],
      new_reference_roles: [],
      confirm_unknown_retry: false,
    })

    await useMediaWorkbenchStore.getState().deleteProject(first.id, 'image')
    expect(useMediaWorkbenchStore.getState()).toMatchObject({
      imageProjects: [second],
      activeImageId: second.id,
    })
  })

  it('applies monotonic project events and refreshes the owning project projection', async () => {
    const failedProject = { ...image('img_failed001'), state: 'failed' as const, error: '上游失败' }
    const task: MediaTask = {
      schema_version: 1,
      id: 'task_failed01',
      project_id: failedProject.id,
      kind: 'image.generate',
      status: 'failed',
      status_sequence: 2,
      progress: 0,
      stage: '生成失败',
      error: '上游失败',
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:01:00.000Z',
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [failedProject] })
    mediaApiMock.getTask.mockResolvedValue({ task })
    const nextPage = deferred<never>()
    mediaApiMock.waitForProjectEvents
      .mockResolvedValueOnce({
        events: [{
          schema_version: 1,
          cursor: 2,
          project_id: failedProject.id,
          task_id: task.id,
          operation_id: 'op_event00000001',
          status_sequence: 2,
          occurred_at: task.updated_at,
          task,
        }, {
          schema_version: 1,
          cursor: 1,
          project_id: failedProject.id,
          task_id: task.id,
          operation_id: 'op_event00000001',
          status_sequence: 1,
          occurred_at: task.created_at,
          task: { ...task, status: 'running', status_sequence: 1, progress: 40, stage: '生成中' },
        }],
        cursor: 2,
        reset_required: false,
      })
      .mockReturnValue(nextPage.promise)

    const unsubscribe = useMediaWorkbenchStore.getState().subscribeProjectEvents(failedProject.id, 'image')
    await vi.waitFor(() => {
      expect(useMediaWorkbenchStore.getState().tasks[task.id]).toEqual(task)
      expect(useMediaWorkbenchStore.getState().eventCursors[failedProject.id]).toBe(2)
      expect(useMediaWorkbenchStore.getState().imageProjects).toEqual([failedProject])
    })
    unsubscribe()
  })

  it('reloads the persisted project revision when image submission has an unknown outcome', async () => {
    const draft = image('img_unknown01')
    const rawDetail = 'gateway status lost token=private-token'
    const safeMessage = '暂时无法确认图片任务是否已被远程服务受理。请先查询原操作，确需新建时再继续。'
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
        status_sequence: 1,
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
