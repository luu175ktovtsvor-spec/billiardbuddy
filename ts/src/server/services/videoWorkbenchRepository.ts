import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  mediaDeletionReceiptSchema,
  mediaTaskSchema,
  videoStudioProjectSchema,
  type MediaDeletionReceipt,
  type MediaOwner,
  type MediaTask,
  type VideoStudioProject,
} from '../../../shared/contracts/media.js'
import { EventJournal, type PersistedOutboxEvent } from '../media/kernel/operations/eventJournal.js'
import { RecoverySupervisor } from '../media/kernel/recovery/recoverySupervisor.js'
import { AssetIntegrity } from '../media/kernel/assets/assetIntegrity.js'
import { DeletionStore, type StoredDeletion } from '../media/kernel/storage/deletionStore.js'
import { PayloadCommitProtocol, type PayloadCommitIntent } from '../media/kernel/storage/payloadCommitProtocol.js'
import { SqliteUnitOfWork } from '../media/kernel/storage/sqliteUnitOfWork.js'
import { WriterFence } from '../media/kernel/storage/writerFence.js'

const VIDEO_ID = /^[a-z0-9][a-z0-9_-]{7,79}$/
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`
const PROJECT_PAYLOAD_SCHEMA = 'video-project-v1'
const OPERATION_PAYLOAD_SCHEMA = 'video-operation-v1'

type VideoOperationKind = Extract<MediaTask['kind'], `video.${string}`>

export type VideoOperation = MediaTask & {
  kind: VideoOperationKind
}

export type VideoOperationEvent = {
  schema_version: 1
  cursor: number
  project_id: string
  operation_id: string
  status_sequence: number
  occurred_at: string
  operation: VideoOperation
}

type ProjectRow = {
  id: string
  owner_kind: MediaOwner['kind']
  owner_id: string
  writer_fence: string
  revision: number
  created_at: string
  updated_at: string
  payload_hash: `sha256:${string}`
  payload_locator: string
  payload_schema: string
  payload_version: number
  deleted: number
}

type OperationRow = {
  id: string
  operation_id: string
  project_id: string
  kind: VideoOperationKind
  status: VideoOperation['status']
  status_sequence: number
  updated_at: string
  payload_hash: `sha256:${string}`
  payload_locator: string
  payload_schema: string
  payload_version: number
  deleted: number
}

export class VideoWorkbenchRepositoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'VIDEO_PROJECT_NOT_FOUND' | 'VIDEO_OPERATION_NOT_FOUND' | 'VIDEO_STORAGE_INVALID' | 'VIDEO_WRITER_FENCE_CONFLICT',
  ) {
    super(message)
    this.name = 'VideoWorkbenchRepositoryError'
  }
}

function canonicalOperation(value: unknown): VideoOperation {
  const operation = mediaTaskSchema.parse(value)
  if (!operation.kind.startsWith('video.')) {
    throw new VideoWorkbenchRepositoryError('视频操作记录类型无效', 500, 'VIDEO_STORAGE_INVALID')
  }
  return operation as VideoOperation
}

function operationId(projectId: string, operation: VideoOperation): string {
  return operation.operation_id ?? `op_${createHash('sha256')
    .update([projectId, operation.kind, operation.idempotency_key ?? operation.id].join('\0'))
    .digest('hex')
    .slice(0, 32)}`
}

function sameOwner(left: MediaOwner, right: MediaOwner): boolean {
  return left.kind === right.kind && left.owner_id === right.owner_id
}

/**
 * Video is the first Media Kernel consumer. SQLite owns all project, operation,
 * event and deletion indices; immutable payloads only hold the full documents.
 * The former JSON directories are read once and then archived as migration
 * evidence, never written by this repository again.
 */
export class VideoWorkbenchRepository {
  private readonly root: string
  private readonly projectsDir: string
  private readonly assetsDir: string
  private readonly exportsDir: string
  private readonly trashDir: string
  private readonly legacyImportDir: string
  private readonly locksDir: string
  private readonly now: () => Date
  private readonly unitOfWork: SqliteUnitOfWork
  private readonly assetIntegrity = new AssetIntegrity()
  private readonly payloads: PayloadCommitProtocol
  private readonly fences: WriterFence
  private readonly events: EventJournal
  private readonly deletions: DeletionStore<MediaDeletionReceipt>
  private readonly recovery: RecoverySupervisor
  private readonly readyPromise: Promise<void>
  private readonly eventWaiters = new Map<string, Set<() => void>>()

  constructor(options: { root?: string; now?: () => Date } = {}) {
    this.root = options.root
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'videos')
    this.projectsDir = join(this.root, 'projects')
    this.assetsDir = join(this.root, 'assets')
    this.exportsDir = join(this.root, 'exports')
    this.trashDir = join(this.root, 'trash')
    this.legacyImportDir = join(this.root, 'legacy-import')
    this.locksDir = join(this.root, 'locks')
    this.now = options.now ?? (() => new Date())
    this.unitOfWork = new SqliteUnitOfWork(this.root)
    this.payloads = new PayloadCommitProtocol(this.root, this.unitOfWork, this.now)
    this.fences = new WriterFence(this.locksDir)
    this.events = new EventJournal(this.unitOfWork)
    this.deletions = new DeletionStore(this.unitOfWork, value => mediaDeletionReceiptSchema.parse(value))
    this.recovery = new RecoverySupervisor([
      { name: 'payload commits', recover: async () => await this.recoverPayloadCommits() },
      { name: 'legacy JSON', recover: async () => await this.migrateLegacyJson() },
      { name: 'deletions', recover: async () => await this.recoverDeletions() },
    ])
    this.readyPromise = this.initialize()
  }

  paths(): Readonly<{ root: string; projects: string; operations: string; events: string; assets: string; exports: string }> {
    return {
      root: this.root,
      projects: this.projectsDir,
      // Kept as a read-only compatibility projection for callers that only
      // need a stable root; Operations and Events now live in metadata.sqlite.
      operations: join(this.legacyImportDir, 'operations'),
      events: join(this.legacyImportDir, 'events'),
      assets: this.assetsDir,
      exports: this.exportsDir,
    }
  }

  close(): void {
    this.unitOfWork.close()
  }

  private async initialize(): Promise<void> {
    await this.ensureDirs()
    try {
      await this.recovery.recover()
    } catch (error) {
      throw this.storageError(error)
    }
  }

  private async ready(): Promise<void> {
    await this.readyPromise
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private assertId(value: string, kind: 'project' | 'operation'): void {
    if (!VIDEO_ID.test(value)) {
      throw new VideoWorkbenchRepositoryError(
        '视频记录 ID 无效',
        400,
        kind === 'project' ? 'VIDEO_PROJECT_NOT_FOUND' : 'VIDEO_OPERATION_NOT_FOUND',
      )
    }
  }

  private projectDirectory(projectId: string): string {
    this.assertId(projectId, 'project')
    return join(this.projectsDir, projectId)
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.projectsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.assetsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.exportsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.trashDir, { recursive: true, mode: 0o700 }),
      mkdir(this.legacyImportDir, { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, 'staging'), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, 'quarantine'), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, 'backups'), { recursive: true, mode: 0o700 }),
    ])
  }

  private storageError(error: unknown): VideoWorkbenchRepositoryError {
    if (error instanceof VideoWorkbenchRepositoryError) return error
    return new VideoWorkbenchRepositoryError(
      '视频项目存储不可用',
      500,
      'VIDEO_STORAGE_INVALID',
    )
  }

  private async payloadText(locator: string, expectedHash: `sha256:${string}`): Promise<string> {
    try {
      const path = this.payloads.pathFor(locator)
      await this.assetIntegrity.assert(path, expectedHash)
      return await readFile(path, 'utf8')
    } catch (error) {
      throw this.storageError(error)
    }
  }

  private async loadProject(row: ProjectRow): Promise<VideoStudioProject> {
    try {
      return videoStudioProjectSchema.parse(JSON.parse(await this.payloadText(row.payload_locator, row.payload_hash)))
    } catch (error) {
      throw this.storageError(error)
    }
  }

  private async loadOperation(row: { payload_locator: string; payload_hash: `sha256:${string}` }): Promise<VideoOperation> {
    try {
      return canonicalOperation(JSON.parse(await this.payloadText(row.payload_locator, row.payload_hash)))
    } catch (error) {
      throw this.storageError(error)
    }
  }

  private projectRow(projectId: string, includeDeleted = false): ProjectRow | null {
    this.assertId(projectId, 'project')
    return this.unitOfWork.database.query(`SELECT * FROM video_projects WHERE id=?${includeDeleted ? '' : ' AND deleted=0'}`)
      .get(projectId) as ProjectRow | null
  }

  private operationRow(operationIdValue: string, includeDeleted = false): OperationRow | null {
    this.assertId(operationIdValue, 'operation')
    return this.unitOfWork.database.query(`SELECT * FROM video_operations WHERE id=?${includeDeleted ? '' : ' AND deleted=0'}`)
      .get(operationIdValue) as OperationRow | null
  }

  private projection(operation: VideoOperation): string {
    return JSON.stringify({
      operation_id: operation.operation_id,
      kind: operation.kind,
      status: operation.status,
      progress: operation.progress,
      stage: operation.stage,
      outcome_unknown: operation.outcome_unknown,
      result: operation.result,
      error: operation.error,
      error_code: operation.error_code,
    })
  }

  private payloadLocator(kind: 'projects' | 'operations' | 'events', projectId: string, aggregateId: string): string {
    return join(
      'projects',
      projectId,
      'payloads',
      kind,
      `${aggregateId}-${randomUUID().replaceAll('-', '')}.json`,
    )
  }

  async listProjects(owner?: MediaOwner): Promise<VideoStudioProject[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT * FROM video_projects
      WHERE deleted=0${owner ? ' AND owner_kind=? AND owner_id=?' : ''} ORDER BY updated_at DESC`)
      .all(...(owner ? [owner.kind, owner.owner_id] : [])) as ProjectRow[]
    return await Promise.all(rows.map(async row => await this.loadProject(row)))
  }

  async getProject(projectId: string): Promise<VideoStudioProject> {
    await this.ready()
    const row = this.projectRow(projectId)
    if (!row) throw new VideoWorkbenchRepositoryError('视频项目不存在', 404, 'VIDEO_PROJECT_NOT_FOUND')
    return await this.loadProject(row)
  }

  async saveProject(project: VideoStudioProject): Promise<VideoStudioProject> {
    await this.ready()
    const input = videoStudioProjectSchema.parse(project)
    return await this.fences.run(`project-${input.id}`, async () => await this.saveProjectLocked(input))
  }

  private async saveProjectLocked(input: VideoStudioProject): Promise<VideoStudioProject> {
    const currentRow = this.projectRow(input.id, true)
    const current = currentRow && !currentRow.deleted ? await this.loadProject(currentRow) : null
    if (current && current.writer_fence !== input.writer_fence) {
      throw new VideoWorkbenchRepositoryError('视频项目已被另一写入者更新，请刷新后重试', 409, 'VIDEO_WRITER_FENCE_CONFLICT')
    }
    if (!current && input.writer_fence !== INITIAL_WRITER_FENCE) {
      throw new VideoWorkbenchRepositoryError('视频项目创建凭据无效', 409, 'VIDEO_WRITER_FENCE_CONFLICT')
    }
    const next = videoStudioProjectSchema.parse({
      ...input,
      writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
      updated_at: this.iso(),
    })
    const intent = await this.payloads.stage({
      entityKind: 'video_project',
      aggregateId: next.id,
      projectId: next.id,
      finalLocator: this.payloadLocator('projects', next.id, next.id),
      schema: PROJECT_PAYLOAD_SCHEMA,
      version: 1,
      value: next,
    })
    const prepared = this.payloads.prepare(intent.id, preparedIntent => {
      this.unitOfWork.database.query(`INSERT INTO video_project_payloads(
        intent_id,project_id,payload_hash,payload_locator,payload_schema,payload_version,state
      ) VALUES(?,?,?,?,?,?, 'prepared')`).run(
        preparedIntent.id,
        next.id,
        preparedIntent.expected_hash,
        preparedIntent.final_locator,
        preparedIntent.payload_schema,
        preparedIntent.payload_version,
      )
      this.recordPayloadReference(preparedIntent)
    })
    try {
      await this.payloads.publish(prepared)
      await this.commitProjectIntent(prepared.id)
    } catch (error) {
      this.abandonPreparedIntent(prepared)
      throw error
    }
    return next
  }

  private recordPayloadReference(intent: PayloadCommitIntent): void {
    this.unitOfWork.database.query(`INSERT INTO media_payload_blobs(
      locator,content_hash,byte_size,schema_name,schema_version,ref_count,created_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(locator) DO UPDATE SET ref_count=media_payload_blobs.ref_count+1`).run(
      intent.final_locator,
      intent.expected_hash,
      intent.expected_bytes,
      intent.payload_schema,
      intent.payload_version,
      1,
      this.iso(),
    )
  }

  private async commitProjectIntent(intentId: string): Promise<void> {
    const revision = this.unitOfWork.database.query('SELECT * FROM video_project_payloads WHERE intent_id=?').get(intentId) as {
      project_id: string
      payload_hash: `sha256:${string}`
      payload_locator: string
      payload_schema: string
      payload_version: number
    } | null
    if (!revision) throw new VideoWorkbenchRepositoryError('视频项目提交记录无效', 500, 'VIDEO_STORAGE_INVALID')
    const project = videoStudioProjectSchema.parse(JSON.parse(await this.payloadText(revision.payload_locator, revision.payload_hash)))
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query(`INSERT INTO video_projects(
        id,owner_kind,owner_id,writer_fence,revision,created_at,updated_at,payload_hash,payload_locator,payload_schema,payload_version,deleted
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET
        owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,writer_fence=excluded.writer_fence,
        revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at,
        payload_hash=excluded.payload_hash,payload_locator=excluded.payload_locator,
        payload_schema=excluded.payload_schema,payload_version=excluded.payload_version,deleted=0`).run(
        project.id,
        project.owner.kind,
        project.owner.owner_id,
        project.writer_fence,
        project.revision,
        project.created_at,
        project.updated_at,
        revision.payload_hash,
        revision.payload_locator,
        revision.payload_schema,
        revision.payload_version,
      )
      this.unitOfWork.database.query("UPDATE video_project_payloads SET state='committed' WHERE intent_id=?").run(intentId)
      this.payloads.markCommitted(intentId)
    })
  }

  async getOperation(operationIdValue: string): Promise<VideoOperation> {
    await this.ready()
    const row = this.operationRow(operationIdValue)
    if (!row) throw new VideoWorkbenchRepositoryError('视频操作不存在', 404, 'VIDEO_OPERATION_NOT_FOUND')
    return await this.loadOperation(row)
  }

  async listOperations(projectId?: string): Promise<VideoOperation[]> {
    await this.ready()
    if (projectId) this.assertId(projectId, 'project')
    const rows = this.unitOfWork.database.query(`SELECT * FROM video_operations WHERE deleted=0${projectId ? ' AND project_id=?' : ''} ORDER BY updated_at DESC`)
      .all(...(projectId ? [projectId] : [])) as OperationRow[]
    return await Promise.all(rows.map(async row => await this.loadOperation(row)))
  }

  async saveOperation(operation: VideoOperation): Promise<VideoOperation> {
    await this.ready()
    const input = canonicalOperation(operation)
    return await this.fences.run(`project-${input.project_id}`, async () => await this.saveOperationLocked(input, true))
  }

  private async saveOperationLocked(input: VideoOperation, emitsEvent: boolean): Promise<VideoOperation> {
    const projectRow = this.projectRow(input.project_id)
    if (!projectRow) throw new VideoWorkbenchRepositoryError('视频项目不存在', 404, 'VIDEO_PROJECT_NOT_FOUND')
    const project = await this.loadProject(projectRow)
    const previousRow = this.operationRow(input.id, true)
    const previous = previousRow && !previousRow.deleted ? await this.loadOperation(previousRow) : null
    const resolvedOperationId = operationId(input.project_id, input)
    const projected = this.projection({ ...input, operation_id: resolvedOperationId })
    const changed = !previous || projected !== this.projection(previous)
    const candidate = canonicalOperation({
      ...input,
      owner: input.owner ?? previous?.owner ?? project.owner,
      operation_id: resolvedOperationId,
      status_sequence: changed ? (previous?.status_sequence ?? 0) + 1 : previous?.status_sequence ?? input.status_sequence,
      updated_at: this.iso(),
    })
    return await this.persistOperation(candidate, emitsEvent && changed)
  }

  private async persistOperation(candidate: VideoOperation, emitsEvent: boolean): Promise<VideoOperation> {
    const intent = await this.payloads.stage({
      entityKind: 'video_operation',
      aggregateId: candidate.id,
      projectId: candidate.project_id,
      finalLocator: this.payloadLocator('operations', candidate.project_id, candidate.id),
      schema: OPERATION_PAYLOAD_SCHEMA,
      version: 1,
      value: candidate,
      operationId: candidate.operation_id ?? candidate.id,
    })
    const prepared = this.payloads.prepare(intent.id, preparedIntent => {
      this.unitOfWork.database.query(`INSERT INTO video_operation_payloads(
        intent_id,operation_id,project_id,payload_hash,payload_locator,payload_schema,payload_version,emits_event,state
      ) VALUES(?,?,?,?,?,?,?,?, 'prepared')`).run(
        preparedIntent.id,
        candidate.id,
        candidate.project_id,
        preparedIntent.expected_hash,
        preparedIntent.final_locator,
        preparedIntent.payload_schema,
        preparedIntent.payload_version,
        emitsEvent ? 1 : 0,
      )
      this.recordPayloadReference(preparedIntent)
      if (emitsEvent) {
        this.events.prepare({
          intent_id: preparedIntent.id,
          project_id: candidate.project_id,
          operation_id: candidate.operation_id!,
          status_sequence: candidate.status_sequence,
          occurred_at: candidate.updated_at,
          payload_hash: preparedIntent.expected_hash,
          payload_locator: preparedIntent.final_locator,
          legacy_key: null,
        })
      }
    })
    try {
      await this.payloads.publish(prepared)
      await this.commitOperationIntent(prepared.id)
    } catch (error) {
      this.abandonPreparedIntent(prepared)
      throw error
    }
    if (emitsEvent) this.notify(candidate.project_id)
    return candidate
  }

  private async commitOperationIntent(intentId: string): Promise<void> {
    const revision = this.unitOfWork.database.query('SELECT * FROM video_operation_payloads WHERE intent_id=?').get(intentId) as {
      operation_id: string
      project_id: string
      payload_hash: `sha256:${string}`
      payload_locator: string
      payload_schema: string
      payload_version: number
      emits_event: number
    } | null
    if (!revision) throw new VideoWorkbenchRepositoryError('视频操作提交记录无效', 500, 'VIDEO_STORAGE_INVALID')
    const operation = await this.loadOperation(revision)
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query(`INSERT INTO video_operations(
        id,operation_id,project_id,kind,status,status_sequence,updated_at,payload_hash,payload_locator,payload_schema,payload_version,deleted
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET
        operation_id=excluded.operation_id,project_id=excluded.project_id,kind=excluded.kind,status=excluded.status,
        status_sequence=excluded.status_sequence,updated_at=excluded.updated_at,payload_hash=excluded.payload_hash,
        payload_locator=excluded.payload_locator,payload_schema=excluded.payload_schema,payload_version=excluded.payload_version,deleted=0`).run(
        operation.id,
        operation.operation_id ?? operation.id,
        operation.project_id,
        operation.kind,
        operation.status,
        operation.status_sequence,
        operation.updated_at,
        revision.payload_hash,
        revision.payload_locator,
        revision.payload_schema,
        revision.payload_version,
      )
      this.unitOfWork.database.query("UPDATE video_operation_payloads SET state='committed' WHERE intent_id=?").run(intentId)
      this.events.commit(intentId)
      this.payloads.markCommitted(intentId)
    })
  }

  async listOperationEvents(projectId: string, after = 0, limit = 200): Promise<{ events: VideoOperationEvent[]; cursor: number; reset_required: boolean }> {
    await this.ready()
    this.assertId(projectId, 'project')
    const rows = this.events.list(projectId, after, limit)
    const events = await Promise.all(rows.map(async row => await this.eventFromRow(row)))
    return { events, cursor: events.at(-1)?.cursor ?? after, reset_required: false }
  }

  private async eventFromRow(row: PersistedOutboxEvent): Promise<VideoOperationEvent> {
    return {
      schema_version: 1,
      cursor: row.cursor,
      project_id: row.project_id,
      operation_id: row.operation_id,
      status_sequence: row.status_sequence,
      occurred_at: row.occurred_at,
      operation: await this.loadOperation(row),
    }
  }

  async waitForOperationEvent(projectId: string, after: number, timeoutMs = 25_000): Promise<void> {
    const current = await this.listOperationEvents(projectId, after, 1)
    if (current.events.length > 0) return
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

  private notify(projectId: string): void {
    for (const listener of this.eventWaiters.get(projectId) ?? []) listener()
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
      throw new VideoWorkbenchRepositoryError('视频回收区存在冲突记录', 409, 'VIDEO_STORAGE_INVALID')
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(source, target)
  }

  private async managedAssetUsage(projectId: string): Promise<{ count: number; bytes: number }> {
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
    return await walk(join(this.assetsDir, projectId))
  }

  private storedDeletions(): StoredDeletion<MediaDeletionReceipt>[] {
    try {
      return this.deletions.list()
    } catch (error) {
      throw this.storageError(error)
    }
  }

  private latestDeletion(projectId: string, statuses: MediaDeletionReceipt['status'][]): MediaDeletionReceipt | null {
    return this.storedDeletions()
      .map(item => item.receipt)
      .filter(receipt => receipt.project_id === projectId && statuses.includes(receipt.status))
      .sort((left, right) => right.deleted_at.localeCompare(left.deleted_at))[0] ?? null
  }

  private writeDeletion(receipt: MediaDeletionReceipt): void {
    this.deletions.put({
      deletion_id: receipt.deletion_id,
      project_id: receipt.project_id,
      owner_kind: receipt.owner.kind,
      owner_id: receipt.owner.owner_id,
      status: receipt.status,
      receipt,
      updated_at: receipt.restored_at ?? receipt.deleted_at,
    })
  }

  private trashPath(trashKey: string): string {
    this.assertId(trashKey, 'project')
    return join(this.trashDir, trashKey)
  }

  private async resumeDeletion(receipt: MediaDeletionReceipt): Promise<MediaDeletionReceipt> {
    const trash = this.trashPath(receipt.trash_key)
    await this.moveIfPresent(this.projectDirectory(receipt.project_id), join(trash, 'project'))
    await this.moveIfPresent(join(this.assetsDir, receipt.project_id), join(trash, 'assets'))
    const deleted = mediaDeletionReceiptSchema.parse({ ...receipt, status: 'deleted' })
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query('UPDATE video_projects SET deleted=1 WHERE id=?').run(receipt.project_id)
      this.unitOfWork.database.query('UPDATE video_operations SET deleted=1 WHERE project_id=?').run(receipt.project_id)
      this.writeDeletion(deleted)
    })
    return deleted
  }

  private async resumeRestore(receipt: MediaDeletionReceipt): Promise<MediaDeletionReceipt> {
    const trash = this.trashPath(receipt.trash_key)
    const activeProject = this.projectDirectory(receipt.project_id)
    const trashedProject = join(trash, 'project')
    if (await this.exists(activeProject) && await this.exists(trashedProject)) {
      throw new VideoWorkbenchRepositoryError('视频项目 ID 已被占用，不能恢复', 409, 'VIDEO_STORAGE_INVALID')
    }
    await this.moveIfPresent(join(trash, 'assets'), join(this.assetsDir, receipt.project_id))
    await this.moveIfPresent(trashedProject, activeProject)
    if (!(await this.exists(activeProject))) {
      throw new VideoWorkbenchRepositoryError('视频项目恢复不完整，可安全重试', 503, 'VIDEO_STORAGE_INVALID')
    }
    const restored = mediaDeletionReceiptSchema.parse({ ...receipt, status: 'restored', restored_at: this.iso() })
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query('UPDATE video_projects SET deleted=0 WHERE id=?').run(receipt.project_id)
      this.unitOfWork.database.query('UPDATE video_operations SET deleted=0 WHERE project_id=?').run(receipt.project_id)
      this.writeDeletion(restored)
    })
    return restored
  }

  async listDeletions(owner?: MediaOwner): Promise<MediaDeletionReceipt[]> {
    await this.ready()
    return this.storedDeletions()
      .map(item => item.receipt)
      .filter(receipt => !owner || sameOwner(receipt.owner, owner))
      .filter(receipt => receipt.status !== 'purged')
      .sort((left, right) => right.deleted_at.localeCompare(left.deleted_at))
  }

  async hasProjectHistory(projectId: string, owner?: MediaOwner): Promise<boolean> {
    await this.ready()
    this.assertId(projectId, 'project')
    const row = this.projectRow(projectId, true)
    if (row && (!owner || (row.owner_kind === owner.kind && row.owner_id === owner.owner_id))) return true
    return this.storedDeletions().some(item => item.project_id === projectId && (!owner || (
      item.owner_kind === owner.kind && item.owner_id === owner.owner_id
    )))
  }

  async hasOperationHistory(operationIdValue: string, owner?: MediaOwner): Promise<boolean> {
    await this.ready()
    this.assertId(operationIdValue, 'operation')
    const row = this.operationRow(operationIdValue, true)
    if (row) {
      const project = this.projectRow(row.project_id, true)
      return !owner || Boolean(project && project.owner_kind === owner.kind && project.owner_id === owner.owner_id)
    }
    return this.storedDeletions().some(item => item.receipt.task_ids.includes(operationIdValue) && (!owner || (
      item.owner_kind === owner.kind && item.owner_id === owner.owner_id
    )))
  }

  async deleteProject(projectId: string): Promise<MediaDeletionReceipt> {
    await this.ready()
    this.assertId(projectId, 'project')
    return await this.fences.run(`project-${projectId}`, async () => {
      const row = this.projectRow(projectId)
      if (!row) {
        const pending = this.latestDeletion(projectId, ['pending', 'deleted'])
        if (pending) return await this.resumeDeletion(pending)
        throw new VideoWorkbenchRepositoryError('视频项目不存在', 404, 'VIDEO_PROJECT_NOT_FOUND')
      }
      const current = await this.loadProject(row)
      const operations = await this.listOperations(projectId)
      if (operations.some(operation => ['queued', 'running', 'committing'].includes(operation.status))) {
        throw new VideoWorkbenchRepositoryError('请先等待当前视频操作完成或取消', 409, 'VIDEO_STORAGE_INVALID')
      }
      const usage = await this.managedAssetUsage(projectId)
      const deletionId = `del_${randomUUID().replaceAll('-', '')}`
      const receipt = mediaDeletionReceiptSchema.parse({
        deletion_id: deletionId,
        project_id: current.id,
        project_kind: 'video',
        project_title: current.title,
        owner: current.owner,
        status: 'pending',
        deleted_at: this.iso(),
        purge_after: new Date(this.now().getTime() + 30 * 86_400_000).toISOString(),
        task_ids: operations.map(operation => operation.id),
        managed_asset_count: usage.count,
        managed_asset_bytes: usage.bytes,
        trash_key: deletionId,
      })
      this.unitOfWork.transaction(() => this.writeDeletion(receipt))
      return await this.resumeDeletion(receipt)
    })
  }

  async restoreProject(projectId: string, owner: MediaOwner): Promise<MediaDeletionReceipt> {
    await this.ready()
    this.assertId(projectId, 'project')
    return await this.fences.run(`project-${projectId}`, async () => {
      const receipt = this.latestDeletion(projectId, ['pending', 'deleted', 'restoring'])
      if (!receipt || !sameOwner(receipt.owner, owner)) {
        throw new VideoWorkbenchRepositoryError('找不到可恢复的视频项目', 404, 'VIDEO_PROJECT_NOT_FOUND')
      }
      const deleted = receipt.status === 'pending' ? await this.resumeDeletion(receipt) : receipt
      const restoring = mediaDeletionReceiptSchema.parse({ ...deleted, status: 'restoring' })
      this.unitOfWork.transaction(() => this.writeDeletion(restoring))
      return await this.resumeRestore(restoring)
    })
  }

  private async recoverPayloadCommits(): Promise<void> {
    const recovery = await this.payloads.recover()
    for (const intent of recovery.abandoned) {
      this.abandonPreparedIntent(intent)
    }
    for (const intent of recovery.readyToCommit) {
      if (intent.entity_kind === 'video_project') await this.commitProjectIntent(intent.id)
      else if (intent.entity_kind === 'video_operation') await this.commitOperationIntent(intent.id)
      else if (intent.entity_kind === 'video_operation_event') {
        this.unitOfWork.transaction(() => {
          this.events.commit(intent.id)
          this.payloads.markCommitted(intent.id)
        })
      } else {
        this.unitOfWork.transaction(() => this.payloads.markAbandoned(intent.id))
      }
    }
  }

  private abandonPreparedIntent(intent: PayloadCommitIntent): void {
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query("UPDATE video_project_payloads SET state='abandoned' WHERE intent_id=? AND state='prepared'").run(intent.id)
      this.unitOfWork.database.query("UPDATE video_operation_payloads SET state='abandoned' WHERE intent_id=? AND state='prepared'").run(intent.id)
      this.events.abandon(intent.id)
      this.unitOfWork.database.query('UPDATE media_payload_blobs SET ref_count=MAX(ref_count-1,0) WHERE locator=?')
        .run(intent.final_locator)
      this.payloads.markAbandoned(intent.id)
    })
  }

  private async recoverDeletions(): Promise<void> {
    for (const item of this.storedDeletions()) {
      if (item.receipt.status !== 'pending' && item.receipt.status !== 'restoring') continue
      await this.fences.run(`project-${item.project_id}`, async () => {
        if (item.receipt.status === 'pending') await this.resumeDeletion(item.receipt)
        else await this.resumeRestore(item.receipt)
      })
    }
  }

  private async importLegacyEvent(event: VideoOperationEvent, legacyKey: string): Promise<void> {
    const existing = this.unitOfWork.database.query('SELECT cursor FROM media_outbox_events WHERE legacy_key=?').get(legacyKey)
    if (existing) return
    const operation = canonicalOperation(event.operation)
    const intent = await this.payloads.stage({
      entityKind: 'video_operation_event',
      aggregateId: `${event.project_id}-${event.cursor}`,
      projectId: event.project_id,
      finalLocator: this.payloadLocator('events', event.project_id, `${event.operation_id}-${event.cursor}`),
      schema: OPERATION_PAYLOAD_SCHEMA,
      version: 1,
      value: operation,
      operationId: operation.operation_id ?? operation.id,
    })
    const prepared = this.payloads.prepare(intent.id, preparedIntent => {
      this.recordPayloadReference(preparedIntent)
      this.events.prepare({
        intent_id: preparedIntent.id,
        project_id: event.project_id,
        operation_id: event.operation_id,
        status_sequence: event.status_sequence,
        occurred_at: event.occurred_at,
        payload_hash: preparedIntent.expected_hash,
        payload_locator: preparedIntent.final_locator,
        legacy_key: legacyKey,
      })
    })
    try {
      await this.payloads.publish(prepared)
      this.unitOfWork.transaction(() => {
        this.events.commit(prepared.id)
        this.payloads.markCommitted(prepared.id)
      })
    } catch (error) {
      this.abandonPreparedIntent(prepared)
      throw error
    }
  }

  private async migrateLegacyJson(): Promise<void> {
    const migrationKey = 'video-json-to-sqlite-v1'
    const complete = this.unitOfWork.database.query('SELECT migration_key FROM media_legacy_imports WHERE migration_key=?').get(migrationKey)
    if (complete) return
    const oldOperationsDir = join(this.root, 'operations')
    const oldEventsDir = join(this.root, 'events')
    const oldDeletionsDir = join(this.root, 'deletions')
    const projectNames = (await readdir(this.projectsDir).catch(() => [])).filter(name => name.endsWith('.json')).sort()
    const operationNames = (await readdir(oldOperationsDir).catch(() => [])).filter(name => name.endsWith('.json')).sort()
    const eventNames = (await readdir(oldEventsDir).catch(() => [])).filter(name => name.endsWith('.json')).sort()
    const deletionNames = (await readdir(oldDeletionsDir).catch(() => [])).filter(name => name.endsWith('.json')).sort()
    const legacyEvents = new Map<string, VideoOperationEvent[]>()
    for (const name of eventNames) {
      const projectId = name.slice(0, -'.json'.length)
      const raw = await readFile(join(oldEventsDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      try {
        const journal = JSON.parse(raw) as { events?: VideoOperationEvent[] }
        if (!Array.isArray(journal.events)) continue
        legacyEvents.set(projectId, journal.events
          .map(event => ({ ...event, operation: canonicalOperation(event.operation) }))
          .sort((left, right) => left.cursor - right.cursor))
      } catch {
        throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      }
    }
    for (const name of projectNames) {
      const raw = await readFile(join(this.projectsDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      const project = videoStudioProjectSchema.parse(JSON.parse(raw))
      if (this.projectRow(project.id, true)) continue
      await this.fences.run(`project-${project.id}`, async () => await this.saveProjectLocked(videoStudioProjectSchema.parse({
        ...project,
        writer_fence: INITIAL_WRITER_FENCE,
      })))
    }
    for (const name of operationNames) {
      const raw = await readFile(join(oldOperationsDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      const operation = canonicalOperation(JSON.parse(raw))
      if (this.operationRow(operation.id, true)) continue
      await this.fences.run(`project-${operation.project_id}`, async () => await this.saveOperationLocked(operation, false))
    }
    for (const [projectId, events] of legacyEvents) {
      for (const event of events) {
        await this.fences.run(`project-${projectId}`, async () => await this.importLegacyEvent(
          event,
          `legacy-events/${projectId}.json#${event.cursor}`,
        ))
      }
    }
    for (const name of deletionNames) {
      const raw = await readFile(join(oldDeletionsDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      const receipt = mediaDeletionReceiptSchema.parse(JSON.parse(raw))
      if (!this.storedDeletions().some(item => item.deletion_id === receipt.deletion_id)) {
        this.unitOfWork.transaction(() => this.writeDeletion(receipt))
      }
    }
    for (const item of this.storedDeletions()) {
      await this.migrateLegacyDeletedProject(item.receipt)
    }
    for (const name of [...projectNames.map(name => join('projects', name)), ...operationNames.map(name => join('operations', name)), ...eventNames.map(name => join('events', name)), ...deletionNames.map(name => join('deletions', name))]) {
      await this.archiveLegacyFile(name)
    }
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query('INSERT OR REPLACE INTO media_legacy_imports(migration_key,completed_at) VALUES(?,?)')
        .run(migrationKey, this.iso())
    })
  }

  /**
   * The old deletion store moved JSON documents below trash/<key>/project.json
   * before SQLite existed. Import those documents, then move the new immutable
   * payload directory to the new trash shape so a later restore remains a
   * normal SQLite/file recovery instead of a special legacy branch.
   */
  private async migrateLegacyDeletedProject(receipt: MediaDeletionReceipt): Promise<void> {
    if (receipt.status === 'purged' || receipt.status === 'restored') return
    const trash = this.trashPath(receipt.trash_key)
    const oldProjectPath = join(trash, 'project.json')
    const oldOperationsDirectory = join(trash, 'operations')
    const oldEventsPath = join(trash, 'events.json')
    const newProjectTrash = join(trash, 'project')
    const oldProjectRaw = await readFile(oldProjectPath, 'utf8').catch(() => null)
    if (oldProjectRaw && !this.projectRow(receipt.project_id, true)) {
      const oldProject = videoStudioProjectSchema.parse(JSON.parse(oldProjectRaw))
      await this.fences.run(`project-${oldProject.id}`, async () => await this.saveProjectLocked(videoStudioProjectSchema.parse({
        ...oldProject,
        writer_fence: INITIAL_WRITER_FENCE,
      })))
      const operationNames = (await readdir(oldOperationsDirectory).catch(() => [])).filter(name => name.endsWith('.json')).sort()
      for (const name of operationNames) {
        const raw = await readFile(join(oldOperationsDirectory, name), 'utf8').catch(() => null)
        if (!raw) continue
        const operation = canonicalOperation(JSON.parse(raw))
        if (this.operationRow(operation.id, true)) continue
        await this.fences.run(`project-${operation.project_id}`, async () => await this.saveOperationLocked(operation, false))
      }
      const eventsRaw = await readFile(oldEventsPath, 'utf8').catch(() => null)
      if (eventsRaw) {
        const journal = JSON.parse(eventsRaw) as { events?: VideoOperationEvent[] }
        if (!Array.isArray(journal.events)) {
          throw new VideoWorkbenchRepositoryError('旧回收区视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
        }
        for (const event of journal.events
          .map(candidate => ({ ...candidate, operation: canonicalOperation(candidate.operation) }))
          .sort((left, right) => left.cursor - right.cursor)) {
          await this.fences.run(`project-${event.project_id}`, async () => await this.importLegacyEvent(
            event,
            `legacy-trash-events/${receipt.trash_key}/events.json#${event.cursor}`,
          ))
        }
      }
    }
    const row = this.projectRow(receipt.project_id, true)
    if (row && !row.deleted) {
      if (!(await this.exists(newProjectTrash))) {
        await this.moveIfPresent(this.projectDirectory(receipt.project_id), newProjectTrash)
      }
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query('UPDATE video_projects SET deleted=1 WHERE id=?').run(receipt.project_id)
        this.unitOfWork.database.query('UPDATE video_operations SET deleted=1 WHERE project_id=?').run(receipt.project_id)
      })
    }
    await this.archiveLegacyFile(join('trash', receipt.trash_key, 'project.json'))
    await this.archiveLegacyFile(join('trash', receipt.trash_key, 'events.json'))
    for (const name of (await readdir(oldOperationsDirectory).catch(() => [])).filter(name => name.endsWith('.json'))) {
      await this.archiveLegacyFile(join('trash', receipt.trash_key, 'operations', name))
    }
  }

  private async archiveLegacyFile(locator: string): Promise<void> {
    const source = join(this.root, locator)
    const target = join(this.legacyImportDir, locator)
    if (!(await this.exists(source))) return
    if (await this.exists(target)) {
      throw new VideoWorkbenchRepositoryError('旧视频迁移归档存在冲突', 409, 'VIDEO_STORAGE_INVALID')
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(source, target)
  }
}
