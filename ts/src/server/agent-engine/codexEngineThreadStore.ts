import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { syncParentDirectory } from '../../utils/durableFile.js'
import { lock } from '../../utils/lockfile.js'

const MAX_THREAD_BINDING_BYTES = 16 * 1024

/**
 * BilliardBuddy owns this binding. The Codex engine may persist its own
 * thread cache, but never becomes the product's authority for which task,
 * Run, or Turn it belongs to.
 */
export type CodexEngineThreadBinding = {
  storage_dir: string
  binding_id: string
  lineage_id: string
}

export type CodexEngineThreadState = {
  /** Absent only while a declared tool surface awaits the first source Turn. */
  thread_id?: string
  source_revision: string
  /** Product-owned identity of the declared dynamic source-tool surface. */
  tool_surface_digest?: string
  tool_surface_count?: number
  last_run_id?: string
  last_turn_id?: string
  /** Product receipt for the accepted source `turn/start`, never source state. */
  last_turn_operation_id?: string
  /** Product receipt for the attachment-derived input admitted to that Turn. */
  last_input_run_id?: string
  last_input_operation_id?: string
  last_input_result_digest?: string
  /** Product receipt for the latest user steer admitted to the active Turn. */
  last_steer_run_id?: string
  last_steer_operation_id?: string
  last_steer_queue_item_id?: string
  last_steer_input_digest?: string
  /** Product receipt for the last model result admitted into that Turn. */
  last_model_run_id?: string
  last_model_operation_id?: string
  last_model_result_digest?: string
  /** Product receipt for the last dynamic tool result returned to the source. */
  last_tool_run_id?: string
  last_tool_operation_id?: string
  last_tool_call_id?: string
  last_tool_result_digest?: string
  /** Product receipt for the latest completed lifecycle Hook effect. */
  last_hook_run_id?: string
  last_hook_operation_id?: string
  last_hook_result_digest?: string
  updated_at: string
}

type StoredCodexEngineThreadState = CodexEngineThreadState & {
  version: 1
  binding_id: string
  lineage_id: string
}

export type CodexEngineThreadCheckpoint = {
  state: CodexEngineThreadState
  checkpoint_digest: string
}

