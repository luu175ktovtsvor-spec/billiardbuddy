import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseProductHarnessMessages, validProductModelOperationReceipt, type ProductHarnessMessage, type ProductModelOperationReceipt } from '../../../shared/product/harnessMessages.js'
import { syncParentDirectory } from '../../utils/durableFile.js'
import { lock } from '../../utils/lockfile.js'
import { TASK_RUN_EXTERNAL_OPERATION_KINDS, type TaskRunExternalOperationKind } from '../product/taskRunLedgerModel.js'

const MAX_SESSION_BYTES = 64 * 1024 * 1024
const MAX_EXTERNAL_OPERATION_CHECKPOINTS = 512
const MAX_ACKNOWLEDGED_OPERATION_RECEIPT_KEYS = 4_096

export type ProductHarnessSessionBinding = {
  storage_dir: string
  binding_id: string
  lineage_id: string
}

type ProductHarnessSession = {
  version: 6
  binding_id: string
  lineage_id: string
  context_prefix: string
  messages: ProductHarnessMessage[]
  run_id?: string
  instruction_digest?: string
  instruction_prompt?: string | null
  turn_state: 'preparing' | 'active' | 'completed'
  hook_context?: string
  completed_result?: string
  operation_receipts: ProductModelOperationReceipt[]
  external_operation_checkpoints: ProductHarnessSessionExternalOperationCheckpoint[]
  acknowledged_operation_receipt_keys: string[]
}

type ProductHarnessSessionInput = Omit<ProductHarnessSession, 'version' | 'turn_state' | 'operation_receipts'> & {
  version: 2 | 3 | 4 | 5 | 6
  turn_state?: ProductHarnessSession['turn_state']
  operation_receipts?: ProductModelOperationReceipt[]
  external_operation_checkpoints?: ProductHarnessSessionExternalOperationCheckpoint[]
  acknowledged_operation_receipt_keys?: string[]
}

export type ProductHarnessSessionExternalOperationCheckpoint = {
  operation_id: string
  kind: TaskRunExternalOperationKind
  /** Never replay a session proof into a later recovered Run generation. */
  dispatch_generation: number
  checkpoint_digest: string
  recorded_at: string
}

export type ProductHarnessSessionExternalOperationCheckpointInput = Pick<
  ProductHarnessSessionExternalOperationCheckpoint,
  'operation_id' | 'kind' | 'dispatch_generation'
>

function isExternalOperationCheckpoint(value: unknown): value is ProductHarnessSessionExternalOperationCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const checkpoint = value as Record<string, unknown>
  return Object.keys(checkpoint).every(key => ['operation_id', 'kind', 'dispatch_generation', 'checkpoint_digest', 'recorded_at'].includes(key))
    && Object.keys(checkpoint).length === 5
    && typeof checkpoint.operation_id === 'string'
    && /^effect_[a-f0-9-]{36}$/.test(checkpoint.operation_id)
    && typeof checkpoint.kind === 'string'
    && (TASK_RUN_EXTERNAL_OPERATION_KINDS as readonly string[]).includes(checkpoint.kind)
    && typeof checkpoint.dispatch_generation === 'number'
    && Number.isSafeInteger(checkpoint.dispatch_generation)
    && checkpoint.dispatch_generation >= 1
    && typeof checkpoint.checkpoint_digest === 'string'
    && /^[a-f0-9]{64}$/.test(checkpoint.checkpoint_digest)
    && typeof checkpoint.recorded_at === 'string'
    && Number.isFinite(Date.parse(checkpoint.recorded_at))
}

/** v5 was an unpublished intermediate format without a generation. It can be
 * read conservatively, but it must never be replayed into a new Worker. */
function isLegacyV5ExternalOperationCheckpoint(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const checkpoint = value as Record<string, unknown>
  return Object.keys(checkpoint).every(key => ['operation_id', 'kind', 'checkpoint_digest', 'recorded_at'].includes(key))
    && Object.keys(checkpoint).length === 4
    && typeof checkpoint.operation_id === 'string'
    && /^effect_[a-f0-9-]{36}$/.test(checkpoint.operation_id)
    && typeof checkpoint.kind === 'string'
    && (TASK_RUN_EXTERNAL_OPERATION_KINDS as readonly string[]).includes(checkpoint.kind)
    && typeof checkpoint.checkpoint_digest === 'string'
    && /^[a-f0-9]{64}$/.test(checkpoint.checkpoint_digest)
    && typeof checkpoint.recorded_at === 'string'
    && Number.isFinite(Date.parse(checkpoint.recorded_at))
}

