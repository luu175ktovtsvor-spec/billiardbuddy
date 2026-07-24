import { productApi } from './client'
import type {
  AuthoritySnapshot,
  ContinueProductTaskInput,
  CreateProductTaskInput,
  CreateProductSideTaskInput,
  MutationEnvelope,
  OperationReceipt,
  ProductTaskActionResponse,
  ProductTaskDeletionResponse,
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
  ProductWorkspaceApi,
  ProductComposerDraftApi,
  ProductConversationLineageApi,
  ProductAttachmentApi,
  ProductTaskPermissionMode,
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

export type NewTaskDraftResponse = {
  draft: { draft_id: string; revision: number }
  authority_revision: number
  outcome: 'accepted' | 'duplicate'
}

export type AtomicTaskSubmitInput = {
  draft_id: string
  expected_draft_revision: number
  client_operation_id: string
  text: string
  attachment_ids: string[]
  permission_mode: ProductTaskPermissionMode
}

export type AtomicTaskSubmitResponse = {
  receipt: {
    outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
    authority_revision: number
    result?: { task_id: string; run_id: string; entry_id: string; dispatch_generation: number }
  }
}

export type ProductTaskRunSubmitInput = {
  client_operation_id: string
  expected_task_revision: number
  expected_lineage_revision: number
  text: string
  attachment_ids: string[]
  reference_entry_ids: string[]
  draft_id?: string
  expected_draft_revision?: number
}

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
  delete: (taskId, input) => productApi.post<ProductTaskDeletionResponse>(`${taskPath(taskId)}/delete`, input),
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

export const productAtomicTaskSubmitApi = {
  createDraft: (client_operation_id: string) => productApi.post<NewTaskDraftResponse>(
    '/api/product/composer-drafts/new-task',
    { ttl_ms: 7 * 24 * 60 * 60 * 1000, client_operation_id },
  ),
  submit: (input: AtomicTaskSubmitInput) => productApi.post<AtomicTaskSubmitResponse>(
    '/api/product/tasks',
    input,
  ),
}

export const productTaskRunSubmitApi = {
  submit: (taskId: string, input: ProductTaskRunSubmitInput) => productApi.post<AtomicTaskSubmitResponse>(
    `${taskPath(taskId)}/runs`,
    input,
  ),
}

export const productAttachmentIngestApi = {
  ingest: (draftId: string, input: {
    type: 'file' | 'image'
    name: string
    mime_type: string
    data: string
    client_operation_id: string
  }) => productApi.post<{
    attachment: {
      attachment_id: string
      attachment_revision: number
      authority_revision: number
      outcome: 'accepted' | 'duplicate'
    }
  }>(`/api/product/composer-drafts/${encodeURIComponent(draftId)}/attachments`, input),
}


function workspacePath(workspaceId?: string): string {
  return workspaceId
    ? `/api/product/workspaces/${encodeURIComponent(workspaceId)}`
    : '/api/product/workspaces'
}

export const productWorkspaceApi: ProductWorkspaceApi = {
  register: (input) => productApi.post(workspacePath(), input),
  inspect: (workspaceId) => productApi.post(`${workspacePath(workspaceId)}/inspect`, {}),
  relocate: (workspaceId, input) => productApi.post(`${workspacePath(workspaceId)}/relocate`, input),
  relink: (workspaceId, input) => productApi.post(`${workspacePath(workspaceId)}/relink`, input),
}

export const productComposerDraftApi: ProductComposerDraftApi = {
  create: (input) => productApi.post('/api/product/composer-drafts', input),
  get: (draftId) => productApi.get(`/api/product/composer-drafts/${encodeURIComponent(draftId)}`),
  mutate: (draftId, action, input) => productApi.post(`/api/product/composer-drafts/${encodeURIComponent(draftId)}/${action}`, input),
}

export const productConversationLineageApi: ProductConversationLineageApi = {
  create: (input) => productApi.post('/api/product/lineages', input),
  get: (lineageId) => productApi.get(`/api/product/lineages/${encodeURIComponent(lineageId)}`),
  root: (lineageId) => productApi.get(`/api/product/lineages/${encodeURIComponent(lineageId)}/root`),
  mutate: (lineageId, action, input) => productApi.post(`/api/product/lineages/${encodeURIComponent(lineageId)}/${action}`, input),
  current: (taskId) => productApi.get(`${taskPath(taskId)}/lineage/current`),
  setCurrent: (taskId, input) => productApi.post(`${taskPath(taskId)}/lineage/current`, input),
}


export const productAttachmentApi: ProductAttachmentApi = {
  transition: (attachmentId, input) => productApi.post(`/api/product/attachments/${encodeURIComponent(attachmentId)}/transition`, input),
  bind: (attachmentId, input) => productApi.post(`/api/product/attachments/${encodeURIComponent(attachmentId)}/bind`, input),
}
