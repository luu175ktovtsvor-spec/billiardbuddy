import { create, type StateCreator } from 'zustand'
import {
  mediaApi,
  type CreateVideoProjectInput,
  type MediaDeletionReceipt,
  type MediaTask,
  type MediaToolchainStatus,
  type VideoStudioProject,
  mediaUserFacingError,
} from '../api/media'

type MediaWorkbenchStore = {
  videoProjects: VideoStudioProject[]
  deletions: MediaDeletionReceipt[]
  tasks: Record<string, MediaTask | undefined>
  eventCursors: Record<string, number | undefined>
  toolchain: MediaToolchainStatus | null
  activeVideoId: string | null
  loading: boolean
  error: string | null
  loadProjects: (quiet?: boolean) => Promise<void>
  loadDeletions: () => Promise<void>
  loadToolchain: () => Promise<void>
  selectVideo: (id: string | null) => void
  createVideo: (input?: CreateVideoProjectInput) => Promise<VideoStudioProject>
  addVideoSource: (projectId: string, path: string) => Promise<VideoStudioProject>
  saveTimeline: (project: VideoStudioProject) => Promise<VideoStudioProject>
  selectVideoTimelineVersion: (projectId: string, revision: number, versionId: string) => Promise<VideoStudioProject>
  analyzeVideo: (project: VideoStudioProject, userGoal: string) => Promise<MediaTask>
  lockVideoScene: (project: VideoStudioProject, sceneId: string, locked: boolean) => Promise<VideoStudioProject>
  applyVideoAlternative: (project: VideoStudioProject, alternativeId: string) => Promise<VideoStudioProject>
  previewVideo: (project: VideoStudioProject) => Promise<MediaTask>
  renderVideo: (project: VideoStudioProject, outputPath: string) => Promise<MediaTask>
  cancelTask: (taskId: string) => Promise<MediaTask>
  deleteProject: (projectId: string) => Promise<void>
  restoreProject: (projectId: string) => Promise<void>
  subscribeProjectEvents: (projectId: string) => () => void
  clearError: () => void
}

type MediaWorkbenchSet = Parameters<StateCreator<MediaWorkbenchStore>>[0]

function message(error: unknown): string {
  return mediaUserFacingError(error)
}

function rendererSafeError(error: unknown): Error {
  return new Error(message(error))
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex(candidate => candidate.id === item.id)
  if (index < 0) return [item, ...items]
  const next = [...items]
  next[index] = item
  return next
}

/**
 * A workbench can request the same persisted project list from its initial
 * mount, event reconciliation, and explicit refresh at nearly the same time. Keep the
 * newest response authoritative so an older snapshot cannot make a newly
 * created project disappear from the current editing surface.
 */
let projectLoadVersion = 0
let deletionLoadVersion = 0

const taskLoadVersion: Record<string, number> = {}

function nextProjectLoadVersion(): number {
  const version = projectLoadVersion + 1
  projectLoadVersion = version
  return version
}

function nextTaskLoadVersion(taskId: string): number {
  const version = (taskLoadVersion[taskId] ?? 0) + 1
  taskLoadVersion[taskId] = version
  return version
}

let nextLoadingOperation = 0
const pendingLoadingOperations = new Set<number>()

type ActiveMediaEventSubscription = {
  controller: AbortController
  references: number
}

const activeMediaEventSubscriptions = new Map<string, ActiveMediaEventSubscription>()

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function waitForReconnect(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timeoutSignal = AbortSignal.timeout(milliseconds)
    const finish = () => {
      timeoutSignal.removeEventListener('abort', finish)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timeoutSignal.addEventListener('abort', finish, { once: true })
    signal.addEventListener('abort', finish, { once: true })
  })
}

function beginLoading(set: MediaWorkbenchSet): () => void {
  const operation = ++nextLoadingOperation
  pendingLoadingOperations.add(operation)
  set({ loading: true, error: null })
  return () => {
    pendingLoadingOperations.delete(operation)
    set({ loading: pendingLoadingOperations.size > 0 })
  }
}

async function loadProjectTasks(
  projects: Array<{ task_id?: string; preview_task_id?: string }>,
): Promise<Record<string, MediaTask | undefined>> {
  const taskIds = [...new Set(projects.flatMap(project => [
    ...(project.task_id ? [project.task_id] : []),
    ...(project.preview_task_id ? [project.preview_task_id] : []),
  ]))]
  const entries = await Promise.all(taskIds.map(async taskId => {
    const version = nextTaskLoadVersion(taskId)
    const result = await mediaApi.getTask(taskId).catch(() => null)
    return result?.task && taskLoadVersion[taskId] === version
      ? [taskId, result.task] as const
      : null
  }))
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, MediaTask] => entry !== null))
}

