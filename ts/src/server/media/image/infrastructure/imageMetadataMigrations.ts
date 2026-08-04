import { createHash } from 'node:crypto'
import type { SqliteUnitOfWork } from '../../kernel/storage/sqliteUnitOfWork.js'

const IMAGE_METADATA_SCHEMA_VERSION = 12

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
    if (version === 10) migrateV10(unitOfWork)
    if (version === 11) migrateV11(unitOfWork)
    if (version === 12) migrateV12(unitOfWork)
  }
}

/**
 * A Campaign item can move to a new attempt and therefore clear its current
 * project pointer.  The Project-facing intent must remain immutable for each
 * prior attempt, so it is a receipt rather than a derived item lookup.
 */
function migrateV11(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_campaign_project_intents(
      project_id TEXT PRIMARY KEY REFERENCES image_projects(id),
      campaign_id TEXT NOT NULL REFERENCES image_campaigns(id),
      item_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      campaign_revision INTEGER NOT NULL CHECK(campaign_revision >= 0),
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(campaign_id,item_id,attempt)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_campaign_project_intents_campaign_item ON image_campaign_project_intents(campaign_id,item_id,attempt)')
    const rows = unitOfWork.database.query(`SELECT campaigns.document_json AS campaign_json,
      items.campaign_id AS campaign_id,items.project_id AS project_id,items.updated_at AS item_updated_at,items.document_json AS item_json
      FROM image_campaign_items items
      JOIN image_campaigns campaigns ON campaigns.id=items.campaign_id
      WHERE items.project_id IS NOT NULL`).all() as Array<{
        campaign_json: string
        campaign_id: string
        project_id: string
        item_updated_at: string
        item_json: string
      }>
    for (const row of rows) {
      const intent = legacyCampaignProjectIntent(unitOfWork, row)
      unitOfWork.database.query(`INSERT INTO image_campaign_project_intents(
        project_id,campaign_id,item_id,attempt,campaign_revision,created_at,document_json
      ) VALUES(?,?,?,?,?,?,?)`).run(
        intent.project_id, intent.campaign_id, intent.item_id, intent.attempt,
        intent.campaign_revision, intent.created_at, JSON.stringify(intent.document),
      )
    }
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(11, new Date().toISOString())
  })
}

/**
 * v11 originally reconstructed an immutable child-project intent from the
 * mutable Campaign row.  A completed/retried Campaign has moved its revision
 * since the child was bound, so that record is not evidence for the original
 * binding.  v12 repairs existing v11 data and records the exact paid Round /
 * Operation for every attempt.  Both facts come from durable receipts only.
 */
