import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { CronScheduler, resolveCronTaskTimeoutMs } from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'

const originalConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR

describe('cron scheduler durable ProductTask hand-off', () => {
  let root: string
  let cron: CronService

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-cron-worker-'))
    process.env.BILLIARDBUDDY_CONFIG_DIR = path.join(root, 'config')
    cron = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = originalConfigDir
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps the stale-run timeout configurable without owning an execution timeout', () => {
    expect(resolveCronTaskTimeoutMs({})).toBe(10 * 60 * 1000)
    expect(resolveCronTaskTimeoutMs({ BB_TASK_TIMEOUT_MS: '1800000' })).toBe(1_800_000)
    expect(resolveCronTaskTimeoutMs({ BB_TASK_TIMEOUT_MS: 'not-a-number' })).toBe(10 * 60 * 1000)
    expect(resolveCronTaskTimeoutMs({ BB_TASK_TIMEOUT_MS: '0' })).toBe(10 * 60 * 1000)
  })

  it('submits one canonical schedule occurrence through the durable run bridge', async () => {
    const submissions: Array<{ scheduleId: string; title: string; prompt: string; workDir: string; occurrence: string }> = []
    const scheduler = new CronScheduler(cron, {
      submitScheduledTaskRun: async (scheduleId, title, prompt, workDir, occurrence) => {
        submissions.push({ scheduleId, title, prompt, workDir, occurrence })
        return { task_id: 'task_durable', run_id: 'run_durable', dispatch_generation: 1 }
      },
    })
    const task = await cron.createTask({
      cron: '* * * * *',
      prompt: '生成今日经营摘要',
      recurring: false,
      folderPath: root,
    })

    const occurrenceAt = new Date('2026-07-24T06:05:00.000Z')
    const result = await scheduler.executeTask(task, { trigger: 'schedule', occurrenceAt })

    expect(result).toMatchObject({ status: 'running', output: '已提交到 ProductTask，正在执行', occurrenceAt: occurrenceAt.toISOString(), trigger: 'schedule' })
    expect(result).not.toHaveProperty('sessionId')
    expect(submissions).toEqual([{
      scheduleId: task.id,
      title: task.prompt,
      prompt: task.prompt,
      workDir: await fs.realpath(root),
      occurrence: occurrenceAt.toISOString(),
    }])
    expect((await cron.listTasks()).find(value => value.id === task.id)?.enabled).toBe(false)
  })

  it('does not create a second run while the same schedule hand-off is unsettled', async () => {
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const scheduler = new CronScheduler(cron, {
      submitScheduledTaskRun: async () => {
        calls += 1
        enter()
        await gate
        return { task_id: 'task_once', run_id: 'run_once', dispatch_generation: 1 }
      },
    })
    const task = await cron.createTask({
      cron: '* * * * *',
      prompt: '只提交一次',
      recurring: true,
      folderPath: root,
    })

    const first = scheduler.executeTask(task)
    const duplicate = await scheduler.executeTask(task)
    expect(duplicate.status).toBe('running')
    await entered
    expect(calls).toBe(1)

    release()
    expect((await first).status).toBe('running')
  })

  it('keeps a run active until the durable ProductTask reaches a real terminal state', async () => {
    let state: 'running' | 'completed' = 'running'
    const scheduler = new CronScheduler(cron, {
      submitScheduledTaskRun: async () => ({ task_id: 'task_terminal', run_id: 'run_terminal', dispatch_generation: 1 }),
      inspectScheduledTaskRun: async () => state === 'running'
        ? { state }
        : { state, completed_at: '2026-07-24T06:06:05.000Z' },
    }, () => new Date('2026-07-24T06:06:00.000Z'))
    const task = await cron.createTask({ cron: '* * * * *', prompt: '等待真实完成', folderPath: root })

    await scheduler.executeTask(task)
    expect((await scheduler.getTaskRuns(task.id))[0]?.status).toBe('running')

    state = 'completed'
    expect((await scheduler.getTaskRuns(task.id))[0]).toMatchObject({
      status: 'completed',
      completedAt: '2026-07-24T06:06:05.000Z',
      output: 'ProductTask 已完成',
    })
  })
})
