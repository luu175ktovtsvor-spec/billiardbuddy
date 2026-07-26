/**
 * CronService — 管理定时任务的增删改查
 *
 * 任务持久化到 ~/.BilliardBuddy/scheduled_tasks.json（JSON 文件）。
 * 文件格式: { "schemaVersion": 1, "tasks": [ CronTask, ... ] }
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { lock } from '../../utils/lockfile.js'
import type {
  ProductScheduledTaskContext,
  ProductScheduledTaskMissedRunPolicy,
} from '../../../shared/product/scheduledTasks.js'

export type TaskNotificationConfig = {
  enabled: boolean
  channels: ('desktop')[]
}

/**
 * Scheduled tasks are always unattended.  They must never inherit an
 * interactive session's permission mode or opt into the Core bypass mode.
 * `dontAsk` keeps ordinary read-only/allowed work available, while rejecting
 * every action that would otherwise require an approval prompt.
 */
export const SCHEDULED_TASK_PERMISSION_MODE = 'dontAsk' as const
export type ScheduledTaskPermissionMode = typeof SCHEDULED_TASK_PERMISSION_MODE

export function isScheduledTaskPermissionMode(
  value: unknown,
): value is ScheduledTaskPermissionMode {
  return value === SCHEDULED_TASK_PERMISSION_MODE
}

export type CronTask = {
  id: string
  name?: string
  description?: string
  cron: string // 5-field cron expression
  timeZone?: string
  prompt: string
  createdAt: number // epoch ms
  lastFiredAt?: string // ISO timestamp of last execution
  enabled?: boolean // allow disabling without deleting (default true)
  recurring?: boolean
  missedRunPolicy?: ProductScheduledTaskMissedRunPolicy
  context?: ProductScheduledTaskContext
  permissionMode?: ScheduledTaskPermissionMode
  folderPath?: string
  notification?: TaskNotificationConfig
}

export const CURRENT_SCHEDULED_TASKS_SCHEMA_VERSION = 1

type TasksFile = {
  schemaVersion: typeof CURRENT_SCHEDULED_TASKS_SCHEMA_VERSION
  tasks: CronTask[]
}

const TASKS_FILE_WRITE_ATTEMPTS = 2
const tasksFileLocks = new Map<string, Promise<void>>()

export class CronService {
  constructor(
    private readonly configDir?: string,
    private readonly fileOps: { rename?: typeof fs.rename } = {},
  ) {}

  /** 任务文件路径 */
  private getTasksFilePath(): string {
    const configDir = this.configDir
      ?? process.env.BILLIARDBUDDY_CONFIG_DIR
      ?? path.join(os.homedir(), '.BilliardBuddy')
    return path.join(configDir, 'scheduled_tasks.json')
  }

  private async withTasksLock<T>(operation: () => Promise<T>): Promise<T> {
    const filePath = this.getTasksFilePath()
    const previous = tasksFileLocks.get(filePath) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    tasksFileLocks.set(filePath, current)

    await previous
    const guardPath = `${filePath}.guard`
    let releaseFileLock: (() => Promise<void>) | undefined
    try {
      await fs.mkdir(path.dirname(guardPath), { recursive: true })
      await fs.open(guardPath, 'a', 0o600).then((handle) => handle.close())
      releaseFileLock = await lock(guardPath, {
        stale: 30_000,
        retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
      })
      return await operation()
    } finally {
      await releaseFileLock?.()
      release()
      if (tasksFileLocks.get(filePath) === current) {
        tasksFileLocks.delete(filePath)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 公开方法
  // ---------------------------------------------------------------------------

  /** 获取所有任务 */
  async listTasks(): Promise<CronTask[]> {
    const data = await this.readTasksFile()
    return data.tasks
  }

  /** Persist the supported legacy envelope before the scheduler can execute it. */
  async migrateSupportedStorage(): Promise<void> {
    await this.withTasksLock(async () => {
      const filePath = this.getTasksFilePath()
      const before = await fs.readFile(filePath, 'utf-8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (before === null) return
      const data = await this.readTasksFile()
      const after = JSON.stringify(data, null, 2) + '\n'
      if (before !== after) await this.writeTasksFile(data)
    })
  }

  /** 创建新任务 */
  async createTask(
    task: Omit<CronTask, 'id' | 'createdAt'>,
  ): Promise<CronTask> {
    return this.withTasksLock(async () => {
      if (!task.cron || !task.prompt) {
        throw ApiError.badRequest('Fields "cron" and "prompt" are required')
      }

      const data = await this.readTasksFile()
      const {
        permissionMode: _requestedPermissionMode,
        useWorktree: _legacyUseWorktree,
        ...safeTask
      } = task as typeof task & { useWorktree?: unknown }
      const newTask: CronTask = {
        ...safeTask,
        permissionMode: SCHEDULED_TASK_PERMISSION_MODE,
        missedRunPolicy: safeTask.missedRunPolicy ?? 'run_once',
        timeZone: safeTask.timeZone ?? systemTimeZone(),
        context: safeTask.context ?? { mode: 'independent' },
        id: crypto.randomBytes(4).toString('hex'),
        createdAt: Date.now(),
      }
      data.tasks.push(newTask)
      await this.writeTasksFile(data)
      return newTask
    })
  }

  /** 更新已有任务 */
  async updateTask(id: string, updates: Partial<CronTask>): Promise<CronTask> {
    return this.withTasksLock(async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) {
        throw ApiError.notFound(`Task not found: ${id}`)
      }

      // 不允许修改 id 和 createdAt
      const {
        id: _id,
        createdAt: _ca,
        permissionMode: _requestedPermissionMode,
        useWorktree: _legacyUseWorktree,
        ...safeUpdates
      } = updates as typeof updates & { useWorktree?: unknown }
      data.tasks[index] = {
        ...data.tasks[index],
        ...safeUpdates,
        permissionMode: SCHEDULED_TASK_PERMISSION_MODE,
        missedRunPolicy: safeUpdates.missedRunPolicy ?? data.tasks[index].missedRunPolicy ?? 'run_once',
        timeZone: safeUpdates.timeZone ?? data.tasks[index].timeZone ?? systemTimeZone(),
        context: safeUpdates.context ?? data.tasks[index].context ?? { mode: 'independent' },
      }
      await this.writeTasksFile(data)
      return data.tasks[index]
    })
  }

  /** 删除任务 */
  async deleteTask(id: string): Promise<void> {
    await this.withTasksLock(async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) {
        throw ApiError.notFound(`Task not found: ${id}`)
      }
      data.tasks.splice(index, 1)
      await this.writeTasksFile(data)
    })
  }

