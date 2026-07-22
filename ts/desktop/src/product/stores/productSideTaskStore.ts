import { create } from 'zustand'
import { ProductApiError, productApiUserFacingError } from '../api/client'
import { productSideTasksApi } from '../api/sideTasks'
import type {
  CreateProductSideTaskInput,
  MutationEnvelope,
  ProductSideTask,
  ProductSideTaskActionResponse,
} from '../domain/types'

export type ProductSideTaskPanelState = { isOpen: boolean; selectedSideTaskId?: string }
type PendingSideMutation = MutationEnvelope<Record<string, unknown>>
type AuthoritativeSideResponse = Extract<ProductSideTaskActionResponse, { authority: unknown }>

type ProductSideTaskStore = {
  sideTasksByParentTaskId: Record<string, ProductSideTask[] | undefined>
  loadingByParentTaskId: Record<string, boolean | undefined>
  errorsByParentTaskId: Record<string, string | undefined>
  mutations: Record<string, boolean | undefined>
  panelByParentTaskId: Record<string, ProductSideTaskPanelState | undefined>
  confirmedAuthorityRevisionByParentTaskId: Record<string, number | undefined>
  pending: Record<string, PendingSideMutation | undefined>
  refreshSideTasks: (parentTaskId: string) => Promise<void>
  createSideTask: (parentTaskId: string, input: CreateProductSideTaskInput) => Promise<ProductSideTask>
  closeSideTask: (parentTaskId: string, sideTaskId: string) => Promise<ProductSideTask>
  openSideTaskPanel: (parentTaskId: string, sideTaskId?: string) => void
  closeSideTaskPanel: (parentTaskId: string) => void
  selectSideTask: (parentTaskId: string, sideTaskId: string) => void
}

function errorMessage(error: unknown, fallback: string): string { return productApiUserFacingError(error, fallback) }
export function productSideTaskMutationKey(parentTaskId: string, sideTaskId: string, action: string): string { return `${parentTaskId}:${sideTaskId}:${action}` }

/** Replace side projections only with complete authority-owned entities. */
function mergeAuthoritySideProjection(map: Record<string, ProductSideTask[] | undefined>, parentTaskId: string, response: AuthoritativeSideResponse) {
  const sideTasks = response.authority.side_tasks.filter((sideTask) => sideTask.parentTaskId === parentTaskId)
  if (sideTasks.some((sideTask) => !sideTask.id || !sideTask.taskId || !sideTask.title || !sideTask.createdAt || !sideTask.updatedAt || (sideTask.status !== 'open' && sideTask.status !== 'closed'))) throw new Error('Incomplete authority side-task projection')
  return { ...map, [parentTaskId]: sideTasks }
}

