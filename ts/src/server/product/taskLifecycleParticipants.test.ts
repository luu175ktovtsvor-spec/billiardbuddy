import { expect, test } from 'bun:test'
import { createRuntimeTaskLifecycleParticipants } from './taskLifecycleParticipants.js'

test('runtime lifecycle consumers block live work and purge every task-owned external record', async () => {
  const schedules = [
    { id: 'enabled', context: { mode: 'related_task' as const, taskId: 'task' }, enabled: true },
    { id: 'disabled', context: { mode: 'related_task' as const, taskId: 'task' }, enabled: false },
    { id: 'independent', context: { mode: 'independent' as const }, enabled: true },
  ]
  const deletedSchedules: string[] = []
  let recruitingState = 'awaiting_confirmation'
  const purgedRecruiting: string[] = []
  const resourceBlockers = new Set(['task:task'])
  const purgedOwners: string[] = []
  const purgedJournals: string[] = []
  const purgedScheduledRuns: Array<{ taskId: string; scheduleIds: readonly string[] }> = []
  const participants = createRuntimeTaskLifecycleParticipants({
    schedules: {
      listTasks: async () => schedules as any,
      deleteTask: async id => { deletedSchedules.push(id) },
    },
    recruiting: () => ({
      listActions: async taskId => [{ id: 'action', task_id: taskId, state: recruitingState } as any],
      purgeTaskActions: async taskId => { purgedRecruiting.push(taskId) },
    }),
    resources: () => ({
      hasBlockingOwnerJobs: async ownerId => resourceBlockers.has(ownerId),
      purgeOwnerJobs: async ownerId => { purgedOwners.push(ownerId) },
    }),
    operationJournal: {
      purgeTaskRecords: async taskId => { purgedJournals.push(taskId); return 1 },
    },
    scheduledRuns: {
      purgeTaskRuns: async (taskId, scheduleIds) => { purgedScheduledRuns.push({ taskId, scheduleIds }); return 2 },
    },
  })
  const schedule = participants.find(item => item.id === 'related_scheduled_tasks')!
  const recruiting = participants.find(item => item.id === 'recruiting_actions')!
  const resources = participants.find(item => item.id === 'desktop_resource_jobs')!
  const operationJournal = participants.find(item => item.id === 'core_operation_journal')!

  expect(await schedule.inspectBlockers('task', 0)).toEqual([{ participant: 'related_scheduled_tasks', code: 'SCHEDULE', action: 'disable' }])
  schedules[0]!.enabled = false
  expect(await schedule.inspectBlockers('task', 0)).toEqual([])
  await schedule.purgeCleanup!('task', 0, 'fence')
  expect(deletedSchedules).toEqual(['enabled', 'disabled'])
  expect(purgedScheduledRuns).toEqual([{ taskId: 'task', scheduleIds: ['enabled', 'disabled'] }])

  expect(await recruiting.inspectBlockers('task', 0)).toEqual([{ participant: 'recruiting_actions', code: 'RECRUITING', action: 'resolve' }])
  recruitingState = 'succeeded'
  expect(await recruiting.inspectBlockers('task', 0)).toEqual([])
  await recruiting.purgeCleanup!('task', 0, 'fence')
  expect(purgedRecruiting).toEqual(['task'])

  expect(await resources.inspectBlockers('task', 0)).toEqual([{ participant: 'desktop_resource_jobs', code: 'QUEUE', action: 'resolve' }])
  resourceBlockers.clear()
  expect(await resources.inspectBlockers('task', 0)).toEqual([])
  await resources.purgeCleanup!('task', 0, 'fence')
  expect(purgedOwners).toEqual(['task', 'task:task'])

  expect(await operationJournal.inspectBlockers('task', 0)).toEqual([])
  await operationJournal.purgeCleanup!('task', 0, 'fence')
  expect(purgedJournals).toEqual(['task'])
})
