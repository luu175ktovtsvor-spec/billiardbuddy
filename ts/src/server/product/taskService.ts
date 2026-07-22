import { createHash, randomUUID, type UUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PRODUCT_DOMAIN_VERSION,
  PRODUCT_TASK_PERMISSION_MODES,
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
  type UpdateProductTaskInput,
} from '../../../shared/product/domain.js'
import type { ProductTaskThread } from '../../../shared/product/taskEvents.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  sessionService,
  type MessageEntry,
  type SessionListItem,
} from '../services/sessionService.js'
import {
  createSessionBranch,
  SessionBranchingError,
} from '../../utils/sessionBranching.js'
import {
  cleanupPreparedSessionWorkspace,
  isMaterializedWorktreeLaunch,
  prepareSessionWorkspace,
} from '../services/repositoryLaunchService.js'
import {
  projectSessionTranscriptForProductTask,
  resolveCoreMessageIdForProductThreadEntry,
} from './taskThreadProjection.js'
import { productTaskRunProjection } from './taskRunProjection.js'
import { findCanonicalGitRoot, findGitRoot } from '../../utils/git.js'
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
import { ProductTaskAuthorityRepository, readLegacyProductTasks } from './authorityRepository.js'
import { CoreOperationTerminalError, type CoreOperationBridge } from './coreOperationBridge.js'

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

export type AgentCoreSession = Pick<
  SessionListItem,
  'id' | 'title' | 'createdAt' | 'modifiedAt' | 'projectRoot' | 'workDir'
>

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

/**
 * Server-owned product runtime state. The Core session ID never crosses the
 * product API, but the task registry needs this narrow check to keep a live
 * task from being hidden while its stop or approval controls are still needed.
 */
export type ProductTaskRunInspector = {
  hasActiveRunForSession: (sessionId: string) => boolean
}

export const agentCoreAdapter: AgentCoreAdapter = {
  async listSessions() {
    const { sessions } = await sessionService.listSessions({ limit: 1_000, offset: 0 })
    return sessions
  },

  async createSession(input) {
    return sessionService.createSession(
      input.workDir,
      input.useWorktree ? { worktree: true } : undefined,
      input.permissionMode,
    )
  },

  async renameSession(sessionId, title) {
    await sessionService.renameSession(sessionId, title)
  },

  async branchSession(sessionId, title, sourceTurnId, target = 'current_workspace') {
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    if (!launchInfo) throw ApiError.notFound(`任务不存在：${sessionId}`)

    const targetSessionId = target === 'new_worktree'
      ? randomUUID() as UUID
      : undefined
    const preparedWorkspace = targetSessionId
      ? await prepareSessionWorkspace(
          launchInfo.repository?.requestedWorkDir ?? launchInfo.workDir,
          {
            branch: launchInfo.repository?.branch,
            worktree: true,
          },
          targetSessionId,
        )
      : undefined

    try {
      const result = await createSessionBranch({
        sourceSessionId: sessionId,
        sourceTranscriptPath: launchInfo.filePath,
        title,
        targetMessageId: sourceTurnId,
        sourceWorkDir: launchInfo.workDir,
        sourceRepository: launchInfo.repository,
        sourceWorktreeSession: launchInfo.worktreeSession,
        ...(targetSessionId ? { targetSessionId } : {}),
        ...(preparedWorkspace
          ? {
              targetWorkDir: preparedWorkspace.workDir,
              targetRepository: preparedWorkspace.repository,
            }
          : {}),
      })
      sessionService.invalidateSessionList()
      return {
        sessionId: result.sessionId,
        workDir: result.workDir ?? launchInfo.workDir,
        title: result.title,
      }
    } catch (error) {
      if (preparedWorkspace) {
        await cleanupPreparedSessionWorkspace(preparedWorkspace).catch(() => false)
      }
      if (error instanceof SessionBranchingError) {
        throw ApiError.badRequest(error.message)
      }
      throw error
    }
  },

  async getWorktreeLaunchState(sessionId) {
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    if (!launchInfo?.repository?.worktree) return 'not_requested'
    return isMaterializedWorktreeLaunch(launchInfo) ? 'materialized' : 'planned'
  },

  async getSessionMessages(sessionId) {
    return sessionService.getSessionMessages(sessionId)
  },
}

function productStorePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
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
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`
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
  if (!findGitRoot(workDir)) {
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
  'default' | 'acceptEdits' | 'plan'
> = {
  ask: 'default',
  allow_edits: 'acceptEdits',
  plan_only: 'plan',
}

function productTaskPermissionMode(value: unknown): ProductTaskPermissionMode {
  if (value === undefined) return 'ask'
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
  return publicTask as ProductTaskRecord
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
  private readonly runs: ProductTaskRunInspector

  constructor(options: {
    storagePath?: string
    core?: AgentCoreAdapter
    runs?: ProductTaskRunInspector
  } = {}) {
    this.usesDefaultStoragePath = !options.storagePath
    this.storagePath = options.storagePath ?? productStorePath()
    this.authorityPath = options.storagePath ? authorityStorePath(options.storagePath) : authorityStorePath(productStorePath())
    this.core = options.core ?? agentCoreAdapter
    this.runs = options.runs ?? productTaskRunProjection
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
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath).read()
    const byId = new Map(legacy.tasks.map(task => [task.id, task]))
    const sideTaskIds = new Set(Object.values(authority.side_tasks).map(side => (side as { taskId?: unknown }).taskId).filter((id): id is string => typeof id === 'string'))
    for (const value of Object.values(authority.tasks)) {
      const task = authorityPublicTask(value)
      if (!task?.id || sideTaskIds.has(task.id) || (task as unknown as { kind?: unknown }).kind === 'side') continue
      const runtime = byId.get(task.id)
      // worktree state, action availability and transcript activity are live
      // Core projections, not authority metadata mutations.
      byId.set(task.id, runtime ? { ...task, workDir: runtime.workDir, worktreeState: runtime.worktreeState, updatedAt: runtime.updatedAt, actions: runtime.actions } : task)
    }
    const tasks = [...byId.values()]
    return { ...legacy, tasks, total: tasks.length }
  }

  async listTasksAuthoritatively(): Promise<ProductTaskIndexResponse> { return this.listTasks() }

  async listSideTasksAuthoritatively(taskId: string): Promise<ProductSideTask[]> { return this.listSideTasks(taskId) }

  private async listTasksUnlocked(): Promise<ProductTaskIndexResponse> {
    const { store, sessions } = await this.loadRegisteredStore()
    const sideTaskSessionIds = new Set(
      Object.values(store.sideTasks).map((sideTask) => sideTask.coreSessionId),
    )
    const records: ProductTaskRecord[] = []
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    for (const metadata of Object.values(store.tasks)) {
      if (sideTaskSessionIds.has(metadata.coreSessionId) || metadata.visibility === 'side_task') continue
      const session = sessionsById.get(metadata.coreSessionId)
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

  async continueTaskAuthoritatively(input: { taskId: string; expected_revision: number; client_operation_id: string; canonical_input: string }, options: { authorityPath: string; bridge: Pick<CoreOperationBridge, 'ensureBranch'> }): Promise<{ outcome: string; revision: number }> {
    await this.ensureAuthorityProjectionForLegacyTask(input.taskId, options)
    return this.authoritativeBranch(input, options, 'continue')
  }

  async createSideTaskAuthoritatively(input: { taskId: string; sideTaskId: string; expected_revision: number; client_operation_id: string; canonical_input: string }, options: { authorityPath: string; bridge: Pick<CoreOperationBridge, 'ensureBranch'> }): Promise<{ outcome: string; revision: number }> {
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
    try { reserved = await authority.reserve({ client_operation_id: input.client_operation_id, product_task_id: input.sideTaskId, kind: 'close', canonical_input: input.canonical_input, expected_revision: input.expected_revision }) } catch (error) {
      if ((error as Error).message !== 'AUTHORITY_CONFLICT') throw error
      return { outcome: 'conflict', revision: (await authority.read()).revision }
    }
    if (reserved.file.receipts[input.client_operation_id]) return { outcome: 'duplicate', revision: reserved.file.receipts[input.client_operation_id].revision }
    const closed = { ...side, status: 'closed' as const, closedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, result: closed }, undefined, { sideTask: closed })
    return { outcome: 'accepted', revision: final.revision }
  }

  private async authoritativeBranch(input: { taskId: string; expected_revision: number; client_operation_id: string; canonical_input: string }, options: { authorityPath: string; bridge: Pick<CoreOperationBridge, 'ensureBranch'> }, kind: string): Promise<{ outcome: string; revision: number }> {
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
    if (source?.binding?.coreSessionId) {
      const serverInput: Record<string, unknown> = { sourceSessionId: source.binding.coreSessionId, title: typeof publicInput.title === 'string' ? publicInput.title : source.task?.title ?? 'Continue task' }
      if (typeof publicInput.sourceEntryId === 'string') serverInput.targetMessageId = await this.resolveSourceTurnIdForProductEntry(source.binding.coreSessionId, publicInput.sourceEntryId)
      canonicalInput = JSON.stringify(serverInput)
    }
    let reserved
    try { reserved = await authority.reserve({ client_operation_id: input.client_operation_id, product_task_id: input.taskId, kind: 'branch', canonical_input: canonicalInput, expected_revision: input.expected_revision }) } catch (error) {
      if ((error as Error).message !== 'AUTHORITY_CONFLICT') throw error
      return { outcome: 'conflict', revision: (await authority.read()).revision }
    }
    const prior = reserved.file.receipts[input.client_operation_id]
    if (prior) return { outcome: 'duplicate', revision: prior.revision }
    let binding: unknown
    try {
      binding = await options.bridge.ensureBranch(input.client_operation_id, input.taskId, canonicalInput)
    } catch (error) {
      if (!(error instanceof CoreOperationTerminalError)) throw error
      const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'rejected', revision: reserved.file.revision, error: 'OPERATION_REJECTED' })
      return { outcome: 'rejected', revision: final.revision }
    }
    const sideTask = kind === 'side' ? (() => {
      const parsed = publicInput as { taskId?: string; sideTaskId?: string; title?: string }
      const now = new Date().toISOString()
      return { id: input.taskId, parentTaskId: parsed.taskId ?? '', taskId: input.taskId, title: parsed.title ?? '', status: 'open', createdAt: now, updatedAt: now }
    })() : undefined
    const final = await authority.finalize(input.client_operation_id, { client_operation_id: input.client_operation_id, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, ...(sideTask ? { result: sideTask } : {}) }, { id: input.taskId, kind, binding }, sideTask ? { sideTask } : {})
    return { outcome: 'accepted', revision: final.revision }
  }

  /** Authority-backed create. The legacy registry is deliberately read-only. */
  async createTaskAuthoritatively(input: CreateProductTaskInput, options: {
    authorityPath: string
    bridge: Pick<CoreOperationBridge, 'ensureCreate'>
    afterEnsure?: () => void | Promise<void>
  }): Promise<{ task: ProductTaskRecord; receipt: { outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'; revision: number } }> {
    if (!isRecord(input) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision! < 0 || typeof input.client_operation_id !== 'string' || !input.client_operation_id.trim()) throw ApiError.badRequest('expected_revision 和 client_operation_id 必填')
    if (typeof input.workDir !== 'string' || !input.workDir.trim()) throw ApiError.badRequest('workDir 必须是非空字符串')
    const title = validTitle(input.title) ?? ''
    const operationId = input.client_operation_id
    const taskId = `task_${createHash('sha256').update(operationId).digest('hex').slice(0, 16)}`
    const canonical = JSON.stringify({ workDir: input.workDir, title, permissionMode: input.permissionMode ?? 'ask', useWorktree: input.useWorktree === true })
    const authority = new ProductTaskAuthorityRepository(options.authorityPath)
    try {
      const reserved = await authority.reserve({ client_operation_id: operationId, product_task_id: taskId, kind: 'create', canonical_input: canonical, expected_revision: input.expected_revision })
      const receipt = reserved.file.receipts[operationId]
      if (receipt) return { task: authorityPublicTask(reserved.file.tasks[taskId]), receipt: { outcome: 'duplicate', revision: receipt.revision } }
      const task = { id: taskId, projectId: '', directoryId: '', workDir: input.workDir, title, lifecycle: 'active' as const, kind: 'main' as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), worktreeState: input.useWorktree ? 'planned' as const : 'not_requested' as const, actions: ['pin', 'rename', 'continue', 'archive'] as ProductTaskAction[] }
      let binding: unknown
      try {
        binding = await options.bridge.ensureCreate(operationId, taskId, canonical)
      } catch (error) {
        if (!(error instanceof CoreOperationTerminalError)) throw error
        const final = await authority.finalize(operationId, { client_operation_id: operationId, expected_revision: input.expected_revision, outcome: 'rejected', revision: reserved.file.revision, error: 'OPERATION_REJECTED' })
        return { task, receipt: { outcome: 'rejected', revision: final.revision } }
      }
      await options.afterEnsure?.()
      const final = await authority.finalize(operationId, { client_operation_id: operationId, expected_revision: input.expected_revision, outcome: 'accepted', revision: reserved.file.revision, result: task }, { task, binding })
      return { task, receipt: { outcome: 'accepted', revision: final.revision } }
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
      const reserved = await authority.reserve({ client_operation_id: input.client_operation_id, product_task_id: input.taskId, kind: 'metadata', canonical_input: canonical, expected_revision: input.expected_revision })
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
        ...(input.patch.archived !== undefined ? input.patch.archived ? { lifecycle: 'archived' as const, archivedAt: now } : { lifecycle: 'active' as const, archivedAt: undefined } : {}),
        updatedAt: now,
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
    bridge: Pick<CoreOperationBridge, 'ensureRename'>
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
      })
      const prior = reserved.file.receipts[input.client_operation_id]
      if (prior) {
        const current = await authority.read()
        const task = authorityPublicTask((current.tasks[input.taskId] as { task: ProductTaskRecord }).task)
        return { task, receipt: { outcome: 'duplicate', revision: prior.revision }, snapshot: this.authoritySnapshot(current), mirror: current.outbox[input.client_operation_id] ?? { state: 'pending' } }
      }
      const task = { ...stored.task, title, updatedAt: new Date().toISOString() }
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
    bridge: Pick<CoreOperationBridge, 'ensureRename'>
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
    if (!receipt) throw ApiError.notFound('操作不存在')
    const tasks = this.authoritySnapshot(file).tasks
    if (!tasks.some((task) => task.id === taskId || task.parentTaskId === taskId)) throw ApiError.notFound('操作不存在')
    return { receipt: { outcome: receipt.outcome, revision: receipt.revision }, authority: this.authoritySnapshot(file), ...(file.outbox[operationId] ? { mirror: file.outbox[operationId] } : {}) }
  }

  private authoritySnapshot(file: Awaited<ReturnType<ProductTaskAuthorityRepository['read']>>): { revision: number; event_sequence: number; tasks: ProductTaskRecord[]; side_tasks: ProductSideTask[] } {
    return {
      revision: file.revision,
      event_sequence: file.event_sequence,
      tasks: Object.values(file.tasks).map(authorityPublicTask),
      side_tasks: Object.values(file.side_tasks).map((sideTask) => publicSideTask(sideTask as ProductSideTaskMetadata)),
    }
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

  /**
   * Resolve the Agent Core binding inside the product application layer.
   *
   * Product clients only ever address an opaque product id. The Core session
   * binding stays in the private product store and never crosses this seam.
   */
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
      if (!getSessionMessages) {
        throw new ApiError(503, '任务记录暂不可用', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
      }
      const sessionId = (await this.requireTaskBinding(taskId)).metadata.coreSessionId
      const messages = await getSessionMessages(sessionId)
      return projectSessionTranscriptForProductTask(taskId, messages)
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
    if (archived && this.runs.hasActiveRunForSession(binding.metadata.coreSessionId)) {
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
    }
    const { store } = await this.loadRegisteredStore()
    store.tasks[metadata.id] = metadata
    await this.writeStore(store)
    return this.requireTask(metadata.id)
  }

  async listSideTasks(taskId: string): Promise<ProductSideTask[]> {
    const legacy = await this.withStoreLock(() => this.listSideTasksUnlocked(taskId))
    const authority = await new ProductTaskAuthorityRepository(this.authorityPath).read()
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

    let directory = Object.values(store.directories).find((candidate) => (
      candidate.projectId === project.id && sameProductPath(candidate.path, directoryPath)
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
    return findCanonicalGitRoot(directoryPath) ?? directoryPath
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

  private async requireTaskBinding(taskId: string): Promise<{
    task: ProductTaskRecord
    metadata: ProductTaskMetadata
  }> {
    const { store, sessions } = await this.loadRegisteredStore()
    const stored = store.tasks[taskId]
    if (stored) {
      const session = sessions.find((candidate) => candidate.id === stored.coreSessionId)
      if (!session) throw ApiError.notFound(`任务不存在：${taskId}`)
      return { task: await this.toRecord(session, stored), metadata: stored }
    }
    throw ApiError.notFound(`任务不存在：${taskId}`)
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
      title: metadata.title ?? session.title,
      lifecycle: metadata.lifecycle === 'archived' ? 'archived' : 'active',
      kind: metadata.kind === 'continuation' ? 'continuation' : 'main',
      ...(metadata.pinnedAt ? { pinnedAt: metadata.pinnedAt } : {}),
      ...(metadata.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
      ...(metadata.parentTaskId ? { parentTaskId: metadata.parentTaskId } : {}),
      createdAt: metadata.createdAt || session.createdAt,
      updatedAt: latestProductTimestamp(metadata.updatedAt, session.modifiedAt) || session.modifiedAt,
      worktreeState,
    }
    return {
      ...task,
      actions: actionsFor(task, this.runs.hasActiveRunForSession(session.id)),
    }
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

export const productTaskService = new ProductTaskService()
