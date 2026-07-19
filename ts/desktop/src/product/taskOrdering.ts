import type { ProductProject, ProductTaskRecord } from './domain/types'

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function compareProductTasks(left: ProductTaskRecord, right: ProductTaskRecord): number {
  if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) {
    return left.pinnedAt ? -1 : 1
  }

  return timestamp(right.updatedAt) - timestamp(left.updatedAt)
}

export function orderProductTasks<T extends ProductTaskRecord>(tasks: readonly T[]): T[] {
  return [...tasks].sort(compareProductTasks)
}

type ProjectOrderStats = {
  hasActivePinnedTask: boolean
  latestTaskUpdatedAt: number
}

function getProjectOrderStats(tasks: readonly ProductTaskRecord[]): Map<string, ProjectOrderStats> {
  const stats = new Map<string, ProjectOrderStats>()
  for (const task of tasks) {
    const current = stats.get(task.projectId) ?? {
      hasActivePinnedTask: false,
      latestTaskUpdatedAt: 0,
    }
    current.hasActivePinnedTask ||= task.lifecycle === 'active' && Boolean(task.pinnedAt)
    current.latestTaskUpdatedAt = Math.max(current.latestTaskUpdatedAt, timestamp(task.updatedAt))
    stats.set(task.projectId, current)
  }
  return stats
}

export function orderProductProjects<T extends ProductProject>(
  projects: readonly T[],
  tasks: readonly ProductTaskRecord[],
): T[] {
  const stats = getProjectOrderStats(tasks)
  return [...projects].sort((left, right) => {
    const leftStats = stats.get(left.id)
    const rightStats = stats.get(right.id)
    if (Boolean(leftStats?.hasActivePinnedTask) !== Boolean(rightStats?.hasActivePinnedTask)) {
      return leftStats?.hasActivePinnedTask ? -1 : 1
    }

    const leftUpdatedAt = leftStats?.latestTaskUpdatedAt ?? timestamp(left.updatedAt)
    const rightUpdatedAt = rightStats?.latestTaskUpdatedAt ?? timestamp(right.updatedAt)
    return rightUpdatedAt - leftUpdatedAt || left.id.localeCompare(right.id)
  })
}
