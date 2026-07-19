import { productApi } from './client'
import type {
  CreateProductScheduledTaskInput,
  ProductScheduledTaskApi,
  ProductScheduledTaskListResponse,
  ProductScheduledTaskResponse,
  ProductScheduledTaskRunsResponse,
  UpdateProductScheduledTaskInput,
} from '../domain/types'

const SCHEDULED_TASKS_PATH = '/api/product/scheduled-tasks'

function taskPath(taskId: string): string {
  return `${SCHEDULED_TASKS_PATH}/${encodeURIComponent(taskId)}`
}

export const productScheduledTasksApi: ProductScheduledTaskApi = {
  list: () => productApi.get<ProductScheduledTaskListResponse>(SCHEDULED_TASKS_PATH),
  create: (input: CreateProductScheduledTaskInput) => productApi.post<ProductScheduledTaskResponse>(SCHEDULED_TASKS_PATH, input),
  update: (taskId: string, input: UpdateProductScheduledTaskInput) => productApi.patch<ProductScheduledTaskResponse>(taskPath(taskId), input),
  delete: (taskId: string) => productApi.delete<{ ok: true }>(taskPath(taskId)),
  run: (taskId: string) => productApi.post<{ ok: true }>(`${taskPath(taskId)}/run`, {}),
  getRecentRuns: (limit = 50) => productApi.get<ProductScheduledTaskRunsResponse>(`${SCHEDULED_TASKS_PATH}/runs?limit=${limit}`),
  getTaskRuns: (taskId: string) => productApi.get<ProductScheduledTaskRunsResponse>(`${taskPath(taskId)}/runs`),
}
