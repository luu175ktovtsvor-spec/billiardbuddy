/**
 * Tests for CronScheduler — cron matching, task execution, log storage, and API endpoints
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  cronMatches,
  fieldMatches,
  CronScheduler,
  latestScheduledOccurrence,
  nextScheduledOccurrence,
  purgeScheduledTaskRunsForDeletedTask,
  type TaskRun,
} from '../services/cronScheduler.js'
import { CronService, type CronTask } from '../services/cronService.js'

// ─── Test helpers ───────────────────────────────────────────────────────────

let tmpDir: string
const originalConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR

async function createTmpDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `billiardbuddy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ─── fieldMatches tests ────────────────────────────────────────────────────

describe('fieldMatches', () => {
  it('should match wildcard', () => {
    expect(fieldMatches('*', 0)).toBe(true)
    expect(fieldMatches('*', 59)).toBe(true)
    expect(fieldMatches('*', 23)).toBe(true)
  })

  it('should match exact number', () => {
    expect(fieldMatches('5', 5)).toBe(true)
    expect(fieldMatches('5', 6)).toBe(false)
    expect(fieldMatches('0', 0)).toBe(true)
    expect(fieldMatches('30', 30)).toBe(true)
  })

  it('should match comma-separated list', () => {
    expect(fieldMatches('1,3,5', 1)).toBe(true)
    expect(fieldMatches('1,3,5', 3)).toBe(true)
    expect(fieldMatches('1,3,5', 5)).toBe(true)
    expect(fieldMatches('1,3,5', 2)).toBe(false)
    expect(fieldMatches('1,3,5', 4)).toBe(false)
  })

  it('should match range', () => {
    expect(fieldMatches('1-5', 1)).toBe(true)
    expect(fieldMatches('1-5', 3)).toBe(true)
    expect(fieldMatches('1-5', 5)).toBe(true)
    expect(fieldMatches('1-5', 0)).toBe(false)
    expect(fieldMatches('1-5', 6)).toBe(false)
  })

  it('should match step from wildcard', () => {
    expect(fieldMatches('*/2', 0)).toBe(true)
    expect(fieldMatches('*/2', 2)).toBe(true)
    expect(fieldMatches('*/2', 4)).toBe(true)
    expect(fieldMatches('*/2', 1)).toBe(false)
    expect(fieldMatches('*/2', 3)).toBe(false)
    expect(fieldMatches('*/15', 0)).toBe(true)
    expect(fieldMatches('*/15', 15)).toBe(true)
    expect(fieldMatches('*/15', 30)).toBe(true)
    expect(fieldMatches('*/15', 7)).toBe(false)
  })

  it('should match step within range', () => {
    expect(fieldMatches('1-10/3', 1)).toBe(true)
    expect(fieldMatches('1-10/3', 4)).toBe(true)
    expect(fieldMatches('1-10/3', 7)).toBe(true)
    expect(fieldMatches('1-10/3', 10)).toBe(true)
    expect(fieldMatches('1-10/3', 2)).toBe(false)
    expect(fieldMatches('1-10/3', 11)).toBe(false)
    expect(fieldMatches('1-10/3', 0)).toBe(false)
  })

  it('should handle combined comma and range', () => {
    expect(fieldMatches('1-3,7,10-12', 2)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 7)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 11)).toBe(true)
    expect(fieldMatches('1-3,7,10-12', 5)).toBe(false)
  })
})

// ─── cronMatches tests ─────────────────────────────────────────────────────

