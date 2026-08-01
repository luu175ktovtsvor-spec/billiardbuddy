/**
 * CronScheduler — Execution engine for scheduled tasks
 *
 * Periodically checks all scheduled tasks and executes those whose cron
 * expression matches the current time. Each occurrence becomes one durable
 * ProductTask run and is dispatched by the internal agent-worker. Execution
 * submission history is persisted to ~/.BilliardBuddy/scheduled_tasks_log.json.
 */

import * as fs from 'fs/promises'
import { existsSync, realpathSync, statSync } from 'node:fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { lock } from '../../utils/lockfile.js'
import { parseCronExpression, type CronFields } from '../../utils/cron.js'
import {
  CronService,
  type CronTask,
} from './cronService.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type TaskRun = {
  id: string // random ID
  taskId: string // references CronTask.id
  taskName: string
  startedAt: string // ISO timestamp
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
  prompt: string
  output?: string // captured stdout summary
  error?: string
  exitCode?: number
  durationMs?: number
  occurrenceAt?: string
  trigger?: 'schedule' | 'manual'
  productRunId?: string
  productTaskId?: string
  dispatchGeneration?: number
  // Old installations can still have this field in persisted run logs. It is
  // never created by the scheduler and is stripped from the product API.
  sessionId?: string
}

export type ScheduledTaskRunBridge = {
  submitScheduledTaskRun(scheduleId: string, title: string, prompt: string, workDir: string, occurrence: string, context: CronTask['context']): Promise<{ task_id: string; run_id: string; dispatch_generation: number }>
  inspectScheduledTaskRun?(runId: string, dispatchGeneration: number): Promise<{ state: 'running' | 'completed' | 'failed' | 'cancelled'; completed_at?: string }>
  stopScheduledTaskRun?(runId: string, dispatchGeneration: number): Promise<boolean>
}

// ─── Cron expression matching ──────────────────────────────────────────────────

/**
 * Check whether a single cron field matches a given numeric value.
 *
 * Supported syntax per field:
 *   *          — any value
 *   5          — exact match
 *   1,3,5      — list
 *   1-5        — inclusive range
 *   *​/2        — step from 0
 *   1-10/3     — step within a range
 */
export function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true

  // Comma-separated list — each element can be a range or step
  const parts = field.split(',')
  return parts.some((part) => singleFieldMatches(part.trim(), value))
}

function singleFieldMatches(part: string, value: number): boolean {
  // Step: */n or range/n
  if (part.includes('/')) {
    const [rangePart, stepStr] = part.split('/')
    const step = parseInt(stepStr, 10)
    if (isNaN(step) || step <= 0) return false

    if (rangePart === '*') {
      return value % step === 0
    }
    // range/step  e.g. 1-10/3
    if (rangePart.includes('-')) {
      const [startStr, endStr] = rangePart.split('-')
      const start = parseInt(startStr, 10)
      const end = parseInt(endStr, 10)
      if (value < start || value > end) return false
      return (value - start) % step === 0
    }
    // single/step  e.g. 5/2  — treat as start with step
    const start = parseInt(rangePart, 10)
    if (value < start) return false
    return (value - start) % step === 0
  }

  // Range: a-b
  if (part.includes('-')) {
    const [startStr, endStr] = part.split('-')
    const start = parseInt(startStr, 10)
    const end = parseInt(endStr, 10)
    return value >= start && value <= end
  }

  // Exact number
  return parseInt(part, 10) === value
}

/**
 * Check whether a standard 5-field cron expression matches the given date.
 * Fields: minute hour day-of-month month day-of-week
 */
export function cronMatches(
  cronExpr: string,
  date: Date,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
): boolean {
  const fields = parseCronExpression(cronExpr)
  return fields ? cronFieldsMatch(fields, date, timeZone) : false
}

function cronFieldsMatch(fields: CronFields, date: Date, timeZone: string): boolean {
  const parts = zonedDateParts(date, timeZone)
  const dayOfMonthWildcard = fields.dayOfMonth.length === 31
  const dayOfWeekWildcard = fields.dayOfWeek.length === 7
  const dayMatches = dayOfMonthWildcard && dayOfWeekWildcard
    ? true
    : dayOfMonthWildcard
      ? fields.dayOfWeek.includes(parts.dayOfWeek)
      : dayOfWeekWildcard
        ? fields.dayOfMonth.includes(parts.day)
        : fields.dayOfMonth.includes(parts.day) || fields.dayOfWeek.includes(parts.dayOfWeek)
  return fields.minute.includes(parts.minute)
    && fields.hour.includes(parts.hour)
    && fields.month.includes(parts.month)
    && dayMatches
}

