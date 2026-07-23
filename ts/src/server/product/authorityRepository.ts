import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { lock } from '../../utils/lockfile.js'
import * as path from 'node:path'
import {
  assertAuthorityMapKey,
  type ProductTaskOperationReceipt,
} from '../../../shared/product/authority.js'

export type LegacyProductTaskSource = {
  version: 1 | 3 | 4
  records: Record<string, unknown>
  storeDigest: string
  recordDigest: (key: string) => string
}

export type PreparedIntent = {
  client_operation_id: string
  product_task_id: string
  kind: 'create' | 'branch' | 'close' | 'rename' | 'metadata'
  canonical_input: string
  expected_revision: number
  /** Entity CAS for task-targeting operations; root revision remains a write fence only. */
  expected_task_revision?: number
  /** Source task owning entity CAS when product_task_id names a newly created branch/side entity. */
  expected_task_id?: string
}

type OutboxRecord = {
  state: 'pending' | 'reconciled' | 'failed'
  error?: string
}

export type WorkspaceRootIdentity = { platform: string; volume_id: string; file_id: string }
export type WorkspaceRecord = {
  workspace_id: string
  installation_id: string
  canonical_root: string
  root_identity: WorkspaceRootIdentity
  revision: number
  availability: 'available' | 'missing' | 'read_only' | 'identity_changed' | 'relink_required'
  created_at: string
  updated_at: string
}

export type AuthorityFile = {
  version: 1
  /** v1 files predate the additive workspace capability maps. */
  authority_schema_revision: 1 | 2 | 3
  revision: number
  event_sequence: number
  tasks: Record<string, unknown>
  side_tasks: Record<string, unknown>
  bindings: Record<string, unknown>
  receipts: Record<string, ProductTaskOperationReceipt>
  events: Record<string, {
    event_sequence: number
    client_operation_id: string
    kind: string
    revision: number
    canonical_input?: string
    entity_id?: string
    product_task_id?: string
    participant_receipts?: unknown
    blocker_error?: unknown
  }>
  outbox: Record<string, OutboxRecord>
  prepared: Record<string, PreparedIntent>
  provenance: Record<string, {
    version: 1 | 3 | 4
    store_digest: string
    record_digest: string
  }>
  workspaces: Record<string, WorkspaceRecord>
  task_scopes: Record<string, unknown>
  composer_drafts: Record<string, unknown>
  task_attachments: Record<string, unknown>
  conversation_lineages: Record<string, unknown>
  thread_entries: Record<string, unknown>
  task_runs: Record<string, unknown>
  dispatch_records: Record<string, unknown>
  task_events: Record<string, unknown>
  attachment_bindings: Record<string, unknown>
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function map(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AUTHORITY_INVALID')
  }
  for (const key of Object.keys(value)) assertAuthorityMapKey(key)
  return value as Record<string, unknown>
}

function empty(): AuthorityFile {
  return {
    version: 1,
    authority_schema_revision: 2,
    revision: 0,
    event_sequence: 0,
    tasks: Object.create(null),
    side_tasks: Object.create(null),
    bindings: Object.create(null),
    receipts: Object.create(null),
    events: Object.create(null),
    outbox: Object.create(null),
    prepared: Object.create(null),
    provenance: Object.create(null),
    workspaces: Object.create(null),
    task_scopes: Object.create(null),
    composer_drafts: Object.create(null),
    task_attachments: Object.create(null),
    conversation_lineages: Object.create(null),
    thread_entries: Object.create(null),
    task_runs: Object.create(null),
    dispatch_records: Object.create(null),
    task_events: Object.create(null),
    attachment_bindings: Object.create(null),
  }
}

function invalid(): never { throw new Error('AUTHORITY_INVALID') }

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function object(value: unknown): Record<string, unknown> {
  return map(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) invalid()
  for (const key of keys) if (!(key in value)) invalid()
}

