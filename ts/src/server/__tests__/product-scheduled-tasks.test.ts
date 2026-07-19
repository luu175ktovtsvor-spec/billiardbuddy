import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleProductScheduledTasksApi } from '../api/productScheduledTasks.js'
import { ProductScheduledTaskService } from '../product/scheduledTaskService.js'
import { handleApiRequest } from '../router.js'
import { CronService } from '../services/cronService.js'
import type { CronScheduler, TaskRun } from '../services/cronScheduler.js'

let tempDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

function schedulerWith(runs: TaskRun[] = []): Pick<CronScheduler, 'executeTask' | 'getRecentRuns' | 'getTaskRuns'> {
  return {
    async executeTask(task) {
      return {
        id: 'run-triggered',
        taskId: task.id,
        taskName: task.name || '定时任务',
        startedAt: '2026-07-19T00:00:00.000Z',
        status: 'running',
        prompt: task.prompt,
      }
    },
    async getRecentRuns() {
      return runs
    },
    async getTaskRuns(taskId) {
      return runs.filter((run) => run.taskId === taskId)
    },
  }
}

function productSegments(...segments: string[]): string[] {
  return ['api', 'product', 'scheduled-tasks', ...segments]
}

describe('product scheduled task adapter', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-product-schedule-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
  })

  afterEach(async () => {
    if (originalConfigDir) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('creates through the product route without accepting provider or permission controls', async () => {
    const service = new ProductScheduledTaskService(new CronService(), schedulerWith())
    const request = new Request('http://localhost/api/product/scheduled-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '每日营业复盘',
        description: '汇总当天关键数据',
        schedule: '0 21 * * *',
        instruction: '整理今天的营业数据并给出明日建议。',
        workDir: '/workspace/billiard',
        notification: { enabled: true, channels: ['desktop'] },
        model: 'internal-model',
        providerId: 'private-provider',
        permissionMode: 'bypassPermissions',
      }),
    })

    const response = await handleProductScheduledTasksApi(
      request,
      new URL(request.url),
      productSegments(),
      service,
    )
    const body = await response.json() as { task: Record<string, unknown> }

    expect(response.status).toBe(201)
    expect(body.task).toMatchObject({
      title: '每日营业复盘',
      schedule: '0 21 * * *',
      instruction: '整理今天的营业数据并给出明日建议。',
      enabled: true,
      recurring: true,
    })
    expect(body.task).not.toHaveProperty('model')
    expect(body.task).not.toHaveProperty('providerId')
    expect(body.task).not.toHaveProperty('permissionMode')

    const [stored] = await new CronService().listTasks()
    expect(stored).toMatchObject({
      name: '每日营业复盘',
      permissionMode: 'dontAsk',
    })
    expect(stored).not.toHaveProperty('model')
    expect(stored).not.toHaveProperty('providerId')
  })

  it('returns a bounded run result without Core session, prompt, or stderr', async () => {
    const rawRun: TaskRun = {
      id: 'run-1',
      taskId: 'task-1',
      taskName: '每日复盘',
      startedAt: '2026-07-19T00:00:00.000Z',
      completedAt: '2026-07-19T00:00:05.000Z',
      status: 'failed',
      prompt: 'private instruction',
      output: '公开的执行结果',
      error: 'private stderr /Users/me/.claude/token',
      sessionId: 'private-core-session',
      durationMs: 5_000,
    }
    const service = new ProductScheduledTaskService(new CronService(), schedulerWith([rawRun]))
    const request = new Request('http://localhost/api/product/scheduled-tasks/runs', { method: 'GET' })

    const response = await handleProductScheduledTasksApi(
      request,
      new URL(request.url),
      productSegments('runs'),
      service,
    )
    const body = await response.json() as { runs: Array<Record<string, unknown>> }
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body.runs).toEqual([{
      id: 'run-1',
      taskId: 'task-1',
      taskTitle: '每日复盘',
      startedAt: '2026-07-19T00:00:00.000Z',
      completedAt: '2026-07-19T00:00:05.000Z',
      status: 'failed',
      result: '公开的执行结果',
      durationMs: 5_000,
    }])
    expect(serialized).not.toContain('private instruction')
    expect(serialized).not.toContain('private stderr')
    expect(serialized).not.toContain('private-core-session')
  })

  it('uses the scheduler for a real manual run and keeps the product response asynchronous', async () => {
    let runCalls = 0
    const scheduler = schedulerWith()
    const executeTask = scheduler.executeTask
    scheduler.executeTask = async (task) => {
      runCalls += 1
      return executeTask(task)
    }
    const service = new ProductScheduledTaskService(new CronService(), scheduler)
    const task = await service.createTask({
      title: '手动运行',
      schedule: '0 9 * * *',
      instruction: '检查营业日报。',
    })
    const request = new Request(`http://localhost/api/product/scheduled-tasks/${task.id}/run`, { method: 'POST' })

    const response = await handleProductScheduledTasksApi(
      request,
      new URL(request.url),
      productSegments(task.id, 'run'),
      service,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(runCalls).toBe(1)
  })

  it('retires the generic scheduled-task route after the product route is connected', async () => {
    const oldRequest = new Request('http://localhost/api/scheduled-tasks', { method: 'GET' })
    const oldResponse = await handleApiRequest(oldRequest, new URL(oldRequest.url))
    expect(oldResponse.status).toBe(404)

    const productRequest = new Request('http://localhost/api/product/scheduled-tasks', { method: 'GET' })
    const productResponse = await handleApiRequest(productRequest, new URL(productRequest.url))
    expect(productResponse.status).toBe(200)
    await expect(productResponse.json()).resolves.toEqual({ tasks: [] })

    const nestedProductRequest = new Request('http://localhost/api/product/scheduled-tasks/runs/private', { method: 'GET' })
    const nestedProductResponse = await handleApiRequest(nestedProductRequest, new URL(nestedProductRequest.url))
    expect(nestedProductResponse.status).toBe(404)
  })
})
