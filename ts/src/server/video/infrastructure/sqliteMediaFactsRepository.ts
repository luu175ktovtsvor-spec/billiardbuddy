import { createHash, randomUUID } from 'node:crypto'
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
  factDisplaySearchText,
  factSourceRange,
  normalizeFactSearchText,
  type VideoFact,
  type VideoFactKind,
  type VideoDerivative,
  type VideoFactEvidence,
  type VideoFactSource,
  type TimedTranscript,
  type TranscriptRevision,
} from '../domain/mediaFacts/model.js'
import { materializeTranscriptRevision, transcriptRevisionFingerprint } from '../domain/mediaFacts/transcript.js'
import { compareRationalTime, endOfRange, sourceTimeRange, type SourceTimeRange } from '../domain/mediaFacts/time.js'

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

export type VideoFactSearchResult = {
  id: string
  source_id: string
  kind: VideoFactKind
  segment_id?: string
  segment_ids: string[]
  range: SourceTimeRange
  text: string
}

export type VideoFactSearchPage = {
  generation: number
  items: VideoFactSearchResult[]
  next_cursor?: string
}

export type VideoFactEmbedding = { entry_id: string; vector: number[]; model_snapshot: string; instruction_version: string; content_hash: `sha256:${string}` }
/** A Relay result may be deleted only after the already-persisted document
 * vectors have been acknowledged. This is a SQLite outbox record, not a
 * provider cache or an in-memory retry. */
export type VideoFactEmbeddingRelayAcknowledgement = {
  local_operation_id: string
  relay_operation_id: string
  receipt_id: string
  result_hashes: `sha256:${string}`[]
  created_at: string
}

