import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  imageWorkbenchProjectSchema,
  mediaDeletionReceiptSchema,
  mediaTaskSchema,
  type ImageWorkbenchProject,
  type MediaDeletionReceipt,
  type MediaOwner,
  type MediaTask,
} from '../../../shared/contracts/media.js'
import { lock } from '../../utils/lockfile.js'

const IMAGE_ID = /^[a-z0-9][a-z0-9_-]{7,79}$/
const MAX_EVENTS_PER_PROJECT = 2_000

export type ImageOperation = MediaTask & {
  kind: 'image.generate'
  image_operation: NonNullable<MediaTask['image_operation']>
}

export type ImageOperationEvent = {
  schema_version: 1
  cursor: number
  project_id: string
  operation_id: string
  status_sequence: number
  occurred_at: string
  operation: ImageOperation
}

export type ImageOperationEventJournal = {
  schema_version: 1
  next_cursor: number
  events: ImageOperationEvent[]
}

export class ImageWorkbenchRepositoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'IMAGE_PROJECT_NOT_FOUND' | 'IMAGE_OPERATION_NOT_FOUND' | 'IMAGE_STORAGE_INVALID' | 'IMAGE_WRITER_FENCE_CONFLICT',
  ) {
    super(message)
    this.name = 'ImageWorkbenchRepositoryError'
  }
}

function canonicalImageOperation(value: unknown): ImageOperation {
  const operation = mediaTaskSchema.parse(value)
  if (operation.kind !== 'image.generate' || !operation.image_operation) {
    throw new ImageWorkbenchRepositoryError('图片操作记录类型无效', 500, 'IMAGE_STORAGE_INVALID')
  }
  return operation as ImageOperation
}