function requiredString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function taskRecord(value: unknown): void {
  const task = object(value)
  exactKeys(task, ['id', 'projectId', 'directoryId', 'workDir', 'title', 'lifecycle', 'kind', 'createdAt', 'updatedAt', 'worktreeState', 'actions'], ['pinnedAt', 'archivedAt', 'parentTaskId', 'coreSessionId', 'revision', 'task_scope', 'current_lineage_id', 'deletion'])
  for (const key of ['id', 'createdAt', 'updatedAt', 'worktreeState']) if (!requiredString(task[key])) invalid()
  if (typeof task.projectId !== 'string' || typeof task.directoryId !== 'string' || typeof task.workDir !== 'string') invalid()
  if (typeof task.title !== 'string') invalid()
  if (!['active', 'archived', 'deleting', 'delete_failed_pre_purge', 'purge_committed', 'delete_failed_post_purge', 'deleted'].includes(task.lifecycle as string) || !['main', 'continuation'].includes(task.kind as string) || !['not_requested', 'planned', 'materialized'].includes(task.worktreeState as string) || !isTimestamp(task.createdAt) || !isTimestamp(task.updatedAt) || !Array.isArray(task.actions) || task.actions.some(action => !['pin', 'unpin', 'rename', 'continue', 'archive', 'restore'].includes(action as string))) invalid()
  for (const key of ['pinnedAt', 'archivedAt'] as const) if (task[key] !== undefined && !isTimestamp(task[key])) invalid()
  if (task.parentTaskId !== undefined && !requiredString(task.parentTaskId)) invalid()
  if (task.coreSessionId !== undefined && !requiredString(task.coreSessionId)) invalid()
  if (task.revision !== undefined && (!Number.isSafeInteger(task.revision) || (task.revision as number) < 0)) invalid()
  if (task.task_scope !== undefined && typeof task.task_scope !== 'string') invalid()
  if (task.current_lineage_id !== undefined && !requiredString(task.current_lineage_id)) invalid()
  if (task.deletion !== undefined) {
    const deletion = object(task.deletion)
    exactKeys(deletion, ['phase', 'fencing_token', 'cleanup_plan_hash', 'started_at'], ['failed_items', 'tombstone_expires_at'])
    if (!['deleting', 'delete_failed_pre_purge', 'purge_committed', 'delete_failed_post_purge', 'deleted'].includes(deletion.phase as string) || !requiredString(deletion.fencing_token) || !/^[a-f0-9]{64}$/.test(deletion.cleanup_plan_hash as string) || !isTimestamp(deletion.started_at) || (deletion.failed_items !== undefined && (!Array.isArray(deletion.failed_items) || deletion.failed_items.some(item => !requiredString(item))) || (deletion.tombstone_expires_at !== undefined && !isTimestamp(deletion.tombstone_expires_at)))) invalid()
  }
}
function bindingRecord(value: unknown): void {
  const binding = object(value)
  exactKeys(binding, ['coreSessionId'])
  if (!requiredString(binding.coreSessionId)) invalid()
}
function taskValue(value: unknown): void {
  const record = object(value)
  if ('task' in record) { exactKeys(record, ['task', 'binding']); taskRecord(record.task); bindingRecord(record.binding); return }
  // A continuation has no public task metadata; its private branch binding is
  // stored separately from the parent task projection.
  exactKeys(record, ['id', 'kind', 'binding'])
  if (!requiredString(record.id) || (record.kind !== 'continue' && record.kind !== 'side')) invalid()
  bindingRecord(record.binding)
}
function sideValue(value: unknown, key: string): void {
  const side = object(value); exactKeys(side, ['id', 'parentTaskId', 'taskId', 'title', 'status', 'createdAt', 'updatedAt'], ['closedAt'])
  if (side.id !== key || !requiredString(side.parentTaskId) || !requiredString(side.taskId) || typeof side.title !== 'string' || !['open', 'closed'].includes(side.status as string) || !isTimestamp(side.createdAt) || !isTimestamp(side.updatedAt) || (side.closedAt !== undefined && !isTimestamp(side.closedAt))) invalid()
}

function validateParticipantReceipts(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 5) invalid()
  const expected = ['active_core_run', 'queue', 'pty', 'preview', 'workspace_write']
  for (let i = 0; i < expected.length; i++) { const receipt = object(value[i]); if (receipt.participant !== expected[i]) invalid(); if (expected[i] === 'active_core_run') { exactKeys(receipt, ['participant', 'status'], ['code']); if ((receipt.status !== 'CLEAR' && receipt.status !== 'BLOCKED') || (receipt.status === 'BLOCKED' && receipt.code !== 'ACTIVE_RUN') || (receipt.status === 'CLEAR' && receipt.code !== undefined)) invalid() } else { exactKeys(receipt, ['participant', 'status', 'owner_module']); if (receipt.status !== 'OUT_OF_SCOPE_DISABLED' || receipt.owner_module !== 'BB-02C') invalid() } }
}

