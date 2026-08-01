import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sessionAdmissionBarrier, type SessionAdmissionBarrier } from './sessionAdmissionBarrier.js'
import {
  PRODUCT_DOMAIN_VERSION,
  PRODUCT_TASK_PERMISSION_MODES,
  isProductPermissionSnapshot,
  productPermissionSnapshot,
  type ContinueProductTaskInput,
  type CreateProductSideTaskInput,
  type ProductProject,
  type ProductProjectDirectory,
  type ProductRecentProject,
  type ProductRecentProjectList,
  type ProductSideTask,
  type ProductTask,
  type ProductTaskIndex,
  type ProductTaskPermissionMode,
  type ProductPermissionSnapshot,
  type ProductTaskScope,
  type ProductWorkspace,
  type ProductWorkspaceAvailability,
  type SubmitTaskRunInput,
  type SubmitTaskRunReceipt,
} from '../../../shared/product/domain.js'
import type { ProductTaskActionApproval, ProductTaskAttachmentSummary, ProductTaskEvent, ProductTaskExternalOperationKind, ProductTaskOutcomeUnknown, ProductTaskPlan, ProductTaskQuestion, ProductTaskQueuedInput, ProductTaskRunFailure, ProductTaskThread, ProductTaskThreadEntry, TaskEvent } from '../../../shared/product/taskEvents.js'
import { isProductTaskRunFailureCode, productTaskRunFailure } from './taskRunFailure.js'
import { assertAuthorityMapKey } from '../../../shared/product/authority.js'
import type {
  ProductTaskReviewComment,
  ProductTaskReviewCommentMutation,
  WorkspaceFileRef,
} from '../../../shared/product/taskReview.js'
import type { AgentWorkerApprovalReviewFacts, AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  projectLegacyCoreThreadItems,
} from './taskThreadProjection.js'
import { findProductCanonicalGitRoot, findProductGitRoot } from './productGit.js'
import {
  isRecord,
  legacyProductTaskId,
  readStrictLegacyProductTasks,
} from './legacyProductTaskReader.js'
import {
  type ProductProjectDirectoryMetadata,
  type ProductProjectMetadata,
  type ProductSideTaskMetadata,
} from './taskLegacyStore.js'
export type {
  ProductProjectDirectoryMetadata,
  ProductProjectMetadata,
  ProductSideTaskMetadata,
  ProductTaskMetadata,
  ProductTaskStore,
} from './taskLegacyStore.js'
import {
  ProductTaskLegacyRegistry,
  agentCoreAdapter,
  type AgentCoreAdapter,
} from './taskLegacyRegistry.js'
export {
  agentCoreAdapter,
  type AgentCoreAdapter,
  type AgentCoreSession,
} from './taskLegacyRegistry.js'
import { ProductTaskAuthorityRepository, readLegacyProductTasks, type AuthorityFile, type ProductTaskAuthorityRepositoryDeps } from './authorityRepository.js'
import {
  ProductCoreOperationTerminalError,
  type ProductCoreOperationBridge,
} from './productCoreOperationBridge.js'
import { codexEnginePrivateState } from '../agent-engine/codexEnginePrivateState.js'
import { productTaskActivitySummary } from './taskEventProjection.js'
import {
  MAX_DURABLE_ASSISTANT_TEXT_LENGTH,
  MAX_TASK_RUN_QUEUE_DEPTH,
  TASK_RUN_EXTERNAL_OPERATION_KINDS,
  activeTaskRun,
  appendQueuedInputEvent,
  durableApprovalItemId,
  durableAssistantItemId,
  durableContextCompactionItemId,
  durableSubtaskActivityItemId,
  durableTerminalItemId,
  durableUserItemId,
  hasBlockingTaskWork,
  hasQueuedTaskWork,
  hasUnsettledTaskQueue,
  legacyActivityItemId,
  legacyAuthorityId,
  nextTaskRunId,
  orderedQueuedInputs,
  orderedTaskRunIds,
  productRunToolActivityItemId,
  outcomeUnknownTaskRunId,
  publicQueuedInput,
  publicQueuedInputs,
  recoveryRequiredTaskRunId,
  releaseQueuedInputTargets,
  renderDurableSessionContext,
  taskRunQueueDepth,
  type DurableSessionContext,
  type DurableContextSnapshot,
  type DurableTaskRun,
  type DurableTaskRunApproval,
  type DurableTaskRunDispatch,
  type DurableTaskRunExternalOperation,
  type DurableTaskRunExternalOperationCheckpoint,
  type DurableTurnInput,
  type TaskRunExternalOperationKind,
  taskRunContextCursor,
} from './taskRunLedgerModel.js'
import { productTextReasoningBinding } from './productGatewayRuntime.js'
import { productTaskPrivateArtifactPort, type ProductTaskPrivateArtifactPort } from './taskPrivateArtifactPort.js'
import type { ProductTaskRunDispatchPort } from './taskRunDispatchPort.js'
import { createProductTaskRuntimeEventPort, type ProductTaskRuntimeEventPort } from './taskRuntimeEventPort.js'
import { ProductTaskWorkerRuntimeEvents } from './taskWorkerRuntimeEvents.js'
import {
  productAttachmentStorageRoot,
  productAttachmentSummary,
  purgeProductAttachmentCopies,
  resolveProductAttachmentCopy,
  storeProductAttachmentCopy,
  verifyProductAttachmentBytes,
  verifyProductAttachmentInput,
} from './taskAttachmentIngest.js'

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

export type ProductTaskInputQueueMutation =
  | { action: 'edit'; queue_item_id: string; text: string; expected_task_revision: number; client_operation_id: string }
  | { action: 'delete'; queue_item_id: string; expected_task_revision: number; client_operation_id: string }
  | { action: 'reorder'; queue_item_ids: string[]; expected_task_revision: number; client_operation_id: string }

export type ProductTaskInputQueueMutationResult = {
  outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
  task_revision: number
  items: ProductTaskQueuedInput[]
}

export type TaskLifecycleBlocker = {
  participant: string
  code: 'ACTIVE_RUN' | 'QUEUE' | 'SCHEDULE' | 'RECRUITING' | 'FORK' | 'WORKTREE' | 'BLOCKER_UNKNOWN' | 'BLOCKER_UNAVAILABLE'
  action: 'stop' | 'detach' | 'disable' | 'resolve'
}

export type TaskLifecycleParticipant = {
  id: string
  inspectBlockers: (taskId: string, revision: number) => Promise<TaskLifecycleBlocker[]>
  prepareCleanup?: (taskId: string, revision: number, fencingToken: string) => Promise<void>
  cancelCleanup?: (taskId: string, revision: number, fencingToken: string) => Promise<void>
  purgeCleanup?: (taskId: string, revision: number, fencingToken: string) => Promise<void>
}

export type ProductTaskIndexResponse = Omit<ProductTaskIndex, 'tasks'> & {
  tasks: ProductTaskRecord[]
  capabilities: {
    createTask: boolean
  }
}

const DEFAULT_PRODUCT_GIT_INFO_COMMAND_TIMEOUT_MS = 3_000
const MAX_RECENT_PRODUCT_PROJECTS = 500

export type WorkspaceFilesystemPort = {
  inspect(root: string): Promise<{ canonical_root: string; identity: { platform: string; volume_id: string; file_id: string }; availability: ProductWorkspaceAvailability }>
}

const workspaceFilesystem: WorkspaceFilesystemPort = {
  async inspect(root) {
    try {
      const canonical_root = await fs.realpath(root)
      const stat = await fs.stat(canonical_root)
      if (!stat.isDirectory()) throw new Error('not-directory')
      const writable = await fs.access(canonical_root, fsConstants.W_OK).then(() => true).catch(() => false)
      return { canonical_root, identity: { platform: process.platform, volume_id: String(stat.dev), file_id: String(stat.ino) }, availability: writable ? 'available' : 'read_only' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { canonical_root: path.resolve(root), identity: { platform: process.platform, volume_id: 'missing', file_id: 'missing' }, availability: 'missing' }
      throw error
    }
  },
}

export type WorkspaceBindBlockerCode = 'ACTIVE_RUN' | 'QUEUE' | 'PTY' | 'PREVIEW' | 'WORKSPACE_WRITE' | 'BLOCKER_UNKNOWN' | 'BLOCKER_UNAVAILABLE'
export type WorkspaceBindParticipantReceipt =
  | { participant: 'active_core_run'; status: 'CLEAR' | 'BLOCKED'; code?: 'ACTIVE_RUN' }
  | { participant: 'queue'; status: 'CLEAR' | 'BLOCKED'; code?: 'QUEUE' }
  | { participant: 'queue' | 'pty' | 'preview' | 'workspace_write'; status: 'OUT_OF_SCOPE_DISABLED'; owner_module: 'BB-02C' }
export type WorkspaceBindBlockerPort = {
  inspect(taskId: string, taskRevision: number, workspaceId: string): Promise<{ receipts: WorkspaceBindParticipantReceipt[] }>
}
function defaultParticipantReceipts(active: boolean, queued = false): WorkspaceBindParticipantReceipt[] {
  return [
    active ? { participant: 'active_core_run', status: 'BLOCKED', code: 'ACTIVE_RUN' } : { participant: 'active_core_run', status: 'CLEAR' },
    queued ? { participant: 'queue', status: 'BLOCKED', code: 'QUEUE' } : { participant: 'queue', status: 'CLEAR' },
    { participant: 'pty', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' },
    { participant: 'preview', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' },
    { participant: 'workspace_write', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' },
  ]
}

export type VerifiedAttachmentMetadata = { source_fingerprint: string; content_hash: string; verified_media_type: string; storage_kind: 'external_reference' | 'app_owned_copy'; byte_size: number }
export type ProductTaskRunRecoveryLeaseInspector = {
  hasLiveTaskRunLease(runId: string, dispatchGeneration: number): Promise<boolean>
}

const MAX_TASK_ATTACHMENT_TOTAL_BYTES = 64 * 1024 * 1024

function isExecutionClaimToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
}

function isTaskRunExternalOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^effect_[a-f0-9-]{36}$/.test(value)
}

function isTaskRunExternalOperationKind(value: unknown): value is TaskRunExternalOperationKind {
  return typeof value === 'string' && (TASK_RUN_EXTERNAL_OPERATION_KINDS as readonly string[]).includes(value)
}

function executionClaimMatches(
  dispatch: { execution_claim?: unknown },
  token: string | undefined,
): boolean {
  const claim = dispatch.execution_claim
  return Boolean(
    isExecutionClaimToken(token)
    && isRecord(claim)
    && typeof claim.claim_token === 'string'
    && claim.claim_token === token,
  )
}

/** Normal Worker events stop the instant a stop/recovery intent is durable. */
function executionClaimAllowsWorkerMutation(
  dispatch: { execution_claim?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown },
  token: string,
): boolean {
  return dispatch.recovery_fence === undefined
    && dispatch.stop_requested_at === undefined
    && executionClaimMatches(dispatch, token)
}

function liveExternalOperations(dispatch: { external_operations?: unknown }): DurableTaskRunExternalOperation[] {
  return Array.isArray(dispatch.external_operations)
    ? dispatch.external_operations as DurableTaskRunExternalOperation[]
    : []
}

function externalOperationForId(
  dispatch: { external_operations?: unknown },
  operationId: string,
): DurableTaskRunExternalOperation | undefined {
  return isTaskRunExternalOperationId(operationId)
    ? liveExternalOperations(dispatch).find(operation => operation.operation_id === operationId)
    : undefined
}

function externalOperationCheckpointForId(
  dispatch: { external_operation_checkpoints?: unknown },
  operationId: string,
): DurableTaskRunExternalOperationCheckpoint | undefined {
  const checkpoints = Array.isArray(dispatch.external_operation_checkpoints)
    ? dispatch.external_operation_checkpoints as DurableTaskRunExternalOperationCheckpoint[]
    : []
  return isTaskRunExternalOperationId(operationId)
    ? checkpoints.find(checkpoint => checkpoint.operation_id === operationId)
    : undefined
}

function publicOutcomeUnknown(
  runId: string,
  generation: number,
  operation: DurableTaskRunExternalOperation,
): ProductTaskOutcomeUnknown {
  return {
    runId,
    generation,
    operation: {
      id: operation.operation_id,
      kind: operation.kind,
      startedAt: operation.started_at,
    },
  }
}

function primaryUnknownExternalOperation(dispatch: { external_operations?: unknown }): DurableTaskRunExternalOperation | undefined {
  return liveExternalOperations(dispatch)
    .filter(operation => operation.state === 'outcome_unknown')
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at) || right.operation_id.localeCompare(left.operation_id))[0]
}

function durableOutcomeUnknownEvent(
  state: AuthorityFile,
  taskId: string,
  runId: string,
  generation: number,
  operation: DurableTaskRunExternalOperation,
  now: string,
): Extract<ProductTaskEvent, { type: 'outcome_unknown' }> {
  const existing = Object.values(state.task_events)
    .map(value => value as TaskEvent)
    .find((event): event is Extract<TaskEvent, { type: 'outcome_unknown' }> => (
      event.type === 'outcome_unknown'
      && event.run_id === runId
      && event.dispatch_generation === generation
      && event.operation_id === operation.operation_id
    ))
  if (existing) {
    return {
      type: 'outcome_unknown',
      outcome: publicOutcomeUnknown(runId, generation, operation),
      event_sequence: existing.event_sequence,
    }
  }
  state.event_sequence += 1
  state.task_events[String(state.event_sequence)] = {
    event_sequence: state.event_sequence,
    task_id: taskId,
    run_id: runId,
    type: 'outcome_unknown',
    dispatch_generation: generation,
    operation_id: operation.operation_id,
    operation_kind: operation.kind,
    operation_started_at: operation.started_at,
    created_at: now,
  }
  return {
    type: 'outcome_unknown',
    outcome: publicOutcomeUnknown(runId, generation, operation),
    event_sequence: state.event_sequence,
  }
}

/**
 * A delegated child has its own private Run, but its lifecycle is a public
 * fact of the parent's work. Keep that one safe projection in the parent
 * stream so the renderer can show a real task tree without receiving child
 * prompts, model text, tools or its private Codex Thread.
 */
function subtaskLifecycleActivity(
  parentRunId: string,
  parentToolCallId: string,
  phase: 'started' | 'completed' | 'failed',
): Extract<ProductTaskEvent, { type: 'activity' }> {
  return {
    type: 'activity',
    id: durableSubtaskActivityItemId(parentRunId, parentToolCallId),
    parentId: productRunToolActivityItemId(parentRunId, parentToolCallId),
    kind: 'subtask',
    phase,
    summary: productTaskActivitySummary('subtask', phase),
  }
}

function recordSubtaskLifecycleActivity(
  state: AuthorityFile,
  input: {
    child: { task_id?: unknown; parent_run_id?: unknown; parent_tool_call_id?: unknown }
    phase: 'started' | 'completed' | 'failed'
    now: string
  },
): Extract<ProductTaskEvent, { type: 'activity' }> | undefined {
  const parentRunId = input.child.parent_run_id
  const parentToolCallId = input.child.parent_tool_call_id
  if (typeof input.child.task_id !== 'string' || typeof parentRunId !== 'string' || typeof parentToolCallId !== 'string') return undefined
  const parent = state.task_runs[parentRunId] as { task_id?: unknown; event_contract?: unknown } | undefined
  const parentDispatch = state.dispatch_records[parentRunId] as { dispatch_generation?: unknown; state?: unknown } | undefined
  const parentGeneration = parentDispatch?.dispatch_generation
  if (
    !parent
    || parent.task_id !== input.child.task_id
    || !Number.isSafeInteger(parentGeneration)
    || (input.phase === 'started' && !['claimed', 'started'].includes(parentDispatch?.state as string))
  ) return undefined

  const activity = subtaskLifecycleActivity(parentRunId, parentToolCallId, input.phase)
  const existing = Object.values(state.task_events)
    .map(value => value as TaskEvent)
    .find((event): event is Extract<TaskEvent, { type: 'activity' }> => (
      event.type === 'activity'
      && event.run_id === parentRunId
      && event.dispatch_generation === parentGeneration
      && event.item_id === activity.id
      && event.phase === input.phase
    ))
  if (existing) {
    if (
      existing.kind !== activity.kind
      || existing.parent_item_id !== activity.parentId
      || existing.summary !== activity.summary
    ) throw new Error('AUTHORITY_INVALID')
    return activity
  }

  parent.event_contract = 'durable_items_v1'
  state.event_sequence += 1
  state.task_events[String(state.event_sequence)] = {
    event_sequence: state.event_sequence,
    task_id: input.child.task_id,
    run_id: parentRunId,
    type: 'activity',
    dispatch_generation: parentGeneration,
    item_id: activity.id,
    parent_item_id: activity.parentId,
    kind: activity.kind,
    phase: activity.phase,
    summary: activity.summary,
    created_at: input.now,
  }
  return activity
}

/**
 * A stop, fence, IPC loss, or failed effect cannot distinguish whether a
 * side effect committed.  Turn every still-live receipt into one durable,
 * user-visible reconciliation state before revoking the worker claim.
 */
function markDurableTaskRunOutcomeUnknown(
  state: AuthorityFile,
  taskId: string,
  runId: string,
  dispatch: DurableTaskRunDispatch,
  now: string,
): { event: Extract<ProductTaskEvent, { type: 'outcome_unknown' }>; changed: boolean } {
  if (!Number.isSafeInteger(dispatch.dispatch_generation)) throw new Error('AUTHORITY_INVALID')
  const operations = liveExternalOperations(dispatch)
  if (operations.length === 0) throw new Error('AUTHORITY_INVALID')
  let changed = false
  for (const operation of operations) {
    if (operation.state !== 'outcome_unknown') {
      operation.state = 'outcome_unknown'
      delete operation.result_obtained_at
      changed = true
    }
  }
  if (dispatch.state !== 'outcome_unknown') {
    dispatch.state = 'outcome_unknown'
    changed = true
  }
  if (dispatch.outcome_unknown_at === undefined) {
    dispatch.outcome_unknown_at = now
    changed = true
  }
  if (dispatch.error !== 'EXTERNAL_OPERATION_OUTCOME_UNKNOWN') {
    dispatch.error = 'EXTERNAL_OPERATION_OUTCOME_UNKNOWN'
    changed = true
  }
  if (dispatch.completed_at !== undefined) { delete dispatch.completed_at; changed = true }
  if (dispatch.execution_claim !== undefined) { delete dispatch.execution_claim; changed = true }
  if (dispatch.recovery_fence !== undefined) { delete dispatch.recovery_fence; changed = true }
  if (dispatch.stop_requested_at !== undefined) { delete dispatch.stop_requested_at; changed = true }
  const primary = primaryUnknownExternalOperation(dispatch)
  if (!primary) throw new Error('AUTHORITY_INVALID')
  const beforeSequence = state.event_sequence
  const event = durableOutcomeUnknownEvent(state, taskId, runId, dispatch.dispatch_generation as number, primary, now)
  return { event, changed: changed || state.event_sequence !== beforeSequence }
}

function productStorePath(): string {
  const configDir = process.env.BILLIARDBUDDY_CONFIG_DIR || path.join(os.homedir(), '.BilliardBuddy')
  return path.join(configDir, 'billiardbuddy', 'product-tasks.json')
}

function authorityStorePath(storagePath: string): string {
  return path.join(path.dirname(storagePath), 'product-task-authority.v1.json')
}

function boundedRecentProjectLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10
  return Math.min(Math.max(Math.floor(limit), 1), MAX_RECENT_PRODUCT_PROJECTS)
}

function isDesktopWorktreeBranchName(branch: string | null): boolean {
  return !!branch && branch.startsWith('worktree-desktop-')
}

async function runRecentProjectGitCommand(
  workDir: string,
  args: string[],
): Promise<string | null> {
  let process: Bun.Subprocess<'ignore', 'pipe', 'ignore'> | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    process = Bun.spawn(['git', ...args], {
      cwd: workDir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const output = new Response(process.stdout).text()
      .then(async (text) => (await process!.exited) === 0 ? text.trim() : null)
      .catch(() => null)
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        try {
          process?.kill()
        } catch {
          // The process may already have exited.
        }
        resolve(null)
      }, DEFAULT_PRODUCT_GIT_INFO_COMMAND_TIMEOUT_MS)
    })
    return await Promise.race([output, timedOut])
  } catch {
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function ownerRepoNameFromRemote(remote: string | null): string | null {
  if (!remote) return null
  const match = remote.match(/:([^/]+\/[^/]+?)(?:\.git)?$/) || remote.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/)
  return match ? match[1]! : null
}

async function recentProjectGitInfo(workDir: string): Promise<Pick<
  ProductRecentProject,
  'isGit' | 'repoName' | 'branch'
>> {
  if (!findProductGitRoot(workDir)) {
    return { isGit: false, repoName: null, branch: null }
  }

  const [branchResult, remoteResult] = await Promise.all([
    runRecentProjectGitCommand(workDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runRecentProjectGitCommand(workDir, ['remote', 'get-url', 'origin']),
  ])
  return {
    isGit: true,
    repoName: ownerRepoNameFromRemote(remoteResult),
    branch: isDesktopWorktreeBranchName(branchResult) ? null : branchResult,
  }
}

function validTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest('title 必须是字符串')
  const title = value.trim()
  if (!title) throw ApiError.badRequest('任务标题不能为空')
  if (title.length > 200) throw ApiError.badRequest('任务标题不能超过 200 个字符')
  return title
}

function productTaskPermissionMode(value: unknown): ProductTaskPermissionMode {
  if (value === undefined) return 'ask_for_approval'
  if (
    typeof value === 'string'
    && (PRODUCT_TASK_PERMISSION_MODES as readonly string[]).includes(value)
  ) {
    return value as ProductTaskPermissionMode
  }
  throw ApiError.badRequest(
    `permissionMode 必须是 ${PRODUCT_TASK_PERMISSION_MODES.join('、')} 之一`,
  )
}

function taskPermissionSnapshot(value: unknown): ProductPermissionSnapshot {
  return isProductPermissionSnapshot(value)
    ? { ...value }
    : productPermissionSnapshot('ask_for_approval')
}

/** Only the Core session identity belongs in the durable Authority binding. */
function authorityCoreBinding(value: unknown): { coreSessionId: string } {
  const coreSessionId = (value as { coreSessionId?: unknown } | null)?.coreSessionId
  if (typeof coreSessionId !== 'string' || !coreSessionId.trim()) {
    throw new Error('AUTHORITY_INVALID')
  }
  return { coreSessionId }
}

function workspaceIdForIdentity(
  installationId: string,
  identity: Pick<ProductWorkspace['root_identity'], 'volume_id' | 'file_id'>,
): string {
  return `workspace_${createHash('sha256').update(`${installationId}\u0000${identity.volume_id}\u0000${identity.file_id}`).digest('hex').slice(0, 16)}`
}

function projectIdForRoot(installationId: string, rootDir: string): string {
  return `project_${createHash('sha256').update(`${installationId}\u0000${rootDir}`).digest('hex').slice(0, 16)}`
}

function directoryIdForPath(projectId: string, directoryPath: string): string {
  return `directory_${createHash('sha256').update(`${projectId}\u0000${directoryPath}`).digest('hex').slice(0, 16)}`
}

