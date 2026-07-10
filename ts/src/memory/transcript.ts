import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ContentBlock, Message, MessageProvenance } from '../types/message'
import type { ContentReplacementRecord } from '../context/toolResultStorage'

const CID_RE = /^[A-Za-z0-9_-]{1,128}$/
const DEFAULT_PAGE_LIMIT = 200
const MAX_PAGE_LIMIT = 1000

export interface TranscriptPageRecord {
  seq: number
  message: Message
}

export interface TranscriptPage {
  messages: TranscriptPageRecord[]
  nextSeq: number
  hasMore: boolean
}

/** provenance 戳记(对齐 cc:sessionId/cwd/gitBranch);cwd 提供时 gitBranch 会尽力从 .git/HEAD 读。 */
export interface TranscriptProvenance {
  sessionId?: string
  cwd?: string
  gitBranch?: string
}

export interface TranscriptOptions {
  /**
   * 事件日志所在子目录名,默认 `'transcripts'`(与既有子代理/后台任务布局一致)。
   * 主会话走 `''`(扁平)→ `<projects/<slug>>/<id>.jsonl`,对齐 cc `projects/<slug>/<sessionId>.jsonl`。
   */
  subdir?: string
  provenance?: TranscriptProvenance
}

/** 磁盘一行 = 打了 uuid/parentUuid/provenance 戳的 Message(扁平)。uuid 必存,其余 provenance 尽力而为。 */
type StampedMessage = Message & { uuid: string; parentUuid: string | null }

/**
 * 压缩边界标记(对齐 cc SystemCompactBoundaryMessage / createCompactBoundaryMessage):压缩时**不重写**旧历史,
 * 只把这条边界 + 摘要追加进同一条活跃链;边界 parentUuid 接上压缩前最后一条消息,压缩前全量历史仍留在盘上、
 * 且仍在活跃链里(可供 message 级 rewind 定位)。发模型的活跃上下文 = load() 只取「最后一个边界之后」的那段
 * (= 摘要 + 保留的近段),等价 cc getMessagesAfterCompactBoundary。边界自身不是 Message、喂模型前被过滤掉。
 */
interface CompactBoundaryEntry {
  type: 'compact-boundary'
  uuid: string
  parentUuid: string | null
  trigger: 'auto' | 'manual'
  /** 压缩前上一轮响应回报的真实 input tokens(尽力而为,对齐 cc compactMetadata.preTokens)。 */
  preTokens?: number
  /** 被摘要吃掉的消息条数(压缩前条数 − 压缩后条数)。 */
  messagesSummarized?: number
  sessionId?: string
  cwd?: string
  gitBranch?: string
  timestamp?: string
}

/**
 * 回退边界标记(message 级 rewind,append-only 版:**不重写**历史,只在活跃链尾追加一条这样的分叉标记):
 * `rewindTo(targetUuid)` 把「目标消息及其后」整段掰成孤儿分支——它们仍留在文件里(append-only 不删),
 * 只是新 tip(这条边界)的 parentUuid 接回目标消息**前一条**消息(目标是链首则 null),
 * reconstructChain 从新 tip 回溯时便不会再走到被移除的那段。边界自身不是 Message、喂模型前被过滤掉,
 * 且**不算压缩窗口边界**(load() 的裁窗点 lastBoundaryIndex 只认 compact-boundary,rewind-boundary 不裁窗)。
 */
interface RewindBoundaryEntry {
  type: 'rewind-boundary'
  uuid: string
  parentUuid: string | null
  /** 被回退掉的目标消息 uuid(供审计/UI 展示这次回退指向哪条消息)。 */
  targetUuid: string
  /** 被移除的 Message 条数(target 起到原 tip,不计 boundary)。 */
  removedCount?: number
  sessionId?: string
  cwd?: string
  gitBranch?: string
  timestamp?: string
}

/** 事件日志的一条:普通消息、压缩边界标记、或回退边界标记。三者都带 uuid/parentUuid,共用 parentUuid 链重建。 */
type Entry = Message | CompactBoundaryEntry | RewindBoundaryEntry

