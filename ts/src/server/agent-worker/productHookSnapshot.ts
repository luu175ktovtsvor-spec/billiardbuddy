import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'jsonc-parser'
import { findProductGitRoot } from '../product/productGit.js'
import { listProductPlugins, productPluginHookFiles } from '../services/productPluginRegistry.js'

export type ProductHookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PreCompact' | 'PostCompact' | 'Stop'
export type ProductHookCommand =
  | { type: 'command'; command: string; shell?: 'sh' | 'powershell'; timeout?: number; async?: boolean; asyncRewake?: boolean; if?: string; once?: boolean }
  | { type: 'http'; url: string; headers?: Record<string, string>; timeout?: number; if?: string; once?: boolean }
  | { type: 'prompt'; prompt: string; model?: string; timeout?: number; if?: string; once?: boolean }
  | { type: 'agent'; prompt: string; model?: string; timeout?: number; if?: string; once?: boolean }
export type ProductHookMatcher = { matcher?: string; hooks: ProductHookCommand[] }
export type ProductHooks = Partial<Record<ProductHookEvent, ProductHookMatcher[]>>

const PRODUCT_HOOK_EVENTS = new Set<ProductHookEvent>(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact', 'Stop'])

const SETTINGS_NAMES = [
  path.join('.BilliardBuddy', 'settings.json'),
  path.join('.BilliardBuddy', 'settings.local.json'),
] as const
const MAX_SETTINGS_FILES = 32
const MAX_HOOK_MATCHERS = 256
const MAX_HOOK_COMMANDS = 512
const MAX_SETTINGS_BYTES = 1024 * 1024

export type ProductHookSnapshot = {
  hooks: ProductHooks
  disableAllHooks?: boolean
  digest: string
  sourceCount: number
  matcherCount: number
  commandCount: number
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function directoriesFromRoot(root: string, workDir: string): string[] {
  const relative = path.relative(root, workDir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return []
  const directories = [root]
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    directories.push(current)
  }
  return directories
}

function appendMatchers(
  target: ProductHooks,
  source: ProductHooks,
  remainingMatchers: number,
  remainingCommands: number,
): { matcherCount: number; commandCount: number } {
  let matcherCount = 0
  let commandCount = 0
  for (const [event, rawMatchers] of Object.entries(source)) {
    if (matcherCount >= remainingMatchers || commandCount >= remainingCommands) break
    const accepted: ProductHookMatcher[] = []
    for (const matcher of rawMatchers ?? []) {
      if (matcherCount >= remainingMatchers || commandCount >= remainingCommands) break
      const availableCommands = remainingCommands - commandCount
      const hooks = matcher.hooks.slice(0, availableCommands)
      if (hooks.length === 0) continue
      accepted.push({ ...matcher, hooks })
      matcherCount += 1
      commandCount += hooks.length
    }
    if (accepted.length === 0) continue
    const key = event as ProductHookEvent
    target[key] = [...(target[key] ?? []), ...accepted]
  }
  return { matcherCount, commandCount }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function hookCommand(value: unknown): ProductHookCommand | null {
  const input = record(value)
  if (!input || typeof input.type !== 'string') return null
  const timeout = input.timeout === undefined ? undefined : Number(input.timeout)
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 1 || timeout > 600)) return null
  const condition = input.if === undefined ? undefined : typeof input.if === 'string' && input.if.length <= 2_000 ? input.if : null
  if (condition === null || (input.once !== undefined && typeof input.once !== 'boolean')) return null
  const common = { ...(timeout ? { timeout } : {}), ...(condition ? { if: condition } : {}), ...(input.once === true ? { once: true } : {}) }
  if (input.type === 'command' && typeof input.command === 'string' && input.command.trim() && input.command.length <= 100_000) {
    if (input.shell !== undefined && input.shell !== 'sh' && input.shell !== 'powershell') return null
    const shell = input.shell as 'sh' | 'powershell' | undefined
    return { type: 'command', command: input.command, ...(shell ? { shell } : {}), ...common, ...(input.async === true ? { async: true } : {}), ...(input.asyncRewake === true ? { asyncRewake: true } : {}) }
  }
  if (input.type === 'http' && typeof input.url === 'string' && input.url.length <= 8_192) {
    const headers = input.headers === undefined ? undefined : record(input.headers)
    if (headers && Object.values(headers).some(item => typeof item !== 'string' || item.length > 8_192)) return null
    return { type: 'http', url: input.url, ...(headers ? { headers: headers as Record<string, string> } : {}), ...common }
  }
  if ((input.type === 'prompt' || input.type === 'agent') && typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= 100_000 && (input.model === undefined || typeof input.model === 'string')) {
    return { type: input.type, prompt: input.prompt, ...(typeof input.model === 'string' ? { model: input.model } : {}), ...common }
  }
  return null
}

function productSettings(value: string): { hooks: ProductHooks; disableAllHooks?: boolean } | null {
  const errors: import('jsonc-parser').ParseError[] = []
  const root = record(parse(value, errors, { allowTrailingComma: true, disallowComments: false }))
  if (!root || errors.length) return null
  const hooksRoot = root.hooks === undefined ? {} : record(root.hooks)
  if (!hooksRoot) return null
  const hooks: ProductHooks = {}
  for (const [event, rawMatchers] of Object.entries(hooksRoot)) {
    if (!PRODUCT_HOOK_EVENTS.has(event as ProductHookEvent) || !Array.isArray(rawMatchers)) continue
    const matchers: ProductHookMatcher[] = []
    for (const raw of rawMatchers) {
      const matcher = record(raw)
      if (!matcher || (matcher.matcher !== undefined && typeof matcher.matcher !== 'string') || !Array.isArray(matcher.hooks)) continue
      const commands = matcher.hooks.map(hookCommand).filter((hook): hook is ProductHookCommand => Boolean(hook))
      if (commands.length) matchers.push({ ...(typeof matcher.matcher === 'string' ? { matcher: matcher.matcher.slice(0, 2_000) } : {}), hooks: commands })
    }
    if (matchers.length) hooks[event as ProductHookEvent] = matchers
  }
  return { hooks, ...(typeof root.disableAllHooks === 'boolean' ? { disableAllHooks: root.disableAllHooks } : {}) }
}

export async function inspectProductPluginHookFile(file: string, pluginRoot: string): Promise<{ matcherCount: number; commandCount: number } | null> {
  try {
    const [root, canonical] = await Promise.all([fs.promises.realpath(pluginRoot), fs.promises.realpath(file)])
    if (!isWithinRoot(root, canonical)) return null
    const stat = await fs.promises.lstat(canonical)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) return null
    const parsed = productSettings(await fs.promises.readFile(canonical, 'utf8'))
    if (!parsed) return null
    const matchers = Object.values(parsed.hooks).flatMap(value => value ?? [])
    return { matcherCount: matchers.length, commandCount: matchers.reduce((sum, matcher) => sum + matcher.hooks.length, 0) }
  } catch { return null }
}