function migrateV12(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_campaign_attempts(
      campaign_id TEXT NOT NULL REFERENCES image_campaigns(id),
      item_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      expected_project_id TEXT NOT NULL UNIQUE,
      generation_round_id TEXT,
      generation_operation_id TEXT UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('reserved','bound','cancelled','cancellation_too_late')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,item_id,attempt)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_campaign_attempts_project ON image_campaign_attempts(expected_project_id,state)')
    unitOfWork.database.exec('CREATE INDEX image_campaign_attempts_operation ON image_campaign_attempts(generation_operation_id)')

    const intents = unitOfWork.database.query(`SELECT campaign_id,item_id,attempt,project_id,created_at,document_json
      FROM image_campaign_project_intents ORDER BY created_at ASC,project_id ASC`).all() as Array<{
        campaign_id: string
        item_id: string
        attempt: number
        project_id: string
        created_at: string
        document_json: string
      }>
    for (const row of intents) {
      const intent = campaignIntentFromBindingReceipt(unitOfWork, {
        campaign_id: row.campaign_id,
        item_id: row.item_id,
        attempt: row.attempt,
        project_id: row.project_id,
        fallback_created_at: row.created_at,
      })
      unitOfWork.database.query(`UPDATE image_campaign_project_intents
        SET campaign_revision=?,created_at=?,document_json=? WHERE project_id=?`).run(
        intent.campaign_revision,
        intent.created_at,
        JSON.stringify(intent.document),
        row.project_id,
      )
      const expectedProjectId = legacyCampaignProjectId(intent.campaign_id, intent.item_id, intent.attempt)
      if (expectedProjectId !== row.project_id) {
        throw new Error('Campaign 项目意图的子项目标识与确定性尝试不一致，不能迁移尝试映射')
      }
      const roundId = legacyCampaignRoundId(expectedProjectId, intent.campaign_id, intent.item_id, intent.attempt)
      const round = unitOfWork.database.query('SELECT document_json FROM image_generation_rounds WHERE id=? AND project_id=?')
        .get(roundId, row.project_id) as { document_json: string } | null
      if (!round) throw new Error('Campaign 项目缺少已持久化的生成 Round，不能迁移尝试映射')
      const roundDocument = migrationRecord(JSON.parse(round.document_json), 'Campaign 生成 Round')
      const directions = Array.isArray(roundDocument.direction_operations) ? roundDocument.direction_operations : []
      if (directions.length !== 1) throw new Error('Campaign 项目生成 Round 必须恰好包含一个操作，不能迁移尝试映射')
      const direction = migrationRecord(directions[0], 'Campaign 生成 Round 操作')
      const operationId = migrationString(direction.operation_id, 'Campaign 生成 Operation id')
      const operation = unitOfWork.database.query(`SELECT document_json FROM image_generation_operations
        WHERE id=? AND project_id=?`).get(operationId, row.project_id) as { document_json: string } | null
      if (!operation) throw new Error('Campaign 项目生成 Round 引用的正式 Operation 不存在或不属于子项目，不能迁移尝试映射')
      const operationDocument = migrationRecord(JSON.parse(operation.document_json), 'Campaign 正式生成 Operation')
      if (
        migrationString(operationDocument.id, 'Campaign 正式生成 Operation id') !== operationId
        || migrationString(operationDocument.project_id, 'Campaign 正式生成 Operation project id') !== row.project_id
      ) {
        throw new Error('Campaign 项目正式 Operation 事实不一致，不能迁移尝试映射')
      }
      const transportTaskId = migrationString(operationDocument.transport_task_id, 'Campaign 正式生成 Operation transport task id')
      const transport = unitOfWork.database.query(`SELECT project_id FROM image_operations WHERE id=?`).get(transportTaskId) as { project_id: string } | null
      if (!transport || transport.project_id !== row.project_id) {
        throw new Error('Campaign 项目正式 Operation 的传输任务不存在或不属于子项目，不能迁移尝试映射')
      }
      unitOfWork.database.query(`INSERT INTO image_campaign_attempts(
        campaign_id,item_id,attempt,expected_project_id,generation_round_id,generation_operation_id,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        intent.campaign_id,
        intent.item_id,
        intent.attempt,
        expectedProjectId,
        roundId,
        operationId,
        'bound',
        intent.created_at,
        intent.created_at,
      )
    }
    // A process can have committed Campaign->queued before it creates the
    // deterministic child Project.  Preserve that recoverable boundary too:
    // the first restart can bind or cancel this reservation without guessing
    // a different paid attempt.
    const queued = unitOfWork.database.query(`SELECT campaign_id,id,attempt,updated_at FROM image_campaign_items
      WHERE state='queued' AND project_id IS NULL ORDER BY updated_at ASC,id ASC`).all() as Array<{
        campaign_id: string
        id: string
        attempt: number
        updated_at: string
      }>
    for (const item of queued) {
      const expectedProjectId = legacyCampaignProjectId(item.campaign_id, item.id, item.attempt)
      unitOfWork.database.query(`INSERT INTO image_campaign_attempts(
        campaign_id,item_id,attempt,expected_project_id,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(campaign_id,item_id,attempt) DO NOTHING`).run(
        item.campaign_id,
        item.id,
        item.attempt,
        expectedProjectId,
        'reserved',
        item.updated_at,
        item.updated_at,
      )
    }
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(12, new Date().toISOString())
  })
}

function legacyCampaignProjectIntent(
  unitOfWork: SqliteUnitOfWork,
  row: { campaign_json: string; campaign_id: string; project_id: string; item_updated_at: string; item_json: string },
): {
  project_id: string
  campaign_id: string
  item_id: string
  attempt: number
  campaign_revision: number
  created_at: string
  document: Record<string, unknown>
} {
  const currentCampaign = migrationRecord(JSON.parse(row.campaign_json), 'Campaign')
  const currentItem = migrationRecord(JSON.parse(row.item_json), 'Campaign 项目')
  const campaignId = migrationString(currentCampaign.id, 'Campaign id')
  if (campaignId !== row.campaign_id) throw new Error('Campaign 项目与 Campaign 记录不一致，不能迁移项目意图')
  const itemId = migrationString(currentItem.id, 'Campaign 项目 id')
  const attempt = migrationInteger(currentItem.attempt, 'Campaign 项目 attempt', 1)
  return campaignIntentFromBindingReceipt(unitOfWork, {
    campaign_id: campaignId,
    item_id: itemId,
    attempt,
    project_id: row.project_id,
    fallback_created_at: row.item_updated_at,
  })
}

function campaignIntentFromBindingReceipt(
  unitOfWork: SqliteUnitOfWork,
  input: { campaign_id: string; item_id: string; attempt: number; project_id: string; fallback_created_at: string },
): {
  project_id: string
  campaign_id: string
  item_id: string
  attempt: number
  campaign_revision: number
  created_at: string
  document: Record<string, unknown>
} {
  const bindingKey = `bb-image-campaign-bind-${input.campaign_id}-${input.item_id}-${input.attempt}`
  const receipt = unitOfWork.database.query(`SELECT result_json,created_at FROM image_campaign_commands
    WHERE campaign_id=? AND idempotency_key=?`).get(input.campaign_id, bindingKey) as {
      result_json: string
      created_at: string
    } | null
  if (!receipt) throw new Error('Campaign 项目缺少绑定命令回执，不能迁移项目意图')
  const result = migrationRecord(JSON.parse(receipt.result_json), 'Campaign 项目绑定回执')
  const campaign = migrationRecord(result.campaign, 'Campaign 项目绑定回执 Campaign')
  const items = Array.isArray(result.items) ? result.items.map(value => migrationRecord(value, 'Campaign 项目绑定回执项目')) : []
  const item = items.find(candidate => migrationString(candidate.id, 'Campaign 项目绑定回执项目 id') === input.item_id)
  if (!item) throw new Error('Campaign 项目绑定回执缺少项目，不能迁移项目意图')
  const campaignId = migrationString(campaign.id, 'Campaign id')
  const itemId = migrationString(item.id, 'Campaign 项目 id')
  const attempt = migrationInteger(item.attempt, 'Campaign 项目 attempt', 1)
  const projectId = migrationString(item.project_id, 'Campaign 项目绑定的图片项目')
  if (campaignId !== input.campaign_id || itemId !== input.item_id || attempt !== input.attempt || projectId !== input.project_id) {
    throw new Error('Campaign 项目绑定回执与项目指针不一致，不能迁移项目意图')
  }
  const bindingResultRevision = migrationInteger(campaign.revision, 'Campaign 绑定结果 revision')
  if (bindingResultRevision < 1) throw new Error('Campaign 绑定结果 revision 无效，不能迁移项目意图')
  const campaignRevision = bindingResultRevision - 1
  const templateId = migrationOptionalString(campaign.template_id, 'Campaign template id')
  const templateRevisionId = migrationOptionalString(campaign.template_revision_id, 'Campaign template revision id')
  const brandKitId = migrationOptionalString(campaign.brand_kit_id, 'Campaign Brand id')
  const brandKitRevisionId = migrationOptionalString(campaign.brand_kit_revision_id, 'Campaign Brand revision id')
  if (Boolean(templateId) !== Boolean(templateRevisionId) || Boolean(brandKitId) !== Boolean(brandKitRevisionId)) {
    throw new Error('Campaign 锁定的 Template 或 Brand revision 损坏，不能迁移项目意图')
  }
  const bindings: Array<Record<string, string>> = []
  const variableValues = Array.isArray(item.variable_values) ? item.variable_values : []
  if (templateId && templateRevisionId) {
    const templateRow = unitOfWork.database.query(`SELECT document_json FROM image_template_revisions
      WHERE id=? AND template_id=?`).get(templateRevisionId, templateId) as { document_json: string } | null
    if (!templateRow) throw new Error('Campaign 锁定的 Template revision 不存在，不能迁移项目意图')
    const template = migrationRecord(JSON.parse(templateRow.document_json), 'Template revision')
    const slots = Array.isArray(template.slots) ? template.slots.map(value => migrationRecord(value, 'Template Slot')) : []
    const slotsById = new Map(slots.map(slot => [migrationString(slot.id, 'Template Slot id'), slot]))
    const seen = new Set<string>()
    for (const rawVariable of variableValues) {
      const variable = migrationRecord(rawVariable, 'Campaign 变量')
      const slotId = migrationString(variable.slot_id, 'Campaign 变量 Slot id')
      const value = migrationString(variable.value, 'Campaign 变量值')
      const slot = slotsById.get(slotId)
      if (!slot || seen.has(slotId)) throw new Error('Campaign 变量与锁定 Template Slot 不一致，不能迁移项目意图')
      seen.add(slotId)
      const kind = migrationString(slot.kind, 'Template Slot kind')
      if (kind === 'text') bindings.push({ slot_id: slotId, text: value })
      else if (kind === 'qrcode') bindings.push({ slot_id: slotId, qr_payload: value })
      else throw new Error('Campaign 变量不能写入图片或标志 Template Slot')
    }
  } else if (variableValues.length > 0) {
    throw new Error('Campaign 变量缺少锁定 Template，不能迁移项目意图')
  }
  const document: Record<string, unknown> = {
    project_id: input.project_id,
    campaign_id: campaignId,
    campaign_revision: campaignRevision,
    item_id: itemId,
    attempt,
    ...(brandKitId ? { brand_kit_id: brandKitId, brand_kit_revision_id: brandKitRevisionId } : {}),
    ...(templateId ? { template_id: templateId, template_revision_id: templateRevisionId } : {}),
    slot_bindings: bindings,
  }
  return {
    project_id: input.project_id,
    campaign_id: campaignId,
    item_id: itemId,
    attempt,
    campaign_revision: campaignRevision,
    created_at: receipt.created_at || input.fallback_created_at,
    document,
  }
}

function legacyCampaignProjectId(campaignId: string, itemId: string, attempt: number): string {
  const key = `bb-image-campaign-${campaignId}-${itemId}-attempt-${attempt}`
  return `img_${createHash('sha256').update(['quick-create', key].join('\0')).digest('hex').slice(0, 32)}`
}

function legacyCampaignRoundId(projectId: string, campaignId: string, itemId: string, attempt: number): string {
  const key = `bb-image-campaign-${campaignId}-${itemId}-attempt-${attempt}`
  return `rnd_${createHash('sha256').update([projectId, key].join('\0')).digest('hex').slice(0, 32)}`
}

function migrationRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 文档损坏，不能迁移项目意图`)
  return value as Record<string, unknown>
}

function migrationString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} 损坏，不能迁移项目意图`)
  return value
}

function migrationOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return migrationString(value, label)
}

function migrationInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) throw new Error(`${label} 损坏，不能迁移项目意图`)
  return value
}

/**
 * 15.5 adds human workflow aggregates without reopening the old JSON writer.
 * Every aggregate keeps an indexed header and a schema-validated immutable
 * document payload; item collections and command receipts stay independently
 * addressable so recovery never needs to infer a batch from a mutable array.
 */
function migrateV10(unitOfWork: SqliteUnitOfWork): void {
  unitOfWork.transaction(() => {
    unitOfWork.database.exec(`CREATE TABLE image_workflow_command_receipts(
      scope TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','complete')),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, aggregate_id, idempotency_key)
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_project_workflow_commands(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      idempotency_key TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_project_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, idempotency_key)
    )`)

    unitOfWork.database.exec(`CREATE TABLE image_inspiration_boards(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE REFERENCES image_projects(id),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_inspiration_items(
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES image_inspiration_boards(id),
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      asset_id TEXT NOT NULL,
      promoted_reference_asset_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_inspiration_items_board ON image_inspiration_items(board_id, created_at)')
    unitOfWork.database.exec(`CREATE TABLE image_inspiration_commands(
      project_id TEXT NOT NULL REFERENCES image_projects(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      board_id TEXT NOT NULL REFERENCES image_inspiration_boards(id),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, idempotency_key)
    )`)

    unitOfWork.database.exec(`CREATE TABLE image_brand_kits(
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      current_revision_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','trashed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_brand_kits_owner ON image_brand_kits(owner_kind, owner_id, state, updated_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_brand_kit_commands(
      brand_kit_id TEXT NOT NULL REFERENCES image_brand_kits(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(brand_kit_id, idempotency_key)
    )`)

    unitOfWork.database.exec(`CREATE TABLE image_templates(
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      current_revision_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','trashed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_templates_owner ON image_templates(owner_kind, owner_id, state, updated_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_template_commands(
      template_id TEXT NOT NULL REFERENCES image_templates(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(template_id, idempotency_key)
    )`)

    unitOfWork.database.exec(`CREATE TABLE image_asset_provenances(
      asset_id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('user_upload','generated','derived','template')),
      retention TEXT NOT NULL CHECK(retention IN ('project','brand_kit','template')),
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_asset_provenances_owner ON image_asset_provenances(owner_kind, owner_id, created_at DESC)')
    /* This detached grant table intentionally does not FK asset ownership. A
       project relation refresh replaces normalized asset rows atomically and
       must never erase a valid cross-aggregate grant during that refresh. */
    unitOfWork.database.exec(`CREATE TABLE image_workflow_asset_grants(
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      from_owner_kind TEXT NOT NULL,
      from_owner_id TEXT NOT NULL,
      to_owner_kind TEXT NOT NULL,
      to_owner_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('render','template_use','project_reuse')),
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_workflow_asset_grants_target ON image_workflow_asset_grants(to_owner_kind, to_owner_id, revoked_at, created_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_workflow_asset_grant_commands(
      aggregate_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(aggregate_id, idempotency_key)
    )`)

    unitOfWork.database.exec(`CREATE TABLE image_campaigns(
      id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 0),
      state TEXT NOT NULL CHECK(state IN ('draft','confirmed','running','completed','cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_campaigns_owner ON image_campaigns(owner_kind, owner_id, updated_at DESC)')
    unitOfWork.database.exec(`CREATE TABLE image_campaign_items(
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES image_campaigns(id),
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      project_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('draft','queued','running','ready','failed','cancelled')),
      attempt INTEGER NOT NULL CHECK(attempt >= 1),
      updated_at TEXT NOT NULL,
      document_json TEXT NOT NULL,
      UNIQUE(campaign_id, ordinal)
    )`)
    unitOfWork.database.exec('CREATE INDEX image_campaign_items_campaign_state ON image_campaign_items(campaign_id, state, ordinal)')
    unitOfWork.database.exec(`CREATE TABLE image_campaign_estimates(
      estimate_hash TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES image_campaigns(id),
      campaign_revision INTEGER NOT NULL CHECK(campaign_revision >= 0),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec('CREATE INDEX image_campaign_estimates_expiry ON image_campaign_estimates(campaign_id, expires_at)')
    unitOfWork.database.exec(`CREATE TABLE image_campaign_confirmations(
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES image_campaigns(id),
      campaign_revision INTEGER NOT NULL CHECK(campaign_revision >= 0),
      estimate_hash TEXT NOT NULL REFERENCES image_campaign_estimates(estimate_hash),
      created_at TEXT NOT NULL,
      document_json TEXT NOT NULL
    )`)
    unitOfWork.database.exec(`CREATE TABLE image_campaign_commands(
      campaign_id TEXT NOT NULL REFERENCES image_campaigns(id),
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id, idempotency_key)
    )`)
    unitOfWork.database.query('INSERT INTO image_metadata_schema_migrations(version,applied_at) VALUES(?,?)')
      .run(10, new Date().toISOString())
  })
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
