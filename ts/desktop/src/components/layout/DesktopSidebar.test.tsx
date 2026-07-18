import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DesktopSidebar } from './DesktopSidebar'
import { PRODUCT_TASKS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from '../../product/stores/productTaskStore'
import { useChatStore } from '../../stores/chatStore'
import type { ProductTaskIndexResponse } from '../../product/domain/types'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => ({
    'sidebar.newSession': '新建任务',
    'sidebar.scheduled': '已安排',
    'sidebar.settings': '设置',
    'sidebar.collapse': '收起侧边栏',
    'session.untitled': '未命名任务',
  })[key] ?? key,
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({ isDesktop: false }),
}))

describe('DesktopSidebar', () => {
  const refresh = vi.fn(async () => undefined)
  const connectToSession = vi.fn()

  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    useProductTaskStore.setState({
      index: EMPTY_PRODUCT_TASK_INDEX,
      isLoading: false,
      error: null,
      mutations: {},
      composerRequest: null,
      refresh,
    })
    useChatStore.setState({
      connectToSession,
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    refresh.mockClear()
    connectToSession.mockClear()
  })

  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
    useProductTaskStore.setState({
      index: EMPTY_PRODUCT_TASK_INDEX,
      composerRequest: null,
    })
  })

  it('opens the product task index through the desktop navigation', () => {
    render(<DesktopSidebar />)

    fireEvent.click(screen.getByRole('button', { name: '任务中心' }))

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: PRODUCT_TASKS_TAB_ID,
      tabs: [{
        sessionId: PRODUCT_TASKS_TAB_ID,
        title: '任务中心',
        type: 'product-tasks',
        status: 'idle',
      }],
    })
  })

  it('opens a product task through its real core session instead of a raw session entry', () => {
    const index: ProductTaskIndexResponse = {
      schemaVersion: 1,
      projects: [{
        id: 'project-1',
        title: 'BilliardBuddy',
        workDir: '/workspace/billiard',
        taskCount: 1,
        archivedTaskCount: 0,
        updatedAt: '2026-07-18T00:00:00.000Z',
      }],
      tasks: [{
        id: 'task-1',
        projectId: 'project-1',
        workDir: '/workspace/billiard',
        title: '整理训练计划',
        coreSessionId: 'session-1',
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
      activeTabId: 'session-1',
      tabs: [expect.objectContaining({ sessionId: 'session-1', type: 'session' })],
    })
    expect(connectToSession).toHaveBeenCalledWith('session-1')
  })

  it('routes a new desktop task through the product composer rather than creating a raw session', () => {
    render(<DesktopSidebar />)

    fireEvent.click(screen.getAllByRole('button', { name: '新建任务' })[0]!)

    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
    expect(useProductTaskStore.getState().composerRequest).toEqual(expect.objectContaining({ id: expect.any(Number) }))
  })
})
