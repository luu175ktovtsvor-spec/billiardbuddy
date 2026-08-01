import type { ProductTaskService } from './taskService.js'

/**
 * The Agent runtime receives only its durable Run ledger, never the whole
 * product-task catalog.  This prevents Worker/IPC code from acquiring an
 * accidental dependency on projects, workspaces, drafts, or media state.
 */
export type ProductTaskRunLedger = Pick<
  ProductTaskService,
  | 'readTaskRunDispatchIdentity'
  | 'resolveTaskRunCoreBinding'
  | 'inspectTaskRunQueuePosition'
  | 'claimTaskRunDispatch'
  | 'settleTaskRunDispatch'
  | 'advanceTaskRunQueue'
  | 'recordQueuedInputConsumed'
  | 'recordTaskRunExtensionSnapshot'
  | 'recordTaskRunActivity'
  | 'recordTaskRunPlan'
  | 'recordTaskRunContextCompaction'
  | 'recordTaskRunTerminalProjection'
  | 'recordTaskRunApprovalRequest'
  | 'recordTaskRunQuestionRequest'
  | 'resolveTaskRunApproval'
>