export const useMediaWorkbenchStore = create<MediaWorkbenchStore>((set, get) => ({
  videoProjects: [],
  deletions: [],
  tasks: {},
  eventCursors: {},
  toolchain: null,
  activeVideoId: null,
  loading: false,
  error: null,

  loadProjects: async (quiet = false) => {
    const version = nextProjectLoadVersion()
    const finishLoading = quiet ? () => undefined : beginLoading(set)
    try {
      const { projects } = await mediaApi.listProjects('video')
      if (projectLoadVersion !== version) return
      const projectTasks = await loadProjectTasks(projects)
      if (projectLoadVersion !== version) return
      const videoProjects = projects.filter((project): project is VideoStudioProject => project.kind === 'video')
      set(state => ({
        videoProjects,
        tasks: { ...state.tasks, ...projectTasks },
        activeVideoId: state.activeVideoId && videoProjects.some(project => project.id === state.activeVideoId)
          ? state.activeVideoId
          : videoProjects[0]?.id ?? null,
      }))
    } catch (error) {
      if (projectLoadVersion !== version) return
      set({ error: message(error) })
    } finally {
      finishLoading()
    }
  },

  loadDeletions: async () => {
    const version = ++deletionLoadVersion
    const finishLoading = beginLoading(set)
    try {
      const { deletions } = await mediaApi.listDeletions()
      if (deletionLoadVersion !== version) return
      set({ deletions: deletions.filter(deletion => deletion.project_kind !== 'image' && ['pending', 'deleted', 'restoring'].includes(deletion.status)) })
    } catch (error) {
      if (deletionLoadVersion !== version) return
      set({ error: message(error) })
    } finally {
      finishLoading()
    }
  },

  loadToolchain: async () => {
    try {
      set({ toolchain: await mediaApi.getToolchain() })
    } catch (error) {
      set({ error: message(error) })
    }
  },

  selectVideo: activeVideoId => set({ activeVideoId }),

  createVideo: async input => {
    const finishLoading = beginLoading(set)
    try {
      const { project } = await mediaApi.createVideoProject(input ?? {})
      nextProjectLoadVersion()
      set(state => ({ videoProjects: upsert(state.videoProjects, project), activeVideoId: project.id }))
      return project
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  addVideoSource: async (projectId, path) => {
    const finishLoading = beginLoading(set)
    try {
      const { project, task } = await mediaApi.addVideoSource(projectId, path)
      nextProjectLoadVersion()
      nextTaskLoadVersion(task.id)
      set(state => ({
        videoProjects: upsert(state.videoProjects, project),
        tasks: { ...state.tasks, [task.id]: task },
      }))
      return project
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  saveTimeline: async project => {
    const finishLoading = beginLoading(set)
    try {
      const { project: saved } = await mediaApi.updateVideoTimeline(project.id, {
        base_revision: project.revision,
        base_timeline_version_id: project.current_timeline_version_id!,
        clips: project.timeline,
      })
      nextProjectLoadVersion()
      set(state => ({ videoProjects: upsert(state.videoProjects, saved) }))
      return saved
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  selectVideoTimelineVersion: async (projectId, revision, versionId) => {
    const finishLoading = beginLoading(set)
    try {
      const { project } = await mediaApi.selectVideoTimelineVersion(projectId, {
        revision,
        version_id: versionId,
      })
      nextProjectLoadVersion()
      set(state => ({ videoProjects: upsert(state.videoProjects, project) }))
      return project
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  analyzeVideo: async (project, userGoal) => {
    const finishLoading = beginLoading(set)
    try {
      const { task } = await mediaApi.analyzeVideo(project.id, {
        base_revision: project.revision,
        user_goal: userGoal,
      })
      nextTaskLoadVersion(task.id)
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      await get().loadProjects()
      return task
    } catch (error) {
      const safeError = rendererSafeError(error)
      await get().loadProjects()
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  lockVideoScene: async (project, sceneId, locked) => {
    const finishLoading = beginLoading(set)
    try {
      const { project: saved } = await mediaApi.lockVideoScene(project.id, sceneId, {
        base_revision: project.revision,
        timeline_version_id: project.current_timeline_version_id!,
        locked,
      })
      nextProjectLoadVersion()
      set(state => ({ videoProjects: upsert(state.videoProjects, saved) }))
      return saved
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  applyVideoAlternative: async (project, alternativeId) => {
    const finishLoading = beginLoading(set)
    try {
      const { project: saved } = await mediaApi.applyVideoAlternative(project.id, alternativeId, {
        base_revision: project.revision,
        alternative_id: alternativeId,
      })
      nextProjectLoadVersion()
      set(state => ({ videoProjects: upsert(state.videoProjects, saved) }))
      return saved
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  previewVideo: async project => {
    const finishLoading = beginLoading(set)
    try {
      const { task } = await mediaApi.previewVideo(project.id, {
        base_revision: project.revision,
        timeline_version_id: project.current_timeline_version_id!,
      })
      nextTaskLoadVersion(task.id)
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      await get().loadProjects()
      return task
    } catch (error) {
      const safeError = rendererSafeError(error)
      await get().loadProjects()
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  renderVideo: async (project, outputPath) => {
    const finishLoading = beginLoading(set)
    try {
      const { task } = await mediaApi.renderVideo(project.id, {
        base_revision: project.revision,
        timeline_version_id: project.current_timeline_version_id!,
        output_path: outputPath,
      })
      nextTaskLoadVersion(task.id)
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      await get().loadProjects()
      return task
    } catch (error) {
      const safeError = rendererSafeError(error)
      await get().loadProjects()
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  cancelTask: async taskId => {
    const finishLoading = beginLoading(set)
    try {
      const { task } = await mediaApi.cancelTask(taskId)
      nextTaskLoadVersion(task.id)
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      await get().loadProjects()
      return task
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  deleteProject: async projectId => {
    const finishLoading = beginLoading(set)
    try {
      await mediaApi.deleteProject(projectId)
      nextProjectLoadVersion()
      set(state => {
        const videoProjects = state.videoProjects.filter(project => project.id !== projectId)
        return {
          videoProjects,
          eventCursors: { ...state.eventCursors, [projectId]: undefined },
          activeVideoId: state.activeVideoId === projectId
            ? videoProjects[0]?.id ?? null
            : state.activeVideoId,
        }
      })
      await get().loadDeletions()
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  restoreProject: async projectId => {
    const finishLoading = beginLoading(set)
    try {
      await mediaApi.restoreProject(projectId)
      const { project } = await mediaApi.getProject(projectId)
      if (project.kind !== 'video') throw new Error('视频项目不存在')
      await Promise.all([
        get().loadProjects(true),
        get().loadDeletions(),
      ])
      set({ activeVideoId: project.id })
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  subscribeProjectEvents: projectId => {
    const existing = activeMediaEventSubscriptions.get(projectId)
    if (existing) {
      existing.references += 1
      return () => {
        existing.references -= 1
        if (existing.references === 0) {
          existing.controller.abort()
          activeMediaEventSubscriptions.delete(projectId)
        }
      }
    }

    const controller = new AbortController()
    const subscription = { controller, references: 1 }
    activeMediaEventSubscriptions.set(projectId, subscription)
    void (async () => {
      let reconnectDelay = 250
      let reconcileAfterReconnect = false
      while (!controller.signal.aborted) {
        const cursor = get().eventCursors[projectId] ?? 0
        try {
          const page = await mediaApi.waitForProjectEvents(projectId, cursor, controller.signal)
          if (controller.signal.aborted) break
          reconnectDelay = 250
          let acceptedEvent = false
          set(state => {
            let nextCursor = state.eventCursors[projectId] ?? 0
            const tasks = { ...state.tasks }
            for (const event of [...page.events].sort((left, right) => left.cursor - right.cursor)) {
              if (event.project_id !== projectId || event.cursor <= nextCursor) continue
              nextCursor = event.cursor
              const current = tasks[event.task.id]
              if (!current || event.status_sequence >= (current.status_sequence ?? 0)) {
                nextTaskLoadVersion(event.task.id)
                tasks[event.task.id] = event.task
                acceptedEvent = true
              }
            }
            return {
              tasks,
              eventCursors: {
                ...state.eventCursors,
                [projectId]: Math.max(nextCursor, page.cursor),
              },
            }
          })
          if (acceptedEvent || page.reset_required || reconcileAfterReconnect) {
            await get().loadProjects(true)
            reconcileAfterReconnect = false
          }
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) break
          set({ error: message(error) })
          reconcileAfterReconnect = true
          await waitForReconnect(controller.signal, reconnectDelay)
          reconnectDelay = Math.min(5_000, reconnectDelay * 2)
        }
      }
    })().finally(() => {
      if (activeMediaEventSubscriptions.get(projectId) === subscription) {
        activeMediaEventSubscriptions.delete(projectId)
      }
    })

    return () => {
      subscription.references -= 1
      if (subscription.references === 0) {
        controller.abort()
        activeMediaEventSubscriptions.delete(projectId)
      }
    }
  },

  clearError: () => set({ error: null }),
}))
