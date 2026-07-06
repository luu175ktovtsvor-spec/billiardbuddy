import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from './taskService'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('TaskService starts async runner, persists metadata and event log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-'))
  try {
    const tasks = new TaskService(root)
    const task = await tasks.create({ id: 't1', title: '后台研究', conversationId: 'c1', workspaceRoot: root })
    expect(task.status).toBe('queued')

    tasks.start('t1', async ctx => {
      await ctx.emit({ type: 'thinking', text: '研究中' })
      await ctx.emit({ type: 'final', text: '研究完成' })
      return '研究完成'
    })

    const done = await waitFor(async () => {
      const meta = await tasks.get('t1')
      return meta?.status === 'completed' ? meta : null
    })
    expect(done.result).toBe('研究完成')
    expect((await tasks.list({ conversationId: 'c1' })).map(t => t.id)).toEqual(['t1'])
    expect((await tasks.loadEvents('t1')).map(e => e.event.type)).toEqual(['started', 'thinking', 'final', 'done'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskService can cancel a running task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tasks-cancel-'))
  try {
    const tasks = new TaskService(root)
    await tasks.create({ id: 't1', title: '长任务' })
    tasks.start('t1', async ctx => {
      await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
    })

    await waitFor(async () => (await tasks.get('t1'))?.status === 'running' ? { ok: true } : null)
    expect(await tasks.cancel('t1')).toBe(true)
    const cancelled = await waitFor(async () => {
      const meta = await tasks.get('t1')
      return meta?.status === 'cancelled' ? meta : null
    })
    expect(cancelled.status).toBe('cancelled')
    expect((await tasks.loadEvents('t1')).some(e => e.event.type === 'context_note')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
