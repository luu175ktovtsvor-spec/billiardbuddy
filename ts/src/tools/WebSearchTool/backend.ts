import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { Input, Output, SearchResult } from './WebSearchTool.js'
import { readWebSearchSecretsSync } from '../../utils/settings/webSearchSecrets.js'

export type WebSearchMode =
  | 'auto'
  | 'anthropic'
  | 'tavily'
  | 'brave'
  | 'disabled'

export type WebSearchProvider = 'product' | 'anthropic' | 'tavily' | 'brave' | 'disabled'

export type WebSearchSettings = {
  mode?: WebSearchMode
  tavilyApiKey?: string
  braveApiKey?: string
}

export type ResolvedWebSearch = {
  provider: WebSearchProvider
  settings: WebSearchSettings
  productGatewayUrl?: string
}

export type WebSearchResolveOptions = {
  /**
   * Test/host override for the local product route. Undefined means inspect
   * ANTHROPIC_BASE_URL; null explicitly disables product gateway resolution.
   */
  productGatewayUrl?: string | null
  /**
   * Test/host override for the native Anthropic-compatible endpoint. Undefined
   * means inspect ANTHROPIC_BASE_URL; null explicitly disables DeepSeek native
   * transport detection.
   */
  anthropicBaseUrl?: string | null
}

type ExternalSearchHit = {
  title: string
  url: string
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

class WebSearchRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebSearchRequestError'
  }
}

const WEB_SEARCH_MODES = new Set<WebSearchMode>([
  'auto',
  'anthropic',
  'tavily',
  'brave',
  'disabled',
])

const PRODUCT_WEB_SEARCH_PROXY_PATH = '/proxy/providers/qf-gateway/v1/web_search'
const MAX_QUERY_LENGTH = 500
const MAX_DOMAIN_FILTERS = 20
const MAX_RESPONSE_BYTES = 128 * 1024
const MAX_TITLE_LENGTH = 300

const unsupportedNativeModels = new Set<string>()

export function isLikelyClaudeModel(model: string | undefined): boolean {
  if (!model) {
    return false
  }

  return /(^|[/:._-])claude([/:._-]|$)/.test(model.toLowerCase())
}

export function isLikelyDeepSeekModel(model: string | undefined): boolean {
  if (!model) {
    return false
  }

  return /^deepseek(?:[-_./]|$)/.test(model.trim().toLowerCase())
}

/**
 * DeepSeek documents this exact Anthropic-compatible endpoint for Claude Code.
 * Keep this deliberately strict: a model name alone must never cause a request
 * to a different Anthropic-compatible provider to opt into a server tool.
 */
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

export function getConfiguredWebSearchSettings(
  settings: Pick<SettingsJson, 'webSearch'> = getSettings_DEPRECATED(),
): WebSearchSettings {
  const raw = settings.webSearch && typeof settings.webSearch === 'object'
    ? settings.webSearch
    : {}

  const modeCandidate = raw.mode ?? 'auto'

  const secrets = readWebSearchSecretsSync()
  return {
    mode: WEB_SEARCH_MODES.has(modeCandidate) ? modeCandidate : 'auto',
    tavilyApiKey: secrets.tavilyApiKey ?? normalizeApiKey(raw.tavilyApiKey),
    braveApiKey: secrets.braveApiKey ?? normalizeApiKey(raw.braveApiKey),
  }
}

export function resolveWebSearchProvider(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
  options: WebSearchResolveOptions = {},
): ResolvedWebSearch {
  const mode = settings.mode ?? 'auto'
  const productGatewayUrl = options.productGatewayUrl === undefined
    ? getProductWebSearchProxyUrl()
    : options.productGatewayUrl
  const anthropicBaseUrl = options.anthropicBaseUrl === undefined
    ? process.env.ANTHROPIC_BASE_URL
    : options.anthropicBaseUrl

  if (mode === 'disabled') {
    return { provider: 'disabled', settings }
  }

  if (mode === 'tavily') {
    return { provider: settings.tavilyApiKey ? 'tavily' : 'disabled', settings }
  }

  if (mode === 'brave') {
    // The managed route ultimately uses Brave. Keep it behind the explicit
    // advanced mode so ordinary search never silently leaves DeepSeek's native
    // server-tool transport.
    if (productGatewayUrl) {
      return { provider: 'product', settings, productGatewayUrl }
    }
    return { provider: settings.braveApiKey ? 'brave' : 'disabled', settings }
  }

  if (mode === 'anthropic') {
    return {
      provider: canUseAnthropicNativeWebSearch(model, anthropicBaseUrl) ? 'anthropic' : 'disabled',
      settings,
    }
  }

  if (canUseAnthropicNativeWebSearch(model, anthropicBaseUrl)) {
    return { provider: 'anthropic', settings }
  }

  // Automatic search is native-only. External providers stay available only
  // through an explicit advanced setting so a native transport failure can
  // never quietly switch the query to a different provider.
  return { provider: 'disabled', settings }
}

