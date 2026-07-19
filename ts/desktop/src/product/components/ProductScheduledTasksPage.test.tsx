import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ProductScheduledTask } from '../domain/types'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  run: vi.fn(),
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
    getRecentRuns: mocks.getRecentRuns,
    getTaskRuns: mocks.getTaskRuns,
  },
}))

vi.mock('../api/client', () => ({
  productApiUserFacingError: () => '安全提示',
}))

import { ProductScheduledTasksPage } from './ProductScheduledTasksPage'

function makeTask(overrides: Partial<ProductScheduledTask> = {}): ProductScheduledTask {
  return {
    id: 'schedule-1',
    title: '每日营业复盘',
    description: '汇总当天关键数据',
    schedule: '0 21 * * *',
    instruction: '整理今天的营业数据并给出明日建议。',
    enabled: true,
    recurring: true,
    createdAt: 1,
    notification: { enabled: true, channels: ['desktop'] },
    ...overrides,
  }
}

beforeEach(() => {
  mocks.list.mockResolvedValue({ tasks: [makeTask()] })
  mocks.create.mockResolvedValue({ task: makeTask({ id: 'schedule-2', title: '早班检查' }) })
  mocks.update.mockResolvedValue({ task: makeTask() })
  mocks.remove.mockResolvedValue({ ok: true })
  mocks.run.mockResolvedValue({ ok: true })
  mocks.getRecentRuns.mockResolvedValue({ runs: [] })
  mocks.getTaskRuns.mockResolvedValue({
    runs: [{
      id: 'run-1',
      taskId: 'schedule-1',
      taskTitle: '每日营业复盘',
      startedAt: '2026-07-19T12:00:00.000Z',
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
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      title: '早班检查',
      instruction: '检查球台、灯光和预约。',
      schedule: '0 9 * * *',
      recurring: true,
      enabled: true,
    })))
    expect(await screen.findByTestId('product-scheduled-task-schedule-2')).toHaveTextContent('早班检查')
  })
})