function isNonEmptyText(value: unknown, limit = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function threadStatePath(binding: CodexEngineThreadBinding): string {
  const identity = createHash('sha256')
    .update(`${binding.binding_id}\0${binding.lineage_id}`)
    .digest('hex')
  return path.join(binding.storage_dir, `${identity}.json`)
}

function checkpointDigest(state: StoredCodexEngineThreadState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^effect_[a-f0-9-]{36}$/.test(value)
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isQueueItemId(value: unknown): value is string {
  return typeof value === 'string' && /^queue_[a-f0-9-]{36}$/.test(value)
}

async function ensureStorageDirectory(storageDir: string): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(storageDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
}

async function withBindingLock<T>(binding: CodexEngineThreadBinding, operation: () => Promise<T>): Promise<T> {
  await ensureStorageDirectory(binding.storage_dir)
  const filePath = threadStatePath(binding)
  const guard = `${filePath}.guard`
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

function validateBinding(binding: CodexEngineThreadBinding): void {
  if (!binding.storage_dir || !isNonEmptyText(binding.binding_id) || !isNonEmptyText(binding.lineage_id)) {
    throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
  }
}

function validateState(value: unknown, binding: CodexEngineThreadBinding): CodexEngineThreadState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
  const state = value as Partial<StoredCodexEngineThreadState>
  const hasThread = state.thread_id !== undefined
  const hasToolSurface = state.tool_surface_digest !== undefined || state.tool_surface_count !== undefined
  const hasTurnOperation = state.last_turn_operation_id !== undefined
  const inputReceiptCount = [state.last_input_run_id, state.last_input_operation_id, state.last_input_result_digest]
    .filter(value => value !== undefined).length
  const steerReceiptCount = [state.last_steer_run_id, state.last_steer_operation_id, state.last_steer_queue_item_id, state.last_steer_input_digest]
    .filter(value => value !== undefined).length
  const modelReceiptCount = [state.last_model_run_id, state.last_model_operation_id, state.last_model_result_digest]
    .filter(value => value !== undefined).length
  const toolReceiptCount = [state.last_tool_run_id, state.last_tool_operation_id, state.last_tool_call_id, state.last_tool_result_digest]
    .filter(value => value !== undefined).length
  const hookReceiptCount = [state.last_hook_run_id, state.last_hook_operation_id, state.last_hook_result_digest]
    .filter(value => value !== undefined).length
  if (
    state.version !== 1
    || state.binding_id !== binding.binding_id
    || state.lineage_id !== binding.lineage_id
    || (state.thread_id !== undefined && !isNonEmptyText(state.thread_id))
    || !/^[a-f0-9]{40}$/.test(String(state.source_revision ?? ''))
    || (hasToolSurface && (!isDigest(state.tool_surface_digest) || !Number.isSafeInteger(state.tool_surface_count) || state.tool_surface_count! < 0 || state.tool_surface_count! > 256))
    || (state.last_run_id !== undefined && !isNonEmptyText(state.last_run_id))
    || (state.last_turn_id !== undefined && !isNonEmptyText(state.last_turn_id))
    || (state.last_turn_operation_id !== undefined && !isOperationId(state.last_turn_operation_id))
    || (state.last_input_run_id !== undefined && !isNonEmptyText(state.last_input_run_id))
    || (state.last_input_operation_id !== undefined && !isOperationId(state.last_input_operation_id))
    || (state.last_input_result_digest !== undefined && !isDigest(state.last_input_result_digest))
    || (state.last_steer_run_id !== undefined && !isNonEmptyText(state.last_steer_run_id))
    || (state.last_steer_operation_id !== undefined && !isOperationId(state.last_steer_operation_id))
    || (state.last_steer_queue_item_id !== undefined && !isQueueItemId(state.last_steer_queue_item_id))
    || (state.last_steer_input_digest !== undefined && !isDigest(state.last_steer_input_digest))
    || (state.last_model_run_id !== undefined && !isNonEmptyText(state.last_model_run_id))
    || (state.last_model_operation_id !== undefined && !isOperationId(state.last_model_operation_id))
    || (state.last_model_result_digest !== undefined && !isDigest(state.last_model_result_digest))
    || (hasTurnOperation && (!state.last_run_id || !state.last_turn_id))
    || (inputReceiptCount !== 0 && inputReceiptCount !== 3)
    || (inputReceiptCount === 3 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_input_run_id !== state.last_run_id))
    || (steerReceiptCount !== 0 && steerReceiptCount !== 4)
    || (steerReceiptCount === 4 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_steer_run_id !== state.last_run_id))
    || (modelReceiptCount !== 0 && modelReceiptCount !== 3)
    || (modelReceiptCount === 3 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_model_run_id !== state.last_run_id))
    || (toolReceiptCount !== 0 && toolReceiptCount !== 4)
    || (toolReceiptCount === 4 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_tool_run_id !== state.last_run_id || !isOperationId(state.last_tool_operation_id) || !isNonEmptyText(state.last_tool_call_id) || !isDigest(state.last_tool_result_digest)))
    || (hookReceiptCount !== 0 && hookReceiptCount !== 3)
    || (hookReceiptCount === 3 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_hook_run_id !== state.last_run_id || !isOperationId(state.last_hook_operation_id) || !isDigest(state.last_hook_result_digest)))
    || (!hasThread && (state.last_run_id !== undefined || state.last_turn_id !== undefined || state.last_turn_operation_id !== undefined || inputReceiptCount !== 0 || steerReceiptCount !== 0 || modelReceiptCount !== 0 || toolReceiptCount !== 0 || hookReceiptCount !== 0))
    || !isNonEmptyText(state.updated_at, 128)
    || !Number.isFinite(Date.parse(state.updated_at))
  ) throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
  return {
    ...(state.thread_id ? { thread_id: state.thread_id } : {}),
    source_revision: state.source_revision!,
    ...(state.tool_surface_digest ? { tool_surface_digest: state.tool_surface_digest, tool_surface_count: state.tool_surface_count! } : {}),
    ...(state.last_run_id ? { last_run_id: state.last_run_id } : {}),
    ...(state.last_turn_id ? { last_turn_id: state.last_turn_id } : {}),
    ...(state.last_turn_operation_id ? { last_turn_operation_id: state.last_turn_operation_id } : {}),
    ...(state.last_input_run_id ? { last_input_run_id: state.last_input_run_id } : {}),
    ...(state.last_input_operation_id ? { last_input_operation_id: state.last_input_operation_id } : {}),
    ...(state.last_input_result_digest ? { last_input_result_digest: state.last_input_result_digest } : {}),
    ...(state.last_steer_run_id ? { last_steer_run_id: state.last_steer_run_id } : {}),
    ...(state.last_steer_operation_id ? { last_steer_operation_id: state.last_steer_operation_id } : {}),
    ...(state.last_steer_queue_item_id ? { last_steer_queue_item_id: state.last_steer_queue_item_id } : {}),
    ...(state.last_steer_input_digest ? { last_steer_input_digest: state.last_steer_input_digest } : {}),
    ...(state.last_model_run_id ? { last_model_run_id: state.last_model_run_id } : {}),
    ...(state.last_model_operation_id ? { last_model_operation_id: state.last_model_operation_id } : {}),
    ...(state.last_model_result_digest ? { last_model_result_digest: state.last_model_result_digest } : {}),
    ...(state.last_tool_run_id ? { last_tool_run_id: state.last_tool_run_id } : {}),
    ...(state.last_tool_operation_id ? { last_tool_operation_id: state.last_tool_operation_id } : {}),
    ...(state.last_tool_call_id ? { last_tool_call_id: state.last_tool_call_id } : {}),
    ...(state.last_tool_result_digest ? { last_tool_result_digest: state.last_tool_result_digest } : {}),
    ...(state.last_hook_run_id ? { last_hook_run_id: state.last_hook_run_id } : {}),
    ...(state.last_hook_operation_id ? { last_hook_operation_id: state.last_hook_operation_id } : {}),
    ...(state.last_hook_result_digest ? { last_hook_result_digest: state.last_hook_result_digest } : {}),
    updated_at: state.updated_at,
  }
}

