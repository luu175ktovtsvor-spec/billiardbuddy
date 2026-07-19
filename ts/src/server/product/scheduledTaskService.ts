import type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskNotification,
  ProductScheduledTaskRun,
  UpdateProductScheduledTaskInput,
} from '../../../shared/product/scheduledTasks.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  CronService,
  type CronTask,
  type TaskNotificationConfig,
} from '../services/cronService.js'
import {
  cronScheduler,
  type CronScheduler,
  type TaskRun,
} from '../services/cronScheduler.js'

const PRODUCT_SCHEDULED_TASK_ID = /^[0-9a-zA-Z_-]{1,64}$/
const MAX_TITLE_LENGTH = 160
const MAX_DESCRIPTION_LENGTH = 1_000
const MAX_INSTRUCTION_LENGTH = 20_000
const MAX_WORK_DIR_LENGTH = 4_096
const MAX_RESULT_LENGTH = 12_000

type ScheduledTaskScheduler = Pick<
  CronScheduler,
  'executeTask' | 'getRecentRuns' | 'getTaskRuns'
>

type JsonRecord = Record<string, unknown>

/**
 * Product adapter for the unattended scheduler. It preserves the scheduler's
 * real lifecycle and permission boundary while preventing Core-only fields
 * such as model and provider selection from reaching the renderer.
 */
export class ProductScheduledTaskService {
  constructor(
    private readonly cronService: CronService = new CronService(),
    private readonly scheduler: ScheduledTaskScheduler = cronScheduler,
  ) {}

  async listTasks(): Promise<ProductScheduledTask[]> {
    return (await this.cronService.listTasks()).map(publicScheduledTask)
  }

  async createTask(input: unknown): Promise<ProductScheduledTask> {
    const task = await this.cronService.createTask(toStoredCreateInput(input))
    return publicScheduledTask(task)
  }

  async updateTask(taskId: string, input: unknown): Promise<ProductScheduledTask> {
    const task = await this.cronService.updateTask(
      requireProductScheduledTaskId(taskId),
      toStoredUpdateInput(input),
    )
    return publicScheduledTask(task)
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.cronService.deleteTask(requireProductScheduledTaskId(taskId))
  }

  async runTask(taskId: string): Promise<void> {
    const normalizedTaskId = requireProductScheduledTaskId(taskId)
    const task = (await this.cronService.listTasks()).find((entry) => entry.id === normalizedTaskId)
    if (!task) throw ApiError.notFound('定时任务不存在')

    // The scheduler persists a real running record before starting the Core
    // process. Do not make up an optimistic client-side completion state.
    void this.scheduler.executeTask(task).catch((error) => {
      console.error('[product-scheduled-tasks] manual run failed:', error)
    })
  }

  async listRecentRuns(limit: number): Promise<ProductScheduledTaskRun[]> {
    const runs = await this.scheduler.getRecentRuns(normalizeRunLimit(limit))
    return runs.map(publicScheduledTaskRun)
  }

  async listTaskRuns(taskId: string): Promise<ProductScheduledTaskRun[]> {
    const runs = await this.scheduler.getTaskRuns(requireProductScheduledTaskId(taskId))
    return runs.map(publicScheduledTaskRun)
  }
}

export const productScheduledTaskService = new ProductScheduledTaskService()

function toStoredCreateInput(input: unknown): Omit<CronTask, 'id' | 'createdAt'> {
  const record = requireRecord(input)
  return {
    name: requireText(record.title, '任务名称', MAX_TITLE_LENGTH),
    description: optionalText(record.description, '任务说明', MAX_DESCRIPTION_LENGTH),
    cron: requireSchedule(record.schedule),
    prompt: requireText(record.instruction, '任务内容', MAX_INSTRUCTION_LENGTH),
    enabled: optionalBoolean(record.enabled, '启用状态') ?? true,
    recurring: optionalBoolean(record.recurring, '重复执行') ?? true,
    folderPath: optionalText(record.workDir, '工作目录', MAX_WORK_DIR_LENGTH),
    notification: optionalNotification(record.notification),
  }
}

function toStoredUpdateInput(input: unknown): Partial<CronTask> {
  const record = requireRecord(input)
  const updates: Partial<CronTask> = {}

  if ('title' in record) updates.name = requireText(record.title, '任务名称', MAX_TITLE_LENGTH)
  if ('description' in record) updates.description = optionalNullableText(record.description, '任务说明', MAX_DESCRIPTION_LENGTH)
  if ('schedule' in record) updates.cron = requireSchedule(record.schedule)
  if ('instruction' in record) updates.prompt = requireText(record.instruction, '任务内容', MAX_INSTRUCTION_LENGTH)
  if ('enabled' in record) updates.enabled = optionalBoolean(record.enabled, '启用状态')
  if ('recurring' in record) updates.recurring = optionalBoolean(record.recurring, '重复执行')
  if ('workDir' in record) updates.folderPath = optionalNullableText(record.workDir, '工作目录', MAX_WORK_DIR_LENGTH)
  if ('notification' in record) updates.notification = optionalNullableNotification(record.notification)

  if (Object.keys(updates).length === 0) {
    throw ApiError.badRequest('请至少提供一项需要更新的内容')
  }
  return updates
}

