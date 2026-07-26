import type { ProductHarnessMessage } from '../../../shared/product/harnessMessages.js'
import axios from 'axios'
import { ssrfGuardedLookup } from '../../utils/hooks/ssrfGuard.js'
import { getProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import type { ProductHookCommand, ProductHookEvent, ProductHookSnapshot } from './productHookSnapshot.js'
import { runProductShell } from './productSandboxRunner.js'
import type { ProductToolContext } from './productTool.js'

const MAX_HOOK_CONTEXT_CHARS = 20_000
const MAX_HOOK_REASON_CHARS = 4_000
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024

export type ProductLifecycleHookResult = {
  blocked?: boolean
  reason?: string
  additionalContext?: string
}

export type ProductHarnessLifecycleHookHost = {
  sessionStart(input: { source: 'startup' | 'resume'; sessionId: string; model: string; signal: AbortSignal }): Promise<ProductLifecycleHookResult>
  userPrompt(input: { prompt: string; permissionMode: string; context: ProductToolContext }): Promise<ProductLifecycleHookResult>
  preTool(input: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string; signal: AbortSignal }): Promise<ProductLifecycleHookResult>
  postTool(input: { toolName: string; toolInput: Record<string, unknown>; toolUseId: string; success: boolean; result: unknown; signal: AbortSignal }): Promise<ProductLifecycleHookResult>
  preCompact(input: { trigger: 'manual' | 'auto'; signal: AbortSignal }): Promise<{ instructions?: string }>
  postCompact(input: { trigger: 'manual' | 'auto'; summary: string; signal: AbortSignal }): Promise<void>
  stop(input: { permissionMode: string; signal: AbortSignal; context: ProductToolContext; messages: ProductHarnessMessage[] }): Promise<ProductLifecycleHookResult>
}

type HookOutput = {
  continue?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: { hookEventName?: string; additionalContext?: string; initialUserMessage?: string }
}

function bounded(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized.slice(0, limit) : undefined
}

function parseOutput(value: string): HookOutput | undefined {
  const text = value.trim()
  if (!text.startsWith('{')) return text ? { systemMessage: text } : undefined
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as HookOutput : undefined
  } catch {
    return undefined
  }
}

