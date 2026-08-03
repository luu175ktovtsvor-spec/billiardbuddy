import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Database } from 'bun:sqlite'

export class SqliteUnitOfWorkError extends Error {
  constructor(message: string, readonly code: 'MEDIA_SQLITE_UNAVAILABLE' | 'MEDIA_SQLITE_CORRUPT' = 'MEDIA_SQLITE_UNAVAILABLE') {
    super(message)
    this.name = 'SqliteUnitOfWorkError'
  }
}

const MEDIA_KERNEL_SCHEMA_VERSION = 1

/**
 * The Media Kernel is the only owner of the SQLite connection and schema
 * lifecycle. Domain repositories receive this narrow transaction boundary;
 * they do not open their own database or silently recreate a damaged one.
 */
export class SqliteUnitOfWork {
  readonly database: Database
  readonly path: string

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.path = join(root, 'metadata.sqlite')
    try {
      this.database = new Database(this.path)
      this.database.exec('PRAGMA foreign_keys=ON')
      this.database.exec('PRAGMA busy_timeout=5000')
      this.database.exec('PRAGMA journal_mode=WAL')
      this.database.exec('PRAGMA synchronous=FULL')
      this.assertHealthy()
      this.migrate()
    } catch (error) {
      if (error instanceof SqliteUnitOfWorkError) throw error
      throw new SqliteUnitOfWorkError(
        error instanceof Error ? error.message : '无法打开媒体 SQLite 存储',
      )
    }
  }

  transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // The original failure is the useful one. A failed BEGIN/COMMIT can
        // leave SQLite without an active transaction to roll back.
      }
      throw error
    }
  }

  close(): void {
    try {
      this.checkpoint()
    } finally {
      this.database.close()
    }
  }

  checkpoint(): void {
    // PASSIVE never blocks an active reader; it is a controlled durability
    // boundary rather than an opportunistic truncate of another process's WAL.
    this.database.exec('PRAGMA wal_checkpoint(PASSIVE)')
  }

  private assertHealthy(): void {
    const row = this.database.query('PRAGMA quick_check').get() as Record<string, unknown> | null
    const value = row ? Object.values(row)[0] : undefined
    if (value !== 'ok') {
      throw new SqliteUnitOfWorkError('媒体 SQLite 存储损坏，已拒绝继续写入', 'MEDIA_SQLITE_CORRUPT')
    }
  }

  private backupBeforeMigration(version: number): void {
    if (!existsSync(this.path)) return
    const backup = join(dirname(this.path), 'backups', `metadata.sqlite.before-v${version}`)
    if (existsSync(backup)) return
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 })
    // VACUUM INTO captures the WAL-backed database as one consistent snapshot;
    // copying only metadata.sqlite could lose recent pages still in its WAL.
    const escaped = backup.replaceAll("'", "''")
    this.database.exec(`VACUUM INTO '${escaped}'`)
  }

  private migrate(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS media_kernel_schema_migrations(
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`)
    const applied = this.database.query('SELECT version FROM media_kernel_schema_migrations WHERE version=?')
      .get(MEDIA_KERNEL_SCHEMA_VERSION) as { version: number } | null
    if (applied) return

    this.backupBeforeMigration(MEDIA_KERNEL_SCHEMA_VERSION)
    this.transaction(() => {
      this.database.exec(`CREATE TABLE IF NOT EXISTS media_commit_intents(
        id TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        project_id TEXT,
        staging_locator TEXT NOT NULL,
        final_locator TEXT NOT NULL,
        expected_hash TEXT NOT NULL,
        expected_bytes INTEGER NOT NULL,
        payload_schema TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('staging','payload_ready','prepared','committed','abandoned')),
        created_at TEXT NOT NULL,
        prepared_at TEXT,
        committed_at TEXT,
        abandoned_at TEXT
      )`)
      this.database.exec(`CREATE TABLE IF NOT EXISTS media_payload_blobs(
        locator TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        schema_name TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        ref_count INTEGER NOT NULL CHECK(ref_count >= 0),
        created_at TEXT NOT NULL
      )`)
      this.database.exec(`CREATE TABLE IF NOT EXISTS video_project_payloads(
        intent_id TEXT PRIMARY KEY REFERENCES media_commit_intents(id),
        project_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_locator TEXT NOT NULL,
        payload_schema TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','committed','abandoned'))
      )`)
      this.database.exec(`CREATE TABLE IF NOT EXISTS video_operation_payloads(
        intent_id TEXT PRIMARY KEY REFERENCES media_commit_intents(id),
        operation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_locator TEXT NOT NULL,
        payload_schema TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        emits_event INTEGER NOT NULL CHECK(emits_event IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('prepared','committed','abandoned'))
      )`)
      this.database.exec(`CREATE TABLE IF NOT EXISTS video_projects(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        writer_fence TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_locator TEXT NOT NULL,
        payload_schema TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
      )`)
      this.database.exec('CREATE INDEX IF NOT EXISTS video_projects_owner_updated ON video_projects(owner_kind, owner_id, deleted, updated_at DESC)')
      this.database.exec(`CREATE TABLE IF NOT EXISTS video_operations(
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        status_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_locator TEXT NOT NULL,
        payload_schema TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
        FOREIGN KEY(project_id) REFERENCES video_projects(id)
      )`)
      this.database.exec('CREATE INDEX IF NOT EXISTS video_operations_project_updated ON video_operations(project_id, deleted, updated_at DESC)')
      this.database.exec(`CREATE TABLE IF NOT EXISTS media_outbox_events(
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_id TEXT NOT NULL UNIQUE REFERENCES media_commit_intents(id),
        project_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        status_sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_locator TEXT NOT NULL,
        legacy_key TEXT UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('prepared','committed','abandoned'))
      )`)
      this.database.exec('CREATE INDEX IF NOT EXISTS media_outbox_events_project_cursor ON media_outbox_events(project_id, state, cursor)')
      this.database.exec(`CREATE TABLE IF NOT EXISTS video_deletions(
        deletion_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`)
      this.database.exec('CREATE INDEX IF NOT EXISTS video_deletions_project_status ON video_deletions(project_id, status, updated_at DESC)')
      this.database.exec(`CREATE TABLE IF NOT EXISTS media_legacy_imports(
        migration_key TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      )`)
      this.database.query('INSERT INTO media_kernel_schema_migrations(version,applied_at) VALUES(?,?)')
        .run(MEDIA_KERNEL_SCHEMA_VERSION, new Date().toISOString())
    })
  }
}
