import { createHash } from 'node:crypto'
import type { AgentWorkerApprovalReviewFacts } from '../../../shared/product/agentWorker.js'
import type {
  ProductTaskActionApproval,
  ProductTaskExternalOperationKind,
  ProductTaskEvent,
  ProductTaskQueuedInput,
  ProductTaskQuestion,
  ProductTaskRunFailure,
  TaskEvent,
} from '../../../shared/product/taskEvents.js'
import { PRODUCT_TASK_EXTERNAL_OPERATION_KINDS } from '../../../shared/product/taskEvents.js'
import type { AuthorityFile } from './authorityRepository.js'

export type DurableTaskRunApproval = {
  request_id: string
  action: ProductTaskActionApproval
  review?: AgentWorkerApprovalReviewFacts
  questions?: ProductTaskQuestion[]
  answers?: string[]
  status: 'pending' | 'resolved'
  requested_at: string
  decision?: 'allowed' | 'denied'
  reviewer?: 'user' | 'automatic'
  resolution_reason?: 'user_decision' | 'read_only_local' | 'destructive' | 'data_egress' | 'write_boundary' | 'unknown_capability'
  resolved_at?: string
}

export type DurableTaskRun = {
  run_id?: unknown
  task_id?: unknown
  created_at?: unknown
  event_contract?: unknown
  /** A private child Run is not part of the user's serial input queue. */
  parent_run_id?: unknown
}
/**
 * A durable fence written before a Worker is stopped or its scheduler lease is
 * released.  It never claims that the final model output was saved; on a
 * restart it deliberately resolves to recovery_required unless a terminal
 * projection has already committed.
 */
export type DurableTaskRunRecoveryFence = {
  failure: ProductTaskRunFailure
  created_at: string
}
/**
 * A private capability issued by the authority ledger to exactly one local
 * supervisor. Scheduler receipts decide resource ownership; this token binds
 * durable task mutations to the supervisor that successfully claimed the run.
 */
export type DurableTaskRunExecutionClaim = {
  claim_token: string
  claimed_at: string
}

/**
 * One effect that may have changed a system outside the TaskRun ledger.  The
 * ledger permits only one such effect at a time: a Worker must persist the
 * start before it crosses the process/network/workspace boundary, then clear
 * it only after it has a definite result.  A crashed in-flight effect is never
 * replayed automatically.
 */
export const TASK_RUN_EXTERNAL_OPERATION_KINDS = PRODUCT_TASK_EXTERNAL_OPERATION_KINDS

export type TaskRunExternalOperationKind = ProductTaskExternalOperationKind

export type DurableTaskRunExternalOperation = {
  operation_id: string
  kind: TaskRunExternalOperationKind
  /** Result reception is not a checkpoint: it remains non-replayable. */
  state: 'in_flight' | 'result_obtained' | 'outcome_unknown'
  started_at: string
  result_obtained_at?: string
}

/**
 * A small authority-side audit proving that the matching operation id was
 * present in a successfully written Harness Session or a formal Run snapshot.
 * The effect payload stays in its owning private store, never in the ledger.
 */
export type DurableTaskRunExternalOperationCheckpoint = {
  operation_id: string
  kind: TaskRunExternalOperationKind
  checkpoint_digest: string
  checkpointed_at: string
}

export type DurableTaskRunDispatch = {
  dispatch_generation?: unknown
  state?: unknown
  completed_at?: unknown
  error?: unknown
  /** A user stop is durable even before a Worker has obtained a lease. */
  stop_requested_at?: string
  execution_claim?: DurableTaskRunExecutionClaim
  recovery_fence?: DurableTaskRunRecoveryFence
  /**
   * Effects are serial while in flight, but several definite results may wait
   * for the same next durable Harness snapshot (for example sequential Hooks).
   */
  external_operations?: DurableTaskRunExternalOperation[]
  external_operation_checkpoints?: DurableTaskRunExternalOperationCheckpoint[]
  outcome_unknown_at?: string
}
export type DurableContextSnapshot = {
  lineage_id: string
  task_id: string
  generation: number
  summary: string
  compacted_through_event_sequence: number
  source: 'automatic' | 'manual'
  input_tokens: number
  output_tokens: number
  created_at: string
}
export type DurableSessionContext = {
  text: string
  event_sequence: number
  estimated_tokens: number
  compact_generation: number
}
export type DurableTurnInput = {
  queue_item_id: string
  queue_sequence: number
  entry_id: string
  task_id: string
  lineage_id: string
  text: string
  attachment_ids: string[]
  reference_entry_ids?: string[]
  state: 'queued' | 'injected' | 'promoted' | 'failed'
  created_at: string
  updated_at: string
  target_run_id?: string
  dispatch_generation?: number
}

