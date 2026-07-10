import { existsSync } from 'node:fs'
import { readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import type { Tool } from '../../tools/Tool'
import { readOfficeDocumentBlocks, readXlsxSheet } from '../../utils/officeDocuments'
import type { DesktopDataStore } from './desktopDataStore'

type JsonObject = Record<string, unknown>

interface StoreDocChunk {
  id: string
  path: string
  fileName: string
  chunkIndex: number
  text: string
}

interface StoreDocsIndex {
  folderPath: string
  indexedAt: string
  chunks: StoreDocChunk[]
}

interface QueryProfile {
  needle: string
  terms: string[]
  semanticTerms: string[]
}

interface ScoredChunk {
  chunk: StoreDocChunk
  score: number
  matchedTerms: string[]
  semanticMatchedTerms: string[]
  phraseMatch: boolean
  fileNameMatch: boolean
  channels: string[]
}

export interface StoreDocHit {
  source_id: string
  file_name: string
  path: string
  chunk_index: number
  score: number
  confidence: 'high' | 'medium' | 'low'
  matched_terms: string[]
  why: string
  excerpt: string
}

export interface StoreDocSearchOptions {
  paths?: string | string[]
}

const SUPPORTED_EXTS = new Set([
  '.csv',
  '.docx',
  '.json',
  '.log',
  '.markdown',
  '.md',
  '.pptx',
  '.txt',
  '.tsv',
  '.xlsx',
  '.yaml',
  '.yml',
])

const SKIP_DIRS = new Set(['.git', '.backups', '.billiards-backups', 'node_modules', 'dist', 'build'])
const MAX_FILE_BYTES = 2 * 1024 * 1024
const CHUNK_CHARS = 900
const CHUNK_OVERLAP = 120
const RRF_K = 60

const SEMANTIC_ALIAS_GROUPS: Array<{ triggers: string[]; terms: string[] }> = [
  {
    triggers: ['台费', '包台', '小时费', '收费', '价目', '价格', '消费'],
    terms: ['台费', '包台', '小时费', '收费', '价目', '价格', '消费', '每小时', '元/小时', '一小时'],
  },
  {
    triggers: ['黄金档', '黄金时段', '高峰', '晚高峰', '黄金档期'],
    terms: ['黄金档', '黄金时段', '高峰', '晚高峰', '黄金档期', '晚上黄金', '夜间'],
  },
  {
    triggers: ['会员', '充值', '储值', '办卡', '会员卡'],
    terms: ['会员', '充值', '储值', '办卡', '会员卡', '卡金', '余额', '赠送', '满送'],
  },
  {
    triggers: ['排班', '班次', '值班', '晚班', '早班'],
    terms: ['排班', '班次', '值班', '晚班', '早班', '轮班', '当班'],
  },
  {
    triggers: ['合同', '租约', '租赁', '租期', '到期'],
    terms: ['合同', '租约', '租赁', '租期', '到期', '期限', '续租', '截止'],
  },
  {
    triggers: ['门头', '广告位', '招牌', '门脸'],
    terms: ['门头', '广告位', '招牌', '门脸', '店招', '外立面'],
  },
  {
    triggers: ['收款码', '二维码', '付款码'],
    terms: ['收款码', '二维码', '付款码', '支付码', '微信收款', '支付宝收款'],
  },
  {
    triggers: ['进货', '采购', '库存', '耗材'],
    terms: ['进货', '采购', '库存', '耗材', '补货', '供应商', '入库'],
  },
  {
    triggers: ['工资', '提成', '奖金', '绩效'],
    terms: ['工资', '提成', '奖金', '绩效', '薪资', '底薪', '奖励'],
  },
]

export class StoreDocsService {
  private readonly indexPath: string

  constructor(
    private readonly desktopData: DesktopDataStore,
    stateRoot: string,
  ) {
    this.indexPath = join(stateRoot, 'store-docs-index.json')
  }

  async setFolder(folderPath: string | null): Promise<JsonObject> {
    if (!folderPath) return this.clear()
    await this.desktopData.updateStoreDocs({ folder_path: folderPath, status: 'indexing', last_error: null })
    return this.reindex(folderPath)
  }

  async clear(): Promise<JsonObject> {
    await rm(this.indexPath, { force: true }).catch(() => undefined)
    return this.desktopData.updateStoreDocs({
      folder_path: null,
      status: 'idle',
      indexed_file_count: 0,
      indexed_chunk_count: 0,
      last_indexed_at: null,
      last_error: null,
    })
  }

  async reindex(folderPath?: string): Promise<JsonObject> {
    const docs = await this.desktopData.getStoreDocs()
    const root = typeof folderPath === 'string' && folderPath.trim()
      ? folderPath.trim()
      : typeof docs.folder_path === 'string'
        ? docs.folder_path
        : ''
    if (!root) return this.clear()

    try {
      const resolvedRoot = resolve(root)
      const st = await stat(resolvedRoot)
      if (!st.isDirectory()) throw new Error('请选择一个文件夹')

      await this.desktopData.updateStoreDocs({ folder_path: resolvedRoot, status: 'indexing', last_error: null })
      const files = await walkFiles(resolvedRoot)
      const chunks: StoreDocChunk[] = []
      let indexedFiles = 0

      for (const file of files) {
        const text = await extractText(file).catch(() => '')
        if (!text.trim()) continue
        indexedFiles += 1
        const fileName = basename(file)
        splitChunks(text).forEach((chunk, chunkIndex) => {
          chunks.push({
            id: `${relative(resolvedRoot, file)}#${chunkIndex}`,
            path: file,
            fileName,
            chunkIndex,
            text: chunk,
          })
        })
      }

      const indexedAt = new Date().toISOString()
      await mkdir(dirname(this.indexPath), { recursive: true })
      await writeFile(this.indexPath, `${JSON.stringify({ folderPath: resolvedRoot, indexedAt, chunks }, null, 2)}\n`, 'utf8')
      return this.desktopData.updateStoreDocs({
        folder_path: resolvedRoot,
        status: 'ready',
        indexed_file_count: indexedFiles,
        indexed_chunk_count: chunks.length,
        last_indexed_at: indexedAt,
        last_error: null,
      })
    } catch (error) {
      return this.desktopData.updateStoreDocs({
        folder_path: root,
        status: 'error',
        last_error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async search(query: string, top = 5, options: StoreDocSearchOptions = {}): Promise<StoreDocHit[]> {
    const q = query.trim()
    if (!q) return []
    let index = await this.loadIndex()
    const docs = await this.desktopData.getStoreDocs()
    if (!index && typeof docs.folder_path === 'string' && docs.folder_path) {
      await this.reindex(docs.folder_path)
      index = await this.loadIndex()
    }
    if (!index) return []

    const profile = queryProfile(q)
    const chunks = filterChunksByPaths(index, normalizeSearchPaths(options.paths))
    return scoreChunks(chunks, profile)
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, top)))
      .map((item, index) => ({
        source_id: `S${index + 1}`,
        file_name: item.chunk.fileName,
        path: item.chunk.path,
        chunk_index: item.chunk.chunkIndex,
        score: Number(item.score.toFixed(3)),
        confidence: confidenceFor(item.score, item.matchedTerms.length, profile.terms.length, item.phraseMatch),
        matched_terms: item.matchedTerms.slice(0, 8),
        why: reasonFor(item, profile.terms.length),
        excerpt: excerptFor(item.chunk.text, [...item.matchedTerms, ...profile.terms, ...profile.semanticTerms], profile.needle),
      }))
  }

  private async loadIndex(): Promise<StoreDocsIndex | null> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      const raw = parsed as Partial<StoreDocsIndex>
      if (typeof raw.folderPath !== 'string' || !Array.isArray(raw.chunks)) return null
      return {
        folderPath: raw.folderPath,
        indexedAt: typeof raw.indexedAt === 'string' ? raw.indexedAt : '',
        chunks: raw.chunks.filter(isChunk),
      }
    } catch {
      return null
    }
  }
}

