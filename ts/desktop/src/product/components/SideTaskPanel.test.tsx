import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ProductSideTask, ProductTaskRecord } from '../domain/types'
import { productSideTasksApi } from '../api/sideTasks'
import { useProductSideTaskStore } from '../stores/productSideTaskStore'

const mocks = vi.hoisted(() => ({
  connectToSession: vi.fn(),
  disconnectSession: vi.fn(),
}))

vi.mock('../../components/chat/MessageList', () => ({
  MessageList: ({
    sessionId,
    compact,
    enableProductActions,
  }: {
    sessionId?: string
    compact?: boolean
    enableProductActions?: boolean
  }) => (
    <div
      data-testid="side-task-message-list"
      data-session-id={sessionId}
      data-compact={String(compact)}
      data-enable-product-actions={String(enableProductActions)}
    />
  ),
}))

vi.mock('../../components/chat/ChatInput', () => ({
  ChatInput: ({ sessionId, workDir, compact }: { sessionId?: string; workDir?: string; compact?: boolean }) => (
    <div
      data-testid="side-task-chat-input"
      data-session-id={sessionId}
      data-work-dir={workDir}
      data-compact={String(compact)}
    />
  ),
}))

vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      connectToSession: mocks.connectToSession,
      disconnectSession: mocks.disconnectSession,
    }),
  },
}))

vi.mock('../api/sideTasks', () => ({
  productSideTasksApi: {
    list: vi.fn(),
    create: vi.fn(),
    close: vi.fn(),
  },
}))

import { SideTaskPanel } from './SideTaskPanel'

const parentTaskId = 'task-1'

function makeParentTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: parentTaskId,
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

function makeSideTask(overrides: Partial<ProductSideTask> = {}): ProductSideTask {
  return {
    id: 'side-1',
    parentTaskId,
    sourceTurnId: 'message-42',
    coreSessionId: 'session-side-1',
    title: '单独核对优惠规则',
    status: 'open',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  }
}

function resetSideTaskStore() {
  useProductSideTaskStore.setState({
    sideTasksByParentTaskId: {},
    loadingByParentTaskId: {},
    errorsByParentTaskId: {},
    mutations: {},
    panelByParentTaskId: {},
  })
}

describe('SideTaskPanel', () => {
  beforeEach(() => {
    resetSideTaskStore()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    resetSideTaskStore()
  })

  it('connects the selected temporary fork and keeps it embedded while closing it', async () => {
    const firstSideTask = makeSideTask()
    const secondSideTask = makeSideTask({
      id: 'side-2',
      coreSessionId: 'session-side-2',
      title: '比较两套练习安排',
    })
    const closedFirstSideTask = makeSideTask({
      status: 'closed',
      closedAt: '2026-07-19T00:05:00.000Z',
    })

    useProductSideTaskStore.setState({
      sideTasksByParentTaskId: { [parentTaskId]: [firstSideTask, secondSideTask] },
      panelByParentTaskId: {
        [parentTaskId]: {
          isOpen: true,
          selectedSideTaskId: firstSideTask.id,
        },
      },
    })
    vi.mocked(productSideTasksApi.list).mockResolvedValue({ sideTasks: [firstSideTask, secondSideTask] })
    vi.mocked(productSideTasksApi.close).mockResolvedValue({ sideTask: closedFirstSideTask })

    render(<SideTaskPanel parentTask={makeParentTask()} />)

    await waitFor(() => expect(mocks.connectToSession).toHaveBeenCalledWith(firstSideTask.coreSessionId))
    expect(screen.getByTestId('side-task-message-list')).toHaveAttribute('data-session-id', firstSideTask.coreSessionId)
    expect(screen.getByTestId('side-task-message-list')).toHaveAttribute('data-compact', 'true')
    expect(screen.getByTestId('side-task-message-list')).toHaveAttribute('data-enable-product-actions', 'false')
    expect(screen.getByTestId('side-task-chat-input')).toHaveAttribute('data-session-id', firstSideTask.coreSessionId)
    expect(screen.getByTestId('side-task-chat-input')).toHaveAttribute('data-work-dir', '/workspace/billiard')
    expect(screen.getByTestId('side-task-chat-input')).toHaveAttribute('data-compact', 'true')

    fireEvent.click(screen.getByRole('button', { name: `关闭侧边任务 ${firstSideTask.title}` }))

    await waitFor(() => expect(productSideTasksApi.close).toHaveBeenCalledWith(parentTaskId, firstSideTask.id))
    expect(mocks.disconnectSession).toHaveBeenCalledWith(firstSideTask.coreSessionId)
    await waitFor(() => expect(mocks.connectToSession).toHaveBeenCalledWith(secondSideTask.coreSessionId))
    expect(screen.getByTestId('side-task-message-list')).toHaveAttribute('data-session-id', secondSideTask.coreSessionId)
    expect(useProductSideTaskStore.getState().panelByParentTaskId[parentTaskId]).toEqual({
      isOpen: true,
      selectedSideTaskId: secondSideTask.id,
    })
  })

  it('hides only the panel when its close control is used', async () => {
    const sideTask = makeSideTask()
    useProductSideTaskStore.setState({
      sideTasksByParentTaskId: { [parentTaskId]: [sideTask] },
      panelByParentTaskId: {
        [parentTaskId]: {
          isOpen: true,
          selectedSideTaskId: sideTask.id,
        },
      },
    })
    vi.mocked(productSideTasksApi.list).mockResolvedValue({ sideTasks: [sideTask] })

    render(<SideTaskPanel parentTask={makeParentTask()} />)

    await waitFor(() => expect(mocks.connectToSession).toHaveBeenCalledWith(sideTask.coreSessionId))
    fireEvent.click(screen.getByRole('button', { name: '关闭侧边任务面板' }))

    expect(useProductSideTaskStore.getState().panelByParentTaskId[parentTaskId]).toEqual({ isOpen: false })
    expect(mocks.disconnectSession).not.toHaveBeenCalled()
  })
})
