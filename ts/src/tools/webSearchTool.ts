// WebSearch —— web 搜索,出口走我们的网关/美国 relay(别直连、别把 key 暴露给客户端)。
// 对齐 cc-haha src/tools/WebSearchTool 的对外形态(query + allowed_domains/blocked_domains、
// 未配置时优雅降级不报错),但后端换成「我们的网关」:key 只在服务端 env(QF_GATEWAY_TOKEN /
// QF_WEBSEARCH_TOKEN),工具只把查询词发给网关,绝不内置第三方搜索 key、绝不直连搜索厂商。
import type { Tool } from './Tool'

export interface WebSearchInput {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

interface SearchHit {
  title: string
  url: string
  snippet?: string
}

type FetchImpl = typeof fetch

interface GatewaySearchConfig {
  baseUrl: string
  token: string
  path: string
}

const DEFAULT_SEARCH_PATH = '/v1/web_search'
const MAX_RESULTS = 8

export const webSearchTool: Tool<WebSearchInput> = {
  name: 'WebSearch',
  description: [
    'Search the public web for up-to-date information and return ranked result titles + URLs.',
    'Input: { query, allowed_domains?, blocked_domains? }. Use allowed_domains to restrict to specific sites, blocked_domains to exclude sites.',
    'Runs through the built-in gateway (no API key needed). Follow up with WebFetch on a result URL to read a page in full.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains.' },
      blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude results from these domains.' },
    },
    required: ['query'],
  },
  isReadOnly: true,
  async execute(input, ctx) {
    if (!input || typeof input.query !== 'string' || !input.query.trim()) throw new Error('WebSearch 需要 string 参数 query')
    return runWebSearch(input, process.env, { signal: ctx.signal })
  },
}

/** 可测试入口:注入 env / fetch。未配置网关时返回「不可用」提示而不抛错(对齐 cc 的优雅降级)。 */
export async function runWebSearch(
  input: WebSearchInput,
  env: NodeJS.ProcessEnv,
  opts: { signal?: AbortSignal; fetchImpl?: FetchImpl } = {},
): Promise<string> {
  const query = input.query.trim()
  const config = resolveGatewaySearchConfig(env)
  if (!config) {
    return formatUnavailable(query, '网关未配置 web 搜索出口(缺 QF_GATEWAY_URL / QF_WEBSEARCH_URL 或对应 token)。请改用 WebFetch 直接抓已知 URL,或稍后再试。')
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  let hits: SearchHit[]
  try {
    hits = await searchViaGateway(config, input, fetchImpl, opts.signal)
  } catch (err) {
    return formatUnavailable(query, `web 搜索请求失败:${err instanceof Error ? err.message : String(err)}`)
  }
  const filtered = applyDomainFilters(hits, input)
  return formatResults(query, filtered)
}

function resolveGatewaySearchConfig(env: NodeJS.ProcessEnv): GatewaySearchConfig | null {
  const baseUrl = normalizeBaseUrl(env.QF_WEBSEARCH_URL) ?? normalizeBaseUrl(env.QF_GATEWAY_URL)
  const token = firstNonEmpty(env.QF_WEBSEARCH_TOKEN, env.QF_GATEWAY_TOKEN)
  if (!baseUrl || !token) return null
  const path = firstNonEmpty(env.QF_WEBSEARCH_PATH) ?? DEFAULT_SEARCH_PATH
  return { baseUrl, token, path: path.startsWith('/') ? path : `/${path}` }
}

async function searchViaGateway(
  config: GatewaySearchConfig,
  input: WebSearchInput,
  fetchImpl: FetchImpl,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const url = `${config.baseUrl}${config.path}`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      // key 只在服务端 env,通过 Authorization 发给「我们的网关」——不落日志、不返回给客户端。
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: input.query.trim(),
      max_results: MAX_RESULTS,
      ...(input.allowed_domains?.length ? { allowed_domains: input.allowed_domains } : {}),
      ...(input.blocked_domains?.length ? { blocked_domains: input.blocked_domains } : {}),
    }),
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`gateway ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`)
  }
  const json = (await response.json().catch(() => null)) as unknown
  return normalizeHits(json)
}

/** 宽松解析网关返回:兼容 { results:[{title,url,snippet}] } / { data:[...] } / 顶层数组等常见形态。 */
export function normalizeHits(json: unknown): SearchHit[] {
  const rows = extractRows(json)
  const hits: SearchHit[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const url = firstString(r.url, r.link, r.href)
    const title = firstString(r.title, r.name, r.heading) || url
    if (!url) continue
    const snippet = firstString(r.snippet, r.description, r.content, r.summary)
    hits.push({ title, url, ...(snippet ? { snippet } : {}) })
  }
  return hits.slice(0, MAX_RESULTS)
}

function extractRows(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    for (const key of ['results', 'data', 'items', 'hits', 'web']) {
      const value = obj[key]
      if (Array.isArray(value)) return value
      if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).results)) {
        return (value as Record<string, unknown>).results as unknown[]
      }
    }
  }
  return []
}

export function applyDomainFilters(hits: SearchHit[], input: WebSearchInput): SearchHit[] {
  const allow = (input.allowed_domains ?? []).map(normalizeDomain).filter(Boolean)
  const block = (input.blocked_domains ?? []).map(normalizeDomain).filter(Boolean)
  if (allow.length === 0 && block.length === 0) return hits
  return hits.filter(hit => {
    const host = hostnameOf(hit.url)
    if (!host) return allow.length === 0
    if (allow.length > 0 && !allow.some(d => hostMatchesDomain(host, d))) return false
    if (block.some(d => hostMatchesDomain(host, d))) return false
    return true
  })
}

function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function formatResults(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `<web_search query="${xmlAttr(query)}" count="0">\n没有找到结果。请换更具体的关键词,或用 WebFetch 抓取已知 URL。\n</web_search>`
  }
  const lines = hits.map((hit, i) => {
    const parts = [`${i + 1}. ${hit.title}`, `   ${hit.url}`]
    if (hit.snippet) parts.push(`   ${oneLine(hit.snippet, 300)}`)
    return parts.join('\n')
  })
  return [`<web_search query="${xmlAttr(query)}" count="${hits.length}">`, ...lines, '</web_search>'].join('\n')
}

function formatUnavailable(query: string, reason: string): string {
  return `<web_search query="${xmlAttr(query)}" status="unavailable">\n${reason}\n</web_search>`
}

function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed || null
}

function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function oneLine(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

function xmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
