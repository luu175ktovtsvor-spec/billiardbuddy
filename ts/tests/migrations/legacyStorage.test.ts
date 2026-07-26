import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ProductTaskService,
  type AgentCoreAdapter,
  type AgentCoreSession,
} from '../../src/server/product/taskService.js'
import { MediaProjectService } from '../../src/server/services/mediaProjectService.js'
import { CronService } from '../../src/server/services/cronService.js'
import { migrateSupportedScheduledTaskRuns } from '../../src/server/services/cronScheduler.js'

const tsRoot = resolve(import.meta.dir, '../..')

function loadFixture(name: string): { raw: string, value: any } {
  const raw = readFileSync(join(tsRoot, 'fixtures/migrations', name), 'utf8')
  return { raw, value: JSON.parse(raw) }
}

function fixtureCore(sessions: AgentCoreSession[]): AgentCoreAdapter {
  return {
    listSessions: async () => sessions,
    createSession: async () => { throw new Error('migration must not create a Core session') },
    renameSession: async () => { throw new Error('migration must not rename a Core session') },
    branchSession: async () => { throw new Error('migration must not branch a Core session') },
    getWorktreeLaunchState: async () => 'not_requested',
  }
}

async function migrateProductTaskFixture(name: string, idempotence: boolean): Promise<void> {
  const fixture = loadFixture(name)
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-01a-product-task-'))
  try {
    const storagePath = join(tempRoot, 'product-tasks.json')
    await writeFile(storagePath, `${JSON.stringify(fixture.value.store, null, 2)}\n`)
    const service = new ProductTaskService({ storagePath, core: fixtureCore(fixture.value.core_sessions) })
    const first = await service.listTasks()
    const migrated = JSON.parse(await readFile(storagePath, 'utf8'))
    expect(migrated.version).toBe(fixture.value.expected_current_version)
    expect(first.tasks).toHaveLength(1)
    expect(migrated.tasks).toHaveProperty(first.tasks[0].id)
    expect(migrated.tasks[first.tasks[0].id].coreSessionId).toBe(fixture.value.core_sessions[0].id)
    expect(loadFixture(name).raw).toBe(fixture.raw)
    expect((await readdir(tempRoot)).filter(file => file.includes('bak-before-migration'))).toEqual([])
    if (idempotence) {
      const firstBytes = await readFile(storagePath, 'utf8')
      const reloaded = new ProductTaskService({ storagePath, core: fixtureCore(fixture.value.core_sessions) })
      await reloaded.listTasks()
      expect(await readFile(storagePath, 'utf8')).toBe(firstBytes)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function migrateMediaFixture(idempotence: boolean): Promise<void> {
  const fixture = loadFixture('media-disk-v1-inline-reference-images.json')
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-01a-media-'))
  try {
    const projectPath = join(tempRoot, 'projects', `${fixture.value.project.id}.json`)
    await mkdir(join(tempRoot, 'projects'), { recursive: true })
    await writeFile(projectPath, `${JSON.stringify(fixture.value.project, null, 2)}\n`)
    const migrated = await new MediaProjectService({ root: tempRoot }).getProject(fixture.value.project.id)
    expect(migrated.kind).toBe('image')
    if (migrated.kind !== 'image') throw new Error('fixture did not load as an image project')
    expect(migrated.reference_images).toEqual(fixture.value.expected_reference_images)
    expect(migrated.reference_image_assets).toHaveLength(fixture.value.expected_private_asset_count)
    const asset = join(tempRoot, 'assets', migrated.id, 'references', migrated.reference_image_assets![0]!)
    expect((await readFile(asset)).length).toBeGreaterThan(0)
    const persisted = await readFile(projectPath, 'utf8')
    expect(persisted).not.toContain(fixture.value.project.reference_images[0])
    expect(loadFixture('media-disk-v1-inline-reference-images.json').raw).toBe(fixture.raw)
    expect((await readdir(tempRoot)).filter(file => file.includes('bak-before-migration'))).toEqual([])
    if (idempotence) {
      await new MediaProjectService({ root: tempRoot }).getProject(fixture.value.project.id)
      expect(await readFile(projectPath, 'utf8')).toBe(persisted)
      expect(await readdir(join(tempRoot, 'assets', migrated.id, 'references'))).toEqual(migrated.reference_image_assets)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function migrateCronFixture(idempotence: boolean): Promise<void> {
  const fixture = loadFixture('cron-disk-v0-legacy-fields.json')
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-cron-migration-'))
  try {
    const storagePath = join(tempRoot, 'scheduled_tasks.json')
    await writeFile(storagePath, `${JSON.stringify(fixture.value.store, null, 2)}\n`)
    const service = new CronService(tempRoot)
    await service.migrateSupportedStorage()
    const firstBytes = await readFile(storagePath, 'utf8')
    const migrated = JSON.parse(firstBytes)
    expect(migrated.schemaVersion).toBe(1)
    expect(migrated.tasks[0]).toMatchObject({
      id: 'legacy01',
      folderPath: '/example/workspace',
      permissionMode: 'dontAsk',
      missedRunPolicy: 'run_once',
      context: { mode: 'independent' },
    })
    for (const retired of ['folder', 'model', 'providerId', 'useWorktree', 'frequency', 'scheduledTime']) {
      expect(migrated.tasks[0]).not.toHaveProperty(retired)
    }
    expect(loadFixture('cron-disk-v0-legacy-fields.json').raw).toBe(fixture.raw)
    if (idempotence) {
      await new CronService(tempRoot).migrateSupportedStorage()
      expect(await readFile(storagePath, 'utf8')).toBe(firstBytes)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function migrateCronRunFixture(idempotence: boolean): Promise<void> {
  const fixture = loadFixture('cron-run-log-v0-private-runtime-fields.json')
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-cron-run-migration-'))
  try {
    const storagePath = join(tempRoot, 'scheduled_tasks_log.json')
    await writeFile(storagePath, `${JSON.stringify(fixture.value.store, null, 2)}\n`)
    await migrateSupportedScheduledTaskRuns(tempRoot)
    const firstBytes = await readFile(storagePath, 'utf8')
    const migrated = JSON.parse(firstBytes)
    expect(migrated.schemaVersion).toBe(1)
    expect(migrated.runs[0]).toMatchObject({ id: 'run-legacy01' })
    expect(migrated.runs[0]).not.toHaveProperty('productTaskId')
    for (const retired of ['sessionId', 'model', 'providerId']) {
      expect(migrated.runs[0]).not.toHaveProperty(retired)
    }
    expect(loadFixture('cron-run-log-v0-private-runtime-fields.json').raw).toBe(fixture.raw)
    if (idempotence) {
      await migrateSupportedScheduledTaskRuns(tempRoot)
      expect(await readFile(storagePath, 'utf8')).toBe(firstBytes)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

describe('supported storage migrations', () => {
  it('product-task-disk-v1-to-v4:positive', () => migrateProductTaskFixture('product-task-disk-v1.json', false))
  it('product-task-disk-v1-to-v4:idempotence', () => migrateProductTaskFixture('product-task-disk-v1.json', true))
  it('product-task-disk-v3-to-v4:positive', () => migrateProductTaskFixture('product-task-disk-v3.json', false))
  it('product-task-disk-v3-to-v4:idempotence', () => migrateProductTaskFixture('product-task-disk-v3.json', true))
  it('product-task-disk-v4-current:positive', () => migrateProductTaskFixture('product-task-disk-v4.json', false))
  it('product-task-disk-v4-current:idempotence', () => migrateProductTaskFixture('product-task-disk-v4.json', true))
  it('media-disk-v1-inline-reference-images-to-private-asset:positive', () => migrateMediaFixture(false))
  it('media-disk-v1-inline-reference-images-to-private-asset:idempotence', () => migrateMediaFixture(true))
  it('cron-disk-v0-legacy-fields-to-v1:positive', () => migrateCronFixture(false))
  it('cron-disk-v0-legacy-fields-to-v1:idempotence', () => migrateCronFixture(true))
  it('cron-run-log-v0-private-runtime-fields-to-v1:positive', () => migrateCronRunFixture(false))
  it('cron-run-log-v0-private-runtime-fields-to-v1:idempotence', () => migrateCronRunFixture(true))
})