/** Durable BilliardBuddy-side task-session -> Codex Thread association. */
export class CodexEngineThreadStore {
  async load(binding: CodexEngineThreadBinding): Promise<CodexEngineThreadState | undefined> {
    validateBinding(binding)
    return await withBindingLock(binding, async () => {
      const filePath = threadStatePath(binding)
      const stat = await fs.lstat(filePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (!stat) return undefined
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_THREAD_BINDING_BYTES) {
        throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
      }
      return validateState(JSON.parse(await fs.readFile(filePath, 'utf8')), binding)
    })
  }

  async save(binding: CodexEngineThreadBinding, state: Omit<CodexEngineThreadState, 'updated_at'>): Promise<CodexEngineThreadCheckpoint> {
    validateBinding(binding)
    const hasThread = state.thread_id !== undefined
    const hasToolSurface = state.tool_surface_digest !== undefined || state.tool_surface_count !== undefined
    const hasTurnOperation = state.last_turn_operation_id !== undefined
    const inputReceiptCount = [state.last_input_run_id, state.last_input_operation_id, state.last_input_result_digest]
      .filter(value => value !== undefined).length
    const steerReceiptCount = [state.last_steer_run_id, state.last_steer_operation_id, state.last_steer_queue_item_id, state.last_steer_input_digest]
      .filter(value => value !== undefined).length
    const modelReceiptCount = [state.last_model_run_id, state.last_model_operation_id, state.last_model_result_digest]
      .filter(value => value !== undefined).length
    const toolReceiptCount = [state.last_tool_run_id, state.last_tool_operation_id, state.last_tool_call_id, state.last_tool_result_digest]
      .filter(value => value !== undefined).length
    const hookReceiptCount = [state.last_hook_run_id, state.last_hook_operation_id, state.last_hook_result_digest]
      .filter(value => value !== undefined).length
    if (
      (state.thread_id !== undefined && !isNonEmptyText(state.thread_id))
      || !/^[a-f0-9]{40}$/.test(state.source_revision)
      || (hasToolSurface && (!isDigest(state.tool_surface_digest) || !Number.isSafeInteger(state.tool_surface_count) || state.tool_surface_count! < 0 || state.tool_surface_count! > 256))
      || (state.last_run_id !== undefined && !isNonEmptyText(state.last_run_id))
      || (state.last_turn_id !== undefined && !isNonEmptyText(state.last_turn_id))
      || (state.last_turn_operation_id !== undefined && !isOperationId(state.last_turn_operation_id))
      || (state.last_input_run_id !== undefined && !isNonEmptyText(state.last_input_run_id))
      || (state.last_input_operation_id !== undefined && !isOperationId(state.last_input_operation_id))
      || (state.last_input_result_digest !== undefined && !isDigest(state.last_input_result_digest))
      || (state.last_steer_run_id !== undefined && !isNonEmptyText(state.last_steer_run_id))
      || (state.last_steer_operation_id !== undefined && !isOperationId(state.last_steer_operation_id))
      || (state.last_steer_queue_item_id !== undefined && !isQueueItemId(state.last_steer_queue_item_id))
      || (state.last_steer_input_digest !== undefined && !isDigest(state.last_steer_input_digest))
      || (state.last_model_run_id !== undefined && !isNonEmptyText(state.last_model_run_id))
      || (state.last_model_operation_id !== undefined && !isOperationId(state.last_model_operation_id))
      || (state.last_model_result_digest !== undefined && !isDigest(state.last_model_result_digest))
      || (hasTurnOperation && (!state.last_run_id || !state.last_turn_id))
      || (inputReceiptCount !== 0 && inputReceiptCount !== 3)
      || (inputReceiptCount === 3 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_input_run_id !== state.last_run_id))
      || (steerReceiptCount !== 0 && steerReceiptCount !== 4)
      || (steerReceiptCount === 4 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_steer_run_id !== state.last_run_id))
      || (modelReceiptCount !== 0 && modelReceiptCount !== 3)
      || (modelReceiptCount === 3 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_model_run_id !== state.last_run_id))
      || (toolReceiptCount !== 0 && toolReceiptCount !== 4)
      || (toolReceiptCount === 4 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_tool_run_id !== state.last_run_id || !isOperationId(state.last_tool_operation_id) || !isNonEmptyText(state.last_tool_call_id) || !isDigest(state.last_tool_result_digest)))
      || (hookReceiptCount !== 0 && hookReceiptCount !== 3)
      || (hookReceiptCount === 3 && (!hasThread || !state.last_run_id || !state.last_turn_id || state.last_hook_run_id !== state.last_run_id || !isOperationId(state.last_hook_operation_id) || !isDigest(state.last_hook_result_digest)))
      || (!hasThread && (state.last_run_id !== undefined || state.last_turn_id !== undefined || state.last_turn_operation_id !== undefined || inputReceiptCount !== 0 || steerReceiptCount !== 0 || modelReceiptCount !== 0 || toolReceiptCount !== 0 || hookReceiptCount !== 0))
    ) throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
    return await withBindingLock(binding, async () => {
      const saved: StoredCodexEngineThreadState = {
        version: 1,
        binding_id: binding.binding_id,
        lineage_id: binding.lineage_id,
        ...state,
        updated_at: new Date().toISOString(),
      }
      const filePath = threadStatePath(binding)
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`
      const body = `${JSON.stringify(saved)}\n`
      if (Buffer.byteLength(body) > MAX_THREAD_BINDING_BYTES) throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
      const handle = await fs.open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(body, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await fs.rename(temporaryPath, filePath)
        await syncParentDirectory(filePath)
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
      return { state: validateState(saved, binding), checkpoint_digest: checkpointDigest(saved) }
    })
  }

  async purge(binding: CodexEngineThreadBinding): Promise<void> {
    validateBinding(binding)
    await withBindingLock(binding, async () => {
      await fs.rm(threadStatePath(binding), { force: true })
    })
  }
}
