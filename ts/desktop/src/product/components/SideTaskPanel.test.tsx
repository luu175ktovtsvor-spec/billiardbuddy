import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ProductSideTask, ProductTaskRecord } from '../domain/types'
import { productSideTasksApi } from '../api/sideTasks'
import { useProductSideTaskStore } from '../stores/productSideTaskStore'

const mocks = vi.hoisted(() => ({
  connectTask: vi.fn(),
  disconnectTask: vi.fn(),
  sendText: vi.fn(),
  stopTask: vi.fn(),
  respondToApproval: vi.fn(),
  respondToQuestions: vi.fn(),
  respondToComputerUseApproval: vi.fn(),
  runtimes: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('../stores/productTaskRuntimeStore', () => ({
  PRODUCT_TASK_SAFE_ERROR_LABEL: {},
  canSendProductTaskText: (value: string) => Boolean(value.trim()),
  useProductTaskRuntimeStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    tasks: mocks.runtimes,
    connectTask: mocks.connectTask,
    disconnectTask: mocks.disconnectTask,
    sendText: mocks.sendText,
    stopTask: mocks.stopTask,
    respondToApproval: mocks.respondToApproval,
    respondToQuestions: mocks.respondToQuestions,
    respondToComputerUseApproval: mocks.respondToComputerUseApproval,
  }),
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { chatSendBehavior: 'enter' }) => unknown) => selector({
    chatSendBehavior: 'enter',
  }),
}))

vi.mock('./ProductTaskPage', () => ({
  ProductTaskThreadEntryView: ({ entry }: { entry: { text?: string } }) => (
    <div data-testid="side-task-thread-entry">{entry.text ?? ''}</div>
  ),
  ProductTaskApprovalCard: () => <div data-testid="side-task-approval" />,
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
    taskId: 'task-side-1',
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

function makeRuntime(entries: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    historyStatus: 'ready',
    entries,
    runState: 'idle',
    streamingEntryId: null,
    pendingApproval: null,
    approvalResponsePending: false,
    error: null,
  }
}

describe('SideTaskPanel', () => {
  beforeEach(() => {
    resetSideTaskStore()
    vi.clearAllMocks()
    mocks.runtimes = {}
    mocks.connectTask.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    resetSideTaskStore()
  })

  it('renders a safe error when loading side tasks fails upstream', async () => {
    const rawError = 'DeepSeek provider rejected /private/.claude/settings.json token'
    useProductSideTaskStore.setState({
      panelByParentTaskId: {
        [parentTaskId]: { isOpen: true },
      },
    })
    vi.mocked(productSideTasksApi.list).mockRejectedValue(new Error(rawError))

    render(<SideTaskPanel parentTask={makeParentTask()} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('暂时无法读取侧边任务，请稍后重试。')
    expect(alert).not.toHaveTextContent(rawError)
  })

  it('connects the selected temporary fork through its product task stream while closing it', async () => {
    const firstSideTask = makeSideTask()
    const secondSideTask = makeSideTask({
      id: 'side-2',
      taskId: 'task-side-2',
      title: '比较两套练习安排',
    })
    mocks.runtimes = {
      [firstSideTask.taskId]: makeRuntime([{
        id: 'entry-1',
        type: 'assistant_text',
        text: '已列出优惠规则。',
        createdAt: '2026-07-19T00:00:00.000Z',
      }]),
      [secondSideTask.taskId]: makeRuntime(),
    }
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

    await waitFor(() => expect(mocks.connectTask).toHaveBeenCalledWith(firstSideTask.taskId))
    expect(screen.getByTestId('side-task-thread-entry')).toHaveTextContent('已列出优惠规则。')

    fireEvent.click(screen.getByRole('button', { name: `Close side task ${firstSideTask.title}` }))

    await waitFor(() => expect(productSideTasksApi.close).toHaveBeenCalledWith(parentTaskId, firstSideTask.id))
    expect(mocks.disconnectTask).toHaveBeenCalledWith(firstSideTask.taskId)
    await waitFor(() => expect(mocks.connectTask).toHaveBeenCalledWith(secondSideTask.taskId))
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

    mocks.runtimes = { [sideTask.taskId]: makeRuntime() }
    await waitFor(() => expect(mocks.connectTask).toHaveBeenCalledWith(sideTask.taskId))
    fireEvent.click(screen.getByRole('button', { name: 'Close side-task panel' }))

    expect(useProductSideTaskStore.getState().panelByParentTaskId[parentTaskId]).toEqual({ isOpen: false })
    await waitFor(() => expect(mocks.disconnectTask).toHaveBeenCalledWith(sideTask.taskId))
  })

  it('sends and stops a side task through its public product task reference', async () => {
    const sideTask = makeSideTask({ taskId: 'task-public-side-73' })
    const runtime = makeRuntime()
    runtime.runState = 'working'
    mocks.runtimes = { [sideTask.taskId]: runtime }
    mocks.sendText.mockReturnValue(true)
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

    await waitFor(() => expect(mocks.connectTask).toHaveBeenCalledWith('task-public-side-73'))
    fireEvent.change(screen.getByLabelText('继续侧边任务'), { target: { value: '核对价格表' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    fireEvent.click(screen.getByRole('button', { name: '停止' }))

    expect(mocks.sendText).toHaveBeenCalledWith('task-public-side-73', '核对价格表')
    expect(mocks.stopTask).toHaveBeenCalledWith('task-public-side-73')
  })
})
