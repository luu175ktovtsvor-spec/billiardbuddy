import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AssetIntegrity } from '../../media/kernel/assets/assetIntegrity.js'
import { PayloadCommitProtocol, type PayloadCommitIntent } from '../../media/kernel/storage/payloadCommitProtocol.js'
import { SqliteUnitOfWork } from '../../media/kernel/storage/sqliteUnitOfWork.js'
import { WriterFence } from '../../media/kernel/storage/writerFence.js'
import {
  factKind,
  factSchema,
  factSearchText,
  type VideoFact,
  type VideoFactKind,
  type TimedTranscript,
  type TranscriptRevision,
} from '../domain/mediaFacts/model.js'
import { transcriptRevisionFingerprint } from '../domain/mediaFacts/transcript.js'

type FactRow = {
  id: string
  project_id: string
  source_id: string | null
  source_fingerprint: string | null
  state: string
  updated_at: string
  last_accessed_at: string
  payload_hash: `sha256:${string}`
  payload_locator: string
  payload_schema: string
  payload_version: number
}

type FactPayloadRow = {
  intent_id: string
  fact_kind: VideoFactKind
  fact_id: string
  project_id: string
  source_id: string | null
  source_fingerprint: string | null
  payload_hash: `sha256:${string}`
  payload_locator: string
  payload_schema: string
  payload_version: number
  state: 'prepared' | 'committed' | 'abandoned'
}

export type VideoFactsPage = {
  items: VideoFact[]
  next_cursor?: string
}

const TABLE_BY_KIND: Record<VideoFactKind, string> = {
  source: 'video_fact_sources',
  derivative: 'video_fact_derivatives',
  transcript: 'video_fact_transcripts',
  transcript_revision: 'video_fact_transcript_revisions',
  camera_shot: 'video_fact_camera_shots',
  content_segment: 'video_fact_content_segments',
  evidence_window: 'video_fact_evidence_windows',
  evidence: 'video_fact_evidence',
}

function sourceFields(value: VideoFact): { sourceId: string | null; sourceFingerprint: string | null; state: string } {
  if ('fast_identity' in value) return { sourceId: value.id, sourceFingerprint: value.fingerprint ?? null, state: value.state }
  if ('source_id' in value) {
    return {
      sourceId: value.source_id,
      sourceFingerprint: 'source_fingerprint' in value ? value.source_fingerprint : null,
      state: 'state' in value ? String(value.state) : 'ready',
    }
  }
  return { sourceId: null, sourceFingerprint: null, state: 'ready' }
}

function factUpdatedAt(value: VideoFact): string {
  return 'updated_at' in value ? value.updated_at : value.created_at
}

export class VideoFactsRepositoryError extends Error {
  constructor(message: string, readonly code: 'VIDEO_FACTS_INVALID' | 'VIDEO_FACTS_NOT_FOUND' | 'VIDEO_FACTS_CORRUPT') {
    super(message)
    this.name = 'VideoFactsRepositoryError'
  }
}

/**
 * SQLite owns every Media Fact index; payloads only retain immutable detail.
 * It deliberately has no JSON-directory reader or writer, keeping the legacy
 * project reader isolated in VideoWorkbenchRepository during the migration.
 */
export class SqliteMediaFactsRepository {
  private readonly integrity = new AssetIntegrity()

  constructor(
    private readonly unitOfWork: SqliteUnitOfWork,
    private readonly payloads: PayloadCommitProtocol,
    private readonly fences: WriterFence,
    private readonly now: () => Date = () => new Date(),
  ) {}

  owns(intent: PayloadCommitIntent): boolean {
    return intent.entity_kind.startsWith('video_fact_')
  }

  async save(value: VideoFact): Promise<VideoFact> {
    const kind = factKind(value)
    const parsed = factSchema(kind).parse(value)
    return await this.fences.run(`project-${parsed.project_id}`, async () => await this.saveLocked(kind, parsed))
  }

  async get(kind: VideoFactKind, id: string): Promise<VideoFact> {
    const table = TABLE_BY_KIND[kind]
    const row = this.unitOfWork.database.query(`SELECT * FROM ${table} WHERE id=? AND state NOT IN ('prepared','abandoned')`).get(id) as FactRow | null
    if (!row) throw new VideoFactsRepositoryError('视频事实不存在', 'VIDEO_FACTS_NOT_FOUND')
    const value = await this.readRow(kind, row)
    if (kind === 'derivative') {
      await this.fences.run(`project-${row.project_id}`, async () => {
        this.unitOfWork.database.query('UPDATE video_fact_derivatives SET last_accessed_at=? WHERE id=?').run(this.now().toISOString(), id)
      })
    }
    return value
  }