export const MAX_TASK_RUN_QUEUE_DEPTH = 8
export const MAX_DURABLE_ASSISTANT_TEXT_LENGTH = 100_000

export function durableAssistantItemId(runId: string, dispatchGeneration: number): string {
  return `thread_${createHash('sha256').update(`${runId}:${dispatchGeneration}:assistant`).digest('hex').slice(0, 20)}`
}

export function durableUserItemId(runId: string): string {
  return `thread_${createHash('sha256').update(`${runId}:user`).digest('hex').slice(0, 20)}`
}

export function durableTerminalItemId(runId: string, dispatchGeneration: number): string {
  return `turn_${createHash('sha256').update(`${runId}:${dispatchGeneration}:terminal`).digest('hex').slice(0, 32)}`
}

export function durableContextCompactionItemId(runId: string, dispatchGeneration: number, compactGeneration: number): string {
  return `compact_${createHash('sha256').update(`${runId}:${dispatchGeneration}:${compactGeneration}:context-compaction`).digest('hex').slice(0, 32)}`
}

export function durableApprovalItemId(runId: string, dispatchGeneration: number, requestId: string): string {
  return `approval_${createHash('sha256').update(`${runId}:${dispatchGeneration}:${requestId}`).digest('hex').slice(0, 32)}`
}

/**
 * The same stable activity identity is used by the Engine Tool bridge and the
 * product collaboration projection.  A child activity can therefore nest
 * under the exact parent tool call without exposing that call's arguments.
 */
export function productRunToolActivityItemId(runId: string, toolCallId: string): string {
  return `activity_${createHash('sha256').update(`${runId}:${toolCallId}`).digest('hex').slice(0, 32)}`
}

/** One product-owned child-Run lifecycle row beneath its delegating tool. */
export function durableSubtaskActivityItemId(parentRunId: string, parentToolCallId: string): string {
  return `activity_${createHash('sha256').update(`${parentRunId}:${parentToolCallId}:subtask`).digest('hex').slice(0, 32)}`
}

export function legacyAuthorityId(prefix: 'lineage' | 'run' | 'entry', taskId: string): string {
  return `${prefix}_${createHash('sha256').update(`legacy-authority:${taskId}:${prefix}`).digest('hex').slice(0, 32)}`
}

export function legacyActivityItemId(runId: string, entryId: string): string {
  return `activity_${createHash('sha256').update(`${runId}:${entryId}:legacy-activity`).digest('hex').slice(0, 32)}`
}

export function taskRunContextCursor(state: AuthorityFile, runId: string, run: Record<string, unknown>): number {
  const binding = run.core_binding as { context_event_sequence?: unknown } | undefined
  if (Number.isSafeInteger(binding?.context_event_sequence) && (binding!.context_event_sequence as number) >= 0) return binding!.context_event_sequence as number
  const firstInput = Object.values(state.task_events)
    .map(value => value as TaskEvent)
    .filter((event): event is Extract<TaskEvent, { type: 'user_text' }> => event.type === 'user_text' && event.run_id === runId)
    .sort((left, right) => left.event_sequence - right.event_sequence)[0]
  if (!firstInput) throw new Error('AUTHORITY_INVALID')
  return firstInput.event_sequence - 1
}