export function createStoreDocsTool(service: StoreDocsService): Tool {
  return {
    name: 'search_store_docs',
    description: 'Search the user-selected local store document folder (contracts, price lists, schedules, purchase sheets). Returns short excerpts with file names as sources. Use this when answering questions about the user’s own store files, not general industry knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in the store documents.' },
        top: { type: 'number', description: 'Maximum number of excerpts to return. Default 5.' },
        path: { type: 'string', description: 'Optional indexed file path, relative suffix, or file name to restrict the search.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional indexed file paths, relative suffixes, or file names to restrict the search.' },
      },
      required: ['query'],
    },
    isReadOnly: true,
    async execute(input: unknown) {
      const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
      const query = typeof body.query === 'string' ? body.query : ''
      const top = typeof body.top === 'number' ? body.top : 5
      const paths = normalizeSearchPaths(body.paths ?? body.path)
      const hits = await service.search(query, top, { paths })
      if (!hits.length) {
        return paths.length
          ? `没有在指定店铺文件范围内找到相关内容。\n范围:${paths.join('、')}`
          : '没有在店铺资料库里找到相关内容。'
      }
      return [
        '<store_doc_sources>',
        '回答时优先引用这些店铺文件来源；若信息不足，要明确说“资料库里没看到”。引用格式建议写成「据 S1《文件名》」。',
        ...hits.map(hit => [
          `[${hit.source_id}] ${hit.file_name} · 片段 ${hit.chunk_index + 1} · 可信度:${hit.confidence} · 分数:${hit.score}`,
          `匹配:${hit.matched_terms.length ? hit.matched_terms.join('、') : '无'}`,
          `原因:${hit.why}`,
          `摘录:${hit.excerpt}`,
          `路径:${hit.path}`,
        ].join('\n')),
        '</store_doc_sources>',
        '<store_doc_sources_json>',
        jsonForTaggedBlock({ hits }),
        '</store_doc_sources_json>',
      ].join('\n\n')
    },
  }
}

