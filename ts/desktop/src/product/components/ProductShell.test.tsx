import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateProductTaskInput, ProductTaskRecord } from '../domain/types'
import type { ProductTaskInitialMessage } from '../taskLaunch'
import type { TaskIndexProps } from './TaskIndex'

const mocks = vi.hoisted(() => ({
  taskIndexProps: null as unknown,
  taskComposerProps: null as unknown,
  events: [] as string[],
  refresh: vi.fn(),
  createTask: vi.fn(),
  continueTask: vi.fn(),
  refreshSessions: vi.fn(),
  openTab: vi.fn(),
  openNewProductTask: vi.fn(),
  closeTab: vi.fn(),
  connectToSession: vi.fn(),
  sendMessage: vi.fn(),
  setWorkspaceMode: vi.fn(),
  openWorkspace: vi.fn(),
  openTerminal: vi.fn(),
  index: { projects: [], tasks: [], total: 0, capabilities: { createTask: true } } as Record<string, unknown>,
  chatSessions: {} as Record<string, unknown>,
  tabs: [] as Array<Record<string, unknown>>,
}))

vi.mock('./TaskIndex', () => ({
  TaskIndex: (props: unknown) => {
    mocks.taskIndexProps = props
    return null
  },
  TaskComposer: (props: unknown) => {
    mocks.taskComposerProps = props
    return null
  },
}))

vi.mock('../stores/productTaskStore', () => ({
  useProductTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    index: mocks.index,
    isLoading: false,
    error: null,
    mutations: {},
    refresh: mocks.refresh,
    createTask: mocks.createTask,
    renameTask: vi.fn(),
    pinTask: vi.fn(),
    unpinTask: vi.fn(),
    archiveTask: vi.fn(),
    restoreTask: vi.fn(),
    continueTask: mocks.continueTask,
  }),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    fetchSessions: mocks.refreshSessions,
  }),
}))

vi.mock('../../stores/tabStore', () => ({
  PRODUCT_TASKS_TAB_ID: '__product_tasks__',
  NEW_PRODUCT_TASK_TAB_ID: '__new_product_task__',
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openTab: mocks.openTab,
    openNewProductTask: mocks.openNewProductTask,
    closeTab: mocks.closeTab,
    tabs: mocks.tabs,
  }),
}))

vi.mock('../../stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ sessions: mocks.chatSessions }),
    {
      getState: () => ({
      connectToSession: mocks.connectToSession,
      sendMessage: mocks.sendMessage,
      }),
    },
  ),
}))

vi.mock('../../stores/workspacePanelStore', () => ({
  useWorkspacePanelStore: {
    getState: () => ({
      setMode: mocks.setWorkspaceMode,
      openPanel: mocks.openWorkspace,
    }),
  },
}))

vi.mock('../../stores/terminalPanelStore', () => ({
  useTerminalPanelStore: {
    getState: () => ({
      openPanel: mocks.openTerminal,
    }),
  },
}))

import { ProductShell } from './ProductShell'

function makeTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-1',
    workDir: '/workspace/billiard',
    title: '整理开球训练',
    lifecycle: 'active',
    kind: 'main',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    worktreeState: 'not_requested',
    actions: ['continue'],
    ...overrides,
  }
}

function taskIndexProps(): TaskIndexProps {
  expect(mocks.taskIndexProps).not.toBeNull()
  return mocks.taskIndexProps as TaskIndexProps
}

function taskComposerProps(): {
  initialWorkDir?: string
  onCancel: () => void
  onSubmit: (input: CreateProductTaskInput, initialMessage?: ProductTaskInitialMessage) => Promise<void>
} {
  expect(mocks.taskComposerProps).not.toBeNull()
  return mocks.taskComposerProps as {
    initialWorkDir?: string
    onCancel: () => void
    onSubmit: (input: CreateProductTaskInput, initialMessage?: ProductTaskInitialMessage) => Promise<void>
  }
}