function wildcardMatches(value: string, pattern: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`, 'u').test(value)
}

function hookMatches(matcher: string | undefined, value: string): boolean {
  if (!matcher) return true
  return wildcardMatches(value, matcher)
}

function hookConditionMatches(condition: string | undefined, event: ProductHookEvent, toolName: string, payload: Record<string, unknown>): boolean {
  if (!condition) return true
  if (event !== 'PreToolUse' && event !== 'PostToolUse' && event !== 'PostToolUseFailure') return false
  const parsed = condition.match(/^([A-Za-z][A-Za-z0-9:_-]*)(?:\(([\s\S]*)\))?$/)
  if (!parsed || parsed[1] !== toolName) return false
  const rule = parsed[2]?.trim()
  if (!rule) return true
  const input = payload.tool_input
  const candidates = [JSON.stringify(input)]
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const value of Object.values(input)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') candidates.push(String(value))
    }
  }
  return candidates.some(value => wildcardMatches(value, rule))
}

async function commandHook(hook: Extract<ProductHookCommand, { type: 'command' }>, cwd: string, input: string, signal: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  const envelope = getProductPermissionEnvelope()
  if (!envelope) throw new Error('PRODUCT_HOOK_PERMISSION_ENVELOPE_MISSING')
  const command = hook.shell === 'powershell'
    ? `${process.platform === 'win32' ? 'powershell' : 'pwsh'} -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(hook.command, 'utf16le').toString('base64')}`
    : hook.command
  const result = await runProductShell({
    command,
    workDir: cwd,
    timeoutMs: Math.min((hook.timeout ?? 600) * 1000, 600_000),
    signal,
    envelope,
    stdin: input,
  })
  return { code: result.exitCode, stdout: result.stdout.slice(0, MAX_HOOK_OUTPUT_BYTES), stderr: result.stderr.slice(0, MAX_HOOK_OUTPUT_BYTES) }
}

async function httpHook(hook: Extract<ProductHookCommand, { type: 'http' }>, jsonInput: string, signal: AbortSignal): Promise<{ ok: boolean; statusCode?: number; body: string; error?: string; aborted?: boolean }> {
  const envelope = getProductPermissionEnvelope()
  if (!envelope || envelope.network_scope === 'denied') return { ok: false, body: '', error: 'HTTP Hook network access is denied for this Turn' }
  let url: URL
  try { url = new URL(hook.url) } catch { return { ok: false, body: '', error: 'HTTP Hook URL is invalid' } }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    return { ok: false, body: '', error: 'HTTP Hook requires HTTPS or loopback HTTP' }
  }
  const timeout = AbortSignal.timeout(Math.min((hook.timeout ?? 600) * 1000, 600_000))
  const combined = AbortSignal.any([signal, timeout])
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  for (const [name, value] of Object.entries(hook.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return { ok: false, body: '', error: 'HTTP Hook header name is invalid' }
    headers[name] = value.replace(/[\r\n\0]/g, '')
  }
  try {
    const response = await axios.post<string>(url.toString(), jsonInput, {
      headers,
      signal: combined,
      responseType: 'text',
      validateStatus: () => true,
      maxRedirects: 0,
      maxContentLength: MAX_HOOK_OUTPUT_BYTES,
      maxBodyLength: MAX_HOOK_OUTPUT_BYTES,
      proxy: false,
      lookup: ssrfGuardedLookup,
    })
    return {
      ok: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      body: String(response.data ?? '').slice(0, MAX_HOOK_OUTPUT_BYTES),
    }
  } catch (error) {
    if (combined.aborted) return { ok: false, body: '', aborted: true }
    return { ok: false, body: '', error: error instanceof Error ? error.message.slice(0, MAX_HOOK_REASON_CHARS) : 'HTTP Hook failed' }
  }
}

export function createProductHarnessLifecycleHookHost(input: {
  snapshot: ProductHookSnapshot
  cwd: string
  evaluate?: (prompt: string, model: string | undefined, signal: AbortSignal) => Promise<{ ok: boolean; reason?: string }>
  onAsyncRewake?: (value: { event: ProductHookEvent; additionalContext?: string; reason?: string }) => void
}): ProductHarnessLifecycleHookHost {
  const completedOnceHooks = new Set<string>()
  const runningOnceHooks = new Set<string>()
  const run = async (event: ProductHookEvent, matcherValue: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<ProductLifecycleHookResult> => {
    if (input.snapshot.disableAllHooks) return {}
    const contexts: string[] = []
    let reason: string | undefined
    for (const [matcherIndex, matcher] of (input.snapshot.hooks[event] ?? []).entries()) {
      if (!hookMatches(matcher.matcher, matcherValue)) continue
      for (const [hookIndex, hook] of matcher.hooks.entries()) {
        const onceKey = `${event}:${matcherIndex}:${hookIndex}`
        if ((hook.once && (completedOnceHooks.has(onceKey) || runningOnceHooks.has(onceKey))) || !hookConditionMatches(hook.if, event, matcherValue, payload)) continue
        if (signal.aborted) throw new Error('PRODUCT_HOOK_ABORTED')
        const body = JSON.stringify({ hook_event_name: event, ...payload })
        let output: HookOutput | undefined
        let succeeded = false
        if (hook.type === 'command') {
          if (hook.async || hook.asyncRewake) {
            if (hook.once) runningOnceHooks.add(onceKey)
            const detachedSignal = AbortSignal.timeout(Math.min((hook.timeout ?? 600) * 1000, 600_000))
            void commandHook(hook, input.cwd, body, detachedSignal).then(result => {
              const parsed = parseOutput(result.stdout)
              if (hook.once && result.code === 0 && parsed?.continue !== false && parsed?.decision !== 'block') completedOnceHooks.add(onceKey)
              if (hook.asyncRewake) {
                const additionalContext = bounded(parsed?.hookSpecificOutput?.additionalContext || parsed?.hookSpecificOutput?.initialUserMessage || parsed?.systemMessage, MAX_HOOK_CONTEXT_CHARS)
                const asyncReason = result.code === 0 && parsed?.continue !== false && parsed?.decision !== 'block'
                  ? undefined
                  : bounded(parsed?.stopReason || parsed?.reason || result.stderr || `Async Hook command failed (${result.code})`, MAX_HOOK_REASON_CHARS)
                input.onAsyncRewake?.({ event, ...(additionalContext ? { additionalContext } : {}), ...(asyncReason ? { reason: asyncReason } : {}) })
              }
            }).catch(() => {
              if (hook.asyncRewake) input.onAsyncRewake?.({ event, reason: 'Async Hook command failed' })
            }).finally(() => { if (hook.once) runningOnceHooks.delete(onceKey) })
            continue
          }
          const result = await commandHook(hook, input.cwd, body, signal)
          output = parseOutput(result.stdout)
          succeeded = result.code === 0
          if (!succeeded) reason ??= bounded(result.stderr || result.stdout || `Hook command failed (${result.code})`, MAX_HOOK_REASON_CHARS)
        } else if (hook.type === 'http') {
          const result = await httpHook(hook, body, signal)
          succeeded = result.ok
          if (succeeded) output = parseOutput(result.body)
          else if (!result.aborted) reason ??= bounded(result.error || `HTTP Hook failed (${result.statusCode ?? 'network'})`, MAX_HOOK_REASON_CHARS)
        } else if (input.evaluate) {
          const prompt = hook.prompt.replaceAll('$ARGUMENTS', body)
          const evaluationSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.min((hook.timeout ?? 600) * 1000, 600_000)),
          ])
          const result = await input.evaluate(prompt, hook.model, evaluationSignal)
          succeeded = result.ok
          if (!result.ok) reason ??= bounded(result.reason || 'Prompt Hook blocked execution', MAX_HOOK_REASON_CHARS)
        } else {
          reason ??= `${hook.type === 'agent' ? 'Agent' : 'Prompt'} Hook requires an unavailable verified evaluator`
        }
        if (output?.continue === false || output?.decision === 'block') reason ??= bounded(output.stopReason || output.reason || 'Hook blocked execution', MAX_HOOK_REASON_CHARS)
        const specific = output?.hookSpecificOutput
        const context = bounded(specific?.additionalContext || specific?.initialUserMessage || output?.systemMessage, MAX_HOOK_CONTEXT_CHARS)
        if (context) contexts.push(context)
        if (hook.once && succeeded && output?.continue !== false && output?.decision !== 'block') completedOnceHooks.add(onceKey)
      }
    }
    return {
      ...(reason ? { blocked: true, reason } : {}),
      ...(contexts.length ? { additionalContext: contexts.join('\n\n').slice(0, MAX_HOOK_CONTEXT_CHARS) } : {}),
    }
  }

  return {
    sessionStart: value => run('SessionStart', value.source, { source: value.source, session_id: value.sessionId, model: value.model }, value.signal),
    userPrompt: value => run('UserPromptSubmit', value.prompt, { prompt: value.prompt, permission_mode: value.permissionMode }, value.context.abortController.signal),
    preTool: value => run('PreToolUse', value.toolName, { tool_name: value.toolName, tool_input: value.toolInput, tool_use_id: value.toolUseId }, value.signal),
    postTool: value => run(value.success ? 'PostToolUse' : 'PostToolUseFailure', value.toolName, { tool_name: value.toolName, tool_input: value.toolInput, tool_use_id: value.toolUseId, tool_response: value.result }, value.signal),
    async preCompact(value) {
      const result = await run('PreCompact', value.trigger, { trigger: value.trigger }, value.signal)
      if (result.blocked) throw new Error(result.reason || 'PRE_COMPACT_HOOK_BLOCKED')
      return { ...(result.additionalContext ? { instructions: result.additionalContext } : {}) }
    },
    async postCompact(value) {
      const result = await run('PostCompact', value.trigger, { trigger: value.trigger, compact_summary: value.summary }, value.signal)
      if (result.blocked) throw new Error(result.reason || 'POST_COMPACT_HOOK_BLOCKED')
    },
    stop: value => run('Stop', 'Stop', { permission_mode: value.permissionMode, message_count: value.messages.length }, value.signal),
  }
}
