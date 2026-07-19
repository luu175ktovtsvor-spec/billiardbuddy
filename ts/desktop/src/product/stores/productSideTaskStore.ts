import { create } from 'zustand'
import { productApiUserFacingError } from '../api/client'
import { productSideTasksApi } from '../api/sideTasks'
import type {
  CreateProductSideTaskInput,
  ProductSideTask,
} from '../domain/types'

export type ProductSideTaskPanelState = {
  isOpen: boolean
  selectedSideTaskId?: string
}

type ProductSideTaskStore = {
  sideTasksByParentTaskId: Record<string, ProductSideTask[] | undefined>
  loadingByParentTaskId: Record<string, boolean | undefined>
  errorsByParentTaskId: Record<string, string | undefined>
  mutations: Record<string, boolean | undefined>
  panelByParentTaskId: Record<string, ProductSideTaskPanelState | undefined>

  refreshSideTasks: (parentTaskId: string) => Promise<void>
  createSideTask: (parentTaskId: string, input: CreateProductSideTaskInput) => Promise<ProductSideTask>
  closeSideTask: (parentTaskId: string, sideTaskId: string) => Promise<ProductSideTask>
  openSideTaskPanel: (parentTaskId: string, sideTaskId?: string) => void
  closeSideTaskPanel: (parentTaskId: string) => void
  selectSideTask: (parentTaskId: string, sideTaskId: string) => void
}

function errorMessage(error: unknown, fallback: string): string {
  return productApiUserFacingError(error, fallback)
}

export function productSideTaskMutationKey(parentTaskId: string, sideTaskId: string, action: string): string {
  return `${parentTaskId}:${sideTaskId}:${action}`
}

function upsertSideTask(
  sideTasksByParentTaskId: Record<string, ProductSideTask[] | undefined>,
  parentTaskId: string,
  sideTask: ProductSideTask,
): Record<string, ProductSideTask[] | undefined> {
  const current = sideTasksByParentTaskId[parentTaskId] ?? []
  const exists = current.some((candidate) => candidate.id === sideTask.id)
  const next = exists
    ? current.map((candidate) => candidate.id === sideTask.id ? sideTask : candidate)
    : [sideTask, ...current]
  return {
    ...sideTasksByParentTaskId,
    [parentTaskId]: next,
  }
}

let nextRefreshRequestId = 0
const latestRefreshRequestIdByParentTaskId = new Map<string, number>()

export const useProductSideTaskStore = create<ProductSideTaskStore>((set, get) => ({
  sideTasksByParentTaskId: {},
  loadingByParentTaskId: {},
  errorsByParentTaskId: {},
  mutations: {},
  panelByParentTaskId: {},

  refreshSideTasks: async (parentTaskId) => {
    const requestId = ++nextRefreshRequestId
    latestRefreshRequestIdByParentTaskId.set(parentTaskId, requestId)
    set((state) => ({
      loadingByParentTaskId: {
        ...state.loadingByParentTaskId,
        [parentTaskId]: true,
      },
      errorsByParentTaskId: {
        ...state.errorsByParentTaskId,
        [parentTaskId]: undefined,
      },
    }))

    try {
      const { sideTasks } = await productSideTasksApi.list(parentTaskId)
      if (latestRefreshRequestIdByParentTaskId.get(parentTaskId) !== requestId) return
      set((state) => ({
        sideTasksByParentTaskId: {
          ...state.sideTasksByParentTaskId,
          [parentTaskId]: sideTasks,
        },
        loadingByParentTaskId: {
          ...state.loadingByParentTaskId,
          [parentTaskId]: false,
        },
      }))
    } catch (error) {
      if (latestRefreshRequestIdByParentTaskId.get(parentTaskId) !== requestId) return
      set((state) => ({
        loadingByParentTaskId: {
          ...state.loadingByParentTaskId,
          [parentTaskId]: false,
        },
        errorsByParentTaskId: {
          ...state.errorsByParentTaskId,
          [parentTaskId]: errorMessage(error, '暂时无法读取侧边任务，请稍后重试。'),
        },
      }))
    }
  },

  createSideTask: async (parentTaskId, input) => {
    const key = productSideTaskMutationKey(parentTaskId, 'new', 'create')
    set((state) => ({
      errorsByParentTaskId: {
        ...state.errorsByParentTaskId,
        [parentTaskId]: undefined,
      },
      mutations: {
        ...state.mutations,
        [key]: true,
      },
    }))

    try {
      const { sideTask } = await productSideTasksApi.create(parentTaskId, input)
      set((state) => ({
        sideTasksByParentTaskId: upsertSideTask(
          state.sideTasksByParentTaskId,
          parentTaskId,
          sideTask,
        ),
      }))
      return sideTask
    } catch (error) {
      set((state) => ({
        errorsByParentTaskId: {
          ...state.errorsByParentTaskId,
          [parentTaskId]: errorMessage(error, '暂时无法创建侧边任务，请稍后重试。'),
        },
      }))
      throw error
    } finally {
      set((state) => ({
        mutations: {
          ...state.mutations,
          [key]: false,
        },
      }))
    }
  },

  closeSideTask: async (parentTaskId, sideTaskId) => {
    const key = productSideTaskMutationKey(parentTaskId, sideTaskId, 'close')
    set((state) => ({
      errorsByParentTaskId: {
        ...state.errorsByParentTaskId,
        [parentTaskId]: undefined,
      },
      mutations: {
        ...state.mutations,
        [key]: true,
      },
    }))

    try {
      const { sideTask } = await productSideTasksApi.close(parentTaskId, sideTaskId)
      set((state) => ({
        sideTasksByParentTaskId: upsertSideTask(
          state.sideTasksByParentTaskId,
          parentTaskId,
          sideTask,
        ),
      }))
      return sideTask
    } catch (error) {
      set((state) => ({
        errorsByParentTaskId: {
          ...state.errorsByParentTaskId,
          [parentTaskId]: errorMessage(error, '暂时无法关闭侧边任务，请稍后重试。'),
        },
      }))
      throw error
    } finally {
      set((state) => ({
        mutations: {
          ...state.mutations,
          [key]: false,
        },
      }))
    }
  },

  openSideTaskPanel: (parentTaskId, sideTaskId) => {
    const existingPanel = get().panelByParentTaskId[parentTaskId]
    const availableSideTasks = get().sideTasksByParentTaskId[parentTaskId] ?? []
    const selectedSideTaskId = sideTaskId
      ?? existingPanel?.selectedSideTaskId
      ?? availableSideTasks.find((sideTask) => sideTask.status === 'open')?.id
    set((state) => ({
      panelByParentTaskId: {
        ...state.panelByParentTaskId,
        [parentTaskId]: {
          isOpen: true,
          ...(selectedSideTaskId ? { selectedSideTaskId } : {}),
        },
      },
    }))
  },

  closeSideTaskPanel: (parentTaskId) => {
    set((state) => ({
      panelByParentTaskId: {
        ...state.panelByParentTaskId,
        [parentTaskId]: {
          isOpen: false,
        },
      },
    }))
  },

  selectSideTask: (parentTaskId, sideTaskId) => {
    set((state) => ({
      panelByParentTaskId: {
        ...state.panelByParentTaskId,
        [parentTaskId]: {
          isOpen: true,
          selectedSideTaskId: sideTaskId,
        },
      },
    }))
  },
}))
