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
}

type OutboxRecord = {
  state: 'pending' | 'reconciled' | 'failed'
  error?: string
}

export type AuthorityFile = {
  version: 1
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
  }>
  outbox: Record<string, OutboxRecord>
  prepared: Record<string, PreparedIntent>
  provenance: Record<string, {
    version: 1 | 3 | 4
    store_digest: string
    record_digest: string
  }>
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
  exactKeys(task, ['id', 'projectId', 'directoryId', 'workDir', 'title', 'lifecycle', 'kind', 'createdAt', 'updatedAt', 'worktreeState', 'actions'], ['pinnedAt', 'archivedAt', 'parentTaskId', 'coreSessionId'])
  for (const key of ['id', 'createdAt', 'updatedAt', 'worktreeState']) if (!requiredString(task[key])) invalid()
  if (typeof task.projectId !== 'string' || typeof task.directoryId !== 'string' || typeof task.workDir !== 'string') invalid()
  if (typeof task.title !== 'string') invalid()
  if (!['active', 'archived'].includes(task.lifecycle as string) || !['main', 'continuation'].includes(task.kind as string) || !['not_requested', 'planned', 'materialized'].includes(task.worktreeState as string) || !isTimestamp(task.createdAt) || !isTimestamp(task.updatedAt) || !Array.isArray(task.actions) || task.actions.some(action => !['pin', 'unpin', 'rename', 'continue', 'archive', 'restore'].includes(action as string))) invalid()
  for (const key of ['pinnedAt', 'archivedAt'] as const) if (task[key] !== undefined && !isTimestamp(task[key])) invalid()
  if (task.parentTaskId !== undefined && !requiredString(task.parentTaskId)) invalid()
  if (task.coreSessionId !== undefined && !requiredString(task.coreSessionId)) invalid()
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

function validateReceipt(value: unknown, key: string): void {
  const receipt = object(value)
  exactKeys(receipt, ['client_operation_id', 'expected_revision', 'outcome', 'revision'], ['result', 'error'])
  if (receipt.client_operation_id !== key || !Number.isSafeInteger(receipt.expected_revision) || (receipt.expected_revision as number) < 0 || !Number.isSafeInteger(receipt.revision) || (receipt.revision as number) < 0 || !['accepted', 'duplicate', 'conflict', 'rejected'].includes(receipt.outcome as string)) invalid()
  if (receipt.error !== undefined && !['AUTHORITY_INVALID', 'AUTHORITY_CONFLICT', 'LEGACY_SOURCE_CHANGED', 'OPERATION_REJECTED'].includes(receipt.error as string)) invalid()
  if (receipt.result !== undefined) { const result = object(receipt.result); if (receipt.outcome === 'accepted') { if ('status' in result) sideValue(result, result.id as string); else taskRecord(result) } else exactKeys(result, []) }
}

function validateIntent(value: unknown, key: string): void {
  const intent = object(value)
  exactKeys(intent, ['client_operation_id', 'product_task_id', 'kind', 'canonical_input', 'expected_revision'])
  if (intent.client_operation_id !== key || typeof intent.product_task_id !== 'string' || !intent.product_task_id || typeof intent.canonical_input !== 'string' || !['create', 'branch', 'close', 'rename', 'metadata'].includes(intent.kind as string) || !Number.isSafeInteger(intent.expected_revision) || (intent.expected_revision as number) < 0) invalid()
  assertAuthorityMapKey(intent.product_task_id)
}

function validate(file: AuthorityFile): AuthorityFile {
  if (file.version !== 1 || !Number.isSafeInteger(file.revision) || file.revision < 0 || !Number.isSafeInteger(file.event_sequence) || file.event_sequence < 0) invalid()
  const maps = ['tasks', 'side_tasks', 'bindings', 'receipts', 'events', 'outbox', 'prepared', 'provenance'] as const
  for (const name of maps) map(file[name])
  for (const [key, value] of Object.entries(file.tasks)) { assertAuthorityMapKey(key); taskValue(value) }
  for (const [key, value] of Object.entries(file.side_tasks)) { assertAuthorityMapKey(key); sideValue(value, key) }
  for (const [key, value] of Object.entries(file.bindings)) { assertAuthorityMapKey(key); const record = object(value); if ('coreSessionId' in record) bindingRecord(record); else taskValue(record) }
  for (const [key, value] of Object.entries(file.receipts)) validateReceipt(value, key)
  for (const [key, value] of Object.entries(file.prepared)) validateIntent(value, key)
  for (const [key, value] of Object.entries(file.events)) { const event = object(value); exactKeys(event, ['event_sequence', 'client_operation_id', 'kind', 'revision'], ['canonical_input']); if (event.client_operation_id !== key || !Number.isSafeInteger(event.event_sequence) || (event.event_sequence as number) < 1 || !Number.isSafeInteger(event.revision) || (event.revision as number) < 0 || typeof event.kind !== 'string' || !event.kind || (event.canonical_input !== undefined && typeof event.canonical_input !== 'string')) invalid() }
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

export class ProductTaskAuthorityRepository {
  constructor(readonly authorityPath: string) {}

  async read(): Promise<AuthorityFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.authorityPath, 'utf8')) as Partial<AuthorityFile>
      const root = object(parsed)
      exactKeys(root, ['version', 'revision', 'event_sequence', 'tasks', 'side_tasks', 'bindings', 'receipts', 'events', 'outbox', 'prepared', 'provenance'])
      return validate(root as AuthorityFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    }
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
      if (file.revision !== intent.expected_revision) throw new Error('AUTHORITY_CONFLICT')
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

  private async write(file: AuthorityFile): Promise<AuthorityFile> {
    validate(file)
    await fs.mkdir(path.dirname(this.authorityPath), { recursive: true })
    const temporaryPath = `${this.authorityPath}.${process.pid}.${randomUUID()}.tmp`
    const handle = await fs.open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(file)}\n`, 'utf8')
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
