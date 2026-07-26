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
  type CreateProductTaskInput,
  type CreateProductSideTaskInput,
  type ProductContinuationTarget,
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
  type UpdateProductTaskInput,
} from '../../../shared/product/domain.js'
import type { ProductTaskActionApproval, ProductTaskAttachmentSummary, ProductTaskEvent, ProductTaskQuestion, ProductTaskQueuedInput, ProductTaskThread, ProductTaskThreadEntry, TaskEvent } from '../../../shared/product/taskEvents.js'
import { assertAuthorityMapKey } from '../../../shared/product/authority.js'
import type {
  ProductTaskReviewComment,
  ProductTaskReviewCommentMutation,
  WorkspaceFileRef,
} from '../../../shared/product/taskReview.js'
import type { AgentWorkerApprovalReviewFacts, AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  projectSessionTranscriptForProductTask,
  resolveCoreMessageIdForProductThreadEntry,
} from './taskThreadProjection.js'
import { findProductCanonicalGitRoot, findProductGitRoot } from './productGit.js'
import {
  isRecord,
  latestProductTimestamp,
  legacyProductTaskId,
  readStrictLegacyProductTasks,
  normalizeLegacyV1SideTasks,
  normalizeMetadata,
  normalizeModernTaskStore,
  optionalString,
} from './legacyProductTaskReader.js'
import { ProductTaskAuthorityRepository, readLegacyProductTasks, type AuthorityFile, type ProductTaskAuthorityRepositoryDeps } from './authorityRepository.js'
import {
  ProductCoreOperationTerminalError,
  type ProductCoreOperationBridge,
} from './productCoreOperationBridge.js'
import { ProductSettingsRepository } from './productSettingsRepository.js'
import { ProductHarnessSessionRepository } from '../agent-worker/harnessSessionRepository.js'
import { ProductAutoMemoryRepository } from '../services/productAutoMemory.js'
import { productTaskWorkerRuntimeEvents } from './taskWorkerRuntimeEvents.js'
import { productTaskActivitySummary } from './taskEventProjection.js'
import { productTextReasoningBinding } from './productGatewayRuntime.js'
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

export type ProductTaskMetadata = {
  id: string
  /** Private Agent Core binding. Never return this from a product API. */
  coreSessionId: string
  /** Product-owned project binding; never derived from a Core session again. */
  projectId?: string
  /** Product-owned source-directory binding; separate from the live workDir. */
  directoryId?: string
  title?: string
  lifecycle: ProductTask['lifecycle']
  kind: ProductTask['kind']
  pinnedAt?: string
  archivedAt?: string
  parentTaskId?: string
  sourceTurnId?: string
  createdAt: string
  updatedAt: string
  worktreeState: ProductTask['worktreeState']
  visibility?: 'main' | 'side_task'
  permission_snapshot?: ProductPermissionSnapshot
}

export type ProductSideTaskMetadata = ProductSideTask & {
  /** Private Agent Core binding for the temporary branch. */
  coreSessionId: string
  /** Private Core turn selected by the product-thread entry. */
  sourceTurnId: string
}

export type ProductProjectMetadata = Pick<
  ProductProject,
  'id' | 'title' | 'rootDir' | 'createdAt' | 'updatedAt'
>

export type ProductProjectDirectoryMetadata = ProductProjectDirectory

const PRODUCT_TASK_STORE_VERSION = 4 as const
// Keep persisted v1 task metadata readable even when the public product
// response schema advances independently.
const LEGACY_PRODUCT_TASK_STORE_VERSION = 1 as const
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

export type ProductTaskStore = {
  version: typeof PRODUCT_TASK_STORE_VERSION
  projects: Record<string, ProductProjectMetadata>
  directories: Record<string, ProductProjectDirectoryMetadata>
  tasks: Record<string, ProductTaskMetadata>
  sideTasks: Record<string, ProductSideTaskMetadata>
  /**
   * The legacy Core-session list was imported once into this product-owned
   * registry. Future Core sessions are not automatically promoted to product
   * tasks, so the product index has a single durable source of truth.
   */
  legacyCoreSessionsImportedAt?: string
}

type ProductDirectoryBinding = {
  project: ProductProjectMetadata
  directory: ProductProjectDirectoryMetadata
}

type RegisteredProductDirectory = ProductDirectoryBinding & {
  changed: boolean
}

export type AgentCoreSession = {
  id: string
  title?: string
  createdAt: string
  modifiedAt: string
  projectRoot?: string
  workDir?: string
}

type MessageEntry = Parameters<typeof projectSessionTranscriptForProductTask>[1][number]

export type AgentCoreAdapter = {
  listSessions: () => Promise<AgentCoreSession[]>
  createSession: (input: {
    workDir: string
    permissionMode?: string
    useWorktree?: boolean
  }) => Promise<{ sessionId: string; workDir: string }>
  renameSession: (sessionId: string, title: string) => Promise<void>
  branchSession: (
    sessionId: string,
    title?: string,
    sourceTurnId?: string,
    target?: ProductContinuationTarget,
  ) => Promise<{
    sessionId: string
    workDir: string
    title: string
  }>
  getWorktreeLaunchState: (sessionId: string) => Promise<ProductTask['worktreeState']>
  getSessionMessages?: (sessionId: string) => Promise<MessageEntry[]>
}

const nativeCoreWorkDirs = new Map<string, string>()

/**
 * Server-owned product runtime state. The Core session ID never crosses the
 * product API, but the task registry needs this narrow check to keep a live
 * task from being hidden while its stop or approval controls are still needed.
 */
type ProductTaskRunDispatcher = {
  dispatch(runId: string, generation: number, kind?: 'interactive' | 'scheduled'): Promise<'started' | 'queued' | 'recovery_required'>
  stop?(runId: string, generation: number): Promise<void>
  approve?(runId: string, generation: number, requestId: string, allowed: boolean): Promise<boolean>
  answer?(runId: string, generation: number, requestId: string, answers: readonly string[]): Promise<boolean>
  steer?(runId: string, generation: number, queueItemId: string, text: string): Promise<boolean>
}