export function renderDurableSessionContext(state: AuthorityFile, runId: string, run: Record<string, unknown>): DurableSessionContext {
  if (typeof run.task_id !== 'string' || typeof run.lineage_id !== 'string') throw new Error('AUTHORITY_INVALID')
  const cursor = taskRunContextCursor(state, runId, run)
  const chain: Array<{ lineage_id: string; limit: number }> = []
  let lineageId = run.lineage_id
  let limit = cursor
  const seen = new Set<string>()
  while (true) {
    if (seen.has(lineageId)) throw new Error('AUTHORITY_INVALID')
    seen.add(lineageId)
    const lineage = state.conversation_lineages[lineageId] as Record<string, unknown> | undefined
    if (!lineage || lineage.product_task_id !== run.task_id) throw new Error('AUTHORITY_INVALID')
    chain.unshift({ lineage_id: lineageId, limit })
    if (typeof lineage.parent_lineage_id !== 'string') break
    if (typeof lineage.fork_checkpoint_id !== 'string') throw new Error('AUTHORITY_INVALID')
    const checkpoint = Object.values(state.task_events)
      .map(value => value as TaskEvent)
      .find((event): event is Extract<TaskEvent, { type: 'user_text' }> => event.type === 'user_text' && event.task_id === run.task_id && event.entry_id === lineage.fork_checkpoint_id)
    if (!checkpoint) throw new Error('AUTHORITY_INVALID')
    // A child stores the product event cursor that existed when it forked.
    // Do not let a later parent result leak into its frozen context merely
    // because this snapshot is rendered after the parent has continued.
    limit = Object.values(state.task_events)
      .map(value => value as TaskEvent)
      .filter(event => 'run_id' in event && event.run_id === checkpoint.run_id && event.event_sequence <= limit)
      .reduce((latest, event) => Math.max(latest, event.event_sequence), checkpoint.event_sequence)
    lineageId = lineage.parent_lineage_id
  }

  const runLineages = new Map<string, string>()
  for (const [candidateRunId, value] of Object.entries(state.task_runs)) {
    const candidate = value as { task_id?: unknown; lineage_id?: unknown }
    if (candidate.task_id === run.task_id && typeof candidate.lineage_id === 'string') runLineages.set(candidateRunId, candidate.lineage_id)
  }

  let snapshot: DurableContextSnapshot | undefined
  let snapshotIndex = -1
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = state.context_snapshots[chain[index]!.lineage_id] as DurableContextSnapshot | undefined
    if (candidate && candidate.task_id === run.task_id && candidate.compacted_through_event_sequence <= chain[index]!.limit) {
      snapshot = candidate
      snapshotIndex = index
      break
    }
  }

  const sections: string[] = []
  if (snapshot) sections.push(`<context_summary generation="${snapshot.generation}">\n${snapshot.summary}\n</context_summary>`)
  const events = Object.values(state.task_events)
    .map(value => value as TaskEvent)
    .filter(event => event.task_id === run.task_id && event.event_sequence <= cursor)
    .sort((left, right) => left.event_sequence - right.event_sequence)
  for (let index = Math.max(0, snapshotIndex); index < chain.length; index += 1) {
    const segment = chain[index]!
    const floor = index === snapshotIndex && snapshot ? snapshot.compacted_through_event_sequence : 0
    for (const event of events) {
      if (event.event_sequence <= floor || event.event_sequence > segment.limit || !('run_id' in event) || runLineages.get(event.run_id) !== segment.lineage_id) continue
      if (event.type === 'user_text') sections.push(`<user>\n${event.text}\n</user>`)
      else if (event.type === 'assistant_text') sections.push(`<assistant>\n${event.text}\n</assistant>`)
    }
  }
  const text = sections.join('\n\n')
  if (text.length > 512_000) throw new Error('CONTEXT_TOO_LARGE')
  const currentLineage = state.conversation_lineages[run.lineage_id] as { compact_generation?: unknown }
  if (!Number.isSafeInteger(currentLineage.compact_generation) || (currentLineage.compact_generation as number) < 0) throw new Error('AUTHORITY_INVALID')
  return { text, event_sequence: cursor, estimated_tokens: Math.max(0, Math.ceil(text.length / 4)), compact_generation: currentLineage.compact_generation as number }
}

export function orderedTaskRunIds(state: AuthorityFile, taskId: string): string[] {
  const sequence = new Map<string, number>()
  for (const value of Object.values(state.task_events)) {
    const event = value as { task_id?: unknown; run_id?: unknown; event_sequence?: unknown }
    if (event.task_id === taskId && typeof event.run_id === 'string' && typeof event.event_sequence === 'number') sequence.set(event.run_id, event.event_sequence)
  }
  return Object.values(state.task_runs)
    .map(value => value as DurableTaskRun)
    // Child Runs have their own scheduler reservation and are awaited through
    // their parent tool effect. They must not block, or be queued behind, the
    // user-facing conversation Run that created them.
    .filter(run => run.task_id === taskId && typeof run.run_id === 'string' && run.parent_run_id === undefined)
    .sort((left, right) => (sequence.get(left.run_id as string) ?? Number.MAX_SAFE_INTEGER) - (sequence.get(right.run_id as string) ?? Number.MAX_SAFE_INTEGER)
      || Date.parse(left.created_at as string) - Date.parse(right.created_at as string)
      || (left.run_id as string).localeCompare(right.run_id as string))
    .map(run => run.run_id as string)
}

