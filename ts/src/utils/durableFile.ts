import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Flush a completed rename through its parent directory when the platform
 * supports directory handles. Windows rejects directory fsync with EPERM, so
 * the durable boundary there is the already-synced file plus atomic rename.
 */
export async function syncParentDirectory(filePath: string, platform = process.platform): Promise<void> {
  if (platform === 'win32') return
  const directory = await fs.open(path.dirname(filePath), fsConstants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
