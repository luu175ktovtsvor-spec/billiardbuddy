import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { syncParentDirectory } from '../../../../utils/durableFile.js'
import { ContentAddressedStore } from '../assets/contentAddressedStore.js'
import { SqliteUnitOfWork } from './sqliteUnitOfWork.js'

export type PayloadCommitState = 'staging' | 'payload_ready' | 'prepared' | 'committed' | 'abandoned'

export type PayloadCommitIntent = {
  id: string
  entity_kind: string
  aggregate_id: string
  project_id: string | null
  staging_locator: string
  final_locator: string
  expected_hash: `sha256:${string}`
  expected_bytes: number
  payload_schema: string
  payload_version: number
  state: PayloadCommitState
  created_at: string
  prepared_at: string | null
  committed_at: string | null
  abandoned_at: string | null
}

export type StagePayloadInput = {
  entityKind: string
  aggregateId: string
  projectId?: string
  finalLocator: string
  schema: string
  version: number
  value: unknown
  operationId?: string
}

function asIntent(row: PayloadCommitIntent): PayloadCommitIntent {
  return {
    ...row,
    expected_hash: row.expected_hash as `sha256:${string}`,
  }
}

/**
 * Implements the filesystem half of the SQLite/file commit protocol. Domain
 * repositories own their prepared rows and projections, while this class owns
 * staging, hashing, atomic publication and deterministic crash discovery.
 */
export class PayloadCommitProtocol {
  private readonly contentAddressedStore = new ContentAddressedStore()