describe('cronMatches', () => {
  it('should match every-minute expression', () => {
    const date = new Date(2026, 3, 5, 14, 30, 0) // April 5, 2026 14:30 (Sunday)
    expect(cronMatches('* * * * *', date)).toBe(true)
  })

  it('should match daily at 9:00', () => {
    const match = new Date(2026, 3, 5, 9, 0, 0)
    const noMatch = new Date(2026, 3, 5, 9, 1, 0)
    expect(cronMatches('0 9 * * *', match)).toBe(true)
    expect(cronMatches('0 9 * * *', noMatch)).toBe(false)
  })

  it('should match every 2 hours at minute 0', () => {
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 2, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 4, 0))).toBe(true)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 1, 0))).toBe(false)
    expect(cronMatches('0 */2 * * *', new Date(2026, 0, 1, 3, 0))).toBe(false)
  })

  it('should match weekdays at 14:30', () => {
    // April 6, 2026 is a Monday (dow = 1)
    const monday = new Date(2026, 3, 6, 14, 30, 0)
    // April 5, 2026 is a Sunday (dow = 0)
    const sunday = new Date(2026, 3, 5, 14, 30, 0)
    expect(cronMatches('30 14 * * 1-5', monday)).toBe(true)
    expect(cronMatches('30 14 * * 1-5', sunday)).toBe(false)
  })

  it('should match specific month and day', () => {
    // January 15 at midnight
    const jan15 = new Date(2026, 0, 15, 0, 0)
    const feb15 = new Date(2026, 1, 15, 0, 0)
    expect(cronMatches('0 0 15 1 *', jan15)).toBe(true)
    expect(cronMatches('0 0 15 1 *', feb15)).toBe(false)
  })

  it('should reject invalid cron expressions', () => {
    const date = new Date()
    expect(cronMatches('* * *', date)).toBe(false) // only 3 fields
    expect(cronMatches('', date)).toBe(false)
    expect(cronMatches('* * * * * *', date)).toBe(false) // 6 fields
  })

  it('should match day-of-week with Sunday as 0', () => {
    // Sunday = 0
    const sunday = new Date(2026, 3, 5, 10, 0) // April 5, 2026 is Sunday
    expect(cronMatches('0 10 * * 0', sunday)).toBe(true)
    expect(cronMatches('0 10 * * 6', sunday)).toBe(false)
  })

  it('uses standard cron OR semantics when day-of-month and weekday are both constrained', () => {
    expect(cronMatches('0 9 1 * 1', new Date(2026, 5, 8, 9, 0))).toBe(true)
  })

  it('evaluates an occurrence in the schedule IANA time zone', () => {
    const instant = new Date('2026-07-24T01:00:00.000Z')
    expect(cronMatches('0 9 * * *', instant, 'Asia/Shanghai')).toBe(true)
    expect(cronMatches('0 9 * * *', instant, 'UTC')).toBe(false)
  })

  it('skips a nonexistent DST wall-clock minute when calculating the next occurrence', () => {
    const task: CronTask = {
      id: 'dst',
      cron: '30 2 * * *',
      timeZone: 'America/New_York',
      prompt: 'dst',
      createdAt: 0,
    }
    expect(nextScheduledOccurrence(task, new Date('2026-03-08T05:00:00.000Z'))?.toISOString())
      .toBe('2026-03-09T06:30:00.000Z')
  })
})

describe('missed-run policy', () => {
  const baseTask: CronTask = {
    id: 'task-policy',
    cron: '0 9 * * *',
    prompt: 'review',
    createdAt: new Date('2026-07-20T00:00:00.000Z').getTime(),
    recurring: true,
  }

  it('coalesces several missed occurrences to the latest one', () => {
    const occurrence = latestScheduledOccurrence(
      { ...baseTask, missedRunPolicy: 'run_once', lastFiredAt: '2026-07-21T09:00:00.000Z' },
      new Date('2026-07-24T12:00:00.000Z'),
    )
    expect(occurrence?.toISOString()).toBe('2026-07-24T09:00:00.000Z')
  })

  it('does not replay a missed occurrence under skip policy', () => {
    expect(latestScheduledOccurrence(
      { ...baseTask, missedRunPolicy: 'skip' },
      new Date('2026-07-24T12:00:00.000Z'),
    )).toBeNull()
  })
})

