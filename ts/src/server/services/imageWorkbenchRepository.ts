import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  imageWorkbenchProjectSchema,
  mediaDeletionReceiptSchema,
  mediaJobEventJournalSchema,
  mediaTaskSchema,
  type ImageWorkbenchProject,
  type MediaDeletionReceipt,
  type MediaOwner,
  type MediaTask,
} from '../../../shared/contracts/media.js'
import { AssetIntegrity } from '../media/kernel/assets/assetIntegrity.js'
import { RecoverySupervisor } from '../media/kernel/recovery/recoverySupervisor.js'
import { SqliteUnitOfWork } from '../media/kernel/storage/sqliteUnitOfWork.js'
import { WriterFence } from '../media/kernel/storage/writerFence.js'
import { migrateImageMetadata } from '../media/image/infrastructure/imageMetadataMigrations.js'

const IMAGE_ID = /^[a-z0-9][a-z0-9_-]{7,79}$/
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`

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

type ProjectRow = {
  id: string
  owner_kind: MediaOwner['kind']
  owner_id: string
  writer_fence: string
  revision: number
  created_at: string
  updated_at: string
  document_json: string
  deleted: number
}

type OperationRow = {
  id: string
  operation_id: string
  project_id: string
  owner_kind: MediaOwner['kind']
  owner_id: string
  kind: ImageOperation['kind']
  status: ImageOperation['status']
  status_sequence: number
  idempotency_key: string | null
  remote_task_id: string | null
  remote_result_acknowledged_at: string | null
  updated_at: string
  document_json: string
  deleted: number
}

type EventRow = {
  cursor: number
  project_id: string
  operation_id: string
  status_sequence: number
  occurred_at: string
  operation_json: string
  state: 'committed' | 'abandoned'
}

type DeletionRow = {
  deletion_id: string
  project_id: string
  owner_kind: MediaOwner['kind']
  owner_id: string
  status: MediaDeletionReceipt['status']
  receipt_json: string
  updated_at: string
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

function eventOperation(value: unknown): ImageOperation {
  const operation = mediaTaskSchema.parse(value)
  if (operation.kind !== 'image.generate') {
    throw new ImageWorkbenchRepositoryError('图片操作事件类型无效', 500, 'IMAGE_STORAGE_INVALID')
  }
  return operation as ImageOperation
}

function resolvedOperationId(operation: ImageOperation): string {
  return operation.operation_id ?? `op_${createHash('sha256')
    .update([operation.project_id, operation.kind, operation.idempotency_key ?? operation.id].join('\0'))
    .digest('hex')
    .slice(0, 32)}`
}

function sameOwner(left: MediaOwner, right: MediaOwner): boolean {
  return left.kind === right.kind && left.owner_id === right.owner_id
}

function operationProjection(operation: ImageOperation): string {
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

function eventSnapshot(operation: ImageOperation): ImageOperation {
  // An Event is a status projection, not a persistence route for a provider
  // instruction or other private request input. The complete operation remains
  // in its SQLite row and is never exposed by this snapshot.
  const { image_operation: _privateInput, ...snapshot } = operation
  return snapshot as ImageOperation
}

/**
 * SQLite is the only image metadata writer. Project and operation documents
 * are compatibility payloads indexed by normalized image tables; the old JSON
 * layout is deliberately not opened here and is only consumed by the legacy
 * reader during import.
 */
export class ImageWorkbenchRepository {
  private readonly root: string
  private readonly projectsDir: string
  private readonly assetsDir: string
  private readonly exportsDir: string
  private readonly trashDir: string
  private readonly locksDir: string
  private readonly now: () => Date
  private readonly unitOfWork: SqliteUnitOfWork
  private readonly fences: WriterFence
  private readonly integrity = new AssetIntegrity()
  private readonly recovery: RecoverySupervisor
  private readonly readyPromise: Promise<void>
  private readonly eventWaiters = new Map<string, Set<() => void>>()

  constructor(options: { root?: string; now?: () => Date } = {}) {
    this.root = options.root
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'images')
    this.projectsDir = join(this.root, 'projects')
    this.assetsDir = join(this.root, 'assets')
    this.exportsDir = join(this.root, 'exports')
    this.trashDir = join(this.root, 'trash')
    this.locksDir = join(this.root, 'locks')
    this.now = options.now ?? (() => new Date())
    this.unitOfWork = new SqliteUnitOfWork(join(this.root, 'metadata'))
    migrateImageMetadata(this.unitOfWork)
    this.fences = new WriterFence(this.locksDir)
    this.recovery = new RecoverySupervisor([
      { name: 'image deletion receipts', recover: async () => await this.recoverDeletions() },
      {
        name: 'image CAS orphans',
        recover: async () => {
          // A pre-15.1 ImageWorkbenchRepository stored project JSON under this
          // directory. Its CAS objects are not in SQLite yet, so no collector
          // may run until the read-only importer has copied that evidence.
          if (!(await this.hasLegacyProjectJson())) await this.collectCasOrphans()
        },
      },
    ])
    this.readyPromise = this.initialize()
  }

  paths(): Readonly<{ root: string; projects: string; operations: string; events: string; assets: string; exports: string }> {
    return {
      root: this.root,
      // These legacy-shaped locations are intentionally read-only compatibility
      // names. SQLite owns all current metadata and event writes.
      projects: this.projectsDir,
      operations: join(this.root, 'legacy-readonly', 'operations'),
      events: join(this.root, 'legacy-readonly', 'events'),
      assets: this.assetsDir,
      exports: this.exportsDir,
    }
  }

  close(): void {
    this.unitOfWork.close()
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.projectsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.assetsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.exportsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.trashDir, { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, 'cas', 'sha256'), { recursive: true, mode: 0o700 }),
      mkdir(join(this.root, 'legacy-readonly'), { recursive: true, mode: 0o700 }),
    ])
    await this.recovery.recover()
  }

  private async ready(): Promise<void> {
    await this.readyPromise
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private assertId(value: string, kind: 'project' | 'operation'): void {
    if (!IMAGE_ID.test(value)) {
      throw new ImageWorkbenchRepositoryError(
        '图片记录 ID 无效',
        400,
        kind === 'project' ? 'IMAGE_PROJECT_NOT_FOUND' : 'IMAGE_OPERATION_NOT_FOUND',
      )
    }
  }

  private projectRow(projectId: string, includeDeleted = false): ProjectRow | null {
    this.assertId(projectId, 'project')
    return this.unitOfWork.database.query(`SELECT * FROM image_projects WHERE id=?${includeDeleted ? '' : ' AND deleted=0'}`)
      .get(projectId) as ProjectRow | null
  }

  private operationRow(operationId: string, includeDeleted = false): OperationRow | null {
    this.assertId(operationId, 'operation')
    return this.unitOfWork.database.query(`SELECT * FROM image_operations WHERE id=?${includeDeleted ? '' : ' AND deleted=0'}`)
      .get(operationId) as OperationRow | null
  }

  private loadProject(row: ProjectRow): ImageWorkbenchProject {
    try {
      return imageWorkbenchProjectSchema.parse(JSON.parse(row.document_json))
    } catch {
      throw new ImageWorkbenchRepositoryError('图片项目 SQLite 记录损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  private loadOperation(row: OperationRow): ImageOperation {
    try {
      return canonicalImageOperation(JSON.parse(row.document_json))
    } catch (error) {
      if (error instanceof ImageWorkbenchRepositoryError) throw error
      throw new ImageWorkbenchRepositoryError('图片操作 SQLite 记录损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  async listProjects(owner?: MediaOwner): Promise<ImageWorkbenchProject[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT * FROM image_projects
      WHERE deleted=0${owner ? ' AND owner_kind=? AND owner_id=?' : ''} ORDER BY updated_at DESC`)
      .all(...(owner ? [owner.kind, owner.owner_id] : [])) as ProjectRow[]
    return rows.map(row => this.loadProject(row))
  }

  async getProject(projectId: string): Promise<ImageWorkbenchProject> {
    await this.ready()
    const row = this.projectRow(projectId)
    if (!row) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
    return this.loadProject(row)
  }

  async saveProject(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    await this.ready()
    const input = imageWorkbenchProjectSchema.parse(project)
    return await this.fences.run(`project-${input.id}`, async () => this.saveProjectLocked(input))
  }

  private saveProjectLocked(input: ImageWorkbenchProject): ImageWorkbenchProject {
    const currentRow = this.projectRow(input.id, true)
    const current = currentRow && !currentRow.deleted ? this.loadProject(currentRow) : null
    if (current && current.writer_fence !== input.writer_fence) {
      throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_WRITER_FENCE_CONFLICT')
    }
    if (!current && input.writer_fence !== INITIAL_WRITER_FENCE) {
      throw new ImageWorkbenchRepositoryError('图片项目创建凭据无效', 409, 'IMAGE_WRITER_FENCE_CONFLICT')
    }
    const next = imageWorkbenchProjectSchema.parse({
      ...input,
      writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
      updated_at: this.iso(),
    })
    this.unitOfWork.transaction(() => this.persistProject(next))
    return next
  }

  private persistProject(project: ImageWorkbenchProject): void {
    this.unitOfWork.database.query(`INSERT INTO image_projects(
      id,owner_kind,owner_id,writer_fence,revision,created_at,updated_at,document_json,deleted
    ) VALUES(?,?,?,?,?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET
      owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,writer_fence=excluded.writer_fence,
      revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at,
      document_json=excluded.document_json,deleted=0`).run(
      project.id,
      project.owner.kind,
      project.owner.owner_id,
      project.writer_fence,
      project.revision,
      project.created_at,
      project.updated_at,
      JSON.stringify(project),
    )
    this.replaceProjectRelations(project)
  }

  private replaceProjectRelations(project: ImageWorkbenchProject): void {
    this.unitOfWork.database.query('DELETE FROM image_project_references WHERE project_id=?').run(project.id)
    this.unitOfWork.database.query('DELETE FROM image_project_versions WHERE project_id=?').run(project.id)
    this.unitOfWork.database.query('DELETE FROM image_project_outputs WHERE project_id=?').run(project.id)
    this.unitOfWork.database.query('DELETE FROM image_asset_ownerships WHERE project_id=?').run(project.id)
    for (const asset of project.assets) {
      this.unitOfWork.database.query(`INSERT INTO image_asset_ownerships(
        asset_id,project_id,owner_kind,owner_id,role,storage_kind,locator,content_hash,byte_size,asset_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        asset.id,
        project.id,
        project.owner.kind,
        project.owner.owner_id,
        asset.role,
        asset.storage.kind,
        asset.storage.locator,
        asset.content_hash ?? null,
        asset.byte_size ?? null,
        JSON.stringify(asset),
        asset.created_at,
      )
    }
    for (const [position, reference] of project.references.entries()) {
      this.unitOfWork.database.query(`INSERT INTO image_project_references(project_id,asset_id,position,role,reference_json)
        VALUES(?,?,?,?,?)`).run(project.id, reference.asset_id, position, reference.role, JSON.stringify(reference))
    }
    for (const version of project.versions) {
      this.unitOfWork.database.query(`INSERT INTO image_project_versions(
        id,project_id,operation_id,parent_version_id,project_revision,version_json,created_at
      ) VALUES(?,?,?,?,?,?,?)`).run(
        version.id,
        project.id,
        version.operation_id ?? null,
        version.parent_version_id ?? null,
        version.project_revision,
        JSON.stringify(version),
        version.created_at,
      )
    }
    for (const output of project.outputs) {
      this.unitOfWork.database.query(`INSERT INTO image_project_outputs(id,project_id,version_id,operation_id,output_json)
        VALUES(?,?,?,?,?)`).run(output.id, project.id, output.version_id ?? null, output.operation_id ?? null, JSON.stringify(output))
    }
  }

  async getOperation(operationId: string): Promise<ImageOperation> {
    await this.ready()
    const row = this.operationRow(operationId)
    if (!row) throw new ImageWorkbenchRepositoryError('图片操作不存在', 404, 'IMAGE_OPERATION_NOT_FOUND')
    return this.loadOperation(row)
  }

  async listOperations(projectId?: string): Promise<ImageOperation[]> {
    await this.ready()
    if (projectId) this.assertId(projectId, 'project')
    const rows = this.unitOfWork.database.query(`SELECT * FROM image_operations
      WHERE deleted=0${projectId ? ' AND project_id=?' : ''} ORDER BY updated_at DESC`)
      .all(...(projectId ? [projectId] : [])) as OperationRow[]
    return rows.map(row => this.loadOperation(row))
  }

  async saveOperation(operation: ImageOperation): Promise<ImageOperation> {
    await this.ready()
    const input = canonicalImageOperation(operation)
    return await this.fences.run(`project-${input.project_id}`, async () => this.saveOperationLocked(input))
  }

  private saveOperationLocked(input: ImageOperation): ImageOperation {
    const projectRow = this.projectRow(input.project_id)
    if (!projectRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
    const project = this.loadProject(projectRow)
    const previousRow = this.operationRow(input.id, true)
    const previous = previousRow && !previousRow.deleted ? this.loadOperation(previousRow) : null
    const operationId = resolvedOperationId(input)
    const projected = operationProjection({ ...input, operation_id: operationId })
    const changed = !previous || projected !== operationProjection(previous)
    const next = canonicalImageOperation({
      ...input,
      owner: input.owner ?? previous?.owner ?? project.owner,
      operation_id: operationId,
      status_sequence: changed ? (previous?.status_sequence ?? 0) + 1 : previous?.status_sequence ?? input.status_sequence,
      updated_at: this.iso(),
    })
    this.unitOfWork.transaction(() => {
      this.assertIdempotencyUnique(next)
      this.persistOperation(next)
      if (changed) this.appendEvent(next)
    })
    if (changed) this.notify(next.project_id)
    return next
  }

  private assertIdempotencyUnique(operation: ImageOperation): void {
    if (!operation.idempotency_key || !operation.owner) return
    const matching = this.unitOfWork.database.query(`SELECT id FROM image_operations
      WHERE owner_kind=? AND owner_id=? AND kind=? AND idempotency_key=? AND deleted=0`).get(
      operation.owner.kind,
      operation.owner.owner_id,
      operation.kind,
      operation.idempotency_key,
    ) as { id: string } | null
    if (matching && matching.id !== operation.id) {
      throw new ImageWorkbenchRepositoryError('图片操作幂等键已对应另一条操作', 409, 'IMAGE_STORAGE_INVALID')
    }
  }

  private persistOperation(operation: ImageOperation): void {
    this.unitOfWork.database.query(`INSERT INTO image_operations(
      id,operation_id,project_id,owner_kind,owner_id,kind,status,status_sequence,idempotency_key,remote_task_id,
      remote_result_acknowledged_at,updated_at,document_json,deleted
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET
      operation_id=excluded.operation_id,project_id=excluded.project_id,owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,
      kind=excluded.kind,status=excluded.status,status_sequence=excluded.status_sequence,idempotency_key=excluded.idempotency_key,
      remote_task_id=excluded.remote_task_id,remote_result_acknowledged_at=excluded.remote_result_acknowledged_at,
      updated_at=excluded.updated_at,document_json=excluded.document_json,deleted=0`).run(
      operation.id,
      operation.operation_id!,
      operation.project_id,
      operation.owner!.kind,
      operation.owner!.owner_id,
      operation.kind,
      operation.status,
      operation.status_sequence,
      operation.idempotency_key ?? null,
      operation.remote_task_id ?? null,
      operation.remote_result_acknowledged_at ?? null,
      operation.updated_at,
      JSON.stringify(operation),
    )
  }

  private appendEvent(operation: ImageOperation): void {
    const state = this.eventCursorState(operation.project_id)
    const cursor = state?.next_cursor ?? 1
    if (!state) {
      this.unitOfWork.database.query(`INSERT INTO image_event_cursors(project_id,next_cursor,retained_from_cursor)
        VALUES(?,?,?)`).run(operation.project_id, cursor + 1, cursor)
    } else {
      this.unitOfWork.database.query('UPDATE image_event_cursors SET next_cursor=? WHERE project_id=?')
        .run(cursor + 1, operation.project_id)
    }
    this.unitOfWork.database.query(`INSERT INTO image_outbox_events(
      project_id,cursor,operation_id,status_sequence,occurred_at,operation_json,state
    ) VALUES(?,?,?,?,?,?, 'committed')`).run(
      operation.project_id,
      cursor,
      operation.operation_id!,
      operation.status_sequence,
      operation.updated_at,
      JSON.stringify(eventSnapshot(operation)),
    )
  }

  async saveProjectAndOperation(project: ImageWorkbenchProject, operation: ImageOperation): Promise<{ project: ImageWorkbenchProject; operation: ImageOperation }> {
    await this.ready()
    const projectInput = imageWorkbenchProjectSchema.parse(project)
    const operationInput = canonicalImageOperation(operation)
    if (projectInput.id !== operationInput.project_id) throw new ImageWorkbenchRepositoryError('图片事务项目不一致', 409, 'IMAGE_STORAGE_INVALID')
    return await this.fences.run(`project-${projectInput.id}`, async () => {
      const currentRow = this.projectRow(projectInput.id, true)
      const current = currentRow && !currentRow.deleted ? this.loadProject(currentRow) : null
      if (current && current.writer_fence !== projectInput.writer_fence) {
        throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_WRITER_FENCE_CONFLICT')
      }
      if (!current && projectInput.writer_fence !== INITIAL_WRITER_FENCE) {
        throw new ImageWorkbenchRepositoryError('图片项目创建凭据无效', 409, 'IMAGE_WRITER_FENCE_CONFLICT')
      }
      const nextProject = imageWorkbenchProjectSchema.parse({
        ...projectInput,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      const previousRow = this.operationRow(operationInput.id, true)
      const previous = previousRow && !previousRow.deleted ? this.loadOperation(previousRow) : null
      const nextOperation = canonicalImageOperation({
        ...operationInput,
        owner: operationInput.owner ?? previous?.owner ?? nextProject.owner,
        operation_id: resolvedOperationId(operationInput),
        status_sequence: operationProjection({ ...operationInput, operation_id: resolvedOperationId(operationInput) }) === (previous ? operationProjection(previous) : '')
          ? previous?.status_sequence ?? operationInput.status_sequence
          : (previous?.status_sequence ?? 0) + 1,
        updated_at: this.iso(),
      })
      const changed = !previous || operationProjection(nextOperation) !== operationProjection(previous)
      this.unitOfWork.transaction(() => {
        this.persistProject(nextProject)
        this.assertIdempotencyUnique(nextOperation)
        this.persistOperation(nextOperation)
        if (changed) this.appendEvent(nextOperation)
      })
      if (changed) this.notify(nextProject.id)
      return { project: nextProject, operation: nextOperation }
    })
  }

  /** Import retains legacy revision, timestamps and event cursor verbatim. */
  async importLegacyProject(project: ImageWorkbenchProject): Promise<boolean> {
    await this.ready()
    const input = imageWorkbenchProjectSchema.parse(project)
    return await this.fences.run(`project-${input.id}`, async () => {
      if (this.projectRow(input.id, true)) return false
      this.unitOfWork.transaction(() => this.persistProject(input))
      return true
    })
  }

  async importLegacyOperation(operation: ImageOperation): Promise<boolean> {
    await this.ready()
    const input = canonicalImageOperation(operation)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      const project = this.projectRow(input.project_id)
      if (!project) throw new ImageWorkbenchRepositoryError('旧图片操作缺少项目', 500, 'IMAGE_STORAGE_INVALID')
      const existing = this.operationRow(input.id, true)
      if (existing) return false
      const imported = canonicalImageOperation({
        ...input,
        owner: input.owner ?? this.loadProject(project).owner,
        operation_id: resolvedOperationId(input),
      })
      this.unitOfWork.transaction(() => {
        this.assertIdempotencyUnique(imported)
        this.persistOperation(imported)
      })
      return true
    })
  }

  async importLegacyEvent(value: unknown): Promise<boolean> {
    await this.ready()
    const event = mediaJobEventJournalSchema.parse({ schema_version: 1, next_cursor: 1, events: [value] }).events[0]!
    const operation = eventOperation(event.task)
    return await this.fences.run(`project-${event.project_id}`, async () => {
      const existing = this.unitOfWork.database.query(`SELECT cursor FROM image_outbox_events
        WHERE project_id=? AND cursor=?`).get(event.project_id, event.cursor) as { cursor: number } | null
      if (existing) return false
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO image_outbox_events(
          project_id,cursor,operation_id,status_sequence,occurred_at,operation_json,state
        ) VALUES(?,?,?,?,?,?, 'committed')`).run(
          event.project_id,
          event.cursor,
          event.operation_id,
          event.status_sequence,
          event.occurred_at,
          JSON.stringify(eventSnapshot(operation)),
        )
        const state = this.eventCursorState(event.project_id)
        if (!state) {
          this.unitOfWork.database.query(`INSERT INTO image_event_cursors(project_id,next_cursor,retained_from_cursor)
            VALUES(?,?,?)`).run(event.project_id, event.cursor + 1, event.cursor)
        } else {
          this.unitOfWork.database.query(`UPDATE image_event_cursors
            SET next_cursor=MAX(next_cursor,?), retained_from_cursor=MIN(retained_from_cursor,?) WHERE project_id=?`)
            .run(event.cursor + 1, event.cursor, event.project_id)
        }
      })
      return true
    })
  }

  async listOperationEvents(projectId: string, after = 0, limit = 200): Promise<{ events: ImageOperationEvent[]; cursor: number; reset_required: boolean }> {
    await this.ready()
    this.assertId(projectId, 'project')
    const state = this.eventCursorState(projectId)
    if (state && after < state.retained_from_cursor - 1) {
      return { events: [], cursor: state.next_cursor - 1, reset_required: true }
    }
    const rows = this.unitOfWork.database.query(`SELECT * FROM image_outbox_events
      WHERE project_id=? AND state='committed' AND cursor>? ORDER BY cursor ASC LIMIT ?`)
      .all(projectId, after, Math.max(1, Math.min(200, limit))) as EventRow[]
    const events = rows.map(row => ({
      schema_version: 1 as const,
      cursor: row.cursor,
      project_id: row.project_id,
      operation_id: row.operation_id,
      status_sequence: row.status_sequence,
      occurred_at: row.occurred_at,
      operation: eventOperation(JSON.parse(row.operation_json)),
    }))
    return { events, cursor: events.at(-1)?.cursor ?? after, reset_required: false }
  }

  private eventCursorState(projectId: string): { next_cursor: number; retained_from_cursor: number } | null {
    return this.unitOfWork.database.query('SELECT next_cursor,retained_from_cursor FROM image_event_cursors WHERE project_id=?')
      .get(projectId) as { next_cursor: number; retained_from_cursor: number } | null
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

  private notify(projectId: string): void {
    for (const notify of this.eventWaiters.get(projectId) ?? []) notify()
  }

  async listDeletions(owner?: MediaOwner): Promise<MediaDeletionReceipt[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT * FROM image_deletions
      ${owner ? 'WHERE owner_kind=? AND owner_id=?' : ''} ORDER BY updated_at DESC`)
      .all(...(owner ? [owner.kind, owner.owner_id] : [])) as DeletionRow[]
    return rows
      .map(row => mediaDeletionReceiptSchema.parse(JSON.parse(row.receipt_json)))
      .filter(receipt => receipt.status !== 'purged')
  }

  private latestDeletion(projectId: string, statuses: MediaDeletionReceipt['status'][]): MediaDeletionReceipt | null {
    const rows = this.unitOfWork.database.query('SELECT * FROM image_deletions WHERE project_id=? ORDER BY updated_at DESC')
      .all(projectId) as DeletionRow[]
    for (const row of rows) {
      const receipt = mediaDeletionReceiptSchema.parse(JSON.parse(row.receipt_json))
      if (statuses.includes(receipt.status)) return receipt
    }
    return null
  }

  private writeDeletion(receipt: MediaDeletionReceipt): void {
    this.unitOfWork.database.query(`INSERT INTO image_deletions(
      deletion_id,project_id,owner_kind,owner_id,status,receipt_json,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(deletion_id) DO UPDATE SET status=excluded.status,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`).run(
      receipt.deletion_id,
      receipt.project_id,
      receipt.owner.kind,
      receipt.owner.owner_id,
      receipt.status,
      JSON.stringify(receipt),
      receipt.restored_at ?? receipt.deleted_at,
    )
  }

  async hasProjectHistory(projectId: string, owner?: MediaOwner): Promise<boolean> {
    await this.ready()
    this.assertId(projectId, 'project')
    const project = this.projectRow(projectId, true)
    if (project && (!owner || (project.owner_kind === owner.kind && project.owner_id === owner.owner_id))) return true
    return Boolean(this.latestDeletion(projectId, ['pending', 'deleted', 'restoring', 'restored']))
  }

  async hasOperationHistory(operationId: string, owner?: MediaOwner): Promise<boolean> {
    await this.ready()
    this.assertId(operationId, 'operation')
    const operation = this.operationRow(operationId, true)
    if (operation) {
      const project = this.projectRow(operation.project_id, true)
      return !owner || Boolean(project && project.owner_kind === owner.kind && project.owner_id === owner.owner_id)
    }
    return (await this.listDeletions(owner)).some(receipt => receipt.task_ids.includes(operationId))
  }

  async deleteProject(projectId: string): Promise<MediaDeletionReceipt> {
    await this.ready()
    this.assertId(projectId, 'project')
    return await this.fences.run(`project-${projectId}`, async () => {
      const row = this.projectRow(projectId)
      if (!row) {
        const receipt = this.latestDeletion(projectId, ['pending', 'deleted'])
        if (receipt) return await this.resumeDeletion(receipt)
        throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      }
      const project = this.loadProject(row)
      const operations = this.operationRowsForProject(projectId).map(item => this.loadOperation(item))
      if (operations.some(operation => ['queued', 'running', 'committing'].includes(operation.status))) {
        throw new ImageWorkbenchRepositoryError('请先等待当前图片操作完成或取消', 409, 'IMAGE_STORAGE_INVALID')
      }
      const usage = await this.managedAssetUsage(projectId)
      const receipt = mediaDeletionReceiptSchema.parse({
        deletion_id: `del_${randomUUID().replaceAll('-', '')}`,
        project_id: project.id,
        project_kind: 'image',
        project_title: project.title,
        owner: project.owner,
        status: 'pending',
        deleted_at: this.iso(),
        purge_after: new Date(this.now().getTime() + 30 * 86_400_000).toISOString(),
        task_ids: operations.map(operation => operation.id),
        managed_asset_count: usage.count,
        managed_asset_bytes: usage.bytes,
        trash_key: `del_${randomUUID().replaceAll('-', '')}`,
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
        throw new ImageWorkbenchRepositoryError('找不到可恢复的图片项目', 404, 'IMAGE_PROJECT_NOT_FOUND')
      }
      const deleted = receipt.status === 'pending' ? await this.resumeDeletion(receipt) : receipt
      const restoring = mediaDeletionReceiptSchema.parse({ ...deleted, status: 'restoring' })
      this.unitOfWork.transaction(() => this.writeDeletion(restoring))
      return await this.resumeRestore(restoring)
    })
  }

  private operationRowsForProject(projectId: string, includeDeleted = false): OperationRow[] {
    return this.unitOfWork.database.query(`SELECT * FROM image_operations WHERE project_id=?${includeDeleted ? '' : ' AND deleted=0'}`)
      .all(projectId) as OperationRow[]
  }

  private trashPath(trashKey: string): string {
    this.assertId(trashKey, 'project')
    return join(this.trashDir, trashKey)
  }

  private async resumeDeletion(receipt: MediaDeletionReceipt): Promise<MediaDeletionReceipt> {
    const assets = join(this.assetsDir, receipt.project_id)
    const trashedAssets = join(this.trashPath(receipt.trash_key), 'assets')
    await this.moveIfPresent(assets, trashedAssets)
    const deleted = mediaDeletionReceiptSchema.parse({ ...receipt, status: 'deleted' })
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query('UPDATE image_projects SET deleted=1 WHERE id=?').run(receipt.project_id)
      this.unitOfWork.database.query('UPDATE image_operations SET deleted=1 WHERE project_id=?').run(receipt.project_id)
      this.writeDeletion(deleted)
    })
    return deleted
  }

  private async resumeRestore(receipt: MediaDeletionReceipt): Promise<MediaDeletionReceipt> {
    const project = this.projectRow(receipt.project_id, true)
    if (!project) throw new ImageWorkbenchRepositoryError('图片项目历史不完整，无法恢复', 503, 'IMAGE_STORAGE_INVALID')
    const assets = join(this.assetsDir, receipt.project_id)
    const trashedAssets = join(this.trashPath(receipt.trash_key), 'assets')
    await this.moveIfPresent(trashedAssets, assets)
    const restored = mediaDeletionReceiptSchema.parse({ ...receipt, status: 'restored', restored_at: this.iso() })
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query('UPDATE image_projects SET deleted=0 WHERE id=?').run(receipt.project_id)
      this.unitOfWork.database.query('UPDATE image_operations SET deleted=0 WHERE project_id=?').run(receipt.project_id)
      this.writeDeletion(restored)
    })
    return restored
  }

  private async recoverDeletions(): Promise<void> {
    const rows = this.unitOfWork.database.query("SELECT * FROM image_deletions WHERE status IN ('pending','restoring')")
      .all() as DeletionRow[]
    for (const row of rows) {
      const receipt = mediaDeletionReceiptSchema.parse(JSON.parse(row.receipt_json))
      await this.fences.run(`project-${receipt.project_id}`, async () => {
        if (receipt.status === 'pending') await this.resumeDeletion(receipt)
        else await this.resumeRestore(receipt)
      })
    }
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

  private async moveIfPresent(source: string, target: string): Promise<void> {
    const present = await stat(source).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    if (!present) return
    const targetExists = await stat(target).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    if (targetExists) throw new ImageWorkbenchRepositoryError('图片回收区存在冲突记录', 409, 'IMAGE_STORAGE_INVALID')
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rename(source, target)
  }

  private async collectCasOrphans(): Promise<void> {
    const directory = join(this.root, 'cas', 'sha256')
    const names = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const reachable = new Set((this.unitOfWork.database.query(`SELECT content_hash FROM image_asset_ownerships
      WHERE storage_kind='cas' AND content_hash IS NOT NULL`).all() as Array<{ content_hash: string }>).map(row => row.content_hash.slice('sha256:'.length)))
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name) || reachable.has(name)) continue
      await rm(join(directory, name), { force: true })
    }
    const owned = this.unitOfWork.database.query(`SELECT content_hash,byte_size,locator FROM image_asset_ownerships
      WHERE storage_kind='cas' AND content_hash IS NOT NULL`).all() as Array<{ content_hash: `sha256:${string}`; byte_size: number | null; locator: string }>
    for (const asset of owned) {
      const digest = /^sha256\/([a-f0-9]{64})$/.exec(asset.locator)?.[1]
      if (!digest) throw new ImageWorkbenchRepositoryError('图片 CAS 地址无效', 500, 'IMAGE_STORAGE_INVALID')
      await this.integrity.assert(join(directory, digest), asset.content_hash, asset.byte_size ?? undefined)
    }
  }

  private async hasLegacyProjectJson(): Promise<boolean> {
    const names = await readdir(this.projectsDir).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    return names.some(name => name.endsWith('.json'))
  }

  async migrationReceipt(migrationKey: string): Promise<{ source_hash: string; completed_at: string } | null> {
    await this.ready()
    return this.unitOfWork.database.query('SELECT source_hash,completed_at FROM image_migration_receipts WHERE migration_key=?')
      .get(migrationKey) as { source_hash: string; completed_at: string } | null
  }

  async recordMigrationReceipt(migrationKey: string, sourceHash: string): Promise<void> {
    await this.ready()
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query(`INSERT INTO image_migration_receipts(migration_key,source_hash,completed_at)
        VALUES(?,?,?) ON CONFLICT(migration_key) DO UPDATE SET source_hash=excluded.source_hash,completed_at=excluded.completed_at`)
        .run(migrationKey, sourceHash, this.iso())
    })
  }
}
