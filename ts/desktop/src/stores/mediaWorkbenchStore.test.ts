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

vi.mock('../api/media', () => ({ mediaApi: mediaApiMock }))

import type { ImageWorkbenchProject, MediaTask } from '../api/media'
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

  it('reloads the persisted project revision when image submission has an unknown outcome', async () => {
    const draft = image('img_unknown01')
    const failed = {
      ...draft,
      revision: 1,
      state: 'failed' as const,
      task_id: 'task_unknown1',
      error: '可能已经产生费用',
    }
    mediaApiMock.submitImageProject.mockRejectedValue(new Error('可能已经产生费用'))
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

    await expect(useMediaWorkbenchStore.getState().submitImage(draft.id, true)).rejects.toThrow('可能已经产生费用')
    expect(mediaApiMock.submitImageProject).toHaveBeenCalledWith(draft.id, true)
    expect(useMediaWorkbenchStore.getState()).toMatchObject({
      imageProjects: [failed],
      activeImageId: failed.id,
      error: '可能已经产生费用',
    })
    expect(useMediaWorkbenchStore.getState().tasks.task_unknown1).toMatchObject({
      outcome_unknown: true,
      remote_task_id: 'remote-unknown',
    })
  })
})
