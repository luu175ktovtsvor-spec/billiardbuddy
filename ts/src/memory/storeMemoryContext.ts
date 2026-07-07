type JsonObject = Record<string, unknown>

export interface StoreMemoryContextOptions {
  workingDir?: string
  now?: Date
  maxItems?: number
}

interface ScoredMemory {
  item: JsonObject
  score: number
  ageDays: number | null
}

const DEFAULT_MAX_MEMORIES = 5
const STALE_MEMORY_DAYS = 30

export function buildStoreMemoryContext(
  memories: JsonObject[],
  query: string,
  opts: StoreMemoryContextOptions = {},
): string {
  const terms = extractTerms(query)
  if (!terms.length || !memories.length) return ''
  const now = opts.now ?? new Date()
  const maxItems = positiveInt(opts.maxItems, DEFAULT_MAX_MEMORIES)
  const scoped = memories.filter(item => memoryVisibleForScope(item, opts.workingDir))
  const scored = scoped
    .map(item => scoreMemory(item, terms, query, now))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
  if (!scored.length) return ''

  return [
    `<store_memory_context count="${scored.length}">`,
    '这些是用户保存的门店记忆。回答时优先尊重它们;若 age_warning 存在,涉及价格、排班、活动、库存、合同等易变事实时先提醒用户核对现状。',
    ...scored.map(({ item, score, ageDays }, index) => formatMemory(item, index + 1, score, ageDays)),
    '</store_memory_context>',
  ].join('\n')
}

function scoreMemory(item: JsonObject, terms: string[], query: string, now: Date): ScoredMemory {
  const content = typeof item.content === 'string' ? item.content : ''
  const haystack = content.toLowerCase()
  const queryText = query.trim().toLowerCase()
  let matchScore = queryText && haystack.includes(queryText) ? 8 : 0
  for (const term of terms) {
    if (haystack.includes(term.toLowerCase())) matchScore += term.length >= 3 ? 3 : 1.5
  }
  if (matchScore <= 0) return { item, score: 0, ageDays: memoryAgeDays(item, now) }
  let score = matchScore
  if (item.source === 'manual') score += 1.5
  if (item.source === 'pending') score -= 2
  const ageDays = memoryAgeDays(item, now)
  if (ageDays !== null && ageDays <= 7) score += 0.5
  return { item, score, ageDays }
}

function formatMemory(item: JsonObject, index: number, score: number, ageDays: number | null): string {
  const id = typeof item.id === 'string' ? item.id : `memory-${index}`
  const source = typeof item.source === 'string' ? item.source : 'manual'
  const confidence = typeof item.confidence === 'string' ? item.confidence : ''
  const type = typeof item.type === 'string' ? item.type : ''
  const content = typeof item.content === 'string' ? item.content : ''
  const ageAttrs = ageDays === null
    ? ' age_days="unknown"'
    : ` age_days="${ageDays}"${ageDays >= STALE_MEMORY_DAYS ? ` age_warning="${xmlAttr(`这条记忆是 ${ageDays} 天前记录的,请核对是否仍然有效。`)}"` : ''}`
  return [
    `<memory source_id="M${index}" id="${xmlAttr(id)}" source="${xmlAttr(source)}" confidence="${xmlAttr(confidence)}" type="${xmlAttr(type)}" score="${Number(score.toFixed(2))}"${ageAttrs}>`,
    xmlText(content),
    '</memory>',
  ].join('\n')
}

function memoryVisibleForScope(item: JsonObject, workingDir?: string): boolean {
  if (item.source === 'pending') return false
  const scope = typeof item.scope === 'string' ? item.scope : 'global'
  if (scope !== 'working_dir') return true
  const itemDir = typeof item.working_dir === 'string' ? item.working_dir : ''
  return !!workingDir && itemDir === workingDir
}

function memoryAgeDays(item: JsonObject, now: Date): number | null {
  const raw = typeof item.updated_at === 'string'
    ? item.updated_at
    : typeof item.created_at === 'string'
      ? item.created_at
      : ''
  if (!raw) return null
  const ts = Date.parse(raw)
  if (!Number.isFinite(ts)) return null
  return Math.max(0, Math.floor((now.getTime() - ts) / 86_400_000))
}

function extractTerms(query: string): string[] {
  const terms = new Set<string>()
  const lower = query.toLowerCase()
  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) terms.add(word)
  for (const seq of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    terms.add(seq)
    for (let i = 0; i < seq.length - 1; i++) terms.add(seq.slice(i, i + 2))
  }
  return [...terms].filter(term => term.trim().length >= 2)
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