export function nextTaskRunId(state: AuthorityFile, taskId: string): string | undefined {
  for (const runId of orderedTaskRunIds(state, taskId)) {
    const status = (state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state
    if (status === 'terminal') continue
    return status === 'pending' ? runId : undefined
  }
}

export function recoveryRequiredTaskRunId(state: AuthorityFile, taskId: string): string | undefined {
  for (const runId of orderedTaskRunIds(state, taskId)) {
    const status = (state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state
    if (status === 'terminal') continue
    return status === 'recovery_required' ? runId : undefined
  }
}

/** A separate state from recoverable failure: replay needs explicit consent. */
export function outcomeUnknownTaskRunId(state: AuthorityFile, taskId: string): string | undefined {
  for (const runId of orderedTaskRunIds(state, taskId)) {
    const status = (state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state
    if (status === 'terminal') continue
    return status === 'outcome_unknown' ? runId : undefined
  }
}

export function hasUnsettledTaskQueue(state: AuthorityFile, taskId: string): boolean {
  return orderedTaskRunIds(state, taskId).some(runId => ['pending', 'claimed', 'started', 'recovery_required', 'outcome_unknown'].includes((state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state as string))
}

export function hasBlockingTaskWork(state: AuthorityFile, taskId: string): boolean {
  return hasUnsettledTaskQueue(state, taskId) || orderedQueuedInputs(state, taskId).length > 0
}

export function hasQueuedTaskWork(state: AuthorityFile, taskId: string): boolean {
  return orderedTaskRunIds(state, taskId).some((runId) => {
    const status = (state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state
    return status === 'pending' || status === 'recovery_required' || status === 'outcome_unknown'
  }) || orderedQueuedInputs(state, taskId).length > 0
}

export function activeTaskRun(state: AuthorityFile, taskId: string): { run_id: string; dispatch_generation: number } | undefined {
  for (const runId of orderedTaskRunIds(state, taskId)) {
    const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
    if ((dispatch?.state === 'claimed' || dispatch?.state === 'started') && Number.isSafeInteger(dispatch.dispatch_generation)) return { run_id: runId, dispatch_generation: dispatch.dispatch_generation as number }
  }
}

export function orderedQueuedInputs(state: AuthorityFile, taskId: string): DurableTurnInput[] {
  return Object.values(state.turn_input_queue)
    .map(value => value as DurableTurnInput)
    .filter(item => item.task_id === taskId && item.state === 'queued')
    .sort((left, right) => left.queue_sequence - right.queue_sequence)
}

export function publicQueuedInput(item: DurableTurnInput): ProductTaskQueuedInput {
  return { id: item.queue_item_id, text: item.text, state: item.state, createdAt: item.created_at, attachmentCount: item.attachment_ids.length, ...(item.target_run_id ? { targetRunId: item.target_run_id } : {}) }
}

export function publicQueuedInputs(state: AuthorityFile, taskId: string): ProductTaskQueuedInput[] {
  return Object.values(state.turn_input_queue)
    .map(value => value as DurableTurnInput)
    .filter(item => item.task_id === taskId && (item.state === 'queued' || item.state === 'failed'))
    .sort((left, right) => left.queue_sequence - right.queue_sequence)
    .map(publicQueuedInput)
}

export function appendQueuedInputEvent(state: AuthorityFile, item: DurableTurnInput, phase: Extract<TaskEvent, { type: 'queue_updated' }>['phase']): Extract<ProductTaskEvent, { type: 'queue_updated' }> {
  state.event_sequence += 1
  const targetRunId = item.target_run_id
  state.task_events[String(state.event_sequence)] = {
    event_sequence: state.event_sequence, task_id: item.task_id, type: 'queue_updated', queue_item_id: item.queue_item_id, entry_id: item.entry_id,
    phase, text: item.text, attachment_count: item.attachment_ids.length, ...(targetRunId ? { target_run_id: targetRunId } : {}), created_at: item.created_at,
  }
  return {
    type: 'queue_updated',
    item: { id: item.queue_item_id, text: item.text, state: phase, createdAt: item.created_at, attachmentCount: item.attachment_ids.length, ...(targetRunId ? { targetRunId } : {}) },
    event_sequence: state.event_sequence,
  }
}

export function releaseQueuedInputTargets(state: AuthorityFile, runId: string, dispatchGeneration: number, now: string): ProductTaskEvent[] {
  const events: ProductTaskEvent[] = []
  for (const value of Object.values(state.turn_input_queue)) {
    const item = value as DurableTurnInput
    if (item.state !== 'queued' || item.target_run_id !== runId || item.dispatch_generation !== dispatchGeneration) continue
    delete item.target_run_id
    delete item.dispatch_generation
    item.updated_at = now
    events.push(appendQueuedInputEvent(state, item, 'queued'))
  }
  return events
}

export function taskRunQueueDepth(state: AuthorityFile, taskId: string): number {
  return orderedTaskRunIds(state, taskId).filter(runId => ['pending', 'claimed', 'started', 'recovery_required', 'outcome_unknown'].includes((state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state as string)).length + orderedQueuedInputs(state, taskId).length
}
