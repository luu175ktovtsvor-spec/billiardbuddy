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
import {
  ensurePersistentStorageUpgraded,
  resetPersistentStorageMigrationsForTests,
} from '../../src/server/services/persistentStorageMigrations.js'

const tsRoot = resolve(import.meta.dir, '../..')

function loadFixture(name: string): { raw: string, value: any } {
  const raw = readFileSync(join(tsRoot, 'product-contracts/fixtures', name), 'utf8')
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

async function migrateProviderFixture(idempotence: boolean): Promise<void> {
  const fixture = loadFixture('provider-root-v1-legacy-index.json')
  const tempRoot = await mkdtemp(join(tmpdir(), 'bb-01a-provider-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = tempRoot
    resetPersistentStorageMigrationsForTests()
    const legacyPath = join(tempRoot, 'providers.json')
    const legacyBytes = `${JSON.stringify(fixture.value.legacy_root, null, 2)}\n`
    await writeFile(legacyPath, legacyBytes)
    const report = await ensurePersistentStorageUpgraded()
    expect(report.failures).toEqual([])
    expect(report.migratedEntries).toContain('providers.json -> billiardbuddy/providers.json')
    expect(await readFile(legacyPath, 'utf8')).toBe(legacyBytes)
    const migratedPath = join(tempRoot, 'billiardbuddy', 'providers.json')
    const migrated = JSON.parse(await readFile(migratedPath, 'utf8'))
    expect(migrated.schemaVersion).toBe(fixture.value.expected_provider_index_version)
    expect(migrated.activeId).toBe('fixture-provider')
    expect(migrated.providers[0].models.main).toBe('fixture-model')
    expect(loadFixture('provider-root-v1-legacy-index.json').raw).toBe(fixture.raw)
    expect((await readdir(join(tempRoot, 'billiardbuddy'))).filter(file => file.includes('bak-before-migration'))).toEqual([])
    if (idempotence) {
      const firstBytes = await readFile(migratedPath, 'utf8')
      resetPersistentStorageMigrationsForTests()
      const second = await ensurePersistentStorageUpgraded()
      expect(second.migratedEntries).toEqual([])
      expect(await readFile(migratedPath, 'utf8')).toBe(firstBytes)
      expect(await readFile(legacyPath, 'utf8')).toBe(legacyBytes)
    }
  } finally {
    resetPersistentStorageMigrationsForTests()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(tempRoot, { recursive: true, force: true })
  }
}

describe('BB-01A registered legacy reader migrations', () => {
  it('product-task-disk-v1-to-v4:positive', () => migrateProductTaskFixture('product-task-disk-v1.json', false))
  it('product-task-disk-v1-to-v4:idempotence', () => migrateProductTaskFixture('product-task-disk-v1.json', true))
  it('product-task-disk-v3-to-v4:positive', () => migrateProductTaskFixture('product-task-disk-v3.json', false))
  it('product-task-disk-v3-to-v4:idempotence', () => migrateProductTaskFixture('product-task-disk-v3.json', true))
  it('product-task-disk-v4-current:positive', () => migrateProductTaskFixture('product-task-disk-v4.json', false))
  it('product-task-disk-v4-current:idempotence', () => migrateProductTaskFixture('product-task-disk-v4.json', true))
  it('media-disk-v1-inline-reference-images-to-private-asset:positive', () => migrateMediaFixture(false))
  it('media-disk-v1-inline-reference-images-to-private-asset:idempotence', () => migrateMediaFixture(true))
  it('provider-root-v1-legacy-index-to-provider-index-v2:positive', () => migrateProviderFixture(false))
  it('provider-root-v1-legacy-index-to-provider-index-v2:idempotence', () => migrateProviderFixture(true))
})