function isAcknowledgedOperationReceiptKey(value: unknown): value is string {
  return typeof value === 'string' && /^(gateway|personal):[A-Za-z0-9._:-]{8,200}$/.test(value)
}

function checkpointDigest(
  value: Omit<ProductHarnessSession, 'external_operation_checkpoints'>,
  operations: readonly ProductHarnessSessionExternalOperationCheckpointInput[],
): string {
  // The record cannot hash itself. Bind the snapshot to the exact operation
  // identities separately so the durable proof is not a generic opaque hash.
  return createHash('sha256').update(JSON.stringify({
    session: value,
    checkpoint_operations: operations.map(operation => ({
      operation_id: operation.operation_id,
      kind: operation.kind,
      dispatch_generation: operation.dispatch_generation,
    })),
  })).digest('hex')
}

function sessionPath(binding: ProductHarnessSessionBinding): string {
  const identity = createHash('sha256')
    .update(`${binding.binding_id}\0${binding.lineage_id}`)
    .digest('hex')
  return path.join(binding.storage_dir, `${identity}.json`)
}

async function sessionLock<T>(binding: ProductHarnessSessionBinding, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(binding.storage_dir, { recursive: true, mode: 0o700 })
  const guard = `${sessionPath(binding)}.guard`
  const handle = await fs.open(guard, 'a', 0o600)
  await handle.close()
  const release = await lock(guard, {
    stale: 30_000,
    update: 10_000,
    retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
  })
  try {
    return await operation()
  } finally {
    await release()
  }
}

function validateSession(value: unknown, binding: ProductHarnessSessionBinding): ProductHarnessSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HARNESS_SESSION_INVALID')
  const session = value as Partial<ProductHarnessSessionInput>
  if (
    (session.version !== 2 && session.version !== 3 && session.version !== 4 && session.version !== 5 && session.version !== 6)
    || session.binding_id !== binding.binding_id
    || session.lineage_id !== binding.lineage_id
    || typeof session.context_prefix !== 'string'
    || session.context_prefix.length > MAX_SESSION_BYTES
    || !Array.isArray(session.messages)
  ) throw new Error('HARNESS_SESSION_INVALID')
  if (
    (session.run_id !== undefined && (typeof session.run_id !== 'string' || !session.run_id))
    || (session.instruction_digest !== undefined && (typeof session.instruction_digest !== 'string' || !/^[a-f0-9]{64}$/.test(session.instruction_digest)))
    || (session.instruction_prompt !== undefined && session.instruction_prompt !== null && typeof session.instruction_prompt !== 'string')
    || (session.operation_receipts !== undefined && (!Array.isArray(session.operation_receipts) || session.operation_receipts.length > 4_096 || !session.operation_receipts.every(validProductModelOperationReceipt)))
    || (session.external_operation_checkpoints !== undefined && (
      !Array.isArray(session.external_operation_checkpoints)
      || session.external_operation_checkpoints.length > MAX_EXTERNAL_OPERATION_CHECKPOINTS
      || !session.external_operation_checkpoints.every(checkpoint => session.version === 5
        ? isExternalOperationCheckpoint(checkpoint) || isLegacyV5ExternalOperationCheckpoint(checkpoint)
        : isExternalOperationCheckpoint(checkpoint))
      || new Set(session.external_operation_checkpoints.map(checkpoint => (checkpoint as { operation_id?: unknown }).operation_id)).size !== session.external_operation_checkpoints.length
    ))
    || (session.acknowledged_operation_receipt_keys !== undefined && (!Array.isArray(session.acknowledged_operation_receipt_keys) || session.acknowledged_operation_receipt_keys.length > MAX_ACKNOWLEDGED_OPERATION_RECEIPT_KEYS || !session.acknowledged_operation_receipt_keys.every(isAcknowledgedOperationReceiptKey) || new Set(session.acknowledged_operation_receipt_keys).size !== session.acknowledged_operation_receipt_keys.length))
  ) throw new Error('HARNESS_SESSION_INVALID')
  if ((session.version === 3 || session.version === 4 || session.version === 5 || session.version === 6) && (
    !['preparing', 'active', 'completed'].includes(String(session.turn_state))
    || (session.turn_state !== 'completed' && session.completed_result !== undefined)
    || (session.turn_state === 'completed' && (typeof session.completed_result !== 'string' || session.completed_result.length > 100_000))
    || (session.hook_context !== undefined && (typeof session.hook_context !== 'string' || session.hook_context.length > 40_000))
  )) throw new Error('HARNESS_SESSION_INVALID')
  return {
    ...session,
    version: 6,
    messages: parseProductHarnessMessages(session.messages),
    turn_state: session.version === 3 || session.version === 4 || session.version === 5 || session.version === 6 ? session.turn_state! : 'active',
    ...((session.version === 3 || session.version === 4 || session.version === 5 || session.version === 6) && session.completed_result !== undefined ? { completed_result: session.completed_result } : {}),
    operation_receipts: session.operation_receipts ?? [],
    // A v5 proof has no generation. Dropping it from the working projection
    // deliberately prefers `outcome_unknown` over applying it to a new Run.
    external_operation_checkpoints: (session.external_operation_checkpoints ?? []).filter(isExternalOperationCheckpoint),
    acknowledged_operation_receipt_keys: session.acknowledged_operation_receipt_keys ?? [],
  } as ProductHarnessSession
}

