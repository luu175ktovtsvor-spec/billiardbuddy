import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
  OLDEST_SUPPORTED_PRODUCT_VERSION,
} from '../../src/server/services/productStorageMigrations'

type UpgradeEvidence = { original: string, expectedTaskId: string }

function productDir(configDir: string): string {
  return join(resolve(configDir), 'billiardbuddy')
}

function backupId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `v3-${timestamp}-${randomBytes(4).toString('hex')}`
}

export function seedInterruptedProductStorage(configDir: string, expectedTaskId: string): UpgradeEvidence {
  const root = productDir(configDir)
  const storePath = join(root, 'product-tasks.json')
  const original = readFileSync(storePath, 'utf8')
  const oldStore = JSON.parse(original) as { version?: unknown, tasks?: Record<string, unknown> }
  if (oldStore.version !== 4 || !oldStore.tasks?.[expectedTaskId]) {
    throw new Error('最老支持安装包没有留下可升级的真实任务状态')
  }
  const id = backupId()
  const backupDir = join(root, 'storage-migration-backups', id)
  const journal = {
    schema_version: 1,
    target_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
    backup_id: id,
    existing_paths: ['billiardbuddy/product-tasks.json'],
    backed_up_files: [{ path: 'billiardbuddy/product-tasks.json', mode: 0o600 }],
  }
  mkdirSync(join(backupDir, 'files', 'billiardbuddy'), { recursive: true })
  writeFileSync(join(backupDir, 'files', 'billiardbuddy', 'product-tasks.json'), original, { mode: 0o600 })
  writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(root, 'storage-migration-journal.json'), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(storePath, `${JSON.stringify({ ...oldStore, tasks: {} }, null, 2)}\n`, { mode: 0o600 })
  return { original, expectedTaskId }
}

export async function waitForProductStorageUpgrade(
  configDir: string,
  evidence: UpgradeEvidence,
  timeoutMs = 60_000,
): Promise<{ backupId: string, taskId: string }> {
  const root = productDir(configDir)
  const statePath = join(root, 'storage-migration-state.json')
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('迁移状态尚未生成')
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      if (state.completed_version !== CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION
        || state.oldest_supported_product_version !== OLDEST_SUPPORTED_PRODUCT_VERSION
        || typeof state.backup_id !== 'string') {
        throw new Error('迁移状态不符合发行合同')
      }
      if (existsSync(join(root, 'storage-migration-journal.json'))) throw new Error('迁移日志未完成结算')
      const store = JSON.parse(readFileSync(join(root, 'product-tasks.json'), 'utf8')) as {
        version?: unknown
        tasks?: Record<string, { title?: unknown }>
      }
      if (store.version !== 4
        || store.tasks?.[evidence.expectedTaskId]?.title !== 'Oldest supported package task') {
        throw new Error('旧任务没有迁移到当前存储版本')
      }
      const currentBackupId = state.backup_id
      const backup = readFileSync(join(
        root,
        'storage-migration-backups',
        currentBackupId,
        'files',
        'billiardbuddy',
        'product-tasks.json',
      ), 'utf8')
      if (backup !== evidence.original) throw new Error('升级备份没有保留恢复后的旧版本原始字节')
      return { backupId: currentBackupId, taskId: evidence.expectedTaskId }
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`安装包升级未在 ${timeoutMs} 毫秒内完成: ${String(lastError)}`)
}

export function verifyRollbackProductStorage(configDir: string, expectedTaskId: string): void {
  const store = JSON.parse(readFileSync(join(productDir(configDir), 'product-tasks.json'), 'utf8')) as {
    version?: unknown
    tasks?: Record<string, unknown>
  }
  if (store.version !== 4 || !store.tasks?.[expectedTaskId]) throw new Error('回退旧包后迁移数据不可读')
}

function cliValues(argv: string[]): { operation: string, configDir: string, taskId: string, evidenceFile: string } {
  const [operation, ...rest] = argv
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]
    const value = rest[index + 1]
    if (!name || !value || !['--config-dir', '--task-id', '--evidence-file'].includes(name)) {
      throw new Error('用法: bun run package-upgrade-storage.ts <seed|verify-upgrade|verify-rollback> --config-dir <path> --task-id <id> --evidence-file <path>')
    }
    values.set(name, value)
  }
  const configDir = values.get('--config-dir')
  const taskId = values.get('--task-id')
  const evidenceFile = values.get('--evidence-file')
  if (!operation || !['seed', 'verify-upgrade', 'verify-rollback'].includes(operation)
    || !configDir || !taskId || !evidenceFile) {
    throw new Error('升级存储验收参数不完整')
  }
  return { operation, configDir, taskId, evidenceFile: resolve(evidenceFile) }
}

if (import.meta.main) {
  const input = cliValues(process.argv.slice(2))
  if (input.operation === 'seed') {
    const evidence = seedInterruptedProductStorage(input.configDir, input.taskId)
    mkdirSync(dirname(input.evidenceFile), { recursive: true })
    writeFileSync(input.evidenceFile, `${JSON.stringify({
      expectedTaskId: evidence.expectedTaskId,
      originalBase64: Buffer.from(evidence.original).toString('base64'),
    })}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ seeded: true, taskId: input.taskId }))
  } else {
    const encoded = JSON.parse(readFileSync(input.evidenceFile, 'utf8')) as {
      expectedTaskId?: unknown
      originalBase64?: unknown
    }
    if (encoded.expectedTaskId !== input.taskId || typeof encoded.originalBase64 !== 'string') {
      throw new Error('升级存储验收证据不匹配')
    }
    const evidence = { expectedTaskId: input.taskId, original: Buffer.from(encoded.originalBase64, 'base64').toString() }
    if (input.operation === 'verify-upgrade') {
      console.log(JSON.stringify({ upgraded: true, ...await waitForProductStorageUpgrade(input.configDir, evidence) }))
    } else {
      verifyRollbackProductStorage(input.configDir, input.taskId)
      console.log(JSON.stringify({ rollbackReadable: true, taskId: input.taskId }))
    }
  }
}
