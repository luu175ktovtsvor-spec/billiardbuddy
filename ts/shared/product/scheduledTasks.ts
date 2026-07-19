/**
 * Product-facing contract for unattended scheduled tasks.
 *
 * The Agent Core scheduler owns process launch, permission enforcement and
 * persisted provider details. This contract deliberately exposes only the
 * task information a BilliardBuddy user can act on.
 */

export const PRODUCT_SCHEDULED_TASK_RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'timeout',
] as const

export type ProductScheduledTaskRunStatus =
  (typeof PRODUCT_SCHEDULED_TASK_RUN_STATUSES)[number]

export type ProductScheduledTaskNotification = {
  enabled: boolean
  channels: Array<'desktop'>
}

export type ProductScheduledTask = {
  id: string
  title: string
  description?: string
  schedule: string
  instruction: string
  enabled: boolean
  recurring: boolean
  createdAt: number
  lastRunAt?: string
  workDir?: string
  notification?: ProductScheduledTaskNotification
}

export type CreateProductScheduledTaskInput = {
  title: string
  description?: string
  schedule: string
  instruction: string
  enabled?: boolean
  recurring?: boolean
  workDir?: string
  notification?: ProductScheduledTaskNotification
}

export type UpdateProductScheduledTaskInput = {
  title?: string
  description?: string | null
  schedule?: string
  instruction?: string
  enabled?: boolean
  recurring?: boolean
  workDir?: string | null
  notification?: ProductScheduledTaskNotification | null
}

export type ProductScheduledTaskRun = {
  id: string
  taskId: string
  taskTitle: string
  startedAt: string
  completedAt?: string
  status: ProductScheduledTaskRunStatus
  result?: string
  durationMs?: number
}
