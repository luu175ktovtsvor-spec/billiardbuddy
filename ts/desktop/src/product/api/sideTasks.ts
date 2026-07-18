import { productApi } from './client'
import type {
  CreateProductSideTaskInput,
  ProductSideTaskActionResponse,
  ProductSideTaskApi,
  ProductSideTaskListResponse,
} from '../domain/types'

function taskPath(taskId: string): string {
  return `/api/product/tasks/${encodeURIComponent(taskId)}`
}

export const productSideTasksApi: ProductSideTaskApi = {
  list: (taskId: string) => productApi.get<ProductSideTaskListResponse>(`${taskPath(taskId)}/side-tasks`),
  create: (taskId: string, input: CreateProductSideTaskInput) =>
    productApi.post<ProductSideTaskActionResponse>(`${taskPath(taskId)}/side-tasks`, input),
  close: (taskId: string, sideTaskId: string) =>
    productApi.post<ProductSideTaskActionResponse>(
      `${taskPath(taskId)}/side-tasks/${encodeURIComponent(sideTaskId)}/close`,
      {},
    ),
}
