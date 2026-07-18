import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PRODUCT_DOMAIN_VERSION,
  type ContinueProductTaskInput,
  type CreateProductTaskInput,
  type ProductProject,
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
  branchSession: (sessionId: string, title?: string, sourceTurnId?: string) => Promise<{
    sessionId: string
    workDir: string
  }>
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

  async branchSession(sessionId, title, sourceTurnId) {
    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    if (!launchInfo) throw ApiError.notFound(`任务不存在：${sessionId}`)

    try {
      const result = await createSessionBranch({
        sourceSessionId: sessionId,
        sourceTranscriptPath: launchInfo.filePath,
        title,
        targetMessageId: sourceTurnId,
        sourceWorkDir: launchInfo.workDir,
        sourceRepository: launchInfo.repository,
        sourceWorktreeSession: launchInfo.worktreeSession,
      })
      return {
        sessionId: result.sessionId,
        workDir: result.workDir ?? launchInfo.workDir,
      }
    } catch (error) {
      if (error instanceof SessionBranchingError) {
        throw ApiError.badRequest(error.message)
      }
      throw error
    }
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
    const records = sessions.map((session) => this.toRecord(session, store.tasks[session.id]))
      .sort((left, right) => {
        if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      })

    const projects = new Map<string, ProductProject>()
    const sessionById = new Map(sessions.map((session) => [session.id, session]))

    for (const task of records) {
      const session = sessionById.get(task.id)
      const workDir = session?.workDir
        ?? session?.projectRoot
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
    const source = await this.requireTask(taskId)
    const title = validTitle(input.title) ?? `继续：${source.title}`
    const created = await this.core.branchSession(source.coreSessionId, title, input.sourceTurnId)
    const now = new Date().toISOString()
    await this.updateMetadata(created.sessionId, () => ({
      id: created.sessionId,
      title,
      lifecycle: 'active',
      kind: 'continuation',
      parentTaskId: source.id,
      parentThreadId: source.coreSessionId,
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {}),
      createdAt: now,
      updatedAt: now,
      worktreeState: 'not_requested',
    }))
    return this.requireTask(created.sessionId)
  }

  private async requireTask(taskId: string): Promise<ProductTaskRecord> {
    const index = await this.listTasks()
    const task = index.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw ApiError.notFound(`任务不存在：${taskId}`)
    return task
  }

  private toRecord(session: AgentCoreSession, saved: ProductTaskMetadata | undefined): ProductTaskRecord {
    const metadata = saved ?? defaultMetadata(session)
    const workDir = session.workDir ?? session.projectRoot ?? ''
    const projectId = resourceId('project', workDir || session.id)
    const task: ProductTask = {
      id: session.id,
      projectId,
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
      worktreeState: metadata.worktreeState === 'planned' ? 'planned' : 'not_requested',
    }
    return { ...task, actions: actionsFor(task) }
  }

  private async readStore(): Promise<ProductTaskStore> {
    try {
      const raw = await fs.readFile(this.storagePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<ProductTaskStore>
      if (parsed.version !== PRODUCT_DOMAIN_VERSION || !parsed.tasks || typeof parsed.tasks !== 'object') {
        throw new Error('invalid product task store')
      }
      return { version: PRODUCT_DOMAIN_VERSION, tasks: parsed.tasks }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: PRODUCT_DOMAIN_VERSION, tasks: {} }
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
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await fs.rename(temporaryPath, this.storagePath)
  }
}

export const productTaskService = new ProductTaskService()
