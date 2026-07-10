// 定时任务调度引擎(触发器)。
//
// 照搬 cc-haha `src/server/services/cronScheduler.ts` 的整套调度骨架(白标):
//   · 每 60s 一个 tick,遍历所有任务,判定到点者触发
//   · runningTasks 内存守卫防同一任务并发重入
//   · 运行历史落 JSON 文件(<stateRoot>/scheduled-tasks-log.json),每任务保留最近 N 条
//   · 启动时清理上次进程崩溃遗留的 "running" 陈旧记录
//   · 错过补跑:进程宕机期间已过的 next_run_at,重启后首个 tick 补触发一次
//
// 与 cc 的唯一有意分叉(#66 owner 铁律)——触发方式:
//   cc-desktop 的 cronScheduler 到点是 `Bun.spawn` 拉起一个 CLI 子进程(那个子进程内部才跑 agent 循环)。
//   我们的后端本身就在进程内跑 agent 循环(server 的 createTurnStream / runAgentLoop),所以到点直接调用
//   注入的 fireTask 回调 → 在进程内开一个真会话让模型在 cc 循环里用工具把任务干完。净效果一致(都是「起一个
//   真 agent 会话」),只是省掉子进程。**绝不是执行写死的 SOP 脚本**。
//
// 到点判定用 next_run_at 时间戳(cc-haha cron.ts 的 computeNextCronRun 语义),而非 cc-desktop 的
// 「cronMatches(now)+分钟去重」——因为我们的存储已持久化 next_run_at,时间戳法天然支持补跑、且无分钟竞态。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { computeNextRunAt, isRecurringSchedule } from './scheduledTaskSchedule'

type JsonObject = Record<string, unknown>

/** 单次运行结果(白标 cc TaskRun)。 */
export interface ScheduledTaskRun {
  id: string
  task_id: string
  task_name: string
  started_at: string
  completed_at?: string
  status: 'running' | 'completed' | 'failed'
  instruction: string
  summary?: string
  error?: string
  duration_ms?: number
  conversation_id?: string
}

/** fireTask 回调的返回:模型会话跑完后的产出/状态。 */
export interface FireTaskResult {
  status?: 'completed' | 'failed'
  summary?: string
  error?: string
  conversationId?: string
}

/** 触发一个任务 = 起一个真 agent 会话(见 index.ts 的注入实现)。 */
export type FireTask = (
  task: JsonObject,
  ctx: { runId: string; manual: boolean; signal?: AbortSignal },
) => Promise<FireTaskResult>

interface ScheduledTaskStore {
  listScheduledTasks(): Promise<JsonObject[]>
  updateScheduledTask(id: string, patch: JsonObject): Promise<JsonObject | null>
}

export interface ScheduledTaskRunnerOptions {
  store: ScheduledTaskStore
  stateRoot: string
  fireTask: FireTask
  tickMs?: number
  now?: () => number
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

type RunsFile = { runs: ScheduledTaskRun[] }

const MAX_RUNS_PER_TASK = 100
const DEFAULT_TICK_MS = 60_000
// "running" 状态存活超过这个时长几乎肯定是宿主进程崩了没写回,启动时标记为 failed。
const STALE_RUN_MS = 30 * 60 * 1000

function randomId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 12)
}

export class ScheduledTaskRunner {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private readonly runningTasks = new Map<string, { runId: string; controller: AbortController; startedAt: number }>()
  private readonly logFilePath: string
  private writeQueue: Promise<void> = Promise.resolve()

  private readonly store: ScheduledTaskStore
  private readonly fireTask: FireTask
  private readonly tickMs: number
  private readonly now: () => number
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>

  constructor(opts: ScheduledTaskRunnerOptions) {
    this.store = opts.store
    this.fireTask = opts.fireTask
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS
    this.now = opts.now ?? (() => Date.now())
    this.logger = opts.logger ?? console
    this.logFilePath = join(opts.stateRoot, 'scheduled-tasks-log.json')
  }

  /** 服务器启动时调用:清陈旧运行 → 回填缺失的 next_run_at → 起 tick 定时器 → 立即先 tick 一次(含补跑)。 */
  start(): void {
    if (this.intervalId) return
    this.cleanupStaleRuns().catch(err => this.logger.error('[scheduler] cleanup stale runs failed:', err))
    this.intervalId = setInterval(() => {
      void this.tick()
    }, this.tickMs)
    // 定时器不该拖住进程退出(Electron 壳/测试友好)。
    ;(this.intervalId as unknown as { unref?: () => void }).unref?.()
    void this.tick()
  }

