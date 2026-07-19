import { productApi } from './client'
import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  ProductTaskActionResponse,
  ProductTaskApi,
  ProductTaskIndexResponse,
  ProductTaskThreadResponse,
  UpdateProductTaskInput,
} from '../domain/types'

function taskPath(taskId: string): string {
  return `/api/product/tasks/${encodeURIComponent(taskId)}`
}

export const productTasksApi: ProductTaskApi = {
  list: () => productApi.get<ProductTaskIndexResponse>('/api/product/tasks'),
  create: (input: CreateProductTaskInput) => productApi.post<ProductTaskActionResponse>('/api/product/tasks', input),
  update: (taskId: string, input: UpdateProductTaskInput) => productApi.patch<ProductTaskActionResponse>(taskPath(taskId), input),
  pin: (taskId: string) => productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/pin`, {}),
  unpin: (taskId: string) => productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/unpin`, {}),
  archive: (taskId: string) => productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/archive`, {}),
  restore: (taskId: string) => productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/restore`, {}),
  continue: (taskId: string, input: ContinueProductTaskInput) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/continue`, input),
  getThread: (taskId: string) => productApi.get<ProductTaskThreadResponse>(`${taskPath(taskId)}/thread`),
}
