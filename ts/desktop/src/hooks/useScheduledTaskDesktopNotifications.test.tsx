import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useScheduledTaskDesktopNotifications } from './useScheduledTaskDesktopNotifications'

const { listMock, getRecentRunsMock, notifyDesktopMock, serverReadyMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  getRecentRunsMock: vi.fn(),
  notifyDesktopMock: vi.fn(),
  serverReadyMock: vi.fn(),
}))

vi.mock('../product/api/scheduledTasks', () => ({
  productScheduledTasksApi: {
    list: listMock,
    getRecentRuns: getRecentRunsMock,
  },
}))

vi.mock('../lib/desktopNotifications', () => ({
  notifyDesktop: notifyDesktopMock,
}))

vi.mock('../lib/desktopRuntime', () => ({
  whenDesktopServerReady: serverReadyMock,
}))

function Harness() {
  useScheduledTaskDesktopNotifications()
  return null
}

describe('useScheduledTaskDesktopNotifications', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    listMock.mockReset()
    getRecentRunsMock.mockReset()
    notifyDesktopMock.mockReset()
    notifyDesktopMock.mockResolvedValue(true)
    serverReadyMock.mockReset()
    serverReadyMock.mockResolvedValue(undefined)
  })

  it('does not poll until the desktop server is ready', async () => {
    let resolveReady: () => void = () => {}
    serverReadyMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve
      }),
    )
    listMock.mockResolvedValue({ tasks: [] })
    getRecentRunsMock.mockResolvedValue({ runs: [] })

    render(<Harness />)

    // While the server is not ready, the poller must stay silent — this is the
    // regression guard for the startup race that logged "Failed to fetch" warnings.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listMock).not.toHaveBeenCalled()
    expect(getRecentRunsMock).not.toHaveBeenCalled()

    resolveReady()
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('does not notify old runs on first poll and notifies new desktop-enabled task runs later', async () => {
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'Daily review',
        schedule: '* * * * *',
        instruction: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock
      .mockResolvedValueOnce({
        runs: [{
          id: 'run-old',
          taskId: 'task-1',
          taskTitle: 'Daily review',
          startedAt: '2026-05-03T00:00:00.000Z',
          completedAt: '2026-05-03T00:00:01.000Z',
          status: 'completed',
          result: 'old result',
        }],
      })
      .mockResolvedValueOnce({
        runs: [
          {
            id: 'run-old',
            taskId: 'task-1',
            taskTitle: 'Daily review',
            startedAt: '2026-05-03T00:00:00.000Z',
            completedAt: '2026-05-03T00:00:01.000Z',
            status: 'completed',
            result: 'old result',
          },
          {
            id: 'run-new',
            taskId: 'task-1',
            taskTitle: 'Daily review',
            startedAt: '2026-05-03T00:01:00.000Z',
            completedAt: '2026-05-03T00:01:01.000Z',
            status: 'failed',
          },
        ],
      })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'scheduled-task:run-new',
      title: '定时任务 Daily review',
      body: '状态: 失败',
      target: { type: 'scheduled' },
    })
  })

  it('always targets the scheduled task page even when an old response carries a session id', async () => {
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'Daily review',
        schedule: '* * * * *',
        instruction: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({
        runs: [{
          id: 'run-new',
          taskId: 'task-1',
          taskTitle: 'Daily review',
          startedAt: '2026-05-03T00:01:00.000Z',
          completedAt: '2026-05-03T00:01:01.000Z',
          status: 'completed',
          result: 'done',
          // A stale older server can include this extra field; it must not
          // become a raw-session notification target.
          sessionId: 'session-task-run',
        }],
      })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))
    expect(notifyDesktopMock).toHaveBeenCalledWith({
      dedupeKey: 'scheduled-task:run-new',
      title: '定时任务 Daily review',
      body: '完成: done',
      target: { type: 'scheduled' },
    })
  })

  it('ignores task runs without the desktop notification channel', async () => {
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'IM only',
        schedule: '* * * * *',
        instruction: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: [] },
      }],
    })
    getRecentRunsMock.mockResolvedValue({
      runs: [{
        id: 'run-1',
        taskId: 'task-1',
        taskTitle: 'IM only',
        startedAt: '2026-05-03T00:00:00.000Z',
        completedAt: '2026-05-03T00:00:01.000Z',
        status: 'completed',
      }],
    })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(notifyDesktopMock).not.toHaveBeenCalled()
  })

  it('does not mark a run as notified when desktop notification delivery fails', async () => {
    notifyDesktopMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    listMock.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        title: 'Daily review',
        schedule: '* * * * *',
        instruction: 'review',
        enabled: true,
        createdAt: 1,
        notification: { enabled: true, channels: ['desktop'] },
      }],
    })
    getRecentRunsMock
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValue({
        runs: [{
          id: 'run-new',
          taskId: 'task-1',
          taskTitle: 'Daily review',
          startedAt: '2026-05-03T00:01:00.000Z',
          completedAt: '2026-05-03T00:01:01.000Z',
          status: 'completed',
        }],
      })

    render(<Harness />)
    await vi.waitFor(() => expect(getRecentRunsMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(notifyDesktopMock).toHaveBeenCalledTimes(2))
  })
})