  /** 停止调度并中断在跑的任务会话。 */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    for (const [taskId, entry] of this.runningTasks) {
      try {
        entry.controller.abort()
      } catch {
        // ignore
      }
      this.runningTasks.delete(taskId)
    }
  }

  /** 一个 tick:遍历任务,到点(next_run_at <= now)且未在跑者触发。 */
  async tick(): Promise<void> {
    let tasks: JsonObject[]
    try {
      tasks = await this.store.listScheduledTasks()
    } catch (err) {
      this.logger.error('[scheduler] tick list failed:', err)
      return
    }
    const nowMs = this.now()
    const inflight: Promise<unknown>[] = []

    for (const task of tasks) {
      const id = typeof task.id === 'string' ? task.id : null
      if (!id) continue
      if (task.enabled === false) continue
      if (this.runningTasks.has(id)) continue

      const dueMs = await this.dueTimestamp(task, nowMs)
      if (dueMs === null) continue

      if (dueMs <= nowMs) {
        // 到点(含补跑:next_run_at 落在过去)。本 tick 里所有到点任务同时起跑;runningTasks 守卫保证
        // 下个 tick(60s 后)不会重入仍在跑的任务。await 全部起跑的 fire 只为让 start() 的立即 tick 与
        // 测试可确定性收尾——生产用 `void this.tick()` 调用,不阻塞定时器。
        inflight.push(
          this.executeTask(task, { manual: false }).catch(err =>
            this.logger.error(`[scheduler] execute task ${id} failed:`, err),
          ),
        )
      }
    }
    await Promise.allSettled(inflight)
  }

  /**
   * 求任务的「下次应触发」时间戳(ms)。
   * - next_run_at 已持久化 → 直接用。
   * - 缺失(老任务/刚建未回填)→ 现算并回写,但**不立刻触发**(返回未来时刻),避免新建的每日任务被误当补跑立即跑。
   * - 无法排程(manual / once 已过)→ null。
   */
  private async dueTimestamp(task: JsonObject, nowMs: number): Promise<number | null> {
    const raw = task.next_run_at
    if (typeof raw === 'string' && raw.trim()) {
      const ms = Date.parse(raw)
      return Number.isFinite(ms) ? ms : null
    }
    if (raw === null || raw === undefined) {
      const computed = computeNextRunAt(task, nowMs)
      if (computed && typeof task.id === 'string') {
        await this.store.updateScheduledTask(task.id, { next_run_at: computed }).catch(() => undefined)
      }
      return null // 本轮不触发,下一 tick 用回写后的 next_run_at 正常判定
    }
    return null
  }

  /** 手动「立即运行」:无视排程直接触发一次(面板 Run Now)。 */
  async runTaskNow(taskId: string): Promise<ScheduledTaskRun | null> {
    const tasks = await this.store.listScheduledTasks()
    const task = tasks.find(t => t.id === taskId)
    if (!task) return null
    return this.executeTask(task, { manual: true })
  }

  /**
   * 触发单个任务:开一个真 agent 会话(fireTask),把产出/状态写回运行历史与任务本身。
   * @param options.manual 手动立即运行(不改 next_run_at 的"到点"语义,但照常记历史 + 更新 last_run_*)
   */
  async executeTask(task: JsonObject, options: { manual: boolean }): Promise<ScheduledTaskRun> {
    const taskId = String(task.id)
    const existing = this.runningTasks.get(taskId)
    if (existing) {
      // 已在跑,不重入(cc 同款守卫)。
      return {
        id: existing.runId,
        task_id: taskId,
        task_name: taskName(task),
        started_at: new Date(existing.startedAt).toISOString(),
        status: 'running',
        instruction: taskInstruction(task),
      }
    }

    const runId = randomId()
    const startedAtMs = this.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const controller = new AbortController()
    this.runningTasks.set(taskId, { runId, controller, startedAt: startedAtMs })

    const run: ScheduledTaskRun = {
      id: runId,
      task_id: taskId,
      task_name: taskName(task),
      started_at: startedAt,
      status: 'running',
      instruction: taskInstruction(task),
    }
    await this.appendRun(run)

    let result: FireTaskResult
    try {
      result = await this.fireTask(task, { runId, manual: options.manual, signal: controller.signal })
    } catch (err) {
      result = { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.runningTasks.delete(taskId)
    }

    const completedAtMs = this.now()
    const status: ScheduledTaskRun['status'] = result.status === 'failed' || result.error ? 'failed' : 'completed'
    const completedRun: ScheduledTaskRun = {
      ...run,
      status,
      completed_at: new Date(completedAtMs).toISOString(),
      duration_ms: Math.max(0, completedAtMs - startedAtMs),
      summary: result.summary ? result.summary.slice(0, 20_000) : undefined,
      error: result.error ? result.error.slice(0, 5_000) : undefined,
      conversation_id: result.conversationId,
    }
    await this.updateRun(completedRun)

    // 回写任务:last_run_* + 重排 next_run_at(一次性任务跑完关闭)。
    const patch: JsonObject = {
      last_run_at: completedRun.completed_at,
      last_run_status: status,
      last_result_summary: completedRun.summary ?? completedRun.error ?? null,
      last_run_conversation_id: result.conversationId ?? null,
    }
    if (isRecurringSchedule(task)) {
      patch.next_run_at = computeNextRunAt(task, completedAtMs)
    } else {
      patch.next_run_at = null
      if (!options.manual) patch.enabled = false // 自动触发的一次性任务跑完即停用;手动运行不改启停
    }
    await this.store.updateScheduledTask(taskId, patch).catch(err =>
      this.logger.warn(`[scheduler] write-back task ${taskId} failed:`, err),
    )

    return completedRun
  }

  // ─── 运行历史查询 ────────────────────────────────────────────────

  async getTaskRuns(taskId: string): Promise<ScheduledTaskRun[]> {
    const data = await this.readRunsFile()
    return data.runs
      .filter(r => r.task_id === taskId)
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
  }

  async getRecentRuns(limit = 50): Promise<ScheduledTaskRun[]> {
    const data = await this.readRunsFile()
    return data.runs
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .slice(0, limit)
  }

  // ─── 运行历史 JSON 文件读写(原子写) ──────────────────────────────

  private async readRunsFile(): Promise<RunsFile> {
    try {
      const parsed = JSON.parse(await readFile(this.logFilePath, 'utf8')) as unknown
      const runs = (parsed as RunsFile)?.runs
      return Array.isArray(runs) ? { runs } : { runs: [] }
    } catch {
      return { runs: [] }
    }
  }

  private async writeRunsFile(data: RunsFile): Promise<void> {
    const run = this.writeQueue.then(async () => {
      await mkdir(join(this.logFilePath, '..'), { recursive: true })
      const tmp = `${this.logFilePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      await rename(tmp, this.logFilePath)
    })
    this.writeQueue = run.catch(() => undefined)
    await run
  }

  private async appendRun(run: ScheduledTaskRun): Promise<void> {
    const data = await this.readRunsFile()
    data.runs.push(run)
    trimRuns(data)
    await this.writeRunsFile(data)
  }

  private async updateRun(run: ScheduledTaskRun): Promise<void> {
    const data = await this.readRunsFile()
    const idx = data.runs.findIndex(r => r.id === run.id)
    if (idx !== -1) data.runs[idx] = run
    else data.runs.push(run)
    trimRuns(data)
    await this.writeRunsFile(data)
  }

  /** 启动时把上次进程崩溃遗留的 "running" 记录标记为 failed(cc cleanupStaleRuns)。 */
  private async cleanupStaleRuns(): Promise<void> {
    const data = await this.readRunsFile()
    let changed = false
    const nowMs = this.now()
    for (const run of data.runs) {
      if (run.status !== 'running') continue
      if (nowMs - Date.parse(run.started_at) > STALE_RUN_MS) {
        run.status = 'failed'
        run.error = '进程在任务完成前退出'
        run.completed_at = new Date(nowMs).toISOString()
        run.duration_ms = Math.max(0, nowMs - Date.parse(run.started_at))
        changed = true
      }
    }
    if (changed) await this.writeRunsFile(data)
  }
}

function trimRuns(data: RunsFile): void {
  const countByTask = new Map<string, number>()
  const keep = new Array<boolean>(data.runs.length).fill(false)
  for (let i = data.runs.length - 1; i >= 0; i--) {
    const taskId = data.runs[i]!.task_id
    const count = countByTask.get(taskId) ?? 0
    if (count < MAX_RUNS_PER_TASK) {
      keep[i] = true
      countByTask.set(taskId, count + 1)
    }
  }
  data.runs = data.runs.filter((_, i) => keep[i])
}

function taskName(task: JsonObject): string {
  return typeof task.name === 'string' && task.name.trim() ? task.name.trim() : '定时任务'
}

function taskInstruction(task: JsonObject): string {
  return typeof task.instruction === 'string' ? task.instruction : ''
}
