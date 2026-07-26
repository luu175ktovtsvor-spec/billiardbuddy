import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DesktopSidebar } from './DesktopSidebar'
import {
  IMAGE_WORKBENCH_TAB_ID,
  NEW_PRODUCT_TASK_TAB_ID,
  PRODUCT_TASK_TAB_PREFIX,
  PRODUCT_TASKS_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  useTabStore,
} from '../../stores/tabStore'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from '../../product/stores/productTaskStore'
import { useProductTaskRuntimeStore, type ProductTaskRuntime } from '../../product/stores/productTaskRuntimeStore'
import type { ProductTaskIndexResponse } from '../../product/domain/types'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => ({
    'sidebar.newTask': '新建任务',
    'sidebar.scheduled': '已安排',
    'sidebar.settings': '设置',
    'sidebar.collapse': '收起侧边栏',
    'sidebar.untitledTask': '未命名任务',
  })[key] ?? key,
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({ isDesktop: false }),
}))

describe('DesktopSidebar', () => {
  const refresh = vi.fn(async () => undefined)

  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    useProductTaskStore.setState({
      index: EMPTY_PRODUCT_TASK_INDEX,
      isLoading: false,
      error: null,
      mutations: {},
      refresh,
    })
    useProductTaskRuntimeStore.setState({ tasks: {} })
    refresh.mockClear()
  })

  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useProductTaskStore.setState({
      index: EMPTY_PRODUCT_TASK_INDEX,
    })
    useProductTaskRuntimeStore.setState({ tasks: {} })
  })

  it('presents the three product workbenches and scheduled-task control plane', () => {
    render(<DesktopSidebar />)

    const navigation = screen.getByRole('navigation', { name: '产品导航' })
    expect(navigation).toHaveTextContent('任务图片创作视频创作已安排')
    expect(navigation).not.toHaveTextContent('经营')
    expect(navigation).not.toHaveTextContent('插件')
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()

    fireEvent.click(within(navigation).getByRole('button', { name: '任务' }))

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: PRODUCT_TASKS_TAB_ID,
      tabs: [{
        sessionId: PRODUCT_TASKS_TAB_ID,
        title: '任务中心',
        type: 'product-tasks',
      }],
    })
  })

  it('opens image and video workbenches directly from primary navigation', () => {
    render(<DesktopSidebar />)

    fireEvent.click(screen.getByRole('button', { name: '图片创作' }))
    expect(useTabStore.getState()).toMatchObject({
      activeTabId: IMAGE_WORKBENCH_TAB_ID,
      tabs: [expect.objectContaining({ type: 'image-workbench', title: '图片创作' })],
    })

    fireEvent.click(screen.getByRole('button', { name: '视频创作' }))
    expect(useTabStore.getState()).toMatchObject({
      activeTabId: VIDEO_STUDIO_TAB_ID,
      tabs: [
        expect.objectContaining({ type: 'image-workbench' }),
        expect.objectContaining({ type: 'video-studio', title: '视频创作' }),
      ],
    })
  })

  it('opens a product task through its dedicated product-task route', () => {
    const index: ProductTaskIndexResponse = {
      schemaVersion: 2,
      projects: [{
        id: 'project-1',
        title: 'BilliardBuddy',
        rootDir: '/workspace/billiard',
        createdAt: '2026-07-18T00:00:00.000Z',
        taskCount: 1,
        archivedTaskCount: 0,
        updatedAt: '2026-07-18T00:00:00.000Z',
      }],
      directories: [{
        id: 'directory-1',
        projectId: 'project-1',
        path: '/workspace/billiard',
        label: 'BilliardBuddy',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      }],
      tasks: [{
        id: 'task-1',
        projectId: 'project-1',
        directoryId: 'directory-1',
        workDir: '/workspace/billiard',
        title: '整理训练计划',
        lifecycle: 'active',
        kind: 'main',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
        worktreeState: 'not_requested',
        actions: ['archive'],
      }],
      total: 1,
      capabilities: { createTask: true },
    }
    useProductTaskStore.setState({ index })

    render(<DesktopSidebar />)
    fireEvent.click(screen.getByRole('button', { name: '整理训练计划' }))

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
      tabs: [expect.objectContaining({
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        type: 'product-task',
        taskId: 'task-1',
      })],
    })
  })

  it('shows a running marker from the product task runtime only for the active product task', () => {
    const index: ProductTaskIndexResponse = {
      schemaVersion: 2,
      projects: [],
      directories: [],
      tasks: [{
        id: 'task-running',
        projectId: 'project-1',
        directoryId: 'directory-1',
        workDir: '/workspace/billiard',
        title: '正在整理训练计划',
        lifecycle: 'active',
        kind: 'main',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
        worktreeState: 'not_requested',
        actions: ['archive'],
      }],
      total: 1,
      capabilities: { createTask: true },
    }
    const runtime: ProductTaskRuntime = {
      connectionState: 'connected',
      historyStatus: 'ready',
      runState: 'working',
      entries: [],
      queuedInputs: [],
      activeActivity: null,
      runActivities: [],
      contextCompactions: [],
      pendingApproval: null,
      approvalResponsePending: false,
      error: null,
          streamingEntryId: null,
          stopRequested: false,
          recoveryRequired: false,
    }
    useProductTaskStore.setState({ index })
    useProductTaskRuntimeStore.setState({ tasks: { 'task-running': runtime } })

    const { container } = render(<DesktopSidebar />)
    fireEvent.click(screen.getByRole('button', { name: '正在整理训练计划' }))

    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('keeps an active pinned project and task first in the sidebar', () => {
    const index: ProductTaskIndexResponse = {
      schemaVersion: 2,
      projects: [
        {
          id: 'project-newer',
          title: '较新项目',
          rootDir: '/workspace/newer',
          createdAt: '2026-07-19T00:00:00.000Z',
          taskCount: 1,
          archivedTaskCount: 0,
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
        {
          id: 'project-pinned',
          title: '置顶项目',
          rootDir: '/workspace/pinned',
          createdAt: '2026-07-18T00:00:00.000Z',
          taskCount: 1,
          archivedTaskCount: 0,
          updatedAt: '2026-07-18T00:00:00.000Z',
        },
      ],
      directories: [
        {
          id: 'directory-newer',
          projectId: 'project-newer',
          path: '/workspace/newer',
          label: '较新项目',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
        {
          id: 'directory-pinned',
          projectId: 'project-pinned',
          path: '/workspace/pinned',
          label: '置顶项目',
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: '2026-07-18T00:00:00.000Z',
        },
      ],
      tasks: [
        {
          id: 'task-newer',
          projectId: 'project-newer',
          directoryId: 'directory-newer',
          workDir: '/workspace/newer',
          title: '较新任务',
          lifecycle: 'active',
          kind: 'main',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
          worktreeState: 'not_requested',
          actions: ['archive'],
        },
        {
          id: 'task-pinned',
          projectId: 'project-pinned',
          directoryId: 'directory-pinned',
          workDir: '/workspace/pinned',
          title: '置顶任务',
          lifecycle: 'active',
          kind: 'main',
          pinnedAt: '2026-07-18T00:01:00.000Z',
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: '2026-07-18T00:00:00.000Z',
          worktreeState: 'not_requested',
          actions: ['unpin', 'archive'],
        },
      ],
      total: 2,
      capabilities: { createTask: true },
    }
    useProductTaskStore.setState({ index })

    render(<DesktopSidebar />)

    const pinnedTask = screen.getByRole('button', { name: /置顶任务/ })
    const newerTask = screen.getByRole('button', { name: /较新任务/ })
    expect(pinnedTask.compareDocumentPosition(newerTask) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getByTitle('已置顶')).toBeInTheDocument()
  })

  it('routes a new desktop task through its dedicated product page rather than creating a raw session', () => {
    render(<DesktopSidebar />)

    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: NEW_PRODUCT_TASK_TAB_ID,
      tabs: [expect.objectContaining({
        sessionId: NEW_PRODUCT_TASK_TAB_ID,
        title: '新建任务',
        type: 'new-product-task',
      })],
    })
  })
})
