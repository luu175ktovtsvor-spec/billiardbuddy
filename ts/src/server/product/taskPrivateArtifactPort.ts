import * as path from 'node:path'
import { ProductHarnessSessionRepository } from '../agent-worker/harnessSessionRepository.js'
import { ProductAutoMemoryRepository } from '../services/productAutoMemory.js'
import { ProductTaskAuthorityRepository, type ProductTaskAuthorityRepositoryDeps } from './authorityRepository.js'
import {
  productAttachmentStorageRoot,
  purgeProductAttachmentCopies,
} from './taskAttachmentIngest.js'

export type ProductTaskPrivateArtifactPurgeInput = {
  taskId: string
  storagePath: string
  authorityPath: string
  authorityRepositoryDeps: ProductTaskAuthorityRepositoryDeps
}

export type ProductTaskPrivateArtifactPort = {
  purge(input: ProductTaskPrivateArtifactPurgeInput): Promise<void>
}

function harnessSessionStorageDir(storagePath: string): string {
  return path.join(path.dirname(storagePath), 'product-harness-sessions')
}

function autoMemoryStorageDir(storagePath: string): string {
  return path.join(path.dirname(storagePath), 'product-auto-memory')
}

export const productTaskPrivateArtifactPort: ProductTaskPrivateArtifactPort = {
  async purge({ taskId, storagePath, authorityPath, authorityRepositoryDeps }) {
    const state = await new ProductTaskAuthorityRepository(authorityPath, authorityRepositoryDeps).read()
    const lineages = Object.values(state.conversation_lineages)
      .filter(value => (value as { product_task_id?: unknown }).product_task_id === taskId)
      .flatMap(value => {
        const lineage = value as { lineage_id?: unknown; resume_binding_id?: unknown }
        return typeof lineage.lineage_id === 'string' && typeof lineage.resume_binding_id === 'string'
          ? [{ storage_dir: harnessSessionStorageDir(storagePath), binding_id: lineage.resume_binding_id, lineage_id: lineage.lineage_id }]
          : []
      })
    const entryIds = Object.values(state.thread_entries)
      .filter(value => (value as { task_id?: unknown }).task_id === taskId)
      .flatMap(value => typeof (value as { entry_id?: unknown }).entry_id === 'string' ? [(value as { entry_id: string }).entry_id] : [])
    const draftIds = new Set(Object.values(state.composer_drafts)
      .filter(value => (value as { target_task_id?: unknown }).target_task_id === taskId)
      .flatMap(value => typeof (value as { draft_id?: unknown }).draft_id === 'string' ? [(value as { draft_id: string }).draft_id] : []))
    const attachmentIds = Object.entries(state.task_attachments)
      .filter(([, value]) => {
        const attachment = value as { owner_kind?: unknown; owner_id?: unknown }
        return (attachment.owner_kind === 'product_task' && attachment.owner_id === taskId)
          || (attachment.owner_kind === 'composer_draft' && typeof attachment.owner_id === 'string' && draftIds.has(attachment.owner_id))
      })
      .map(([attachmentId]) => attachmentId)
    const harnessSessions = new ProductHarnessSessionRepository()
    await Promise.all([
      ...lineages.map(binding => harnessSessions.purge(binding)),
      new ProductAutoMemoryRepository().purgeTaskTurns(autoMemoryStorageDir(storagePath), taskId, entryIds),
      purgeProductAttachmentCopies(productAttachmentStorageRoot(storagePath), attachmentIds),
    ])
  },
}
