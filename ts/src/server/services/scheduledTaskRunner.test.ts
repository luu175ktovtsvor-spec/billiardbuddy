import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduledTaskRunner, type FireTask } from './scheduledTaskRunner'
import { computeNextRunAt, isRecurringSchedule, scheduleToCron } from './scheduledTaskSchedule'

type Task = Record<string, unknown>

/** 内存版 store,只实现 runner 用到的两个方法。 */
class FakeStore {
  tasks: Task[]
  constructor(tasks: Task[]) {
    this.tasks = tasks
  }
  async listScheduledTasks(): Promise<Task[]> {
    return this.tasks.map(t => ({ ...t }))
  }
  async updateScheduledTask(id: string, patch: Task): Promise<Task | null> {
    const idx = this.tasks.findIndex(t => t.id === id)
    if (idx === -1) return null
    this.tasks[idx] = { ...this.tasks[idx], ...patch }
    return { ...this.tasks[idx] }
  }
}

let stateRoot: string
beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'sched-runner-'))
})
afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true })
})

describe('scheduledTaskSchedule', () => {
  test('maps schedule kinds to cron', () => {
    expect(scheduleToCron('daily', { hour: 9, minute: 0 })).toBe('0 9 * * *')
    expect(scheduleToCron('daily', { hour: 21, minute: 30 })).toBe('30 21 * * *')
    expect(scheduleToCron('hourly', { minute: 15 })).toBe('15 * * * *')
    expect(scheduleToCron('weekdays', { hour: 8, minute: 0 })).toBe('0 8 * * 1-5')
    expect(scheduleToCron('weekly', { weekday: 1, hour: 9, minute: 0 })).toBe('0 9 * * 1')
    expect(scheduleToCron('monthly', { day: 1, hour: 10, minute: 0 })).toBe('0 10 1 * *')
    expect(scheduleToCron('cron', { expression: '*/5 * * * *' })).toBe('*/5 * * * *')
    expect(scheduleToCron('cron', { expression: 'garbage' })).toBeNull()
    expect(scheduleToCron('manual', {})).toBeNull()
    expect(scheduleToCron('once', {})).toBeNull()
  })

  test('computeNextRunAt for once respects target time', () => {
    const from = Date.parse('2026-07-10T08:00:00')
    const future = new Date(from + 3600_000).toISOString()
    expect(computeNextRunAt({ schedule_kind: 'once', schedule_spec: { at: future } }, from)).toBe(
      new Date(from + 3600_000).toISOString(),
    )
    const past = new Date(from - 3600_000).toISOString()
    expect(computeNextRunAt({ schedule_kind: 'once', schedule_spec: { at: past } }, from)).toBeNull()
  })

  test('recurrence classification', () => {
    expect(isRecurringSchedule({ schedule_kind: 'daily', schedule_spec: { hour: 9, minute: 0 } })).toBe(true)
    expect(isRecurringSchedule({ schedule_kind: 'once', schedule_spec: {} })).toBe(false)
    expect(isRecurringSchedule({ schedule_kind: 'manual', schedule_spec: {} })).toBe(false)
  })
})

