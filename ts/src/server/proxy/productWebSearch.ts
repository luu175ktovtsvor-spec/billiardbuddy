/**
 * Narrow local proxy for the product-owned web search route.
 *
 * The CLI only knows its loopback `ANTHROPIC_BASE_URL`; the QF app token stays
 * in the desktop server process and is injected here after the route and body
 * have both been whitelisted. This is intentionally separate from the generic
 * Anthropic/OpenAI message transformer.
 */

import { getNetworkProxyFetchOptions, loadNetworkSettings } from '../services/networkSettings.js'
import type { ProviderService } from '../services/providerService.js'
import {
  QF_GATEWAY_PROXY_PATH,
  QF_GATEWAY_PROVIDER_ID,
  isQfGatewayProviderId,
} from '../services/qfGatewayProvider.js'

const MAX_REQUEST_BYTES = 8 * 1024
const MAX_QUERY_LENGTH = 500
const MAX_DOMAIN_FILTERS = 20
const MAX_RESULTS = 8
const MAX_RESPONSE_BYTES = 128 * 1024
const REQUEST_TIMEOUT_MS = 20_000

export const PRODUCT_WEB_SEARCH_PROXY_PATH = `${QF_GATEWAY_PROXY_PATH}/v1/web_search`

type ProductWebSearchInput = {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

type ProductWebSearchResult = {
  title: string
  url: string
  snippet?: string
}

class ProductWebSearchProxyError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'ProductWebSearchProxyError'
  }
}

/**
 * Handles exactly POST /proxy/providers/qf-gateway/v1/web_search. The caller
 * must not route any provider-scoped path other than this product route here.
 */
export async function handleProductWebSearchProxyRequest(
  request: Request,
  url: URL,
  providerService: ProviderService,
): Promise<Response> {
  if (url.pathname !== PRODUCT_WEB_SEARCH_PROXY_PATH) {
    return proxyError(404, 'not_found')
  }
  if (request.method !== 'POST') {
    return proxyError(405, 'method_not_allowed', { Allow: 'POST' })
  }
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return proxyError(415, 'unsupported_media_type')
  }

  try {
    const input = await readAndValidateInput(request)
    // This explicit provider lookup is the token-injection choke point. It
    // fails closed when QF gateway env is absent and never reads an inbound
    // Authorization or X-QF-Client-ID header from the CLI process.
    const config = await providerService.getProviderForProxy(QF_GATEWAY_PROVIDER_ID)
    if (!config || !isQfGatewayProviderId(config.id) || !config.baseUrl || !config.apiKey) {
      return proxyError(503, 'web_search_unavailable')
    }

    const upstreamUrl = `${config.baseUrl.replace(/\/+$/, '')}/v1/web_search`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (config.clientId) headers['X-QF-Client-ID'] = config.clientId

    const networkSettings = await loadNetworkSettings()
    const timeout = createForwardAbortSignal(request.signal)
    try {
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        ...getNetworkProxyFetchOptions(networkSettings, upstreamUrl),
        signal: timeout.signal,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        const status = mapUpstreamStatus(response.status)
        return proxyError(
          status,
          status === 429
            ? 'web_search_busy'
            : status === 504
              ? 'web_search_timeout'
              : 'web_search_unavailable',
        )
      }

      const payload = await readJsonWithLimit(response, MAX_RESPONSE_BYTES)
      const results = sanitizeResults(payload, input)
      return Response.json({ results })
    } catch (error) {
      if (request.signal.aborted) {
        return proxyError(499, 'web_search_unavailable')
      }
      if (timeout.timedOut()) {
        return proxyError(504, 'web_search_timeout')
      }
      throw error
    } finally {
      timeout.clear()
    }
  } catch (error) {
    if (error instanceof ProductWebSearchProxyError) {
      return proxyError(error.status, error.code)
    }
    // Do not surface fetch/network/config details to the CLI. In particular
    // this keeps a malformed upstream error from revealing credentials or the
    // remote gateway topology through tool output.
    return proxyError(502, 'web_search_unavailable')
  }
}

function proxyError(status: number, code: string, headers?: HeadersInit): Response {
  return Response.json(
    {
      error: {
        code,
        message: productErrorMessage(code),
      },
    },
    { status, headers },
  )
}

function productErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_request':
      return 'Invalid web search request.'
    case 'request_too_large':
      return 'Web search request is too large.'
    case 'unsupported_media_type':
      return 'Web search requires JSON.'
    case 'method_not_allowed':
      return 'Method not allowed.'
    case 'web_search_busy':
      return 'Web search is busy. Please retry.'
    case 'web_search_timeout':
      return 'Web search timed out. Please retry.'
    default:
      return 'Web search is currently unavailable.'
  }
}

async function readAndValidateInput(request: Request): Promise<ProductWebSearchInput> {
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ProductWebSearchProxyError(413, 'request_too_large')
  }

  const raw = await readTextWithLimit(request, MAX_REQUEST_BYTES)
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new ProductWebSearchProxyError(400, 'invalid_request')
  }
  return parseInput(payload)
}

