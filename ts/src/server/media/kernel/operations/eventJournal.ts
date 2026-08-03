import { SqliteUnitOfWork } from '../storage/sqliteUnitOfWork.js'

export type PersistedOutboxEvent = {
  cursor: number
  intent_id: string
  project_id: string
  operation_id: string
  status_sequence: number
  occurred_at: string
  payload_hash: `sha256:${string}`
  payload_locator: string
  legacy_key: string | null
  state: 'prepared' | 'committed' | 'abandoned'
}

/** SQLite-backed outbox. Prepared rows stay invisible until payload publish. */
export class EventJournal {
  constructor(private readonly unitOfWork: SqliteUnitOfWork) {}

  prepare(input: Omit<PersistedOutboxEvent, 'cursor' | 'state'>): number {
    const result = this.unitOfWork.database.query(`INSERT INTO media_outbox_events(
      intent_id,project_id,operation_id,status_sequence,occurred_at,payload_hash,payload_locator,legacy_key,state
    ) VALUES(?,?,?,?,?,?,?,?, 'prepared')`).run(
      input.intent_id,
      input.project_id,
      input.operation_id,
      input.status_sequence,
      input.occurred_at,
      input.payload_hash,
      input.payload_locator,
      input.legacy_key,
    )
    return Number(result.lastInsertRowid)
  }

  commit(intentId: string): void {
    this.unitOfWork.database.query("UPDATE media_outbox_events SET state='committed' WHERE intent_id=? AND state='prepared'")
      .run(intentId)
  }

  abandon(intentId: string): void {
    this.unitOfWork.database.query("UPDATE media_outbox_events SET state='abandoned' WHERE intent_id=? AND state='prepared'")
      .run(intentId)
  }

  list(projectId: string, after: number, limit: number): PersistedOutboxEvent[] {
    return (this.unitOfWork.database.query(`SELECT * FROM media_outbox_events
      WHERE project_id=? AND state='committed' AND cursor>? ORDER BY cursor ASC LIMIT ?`).all(
      projectId,
      after,
      Math.max(1, Math.min(200, limit)),
    ) as PersistedOutboxEvent[]).map(row => ({ ...row, payload_hash: row.payload_hash as `sha256:${string}` }))
  }

  listPrepared(): PersistedOutboxEvent[] {
    return (this.unitOfWork.database.query("SELECT * FROM media_outbox_events WHERE state='prepared' ORDER BY cursor")
      .all() as PersistedOutboxEvent[]).map(row => ({ ...row, payload_hash: row.payload_hash as `sha256:${string}` }))
  }
}
