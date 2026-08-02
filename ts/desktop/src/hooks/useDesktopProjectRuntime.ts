import { useEffect, useMemo } from 'react'
import { useVideoWorkbenchStore } from '../stores/videoWorkbenchStore'
import { useImageWorkbenchStore } from '../stores/imageWorkbenchStore'

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
 * The shell observes media work after its page has been closed. Agent Threads
 * are owned and recovered by Rust App Server directly; this hook must never
 * reconnect the retired ProductTask runtime or recreate its execution state.
 */
export function useDesktopProjectRuntime(): void {
  const imageProjects = useImageWorkbenchStore(state => state.projects)
  const videoProjects = useVideoWorkbenchStore(state => state.videoProjects)
  const imageTasks = useImageWorkbenchStore(state => state.operations)
  const videoTasks = useVideoWorkbenchStore(state => state.tasks)
  const loadImageProjects = useImageWorkbenchStore(state => state.loadProjects)
  const loadVideoProjects = useVideoWorkbenchStore(state => state.loadProjects)
  const loadImageDeletions = useImageWorkbenchStore(state => state.loadDeletions)
  const loadVideoDeletions = useVideoWorkbenchStore(state => state.loadDeletions)
  const subscribeImageProjectEvents = useImageWorkbenchStore(state => state.subscribeProjectEvents)
  const subscribeVideoProjectEvents = useVideoWorkbenchStore(state => state.subscribeProjectEvents)

  const activeImageIds = useMemo(
    () => activeMediaProjectIds(imageProjects, imageTasks),
    [imageProjects, imageTasks],
  )
  const activeVideoIds = useMemo(
    () => activeMediaProjectIds(videoProjects, videoTasks),
    [videoProjects, videoTasks],
  )

  useEffect(() => {
    void loadImageProjects(true)
    void loadVideoProjects(true)
    void loadImageDeletions()
    void loadVideoDeletions()
  }, [loadImageDeletions, loadImageProjects, loadVideoDeletions, loadVideoProjects])

  useEffect(() => {
    const imageUnsubscribers = activeImageIds.map(projectId => subscribeImageProjectEvents(projectId))
    const videoUnsubscribers = activeVideoIds.map(projectId => subscribeVideoProjectEvents(projectId))
    return () => {
      for (const unsubscribe of [...imageUnsubscribers, ...videoUnsubscribers]) unsubscribe()
    }
  }, [activeImageIds, activeVideoIds, subscribeImageProjectEvents, subscribeVideoProjectEvents])
}
