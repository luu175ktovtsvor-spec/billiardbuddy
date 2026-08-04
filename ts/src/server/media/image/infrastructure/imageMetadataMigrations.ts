import type { SqliteUnitOfWork } from '../../kernel/storage/sqliteUnitOfWork.js'

const IMAGE_METADATA_SCHEMA_VERSION = 9

/** Image-only metadata schema. The shared Kernel remains unaware of image facts. */
export function migrateImageMetadata(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.database.exec(`CREATE TABLE IF NOT EXISTS image_metadata_schema_migrations(
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  for (let version = 1; version <= IMAGE_METADATA_SCHEMA_VERSION; version += 1) {
    if (unitOfWork.database.query('SELECT version FROM image_metadata_schema_migrations WHERE version=?').get(version)) continue
    if (version === 1) migrateV1(unitOfWork)
    if (version === 2) migrateV2(unitOfWork)
    if (version === 3) migrateV3(unitOfWork)
    if (version === 4) migrateV4(unitOfWork)
    if (version === 5) migrateV5(unitOfWork)
    if (version === 6) migrateV6(unitOfWork)
    if (version === 7) migrateV7(unitOfWork)
    if (version === 8) migrateV8(unitOfWork)
    if (version === 9) migrateV9(unitOfWork)
  }
}

/** 15.4 keeps Qwen suggestions immutable and separate from Candidate/Version facts. */
function migrateV9(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_understanding_suggestions(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      execution_receipt_id TEXT NOT NULL UNIQUE REFERENCES image_provider_execution_receipts(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_visual_assessments(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      candidate_id TEXT REFERENCES image_candidates(id),
      version_id TEXT,
      execution_receipt_id TEXT NOT NULL UNIQUE REFERENCES image_provider_execution_receipts(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key),
      CHECK((candidate_id IS NOT NULL AND version_id IS NULL) OR (candidate_id IS NULL AND version_id IS NOT NULL))
    )`)
    unitOfWork.database.exec('CREATE INDEX image_visual_assessments_target ON image_visual_assessments(project_id, candidate_id, version_id, created_at DESC)')
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(9, new Date().toISOString())
  })
}

/** Immutable Brand/Template revisions are renderer inputs, never project JSON. */
function migrateV8(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_brand_kit_revisions(
      id TEXT PRIMARY KEY,
      brand_kit_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(brand_kit_id, revision)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_template_revisions(
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(template_id, revision)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_brand_kit_revisions_owner ON image_brand_kit_revisions(owner_kind, owner_id, brand_kit_id, revision DESC)')
    unitOfWork.database.exec('CREATE INDEX image_template_revisions_owner ON image_template_revisions(owner_kind, owner_id, template_id, revision DESC)')
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(8, new Date().toISOString())
  })
}

/**
 * Keep the request identity separate from a mutable operation projection. A
 * status refresh must therefore never turn into a different idempotent
 * request, while a retry with the same original request can safely find the
 * persisted operation.
 */
function migrateV2(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec("ALTER TABLE image_operations ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''")
    unitOfWork.database.exec(`CREATE TABLE image_project_migration_receipts(
      source_kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      operation_count INTEGER NOT NULL CHECK(operation_count >= 0),
      journal_next_cursor INTEGER,
      version_count INTEGER NOT NULL CHECK(version_count >= 0),
      current_version_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('complete')),
      completed_at TEXT NOT NULL,
      PRIMARY KEY(source_kind, project_id)
    )`)
    unitOfWork.database.exec(`CREATE INDEX image_project_migration_receipts_source
      ON image_project_migration_receipts(source_kind, status, project_id)`)
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(2, new Date().toISOString())
  })
}

/** Orphan deletion requires an aged observation and a later confirming scan. */
function migrateV3(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_cas_orphan_observations(
      content_hash TEXT PRIMARY KEY,
      first_unreachable_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      scan_count INTEGER NOT NULL CHECK(scan_count >= 1)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_cas_orphan_observations_seen ON image_cas_orphan_observations(last_seen_at)')
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(3, new Date().toISOString())
  })
}