function zonedDateParts(date: Date, timeZone: string): {
  minute: number
  hour: number
  day: number
  month: number
  dayOfWeek: number
} {
  let formatter = zonedFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    zonedFormatters.set(timeZone, formatter)
  }
  const values = Object.fromEntries(formatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
  const year = values.year
  const month = values.month
  const day = values.day
  const hour = values.hour
  const minute = values.minute
  if (![year, month, day, hour, minute].every(Number.isInteger)) throw new Error('SCHEDULE_TIME_ZONE_INVALID')
  return {
    minute,
    hour,
    day,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  }
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>()

// ─── Log file I/O ──────────────────────────────────────────────────────────────

export const CURRENT_SCHEDULED_TASK_RUNS_SCHEMA_VERSION = 1

type RunsFile = {
  schemaVersion: typeof CURRENT_SCHEDULED_TASK_RUNS_SCHEMA_VERSION
  runs: TaskRun[]
}

function getLogFilePath(
  configDir = process.env.BILLIARDBUDDY_CONFIG_DIR || path.join(os.homedir(), '.BilliardBuddy'),
): string {
  return path.join(configDir, 'scheduled_tasks_log.json')
}

async function readRunsFile(configDir?: string): Promise<RunsFile> {
  try {
    const raw = await fs.readFile(getLogFilePath(configDir), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<RunsFile>
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== CURRENT_SCHEDULED_TASK_RUNS_SCHEMA_VERSION) {
      throw new Error('UNSUPPORTED_SCHEDULED_TASK_RUNS_SCHEMA')
    }
    if (!Array.isArray(parsed.runs)) throw new Error('INVALID_SCHEDULED_TASK_RUNS_SCHEMA')
    return {
      schemaVersion: CURRENT_SCHEDULED_TASK_RUNS_SCHEMA_VERSION,
      runs: parsed.runs.map((run) => {
        const {
          sessionId: _legacySessionId,
          model: _legacyModel,
          providerId: _legacyProviderId,
          ...current
        } = run as TaskRun & { model?: unknown; providerId?: unknown }
        return current
      }),
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: CURRENT_SCHEDULED_TASK_RUNS_SCHEMA_VERSION, runs: [] }
    }
    throw err
  }
}

async function writeRunsFile(data: RunsFile, configDir?: string): Promise<void> {
  const filePath = getLogFilePath(configDir)
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tmpFile = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmpFile, filePath)
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {})
    throw err
  }
}

async function withRunsLock<T>(operation: () => Promise<T>, configDir?: string): Promise<T> {
  const guardPath = `${getLogFilePath(configDir)}.guard`
  await fs.mkdir(path.dirname(guardPath), { recursive: true })
  await fs.open(guardPath, 'a', 0o600).then((handle) => handle.close())
  const release = await lock(guardPath, {
    stale: 30_000,
    retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
  })
  try {
    return await operation()
  } finally {
    await release()
  }
}

async function mutateRuns(operation: (data: RunsFile) => void, configDir?: string): Promise<void> {
  await withRunsLock(async () => {
    const data = await readRunsFile(configDir)
    operation(data)
    trimRuns(data)
    await writeRunsFile(data, configDir)
  }, configDir)
}

