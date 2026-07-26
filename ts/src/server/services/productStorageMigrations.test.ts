import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CronService } from './cronService.js'
import { migrateSupportedScheduledTaskRuns } from './cronScheduler.js'
import {
  CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
  OLDEST_SUPPORTED_PRODUCT_VERSION,
  ProductStorageMigrationCoordinator,
  type ProductStorageMigrationDependencies,
} from './productStorageMigrations.js'
import desktopPackage from '../../../desktop/package.json'

function versionTuple(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) throw new Error(`invalid release version: ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: string, right: string): number {
  const a = versionTuple(left)
  const b = versionTuple(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!
  }
  return 0
}

function noOpDependencies(overrides: Partial<ProductStorageMigrationDependencies> = {}): ProductStorageMigrationDependencies {
  return {
    migrateProductTasks: async () => undefined,
    migrateMedia: async () => undefined,
    migrateVoice: async () => undefined,
    migrateScheduledTasks: async () => undefined,
    migrateScheduledTaskRuns: async () => undefined,
    ...overrides,
  }
}

describe('Product storage migration coordinator', () => {
  test('binds the desktop release to a newer version than the supported rollback floor', () => {
    expect(compareVersions(desktopPackage.version, OLDEST_SUPPORTED_PRODUCT_VERSION)).toBeGreaterThan(0)
  })

  test('backs up once, serializes callers, and never reruns a committed migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bb-storage-migration-'))
    try {
      const scheduledPath = join(root, 'scheduled_tasks.json')
      const original = `${JSON.stringify({ tasks: [] }, null, 2)}\n`
      await writeFile(scheduledPath, original, { mode: 0o600 })
      let scheduledMigrations = 0
      const coordinator = new ProductStorageMigrationCoordinator(root, noOpDependencies({
        migrateScheduledTasks: async () => {
          scheduledMigrations += 1
          await new CronService(root).migrateSupportedStorage()
        },
        migrateScheduledTaskRuns: () => migrateSupportedScheduledTaskRuns(root),
        now: () => new Date('2026-07-26T10:20:30.000Z'),
      }))

      const [first, sameRun] = await Promise.all([coordinator.ensureUpgraded(), coordinator.ensureUpgraded()])
      expect(first).toEqual(sameRun)
      expect(first).toMatchObject({ version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION, migrated: true })
      expect(scheduledMigrations).toBe(1)

      const state = JSON.parse(await readFile(join(root, 'billiardbuddy', 'storage-migration-state.json'), 'utf8'))
      expect(state).toMatchObject({ completed_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION, backup_id: first.backup_id })
      const backup = join(root, 'billiardbuddy', 'storage-migration-backups', first.backup_id, 'files', 'scheduled_tasks.json')
      expect(await readFile(backup, 'utf8')).toBe(original)
      expect((await stat(backup)).mode & 0o777).toBe(0o600)

      const second = await new ProductStorageMigrationCoordinator(root, noOpDependencies({
        migrateScheduledTasks: async () => { throw new Error('committed migration ran again') },
      })).ensureUpgraded()
      expect(second).toEqual({ version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION, migrated: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restores exact mutable bytes when any migration step fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bb-storage-rollback-'))
    try {
      const scheduledPath = join(root, 'scheduled_tasks.json')
      const original = `${JSON.stringify({ tasks: [{ id: 'legacy01', cron: '0 9 * * *', prompt: '复盘', createdAt: 1 }] }, null, 2)}\n`
      await writeFile(scheduledPath, original, { mode: 0o640 })
      const coordinator = new ProductStorageMigrationCoordinator(root, noOpDependencies({
        migrateScheduledTasks: () => new CronService(root).migrateSupportedStorage(),
        afterStep: async (step) => {
          if (step === 'scheduled-tasks') throw new Error('injected migration failure')
        },
        now: () => new Date('2026-07-26T10:20:30.000Z'),
      }))

      await expect(coordinator.ensureUpgraded()).rejects.toThrow('injected migration failure')
      expect(await readFile(scheduledPath, 'utf8')).toBe(original)
      expect((await stat(scheduledPath)).mode & 0o777).toBe(0o640)
      await expect(readFile(join(root, 'billiardbuddy', 'storage-migration-state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(root, 'billiardbuddy', 'storage-migration-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('recovers an interrupted journal before starting the next migration attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bb-storage-journal-recovery-'))
    try {
      const productDir = join(root, 'billiardbuddy')
      const backupId = 'v3-20260726T102030Z-1234abcd'
      const backupFile = join(productDir, 'storage-migration-backups', backupId, 'files', 'scheduled_tasks.json')
      const scheduledPath = join(root, 'scheduled_tasks.json')
      await mkdir(join(productDir, 'storage-migration-backups', backupId, 'files'), { recursive: true })
      await writeFile(backupFile, `${JSON.stringify({ tasks: [{ id: 'before', cron: '0 9 * * *', prompt: '原任务', createdAt: 1 }] }, null, 2)}\n`)
      await chmod(backupFile, 0o600)
      await writeFile(scheduledPath, `${JSON.stringify({ tasks: [{ id: 'partial', cron: '* * * * *', prompt: '半成品', createdAt: 2 }] }, null, 2)}\n`)
      await writeFile(join(productDir, 'storage-migration-journal.json'), `${JSON.stringify({
        schema_version: 1,
        target_version: 3,
        backup_id: backupId,
        existing_paths: ['scheduled_tasks.json'],
        backed_up_files: [{ path: 'scheduled_tasks.json', mode: 0o600 }],
      }, null, 2)}\n`)

      await new ProductStorageMigrationCoordinator(root, noOpDependencies({
        migrateScheduledTasks: () => new CronService(root).migrateSupportedStorage(),
        migrateScheduledTaskRuns: () => migrateSupportedScheduledTaskRuns(root),
        now: () => new Date('2026-07-26T10:21:00.000Z'),
      })).ensureUpgraded()

      const migrated = JSON.parse(await readFile(scheduledPath, 'utf8'))
      expect(migrated.schemaVersion).toBe(1)
      expect(migrated.tasks.map((task: { id: string }) => task.id)).toEqual(['before'])
      await expect(readFile(join(productDir, 'storage-migration-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
