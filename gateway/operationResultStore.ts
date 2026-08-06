import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

export type GatewayReplayCapability = 'SpeechTranscription' | 'SpeechSynthesis' | 'VoiceCloning' | 'VisualEvidence' | 'AudioUnderstanding' | 'MediaReasoning' | 'ImageAdvice' | 'WebSearch' | 'TextReasoning'

export type GatewayOperationResultBinding = {
  principal_id: string
  installation_id: string
  operation_id: string
  capability: GatewayReplayCapability
  fingerprint: string
}

export type GatewayOperationStart =
  | { outcome: 'started'; fencing_token: number }
  | { outcome: 'succeeded'; payload: string }
  | { outcome: 'in_progress' }
  | { outcome: 'outcome_unknown' }

export type GatewayOperationLookup =
  | { outcome: 'not_found' }
  | Exclude<GatewayOperationStart, { outcome: 'started' }>

export type GatewayOperationAcknowledgement = 'acknowledged' | 'in_progress' | 'outcome_unknown'
export type GatewayConsumerAckBacklog = {
  installation: { rows: number; bytes: number; max_rows: number; max_bytes: number }
  global: { rows: number; bytes: number; max_rows: number; max_bytes: number }
}

export class GatewayOperationResultError extends Error {
  constructor(
    readonly status: 409 | 503,
    readonly code: 'OPERATION_RESULT_CONFLICT' | 'OPERATION_RESULT_UNAVAILABLE' | 'OPERATION_RESULT_BACKLOG_FULL',
  ) {
    super(code)
    this.name = 'GatewayOperationResultError'
  }
}

export interface GatewayOperationResultStore {
  begin(
    binding: GatewayOperationResultBinding,
    options?: { awaitingConsumerAck?: boolean },
  ): GatewayOperationStart
  /** Read-only state/result lookup. It must not reserve, settle, or mutate usage. */
  lookup(binding: GatewayOperationResultBinding): GatewayOperationLookup
  complete(
    binding: GatewayOperationResultBinding,
    fencingToken: number,
    payload: string,
    options?: { awaitingConsumerAck?: boolean },
  ): void
  acknowledge(binding: GatewayOperationResultBinding): GatewayOperationAcknowledgement
  consumerAckBacklog(principalId: string, installationId: string): GatewayConsumerAckBacklog
  release(binding: GatewayOperationResultBinding, fencingToken: number): void
  markOutcomeUnknown(binding: GatewayOperationResultBinding, fencingToken: number): void
}

type StoredRow = GatewayOperationResultBinding & {
  state: 'reserved' | 'succeeded' | 'outcome_unknown'
  fencing_token: number
  payload: string | null
  created_at: number
  attempt: number
  expires_at: number
  acknowledged_at: number | null
}

const MAX_RESULT_BYTES_BY_CAPABILITY: Record<GatewayReplayCapability, number> = {
  SpeechTranscription: 4 * 1024 * 1024,
  SpeechSynthesis: 16 * 1024 * 1024,
  VoiceCloning: 1024 * 1024,
  VisualEvidence: 4 * 1024 * 1024,
  AudioUnderstanding: 4 * 1024 * 1024,
  MediaReasoning: 4 * 1024 * 1024,
  ImageAdvice: 4 * 1024 * 1024,
  WebSearch: 4 * 1024 * 1024,
  // The canonical JSON can be larger than the original 8 MiB SSE body because
  // JSON string escaping may expand tool arguments and text by nearly 2x.
  TextReasoning: 20 * 1024 * 1024,
}
const RESULT_RETENTION_MS = 30 * 24 * 60 * 60_000
const RESERVATION_LEASE_MS = 30 * 60_000
// Consumer ACK is a durability boundary, not permission to fill the server
// indefinitely. These high-water marks are safety limits for abandoned clients;
// normal consumers drain each row immediately after their own durable commit.
const MAX_UNACKNOWLEDGED_BYTES_PER_INSTALLATION = 512 * 1024 * 1024
const MAX_UNACKNOWLEDGED_BYTES_GLOBAL = 2 * 1024 * 1024 * 1024
const MAX_UNACKNOWLEDGED_ROWS_PER_INSTALLATION = 100_000
const MAX_UNACKNOWLEDGED_ROWS_GLOBAL = 250_000
const MAX_SUCCEEDED_RESULTS_BY_CAPABILITY: Record<GatewayReplayCapability, number> = {
  SpeechTranscription: 512,
  SpeechSynthesis: 32,
  VoiceCloning: 128,
  VisualEvidence: 512,
  AudioUnderstanding: 512,
  MediaReasoning: 256,
  ImageAdvice: 512,
  WebSearch: 128,
  TextReasoning: 64,
}

