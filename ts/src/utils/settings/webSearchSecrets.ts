import { existsSync, readFileSync } from 'node:fs'
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
