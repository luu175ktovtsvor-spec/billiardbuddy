import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProductTaskRecord } from '../domain/types'
import type { TaskIndexProps } from './TaskIndex'

const mocks = vi.hoisted(() => ({
  taskIndexProps: null as unknown,
  taskComposerProps: null as unknown,
  events: [] as string[],
  refresh: vi.fn(),
  submitNewTask: vi.fn(),
  continueTask: vi.fn(),
  openTab: vi.fn(),
  openProductTaskTab: vi.fn(),
  openNewProductTask: vi.fn(),
  closeTab: vi.fn(),
  connectProductTask: vi.fn(),
  sendProductTaskMessage: vi.fn(),
  index: { projects: [], directories: [], tasks: [], total: 0, capabilities: { createTask: true } } as Record<string, unknown>,
  taskRuntimes: {} as Record<string, unknown>,
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
    submitNewTask: mocks.submitNewTask,
    renameTask: vi.fn(),
    pinTask: vi.fn(),
    unpinTask: vi.fn(),
    archiveTask: vi.fn(),
    restoreTask: vi.fn(),
    continueTask: mocks.continueTask,
  }),
}))

vi.mock('../stores/productTaskRuntimeStore', () => ({
  useProductTaskRuntimeStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ tasks: mocks.taskRuntimes }),
    {
      getState: () => ({
        connectTask: mocks.connectProductTask,
        sendMessage: mocks.sendProductTaskMessage,
      }),
    },
  ),
}))

vi.mock('../../stores/tabStore', () => ({
  PRODUCT_TASKS_TAB_ID: '__product_tasks__',
  NEW_PRODUCT_TASK_TAB_ID: '__new_product_task__',
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openTab: mocks.openTab,
    openProductTaskTab: mocks.openProductTaskTab,
    openNewProductTask: mocks.openNewProductTask,
    closeTab: mocks.closeTab,
    tabs: mocks.tabs,
  }),
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
    directoryId: overrides.directoryId ?? 'directory-1',
  }
}

function taskIndexProps(): TaskIndexProps {
  expect(mocks.taskIndexProps).not.toBeNull()
  return mocks.taskIndexProps as TaskIndexProps
}

function taskComposerProps(): {
  initialWorkDir?: string
  onCancel: () => void
  onSubmit: (input: { text: string; attachment_ids: string[] }) => Promise<void>
} {
  expect(mocks.taskComposerProps).not.toBeNull()
  return mocks.taskComposerProps as {
    initialWorkDir?: string
    onCancel: () => void
    onSubmit: (input: { text: string; attachment_ids: string[] }) => Promise<void>
  }
}

beforeEach(() => {
  mocks.taskIndexProps = null
  mocks.taskComposerProps = null
  mocks.events.length = 0
  mocks.index = { projects: [], directories: [], tasks: [], total: 0, capabilities: { createTask: true } }
  mocks.taskRuntimes = {}
  mocks.tabs = []
  mocks.refresh.mockResolvedValue(undefined)
  mocks.submitNewTask.mockImplementation(async () => {
    mocks.events.push('submit')
    return makeTask()
  })
  mocks.continueTask.mockImplementation(async () => {
    mocks.events.push('continue')
    return makeTask({ id: 'task-2', title: '继续整理开球训练' })
  })
  mocks.openTab.mockImplementation(() => {
    mocks.events.push('open-tab')
  })
  mocks.openProductTaskTab.mockImplementation(() => {
    mocks.events.push('open-product-task')
  })
  mocks.openNewProductTask.mockReset()
  mocks.closeTab.mockReset()
  mocks.connectProductTask.mockImplementation(() => {
    mocks.events.push('connect-product-task')
  })
  mocks.sendProductTaskMessage.mockImplementation(() => {
    mocks.events.push('send-product-message')
    return true
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

  it('opens an existing task in the dedicated product task surface', () => {
    render(<ProductShell />)
    const task = makeTask()

    taskIndexProps().onOpenTask(task)

    expect(mocks.openProductTaskTab).toHaveBeenCalledWith('task-1', '整理开球训练')
    expect(mocks.events).toEqual(['open-product-task'])
  })

  it('projects the product task stream state into the task index', () => {
    mocks.index = {
      projects: [],
      directories: [],
      tasks: [makeTask()],
      total: 1,
      capabilities: { createTask: true },
    }
    mocks.taskRuntimes = {
      'task-1': {
        connectionState: 'connected',
        runState: 'awaiting_approval',
        pendingApproval: { requestId: 'permission-1', kind: 'action' },
        error: null,
      },
    }

    render(<ProductShell />)

    expect(taskIndexProps().runtimeStatesBySessionId).toEqual({
      'task-1': 'awaiting_approval',
    })
  })

  it('surfaces a product stream error through the task index', () => {
    mocks.index = {
      projects: [],
      directories: [],
      tasks: [makeTask()],
      total: 1,
      capabilities: { createTask: true },
    }
    mocks.taskRuntimes = {
      'task-1': {
        connectionState: 'connected',
        runState: 'idle',
        pendingApproval: null,
        error: { code: 'task_failed' },
      },
    }

    render(<ProductShell />)

    expect(taskIndexProps().runtimeStatesBySessionId).toEqual({
      'task-1': 'needs_attention',
    })
  })

  it('opens the resulting product task after continuing a task', async () => {
    render(<ProductShell />)

    await act(async () => {
      await taskIndexProps().onContinueTask('task-1', {})
    })

    expect(mocks.continueTask).toHaveBeenCalledWith('task-1', {})
    expect(mocks.openProductTaskTab).toHaveBeenCalledWith('task-2', '继续整理开球训练')
    expect(mocks.events).toEqual(['continue', 'open-product-task'])
  })

  it('submits atomically, then opens and connects the resulting product task without a raw message transport', async () => {
    render(<ProductShell page="new-task" />)
    const input = { text: '请整理本周开球训练计划', attachment_ids: [] }

    await act(async () => {
      await taskComposerProps().onSubmit(input)
    })

    expect(mocks.submitNewTask).toHaveBeenCalledWith(input)
    expect(mocks.openProductTaskTab).toHaveBeenCalledWith('task-1', '整理开球训练')
    expect(mocks.connectProductTask).toHaveBeenCalledWith('task-1')
    expect(mocks.sendProductTaskMessage).not.toHaveBeenCalled()
    expect(mocks.closeTab).toHaveBeenCalledWith('__new_product_task__')
    expect(mocks.events).toEqual(['submit', 'open-product-task', 'connect-product-task'])
  })

  it('keeps attachment IDs in the atomic submit contract and never forwards raw attachment bytes', async () => {
    render(<ProductShell page="new-task" initialWorkDir="/workspace/billiard" />)
    const input = { text: '识别球台照片', attachment_ids: ['attachment-1'] }

    await act(async () => {
      await taskComposerProps().onSubmit(input)
    })

    expect(mocks.submitNewTask).toHaveBeenCalledWith(input)
    expect(mocks.sendProductTaskMessage).not.toHaveBeenCalled()
    expect(taskComposerProps().initialWorkDir).toBe('/workspace/billiard')
    expect(mocks.events).toEqual(['submit', 'open-product-task', 'connect-product-task'])
  })

  it('returns to the task index and closes the dedicated tab when creation is cancelled', () => {
    render(<ProductShell page="new-task" />)

    taskComposerProps().onCancel()

    expect(mocks.openTab).toHaveBeenCalledWith('__product_tasks__', '任务中心', 'product-tasks')
    expect(mocks.closeTab).toHaveBeenCalledWith('__new_product_task__')
  })
})
