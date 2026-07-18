import { describe, expect, it, vi } from 'vitest'
import { launchProductTask } from './taskLaunch'
import type { ProductTaskRecord } from './domain/types'

function makeTask(): ProductTaskRecord {
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
    actions: [],
  }
}

describe('launchProductTask', () => {
  it('creates through the product API input, then opens, connects, and sends the optional initial goal', async () => {
    const task = makeTask()
    const events: string[] = []
    const createTask = vi.fn(async (input) => {
      events.push(`create:${JSON.stringify(input)}`)
      return task
    })
    const refreshSessions = vi.fn(async () => { events.push('refresh') })
    const openTask = vi.fn(() => { events.push('open') })
    const connectToSession = vi.fn(() => { events.push('connect') })
    const sendMessage = vi.fn(() => { events.push('send') })
    const input = {
      workDir: '/workspace/billiard',
      title: '整理开球训练',
      useWorktree: true,
    }

    await expect(launchProductTask({
      createTask,
      refreshSessions,
      openTask,
      connectToSession,
      sendMessage,
    }, input, { text: '  请整理本周开球训练计划  ' })).resolves.toBe(task)

    expect(createTask).toHaveBeenCalledWith(input)
    expect(sendMessage).toHaveBeenCalledWith('session-1', '请整理本周开球训练计划', [])
    expect(events).toEqual([
      `create:${JSON.stringify(input)}`,
      'refresh',
      'open',
      'connect',
      'send',
    ])
  })

  it('connects a blank task without sending an empty initial message', async () => {
    const task = makeTask()
    const sendMessage = vi.fn()
    const connectToSession = vi.fn()

    await launchProductTask({
      createTask: vi.fn(async () => task),
      refreshSessions: vi.fn(async () => undefined),
      openTask: vi.fn(),
      connectToSession,
      sendMessage,
    }, { workDir: '/workspace/billiard' }, { text: '   ' })

    expect(connectToSession).toHaveBeenCalledWith('session-1')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('forwards a selected slash command as the initial Agent message, not as product task data', async () => {
    const task = makeTask()
    const createTask = vi.fn(async () => task)
    const sendMessage = vi.fn()
    const input = {
      workDir: '/workspace/billiard',
      title: '复盘今天经营',
    }

    await launchProductTask({
      createTask,
      refreshSessions: vi.fn(async () => undefined),
      openTask: vi.fn(),
      connectToSession: vi.fn(),
      sendMessage,
    }, input, { text: ' /venue-daily-review 今天营业额和昨天对比 ' })

    expect(createTask).toHaveBeenCalledWith(input)
    expect(sendMessage).toHaveBeenCalledWith(
      'session-1',
      '/venue-daily-review 今天营业额和昨天对比',
      [],
    )
  })

  it('sends attachment refs through the real chat path even when the initial text is blank', async () => {
    const task = makeTask()
    const createTask = vi.fn(async () => task)
    const sendMessage = vi.fn()
    const attachments = [
      {
        type: 'image' as const,
        name: '开球站位.png',
        data: 'data:image/png;base64,cG9zaXRpb24=',
        mimeType: 'image/png',
      },
      {
        type: 'file' as const,
        name: '训练记录.csv',
        path: '/workspace/billiard/训练记录.csv',
      },
    ]
    const input = { workDir: '/workspace/billiard', title: '复盘开球' }

    await launchProductTask({
      createTask,
      refreshSessions: vi.fn(async () => undefined),
      openTask: vi.fn(),
      connectToSession: vi.fn(),
      sendMessage,
    }, input, { text: '   ', attachments })

    expect(createTask).toHaveBeenCalledWith(input)
    expect(sendMessage).toHaveBeenCalledWith('session-1', '', attachments)
  })
})