function normalizeSearchPaths(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const cleaned = normalizePathQuery(value)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out.slice(0, 20)
}

function filterChunksByPaths(index: StoreDocsIndex, paths: string[]): StoreDocChunk[] {
  if (!paths.length) return index.chunks
  return index.chunks.filter(chunk => {
    const absolute = normalizePathQuery(chunk.path)
    const relativePath = normalizePathQuery(relative(index.folderPath, chunk.path))
    const name = normalizePathQuery(chunk.fileName)
    return paths.some(scope =>
      scope === absolute ||
      scope === relativePath ||
      scope === name ||
      absolute.endsWith(`/${scope}`) ||
      relativePath.endsWith(`/${scope}`))
  })
}

function normalizePathQuery(value: string): string {
  return value.trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase()
}

function jsonForTaggedBlock(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 8) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())) out.push(path)
    }
  }
  await visit(root, 0)
  return out
}

async function extractText(path: string): Promise<string> {
  if (!existsSync(path)) return ''
  const st = await stat(path)
  if (st.size > MAX_FILE_BYTES) return ''
  const ext = extname(path).toLowerCase()
  if (ext === '.docx' || ext === '.pptx') {
    const doc = await readOfficeDocumentBlocks(path)
    return doc.blocks.map(block => block.text).join('\n')
  }
  if (ext === '.xlsx') {
    const sheet = await readXlsxSheet(path)
    return sheet.sheets.flatMap(s => s.rows.map(row => row.join('\t'))).join('\n')
  }
  return stripBinaryControl(await readFile(path, 'utf8'))
}

function splitChunks(text: string): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim()
  if (!clean) return []
  const chunks: string[] = []
  for (let start = 0; start < clean.length; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    const chunk = clean.slice(start, start + CHUNK_CHARS).trim()
    if (chunk) chunks.push(chunk)
    if (start + CHUNK_CHARS >= clean.length) break
  }
  return chunks
}

