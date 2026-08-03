import type { SqliteUnitOfWork } from '../../kernel/storage/sqliteUnitOfWork.js'

const IMAGE_METADATA_SCHEMA_VERSION = 1

/** Image-only metadata schema. The shared Kernel remains unaware of image facts. */
export function migrateImageMetadata(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.database.exec(`CREATE TABLE IF NOT EXISTS image_metadata_schema_migrations(
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  for (let version = 1; version <= IMAGE_METADATA_SCHEMA_VERSION; version += 1) {
    if (unitOfWork.database.query('SELECT version FROM image_metadata_schema_migrations WHERE version=?').get(version)) continue
    if (version === 1) migrateV1(unitOfWork)
  }
}

function migrateV1(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_projects(
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      writer_fence TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
    )`)
    unitOfWork.database.exec('CREATE INDEX image_projects_owner_updated ON image_projects(owner_kind, owner_id, deleted, updated_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_operations(
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      status_sequence INTEGER NOT NULL CHECK(status_sequence >= 0),
      idempotency_key TEXT,
      remote_task_id TEXT,
      remote_result_acknowledged_at TEXT,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
    )`)
    unitOfWork.database.exec('CREATE INDEX image_operations_project_updated ON image_operations(project_id, deleted, updated_at DESC)')
    unitOfWork.database.exec(`CREATE UNIQUE INDEX image_operations_idempotency_unique
      ON image_operations(owner_kind, owner_id, kind, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND deleted=0`)
    unitOfWork.database.exec(`CREATE TABLE image_outbox_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      cursor INTEGER NOT NULL CHECK(cursor >= 1),
      operation_id TEXT NOT NULL,
      status_sequence INTEGER NOT NULL CHECK(status_sequence >= 0),
      occurred_at TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('committed','abandoned')),
      UNIQUE(project_id, cursor)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_outbox_events_project_cursor ON image_outbox_events(project_id, state, cursor)')
    unitOfWork.database.exec(`CREATE TABLE image_event_cursors(
      project_id TEXT PRIMARY KEY REFERENCES image_projects(id),
      next_cursor INTEGER NOT NULL CHECK(next_cursor >= 1),
      retained_from_cursor INTEGER NOT NULL CHECK(retained_from_cursor >= 1)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_asset_ownerships(
      asset_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      role TEXT NOT NULL,
      storage_kind TEXT NOT NULL,
      locator TEXT NOT NULL,
      content_hash TEXT,
      byte_size INTEGER,
      asset_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_asset_ownerships_project ON image_asset_ownerships(project_id, role)')
    unitOfWork.database.exec(`CREATE TABLE image_asset_grants(
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES image_asset_ownerships(asset_id),
      from_owner_json TEXT NOT NULL,
      to_owner_json TEXT NOT NULL,
      purpose TEXT NOT NULL,
      granted_by_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_project_references(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      asset_id TEXT NOT NULL REFERENCES image_asset_ownerships(asset_id),
      position INTEGER NOT NULL CHECK(position >= 0),
      role TEXT NOT NULL,
      reference_json TEXT NOT NULL,
      PRIMARY KEY(project_id, asset_id)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_project_versions(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      operation_id TEXT,
      parent_version_id TEXT,
      project_revision INTEGER NOT NULL CHECK(project_revision >= 0),
      version_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_project_versions_project_created ON image_project_versions(project_id, created_at)')
    unitOfWork.database.exec(`CREATE TABLE image_project_outputs(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      version_id TEXT,
      operation_id TEXT,
      output_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_project_outputs_project ON image_project_outputs(project_id)')
    unitOfWork.database.exec(`CREATE TABLE image_migration_receipts(
      migration_key TEXT PRIMARY KEY,
      source_hash TEXT NOT NULL,
      completed_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_deletions(
      deletion_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_deletions_project_status ON image_deletions(project_id, status, updated_at DESC)')
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(1, new Date().toISOString())
  })
}