function publicScheduledTask(task: CronTask): ProductScheduledTask {
  const notification = publicNotification(task.notification)
  return {
    id: task.id,
    title: boundedText(task.name?.trim() || task.prompt.trim() || '未命名定时任务', MAX_TITLE_LENGTH),
    ...(task.description?.trim()
      ? { description: boundedText(task.description.trim(), MAX_DESCRIPTION_LENGTH) }
      : {}),
    schedule: task.cron,
    instruction: boundedText(task.prompt, MAX_INSTRUCTION_LENGTH),
    enabled: task.enabled !== false,
    recurring: task.recurring !== false,
    createdAt: Number.isFinite(task.createdAt) ? task.createdAt : 0,
    ...(validTimestamp(task.lastFiredAt) ? { lastRunAt: task.lastFiredAt } : {}),
    ...(task.folderPath?.trim() ? { workDir: boundedText(task.folderPath.trim(), MAX_WORK_DIR_LENGTH) } : {}),
    ...(notification ? { notification } : {}),
  }
}

function publicScheduledTaskRun(run: TaskRun): ProductScheduledTaskRun {
  const status = run.status === 'running' || run.status === 'completed' || run.status === 'timeout'
    ? run.status
    : 'failed'
  return {
    id: run.id,
    taskId: run.taskId,
    taskTitle: boundedText(run.taskName || '定时任务', MAX_TITLE_LENGTH),
    startedAt: run.startedAt,
    ...(validTimestamp(run.completedAt) ? { completedAt: run.completedAt } : {}),
    status,
    ...(run.output?.trim() ? { result: boundedText(run.output.trim(), MAX_RESULT_LENGTH) } : {}),
    ...(typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0
      ? { durationMs: run.durationMs }
      : {}),
  }
}

function requireProductScheduledTaskId(value: string): string {
  if (!PRODUCT_SCHEDULED_TASK_ID.test(value)) {
    throw ApiError.notFound('定时任务不存在')
  }
  return value
}

function requireRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('请求内容有误，请检查后重试')
  }
  return value as JsonRecord
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw ApiError.badRequest(`${label}不能为空`)
  const text = value.trim()
  if (!text) throw ApiError.badRequest(`${label}不能为空`)
  if (text.length > maxLength) throw ApiError.badRequest(`${label}过长`)
  return text
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return optionalNullableText(value, label, maxLength)
}

function optionalNullableText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${label}格式有误`)
  const text = value.trim()
  if (text.length > maxLength) throw ApiError.badRequest(`${label}过长`)
  return text || undefined
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${label}格式有误`)
  return value
}

function requireSchedule(value: unknown): string {
  const schedule = requireText(value, '执行计划', 100)
  if (!isValidSchedule(schedule)) throw ApiError.badRequest('执行计划格式有误')
  return schedule
}

function isValidSchedule(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const fieldPattern = /^(\*|(\d+(-\d+)?(\/\d+)?)(,(\d+(-\d+)?(\/\d+)?))*)$/
  const maxValues = [59, 23, 31, 12, 7]
  const minValues = [0, 0, 1, 1, 0]

  return fields.every((field, index) => {
    if (/^\*\/\d+$/.test(field) || field === '*') return true
    if (!fieldPattern.test(field)) return false
    const values = field.replace(/\/\d+/g, '').split(/[,\-]/).filter((value) => /^\d+$/.test(value))
    return values.every((value) => {
      const parsed = Number.parseInt(value, 10)
      return parsed >= minValues[index]! && parsed <= maxValues[index]!
    })
  })
}

function optionalNotification(value: unknown): TaskNotificationConfig | undefined {
  if (value === undefined || value === null) return undefined
  return requireNotification(value)
}

function optionalNullableNotification(value: unknown): TaskNotificationConfig | undefined {
  if (value === undefined || value === null) return undefined
  return requireNotification(value)
}

function requireNotification(value: unknown): TaskNotificationConfig {
  const record = requireRecord(value)
  if (typeof record.enabled !== 'boolean') throw ApiError.badRequest('通知设置格式有误')
  if (!Array.isArray(record.channels) || record.channels.some((channel) => channel !== 'desktop')) {
    throw ApiError.badRequest('通知设置格式有误')
  }
  return {
    enabled: record.enabled,
    channels: record.channels.includes('desktop') ? ['desktop'] : [],
  }
}

function publicNotification(
  notification: TaskNotificationConfig | undefined,
): ProductScheduledTaskNotification | undefined {
  if (!notification || typeof notification.enabled !== 'boolean') return undefined
  return {
    enabled: notification.enabled,
    channels: notification.channels.includes('desktop') ? ['desktop'] : [],
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function normalizeRunLimit(value: number): number {
  if (!Number.isFinite(value)) return 50
  return Math.max(1, Math.min(100, Math.floor(value)))
}

export type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskRun,
  UpdateProductScheduledTaskInput,
}
