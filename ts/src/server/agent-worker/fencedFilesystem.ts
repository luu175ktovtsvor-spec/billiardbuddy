import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import type { ProductResourceReceipt } from '../../../shared/product/resourceScheduler.js'

export type WorkspaceWriteFence = { root: string; expected_head: string; fencing_token: number }
/** Validates target containment and scheduler fencing before the first write. */
export async function writeWorkspaceFile(fence: WorkspaceWriteFence, receipt: ProductResourceReceipt, relativePath: string, content: string, head: () => Promise<string>): Promise<void> {
  if (receipt.outcome !== 'admitted' || receipt.fencing_token !== fence.fencing_token || !receipt.resource_keys.includes('filesystem.write.workspace') || !relativePath || path.isAbsolute(relativePath) || await head() !== fence.expected_head) throw new Error('WORKSPACE_WRITE_DENIED')
  const root = await fs.realpath(fence.root); const target = path.resolve(root, relativePath)
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('WORKSPACE_WRITE_DENIED')
  const parent = await fs.realpath(path.dirname(target)); if (!parent.startsWith(root)) throw new Error('WORKSPACE_WRITE_DENIED')
  // New targets and path-following writes would leave a target-replacement
  // TOCTOU window.  D only permits an existing regular file opened O_NOFOLLOW.
  const before = await fs.lstat(target); if (!before.isFile() || before.isSymbolicLink()) throw new Error('WORKSPACE_WRITE_DENIED')
  const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW)
  try { const after = await handle.stat(); if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) throw new Error('WORKSPACE_WRITE_DENIED'); await handle.writeFile(content) } finally { await handle.close() }
}
