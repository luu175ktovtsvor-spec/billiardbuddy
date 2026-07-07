import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CURRENT_SCHEMA_VERSION = 1
const MAX_HISTORY_EVENTS = 80

export type ProviderFailureCategory = 'configuration' | 'rate_limit' | 'transient'
export type ProviderHealthHistoryKind = 'failure' | 'success' | 'clear'

export interface ProviderHealthEntry {
  key: string
  failureCount: number
  cooldownUntil: number
  label: string
  lastError: string
  failureCategory?: ProviderFailureCategory
  updatedAt: string
}

export interface ProviderHealthHistoryEvent {
  kind: ProviderHealthHistoryKind
  key: string
  label: string
  ts: string
  failureCount?: number
  failureCategory?: ProviderFailureCategory
  error?: string
}

interface ProviderHealthIndex {
  schemaVersion: number
  entries: ProviderHealthEntry[]
  history?: ProviderHealthHistoryEvent[]
}

export class ProviderHealthStore {
  private readonly path: string
  private loaded = false
  private entries = new Map<string, ProviderHealthEntry>()
  private history: ProviderHealthHistoryEvent[] = []

  constructor(rootDir: string) {
    this.path = join(rootDir, 'provider-health.json')
  }

  get(key: string, now = Date.now()): ProviderHealthEntry | undefined {
    this.ensureLoaded()
    const entry = this.entries.get(key)
    if (entry && entry.cooldownUntil <= now) {
      this.entries.delete(key)
      this.flush()
      return undefined
    }
    return entry
  }

  recordFailure(key: string, label: string, lastError: string, now = Date.now()): ProviderHealthEntry {
    this.ensureLoaded()
    const previous = this.entries.get(key)
    const failureCount = Math.min(5, (previous?.failureCount ?? 0) + 1)
    const failureCategory = classifyProviderFailure(lastError)
    const cooldownMs = providerFailureCooldownMs(failureCategory, failureCount)
    const entry: ProviderHealthEntry = {
      key,
      failureCount,
      cooldownUntil: now + cooldownMs,
      label,
      lastError,
      failureCategory,
      updatedAt: new Date(now).toISOString(),
    }
    this.entries.set(key, entry)
    this.pushHistory({
      kind: 'failure',
      key,
      label,
      ts: entry.updatedAt,
      failureCount,
      failureCategory,
      error: lastError,
    })
    this.flush()
    return entry
  }

  recordSuccess(key: string): void {
    this.ensureLoaded()
    const previous = this.entries.get(key)
    if (!previous || !this.entries.delete(key)) return
    this.pushHistory({
      kind: 'success',
      key,
      label: previous.label,
      ts: new Date().toISOString(),
    })
    this.flush()
  }

  clear(key: string): boolean {
    this.ensureLoaded()
    const previous = this.entries.get(key)
    const removed = this.entries.delete(key)
    if (removed && previous) {
      this.pushHistory({
        kind: 'clear',
        key,
        label: previous.label,
        ts: new Date().toISOString(),
        failureCount: previous.failureCount,
        failureCategory: previous.failureCategory,
      })
    }
    if (removed) this.flush()
    return removed
  }

  clearAll(keys?: string[]): number {
    this.ensureLoaded()
    const targets = keys ? new Set(keys) : null
    let removed = 0
    for (const key of [...this.entries.keys()]) {
      if (targets && !targets.has(key)) continue
      const previous = this.entries.get(key)
      this.entries.delete(key)
      removed += 1
      if (previous) {
        this.pushHistory({
          kind: 'clear',
          key,
          label: previous.label,
          ts: new Date().toISOString(),
          failureCount: previous.failureCount,
          failureCategory: previous.failureCategory,
        })
      }
    }
    if (removed > 0) this.flush()
    return removed
  }

  list(now = Date.now()): ProviderHealthEntry[] {
    this.ensureLoaded()
    let changed = false
    for (const [key, entry] of this.entries) {
      if (entry.cooldownUntil <= now) {
        this.entries.delete(key)
        changed = true
      }
    }
    if (changed) this.flush()
    return [...this.entries.values()]
  }

  listHistory(limit = 20): ProviderHealthHistoryEvent[] {
    this.ensureLoaded()
    const safeLimit = Math.max(1, Math.min(MAX_HISTORY_EVENTS, Math.floor(limit)))
    return this.history.slice(-safeLimit).reverse()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (!isIndex(parsed)) return
      for (const entry of parsed.entries) this.entries.set(entry.key, entry)
      this.history = (parsed.history ?? []).filter(isHistoryEvent).slice(-MAX_HISTORY_EVENTS)
    } catch {
      this.entries.clear()
      this.history = []
    }
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const index: ProviderHealthIndex = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        entries: [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
        history: this.history.slice(-MAX_HISTORY_EVENTS),
      }
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.path)
    } catch {
      // provider health 是运行时优化;落盘失败时退化成当前进程内记忆,不能影响对话。
    }
  }

  private pushHistory(event: ProviderHealthHistoryEvent): void {
    this.history.push(event)
    if (this.history.length > MAX_HISTORY_EVENTS) this.history = this.history.slice(-MAX_HISTORY_EVENTS)
  }
}

function isIndex(value: unknown): value is ProviderHealthIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== CURRENT_SCHEMA_VERSION || !Array.isArray(record.entries)) return false
  return record.entries.every(isEntry)
}

function isEntry(value: unknown): value is ProviderHealthEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.key === 'string' &&
    typeof record.failureCount === 'number' &&
    Number.isFinite(record.failureCount) &&
    record.failureCount > 0 &&
    typeof record.cooldownUntil === 'number' &&
    Number.isFinite(record.cooldownUntil) &&
    typeof record.label === 'string' &&
    typeof record.lastError === 'string' &&
    (record.failureCategory === undefined || record.failureCategory === 'configuration' || record.failureCategory === 'rate_limit' || record.failureCategory === 'transient') &&
    typeof record.updatedAt === 'string'
}

function isHistoryEvent(value: unknown): value is ProviderHealthHistoryEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (record.kind === 'failure' || record.kind === 'success' || record.kind === 'clear') &&
    typeof record.key === 'string' &&
    typeof record.label === 'string' &&
    typeof record.ts === 'string' &&
    (record.failureCount === undefined || (typeof record.failureCount === 'number' && Number.isFinite(record.failureCount))) &&
    (record.failureCategory === undefined || record.failureCategory === 'configuration' || record.failureCategory === 'rate_limit' || record.failureCategory === 'transient') &&
    (record.error === undefined || typeof record.error === 'string')
}

export function classifyProviderFailure(message: string): ProviderFailureCategory {
  const text = message.toLowerCase()
  if (/\b(401|403|404)\b/.test(text) ||
    /unauthori[sz]ed|forbidden|invalid[_\s-]?api[_\s-]?key|authentication|permission denied|model .*not found|not found/.test(text)) {
    return 'configuration'
  }
  if (/\b429\b|rate[_\s-]?limit|too many requests|insufficient[_\s-]?quota|quota exceeded|throttl/.test(text)) {
    return 'rate_limit'
  }
  return 'transient'
}

export function providerFailureCooldownMs(category: ProviderFailureCategory, failureCount: number): number {
  const count = Math.max(1, Math.min(5, Math.floor(failureCount)))
  if (category === 'configuration') return Math.min(60 * 60_000, 10 * 60_000 * 2 ** (count - 1))
  if (category === 'rate_limit') return Math.min(15 * 60_000, 2 * 60_000 * 2 ** (count - 1))
  return Math.min(5 * 60_000, 30_000 * 2 ** (count - 1))
}
