import { useEffect, useMemo } from 'react'
import { useMediaWorkbenchStore } from '../stores/mediaWorkbenchStore'
import { useProductTaskStore } from '../product/stores/productTaskStore'
import { useProductTaskRuntimeStore } from '../product/stores/productTaskRuntimeStore'

function activeMediaProjectIds(
  projects: Array<{ id: string; task_id?: string; preview_task_id?: string }>,
  tasks: Record<string, { status: string } | undefined>,
): string[] {
  return projects
    .filter(project => [project.task_id, project.preview_task_id].some(taskId => {
      const status = taskId ? tasks[taskId]?.status : undefined
      return status === 'queued' || status === 'running' || status === 'committing'
    }))
    .map(project => project.id)
}

/**
 * The shell observes background work after its page has been closed. It owns
 * only socket/event lifetimes; ProductTask and media services remain the
 * durable authorities for every task and project state.
 */
export function useDesktopProjectRuntime(): void {
  const productTasks = useProductTaskStore(state => state.index.tasks)
  const refreshProductTasks = useProductTaskStore(state => state.refresh)
  const connectTask = useProductTaskRuntimeStore(state => state.connectTask)
  const disconnectTask = useProductTaskRuntimeStore(state => state.disconnectTask)
  const imageProjects = useMediaWorkbenchStore(state => state.imageProjects)
  const videoProjects = useMediaWorkbenchStore(state => state.videoProjects)
  const mediaTasks = useMediaWorkbenchStore(state => state.tasks)
  const loadProjects = useMediaWorkbenchStore(state => state.loadProjects)
  const loadDeletions = useMediaWorkbenchStore(state => state.loadDeletions)
  const subscribeProjectEvents = useMediaWorkbenchStore(state => state.subscribeProjectEvents)

  const activeProductTaskIds = useMemo(
    () => productTasks.filter(task => task.lifecycle !== 'archived').map(task => task.id),
    [productTasks],
  )
  const activeImageIds = useMemo(
    () => activeMediaProjectIds(imageProjects, mediaTasks),
    [imageProjects, mediaTasks],
  )
  const activeVideoIds = useMemo(
    () => activeMediaProjectIds(videoProjects, mediaTasks),
    [videoProjects, mediaTasks],
  )

  useEffect(() => {
    void refreshProductTasks()
    void loadProjects('image', true)
    void loadProjects('video', true)
    void loadDeletions()
  }, [loadDeletions, loadProjects, refreshProductTasks])

  useEffect(() => {
    for (const taskId of activeProductTaskIds) void connectTask(taskId)
    return () => {
      for (const taskId of activeProductTaskIds) disconnectTask(taskId)
    }
  }, [activeProductTaskIds, connectTask, disconnectTask])

  useEffect(() => {
    const imageUnsubscribers = activeImageIds.map(projectId => subscribeProjectEvents(projectId, 'image'))
    const videoUnsubscribers = activeVideoIds.map(projectId => subscribeProjectEvents(projectId, 'video'))
    return () => {
      for (const unsubscribe of [...imageUnsubscribers, ...videoUnsubscribers]) unsubscribe()
    }
  }, [activeImageIds, activeVideoIds, subscribeProjectEvents])
}