// ─── CronScheduler execution tests ────────────────────────────────────────

describe('CronScheduler', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.BILLIARDBUDDY_CONFIG_DIR = tmpDir
    cronService = new CronService()
    scheduler = new CronScheduler(cronService, {
      submitScheduledTaskRun: async (scheduleId) => ({ task_id: `task_${scheduleId}`, run_id: `durable_${scheduleId}`, dispatch_generation: 1 }),
      inspectScheduledTaskRun: async () => ({ state: 'completed' }),
    })
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.BILLIARDBUDDY_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.BILLIARDBUDDY_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should start and stop without errors', () => {
    scheduler.start()
    scheduler.stop()
    // Starting again after stop should also work
    scheduler.start()
    scheduler.stop()
  })

  it('should not start twice', () => {
    scheduler.start()
    // Second start should be a no-op (no error)
    scheduler.start()
    scheduler.stop()
  })

  it('should return empty runs when no tasks have executed', async () => {
    const runs = await scheduler.getRecentRuns()
    expect(runs).toEqual([])
  })

  it('should return empty runs for a non-existent task ID', async () => {
    const runs = await scheduler.getTaskRuns('nonexistent')
    expect(runs).toEqual([])
  })

  it('should persist a task run to the log file', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'echo test',
      name: 'Test Task',
      recurring: true,
      folderPath: tmpDir,
    })

    await scheduler.executeTask(task)

    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const logExists = await fs
      .stat(logPath)
      .then(() => true)
      .catch(() => false)
    expect(logExists).toBe(true)

    const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
      runs: TaskRun[]
    }
    expect(logContent.runs.length).toBeGreaterThanOrEqual(1)
    expect(logContent.runs[0].taskId).toBe(task.id)
    expect(logContent.runs[0].taskName).toBe('Test Task')
    expect(logContent.runs[0].prompt).toBe('echo test')
  })

  it('purges run history owned by a deleted ProductTask or its related schedules', async () => {
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = [
      { id: 'related', taskId: 'schedule-related', taskName: 'Related', startedAt: new Date().toISOString(), status: 'completed', prompt: 'private', productTaskId: 'task-delete' },
      { id: 'failed-related', taskId: 'schedule-related', taskName: 'Failed related', startedAt: new Date().toISOString(), status: 'failed', prompt: 'private' },
      { id: 'keep', taskId: 'schedule-keep', taskName: 'Keep', startedAt: new Date().toISOString(), status: 'completed', prompt: 'keep', productTaskId: 'task-keep' },
    ]
    await fs.writeFile(logPath, JSON.stringify({ schemaVersion: 1, runs }, null, 2), 'utf8')

    expect(await purgeScheduledTaskRunsForDeletedTask('task-delete', ['schedule-related'], tmpDir)).toBe(2)
    const stored = JSON.parse(await fs.readFile(logPath, 'utf8')) as { runs: TaskRun[] }
    expect(stored.runs.map(run => run.id)).toEqual(['keep'])
  })

  it('should disable non-recurring task after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'one-shot task',
      recurring: false,
      folderPath: tmpDir,
    })

    await scheduler.executeTask(task)

    // After execution, the task should be disabled
    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    expect(updated?.enabled).toBe(false)
  })

  it('should NOT disable recurring task after execution', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'recurring task',
      recurring: true,
      folderPath: tmpDir,
    })

    await scheduler.executeTask(task)

    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    // enabled should not have been set to false
    expect(updated?.enabled).not.toBe(false)
  })

  it('records the logical occurrence after a scheduled hand-off', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'fire test',
      recurring: true,
      folderPath: tmpDir,
    })

    const occurrenceAt = new Date()
    occurrenceAt.setSeconds(0, 0)
    await scheduler.executeTask(task, { trigger: 'schedule', occurrenceAt })

    const tasks = await cronService.listTasks()
    const updated = tasks.find((t) => t.id === task.id)
    expect(updated?.lastFiredAt).toBeDefined()
    expect(updated?.lastFiredAt).toBe(occurrenceAt.toISOString())
  })

  it('should skip disabled tasks during tick', async () => {
    // Create a task matching every minute but disabled
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'should not run',
      enabled: false,
      recurring: true,
    })

    await scheduler.tick()

    // No runs should be logged
    const runs = await scheduler.getTaskRuns(task.id)
    expect(runs).toHaveLength(0)
  })

  it('getTaskRuns should return runs sorted newest first', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'multi run',
      recurring: true,
      folderPath: tmpDir,
    })

    // Execute twice
    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }
    await scheduler.getTaskRuns(task.id)
    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }

    const runs = await scheduler.getTaskRuns(task.id)
    expect(runs.length).toBeGreaterThanOrEqual(2)
    // Should be sorted newest first
    if (runs.length >= 2) {
      expect(
        new Date(runs[0].startedAt).getTime(),
      ).toBeGreaterThanOrEqual(new Date(runs[1].startedAt).getTime())
    }
  })

  it('getRecentRuns should respect limit parameter', async () => {
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'limit test',
      recurring: true,
    })

    // Execute 3 times
    for (let i = 0; i < 3; i++) {
      try {
        await scheduler.executeTask(task)
      } catch {
        /* ignore */
      }
      await scheduler.getTaskRuns(task.id)
    }

    const runs = await scheduler.getRecentRuns(2)
    expect(runs.length).toBeLessThanOrEqual(2)
  })
})

