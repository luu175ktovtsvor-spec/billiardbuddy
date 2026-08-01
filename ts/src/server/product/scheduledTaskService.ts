import type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskNotification,
  ProductScheduledTaskRun,
  UpdateProductScheduledTaskInput,
} from '../../../shared/product/scheduledTasks.js'
import { realpath, stat } from 'node:fs/promises'
import { ApiError } from '../middleware/errorHandler.js'
import {
  CronService,
  type CronTask,
  type TaskNotificationConfig,
} from '../services/cronService.js'
import {
  nextScheduledOccurrence,
  type CronScheduler,
  type TaskRun,
} from '../services/cronScheduler.js'
import { parseCronExpression } from '../../utils/cron.js'

const PRODUCT_SCHEDULED_TASK_ID = /^[0-9a-zA-Z_-]{1,64}$/
const MAX_TITLE_LENGTH = 160
const MAX_DESCRIPTION_LENGTH = 1_000
const MAX_INSTRUCTION_LENGTH = 20_000
const MAX_WORK_DIR_LENGTH = 4_096
const MAX_RESULT_LENGTH = 12_000

type ScheduledTaskScheduler = Pick<
  CronScheduler,
  'executeTask' | 'getRecentRuns' | 'getTaskRuns' | 'cancelTaskRun'
>

type RelatedTaskContextPort = {
  get(taskId: string): Promise<{ lifecycle: string; workDir: string }>
}

type JsonRecord = Record<string, unknown>

/**
 * Product adapter for the unattended scheduler. It preserves the scheduler's
 * real lifecycle and permission boundary while preventing Core-only fields
 * such as model and provider selection from reaching the renderer.
 */
export class ProductScheduledTaskService {
  constructor(
    private readonly cronService: CronService,
    private readonly scheduler: ScheduledTaskScheduler,
    private readonly relatedTaskContext: RelatedTaskContextPort,
  ) {}

  async listTasks(): Promise<ProductScheduledTask[]> {
    return (await this.cronService.listTasks()).map(publicScheduledTask)
  }

  async createTask(input: unknown): Promise<ProductScheduledTask> {
    const stored = toStoredCreateInput(input)
    stored.folderPath = await requireCanonicalWorkDir(stored.folderPath)
    await this.validateRelatedTask(stored.context, stored.folderPath)
    const task = await this.cronService.createTask(stored)
    return publicScheduledTask(task)
  }

