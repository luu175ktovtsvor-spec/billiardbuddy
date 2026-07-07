import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { parseHookDecisionJSON, type HookDecision, type HookEvent, type HookPayload, type HookRegistry, type HookRule } from './hooks'
import type { ToolContext } from '../tools/Tool'

const HOOK_EVENTS = new Set<HookEvent>(['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'SessionStart', 'SubagentStart', 'SubagentStop'])

interface RawHookRule {
  event?: unknown
  matcher?: unknown
  decision?: unknown
  decisions?: unknown
}

interface RawCommandHook {
  type?: unknown
  command?: unknown
  timeout?: unknown
  decision?: unknown
  decisions?: unknown
}

interface RawHttpHook {
  type?: unknown
  url?: unknown
  timeout?: unknown
  headers?: unknown
  allowedEnvVars?: unknown
  decision?: unknown
  decisions?: unknown
}

export interface NormalizeHookRegistryOptions {
  agentFrontmatter?: boolean
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

function targetEvent(event: HookEvent, options?: NormalizeHookRegistryOptions): HookEvent {
  return options?.agentFrontmatter && event === 'Stop' ? 'SubagentStop' : event
}

function normalizeRule(raw: RawHookRule, options?: NormalizeHookRegistryOptions): HookRule | null {
  if (typeof raw.event !== 'string' || !HOOK_EVENTS.has(raw.event as HookEvent)) return null
  const decisions = normalizeDecisionList(raw.decisions ?? raw.decision)
  if (decisions.length === 0) return null
  const matcher = typeof raw.matcher === 'string' && raw.matcher.trim() ? raw.matcher.trim() : undefined
  return {
    event: targetEvent(raw.event as HookEvent, options),
    matcher,
    handler: () => decisions,
  }
}

function normalizeFlatRules(value: unknown, options?: NormalizeHookRegistryOptions): HookRule[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map(rule => normalizeRule(rule as RawHookRule, options))
    .filter((rule): rule is HookRule => !!rule)
}

function commandHookPayload(payload: HookPayload, ctx: ToolContext): Record<string, unknown> {
  return {
    hook_event_name: payload.event,
    session_id: payload.sessionId ?? ctx.conversationId ?? '',
    cwd: ctx.workspace.root,
    permission_mode: ctx.permissionMode,
    ...(payload.toolName ? { tool_name: payload.toolName } : {}),
    ...(payload.input !== undefined ? { tool_input: payload.input } : {}),
    ...(payload.output !== undefined ? { tool_response: payload.output, last_assistant_message: payload.output } : {}),
    ...(payload.userPrompt !== undefined ? { prompt: payload.userPrompt } : {}),
    ...(payload.agentId ? { agent_id: payload.agentId } : {}),
    ...(payload.agentType ? { agent_type: payload.agentType } : {}),
  }
}

function commandTimeoutMs(value: unknown): number {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return 120_000
  return Math.min(Math.max(Math.round(seconds * 1000), 1000), 600_000)
}

function hookTimeoutMs(value: unknown, fallbackMs: number): number {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs
  return Math.min(Math.max(Math.round(seconds * 1000), 1000), 600_000)
}

function hookSpecificDecisions(raw: Record<string, unknown>): HookDecision[] {
  const out: HookDecision[] = []
  if (raw.decision === 'block') out.push({ action: 'deny', message: typeof raw.reason === 'string' ? raw.reason : 'hook blocked execution' })
  if (raw.decision === 'approve') out.push({ action: 'allow', message: typeof raw.reason === 'string' ? raw.reason : undefined })
  const specific = isRecord(raw.hookSpecificOutput) ? raw.hookSpecificOutput : null
  if (specific) {
    if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) {
      out.push({ action: 'context', additionalContext: specific.additionalContext })
    }
    if ('updatedInput' in specific) {
      out.push({ action: 'modify', updatedInput: specific.updatedInput, message: typeof raw.reason === 'string' ? raw.reason : undefined })
    }
  }
  return out
}

function parseCommandHookStdout(stdout: string): HookDecision | HookDecision[] | null {
  const text = stdout.trim()
  if (!text) return null
  const direct = parseHookDecisionJSON(text)
  if (direct) return direct
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw)) return { action: 'context', additionalContext: text }
    const decisions = hookSpecificDecisions(raw)
    return decisions.length > 0 ? decisions : { action: 'context', additionalContext: text }
  } catch {
    return { action: 'context', additionalContext: text }
  }
}

async function runCommandHook(raw: RawCommandHook, payload: HookPayload, ctx: ToolContext): Promise<HookDecision | HookDecision[] | null> {
  if (typeof raw.command !== 'string' || !raw.command.trim()) return null
  const command = raw.command.trim()
  const timeoutMs = commandTimeoutMs(raw.timeout)
  const jsonInput = JSON.stringify(commandHookPayload(payload, ctx))
  return await new Promise<HookDecision | HookDecision[] | null>(resolve => {
    const child = spawn(command, {
      cwd: ctx.workspace.root,
      env: process.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (decision: HookDecision | HookDecision[] | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      resolve(decision)
    }
    const abort = () => {
      child.kill()
      settle({ action: 'deny', message: `hook command aborted: ${command}` })
    }
    timer = setTimeout(() => {
      child.kill()
      settle({ action: 'deny', message: `hook command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}` })
    }, timeoutMs)
    ctx.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => settle({ action: 'deny', message: `hook command failed: ${error.message}` }))
    child.on('close', code => {
      if (settled) return
      const output = (stderr || stdout).trim()
      if (code === 2) {
        settle({ action: 'deny', message: output || `hook command blocked: ${command}` })
        return
      }
      if (code && code !== 0) {
        settle({ action: 'context', additionalContext: `[${payload.event} command hook 非阻塞错误] ${output || `exit ${code}: ${command}`}` })
        return
      }
      settle(parseCommandHookStdout(stdout))
    })
    child.stdin?.end(jsonInput)
  })
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\x00]/g, '')
}

