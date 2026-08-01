import type {
  ContinueProductTaskInput,
  CreateProductSideTaskInput,
  ProductSideTask,
  ProductTask,
  ProductTaskIndex,
  UpdateProductTaskInput,
} from '../../../../shared/product/domain'
import type {
  ProductTaskAuthoritySnapshot,
  ProductTaskOperationEnvelope,
  ProductTaskOperationReceipt,
} from '../../../../shared/product/authority'
import type { ProductTaskOutcomeUnknown, ProductTaskQueuedInput, ProductTaskThread } from '../../../../shared/product/taskEvents'
import type {
  ProductTaskReviewCommentMutation,
  ProductTaskReviewComments,
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
  WorkspaceFileRef,
} from '../../../../shared/product/taskReview'
import type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskRun,
  UpdateProductScheduledTaskInput,
} from '../../../../shared/product/scheduledTasks'

export { PRODUCT_DOMAIN_VERSION } from '../../../../shared/product/domain'
export { PRODUCT_TASK_EVENT_VERSION } from '../../../../shared/product/taskEvents'
export { parseProductTaskReviewDiff } from '../../../../shared/product/taskReview'
export type {
  ContinueProductTaskInput,
  CreateProductSideTaskInput,
  ProductContinuationTarget,
  ProductProject,
  ProductProjectDirectory,
  ProductRecentProject,
  ProductRecentProjectList,
  ProductSideTask,
  ProductSideTaskStatus,
  ProductTask,
  ProductTaskIndex,
  ProductTaskKind,
  ProductTaskLifecycle,
  ProductTaskPermissionMode,
  ProductTaskScope,
  ProductTaskWorkspaceCapability,
  ProductWorkspaceAvailability,
  ProductWorktreeState,
  UpdateProductTaskInput,
} from '../../../../shared/product/domain'
export type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskActivityProgress,
  ProductTaskRunActivity,
  ProductTaskRunSnapshot,
  ProductTaskPlan,
  ProductTaskPlanStep,
  ProductTaskAttachmentSummary,
  ProductTaskActionApproval,
  ProductTaskApprovalKind,
  ProductTaskContextCompaction,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskQuestionOption,
  ProductTaskRunState,
  ProductTaskRunFailure,
  ProductTaskRunFailureCode,
  ProductTaskExternalOperationKind,
  ProductTaskOutcomeUnknown,
  ProductTaskQueuedInput,
  ProductTaskSafeErrorCode,
  ProductTaskThread,
  ProductTaskThreadEntry,
} from '../../../../shared/product/taskEvents'
export type {
  ProductTaskReviewChangedFile,
  ProductTaskReviewChangedFileStatus,
  ProductTaskReviewComment,
  ProductTaskReviewCommentMutation,
  ProductTaskReviewComments,
  ProductTaskReviewDiffLine,
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
  ProductTaskReviewTreeEntry,
  WorkspaceFileRef,
} from '../../../../shared/product/taskReview'
export type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskNotification,
  ProductScheduledTaskRun,
  ProductScheduledTaskRunStatus,
  UpdateProductScheduledTaskInput,
} from '../../../../shared/product/scheduledTasks'

export type ProductPublicWorkspace = {
  workspace_id: string
  revision: number
  availability: import('../../../../shared/product/domain').ProductWorkspaceAvailability
  created_at: string
  updated_at: string
}

export type ProductPublicOperationReceipt = {
  outcome: 'accepted' | 'replayed'
  revision: number
}

export type ProductPublicComposerDraft = {
  draft_id: string
  target_task_id: string
  workspace_id?: string
  revision: number
  state: 'active' | 'consumed' | 'expired'
  last_activity: string
  created_at: string
  expires_at: string
}

export type ProductPublicAttachment = {
  attachment_id: string
  owner_kind: 'composer_draft' | 'product_task'
  owner_id: string
  revision: number
  state: 'staged' | 'inspecting' | 'ready' | 'accepted_bound' | 'failed' | 'cancelled' | 'discarded'
  expires_at?: string
  created_at: string
  updated_at: string
}

export type ProductPublicConversationLineage = {
  lineage_id: string
  product_task_id: string
  parent_lineage_id?: string
  fork_checkpoint_id?: string
  head_entry_id?: string
  revision: number
  compact_generation: number
  state: 'active' | 'parked' | 'recovery_required'
  created_at: string
  updated_at: string
}

