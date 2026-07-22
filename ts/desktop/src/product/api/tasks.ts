import { productApi } from './client'
import type {
  AuthoritySnapshot,
  ContinueProductTaskInput,
  CreateProductTaskInput,
  CreateProductSideTaskInput,
  MutationEnvelope,
  OperationReceipt,
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

export const PRODUCT_MEDIA_RESULT_TIMEOUT_MS = 5 * 60_000

function reviewPath(taskId: string, resource: 'status' | 'tree' | 'file' | 'diff', path?: string): string {
  const base = `${taskPath(taskId)}/review/${resource}`
  if (!path) return base
  return `${base}?path=${encodeURIComponent(path)}`
}

type OperationQueryResponse = { receipt: OperationReceipt; authority: AuthoritySnapshot }

export const productTasksApi: ProductTaskApi = {
  list: () => productApi.get<ProductTaskIndexResponse>('/api/product/tasks'),
  create: (input: MutationEnvelope<CreateProductTaskInput>) =>
    productApi.post<ProductTaskActionResponse>('/api/product/tasks', input),
  update: (taskId: string, input: MutationEnvelope<UpdateProductTaskInput>) =>
    productApi.patch<ProductTaskActionResponse>(taskPath(taskId), input),
  pin: (taskId: string, input: MutationEnvelope) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/pin`, input),
  unpin: (taskId: string, input: MutationEnvelope) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/unpin`, input),
  archive: (taskId: string, input: MutationEnvelope) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/archive`, input),
  restore: (taskId: string, input: MutationEnvelope) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/restore`, input),
  continue: (taskId: string, input: MutationEnvelope<ContinueProductTaskInput>) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/continue`, input),
  createSideTask: (taskId: string, input: MutationEnvelope<CreateProductSideTaskInput & { sideTaskId: string }>) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/side-tasks`, input),
  closeSideTask: (taskId: string, sideTaskId: string, input: MutationEnvelope) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/side-tasks/${encodeURIComponent(sideTaskId)}/close`, input),
  getOperation: (taskId: string, operationId: string) =>
    productApi.get<OperationQueryResponse>(`${taskPath(taskId)}/operations/${encodeURIComponent(operationId)}`),
  getThread: (taskId: string) => productApi.get<ProductTaskThreadResponse>(`${taskPath(taskId)}/thread`),
  getReviewStatus: (taskId) => productApi.get<ProductTaskReviewStatus>(reviewPath(taskId, 'status')),
  getReviewTree: (taskId, path) => productApi.get<ProductTaskReviewTree>(reviewPath(taskId, 'tree', path)),
  getReviewFile: (taskId, path) => productApi.get<ProductTaskReviewFile>(reviewPath(taskId, 'file', path)),
  getReviewDiff: (taskId, path) => productApi.get<ProductTaskReviewDiff>(reviewPath(taskId, 'diff', path)),
  getMedia: (taskId) => productApi.get<ProductTaskMediaList>(
    `${taskPath(taskId)}/media`,
    { timeout: PRODUCT_MEDIA_RESULT_TIMEOUT_MS },
  ),
  getAttachableMedia: (taskId) => productApi.get<ProductTaskMediaAttachableList>(`${taskPath(taskId)}/media/attachable-projects`),
  attachMediaProject: (taskId, projectId) => productApi.post<{ project: ProductTaskMediaProject }>(
    `${taskPath(taskId)}/media/projects/${encodeURIComponent(projectId)}/attach`,
    {},
  ),
}