function interpolateAllowedEnv(value: string, allowedEnvVars: Set<string>): string {
  return sanitizeHeaderValue(value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced: string | undefined, unbraced: string | undefined) => {
    const name = braced ?? unbraced ?? ''
    return allowedEnvVars.has(name) ? process.env[name] ?? '' : ''
  }))
}

function normalizeHeaders(value: unknown, allowedEnvVars: Set<string>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!isRecord(value)) return headers
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue
    const cleanName = name.trim()
    if (!cleanName || /[\r\n\x00:]/.test(cleanName)) continue
    headers[cleanName] = interpolateAllowedEnv(raw, allowedEnvVars)
  }
  return headers
}

async function runHttpHook(raw: RawHttpHook, payload: HookPayload, ctx: ToolContext): Promise<HookDecision | HookDecision[] | null> {
  if (typeof raw.url !== 'string' || !raw.url.trim()) return null
  let url: URL
  try {
    url = new URL(raw.url.trim())
  } catch {
    return { action: 'deny', message: `http hook url invalid: ${String(raw.url)}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { action: 'deny', message: `http hook url protocol not allowed: ${url.protocol}` }
  }
  const allowedEnvVars = new Set(Array.isArray(raw.allowedEnvVars) ? raw.allowedEnvVars.filter((item): item is string => typeof item === 'string') : [])
  const timeoutMs = hookTimeoutMs(raw.timeout, 120_000)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  ctx.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: normalizeHeaders(raw.headers, allowedEnvVars),
      body: JSON.stringify(commandHookPayload(payload, ctx)),
      redirect: 'manual',
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) {
      return { action: 'context', additionalContext: `[${payload.event} http hook 非阻塞错误] HTTP ${response.status}${body.trim() ? `: ${body.trim()}` : ''}` }
    }
    return parseCommandHookStdout(body)
  } catch (error) {
    if (controller.signal.aborted) {
      return { action: 'deny', message: `http hook aborted or timed out after ${Math.round(timeoutMs / 1000)}s: ${url.toString()}` }
    }
    return { action: 'context', additionalContext: `[${payload.event} http hook 非阻塞错误] ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', abort)
  }
}

function normalizeHookCommand(event: HookEvent, matcher: string | undefined, raw: Record<string, unknown>): HookRule | null {
  const staticDecisions = normalizeDecisionList(raw.decisions ?? raw.decision ?? (raw.action ? raw : undefined))
  if (staticDecisions.length > 0) {
    return { event, matcher, handler: () => staticDecisions }
  }

  if (raw.type === 'command' && typeof raw.command === 'string' && raw.command.trim()) {
    const commandHook = raw as RawCommandHook
    return { event, matcher, handler: (payload, ctx) => runCommandHook(commandHook, payload, ctx) }
  }

  if (raw.type === 'http' && typeof raw.url === 'string' && raw.url.trim()) {
    const httpHook = raw as RawHttpHook
    return { event, matcher, handler: (payload, ctx) => runHttpHook(httpHook, payload, ctx) }
  }

  if (raw.type === 'prompt' || raw.type === 'agent') {
    const hookType = raw.type
    return {
      event,
      matcher,
      handler: () => ({ action: 'context', additionalContext: `[${event} hook] ${hookType} executor 待按 CC-Haha 继续移植,当前已保留 frontmatter 注册与匹配。` }),
    }
  }

  return null
}

function normalizeEventMap(value: unknown, options?: NormalizeHookRegistryOptions): HookRule[] {
  if (!isRecord(value)) return []
  const rules: HookRule[] = []
  for (const [eventName, matcherConfigs] of Object.entries(value)) {
    if (!HOOK_EVENTS.has(eventName as HookEvent) || !Array.isArray(matcherConfigs)) continue
    const event = targetEvent(eventName as HookEvent, options)
    for (const matcherConfig of matcherConfigs) {
      if (!isRecord(matcherConfig)) continue
      const matcher = typeof matcherConfig.matcher === 'string' && matcherConfig.matcher.trim() ? matcherConfig.matcher.trim() : undefined
      if (Array.isArray(matcherConfig.hooks)) {
        for (const hook of matcherConfig.hooks) {
          if (!isRecord(hook)) continue
          const rule = normalizeHookCommand(event, matcher, hook)
          if (rule) rules.push(rule)
        }
        continue
      }
      const rule = normalizeHookCommand(event, matcher, matcherConfig)
      if (rule) rules.push(rule)
    }
  }
  return rules
}

export function normalizeHookRegistry(value: unknown, options?: NormalizeHookRegistryOptions): HookRegistry {
  const rules: HookRule[] = []
  if (Array.isArray(value)) rules.push(...normalizeFlatRules(value, options))
  if (isRecord(value)) {
    rules.push(...normalizeFlatRules(value.rules, options))
    if (Array.isArray(value.hooks)) rules.push(...normalizeFlatRules(value.hooks, options))
    else if (isRecord(value.hooks)) rules.push(...normalizeEventMap(value.hooks, options))
    rules.push(...normalizeEventMap(value, options))
  }
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
