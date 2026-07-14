export interface UrlCitation {
  url: string
  title?: string
  siteName?: string
}

const MAX_CITATIONS = 20

export function normalizeUrlCitations(value: unknown): UrlCitation[] {
  if (!Array.isArray(value)) return []
  const citations: UrlCitation[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (record.type !== 'url_citation' || typeof record.url !== 'string') continue
    const url = normalizeHttpUrl(record.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const title = cleanLabel(record.title)
    const siteName = cleanLabel(record.site_name)
    citations.push({ url, ...(title ? { title } : {}), ...(siteName ? { siteName } : {}) })
    if (citations.length >= MAX_CITATIONS) break
  }
  return citations
}

export function mergeUrlCitations(target: UrlCitation[], incoming: unknown): void {
  const seen = new Set(target.map(citation => citation.url))
  for (const citation of normalizeUrlCitations(incoming)) {
    if (seen.has(citation.url)) continue
    seen.add(citation.url)
    target.push(citation)
    if (target.length >= MAX_CITATIONS) break
  }
}

export function appendCitationMarkdown(text: string, citations: UrlCitation[]): string {
  if (citations.length === 0) return text
  const lines = citations.map((citation, index) => {
    const fallback = citation.siteName || hostname(citation.url) || '网页来源'
    return `${index + 1}. [${escapeMarkdownLabel(citation.title || fallback)}](<${citation.url}>)`
  })
  return `${text}${text ? '\n\n' : ''}参考来源\n\n${lines.join('\n')}`
}

function normalizeHttpUrl(value: string): string {
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function cleanLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1')
}
