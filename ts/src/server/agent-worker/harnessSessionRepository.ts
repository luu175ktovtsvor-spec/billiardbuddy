import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseProductHarnessMessages, type ProductHarnessMessage } from '../../../shared/product/harnessMessages.js'
import { syncParentDirectory } from '../../utils/durableFile.js'
import { lock } from '../../utils/lockfile.js'

const MAX_SESSION_BYTES = 64 * 1024 * 1024

export type ProductHarnessSessionBinding = {
  storage_dir: string
  binding_id: string
  lineage_id: string
}

type ProductHarnessSession = {
  version: 2
  binding_id: string
  lineage_id: string
  context_prefix: string
  messages: ProductHarnessMessage[]
  run_id?: string
  instruction_digest?: string
  instruction_prompt?: string | null
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
  const session = value as Partial<ProductHarnessSession>
  if (
    session.version !== 2
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
  ) throw new Error('HARNESS_SESSION_INVALID')
  return { ...session, messages: parseProductHarnessMessages(session.messages) } as ProductHarnessSession
}

export class ProductHarnessSessionRepository {
  async load(binding: ProductHarnessSessionBinding): Promise<{
    context_prefix: string
    messages: ProductHarnessMessage[]
    run_id?: string
    instruction_digest?: string
    instruction_prompt?: string | null
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
    }
  }

  async save(binding: ProductHarnessSessionBinding, value: {
    context_prefix: string
    messages: readonly ProductHarnessMessage[]
    run_id: string
    instruction_digest: string
    instruction_prompt: string | null
  }): Promise<void> {
    const session: ProductHarnessSession = {
      version: 2,
      binding_id: binding.binding_id,
      lineage_id: binding.lineage_id,
      context_prefix: value.context_prefix,
      messages: [...value.messages],
      run_id: value.run_id,
      instruction_digest: value.instruction_digest,
      instruction_prompt: value.instruction_prompt,
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
