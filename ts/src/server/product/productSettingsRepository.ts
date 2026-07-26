import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { lock } from '../../utils/lockfile.js'
import { getProductConfigDir } from './productPaths.js'

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024

function settingsPath(): string {
  return path.join(getProductConfigDir(), 'settings.json')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PRODUCT_SETTINGS_INVALID')
  return value as Record<string, unknown>
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  const stat = await fs.lstat(file).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error))
  if (!stat) return {}
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) throw new Error('PRODUCT_SETTINGS_INVALID')
  return record(JSON.parse(await fs.readFile(file, 'utf8')))
}

async function atomicWrite(file: string, value: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const existing = await fs.lstat(file).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('PRODUCT_SETTINGS_INVALID')
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', existing?.mode ?? 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
    const directory = await fs.open(path.dirname(file), fsConstants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

export class ProductSettingsRepository {
  async get(): Promise<Record<string, unknown>> {
    return readSettings(settingsPath())
  }

  async mutate(update: (current: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = settingsPath()
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const guard = path.join(path.dirname(file), '.settings.guard')
    await fs.open(guard, 'a', 0o600).then(handle => handle.close())
    const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
    try {
      const next = record(update(await readSettings(file)))
      await atomicWrite(file, next)
      return next
    } finally {
      await release()
    }
  }
}