  constructor(
    private readonly root: string,
    private readonly unitOfWork: SqliteUnitOfWork,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async stage(input: StagePayloadInput): Promise<PayloadCommitIntent> {
    const finalLocator = this.assertLocator(input.finalLocator)
    const value = `${JSON.stringify(input.value)}\n`
    const bytes = Buffer.from(value, 'utf8')
    const expectedHash = this.contentAddressedStore.hash(bytes)
    const intentId = `commit_${randomUUID().replaceAll('-', '')}`
    const stagingLocator = this.assertLocator(join('staging', input.operationId ?? intentId, `${intentId}.json`))
    const createdAt = this.now().toISOString()
    this.unitOfWork.transaction(() => {
      this.unitOfWork.database.query(`INSERT INTO media_commit_intents(
        id,entity_kind,aggregate_id,project_id,staging_locator,final_locator,expected_hash,expected_bytes,payload_schema,payload_version,state,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        intentId,
        input.entityKind,
        input.aggregateId,
        input.projectId ?? null,
        stagingLocator,
        finalLocator,
        expectedHash,
        bytes.byteLength,
        input.schema,
        input.version,
        'staging',
        createdAt,
      )
    })
    const stagingPath = this.pathFor(stagingLocator)
    try {
      await mkdir(dirname(stagingPath), { recursive: true, mode: 0o700 })
      const handle = await open(stagingPath, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncParentDirectory(stagingPath)
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query("UPDATE media_commit_intents SET state='payload_ready' WHERE id=? AND state='staging'")
          .run(intentId)
      })
      return this.requireIntent(intentId)
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined)
      this.unitOfWork.transaction(() => {
        this.unitOfWork.database.query("UPDATE media_commit_intents SET state='abandoned',abandoned_at=? WHERE id=? AND state IN ('staging','payload_ready')")
          .run(this.now().toISOString(), intentId)
      })
      throw error
    }
  }

  prepare(intentId: string, action: (intent: PayloadCommitIntent) => void): PayloadCommitIntent {
    return this.unitOfWork.transaction(() => {
      const intent = this.requireIntent(intentId)
      if (intent.state === 'prepared' || intent.state === 'committed') return intent
      if (intent.state !== 'payload_ready') throw new Error('MEDIA_PAYLOAD_NOT_READY')
      action(intent)
      this.unitOfWork.database.query("UPDATE media_commit_intents SET state='prepared',prepared_at=? WHERE id=?")
        .run(this.now().toISOString(), intentId)
      return this.requireIntent(intentId)
    })
  }

  async publish(intent: PayloadCommitIntent): Promise<void> {
    if (intent.state !== 'prepared' && intent.state !== 'committed') throw new Error('MEDIA_PAYLOAD_NOT_PREPARED')
    const finalPath = this.pathFor(intent.final_locator)
    const stagingPath = this.pathFor(intent.staging_locator)
    const finalInfo = await this.hashIfFile(finalPath)
    if (finalInfo) {
      if (finalInfo.hash !== intent.expected_hash || finalInfo.bytes !== intent.expected_bytes) {
        throw new Error('MEDIA_PAYLOAD_FINAL_HASH_CONFLICT')
      }
      await rm(stagingPath, { force: true }).catch(() => undefined)
      return
    }
    const staged = await this.hashIfFile(stagingPath)
    if (!staged || staged.hash !== intent.expected_hash || staged.bytes !== intent.expected_bytes) {
      throw new Error('MEDIA_PAYLOAD_STAGING_INVALID')
    }
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 })
    await rename(stagingPath, finalPath)
    await syncParentDirectory(finalPath)
  }

  markCommitted(intentId: string): void {
    this.unitOfWork.database.query("UPDATE media_commit_intents SET state='committed',committed_at=? WHERE id=? AND state='prepared'")
      .run(this.now().toISOString(), intentId)
  }

  markAbandoned(intentId: string): void {
    this.unitOfWork.database.query("UPDATE media_commit_intents SET state='abandoned',abandoned_at=? WHERE id=? AND state<>'committed'")
      .run(this.now().toISOString(), intentId)
  }

  preparedIntents(): PayloadCommitIntent[] {
    return (this.unitOfWork.database.query("SELECT * FROM media_commit_intents WHERE state='prepared' ORDER BY created_at,id")
      .all() as PayloadCommitIntent[]).map(asIntent)
  }

  /**
   * A payload_ready intent was never made visible to SQLite and is safe to
   * discard. A prepared intent is completed by its domain repository after
   * this method has republished its immutable payload.
   */
  async recover(): Promise<{ readyToCommit: PayloadCommitIntent[]; abandoned: PayloadCommitIntent[] }> {
    const rows = this.unitOfWork.database.query("SELECT * FROM media_commit_intents WHERE state IN ('staging','payload_ready','prepared') ORDER BY created_at,id")
      .all() as PayloadCommitIntent[]
    const readyToCommit: PayloadCommitIntent[] = []
    const abandoned: PayloadCommitIntent[] = []
    for (const raw of rows) {
      const intent = asIntent(raw)
      if (intent.state === 'staging' || intent.state === 'payload_ready') {
        await rm(this.pathFor(intent.staging_locator), { force: true }).catch(() => undefined)
        this.unitOfWork.transaction(() => this.markAbandoned(intent.id))
        abandoned.push(intent)
        continue
      }
      try {
        await this.publish(intent)
        readyToCommit.push(this.requireIntent(intent.id))
      } catch {
        await rm(this.pathFor(intent.staging_locator), { force: true }).catch(() => undefined)
        this.unitOfWork.transaction(() => this.markAbandoned(intent.id))
        abandoned.push(intent)
      }
    }
    return { readyToCommit, abandoned }
  }

  pathFor(locator: string): string {
    return resolve(this.root, this.assertLocator(locator))
  }

  private requireIntent(intentId: string): PayloadCommitIntent {
    const row = this.unitOfWork.database.query('SELECT * FROM media_commit_intents WHERE id=?').get(intentId) as PayloadCommitIntent | null
    if (!row) throw new Error('MEDIA_COMMIT_INTENT_NOT_FOUND')
    return asIntent(row)
  }

  private assertLocator(locator: string): string {
    if (!locator || isAbsolute(locator)) throw new Error('MEDIA_PAYLOAD_LOCATOR_INVALID')
    const normalized = resolve(this.root, locator)
    if (relative(this.root, normalized).startsWith('..')) throw new Error('MEDIA_PAYLOAD_LOCATOR_INVALID')
    return relative(this.root, normalized)
  }

  private async hashIfFile(path: string): Promise<{ hash: `sha256:${string}`; bytes: number } | null> {
    const file = await this.contentAddressedStore.inspect(path)
    return file ? { hash: file.content_hash, bytes: file.byte_size } : null
  }
}