  async updateTask(taskId: string, input: unknown): Promise<ProductScheduledTask> {
    const normalizedTaskId = requireProductScheduledTaskId(taskId)
    const existing = (await this.cronService.listTasks()).find((entry) => entry.id === normalizedTaskId)
    if (!existing) throw ApiError.notFound('定时任务不存在')
    const updates = toStoredUpdateInput(input)
    if (updates.folderPath !== undefined) {
      updates.folderPath = await requireCanonicalWorkDir(updates.folderPath)
    }
    if ((updates.enabled ?? existing.enabled ?? true) && !(updates.folderPath ?? existing.folderPath)) {
      throw ApiError.badRequest('启用定时任务前必须选择工作目录')
    }
    const nextContext = updates.context ?? existing.context ?? { mode: 'independent' as const }
    const nextWorkDir = updates.folderPath ?? existing.folderPath
    if (nextWorkDir) await this.validateRelatedTask(nextContext, nextWorkDir)
    const task = await this.cronService.updateTask(
      normalizedTaskId,
      updates,
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
    if (task.enabled === false) {
      throw new ApiError(
        409,
        '定时任务已暂停，请先启用后再运行',
        'PRODUCT_SCHEDULED_TASK_DISABLED',
      )
    }
    const workDir = await requireCanonicalWorkDir(task.folderPath)
    await this.validateRelatedTask(task.context, workDir)

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

  async cancelTaskRun(taskId: string, runId: string): Promise<void> {
    const normalizedTaskId = requireProductScheduledTaskId(taskId)
    if (!/^[0-9a-zA-Z_-]{1,96}$/.test(runId)) throw ApiError.notFound('运行记录不存在')
    if (!await this.scheduler.cancelTaskRun(normalizedTaskId, runId)) {
      throw new ApiError(409, '这次运行已经结束或暂时无法取消', 'PRODUCT_SCHEDULED_TASK_RUN_NOT_CANCELLABLE')
    }
  }

  private async validateRelatedTask(context: CronTask['context'], workDir: string): Promise<void> {
    if (context?.mode !== 'related_task') return
    const target = await this.relatedTaskContext.get(context.taskId)
    if (target.lifecycle !== 'active') {
      throw new ApiError(409, '关联任务当前不能执行定时任务', 'PRODUCT_SCHEDULED_TASK_CONTEXT_INACTIVE')
    }
    const targetWorkDir = await requireCanonicalWorkDir(target.workDir)
    if (targetWorkDir !== workDir) {
      throw new ApiError(409, '定时任务工作目录必须与关联任务一致', 'PRODUCT_SCHEDULED_TASK_WORKDIR_MISMATCH')
    }
  }
}

function toStoredCreateInput(input: unknown): Omit<CronTask, 'id' | 'createdAt'> {
  const record = requireRecord(input)
  return {
    name: requireText(record.title, '任务名称', MAX_TITLE_LENGTH),
    description: optionalText(record.description, '任务说明', MAX_DESCRIPTION_LENGTH),
    cron: requireSchedule(record.schedule),
    timeZone: requireTimeZone(record.timeZone),
    prompt: requireText(record.instruction, '任务内容', MAX_INSTRUCTION_LENGTH),
    enabled: optionalBoolean(record.enabled, '启用状态') ?? true,
    recurring: optionalBoolean(record.recurring, '重复执行') ?? true,
    folderPath: requireText(record.workDir, '工作目录', MAX_WORK_DIR_LENGTH),
    missedRunPolicy: optionalMissedRunPolicy(record.missedRunPolicy) ?? 'run_once',
    context: optionalContext(record.context) ?? { mode: 'independent' },
    notification: optionalNotification(record.notification),
  }
}

function toStoredUpdateInput(input: unknown): Partial<CronTask> {
  const record = requireRecord(input)
  const updates: Partial<CronTask> = {}

  if ('title' in record) updates.name = requireText(record.title, '任务名称', MAX_TITLE_LENGTH)
  if ('description' in record) updates.description = optionalNullableText(record.description, '任务说明', MAX_DESCRIPTION_LENGTH)
  if ('schedule' in record) updates.cron = requireSchedule(record.schedule)
  if ('timeZone' in record) updates.timeZone = requireTimeZone(record.timeZone)
  if ('instruction' in record) updates.prompt = requireText(record.instruction, '任务内容', MAX_INSTRUCTION_LENGTH)
  if ('enabled' in record) updates.enabled = optionalBoolean(record.enabled, '启用状态')
  if ('recurring' in record) updates.recurring = optionalBoolean(record.recurring, '重复执行')
  if ('missedRunPolicy' in record) updates.missedRunPolicy = requireMissedRunPolicy(record.missedRunPolicy)
  if ('context' in record) updates.context = requireContext(record.context)
  if ('workDir' in record) updates.folderPath = requireText(record.workDir, '工作目录', MAX_WORK_DIR_LENGTH)
  if ('notification' in record) updates.notification = optionalNullableNotification(record.notification)

  if (Object.keys(updates).length === 0) {
    throw ApiError.badRequest('请至少提供一项需要更新的内容')
  }
  return updates
}

function publicScheduledTask(task: CronTask): ProductScheduledTask {
  const notification = publicNotification(task.notification)
  const hasWorkDir = Boolean(task.folderPath?.trim())
  const nextRun = task.enabled === false ? null : nextScheduledOccurrence(task, new Date())
  return {
    id: task.id,
    title: boundedText(task.name?.trim() || task.prompt.trim() || '未命名定时任务', MAX_TITLE_LENGTH),
    ...(task.description?.trim()
      ? { description: boundedText(task.description.trim(), MAX_DESCRIPTION_LENGTH) }
      : {}),
    schedule: task.cron,
    timeZone: task.timeZone ?? 'UTC',
    instruction: boundedText(task.prompt, MAX_INSTRUCTION_LENGTH),
    // Older generic cron records did not require a working directory. Keep
    // them visible for repair, but never present them as runnable ProductTasks.
    enabled: task.enabled !== false && hasWorkDir,
    recurring: task.recurring !== false,
    missedRunPolicy: task.missedRunPolicy === 'skip' ? 'skip' : 'run_once',
    context: task.context?.mode === 'related_task' && task.context.taskId
      ? task.context
      : { mode: 'independent' },
    grant: {
      version: 1,
      scope: 'workdir',
      fileAccess: 'workspace_write',
      networkAccess: 'denied',
      destructiveActions: 'denied',
    },
    createdAt: Number.isFinite(task.createdAt) ? task.createdAt : 0,
    ...(validTimestamp(task.lastFiredAt) ? { lastRunAt: task.lastFiredAt } : {}),
    ...(nextRun ? { nextRunAt: nextRun.toISOString() } : {}),
    ...(task.folderPath?.trim() ? { workDir: boundedText(task.folderPath.trim(), MAX_WORK_DIR_LENGTH) } : {}),
    ...(notification ? { notification } : {}),
  }
}

function publicScheduledTaskRun(run: TaskRun): ProductScheduledTaskRun {
  const status = run.status === 'running' || run.status === 'completed' || run.status === 'timeout' || run.status === 'cancelled'
    ? run.status
    : 'failed'
  return {
    id: run.id,
    taskId: run.taskId,
    taskTitle: boundedText(run.taskName || '定时任务', MAX_TITLE_LENGTH),
    startedAt: run.startedAt,
    occurrenceAt: validTimestamp(run.occurrenceAt) ? run.occurrenceAt : run.startedAt,
    trigger: run.trigger === 'schedule' ? 'schedule' : 'manual',
    ...(run.productTaskId ? { productTaskId: run.productTaskId } : {}),
    ...(validTimestamp(run.completedAt) ? { completedAt: run.completedAt } : {}),
    status,
    ...(run.output?.trim() ? { result: boundedText(run.output.trim(), MAX_RESULT_LENGTH) } : {}),
    ...(typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0
      ? { durationMs: run.durationMs }
      : {}),
  }
}

function requireTimeZone(value: unknown): string {
  const timeZone = requireText(value, '时区', 100)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0))
    return timeZone
  } catch {
    throw ApiError.badRequest('时区格式有误')
  }
}

