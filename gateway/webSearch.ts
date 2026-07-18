type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export const GATEWAY_WEB_SEARCH_MAX_QUERY_LENGTH = 500
export const GATEWAY_WEB_SEARCH_MAX_DOMAIN_FILTERS = 20
export const GATEWAY_WEB_SEARCH_MAX_RESULTS = 8
export const GATEWAY_WEB_SEARCH_MAX_REQUEST_BYTES = 8 * 1024

const UPSTREAM_RESULT_COUNT = 20
const MAX_UPSTREAM_BYTES = 1024 * 1024
const MAX_TITLE_LENGTH = 300
const MAX_SNIPPET_LENGTH = 1_000

export interface GatewayWebSearchInput {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export interface GatewayWebSearchResult {
  title: string
  url: string
  snippet?: string
}

export interface GatewayWebSearchResponse {
  results: GatewayWebSearchResult[]
}

export type GatewayWebSearch = (
  input: unknown,
  options?: { signal?: AbortSignal },
) => Promise<GatewayWebSearchResponse>

export class GatewayWebSearchError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'GatewayWebSearchError'
  }
}

interface BraveConfig {
  baseUrl: string
  key: string
  timeoutMs: number
}

/**
 * Product-owned web search adapter. The Brave credential stays in gw.env and
 * the only public contract is the already-sanitised `results` payload below.
 * A missing configuration returns null so the route can fail closed with 503;
 * it never falls through to another provider.
 */
export function createGatewayWebSearch(env: Env, fetchImpl: FetchLike): GatewayWebSearch | null {
  const provider = (env.GW_WEBSEARCH_PROVIDER ?? '').trim().toLowerCase()
  if (!provider) return null
  if (provider !== 'brave') {
    throw new Error('GW_WEBSEARCH_PROVIDER must be brave')
  }

  const key = (env.GW_WEBSEARCH_KEY ?? '').trim()
  if (!key) return null

  const config: BraveConfig = {
    baseUrl: normalizeBaseUrl(
      env.GW_WEBSEARCH_BASE ?? 'https://api.search.brave.com/res/v1/web/search',
    ),
    key,
    timeoutMs: boundedInt(env.GW_WEBSEARCH_TIMEOUT_MS, 15_000, 1_000, 60_000),
  }

  return async (rawInput, options = {}) => {
    const input = parseGatewayWebSearchInput(rawInput)
    const url = new URL(config.baseUrl)
    url.searchParams.set('q', input.query)
    // Fetch a modest over-sample so server-side allow/block filters can still
    // yield useful results, then cap the public response at eight.
    url.searchParams.set('count', String(UPSTREAM_RESULT_COUNT))
    url.searchParams.set('safesearch', 'moderate')

    const controller = new AbortController()
    const forwardAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new Error('web search timeout')),
      config.timeoutMs,
    )

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          'X-Subscription-Token': config.key,
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        const status = response.status === 429 ? 429 : 502
        throw new GatewayWebSearchError(status, publicUpstreamError(status))
      }

      const text = await readTextWithLimit(response, MAX_UPSTREAM_BYTES)
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new GatewayWebSearchError(502, '联网搜索返回了无法识别的数据')
      }

      return {
        results: filterResults(normalizeBraveResults(payload), input),
      }
    } catch (error) {
      if (error instanceof GatewayWebSearchError) throw error
      if (options.signal?.aborted) {
        throw new GatewayWebSearchError(499, '搜索请求已取消')
      }
      if (controller.signal.aborted) {
        throw new GatewayWebSearchError(504, '联网搜索超时，请稍后重试')
      }
      throw new GatewayWebSearchError(502, '联网搜索暂时不可用，请稍后重试')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

/**
 * Strict shared gateway boundary. It deliberately rejects unknown fields and
 * invalid filters instead of silently weakening a caller's search constraint.
 */
export function parseGatewayWebSearchInput(input: unknown): GatewayWebSearchInput {
  if (!isRecord(input)) {
    throw new GatewayWebSearchError(400, '搜索请求格式不正确')
  }

  const allowedKeys = new Set(['query', 'allowed_domains', 'blocked_domains'])
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new GatewayWebSearchError(400, '搜索请求包含不支持的字段')
  }

  const query = normalizeQuery(input.query)
  const allowedDomains = parseDomains(input.allowed_domains, 'allowed_domains')
  const blockedDomains = parseDomains(input.blocked_domains, 'blocked_domains')
  if (allowedDomains && blockedDomains) {
    throw new GatewayWebSearchError(400, '不能同时设置允许域名和排除域名')
  }

  return {
    query,
    ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
    ...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GatewayWebSearchError(400, '搜索词不能为空')
  }
  const query = value.replace(/\s+/g, ' ').trim()
  if (query.length < 2) {
    throw new GatewayWebSearchError(400, '搜索词至少需要 2 个字符')
  }
  if (query.length > GATEWAY_WEB_SEARCH_MAX_QUERY_LENGTH) {
    throw new GatewayWebSearchError(
      400,
      `搜索词不能超过 ${GATEWAY_WEB_SEARCH_MAX_QUERY_LENGTH} 个字符`,
    )
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(query)) {
    throw new GatewayWebSearchError(400, '搜索词包含不支持的字符')
  }
  return query
}

function parseDomains(
  value: unknown,
  key: 'allowed_domains' | 'blocked_domains',
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > GATEWAY_WEB_SEARCH_MAX_DOMAIN_FILTERS) {
    throw new GatewayWebSearchError(400, `${key} 格式不正确`)
  }

  const domains = value.map(normalizeDomain)
  if (domains.some((domain) => !domain)) {
    throw new GatewayWebSearchError(400, `${key} 包含无效域名`)
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

function normalizeBraveResults(payload: unknown): GatewayWebSearchResult[] {
  if (!isRecord(payload) || !isRecord(payload.web) || !Array.isArray(payload.web.results)) {
    return []
  }

  const results: GatewayWebSearchResult[] = []
  for (const row of payload.web.results) {
    if (!isRecord(row)) continue
    const title = cleanText(row.title, MAX_TITLE_LENGTH)
    const url = publicHttpUrl(row.url)
    if (!title || !url) continue
    const snippet = cleanText(row.description, MAX_SNIPPET_LENGTH)
    results.push({ title, url, ...(snippet ? { snippet } : {}) })
  }
  return results
}

function filterResults(
  results: GatewayWebSearchResult[],
  input: GatewayWebSearchInput,
): GatewayWebSearchResult[] {
  const allowed = input.allowed_domains ?? []
  const blocked = input.blocked_domains ?? []
  const seen = new Set<string>()

  return results.filter((result) => {
    const parsed = new URL(result.url)
    const host = parsed.hostname.toLowerCase()
    if (allowed.length > 0 && !allowed.some((domain) => hostMatches(host, domain))) return false
    if (blocked.some((domain) => hostMatches(host, domain))) return false
    if (seen.has(result.url)) return false
    seen.add(result.url)
    return true
  }).slice(0, GATEWAY_WEB_SEARCH_MAX_RESULTS)
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
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

async function readTextWithLimit(response: Response, limit: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) {
      await reader.cancel().catch(() => {})
      throw new GatewayWebSearchError(502, '联网搜索返回的数据过大')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('GW_WEBSEARCH_BASE must use http(s)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('GW_WEBSEARCH_BASE must not contain credentials, query, or fragment')
  }
  return url.toString()
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function publicUpstreamError(status: number): string {
  if (status === 429) return '联网搜索当前较忙，请稍后重试'
  return '联网搜索暂时不可用，请稍后重试'
}
