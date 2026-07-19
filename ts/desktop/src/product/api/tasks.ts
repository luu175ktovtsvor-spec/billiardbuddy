import { productApi } from './client'
import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  ProductTaskActionResponse,
  ProductTaskApi,
  ProductTaskIndexResponse,
  ProductTaskMediaAttachableList,
  ProductTaskMediaList,
  ProductTaskMediaProject,
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
  ProductTaskThreadResponse,
  UpdateProductTaskInput,
} from '../domain/types'

function taskPath(taskId: string): string {
  return `/api/product/tasks/${encodeURIComponent(taskId)}`
}

function reviewPath(taskId: string, resource: 'status' | 'tree' | 'file' | 'diff', path?: string): string {
  const base = `${taskPath(taskId)}/review/${resource}`
  if (!path) return base
  return `${base}?path=${encodeURIComponent(path)}`
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
  getReviewStatus: (taskId) => productApi.get<ProductTaskReviewStatus>(reviewPath(taskId, 'status')),
  getReviewTree: (taskId, path) => productApi.get<ProductTaskReviewTree>(reviewPath(taskId, 'tree', path)),
  getReviewFile: (taskId, path) => productApi.get<ProductTaskReviewFile>(reviewPath(taskId, 'file', path)),
  getReviewDiff: (taskId, path) => productApi.get<ProductTaskReviewDiff>(reviewPath(taskId, 'diff', path)),
  getMedia: (taskId) => productApi.get<ProductTaskMediaList>(`${taskPath(taskId)}/media`),
  getAttachableMedia: (taskId) => productApi.get<ProductTaskMediaAttachableList>(`${taskPath(taskId)}/media/attachable-projects`),
  attachMediaProject: (taskId, projectId) => productApi.post<{ project: ProductTaskMediaProject }>(
    `${taskPath(taskId)}/media/projects/${encodeURIComponent(projectId)}/attach`,
    {},
  ),
}
