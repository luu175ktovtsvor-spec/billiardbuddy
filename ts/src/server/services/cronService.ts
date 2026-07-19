/**
 * CronService — 管理定时任务的增删改查
 *
 * 任务持久化到 ~/.claude/scheduled_tasks.json（JSON 文件）。
 * 文件格式: { "tasks": [ CronTask, ... ] }
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'

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
  prompt: string
  createdAt: number // epoch ms
  lastFiredAt?: string // ISO timestamp of last execution
  enabled?: boolean // allow disabling without deleting (default true)
  recurring?: boolean
  permanent?: boolean
  permissionMode?: ScheduledTaskPermissionMode
  model?: string
  providerId?: string | null
  folderPath?: string
  notification?: TaskNotificationConfig
}

type TasksFile = {
  tasks: CronTask[]
}

const TASKS_FILE_WRITE_ATTEMPTS = 2

export class CronService {
  /** 任务文件路径 */
  private getTasksFilePath(): string {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    return path.join(configDir, 'scheduled_tasks.json')
  }

  // ---------------------------------------------------------------------------
  // 公开方法
  // ---------------------------------------------------------------------------

  /** 获取所有任务 */
  async listTasks(): Promise<CronTask[]> {
    const data = await this.readTasksFile()
    return data.tasks
  }

  /** 创建新任务 */
  async createTask(
    task: Omit<CronTask, 'id' | 'createdAt'>,
  ): Promise<CronTask> {
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
      id: crypto.randomBytes(4).toString('hex'),
      createdAt: Date.now(),
    }
    data.tasks.push(newTask)
    await this.writeTasksFile(data)
    return newTask
  }

  /** 更新已有任务 */
  async updateTask(id: string, updates: Partial<CronTask>): Promise<CronTask> {
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
    }
    await this.writeTasksFile(data)
    return data.tasks[index]
  }

  /** 删除任务 */
  async deleteTask(id: string): Promise<void> {
    const data = await this.readTasksFile()
    const index = data.tasks.findIndex((t) => t.id === id)
    if (index === -1) {
      throw ApiError.notFound(`Task not found: ${id}`)
    }
    data.tasks.splice(index, 1)
    await this.writeTasksFile(data)
  }

  /** 更新任务的最后执行时间 */
  async updateLastFired(taskId: string, timestamp: string): Promise<void> {
    const data = await this.readTasksFile()
    const index = data.tasks.findIndex((t) => t.id === taskId)
    if (index === -1) {
      return // Task may have been deleted; silently ignore
    }
    data.tasks[index].lastFiredAt = timestamp
    await this.writeTasksFile(data)
  }

  // ---------------------------------------------------------------------------
  // 内部: 文件读写
  // ---------------------------------------------------------------------------

  /** 读取任务 JSON 文件。文件不存在时返回空列表。 */
  private async readTasksFile(): Promise<TasksFile> {
    try {
      const raw = await fs.readFile(this.getTasksFilePath(), 'utf-8')
      const parsed = JSON.parse(raw) as TasksFile
      // 兼容异常格式
      if (!Array.isArray(parsed.tasks)) {
        return { tasks: [] }
      }
      return {
        tasks: parsed.tasks.map((task) => {
          const { useWorktree: _legacyUseWorktree, ...safeTask } = task as CronTask & {
            useWorktree?: unknown
          }
          return {
            ...safeTask,
            // Existing desktop builds persisted bypassPermissions. Normalize it
            // on every read so it can never reach the scheduler again; the next
            // write persists the migrated value. A scheduled task never had a
            // worktree launcher, so discard that legacy no-op setting too.
            permissionMode: SCHEDULED_TASK_PERMISSION_MODE,
          }
        }),
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { tasks: [] }
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
        await fs.writeFile(tmpFile, contents, 'utf-8')
        await fs.rename(tmpFile, filePath)
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
