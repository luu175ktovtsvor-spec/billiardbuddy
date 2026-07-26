import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { previewBridgeMock, productTaskProbe } = vi.hoisted(() => ({
  previewBridgeMock: {
    close: vi.fn().mockResolvedValue(undefined),
  },
  productTaskProbe: { mounts: 0 },
}))

vi.mock('../../lib/previewBridge', () => ({ previewBridge: previewBridgeMock }))

vi.mock('../../product/components/ProductScheduledTasksPage', () => ({
  ProductScheduledTasksPage: () => <div data-testid="product-scheduled-tasks" />,
}))

vi.mock('../../pages/Settings', () => ({
  Settings: () => <div data-testid="settings-page" />,
}))

vi.mock('../media/ImageWorkbench', () => ({
  ImageWorkbench: () => <div data-testid="image-workbench" />,
}))

vi.mock('../media/VideoStudio', () => ({
  VideoStudio: () => <div data-testid="video-studio" />,
}))

vi.mock('../../product/components/ProductShell', () => ({
  ProductShell: ({ page = 'task-index', initialWorkDir }: { page?: string; initialWorkDir?: string }) => (
    <div data-page={page} data-work-dir={initialWorkDir ?? ''} data-testid="product-shell" />
  ),
}))

vi.mock('../../product/components/ProductTaskPage', async () => {
  const { useState } = await import('react')
  return {
    ProductTaskPage: ({ taskId }: { taskId: string }) => {
      const [mount] = useState(() => ++productTaskProbe.mounts)
      return <div data-mount={mount} data-testid="product-task-page">task:{taskId}</div>
    },
  }
})

import { ContentRouter } from './ContentRouter'
import { useTabStore } from '../../stores/tabStore'

describe('ContentRouter tab surfaces', () => {
  afterEach(() => {
    cleanup()
    previewBridgeMock.close.mockClear()
    productTaskProbe.mounts = 0
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it('routes an empty desktop surface to the dedicated new-task page', () => {
    render(<ContentRouter />)

    expect(screen.getByTestId('product-shell')).toHaveAttribute('data-page', 'new-task')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('routes a new-task tab with its requested work directory', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__new_product_task__',
        title: '新建任务',
        type: 'new-product-task',
        newTaskWorkDir: '/workspace/billiard',
        newTaskRequestId: 3,
      }],
      activeTabId: '__new_product_task__',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('product-shell')).toHaveAttribute('data-page', 'new-task')
    expect(screen.getByTestId('product-shell')).toHaveAttribute('data-work-dir', '/workspace/billiard')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('renders the image workbench as a product surface', () => {
    useTabStore.setState({
      tabs: [{ sessionId: '__image_workbench__', title: '生成图片', type: 'image-workbench' }],
      activeTabId: '__image_workbench__',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('image-workbench')).toBeInTheDocument()
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('renders the video studio as a product surface', () => {
    useTabStore.setState({
      tabs: [{ sessionId: '__video_studio__', title: '剪视频', type: 'video-studio' }],
      activeTabId: '__video_studio__',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('video-studio')).toBeInTheDocument()
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('renders the product task index without mounting the chat session surface', () => {
    useTabStore.setState({
      tabs: [{ sessionId: '__product_tasks__', title: '任务中心', type: 'product-tasks' }],
      activeTabId: '__product_tasks__',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('product-shell')).toBeInTheDocument()
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('renders a product task through its task identity without mounting the chat session surface', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__product_task__task-1',
        title: '整理开球训练',
        type: 'product-task',
        taskId: 'task-1',
      }],
      activeTabId: '__product_task__task-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('product-task-page')).toHaveTextContent('task:task-1')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
  })

  it('remounts the task page when switching product task tabs', () => {
    useTabStore.setState({
      tabs: [
        {
          sessionId: '__product_task__task-1',
          title: '整理开球训练',
          type: 'product-task',
          taskId: 'task-1',
        },
        {
          sessionId: '__product_task__task-2',
          title: '整理排班',
          type: 'product-task',
          taskId: 'task-2',
        },
      ],
      activeTabId: '__product_task__task-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('product-task-page')).toHaveAttribute('data-mount', '1')
    act(() => {
      useTabStore.setState({ activeTabId: '__product_task__task-2' })
    })

    expect(screen.getByTestId('product-task-page')).toHaveTextContent('task:task-2')
    expect(screen.getByTestId('product-task-page')).toHaveAttribute('data-mount', '2')
  })

  it('keeps the native preview host available while a product task is active, then closes it after leaving', async () => {
    useTabStore.setState({
      tabs: [
        {
          sessionId: '__product_task__task-1',
          title: '整理开球训练',
          type: 'product-task',
          taskId: 'task-1',
        },
        { sessionId: '__settings__', title: 'Settings', type: 'settings' },
      ],
      activeTabId: '__product_task__task-1',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('product-task-page')).toBeInTheDocument()
    expect(previewBridgeMock.close).not.toHaveBeenCalled()

    act(() => {
      useTabStore.setState({ activeTabId: '__settings__' })
    })

    await waitFor(() => {
      expect(previewBridgeMock.close).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps an unknown tab out of task runtime routing', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__unknown_tab__',
        title: 'Unknown',
        type: 'unknown' as never,
      }],
      activeTabId: '__unknown_tab__',
    })

    render(<ContentRouter />)

    expect(screen.getByTestId('product-shell')).toHaveAttribute('data-page', 'new-task')
    expect(screen.queryByTestId('active-session')).not.toBeInTheDocument()
    expect(useTabStore.getState().activeTabId).toBe('__unknown_tab__')
    expect(useTabStore.getState().tabs).toHaveLength(1)
  })
})
