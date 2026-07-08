import { createHash } from 'node:crypto'
import type { Message } from '../types/message'
import type { ModelUsage } from '../types/model'
import type { ToolSpec } from '../tools/Tool'

export interface PromptCacheStateSnapshot {
  trackingKey?: string
  system: string
  tools: ToolSpec[]
  model?: string
}

export interface PromptCacheBreakEvent {
  reason: string
  previousCacheReadTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  tokenDrop: number
  callNumber: number
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  addedToolCount: number
  removedToolCount: number
  changedToolSchemas: string[]
  systemCharDelta: number
  timeSinceLastAssistantMs: number | null
}

interface PromptCacheState {
  systemHash: string
  toolsHash: string
  perToolHashes: Record<string, string>
  toolNames: string[]
  systemCharCount: number
  model: string
  callCount: number
  previousCacheReadTokens: number | null
  pendingChanges: PendingChanges | null
}

interface PendingChanges {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  addedToolCount: number
  removedToolCount: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  systemCharDelta: number
  previousModel: string
  newModel: string
}

const states = new Map<string, PromptCacheState>()

const MAX_TRACKED_KEYS = 20
const MIN_CACHE_MISS_TOKENS = 2_000
const CACHE_DROP_RATIO = 0.95
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

function perToolHashes(tools: ToolSpec[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const tool of tools) {
    out[tool.name] = hash({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })
  }
  return out
}

function lastAssistantAgeMs(messages: Message[]): number | null {
  const lastAssistantIndex = messages.findLastIndex(message => message.role === 'assistant')
  if (lastAssistantIndex === -1) return null
  const followingMessages = messages.length - lastAssistantIndex - 1
  return followingMessages > 0 ? 0 : null
}

function reasonFor(changes: PendingChanges | null, timeSinceLastAssistantMs: number | null): string {
  const parts: string[] = []
  if (changes?.modelChanged) parts.push(`model changed (${changes.previousModel || 'default'} -> ${changes.newModel || 'default'})`)
  if (changes?.systemPromptChanged) {
    const delta = changes.systemCharDelta
    parts.push(`system prompt changed${delta === 0 ? '' : delta > 0 ? ` (+${delta} chars)` : ` (${delta} chars)`}`)
  }
  if (changes?.toolSchemasChanged) {
    const setDiff = changes.addedToolCount || changes.removedToolCount
      ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
      : ' (tool prompt/schema changed, same tool set)'
    parts.push(`tools changed${setDiff}`)
  }
  if (parts.length > 0) return parts.join(', ')
  if (timeSinceLastAssistantMs !== null && timeSinceLastAssistantMs > CACHE_TTL_1HOUR_MS) return 'possible 1h TTL expiry (prompt unchanged)'
  if (timeSinceLastAssistantMs !== null && timeSinceLastAssistantMs > CACHE_TTL_5MIN_MS) return 'possible 5min TTL expiry (prompt unchanged)'
  if (timeSinceLastAssistantMs !== null) return 'likely server-side (prompt unchanged, <5min gap)'
  return 'unknown cause'
}