function validateReceipt(value: unknown, key: string): void {
  const receipt = object(value)
  exactKeys(receipt, ['client_operation_id', 'expected_revision', 'outcome', 'revision'], ['result', 'error'])
  if (receipt.client_operation_id !== key || !Number.isSafeInteger(receipt.expected_revision) || (receipt.expected_revision as number) < 0 || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 0 || !['accepted', 'duplicate', 'conflict', 'rejected'].includes(receipt.outcome as string)) invalid()
  if (receipt.error !== undefined && !['AUTHORITY_INVALID', 'AUTHORITY_CONFLICT', 'LEGACY_SOURCE_CHANGED', 'OPERATION_REJECTED'].includes(receipt.error as string)) invalid()
  if (receipt.result !== undefined) { const result = object(receipt.result); if ('participant_receipts' in result) { exactKeys(result, ['participant_receipts'], ['blocker_error']); validateParticipantReceipts(result.participant_receipts); if (result.blocker_error !== undefined && !['ACTIVE_RUN', 'QUEUE', 'PTY', 'PREVIEW', 'WORKSPACE_WRITE', 'BLOCKER_UNKNOWN', 'BLOCKER_UNAVAILABLE'].includes(result.blocker_error as string)) invalid() } else if ('entity_id' in result) { exactKeys(result, ['entity_id']); if (!requiredString(result.entity_id)) invalid() } else if ('run_id' in result) { exactKeys(result, ['task_id', 'run_id', 'entry_id', 'dispatch_generation', 'authority_revision', 'entity_revisions']); if (!requiredString(result.task_id) || !requiredString(result.run_id) || !requiredString(result.entry_id) || result.dispatch_generation !== 1 || !Number.isSafeInteger(result.authority_revision) || (result.authority_revision as number) < 0 || !result.entity_revisions || typeof result.entity_revisions !== 'object' || Array.isArray(result.entity_revisions) || Object.values(result.entity_revisions as Record<string, unknown>).some(revision => !Number.isSafeInteger(revision) || (revision as number) < 0)) invalid() } else if (receipt.outcome === 'accepted') { if ('status' in result) sideValue(result, result.id as string); else taskRecord(result) } else exactKeys(result, []) }
}

function validateIntent(value: unknown, key: string): void {
  const intent = object(value)
  exactKeys(intent, ['client_operation_id', 'product_task_id', 'kind', 'canonical_input', 'expected_revision'], ['expected_task_revision', 'expected_task_id'])
  if (intent.client_operation_id !== key || typeof intent.product_task_id !== 'string' || !intent.product_task_id || typeof intent.canonical_input !== 'string' || !['create', 'branch', 'close', 'rename', 'metadata'].includes(intent.kind as string) || !Number.isSafeInteger(intent.expected_revision) || (intent.expected_revision as number) < 0 || (intent.expected_task_revision !== undefined && (!Number.isSafeInteger(intent.expected_task_revision) || (intent.expected_task_revision as number) < 0)) || (intent.expected_task_id !== undefined && !requiredString(intent.expected_task_id))) invalid()
  assertAuthorityMapKey(intent.product_task_id)
}

function validateWorkspace(value: unknown, key: string): void {
  const workspace = object(value)
  exactKeys(workspace, ['workspace_id', 'installation_id', 'canonical_root', 'root_identity', 'revision', 'availability', 'created_at', 'updated_at'])
  const identity = object(workspace.root_identity)
  exactKeys(identity, ['platform', 'volume_id', 'file_id'])
  if (workspace.workspace_id !== key || !requiredString(workspace.installation_id) || !requiredString(workspace.canonical_root)
    || !requiredString(identity.platform) || !requiredString(identity.volume_id) || !requiredString(identity.file_id)
    || !Number.isSafeInteger(workspace.revision) || (workspace.revision as number) < 0
    || !isTimestamp(workspace.created_at) || !isTimestamp(workspace.updated_at)
    || !['available', 'missing', 'read_only', 'identity_changed', 'relink_required'].includes(workspace.availability as string)) invalid()
}