function queryTerms(query: string): string[] {
  const normalized = normalizeText(query)
  const raw = normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []
  const terms = new Set<string>()
  for (const item of raw) {
    if (item.length <= 1) continue
    terms.add(item)
    if (/[\p{Script=Han}]/u.test(item) && item.length > 3) {
      for (let i = 0; i < item.length - 1; i++) terms.add(item.slice(i, i + 2))
    }
  }
  return [...terms]
}

function queryProfile(query: string): QueryProfile {
  const needle = normalizeText(query)
  const terms = queryTerms(query)
  const semantic = new Set<string>()
  for (const group of SEMANTIC_ALIAS_GROUPS) {
    const triggered = group.triggers.some(trigger => needle.includes(trigger) || terms.includes(trigger))
    if (!triggered) continue
    for (const term of group.terms) {
      if (term.length > 1 && !terms.includes(term)) semantic.add(term)
    }
  }
  return {
    needle,
    terms,
    semanticTerms: [...semantic],
  }
}

function scoreChunks(chunks: StoreDocChunk[], profile: QueryProfile): ScoredChunk[] {
  const lexical = rankChannel(chunks, profile.terms, profile.needle, 'lexical', 1)
  const semantic = profile.semanticTerms.length
    ? rankChannel(chunks, profile.semanticTerms, '', 'semantic', 0.45)
    : []
  return fuseRankedChannels([
    { name: 'lexical', items: lexical, weight: 1 },
    { name: 'semantic', items: semantic, weight: 0.55 },
  ])
}

function rankChannel(chunks: StoreDocChunk[], terms: string[], needle: string, channel: string, scoreWeight: number): ScoredChunk[] {
  if (!chunks.length || !terms.length) return []
  const docs = chunks.map(chunk => {
    const text = normalizeText(chunk.text)
    const fileName = normalizeText(chunk.fileName)
    return {
      chunk,
      text,
      fileName,
      length: Math.max(1, Math.ceil(text.length / 2)),
    }
  })
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1
  const docFreq = new Map<string, number>()
  for (const term of terms) {
    let count = 0
    for (const doc of docs) {
      if (doc.text.includes(term) || doc.fileName.includes(term)) count += 1
    }
    docFreq.set(term, count)
  }

  const k1 = 1.35
  const b = 0.72
  return docs.map(doc => {
    let score = 0
    const hitTerms = new Set<string>()
    const phraseMatch = !!needle && doc.text.includes(needle)
    const fileNameMatch = !!needle && doc.fileName.includes(needle)
    if (needle) {
      if (phraseMatch) score += 14 + Math.min(8, needle.length / 2)
      if (fileNameMatch) score += 6
    }
    for (const term of terms) {
      const bodyHits = countOccurrences(doc.text, term)
      const fileHits = countOccurrences(doc.fileName, term)
      const tf = bodyHits + fileHits * 2.5
      if (tf <= 0) continue
      hitTerms.add(term)
      const df = docFreq.get(term) || 1
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      const lengthNorm = k1 * (1 - b + b * (doc.length / avgLength))
      const termWeight = term.length >= 4 ? 1.45 : /[\p{Script=Han}]/u.test(term) ? 1.05 : 1
      score += idf * ((tf * (k1 + 1)) / (tf + lengthNorm)) * termWeight
      if (fileHits > 0) score += Math.min(2.5, fileHits * 0.8)
    }
    if (hitTerms.size > 0) score += (hitTerms.size / Math.max(1, terms.length)) * 5
    return {
      chunk: doc.chunk,
      score: score * scoreWeight,
      matchedTerms: [...hitTerms].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 12),
      semanticMatchedTerms: channel === 'semantic'
        ? [...hitTerms].sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 12)
        : [],
      phraseMatch,
      fileNameMatch,
      channels: score > 0 ? [channel] : [],
    }
  })
}