export function recordPromptCacheState(snapshot: PromptCacheStateSnapshot): void {
  const key = snapshot.trackingKey?.trim()
  if (!key) return

  const toolNames = snapshot.tools.map(tool => tool.name)
  const nextPerToolHashes = perToolHashes(snapshot.tools)
  const systemHash = hash(snapshot.system)
  const toolsHash = hash(snapshot.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })))
  const systemCharCount = snapshot.system.length
  const model = snapshot.model ?? ''
  const prev = states.get(key)

  if (!prev) {
    while (states.size >= MAX_TRACKED_KEYS) {
      const oldest = states.keys().next().value
      if (oldest === undefined) break
      states.delete(oldest)
    }
    states.set(key, {
      systemHash,
      toolsHash,
      perToolHashes: nextPerToolHashes,
      toolNames,
      systemCharCount,
      model,
      callCount: 1,
      previousCacheReadTokens: null,
      pendingChanges: null,
    })
    return
  }

  prev.callCount += 1
  const systemPromptChanged = systemHash !== prev.systemHash
  const toolSchemasChanged = toolsHash !== prev.toolsHash
  const modelChanged = model !== prev.model

  if (systemPromptChanged || toolSchemasChanged || modelChanged) {
    const prevToolSet = new Set(prev.toolNames)
    const nextToolSet = new Set(toolNames)
    const addedTools = toolNames.filter(name => !prevToolSet.has(name))
    const removedTools = prev.toolNames.filter(name => !nextToolSet.has(name))
    const changedToolSchemas = toolSchemasChanged
      ? toolNames.filter(name => prevToolSet.has(name) && nextPerToolHashes[name] !== prev.perToolHashes[name])
      : []
    prev.pendingChanges = {
      systemPromptChanged,
      toolSchemasChanged,
      modelChanged,
      addedToolCount: addedTools.length,
      removedToolCount: removedTools.length,
      addedTools,
      removedTools,
      changedToolSchemas,
      systemCharDelta: systemCharCount - prev.systemCharCount,
      previousModel: prev.model,
      newModel: model,
    }
  } else {
    prev.pendingChanges = null
  }

  prev.systemHash = systemHash
  prev.toolsHash = toolsHash
  prev.perToolHashes = nextPerToolHashes
  prev.toolNames = toolNames
  prev.systemCharCount = systemCharCount
  prev.model = model
}

export function checkPromptCacheBreak(trackingKey: string | undefined, usage: ModelUsage | undefined, messages: Message[]): PromptCacheBreakEvent | null {
  const key = trackingKey?.trim()
  if (!key || !usage) return null
  const state = states.get(key)
  if (!state) return null

  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
  const previous = state.previousCacheReadTokens
  state.previousCacheReadTokens = cacheReadTokens
  if (previous === null) {
    state.pendingChanges = null
    return null
  }

  const tokenDrop = previous - cacheReadTokens
  if (cacheReadTokens >= previous * CACHE_DROP_RATIO || tokenDrop < MIN_CACHE_MISS_TOKENS) {
    state.pendingChanges = null
    return null
  }

  const changes = state.pendingChanges
  const timeSinceLastAssistantMs = lastAssistantAgeMs(messages)
  const event: PromptCacheBreakEvent = {
    reason: reasonFor(changes, timeSinceLastAssistantMs),
    previousCacheReadTokens: previous,
    cacheReadTokens,
    cacheCreationTokens,
    tokenDrop,
    callNumber: state.callCount,
    systemPromptChanged: changes?.systemPromptChanged ?? false,
    toolSchemasChanged: changes?.toolSchemasChanged ?? false,
    modelChanged: changes?.modelChanged ?? false,
    addedToolCount: changes?.addedToolCount ?? 0,
    removedToolCount: changes?.removedToolCount ?? 0,
    changedToolSchemas: (changes?.changedToolSchemas ?? []).map(sanitizeToolName),
    systemCharDelta: changes?.systemCharDelta ?? 0,
    timeSinceLastAssistantMs,
  }
  state.pendingChanges = null
  return event
}

export function notifyPromptCacheCompaction(trackingKey: string | undefined): void {
  const key = trackingKey?.trim()
  const state = key ? states.get(key) : undefined
  if (state) {
    state.previousCacheReadTokens = null
    state.pendingChanges = null
  }
}

export function formatPromptCacheBreak(event: PromptCacheBreakEvent): string {
  return [
    '[PROMPT CACHE BREAK]',
    event.reason,
    `cache read: ${event.previousCacheReadTokens} -> ${event.cacheReadTokens}`,
    `creation: ${event.cacheCreationTokens}`,
    `drop: ${event.tokenDrop}`,
    `call #${event.callNumber}`,
  ].join(' ')
}

export function resetPromptCacheBreakDetection(): void {
  states.clear()
}
