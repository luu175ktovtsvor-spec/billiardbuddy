/**
 * 记忆召回(findRelevantMemories)—— 移植 cc-haha:
 *   - memdir/memoryScan.ts:scanMemoryFiles / formatMemoryManifest(frontmatter 扫描)
 *   - memdir/findRelevantMemories.ts:侧路小模型按 name/description 选 top-5
 *   - utils/attachments.ts:2192 getRelevantMemoryAttachments / readMemoriesForSurfacing /
 *     collectSurfacedMemories(去重 + 会话字节上限)
 *
 * 这是「写进去的记忆能被读回」的核心:每个用户回合开始时,拿用户这句话去 memdir 里
 * 扫所有记忆文件的 frontmatter(name/description/type),让一个便宜档小模型选出最相关的
 * 至多 5 条,把选中主题文件的正文当作一条 <system-reminder> 注入本回合,模型即可直接用上。
 *
 * 白标:memdir 走 getAutoMemDir(workspaceRoot)(~/.billiardbuddy/projects/<slug>/memory),
 * 与写侧(save_memory 工具)、常驻索引读侧(claudemd.getMemoryFiles 的 AutoMem 层)派生同一目录。
 * 侧路小模型的 system prompt 品牌中性、绝不出现底层来源名。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseFrontmatter } from '../harness/claudemd'

// cc utils/attachments.ts:269/277/279-288 —— 与 cc 对齐的召回上限。
/** 单条召回记忆最多注入的行数(cc MAX_MEMORY_LINES)。 */
export const MAX_MEMORY_LINES = 200
/** 单条召回记忆最多注入的字节数(cc MAX_MEMORY_BYTES=4096)。 */
export const MAX_MEMORY_BYTES = 4096
/** 一次最多召回几条(cc:slice(0,5))。 */
export const MAX_RELEVANT_MEMORIES = 5
/** 整个会话累计注入的召回字节上限,超了就不再召回(cc MAX_SESSION_BYTES=60KB)。 */
export const MAX_SESSION_MEMORY_BYTES = 60 * 1024
/** memdir 扫描的记忆文件数量上限(cc memoryScan MAX_MEMORY_FILES)。 */
const MAX_MEMORY_FILES = 200
/** 召回注入块里 <recalled-memory> 的路径标记,用于跨回合去重扫描。 */
const RECALLED_MEMORY_MARKER_RE = /<recalled-memory path="([^"]+)"/g

/** 侧路小模型选择记忆用的品牌中性 system prompt(移植 cc SELECT_MEMORIES_SYSTEM_PROMPT,去掉品牌名)。 */
export const SELECT_MEMORIES_SYSTEM_PROMPT = [
  "You are selecting memories that may help an AI agent answer the user's current request. You will receive the request and a manifest of available memories, each with a file name and short description.",
  '',
  'Return at most 5 memory file names that are clearly useful for the current request:',
  '- Be selective. If relevance is uncertain, do not include the memory.',
  '- Return an empty list when no memory is clearly useful.',
  '- Return only a JSON array of file names, for example ["user_role.md","golden_hours.md"], with no explanation.',
].join('\n')

/** 记忆文件头(frontmatter 扫描结果)。 */
export interface MemoryHeader {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: string | undefined
}

/** 召回结果:绝对路径 + mtime(供上层显示新鲜度,免二次 stat)。 */
export interface RelevantMemory {
  path: string
  mtimeMs: number
}

/** 读回待注入的记忆正文。 */
export interface SurfacedMemory {
  path: string
  content: string
  mtimeMs: number
}

/**
 * 侧路小模型选择器:给用户问题 + 记忆清单,返回小模型的**原始文本**回复
 * (由 findRelevantMemories 用 parseSelectedFilenames 解析出文件名)。
 * 抽成注入点是为了① 复用便宜档模型 ② 测试可传假选择器,不必打真模型。
 */
export type MemorySelector = (input: {
  query: string
  manifest: string
  recentTools: readonly string[]
  signal?: AbortSignal
}) => Promise<string>

// ── 扫描 ──────────────────────────────────────────────────────────────────────

/**
 * 扫 memdir 下所有 .md(排除 MEMORY.md 索引),读 frontmatter 头,按 mtime 新→旧排序、
 * 截断到 MAX_MEMORY_FILES(移植 cc memoryScan.scanMemoryFiles)。目录不存在/读不动 → 返回 []。
 */
