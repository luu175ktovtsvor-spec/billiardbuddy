import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'
import {
  imageWorkbenchProjectSchema,
  mediaAssetSchema,
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
  type ImageCanvasLayer,
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
import {
  imageAssetGrantSchema,
  imageAssetProvenanceSchema,
  imageBrandKitSchema,
  imageCampaignConfirmationReceiptSchema,
  imageCampaignEstimateSchema,
  imageCampaignItemSchema,
  imageCampaignPendingRetryConfirmationSchema,
  imageCampaignProjectIntentSchema,
  imageCampaignResponseSchema,
  imageCampaignSchema,
  imageInspirationBoardSchema,
  imageInspirationItemSchema,
  imageLibraryEntrySchema,
  imageProjectLibrarySchema,
  imageTemplateSchema,
  type ImageAssetGrant,
  type ImageAssetProvenance,
  type ImageBrandKit,
  type ImageCampaign,
  type ImageCampaignConfirmationReceipt,
  type ImageCampaignEstimate,
  type ImageCampaignItem,
  type ImageCampaignPendingRetryConfirmation,
  type ImageCampaignProjectIntent,
  type ImageInspirationBoard,
  type ImageInspirationItem,
  type ImageProjectLibrary,
  type ImageTemplate,
  type ImageWorkflowAssetOwner,
} from '../../../shared/contracts/imageWorkflow.js'
import { applyCanvasCommandDocument, ImageCanvasCommandError } from './imageCanvasCommands.js'
import { mediaSafeError } from '../../../shared/contracts/mediaErrors.js'
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

export type ImageCampaignSnapshot = {
  campaign: ImageCampaign
  items: ImageCampaignItem[]
}

/**
 * The Campaign aggregate owns the human-facing item state, while this receipt
 * pins an individual paid attempt to the one child Project / Round / Operation
 * allowed to advance it.  It remains internal because the public Campaign
 * projection intentionally exposes the item, not transport implementation.
 */
export type ImageCampaignAttempt = {
  campaign_id: string
  item_id: string
  attempt: number
  expected_project_id: string
  generation_round_id?: string
  generation_operation_id?: string
  state: 'reserved' | 'bound' | 'cancelled' | 'cancellation_too_late'
  created_at: string
  updated_at: string
}

export type PreparedCampaignCancellation = {
  campaign_id: string
  idempotency_key: string
  request_hash: string
  base_revision: number
  targets: Array<{ item_id: string; attempt: number }>
}

type CampaignCancellationOutcome = {
  kind: 'campaign_cancellation_outcome'
  outcome: 'cancellation_too_late'
  intent: PreparedCampaignCancellation
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
      | 'IMAGE_REVISION_CONFLICT'
      | 'IMAGE_BUDGET_EXCEEDED'
      | 'IMAGE_PROJECT_FORBIDDEN'
      | 'IMAGE_ASSET_NOT_FOUND',
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

  /**
   * A human workflow command reserves its idempotency identity before any
   * follow-up application step can reach a remote provider. A `prepared`
   * receipt is intentionally recoverable: callers reconstruct the same
   * deterministic aggregate IDs and complete it instead of creating another
   * paid attempt.
   */
  async prepareWorkflowCommand(input: {
    scope: string
    aggregate_id: string
    idempotency_key: string
    request_hash: string
    result: unknown
  }): Promise<{ status: 'prepared' | 'complete'; result: unknown; replayed: boolean }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`workflow-${input.scope}-${input.aggregate_id}`, async () => this.unitOfWork.transaction(() => {
      const existing = this.unitOfWork.database.query(`SELECT request_hash,status,result_json FROM image_workflow_command_receipts
        WHERE scope=? AND aggregate_id=? AND idempotency_key=?`).get(
        input.scope,
        input.aggregate_id,
        input.idempotency_key,
      ) as { request_hash: string; status: 'prepared' | 'complete'; result_json: string } | null
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ImageWorkbenchRepositoryError('图片工作流幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        let result: unknown
        try { result = JSON.parse(existing.result_json) } catch {
          throw new ImageWorkbenchRepositoryError('图片工作流幂等回执损坏', 500, 'IMAGE_STORAGE_INVALID')
        }
        return { status: existing.status, result, replayed: true }
      }
      const now = this.iso()
      this.unitOfWork.database.query(`INSERT INTO image_workflow_command_receipts(
        scope,aggregate_id,idempotency_key,request_hash,status,result_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        input.scope,
        input.aggregate_id,
        input.idempotency_key,
        requestHash,
        'prepared',
        JSON.stringify(input.result),
        now,
        now,
      )
      return { status: 'prepared' as const, result: input.result, replayed: false }
    }))
  }

  async completeWorkflowCommand(input: {
    scope: string
    aggregate_id: string
    idempotency_key: string
    request_hash: string
    result: unknown
  }): Promise<void> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    await this.fences.run(`workflow-${input.scope}-${input.aggregate_id}`, async () => this.unitOfWork.transaction(() => {
      const existing = this.unitOfWork.database.query(`SELECT request_hash FROM image_workflow_command_receipts
        WHERE scope=? AND aggregate_id=? AND idempotency_key=?`).get(
        input.scope,
        input.aggregate_id,
        input.idempotency_key,
      ) as { request_hash: string } | null
      if (!existing) throw new ImageWorkbenchRepositoryError('图片工作流幂等回执不存在', 500, 'IMAGE_STORAGE_INVALID')
      if (existing.request_hash !== requestHash) {
        throw new ImageWorkbenchRepositoryError('图片工作流幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      this.unitOfWork.database.query(`UPDATE image_workflow_command_receipts
        SET status='complete',result_json=?,updated_at=?
        WHERE scope=? AND aggregate_id=? AND idempotency_key=?`).run(
        JSON.stringify(input.result),
        this.iso(),
        input.scope,
        input.aggregate_id,
        input.idempotency_key,
      )
    }))
  }

  /** Generic project mutations added by 15.5 keep the same CAS/fence/CAS
   * boundary as Reference Control instead of opening a second JSON writer. */
  async saveWorkflowProjectCommand(input: {
    project: ImageWorkbenchProject
    base_revision: number
    idempotency_key: string
    request_hash: string
    command_kind: string
  }): Promise<{ project: ImageWorkbenchProject; replayed: boolean }> {
    await this.ready()
    const project = imageWorkbenchProjectSchema.parse(input.project)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`project-${project.id}`, async () => this.unitOfWork.transaction(() => {
      const prior = this.unitOfWork.database.query(`SELECT request_hash,result_project_json FROM image_project_workflow_commands
        WHERE project_id=? AND idempotency_key=?`).get(project.id, input.idempotency_key) as { request_hash: string; result_project_json: string } | null
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new ImageWorkbenchRepositoryError('图片工作流幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        try {
          return { project: imageWorkbenchProjectSchema.parse(JSON.parse(prior.result_project_json) as unknown), replayed: true }
        } catch {
          throw new ImageWorkbenchRepositoryError('图片工作流幂等回执损坏', 500, 'IMAGE_STORAGE_INVALID')
        }
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
      this.persistProject(next)
      this.unitOfWork.database.query(`INSERT INTO image_project_workflow_commands(
        project_id,idempotency_key,command_kind,request_hash,result_project_json,created_at
      ) VALUES(?,?,?,?,?,?)`).run(
        next.id,
        input.idempotency_key,
        input.command_kind,
        requestHash,
        JSON.stringify(next),
        next.updated_at,
      )
      return { project: next, replayed: false }
    }))
  }

  async workflowProjectCommandResult(projectId: string, idempotencyKey: string, requestHash: string): Promise<ImageWorkbenchProject | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const hash = imageHashSchema.parse(requestHash)
    const prior = this.unitOfWork.database.query(`SELECT request_hash,result_project_json FROM image_project_workflow_commands
      WHERE project_id=? AND idempotency_key=?`).get(projectId, idempotencyKey) as { request_hash: string; result_project_json: string } | null
    if (!prior) return null
    if (prior.request_hash !== hash) {
      throw new ImageWorkbenchRepositoryError('图片工作流幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
    }
    try {
      return imageWorkbenchProjectSchema.parse(JSON.parse(prior.result_project_json) as unknown)
    } catch {
      throw new ImageWorkbenchRepositoryError('图片工作流幂等回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  private loadInspirationBoard(row: { document_json: string }, itemRows: Array<{ document_json: string }>): ImageInspirationBoard {
    try {
      const header = imageInspirationBoardSchema.parse(JSON.parse(row.document_json))
      const items = itemRows.map(item => imageInspirationItemSchema.parse(JSON.parse(item.document_json)))
      return imageInspirationBoardSchema.parse({ ...header, items })
    } catch {
      throw new ImageWorkbenchRepositoryError('灵感板 SQLite 记录损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  async getInspirationBoard(projectId: string): Promise<ImageInspirationBoard | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_inspiration_boards WHERE project_id=?')
      .get(projectId) as { document_json: string } | null
    if (!row) return null
    const items = this.unitOfWork.database.query(`SELECT document_json FROM image_inspiration_items
      WHERE project_id=? ORDER BY created_at,id`).all(projectId) as Array<{ document_json: string }>
    return this.loadInspirationBoard(row, items)
  }

  async saveInspirationBoardCommand(input: {
    project: ImageWorkbenchProject
    base_revision: number
    idempotency_key: string
    request_hash: string
    board: ImageInspirationBoard
  }): Promise<{ project: ImageWorkbenchProject; board: ImageInspirationBoard; replayed: boolean }> {
    await this.ready()
    const project = imageWorkbenchProjectSchema.parse(input.project)
    const board = imageInspirationBoardSchema.parse(input.board)
    const requestHash = imageHashSchema.parse(input.request_hash)
    if (board.project_id !== project.id) throw new ImageWorkbenchRepositoryError('灵感板项目不匹配', 409, 'IMAGE_STORAGE_INVALID')
    return await this.fences.run(`project-${project.id}`, async () => this.unitOfWork.transaction(() => {
      const prior = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_inspiration_commands
        WHERE project_id=? AND idempotency_key=?`).get(project.id, input.idempotency_key) as { request_hash: string; result_json: string } | null
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new ImageWorkbenchRepositoryError('灵感板幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        try {
          const replay = JSON.parse(prior.result_json) as { project: unknown; board: unknown }
          return {
            project: imageWorkbenchProjectSchema.parse(replay.project),
            board: imageInspirationBoardSchema.parse(replay.board),
            replayed: true,
          }
        } catch {
          throw new ImageWorkbenchRepositoryError('灵感板幂等回执损坏', 500, 'IMAGE_STORAGE_INVALID')
        }
      }
      const currentRow = this.projectRow(project.id)
      if (!currentRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const current = this.loadProject(currentRow)
      if (current.revision !== input.base_revision || current.writer_fence !== project.writer_fence) {
        throw new ImageWorkbenchRepositoryError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const existing = this.unitOfWork.database.query('SELECT revision FROM image_inspiration_boards WHERE project_id=?')
        .get(project.id) as { revision: number } | null
      if (board.revision !== (existing?.revision ?? -1) + 1) {
        throw new ImageWorkbenchRepositoryError('灵感板修订不是下一连续版本', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const nextProject = imageWorkbenchProjectSchema.parse({
        ...project,
        writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        updated_at: board.updated_at,
      })
      this.persistProject(nextProject)
      this.unitOfWork.database.query(`INSERT INTO image_inspiration_boards(
        id,project_id,revision,created_at,updated_at,document_json
      ) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
        id=excluded.id,revision=excluded.revision,updated_at=excluded.updated_at,document_json=excluded.document_json`).run(
        board.id,
        board.project_id,
        board.revision,
        board.created_at,
        board.updated_at,
        JSON.stringify(board),
      )
      this.unitOfWork.database.query('DELETE FROM image_inspiration_items WHERE project_id=?').run(project.id)
      for (const item of board.items) {
        this.unitOfWork.database.query(`INSERT INTO image_inspiration_items(
          id,board_id,project_id,asset_id,promoted_reference_asset_id,created_at,updated_at,document_json
        ) VALUES(?,?,?,?,?,?,?,?)`).run(
          item.id,
          board.id,
          project.id,
          item.asset_id,
          item.promoted_reference_asset_id ?? null,
          item.created_at,
          item.updated_at,
          JSON.stringify(item),
        )
      }
      const result = { project: nextProject, board }
      this.unitOfWork.database.query(`INSERT INTO image_inspiration_commands(
        project_id,idempotency_key,request_hash,board_id,result_json,created_at
      ) VALUES(?,?,?,?,?,?)`).run(
        project.id,
        input.idempotency_key,
        requestHash,
        board.id,
        JSON.stringify(result),
        board.updated_at,
      )
      return { ...result, replayed: false }
    }))
  }

  async inspirationCommandResult(projectId: string, idempotencyKey: string, requestHash: string): Promise<{ project: ImageWorkbenchProject; board: ImageInspirationBoard } | null> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const hash = imageHashSchema.parse(requestHash)
    const prior = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_inspiration_commands
      WHERE project_id=? AND idempotency_key=?`).get(projectId, idempotencyKey) as { request_hash: string; result_json: string } | null
    if (!prior) return null
    if (prior.request_hash !== hash) {
      throw new ImageWorkbenchRepositoryError('灵感板幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
    }
    try {
      const replay = JSON.parse(prior.result_json) as { project: unknown; board: unknown }
      return {
        project: imageWorkbenchProjectSchema.parse(replay.project),
        board: imageInspirationBoardSchema.parse(replay.board),
      }
    } catch {
      throw new ImageWorkbenchRepositoryError('灵感板幂等回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
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
      this.ensureAssetProvenance(project, asset)
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

  /** The Project relation is authoritative for bytes; provenance is immutable once recorded. */
  private ensureAssetProvenance(project: ImageWorkbenchProject, asset: MediaAsset): void {
    const existing = this.unitOfWork.database.query('SELECT asset_id FROM image_asset_provenances WHERE asset_id=?').get(asset.id) as { asset_id: string } | null
    if (existing) return
    const provenance = imageAssetProvenanceSchema.parse({
      asset_id: asset.id,
      owner: { kind: 'project', id: project.id },
      origin: asset.role === 'reference' || asset.role === 'source'
        ? 'user_upload'
        : asset.role === 'result'
          ? 'generated'
          : 'derived',
      source_asset_ids: [],
      source_project_id: project.id,
      ...(asset.role === 'result' || asset.role === 'export' ? { source_version_id: asset.version_id } : {}),
      retention: 'project',
      created_at: asset.created_at,
    })
    this.unitOfWork.database.query(`INSERT INTO image_asset_provenances(
      asset_id,owner_kind,owner_id,origin,retention,created_at,document_json
    ) VALUES(?,?,?,?,?,?,?)`).run(
      provenance.asset_id,
      provenance.owner.kind,
      provenance.owner.id,
      provenance.origin,
      provenance.retention,
      provenance.created_at,
      JSON.stringify(provenance),
    )
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

  /**
   * Persist a known Operation identity while the caller already owns its
   * project transaction. This keeps a coupled formal/transport transition
   * atomic without opening a nested SQLite transaction.
   */
  private updateOperationWithinTransaction(input: ImageOperation): { operation: ImageOperation; changed: boolean } {
    const projectRow = this.projectRow(input.project_id)
    if (!projectRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
    const project = this.loadProject(projectRow)
    const previousRow = this.operationRow(input.id, true)
    if (!previousRow || previousRow.deleted) {
      throw new ImageWorkbenchRepositoryError('图片操作不存在', 404, 'IMAGE_OPERATION_NOT_FOUND')
    }
    const previous = this.loadOperation(previousRow)
    if (previous.project_id !== input.project_id || idempotencyRequestHash(previous) !== idempotencyRequestHash(input)) {
      throw new ImageWorkbenchRepositoryError('图片操作请求身份不能改变', 409, 'IMAGE_STORAGE_INVALID')
    }
    const operationId = resolvedOperationId(input)
    const candidate = canonicalImageOperation({
      ...input,
      owner: input.owner ?? previous.owner ?? project.owner,
      operation_id: operationId,
    })
    const changed = operationProjection(candidate) !== operationProjection(previous)
    const next = canonicalImageOperation({
      ...candidate,
      status_sequence: changed ? previous.status_sequence + 1 : previous.status_sequence,
      updated_at: input.updated_at,
    })
    this.persistOperation(next)
    if (changed) this.appendEvent(next)
    return { operation: next, changed }
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
    return this.brandKitRevisionLocked(brandKitId, revisionId, owner)
  }

  private brandKitRevisionLocked(brandKitId: string, revisionId: string, owner: MediaOwner): ImageBrandKitRevision {
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
    return this.templateRevisionLocked(templateId, revisionId, owner)
  }

  private templateRevisionLocked(templateId: string, revisionId: string, owner: MediaOwner): ImageTemplateRevision {
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_template_revisions
      WHERE id=? AND template_id=? AND owner_kind=? AND owner_id=?`).get(revisionId, templateId, owner.kind, owner.owner_id) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('模板 revision 不存在、无权访问或与模板标识不匹配', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageTemplateRevisionSchema.parse(value))
  }

  private workflowBrandKit(row: { document_json: string }): ImageBrandKit {
    return this.generationDocument(row, value => imageBrandKitSchema.parse(value))
  }

  private workflowTemplate(row: { document_json: string }): ImageTemplate {
    return this.generationDocument(row, value => imageTemplateSchema.parse(value))
  }

  private workflowGrant(row: { document_json: string }): ImageAssetGrant {
    return this.generationDocument(row, value => imageAssetGrantSchema.parse(value))
  }

  private workflowProvenance(row: { document_json: string }): ImageAssetProvenance {
    return this.generationDocument(row, value => imageAssetProvenanceSchema.parse(value))
  }

  private brandKitRow(brandKitId: string): { document_json: string; revision: number; state: 'active' | 'trashed' } | null {
    return this.unitOfWork.database.query(`SELECT document_json,revision,state FROM image_brand_kits WHERE id=?`)
      .get(brandKitId) as { document_json: string; revision: number; state: 'active' | 'trashed' } | null
  }

  private templateRow(templateId: string): { document_json: string; revision: number; state: 'active' | 'trashed' } | null {
    return this.unitOfWork.database.query(`SELECT document_json,revision,state FROM image_templates WHERE id=?`)
      .get(templateId) as { document_json: string; revision: number; state: 'active' | 'trashed' } | null
  }

  private brandKitCommandResultLocked(brandKitId: string, idempotencyKey: string, requestHash: string): { brand_kit: ImageBrandKit; revision: ImageBrandKitRevision } | null {
    const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_brand_kit_commands
      WHERE brand_kit_id=? AND idempotency_key=?`).get(brandKitId, idempotencyKey) as { request_hash: string; result_json: string } | null
    if (!command) return null
    if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('品牌套件幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
    try {
      const result = JSON.parse(command.result_json) as { brand_kit: unknown; revision: unknown }
      return { brand_kit: imageBrandKitSchema.parse(result.brand_kit), revision: imageBrandKitRevisionSchema.parse(result.revision) }
    } catch {
      throw new ImageWorkbenchRepositoryError('品牌套件命令回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  private templateCommandResultLocked(templateId: string, idempotencyKey: string, requestHash: string): { template: ImageTemplate; revision: ImageTemplateRevision } | null {
    const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_template_commands
      WHERE template_id=? AND idempotency_key=?`).get(templateId, idempotencyKey) as { request_hash: string; result_json: string } | null
    if (!command) return null
    if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('模板幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
    try {
      const result = JSON.parse(command.result_json) as { template: unknown; revision: unknown }
      return { template: imageTemplateSchema.parse(result.template), revision: imageTemplateRevisionSchema.parse(result.revision) }
    } catch {
      throw new ImageWorkbenchRepositoryError('模板命令回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  async brandKitCommandResult(brandKitId: string, idempotencyKey: string, requestHash: string): Promise<{ brand_kit: ImageBrandKit; revision: ImageBrandKitRevision } | null> {
    await this.ready()
    return this.brandKitCommandResultLocked(brandKitId, idempotencyKey, imageHashSchema.parse(requestHash))
  }

  async templateCommandResult(templateId: string, idempotencyKey: string, requestHash: string): Promise<{ template: ImageTemplate; revision: ImageTemplateRevision } | null> {
    await this.ready()
    return this.templateCommandResultLocked(templateId, idempotencyKey, imageHashSchema.parse(requestHash))
  }

  async listBrandKits(owner: MediaOwner, includeTrashed = false): Promise<ImageBrandKit[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_brand_kits
      WHERE owner_kind=? AND owner_id=?${includeTrashed ? '' : " AND state='active'"} ORDER BY updated_at DESC,id ASC`)
      .all(owner.kind, owner.owner_id) as Array<{ document_json: string }>
    return rows.map(row => this.workflowBrandKit(row))
  }

  async getBrandKit(brandKitId: string, owner: MediaOwner): Promise<{ brand_kit: ImageBrandKit; revision: ImageBrandKitRevision }> {
    await this.ready()
    const row = this.brandKitRow(brandKitId)
    if (!row) throw new ImageWorkbenchRepositoryError('品牌套件不存在', 404, 'IMAGE_STORAGE_INVALID')
    const brandKit = this.workflowBrandKit(row)
    if (!sameOwner(brandKit.owner, owner)) throw new ImageWorkbenchRepositoryError('无权访问品牌套件', 403, 'IMAGE_PROJECT_FORBIDDEN')
    return { brand_kit: brandKit, revision: await this.brandKitRevision(brandKit.id, brandKit.current_revision_id, owner) }
  }

  async createBrandKitCommand(input: {
    brand_kit: ImageBrandKit
    revision: ImageBrandKitRevision
    idempotency_key: string
    request_hash: string
  }): Promise<{ brand_kit: ImageBrandKit; revision: ImageBrandKitRevision; replayed: boolean }> {
    await this.ready()
    const brandKit = imageBrandKitSchema.parse(input.brand_kit)
    const revision = imageBrandKitRevisionSchema.parse(input.revision)
    const requestHash = imageHashSchema.parse(input.request_hash)
    if (revision.brand_kit_id !== brandKit.id || revision.id !== brandKit.current_revision_id || revision.revision !== brandKit.revision || !sameOwner(revision.owner, brandKit.owner)) {
      throw new ImageWorkbenchRepositoryError('品牌套件初始 revision 无效', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`brand-kit-${brandKit.id}`, async () => this.unitOfWork.transaction(() => {
      const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_brand_kit_commands
        WHERE brand_kit_id=? AND idempotency_key=?`).get(brandKit.id, input.idempotency_key) as { request_hash: string; result_json: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('品牌套件幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const result = JSON.parse(command.result_json) as { brand_kit: unknown; revision: unknown }
        return { brand_kit: imageBrandKitSchema.parse(result.brand_kit), revision: imageBrandKitRevisionSchema.parse(result.revision), replayed: true }
      }
      if (this.brandKitRow(brandKit.id)) throw new ImageWorkbenchRepositoryError('品牌套件标识已存在', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      this.assertBrandRevisionAssetGrantsLocked(revision, true)
      this.unitOfWork.database.query(`INSERT INTO image_brand_kits(
        id,owner_kind,owner_id,revision,current_revision_id,state,created_at,updated_at,document_json
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        brandKit.id, brandKit.owner.kind, brandKit.owner.owner_id, brandKit.revision, brandKit.current_revision_id,
        brandKit.state, brandKit.created_at, brandKit.updated_at, JSON.stringify(brandKit),
      )
      this.unitOfWork.database.query(`INSERT INTO image_brand_kit_revisions(
        id,brand_kit_id,revision,owner_kind,owner_id,created_at,document_json
      ) VALUES(?,?,?,?,?,?,?)`).run(
        revision.id, revision.brand_kit_id, revision.revision, revision.owner.kind, revision.owner.owner_id, revision.created_at, JSON.stringify(revision),
      )
      const result = { brand_kit: brandKit, revision }
      this.unitOfWork.database.query(`INSERT INTO image_brand_kit_commands(
        brand_kit_id,idempotency_key,request_hash,result_json,created_at
      ) VALUES(?,?,?,?,?)`).run(brandKit.id, input.idempotency_key, requestHash, JSON.stringify(result), brandKit.updated_at)
      return { ...result, replayed: false }
    }))
  }

  async reviseBrandKitCommand(input: {
    brand_kit: ImageBrandKit
    revision: ImageBrandKitRevision
    base_revision: number
    idempotency_key: string
    request_hash: string
  }): Promise<{ brand_kit: ImageBrandKit; revision: ImageBrandKitRevision; replayed: boolean }> {
    await this.ready()
    const brandKit = imageBrandKitSchema.parse(input.brand_kit)
    const revision = imageBrandKitRevisionSchema.parse(input.revision)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`brand-kit-${brandKit.id}`, async () => this.unitOfWork.transaction(() => {
      const currentRow = this.brandKitRow(brandKit.id)
      if (!currentRow) throw new ImageWorkbenchRepositoryError('品牌套件不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowBrandKit(currentRow)
      const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_brand_kit_commands
        WHERE brand_kit_id=? AND idempotency_key=?`).get(brandKit.id, input.idempotency_key) as { request_hash: string; result_json: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('品牌套件幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const result = JSON.parse(command.result_json) as { brand_kit: unknown; revision: unknown }
        return { brand_kit: imageBrandKitSchema.parse(result.brand_kit), revision: imageBrandKitRevisionSchema.parse(result.revision), replayed: true }
      }
      if (current.state !== 'active' || current.revision !== input.base_revision || revision.brand_kit_id !== current.id
        || revision.revision !== current.revision + 1 || !sameOwner(revision.owner, current.owner)) {
        throw new ImageWorkbenchRepositoryError('品牌套件 revision 已过期或无效', 409, 'IMAGE_REVISION_CONFLICT')
      }
      this.assertBrandRevisionAssetGrantsLocked(revision)
      this.unitOfWork.database.query(`INSERT INTO image_brand_kit_revisions(
        id,brand_kit_id,revision,owner_kind,owner_id,created_at,document_json
      ) VALUES(?,?,?,?,?,?,?)`).run(
        revision.id, revision.brand_kit_id, revision.revision, revision.owner.kind, revision.owner.owner_id, revision.created_at, JSON.stringify(revision),
      )
      this.unitOfWork.database.query(`UPDATE image_brand_kits SET revision=?,current_revision_id=?,updated_at=?,document_json=? WHERE id=?`).run(
        brandKit.revision, brandKit.current_revision_id, brandKit.updated_at, JSON.stringify(brandKit), brandKit.id,
      )
      const result = { brand_kit: brandKit, revision }
      this.unitOfWork.database.query(`INSERT INTO image_brand_kit_commands(
        brand_kit_id,idempotency_key,request_hash,result_json,created_at
      ) VALUES(?,?,?,?,?)`).run(brandKit.id, input.idempotency_key, requestHash, JSON.stringify(result), brandKit.updated_at)
      return { ...result, replayed: false }
    }))
  }

  async trashBrandKitCommand(input: { brand_kit_id: string; base_revision: number; idempotency_key: string; request_hash: string; updated_at: string }): Promise<{ brand_kit: ImageBrandKit; revision: ImageBrandKitRevision; replayed: boolean }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`brand-kit-${input.brand_kit_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.brandKitRow(input.brand_kit_id)
      if (!row) throw new ImageWorkbenchRepositoryError('品牌套件不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowBrandKit(row)
      const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_brand_kit_commands
        WHERE brand_kit_id=? AND idempotency_key=?`).get(current.id, input.idempotency_key) as { request_hash: string; result_json: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('品牌套件幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const result = JSON.parse(command.result_json) as { brand_kit: unknown; revision: unknown }
        return { brand_kit: imageBrandKitSchema.parse(result.brand_kit), revision: imageBrandKitRevisionSchema.parse(result.revision), replayed: true }
      }
      if (current.state !== 'active' || current.revision !== input.base_revision) throw new ImageWorkbenchRepositoryError('品牌套件 revision 已过期或已在回收站', 409, 'IMAGE_REVISION_CONFLICT')
      const brandKit = imageBrandKitSchema.parse({ ...current, state: 'trashed', updated_at: input.updated_at })
      const revision = this.brandKitRevisionLocked(brandKit.id, brandKit.current_revision_id, brandKit.owner)
      this.unitOfWork.database.query(`UPDATE image_brand_kits SET state='trashed',updated_at=?,document_json=? WHERE id=?`)
        .run(brandKit.updated_at, JSON.stringify(brandKit), brandKit.id)
      const result = { brand_kit: brandKit, revision }
      this.unitOfWork.database.query(`INSERT INTO image_brand_kit_commands(
        brand_kit_id,idempotency_key,request_hash,result_json,created_at
      ) VALUES(?,?,?,?,?)`).run(brandKit.id, input.idempotency_key, requestHash, JSON.stringify(result), brandKit.updated_at)
      return { ...result, replayed: false }
    }))
  }

  async activeBrandKitRevision(brandKitId: string, revisionId: string, owner: MediaOwner): Promise<ImageBrandKitRevision> {
    await this.ready()
    return this.activeBrandKitRevisionLocked(brandKitId, revisionId, owner)
  }

  /** Must be called while the caller owns the SQLite write transaction. */
  private activeBrandKitRevisionLocked(brandKitId: string, revisionId: string, owner: MediaOwner): ImageBrandKitRevision {
    const row = this.brandKitRow(brandKitId)
    if (!row) throw new ImageWorkbenchRepositoryError('品牌套件不存在', 404, 'IMAGE_STORAGE_INVALID')
    const brandKit = this.workflowBrandKit(row)
    if (!sameOwner(brandKit.owner, owner)) throw new ImageWorkbenchRepositoryError('无权访问品牌套件', 403, 'IMAGE_PROJECT_FORBIDDEN')
    if (brandKit.state !== 'active') throw new ImageWorkbenchRepositoryError('品牌套件已移入回收站，不能应用到新画布', 409, 'IMAGE_STORAGE_INVALID')
    return this.brandKitRevisionLocked(brandKitId, revisionId, owner)
  }

  async listTemplates(owner: MediaOwner, includeTrashed = false): Promise<ImageTemplate[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_templates
      WHERE owner_kind=? AND owner_id=?${includeTrashed ? '' : " AND state='active'"} ORDER BY updated_at DESC,id ASC`)
      .all(owner.kind, owner.owner_id) as Array<{ document_json: string }>
    return rows.map(row => this.workflowTemplate(row))
  }

  async getTemplate(templateId: string, owner: MediaOwner): Promise<{ template: ImageTemplate; revision: ImageTemplateRevision }> {
    await this.ready()
    const row = this.templateRow(templateId)
    if (!row) throw new ImageWorkbenchRepositoryError('模板不存在', 404, 'IMAGE_STORAGE_INVALID')
    const template = this.workflowTemplate(row)
    if (!sameOwner(template.owner, owner)) throw new ImageWorkbenchRepositoryError('无权访问模板', 403, 'IMAGE_PROJECT_FORBIDDEN')
    return { template, revision: await this.templateRevision(template.id, template.current_revision_id, owner) }
  }

  async createTemplateCommand(input: {
    template: ImageTemplate
    revision: ImageTemplateRevision
    idempotency_key: string
    request_hash: string
  }): Promise<{ template: ImageTemplate; revision: ImageTemplateRevision; replayed: boolean }> {
    await this.ready()
    const template = imageTemplateSchema.parse(input.template)
    const revision = imageTemplateRevisionSchema.parse(input.revision)
    const requestHash = imageHashSchema.parse(input.request_hash)
    if (revision.template_id !== template.id || revision.id !== template.current_revision_id || revision.revision !== template.revision || !sameOwner(revision.owner, template.owner)) {
      throw new ImageWorkbenchRepositoryError('模板初始 revision 无效', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`template-${template.id}`, async () => this.unitOfWork.transaction(() => {
      const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_template_commands
        WHERE template_id=? AND idempotency_key=?`).get(template.id, input.idempotency_key) as { request_hash: string; result_json: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('模板幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const result = JSON.parse(command.result_json) as { template: unknown; revision: unknown }
        return { template: imageTemplateSchema.parse(result.template), revision: imageTemplateRevisionSchema.parse(result.revision), replayed: true }
      }
      if (this.templateRow(template.id)) throw new ImageWorkbenchRepositoryError('模板标识已存在', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      this.assertTemplateRevisionAssetGrantsLocked(revision, true)
      this.unitOfWork.database.query(`INSERT INTO image_templates(
        id,owner_kind,owner_id,revision,current_revision_id,state,created_at,updated_at,document_json
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        template.id, template.owner.kind, template.owner.owner_id, template.revision, template.current_revision_id,
        template.state, template.created_at, template.updated_at, JSON.stringify(template),
      )
      this.unitOfWork.database.query(`INSERT INTO image_template_revisions(
        id,template_id,revision,owner_kind,owner_id,created_at,document_json
      ) VALUES(?,?,?,?,?,?,?)`).run(
        revision.id, revision.template_id, revision.revision, revision.owner.kind, revision.owner.owner_id, revision.created_at, JSON.stringify(revision),
      )
      const result = { template, revision }
      this.unitOfWork.database.query(`INSERT INTO image_template_commands(
        template_id,idempotency_key,request_hash,result_json,created_at
      ) VALUES(?,?,?,?,?)`).run(template.id, input.idempotency_key, requestHash, JSON.stringify(result), template.updated_at)
      return { ...result, replayed: false }
    }))
  }

  async reviseTemplateCommand(input: {
    template: ImageTemplate
    revision: ImageTemplateRevision
    base_revision: number
    idempotency_key: string
    request_hash: string
  }): Promise<{ template: ImageTemplate; revision: ImageTemplateRevision; replayed: boolean }> {
    await this.ready()
    const template = imageTemplateSchema.parse(input.template)
    const revision = imageTemplateRevisionSchema.parse(input.revision)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`template-${template.id}`, async () => this.unitOfWork.transaction(() => {
      const currentRow = this.templateRow(template.id)
      if (!currentRow) throw new ImageWorkbenchRepositoryError('模板不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowTemplate(currentRow)
      const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_template_commands
        WHERE template_id=? AND idempotency_key=?`).get(template.id, input.idempotency_key) as { request_hash: string; result_json: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('模板幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const result = JSON.parse(command.result_json) as { template: unknown; revision: unknown }
        return { template: imageTemplateSchema.parse(result.template), revision: imageTemplateRevisionSchema.parse(result.revision), replayed: true }
      }
      if (current.state !== 'active' || current.revision !== input.base_revision || revision.template_id !== current.id
        || revision.revision !== current.revision + 1 || !sameOwner(revision.owner, current.owner)) {
        throw new ImageWorkbenchRepositoryError('模板 revision 已过期或无效', 409, 'IMAGE_REVISION_CONFLICT')
      }
      this.assertTemplateRevisionAssetGrantsLocked(revision)
      this.unitOfWork.database.query(`INSERT INTO image_template_revisions(
        id,template_id,revision,owner_kind,owner_id,created_at,document_json
      ) VALUES(?,?,?,?,?,?,?)`).run(
        revision.id, revision.template_id, revision.revision, revision.owner.kind, revision.owner.owner_id, revision.created_at, JSON.stringify(revision),
      )
      this.unitOfWork.database.query(`UPDATE image_templates SET revision=?,current_revision_id=?,updated_at=?,document_json=? WHERE id=?`).run(
        template.revision, template.current_revision_id, template.updated_at, JSON.stringify(template), template.id,
      )
      const result = { template, revision }
      this.unitOfWork.database.query(`INSERT INTO image_template_commands(
        template_id,idempotency_key,request_hash,result_json,created_at
      ) VALUES(?,?,?,?,?)`).run(template.id, input.idempotency_key, requestHash, JSON.stringify(result), template.updated_at)
      return { ...result, replayed: false }
    }))
  }

  async trashTemplateCommand(input: { template_id: string; base_revision: number; idempotency_key: string; request_hash: string; updated_at: string }): Promise<{ template: ImageTemplate; revision: ImageTemplateRevision; replayed: boolean }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`template-${input.template_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.templateRow(input.template_id)
      if (!row) throw new ImageWorkbenchRepositoryError('模板不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowTemplate(row)
      const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_template_commands
        WHERE template_id=? AND idempotency_key=?`).get(current.id, input.idempotency_key) as { request_hash: string; result_json: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('模板幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        const result = JSON.parse(command.result_json) as { template: unknown; revision: unknown }
        return { template: imageTemplateSchema.parse(result.template), revision: imageTemplateRevisionSchema.parse(result.revision), replayed: true }
      }
      if (current.state !== 'active' || current.revision !== input.base_revision) throw new ImageWorkbenchRepositoryError('模板 revision 已过期或已在回收站', 409, 'IMAGE_REVISION_CONFLICT')
      const template = imageTemplateSchema.parse({ ...current, state: 'trashed', updated_at: input.updated_at })
      const revision = this.templateRevisionLocked(template.id, template.current_revision_id, template.owner)
      this.unitOfWork.database.query(`UPDATE image_templates SET state='trashed',updated_at=?,document_json=? WHERE id=?`)
        .run(template.updated_at, JSON.stringify(template), template.id)
      const result = { template, revision }
      this.unitOfWork.database.query(`INSERT INTO image_template_commands(
        template_id,idempotency_key,request_hash,result_json,created_at
      ) VALUES(?,?,?,?,?)`).run(template.id, input.idempotency_key, requestHash, JSON.stringify(result), template.updated_at)
      return { ...result, replayed: false }
    }))
  }

  async activeTemplateRevision(templateId: string, revisionId: string, owner: MediaOwner): Promise<ImageTemplateRevision> {
    await this.ready()
    return this.activeTemplateRevisionLocked(templateId, revisionId, owner)
  }

  /** Must be called while the caller owns the SQLite write transaction. */
  private activeTemplateRevisionLocked(templateId: string, revisionId: string, owner: MediaOwner): ImageTemplateRevision {
    const row = this.templateRow(templateId)
    if (!row) throw new ImageWorkbenchRepositoryError('模板不存在', 404, 'IMAGE_STORAGE_INVALID')
    const template = this.workflowTemplate(row)
    if (!sameOwner(template.owner, owner)) throw new ImageWorkbenchRepositoryError('无权访问模板', 403, 'IMAGE_PROJECT_FORBIDDEN')
    if (template.state !== 'active') throw new ImageWorkbenchRepositoryError('模板已移入回收站，不能应用到新画布', 409, 'IMAGE_STORAGE_INVALID')
    // The aggregate governs whether a new Canvas write is allowed; the
    // requested immutable revision remains valid while that aggregate is active.
    return this.templateRevisionLocked(templateId, revisionId, owner)
  }

  private workflowAssetRecord(assetId: string): {
    asset: MediaAsset
    project_id: string
    owner: ImageWorkflowAssetOwner
    provenance: ImageAssetProvenance
  } {
    const row = this.unitOfWork.database.query(`SELECT ownership.project_id,ownership.asset_json,
      provenance.document_json AS provenance_json
      FROM image_asset_ownerships ownership
      LEFT JOIN image_asset_provenances provenance ON provenance.asset_id=ownership.asset_id
      WHERE ownership.asset_id=?`).get(assetId) as {
        project_id: string
        asset_json: string
        provenance_json: string | null
      } | null
    if (!row) throw new ImageWorkbenchRepositoryError('图片素材不存在', 404, 'IMAGE_STORAGE_INVALID')
    let asset: MediaAsset
    try {
      asset = mediaAssetSchema.parse(JSON.parse(row.asset_json))
    } catch {
      throw new ImageWorkbenchRepositoryError('图片素材记录无效', 500, 'IMAGE_STORAGE_INVALID')
    }
    if (asset.id !== assetId) throw new ImageWorkbenchRepositoryError('图片素材标识不匹配', 500, 'IMAGE_STORAGE_INVALID')
    const owner: ImageWorkflowAssetOwner = { kind: 'project', id: row.project_id }
    const provenance = row.provenance_json
      ? this.workflowProvenance({ document_json: row.provenance_json })
      : imageAssetProvenanceSchema.parse({
          asset_id: asset.id,
          owner,
          origin: asset.role === 'reference' || asset.role === 'source'
            ? 'user_upload'
            : asset.role === 'result'
              ? 'generated'
              : 'derived',
          source_asset_ids: [],
          source_project_id: row.project_id,
          ...(asset.role === 'result' || asset.role === 'export' ? { source_version_id: asset.version_id } : {}),
          retention: 'project',
          created_at: asset.created_at,
        })
    return { asset, project_id: row.project_id, owner, provenance }
  }

  private workflowGrantById(grantId: string): ImageAssetGrant {
    const row = this.unitOfWork.database.query('SELECT document_json FROM image_workflow_asset_grants WHERE id=?')
      .get(grantId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('素材授权不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.workflowGrant(row)
  }

  private assertWorkflowGrantTarget(target: ImageWorkflowAssetOwner, owner: MediaOwner): void {
    if (target.kind === 'project') {
      const projectRow = this.projectRow(target.id)
      if (!projectRow) throw new ImageWorkbenchRepositoryError('授权目标图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const project = this.loadProject(projectRow)
      if (!sameOwner(project.owner, owner)) throw new ImageWorkbenchRepositoryError('无权向该图片项目授权素材', 403, 'IMAGE_PROJECT_FORBIDDEN')
      return
    }
    if (target.kind === 'brand_kit') {
      const row = this.brandKitRow(target.id)
      if (!row) throw new ImageWorkbenchRepositoryError('授权目标品牌套件不存在', 404, 'IMAGE_STORAGE_INVALID')
      const brandKit = this.workflowBrandKit(row)
      if (!sameOwner(brandKit.owner, owner)) throw new ImageWorkbenchRepositoryError('无权向该品牌套件授权素材', 403, 'IMAGE_PROJECT_FORBIDDEN')
      if (brandKit.state !== 'active') throw new ImageWorkbenchRepositoryError('已移入回收站的品牌套件不能接收新授权', 409, 'IMAGE_STORAGE_INVALID')
      return
    }
    const row = this.templateRow(target.id)
    if (!row) throw new ImageWorkbenchRepositoryError('授权目标模板不存在', 404, 'IMAGE_STORAGE_INVALID')
    const template = this.workflowTemplate(row)
    if (!sameOwner(template.owner, owner)) throw new ImageWorkbenchRepositoryError('无权向该模板授权素材', 403, 'IMAGE_PROJECT_FORBIDDEN')
    if (template.state !== 'active') throw new ImageWorkbenchRepositoryError('已移入回收站的模板不能接收新授权', 409, 'IMAGE_STORAGE_INVALID')
  }

  private assertWorkflowGrantPurpose(target: ImageWorkflowAssetOwner, purpose: ImageAssetGrant['purpose']): void {
    const valid = target.kind === 'project'
      ? purpose === 'render' || purpose === 'project_reuse'
      : target.kind === 'brand_kit'
        ? purpose === 'render' || purpose === 'template_use'
        : purpose === 'template_use'
    if (!valid) {
      throw new ImageWorkbenchRepositoryError('素材授权用途与目标聚合不兼容', 400, 'IMAGE_STORAGE_INVALID')
    }
  }

  async getWorkflowAsset(assetId: string): Promise<MediaAsset> {
    await this.ready()
    return this.workflowAssetRecord(assetId).asset
  }

  async getWorkflowAssetProvenance(assetId: string): Promise<ImageAssetProvenance> {
    await this.ready()
    return this.workflowAssetRecord(assetId).provenance
  }

  async listProjectLibrary(projectId: string): Promise<ImageProjectLibrary> {
    await this.ready()
    this.assertGenerationProject(projectId)
    /* A project library has two distinct sources: material it owns and
       material another project actively granted to it.  Select one stable
       active grant per foreign asset so a render + project_reuse pair remains
       a single reusable library card; prefer project_reuse because it is the
       stronger direct-reuse capability exposed by this library. */
    const rows = this.unitOfWork.database.query(`WITH active_project_grants AS (
      SELECT grants.id,grants.asset_id,grants.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY grants.asset_id
          ORDER BY CASE grants.purpose WHEN 'project_reuse' THEN 0 ELSE 1 END,
            grants.created_at ASC,grants.id ASC
        ) AS grant_rank
      FROM image_workflow_asset_grants grants
      WHERE grants.to_owner_kind='project' AND grants.to_owner_id=? AND grants.revoked_at IS NULL
        AND grants.purpose IN ('render','project_reuse')
    )
    SELECT * FROM (
      SELECT ownership.project_id,ownership.asset_id,ownership.asset_json,provenance.document_json AS provenance_json,
        NULL AS grant_id,ownership.created_at AS library_created_at
      FROM image_asset_ownerships ownership
      LEFT JOIN image_asset_provenances provenance ON provenance.asset_id=ownership.asset_id
      WHERE ownership.project_id=?
      UNION ALL
      SELECT ownership.project_id,ownership.asset_id,ownership.asset_json,provenance.document_json AS provenance_json,
        grants.id AS grant_id,grants.created_at AS library_created_at
      FROM active_project_grants grants
      JOIN image_asset_ownerships ownership ON ownership.asset_id=grants.asset_id
      LEFT JOIN image_asset_provenances provenance ON provenance.asset_id=ownership.asset_id
      WHERE grants.grant_rank=1 AND ownership.project_id<>?
    )
    ORDER BY library_created_at DESC,asset_id ASC`).all(projectId, projectId, projectId) as Array<{
        project_id: string
        asset_id: string
        asset_json: string
        provenance_json: string | null
        grant_id: string | null
      }>
    return imageProjectLibrarySchema.parse({
      project_id: projectId,
      entries: rows.map(row => {
        let asset: MediaAsset
        try {
          asset = mediaAssetSchema.parse(JSON.parse(row.asset_json))
        } catch {
          throw new ImageWorkbenchRepositoryError('图片素材记录无效', 500, 'IMAGE_STORAGE_INVALID')
        }
        const provenance = row.provenance_json
          ? this.workflowProvenance({ document_json: row.provenance_json })
          : imageAssetProvenanceSchema.parse({
              asset_id: asset.id,
              owner: { kind: 'project', id: projectId },
              origin: asset.role === 'reference' || asset.role === 'source'
                ? 'user_upload'
                : asset.role === 'result'
                  ? 'generated'
                  : 'derived',
              source_asset_ids: [],
              source_project_id: projectId,
              ...(asset.role === 'result' || asset.role === 'export' ? { source_version_id: asset.version_id } : {}),
              retention: 'project',
              created_at: asset.created_at,
            })
        return imageLibraryEntrySchema.parse({
          asset_id: asset.id,
          project_id: row.project_id,
          role: asset.role,
          ...(asset.mime_type && /^(image\/png|image\/jpeg|image\/webp)$/.test(asset.mime_type) ? { mime_type: asset.mime_type } : {}),
          ...(asset.byte_size !== undefined ? { byte_size: asset.byte_size } : {}),
          ...(asset.content_hash ? { content_hash: asset.content_hash } : {}),
          origin: provenance.origin,
          source_asset_ids: provenance.source_asset_ids,
          ...(provenance.source_project_id ? { source_project_id: provenance.source_project_id } : {}),
          ...(provenance.source_version_id ? { source_version_id: provenance.source_version_id } : {}),
          ...(row.grant_id ? { grant_id: row.grant_id } : {}),
          created_at: asset.created_at,
        })
      }),
    })
  }

  async assetForProjectInput(projectId: string, assetId: string): Promise<MediaAsset> {
    await this.ready()
    this.assertGenerationProject(projectId)
    return this.assetForProjectInputLocked(projectId, assetId)
  }

  /** Verifies the live Project grant as part of the write that consumes it. */
  private assetForProjectInputLocked(projectId: string, assetId: string): MediaAsset {
    const record = this.workflowAssetRecord(assetId)
    if (record.project_id === projectId) return record.asset
    const grant = this.unitOfWork.database.query(`SELECT id FROM image_workflow_asset_grants
      WHERE asset_id=? AND to_owner_kind='project' AND to_owner_id=? AND revoked_at IS NULL
        AND purpose IN ('render','project_reuse') LIMIT 1`).get(assetId, projectId) as { id: string } | null
    if (!grant) throw new ImageWorkbenchRepositoryError('该素材未获授权用于当前项目', 403, 'IMAGE_PROJECT_FORBIDDEN')
    return record.asset
  }

  async activeAssetGrant(assetId: string, target: ImageWorkflowAssetOwner, purposes: readonly ImageAssetGrant['purpose'][]): Promise<ImageAssetGrant> {
    await this.ready()
    return this.activeAssetGrantLocked(assetId, target, purposes)
  }

  /** Verifies a target grant against the same SQLite snapshot as its consumer. */
  private activeAssetGrantLocked(assetId: string, target: ImageWorkflowAssetOwner, purposes: readonly ImageAssetGrant['purpose'][]): ImageAssetGrant {
    if (purposes.length === 0) throw new ImageWorkbenchRepositoryError('素材授权用途不能为空', 500, 'IMAGE_STORAGE_INVALID')
    const placeholders = purposes.map(() => '?').join(',')
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_workflow_asset_grants
      WHERE asset_id=? AND to_owner_kind=? AND to_owner_id=? AND revoked_at IS NULL
        AND purpose IN (${placeholders}) ORDER BY created_at ASC LIMIT 1`)
      .get(assetId, target.kind, target.id, ...purposes) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('素材未获得目标聚合的有效授权', 403, 'IMAGE_PROJECT_FORBIDDEN')
    return this.workflowGrant(row)
  }

  async listWorkflowAssetGrants(owner: MediaOwner, includeRevoked = false): Promise<ImageAssetGrant[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT grants.document_json FROM image_workflow_asset_grants grants
      JOIN image_asset_ownerships ownership ON ownership.asset_id=grants.asset_id
      JOIN image_projects projects ON projects.id=ownership.project_id
      WHERE projects.owner_kind=? AND projects.owner_id=? AND projects.deleted=0${includeRevoked ? '' : ' AND grants.revoked_at IS NULL'}
      ORDER BY grants.created_at DESC,grants.id ASC`).all(owner.kind, owner.owner_id) as Array<{ document_json: string }>
    return rows.map(row => this.workflowGrant(row))
  }

  async createWorkflowAssetGrant(input: {
    grant: ImageAssetGrant
    owner: MediaOwner
    idempotency_key: string
    request_hash: string
  }): Promise<{ grant: ImageAssetGrant; replayed: boolean }> {
    await this.ready()
    const grant = imageAssetGrantSchema.parse(input.grant)
    const requestHash = imageHashSchema.parse(input.request_hash)
    if (!sameOwner(grant.granted_by, input.owner)) {
      throw new ImageWorkbenchRepositoryError('素材授权创建者不属于当前工作台', 403, 'IMAGE_PROJECT_FORBIDDEN')
    }
    const aggregateId = `asset-grant:${grant.from_owner.kind}:${grant.from_owner.id}`
    return await this.fences.run(`asset-${grant.asset_id}`, async () => this.unitOfWork.transaction(() => {
      const command = this.unitOfWork.database.query(`SELECT request_hash,grant_id FROM image_workflow_asset_grant_commands
        WHERE aggregate_id=? AND idempotency_key=?`).get(aggregateId, input.idempotency_key) as { request_hash: string; grant_id: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('素材授权幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        return { grant: this.workflowGrantById(command.grant_id), replayed: true }
      }
      const source = this.workflowAssetRecord(grant.asset_id)
      if (grant.from_owner.kind !== 'project' || grant.from_owner.id !== source.project_id) {
        throw new ImageWorkbenchRepositoryError('素材授权来源与实际归属不一致', 409, 'IMAGE_STORAGE_INVALID')
      }
      const sourceProjectRow = this.projectRow(source.project_id)
      if (!sourceProjectRow || !sameOwner(this.loadProject(sourceProjectRow).owner, input.owner)) {
        throw new ImageWorkbenchRepositoryError('无权授权该图片素材', 403, 'IMAGE_PROJECT_FORBIDDEN')
      }
      if (grant.from_owner.kind === grant.to_owner.kind && grant.from_owner.id === grant.to_owner.id) {
        throw new ImageWorkbenchRepositoryError('素材授权来源和目标不能相同', 409, 'IMAGE_STORAGE_INVALID')
      }
      this.assertWorkflowGrantPurpose(grant.to_owner, grant.purpose)
      this.assertWorkflowGrantTarget(grant.to_owner, input.owner)
      const existing = this.unitOfWork.database.query(`SELECT document_json FROM image_workflow_asset_grants
        WHERE asset_id=? AND from_owner_kind=? AND from_owner_id=? AND to_owner_kind=? AND to_owner_id=?
          AND purpose=? AND revoked_at IS NULL ORDER BY created_at ASC LIMIT 1`).get(
        grant.asset_id, grant.from_owner.kind, grant.from_owner.id, grant.to_owner.kind, grant.to_owner.id, grant.purpose,
      ) as { document_json: string } | null
      const resolved = existing ? this.workflowGrant(existing) : grant
      if (!existing) {
        const collision = this.unitOfWork.database.query('SELECT document_json FROM image_workflow_asset_grants WHERE id=?').get(grant.id) as { document_json: string } | null
        if (collision) throw new ImageWorkbenchRepositoryError('素材授权标识已被占用', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        this.unitOfWork.database.query(`INSERT INTO image_workflow_asset_grants(
          id,asset_id,from_owner_kind,from_owner_id,to_owner_kind,to_owner_id,purpose,revoked_at,created_at,document_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
          grant.id, grant.asset_id, grant.from_owner.kind, grant.from_owner.id, grant.to_owner.kind, grant.to_owner.id,
          grant.purpose, null, grant.created_at, JSON.stringify(grant),
        )
      }
      this.unitOfWork.database.query(`INSERT INTO image_workflow_asset_grant_commands(
        aggregate_id,idempotency_key,request_hash,grant_id,created_at
      ) VALUES(?,?,?,?,?)`).run(aggregateId, input.idempotency_key, requestHash, resolved.id, grant.created_at)
      return { grant: resolved, replayed: Boolean(existing) }
    }))
  }

  async revokeWorkflowAssetGrant(input: {
    grant_id: string
    owner: MediaOwner
    idempotency_key: string
    request_hash: string
    revoked_at: string
  }): Promise<{ grant: ImageAssetGrant; replayed: boolean }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    const aggregateId = `asset-grant-revoke:${input.grant_id}`
    return await this.fences.run(`grant-${input.grant_id}`, async () => this.unitOfWork.transaction(() => {
      const command = this.unitOfWork.database.query(`SELECT request_hash,grant_id FROM image_workflow_asset_grant_commands
        WHERE aggregate_id=? AND idempotency_key=?`).get(aggregateId, input.idempotency_key) as { request_hash: string; grant_id: string } | null
      if (command) {
        if (command.request_hash !== requestHash) throw new ImageWorkbenchRepositoryError('撤销素材授权的幂等键对应请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        return { grant: this.workflowGrantById(command.grant_id), replayed: true }
      }
      const current = this.workflowGrantById(input.grant_id)
      const source = this.workflowAssetRecord(current.asset_id)
      const sourceProjectRow = this.projectRow(source.project_id)
      if (!sourceProjectRow || !sameOwner(this.loadProject(sourceProjectRow).owner, input.owner) || !sameOwner(current.granted_by, input.owner)) {
        throw new ImageWorkbenchRepositoryError('无权撤销该素材授权', 403, 'IMAGE_PROJECT_FORBIDDEN')
      }
      const grant = current.revoked_at
        ? current
        : imageAssetGrantSchema.parse({ ...current, revoked_at: input.revoked_at })
      if (!current.revoked_at) {
        this.unitOfWork.database.query('UPDATE image_workflow_asset_grants SET revoked_at=?,document_json=? WHERE id=?')
          .run(grant.revoked_at ?? null, JSON.stringify(grant), grant.id)
      }
      this.unitOfWork.database.query(`INSERT INTO image_workflow_asset_grant_commands(
        aggregate_id,idempotency_key,request_hash,grant_id,created_at
      ) VALUES(?,?,?,?,?)`).run(aggregateId, input.idempotency_key, requestHash, grant.id, input.revoked_at)
      return { grant, replayed: Boolean(current.revoked_at) }
    }))
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

  private canvasLayerAssetIds(layers: readonly ImageCanvasLayer[]): string[] {
    const assetIds = new Set<string>()
    const collect = (items: readonly ImageCanvasLayer[]): void => {
      for (const layer of items) {
        if (layer.kind === 'group') {
          collect(layer.children)
          continue
        }
        if (layer.kind === 'raster' || layer.kind === 'logo' || layer.kind === 'mask') assetIds.add(layer.source_asset_id)
        if (layer.kind === 'qrcode' && layer.source.kind === 'asset') assetIds.add(layer.source.asset_id)
      }
    }
    collect(layers)
    return [...assetIds]
  }

  private canvasCommandAssetIdsLocked(command: ImageCanvasCommandInput): string[] {
    if (command.kind !== 'add_layer' && command.kind !== 'replace_layer') return []
    return this.canvasLayerAssetIds([command.payload.layer as ImageCanvasLayer])
  }

  private assertBrandRevisionAssetGrantsLocked(revision: ImageBrandKitRevision, initial = false): void {
    const nonBuiltinFonts = revision.font_asset_ids.filter(assetId => assetId !== 'font_builtin_0001')
    if (nonBuiltinFonts.length > 0) {
      throw new ImageWorkbenchRepositoryError('当前图片工作台仅支持受控内置字体，其他品牌字体暂不可写入品牌包', 422, 'IMAGE_ASSET_NOT_FOUND')
    }
    if (initial && revision.logo_asset_ids.length > 0) {
      throw new ImageWorkbenchRepositoryError('新建品牌套件必须先创建空 revision，再对素材授权后写入 Logo', 409, 'IMAGE_REVISION_CONFLICT')
    }
    for (const assetId of revision.logo_asset_ids) {
      this.activeAssetGrantLocked(assetId, { kind: 'brand_kit', id: revision.brand_kit_id }, ['render', 'template_use'])
    }
  }

  private templateReferencedAssetIdsLocked(revision: ImageTemplateRevision): string[] {
    return this.canvasLayerAssetIds(revision.blueprint.layers)
  }

  private assertTemplateRevisionAssetGrantsLocked(revision: ImageTemplateRevision, initial = false): void {
    const brand = revision.brand_kit_id && revision.brand_kit_revision_id
      ? this.activeBrandKitRevisionLocked(revision.brand_kit_id, revision.brand_kit_revision_id, revision.owner)
      : undefined
    if (brand) this.assertBrandRevisionAssetGrantsLocked(brand)
    const brandAssets = new Set(brand?.logo_asset_ids ?? [])
    const brandFonts = new Set(brand?.font_asset_ids ?? [])
    for (const assetId of this.templateReferencedAssetIdsLocked(revision)) {
      if (brandAssets.has(assetId)) continue
      if (initial) {
        throw new ImageWorkbenchRepositoryError('新建模板只能从空蓝图或已绑定品牌素材开始；项目素材需先授权后写入 revision', 409, 'IMAGE_REVISION_CONFLICT')
      }
      this.activeAssetGrantLocked(assetId, { kind: 'template', id: revision.template_id }, ['template_use'])
    }
    const validateFonts = (layers: readonly ImageCanvasLayer[]): void => {
      for (const layer of layers) {
        if (layer.kind === 'group') {
          validateFonts(layer.children)
          continue
        }
        if (layer.kind === 'text' && layer.font_asset_id !== 'font_builtin_0001' && !brandFonts.has(layer.font_asset_id)) {
          throw new ImageWorkbenchRepositoryError('模板文字只能使用内置字体或已锁定的品牌字体', 422, 'IMAGE_ASSET_NOT_FOUND')
        }
      }
    }
    validateFonts(revision.blueprint.layers)
  }

  private assertTemplateBrandLockLocked(canvas: ImageCanvasRevision, command: ImageCanvasCommandInput, owner: MediaOwner): void {
    if (command.kind !== 'apply_brand_kit') return
    const { template_id: templateId, template_revision_id: templateRevisionId } = canvas.document
    if (!templateId || !templateRevisionId) return
    const template = this.templateRevisionLocked(templateId, templateRevisionId, owner)
    if (template.brand_kit_id && template.brand_kit_revision_id && (
      template.brand_kit_id !== command.payload.brand_kit_id
      || template.brand_kit_revision_id !== command.payload.brand_kit_revision_id
    )) {
      throw new ImageWorkbenchRepositoryError('已应用的模板锁定了品牌 revision，不能被画布命令覆盖', 409, 'IMAGE_REVISION_CONFLICT')
    }
  }

  async applyCanvasCommand(input: {
    project_id: string
    canvas_id: string
    base_project_revision: number
    command: ImageCanvasCommandInput
    request_hash: string
    created_at: string
    delivery_artboard?: { width: number; height: number; safe_area?: { top: number; right: number; bottom: number; left: number } }
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
      // Resolve new-write aggregate permissions before the mutable Canvas
      // revision check, still in this transaction. A trashed Template/Brand
      // is a stable invalid request even when its caller also holds a stale
      // Canvas revision; idempotent replays returned above remain exempt.
      let template: ImageTemplateRevision | undefined
      if (command.kind === 'apply_template') {
        template = this.activeTemplateRevisionLocked(command.payload.template_id, command.payload.template_revision_id, current.owner)
        this.assertTemplateRevisionAssetGrantsLocked(template)
        for (const assetId of command.payload.slot_bindings.flatMap(binding => binding.asset_id ? [binding.asset_id] : [])) {
          this.assetForProjectInputLocked(input.project_id, assetId)
        }
      }
      if (command.kind === 'apply_brand_kit') {
        const brand = this.activeBrandKitRevisionLocked(command.payload.brand_kit_id, command.payload.brand_kit_revision_id, current.owner)
        this.assertBrandRevisionAssetGrantsLocked(brand)
      }
      const currentCanvas = this.canvasRevisionRow(input.project_id, input.canvas_id)
      if (currentCanvas.revision !== command.base_revision) {
        throw new ImageWorkbenchRepositoryError('画布修订已更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      this.assertTemplateBrandLockLocked(currentCanvas, command, current.owner)
      for (const assetId of this.canvasCommandAssetIdsLocked(command)) {
        this.assetForProjectInputLocked(input.project_id, assetId)
      }
      let document
      try {
        document = applyCanvasCommandDocument(currentCanvas.document, command, input.delivery_artboard, template)
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

  /**
   * Resolve a completed Canvas command before the caller validates current
   * Template, Brand, or Grant state. Those dependencies may legitimately be
   * retired after the original command committed, but the same idempotency
   * key must still replay its immutable revision.
   */
  async canvasCommandResult(input: {
    project_id: string
    canvas_id: string
    idempotency_key: string
    request_hash: string
  }): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision } | null> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`project-${input.project_id}`, async () => this.unitOfWork.transaction(() => {
      const projectRow = this.projectRow(input.project_id)
      if (!projectRow) throw new ImageWorkbenchRepositoryError('图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      const duplicate = this.unitOfWork.database.query(`SELECT request_hash,result_revision FROM image_canvas_commands
        WHERE project_id=? AND canvas_id=? AND idempotency_key=?`).get(
        input.project_id,
        input.canvas_id,
        input.idempotency_key,
      ) as { request_hash: string; result_revision: number } | null
      if (!duplicate) return null
      if (duplicate.request_hash !== requestHash) {
        throw new ImageWorkbenchRepositoryError('画布命令幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      return {
        project: this.loadProject(projectRow),
        canvas: this.canvasRevisionRow(input.project_id, input.canvas_id, duplicate.result_revision),
      }
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

  async listCreativePlans(projectId: string): Promise<ImageCreativePlan[]> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_creative_plans
      WHERE project_id=? ORDER BY created_at ASC, id ASC`).all(projectId) as Array<{ document_json: string }>
    return rows.map(row => this.generationDocument(row, value => imageCreativePlanSchema.parse(value)))
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

  /**
   * Linearizes the point of no return for a paid generation request. The
   * formal Operation and Relay transport are claimed together before the
   * network POST, so a queued Campaign cancellation can either win entirely
   * or observe a durable in-flight submission and return its expected 409.
   */
  async claimGenerationSubmission(input: {
    operation: ImageOperationV2
    transport: ImageOperation
    submitted_at: string
  }): Promise<{ operation: ImageOperationV2; transport: ImageOperation; claimed: boolean }> {
    await this.ready()
    const requestedOperation = imageOperationV2Schema.parse(input.operation)
    const requestedTransport = canonicalImageOperation(input.transport)
    if (
      requestedOperation.project_id !== requestedTransport.project_id
      || requestedOperation.transport_task_id !== requestedTransport.id
    ) {
      throw new ImageWorkbenchRepositoryError('图片生成操作与传输任务不匹配', 409, 'IMAGE_STORAGE_INVALID')
    }
    return await this.fences.run(`project-${requestedOperation.project_id}`, async () => {
      let shouldNotify = false
      const claimed = this.unitOfWork.transaction(() => {
        this.assertGenerationProject(requestedOperation.project_id)
        const operationRow = this.unitOfWork.database.query('SELECT document_json FROM image_generation_operations WHERE id=? AND project_id=?')
          .get(requestedOperation.id, requestedOperation.project_id) as { document_json: string } | null
        const transportRow = this.operationRow(requestedTransport.id, true)
        if (!operationRow || !transportRow || transportRow.deleted) {
          throw new ImageWorkbenchRepositoryError('图片生成提交缺少持久化操作', 404, 'IMAGE_OPERATION_NOT_FOUND')
        }
        const currentOperation = this.loadGenerationOperation(operationRow)
        const currentTransport = this.loadOperation(transportRow)
        if (
          currentOperation.request_hash !== requestedOperation.request_hash
          || currentOperation.transport_task_id !== currentTransport.id
          || currentTransport.project_id !== currentOperation.project_id
        ) {
          throw new ImageWorkbenchRepositoryError('图片生成提交身份不一致', 409, 'IMAGE_STORAGE_INVALID')
        }
        const canClaim = currentOperation.status === 'queued'
          && currentTransport.status === 'queued'
          && !currentTransport.remote_task_id
          && !currentTransport.remote_submission_started_at
        if (!canClaim) return { operation: currentOperation, transport: currentTransport, claimed: false }
        const nextOperation = imageOperationV2Schema.parse({
          ...currentOperation,
          status: 'queued',
          cost_state: 'submitted_charge_possible',
          submitted_at: currentOperation.submitted_at ?? input.submitted_at,
          updated_at: input.submitted_at,
        })
        const transportUpdate = this.updateOperationWithinTransaction(canonicalImageOperation({
          ...currentTransport,
          status: 'queued',
          progress: Math.max(currentTransport.progress, 1),
          stage: currentTransport.outcome_unknown ? '正在确认上次提交' : '正在提交图片任务',
          remote_submission_started_at: input.submitted_at,
          outcome_unknown: false,
          error: undefined,
          error_code: undefined,
          updated_at: input.submitted_at,
        }))
        this.persistGenerationOperation(nextOperation)
        shouldNotify ||= transportUpdate.changed
        return { operation: nextOperation, transport: transportUpdate.operation, claimed: true }
      })
      if (shouldNotify) this.notify(requestedOperation.project_id)
      return claimed
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
      if (input.gateway_result_acknowledged_at && !prior.gateway_result_acknowledged_at) {
        const acknowledged = providerExecutionReceiptSchema.parse({
          ...prior,
          ...(input.gateway_result_fingerprint ? { gateway_result_fingerprint: input.gateway_result_fingerprint } : {}),
          gateway_result_acknowledged_at: input.gateway_result_acknowledged_at,
        })
        this.unitOfWork.database.query('UPDATE image_provider_execution_receipts SET document_json=? WHERE id=?')
          .run(JSON.stringify(acknowledged), acknowledged.id)
        return acknowledged
      }
      return prior
    }
    const completed = providerExecutionReceiptSchema.parse({
      ...prior,
      ...(input.provider_request_id ? { provider_request_id: input.provider_request_id } : {}),
      ...(input.output_asset_hashes ? { output_asset_hashes: input.output_asset_hashes } : {}),
      ...(input.refusal ? { refusal: input.refusal } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.gateway_result_fingerprint ? { gateway_result_fingerprint: input.gateway_result_fingerprint } : {}),
      ...(input.gateway_result_acknowledged_at ? { gateway_result_acknowledged_at: input.gateway_result_acknowledged_at } : {}),
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

  /** Gateway advice results are retained until the local receipt can acknowledge them. */
  async listUnacknowledgedGatewayAdviceReceipts(): Promise<ProviderExecutionReceipt[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query('SELECT document_json FROM image_provider_execution_receipts').all() as Array<{ document_json: string }>
    return rows
      .map(row => this.generationDocument(row, value => providerExecutionReceiptSchema.parse(value)))
      .filter(receipt => receipt.provider === 'qwen'
        && receipt.completed_at !== undefined
        && receipt.gateway_result_fingerprint !== undefined
        && receipt.gateway_result_acknowledged_at === undefined)
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

  async listGenerationRounds(projectId: string): Promise<ImageGenerationRound[]> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_rounds
      WHERE project_id=? ORDER BY confirmed_at ASC, id ASC`).all(projectId) as Array<{ document_json: string }>
    return rows.map(row => this.generationDocument(row, value => imageGenerationRoundSchema.parse(value)))
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

  async listCandidateGroups(projectId: string): Promise<Array<{ group: ImageCandidateGroup; candidates: ImageCandidate[] }>> {
    await this.ready()
    this.assertGenerationProject(projectId)
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_candidate_groups
      WHERE project_id=? ORDER BY created_at ASC, id ASC`).all(projectId) as Array<{ document_json: string }>
    return rows.map(row => {
      const group = this.generationDocument(row, value => imageCandidateGroupSchema.parse(value))
      const candidates = this.unitOfWork.database.query(`SELECT document_json FROM image_candidates
        WHERE candidate_group_id=? ORDER BY candidate_index ASC, id ASC`).all(group.id) as Array<{ document_json: string }>
      return {
        group,
        candidates: candidates.map(candidate => this.generationDocument(candidate, value => imageCandidateSchema.parse(value))),
      }
    })
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

  /** Campaign writes use one aggregate fence and one SQLite transaction. */
  private campaignRow(campaignId: string): {
    id: string
    owner_kind: MediaOwner['kind']
    owner_id: string
    revision: number
    state: ImageCampaign['state']
    document_json: string
  } | null {
    if (!IMAGE_ID.test(campaignId)) {
      throw new ImageWorkbenchRepositoryError('Campaign 标识无效', 400, 'IMAGE_STORAGE_INVALID')
    }
    return this.unitOfWork.database.query(`SELECT id,owner_kind,owner_id,revision,state,document_json
      FROM image_campaigns WHERE id=?`).get(campaignId) as {
      id: string
      owner_kind: MediaOwner['kind']
      owner_id: string
      revision: number
      state: ImageCampaign['state']
      document_json: string
    } | null
  }

  private workflowCampaign(row: { document_json: string }): ImageCampaign {
    return this.generationDocument(row, value => imageCampaignSchema.parse(value))
  }

  private workflowCampaignItem(row: { document_json: string }): ImageCampaignItem {
    return this.generationDocument(row, value => imageCampaignItemSchema.parse(value))
  }

  private campaignItemsLocked(campaignId: string): ImageCampaignItem[] {
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_items
      WHERE campaign_id=? ORDER BY ordinal ASC,id ASC`).all(campaignId) as Array<{ document_json: string }>
    return rows.map(row => this.workflowCampaignItem(row))
  }

  private campaignAttemptLocked(campaignId: string, itemId: string, attempt: number): ImageCampaignAttempt | null {
    const row = this.unitOfWork.database.query(`SELECT campaign_id,item_id,attempt,expected_project_id,generation_round_id,
      generation_operation_id,state,created_at,updated_at FROM image_campaign_attempts
      WHERE campaign_id=? AND item_id=? AND attempt=?`).get(campaignId, itemId, attempt) as {
        campaign_id: string
        item_id: string
        attempt: number
        expected_project_id: string
        generation_round_id: string | null
        generation_operation_id: string | null
        state: ImageCampaignAttempt['state']
        created_at: string
        updated_at: string
      } | null
    if (!row) return null
    if (!['reserved', 'bound', 'cancelled', 'cancellation_too_late'].includes(row.state)) {
      throw new ImageWorkbenchRepositoryError('Campaign 尝试状态损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
    return {
      campaign_id: row.campaign_id,
      item_id: row.item_id,
      attempt: row.attempt,
      expected_project_id: row.expected_project_id,
      ...(row.generation_round_id ? { generation_round_id: row.generation_round_id } : {}),
      ...(row.generation_operation_id ? { generation_operation_id: row.generation_operation_id } : {}),
      state: row.state,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private reserveCampaignAttemptLocked(input: {
    campaign_id: string
    item_id: string
    attempt: number
    expected_project_id: string
    created_at: string
  }): ImageCampaignAttempt {
    const existing = this.campaignAttemptLocked(input.campaign_id, input.item_id, input.attempt)
    if (existing) {
      if (existing.expected_project_id !== input.expected_project_id) {
        throw new ImageWorkbenchRepositoryError('Campaign 尝试已绑定其他确定性子项目', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      return existing
    }
    this.unitOfWork.database.query(`INSERT INTO image_campaign_attempts(
      campaign_id,item_id,attempt,expected_project_id,state,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)`).run(
      input.campaign_id,
      input.item_id,
      input.attempt,
      input.expected_project_id,
      'reserved',
      input.created_at,
      input.created_at,
    )
    return {
      campaign_id: input.campaign_id,
      item_id: input.item_id,
      attempt: input.attempt,
      expected_project_id: input.expected_project_id,
      state: 'reserved',
      created_at: input.created_at,
      updated_at: input.created_at,
    }
  }

  private updateCampaignAttemptLocked(attempt: ImageCampaignAttempt): ImageCampaignAttempt {
    this.unitOfWork.database.query(`UPDATE image_campaign_attempts SET generation_round_id=?,generation_operation_id=?,state=?,updated_at=?
      WHERE campaign_id=? AND item_id=? AND attempt=?`).run(
      attempt.generation_round_id ?? null,
      attempt.generation_operation_id ?? null,
      attempt.state,
      attempt.updated_at,
      attempt.campaign_id,
      attempt.item_id,
      attempt.attempt,
    )
    return attempt
  }

  private pendingCampaignRetryConfirmationsLocked(
    campaign: ImageCampaign,
    items: readonly ImageCampaignItem[],
  ): ImageCampaignPendingRetryConfirmation[] {
    const rows = this.unitOfWork.database.query(`SELECT confirmations.document_json AS confirmation_json,
      estimates.document_json AS estimate_json
      FROM image_campaign_confirmations confirmations
      JOIN image_campaign_estimates estimates ON estimates.estimate_hash=confirmations.estimate_hash
      WHERE confirmations.campaign_id=? ORDER BY confirmations.created_at ASC,confirmations.id ASC`)
      .all(campaign.id) as Array<{ confirmation_json: string; estimate_json: string }>
    const byItemId = new Map(items.map(item => [item.id, item]))
    return rows.flatMap(row => {
      const confirmation = this.generationDocument(
        { document_json: row.confirmation_json },
        value => imageCampaignConfirmationReceiptSchema.parse(value),
      )
      if (confirmation.purpose !== 'retry' || !confirmation.item_id || confirmation.attempt === undefined) return []
      const estimate = this.generationDocument(
        { document_json: row.estimate_json },
        value => imageCampaignEstimateSchema.parse(value),
      )
      const item = byItemId.get(confirmation.item_id)
      if (
        !item
        || !['failed', 'cancelled'].includes(item.state)
        || item.attempt + 1 !== confirmation.attempt
        || campaign.revision !== confirmation.campaign_revision
        || confirmation.estimate_hash !== estimate.estimate_hash
        || estimate.purpose !== 'retry'
        || estimate.item_id !== item.id
        || estimate.attempt !== confirmation.attempt
        || estimate.campaign_revision !== campaign.revision
        || Date.parse(estimate.expires_at) <= this.now().getTime()
      ) return []
      return [imageCampaignPendingRetryConfirmationSchema.parse({
        item_id: item.id,
        attempt: confirmation.attempt,
        estimate_hash: estimate.estimate_hash,
        confirmation_receipt_id: confirmation.id,
        expires_at: estimate.expires_at,
      })]
    })
  }

  private campaignSnapshotLocked(campaignId: string): ImageCampaignSnapshot {
    const row = this.campaignRow(campaignId)
    if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
    const campaign = this.workflowCampaign(row)
    const items = this.campaignItemsLocked(campaignId)
    return imageCampaignResponseSchema.parse({
      campaign,
      items,
      pending_retry_confirmations: this.pendingCampaignRetryConfirmationsLocked(campaign, items),
    })
  }

  private assertCampaignOwner(campaign: ImageCampaign, owner: MediaOwner): void {
    if (!sameOwner(campaign.owner, owner)) {
      throw new ImageWorkbenchRepositoryError('无权访问该 Campaign', 403, 'IMAGE_PROJECT_FORBIDDEN')
    }
  }

  private campaignCommandResultLocked(campaignId: string, idempotencyKey: string, requestHash: string): ImageCampaignSnapshot | null {
    const command = this.unitOfWork.database.query(`SELECT request_hash,result_json FROM image_campaign_commands
      WHERE campaign_id=? AND idempotency_key=?`).get(campaignId, idempotencyKey) as { request_hash: string; result_json: string } | null
    if (!command) return null
    if (command.request_hash !== requestHash) {
      throw new ImageWorkbenchRepositoryError('Campaign 幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
    }
    try {
      return imageCampaignResponseSchema.parse(JSON.parse(command.result_json))
    } catch {
      throw new ImageWorkbenchRepositoryError('Campaign 命令回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
  }

  private saveCampaignCommandLocked(campaignId: string, idempotencyKey: string, requestHash: string, result: ImageCampaignSnapshot, createdAt: string): void {
    this.unitOfWork.database.query(`INSERT INTO image_campaign_commands(
      campaign_id,idempotency_key,request_hash,result_json,created_at
    ) VALUES(?,?,?,?,?)`).run(campaignId, idempotencyKey, requestHash, JSON.stringify(result), createdAt)
  }

  /** The confirmation write is fenced, so a retry can never overbook Campaign budget through a race. */
  private assertCampaignRetryBudgetLocked(campaign: ImageCampaign, candidate: ImageCampaignEstimate): void {
    if (!campaign.budget_limit) return
    if (candidate.price_upper_bound.currency !== campaign.budget_limit.currency) {
      throw new ImageWorkbenchRepositoryError('Campaign 预算币种与报价币种不一致', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
    const rows = this.unitOfWork.database.query(`SELECT confirmations.document_json AS confirmation_json,
      estimates.document_json AS estimate_json
      FROM image_campaign_confirmations confirmations
      JOIN image_campaign_estimates estimates ON estimates.estimate_hash=confirmations.estimate_hash
      WHERE confirmations.campaign_id=?`).all(campaign.id) as Array<{
        confirmation_json: string
        estimate_json: string
      }>
    const usedRetryReceipts = new Set(this.campaignItemsLocked(campaign.id)
      .map(item => item.retry_confirmation_receipt_id)
      .filter((receipt): receipt is string => Boolean(receipt)))
    let confirmedAmount = 0
    for (const row of rows) {
      const confirmation = this.generationDocument({ document_json: row.confirmation_json }, value => imageCampaignConfirmationReceiptSchema.parse(value))
      const estimate = this.generationDocument({ document_json: row.estimate_json }, value => imageCampaignEstimateSchema.parse(value))
      if (confirmation.estimate_hash !== estimate.estimate_hash || confirmation.purpose !== estimate.purpose) {
        throw new ImageWorkbenchRepositoryError('Campaign 确认收据与报价不一致', 500, 'IMAGE_STORAGE_INVALID')
      }
      if (
        confirmation.purpose === 'retry'
        && !usedRetryReceipts.has(confirmation.id)
        && Date.parse(estimate.expires_at) <= this.now().getTime()
      ) continue
      if (estimate.price_upper_bound.currency !== campaign.budget_limit.currency) {
        throw new ImageWorkbenchRepositoryError('Campaign 已确认报价币种与预算不一致', 422, 'IMAGE_BUDGET_EXCEEDED')
      }
      confirmedAmount += estimate.price_upper_bound.amount_minor
    }
    if (confirmedAmount + candidate.price_upper_bound.amount_minor > campaign.budget_limit.amount_minor) {
      throw new ImageWorkbenchRepositoryError('Campaign 预计费用超过预算上限', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
  }

  private assertCampaignItemSet(campaign: ImageCampaign, items: ImageCampaignItem[]): void {
    if (items.length !== campaign.planned_item_count) {
      throw new ImageWorkbenchRepositoryError('Campaign 项目数量与计划不一致', 409, 'IMAGE_STORAGE_INVALID')
    }
    const ids = new Set<string>()
    const ordinals = new Set<number>()
    for (const item of items) {
      if (item.campaign_id !== campaign.id || ids.has(item.id) || ordinals.has(item.ordinal)) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目事实无效', 409, 'IMAGE_STORAGE_INVALID')
      }
      ids.add(item.id)
      ordinals.add(item.ordinal)
    }
    for (let ordinal = 0; ordinal < items.length; ordinal += 1) {
      if (!ordinals.has(ordinal)) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目序号必须连续', 409, 'IMAGE_STORAGE_INVALID')
      }
    }
  }

  private assertCampaignStateTransition(current: ImageCampaign, next: ImageCampaign, nextItems: ImageCampaignItem[]): void {
    if (current.id !== next.id || !sameOwner(current.owner, next.owner) || current.created_at !== next.created_at) {
      throw new ImageWorkbenchRepositoryError('Campaign 事实不能改变', 409, 'IMAGE_STORAGE_INVALID')
    }
    if (next.revision !== current.revision + 1) {
      throw new ImageWorkbenchRepositoryError('Campaign revision 已过期或不是下一版本', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const transitions: Record<ImageCampaign['state'], readonly ImageCampaign['state'][]> = {
      draft: ['draft', 'confirmed', 'cancelled'],
      confirmed: ['confirmed', 'running', 'cancelled'],
      running: ['running', 'completed', 'cancelled'],
      // A terminal Campaign can be reopened only by an explicit per-item
      // retry command. It never recreates a prior Operation; the item must
      // advance to a new logical attempt first.
      completed: ['completed', 'running'],
      cancelled: ['cancelled', 'running'],
    }
    if (!transitions[current.state].includes(next.state)) {
      throw new ImageWorkbenchRepositoryError('Campaign 状态不能这样迁移', 409, 'IMAGE_REVISION_CONFLICT')
    }
    if (next.state === 'completed' && nextItems.some(item => ['draft', 'queued', 'running'].includes(item.state))) {
      throw new ImageWorkbenchRepositoryError('仍有未终态项目，不能完成 Campaign', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const immutableCurrent = {
      name: current.name,
      brand_kit_id: current.brand_kit_id,
      brand_kit_revision_id: current.brand_kit_revision_id,
      template_id: current.template_id,
      template_revision_id: current.template_revision_id,
      shared_brief: current.shared_brief,
      output_preset: current.output_preset,
      budget_limit: current.budget_limit,
    }
    const immutableNext = {
      name: next.name,
      brand_kit_id: next.brand_kit_id,
      brand_kit_revision_id: next.brand_kit_revision_id,
      template_id: next.template_id,
      template_revision_id: next.template_revision_id,
      shared_brief: next.shared_brief,
      output_preset: next.output_preset,
      budget_limit: next.budget_limit,
    }
    if (stableJson(immutableCurrent) !== stableJson(immutableNext)) {
      throw new ImageWorkbenchRepositoryError('Campaign 已冻结的创作事实不能改变', 409, 'IMAGE_STORAGE_INVALID')
    }
    if (current.confirmation_receipt_id && (
      next.confirmation_receipt_id !== current.confirmation_receipt_id
      || next.confirmed_at !== current.confirmed_at
      || next.estimate_hash !== current.estimate_hash
    )) {
      throw new ImageWorkbenchRepositoryError('Campaign 确认收据不能改变', 409, 'IMAGE_STORAGE_INVALID')
    }
  }

  private assertCampaignItemTransition(
    campaign: ImageCampaign,
    currentItems: ImageCampaignItem[],
    nextItems: ImageCampaignItem[],
    allowDraftReplacement: boolean,
  ): void {
    this.assertCampaignItemSet(campaign, nextItems)
    if (allowDraftReplacement) {
      if (campaign.state !== 'draft') {
        throw new ImageWorkbenchRepositoryError('只有草稿 Campaign 可以替换项目', 409, 'IMAGE_REVISION_CONFLICT')
      }
      return
    }
    if (currentItems.length !== nextItems.length) {
      throw new ImageWorkbenchRepositoryError('已创建的 Campaign 不能增删项目', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const byId = new Map(currentItems.map(item => [item.id, item]))
    const transitions: Record<ImageCampaignItem['state'], readonly ImageCampaignItem['state'][]> = {
      draft: ['draft', 'queued', 'cancelled'],
      queued: ['queued', 'running', 'ready', 'failed', 'cancelled'],
      running: ['running', 'ready', 'failed', 'cancelled'],
      ready: ['ready'],
      failed: ['failed', 'queued', 'cancelled'],
      cancelled: ['cancelled', 'queued'],
    }
    for (const next of nextItems) {
      const current = byId.get(next.id)
      if (!current || current.ordinal !== next.ordinal || current.created_at !== next.created_at
        || stableJson(current.variable_values) !== stableJson(next.variable_values)) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目身份不能改变', 409, 'IMAGE_STORAGE_INVALID')
      }
      if (!transitions[current.state].includes(next.state)) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目状态不能这样迁移', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const retry = (current.state === 'failed' || current.state === 'cancelled') && next.state === 'queued'
      if (retry) {
        if (next.attempt !== current.attempt + 1) {
          throw new ImageWorkbenchRepositoryError('重试必须创建明确的新付费尝试', 409, 'IMAGE_REVISION_CONFLICT')
        }
        if (!next.retry_estimate_hash || !next.retry_confirmation_receipt_id) {
          throw new ImageWorkbenchRepositoryError('Campaign 重试必须绑定新的费用确认回执', 409, 'IMAGE_REVISION_CONFLICT')
        }
      } else if (next.attempt !== current.attempt) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目尝试次数不能跳变', 409, 'IMAGE_REVISION_CONFLICT')
      }
      if (!retry && (
        next.retry_estimate_hash !== current.retry_estimate_hash
        || next.retry_confirmation_receipt_id !== current.retry_confirmation_receipt_id
      )) {
        throw new ImageWorkbenchRepositoryError('Campaign 已确认的重试费用回执不能修改', 409, 'IMAGE_STORAGE_INVALID')
      }
      if (current.project_id && next.project_id !== current.project_id && !retry) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目关联的图片项目不能改变', 409, 'IMAGE_STORAGE_INVALID')
      }
    }
  }

  private assertCampaignItemProjects(items: ImageCampaignItem[], owner: MediaOwner): void {
    const seenProjectIds = new Set<string>()
    for (const item of items) {
      if (!item.project_id) continue
      if (seenProjectIds.has(item.project_id)) {
        throw new ImageWorkbenchRepositoryError('一个图片项目不能同时属于多个 Campaign 项目', 409, 'IMAGE_STORAGE_INVALID')
      }
      seenProjectIds.add(item.project_id)
      const projectRow = this.projectRow(item.project_id)
      if (!projectRow) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目关联的图片项目不存在', 404, 'IMAGE_PROJECT_NOT_FOUND')
      }
      if (!sameOwner(this.loadProject(projectRow).owner, owner)) {
        throw new ImageWorkbenchRepositoryError('无权关联其他工作台的图片项目', 403, 'IMAGE_PROJECT_FORBIDDEN')
      }
      const existing = this.unitOfWork.database.query(`SELECT id,campaign_id FROM image_campaign_items
        WHERE project_id=?`).get(item.project_id) as { id: string; campaign_id: string } | null
      if (existing && existing.id !== item.id) {
        throw new ImageWorkbenchRepositoryError('图片项目已关联到其他 Campaign 项目', 409, 'IMAGE_STORAGE_INVALID')
      }
    }
  }

  private insertCampaignLocked(campaign: ImageCampaign, items: ImageCampaignItem[]): void {
    this.unitOfWork.database.query(`INSERT INTO image_campaigns(
      id,owner_kind,owner_id,revision,state,created_at,updated_at,document_json
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      campaign.id, campaign.owner.kind, campaign.owner.owner_id, campaign.revision, campaign.state,
      campaign.created_at, campaign.updated_at, JSON.stringify(campaign),
    )
    this.replaceCampaignItemsLocked(campaign, items)
  }

  private updateCampaignLocked(campaign: ImageCampaign, items: ImageCampaignItem[]): void {
    this.unitOfWork.database.query(`UPDATE image_campaigns SET revision=?,state=?,updated_at=?,document_json=? WHERE id=?`).run(
      campaign.revision, campaign.state, campaign.updated_at, JSON.stringify(campaign), campaign.id,
    )
    this.replaceCampaignItemsLocked(campaign, items)
  }

  private replaceCampaignItemsLocked(campaign: ImageCampaign, items: ImageCampaignItem[]): void {
    for (const item of items) {
      const existing = this.unitOfWork.database.query('SELECT campaign_id FROM image_campaign_items WHERE id=?')
        .get(item.id) as { campaign_id: string } | null
      if (existing && existing.campaign_id !== campaign.id) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目标识已被占用', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
    }
    this.unitOfWork.database.query('DELETE FROM image_campaign_items WHERE campaign_id=?').run(campaign.id)
    for (const item of items) {
      this.unitOfWork.database.query(`INSERT INTO image_campaign_items(
        id,campaign_id,ordinal,project_id,state,attempt,updated_at,document_json
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        item.id, item.campaign_id, item.ordinal, item.project_id ?? null, item.state, item.attempt,
        item.updated_at, JSON.stringify(item),
      )
    }
  }

  private mutateCampaignCommandLocked(input: {
    owner: MediaOwner
    campaign: ImageCampaign
    items: ImageCampaignItem[]
    base_revision: number
    idempotency_key: string
    request_hash: string
  }, allowDraftReplacement: boolean): { snapshot: ImageCampaignSnapshot; replayed: boolean } {
    const currentRow = this.campaignRow(input.campaign.id)
    if (!currentRow) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
    const current = this.workflowCampaign(currentRow)
    this.assertCampaignOwner(current, input.owner)
    const replay = this.campaignCommandResultLocked(current.id, input.idempotency_key, input.request_hash)
    if (replay) return { snapshot: replay, replayed: true }
    if (current.revision !== input.base_revision) {
      throw new ImageWorkbenchRepositoryError('Campaign revision 已过期，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
    }
    this.assertCampaignStateTransition(current, input.campaign, input.items)
    this.assertCampaignItemTransition(input.campaign, this.campaignItemsLocked(current.id), input.items, allowDraftReplacement)
    this.assertCampaignItemProjects(input.items, input.owner)
    const snapshot = imageCampaignResponseSchema.parse({ campaign: input.campaign, items: [...input.items].sort((left, right) => left.ordinal - right.ordinal) })
    this.updateCampaignLocked(snapshot.campaign, snapshot.items)
    this.saveCampaignCommandLocked(current.id, input.idempotency_key, input.request_hash, snapshot, snapshot.campaign.updated_at)
    return { snapshot, replayed: false }
  }

  async listCampaigns(owner: MediaOwner): Promise<ImageCampaignSnapshot[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT id,document_json FROM image_campaigns
      WHERE owner_kind=? AND owner_id=? ORDER BY updated_at DESC,id ASC`).all(owner.kind, owner.owner_id) as Array<{ document_json: string }>
    return rows.map(row => {
      const campaign = this.workflowCampaign(row)
      this.assertCampaignOwner(campaign, owner)
      return this.campaignSnapshotLocked(campaign.id)
    })
  }

  /** A Campaign index is intentionally local and paged; it must not poll every child Operation. */
  async listCampaignSummaries(owner: MediaOwner, input: { cursor?: number; limit?: number } = {}): Promise<{
    campaigns: ImageCampaign[]
    next_cursor?: number
  }> {
    await this.ready()
    const cursor = input.cursor ?? 0
    const limit = input.limit ?? 20
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new ImageWorkbenchRepositoryError('Campaign 列表分页参数无效', 400, 'IMAGE_STORAGE_INVALID')
    }
    const rows = this.unitOfWork.database.query(`SELECT document_json FROM image_campaigns
      WHERE owner_kind=? AND owner_id=? ORDER BY created_at DESC,id ASC LIMIT ? OFFSET ?`).all(
      owner.kind,
      owner.owner_id,
      limit + 1,
      cursor,
    ) as Array<{ document_json: string }>
    const campaigns = rows.slice(0, limit).map(row => {
      const campaign = this.workflowCampaign(row)
      this.assertCampaignOwner(campaign, owner)
      return campaign
    })
    return {
      campaigns,
      ...(rows.length > limit ? { next_cursor: cursor + limit } : {}),
    }
  }

  async getCampaign(campaignId: string, owner: MediaOwner): Promise<ImageCampaignSnapshot> {
    await this.ready()
    const row = this.campaignRow(campaignId)
    if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
    const campaign = this.workflowCampaign(row)
    this.assertCampaignOwner(campaign, owner)
    return this.campaignSnapshotLocked(campaign.id)
  }

  async campaignAttempt(campaignId: string, itemId: string, attempt: number, owner: MediaOwner): Promise<ImageCampaignAttempt | null> {
    await this.ready()
    const row = this.campaignRow(campaignId)
    if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
    this.assertCampaignOwner(this.workflowCampaign(row), owner)
    return this.campaignAttemptLocked(campaignId, itemId, attempt)
  }

  async campaignAttemptForExpectedProject(projectId: string, owner: MediaOwner): Promise<ImageCampaignAttempt | null> {
    await this.ready()
    const row = this.unitOfWork.database.query(`SELECT campaign_id,item_id,attempt FROM image_campaign_attempts
      WHERE expected_project_id=?`).get(projectId) as { campaign_id: string; item_id: string; attempt: number } | null
    if (!row) return null
    const campaign = this.campaignRow(row.campaign_id)
    if (!campaign) throw new ImageWorkbenchRepositoryError('Campaign 尝试引用的 Campaign 不存在', 500, 'IMAGE_STORAGE_INVALID')
    this.assertCampaignOwner(this.workflowCampaign(campaign), owner)
    return this.campaignAttemptLocked(row.campaign_id, row.item_id, row.attempt)
  }

  async campaignAttemptForGenerationOperation(operationId: string, owner: MediaOwner): Promise<ImageCampaignAttempt | null> {
    await this.ready()
    const row = this.unitOfWork.database.query(`SELECT campaign_id,item_id,attempt FROM image_campaign_attempts
      WHERE generation_operation_id=?`).get(operationId) as { campaign_id: string; item_id: string; attempt: number } | null
    if (!row) return null
    const campaign = this.campaignRow(row.campaign_id)
    if (!campaign) throw new ImageWorkbenchRepositoryError('Campaign 尝试引用的 Campaign 不存在', 500, 'IMAGE_STORAGE_INVALID')
    this.assertCampaignOwner(this.workflowCampaign(campaign), owner)
    return this.campaignAttemptLocked(row.campaign_id, row.item_id, row.attempt)
  }

  async ensureCampaignAttemptReservation(input: {
    campaign_id: string
    item_id: string
    attempt: number
    expected_project_id: string
    owner: MediaOwner
    created_at: string
  }): Promise<ImageCampaignAttempt> {
    await this.ready()
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      const campaign = this.workflowCampaign(row)
      this.assertCampaignOwner(campaign, input.owner)
      const item = this.campaignItemsLocked(campaign.id).find(candidate => candidate.id === input.item_id)
      if (!item || item.attempt !== input.attempt || item.state !== 'queued') {
        throw new ImageWorkbenchRepositoryError('Campaign 项目不再处于可预留的排队尝试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      return this.reserveCampaignAttemptLocked(input)
    }))
  }

  async markCampaignAttemptCancelled(input: {
    campaign_id: string
    item_id: string
    attempt: number
    expected_project_id: string
    owner: MediaOwner
    updated_at: string
  }): Promise<ImageCampaignAttempt> {
    await this.ready()
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      this.assertCampaignOwner(this.workflowCampaign(row), input.owner)
      const attempt = this.reserveCampaignAttemptLocked({
        campaign_id: input.campaign_id,
        item_id: input.item_id,
        attempt: input.attempt,
        expected_project_id: input.expected_project_id,
        created_at: input.updated_at,
      })
      if (attempt.state === 'cancellation_too_late') return attempt
      return this.updateCampaignAttemptLocked({ ...attempt, state: 'cancelled', updated_at: input.updated_at })
    }))
  }

  async markCampaignAttemptCancellationTooLate(input: {
    campaign_id: string
    item_id: string
    attempt: number
    owner: MediaOwner
    updated_at: string
  }): Promise<ImageCampaignAttempt | null> {
    await this.ready()
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      this.assertCampaignOwner(this.workflowCampaign(row), input.owner)
      const attempt = this.campaignAttemptLocked(input.campaign_id, input.item_id, input.attempt)
      if (!attempt || attempt.state === 'cancelled') return attempt
      return this.updateCampaignAttemptLocked({ ...attempt, state: 'cancellation_too_late', updated_at: input.updated_at })
    }))
  }

  /**
   * Cancel the exact, still-local Campaign attempt as one durable state
   * change.  A recovery process must never observe a cancelled formal
   * Operation beside a queued transport/attempt and decide it may POST.
   */
  async cancelCampaignAttemptBeforeSubmission(input: {
    campaign_id: string
    item_id: string
    attempt: number
    expected_project_id: string
    generation_operation_id: string
    owner: MediaOwner
    updated_at: string
  }): Promise<{ cancelled: boolean; operation: ImageOperationV2; transport: ImageOperation; attempt_record: ImageCampaignAttempt }> {
    await this.ready()
    return await this.fences.run(`project-${input.expected_project_id}`, async () => {
      let shouldNotify = false
      const result = this.unitOfWork.transaction(() => {
        const campaignRow = this.campaignRow(input.campaign_id)
        if (!campaignRow) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
        const campaign = this.workflowCampaign(campaignRow)
        this.assertCampaignOwner(campaign, input.owner)
        const item = this.campaignItemsLocked(campaign.id).find(candidate => candidate.id === input.item_id)
        let attempt = this.campaignAttemptLocked(campaign.id, input.item_id, input.attempt)
        if (!attempt) {
          if (!item || item.attempt !== input.attempt) {
            throw new ImageWorkbenchRepositoryError('Campaign 尝试已被新的项目替换', 409, 'IMAGE_REVISION_CONFLICT')
          }
          attempt = this.reserveCampaignAttemptLocked({
            campaign_id: campaign.id,
            item_id: item.id,
            attempt: item.attempt,
            expected_project_id: input.expected_project_id,
            created_at: input.updated_at,
          })
        }
        if (attempt.expected_project_id !== input.expected_project_id) {
          throw new ImageWorkbenchRepositoryError('Campaign 尝试已绑定其他确定性子项目', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        // An old delayed callback may be cancelling a durable attempt after a
        // user has already created a retry. Its explicit cancelled receipt is
        // sufficient authority to close only the old Project/Operation; it
        // must never write the newer Campaign item.
        if ((!item || item.attempt !== input.attempt) && attempt.state !== 'cancelled') {
          throw new ImageWorkbenchRepositoryError('Campaign 尝试已被新的项目替换', 409, 'IMAGE_REVISION_CONFLICT')
        }
        if (attempt.generation_operation_id && attempt.generation_operation_id !== input.generation_operation_id) {
          throw new ImageWorkbenchRepositoryError('Campaign 尝试已绑定其他正式生成操作', 409, 'IMAGE_REVISION_CONFLICT')
        }
        const operationRow = this.unitOfWork.database.query('SELECT document_json FROM image_generation_operations WHERE id=? AND project_id=?')
          .get(input.generation_operation_id, input.expected_project_id) as { document_json: string } | null
        if (!operationRow) throw new ImageWorkbenchRepositoryError('Campaign 尝试缺少正式生成操作', 404, 'IMAGE_OPERATION_NOT_FOUND')
        const currentOperation = this.loadGenerationOperation(operationRow)
        if (!currentOperation.transport_task_id) {
          throw new ImageWorkbenchRepositoryError('Campaign 尝试缺少传输操作', 500, 'IMAGE_STORAGE_INVALID')
        }
        const transportRow = this.operationRow(currentOperation.transport_task_id, true)
        if (!transportRow || transportRow.deleted) {
          throw new ImageWorkbenchRepositoryError('Campaign 尝试缺少传输操作', 404, 'IMAGE_OPERATION_NOT_FOUND')
        }
        const currentTransport = this.loadOperation(transportRow)
        if (attempt.state === 'cancellation_too_late') {
          return { cancelled: false, operation: currentOperation, transport: currentTransport, attempt_record: attempt }
        }
        const isLocalOnly = !currentTransport.remote_task_id
          && !currentTransport.remote_submission_started_at
          && ['queued', 'cancelled'].includes(currentOperation.status)
          && ['queued', 'cancelled'].includes(currentTransport.status)
        if (!isLocalOnly) {
          const tooLate = attempt.state === 'cancelled'
            ? attempt
            : this.updateCampaignAttemptLocked({ ...attempt, state: 'cancellation_too_late', updated_at: input.updated_at })
          return { cancelled: false, operation: currentOperation, transport: currentTransport, attempt_record: tooLate }
        }
        const safe = mediaSafeError('MEDIA_IMAGE_CANCELLED')
        const nextOperation = imageOperationV2Schema.parse({
          ...currentOperation,
          status: 'cancelled',
          cost_state: 'not_submitted',
          cancellation: {
            requested_at: currentOperation.cancellation?.requested_at ?? input.updated_at,
            remote_state: 'confirmed',
            late_result_policy: 'retain_as_unadopted',
          },
          completed_at: currentOperation.completed_at ?? input.updated_at,
          updated_at: input.updated_at,
        })
        const transportUpdate = this.updateOperationWithinTransaction(canonicalImageOperation({
          ...currentTransport,
          status: 'cancelled',
          progress: 0,
          stage: '已取消',
          error: safe.message,
          error_code: safe.code,
          outcome_unknown: false,
          updated_at: input.updated_at,
        }))
        this.persistGenerationOperation(nextOperation)
        const cancelledAttempt = attempt.state === 'cancelled'
          ? attempt
          : this.updateCampaignAttemptLocked({ ...attempt, state: 'cancelled', updated_at: input.updated_at })
        shouldNotify ||= transportUpdate.changed
        return {
          cancelled: true,
          operation: nextOperation,
          transport: transportUpdate.operation,
          attempt_record: cancelledAttempt,
        }
      })
      if (shouldNotify) this.notify(input.expected_project_id)
      return result
    })
  }

  async prepareCampaignCancellation(input: {
    campaign_id: string
    owner: MediaOwner
    base_revision: number
    idempotency_key: string
    request_hash: string
  }): Promise<{ intent: PreparedCampaignCancellation; replayed: boolean; outcome?: CampaignCancellationOutcome['outcome'] }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      const campaign = this.workflowCampaign(row)
      this.assertCampaignOwner(campaign, input.owner)
      const existing = this.unitOfWork.database.query(`SELECT request_hash,status,result_json FROM image_workflow_command_receipts
        WHERE scope='campaign-cancel' AND aggregate_id=? AND idempotency_key=?`).get(
        campaign.id,
        input.idempotency_key,
      ) as { request_hash: string; status: 'prepared' | 'complete'; result_json: string } | null
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ImageWorkbenchRepositoryError('Campaign 取消幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        if (existing.status === 'prepared') {
          return { intent: this.preparedCampaignCancellation(existing.result_json), replayed: true }
        }
        const outcome = this.campaignCancellationOutcome(existing.result_json)
        return { intent: outcome.intent, replayed: true, outcome: outcome.outcome }
      }
      if (campaign.revision !== input.base_revision) {
        throw new ImageWorkbenchRepositoryError('Campaign revision 已过期，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const intent: PreparedCampaignCancellation = {
        campaign_id: campaign.id,
        idempotency_key: input.idempotency_key,
        request_hash: requestHash,
        base_revision: input.base_revision,
        targets: this.campaignItemsLocked(campaign.id)
          .filter(item => !['ready', 'failed', 'cancelled'].includes(item.state))
          .map(item => ({ item_id: item.id, attempt: item.attempt })),
      }
      const now = this.iso()
      this.unitOfWork.database.query(`INSERT INTO image_workflow_command_receipts(
        scope,aggregate_id,idempotency_key,request_hash,status,result_json,created_at,updated_at
      ) VALUES('campaign-cancel',?,?,?,?,?,?,?)`).run(
        campaign.id,
        input.idempotency_key,
        requestHash,
        'prepared',
        JSON.stringify(intent),
        now,
        now,
      )
      return { intent, replayed: false }
    }))
  }

  /**
   * A queued Campaign target can cross its remote submission boundary while a
   * cancellation is in flight. Persist that observable outcome so recovery
   * replays the same 409 instead of later attempting an invalid terminal
   * Campaign transition.
   */
  async completeCampaignCancellationTooLate(input: {
    campaign_id: string
    owner: MediaOwner
    idempotency_key: string
    request_hash: string
    intent: PreparedCampaignCancellation
  }): Promise<void> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      this.assertCampaignOwner(this.workflowCampaign(row), input.owner)
      const existing = this.unitOfWork.database.query(`SELECT request_hash,status,result_json FROM image_workflow_command_receipts
        WHERE scope='campaign-cancel' AND aggregate_id=? AND idempotency_key=?`).get(
        input.campaign_id,
        input.idempotency_key,
      ) as { request_hash: string; status: 'prepared' | 'complete'; result_json: string } | null
      if (!existing) throw new ImageWorkbenchRepositoryError('Campaign 取消回执不存在', 500, 'IMAGE_STORAGE_INVALID')
      if (existing.request_hash !== requestHash) {
        throw new ImageWorkbenchRepositoryError('Campaign 取消幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      if (existing.status === 'complete') {
        const outcome = this.campaignCancellationOutcome(existing.result_json)
        if (outcome.outcome !== 'cancellation_too_late') {
          throw new ImageWorkbenchRepositoryError('Campaign 取消回执完成结果无效', 500, 'IMAGE_STORAGE_INVALID')
        }
        return
      }
      const outcome: CampaignCancellationOutcome = {
        kind: 'campaign_cancellation_outcome',
        outcome: 'cancellation_too_late',
        intent: input.intent,
      }
      this.unitOfWork.database.query(`UPDATE image_workflow_command_receipts
        SET status='complete',result_json=?,updated_at=?
        WHERE scope='campaign-cancel' AND aggregate_id=? AND idempotency_key=?`).run(
        JSON.stringify(outcome),
        this.iso(),
        input.campaign_id,
        input.idempotency_key,
      )
    }))
  }

  async listPreparedCampaignCancellations(owner: MediaOwner): Promise<PreparedCampaignCancellation[]> {
    await this.ready()
    const rows = this.unitOfWork.database.query(`SELECT receipts.aggregate_id,receipts.idempotency_key,receipts.request_hash,receipts.result_json,
      campaigns.document_json AS campaign_json
      FROM image_workflow_command_receipts receipts
      JOIN image_campaigns campaigns ON campaigns.id=receipts.aggregate_id
      WHERE receipts.scope='campaign-cancel' AND receipts.status='prepared'
        AND campaigns.owner_kind=? AND campaigns.owner_id=?
      ORDER BY receipts.created_at ASC`).all(owner.kind, owner.owner_id) as Array<{
        aggregate_id: string
        idempotency_key: string
        request_hash: string
        result_json: string
        campaign_json: string
      }>
    return rows.map(row => {
      this.assertCampaignOwner(this.workflowCampaign({ document_json: row.campaign_json }), owner)
      const intent = this.preparedCampaignCancellation(row.result_json)
      if (intent.campaign_id !== row.aggregate_id || intent.idempotency_key !== row.idempotency_key || intent.request_hash !== row.request_hash) {
        throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
      }
      return intent
    })
  }

  private preparedCampaignCancellation(value: string): PreparedCampaignCancellation {
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch {
      throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
    const record = parsed as Record<string, unknown>
    if (
      typeof record.campaign_id !== 'string'
      || typeof record.idempotency_key !== 'string'
      || typeof record.request_hash !== 'string'
      || typeof record.base_revision !== 'number'
      || !Number.isInteger(record.base_revision)
      || !Array.isArray(record.targets)
    ) {
      throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
    const targets = record.targets.map(target => {
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
      }
      const item = target as Record<string, unknown>
      if (typeof item.item_id !== 'string' || typeof item.attempt !== 'number' || !Number.isInteger(item.attempt) || item.attempt < 1) {
        throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
      }
      return { item_id: item.item_id, attempt: item.attempt }
    })
    return {
      campaign_id: record.campaign_id,
      idempotency_key: record.idempotency_key,
      request_hash: record.request_hash,
      base_revision: record.base_revision,
      targets,
    }
  }

  private campaignCancellationOutcome(value: string): CampaignCancellationOutcome {
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch {
      throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ImageWorkbenchRepositoryError('Campaign 取消回执损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
    const record = parsed as Record<string, unknown>
    if (record.kind !== 'campaign_cancellation_outcome' || record.outcome !== 'cancellation_too_late') {
      throw new ImageWorkbenchRepositoryError('Campaign 取消回执已完成但缺少命令结果', 500, 'IMAGE_STORAGE_INVALID')
    }
    return {
      kind: 'campaign_cancellation_outcome',
      outcome: 'cancellation_too_late',
      intent: this.preparedCampaignCancellation(JSON.stringify(record.intent)),
    }
  }

  /** Reads the immutable Campaign-to-Project receipt for any completed attempt. */
  async campaignProjectIntentForProject(projectId: string, owner: MediaOwner): Promise<ImageCampaignProjectIntent | null> {
    await this.ready()
    const row = this.unitOfWork.database.query(`SELECT campaign_id,document_json FROM image_campaign_project_intents
      WHERE project_id=?`).get(projectId) as { campaign_id: string; document_json: string } | null
    if (!row) return null
    const intent = this.generationDocument(row, value => imageCampaignProjectIntentSchema.parse(value))
    if (intent.project_id !== projectId || intent.campaign_id !== row.campaign_id) {
      throw new ImageWorkbenchRepositoryError('Campaign 项目意图收据损坏', 500, 'IMAGE_STORAGE_INVALID')
    }
    const campaignRow = this.campaignRow(intent.campaign_id)
    if (!campaignRow) throw new ImageWorkbenchRepositoryError('Campaign 项目意图引用的 Campaign 不存在', 500, 'IMAGE_STORAGE_INVALID')
    this.assertCampaignOwner(this.workflowCampaign(campaignRow), owner)
    return intent
  }

  async campaignCommandResult(campaignId: string, owner: MediaOwner, idempotencyKey: string, requestHash: string): Promise<ImageCampaignSnapshot | null> {
    await this.ready()
    const row = this.campaignRow(campaignId)
    if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
    this.assertCampaignOwner(this.workflowCampaign(row), owner)
    return this.campaignCommandResultLocked(campaignId, idempotencyKey, imageHashSchema.parse(requestHash))
  }

  /**
   * Creation uses a deterministic Campaign id.  It must be able to replay an
   * existing command before checking whether its frozen Brand/Template is
   * still active, while a missing aggregate remains a normal new creation.
   */
  async findCampaignCommandResult(campaignId: string, owner: MediaOwner, idempotencyKey: string, requestHash: string): Promise<ImageCampaignSnapshot | null> {
    await this.ready()
    const row = this.campaignRow(campaignId)
    if (!row) return null
    this.assertCampaignOwner(this.workflowCampaign(row), owner)
    return this.campaignCommandResultLocked(campaignId, idempotencyKey, imageHashSchema.parse(requestHash))
  }

  async createCampaignCommand(input: {
    owner: MediaOwner
    campaign: ImageCampaign
    items: ImageCampaignItem[]
    idempotency_key: string
    request_hash: string
  }): Promise<ImageCampaignSnapshot & { replayed: boolean }> {
    await this.ready()
    const campaign = imageCampaignSchema.parse(input.campaign)
    const items = input.items.map(item => imageCampaignItemSchema.parse(item))
    const requestHash = imageHashSchema.parse(input.request_hash)
    this.assertCampaignOwner(campaign, input.owner)
    if (campaign.revision !== 0 || campaign.state !== 'draft' || campaign.estimate_hash || campaign.confirmation_receipt_id || campaign.confirmed_at) {
      throw new ImageWorkbenchRepositoryError('Campaign 初始状态无效', 409, 'IMAGE_STORAGE_INVALID')
    }
    if (items.some(item => item.state !== 'draft' || item.attempt !== 1 || item.project_id)) {
      throw new ImageWorkbenchRepositoryError('Campaign 初始项目必须是未排队草稿', 409, 'IMAGE_STORAGE_INVALID')
    }
    this.assertCampaignItemSet(campaign, items)
    return await this.fences.run(`campaign-${campaign.id}`, async () => this.unitOfWork.transaction(() => {
      const existingRow = this.campaignRow(campaign.id)
      if (existingRow) {
        const existing = this.workflowCampaign(existingRow)
        this.assertCampaignOwner(existing, input.owner)
        const replay = this.campaignCommandResultLocked(campaign.id, input.idempotency_key, requestHash)
        if (replay) return { ...replay, replayed: true }
        throw new ImageWorkbenchRepositoryError('Campaign 标识已被占用', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      const snapshot = imageCampaignResponseSchema.parse({ campaign, items: [...items].sort((left, right) => left.ordinal - right.ordinal) })
      this.insertCampaignLocked(snapshot.campaign, snapshot.items)
      this.saveCampaignCommandLocked(campaign.id, input.idempotency_key, requestHash, snapshot, campaign.created_at)
      return { ...snapshot, replayed: false }
    }))
  }

  async replaceCampaignItemsCommand(input: {
    owner: MediaOwner
    campaign: ImageCampaign
    items: ImageCampaignItem[]
    base_revision: number
    idempotency_key: string
    request_hash: string
  }): Promise<ImageCampaignSnapshot & { replayed: boolean }> {
    await this.ready()
    const campaign = imageCampaignSchema.parse(input.campaign)
    const items = input.items.map(item => imageCampaignItemSchema.parse(item))
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`campaign-${campaign.id}`, async () => this.unitOfWork.transaction(() => {
      const result = this.mutateCampaignCommandLocked({
        ...input,
        campaign,
        items,
        request_hash: requestHash,
      }, true)
      return { ...result.snapshot, replayed: result.replayed }
    }))
  }

  async updateCampaignWithItemsCommand(input: {
    owner: MediaOwner
    campaign: ImageCampaign
    items: ImageCampaignItem[]
    base_revision: number
    idempotency_key: string
    request_hash: string
    /** Queued paid attempts are reserved in the same Campaign transaction. */
    attempt_reservations?: Array<{
      item_id: string
      attempt: number
      expected_project_id: string
    }>
  }): Promise<ImageCampaignSnapshot & { replayed: boolean }> {
    await this.ready()
    const campaign = imageCampaignSchema.parse(input.campaign)
    const items = input.items.map(item => imageCampaignItemSchema.parse(item))
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`campaign-${campaign.id}`, async () => this.unitOfWork.transaction(() => {
      const result = this.mutateCampaignCommandLocked({
        ...input,
        campaign,
        items,
        request_hash: requestHash,
      }, false)
      if (!result.replayed) {
        const currentItems = new Map(result.snapshot.items.map(item => [item.id, item]))
        for (const reservation of input.attempt_reservations ?? []) {
          const item = currentItems.get(reservation.item_id)
          if (!item || item.attempt !== reservation.attempt || item.state !== 'queued') {
            throw new ImageWorkbenchRepositoryError('Campaign 尝试预留与排队项目不一致', 409, 'IMAGE_STORAGE_INVALID')
          }
          this.reserveCampaignAttemptLocked({
            campaign_id: campaign.id,
            item_id: reservation.item_id,
            attempt: reservation.attempt,
            expected_project_id: reservation.expected_project_id,
            created_at: campaign.updated_at,
          })
        }
      }
      return { ...result.snapshot, replayed: result.replayed }
    }))
  }

  async saveCampaignEstimate(input: {
    owner: MediaOwner
    estimate: ImageCampaignEstimate
  }): Promise<{ campaign: ImageCampaign; estimate: ImageCampaignEstimate; replayed: boolean }> {
    await this.ready()
    const estimate = imageCampaignEstimateSchema.parse(input.estimate)
    return await this.fences.run(`campaign-${estimate.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(estimate.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      const campaign = this.workflowCampaign(row)
      this.assertCampaignOwner(campaign, input.owner)
      const existing = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_estimates
        WHERE estimate_hash=?`).get(estimate.estimate_hash) as { document_json: string } | null
      if (existing) {
        const stored = this.generationDocument(existing, value => imageCampaignEstimateSchema.parse(value))
        if (stableJson(stored) !== stableJson(estimate)) {
          throw new ImageWorkbenchRepositoryError('Campaign estimate hash 对应的内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        return { campaign, estimate: stored, replayed: true }
      }
      const retryItem = estimate.purpose === 'retry' && estimate.item_id
        ? this.campaignItemsLocked(campaign.id).find(item => item.id === estimate.item_id)
        : undefined
      const startEstimate = estimate.purpose === 'start'
        && campaign.state === 'draft'
        && estimate.paid_operation_count === this.campaignItemsLocked(campaign.id).length
      const retryEstimate = estimate.purpose === 'retry'
        && ['running', 'completed', 'cancelled'].includes(campaign.state)
        && estimate.paid_operation_count === 1
        && retryItem !== undefined
        && ['failed', 'cancelled'].includes(retryItem.state)
        && estimate.attempt === retryItem.attempt + 1
      if (campaign.revision !== estimate.campaign_revision || (!startEstimate && !retryEstimate)) {
        throw new ImageWorkbenchRepositoryError('Campaign 已变更，不能保存过期 estimate', 409, 'IMAGE_REVISION_CONFLICT')
      }
      this.unitOfWork.database.query(`INSERT INTO image_campaign_estimates(
        estimate_hash,campaign_id,campaign_revision,expires_at,created_at,document_json
      ) VALUES(?,?,?,?,?,?)`).run(
        estimate.estimate_hash, estimate.campaign_id, estimate.campaign_revision,
        estimate.expires_at, estimate.created_at, JSON.stringify(estimate),
      )
      return { campaign, estimate, replayed: false }
    }))
  }

  async getCampaignEstimate(campaignId: string, estimateHash: string, owner: MediaOwner): Promise<ImageCampaignEstimate> {
    await this.ready()
    const campaign = await this.getCampaign(campaignId, owner)
    const hash = imageHashSchema.parse(estimateHash)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_estimates
      WHERE campaign_id=? AND estimate_hash=?`).get(campaign.campaign.id, hash) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('Campaign estimate 不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageCampaignEstimateSchema.parse(value))
  }

  async latestCampaignEstimate(campaignId: string, owner: MediaOwner): Promise<ImageCampaignEstimate | null> {
    await this.ready()
    const campaign = await this.getCampaign(campaignId, owner)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_estimates
      WHERE campaign_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(campaign.campaign.id) as { document_json: string } | null
    return row ? this.generationDocument(row, value => imageCampaignEstimateSchema.parse(value)) : null
  }

  /** Retry confirmations reserve their own exact quote; they never rewrite the start receipt. */
  async listCampaignRetryConfirmations(campaignId: string, owner: MediaOwner): Promise<Array<{
    confirmation: ImageCampaignConfirmationReceipt
    estimate: ImageCampaignEstimate
  }>> {
    await this.ready()
    const campaign = await this.getCampaign(campaignId, owner)
    const rows = this.unitOfWork.database.query(`SELECT confirmations.document_json AS confirmation_json,
      estimates.document_json AS estimate_json
      FROM image_campaign_confirmations confirmations
      JOIN image_campaign_estimates estimates ON estimates.estimate_hash=confirmations.estimate_hash
      WHERE confirmations.campaign_id=? ORDER BY confirmations.created_at ASC, confirmations.id ASC`)
      .all(campaign.campaign.id) as Array<{ confirmation_json: string; estimate_json: string }>
    return rows.flatMap(row => {
      const confirmation = this.generationDocument({ document_json: row.confirmation_json }, value => imageCampaignConfirmationReceiptSchema.parse(value))
      if (confirmation.purpose !== 'retry') return []
      const estimate = this.generationDocument({ document_json: row.estimate_json }, value => imageCampaignEstimateSchema.parse(value))
      return [{ confirmation, estimate }]
    })
  }

  async getCampaignConfirmation(campaignId: string, confirmationId: string, owner: MediaOwner): Promise<ImageCampaignConfirmationReceipt> {
    await this.ready()
    const campaign = await this.getCampaign(campaignId, owner)
    const row = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_confirmations
      WHERE campaign_id=? AND id=?`).get(campaign.campaign.id, confirmationId) as { document_json: string } | null
    if (!row) throw new ImageWorkbenchRepositoryError('Campaign 确认收据不存在', 404, 'IMAGE_STORAGE_INVALID')
    return this.generationDocument(row, value => imageCampaignConfirmationReceiptSchema.parse(value))
  }

  async confirmCampaignCommand(input: {
    owner: MediaOwner
    campaign: ImageCampaign
    confirmation: ImageCampaignConfirmationReceipt
    base_revision: number
    idempotency_key: string
    request_hash: string
  }): Promise<ImageCampaignSnapshot & { confirmation: ImageCampaignConfirmationReceipt; replayed: boolean }> {
    await this.ready()
    const campaign = imageCampaignSchema.parse(input.campaign)
    const confirmation = imageCampaignConfirmationReceiptSchema.parse(input.confirmation)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`campaign-${campaign.id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(campaign.id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowCampaign(row)
      this.assertCampaignOwner(current, input.owner)
      const replay = this.campaignCommandResultLocked(current.id, input.idempotency_key, requestHash)
      if (replay) {
        if (!replay.campaign.confirmation_receipt_id) {
          throw new ImageWorkbenchRepositoryError('Campaign 确认命令回执缺少确认收据', 500, 'IMAGE_STORAGE_INVALID')
        }
        const receipt = this.unitOfWork.database.query('SELECT document_json FROM image_campaign_confirmations WHERE id=? AND campaign_id=?')
          .get(replay.campaign.confirmation_receipt_id, replay.campaign.id) as { document_json: string } | null
        if (!receipt) throw new ImageWorkbenchRepositoryError('Campaign 确认收据丢失', 500, 'IMAGE_STORAGE_INVALID')
        return { ...replay, confirmation: this.generationDocument(receipt, value => imageCampaignConfirmationReceiptSchema.parse(value)), replayed: true }
      }
      const items = this.campaignItemsLocked(current.id)
      if (current.revision !== input.base_revision || current.state !== 'draft'
        || confirmation.purpose !== 'start' || confirmation.item_id || confirmation.attempt !== undefined
        || confirmation.campaign_id !== current.id || confirmation.campaign_revision !== current.revision
        || campaign.state !== 'confirmed' || campaign.confirmation_receipt_id !== confirmation.id
        || campaign.estimate_hash !== confirmation.estimate_hash || campaign.confirmed_at !== confirmation.confirmed_at) {
        throw new ImageWorkbenchRepositoryError('Campaign 确认所依据的 revision 已过期', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const estimateRow = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_estimates
        WHERE campaign_id=? AND estimate_hash=?`).get(current.id, confirmation.estimate_hash) as { document_json: string } | null
      if (!estimateRow) throw new ImageWorkbenchRepositoryError('Campaign 确认引用的 estimate 不存在', 409, 'IMAGE_REVISION_CONFLICT')
      const estimate = this.generationDocument(estimateRow, value => imageCampaignEstimateSchema.parse(value))
      if (estimate.purpose !== 'start' || estimate.item_id || estimate.attempt !== undefined
        || estimate.campaign_revision !== current.revision || Date.parse(estimate.expires_at) <= this.now().getTime()) {
        throw new ImageWorkbenchRepositoryError('Campaign estimate 已过期，请重新估算', 409, 'IMAGE_REVISION_CONFLICT')
      }
      this.assertCampaignStateTransition(current, campaign, items)
      this.assertCampaignItemTransition(campaign, items, items, false)
      const collision = this.unitOfWork.database.query('SELECT document_json FROM image_campaign_confirmations WHERE id=?')
        .get(confirmation.id) as { document_json: string } | null
      if (collision) throw new ImageWorkbenchRepositoryError('Campaign 确认收据标识已被占用', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      const snapshot = imageCampaignResponseSchema.parse({ campaign, items })
      this.updateCampaignLocked(snapshot.campaign, snapshot.items)
      this.unitOfWork.database.query(`INSERT INTO image_campaign_confirmations(
        id,campaign_id,campaign_revision,estimate_hash,created_at,document_json
      ) VALUES(?,?,?,?,?,?)`).run(
        confirmation.id, confirmation.campaign_id, confirmation.campaign_revision,
        confirmation.estimate_hash, confirmation.confirmed_at, JSON.stringify(confirmation),
      )
      this.saveCampaignCommandLocked(current.id, input.idempotency_key, requestHash, snapshot, confirmation.confirmed_at)
      return { ...snapshot, confirmation, replayed: false }
    }))
  }

  /** A retry quote is confirmed under the same Campaign fence, without changing the initial start receipt. */
  async confirmCampaignRetryCommand(input: {
    owner: MediaOwner
    campaign_id: string
    item_id: string
    confirmation: ImageCampaignConfirmationReceipt
    base_revision: number
    idempotency_key: string
    request_hash: string
  }): Promise<ImageCampaignSnapshot & { confirmation: ImageCampaignConfirmationReceipt; replayed: boolean }> {
    await this.ready()
    const confirmation = imageCampaignConfirmationReceiptSchema.parse(input.confirmation)
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowCampaign(row)
      this.assertCampaignOwner(current, input.owner)
      const replay = this.campaignCommandResultLocked(current.id, input.idempotency_key, requestHash)
      if (replay) {
        const receipt = this.unitOfWork.database.query('SELECT document_json FROM image_campaign_confirmations WHERE id=? AND campaign_id=?')
          .get(confirmation.id, current.id) as { document_json: string } | null
        if (!receipt) throw new ImageWorkbenchRepositoryError('Campaign 重试确认收据丢失', 500, 'IMAGE_STORAGE_INVALID')
        return { ...replay, confirmation: this.generationDocument(receipt, value => imageCampaignConfirmationReceiptSchema.parse(value)), replayed: true }
      }
      const items = this.campaignItemsLocked(current.id)
      const item = items.find(candidate => candidate.id === input.item_id)
      if (
        current.revision !== input.base_revision
        || !['running', 'completed', 'cancelled'].includes(current.state)
        || !item
        || !['failed', 'cancelled'].includes(item.state)
        || confirmation.purpose !== 'retry'
        || confirmation.campaign_id !== current.id
        || confirmation.campaign_revision !== current.revision
        || confirmation.item_id !== item.id
        || confirmation.attempt !== item.attempt + 1
      ) {
        throw new ImageWorkbenchRepositoryError('Campaign 重试确认所依据的 revision 或项目状态已过期', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const estimateRow = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_estimates
        WHERE campaign_id=? AND estimate_hash=?`).get(current.id, confirmation.estimate_hash) as { document_json: string } | null
      if (!estimateRow) throw new ImageWorkbenchRepositoryError('Campaign 重试确认引用的 estimate 不存在', 409, 'IMAGE_REVISION_CONFLICT')
      const estimate = this.generationDocument(estimateRow, value => imageCampaignEstimateSchema.parse(value))
      if (
        estimate.purpose !== 'retry'
        || estimate.campaign_revision !== current.revision
        || estimate.item_id !== item.id
        || estimate.attempt !== item.attempt + 1
        || Date.parse(estimate.expires_at) <= this.now().getTime()
      ) {
        throw new ImageWorkbenchRepositoryError('Campaign 重试 estimate 已过期或不匹配', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const existingEstimateConfirmation = this.unitOfWork.database.query(`SELECT id FROM image_campaign_confirmations
        WHERE campaign_id=? AND estimate_hash=?`).get(current.id, confirmation.estimate_hash) as { id: string } | null
      if (existingEstimateConfirmation) {
        throw new ImageWorkbenchRepositoryError('Campaign 重试报价已被确认，不能重复创建费用回执', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      const existingAttemptConfirmationRows = this.unitOfWork.database.query(`SELECT confirmations.document_json AS confirmation_json,
        estimates.document_json AS estimate_json
        FROM image_campaign_confirmations confirmations
        JOIN image_campaign_estimates estimates ON estimates.estimate_hash=confirmations.estimate_hash
        WHERE confirmations.campaign_id=?`).all(current.id) as Array<{
          confirmation_json: string
          estimate_json: string
        }>
      const activeAttemptReceipt = existingAttemptConfirmationRows.some(row => {
        const prior = this.generationDocument({ document_json: row.confirmation_json }, value => imageCampaignConfirmationReceiptSchema.parse(value))
        if (prior.purpose !== 'retry' || prior.item_id !== item.id || prior.attempt !== item.attempt + 1) return false
        const priorEstimate = this.generationDocument({ document_json: row.estimate_json }, value => imageCampaignEstimateSchema.parse(value))
        return Date.parse(priorEstimate.expires_at) > this.now().getTime()
      })
      if (activeAttemptReceipt) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目已有仍有效的重试费用回执', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      this.assertCampaignRetryBudgetLocked(current, estimate)
      const collision = this.unitOfWork.database.query('SELECT document_json FROM image_campaign_confirmations WHERE id=?')
        .get(confirmation.id) as { document_json: string } | null
      if (collision) throw new ImageWorkbenchRepositoryError('Campaign 重试确认收据标识已被占用', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      const snapshot = imageCampaignResponseSchema.parse({ campaign: current, items })
      this.unitOfWork.database.query(`INSERT INTO image_campaign_confirmations(
        id,campaign_id,campaign_revision,estimate_hash,created_at,document_json
      ) VALUES(?,?,?,?,?,?)`).run(
        confirmation.id, confirmation.campaign_id, confirmation.campaign_revision,
        confirmation.estimate_hash, confirmation.confirmed_at, JSON.stringify(confirmation),
      )
      this.saveCampaignCommandLocked(current.id, input.idempotency_key, requestHash, snapshot, confirmation.confirmed_at)
      return { ...snapshot, confirmation, replayed: false }
    }))
  }

  /** Verify the immutable Round -> formal Operation -> transport chain before binding a Campaign attempt. */
  private assertCampaignAttemptGenerationLocked(projectId: string, roundId: string, operationId: string): void {
    const roundRow = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_rounds
      WHERE id=? AND project_id=?`).get(roundId, projectId) as { document_json: string } | null
    if (!roundRow) {
      throw new ImageWorkbenchRepositoryError('Campaign 尝试引用的生成 Round 不存在或不属于子项目', 409, 'IMAGE_STORAGE_INVALID')
    }
    const round = this.generationDocument(roundRow, value => imageGenerationRoundSchema.parse(value))
    if (round.project_id !== projectId || round.direction_operations.length !== 1 || round.direction_operations[0]?.operation_id !== operationId) {
      throw new ImageWorkbenchRepositoryError('Campaign 尝试的 Round 与正式生成操作不一致', 409, 'IMAGE_STORAGE_INVALID')
    }
    const operationRow = this.unitOfWork.database.query(`SELECT document_json FROM image_generation_operations
      WHERE id=? AND project_id=?`).get(operationId, projectId) as { document_json: string } | null
    if (!operationRow) {
      throw new ImageWorkbenchRepositoryError('Campaign 尝试引用的正式生成操作不存在或不属于子项目', 409, 'IMAGE_STORAGE_INVALID')
    }
    const operation = this.loadGenerationOperation(operationRow)
    if (operation.project_id !== projectId || !operation.transport_task_id) {
      throw new ImageWorkbenchRepositoryError('Campaign 尝试的正式生成操作缺少传输任务', 409, 'IMAGE_STORAGE_INVALID')
    }
    const transport = this.operationRow(operation.transport_task_id, true)
    if (!transport || transport.deleted || transport.project_id !== projectId) {
      throw new ImageWorkbenchRepositoryError('Campaign 尝试的传输任务不存在或不属于子项目', 409, 'IMAGE_STORAGE_INVALID')
    }
  }

  async recordCampaignItemProjectCommand(input: {
    campaign_id: string
    owner: MediaOwner
    base_revision: number
    item_id: string
    expected_attempt: number
    project_id: string
    generation_round_id: string
    generation_operation_id: string
    intent: ImageCampaignProjectIntent
    item_state: ImageCampaignItem['state']
    campaign_state?: ImageCampaign['state']
    idempotency_key: string
    request_hash: string
    updated_at: string
  }): Promise<ImageCampaignSnapshot & { replayed: boolean; suppressed: boolean }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    const intent = imageCampaignProjectIntentSchema.parse(input.intent)
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowCampaign(row)
      this.assertCampaignOwner(current, input.owner)
      const attempt = this.reserveCampaignAttemptLocked({
        campaign_id: current.id,
        item_id: input.item_id,
        attempt: input.expected_attempt,
        expected_project_id: input.project_id,
        created_at: input.updated_at,
      })
      const replay = this.campaignCommandResultLocked(current.id, input.idempotency_key, requestHash)
      if (replay) return { ...replay, replayed: true, suppressed: attempt.state === 'cancelled' }
      if (attempt.state === 'cancelled') {
        return { ...this.campaignSnapshotLocked(current.id), replayed: true, suppressed: true }
      }
      if (attempt.state === 'cancellation_too_late') {
        throw new ImageWorkbenchRepositoryError('Campaign 尝试已在取消竞态中开始执行，不能重新绑定', 409, 'IMAGE_REVISION_CONFLICT')
      }
      if (
        attempt.state === 'bound'
        && (attempt.generation_round_id !== input.generation_round_id || attempt.generation_operation_id !== input.generation_operation_id)
      ) {
        throw new ImageWorkbenchRepositoryError('Campaign 尝试已绑定其他生成操作', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      this.assertCampaignAttemptGenerationLocked(input.project_id, input.generation_round_id, input.generation_operation_id)
      const items = this.campaignItemsLocked(current.id)
      const item = items.find(candidate => candidate.id === input.item_id)
      if (!item) throw new ImageWorkbenchRepositoryError('Campaign 项目不存在', 404, 'IMAGE_STORAGE_INVALID')
      if (
        current.revision !== input.base_revision
        || item.attempt !== input.expected_attempt
        || item.state !== 'queued'
        || (item.project_id && item.project_id !== input.project_id)
      ) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目已进入其他尝试，不能绑定旧图片项目', 409, 'IMAGE_REVISION_CONFLICT')
      }
      if (
        intent.project_id !== input.project_id
        || intent.campaign_id !== current.id
        || intent.campaign_revision !== current.revision
        || intent.item_id !== item.id
        || intent.attempt !== item.attempt
        || intent.brand_kit_id !== current.brand_kit_id
        || intent.brand_kit_revision_id !== current.brand_kit_revision_id
        || intent.template_id !== current.template_id
        || intent.template_revision_id !== current.template_revision_id
      ) {
        throw new ImageWorkbenchRepositoryError('Campaign 项目意图与锁定事实不一致', 409, 'IMAGE_STORAGE_INVALID')
      }
      const existingIntent = this.unitOfWork.database.query(`SELECT document_json FROM image_campaign_project_intents
        WHERE project_id=?`).get(intent.project_id) as { document_json: string } | null
      if (existingIntent) {
        const prior = this.generationDocument(existingIntent, value => imageCampaignProjectIntentSchema.parse(value))
        if (stableJson(prior) !== stableJson(intent)) {
          throw new ImageWorkbenchRepositoryError('图片项目已绑定其他 Campaign 尝试', 409, 'IMAGE_STORAGE_INVALID')
        }
      } else {
        const priorAttempt = this.unitOfWork.database.query(`SELECT project_id FROM image_campaign_project_intents
          WHERE campaign_id=? AND item_id=? AND attempt=?`).get(intent.campaign_id, intent.item_id, intent.attempt) as { project_id: string } | null
        if (priorAttempt && priorAttempt.project_id !== intent.project_id) {
          throw new ImageWorkbenchRepositoryError('Campaign 尝试已绑定其他图片项目', 409, 'IMAGE_STORAGE_INVALID')
        }
        this.unitOfWork.database.query(`INSERT INTO image_campaign_project_intents(
          project_id,campaign_id,item_id,attempt,campaign_revision,created_at,document_json
        ) VALUES(?,?,?,?,?,?,?)`).run(
          intent.project_id, intent.campaign_id, intent.item_id, intent.attempt,
          intent.campaign_revision, input.updated_at, JSON.stringify(intent),
        )
      }
      const nextCampaign = imageCampaignSchema.parse({
        ...current,
        state: input.campaign_state ?? current.state,
        revision: current.revision + 1,
        updated_at: input.updated_at,
      })
      const nextItems = items.map(candidate => candidate.id === input.item_id
        ? imageCampaignItemSchema.parse({ ...candidate, project_id: input.project_id, state: input.item_state, updated_at: input.updated_at })
        : candidate)
      const result = this.mutateCampaignCommandLocked({
        owner: input.owner,
        campaign: nextCampaign,
        items: nextItems,
        base_revision: input.base_revision,
        idempotency_key: input.idempotency_key,
        request_hash: requestHash,
      }, false)
      this.updateCampaignAttemptLocked({
        ...attempt,
        generation_round_id: input.generation_round_id,
        generation_operation_id: input.generation_operation_id,
        state: 'bound',
        updated_at: input.updated_at,
      })
      return { ...result.snapshot, replayed: result.replayed, suppressed: false }
    }))
  }

  async updateCampaignItemStateCommand(input: {
    campaign_id: string
    owner: MediaOwner
    base_revision: number
    item_id: string
    item_state: ImageCampaignItem['state']
    campaign_state?: ImageCampaign['state']
    project_id?: string
    attempt?: number
    safe_error_code?: string
    idempotency_key: string
    request_hash: string
    updated_at: string
  }): Promise<ImageCampaignSnapshot & { replayed: boolean }> {
    await this.ready()
    const requestHash = imageHashSchema.parse(input.request_hash)
    return await this.fences.run(`campaign-${input.campaign_id}`, async () => this.unitOfWork.transaction(() => {
      const row = this.campaignRow(input.campaign_id)
      if (!row) throw new ImageWorkbenchRepositoryError('Campaign 不存在', 404, 'IMAGE_STORAGE_INVALID')
      const current = this.workflowCampaign(row)
      this.assertCampaignOwner(current, input.owner)
      const replay = this.campaignCommandResultLocked(current.id, input.idempotency_key, requestHash)
      if (replay) return { ...replay, replayed: true }
      const items = this.campaignItemsLocked(current.id)
      const item = items.find(candidate => candidate.id === input.item_id)
      if (!item) throw new ImageWorkbenchRepositoryError('Campaign 项目不存在', 404, 'IMAGE_STORAGE_INVALID')
      const { safe_error_code: _previousError, ...withoutPreviousError } = item
      const nextItem = imageCampaignItemSchema.parse({
        ...withoutPreviousError,
        ...(input.project_id ? { project_id: input.project_id } : {}),
        state: input.item_state,
        attempt: input.attempt ?? (item.state === 'failed' && input.item_state === 'queued' ? item.attempt + 1 : item.attempt),
        ...(input.item_state === 'failed' && input.safe_error_code ? { safe_error_code: input.safe_error_code } : {}),
        updated_at: input.updated_at,
      })
      const nextCampaign = imageCampaignSchema.parse({
        ...current,
        state: input.campaign_state ?? current.state,
        revision: current.revision + 1,
        updated_at: input.updated_at,
      })
      const result = this.mutateCampaignCommandLocked({
        owner: input.owner,
        campaign: nextCampaign,
        items: items.map(candidate => candidate.id === input.item_id ? nextItem : candidate),
        base_revision: input.base_revision,
        idempotency_key: input.idempotency_key,
        request_hash: requestHash,
      }, false)
      return { ...result.snapshot, replayed: result.replayed }
    }))
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