export type ProductWorkspaceApi = {
  register: (input: { root: string; expected_revision: number; client_operation_id: string }) => Promise<{ workspace: ProductPublicWorkspace; receipt: ProductPublicOperationReceipt }>
  inspect: (workspaceId: string) => Promise<{ workspace: ProductPublicWorkspace }>
  relocate: (workspaceId: string, input: { root: string; expected_workspace_revision: number; client_operation_id: string }) => Promise<{ workspace: ProductPublicWorkspace; receipt: ProductPublicOperationReceipt }>
  relink: (workspaceId: string, input: { root: string; expected_workspace_revision: number; client_operation_id: string }) => Promise<{ workspace: ProductPublicWorkspace; receipt: ProductPublicOperationReceipt }>
}

export type ProductComposerDraftApi = {
  create: (input: { target_task_id: string; workspace_id?: string; ttl_ms: number; client_operation_id: string }) => Promise<{ draft: ProductPublicComposerDraft; receipt: ProductPublicOperationReceipt }>
  get: (draftId: string) => Promise<{ draft: ProductPublicComposerDraft }>
  mutate: (draftId: string, action: 'update' | 'consume' | 'expire', input: { expected_draft_revision: number; client_operation_id: string }) => Promise<{ receipt: ProductPublicOperationReceipt }>
}

export type ProductAttachmentOperationResult = {
  authority_revision: number
  attachment_revision: number
  outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
}
export type ProductAttachmentApi = {
  transition: (attachmentId: string, input: { expected_revision: number; target_state: 'inspecting' | 'ready' | 'failed' | 'cancelled' | 'discarded'; client_operation_id: string; error?: string }) => Promise<ProductAttachmentOperationResult>
  bind: (attachmentId: string, input: { expected_revision: number; owner: { kind: 'composer_draft' | 'product_task'; id: string }; client_operation_id: string }) => Promise<ProductAttachmentOperationResult>
}

export type ProductConversationLineageApi = {
  create: (input: { task_id: string; expected_task_revision: number; parent_lineage_id: null; fork_checkpoint_id: null; client_operation_id: string }) => Promise<{ lineage: ProductPublicConversationLineage; receipt: ProductPublicOperationReceipt }>
  get: (lineageId: string) => Promise<{ lineage: ProductPublicConversationLineage }>
  root: (lineageId: string) => Promise<{ lineage: ProductPublicConversationLineage }>
  mutate: (lineageId: string, action: 'advance' | 'park' | 'recovery' | 'compact', input: { expected_lineage_revision: number; client_operation_id: string; head_entry_id?: string }) => Promise<{ receipt: ProductPublicOperationReceipt }>
  current: (taskId: string) => Promise<{ lineage: ProductPublicConversationLineage | null }>
  setCurrent: (taskId: string, input: { lineage_id: string; expected_task_revision: number; expected_lineage_revision: number; client_operation_id: string }) => Promise<{ receipt: ProductPublicOperationReceipt }>
}

export type ProductTaskAction =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'archive'
  | 'restore'
  | 'continue'

export type ProductTaskRecord = ProductTask & {
  actions: ProductTaskAction[]
  links?: Record<string, string>
}

/** Immutable idempotency/CAS payload created at the renderer intent boundary. */
export type MutationEnvelope<T extends object = object> = T & Required<ProductTaskOperationEnvelope>
export type OperationReceipt<T = unknown> = ProductTaskOperationReceipt<T>
/** The authority is deliberately partial; it never replaces a full index projection. */
export type AuthoritySnapshot = ProductTaskAuthoritySnapshot<ProductTask, ProductSideTask>

export type ProductTaskIndexResponse = Omit<ProductTaskIndex, 'tasks'> & {
  tasks: ProductTaskRecord[]
  capabilities: {
    createTask: boolean
  }
}

/** All authoritative mutations use this response shape. Core identities are never public. */
export type ProductTaskActionResponse = {
  receipt: OperationReceipt
  authority: AuthoritySnapshot
  task?: ProductTaskRecord
  mirror?: { state: 'pending' | 'reconciled' | 'failed'; error?: string }
}

export type ProductTaskDeletionPhase = 'begin' | 'cancel' | 'commit_purge' | 'retry'
export type ProductTaskDeletionResponse = {
  task: ProductTaskRecord
  receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected' }
  blockers: Array<{ participant: string; code: string; action: string }>
}

export type ProductTaskThreadResponse = ProductTaskThread

export type ProductTaskInputQueueMutation =
  | { action: 'edit'; queue_item_id: string; text: string; expected_task_revision: number; client_operation_id: string }
  | { action: 'delete'; queue_item_id: string; expected_task_revision: number; client_operation_id: string }
  | { action: 'reorder'; queue_item_ids: string[]; expected_task_revision: number; client_operation_id: string }

export type ProductTaskInputQueueMutationResult = {
  outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
  task_revision: number
  items: ProductTaskQueuedInput[]
}

export type ProductSideTaskListResponse = {
  sideTasks: ProductSideTask[]
}

