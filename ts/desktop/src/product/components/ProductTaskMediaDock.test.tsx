import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_WORKBENCH_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  useTabStore,
} from '../../stores/tabStore'
import { useMediaWorkbenchStore } from '../../stores/mediaWorkbenchStore'

const apiMocks = vi.hoisted(() => ({
  getMedia: vi.fn(),
  getAttachableMedia: vi.fn(),
  attachMediaProject: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

vi.mock('../api/tasks', () => ({
  productTasksApi: apiMocks,
}))

vi.mock('../../api/client', () => ({
  getApiUrl: (path: string) => `http://127.0.0.1:49237${path}`,
}))

import { ProductTaskMediaDock } from './ProductTaskMediaDock'

beforeEach(() => {
  apiMocks.getMedia.mockReset()
  apiMocks.getAttachableMedia.mockReset()
  apiMocks.attachMediaProject.mockReset()
  useTabStore.setState({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
  useMediaWorkbenchStore.setState({ activeImageId: null, activeVideoId: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('ProductTaskMediaDock', () => {
  it('renders verified image and video assets without exposing output paths', async () => {
    apiMocks.getMedia.mockResolvedValue({
      taskId: 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb',
      projects: [
        {
          id: 'img_12345678',
          kind: 'image',
          title: '会员日海报',
          state: 'ready',
          updatedAt: '2026-07-19T00:00:00.000Z',
          mediaTask: { status: 'succeeded', progress: 100, stage: '生成完成', outcomeUnknown: false },
          assets: [{
            id: 'out_12345678',
            kind: 'image',
            mimeType: 'image/png',
            url: '/api/product/tasks/task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb/media/projects/img_12345678/assets/out_12345678.png',
          }],
        },
        {
          id: 'vid_12345678',
          kind: 'video',
          title: '活动集锦',
          state: 'complete',
          updatedAt: '2026-07-19T00:01:00.000Z',
          mediaTask: { status: 'succeeded', progress: 100, stage: '导出完成', outcomeUnknown: false },
          assets: [{
            id: 'export',
            kind: 'video',
            mimeType: 'video/mp4',
            url: '/api/product/tasks/task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb/media/projects/vid_12345678/assets/export',
          }],
        },
      ],
    })

    render(<ProductTaskMediaDock taskId="task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb" onClose={vi.fn()} />)

    expect(await screen.findByTestId('product-task-media-project-img_12345678')).toBeInTheDocument()
    const image = screen.getByAltText('会员日海报 图片结果')
    expect(image).toHaveAttribute(
      'src',
      'http://127.0.0.1:49237/api/product/tasks/task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb/media/projects/img_12345678/assets/out_12345678.png',
    )
    expect(screen.getByRole('link', { name: '打开原图' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:49237/api/product/tasks/task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb/media/projects/img_12345678/assets/out_12345678.png',
    )
    expect(screen.getByLabelText('活动集锦 视频预览')).toHaveAttribute(
      'src',
      'http://127.0.0.1:49237/api/product/tasks/task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb/media/projects/vid_12345678/assets/export',
    )
    expect(screen.getByRole('link', { name: '打开视频' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:49237/api/product/tasks/task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb/media/projects/vid_12345678/assets/export',
    )
    expect(screen.queryByText('/private/export/activity.mp4')).not.toBeInTheDocument()
    expect(screen.getByText('此处不会创建、生成或导出媒体；你可以明确关联一个尚未归属任务的已有项目，其他操作仍需在独立媒体工作台中完成。')).toBeInTheDocument()
    expect(apiMocks.getMedia).toHaveBeenCalledWith('task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb')
  })

  it('opens each task-scoped project in its dedicated workbench and selects it first', async () => {
    const taskId = 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb'
    apiMocks.getMedia.mockResolvedValue({
      taskId,
      projects: [
        {
          id: 'img_12345678',
          kind: 'image',
          title: '会员日海报',
          state: 'ready',
          updatedAt: '2026-07-19T00:00:00.000Z',
          mediaTask: null,
          assets: [],
        },
        {
          id: 'vid_12345678',
          kind: 'video',
          title: '活动集锦',
          state: 'complete',
          updatedAt: '2026-07-19T00:01:00.000Z',
          mediaTask: null,
          assets: [],
        },
      ],
    })

    render(<ProductTaskMediaDock taskId={taskId} onClose={vi.fn()} />)
    await screen.findByTestId('product-task-media-project-img_12345678')

    fireEvent.click(screen.getByRole('button', { name: '在图片工作台中打开' }))
    expect(useMediaWorkbenchStore.getState().activeImageId).toBe('img_12345678')
    expect(useTabStore.getState()).toMatchObject({
      activeTabId: IMAGE_WORKBENCH_TAB_ID,
      tabs: [{
        sessionId: IMAGE_WORKBENCH_TAB_ID,
        title: '生成图片',
        type: 'image-workbench',
      }],
    })

    fireEvent.click(screen.getByRole('button', { name: '在视频工作台中打开' }))
    expect(useMediaWorkbenchStore.getState().activeVideoId).toBe('vid_12345678')
    expect(useTabStore.getState()).toMatchObject({
      activeTabId: VIDEO_STUDIO_TAB_ID,
      tabs: expect.arrayContaining([{
        sessionId: VIDEO_STUDIO_TAB_ID,
        title: '剪视频',
        type: 'video-studio',
      }]),
    })
  })

  it('keeps the empty state honest and offers no create control', async () => {
    apiMocks.getMedia.mockResolvedValue({ taskId: 'task_0123456789abcdef', projects: [] })

    render(<ProductTaskMediaDock taskId="task_0123456789abcdef" onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('当前任务没有已关联的媒体项目。')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: /新项目|创建|生成|导出/ })).not.toBeInTheDocument()
  })

  it('explicitly attaches only a listed unowned draft and then reloads the task media', async () => {
    const taskId = 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb'
    const attachedProject = {
      id: 'img_12345678',
      kind: 'image' as const,
      title: '会员日海报',
      state: 'draft' as const,
      updatedAt: '2026-07-19T00:00:00.000Z',
      mediaTask: null,
      assets: [],
    }
    apiMocks.getMedia
      .mockResolvedValueOnce({ taskId, projects: [] })
      .mockResolvedValueOnce({ taskId, projects: [attachedProject] })
    apiMocks.getAttachableMedia.mockResolvedValue({
      taskId,
      projects: [{
        id: attachedProject.id,
        kind: attachedProject.kind,
        title: attachedProject.title,
        state: attachedProject.state,
        updatedAt: attachedProject.updatedAt,
      }],
    })
    apiMocks.attachMediaProject.mockResolvedValue({ project: attachedProject })

    render(<ProductTaskMediaDock taskId={taskId} onClose={vi.fn()} />)
    await screen.findByText('当前任务没有已关联的媒体项目。')

    fireEvent.click(screen.getByRole('button', { name: '关联已有项目' }))
    expect(await screen.findByTestId('product-task-media-attachable-img_12345678')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '关联' }))

    await waitFor(() => {
      expect(screen.getByTestId('product-task-media-project-img_12345678')).toBeInTheDocument()
    })
    expect(apiMocks.attachMediaProject).toHaveBeenCalledWith(taskId, 'img_12345678')
    expect(apiMocks.getMedia).toHaveBeenCalledTimes(2)
  })

  it('keeps a pending association scoped to its original task after the dock switches tasks', async () => {
    const firstTaskId = 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb'
    const secondTaskId = 'task_0123456789abcdef'
    const attachableProject = {
      id: 'img_task_one',
      kind: 'image' as const,
      title: '任务一海报',
      state: 'draft' as const,
      updatedAt: '2026-07-19T00:00:00.000Z',
    }
    const secondTaskProject = {
      id: 'img_task_two',
      kind: 'image' as const,
      title: '任务二海报',
      state: 'ready' as const,
      updatedAt: '2026-07-19T00:01:00.000Z',
      mediaTask: null,
      assets: [],
    }
    const attachedFirstTaskProject = {
      ...attachableProject,
      mediaTask: null,
      assets: [],
    }
    const pendingAttachment = deferred<{ project: typeof attachedFirstTaskProject }>()
    apiMocks.getMedia.mockImplementation(async (requestedTaskId: string) => (
      requestedTaskId === firstTaskId
        ? { taskId: firstTaskId, projects: [] }
        : { taskId: secondTaskId, projects: [secondTaskProject] }
    ))
    apiMocks.getAttachableMedia.mockResolvedValue({
      taskId: firstTaskId,
      projects: [attachableProject],
    })
    apiMocks.attachMediaProject.mockReturnValue(pendingAttachment.promise)

    const view = render(<ProductTaskMediaDock taskId={firstTaskId} onClose={vi.fn()} />)
    await screen.findByText('当前任务没有已关联的媒体项目。')

    fireEvent.click(screen.getByRole('button', { name: '关联已有项目' }))
    await screen.findByTestId('product-task-media-attachable-img_task_one')
    fireEvent.click(screen.getByRole('button', { name: '关联' }))

    view.rerender(<ProductTaskMediaDock taskId={secondTaskId} onClose={vi.fn()} />)

    expect(await screen.findByTestId('product-task-media-project-img_task_two')).toBeInTheDocument()
    expect(screen.queryByText('任务一海报')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关联已有项目' })).not.toBeDisabled()

    await act(async () => {
      pendingAttachment.resolve({ project: attachedFirstTaskProject })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('product-task-media-project-img_task_two')).toBeInTheDocument()
    expect(apiMocks.getMedia.mock.calls.filter(([requestedTaskId]) => requestedTaskId === firstTaskId)).toHaveLength(1)
    expect(apiMocks.getMedia).toHaveBeenCalledWith(secondTaskId)
  })

  it('refreshes an active media task without clearing the current task-scoped view', async () => {
    vi.useFakeTimers()
    const taskId = 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb'
    apiMocks.getMedia
      .mockResolvedValueOnce({
        taskId,
        projects: [{
          id: 'img_12345678',
          kind: 'image',
          title: '会员日海报',
          state: 'generating',
          updatedAt: '2026-07-19T00:00:00.000Z',
          mediaTask: { status: 'running', progress: 40, stage: '正在生成', outcomeUnknown: false },
          assets: [],
        }],
      })
      .mockResolvedValueOnce({
        taskId,
        projects: [{
          id: 'img_12345678',
          kind: 'image',
          title: '会员日海报',
          state: 'ready',
          updatedAt: '2026-07-19T00:00:03.000Z',
          mediaTask: { status: 'succeeded', progress: 100, stage: '生成完成', outcomeUnknown: false },
          assets: [{
            id: 'out_12345678',
            kind: 'image',
            mimeType: 'image/png',
            url: '/api/product/tasks/task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb/media/projects/img_12345678/assets/out_12345678.png',
          }],
        }],
      })

    render(<ProductTaskMediaDock taskId={taskId} onClose={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('媒体任务：处理中 · 40% · 正在生成')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(screen.getByAltText('会员日海报 图片结果')).toBeInTheDocument()
    expect(apiMocks.getMedia).toHaveBeenCalledTimes(2)
    expect(apiMocks.getMedia).toHaveBeenLastCalledWith(taskId)
  })
})
