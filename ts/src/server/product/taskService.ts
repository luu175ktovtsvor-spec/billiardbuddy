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

type ProductTaskMetadata = {
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

type ProductSideTaskMetadata = ProductSideTask & {
  /** Private Agent Core binding for the temporary branch. */
  coreSessionId: string
  /** Private Core turn selected by the product-thread entry. */
  sourceTurnId: string
}

type ProductProjectMetadata = Pick<
  ProductProject,
  'id' | 'title' | 'rootDir' | 'createdAt' | 'updatedAt'
>

type ProductProjectDirectoryMetadata = ProductProjectDirectory

const PRODUCT_TASK_STORE_VERSION = 4 as const
// Keep persisted v1 task metadata readable even when the public product
// response schema advances independently.
const LEGACY_PRODUCT_TASK_STORE_VERSION = 1 as const
const DEFAULT_PRODUCT_GIT_INFO_COMMAND_TIMEOUT_MS = 3_000
const MAX_RECENT_PRODUCT_PROJECTS = 500

type ProductTaskStore = {
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

function resourceId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function legacyProductTaskId(coreSessionId: string): string {
  // Old product metadata was keyed by the Core session id. Keep old tasks
  // addressable without ever returning that id to a product renderer.
  return resourceId('task', coreSessionId)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Core transcript activity is the authoritative recency signal for a task.
 * Product metadata can also move independently for lifecycle actions, so keep
 * whichever valid timestamp is newer instead of letting the first stored
 * value permanently mask later Core work.
 */
function latestProductTimestamp(...values: Array<string | undefined>): string {
  let latest = ''
  let latestTime = Number.NEGATIVE_INFINITY

  for (const value of values) {
    if (!value) continue
    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
      if (!latest) latest = value
      continue
    }
    if (timestamp > latestTime) {
      latest = value
      latestTime = timestamp
    }
  }

  return latest
}

function storedLifecycle(value: unknown): ProductTask['lifecycle'] {
  return value === 'archived' ? 'archived' : 'active'
}

function storedKind(value: unknown): ProductTask['kind'] {
  return value === 'continuation' ? 'continuation' : 'main'
}

function storedWorktreeState(value: unknown): ProductTask['worktreeState'] {
  return value === 'planned' || value === 'materialized' ? value : 'not_requested'
}

function normalizeMetadata(
  value: unknown,
  fallback: { id: string; coreSessionId: string },
): ProductTaskMetadata {
  const record = isRecord(value) ? value : {}
  return {
    id: fallback.id,
    coreSessionId: fallback.coreSessionId,
    ...(optionalString(record.projectId) ? { projectId: optionalString(record.projectId) } : {}),
    ...(optionalString(record.directoryId) ? { directoryId: optionalString(record.directoryId) } : {}),
    ...(optionalString(record.title) ? { title: optionalString(record.title) } : {}),
    lifecycle: storedLifecycle(record.lifecycle),
    kind: storedKind(record.kind),
    ...(optionalString(record.pinnedAt) ? { pinnedAt: optionalString(record.pinnedAt) } : {}),
    ...(optionalString(record.archivedAt) ? { archivedAt: optionalString(record.archivedAt) } : {}),
    ...(optionalString(record.parentTaskId) ? { parentTaskId: optionalString(record.parentTaskId) } : {}),
    ...(optionalString(record.sourceTurnId) ? { sourceTurnId: optionalString(record.sourceTurnId) } : {}),
    createdAt: optionalString(record.createdAt) ?? new Date(0).toISOString(),
    updatedAt: optionalString(record.updatedAt) ?? new Date(0).toISOString(),
    worktreeState: storedWorktreeState(record.worktreeState),
    ...(record.visibility === 'side_task' ? { visibility: 'side_task' as const } : { visibility: 'main' as const }),
  }
}

function normalizeSideTasks(value: unknown): Record<string, ProductSideTaskMetadata> {
  const sideTasks: Record<string, ProductSideTaskMetadata> = {}
  if (!isRecord(value)) return sideTasks

  for (const [sideTaskId, rawSideTask] of Object.entries(value)) {
    if (!isRecord(rawSideTask) || typeof rawSideTask.coreSessionId !== 'string' || !rawSideTask.coreSessionId) {
      continue
    }
    const taskId = typeof rawSideTask.taskId === 'string' && rawSideTask.taskId
      ? rawSideTask.taskId
      : legacyProductTaskId(rawSideTask.coreSessionId)
    const parentTaskId = optionalString(rawSideTask.parentTaskId)
    const sourceTurnId = optionalString(rawSideTask.sourceTurnId)
    const title = optionalString(rawSideTask.title)
    const createdAt = optionalString(rawSideTask.createdAt)
    const updatedAt = optionalString(rawSideTask.updatedAt)
    if (!parentTaskId || !sourceTurnId || !title || !createdAt || !updatedAt) continue
    sideTasks[sideTaskId] = {
      id: sideTaskId,
      parentTaskId,
      taskId,
      sourceTurnId,
      coreSessionId: rawSideTask.coreSessionId,
      title,
      status: rawSideTask.status === 'closed' ? 'closed' : 'open',
      createdAt,
      updatedAt,
      ...(optionalString(rawSideTask.closedAt) ? { closedAt: optionalString(rawSideTask.closedAt) } : {}),
    }
  }
  return sideTasks
}

function normalizeLegacyV1SideTasks(value: unknown): Record<string, ProductSideTaskMetadata> {
  const sideTasks: Record<string, ProductSideTaskMetadata> = {}
  if (!isRecord(value)) return sideTasks

  for (const [sideTaskId, rawSideTask] of Object.entries(value)) {
    if (!isRecord(rawSideTask) || typeof rawSideTask.coreSessionId !== 'string' || !rawSideTask.coreSessionId) {
      continue
    }
    const parentCoreSessionId = optionalString(rawSideTask.parentTaskId)
    const sourceTurnId = optionalString(rawSideTask.sourceTurnId)
    const title = optionalString(rawSideTask.title)
    const createdAt = optionalString(rawSideTask.createdAt)
    const updatedAt = optionalString(rawSideTask.updatedAt)
    if (!parentCoreSessionId || !sourceTurnId || !title || !createdAt || !updatedAt) continue
    sideTasks[sideTaskId] = {
      id: sideTaskId,
      parentTaskId: legacyProductTaskId(parentCoreSessionId),
      taskId: legacyProductTaskId(rawSideTask.coreSessionId),
      sourceTurnId,
      coreSessionId: rawSideTask.coreSessionId,
      title,
      status: rawSideTask.status === 'closed' ? 'closed' : 'open',
      createdAt,
      updatedAt,
      ...(optionalString(rawSideTask.closedAt) ? { closedAt: optionalString(rawSideTask.closedAt) } : {}),
    }
  }
  return sideTasks
}

function normalizeProjects(value: unknown): Record<string, ProductProjectMetadata> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  const projects: Record<string, ProductProjectMetadata> = {}
  for (const [projectId, rawProject] of Object.entries(value)) {
    if (!isRecord(rawProject)) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    const rootDir = optionalString(rawProject.rootDir)?.trim()
    if (!projectId || !rootDir) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    projects[projectId] = {
      id: projectId,
      title: optionalString(rawProject.title)?.trim() || projectTitle(rootDir),
      rootDir,
      createdAt: optionalString(rawProject.createdAt) ?? new Date(0).toISOString(),
      updatedAt: optionalString(rawProject.updatedAt) ?? new Date(0).toISOString(),
    }
  }
  return projects
}

function normalizeDirectories(value: unknown): Record<string, ProductProjectDirectoryMetadata> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  const directories: Record<string, ProductProjectDirectoryMetadata> = {}
  for (const [directoryId, rawDirectory] of Object.entries(value)) {
    if (!isRecord(rawDirectory)) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    const projectId = optionalString(rawDirectory.projectId)?.trim()
    const directoryPath = optionalString(rawDirectory.path)?.trim()
    if (!directoryId || !projectId || !directoryPath) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    directories[directoryId] = {
      id: directoryId,
      projectId,
      path: directoryPath,
      label: optionalString(rawDirectory.label)?.trim() || path.basename(directoryPath) || directoryPath,
      createdAt: optionalString(rawDirectory.createdAt) ?? new Date(0).toISOString(),
      updatedAt: optionalString(rawDirectory.updatedAt) ?? new Date(0).toISOString(),
    }
  }
  return directories
}

