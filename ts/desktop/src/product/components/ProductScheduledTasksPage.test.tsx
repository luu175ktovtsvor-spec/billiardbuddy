import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ProductScheduledTask, ProductScheduledTaskRun } from '../domain/types'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  run: vi.fn(),
  cancelRun: vi.fn(),
  getRecentRuns: vi.fn(),
  getTaskRuns: vi.fn(),
}))

vi.mock('../api/scheduledTasks', () => ({
  productScheduledTasksApi: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    delete: mocks.remove,
    run: mocks.run,
    cancelRun: mocks.cancelRun,
    getRecentRuns: mocks.getRecentRuns,
    getTaskRuns: mocks.getTaskRuns,
  },
}))

vi.mock('../api/client', () => ({
  productApiUserFacingError: () => '安全提示',
}))

vi.mock('../../components/shared/DirectoryPicker', () => ({
  DirectoryPicker: ({ onChange }: { onChange: (path: string) => void }) => (
    <button type="button" aria-label="选择工作目录" onClick={() => onChange('/workspace/billiard')}>选择工作目录</button>
  ),
}))

import { ProductScheduledTasksPage } from './ProductScheduledTasksPage'

function makeTask(overrides: Partial<ProductScheduledTask> = {}): ProductScheduledTask {
  return {
    id: 'schedule-1',
    title: '每日营业复盘',
    description: '汇总当天关键数据',
    schedule: '0 21 * * *',
    timeZone: 'Asia/Shanghai',
    instruction: '整理今天的营业数据并给出明日建议。',
    enabled: true,
    recurring: true,
    missedRunPolicy: 'run_once',
    context: { mode: 'independent' },
    grant: { version: 1, scope: 'workdir', fileAccess: 'workspace_write', networkAccess: 'denied', destructiveActions: 'denied' },
    workDir: '/workspace/billiard',
    createdAt: 1,
    notification: { enabled: true, channels: ['desktop'] },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.list.mockResolvedValue({ tasks: [makeTask()] })
  mocks.create.mockResolvedValue({ task: makeTask({ id: 'schedule-2', title: '早班检查' }) })
  mocks.update.mockResolvedValue({ task: makeTask() })
  mocks.remove.mockResolvedValue({ ok: true })
  mocks.run.mockResolvedValue({ ok: true })
  mocks.cancelRun.mockResolvedValue({ ok: true })
  mocks.getRecentRuns.mockResolvedValue({ runs: [] })
  mocks.getTaskRuns.mockResolvedValue({
    runs: [{
      id: 'run-1',
      taskId: 'schedule-1',
      taskTitle: '每日营业复盘',
      startedAt: '2026-07-19T12:00:00.000Z',
      occurrenceAt: '2026-07-19T12:00:00.000Z',
      trigger: 'schedule',
      completedAt: '2026-07-19T12:00:03.000Z',
      status: 'completed',
      result: '今日营业复盘已整理完成。',
      durationMs: 3_000,
    }],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ProductScheduledTasksPage', () => {
  it('renders bounded product task data and a safe run result', async () => {
    render(<ProductScheduledTasksPage />)

    expect(await screen.findByTestId('product-scheduled-task-schedule-1')).toHaveTextContent('每日营业复盘')
    expect(screen.getByText('完成后提醒')).toBeInTheDocument()
    expect(screen.queryByText(/provider/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '运行记录' }))
    expect(await screen.findByText('今日营业复盘已整理完成。')).toBeInTheDocument()
    expect(screen.queryByText(/private stderr/i)).not.toBeInTheDocument()
  })

  it('creates a real scheduled task through the product API', async () => {
    render(<ProductScheduledTasksPage />)
    await screen.findByTestId('product-scheduled-task-schedule-1')

    fireEvent.click(screen.getAllByRole('button', { name: '新建定时任务' })[0]!)
    await screen.findByRole('dialog', { name: '新建定时任务' })
    fireEvent.change(screen.getByLabelText(/任务名称/), { target: { value: '早班检查' } })
    fireEvent.change(screen.getByLabelText(/执行内容/), { target: { value: '检查球台、灯光和预约。' } })
    fireEvent.click(screen.getByRole('button', { name: '选择工作目录' }))
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      title: '早班检查',
      instruction: '检查球台、灯光和预约。',
      schedule: '0 9 * * *',
      recurring: true,
      enabled: true,
      workDir: '/workspace/billiard',
      missedRunPolicy: 'run_once',
      timeZone: expect.any(String),
      context: { mode: 'independent' },
    })))
    expect(await screen.findByTestId('product-scheduled-task-schedule-2')).toHaveTextContent('早班检查')
  })

  it('keeps a created task when an earlier list response returns late', async () => {
    const initialList = deferred<{ tasks: ProductScheduledTask[] }>()
    mocks.list.mockReturnValueOnce(initialList.promise)

    render(<ProductScheduledTasksPage />)

    fireEvent.click(screen.getByRole('button', { name: '新建定时任务' }))
    await screen.findByRole('dialog', { name: '新建定时任务' })
    fireEvent.change(screen.getByLabelText(/任务名称/), { target: { value: '早班检查' } })
    fireEvent.change(screen.getByLabelText(/执行内容/), { target: { value: '检查球台、灯光和预约。' } })
    fireEvent.click(screen.getByRole('button', { name: '选择工作目录' }))
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    expect(await screen.findByTestId('product-scheduled-task-schedule-2')).toHaveTextContent('早班检查')

    await act(async () => {
      initialList.resolve({ tasks: [makeTask()] })
    })

    expect(screen.getByTestId('product-scheduled-task-schedule-2')).toHaveTextContent('早班检查')
  })

  it('does not show one task\'s late run history under another task', async () => {
    const firstRuns = deferred<{ runs: ProductScheduledTaskRun[] }>()
    const secondRuns = deferred<{ runs: ProductScheduledTaskRun[] }>()
    const firstTask = makeTask()
    const secondTask = makeTask({ id: 'schedule-2', title: '早班检查' })
    mocks.list.mockResolvedValue({ tasks: [firstTask, secondTask] })
    mocks.getTaskRuns.mockImplementation((taskId: string) => (
      taskId === firstTask.id ? firstRuns.promise : secondRuns.promise
    ))

    render(<ProductScheduledTasksPage />)
    const firstCard = await screen.findByTestId('product-scheduled-task-schedule-1')
    const secondCard = await screen.findByTestId('product-scheduled-task-schedule-2')

    fireEvent.click(within(firstCard).getByRole('button', { name: '运行记录' }))
    await waitFor(() => expect(mocks.getTaskRuns).toHaveBeenCalledWith(firstTask.id))
    fireEvent.click(within(secondCard).getByRole('button', { name: '运行记录' }))
    await waitFor(() => expect(mocks.getTaskRuns).toHaveBeenCalledWith(secondTask.id))

    await act(async () => {
      secondRuns.resolve({
        runs: [{
          id: 'run-second',
          taskId: secondTask.id,
          taskTitle: secondTask.title,
          startedAt: '2026-07-19T12:01:00.000Z',
          occurrenceAt: '2026-07-19T12:01:00.000Z',
          trigger: 'schedule',
          status: 'completed',
          result: '早班检查已完成。',
        }],
      })
    })
    expect(await screen.findByText('早班检查已完成。')).toBeInTheDocument()

    await act(async () => {
      firstRuns.resolve({
        runs: [{
          id: 'run-first',
          taskId: firstTask.id,
          taskTitle: firstTask.title,
          startedAt: '2026-07-19T12:00:00.000Z',
          occurrenceAt: '2026-07-19T12:00:00.000Z',
          trigger: 'schedule',
          status: 'completed',
          result: '不应出现在早班检查中的旧结果。',
        }],
      })
    })

    expect(screen.queryByText('不应出现在早班检查中的旧结果。')).not.toBeInTheDocument()
    expect(screen.getByText('早班检查已完成。')).toBeInTheDocument()
  })
})