function fuseRankedChannels(channels: Array<{ name: string; items: ScoredChunk[]; weight: number }>): ScoredChunk[] {
  const byId = new Map<string, ScoredChunk & { rrf: number }>()
  for (const channel of channels) {
    const ranked = channel.items
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
    ranked.forEach((item, rank) => {
      const id = item.chunk.id
      const existing = byId.get(id)
      const rrf = channel.weight / (RRF_K + rank + 1)
      if (!existing) {
        byId.set(id, {
          ...item,
          matchedTerms: [...item.matchedTerms],
          semanticMatchedTerms: [...item.semanticMatchedTerms],
          channels: [...item.channels],
          rrf,
        })
        return
      }
      existing.score += item.score
      existing.rrf += rrf
      existing.phraseMatch = existing.phraseMatch || item.phraseMatch
      existing.fileNameMatch = existing.fileNameMatch || item.fileNameMatch
      existing.matchedTerms = mergeTerms(existing.matchedTerms, item.matchedTerms)
      existing.semanticMatchedTerms = mergeTerms(existing.semanticMatchedTerms, item.semanticMatchedTerms)
      existing.channels = [...new Set([...existing.channels, channel.name])]
    })
  }
  return [...byId.values()].map(item => {
    const { rrf, ...rest } = item
    return {
      ...rest,
      score: rest.score + rrf * 18,
      matchedTerms: mergeTerms(rest.matchedTerms, rest.semanticMatchedTerms).slice(0, 12),
    }
  })
}

function mergeTerms(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
}

function confidenceFor(score: number, matchedCount: number, totalTerms: number, phraseMatch: boolean): StoreDocHit['confidence'] {
  const coverage = Math.min(1, matchedCount / Math.max(1, totalTerms))
  if (phraseMatch || score >= 14 || (score >= 8 && coverage >= 0.55)) return 'high'
  if (score >= 4 || coverage >= 0.35) return 'medium'
  return 'low'
}

function reasonFor(item: { phraseMatch: boolean; fileNameMatch: boolean; matchedTerms: string[]; semanticMatchedTerms: string[] }, totalTerms: number): string {
  const reasons: string[] = []
  if (item.phraseMatch) reasons.push('命中完整查询短语')
  if (item.fileNameMatch) reasons.push('文件名命中查询')
  const semantic = new Set(item.semanticMatchedTerms)
  const directTerms = item.matchedTerms.filter(term => !semantic.has(term))
  if (directTerms.length) {
    const coverage = Math.round((Math.min(directTerms.length, totalTerms) / Math.max(1, totalTerms)) * 100)
    reasons.push(`命中 ${directTerms.length}/${Math.max(1, totalTerms)} 个关键词（约 ${coverage}%）`)
  }
  if (item.semanticMatchedTerms.length) {
    reasons.push(`语义扩展命中:${item.semanticMatchedTerms.slice(0, 4).join('、')}`)
  }
  return reasons.length ? reasons.join('；') : '关键词相关度较低，仅供排查'
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = haystack.indexOf(needle)
  while (pos !== -1) {
    count += 1
    pos = haystack.indexOf(needle, pos + Math.max(1, needle.length))
  }
  return count
}

function excerptFor(text: string, terms: string[], needle: string): string {
  const normalized = normalizeText(text)
  let idx = needle ? normalized.indexOf(needle) : -1
  if (idx === -1) {
    const term = terms.find(t => normalized.includes(t))
    idx = term ? normalized.indexOf(term) : 0
  }
  const start = Math.max(0, idx - 80)
  const excerpt = text.slice(start, start + 240).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${excerpt}${start + 240 < text.length ? '…' : ''}`
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '')
}

function stripBinaryControl(value: string): string {
  return value.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function isChunk(value: unknown): value is StoreDocChunk {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StoreDocChunk>
  return typeof item.path === 'string' &&
    typeof item.fileName === 'string' &&
    typeof item.text === 'string' &&
    typeof item.chunkIndex === 'number'
}