type DurableTaskRunApproval = {
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

type DurableTaskRun = { run_id?: unknown; task_id?: unknown; created_at?: unknown }
type DurableTaskRunDispatch = { dispatch_generation?: unknown; state?: unknown; completed_at?: unknown; error?: unknown }
type DurableContextSnapshot = {
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
type DurableSessionContext = {
  text: string
  event_sequence: number
  estimated_tokens: number
  compact_generation: number
}
type DurableTurnInput = {
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
const MAX_TASK_RUN_QUEUE_DEPTH = 8
const MAX_DURABLE_ASSISTANT_TEXT_LENGTH = 100_000
const MAX_TASK_ATTACHMENT_TOTAL_BYTES = 64 * 1024 * 1024

function durableAssistantItemId(runId: string, dispatchGeneration: number): string {
  return `thread_${createHash('sha256').update(`${runId}:${dispatchGeneration}:assistant`).digest('hex').slice(0, 20)}`
}

function durableUserItemId(runId: string): string {
  return `thread_${createHash('sha256').update(`${runId}:user`).digest('hex').slice(0, 20)}`
}

function durableTerminalItemId(runId: string, dispatchGeneration: number): string {
  return `turn_${createHash('sha256').update(`${runId}:${dispatchGeneration}:terminal`).digest('hex').slice(0, 32)}`
}

function durableContextCompactionItemId(runId: string, dispatchGeneration: number, compactGeneration: number): string {
  return `compact_${createHash('sha256').update(`${runId}:${dispatchGeneration}:${compactGeneration}:context-compaction`).digest('hex').slice(0, 32)}`
}

function durableApprovalItemId(runId: string, dispatchGeneration: number, requestId: string): string {
  return `approval_${createHash('sha256').update(`${runId}:${dispatchGeneration}:${requestId}`).digest('hex').slice(0, 32)}`
}

function taskRunContextCursor(state: AuthorityFile, runId: string, run: Record<string, unknown>): number {
  const binding = run.core_binding as { context_event_sequence?: unknown } | undefined
  if (Number.isSafeInteger(binding?.context_event_sequence) && (binding!.context_event_sequence as number) >= 0) return binding!.context_event_sequence as number
  const firstInput = Object.values(state.task_events)
    .map(value => value as TaskEvent)
    .filter((event): event is Extract<TaskEvent, { type: 'user_text' }> => event.type === 'user_text' && event.run_id === runId)
    .sort((left, right) => left.event_sequence - right.event_sequence)[0]
  if (!firstInput) throw new Error('AUTHORITY_INVALID')
  return firstInput.event_sequence - 1
}

function renderDurableSessionContext(state: AuthorityFile, runId: string, run: Record<string, unknown>): DurableSessionContext {
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
    limit = Object.values(state.task_events)
      .map(value => value as TaskEvent)
      .filter(event => 'run_id' in event && event.run_id === checkpoint.run_id)
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
  return {
    text,
    event_sequence: cursor,
    estimated_tokens: Math.max(0, Math.ceil(text.length / 4)),
    compact_generation: currentLineage.compact_generation as number,
  }
}

function orderedTaskRunIds(state: AuthorityFile, taskId: string): string[] {
  const sequence = new Map<string, number>()
  for (const value of Object.values(state.task_events)) {
    const event = value as { task_id?: unknown; run_id?: unknown; event_sequence?: unknown }
    if (event.task_id === taskId && typeof event.run_id === 'string' && typeof event.event_sequence === 'number') sequence.set(event.run_id, event.event_sequence)
  }
  return Object.values(state.task_runs)
    .map(value => value as DurableTaskRun)
    .filter(run => run.task_id === taskId && typeof run.run_id === 'string')
    .sort((left, right) => (sequence.get(left.run_id as string) ?? Number.MAX_SAFE_INTEGER) - (sequence.get(right.run_id as string) ?? Number.MAX_SAFE_INTEGER)
      || Date.parse(left.created_at as string) - Date.parse(right.created_at as string)
      || (left.run_id as string).localeCompare(right.run_id as string))
    .map(run => run.run_id as string)
}

/** The first non-terminal run is the only one eligible to leave a task queue. */
function nextTaskRunId(state: AuthorityFile, taskId: string): string | undefined {
  for (const runId of orderedTaskRunIds(state, taskId)) {
    const status = (state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state
    if (status === 'terminal') continue
    return status === 'pending' ? runId : undefined
  }
}

function recoveryRequiredTaskRunId(state: AuthorityFile, taskId: string): string | undefined {
  for (const runId of orderedTaskRunIds(state, taskId)) {
    const status = (state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state
    if (status === 'terminal') continue
    return status === 'recovery_required' ? runId : undefined
  }
}

function hasUnsettledTaskQueue(state: AuthorityFile, taskId: string): boolean {
  return orderedTaskRunIds(state, taskId).some(runId => ['pending', 'claimed', 'started', 'recovery_required'].includes((state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state as string))
}

function hasBlockingTaskWork(state: AuthorityFile, taskId: string): boolean {
  return hasUnsettledTaskQueue(state, taskId) || orderedQueuedInputs(state, taskId).length > 0
}

function hasQueuedTaskWork(state: AuthorityFile, taskId: string): boolean {
  return orderedTaskRunIds(state, taskId).some((runId) => {
    const status = (state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state
    return status === 'pending' || status === 'recovery_required'
  }) || orderedQueuedInputs(state, taskId).length > 0
}

function activeTaskRun(state: AuthorityFile, taskId: string): { run_id: string; dispatch_generation: number } | undefined {
  for (const runId of orderedTaskRunIds(state, taskId)) {
    const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
    if ((dispatch?.state === 'claimed' || dispatch?.state === 'started') && Number.isSafeInteger(dispatch.dispatch_generation)) return { run_id: runId, dispatch_generation: dispatch.dispatch_generation as number }
  }
}

function orderedQueuedInputs(state: AuthorityFile, taskId: string): DurableTurnInput[] {
  return Object.values(state.turn_input_queue)
    .map(value => value as DurableTurnInput)
    .filter(item => item.task_id === taskId && item.state === 'queued')
    .sort((left, right) => left.queue_sequence - right.queue_sequence)
}

function publicQueuedInput(item: DurableTurnInput): ProductTaskQueuedInput {
  return {
    id: item.queue_item_id,
    text: item.text,
    state: item.state,
    createdAt: item.created_at,
    attachmentCount: item.attachment_ids.length,
    ...(item.target_run_id ? { targetRunId: item.target_run_id } : {}),
  }
}

function taskRunQueueDepth(state: AuthorityFile, taskId: string): number {
  return orderedTaskRunIds(state, taskId).filter(runId => ['pending', 'claimed', 'started', 'recovery_required'].includes((state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state as string)).length + orderedQueuedInputs(state, taskId).length
}

export const agentCoreAdapter: AgentCoreAdapter = {
  async listSessions() { return [] },

  async createSession(input) {
    const sessionId = randomUUID()
    nativeCoreWorkDirs.set(sessionId, input.workDir)
    return { sessionId, workDir: input.workDir }
  },

  async renameSession() {},

  async branchSession(sessionId, title) {
    const next = randomUUID()
    const workDir = nativeCoreWorkDirs.get(sessionId) ?? process.cwd()
    nativeCoreWorkDirs.set(next, workDir)
    return { sessionId: next, workDir, title: title || '新任务' }
  },

  async getWorktreeLaunchState() { return 'not_requested' },
}

function productStorePath(): string {
  const configDir = process.env.BILLIARDBUDDY_CONFIG_DIR || path.join(os.homedir(), '.BilliardBuddy')
  return path.join(configDir, 'billiardbuddy', 'product-tasks.json')
}

function authorityStorePath(storagePath: string): string {
  return path.join(path.dirname(storagePath), 'product-task-authority.v1.json')
}

function resourceId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function createProductTaskId(): string {
  return `task_${randomUUID()}`
}

function createProductSideTaskId(): string {
  return `side_task_${randomUUID()}`
}

function createProductProjectId(): string {
  return `project_${randomUUID()}`
}

function createProductDirectoryId(): string {
  return `directory_${randomUUID()}`
}

function legacyProductProjectId(rootDir: string): string {
  return resourceId('project', rootDir)
}

function legacyProductDirectoryId(projectId: string, directoryPath: string): string {
  return resourceId('directory', `${projectId}\u0000${directoryPath}`)
}

function projectTitle(rootDir: string): string {
  const base = path.basename(rootDir.replace(/[\\/]+$/, ''))
  return base || rootDir || '未命名项目'
}

function directoryLabel(rootDir: string, directoryPath: string): string {
  const relative = path.relative(rootDir, directoryPath)
  if (!relative) return '项目根目录'
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative
  return path.basename(directoryPath) || directoryPath
}

function sameProductPath(left: string, right: string): boolean {
  return path.resolve(left).normalize('NFC') === path.resolve(right).normalize('NFC')
}

function isSameOrChildPath(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function isDesktopWorktreeDirectory(workDir: string, rootDir: string): boolean {
  if (!isSameOrChildPath(rootDir, workDir)) return false
  const marker = `${path.sep}.BilliardBuddy${path.sep}worktrees${path.sep}`
  return workDir.includes(marker)
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

const CORE_PERMISSION_MODE_BY_PRODUCT_MODE: Record<
  ProductTaskPermissionMode,
  'default' | 'bypassPermissions'
> = {
  ask_for_approval: 'default',
  approve_for_me: 'default',
  full_access: 'bypassPermissions',
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

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} 必须是布尔值`)
  return value
}

function continuationTarget(value: unknown): ProductContinuationTarget {
  if (value === undefined) return 'current_workspace'
  if (value === 'current_workspace' || value === 'new_worktree') return value
  throw ApiError.badRequest('target 必须是 current_workspace 或 new_worktree')
}

function requiredSourceEntryId(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('sourceEntryId 必须是字符串')
  const sourceEntryId = value.trim()
  if (!/^thread_[a-f0-9]{20}$/.test(sourceEntryId)) {
    throw ApiError.badRequest('sourceEntryId 格式不正确')
  }
  return sourceEntryId
}

function optionalSourceEntryId(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredSourceEntryId(value)
}

function rejectCoreSourceTurnId(input: object): void {
  if (Object.prototype.hasOwnProperty.call(input, 'sourceTurnId')) {
    throw ApiError.badRequest('产品接口不支持 sourceTurnId；请使用 sourceEntryId')
  }
}

function requestedProductResourceId(value: unknown, field: 'projectId' | 'directoryId'): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw ApiError.badRequest(`${field} 必须是非空字符串`)
  }
  return value.trim()
}

function defaultMetadata(session: AgentCoreSession): ProductTaskMetadata {
  return {
    id: legacyProductTaskId(session.id),
    coreSessionId: session.id,
    lifecycle: 'active',
    kind: 'main',
    createdAt: session.createdAt,
    updatedAt: session.modifiedAt,
    worktreeState: 'not_requested',
    visibility: 'main',
  }
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

function normalizeProductTaskStore(value: unknown): ProductTaskStore {
  if (!isRecord(value) || !isRecord(value.tasks)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  if (value.version === PRODUCT_TASK_STORE_VERSION || value.version === 3 || value.version === 2) {
    return normalizeModernTaskStore(value)
  }

  // Version 1 keyed metadata by Core session id and returned that id as the
  // product id. Convert it in memory to stable opaque identifiers. Project
  // and directory bindings are backfilled from the registered Core sessions
  // before the v4 store is written.
  if (value.version === LEGACY_PRODUCT_TASK_STORE_VERSION) {
    const tasks: Record<string, ProductTaskMetadata> = {}
    for (const [coreSessionId, rawMetadata] of Object.entries(value.tasks)) {
      const taskId = legacyProductTaskId(coreSessionId)
      const metadata = normalizeMetadata(rawMetadata, { id: taskId, coreSessionId })
      const raw = isRecord(rawMetadata) ? rawMetadata : {}
      const legacyParentTaskId = optionalString(raw.parentTaskId)
      const legacyParentThreadId = optionalString(raw.parentThreadId)
      const legacyParentReference = legacyParentTaskId ?? legacyParentThreadId
      tasks[taskId] = {
        ...metadata,
        ...(legacyParentReference ? { parentTaskId: legacyProductTaskId(legacyParentReference) } : {}),
      }
    }

    const sideTasks = normalizeLegacyV1SideTasks(value.sideTasks)
    for (const sideTask of Object.values(sideTasks)) {
      if (tasks[sideTask.taskId]) continue
      tasks[sideTask.taskId] = {
        id: sideTask.taskId,
        coreSessionId: sideTask.coreSessionId,
        title: sideTask.title,
        lifecycle: 'active',
        kind: 'continuation',
        parentTaskId: sideTask.parentTaskId,
        sourceTurnId: sideTask.sourceTurnId,
        createdAt: sideTask.createdAt,
        updatedAt: sideTask.updatedAt,
        worktreeState: 'not_requested',
        visibility: 'side_task',
      }
    }
    return {
      version: PRODUCT_TASK_STORE_VERSION,
      projects: {},
      directories: {},
      tasks,
      sideTasks,
    }
  }

  throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
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

function requireTaskAction(task: ProductTaskRecord, action: ProductTaskAction): void {
  if (task.actions.includes(action)) return
  throw ApiError.conflict('该任务当前不能执行此操作')
}

export class ProductTaskService {
  private static readonly storeLocks = new Map<string, Promise<void>>()
  private readonly storagePath: string
  private readonly authorityPath: string
  private readonly usesDefaultStoragePath: boolean
  private readonly core: AgentCoreAdapter
  private readonly workspaceFs: WorkspaceFilesystemPort
  private readonly workspaceBindBlockers: WorkspaceBindBlockerPort
  private readonly admissionBarrier: SessionAdmissionBarrier
  private readonly authorityRepositoryDeps: ProductTaskAuthorityRepositoryDeps
  private readonly lifecycleParticipants: readonly TaskLifecycleParticipant[]
  private readonly now: () => Date
  private readonly installationId: string
  private readonly dispatcher?: ProductTaskRunDispatcher
  private readonly autoMemoryEnabled: () => Promise<boolean>
  private taskRunQueueRecovery?: Promise<void>

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
    dispatcher?: ProductTaskRunDispatcher
    /** Product AutoMem preference seam owned by the BilliardBuddy task runtime. */
    autoMemoryEnabled?: () => Promise<boolean>
  } = {}) {
    this.usesDefaultStoragePath = !options.storagePath
    this.storagePath = options.storagePath ?? productStorePath()
    this.authorityPath = options.storagePath ? authorityStorePath(options.storagePath) : authorityStorePath(productStorePath())
    this.core = options.core ?? agentCoreAdapter
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
        id: 'legacy_product_session_memory',
        inspectBlockers: async () => [],
        purgeCleanup: async taskId => purgeLegacyProductSessionMemory(this.sessionMemoryStorageDir(), taskId),
      },
      {
        id: 'legacy_product_registry',
        inspectBlockers: async () => [],
        purgeCleanup: async taskId => this.purgeLegacyProductRegistry(taskId),
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
    this.autoMemoryEnabled = options.autoMemoryEnabled ?? (this.usesDefaultStoragePath
      ? async () => (await new ProductSettingsRepository().get()).productAutoMemoryEnabled !== false
      : async () => true)
  }

  /**
   * The registry is one JSON document. Serialize operations per storage path
   * so migration and read-modify-write actions cannot overwrite each other.
   */
  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.storagePath)
    const previous = ProductTaskService.storeLocks.get(key) ?? Promise.resolve()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => gate)
    ProductTaskService.storeLocks.set(key, queued)

    await previous
    try {
      return await operation()
    } finally {
      release?.()
      if (ProductTaskService.storeLocks.get(key) === queued) {
        ProductTaskService.storeLocks.delete(key)
      }
    }
  }

  async listTasks(): Promise<ProductTaskIndexResponse> {
    const legacy = await this.withStoreLock(() => this.listTasksUnlocked())
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const byId = new Map(legacy.tasks.map(task => [task.id, task]))
    const sideTaskIds = new Set(Object.values(authority.side_tasks).map(side => (side as { taskId?: unknown }).taskId).filter((id): id is string => typeof id === 'string'))
    for (const value of Object.values(authority.tasks)) {
      const task = authorityPublicTask(value)
      if (!task?.id || sideTaskIds.has(task.id) || (task as unknown as { kind?: unknown }).kind === 'side') continue
      if (task.lifecycle === 'deleted') {
        byId.delete(task.id)
        continue
      }
      const runtime = byId.get(task.id)
      const hasBlockingWork = hasBlockingTaskWork(authority, task.id)
      byId.set(task.id, runtime
        ? { ...task, workDir: runtime.workDir, worktreeState: runtime.worktreeState, updatedAt: runtime.updatedAt, actions: actionsFor(task, hasBlockingWork || !runtime.actions.includes('archive')) }
        : { ...task, actions: actionsFor(task, hasBlockingWork) })
    }
    const tasks = [...byId.values()]
    return { ...legacy, tasks, total: tasks.length }
  }

  async listTasksAuthoritatively(): Promise<ProductTaskIndexResponse> {
    const index = await this.listTasks()
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
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

  async listSideTasksAuthoritatively(taskId: string): Promise<ProductSideTask[]> { return this.listSideTasks(taskId) }

  /**
   * Materialize every supported v1-v4 task record through the existing domain
   * normalizer before the legacy reader is eligible for retirement.
   */
  async migrateSupportedStorage(): Promise<void> {
    const taskIds = await this.withStoreLock(async () => {
      const exists = await fs.access(this.storagePath).then(() => true, () => false)
      if (!exists) return []
      const { store } = await this.loadRegisteredStore()
      await this.writeStore(store)
      return Object.keys(store.tasks).sort()
    })
    for (const taskId of taskIds) {
      await this.ensureAuthorityProjectionForLegacyTask(taskId, { authorityPath: this.authorityPath })
    }
  }

  private async listTasksUnlocked(): Promise<ProductTaskIndexResponse> {
    const { store, sessions } = await this.loadRegisteredStore()
    const sideTaskSessionIds = new Set(
      Object.values(store.sideTasks).map((sideTask) => sideTask.coreSessionId),
    )
    const records: ProductTaskRecord[] = []
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    for (const metadata of Object.values(store.tasks)) {
      if (sideTaskSessionIds.has(metadata.coreSessionId) || metadata.visibility === 'side_task') continue
      const session = sessionsById.get(metadata.coreSessionId) ?? this.sessionFromProductBinding(store, metadata)
      if (!session) continue
      const record = await this.toRecord(session, metadata)
      records.push(record)
    }
    records.sort((left, right) => {
      if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    })

    const activePinnedProjectIds = new Set(
      records
        .filter((task) => task.lifecycle === 'active' && Boolean(task.pinnedAt))
        .map((task) => task.projectId),
    )
    const projects = new Map<string, ProductProject>()
    for (const task of records) {
      const registered = store.projects[task.projectId]
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
      directories: Object.values(store.directories)
        .filter((directory) => visibleProjectIds.has(directory.projectId))
        .sort((left, right) => left.projectId.localeCompare(right.projectId)
          || left.label.localeCompare(right.label) || left.path.localeCompare(right.path)),
      tasks: records,
      total: records.length,
      capabilities: { createTask: true },
    }
  }

  /**
   * Directory-picker projects are derived from the public product task index.
   * This deliberately excludes unregistered Agent Core sessions and never
   * exposes their private session bindings.
   */
  async listRecentProjects(limit = 10): Promise<ProductRecentProjectList> {
    const taskIndex = await this.listTasks()
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
    const coreBinding = binding as { coreSessionId?: unknown; branchWorkDir?: unknown }
    const parentLineageId = typeof source?.task?.current_lineage_id === 'string' ? source.task.current_lineage_id : undefined
    const childLineageId = `lineage_${createHash('sha256').update(`fork\0${input.client_operation_id}`).digest('hex').slice(0, 32)}`
    const now = this.now().toISOString()
    const executionDirectory = typeof coreBinding.branchWorkDir === 'string' ? coreBinding.branchWorkDir : source?.task?.workDir
    const childLineage = kind === 'continue' && parentLineageId && forkCheckpointId && executionDirectory
      ? { lineage_id: childLineageId, product_task_id: input.taskId, parent_lineage_id: parentLineageId, fork_checkpoint_id: forkCheckpointId, revision: 0, compact_generation: 0, resume_binding_id: `resume_${randomUUID()}`, execution_directory: executionDirectory, state: 'active', created_at: now, updated_at: now }
      : undefined
    const finalBinding = sideTask
      ? { id: input.taskId, kind, binding }
      : source?.task
        ? { ...source, binding: { ...source.binding, ...(typeof coreBinding.coreSessionId === 'string' ? { coreSessionId: coreBinding.coreSessionId } : {}) }, task: { ...source.task, revision: (source.task.revision ?? 0) + 1, ...(childLineage ? { current_lineage_id: childLineageId, workDir: executionDirectory, worktreeState: 'materialized', updatedAt: now } : {}) } }
        : { id: input.taskId, kind, binding }
    const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, ...(sideTask ? { result: sideTask } : {}) }, finalBinding, { ...(sideTask ? { sideTask } : {}), ...(childLineage ? { lineage: { id: childLineageId, value: childLineage } } : {}) })
    return { outcome: 'accepted', revision: final.revision }
  }

  /** Authority-backed create. The legacy registry is deliberately read-only. */
  async createTaskAuthoritatively(input: CreateProductTaskInput, options: {
    authorityPath: string
    bridge: Pick<ProductCoreOperationBridge, 'ensureCreate'>
    afterEnsure?: () => void | Promise<void>
  }): Promise<{ task: ProductTaskRecord; receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number } }> {
    if (!isRecord(input) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision! < 0 || typeof input.client_operation_id !== 'string' || !input.client_operation_id.trim()) throw ApiError.badRequest('expected_revision 和 client_operation_id 必填')
    if (typeof input.workDir !== 'string' || !input.workDir.trim()) throw ApiError.badRequest('workDir 必须是非空字符串')
    const title = validTitle(input.title) ?? ''
    const operationId = input.client_operation_id
    const taskId = `task_${createHash('sha256').update(operationId).digest('hex').slice(0, 16)}`
    const permissionSnapshot = productPermissionSnapshot(productTaskPermissionMode(input.permissionMode))
    const canonical = JSON.stringify({ workDir: input.workDir, title, permissionMode: permissionSnapshot.mode, useWorktree: input.useWorktree === true })
    const expectedRevision = input.expected_revision as number
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    try {
      const reserved = await authority.reserve({ client_operation_id: operationId, product_task_id: taskId, kind: 'create', canonical_input: canonical, expected_revision: expectedRevision })
      const receipt = reserved.file.receipts[operationId]
      if (receipt) return { task: authorityPublicTask(reserved.file.tasks[taskId]), receipt: { outcome: 'duplicate', revision: receipt.revision } }
      const task = { id: taskId, projectId: '', directoryId: '', workDir: input.workDir, title, lifecycle: 'active' as const, kind: 'main' as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), worktreeState: input.useWorktree ? 'planned' as const : 'not_requested' as const, permission_snapshot: permissionSnapshot, actions: ['pin', 'rename', 'continue', 'archive'] as ProductTaskAction[] }
      let binding: unknown
      try {
        binding = await options.bridge.ensureCreate(operationId, taskId, canonical)
      } catch (error) {
        if (!(error instanceof ProductCoreOperationTerminalError)) throw error
        const final = await authority.finalize(operationId, { client_operation_id: operationId, expected_revision: expectedRevision, outcome: 'rejected', revision: reserved.file.revision, error: 'OPERATION_REJECTED' })
        return { task, receipt: { outcome: 'rejected', revision: final.revision } }
      }
      await options.afterEnsure?.()
      const workDir = typeof (binding as { branchWorkDir?: unknown }).branchWorkDir === 'string'
        ? (binding as { branchWorkDir: string }).branchWorkDir
        : task.workDir
      const materializedTask = { ...task, workDir, worktreeState: input.useWorktree ? 'materialized' as const : task.worktreeState }
      const final = await authority.finalize(operationId, { client_operation_id: operationId, expected_revision: expectedRevision, outcome: 'accepted', revision: reserved.file.revision, result: materializedTask }, { task: materializedTask, binding })
      return { task: materializedTask, receipt: { outcome: 'accepted', revision: final.revision } }
    } catch (error) {
      if ((error as Error).message === 'AUTHORITY_CONFLICT') return { task: authorityPublicTask((await authority.read()).tasks[taskId]), receipt: { outcome: 'conflict', revision: (await authority.read()).revision } }
      throw error
    }
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
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
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
        const scope = state.task_scopes[taskId] as { kind?: unknown } | undefined
        const execution_capability = scope?.kind === 'workspace' ? 'workspace_bound' : 'installation_default_denied'
        const workspace = scope?.kind === 'workspace' && typeof (scope as { workspace_id?: unknown }).workspace_id === 'string' ? state.workspaces[(scope as { workspace_id: string }).workspace_id] as { canonical_root?: unknown } | undefined : undefined
        const workDir = typeof lineage.execution_directory === 'string' ? lineage.execution_directory : typeof workspace?.canonical_root === 'string' ? workspace.canonical_root : path.dirname(this.storagePath)
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
      if ('queue_item_id' in snapshot) this.steerAcceptedQueuedInput(snapshot.queue_item_id)
      else this.dispatchAcceptedRun(snapshot.run_id, snapshot.dispatch_generation)
      return response
    } catch (error) {
      const file = await authority.read()
      return { client_operation_id: input.client_operation_id, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected', authority_revision: file.revision, entity_revisions: {}, error: (error as Error).message }
    }
  }

  async recoverTaskRun(taskId: string, input: { expected_revision: number; client_operation_id: string }): Promise<{
    task: ProductTaskRecord
    receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number }
    snapshot: { revision: number; event_sequence: number; tasks: ProductTaskRecord[]; side_tasks: ProductSideTask[] }
  }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonical = JSON.stringify({ task_id: taskId, expected_revision: input.expected_revision })
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
        const runId = recoveryRequiredTaskRunId(state, taskId)
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
    const canonical = JSON.stringify({ draft_id: input.draft_id, expected_draft_revision: input.expected_draft_revision, client_operation_id: input.client_operation_id, text: input.text, attachment_ids: input.attachment_ids, permission_mode: input.permission_mode })
    try { const { file, result } = await authority.transactSubmit(state => {
      const prior = state.receipts[input.client_operation_id]
      if (prior) { if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT'); return { changed: false as const, value: { duplicate: true, receipt: prior } } }
      if (!input.text || !Array.isArray(input.attachment_ids) || input.attachment_ids.length > 4 || new Set(input.attachment_ids).size !== input.attachment_ids.length) throw new Error('AUTHORITY_INVALID')
      const permissionSnapshot = productPermissionSnapshot(productTaskPermissionMode(input.permission_mode))
      const draft = state.composer_drafts[input.draft_id] as Record<string, unknown> | undefined
      if (!draft || draft.installation_id !== this.installationId || draft.target_state !== 'pending_task' || draft.state !== 'active' || draft.revision !== input.expected_draft_revision || Date.parse(draft.expires_at as string) <= this.now().getTime()) throw new Error('DRAFT_REJECTED')
      const taskId = draft.target_task_id as string; if (state.tasks[taskId]) throw new Error('AUTHORITY_CONFLICT')
      const attachments = input.attachment_ids.map(id => { const a = state.task_attachments[id] as Record<string, unknown> | undefined; if (!a || a.installation_id !== this.installationId || a.owner_kind !== 'composer_draft' || a.owner_id !== input.draft_id || a.state !== 'ready' || Date.parse(a.expires_at as string) <= this.now().getTime()) throw new Error('ATTACHMENT_REJECTED'); return [id, a] as const })
      if (attachments.reduce((total, [, attachment]) => total + (attachment.byte_size as number), 0) > MAX_TASK_ATTACHMENT_TOTAL_BYTES) throw new Error('ATTACHMENT_REJECTED')
      const now = this.now().toISOString(), lineageId = `lineage_${randomUUID()}`, runId = `run_${randomUUID()}`, entryId = `entry_${randomUUID()}`
      const task = { id: taskId, projectId: '', directoryId: '', workDir: '', title: input.text.slice(0, 120), lifecycle: 'active' as const, kind: 'main' as const, createdAt: now, updatedAt: now, worktreeState: 'not_requested' as const, permission_snapshot: permissionSnapshot, actions: ['pin', 'unpin', 'rename', 'continue', 'archive', 'restore'], revision: 1, task_scope: 'installation-default', current_lineage_id: lineageId }
      const resumeBindingId = `resume_${randomUUID()}`; state.tasks[taskId] = { task, binding: { coreSessionId: 'unbound' } }; state.task_scopes[taskId] = { kind: 'installation-default' }; state.conversation_lineages[lineageId] = { lineage_id: lineageId, product_task_id: taskId, revision: 1, compact_generation: 0, resume_binding_id: resumeBindingId, state: 'active', created_at: now, updated_at: now, head_entry_id: entryId }
      state.thread_entries[entryId] = { entry_id: entryId, task_id: taskId, run_id: runId, text: input.text, created_at: now }; state.task_runs[runId] = { run_id: runId, task_id: taskId, lineage_id: lineageId, entry_id: entryId, created_at: now, execution_capability: 'installation_default_denied', permission_mode: permissionSnapshot.mode, permission_snapshot: permissionSnapshot, provider: null, model: null, event_contract: 'durable_items_v1', core_binding: { resume_binding_id: resumeBindingId, session_id: randomUUID(), work_dir: path.dirname(this.storagePath), dispatch_generation: 1, context_event_sequence: state.event_sequence } }; state.dispatch_records[runId] = { run_id: runId, dispatch_generation: 1, state: 'pending' }; state.event_sequence += 1; state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: runId, type: 'user_text', entry_id: entryId, item_id: durableUserItemId(runId), text: input.text, attachment_ids: input.attachment_ids, created_at: now }
      for (const [id, a] of attachments) { state.task_attachments[id] = { ...a, owner_kind: 'product_task', owner_id: taskId, state: 'accepted_bound', refs: [...a.refs as string[], taskId], revision: (a.revision as number) + 1, last_activity: now }; state.attachment_bindings[id] = { attachment_id: id, task_id: taskId, run_id: runId, entry_id: entryId } }
      state.composer_drafts[input.draft_id] = { ...draft, state: 'consumed', revision: (draft.revision as number) + 1, last_activity: now }; const entity_revisions: Record<string, number> = { task: 1, lineage: 1, draft: (state.composer_drafts[input.draft_id] as { revision: number }).revision }; for (const id of input.attachment_ids) entity_revisions[id] = (state.task_attachments[id] as { revision: number }).revision; const receipt = { client_operation_id: input.client_operation_id, expected_revision: input.expected_draft_revision, outcome: 'accepted' as const, revision: state.revision + 1, result: { task_id: taskId, run_id: runId, entry_id: entryId, dispatch_generation: 1, authority_revision: state.revision + 1, entity_revisions } }; state.receipts[input.client_operation_id] = receipt; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'task_create_submit', revision: state.revision + 1, canonical_input: canonical, entity_id: taskId, product_task_id: taskId }; return { duplicate: false, receipt }
    }); const receipt = result.receipt; const snapshot = receipt.result as { task_id: string; run_id: string; entry_id: string; dispatch_generation: number; authority_revision: number; entity_revisions: Record<string, number> }; const response: SubmitTaskRunReceipt = { client_operation_id: input.client_operation_id, outcome: result.duplicate ? 'duplicate' : 'accepted', authority_revision: snapshot.authority_revision, entity_revisions: snapshot.entity_revisions, result: { task_id: snapshot.task_id, run_id: snapshot.run_id, entry_id: snapshot.entry_id, dispatch_generation: snapshot.dispatch_generation } }; this.dispatchAcceptedRun(snapshot.run_id, snapshot.dispatch_generation); return response } catch (error) { const file = await authority.read(); return { client_operation_id: input.client_operation_id, outcome: (error as Error).message === 'AUTHORITY_CONFLICT' ? 'conflict' : 'rejected', authority_revision: file.revision, entity_revisions: {}, error: (error as Error).message } }
  }

  /** Durable receipt first, then best-effort server dispatch; never an API-side fake response. */
  private dispatchAcceptedRun(runId: string, generation: number, kind: 'interactive' | 'scheduled' = 'interactive'): void {
    // Isolated authority fixtures intentionally own the dispatch claim in
    // their assertions. The live server (default path) and any explicit
    // server dispatcher are the only automatic consumers.
    if (!this.usesDefaultStoragePath && !this.dispatcher) return
    void (async () => {
      const dispatcher: ProductTaskRunDispatcher = this.dispatcher ?? await import('./taskRunDispatchBridge.js').then(module => module.dispatcherFor(this))
      await dispatcher.dispatch(runId, generation, kind)
    })().catch(() => undefined)
  }

  private steerAcceptedQueuedInput(queueItemId: string): void {
    if (!this.usesDefaultStoragePath && !this.dispatcher) return
    void (async () => {
      const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
      const item = state.turn_input_queue[queueItemId] as DurableTurnInput | undefined
      if (!item || item.state !== 'queued' || item.attachment_ids.length > 0) return
      const active = activeTaskRun(state, item.task_id)
      if (!active) return
      const dispatcher: ProductTaskRunDispatcher = this.dispatcher ?? await import('./taskRunDispatchBridge.js').then(module => module.dispatcherFor(this))
      await dispatcher.steer?.(active.run_id, active.dispatch_generation, item.queue_item_id, item.text)
    })().catch(() => undefined)
  }

  async listQueuedInputs(taskId: string): Promise<{ items: ProductTaskQueuedInput[] }> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    if (!state.tasks[taskId]) throw ApiError.notFound('任务不存在')
    return { items: Object.values(state.turn_input_queue).map(value => value as DurableTurnInput).filter(item => item.task_id === taskId && (item.state === 'queued' || item.state === 'failed')).sort((left, right) => left.queue_sequence - right.queue_sequence).map(publicQueuedInput) }
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

  async recordQueuedInputConsumed(runId: string, dispatchGeneration: number, queueItemId: string): Promise<{ task_id: string; events: ProductTaskEvent[] }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^queue_[a-f0-9-]{36}$/.test(queueItemId)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; lineage_id?: unknown; event_contract?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as DurableTaskRunDispatch | undefined
      const item = state.turn_input_queue[queueItemId] as DurableTurnInput | undefined
      if (!run || typeof run.task_id !== 'string' || typeof run.lineage_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string) || !item || item.task_id !== run.task_id || item.lineage_id !== run.lineage_id || item.attachment_ids.length > 0) throw new Error('AUTHORITY_INVALID')
      if (item.state === 'injected' && item.target_run_id === runId && item.dispatch_generation === dispatchGeneration) {
        const existing = Object.values(state.task_events).map(value => value as TaskEvent).find(event => event.type === 'queue_updated' && event.queue_item_id === queueItemId && event.phase === 'injected')
        if (!existing) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id, item, queue_sequence: existing.event_sequence, user_sequence: Object.values(state.task_events).map(value => value as TaskEvent).find(event => event.type === 'user_text' && event.entry_id === item.entry_id)?.event_sequence } }
      }
      if (item.state !== 'queued' || orderedQueuedInputs(state, item.task_id)[0]?.queue_item_id !== queueItemId) throw new Error('AUTHORITY_INVALID')
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
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const candidates = orderedTaskRunIds(state, taskId).filter(runId => ['pending', 'claimed', 'started'].includes((state.dispatch_records[runId] as DurableTaskRunDispatch | undefined)?.state as string))
    const runId = candidates.find(id => ['claimed', 'started'].includes((state.dispatch_records[id] as DurableTaskRunDispatch).state as string)) ?? candidates[0]
    if (!runId) return false
    const dispatch = state.dispatch_records[runId] as { dispatch_generation: number }
    const supervisor: ProductTaskRunDispatcher = this.dispatcher ?? await import('./taskRunDispatchBridge.js').then(module => module.dispatcherFor(this))
    if (!supervisor.stop) return false
    await supervisor.stop(runId, dispatch.dispatch_generation)
    return true
  }

  /** Freeze the exact extension/tool surface used by one Turn before sampling. */
  async recordTaskRunExtensionSnapshot(
    runId: string,
    dispatchGeneration: number,
    snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number },
  ): Promise<void> {
    if (
      !runId
      || !Number.isSafeInteger(dispatchGeneration)
      || dispatchGeneration < 1
      || !/^[a-f0-9]{64}$/.test(snapshot.digest)
      || [snapshot.tool_count, snapshot.command_count, snapshot.mcp_server_count].some(count => !Number.isSafeInteger(count) || count < 0 || count > 10_000)
    ) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { extension_snapshot?: typeof snapshot } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown } | undefined
      if (!run || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
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
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'activity' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^activity_[a-f0-9]{32}$/.test(activity.id)) throw new Error('AUTHORITY_INVALID')
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
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
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

  /** Persist compact lifecycle before the renderer can observe it; summaries remain server-private. */
  async recordTaskRunContextCompaction(
    runId: string,
    dispatchGeneration: number,
    compaction: Extract<AgentWorkerOutbound, { type: 'event'; event: 'context_compaction' }>,
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'context_compaction' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !Number.isSafeInteger(compaction.generation) || compaction.generation < 1 || !Number.isSafeInteger(compaction.input_tokens) || compaction.input_tokens < 1) throw new Error('AUTHORITY_INVALID')
    if (compaction.phase === 'completed' && (!compaction.summary.trim() || compaction.summary.length > 40_000 || !Number.isSafeInteger(compaction.output_tokens) || compaction.output_tokens < 1 || !Number.isSafeInteger(compaction.compacted_through_event_sequence) || compaction.compacted_through_event_sequence < 0)) throw new Error('AUTHORITY_INVALID')
    const itemId = durableContextCompactionItemId(runId, dispatchGeneration, compaction.generation)
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as Record<string, unknown> | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || typeof run.lineage_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
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
  ): Promise<{ task_id: string }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !['completed', 'stopped', 'recovery_required'].includes(terminalState) || assistantText.length > MAX_DURABLE_ASSISTANT_TEXT_LENGTH) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; event_contract?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; completed_at?: unknown; error?: unknown } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      const events = Object.values(state.task_events).map(value => value as TaskEvent)
      const priorTerminal = events.find((event): event is Extract<TaskEvent, { type: 'run_terminal' }> => event.type === 'run_terminal' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)
      const priorAssistant = events.find((event): event is Extract<TaskEvent, { type: 'assistant_text' }> => event.type === 'assistant_text' && event.run_id === runId && event.dispatch_generation === dispatchGeneration)
      if (priorTerminal) {
        const expectedDispatchState = terminalState === 'recovery_required' ? 'recovery_required' : 'terminal'
        if (priorTerminal.state !== terminalState || (priorAssistant?.text ?? '') !== assistantText || dispatch.state !== expectedDispatchState) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { task_id: run.task_id as string } }
      }
      if (!['pending', 'claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
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
      dispatch.error = terminalState === 'completed' ? 'TERMINAL' : terminalState === 'stopped' ? 'STOPPED' : 'CORE_RECOVERY_REQUIRED'
      return { task_id: run.task_id }
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
  ): Promise<{ task_id: string; reviewer: 'user' | 'automatic'; event: Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'action' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestId)) throw new Error('AUTHORITY_INVALID')
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; permission_snapshot?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; approvals?: DurableTaskRunApproval[] } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
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
  ): Promise<{ task_id: string; event: Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'question' }> }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1 || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestId) || questions.length < 1 || questions.length > 8 || JSON.stringify(questions).length > 32_000) throw new Error('AUTHORITY_INVALID')
    const action: ProductTaskActionApproval = { what: '回答任务中的澄清问题', scope: '当前任务回合', consequence: '回答会作为本回合的后续输入交给 Agent。' }
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; approvals?: DurableTaskRunApproval[] } | undefined
      if (!run || typeof run.task_id !== 'string' || dispatch?.dispatch_generation !== dispatchGeneration || !['claimed', 'started'].includes(dispatch.state as string)) throw new Error('AUTHORITY_INVALID')
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
      const dispatch = value as { state?: unknown; approvals?: DurableTaskRunApproval[] }
      if (run?.task_id !== taskId || !['claimed', 'started'].includes(dispatch.state as string)) continue
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
        const dispatch = value as { dispatch_generation?: unknown; state?: unknown; approvals?: DurableTaskRunApproval[] }
        if (run?.task_id !== taskId || !Number.isSafeInteger(dispatch.dispatch_generation)) continue
        const approval = dispatch.approvals?.find(candidate => candidate.request_id === requestId && candidate.questions)
        if (!approval) continue
        if (approval.questions!.length !== answers.length) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
        if (approval.status === 'resolved') return { changed: false as const, value: { handled: JSON.stringify(approval.answers) === JSON.stringify(answers), duplicate: true, run_id: runId, generation: dispatch.dispatch_generation as number } }
        if (!['claimed', 'started'].includes(dispatch.state as string)) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
        const now = this.now().toISOString()
        approval.status = 'resolved'; approval.decision = 'allowed'; approval.reviewer = 'user'; approval.resolution_reason = 'user_decision'; approval.resolved_at = now; approval.answers = [...answers]
        state.event_sequence += 1
        state.task_events[String(state.event_sequence)] = { event_sequence: state.event_sequence, task_id: taskId, run_id: runId, type: 'approval', dispatch_generation: dispatch.dispatch_generation as number, item_id: durableApprovalItemId(runId, dispatch.dispatch_generation as number, requestId), request_id: requestId, phase: 'resolved', action: { ...approval.action }, decision: 'allowed', reviewer: 'user', created_at: now }
        return { handled: true, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number }
      }
      return { changed: false as const, value: { handled: false, duplicate: false, run_id: '', generation: 0 } }
    })
    if (!result.handled || result.duplicate) return result.handled
    const supervisor: ProductTaskRunDispatcher = this.dispatcher ?? await import('./taskRunDispatchBridge.js').then(module => module.dispatcherFor(this))
    const delivered = Boolean(supervisor.answer && await supervisor.answer(result.run_id, result.generation, requestId, answers))
    if (delivered) {
      productTaskWorkerRuntimeEvents.publish(taskId, { type: 'status', state: 'working' })
      return true
    }
    await this.settleTaskRunDispatch(result.run_id, result.generation, 'recovery_required', 'QUESTION_DELIVERY_UNAVAILABLE')
    productTaskWorkerRuntimeEvents.publish(taskId, { type: 'error', code: 'task_unavailable', retryable: false })
    return true
  }

  /** Durable decision first, then one fenced response to the matching worker. */
  async resolveTaskRunApproval(
    taskId: string,
    requestId: string,
    allowed: boolean,
    reviewer: 'user' | 'automatic',
    resolutionReason: DurableTaskRunApproval['resolution_reason'] = reviewer === 'user' ? 'user_decision' : 'unknown_capability',
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(requestId)) return false
    if ((reviewer === 'user') !== (resolutionReason === 'user_decision')) return false
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      for (const [runId, value] of Object.entries(state.dispatch_records)) {
        const run = state.task_runs[runId] as { task_id?: unknown; permission_snapshot?: unknown } | undefined
        const dispatch = value as { dispatch_generation?: unknown; state?: unknown; approvals?: DurableTaskRunApproval[] }
        if (run?.task_id !== taskId || !Number.isSafeInteger(dispatch.dispatch_generation)) continue
        const approval = dispatch.approvals?.find(candidate => candidate.request_id === requestId)
        if (!approval) continue
        if (approval.questions) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
        if (approval.status === 'resolved') return { changed: false as const, value: { handled: approval.decision === (allowed ? 'allowed' : 'denied'), duplicate: true, run_id: runId, generation: dispatch.dispatch_generation as number } }
        const snapshot = taskPermissionSnapshot(run.permission_snapshot)
        if (snapshot.reviewer !== reviewer || !['claimed', 'started'].includes(dispatch.state as string)) return { changed: false as const, value: { handled: false, duplicate: false, run_id: runId, generation: dispatch.dispatch_generation as number } }
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
    const supervisor: ProductTaskRunDispatcher = this.dispatcher ?? await import('./taskRunDispatchBridge.js').then(module => module.dispatcherFor(this))
    const delivered = Boolean(supervisor.approve && await supervisor.approve(result.run_id, result.generation, requestId, allowed))
    if (delivered) {
      productTaskWorkerRuntimeEvents.publish(taskId, { type: 'status', state: 'working' })
      return true
    }
    await this.settleTaskRunDispatch(result.run_id, result.generation, 'recovery_required', 'APPROVAL_DELIVERY_UNAVAILABLE')
    productTaskWorkerRuntimeEvents.publish(taskId, { type: 'error', code: 'task_unavailable', retryable: false })
    return true
  }

  async respondToTaskApproval(taskId: string, requestId: string, allowed: boolean): Promise<boolean> {
    return this.resolveTaskRunApproval(taskId, requestId, allowed, 'user')
  }

  /** Server-private scheduler state never crosses a product API boundary. */
  workerSchedulerStatePath(): string { return path.join(path.dirname(this.storagePath), 'product-agent-worker-scheduler.json') }

  /** Private BB-05B state lives beside, not inside, ProductTask authority. */
  private sessionMemoryStorageDir(): string { return path.join(path.dirname(this.storagePath), 'product-session-memory') }

  /** Private BB-05C project memory; never aliases legacy ~/.BilliardBuddy memory. */
  private autoMemoryStorageDir(): string { return path.join(path.dirname(this.storagePath), 'product-auto-memory') }

  private harnessSessionStorageDir(): string { return path.join(path.dirname(this.storagePath), 'product-harness-sessions') }

  private async purgeTaskPrivateArtifacts(taskId: string): Promise<void> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const lineages = Object.values(state.conversation_lineages)
      .filter(value => (value as { product_task_id?: unknown }).product_task_id === taskId)
      .flatMap(value => {
        const lineage = value as { lineage_id?: unknown; resume_binding_id?: unknown }
        return typeof lineage.lineage_id === 'string' && typeof lineage.resume_binding_id === 'string'
          ? [{ storage_dir: this.harnessSessionStorageDir(), binding_id: lineage.resume_binding_id, lineage_id: lineage.lineage_id }]
          : []
      })
    const entryIds = Object.values(state.thread_entries)
      .filter(value => (value as { task_id?: unknown }).task_id === taskId)
      .flatMap(value => typeof (value as { entry_id?: unknown }).entry_id === 'string' ? [(value as { entry_id: string }).entry_id] : [])
    const draftIds = new Set(Object.values(state.composer_drafts)
      .filter(value => (value as { target_task_id?: unknown }).target_task_id === taskId)
      .flatMap(value => typeof (value as { draft_id?: unknown }).draft_id === 'string' ? [(value as { draft_id: string }).draft_id] : []))
    const attachmentIds = Object.entries(state.task_attachments)
      .filter(([, value]) => {
        const attachment = value as { owner_kind?: unknown; owner_id?: unknown }
        return (attachment.owner_kind === 'product_task' && attachment.owner_id === taskId)
          || (attachment.owner_kind === 'composer_draft' && typeof attachment.owner_id === 'string' && draftIds.has(attachment.owner_id))
      })
      .map(([attachmentId]) => attachmentId)
    const harnessSessions = new ProductHarnessSessionRepository()
    await Promise.all([
      ...lineages.map(binding => harnessSessions.purge(binding)),
      new ProductAutoMemoryRepository().purgeTaskTurns(this.autoMemoryStorageDir(), taskId, entryIds),
      purgeProductAttachmentCopies(productAttachmentStorageRoot(this.storagePath), attachmentIds),
    ])
  }

  private async purgeLegacyProductRegistry(taskId: string): Promise<void> {
    await this.withStoreLock(async () => {
      const store = await this.readStore()
      delete store.tasks[taskId]
      for (const [sideId, sideTask] of Object.entries(store.sideTasks)) {
        if (sideTask.parentTaskId === taskId || sideTask.taskId === taskId) delete store.sideTasks[sideId]
      }
      await this.writeStore(store)
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
    if (!['pending', 'claimed', 'started'].includes(dispatch.state as string)) return false
    const supervisor: ProductTaskRunDispatcher = this.dispatcher ?? await import('./taskRunDispatchBridge.js').then(module => module.dispatcherFor(this))
    if (!supervisor.stop) return false
    await supervisor.stop(runId, dispatchGeneration)
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
    if (dispatch.state === 'recovery_required') {
      return { state: 'failed', ...(typeof dispatch.completed_at === 'string' ? { completed_at: dispatch.completed_at } : {}) }
    }
    return { state: 'running' }
  }

  /**
   * Read the durable BB-02C user-event ledger.  The operation audit map is
   * intentionally not visible here: reconnect cursors are keyed only by the
   * permanent task-event sequence.
   */
  async listTaskEvents(taskId: string, afterEventSequence = 0, limit = 200): Promise<{ events: Array<TaskEvent & { attachments?: ProductTaskAttachmentSummary[] }>; cursor: number; has_more?: true }> {
    if (!Number.isSafeInteger(afterEventSequence) || afterEventSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw ApiError.badRequest('事件游标无效')
    }
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const state = await authority.read()
    if (!state.tasks[taskId]) throw ApiError.notFound('任务不存在')
    const matchingEvents = Object.values(state.task_events)
      .map((event) => event as TaskEvent)
      .filter((event) => event.task_id === taskId && event.event_sequence > afterEventSequence)
      .sort((left, right) => left.event_sequence - right.event_sequence)
    const durableEvents = matchingEvents.slice(0, limit)
    const hasMore = matchingEvents.length > durableEvents.length
    const events = await Promise.all(durableEvents.map(async event => {
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
      const safeAttachments = attachments.filter((attachment): attachment is ProductTaskAttachmentSummary => attachment !== null)
      return { ...event, item_id: event.item_id ?? durableUserItemId(event.run_id), attachment_ids: [...event.attachment_ids], ...(safeAttachments.length ? { attachments: safeAttachments } : {}) }
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
    return nextTaskRunId(state, run.task_id) === runId ? 'ready' : 'queued'
  }

  async claimTaskRunDispatch(runId: string, dispatchGeneration: number): Promise<{ outcome: 'claimed' | 'duplicate' | 'queued' | 'recovery_required'; task_id: string }> {
    if (!runId || !Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 1) {
      throw ApiError.badRequest('运行派发参数无效')
    }
    const binding = productTextReasoningBinding()
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result } = await authority.transactSubmit((state) => {
      const run = state.task_runs[runId] as { task_id?: unknown; provider?: unknown; model?: unknown } | undefined
      const dispatch = state.dispatch_records[runId] as {
        dispatch_generation?: unknown
        state?: unknown
        claimed_at?: unknown
      } | undefined
      if (!run || typeof run.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) {
        throw new Error('AUTHORITY_INVALID')
      }
      if (dispatch.state === 'pending') {
        if (nextTaskRunId(state, run.task_id) !== runId) return { changed: false as const, value: { outcome: 'queued' as const, task_id: run.task_id } }
        run.provider = binding.provider
        run.model = binding.model
        dispatch.state = 'claimed'
        dispatch.claimed_at = this.now().toISOString()
        return { outcome: 'claimed' as const, task_id: run.task_id }
      }
      if (dispatch.state === 'claimed' || dispatch.state === 'started') {
        if (run.provider !== binding.provider || run.model !== binding.model) throw new Error('AUTHORITY_INVALID')
        return { changed: false as const, value: { outcome: 'duplicate' as const, task_id: run.task_id } }
      }
      return { changed: false as const, value: { outcome: 'recovery_required' as const, task_id: run.task_id } }
    })
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
      const executionCapability = scope?.kind === 'workspace' ? 'workspace_bound' : 'installation_default_denied'
      const workspace = scope?.kind === 'workspace' && typeof scope.workspace_id === 'string' ? state.workspaces[scope.workspace_id] as { canonical_root?: unknown } | undefined : undefined
      const workDir = typeof lineage.execution_directory === 'string' ? lineage.execution_directory : typeof workspace?.canonical_root === 'string' ? workspace.canonical_root : path.dirname(this.storagePath)
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
  recoverDurableTaskRunQueue(): Promise<void> {
    this.taskRunQueueRecovery ??= this.performTaskRunQueueRecovery()
    return this.taskRunQueueRecovery
  }

  private async performTaskRunQueueRecovery(): Promise<void> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result: recovery } = await authority.transactSubmit((state) => {
      let changed = false
      const now = this.now().toISOString()
      for (const value of Object.values(state.dispatch_records)) {
        const dispatch = value as DurableTaskRunDispatch
        if (dispatch.state !== 'claimed' && dispatch.state !== 'started') continue
        dispatch.state = 'recovery_required'
        dispatch.completed_at = now
        dispatch.error = 'SERVER_RESTARTED'
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
    for (const taskId of recovery.promotable) {
      const promoted = await this.promoteNextQueuedInput(taskId)
      if (promoted) recovery.pending.push(promoted.run_id)
    }
    for (const runId of [...new Set(recovery.pending)]) {
      const state = await authority.read()
      const dispatch = state.dispatch_records[runId] as { dispatch_generation?: unknown } | undefined
      if (Number.isSafeInteger(dispatch?.dispatch_generation)) this.dispatchAcceptedRun(runId, dispatch!.dispatch_generation as number)
    }
  }

  /** Server-private BB-03D/BB-05B lookup; it reads the durable hand-off only. */
  async readTaskRunDispatchIdentity(runId: string, dispatchGeneration: number): Promise<{
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
    session_context: DurableSessionContext
    harness_session: {
      storage_dir: string
      binding_id: string
      lineage_id: string
    }
  }> {
    const state = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = state.task_runs[runId] as { task_id?: unknown; lineage_id?: unknown; entry_id?: unknown; permission_snapshot?: unknown } | undefined
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
      auto_memory: { storage_dir: this.autoMemoryStorageDir(), enabled: await this.autoMemoryEnabled(), entry_id: run.entry_id },
      session_context: sessionContext,
      harness_session: { storage_dir: this.harnessSessionStorageDir(), binding_id: resumeBindingId, lineage_id: run.lineage_id },
    }
  }

  /** The only server-private resolver for a run's durable Core launch target. */
  async resolveTaskRunCoreBinding(runId: string, dispatchGeneration: number): Promise<{ session_id: string; work_dir: string }> {
    const file = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const run = file.task_runs[runId] as { lineage_id?: unknown; core_binding?: { resume_binding_id?: unknown; session_id?: unknown; work_dir?: unknown; dispatch_generation?: unknown } } | undefined
    const binding = run?.core_binding
    if (!binding || binding.dispatch_generation !== dispatchGeneration || typeof binding.resume_binding_id !== 'string' || typeof binding.session_id !== 'string' || typeof binding.work_dir !== 'string' || !binding.work_dir) throw new Error('CORE_BINDING_UNAVAILABLE')
    const lineage = typeof run.lineage_id === 'string' ? file.conversation_lineages[run.lineage_id] as { resume_binding_id?: unknown } | undefined : undefined
    if (binding.resume_binding_id !== lineage?.resume_binding_id) throw new Error('CORE_BINDING_UNAVAILABLE')
    const workDir = await fs.realpath(binding.work_dir).catch(() => undefined); if (!workDir || !await fs.stat(workDir).then(stat => stat.isDirectory()).catch(() => false)) throw new Error('CORE_BINDING_UNAVAILABLE')
    return { session_id: binding.session_id, work_dir: workDir }
  }

  /** BB-03DR terminal/recovery marker; it cannot create or replay a user turn. */
  async settleTaskRunDispatch(runId: string, dispatchGeneration: number, state: 'recovery_required' | 'terminal', error?: string): Promise<void> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const { result: taskId } = await authority.transactSubmit((file) => {
      const run = file.task_runs[runId] as { task_id?: unknown; event_contract?: unknown } | undefined
      const dispatch = file.dispatch_records[runId] as { dispatch_generation?: unknown; state?: unknown; completed_at?: unknown; error?: unknown } | undefined
      if (typeof run?.task_id !== 'string' || !dispatch || dispatch.dispatch_generation !== dispatchGeneration) throw new Error('AUTHORITY_INVALID')
      if (dispatch.state === 'terminal' || dispatch.state === 'recovery_required') return { changed: false as const, value: undefined }
      const now = this.now().toISOString()
      if (run.event_contract === 'durable_items_v1' && !Object.values(file.task_events).some(value => {
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
      dispatch.state = state; dispatch.completed_at = now; if (error) dispatch.error = error
      return run.task_id
    })
    if (state === 'recovery_required' && taskId) productTaskWorkerRuntimeEvents.publish(taskId, { type: 'error', code: 'task_failed', retryable: false })
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

  async createTask(input: CreateProductTaskInput): Promise<ProductTaskRecord> {
    return this.withStoreLock(() => this.createTaskUnlocked(input))
  }

  private async createTaskUnlocked(input: CreateProductTaskInput): Promise<ProductTaskRecord> {
    if (!isRecord(input)) throw ApiError.badRequest('创建任务参数必须是对象')
    const title = validTitle(input.title)
    const permissionMode = productTaskPermissionMode(input.permissionMode)
    const useWorktree = optionalBoolean(input.useWorktree, 'useWorktree')
    const { store, binding } = await this.resolveCreateTaskBinding(input)
    const created = await this.core.createSession({
      workDir: binding.directory.path,
      // Keep Core-specific values inside this adapter boundary. Product
      // clients only send the safe product-facing choices above.
      permissionMode: CORE_PERMISSION_MODE_BY_PRODUCT_MODE[permissionMode],
      useWorktree,
    })
    const now = new Date().toISOString()
    const metadata: ProductTaskMetadata = {
      id: createProductTaskId(),
      coreSessionId: created.sessionId,
      projectId: binding.project.id,
      directoryId: binding.directory.id,
      ...(title ? { title } : {}),
      lifecycle: 'active',
      kind: 'main',
      createdAt: now,
      updatedAt: now,
      worktreeState: useWorktree ? 'planned' : 'not_requested',
      visibility: 'main',
      permission_snapshot: productPermissionSnapshot(permissionMode),
    }
    if (title) await this.core.renameSession(created.sessionId, title)
    store.tasks[metadata.id] = metadata
    await this.writeStore(store)
    return this.requireTask(metadata.id)
  }

  /**
   * Validate and resolve a public product task without returning its private
   * Agent Core binding. Server-side feature modules use this as their owner
   * check instead of ever accepting a Core session id.
   */
  async getTask(taskId: string): Promise<ProductTaskRecord> {
    return this.withStoreLock(() => this.requireTask(taskId))
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
    if (inspected.availability === 'missing') throw ApiError.badRequest('工作区根目录不存在')
    const id = `workspace_${createHash('sha256').update(`${this.installationId}\u0000${inspected.identity.volume_id}\u0000${inspected.identity.file_id}`).digest('hex').slice(0, 16)}`
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
    if (inspected.availability === 'missing') throw ApiError.badRequest('工作区根目录不存在')
    const id = `workspace_${createHash('sha256').update(`${this.installationId}\u0000${inspected.identity.volume_id}\u0000${inspected.identity.file_id}`).digest('hex').slice(0, 16)}`
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
        const priorScope = state.task_scopes[input.task_id] as { generation?: number } | undefined; state.task_scopes[input.task_id] = { kind: 'workspace', workspace_id: input.workspace_id, generation: (priorScope?.generation ?? 0) + 1 }; task.revision = taskRevision + 1; workspace.revision += 1
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

  async createNewTaskComposerDraft(input: { ttl_ms: number; client_operation_id: string }): Promise<{ draft: Record<string, unknown>; authority_revision: number; outcome: 'accepted' | 'duplicate' }> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps)
    const canonical = JSON.stringify({ kind: 'new_task_draft', ttl_ms: input.ttl_ms })
    const { file, result } = await authority.transactCapabilities((state) => {
      const prior = state.receipts[input.client_operation_id]
      if (prior) { if (state.events[input.client_operation_id]?.canonical_input !== canonical) throw new Error('OPERATION_INPUT_CONFLICT'); const id = (prior.result as { entity_id?: string } | undefined)?.entity_id; const draft = id ? state.composer_drafts[id] as Record<string, unknown> : undefined; if (!draft) throw new Error('AUTHORITY_INVALID'); return { changed: false as const, value: { draft, outcome: 'duplicate' as const } } }
      if (!Number.isSafeInteger(input.ttl_ms) || input.ttl_ms < 1) throw new Error('AUTHORITY_INVALID')
      const now = this.now().toISOString(), id = `draft_${randomUUID()}`, target = `task_${randomUUID()}`
      const draft = { draft_id: id, installation_id: this.installationId, target_task_id: target, target_state: 'pending_task', revision: 0, last_activity: now, state: 'active', created_at: now, expires_at: new Date(this.now().getTime() + input.ttl_ms).toISOString() }
      state.composer_drafts[id] = draft; state.receipts[input.client_operation_id] = { client_operation_id: input.client_operation_id, expected_revision: 0, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: id } }; state.event_sequence += 1; state.events[input.client_operation_id] = { event_sequence: state.event_sequence, client_operation_id: input.client_operation_id, kind: 'new_task_draft', revision: state.revision + 1, canonical_input: canonical, entity_id: id }
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

  async setAttachmentReadyForTest(attachmentId: string, expectedRevision: number): Promise<void> {
    const authority = new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps); await authority.mutateCapabilities((state) => { const attachment = state.task_attachments[attachmentId] as Record<string, unknown> | undefined; if (!attachment || attachment.installation_id !== this.installationId || attachment.revision !== expectedRevision || attachment.state !== 'staged') throw new Error('AUTHORITY_CONFLICT'); state.task_attachments[attachmentId] = { ...attachment, state: 'ready', revision: expectedRevision + 1, last_activity: this.now().toISOString() } })
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
    return this.withStoreLock(async () => {
      const authorityPath = this.usesDefaultStoragePath ? authorityStorePath(productStorePath()) : this.authorityPath
      let authority = await new ProductTaskAuthorityRepository(authorityPath).read()
      const record = authority.tasks[taskId] as { binding?: { coreSessionId?: unknown } } | undefined
      if (typeof record?.binding?.coreSessionId === 'string' && record.binding.coreSessionId) return record.binding.coreSessionId
      // Owner lookup is a strict, read-only D3 legacy projection. It must not
      // bootstrap an authority file; the first authoritative mutation does so.
      await readLegacyProductTasks(this.storagePath)
      return (await this.requireTaskBinding(taskId)).metadata.coreSessionId
    })
  }

  async getTaskThread(taskId: string): Promise<ProductTaskThread> {
    return this.withStoreLock(async () => {
      const getSessionMessages = this.core.getSessionMessages
      const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
      const task = (authority.tasks[taskId] as { task?: { current_lineage_id?: unknown } } | undefined)?.task
      if (typeof task?.current_lineage_id === 'string') {
        const runSequence = new Map<string, number>()
        for (const event of Object.values(authority.task_events)) {
          const value = event as { task_id?: unknown; run_id?: unknown; event_sequence?: unknown }
          if (value.task_id === taskId && typeof value.run_id === 'string' && typeof value.event_sequence === 'number') {
            runSequence.set(value.run_id, Math.max(runSequence.get(value.run_id) ?? 0, value.event_sequence))
          }
        }
        const lineageSegments: Array<{ lineageId: string; checkpoint?: string }> = []
        let lineage = authority.conversation_lineages[task.current_lineage_id] as Record<string, unknown> | undefined
        const seen = new Set<string>()
        while (lineage && typeof lineage.lineage_id === 'string') {
          if (seen.has(lineage.lineage_id)) throw new Error('AUTHORITY_INVALID')
          seen.add(lineage.lineage_id)
          lineageSegments.push({ lineageId: lineage.lineage_id })
          if (typeof lineage.parent_lineage_id !== 'string') break
          const parent = authority.conversation_lineages[lineage.parent_lineage_id] as Record<string, unknown> | undefined
          if (!parent || parent.product_task_id !== taskId) throw new Error('AUTHORITY_INVALID')
          lineageSegments[lineageSegments.length - 1]!.checkpoint = typeof lineage.fork_checkpoint_id === 'string' ? lineage.fork_checkpoint_id : undefined
          lineage = parent
        }
        lineageSegments.reverse()
        const allRuns = Object.values(authority.task_runs)
          .map(run => run as { run_id?: unknown; task_id?: unknown; lineage_id?: unknown; entry_id?: unknown; created_at?: unknown; event_contract?: unknown; core_binding?: { session_id?: unknown } })
          .filter(run => run.task_id === taskId && typeof run.run_id === 'string' && typeof run.created_at === 'string')
          .sort((left, right) => (
            (runSequence.get(left.run_id as string) ?? 0) - (runSequence.get(right.run_id as string) ?? 0)
            || Date.parse(left.created_at as string) - Date.parse(right.created_at as string)
          ))
        const entries: ProductTaskThreadEntry[] = []
        for (const [index, segment] of lineageSegments.entries()) {
          const cutoff = index + 1 < lineageSegments.length ? lineageSegments[index + 1]!.checkpoint : undefined
          let foundCutoff = cutoff === undefined
          for (const run of allRuns.filter(candidate => candidate.lineage_id === segment.lineageId)) {
            if (run.event_contract === 'durable_items_v1') {
              const events = Object.values(authority.task_events)
                .map(value => value as TaskEvent)
                .filter(event => 'run_id' in event && event.run_id === run.run_id)
                .sort((left, right) => left.event_sequence - right.event_sequence)
              for (const event of events) {
                if (event.type === 'user_text') {
                  const attachmentSummaries = await Promise.all(event.attachment_ids.map(async attachmentId => {
                    const attachment = authority.task_attachments[attachmentId] as { content_hash?: unknown; byte_size?: unknown; verified_media_type?: unknown } | undefined
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
                  const attachments = attachmentSummaries.filter((attachment): attachment is ProductTaskAttachmentSummary => attachment !== null)
                  entries.push({
                    id: event.item_id ?? durableUserItemId(event.run_id),
                    type: 'user_text',
                    text: event.text,
                    createdAt: event.created_at,
                    ...(attachments.length ? { attachments } : {}),
                    ...(event.reference_entry_ids?.length ? { referenceEntryIds: [...event.reference_entry_ids] } : {}),
                  })
                } else if (event.type === 'assistant_text') {
                  entries.push({ id: event.item_id, type: 'assistant_text', text: event.text, createdAt: event.created_at })
                } else if (event.type === 'activity' && (event.phase === 'completed' || event.phase === 'failed')) {
                  entries.push({ id: event.item_id, type: 'activity', kind: event.kind, phase: event.phase, createdAt: event.created_at })
                }
              }
            } else {
              if (!getSessionMessages || typeof run.core_binding?.session_id !== 'string') throw new ApiError(503, '任务记录暂不可用', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
              const messages = await getSessionMessages(run.core_binding.session_id).catch(() => [])
              const projected = projectSessionTranscriptForProductTask(taskId, messages).entries
              const durableEntry = typeof run.entry_id === 'string' ? authority.thread_entries[run.entry_id] as { reference_entry_ids?: unknown } | undefined : undefined
              const referenceEntryIds = Array.isArray(durableEntry?.reference_entry_ids) ? durableEntry.reference_entry_ids.filter((id): id is string => typeof id === 'string') : []
              let attached = false
              entries.push(...projected.map(entry => {
                if (!attached && entry.type === 'user_text' && referenceEntryIds.length) {
                  attached = true
                  return { ...entry, referenceEntryIds }
                }
                return entry
              }))
            }
            if (cutoff && run.entry_id === cutoff) { foundCutoff = true; break }
          }
          if (!foundCutoff) throw new Error('AUTHORITY_INVALID')
        }
        if (entries.length > 0) return { taskId, entries, ...(recoveryRequiredTaskRunId(authority, taskId) ? { recoveryRequired: true } : {}) }
      }
      if (!getSessionMessages) throw new ApiError(503, '任务记录暂不可用', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
      const sessionId = (await this.requireTaskBinding(taskId)).metadata.coreSessionId
      const messages = await getSessionMessages(sessionId)
      return { ...projectSessionTranscriptForProductTask(taskId, messages), ...(recoveryRequiredTaskRunId(authority, taskId) ? { recoveryRequired: true } : {}) }
    })
  }

  async updateTask(taskId: string, input: UpdateProductTaskInput): Promise<ProductTaskRecord> {
    return this.withStoreLock(() => this.updateTaskUnlocked(taskId, input))
  }

  private async updateTaskUnlocked(taskId: string, input: UpdateProductTaskInput): Promise<ProductTaskRecord> {
    if (!isRecord(input)) throw ApiError.badRequest('更新任务参数必须是对象')
    const binding = await this.requireTaskBinding(taskId)
    const task = binding.task
    const title = validTitle(input.title)
    const pinned = input.pinned
    const hasPinnedUpdate = pinned !== undefined
    if (hasPinnedUpdate && typeof pinned !== 'boolean') {
      throw ApiError.badRequest('pinned 必须是布尔值')
    }
    if (title === undefined && !hasPinnedUpdate) {
      throw ApiError.badRequest('请提供要更新的任务字段')
    }
    if (title !== undefined) requireTaskAction(task, 'rename')
    if (hasPinnedUpdate) requireTaskAction(task, pinned ? 'pin' : 'unpin')

    if (title) await this.core.renameSession(binding.metadata.coreSessionId, title)
    await this.updateMetadata(taskId, (metadata) => ({
      ...metadata,
      ...(title ? { title } : {}),
      ...(hasPinnedUpdate ? pinned
        ? { pinnedAt: new Date().toISOString() }
        : { pinnedAt: undefined } : {}),
      updatedAt: new Date().toISOString(),
    }))
    return this.requireTask(taskId)
  }

  async setPinned(taskId: string, pinned: boolean): Promise<ProductTaskRecord> {
    return this.updateTask(taskId, { pinned })
  }

  async setArchived(taskId: string, archived: boolean): Promise<ProductTaskRecord> {
    return this.withStoreLock(() => this.setArchivedUnlocked(taskId, archived))
  }

  private async setArchivedUnlocked(taskId: string, archived: boolean): Promise<ProductTaskRecord> {
    if (typeof archived !== 'boolean') throw ApiError.badRequest('archived 必须是布尔值')
    const binding = await this.requireTaskBinding(taskId)
    const task = binding.task
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    if (archived && hasBlockingTaskWork(authority, taskId)) {
      throw new ApiError(
        409,
        '任务正在运行或等待确认，请先停止任务后再归档',
        'PRODUCT_TASK_ACTIVE_RUN',
      )
    }
    requireTaskAction(task, archived ? 'archive' : 'restore')
    const now = new Date().toISOString()
    await this.updateMetadata(taskId, (metadata) => ({
      ...metadata,
      lifecycle: archived ? 'archived' : 'active',
      archivedAt: archived ? now : undefined,
      updatedAt: now,
    }))
    return this.requireTask(taskId)
  }

  async continueTask(taskId: string, input: ContinueProductTaskInput): Promise<ProductTaskRecord> {
    return this.withStoreLock(() => this.continueTaskUnlocked(taskId, input))
  }

  private async continueTaskUnlocked(
    taskId: string,
    input: ContinueProductTaskInput,
  ): Promise<ProductTaskRecord> {
    if (!isRecord(input)) {
      throw ApiError.badRequest('继续任务参数必须是对象')
    }
    rejectCoreSourceTurnId(input)
    const sourceBinding = await this.requireTaskBinding(taskId)
    const source = sourceBinding.task
    requireTaskAction(source, 'continue')
    const requestedTitle = validTitle(input.title) ?? `继续：${source.title}`
    const target = continuationTarget(input.target)
    const sourceEntryId = optionalSourceEntryId(input.sourceEntryId)
    const sourceTurnId = sourceEntryId
      ? await this.resolveSourceTurnIdForProductEntry(sourceBinding.metadata.coreSessionId, sourceEntryId)
      : undefined
    const created = await this.core.branchSession(
      sourceBinding.metadata.coreSessionId,
      requestedTitle,
      sourceTurnId,
      target,
    )
    const now = new Date().toISOString()
    const metadata: ProductTaskMetadata = {
      id: createProductTaskId(),
      coreSessionId: created.sessionId,
      projectId: source.projectId,
      directoryId: source.directoryId,
      title: created.title,
      lifecycle: 'active',
      kind: 'continuation',
      parentTaskId: source.id,
      ...(sourceTurnId ? { sourceTurnId } : {}),
      createdAt: now,
      updatedAt: now,
      worktreeState: target === 'new_worktree'
        ? 'materialized'
        : source.worktreeState,
      visibility: 'main',
      permission_snapshot: taskPermissionSnapshot(source.permission_snapshot),
    }
    const { store } = await this.loadRegisteredStore()
    store.tasks[metadata.id] = metadata
    await this.writeStore(store)
    return this.requireTask(metadata.id)
  }

  async listSideTasks(taskId: string): Promise<ProductSideTask[]> {
    const legacy = await this.withStoreLock(() => this.listSideTasksUnlocked(taskId))
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    const byId = new Map(legacy.map(task => [task.id, task]))
    for (const value of Object.values(authority.side_tasks)) {
      const side = publicSideTask(value as ProductSideTaskMetadata)
      if (side.parentTaskId === taskId) byId.set(side.id, side)
    }
    return [...byId.values()]
  }

  private async listSideTasksUnlocked(taskId: string): Promise<ProductSideTask[]> {
    await this.requireTask(taskId)
    const { store } = await this.loadRegisteredStore()
    return Object.values(store.sideTasks)
      .filter((sideTask) => sideTask.parentTaskId === taskId)
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === 'open' ? -1 : 1
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      })
      .map(publicSideTask)
  }

  async createSideTask(
    taskId: string,
    input: CreateProductSideTaskInput,
  ): Promise<ProductSideTask> {
    return this.withStoreLock(() => this.createSideTaskUnlocked(taskId, input))
  }

  private async createSideTaskUnlocked(
    taskId: string,
    input: CreateProductSideTaskInput,
  ): Promise<ProductSideTask> {
    if (!isRecord(input)) {
      throw ApiError.badRequest('侧边任务参数必须是对象')
    }
    rejectCoreSourceTurnId(input)
    const sourceBinding = await this.requireTaskBinding(taskId)
    const source = sourceBinding.task
    if (source.lifecycle !== 'active') {
      throw ApiError.conflict('归档任务不能创建侧边任务')
    }
    const sourceEntryId = requiredSourceEntryId(input.sourceEntryId)
    const sourceTurnId = await this.resolveSourceTurnIdForProductEntry(
      sourceBinding.metadata.coreSessionId,
      sourceEntryId,
    )
    const requestedTitle = validTitle(input.title) ?? `侧边任务：${source.title}`
    const created = await this.core.branchSession(
      sourceBinding.metadata.coreSessionId,
      requestedTitle,
      sourceTurnId,
    )
    const now = new Date().toISOString()
    const sideTaskTaskId = createProductTaskId()
    const sideTask: ProductSideTaskMetadata = {
      id: createProductSideTaskId(),
      parentTaskId: source.id,
      taskId: sideTaskTaskId,
      sourceTurnId,
      coreSessionId: created.sessionId,
      title: created.title,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    const { store } = await this.loadRegisteredStore()
    store.tasks[sideTaskTaskId] = {
      id: sideTaskTaskId,
      coreSessionId: created.sessionId,
      projectId: source.projectId,
      directoryId: source.directoryId,
      title: created.title,
      lifecycle: 'active',
      kind: 'continuation',
      parentTaskId: source.id,
      sourceTurnId,
      createdAt: now,
      updatedAt: now,
      worktreeState: source.worktreeState,
      visibility: 'side_task',
      permission_snapshot: taskPermissionSnapshot(source.permission_snapshot),
    }
    store.sideTasks[sideTask.id] = sideTask
    await this.writeStore(store)
    return publicSideTask(sideTask)
  }

  async closeSideTask(taskId: string, sideTaskId: string): Promise<ProductSideTask> {
    return this.withStoreLock(() => this.closeSideTaskUnlocked(taskId, sideTaskId))
  }

  private async closeSideTaskUnlocked(taskId: string, sideTaskId: string): Promise<ProductSideTask> {
    await this.requireTask(taskId)
    const { store } = await this.loadRegisteredStore()
    const sideTask = store.sideTasks[sideTaskId]
    if (!sideTask || sideTask.parentTaskId !== taskId) {
      throw ApiError.notFound(`侧边任务不存在：${sideTaskId}`)
    }
    if (sideTask.status === 'closed') return publicSideTask(sideTask)

    const now = new Date().toISOString()
    const closed: ProductSideTaskMetadata = {
      ...sideTask,
      status: 'closed',
      closedAt: now,
      updatedAt: now,
    }
    store.sideTasks[sideTaskId] = closed
    await this.writeStore(store)
    return publicSideTask(closed)
  }

  private async resolveCreateTaskBinding(input: CreateProductTaskInput): Promise<{
    store: ProductTaskStore
    binding: ProductDirectoryBinding
  }> {
    const projectId = requestedProductResourceId(input.projectId, 'projectId')
    const directoryId = requestedProductResourceId(input.directoryId, 'directoryId')
    if (Boolean(projectId) !== Boolean(directoryId)) {
      throw ApiError.badRequest('projectId 和 directoryId 必须同时提供')
    }

    const { store } = await this.loadRegisteredStore()
    if (projectId && directoryId) {
      const project = store.projects[projectId]
      if (!project) throw ApiError.notFound(`项目不存在：${projectId}`)
      const directory = store.directories[directoryId]
      if (!directory || directory.projectId !== project.id) {
        throw ApiError.badRequest('所选目录不属于当前项目')
      }
      if (!isSameOrChildPath(project.rootDir, directory.path)) {
        throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
      }
      const actualDirectory = await this.canonicalizeExistingDirectory(directory.path)
      if (!sameProductPath(actualDirectory, directory.path)) {
        throw ApiError.conflict('所选目录的位置已变化，请重新选择')
      }
      return { store, binding: { project, directory } }
    }

    if (typeof input.workDir !== 'string' || !input.workDir.trim()) {
      throw ApiError.badRequest('workDir 必须是非空字符串')
    }
    const directoryPath = await this.canonicalizeExistingDirectory(input.workDir)
    const rootDir = this.projectRootForDirectory(directoryPath)
    const now = new Date().toISOString()
    const registered = this.registerProductDirectory(store, rootDir, directoryPath, {
      createdAt: now,
      updatedAt: now,
      touch: true,
    })
    return { store, binding: registered }
  }

  private async loadRegisteredStore(): Promise<{
    store: ProductTaskStore
    sessions: AgentCoreSession[]
  }> {
    let [store, sessions] = await Promise.all([this.readStore(), this.core.listSessions()])
    store = await this.importLegacyCoreSessionsOnce(store, sessions)
    store = await this.ensureProjectStructure(store, sessions)
    return { store, sessions }
  }

  /**
   * v1-v3 stored only a private Core binding per task. Backfill stable product
   * project/directory identities once the registered Core session is visible;
   * the Core binding itself remains private and is not returned by listTasks.
   */
  private async ensureProjectStructure(
    store: ProductTaskStore,
    sessions: readonly AgentCoreSession[],
  ): Promise<ProductTaskStore> {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    let changed = false

    for (const metadata of Object.values(store.tasks)) {
      // A registered directory is the product's durable source-directory
      // identity. In particular, a continuation can execute in a materialized
      // worktree while it must remain bound to the directory selected for its
      // source task. Only legacy or invalid bindings are derived from Core.
      if (this.existingProductDirectoryBinding(store, metadata)) continue

      const session = sessionsById.get(metadata.coreSessionId)
      if (!session) continue

      const rootDir = await this.projectRootForSession(session)
      if (!rootDir) continue
      const directoryPath = await this.migrationDirectoryForTask(session, metadata, rootDir)
      const registered = this.registerProductDirectory(store, rootDir, directoryPath, {
        preferredProjectId: metadata.projectId,
        preferredDirectoryId: metadata.directoryId,
        legacyIds: !metadata.projectId || !metadata.directoryId,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        touch: false,
      })
      changed ||= registered.changed
      if (metadata.projectId !== registered.project.id || metadata.directoryId !== registered.directory.id) {
        metadata.projectId = registered.project.id
        metadata.directoryId = registered.directory.id
        changed = true
      }
    }

    for (const directory of Object.values(store.directories)) {
      const project = store.projects[directory.projectId]
      if (!project || !isSameOrChildPath(project.rootDir, directory.path)) {
        throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
      }
    }

    if (changed) await this.writeStore(store)
    return store
  }

  private existingProductDirectoryBinding(
    store: ProductTaskStore,
    metadata: ProductTaskMetadata,
  ): ProductDirectoryBinding | null {
    if (!metadata.projectId || !metadata.directoryId) return null
    const project = store.projects[metadata.projectId]
    const directory = store.directories[metadata.directoryId]
    if (
      !project
      || !directory
      || directory.projectId !== project.id
      || !isSameOrChildPath(project.rootDir, directory.path)
    ) {
      return null
    }
    return { project, directory }
  }

  private registerProductDirectory(
    store: ProductTaskStore,
    rootDir: string,
    directoryPath: string,
    options: {
      preferredProjectId?: string
      preferredDirectoryId?: string
      legacyIds?: boolean
      createdAt: string
      updatedAt: string
      touch: boolean
    },
  ): RegisteredProductDirectory {
    if (!isSameOrChildPath(rootDir, directoryPath)) {
      throw ApiError.badRequest('工作目录必须位于所选项目内')
    }

    let changed = false
    let project = Object.values(store.projects).find((candidate) => sameProductPath(candidate.rootDir, rootDir))
    if (!project) {
      const preferred = options.preferredProjectId
      const projectId = preferred && !store.projects[preferred]
        ? preferred
        : options.legacyIds
          ? legacyProductProjectId(rootDir)
          : createProductProjectId()
      const existingById = store.projects[projectId]
      if (existingById && !sameProductPath(existingById.rootDir, rootDir)) {
        throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
      }
      project = existingById ?? {
        id: projectId,
        title: projectTitle(rootDir),
        rootDir,
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
      }
      if (!existingById) {
        store.projects[project.id] = project
        changed = true
      }
    }
    if (!project) throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    const registeredProject = project

    let directory = Object.values(store.directories).find((candidate) => (
      candidate.projectId === registeredProject.id && sameProductPath(candidate.path, directoryPath)
    ))
    if (!directory) {
      const preferred = options.preferredDirectoryId
      const directoryId = preferred && !store.directories[preferred]
        ? preferred
        : options.legacyIds
          ? legacyProductDirectoryId(project.id, directoryPath)
          : createProductDirectoryId()
      const existingById = store.directories[directoryId]
      if (
        existingById
        && (existingById.projectId !== project.id || !sameProductPath(existingById.path, directoryPath))
      ) {
        throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
      }
      directory = existingById ?? {
        id: directoryId,
        projectId: project.id,
        path: directoryPath,
        label: directoryLabel(project.rootDir, directoryPath),
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
      }
      if (!existingById) {
        store.directories[directory.id] = directory
        changed = true
      }
    }

    if (options.touch) {
      if (project.updatedAt !== options.updatedAt) {
        project = { ...project, updatedAt: options.updatedAt }
        store.projects[project.id] = project
        changed = true
      }
      if (directory.updatedAt !== options.updatedAt) {
        directory = { ...directory, updatedAt: options.updatedAt }
        store.directories[directory.id] = directory
        changed = true
      }
    }

    return { project, directory, changed }
  }

  private async canonicalizeExistingDirectory(value: string): Promise<string> {
    const resolved = path.resolve(value.trim())
    let realPath: string
    try {
      realPath = (await fs.realpath(resolved)).normalize('NFC')
    } catch {
      // Keep the product contract compatible with the Core adapter: the Core
      // remains the final authority for whether a launch directory is usable.
      // Do not persist this binding until a session was created successfully.
      return resolved.normalize('NFC')
    }
    const stat = await fs.stat(realPath).catch(() => null)
    if (!stat?.isDirectory()) {
      throw ApiError.badRequest(`工作目录不是目录：${realPath}`)
    }
    return realPath
  }

  private async canonicalizeKnownDirectory(value: string): Promise<string> {
    const resolved = path.resolve(value).normalize('NFC')
    return (await fs.realpath(resolved).catch(() => resolved)).normalize('NFC')
  }

  private projectRootForDirectory(directoryPath: string): string {
    return findProductCanonicalGitRoot(directoryPath) ?? directoryPath
  }

  private async projectRootForSession(session: AgentCoreSession): Promise<string | null> {
    const candidate = session.projectRoot ?? session.workDir
    if (!candidate) return null
    return this.projectRootForDirectory(await this.canonicalizeKnownDirectory(candidate))
  }

  private async migrationDirectoryForTask(
    session: AgentCoreSession,
    metadata: ProductTaskMetadata,
    rootDir: string,
  ): Promise<string> {
    const workDir = session.workDir
      ? await this.canonicalizeKnownDirectory(session.workDir)
      : rootDir
    if (
      metadata.worktreeState !== 'not_requested'
      && isDesktopWorktreeDirectory(workDir, rootDir)
    ) {
      return rootDir
    }
    return isSameOrChildPath(rootDir, workDir) ? workDir : rootDir
  }

  private async requireTask(taskId: string): Promise<ProductTaskRecord> {
    return (await this.requireTaskBinding(taskId)).task
  }

  private async resolveSourceTurnIdForProductEntry(
    coreSessionId: string,
    sourceEntryId: string,
  ): Promise<string> {
    const getSessionMessages = this.core.getSessionMessages
    if (!getSessionMessages) {
      throw new ApiError(503, '暂时无法读取当前任务记录', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
    }

    const sourceTurnId = resolveCoreMessageIdForProductThreadEntry(
      await getSessionMessages(coreSessionId),
      sourceEntryId,
    )
    if (!sourceTurnId) {
      throw ApiError.badRequest('请选择当前任务中的一条已保存消息')
    }
    return sourceTurnId
  }

  private async resolveTaskBranchSource(
    taskId: string,
    sourceEntryId: string,
    authority: AuthorityFile,
  ): Promise<{ coreSessionId: string; coreTurnId: string; checkpointEntryId: string }> {
    const getSessionMessages = this.core.getSessionMessages
    if (!getSessionMessages) throw new ApiError(503, '暂时无法读取当前任务记录', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
    const task = (authority.tasks[taskId] as { task?: { current_lineage_id?: unknown } } | undefined)?.task
    if (typeof task?.current_lineage_id === 'string') {
      const lineageSegments: Array<{ lineageId: string; checkpoint?: string }> = []
      let lineage = authority.conversation_lineages[task.current_lineage_id] as Record<string, unknown> | undefined
      const seen = new Set<string>()
      while (lineage && typeof lineage.lineage_id === 'string') {
        if (seen.has(lineage.lineage_id)) throw new Error('AUTHORITY_INVALID')
        seen.add(lineage.lineage_id)
        lineageSegments.push({ lineageId: lineage.lineage_id })
        if (typeof lineage.parent_lineage_id !== 'string') break
        const parent = authority.conversation_lineages[lineage.parent_lineage_id] as Record<string, unknown> | undefined
        if (!parent || parent.product_task_id !== taskId) throw new Error('AUTHORITY_INVALID')
        lineageSegments[lineageSegments.length - 1]!.checkpoint = typeof lineage.fork_checkpoint_id === 'string' ? lineage.fork_checkpoint_id : undefined
        lineage = parent
      }
      lineageSegments.reverse()
      const runSequence = new Map<string, number>()
      for (const event of Object.values(authority.task_events)) {
        const value = event as { run_id?: unknown; event_sequence?: unknown }
        if (typeof value.run_id === 'string' && typeof value.event_sequence === 'number') {
          runSequence.set(value.run_id, Math.max(runSequence.get(value.run_id) ?? 0, value.event_sequence))
        }
      }
      const runs = Object.values(authority.task_runs)
        .map(value => value as { run_id?: unknown; task_id?: unknown; lineage_id?: unknown; entry_id?: unknown; created_at?: unknown; event_contract?: unknown; core_binding?: { session_id?: unknown } })
        .filter(run => run.task_id === taskId && typeof run.lineage_id === 'string' && typeof run.entry_id === 'string' && typeof run.created_at === 'string' && typeof run.core_binding?.session_id === 'string')
        .sort((left, right) => (
          (runSequence.get(left.run_id as string) ?? 0) - (runSequence.get(right.run_id as string) ?? 0)
          || Date.parse(left.created_at as string) - Date.parse(right.created_at as string)
        ))
      for (const [index, segment] of lineageSegments.entries()) {
        const cutoff = index + 1 < lineageSegments.length ? lineageSegments[index + 1]!.checkpoint : undefined
        let foundCutoff = cutoff === undefined
        for (const run of runs.filter(candidate => candidate.lineage_id === segment.lineageId)) {
          const messages = await getSessionMessages(run.core_binding!.session_id as string).catch(() => [])
          const coreTurnId = resolveCoreMessageIdForProductThreadEntry(messages, sourceEntryId)
          if (coreTurnId) return { coreSessionId: run.core_binding!.session_id as string, coreTurnId, checkpointEntryId: run.entry_id as string }
          if (run.event_contract === 'durable_items_v1' && typeof run.run_id === 'string') {
            const durableMatch = Object.values(authority.task_events)
              .map(value => value as TaskEvent)
              .find(event => 'run_id' in event && event.run_id === run.run_id && (
                (event.type === 'user_text' && durableUserItemId(event.run_id) === sourceEntryId) ||
                (event.type === 'assistant_text' && event.item_id === sourceEntryId)
              ))
            if (durableMatch) {
              const candidates = durableMatch.type === 'user_text' ? messages : [...messages].reverse()
              const source = candidates.find(message => projectSessionTranscriptForProductTask(taskId, [message]).entries.some(entry => entry.type === durableMatch.type))
              if (source) return { coreSessionId: run.core_binding!.session_id as string, coreTurnId: source.id, checkpointEntryId: run.entry_id as string }
            }
          }
          if (cutoff && run.entry_id === cutoff) { foundCutoff = true; break }
        }
        if (!foundCutoff) throw new Error('AUTHORITY_INVALID')
      }
    }
    throw ApiError.badRequest('请选择当前任务谱系中的一条已保存消息')
  }

  private async requireTaskBinding(taskId: string): Promise<{
    task: ProductTaskRecord
    metadata: ProductTaskMetadata
  }> {
    const { store, sessions } = await this.loadRegisteredStore()
    const stored = store.tasks[taskId]
    if (stored) {
      const session = sessions.find((candidate) => candidate.id === stored.coreSessionId) ?? this.sessionFromProductBinding(store, stored)
      if (!session) throw ApiError.notFound(`任务不存在：${taskId}`)
      const task = await this.toRecord(session, stored)
      const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
      return {
        task: {
          ...task,
          actions: actionsFor(task, hasBlockingTaskWork(authority, taskId) || !task.actions.includes('archive')),
        },
        metadata: stored,
      }
    }
    throw ApiError.notFound(`任务不存在：${taskId}`)
  }

  private sessionFromProductBinding(store: ProductTaskStore, metadata: ProductTaskMetadata): AgentCoreSession | undefined {
    if (!metadata.projectId || !metadata.directoryId) return undefined
    const project = store.projects[metadata.projectId]
    const directory = store.directories[metadata.directoryId]
    if (!project || !directory || directory.projectId !== project.id || !isSameOrChildPath(project.rootDir, directory.path)) return undefined
    return {
      id: metadata.coreSessionId,
      ...(metadata.title ? { title: metadata.title } : {}),
      createdAt: metadata.createdAt,
      modifiedAt: metadata.updatedAt,
      projectRoot: project.rootDir,
      workDir: directory.path,
    }
  }

  /**
   * Move the legacy Core list across the product boundary once.  After this
   * write, only explicit product metadata participates in the task index or
   * can resolve a public task id; Core may still execute a registered task,
   * but it no longer defines the product's task collection.
   */
  private async importLegacyCoreSessionsOnce(
    store: ProductTaskStore,
    sessions: readonly AgentCoreSession[],
  ): Promise<ProductTaskStore> {
    if (store.legacyCoreSessionsImportedAt) return store

    const registeredCoreSessionIds = new Set(
      Object.values(store.tasks).map((task) => task.coreSessionId),
    )
    const sideTaskSessionIds = new Set(
      Object.values(store.sideTasks).map((sideTask) => sideTask.coreSessionId),
    )

    for (const session of sessions) {
      if (registeredCoreSessionIds.has(session.id) || sideTaskSessionIds.has(session.id)) continue
      const taskId = legacyProductTaskId(session.id)
      const existing = store.tasks[taskId]
      if (existing && existing.coreSessionId !== session.id) {
        throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
      }
      store.tasks[taskId] = defaultMetadata(session)
      registeredCoreSessionIds.add(session.id)
    }

    store.legacyCoreSessionsImportedAt = new Date().toISOString()
    await this.writeStore(store)
    return store
  }

  private async toRecord(
    session: AgentCoreSession,
    saved: ProductTaskMetadata | undefined,
  ): Promise<ProductTaskRecord> {
    const metadata = saved ?? defaultMetadata(session)
    const workDir = session.workDir ?? session.projectRoot ?? ''
    if (!metadata.projectId || !metadata.directoryId) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    const requestedWorktree = metadata.worktreeState !== 'not_requested'
    const worktreeState = requestedWorktree
      ? await this.resolveWorktreeState(session.id)
      : 'not_requested'
    const task: ProductTask = {
      id: metadata.id,
      projectId: metadata.projectId,
      directoryId: metadata.directoryId,
      workDir,
      title: metadata.title ?? session.title ?? '',
      lifecycle: metadata.lifecycle === 'archived' ? 'archived' : 'active',
      kind: metadata.kind === 'continuation' ? 'continuation' : 'main',
      ...(metadata.pinnedAt ? { pinnedAt: metadata.pinnedAt } : {}),
      ...(metadata.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
      ...(metadata.parentTaskId ? { parentTaskId: metadata.parentTaskId } : {}),
      permission_snapshot: taskPermissionSnapshot(metadata.permission_snapshot),
      createdAt: metadata.createdAt || session.createdAt,
      updatedAt: latestProductTimestamp(metadata.updatedAt, session.modifiedAt) || session.modifiedAt,
      worktreeState,
    }
    return {
      ...task,
      actions: actionsFor(task, await this.hasBlockingTaskWork(task.id)),
    }
  }

  private async hasBlockingTaskWork(taskId: string): Promise<boolean> {
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath, this.authorityRepositoryDeps).read()
    return hasBlockingTaskWork(authority, taskId)
  }

  private async resolveWorktreeState(sessionId: string): Promise<ProductTask['worktreeState']> {
    try {
      return (await this.core.getWorktreeLaunchState(sessionId)) === 'materialized'
        ? 'materialized'
        : 'planned'
    } catch {
      return 'planned'
    }
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

  private async readStore(): Promise<ProductTaskStore> {
    try {
      const raw = await fs.readFile(this.storagePath, 'utf8')
      return normalizeProductTaskStore(JSON.parse(raw) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: PRODUCT_TASK_STORE_VERSION,
          projects: {},
          directories: {},
          tasks: {},
          sideTasks: {},
        }
      }
      if (error instanceof ApiError) throw error
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
  }

  private async updateMetadata(
    taskId: string,
    update: (current: ProductTaskMetadata) => ProductTaskMetadata,
  ): Promise<void> {
    const binding = await this.requireTaskBinding(taskId)
    const { store } = await this.loadRegisteredStore()
    const next = update(store.tasks[taskId] ?? binding.metadata)
    store.tasks[taskId] = next
    if (next.projectId && store.projects[next.projectId]) {
      store.projects[next.projectId] = {
        ...store.projects[next.projectId],
        updatedAt: latestProductTimestamp(
          store.projects[next.projectId].updatedAt,
          next.updatedAt,
        ),
      }
    }
    await this.writeStore(store)
  }

  private async writeStore(store: ProductTaskStore): Promise<void> {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await fs.rename(temporaryPath, this.storagePath)
  }
}

async function purgeLegacyProductSessionMemory(storageDir: string, taskId: string): Promise<void> {
  const entries = await fs.readdir(storageDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(storageDir, entry.name)
    const value = await fs.readFile(file, 'utf8').then(JSON.parse)
    if (value && typeof value === 'object' && !Array.isArray(value) && value.task_id === taskId) {
      await fs.unlink(file)
    }
  }
}

/**
 * Server tests (and Electron restarts) may change the configured data root
 * after this module has been imported.  Keep the live binding replaceable so
 * each sidecar start owns exactly the data root it was started with.
 */
export let productTaskService = new ProductTaskService()

export function resetProductTaskServiceForServer(options: {
  additionalLifecycleParticipants?: readonly TaskLifecycleParticipant[]
} = {}): ProductTaskService {
  productTaskService = new ProductTaskService(options)
  return productTaskService
}
