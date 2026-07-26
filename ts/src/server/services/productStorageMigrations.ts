import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

export const CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION = 3
export const OLDEST_SUPPORTED_PRODUCT_VERSION = '0.4.9'
export const OLDEST_SUPPORTED_PRODUCT_BASELINE = '2a6e79846a49f45a24080a9b50e93a7c66c12e61'

type MigrationState = {
  schema_version: 1
  completed_version: number
  oldest_supported_product_version: typeof OLDEST_SUPPORTED_PRODUCT_VERSION
  completed_at: string
  backup_id: string
}

type BackupFile = { path: string; mode: number }
type MigrationJournal = {
  schema_version: 1
  target_version: number
  backup_id: string
  existing_paths: string[]
  backed_up_files: BackupFile[]
}

export type ProductStorageMigrationReport = {
  version: number
  migrated: boolean
  backup_id?: string
}

export type ProductStorageMigrationDependencies = {
  migrateProductTasks: () => Promise<void>
  migrateMedia: () => Promise<void>
  migrateVoice?: () => Promise<void>
  migrateScheduledTasks: () => Promise<void>
  migrateScheduledTaskRuns: () => Promise<void>
  now?: () => Date
  afterStep?: (step: string) => Promise<void> | void
}

const FIXED_MUTABLE_FILES = [
  'scheduled_tasks.json',
  'scheduled_tasks_log.json',
  'billiardbuddy/product-tasks.json',
  'billiardbuddy/product-task-authority.v1.json',
] as const

const TRACKED_ROOTS = [
  'billiardbuddy/media/projects',
  'billiardbuddy/media/tasks',
  'billiardbuddy/media/deletions',
  'billiardbuddy/voice/operations',
  'billiardbuddy/media/assets',
  'billiardbuddy/media/cas/sha256',
] as const

const MUTABLE_JSON_ROOTS = new Set([
  'billiardbuddy/media/projects',
  'billiardbuddy/media/tasks',
  'billiardbuddy/media/deletions',
  'billiardbuddy/voice/operations',
])
const BACKUP_ID = /^v[123]-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function portableRelative(configDir: string, absolutePath: string): string {
  const relative = path.relative(configDir, absolutePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PRODUCT_STORAGE_PATH_INVALID')
  return relative.split(path.sep).join('/')
}

function absoluteFromRelative(configDir: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
    throw new Error('PRODUCT_STORAGE_PATH_INVALID')
  }
  const absolute = path.resolve(configDir, ...relativePath.split('/'))
  if (portableRelative(configDir, absolute) !== relativePath) throw new Error('PRODUCT_STORAGE_PATH_INVALID')
  return absolute
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw error
  }
}

async function listRegularFiles(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries: Array<import('node:fs').Dirent<string>>
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('PRODUCT_STORAGE_SYMLINK_UNSUPPORTED')
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile()) output.push(entryPath)
    }
  }
  await visit(root)
  return output
}

function assertVersion(value: unknown, allowed: readonly number[], code: string): void {
  if (!allowed.includes(value as number)) throw new Error(code)
}

