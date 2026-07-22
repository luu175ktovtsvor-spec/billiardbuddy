import { productApi } from './client'
import { productTasksApi } from './tasks'
import type {
  CreateProductSideTaskInput,
  MutationEnvelope,
  ProductSideTaskApi,
  ProductSideTaskListResponse,
} from '../domain/types'

function taskPath(taskId: string): string {
  return `/api/product/tasks/${encodeURIComponent(taskId)}`
}

/** Side mutations share the sole authoritative ProductTask HTTP protocol. */
export const productSideTasksApi: ProductSideTaskApi = {
  list: (taskId: string) => productApi.get<ProductSideTaskListResponse>(`${taskPath(taskId)}/side-tasks`),
  create: (taskId: string, input: MutationEnvelope<CreateProductSideTaskInput & { sideTaskId: string }>) =>
    productTasksApi.createSideTask(taskId, input),
  close: (taskId: string, sideTaskId: string, input: MutationEnvelope) =>
    productTasksApi.closeSideTask(taskId, sideTaskId, input),
}