export type ProductSideTaskActionResponse =
  | {
    receipt: OperationReceipt
    authority: AuthoritySnapshot
    /** The authority HTTP response may omit the list projection. */
    sideTask?: ProductSideTask
  }
  | { sideTask: ProductSideTask }

export type ProductTaskApi = {
  list: () => Promise<ProductTaskIndexResponse>
  update: (taskId: string, input: MutationEnvelope<UpdateProductTaskInput>) => Promise<ProductTaskActionResponse>
  bindWorkspace: (taskId: string, input: {
    workspace_id: string
    expected_task_revision: number
    expected_workspace_revision: number
    client_operation_id: string
  }) => Promise<{ receipt: {
    authority_revision: number
    entity_revisions: { task: number; workspace: number }
    outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
    error?: string
  } }>
  pin: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  unpin: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  archive: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  restore: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  recover: (taskId: string, input: MutationEnvelope<{
    confirm_outcome_unknown?: {
      run_id: ProductTaskOutcomeUnknown['runId']
      generation: ProductTaskOutcomeUnknown['generation']
      operation_id: ProductTaskOutcomeUnknown['operation']['id']
    }
  }>) => Promise<ProductTaskActionResponse>
  delete: (taskId: string, input: { phase: ProductTaskDeletionPhase; expected_revision: number; client_operation_id: string }) => Promise<ProductTaskDeletionResponse>
  continue: (taskId: string, input: MutationEnvelope<ContinueProductTaskInput>) => Promise<ProductTaskActionResponse>
  createSideTask: (taskId: string, input: MutationEnvelope<CreateProductSideTaskInput & { sideTaskId: string }>) => Promise<ProductTaskActionResponse>
  closeSideTask: (taskId: string, sideTaskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  getOperation: (taskId: string, operationId: string) => Promise<{ receipt: OperationReceipt; authority: AuthoritySnapshot }>
  getThread: (taskId: string) => Promise<ProductTaskThreadResponse>
  getQueue: (taskId: string) => Promise<{ items: ProductTaskQueuedInput[] }>
  mutateQueue: (taskId: string, input: ProductTaskInputQueueMutation) => Promise<ProductTaskInputQueueMutationResult>
  steerQueue: (taskId: string, input: { queue_item_id: string; expected_task_revision: number; client_operation_id: string }) => Promise<ProductTaskInputQueueMutationResult & { delivery: 'steer' | 'queued' }>
  resumeQueue: (taskId: string, input: { expected_task_revision: number; client_operation_id: string }) => Promise<{ outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; task_revision: number }>
  getReviewStatus: (taskId: string) => Promise<ProductTaskReviewStatus>
  getReviewTree: (taskId: string, path?: string) => Promise<ProductTaskReviewTree>
  getReviewFile: (taskId: string, path: string) => Promise<ProductTaskReviewFile>
  getReviewDiff: (taskId: string, path: string, revision?: string) => Promise<ProductTaskReviewDiff>
  getReviewComments: (taskId: string, fileRef: WorkspaceFileRef) => Promise<ProductTaskReviewComments>
  createReviewComment: (taskId: string, input: {
    file_ref: { file_id: string; path: string; revision: string }
    side: 'old' | 'new'
    line: number
    body: string
    client_operation_id: string
  }) => Promise<ProductTaskReviewCommentMutation>
}

export type ProductSideTaskApi = {
  list: (taskId: string) => Promise<ProductSideTaskListResponse>
  create: (taskId: string, input: MutationEnvelope<CreateProductSideTaskInput & { sideTaskId: string }>) => Promise<ProductSideTaskActionResponse>
  close: (taskId: string, sideTaskId: string, input: MutationEnvelope) => Promise<ProductSideTaskActionResponse>
}

export type ProductScheduledTaskListResponse = { tasks: ProductScheduledTask[] }
export type ProductScheduledTaskResponse = { task: ProductScheduledTask }
export type ProductScheduledTaskRunsResponse = { runs: ProductScheduledTaskRun[] }

export type ProductScheduledTaskApi = {
  list: () => Promise<ProductScheduledTaskListResponse>
  create: (input: CreateProductScheduledTaskInput) => Promise<ProductScheduledTaskResponse>
  update: (taskId: string, input: UpdateProductScheduledTaskInput) => Promise<ProductScheduledTaskResponse>
  delete: (taskId: string) => Promise<{ ok: true }>
  run: (taskId: string) => Promise<{ ok: true }>
  cancelRun: (taskId: string, runId: string) => Promise<{ ok: true }>
  getRecentRuns: (limit?: number) => Promise<ProductScheduledTaskRunsResponse>
  getTaskRuns: (taskId: string) => Promise<ProductScheduledTaskRunsResponse>
}