export class ProductHarnessSessionRepository {
  async load(binding: ProductHarnessSessionBinding): Promise<{
    context_prefix: string
    messages: ProductHarnessMessage[]
    run_id?: string
    instruction_digest?: string
    instruction_prompt?: string | null
    turn_state: 'preparing' | 'active' | 'completed'
    hook_context?: string
    completed_result?: string
    operation_receipts: ProductModelOperationReceipt[]
    external_operation_checkpoints: ProductHarnessSessionExternalOperationCheckpoint[]
    acknowledged_operation_receipt_keys: string[]
  } | undefined> {
    const filePath = sessionPath(binding)
    const stat = await fs.lstat(filePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) return undefined
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_BYTES) throw new Error('HARNESS_SESSION_INVALID')
    const session = validateSession(JSON.parse(await fs.readFile(filePath, 'utf8')), binding)
    return {
      context_prefix: session.context_prefix,
      messages: session.messages,
      ...(session.run_id ? { run_id: session.run_id } : {}),
      ...(session.instruction_digest ? { instruction_digest: session.instruction_digest } : {}),
      ...(session.instruction_prompt !== undefined ? { instruction_prompt: session.instruction_prompt } : {}),
      turn_state: session.turn_state,
      ...(session.hook_context !== undefined ? { hook_context: session.hook_context } : {}),
      ...(session.completed_result !== undefined ? { completed_result: session.completed_result } : {}),
      operation_receipts: session.operation_receipts,
      external_operation_checkpoints: session.external_operation_checkpoints,
      acknowledged_operation_receipt_keys: session.acknowledged_operation_receipt_keys,
    }
  }

  async save(binding: ProductHarnessSessionBinding, value: {
    context_prefix: string
    messages: readonly ProductHarnessMessage[]
    run_id: string
    instruction_digest: string
    instruction_prompt: string | null
    turn_state?: 'preparing' | 'active' | 'completed'
    hook_context?: string
    completed_result?: string
    operation_receipts: readonly ProductModelOperationReceipt[]
    external_operation_checkpoints?: readonly ProductHarnessSessionExternalOperationCheckpoint[]
    acknowledged_operation_receipt_keys?: readonly string[]
    checkpoint_operations?: readonly ProductHarnessSessionExternalOperationCheckpointInput[]
  }): Promise<{ external_operation_checkpoints: ProductHarnessSessionExternalOperationCheckpoint[] }> {
    const turnState = value.turn_state ?? 'active'
    if (
      (turnState !== 'completed' && value.completed_result !== undefined)
      || (turnState === 'completed' && (typeof value.completed_result !== 'string' || value.completed_result.length > 100_000))
      || (value.hook_context !== undefined && value.hook_context.length > 40_000)
    ) throw new Error('HARNESS_SESSION_INVALID')
    const priorCheckpoints = [...(value.external_operation_checkpoints ?? [])]
    const checkpointOperations = [...(value.checkpoint_operations ?? [])]
    if (
      priorCheckpoints.length > MAX_EXTERNAL_OPERATION_CHECKPOINTS
      || checkpointOperations.length > MAX_EXTERNAL_OPERATION_CHECKPOINTS
      || !priorCheckpoints.every(isExternalOperationCheckpoint)
      || checkpointOperations.some(operation => (
        !/^effect_[a-f0-9-]{36}$/.test(operation.operation_id)
        || !(TASK_RUN_EXTERNAL_OPERATION_KINDS as readonly string[]).includes(operation.kind)
        || !Number.isSafeInteger(operation.dispatch_generation)
        || operation.dispatch_generation < 1
      ))
      || new Set([...priorCheckpoints.map(checkpoint => checkpoint.operation_id), ...checkpointOperations.map(operation => operation.operation_id)]).size !== priorCheckpoints.length + checkpointOperations.length
    ) throw new Error('HARNESS_SESSION_INVALID')
    const acknowledgedOperationReceiptKeys = [...(value.acknowledged_operation_receipt_keys ?? [])]
    if (acknowledgedOperationReceiptKeys.length > MAX_ACKNOWLEDGED_OPERATION_RECEIPT_KEYS || !acknowledgedOperationReceiptKeys.every(isAcknowledgedOperationReceiptKey) || new Set(acknowledgedOperationReceiptKeys).size !== acknowledgedOperationReceiptKeys.length) throw new Error('HARNESS_SESSION_INVALID')
    const base: Omit<ProductHarnessSession, 'external_operation_checkpoints'> = {
      version: 6,
      binding_id: binding.binding_id,
      lineage_id: binding.lineage_id,
      context_prefix: value.context_prefix,
      messages: [...value.messages],
      run_id: value.run_id,
      instruction_digest: value.instruction_digest,
      instruction_prompt: value.instruction_prompt,
      turn_state: turnState,
      ...(value.hook_context !== undefined ? { hook_context: value.hook_context } : {}),
      ...(value.completed_result !== undefined ? { completed_result: value.completed_result } : {}),
      operation_receipts: [...value.operation_receipts],
      acknowledged_operation_receipt_keys: acknowledgedOperationReceiptKeys,
    }
    const recordedAt = new Date().toISOString()
    const digest = checkpointDigest(base, checkpointOperations)
    const freshCheckpoints = checkpointOperations.map(operation => ({
      operation_id: operation.operation_id,
      kind: operation.kind,
      dispatch_generation: operation.dispatch_generation,
      checkpoint_digest: digest,
      recorded_at: recordedAt,
    }))
    const externalOperationCheckpoints = [...priorCheckpoints, ...freshCheckpoints].slice(-MAX_EXTERNAL_OPERATION_CHECKPOINTS)
    const session: ProductHarnessSession = {
      ...base,
      external_operation_checkpoints: externalOperationCheckpoints,
    }
    const serialized = JSON.stringify(session)
    if (Buffer.byteLength(serialized) > MAX_SESSION_BYTES) throw new Error('HARNESS_SESSION_TOO_LARGE')
    await sessionLock(binding, async () => {
      const filePath = sessionPath(binding)
      const existing = await fs.lstat(filePath).catch(error => (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error)
      ))
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('HARNESS_SESSION_INVALID')
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`
      const handle = await fs.open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await fs.rename(temporaryPath, filePath)
        await fs.chmod(filePath, 0o600)
        await syncParentDirectory(filePath)
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      }
    })
    return { external_operation_checkpoints: freshCheckpoints }
  }

  async purge(binding: ProductHarnessSessionBinding): Promise<void> {
    await sessionLock(binding, async () => {
      await fs.rm(sessionPath(binding), { force: true })
    })
  }
}
