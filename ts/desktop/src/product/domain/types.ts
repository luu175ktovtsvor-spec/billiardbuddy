import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  CreateProductSideTaskInput,
  ProductSideTask,
  ProductTask,
  ProductTaskIndex,
  UpdateProductTaskInput,
} from '../../../../shared/product/domain'
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
}

export type ProductTaskIndexResponse = Omit<ProductTaskIndex, 'tasks'> & {
  tasks: ProductTaskRecord[]
  capabilities: {
    createTask: boolean
  }
}

export type ProductTaskActionResponse = {
  task: ProductTaskRecord
}

export type ProductTaskThreadResponse = ProductTaskThread

export type ProductSideTaskListResponse = {
  sideTasks: ProductSideTask[]
}

export type ProductSideTaskActionResponse = {
  sideTask: ProductSideTask
}

export type ProductTaskApi = {
  list: () => Promise<ProductTaskIndexResponse>
  create: (input: CreateProductTaskInput) => Promise<ProductTaskActionResponse>
  update: (taskId: string, input: UpdateProductTaskInput) => Promise<ProductTaskActionResponse>
  pin: (taskId: string) => Promise<ProductTaskActionResponse>
  unpin: (taskId: string) => Promise<ProductTaskActionResponse>
  archive: (taskId: string) => Promise<ProductTaskActionResponse>
  restore: (taskId: string) => Promise<ProductTaskActionResponse>
  continue: (taskId: string, input: ContinueProductTaskInput) => Promise<ProductTaskActionResponse>
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
  create: (taskId: string, input: CreateProductSideTaskInput) => Promise<ProductSideTaskActionResponse>
  close: (taskId: string, sideTaskId: string) => Promise<ProductSideTaskActionResponse>
}

export type ProductScheduledTaskListResponse = {
  tasks: ProductScheduledTask[]
}

export type ProductScheduledTaskResponse = {
  task: ProductScheduledTask
}

export type ProductScheduledTaskRunsResponse = {
  runs: ProductScheduledTaskRun[]
}

export type ProductScheduledTaskApi = {
  list: () => Promise<ProductScheduledTaskListResponse>
  create: (input: CreateProductScheduledTaskInput) => Promise<ProductScheduledTaskResponse>
  update: (taskId: string, input: UpdateProductScheduledTaskInput) => Promise<ProductScheduledTaskResponse>
  delete: (taskId: string) => Promise<{ ok: true }>
  run: (taskId: string) => Promise<{ ok: true }>
  getRecentRuns: (limit?: number) => Promise<ProductScheduledTaskRunsResponse>
  getTaskRuns: (taskId: string) => Promise<ProductScheduledTaskRunsResponse>
}