beforeEach(() => {
  mocks.taskIndexProps = null
  mocks.taskComposerProps = null
  mocks.events.length = 0
  mocks.index = { projects: [], tasks: [], total: 0, capabilities: { createTask: true } }
  mocks.chatSessions = {}
  mocks.tabs = []
  mocks.refresh.mockResolvedValue(undefined)
  mocks.createTask.mockImplementation(async () => {
    mocks.events.push('create')
    return makeTask()
  })
  mocks.continueTask.mockImplementation(async () => {
    mocks.events.push('continue')
    return makeTask({ id: 'task-2', title: '继续整理开球训练' })
  })
  mocks.refreshSessions.mockImplementation(async () => {
    mocks.events.push('refresh-sessions')
  })
  mocks.openTab.mockImplementation(() => {
    mocks.events.push('open-tab')
  })
  mocks.openNewProductTask.mockReset()
  mocks.closeTab.mockReset()
  mocks.connectToSession.mockImplementation(() => {
    mocks.events.push('connect')
  })
  mocks.sendMessage.mockImplementation(() => {
    mocks.events.push('send-message')
  })
  mocks.setWorkspaceMode.mockImplementation(() => {
    mocks.events.push('set-workspace-mode')
  })
  mocks.openWorkspace.mockImplementation(() => {
    mocks.events.push('open-workspace')
  })
  mocks.openTerminal.mockImplementation(() => {
    mocks.events.push('open-terminal')
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProductShell', () => {
  it('opens the dedicated new-task tab from the task index', () => {
    render(<ProductShell />)

    taskIndexProps().onRequestNewTask()

    expect(mocks.openNewProductTask).toHaveBeenCalledOnce()
  })

  it('opens an existing product task and explicitly connects its core session', () => {
    render(<ProductShell />)
    const task = makeTask()

    taskIndexProps().onOpenTask(task)

    expect(mocks.openTab).toHaveBeenCalledWith('task-1', '整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledWith('task-1')
    expect(mocks.events).toEqual(['open-tab', 'connect'])
  })

  it('opens the real task session before exposing its file workbench', () => {
    render(<ProductShell />)
    const task = makeTask()

    taskIndexProps().onOpenTaskWorkbench(task)

    expect(mocks.openTab).toHaveBeenCalledWith('task-1', '整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledWith('task-1')
    expect(mocks.setWorkspaceMode).toHaveBeenCalledWith('task-1', 'workspace')
    expect(mocks.openWorkspace).toHaveBeenCalledWith('task-1')
    expect(mocks.events).toEqual(['open-tab', 'connect', 'set-workspace-mode', 'open-workspace'])
  })

  it('opens the real task session before exposing its terminal', () => {
    render(<ProductShell />)
    const task = makeTask()

    taskIndexProps().onOpenTaskTerminal(task)

    expect(mocks.openTab).toHaveBeenCalledWith('task-1', '整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledWith('task-1')
    expect(mocks.openTerminal).toHaveBeenCalledWith('task-1')
    expect(mocks.events).toEqual(['open-tab', 'connect', 'open-terminal'])
  })

  it('projects the real Agent Core session state into the task index', () => {
    mocks.index = {
      projects: [],
      tasks: [makeTask()],
      total: 1,
      capabilities: { createTask: true },
    }
    mocks.chatSessions = {
      'task-1': {
        chatState: 'permission_pending',
        connectionState: 'connected',
        pendingPermission: null,
        pendingComputerUsePermission: null,
        backgroundAgentTasks: {},
      },
    }

    render(<ProductShell />)

    expect(taskIndexProps().runtimeStatesBySessionId).toEqual({
      'task-1': 'awaiting_approval',
    })
  })

  it('surfaces the real session tab error through the task index', () => {
    mocks.index = {
      projects: [],
      tasks: [makeTask()],
      total: 1,
      capabilities: { createTask: true },
    }
    mocks.chatSessions = {
      'task-1': {
        chatState: 'idle',
        connectionState: 'connected',
        pendingPermission: null,
        pendingComputerUsePermission: null,
        backgroundAgentTasks: {},
      },
    }
    mocks.tabs = [{ sessionId: 'task-1', title: '整理开球训练', type: 'session', status: 'error' }]

    render(<ProductShell />)

    expect(taskIndexProps().runtimeStatesBySessionId).toEqual({
      'task-1': 'needs_attention',
    })
  })

  it('refreshes and connects the real continuation session after continuing a task', async () => {
    render(<ProductShell />)

    await act(async () => {
      await taskIndexProps().onContinueTask('task-1', {})
    })

    expect(mocks.continueTask).toHaveBeenCalledWith('task-1', {})
    expect(mocks.refreshSessions).toHaveBeenCalledTimes(1)
    expect(mocks.openTab).toHaveBeenCalledWith('task-2', '继续整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledWith('task-2')
    expect(mocks.events).toEqual(['continue', 'refresh-sessions', 'open-tab', 'connect'])
  })

  it('keeps creation on the original open, connect, then initial-message path without reconnecting', async () => {
    render(<ProductShell page="new-task" />)
    const input: CreateProductTaskInput = {
      workDir: '/workspace/billiard',
      title: '整理开球训练',
    }

    await act(async () => {
      await taskComposerProps().onSubmit(input, { text: '请整理本周开球训练计划' })
    })

    expect(mocks.openTab).toHaveBeenCalledWith('task-1', '整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage).toHaveBeenCalledWith('task-1', '请整理本周开球训练计划', [])
    expect(mocks.closeTab).toHaveBeenCalledWith('__new_product_task__')
    expect(mocks.events).toEqual(['create', 'refresh-sessions', 'open-tab', 'connect', 'send-message'])
  })

  it('forwards initial attachment refs to the existing chat store without putting them into task creation', async () => {
    render(<ProductShell page="new-task" initialWorkDir="/workspace/billiard" />)
    const input: CreateProductTaskInput = {
      workDir: '/workspace/billiard',
      title: '识别球台照片',
    }
    const attachments = [{
      type: 'image' as const,
      name: '球台.png',
      data: 'data:image/png;base64,dGFibGU=',
      mimeType: 'image/png',
    }]

    await act(async () => {
      await taskComposerProps().onSubmit(input, { attachments })
    })

    expect(mocks.createTask).toHaveBeenCalledWith(input)
    expect(mocks.sendMessage).toHaveBeenCalledWith('task-1', '', attachments)
    expect(taskComposerProps().initialWorkDir).toBe('/workspace/billiard')
    expect(mocks.events).toEqual(['create', 'refresh-sessions', 'open-tab', 'connect', 'send-message'])
  })

  it('returns to the task index and closes the dedicated tab when creation is cancelled', () => {
    render(<ProductShell page="new-task" />)

    taskComposerProps().onCancel()

    expect(mocks.openTab).toHaveBeenCalledWith('__product_tasks__', '任务中心', 'product-tasks')
    expect(mocks.closeTab).toHaveBeenCalledWith('__new_product_task__')
  })
})
