import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseProductHarnessMessages, validProductModelOperationReceipt, type ProductHarnessMessage, type ProductModelOperationReceipt } from '../../../shared/product/harnessMessages.js'
import { syncParentDirectory } from '../../utils/durableFile.js'
import { lock } from '../../utils/lockfile.js'

const MAX_SESSION_BYTES = 64 * 1024 * 1024

export type ProductHarnessSessionBinding = {
  storage_dir: string
  binding_id: string
  lineage_id: string
}

type ProductHarnessSession = {
  version: 4
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
}

type ProductHarnessSessionInput = Omit<ProductHarnessSession, 'version' | 'turn_state' | 'operation_receipts'> & {
  version: 2 | 3 | 4
  turn_state?: ProductHarnessSession['turn_state']
  operation_receipts?: ProductModelOperationReceipt[]
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
    (session.version !== 2 && session.version !== 3 && session.version !== 4)
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
  ) throw new Error('HARNESS_SESSION_INVALID')
  if ((session.version === 3 || session.version === 4) && (
    !['preparing', 'active', 'completed'].includes(String(session.turn_state))
    || (session.turn_state !== 'completed' && session.completed_result !== undefined)
    || (session.turn_state === 'completed' && (typeof session.completed_result !== 'string' || session.completed_result.length > 100_000))
    || (session.hook_context !== undefined && (typeof session.hook_context !== 'string' || session.hook_context.length > 40_000))
  )) throw new Error('HARNESS_SESSION_INVALID')
  return {
    ...session,
    version: 4,
    messages: parseProductHarnessMessages(session.messages),
    turn_state: session.version === 3 || session.version === 4 ? session.turn_state! : 'active',
    ...((session.version === 3 || session.version === 4) && session.completed_result !== undefined ? { completed_result: session.completed_result } : {}),
    operation_receipts: session.operation_receipts ?? [],
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
  }): Promise<void> {
    const turnState = value.turn_state ?? 'active'
    if (
      (turnState !== 'completed' && value.completed_result !== undefined)
      || (turnState === 'completed' && (typeof value.completed_result !== 'string' || value.completed_result.length > 100_000))
      || (value.hook_context !== undefined && value.hook_context.length > 40_000)
    ) throw new Error('HARNESS_SESSION_INVALID')
    const session: ProductHarnessSession = {
      version: 4,
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
  }

  async purge(binding: ProductHarnessSessionBinding): Promise<void> {
    await sessionLock(binding, async () => {
      await fs.rm(sessionPath(binding), { force: true })
    })
  }
}