function validateDraft(value: unknown, key: string): void {
  const draft = object(value); exactKeys(draft, ['draft_id', 'installation_id', 'target_task_id', 'revision', 'last_activity', 'state', 'created_at', 'expires_at'], ['workspace_id', 'target_state'])
  if (draft.draft_id !== key || !requiredString(draft.installation_id) || !requiredString(draft.target_task_id) || (draft.target_state !== undefined && !['existing_task', 'pending_task'].includes(draft.target_state as string)) || !Number.isSafeInteger(draft.revision) || (draft.revision as number) < 0 || !['active', 'consumed', 'expired'].includes(draft.state as string) || !isTimestamp(draft.last_activity) || !isTimestamp(draft.created_at) || !isTimestamp(draft.expires_at) || (draft.workspace_id !== undefined && !requiredString(draft.workspace_id))) invalid()
}
function validateAttachment(value: unknown, key: string): void {
  const attachment = object(value); exactKeys(attachment, ['attachment_id', 'installation_id', 'owner_kind', 'owner_id', 'source_fingerprint', 'content_hash', 'verified_media_type', 'storage_kind', 'byte_size', 'state', 'refs', 'created_at', 'last_activity', 'expires_at', 'revision'])
  if (attachment.attachment_id !== key || !requiredString(attachment.installation_id) || !['composer_draft', 'product_task'].includes(attachment.owner_kind as string) || !requiredString(attachment.owner_id) || !/^[a-f0-9]{64}$/.test(attachment.source_fingerprint as string) || !/^[a-f0-9]{64}$/.test(attachment.content_hash as string) || !requiredString(attachment.verified_media_type) || !['external_reference', 'app_owned_copy'].includes(attachment.storage_kind as string) || !Number.isSafeInteger(attachment.byte_size) || (attachment.byte_size as number) < 0 || !['staged', 'inspecting', 'ready', 'accepted_bound', 'failed', 'cancelled', 'discarded'].includes(attachment.state as string) || !Array.isArray(attachment.refs) || attachment.refs.some(ref => !requiredString(ref)) || !isTimestamp(attachment.created_at) || !isTimestamp(attachment.last_activity) || !isTimestamp(attachment.expires_at) || !Number.isSafeInteger(attachment.revision) || (attachment.revision as number) < 0) invalid()
}

function validateLineage(value: unknown, key: string): void {
  const lineage = object(value); exactKeys(lineage, ['lineage_id', 'product_task_id', 'revision', 'compact_generation', 'resume_binding_id', 'state', 'created_at', 'updated_at'], ['parent_lineage_id', 'fork_checkpoint_id', 'head_entry_id'])
  if (lineage.lineage_id !== key || !requiredString(lineage.product_task_id) || !Number.isSafeInteger(lineage.revision) || (lineage.revision as number) < 0 || !Number.isSafeInteger(lineage.compact_generation) || (lineage.compact_generation as number) < 0 || !requiredString(lineage.resume_binding_id) || !['active', 'parked', 'recovery_required'].includes(lineage.state as string) || !isTimestamp(lineage.created_at) || !isTimestamp(lineage.updated_at) || (lineage.parent_lineage_id !== undefined && !requiredString(lineage.parent_lineage_id)) || (lineage.fork_checkpoint_id !== undefined && !requiredString(lineage.fork_checkpoint_id)) || (lineage.head_entry_id !== undefined && !requiredString(lineage.head_entry_id))) invalid()
}

