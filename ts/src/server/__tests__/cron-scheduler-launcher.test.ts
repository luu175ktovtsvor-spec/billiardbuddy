import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { CronScheduler, resolveCronTaskTimeoutMs } from '../services/cronScheduler.js'
import { CronService } from '../services/cronService.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

describe('cron scheduler durable ProductTask hand-off', () => {
  let root: string
  let cron: CronService

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-cron-worker-'))
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config')
    cron = new CronService()
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps the stale-run timeout configurable without owning an execution timeout', () => {
    expect(resolveCronTaskTimeoutMs({})).toBe(10 * 60 * 1000)
    expect(resolveCronTaskTimeoutMs({ BB_TASK_TIMEOUT_MS: '1800000' })).toBe(1_800_000)
    expect(resolveCronTaskTimeoutMs({ BB_TASK_TIMEOUT_MS: 'not-a-number' })).toBe(10 * 60 * 1000)
    expect(resolveCronTaskTimeoutMs({ BB_TASK_TIMEOUT_MS: '0' })).toBe(10 * 60 * 1000)
  })

  it('submits one canonical schedule occurrence through the durable run bridge', async () => {
    const submissions: Array<{ scheduleId: string; prompt: string; workDir: string; occurrence: string }> = []
    const scheduler = new CronScheduler(cron, {
      submitScheduledTaskRun: async (scheduleId, prompt, workDir, occurrence) => {
        submissions.push({ scheduleId, prompt, workDir, occurrence })
        return { run_id: 'run_durable', dispatch_generation: 1 }
      },
    })
    const task = await cron.createTask({
      cron: '* * * * *',
      prompt: '生成今日经营摘要',
      recurring: false,
      folderPath: root,
    })

    const result = await scheduler.executeTask(task)

    expect(result).toMatchObject({ status: 'completed', output: '已提交到 ProductTask 运行 run_durable' })
    expect(result).not.toHaveProperty('sessionId')
    expect(submissions).toEqual([{
      scheduleId: task.id,
      prompt: task.prompt,
      workDir: await fs.realpath(root),
      occurrence: expect.stringMatching(/^\d{4}-\d{1,2}-\d{1,2}-\d{1,2}-\d{1,2}$/),
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
        return { run_id: 'run_once', dispatch_generation: 1 }
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
    expect((await first).status).toBe('completed')
  })
})
