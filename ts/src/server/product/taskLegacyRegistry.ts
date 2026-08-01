import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ProductContinuationTarget } from '../../../shared/product/domain.js'
import { ApiError } from '../middleware/errorHandler.js'
import { legacyProductTaskId, normalizeProductTaskStore } from './legacyProductTaskReader.js'
import {
  PRODUCT_TASK_STORE_VERSION,
  type ProductProjectDirectoryMetadata,
  type ProductProjectMetadata,
  type ProductTaskMetadata,
  type ProductTaskStore,
} from './taskLegacyStore.js'
import { findProductCanonicalGitRoot } from './productGit.js'
import type { ProductLegacyCoreMessageEntry } from './taskThreadProjection.js'

/**
 * Private legacy-Core contract retained solely to import historical tasks.
 * New Agent runs are created through the Authority ledger and never call it.
 */
export type AgentCoreSession = {
  id: string
  title?: string
  createdAt: string
  modifiedAt: string
  projectRoot?: string
  workDir?: string
}

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
  getSessionMessages?: (sessionId: string) => Promise<ProductLegacyCoreMessageEntry[]>
}

const nativeCoreWorkDirs = new Map<string, string>()

/** Fallback only; production runs use the private Worker/Harness bridge. */
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
}

export type ProductTaskLegacyRegistrySnapshot = {
  taskIds: string[]
  sideTasks: ProductTaskStore['sideTasks']
  projects: ProductTaskStore['projects']
  directories: ProductTaskStore['directories']
}

type ProductDirectoryBinding = {
  project: ProductProjectMetadata
  directory: ProductProjectDirectoryMetadata
}

type RegisteredProductDirectory = ProductDirectoryBinding & {
  changed: boolean
}

function resourceId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
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

/**
 * One-way reader/writer for retired task storage. It deliberately has no
 * Authority, Worker, renderer, or runtime-event dependency.
 */
export class ProductTaskLegacyRegistry {
  private static readonly storeLocks = new Map<string, Promise<void>>()

  constructor(
    private readonly storagePath: string,
    private readonly core: AgentCoreAdapter,
  ) {}

  /**
   * Normalize and materialize supported historical records once before they
   * are projected into the current Authority ledger.
   */
  async materializeSupportedStore(): Promise<ProductTaskLegacyRegistrySnapshot> {
    return await this.withStoreLock(async () => {
      const exists = await fs.access(this.storagePath).then(() => true, () => false)
      if (!exists) return { taskIds: [], sideTasks: {}, projects: {}, directories: {} }
      const { store } = await this.loadRegisteredStore()
      await this.writeStore(store)
      return {
        taskIds: Object.keys(store.tasks).sort(),
        sideTasks: structuredClone(store.sideTasks),
        projects: structuredClone(store.projects),
        directories: structuredClone(store.directories),
      }
    })
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.storagePath)
    const previous = ProductTaskLegacyRegistry.storeLocks.get(key) ?? Promise.resolve()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => gate)
    ProductTaskLegacyRegistry.storeLocks.set(key, queued)

    await previous
    try {
      return await operation()
    } finally {
      release?.()
      if (ProductTaskLegacyRegistry.storeLocks.get(key) === queued) {
        ProductTaskLegacyRegistry.storeLocks.delete(key)
      }
    }
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
   * project/directory identities once the registered Core session is visible.
   */
  private async ensureProjectStructure(
    store: ProductTaskStore,
    sessions: readonly AgentCoreSession[],
  ): Promise<ProductTaskStore> {
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    let changed = false

    for (const metadata of Object.values(store.tasks)) {
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

  /** Move the legacy Core list into product-owned task metadata once. */
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

  private async writeStore(store: ProductTaskStore): Promise<void> {
    await fs.mkdir(path.dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await fs.rename(temporaryPath, this.storagePath)
  }
}
