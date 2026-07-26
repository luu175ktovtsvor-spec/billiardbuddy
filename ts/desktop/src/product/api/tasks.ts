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
  ProductTaskReviewCommentMutation,
  ProductTaskReviewComments,
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
  ProductTaskQueuedInput,
  ProductTaskInputQueueMutation,
  ProductTaskInputQueueMutationResult,
} from '../domain/types'

function taskPath(taskId: string): string {
  return `/api/product/tasks/${encodeURIComponent(taskId)}`
}

function reviewPath(
  taskId: string,
  resource: 'status' | 'tree' | 'file' | 'diff' | 'comments',
  path?: string,
  revision?: string,
): string {
  const base = `${taskPath(taskId)}/review/${resource}`
  if (!path) return base
  const params = new URLSearchParams({ path })
  if (revision) params.set('revision', revision)
  return `${base}?${params.toString()}`
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
    result?:
      | { task_id: string; run_id: string; entry_id: string; dispatch_generation: number; delivery?: 'turn' }
      | { task_id: string; queue_item_id: string; entry_id: string; delivery: 'queued' }
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
  recover: (taskId: string, input: MutationEnvelope) =>
    productApi.post<ProductTaskActionResponse>(`${taskPath(taskId)}/recover`, input),
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
  getQueue: (taskId: string) => productApi.get<{ items: ProductTaskQueuedInput[] }>(`${taskPath(taskId)}/queue`),
  mutateQueue: (taskId: string, input: ProductTaskInputQueueMutation) => productApi.post<ProductTaskInputQueueMutationResult>(`${taskPath(taskId)}/queue/mutate`, input),
  steerQueue: (taskId, input) => productApi.post(`${taskPath(taskId)}/queue/steer`, input),
  resumeQueue: (taskId, input) => productApi.post(`${taskPath(taskId)}/queue/resume`, input),
  getReviewStatus: (taskId) => productApi.get<ProductTaskReviewStatus>(reviewPath(taskId, 'status')),
  getReviewTree: (taskId, path) => productApi.get<ProductTaskReviewTree>(reviewPath(taskId, 'tree', path)),
  getReviewFile: (taskId, path) => productApi.get<ProductTaskReviewFile>(reviewPath(taskId, 'file', path)),
  getReviewDiff: (taskId, path, revision) => productApi.get<ProductTaskReviewDiff>(reviewPath(taskId, 'diff', path, revision)),
  getReviewComments: (taskId, fileRef) => productApi.get<ProductTaskReviewComments>(
    reviewPath(taskId, 'comments', fileRef.path, fileRef.revision),
  ),
  createReviewComment: (taskId, input) => productApi.post<ProductTaskReviewCommentMutation>(
    reviewPath(taskId, 'comments'),
    input,
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
    client_operation_id: string
  } & ({ data: string; file?: never } | { file: File; data?: never })) => productApi.post<{
    attachment: {
      attachment_id: string
      attachment_revision: number
      authority_revision: number
      outcome: 'accepted' | 'duplicate'
    }
  }>(`/api/product/composer-drafts/${encodeURIComponent(draftId)}/attachments`, 'file' in input && input.file
    ? (() => {
        const form = new FormData()
        form.set('type', input.type)
        form.set('name', input.name)
        form.set('mime_type', input.mime_type)
        form.set('client_operation_id', input.client_operation_id)
        form.set('file', input.file, input.name)
        return form
      })()
    : input, { timeout: 120_000 }),
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