function foundationId(prefix: 'op', ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

/**
 * The image domain owns its files from this boundary downward.  It does not
 * read MediaProject, video tasks, or any FFmpeg queue state.  Gateway/Relay
 * receipts are persisted as image operations before a candidate can become a
 * project version.
 */
export class ImageWorkbenchRepository {
  private readonly root: string
  private readonly projectsDir: string
  private readonly operationsDir: string
  private readonly eventsDir: string
  private readonly assetsDir: string
  private readonly exportsDir: string
  private readonly deletionsDir: string
  private readonly trashDir: string
  private readonly locksDir: string
  private readonly now: () => Date
  private readonly eventWaiters = new Map<string, Set<() => void>>()

  constructor(options: { root?: string; now?: () => Date } = {}) {
    this.root = options.root
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'images')
    this.projectsDir = join(this.root, 'projects')
    this.operationsDir = join(this.root, 'operations')
    this.eventsDir = join(this.root, 'events')
    this.assetsDir = join(this.root, 'assets')
    this.exportsDir = join(this.root, 'exports')
    this.deletionsDir = join(this.root, 'deletions')
    this.trashDir = join(this.root, 'trash')
    this.locksDir = join(this.root, 'locks')
    this.now = options.now ?? (() => new Date())
  }

  paths(): Readonly<{ root: string; projects: string; operations: string; events: string; assets: string; exports: string }> {
    return {
      root: this.root,
      projects: this.projectsDir,
      operations: this.operationsDir,
      events: this.eventsDir,
      assets: this.assetsDir,
      exports: this.exportsDir,
    }
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private assertId(value: string, error: 'IMAGE_PROJECT_NOT_FOUND' | 'IMAGE_OPERATION_NOT_FOUND'): void {
    if (!IMAGE_ID.test(value)) throw new ImageWorkbenchRepositoryError('图片记录 ID 无效', 400, error)
  }

  private projectPath(projectId: string): string {
    this.assertId(projectId, 'IMAGE_PROJECT_NOT_FOUND')
    return join(this.projectsDir, `${projectId}.json`)
  }

  private operationPath(operationId: string): string {
    this.assertId(operationId, 'IMAGE_OPERATION_NOT_FOUND')
    return join(this.operationsDir, `${operationId}.json`)
  }

  private eventPath(projectId: string): string {
    this.assertId(projectId, 'IMAGE_PROJECT_NOT_FOUND')
    return join(this.eventsDir, `${projectId}.json`)
  }

  private deletionPath(deletionId: string): string {
    this.assertId(deletionId, 'IMAGE_PROJECT_NOT_FOUND')
    return join(this.deletionsDir, `${deletionId}.json`)
  }

  private trashPath(trashKey: string): string {
    this.assertId(trashKey, 'IMAGE_PROJECT_NOT_FOUND')
    return join(this.trashDir, trashKey)
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.projectsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.operationsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.eventsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.assetsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.exportsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.deletionsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.trashDir, { recursive: true, mode: 0o700 }),
      mkdir(this.locksDir, { recursive: true, mode: 0o700 }),
    ])
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${randomUUID()}`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  private async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.ensureDirs()
    const guard = join(this.locksDir, `${name}.guard`)
    await writeFile(guard, '', { flag: 'a', mode: 0o600 })
    const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
    try {
      return await action()
    } finally {
      await release()
    }
  }

  private async readProjectOrNull(projectId: string): Promise<ImageWorkbenchProject | null> {
    const raw = await readFile(this.projectPath(projectId), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return null
    try {
      return imageWorkbenchProjectSchema.parse(JSON.parse(raw))
    } catch {
      throw new ImageWorkbenchRepositoryError('图片项目存储损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  async listProjects(owner?: MediaOwner): Promise<ImageWorkbenchProject[]> {
    await this.ensureDirs()
    const names = await readdir(this.projectsDir).catch(() => [])
    const projects = await Promise.all(names
      .filter(name => name.endsWith('.json'))
      .map(name => this.readProjectOrNull(name.slice(0, -'.json'.length))))
    return projects
      .filter((project): project is ImageWorkbenchProject => project !== null)
      .filter(project => !owner || (project.owner.kind === owner.kind && project.owner.owner_id === owner.owner_id))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  async getProject(projectId: string): Promise<ImageWorkbenchProject> {
    const project = await this.readProjectOrNull(projectId)
    if (!project) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
    return project
  }

  async saveProject(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    const input = imageWorkbenchProjectSchema.parse(project)
    return await this.withLock(`project-${input.id}`, async () => {
      const current = await this.readProjectOrNull(input.id)
      if (current && current.writer_fence !== input.writer_fence) {
        throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_WRITER_FENCE_CONFLICT')
      }
      if (!current && input.writer_fence !== `fence_${'0'.repeat(32)}`) {
        throw new ImageWorkbenchRepositoryError('图片项目创建凭据无效', 409, 'IMAGE_WRITER_FENCE_CONFLICT')
      }
      const next = imageWorkbenchProjectSchema.parse({
        ...input,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      await this.writeJson(this.projectPath(next.id), next)
      return next
    })
  }

  async getOperation(operationId: string): Promise<ImageOperation> {
    const raw = await readFile(this.operationPath(operationId), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (raw === null) throw new ImageWorkbenchRepositoryError('图片操作不存在', 404, 'IMAGE_OPERATION_NOT_FOUND')
    try {
      return canonicalImageOperation(JSON.parse(raw))
    } catch (error) {
      if (error instanceof ImageWorkbenchRepositoryError) throw error
      throw new ImageWorkbenchRepositoryError('图片操作存储损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  async listOperations(projectId?: string): Promise<ImageOperation[]> {
    await this.ensureDirs()
    const names = await readdir(this.operationsDir).catch(() => [])
    const operations = await Promise.all(names
      .filter(name => name.endsWith('.json'))
      .map(name => this.getOperation(name.slice(0, -'.json'.length))))
    return operations
      .filter(operation => !projectId || operation.project_id === projectId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  private async readJournal(projectId: string): Promise<ImageOperationEventJournal> {
    const raw = await readFile(this.eventPath(projectId), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return { schema_version: 1, next_cursor: 1, events: [] }
    try {
      const value = JSON.parse(raw) as ImageOperationEventJournal
      if (value.schema_version !== 1 || !Number.isSafeInteger(value.next_cursor) || value.next_cursor < 1 || !Array.isArray(value.events)) throw new Error('invalid')
      for (const event of value.events) {
        if (event.schema_version !== 1 || !Number.isSafeInteger(event.cursor) || event.cursor < 1 || !event.operation_id || event.project_id !== projectId) throw new Error('invalid')
        canonicalImageOperation(event.operation)
      }
      return value
    } catch {
      throw new ImageWorkbenchRepositoryError('图片操作日志损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  private projection(operation: ImageOperation): string {
    return JSON.stringify({
      operation_id: operation.operation_id,
      status: operation.status,
      progress: operation.progress,
      stage: operation.stage,
      remote_task_id: operation.remote_task_id,
      outcome_unknown: operation.outcome_unknown,
      provider_receipt_hash: operation.provider_receipt_hash,
      remote_result_acknowledged_at: operation.remote_result_acknowledged_at,
      result: operation.result,
      error: operation.error,
      error_code: operation.error_code,
    })
  }

  async saveOperation(operation: ImageOperation): Promise<ImageOperation> {
    const input = canonicalImageOperation(operation)
    return await this.withLock(`events-${input.project_id}`, async () => {
      const project = await this.getProject(input.project_id)
      const previous = await readFile(this.operationPath(input.id), 'utf8')
        .then(raw => canonicalImageOperation(JSON.parse(raw)))
        .catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
      const operationId = input.operation_id ?? previous?.operation_id ?? foundationId('op', input.project_id, input.idempotency_key ?? input.id)
      const candidate = canonicalImageOperation({
        ...input,
        owner: input.owner ?? previous?.owner ?? project.owner,
        operation_id: operationId,
        status_sequence: this.projection(input) === (previous ? this.projection(previous) : '')
          ? previous?.status_sequence ?? input.status_sequence
          : (previous?.status_sequence ?? 0) + 1,
        updated_at: this.iso(),
      })
      await this.writeJson(this.operationPath(candidate.id), candidate)
      if (!previous || this.projection(candidate) !== this.projection(previous)) {
        const journal = await this.readJournal(candidate.project_id)
        const event: ImageOperationEvent = {
          schema_version: 1,
          cursor: journal.next_cursor,
          project_id: candidate.project_id,
          operation_id: operationId,
          status_sequence: candidate.status_sequence,
          occurred_at: candidate.updated_at,
          operation: candidate,
        }
        await this.writeJson(this.eventPath(candidate.project_id), {
          schema_version: 1,
          next_cursor: event.cursor + 1,
          events: [...journal.events, event].slice(-MAX_EVENTS_PER_PROJECT),
        } satisfies ImageOperationEventJournal)
        for (const notify of this.eventWaiters.get(candidate.project_id) ?? []) notify()
      }
      return candidate
    })
  }

  async listOperationEvents(projectId: string, after = 0, limit = 200): Promise<{ events: ImageOperationEvent[]; cursor: number; reset_required: boolean }> {
    const journal = await this.readJournal(projectId)
    const first = journal.events[0]?.cursor ?? journal.next_cursor
    if (after < first - 1) return { events: [], cursor: journal.next_cursor - 1, reset_required: true }
    const events = journal.events.filter(event => event.cursor > after).slice(0, Math.max(1, Math.min(200, limit)))
    return { events, cursor: events.at(-1)?.cursor ?? after, reset_required: false }
  }

  async waitForOperationEvent(projectId: string, after: number, timeoutMs = 25_000): Promise<void> {
    const current = await this.listOperationEvents(projectId, after, 1)
    if (current.reset_required || current.events.length > 0) return
    await new Promise<void>(resolve => {
      const waiters = this.eventWaiters.get(projectId) ?? new Set<() => void>()
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        if (waiters.size === 0) this.eventWaiters.delete(projectId)
        resolve()
      }
      const timer = setTimeout(done, Math.max(1, Math.min(30_000, timeoutMs)))
      waiters.add(done)
      this.eventWaiters.set(projectId, waiters)
    })
  }

  private async exists(path: string): Promise<boolean> {
    return await stat(path).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
  }

  private async moveIfPresent(source: string, target: string): Promise<void> {
    if (!(await this.exists(source))) return
    if (await this.exists(target)) {
      throw new ImageWorkbenchRepositoryError('图片回收区存在冲突记录', 409, 'IMAGE_STORAGE_INVALID')
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(source, target)
  }

  private async managedAssetUsage(projectId: string): Promise<{ count: number; bytes: number }> {
    const root = join(this.assetsDir, projectId)
    const walk = async (directory: string): Promise<{ count: number; bytes: number }> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      let count = 0
      let bytes = 0
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          const nested = await walk(path)
          count += nested.count
          bytes += nested.bytes
        } else if (entry.isFile()) {
          count += 1
          bytes += (await stat(path)).size
        }
      }
      return { count, bytes }
    }
    return await walk(root)
  }

  private sameOwner(left: MediaOwner, right: MediaOwner): boolean {
    return left.kind === right.kind && left.owner_id === right.owner_id
  }

  private async readDeletionReceipts(): Promise<MediaDeletionReceipt[]> {
    await this.ensureDirs()
    const names = await readdir(this.deletionsDir).catch(() => [])
    return await Promise.all(names
      .filter(name => name.endsWith('.json'))
      .map(async name => {
        try {
          return mediaDeletionReceiptSchema.parse(JSON.parse(await readFile(join(this.deletionsDir, name), 'utf8')))
        } catch {
          throw new ImageWorkbenchRepositoryError('图片删除记录存储损坏', 500, 'IMAGE_STORAGE_INVALID')
        }
      }))
  }

  private async latestDeletion(
    projectId: string,
    statuses: MediaDeletionReceipt['status'][],
  ): Promise<MediaDeletionReceipt | null> {
    return (await this.readDeletionReceipts())
      .filter(receipt => receipt.project_id === projectId && statuses.includes(receipt.status))
      .sort((left, right) => right.deleted_at.localeCompare(left.deleted_at))[0] ?? null
  }

  private async writeDeletion(receipt: MediaDeletionReceipt): Promise<void> {
    await this.writeJson(this.deletionPath(receipt.deletion_id), mediaDeletionReceiptSchema.parse(receipt))
  }

  private async resumeDeletion(receipt: MediaDeletionReceipt): Promise<MediaDeletionReceipt> {
    const trash = this.trashPath(receipt.trash_key)
    // Publishing the removal of project.json first ensures a crash never
    // leaves an apparently-live project after its owned assets moved away.
    await this.moveIfPresent(this.projectPath(receipt.project_id), join(trash, 'project.json'))
    for (const operationId of receipt.task_ids) {
      await this.moveIfPresent(this.operationPath(operationId), join(trash, 'operations', `${operationId}.json`))
    }
    await this.moveIfPresent(this.eventPath(receipt.project_id), join(trash, 'events.json'))
    await this.moveIfPresent(join(this.assetsDir, receipt.project_id), join(trash, 'assets'))
    const deleted = mediaDeletionReceiptSchema.parse({ ...receipt, status: 'deleted' })
    await this.writeDeletion(deleted)
    return deleted
  }

  async listDeletions(owner?: MediaOwner): Promise<MediaDeletionReceipt[]> {
    return (await this.readDeletionReceipts())
      .filter(receipt => !owner || this.sameOwner(receipt.owner, owner))
      .filter(receipt => receipt.status !== 'purged')
      .sort((left, right) => right.deleted_at.localeCompare(left.deleted_at))
  }

  async hasProjectHistory(projectId: string, owner?: MediaOwner): Promise<boolean> {
    this.assertId(projectId, 'IMAGE_PROJECT_NOT_FOUND')
    if (await this.readProjectOrNull(projectId)) return true
    return (await this.readDeletionReceipts()).some(receipt => (
      receipt.project_id === projectId
      && (!owner || this.sameOwner(receipt.owner, owner))
    ))
  }

  async hasOperationHistory(operationId: string, owner?: MediaOwner): Promise<boolean> {
    this.assertId(operationId, 'IMAGE_OPERATION_NOT_FOUND')
    try {
      const operation = await this.getOperation(operationId)
      return !owner || (operation.owner !== undefined && this.sameOwner(operation.owner, owner))
    } catch (error) {
      if (!(error instanceof ImageWorkbenchRepositoryError) || error.code !== 'IMAGE_OPERATION_NOT_FOUND') throw error
    }
    return (await this.readDeletionReceipts()).some(receipt => (
      receipt.task_ids.includes(operationId)
      && (!owner || this.sameOwner(receipt.owner, owner))
    ))
  }

  async deleteProject(projectId: string): Promise<MediaDeletionReceipt> {
    await this.ensureDirs()
    this.assertId(projectId, 'IMAGE_PROJECT_NOT_FOUND')
    return await this.withLock(`project-${projectId}`, async () => {
      const current = await this.readProjectOrNull(projectId)
      if (!current) {
        const pending = await this.latestDeletion(projectId, ['pending', 'deleted'])
        if (pending) return await this.resumeDeletion(pending)
        throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      }
      const operations = await this.listOperations(projectId)
      if (operations.some(operation => ['queued', 'running', 'committing'].includes(operation.status))) {
        throw new ImageWorkbenchRepositoryError('请先等待当前图片操作完成或取消', 409, 'IMAGE_STORAGE_INVALID')
      }
      const usage = await this.managedAssetUsage(projectId)
      const deletedAt = this.iso()
      const deletionId = `del_${randomUUID().replaceAll('-', '')}`
      const receipt = mediaDeletionReceiptSchema.parse({
        deletion_id: deletionId,
        project_id: current.id,
        project_kind: 'image',
        project_title: current.title,
        owner: current.owner,
        status: 'pending',
        deleted_at: deletedAt,
        purge_after: new Date(this.now().getTime() + 30 * 86_400_000).toISOString(),
        task_ids: operations.map(operation => operation.id),
        managed_asset_count: usage.count,
        managed_asset_bytes: usage.bytes,
        trash_key: deletionId,
      })
      await this.writeDeletion(receipt)
      return await this.resumeDeletion(receipt)
    })
  }

  async restoreProject(projectId: string, owner: MediaOwner): Promise<MediaDeletionReceipt> {
    this.assertId(projectId, 'IMAGE_PROJECT_NOT_FOUND')
    return await this.withLock(`project-${projectId}`, async () => {
      const receipt = await this.latestDeletion(projectId, ['pending', 'deleted', 'restoring'])
      if (!receipt || !this.sameOwner(receipt.owner, owner)) {
        throw new ImageWorkbenchRepositoryError('找不到可恢复的图片项目', 404, 'IMAGE_PROJECT_NOT_FOUND')
      }
      const deleted = receipt.status === 'pending' ? await this.resumeDeletion(receipt) : receipt
      const trash = this.trashPath(deleted.trash_key)
      const activeProject = this.projectPath(projectId)
      const trashedProject = join(trash, 'project.json')
      if (await this.exists(activeProject) && await this.exists(trashedProject)) {
        throw new ImageWorkbenchRepositoryError('图片项目 ID 已被占用，不能恢复', 409, 'IMAGE_STORAGE_INVALID')
      }
      const restoring = mediaDeletionReceiptSchema.parse({ ...deleted, status: 'restoring' })
      await this.writeDeletion(restoring)
      await this.moveIfPresent(join(trash, 'assets'), join(this.assetsDir, projectId))
      for (const operationId of restoring.task_ids) {
        await this.moveIfPresent(join(trash, 'operations', `${operationId}.json`), this.operationPath(operationId))
      }
      await this.moveIfPresent(join(trash, 'events.json'), this.eventPath(projectId))
      // Publish the project last so readers cannot observe a partially
      // restored project with missing operations or image bytes.
      await this.moveIfPresent(trashedProject, activeProject)
      if (!(await this.exists(activeProject))) {
        throw new ImageWorkbenchRepositoryError('图片项目恢复不完整，可安全重试', 503, 'IMAGE_STORAGE_INVALID')
      }
      const restored = mediaDeletionReceiptSchema.parse({
        ...restoring,
        status: 'restored',
        restored_at: this.iso(),
      })
      await this.writeDeletion(restored)
      return restored
    })
  }
}
