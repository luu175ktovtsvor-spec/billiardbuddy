// Source: src/server/services/cronService.ts

export type TaskNotificationConfig = {
  enabled: boolean
  channels: ('desktop')[]
}

/**
 * Scheduled tasks run without an approval UI. The server uses this mode to
 * reject actions that would otherwise stop for a permission prompt.
 */
export type ScheduledTaskPermissionMode = 'dontAsk'

export type CronTask = {
  id: string
  name: string
  description?: string
  cron: string
  prompt: string
  enabled: boolean
  recurring?: boolean
  permanent?: boolean
  createdAt: number
  lastRunAt?: number
  lastFiredAt?: string
  nextRunAt?: number
  permissionMode?: ScheduledTaskPermissionMode
  folderPath?: string
  notification?: TaskNotificationConfig
}

export type CreateTaskInput = {
  name: string
  description?: string
  cron: string
  prompt: string
  enabled?: boolean
  recurring?: boolean
  permanent?: boolean
  permissionMode?: ScheduledTaskPermissionMode
  folderPath?: string
  notification?: TaskNotificationConfig
}

export type TaskRun = {
  id: string
  taskId: string
  taskName: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed' | 'timeout'
  prompt: string
  output?: string
  error?: string
  exitCode?: number
  durationMs?: number
}