function operationId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `operation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
function envelope<T extends object>(input: T, expected_revision: number): MutationEnvelope<T> {
  return Object.freeze({ ...input, expected_revision, client_operation_id: operationId() })
}

let nextRefreshRequestId = 0
const latestRefreshRequestIdByParentTaskId = new Map<string, number>()

export const useProductSideTaskStore = create<ProductSideTaskStore>((set, get) => {
  const runMutation = async (
    parentTaskId: string,
    intentKey: string,
    sideTaskId: string,
    input: Record<string, unknown>,
    action: (value: PendingSideMutation) => Promise<ProductSideTaskActionResponse>,
  ): Promise<ProductSideTask> => {
    const current = get()
    const value = current.pending[intentKey] ?? envelope(input, current.confirmedAuthorityRevisionByParentTaskId[parentTaskId] ?? 0)
    set((state) => ({ errorsByParentTaskId: { ...state.errorsByParentTaskId, [parentTaskId]: undefined }, pending: { ...state.pending, [intentKey]: value }, mutations: { ...state.mutations, [intentKey]: true } }))
    try {
      const response = await action(value)
      if (!('receipt' in response) || !('authority' in response)) throw new Error('Missing durable operation receipt')
      let sideTask: ProductSideTask | undefined
      set((state) => {
        const confirmed = state.confirmedAuthorityRevisionByParentTaskId[parentTaskId] ?? 0
        const pending = { ...state.pending }
        delete pending[intentKey]
        if (response.authority.revision < confirmed) {
          sideTask = state.sideTasksByParentTaskId[parentTaskId]?.find((task) => task.id === sideTaskId)
          return { pending, mutations: { ...state.mutations, [intentKey]: false } }
        }
        let sideTasksByParentTaskId = mergeAuthoritySideProjection(state.sideTasksByParentTaskId, parentTaskId, response)
        sideTask = sideTasksByParentTaskId[parentTaskId]?.find((task) => task.id === sideTaskId)
        if (!sideTask) throw new Error('Authority receipt did not include the mutated side-task entity')
        return {
          sideTasksByParentTaskId,
          confirmedAuthorityRevisionByParentTaskId: { ...state.confirmedAuthorityRevisionByParentTaskId, [parentTaskId]: response.authority.revision },
          pending,
          mutations: { ...state.mutations, [intentKey]: false },
        }
      })
      if (!sideTask) throw new Error('Authority receipt did not identify a side-task projection')
      return sideTask
    } catch (error) {
      set((state) => {
        const pending = { ...state.pending }
        if (error instanceof ProductApiError) delete pending[intentKey]
        return { errorsByParentTaskId: { ...state.errorsByParentTaskId, [parentTaskId]: errorMessage(error, '暂时无法完成侧边任务操作，请稍后重试。') }, pending, mutations: { ...state.mutations, [intentKey]: false } }
      })
      throw error
    }
  }

  return {
    sideTasksByParentTaskId: {}, loadingByParentTaskId: {}, errorsByParentTaskId: {}, mutations: {}, panelByParentTaskId: {}, confirmedAuthorityRevisionByParentTaskId: {}, pending: {},
    refreshSideTasks: async (parentTaskId) => {
      const requestId = ++nextRefreshRequestId
      latestRefreshRequestIdByParentTaskId.set(parentTaskId, requestId)
      set((state) => ({ loadingByParentTaskId: { ...state.loadingByParentTaskId, [parentTaskId]: true }, errorsByParentTaskId: { ...state.errorsByParentTaskId, [parentTaskId]: undefined } }))
      try {
        const { sideTasks } = await productSideTasksApi.list(parentTaskId)
        if (latestRefreshRequestIdByParentTaskId.get(parentTaskId) !== requestId) return
        set((state) => ({ sideTasksByParentTaskId: { ...state.sideTasksByParentTaskId, [parentTaskId]: sideTasks }, loadingByParentTaskId: { ...state.loadingByParentTaskId, [parentTaskId]: false } }))
      } catch (error) {
        if (latestRefreshRequestIdByParentTaskId.get(parentTaskId) !== requestId) return
        set((state) => ({ loadingByParentTaskId: { ...state.loadingByParentTaskId, [parentTaskId]: false }, errorsByParentTaskId: { ...state.errorsByParentTaskId, [parentTaskId]: errorMessage(error, '暂时无法读取侧边任务，请稍后重试。') } }))
      }
    },
    createSideTask: (parentTaskId, input) => {
      const existing = get().pending[productSideTaskMutationKey(parentTaskId, 'new', 'create')]
      const sideTaskId = typeof existing?.sideTaskId === 'string' ? existing.sideTaskId : `side_${operationId().replace(/[^a-zA-Z0-9_-]/g, '')}`
      const key = productSideTaskMutationKey(parentTaskId, 'new', 'create')
      return runMutation(parentTaskId, key, sideTaskId, { ...input, sideTaskId }, (value) => productSideTasksApi.create(parentTaskId, value as MutationEnvelope<CreateProductSideTaskInput & { sideTaskId: string }>))
    },
    closeSideTask: (parentTaskId, sideTaskId) => {
      const key = productSideTaskMutationKey(parentTaskId, sideTaskId, 'close')
      return runMutation(parentTaskId, key, sideTaskId, { sideTaskId }, (value) => productSideTasksApi.close(parentTaskId, sideTaskId, value))
    },
    openSideTaskPanel: (parentTaskId, sideTaskId) => {
      const existing = get().panelByParentTaskId[parentTaskId]
      const selectedSideTaskId = sideTaskId ?? existing?.selectedSideTaskId ?? get().sideTasksByParentTaskId[parentTaskId]?.find((sideTask) => sideTask.status === 'open')?.id
      set((state) => ({ panelByParentTaskId: { ...state.panelByParentTaskId, [parentTaskId]: { isOpen: true, ...(selectedSideTaskId ? { selectedSideTaskId } : {}) } } }))
    },
    closeSideTaskPanel: (parentTaskId) => set((state) => ({ panelByParentTaskId: { ...state.panelByParentTaskId, [parentTaskId]: { isOpen: false } } })),
    selectSideTask: (parentTaskId, sideTaskId) => set((state) => ({ panelByParentTaskId: { ...state.panelByParentTaskId, [parentTaskId]: { isOpen: true, selectedSideTaskId: sideTaskId } } })),
  }
})