function parseInput(value: unknown): ProductWebSearchInput {
  if (!isRecord(value)) throw new ProductWebSearchProxyError(400, 'invalid_request')
  const allowedKeys = new Set(['query', 'allowed_domains', 'blocked_domains'])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ProductWebSearchProxyError(400, 'invalid_request')
  }

  const query = normalizeQuery(value.query)
  const allowedDomains = normalizeDomains(value.allowed_domains)
  const blockedDomains = normalizeDomains(value.blocked_domains)
  if (allowedDomains && blockedDomains) {
    throw new ProductWebSearchProxyError(400, 'invalid_request')
  }

  return {
    query,
    ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
    ...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
  }
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw new ProductWebSearchProxyError(400, 'invalid_request')
  const query = value.replace(/\s+/g, ' ').trim()
  if (
    query.length < 2 ||
    query.length > MAX_QUERY_LENGTH ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(query)
  ) {
    throw new ProductWebSearchProxyError(400, 'invalid_request')
  }
  return query
}

function normalizeDomains(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_DOMAIN_FILTERS) {
    throw new ProductWebSearchProxyError(400, 'invalid_request')
  }

  const domains = value.map(normalizeDomain)
  if (domains.some((domain) => !domain)) {
    throw new ProductWebSearchProxyError(400, 'invalid_request')
  }
  return [...new Set(domains)]
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  const domain = value.trim().toLowerCase()
  if (!domain || domain.length > 253 || domain.includes(':') || domain.includes('@')) return ''
  if (domain.includes('/') || domain.includes('?') || domain.includes('#')) return ''
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      domain,
    )
  ) {
    return ''
  }
  return domain
}

async function readJsonWithLimit(response: Response, maxBytes: number): Promise<unknown> {
  const raw = await readResponseTextWithLimit(response, maxBytes)
  try {
    return JSON.parse(raw)
  } catch {
    throw new ProductWebSearchProxyError(502, 'web_search_unavailable')
  }
}

function sanitizeResults(
  payload: unknown,
  input: ProductWebSearchInput,
): ProductWebSearchResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new ProductWebSearchProxyError(502, 'web_search_unavailable')
  }

  const seen = new Set<string>()
  const results: ProductWebSearchResult[] = []
  for (const candidate of payload.results) {
    if (!isRecord(candidate)) continue
    const title = cleanText(candidate.title, 300)
    const url = publicHttpUrl(candidate.url)
    if (!title || !url || seen.has(url)) continue
    const host = new URL(url).hostname.toLowerCase()
    const matchesAllowed = !input.allowed_domains?.length || input.allowed_domains.some(
      (domain) => hostMatches(host, domain),
    )
    const matchesBlocked = input.blocked_domains?.some(
      (domain) => hostMatches(host, domain),
    ) ?? false
    if (!matchesAllowed || matchesBlocked) {
      continue
    }
    seen.add(url)
    const snippet = cleanText(candidate.snippet, 1_000)
    results.push({ title, url, ...(snippet ? { snippet } : {}) })
    if (results.length >= MAX_RESULTS) break
  }
  return results
}

async function readTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ProductWebSearchProxyError(413, 'request_too_large')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ProductWebSearchProxyError) throw error
    throw new ProductWebSearchProxyError(400, 'invalid_request')
  }
  return decodeChunks(chunks, total)
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new ProductWebSearchProxyError(502, 'web_search_unavailable')
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
        throw new ProductWebSearchProxyError(502, 'web_search_unavailable')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ProductWebSearchProxyError) throw error
    throw new ProductWebSearchProxyError(502, 'web_search_unavailable')
  }
  return decodeChunks(chunks, total)
}

function decodeChunks(chunks: Uint8Array[], total: number): string {
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function createForwardAbortSignal(requestSignal: AbortSignal): {
  signal: AbortSignal
  clear: () => void
  timedOut: () => boolean
} {
  const controller = new AbortController()
  let timeoutFired = false
  const forwardAbort = () => controller.abort(requestSignal.reason)
  if (requestSignal.aborted) forwardAbort()
  else requestSignal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timeoutFired = true
    controller.abort(new Error('web search timeout'))
  }, REQUEST_TIMEOUT_MS)
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      requestSignal.removeEventListener('abort', forwardAbort)
    },
    timedOut: () => timeoutFired,
  }
}

function mapUpstreamStatus(status: number): number {
  if (status === 429) return 429
  if (status === 408 || status === 504) return 504
  if (status === 400 || status === 413 || status === 415) return 502
  if (status === 401 || status === 403) return 503
  return 503
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonContentType(value: string | null): boolean {
  return (value ?? '').toLowerCase().startsWith('application/json')
}

function publicHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) return ''
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return ''
    }
    return url.toString()
  } catch {
    return ''
  }
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}