export async function scanMemoryFiles(memoryDir: string): Promise<MemoryHeader[]> {
  let entries: string[]
  try {
    entries = await readdir(memoryDir, { recursive: true })
  } catch {
    return []
  }
  const mdFiles = entries.filter(f => f.endsWith('.md') && basename(f) !== 'MEMORY.md')
  const headers = await Promise.all(
    mdFiles.map(async (rel): Promise<MemoryHeader | null> => {
      const filePath = join(memoryDir, rel)
      try {
        const info = await stat(filePath)
        if (!info.isFile()) return null
        const raw = await readFile(filePath, 'utf8')
        const { frontmatter } = parseFrontmatter(raw)
        const description = typeof frontmatter.description === 'string' ? frontmatter.description : null
        const type = typeof frontmatter.type === 'string' ? frontmatter.type : undefined
        return { filename: rel, filePath, mtimeMs: info.mtimeMs, description, type }
      } catch {
        return null
      }
    }),
  )
  return headers
    .filter((h): h is MemoryHeader => h !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES)
}

/** 把记忆头拼成一行一条的清单:`- [type] filename (时间): 描述`(移植 cc formatMemoryManifest)。 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}

/** 从小模型返回的文本里解析出文件名列表:优先 JSON 数组,回退成「清单里出现过的文件名」子串匹配。 */
export function parseSelectedFilenames(text: string, validFilenames: ReadonlySet<string>): string[] {
  const out: string[] = []
  // 先试 JSON 数组(可能被包在解释文字里,取第一个 [...])。
  const arrayMatch = text.match(/\[[\s\S]*?\]/)
  if (arrayMatch) {
    try {
      const parsed: unknown = JSON.parse(arrayMatch[0])
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && validFilenames.has(item) && !out.includes(item)) out.push(item)
        }
        if (out.length > 0) return out
      }
    } catch {
      // 落到子串匹配。
    }
  }
  // 回退:凡在文本里出现过的合法文件名都算被选中(保序按 valid 集合无序,故按出现位置排)。
  const hits: Array<{ name: string; idx: number }> = []
  for (const name of validFilenames) {
    const idx = text.indexOf(name)
    if (idx !== -1) hits.push({ name, idx })
  }
  hits.sort((a, b) => a.idx - b.idx)
  return hits.map(h => h.name)
}

// ── 召回 ──────────────────────────────────────────────────────────────────────

/**
 * 找出与 query 相关的记忆文件(移植 cc findRelevantMemories):扫头 → 小模型选 → 映射成 RelevantMemory。
 * `alreadySurfaced` 在小模型前先过滤,让它把 5 个名额花在没露过的候选上。
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  select: MemorySelector,
  opts?: { recentTools?: readonly string[]; alreadySurfaced?: ReadonlySet<string>; signal?: AbortSignal },
): Promise<RelevantMemory[]> {
  const alreadySurfaced = opts?.alreadySurfaced ?? new Set<string>()
  const memories = (await scanMemoryFiles(memoryDir)).filter(m => !alreadySurfaced.has(m.filePath))
  if (memories.length === 0) return []

  const validFilenames = new Set(memories.map(m => m.filename))
  const manifest = formatMemoryManifest(memories)
  let selectedFilenames: string[]
  try {
    const rawText = await select({
      query,
      manifest,
      recentTools: opts?.recentTools ?? [],
      signal: opts?.signal,
    })
    selectedFilenames = parseSelectedFilenames(rawText, validFilenames)
  } catch {
    return []
  }
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  return selectedFilenames
    .map(f => byFilename.get(f))
    .filter((m): m is MemoryHeader => m !== undefined)
    .slice(0, MAX_RELEVANT_MEMORIES)
    .map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

/**
 * 读回选中的记忆正文以供注入(移植 cc readMemoriesForSurfacing):按行数 + 字节上限截断,
 * 截断时保留前部并追加提示(让模型知道可用 read_file 读全)。读不动的条目丢弃。
 */