export function isWebSearchEnabledForModel(
  model: string | undefined,
  settings: WebSearchSettings = getConfiguredWebSearchSettings(),
  options: WebSearchResolveOptions = {},
): boolean {
  return resolveWebSearchProvider(model, settings, options).provider !== 'disabled'
}

/**
 * Resolve only the loopback endpoint installed by the managed QF runtime.
 * This deliberately does not inspect QF_GATEWAY_* variables, so the tool can
 * run inside the CLI without ever learning the host-only gateway token.
 */
export function getProductWebSearchProxyUrl(
  baseUrl: string | undefined = process.env.ANTHROPIC_BASE_URL,
): string | null {
  if (!baseUrl) return null
  try {
    const parsed = new URL(baseUrl)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    const path = parsed.pathname.replace(/\/+$/, '')
    if (
      parsed.protocol !== 'http:' ||
      !isLoopback ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      path !== '/proxy/providers/qf-gateway'
    ) {
      return null
    }
    return `${parsed.origin}${PRODUCT_WEB_SEARCH_PROXY_PATH}`
  } catch {
    return null
  }
}

function isProductWebSearchProxyUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return (
      parsed.protocol === 'http:' &&
      (host === '127.0.0.1' || host === 'localhost' || host === '::1') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === PRODUCT_WEB_SEARCH_PROXY_PATH
    )
  } catch {
    return false
  }
}

export function isNativeWebSearchProtocolMismatch(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error)
  return (
    /\b(400|422)\b/.test(message) ||
    /web_search|server tool|tool schema|input_schema|extra input|unsupported/i.test(
      message,
    )
  )
}

export function markAnthropicNativeUnsupported(model: string | undefined): void {
  const key = normalizeModelKey(model)
  if (key) {
    unsupportedNativeModels.add(key)
  }
}

export async function searchWithExternalProvider(
  provider: Exclude<WebSearchProvider, 'product' | 'anthropic' | 'disabled'>,
  input: Input,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<Output> {
  const normalizedInput = normalizeWebSearchInput(input)
  const startTime = performance.now()
  const hits =
    provider === 'tavily'
      ? await searchWithTavily(normalizedInput, apiKey, signal, fetchImpl)
      : await searchWithBrave(normalizedInput, apiKey, signal, fetchImpl)
  const durationSeconds = (performance.now() - startTime) / 1000

  return makeExternalSearchOutput(normalizedInput.query, hits, durationSeconds)
}

/**
 * Call the exact loopback sidecar path selected by the managed runtime. The
 * request contains only a validated query/filter contract; it does not carry a
 * provider key, gateway URL, or an inbound CLI Authorization header.
 */
export async function searchWithProductGateway(
  input: Input,
  signal: AbortSignal,
  proxyUrl: string | null = getProductWebSearchProxyUrl(),
  fetchImpl: FetchLike = fetch,
): Promise<Output> {
  if (!proxyUrl || !isProductWebSearchProxyUrl(proxyUrl)) {
    throw new WebSearchRequestError('Web search is not available for this task.')
  }
  const normalizedInput = normalizeWebSearchInput(input)
  const startTime = performance.now()
  let response: Response
  try {
    response = await fetchImpl(proxyUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(normalizedInput),
      signal,
    })
  } catch {
    throw new WebSearchRequestError('Web search is temporarily unavailable. Please try again.')
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new WebSearchRequestError(productGatewayErrorMessage(response.status))
  }

  let payload: unknown
  try {
    payload = JSON.parse(await readResponseTextWithLimit(response, MAX_RESPONSE_BYTES))
  } catch (error) {
    if (error instanceof WebSearchRequestError) throw error
    throw new WebSearchRequestError('Web search returned an invalid response.')
  }
  const hits = normalizeProductGatewayResults(payload)
  const durationSeconds = (performance.now() - startTime) / 1000
  return makeExternalSearchOutput(normalizedInput.query, hits, durationSeconds)
}

export function getApiKeyForProvider(
  provider: Exclude<WebSearchProvider, 'product' | 'anthropic' | 'disabled'>,
  settings: WebSearchSettings,
): string | null {
  return provider === 'tavily'
    ? settings.tavilyApiKey ?? null
    : settings.braveApiKey ?? null
}

export function makeWebSearchUnavailableOutput(
  query: string,
  durationSeconds: number,
  reason: string,
): Output {
  return {
    query,
    results: [reason],
    durationSeconds,
  }
}

function canUseAnthropicNativeWebSearch(
  model: string | undefined,
  anthropicBaseUrl: string | null | undefined,
): boolean {
  const key = normalizeModelKey(model)
  const supportsNativeTransport =
    isLikelyClaudeModel(model) ||
    (isLikelyDeepSeekModel(model) && isDeepSeekAnthropicBaseUrl(anthropicBaseUrl))
  return supportsNativeTransport && (!key || !unsupportedNativeModels.has(key))
}

function normalizeModelKey(model: string | undefined): string | null {
  const trimmed = model?.trim().toLowerCase()
  return trimmed || null
}

function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length ? trimmed : undefined
}

