import type {
  ProductPermissionSnapshot,
} from '../../../shared/product/domain.js'
import type {
  ProductTaskActionApproval,
  ProductTaskEvent,
  ProductTaskPlan,
  ProductTaskQuestion,
  ProductTaskRunFailure,
} from '../../../shared/product/taskEvents.js'
import type { AgentWorkerApprovalReviewFacts, AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { DurableTaskRunApproval } from './taskRunLedgerModel.js'

/**
 * The Agent runtime receives only its durable Run ledger, never the whole
 * product-task catalog.  This prevents Worker/IPC code from acquiring an
 * accidental dependency on projects, workspaces, drafts, or media state.
 */
export type ProductTaskRunIdentity = {
  task_id: string
  lineage_id: string
  resume_binding_id: string
  initial_input: string
  initial_attachments?: string[]
  permission_snapshot: ProductPermissionSnapshot
  auto_memory: {
    storage_dir: string
    enabled: boolean
    entry_id: string
  }
  session_context: {
    text: string
    event_sequence: number
    estimated_tokens: number
    compact_generation: number
  }
  harness_session: {
    storage_dir: string
    binding_id: string
    lineage_id: string
  }
}

export type ProductTaskRunCoreBinding = {
  session_id: string
  work_dir: string
  provider: string
  model: string
  model_route_fingerprint: string
  model_attempt_id: string
}

/**
 * Deliberate execution boundary between the durable Agent ledger and the
 * private Worker/Harness process. It is a first-class port rather than a
 * Pick of ProductTaskService so neither side acquires the other service's
 * catalog, workspace, attachment, or legacy-migration responsibilities.
 */
export type ProductTaskRunLedger = {
  readTaskRunDispatchIdentity(runId: string, dispatchGeneration: number): Promise<ProductTaskRunIdentity>
  resolveTaskRunCoreBinding(runId: string, dispatchGeneration: number): Promise<ProductTaskRunCoreBinding>
  inspectTaskRunQueuePosition(runId: string, dispatchGeneration: number): Promise<'ready' | 'queued'>
  claimTaskRunDispatch(runId: string, dispatchGeneration: number): Promise<{
    outcome: 'claimed' | 'duplicate' | 'queued' | 'recovery_required'
    task_id: string
  }>
  settleTaskRunDispatch(
    runId: string,
    dispatchGeneration: number,
    state: 'recovery_required' | 'terminal',
    error?: string,
    failure?: ProductTaskRunFailure,
  ): Promise<void>
  advanceTaskRunQueue(runId: string, dispatchGeneration: number): Promise<void>
  recordQueuedInputConsumed(runId: string, dispatchGeneration: number, queueItemId: string): Promise<{
    task_id: string
    events: ProductTaskEvent[]
  }>
  recordTaskRunExtensionSnapshot(
    runId: string,
    dispatchGeneration: number,
    snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number },
  ): Promise<void>
  recordTaskRunActivity(
    runId: string,
    dispatchGeneration: number,
    activity: Extract<ProductTaskEvent, { type: 'activity' }>,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'activity' }> }>
  recordTaskRunPlan(
    runId: string,
    dispatchGeneration: number,
    plan: ProductTaskPlan,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'plan_updated' }> }>
  recordTaskRunContextCompaction(
    runId: string,
    dispatchGeneration: number,
    compaction: Extract<AgentWorkerOutbound, { type: 'event'; event: 'context_compaction' }>,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'context_compaction' }> }>
  recordTaskRunTerminalProjection(
    runId: string,
    dispatchGeneration: number,
    terminalState: 'completed' | 'stopped' | 'recovery_required',
    assistantText: string,
    failure?: ProductTaskRunFailure,
  ): Promise<{ task_id: string; queue_events: ProductTaskEvent[] }>
  recordTaskRunApprovalRequest(
    runId: string,
    dispatchGeneration: number,
    requestId: string,
    action: ProductTaskActionApproval,
    review: AgentWorkerApprovalReviewFacts,
  ): Promise<{
    task_id: string
    reviewer: 'user' | 'automatic'
    event: Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'action' }>
  }>
  recordTaskRunQuestionRequest(
    runId: string,
    dispatchGeneration: number,
    requestId: string,
    questions: ProductTaskQuestion[],
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'question' }> }>
  resolveTaskRunApproval(
    taskId: string,
    requestId: string,
    allowed: boolean,
    reviewer: 'user' | 'automatic',
    resolutionReason?: DurableTaskRunApproval['resolution_reason'],
  ): Promise<boolean>
}