function operationKey(binding: GatewayOperationResultBinding): string {
  return createHash('sha256').update(`${binding.principal_id}\0${binding.installation_id}\0${binding.operation_id}`).digest('hex')
}

function fencingToken(): number {
  return randomBytes(6).readUIntBE(0, 6)
}

function validateBinding(binding: GatewayOperationResultBinding): void {
  if (!binding.principal_id || !binding.installation_id
    || !/^[A-Za-z0-9._:-]{8,200}$/.test(binding.operation_id)
    || !['SpeechTranscription', 'SpeechSynthesis', 'VoiceCloning', 'VisualEvidence', 'AudioUnderstanding', 'MediaReasoning', 'ImageAdvice', 'WebSearch', 'TextReasoning'].includes(binding.capability)
    || !/^[a-f0-9]{64}$/.test(binding.fingerprint)) {
    throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
  }
}

function validatePayload(capability: GatewayReplayCapability, payload: string): void {
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (bytes < 2 || bytes > MAX_RESULT_BYTES_BY_CAPABILITY[capability]) {
    throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
  } catch {
    throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
  }
}

function assertSameBinding(row: StoredRow, binding: GatewayOperationResultBinding): void {
  if (row.principal_id !== binding.principal_id
    || row.installation_id !== binding.installation_id
    || row.operation_id !== binding.operation_id
    || row.capability !== binding.capability
    || row.fingerprint !== binding.fingerprint) {
    throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
  }
}

export class SqliteGatewayOperationResultStore implements GatewayOperationResultStore {
  private readonly db: Database