/** A changed source must never continue to advertise a completed receipt. */
function migrateV4(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_project_migration_invalidations(
      source_kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      previous_source_hash TEXT,
      invalidated_at TEXT NOT NULL,
      PRIMARY KEY(source_kind, project_id)
    )`)
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(4, new Date().toISOString())
  })
}

/**
 * 15.2 keeps paid-generation facts separate from the pre-15.1 compatibility
 * project document.  The JSON document in each table is validated by the
 * shared ImageGeneration contract; indexed columns enforce the identities and
 * transaction boundaries SQLite needs to protect.
 */
function migrateV5(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_generation_briefs(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      snapshot_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, snapshot_hash)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_generation_briefs_project_created ON image_generation_briefs(project_id, created_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_delivery_specs(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, revision)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_provider_execution_receipts(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_creative_plans(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      brief_snapshot_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_creative_plans_project_created ON image_creative_plans(project_id, created_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_generation_rounds(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      creative_plan_id TEXT NOT NULL REFERENCES image_creative_plans(id),
      estimate_hash TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_generation_operations(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      transport_task_id TEXT UNIQUE REFERENCES image_operations(id),
      kind TEXT NOT NULL CHECK(kind IN ('generate','edit','inpaint','assess','canvas_render','export')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','committing','succeeded','failed','cancelled','blocked_by_policy','outcome_unknown')),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_generation_operations_project_updated ON image_generation_operations(project_id, updated_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_candidate_groups(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      operation_id TEXT NOT NULL UNIQUE REFERENCES image_generation_operations(id),
      generation_round_id TEXT NOT NULL REFERENCES image_generation_rounds(id),
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_candidates(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      candidate_group_id TEXT NOT NULL REFERENCES image_candidate_groups(id),
      /* Project relation replacement re-inserts owned assets transactionally. */
      asset_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      candidate_index INTEGER NOT NULL CHECK(candidate_index >= 0),
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(candidate_group_id, candidate_index)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_candidates_project_created ON image_candidates(project_id, created_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_candidate_decisions(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      candidate_id TEXT NOT NULL REFERENCES image_candidates(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_initial_canvases(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      artboard_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      candidate_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, artboard_id, revision)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_candidate_adoptions(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      candidate_id TEXT NOT NULL,
      artboard_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key, artboard_id)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_project_working_versions(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      artboard_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, artboard_id)
    )`)
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(5, new Date().toISOString())
  })
}

/**
 * 15.2 commands are independently replayable.  Their request identity is
 * indexed separately from mutable projections, and estimates are persisted so
 * a client cannot mint or extend a paid confirmation window by recomputing a
 * hash locally.
 */
function migrateV6(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec("ALTER TABLE image_creative_plans ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''")
    unitOfWork.database.exec("ALTER TABLE image_generation_rounds ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''")
    unitOfWork.database.exec(`CREATE TABLE image_generation_estimates(
      estimate_hash TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      kind TEXT NOT NULL CHECK(kind IN ('generation_round','derivation')),
      request_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_generation_estimates_project_expiry ON image_generation_estimates(project_id, expires_at)')
    unitOfWork.database.exec(`CREATE TABLE image_reference_control_commands(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_project_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, idempotency_key)
    )`)
    // Replaying the same Candidate onto the same Artboard must use the
    // original idempotency command rather than manufacture another Version.
    unitOfWork.database.exec(`CREATE UNIQUE INDEX image_candidate_adoptions_candidate_artboard_unique
      ON image_candidate_adoptions(project_id, candidate_id, artboard_id)`)
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(6, new Date().toISOString())
  })
}

/**
 * 15.3 stores Canvas changes as immutable revisions.  The normalized index is
 * intentionally small; `document_json` remains the validated, complete
 * command/render/export fact so a recovery never has to reconstitute pixels
 * from a renderer-owned cache.
 */
function migrateV7(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_canvases(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      artboard_id TEXT NOT NULL,
      current_revision INTEGER NOT NULL CHECK(current_revision >= 0),
      created_at TEXT NOT NULL,
      UNIQUE(project_id, artboard_id)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_canvas_revisions(
      canvas_id TEXT NOT NULL REFERENCES image_canvases(id),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      document_hash TEXT NOT NULL,
      parent_revision INTEGER,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      PRIMARY KEY(canvas_id, revision)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_canvas_commands(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      canvas_id TEXT NOT NULL REFERENCES image_canvases(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_revision INTEGER NOT NULL CHECK(result_revision >= 0),
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, canvas_id, idempotency_key)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_canvas_preflights(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      canvas_id TEXT NOT NULL REFERENCES image_canvases(id),
      canvas_revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_render_receipts(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      canvas_id TEXT NOT NULL REFERENCES image_canvases(id),
      canvas_revision INTEGER NOT NULL,
      version_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(canvas_id, canvas_revision, version_id)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_release_check_results(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      version_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_export_receipts(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      artboard_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_delivery_sets(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      delivery_spec_id TEXT NOT NULL,
      delivery_spec_revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_delivery_spec_commands(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      delivery_spec_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, idempotency_key)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_artboard_selection_commands(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      artboard_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      version_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, artboard_id, idempotency_key)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_canvas_revisions_created ON image_canvas_revisions(canvas_id, revision DESC)')
    unitOfWork.database.exec('CREATE INDEX image_render_receipts_project_created ON image_render_receipts(project_id, created_at DESC)')
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(7, new Date().toISOString())
  })
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
