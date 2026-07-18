import { createHash, randomUUID, type UUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PRODUCT_DOMAIN_VERSION,
  type ContinueProductTaskInput,
  type CreateProductTaskInput,
  type CreateProductSideTaskInput,
  type ProductContinuationTarget,
  type ProductProject,
  type ProductSideTask,
  type ProductTask,
  type ProductTaskIndex,
  type UpdateProductTaskInput,
} from '../../../shared/product/domain.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  sessionService,
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
  title?: string
  lifecycle: ProductTask['lifecycle']
  kind: ProductTask['kind']
  pinnedAt?: string
  archivedAt?: string
  parentTaskId?: string
  parentThreadId?: string
  sourceTurnId?: string
  createdAt: string
  updatedAt: string
  worktreeState: ProductTask['worktreeState']
}

type ProductTaskStore = {
  version: typeof PRODUCT_DOMAIN_VERSION
  tasks: Record<string, ProductTaskMetadata>
  sideTasks: Record<string, ProductSideTask>
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
}

function productStorePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'billiardbuddy', 'product-tasks.json')
}

function resourceId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
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

function continuationTarget(value: unknown): ProductContinuationTarget {
  if (value === undefined) return 'current_workspace'
  if (value === 'current_workspace' || value === 'new_worktree') return value
  throw ApiError.badRequest('target 必须是 current_workspace 或 new_worktree')
}

function requiredSourceTurnId(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('sourceTurnId 必须是字符串')
  const sourceTurnId = value.trim()
  if (!sourceTurnId) throw ApiError.badRequest('sourceTurnId 不能为空')
  return sourceTurnId
}