/** Resolve one immutable, checkout-contained Hook configuration for a ProductTask. */
export async function createProductHookSnapshot(workDir: string): Promise<ProductHookSnapshot> {
  const discoveredRoot = findProductGitRoot(workDir) ?? workDir
  let root: string
  let active: string
  try {
    root = fs.realpathSync(discoveredRoot)
    active = fs.realpathSync(workDir)
  } catch {
    return emptyProductHookSnapshot()
  }
  if (!isWithinRoot(root, active)) return emptyProductHookSnapshot()

  const hooks: ProductHooks = {}
  const sources: string[] = []
  const seen = new Set<string>()
  let disableAllHooks: boolean | undefined
  let matcherCount = 0
  let commandCount = 0

  outer: for (const directory of directoriesFromRoot(root, active)) {
    for (const name of SETTINGS_NAMES) {
      if (sources.length >= MAX_SETTINGS_FILES) break outer
      const candidate = path.join(directory, name)
      let canonical: string
      try {
        const stat = fs.statSync(candidate)
        if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) continue
        canonical = fs.realpathSync(candidate)
      } catch {
        continue
      }
      if (!isWithinRoot(root, canonical) || seen.has(canonical)) continue
      seen.add(canonical)
      let parsed: ReturnType<typeof productSettings>
      try { parsed = productSettings(fs.readFileSync(canonical, 'utf8')) } catch { parsed = null }
      if (!parsed) continue
      sources.push(path.relative(root, canonical))
      if (typeof parsed.disableAllHooks === 'boolean') disableAllHooks = parsed.disableAllHooks
      const appended = appendMatchers(
        hooks,
        parsed.hooks ?? {},
        MAX_HOOK_MATCHERS - matcherCount,
        MAX_HOOK_COMMANDS - commandCount,
      )
      matcherCount += appended.matcherCount
      commandCount += appended.commandCount
    }
  }

  const plugins = await listProductPlugins(workDir).catch(() => [])
  pluginLoop: for (const plugin of plugins.filter(value => value.enabled)) {
    for (const candidate of productPluginHookFiles(plugin)) {
      if (sources.length >= MAX_SETTINGS_FILES || matcherCount >= MAX_HOOK_MATCHERS || commandCount >= MAX_HOOK_COMMANDS) break pluginLoop
      let canonical: string
      try {
        const stat = fs.lstatSync(candidate)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) continue
        canonical = fs.realpathSync(candidate)
        if (!isWithinRoot(fs.realpathSync(plugin.root), canonical)) continue
      } catch { continue }
      let parsed: ReturnType<typeof productSettings>
      try { parsed = productSettings(fs.readFileSync(canonical, 'utf8')) } catch { parsed = null }
      if (!parsed) continue
      sources.push(`plugin:${plugin.id}:${path.relative(plugin.root, canonical)}`)
      const appended = appendMatchers(hooks, parsed.hooks, MAX_HOOK_MATCHERS - matcherCount, MAX_HOOK_COMMANDS - commandCount)
      matcherCount += appended.matcherCount
      commandCount += appended.commandCount
    }
  }

  const digest = createHash('sha256')
    .update(JSON.stringify({ sources, hooks, disableAllHooks }))
    .digest('hex')
  return {
    hooks,
    ...(disableAllHooks !== undefined ? { disableAllHooks } : {}),
    digest,
    sourceCount: sources.length,
    matcherCount,
    commandCount,
  }
}

function emptyProductHookSnapshot(): ProductHookSnapshot {
  const hooks: ProductHooks = {}
  return {
    hooks,
    digest: createHash('sha256').update(JSON.stringify({ sources: [], hooks })).digest('hex'),
    sourceCount: 0,
    matcherCount: 0,
    commandCount: 0,
  }
}
