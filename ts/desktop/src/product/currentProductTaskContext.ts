import { useTabStore, type Tab } from '../stores/tabStore'
import { useProductTaskStore } from './stores/productTaskStore'
import type { ProductTaskRecord } from './domain/types'

export type CurrentProductTaskContext = {
  taskId?: string
  workDir?: string
}

function normalizedTaskId(value: string | null | undefined): string | undefined {
  const taskId = value?.trim()
  return taskId || undefined
}

/**
 * Settings can be the active surface while a task remains open beside it.
 * Prefer the active product task; otherwise use the explicit last product
 * task selected by tab navigation. Legacy Core tabs are never read and tab
 * array order never decides the public task context.
 */
export function resolveCurrentProductTaskId(
  tabs: readonly Tab[],
  activeTabId: string | null,
  lastActiveProductTaskId?: string | null,
): string | undefined {
  const activeTab = activeTabId
    ? tabs.find((tab) => tab.sessionId === activeTabId)
    : undefined
  if (activeTab?.type === 'product-task') {
    return normalizedTaskId(activeTab.taskId)
  }

  const lastTaskId = normalizedTaskId(lastActiveProductTaskId)
  if (!lastTaskId) return undefined
  return tabs.some(
    (tab) => tab.type === 'product-task' && normalizedTaskId(tab.taskId) === lastTaskId,
  )
    ? lastTaskId
    : undefined
}

export function resolveCurrentProductTaskContext(
  tabs: readonly Tab[],
  activeTabId: string | null,
  tasks: readonly ProductTaskRecord[],
  lastActiveProductTaskId?: string | null,
): CurrentProductTaskContext {
  const taskId = resolveCurrentProductTaskId(tabs, activeTabId, lastActiveProductTaskId)
  if (!taskId) return {}

  const workDir = tasks.find((task) => task.id === taskId)?.workDir.trim()
  return {
    taskId,
    ...(workDir ? { workDir } : {}),
  }
}

/**
 * Product renderer context for settings and capability surfaces. The task id
 * is opaque and may be sent to a product-aware server endpoint; it is never
 * a Core session id.
 */
export function useCurrentProductTaskContext(): CurrentProductTaskContext {
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const lastActiveProductTaskId = useTabStore((state) => state.lastActiveProductTaskId)
  const tasks = useProductTaskStore((state) => state.index.tasks)
  return resolveCurrentProductTaskContext(tabs, activeTabId, tasks, lastActiveProductTaskId)
}
