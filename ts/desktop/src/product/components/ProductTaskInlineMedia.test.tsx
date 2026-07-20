import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getMedia: vi.fn(),
}))

vi.mock('../api/tasks', () => ({
  productTasksApi: apiMocks,
}))

vi.mock('../../api/client', () => ({
  getApiUrl: (path: string) => `http://127.0.0.1:3457${path}`,
}))

import { ProductTaskInlineMedia } from './ProductTaskInlineMedia'

beforeEach(() => {
  apiMocks.getMedia.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProductTaskInlineMedia', () => {
  it('shows task-owned image and video assets inside the message stream', async () => {
    const taskId = 'task-1'
    apiMocks.getMedia.mockResolvedValue({
      taskId,
      projects: [{
        id: 'vid_12345678',
        kind: 'video',
        title: '训练回放',
        state: 'complete',
        updatedAt: '2026-07-20T00:00:00.000Z',
        mediaTask: null,
        assets: [
          {
            id: 'cover',
            kind: 'image',
            mimeType: 'image/png',
            url: '/api/product/tasks/task-1/media/projects/vid_12345678/assets/cover',
          },
          {
            id: 'export',
            kind: 'video',
            mimeType: 'video/mp4',
            url: '/api/product/tasks/task-1/media/projects/vid_12345678/assets/export',
          },
        ],
      }],
    })

    render(
      <ProductTaskInlineMedia
        taskId={taskId}
        draft={{ projectId: 'vid_12345678', kind: 'video', state: 'draft' }}
      />,
    )

    expect(await screen.findByAltText('训练回放 图片结果')).toHaveAttribute(
      'src',
      'http://127.0.0.1:3457/api/product/tasks/task-1/media/projects/vid_12345678/assets/cover',
    )
    expect(screen.getByLabelText('训练回放 视频预览')).toHaveAttribute(
      'src',
      'http://127.0.0.1:3457/api/product/tasks/task-1/media/projects/vid_12345678/assets/export',
    )
    expect(screen.queryByRole('button', { name: '关联到当前任务并打开工作台' })).toBeNull()
  })

  it('does not display media returned for another task', async () => {
    apiMocks.getMedia.mockResolvedValue({
      taskId: 'task-other',
      projects: [{
        id: 'img_12345678',
        kind: 'image',
        title: '不应显示',
        state: 'ready',
        updatedAt: '2026-07-20T00:00:00.000Z',
        mediaTask: null,
        assets: [{
          id: 'output',
          kind: 'image',
          mimeType: 'image/png',
          url: '/api/product/tasks/task-other/media/projects/img_12345678/assets/output',
        }],
      }],
    })

    render(
      <ProductTaskInlineMedia
        taskId="task-1"
        draft={{ projectId: 'img_12345678', kind: 'image', state: 'draft' }}
        onAttach={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: '关联到当前任务并打开工作台' })).toBeInTheDocument()
    expect(screen.queryByAltText('不应显示 图片结果')).toBeNull()
  })
})
