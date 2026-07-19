import { create } from 'zustand'
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
  createTask: (input: CreateProductTaskInput) => Promise<ProductTaskRecord>
  renameTask: (taskId: string, title: string) => Promise<ProductTaskRecord>
  pinTask: (taskId: string) => Promise<ProductTaskRecord>
  unpinTask: (taskId: string) => Promise<ProductTaskRecord>
  archiveTask: (taskId: string) => Promise<ProductTaskRecord>
  restoreTask: (taskId: string) => Promise<ProductTaskRecord>
  continueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<ProductTaskRecord>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function upsertTask(index: ProductTaskIndexResponse, task: ProductTaskRecord): ProductTaskIndexResponse {
  const exists = index.tasks.some((current) => current.id === task.id)
  const tasks = orderProductTasks(exists
    ? index.tasks.map((current) => current.id === task.id ? task : current)
    : [task, ...index.tasks])
  return {
    ...index,
    projects: orderProductProjects(
      index.projects,
      tasks.filter((candidate) => candidate.lifecycle === 'active'),
    ),
    tasks,
    total: tasks.length,
  }
}

let latestRefreshRequest = 0

export const useProductTaskStore = create<ProductTaskStore>((set) => {
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
      set({ error: errorMessage(error) })
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
          set({ error: errorMessage(error), isLoading: false })
        }
      }
    },

    clearError: () => set({ error: null }),

    createTask: (input) => runMutation('create', () => productTasksApi.create(input)),

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

    continueTask: (taskId, input) => runMutation(
      productTaskMutationKey(taskId, 'continue'),
      () => productTasksApi.continue(taskId, input),
    ),
  }
})
