import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import {
  imageWorkbenchProjectSchema,
  mediaDeletionReceiptSchema,
  mediaJobEventJournalSchema,
  mediaTaskSchema,
  type ImageWorkbenchProject,
  type MediaAsset,
  type MediaDeletionReceipt,
  type MediaOwner,
  type MediaTask,
  type MediaVersion,
} from '../../../shared/contracts/media.js'
import {
  imageBriefSnapshotSchema,
  imageBrandKitRevisionSchema,
  imageCanvasPreflightSchema,
  imageCanvasCommandInputSchema,
  imageCanvasRevisionSchema,
  imageCandidateAdoptionSchema,
  imageCandidateDecisionSchema,
  imageCandidateGroupSchema,
  imageCandidateSchema,
  imageCreativePlanSchema,
  imageDeliverySpecSchema,
  imageGenerationEstimateSchema,
  imageGenerationRoundSchema,
  imageHashSchema,
  imageUnderstandingSuggestionSchema,
  imageVisualAssessmentSchema,
  imageRenderReceiptSchema,
  imageReleaseCheckResultSchema,
  imageExportReceiptSchema,
  imageDeliverySetSchema,
  imageOperationV2Schema,
  imageTemplateRevisionSchema,
  providerExecutionReceiptSchema,
  type ImageBriefSnapshot,
  type ImageBrandKitRevision,
  type ImageCanvasCommandInput,
  type ImageCanvasPreflight,
  type ImageCanvasRevision,
  type ImageCandidateAdoption,
  type ImageCandidateDecision,
  type ImageCandidateGroup,
  type ImageCandidate,
  type ImageCreativePlan,
  type ImageDeliverySpec,
  type ImageGenerationEstimate,
  type ImageGenerationRound,
  type ImageUnderstandingSuggestion,
  type ImageVisualAssessment,
  type ImageRenderReceipt,
  type ImageReleaseCheckResult,
  type ImageExportReceipt,
  type ImageDeliverySet,
  type ImageOperationV2,
  type ImageTemplateRevision,
  type ProviderExecutionReceipt,
} from '../../../shared/contracts/imageGeneration.js'
import { applyCanvasCommandDocument, ImageCanvasCommandError } from './imageCanvasCommands.js'
import { AssetIntegrity } from '../media/kernel/assets/assetIntegrity.js'
import { RecoverySupervisor } from '../media/kernel/recovery/recoverySupervisor.js'
import { SqliteUnitOfWork } from '../media/kernel/storage/sqliteUnitOfWork.js'
import { WriterFence } from '../media/kernel/storage/writerFence.js'
import { migrateImageMetadata } from '../media/image/infrastructure/imageMetadataMigrations.js'
import { LegacyImageProjectReader, legacyProjectSourceHash } from '../media/image/infrastructure/legacyImageProjectReader.js'
import { syncParentDirectory } from '../../utils/durableFile.js'

