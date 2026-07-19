import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useProductTaskStore } from '../../product/stores/productTaskStore'
import type { ProductTaskRecord } from '../../product/domain/types'

vi.mock('./WindowControls', () => ({
  WindowControls: () => null,
  showWindowControls: false,
}))

import { TopBar } from './TopBar'

const SESSION_ID = 'topbar-session'

const productTaskMocks = {
  archiveTask: vi.fn(),
  continueTask: vi.fn(),
  fetchSessions: vi.fn(),
  pinTask: vi.fn(),
  renameTask: vi.fn(),
  restoreTask: vi.fn(),
  unpinTask: vi.fn(),
  connectToSession: vi.fn(),
}

function makeProductTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: SESSION_ID,
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
  }
}

function setActiveProductTask(task = makeProductTask()) {
  useProductTaskStore.setState({
    index: {
      schemaVersion: 1,
      projects: [],
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
}

beforeEach(() => {
  vi.clearAllMocks()
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  useChatStore.setState(useChatStore.getInitialState(), true)
  useProductTaskStore.setState(useProductTaskStore.getInitialState(), true)
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useTerminalPanelStore.setState(useTerminalPanelStore.getInitialState(), true)
  useTabStore.setState({
    tabs: [{ sessionId: SESSION_ID, title: 'Panel task', type: 'session', status: 'idle' }],
    activeTabId: SESSION_ID,
  })
  useSessionStore.setState({
    sessions: [{
      id: SESSION_ID,
      title: 'Panel task',
      createdAt: '2026-07-18T00:00:00.000Z',
      modifiedAt: '2026-07-18T00:00:00.000Z',
      messageCount: 0,
      projectPath: '/workspace/panel-task',
      workDir: '/workspace/panel-task',
      workDirExists: true,
    }],
    activeSessionId: SESSION_ID,
    isLoading: false,
    error: null,
    fetchSessions: productTaskMocks.fetchSessions as never,
  })
  useChatStore.setState({ connectToSession: productTaskMocks.connectToSession as never })
  useSettingsStore.setState({ locale: 'en' })
  useUIStore.setState({ sidebarOpen: true, activeModal: null })
})

afterEach(() => {
  cleanup()
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  useChatStore.setState(useChatStore.getInitialState(), true)
  useProductTaskStore.setState(useProductTaskStore.getInitialState(), true)
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useTerminalPanelStore.setState(useTerminalPanelStore.getInitialState(), true)
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
})

describe('TopBar panel controls', () => {
  it('opens the dedicated task-search modal from search and recent-task controls', () => {
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
    expect(useUIStore.getState().activeModal).toBe('task-search')

    useUIStore.getState().closeModal()
    fireEvent.click(screen.getByRole('button', { name: 'Recent tasks' }))
    expect(useUIStore.getState().activeModal).toBe('task-search')
  })

  it('opens, selects, and closes browser and file panels independently', () => {
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Show Browser' }))

    expect(useBrowserPanelStore.getState().bySession[SESSION_ID]?.isOpen).toBe(true)
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(false)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('browser')

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))

    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')
    expect(useBrowserPanelStore.getState().bySession[SESSION_ID]?.isOpen).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Hide Workspace' }))
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(false)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('browser')

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')

    fireEvent.click(screen.getByRole('button', { name: 'Show Browser' }))
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('browser')

    fireEvent.click(screen.getByRole('button', { name: 'Hide Browser' }))

    expect(useBrowserPanelStore.getState().bySession[SESSION_ID]?.isOpen).toBe(false)
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')
  })

  it('surfaces only backend-enabled product task lifecycle actions in the active task menu', () => {
    setActiveProductTask()
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))

    expect(screen.getByRole('menuitem', { name: '复制任务 ID' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '重命名任务' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '置顶任务' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '在当前工作目录继续' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '在新工作树中继续' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '归档任务' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '恢复任务' })).not.toBeInTheDocument()
  })

  it('renames the real product task and synchronizes the opened task title', async () => {
    productTaskMocks.renameTask.mockResolvedValue(makeProductTask({ title: '更新后的任务名称' }))
    setActiveProductTask()
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名任务' }))
    fireEvent.change(screen.getByRole('textbox', { name: '任务名称' }), { target: { value: '更新后的任务名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(productTaskMocks.renameTask).toHaveBeenCalledWith(SESSION_ID, '更新后的任务名称'))
    expect(useTabStore.getState().tabs[0]?.title).toBe('更新后的任务名称')
    expect(useSessionStore.getState().sessions[0]?.title).toBe('更新后的任务名称')
  })

  it('archives and continues through the product task contract instead of a session-only placeholder', async () => {
    productTaskMocks.archiveTask.mockResolvedValue(makeProductTask({ lifecycle: 'archived', actions: ['restore', 'continue'] }))
    productTaskMocks.continueTask.mockResolvedValue(makeProductTask({
      id: 'continued-task',
      title: '继续 Panel task',
      kind: 'continuation',
      actions: ['archive', 'continue'],
    }))
    productTaskMocks.fetchSessions.mockResolvedValue(undefined)
    setActiveProductTask()
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '归档任务' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

    await waitFor(() => expect(productTaskMocks.archiveTask).toHaveBeenCalledWith(SESSION_ID))

    fireEvent.click(screen.getByRole('button', { name: '任务操作：Panel task' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在新工作树中继续' }))

    await waitFor(() => expect(productTaskMocks.continueTask).toHaveBeenCalledWith(SESSION_ID, {
      target: 'new_worktree',
    }))
    expect(productTaskMocks.fetchSessions).toHaveBeenCalledTimes(1)
    expect(productTaskMocks.connectToSession).toHaveBeenCalledWith('continued-task')
    expect(useTabStore.getState()).toMatchObject({ activeTabId: 'continued-task' })
  })
})