type SearchRow = {
  rowid: number
  entry_id: string
  source_id: string | null
  fact_kind: VideoFactKind
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
const PAGE_SCAN_BATCH = 200
const PAGE_SCAN_MAX_ROWS = 2_000
const SEARCH_SCAN_BATCH = 100
const SEARCH_SCAN_MAX_ROWS = 1_000

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
    const cursor = options.cursor ? this.decodeCursor(options.cursor, { kind, projectId, sourceId: options.sourceId }) : undefined
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
        ? { next_cursor: this.encodeCursor(visible.at(-1)!, { kind, projectId, sourceId: options.sourceId }) }
        : {}),
    }
  }

  /** Public projections hide facts whose source fingerprint has changed or failed. */
  async pageCurrent(kind: VideoFactKind, projectId: string, options: { sourceId?: string; cursor?: string; limit?: number } = {}): Promise<VideoFactsPage> {
    const table = TABLE_BY_KIND[kind]
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    let cursor = options.cursor ? this.decodeCursor(options.cursor, { kind, projectId, sourceId: options.sourceId }) : undefined
    const accepted: Array<{ row: FactRow; value: VideoFact }> = []
    let scanned = 0
    let exhausted = false
    for (; scanned < PAGE_SCAN_MAX_ROWS;) {
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
      values.push(Math.min(PAGE_SCAN_BATCH, PAGE_SCAN_MAX_ROWS - scanned))
      const rows = this.unitOfWork.database.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY updated_at DESC,id LIMIT ?`)
        .all(...values) as FactRow[]
      if (!rows.length) {
        exhausted = true
        break
      }
      scanned += rows.length
      for (const row of rows) {
        cursor = { updated_at: row.updated_at, id: row.id }
        const value = await this.readRow(kind, row)
        if (await this.isCurrentFactProjection(kind, value)) accepted.push({ row, value })
        if (accepted.length > limit) break
      }
      if (accepted.length > limit || rows.length < PAGE_SCAN_BATCH) {
        exhausted = rows.length < PAGE_SCAN_BATCH
        break
      }
    }
    const visible = accepted.slice(0, limit)
    return {
      items: visible.map(item => item.value),
      ...(accepted.length > limit && visible.at(-1)
        ? { next_cursor: this.encodeCursor(visible.at(-1)!.row, { kind, projectId, sourceId: options.sourceId }) }
        : !exhausted && cursor ? { next_cursor: this.encodeCursor(cursor, { kind, projectId, sourceId: options.sourceId }) } : {}),
    }
  }

  async search(projectId: string, query: string, limit = 50): Promise<VideoFactSearchResult[]> {
    return (await this.searchPage(projectId, query, { limit })).items
  }

  /** Current search projections are the semantic corpus.  This intentionally
   * does not depend on a lexical query: otherwise semantic-only matches can
   * never be indexed or returned. */
  async listCurrentSearchCandidates(projectId: string, limit = 10_000): Promise<VideoFactSearchResult[]> {
    await this.ensureSearchGeneration(projectId)
    const rows = this.unitOfWork.database.query(`SELECT rowid,fact_id AS entry_id,source_id,fact_kind
      FROM video_fact_search WHERE project_id=? ORDER BY rowid LIMIT ?`).all(projectId, Math.max(1, Math.min(10_000, limit))) as SearchRow[]
    const results: VideoFactSearchResult[] = []
    for (const row of rows) {
      const item = await this.materializeSearchResult(row)
      if (item) results.push(item)
    }
    return results
  }

  async missingSearchEmbeddingEntries(projectId: string, entryIds: string[]): Promise<Set<string>> {
    const generation = await this.ensureSearchGeneration(projectId)
    const missing = new Set<string>()
    for (let offset = 0; offset < entryIds.length; offset += 500) {
      const batch = entryIds.slice(offset, offset + 500)
      if (!batch.length) continue
      const rows = this.unitOfWork.database.query(`SELECT entry_id FROM video_fact_embeddings
        WHERE project_id=? AND generation=? AND entry_id IN (${batch.map(() => '?').join(',')})`).all(projectId, generation, ...batch) as Array<{ entry_id: string }>
      const present = new Set(rows.map(row => row.entry_id))
      for (const entryId of batch) if (!present.has(entryId)) missing.add(entryId)
    }
    return missing
  }

  async searchPage(projectId: string, query: string, options: { cursor?: string; limit?: number } = {}): Promise<VideoFactSearchPage> {
    const normalized = query.trim()
    const generation = await this.ensureSearchGeneration(projectId)
    const queryHash = this.searchQueryHash(normalized)
    const cursor = options.cursor ? this.decodeSearchCursor(options.cursor, { projectId, queryHash }) : undefined
    if (cursor && cursor.generation !== generation) {
      throw new VideoFactsRepositoryError('搜索索引已更新，请从第一页重新查询', 'VIDEO_FACTS_INVALID')
    }
    if (!normalized) return { generation, items: [] }
    const terms = [...normalized].filter(character => /[\u3400-\u9fff]/u.test(character))
    const searchable = terms.length ? terms : normalized.match(/[\p{L}\p{N}_]+/gu) ?? []
    if (!searchable.length) return { generation, items: [] }
    const match = searchable.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')
    const limit = Math.max(1, Math.min(100, options.limit ?? 50))
    const accepted: Array<{ rowid: number; result: VideoFactSearchResult }> = []
    let after = cursor?.rowid ?? 0
    let scanned = 0
    let exhausted = false
    for (; scanned < SEARCH_SCAN_MAX_ROWS;) {
      const rows = this.unitOfWork.database.query(`SELECT rowid,fact_id AS entry_id,source_id,fact_kind
        FROM video_fact_search WHERE project_id=? AND video_fact_search MATCH ? AND rowid>? ORDER BY rowid LIMIT ?`).all(
        projectId,
        match,
        after,
        Math.min(SEARCH_SCAN_BATCH, SEARCH_SCAN_MAX_ROWS - scanned),
      ) as SearchRow[]
      if (!rows.length) {
        exhausted = true
        break
      }
      scanned += rows.length
      for (const row of rows) {
        after = row.rowid
        const result = await this.materializeSearchResult(row)
        if (result) accepted.push({ rowid: row.rowid, result })
        if (accepted.length > limit) break
      }
      if (accepted.length > limit || rows.length < SEARCH_SCAN_BATCH) {
        exhausted = rows.length < SEARCH_SCAN_BATCH
        break
      }
    }
    const visible = accepted.slice(0, limit)
    return {
      generation,
      items: visible.map(item => item.result),
      ...(accepted.length > limit && visible.at(-1)
        ? { next_cursor: this.encodeSearchCursor({ generation, rowid: visible.at(-1)!.rowid }, { projectId, queryHash }) }
        : !exhausted && after > (cursor?.rowid ?? 0)
          ? { next_cursor: this.encodeSearchCursor({ generation, rowid: after }, { projectId, queryHash }) }
          : {}),
    }
  }

  /** Stores only text-derived vectors. Raw image/audio bytes never enter this index. */
  async saveEmbeddings(projectId: string, entries: VideoFactEmbedding[]): Promise<number> {
    return await this.saveEmbeddingsWithRelayAcknowledgement(projectId, entries)
  }

  /** Atomically makes document vectors visible and records the corresponding
   * Relay ACK obligation. A crash after commit can retry only the ACK; it
   * cannot trigger a second embedding request for already-present entries. */
  async saveEmbeddingsWithRelayAcknowledgement(
    projectId: string,
    entries: VideoFactEmbedding[],
    acknowledgement?: VideoFactEmbeddingRelayAcknowledgement,
  ): Promise<number> {
    if (!entries.length) {
      if (acknowledgement) throw new VideoFactsRepositoryError('Embedding ACK 缺少向量', 'VIDEO_FACTS_INVALID')
      return await this.ensureSearchGeneration(projectId)
    }
    const model = entries[0]!.model_snapshot
    const instruction = entries[0]!.instruction_version
    if (!entries.every(entry => entry.model_snapshot === model && entry.instruction_version === instruction && entry.vector.length === 768 && entry.vector.every(value => Number.isFinite(value)))) {
      throw new VideoFactsRepositoryError('Embedding 索引输入无效', 'VIDEO_FACTS_INVALID')
    }
    if (acknowledgement) this.assertEmbeddingAcknowledgement(acknowledgement)
    await this.ensureSearchGeneration(projectId)
    return await this.fences.run(`project-${projectId}`, async () => this.unitOfWork.transaction(() => {
      const latest = this.unitOfWork.database.query(`SELECT model_snapshot,instruction_version FROM video_fact_embeddings WHERE project_id=? ORDER BY generation DESC LIMIT 1`).get(projectId) as { model_snapshot: string; instruction_version: string } | null
      if (latest && (latest.model_snapshot !== model || latest.instruction_version !== instruction)) this.bumpSearchGeneration(projectId)
      const generation = this.searchGeneration(projectId) ?? 1
      const createdAt = this.now().toISOString()
      for (const entry of entries) {
        const actual = `sha256:${createHash('sha256').update(JSON.stringify(entry.vector)).digest('hex')}`
        if (actual !== entry.content_hash) throw new VideoFactsRepositoryError('Embedding 内容哈希不匹配', 'VIDEO_FACTS_INVALID')
        this.unitOfWork.database.query(`INSERT INTO video_fact_embeddings(project_id,entry_id,generation,model_snapshot,dimension,instruction_version,vector_json,content_hash,created_at)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,entry_id,generation) DO UPDATE SET vector_json=excluded.vector_json,content_hash=excluded.content_hash,created_at=excluded.created_at`)
          .run(projectId, entry.entry_id, generation, model, 768, instruction, JSON.stringify(entry.vector), entry.content_hash, createdAt)
      }
      if (acknowledgement) {
        const existing = this.unitOfWork.database.query(`SELECT project_id,local_operation_id,receipt_id,result_hashes_json
          FROM video_fact_embedding_relay_acknowledgements WHERE relay_operation_id=?`)
          .get(acknowledgement.relay_operation_id) as { project_id: string; local_operation_id: string; receipt_id: string; result_hashes_json: string } | null
        const hashes = JSON.stringify(acknowledgement.result_hashes)
        if (existing && (
          existing.project_id !== projectId
          || existing.local_operation_id !== acknowledgement.local_operation_id
          || existing.receipt_id !== acknowledgement.receipt_id
          || existing.result_hashes_json !== hashes
        )) throw new VideoFactsRepositoryError('Embedding ACK 回执不一致', 'VIDEO_FACTS_INVALID')
        if (!existing) {
          this.unitOfWork.database.query(`INSERT INTO video_fact_embedding_relay_acknowledgements(
            relay_operation_id,project_id,local_operation_id,receipt_id,result_hashes_json,state,created_at,updated_at
          ) VALUES(?,?,?,?,?,'pending',?,?)`).run(
            acknowledgement.relay_operation_id,
            projectId,
            acknowledgement.local_operation_id,
            acknowledgement.receipt_id,
            hashes,
            acknowledgement.created_at,
            createdAt,
          )
        }
      }
      return generation
    }))
  }

  async listPendingEmbeddingRelayAcknowledgements(projectId: string): Promise<VideoFactEmbeddingRelayAcknowledgement[]> {
    const rows = this.unitOfWork.database.query(`SELECT local_operation_id,relay_operation_id,receipt_id,result_hashes_json,created_at
      FROM video_fact_embedding_relay_acknowledgements
      WHERE project_id=? AND state='pending' ORDER BY created_at,relay_operation_id`).all(projectId) as Array<{
        local_operation_id: string; relay_operation_id: string; receipt_id: string; result_hashes_json: string; created_at: string
      }>
    return rows.map(row => {
      let hashes: unknown
      try { hashes = JSON.parse(row.result_hashes_json) } catch { throw new VideoFactsRepositoryError('Embedding ACK 记录损坏', 'VIDEO_FACTS_INVALID') }
      const acknowledgement = { ...row, result_hashes: hashes }
      this.assertEmbeddingAcknowledgement(acknowledgement)
      return acknowledgement
    })
  }

  async hasEmbeddingRelayAcknowledgement(projectId: string, acknowledgement: Pick<VideoFactEmbeddingRelayAcknowledgement, 'relay_operation_id' | 'receipt_id' | 'result_hashes'>): Promise<boolean> {
    const row = this.unitOfWork.database.query(`SELECT receipt_id,result_hashes_json FROM video_fact_embedding_relay_acknowledgements
      WHERE project_id=? AND relay_operation_id=? AND state IN ('pending','acknowledged','retired')`)
      .get(projectId, acknowledgement.relay_operation_id) as { receipt_id: string; result_hashes_json: string } | null
    return Boolean(row && row.receipt_id === acknowledgement.receipt_id && row.result_hashes_json === JSON.stringify(acknowledgement.result_hashes))
  }

  async resolveEmbeddingRelayAcknowledgement(projectId: string, relayOperationId: string, state: 'acknowledged' | 'retired'): Promise<void> {
    await this.fences.run(`project-${projectId}`, async () => this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query(`UPDATE video_fact_embedding_relay_acknowledgements
        SET state=?,updated_at=? WHERE project_id=? AND relay_operation_id=? AND state='pending'`)
        .run(state, this.now().toISOString(), projectId, relayOperationId)
    }))
  }

  private assertEmbeddingAcknowledgement(value: unknown): asserts value is VideoFactEmbeddingRelayAcknowledgement {
    const acknowledgement = value as Partial<VideoFactEmbeddingRelayAcknowledgement>
    if (
      !acknowledgement
      || typeof acknowledgement.local_operation_id !== 'string' || !acknowledgement.local_operation_id
      || typeof acknowledgement.relay_operation_id !== 'string' || !acknowledgement.relay_operation_id
      || typeof acknowledgement.receipt_id !== 'string' || !acknowledgement.receipt_id
      || typeof acknowledgement.created_at !== 'string' || Number.isNaN(Date.parse(acknowledgement.created_at))
      || !Array.isArray(acknowledgement.result_hashes) || !acknowledgement.result_hashes.length
      || !acknowledgement.result_hashes.every(hash => typeof hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(hash))
    ) throw new VideoFactsRepositoryError('Embedding ACK 记录无效', 'VIDEO_FACTS_INVALID')
  }

  /**
   * Hybrid recall is the union of FTS matches and all current embedding
   * candidates.  Reciprocal-rank fusion deliberately keeps the lexical and
   * semantic signals independent; semantic retrieval is no longer restricted
   * to whatever happened to fit in the current FTS page.
   */
  async hybridSearchPage(projectId: string, query: string, queryVector: number[], options: { cursor?: string; limit?: number } = {}): Promise<VideoFactSearchPage> {
    if (queryVector.length !== 768 || queryVector.some(value => !Number.isFinite(value))) throw new VideoFactsRepositoryError('Embedding 查询向量无效', 'VIDEO_FACTS_INVALID')
    const generation = await this.ensureSearchGeneration(projectId)
    const vectorHash = `sha256:${createHash('sha256').update(JSON.stringify(queryVector)).digest('hex')}`
    const cursor = options.cursor ? this.decodeHybridSearchCursor(options.cursor) : undefined
    if (cursor && (cursor.project_id !== projectId || cursor.generation !== generation || cursor.query_hash !== this.searchQueryHash(query) || cursor.vector_hash !== vectorHash)) {
      throw new VideoFactsRepositoryError('搜索索引或查询已更新，请从第一页重新查询', 'VIDEO_FACTS_INVALID')
    }
    const lexical = await this.searchPage(projectId, query, { limit: 100 })
    // The persisted fact contract caps one project at 10,000 searchable
    // entries. Recall that complete bounded set instead of a hidden 2,000-row
    // prefix, otherwise a semantic-only result can silently disappear.
    const rows = this.unitOfWork.database.query(`SELECT entry_id,vector_json FROM video_fact_embeddings WHERE project_id=? AND generation=? ORDER BY entry_id LIMIT 10000`).all(projectId, generation) as Array<{ entry_id: string; vector_json: string }>
    const entryId = (item: VideoFactSearchResult) => item.kind === 'transcript' ? this.transcriptSearchEntryId(item.id, item.segment_ids.join(',')) : item.id
    const cosine = (left: number[], right: number[]) => { let dot = 0; let a = 0; let b = 0; for (let index = 0; index < 768; index += 1) { dot += left[index]! * right[index]!; a += left[index]! ** 2; b += right[index]! ** 2 } return a && b ? dot / Math.sqrt(a * b) : -1 }
    const candidates = new Map<string, { item: VideoFactSearchResult; lexicalRank?: number; semanticRank?: number }>()
    for (const [index, item] of lexical.items.entries()) candidates.set(entryId(item), { item, lexicalRank: index + 1 })
    const semantic = rows.flatMap(row => {
      try {
        const vector = JSON.parse(row.vector_json) as unknown
        return Array.isArray(vector) && vector.length === 768 && vector.every(value => typeof value === 'number' && Number.isFinite(value))
          ? [{ entryId: row.entry_id, score: cosine(queryVector, vector as number[]) }]
          : []
      } catch { return [] }
    }).sort((left, right) => right.score - left.score || left.entryId.localeCompare(right.entryId))
    for (const [index, candidate] of semantic.entries()) {
      const existing = candidates.get(candidate.entryId)
      if (existing) { existing.semanticRank = index + 1; continue }
      const row = this.unitOfWork.database.query(`SELECT rowid,fact_id AS entry_id,source_id,fact_kind
        FROM video_fact_search WHERE project_id=? AND fact_id=? ORDER BY rowid LIMIT 1`).get(projectId, candidate.entryId) as SearchRow | null
      const item = row ? await this.materializeSearchResult(row) : null
      if (item) candidates.set(candidate.entryId, { item, semanticRank: index + 1 })
    }
    const ordered = [...candidates.entries()].map(([key, candidate]) => ({
      key,
      item: candidate.item,
      score: (candidate.lexicalRank ? 1 / (60 + candidate.lexicalRank) : 0) + (candidate.semanticRank ? 1 / (60 + candidate.semanticRank) : 0),
    })).sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    const limit = Math.max(1, Math.min(100, options.limit ?? 50)); const offset = cursor?.offset ?? 0
    const items = ordered.slice(offset, offset + limit).map(candidate => candidate.item)
    return {
      generation,
      items,
      ...(offset + items.length < ordered.length ? { next_cursor: this.encodeHybridSearchCursor({ project_id: projectId, generation, offset: offset + items.length, query_hash: this.searchQueryHash(query), vector_hash: vectorHash }) } : {}),
    }
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
      const transcript = await this.get('transcript', transcriptId) as TimedTranscript
      if (transcript.project_id !== projectId) {
        throw new VideoFactsRepositoryError('原始转录不属于当前项目', 'VIDEO_FACTS_INVALID')
      }
      await this.ensureSearchGeneration(projectId)
      const projection = materializeTranscriptRevision(transcript, revision as TranscriptRevision)
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query(`INSERT INTO video_fact_transcript_heads(transcript_id,revision_id,updated_at)
          VALUES(?,?,?) ON CONFLICT(transcript_id) DO UPDATE SET revision_id=excluded.revision_id,updated_at=excluded.updated_at`)
          .run(transcriptId, revisionId, this.now().toISOString())
        this.replaceTranscriptSearch(transcript, projection)
        this.bumpSearchGeneration(projectId)
      })
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
    const transcriptSearch = await this.transcriptSearchProjection(row.fact_kind, value)
    await this.ensureSearchGeneration(row.project_id)
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
      if (transcriptSearch) {
        this.replaceTranscriptSearch(transcriptSearch.transcript, transcriptSearch.projection)
      } else {
        const text = factSearchText(value)
        if (text) {
          const fields = sourceFields(value)
          this.unitOfWork.database.query('INSERT INTO video_fact_search(fact_id,project_id,source_id,fact_kind,text) VALUES(?,?,?,?,?)')
            .run(row.fact_id, row.project_id, fields.sourceId, row.fact_kind, text)
        }
      }
      this.bumpSearchGeneration(row.project_id)
    })
  }

  abandonIntent(intent: PayloadCommitIntent): void {
    if (!this.owns(intent)) return
    this.unitOfWork.database.query("UPDATE video_fact_payloads SET state='abandoned' WHERE intent_id=? AND state='prepared'")
      .run(intent.id)
  }

  private async saveLocked(kind: VideoFactKind, value: VideoFact): Promise<VideoFact> {
    let cacheInvalidation = false
    if (kind === 'derivative') {
      const existing = this.unitOfWork.database.query('SELECT * FROM video_fact_derivatives WHERE id=?').get(value.id) as FactRow | null
      if (existing) {
        const stored = await this.readRow('derivative', existing) as VideoDerivative
        if (JSON.stringify(stored) === JSON.stringify(value)) return stored
        cacheInvalidation = this.isDerivativeCacheInvalidation(stored, value as VideoDerivative)
      }
    }
    // A derivative can be marked missing while reclaiming its already-managed
    // bytes after the source has changed. This is a cache invalidation, not a
    // new source-derived Fact; every other write must bind to a current source.
    if (!cacheInvalidation) await this.assertFactSourceIntegrity(kind, value)
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
      const existing = this.unitOfWork.database.query('SELECT * FROM video_fact_transcript_revisions WHERE id=?').get(revision.id) as FactRow | null
      if (existing) {
        const stored = await this.readRow('transcript_revision', existing) as TranscriptRevision
        if (JSON.stringify(stored) !== JSON.stringify(revision)) {
          throw new VideoFactsRepositoryError('转录修订不可覆盖；请创建新的修订版本', 'VIDEO_FACTS_INVALID')
        }
        return stored
      }
      const originalRow = this.unitOfWork.database.query('SELECT * FROM video_fact_transcripts WHERE id=?').get(revision.transcript_id) as FactRow | null
      if (!originalRow) throw new VideoFactsRepositoryError('转录修订缺少对应的原始转录', 'VIDEO_FACTS_INVALID')
      const original = await this.readRow('transcript', originalRow) as TimedTranscript
      if (original.project_id !== revision.project_id) {
        throw new VideoFactsRepositoryError('转录修订不能跨项目引用原始转录', 'VIDEO_FACTS_INVALID')
      }
      if (revision.base_transcript_fingerprint !== transcriptRevisionFingerprint(original)) {
        throw new VideoFactsRepositoryError('转录修订不匹配不可变原始转录', 'VIDEO_FACTS_INVALID')
      }
      if (revision.parent_revision_id) {
        const parentRow = this.unitOfWork.database.query('SELECT * FROM video_fact_transcript_revisions WHERE id=?').get(revision.parent_revision_id) as FactRow | null
        if (!parentRow) throw new VideoFactsRepositoryError('转录修订父版本不存在', 'VIDEO_FACTS_INVALID')
        const parent = await this.readRow('transcript_revision', parentRow) as TranscriptRevision
        if (parent.project_id !== revision.project_id || parent.transcript_id !== revision.transcript_id) {
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

  /**
   * Facts are immutable, but their source binding is not merely descriptive:
   * it is the boundary that prevents a stale, cross-project, or display-only
   * range from becoming editorial evidence.  Validate it before staging a
   * payload so no corrupted child Fact can be made durable and later hidden by
   * a best-effort projection.
   */
  private async assertFactSourceIntegrity(kind: VideoFactKind, value: VideoFact): Promise<void> {
    if (kind === 'source' || kind === 'transcript_revision') return
    if (!('source_id' in value) || !('source_fingerprint' in value)) {
      throw new VideoFactsRepositoryError('视频事实缺少来源绑定', 'VIDEO_FACTS_INVALID')
    }
    const row = this.unitOfWork.database.query('SELECT * FROM video_fact_sources WHERE id=?').get(value.source_id) as FactRow | null
    if (!row) throw new VideoFactsRepositoryError('视频事实引用的来源不存在', 'VIDEO_FACTS_INVALID')
    const source = await this.readRow('source', row) as VideoFactSource
    if (source.project_id !== value.project_id
      || source.id !== value.source_id
      || source.state !== 'ready'
      || source.fingerprint_state !== 'ready'
      || !source.fingerprint
      || source.fingerprint !== value.source_fingerprint
    ) throw new VideoFactsRepositoryError('视频事实来源已变化、不可用或不属于当前项目', 'VIDEO_FACTS_INVALID')

    const primaryDuration = source.primary_video_stream.duration
    if (!primaryDuration) throw new VideoFactsRepositoryError('原始主视频流时长缺失，不能验证事实范围', 'VIDEO_FACTS_INVALID')
    const primaryRange = sourceTimeRange(source.primary_video_stream.start_time, primaryDuration)
    const assertRange = (range: SourceTimeRange, label: string) => {
      if (
        compareRationalTime(range.start, primaryRange.start) < 0
        || compareRationalTime(endOfRange(range), endOfRange(primaryRange)) > 0
      ) throw new VideoFactsRepositoryError(`${label}超出原始主视频流 PTS 范围`, 'VIDEO_FACTS_INVALID')
    }
    const assertPoint = (at: { ticks: string; tick_rate: { num: number; den: number } }, label: string) => {
      assertRange(sourceTimeRange(at, { ticks: '0', tick_rate: at.tick_rate }), label)
    }

    if (kind === 'derivative') {
      const derivative = value as Extract<VideoFact, { generator_name: string }>
      if (derivative.source_range) assertRange(derivative.source_range, '派生素材范围')
      return
    }
    if (kind === 'transcript') {
      const transcript = value as TimedTranscript
      assertPoint(transcript.source_offset, '转录来源偏移')
      for (const segment of transcript.segments) {
        if (segment.source_id !== source.id) throw new VideoFactsRepositoryError('转录片段来源与转录不一致', 'VIDEO_FACTS_INVALID')
        assertRange(sourceTimeRange(segment.start, segment.duration), '转录片段范围')
      }
      return
    }
    if (kind === 'evidence_window') {
      const window = value as Extract<VideoFact, { sample_strategy: string }>
      assertRange(window.range, '证据窗口范围')
      for (const uncovered of window.coverage.uncovered) assertRange(uncovered.range, '未覆盖范围')
      return
    }

    const range = factSourceRange(value)
    if (range) assertRange(range, '视频事实范围')
    if (kind !== 'evidence') return
    const evidence = value as VideoFactEvidence
    if (evidence.kind === 'beat_grid') {
      for (const coverage of evidence.payload.coverage) assertRange(coverage, '节拍覆盖范围')
      for (const beat of evidence.payload.beat_times) assertPoint(beat, '节拍时间')
      for (const beat of evidence.payload.beats) assertPoint(beat.at, '节拍时间')
    }
    if (evidence.kind === 'subject_track') {
      for (const point of evidence.payload.points) assertPoint(point.at, '主体轨迹时间')
      for (const unresolved of evidence.payload.unresolved_ranges) assertRange(unresolved.range, '主体未解决范围')
    }
  }

  private isDerivativeCacheInvalidation(stored: VideoDerivative, candidate: VideoDerivative): boolean {
    const { state: storedState, ...storedIdentity } = stored
    const { state: candidateState, ...candidateIdentity } = candidate
    return storedState !== candidateState
      && (candidateState === 'stale' || candidateState === 'missing')
      && JSON.stringify(storedIdentity) === JSON.stringify(candidateIdentity)
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

  private async transcriptSearchProjection(kind: VideoFactKind, value: VideoFact): Promise<{ transcript: TimedTranscript; projection: ReturnType<typeof materializeTranscriptRevision> } | null> {
    if (kind === 'transcript') {
      const transcript = value as TimedTranscript
      return { transcript, projection: materializeTranscriptRevision(transcript) }
    }
    if (kind !== 'transcript_revision') return null
    const revision = value as TranscriptRevision
    const row = this.unitOfWork.database.query('SELECT * FROM video_fact_transcripts WHERE id=?').get(revision.transcript_id) as FactRow | null
    if (!row) throw new VideoFactsRepositoryError('转录修订缺少对应的原始转录', 'VIDEO_FACTS_CORRUPT')
    const transcript = await this.readRow('transcript', row) as TimedTranscript
    if (transcript.project_id !== revision.project_id) {
      throw new VideoFactsRepositoryError('转录修订跨项目引用原始转录', 'VIDEO_FACTS_CORRUPT')
    }
    return {
      transcript,
      projection: materializeTranscriptRevision(transcript, revision),
    }
  }

  private replaceTranscriptSearch(transcript: TimedTranscript, projection: ReturnType<typeof materializeTranscriptRevision>): void {
    this.unitOfWork.database.query("DELETE FROM video_fact_search WHERE fact_kind='transcript' AND (fact_id=? OR fact_id GLOB ?)")
      .run(transcript.id, `${transcript.id}\u001f*`)
    for (const segment of projection.segments) {
      const text = normalizeFactSearchText(segment.text)
      if (!text) continue
      this.unitOfWork.database.query('INSERT INTO video_fact_search(fact_id,project_id,source_id,fact_kind,text) VALUES(?,?,?,?,?)')
        .run(this.transcriptSearchEntryId(transcript.id, segment.anchor_segment_ids.join(',')), transcript.project_id, transcript.source_id, 'transcript', text)
    }
  }

  private transcriptSearchEntryId(transcriptId: string, segmentId: string): string {
    return `${transcriptId}\u001f${segmentId}`
  }

  private splitTranscriptSearchEntryId(entryId: string): { transcriptId: string; segmentId?: string } {
    const separator = entryId.indexOf('\u001f')
    return separator < 0
      ? { transcriptId: entryId }
      : { transcriptId: entryId.slice(0, separator), segmentId: entryId.slice(separator + 1) }
  }

  private searchGeneration(projectId: string): number | null {
    const row = this.unitOfWork.database.query('SELECT generation FROM video_fact_search_generations WHERE project_id=?').get(projectId) as { generation: number } | null
    return row?.generation ?? null
  }

  private bumpSearchGeneration(projectId: string): void {
    this.unitOfWork.database.query(`INSERT INTO video_fact_search_generations(project_id,generation,updated_at)
      VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET generation=video_fact_search_generations.generation+1,updated_at=excluded.updated_at`)
      .run(projectId, 1, this.now().toISOString())
  }

  private async ensureSearchGeneration(projectId: string): Promise<number> {
    const known = this.searchGeneration(projectId)
    if (known !== null) return known
    const values: Array<{ kind: VideoFactKind; value: VideoFact }> = []
    for (const kind of Object.keys(TABLE_BY_KIND) as VideoFactKind[]) {
      if (kind === 'transcript_revision') continue
      const table = TABLE_BY_KIND[kind]
      const rows = this.unitOfWork.database.query(`SELECT * FROM ${table} WHERE project_id=? AND state NOT IN ('prepared','abandoned')`)
        .all(projectId) as FactRow[]
      for (const row of rows) values.push({ kind, value: await this.readRow(kind, row) })
    }
    const transcriptProjections = new Map<string, ReturnType<typeof materializeTranscriptRevision>>()
    for (const item of values) {
      if (item.kind !== 'transcript') continue
      const transcript = item.value as TimedTranscript
      const active = await this.activeTranscriptRevision(transcript.id)
      transcriptProjections.set(transcript.id, materializeTranscriptRevision(transcript, active as TranscriptRevision | null ?? undefined))
    }
    this.unitOfWork.transaction(() => {
      if (this.searchGeneration(projectId) !== null) return
      this.unitOfWork.database.query('DELETE FROM video_fact_search WHERE project_id=?').run(projectId)
      for (const item of values) {
        if (item.kind === 'transcript') {
          this.replaceTranscriptSearch(item.value as TimedTranscript, transcriptProjections.get(item.value.id)!)
          continue
        }
        const text = factSearchText(item.value)
        if (!text) continue
        const fields = sourceFields(item.value)
        this.unitOfWork.database.query('INSERT INTO video_fact_search(fact_id,project_id,source_id,fact_kind,text) VALUES(?,?,?,?,?)')
          .run(item.value.id, projectId, fields.sourceId, item.kind, text)
      }
      this.unitOfWork.database.query('INSERT INTO video_fact_search_generations(project_id,generation,updated_at) VALUES(?,?,?)')
        .run(projectId, 1, this.now().toISOString())
    })
    return this.searchGeneration(projectId) ?? 1
  }

  private async materializeSearchResult(row: SearchRow): Promise<VideoFactSearchResult | null> {
    const entry = row.fact_kind === 'transcript'
      ? this.splitTranscriptSearchEntryId(row.entry_id)
      : { transcriptId: row.entry_id }
    const factId = entry.transcriptId
    const table = TABLE_BY_KIND[row.fact_kind]
    const factRow = this.unitOfWork.database.query(`SELECT * FROM ${table} WHERE id=? AND state NOT IN ('prepared','abandoned')`).get(factId) as FactRow | null
    if (!factRow) return null
    const value = await this.readRow(row.fact_kind, factRow)
    if (row.fact_kind === 'transcript') {
      const transcript = value as TimedTranscript
      const active = await this.activeTranscriptRevision(transcript.id)
      const projection = materializeTranscriptRevision(transcript, active as TranscriptRevision | null ?? undefined)
      const segment = projection.segments.find(item => item.anchor_segment_ids.join(',') === entry.segmentId)
      if (!segment || !await this.isCurrentSourceProjection(transcript.project_id, transcript.source_id, transcript.source_fingerprint)) return null
      return {
        id: transcript.id,
        source_id: transcript.source_id,
        kind: 'transcript',
        ...(segment.anchor_segment_ids.length === 1 ? { segment_id: segment.anchor_segment_ids[0] } : {}),
        segment_ids: segment.anchor_segment_ids,
        range: sourceTimeRange(segment.start, segment.duration),
        text: segment.text,
      }
    }
    const sourceId = 'source_id' in value ? value.source_id : undefined
    const fingerprint = 'source_fingerprint' in value ? value.source_fingerprint : undefined
    const range = factSourceRange(value)
    if (!sourceId || !fingerprint || !range || !await this.isCurrentSourceProjection(value.project_id, sourceId, fingerprint)) return null
    return {
      id: value.id,
      source_id: sourceId,
      kind: row.fact_kind,
      ...('content_segment_id' in value && value.content_segment_id ? { segment_id: value.content_segment_id } : row.fact_kind === 'content_segment' ? { segment_id: value.id } : {}),
      ...('content_segment_id' in value && value.content_segment_id
        ? { segment_ids: [value.content_segment_id] }
        : row.fact_kind === 'content_segment' ? { segment_ids: [value.id] } : { segment_ids: [] }),
      range,
      text: factDisplaySearchText(value),
    }
  }

  private async isCurrentSourceProjection(projectId: string, sourceId: string, fingerprint: string): Promise<boolean> {
    const row = this.unitOfWork.database.query(`SELECT * FROM video_fact_sources
      WHERE id=? AND project_id=? AND state='ready' AND source_fingerprint=?`).get(sourceId, projectId, fingerprint) as FactRow | null
    if (!row) return false
    const source = await this.readRow('source', row) as VideoFact
    return 'fast_identity' in source && source.fingerprint_state === 'ready' && source.fingerprint === fingerprint
  }

  private async isCurrentFactProjection(kind: VideoFactKind, value: VideoFact): Promise<boolean> {
    if (kind === 'source') {
      // The Source itself is the authoritative changed/failed projection; only
      // facts derived from it are hidden from active public projections.
      return true
    }
    if (kind === 'transcript_revision') {
      const revision = value as TranscriptRevision
      const row = this.unitOfWork.database.query('SELECT * FROM video_fact_transcripts WHERE id=?').get(revision.transcript_id) as FactRow | null
      if (!row) return false
      const transcript = await this.readRow('transcript', row) as TimedTranscript
      return transcript.project_id === revision.project_id
        && await this.isCurrentSourceProjection(transcript.project_id, transcript.source_id, transcript.source_fingerprint)
    }
    const sourceId = 'source_id' in value ? value.source_id : undefined
    const fingerprint = 'source_fingerprint' in value ? value.source_fingerprint : undefined
    return Boolean(sourceId && fingerprint && await this.isCurrentSourceProjection(value.project_id, sourceId, fingerprint))
  }

  private encodeSearchCursor(
    value: { generation: number; rowid: number },
    scope: { projectId: string; queryHash: string },
  ): string {
    return Buffer.from(JSON.stringify({
      kind: 'fact-search-v2',
      project_id: scope.projectId,
      query_hash: scope.queryHash,
      ...value,
    }), 'utf8').toString('base64url')
  }

  private decodeSearchCursor(
    cursor: string,
    scope: { projectId: string; queryHash: string },
  ): { generation: number; rowid: number } {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
      const generation = value.generation
      const rowid = value.rowid
      if (
        value.kind !== 'fact-search-v2'
        || value.project_id !== scope.projectId
        || value.query_hash !== scope.queryHash
        || typeof generation !== 'number'
        || typeof rowid !== 'number'
        || !Number.isSafeInteger(generation)
        || !Number.isSafeInteger(rowid)
        || generation < 0
        || rowid < 0
      ) throw new Error('invalid')
      return { generation, rowid }
    } catch {
      throw new VideoFactsRepositoryError('视频事实搜索游标无效', 'VIDEO_FACTS_INVALID')
    }
  }

  private searchQueryHash(query: string): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(query.trim()).digest('hex')}`
  }

  private encodeHybridSearchCursor(value: { project_id: string; generation: number; offset: number; query_hash: string; vector_hash: string }): string {
    return Buffer.from(JSON.stringify({ kind: 'hybrid-v2', ...value }), 'utf8').toString('base64url')
  }

  private decodeHybridSearchCursor(cursor: string): { project_id: string; generation: number; offset: number; query_hash: string; vector_hash: string } {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
      if (value.kind !== 'hybrid-v2' || typeof value.project_id !== 'string' || !value.project_id || typeof value.generation !== 'number' || typeof value.offset !== 'number'
        || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.offset) || value.generation < 0 || value.offset < 0
        || typeof value.query_hash !== 'string' || typeof value.vector_hash !== 'string') throw new Error('invalid')
      return { project_id: value.project_id, generation: value.generation, offset: value.offset, query_hash: value.query_hash, vector_hash: value.vector_hash }
    } catch {
      throw new VideoFactsRepositoryError('视频事实搜索游标无效', 'VIDEO_FACTS_INVALID')
    }
  }

  private encodeCursor(
    row: Pick<FactRow, 'updated_at' | 'id'>,
    scope: { kind: VideoFactKind; projectId: string; sourceId?: string },
  ): string {
    return Buffer.from(JSON.stringify({
      kind: 'fact-page-v2',
      project_id: scope.projectId,
      fact_kind: scope.kind,
      source_id: scope.sourceId ?? null,
      updated_at: row.updated_at,
      id: row.id,
    }), 'utf8').toString('base64url')
  }

  private decodeCursor(
    cursor: string,
    scope: { kind: VideoFactKind; projectId: string; sourceId?: string },
  ): { updated_at: string; id: string } {
    try {
      const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/')
      const value = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as Record<string, unknown>
      if (
        value.kind !== 'fact-page-v2'
        || value.project_id !== scope.projectId
        || value.fact_kind !== scope.kind
        || value.source_id !== (scope.sourceId ?? null)
        || typeof value.updated_at !== 'string'
        || Number.isNaN(Date.parse(value.updated_at))
        || new Date(value.updated_at).toISOString() !== value.updated_at
        || typeof value.id !== 'string'
        || !value.id
        || value.id.length > 160
      ) throw new Error('invalid')
      return { updated_at: value.updated_at, id: value.id }
    } catch {
      throw new VideoFactsRepositoryError('视频事实分页游标无效', 'VIDEO_FACTS_INVALID')
    }
  }
}
