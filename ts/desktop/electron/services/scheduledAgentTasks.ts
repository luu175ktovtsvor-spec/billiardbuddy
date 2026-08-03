import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type ScheduledAgentTaskSchedule =
  | { kind: 'once', at: number }
  | { kind: 'interval', everyMs: number }
  | { kind: 'daily', hour: number, minute: number }
  | { kind: 'weekly', days: number[], hour: number, minute: number }

export type ScheduledAgentTask = {
  id: string
  threadId: string
  cwd: string
  prompt: string
  schedule: ScheduledAgentTaskSchedule
  enabled: boolean
  createdAt: number
  nextRunAt: number
  lastRunAt?: number
  lastError?: string
}

export type ScheduledAgentTaskInput = Omit<ScheduledAgentTask, 'id' | 'createdAt' | 'nextRunAt' | 'lastRunAt' | 'lastError'>

export type ScheduledAgentTaskEvent =
  | { type: 'scheduled-task-started', task: ScheduledAgentTask }
  | { type: 'scheduled-task-completed', task: ScheduledAgentTask, turnId: string }
  | { type: 'scheduled-task-failed', task: ScheduledAgentTask, error: string }

type PersistedTasks = { version: 1, tasks: ScheduledAgentTask[] }

const MAX_TIMEOUT_MS = 2_147_000_000
const MIN_INTERVAL_MS = 60_000
const MAX_INTERVAL_MS = 31 * 24 * 60 * 60_000

function tasksPath(userDataPath: string): string {
  return path.join(userDataPath, 'agent-runtime', 'scheduled-tasks', 'tasks.json')
}

function finiteTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
}

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function validClock(hour: unknown, minute: unknown): boolean {
  return integerBetween(hour, 0, 23) && integerBetween(minute, 0, 59)
}

export function validateScheduledAgentTaskSchedule(value: unknown): value is ScheduledAgentTaskSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.kind === 'once') return Object.keys(item).every(key => key === 'kind' || key === 'at') && finiteTime(item.at)
  if (item.kind === 'interval') return Object.keys(item).every(key => key === 'kind' || key === 'everyMs')
    && integerBetween(item.everyMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS)
  if (item.kind === 'daily') return Object.keys(item).every(key => key === 'kind' || key === 'hour' || key === 'minute') && validClock(item.hour, item.minute)
  if (item.kind === 'weekly') return Object.keys(item).every(key => key === 'kind' || key === 'days' || key === 'hour' || key === 'minute')
    && Array.isArray(item.days) && item.days.length > 0 && item.days.length <= 7
    && item.days.every(day => integerBetween(day, 0, 6))
    && new Set(item.days).size === item.days.length && validClock(item.hour, item.minute)
  return false
}

function validTask(value: unknown): value is ScheduledAgentTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Record<string, unknown>
  return Object.keys(task).every(key => ['id', 'threadId', 'cwd', 'prompt', 'schedule', 'enabled', 'createdAt', 'nextRunAt', 'lastRunAt', 'lastError'].includes(key))
    && typeof task.id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(task.id)
    && typeof task.threadId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(task.threadId)
    && typeof task.cwd === 'string' && task.cwd.length > 0 && task.cwd.length <= 4_096 && !/[\u0000\r\n]/.test(task.cwd)
    && typeof task.prompt === 'string' && task.prompt.trim().length > 0 && task.prompt.length <= 32_000 && !task.prompt.includes('\u0000')
    && validateScheduledAgentTaskSchedule(task.schedule)
    && typeof task.enabled === 'boolean'
    && finiteTime(task.createdAt) && finiteTime(task.nextRunAt)
    && (task.lastRunAt === undefined || finiteTime(task.lastRunAt))
    && (task.lastError === undefined || typeof task.lastError === 'string' && task.lastError.length <= 1_024)
}

/** Calculate the first future run after `after`, without using a cron parser. */
export function nextScheduledAgentTaskRun(schedule: ScheduledAgentTaskSchedule, after: number): number | undefined {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : undefined
  if (schedule.kind === 'interval') return after + schedule.everyMs
  const now = new Date(after)
  const candidate = new Date(after)
  candidate.setSeconds(0, 0)
  candidate.setHours(schedule.hour, schedule.minute, 0, 0)
  if (schedule.kind === 'daily') {
    if (candidate.getTime() <= after) candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
  }
  for (let offset = 0; offset <= 7; offset += 1) {
    const next = new Date(candidate)
    next.setDate(now.getDate() + offset)
    if (schedule.days.includes(next.getDay()) && next.getTime() > after) return next.getTime()
  }
  return undefined
}

export class ScheduledAgentTaskService {
  private readonly tasks = new Map<string, ScheduledAgentTask>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false