function validate(file: AuthorityFile): AuthorityFile {
  if (file.version !== 1 || !Number.isSafeInteger(file.revision) || file.revision < 0 || !Number.isSafeInteger(file.event_sequence) || file.event_sequence < 0) invalid()
  if (file.authority_schema_revision !== 1 && file.authority_schema_revision !== 2 && file.authority_schema_revision !== 3) throw new Error('UNSUPPORTED_SCHEMA')
  const maps = ['tasks', 'side_tasks', 'bindings', 'receipts', 'events', 'outbox', 'prepared', 'provenance'] as const
  for (const name of maps) map(file[name])
  if (file.authority_schema_revision >= 2) {
    for (const name of ['workspaces', 'task_scopes', 'composer_drafts', 'task_attachments', 'conversation_lineages'] as const) map(file[name])
    for (const [key, value] of Object.entries(file.workspaces)) { assertAuthorityMapKey(key); validateWorkspace(value, key) }
    for (const [key, value] of Object.entries(file.task_scopes)) { const scope = object(value); assertAuthorityMapKey(key); if (scope.kind === 'installation-default') exactKeys(scope, ['kind']); else { exactKeys(scope, ['kind', 'workspace_id', 'generation']); if (scope.kind !== 'workspace' || !requiredString(scope.workspace_id) || !Number.isSafeInteger(scope.generation) || (scope.generation as number) < 0) invalid() } }
    for (const [key, value] of Object.entries(file.composer_drafts)) { assertAuthorityMapKey(key); validateDraft(value, key) }
    for (const [key, value] of Object.entries(file.task_attachments)) { assertAuthorityMapKey(key); validateAttachment(value, key) }
    for (const [key, value] of Object.entries(file.conversation_lineages)) { assertAuthorityMapKey(key); validateLineage(value, key) }
    if (file.authority_schema_revision === 3) {
      for (const name of ['thread_entries', 'task_runs', 'dispatch_records', 'task_events', 'attachment_bindings'] as const) map(file[name])
      for (const [key, value] of Object.entries(file.thread_entries)) { const entry = object(value); assertAuthorityMapKey(key); exactKeys(entry, ['entry_id', 'task_id', 'run_id', 'text', 'created_at']); if (entry.entry_id !== key || !requiredString(entry.task_id) || !requiredString(entry.run_id) || typeof entry.text !== 'string' || !isTimestamp(entry.created_at)) invalid() }
      for (const [key, value] of Object.entries(file.task_runs)) { const run = object(value); assertAuthorityMapKey(key); exactKeys(run, ['run_id', 'task_id', 'lineage_id', 'entry_id', 'created_at', 'execution_capability', 'permission_mode', 'provider', 'model'], ['core_binding']); const binding = run.core_binding === undefined ? undefined : object(run.core_binding); if (binding) exactKeys(binding, ['resume_binding_id', 'session_id', 'work_dir', 'dispatch_generation']); if (run.run_id !== key || !requiredString(run.task_id) || !requiredString(run.lineage_id) || !requiredString(run.entry_id) || !isTimestamp(run.created_at) || !['installation_default_denied', 'workspace_bound'].includes(run.execution_capability as string) || (run.permission_mode !== null && typeof run.permission_mode !== 'string') || (run.provider !== null && typeof run.provider !== 'string') || (run.model !== null && typeof run.model !== 'string') || (binding && (!requiredString(binding.resume_binding_id) || !requiredString(binding.session_id) || typeof binding.work_dir !== 'string' || binding.dispatch_generation !== 1))) invalid() }
      for (const [key, value] of Object.entries(file.dispatch_records)) { const dispatch = object(value); assertAuthorityMapKey(key); exactKeys(dispatch, ['run_id', 'dispatch_generation', 'state'], ['claimed_at', 'started_at', 'completed_at', 'error']); if (dispatch.run_id !== key || dispatch.dispatch_generation !== 1 || !['pending', 'claimed', 'started', 'recovery_required', 'terminal'].includes(dispatch.state as string) || (dispatch.claimed_at !== undefined && !isTimestamp(dispatch.claimed_at)) || (dispatch.started_at !== undefined && !isTimestamp(dispatch.started_at)) || (dispatch.completed_at !== undefined && !isTimestamp(dispatch.completed_at)) || (dispatch.error !== undefined && typeof dispatch.error !== 'string')) invalid() }
      for (const [key, value] of Object.entries(file.task_events)) { const event = object(value); assertAuthorityMapKey(key); exactKeys(event, ['event_sequence', 'task_id', 'run_id', 'type', 'entry_id', 'text', 'attachment_ids', 'created_at']); if (!Number.isSafeInteger(event.event_sequence) || (event.event_sequence as number) < 1 || !requiredString(event.task_id) || !requiredString(event.run_id) || event.type !== 'user_text' || !requiredString(event.entry_id) || typeof event.text !== 'string' || !Array.isArray(event.attachment_ids) || event.attachment_ids.some(id => !requiredString(id)) || !isTimestamp(event.created_at)) invalid() }
      for (const [key, value] of Object.entries(file.attachment_bindings)) { const binding = object(value); assertAuthorityMapKey(key); exactKeys(binding, ['attachment_id', 'task_id', 'run_id', 'entry_id']); if (binding.attachment_id !== key || !requiredString(binding.task_id) || !requiredString(binding.run_id) || !requiredString(binding.entry_id)) invalid() }
    }
  }
  for (const [key, value] of Object.entries(file.tasks)) { assertAuthorityMapKey(key); taskValue(value) }
  for (const [key, value] of Object.entries(file.side_tasks)) { assertAuthorityMapKey(key); sideValue(value, key) }
  for (const [key, value] of Object.entries(file.bindings)) { assertAuthorityMapKey(key); const record = object(value); if ('coreSessionId' in record) bindingRecord(record); else taskValue(record) }
  for (const [key, value] of Object.entries(file.receipts)) validateReceipt(value, key)
  for (const [key, value] of Object.entries(file.prepared)) validateIntent(value, key)
  for (const [key, value] of Object.entries(file.events)) { const event = object(value); exactKeys(event, ['event_sequence', 'client_operation_id', 'kind', 'revision'], ['canonical_input', 'entity_id', 'product_task_id', 'participant_receipts', 'blocker_error']); if (event.client_operation_id !== key || !Number.isSafeInteger(event.event_sequence) || (event.event_sequence as number) < 1 || !Number.isSafeInteger(event.revision) || (event.revision as number) < 0 || typeof event.kind !== 'string' || !event.kind || (event.canonical_input !== undefined && typeof event.canonical_input !== 'string') || (event.entity_id !== undefined && !requiredString(event.entity_id)) || (event.participant_receipts !== undefined && (() => { try { validateParticipantReceipts(event.participant_receipts); return false } catch { return true } })()) || (event.blocker_error !== undefined && !['ACTIVE_RUN', 'QUEUE', 'PTY', 'PREVIEW', 'WORKSPACE_WRITE', 'BLOCKER_UNKNOWN', 'BLOCKER_UNAVAILABLE'].includes(event.blocker_error as string))) invalid() }
  for (const [key, value] of Object.entries(file.outbox)) { const outbox = object(value); exactKeys(outbox, ['state'], ['error']); if (!['pending', 'reconciled', 'failed'].includes(outbox.state as string) || (outbox.error !== undefined && typeof outbox.error !== 'string')) invalid(); assertAuthorityMapKey(key) }
  for (const [key, value] of Object.entries(file.provenance)) { const provenance = object(value); exactKeys(provenance, ['version', 'store_digest', 'record_digest']); if (![1, 3, 4].includes(provenance.version as number) || !/^[a-f0-9]{64}$/.test(provenance.store_digest as string) || !/^[a-f0-9]{64}$/.test(provenance.record_digest as string)) invalid(); assertAuthorityMapKey(key) }
  return file
}
export async function readLegacyProductTasks(sourcePath: string): Promise<LegacyProductTaskSource> {
  const raw = await fs.readFile(sourcePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AUTHORITY_INVALID')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUTHORITY_INVALID')
  }
  const store = parsed as Record<string, unknown>
  if (store.version !== 1 && store.version !== 3 && store.version !== 4) {
    throw new Error('AUTHORITY_INVALID')
  }
  const records = map(store.tasks)
  for (const record of Object.values(records)) map(record)
  return {
    version: store.version,
    records,
    storeDigest: digest(raw),
    recordDigest(key) {
      assertAuthorityMapKey(key)
      if (!(key in records)) throw new Error('AUTHORITY_INVALID')
      return digest(JSON.stringify(records[key]))
    },
  }
}