const IMAGE_ID = /^[a-z0-9][a-z0-9_-]{7,79}$/
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`
const DEFAULT_CAS_ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000

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
  request_hash: string
  remote_task_id: string | null
  remote_result_acknowledged_at: string | null
  updated_at: string
  document_json: string
  deleted: number
}

export type ImageProjectMigrationReceipt = {
  source_kind: string
  project_id: string
  source_hash: string
  operation_count: number
  journal_next_cursor: number | null
  version_count: number
  current_version_id: string | null
  status: 'complete'
  completed_at: string
}

export type ImageProjectMigrationInvalidation = {
  source_kind: string
  project_id: string
  source_hash: string
  previous_source_hash: string | null
  invalidated_at: string
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

type CasOrphanObservationRow = {
  content_hash: string
  first_unreachable_at: string
  last_seen_at: string
  scan_count: number
}

const candidateDecisionCommandSchema = imageCandidateDecisionSchema.omit({ actor: true }).extend({
  base_revision: z.number().int().nonnegative(),
}).strict()
type CandidateDecisionCommand = z.infer<typeof candidateDecisionCommandSchema>

export class ImageWorkbenchRepositoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code:
      | 'IMAGE_PROJECT_NOT_FOUND'
      | 'IMAGE_OPERATION_NOT_FOUND'
      | 'IMAGE_STORAGE_INVALID'
      | 'IMAGE_WRITER_FENCE_CONFLICT'
      | 'IMAGE_IDEMPOTENCY_CONFLICT'
      | 'IMAGE_REVISION_CONFLICT',
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The idempotency identity is the immutable remote request, never its status. */
function idempotencyRequestHash(operation: ImageOperation): string {
  return `sha256:${createHash('sha256').update(stableJson({
    project_id: operation.project_id,
    owner: operation.owner,
    kind: operation.kind,
    image_operation: operation.image_operation,
  })).digest('hex')}`
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
  private readonly casOrphanRetentionMs: number
  private readonly unitOfWork: SqliteUnitOfWork
  private readonly fences: WriterFence
  private readonly integrity = new AssetIntegrity()
  private readonly recovery: RecoverySupervisor
  private readonly readyPromise: Promise<void>
  private readonly eventWaiters = new Map<string, Set<() => void>>()

  constructor(options: { root?: string; now?: () => Date; casOrphanRetentionMs?: number } = {}) {
    this.root = options.root
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'images')
    this.projectsDir = join(this.root, 'projects')
    this.assetsDir = join(this.root, 'assets')
    this.exportsDir = join(this.root, 'exports')
    this.trashDir = join(this.root, 'trash')
    this.locksDir = join(this.root, 'locks')
    this.now = options.now ?? (() => new Date())
    this.casOrphanRetentionMs = Math.max(1_000, Math.min(30 * 86_400_000, options.casOrphanRetentionMs ?? DEFAULT_CAS_ORPHAN_RETENTION_MS))
    this.unitOfWork = new SqliteUnitOfWork(join(this.root, 'metadata'))
    migrateImageMetadata(this.unitOfWork)
    this.backfillIdempotencyRequestHashes()
    this.fences = new WriterFence(this.locksDir)
    this.recovery = new RecoverySupervisor([
      { name: 'image deletion receipts', recover: async () => await this.recoverDeletions() },
      {
        name: 'image CAS orphans',
        recover: async () => {
          await this.reconcileCasAfterLegacyMigration()
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

  private backfillIdempotencyRequestHashes(): void {
    const rows = this.unitOfWork.database.query(`SELECT id,document_json FROM image_operations
      WHERE request_hash=''`).all() as Array<{ id: string; document_json: string }>
    if (rows.length === 0) return
    this.unitOfWork.transaction(() => {
      for (const row of rows) {
        const operation = canonicalImageOperation(JSON.parse(row.document_json))
        this.unitOfWork.database.query('UPDATE image_operations SET request_hash=? WHERE id=?')
          .run(idempotencyRequestHash(operation), row.id)
      }
    })
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

  /** Reference control is a command, not a mutable Project document retry. */
  async saveReferenceControlProject(input: {
    project: ImageWorkbenchProject
    base_revision: number
    idempotency_key: string
    request_hash: string
  }): Promise<{ project: ImageWorkbenchProject; replayed: boolean }> {
    await this.ready()
    const project = imageWorkbenchProjectSchema.parse(input.project)
    const request_hash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`project-${project.id}`, async () => {
      const prior = this.unitOfWork.database.query(`SELECT request_hash,result_project_json FROM image_reference_control_commands
        WHERE project_id=? AND idempotency_key=?`).get(project.id, input.idempotency_key) as { request_hash: string; result_project_json: string } | null
      if (prior) {
        if (prior.request_hash !== request_hash) {
          throw new ImageWorkbenchRepositoryError('参考图控制幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        return { project: imageWorkbenchProjectSchema.parse(JSON.parse(prior.result_project_json) as unknown), replayed: true }
      }
      const currentRow = this.projectRow(project.id)
      if (!currentRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(currentRow)
      if (current.revision !== input.base_revision || current.writer_fence !== project.writer_fence) {
        throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const next = imageWorkbenchProjectSchema.parse({
        ...project,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      this.unitOfWork.transaction(() => {
        this.persistProject(next)
        this.unitOfWork.database.query(`INSERT INTO image_reference_control_commands(
          project_id,idempotency_key,request_hash,result_project_json,created_at
        ) VALUES(?,?,?,?,?)`).run(next.id, input.idempotency_key, request_hash, JSON.stringify(next), next.updated_at)
      })
      return { project: next, replayed: false }
    })
  }

  async hasReferenceControlCommand(projectId: string, idempotencyKey: string, requestHash: string): Promise<boolean> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const request_hash = imageHashSchema.parse(requestHash)
    const prior = this.unitOfWork.database.query(`SELECT request_hash FROM image_reference_control_commands
      WHERE project_id=? AND idempotency_key=?`).get(projectId, idempotencyKey) as { request_hash: string } | null
    if (!prior) return false
    if (prior.request_hash !== request_hash) {
      throw new ImageWorkbenchRepositoryError('参考图控制幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
    }
    return true
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
    const duplicate = this.idempotentOperation(next)
    if (duplicate && duplicate.id !== next.id) return this.loadOperation(duplicate)
    this.unitOfWork.transaction(() => {
      this.persistOperation(next)
      if (changed) this.appendEvent(next)
    })
    if (changed) this.notify(next.project_id)
    return next
  }

  private idempotentOperation(operation: ImageOperation): OperationRow | null {
    if (!operation.idempotency_key || !operation.owner) return null
    const matching = this.unitOfWork.database.query(`SELECT * FROM image_operations
      WHERE owner_kind=? AND owner_id=? AND kind=? AND idempotency_key=? AND deleted=0`).get(
      operation.owner.kind,
      operation.owner.owner_id,
      operation.kind,
      operation.idempotency_key,
    ) as OperationRow | null
    if (!matching) return null
    if (matching.request_hash !== idempotencyRequestHash(operation)) {
      throw new ImageWorkbenchRepositoryError('图片操作幂等键对应的请求内容不一致', 409, 'IMAGE_STORAGE_INVALID')
    }
    return matching
  }

  private persistOperation(operation: ImageOperation): void {
    this.unitOfWork.database.query(`INSERT INTO image_operations(
      id,operation_id,project_id,owner_kind,owner_id,kind,status,status_sequence,idempotency_key,request_hash,remote_task_id,
      remote_result_acknowledged_at,updated_at,document_json,deleted
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    ON CONFLICT(id) DO UPDATE SET
      operation_id=excluded.operation_id,project_id=excluded.project_id,owner_kind=excluded.owner_kind,owner_id=excluded.owner_id,
      kind=excluded.kind,status=excluded.status,status_sequence=excluded.status_sequence,idempotency_key=excluded.idempotency_key,request_hash=excluded.request_hash,
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
      idempotencyRequestHash(operation),
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
      const identity = canonicalImageOperation({
        ...operationInput,
        owner: operationInput.owner ?? current?.owner ?? projectInput.owner,
      })
      const duplicate = this.idempotentOperation(identity)
      if (duplicate && duplicate.id !== operationInput.id) {
        if (!current) throw new ImageWorkbenchRepositoryError('图片幂等操作缺少项目', 500, 'IMAGE_STORAGE_INVALID')
        return { project: current, operation: this.loadOperation(duplicate) }
      }
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
      const duplicate = this.idempotentOperation(imported)
      if (duplicate && duplicate.id !== imported.id) return false
      this.unitOfWork.transaction(() => {
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

  /** Preserve an empty journal's cursor and gaps after the final event. */
  async preserveLegacyJournalCursor(projectId: string, nextCursor: number): Promise<void> {
    await this.ready()
    this.assertId(projectId, 'project')
    if (!Number.isInteger(nextCursor) || nextCursor < 1) {
      throw new ImageWorkbenchRepositoryError('旧图片事件游标无效', 500, 'IMAGE_STORAGE_INVALID')
    }
    await this.fences.run(`project-${projectId}`, async () => {
      if (!this.projectRow(projectId)) throw new ImageWorkbenchRepositoryError('旧图片事件缺少项目', 500, 'IMAGE_STORAGE_INVALID')
      this.unitOfWork.transaction(() => {
        const state = this.eventCursorState(projectId)
        if (!state) {
          this.unitOfWork.database.query(`INSERT INTO image_event_cursors(project_id,next_cursor,retained_from_cursor)
            VALUES(?,?,?)`).run(projectId, nextCursor, 1)
        } else {
          this.unitOfWork.database.query('UPDATE image_event_cursors SET next_cursor=MAX(next_cursor,?) WHERE project_id=?')
            .run(nextCursor, projectId)
        }
      })
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
    const inFlight = Boolean(this.unitOfWork.database.query(`SELECT 1 FROM image_operations
      WHERE deleted=0 AND status IN ('queued','running','committing') LIMIT 1`).get())
    const seen = new Set<string>()
    const now = this.iso()
    const eligibleBefore = this.now().getTime() - this.casOrphanRetentionMs
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue
      const contentHash = `sha256:${name}`
      seen.add(contentHash)
      if (reachable.has(name)) {
        this.unitOfWork.database.query('DELETE FROM image_cas_orphan_observations WHERE content_hash=?').run(contentHash)
        continue
      }
      // A committing operation may have published CAS bytes but not yet been
      // able to commit its Project transaction. Without a byte→operation link
      // at that crash boundary, protecting every orphan while work is in
      // flight is the conservative and correct ownership policy.
      if (inFlight) continue
      const observation = this.unitOfWork.database.query(`SELECT content_hash,first_unreachable_at,last_seen_at,scan_count
        FROM image_cas_orphan_observations WHERE content_hash=?`).get(contentHash) as CasOrphanObservationRow | null
      const firstSeenAt = observation ? Date.parse(observation.first_unreachable_at) : Number.NaN
      if (observation && observation.scan_count >= 1 && Number.isFinite(firstSeenAt) && firstSeenAt <= eligibleBefore) {
        const path = join(directory, name)
        await rm(path, { force: true })
        await syncParentDirectory(path)
        this.unitOfWork.database.query('DELETE FROM image_cas_orphan_observations WHERE content_hash=?').run(contentHash)
        continue
      }
      this.unitOfWork.database.query(`INSERT INTO image_cas_orphan_observations(
        content_hash,first_unreachable_at,last_seen_at,scan_count
      ) VALUES(?,?,?,1)
      ON CONFLICT(content_hash) DO UPDATE SET last_seen_at=excluded.last_seen_at,scan_count=image_cas_orphan_observations.scan_count+1`)
        .run(contentHash, now, now)
    }
    for (const observation of this.unitOfWork.database.query('SELECT content_hash FROM image_cas_orphan_observations').all() as Array<{ content_hash: string }>) {
      if (!seen.has(observation.content_hash)) {
        this.unitOfWork.database.query('DELETE FROM image_cas_orphan_observations WHERE content_hash=?').run(observation.content_hash)
      }
    }
    const owned = this.unitOfWork.database.query(`SELECT content_hash,byte_size,locator FROM image_asset_ownerships
      WHERE storage_kind='cas' AND content_hash IS NOT NULL`).all() as Array<{ content_hash: `sha256:${string}`; byte_size: number | null; locator: string }>
    for (const asset of owned) {
      const digest = /^sha256\/([a-f0-9]{64})$/.exec(asset.locator)?.[1]
      if (!digest) throw new ImageWorkbenchRepositoryError('图片 CAS 地址无效', 500, 'IMAGE_STORAGE_INVALID')
      await this.integrity.assert(join(directory, digest), asset.content_hash, asset.byte_size ?? undefined)
    }
  }

  /**
   * CAS collection remains blocked while the current JSON source cannot be
   * parsed or any completed receipt no longer matches its source snapshot.
   * This prevents both stale completion reports and source-change GC loss.
   */
  async reconcileCasAfterLegacyMigration(): Promise<boolean> {
    const source = await new LegacyImageProjectReader(this.root).read().catch(() => null)
    if (!source) return false
    const sourceProjectIds = new Set(source.projects.map(project => project.id))
    const receipts = this.unitOfWork.database.query(`SELECT project_id,source_hash FROM image_project_migration_receipts
      WHERE source_kind='image-workbench-json-v1' AND status='complete'`).all() as Array<{ project_id: string; source_hash: string }>
    let pending = false
    for (const project of source.projects) {
      const expectedSourceHash = legacyProjectSourceHash(source, project)
      const receipt = this.unitOfWork.database.query(`SELECT source_hash FROM image_project_migration_receipts
        WHERE source_kind='image-workbench-json-v1' AND project_id=? AND status='complete'`).get(project.id) as { source_hash: string } | null
      if (!receipt) {
        const invalidation = this.projectMigrationInvalidationRow('image-workbench-json-v1', project.id)
        if (invalidation && invalidation.source_hash !== expectedSourceHash) {
          this.markProjectMigrationSourceChanged('image-workbench-json-v1', project.id, expectedSourceHash, invalidation.previous_source_hash)
        }
        pending = true
        continue
      }
      if (receipt.source_hash !== expectedSourceHash) {
        this.markProjectMigrationSourceChanged('image-workbench-json-v1', project.id, expectedSourceHash, receipt.source_hash)
        pending = true
      }
    }
    for (const receipt of receipts) {
      if (!sourceProjectIds.has(receipt.project_id)) {
        this.markProjectMigrationSourceChanged('image-workbench-json-v1', receipt.project_id, 'source-missing', receipt.source_hash)
        pending = true
      }
    }
    if (pending) return false
    await this.collectCasOrphans()
    return true
  }

  /** 15.2 generation facts are immutable JSON contracts indexed by SQLite. */
  private generationDocument<T>(raw: { document_json: string }, parse: (value: unknown) => T): T {
    try {
      return parse(JSON.parse(raw.document_json))
    } catch {
      throw new ImageWorkbenchRepositoryError('图片生成领域记录无效', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  private assertGenerationProject(projectId: string): void {
    this.assertId(projectId, 'project')
    if (!this.projectRow(projectId)) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
  }

  async saveGenerationBrief(brief: ImageBriefSnapshot): Promise<ImageBriefSnapshot> {
    await this.ready()
    const input = imageBriefSnapshotSchema.parse(brief)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const existing = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_briefs
        WHERE project_id=? AND snapshot_hash=?`).get(input.project_id, input.snapshot_hash) as { document_json: string } | null
      if (existing) return this.generationDocument(existing, value => imageBriefSnapshotSchema.parse(value))
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO image_generation_briefs(id,project_id,snapshot_hash,created_at,document_json)
          VALUES(?,?,?,?,?)`).run(input.id, input.project_id, input.snapshot_hash, input.created_at, JSON.stringify(input))
      })
      return input
    })
  }

  async latestGenerationBrief(projectId: string): Promise<ImageBriefSnapshot | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_briefs
      WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId) as { document_json: string } | null
    return row ? this.generationDocument(row, value => imageBriefSnapshotSchema.parse(value)) : null
  }

  async saveDeliverySpec(spec: ImageDeliverySpec): Promise<ImageDeliverySpec> {
    await this.ready()
    const input = imageDeliverySpecSchema.parse(spec)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const existing = this.unitOfWork.database.query(`SELECT document_json FROM image_delivery_specs
        WHERE project_id=? AND revision=?`).get(input.project_id, input.revision) as { document_json: string } | null
      if (existing) return this.generationDocument(existing, value => imageDeliverySpecSchema.parse(value))
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO image_delivery_specs(id,project_id,revision,created_at,document_json)
          VALUES(?,?,?,?,?)`).run(input.id, input.project_id, input.revision, input.created_at, JSON.stringify(input))
      })
      return input
    })
  }

  async createDeliverySpecRevision(input: {
    project_id: string
    base_revision: number
    idempotency_key: string
    request_hash: string
    spec: ImageDeliverySpec
  }): Promise<{ project: ImageWorkbenchProject; spec: ImageDeliverySpec; replayed: boolean }> {
    await this.ready()
    const spec = imageDeliverySpecSchema.parse(input.spec)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`project-${input.project_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.projectRow(input.project_id)
      if (!row) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(row)
      const duplicate = this.unitOfWork.database.query(`SELECT request_hash,delivery_spec_id FROM image_delivery_spec_commands
        WHERE project_id=? AND idempotency_key=?`).get(input.project_id, input.idempotency_key) as { request_hash: string; delivery_spec_id: string } | null
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('交付规格幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const stored = this.unitOfWork.database.query('SELECT document_json FROM image_delivery_specs WHERE id=? AND project_id=?')
          .get(duplicate.delivery_spec_id, input.project_id) as { document_json: string } | null
        if (!stored) throw new ImageWorkbenchRepositoryError('交付规格重放记录损坏', 500, 'IMAGE_STORAGE_INVALID')
        return { project: current, spec: this.generationDocument(stored, value => imageDeliverySpecSchema.parse(value)), replayed: true }
      }
      if (current.revision !== input.base_revision) throw new ImageWorkbenchRepositoryError('图片项目已更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      const latest = this.unitOfWork.database.query('SELECT MAX(revision) AS revision FROM image_delivery_specs WHERE project_id=?').get(input.project_id) as { revision: number | null }
      if (spec.project_id !== input.project_id || spec.revision !== (latest.revision ?? -1) + 1) {
        throw new ImageWorkbenchRepositoryError('交付规格修订不是下一连续版本', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const project = imageWorkbenchProjectSchema.parse({
        ...current,
        current_delivery_spec_id: spec.id,
        current_delivery_spec_revision: spec.revision,
        revision: current.revision + 1,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: spec.created_at,
      })
      this.persistProject(project)
      this.unitOfWork.database.query(`INSERT INTO image_delivery_specs(id,project_id,revision,created_at,document_json)
        VALUES(?,?,?,?,?)`).run(spec.id, spec.project_id, spec.revision, spec.created_at, JSON.stringify(spec))
      this.unitOfWork.database.query(`INSERT INTO image_delivery_spec_commands(
        project_id,idempotency_key,request_hash,delivery_spec_id,created_at
      ) VALUES(?,?,?,?,?)`).run(input.project_id, input.idempotency_key, requestHash, spec.id, spec.created_at)
      return { project, spec, replayed: false }
    }))
  }

  async currentDeliverySpec(projectId: string): Promise<ImageDeliverySpec | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_delivery_specs
      WHERE project_id=? ORDER BY revision DESC LIMIT 1`).get(projectId) as { document_json: string } | null
    return row ? this.generationDocument(row, value => imageDeliverySpecSchema.parse(value)) : null
  }

  async getDeliverySpecRevision(projectId: string, specId: string, revision: number): Promise<ImageDeliverySpec> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_delivery_specs
      WHERE project_id=? AND id=? AND revision=?`).get(projectId, specId, revision) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('交付规格修订不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageDeliverySpecSchema.parse(value))
  }

  async saveBrandKitRevision(revision: ImageBrandKitRevision): Promise<ImageBrandKitRevision> {
    await this.ready()
    const value = imageBrandKitRevisionSchema.parse(revision)
    return await this.unitOfWork.transaction(() => {
      const existing = this.unitOfWork.database.query('SELECT document_json FROM image_brand_kit_revisions WHERE id=?').get(value.id) as { document_json: string } | null
      if (existing) return this.generationDocument(existing, item => imageBrandKitRevisionSchema.parse(item))
      this.unitOfWork.database.query(`INSERT INTO image_brand_kit_revisions(
        id,brand_kit_id,revision,owner_kind,owner_id,created_at,document_json
      ) VALUES(?,?,?,?,?,?,?)`).run(value.id, value.brand_kit_id, value.revision, value.owner.kind, value.owner.owner_id, value.created_at, JSON.stringify(value))
      return value
    })
  }

  async brandKitRevision(brandKitId: string, revisionId: string, owner: MediaOwner): Promise<ImageBrandKitRevision> {
    await this.ready()
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_brand_kit_revisions
      WHERE id=? AND brand_kit_id=? AND owner_kind=? AND owner_id=?`).get(revisionId, brandKitId, owner.kind, owner.owner_id) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('品牌 revision 不存在、无权访问或与品牌标识不匹配', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageBrandKitRevisionSchema.parse(value))
  }

  async brandKitRevisionById(revisionId: string, owner: MediaOwner): Promise<ImageBrandKitRevision> {
    await this.ready()
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_brand_kit_revisions
      WHERE id=? AND owner_kind=? AND owner_id=?`).get(revisionId, owner.kind, owner.owner_id) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('品牌 revision 不存在或无权访问', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageBrandKitRevisionSchema.parse(value))
  }

  async saveTemplateRevision(revision: ImageTemplateRevision): Promise<ImageTemplateRevision> {
    await this.ready()
    const value = imageTemplateRevisionSchema.parse(revision)
    return await this.unitOfWork.transaction(() => {
      const existing = this.unitOfWork.database.query('SELECT document_json FROM image_template_revisions WHERE id=?').get(value.id) as { document_json: string } | null
      if (existing) return this.generationDocument(existing, item => imageTemplateRevisionSchema.parse(item))
      this.unitOfWork.database.query(`INSERT INTO image_template_revisions(
        id,template_id,revision,owner_kind,owner_id,created_at,document_json
      ) VALUES(?,?,?,?,?,?,?)`).run(value.id, value.template_id, value.revision, value.owner.kind, value.owner.owner_id, value.created_at, JSON.stringify(value))
      return value
    })
  }

  async templateRevision(templateId: string, revisionId: string, owner: MediaOwner): Promise<ImageTemplateRevision> {
    await this.ready()
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_template_revisions
      WHERE id=? AND template_id=? AND owner_kind=? AND owner_id=?`).get(revisionId, templateId, owner.kind, owner.owner_id) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('模板 revision 不存在、无权访问或与模板标识不匹配', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageTemplateRevisionSchema.parse(value))
  }

  /** A Canvas revision is the only mutable-artwork write authority. */
  async getCanvasRevision(projectId: string, canvasId: string, revision?: number): Promise<ImageCanvasRevision> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT revisions.document_json FROM image_canvas_revisions revisions
      JOIN image_canvases canvases ON canvases.id=revisions.canvas_id
      WHERE canvases.project_id=? AND revisions.canvas_id=?${revision === undefined ? ' ORDER BY revisions.revision DESC LIMIT 1' : ' AND revisions.revision=?'}`)
      .get(...(revision === undefined ? [projectId, canvasId] : [projectId, canvasId, revision])) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('画布或画布修订不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageCanvasRevisionSchema.parse(value))
  }

  async listCanvasRevisions(projectId: string): Promise<ImageCanvasRevision[]> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const rows = this.unitOfWork.database.query(`SELECT revisions.document_json FROM image_canvas_revisions revisions
      JOIN image_canvases canvases ON canvases.id=revisions.canvas_id
      WHERE canvases.project_id=? AND revisions.revision=canvases.current_revision ORDER BY canvases.artboard_id ASC`)
      .all(projectId) as Array<{ document_json: string }>
    return rows.map(row => this.generationDocument(row, value => imageCanvasRevisionSchema.parse(value)))
  }

  /** Initial Canvas creation is idempotent per Artboard and must happen inside adoption's transaction. */
  private insertCanvasRevision(revision: ImageCanvasRevision): void {
    this.unitOfWork.database.query(`INSERT INTO image_canvases(id,project_id,artboard_id,current_revision,created_at)
      VALUES(?,?,?,?,?)`).run(
      revision.canvas_id, revision.document.project_id, revision.document.artboard_id, revision.revision, revision.created_at,
    )
    this.unitOfWork.database.query(`INSERT INTO image_canvas_revisions(
      canvas_id,revision,document_hash,parent_revision,created_at,document_json
    ) VALUES(?,?,?,?,?,?)`).run(
      revision.canvas_id, revision.revision, revision.document_hash, revision.parent_revision ?? null, revision.created_at, JSON.stringify(revision),
    )
  }

  async createCanvas(input: {
    project_id: string
    base_project_revision: number
    idempotency_key: string
    request_hash: string
    canvas: ImageCanvasRevision
  }): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision; replayed: boolean }> {
    await this.ready()
    const canvas = imageCanvasRevisionSchema.parse(input.canvas)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`project-${input.project_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.projectRow(input.project_id)
      if (!row) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(row)
      const duplicate = this.unitOfWork.database.query(`SELECT commands.request_hash,commands.result_revision,canvases.id AS canvas_id FROM image_canvas_commands commands
        JOIN image_canvases canvases ON canvases.id=commands.canvas_id
        WHERE commands.project_id=? AND canvases.artboard_id=? AND commands.idempotency_key=?`).get(
        input.project_id, canvas.document.artboard_id, input.idempotency_key,
      ) as { request_hash: string; result_revision: number; canvas_id: string } | null
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('创建画布幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        return { project: current, canvas: this.canvasRevisionRow(input.project_id, duplicate.canvas_id, duplicate.result_revision), replayed: true }
      }
      if (current.revision !== input.base_project_revision) throw new ImageWorkbenchRepositoryError('图片项目已更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      const existing = this.unitOfWork.database.query('SELECT id FROM image_canvases WHERE project_id=? AND artboard_id=?')
        .get(input.project_id, canvas.document.artboard_id) as { id: string } | null
      if (existing) throw new ImageWorkbenchRepositoryError('该画板已经有正式画布', 409, 'IMAGE_REVISION_CONFLICT')
      if (canvas.revision !== 0 || canvas.document.project_id !== input.project_id) throw new ImageWorkbenchRepositoryError('初始画布事实无效', 409, 'IMAGE_STORAGE_INVALID')
      const project = imageWorkbenchProjectSchema.parse({
        ...current,
        revision: current.revision + 1,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: canvas.created_at,
      })
      this.persistProject(project)
      this.insertCanvasRevision(canvas)
      this.unitOfWork.database.query(`INSERT INTO image_canvas_commands(
        project_id,canvas_id,idempotency_key,request_hash,result_revision,created_at
      ) VALUES(?,?,?,?,?,?)`).run(input.project_id, canvas.canvas_id, input.idempotency_key, requestHash, 0, canvas.created_at)
      return { project, canvas, replayed: false }
    }))
  }

  async applyCanvasCommand(input: {
    project_id: string
    canvas_id: string
    base_project_revision: number
    command: ImageCanvasCommandInput
    request_hash: string
    created_at: string
    delivery_artboard?: { width: number; height: number; safe_area?: { top: number; right: number; bottom: number; left: number } }
    template?: ImageTemplateRevision
  }): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision; replayed: boolean }> {
    await this.ready()
    const command = imageCanvasCommandInputSchema.parse(input.command)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`project-${input.project_id}`, async () => this.unitOfWork.transaction(() => {
      const projectRow = this.projectRow(input.project_id)
      if (!projectRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(projectRow)
      const duplicate = this.unitOfWork.database.query(`SELECT request_hash,result_revision FROM image_canvas_commands
        WHERE project_id=? AND canvas_id=? AND idempotency_key=?`).get(input.project_id, input.canvas_id, command.idempotency_key) as { request_hash: string; result_revision: number } | null
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('画布命令幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const canvas = this.canvasRevisionRow(input.project_id, input.canvas_id, duplicate.result_revision)
        return { project: current, canvas, replayed: true }
      }
      if (current.revision !== input.base_project_revision) {
        throw new ImageWorkbenchRepositoryError('图片项目已更新，请刷新画布后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const currentCanvas = this.canvasRevisionRow(input.project_id, input.canvas_id)
      if (currentCanvas.revision !== command.base_revision) {
        throw new ImageWorkbenchRepositoryError('画布修订已更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      let document
      try {
        document = applyCanvasCommandDocument(currentCanvas.document, command, input.delivery_artboard, input.template)
      } catch (error) {
        if (error instanceof ImageCanvasCommandError) throw new ImageWorkbenchRepositoryError(error.message, 400, 'IMAGE_STORAGE_INVALID')
        throw error
      }
      const canvas = imageCanvasRevisionSchema.parse({
        canvas_id: currentCanvas.canvas_id,
        revision: currentCanvas.revision + 1,
        parent_revision: currentCanvas.revision,
        document_hash: this.documentHash(document),
        document,
        created_at: input.created_at,
      })
      const project = imageWorkbenchProjectSchema.parse({
        ...current,
        revision: current.revision + 1,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      this.persistProject(project)
      this.unitOfWork.database.query('UPDATE image_canvases SET current_revision=? WHERE id=?')
        .run(canvas.revision, canvas.canvas_id)
      this.unitOfWork.database.query(`INSERT INTO image_canvas_revisions(
        canvas_id,revision,document_hash,parent_revision,created_at,document_json
      ) VALUES(?,?,?,?,?,?)`).run(canvas.canvas_id, canvas.revision, canvas.document_hash, canvas.parent_revision ?? null, canvas.created_at, JSON.stringify(canvas))
      this.unitOfWork.database.query(`INSERT INTO image_canvas_commands(
        project_id,canvas_id,idempotency_key,request_hash,result_revision,created_at
      ) VALUES(?,?,?,?,?,?)`).run(input.project_id, input.canvas_id, command.idempotency_key, requestHash, canvas.revision, input.created_at)
      return { project, canvas, replayed: false }
    }))
  }

  async saveCanvasPreflight(preflight: ImageCanvasPreflight): Promise<ImageCanvasPreflight> {
    await this.ready()
    const input = imageCanvasPreflightSchema.parse(preflight)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const prior = this.unitOfWork.database.query('SELECT document_json FROM image_canvas_preflights WHERE id=? AND project_id=?')
        .get(input.id, input.project_id) as { document_json: string } | null
      if (prior) return this.generationDocument(prior, value => imageCanvasPreflightSchema.parse(value))
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO image_canvas_preflights(id,project_id,canvas_id,canvas_revision,document_json,created_at)
          VALUES(?,?,?,?,?,?)`).run(input.id, input.project_id, input.canvas_id, input.canvas_revision, JSON.stringify(input), input.created_at)
      })
      return input
    })
  }

  async getRenderReceipt(projectId: string, receiptId: string): Promise<ImageRenderReceipt> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_render_receipts WHERE id=? AND project_id=?')
      .get(receiptId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('画布渲染收据不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageRenderReceiptSchema.parse(value))
  }

  async getReleaseCheckResult(projectId: string, resultId: string): Promise<ImageReleaseCheckResult> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_release_check_results WHERE id=? AND project_id=?')
      .get(resultId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('发布检查结果不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageReleaseCheckResultSchema.parse(value))
  }

  async getDeliverySet(projectId: string, deliverySetId: string): Promise<ImageDeliverySet> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_delivery_sets WHERE id=? AND project_id=?')
      .get(deliverySetId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('交付集不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageDeliverySetSchema.parse(value))
  }

  async getExportReceipt(projectId: string, receiptId: string): Promise<ImageExportReceipt> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_export_receipts WHERE id=? AND project_id=?')
      .get(receiptId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('导出收据不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageExportReceiptSchema.parse(value))
  }

  /**
   * CAS bytes are persisted before this transaction.  This is the sole point
   * where those bytes become a formal Version, RenderReceipt and release fact;
   * therefore a crash before it merely leaves an unreferenced CAS object and a
   * retry may safely render/reuse the same immutable revision.
   */
  async commitCanvasRender(input: {
    project_id: string
    artboard_id: string
    expected_current_version_id?: string
    expected_canvas_current_revision: number
    activate_on_success: boolean
    operation: ImageOperationV2
    asset: MediaAsset
    version: MediaVersion
    receipt: ImageRenderReceipt
    release_check: ImageReleaseCheckResult
  }): Promise<{ project: ImageWorkbenchProject; operation: ImageOperationV2; version: MediaVersion; freshness: 'current' | 'stale' }> {
    await this.ready()
    const operation = imageOperationV2Schema.parse(input.operation)
    const receipt = imageRenderReceiptSchema.parse(input.receipt)
    const releaseCheck = imageReleaseCheckResultSchema.parse(input.release_check)
    if (operation.project_id !== input.project_id || receipt.canvas_id !== input.version.canvas_id || receipt.version_id !== input.version.id
      || releaseCheck.version_id !== input.version.id || releaseCheck.export_asset_id !== input.asset.id) {
      throw new ImageWorkbenchRepositoryError('画布渲染提交事实不一致', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`project-${input.project_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.projectRow(input.project_id)
      if (!row) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(row)
      const duplicate = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_generation_operations
        WHERE project_id=? AND idempotency_key=?`).get(input.project_id, operation.idempotency_key) as { document_json: string; request_hash: string } | null
      if (duplicate) {
        if (duplicate.request_hash !== operation.request_hash) throw new ImageWorkbenchRepositoryError('画布渲染幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const previous = this.loadGenerationOperation(duplicate)
        const renderedResult = previous.result
        const rendered = renderedResult?.kind === 'rendered_version' ? current.versions.find(version => version.id === renderedResult.version_id) : undefined
        if (rendered) return { project: current, operation: previous, version: rendered, freshness: previous.completion_freshness ?? 'stale' }
        if (!['queued', 'running', 'committing'].includes(previous.status)) {
          throw new ImageWorkbenchRepositoryError('画布渲染幂等记录缺少版本', 500, 'IMAGE_STORAGE_INVALID')
        }
      }
      const canvas = this.canvasRevisionRow(input.project_id, receipt.canvas_id, receipt.canvas_revision)
      if (canvas.document_hash !== receipt.document_hash) throw new ImageWorkbenchRepositoryError('画布渲染收据与文档不一致', 409, 'IMAGE_STORAGE_INVALID')
      const latestCanvas = this.canvasRevisionRow(input.project_id, receipt.canvas_id)
      const freshness: 'current' | 'stale' = current.current_versions_by_artboard[input.artboard_id] === input.expected_current_version_id
        && latestCanvas.revision === input.expected_canvas_current_revision
        ? 'current'
        : 'stale'
      const version = {
        ...input.version,
        project_revision: current.revision + 1,
        artboard_id: input.artboard_id,
        canvas_id: receipt.canvas_id,
        canvas_revision: receipt.canvas_revision,
        canvas_document_hash: receipt.document_hash,
        render_receipt_id: receipt.id,
        content_hash: input.asset.content_hash,
      } satisfies MediaVersion
      const committedOperation = imageOperationV2Schema.parse({
        ...operation,
        status: 'succeeded',
        completion_freshness: freshness,
        result: { kind: 'rendered_version', version_id: version.id, render_receipt_id: receipt.id },
        completed_at: operation.completed_at ?? receipt.created_at,
        updated_at: receipt.created_at,
      })
      const project = imageWorkbenchProjectSchema.parse({
        ...current,
        state: 'ready',
        assets: current.assets.some(asset => asset.id === input.asset.id) ? current.assets : [...current.assets, input.asset],
        versions: current.versions.some(item => item.id === version.id) ? current.versions : [...current.versions, version],
        current_versions_by_artboard: input.activate_on_success && freshness === 'current'
          ? { ...current.current_versions_by_artboard, [input.artboard_id]: version.id }
          : current.current_versions_by_artboard,
        revision: current.revision + 1,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: receipt.created_at,
        error: undefined,
        error_code: undefined,
      })
      this.persistProject(project)
      this.persistGenerationOperation(committedOperation)
      this.unitOfWork.database.query(`INSERT INTO image_render_receipts(
        id,project_id,canvas_id,canvas_revision,version_id,document_json,created_at
      ) VALUES(?,?,?,?,?,?,?)`).run(receipt.id, input.project_id, receipt.canvas_id, receipt.canvas_revision, version.id, JSON.stringify(receipt), receipt.created_at)
      this.unitOfWork.database.query(`INSERT INTO image_release_check_results(
        id,project_id,version_id,document_json,created_at
      ) VALUES(?,?,?,?,?)`).run(releaseCheck.id, input.project_id, version.id, JSON.stringify(releaseCheck), releaseCheck.created_at)
      const selectedVersionId = project.current_versions_by_artboard[input.artboard_id]
      if (selectedVersionId) {
        this.unitOfWork.database.query(`INSERT INTO image_project_working_versions(project_id,artboard_id,version_id,updated_at)
          VALUES(?,?,?,?) ON CONFLICT(project_id,artboard_id) DO UPDATE SET version_id=excluded.version_id,updated_at=excluded.updated_at`)
          .run(input.project_id, input.artboard_id, selectedVersionId, receipt.created_at)
      }
      return { project, operation: committedOperation, version, freshness }
    }))
  }

  async commitExport(input: {
    project_id: string
    operation: ImageOperationV2
    assets: MediaAsset[]
    export_receipts: ImageExportReceipt[]
    delivery_set?: ImageDeliverySet
  }): Promise<{ project: ImageWorkbenchProject; operation: ImageOperationV2 }> {
    await this.ready()
    const operation = imageOperationV2Schema.parse(input.operation)
    const receipts = input.export_receipts.map(receipt => imageExportReceiptSchema.parse(receipt))
    const deliverySet = input.delivery_set ? imageDeliverySetSchema.parse(input.delivery_set) : undefined
    return await this.fences.run(`project-${input.project_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.projectRow(input.project_id)
      if (!row) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(row)
      const duplicate = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_generation_operations
        WHERE project_id=? AND idempotency_key=?`).get(input.project_id, operation.idempotency_key) as { document_json: string; request_hash: string } | null
      if (duplicate) {
        if (duplicate.request_hash !== operation.request_hash) throw new ImageWorkbenchRepositoryError('图片导出幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const previous = this.loadGenerationOperation(duplicate)
        if (previous.result?.kind === 'export_receipts') return { project: current, operation: previous }
        if (!['queued', 'running', 'committing'].includes(previous.status)) {
          throw new ImageWorkbenchRepositoryError('图片导出幂等记录缺少收据', 500, 'IMAGE_STORAGE_INVALID')
        }
      }
      if (receipts.length === 0 || receipts.some(receipt => receipt.project_id !== input.project_id)
        || deliverySet?.project_id !== input.project_id) throw new ImageWorkbenchRepositoryError('图片导出事实无效', 409, 'IMAGE_STORAGE_INVALID')
      const committedOperation = imageOperationV2Schema.parse({
        ...operation,
        status: 'succeeded',
        result: { kind: 'export_receipts', export_receipt_ids: receipts.map(receipt => receipt.id), delivery_set_id: deliverySet?.id },
        completed_at: operation.completed_at ?? receipts[0]!.created_at,
        updated_at: receipts[0]!.created_at,
      })
      const project = imageWorkbenchProjectSchema.parse({
        ...current,
        assets: [...current.assets, ...input.assets.filter(asset => !current.assets.some(existing => existing.id === asset.id))],
        latest_delivery_set_id: deliverySet?.id ?? current.latest_delivery_set_id,
        revision: current.revision + 1,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: receipts[0]!.created_at,
      })
      this.persistProject(project)
      this.persistGenerationOperation(committedOperation)
      for (const receipt of receipts) {
        this.unitOfWork.database.query(`INSERT INTO image_export_receipts(
          id,project_id,artboard_id,version_id,document_json,created_at
        ) VALUES(?,?,?,?,?,?)`).run(receipt.id, receipt.project_id, receipt.artboard_id, receipt.version_id, JSON.stringify(receipt), receipt.created_at)
      }
      if (deliverySet) {
        this.unitOfWork.database.query(`INSERT INTO image_delivery_sets(
          id,project_id,delivery_spec_id,delivery_spec_revision,document_json,created_at
        ) VALUES(?,?,?,?,?,?)`).run(deliverySet.id, deliverySet.project_id, deliverySet.delivery_spec_id, deliverySet.delivery_spec_revision, JSON.stringify(deliverySet), deliverySet.created_at)
      }
      return { project, operation: committedOperation }
    }))
  }

  private canvasRevisionRow(projectId: string, canvasId: string, revision?: number): ImageCanvasRevision {
    const row = this.unitOfWork.database.query(`SELECT revisions.document_json FROM image_canvas_revisions revisions
      JOIN image_canvases canvases ON canvases.id=revisions.canvas_id
      WHERE canvases.project_id=? AND revisions.canvas_id=?${revision === undefined ? ' AND revisions.revision=canvases.current_revision' : ' AND revisions.revision=?'}`)
      .get(...(revision === undefined ? [projectId, canvasId] : [projectId, canvasId, revision])) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('画布或画布修订不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageCanvasRevisionSchema.parse(value))
  }

  private documentHash(value: unknown): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
  }

  async saveGenerationEstimate(estimate: ImageGenerationEstimate): Promise<ImageGenerationEstimate> {
    await this.ready()
    const input = imageGenerationEstimateSchema.parse(estimate)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const existing = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_estimates
        WHERE estimate_hash=?`).get(input.estimate_hash) as { document_json: string } | null
      if (existing) return this.generationDocument(existing, value => imageGenerationEstimateSchema.parse(value))
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO image_generation_estimates(
          estimate_hash,project_id,kind,request_hash,expires_at,created_at,document_json
        ) VALUES(?,?,?,?,?,?,?)`).run(
          input.estimate_hash, input.project_id, input.kind, input.request_hash, input.expires_at, input.created_at, JSON.stringify(input),
        )
      })
      return input
    })
  }

  async getGenerationEstimate(projectId: string, estimateHash: string): Promise<ImageGenerationEstimate> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const estimate_hash = imageHashSchema.parse(estimateHash)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_estimates
      WHERE estimate_hash=? AND project_id=?`).get(estimate_hash, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('生成费用估算不存在或不属于当前项目', 409, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageGenerationEstimateSchema.parse(value))
  }

  async saveCreativePlan(plan: ImageCreativePlan, requestHash: string): Promise<ImageCreativePlan> {
    await this.ready()
    const input = imageCreativePlanSchema.parse(plan)
    const request_hash = imageHashSchema.parse(requestHash)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const existing = this.unitOfWork.database.query('SELECT project_id,document_json,request_hash FROM image_creative_plans WHERE id=?')
        .get(input.id) as { project_id: string; document_json: string; request_hash: string } | null
      if (existing) {
        if (existing.project_id !== input.project_id || existing.request_hash !== request_hash) {
          throw new ImageWorkbenchRepositoryError('创作方向幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        return this.generationDocument(existing, value => imageCreativePlanSchema.parse(value))
      }
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO image_creative_plans(id,project_id,brief_snapshot_hash,created_at,document_json,request_hash)
          VALUES(?,?,?,?,?,?)`).run(input.id, input.project_id, input.brief_snapshot_hash, input.created_at, JSON.stringify(input), request_hash)
      })
      return input
    })
  }

  async getCreativePlan(projectId: string, planId: string): Promise<ImageCreativePlan> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_creative_plans WHERE id=? AND project_id=?')
      .get(planId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('创作方向不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageCreativePlanSchema.parse(value))
  }

  private loadGenerationOperation(row: { document_json: string }): ImageOperationV2 {
    return this.generationDocument(row, value => imageOperationV2Schema.parse(value))
  }

  private persistGenerationOperation(input: ImageOperationV2): void {
    this.unitOfWork.database.query(`INSERT INTO image_generation_operations(
      id,project_id,transport_task_id,kind,status,idempotency_key,request_hash,created_at,updated_at,document_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET transport_task_id=excluded.transport_task_id,kind=excluded.kind,status=excluded.status,
      idempotency_key=excluded.idempotency_key,request_hash=excluded.request_hash,updated_at=excluded.updated_at,document_json=excluded.document_json`).run(
      input.id, input.project_id, input.transport_task_id ?? null, input.kind, input.status, input.idempotency_key,
      input.request_hash, input.created_at, input.updated_at, JSON.stringify(input),
    )
  }

  async saveGenerationOperation(operation: ImageOperationV2): Promise<ImageOperationV2> {
    await this.ready()
    const input = imageOperationV2Schema.parse(operation)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const duplicate = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_generation_operations
        WHERE project_id=? AND idempotency_key=?`).get(input.project_id, input.idempotency_key) as { document_json: string; request_hash: string } | null
      if (duplicate && duplicate.request_hash !== input.request_hash) {
        throw new ImageWorkbenchRepositoryError('图片操作幂等键对应的请求内容不一致', 409, 'IMAGE_STORAGE_INVALID')
      }
      if (duplicate) return this.loadGenerationOperation(duplicate)
      this.unitOfWork.transaction(() => this.persistGenerationOperation(input))
      return input
    })
  }

  async updateGenerationOperation(operation: ImageOperationV2): Promise<ImageOperationV2> {
    await this.ready()
    const input = imageOperationV2Schema.parse(operation)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const previous = this.unitOfWork.database.query('SELECT document_json,request_hash FROM image_generation_operations WHERE id=?')
        .get(input.id) as { document_json: string; request_hash: string } | null
      if (!previous) throw new ImageWorkbenchRepositoryError('图片生成操作不存在', 404, 'IMAGE_OPERATION_NOT_FOUND')
      if (previous.request_hash !== input.request_hash) {
        throw new ImageWorkbenchRepositoryError('图片操作请求身份不能改变', 409, 'IMAGE_STORAGE_INVALID')
      }
      this.unitOfWork.transaction(() => this.persistGenerationOperation(input))
      return input
    })
  }

  async getGenerationOperation(projectId: string, operationId: string): Promise<ImageOperationV2> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_generation_operations WHERE id=? AND project_id=?')
      .get(operationId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('图片生成操作不存在', 404, 'IMAGE_OPERATION_NOT_FOUND')
    return this.loadGenerationOperation(row)
  }

  async getGenerationOperationByTransportTask(taskId: string): Promise<ImageOperationV2 | null> {
    await this.ready()
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_operations
      WHERE transport_task_id=?`).get(taskId) as { document_json: string } | null
    return row ? this.loadGenerationOperation(row) : null
  }

  async findGenerationOperation(operationId: string): Promise<ImageOperationV2 | null> {
    await this.ready()
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_generation_operations WHERE id=?')
      .get(operationId) as { document_json: string } | null
    return row ? this.loadGenerationOperation(row) : null
  }

  async listGenerationOperations(projectId: string): Promise<ImageOperationV2[]> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_operations
      WHERE project_id=? ORDER BY created_at ASC`).all(projectId) as Array<{ document_json: string }>
    return rows.map(row => this.loadGenerationOperation(row))
  }

  async saveExecutionReceipt(receipt: ProviderExecutionReceipt): Promise<ProviderExecutionReceipt> {
    await this.ready()
    const input = providerExecutionReceiptSchema.parse(receipt)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      return this.unitOfWork.transaction(() => this.persistExecutionReceipt(input))
    })
  }

  /** A receipt may gain terminal facts once, but its charged request identity never changes. */
  private persistExecutionReceipt(input: ProviderExecutionReceipt): ProviderExecutionReceipt {
    const existing = this.unitOfWork.database.query(`SELECT document_json FROM image_provider_execution_receipts
      WHERE id=?`).get(input.id) as { document_json: string } | null
    if (!existing) {
      const duplicate = this.unitOfWork.database.query(`SELECT document_json FROM image_provider_execution_receipts
        WHERE project_id=? AND idempotency_key=?`).get(input.project_id, input.idempotency_key) as { document_json: string } | null
      if (duplicate) {
        const prior = this.generationDocument(duplicate, value => providerExecutionReceiptSchema.parse(value))
        if (prior.request_hash !== input.request_hash) {
          throw new ImageWorkbenchRepositoryError('图片执行回执幂等键冲突', 409, 'IMAGE_STORAGE_INVALID')
        }
        return prior
      }
      this.unitOfWork.database.query(`INSERT INTO image_provider_execution_receipts(
        id,project_id,idempotency_key,request_hash,submitted_at,document_json
      ) VALUES(?,?,?,?,?,?)`).run(input.id, input.project_id, input.idempotency_key, input.request_hash, input.submitted_at, JSON.stringify(input))
      return input
    }
    const prior = this.generationDocument(existing, value => providerExecutionReceiptSchema.parse(value))
    if (
      prior.project_id !== input.project_id
      || prior.idempotency_key !== input.idempotency_key
      || prior.request_hash !== input.request_hash
      || prior.provider !== input.provider
      || prior.model_id !== input.model_id
      || prior.policy_revision !== input.policy_revision
      || prior.submitted_at !== input.submitted_at
    ) {
      throw new ImageWorkbenchRepositoryError('图片执行回执身份不能改变', 409, 'IMAGE_STORAGE_INVALID')
    }
    if (!input.completed_at) return prior
    if (prior.completed_at) {
      const sameTerminalFacts = prior.completed_at === input.completed_at
        && JSON.stringify(prior.output_asset_hashes ?? []) === JSON.stringify(input.output_asset_hashes ?? [])
        && JSON.stringify(prior.refusal ?? null) === JSON.stringify(input.refusal ?? null)
      if (!sameTerminalFacts) throw new ImageWorkbenchRepositoryError('图片执行回执终态不能改变', 409, 'IMAGE_STORAGE_INVALID')
      return prior
    }
    const completed = providerExecutionReceiptSchema.parse({
      ...prior,
      ...(input.provider_request_id ? { provider_request_id: input.provider_request_id } : {}),
      ...(input.output_asset_hashes ? { output_asset_hashes: input.output_asset_hashes } : {}),
      ...(input.refusal ? { refusal: input.refusal } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      completed_at: input.completed_at,
    })
    this.unitOfWork.database.query(`UPDATE image_provider_execution_receipts SET document_json=? WHERE id=?`)
      .run(JSON.stringify(completed), completed.id)
    return completed
  }

  async getExecutionReceipt(projectId: string, receiptId: string): Promise<ProviderExecutionReceipt> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_provider_execution_receipts WHERE id=? AND project_id=?')
      .get(receiptId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('图片执行回执不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => providerExecutionReceiptSchema.parse(value))
  }

  /** Qwen advice and its immutable remote receipt commit together, never touching user facts. */
  async saveUnderstandingSuggestionWithReceipt(
    suggestion: ImageUnderstandingSuggestion,
    receipt: ProviderExecutionReceipt,
    requestHash: string,
  ): Promise<ImageUnderstandingSuggestion> {
    await this.ready()
    const input = imageUnderstandingSuggestionSchema.parse(suggestion)
    const execution = providerExecutionReceiptSchema.parse(receipt)
    const request_hash = imageHashSchema.parse(requestHash)
    if (input.project_id !== execution.project_id || input.execution_receipt_id !== execution.id) {
      throw new ImageWorkbenchRepositoryError('Qwen 建议与执行回执不匹配', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      return this.unitOfWork.transaction(() => {
        const prior = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_understanding_suggestions
          WHERE project_id=? AND idempotency_key=?`).get(input.project_id, execution.idempotency_key) as { document_json: string; request_hash: string } | null
        if (prior) {
          if (prior.request_hash !== request_hash) throw new ImageWorkbenchRepositoryError('Qwen 建议幂等键冲突', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
          return this.generationDocument(prior, value => imageUnderstandingSuggestionSchema.parse(value))
        }
        this.persistExecutionReceipt(execution)
        this.unitOfWork.database.query(`INSERT INTO image_understanding_suggestions(
          id,project_id,execution_receipt_id,idempotency_key,request_hash,created_at,document_json
        ) VALUES(?,?,?,?,?,?,?)`).run(input.id, input.project_id, input.execution_receipt_id, execution.idempotency_key, request_hash, input.created_at, JSON.stringify(input))
        return input
      })
    })
  }

  async saveVisualAssessmentWithReceipt(
    assessment: ImageVisualAssessment,
    receipt: ProviderExecutionReceipt,
    requestHash: string,
  ): Promise<ImageVisualAssessment> {
    await this.ready()
    const input = imageVisualAssessmentSchema.parse(assessment)
    const execution = providerExecutionReceiptSchema.parse(receipt)
    const request_hash = imageHashSchema.parse(requestHash)
    if (input.project_id !== execution.project_id || input.execution_receipt_id !== execution.id) {
      throw new ImageWorkbenchRepositoryError('Qwen 评估与执行回执不匹配', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      return this.unitOfWork.transaction(() => {
        const prior = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_visual_assessments
          WHERE project_id=? AND idempotency_key=?`).get(input.project_id, execution.idempotency_key) as { document_json: string; request_hash: string } | null
        if (prior) {
          if (prior.request_hash !== request_hash) throw new ImageWorkbenchRepositoryError('Qwen 评估幂等键冲突', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
          return this.generationDocument(prior, value => imageVisualAssessmentSchema.parse(value))
        }
        this.persistExecutionReceipt(execution)
        this.unitOfWork.database.query(`INSERT INTO image_visual_assessments(
          id,project_id,candidate_id,version_id,execution_receipt_id,idempotency_key,request_hash,created_at,document_json
        ) VALUES(?,?,?,?,?,?,?,?,?)`).run(input.id, input.project_id, input.candidate_id ?? null, input.version_id ?? null, input.execution_receipt_id, execution.idempotency_key, request_hash, input.created_at, JSON.stringify(input))
        return input
      })
    })
  }

  async latestUnderstandingSuggestion(projectId: string): Promise<ImageUnderstandingSuggestion | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_understanding_suggestions
      WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(projectId) as { document_json: string } | null
    return row ? this.generationDocument(row, value => imageUnderstandingSuggestionSchema.parse(value)) : null
  }

  async understandingSuggestionByIdempotency(projectId: string, idempotencyKey: string): Promise<{ suggestion: ImageUnderstandingSuggestion; request_hash: string } | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_understanding_suggestions
      WHERE project_id=? AND idempotency_key=?`).get(projectId, idempotencyKey) as { document_json: string; request_hash: string } | null
    return row ? { suggestion: this.generationDocument(row, value => imageUnderstandingSuggestionSchema.parse(value)), request_hash: row.request_hash } : null
  }

  async latestVisualAssessmentForCandidate(projectId: string, candidateId: string): Promise<ImageVisualAssessment | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_visual_assessments
      WHERE project_id=? AND candidate_id=? ORDER BY created_at DESC LIMIT 1`).get(projectId, candidateId) as { document_json: string } | null
    return row ? this.generationDocument(row, value => imageVisualAssessmentSchema.parse(value)) : null
  }

  async visualAssessmentByIdempotency(projectId: string, idempotencyKey: string): Promise<{ assessment: ImageVisualAssessment; request_hash: string } | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_visual_assessments
      WHERE project_id=? AND idempotency_key=?`).get(projectId, idempotencyKey) as { document_json: string; request_hash: string } | null
    return row ? { assessment: this.generationDocument(row, value => imageVisualAssessmentSchema.parse(value)), request_hash: row.request_hash } : null
  }

  async saveGenerationRound(round: ImageGenerationRound, requestHash: string): Promise<ImageGenerationRound> {
    await this.ready()
    const input = imageGenerationRoundSchema.parse(round)
    const request_hash = imageHashSchema.parse(requestHash)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      this.assertGenerationProject(input.project_id)
      const existing = this.unitOfWork.database.query('SELECT project_id,document_json,request_hash FROM image_generation_rounds WHERE id=?')
        .get(input.id) as { project_id: string; document_json: string; request_hash: string } | null
      if (existing) {
        if (existing.project_id !== input.project_id || existing.request_hash !== request_hash) {
          throw new ImageWorkbenchRepositoryError('生成轮次幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        return this.generationDocument(existing, value => imageGenerationRoundSchema.parse(value))
      }
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO image_generation_rounds(id,project_id,creative_plan_id,estimate_hash,confirmed_at,document_json,request_hash)
          VALUES(?,?,?,?,?,?,?)`).run(input.id, input.project_id, input.creative_plan_id, input.estimate_hash, input.confirmed_at, JSON.stringify(input), request_hash)
      })
      return input
    })
  }

  async getGenerationRound(projectId: string, roundId: string): Promise<ImageGenerationRound> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_generation_rounds WHERE id=? AND project_id=?')
      .get(roundId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('生成轮次不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageGenerationRoundSchema.parse(value))
  }

  async generationRoundRequestHash(projectId: string, roundId: string): Promise<string> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT request_hash FROM image_generation_rounds WHERE id=? AND project_id=?')
      .get(roundId, projectId) as { request_hash: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('生成轮次不存在', 404, 'IMAGE_STORAGE_INVALID')
    return row.request_hash
  }

  async generationRoundForOperation(projectId: string, operationId: string): Promise<ImageGenerationRound> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_rounds
      WHERE project_id=? ORDER BY confirmed_at DESC`).all(projectId) as Array<{ document_json: string }>
    const round = rows
      .map(row => this.generationDocument(row, value => imageGenerationRoundSchema.parse(value)))
      .find(candidate => candidate.direction_operations.some(direction => direction.operation_id === operationId))
    if (!round) throw new ImageWorkbenchRepositoryError('图片生成操作缺少轮次', 500, 'IMAGE_STORAGE_INVALID')
    return round
  }

  /** The Round mapping and every paid Direction are committed before any POST. */
  async createGenerationRoundWithOperations(input: {
    project: ImageWorkbenchProject
    base_revision: number
    request_hash: string
    round: ImageGenerationRound
    operations: ImageOperationV2[]
    transport_operations: ImageOperation[]
  }): Promise<{ project: ImageWorkbenchProject; round: ImageGenerationRound; operations: ImageOperationV2[]; transport_operations: ImageOperation[] }> {
    await this.ready()
    const projectInput = imageWorkbenchProjectSchema.parse(input.project)
    const request_hash = imageHashSchema.parse(input.request_hash)
    const round = imageGenerationRoundSchema.parse(input.round)
    const operations = input.operations.map(operation => imageOperationV2Schema.parse(operation))
    const transports = input.transport_operations.map(operation => canonicalImageOperation(operation))
    if (round.project_id !== projectInput.id || operations.length === 0 || operations.length !== transports.length
      || operations.some(operation => operation.project_id !== projectInput.id)
      || transports.some(operation => operation.project_id !== projectInput.id)
      || new Set(operations.map(operation => operation.id)).size !== operations.length) {
      throw new ImageWorkbenchRepositoryError('图片生成轮次操作无效', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`project-${projectInput.id}`, async () => {
      const currentRow = this.projectRow(projectInput.id)
      if (!currentRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(currentRow)
      if (current.revision !== input.base_revision || current.writer_fence !== projectInput.writer_fence) {
        throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const existingRound = this.unitOfWork.database.query('SELECT document_json,request_hash FROM image_generation_rounds WHERE id=?')
        .get(round.id) as { document_json: string; request_hash: string } | null
      if (existingRound) {
        const restored = this.generationDocument(existingRound, value => imageGenerationRoundSchema.parse(value))
        if (restored.project_id !== projectInput.id || restored.estimate_hash !== round.estimate_hash || existingRound.request_hash !== request_hash) {
          throw new ImageWorkbenchRepositoryError('图片生成轮次幂等键冲突', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        const restoredOperations = await Promise.all(restored.direction_operations.map(async direction => await this.getGenerationOperation(projectInput.id, direction.operation_id)))
        const restoredTransports = await Promise.all(restoredOperations.map(async operation => {
          if (!operation.transport_task_id) throw new ImageWorkbenchRepositoryError('图片生成轮次缺少传输任务', 500, 'IMAGE_STORAGE_INVALID')
          return await this.getOperation(operation.transport_task_id)
        }))
        return { project: current, round: restored, operations: restoredOperations, transport_operations: restoredTransports }
      }
      const existingIdempotency = this.unitOfWork.database.query(`SELECT id,request_hash FROM image_generation_operations
        WHERE project_id=? AND idempotency_key IN (${operations.map(() => '?').join(',')})`).all(projectInput.id, ...operations.map(operation => operation.idempotency_key)) as Array<{ id: string; request_hash: string }>
      if (existingIdempotency.length > 0) throw new ImageWorkbenchRepositoryError('图片生成操作幂等键冲突', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      const nextProject = imageWorkbenchProjectSchema.parse({
        ...projectInput,
        state: 'queued',
        task_id: undefined,
        revision: projectInput.revision + 1,
        error: undefined,
        error_code: undefined,
        notice: undefined,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      const nextTransports = transports.map(transport => canonicalImageOperation({
        ...transport,
        owner: transport.owner ?? nextProject.owner,
        operation_id: resolvedOperationId(transport),
        status_sequence: 1,
        updated_at: this.iso(),
      }))
      this.unitOfWork.transaction(() => {
        this.persistProject(nextProject)
        this.unitOfWork.database.query(`INSERT INTO image_generation_rounds(id,project_id,creative_plan_id,estimate_hash,confirmed_at,document_json,request_hash)
          VALUES(?,?,?,?,?,?,?)`).run(round.id, round.project_id, round.creative_plan_id, round.estimate_hash, round.confirmed_at, JSON.stringify(round), request_hash)
        for (const transport of nextTransports) {
          this.persistOperation(transport)
          this.appendEvent(transport)
        }
        for (const operation of operations) this.persistGenerationOperation(operation)
      })
      this.notify(nextProject.id)
      return { project: nextProject, round, operations, transport_operations: nextTransports }
    })
  }

  async getCandidateGroup(projectId: string, groupId: string): Promise<{ group: ImageCandidateGroup; candidates: ImageCandidate[] }> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_candidate_groups WHERE id=? AND project_id=?')
      .get(groupId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('图片候选组不存在', 404, 'IMAGE_STORAGE_INVALID')
    const group = this.generationDocument(row, value => imageCandidateGroupSchema.parse(value))
    const candidates = this.unitOfWork.database.query(`SELECT document_json FROM image_candidates
      WHERE candidate_group_id=? ORDER BY candidate_index ASC`).all(group.id) as Array<{ document_json: string }>
    return { group, candidates: candidates.map(candidate => this.generationDocument(candidate, value => imageCandidateSchema.parse(value))) }
  }

  async getCandidate(projectId: string, candidateId: string): Promise<ImageCandidate> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_candidates WHERE id=? AND project_id=?')
      .get(candidateId, projectId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('图片候选不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageCandidateSchema.parse(value))
  }

  /**
   * The local bytes, owned assets, candidate facts, receipt and terminal
   * Operation status become visible together.  Relay ACK happens strictly
   * after this method returns.
   */
  async commitCandidateGroup(input: {
    project: ImageWorkbenchProject
    transport_operation: ImageOperation
    operation: ImageOperationV2
    receipt: ProviderExecutionReceipt
    group: ImageCandidateGroup
    candidates: ImageCandidate[]
    assets: MediaAsset[]
  }): Promise<{ project: ImageWorkbenchProject; transport_operation: ImageOperation; operation: ImageOperationV2 }> {
    await this.ready()
    const operation = imageOperationV2Schema.parse(input.operation)
    const group = imageCandidateGroupSchema.parse(input.group)
    const candidates = input.candidates.map(candidate => imageCandidateSchema.parse(candidate))
    const receipt = providerExecutionReceiptSchema.parse(input.receipt)
    const projectInput = imageWorkbenchProjectSchema.parse(input.project)
    const transport = canonicalImageOperation(input.transport_operation)
    if (operation.project_id !== projectInput.id || group.project_id !== projectInput.id || receipt.project_id !== projectInput.id || transport.project_id !== projectInput.id) {
      throw new ImageWorkbenchRepositoryError('图片候选提交项目不一致', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`project-${projectInput.id}`, async () => {
      const currentRow = this.projectRow(projectInput.id)
      if (!currentRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(currentRow)
      if (current.writer_fence !== projectInput.writer_fence) {
        throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_WRITER_FENCE_CONFLICT')
      }
      const existingGroup = this.unitOfWork.database.query('SELECT document_json FROM image_candidate_groups WHERE operation_id=?')
        .get(operation.id) as { document_json: string } | null
      if (existingGroup) {
        const existingOperation = await this.getGenerationOperation(projectInput.id, operation.id)
        const existingTransport = this.operationRow(transport.id)
        if (!existingTransport) throw new ImageWorkbenchRepositoryError('图片候选提交缺少传输操作', 500, 'IMAGE_STORAGE_INVALID')
        return { project: current, transport_operation: this.loadOperation(existingTransport), operation: existingOperation }
      }
      const nextProject = imageWorkbenchProjectSchema.parse({
        ...projectInput,
        assets: [...projectInput.assets, ...input.assets],
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      const previousTransportRow = this.operationRow(transport.id, true)
      const previousTransport = previousTransportRow && !previousTransportRow.deleted ? this.loadOperation(previousTransportRow) : null
      const changed = !previousTransport || operationProjection(transport) !== operationProjection(previousTransport)
      const nextTransport = canonicalImageOperation({
        ...transport,
        owner: transport.owner ?? nextProject.owner,
        operation_id: resolvedOperationId(transport),
        status_sequence: changed ? (previousTransport?.status_sequence ?? 0) + 1 : previousTransport?.status_sequence ?? transport.status_sequence,
        updated_at: this.iso(),
      })
      this.unitOfWork.transaction(() => {
        this.persistProject(nextProject)
        this.persistGenerationOperation(operation)
        this.persistExecutionReceipt(receipt)
        this.unitOfWork.database.query(`INSERT INTO image_candidate_groups(
          id,project_id,operation_id,generation_round_id,created_at,document_json
        ) VALUES(?,?,?,?,?,?)`).run(group.id, group.project_id, group.operation_id, group.generation_round_id, group.created_at, JSON.stringify(group))
        for (const candidate of candidates) {
          this.unitOfWork.database.query(`INSERT INTO image_candidates(
            id,project_id,candidate_group_id,asset_id,content_hash,candidate_index,created_at,document_json
          ) VALUES(?,?,?,?,?,?,?,?)`).run(
            candidate.id, group.project_id, group.id, candidate.asset_id, candidate.content_hash, candidate.candidate_index, candidate.created_at, JSON.stringify(candidate),
          )
        }
        this.persistOperation(nextTransport)
        if (changed) this.appendEvent(nextTransport)
      })
      if (changed) this.notify(nextProject.id)
      return { project: nextProject, transport_operation: nextTransport, operation }
    })
  }

  /**
   * Candidate decisions are a single aggregate command.  The replay lookup,
   * revision fence, and insert deliberately share one project lock and one
   * SQLite transaction so a concurrent Project update cannot slip between
   * the service's revision check and the durable decision write.
   */
  async decideCandidate(raw: CandidateDecisionCommand): Promise<ImageCandidateDecision> {
    await this.ready()
    const input = candidateDecisionCommandSchema.parse(raw)
    return await this.fences.run(`project-${input.project_id}`, async () => {
      return this.unitOfWork.transaction(() => {
        const currentRow = this.projectRow(input.project_id)
        if (!currentRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
        const current = this.loadProject(currentRow)
        const duplicate = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_candidate_decisions
          WHERE project_id=? AND idempotency_key=?`).get(input.project_id, input.idempotency_key) as { document_json: string; request_hash: string } | null
        if (duplicate) {
          if (duplicate.request_hash !== input.request_hash) {
            throw new ImageWorkbenchRepositoryError('图片候选决定幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
          }
          return this.generationDocument(duplicate, value => imageCandidateDecisionSchema.parse(value))
        }
        if (current.revision !== input.base_revision) {
          throw new ImageWorkbenchRepositoryError('图片项目已更新，请刷新后再决定候选', 409, 'IMAGE_REVISION_CONFLICT')
        }
        const candidate = this.unitOfWork.database.query('SELECT id FROM image_candidates WHERE id=? AND project_id=?').get(input.candidate_id, input.project_id)
        if (!candidate) throw new ImageWorkbenchRepositoryError('图片候选不存在', 404, 'IMAGE_STORAGE_INVALID')
        const decision = imageCandidateDecisionSchema.parse({
          id: input.id,
          project_id: input.project_id,
          candidate_id: input.candidate_id,
          decision: input.decision,
          actor: current.owner,
          idempotency_key: input.idempotency_key,
          request_hash: input.request_hash,
          created_at: input.created_at,
        })
        this.unitOfWork.database.query(`INSERT INTO image_candidate_decisions(
          id,project_id,candidate_id,idempotency_key,request_hash,created_at,document_json
        ) VALUES(?,?,?,?,?,?,?)`).run(decision.id, decision.project_id, decision.candidate_id, decision.idempotency_key, decision.request_hash, decision.created_at, JSON.stringify(decision))
        return decision
      })
    })
  }

  async currentWorkingVersions(projectId: string): Promise<Record<string, string>> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const rows = this.unitOfWork.database.query(`SELECT artboard_id,version_id FROM image_project_working_versions
      WHERE project_id=? ORDER BY artboard_id ASC`).all(projectId) as Array<{ artboard_id: string; version_id: string }>
    return Object.fromEntries(rows.map(row => [row.artboard_id, row.version_id]))
  }

  async selectArtboardVersion(input: {
    project_id: string
    artboard_id: string
    base_revision: number
    idempotency_key: string
    request_hash: string
    version_id: string
  }): Promise<{ project: ImageWorkbenchProject; replayed: boolean }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`project-${input.project_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.projectRow(input.project_id)
      if (!row) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(row)
      const duplicate = this.unitOfWork.database.query(`SELECT request_hash,version_id FROM image_artboard_selection_commands
        WHERE project_id=? AND artboard_id=? AND idempotency_key=?`).get(input.project_id, input.artboard_id, input.idempotency_key) as { request_hash: string; version_id: string } | null
      if (duplicate) {
        if (duplicate.request_hash !== requestHash || duplicate.version_id !== input.version_id) throw new ImageWorkbenchRepositoryError('画板版本选择幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        return { project: current, replayed: true }
      }
      if (current.revision !== input.base_revision) throw new ImageWorkbenchRepositoryError('图片项目已更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      const version = current.versions.find(candidate => candidate.id === input.version_id)
      if (!version || version.artboard_id !== input.artboard_id || version.kind !== 'canvas') {
        throw new ImageWorkbenchRepositoryError('版本不属于当前画板或不是正式渲染版本', 409, 'IMAGE_STORAGE_INVALID')
      }
      const project = imageWorkbenchProjectSchema.parse({
        ...current,
        current_versions_by_artboard: { ...current.current_versions_by_artboard, [input.artboard_id]: input.version_id },
        revision: current.revision + 1,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      this.persistProject(project)
      this.unitOfWork.database.query(`INSERT INTO image_project_working_versions(project_id,artboard_id,version_id,updated_at)
        VALUES(?,?,?,?) ON CONFLICT(project_id,artboard_id) DO UPDATE SET version_id=excluded.version_id,updated_at=excluded.updated_at`)
        .run(input.project_id, input.artboard_id, input.version_id, project.updated_at)
      this.unitOfWork.database.query(`INSERT INTO image_artboard_selection_commands(
        project_id,artboard_id,idempotency_key,request_hash,version_id,created_at
      ) VALUES(?,?,?,?,?,?)`).run(input.project_id, input.artboard_id, input.idempotency_key, requestHash, input.version_id, project.updated_at)
      return { project, replayed: false }
    }))
  }

  /** Multi-artboard adoption is a single CAS-protected Project transaction. */
  async adoptCandidate(input: {
    project: ImageWorkbenchProject
    base_revision: number
    candidate_id: string
    request_hash: string
    idempotency_key: string
    adoptions: ImageCandidateAdoption[]
    versions: MediaVersion[]
    canvases: ImageCanvasRevision[]
  }): Promise<{ project: ImageWorkbenchProject; adoptions: ImageCandidateAdoption[] }> {
    await this.ready()
    const projectInput = imageWorkbenchProjectSchema.parse(input.project)
    const adoptions = input.adoptions.map(adoption => imageCandidateAdoptionSchema.parse(adoption))
    const canvases = input.canvases.map(canvas => imageCanvasRevisionSchema.parse(canvas))
    if (new Set(adoptions.map(adoption => adoption.artboard_id)).size !== adoptions.length) {
      throw new ImageWorkbenchRepositoryError('同一画板只能采纳一次候选', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`project-${projectInput.id}`, async () => {
      const currentRow = this.projectRow(projectInput.id)
      if (!currentRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(currentRow)
      const previousRows = this.unitOfWork.database.query(`SELECT document_json,request_hash FROM image_candidate_adoptions
        WHERE project_id=? AND idempotency_key=? ORDER BY artboard_id ASC`).all(projectInput.id, input.idempotency_key) as Array<{ document_json: string; request_hash: string }>
      if (previousRows.length > 0) {
        if (previousRows.length !== adoptions.length || previousRows.some(row => row.request_hash !== input.request_hash)) {
          throw new ImageWorkbenchRepositoryError('图片候选采纳幂等键冲突', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        return { project: current, adoptions: previousRows.map(row => this.generationDocument(row, value => imageCandidateAdoptionSchema.parse(value))) }
      }
      if (current.revision !== input.base_revision || current.writer_fence !== projectInput.writer_fence) {
        throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const existingCandidateArtboard = this.unitOfWork.database.query(`SELECT artboard_id FROM image_candidate_adoptions
        WHERE project_id=? AND candidate_id=? AND artboard_id IN (${adoptions.map(() => '?').join(',')})`).all(
        projectInput.id,
        input.candidate_id,
        ...adoptions.map(adoption => adoption.artboard_id),
      ) as Array<{ artboard_id: string }>
      if (existingCandidateArtboard.length > 0) {
        throw new ImageWorkbenchRepositoryError('同一候选不能再次采纳到同一画板', 409, 'IMAGE_STORAGE_INVALID')
      }
      const candidate = this.unitOfWork.database.query('SELECT asset_id FROM image_candidates WHERE id=? AND project_id=?')
        .get(input.candidate_id, projectInput.id) as { asset_id: string } | null
      if (!candidate) throw new ImageWorkbenchRepositoryError('图片候选不存在', 404, 'IMAGE_STORAGE_INVALID')
      if (input.versions.length !== adoptions.length || canvases.length !== adoptions.length || input.versions.some(version => !version.asset_ids.includes(candidate.asset_id))
        || canvases.some(canvas => canvas.revision !== 0 || canvas.document.project_id !== projectInput.id
          || !adoptions.some(adoption => adoption.canvas_id === canvas.canvas_id && adoption.artboard_id === canvas.document.artboard_id))) {
        throw new ImageWorkbenchRepositoryError('候选采纳版本不匹配', 409, 'IMAGE_STORAGE_INVALID')
      }
      const existingPointers = Object.fromEntries((this.unitOfWork.database.query(`SELECT artboard_id,version_id FROM image_project_working_versions
        WHERE project_id=?`).all(projectInput.id) as Array<{ artboard_id: string; version_id: string }>).map(row => [row.artboard_id, row.version_id]))
      const nextProject = imageWorkbenchProjectSchema.parse({
        ...projectInput,
        versions: [...projectInput.versions, ...input.versions],
        current_versions_by_artboard: {
          ...existingPointers,
          ...Object.fromEntries(adoptions.map(adoption => [adoption.artboard_id, adoption.version_id])),
        },
        revision: projectInput.revision + 1,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: this.iso(),
      })
      this.unitOfWork.transaction(() => {
        this.persistProject(nextProject)
        for (const [index, adoption] of adoptions.entries()) {
          const version = input.versions[index]!
          this.unitOfWork.database.query(`INSERT INTO image_initial_canvases(
            id,project_id,artboard_id,revision,candidate_id,document_json
          ) VALUES(?,?,?,?,?,?)`).run(adoption.canvas_id, adoption.project_id, adoption.artboard_id, adoption.canvas_revision, adoption.candidate_id, JSON.stringify({
            id: adoption.canvas_id, project_id: adoption.project_id, artboard_id: adoption.artboard_id,
            revision: adoption.canvas_revision, candidate_id: adoption.candidate_id, placement: adoption.placement, created_at: adoption.created_at,
          }))
          this.insertCanvasRevision(canvases[index]!)
          this.unitOfWork.database.query(`INSERT INTO image_candidate_adoptions(
            id,project_id,candidate_id,artboard_id,version_id,idempotency_key,request_hash,created_at,document_json
          ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
            adoption.id, adoption.project_id, adoption.candidate_id, adoption.artboard_id, version.id,
            adoption.idempotency_key, adoption.request_hash, adoption.created_at, JSON.stringify(adoption),
          )
          this.unitOfWork.database.query(`INSERT INTO image_project_working_versions(project_id,artboard_id,version_id,updated_at)
            VALUES(?,?,?,?) ON CONFLICT(project_id,artboard_id) DO UPDATE SET version_id=excluded.version_id,updated_at=excluded.updated_at`)
            .run(adoption.project_id, adoption.artboard_id, version.id, adoption.created_at)
        }
      })
      return { project: nextProject, adoptions }
    })
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

  async projectMigrationReceipt(sourceKind: string, projectId: string): Promise<ImageProjectMigrationReceipt | null> {
    await this.ready()
    this.assertId(projectId, 'project')
    return this.unitOfWork.database.query(`SELECT source_kind,project_id,source_hash,operation_count,journal_next_cursor,
      version_count,current_version_id,status,completed_at FROM image_project_migration_receipts
      WHERE source_kind=? AND project_id=?`).get(sourceKind, projectId) as ImageProjectMigrationReceipt | null
  }

  async recordProjectMigrationReceipt(receipt: Omit<ImageProjectMigrationReceipt, 'status' | 'completed_at'>): Promise<void> {
    await this.ready()
    this.assertId(receipt.project_id, 'project')
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query(`INSERT INTO image_project_migration_receipts(
        source_kind,project_id,source_hash,operation_count,journal_next_cursor,version_count,current_version_id,status,completed_at
      ) VALUES(?,?,?,?,?,?,?,'complete',?)
      ON CONFLICT(source_kind,project_id) DO UPDATE SET
        source_hash=excluded.source_hash,operation_count=excluded.operation_count,journal_next_cursor=excluded.journal_next_cursor,
        version_count=excluded.version_count,current_version_id=excluded.current_version_id,status=excluded.status,completed_at=excluded.completed_at`).run(
        receipt.source_kind,
        receipt.project_id,
        receipt.source_hash,
        receipt.operation_count,
        receipt.journal_next_cursor,
        receipt.version_count,
        receipt.current_version_id,
        this.iso(),
      )
      this.unitOfWork.database.query(`DELETE FROM image_project_migration_invalidations
        WHERE source_kind=? AND project_id=?`).run(receipt.source_kind, receipt.project_id)
    })
  }

  private projectMigrationInvalidationRow(sourceKind: string, projectId: string): ImageProjectMigrationInvalidation | null {
    return this.unitOfWork.database.query(`SELECT source_kind,project_id,source_hash,previous_source_hash,invalidated_at
      FROM image_project_migration_invalidations WHERE source_kind=? AND project_id=?`)
      .get(sourceKind, projectId) as ImageProjectMigrationInvalidation | null
  }

  private markProjectMigrationSourceChanged(sourceKind: string, projectId: string, sourceHash: string, previousSourceHash: string | null): void {
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query(`INSERT INTO image_project_migration_invalidations(
        source_kind,project_id,source_hash,previous_source_hash,invalidated_at
      ) VALUES(?,?,?,?,?)
      ON CONFLICT(source_kind,project_id) DO UPDATE SET
        source_hash=excluded.source_hash,
        previous_source_hash=COALESCE(excluded.previous_source_hash,image_project_migration_invalidations.previous_source_hash),
        invalidated_at=excluded.invalidated_at`).run(sourceKind, projectId, sourceHash, previousSourceHash, this.iso())
      this.unitOfWork.database.query(`DELETE FROM image_project_migration_receipts
        WHERE source_kind=? AND project_id=?`).run(sourceKind, projectId)
    })
  }

  async projectMigrationInvalidation(sourceKind: string, projectId: string): Promise<ImageProjectMigrationInvalidation | null> {
    await this.ready()
    this.assertId(projectId, 'project')
    return this.projectMigrationInvalidationRow(sourceKind, projectId)
  }

  async invalidateProjectMigrationReceipt(sourceKind: string, projectId: string, previousSourceHash: string, observedSourceHash: string): Promise<void> {
    await this.ready()
    this.assertId(projectId, 'project')
    this.markProjectMigrationSourceChanged(sourceKind, projectId, observedSourceHash, previousSourceHash)
  }
}