  constructor(
    private readonly options: {
      userDataPath: string
      now?: () => number
      run(task: ScheduledAgentTask): Promise<{ turnId: string }>
      onEvent?(event: ScheduledAgentTaskEvent): void
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) return
    await this.load()
    this.started = true
    this.arm()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  list(threadId?: string): ScheduledAgentTask[] {
    return [...this.tasks.values()]
      .filter(task => threadId === undefined || task.threadId === threadId)
      .sort((left, right) => left.nextRunAt - right.nextRunAt || left.createdAt - right.createdAt)
      .map(task => structuredClone(task))
  }

  async create(input: ScheduledAgentTaskInput): Promise<ScheduledAgentTask> {
    if (!validateScheduledAgentTaskInput(input)) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_INVALID')
    const now = this.now()
    const nextRunAt = nextScheduledAgentTaskRun(input.schedule, now)
    if (nextRunAt === undefined) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_IN_PAST')
    const task: ScheduledAgentTask = {
      ...structuredClone(input),
      id: crypto.randomUUID().replaceAll('-', ''),
      createdAt: now,
      nextRunAt,
    }
    this.tasks.set(task.id, task)
    await this.persist()
    this.arm()
    return structuredClone(task)
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledAgentTask> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_NOT_FOUND')
    task.enabled = enabled
    if (enabled && task.nextRunAt <= this.now()) {
      const next = nextScheduledAgentTaskRun(task.schedule, this.now())
      if (next === undefined) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_EXPIRED')
      task.nextRunAt = next
    }
    await this.persist()
    this.arm()
    return structuredClone(task)
  }

  async remove(id: string): Promise<void> {
    if (!this.tasks.delete(id)) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_NOT_FOUND')
    await this.persist()
    this.arm()
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  private async load(): Promise<void> {
    const file = tasksPath(this.options.userDataPath)
    const raw = await fs.readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (!raw) return
    let parsed: PersistedTasks
    try { parsed = JSON.parse(raw) as PersistedTasks } catch { throw new Error('BILLIARDBUDDY_SCHEDULED_TASKS_CORRUPT') }
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || !parsed.tasks.every(validTask)) {
      throw new Error('BILLIARDBUDDY_SCHEDULED_TASKS_CORRUPT')
    }
    for (const task of parsed.tasks) this.tasks.set(task.id, task)
  }

  private async persist(): Promise<void> {
    const file = tasksPath(this.options.userDataPath)
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, tasks: this.list() satisfies ScheduledAgentTask[] }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await fs.rename(temporary, file)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private arm(): void {
    if (!this.started) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const due = this.list().find(task => task.enabled)
    if (!due) return
    const delay = Math.max(0, due.nextRunAt - this.now())
    this.timer = setTimeout(() => {
      void this.runDue().catch(error => {
        console.error('BilliardBuddy scheduled task service failed', error)
      })
    }, Math.min(delay, MAX_TIMEOUT_MS))
    this.timer.unref?.()
  }

  private async runDue(): Promise<void> {
    if (!this.started) return
    try {
      const now = this.now()
      const due = this.list().filter(task => task.enabled && task.nextRunAt <= now)
      for (const snapshot of due) {
        const task = this.tasks.get(snapshot.id)
        if (!task || !task.enabled || task.nextRunAt > now) continue
        task.lastRunAt = now
        const next = nextScheduledAgentTaskRun(task.schedule, now)
        if (next === undefined) task.enabled = false
        else task.nextRunAt = next
        this.emit({ type: 'scheduled-task-started', task: structuredClone(task) })
        try {
          const result = await this.options.run(structuredClone(task))
          task.lastError = undefined
          this.emit({ type: 'scheduled-task-completed', task: structuredClone(task), turnId: result.turnId })
        } catch (error) {
          task.lastError = error instanceof Error ? error.message.slice(0, 1_024) : 'scheduled task failed'
          this.emit({ type: 'scheduled-task-failed', task: structuredClone(task), error: task.lastError })
        }
        await this.persist()
      }
    } finally {
      this.arm()
    }
  }

  private emit(event: ScheduledAgentTaskEvent): void {
    try { this.options.onEvent?.(event) } catch (error) {
      console.error('BilliardBuddy scheduled task event handler failed', error)
    }
  }
}

export function validateScheduledAgentTaskInput(value: unknown): value is ScheduledAgentTaskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).every(key => ['threadId', 'cwd', 'prompt', 'schedule', 'enabled'].includes(key))
    && typeof item.threadId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(item.threadId)
    && typeof item.cwd === 'string' && item.cwd.length > 0 && item.cwd.length <= 4_096 && !/[\u0000\r\n]/.test(item.cwd)
    && typeof item.prompt === 'string' && item.prompt.trim().length > 0 && item.prompt.length <= 32_000 && !item.prompt.includes('\u0000')
    && validateScheduledAgentTaskSchedule(item.schedule)
    && typeof item.enabled === 'boolean'
}