async function searchWithTavily(
  input: Input,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<ExternalSearchHit[]> {
  const response = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: input.query,
      max_results: 8,
      search_depth: 'basic',
      include_answer: false,
      include_domains: normalizeDomains(input.allowed_domains),
      exclude_domains: normalizeDomains(input.blocked_domains),
    }),
    signal,
  })

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new WebSearchRequestError(externalProviderErrorMessage(response.status))
  }

  const body = (await response.json()) as {
    results?: Array<{ title?: unknown; url?: unknown }>
  }

  return (body.results ?? [])
    .map(hit => normalizeHit(hit.title, hit.url))
    .filter((hit): hit is ExternalSearchHit => hit != null)
    .slice(0, 8)
}

async function searchWithBrave(
  input: Input,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): Promise<ExternalSearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', applyDomainFiltersToQuery(input))
  url.searchParams.set('count', '8')

  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal,
  })

  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new WebSearchRequestError(externalProviderErrorMessage(response.status))
  }

  const body = (await response.json()) as {
    web?: { results?: Array<{ title?: unknown; url?: unknown }> }
  }

  return (body.web?.results ?? [])
    .map(hit => normalizeHit(hit.title, hit.url))
    .filter((hit): hit is ExternalSearchHit => hit != null)
    .slice(0, 8)
}

function applyDomainFiltersToQuery(input: Input): string {
  const allowed = normalizeDomains(input.allowed_domains) ?? []
  const blocked = normalizeDomains(input.blocked_domains) ?? []
  const allowedClause = allowed.length
    ? `(${allowed.map(domain => `site:${domain}`).join(' OR ')}) `
    : ''
  const blockedClause = blocked.length
    ? `${blocked.map(domain => `-site:${domain}`).join(' ')} `
    : ''

  return `${allowedClause}${blockedClause}${input.query}`.trim()
}

function normalizeHit(title: unknown, url: unknown): ExternalSearchHit | null {
  if (typeof title !== 'string' || typeof url !== 'string') {
    return null
  }
  const normalizedTitle = title
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
  if (!normalizedTitle) return null
  try {
    const parsed = new URL(url)
    if (
      url.length > 2_048 ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password
    ) {
      return null
    }
    return { title: normalizedTitle, url: parsed.toString() }
  } catch {
    return null
  }
}

function normalizeDomains(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined
  if (values.length > MAX_DOMAIN_FILTERS) {
    throw new WebSearchRequestError('Web search domain filters are invalid.')
  }
  const domains = values.map(value => normalizeDomain(value))
  if (domains.some((domain) => !domain)) {
    throw new WebSearchRequestError('Web search domain filters are invalid.')
  }
  return [...new Set(domains)]
}

function makeExternalSearchOutput(
  query: string,
  hits: ExternalSearchHit[],
  durationSeconds: number,
): Output {
  const result: SearchResult = {
    tool_use_id: 'web-search',
    content: hits,
  }

  return {
    query,
    results: ['Search completed.', result],
    durationSeconds,
  }
}

function normalizeWebSearchInput(input: Input): Input {
  const query = input.query.replace(/\s+/g, ' ').trim()
  if (
    query.length < 2 ||
    query.length > MAX_QUERY_LENGTH ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(query)
  ) {
    throw new WebSearchRequestError('Web search query is invalid.')
  }
  const allowedDomains = normalizeDomains(input.allowed_domains)
  const blockedDomains = normalizeDomains(input.blocked_domains)
  if (allowedDomains && blockedDomains) {
    throw new WebSearchRequestError('Web search cannot combine allowed and blocked domains.')
  }
  return {
    query,
    ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
    ...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
  }
}

function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase()
  if (!domain || domain.length > 253 || domain.includes(':') || domain.includes('@')) return ''
  if (domain.includes('/') || domain.includes('?') || domain.includes('#')) return ''
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    return ''
  }
  return domain
}

function normalizeProductGatewayResults(payload: unknown): ExternalSearchHit[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) {
    throw new WebSearchRequestError('Web search returned an invalid response.')
  }
  const seen = new Set<string>()
  const hits: ExternalSearchHit[] = []
  for (const candidate of (payload as { results: unknown[] }).results) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as { title?: unknown; url?: unknown }
    const hit = normalizeHit(record.title, record.url)
    if (!hit || seen.has(hit.url)) continue
    seen.add(hit.url)
    hits.push(hit)
    if (hits.length >= 8) break
  }
  return hits
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new WebSearchRequestError('Web search returned an invalid response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new WebSearchRequestError('Web search returned an invalid response.')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof WebSearchRequestError) throw error
    throw new WebSearchRequestError('Web search returned an invalid response.')
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function externalProviderErrorMessage(status: number): string {
  if (status === 429) return 'Web search is busy. Please try again.'
  if (status === 401 || status === 403) return 'Web search is not available for this task.'
  return 'Web search is temporarily unavailable. Please try again.'
}

function productGatewayErrorMessage(status: number): string {
  if (status === 429) return 'Web search is busy. Please try again.'
  if (status === 408 || status === 504) return 'Web search timed out. Please try again.'
  return 'Web search is temporarily unavailable. Please try again.'
}
