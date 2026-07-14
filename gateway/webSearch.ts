type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const MAX_QUERY_LENGTH = 500
const MAX_DOMAIN_FILTERS = 20
const MAX_RESULTS = 8
const UPSTREAM_RESULT_COUNT = 20
const MAX_UPSTREAM_BYTES = 1024 * 1024

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
  }
}

interface BraveConfig {
  baseUrl: string
  key: string
  timeoutMs: number
}

export function createGatewayWebSearch(env: Env, fetchImpl: FetchLike): GatewayWebSearch | null {
  const provider = (env.GW_WEBSEARCH_PROVIDER ?? '').trim().toLowerCase()
  if (!provider) return null
  if (provider !== 'brave') throw new Error(`unsupported GW_WEBSEARCH_PROVIDER: ${provider}`)

  const key = (env.GW_WEBSEARCH_KEY ?? '').trim()
  if (!key) return null
  const baseUrl = normalizeBaseUrl(env.GW_WEBSEARCH_BASE ?? 'https://api.search.brave.com/res/v1/web/search')
  const timeoutMs = boundedInt(env.GW_WEBSEARCH_TIMEOUT_MS, 15_000, 100, 60_000)
  const config: BraveConfig = { baseUrl, key, timeoutMs }

  return async (rawInput, options = {}) => {
    const input = parseInput(rawInput)
    const url = new URL(config.baseUrl)
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', String(UPSTREAM_RESULT_COUNT))
    url.searchParams.set('safesearch', 'moderate')

    const controller = new AbortController()
    const forwardAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('web search timeout')), config.timeoutMs)
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
        throw new GatewayWebSearchError(response.status === 429 ? 429 : 502, '联网搜索暂时不可用，请稍后重试')
      }
      const text = await readTextWithLimit(response, MAX_UPSTREAM_BYTES)
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new GatewayWebSearchError(502, '联网搜索返回了无法识别的数据')
      }
      return { results: filterResults(normalizeBraveResults(payload), input) }
    } catch (error) {
      if (error instanceof GatewayWebSearchError) throw error
      if (controller.signal.aborted) throw new GatewayWebSearchError(504, '联网搜索超时，请稍后重试')
      throw new GatewayWebSearchError(502, '联网搜索暂时不可用，请稍后重试')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

function parseInput(input: unknown): GatewayWebSearchInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GatewayWebSearchError(400, '搜索请求格式不正确')
  }
  const body = input as Record<string, unknown>
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) throw new GatewayWebSearchError(400, '搜索词不能为空')
  if (query.length > MAX_QUERY_LENGTH) throw new GatewayWebSearchError(400, `搜索词不能超过 ${MAX_QUERY_LENGTH} 个字符`)
  return {
    query,
    ...parseDomains(body.allowed_domains, 'allowed_domains'),
    ...parseDomains(body.blocked_domains, 'blocked_domains'),
  }
}

function parseDomains(value: unknown, key: 'allowed_domains' | 'blocked_domains'): Partial<GatewayWebSearchInput> {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.length > MAX_DOMAIN_FILTERS) {
    throw new GatewayWebSearchError(400, `${key} 格式不正确`)
  }
  const domains = value.map(item => normalizeDomain(item))
  if (domains.some(domain => !domain)) throw new GatewayWebSearchError(400, `${key} 包含无效域名`)
  return { [key]: [...new Set(domains)] }
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
  if (!raw || raw.length > 253 || raw.includes(':') || raw.includes('@')) return ''
  if (!/^[a-z0-9.-]+$/.test(raw) || raw.startsWith('.') || raw.endsWith('.') || raw.includes('..')) return ''
  return raw
}

function normalizeBraveResults(payload: unknown): GatewayWebSearchResult[] {
  if (!payload || typeof payload !== 'object') return []
  const web = (payload as Record<string, unknown>).web
  if (!web || typeof web !== 'object') return []
  const rows = (web as Record<string, unknown>).results
  if (!Array.isArray(rows)) return []

  const results: GatewayWebSearchResult[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const candidate = row as Record<string, unknown>
    const title = cleanText(candidate.title, 300)
    const url = publicHttpUrl(candidate.url)
    if (!title || !url) continue
    const snippet = cleanText(candidate.description, 1_000)
    results.push({ title, url, ...(snippet ? { snippet } : {}) })
  }
  return results
}

function filterResults(results: GatewayWebSearchResult[], input: GatewayWebSearchInput): GatewayWebSearchResult[] {
  const allowed = input.allowed_domains ?? []
  const blocked = input.blocked_domains ?? []
  return results.filter(result => {
    const host = new URL(result.url).hostname.toLowerCase().replace(/^www\./, '')
    if (allowed.length > 0 && !allowed.some(domain => hostMatches(host, domain))) return false
    if (blocked.some(domain => hostMatches(host, domain))) return false
    return true
  }).slice(0, MAX_RESULTS)
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function publicHttpUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
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
      await reader.cancel()
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
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('GW_WEBSEARCH_BASE must use http(s)')
  return url.toString()
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}
