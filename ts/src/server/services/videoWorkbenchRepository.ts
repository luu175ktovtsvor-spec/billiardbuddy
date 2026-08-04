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
import {
  SqliteMediaFactsRepository,
  type VideoFactsPage,
  type VideoFactSearchPage,
  type VideoFactEmbedding,
  type VideoFactEmbeddingRelayAcknowledgement,
} from '../video/infrastructure/sqliteMediaFactsRepository.js'
import type { VideoFact, VideoFactKind } from '../video/domain/mediaFacts/model.js'

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

type LegacyEventJournal = {
  next_cursor: number
  events: VideoOperationEvent[]
}

type LegacyDeletedProject = {
  receipt: MediaDeletionReceipt
  project: VideoStudioProject | null
  operations: VideoOperation[]
  journal: LegacyEventJournal | null
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

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Video is the first Media Kernel consumer. SQLite owns all project, operation,
 * event and deletion indices; immutable payloads only hold the full documents.
 * The former JSON directories are a strictly read-only migration source until
 * the contract's independent reconciliation and retirement exit conditions
 * have been met. This repository never writes, moves or deletes them.
 */
export class VideoWorkbenchRepository {
  private readonly root: string
  private readonly projectsDir: string
  private readonly assetsDir: string
  private readonly exportsDir: string
  private readonly trashDir: string
  private readonly legacyImportDir: string
  private readonly legacyOperationsDir: string
  private readonly legacyEventsDir: string
  private readonly legacyDeletionsDir: string
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
  readonly facts: SqliteMediaFactsRepository

  constructor(options: { root?: string; now?: () => Date } = {}) {
    this.root = options.root
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'videos')
    this.projectsDir = join(this.root, 'projects')
    this.assetsDir = join(this.root, 'assets')
    this.exportsDir = join(this.root, 'exports')
    this.trashDir = join(this.root, 'trash')
    this.legacyImportDir = join(this.root, 'legacy-import')
    this.legacyOperationsDir = join(this.root, 'operations')
    this.legacyEventsDir = join(this.root, 'events')
    this.legacyDeletionsDir = join(this.root, 'deletions')
    this.locksDir = join(this.root, 'locks')
    this.now = options.now ?? (() => new Date())
    this.unitOfWork = new SqliteUnitOfWork(this.root)
    this.payloads = new PayloadCommitProtocol(this.root, this.unitOfWork, this.now)
    this.fences = new WriterFence(this.locksDir)
    this.facts = new SqliteMediaFactsRepository(this.unitOfWork, this.payloads, this.fences, this.now)
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
      // Legacy directories are retained as read-only migration inputs. SQLite
      // remains the authority for all new operations and events.
      operations: this.legacyOperationsDir,
      events: this.legacyEventsDir,
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
    return await this.persistProject(next)
  }

  private async importLegacyProject(project: VideoStudioProject): Promise<void> {
    if (this.projectRow(project.id, true)) return
    // Migration is a copy into immutable payloads, not a user update. Keep the
    // old project document verbatim so current Timeline/Export projections can
    // be reconciled before the old reader is ever retired.
    await this.persistProject(videoStudioProjectSchema.parse(project))
  }

  private async persistProject(next: VideoStudioProject): Promise<VideoStudioProject> {
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

  async saveFact(value: VideoFact): Promise<VideoFact> {
    await this.ready()
    return await this.facts.save(value)
  }

  async getFact(kind: VideoFactKind, id: string): Promise<VideoFact> {
    await this.ready()
    return await this.facts.get(kind, id)
  }

  async listFacts(kind: VideoFactKind, projectId: string, sourceId?: string): Promise<VideoFact[]> {
    await this.ready()
    return await this.facts.list(kind, projectId, sourceId)
  }

  async pageFacts(kind: VideoFactKind, projectId: string, options?: { sourceId?: string; cursor?: string; limit?: number }): Promise<VideoFactsPage> {
    await this.ready()
    return await this.facts.page(kind, projectId, options)
  }

  async pageCurrentFacts(kind: VideoFactKind, projectId: string, options?: { sourceId?: string; cursor?: string; limit?: number }): Promise<VideoFactsPage> {
    await this.ready()
    return await this.facts.pageCurrent(kind, projectId, options)
  }

  async searchFacts(projectId: string, query: string, limit?: number) {
    await this.ready()
    return await this.facts.search(projectId, query, limit)
  }

  async searchFactsPage(projectId: string, query: string, options?: { cursor?: string; limit?: number }): Promise<VideoFactSearchPage> {
    await this.ready()
    return await this.facts.searchPage(projectId, query, options)
  }

  async listCurrentSearchCandidates(projectId: string) {
    await this.ready()
    return await this.facts.listCurrentSearchCandidates(projectId)
  }

  async missingSearchEmbeddingEntries(projectId: string, entryIds: string[]) {
    await this.ready()
    return await this.facts.missingSearchEmbeddingEntries(projectId, entryIds)
  }

  async saveFactEmbeddings(projectId: string, entries: VideoFactEmbedding[]): Promise<number> {
    await this.ready()
    return await this.facts.saveEmbeddings(projectId, entries)
  }

  async saveFactEmbeddingsWithRelayAcknowledgement(
    projectId: string,
    entries: VideoFactEmbedding[],
    acknowledgement: VideoFactEmbeddingRelayAcknowledgement,
  ): Promise<number> {
    await this.ready()
    return await this.facts.saveEmbeddingsWithRelayAcknowledgement(projectId, entries, acknowledgement)
  }

  async listPendingFactEmbeddingRelayAcknowledgements(projectId: string): Promise<VideoFactEmbeddingRelayAcknowledgement[]> {
    await this.ready()
    return await this.facts.listPendingEmbeddingRelayAcknowledgements(projectId)
  }

  async hasFactEmbeddingRelayAcknowledgement(
    projectId: string,
    acknowledgement: Pick<VideoFactEmbeddingRelayAcknowledgement, 'relay_operation_id' | 'receipt_id' | 'result_hashes'>,
  ): Promise<boolean> {
    await this.ready()
    return await this.facts.hasEmbeddingRelayAcknowledgement(projectId, acknowledgement)
  }

  async resolveFactEmbeddingRelayAcknowledgement(projectId: string, relayOperationId: string, state: 'acknowledged' | 'retired'): Promise<void> {
    await this.ready()
    await this.facts.resolveEmbeddingRelayAcknowledgement(projectId, relayOperationId, state)
  }

  async hybridSearchFactsPage(projectId: string, query: string, vector: number[], options?: { cursor?: string; limit?: number }): Promise<VideoFactSearchPage> {
    await this.ready()
    return await this.facts.hybridSearchPage(projectId, query, vector, options)
  }

  async activeTranscriptRevision(transcriptId: string): Promise<VideoFact | null> {
    await this.ready()
    return await this.facts.activeTranscriptRevision(transcriptId)
  }

  async selectTranscriptRevision(projectId: string, transcriptId: string, revisionId: string): Promise<VideoFact> {
    await this.ready()
    return await this.facts.selectTranscriptRevision(projectId, transcriptId, revisionId)
  }

  async reclaimLeastRecentlyUsedDerivatives(projectId: string, maxEvictions: number): Promise<string[]> {
    await this.ready()
    return await this.facts.reclaimLeastRecentlyUsedDerivatives(projectId, maxEvictions)
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

  private async importLegacyOperation(operation: VideoOperation): Promise<void> {
    const canonical = canonicalOperation({
      ...operation,
      operation_id: operation.operation_id ?? operationId(operation.project_id, operation),
    })
    const existing = this.operationRow(operation.id, true)
    if (existing && JSON.stringify(await this.loadOperation(existing)) === JSON.stringify(canonical)) return
    // Do not route a legacy value through saveOperationLocked(): that method
    // intentionally generates the next sequence for a new write. Import must
    // retain the original status_sequence and timestamps exactly.
    await this.persistOperation(canonical, false)
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
    const page = this.events.list(projectId, after, limit)
    const events = await Promise.all(page.events.map(async row => await this.eventFromRow(row)))
    return { events, cursor: page.cursor, reset_required: page.reset_required }
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
    // SQLite locators deliberately keep addressing immutable project payloads
    // below projects/<id>. Moving that directory would make a deleted project's
    // history unverifiable until restore. Deletion hides the rows in SQLite and
    // moves mutable managed assets only; payload collection is a later,
    // explicit retention operation after references have expired.
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
    // A pre-fix deletion may have moved immutable payloads to trash/project;
    // keep this compatibility move for recovery, while new deletions leave the
    // payload directory in place so locators remain valid.
    if (await this.exists(trashedProject)) await this.moveIfPresent(trashedProject, activeProject)
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
      } else if (this.facts.owns(intent)) {
        await this.facts.commitIntent(intent.id)
      } else {
        this.unitOfWork.transaction(() => this.payloads.markAbandoned(intent.id))
      }
    }
  }

  private abandonPreparedIntent(intent: PayloadCommitIntent): void {
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query("UPDATE video_project_payloads SET state='abandoned' WHERE intent_id=? AND state='prepared'").run(intent.id)
      this.unitOfWork.database.query("UPDATE video_operation_payloads SET state='abandoned' WHERE intent_id=? AND state='prepared'").run(intent.id)
      this.facts.abandonIntent(intent)
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
    const existing = this.unitOfWork.database.query('SELECT cursor FROM media_outbox_events WHERE legacy_key=?').get(legacyKey) as { cursor: number } | null
    if (existing) {
      // Repair databases written by the initial v1 importer, which allocated a
      // fresh SQLite cursor instead of retaining the legacy journal cursor.
      // The immutable event payload is already the same source document; only
      // its index needs to be corrected before reconciliation can proceed.
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`UPDATE media_outbox_events
          SET cursor=?,project_id=?,operation_id=?,status_sequence=?,occurred_at=?
          WHERE legacy_key=?`).run(
          event.cursor,
          event.project_id,
          event.operation_id,
          event.status_sequence,
          event.occurred_at,
          legacyKey,
        )
      })
      return
    }
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
      }, event.cursor)
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
    const migrationKey = 'video-json-to-sqlite-v1-imported'
    // Always open and validate the retained reader. It remains deliberately
    // read-only after import, so legacy projects can be audited before a
    // separate retirement change proves the contract exit conditions.
    const legacy = await this.readLegacyJson()
    const complete = this.unitOfWork.database.query('SELECT migration_key FROM media_legacy_imports WHERE migration_key=?').get(migrationKey)
    if (complete) return

    for (const project of legacy.projects) {
      await this.fences.run(`project-${project.id}`, async () => await this.importLegacyProject(project))
    }
    for (const operation of legacy.operations) {
      await this.fences.run(`project-${operation.project_id}`, async () => await this.importLegacyOperation(operation))
    }
    for (const [projectId, journal] of legacy.journals) {
      await this.importLegacyJournal(projectId, journal, `legacy-events/${projectId}.json`)
    }
    for (const item of legacy.deletedProjects) {
      if (!this.storedDeletions().some(candidate => candidate.deletion_id === item.receipt.deletion_id)) {
        this.unitOfWork.transaction(() => this.writeDeletion(item.receipt))
      }
      await this.migrateLegacyDeletedProject(item)
    }

    await this.reconcileLegacyImport(legacy)
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query('INSERT INTO media_legacy_imports(migration_key,completed_at) VALUES(?,?)')
        .run(migrationKey, this.iso())
    })
  }

  /**
   * The former deletion store keeps JSON below trash/<key>/project.json. The
   * documents stay there as a read-only source. SQLite hides their copied
   * payloads without moving them, so their content-addressed locators remain
   * verifiable while the project is deleted.
   */
  private async migrateLegacyDeletedProject(legacy: LegacyDeletedProject): Promise<void> {
    const { receipt } = legacy
    const persisted = this.storedDeletions().find(item => item.deletion_id === receipt.deletion_id)?.receipt
    if (receipt.status === 'purged' || receipt.status === 'restored' || persisted?.status === 'purged' || persisted?.status === 'restored') return
    const activeProject = this.projectDirectory(receipt.project_id)
    const misplacedPayloads = join(this.trashPath(receipt.trash_key), 'project')
    // Repair the first v1 implementation, which moved immutable payloads but
    // left SQLite locators under projects/<id>. This relocation touches only
    // the new payload tree; the old project.json remains a read-only source.
    if (!(await this.exists(activeProject)) && await this.exists(misplacedPayloads)) {
      await this.moveIfPresent(misplacedPayloads, activeProject)
    }
    if (legacy.project) await this.fences.run(`project-${legacy.project.id}`, async () => await this.importLegacyProject(legacy.project!))
    for (const operation of legacy.operations) {
      await this.fences.run(`project-${operation.project_id}`, async () => await this.importLegacyOperation(operation))
    }
    if (legacy.journal) await this.importLegacyJournal(
      receipt.project_id,
      legacy.journal,
      `legacy-trash-events/${receipt.trash_key}/events.json`,
    )
    const row = this.projectRow(receipt.project_id, true)
    if (row && !row.deleted) {
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query('UPDATE video_projects SET deleted=1 WHERE id=?').run(receipt.project_id)
        this.unitOfWork.database.query('UPDATE video_operations SET deleted=1 WHERE project_id=?').run(receipt.project_id)
      })
    }
  }

  private async importLegacyJournal(projectId: string, journal: LegacyEventJournal, legacyPath: string): Promise<void> {
    for (const event of journal.events) {
      await this.fences.run(`project-${projectId}`, async () => await this.importLegacyEvent(
        event,
        `${legacyPath}#${event.cursor}`,
      ))
    }
    this.unitOfWork.transaction(() => this.events.preserveLegacyCursorState(
      projectId,
      journal.next_cursor,
      journal.events[0]?.cursor ?? journal.next_cursor,
    ))
  }

  private async readLegacyJson(): Promise<{
    projects: VideoStudioProject[]
    operations: VideoOperation[]
    journals: Map<string, LegacyEventJournal>
    deletedProjects: LegacyDeletedProject[]
  }> {
    // `legacy-import/` is read only for a short-lived compatibility upgrade:
    // the first revision of this branch moved files there. New code never puts
    // files in that directory, but retaining this fallback repairs any such
    // early database without abandoning its historical reader.
    const projectFiles = await this.legacyJsonFiles(this.projectsDir, join(this.legacyImportDir, 'projects'))
    const operationFiles = await this.legacyJsonFiles(this.legacyOperationsDir, join(this.legacyImportDir, 'operations'))
    const eventFiles = await this.legacyJsonFiles(this.legacyEventsDir, join(this.legacyImportDir, 'events'))
    const deletionFiles = await this.legacyJsonFiles(this.legacyDeletionsDir, join(this.legacyImportDir, 'deletions'))
    const projects = await Promise.all(projectFiles.map(async ([name, path]) => {
      const item = videoStudioProjectSchema.parse(await this.readLegacyValue(path, '项目'))
      if (name !== `${item.id}.json`) throw new VideoWorkbenchRepositoryError('旧视频项目文件名与内容不匹配', 500, 'VIDEO_STORAGE_INVALID')
      return item
    }))
    const operations = await Promise.all(operationFiles.map(async ([name, path]) => {
      const item = canonicalOperation(await this.readLegacyValue(path, '操作'))
      if (name !== `${item.id}.json`) throw new VideoWorkbenchRepositoryError('旧视频操作文件名与内容不匹配', 500, 'VIDEO_STORAGE_INVALID')
      return item
    }))
    const journals = new Map<string, LegacyEventJournal>()
    for (const [name, path] of eventFiles) {
      const projectId = name.slice(0, -'.json'.length)
      this.assertId(projectId, 'project')
      journals.set(projectId, this.parseLegacyJournal(await this.readLegacyValue(path, '操作日志'), projectId))
    }
    const deletedProjects: LegacyDeletedProject[] = []
    for (const [name, path] of deletionFiles) {
      const receipt = mediaDeletionReceiptSchema.parse(await this.readLegacyValue(path, '删除记录'))
      if (name !== `${receipt.deletion_id}.json`) throw new VideoWorkbenchRepositoryError('旧视频删除记录文件名与内容不匹配', 500, 'VIDEO_STORAGE_INVALID')
      const trash = this.trashPath(receipt.trash_key)
      const archivedTrash = join(this.legacyImportDir, 'trash', receipt.trash_key)
      const projectPath = await this.legacyFilePath(join(trash, 'project.json'), join(archivedTrash, 'project.json'))
      const project = await this.exists(projectPath)
        ? videoStudioProjectSchema.parse(await this.readLegacyValue(projectPath, '回收区项目'))
        : null
      const operationsDirectory = join(trash, 'operations')
      const trashOperations = await Promise.all((await this.legacyJsonFiles(operationsDirectory, join(archivedTrash, 'operations'))).map(async ([, operationPath]) => (
        canonicalOperation(await this.readLegacyValue(operationPath, '回收区操作'))
      )))
      const eventsPath = await this.legacyFilePath(join(trash, 'events.json'), join(archivedTrash, 'events.json'))
      const journal = await this.exists(eventsPath)
        ? this.parseLegacyJournal(await this.readLegacyValue(eventsPath, '回收区操作日志'), receipt.project_id)
        : null
      if (project && project.id !== receipt.project_id) {
        throw new VideoWorkbenchRepositoryError('旧回收区项目与删除记录不匹配', 500, 'VIDEO_STORAGE_INVALID')
      }
      if (trashOperations.some(operation => operation.project_id !== receipt.project_id)) {
        throw new VideoWorkbenchRepositoryError('旧回收区操作与删除记录不匹配', 500, 'VIDEO_STORAGE_INVALID')
      }
      deletedProjects.push({ receipt, project, operations: trashOperations, journal })
    }
    return { projects, operations, journals, deletedProjects }
  }

  private async legacyJsonNames(directory: string): Promise<string[]> {
    return (await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })).filter(name => name.endsWith('.json')).sort()
  }

  private async legacyJsonFiles(primary: string, archived: string): Promise<Array<[string, string]>> {
    const files = new Map<string, string>()
    for (const directory of [primary, archived]) {
      for (const name of await this.legacyJsonNames(directory)) {
        if (!files.has(name)) files.set(name, join(directory, name))
      }
    }
    return [...files.entries()].sort(([left], [right]) => left.localeCompare(right))
  }

  private async legacyFilePath(primary: string, archived: string): Promise<string> {
    return await this.exists(primary) ? primary : archived
  }

  private async readLegacyValue(path: string, label: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      throw new VideoWorkbenchRepositoryError(`旧视频${label}损坏，无法安全迁移`, 500, 'VIDEO_STORAGE_INVALID')
    }
  }

  private parseLegacyJournal(value: unknown, expectedProjectId: string): LegacyEventJournal {
    if (!value || typeof value !== 'object') throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
    const journal = value as { schema_version?: unknown; next_cursor?: unknown; events?: unknown }
    if (journal.schema_version !== 1 || !isPositiveSafeInteger(journal.next_cursor) || !Array.isArray(journal.events)) {
      throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
    }
    const nextCursor = journal.next_cursor
    const seen = new Set<number>()
    const events = journal.events.map(raw => {
      if (!raw || typeof raw !== 'object') throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      const event = raw as Partial<VideoOperationEvent>
      const operation = canonicalOperation(event.operation)
      const cursor = event.cursor
      const statusSequence = event.status_sequence
      if (event.schema_version !== 1 || !isPositiveSafeInteger(cursor) || cursor >= nextCursor) {
        throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      }
      if (event.project_id !== expectedProjectId || typeof event.operation_id !== 'string' || event.operation_id !== (operation.operation_id ?? operation.id)) {
        throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      }
      if (!isNonnegativeSafeInteger(statusSequence)) {
        throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      }
      if (typeof event.occurred_at !== 'string' || !Number.isFinite(Date.parse(event.occurred_at)) || seen.has(cursor)) {
        throw new VideoWorkbenchRepositoryError('旧视频操作日志损坏，无法安全迁移', 500, 'VIDEO_STORAGE_INVALID')
      }
      seen.add(cursor)
      return {
        schema_version: 1 as const,
        cursor,
        project_id: expectedProjectId,
        operation_id: event.operation_id,
        status_sequence: statusSequence,
        occurred_at: event.occurred_at,
        operation,
      }
    }).sort((left, right) => left.cursor - right.cursor)
    return { next_cursor: nextCursor, events }
  }

  private async reconcileLegacyImport(legacy: Awaited<ReturnType<VideoWorkbenchRepository['readLegacyJson']>>): Promise<void> {
    const projects = [...legacy.projects, ...legacy.deletedProjects.flatMap(item => item.project ? [item.project] : [])]
    const operations = [...legacy.operations, ...legacy.deletedProjects.flatMap(item => item.operations)]
    if (new Set(projects.map(project => project.id)).size !== projects.length || new Set(operations.map(operation => operation.id)).size !== operations.length) {
      throw new VideoWorkbenchRepositoryError('旧视频迁移记录存在重复 ID，无法安全对账', 500, 'VIDEO_STORAGE_INVALID')
    }
    for (const project of projects) {
      const row = this.projectRow(project.id, true)
      if (!row || !this.sameMigrationProject(project, await this.loadProject(row))) {
        throw new VideoWorkbenchRepositoryError('旧视频项目数量、Timeline 或 Export 对账失败', 500, 'VIDEO_STORAGE_INVALID')
      }
    }
    for (const operation of operations) {
      const row = this.operationRow(operation.id, true)
      if (!row || JSON.stringify(operation) !== JSON.stringify(await this.loadOperation(row))) {
        throw new VideoWorkbenchRepositoryError('旧视频操作 status_sequence 对账失败', 500, 'VIDEO_STORAGE_INVALID')
      }
    }
    for (const [projectId, journal] of legacy.journals) await this.reconcileLegacyJournal(projectId, journal)
    for (const item of legacy.deletedProjects) {
      if (!this.storedDeletions().some(candidate => candidate.deletion_id === item.receipt.deletion_id)) {
        throw new VideoWorkbenchRepositoryError('旧视频删除记录对账失败', 500, 'VIDEO_STORAGE_INVALID')
      }
      if (item.journal) await this.reconcileLegacyJournal(item.receipt.project_id, item.journal)
    }
  }

  private sameMigrationProject(left: VideoStudioProject, right: VideoStudioProject): boolean {
    return JSON.stringify({
      id: left.id,
      sources: left.sources,
      timeline: left.timeline,
      timeline_versions: left.timeline_versions,
      current_timeline_version_id: left.current_timeline_version_id,
      output: left.output,
      output_path: left.output_path,
      output_asset_id: left.output_asset_id,
      output_content_hash: left.output_content_hash,
      output_verification: left.output_verification,
      assets: left.assets,
      versions: left.versions,
    }) === JSON.stringify({
      id: right.id,
      sources: right.sources,
      timeline: right.timeline,
      timeline_versions: right.timeline_versions,
      current_timeline_version_id: right.current_timeline_version_id,
      output: right.output,
      output_path: right.output_path,
      output_asset_id: right.output_asset_id,
      output_content_hash: right.output_content_hash,
      output_verification: right.output_verification,
      assets: right.assets,
      versions: right.versions,
    })
  }

  private async reconcileLegacyJournal(projectId: string, journal: LegacyEventJournal): Promise<void> {
    const actualRows = this.events.listAll(projectId)
    if (actualRows.length !== journal.events.length) {
      throw new VideoWorkbenchRepositoryError('旧视频 Event 数量对账失败', 500, 'VIDEO_STORAGE_INVALID')
    }
    const actual = await Promise.all(actualRows.map(async row => await this.eventFromRow(row)))
    if (actual.some((event, index) => JSON.stringify(event) !== JSON.stringify(journal.events[index]))) {
      throw new VideoWorkbenchRepositoryError('旧视频 Event cursor 或内容对账失败', 500, 'VIDEO_STORAGE_INVALID')
    }
    const state = this.events.cursorState(projectId)
    if (!state || state.next_cursor !== journal.next_cursor) {
      throw new VideoWorkbenchRepositoryError('旧视频 Event next_cursor 对账失败', 500, 'VIDEO_STORAGE_INVALID')
    }
  }
}