function normalizeModernTaskStore(value: Record<string, unknown>): ProductTaskStore {
  const tasks: Record<string, ProductTaskMetadata> = {}
  const taskIdByCoreSessionId = new Map<string, string>()
  const rawTasks = value.tasks
  if (!isRecord(rawTasks)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  for (const [taskId, rawMetadata] of Object.entries(rawTasks)) {
    if (!isRecord(rawMetadata) || typeof rawMetadata.coreSessionId !== 'string' || !rawMetadata.coreSessionId) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    const existingTaskId = taskIdByCoreSessionId.get(rawMetadata.coreSessionId)
    if (existingTaskId && existingTaskId !== taskId) {
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
    taskIdByCoreSessionId.set(rawMetadata.coreSessionId, taskId)
    tasks[taskId] = normalizeMetadata(rawMetadata, {
      id: taskId,
      coreSessionId: rawMetadata.coreSessionId,
    })
  }

  return {
    version: PRODUCT_TASK_STORE_VERSION,
    projects: normalizeProjects(value.projects),
    directories: normalizeDirectories(value.directories),
    tasks,
    sideTasks: normalizeSideTasks(value.sideTasks),
    ...(optionalString(value.legacyCoreSessionsImportedAt)
      ? { legacyCoreSessionsImportedAt: optionalString(value.legacyCoreSessionsImportedAt) }
      : {}),
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
  private readonly core: AgentCoreAdapter
  private readonly runs: ProductTaskRunInspector

  constructor(options: {
    storagePath?: string
    core?: AgentCoreAdapter
    runs?: ProductTaskRunInspector
  } = {}) {
    this.storagePath = options.storagePath ?? productStorePath()
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
    return this.withStoreLock(() => this.listTasksUnlocked())
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
    return this.withStoreLock(async () => (await this.requireTaskBinding(taskId)).metadata.coreSessionId)
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
    return this.withStoreLock(() => this.listSideTasksUnlocked(taskId))
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
