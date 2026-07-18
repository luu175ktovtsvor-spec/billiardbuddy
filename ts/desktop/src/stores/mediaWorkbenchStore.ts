import { create } from 'zustand'
import {
  mediaApi,
  type CreateImageProjectInput,
  type CreateVideoProjectInput,
  type ImageWorkbenchProject,
  type MediaTask,
  type MediaToolchainStatus,
  type VideoStudioProject,
} from '../api/media'

type MediaWorkbenchStore = {
  imageProjects: ImageWorkbenchProject[]
  videoProjects: VideoStudioProject[]
  tasks: Record<string, MediaTask | undefined>
  toolchain: MediaToolchainStatus | null
  activeImageId: string | null
  activeVideoId: string | null
  loading: boolean
  error: string | null
  loadProjects: (kind: 'image' | 'video') => Promise<void>
  loadToolchain: () => Promise<void>
  selectImage: (id: string | null) => void
  selectVideo: (id: string | null) => void
  createImage: (input: CreateImageProjectInput) => Promise<ImageWorkbenchProject>
  saveImageDraft: (
    project: ImageWorkbenchProject,
    confirmUnknownRetry?: boolean,
  ) => Promise<ImageWorkbenchProject>
  submitImage: (projectId: string, confirmUnknownRetry?: boolean) => Promise<MediaTask>
  createVideo: (input?: CreateVideoProjectInput) => Promise<VideoStudioProject>
  addVideoSource: (projectId: string, path: string) => Promise<VideoStudioProject>
  saveTimeline: (project: VideoStudioProject) => Promise<VideoStudioProject>
  renderVideo: (project: VideoStudioProject, outputPath: string) => Promise<MediaTask>
  cancelTask: (taskId: string) => Promise<MediaTask>
  deleteProject: (projectId: string, kind: 'image' | 'video') => Promise<void>
  refreshTask: (taskId: string) => Promise<MediaTask>
  clearError: () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex(candidate => candidate.id === item.id)
  if (index < 0) return [item, ...items]
  const next = [...items]
  next[index] = item
  return next
}

async function loadProjectTasks(
  projects: Array<{ task_id?: string }>,
): Promise<Record<string, MediaTask | undefined>> {
  const taskIds = [...new Set(projects.flatMap(project => project.task_id ? [project.task_id] : []))]
  const entries = await Promise.all(taskIds.map(async taskId => {
    const result = await mediaApi.getTask(taskId).catch(() => null)
    return result?.task ? [taskId, result.task] as const : null
  }))
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, MediaTask] => entry !== null))
}

