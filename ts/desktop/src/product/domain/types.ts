import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
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
import type { ProductTaskThread } from '../../../../shared/product/taskEvents'
import type {
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
} from '../../../../shared/product/taskReview'
import type {
  ProductTaskMediaAttachableList,
  ProductTaskMediaList,
  ProductTaskMediaProject,
} from '../../../../shared/product/taskMedia'
import type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskRun,
  UpdateProductScheduledTaskInput,
} from '../../../../shared/product/scheduledTasks'

export { PRODUCT_DOMAIN_VERSION } from '../../../../shared/product/domain'
export { PRODUCT_TASK_EVENT_VERSION } from '../../../../shared/product/taskEvents'
export type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
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
  ProductWorktreeState,
  UpdateProductTaskInput,
} from '../../../../shared/product/domain'
export type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskActivityProgress,
  ProductTaskRunActivity,
  ProductTaskRunSnapshot,
  ProductTaskAttachmentSummary,
  ProductTaskMediaDraft,
  ProductTaskApprovalKind,
  ProductTaskComputerUseApp,
  ProductTaskComputerUseApproval,
  ProductTaskComputerUseCapability,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskQuestionOption,
  ProductTaskRunState,
  ProductTaskSafeErrorCode,
  ProductTaskThread,
  ProductTaskThreadEntry,
} from '../../../../shared/product/taskEvents'
export type {
  ProductTaskReviewChangedFile,
  ProductTaskReviewChangedFileStatus,
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
  ProductTaskReviewTreeEntry,
} from '../../../../shared/product/taskReview'
export type {
  ProductTaskMediaAsset,
  ProductTaskMediaAttachableList,
  ProductTaskMediaAttachableProject,
  ProductTaskMediaList,
  ProductTaskMediaProject,
  ProductTaskMediaTask,
} from '../../../../shared/product/taskMedia'
export type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskNotification,
  ProductScheduledTaskRun,
  ProductScheduledTaskRunStatus,
  UpdateProductScheduledTaskInput,
} from '../../../../shared/product/scheduledTasks'

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

export type ProductTaskThreadResponse = ProductTaskThread

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
  create: (input: MutationEnvelope<CreateProductTaskInput>) => Promise<ProductTaskActionResponse>
  update: (taskId: string, input: MutationEnvelope<UpdateProductTaskInput>) => Promise<ProductTaskActionResponse>
  pin: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  unpin: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  archive: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  restore: (taskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  continue: (taskId: string, input: MutationEnvelope<ContinueProductTaskInput>) => Promise<ProductTaskActionResponse>
  createSideTask: (taskId: string, input: MutationEnvelope<CreateProductSideTaskInput & { sideTaskId: string }>) => Promise<ProductTaskActionResponse>
  closeSideTask: (taskId: string, sideTaskId: string, input: MutationEnvelope) => Promise<ProductTaskActionResponse>
  getOperation: (taskId: string, operationId: string) => Promise<{ receipt: OperationReceipt; authority: AuthoritySnapshot }>
  getThread: (taskId: string) => Promise<ProductTaskThreadResponse>
  getReviewStatus: (taskId: string) => Promise<ProductTaskReviewStatus>
  getReviewTree: (taskId: string, path?: string) => Promise<ProductTaskReviewTree>
  getReviewFile: (taskId: string, path: string) => Promise<ProductTaskReviewFile>
  getReviewDiff: (taskId: string, path: string) => Promise<ProductTaskReviewDiff>
  getMedia: (taskId: string) => Promise<ProductTaskMediaList>
  getAttachableMedia: (taskId: string) => Promise<ProductTaskMediaAttachableList>
  attachMediaProject: (taskId: string, projectId: string) => Promise<{ project: ProductTaskMediaProject }>
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
  getRecentRuns: (limit?: number) => Promise<ProductScheduledTaskRunsResponse>
  getTaskRuns: (taskId: string) => Promise<ProductScheduledTaskRunsResponse>
}
