import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getMedia: vi.fn(),
  getAttachableMedia: vi.fn(),
  attachMediaProject: vi.fn(),
}))

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
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('ProductTaskMediaDock', () => {
  it('renders verified image assets and keeps video exports state-only without exposing output paths', async () => {
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
            url: '/api/media/assets/img_12345678/out_12345678.png',
          }],
        },
        {
          id: 'vid_12345678',
          kind: 'video',
          title: '活动集锦',
          state: 'complete',
          updatedAt: '2026-07-19T00:01:00.000Z',
          mediaTask: { status: 'succeeded', progress: 100, stage: '导出完成', outcomeUnknown: false },
          assets: [],
        },
      ],
    })

    render(<ProductTaskMediaDock taskId="task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb" onClose={vi.fn()} />)

    expect(await screen.findByTestId('product-task-media-project-img_12345678')).toBeInTheDocument()
    const image = screen.getByAltText('会员日海报 图片结果')
    expect(image).toHaveAttribute(
      'src',
      'http://127.0.0.1:49237/api/media/assets/img_12345678/out_12345678.png',
    )
    expect(screen.getByRole('link', { name: '打开原图' })).toHaveAttribute(
      'href',
      'http://127.0.0.1:49237/api/media/assets/img_12345678/out_12345678.png',
    )
    expect(screen.queryByLabelText('活动集锦 视频预览')).not.toBeInTheDocument()
    expect(screen.getByText('视频导出位于本机选择的位置，任务页不会读取或公开该路径。')).toBeInTheDocument()
    expect(screen.queryByText('/private/export/activity.mp4')).not.toBeInTheDocument()
    expect(screen.getByText('此处不会创建、生成或导出媒体；你可以明确关联一个尚未归属任务的已有项目，其他操作仍需在独立媒体工作台中完成。')).toBeInTheDocument()
    expect(apiMocks.getMedia).toHaveBeenCalledWith('task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb')
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
            url: '/api/media/assets/img_12345678/out_12345678.png',
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
