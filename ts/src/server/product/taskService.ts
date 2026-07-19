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

const PRODUCT_TASK_STORE_VERSION = 3 as const

type ProductTaskStore = {
  version: typeof PRODUCT_TASK_STORE_VERSION
  tasks: Record<string, ProductTaskMetadata>
  sideTasks: Record<string, ProductSideTaskMetadata>
  /**
   * The legacy Core-session list was imported once into this product-owned
   * registry. Future Core sessions are not automatically promoted to product
   * tasks, so the product index has a single durable source of truth.
   */
  legacyCoreSessionsImportedAt?: string
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

function projectTitle(workDir: string): string {
  const base = path.basename(workDir.replace(/[\\/]+$/, ''))
  return base || workDir || '未命名项目'
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

function normalizeProductTaskStore(value: unknown): ProductTaskStore {
  if (!isRecord(value) || !isRecord(value.tasks)) {
    throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
  }

  if (value.version === PRODUCT_TASK_STORE_VERSION || value.version === 2) {
    const tasks: Record<string, ProductTaskMetadata> = {}
    const taskIdByCoreSessionId = new Map<string, string>()
    for (const [taskId, rawMetadata] of Object.entries(value.tasks)) {
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

    const sideTasks: Record<string, ProductSideTaskMetadata> = {}
    if (isRecord(value.sideTasks)) {
      for (const [sideTaskId, rawSideTask] of Object.entries(value.sideTasks)) {
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
    }
    const importedAt = value.version === PRODUCT_TASK_STORE_VERSION
      ? optionalString(value.legacyCoreSessionsImportedAt)
      : undefined
    return {
      version: PRODUCT_TASK_STORE_VERSION,
      tasks,
      sideTasks,
      ...(importedAt ? { legacyCoreSessionsImportedAt: importedAt } : {}),
    }
  }

  // Version 1 keyed metadata by Core session id and returned that id as the
  // product id. Convert it in memory to stable opaque identifiers. The next
  // product-index load imports any remaining legacy sessions and writes the
  // v3 product registry atomically.
  if (value.version === PRODUCT_DOMAIN_VERSION) {
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

    const sideTasks: Record<string, ProductSideTaskMetadata> = {}
    if (isRecord(value.sideTasks)) {
      for (const [sideTaskId, rawSideTask] of Object.entries(value.sideTasks)) {
        if (!isRecord(rawSideTask) || typeof rawSideTask.coreSessionId !== 'string' || !rawSideTask.coreSessionId) {
          continue
        }
        const parentCoreSessionId = optionalString(rawSideTask.parentTaskId)
        const sourceTurnId = optionalString(rawSideTask.sourceTurnId)
        const title = optionalString(rawSideTask.title)
        const createdAt = optionalString(rawSideTask.createdAt)
        const updatedAt = optionalString(rawSideTask.updatedAt)
        if (!parentCoreSessionId || !sourceTurnId || !title || !createdAt || !updatedAt) continue

        const taskId = legacyProductTaskId(rawSideTask.coreSessionId)
        const parentTaskId = legacyProductTaskId(parentCoreSessionId)
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
        if (!tasks[taskId]) {
          tasks[taskId] = {
            id: taskId,
            coreSessionId: rawSideTask.coreSessionId,
            title,
            lifecycle: 'active',
            kind: 'continuation',
            parentTaskId,
            sourceTurnId,
            createdAt,
            updatedAt,
            worktreeState: 'not_requested',
            visibility: 'side_task',
          }
        }
      }
    }
    return { version: PRODUCT_TASK_STORE_VERSION, tasks, sideTasks }
  }

  throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
}

function actionsFor(task: ProductTask): ProductTaskAction[] {
  if (task.lifecycle === 'archived') return ['restore', 'continue']
  return [
    task.pinnedAt ? 'unpin' : 'pin',
    'rename',
    'archive',
    'continue',
  ]
}

export class ProductTaskService {
  private readonly storagePath: string
  private readonly core: AgentCoreAdapter

  constructor(options: { storagePath?: string; core?: AgentCoreAdapter } = {}) {
    this.storagePath = options.storagePath ?? productStorePath()
    this.core = options.core ?? agentCoreAdapter
  }

  async listTasks(): Promise<ProductTaskIndexResponse> {
    let [store, sessions] = await Promise.all([this.readStore(), this.core.listSessions()])
    store = await this.importLegacyCoreSessionsOnce(store, sessions)
    const sideTaskSessionIds = new Set(
      Object.values(store.sideTasks).map((sideTask) => sideTask.coreSessionId),
    )
    const records: ProductTaskRecord[] = []
    const coreSessionIdByTaskId = new Map<string, string>()
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    for (const metadata of Object.values(store.tasks)) {
      if (sideTaskSessionIds.has(metadata.coreSessionId) || metadata.visibility === 'side_task') continue
      const session = sessionsById.get(metadata.coreSessionId)
      if (!session) continue
      const record = await this.toRecord(session, metadata)
      records.push(record)
      coreSessionIdByTaskId.set(record.id, metadata.coreSessionId)
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
      const session = sessionsById.get(coreSessionIdByTaskId.get(task.id) ?? '')
      const workDir = session?.projectRoot
        ?? session?.workDir
        ?? ''
      if (!workDir) continue

      const project = projects.get(task.projectId) ?? {
        id: task.projectId,
        title: projectTitle(workDir),
        workDir,
        taskCount: 0,
        archivedTaskCount: 0,
        updatedAt: task.updatedAt,
      }
      if (task.lifecycle === 'archived') project.archivedTaskCount += 1
      else project.taskCount += 1
      if (Date.parse(task.updatedAt) > Date.parse(project.updatedAt)) project.updatedAt = task.updatedAt
      projects.set(task.projectId, project)
    }

    return {
      schemaVersion: PRODUCT_DOMAIN_VERSION,
      projects: [...projects.values()].sort((left, right) => {
        if (activePinnedProjectIds.has(left.id) !== activePinnedProjectIds.has(right.id)) {
          return activePinnedProjectIds.has(left.id) ? -1 : 1
        }
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
      }),
      tasks: records,
      total: records.length,
      capabilities: { createTask: true },
    }
  }

  async createTask(input: CreateProductTaskInput): Promise<ProductTaskRecord> {
    if (!input || typeof input !== 'object' || typeof input.workDir !== 'string' || !input.workDir.trim()) {
      throw ApiError.badRequest('workDir 必须是非空字符串')
    }
    const title = validTitle(input.title)
    const permissionMode = productTaskPermissionMode(input.permissionMode)
    const created = await this.core.createSession({
      workDir: input.workDir.trim(),
      // Keep Core-specific values inside this adapter boundary. Product
      // clients only send the safe product-facing choices above.
      permissionMode: CORE_PERMISSION_MODE_BY_PRODUCT_MODE[permissionMode],
      useWorktree: input.useWorktree,
    })
    const now = new Date().toISOString()
    const metadata: ProductTaskMetadata = {
      id: createProductTaskId(),
      coreSessionId: created.sessionId,
      ...(title ? { title } : {}),
      lifecycle: 'active',
      kind: 'main',
      createdAt: now,
      updatedAt: now,
      worktreeState: input.useWorktree ? 'planned' : 'not_requested',
      visibility: 'main',
    }
    if (title) await this.core.renameSession(created.sessionId, title)
    const store = await this.readStore()
    store.tasks[metadata.id] = metadata
    await this.writeStore(store)
    return this.requireTask(metadata.id)
  }

  /**
   * Resolve the Agent Core binding inside the product application layer.
   *
   * Product clients only ever address an opaque product id. The Core session
   * binding stays in the private product store and never crosses this seam.
   */
  async resolveCoreSessionId(taskId: string): Promise<string> {
    return (await this.requireTaskBinding(taskId)).metadata.coreSessionId
  }

  async getTaskThread(taskId: string): Promise<ProductTaskThread> {
    const getSessionMessages = this.core.getSessionMessages
    if (!getSessionMessages) {
      throw new ApiError(503, '任务记录暂不可用', 'PRODUCT_TASK_THREAD_UNAVAILABLE')
    }
    const sessionId = await this.resolveCoreSessionId(taskId)
    const messages = await getSessionMessages(sessionId)
    return projectSessionTranscriptForProductTask(taskId, messages)
  }

  async updateTask(taskId: string, input: UpdateProductTaskInput): Promise<ProductTaskRecord> {
    const binding = await this.requireTaskBinding(taskId)
    const task = binding.task
    const title = validTitle(input.title)
    if (title) await this.core.renameSession(binding.metadata.coreSessionId, title)
    await this.updateMetadata(taskId, (metadata) => ({
      ...metadata,
      ...(title ? { title } : {}),
      ...(input.pinned === undefined ? {} : input.pinned
        ? { pinnedAt: new Date().toISOString() }
        : { pinnedAt: undefined }),
      updatedAt: new Date().toISOString(),
    }))
    return this.requireTask(taskId)
  }

  async setPinned(taskId: string, pinned: boolean): Promise<ProductTaskRecord> {
    return this.updateTask(taskId, { pinned })
  }

  async setArchived(taskId: string, archived: boolean): Promise<ProductTaskRecord> {
    await this.requireTask(taskId)
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
    if (!input || typeof input !== 'object') {
      throw ApiError.badRequest('继续任务参数必须是对象')
    }
    rejectCoreSourceTurnId(input)
    const sourceBinding = await this.requireTaskBinding(taskId)
    const source = sourceBinding.task
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
    const store = await this.readStore()
    store.tasks[metadata.id] = metadata
    await this.writeStore(store)
    return this.requireTask(metadata.id)
  }

  async listSideTasks(taskId: string): Promise<ProductSideTask[]> {
    await this.requireTask(taskId)
    const store = await this.readStore()
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
    if (!input || typeof input !== 'object') {
      throw ApiError.badRequest('侧边任务参数必须是对象')
    }
    rejectCoreSourceTurnId(input)
    const sourceBinding = await this.requireTaskBinding(taskId)
    const source = sourceBinding.task
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
    const store = await this.readStore()
    store.tasks[sideTaskTaskId] = {
      id: sideTaskTaskId,
      coreSessionId: created.sessionId,
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
    await this.requireTask(taskId)
    const store = await this.readStore()
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
    const [store, sessions] = await Promise.all([this.readStore(), this.core.listSessions()])
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
    const projectRoot = session.projectRoot ?? workDir
    const requestedWorktree = metadata.worktreeState !== 'not_requested'
    const worktreeState = requestedWorktree
      ? await this.resolveWorktreeState(session.id)
      : 'not_requested'
    const task: ProductTask = {
      id: metadata.id,
      projectId: resourceId('project', projectRoot || session.id),
      workDir,
      title: metadata.title ?? session.title,
      lifecycle: metadata.lifecycle === 'archived' ? 'archived' : 'active',
      kind: metadata.kind === 'continuation' ? 'continuation' : 'main',
      ...(metadata.pinnedAt ? { pinnedAt: metadata.pinnedAt } : {}),
      ...(metadata.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
      ...(metadata.parentTaskId ? { parentTaskId: metadata.parentTaskId } : {}),
      createdAt: metadata.createdAt || session.createdAt,
      updatedAt: metadata.updatedAt || session.modifiedAt,
      worktreeState,
    }
    return { ...task, actions: actionsFor(task) }
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
        return { version: PRODUCT_TASK_STORE_VERSION, tasks: {}, sideTasks: {} }
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
    const store = await this.readStore()
    store.tasks[taskId] = update(store.tasks[taskId] ?? binding.metadata)
    await this.writeStore(store)
  }

  private async writeStore(store: ProductTaskStore): Promise<void> {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await fs.rename(temporaryPath, this.storagePath)
  }
}

export const productTaskService = new ProductTaskService()
