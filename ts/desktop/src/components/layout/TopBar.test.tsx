import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useProductTaskStore } from '../../product/stores/productTaskStore'
import type { ProductTaskRecord } from '../../product/domain/types'

vi.mock('./WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls">window controls</div>,
  showWindowControls: false,
}))

vi.mock('../chat/clipboard', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}))

import { copyTextToClipboard } from '../chat/clipboard'
import { TopBar } from './TopBar'

const TASK_ID = 'topbar-task'

const productTaskMocks = {
  archiveTask: vi.fn(),
  continueTask: vi.fn(),
  pinTask: vi.fn(),
  renameTask: vi.fn(),
  restoreTask: vi.fn(),
  unpinTask: vi.fn(),
}

function makeProductTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: TASK_ID,
    projectId: 'project-topbar',
    workDir: '/workspace/panel-task',
    title: 'Panel task',
    lifecycle: 'active',
    kind: 'main',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    worktreeState: 'not_requested',
    actions: ['pin', 'rename', 'archive', 'continue'],
    ...overrides,
    directoryId: overrides.directoryId ?? 'directory-topbar',
  }
}

function setActiveProductTask(task = makeProductTask()) {
  useProductTaskStore.setState({
    index: {
      schemaVersion: 1,
      projects: [],
      directories: [],
      tasks: [task],
      total: 1,
      capabilities: { createTask: true },
    },
    mutations: {},
    archiveTask: productTaskMocks.archiveTask as never,
    continueTask: productTaskMocks.continueTask as never,
    pinTask: productTaskMocks.pinTask as never,
    renameTask: productTaskMocks.renameTask as never,
    restoreTask: productTaskMocks.restoreTask as never,
    unpinTask: productTaskMocks.unpinTask as never,
  })
  useTabStore.setState({
    tabs: [{
      sessionId: `__product_task__${task.id}`,
      title: task.title,
      type: 'product-task',
      taskId: task.id,
    }],
    activeTabId: `__product_task__${task.id}`,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useProductTaskStore.setState(useProductTaskStore.getInitialState(), true)
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSettingsStore.setState({ locale: 'en' })
  useUIStore.setState({ sidebarOpen: true, activeModal: null })
  setActiveProductTask()
})

afterEach(() => {
  cleanup()
  useProductTaskStore.setState(useProductTaskStore.getInitialState(), true)
  useTabStore.setState({ tabs: [], activeTabId: null })
  useUIStore.setState(useUIStore.getInitialState(), true)
})

describe('TopBar product task navigation', () => {
  it('keeps product task search navigation, title, and window controls', () => {
    render(<TopBar />)

    expect(screen.getByTestId('window-controls')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '任务操作：Panel task' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
    expect(useUIStore.getState().activeModal).toBe('task-search')

    useUIStore.getState().closeModal()
    fireEvent.click(screen.getByRole('button', { name: 'Recent tasks' }))
    expect(useUIStore.getState().activeModal).toBe('task-search')
  })

  it('keeps the product task lifecycle menu and work-directory copy', async () => {
    render(<TopBar />)

    expect(screen.queryByRole('button', { name: 'Open Terminal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Browser' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show Workspace' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))

    expect(screen.getByRole('menuitem', { name: '复制工作目录' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '复制任务 ID' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '重命名任务' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '置顶任务' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '在当前工作目录继续' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '在新工作树中继续' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '归档任务' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '复制整段对话' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: '复制工作目录' }))
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith('/workspace/panel-task'))

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '复制任务 ID' }))
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledWith(TASK_ID))
  })

  it('keeps ordinary product-page titles without turning them into task menus', () => {
    useTabStore.setState({
      tabs: [{
        sessionId: '__product_tasks__',
        title: '任务中心',
        type: 'product-tasks',
      }],
      activeTabId: '__product_tasks__',
    })

    render(<TopBar />)

    expect(screen.getByText('任务中心')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /任务操作/ })).not.toBeInTheDocument()
  })

  it('renames the real product task through its dedicated tab identity', async () => {
    productTaskMocks.renameTask.mockResolvedValue(makeProductTask({ title: '更新后的任务名称' }))
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名任务' }))
    fireEvent.change(screen.getByRole('textbox', { name: '任务名称' }), { target: { value: '更新后的任务名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(productTaskMocks.renameTask).toHaveBeenCalledWith(TASK_ID, '更新后的任务名称'))
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      type: 'product-task',
      taskId: TASK_ID,
      title: '更新后的任务名称',
    })
    expect(screen.getByRole('button', { name: '任务操作：更新后的任务名称' })).toBeInTheDocument()
  })

  it('archives and continues through the product task contract', async () => {
    productTaskMocks.archiveTask.mockResolvedValue(makeProductTask({ lifecycle: 'archived', actions: ['restore', 'continue'] }))
    productTaskMocks.continueTask.mockResolvedValue(makeProductTask({
      id: 'continued-task',
      title: '继续 Panel task',
      kind: 'continuation',
      actions: ['archive', 'continue'],
    }))
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '归档任务' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

    await waitFor(() => expect(productTaskMocks.archiveTask).toHaveBeenCalledWith(TASK_ID))

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在新工作树中继续' }))

    await waitFor(() => expect(productTaskMocks.continueTask).toHaveBeenCalledWith(TASK_ID, {
      target: 'new_worktree',
    }))
    expect(useTabStore.getState().activeTabId).toBe('__product_task__continued-task')
  })

  it('keeps the collapsed-sidebar control in the product task shell', () => {
    useUIStore.setState({ sidebarOpen: false })
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))

    expect(useUIStore.getState().sidebarOpen).toBe(true)
    expect(screen.getByTestId('window-controls')).toBeInTheDocument()
  })
})