function isSameOrChildPath(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function productProjectTitle(rootDir: string): string {
  return path.basename(rootDir.replace(/[\\/]+$/, '')) || rootDir || '未命名项目'
}

function productDirectoryLabel(rootDir: string, directoryPath: string): string {
  const relative = path.relative(rootDir, directoryPath)
  return relative && isSameOrChildPath(rootDir, directoryPath)
    ? relative
    : '项目根目录'
}

function publicSideTask(sideTask: ProductSideTaskMetadata): ProductSideTask {
  const {
    coreSessionId: _coreSessionId,
    sourceTurnId: _sourceTurnId,
    ...result
  } = sideTask
  return result
}

function authorityPublicTask(value: unknown): ProductTaskRecord {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const task = record.task && typeof record.task === 'object' ? record.task as ProductTaskRecord : record as ProductTaskRecord
  const { coreSessionId: _coreSessionId, binding: _binding, ...publicTask } = task as ProductTaskRecord & { coreSessionId?: unknown; binding?: unknown }
  return { ...publicTask, revision: typeof publicTask.revision === 'number' ? publicTask.revision : 0 } as ProductTaskRecord
}

type StoredReviewComment = {
  comment_id: string
  task_id: string
  file_ref: { file_id: string; path: string; revision: string }
  side: 'old' | 'new'
  line: number
  body: string
  created_at: string
}

function publicReviewComment(value: StoredReviewComment): ProductTaskReviewComment {
  return {
    commentId: value.comment_id,
    taskId: value.task_id,
    fileRef: {
      fileId: value.file_ref.file_id,
      path: value.file_ref.path,
      revision: value.file_ref.revision,
    },
    side: value.side,
    line: value.line,
    body: value.body,
    createdAt: value.created_at,
  }
}

function actionsFor(task: ProductTask, hasActiveRun: boolean): ProductTaskAction[] {
  if (task.lifecycle === 'archived') return ['restore', 'continue']
  if (task.lifecycle !== 'active') return []
  const actions: ProductTaskAction[] = [
    task.pinnedAt ? 'unpin' : 'pin',
    'rename',
    'continue',
  ]
  // An active Core turn has a product-owned stop/approval surface. Do not
  // offer a lifecycle action that would make that live task disappear.
  if (!hasActiveRun) actions.splice(2, 0, 'archive')
  return actions
}

function authorityTaskIndex(authority: AuthorityFile): ProductTaskIndexResponse {
  const sideTaskIds = new Set(
    Object.values(authority.side_tasks)
      .map((side) => (side as { taskId?: unknown }).taskId)
      .filter((taskId): taskId is string => typeof taskId === 'string'),
  )
  const tasks = Object.values(authority.tasks)
    .map(authorityPublicTask)
    .filter((task) => task?.id && !sideTaskIds.has(task.id) && task.lifecycle !== 'deleted')
    .map((task) => ({ ...task, actions: actionsFor(task, hasBlockingTaskWork(authority, task.id)) }))
    .sort((left, right) => {
      if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    })

  const registeredProjects = authority.product_projects as Record<string, ProductProjectMetadata>
  const registeredDirectories = authority.product_directories as Record<string, ProductProjectDirectoryMetadata>
  const activePinnedProjectIds = new Set(
    tasks.filter((task) => task.lifecycle === 'active' && Boolean(task.pinnedAt)).map((task) => task.projectId),
  )
  const projects = new Map<string, ProductProject>()
  for (const task of tasks) {
    const registered = registeredProjects[task.projectId]
    if (!registered) continue
    const project = projects.get(task.projectId) ?? {
      ...registered,
      taskCount: 0,
      archivedTaskCount: 0,
    }
    if (task.lifecycle === 'archived') project.archivedTaskCount += 1
    else project.taskCount += 1
    if (Date.parse(task.updatedAt) > Date.parse(project.updatedAt)) project.updatedAt = task.updatedAt
    projects.set(task.projectId, project)
  }
  const publicProjects = [...projects.values()].sort((left, right) => {
    if (activePinnedProjectIds.has(left.id) !== activePinnedProjectIds.has(right.id)) {
      return activePinnedProjectIds.has(left.id) ? -1 : 1
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
  })
  const visibleProjectIds = new Set(publicProjects.map((project) => project.id))
  return {
    schemaVersion: PRODUCT_DOMAIN_VERSION,
    projects: publicProjects,
    directories: Object.values(registeredDirectories)
      .filter((directory) => visibleProjectIds.has(directory.projectId))
      .sort((left, right) => left.projectId.localeCompare(right.projectId)
        || left.label.localeCompare(right.label) || left.path.localeCompare(right.path)),
    tasks,
    total: tasks.length,
    capabilities: { createTask: true },
  }
}

export class ProductTaskService {
  private readonly storagePath: string
  private readonly authorityPath: string
  private readonly core: AgentCoreAdapter
  private readonly legacyRegistry: ProductTaskLegacyRegistry
  private readonly workspaceFs: WorkspaceFilesystemPort
  private readonly workspaceBindBlockers: WorkspaceBindBlockerPort
  private readonly admissionBarrier: SessionAdmissionBarrier
  private readonly authorityRepositoryDeps: ProductTaskAuthorityRepositoryDeps
  private readonly lifecycleParticipants: readonly TaskLifecycleParticipant[]
  private readonly now: () => Date
  private readonly installationId: string
  private readonly dispatcher?: ProductTaskRunDispatchPort
  private readonly privateArtifacts: ProductTaskPrivateArtifactPort
  private readonly runtimeEvents: ProductTaskRuntimeEventPort
  private taskRunQueueRecovery?: Promise<void>
  private taskRunQueueRecoveryRetry?: ReturnType<typeof setTimeout>

  constructor(options: {
    storagePath?: string
    core?: AgentCoreAdapter
    workspaceFs?: WorkspaceFilesystemPort
    workspaceBindBlockers?: WorkspaceBindBlockerPort
    admissionBarrier?: SessionAdmissionBarrier
    /** Test-only authority write seam. */
    authorityRepositoryDeps?: ProductTaskAuthorityRepositoryDeps
    /** Server-private Core binding persistence seam. */
    sessionBindingPort?: unknown
    lifecycleParticipants?: readonly TaskLifecycleParticipant[]
    additionalLifecycleParticipants?: readonly TaskLifecycleParticipant[]
    now?: () => Date
    installationId?: string
    /** Server-private dispatch seam. Accepted durable receipts are never rolled back on launch failure. */
    dispatcher?: ProductTaskRunDispatchPort
    /** Server-owned cleanup for Harness and other private task artifacts. */
    privateArtifacts?: ProductTaskPrivateArtifactPort
    /** Server-owned projection publisher for already durable task events. */
    runtimeEvents?: ProductTaskRuntimeEventPort
  } = {}) {
    this.storagePath = options.storagePath ?? productStorePath()
    this.authorityPath = options.storagePath ? authorityStorePath(options.storagePath) : authorityStorePath(productStorePath())
    this.core = options.core ?? agentCoreAdapter
    this.legacyRegistry = new ProductTaskLegacyRegistry(this.storagePath, this.core)
    this.workspaceFs = options.workspaceFs ?? workspaceFilesystem
    // BB-02B can observe active product runs. Queue/PTY/preview/write leases
    // are explicitly out-of-scope disabled participants, not synthetic unknowns.
    this.admissionBarrier = options.admissionBarrier ?? sessionAdmissionBarrier
    this.authorityRepositoryDeps = options.authorityRepositoryDeps ?? {}
    const defaultLifecycleParticipants: TaskLifecycleParticipant[] = [
      {
        id: 'active_core_run',
        inspectBlockers: async (taskId) => {
          const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
          return activeTaskRun(state, taskId) !== undefined
            ? [{ participant: 'active_core_run', code: 'ACTIVE_RUN', action: 'stop' }]
            : []
        },
      },
      {
        id: 'task_run_queue',
        inspectBlockers: async (taskId) => {
          const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
          return hasQueuedTaskWork(state, taskId)
            ? [{ participant: 'task_run_queue', code: 'QUEUE', action: 'resolve' }]
            : []
        },
      },
      {
        id: 'private_task_artifacts',
        inspectBlockers: async () => [],
        purgeCleanup: async taskId => this.purgeTaskPrivateArtifacts(taskId),
      },
    ]
    this.lifecycleParticipants = options.lifecycleParticipants
      ?? [...defaultLifecycleParticipants, ...(options.additionalLifecycleParticipants ?? [])]
    this.workspaceBindBlockers = options.workspaceBindBlockers ?? {
      inspect: async (taskId) => {
        const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
        const active = activeTaskRun(state, taskId) !== undefined
        return { receipts: defaultParticipantReceipts(active, hasQueuedTaskWork(state, taskId)) }
      },
    }
    this.now = options.now ?? (() => new Date())
    this.installationId = options.installationId ?? 'installation-default'
    this.dispatcher = options.dispatcher
    this.privateArtifacts = options.privateArtifacts ?? productTaskPrivateArtifactPort
    this.runtimeEvents = options.runtimeEvents
      ?? createProductTaskRuntimeEventPort(new ProductTaskWorkerRuntimeEvents())
  }

  async listTasksAuthoritatively(): Promise<ProductTaskIndexResponse> {
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const index = authorityTaskIndex(authority)
    return {
      ...index,
      tasks: index.tasks.map((task) => {
        const scope = authority.task_scopes[task.id] as ProductTaskScope | undefined
        if (!scope || scope.kind === 'installation-default') {
          const { workDir: _workDir, ...publicTask } = task
          return { ...publicTask, task_scope: { kind: 'installation-default' }, workspace_capability: { scope: { kind: 'installation-default' }, available: false } } as typeof task
        }
        const workspace = authority.workspaces[scope.workspace_id] as ProductWorkspace | undefined
        const capability = {
          scope,
          ...(workspace ? { workspace_revision: workspace.revision, availability: workspace.availability } : {}),
          available: workspace?.availability === 'available',
        }
        if (!capability.available) {
          const { workDir: _workDir, ...publicTask } = task
          return { ...publicTask, task_scope: scope, workspace_capability: capability } as typeof task
        }
        return { ...task, task_scope: scope, workspace_capability: capability }
      }),
    }
  }

  async listSideTasksAuthoritatively(taskId: string): Promise<ProductSideTask[]> {
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    if (!authority.tasks[taskId]) throw ApiError.notFound(`任务不存在：${taskId}`)
    return Object.values(authority.side_tasks)
      .map((sideTask) => publicSideTask(sideTask as ProductSideTaskMetadata))
      .filter((sideTask) => sideTask.parentTaskId === taskId)
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === 'open' ? -1 : 1
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      })
  }

  /**
   * Materialize every supported v1-v4 task and side-task record through the
   * existing domain normalizer before the legacy reader is eligible for
   * retirement.
   */
  async migrateSupportedStorage(): Promise<void> {
    const registered = await this.legacyRegistry.materializeSupportedStore()
    const legacy = {
      taskIds: registered.taskIds,
      sideTasks: Object.values(registered.sideTasks)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(publicSideTask),
      projects: registered.projects,
      directories: registered.directories,
    }
    for (const taskId of legacy.taskIds) {
      await this.ensureAuthorityProjectionForLegacyTask(taskId, { authorityPath: this.authorityPath })
      await this.materializeLegacyTaskThread(taskId)
    }
    if (legacy.taskIds.length || legacy.sideTasks.length || Object.keys(legacy.projects).length || Object.keys(legacy.directories).length) {
      const source = await readLegacyProductTasks(this.storagePath)
      const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
      await authority.ensureLegacyProjectRegistryProjection(source, {
        projects: legacy.projects,
        directories: legacy.directories,
      })
      for (const sideTask of legacy.sideTasks) {
        await authority.ensureLegacySideTaskProjection(sideTask.id, source, sideTask)
      }
    }
  }

  /**
   * Imports the safe, existing Core transcript once so product reads and
   * branches use the Authority ledger rather than a second thread source.
   */
  private async materializeLegacyTaskThread(taskId: string): Promise<void> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let snapshot = await authority.read()
    if (!snapshot.tasks[taskId]) {
      await this.ensureAuthorityProjectionForLegacyTask(taskId, { authorityPath: this.authorityPath })
      snapshot = await authority.read()
    }
    const stored = snapshot.tasks[taskId] as { task?: ProductTaskRecord; binding?: { coreSessionId?: unknown } } | undefined
    const task = stored?.task
    if (!task) throw ApiError.notFound(`任务不存在：${taskId}`)

    const currentLineageId = typeof task.current_lineage_id === 'string' ? task.current_lineage_id : undefined
    const legacyRuns = Object.values(snapshot.task_runs)
      .map(value => value as { run_id?: unknown; task_id?: unknown; lineage_id?: unknown; entry_id?: unknown; created_at?: unknown; core_binding?: { session_id?: unknown; dispatch_generation?: unknown } })
      .filter((run): run is { run_id: string; task_id: string; lineage_id: string; entry_id: string; created_at: string; core_binding?: { session_id?: unknown; dispatch_generation?: unknown } } => (
        run.task_id === taskId
        && typeof run.run_id === 'string'
        && typeof run.lineage_id === 'string'
        && typeof run.entry_id === 'string'
        && typeof run.created_at === 'string'
        && (snapshot.task_runs[run.run_id] as { event_contract?: unknown }).event_contract !== 'durable_items_v1'
      ))

    const initialSessionId = typeof stored?.binding?.coreSessionId === 'string'
      ? stored.binding.coreSessionId
      : undefined
    const needsSyntheticRun = legacyRuns.length === 0 && !currentLineageId && Boolean(initialSessionId)
    if (legacyRuns.length === 0 && !needsSyntheticRun) return

    const getSessionMessages = this.core.getSessionMessages
    if (!getSessionMessages) throw new ApiError(503, '任务记录暂不可用', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
    const pendingRuns = needsSyntheticRun
      ? [{
          run_id: legacyAuthorityId('run', taskId),
          task_id: taskId,
          lineage_id: legacyAuthorityId('lineage', taskId),
          entry_id: legacyAuthorityId('entry', taskId),
          created_at: task.createdAt,
          core_binding: { session_id: initialSessionId!, dispatch_generation: 1 },
        }]
      : legacyRuns
    const projections = new Map<string, ReturnType<typeof projectLegacyCoreThreadItems>>()
    for (const run of pendingRuns) {
      const sessionId = run.core_binding?.session_id
      if (typeof sessionId !== 'string' || !sessionId) throw new ApiError(503, '任务记录暂不可用', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
      projections.set(run.run_id, projectLegacyCoreThreadItems(await getSessionMessages(sessionId)))
    }

    await authority.transactSubmit((state) => {
      const currentStored = state.tasks[taskId] as { task?: ProductTaskRecord } | undefined
      const currentTask = currentStored?.task
      if (!currentTask) throw new Error('AUTHORITY_INVALID')
      for (const planned of pendingRuns) {
        let run = state.task_runs[planned.run_id] as Record<string, unknown> | undefined
        if (!run && needsSyntheticRun) {
          const lineageId = planned.lineage_id
          const createdAt = planned.created_at
          const sessionId = planned.core_binding!.session_id as string
          state.conversation_lineages[lineageId] = {
            lineage_id: lineageId,
            product_task_id: taskId,
            revision: 0,
            compact_generation: 0,
            resume_binding_id: `resume_${createHash('sha256').update(`legacy-authority:${taskId}:resume`).digest('hex').slice(0, 32)}`,
            execution_directory: currentTask.workDir || path.dirname(this.storagePath),
            state: 'active',
            created_at: createdAt,
            updated_at: createdAt,
          }
          currentTask.current_lineage_id = lineageId
          state.thread_entries[planned.entry_id] = { entry_id: planned.entry_id, task_id: taskId, run_id: planned.run_id, text: '', created_at: createdAt, core_session_id: sessionId, core_message_id: `legacy-root:${taskId}` }
          run = {
            run_id: planned.run_id,
            task_id: taskId,
            lineage_id: lineageId,
            entry_id: planned.entry_id,
            created_at: createdAt,
            execution_capability: 'installation_default_denied',
            permission_mode: null,
            provider: null,
            model: null,
            core_binding: { resume_binding_id: (state.conversation_lineages[lineageId] as { resume_binding_id: string }).resume_binding_id, session_id: sessionId, work_dir: currentTask.workDir || path.dirname(this.storagePath), dispatch_generation: 1 },
          }
          state.task_runs[planned.run_id] = run
          state.dispatch_records[planned.run_id] = { run_id: planned.run_id, dispatch_generation: 1, state: 'terminal', completed_at: createdAt, error: 'TERMINAL' }
        }
        if (!run || run.event_contract === 'durable_items_v1') continue
        if (run.task_id !== taskId || run.lineage_id !== planned.lineage_id || run.entry_id !== planned.entry_id) throw new Error('AUTHORITY_INVALID')
        if (Object.values(state.task_events).some(value => (value as { run_id?: unknown }).run_id === planned.run_id)) throw new Error('AUTHORITY_INVALID')
        const coreBinding = run.core_binding as { session_id?: unknown; dispatch_generation?: unknown } | undefined
        const sessionId = coreBinding?.session_id
        const dispatchGeneration = Number.isSafeInteger(coreBinding?.dispatch_generation) ? coreBinding!.dispatch_generation as number : 1
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('AUTHORITY_INVALID')
        for (const item of projections.get(planned.run_id) ?? []) {
          const entry = item.entry
          if (entry.type === 'user_text') {
            state.thread_entries[entry.id] = {
              entry_id: entry.id,
              task_id: taskId,
              run_id: planned.run_id,
              text: entry.text,
              created_at: entry.createdAt,
              core_session_id: sessionId,
              core_message_id: item.coreMessageId,
              ...(entry.referenceEntryIds?.length ? { reference_entry_ids: entry.referenceEntryIds } : {}),
            }
            state.event_sequence += 1
            state.task_events[String(state.event_sequence)] = {
              event_sequence: state.event_sequence,
              task_id: taskId,
              run_id: planned.run_id,
              type: 'user_text',
              entry_id: entry.id,
              item_id: entry.id,
              text: entry.text,
              attachment_ids: [],
              ...(entry.attachments?.length ? { attachment_summaries: entry.attachments } : {}),
              ...(entry.referenceEntryIds?.length ? { reference_entry_ids: entry.referenceEntryIds } : {}),
              created_at: entry.createdAt,
            }
          } else if (entry.type === 'assistant_text') {
            state.thread_entries[entry.id] = { entry_id: entry.id, task_id: taskId, run_id: planned.run_id, text: entry.text, created_at: entry.createdAt, core_session_id: sessionId, core_message_id: item.coreMessageId }
            state.event_sequence += 1
            state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: planned.run_id, type: 'assistant_text', dispatch_generation: dispatchGeneration, item_id: entry.id, text: entry.text, created_at: entry.createdAt }
          } else {
            state.event_sequence += 1
            state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: planned.run_id, type: 'activity', dispatch_generation: dispatchGeneration, item_id: legacyActivityItemId(planned.run_id, entry.id), kind: entry.kind, phase: entry.phase, summary: productTaskActivitySummary(entry.kind, entry.phase), created_at: entry.createdAt }
          }
        }
        run.event_contract = 'durable_items_v1'
      }
    })
  }

  /**
   * Records one current durable Item's private Core origin before a branch
   * consumes it. Core is consulted only to create this Authority mapping;
   * branch resolution itself never treats the transcript as product truth.
   */
  private async materializeTaskBranchEntryBinding(taskId: string, sourceEntryId: string): Promise<void> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const snapshot = await authority.read()
    const existing = snapshot.thread_entries[sourceEntryId] as { task_id?: unknown; core_session_id?: unknown; core_message_id?: unknown } | undefined
    if (existing?.task_id === taskId && typeof existing.core_session_id === 'string' && typeof existing.core_message_id === 'string') return

    const event = Object.values(snapshot.task_events)
      .map(value => value as TaskEvent)
      .find((candidate): candidate is Extract<TaskEvent, { type: 'user_text' | 'assistant_text' }> => (
        candidate.task_id === taskId
        && (candidate.type === 'user_text' || candidate.type === 'assistant_text')
        && (candidate.item_id ?? (candidate.type === 'user_text' ? durableUserItemId(candidate.run_id) : '')) === sourceEntryId
      ))
    if (!event) return
    const run = snapshot.task_runs[event.run_id] as { task_id?: unknown; core_binding?: { session_id?: unknown } } | undefined
    const sessionId = run?.core_binding?.session_id
    const getSessionMessages = this.core.getSessionMessages
    if (run?.task_id !== taskId || typeof sessionId !== 'string' || !sessionId || !getSessionMessages) {
      throw new ApiError(503, '任务记录暂不可用', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
    }
    const matchingCoreItems = projectLegacyCoreThreadItems(await getSessionMessages(sessionId))
      .filter(item => item.entry.type === event.type && item.entry.text === event.text)
    const coreMessageIds = new Set(matchingCoreItems.map(item => item.coreMessageId))
    if (coreMessageIds.size !== 1) return
    const coreItem = matchingCoreItems[0]!

    await authority.transactSubmit((state) => {
      const currentEvent = state.task_events[String(event.event_sequence)] as TaskEvent | undefined
      if (!currentEvent || currentEvent.task_id !== taskId || currentEvent.type !== event.type || currentEvent.run_id !== event.run_id || currentEvent.text !== event.text) throw new Error('AUTHORITY_INVALID')
      const itemId = currentEvent.item_id ?? (currentEvent.type === 'user_text' ? durableUserItemId(currentEvent.run_id) : '')
      if (itemId !== sourceEntryId) throw new Error('AUTHORITY_INVALID')
      const currentRun = state.task_runs[currentEvent.run_id] as { task_id?: unknown; core_binding?: { session_id?: unknown } } | undefined
      if (currentRun?.task_id !== taskId || currentRun.core_binding?.session_id !== sessionId) throw new Error('AUTHORITY_INVALID')
      const entry = state.thread_entries[itemId] as { task_id?: unknown; run_id?: unknown; text?: unknown; core_session_id?: unknown; core_message_id?: unknown } | undefined
      if (entry?.core_session_id !== undefined || entry?.core_message_id !== undefined) {
        if (entry.task_id !== taskId || entry.run_id !== currentEvent.run_id || entry.core_session_id !== sessionId || entry.core_message_id !== coreItem.coreMessageId) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: undefined }
      }
      state.thread_entries[itemId] = {
        entry_id: itemId,
        task_id: taskId,
        run_id: currentEvent.run_id,
        text: currentEvent.text,
        created_at: currentEvent.created_at,
        core_session_id: sessionId,
        core_message_id: coreItem.coreMessageId,
        ...(currentEvent.type === 'user_text' && currentEvent.reference_entry_ids?.length ? { reference_entry_ids: currentEvent.reference_entry_ids } : {}),
      }
    })
  }

  /**
   * Directory-picker projects are derived from the public product task index.
   * This deliberately excludes unregistered Agent Core sessions and never
   * exposes their private session bindings.
   */
  async listRecentProjects(limit = 10): Promise<ProductRecentProjectList> {
    const taskIndex = await this.listTasksAuthoritatively()
    const projects = [...taskIndex.projects]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedRecentProjectLimit(limit))

    return {
      projects: await Promise.all(projects.map(async (project) => {
        const realPath = await fs.realpath(project.rootDir).catch(() => project.rootDir)
        const git = await recentProjectGitInfo(realPath)
        return {
          projectPath: project.rootDir,
          realPath,
          projectName: project.title,
          ...git,
          modifiedAt: project.updatedAt,
          sessionCount: project.taskCount + project.archivedTaskCount,
        }
      })),
    }
  }

  async continueTaskAuthoritatively(input: { taskId: string; expected_revision: number; client_operation_id: string; canonical_input: string }, options: { authorityPath: string; bridge: Pick<ProductCoreOperationBridge, 'ensureBranch'> }): Promise<{ outcome: string; revision: number }> {
    await this.ensureAuthorityProjectionForLegacyTask(input.taskId, options)
    return this.authoritativeBranch(input, options, 'continue')
  }

  async createSideTaskAuthoritatively(input: { taskId: string; sideTaskId: string; expected_revision: number; client_operation_id: string; canonical_input: string }, options: { authorityPath: string; bridge: Pick<ProductCoreOperationBridge, 'ensureBranch'> }): Promise<{ outcome: string; revision: number }> {
    await this.ensureAuthorityProjectionForLegacyTask(input.taskId, options)
    return this.authoritativeBranch({ ...input, taskId: input.sideTaskId, canonical_input: JSON.stringify({ ...JSON.parse(input.canonical_input), taskId: input.taskId }) }, options, 'side')
  }

  async closeSideTaskAuthoritatively(input: { taskId: string; sideTaskId: string; expected_revision: number; client_operation_id: string; canonical_input: string }, options: { authorityPath: string }): Promise<{ outcome: string; revision: number }> {
    await this.ensureAuthorityProjectionForLegacyTask(input.taskId, options)
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    const current = await authority.read()
    // Side-task ownership is authority-only. A legacy or client-shaped record
    // must never be promoted during a close mutation.
    const side = current.side_tasks[input.sideTaskId] as ProductSideTask | undefined
    if (!side || side.parentTaskId !== input.taskId) throw ApiError.notFound(`侧边任务不存在：${input.sideTaskId}`)
    let reserved
    try { reserved = await authority.reserve({ client_operation_id: input.client_operation_id, product_task_id: input.sideTaskId, kind: 'close', canonical_input: input.canonical_input, expected_revision: input.expected_revision, expected_task_revision: input.expected_revision, expected_task_id: input.taskId }) } catch (error) {
      if ((error as Error).message !== 'AUTHORITY_CONFLICT') throw error
      return { outcome: 'conflict', revision: (await authority.read()).revision }
    }
    if (reserved.file.receipts[input.client_operation_id]) return { outcome: 'duplicate', revision: reserved.file.receipts[input.client_operation_id].revision }
    const closed = { ...side, status: 'closed' as const, closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, result: closed }, undefined, { sideTask: closed })
    return { outcome: 'accepted', revision: final.revision }
  }

  private async authoritativeBranch(input: { taskId: string; expected_revision: number; client_operation_id: string; canonical_input: string }, options: { authorityPath: string; bridge: Pick<ProductCoreOperationBridge, 'ensureBranch'> }, kind: string): Promise<{ outcome: string; revision: number }> {
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    // Public input never chooses a Core source. Resolve its product entry id
    // against the authority-owned private parent binding before persisting the
    // server-only branch plan.
    let publicInput: Record<string, unknown> = {}
    try { publicInput = JSON.parse(input.canonical_input) as Record<string, unknown> } catch { /* bridge records invalid input as terminal */ }
    const sourceTaskId = typeof publicInput.taskId === 'string' ? publicInput.taskId : input.taskId
    if (typeof publicInput.sourceEntryId === 'string') {
      await this.materializeLegacyTaskThread(sourceTaskId)
      await this.materializeTaskBranchEntryBinding(sourceTaskId, publicInput.sourceEntryId)
    }
    const current = await authority.read()
    const source = current.tasks[sourceTaskId] as { task?: ProductTaskRecord; binding?: { coreSessionId?: string } } | undefined
    let canonicalInput = input.canonical_input
    let forkCheckpointId: string | undefined
    if (source?.binding?.coreSessionId) {
      if (kind === 'continue' && publicInput.target !== 'new_worktree') throw ApiError.badRequest('任务分叉必须使用独立工作树')
      let sourceSessionId = source.binding.coreSessionId
      let targetMessageId: string | undefined
      if (typeof publicInput.sourceEntryId === 'string') {
        const resolved = await this.resolveTaskBranchSource(sourceTaskId, publicInput.sourceEntryId, current)
        sourceSessionId = resolved.coreSessionId
        targetMessageId = resolved.coreTurnId
        forkCheckpointId = resolved.checkpointEntryId
      }
      const serverInput: Record<string, unknown> = { sourceSessionId, sourceWorkDir: source.task?.workDir, title: typeof publicInput.title === 'string' ? publicInput.title : source.task?.title ?? 'Continue task', ...(kind === 'continue' ? { target: 'new_worktree' } : {}) }
      if (targetMessageId) serverInput.targetMessageId = targetMessageId
      canonicalInput = JSON.stringify(serverInput)
    }
    let reserved
    try { reserved = await authority.reserve({ client_operation_id: input.client_operation_id, product_task_id: input.taskId, kind: 'branch', canonical_input: input.canonical_input, expected_revision: input.expected_revision, expected_task_revision: input.expected_revision, expected_task_id: sourceTaskId }) } catch (error) {
      if ((error as Error).message !== 'AUTHORITY_CONFLICT') throw error
      return { outcome: 'conflict', revision: (await authority.read()).revision }
    }
    const prior = reserved.file.receipts[input.client_operation_id]
    if (prior) return { outcome: 'duplicate', revision: prior.revision }
    let binding: unknown
    try {
      binding = await options.bridge.ensureBranch(input.client_operation_id, input.taskId, canonicalInput)
    } catch (error) {
      if (!(error instanceof ProductCoreOperationTerminalError)) throw error
      const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'rejected', revision: reserved.file.revision, error: 'OPERATION_REJECTED' })
      return { outcome: 'rejected', revision: final.revision }
    }
    const sideTask = kind === 'side' ? (() => {
      const parsed = publicInput as { taskId?: string; sideTaskId?: string; title?: string }
      const now = new Date().toISOString()
      return { id: input.taskId, parentTaskId: parsed.taskId ?? '', taskId: input.taskId, title: parsed.title ?? '', status: 'open', createdAt: now, updatedAt: now }
    })() : undefined
    const rawBinding = binding as { branchWorkDir?: unknown }
    const coreBinding = authorityCoreBinding(binding)
    const parentLineageId = typeof source?.task?.current_lineage_id === 'string' ? source.task.current_lineage_id : undefined
    const childLineageId = `lineage_${createHash('sha256').update(`fork\0${input.client_operation_id}`).digest('hex').slice(0, 32)}`
    const now = this.now().toISOString()
    const executionDirectory = typeof rawBinding.branchWorkDir === 'string' ? rawBinding.branchWorkDir : source?.task?.workDir
    const childLineage = kind === 'continue' && parentLineageId && forkCheckpointId && executionDirectory
      ? { lineage_id: childLineageId, product_task_id: input.taskId, parent_lineage_id: parentLineageId, fork_checkpoint_id: forkCheckpointId, revision: 0, compact_generation: 0, resume_binding_id: `resume_${randomUUID()}`, execution_directory: executionDirectory, state: 'active', created_at: now, updated_at: now }
      : undefined
    const finalBinding = sideTask
      ? { id: input.taskId, kind, binding: coreBinding }
      : source?.task
        ? { ...source, binding: coreBinding, task: { ...source.task, revision: (source.task.revision ?? 0) + 1, ...(childLineage ? { current_lineage_id: childLineageId, workDir: executionDirectory, worktreeState: 'materialized', updatedAt: now } : {}) } }
        : { id: input.taskId, kind, binding: coreBinding }
    const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, ...(sideTask ? { result: sideTask } : {}) }, finalBinding, { ...(sideTask ? { sideTask } : {}), ...(childLineage ? { lineage: { id: childLineageId, value: childLineage } } : {}) })
    return { outcome: 'accepted', revision: final.revision }
  }

  async getTaskAuthoritatively(taskId: string, options: { authorityPath: string }): Promise<ProductTaskRecord> {
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    let file = await authority.read()
    if (!file.tasks[taskId]) await this.ensureAuthorityProjectionForLegacyTask(taskId, options)
    file = await authority.read()
    const value = file.tasks[taskId]
    if (!value) throw ApiError.notFound(`任务不存在：${taskId}`)
    const task = authorityPublicTask(value)
    if (!task?.id) throw ApiError.notFound(`任务不存在：${taskId}`)
    return task
  }

  async ensureAuthorityProjectionForLegacyTask(taskId: string, options: { authorityPath: string }): Promise<{ revision: number; task: ProductTaskRecord }> {
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    const current = await authority.read()
    const existing = current.tasks[taskId]
    if (existing) {
      const task = authorityPublicTask(existing)
      if (!task?.id) throw new Error('AUTHORITY_INVALID')
      return { revision: current.revision, task }
    }

    // A legacy JSON record is only an on-demand import source. Once a task is
    // present in Authority, normal Agent operations must not depend on or
    // validate against that retired second store.
    const raw = await fs.readFile(this.storagePath, 'utf8')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('AUTHORITY_INVALID') }
    const strict = readStrictLegacyProductTasks(parsed)
    const task = strict.find((candidate) => candidate.id === taskId)
    if (!task) throw ApiError.notFound(`任务不存在：${taskId}`)
    const root = parsed as { version?: unknown; tasks?: Record<string, unknown> }
    if (root.version === 2) throw new Error('UNSUPPORTED_SCHEMA')
    const taskKey = root.version === 1
      ? Object.keys(root.tasks ?? {}).find((key) => legacyProductTaskId(key) === taskId)
      : taskId
    if (!taskKey) throw ApiError.notFound(`任务不存在：${taskId}`)
    const source = await readLegacyProductTasks(this.storagePath)
    const record: ProductTaskRecord = { ...task, actions: task.lifecycle === 'archived' ? ['restore', 'continue'] : [task.pinnedAt ? 'unpin' : 'pin', 'rename', 'continue', 'archive'] }
    const projected = await authority.ensureLegacyProjection(taskId, {
      ...source,
      recordDigest: () => source.recordDigest(taskKey),
    }, { task: record, binding: { coreSessionId: task.coreSessionId } })
    return { revision: projected.revision, task: authorityPublicTask((projected.tasks[taskId] as { task: ProductTaskRecord }).task) }
  }

  async mutateTaskAuthoritatively(input: {
    taskId: string
    patch: { pinned?: boolean; archived?: boolean; title?: string }
    expected_revision: number
    client_operation_id: string
  }, options: { authorityPath: string }): Promise<{
    task: ProductTaskRecord
    receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number }
    snapshot: { revision: number; event_sequence: number; tasks: ProductTaskRecord[] }
  }> {
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    await this.ensureAuthorityProjectionForLegacyTask(input.taskId, options)
    const canonical = JSON.stringify({ taskId: input.taskId, patch: input.patch })
    try {
      const before = await authority.read()
      const stored = before.tasks[input.taskId] as { task?: ProductTaskRecord; binding?: unknown } | undefined
      if (!stored?.task) throw ApiError.notFound(`任务不存在：${input.taskId}`)
      const reserved = await authority.reserve({ client_operation_id: input.client_operation_id, product_task_id: input.taskId, kind: 'metadata', canonical_input: canonical, expected_revision: input.expected_revision, expected_task_revision: input.expected_revision })
      const prior = reserved.file.receipts[input.client_operation_id]
      if (prior) {
        const current = await authority.read()
        const task = authorityPublicTask((current.tasks[input.taskId] as { task: ProductTaskRecord }).task)
        return { task, receipt: { outcome: 'duplicate', revision: prior.revision }, snapshot: this.authoritySnapshot(current) }
      }
      const now = new Date().toISOString()
      const task: ProductTaskRecord = {
        ...stored.task,
        ...(input.patch.title !== undefined ? { title: validTitle(input.patch.title) } : {}),
        ...(input.patch.pinned !== undefined ? input.patch.pinned ? { pinnedAt: now } : { pinnedAt: undefined } : {}),
        ...(input.patch.archived !== undefined ? input.patch.archived
          ? { lifecycle: 'archived' as const, archivedAt: now, actions: ['restore', 'continue'] as ProductTaskAction[] }
          : { lifecycle: 'active' as const, archivedAt: undefined, actions: [stored.task.pinnedAt ? 'unpin' : 'pin', 'rename', 'continue', 'archive'] as ProductTaskAction[] }
          : {}),
        updatedAt: now,
        revision: (stored.task.revision ?? 0) + 1,
      }
      const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, result: task }, { ...stored, task })
      return { task: authorityPublicTask(task), receipt: { outcome: 'accepted', revision: final.revision }, snapshot: this.authoritySnapshot(final) }
    } catch (error) {
      if ((error as Error).message === 'AUTHORITY_CONFLICT') {
        const current = await authority.read()
        return { task: authorityPublicTask((current.tasks[input.taskId] as { task?: ProductTaskRecord } | undefined)?.task), receipt: { outcome: 'conflict', revision: current.revision }, snapshot: this.authoritySnapshot(current) }
      }
      throw error
    }
  }

  async renameTaskAuthoritatively(input: {
    taskId: string
    title: string
    expected_revision: number
    client_operation_id: string
  }, options: {
    authorityPath: string
    bridge: Pick<ProductCoreOperationBridge, 'ensureRename'>
  }): Promise<{
    task: ProductTaskRecord
    receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number }
    snapshot: { revision: number; event_sequence: number; tasks: ProductTaskRecord[] }
    mirror: { state: 'pending' | 'reconciled' | 'failed'; error?: string }
  }> {
    const title = validTitle(input.title)
    if (!title) throw ApiError.badRequest('任务标题不能为空')
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    await this.ensureAuthorityProjectionForLegacyTask(input.taskId, options)
    const canonical = JSON.stringify({ taskId: input.taskId, title })
    try {
      const before = await authority.read()
      const stored = before.tasks[input.taskId] as { task?: ProductTaskRecord; binding?: { coreSessionId?: string } } | undefined
      if (!stored?.task || !stored.binding?.coreSessionId) throw ApiError.notFound(`任务不存在：${input.taskId}`)
      const reserved = await authority.reserve({
        client_operation_id: input.client_operation_id,
        product_task_id: input.taskId,
        kind: 'rename',
        canonical_input: canonical,
        expected_revision: input.expected_revision,
        expected_task_revision: input.expected_revision,
      })
      const prior = reserved.file.receipts[input.client_operation_id]
      if (prior) {
        const current = await authority.read()
        const task = authorityPublicTask((current.tasks[input.taskId] as { task: ProductTaskRecord }).task)
        return { task, receipt: { outcome: 'duplicate', revision: prior.revision }, snapshot: this.authoritySnapshot(current), mirror: current.outbox[input.client_operation_id] ?? { state: 'pending' } }
      }
      const task = { ...stored.task, title, updatedAt: new Date().toISOString(), revision: (stored.task.revision ?? 0) + 1 }
      // The product mutation is authoritative before Core is touched. The
      // reconciler reads this durable outbox after a crash as well.
      const final = await authority.finalize(
        input.client_operation_id,
        { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, result: task },
        { ...stored, task },
        { outbox: { state: 'pending' } },
      )
      return { task: authorityPublicTask(task), receipt: { outcome: 'accepted', revision: final.revision }, snapshot: this.authoritySnapshot(final), mirror: final.outbox[input.client_operation_id]! }
    } catch (error) {
      if ((error as Error).message === 'AUTHORITY_CONFLICT') {
        const current = await authority.read()
        return { task: authorityPublicTask((current.tasks[input.taskId] as { task?: ProductTaskRecord } | undefined)?.task), receipt: { outcome: 'conflict', revision: current.revision }, snapshot: this.authoritySnapshot(current), mirror: { state: 'failed', error: 'AUTHORITY_CONFLICT' } }
      }
      throw error
    }
  }

  async reconcileRenameAuthoritatively(operationId: string, options: {
    authorityPath: string
    bridge: Pick<ProductCoreOperationBridge, 'ensureRename'>
  }): Promise<{ state: 'reconciled' | 'failed'; error?: string }> {
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    const file = await authority.read()
    const event = file.events[operationId]
    const stored = event ? file.tasks[(JSON.parse(event.canonical_input ?? '{}') as { taskId?: string }).taskId ?? ''] as { task?: ProductTaskRecord; binding?: { coreSessionId?: string } } | undefined : undefined
    if (!event || event.kind !== 'rename' || !stored?.task || !stored.binding?.coreSessionId) {
      throw new Error('AUTHORITY_INVALID')
    }
    try {
      await options.bridge.ensureRename(operationId, stored.task.id, JSON.stringify({ sessionId: stored.binding.coreSessionId, title: stored.task.title }))
      await authority.setOutbox(operationId, 'reconciled')
      return { state: 'reconciled' }
    } catch {
      await authority.setOutbox(operationId, 'failed', 'OPERATION_REJECTED')
      return { state: 'failed', error: 'OPERATION_REJECTED' }
    }
  }

  async getAuthorityOperation(taskId: string, operationId: string, options: { authorityPath: string }): Promise<{
    receipt: { outcome: string; revision: number }
    authority: { revision: number; event_sequence: number; tasks: ProductTaskRecord[]; side_tasks: ProductSideTask[] }
    mirror?: { state: 'pending' | 'reconciled' | 'failed'; error?: string }
  }> {
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    const file = await authority.read()
    const receipt = file.receipts[operationId]
    const event = file.events[operationId]
    if (!receipt || !event || event.product_task_id !== taskId) throw ApiError.notFound('操作不存在')
    const snapshot = this.authoritySnapshot(file)
    const task = snapshot.tasks.find(item => item.id === taskId)
    if (!task) throw ApiError.notFound('操作不存在')
    return { receipt: { outcome: receipt.outcome, revision: receipt.revision }, authority: { revision: snapshot.revision, event_sequence: snapshot.event_sequence, tasks: [task], side_tasks: snapshot.side_tasks.filter(side => side.parentTaskId === taskId || side.taskId === taskId) }, ...(file.outbox[operationId] ? { mirror: file.outbox[operationId] } : {}) }
  }

  private authoritySnapshot(file: Awaited<ReturnType<ProductTaskAuthorityRepository['read']>>): { revision: number; event_sequence: number; tasks: ProductTaskRecord[]; side_tasks: ProductSideTask[] } {
    return {
      revision: file.revision,
      event_sequence: file.event_sequence,
      tasks: Object.values(file.tasks).map(authorityPublicTask),
      side_tasks: Object.values(file.side_tasks).map((sideTask) => publicSideTask(sideTask as ProductSideTaskMetadata)),
    }
  }

  async submitTaskRun(taskId: string, input: SubmitTaskRunInput): Promise<SubmitTaskRunReceipt> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const referenceEntryIds = input.reference_entry_ids ?? []
    const canonical = JSON.stringify({ task_id: taskId, expected_task_revision: input.expected_task_revision, expected_lineage_revision: input.expected_lineage_revision, text: input.text, attachment_ids: input.attachment_ids, reference_entry_ids: referenceEntryIds, draft_id: input.draft_id, expected_draft_revision: input.expected_draft_revision })
    try {
      const { file, result } = await authority.transactSubmit((state) => {
        const prior = state.receipts[input.client_operation_id]
        if (prior) {
          if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT')
          return { changed: false as const, value: { duplicate: true, receipt: prior } }
        }
        if ((input.draft_id === undefined) !== (input.expected_draft_revision === undefined) || (input.draft_id !== undefined && (!input.draft_id || !Number.isSafeInteger(input.expected_draft_revision) || input.expected_draft_revision! < 0)) || !input.text || !Array.isArray(input.attachment_ids) || input.attachment_ids.length > 4 || new Set(input.attachment_ids).size !== input.attachment_ids.length || referenceEntryIds.length > 8 || new Set(referenceEntryIds).size !== referenceEntryIds.length || referenceEntryIds.some(id => !/^thread_[a-f0-9]{20}$/.test(id))) throw new Error('AUTHORITY_INVALID')
        const stored = state.tasks[taskId] as { task?: Record<string, unknown> } | undefined
        const task = stored?.task
        if (!task || (task.revision ?? 0) !== input.expected_task_revision) throw new Error('AUTHORITY_CONFLICT')
        if (taskRunQueueDepth(state, taskId) >= MAX_TASK_RUN_QUEUE_DEPTH) throw new Error('TASK_QUEUE_FULL')
        let lineageId = task.current_lineage_id as string | undefined
        if (!lineageId) {
          if (input.expected_lineage_revision !== 0) throw new Error('AUTHORITY_CONFLICT')
          lineageId = `lineage_${randomUUID()}`
          state.conversation_lineages[lineageId] = { lineage_id: lineageId, product_task_id: taskId, revision: 0, compact_generation: 0, resume_binding_id: `resume_${randomUUID()}`, state: 'active', created_at: this.now().toISOString(), updated_at: this.now().toISOString() }
          task.current_lineage_id = lineageId
        }
        const lineage = state.conversation_lineages[lineageId] as Record<string, unknown> | undefined
        if (!lineage || lineage.product_task_id !== taskId || lineage.revision !== input.expected_lineage_revision || lineage.state !== 'active') throw new Error('AUTHORITY_CONFLICT')
        const now = this.now().toISOString()
        const attachments = input.attachment_ids.map(id => {
          const attachment = state.task_attachments[id] as Record<string, unknown> | undefined
          if (!attachment || attachment.installation_id !== this.installationId || attachment.state !== 'ready' || Date.parse(attachment.expires_at as string) <= this.now().getTime()) throw new Error('ATTACHMENT_REJECTED')
          if ((attachment.owner_kind === 'product_task' && attachment.owner_id !== taskId) || (attachment.owner_kind === 'composer_draft' && attachment.owner_id !== input.draft_id)) throw new Error('ATTACHMENT_REJECTED')
          return [id, attachment] as const
        })
        if (attachments.reduce((total, [, attachment]) => total + (attachment.byte_size as number), 0) > MAX_TASK_ATTACHMENT_TOTAL_BYTES) throw new Error('ATTACHMENT_REJECTED')
        let draft: Record<string, unknown> | undefined
        if (input.draft_id) {
          draft = state.composer_drafts[input.draft_id] as Record<string, unknown> | undefined
          if (!draft || draft.installation_id !== this.installationId || draft.target_task_id !== taskId || draft.revision !== input.expected_draft_revision || draft.state !== 'active' || Date.parse(draft.expires_at as string) <= this.now().getTime()) throw new Error('DRAFT_REJECTED')
        }
        const scope = state.task_scopes[taskId] as { kind?: unknown; workspace_id?: unknown } | undefined
        const workspace = scope?.kind === 'workspace' && typeof scope.workspace_id === 'string'
          ? state.workspaces[scope.workspace_id] as ProductWorkspace | undefined
          : undefined
        if (!workspace || workspace.installation_id !== this.installationId || workspace.availability !== 'available') {
          throw new Error('WORKSPACE_REQUIRED')
        }
        if (hasUnsettledTaskQueue(state, taskId) || orderedQueuedInputs(state, taskId).length > 0) {
          const queueItemId = `queue_${randomUUID()}`
          const entryId = `entry_${randomUUID()}`
          task.revision = input.expected_task_revision + 1
          task.permission_snapshot = taskPermissionSnapshot(task.permission_snapshot)
          task.updatedAt = now
          state.turn_input_queue[queueItemId] = {
            queue_item_id: queueItemId,
            queue_sequence: state.event_sequence + 1,
            entry_id: entryId,
            task_id: taskId,
            lineage_id: lineageId,
            text: input.text,
            attachment_ids: input.attachment_ids,
            ...(referenceEntryIds.length ? { reference_entry_ids: referenceEntryIds } : {}),
            state: 'queued',
            created_at: now,
            updated_at: now,
          }
          for (const [id, attachment] of attachments) state.task_attachments[id] = { ...attachment, owner_kind: 'product_task', owner_id: taskId, state: 'accepted_bound', refs: [...attachment.refs as string[], taskId], revision: (attachment.revision as number) + 1, last_activity: now }
          if (draft) state.composer_drafts[input.draft_id!] = { ...draft, state: 'consumed', revision: (draft.revision as number) + 1, last_activity: now }
          state.event_sequence += 1
          state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, type: 'queue_updated', queue_item_id: queueItemId, entry_id: entryId, phase: 'queued', text: input.text, attachment_count: input.attachment_ids.length, created_at: now }
          const entity_revisions: Record<string, number> = { task: task.revision as number, lineage: lineage.revision as number }
          for (const id of input.attachment_ids) entity_revisions[id] = (state.task_attachments[id] as { revision: number }).revision
          if (draft) entity_revisions.draft = (state.composer_drafts[input.draft_id!] as { revision: number }).revision
          const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_task_revision, outcome: 'accepted' as const, revision: state.revision + 1, result: { task_id: taskId, queue_item_id: queueItemId, entry_id: entryId, delivery: 'queued' as const, authority_revision: state.revision + 1, entity_revisions } }
          state.receipts[input.client_operation_id] = receipt
          state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'task_input_queue', revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
          return { duplicate: false, receipt }
        }
        const runId = `run_${randomUUID()}`, entryId = `entry_${randomUUID()}`
        const permissionSnapshot = taskPermissionSnapshot(task.permission_snapshot)
        task.revision = input.expected_task_revision + 1
        task.current_lineage_id = lineageId
        task.permission_snapshot = permissionSnapshot
        lineage.head_entry_id = entryId; lineage.revision = input.expected_lineage_revision + 1; lineage.updated_at = now
        state.thread_entries[entryId] = { entry_id: entryId, task_id: taskId, run_id: runId, text: input.text, created_at: now, ...(referenceEntryIds.length ? { reference_entry_ids: referenceEntryIds } : {}) }
        const execution_capability = 'workspace_bound'
        const workDir = typeof lineage.execution_directory === 'string'
          ? lineage.execution_directory
          : workspace.canonical_root
        state.task_runs[runId] = { run_id: runId, task_id: taskId, lineage_id: lineageId, entry_id: entryId, created_at: now, execution_capability, permission_mode: permissionSnapshot.mode, permission_snapshot: permissionSnapshot, provider: null, model: null, event_contract: 'durable_items_v1', core_binding: { resume_binding_id: lineage.resume_binding_id, session_id: randomUUID(), work_dir: workDir, dispatch_generation: 1, context_event_sequence: state.event_sequence } }
        state.dispatch_records[runId] = { run_id: runId, dispatch_generation: 1, state: 'pending' }
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: runId, type: 'user_text', entry_id: entryId, item_id: durableUserItemId(runId), text: input.text, attachment_ids: input.attachment_ids, ...(referenceEntryIds.length ? { reference_entry_ids: referenceEntryIds } : {}), created_at: now }
        for (const [id, attachment] of attachments) { state.task_attachments[id] = { ...attachment, owner_kind: 'product_task', owner_id: taskId, state: 'accepted_bound', refs: [...attachment.refs as string[], taskId], revision: (attachment.revision as number) + 1, last_activity: now }; state.attachment_bindings[id] = { attachment_id: id, task_id: taskId, run_id: runId, entry_id: entryId } }
        if (draft) state.composer_drafts[input.draft_id!] = { ...draft, state: 'consumed', revision: (draft.revision as number) + 1, last_activity: now }
        const entity_revisions: Record<string, number> = { task: task.revision as number, lineage: lineage.revision as number }; for (const id of input.attachment_ids) entity_revisions[id] = (state.task_attachments[id] as { revision: number }).revision; if (draft) entity_revisions.draft = (state.composer_drafts[input.draft_id!] as { revision: number }).revision
        const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_task_revision, outcome: 'accepted' as const, revision: state.revision + 1, result: { task_id: taskId, run_id: runId, entry_id: entryId, dispatch_generation: 1, authority_revision: state.revision + 1, entity_revisions } }
        state.receipts[input.client_operation_id] = receipt
        state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'task_submit', revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
        return { duplicate: false, receipt }
      })
      const receipt = result.receipt
      const snapshot = receipt.result as ({ task_id: string; run_id: string; entry_id: string; dispatch_generation: number; authority_revision: number; entity_revisions: Record<string, number> } | { task_id: string; queue_item_id: string; entry_id: string; delivery: 'queued'; authority_revision: number; entity_revisions: Record<string, number> })
      const response = 'queue_item_id' in snapshot
        ? { client_operation_id: input.client_operation_id, outcome: result.duplicate ? 'duplicate' as const : 'accepted' as const, authority_revision: snapshot.authority_revision, entity_revisions: snapshot.entity_revisions, result: { task_id: snapshot.task_id, queue_item_id: snapshot.queue_item_id, entry_id: snapshot.entry_id, delivery: 'queued' as const } }
        : { client_operation_id: input.client_operation_id, outcome: result.duplicate ? 'duplicate' as const : 'accepted' as const, authority_revision: snapshot.authority_revision, entity_revisions: snapshot.entity_revisions, result: { task_id: snapshot.task_id, run_id: snapshot.run_id, entry_id: snapshot.entry_id, dispatch_generation: snapshot.dispatch_generation, delivery: 'turn' as const } }
      if (!('queue_item_id' in snapshot)) this.dispatchAcceptedRun(snapshot.run_id, snapshot.dispatch_generation)
      return response
    } catch (error) {
      const file = await authority.read()
      return { client_operation_id: input.client_operation_id, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected', authority_revision: file.revision, entity_revisions: {}, error: (error as Error).message }
    }
  }

  async recoverTaskRun(taskId: string, input: {
    expected_revision: number
    client_operation_id: string
    /** Binds explicit human reconciliation to one exact interrupted effect. */
    confirm_outcome_unknown?: { run_id: string; generation: number; operation_id: string }
  }): Promise<{
    task: ProductTaskRecord
    receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number }
    snapshot: { revision: number; event_sequence: number; tasks: ProductTaskRecord[]; side_tasks: ProductSideTask[] }
  }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    if (
      input.confirm_outcome_unknown !== undefined
      && (
        !isTaskRunExternalOperationId(input.confirm_outcome_unknown.operation_id)
        || !Number.isSafeInteger(input.confirm_outcome_unknown.generation)
        || input.confirm_outcome_unknown.generation < 1
        || typeof input.confirm_outcome_unknown.run_id !== 'string'
        || !input.confirm_outcome_unknown.run_id
      )
    ) throw new Error('AUTHORITY_INVALID')
    const canonical = JSON.stringify({
      task_id: taskId,
      expected_revision: input.expected_revision,
      ...(input.confirm_outcome_unknown ? { confirm_outcome_unknown: input.confirm_outcome_unknown } : {}),
    })
    try {
      const { file, result } = await authority.transactSubmit((state) => {
        const prior = state.receipts[input.client_operation_id]
        const stored = state.tasks[taskId] as { task?: ProductTaskRecord } | undefined
        if (!stored?.task) throw new Error('AUTHORITY_INVALID')
        if (prior) {
          if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT')
          return { changed: false as const, value: { duplicate: true, receipt: prior } }
        }
        if (stored.task.revision !== input.expected_revision) throw new Error('AUTHORITY_CONFLICT')
        const recoveryRunId = recoveryRequiredTaskRunId(state, taskId)
        const unknownOutcomeRunId = outcomeUnknownTaskRunId(state, taskId)
        const runId = recoveryRunId ?? unknownOutcomeRunId
        if (unknownOutcomeRunId && !recoveryRunId) {
          const unknownDispatch = state.dispatch_records[unknownOutcomeRunId] as DurableTaskRunDispatch | undefined
          const unknownOperation = unknownDispatch ? primaryUnknownExternalOperation(unknownDispatch) : undefined
          const confirmation = input.confirm_outcome_unknown
          if (!confirmation) throw new Error('OUTCOME_UNKNOWN_CONFIRMATION_REQUIRED')
          if (
            !unknownOperation
            || confirmation.run_id !== unknownOutcomeRunId
            || confirmation.generation !== unknownDispatch?.dispatch_generation
            || confirmation.operation_id !== unknownOperation.operation_id
          ) throw new Error('OUTCOME_UNKNOWN_CONFIRMATION_STALE')
        } else if (input.confirm_outcome_unknown !== undefined) {
          // A UI snapshot can become stale between opening its confirmation
          // dialog and pressing Continue.  Never let that confirmation apply
          // to another run or a normal recovery failure.
          throw new Error('OUTCOME_UNKNOWN_CONFIRMATION_STALE')
        }
        const run = runId ? state.task_runs[runId] as { entry_id?: unknown; event_contract?: unknown; core_binding?: Record<string, unknown> } | undefined : undefined
        const dispatch = runId ? state.dispatch_records[runId] as DurableTaskRunDispatch | undefined : undefined
        if (!runId || typeof run?.entry_id !== 'string' || !run.core_binding || !Number.isSafeInteger(dispatch?.dispatch_generation)) throw new Error('RECOVERY_NOT_REQUIRED')
        const generation = (dispatch!.dispatch_generation as number) + 1
        run.event_contract = 'durable_items_v1'
        run.core_binding = { ...run.core_binding, session_id: randomUUID(), dispatch_generation: generation }
        state.dispatch_records[runId] = { run_id: runId, dispatch_generation: generation, state: 'pending' }
        const now = this.now().toISOString()
        stored.task.revision = input.expected_revision + 1
        stored.task.updatedAt = now
        const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted' as const, revision: state.revision + 1, result: { task_id: taskId, run_id: runId, entry_id: run.entry_id, dispatch_generation: generation } }
        state.receipts[input.client_operation_id] = receipt
        state.event_sequence += 1
        state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'task_run_recover', revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
        return { duplicate: false, receipt }
      })
      const receipt = result.receipt
      const recovered = receipt.result as { run_id: string; dispatch_generation: number }
      this.dispatchAcceptedRun(recovered.run_id, recovered.dispatch_generation)
      const snapshot = this.authoritySnapshot(file)
      return { task: snapshot.tasks.find(task => task.id === taskId)!, receipt: { outcome: result.duplicate ? 'duplicate' : 'accepted', revision: receipt.revision }, snapshot }
    } catch (error) {
      const file = await authority.read()
      const snapshot = this.authoritySnapshot(file)
      const task = snapshot.tasks.find(task => task.id === taskId)
      if (!task) throw ApiError.notFound('任务不存在')
      return { task, receipt: { outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected', revision: file.revision }, snapshot }
    }
  }

  async createAndSubmitTask(input: import('../../../shared/product/domain.js').CreateAndSubmitTaskInput): Promise<import('../../../shared/product/domain.js').SubmitTaskRunReceipt> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonical = JSON.stringify({
      draft_id: input.draft_id,
      expected_draft_revision: input.expected_draft_revision,
      client_operation_id: input.client_operation_id,
      text: input.text,
      attachment_ids: input.attachment_ids,
      permission_mode: input.permission_mode,
    })

    try {
      const { result } = await authority.transactSubmitAsync(async (state) => {
        const prior = state.receipts[input.client_operation_id]
        if (prior) {
          if (state.events[input.client_operation_id]?.canonical_input !== canonical) {
            throw new Error('OPERATION_INPUT_CONFLICT')
          }
          return { changed: false as const, value: { duplicate: true, receipt: prior } }
        }
        if (!input.text || !Array.isArray(input.attachment_ids) || input.attachment_ids.length > 4 || new Set(input.attachment_ids).size !== input.attachment_ids.length) {
          throw new Error('AUTHORITY_INVALID')
        }

        const permissionSnapshot = productPermissionSnapshot(productTaskPermissionMode(input.permission_mode))
        const draft = state.composer_drafts[input.draft_id] as Record<string, unknown> | undefined
        if (!draft || draft.installation_id !== this.installationId || draft.target_state !== 'pending_task' || draft.state !== 'active' || draft.revision !== input.expected_draft_revision || Date.parse(draft.expires_at as string) <= this.now().getTime()) {
          throw new Error('DRAFT_REJECTED')
        }

        const workspaceId = typeof draft.workspace_id === 'string' ? draft.workspace_id : ''
        const workspace = workspaceId ? state.workspaces[workspaceId] as ProductWorkspace | undefined : undefined
        if (!workspace || workspace.installation_id !== this.installationId || workspace.availability !== 'available') {
          throw new Error('WORKSPACE_REQUIRED')
        }
        let inspected: Awaited<ReturnType<WorkspaceFilesystemPort['inspect']>>
        try {
          inspected = await this.workspaceFs.inspect(workspace.canonical_root)
        } catch {
          throw new Error('WORKSPACE_REQUIRED')
        }
        if (
          inspected.availability !== 'available'
          || inspected.identity.platform !== workspace.root_identity.platform
          || inspected.identity.volume_id !== workspace.root_identity.volume_id
          || inspected.identity.file_id !== workspace.root_identity.file_id
        ) {
          throw new Error('WORKSPACE_REQUIRED')
        }

        const taskWorkDir = inspected.canonical_root
        const checkoutRoot = findProductGitRoot(taskWorkDir)
        const projectRoot = findProductCanonicalGitRoot(taskWorkDir) ?? taskWorkDir
        const directoryPath = checkoutRoot && path.resolve(checkoutRoot) !== path.resolve(projectRoot)
          ? projectRoot
          : taskWorkDir
        if (!isSameOrChildPath(projectRoot, directoryPath)) {
          throw new Error('AUTHORITY_INVALID')
        }
        const projectId = projectIdForRoot(this.installationId, projectRoot)
        const directoryId = directoryIdForPath(projectId, directoryPath)
        const taskId = draft.target_task_id as string
        if (state.tasks[taskId]) throw new Error('AUTHORITY_CONFLICT')

        const attachments = input.attachment_ids.map((id) => {
          const attachment = state.task_attachments[id] as Record<string, unknown> | undefined
          if (!attachment || attachment.installation_id !== this.installationId || attachment.owner_kind !== 'composer_draft' || attachment.owner_id !== input.draft_id || attachment.state !== 'ready' || Date.parse(attachment.expires_at as string) <= this.now().getTime()) {
            throw new Error('ATTACHMENT_REJECTED')
          }
          return [id, attachment] as const
        })
        if (attachments.reduce((total, [, attachment]) => total + (attachment.byte_size as number), 0) > MAX_TASK_ATTACHMENT_TOTAL_BYTES) {
          throw new Error('ATTACHMENT_REJECTED')
        }

        const now = this.now().toISOString()
        state.authority_schema_revision = 8
        const existingProject = state.product_projects[projectId] as ProductProjectMetadata | undefined
        if (existingProject && existingProject.rootDir !== projectRoot) throw new Error('AUTHORITY_INVALID')
        if (!existingProject) {
          state.product_projects[projectId] = {
            id: projectId,
            title: productProjectTitle(projectRoot),
            rootDir: projectRoot,
            createdAt: now,
            updatedAt: now,
          }
        }
        const existingDirectory = state.product_directories[directoryId] as ProductProjectDirectoryMetadata | undefined
        if (existingDirectory && (existingDirectory.projectId !== projectId || existingDirectory.path !== directoryPath)) {
          throw new Error('AUTHORITY_INVALID')
        }
        if (!existingDirectory) {
          state.product_directories[directoryId] = {
            id: directoryId,
            projectId,
            path: directoryPath,
            label: productDirectoryLabel(projectRoot, directoryPath),
            createdAt: now,
            updatedAt: now,
          }
        }

        const lineageId = `lineage_${randomUUID()}`
        const runId = `run_${randomUUID()}`
        const entryId = `entry_${randomUUID()}`
        const resumeBindingId = `resume_${randomUUID()}`
        const task = {
          id: taskId,
          projectId,
          directoryId,
          workDir: taskWorkDir,
          title: input.text.slice(0, 120),
          lifecycle: 'active' as const,
          kind: 'main' as const,
          createdAt: now,
          updatedAt: now,
          worktreeState: 'not_requested' as const,
          permission_snapshot: permissionSnapshot,
          actions: ['pin', 'unpin', 'rename', 'continue', 'archive', 'restore'],
          revision: 1,
          task_scope: 'workspace',
          current_lineage_id: lineageId,
        }
        state.tasks[taskId] = { task, binding: { coreSessionId: 'unbound' } }
        state.task_scopes[taskId] = { kind: 'workspace', workspace_id: workspaceId, generation: 1 }
        state.conversation_lineages[lineageId] = {
          lineage_id: lineageId,
          product_task_id: taskId,
          revision: 1,
          compact_generation: 0,
          resume_binding_id: resumeBindingId,
          execution_directory: taskWorkDir,
          state: 'active',
          created_at: now,
          updated_at: now,
          head_entry_id: entryId,
        }
        state.thread_entries[entryId] = { entry_id: entryId, task_id: taskId, run_id: runId, text: input.text, created_at: now }
        state.task_runs[runId] = {
          run_id: runId,
          task_id: taskId,
          lineage_id: lineageId,
          entry_id: entryId,
          created_at: now,
          execution_capability: 'workspace_bound',
          permission_mode: permissionSnapshot.mode,
          permission_snapshot: permissionSnapshot,
          provider: null,
          model: null,
          event_contract: 'durable_items_v1',
          core_binding: {
            resume_binding_id: resumeBindingId,
            session_id: randomUUID(),
            work_dir: taskWorkDir,
            dispatch_generation: 1,
            context_event_sequence: state.event_sequence,
          },
        }
        state.dispatch_records[runId] = { run_id: runId, dispatch_generation: 1, state: 'pending' }
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = {
          event_sequence: state.event_sequence,
          task_id: taskId,
          run_id: runId,
          type: 'user_text',
          entry_id: entryId,
          item_id: durableUserItemId(runId),
          text: input.text,
          attachment_ids: input.attachment_ids,
          created_at: now,
        }
        for (const [id, attachment] of attachments) {
          state.task_attachments[id] = {
            ...attachment,
            owner_kind: 'product_task',
            owner_id: taskId,
            state: 'accepted_bound',
            refs: [...attachment.refs as string[], taskId],
            revision: (attachment.revision as number) + 1,
            last_activity: now,
          }
          state.attachment_bindings[id] = { attachment_id: id, task_id: taskId, run_id: runId, entry_id: entryId }
        }
        state.composer_drafts[input.draft_id] = {
          ...draft,
          state: 'consumed',
          revision: (draft.revision as number) + 1,
          last_activity: now,
        }
        const entity_revisions: Record<string, number> = {
          task: 1,
          lineage: 1,
          workspace: workspace.revision,
          project: 0,
          directory: 0,
          draft: (state.composer_drafts[input.draft_id] as { revision: number }).revision,
        }
        for (const id of input.attachment_ids) {
          entity_revisions[id] = (state.task_attachments[id] as { revision: number }).revision
        }
        const receipt = {
          client_operation_id: input.client_operation_id,
          expected_revision: input.expected_draft_revision,
          outcome: 'accepted' as const,
          revision: state.revision + 1,
          result: {
            task_id: taskId,
            run_id: runId,
            entry_id: entryId,
            dispatch_generation: 1,
            authority_revision: state.revision + 1,
            entity_revisions,
          },
        }
        state.receipts[input.client_operation_id] = receipt
        state.events[input.client_operation_id] = {
          event_sequence: state.event_sequence,
          client_operation_id: input.client_operation_id,
          kind: 'task_create_submit',
          revision: state.revision + 1,
          canonical_input: canonical,
          entity_id: taskId,
          product_task_id: taskId,
        }
        return { duplicate: false, receipt }
      })
      const receipt = result.receipt
      const snapshot = receipt.result as {
        task_id: string
        run_id: string
        entry_id: string
        dispatch_generation: number
        authority_revision: number
        entity_revisions: Record<string, number>
      }
      const response: SubmitTaskRunReceipt = {
        client_operation_id: input.client_operation_id,
        outcome: result.duplicate ? 'duplicate' : 'accepted',
        authority_revision: snapshot.authority_revision,
        entity_revisions: snapshot.entity_revisions,
        result: {
          task_id: snapshot.task_id,
          run_id: snapshot.run_id,
          entry_id: snapshot.entry_id,
          dispatch_generation: snapshot.dispatch_generation,
        },
      }
      this.dispatchAcceptedRun(snapshot.run_id, snapshot.dispatch_generation)
      return response
    } catch (error) {
      const file = await authority.read()
      return {
        client_operation_id: input.client_operation_id,
        outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected',
        authority_revision: file.revision,
        entity_revisions: {},
        error: (error as Error).message,
      }
    }
  }

  /** Durable receipt first, then best-effort server dispatch; never an API-side fake response. */
  private dispatchAcceptedRun(runId: string, generation: number, kind: 'interactive' | 'scheduled' = 'interactive'): void {
    if (!this.dispatcher) return
    void (async () => {
      await this.dispatcher!.dispatch(runId, generation, kind)
    })().catch(() => undefined)
  }

  async listQueuedInputs(taskId: string): Promise<{ items: ProductTaskQueuedInput[] }> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    if (!state.tasks[taskId]) throw ApiError.notFound('任务不存在')
    return { items: publicQueuedInputs(state, taskId) }
  }

  async mutateTaskInputQueue(taskId: string, input: ProductTaskInputQueueMutation): Promise<ProductTaskInputQueueMutationResult> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const normalized = input.action === 'edit' ? { ...input, text: input.text.trim() } : input
    const canonical = JSON.stringify({ task_id: taskId, ...normalized })
    try {
      const { result } = await authority.transactSubmit((state) => {
        const prior = state.receipts[normalized.client_operation_id]
        const stored = state.tasks[taskId] as { task?: Record<string, unknown> } | undefined
        const task = stored?.task
        if (!task) throw new Error('AUTHORITY_INVALID')
        if (prior) {
          if (state.events[normalized.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT')
          return { changed: false as const, value: { duplicate: true, task_revision: task.revision as number, items: publicQueuedInputs(state, taskId), events: [] as ProductTaskEvent[] } }
        }
        if (task.revision !== normalized.expected_task_revision) throw new Error('AUTHORITY_CONFLICT')
        const events: ProductTaskEvent[] = []
        const now = this.now().toISOString()
        if (normalized.action === 'edit') {
          if (!normalized.text || normalized.text.length > 32_000 || !/^queue_[a-f0-9-]{36}$/.test(normalized.queue_item_id)) throw new Error('AUTHORITY_INVALID')
          const item = state.turn_input_queue[normalized.queue_item_id] as DurableTurnInput | undefined
          if (!item || item.task_id !== taskId || item.state !== 'queued' || item.target_run_id) throw new Error('QUEUE_ITEM_LOCKED')
          item.text = normalized.text
          item.updated_at = now
          events.push(appendQueuedInputEvent(state, item, 'queued'))
        } else if (normalized.action === 'delete') {
          if (!/^queue_[a-f0-9-]{36}$/.test(normalized.queue_item_id)) throw new Error('AUTHORITY_INVALID')
          const item = state.turn_input_queue[normalized.queue_item_id] as DurableTurnInput | undefined
          if (!item || item.task_id !== taskId || item.state !== 'queued' || item.target_run_id) throw new Error('QUEUE_ITEM_LOCKED')
          for (const attachmentId of item.attachment_ids) {
            const attachment = state.task_attachments[attachmentId] as Record<string, unknown> | undefined
            if (attachment?.owner_kind === 'product_task' && attachment.owner_id === taskId && attachment.state === 'accepted_bound') {
              state.task_attachments[attachmentId] = { ...attachment, state: 'discarded', revision: (attachment.revision as number) + 1, last_activity: now }
            }
          }
          events.push(appendQueuedInputEvent(state, item, 'cancelled'))
          delete state.turn_input_queue[normalized.queue_item_id]
        } else {
          if (normalized.queue_item_ids.length < 1 || normalized.queue_item_ids.length > MAX_TASK_RUN_QUEUE_DEPTH || new Set(normalized.queue_item_ids).size !== normalized.queue_item_ids.length || normalized.queue_item_ids.some(id => !/^queue_[a-f0-9-]{36}$/.test(id))) throw new Error('AUTHORITY_INVALID')
          const queued = orderedQueuedInputs(state, taskId)
          const editable = queued.filter(item => !item.target_run_id)
          if (editable.length !== normalized.queue_item_ids.length || normalized.queue_item_ids.some(id => !editable.some(item => item.queue_item_id === id))) throw new Error('AUTHORITY_INVALID')
          let sequence = Math.max(0, ...queued.filter(item => item.target_run_id).map(item => item.queue_sequence)) + 1
          for (const queueItemId of normalized.queue_item_ids) {
            const item = state.turn_input_queue[queueItemId] as DurableTurnInput
            item.queue_sequence = sequence++
            item.updated_at = now
            events.push(appendQueuedInputEvent(state, item, 'queued'))
          }
        }
        task.revision = normalized.expected_task_revision + 1
        task.updatedAt = now
        state.receipts[normalized.client_operation_id] = { client_operation_id: normalized.client_operation_id, expected_revision: normalized.expected_task_revision, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: taskId } }
        state.event_sequence += 1
        state.events[normalized.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: normalized.client_operation_id, kind: `task_input_queue_${normalized.action}`, revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
        return { duplicate: false, task_revision: task.revision as number, items: publicQueuedInputs(state, taskId), events }
      })
      for (const event of result.events) this.runtimeEvents.publish(taskId, event)
      return { outcome: result.duplicate ? 'duplicate' : 'accepted', task_revision: result.task_revision, items: result.items }
    } catch (error) {
      const state = await authority.read()
      const revision = (state.tasks[taskId] as { task?: { revision?: unknown } } | undefined)?.task?.revision
      return { outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected', task_revision: Number.isSafeInteger(revision) ? revision as number : 0, items: publicQueuedInputs(state, taskId) }
    }
  }

  async steerTaskInputQueue(taskId: string, input: { queue_item_id: string; expected_task_revision: number; client_operation_id: string }): Promise<ProductTaskInputQueueMutationResult & { delivery: 'steer' | 'queued' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonical = JSON.stringify({ task_id: taskId, ...input })
    try {
      const { result } = await authority.transactSubmit((state) => {
        const prior = state.receipts[input.client_operation_id]
        const stored = state.tasks[taskId] as { task?: Record<string, unknown> } | undefined
        const task = stored?.task
        if (!task) throw new Error('AUTHORITY_INVALID')
        const item = state.turn_input_queue[input.queue_item_id] as DurableTurnInput | undefined
        if (prior) {
          if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT')
          return { changed: false as const, value: { duplicate: true, task_revision: task.revision as number, items: publicQueuedInputs(state, taskId), events: [] as ProductTaskEvent[], target: item?.target_run_id && item.dispatch_generation ? { run_id: item.target_run_id, dispatch_generation: item.dispatch_generation, text: item.text } : undefined } }
        }
        if (task.revision !== input.expected_task_revision) throw new Error('AUTHORITY_CONFLICT')
        if (!/^queue_[a-f0-9-]{36}$/.test(input.queue_item_id) || !item || item.task_id !== taskId || item.state !== 'queued' || item.target_run_id || item.attachment_ids.length > 0) throw new Error('QUEUE_ITEM_LOCKED')
        const active = activeTaskRun(state, taskId)
        if (!active) throw new Error('ACTIVE_RUN_UNAVAILABLE')
        const now = this.now().toISOString()
        item.target_run_id = active.run_id
        item.dispatch_generation = active.dispatch_generation
        item.updated_at = now
        task.revision = input.expected_task_revision + 1
        task.updatedAt = now
        const event = appendQueuedInputEvent(state, item, 'queued')
        state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_task_revision, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: input.queue_item_id } }
        state.event_sequence += 1
        state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'task_input_queue_steer', revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
        return { duplicate: false, task_revision: task.revision as number, items: publicQueuedInputs(state, taskId), events: [event] as ProductTaskEvent[], target: { run_id: active.run_id, dispatch_generation: active.dispatch_generation, text: item.text } }
      })
      for (const event of result.events) this.runtimeEvents.publish(taskId, event)
      if (result.duplicate) return { outcome: 'duplicate', task_revision: result.task_revision, items: result.items, delivery: result.target ? 'steer' : 'queued' }
      const delivered = Boolean(result.target && this.dispatcher?.steer && await this.dispatcher.steer(result.target.run_id, result.target.dispatch_generation, input.queue_item_id, result.target.text).catch(() => false))
      if (delivered) return { outcome: 'accepted', task_revision: result.task_revision, items: result.items, delivery: 'steer' }

      const target = result.target
      const { result: released } = await authority.transactSubmit((state) => {
        const item = state.turn_input_queue[input.queue_item_id] as DurableTurnInput | undefined
        const task = (state.tasks[taskId] as { task?: Record<string, unknown> } | undefined)?.task
        if (!target || !item || !task || item.state !== 'queued' || item.target_run_id !== target.run_id || item.dispatch_generation !== target.dispatch_generation) {
          const taskRevision = task?.revision
          return { changed: false as const, value: { task_revision: Number.isSafeInteger(taskRevision) ? taskRevision as number : result.task_revision, items: publicQueuedInputs(state, taskId), events: [] as ProductTaskEvent[] } }
        }
        delete item.target_run_id
        delete item.dispatch_generation
        item.updated_at = this.now().toISOString()
        task.revision = (task.revision as number) + 1
        task.updatedAt = item.updated_at
        const event = appendQueuedInputEvent(state, item, 'queued')
        return { task_revision: task.revision as number, items: publicQueuedInputs(state, taskId), events: [event] as ProductTaskEvent[] }
      })
      for (const event of released.events) this.runtimeEvents.publish(taskId, event)
      return { outcome: 'accepted', task_revision: released.task_revision, items: released.items, delivery: 'queued' }
    } catch (error) {
      const state = await authority.read()
      const revision = (state.tasks[taskId] as { task?: { revision?: unknown } } | undefined)?.task?.revision
      return { outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected', task_revision: Number.isSafeInteger(revision) ? revision as number : 0, items: publicQueuedInputs(state, taskId), delivery: 'queued' }
    }
  }

  async resumeTaskInputQueue(taskId: string, input: { expected_task_revision: number; client_operation_id: string }): Promise<{
    outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
    task_revision: number
  }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonical = JSON.stringify({ task_id: taskId, expected_task_revision: input.expected_task_revision })
    let result: { duplicate: boolean; task_revision: number }
    try {
      ;({ result } = await authority.transactSubmit((state) => {
        const prior = state.receipts[input.client_operation_id]
        const stored = state.tasks[taskId] as { task?: Record<string, unknown> } | undefined
        const task = stored?.task
        if (!task) throw new Error('AUTHORITY_INVALID')
        if (prior) {
          if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT')
          return { changed: false as const, value: { duplicate: true, task_revision: task.revision as number } }
        }
        if (task.revision !== input.expected_task_revision) throw new Error('AUTHORITY_CONFLICT')
        if (hasUnsettledTaskQueue(state, taskId) || !orderedQueuedInputs(state, taskId)[0]) throw new Error('QUEUE_NOT_PAUSED')
        const now = this.now().toISOString()
        task.revision = input.expected_task_revision + 1
        task.updatedAt = now
        const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_task_revision, outcome: 'accepted' as const, revision: state.revision + 1, result: { entity_id: taskId } }
        state.receipts[input.client_operation_id] = receipt
        state.event_sequence += 1
        state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'task_input_queue_resume', revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
        return { duplicate: false, task_revision: task.revision as number }
      }))
    } catch (error) {
      const state = await authority.read()
      const taskRevision = ((state.tasks[taskId] as { task?: { revision?: unknown } } | undefined)?.task?.revision)
      return {
        outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected',
        task_revision: Number.isSafeInteger(taskRevision) ? taskRevision as number : 0,
      }
    }
    // The resume receipt is authoritative once committed. A transient launch or
    // storage failure must not turn that durable accepted intent into a rejected
    // API response; startup recovery or an idempotent retry can finish promotion.
    try {
      const promoted = await this.promoteNextQueuedInput(taskId)
      if (promoted) this.dispatchAcceptedRun(promoted.run_id, promoted.dispatch_generation)
    } catch {
      // Keep the durable queue intent available for recovery.
    }
    return { outcome: result.duplicate ? 'duplicate' : 'accepted', task_revision: result.task_revision }
  }

  async recordQueuedInputConsumed(runId: string, dispatchGeneration: number, queueItemId: string, executionClaimToken: string): Promise<{ task_id: string; events: ProductTaskEvent[] }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^queue_[a-f0-9-]{36}$/.test(queueItemId) || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; lineage_id?: unknown; event_contract?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      const item = state.turn_input_queue[queueItemId] as DurableTurnInput | undefined
      if (!run || typeof run.task_id !== 'string' || typeof run.lineage_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken) || !item || item.task_id !== run.task_id || item.lineage_id !== run.lineage_id || item.attachment_ids.length > 0) throw new Error('AUTHORITY_INVALID')
      if (item.state === 'injected' && item.target_run_id === runId && item.dispatch_generation === dispatchGeneration) {
        const existing = Object.values(state.task_events).map(value => value as TaskEvent).find(event => event.type === 'queue_updated' && event.queue_item_id === queueItemId && event.phase === 'injected')
        if (!existing) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id, item, queue_sequence: existing.event_sequence, user_sequence: Object.values(state.task_events).map(value => value as TaskEvent).find(event => event.type === 'user_text' && event.entry_id === item.entry_id)?.event_sequence } }
      }
      if (item.state !== 'queued' || item.target_run_id !== runId || item.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      const lineage = state.conversation_lineages[item.lineage_id] as Record<string, unknown> | undefined
      if (!lineage || lineage.product_task_id !== item.task_id || lineage.state !== 'active' || !Number.isSafeInteger(lineage.revision)) throw new Error('AUTHORITY_INVALID')
      const now = this.now().toISOString()
      item.state = 'injected'; item.target_run_id = runId; item.dispatch_generation = dispatchGeneration; item.updated_at = now
      state.thread_entries[item.entry_id] = { entry_id: item.entry_id, task_id: item.task_id, run_id: runId, text: item.text, created_at: item.created_at, ...(item.reference_entry_ids?.length ? { reference_entry_ids: item.reference_entry_ids } : {}) }
      lineage.head_entry_id = item.entry_id; lineage.revision = (lineage.revision as number) + 1; lineage.updated_at = now
      run.event_contract = 'durable_items_v1'
      state.event_sequence += 1
      const queueSequence = state.event_sequence
      state.task_events[String(queueSequence)] = { event_sequence: queueSequence, task_id: item.task_id, type: 'queue_updated', queue_item_id: item.queue_item_id, entry_id: item.entry_id, phase: 'injected', text: item.text, attachment_count: 0, target_run_id: runId, created_at: now }
      state.event_sequence += 1
      const userSequence = state.event_sequence
      state.task_events[String(userSequence)] = { event_sequence: userSequence, task_id: item.task_id, run_id: runId, type: 'user_text', entry_id: item.entry_id, item_id: durableUserItemId(item.entry_id), text: item.text, attachment_ids: [], ...(item.reference_entry_ids?.length ? { reference_entry_ids: item.reference_entry_ids } : {}), created_at: item.created_at }
      return { task_id: item.task_id, item, queue_sequence: queueSequence, user_sequence: userSequence }
    })
    if (!result.user_sequence) throw new Error('AUTHORITY_INVALID')
    return { task_id: result.task_id, events: [
      { type: 'queue_updated', item: publicQueuedInput(result.item), event_sequence: result.queue_sequence },
      { type: 'user_text', id: durableUserItemId(result.item.entry_id), text: result.item.text, replayed: true, event_sequence: result.user_sequence, ...(result.item.reference_entry_ids?.length ? { referenceEntryIds: result.item.reference_entry_ids } : {}) },
    ] }
  }

  async stopActiveTaskRun(taskId: string): Promise<boolean> {
    const target = await this.persistUserTaskRunStop(taskId)
    if (!target) return false
    if (this.dispatcher?.stop) await this.dispatcher.stop(target.run_id, target.dispatch_generation).catch(() => undefined)
    return true
  }

  /**
   * The user-facing stop path owns the first durable stop write.  A local or
   * remote Worker then only consumes this intent with its private claim token;
   * this closes the claim→launch window without granting a second server a
   * generic stop capability.
   */
  private async persistUserTaskRunStop(
    taskId: string,
    exact?: { run_id: string; dispatch_generation: number },
  ): Promise<{ run_id: string; dispatch_generation: number } | undefined> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((state) => {
      let runId: string | undefined
      if (exact) {
        const run = state.task_runs[exact.run_id] as { task_id?: unknown } | undefined
        const dispatch = state.dispatch_records[exact.run_id] as DurableTaskRunDispatch | undefined
        if (run?.task_id !== taskId || dispatch?.dispatch_generation !== exact.dispatch_generation) throw new Error('AUTHORITY_INVALID')
        runId = exact.run_id
      } else {
        const candidates = orderedTaskRunIds(state, taskId).filter(candidate => ['pending', 'claimed', 'started'].includes((state.dispatch_records[candidate] as DurableTaskRunDispatch | undefined)?.state as string))
        runId = candidates.find(candidate => ['claimed', 'started'].includes((state.dispatch_records[candidate] as DurableTaskRunDispatch).state as string)) ?? candidates[0]
      }
      if (!runId) return { changed: false as const, value: undefined }
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (run?.task_id !== taskId || !dispatch || !Number.isSafeInteger(dispatch.dispatch_generation)) throw new Error('AUTHORITY_INVALID')
      if (!['pending', 'claimed', 'started'].includes(dispatch.state as string)) return { changed: false as const, value: undefined }
      if (liveExternalOperations(dispatch).length > 0) {
        const outcome = markDurableTaskRunOutcomeUnknown(state, taskId, runId, dispatch, this.now().toISOString())
        outcomeUnknownEvent = outcome.event
        return { run_id: runId, dispatch_generation: dispatch.dispatch_generation as number }
      }
      if (dispatch.stop_requested_at === undefined) dispatch.stop_requested_at = this.now().toISOString()
      return { run_id: runId, dispatch_generation: dispatch.dispatch_generation as number }
    })
    if (outcomeUnknownEvent) this.runtimeEvents.publish(taskId, outcomeUnknownEvent)
    return result
  }

  /** Freeze the exact extension/tool surface used by one Turn before sampling. */
  async recordTaskRunExtensionSnapshot(
    runId: string,
    dispatchGeneration: number,
    snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number },
    executionClaimToken: string,
  ): Promise<void> {
    if (
      !runId
      || !Number.isSafeInteger(dispatchGeneration)
      || dispatchGeneration < 1
      || !/^[a-f0-9]{64}$/.test(snapshot.digest)
      || [snapshot.tool_count, snapshot.command_count, snapshot.mcp_server_count].some(count => !Number.isSafeInteger(count) || count < 0 || count > 10_000)
      || !isExecutionClaimToken(executionClaimToken)
    ) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { extension_snapshot?: typeof snapshot } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; execution_claim?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown } | undefined
      if (!run || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)) throw new Error('AUTHORITY_INVALID')
      if (run.extension_snapshot) {
        if (JSON.stringify(run.extension_snapshot) !== JSON.stringify(snapshot)) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: undefined }
      }
      run.extension_snapshot = snapshot
    })
  }

  /** Persist one product-safe tool/activity phase before it is published. */
  async recordTaskRunActivity(
    runId: string,
    dispatchGeneration: number,
    activity: Extract<ProductTaskEvent, { type: 'activity' }>,
    executionClaimToken: string,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'activity' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^activity_[a-f0-9]{32}$/.test(activity.id) || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    if (activity.event_sequence !== undefined || activity.replayed !== undefined) throw new Error('AUTHORITY_INVALID')
    if (activity.parentId !== undefined && (!/^activity_[a-f0-9]{32}$/.test(activity.parentId) || activity.parentId === activity.id)) throw new Error('AUTHORITY_INVALID')
    if (activity.progress !== undefined && (
      !Number.isSafeInteger(activity.progress.completed)
      || !Number.isSafeInteger(activity.progress.total)
      || activity.progress.total < 1
      || activity.progress.total > 1_000_000
      || activity.progress.completed < 0
      || activity.progress.completed > activity.progress.total
    )) throw new Error('AUTHORITY_INVALID')
    if (activity.summary !== productTaskActivitySummary(activity.kind, activity.phase)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; event_contract?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; execution_claim?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)) throw new Error('AUTHORITY_INVALID')
      const existing = Object.values(state.task_events)
        .map(value => value as TaskEvent)
        .find((event): event is Extract<TaskEvent, { type: 'activity' }> => event.type === 'activity' && event.run_id === runId && event.dispatch_generation === dispatchGeneration && event.item_id === activity.id && event.phase === activity.phase)
      if (existing) {
        if (
          existing.kind !== activity.kind
          || existing.summary !== activity.summary
          || existing.parent_item_id !== activity.parentId
          || JSON.stringify(existing.progress) !== JSON.stringify(activity.progress)
        ) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id as string } }
      }
      if (Object.values(state.task_events).some(value => {
        const event = value as TaskEvent
        return event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration
      })) throw new Error('AUTHORITY_INVALID')
      run.event_contract = 'durable_items_v1'
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = {
        event_sequence: state.event_sequence,
        task_id: run.task_id,
        run_id: runId,
        type: 'activity',
        dispatch_generation: dispatchGeneration,
        item_id: activity.id,
        ...(activity.parentId ? { parent_item_id: activity.parentId } : {}),
        kind: activity.kind,
        phase: activity.phase,
        summary: activity.summary,
        ...(activity.progress ? { progress: { ...activity.progress } } : {}),
        created_at: this.now().toISOString(),
      }
      return { task_id: run.task_id }
    })
    return { task_id: result.task_id, event: { ...activity } }
  }

  /**
   * The child Worker has actually started.  Write the parent-owned
   * collaboration row before streaming it, so reconnects show the same task
   * tree and a stop race cannot manufacture a child that never ran.
   */
  async recordTaskRunSubtaskStarted(
    runId: string,
    dispatchGeneration: number,
    executionClaimToken: string,
  ): Promise<{ task_id: string; event?: Extract<ProductTaskEvent, { type: 'activity' }> }> {
    if (!/^run_[a-f0-9-]{36}$/.test(runId) || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const child = state.task_runs[runId] as { task_id?: unknown; parent_run_id?: unknown; parent_tool_call_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; execution_claim?: unknown } | undefined
      if (
        !child
        || typeof child.task_id !== 'string'
        || typeof child.parent_run_id !== 'string'
        || typeof child.parent_tool_call_id !== 'string'
        || !dispatch
        || dispatch.dispatch_generation !== dispatchGeneration
        || !['claimed', 'started'].includes(dispatch.state as string)
        || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)
      ) throw new Error('AUTHORITY_INVALID')
      const event = recordSubtaskLifecycleActivity(state, {
        child,
        phase: 'started',
        now: this.now().toISOString(),
      })
      return { task_id: child.task_id, ...(event ? { event } : {}) }
    })
    return result
  }

  /** Persist the accepted TodoWrite projection before it can reach a renderer. */
  async recordTaskRunPlan(
    runId: string,
    dispatchGeneration: number,
    plan: ProductTaskPlan,
    executionClaimToken: string,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'plan_updated' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^plan_[a-f0-9]{32}$/.test(plan.id) || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 100 || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    let inProgress = 0
    for (const step of plan.steps) {
      if (typeof step.content !== 'string' || !step.content.trim() || step.content.length > 500 || !['pending', 'in_progress', 'completed'].includes(step.status)) throw new Error('AUTHORITY_INVALID')
      if (step.status === 'in_progress') inProgress += 1
    }
    if (inProgress > 1) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; event_contract?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; execution_claim?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)) throw new Error('AUTHORITY_INVALID')
      const events = Object.values(state.task_events).map(value => value as TaskEvent)
      const prior = events.find((event): event is Extract<TaskEvent, { type: 'plan_updated' }> => event.type === 'plan_updated' && event.run_id === runId && event.dispatch_generation === dispatchGeneration && event.item_id === plan.id)
      if (prior) {
        if (JSON.stringify(prior.steps) !== JSON.stringify(plan.steps)) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id, event_sequence: prior.event_sequence } }
      }
      if (events.some(event => event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)) throw new Error('AUTHORITY_INVALID')
      run.event_contract = 'durable_items_v1'
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = {
        event_sequence: state.event_sequence,
        task_id: run.task_id,
        run_id: runId,
        type: 'plan_updated',
        dispatch_generation: dispatchGeneration,
        item_id: plan.id,
        steps: plan.steps.map(step => ({ ...step })),
        created_at: this.now().toISOString(),
      }
      return { task_id: run.task_id, event_sequence: state.event_sequence }
    })
    return { task_id: result.task_id, event: { type: 'plan_updated', plan: { id: plan.id, steps: plan.steps.map(step => ({ ...step })) }, event_sequence: result.event_sequence } }
  }

  /** Persist compact lifecycle before the renderer can observe it; summaries remain server-private. */
  async recordTaskRunContextCompaction(
    runId: string,
    dispatchGeneration: number,
    compaction: Extract<AgentWorkerOutbound, { type: 'event'; event: 'context_compaction' }>,
    executionClaimToken: string,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'context_compaction' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !Number.isSafeInteger(compaction.generation) || compaction.generation < 1 || !Number.isSafeInteger(compaction.input_tokens) || compaction.input_tokens < 1 || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    if (compaction.phase === 'completed' && (!compaction.summary.trim() || compaction.summary.length > 40_000 || !Number.isSafeInteger(compaction.output_tokens) || compaction.output_tokens < 1 || !Number.isSafeInteger(compaction.compacted_through_event_sequence) || compaction.compacted_through_event_sequence < 0)) throw new Error('AUTHORITY_INVALID')
    const itemId = durableContextCompactionItemId(runId, dispatchGeneration, compaction.generation)
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as Record<string, unknown> | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; execution_claim?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || typeof run.lineage_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)) throw new Error('AUTHORITY_INVALID')
      const lineage = state.conversation_lineages[run.lineage_id] as Record<string, unknown> | undefined
      if (!lineage || lineage.product_task_id !== run.task_id || !Number.isSafeInteger(lineage.compact_generation) || !Number.isSafeInteger(lineage.revision)) throw new Error('AUTHORITY_INVALID')
      const events = Object.values(state.task_events).map(value => value as TaskEvent)
      const prior = events.find((event): event is Extract<TaskEvent, { type: 'context_compaction' }> => event.type === 'context_compaction' && event.run_id === runId && event.dispatch_generation === dispatchGeneration && event.item_id === itemId && event.phase === compaction.phase)
      const snapshot = state.context_snapshots[run.lineage_id] as DurableContextSnapshot | undefined
      if (prior) {
        if (prior.source !== compaction.source || prior.generation !== compaction.generation || prior.input_tokens !== compaction.input_tokens || prior.output_tokens !== (compaction.phase === 'completed' ? compaction.output_tokens : undefined)) throw new Error('AUTHORITY_INVALID')
        if (compaction.phase === 'completed' && (!snapshot || snapshot.generation !== compaction.generation || snapshot.summary !== compaction.summary || snapshot.compacted_through_event_sequence !== compaction.compacted_through_event_sequence || snapshot.source !== compaction.source || snapshot.input_tokens !== compaction.input_tokens || snapshot.output_tokens !== compaction.output_tokens)) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id as string, event_sequence: prior.event_sequence } }
      }
      if (events.some(event => event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)) throw new Error('AUTHORITY_INVALID')
      const started = events.find((event): event is Extract<TaskEvent, { type: 'context_compaction' }> => event.type === 'context_compaction' && event.run_id === runId && event.dispatch_generation === dispatchGeneration && event.item_id === itemId && event.phase === 'started')
      if (compaction.phase === 'started') {
        if (compaction.generation !== (lineage.compact_generation as number) + 1) throw new Error('AUTHORITY_INVALID')
      } else if (!started || started.source !== compaction.source || started.input_tokens !== compaction.input_tokens) throw new Error('AUTHORITY_INVALID')
      const now = this.now().toISOString()
      if (compaction.phase === 'completed') {
        const cursor = taskRunContextCursor(state, runId, run)
        if (compaction.compacted_through_event_sequence !== cursor || compaction.generation !== (lineage.compact_generation as number) + 1) throw new Error('AUTHORITY_INVALID')
        state.context_snapshots[run.lineage_id] = {
          lineage_id: run.lineage_id,
          task_id: run.task_id,
          generation: compaction.generation,
          summary: compaction.summary,
          compacted_through_event_sequence: cursor,
          source: compaction.source,
          input_tokens: compaction.input_tokens,
          output_tokens: compaction.output_tokens,
          created_at: now,
        } satisfies DurableContextSnapshot
        lineage.compact_generation = compaction.generation
        lineage.revision = (lineage.revision as number) + 1
        lineage.updated_at = now
      }
      run.event_contract = 'durable_items_v1'
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = {
        event_sequence: state.event_sequence,
        task_id: run.task_id,
        run_id: runId,
        type: 'context_compaction',
        dispatch_generation: dispatchGeneration,
        item_id: itemId,
        phase: compaction.phase,
        source: compaction.source,
        generation: compaction.generation,
        input_tokens: compaction.input_tokens,
        ...(compaction.phase === 'completed' ? { output_tokens: compaction.output_tokens } : {}),
        created_at: now,
      }
      return { task_id: run.task_id, event_sequence: state.event_sequence }
    })
    return {
      task_id: result.task_id,
      event: {
        type: 'context_compaction',
        item: { id: itemId, phase: compaction.phase, source: compaction.source, generation: compaction.generation },
        event_sequence: result.event_sequence,
      },
    }
  }

  /** Persist the assistant item and terminal event atomically before completion is published. */
  async recordTaskRunTerminalProjection(
    runId: string,
    dispatchGeneration: number,
    terminalState: 'completed' | 'stopped' | 'recovery_required',
    assistantText: string,
    failure?: ProductTaskRunFailure,
    executionClaimToken?: string,
  ): Promise<{
    task_id: string
    queue_events: ProductTaskEvent[]
    subtask_event?: Extract<ProductTaskEvent, { type: 'activity' }>
  }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !['completed', 'stopped', 'recovery_required'].includes(terminalState) || assistantText.length > MAX_DURABLE_ASSISTANT_TEXT_LENGTH || (failure !== undefined && (!isProductTaskRunFailureCode(failure.code) || failure.retryable !== productTaskRunFailure(failure.code).retryable)) || (terminalState !== 'recovery_required' && failure !== undefined) || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; event_contract?: unknown; parent_run_id?: unknown; parent_tool_call_id?: unknown; subtask_result?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; completed_at?: unknown; error?: unknown; execution_claim?: unknown; external_operations?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      const events = Object.values(state.task_events).map(value => value as TaskEvent)
      const priorTerminal = events.find((event): event is Extract<TaskEvent, { type: 'run_terminal' }> => event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)
      const priorAssistant = events.find((event): event is Extract<TaskEvent, { type: 'assistant_text' }> => event.type === 'assistant_text' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)
      if (priorTerminal) {
        const expectedDispatchState = terminalState === 'recovery_required' ? 'recovery_required' : 'terminal'
        const expectedError = terminalState === 'completed' ? 'TERMINAL' : terminalState === 'stopped' ? 'STOPPED' : failure?.code ?? 'task_failed'
        const priorSubtask = run.parent_run_id === undefined ? undefined : run.subtask_result as { state?: unknown; text?: unknown } | undefined
        if (
          priorTerminal.state !== terminalState
          || (priorAssistant?.text ?? '') !== assistantText
          || dispatch.state !== expectedDispatchState
          || dispatch.error !== expectedError
          || (run.parent_run_id !== undefined && (!priorSubtask || priorSubtask.state !== terminalState || priorSubtask.text !== assistantText))
        ) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id as string, queue_events: [] as ProductTaskEvent[] } }
      }
      if (!['claimed', 'started'].includes(dispatch.state as string) || liveExternalOperations(dispatch).length > 0 || !executionClaimMatches(dispatch, executionClaimToken)) throw new Error('AUTHORITY_INVALID')
      if (priorAssistant && priorAssistant.text !== assistantText) throw new Error('AUTHORITY_INVALID')
      run.event_contract = 'durable_items_v1'
      const now = this.now().toISOString()
      const latestActivities = new Map<string, Extract<TaskEvent, { type: 'activity' }>>()
      for (const event of events
        .filter((candidate): candidate is Extract<TaskEvent, { type: 'activity' }> => candidate.type === 'activity' && candidate.run_id === runId && candidate.dispatch_generation === dispatchGeneration)
        .sort((left, right) => left.event_sequence - right.event_sequence)) latestActivities.set(event.item_id, event)
      for (const activity of latestActivities.values()) {
        if (activity.phase !== 'started' && activity.phase !== 'running') continue
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = {
          event_sequence: state.event_sequence,
          task_id: run.task_id,
          run_id: runId,
          type: 'activity',
          dispatch_generation: dispatchGeneration,
          item_id: activity.item_id,
          kind: activity.kind,
          phase: 'failed',
          summary: productTaskActivitySummary(activity.kind, 'failed'),
          created_at: now,
        }
      }
      if (assistantText && !priorAssistant) {
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = {
          event_sequence: state.event_sequence,
          task_id: run.task_id,
          run_id: runId,
          type: 'assistant_text',
          dispatch_generation: dispatchGeneration,
          item_id: durableAssistantItemId(runId, dispatchGeneration),
          text: assistantText,
          created_at: now,
        }
      }
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = {
        event_sequence: state.event_sequence,
        task_id: run.task_id,
        run_id: runId,
        type: 'run_terminal',
        dispatch_generation: dispatchGeneration,
        item_id: durableTerminalItemId(runId, dispatchGeneration),
        state: terminalState,
        created_at: now,
      }
      dispatch.state = terminalState === 'recovery_required' ? 'recovery_required' : 'terminal'
      dispatch.completed_at = now
      dispatch.error = terminalState === 'completed' ? 'TERMINAL' : terminalState === 'stopped' ? 'STOPPED' : failure?.code ?? 'task_failed'
      let subtaskEvent: Extract<ProductTaskEvent, { type: 'activity' }> | undefined
      if (typeof run.parent_run_id === 'string') {
        run.subtask_result = { state: terminalState, text: assistantText, completed_at: now }
        subtaskEvent = recordSubtaskLifecycleActivity(state, {
          child: run,
          phase: terminalState === 'completed' ? 'completed' : 'failed',
          now,
        })
      }
      delete (dispatch as { execution_claim?: unknown }).execution_claim
      delete (dispatch as { recovery_fence?: unknown }).recovery_fence
      delete (dispatch as { stop_requested_at?: unknown }).stop_requested_at
      const queueEvents = releaseQueuedInputTargets(state, runId, dispatchGeneration, now)
      if (queueEvents.length) {
        const task = (state.tasks[run.task_id] as { task?: Record<string, unknown> } | undefined)?.task
        if (task && Number.isSafeInteger(task.revision)) {
          task.revision = (task.revision as number) + 1
          task.updatedAt = now
        }
      }
      return { task_id: run.task_id, queue_events: queueEvents, ...(subtaskEvent ? { subtask_event: subtaskEvent } : {}) }
    })
    return result
  }

  /** Persist a product-safe Core approval before any renderer can act on it. */
  async recordTaskRunApprovalRequest(
    runId: string,
    dispatchGeneration: number,
    requestId: string,
    action: ProductTaskActionApproval,
    review: AgentWorkerApprovalReviewFacts,
    executionClaimToken: string,
  ): Promise<{ task_id: string; reviewer: 'user' | 'automatic'; event: Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'action' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestId) || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; permission_snapshot?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; approvals?: DurableTaskRunApproval[]; execution_claim?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)) throw new Error('AUTHORITY_INVALID')
      const reviewer = taskPermissionSnapshot(run.permission_snapshot).reviewer
      if (reviewer === 'none') throw new Error('AUTHORITY_INVALID')
      const approvals = dispatch.approvals ??= []
      const existing = approvals.find(approval => approval.request_id === requestId)
      if (existing) {
        if (existing.status !== 'pending' || JSON.stringify(existing.action) !== JSON.stringify(action) || JSON.stringify(existing.review) !== JSON.stringify(review)) throw new Error('AUTHORITY_INVALID')
        const requested = Object.values(state.task_events).map(value => value as TaskEvent).find(candidate => candidate.type === 'approval' && candidate.run_id === runId && candidate.dispatch_generation === dispatchGeneration && candidate.request_id === requestId && candidate.phase === 'requested')
        if (!requested) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id, reviewer } }
      }
      if (approvals.some(approval => approval.status === 'pending')) throw new Error('AUTHORITY_INVALID')
      const now = this.now().toISOString()
      approvals.push({ request_id: requestId, action: { ...action }, review: { ...review }, status: 'pending', requested_at: now })
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = {
        event_sequence: state.event_sequence,
        task_id: run.task_id,
        run_id: runId,
        type: 'approval',
        dispatch_generation: dispatchGeneration,
        item_id: durableApprovalItemId(runId, dispatchGeneration, requestId),
        request_id: requestId,
        phase: 'requested',
        action: { ...action },
        created_at: now,
      }
      return { task_id: run.task_id, reviewer }
    })
    return { task_id: result.task_id, reviewer: result.reviewer, event: { type: 'approval_required', requestId, kind: 'action', action: { ...action } } }
  }

  /** Persist a safe AskUserQuestion projection; raw tool input remains in Harness memory. */
  async recordTaskRunQuestionRequest(
    runId: string,
    dispatchGeneration: number,
    requestId: string,
    questions: ProductTaskQuestion[],
    executionClaimToken: string,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'question' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestId) || questions.length < 1 || questions.length > 8 || JSON.stringify(questions).length > 32_000 || !isExecutionClaimToken(executionClaimToken)) throw new Error('AUTHORITY_INVALID')
    const action: ProductTaskActionApproval = { what: '回答任务中的澄清问题', scope: '当前任务回合', consequence: '回答会作为本回合的后续输入交给 Agent。' }
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; approvals?: DurableTaskRunApproval[]; execution_claim?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)) throw new Error('AUTHORITY_INVALID')
      const approvals = dispatch.approvals ??= []
      const existing = approvals.find(approval => approval.request_id === requestId)
      if (existing) {
        if (existing.status !== 'pending' || JSON.stringify(existing.questions) !== JSON.stringify(questions)) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id } }
      }
      if (approvals.some(approval => approval.status === 'pending')) throw new Error('AUTHORITY_INVALID')
      const now = this.now().toISOString()
      approvals.push({ request_id: requestId, action, questions: structuredClone(questions), status: 'pending', requested_at: now })
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: run.task_id, run_id: runId, type: 'approval', dispatch_generation: dispatchGeneration, item_id: durableApprovalItemId(runId, dispatchGeneration, requestId), request_id: requestId, phase: 'requested', action, created_at: now }
      return { task_id: run.task_id }
    })
    return { task_id: result.task_id, event: { type: 'approval_required', requestId, kind: 'question', questions: structuredClone(questions) } }
  }

  /** Reconnect projection for the only unresolved approval owned by a task. */
  async readPendingTaskApproval(taskId: string): Promise<Extract<ProductTaskEvent, { type: 'approval_required' }> | null> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    if (!state.tasks[taskId]) return null
    let latest: DurableTaskRunApproval | undefined
    for (const [runId, value] of Object.entries(state.dispatch_records)) {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = value as { state?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown; approvals?: DurableTaskRunApproval[] }
      if (run?.task_id !== taskId || !['claimed', 'started'].includes(dispatch.state as string) || dispatch.recovery_fence !== undefined || dispatch.stop_requested_at !== undefined) continue
      const pending = dispatch.approvals?.find(approval => approval.status === 'pending')
      if (pending && (!latest || Date.parse(pending.requested_at) > Date.parse(latest.requested_at))) latest = pending
    }
    return latest
      ? latest.questions
        ? { type: 'approval_required', requestId: latest.request_id, kind: 'question', questions: structuredClone(latest.questions) }
        : { type: 'approval_required', requestId: latest.request_id, kind: 'action', action: { ...latest.action } }
      : null
  }

  /** Durable question answer first, then one fenced response to the matching Harness. */
  async respondToTaskQuestion(taskId: string, requestId: string, answers: readonly string[]): Promise<boolean> {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(requestId) || answers.length < 1 || answers.length > 8 || answers.some(answer => !answer.trim() || answer.length > 4_000)) return false
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      for (const [runId, value] of Object.entries(state.dispatch_records)) {
        const run = state.task_runs[runId] as { task_id?: unknown } | undefined
        const dispatch = value as { dispatch_generation?: unknown; state?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown; approvals?: DurableTaskRunApproval[] }
        if (run?.task_id !== taskId || !Number.isSafeInteger(dispatch.dispatch_generation)) continue
        const approval = dispatch.approvals?.find(candidate => candidate.request_id === requestId && candidate.questions)
        if (!approval) continue
        if (approval.questions!.length !== answers.length) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
        if (approval.status === 'resolved') return { changed: false as const, value: { handled: JSON.stringify(approval.answers) === JSON.stringify(answers), duplicate: true, run_id: runId, generation: dispatch.dispatch_generation as number } }
        if (!['claimed', 'started'].includes(dispatch.state as string) || dispatch.recovery_fence !== undefined || dispatch.stop_requested_at !== undefined) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
        const now = this.now().toISOString()
        approval.status = 'resolved'; approval.decision = 'allowed'; approval.reviewer = 'user'; approval.resolution_reason = 'user_decision'; approval.resolved_at = now; approval.answers = [...answers]
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: runId, type: 'approval', dispatch_generation: dispatch.dispatch_generation as number, item_id: durableApprovalItemId(runId, dispatch.dispatch_generation as number, requestId), request_id: requestId, phase: 'resolved', action: { ...approval.action }, decision: 'allowed', reviewer: 'user', created_at: now }
        return { handled: true, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number }
      }
      return { changed: false as const, value: { handled: false, duplicate: false, run_id: '', generation: 0 } }
    })
    if (!result.handled || result.duplicate) return result.handled
    const delivered = Boolean(this.dispatcher?.answer && await this.dispatcher.answer(result.run_id, result.generation, requestId, answers))
    if (delivered) {
      this.runtimeEvents.publish(taskId, { type: 'status', state: 'working' })
      return true
    }
    this.runtimeEvents.publish(taskId, { type: 'error', code: 'task_unavailable', retryable: false })
    return true
  }

  /** Durable decision first, then one fenced response to the matching worker. */
  async resolveTaskRunApproval(
    taskId: string,
    requestId: string,
    allowed: boolean,
    reviewer: 'user' | 'automatic',
    resolutionReason: DurableTaskRunApproval['resolution_reason'] = reviewer === 'user' ? 'user_decision' : 'unknown_capability',
    executionClaimToken?: string,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(requestId)) return false
    if ((reviewer === 'user') !== (resolutionReason === 'user_decision')) return false
    if (reviewer === 'automatic' && !isExecutionClaimToken(executionClaimToken)) return false
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      for (const [runId, value] of Object.entries(state.dispatch_records)) {
        const run = state.task_runs[runId] as { task_id?: unknown; permission_snapshot?: unknown } | undefined
        const dispatch = value as { dispatch_generation?: unknown; state?: unknown; recovery_fence?: unknown; stop_requested_at?: unknown; execution_claim?: unknown; approvals?: DurableTaskRunApproval[] }
        if (run?.task_id !== taskId || !Number.isSafeInteger(dispatch.dispatch_generation)) continue
        const approval = dispatch.approvals?.find(candidate => candidate.request_id === requestId)
        if (!approval) continue
        if (approval.questions) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
        if (approval.status === 'resolved') return { changed: false as const, value: { handled: approval.decision === (allowed ? 'allowed' : 'denied'), duplicate: true, run_id: runId, generation: dispatch.dispatch_generation as number } }
        const snapshot = taskPermissionSnapshot(run.permission_snapshot)
        if (snapshot.reviewer !== reviewer || !['claimed', 'started'].includes(dispatch.state as string) || dispatch.recovery_fence !== undefined || dispatch.stop_requested_at !== undefined || (reviewer === 'automatic' && !executionClaimMatches(dispatch, executionClaimToken))) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
        approval.status = 'resolved'
        approval.decision = allowed ? 'allowed' : 'denied'
        approval.reviewer = reviewer
        approval.resolution_reason = resolutionReason
        const now = this.now().toISOString()
        approval.resolved_at = now
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = {
          event_sequence: state.event_sequence,
          task_id: taskId,
          run_id: runId,
          type: 'approval',
          dispatch_generation: dispatch.dispatch_generation as number,
          item_id: durableApprovalItemId(runId, dispatch.dispatch_generation as number, requestId),
          request_id: requestId,
          phase: 'resolved',
          action: { ...approval.action },
          decision: approval.decision,
          reviewer,
          created_at: now,
        }
        return { handled: true, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number }
      }
      return { changed: false as const, value: { handled: false, duplicate: false, run_id: '', generation: 0 } }
    })
    if (!result.handled || result.duplicate) return result.handled
    const delivered = Boolean(this.dispatcher?.approve && await this.dispatcher.approve(result.run_id, result.generation, requestId, allowed))
    if (delivered) {
      this.runtimeEvents.publish(taskId, { type: 'status', state: 'working' })
      return true
    }
    if (reviewer === 'automatic') {
      await this.settleTaskRunDispatch(result.run_id, result.generation, 'recovery_required', 'APPROVAL_DELIVERY_UNAVAILABLE', productTaskRunFailure('task_execution_environment_failed'), executionClaimToken)
    }
    this.runtimeEvents.publish(taskId, { type: 'error', code: 'task_unavailable', retryable: false })
    return true
  }

  async respondToTaskApproval(taskId: string, requestId: string, allowed: boolean): Promise<boolean> {
    return this.resolveTaskRunApproval(taskId, requestId, allowed, 'user')
  }

  /** Server-private scheduler state never crosses a product API boundary. */
  workerSchedulerStatePath(): string { return path.join(path.dirname(this.storagePath), 'product-agent-worker-scheduler.json') }

  private async purgeTaskPrivateArtifacts(taskId: string): Promise<void> {
    await this.privateArtifacts.purge({
      taskId,
      storagePath: this.storagePath,
      authorityPath: this.authorityPath,
      authorityRepositoryDeps: this.authorityRepositoryDeps,
    })
  }

  /** Private structured Harness context; renderer and public APIs never read it. */

  /** Cron uses the same durable TaskRun dispatcher, but only after it owns a run. */
  dispatchScheduledTaskRun(runId: string, generation: number): void { this.dispatchAcceptedRun(runId, generation, 'scheduled') }

  /**
   * Server-private cron hand-off.  The schedule occurrence key is durable and
   * idempotent; cron never fabricates a session or falls back to home/cwd.
   */
  async submitScheduledTaskRun(
    scheduleId: string,
    title: string,
    prompt: string,
    workDir: string,
    occurrence: string,
    context: { mode: 'independent' } | { mode: 'related_task'; taskId: string } = { mode: 'independent' },
  ): Promise<{ task_id: string; run_id: string; dispatch_generation: number }> {
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(scheduleId) || !title.trim() || title.length > 160 || !prompt || !occurrence) throw new Error('SCHEDULE_IDENTITY_INVALID')
    if (context.mode === 'related_task' && !context.taskId) throw new Error('SCHEDULE_CONTEXT_INVALID')
    const canonicalWorkDir = await fs.realpath(workDir).catch(() => undefined)
    if (!canonicalWorkDir || !await fs.stat(canonicalWorkDir).then(stat => stat.isDirectory()).catch(() => false)) throw new Error('SCHEDULE_WORKDIR_UNAVAILABLE')
    const inspectedWorkspace = await this.workspaceFs.inspect(canonicalWorkDir)
    if (inspectedWorkspace.canonical_root !== canonicalWorkDir || inspectedWorkspace.availability !== 'available') throw new Error('SCHEDULE_WORKDIR_UNAVAILABLE')
    const operationId = `schedule:${scheduleId}:${occurrence}`
    const permissionSnapshot = productPermissionSnapshot('approve_for_me')
    const workspaceId = `schedule_${scheduleId}`
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const prior = state.receipts[operationId]
      if (prior) {
        const priorResult = prior.result as { task_id?: unknown; run_id?: unknown; dispatch_generation?: unknown }
        if (typeof priorResult.task_id !== 'string' || typeof priorResult.run_id !== 'string' || !Number.isSafeInteger(priorResult.dispatch_generation)) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: priorResult.task_id, run_id: priorResult.run_id, dispatch_generation: priorResult.dispatch_generation as number } }
      }
      const now = this.now().toISOString()
      const taskId = context.mode === 'related_task'
        ? context.taskId
        : `scheduled_${createHash('sha256').update(`${scheduleId}:${occurrence}`).digest('hex').slice(0, 24)}`
      let stored = state.tasks[taskId] as { task?: Record<string, unknown> } | undefined
      let lineageId = stored?.task?.current_lineage_id as string | undefined
      if (context.mode === 'related_task') {
        if (!stored?.task || !lineageId || stored.task.lifecycle !== 'active' || stored.task.workDir !== canonicalWorkDir) throw new Error('SCHEDULE_CONTEXT_UNAVAILABLE')
      } else if (!stored?.task || !lineageId) {
        lineageId = `lineage_${randomUUID()}`
        const task = { id: taskId, projectId: '', directoryId: '', workDir: canonicalWorkDir, title: title.trim(), lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now, worktreeState: 'not_requested', permission_snapshot: permissionSnapshot, actions: ['rename', 'archive'], revision: 1, task_scope: 'workspace', current_lineage_id: lineageId }
        state.tasks[taskId] = { task, binding: { coreSessionId: 'unbound' } }
        state.conversation_lineages[lineageId] = { lineage_id: lineageId, product_task_id: taskId, revision: 0, compact_generation: 0, resume_binding_id: `resume_${randomUUID()}`, state: 'active', created_at: now, updated_at: now }
        stored = state.tasks[taskId] as { task: Record<string, unknown> }
      }
      if (context.mode === 'independent') {
        const priorScope = state.task_scopes[taskId] as { kind?: unknown; workspace_id?: unknown; generation?: unknown } | undefined
        const priorWorkspace = state.workspaces[workspaceId] as ProductWorkspace | undefined
        const workspaceChanged = !priorWorkspace
          || priorWorkspace.canonical_root !== canonicalWorkDir
          || priorWorkspace.root_identity.platform !== inspectedWorkspace.identity.platform
          || priorWorkspace.root_identity.volume_id !== inspectedWorkspace.identity.volume_id
          || priorWorkspace.root_identity.file_id !== inspectedWorkspace.identity.file_id
          || priorWorkspace.availability !== inspectedWorkspace.availability
        if (workspaceChanged) {
          state.workspaces[workspaceId] = {
            workspace_id: workspaceId,
            installation_id: this.installationId,
            canonical_root: canonicalWorkDir,
            root_identity: inspectedWorkspace.identity,
            revision: priorWorkspace ? priorWorkspace.revision + 1 : 0,
            availability: inspectedWorkspace.availability,
            created_at: priorWorkspace?.created_at ?? now,
            updated_at: now,
          }
        }
        state.task_scopes[taskId] = {
          kind: 'workspace',
          workspace_id: workspaceId,
          generation: priorScope?.kind === 'workspace' && priorScope.workspace_id === workspaceId && Number.isSafeInteger(priorScope.generation)
            ? (priorScope.generation as number) + (workspaceChanged && priorWorkspace ? 1 : 0)
            : 0,
        }
      }
      const lineage = state.conversation_lineages[lineageId] as { resume_binding_id: string; revision: number; head_entry_id?: string; updated_at: string }
      const runId = `run_${randomUUID()}`, entryId = `entry_${randomUUID()}`
      state.thread_entries[entryId] = { entry_id: entryId, task_id: taskId, run_id: runId, text: prompt, created_at: now }
      lineage.head_entry_id = entryId
      lineage.revision += 1
      lineage.updated_at = now
      state.task_runs[runId] = { run_id: runId, task_id: taskId, lineage_id: lineageId, entry_id: entryId, created_at: now, execution_capability: 'workspace_bound', permission_mode: permissionSnapshot.mode, permission_snapshot: permissionSnapshot, provider: null, model: null, event_contract: 'durable_items_v1', core_binding: { resume_binding_id: lineage.resume_binding_id, session_id: randomUUID(), work_dir: canonicalWorkDir, dispatch_generation: 1, context_event_sequence: state.event_sequence } }
      state.dispatch_records[runId] = { run_id: runId, dispatch_generation: 1, state: 'pending' }
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: runId, type: 'user_text', entry_id: entryId, item_id: durableUserItemId(runId), text: prompt, attachment_ids: [], created_at: now }
      const result = { task_id: taskId, run_id: runId, dispatch_generation: 1 }
      state.receipts[operationId] = { client_operation_id: operationId, expected_revision: 0, outcome: 'accepted', revision: state.revision + 1, result: { task_id: taskId, run_id: runId, entry_id: entryId, dispatch_generation: 1 } }
      state.events[operationId] = { event_sequence: state.event_sequence, client_operation_id: operationId, kind: 'schedule_submit', revision: state.revision + 1, canonical_input: JSON.stringify({ scheduleId, occurrence, grant: 'workdir_workspace_write_v1' }), entity_id: taskId, product_task_id: taskId }
      return result
    })
    this.dispatchScheduledTaskRun(result.run_id, result.dispatch_generation)
    return result
  }

  async stopScheduledTaskRun(runId: string, dispatchGeneration: number): Promise<boolean> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = state.task_runs[runId] as { task_id?: unknown } | undefined
    const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
    if (typeof run?.task_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
    const target = await this.persistUserTaskRunStop(run.task_id, { run_id: runId, dispatch_generation: dispatchGeneration })
    if (!target) return false
    if (this.dispatcher?.stop) await this.dispatcher.stop(target.run_id, target.dispatch_generation).catch(() => undefined)
    return true
  }

  /** Server-private terminal projection for the schedule history/notification adapter. */
  async inspectScheduledTaskRun(runId: string, dispatchGeneration: number): Promise<{
    state: 'running' | 'completed' | 'failed' | 'cancelled'
    completed_at?: string
  }> {
    const file = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = file.task_runs[runId] as { task_id?: unknown } | undefined
    const dispatch = file.dispatch_records[runId] as DurableTaskRunDispatch | undefined
    if (typeof run?.task_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
    if (dispatch.state === 'terminal') {
      if (dispatch.error === 'STOPPED') {
        return { state: 'cancelled', ...(typeof dispatch.completed_at === 'string' ? { completed_at: dispatch.completed_at } : {}) }
      }
      return dispatch.error === 'TERMINAL'
        ? { state: 'completed', ...(typeof dispatch.completed_at === 'string' ? { completed_at: dispatch.completed_at } : {}) }
        : { state: 'failed', ...(typeof dispatch.completed_at === 'string' ? { completed_at: dispatch.completed_at } : {}) }
    }
    if (dispatch.state === 'recovery_required' || dispatch.state === 'outcome_unknown') {
      return { state: 'failed', ...(typeof dispatch.completed_at === 'string' ? { completed_at: dispatch.completed_at } : {}) }
    }
    return { state: 'running' }
  }

  /**
   * Read the durable BB-02C user-event ledger.  The operation audit map is
   * intentionally not visible here: reconnect cursors are keyed only by the
   * permanent task-event sequence.
   */
  async listTaskEvents(taskId: string, afterEventSequence = 0, limit = 200): Promise<{ events: Array<TaskEvent & { attachments?: ProductTaskAttachmentSummary[]; failure?: ProductTaskRunFailure }>; cursor: number; has_more?: true }> {
    if (!Number.isSafeInteger(afterEventSequence) || afterEventSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw ApiError.badRequest('事件游标无效')
    }
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const state = await authority.read()
    if (!state.tasks[taskId]) throw ApiError.notFound('任务不存在')
    const privateSubtaskRuns = new Set(
      Object.values(state.task_runs)
        .map(run => run as { run_id?: unknown; parent_run_id?: unknown })
        .filter((run): run is { run_id: string; parent_run_id: string } => typeof run.run_id === 'string' && typeof run.parent_run_id === 'string')
        .map(run => run.run_id),
    )
    const matchingEvents = Object.values(state.task_events)
      .map((event) => event as TaskEvent)
      .filter((event) => event.task_id === taskId && event.event_sequence > afterEventSequence && (!('run_id' in event) || !privateSubtaskRuns.has(event.run_id)))
      .sort((left, right) => left.event_sequence - right.event_sequence)
    const durableEvents = matchingEvents.slice(0, limit)
    const hasMore = matchingEvents.length > durableEvents.length
    const events = await Promise.all(durableEvents.map(async event => {
      if (event.type === 'run_terminal') {
        const dispatch = state.dispatch_records[event.run_id] as { error?: unknown } | undefined
        const failure = event.state === 'recovery_required' && isProductTaskRunFailureCode(dispatch?.error)
          ? productTaskRunFailure(dispatch.error)
          : event.state === 'recovery_required'
            ? productTaskRunFailure('task_failed')
            : undefined
        return { ...event, ...(failure ? { failure } : {}) }
      }
      if (event.type !== 'user_text') return { ...event }
      const attachments = await Promise.all(event.attachment_ids.map(async attachmentId => {
        const attachment = state.task_attachments[attachmentId] as { content_hash?: unknown; byte_size?: unknown; verified_media_type?: unknown } | undefined
        if (!attachment || typeof attachment.content_hash !== 'string' || typeof attachment.byte_size !== 'number' || typeof attachment.verified_media_type !== 'string') return null
        try {
          const filePath = await resolveProductAttachmentCopy(productAttachmentStorageRoot(this.storagePath), attachmentId, attachment.content_hash, attachment.byte_size)
          return productAttachmentSummary(filePath, attachment.verified_media_type)
        } catch {
          return attachment.verified_media_type.startsWith('image/')
            ? { type: 'image' as const, name: '图片附件' }
            : { type: 'file' as const, name: '文件附件' }
        }
      }))
      const visibleAttachments = [
        ...attachments.filter((attachment): attachment is ProductTaskAttachmentSummary => attachment !== null),
        ...(event.attachment_summaries ?? []),
      ]
      return { ...event, item_id: event.item_id ?? durableUserItemId(event.run_id), attachment_ids: [...event.attachment_ids], ...(visibleAttachments.length ? { attachments: visibleAttachments } : {}) }
    }))
    const cursor = hasMore && durableEvents.length > 0
      ? durableEvents[durableEvents.length - 1]!.event_sequence
      : state.event_sequence
    return { events, cursor, ...(hasMore ? { has_more: true as const } : {}) }
  }

  /**
   * The only durable execution hand-off for a BB-02C TaskRun.  Claiming is
   * idempotent and never creates entries, runs, lineages or product events.
   */
  async inspectTaskRunQueuePosition(runId: string, dispatchGeneration: number): Promise<'ready' | 'queued'> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = state.task_runs[runId] as DurableTaskRun | undefined
    const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
    if (typeof run?.task_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || dispatch.state !== 'pending') throw new Error('AUTHORITY_INVALID')
    if (typeof run.parent_run_id === 'string') return 'ready'
    return nextTaskRunId(state, run.task_id) === runId ? 'ready' : 'queued'
  }

  async claimTaskRunDispatch(runId: string, dispatchGeneration: number, executionClaimToken: string): Promise<{ outcome: 'claimed' | 'duplicate' | 'queued' | 'recovery_required'; task_id: string }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken)) {
      throw ApiError.badRequest('运行派发参数无效')
    }
    const binding = productTextReasoningBinding()
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; provider?: unknown; model?: unknown; model_route_fingerprint?: unknown; parent_run_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as {
        dispatch_generation?: unknown
        state?: unknown
        claimed_at?: unknown
        stop_requested_at?: unknown
        recovery_fence?: unknown
        execution_claim?: unknown
      } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) {
        throw new Error('AUTHORITY_INVALID')
      }
      if (dispatch.stop_requested_at !== undefined) {
        return { changed: false as const, value: { outcome: 'recovery_required' as const, task_id: run.task_id } }
      }
      // A supervisor may have stopped the local Worker but still be writing
      // its exact terminal projection. Never claim through that restart fence.
      if (dispatch.recovery_fence !== undefined) {
        return { changed: false as const, value: { outcome: 'recovery_required' as const, task_id: run.task_id } }
      }
      if (dispatch.state === 'pending') {
        if (run.parent_run_id === undefined && nextTaskRunId(state, run.task_id) !== runId) return { changed: false as const, value: { outcome: 'queued' as const, task_id: run.task_id } }
        run.provider = binding.provider
        run.model = binding.model
        run.model_route_fingerprint = binding.fingerprint
        dispatch.state = 'claimed'
        dispatch.claimed_at = this.now().toISOString()
        dispatch.execution_claim = { claim_token: executionClaimToken, claimed_at: dispatch.claimed_at }
        return { outcome: 'claimed' as const, task_id: run.task_id }
      }
      if (dispatch.state === 'claimed' || dispatch.state === 'started') {
        if (typeof run.provider !== 'string' || typeof run.model !== 'string' || !/^[a-f0-9]{64}$/.test(String(run.model_route_fingerprint ?? ''))) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { outcome: 'duplicate' as const, task_id: run.task_id } }
      }
      return { changed: false as const, value: { outcome: 'recovery_required' as const, task_id: run.task_id } }
    })
    return result
  }

  /**
   * Write a restart-safe fence before a Worker is stopped or its scheduler
   * lease is released.  The fence intentionally resolves to recovery_required
   * after a restart unless an exact terminal projection commits first.
   */
  async prepareTaskRunRecoveryFence(runId: string, dispatchGeneration: number, failure: ProductTaskRunFailure, executionClaimToken?: string): Promise<'prepared' | 'already_settled' | 'outcome_unknown' | 'not_owner'> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isProductTaskRunFailureCode(failure.code) || failure.retryable !== productTaskRunFailure(failure.code).retryable || (executionClaimToken !== undefined && !isExecutionClaimToken(executionClaimToken))) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownTaskId: string | undefined
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      if (dispatch.state === 'terminal' || dispatch.state === 'recovery_required') return { changed: false as const, value: 'already_settled' as const }
      if (dispatch.state === 'outcome_unknown') return { changed: false as const, value: 'outcome_unknown' as const }
      if (!['pending', 'claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
      if (dispatch.execution_claim !== undefined && !executionClaimMatches(dispatch, executionClaimToken)) return { changed: false as const, value: 'not_owner' as const }
      if (dispatch.execution_claim === undefined && dispatch.state !== 'pending') return { changed: false as const, value: 'not_owner' as const }
      if (dispatch.execution_claim === undefined && dispatch.stop_requested_at === undefined) return { changed: false as const, value: 'not_owner' as const }
      if (liveExternalOperations(dispatch).length > 0) {
        const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, this.now().toISOString())
        outcomeUnknownTaskId = run.task_id
        outcomeUnknownEvent = outcome.event
        return 'outcome_unknown' as const
      }
      const prior = dispatch.recovery_fence as { failure?: ProductTaskRunFailure } | undefined
      if (prior) {
        if (prior.failure?.code !== failure.code || prior.failure.retryable !== failure.retryable) return { changed: false as const, value: 'not_owner' as const }
        return { changed: false as const, value: 'prepared' as const }
      }
      dispatch.recovery_fence = { failure, created_at: this.now().toISOString() }
      return 'prepared' as const
    })
    if (outcomeUnknownEvent && outcomeUnknownTaskId) this.runtimeEvents.publish(outcomeUnknownTaskId, outcomeUnknownEvent)
    return result
  }

  /**
   * Executor-side acknowledgement of an already-durable user stop.  Only a
   * matching claimed owner may create the intent; a pending run may only
   * observe an intent that ProductTaskService persisted for the user first.
   */
  async requestTaskRunStop(runId: string, dispatchGeneration: number, executionClaimToken?: string): Promise<'requested' | 'already_settled' | 'not_owner'> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || (executionClaimToken !== undefined && !isExecutionClaimToken(executionClaimToken))) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownTaskId: string | undefined
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      if (dispatch.state === 'terminal' || dispatch.state === 'recovery_required' || dispatch.state === 'outcome_unknown') return { changed: false as const, value: 'already_settled' as const }
      if (!['pending', 'claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
      if (dispatch.execution_claim !== undefined) {
        if (!executionClaimMatches(dispatch, executionClaimToken)) return { changed: false as const, value: 'not_owner' as const }
      } else if (dispatch.state !== 'pending' || dispatch.stop_requested_at === undefined) {
        return { changed: false as const, value: 'not_owner' as const }
      }
      if (liveExternalOperations(dispatch).length > 0) {
        const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, this.now().toISOString())
        outcomeUnknownTaskId = run.task_id
        outcomeUnknownEvent = outcome.event
        return 'requested' as const
      }
      if (dispatch.stop_requested_at !== undefined) return { changed: false as const, value: 'requested' as const }
      dispatch.stop_requested_at = this.now().toISOString()
      return 'requested' as const
    })
    if (outcomeUnknownEvent && outcomeUnknownTaskId) this.runtimeEvents.publish(outcomeUnknownTaskId, outcomeUnknownEvent)
    return result
  }

  /** Advance exactly one pending intent after the preceding run is durably terminal. */
  async advanceTaskRunQueue(runId: string, dispatchGeneration: number): Promise<void> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = state.task_runs[runId] as DurableTaskRun | undefined
    const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
    const terminal = Object.values(state.task_events).map(value => value as TaskEvent).find((event): event is Extract<TaskEvent, { type: 'run_terminal' }> => event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)
    if (typeof run?.task_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || dispatch.state !== 'terminal' || terminal?.state !== 'completed') return
    const nextRunId = nextTaskRunId(state, run.task_id)
    if (nextRunId) {
      const next = state.dispatch_records[nextRunId] as { dispatch_generation: number }
      this.dispatchAcceptedRun(nextRunId, next.dispatch_generation)
      return
    }
    const promoted = await this.promoteNextQueuedInput(run.task_id)
    if (promoted) this.dispatchAcceptedRun(promoted.run_id, promoted.dispatch_generation)
  }

  private async promoteNextQueuedInput(taskId: string): Promise<{ run_id: string; dispatch_generation: number } | undefined> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      if (hasUnsettledTaskQueue(state, taskId)) return { changed: false as const, value: undefined }
      const item = orderedQueuedInputs(state, taskId)[0]
      if (!item) return { changed: false as const, value: undefined }
      const stored = state.tasks[taskId] as { task?: Record<string, unknown> } | undefined
      const task = stored?.task
      const lineage = state.conversation_lineages[item.lineage_id] as Record<string, unknown> | undefined
      if (!task || task.current_lineage_id !== item.lineage_id || !lineage || lineage.product_task_id !== taskId || lineage.state !== 'active' || typeof lineage.resume_binding_id !== 'string' || !Number.isSafeInteger(lineage.revision)) {
        item.state = 'failed'; item.updated_at = this.now().toISOString()
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, type: 'queue_updated', queue_item_id: item.queue_item_id, entry_id: item.entry_id, phase: 'failed', text: item.text, attachment_count: item.attachment_ids.length, created_at: item.updated_at }
        return undefined
      }
      for (const attachmentId of item.attachment_ids) {
        const attachment = state.task_attachments[attachmentId] as Record<string, unknown> | undefined
        if (!attachment || attachment.owner_kind !== 'product_task' || attachment.owner_id !== taskId || attachment.state !== 'accepted_bound') {
          item.state = 'failed'; item.updated_at = this.now().toISOString()
          state.event_sequence += 1
          state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, type: 'queue_updated', queue_item_id: item.queue_item_id, entry_id: item.entry_id, phase: 'failed', text: item.text, attachment_count: item.attachment_ids.length, created_at: item.updated_at }
          return undefined
        }
      }
      const now = this.now().toISOString()
      const runId = `run_${randomUUID()}`
      const permissionSnapshot = taskPermissionSnapshot(task.permission_snapshot)
      const scope = state.task_scopes[taskId] as { kind?: unknown; workspace_id?: unknown } | undefined
      const workspace = scope?.kind === 'workspace' && typeof scope.workspace_id === 'string'
        ? state.workspaces[scope.workspace_id] as ProductWorkspace | undefined
        : undefined
      if (!workspace || workspace.installation_id !== this.installationId || workspace.availability !== 'available') {
        item.state = 'failed'
        item.updated_at = now
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, type: 'queue_updated', queue_item_id: item.queue_item_id, entry_id: item.entry_id, phase: 'failed', text: item.text, attachment_count: item.attachment_ids.length, created_at: now }
        return undefined
      }
      const executionCapability = 'workspace_bound'
      const workDir = typeof lineage.execution_directory === 'string'
        ? lineage.execution_directory
        : workspace.canonical_root
      state.thread_entries[item.entry_id] = { entry_id: item.entry_id, task_id: taskId, run_id: runId, text: item.text, created_at: item.created_at, ...(item.reference_entry_ids?.length ? { reference_entry_ids: item.reference_entry_ids } : {}) }
      state.task_runs[runId] = { run_id: runId, task_id: taskId, lineage_id: item.lineage_id, entry_id: item.entry_id, created_at: now, execution_capability: executionCapability, permission_mode: permissionSnapshot.mode, permission_snapshot: permissionSnapshot, provider: null, model: null, event_contract: 'durable_items_v1', core_binding: { resume_binding_id: lineage.resume_binding_id, session_id: randomUUID(), work_dir: workDir, dispatch_generation: 1, context_event_sequence: state.event_sequence } }
      state.dispatch_records[runId] = { run_id: runId, dispatch_generation: 1, state: 'pending' }
      for (const attachmentId of item.attachment_ids) state.attachment_bindings[attachmentId] = { attachment_id: attachmentId, task_id: taskId, run_id: runId, entry_id: item.entry_id }
      item.state = 'promoted'; item.target_run_id = runId; item.dispatch_generation = 1; item.updated_at = now
      lineage.head_entry_id = item.entry_id; lineage.revision = (lineage.revision as number) + 1; lineage.updated_at = now
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, type: 'queue_updated', queue_item_id: item.queue_item_id, entry_id: item.entry_id, phase: 'promoted', text: item.text, attachment_count: item.attachment_ids.length, target_run_id: runId, created_at: now }
      state.event_sequence += 1
      state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: runId, type: 'user_text', entry_id: item.entry_id, item_id: durableUserItemId(item.entry_id), text: item.text, attachment_ids: item.attachment_ids, ...(item.reference_entry_ids?.length ? { reference_entry_ids: item.reference_entry_ids } : {}), created_at: item.created_at }
      return { run_id: runId, dispatch_generation: 1 }
    })
    return result
  }

  /**
   * Rehydrate only never-started queue heads. Interrupted claimed runs become
   * recovery blockers so a restart cannot replay an unknown Core side effect.
   */
  recoverDurableTaskRunQueue(leaseInspector?: ProductTaskRunRecoveryLeaseInspector): Promise<void> {
    if (this.taskRunQueueRecovery) return this.taskRunQueueRecovery
    const recovery = this.performTaskRunQueueRecovery(leaseInspector)
    this.taskRunQueueRecovery = recovery
    void recovery.then(
      () => { if (this.taskRunQueueRecovery === recovery) this.taskRunQueueRecovery = undefined },
      () => { if (this.taskRunQueueRecovery === recovery) this.taskRunQueueRecovery = undefined },
    )
    return recovery
  }

  private async performTaskRunQueueRecovery(leaseInspector?: ProductTaskRunRecoveryLeaseInspector): Promise<void> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    type RecoveryCandidate = {
      run_id: string
      generation: number
      kind: 'pending_stop' | 'lost_claim'
      execution_claim_token?: string
    }
    const snapshot = await authority.read()
    const candidates = new Map<string, RecoveryCandidate>()
    let retryAfterLiveLease = false
    for (const [runId, value] of Object.entries(snapshot.dispatch_records)) {
      const dispatch = value as DurableTaskRunDispatch
      if (!Number.isSafeInteger(dispatch.dispatch_generation)) throw new Error('AUTHORITY_INVALID')
      const generation = dispatch.dispatch_generation as number
      const key = `${runId}:${generation}`
      if (dispatch.state === 'pending') {
        if (dispatch.stop_requested_at !== undefined) candidates.set(key, { run_id: runId, generation, kind: 'pending_stop' })
        continue
      }
      if (!['claimed', 'started'].includes(dispatch.state as string)) continue
      const claim = dispatch.execution_claim
      if (!claim || !isExecutionClaimToken(claim.claim_token)) throw new Error('AUTHORITY_INVALID')
      let liveLease = true
      try {
        liveLease = leaseInspector ? await leaseInspector.hasLiveTaskRunLease(runId, generation) : true
      } catch {
        liveLease = true
      }
      if (liveLease) {
        retryAfterLiveLease = true
        continue
      }
      candidates.set(key, { run_id: runId, generation, kind: 'lost_claim', execution_claim_token: claim.claim_token })
    }
    const outcomeUnknownEvents: Array<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> }> = []
    const { result: recovery } = await authority.transactSubmit((state) => {
      let changed = false
      const now = this.now().toISOString()
      for (const [runId, value] of Object.entries(state.dispatch_records)) {
        const dispatch = value as DurableTaskRunDispatch
        if (!Number.isSafeInteger(dispatch.dispatch_generation)) throw new Error('AUTHORITY_INVALID')
        const dispatchGeneration = dispatch.dispatch_generation as number
        const candidate = candidates.get(`${runId}:${dispatchGeneration}`)
        if (!candidate) continue
        const run = state.task_runs[runId] as DurableTaskRun | undefined
        if (!run || typeof run.task_id !== 'string') throw new Error('AUTHORITY_INVALID')
        if (candidate.kind === 'pending_stop') {
          if (dispatch.state !== 'pending' || dispatch.stop_requested_at === undefined || dispatch.execution_claim !== undefined) continue
          const terminalExists = Object.values(state.task_events).some(value => {
            const event = value as TaskEvent
            return event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration
          })
          if (!terminalExists) {
            run.event_contract = 'durable_items_v1'
            state.event_sequence += 1
            state.task_events[String(state.event_sequence)] = {
              event_sequence: state.event_sequence,
              task_id: run.task_id,
              run_id: runId,
              type: 'run_terminal',
              dispatch_generation: dispatchGeneration,
              item_id: durableTerminalItemId(runId, dispatchGeneration),
              state: 'stopped',
              created_at: now,
            }
          }
          dispatch.state = 'terminal'
          dispatch.completed_at = now
          dispatch.error = 'STOPPED'
          delete dispatch.stop_requested_at
          delete dispatch.recovery_fence
          const queueEvents = releaseQueuedInputTargets(state, runId, dispatchGeneration, now)
          if (queueEvents.length) {
            const task = (state.tasks[run.task_id] as { task?: Record<string, unknown> } | undefined)?.task
            if (task && Number.isSafeInteger(task.revision)) {
              task.revision = (task.revision as number) + 1
              task.updatedAt = now
            }
          }
          changed = true
          continue
        }
        if (!['claimed', 'started'].includes(dispatch.state as string) || !executionClaimMatches(dispatch, candidate.execution_claim_token)) continue
        if (liveExternalOperations(dispatch).length > 0) {
          const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, now)
          outcomeUnknownEvents.push({ task_id: run.task_id, event: outcome.event })
          changed ||= outcome.changed
          continue
        }
        const recoveryFence = dispatch.recovery_fence
        const terminalExists = Object.values(state.task_events).some(value => {
          const event = value as TaskEvent
          return event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration
        })
        if (!terminalExists) {
          run.event_contract = 'durable_items_v1'
          const latestActivities = new Map<string, Extract<TaskEvent, { type: 'activity' }>>()
          for (const event of Object.values(state.task_events)
            .map(value => value as TaskEvent)
            .filter((event): event is Extract<TaskEvent, { type: 'activity' }> => event.type === 'activity' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)
            .sort((left, right) => left.event_sequence - right.event_sequence)) {
            latestActivities.set(event.item_id, event)
          }
          for (const activity of latestActivities.values()) {
            if (activity.phase !== 'started' && activity.phase !== 'running') continue
            state.event_sequence += 1
            state.task_events[String(state.event_sequence)] = {
              event_sequence: state.event_sequence,
              task_id: run.task_id,
              run_id: runId,
              type: 'activity',
              dispatch_generation: dispatchGeneration,
              item_id: activity.item_id,
              kind: activity.kind,
              phase: 'failed',
              summary: productTaskActivitySummary(activity.kind, 'failed'),
              created_at: now,
            }
          }
          state.event_sequence += 1
          state.task_events[String(state.event_sequence)] = {
            event_sequence: state.event_sequence,
            task_id: run.task_id,
            run_id: runId,
            type: 'run_terminal',
            dispatch_generation: dispatchGeneration,
            item_id: durableTerminalItemId(runId, dispatchGeneration),
            state: 'recovery_required',
            created_at: now,
          }
        }
        dispatch.state = 'recovery_required'
        dispatch.completed_at = now
        dispatch.error = recoveryFence?.failure.code ?? 'task_execution_environment_failed'
        delete dispatch.execution_claim
        delete dispatch.recovery_fence
        delete dispatch.stop_requested_at
        const queueEvents = releaseQueuedInputTargets(state, runId, dispatchGeneration, now)
        if (queueEvents.length) {
          const task = (state.tasks[run.task_id] as { task?: Record<string, unknown> } | undefined)?.task
          if (task && Number.isSafeInteger(task.revision)) {
            task.revision = (task.revision as number) + 1
            task.updatedAt = now
          }
        }
        changed = true
      }
      const taskIds = new Set([
        ...Object.values(state.task_runs).map(value => (value as DurableTaskRun).task_id),
        ...Object.values(state.turn_input_queue).map(value => (value as DurableTurnInput).task_id),
      ].filter((value): value is string => typeof value === 'string'))
      const pending: string[] = []
      const promotable: string[] = []
      for (const taskId of taskIds) {
        const pendingRun = nextTaskRunId(state, taskId)
        if (pendingRun) {
          pending.push(pendingRun)
          continue
        }
        if (hasUnsettledTaskQueue(state, taskId) || !orderedQueuedInputs(state, taskId)[0]) continue
        const latestTerminal = Object.values(state.task_events)
          .map(value => value as TaskEvent)
          .filter(event => event.type === 'run_terminal' && event.task_id === taskId)
          .sort((left, right) => right.event_sequence - left.event_sequence)[0]
        if (latestTerminal?.type === 'run_terminal' && latestTerminal.state === 'completed') promotable.push(taskId)
      }
      const value = { pending, promotable }
      return changed ? value : { changed: false as const, value }
    })
    for (const outcome of outcomeUnknownEvents) this.runtimeEvents.publish(outcome.task_id, outcome.event)
    for (const taskId of recovery.promotable) {
      const promoted = await this.promoteNextQueuedInput(taskId)
      if (promoted) recovery.pending.push(promoted.run_id)
    }
    for (const runId of [...new Set(recovery.pending)]) {
      const state = await authority.read()
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown } | undefined
      if (Number.isSafeInteger(dispatch?.dispatch_generation)) this.dispatchAcceptedRun(runId, dispatch!.dispatch_generation as number)
    }
    if (retryAfterLiveLease) this.scheduleTaskRunQueueRecovery(leaseInspector)
  }

  private scheduleTaskRunQueueRecovery(leaseInspector: ProductTaskRunRecoveryLeaseInspector | undefined): void {
    if (!leaseInspector || this.taskRunQueueRecoveryRetry) return
    const timer = setTimeout(() => {
      if (this.taskRunQueueRecoveryRetry === timer) this.taskRunQueueRecoveryRetry = undefined
      void this.recoverDurableTaskRunQueue(leaseInspector).catch(() => undefined)
    }, 5_000)
    timer.unref?.()
    this.taskRunQueueRecoveryRetry = timer
  }

  /**
   * Materialize one bounded Agent child as its own private Run and Lineage.
   * The parent tool call is the only creator; the child never shares the
   * parent's Thread, execution claim, model receipt, or visible transcript.
   */
  async createTaskRunSubtask(input: {
    parent_run_id: string
    parent_dispatch_generation: number
    parent_execution_claim_token: string
    parent_operation_id: string
    parent_tool_call_id: string
    prompt: string
    description: string
  }): Promise<{ run_id: string; dispatch_generation: number }> {
    if (
      !/^run_[a-f0-9-]{36}$/.test(input.parent_run_id)
      || !Number.isSafeInteger(input.parent_dispatch_generation)
      || input.parent_dispatch_generation < 1
      || !isExecutionClaimToken(input.parent_execution_claim_token)
      || !isTaskRunExternalOperationId(input.parent_operation_id)
      || !/^[A-Za-z0-9_-]{1,512}$/.test(input.parent_tool_call_id)
      || !input.prompt.trim() || input.prompt.length > 100_000
      || !input.description.trim() || input.description.length > 160
    ) throw new Error('SUBTASK_INPUT_INVALID')

    const promptDigest = createHash('sha256').update(input.prompt).digest('hex')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const parent = state.task_runs[input.parent_run_id] as Record<string, unknown> | undefined
      const parentDispatch = state.dispatch_records[input.parent_run_id] as DurableTaskRunDispatch | undefined
      const parentBinding = parent?.core_binding as Record<string, unknown> | undefined
      const parentLineage = typeof parent?.lineage_id === 'string'
        ? state.conversation_lineages[parent.lineage_id] as Record<string, unknown> | undefined
        : undefined
      const forkCheckpoint = typeof parent?.entry_id === 'string'
        ? Object.values(state.task_events)
          .map(value => value as TaskEvent)
          .find((event): event is Extract<TaskEvent, { type: 'user_text' }> => event.type === 'user_text' && event.run_id === input.parent_run_id && event.entry_id === parent.entry_id)
        : undefined
      if (
        !parent
        || typeof parent.task_id !== 'string'
        || typeof parent.lineage_id !== 'string'
        || typeof parent.entry_id !== 'string'
        || typeof parent.parent_run_id === 'string'
        || !parentDispatch
        || parentDispatch.dispatch_generation !== input.parent_dispatch_generation
        || !['claimed', 'started'].includes(parentDispatch.state as string)
        || !executionClaimMatches(parentDispatch, input.parent_execution_claim_token)
        || parentDispatch.recovery_fence !== undefined
        || parentDispatch.stop_requested_at !== undefined
        || !liveExternalOperations(parentDispatch).some(operation => operation.operation_id === input.parent_operation_id && operation.kind === 'tools' && operation.state === 'in_flight')
        || !parentBinding
        || typeof parentBinding.work_dir !== 'string'
        || !path.isAbsolute(parentBinding.work_dir)
        || !parentLineage
        || parentLineage.product_task_id !== parent.task_id
        || !forkCheckpoint
      ) throw new Error('SUBTASK_PARENT_UNAVAILABLE')

      const existing = Object.values(state.task_runs)
        .map(value => value as Record<string, unknown>)
        .find(run => run.parent_run_id === input.parent_run_id && run.parent_tool_call_id === input.parent_tool_call_id)
      if (existing) {
        if (
          typeof existing.run_id !== 'string'
          || existing.subtask_prompt_digest !== promptDigest
          || existing.subtask_description !== input.description
          || (state.dispatch_records[existing.run_id] as { dispatch_generation?: unknown } | undefined)?.dispatch_generation !== 1
        ) throw new Error('SUBTASK_CALL_CONFLICT')
        return { changed: false as const, value: { run_id: existing.run_id, dispatch_generation: 1 } }
      }
      const childCount = Object.values(state.task_runs)
        .filter(value => (value as { parent_run_id?: unknown }).parent_run_id === input.parent_run_id)
        .length
      if (childCount >= 16) throw new Error('SUBTASK_LIMIT_REACHED')

      const now = this.now().toISOString()
      const runId = `run_${randomUUID()}`
      const entryId = `entry_${randomUUID()}`
      const lineageId = `lineage_${randomUUID()}`
      const permissionSnapshot = taskPermissionSnapshot(parent.permission_snapshot)
      const taskId = parent.task_id
      // The private-child fields are the rev10 authority extension. Upgrade
      // atomically with the first child so older readers never see a new
      // record shape under a stale revision marker.
      state.authority_schema_revision = 10
      state.conversation_lineages[lineageId] = {
        lineage_id: lineageId,
        product_task_id: taskId,
        parent_lineage_id: parent.lineage_id,
        fork_checkpoint_id: parent.entry_id,
        revision: 0,
        compact_generation: 0,
        resume_binding_id: `resume_${randomUUID()}`,
        execution_directory: parentBinding.work_dir,
        state: 'active',
        created_at: now,
        updated_at: now,
      }
      state.thread_entries[entryId] = {
        entry_id: entryId,
        task_id: taskId,
        run_id: runId,
        text: input.prompt,
        created_at: now,
      }
      state.task_runs[runId] = {
        run_id: runId,
        task_id: taskId,
        lineage_id: lineageId,
        entry_id: entryId,
        created_at: now,
        execution_capability: 'workspace_bound',
        permission_mode: permissionSnapshot.mode,
        permission_snapshot: permissionSnapshot,
        provider: null,
        model: null,
        event_contract: 'durable_items_v1',
        parent_run_id: input.parent_run_id,
        parent_tool_call_id: input.parent_tool_call_id,
        subtask_description: input.description,
        subtask_prompt_digest: promptDigest,
        core_binding: {
          resume_binding_id: (state.conversation_lineages[lineageId] as { resume_binding_id: string }).resume_binding_id,
          session_id: randomUUID(),
          work_dir: parentBinding.work_dir,
          dispatch_generation: 1,
          context_event_sequence: state.event_sequence,
        },
      }
      state.dispatch_records[runId] = { run_id: runId, dispatch_generation: 1, state: 'pending' }
      return { run_id: runId, dispatch_generation: 1 }
    })
    return result
  }

  /** Read one parent-owned child Run without exposing it to the public task stream. */
  async readTaskRunSubtaskResult(input: {
    parent_run_id: string
    parent_dispatch_generation: number
    parent_execution_claim_token: string
    parent_operation_id: string
    parent_tool_call_id: string
    run_id: string
  }): Promise<import('./taskRunLedgerPort.js').ProductTaskRunSubtaskResult> {
    if (
      !/^run_[a-f0-9-]{36}$/.test(input.parent_run_id)
      || !/^run_[a-f0-9-]{36}$/.test(input.run_id)
      || !Number.isSafeInteger(input.parent_dispatch_generation)
      || input.parent_dispatch_generation < 1
      || !isExecutionClaimToken(input.parent_execution_claim_token)
      || !isTaskRunExternalOperationId(input.parent_operation_id)
      || !/^[A-Za-z0-9_-]{1,512}$/.test(input.parent_tool_call_id)
    ) throw new Error('SUBTASK_INPUT_INVALID')
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const parentDispatch = state.dispatch_records[input.parent_run_id] as DurableTaskRunDispatch | undefined
    const child = state.task_runs[input.run_id] as Record<string, unknown> | undefined
    const dispatch = state.dispatch_records[input.run_id] as DurableTaskRunDispatch | undefined
    if (
      !parentDispatch
      || parentDispatch.dispatch_generation !== input.parent_dispatch_generation
      || !['claimed', 'started'].includes(parentDispatch.state as string)
      || !executionClaimMatches(parentDispatch, input.parent_execution_claim_token)
      || !liveExternalOperations(parentDispatch).some(operation => operation.operation_id === input.parent_operation_id && operation.kind === 'tools' && operation.state === 'in_flight')
      || !child
      || child.parent_run_id !== input.parent_run_id
      || child.parent_tool_call_id !== input.parent_tool_call_id
      || !dispatch
    ) throw new Error('SUBTASK_PARENT_UNAVAILABLE')
    if (['pending', 'claimed', 'started'].includes(dispatch.state as string)) return { state: 'running' }
    const result = child.subtask_result as { state?: unknown; text?: unknown } | undefined
    if (dispatch.state === 'terminal') {
      if (!result || result.state !== (dispatch.error === 'TERMINAL' ? 'completed' : 'stopped') || typeof result.text !== 'string') throw new Error('SUBTASK_RESULT_UNAVAILABLE')
      return result.state === 'completed' ? { state: 'completed', text: result.text } : { state: 'stopped', text: result.text }
    }
    if (dispatch.state === 'recovery_required') return { state: 'recovery_required', ...(typeof result?.text === 'string' ? { text: result.text } : {}) }
    if (dispatch.state === 'outcome_unknown') return { state: 'outcome_unknown' }
    throw new Error('SUBTASK_RESULT_UNAVAILABLE')
  }

  /** Server-private BB-03D/BB-05B lookup; it reads the durable hand-off only. */
  async readTaskRunDispatchIdentity(runId: string, dispatchGeneration: number): Promise<{
    task_id: string
    lineage_id: string
    resume_binding_id: string
    initial_input: string
    initial_attachments?: string[]
    permission_snapshot: ProductPermissionSnapshot
    session_context: DurableSessionContext
    codex_engine: {
      engine_home: string
      thread_storage_dir: string
      binding_id: string
      lineage_id: string
      source_revision: string
    }
  }> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = state.task_runs[runId] as { task_id?: unknown; lineage_id?: unknown; entry_id?: unknown; permission_snapshot?: unknown; parent_run_id?: unknown } | undefined
    const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown } | undefined
    const lineage = typeof run?.lineage_id === 'string' ? state.conversation_lineages[run.lineage_id] as Record<string, unknown> | undefined : undefined
    const entry = typeof run?.entry_id === 'string' ? state.thread_entries[run.entry_id] as { task_id?: unknown; run_id?: unknown; text?: unknown } | undefined : undefined
    if (!run || typeof run.task_id !== 'string' || typeof run.lineage_id !== 'string' || typeof run.entry_id !== 'string' || !entry || entry.task_id !== run.task_id || entry.run_id !== runId || typeof entry.text !== 'string' || !entry.text || dispatch?.dispatch_generation !== dispatchGeneration || !lineage || lineage.product_task_id !== run.task_id || typeof lineage.resume_binding_id !== 'string') throw new Error('AUTHORITY_INVALID')
    const resumeBindingId = lineage.resume_binding_id
    const sessionContext = renderDurableSessionContext(state, runId, run as Record<string, unknown>)
    const durableEvent = Object.values(state.task_events).find((candidate) => {
      const event = candidate as { run_id?: unknown; entry_id?: unknown }
      return event.run_id === runId && event.entry_id === run.entry_id
    }) as Extract<TaskEvent, { type: 'user_text' }> | undefined
    const initialAttachments = await Promise.all((durableEvent?.attachment_ids ?? []).map(async attachmentId => {
      const attachment = state.task_attachments[attachmentId] as { content_hash?: unknown; byte_size?: unknown; state?: unknown } | undefined
      const binding = state.attachment_bindings[attachmentId] as { task_id?: unknown; run_id?: unknown; entry_id?: unknown } | undefined
      if (!attachment || !binding || attachment.state !== 'accepted_bound' || typeof attachment.content_hash !== 'string' || typeof attachment.byte_size !== 'number' || binding.task_id !== run.task_id || binding.run_id !== runId || binding.entry_id !== run.entry_id) throw new Error('ATTACHMENT_COPY_INVALID')
      return resolveProductAttachmentCopy(productAttachmentStorageRoot(this.storagePath), attachmentId, attachment.content_hash, attachment.byte_size)
    }))
    return {
      task_id: run.task_id,
      lineage_id: run.lineage_id,
      resume_binding_id: resumeBindingId,
      initial_input: entry.text,
      permission_snapshot: taskPermissionSnapshot(run.permission_snapshot),
      ...(initialAttachments.length ? { initial_attachments: initialAttachments } : {}),
      session_context: sessionContext,
      codex_engine: codexEnginePrivateState(this.storagePath, resumeBindingId, run.lineage_id),
      ...(typeof run.parent_run_id === 'string' ? { subtask: { parent_run_id: run.parent_run_id } } : {}),
    }
  }

  /** Lightweight watchdog check; it revokes a live parent Runtime on a fence. */
  async assertTaskRunExecutionClaim(runId: string, dispatchGeneration: number, executionClaimToken: string): Promise<void> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken)) throw new Error('CORE_BINDING_UNAVAILABLE')
    const file = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const dispatch = file.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; stop_requested_at?: unknown; recovery_fence?: unknown; execution_claim?: unknown } | undefined
    if (dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || dispatch.stop_requested_at !== undefined || dispatch.recovery_fence !== undefined || !executionClaimMatches(dispatch, executionClaimToken)) throw new Error('CORE_BINDING_UNAVAILABLE')
  }

  /**
   * Atomically obtain the one permit that may cross a TaskRun's external
   * boundary.  Claim validation and the in-flight receipt are one authority
   * write, so a stop/fence cannot land between permission and the effect.
   */
  async beginTaskRunExternalOperation(
    runId: string,
    dispatchGeneration: number,
    executionClaimToken: string,
    kind: TaskRunExternalOperationKind,
  ): Promise<{ outcome: 'started'; operation_id: string } | { outcome: 'not_owner' | 'outcome_unknown' }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken) || !isTaskRunExternalOperationKind(kind)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      if (dispatch.state === 'outcome_unknown') return { changed: false as const, value: { outcome: 'outcome_unknown' as const } }
      if (!['claimed', 'started'].includes(dispatch.state as string) || !executionClaimAllowsWorkerMutation(dispatch, executionClaimToken)) {
        return { changed: false as const, value: { outcome: 'not_owner' as const } }
      }
      const existing = liveExternalOperations(dispatch)
      if (existing.some(operation => operation.state === 'in_flight') || existing.length >= 256) {
        return { changed: false as const, value: { outcome: 'not_owner' as const } }
      }
      const operationId = `effect_${randomUUID()}`
      dispatch.external_operations = [...existing, {
        operation_id: operationId,
        kind,
        state: 'in_flight',
        started_at: this.now().toISOString(),
      }]
      return { outcome: 'started' as const, operation_id: operationId }
    })
    return result
  }

  /**
   * The boundary returned a definite response, but the response may still be
   * only in worker memory.  It cannot be replayed and must wait for a matching
   * Harness Session/Run projection checkpoint before its receipt can clear.
   */
  async recordTaskRunExternalOperationResult(
    runId: string,
    dispatchGeneration: number,
    executionClaimToken: string,
    operationId: string,
  ): Promise<'result_obtained' | 'outcome_unknown' | 'not_owner'> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken) || !isTaskRunExternalOperationId(operationId)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownTaskId: string | undefined
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      const operation = externalOperationForId(dispatch, operationId)
      const checkpoint = externalOperationCheckpointForId(dispatch, operationId)
      if (dispatch.state === 'outcome_unknown') {
        return { changed: false as const, value: operation ? 'outcome_unknown' as const : 'not_owner' as const }
      }
      if (checkpoint) return { changed: false as const, value: 'result_obtained' as const }
      if (!operation) return { changed: false as const, value: 'not_owner' as const }
      if (!['claimed', 'started'].includes(dispatch.state as string) || !executionClaimMatches(dispatch, executionClaimToken) || dispatch.recovery_fence !== undefined || dispatch.stop_requested_at !== undefined) {
        const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, this.now().toISOString())
        outcomeUnknownTaskId = run.task_id
        outcomeUnknownEvent = outcome.event
        return 'outcome_unknown' as const
      }
      if (operation.state === 'outcome_unknown') return { changed: false as const, value: 'outcome_unknown' as const }
      if (operation.state === 'result_obtained') return { changed: false as const, value: 'result_obtained' as const }
      if (operation.state !== 'in_flight') {
        return { changed: false as const, value: 'not_owner' as const }
      }
      operation.state = 'result_obtained'
      operation.result_obtained_at = this.now().toISOString()
      return 'result_obtained' as const
    })
    if (outcomeUnknownEvent && outcomeUnknownTaskId) this.runtimeEvents.publish(outcomeUnknownTaskId, outcomeUnknownEvent)
    return result
  }

  /**
   * Clear exactly one definite effect only after its private owner has written
   * a snapshot containing the same operation id and digest.  A repeated IPC
   * request is idempotent through the bounded checkpoint audit.
   */
  async checkpointTaskRunExternalOperation(
    runId: string,
    dispatchGeneration: number,
    executionClaimToken: string,
    operationId: string,
    checkpoint: { digest: string },
  ): Promise<'checkpointed' | 'outcome_unknown' | 'not_owner'> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken) || !isTaskRunExternalOperationId(operationId) || !/^[a-f0-9]{64}$/.test(checkpoint.digest)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownTaskId: string | undefined
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      const prior = externalOperationCheckpointForId(dispatch, operationId)
      if (prior) return { changed: false as const, value: prior.checkpoint_digest === checkpoint.digest ? 'checkpointed' as const : 'not_owner' as const }
      const operation = externalOperationForId(dispatch, operationId)
      if (dispatch.state === 'outcome_unknown') return { changed: false as const, value: operation ? 'outcome_unknown' as const : 'not_owner' as const }
      if (!operation) return { changed: false as const, value: 'not_owner' as const }
      if (!['claimed', 'started'].includes(dispatch.state as string) || !executionClaimMatches(dispatch, executionClaimToken) || dispatch.recovery_fence !== undefined || dispatch.stop_requested_at !== undefined) {
        const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, this.now().toISOString())
        outcomeUnknownTaskId = run.task_id
        outcomeUnknownEvent = outcome.event
        return 'outcome_unknown' as const
      }
      if (operation.state === 'outcome_unknown') return { changed: false as const, value: 'outcome_unknown' as const }
      if (operation.state !== 'result_obtained') return { changed: false as const, value: 'not_owner' as const }
      const now = this.now().toISOString()
      dispatch.external_operations = liveExternalOperations(dispatch).filter(candidate => candidate.operation_id !== operationId)
      if (dispatch.external_operations.length === 0) delete dispatch.external_operations
      const checkpoints = Array.isArray(dispatch.external_operation_checkpoints)
        ? dispatch.external_operation_checkpoints as DurableTaskRunExternalOperationCheckpoint[]
        : []
      dispatch.external_operation_checkpoints = [...checkpoints, {
        operation_id: operation.operation_id,
        kind: operation.kind,
        checkpoint_digest: checkpoint.digest,
        checkpointed_at: now,
      }].slice(-512)
      return 'checkpointed' as const
    })
    if (outcomeUnknownEvent && outcomeUnknownTaskId) this.runtimeEvents.publish(outcomeUnknownTaskId, outcomeUnknownEvent)
    return result
  }

  /**
   * MCP preparation is checkpointed with the authoritative extension snapshot
   * rather than a child-local cache.  Recording both in one authority write
   * prevents a reconnect from replaying a connection whose tool surface was
   * already selected for this Turn.
   */
  async checkpointTaskRunMcpPrepare(
    runId: string,
    dispatchGeneration: number,
    executionClaimToken: string,
    operationId: string,
    snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number },
  ): Promise<'checkpointed' | 'outcome_unknown' | 'not_owner'> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken) || !isTaskRunExternalOperationId(operationId) || !/^[a-f0-9]{64}$/.test(snapshot.digest) || [snapshot.tool_count, snapshot.command_count, snapshot.mcp_server_count].some(value => !Number.isSafeInteger(value) || value < 0 || value > 10_000)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownTaskId: string | undefined
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; extension_snapshot?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      const prior = externalOperationCheckpointForId(dispatch, operationId)
      if (prior) {
        if (prior.kind !== 'mcp_prepare' || prior.checkpoint_digest !== snapshot.digest || JSON.stringify(run.extension_snapshot) !== JSON.stringify(snapshot)) return { changed: false as const, value: 'not_owner' as const }
        return { changed: false as const, value: 'checkpointed' as const }
      }
      const operation = externalOperationForId(dispatch, operationId)
      if (dispatch.state === 'outcome_unknown') return { changed: false as const, value: operation ? 'outcome_unknown' as const : 'not_owner' as const }
      if (!operation || operation.kind !== 'mcp_prepare') return { changed: false as const, value: 'not_owner' as const }
      if (!['claimed', 'started'].includes(dispatch.state as string) || !executionClaimMatches(dispatch, executionClaimToken) || dispatch.recovery_fence !== undefined || dispatch.stop_requested_at !== undefined) {
        const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, this.now().toISOString())
        outcomeUnknownTaskId = run.task_id
        outcomeUnknownEvent = outcome.event
        return 'outcome_unknown' as const
      }
      if (operation.state === 'outcome_unknown') return { changed: false as const, value: 'outcome_unknown' as const }
      if (operation.state !== 'result_obtained') return { changed: false as const, value: 'not_owner' as const }
      if (run.extension_snapshot !== undefined && JSON.stringify(run.extension_snapshot) !== JSON.stringify(snapshot)) throw new Error('AUTHORITY_INVALID')
      run.extension_snapshot = snapshot
      const now = this.now().toISOString()
      dispatch.external_operations = liveExternalOperations(dispatch).filter(candidate => candidate.operation_id !== operationId)
      if (dispatch.external_operations.length === 0) delete dispatch.external_operations
      const checkpoints = Array.isArray(dispatch.external_operation_checkpoints)
        ? dispatch.external_operation_checkpoints as DurableTaskRunExternalOperationCheckpoint[]
        : []
      dispatch.external_operation_checkpoints = [...checkpoints, {
        operation_id: operation.operation_id,
        kind: operation.kind,
        checkpoint_digest: snapshot.digest,
        checkpointed_at: now,
      }].slice(-512)
      return 'checkpointed' as const
    })
    if (outcomeUnknownEvent && outcomeUnknownTaskId) this.runtimeEvents.publish(outcomeUnknownTaskId, outcomeUnknownEvent)
    return result
  }

  /**
   * An effect that threw, lost its response, or was cut off after admission is
   * deliberately left unresolved.  This terminal ledger state blocks both
   * queue advancement and automatic replay until the user explicitly decides.
   */
  async markTaskRunExternalOperationOutcomeUnknown(
    runId: string,
    dispatchGeneration: number,
    executionClaimToken: string,
    operationId: string,
  ): Promise<'marked' | 'already_outcome_unknown' | 'not_owner'> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !isExecutionClaimToken(executionClaimToken) || !isTaskRunExternalOperationId(operationId)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownTaskId: string | undefined
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      if (dispatch.state === 'outcome_unknown') {
        const operation = externalOperationForId(dispatch, operationId)
        if (!operation) return { changed: false as const, value: 'not_owner' as const }
        const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, this.now().toISOString())
        outcomeUnknownTaskId = run.task_id
        outcomeUnknownEvent = outcome.event
        return outcome.changed ? 'already_outcome_unknown' as const : { changed: false as const, value: 'already_outcome_unknown' as const }
      }
      const operation = externalOperationForId(dispatch, operationId)
      if (!['claimed', 'started'].includes(dispatch.state as string) || !executionClaimMatches(dispatch, executionClaimToken) || !operation) {
        return { changed: false as const, value: 'not_owner' as const }
      }
      if (operation.state !== 'in_flight' && operation.state !== 'result_obtained') throw new Error('AUTHORITY_INVALID')
      const outcome = markDurableTaskRunOutcomeUnknown(state, run.task_id, runId, dispatch, this.now().toISOString())
      outcomeUnknownTaskId = run.task_id
      outcomeUnknownEvent = outcome.event
      return 'marked' as const
    })
    if (outcomeUnknownEvent && outcomeUnknownTaskId) this.runtimeEvents.publish(outcomeUnknownTaskId, outcomeUnknownEvent)
    return result
  }

  /** The only server-private resolver for a run's durable Core launch target. */
  async resolveTaskRunCoreBinding(runId: string, dispatchGeneration: number, executionClaimToken: string): Promise<{ session_id: string; work_dir: string; provider: string; model: string; model_route_fingerprint: string; model_attempt_id: string }> {
    if (!isExecutionClaimToken(executionClaimToken)) throw new Error('CORE_BINDING_UNAVAILABLE')
    const file = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = file.task_runs[runId] as { task_id?: unknown; lineage_id?: unknown; execution_capability?: unknown; provider?: unknown; model?: unknown; model_route_fingerprint?: unknown; core_binding?: { resume_binding_id?: unknown; session_id?: unknown; work_dir?: unknown; dispatch_generation?: unknown } } | undefined
    const binding = run?.core_binding
    const dispatch = file.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; stop_requested_at?: unknown; recovery_fence?: unknown; execution_claim?: unknown } | undefined
    if (!binding || run?.execution_capability !== 'workspace_bound' || typeof run.task_id !== 'string' || binding.dispatch_generation !== dispatchGeneration || typeof binding.resume_binding_id !== 'string' || typeof binding.session_id !== 'string' || typeof binding.work_dir !== 'string' || !binding.work_dir || typeof run.provider !== 'string' || typeof run.model !== 'string' || !/^[a-f0-9]{64}$/.test(String(run.model_route_fingerprint ?? ''))) throw new Error('CORE_BINDING_UNAVAILABLE')
    if (dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || dispatch.stop_requested_at !== undefined || dispatch.recovery_fence !== undefined || !executionClaimMatches(dispatch, executionClaimToken)) throw new Error('CORE_BINDING_UNAVAILABLE')
    const lineage = typeof run.lineage_id === 'string' ? file.conversation_lineages[run.lineage_id] as { resume_binding_id?: unknown; execution_directory?: unknown } | undefined : undefined
    if (binding.resume_binding_id !== lineage?.resume_binding_id) throw new Error('CORE_BINDING_UNAVAILABLE')
    const scope = file.task_scopes[run.task_id] as { kind?: unknown; workspace_id?: unknown } | undefined
    const workspace = scope?.kind === 'workspace' && typeof scope.workspace_id === 'string'
      ? file.workspaces[scope.workspace_id] as ProductWorkspace | undefined
      : undefined
    if (!workspace || workspace.installation_id !== this.installationId || workspace.availability !== 'available') throw new Error('CORE_BINDING_UNAVAILABLE')
    let inspected: Awaited<ReturnType<WorkspaceFilesystemPort['inspect']>>
    try {
      inspected = await this.workspaceFs.inspect(workspace.canonical_root)
    } catch {
      throw new Error('CORE_BINDING_UNAVAILABLE')
    }
    if (inspected.availability !== 'available' || inspected.identity.platform !== workspace.root_identity.platform || inspected.identity.volume_id !== workspace.root_identity.volume_id || inspected.identity.file_id !== workspace.root_identity.file_id) throw new Error('CORE_BINDING_UNAVAILABLE')
    const declaredWorkDir = typeof lineage.execution_directory === 'string' ? lineage.execution_directory : workspace.canonical_root
    const [workDir, expectedWorkDir] = await Promise.all([
      fs.realpath(binding.work_dir).catch(() => undefined),
      fs.realpath(declaredWorkDir).catch(() => undefined),
    ])
    if (!workDir || !expectedWorkDir || workDir !== expectedWorkDir || !await fs.stat(workDir).then(stat => stat.isDirectory()).catch(() => false)) throw new Error('CORE_BINDING_UNAVAILABLE')
    // A new dispatch generation is created only by the durable, user-confirmed
    // recovery mutation. It is therefore the authoritative boundary for a new
    // paid model attempt; a restarted process keeps the same generation/ID.
    return { session_id: binding.session_id, work_dir: workDir, provider: run.provider, model: run.model, model_route_fingerprint: run.model_route_fingerprint as string, model_attempt_id: `attempt:${runId}:${dispatchGeneration}` }
  }

  /** BB-03DR terminal/recovery marker; it cannot create or replay a user turn. */
  async settleTaskRunDispatch(runId: string, dispatchGeneration: number, state: 'recovery_required' | 'terminal', error?: string, failure?: ProductTaskRunFailure, executionClaimToken?: string): Promise<'settled' | 'already_settled' | 'outcome_unknown' | 'not_owner'> {
    if (failure !== undefined && (!isProductTaskRunFailureCode(failure.code) || failure.retryable !== productTaskRunFailure(failure.code).retryable || state !== 'recovery_required') || (executionClaimToken !== undefined && !isExecutionClaimToken(executionClaimToken))) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    let outcomeUnknownTaskId: string | undefined
    let outcomeUnknownEvent: Extract<ProductTaskEvent, { type: 'outcome_unknown' }> | undefined
    const { result } = await authority.transactSubmit((file) => {
      const run = file.task_runs[runId] as { task_id?: unknown; event_contract?: unknown } | undefined
      const dispatch = file.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      if (dispatch.state === 'outcome_unknown') return { changed: false as const, value: 'outcome_unknown' as const }
      if (dispatch.state === 'terminal' || dispatch.state === 'recovery_required') {
        const expectedState = state
        const expectedError = state === 'recovery_required' ? failure?.code ?? 'task_failed' : error
        if (dispatch.state !== expectedState || (expectedError !== undefined && dispatch.error !== expectedError)) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: 'already_settled' as const }
      }
      if (dispatch.execution_claim !== undefined && !executionClaimMatches(dispatch, executionClaimToken)) return { changed: false as const, value: 'not_owner' as const }
      if (dispatch.execution_claim === undefined && dispatch.state !== 'pending') return { changed: false as const, value: 'not_owner' as const }
      if (dispatch.execution_claim === undefined && dispatch.stop_requested_at === undefined) return { changed: false as const, value: 'not_owner' as const }
      if (liveExternalOperations(dispatch).length > 0) {
        const outcome = markDurableTaskRunOutcomeUnknown(file, run.task_id, runId, dispatch, this.now().toISOString())
        outcomeUnknownTaskId = run.task_id
        outcomeUnknownEvent = outcome.event
        return 'outcome_unknown' as const
      }
      if (state === 'recovery_required' && dispatch.recovery_fence && dispatch.recovery_fence.failure?.code !== (failure?.code ?? 'task_failed')) return { changed: false as const, value: 'not_owner' as const }
      const now = this.now().toISOString()
      run.event_contract = 'durable_items_v1'
      if (!Object.values(file.task_events).some(value => {
        const event = value as TaskEvent
        return event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration
      })) {
        file.event_sequence += 1
        file.task_events[String(file.event_sequence)] = {
          event_sequence: file.event_sequence,
          task_id: run.task_id,
          run_id: runId,
          type: 'run_terminal',
          dispatch_generation: dispatchGeneration,
          item_id: durableTerminalItemId(runId, dispatchGeneration),
          state: state === 'recovery_required' ? 'recovery_required' : error === 'STOPPED' ? 'stopped' : 'completed',
          created_at: now,
        }
      }
      dispatch.state = state; dispatch.completed_at = now; if (state === 'recovery_required') dispatch.error = failure?.code ?? 'task_failed'; else if (error) dispatch.error = error
      delete dispatch.execution_claim
      delete dispatch.recovery_fence
      delete dispatch.stop_requested_at
      const queueEvents = releaseQueuedInputTargets(file, runId, dispatchGeneration, now)
      if (queueEvents.length) {
        const task = (file.tasks[run.task_id] as { task?: Record<string, unknown> } | undefined)?.task
        if (task && Number.isSafeInteger(task.revision)) {
          task.revision = (task.revision as number) + 1
          task.updatedAt = now
        }
      }
      return { task_id: run.task_id, queue_events: queueEvents }
    })
    if (outcomeUnknownEvent && outcomeUnknownTaskId) this.runtimeEvents.publish(outcomeUnknownTaskId, outcomeUnknownEvent)
    if (result === 'already_settled' || result === 'outcome_unknown' || result === 'not_owner') return result
    for (const event of result.queue_events) this.runtimeEvents.publish(result.task_id, event)
    if (state === 'recovery_required') this.runtimeEvents.publish(result.task_id, { type: 'error', ...(failure ?? { code: 'task_failed', retryable: false }) })
    return 'settled'
  }

  /** BB-02D two-confirmation lifecycle mutation; never deletes a workspace or source path. */
  async mutateTaskDeletion(
    taskId: string,
    input: { action: 'begin' | 'cancel' | 'commit_purge' | 'retry'; expected_revision: number; client_operation_id: string },
  ): Promise<{ task: ProductTaskRecord; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; blockers: TaskLifecycleBlocker[] }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonical = JSON.stringify({ task_id: taskId, action: input.action, expected_revision: input.expected_revision })
    try {
      const { result } = await authority.transactSubmitAsync(async (state) => {
        const prior = state.receipts[input.client_operation_id]
        const stored = state.tasks[taskId] as { task?: ProductTaskRecord; binding?: unknown } | undefined
        if (!stored?.task) throw new Error('AUTHORITY_INVALID')
        if (prior) {
          if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT')
          return { changed: false as const, value: { task: authorityPublicTask(stored.task), outcome: 'duplicate' as const, blockers: [] as TaskLifecycleBlocker[] } }
        }
        if (stored.task.revision !== input.expected_revision) throw new Error('AUTHORITY_CONFLICT')
        const blockers = input.action === 'begin' || input.action === 'commit_purge'
          ? await this.inspectLifecycleBlockers(taskId, input.expected_revision)
          : []
        const now = this.now().toISOString()
        const deletion = stored.task.deletion
        const reject = (rejectedBlockers: TaskLifecycleBlocker[]) => {
          const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'rejected' as const, revision: state.revision + 1, error: 'OPERATION_REJECTED' as const }
          state.receipts[input.client_operation_id] = receipt
          state.event_sequence += 1
          state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: `task_delete_${input.action}_rejected`, revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
          return { task: authorityPublicTask(stored.task), outcome: 'rejected' as const, blockers: rejectedBlockers }
        }
        let next: ProductTaskRecord
        if (input.action === 'begin') {
          if (stored.task.lifecycle !== 'archived' || blockers.length) return reject(blockers)
          const cleanup_plan_hash = createHash('sha256').update(JSON.stringify({ task_id: taskId, thread_entries: Object.values(state.thread_entries).filter((entry: any) => entry.task_id === taskId).map((entry: any) => entry.entry_id).sort(), task_events: Object.values(state.task_events).filter((event: any) => event.task_id === taskId).map((event: any) => event.event_sequence).sort(), turn_input_queue: Object.values(state.turn_input_queue).filter((item: any) => item.task_id === taskId).map((item: any) => item.queue_item_id).sort(), review_comments: Object.values(state.review_comments).filter((comment: any) => comment.task_id === taskId).map((comment: any) => comment.comment_id).sort() })).digest('hex')
          const prepared = { phase: 'deleting' as const, fencing_token: randomUUID(), cleanup_plan_hash, started_at: now }
          const failedItems = await this.runLifecycleCleanup('prepareCleanup', taskId, input.expected_revision, prepared.fencing_token)
          next = { ...stored.task, lifecycle: failedItems.length ? 'delete_failed_pre_purge' : 'deleting', actions: [], updatedAt: now, revision: input.expected_revision + 1, deletion: { ...prepared, phase: failedItems.length ? 'delete_failed_pre_purge' : 'deleting', ...(failedItems.length ? { failed_items: failedItems } : {}) } }
        } else if (input.action === 'cancel') {
          if (!deletion || !['deleting', 'delete_failed_pre_purge'].includes(deletion.phase)) return reject(blockers)
          const failedItems = await this.runLifecycleCleanup('cancelCleanup', taskId, input.expected_revision, deletion.fencing_token)
          if (failedItems.length) {
            next = { ...stored.task, lifecycle: 'delete_failed_pre_purge', actions: [], updatedAt: now, revision: input.expected_revision + 1, deletion: { ...deletion, phase: 'delete_failed_pre_purge', failed_items: failedItems } }
          } else {
            next = { ...stored.task, lifecycle: 'archived', actions: ['restore', 'continue'], updatedAt: now, revision: input.expected_revision + 1, deletion: undefined }
          }
        } else if (input.action === 'commit_purge') {
          if (!deletion || deletion.phase !== 'deleting' || blockers.length) return reject(blockers)
          next = { ...stored.task, lifecycle: 'purge_committed', actions: [], updatedAt: now, revision: input.expected_revision + 1, deletion: { ...deletion, phase: 'purge_committed' } }
        } else {
          if (!deletion) return reject(blockers)
          if (deletion.phase === 'delete_failed_pre_purge') {
            const retryBlockers = await this.inspectLifecycleBlockers(taskId, input.expected_revision)
            if (retryBlockers.length) return reject(retryBlockers)
            const failedItems = await this.runLifecycleCleanup('prepareCleanup', taskId, input.expected_revision, deletion.fencing_token)
            next = { ...stored.task, lifecycle: failedItems.length ? 'delete_failed_pre_purge' : 'deleting', actions: [], updatedAt: now, revision: input.expected_revision + 1, deletion: { ...deletion, phase: failedItems.length ? 'delete_failed_pre_purge' : 'deleting', ...(failedItems.length ? { failed_items: failedItems } : {}) } }
          } else {
            if (!['purge_committed', 'delete_failed_post_purge'].includes(deletion.phase)) return reject(blockers)
            const failedItems = await this.runLifecycleCleanup('purgeCleanup', taskId, input.expected_revision, deletion.fencing_token)
            if (failedItems.length) {
              next = { ...stored.task, lifecycle: 'delete_failed_post_purge', actions: [], updatedAt: now, revision: input.expected_revision + 1, deletion: { ...deletion, phase: 'delete_failed_post_purge', failed_items: failedItems } }
            } else {
          for (const [key, entry] of Object.entries(state.thread_entries)) if ((entry as { task_id?: string }).task_id === taskId) delete state.thread_entries[key]
          for (const [key, event] of Object.entries(state.task_events)) if ((event as { task_id?: string }).task_id === taskId) delete state.task_events[key]
          for (const [key, run] of Object.entries(state.task_runs)) if ((run as { task_id?: string }).task_id === taskId) { delete state.task_runs[key]; delete state.dispatch_records[key] }
          for (const [key, binding] of Object.entries(state.attachment_bindings)) if ((binding as { task_id?: string }).task_id === taskId) delete state.attachment_bindings[key]
          for (const [key, comment] of Object.entries(state.review_comments)) if ((comment as { task_id?: string }).task_id === taskId) delete state.review_comments[key]
          for (const [key, item] of Object.entries(state.turn_input_queue)) if ((item as { task_id?: string }).task_id === taskId) delete state.turn_input_queue[key]
          for (const [key, lineage] of Object.entries(state.conversation_lineages)) if ((lineage as { product_task_id?: string }).product_task_id === taskId) { delete state.conversation_lineages[key]; delete state.context_snapshots[key] }
          delete state.task_scopes[taskId]
          const taskDraftIds = new Set(Object.entries(state.composer_drafts).filter(([, draft]) => (draft as { target_task_id?: string }).target_task_id === taskId).map(([key]) => key))
          for (const key of taskDraftIds) delete state.composer_drafts[key]
          for (const [key, attachment] of Object.entries(state.task_attachments)) {
            const owner = attachment as { owner_kind?: unknown; owner_id?: unknown }
            if ((owner.owner_kind === 'product_task' && owner.owner_id === taskId) || (owner.owner_kind === 'composer_draft' && typeof owner.owner_id === 'string' && taskDraftIds.has(owner.owner_id))) delete state.task_attachments[key]
          }
          const relatedSideIds = new Set(Object.entries(state.side_tasks).filter(([, side]) => {
            const value = side as { parentTaskId?: unknown; taskId?: unknown }
            return value.parentTaskId === taskId || value.taskId === taskId
          }).map(([key]) => key))
          for (const sideId of relatedSideIds) { delete state.side_tasks[sideId]; delete state.bindings[sideId] }
          delete state.bindings[taskId]
          for (const [key, prepared] of Object.entries(state.prepared)) if ((prepared as { product_task_id?: unknown }).product_task_id === taskId) { delete state.prepared[key]; delete state.outbox[key]; delete state.provenance[key] }
          for (const [key, event] of Object.entries(state.events)) {
            const value = event as { product_task_id?: unknown; entity_id?: unknown }
            if (value.product_task_id === taskId || value.entity_id === taskId || (typeof value.entity_id === 'string' && relatedSideIds.has(value.entity_id))) {
              delete state.events[key]; delete state.receipts[key]; delete state.outbox[key]; delete state.provenance[key]
            }
          }
          next = {
            ...stored.task,
            projectId: '', directoryId: '', workDir: '', title: '', parentTaskId: undefined, task_scope: undefined, current_lineage_id: undefined,
            lifecycle: 'deleted', actions: [], updatedAt: now, revision: input.expected_revision + 1,
            deletion: { ...deletion, phase: 'deleted', tombstone_expires_at: deletion.tombstone_expires_at ?? new Date(this.now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() },
          }
            }
          }
        }
        state.tasks[taskId] = next.lifecycle === 'deleted' ? { task: next } : { ...stored, task: next }
        const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted' as const, revision: state.revision + 1, result: next }
        state.receipts[input.client_operation_id] = receipt
        state.event_sequence += 1
        state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: `task_delete_${input.action}`, revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }
        return { task: authorityPublicTask(next), outcome: 'accepted' as const, blockers: [] as TaskLifecycleBlocker[] }
      })
      return result
    } catch (error) {
      if (['AUTHORITY_CONFLICT', 'OPERATION_INPUT_CONFLICT'].includes((error as Error).message)) {
        const current = await authority.read(); const stored = current.tasks[taskId] as { task?: ProductTaskRecord } | undefined
        if (!stored?.task) throw ApiError.notFound('任务不存在')
        return { task: authorityPublicTask(stored.task), outcome: 'conflict', blockers: [] }
      }
      throw error
    }
  }

  private async inspectLifecycleBlockers(taskId: string, revision: number): Promise<TaskLifecycleBlocker[]> {
    const collected = await Promise.all(this.lifecycleParticipants.map(async (participant) => {
      try { return await participant.inspectBlockers(taskId, revision) } catch { return [{ participant: participant.id, code: 'BLOCKER_UNAVAILABLE' as const, action: 'resolve' as const }] }
    }))
    return collected.flat()
  }

  private async runLifecycleCleanup(step: 'prepareCleanup' | 'cancelCleanup' | 'purgeCleanup', taskId: string, revision: number, fencingToken: string): Promise<string[]> {
    const results = await Promise.all(this.lifecycleParticipants.map(async (participant) => {
      const operation = participant[step]
      if (!operation) return undefined
      try { await operation(taskId, revision, fencingToken); return undefined } catch { return participant.id }
    }))
    return results.filter((id): id is string => typeof id === 'string')
  }

  /** Server-private owner check for schedules that reuse an existing task. */
  async getScheduledTaskContext(taskId: string): Promise<{ lifecycle: ProductTask['lifecycle']; workDir: string }> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const task = authorityPublicTask(state.tasks[taskId])
    if (!task || task.lifecycle === 'deleted') throw ApiError.notFound('关联任务不存在')
    return { lifecycle: task.lifecycle, workDir: task.workDir }
  }

  async listReviewComments(
    taskId: string,
    fileRef: WorkspaceFileRef,
  ): Promise<ProductTaskReviewComment[]> {
    const file = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    if (!(file.tasks[taskId] as { task?: unknown } | undefined)?.task) throw ApiError.notFound('任务不存在')
    return Object.values(file.review_comments)
      .map(value => publicReviewComment(value as StoredReviewComment))
      .filter(comment => (
        comment.taskId === taskId &&
        comment.fileRef.fileId === fileRef.fileId &&
        comment.fileRef.path === fileRef.path &&
        comment.fileRef.revision === fileRef.revision
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.commentId.localeCompare(right.commentId))
  }

  async createReviewComment(input: {
    taskId: string
    fileRef: WorkspaceFileRef
    side: 'old' | 'new'
    line: number
    body: string
    clientOperationId: string
  }): Promise<ProductTaskReviewCommentMutation> {
    try {
      assertAuthorityMapKey(input.clientOperationId)
    } catch {
      throw ApiError.badRequest('批注操作标识无效')
    }
    if (
      input.clientOperationId.length > 256 ||
      !/^file_[a-f0-9]{20}$/.test(input.fileRef.fileId) ||
      !/^rev_[a-f0-9]{32}$/.test(input.fileRef.revision) ||
      !input.fileRef.path ||
      input.fileRef.path.length > 4_096 ||
      input.fileRef.path.startsWith('/') ||
      input.fileRef.path.includes('\\') ||
      input.fileRef.path.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
      (input.side !== 'old' && input.side !== 'new') ||
      !Number.isSafeInteger(input.line) ||
      input.line < 1 ||
      input.line > 10_000_000 ||
      !input.body.trim() ||
      input.body.length > 4_000
    ) throw ApiError.badRequest('批注参数无效')

    const canonical = JSON.stringify({
      task_id: input.taskId,
      file_ref: input.fileRef,
      side: input.side,
      line: input.line,
      body: input.body,
    })
    const commentId = `comment_${createHash('sha256')
      .update(`${input.taskId}\0${input.clientOperationId}`)
      .digest('hex')
      .slice(0, 20)}`
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    try {
      const { result } = await authority.transactReview((state) => {
        const prior = state.receipts[input.clientOperationId]
        if (prior) {
          if (state.events[input.clientOperationId]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT')
          const existing = state.review_comments[commentId] as StoredReviewComment | undefined
          if (!existing) throw new Error('AUTHORITY_INVALID')
          return { changed: false as const, value: { duplicate: true, comment: existing, authorityRevision: prior.revision } }
        }
        const task = (state.tasks[input.taskId] as { task?: { lifecycle?: unknown } } | undefined)?.task
        if (!task) throw new Error('TASK_NOT_FOUND')
        if (task.lifecycle !== 'active' && task.lifecycle !== 'archived') throw new Error('TASK_NOT_REVIEWABLE')
        if (state.review_comments[commentId]) throw new Error('AUTHORITY_INVALID')
        const comment: StoredReviewComment = {
          comment_id: commentId,
          task_id: input.taskId,
          file_ref: {
            file_id: input.fileRef.fileId,
            path: input.fileRef.path,
            revision: input.fileRef.revision,
          },
          side: input.side,
          line: input.line,
          body: input.body,
          created_at: this.now().toISOString(),
        }
        state.review_comments[commentId] = comment
        state.receipts[input.clientOperationId] = {
          client_operation_id: input.clientOperationId,
          expected_revision: 0,
          outcome: 'accepted',
          revision: state.revision + 1,
        }
        state.event_sequence += 1
        state.events[input.clientOperationId] = {
          event_sequence: state.event_sequence,
          client_operation_id: input.clientOperationId,
          kind: 'review_comment_create',
          revision: state.revision + 1,
          canonical_input: canonical,
          entity_id: commentId,
          product_task_id: input.taskId,
        }
        return { duplicate: false, comment, authorityRevision: state.revision + 1 }
      })
      return {
        outcome: result.duplicate ? 'duplicate' : 'accepted',
        authorityRevision: result.authorityRevision,
        comment: publicReviewComment(result.comment),
      }
    } catch (error) {
      if ((error as Error).message === 'TASK_NOT_FOUND') throw ApiError.notFound('任务不存在')
      if ((error as Error).message === 'TASK_NOT_REVIEWABLE') throw new ApiError(409, '任务当前不可批注', 'AUTHORITY_CONFLICT')
      if ((error as Error).message === 'OPERATION_INPUT_CONFLICT') throw new ApiError(409, '操作标识已绑定不同批注', 'AUTHORITY_CONFLICT')
      throw new ApiError(503, '批注暂时无法保存', 'PRODUCT_TASK_REVIEW_UNAVAILABLE')
    }
  }

  /**
   * Resolve the Agent Core binding inside the product application layer.
   *
   * Product clients only ever address an opaque product id. The Core session
   * binding stays in the private product store and never crosses this seam.
   */
  /**
   * Workspace authority is deliberately separate from the Core session/workDir.
   * A task without an explicit binding is installation-default and has no cwd
   * capability until BB-02C can enforce tool-level restrictions.
   */
  async requireWorkspaceCapability(
    taskId: string,
    capability: 'review' | 'diff' | 'preview' | 'pty' | 'agent' | 'skill' | 'bash',
    expectedWorkspaceRevision?: number,
  ): Promise<ProductWorkspace> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const file = await authority.read()
    const scope = file.task_scopes[taskId] as ProductTaskScope | undefined
    if (!scope || scope.kind === 'installation-default') {
      throw new ApiError(409, '该任务尚未绑定工作区', 'WORKSPACE_REQUIRED')
    }
    const workspace = file.workspaces[scope.workspace_id] as ProductWorkspace | undefined
    if (!workspace || workspace.availability !== 'available') {
      throw new ApiError(409, '任务工作区不可用，需要重新关联', workspace?.availability === 'relink_required' ? 'WORKSPACE_RELINK_REQUIRED' : 'WORKSPACE_REQUIRED')
    }
    let inspected: Awaited<ReturnType<WorkspaceFilesystemPort['inspect']>>
    try { inspected = await this.workspaceFs.inspect(workspace.canonical_root) } catch { throw new ApiError(409, '任务工作区不可用，需要重新关联', 'WORKSPACE_REQUIRED') }
    if (inspected.availability !== 'available' || inspected.identity.platform !== workspace.root_identity.platform || inspected.identity.volume_id !== workspace.root_identity.volume_id || inspected.identity.file_id !== workspace.root_identity.file_id) {
      throw new ApiError(409, '任务工作区身份已变化，需要重新关联', 'WORKSPACE_REQUIRED')
    }
    if (expectedWorkspaceRevision !== undefined && workspace.revision !== expectedWorkspaceRevision) {
      throw new ApiError(409, '工作区已更新，请刷新后重试', 'AUTHORITY_CONFLICT')
    }
    void capability
    return workspace
  }

  async registerWorkspaceOperation(input: { root: string; expected_revision: number; client_operation_id: string }): Promise<{ workspace: ProductWorkspace; receipt: { outcome: 'accepted' | 'duplicate' | 'conflict'; revision: number } }> {
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0 || !input.client_operation_id) throw ApiError.badRequest('workspace operation 无效')
    const inspected = await this.workspaceFs.inspect(input.root)
    if (inspected.availability !== 'available') throw ApiError.badRequest('工作区目录不存在或不可写')
    const id = workspaceIdForIdentity(this.installationId, inspected.identity)
    const canonical = JSON.stringify({ kind: 'workspace_register', workspace_id: id, root: inspected.canonical_root, expected_revision: input.expected_revision })
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const before = await authority.read()
    const prior = before.receipts[input.client_operation_id]
    if (prior) {
      if (before.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT')
      const workspace = before.workspaces[id] as ProductWorkspace | undefined
      if (!workspace) throw new ApiError(409, '操作目标不存在', 'AUTHORITY_CONFLICT')
      return { workspace, receipt: { outcome: 'duplicate', revision: prior.revision } }
    }
    const existing = before.workspaces[id] as ProductWorkspace | undefined
    if (existing) {
      if (existing.revision !== input.expected_revision) return { workspace: existing, receipt: { outcome: 'conflict', revision: before.revision } }
      return { workspace: existing, receipt: { outcome: 'accepted', revision: before.revision } }
    }
    if (input.expected_revision !== 0) return { workspace: { workspace_id: id, installation_id: this.installationId, canonical_root: inspected.canonical_root, root_identity: inspected.identity, revision: 0, availability: inspected.availability, created_at: '', updated_at: '' }, receipt: { outcome: 'conflict', revision: before.revision } }
    const now = this.now().toISOString()
    const { file } = await authority.mutateCapabilities((state) => {
      state.workspaces[id] = { workspace_id: id, installation_id: this.installationId, canonical_root: inspected.canonical_root, root_identity: inspected.identity, revision: 0, availability: inspected.availability, created_at: now, updated_at: now }
      state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: state.revision + 1 }
      state.event_sequence += 1
      state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'workspace_register', revision: state.revision + 1, canonical_input: canonical }
    })
    return { workspace: file.workspaces[id] as ProductWorkspace, receipt: { outcome: 'accepted', revision: file.revision } }
  }

  async registerWorkspace(root: string): Promise<ProductWorkspace> {
    const inspected = await this.workspaceFs.inspect(root)
    if (inspected.availability !== 'available') throw ApiError.badRequest('工作区目录不存在或不可写')
    const id = workspaceIdForIdentity(this.installationId, inspected.identity)
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const existing = await authority.read()
    const prior = existing.workspaces[id] as ProductWorkspace | undefined
    if (prior) return prior
    const now = new Date().toISOString()
    const { file } = await authority.mutateCapabilities((current) => {
      current.workspaces[id] = { workspace_id: id, installation_id: this.installationId, canonical_root: inspected.canonical_root, root_identity: inspected.identity, revision: 0, availability: inspected.availability, created_at: now, updated_at: now }
    })
    return file.workspaces[id] as ProductWorkspace
  }

  async inspectWorkspace(workspaceId: string): Promise<ProductWorkspace> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const current = await authority.read()
    const workspace = current.workspaces[workspaceId] as ProductWorkspace | undefined
    if (!workspace || workspace.installation_id !== this.installationId) throw ApiError.notFound('工作区不存在')
    const inspected = await this.workspaceFs.inspect(workspace.canonical_root)
    const availability = inspected.availability === 'missing' ? 'missing' : JSON.stringify(inspected.identity) === JSON.stringify(workspace.root_identity) ? inspected.availability : 'identity_changed'
    if (availability === workspace.availability) return workspace
    const { file } = await authority.mutateCapabilities((state) => {
      const record = state.workspaces[workspaceId] as ProductWorkspace
      if (record) state.workspaces[workspaceId] = { ...record, availability, revision: record.revision + 1, updated_at: new Date().toISOString() }
    })
    return file.workspaces[workspaceId] as ProductWorkspace
  }

  async relocateWorkspaceOperation(input: { workspace_id: string; root: string; expected_workspace_revision: number; client_operation_id: string }): Promise<{ workspace: ProductWorkspace; receipt: { outcome: 'accepted' | 'duplicate' | 'conflict'; revision: number } }> {
    if (!Number.isSafeInteger(input.expected_workspace_revision) || input.expected_workspace_revision < 0 || !input.client_operation_id || !input.root.trim()) throw ApiError.badRequest('workspace relocate 参数无效')
    const inspected = await this.workspaceFs.inspect(input.root)
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const before = await authority.read()
    const existing = before.workspaces[input.workspace_id] as ProductWorkspace | undefined
    if (!existing || existing.installation_id !== this.installationId) throw ApiError.notFound('工作区不存在')
    const canonical = JSON.stringify({ kind: 'workspace_relocate', workspace_id: input.workspace_id, root: inspected.canonical_root, identity: inspected.identity, availability: inspected.availability, expected_workspace_revision: input.expected_workspace_revision })
    const prior = before.receipts[input.client_operation_id]
    if (prior) {
      if (before.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT')
      return { workspace: before.workspaces[input.workspace_id] as ProductWorkspace, receipt: { outcome: 'duplicate', revision: prior.revision } }
    }
    if (existing.revision !== input.expected_workspace_revision) return { workspace: existing, receipt: { outcome: 'conflict', revision: before.revision } }
    const sameIdentity = inspected.identity.platform === existing.root_identity.platform && inspected.identity.volume_id === existing.root_identity.volume_id && inspected.identity.file_id === existing.root_identity.file_id
    const nextAvailability = inspected.availability === 'missing' || !sameIdentity ? 'relink_required' : inspected.availability
    if (existing.canonical_root === inspected.canonical_root && existing.availability === nextAvailability) return { workspace: existing, receipt: { outcome: 'accepted', revision: before.revision } }
    const now = this.now().toISOString()
    const { file } = await authority.mutateCapabilities((state) => {
      const workspace = state.workspaces[input.workspace_id] as ProductWorkspace | undefined
      if (!workspace || workspace.installation_id !== this.installationId || workspace.revision !== input.expected_workspace_revision) throw new Error('AUTHORITY_CONFLICT')
      state.workspaces[input.workspace_id] = sameIdentity && inspected.availability !== 'missing'
        ? { ...workspace, canonical_root: inspected.canonical_root, availability: inspected.availability, revision: workspace.revision + 1, updated_at: now }
        : { ...workspace, availability: 'relink_required', revision: workspace.revision + 1, updated_at: now }
      state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_workspace_revision, outcome: 'accepted', revision: state.revision + 1 }
      state.event_sequence += 1
      state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'workspace_relocate', revision: state.revision + 1, canonical_input: canonical }
    })
    return { workspace: file.workspaces[input.workspace_id] as ProductWorkspace, receipt: { outcome: 'accepted', revision: file.revision } }
  }

  async relocateWorkspace(workspaceId: string, expectedRevision: number, root: string): Promise<ProductWorkspace> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const inspected = await this.workspaceFs.inspect(root)
    const { file } = await authority.mutateCapabilities((state) => {
      const workspace = state.workspaces[workspaceId] as ProductWorkspace | undefined
      if (!workspace || workspace.installation_id !== this.installationId || workspace.revision !== expectedRevision) throw new Error('AUTHORITY_CONFLICT')
      if (inspected.availability === 'missing' || inspected.identity.platform !== workspace.root_identity.platform || inspected.identity.volume_id !== workspace.root_identity.volume_id || inspected.identity.file_id !== workspace.root_identity.file_id) {
        state.workspaces[workspaceId] = { ...workspace, availability: 'relink_required', revision: workspace.revision + 1, updated_at: new Date().toISOString() }; return
      }
      state.workspaces[workspaceId] = { ...workspace, canonical_root: inspected.canonical_root, availability: inspected.availability, revision: workspace.revision + 1, updated_at: new Date().toISOString() }
    })
    return file.workspaces[workspaceId] as ProductWorkspace
  }

  async relinkWorkspaceOperation(input: { workspace_id: string; root: string; expected_workspace_revision: number; client_operation_id: string }): Promise<{ workspace: ProductWorkspace; receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number } }> {
    if (!Number.isSafeInteger(input.expected_workspace_revision) || input.expected_workspace_revision < 0 || !input.client_operation_id || !input.root.trim()) throw ApiError.badRequest('workspace relink 参数无效')
    const inspected = await this.workspaceFs.inspect(input.root)
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const before = await authority.read()
    const existing = before.workspaces[input.workspace_id] as ProductWorkspace | undefined
    if (!existing || existing.installation_id !== this.installationId) throw ApiError.notFound('工作区不存在')
    const canonical = JSON.stringify({ kind: 'workspace_relink', workspace_id: input.workspace_id, root: inspected.canonical_root, identity: inspected.identity, availability: inspected.availability, expected_workspace_revision: input.expected_workspace_revision })
    const prior = before.receipts[input.client_operation_id]
    if (prior) {
      if (before.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT')
      return { workspace: before.workspaces[input.workspace_id] as ProductWorkspace, receipt: { outcome: 'duplicate', revision: prior.revision } }
    }
    if (existing.revision !== input.expected_workspace_revision) return { workspace: existing, receipt: { outcome: 'conflict', revision: before.revision } }
    if (!['relink_required', 'missing', 'identity_changed'].includes(existing.availability) || inspected.availability !== 'available') return { workspace: existing, receipt: { outcome: 'rejected', revision: before.revision } }
    const unchanged = existing.canonical_root === inspected.canonical_root && existing.availability === inspected.availability && existing.root_identity.platform === inspected.identity.platform && existing.root_identity.volume_id === inspected.identity.volume_id && existing.root_identity.file_id === inspected.identity.file_id
    if (unchanged) return { workspace: existing, receipt: { outcome: 'accepted', revision: before.revision } }
    const now = this.now().toISOString()
    const { file } = await authority.mutateCapabilities((state) => {
      const workspace = state.workspaces[input.workspace_id] as ProductWorkspace | undefined
      if (!workspace || workspace.installation_id !== this.installationId || workspace.revision !== input.expected_workspace_revision) throw new Error('AUTHORITY_CONFLICT')
      state.workspaces[input.workspace_id] = { ...workspace, canonical_root: inspected.canonical_root, root_identity: inspected.identity, availability: inspected.availability, revision: workspace.revision + 1, updated_at: now }
      state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_workspace_revision, outcome: 'accepted', revision: state.revision + 1 }
      state.event_sequence += 1
      state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'workspace_relink', revision: state.revision + 1, canonical_input: canonical }
    })
    return { workspace: file.workspaces[input.workspace_id] as ProductWorkspace, receipt: { outcome: 'accepted', revision: file.revision } }
  }

  async relinkWorkspace(workspaceId: string, expectedRevision: number, root: string): Promise<ProductWorkspace> {
    const inspected = await this.workspaceFs.inspect(root)
    if (inspected.availability === 'missing') throw ApiError.badRequest('工作区根目录不存在')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { file } = await authority.mutateCapabilities((state) => {
      const workspace = state.workspaces[workspaceId] as ProductWorkspace | undefined
      if (!workspace || workspace.installation_id !== this.installationId || workspace.revision !== expectedRevision) throw new Error('AUTHORITY_CONFLICT')
      state.workspaces[workspaceId] = { ...workspace, canonical_root: inspected.canonical_root, root_identity: inspected.identity, availability: inspected.availability, revision: workspace.revision + 1, updated_at: new Date().toISOString() }
    })
    return file.workspaces[workspaceId] as ProductWorkspace
  }

  async bindTaskWorkspace(input: { task_id: string; workspace_id: string; expected_task_revision: number; expected_workspace_revision: number; client_operation_id: string }): Promise<{ authority_revision: number; entity_revisions: { task: number; workspace: number }; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; error?: WorkspaceBindBlockerCode; receipt?: unknown; participant_receipts?: WorkspaceBindParticipantReceipt[] }> {
    const prior = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    if (prior.receipts[input.client_operation_id]) {
      const canonical = JSON.stringify({ task_id: input.task_id, workspace_id: input.workspace_id, expected_task_revision: input.expected_task_revision, expected_workspace_revision: input.expected_workspace_revision })
      if (prior.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT')
      return this.bindTaskWorkspaceUnlocked(input)
    }
    return this.admissionBarrier.withWorkspaceMutation(input.task_id, () => this.bindTaskWorkspaceUnlocked(input))
  }

  private async bindTaskWorkspaceUnlocked(input: { task_id: string; workspace_id: string; expected_task_revision: number; expected_workspace_revision: number; client_operation_id: string }): Promise<{ authority_revision: number; entity_revisions: { task: number; workspace: number }; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; error?: WorkspaceBindBlockerCode; receipt?: unknown; participant_receipts?: WorkspaceBindParticipantReceipt[] }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonicalInput = JSON.stringify({ task_id: input.task_id, workspace_id: input.workspace_id, expected_task_revision: input.expected_task_revision, expected_workspace_revision: input.expected_workspace_revision })
    try {
      const { file, result } = await authority.transactCapabilitiesAsync(async (state) => {
        const historical = state.receipts[input.client_operation_id]
        if (historical) {
          if (state.events[input.client_operation_id]?.canonical_input !== canonicalInput) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT')
          const receipts = (historical.result as { participant_receipts?: WorkspaceBindParticipantReceipt[] } | undefined)?.participant_receipts
          return { changed: false as const, value: { outcome: 'duplicate' as const, receipt: historical, participant_receipts: receipts, error: (historical.result as { blocker_error?: WorkspaceBindBlockerCode } | undefined)?.blocker_error } }
        }
        const stored = state.tasks[input.task_id] as { task?: Record<string, unknown> } | undefined; const task = stored?.task; const workspace = state.workspaces[input.workspace_id] as ProductWorkspace | undefined; const taskRevision = typeof task?.revision === 'number' ? task.revision : 0
        let participants: WorkspaceBindParticipantReceipt[]; let blockerError: WorkspaceBindBlockerCode | undefined
        try {
          const inspected = await this.workspaceBindBlockers.inspect(input.task_id, taskRevision, input.workspace_id) as { receipts?: WorkspaceBindParticipantReceipt[]; ok?: boolean; code?: WorkspaceBindBlockerCode }
          blockerError = inspected.ok === false ? inspected.code : undefined
          participants = inspected.receipts ?? (inspected.ok === false
            ? inspected.code === 'QUEUE'
              ? defaultParticipantReceipts(false).map(receipt => receipt.participant === 'queue' ? { participant: 'queue', status: 'BLOCKED', code: 'QUEUE' } : receipt)
              : [{ participant: 'active_core_run', status: 'BLOCKED', code: 'ACTIVE_RUN' }, ...defaultParticipantReceipts(false).slice(1)]
            : defaultParticipantReceipts(false))
        } catch {
          blockerError = 'BLOCKER_UNAVAILABLE'
          participants = [{ participant: 'active_core_run', status: 'BLOCKED', code: 'ACTIVE_RUN' }, ...defaultParticipantReceipts(false).slice(1)]
        }
        participants = participants.map(receipt => receipt.participant === 'queue'
          ? receipt.status === 'BLOCKED' || hasUnsettledTaskQueue(state, input.task_id)
            ? { participant: 'queue', status: 'BLOCKED', code: 'QUEUE' }
            : { participant: 'queue', status: 'CLEAR' }
          : receipt)
        const blocked = participants.find(receipt => receipt.status === 'BLOCKED')
        if (blocked) { const rejectedError = blockerError ?? (blocked.participant === 'queue' ? 'QUEUE' : 'ACTIVE_RUN') as WorkspaceBindBlockerCode; const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_task_revision, outcome: 'rejected' as const, revision: state.revision + 1, result: { participant_receipts: participants, blocker_error: rejectedError } }; state.receipts[input.client_operation_id] = receipt; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'bind_workspace', revision: state.revision + 1, canonical_input: canonicalInput, participant_receipts: participants, blocker_error: rejectedError }; return { outcome: 'rejected' as const, receipt, participant_receipts: participants, error: rejectedError } }
        if (!task || !workspace || workspace.availability !== 'available' || taskRevision !== input.expected_task_revision || workspace.revision !== input.expected_workspace_revision) throw new Error('AUTHORITY_CONFLICT')

        let inspectedWorkspace: Awaited<ReturnType<WorkspaceFilesystemPort['inspect']>>
        try {
          inspectedWorkspace = await this.workspaceFs.inspect(workspace.canonical_root)
        } catch {
          throw new ApiError(409, '任务工作区不可用，需要重新关联', 'WORKSPACE_REQUIRED')
        }
        if (
          inspectedWorkspace.availability !== 'available'
          || inspectedWorkspace.identity.platform !== workspace.root_identity.platform
          || inspectedWorkspace.identity.volume_id !== workspace.root_identity.volume_id
          || inspectedWorkspace.identity.file_id !== workspace.root_identity.file_id
        ) {
          throw new ApiError(409, '任务工作区身份已变化，需要重新关联', 'WORKSPACE_REQUIRED')
        }

        const now = this.now().toISOString()
        const taskWorkDir = inspectedWorkspace.canonical_root

        // New tasks already live in revision 8. Keep their project and
        // directory registry aligned when a user deliberately moves the task
        // to a different registered workspace. Historical records below that
        // schema retain their migration boundary and still gain a safe run cwd.
        if (state.authority_schema_revision === 8) {
          const checkoutRoot = findProductGitRoot(taskWorkDir)
          const projectRoot = findProductCanonicalGitRoot(taskWorkDir) ?? taskWorkDir
          const directoryPath = checkoutRoot && path.resolve(checkoutRoot) !== path.resolve(projectRoot)
            ? projectRoot
            : taskWorkDir
          if (!isSameOrChildPath(projectRoot, directoryPath)) throw new Error('AUTHORITY_INVALID')

          const projectId = projectIdForRoot(this.installationId, projectRoot)
          const directoryId = directoryIdForPath(projectId, directoryPath)
          const existingProject = state.product_projects[projectId] as ProductProjectMetadata | undefined
          if (existingProject && existingProject.rootDir !== projectRoot) throw new Error('AUTHORITY_INVALID')
          if (!existingProject) {
            state.product_projects[projectId] = {
              id: projectId,
              title: productProjectTitle(projectRoot),
              rootDir: projectRoot,
              createdAt: now,
              updatedAt: now,
            }
          }

          const existingDirectory = state.product_directories[directoryId] as ProductProjectDirectoryMetadata | undefined
          if (existingDirectory && (existingDirectory.projectId !== projectId || existingDirectory.path !== directoryPath)) {
            throw new Error('AUTHORITY_INVALID')
          }
          if (!existingDirectory) {
            state.product_directories[directoryId] = {
              id: directoryId,
              projectId,
              path: directoryPath,
              label: productDirectoryLabel(projectRoot, directoryPath),
              createdAt: now,
              updatedAt: now,
            }
          }
          task.projectId = projectId
          task.directoryId = directoryId
        }

        const lineageId = typeof task.current_lineage_id === 'string' ? task.current_lineage_id : undefined
        const lineage = lineageId
          ? state.conversation_lineages[lineageId] as Record<string, unknown> | undefined
          : undefined
        if (lineage) {
          if (lineage.product_task_id !== input.task_id) throw new Error('AUTHORITY_INVALID')
          lineage.execution_directory = taskWorkDir
          lineage.updated_at = now
          if (typeof lineage.revision === 'number') lineage.revision += 1
        }

        const priorScope = state.task_scopes[input.task_id] as { generation?: number } | undefined
        state.task_scopes[input.task_id] = {
          kind: 'workspace',
          workspace_id: input.workspace_id,
          generation: (priorScope?.generation ?? 0) + 1,
        }
        task.task_scope = 'workspace'
        task.workDir = taskWorkDir
        task.updatedAt = now
        task.revision = taskRevision + 1
        workspace.canonical_root = taskWorkDir
        workspace.availability = inspectedWorkspace.availability
        workspace.updated_at = now
        workspace.revision += 1
        const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_task_revision, outcome: 'accepted' as const, revision: state.revision + 1, result: { participant_receipts: participants } }; state.receipts[input.client_operation_id] = receipt; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'bind_workspace', revision: state.revision + 1, canonical_input: canonicalInput, participant_receipts: participants }; return { outcome: 'accepted' as const, receipt, participant_receipts: participants }
      })
      const taskRevision = ((file.tasks[input.task_id] as { task?: { revision?: number } } | undefined)?.task?.revision ?? 0); const workspaceRevision = (file.workspaces[input.workspace_id] as ProductWorkspace | undefined)?.revision ?? 0
      return { authority_revision: file.revision, entity_revisions: { task: taskRevision, workspace: workspaceRevision }, ...result }
    } catch (error) { if (error instanceof ApiError) throw error; if ((error as Error).message !== 'AUTHORITY_CONFLICT') throw error; const current = await authority.read(); return { authority_revision: current.revision, entity_revisions: { task: ((current.tasks[input.task_id] as { task?: { revision?: number } } | undefined)?.task?.revision ?? 0), workspace: (current.workspaces[input.workspace_id] as ProductWorkspace | undefined)?.revision ?? 0 }, outcome: 'conflict' } }
  }

  async getComposerDraft(draftId: string): Promise<Record<string, unknown>> {
    const draft = (await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()).composer_drafts[draftId] as Record<string, unknown> | undefined
    if (!draft || draft.installation_id !== this.installationId) throw ApiError.notFound('草稿不存在')
    return { draft_id: draft.draft_id, workspace_id: draft.workspace_id, target_task_id: draft.target_task_id, revision: draft.revision, last_activity: draft.last_activity, state: draft.state, created_at: draft.created_at, expires_at: draft.expires_at }
  }

  async createComposerDraft(input: { target_task_id: string; workspace_id?: string; ttl_ms: number; client_operation_id: string }): Promise<{ draft: Record<string, unknown>; authority_revision: number; outcome: 'accepted' | 'duplicate' }> {
    if (!Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1) throw new ApiError(400, '草稿 TTL 无效', 'AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonical = JSON.stringify({ kind: 'composer_draft_create', target_task_id: input.target_task_id, workspace_id: input.workspace_id ?? null, ttl_ms: input.ttl_ms })
    const { file, result } = await authority.transactCapabilities((state) => {
      const prior = state.receipts[input.client_operation_id]
      if (prior) {
        if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT')
        const id = (prior.result as { entity_id?: string } | undefined)?.entity_id ?? state.events[input.client_operation_id]?.entity_id
        const draft = id ? state.composer_drafts[id] as Record<string, unknown> | undefined : undefined
        if (!draft) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { draft, outcome: 'duplicate' as const } }
      }
      const target = state.tasks[input.target_task_id] as { task?: unknown } | undefined
      const workspace = input.workspace_id ? state.workspaces[input.workspace_id] as ProductWorkspace | undefined : undefined
      if (!target?.task || (input.workspace_id && (!workspace || workspace.installation_id !== this.installationId || workspace.availability !== 'available'))) throw new ApiError(400, '草稿目标无效', 'AUTHORITY_INVALID')
      const now = this.now(); const draftId = `draft_${randomUUID()}`
      const draft = { draft_id: draftId, installation_id: this.installationId, target_task_id: input.target_task_id, target_state: 'existing_task', ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}), revision: 0, last_activity: now.toISOString(), state: 'active', created_at: now.toISOString(), expires_at: new Date(now.getTime() + input.ttl_ms).toISOString() }
      state.composer_drafts[draftId] = draft; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: 0, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: draftId } }; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'composer_draft_create', revision: state.revision + 1, canonical_input: canonical, entity_id: draftId }
      return { draft, outcome: 'accepted' as const }
    })
    return { draft: result.draft, authority_revision: file.revision, outcome: result.outcome }
  }

  async createNewTaskComposerDraft(input: { ttl_ms: number; client_operation_id: string; work_dir: string }): Promise<{ draft: Record<string, unknown>; authority_revision: number; outcome: 'accepted' | 'duplicate' }> {
    const selectedRoot = input.work_dir.trim()
    if (!Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1 || !selectedRoot) {
      throw ApiError.badRequest('新任务草稿必须指定可用工作目录')
    }

    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    // Keep the user-selected spelling in the idempotency identity. A retry of
    // an accepted operation must still return its draft if the directory later
    // disappears, rather than turning an unknown transport outcome into a new
    // operation or a misleading validation error.
    const canonical = JSON.stringify({ kind: 'new_task_draft', ttl_ms: input.ttl_ms, work_dir: selectedRoot })
    const { file, result } = await authority.transactCapabilitiesAsync(async (state) => {
      const prior = state.receipts[input.client_operation_id]
      if (prior) {
        if (state.events[input.client_operation_id]?.canonical_input !== canonical) {
          throw new Error('OPERATION_INPUT_CONFLICT')
        }
        const id = (prior.result as { entity_id?: string } | undefined)?.entity_id
        const draft = id ? state.composer_drafts[id] as Record<string, unknown> | undefined : undefined
        if (!draft) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { draft, outcome: 'duplicate' as const } }
      }

      let inspected: Awaited<ReturnType<WorkspaceFilesystemPort['inspect']>>
      try {
        inspected = await this.workspaceFs.inspect(selectedRoot)
      } catch {
        throw ApiError.badRequest('工作目录不可用')
      }
      if (inspected.availability !== 'available') {
        throw ApiError.badRequest('工作目录不存在或不可写')
      }

      const now = this.now().toISOString()
      const workspaceId = workspaceIdForIdentity(this.installationId, inspected.identity)
      const previousWorkspace = state.workspaces[workspaceId] as ProductWorkspace | undefined
      if (previousWorkspace && previousWorkspace.installation_id !== this.installationId) {
        throw new Error('AUTHORITY_INVALID')
      }
      const identityMatches = previousWorkspace
        && previousWorkspace.root_identity.platform === inspected.identity.platform
        && previousWorkspace.root_identity.volume_id === inspected.identity.volume_id
        && previousWorkspace.root_identity.file_id === inspected.identity.file_id
      state.workspaces[workspaceId] = previousWorkspace && identityMatches
        ? {
            ...previousWorkspace,
            canonical_root: inspected.canonical_root,
            availability: 'available',
            revision: previousWorkspace.availability === 'available' && previousWorkspace.canonical_root === inspected.canonical_root
              ? previousWorkspace.revision
              : previousWorkspace.revision + 1,
            updated_at: now,
          }
        : {
            workspace_id: workspaceId,
            installation_id: this.installationId,
            canonical_root: inspected.canonical_root,
            root_identity: inspected.identity,
            revision: 0,
            availability: 'available',
            created_at: now,
            updated_at: now,
          }

      const id = `draft_${randomUUID()}`
      const target = `task_${randomUUID()}`
      const draft = {
        draft_id: id,
        installation_id: this.installationId,
        target_task_id: target,
        target_state: 'pending_task',
        workspace_id: workspaceId,
        revision: 0,
        last_activity: now,
        state: 'active',
        created_at: now,
        expires_at: new Date(this.now().getTime() + input.ttl_ms).toISOString(),
      }
      state.composer_drafts[id] = draft
      state.receipts[input.client_operation_id] = {
        client_operation_id: input.client_operation_id,
        expected_revision: 0,
        outcome: 'accepted',
        revision: state.revision + 1,
        result: { entity_id: id },
      }
      state.event_sequence += 1
      state.events[input.client_operation_id] = {
        event_sequence: state.event_sequence,
        client_operation_id: input.client_operation_id,
        kind: 'new_task_draft',
        revision: state.revision + 1,
        canonical_input: canonical,
        entity_id: id,
      }
      return { draft, outcome: 'accepted' as const }
    })
    return { draft: result.draft, authority_revision: file.revision, outcome: result.outcome }
  }

  async mutateComposerDraft(input: { draft_id: string; expected_revision: number; client_operation_id: string; action: 'update' | 'consume' | 'expire' }): Promise<{ authority_revision: number; draft_revision: number; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const initial = await authority.read(); const prior = initial.receipts[input.client_operation_id]
    if (prior) return { authority_revision: initial.revision, draft_revision: (initial.composer_drafts[input.draft_id] as { revision?: number } | undefined)?.revision ?? 0, outcome: 'duplicate' }
    try { const { file } = await authority.mutateCapabilities((state) => { const draft = state.composer_drafts[input.draft_id] as Record<string, unknown> | undefined; if (!draft || draft.installation_id !== this.installationId || draft.revision !== input.expected_revision) throw new Error('AUTHORITY_CONFLICT'); const expired = this.now().getTime() >= Date.parse(draft.expires_at as string); if (expired && input.action !== 'expire') throw new Error('DRAFT_REJECTED'); if (draft.state !== 'active' && input.action !== 'expire') throw new Error('DRAFT_REJECTED'); const nextState = input.action === 'consume' ? 'consumed' : input.action === 'expire' ? 'expired' : 'active'; state.composer_drafts[input.draft_id] = { ...draft, state: nextState, revision: (draft.revision as number) + 1, last_activity: this.now().toISOString() }; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: state.revision + 1 } }); return { authority_revision: file.revision, draft_revision: (file.composer_drafts[input.draft_id] as { revision: number }).revision, outcome: 'accepted' } } catch (error) { const current = await authority.read(); return { authority_revision: current.revision, draft_revision: (current.composer_drafts[input.draft_id] as { revision?: number } | undefined)?.revision ?? 0, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected' } }
  }

  async registerAttachmentIdentity(owner: { kind: 'composer_draft' | 'product_task'; id: string }, metadata: VerifiedAttachmentMetadata, ttlMs: number, operationId: string): Promise<{ attachment_id: string; authority_revision: number; outcome: 'accepted' | 'duplicate' }> {
    if (!/^[a-f0-9]{64}$/.test(metadata.source_fingerprint) || !/^[a-f0-9]{64}$/.test(metadata.content_hash) || !metadata.verified_media_type || !Number.isSafeInteger(metadata.byte_size) || metadata.byte_size < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new ApiError(400, '附件验证元数据无效', 'AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const canonical = JSON.stringify({ kind: 'attachment_create', owner, metadata, ttl_ms: ttlMs })
    const { file, result } = await authority.transactCapabilities((state) => {
      const prior = state.receipts[operationId]
      if (prior) { if (state.events[operationId]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT'); const id = (prior.result as { entity_id?: string } | undefined)?.entity_id ?? state.events[operationId]?.entity_id; if (!id || !state.task_attachments[id]) throw new Error('AUTHORITY_INVALID'); return { changed: false as const, value: { id, outcome: 'duplicate' as const } } }
      const ownerRecord = owner.kind === 'composer_draft' ? state.composer_drafts[owner.id] : state.tasks[owner.id]
      if (!ownerRecord) throw new ApiError(400, '附件归属无效', 'AUTHORITY_INVALID')
      const id = `attachment_${randomUUID()}`; const now = this.now().toISOString(); state.task_attachments[id] = { attachment_id: id, installation_id: this.installationId, owner_kind: owner.kind, owner_id: owner.id, ...metadata, state: 'staged', refs: [owner.id], created_at: now, last_activity: now, expires_at: new Date(this.now().getTime() + ttlMs).toISOString(), revision: 0 }; state.receipts[operationId] = { client_operation_id: operationId, expected_revision: 0, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: id } }; state.event_sequence += 1; state.events[operationId] = { event_sequence: state.event_sequence, client_operation_id: operationId, kind: 'attachment_create', revision: state.revision + 1, canonical_input: canonical, entity_id: id }; return { id, outcome: 'accepted' as const }
    }); return { attachment_id: result.id, authority_revision: file.revision, outcome: result.outcome }
  }

  async ingestAttachment(input: {
    owner: { kind: 'composer_draft'; id: string }
    type: 'file' | 'image'
    name: string
    mime_type: string
    data?: string
    bytes?: Buffer
    client_operation_id: string
  }): Promise<{ attachment_id: string; attachment_revision: number; authority_revision: number; outcome: 'accepted' | 'duplicate' }> {
    const verified = input.bytes
      ? verifyProductAttachmentBytes({ ...input, bytes: input.bytes })
      : typeof input.data === 'string'
        ? verifyProductAttachmentInput({ ...input, data: input.data })
        : null
    if (!verified) throw new ApiError(422, '附件内容或类型无效', 'ATTACHMENT_REJECTED')
    const registered = await this.registerAttachmentIdentity(input.owner, {
      source_fingerprint: verified.sourceFingerprint,
      content_hash: verified.contentHash,
      verified_media_type: verified.mediaType,
      storage_kind: 'app_owned_copy',
      byte_size: verified.bytes.length,
    }, 7 * 24 * 60 * 60 * 1000, input.client_operation_id)
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const current = (await authority.read()).task_attachments[registered.attachment_id] as { state?: unknown; revision?: unknown } | undefined
    if (!current || typeof current.revision !== 'number') throw new ApiError(422, '附件登记无效', 'ATTACHMENT_REJECTED')
    if (current.state === 'ready' || current.state === 'accepted_bound') {
      await resolveProductAttachmentCopy(productAttachmentStorageRoot(this.storagePath), registered.attachment_id, verified.contentHash, verified.bytes.length)
      return { ...registered, attachment_revision: current.revision }
    }
    let revision = current.revision
    if (current.state === 'staged') {
      const inspecting = await this.transitionAttachment({ attachment_id: registered.attachment_id, expected_revision: revision, target_state: 'inspecting', client_operation_id: `${input.client_operation_id}:inspect` })
      if (!['accepted', 'duplicate'].includes(inspecting.outcome)) throw new ApiError(422, '附件检查无法开始', 'ATTACHMENT_REJECTED')
      revision = inspecting.attachment_revision
    } else if (current.state !== 'inspecting') {
      throw new ApiError(422, '附件状态无效', 'ATTACHMENT_REJECTED')
    }
    try {
      await storeProductAttachmentCopy(productAttachmentStorageRoot(this.storagePath), registered.attachment_id, verified)
      const ready = await this.transitionAttachment({ attachment_id: registered.attachment_id, expected_revision: revision, target_state: 'ready', client_operation_id: `${input.client_operation_id}:ready` })
      if (!['accepted', 'duplicate'].includes(ready.outcome)) throw new Error('ATTACHMENT_READY_REJECTED')
      return { ...registered, attachment_revision: ready.attachment_revision }
    } catch {
      await this.transitionAttachment({ attachment_id: registered.attachment_id, expected_revision: revision, target_state: 'failed', client_operation_id: `${input.client_operation_id}:failed`, error: 'INGEST_FAILED' }).catch(() => undefined)
      throw new ApiError(422, '附件保存失败', 'ATTACHMENT_REJECTED')
    }
  }

  async transitionAttachment(input: { attachment_id: string; expected_revision: number; target_state: 'inspecting' | 'ready' | 'failed' | 'cancelled' | 'discarded'; client_operation_id: string; error?: string }): Promise<{ authority_revision: number; attachment_revision: number; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const initial = await authority.read(); const canonical = JSON.stringify({ kind: 'attachment_transition', attachment_id: input.attachment_id, expected_revision: input.expected_revision, target_state: input.target_state, error: input.error ?? null }); if (initial.receipts[input.client_operation_id]) { if (initial.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT'); return { authority_revision: initial.revision, attachment_revision: (initial.task_attachments[input.attachment_id] as { revision?: number } | undefined)?.revision ?? 0, outcome: 'duplicate' } }
    try { const { file } = await authority.mutateCapabilities((state) => { const attachment = state.task_attachments[input.attachment_id] as Record<string, unknown> | undefined; if (!attachment || attachment.installation_id !== this.installationId || attachment.revision !== input.expected_revision) throw new Error('AUTHORITY_CONFLICT'); const allowed: Record<string, readonly string[]> = { staged: ['inspecting', 'failed', 'cancelled', 'discarded'], inspecting: ['ready', 'failed', 'cancelled', 'discarded'], ready: ['failed', 'discarded'], failed: [], cancelled: [], discarded: [], accepted_bound: [] }; if (this.now().getTime() >= Date.parse(attachment.expires_at as string) && input.target_state !== 'discarded') throw new Error('ATTACHMENT_REJECTED'); if (!allowed[attachment.state as string]?.includes(input.target_state)) throw new Error('ATTACHMENT_REJECTED'); state.task_attachments[input.attachment_id] = { ...attachment, state: input.target_state, revision: input.expected_revision + 1, last_activity: this.now().toISOString() }; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: state.revision + 1 }; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'attachment_transition', revision: state.revision + 1, canonical_input: canonical } }); return { authority_revision: file.revision, attachment_revision: (file.task_attachments[input.attachment_id] as { revision: number }).revision, outcome: 'accepted' } } catch (error) { const file = await authority.read(); return { authority_revision: file.revision, attachment_revision: (file.task_attachments[input.attachment_id] as { revision?: number } | undefined)?.revision ?? 0, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected' } }
  }

  async bindAttachment(attachmentId: string, expectedRevision: number, owner: { kind: 'composer_draft' | 'product_task'; id: string }, operationId: string): Promise<{ authority_revision: number; attachment_revision: number; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const initial = await authority.read(); const canonical = JSON.stringify({ kind: 'attachment_bind', attachment_id: attachmentId, expected_revision: expectedRevision, owner }); if (initial.receipts[operationId]) { if (initial.events[operationId]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT'); return { authority_revision: initial.revision, attachment_revision: (initial.task_attachments[attachmentId] as { revision?: number } | undefined)?.revision ?? 0, outcome: 'duplicate' } }
    try { const { file } = await authority.mutateCapabilities((state) => { const attachment = state.task_attachments[attachmentId] as Record<string, unknown> | undefined; if (!attachment || attachment.installation_id !== this.installationId || attachment.revision !== expectedRevision) throw new Error('AUTHORITY_CONFLICT'); if (attachment.state !== 'ready' || this.now().getTime() >= Date.parse(attachment.expires_at as string)) throw new Error('ATTACHMENT_REJECTED'); const sameOwner = attachment.owner_kind === owner.kind && attachment.owner_id === owner.id; const draft = attachment.owner_kind === 'composer_draft' ? state.composer_drafts[attachment.owner_id as string] as Record<string, unknown> | undefined : undefined; const legalTransfer = owner.kind === 'product_task' && draft?.target_task_id === owner.id && state.tasks[owner.id]; if (!sameOwner && !legalTransfer) throw new Error('ATTACHMENT_REJECTED'); state.task_attachments[attachmentId] = { ...attachment, owner_kind: owner.kind, owner_id: owner.id, state: 'accepted_bound', refs: [...attachment.refs as string[], owner.id], revision: expectedRevision + 1, last_activity: this.now().toISOString() }; state.receipts[operationId] = { client_operation_id: operationId, expected_revision: expectedRevision, outcome: 'accepted', revision: state.revision + 1 }; state.event_sequence += 1; state.events[operationId] = { event_sequence: state.event_sequence, client_operation_id: operationId, kind: 'attachment_bind', revision: state.revision + 1, canonical_input: canonical } }); return { authority_revision: file.revision, attachment_revision: (file.task_attachments[attachmentId] as { revision: number }).revision, outcome: 'accepted' } } catch (error) { const file = await authority.read(); return { authority_revision: file.revision, attachment_revision: (file.task_attachments[attachmentId] as { revision?: number } | undefined)?.revision ?? 0, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected' } }
  }

  async consumeDraftWithAttachments(input: { draft_id: string; expected_draft_revision: number; attachment_ids: string[]; target_task_id: string; client_operation_id: string }): Promise<{ authority_revision: number; entity_revisions: Record<string, number>; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const initial = await authority.read(); const canonical = JSON.stringify({ kind: 'composer_draft_consume', draft_id: input.draft_id, target_task_id: input.target_task_id, expected_draft_revision: input.expected_draft_revision, attachment_ids: input.attachment_ids }); if (initial.receipts[input.client_operation_id]) { if (initial.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT'); return { authority_revision: initial.revision, entity_revisions: {}, outcome: 'duplicate' } }
    try { const { file } = await authority.mutateCapabilities((state) => { const draft = state.composer_drafts[input.draft_id] as Record<string, unknown> | undefined; if (!draft || draft.installation_id !== this.installationId || draft.revision !== input.expected_draft_revision || draft.target_task_id !== input.target_task_id || !(state.tasks[input.target_task_id] as { task?: unknown } | undefined)?.task || draft.state !== 'active' || this.now().getTime() >= Date.parse(draft.expires_at as string) || new Set(input.attachment_ids).size !== input.attachment_ids.length) throw new Error('DRAFT_REJECTED'); const attachments = input.attachment_ids.map(id => { const item = state.task_attachments[id] as Record<string, unknown> | undefined; if (!item || item.installation_id !== this.installationId || item.owner_kind !== 'composer_draft' || item.owner_id !== input.draft_id || item.state !== 'ready' || this.now().getTime() >= Date.parse(item.expires_at as string)) throw new Error('ATTACHMENT_REJECTED'); return [id, item] as const }); const at = this.now().toISOString(); for (const [id, item] of attachments) state.task_attachments[id] = { ...item, owner_kind: 'product_task', owner_id: input.target_task_id, state: 'accepted_bound', refs: [...item.refs as string[], input.target_task_id], revision: (item.revision as number) + 1, last_activity: at }; state.composer_drafts[input.draft_id] = { ...draft, state: 'consumed', revision: (draft.revision as number) + 1, last_activity: at }; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_draft_revision, outcome: 'accepted', revision: state.revision + 1 }; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'composer_draft_consume', revision: state.revision + 1, canonical_input: canonical } }); const revisions: Record<string, number> = { draft: (file.composer_drafts[input.draft_id] as { revision: number }).revision }; for (const id of input.attachment_ids) revisions[id] = (file.task_attachments[id] as { revision: number }).revision; return { authority_revision: file.revision, entity_revisions: revisions, outcome: 'accepted' } } catch (error) { const file = await authority.read(); return { authority_revision: file.revision, entity_revisions: {}, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected' } }
  }

  async createConversationLineage(input: { task_id: string; expected_task_revision?: number; client_operation_id: string; parent_lineage_id?: string; fork_checkpoint_id?: string }): Promise<{ lineage: Record<string, unknown>; authority_revision: number; outcome: 'accepted' | 'duplicate' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const canonical = JSON.stringify({ kind: 'lineage_create', task_id: input.task_id, expected_task_revision: input.expected_task_revision ?? null, parent_lineage_id: input.parent_lineage_id ?? null, fork_checkpoint_id: input.fork_checkpoint_id ?? null })
    const { file, result } = await authority.transactCapabilities((state) => {
      const prior = state.receipts[input.client_operation_id]
      if (prior) { if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT'); const id = (prior.result as { entity_id?: string } | undefined)?.entity_id ?? state.events[input.client_operation_id]?.entity_id; const stored = id ? state.conversation_lineages[id] as Record<string, unknown> | undefined : undefined; if (!stored) throw new Error('AUTHORITY_INVALID'); const { resume_binding_id: _private, ...lineage } = stored; return { changed: false as const, value: { lineage, outcome: 'duplicate' as const } } }
      if (input.parent_lineage_id && (!(state.conversation_lineages[input.parent_lineage_id] as Record<string, unknown> | undefined) || (state.conversation_lineages[input.parent_lineage_id] as Record<string, unknown>).product_task_id !== input.task_id)) throw new Error('AUTHORITY_INVALID'); const task = state.tasks[input.task_id] as { task?: Record<string, unknown> } | undefined; if (!task?.task || (input.expected_task_revision !== undefined && (typeof task.task.revision === 'number' ? task.task.revision : 0) !== input.expected_task_revision)) throw new Error('AUTHORITY_CONFLICT'); const now = this.now().toISOString(); const id = `lineage_${randomUUID()}`; const stored = { lineage_id: id, product_task_id: input.task_id, ...(input.parent_lineage_id ? { parent_lineage_id: input.parent_lineage_id } : {}), ...(input.fork_checkpoint_id ? { fork_checkpoint_id: input.fork_checkpoint_id } : {}), revision: 0, compact_generation: 0, resume_binding_id: `resume_${randomUUID()}`, state: 'active', created_at: now, updated_at: now }; state.conversation_lineages[id] = stored; if (!input.parent_lineage_id) { task.task.current_lineage_id = id; task.task.revision = (typeof task.task.revision === 'number' ? task.task.revision : 0) + 1 }; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: 0, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: id } }; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'lineage_create', revision: state.revision + 1, canonical_input: canonical, entity_id: id }; const { resume_binding_id: _private, ...lineage } = stored; return { lineage, outcome: 'accepted' as const }
    }); return { lineage: result.lineage, authority_revision: file.revision, outcome: result.outcome }
  }

  async mutateConversationLineage(input: { lineage_id: string; expected_revision: number; client_operation_id: string; action: 'advance' | 'park' | 'recovery'; head_entry_id?: string }): Promise<{ authority_revision: number; lineage_revision: number; outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const before = await authority.read(); const canonical = JSON.stringify({ kind: 'lineage_mutate', lineage_id: input.lineage_id, expected_revision: input.expected_revision, action: input.action, head_entry_id: input.head_entry_id ?? null }); if (before.receipts[input.client_operation_id]) { if (before.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT'); return { authority_revision: before.revision, lineage_revision: (before.conversation_lineages[input.lineage_id] as { revision?: number } | undefined)?.revision ?? 0, outcome: 'duplicate' } }
    try { const { file } = await authority.mutateCapabilities((state) => { const lineage = state.conversation_lineages[input.lineage_id] as Record<string, unknown> | undefined; if (!lineage || lineage.revision !== input.expected_revision) throw new Error('AUTHORITY_CONFLICT'); if (input.action === 'advance' && (!input.head_entry_id || lineage.state !== 'active')) throw new Error('LINEAGE_REJECTED'); const next = { ...lineage, ...(input.action === 'advance' ? { head_entry_id: input.head_entry_id } : {}), ...(input.action === 'park' ? { state: 'parked' } : {}), ...(input.action === 'recovery' ? { state: 'recovery_required' } : {}), revision: (lineage.revision as number) + 1, updated_at: this.now().toISOString() }; state.conversation_lineages[input.lineage_id] = next; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: state.revision + 1 }; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'lineage_mutate', revision: state.revision + 1, canonical_input: canonical } }); return { authority_revision: file.revision, lineage_revision: (file.conversation_lineages[input.lineage_id] as { revision: number }).revision, outcome: 'accepted' } } catch (error) { const file = await authority.read(); return { authority_revision: file.revision, lineage_revision: (file.conversation_lineages[input.lineage_id] as { revision?: number } | undefined)?.revision ?? 0, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected' } }
  }

  async setConversationLineageCurrent(input: { task_id: string; lineage_id: string; expected_task_revision: number; expected_lineage_revision: number; client_operation_id: string }): Promise<{ authority_revision: number; task_revision: number; outcome: 'accepted' | 'duplicate' | 'conflict' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); const before = await authority.read(); const canonical = JSON.stringify({ kind: 'lineage_set_current', task_id: input.task_id, lineage_id: input.lineage_id, expected_task_revision: input.expected_task_revision, expected_lineage_revision: input.expected_lineage_revision }); if (before.receipts[input.client_operation_id]) { if (before.events[input.client_operation_id]?.canonical_input !== canonical) throw new ApiError(409, '操作标识已绑定不同输入', 'AUTHORITY_CONFLICT'); return { authority_revision: before.revision, task_revision: ((before.tasks[input.task_id] as { task?: { revision?: number } } | undefined)?.task?.revision ?? 0), outcome: 'duplicate' } }
    try { const { file } = await authority.mutateCapabilities((state) => { const stored = state.tasks[input.task_id] as { task?: Record<string, unknown> } | undefined; const lineage = state.conversation_lineages[input.lineage_id] as Record<string, unknown> | undefined; const revision = typeof stored?.task?.revision === 'number' ? stored.task.revision : 0; if (!stored?.task || !lineage || lineage.product_task_id !== input.task_id || revision !== input.expected_task_revision || lineage.revision !== input.expected_lineage_revision) throw new Error('AUTHORITY_CONFLICT'); stored.task.current_lineage_id = input.lineage_id; if (typeof lineage.execution_directory === 'string') stored.task.workDir = lineage.execution_directory; stored.task.revision = revision + 1; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: input.expected_task_revision, outcome: 'accepted', revision: state.revision + 1 }; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'lineage_set_current', revision: state.revision + 1, canonical_input: canonical } }); return { authority_revision: file.revision, task_revision: ((file.tasks[input.task_id] as { task?: { revision?: number } }).task?.revision ?? 0), outcome: 'accepted' } } catch { const file = await authority.read(); return { authority_revision: file.revision, task_revision: ((file.tasks[input.task_id] as { task?: { revision?: number } } | undefined)?.task?.revision ?? 0), outcome: 'conflict' } }
  }

  async getConversationLineageRoot(lineageId: string): Promise<Record<string, unknown>> {
    const file = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    let lineage = file.conversation_lineages[lineageId] as Record<string, unknown> | undefined
    if (!lineage) throw ApiError.notFound('会话谱系不存在')
    const seen = new Set<string>()
    while (typeof lineage.parent_lineage_id === 'string') {
      if (seen.has(lineage.lineage_id as string)) throw new ApiError(409, '会话谱系无效', 'AUTHORITY_INVALID')
      seen.add(lineage.lineage_id as string)
      lineage = file.conversation_lineages[lineage.parent_lineage_id] as Record<string, unknown> | undefined
      if (!lineage) throw new ApiError(409, '会话谱系无效', 'AUTHORITY_INVALID')
    }
    const { resume_binding_id: _private, ...publicLineage } = lineage
    return publicLineage
  }

  async getConversationLineageCurrent(taskId: string): Promise<Record<string, unknown> | null> {
    const file = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const task = (file.tasks[taskId] as { task?: { current_lineage_id?: unknown } } | undefined)?.task
    if (typeof task?.current_lineage_id !== 'string') return null
    return this.getConversationLineage(task.current_lineage_id)
  }

  async getConversationLineage(lineageId: string): Promise<Record<string, unknown>> {
    const lineage = (await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()).conversation_lineages[lineageId] as Record<string, unknown> | undefined; if (!lineage) throw ApiError.notFound('会话谱系不存在'); const { resume_binding_id: _private, ...publicLineage } = lineage; return publicLineage
  }

  async resolveCoreSessionId(taskId: string): Promise<string> {
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const record = authority.tasks[taskId] as { binding?: { coreSessionId?: unknown } } | undefined
    if (typeof record?.binding?.coreSessionId === 'string' && record.binding.coreSessionId) return record.binding.coreSessionId
    throw ApiError.notFound(`任务不存在：${taskId}`)
  }

  async getTaskThread(taskId: string): Promise<ProductTaskThread> {
    await this.materializeLegacyTaskThread(taskId)
    const entries: ProductTaskThreadEntry[] = []
    let cursor = 0
    let hasMore = true
    while (hasMore) {
      const page = await this.listTaskEvents(taskId, cursor, 200)
      for (const event of page.events) {
        if (event.type === 'user_text') {
          entries.push({
            id: event.item_id ?? durableUserItemId(event.run_id),
            type: 'user_text',
            text: event.text,
            createdAt: event.created_at,
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
            ...(event.reference_entry_ids?.length ? { referenceEntryIds: [...event.reference_entry_ids] } : {}),
          })
        } else if (event.type === 'assistant_text') {
          entries.push({ id: event.item_id, type: 'assistant_text', text: event.text, createdAt: event.created_at })
        } else if (event.type === 'activity' && (event.phase === 'completed' || event.phase === 'failed')) {
          entries.push({ id: event.item_id, type: 'activity', kind: event.kind, phase: event.phase, createdAt: event.created_at })
        }
      }
      cursor = page.cursor
      hasMore = page.has_more === true
    }
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const unknownOutcomeRunId = outcomeUnknownTaskRunId(authority, taskId)
    const unknownOutcomeDispatch = unknownOutcomeRunId
      ? authority.dispatch_records[unknownOutcomeRunId] as DurableTaskRunDispatch | undefined
      : undefined
    const unknownOutcomeOperation = unknownOutcomeDispatch
      ? primaryUnknownExternalOperation(unknownOutcomeDispatch)
      : undefined
    return {
      taskId,
      entries,
      ...(recoveryRequiredTaskRunId(authority, taskId) ? { recoveryRequired: true } : {}),
      ...(unknownOutcomeRunId && unknownOutcomeOperation && Number.isSafeInteger(unknownOutcomeDispatch?.dispatch_generation)
        ? { outcomeUnknown: publicOutcomeUnknown(unknownOutcomeRunId, unknownOutcomeDispatch!.dispatch_generation as number, unknownOutcomeOperation) }
        : {}),
    }
  }

  private async resolveTaskBranchSource(
    taskId: string,
    sourceEntryId: string,
    authority: AuthorityFile,
  ): Promise<{ coreSessionId: string; coreTurnId: string; checkpointEntryId: string }> {
    const durableEntry = authority.thread_entries[sourceEntryId] as { task_id?: unknown; run_id?: unknown; core_session_id?: unknown; core_message_id?: unknown } | undefined
    if (durableEntry?.task_id === taskId && typeof durableEntry.run_id === 'string' && typeof durableEntry.core_session_id === 'string' && typeof durableEntry.core_message_id === 'string') {
      const run = authority.task_runs[durableEntry.run_id] as { task_id?: unknown; entry_id?: unknown } | undefined
      if (run?.task_id === taskId && typeof run.entry_id === 'string') {
        return { coreSessionId: durableEntry.core_session_id, coreTurnId: durableEntry.core_message_id, checkpointEntryId: run.entry_id }
      }
      throw new Error('AUTHORITY_INVALID')
    }
    throw ApiError.badRequest('请选择当前任务谱系中的一条已保存消息')
  }

  /**
   * Durable authority-only operation used by the BB-02A mutation path.  It
   * intentionally does not touch product-tasks.json: callers reserve before
   * Core and may safely replay the same envelope after a crash.
   */
  async executeAuthorityOperation(input: {
    authorityPath: string
    client_operation_id: string
    product_task_id: string
    kind: 'create' | 'branch' | 'close'
    canonical_input: string
    expected_revision: number
    ensure: () => Promise<unknown>
  }): Promise<{ outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number }> {
    const authority = new ProductTaskAuthorityRepository(input.authorityPath)
    try {
      const reserved = await authority.reserve({
        client_operation_id: input.client_operation_id,
        product_task_id: input.product_task_id,
        kind: input.kind,
        canonical_input: input.canonical_input,
        expected_revision: input.expected_revision,
      })
      const prior = reserved.file.receipts[input.client_operation_id]
      if (prior) return { outcome: 'duplicate', revision: prior.revision }
      try {
        const binding = await input.ensure()
        const final = await authority.finalize(input.client_operation_id, {
          client_operation_id: input.client_operation_id,
          expected_revision: input.expected_revision,
          outcome: 'accepted',
          revision: reserved.file.revision,
        }, binding)
        return { outcome: 'accepted', revision: final.revision }
      } catch (error) {
        const final = await authority.finalize(input.client_operation_id, {
          client_operation_id: input.client_operation_id,
          expected_revision: input.expected_revision,
          outcome: 'rejected',
          revision: reserved.file.revision,
          error: 'OPERATION_REJECTED',
        })
        void final
        throw error
      }
    } catch (error) {
      if ((error as Error).message === 'AUTHORITY_CONFLICT') return { outcome: 'conflict', revision: (await authority.read()).revision }
      throw error
    }
  }

}

/** Each Local Product Server owns one explicitly composed Task Authority. */
export function createProductTaskService(options: {
  additionalLifecycleParticipants?: readonly TaskLifecycleParticipant[]
  dispatcher?: ProductTaskRunDispatchPort
  runtimeEvents?: ProductTaskRuntimeEventPort
} = {}): ProductTaskService {
  return new ProductTaskService(options)
}
