import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { CodexEngineThreadStore } from './codexEngineThreadStore.js'

/** Must move with the verified third_party/codex-engine submodule revision. */
export const CODEX_ENGINE_SOURCE_REVISION = 'ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff'

export type CodexEnginePrivateState = {
  engine_home: string
  thread_storage_dir: string
  binding_id: string
  lineage_id: string
  source_revision: string
}

function isBindingPart(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,512}$/.test(value)
}

function privateIdentity(bindingId: string, lineageId: string): string {
  if (!isBindingPart(bindingId) || !isBindingPart(lineageId)) throw new Error('CODEX_ENGINE_PRIVATE_STATE_INVALID')
  return createHash('sha256').update(`${bindingId}\0${lineageId}`).digest('hex')
}

/**
 * Computes BilliardBuddy-owned paths only. Neither the upstream engine nor a
 * renderer can choose this location or point it at a user's Codex profile.
 */
export function codexEnginePrivateState(storagePath: string, bindingId: string, lineageId: string): CodexEnginePrivateState {
  if (!path.isAbsolute(storagePath)) throw new Error('CODEX_ENGINE_PRIVATE_STATE_INVALID')
  const root = path.join(path.dirname(storagePath), 'product-codex-engine')
  const identity = privateIdentity(bindingId, lineageId)
  return {
    engine_home: path.join(root, 'homes', identity),
    thread_storage_dir: path.join(root, 'threads'),
    binding_id: bindingId,
    lineage_id: lineageId,
    source_revision: CODEX_ENGINE_SOURCE_REVISION,
  }
}

/** Called only by product-task deletion after authority ownership is resolved. */
export async function purgeCodexEnginePrivateState(storagePath: string, bindingId: string, lineageId: string): Promise<void> {
  const state = codexEnginePrivateState(storagePath, bindingId, lineageId)
  await new CodexEngineThreadStore().purge({
    storage_dir: state.thread_storage_dir,
    binding_id: state.binding_id,
    lineage_id: state.lineage_id,
  })
  await fs.rm(state.engine_home, { recursive: true, force: true })
}