describe('ScheduledTaskRunner', () => {
  test('fires a due task by opening an agent session (fireTask) and records history', async () => {
    const fired: { task: Task; runId: string; manual: boolean }[] = []
    const fireTask: FireTask = async (task, ctx) => {
      fired.push({ task, runId: ctx.runId, manual: ctx.manual })
      return { status: 'completed', summary: '已生成日报', conversationId: 'conv-1' }
    }
    const store = new FakeStore([
      {
        id: 't1',
        name: '每日日报',
        instruction: '生成昨天的经营日报',
        billiards_mode: true,
        schedule_kind: 'daily',
        schedule_spec: { hour: 9, minute: 0 },
        next_run_at: '2026-07-10T09:00:00.000Z', // due (past relative to nowMs below)
        enabled: true,
      },
    ])
    const nowMs = Date.parse('2026-07-10T09:00:30.000Z')
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => nowMs })

    await runner.tick()

    // 到点触发了一次 agent 会话
    expect(fired).toHaveLength(1)
    expect(fired[0]!.manual).toBe(false)
    expect((fired[0]!.task as Task).instruction).toBe('生成昨天的经营日报')

    // 运行历史落盘
    const runs = await runner.getTaskRuns('t1')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ task_id: 't1', status: 'completed', summary: '已生成日报', conversation_id: 'conv-1' })

    // 任务回写:last_run_* + 重排到下一个 9 点(未来)
    const task = store.tasks[0]!
    expect(task.last_run_status).toBe('completed')
    expect(task.last_result_summary).toBe('已生成日报')
    expect(typeof task.next_run_at).toBe('string')
    expect(Date.parse(task.next_run_at as string)).toBeGreaterThan(nowMs)
  })

  test('does not fire a task whose next_run_at is in the future', async () => {
    let fires = 0
    const fireTask: FireTask = async () => {
      fires++
      return { status: 'completed' }
    }
    const store = new FakeStore([
      {
        id: 't2',
        instruction: '写朋友圈',
        schedule_kind: 'daily',
        schedule_spec: { hour: 9, minute: 0 },
        next_run_at: '2026-07-11T09:00:00.000Z',
        enabled: true,
      },
    ])
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => Date.parse('2026-07-10T09:00:00.000Z') })
    await runner.tick()
    expect(fires).toBe(0)
  })

  test('catch-up: fires a task whose window passed while process was down', async () => {
    let fires = 0
    const fireTask: FireTask = async () => {
      fires++
      return { status: 'completed', summary: 'ok' }
    }
    const store = new FakeStore([
      {
        id: 't3',
        instruction: '补跑日报',
        schedule_kind: 'daily',
        schedule_spec: { hour: 9, minute: 0 },
        next_run_at: '2026-07-08T09:00:00.000Z', // 2 days ago (missed)
        enabled: true,
      },
    ])
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => Date.parse('2026-07-10T12:00:00.000Z') })
    await runner.tick()
    expect(fires).toBe(1)
  })

  test('one-shot (once) task is disabled after auto-fire', async () => {
    const fireTask: FireTask = async () => ({ status: 'completed', summary: 'done' })
    const at = '2026-07-10T09:00:00.000Z'
    const store = new FakeStore([
      { id: 't4', instruction: '一次性提醒', schedule_kind: 'once', schedule_spec: { at }, next_run_at: at, enabled: true },
    ])
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => Date.parse('2026-07-10T09:00:15.000Z') })
    await runner.tick()
    const task = store.tasks[0]!
    expect(task.enabled).toBe(false)
    expect(task.next_run_at).toBeNull()
  })

  test('runTaskNow fires regardless of schedule and does not disable', async () => {
    let fires = 0
    let sawManual = false
    const fireTask: FireTask = async (_task, ctx) => {
      fires++
      sawManual = ctx.manual
      return { status: 'completed', summary: 'manual run' }
    }
    const store = new FakeStore([
      { id: 't5', instruction: '手动跑', schedule_kind: 'once', schedule_spec: { at: '2026-07-01T00:00:00.000Z' }, next_run_at: null, enabled: true },
    ])
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => Date.now() })
    const run = await runner.runTaskNow('t5')
    expect(run).not.toBeNull()
    expect(fires).toBe(1)
    expect(sawManual).toBe(true)
    expect(store.tasks[0]!.enabled).toBe(true) // 手动运行不停用
  })

  test('skips disabled tasks', async () => {
    let fires = 0
    const fireTask: FireTask = async () => {
      fires++
      return { status: 'completed' }
    }
    const store = new FakeStore([
      { id: 't6', instruction: 'x', schedule_kind: 'daily', schedule_spec: { hour: 9, minute: 0 }, next_run_at: '2026-07-01T09:00:00.000Z', enabled: false },
    ])
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => Date.parse('2026-07-10T12:00:00.000Z') })
    await runner.tick()
    expect(fires).toBe(0)
  })

  test('records failed run when fireTask throws', async () => {
    const fireTask: FireTask = async () => {
      throw new Error('model provider not configured')
    }
    const store = new FakeStore([
      { id: 't7', instruction: 'x', schedule_kind: 'daily', schedule_spec: { hour: 9, minute: 0 }, next_run_at: '2026-07-10T09:00:00.000Z', enabled: true },
    ])
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => Date.parse('2026-07-10T09:01:00.000Z') })
    await runner.tick()
    const runs = await runner.getTaskRuns('t7')
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.error).toContain('model provider not configured')
    // 失败也重排(周期任务),不卡死
    expect(typeof store.tasks[0]!.next_run_at).toBe('string')
  })

  test('backfills next_run_at for a task that has none, without firing it immediately', async () => {
    let fires = 0
    const fireTask: FireTask = async () => {
      fires++
      return { status: 'completed' }
    }
    const store = new FakeStore([
      { id: 't8', instruction: 'x', schedule_kind: 'daily', schedule_spec: { hour: 9, minute: 0 }, next_run_at: null, enabled: true },
    ])
    const runner = new ScheduledTaskRunner({ store, stateRoot, fireTask, now: () => Date.parse('2026-07-10T12:00:00.000Z') })
    await runner.tick()
    expect(fires).toBe(0) // 首见不补跑
    expect(typeof store.tasks[0]!.next_run_at).toBe('string') // 但回填了 next_run_at
  })
})