/** 供上层(rewind 服务)按 uuid 定位活跃链里某条历史消息用的读法:剥 provenance 前保留 uuid/parentUuid 戳。 */
export interface StampedHistoryRecord {
  uuid: string
  parentUuid: string | null
  message: Message
}

function isMessage(x: unknown): x is Message {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (o.role === 'user' || o.role === 'assistant') && Array.isArray(o.content)
}

function isBoundaryRecord(x: unknown): x is CompactBoundaryEntry | RewindBoundaryEntry {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (o.type === 'compact-boundary' || o.type === 'rewind-boundary') && typeof o.uuid === 'string'
}

function isCompactBoundaryEntry(e: Entry): e is CompactBoundaryEntry {
  return (e as { type?: unknown }).type === 'compact-boundary'
}

function isRewindBoundaryEntry(e: Entry): e is RewindBoundaryEntry {
  return (e as { type?: unknown }).type === 'rewind-boundary'
}

/** 两种边界都算(压缩边界 + 回退边界):Message 视图过滤统一用这个——喂模型/UI 回看都不该看见边界本身。 */
function isBoundaryEntry(e: Entry): e is CompactBoundaryEntry | RewindBoundaryEntry {
  return isCompactBoundaryEntry(e) || isRewindBoundaryEntry(e)
}

/** 活跃链里最后一个**压缩**边界的下标(没有则 -1)。⚠️只认 compact-boundary:rewind-boundary 不是压缩窗口边界,
 * 不参与 load() 的裁窗判定——否则回退后 load() 会被误裁成"只剩回退边界之后"(=空),而不是"掰回后的真实活跃视图"。 */
function lastBoundaryIndex(chain: Entry[]): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (isCompactBoundaryEntry(chain[i]!)) return i
  }
  return -1
}

/** 条目带真 uuid 戳(遗留裸 {role,content} 行没有——reconstructChain 对全裸文件走文件顺序兜底,裸条目会出现在活跃链里)。 */
function hasStampedUuid(e: Entry): boolean {
  return typeof e.uuid === 'string' && e.uuid.length > 0
}

/** 从 idx 起往前找最近一条"真消息"(非边界)**且带真 uuid 戳**的 uuid;越界/找不到则 undefined。
 * append() 用它兜底算新分支的 parent——sameMessage 已保证边界永不被判等(故正常不会在 k>0 时撞见边界),
 * 这里只是不依赖那条隐式前提、显式把"跳过边界找最近真消息"这步写清楚。⚠️必须验 uuid 真的存在:
 * 遗留(无戳)条目的 uuid 是 undefined,直接拿去当 parent 会让新消息 parentUuid=null、老历史从活跃链上消失。 */
function nearestMessageUuid(entries: Entry[], idx: number): string | undefined {
  for (let i = idx; i >= 0; i--) {
    const e = entries[i]!
    if (!isBoundaryEntry(e) && hasStampedUuid(e)) return e.uuid as string
  }
  return undefined
}

function isContentReplacementRecord(x: unknown): x is ContentReplacementRecord {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o.kind === 'tool-result' && typeof o.toolUseId === 'string' && typeof o.replacement === 'string'
}

/** 读回内存前剥掉 provenance 戳,还原干净 {role,content}(既有消费者/UI/压缩链路对形状零感知)。 */
function stripProvenance(m: Message): Message {
  return m.role === 'user' ? { role: 'user', content: m.content } : { role: 'assistant', content: m.content }
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_LIMIT
  return Math.min(Math.floor(value), MAX_PAGE_LIMIT)
}

/** 把整份日志文本解析成条目(文件顺序);坏行跳过,不让单行损坏拖垮恢复。压缩边界标记与普通消息一并保留。 */
function parseEntries(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isBoundaryRecord(parsed)) out.push(parsed)
      else if (isMessage(parsed)) out.push(parsed as Message)
    } catch {
      // 坏行跳过。
    }
  }
  return out
}

