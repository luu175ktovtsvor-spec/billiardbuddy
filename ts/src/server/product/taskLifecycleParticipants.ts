import type { PublicRecruitingAction } from '../../../shared/product/browserCapability.js'
import type { CronTask } from '../services/cronService.js'
import type { TaskLifecycleParticipant } from './taskService.js'

type RelatedSchedules = {
  listTasks(): Promise<CronTask[]>
  deleteTask(id: string): Promise<void>
}

type RecruitingActions = {
  listActions(taskId: string): Promise<PublicRecruitingAction[]>
  purgeTaskActions(taskId: string): Promise<void>
}

type ResourceJobs = {
  hasBlockingOwnerJobs(ownerId: string): Promise<boolean>
  purgeOwnerJobs(ownerId: string): Promise<void>
}

type CoreOperationJournal = {
  purgeTaskRecords(taskId: string): Promise<number>
}

type ScheduledRunHistory = {
  purgeTaskRuns(productTaskId: string, scheduleIds: readonly string[]): Promise<number>
}

const terminalRecruitingStates = new Set(['succeeded', 'failed', 'outcome_unknown', 'rejected', 'expired'])

export function createRuntimeTaskLifecycleParticipants(dependencies: {
  schedules: RelatedSchedules
  recruiting: () => RecruitingActions | undefined
  resources: () => ResourceJobs | undefined
  operationJournal: CoreOperationJournal
  scheduledRuns: ScheduledRunHistory
}): TaskLifecycleParticipant[] {
  return [
    {
      id: 'related_scheduled_tasks',
      inspectBlockers: async taskId => (await dependencies.schedules.listTasks()).some(task => task.context?.mode === 'related_task' && task.context.taskId === taskId && task.enabled !== false)
        ? [{ participant: 'related_scheduled_tasks', code: 'SCHEDULE', action: 'disable' }]
        : [],
      purgeCleanup: async taskId => {
        const related = (await dependencies.schedules.listTasks()).filter(task => task.context?.mode === 'related_task' && task.context.taskId === taskId)
        await dependencies.scheduledRuns.purgeTaskRuns(taskId, related.map(task => task.id))
        for (const task of related) await dependencies.schedules.deleteTask(task.id)
      },
    },
    {
      id: 'recruiting_actions',
      inspectBlockers: async taskId => {
        const recruiting = dependencies.recruiting()
        if (!recruiting) throw new Error('BROWSER_BRIDGE_UNAVAILABLE')
        return (await recruiting.listActions(taskId)).some(action => !terminalRecruitingStates.has(action.state))
          ? [{ participant: 'recruiting_actions', code: 'RECRUITING', action: 'resolve' }]
          : []
      },
      purgeCleanup: async taskId => {
        const recruiting = dependencies.recruiting()
        if (!recruiting) throw new Error('BROWSER_BRIDGE_UNAVAILABLE')
        await recruiting.purgeTaskActions(taskId)
      },
    },
    {
      id: 'desktop_resource_jobs',
      inspectBlockers: async taskId => {
        const resources = dependencies.resources()
        if (!resources) throw new Error('RESOURCE_SCHEDULER_UNAVAILABLE')
        const blocked = await Promise.all([
          resources.hasBlockingOwnerJobs(taskId),
          resources.hasBlockingOwnerJobs(`task:${taskId}`),
        ])
        return blocked.some(Boolean)
          ? [{ participant: 'desktop_resource_jobs', code: 'QUEUE', action: 'resolve' }]
          : []
      },
      purgeCleanup: async taskId => {
        const resources = dependencies.resources()
        if (!resources) throw new Error('RESOURCE_SCHEDULER_UNAVAILABLE')
        await resources.purgeOwnerJobs(taskId)
        await resources.purgeOwnerJobs(`task:${taskId}`)
      },
    },
    {
      id: 'core_operation_journal',
      inspectBlockers: async () => [],
      purgeCleanup: async taskId => { await dependencies.operationJournal.purgeTaskRecords(taskId) },
    },
  ]
}
