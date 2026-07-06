import { readFile } from 'node:fs/promises'
import type { HookDecision, HookEvent, HookRegistry, HookRule } from './hooks'

const HOOK_EVENTS = new Set<HookEvent>(['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart'])

type RawHookDecision = HookDecision | HookDecision[]

interface RawHookRule {
  event?: unknown
  matcher?: unknown
  decision?: unknown
  decisions?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDecision(value: unknown): HookDecision | null {
  if (!isRecord(value)) return null
  if (value.action === 'allow') return { action: 'allow', message: typeof value.message === 'string' ? value.message : undefined }
  if (value.action === 'deny' && typeof value.message === 'string') return { action: 'deny', message: value.message }
  if (value.action === 'context' && typeof value.additionalContext === 'string') {
    return { action: 'context', additionalContext: value.additionalContext }
  }
  if (value.action === 'modify' && 'updatedInput' in value) {
    return { action: 'modify', updatedInput: value.updatedInput, message: typeof value.message === 'string' ? value.message : undefined }
  }
  return null
}

function normalizeDecisionList(value: unknown): HookDecision[] {
  if (Array.isArray(value)) return value.map(normalizeDecision).filter((d): d is HookDecision => !!d)
  const single = normalizeDecision(value)
  return single ? [single] : []
}

function normalizeRule(raw: RawHookRule): HookRule | null {
  if (typeof raw.event !== 'string' || !HOOK_EVENTS.has(raw.event as HookEvent)) return null
  const decisions = normalizeDecisionList(raw.decisions ?? raw.decision)
  if (decisions.length === 0) return null
  const matcher = typeof raw.matcher === 'string' && raw.matcher.trim() ? raw.matcher.trim() : undefined
  return {
    event: raw.event as HookEvent,
    matcher,
    handler: () => decisions,
  }
}

export function normalizeHookRegistry(value: unknown): HookRegistry {
  const rawRules = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.hooks)
      ? value.hooks
      : isRecord(value) && Array.isArray(value.rules)
        ? value.rules
        : []
  const rules = rawRules
    .filter(isRecord)
    .map(rule => normalizeRule(rule as RawHookRule))
    .filter((rule): rule is HookRule => !!rule)
  return { rules }
}

export async function loadHookRegistryFile(path: string | undefined): Promise<HookRegistry | undefined> {
  if (!path) return undefined
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const registry = normalizeHookRegistry(JSON.parse(raw) as unknown)
    return registry.rules.length > 0 ? registry : undefined
  } catch {
    return undefined
  }
}