/**
 * 事件日志重建(对齐 cc buildConversationChain):从"最近 append 的活跃 tip"(= 文件里最后一条带 uuid 的条目)
 * 沿 parentUuid 往根走,拿到当前活跃的线性会话。压缩/预算替换会写出新分支(parentUuid 重接),旧分支留在文件里
 * 但不在活跃链上——单写者 append-only 下"最后一行 = 活跃 tip"恒成立。无戳记(遗留/裸写)时退回文件顺序兜底。
 */
function reconstructChain(entries: Entry[]): Entry[] {
  const withUuid = entries.filter(e => typeof e.uuid === 'string' && e.uuid.length > 0)
  if (withUuid.length === 0) return entries
  const byUuid = new Map<string, Entry>()
  for (const e of withUuid) byUuid.set(e.uuid as string, e)
  const chain: Entry[] = []
  const seen = new Set<string>()
  let cur: Entry | undefined = withUuid[withUuid.length - 1]
  while (cur && typeof cur.uuid === 'string') {
    if (seen.has(cur.uuid)) break // 防环
    seen.add(cur.uuid)
    chain.push(cur)
    const parent = cur.parentUuid
    cur = parent ? byUuid.get(parent) : undefined
  }
  chain.reverse()
  return chain
}

function stableContent(c: ContentBlock[]): string {
  return JSON.stringify(c)
}

/** 按 role + content 判等(忽略 provenance),用于 append 的最长公共前缀比对。b 可能是 view 尾部的边界标记
 * (compact-boundary/rewind-boundary)——边界没有 role/content,显式判 false,绝不会被误判等同真消息。 */
function sameMessage(a: Message, b: Entry): boolean {
  if (isBoundaryEntry(b)) return false
  return a.role === b.role && stableContent(a.content) === stableContent(b.content)
}

/**
 * 会话事件日志(append-only,对齐 cc sessionStorage 的 appendEntryToFile / uuid-parentUuid 链)。
 *
 * 写:`append()` 只把"较盘上活跃链新增/分叉的那段"追加成新行,**绝不整表覆写**(旧的"每回合 tmp+rename
 * 整体快照"已掰回)。压缩走 `recordCompaction()`:压缩前全量历史照留盘上、且仍在活跃链里,只在末尾追加一条
 * compact-boundary 标记 + 压缩后消息(对齐 cc:不重写历史,只 append boundary+summary)。发模型的活跃上下文
 * (`load()`)= 只取「最后一个 compact-boundary 之后」的那段(摘要 + 保留近段),等价 cc getMessagesAfterCompactBoundary;
 * 完整历史(含压缩前)用 `loadFullHistory()`/`loadPage()` 取,供 UI 回看与 message 级 rewind。
 * `save()` 仅用于显式整表重置(fork 播种),是唯一一处允许覆写。
 * 读:`load()`/`loadPage()`/`loadFullHistory()` 顺序读日志 → 按 parentUuid 链重建活跃会话 → 剥回干净 {role,content}。
 */
export class Transcript {
  readonly path: string
  readonly contentReplacementPath: string
  private readonly provenance: TranscriptProvenance
  // append-only 增量状态:我们相信当前落在盘上的"活跃链"(带戳,含 compact-boundary)+ 已知文件字节数;
  // 字节数没变=只有本实例写过,用内存缓存省一次全解析;变了(外部 append)=重读重建。首次(-1)强制读盘同步。
  private persistedChain: Entry[] = []
  private knownByteLen = -1
  private gitBranch: string | undefined
  private gitBranchResolved = false

  constructor(dir: string, conversationId: string, opts: TranscriptOptions = {}) {
    if (!CID_RE.test(conversationId)) throw new Error('非法 conversation id')
    const subdir = opts.subdir ?? 'transcripts'
    const base = subdir ? join(dir, subdir) : dir
    this.path = join(base, `${conversationId}.jsonl`)
    this.contentReplacementPath = join(base, `${conversationId}.content-replacements.jsonl`)
    this.provenance = { sessionId: conversationId, ...opts.provenance }
  }

