import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import {
  seedInterruptedProductStorage,
  verifyRollbackProductStorage,
  waitForProductStorageUpgrade,
} from './package-upgrade-storage'
import {
  CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
  OLDEST_SUPPORTED_PRODUCT_VERSION,
} from '../../src/server/services/productStorageMigrations'

const roots: string[] = []

function fixture(): { root: string, configDir: string, storePath: string, original: string } {
  const root = mkdtempSync(join(tmpdir(), 'package-upgrade-storage-test-'))
  roots.push(root)
  const configDir = join(root, 'config')
  const productDir = join(configDir, 'billiardbuddy')
  const storePath = join(productDir, 'product-tasks.json')
  const original = `${JSON.stringify({
    version: 4,
    tasks: { task_fixture: { title: 'Oldest supported package task' } },
    sideTasks: {},
  }, null, 2)}\n`
  mkdirSync(productDir, { recursive: true })
  writeFileSync(storePath, original)
  return { root, configDir, storePath, original }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaged desktop upgrade storage evidence', () => {
  it('recovers exact old bytes and proves rollback-readable task state', async () => {
    const value = fixture()
    const evidence = seedInterruptedProductStorage(value.configDir, 'task_fixture')
    expect(evidence.original).toBe(value.original)
    const productDir = join(value.configDir, 'billiardbuddy')
    const recoveryBackupId = 'v3-20260726T000000Z-recovery'
    const recoveryFile = join(productDir, 'storage-migration-backups', recoveryBackupId, 'files', 'billiardbuddy', 'product-tasks.json')
    mkdirSync(join(recoveryFile, '..'), { recursive: true })
    writeFileSync(recoveryFile, value.original)
    writeFileSync(value.storePath, value.original)
    writeFileSync(join(productDir, 'storage-migration-state.json'), `${JSON.stringify({
      schema_version: 1,
      completed_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
      oldest_supported_product_version: OLDEST_SUPPORTED_PRODUCT_VERSION,
      backup_id: recoveryBackupId,
      completed_at: '2026-07-26T00:00:00.000Z',
    })}\n`)
    rmSync(join(productDir, 'storage-migration-journal.json'))

    await expect(waitForProductStorageUpgrade(value.configDir, evidence, 1_000)).resolves.toEqual({
      backupId: recoveryBackupId,
      taskId: 'task_fixture',
    })
    expect(() => verifyRollbackProductStorage(value.configDir, 'task_fixture')).not.toThrow()
    expect(readFileSync(recoveryFile, 'utf8')).toBe(value.original)
  })
})
