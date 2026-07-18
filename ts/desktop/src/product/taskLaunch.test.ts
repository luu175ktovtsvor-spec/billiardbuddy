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
    }, input, '  请整理本周开球训练计划  ')).resolves.toBe(task)

    expect(createTask).toHaveBeenCalledWith(input)
    expect(sendMessage).toHaveBeenCalledWith('session-1', '请整理本周开球训练计划')
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
    }, { workDir: '/workspace/billiard' }, '   ')

    expect(connectToSession).toHaveBeenCalledWith('session-1')
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
