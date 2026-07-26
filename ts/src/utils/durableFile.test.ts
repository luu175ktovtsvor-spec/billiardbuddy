import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { syncParentDirectory } from './durableFile.js'

describe('durable file helpers', () => {
  test('syncs the parent directory on platforms that support directory handles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bb-durable-file-'))
    try {
      const file = join(root, 'state.json')
      await writeFile(file, '{}')
      await expect(syncParentDirectory(file, 'darwin')).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses file sync plus rename as the Windows durability boundary', async () => {
    await expect(syncParentDirectory('Z:\\missing\\state.json', 'win32')).resolves.toBeUndefined()
  })
})
