import { create } from 'zustand'
import { productApiUserFacingError } from '../api/client'
import { productTasksApi } from '../api/tasks'
import { PRODUCT_DOMAIN_VERSION } from '../domain/types'
import { orderProductProjects, orderProductTasks } from '../taskOrdering'
import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  ProductTaskIndexResponse,
  ProductTaskRecord,
} from '../domain/types'

export const EMPTY_PRODUCT_TASK_INDEX: ProductTaskIndexResponse = {
  schemaVersion: PRODUCT_DOMAIN_VERSION,
  projects: [],
  directories: [],
  tasks: [],
  total: 0,
  capabilities: {
    createTask: false,
  },
}

export function productTaskMutationKey(taskId: string, action: string): string {
  return `${taskId}:${action}`
}

type ProductTaskStore = {
  index: ProductTaskIndexResponse
  isLoading: boolean
  error: string | null
  mutations: Record<string, boolean | undefined>

  refresh: () => Promise<void>
  clearError: () => void
  /** Apply a title received through the restricted product task stream. */
  applyRuntimeTaskTitle: (taskId: string, title: string) => void
  createTask: (input: CreateProductTaskInput) => Promise<ProductTaskRecord>
  renameTask: (taskId: string, title: string) => Promise<ProductTaskRecord>
  pinTask: (taskId: string) => Promise<ProductTaskRecord>
  unpinTask: (taskId: string) => Promise<ProductTaskRecord>
  archiveTask: (taskId: string) => Promise<ProductTaskRecord>
  restoreTask: (taskId: string) => Promise<ProductTaskRecord>
  continueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<ProductTaskRecord>
}

function errorMessage(error: unknown, fallback: string): string {
  return productApiUserFacingError(error, fallback)
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function reconcileProjectSummaries(
  index: ProductTaskIndexResponse,
  tasks: readonly ProductTaskRecord[],
): ProductTaskIndexResponse['projects'] {
  return index.projects.map((project) => {
    const projectTasks = tasks.filter((task) => task.projectId === project.id)
    let updatedAt = project.updatedAt
    let updatedTimestamp = timestamp(updatedAt)
    let taskCount = 0
    let archivedTaskCount = 0

    for (const task of projectTasks) {
      if (task.lifecycle === 'archived') archivedTaskCount += 1
      else taskCount += 1
      const taskTimestamp = timestamp(task.updatedAt)
      if (taskTimestamp > updatedTimestamp) {
        updatedAt = task.updatedAt
        updatedTimestamp = taskTimestamp
      }
    }

    return {
      ...project,
      taskCount,
      archivedTaskCount,
      updatedAt,
    }
  })
}

function upsertTask(index: ProductTaskIndexResponse, task: ProductTaskRecord): ProductTaskIndexResponse {
  const exists = index.tasks.some((current) => current.id === task.id)
  const tasks = orderProductTasks(exists
    ? index.tasks.map((current) => current.id === task.id ? task : current)
    : [task, ...index.tasks])
  const projects = reconcileProjectSummaries(index, tasks)
  return {
    ...index,
    projects: orderProductProjects(projects, tasks),
    tasks,
    total: tasks.length,
  }
}

let latestRefreshRequest = 0

export const useProductTaskStore = create<ProductTaskStore>((set, get) => {
  const runMutation = async (
    key: string,
    action: () => Promise<{ task: ProductTaskRecord }>,
  ): Promise<ProductTaskRecord> => {
    set((state) => ({
      error: null,
      mutations: {
        ...state.mutations,
        [key]: true,
      },
    }))

    try {
      const { task } = await action()
      set((state) => ({
        index: upsertTask(state.index, task),
      }))
      return task
    } catch (error) {
      set({ error: errorMessage(error, '暂时无法完成任务操作，请稍后重试。') })
      throw error
    } finally {
      set((state) => ({
        mutations: {
          ...state.mutations,
          [key]: false,
        },
      }))
    }
  }

  return {
    index: EMPTY_PRODUCT_TASK_INDEX,
    isLoading: false,
    error: null,
    mutations: {},

    refresh: async () => {
      const requestId = ++latestRefreshRequest
      set({ isLoading: true, error: null })
      try {
        const index = await productTasksApi.list()
        if (requestId === latestRefreshRequest) {
          set({ index, isLoading: false })
        }
      } catch (error) {
        if (requestId === latestRefreshRequest) {
          set({ error: errorMessage(error, '暂时无法读取任务，请稍后重试。'), isLoading: false })
        }
      }
    },

    clearError: () => set({ error: null }),

    applyRuntimeTaskTitle: (taskId, title) => {
      const normalizedTaskId = taskId.trim()
      const normalizedTitle = title.trim()
      if (!normalizedTaskId || !normalizedTitle) return

      set((state) => {
        const current = state.index.tasks.find((task) => task.id === normalizedTaskId)
        if (!current || current.title === normalizedTitle) return state

        return {
          index: {
            ...state.index,
            // A title event carries no trustworthy ordering timestamp, so keep
            // lifecycle, actions, and updatedAt from the last task record.
            tasks: state.index.tasks.map((task) => task.id === normalizedTaskId
              ? { ...task, title: normalizedTitle }
              : task),
          },
        }
      })
    },

    createTask: async (input) => {
      const task = await runMutation('create', () => productTasksApi.create(input))
      await get().refresh()
      return task
    },

    renameTask: (taskId, title) => runMutation(
      productTaskMutationKey(taskId, 'rename'),
      () => productTasksApi.update(taskId, { title }),
    ),

    pinTask: (taskId) => runMutation(
      productTaskMutationKey(taskId, 'pin'),
      () => productTasksApi.pin(taskId),
    ),

    unpinTask: (taskId) => runMutation(
      productTaskMutationKey(taskId, 'unpin'),
      () => productTasksApi.unpin(taskId),
    ),

    archiveTask: (taskId) => runMutation(
      productTaskMutationKey(taskId, 'archive'),
      () => productTasksApi.archive(taskId),
    ),

    restoreTask: (taskId) => runMutation(
      productTaskMutationKey(taskId, 'restore'),
      () => productTasksApi.restore(taskId),
    ),

    continueTask: async (taskId, input) => {
      const task = await runMutation(
        productTaskMutationKey(taskId, 'continue'),
        () => productTasksApi.continue(taskId, input),
      )
      await get().refresh()
      return task
    },
  }
})
