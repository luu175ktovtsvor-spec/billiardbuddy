import { create } from 'zustand'
import {
  imageUserFacingError,
  imageWorkbenchApi,
  type CommitImageVersionInput,
  type CreateImageProjectInput,
  type ImageDeletionReceipt,
  type ImageOperation,
  type ImageReferenceRole,
  type ImageWorkbenchProject,
  type StartImageOperationInput,
} from '../api/imageWorkbench'

type ImageWorkbenchStore = {
  projects: ImageWorkbenchProject[]
  deletions: ImageDeletionReceipt[]
  operations: Record<string, ImageOperation | undefined>
  eventCursors: Record<string, number | undefined>
  activeProjectId: string | null
  loading: boolean
  error: string | null
  loadProjects: (quiet?: boolean) => Promise<void>
  loadDeletions: () => Promise<void>
  selectProject: (id: string | null) => void
  createProject: (input: CreateImageProjectInput) => Promise<ImageWorkbenchProject>
  saveDraft: (
    project: ImageWorkbenchProject,
    confirmUnknownRetry?: boolean,
    newReferences?: Array<{ dataUrl: string; role: ImageReferenceRole }>,
    startNewGenerationRound?: boolean,
  ) => Promise<ImageWorkbenchProject>
  addReferences: (
    projectId: string,
    revision: number,
    references: Array<{ dataUrl: string; role: ImageReferenceRole }>,
  ) => Promise<ImageWorkbenchProject>
  submitProject: (projectId: string, confirmUnknownRetry?: boolean) => Promise<ImageOperation>
  startOperation: (projectId: string, input: StartImageOperationInput) => Promise<ImageOperation>
  commitVersion: (projectId: string, input: CommitImageVersionInput) => Promise<ImageWorkbenchProject>
  selectVersion: (projectId: string, revision: number, versionId: string) => Promise<ImageWorkbenchProject>
  cancelOperation: (operationId: string) => Promise<ImageOperation>
  deleteProject: (projectId: string) => Promise<void>
  restoreProject: (projectId: string) => Promise<void>
  subscribeProjectEvents: (projectId: string) => () => void
  clearError: () => void
}

function message(error: unknown): string {
  return imageUserFacingError(error)
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

let projectLoadVersion = 0
let deletionLoadVersion = 0
let nextLoadingOperation = 0
const pendingLoadingOperations = new Set<number>()
const operationLoadVersion: Record<string, number> = {}

type ActiveImageEventSubscription = {
  controller: AbortController
  references: number
}

const activeImageEventSubscriptions = new Map<string, ActiveImageEventSubscription>()

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

function beginLoading(set: (state: Partial<ImageWorkbenchStore>) => void): () => void {
  const operation = ++nextLoadingOperation
  pendingLoadingOperations.add(operation)
  set({ loading: true, error: null })
  return () => {
    pendingLoadingOperations.delete(operation)
    set({ loading: pendingLoadingOperations.size > 0 })
  }
}

function nextOperationLoadVersion(operationId: string): number {
  const version = (operationLoadVersion[operationId] ?? 0) + 1
  operationLoadVersion[operationId] = version
  return version
}

async function loadProjectOperations(projects: readonly ImageWorkbenchProject[]): Promise<Record<string, ImageOperation | undefined>> {
  const operationIds = [...new Set(projects.flatMap(project => project.task_id ? [project.task_id] : []))]
  const entries = await Promise.all(operationIds.map(async operationId => {
    const version = nextOperationLoadVersion(operationId)
    const result = await imageWorkbenchApi.getOperation(operationId).catch(() => null)
    return result?.task && operationLoadVersion[operationId] === version
      ? [operationId, result.task] as const
      : null
  }))
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, ImageOperation] => entry !== null))
}