  /**
   * 读回**发模型的活跃上下文**(= 最后一个 compact-boundary 之后的那段:摘要 + 保留近段;无边界则全量),
   * 按链重建 + 剥 provenance。等价 cc getMessagesAfterCompactBoundary(边界自身不是 Message、被过滤掉)。
   * 主循环 resume 用它:压缩过的会话恢复后模型只见压缩后窗口,压缩前历史留盘不重放。缺文件/全坏行 → 空。
   */
  async load(): Promise<Message[]> {
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return []
    }
    const chain = reconstructChain(parseEntries(text))
    const bi = lastBoundaryIndex(chain)
    const view = bi === -1 ? chain : chain.slice(bi + 1)
    return view.filter((e): e is Message => !isBoundaryEntry(e)).map(stripProvenance)
  }

  /**
   * 读回**完整历史**(含压缩边界前的全部消息),按链重建 + 剥 provenance;压缩边界标记本身过滤掉。
   * 供 UI 回看 / message 级 rewind / fork 拷贝用——它们要看压缩前原文,不该被裁窗。缺文件/全坏行 → 空。
   */
  async loadFullHistory(): Promise<Message[]> {
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return []
    }
    return reconstructChain(parseEntries(text)).filter((e): e is Message => !isBoundaryEntry(e)).map(stripProvenance)
  }

  /**
   * 完整活跃链,但**保留 uuid/parentUuid 戳**(不像 loadFullHistory 剥干净)——rewind 服务按 uuid 定位
   * "回退到哪条历史消息"要靠它(load()/loadFullHistory() 剥了 provenance,定位不到 uuid)。边界标记仍过滤掉,
   * 因为它们不是消息、UI/rewind 选择器不需要看见它们本身。
   */
  async loadFullHistoryStamped(): Promise<StampedHistoryRecord[]> {
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return []
    }
    // 无戳条目(遗留裸行)一并滤掉:它们没有 uuid 身份、没法作 rewind 目标;不滤会产出 uuid:undefined 的
    // 记录,流进 rewindTo(undefined) 还会诡异匹配上第一条裸行。
    return reconstructChain(parseEntries(text))
      .filter((e): e is Message => !isBoundaryEntry(e) && hasStampedUuid(e))
      .map(m => ({ uuid: m.uuid as string, parentUuid: m.parentUuid ?? null, message: stripProvenance(m) }))
  }

  /** 分页读**完整历史**活跃链(含压缩前):seq = 活跃链里的 1 基序号(不是文件行号,孤儿分支/边界不计)。 */
  async loadPage(opts: { after?: number; limit?: number } = {}): Promise<TranscriptPage> {
    const after = Number.isFinite(opts.after) ? Math.max(0, Math.floor(opts.after!)) : 0
    const limit = clampLimit(opts.limit)
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return { messages: [], nextSeq: after, hasMore: false }
    }
    const chain = reconstructChain(parseEntries(text)).filter((e): e is Message => !isBoundaryEntry(e))
    const messages: TranscriptPageRecord[] = []
    let hasMore = false
    for (let i = after; i < chain.length; i++) {
      if (messages.length >= limit) {
        hasMore = true
        break
      }
      messages.push({ seq: i + 1, message: stripProvenance(chain[i]!) })
    }
    return { messages, nextSeq: messages.at(-1)?.seq ?? after, hasMore }
  }

  /**
   * append-only 增量写:比对基准是**最后一个 compact-boundary 之后的活跃视图**(= load() 返回的那段),
   * 与传入 messages 取最长公共前缀(按 role+content 判等,忽略 provenance),只把公共前缀之后的那段打新戳
   * 追加成新行。压缩边界及其之前的全量历史(prefix)始终原样保留、绝不裁掉。常态(尾部新增)= 只写新增消息;
   * 视图内前缀改写(如预算替换)= 从分叉点起打新戳追加成新分支,旧分支留痕不删。整表零覆写。
   */
  async append(messages: Message[]): Promise<void> {
    await this.syncFromDisk()
    const full = this.persistedChain
    const bi = lastBoundaryIndex(full)
    // prefix = 压缩边界及其之前(含 boundary)——恒保留;view = 边界之后的活跃消息(load 视图),作比对基准。
    // ⚠️ view 尾部可能是一条 rewind-boundary(rewindTo 之后、还没有新消息续上时):它不是 Message,
    // sameMessage 对它恒判 false,故正常比对会在碰到它之前就分叉,不会被误判等同新消息。
    const prefix = bi === -1 ? [] : full.slice(0, bi + 1)
    const view = bi === -1 ? full : full.slice(bi + 1)
    let k = 0
    const n = Math.min(messages.length, view.length)
    while (k < n && sameMessage(messages[k]!, view[k]!)) k++
    // 遗留(无 uuid 戳)兼容:公共前缀里第一条裸 {role,content} 条目的下标(没有则 -1)。裸条目只会出现在
    // 老格式全裸文件里(reconstructChain 走文件顺序兜底);新消息/边界没法把 parentUuid 接上去(裸条目没有
    // uuid,链会从接入点断开、老历史从活跃链上消失)——须从第一条裸条目起整段重打戳追加成新分支,让活跃链
    // 在盘上连续;老裸行留痕成孤儿(append-only 不删),内容一条不丢。
    let firstBare = -1
    for (let i = 0; i < k; i++) {
      if (!hasStampedUuid(view[i]!)) {
        firstBare = i
        break
      }
    }
    if (k >= messages.length) {
      // 无新增:常态直接返回;"传入严格更短"也返回(append-only 不删盘上内容)。
      // 例外:等长全匹配且前缀里有裸条目(遗留文件 resume 后零新增就 recordCompaction/续写的场景)——
      // 若在此早退,重打戳不触发,后续 boundary/新消息取链尾 `uuid ?? null` 得 null,老历史照样从链上
      // 消失,必须落到下面的重打戳路径。
      if (firstBare === -1 || messages.length < view.length) return
      k = firstBare
    } else if (firstBare !== -1) {
      k = firstBare
    }
    const branchTail = messages.slice(k)
    // 新段父指针:视图内接上公共前缀最后一条真消息(跳过夹在中间的边界,见 nearestMessageUuid);
    // 视图内 k=0(或前面全是边界)时接上压缩边界(接不上就是根 null)。
    const boundaryParent: string | null = bi === -1 ? null : (full[bi]!.uuid ?? null)
    let parent: string | null = k > 0 ? (nearestMessageUuid(view, k - 1) ?? boundaryParent) : boundaryParent
    const gitBranch = await this.resolveGitBranch()
    const stampedTail: StampedMessage[] = []
    for (const m of branchTail) {
      const s = this.stamp(m, parent, gitBranch)
      stampedTail.push(s)
      parent = s.uuid
    }
    const lines = stampedTail.map(s => `${JSON.stringify(s)}\n`).join('')
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, lines, 'utf8')
    this.persistedChain = [...prefix, ...view.slice(0, k), ...stampedTail]
    this.knownByteLen = (this.knownByteLen < 0 ? 0 : this.knownByteLen) + Buffer.byteLength(lines, 'utf8')
  }

  /**
   * 压缩落盘(对齐 cc autoCompact:**不重写历史**,只在活跃链末尾 append 一条 compact-boundary + 压缩后消息):
   * 1) 先 `append(preCompactMessages)` 把压缩前全量历史补齐到盘(仍在活跃链、可 rewind);
   * 2) 追加一条 compact-boundary,parentUuid 接上压缩前最后一条消息;
   * 3) 追加压缩后消息(摘要 + 保留近段),挂在 boundary 之后。
   * 之后 `load()` 只回步骤 3 那段(裁窗),`loadFullHistory()` 仍能拿到压缩前原文。写失败向上抛,由调用方兜底。
   */
  async recordCompaction(
    preCompactMessages: Message[],
    postCompactMessages: Message[],
    meta: { trigger: 'auto' | 'manual'; preTokens?: number; messagesSummarized?: number },
  ): Promise<void> {
    // 步骤 1:把压缩前历史补齐落盘(dedup 已在盘上的部分,只写未落盘的尾巴);之后 persistedChain 尾 = 压缩前最后一条。
    await this.append(preCompactMessages)
    const gitBranch = await this.resolveGitBranch()
    const full = this.persistedChain
    // 步骤 2:compact-boundary 接上当前活跃链尾(压缩前最后一条消息;空会话则根 null)。
    const boundary = this.stampBoundary(meta, full.at(-1)?.uuid ?? null, gitBranch)
    // 步骤 3:压缩后消息挂在 boundary 之后。
    let parent: string | null = boundary.uuid
    const stampedPost: StampedMessage[] = []
    for (const m of postCompactMessages) {
      const s = this.stamp(m, parent, gitBranch)
      stampedPost.push(s)
      parent = s.uuid
    }
    const lines = [boundary, ...stampedPost].map(e => `${JSON.stringify(e)}\n`).join('')
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, lines, 'utf8')
    this.persistedChain = [...full, boundary, ...stampedPost]
    this.knownByteLen = (this.knownByteLen < 0 ? 0 : this.knownByteLen) + Buffer.byteLength(lines, 'utf8')
  }

  /**
   * message 级 rewind(对齐 cc session rewind,但 append-only 版:**不重写历史**,只在活跃链尾追加一条
   * rewind-boundary 分支标记):在活跃链(含 compact-boundary 之前的完整历史)里找 targetUuid,把它及其后
   * 全部消息掰成孤儿分支——仍留在文件里(append-only 不删),只是新 tip(这条边界)的 parentUuid 接回
   * 目标**前一条**消息(目标是链首则 null)。之后 load()/loadFullHistory()/loadPage() 的活跃链视图自然
   * 裁短到边界之前(reconstructChain 从新 tip 回溯够不到被移除段);继续 append() 新消息时公共前缀比对会在
   * 边界处天然分叉,新分支正确接回保留段最后一条真消息。找不到 targetUuid 抛错(调用方兜底)。
   */
  async rewindTo(targetUuid: string): Promise<{ removedUuids: string[] }> {
    // 兜底防呆:空/undefined 目标直接拒——findIndex 的 `e.uuid === undefined` 会诡异匹配上遗留裸行。
    if (typeof targetUuid !== 'string' || targetUuid.length === 0) throw new Error('rewindTo:targetUuid 不能为空')
    await this.syncFromDisk()
    const full = this.persistedChain
    const idx = full.findIndex(e => e.uuid === targetUuid)
    if (idx === -1) throw new Error(`rewindTo:目标消息不在活跃链里(${targetUuid})`)
    if (isBoundaryEntry(full[idx]!)) throw new Error(`rewindTo:目标是边界标记,不是消息(${targetUuid})`)
    const removedUuids = full.slice(idx)
      .filter((e): e is Message => !isBoundaryEntry(e))
      .map(e => e.uuid as string)
    const parentUuid = idx > 0 ? (full[idx - 1]!.uuid ?? null) : null
    const gitBranch = await this.resolveGitBranch()
    const boundary: RewindBoundaryEntry = {
      type: 'rewind-boundary',
      uuid: randomUUID(),
      parentUuid,
      targetUuid,
      removedCount: removedUuids.length,
    }
    if (this.provenance.sessionId) boundary.sessionId = this.provenance.sessionId
    if (this.provenance.cwd) boundary.cwd = this.provenance.cwd
    if (gitBranch) boundary.gitBranch = gitBranch
    boundary.timestamp = new Date().toISOString()
    const line = `${JSON.stringify(boundary)}\n`
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, line, 'utf8')
    this.persistedChain = [...full.slice(0, idx), boundary]
    this.knownByteLen = (this.knownByteLen < 0 ? 0 : this.knownByteLen) + Buffer.byteLength(line, 'utf8')
    return { removedUuids }
  }

  /** 显式整表重置(fork 播种 / 压缩归档落定):重打全链新戳 + 原子覆写。唯一允许覆写处。 */
  async save(messages: Message[]): Promise<void> {
    const gitBranch = await this.resolveGitBranch()
    let parent: string | null = null
    const stamped: StampedMessage[] = []
    for (const m of messages) {
      const s = this.stamp(m, parent, gitBranch)
      stamped.push(s)
      parent = s.uuid
    }
    const text = stamped.map(s => `${JSON.stringify(s)}\n`).join('')
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, this.path)
    this.persistedChain = stamped
    this.knownByteLen = Buffer.byteLength(text, 'utf8')
  }

  async loadContentReplacementRecords(): Promise<ContentReplacementRecord[]> {
    let text = ''
    try {
      text = await readFile(this.contentReplacementPath, 'utf8')
    } catch {
      return []
    }
    const out: ContentReplacementRecord[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as unknown
        if (isContentReplacementRecord(parsed)) out.push(parsed)
      } catch {
        // 坏行跳过,不让 replacement sidecar 损坏拖垮会话恢复。
      }
    }
    return out
  }

  async appendContentReplacementRecords(records: ContentReplacementRecord[]): Promise<void> {
    if (records.length === 0) return
    await mkdir(dirname(this.contentReplacementPath), { recursive: true })
    await appendFile(this.contentReplacementPath, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
  }

  async seedContentReplacementRecords(records: ContentReplacementRecord[]): Promise<void> {
    if (records.length === 0) return
    await mkdir(dirname(this.contentReplacementPath), { recursive: true })
    await writeFile(this.contentReplacementPath, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
  }

  /** 同步内存活跃链到盘:字节数没变用缓存,变了/首次则全解析重建。 */
  private async syncFromDisk(): Promise<void> {
    let size = 0
    let text = ''
    try {
      size = (await stat(this.path)).size
      if (size === this.knownByteLen && this.knownByteLen >= 0) return
      text = await readFile(this.path, 'utf8')
    } catch {
      this.persistedChain = []
      this.knownByteLen = 0
      return
    }
    this.persistedChain = reconstructChain(parseEntries(text))
    this.knownByteLen = size
  }

  private stamp(message: Message, parentUuid: string | null, gitBranch: string | undefined): StampedMessage {
    // 复用调用方预挂的 uuid(主循环给发起工具调用的 assistant 消息预生成 uuid 并作 file-history 的 messageId,
    // 让「file-history 绑定的 messageId」= 「盘上这条消息的 uuid」,支持 message 级 rewind);未预挂则新生成。
    const uuid = (message as MessageProvenance).uuid ?? randomUUID()
    const stamped: StampedMessage = { ...stripProvenance(message), uuid, parentUuid }
    if (this.provenance.sessionId) stamped.sessionId = this.provenance.sessionId
    if (this.provenance.cwd) stamped.cwd = this.provenance.cwd
    if (gitBranch) stamped.gitBranch = gitBranch
    stamped.timestamp = new Date().toISOString()
    return stamped
  }

  private stampBoundary(
    meta: { trigger: 'auto' | 'manual'; preTokens?: number; messagesSummarized?: number },
    parentUuid: string | null,
    gitBranch: string | undefined,
  ): CompactBoundaryEntry {
    const boundary: CompactBoundaryEntry = { type: 'compact-boundary', uuid: randomUUID(), parentUuid, trigger: meta.trigger }
    if (typeof meta.preTokens === 'number') boundary.preTokens = meta.preTokens
    if (typeof meta.messagesSummarized === 'number') boundary.messagesSummarized = meta.messagesSummarized
    if (this.provenance.sessionId) boundary.sessionId = this.provenance.sessionId
    if (this.provenance.cwd) boundary.cwd = this.provenance.cwd
    if (gitBranch) boundary.gitBranch = gitBranch
    boundary.timestamp = new Date().toISOString()
    return boundary
  }

  /** 尽力而为读 git 分支(不起子进程,直接读 <cwd>/.git/HEAD),缓存一次;任何失败返回 undefined。 */
  private async resolveGitBranch(): Promise<string | undefined> {
    if (this.gitBranchResolved) return this.gitBranch
    this.gitBranchResolved = true
    if (this.provenance.gitBranch) {
      this.gitBranch = this.provenance.gitBranch
      return this.gitBranch
    }
    const cwd = this.provenance.cwd
    if (!cwd) return undefined
    try {
      const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf8')
      const m = head.match(/ref:\s*refs\/heads\/(.+?)\s*$/m)
      if (m) this.gitBranch = m[1]!.trim()
    } catch {
      // 非 git 目录 / 读不到 → 不戳 gitBranch。
    }
    return this.gitBranch
  }
}