async function preflightSupportedSchemas(configDir: string): Promise<void> {
  const productTasks = await readJsonIfPresent(path.join(configDir, 'billiardbuddy', 'product-tasks.json'))
  if (productTasks !== undefined) {
    if (!isRecord(productTasks)) throw new Error('PRODUCT_TASK_STORE_ERROR')
    assertVersion(productTasks.version, [1, 2, 3, 4], 'UNSUPPORTED_PRODUCT_TASK_SCHEMA')
  }

  const authority = await readJsonIfPresent(path.join(configDir, 'billiardbuddy', 'product-task-authority.v1.json'))
  if (authority !== undefined) {
    if (!isRecord(authority)) throw new Error('AUTHORITY_INVALID')
    assertVersion(authority.version, [1], 'UNSUPPORTED_PRODUCT_TASK_AUTHORITY_SCHEMA')
    if (authority.authority_schema_revision !== undefined) {
      assertVersion(authority.authority_schema_revision, [1, 2, 3, 4], 'UNSUPPORTED_PRODUCT_TASK_AUTHORITY_SCHEMA')
    }
  }

  for (const [relativePath, code] of [
    ['scheduled_tasks.json', 'UNSUPPORTED_SCHEDULED_TASKS_SCHEMA'],
    ['scheduled_tasks_log.json', 'UNSUPPORTED_SCHEDULED_TASK_RUNS_SCHEMA'],
  ] as const) {
    const value = await readJsonIfPresent(path.join(configDir, relativePath))
    if (value === undefined) continue
    if (!isRecord(value)) throw new Error(code)
    if (value.schemaVersion !== undefined) assertVersion(value.schemaVersion, [1], code)
  }

  for (const relativeRoot of MUTABLE_JSON_ROOTS) {
    for (const filePath of await listRegularFiles(path.join(configDir, ...relativeRoot.split('/')))) {
      if (!filePath.endsWith('.json')) continue
      const value = await readJsonIfPresent(filePath)
      if (!isRecord(value)) throw new Error('PRODUCT_STORAGE_INVALID')
      if (relativeRoot === 'billiardbuddy/media/deletions' && value.schema_version === undefined) continue
      assertVersion(
        value.schema_version,
        [1],
        relativeRoot === 'billiardbuddy/voice/operations' ? 'UNSUPPORTED_VOICE_SCHEMA' : 'UNSUPPORTED_MEDIA_SCHEMA',
      )
    }
  }
}

async function inventory(configDir: string): Promise<{ existingPaths: string[]; backupFiles: BackupFile[] }> {
  const paths = new Set<string>()
  for (const relativePath of FIXED_MUTABLE_FILES) {
    const absolute = path.join(configDir, ...relativePath.split('/'))
    const info = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) continue
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('PRODUCT_STORAGE_PATH_INVALID')
    paths.add(relativePath)
  }
  for (const relativeRoot of TRACKED_ROOTS) {
    for (const filePath of await listRegularFiles(path.join(configDir, ...relativeRoot.split('/')))) {
      paths.add(portableRelative(configDir, filePath))
    }
  }
  const existingPaths = [...paths].sort()
  const backupFiles: BackupFile[] = []
  for (const relativePath of existingPaths) {
    const isFixed = (FIXED_MUTABLE_FILES as readonly string[]).includes(relativePath)
    const isMutableJson = [...MUTABLE_JSON_ROOTS].some(root => relativePath.startsWith(`${root}/`)) && relativePath.endsWith('.json')
    if (!isFixed && !isMutableJson) continue
    const info = await fs.stat(absoluteFromRelative(configDir, relativePath))
    backupFiles.push({ path: relativePath, mode: info.mode & 0o777 })
  }
  return { existingPaths, backupFiles }
}

async function createBackup(configDir: string, backupsRoot: string, backupId: string): Promise<MigrationJournal> {
  const { existingPaths, backupFiles } = await inventory(configDir)
  const backupDir = path.join(backupsRoot, backupId)
  await fs.mkdir(path.join(backupDir, 'files'), { recursive: true, mode: 0o700 })
  for (const file of backupFiles) {
    const destination = path.join(backupDir, 'files', ...file.path.split('/'))
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    await fs.copyFile(absoluteFromRelative(configDir, file.path), destination)
    await fs.chmod(destination, 0o600)
  }
  const journal: MigrationJournal = {
    schema_version: 1,
    target_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
    backup_id: backupId,
    existing_paths: existingPaths,
    backed_up_files: backupFiles,
  }
  await atomicWriteJson(path.join(backupDir, 'manifest.json'), journal)
  return journal
}

function parseJournal(value: unknown): MigrationJournal {
  if (!isRecord(value)
    || value.schema_version !== 1
    || !Number.isSafeInteger(value.target_version)
    || (value.target_version as number) < 1
    || (value.target_version as number) > CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION
    || typeof value.backup_id !== 'string'
    || !BACKUP_ID.test(value.backup_id)
    || !Array.isArray(value.existing_paths)
    || !value.existing_paths.every(item => typeof item === 'string')
    || !Array.isArray(value.backed_up_files)
    || !value.backed_up_files.every(item => isRecord(item) && typeof item.path === 'string' && Number.isSafeInteger(item.mode))) {
    throw new Error('PRODUCT_STORAGE_MIGRATION_JOURNAL_INVALID')
  }
  return value as MigrationJournal
}

