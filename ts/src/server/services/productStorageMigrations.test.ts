import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CronService } from './cronService.js'
import { migrateSupportedScheduledTaskRuns } from './cronScheduler.js'
import { MediaProjectService } from './mediaProjectService.js'
import { ProductTaskService, type AgentCoreAdapter, type AgentCoreSession } from '../product/taskService.js'
import { ensurePersistentStorageUpgraded } from './persistentStorageMigrations.js'
import {
  CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
  OLDEST_SUPPORTED_PRODUCT_BASELINE,
  OLDEST_SUPPORTED_PRODUCT_VERSION,
  ProductStorageMigrationCoordinator,
} from './productStorageMigrations.js'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-storage-migration-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

function coreWith(session: AgentCoreSession): AgentCoreAdapter {
  return {
    listSessions: async () => [session],
    createSession: async () => ({ sessionId: session.id, workDir: session.workDir ?? '' }),
    renameSession: async () => undefined,
    branchSession: async () => ({ sessionId: 'unused', workDir: session.workDir ?? '', title: 'unused' }),
    getWorktreeLaunchState: async () => 'not_requested',
  }
}

describe('ProductStorageMigrationCoordinator', () => {
  test('upgrades the oldest supported 0.4.9 fixture once without losing tasks, media, settings or schedules', async () => {
    const configDir = await temporaryRoot()
    const productDir = path.join(configDir, 'billiardbuddy')
    const mediaRoot = path.join(productDir, 'media')
    await fs.mkdir(productDir, { recursive: true })

    const session: AgentCoreSession = {
      id: 'legacy-core-session',
      title: '旧版球房任务',
      createdAt: '2026-07-18T00:00:00.000Z',
      modifiedAt: '2026-07-18T00:00:00.000Z',
      projectRoot: configDir,
      workDir: configDir,
    }
    await fs.writeFile(path.join(productDir, 'product-tasks.json'), JSON.stringify({
      version: 1,
      tasks: {
        [session.id]: {
          title: session.title,
          lifecycle: 'active',
          kind: 'main',
          createdAt: session.createdAt,
          updatedAt: session.modifiedAt,
          worktreeState: 'not_requested',
        },
      },
      sideTasks: {},
    }))
    await fs.writeFile(path.join(productDir, 'settings.json'), JSON.stringify({
      h5Access: { enabled: true, token: 'legacy-secret' },
      env: { USER_CUSTOM_ENV: 'keep-me' },
    }))
    await fs.writeFile(path.join(configDir, 'scheduled_tasks.json'), JSON.stringify({
      tasks: [{
        id: 'legacy-schedule',
        cron: '0 9 * * *',
        prompt: '每日复盘',
        createdAt: 1,
        permissionMode: 'bypassPermissions',
        useWorktree: true,
        folderPath: configDir,
      }],
    }))
    await fs.writeFile(path.join(configDir, 'scheduled_tasks_log.json'), JSON.stringify({
      runs: [{
        id: 'legacy-run', taskId: 'legacy-schedule', taskName: '每日复盘',
        startedAt: '2026-07-18T09:00:00.000Z', status: 'completed', prompt: '每日复盘',
      }],
    }))

    const media = new MediaProjectService({ root: mediaRoot })
    const reference = `data:image/png;base64,${Buffer.from('legacy-reference').toString('base64')}`
    const created = await media.createImageProject({
      prompt: '旧版海报',
      mode: 'edit',
      reference_images: [reference],
      reference_roles: ['subject'],
    })
    const projectPath = path.join(mediaRoot, 'projects', `${created.id}.json`)
    await fs.rm(path.join(mediaRoot, 'assets', created.id), { recursive: true, force: true })
    await fs.writeFile(projectPath, `${JSON.stringify({
      ...created,
      reference_images: [reference],
      reference_image_assets: undefined,
      assets: [],
      versions: [],
    }, null, 2)}\n`)

    const tasks = new ProductTaskService({
      storagePath: path.join(productDir, 'product-tasks.json'),
      core: coreWith(session),
    })
    const coordinator = new ProductStorageMigrationCoordinator(configDir, {
      migrateManagedSettings: () => ensurePersistentStorageUpgraded(configDir),
      migrateProductTasks: () => tasks.migrateSupportedStorage(),
      migrateMedia: () => media.migrateSupportedStorage(),
      migrateScheduledTasks: () => new CronService(configDir).migrateSupportedStorage(),
      migrateScheduledTaskRuns: () => migrateSupportedScheduledTaskRuns(configDir),
      now: () => new Date('2026-07-26T00:00:00.000Z'),
    })

    expect(OLDEST_SUPPORTED_PRODUCT_VERSION).toBe('0.4.9')
    expect(OLDEST_SUPPORTED_PRODUCT_BASELINE).toBe('2a6e79846a49f45a24080a9b50e93a7c66c12e61')
    const first = await coordinator.ensureUpgraded()
    expect(first).toMatchObject({ version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION, migrated: true })

    const taskStore = JSON.parse(await fs.readFile(path.join(productDir, 'product-tasks.json'), 'utf8')) as {
      version: number; tasks: Record<string, { title: string }>
    }
    expect(taskStore.version).toBe(4)
    expect(Object.values(taskStore.tasks)).toContainEqual(expect.objectContaining({ title: '旧版球房任务' }))
    const authority = JSON.parse(await fs.readFile(path.join(productDir, 'product-task-authority.v1.json'), 'utf8')) as {
      tasks: Record<string, unknown>
    }
    expect(Object.keys(authority.tasks)).toHaveLength(1)

    const migratedMedia = await media.getProject(created.id)
    expect(migratedMedia.kind).toBe('image')
    if (migratedMedia.kind !== 'image') throw new Error('wrong media kind')
    expect(migratedMedia.reference_images).toEqual([])
    expect(migratedMedia.reference_image_assets).toHaveLength(1)
    expect(migratedMedia.versions.length).toBeGreaterThan(0)

    const settings = JSON.parse(await fs.readFile(path.join(productDir, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings.h5Access).toBeUndefined()
    expect(settings.env).toEqual({ USER_CUSTOM_ENV: 'keep-me' })
    const schedules = JSON.parse(await fs.readFile(path.join(configDir, 'scheduled_tasks.json'), 'utf8')) as {
      schemaVersion: number; tasks: Array<Record<string, unknown>>
    }
    expect(schedules.schemaVersion).toBe(1)
    expect(schedules.tasks[0]).toMatchObject({ permissionMode: 'dontAsk', missedRunPolicy: 'run_once' })
    expect(schedules.tasks[0]).not.toHaveProperty('useWorktree')
    const runs = JSON.parse(await fs.readFile(path.join(configDir, 'scheduled_tasks_log.json'), 'utf8')) as {
      schemaVersion: number; runs: Array<{ id: string }>
    }
    expect(runs).toMatchObject({ schemaVersion: 1, runs: [{ id: 'legacy-run' }] })

    const backupsRoot = path.join(productDir, 'storage-migration-backups')
    expect(await fs.readdir(backupsRoot)).toHaveLength(1)
    const restart = new ProductStorageMigrationCoordinator(configDir, {
      migrateManagedSettings: async () => { throw new Error('must not rerun') },
      migrateProductTasks: async () => { throw new Error('must not rerun') },
      migrateMedia: async () => { throw new Error('must not rerun') },
      migrateScheduledTasks: async () => { throw new Error('must not rerun') },
      migrateScheduledTaskRuns: async () => { throw new Error('must not rerun') },
    })
    expect(await restart.ensureUpgraded()).toEqual({ version: 1, migrated: false })
    expect(await fs.readdir(backupsRoot)).toHaveLength(1)
  })

  test('restores exact prior bytes and removes migration-created files after a failed step', async () => {
    const configDir = await temporaryRoot()
    const productDir = path.join(configDir, 'billiardbuddy')
    const settingsPath = path.join(productDir, 'settings.json')
    const authorityPath = path.join(productDir, 'product-task-authority.v1.json')
    const newAssetPath = path.join(productDir, 'media', 'assets', 'img_legacy001', 'references', 'new.png')
    await fs.mkdir(productDir, { recursive: true })
    const original = '{"env":{"KEEP":"yes"}}\n'
    await fs.writeFile(settingsPath, original, { mode: 0o600 })

    const coordinator = new ProductStorageMigrationCoordinator(configDir, {
      migrateManagedSettings: async () => {
        await fs.writeFile(settingsPath, '{"env":{"KEEP":"changed"}}\n')
      },
      migrateProductTasks: async () => {
        await fs.writeFile(authorityPath, '{"version":1}\n')
      },
      migrateMedia: async () => {
        await fs.mkdir(path.dirname(newAssetPath), { recursive: true })
        await fs.writeFile(newAssetPath, 'new migration byte')
        throw new Error('injected media migration failure')
      },
      migrateScheduledTasks: async () => undefined,
      migrateScheduledTaskRuns: async () => undefined,
      now: () => new Date('2026-07-26T00:00:00.000Z'),
    })

    await expect(coordinator.ensureUpgraded()).rejects.toThrow('injected media migration failure')
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(original)
    expect(await fs.stat(settingsPath).then(info => info.mode & 0o777)).toBe(0o600)
    expect(await fs.access(authorityPath).then(() => true, () => false)).toBeFalse()
    expect(await fs.access(newAssetPath).then(() => true, () => false)).toBeFalse()
    expect(await fs.access(path.join(productDir, 'storage-migration-state.json')).then(() => true, () => false)).toBeFalse()
    expect(await fs.access(path.join(productDir, 'storage-migration-journal.json')).then(() => true, () => false)).toBeFalse()
  })

  test('rolls back a prepared crash journal before retrying the migration', async () => {
    const configDir = await temporaryRoot()
    const productDir = path.join(configDir, 'billiardbuddy')
    const settingsPath = path.join(productDir, 'settings.json')
    const authorityPath = path.join(productDir, 'product-task-authority.v1.json')
    const backupId = 'v1-20260726T000000Z-deadbeef'
    const backupFile = path.join(
      productDir,
      'storage-migration-backups',
      backupId,
      'files',
      'billiardbuddy',
      'settings.json',
    )
    const original = '{"env":{"BEFORE_CRASH":"yes"}}\n'
    await fs.mkdir(path.dirname(backupFile), { recursive: true })
    await fs.writeFile(backupFile, original, { mode: 0o600 })
    await fs.writeFile(settingsPath, '{"env":{"PARTIAL":"write"}}\n')
    await fs.writeFile(authorityPath, '{"version":1,"tasks":{}}\n')
    await fs.writeFile(path.join(productDir, 'storage-migration-journal.json'), JSON.stringify({
      schema_version: 1,
      target_version: 1,
      backup_id: backupId,
      existing_paths: ['billiardbuddy/settings.json'],
      backed_up_files: [{ path: 'billiardbuddy/settings.json', mode: 0o600 }],
    }))

    let sawRestoredSource = false
    const coordinator = new ProductStorageMigrationCoordinator(configDir, {
      migrateManagedSettings: async () => {
        sawRestoredSource = await fs.readFile(settingsPath, 'utf8') === original
          && !await fs.access(authorityPath).then(() => true, () => false)
      },
      migrateProductTasks: async () => undefined,
      migrateMedia: async () => undefined,
      migrateScheduledTasks: async () => undefined,
      migrateScheduledTaskRuns: async () => undefined,
      now: () => new Date('2026-07-26T00:00:01.000Z'),
    })

    expect(await coordinator.ensureUpgraded()).toMatchObject({ migrated: true, version: 1 })
    expect(sawRestoredSource).toBeTrue()
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(original)
    expect(await fs.access(path.join(productDir, 'storage-migration-journal.json')).then(() => true, () => false)).toBeFalse()
  })

  test('keeps a committed migration when journal cleanup was interrupted', async () => {
    const configDir = await temporaryRoot()
    const productDir = path.join(configDir, 'billiardbuddy')
    const backupId = 'v1-20260726T000000Z-feedface'
    await fs.mkdir(path.join(productDir, 'storage-migration-backups', backupId), { recursive: true })
    await fs.writeFile(path.join(productDir, 'storage-migration-state.json'), JSON.stringify({
      schema_version: 1,
      completed_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
      oldest_supported_product_version: OLDEST_SUPPORTED_PRODUCT_VERSION,
      completed_at: '2026-07-26T00:00:00.000Z',
      backup_id: backupId,
    }))
    await fs.writeFile(path.join(productDir, 'storage-migration-journal.json'), JSON.stringify({
      schema_version: 1,
      target_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
      backup_id: backupId,
      existing_paths: [],
      backed_up_files: [],
    }))
    let calls = 0
    const step = async () => { calls += 1 }
    const coordinator = new ProductStorageMigrationCoordinator(configDir, {
      migrateManagedSettings: step,
      migrateProductTasks: step,
      migrateMedia: step,
      migrateScheduledTasks: step,
      migrateScheduledTaskRuns: step,
    })

    expect(await coordinator.ensureUpgraded()).toEqual({ version: 1, migrated: false })
    expect(calls).toBe(0)
    expect(await fs.access(path.join(productDir, 'storage-migration-journal.json')).then(() => true, () => false)).toBeFalse()
  })

  test('fails closed on a future product schema before creating a backup or running a migration', async () => {
    const configDir = await temporaryRoot()
    const productDir = path.join(configDir, 'billiardbuddy')
    await fs.mkdir(productDir, { recursive: true })
    await fs.writeFile(path.join(productDir, 'product-tasks.json'), '{"version":99,"tasks":{}}\n')
    let calls = 0
    const step = async () => { calls += 1 }
    const coordinator = new ProductStorageMigrationCoordinator(configDir, {
      migrateManagedSettings: step,
      migrateProductTasks: step,
      migrateMedia: step,
      migrateScheduledTasks: step,
      migrateScheduledTaskRuns: step,
    })

    await expect(coordinator.ensureUpgraded()).rejects.toThrow('UNSUPPORTED_PRODUCT_TASK_SCHEMA')
    expect(calls).toBe(0)
    expect(await fs.access(path.join(productDir, 'storage-migration-backups')).then(() => true, () => false)).toBeFalse()
  })

  test('fails closed on future schedule and media schemas before creating a backup', async () => {
    const configDir = await temporaryRoot()
    const productDir = path.join(configDir, 'billiardbuddy')
    const projectDir = path.join(productDir, 'media', 'projects')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'scheduled_tasks.json'), '{"schemaVersion":2,"tasks":[]}\n')
    await fs.writeFile(path.join(projectDir, 'img_future.json'), '{"schema_version":2}\n')
    let calls = 0
    const step = async () => { calls += 1 }
    const coordinator = new ProductStorageMigrationCoordinator(configDir, {
      migrateManagedSettings: step,
      migrateProductTasks: step,
      migrateMedia: step,
      migrateScheduledTasks: step,
      migrateScheduledTaskRuns: step,
    })

    await expect(coordinator.ensureUpgraded()).rejects.toThrow('UNSUPPORTED_SCHEDULED_TASKS_SCHEMA')
    expect(calls).toBe(0)
    expect(await fs.access(path.join(productDir, 'storage-migration-backups')).then(() => true, () => false)).toBeFalse()
  })
})
