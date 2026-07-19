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

export { PRODUCT_DOMAIN_VERSION } from '../../../../shared/product/domain'
export { PRODUCT_TASK_EVENT_VERSION } from '../../../../shared/product/taskEvents'
export type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  CreateProductSideTaskInput,
  ProductContinuationTarget,
  ProductProject,
  ProductSideTask,
  ProductSideTaskStatus,
  ProductTask,
  ProductTaskIndex,
  ProductTaskKind,
  ProductTaskLifecycle,
  ProductWorktreeState,
  UpdateProductTaskInput,
} from '../../../../shared/product/domain'
export type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskApprovalKind,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskQuestionOption,
  ProductTaskRunState,
  ProductTaskSafeErrorCode,
  ProductTaskThread,
  ProductTaskThreadEntry,
} from '../../../../shared/product/taskEvents'

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
}

export type ProductSideTaskApi = {
  list: (taskId: string) => Promise<ProductSideTaskListResponse>
  create: (taskId: string, input: CreateProductSideTaskInput) => Promise<ProductSideTaskActionResponse>
  close: (taskId: string, sideTaskId: string) => Promise<ProductSideTaskActionResponse>
}