function optionalContext(value: unknown): CronTask['context'] | undefined {
  if (value === undefined) return undefined
  return requireContext(value)
}

function requireContext(value: unknown): NonNullable<CronTask['context']> {
  const record = requireRecord(value)
  if (record.mode === 'independent' && Object.keys(record).length === 1) return { mode: 'independent' }
  if (record.mode === 'related_task' && Object.keys(record).every(key => key === 'mode' || key === 'taskId')) {
    return { mode: 'related_task', taskId: requireText(record.taskId, '关联任务', 160) }
  }
  throw ApiError.badRequest('上下文模式格式有误')
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
  return parseCronExpression(schedule) !== null
}

function optionalMissedRunPolicy(value: unknown): 'run_once' | 'skip' | undefined {
  if (value === undefined) return undefined
  return requireMissedRunPolicy(value)
}

function requireMissedRunPolicy(value: unknown): 'run_once' | 'skip' {
  if (value !== 'run_once' && value !== 'skip') {
    throw ApiError.badRequest('休眠恢复策略格式有误')
  }
  return value
}

async function requireCanonicalWorkDir(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !value.trim()) {
    throw ApiError.badRequest('工作目录不能为空')
  }
  const canonical = await realpath(value.trim()).catch(() => undefined)
  if (!canonical || !await stat(canonical).then((entry) => entry.isDirectory()).catch(() => false)) {
    throw ApiError.badRequest('工作目录不存在或不可访问')
  }
  return canonical
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
