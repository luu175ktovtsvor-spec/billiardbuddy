import { SqliteUnitOfWork } from './sqliteUnitOfWork.js'

export type StoredDeletion<T> = {
  deletion_id: string
  project_id: string
  owner_kind: string
  owner_id: string
  status: string
  receipt: T
  updated_at: string
}

/** SQLite authority for recoverable deletion receipts. */
export class DeletionStore<T> {
  constructor(
    private readonly unitOfWork: SqliteUnitOfWork,
    private readonly parse: (value: unknown) => T,
  ) {}

  put(input: StoredDeletion<T>): void {
    this.unitOfWork.database.query(`INSERT INTO video_deletions(
      deletion_id,project_id,owner_kind,owner_id,status,receipt_json,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(deletion_id) DO UPDATE SET
      status=excluded.status,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`).run(
      input.deletion_id,
      input.project_id,
      input.owner_kind,
      input.owner_id,
      input.status,
      JSON.stringify(input.receipt),
      input.updated_at,
    )
  }

  list(): StoredDeletion<T>[] {
    return (this.unitOfWork.database.query('SELECT * FROM video_deletions ORDER BY updated_at DESC').all() as Array<{
      deletion_id: string
      project_id: string
      owner_kind: string
      owner_id: string
      status: string
      receipt_json: string
      updated_at: string
    }>).map(row => ({
      deletion_id: row.deletion_id,
      project_id: row.project_id,
      owner_kind: row.owner_kind,
      owner_id: row.owner_id,
      status: row.status,
      receipt: this.parse(JSON.parse(row.receipt_json)),
      updated_at: row.updated_at,
    }))
  }
}