  /** 更新任务的最后执行时间 */
  async updateLastFired(taskId: string, timestamp: string): Promise<void> {
    await this.withTasksLock(async () => {
      const data = await this.readTasksFile()
      const index = data.tasks.findIndex((t) => t.id === taskId)
      if (index === -1) {
        return // Task may have been deleted; silently ignore
      }
      data.tasks[index].lastFiredAt = timestamp
      await this.writeTasksFile(data)
    })
  }

  // ---------------------------------------------------------------------------
  // 内部: 文件读写
  // ---------------------------------------------------------------------------

  /** 读取任务 JSON 文件。文件不存在时返回空列表。 */
  private async readTasksFile(): Promise<TasksFile> {
    try {
      const raw = await fs.readFile(this.getTasksFilePath(), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<TasksFile>
      if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== CURRENT_SCHEDULED_TASKS_SCHEMA_VERSION) {
        throw new Error('UNSUPPORTED_SCHEDULED_TASKS_SCHEMA')
      }
      if (!Array.isArray(parsed.tasks)) throw new Error('INVALID_SCHEDULED_TASKS_SCHEMA')
      return {
        schemaVersion: CURRENT_SCHEDULED_TASKS_SCHEMA_VERSION,
        tasks: parsed.tasks.map((task) => {
          const {
            useWorktree: _legacyUseWorktree,
            model: _legacyModel,
            providerId: _legacyProviderId,
            permanent: _legacyPermanent,
            frequency: _legacyFrequency,
            scheduledTime: _legacyScheduledTime,
            folder: legacyFolder,
            ...safeTask
          } = task as CronTask & {
            useWorktree?: unknown
            model?: unknown
            providerId?: unknown
            permanent?: unknown
            frequency?: unknown
            scheduledTime?: unknown
            folder?: unknown
          }
          const folderPath = safeTask.folderPath
            ?? (typeof legacyFolder === 'string' && legacyFolder.trim() ? legacyFolder : undefined)
          return {
            ...safeTask,
            // Existing desktop builds persisted bypassPermissions. Normalize it
            // on every read so it can never reach the scheduler again; the next
            // write persists the migrated value. A scheduled task never had a
            // worktree launcher, so discard that legacy no-op setting too.
            permissionMode: SCHEDULED_TASK_PERMISSION_MODE,
            missedRunPolicy: safeTask.missedRunPolicy === 'skip' ? 'skip' : 'run_once',
            timeZone: safeTask.timeZone ?? systemTimeZone(),
            context: safeTask.context?.mode === 'related_task' && safeTask.context.taskId
              ? safeTask.context
              : { mode: 'independent' },
            ...(folderPath ? { folderPath } : {}),
          }
        }),
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: CURRENT_SCHEDULED_TASKS_SCHEMA_VERSION, tasks: [] }
      }
      throw ApiError.internal(
        `Failed to read scheduled tasks: ${(err as Error).message}`,
      )
    }
  }

  /** 原子写入任务 JSON 文件 */
  private async writeTasksFile(data: TasksFile): Promise<void> {
    const filePath = this.getTasksFilePath()
    const dir = path.dirname(filePath)
    const contents = JSON.stringify(data, null, 2) + '\n'
    let lastError: Error | undefined

    for (let attempt = 0; attempt < TASKS_FILE_WRITE_ATTEMPTS; attempt++) {
      const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`

      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmpFile, contents, { encoding: 'utf-8', mode: 0o600 })
        await (this.fileOps.rename ?? fs.rename)(tmpFile, filePath)
        return
      } catch (err) {
        lastError = err as Error
        await fs.unlink(tmpFile).catch(() => {})

        if (
          (err as NodeJS.ErrnoException).code !== 'ENOENT' ||
          attempt === TASKS_FILE_WRITE_ATTEMPTS - 1
        ) {
          break
        }
      }
    }

    throw ApiError.internal(
      `Failed to write scheduled tasks: ${lastError?.message ?? 'unknown error'}`,
    )
  }
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
