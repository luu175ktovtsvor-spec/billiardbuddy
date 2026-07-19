import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { Input, Output } from './WebSearchTool.js'

export type WebSearchProvider = 'anthropic' | 'disabled'

export type WebSearchSettings = {
  /** Product preference only; provider routing and credentials stay server-side. */
  enabled?: boolean
}

export type ResolvedWebSearch = {
  provider: WebSearchProvider
  settings: WebSearchSettings
}

export type WebSearchResolveOptions = {
  /** Test/host override. Undefined means inspect ANTHROPIC_BASE_URL. */
  anthropicBaseUrl?: string | null
}

const unsupportedNativeModels = new Set<string>()

export function isLikelyClaudeModel(model: string | undefined): boolean {
  return Boolean(model && /(^|[/:._-])claude([/:._-]|$)/.test(model.toLowerCase()))
}

export function isLikelyDeepSeekModel(model: string | undefined): boolean {
  return Boolean(model && /^deepseek(?:[-_./]|$)/.test(model.trim().toLowerCase()))
}

/** DeepSeek's documented direct Anthropic-compatible endpoint. */
export function isDeepSeekAnthropicBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === 'api.deepseek.com' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname.replace(/\/+$/, '') === '/anthropic'
    )
  } catch {
    return false
  }
}

/**
 * The desktop Agent reaches the managed DeepSeek gateway through this exact
 * loopback proxy. It qualifies only because the server accepts the native
 * WebSearchTool schema and exchanges the local credential for its host-held
 * DeepSeek key; arbitrary local URLs never receive that trust.
 */
export function isManagedDeepSeekAnthropicProxyUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return (
      parsed.protocol === 'http:' &&
      (host === '127.0.0.1' || host === 'localhost' || host === '::1') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname.replace(/\/+$/, '') === '/proxy/providers/qf-gateway'
    )
  } catch {
    return false
  }
}

/**
 * Old settings with `mode: disabled` retain their opt-out during migration.
 * No legacy provider mode or external credential is read at runtime.
 */
export function getConfiguredWebSearchSettings(
  settings: Pick<SettingsJson, 'webSearch'> = getSettings_DEPRECATED(),
): WebSearchSettings {
  const raw = settings.webSearch && typeof settings.webSearch === 'object'
    ? settings.webSearch as Record<string, unknown>
    : {}
  return {
    enabled: typeof raw.enabled === 'boolean'
      ? raw.enabled
      : raw.mode !== 'disabled',
  }
}

export function resolveWebSearchProvider(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
  options: WebSearchResolveOptions = {},
): ResolvedWebSearch {
  if (settings.enabled === false) return { provider: 'disabled', settings }

  const anthropicBaseUrl = options.anthropicBaseUrl === undefined
    ? process.env.ANTHROPIC_BASE_URL
    : options.anthropicBaseUrl
  const key = normalizeModelKey(model)
  const supportsNativeTransport = isLikelyClaudeModel(model) || (
    isLikelyDeepSeekModel(model) && (
      isDeepSeekAnthropicBaseUrl(anthropicBaseUrl)
      || isManagedDeepSeekAnthropicProxyUrl(anthropicBaseUrl)
    )
  )

  return {
    provider: supportsNativeTransport && (!key || !unsupportedNativeModels.has(key))
      ? 'anthropic'
      : 'disabled',
    settings,
  }
}

export function isWebSearchEnabledForModel(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
  options: WebSearchResolveOptions = {},
): boolean {
  return resolveWebSearchProvider(model, settings, options).provider === 'anthropic'
}

export function isNativeWebSearchProtocolMismatch(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error)
  return (
    /\b(400|422)\b/.test(message) ||
    /web_search|server tool|tool schema|input_schema|extra input|unsupported/i.test(message)
  )
}

export function markAnthropicNativeUnsupported(model: string | undefined): void {
  const key = normalizeModelKey(model)
  if (key) unsupportedNativeModels.add(key)
}

export function makeWebSearchUnavailableOutput(
  query: Input['query'],
  durationSeconds: number,
  reason: string,
): Output {
  return { query, results: [reason], durationSeconds }
}

function normalizeModelKey(model: string | undefined): string | null {
  const trimmed = model?.trim().toLowerCase()
  return trimmed || null
}
