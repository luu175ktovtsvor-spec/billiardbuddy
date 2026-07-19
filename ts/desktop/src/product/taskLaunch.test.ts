import { describe, expect, it, vi } from 'vitest'
import { continueProductTask, launchProductTask } from './taskLaunch'
import type { ProductTaskRecord } from './domain/types'

function makeTask(): ProductTaskRecord {
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
    actions: [],
  }
}

describe('launchProductTask', () => {
  it('creates through the product API, opens its task surface, and sends through the product transport', async () => {
    const task = makeTask()
    const events: string[] = []
    const createTask = vi.fn(async (input) => {
      events.push(`create:${JSON.stringify(input)}`)
      return task
    })
    const openTask = vi.fn(() => { events.push('open') })
    const connectTask = vi.fn(() => { events.push('connect') })
    const sendMessage = vi.fn(() => {
      events.push('send')
      return true
    })
    const input = {
      workDir: '/workspace/billiard',
      title: '整理开球训练',
      useWorktree: true,
    }

    await expect(launchProductTask({
      createTask,
      openTask,
      connectTask,
      sendMessage,
    }, input, { text: '  请整理本周开球训练计划  ' })).resolves.toBe(task)

    expect(createTask).toHaveBeenCalledWith(input)
    expect(sendMessage).toHaveBeenCalledWith('task-1', '请整理本周开球训练计划', [])
    expect(events).toEqual([
      `create:${JSON.stringify(input)}`,
      'open',
      'connect',
      'send',
    ])
  })

  it('connects a blank task without sending an empty initial message', async () => {
    const task = makeTask()
    const sendMessage = vi.fn(() => true)
    const connectTask = vi.fn()

    await launchProductTask({
      createTask: vi.fn(async () => task),
      openTask: vi.fn(),
      connectTask,
      sendMessage,
    }, { workDir: '/workspace/billiard' }, { text: '   ' })

    expect(connectTask).toHaveBeenCalledWith('task-1')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('forwards a selected slash command as the initial Agent message, not as product task data', async () => {
    const task = makeTask()
    const createTask = vi.fn(async () => task)
    const sendMessage = vi.fn(() => true)
    const input = {
      workDir: '/workspace/billiard',
      title: '复盘今天经营',
    }

    await launchProductTask({
      createTask,
      openTask: vi.fn(),
      connectTask: vi.fn(),
      sendMessage,
    }, input, { text: ' /venue-daily-review 今天营业额和昨天对比 ' })

    expect(createTask).toHaveBeenCalledWith(input)
    expect(sendMessage).toHaveBeenCalledWith(
      'task-1',
      '/venue-daily-review 今天营业额和昨天对比',
      [],
    )
  })

  it('sends bounded inline attachments through the product transport even when the initial text is blank', async () => {
    const task = makeTask()
    const createTask = vi.fn(async () => task)
    const sendMessage = vi.fn(() => true)
    const attachments = [
      {
        type: 'image' as const,
        name: '开球站位.png',
        data: 'data:image/png;base64,cG9zaXRpb24=',
        mimeType: 'image/png',
      },
    ]
    const input = { workDir: '/workspace/billiard', title: '复盘开球' }

    await launchProductTask({
      createTask,
      openTask: vi.fn(),
      connectTask: vi.fn(),
      sendMessage,
    }, input, { text: '   ', attachments })

    expect(createTask).toHaveBeenCalledWith(input)
    expect(sendMessage).toHaveBeenCalledWith('task-1', '', attachments)
  })

  it('continues through the product task contract and opens the resulting product task', async () => {
    const task = makeTask()
    const events: string[] = []
    const continueTask = vi.fn(async () => {
      events.push('continue')
      return task
    })
    const openTask = vi.fn(() => { events.push('open') })

    await expect(continueProductTask({
      continueTask,
      openTask,
    }, 'task-1', { sourceEntryId: 'thread_0123456789abcdef0123' })).resolves.toBe(task)

    expect(continueTask).toHaveBeenCalledWith('task-1', {
      sourceEntryId: 'thread_0123456789abcdef0123',
    })
    expect(openTask).toHaveBeenCalledWith(task)
    expect(events).toEqual(['continue', 'open'])
  })
})