export type ProductTaskAuthorityRepositoryDeps = {
  /** Test seam invoked after validation and before replacing the authority file. */
  beforeWrite?: () => void | Promise<void>
}

export class ProductTaskAuthorityRepository {
  constructor(readonly authorityPath: string, private readonly deps: ProductTaskAuthorityRepositoryDeps = {}) {}

  async read(): Promise<AuthorityFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.authorityPath, 'utf8')) as Partial<AuthorityFile>
      const root = object(parsed)
      const revision = root.authority_schema_revision
      if (revision !== undefined && revision !== 1 && revision !== 2 && revision !== 3) throw new Error('UNSUPPORTED_SCHEMA')
      if (revision === 3) {
        exactKeys(root, ['version', 'authority_schema_revision', 'revision', 'event_sequence', 'tasks', 'side_tasks', 'bindings', 'receipts', 'events', 'outbox', 'prepared', 'provenance', 'workspaces', 'task_scopes', 'composer_drafts', 'task_attachments', 'conversation_lineages', 'thread_entries', 'task_runs', 'dispatch_records', 'task_events', 'attachment_bindings'])
      } else if (revision === 2) {
        exactKeys(root, ['version', 'authority_schema_revision', 'revision', 'event_sequence', 'tasks', 'side_tasks', 'bindings', 'receipts', 'events', 'outbox', 'prepared', 'provenance', 'workspaces', 'task_scopes', 'composer_drafts', 'task_attachments', 'conversation_lineages'])
        Object.assign(root, { thread_entries: Object.create(null), task_runs: Object.create(null), dispatch_records: Object.create(null), task_events: Object.create(null), attachment_bindings: Object.create(null) })
      } else {
        exactKeys(root, ['version', 'revision', 'event_sequence', 'tasks', 'side_tasks', 'bindings', 'receipts', 'events', 'outbox', 'prepared', 'provenance'], ['authority_schema_revision'])
        // Capability-reader projection only: never write this shape on reads.
        Object.assign(root, {
          authority_schema_revision: 1,
          workspaces: Object.create(null), task_scopes: Object.create(null), composer_drafts: Object.create(null),
          task_attachments: Object.create(null), conversation_lineages: Object.create(null),
          thread_entries: Object.create(null), task_runs: Object.create(null), dispatch_records: Object.create(null), task_events: Object.create(null), attachment_bindings: Object.create(null),
        })
      }
      return validate(root as AuthorityFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    }
  }

  /** BB-02B capability transaction. Root revision fences disk writes only. */
  async mutateCapabilities<T>(mutate: (file: AuthorityFile) => T): Promise<{ file: AuthorityFile; result: T }> {
    return this.lock(async () => {
      const file = await this.read()
      const result = mutate(file)
      file.revision += 1
      return { file: await this.write(file, true), result }
    })
  }

  /** Runs capability identity lookup and mutation under one cross-process lease. */
  async transactCapabilities<T>(mutate: (file: AuthorityFile) => T | { changed: false; value: T }): Promise<{ file: AuthorityFile; result: T }> {
    return this.lock(async () => { const file = await this.read(); const raw = mutate(file); if (raw && typeof raw === 'object' && 'changed' in raw && raw.changed === false) return { file, result: raw.value }; file.revision += 1; return { file: await this.write(file, true), result: raw as T } })
  }

  /** Capability transaction that keeps the cross-process authority lease while awaiting inspection. */
  async transactCapabilitiesAsync<T>(mutate: (file: AuthorityFile) => Promise<T | { changed: false; value: T }>): Promise<{ file: AuthorityFile; result: T }> {
    return this.lock(async () => { const file = await this.read(); const raw = await mutate(file); if (raw && typeof raw === 'object' && 'changed' in raw && raw.changed === false) return { file, result: raw.value }; file.revision += 1; return { file: await this.write(file, true), result: raw as T } })
  }

  /** BB-02C submit transaction: one durable write after all members validate. */
  async transactSubmit<T>(mutate: (file: AuthorityFile) => T | { changed: false; value: T }): Promise<{ file: AuthorityFile; result: T }> {
    return this.lock(async () => {
      const file = await this.read()
      const raw = mutate(file)
      if (raw && typeof raw === 'object' && 'changed' in raw && raw.changed === false) return { file, result: raw.value }
      file.revision += 1
      return { file: await this.write(file, false, true), result: raw as T }
    })
  }

  /** Submit transaction that retains the authority lease while participants inspect state. */
  async transactSubmitAsync<T>(mutate: (file: AuthorityFile) => Promise<T | { changed: false; value: T }>): Promise<{ file: AuthorityFile; result: T }> {
    return this.lock(async () => {
      const file = await this.read()
      const raw = await mutate(file)
      if (raw && typeof raw === 'object' && 'changed' in raw && raw.changed === false) return { file, result: raw.value }
      file.revision += 1
      return { file: await this.write(file, false, true), result: raw as T }
    })
  }

  async compareAndWrite(expected: number, mutate: (file: AuthorityFile) => void): Promise<AuthorityFile> {
    return this.lock(async () => {
      const file = await this.read()
      if (file.revision !== expected) throw new Error('AUTHORITY_CONFLICT')
      mutate(file)
      file.revision += 1
      return this.write(file)
    })
  }

  async reserve(intent: PreparedIntent): Promise<{ file: AuthorityFile; duplicate: boolean }> {
    assertAuthorityMapKey(intent.client_operation_id)
    assertAuthorityMapKey(intent.product_task_id)
    if (!Number.isSafeInteger(intent.expected_revision) || intent.expected_revision < 0) {
      throw new Error('AUTHORITY_INVALID')
    }
    return this.lock(async () => {
      const file = await this.read()
      const prepared = file.prepared[intent.client_operation_id]
      if (prepared) {
        if (JSON.stringify(prepared) !== JSON.stringify(intent)) throw new Error('AUTHORITY_CONFLICT')
        return { file, duplicate: true }
      }
      if (file.receipts[intent.client_operation_id]) {
        if (file.events[intent.client_operation_id]?.canonical_input !== intent.canonical_input) {
          throw new Error('AUTHORITY_CONFLICT')
        }
        return { file, duplicate: true }
      }
      if (intent.expected_task_revision !== undefined) {
        const entityTaskId = intent.expected_task_id ?? intent.product_task_id
        const stored = file.tasks[entityTaskId] as { task?: { revision?: unknown } } | undefined
        const taskRevision = typeof stored?.task?.revision === 'number' ? stored.task.revision : 0
        if (taskRevision !== intent.expected_task_revision) throw new Error('AUTHORITY_CONFLICT')
      } else if (file.revision !== intent.expected_revision) throw new Error('AUTHORITY_CONFLICT')
      file.prepared[intent.client_operation_id] = intent
      file.revision += 1
      return { file: await this.write(file), duplicate: false }
    })
  }

  async finalize(
    operationId: string,
    receipt: ProductTaskOperationReceipt,
    binding?: unknown,
    options: { outbox?: OutboxRecord; sideTask?: unknown } = {},
  ): Promise<AuthorityFile> {
    return this.lock(async () => {
      const file = await this.read()
      if (file.receipts[operationId]) return file
      const intent = file.prepared[operationId]
      if (!intent) throw new Error('AUTHORITY_INVALID')
      file.revision += 1
      file.receipts[operationId] = { ...receipt, revision: file.revision }
      if (binding !== undefined) {
        if (options.sideTask !== undefined) file.bindings[intent.product_task_id] = binding
        else file.tasks[intent.product_task_id] = binding
      }
      if (options.sideTask !== undefined) file.side_tasks[intent.product_task_id] = options.sideTask
      if (options.outbox) file.outbox[operationId] = options.outbox
      delete file.prepared[operationId]
      file.event_sequence += 1
      file.events[operationId] = {
        event_sequence: file.event_sequence,
        client_operation_id: operationId,
        kind: intent.kind,
        revision: file.revision,
        canonical_input: intent.canonical_input,
      }
      return this.write(file)
    })
  }

  async ensureLegacyProjection(taskId: string, source: LegacyProductTaskSource, projection: unknown): Promise<AuthorityFile> {
    assertAuthorityMapKey(taskId)
    return this.lock(async () => {
      const file = await this.read()
      const current = { version: source.version, store_digest: source.storeDigest, record_digest: source.recordDigest(taskId) }
      const previous = file.provenance[taskId]
      if (previous && JSON.stringify(previous) !== JSON.stringify(current)) throw new Error('LEGACY_SOURCE_CHANGED')
      if (file.tasks[taskId]) {
        if (!previous) throw new Error('AUTHORITY_INVALID')
        return file
      }
      if (previous) throw new Error('AUTHORITY_INVALID')
      file.provenance[taskId] = current
      file.tasks[taskId] = projection
      file.revision += 1
      return this.write(file)
    })
  }

  async verifyLegacy(taskId: string, source: LegacyProductTaskSource): Promise<void> {
    assertAuthorityMapKey(taskId)
    return this.lock(async () => {
      const file = await this.read()
      const current = {
        version: source.version,
        store_digest: source.storeDigest,
        record_digest: source.recordDigest(taskId),
      }
      const previous = file.provenance[taskId]
      if (previous && JSON.stringify(previous) !== JSON.stringify(current)) {
        throw new Error('LEGACY_SOURCE_CHANGED')
      }
      if (!previous) {
        file.provenance[taskId] = current
        await this.write(file)
      }
    })
  }

  async setOutbox(
    operationId: string,
    state: OutboxRecord['state'],
    error?: string,
  ): Promise<AuthorityFile> {
    return this.lock(async () => {
      const file = await this.read()
      if (!file.receipts[operationId]) throw new Error('AUTHORITY_INVALID')
      file.outbox[operationId] = { state, ...(error ? { error } : {}) }
      return this.write(file)
    })
  }

  private async write(file: AuthorityFile, upgradeToCapabilities = false, upgradeToSubmit = false): Promise<AuthorityFile> {
    // Rev1 remains byte-compatible for legacy/BB-02A-only writes. Only a real
    // BB-02B entity transaction may persist the additive capability maps.
    if (upgradeToSubmit && file.authority_schema_revision < 3) file.authority_schema_revision = 3
    if (upgradeToCapabilities && file.authority_schema_revision === 1) file.authority_schema_revision = 2
    if (file.authority_schema_revision >= 2) validate(file)
    await this.deps.beforeWrite?.()
    const output: AuthorityFile | Record<string, unknown> = file.authority_schema_revision === 1 && !upgradeToCapabilities
      ? (() => {
          const { authority_schema_revision: _revision, workspaces: _workspaces, task_scopes: _scopes, composer_drafts: _drafts, task_attachments: _attachments, conversation_lineages: _lineages, thread_entries: _entries, task_runs: _runs, dispatch_records: _dispatches, task_events: _events, attachment_bindings: _attachmentBindings, ...legacy } = file
          return legacy
        })()
      : file.authority_schema_revision === 2 && !upgradeToSubmit
        ? (() => { const { thread_entries: _entries, task_runs: _runs, dispatch_records: _dispatches, task_events: _events, attachment_bindings: _attachmentBindings, ...capabilities } = file; return capabilities })()
        : file
    await fs.mkdir(path.dirname(this.authorityPath), { recursive: true })
    const temporaryPath = `${this.authorityPath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await fs.open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(output)}\n`, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await fs.rename(temporaryPath, this.authorityPath)
    const directory = await fs.open(path.dirname(this.authorityPath), fsConstants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
    return file
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    // proper-lockfile uses an atomic mkdir lease and verified release; unlike a
    // hand-rolled stale unlink it cannot delete a successor's lock.
    const guard = `${this.authorityPath}.guard`
    await fs.mkdir(path.dirname(guard), { recursive: true })
    await fs.open(guard, 'a').then(handle => handle.close())
    const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
    try { return await operation() } finally { await release() }
  }
}
