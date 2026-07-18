import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../envUtils.js'

export type WebSearchSecrets = {
  tavilyApiKey?: string
  braveApiKey?: string
}

function secretPath(): string {
  return join(getClaudeConfigHomeDir(), 'billiardbuddy', 'web-search-secrets.json')
}

function normalize(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parse(value: unknown): WebSearchSecrets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    ...(normalize(record.tavilyApiKey) ? { tavilyApiKey: normalize(record.tavilyApiKey) } : {}),
    ...(normalize(record.braveApiKey) ? { braveApiKey: normalize(record.braveApiKey) } : {}),
  }
}

export function readWebSearchSecretsSync(): WebSearchSecrets {
  const path = secretPath()
  if (!existsSync(path)) return {}
  try {
    return parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

export async function updateWebSearchSecrets(
  updates: { tavilyApiKey?: string | null; braveApiKey?: string | null },
): Promise<WebSearchSecrets> {
  const path = secretPath()
  let current: WebSearchSecrets = {}
  try {
    current = parse(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    // Missing or invalid secret files are replaced atomically below.
  }
  for (const key of ['tavilyApiKey', 'braveApiKey'] as const) {
    if (!(key in updates)) continue
    const value = normalize(updates[key])
    if (value) current[key] = value
    else delete current[key]
  }
  const directory = join(getClaudeConfigHomeDir(), 'billiardbuddy')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return current
}
