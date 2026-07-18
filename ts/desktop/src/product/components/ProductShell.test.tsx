import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateProductTaskInput, ProductTaskRecord } from '../domain/types'
import type { TaskIndexProps } from './TaskIndex'

const mocks = vi.hoisted(() => ({
  taskIndexProps: null as unknown,
  events: [] as string[],
  refresh: vi.fn(),
  consumeTaskComposerRequest: vi.fn(),
  createTask: vi.fn(),
  continueTask: vi.fn(),
  refreshSessions: vi.fn(),
  openTab: vi.fn(),
  connectToSession: vi.fn(),
  sendMessage: vi.fn(),
  index: { projects: [], tasks: [], total: 0, capabilities: { createTask: true } } as Record<string, unknown>,
  chatSessions: {} as Record<string, unknown>,
  tabs: [] as Array<Record<string, unknown>>,
}))

vi.mock('./TaskIndex', () => ({
  TaskIndex: (props: unknown) => {
    mocks.taskIndexProps = props
    return null
  },
}))

vi.mock('../stores/productTaskStore', () => ({
  useProductTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    index: mocks.index,
    isLoading: false,
    error: null,
    mutations: {},
    composerRequest: null,
    refresh: mocks.refresh,
    consumeTaskComposerRequest: mocks.consumeTaskComposerRequest,
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
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openTab: mocks.openTab,
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

import { ProductShell } from './ProductShell'

function makeTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-1',
    workDir: '/workspace/billiard',
    title: '整理开球训练',
    coreSessionId: 'session-1',
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

beforeEach(() => {
  mocks.taskIndexProps = null
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
    return makeTask({ id: 'task-2', coreSessionId: 'session-2', title: '继续整理开球训练' })
  })
  mocks.refreshSessions.mockImplementation(async () => {
    mocks.events.push('refresh-sessions')
  })
  mocks.openTab.mockImplementation(() => {
    mocks.events.push('open-tab')
  })
  mocks.connectToSession.mockImplementation(() => {
    mocks.events.push('connect')
  })
  mocks.sendMessage.mockImplementation(() => {
    mocks.events.push('send-message')
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProductShell', () => {
  it('opens an existing product task and explicitly connects its core session', () => {
    render(<ProductShell />)
    const task = makeTask()

    taskIndexProps().onOpenTask(task)

    expect(mocks.openTab).toHaveBeenCalledWith('session-1', '整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledWith('session-1')
    expect(mocks.events).toEqual(['open-tab', 'connect'])
  })

  it('projects the real Agent Core session state into the task index', () => {
    mocks.index = {
      projects: [],
      tasks: [makeTask()],
      total: 1,
      capabilities: { createTask: true },
    }
    mocks.chatSessions = {
      'session-1': {
        chatState: 'permission_pending',
        connectionState: 'connected',
        pendingPermission: null,
        pendingComputerUsePermission: null,
        backgroundAgentTasks: {},
      },
    }

    render(<ProductShell />)

    expect(taskIndexProps().runtimeStatesBySessionId).toEqual({
      'session-1': 'awaiting_approval',
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
      'session-1': {
        chatState: 'idle',
        connectionState: 'connected',
        pendingPermission: null,
        pendingComputerUsePermission: null,
        backgroundAgentTasks: {},
      },
    }
    mocks.tabs = [{ sessionId: 'session-1', title: '整理开球训练', type: 'session', status: 'error' }]

    render(<ProductShell />)

    expect(taskIndexProps().runtimeStatesBySessionId).toEqual({
      'session-1': 'needs_attention',
    })
  })

  it('refreshes and connects the real continuation session after continuing a task', async () => {
    render(<ProductShell />)

    await act(async () => {
      await taskIndexProps().onContinueTask('task-1', {})
    })

    expect(mocks.continueTask).toHaveBeenCalledWith('task-1', {})
    expect(mocks.refreshSessions).toHaveBeenCalledTimes(1)
    expect(mocks.openTab).toHaveBeenCalledWith('session-2', '继续整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledWith('session-2')
    expect(mocks.events).toEqual(['continue', 'refresh-sessions', 'open-tab', 'connect'])
  })

  it('keeps creation on the original open, connect, then initial-message path without reconnecting', async () => {
    render(<ProductShell />)
    const input: CreateProductTaskInput = {
      workDir: '/workspace/billiard',
      title: '整理开球训练',
    }

    await act(async () => {
      await taskIndexProps().onCreateTask(input, { text: '请整理本周开球训练计划' })
    })

    expect(mocks.openTab).toHaveBeenCalledWith('session-1', '整理开球训练', 'session')
    expect(mocks.connectToSession).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', '请整理本周开球训练计划', [])
    expect(mocks.events).toEqual(['create', 'refresh-sessions', 'open-tab', 'connect', 'send-message'])
  })

  it('forwards initial attachment refs to the existing chat store without putting them into task creation', async () => {
    render(<ProductShell />)
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
      await taskIndexProps().onCreateTask(input, { attachments })
    })

    expect(mocks.createTask).toHaveBeenCalledWith(input)
    expect(mocks.sendMessage).toHaveBeenCalledWith('session-1', '', attachments)
    expect(mocks.events).toEqual(['create', 'refresh-sessions', 'open-tab', 'connect', 'send-message'])
  })
})