// ─── Execution log trimming ────────────────────────────────────────────────

describe('Execution log trimming', () => {
  let cronService: CronService
  let scheduler: CronScheduler

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.BILLIARDBUDDY_CONFIG_DIR = tmpDir
    cronService = new CronService()
    scheduler = new CronScheduler(cronService, {
      submitScheduledTaskRun: async (scheduleId) => ({ task_id: `task_${scheduleId}`, run_id: `durable_${scheduleId}`, dispatch_generation: 1 }),
      inspectScheduledTaskRun: async () => ({ state: 'completed' }),
    })
  })

  afterEach(async () => {
    scheduler.stop()
    if (originalConfigDir) {
      process.env.BILLIARDBUDDY_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.BILLIARDBUDDY_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('should keep log entries within the max limit', async () => {
    // Pre-populate the log file with 105 entries for a single task
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = []
    for (let i = 0; i < 105; i++) {
      runs.push({
        id: `run-${i}`,
        taskId: 'task-1',
        taskName: 'Test',
        startedAt: new Date(Date.now() - (105 - i) * 1000).toISOString(),
        completedAt: new Date(Date.now() - (105 - i) * 1000 + 100).toISOString(),
        status: 'completed',
        prompt: 'test',
        exitCode: 0,
        durationMs: 100,
      })
    }
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    // Now execute one more task run — this triggers a trim
    const task = await cronService.createTask({
      cron: '* * * * *',
      prompt: 'trigger trim',
      recurring: true,
      folderPath: tmpDir,
    })

    try {
      await scheduler.executeTask(task)
    } catch {
      /* ignore */
    }

    // Read back the log
    const logContent = JSON.parse(await fs.readFile(logPath, 'utf-8')) as {
      runs: TaskRun[]
    }
    const task1Runs = logContent.runs.filter((r) => r.taskId === 'task-1')
    // Should have been trimmed to at most 100
    expect(task1Runs.length).toBeLessThanOrEqual(100)
  })
})

// ─── Product Scheduled Tasks API with runs endpoints ──────────────────────

describe('Product Scheduled Tasks API — runs endpoints', () => {
  let handleProductScheduledTasksApi: (
    req: Request,
    url: URL,
    segments: string[],
  ) => Promise<Response>

  beforeEach(async () => {
    tmpDir = await createTmpDir()
    process.env.BILLIARDBUDDY_CONFIG_DIR = tmpDir

    const mod = await import('../api/productScheduledTasks.js')
    handleProductScheduledTasksApi = mod.handleProductScheduledTasksApi
  })

  afterEach(async () => {
    if (originalConfigDir) {
      process.env.BILLIARDBUDDY_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.BILLIARDBUDDY_CONFIG_DIR
    }
    await cleanupTmpDir(tmpDir)
  })

  it('GET /api/product/scheduled-tasks/runs should return empty runs', async () => {
    const req = new Request('http://localhost/api/product/scheduled-tasks/runs', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleProductScheduledTasksApi(req, url, [
      'api',
      'product',
      'scheduled-tasks',
      'runs',
    ])
    const body = (await resp.json()) as { runs: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toEqual([])
  })

  it('GET /api/product/scheduled-tasks/:id/runs should return empty runs for a task', async () => {
    const req = new Request(
      'http://localhost/api/product/scheduled-tasks/abc123/runs',
      { method: 'GET' },
    )
    const url = new URL(req.url)
    const resp = await handleProductScheduledTasksApi(req, url, [
      'api',
      'product',
      'scheduled-tasks',
      'abc123',
      'runs',
    ])
    const body = (await resp.json()) as { runs: unknown[] }
    expect(resp.status).toBe(200)
    expect(body.runs).toEqual([])
  })

  it('GET /api/product/scheduled-tasks/runs should return safe runs from log', async () => {
    // Write some runs to the log file
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = [
      {
        id: 'run-1',
        taskId: 'task-a',
        taskName: 'Task A',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'test prompt',
        exitCode: 0,
        durationMs: 500,
        sessionId: 'private-scheduled-run-session',
      },
      {
        id: 'run-2',
        taskId: 'task-b',
        taskName: 'Task B',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failed',
        prompt: 'another prompt',
        error: 'some error',
        exitCode: 1,
        durationMs: 200,
      },
    ]
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    const req = new Request('http://localhost/api/product/scheduled-tasks/runs', {
      method: 'GET',
    })
    const url = new URL(req.url)
    const resp = await handleProductScheduledTasksApi(req, url, [
      'api',
      'product',
      'scheduled-tasks',
      'runs',
    ])
    const body = (await resp.json()) as { runs: Array<Record<string, unknown>> }
    expect(resp.status).toBe(200)
    expect(body.runs).toHaveLength(2)
    expect(body.runs[0]).not.toHaveProperty('sessionId')
    expect(JSON.stringify(body)).not.toContain('private-scheduled-run-session')
    expect(JSON.stringify(body)).not.toContain('test prompt')
    expect(JSON.stringify(body)).not.toContain('some error')
  })

  it('GET /api/product/scheduled-tasks/:id/runs should filter by task ID', async () => {
    const logPath = path.join(tmpDir, 'scheduled_tasks_log.json')
    const runs: TaskRun[] = [
      {
        id: 'run-1',
        taskId: 'task-a',
        taskName: 'Task A',
        startedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'prompt a',
        exitCode: 0,
      },
      {
        id: 'run-2',
        taskId: 'task-b',
        taskName: 'Task B',
        startedAt: new Date().toISOString(),
        status: 'completed',
        prompt: 'prompt b',
        exitCode: 0,
      },
    ]
    await fs.writeFile(logPath, JSON.stringify({ runs }, null, 2), 'utf-8')

    const req = new Request(
      'http://localhost/api/product/scheduled-tasks/task-a/runs',
      { method: 'GET' },
    )
    const url = new URL(req.url)
    const resp = await handleProductScheduledTasksApi(req, url, [
      'api',
      'product',
      'scheduled-tasks',
      'task-a',
      'runs',
    ])
    const body = (await resp.json()) as { runs: Array<{ taskId: string }> }
    expect(resp.status).toBe(200)
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].taskId).toBe('task-a')
  })
})
