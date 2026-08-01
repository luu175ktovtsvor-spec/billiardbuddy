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
  thread_id: string
  source_revision: string
  last_run_id?: string
  last_turn_id?: string
  updated_at: string
}

type StoredCodexEngineThreadState = CodexEngineThreadState & {
  version: 1
  binding_id: string
  lineage_id: string
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
  if (
    state.version !== 1
    || state.binding_id !== binding.binding_id
    || state.lineage_id !== binding.lineage_id
    || !isNonEmptyText(state.thread_id)
    || !/^[a-f0-9]{40}$/.test(String(state.source_revision ?? ''))
    || (state.last_run_id !== undefined && !isNonEmptyText(state.last_run_id))
    || (state.last_turn_id !== undefined && !isNonEmptyText(state.last_turn_id))
    || !isNonEmptyText(state.updated_at, 128)
    || !Number.isFinite(Date.parse(state.updated_at))
  ) throw new Error('CODEX_ENGINE_THREAD_STORE_INVALID')
  return {
    thread_id: state.thread_id,
    source_revision: state.source_revision!,
    ...(state.last_run_id ? { last_run_id: state.last_run_id } : {}),
    ...(state.last_turn_id ? { last_turn_id: state.last_turn_id } : {}),
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

  async save(binding: CodexEngineThreadBinding, state: Omit<CodexEngineThreadState, 'updated_at'>): Promise<CodexEngineThreadState> {
    validateBinding(binding)
    if (
      !isNonEmptyText(state.thread_id)
      || !/^[a-f0-9]{40}$/.test(state.source_revision)
      || (state.last_run_id !== undefined && !isNonEmptyText(state.last_run_id))
      || (state.last_turn_id !== undefined && !isNonEmptyText(state.last_turn_id))
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
      return validateState(saved, binding)
    })
  }
}