export async function readMemoriesForSurfacing(selected: ReadonlyArray<RelevantMemory>): Promise<SurfacedMemory[]> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }): Promise<SurfacedMemory | null> => {
      try {
        const raw = await readFile(filePath, 'utf8')
        const lines = raw.split('\n')
        let truncatedByLines = false
        let body = raw
        if (lines.length > MAX_MEMORY_LINES) {
          body = lines.slice(0, MAX_MEMORY_LINES).join('\n')
          truncatedByLines = true
        }
        let truncatedByBytes = false
        if (Buffer.byteLength(body, 'utf8') > MAX_MEMORY_BYTES) {
          body = Buffer.from(body, 'utf8').subarray(0, MAX_MEMORY_BYTES).toString('utf8')
          const lastNewline = body.lastIndexOf('\n')
          if (lastNewline > 0) body = body.slice(0, lastNewline)
          truncatedByBytes = true
        }
        const content = truncatedByLines || truncatedByBytes
          ? `${body}\n\n> This memory was truncated at ${truncatedByBytes ? `${MAX_MEMORY_BYTES} bytes` : `${MAX_MEMORY_LINES} lines`}. Use read_file to read the complete entry: ${filePath}`
          : body
        return { path: filePath, content, mtimeMs }
      } catch {
        return null
      }
    }),
  )
  return results.filter((r): r is SurfacedMemory => r !== null)
}

/**
 * 把召回记忆拼成一条 <system-reminder> 正文(loop 侧再用 wrapReminder 包壳注入)。
 * 每条带 `<recalled-memory path="..." saved="...">` 标记,供 collectSurfacedMemoryPaths 跨回合去重。
 */
export function buildRelevantMemoriesReminder(memories: ReadonlyArray<SurfacedMemory>): string {
  const blocks = memories.map(m => {
    const saved = new Date(m.mtimeMs).toISOString().slice(0, 10)
    return `<recalled-memory path="${m.path}" saved="${saved}">\n${m.content.trim()}\n</recalled-memory>`
  })
  return [
    "The system recalled the following entries from persistent memory because they may be relevant to the current request. They are not the user's current words.",
    'If a recalled entry conflicts with current evidence, trust the current evidence and consider updating or deleting the stale memory.',
    '',
    ...blocks,
  ].join('\n')
}

/**
 * 扫历史消息,统计已注入过的召回记忆路径与累计字节(移植 cc collectSurfacedMemories)。
 * 通过消息文本里的 `<recalled-memory path="...">` 标记识别 —— 压缩后旧注入随之消失,
 * 于是路径可再次被召回,天然自愈。
 */
export function collectSurfacedMemories(messages: ReadonlyArray<{ role: string; content: unknown }>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: unknown; text?: unknown }
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      RECALLED_MEMORY_MARKER_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = RECALLED_MEMORY_MARKER_RE.exec(b.text)) !== null) {
        paths.add(match[1]!)
      }
      // 累计整块字节(近似 cc 的 per-memory content 累加,足够触发会话上限闸)。
      if (b.text.includes('<recalled-memory ')) totalBytes += Buffer.byteLength(b.text, 'utf8')
    }
  }
  return { paths, totalBytes }
}

/**
 * 一站式:算出这回合该注入的召回记忆块(去重 + 会话字节闸)。无可注入返回 null。
 * loop 侧拿到后用 wrapReminder 包成 text 块追加进用户消息。
 */
export async function computeRelevantMemoryInjection(params: {
  query: string
  memoryDir: string
  select: MemorySelector
  messages: ReadonlyArray<{ role: string; content: unknown }>
  recentTools?: readonly string[]
  signal?: AbortSignal
}): Promise<{ reminder: string; surfaced: SurfacedMemory[] } | null> {
  const { query, memoryDir, select, messages, recentTools, signal } = params
  // 过短/空 query 上下文不足,跳过。cc 用 `!/\s/.test`(单词即跳),但中文句子没有空格、那条规则会把
  // 所有中文问题都误判为「单词」跳掉;本产品中文为主,故改成按长度判(<2 视为过短),不再要求含空白。
  if (!query || query.trim().length < 2) return null
  const surfacedState = collectSurfacedMemories(messages)
  if (surfacedState.totalBytes >= MAX_SESSION_MEMORY_BYTES) return null

  const relevant = await findRelevantMemories(query, memoryDir, select, {
    recentTools,
    alreadySurfaced: surfacedState.paths,
    signal,
  })
  if (relevant.length === 0) return null

  const surfaced = (await readMemoriesForSurfacing(relevant)).filter(m => !surfacedState.paths.has(m.path))
  if (surfaced.length === 0) return null
  return { reminder: buildRelevantMemoriesReminder(surfaced), surfaced }
}
