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

export type EventCursorState = {
  project_id: string
  next_cursor: number
  retained_from_cursor: number
}

export type EventJournalPage = {
  events: PersistedOutboxEvent[]
  cursor: number
  /** Raw journal continuation value. Clients continue from `next_cursor - 1`. */
  next_cursor: number
  reset_required: boolean
}

/** SQLite-backed outbox. Prepared rows stay invisible until payload publish. */
export class EventJournal {
  constructor(private readonly unitOfWork: SqliteUnitOfWork) {}

  prepare(input: Omit<PersistedOutboxEvent, 'cursor' | 'state'>, preservedCursor?: number): number {
    const cursor = preservedCursor === undefined
      ? this.reserveNextCursor(input.project_id)
      : this.reservePreservedCursor(input.project_id, preservedCursor)
    const result = this.unitOfWork.database.query(`INSERT INTO media_outbox_events(
      cursor,intent_id,project_id,operation_id,status_sequence,occurred_at,payload_hash,payload_locator,legacy_key,state
    ) VALUES(?,?,?,?,?,?,?,?,?, 'prepared')`).run(
      cursor,
      input.intent_id,
      input.project_id,
      input.operation_id,
      input.status_sequence,
      input.occurred_at,
      input.payload_hash,
      input.payload_locator,
      input.legacy_key,
    )
    void result
    return cursor
  }

  commit(intentId: string): void {
    this.unitOfWork.database.query("UPDATE media_outbox_events SET state='committed' WHERE intent_id=? AND state='prepared'")
      .run(intentId)
  }

  abandon(intentId: string): void {
    this.unitOfWork.database.query("UPDATE media_outbox_events SET state='abandoned' WHERE intent_id=? AND state='prepared'")
      .run(intentId)
  }

  list(projectId: string, after: number, limit: number): EventJournalPage {
    const state = this.cursorState(projectId)
    const nextCursor = state?.next_cursor ?? 1
    // A cursor beyond the durable head is just as unsafe as one that has
    // fallen behind retention. Returning an ordinary empty page would let a
    // client advance its local checkpoint past events it has never observed.
    if (state && (after < state.retained_from_cursor - 1 || after > state.next_cursor - 1)) {
      return { events: [], cursor: state.next_cursor - 1, next_cursor: state.next_cursor, reset_required: true }
    }
    const events = this.listAllAfter(projectId, after, limit)
    const cursor = events.at(-1)?.cursor ?? after
    // `next_cursor` is a continuation value, not the current global head.
    // A client resumes from `next_cursor - 1`; returning the global head for a
    // truncated page would skip every event between this page and that head.
    // Empty pages may still expose the durable head so a long-polling client
    // remains aligned with a journal that has no newly committed rows.
    const continuation = events.length > 0 ? cursor + 1 : nextCursor
    return { events, cursor, next_cursor: continuation, reset_required: false }
  }

  listAll(projectId: string): PersistedOutboxEvent[] {
    return (this.unitOfWork.database.query(`SELECT * FROM media_outbox_events
      WHERE project_id=? AND state='committed' ORDER BY cursor ASC`).all(projectId) as PersistedOutboxEvent[])
      .map(row => ({ ...row, payload_hash: row.payload_hash as `sha256:${string}` }))
  }

  cursorState(projectId: string): EventCursorState | null {
    return this.unitOfWork.database.query('SELECT * FROM media_event_cursors WHERE project_id=?').get(projectId) as EventCursorState | null
  }

  preserveLegacyCursorState(projectId: string, nextCursor: number, retainedFromCursor: number): void {
    if (
      !Number.isSafeInteger(nextCursor)
      || !Number.isSafeInteger(retainedFromCursor)
      || nextCursor < 1
      || retainedFromCursor < 1
      || retainedFromCursor > nextCursor
    ) throw new Error('MEDIA_EVENT_CURSOR_INVALID')
    const first = this.unitOfWork.database.query(`SELECT MIN(cursor) AS cursor FROM media_outbox_events
      WHERE project_id=? AND state='committed'`).get(projectId) as { cursor: number | null }
    if (first.cursor !== null && first.cursor < retainedFromCursor) {
      throw new Error('MEDIA_EVENT_CURSOR_RECONCILIATION_CONFLICT')
    }
    const current = this.cursorState(projectId)
    if (!current) {
      this.unitOfWork.database.query(`INSERT INTO media_event_cursors(project_id,next_cursor,retained_from_cursor)
        VALUES(?,?,?)`).run(projectId, nextCursor, retainedFromCursor)
      return
    }
    this.unitOfWork.database.query(`UPDATE media_event_cursors
      SET next_cursor=MAX(next_cursor, ?), retained_from_cursor=?
      WHERE project_id=?`).run(nextCursor, retainedFromCursor, projectId)
  }

  private listAllAfter(projectId: string, after: number, limit: number): PersistedOutboxEvent[] {
    return (this.unitOfWork.database.query(`SELECT * FROM media_outbox_events
      WHERE project_id=? AND state='committed' AND cursor>? ORDER BY cursor ASC LIMIT ?`).all(
      projectId,
      after,
      Math.max(1, Math.min(200, limit)),
    ) as PersistedOutboxEvent[]).map(row => ({ ...row, payload_hash: row.payload_hash as `sha256:${string}` }))
  }

  private reserveNextCursor(projectId: string): number {
    const current = this.cursorState(projectId)
    const cursor = current?.next_cursor ?? 1
    if (!current) {
      this.unitOfWork.database.query(`INSERT INTO media_event_cursors(project_id,next_cursor,retained_from_cursor)
        VALUES(?,?,?)`).run(projectId, cursor + 1, cursor)
    } else {
      this.unitOfWork.database.query('UPDATE media_event_cursors SET next_cursor=? WHERE project_id=?')
        .run(cursor + 1, projectId)
    }
    return cursor
  }

  private reservePreservedCursor(projectId: string, cursor: number): number {
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('MEDIA_EVENT_CURSOR_INVALID')
    const current = this.cursorState(projectId)
    if (!current) {
      this.unitOfWork.database.query(`INSERT INTO media_event_cursors(project_id,next_cursor,retained_from_cursor)
        VALUES(?,?,?)`).run(projectId, cursor + 1, cursor)
    } else {
      this.unitOfWork.database.query(`UPDATE media_event_cursors
        SET next_cursor=MAX(next_cursor, ?), retained_from_cursor=MIN(retained_from_cursor, ?)
        WHERE project_id=?`).run(cursor + 1, cursor, projectId)
    }
    return cursor
  }

  listPrepared(): PersistedOutboxEvent[] {
    return (this.unitOfWork.database.query("SELECT * FROM media_outbox_events WHERE state='prepared' ORDER BY cursor")
      .all() as PersistedOutboxEvent[]).map(row => ({ ...row, payload_hash: row.payload_hash as `sha256:${string}` }))
  }
}