export async function migrateSupportedScheduledTaskRuns(configDir?: string): Promise<void> {
  await withRunsLock(async () => {
    const before = await fs.readFile(getLogFilePath(configDir), 'utf-8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (before === null) return
    const data = await readRunsFile(configDir)
    const after = JSON.stringify(data, null, 2) + '\n'
    if (before !== after) await writeRunsFile(data, configDir)
  }, configDir)
}

/** Remove schedule history that would retain a deleted ProductTask identity. */
export async function purgeScheduledTaskRunsForDeletedTask(
  productTaskId: string,
  scheduleIds: readonly string[],
  configDir?: string,
): Promise<number> {
  const schedules = new Set(scheduleIds)
  let purged = 0
  await mutateRuns((data) => {
    const retained = data.runs.filter(run => run.productTaskId !== productTaskId && !schedules.has(run.taskId))
    purged = data.runs.length - retained.length
    data.runs = retained
  }, configDir)
  return purged
}

/** Append a run to the log and trim to keep at most MAX_RUNS_PER_TASK per task. */
async function appendRun(run: TaskRun): Promise<void> {
  await mutateRuns((data) => {
    const index = data.runs.findIndex((entry) => entry.id === run.id)
    if (index === -1) data.runs.push(run)
    else data.runs[index] = run
  })
}

/** Update an existing run in the log (matched by run.id). */
async function updateRun(run: TaskRun): Promise<void> {
  await appendRun(run)
}

const MAX_RUNS_PER_TASK = 100

/** Keep only the latest MAX_RUNS_PER_TASK entries per task. */
function trimRuns(data: RunsFile): void {
  const countByTask = new Map<string, number>()
  // Count from the end (newest first) and mark for removal
  const keep = new Array<boolean>(data.runs.length).fill(false)
  for (let i = data.runs.length - 1; i >= 0; i--) {
    const taskId = data.runs[i].taskId
    const count = countByTask.get(taskId) || 0
    if (count < MAX_RUNS_PER_TASK) {
      keep[i] = true
      countByTask.set(taskId, count + 1)
    }
  }
  data.runs = data.runs.filter((_, i) => keep[i])
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const MISSED_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

function minuteStart(value: Date): Date {
  const minute = new Date(value)
  minute.setSeconds(0, 0)
  return minute
}

function occurrenceKey(value: Date): string {
  return minuteStart(value).toISOString()
}

function scheduledRunId(taskId: string, occurrence: string): string {
  return `occ_${crypto.createHash('sha256').update(`${taskId}:${occurrence}`).digest('hex').slice(0, 24)}`
}

export function latestScheduledOccurrence(task: CronTask, now: Date): Date | null {
  const fields = parseCronExpression(task.cron)
  if (!fields) return null
  const current = minuteStart(now)
  if (task.missedRunPolicy === 'skip') {
    return cronFieldsMatch(fields, current, task.timeZone ?? 'UTC') ? current : null
  }
  const lastFired = task.lastFiredAt && Number.isFinite(Date.parse(task.lastFiredAt))
    ? Date.parse(task.lastFiredAt)
    : Number.NEGATIVE_INFINITY
  const lowerBound = Math.max(task.createdAt, lastFired, current.getTime() - MISSED_RUN_LOOKBACK_MS)
  for (let timestamp = current.getTime(); timestamp > lowerBound; timestamp -= 60_000) {
    const candidate = new Date(timestamp)
    if (cronFieldsMatch(fields, candidate, task.timeZone ?? 'UTC')) return candidate
  }
  return null
}

export function nextScheduledOccurrence(task: CronTask, now: Date): Date | null {
  const fields = parseCronExpression(task.cron)
  if (!fields || task.enabled === false) return null
  const first = minuteStart(new Date(now.getTime() + 60_000)).getTime()
  const end = first + 400 * 24 * 60 * 60_000
  for (let timestamp = first; timestamp <= end;) {
    const candidate = new Date(timestamp)
    if (cronFieldsMatch(fields, candidate, task.timeZone ?? 'UTC')) return candidate
    const parts = zonedDateParts(candidate, task.timeZone ?? 'UTC')
    if (!fields.month.includes(parts.month) || !fields.hour.includes(parts.hour)) {
      timestamp += Math.max(1, 60 - parts.minute) * 60_000
      continue
    }
    const nextMinute = fields.minute.find(value => value > parts.minute)
    timestamp += (nextMinute === undefined ? 60 - parts.minute + fields.minute[0] : nextMinute - parts.minute) * 60_000
  }
  return null
}

export function resolveCronTaskTimeoutMs(
  env: { BB_TASK_TIMEOUT_MS?: string } | NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.BB_TASK_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS

  const timeoutMs = Number(raw)
  return Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TASK_TIMEOUT_MS
}

export class CronScheduler {
  private intervalId: Timer | null = null
  private runningTasks = new Map<string, { startedAt: number; runId: string }>()
  /** Track which minute each task last fired (prevents same-process duplicate within a minute). */
  private lastFiredMinuteKey = new Map<string, string>()
  private cronService: CronService
  private readonly taskRuns: ScheduledTaskRunBridge
  private readonly now: () => Date
  private ticking = false

  constructor(cronService: CronService, taskRuns: ScheduledTaskRunBridge, now: () => Date = () => new Date()) {
    this.cronService = cronService
    this.taskRuns = taskRuns
    this.now = now
  }

  /** Return a string key representing the calendar minute of `date`. */
  private static minuteKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`
  }

  /** Start the scheduler (called on server boot). */
  start(): void {
    if (this.intervalId) return // already running
    console.log('[CronScheduler] Starting — checking every 60 s')
    // Clean up stale "running" entries left by previously crashed processes
    void this.cleanupStaleRuns()
      .catch((err) => console.error('[CronScheduler] Error cleaning up stale runs:', err))
      .then(() => this.tick())
    this.intervalId = setInterval(() => this.tick(), 60_000)
  }

  /** Stop scheduling new occurrences and clear transient submission guards. */
  stop(): void {
    const wasRunning = this.intervalId !== null || this.runningTasks.size > 0
    if (!wasRunning) return

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    for (const taskId of this.runningTasks.keys()) this.runningTasks.delete(taskId)
    console.log('[CronScheduler] Stopped')
  }

  /** One tick of the scheduler — evaluate all tasks against the current time. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.reconcileRuns()
      const tasks = await this.cronService.listTasks()
      const now = this.now()
      const currentKey = CronScheduler.minuteKey(now)
      await Promise.all(tasks.map(async (task) => {
        // Skip disabled tasks
        if (task.enabled === false) return

        // Skip if already running (in-memory guard — same process)
        if (this.runningTasks.has(task.id)) return

        // Skip if this process already fired the task in the current minute
        if (this.lastFiredMinuteKey.get(task.id) === currentKey) return

        const occurrence = latestScheduledOccurrence(task, now)
        if (!occurrence) return
        this.lastFiredMinuteKey.set(task.id, currentKey)
        await this.executeTask(task, { trigger: 'schedule', occurrenceAt: occurrence })
      }))
    } catch (err) {
      console.error('[CronScheduler] Error during tick:', err)
    } finally {
      this.ticking = false
    }
  }

  /** Execute one unattended task and preserve its output/error history. */
  async executeTask(
    task: CronTask,
    execution: { trigger: 'schedule' | 'manual'; occurrenceAt: Date } = { trigger: 'manual', occurrenceAt: this.now() },
  ): Promise<TaskRun> {
    // Prevent concurrent executions of the same task
    const existing = this.runningTasks.get(task.id)
    if (existing) {
      console.log(
        `[CronScheduler] Task ${task.id} is already running (runId=${existing.runId}), skipping`,
      )
      return {
        id: existing.runId,
        taskId: task.id,
        taskName: task.name || task.prompt.slice(0, 60),
        startedAt: new Date(existing.startedAt).toISOString(),
        status: 'running',
        prompt: task.prompt,
      }
    }

    const logicalOccurrence = occurrenceKey(execution.occurrenceAt)
    const runId = execution.trigger === 'schedule'
      ? scheduledRunId(task.id, logicalOccurrence)
      : crypto.randomBytes(6).toString('hex')
    const startedAt = this.now().toISOString()

    const run: TaskRun = {
      id: runId,
      taskId: task.id,
      taskName: task.name || task.prompt.slice(0, 60),
      startedAt,
      status: 'running',
      prompt: task.prompt,
      occurrenceAt: logicalOccurrence,
      trigger: execution.trigger,
    }

    // Claim the in-process slot before the first durable await. Cross-process
    // deduplication follows through lastFiredAt below.
    this.runningTasks.set(task.id, { startedAt: Date.parse(startedAt), runId })
    try {
      await appendRun(run)
      if (!task.folderPath || !existsSync(task.folderPath) || !statSync(task.folderPath).isDirectory()) {
        throw new Error('SCHEDULE_WORKDIR_UNAVAILABLE')
      }
      const workDir = this.resolveCanonicalWorkDir(task.folderPath)

      // The scheduled occurrence is now a durable ProductTask TaskRun. Do not
      // spawn a second public runtime or synthesize an empty Core session here.
      const durable = await this.taskRuns.submitScheduledTaskRun(
        task.id,
        task.name || task.prompt.slice(0, 60),
        task.prompt,
        workDir,
        execution.trigger === 'schedule' ? logicalOccurrence : `manual:${crypto.randomUUID()}`,
        task.context ?? { mode: 'independent' },
      )
      const acceptedRun: TaskRun = {
        ...run,
        productRunId: durable.run_id,
        productTaskId: durable.task_id,
        dispatchGeneration: durable.dispatch_generation,
        output: '已提交到 ProductTask，正在执行',
      }
      await updateRun(acceptedRun)
      if (execution.trigger === 'schedule') await this.cronService.updateLastFired(task.id, logicalOccurrence)
      if (!task.recurring) await this.cronService.updateTask(task.id, { enabled: false }).catch(() => {})
      return acceptedRun
    } catch (error) {
      this.runningTasks.delete(task.id)
      const completedAt = this.now().toISOString()
      const failedRun: TaskRun = { ...run, completedAt, status: 'failed', error: (error as Error).message, durationMs: Date.parse(completedAt) - Date.parse(startedAt) }
      await updateRun(failedRun)
      if (execution.trigger === 'schedule') await this.cronService.updateLastFired(task.id, logicalOccurrence).catch(() => {})
      return failedRun
    }
  }

  async cancelTaskRun(taskId: string, runId: string): Promise<boolean> {
    const run = (await readRunsFile()).runs.find(entry => entry.id === runId && entry.taskId === taskId)
    if (!run || run.status !== 'running' || !run.productRunId || !run.dispatchGeneration || !this.taskRuns.stopScheduledTaskRun) return false
    return await this.taskRuns.stopScheduledTaskRun(run.productRunId, run.dispatchGeneration)
  }

  private resolveCanonicalWorkDir(workDir: string): string {
    try {
      return realpathSync(workDir)
    } catch {
      return workDir
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Mark stale "running" entries as "failed" on startup.
   * These are leftover from previous process instances that crashed or were
   * killed before they could update the run log.
   */
  private async cleanupStaleRuns(): Promise<void> {
    await this.reconcileRuns(true)
  }

  private async reconcileRuns(allowLegacyTimeout = false): Promise<void> {
    const data = await readRunsFile()
    const now = this.now().getTime()
    const timeoutMs = resolveCronTaskTimeoutMs()
    await Promise.all(data.runs.filter((run) => run.status === 'running').map(async (run) => {
      this.runningTasks.set(run.taskId, { startedAt: Date.parse(run.startedAt), runId: run.id })
      let terminal: 'completed' | 'failed' | 'cancelled' | undefined
      let completedAt: string | undefined
      if (run.productRunId && run.dispatchGeneration && this.taskRuns.inspectScheduledTaskRun) {
        try {
          const state = await this.taskRuns.inspectScheduledTaskRun(run.productRunId, run.dispatchGeneration)
          if (state.state !== 'running') {
            terminal = state.state
            completedAt = state.completed_at
          }
        } catch {
          if (allowLegacyTimeout && now - Date.parse(run.startedAt) > timeoutMs + 60_000) terminal = 'failed'
        }
      } else if (allowLegacyTimeout && now - Date.parse(run.startedAt) > timeoutMs + 60_000) {
        terminal = 'failed'
      }
      if (!terminal) return
      const settledAt = completedAt && Number.isFinite(Date.parse(completedAt))
        ? completedAt
        : this.now().toISOString()
      const settled: TaskRun = {
        ...run,
        status: terminal,
        completedAt: settledAt,
        durationMs: Math.max(0, Date.parse(settledAt) - Date.parse(run.startedAt)),
        output: terminal === 'completed' ? 'ProductTask 已完成' : undefined,
        ...(terminal === 'failed' ? { error: 'PRODUCT_TASK_NOT_COMPLETED' } : {}),
        ...(terminal === 'cancelled' ? { output: '已取消' } : {}),
      }
      await updateRun(settled)
      if (this.runningTasks.get(run.taskId)?.runId === run.id) this.runningTasks.delete(run.taskId)
    }))
  }

  // ─── Query helpers ─────────────────────────────────────────────────────────

  /** Get execution history for a specific task. */
  async getTaskRuns(taskId: string): Promise<TaskRun[]> {
    await this.reconcileRuns()
    const data = await readRunsFile()
    return data.runs
      .filter((r) => r.taskId === taskId)
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )
  }

  /** Get recent runs across all tasks. */
  async getRecentRuns(limit = 50): Promise<TaskRun[]> {
    await this.reconcileRuns()
    const data = await readRunsFile()
    return data.runs
      .sort(
        (a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      )
      .slice(0, limit)
  }
}