async function restoreBackup(configDir: string, backupsRoot: string, journal: MigrationJournal): Promise<void> {
  const existing = new Set(journal.existing_paths)
  const current = await inventory(configDir)
  for (const relativePath of current.existingPaths.reverse()) {
    if (!existing.has(relativePath)) await fs.rm(absoluteFromRelative(configDir, relativePath), { force: true })
  }
  for (const file of journal.backed_up_files) {
    const source = path.join(backupsRoot, journal.backup_id, 'files', ...file.path.split('/'))
    const destination = absoluteFromRelative(configDir, file.path)
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    const temporary = `${destination}.rollback.${process.pid}.${randomBytes(4).toString('hex')}`
    await fs.copyFile(source, temporary)
    await fs.chmod(temporary, file.mode)
    await fs.rename(temporary, destination)
  }
}

function parseState(value: unknown): MigrationState | null {
  if (value === undefined) return null
  if (!isRecord(value)
    || value.schema_version !== 1
    || !Number.isSafeInteger(value.completed_version)
    || typeof value.oldest_supported_product_version !== 'string'
    || typeof value.completed_at !== 'string'
    || typeof value.backup_id !== 'string') {
    throw new Error('PRODUCT_STORAGE_MIGRATION_STATE_INVALID')
  }
  if ((value.completed_version as number) > CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION) {
    throw new Error('UNSUPPORTED_PRODUCT_STORAGE_SCHEMA')
  }
  return value as MigrationState
}

export class ProductStorageMigrationCoordinator {
  private promise: Promise<ProductStorageMigrationReport> | null = null
  private readonly now: () => Date

  constructor(
    private readonly configDir: string,
    private readonly deps: ProductStorageMigrationDependencies,
  ) {
    this.now = deps.now ?? (() => new Date())
  }

  ensureUpgraded(): Promise<ProductStorageMigrationReport> {
    this.promise ??= this.run()
    return this.promise
  }

  private async run(): Promise<ProductStorageMigrationReport> {
    const productDir = path.join(this.configDir, 'billiardbuddy')
    const statePath = path.join(productDir, 'storage-migration-state.json')
    const journalPath = path.join(productDir, 'storage-migration-journal.json')
    const backupsRoot = path.join(productDir, 'storage-migration-backups')
    await fs.mkdir(productDir, { recursive: true, mode: 0o700 })

    let state = parseState(await readJsonIfPresent(statePath))
    const journalValue = await readJsonIfPresent(journalPath)
    if (journalValue !== undefined) {
      const journal = parseJournal(journalValue)
      if ((state?.completed_version ?? 0) < journal.target_version) {
        await restoreBackup(this.configDir, backupsRoot, journal)
      }
      await fs.rm(journalPath, { force: true })
      state = parseState(await readJsonIfPresent(statePath))
    }
    if (state?.completed_version === CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION) {
      return { version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION, migrated: false }
    }

    await preflightSupportedSchemas(this.configDir)
    const timestamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const backupId = `v${CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION}-${timestamp}-${randomBytes(4).toString('hex')}`
    const journal = await createBackup(this.configDir, backupsRoot, backupId)
    await atomicWriteJson(journalPath, journal)

    let completed: MigrationState
    try {
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['product-tasks', this.deps.migrateProductTasks],
        ['media', this.deps.migrateMedia],
        ['voice', this.deps.migrateVoice ?? (async () => undefined)],
        ['scheduled-tasks', this.deps.migrateScheduledTasks],
        ['scheduled-task-runs', this.deps.migrateScheduledTaskRuns],
      ]
      for (const [name, migrate] of steps) {
        await migrate()
        await this.deps.afterStep?.(name)
      }
      completed = {
        schema_version: 1,
        completed_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
        oldest_supported_product_version: OLDEST_SUPPORTED_PRODUCT_VERSION,
        completed_at: this.now().toISOString(),
        backup_id: backupId,
      }
      await atomicWriteJson(statePath, completed)
    } catch (error) {
      await restoreBackup(this.configDir, backupsRoot, journal)
      await fs.rm(journalPath, { force: true })
      throw error
    }

    // The state file is the commit point. If journal cleanup is interrupted,
    // the next startup sees the completed state and removes it without rollback.
    await fs.rm(journalPath, { force: true }).catch(() => undefined)
    return { version: completed.completed_version, migrated: true, backup_id: backupId }
  }
}