function defaultMetadata(session: AgentCoreSession): ProductTaskMetadata {
  return {
    id: session.id,
    lifecycle: 'active',
    kind: 'main',
    createdAt: session.createdAt,
    updatedAt: session.modifiedAt,
    worktreeState: 'not_requested',
  }
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
    const [store, sessions] = await Promise.all([this.readStore(), this.core.listSessions()])
    const sideTaskSessionIds = new Set(
      Object.values(store.sideTasks).map((sideTask) => sideTask.coreSessionId),
    )
    const records: ProductTaskRecord[] = []
    for (const session of sessions) {
      if (sideTaskSessionIds.has(session.id)) continue
      records.push(await this.toRecord(session, store.tasks[session.id]))
    }
    records.sort((left, right) => {
      if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    })

    const projects = new Map<string, ProductProject>()
    const sessionById = new Map(sessions.map((session) => [session.id, session]))

    for (const task of records) {
      const session = sessionById.get(task.id)
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
      projects: [...projects.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      tasks: records,
      total: records.length,
      capabilities: { createTask: true },
    }
  }

  async createTask(input: CreateProductTaskInput): Promise<ProductTaskRecord> {
    if (!input || typeof input.workDir !== 'string' || !input.workDir.trim()) {
      throw ApiError.badRequest('workDir 必须是非空字符串')
    }
    const title = validTitle(input.title)
    const created = await this.core.createSession({
      workDir: input.workDir.trim(),
      permissionMode: input.permissionMode,
      useWorktree: input.useWorktree,
    })
    const now = new Date().toISOString()
    const metadata: ProductTaskMetadata = {
      id: created.sessionId,
      ...(title ? { title } : {}),
      lifecycle: 'active',
      kind: 'main',
      createdAt: now,
      updatedAt: now,
      worktreeState: input.useWorktree ? 'planned' : 'not_requested',
    }
    if (title) await this.core.renameSession(created.sessionId, title)
    await this.updateMetadata(created.sessionId, () => metadata)
    return this.requireTask(created.sessionId)
  }

  async updateTask(taskId: string, input: UpdateProductTaskInput): Promise<ProductTaskRecord> {
    const task = await this.requireTask(taskId)
    const title = validTitle(input.title)
    if (title) await this.core.renameSession(task.coreSessionId, title)
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
    const source = await this.requireTask(taskId)
    const requestedTitle = validTitle(input.title) ?? `继续：${source.title}`
    const target = continuationTarget(input.target)
    const created = await this.core.branchSession(
      source.coreSessionId,
      requestedTitle,
      input.sourceTurnId,
      target,
    )
    const now = new Date().toISOString()
    await this.updateMetadata(created.sessionId, () => ({
      id: created.sessionId,
      title: created.title,
      lifecycle: 'active',
      kind: 'continuation',
      parentTaskId: source.id,
      parentThreadId: source.coreSessionId,
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      createdAt: now,
      updatedAt: now,
      worktreeState: target === 'new_worktree'
        ? 'materialized'
        : source.worktreeState,
    }))
    return this.requireTask(created.sessionId)
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
  }

  async createSideTask(
    taskId: string,
    input: CreateProductSideTaskInput,
  ): Promise<ProductSideTask> {
    if (!input || typeof input !== 'object') {
      throw ApiError.badRequest('侧边任务参数必须是对象')
    }
    const source = await this.requireTask(taskId)
    const sourceTurnId = requiredSourceTurnId(input.sourceTurnId)
    const requestedTitle = validTitle(input.title) ?? `侧边任务：${source.title}`
    const created = await this.core.branchSession(
      source.coreSessionId,
      requestedTitle,
      sourceTurnId,
    )
    const now = new Date().toISOString()
    const sideTask: ProductSideTask = {
      id: resourceId('side_task', created.sessionId),
      parentTaskId: source.id,
      sourceTurnId,
      coreSessionId: created.sessionId,
      title: created.title,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    const store = await this.readStore()
    store.sideTasks[sideTask.id] = sideTask
    await this.writeStore(store)
    return sideTask
  }

  async closeSideTask(taskId: string, sideTaskId: string): Promise<ProductSideTask> {
    await this.requireTask(taskId)
    const store = await this.readStore()
    const sideTask = store.sideTasks[sideTaskId]
    if (!sideTask || sideTask.parentTaskId !== taskId) {
      throw ApiError.notFound(`侧边任务不存在：${sideTaskId}`)
    }
    if (sideTask.status === 'closed') return sideTask

    const now = new Date().toISOString()
    const closed: ProductSideTask = {
      ...sideTask,
      status: 'closed',
      closedAt: now,
      updatedAt: now,
    }
    store.sideTasks[sideTaskId] = closed
    await this.writeStore(store)
    return closed
  }

  private async requireTask(taskId: string): Promise<ProductTaskRecord> {
    const index = await this.listTasks()
    const task = index.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw ApiError.notFound(`任务不存在：${taskId}`)
    return task
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
      id: session.id,
      projectId: resourceId('project', projectRoot || session.id),
      workDir,
      title: metadata.title ?? session.title,
      coreSessionId: session.id,
      lifecycle: metadata.lifecycle === 'archived' ? 'archived' : 'active',
      kind: metadata.kind === 'continuation' ? 'continuation' : 'main',
      ...(metadata.pinnedAt ? { pinnedAt: metadata.pinnedAt } : {}),
      ...(metadata.archivedAt ? { archivedAt: metadata.archivedAt } : {}),
      ...(metadata.parentTaskId ? { parentTaskId: metadata.parentTaskId } : {}),
      ...(metadata.parentThreadId ? { parentThreadId: metadata.parentThreadId } : {}),
      ...(metadata.sourceTurnId ? { sourceTurnId: metadata.sourceTurnId } : {}),
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
      const parsed = JSON.parse(raw) as Partial<ProductTaskStore>
      if (parsed.version !== PRODUCT_DOMAIN_VERSION || !parsed.tasks || typeof parsed.tasks !== 'object') {
        throw new Error('invalid product task store')
      }
      return {
        version: PRODUCT_DOMAIN_VERSION,
        tasks: parsed.tasks,
        sideTasks: parsed.sideTasks && typeof parsed.sideTasks === 'object' && !Array.isArray(parsed.sideTasks)
          ? parsed.sideTasks
          : {},
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: PRODUCT_DOMAIN_VERSION, tasks: {}, sideTasks: {} }
      }
      throw new ApiError(500, '无法读取产品任务数据', 'PRODUCT_TASK_STORE_ERROR')
    }
  }

  private async updateMetadata(
    taskId: string,
    update: (current: ProductTaskMetadata) => ProductTaskMetadata,
  ): Promise<void> {
    const store = await this.readStore()
    const sessions = await this.core.listSessions()
    const session = sessions.find((candidate) => candidate.id === taskId)
    if (!session) throw ApiError.notFound(`任务不存在：${taskId}`)
    store.tasks[taskId] = update(store.tasks[taskId] ?? defaultMetadata(session))
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