  async list(kind: VideoFactKind, projectId: string, sourceId?: string): Promise<VideoFact[]> {
    const table = TABLE_BY_KIND[kind]
    const rows = this.unitOfWork.database.query(`SELECT * FROM ${table}
      WHERE project_id=? AND state NOT IN ('prepared','abandoned')${sourceId ? ' AND source_id=?' : ''}
      ORDER BY updated_at DESC,id`).all(...(sourceId ? [projectId, sourceId] : [projectId])) as FactRow[]
    return await Promise.all(rows.map(async row => await this.readRow(kind, row)))
  }

  async page(kind: VideoFactKind, projectId: string, options: { sourceId?: string; cursor?: string; limit?: number } = {}): Promise<VideoFactsPage> {
    const table = TABLE_BY_KIND[kind]
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    const cursor = options.cursor ? this.decodeCursor(options.cursor) : undefined
    const values: Array<string | number> = [projectId]
    let where = "project_id=? AND state NOT IN ('prepared','abandoned')"
    if (options.sourceId) {
      where += ' AND source_id=?'
      values.push(options.sourceId)
    }
    if (cursor) {
      where += ' AND (updated_at < ? OR (updated_at=? AND id>?))'
      values.push(cursor.updated_at, cursor.updated_at, cursor.id)
    }
    values.push(limit + 1)
    const rows = this.unitOfWork.database.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY updated_at DESC,id LIMIT ?`)
      .all(...values) as FactRow[]
    const visible = rows.slice(0, limit)
    return {
      items: await Promise.all(visible.map(async row => await this.readRow(kind, row))),
      ...(rows.length > limit && visible.at(-1)
        ? { next_cursor: this.encodeCursor(visible.at(-1)!) }
        : {}),
    }
  }

  async search(projectId: string, query: string, limit = 50): Promise<Array<{ id: string; source_id: string | null; kind: VideoFactKind; text: string }>> {
    const normalized = query.trim()
    if (!normalized) return []
    const terms = [...normalized].filter(character => /[\u3400-\u9fff]/u.test(character))
    const searchable = terms.length ? terms : normalized.match(/[\p{L}\p{N}_]+/gu) ?? []
    if (!searchable.length) return []
    const match = searchable.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    return this.unitOfWork.database.query(`SELECT fact_id AS id,source_id,fact_kind AS kind,text
      FROM video_fact_search WHERE project_id=? AND video_fact_search MATCH ? LIMIT ?`).all(
      projectId,
      match,
      Math.max(1, Math.min(100, limit)),
    ) as Array<{ id: string; source_id: string | null; kind: VideoFactKind; text: string }>
  }

  async activeTranscriptRevision(transcriptId: string): Promise<VideoFact | null> {
    const row = this.unitOfWork.database.query('SELECT revision_id FROM video_fact_transcript_heads WHERE transcript_id=?').get(transcriptId) as { revision_id: string } | null
    return row ? await this.get('transcript_revision', row.revision_id) : null
  }

  async selectTranscriptRevision(projectId: string, transcriptId: string, revisionId: string): Promise<VideoFact> {
    return await this.fences.run(`project-${projectId}`, async () => {
      const revision = await this.get('transcript_revision', revisionId)
      if (!('transcript_id' in revision) || revision.project_id !== projectId || revision.transcript_id !== transcriptId) {
        throw new VideoFactsRepositoryError('转录修订不属于当前项目或原始转录', 'VIDEO_FACTS_INVALID')
      }
      this.unitOfWork.database.query(`INSERT INTO video_fact_transcript_heads(transcript_id,revision_id,updated_at)
        VALUES(?,?,?) ON CONFLICT(transcript_id) DO UPDATE SET revision_id=excluded.revision_id,updated_at=excluded.updated_at`)
        .run(transcriptId, revisionId, this.now().toISOString())
      return revision
    })
  }

  /** Removes only managed derivative cache bytes, oldest access first. */
  async reclaimLeastRecentlyUsedDerivatives(projectId: string, maxEvictions: number): Promise<string[]> {
    const allowed = Math.max(0, Math.min(10_000, maxEvictions))
    if (!allowed) return []
    const rows = this.unitOfWork.database.query(`SELECT * FROM video_fact_derivatives
      WHERE project_id=? AND state IN ('ready','stale') ORDER BY last_accessed_at,id LIMIT ?`).all(projectId, allowed) as FactRow[]
    const evicted: string[] = []
    for (const row of rows) {
      const value = await this.readRow('derivative', row)
      if (!('asset' in value) || value.asset.storage.kind !== 'managed') continue
      try {
        await rm(this.payloads.pathFor(join('assets', value.asset.storage.locator)), { force: true })
      } catch {
        continue
      }
      await this.save({ ...value, state: 'missing' })
      evicted.push(value.id)
    }
    return evicted
  }

  async commitIntent(intentId: string): Promise<void> {
    const row = this.unitOfWork.database.query('SELECT * FROM video_fact_payloads WHERE intent_id=?').get(intentId) as FactPayloadRow | null
    if (!row) throw new VideoFactsRepositoryError('视频事实提交记录缺失', 'VIDEO_FACTS_CORRUPT')
    const value = await this.readPayload(row.fact_kind, row.payload_locator, row.payload_hash)
    const table = TABLE_BY_KIND[row.fact_kind]
    this.unitOfWork.transaction(() => {
      const previous = this.unitOfWork.database.query(`SELECT payload_locator FROM ${table} WHERE id=?`).get(row.fact_id) as { payload_locator: string } | null
      const fields = sourceFields(value)
      this.unitOfWork.database.query(`INSERT INTO ${table}(
        id,project_id,source_id,source_fingerprint,state,updated_at,last_accessed_at,payload_hash,payload_locator,payload_schema,payload_version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        project_id=excluded.project_id,source_id=excluded.source_id,source_fingerprint=excluded.source_fingerprint,
        state=excluded.state,updated_at=excluded.updated_at,payload_hash=excluded.payload_hash,payload_locator=excluded.payload_locator,
        payload_schema=excluded.payload_schema,payload_version=excluded.payload_version`).run(
        row.fact_id, row.project_id, fields.sourceId, fields.sourceFingerprint, fields.state, factUpdatedAt(value), this.now().toISOString(),
        row.payload_hash, row.payload_locator, row.payload_schema, row.payload_version,
      )
      if (previous && previous.payload_locator !== row.payload_locator) {
        this.unitOfWork.database.query('UPDATE media_payload_blobs SET ref_count=MAX(ref_count-1,0) WHERE locator=?')
          .run(previous.payload_locator)
      }
      if (row.fact_kind === 'transcript_revision' && 'transcript_id' in value) {
        this.unitOfWork.database.query(`INSERT INTO video_fact_transcript_heads(transcript_id,revision_id,updated_at)
          VALUES(?,?,?) ON CONFLICT(transcript_id) DO UPDATE SET revision_id=excluded.revision_id,updated_at=excluded.updated_at`)
          .run(value.transcript_id, value.id, factUpdatedAt(value))
      }
      this.unitOfWork.database.query("UPDATE video_fact_payloads SET state='committed' WHERE intent_id=?").run(intentId)
      this.payloads.markCommitted(intentId)
      this.unitOfWork.database.query('DELETE FROM video_fact_search WHERE fact_id=? AND fact_kind=?').run(row.fact_id, row.fact_kind)
      const text = factSearchText(value)
      if (text) {
        const fields = sourceFields(value)
        this.unitOfWork.database.query('INSERT INTO video_fact_search(fact_id,project_id,source_id,fact_kind,text) VALUES(?,?,?,?,?)')
          .run(row.fact_id, row.project_id, fields.sourceId, row.fact_kind, text)
      }
    })
  }

  abandonIntent(intent: PayloadCommitIntent): void {
    if (!this.owns(intent)) return
    this.unitOfWork.database.query("UPDATE video_fact_payloads SET state='abandoned' WHERE intent_id=? AND state='prepared'")
      .run(intent.id)
  }

  private async saveLocked(kind: VideoFactKind, value: VideoFact): Promise<VideoFact> {
    if (kind === 'transcript') {
      const existing = this.unitOfWork.database.query('SELECT * FROM video_fact_transcripts WHERE id=?').get(value.id) as FactRow | null
      if (existing) {
        const original = await this.readRow('transcript', existing)
        if (JSON.stringify(original) !== JSON.stringify(value)) {
          throw new VideoFactsRepositoryError('原始转录不可覆盖；请创建新的转录或转录修订', 'VIDEO_FACTS_INVALID')
        }
        return original
      }
    }
    if (kind === 'transcript_revision') {
      const revision = value as TranscriptRevision
      const originalRow = this.unitOfWork.database.query('SELECT * FROM video_fact_transcripts WHERE id=?').get(revision.transcript_id) as FactRow | null
      if (!originalRow) throw new VideoFactsRepositoryError('转录修订缺少对应的原始转录', 'VIDEO_FACTS_INVALID')
      const original = await this.readRow('transcript', originalRow) as TimedTranscript
      if (revision.base_transcript_fingerprint !== transcriptRevisionFingerprint(original)) {
        throw new VideoFactsRepositoryError('转录修订不匹配不可变原始转录', 'VIDEO_FACTS_INVALID')
      }
      if (revision.parent_revision_id) {
        const parentRow = this.unitOfWork.database.query('SELECT * FROM video_fact_transcript_revisions WHERE id=?').get(revision.parent_revision_id) as FactRow | null
        if (!parentRow) throw new VideoFactsRepositoryError('转录修订父版本不存在', 'VIDEO_FACTS_INVALID')
        const parent = await this.readRow('transcript_revision', parentRow) as TranscriptRevision
        if (parent.transcript_id !== revision.transcript_id) {
          throw new VideoFactsRepositoryError('转录修订父版本不属于同一原始转录', 'VIDEO_FACTS_INVALID')
        }
      }
    }
    const fields = sourceFields(value)
    const schema = `video-media-fact-${kind}-v1`
    const intent = await this.payloads.stage({
      entityKind: `video_fact_${kind}`,
      aggregateId: value.id,
      projectId: value.project_id,
      finalLocator: join('projects', value.project_id, 'payloads', 'facts', kind, `${value.id}-${randomUUID().replaceAll('-', '')}.json`),
      schema,
      version: 1,
      value,
    })
    const prepared = this.payloads.prepare(intent.id, preparedIntent => {
      this.unitOfWork.database.query(`INSERT INTO video_fact_payloads(
        intent_id,fact_kind,fact_id,project_id,source_id,source_fingerprint,payload_hash,payload_locator,payload_schema,payload_version,state
      ) VALUES(?,?,?,?,?,?,?,?,?,?, 'prepared')`).run(
        preparedIntent.id, kind, value.id, value.project_id, fields.sourceId, fields.sourceFingerprint,
        preparedIntent.expected_hash, preparedIntent.final_locator, preparedIntent.payload_schema, preparedIntent.payload_version,
      )
      this.recordPayloadReference(preparedIntent)
    })
    try {
      await this.payloads.publish(prepared)
      await this.commitIntent(prepared.id)
      return value
    } catch (error) {
      this.unitOfWork.transaction(() => {
        this.abandonIntent(prepared)
        this.unitOfWork.database.query('UPDATE media_payload_blobs SET ref_count=MAX(ref_count-1,0) WHERE locator=?')
          .run(prepared.final_locator)
        this.payloads.markAbandoned(prepared.id)
      })
      throw error
    }
  }

  private recordPayloadReference(intent: PayloadCommitIntent): void {
    this.unitOfWork.database.query(`INSERT INTO media_payload_blobs(
      locator,content_hash,byte_size,schema_name,schema_version,ref_count,created_at
    ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(locator) DO UPDATE SET ref_count=media_payload_blobs.ref_count+1`).run(
      intent.final_locator,
      intent.expected_hash,
      intent.expected_bytes,
      intent.payload_schema,
      intent.payload_version,
      1,
      this.now().toISOString(),
    )
  }

  private async readRow(kind: VideoFactKind, row: FactRow): Promise<VideoFact> {
    return await this.readPayload(kind, row.payload_locator, row.payload_hash)
  }

  private async readPayload(kind: VideoFactKind, locator: string, hash: `sha256:${string}`): Promise<VideoFact> {
    try {
      const path = this.payloads.pathFor(locator)
      await this.integrity.assert(path, hash)
      return factSchema(kind).parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (error instanceof VideoFactsRepositoryError) throw error
      throw new VideoFactsRepositoryError('视频事实 payload 损坏', 'VIDEO_FACTS_CORRUPT')
    }
  }

  private encodeCursor(row: Pick<FactRow, 'updated_at' | 'id'>): string {
    return Buffer.from(JSON.stringify({ updated_at: row.updated_at, id: row.id }), 'utf8').toString('base64url')
  }

  private decodeCursor(cursor: string): { updated_at: string; id: string } {
    try {
      const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
      const value = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>
      if (typeof value.updated_at !== 'string' || typeof value.id !== 'string') throw new Error('invalid')
      return { updated_at: value.updated_at, id: value.id }
    } catch {
      throw new VideoFactsRepositoryError('视频事实分页游标无效', 'VIDEO_FACTS_INVALID')
    }
  }
}