  constructor(filePath: string) {
    const directory = dirname(filePath)
    if (directory && directory !== '.') mkdirSync(directory, { recursive: true })
    this.db = new Database(filePath)
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS gateway_operation_results_v4(
      operation_key TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    )`)
    const columns = this.db.query('PRAGMA table_info(gateway_operation_results_v4)').all() as Array<{ name: string }>
    const hadAcknowledgementColumn = columns.some(column => column.name === 'acknowledged_at')
    if (!hadAcknowledgementColumn) {
      this.db.exec('ALTER TABLE gateway_operation_results_v4 ADD COLUMN acknowledged_at INTEGER')
      // Rows created before the consumer-ACK protocol already followed bounded
      // cache semantics. Backfill only during this one-time schema upgrade so
      // they do not become immortal unowned results.
      this.db.exec("UPDATE gateway_operation_results_v4 SET acknowledged_at=created_at WHERE state='succeeded'")
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS gateway_operation_results_owner_v4 ON gateway_operation_results_v4(principal_id,installation_id,state,created_at)')
    this.db.exec('CREATE INDEX IF NOT EXISTS gateway_operation_results_capability_v4 ON gateway_operation_results_v4(principal_id,installation_id,capability,state,created_at)')
    // A reservation can only be owned by the process that created it. If this
    // store is opening after a Gateway restart, no previous in-memory drain is
    // still capable of completing those rows; expose them as unknown at once
    // instead of making recovery wait for the normal live-process lease.
    this.db.query("UPDATE gateway_operation_results_v4 SET state='outcome_unknown',expires_at=0 WHERE state='reserved'").run()
  }

  begin(
    binding: GatewayOperationResultBinding,
    options: { awaitingConsumerAck?: boolean } = {},
  ): GatewayOperationStart {
    validateBinding(binding)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const now = Date.now()
      let row = this.find(binding)
      if (row) {
        assertSameBinding(row, binding)
        if (row.state === 'succeeded' && row.acknowledged_at !== null && row.expires_at <= now) {
          this.db.query('DELETE FROM gateway_operation_results_v4 WHERE operation_key=? AND fencing_token=?')
            .run(operationKey(binding), row.fencing_token)
          row = null
        } else if (row.state === 'reserved' && row.expires_at <= now) {
          this.db.query(`UPDATE gateway_operation_results_v4 SET state='outcome_unknown',expires_at=0
            WHERE operation_key=? AND fencing_token=? AND state='reserved'`).run(operationKey(binding), row.fencing_token)
          row = { ...row, state: 'outcome_unknown', expires_at: 0 }
        }
      }
      if (row?.state === 'succeeded') {
        if (!row.payload) throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
        validatePayload(binding.capability, row.payload)
        this.db.exec('COMMIT')
        return { outcome: 'succeeded', payload: row.payload }
      }
      if (row?.state === 'reserved') {
        this.db.exec('COMMIT')
        return { outcome: 'in_progress' }
      }
      if (row?.state === 'outcome_unknown') {
        this.db.exec('COMMIT')
        return { outcome: 'outcome_unknown' }
      }
      if (options.awaitingConsumerAck) this.assertConsumerAckBacklogAvailable(binding)
      const token = fencingToken()
      this.db.query(`INSERT INTO gateway_operation_results_v4(
        operation_key,principal_id,installation_id,operation_id,capability,fingerprint,state,fencing_token,payload,created_at,attempt,expires_at,acknowledged_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        operationKey(binding), binding.principal_id, binding.installation_id, binding.operation_id,
        binding.capability, binding.fingerprint, 'reserved', token, null, now, 1, now + RESERVATION_LEASE_MS, null,
      )
      this.db.exec('COMMIT')
      return { outcome: 'started', fencing_token: token }
    } catch (error) {
      this.rollback()
      if (error instanceof GatewayOperationResultError) throw error
      throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
    }
  }

  lookup(binding: GatewayOperationResultBinding): GatewayOperationLookup {
    validateBinding(binding)
    this.db.exec('BEGIN')
    try {
      const row = this.find(binding)
      if (!row) {
        this.db.exec('COMMIT')
        return { outcome: 'not_found' }
      }
      assertSameBinding(row, binding)
      const now = Date.now()
      if (row.state === 'succeeded' && row.acknowledged_at !== null && row.expires_at <= now) {
        this.db.exec('COMMIT')
        return { outcome: 'not_found' }
      }
      if (row.state === 'reserved' && row.expires_at <= now) {
        this.db.exec('COMMIT')
        return { outcome: 'outcome_unknown' }
      }
      if (row.state === 'succeeded') {
        if (!row.payload) throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
        validatePayload(binding.capability, row.payload)
        this.db.exec('COMMIT')
        return { outcome: 'succeeded', payload: row.payload }
      }
      this.db.exec('COMMIT')
      return { outcome: row.state === 'reserved' ? 'in_progress' : 'outcome_unknown' }
    } catch (error) {
      this.rollback()
      if (error instanceof GatewayOperationResultError) throw error
      throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
    }
  }

  complete(
    binding: GatewayOperationResultBinding,
    token: number,
    payload: string,
    options: { awaitingConsumerAck?: boolean } = {},
  ): void {
    validateBinding(binding)
    validatePayload(binding.capability, payload)
    this.mutate(binding, token, row => {
      if (row.state === 'succeeded') {
        if (row.payload !== payload) throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
        return
      }
      if (row.state !== 'reserved') throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
      const now = Date.now()
      // Operations that name an external durable consumer stay outside TTL/count
      // pruning until that consumer explicitly confirms its own commit. Other
      // callers retain the existing bounded replay-cache behavior.
      this.db.query(`UPDATE gateway_operation_results_v4 SET state='succeeded',payload=?,expires_at=?,acknowledged_at=?
        WHERE operation_key=? AND fencing_token=? AND state='reserved'`).run(
        payload,
        options.awaitingConsumerAck ? 0 : now + RESULT_RETENTION_MS,
        options.awaitingConsumerAck ? null : now,
        operationKey(binding), token,
      )
      if (!options.awaitingConsumerAck) this.pruneSucceeded(binding, now)
    })
  }

  acknowledge(binding: GatewayOperationResultBinding): GatewayOperationAcknowledgement {
    validateBinding(binding)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.find(binding)
      if (!row) throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
      assertSameBinding(row, binding)
      if (row.state === 'reserved') {
        this.db.exec('COMMIT')
        return 'in_progress'
      }
      if (row.state === 'outcome_unknown') {
        this.db.exec('COMMIT')
        return 'outcome_unknown'
      }
      if (!row.payload) throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
      validatePayload(binding.capability, row.payload)
      const now = Date.now()
      if (row.acknowledged_at === null) {
        this.db.query(`UPDATE gateway_operation_results_v4 SET acknowledged_at=?,expires_at=?
          WHERE operation_key=? AND state='succeeded' AND acknowledged_at IS NULL`).run(
          now, now + RESULT_RETENTION_MS, operationKey(binding),
        )
      }
      this.pruneSucceeded(binding, now)
      this.db.exec('COMMIT')
      return 'acknowledged'
    } catch (error) {
      this.rollback()
      if (error instanceof GatewayOperationResultError) throw error
      throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
    }
  }

  consumerAckBacklog(principalId: string, installationId: string): GatewayConsumerAckBacklog {
    const installation = this.backlogRow(
      'principal_id=? AND installation_id=?',
      principalId,
      installationId,
    )
    const global = this.backlogRow('1=1')
    return {
      installation: {
        ...installation,
        max_rows: MAX_UNACKNOWLEDGED_ROWS_PER_INSTALLATION,
        max_bytes: MAX_UNACKNOWLEDGED_BYTES_PER_INSTALLATION,
      },
      global: {
        ...global,
        max_rows: MAX_UNACKNOWLEDGED_ROWS_GLOBAL,
        max_bytes: MAX_UNACKNOWLEDGED_BYTES_GLOBAL,
      },
    }
  }

  release(binding: GatewayOperationResultBinding, token: number): void {
    validateBinding(binding)
    this.mutate(binding, token, row => {
      if (row.state !== 'reserved') throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
      this.db.query("DELETE FROM gateway_operation_results_v4 WHERE operation_key=? AND fencing_token=? AND state='reserved'")
        .run(operationKey(binding), token)
    })
  }

  markOutcomeUnknown(binding: GatewayOperationResultBinding, token: number): void {
    validateBinding(binding)
    this.mutate(binding, token, row => {
      if (row.state === 'outcome_unknown') return
      if (row.state !== 'reserved') throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
      this.db.query(`UPDATE gateway_operation_results_v4 SET state='outcome_unknown',expires_at=0
        WHERE operation_key=? AND fencing_token=? AND state='reserved'`).run(operationKey(binding), token)
    })
  }

  private find(binding: GatewayOperationResultBinding): StoredRow | null {
    return this.db.query(`SELECT principal_id,installation_id,operation_id,capability,fingerprint,state,
      fencing_token,payload,created_at,attempt,expires_at,acknowledged_at FROM gateway_operation_results_v4 WHERE operation_key=?`)
      .get(operationKey(binding)) as StoredRow | null
  }

  private mutate(binding: GatewayOperationResultBinding, token: number, action: (row: StoredRow) => void): void {
    if (!Number.isSafeInteger(token) || token <= 0) throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.find(binding)
      if (!row || row.fencing_token !== token) throw new GatewayOperationResultError(409, 'OPERATION_RESULT_CONFLICT')
      assertSameBinding(row, binding)
      action(row)
      this.db.exec('COMMIT')
    } catch (error) {
      this.rollback()
      if (error instanceof GatewayOperationResultError) throw error
      throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
    }
  }

  private pruneSucceeded(binding: GatewayOperationResultBinding, now: number): void {
    this.db.query("DELETE FROM gateway_operation_results_v4 WHERE state='succeeded' AND acknowledged_at IS NOT NULL AND expires_at<=?").run(now)
    const stale = this.db.query(`SELECT operation_key FROM gateway_operation_results_v4
      WHERE principal_id=? AND installation_id=? AND capability=? AND state='succeeded' AND acknowledged_at IS NOT NULL
      ORDER BY created_at DESC LIMIT -1 OFFSET ?`)
      .all(
        binding.principal_id,
        binding.installation_id,
        binding.capability,
        MAX_SUCCEEDED_RESULTS_BY_CAPABILITY[binding.capability],
      ) as Array<{ operation_key: string }>
    const remove = this.db.query("DELETE FROM gateway_operation_results_v4 WHERE operation_key=? AND state='succeeded' AND acknowledged_at IS NOT NULL")
    for (const row of stale) remove.run(row.operation_key)
  }

  private assertConsumerAckBacklogAvailable(binding: GatewayOperationResultBinding): void {
    const backlog = this.consumerAckBacklog(binding.principal_id, binding.installation_id)
    if (backlog.installation.rows >= backlog.installation.max_rows
      || backlog.installation.bytes >= backlog.installation.max_bytes
      || backlog.global.rows >= backlog.global.max_rows
      || backlog.global.bytes >= backlog.global.max_bytes) {
      throw new GatewayOperationResultError(503, 'OPERATION_RESULT_BACKLOG_FULL')
    }
  }

  private backlogRow(where: string, ...params: string[]): { rows: number; bytes: number } {
    return this.db.query(`SELECT COUNT(*) AS rows,
      COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes
      FROM gateway_operation_results_v4
      WHERE state='succeeded' AND acknowledged_at IS NULL AND ${where}`)
      .get(...params) as { rows: number; bytes: number }
  }

  private rollback(): void {
    try { this.db.exec('ROLLBACK') } catch {}
  }
}
