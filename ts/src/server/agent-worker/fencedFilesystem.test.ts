import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { writeWorkspaceFile } from './fencedFilesystem.js'

const receipt = { job_id: 'write', outcome: 'admitted' as const, profile_revision: 'p', resource_keys: ['filesystem.write.workspace'] as const, fencing_token: 7, lease: { owner_id: 'o', process_id: 'p', process_generation: 'g', fencing_token: 7, expires_at: '2027-01-01T00:00:00.000Z' } }
test('fenced workspace writes reject stale receipt, HEAD drift, traversal, and symlink replacement without writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-fence-')); const target = path.join(root, 'safe.txt'); const outside = path.join(root, 'outside.txt'); await fs.writeFile(target, 'before'); await fs.writeFile(outside, 'outside')
  const fence = { root, expected_head: 'head', fencing_token: 7 }
  await expect(writeWorkspaceFile(fence, { ...receipt, fencing_token: 8 }, 'safe.txt', 'bad', async () => 'head')).rejects.toThrow('WORKSPACE_WRITE_DENIED')
  await expect(writeWorkspaceFile(fence, receipt, 'safe.txt', 'bad', async () => 'changed')).rejects.toThrow('WORKSPACE_WRITE_DENIED')
  await expect(writeWorkspaceFile(fence, receipt, '../outside.txt', 'bad', async () => 'head')).rejects.toThrow('WORKSPACE_WRITE_DENIED')
  await fs.unlink(target); await fs.symlink(outside, target)
  await expect(writeWorkspaceFile(fence, receipt, 'safe.txt', 'bad', async () => 'head')).rejects.toThrow('WORKSPACE_WRITE_DENIED')
  expect(await fs.readFile(outside, 'utf8')).toBe('outside')
})