export const useMediaWorkbenchStore = create<MediaWorkbenchStore>((set, get) => ({
  imageProjects: [],
  videoProjects: [],
  tasks: {},
  toolchain: null,
  activeImageId: null,
  activeVideoId: null,
  loading: false,
  error: null,

  loadProjects: async kind => {
    set({ loading: true, error: null })
    try {
      const { projects } = await mediaApi.listProjects(kind)
      const projectTasks = await loadProjectTasks(projects)
      if (kind === 'image') {
        const imageProjects = projects.filter((project): project is ImageWorkbenchProject => project.kind === 'image')
        set(state => ({
          imageProjects,
          tasks: { ...state.tasks, ...projectTasks },
          activeImageId: state.activeImageId && imageProjects.some(project => project.id === state.activeImageId)
            ? state.activeImageId
            : imageProjects[0]?.id ?? null,
        }))
      } else {
        const videoProjects = projects.filter((project): project is VideoStudioProject => project.kind === 'video')
        set(state => ({
          videoProjects,
          tasks: { ...state.tasks, ...projectTasks },
          activeVideoId: state.activeVideoId && videoProjects.some(project => project.id === state.activeVideoId)
            ? state.activeVideoId
            : videoProjects[0]?.id ?? null,
        }))
      }
    } catch (error) {
      set({ error: message(error) })
    } finally {
      set({ loading: false })
    }
  },

  loadToolchain: async () => {
    try {
      set({ toolchain: await mediaApi.getToolchain() })
    } catch (error) {
      set({ error: message(error) })
    }
  },

  selectImage: activeImageId => set({ activeImageId }),
  selectVideo: activeVideoId => set({ activeVideoId }),

  createImage: async input => {
    set({ loading: true, error: null })
    try {
      const { project } = await mediaApi.createImageProject(input)
      set(state => ({ imageProjects: upsert(state.imageProjects, project), activeImageId: project.id }))
      return project
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  submitImage: async (projectId, confirmUnknownRetry = false) => {
    set({ loading: true, error: null })
    try {
      const { task } = await mediaApi.submitImageProject(projectId, confirmUnknownRetry)
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      await get().loadProjects('image')
      return task
    } catch (error) {
      const detail = message(error)
      await get().loadProjects('image')
      set({ error: detail })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  saveImageDraft: async (project, confirmUnknownRetry = false) => {
    set({ loading: true, error: null })
    try {
      const { project: saved } = await mediaApi.updateImageProject(project.id, {
        revision: project.revision,
        prompt: project.prompt,
        size: project.size,
        count: project.count,
        confirm_unknown_retry: confirmUnknownRetry,
      })
      set(state => ({ imageProjects: upsert(state.imageProjects, saved) }))
      return saved
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  createVideo: async input => {
    set({ loading: true, error: null })
    try {
      const { project } = await mediaApi.createVideoProject(input ?? {})
      set(state => ({ videoProjects: upsert(state.videoProjects, project), activeVideoId: project.id }))
      return project
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  addVideoSource: async (projectId, path) => {
    set({ loading: true, error: null })
    try {
      const { project, task } = await mediaApi.addVideoSource(projectId, path)
      set(state => ({
        videoProjects: upsert(state.videoProjects, project),
        tasks: { ...state.tasks, [task.id]: task },
      }))
      return project
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  saveTimeline: async project => {
    set({ loading: true, error: null })
    try {
      const { project: saved } = await mediaApi.updateVideoTimeline(project.id, {
        revision: project.revision,
        clips: project.timeline,
      })
      set(state => ({ videoProjects: upsert(state.videoProjects, saved) }))
      return saved
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  renderVideo: async (project, outputPath) => {
    set({ loading: true, error: null })
    try {
      const { task } = await mediaApi.renderVideo(project.id, {
        revision: project.revision,
        output_path: outputPath,
      })
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      await get().loadProjects('video')
      return task
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  cancelTask: async taskId => {
    set({ loading: true, error: null })
    try {
      const { task } = await mediaApi.cancelTask(taskId)
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      await get().loadProjects(task.kind === 'image.generate' ? 'image' : 'video')
      return task
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  deleteProject: async (projectId, kind) => {
    set({ loading: true, error: null })
    try {
      await mediaApi.deleteProject(projectId)
      if (kind === 'image') {
        set(state => {
          const imageProjects = state.imageProjects.filter(project => project.id !== projectId)
          return {
            imageProjects,
            activeImageId: state.activeImageId === projectId
              ? imageProjects[0]?.id ?? null
              : state.activeImageId,
          }
        })
      } else {
        set(state => {
          const videoProjects = state.videoProjects.filter(project => project.id !== projectId)
          return {
            videoProjects,
            activeVideoId: state.activeVideoId === projectId
              ? videoProjects[0]?.id ?? null
              : state.activeVideoId,
          }
        })
      }
    } catch (error) {
      set({ error: message(error) })
      throw error
    } finally {
      set({ loading: false })
    }
  },

  refreshTask: async taskId => {
    try {
      const { task } = await mediaApi.getTask(taskId)
      set(state => ({ tasks: { ...state.tasks, [task.id]: task } }))
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
        await get().loadProjects(task.kind === 'image.generate' ? 'image' : 'video')
      }
      return task
    } catch (error) {
      set({ error: message(error) })
      throw error
    }
  },

  clearError: () => set({ error: null }),
}))
