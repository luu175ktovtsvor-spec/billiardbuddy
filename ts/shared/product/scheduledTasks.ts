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
  'cancelled',
] as const

export type ProductScheduledTaskRunStatus =
  (typeof PRODUCT_SCHEDULED_TASK_RUN_STATUSES)[number]

export type ProductScheduledTaskNotification = {
  enabled: boolean
  channels: Array<'desktop'>
}

export const PRODUCT_SCHEDULED_TASK_MISSED_RUN_POLICIES = [
  'run_once',
  'skip',
] as const

export type ProductScheduledTaskMissedRunPolicy =
  (typeof PRODUCT_SCHEDULED_TASK_MISSED_RUN_POLICIES)[number]

export type ProductScheduledTaskContext =
  | { mode: 'independent' }
  | { mode: 'related_task'; taskId: string }

/**
 * Scheduled runs use one deliberately narrow grant. The selected workDir is
 * the sandbox root; ordinary writes inside it are allowed, while network,
 * destructive and out-of-scope actions are denied by the automatic reviewer.
 */
export type ProductScheduledTaskGrant = {
  version: 1
  scope: 'workdir'
  fileAccess: 'workspace_write'
  networkAccess: 'denied'
  destructiveActions: 'denied'
}

export type ProductScheduledTask = {
  id: string
  title: string
  description?: string
  schedule: string
  timeZone: string
  instruction: string
  enabled: boolean
  recurring: boolean
  missedRunPolicy: ProductScheduledTaskMissedRunPolicy
  context: ProductScheduledTaskContext
  grant: ProductScheduledTaskGrant
  createdAt: number
  lastRunAt?: string
  nextRunAt?: string
  workDir?: string
  notification?: ProductScheduledTaskNotification
}

export type CreateProductScheduledTaskInput = {
  title: string
  description?: string
  schedule: string
  timeZone: string
  instruction: string
  enabled?: boolean
  recurring?: boolean
  missedRunPolicy?: ProductScheduledTaskMissedRunPolicy
  context?: ProductScheduledTaskContext
  workDir: string
  notification?: ProductScheduledTaskNotification
}

export type UpdateProductScheduledTaskInput = {
  title?: string
  description?: string | null
  schedule?: string
  timeZone?: string
  instruction?: string
  enabled?: boolean
  recurring?: boolean
  missedRunPolicy?: ProductScheduledTaskMissedRunPolicy
  context?: ProductScheduledTaskContext
  workDir?: string | null
  notification?: ProductScheduledTaskNotification | null
}

export type ProductScheduledTaskRun = {
  id: string
  taskId: string
  taskTitle: string
  startedAt: string
  occurrenceAt: string
  trigger: 'schedule' | 'manual'
  productTaskId?: string
  completedAt?: string
  status: ProductScheduledTaskRunStatus
  result?: string
  durationMs?: number
}