export const useImageWorkbenchStore = create<ImageWorkbenchStore>((set, get) => ({
  projects: [],
  deletions: [],
  operations: {},
  eventCursors: {},
  activeProjectId: null,
  loading: false,
  error: null,

  loadProjects: async (quiet = false) => {
    const version = ++projectLoadVersion
    const finishLoading = quiet ? () => undefined : beginLoading(set)
    try {
      const { projects } = await imageWorkbenchApi.listProjects()
      if (projectLoadVersion !== version) return
      const operations = await loadProjectOperations(projects)
      if (projectLoadVersion !== version) return
      set(state => ({
        projects,
        operations: { ...state.operations, ...operations },
        activeProjectId: state.activeProjectId && projects.some(project => project.id === state.activeProjectId)
          ? state.activeProjectId
          : projects[0]?.id ?? null,
      }))
    } catch (error) {
      if (projectLoadVersion === version) set({ error: message(error) })
    } finally {
      finishLoading()
    }
  },

  loadDeletions: async () => {
    const version = ++deletionLoadVersion
    const finishLoading = beginLoading(set)
    try {
      const { deletions } = await imageWorkbenchApi.listDeletions()
      if (deletionLoadVersion === version) {
        set({ deletions: deletions.filter(deletion => ['pending', 'deleted', 'restoring'].includes(deletion.status)) })
      }
    } catch (error) {
      if (deletionLoadVersion === version) set({ error: message(error) })
    } finally {
      finishLoading()
    }
  },

  selectProject: activeProjectId => set({ activeProjectId }),

  createProject: async input => {
    const finishLoading = beginLoading(set)
    try {
      const { project } = await imageWorkbenchApi.createProject(input)
      projectLoadVersion += 1
      set(state => ({ projects: upsert(state.projects, project), activeProjectId: project.id }))
      return project
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  saveDraft: async (project, confirmUnknownRetry = false, newReferences = [], startNewGenerationRound = false) => {
    const finishLoading = beginLoading(set)
    try {
      const { project: saved } = await imageWorkbenchApi.updateProject(project.id, {
        revision: project.revision,
        user_request: project.brief?.user_request ?? project.title,
        size: project.size,
        brief_overrides: project.brief_overrides,
        references: project.references,
        new_reference_images: newReferences.map(reference => reference.dataUrl),
        new_reference_roles: newReferences.map(reference => reference.role),
        start_new_generation_round: startNewGenerationRound,
        confirm_unknown_retry: confirmUnknownRetry,
      })
      projectLoadVersion += 1
      set(state => ({ projects: upsert(state.projects, saved) }))
      return saved
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  addReferences: async (projectId, revision, references) => {
    const finishLoading = beginLoading(set)
    try {
      const { project } = await imageWorkbenchApi.addReferences(projectId, {
        revision,
        reference_images: references.map(reference => reference.dataUrl),
        reference_roles: references.map(reference => reference.role),
      })
      projectLoadVersion += 1
      set(state => ({ projects: upsert(state.projects, project) }))
      return project
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  submitProject: async (projectId, confirmUnknownRetry = false) => {
    const finishLoading = beginLoading(set)
    try {
      const { task } = await imageWorkbenchApi.submitProject(projectId, confirmUnknownRetry)
      nextOperationLoadVersion(task.id)
      set(state => ({ operations: { ...state.operations, [task.id]: task } }))
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

  startOperation: async (projectId, input) => {
    const finishLoading = beginLoading(set)
    try {
      const { task } = await imageWorkbenchApi.startOperation(projectId, input)
      nextOperationLoadVersion(task.id)
      set(state => ({ operations: { ...state.operations, [task.id]: task } }))
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

  commitVersion: async (projectId, input) => {
    const finishLoading = beginLoading(set)
    try {
      const { project } = await imageWorkbenchApi.commitVersion(projectId, input)
      projectLoadVersion += 1
      set(state => ({ projects: upsert(state.projects, project) }))
      return project
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  selectVersion: async (projectId, revision, versionId) => {
    const finishLoading = beginLoading(set)
    try {
      const { project } = await imageWorkbenchApi.selectVersion(projectId, { revision, version_id: versionId })
      projectLoadVersion += 1
      set(state => ({ projects: upsert(state.projects, project) }))
      return project
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  cancelOperation: async operationId => {
    const finishLoading = beginLoading(set)
    try {
      const { task } = await imageWorkbenchApi.cancelOperation(operationId)
      nextOperationLoadVersion(task.id)
      set(state => ({ operations: { ...state.operations, [task.id]: task } }))
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
      await imageWorkbenchApi.deleteProject(projectId)
      projectLoadVersion += 1
      set(state => {
        const projects = state.projects.filter(project => project.id !== projectId)
        return {
          projects,
          eventCursors: { ...state.eventCursors, [projectId]: undefined },
          activeProjectId: state.activeProjectId === projectId ? projects[0]?.id ?? null : state.activeProjectId,
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
      await imageWorkbenchApi.restoreProject(projectId)
      const { project } = await imageWorkbenchApi.getProject(projectId)
      await Promise.all([get().loadProjects(true), get().loadDeletions()])
      set({ activeProjectId: project.id })
    } catch (error) {
      const safeError = rendererSafeError(error)
      set({ error: safeError.message })
      throw safeError
    } finally {
      finishLoading()
    }
  },

  subscribeProjectEvents: projectId => {
    const existing = activeImageEventSubscriptions.get(projectId)
    if (existing) {
      existing.references += 1
      return () => {
        existing.references -= 1
        if (existing.references === 0) {
          existing.controller.abort()
          activeImageEventSubscriptions.delete(projectId)
        }
      }
    }
    const controller = new AbortController()
    const subscription = { controller, references: 1 }
    activeImageEventSubscriptions.set(projectId, subscription)
    void (async () => {
      let reconnectDelay = 250
      let reconcileAfterReconnect = false
      while (!controller.signal.aborted) {
        const cursor = get().eventCursors[projectId] ?? 0
        try {
          const page = await imageWorkbenchApi.waitForProjectEvents(projectId, cursor, controller.signal)
          if (controller.signal.aborted) break
          reconnectDelay = 250
          let acceptedEvent = false
          set(state => {
            let nextCursor = state.eventCursors[projectId] ?? 0
            const operations = { ...state.operations }
            for (const event of [...page.events].sort((left, right) => left.cursor - right.cursor)) {
              if (event.project_id !== projectId || event.cursor <= nextCursor) continue
              nextCursor = event.cursor
              const current = operations[event.task.id]
              if (!current || event.status_sequence >= (current.status_sequence ?? 0)) {
                nextOperationLoadVersion(event.task.id)
                operations[event.task.id] = event.task
                acceptedEvent = true
              }
            }
            return {
              operations,
              eventCursors: { ...state.eventCursors, [projectId]: Math.max(nextCursor, page.cursor) },
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
      if (activeImageEventSubscriptions.get(projectId) === subscription) {
        activeImageEventSubscriptions.delete(projectId)
      }
    })
    return () => {
      subscription.references -= 1
      if (subscription.references === 0) {
        subscription.controller.abort()
        activeImageEventSubscriptions.delete(projectId)
      }
    }
  },

  clearError: () => set({ error: null }),
}))
