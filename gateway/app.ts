import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  createGatewayTranscriber,
  GatewayTranscriptionError,
  type GatewayTranscriber,
} from './transcription'
import { CapacityQueueError, FairCapacityScheduler } from './modelCapacity'
import {
  fetchQwenWithRetry,
  loadQwenAllowedModels,
  prepareQwenChatBody,
  QwenRequestError,
} from './qwenChat'
import {
  fetchMimoWithRetry,
  loadMimoAllowedModels,
  prepareMimoChatBody,
  MimoRequestError,
} from './mimoChat'
import {
  deepSeekAnthropicMessagesUrl,
  deepseekOpaqueUserId,
  fetchDeepSeekWithRetry,
  loadDeepSeekAllowedModels,
  prepareDeepSeekAnthropicWebSearchBody,
  prepareDeepSeekChatBody,
  DeepSeekRequestError,
} from './deepseekChat'
import {
  containsComputerUseContext,
  containsImageContent,
  createVisionBridge,
  VisionBridgeError,
  type VisionBridge,
} from './visionBridge'

type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type RequestTimeoutController = { timeout(request: Request, seconds: number): void }

type ChatRetryOptions = {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

interface ChatRequestError {
  readonly status: number
  readonly publicMessage: string
}

type ChatRequestErrorCtor = new (status: number, publicMessage: string) => Error & ChatRequestError

// 一个可路由的聊天上游(千问 / MiMo / DeepSeek)。每个上游各自持有独立的凭据、白名单、限速、
// 并发、重试与用量标签;共享的代理逻辑由 createChatHandler 消费本结构,互不串台。
type ChatProvider = {
  label: 'qwen' | 'mimo' | 'deepseek'
  base: string
  key: string
  defaultModel: string
  allowedModels: ReadonlySet<string>
  bucket: TokenBucket
  capacity: FairCapacityScheduler
  queueMaxWait: number
  retryMax: number
  retryBaseMs: number
  retryMaxMs: number
  prepareBody: (rawBody: string, allowed: ReadonlySet<string>, defaultModel: string, ctx?: { userId?: string }) => { body: string }
  // 可选:由受信身份(token#client)派生出传给上游的 opaque user_id(仅 DeepSeek 用)。
  deriveUserId?: (user: string, client: string) => string | undefined
  fetchWithRetry: (
    doRequest: (attempt: number) => Promise<Response>,
    opts: ChatRetryOptions,
  ) => Promise<{ response: Response; attempts: number }>
  RequestError: ChatRequestErrorCtor
  retrySleep?: (ms: number) => Promise<void>
  retryRandom?: () => number
}

// user = token 归属(用量/额度按 token 记账);client = 装机身份(X-QF-Client-ID,格式校验后)。
// 公平调度身份 = user#client(每个装机各占一份单用户公平额度),缺 client 时退回按 token 调度。
type ChatHandler = (request: Request, rawBody: string, user: string, client: string) => Promise<Response>
type NativeAnthropicWebSearchHandler = (
  request: Request,
  rawBody: string,
  user: string,
  client: string,
) => Promise<Response>

type GatewayConfig = {
  qwenKey: string
  qwenBase: string
  qwenModel: string
  relayToken: string
  relayTasksBase: string
  adminToken: string
  db: string
  appTokens: Map<string, string>
  qwenRpm: number
  qwenConc: number
  qwenUserConc: number
  qwenTokenConc: number
  qwenQueueMaxWait: number
  qwenRetryMax: number
  qwenRetryBaseMs: number
  qwenRetryMaxMs: number
  qwenAllowedModels: ReadonlySet<string>
  mimoKey: string
  mimoBase: string
  mimoModel: string
  mimoRpm: number
  mimoConc: number
  mimoUserConc: number
  mimoTokenConc: number
  mimoQueueMaxWait: number
  mimoRetryMax: number
  mimoRetryBaseMs: number
  mimoRetryMaxMs: number
  mimoAllowedModels: ReadonlySet<string>
  deepseekKey: string
  deepseekBase: string
  deepseekModel: string
  deepseekRpm: number
  deepseekConc: number
  deepseekUserConc: number
  deepseekTokenConc: number
  deepseekQueueMaxWait: number
  deepseekRetryMax: number
  deepseekRetryBaseMs: number
  deepseekRetryMaxMs: number
  deepseekAllowedModels: ReadonlySet<string>
  // 视觉桥接(非原生多模态文本模型 + 带图请求时,先用 MiMo v2.5 把图读成结构化文本再转给文本模型)。
  visionMaxImages: number
  visionMaxImageBytes: number
  // 同时也是 /v1/chat/completions 的整体请求体大小闸(在任何路由/解析/许可之前生效)。
  visionMaxTotalBytes: number
  visionTimeoutMs: number
  visionConc: number
  visionQueueMax: number
  visionPerRequestConc: number
  visionCacheMax: number
  visionCacheTtlMs: number
  imgIpm: number
  imgTaskMaxBodyBytes: number
  queueMaxWait: number
  transcribeRpm: number
  transcribeConc: number
  transcribeMaxBytes: number
}

type UsageEntry = {
  user: string
  model: string
  ok: boolean
  status: number
  ms: number
  note?: string
}

export interface UsageStore {
  log(entry: UsageEntry): void | Promise<void>
  todayByModel(): Array<{ model: string; total: number; ok: number }> | Promise<Array<{ model: string; total: number; ok: number }>>
  recent(n: number): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>
}

export interface GatewayDeps {
  env?: Env
  fetchImpl?: FetchLike
  usageStore?: UsageStore
  transcribeImpl?: GatewayTranscriber | null
  qwenRetrySleep?: (ms: number) => Promise<void>
  qwenRetryRandom?: () => number
  mimoRetrySleep?: (ms: number) => Promise<void>
  mimoRetryRandom?: () => number
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail)
  }
}

class TokenBucket {
  private capacity: number
  private tokens: number
  private rate: number
  private ts = performance.now()
  private chain: Promise<void> = Promise.resolve()

  constructor(rpm: number) {
    this.capacity = Math.max(1, rpm)
    this.tokens = this.capacity
    this.rate = this.capacity / 60_000
  }

  async acquire(maxWaitSeconds: number, signal?: AbortSignal): Promise<void> {
    const previous = this.chain
    let release!: () => void
    this.chain = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      const deadline = performance.now() + Math.max(0, maxWaitSeconds) * 1000
      while (true) {
        if (signal?.aborted) throw new HttpError(499, '请求已取消')
        const now = performance.now()
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.ts) * this.rate)
        this.ts = now
        if (this.tokens >= 1) {
          this.tokens -= 1
          return
        }
        const needMs = (1 - this.tokens) / this.rate
        if (performance.now() + needMs > deadline) {
          throw new HttpError(429, '现在用的人多,稍等一下再发(已在排队保护)')
        }
        await sleep(Math.min(needMs, 500), signal)
      }
    } finally {
      release()
    }
  }
}

class AsyncSemaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(limit: number) {
    this.limit = Math.max(1, limit)
  }

  private readonly limit: number

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>(resolve => this.queue.push(resolve))
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }
}

export class SqliteUsageStore implements UsageStore {
  private db: Database

  constructor(path: string) {
    const dir = dirname(path)
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS usage(' +
      'id INTEGER PRIMARY KEY, ts TEXT, day TEXT, user TEXT, model TEXT, ' +
      'ok INTEGER, status INTEGER, ms INTEGER, note TEXT)'
    )
  }

  log(entry: UsageEntry): void {
    this.db
      .query('INSERT INTO usage(ts,day,user,model,ok,status,ms,note) VALUES(?,?,?,?,?,?,?,?)')
      .run(timestampCst(), todayCst(), entry.user, entry.model, entry.ok ? 1 : 0, entry.status, entry.ms, entry.note ?? '')
  }

  todayByModel(): Array<{ model: string; total: number; ok: number }> {
    return this.db
      .query('SELECT model, COUNT(*) AS total, SUM(ok) AS ok FROM usage WHERE day=? GROUP BY model')
      .all(todayCst())
      .map((row: any) => ({ model: String(row.model), total: Number(row.total ?? 0), ok: Number(row.ok ?? 0) }))
  }

  recent(n: number): Array<Record<string, unknown>> {
    return this.db
      .query('SELECT ts,user,model,ok,status,ms,note FROM usage ORDER BY id DESC LIMIT ?')
      .all(n) as Array<Record<string, unknown>>
  }
}

export class MemoryUsageStore implements UsageStore {
  readonly rows: Array<UsageEntry & { ts: string; day: string }> = []

  log(entry: UsageEntry): void {
    this.rows.push({ ...entry, ts: timestampCst(), day: todayCst() })
  }

  todayByModel(): Array<{ model: string; total: number; ok: number }> {
    const day = todayCst()
    const grouped = new Map<string, { model: string; total: number; ok: number }>()
    for (const row of this.rows) {
      if (row.day !== day) continue
      const current = grouped.get(row.model) ?? { model: row.model, total: 0, ok: 0 }
      current.total += 1
      current.ok += row.ok ? 1 : 0
      grouped.set(row.model, current)
    }
    return [...grouped.values()]
  }

  recent(n: number): Array<Record<string, unknown>> {
    return this.rows.slice(-n).reverse().map(row => ({
      ts: row.ts,
      user: row.user,
      model: row.model,
      ok: row.ok ? 1 : 0,
      status: row.status,
      ms: row.ms,
      note: row.note ?? '',
    }))
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HttpError(499, '请求已取消'))
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new HttpError(499, '请求已取消'))
    }
    function done() {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * 受限流式读取请求体：逐 chunk 从 request.body 读取并累计真实字节数，一旦超过 maxBytes 立即
 * cancel reader 并 413 失败关闭——不等读完整个超大 body（旧实现 `request.text()` 会先把整个
 * body 囫囵吞进内存，再检查长度，防不住超大/chunked/伪造 Content-Length 的请求先占满内存）。
 * 以逐 chunk 累计的真实字节数为准，不信任可能被伪造的 Content-Length 头或依赖 chunked 编码；
 * 调用方应在此之前先用声明的 Content-Length 做一次读 body 之前的快速预检（常规场景零额外开销），
 * 这里是无法被伪造绕过的兜底硬上限。
 * 三条失败路径互斥：读到的真实字节超限 → 413；客户端取消(request.signal abort) → 499；
 * reader.read() 本身抛错(网络/协议异常) → 400。
 */
async function readRequestBodyBounded(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let aborted = request.signal?.aborted ?? false
  const onAbort = () => {
    aborted = true
    reader.cancel().catch(() => {})
  }
  if (!aborted) request.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (aborted) throw new HttpError(499, '请求已取消')
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        if (aborted) throw new HttpError(499, '请求已取消')
        throw new HttpError(400, '请求体读取失败')
      }
      // cancel() 触发的 abort 可能让挂起的 read() 以 {done:true} 而非抛错的方式结算，
      // 这里再判一次，不让已取消的请求被当成"正常读完"放行。
      if (aborted) throw new HttpError(499, '请求已取消')
      if (result.done) break
      const value = result.value
      if (value && value.byteLength > 0) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new HttpError(413, '请求体过大')
        }
        chunks.push(value)
      }
    }
  } finally {
    request.signal?.removeEventListener('abort', onAbort)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function floatEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function required(env: Env, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parseAppTokens(raw: string | undefined): Map<string, string> {
  if (!raw) return new Map()
  const parsed = JSON.parse(raw)
  return new Map(Object.entries(parsed).map(([token, user]) => [token, String(user)]))
}

function loadConfig(env: Env): GatewayConfig {
  return {
    // 真实上游密钥只在服务端读取,缺失时对应上游 handler 置空(路由到它会 503),绝不回退到另一家。
    qwenKey: env.GW_QWEN_KEY ?? '',
    qwenBase: (env.GW_QWEN_BASE ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    qwenModel: env.GW_QWEN_MODEL ?? 'qwen3-coder-plus',
    relayToken: required(env, 'GW_RELAY_TOKEN'),
    // 美国 relay 上的 GPT 生图异步任务服务(relay/app.ts)地址;缺则异步任务端点返回 503,客户端退同步路径。
    relayTasksBase: (env.GW_RELAY_TASKS_BASE ?? '').replace(/\/+$/, ''),
    adminToken: env.GW_ADMIN_TOKEN ?? 'change-me',
    db: env.GW_DB ?? '/opt/qfgw/usage.db',
    appTokens: parseAppTokens(env.GW_APP_TOKENS),
    // RPM 默认值抬到不再卡正常文字流量(本地令牌桶曾是"80 并发 p95 17s"的元凶);GW_*_CONC 仍是
    // 保护上游的高水位紧急总闸,真正收紧限速请调小对应 env,不靠这个默认值节流。
    qwenRpm: intEnv(env, 'GW_QWEN_RPM', 100_000),
    qwenConc: Math.max(1, intEnv(env, 'GW_QWEN_CONC', 16)),
    // 单装机并发默认 = 全局并发(不再单独节流单装机);GW_*_CONC 全局闸继续兜底。
    qwenUserConc: Math.max(1, intEnv(env, 'GW_QWEN_USER_CONC', intEnv(env, 'GW_QWEN_CONC', 16))),
    // 单 token 名下所有装机合计在途上限:默认=全局并发(共享私测 token 需用满整池)。发独立用户
    // token 后设为低于全局以在 token 间预留 headroom;是防"单 token 伪造多装机独占池"的二级闸。
    qwenTokenConc: Math.max(1, intEnv(env, 'GW_QWEN_TOKEN_CONC', intEnv(env, 'GW_QWEN_CONC', 16))),
    qwenQueueMaxWait: Math.max(0, floatEnv(env, 'GW_QWEN_QUEUE_MAX_WAIT', 120)),
    // 一次逻辑调用最多只额外尝试一次(连接错误/可重试 5xx),硬夹在 [0,1]:CC CLI 自己也会重试,
    // 网关再叠加多次会把一次调用放大成对上游的多次请求。429 由 isRetryableStatus 直接不重试。
    qwenRetryMax: Math.max(0, Math.min(1, intEnv(env, 'GW_QWEN_MAX_RETRIES', 1))),
    qwenRetryBaseMs: Math.max(1, intEnv(env, 'GW_QWEN_RETRY_BASE_MS', 500)),
    qwenRetryMaxMs: Math.max(1, intEnv(env, 'GW_QWEN_RETRY_MAX_MS', 8000)),
    qwenAllowedModels: loadQwenAllowedModels(env),
    mimoKey: env.GW_MIMO_KEY ?? '',
    mimoBase: (env.GW_MIMO_BASE ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    mimoModel: env.GW_MIMO_MODEL ?? 'mimo-v2.5',
    mimoRpm: intEnv(env, 'GW_MIMO_RPM', 100_000),
    mimoConc: Math.max(1, intEnv(env, 'GW_MIMO_CONC', 16)),
    mimoUserConc: Math.max(1, intEnv(env, 'GW_MIMO_USER_CONC', intEnv(env, 'GW_MIMO_CONC', 16))),
    mimoTokenConc: Math.max(1, intEnv(env, 'GW_MIMO_TOKEN_CONC', intEnv(env, 'GW_MIMO_CONC', 16))),
    mimoQueueMaxWait: Math.max(0, floatEnv(env, 'GW_MIMO_QUEUE_MAX_WAIT', 120)),
    // 同 qwen:最多额外一次,硬夹在 [0,1],避免与 CC CLI 重试相乘。
    mimoRetryMax: Math.max(0, Math.min(1, intEnv(env, 'GW_MIMO_MAX_RETRIES', 1))),
    mimoRetryBaseMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_BASE_MS', 500)),
    mimoRetryMaxMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_MAX_MS', 8000)),
    mimoAllowedModels: loadMimoAllowedModels(env),
    // DeepSeek V4 Flash:真 key 只在服务器。全局并发 32、RPM 放开到不限流,靠真实压测再收紧;
    // 不因官方账号并发(~2500)就直接放到无限。缺 key 时路由到它会 503,绝不改投千问/MiMo。
    deepseekKey: env.GW_DEEPSEEK_KEY ?? '',
    deepseekBase: (env.GW_DEEPSEEK_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    deepseekModel: env.GW_DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    deepseekRpm: intEnv(env, 'GW_DEEPSEEK_RPM', 100_000),
    deepseekConc: Math.max(1, intEnv(env, 'GW_DEEPSEEK_CONC', 32)),
    deepseekUserConc: Math.max(1, intEnv(env, 'GW_DEEPSEEK_USER_CONC', intEnv(env, 'GW_DEEPSEEK_CONC', 32))),
    deepseekTokenConc: Math.max(1, intEnv(env, 'GW_DEEPSEEK_TOKEN_CONC', intEnv(env, 'GW_DEEPSEEK_CONC', 32))),
    deepseekQueueMaxWait: Math.max(0, floatEnv(env, 'GW_DEEPSEEK_QUEUE_MAX_WAIT', 120)),
    // 同 qwen/mimo:最多额外一次,硬夹在 [0,1]。
    deepseekRetryMax: Math.max(0, Math.min(1, intEnv(env, 'GW_DEEPSEEK_MAX_RETRIES', 1))),
    deepseekRetryBaseMs: Math.max(1, intEnv(env, 'GW_DEEPSEEK_RETRY_BASE_MS', 500)),
    deepseekRetryMaxMs: Math.max(1, intEnv(env, 'GW_DEEPSEEK_RETRY_MAX_MS', 8000)),
    deepseekAllowedModels: loadDeepSeekAllowedModels(env),
    // 视觉桥接上限:超限在调用 MiMo 之前就失败关闭。visionMaxTotalBytes 同时也是整个聊天请求体
    // (含非图片请求)的大小闸,在任何路由/许可之前生效——图片 base64 是拖垮请求体积的主因。
    visionMaxImages: Math.max(1, intEnv(env, 'GW_VISION_MAX_IMAGES', 8)),
    visionMaxImageBytes: Math.max(1, intEnv(env, 'GW_VISION_MAX_IMAGE_BYTES', 8 * 1024 * 1024)),
    visionMaxTotalBytes: Math.max(1, intEnv(env, 'GW_VISION_MAX_TOTAL_BYTES', 24 * 1024 * 1024)),
    visionTimeoutMs: Math.max(1, intEnv(env, 'GW_VISION_TIMEOUT_MS', 45_000)),
    visionConc: Math.max(1, intEnv(env, 'GW_VISION_CONC', 12)),
    // 视觉排队队列的硬上限(不含正在执行的 GW_VISION_CONC 个)：50~100 装机私测阶段，按
    // "全局在途并发(12)的约 5 倍"给一个保守值——既防队列无界增长打爆内存，又不至于让正常的
    // 突发（多个装机同时贴图）过早被 429；真实生产量上来后按压测结果再收紧或放宽。
    visionQueueMax: Math.max(1, intEnv(env, 'GW_VISION_QUEUE_MAX', 64)),
    // 单个聊天请求最多同时占用几个全局视觉并发槽：默认 2——一个最多 GW_VISION_MAX_IMAGES(8)张图
    // 的请求最多同时占 2 个全局槽，给同一时刻到达的其它请求留出至少 (GW_VISION_CONC-2) 个槽位，
    // 不被单个大请求饿死；请求内相同图片仍按哈希去重只调一次，不受此限流放大延迟。
    visionPerRequestConc: Math.max(1, intEnv(env, 'GW_VISION_PER_REQUEST_CONC', 2)),
    visionCacheMax: Math.max(1, intEnv(env, 'GW_VISION_CACHE_MAX', 512)),
    visionCacheTtlMs: Math.max(1, intEnv(env, 'GW_VISION_CACHE_TTL_MS', 600_000)),
    imgIpm: intEnv(env, 'GW_IMG_IPM', 18),
    // 20 MB decoded reference images expand to about 26.7 MB as base64. Enforce the
    // same 32 MB request ceiling at the public gateway before buffering or forwarding.
    imgTaskMaxBodyBytes: Math.max(1, intEnv(env, 'GW_IMG_TASK_MAX_BODY_BYTES', 32 * 1024 * 1024)),
    queueMaxWait: floatEnv(env, 'GW_QUEUE_MAX_WAIT', 60),
    transcribeRpm: intEnv(env, 'GW_TRANSCRIBE_RPM', 12),
    transcribeConc: intEnv(env, 'GW_TRANSCRIBE_CONC', 1),
    transcribeMaxBytes: intEnv(env, 'GW_TRANSCRIBE_MAX_BYTES', 96 * 1024 * 1024),
  }
}

function supportedAudio(file: File): boolean {
  const type = file.type.toLowerCase()
  if (type.startsWith('audio/')) return true
  if (type === 'video/mp4' || type === 'video/webm' || type === 'application/octet-stream' || type === '') {
    return /\.(wav|wave|mp3|m4a|mp4|webm|ogg|oga|flac|aac)$/i.test(file.name)
  }
  return false
}

function todayCst(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function timestampCst(): string {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().replace('Z', '+08:00')
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init)
}

function jsonError(status: number, detail: string): Response {
  return jsonResponse({ detail }, { status })
}

function isJsonContentType(value: string | null): boolean {
  return (value ?? '').toLowerCase().startsWith('application/json')
}

async function proxyJsonOrRaw(resp: Response): Promise<Response> {
  const contentType = resp.headers.get('content-type')
  if (isJsonContentType(contentType)) {
    return jsonResponse(await resp.json(), { status: resp.status })
  }
  return jsonResponse({ raw: (await resp.text()).slice(0, 500) }, { status: resp.status })
}

function auth(config: GatewayConfig, request: Request): string {
  const user = authenticatedUser(config, request)
  if (!user) {
    const header = request.headers.get('authorization') ?? ''
    if (!header.toLowerCase().startsWith('bearer ')) throw new HttpError(401, '缺少 app 令牌')
    throw new HttpError(401, 'app 令牌无效')
  }
  return user
}

function authenticatedUser(config: GatewayConfig, request: Request): string | undefined {
  const header = request.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return undefined
  const token = header.slice(7).trim()
  return config.appTokens.get(token)
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/

/**
 * 装机身份(X-QF-Client-ID = 桌面端持久化的 installationId)。只做格式校验:
 * 合法则返回,非法/缺失返回空串(退回按 token 调度,老客户端不破)。装机身份只用于细分
 * 单用户公平与用量归属,不参与鉴权、不提权,伪造它也拿不到超过全局上限的额度。
 */
function readClientId(request: Request): string {
  const raw = (request.headers.get('x-qf-client-id') ?? '').trim()
  return CLIENT_ID_PATTERN.test(raw) ? raw : ''
}

/** 传给美国 relay 的受信任务归属身份 = user#client(缺 client 时退回 user)。 */
function relayOwner(user: string, client: string): string {
  return client ? `${user}#${client}` : user
}

async function logUsage(store: UsageStore, entry: UsageEntry): Promise<void> {
  await store.log(entry)
}

function withStreamLogging(
  resp: Response,
  onDone: () => Promise<void>,
  onChunk?: (chunk: Uint8Array) => void,
): Response {
  const headers = new Headers()
  const contentType = resp.headers.get('content-type')
  const contentEncoding = resp.headers.get('content-encoding')
  if (contentType) headers.set('content-type', contentType)
  if (contentEncoding) headers.set('content-encoding', contentEncoding)

  if (!resp.body) {
    void onDone()
    return new Response(null, { status: resp.status, headers })
  }

  const reader = resp.body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          await onDone()
          return
        }
        onChunk?.(value)
        controller.enqueue(value)
      } catch (error) {
        // 上游中途断流(reader.read 抛错):既有实现只在 done/cancel 调 onDone,此路径会漏放许可。
        // 显式在这里 error + 释放许可,保证任何终止路径 active/queued 都回落,不泄漏并发名额。
        controller.error(error)
        await onDone()
      }
    },
    async cancel(reason) {
      // 客户端断开:释放许可。cancel body 本身失败不应吞掉许可释放。
      try { await reader.cancel(reason) } catch { /* ignore */ }
      await onDone()
    },
  })
  return new Response(stream, { status: resp.status, headers })
}

// 仅用于路由决策:宽松解析 model 名,解析失败返回空串(交由 handler 的 prepareBody 兜底 400)。
function parseChatModel(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody)
    if (isRecord(parsed) && typeof parsed.model === 'string') return parsed.model
  } catch {
    // 请求体不是合法 JSON 时不在此报错;路由到默认上游后由 prepareBody 统一 fail closed。
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把单个聊天上游(千问 / MiMo)的代理逻辑收敛成一个 handler:鉴权后的容量许可、令牌桶限速、
 * 带重试的上游 fetch、SSE 原样透传、上游错误脱敏、用量落库都走同一套,只由传入的 provider 参数化。
 * 关键:handler 只会用 provider 自己的凭据/白名单/限速/重试,永不跨上游回退。
 */
function createChatHandler(provider: ChatProvider, fetchImpl: FetchLike, store: UsageStore): ChatHandler {
  return async function chatHandler(request: Request, rawBody: string, user: string, client: string): Promise<Response> {
    // prepareBody 在拿容量许可之前跑,校验失败(400/503)不会漏掉一个许可名额。
    // DeepSeek 在这里注入受信 opaque user_id;千问/MiMo 无 deriveUserId,ctx 被忽略。
    const userId = provider.deriveUserId?.(user, client)
    const prepared = provider.prepareBody(rawBody, provider.allowedModels, provider.defaultModel, { userId })
    // 公平调度按装机身份细分:同一 token 的不同装机各占一份单用户额度。装机身份只细分单用户
    // 公平,永远受同一个 provider 全局并发上限约束,伪造装机 id 也无法放大全局额度或提权。
    const schedId = client ? `${user}#${client}` : user
    const usageNote = (attempts: number) => `attempts=${attempts}${client ? `;client=${client}` : ''}`
    // tokenId=user 让"同一 token 名下所有装机"合计受 maxConcurrentPerToken 约束:即使伪造任意多
    // client id,一个 token 也拿不到超过其 token 级上限的在途,防单 token 独占整池。
    const permit = await provider.capacity.acquire(schedId, {
      maxWaitMs: provider.queueMaxWait * 1000,
      signal: request.signal,
      tokenId: user,
    })
    const started = performance.now()
    try {
      const { response: upstream, attempts } = await provider.fetchWithRetry(async () => {
        try {
          await provider.bucket.acquire(provider.queueMaxWait, request.signal)
        } catch (error) {
          if (error instanceof HttpError) throw new provider.RequestError(error.status, error.detail)
          throw error
        }
        return await fetchImpl(`${provider.base}/chat/completions`, {
          method: 'POST',
          body: prepared.body,
          signal: request.signal,
          headers: {
            Authorization: `Bearer ${provider.key}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'identity',
          },
        })
      }, {
        maxRetries: provider.retryMax,
        baseDelayMs: provider.retryBaseMs,
        maxDelayMs: provider.retryMaxMs,
        signal: request.signal,
        sleep: provider.retrySleep,
        random: provider.retryRandom,
      })

      if (!upstream.ok) {
        const upstreamDetail = await upstream.text().catch(() => '')
        permit.release()
        await logUsage(store, {
          user,
          model: provider.label,
          ok: false,
          status: upstream.status,
          ms: elapsedMs(started),
          note: usageNote(attempts),
        })
        return jsonError(upstream.status, modelPublicError(upstream.status, upstreamDetail))
      }

      let completed = false
      const complete = async () => {
        if (completed) return
        completed = true
        permit.release()
        await logUsage(store, { user, model: provider.label, ok: true, status: upstream.status, ms: elapsedMs(started), note: usageNote(attempts) })
      }
      return withStreamLogging(upstream, complete)
    } catch (error) {
      permit.release()
      const known = error instanceof provider.RequestError
      const status = known ? error.status : 502
      const detail = known ? error.publicMessage : '模型服务暂时不可用，请稍后重试'
      await logUsage(store, {
        user,
        model: provider.label,
        ok: false,
        status,
        ms: elapsedMs(started),
        note: 'upstream_request_failed',
      })
      throw new HttpError(status, detail)
    }
  }
}

/**
 * Narrow native Anthropic route for Claude Code's WebSearchTool. Normal agent
 * chat deliberately remains on the OpenAI-compatible path so Qwen/MiMo
 * routing and the server-side image bridge keep their existing contracts.
 */
function createNativeAnthropicWebSearchHandler(
  provider: ChatProvider,
  fetchImpl: FetchLike,
  store: UsageStore,
): NativeAnthropicWebSearchHandler {
  return async function nativeAnthropicWebSearchHandler(
    request: Request,
    rawBody: string,
    user: string,
    client: string,
  ): Promise<Response> {
    const userId = provider.deriveUserId?.(user, client)
    const prepared = prepareDeepSeekAnthropicWebSearchBody(
      rawBody,
      provider.allowedModels,
      provider.defaultModel,
      { userId },
    )
    const schedulerId = client ? `${user}#${client}` : user
    const permit = await provider.capacity.acquire(schedulerId, {
      maxWaitMs: provider.queueMaxWait * 1000,
      signal: request.signal,
      tokenId: user,
    })
    const started = performance.now()
    const usageNote = (attempts: number) => `native_web_search;attempts=${attempts}${client ? `;client=${client}` : ''}`

    try {
      const { response: upstream, attempts } = await provider.fetchWithRetry(async () => {
        try {
          await provider.bucket.acquire(provider.queueMaxWait, request.signal)
        } catch (error) {
          if (error instanceof HttpError) throw new provider.RequestError(error.status, error.detail)
          throw error
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-api-key': provider.key,
          'anthropic-version': request.headers.get('anthropic-version')?.trim() || '2023-06-01',
          'Accept-Encoding': 'identity',
        }
        const beta = request.headers.get('anthropic-beta')?.trim()
        if (beta) headers['anthropic-beta'] = beta
        const accept = request.headers.get('accept')?.trim()
        if (accept) headers.Accept = accept

        return await fetchImpl(deepSeekAnthropicMessagesUrl(provider.base), {
          method: 'POST',
          body: prepared.body,
          signal: request.signal,
          headers,
        })
      }, {
        maxRetries: provider.retryMax,
        baseDelayMs: provider.retryBaseMs,
        maxDelayMs: provider.retryMaxMs,
        signal: request.signal,
        sleep: provider.retrySleep,
        random: provider.retryRandom,
      })

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '')
        permit.release()
        await logUsage(store, {
          user,
          model: 'deepseek_web_search',
          ok: false,
          status: upstream.status,
          ms: elapsedMs(started),
          note: usageNote(attempts),
        })
        return Response.json({
          type: 'error',
          error: {
            type: 'api_error',
            message: modelPublicError(upstream.status, detail),
          },
        }, { status: upstream.status })
      }

      let completed = false
      const complete = async () => {
        if (completed) return
        completed = true
        permit.release()
        await logUsage(store, {
          user,
          model: 'deepseek_web_search',
          ok: true,
          status: upstream.status,
          ms: elapsedMs(started),
          note: usageNote(attempts),
        })
      }
      return withStreamLogging(upstream, complete)
    } catch (error) {
      permit.release()
      const known = error instanceof provider.RequestError
      const status = known ? error.status : 502
      const detail = known ? error.publicMessage : '联网资料检索暂时不可用，请稍后重试'
      await logUsage(store, {
        user,
        model: 'deepseek_web_search',
        ok: false,
        status,
        ms: elapsedMs(started),
        note: 'native_web_search_failed',
      })
      throw new HttpError(status, detail)
    }
  }
}

export function createGatewayFetch(deps: GatewayDeps = {}) {
  const env = deps.env ?? process.env
  const config = loadConfig(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const store = deps.usageStore ?? new SqliteUsageStore(config.db)
  const qwenBucket = new TokenBucket(config.qwenRpm)
  const qwenCapacity = new FairCapacityScheduler(config.qwenConc, config.qwenUserConc, config.qwenTokenConc)
  const mimoBucket = new TokenBucket(config.mimoRpm)
  const mimoCapacity = new FairCapacityScheduler(config.mimoConc, config.mimoUserConc, config.mimoTokenConc)
  // 每个上游各自的 handler:缺对应密钥则为 null,路由到它时直接 503,绝不静默改投另一家。
  const qwenChat: ChatHandler | null = config.qwenKey
    ? createChatHandler({
      label: 'qwen',
      base: config.qwenBase,
      key: config.qwenKey,
      defaultModel: config.qwenModel,
      allowedModels: config.qwenAllowedModels,
      bucket: qwenBucket,
      capacity: qwenCapacity,
      queueMaxWait: config.qwenQueueMaxWait,
      retryMax: config.qwenRetryMax,
      retryBaseMs: config.qwenRetryBaseMs,
      retryMaxMs: config.qwenRetryMaxMs,
      prepareBody: prepareQwenChatBody,
      fetchWithRetry: fetchQwenWithRetry,
      RequestError: QwenRequestError,
      retrySleep: deps.qwenRetrySleep,
      retryRandom: deps.qwenRetryRandom,
    }, fetchImpl, store)
    : null
  const mimoChat: ChatHandler | null = config.mimoKey
    ? createChatHandler({
      label: 'mimo',
      base: config.mimoBase,
      key: config.mimoKey,
      defaultModel: config.mimoModel,
      allowedModels: config.mimoAllowedModels,
      bucket: mimoBucket,
      capacity: mimoCapacity,
      queueMaxWait: config.mimoQueueMaxWait,
      retryMax: config.mimoRetryMax,
      retryBaseMs: config.mimoRetryBaseMs,
      retryMaxMs: config.mimoRetryMaxMs,
      prepareBody: prepareMimoChatBody,
      fetchWithRetry: fetchMimoWithRetry,
      RequestError: MimoRequestError,
      retrySleep: deps.mimoRetrySleep,
      retryRandom: deps.mimoRetryRandom,
    }, fetchImpl, store)
    : null
  const deepseekBucket = new TokenBucket(config.deepseekRpm)
  const deepseekCapacity = new FairCapacityScheduler(config.deepseekConc, config.deepseekUserConc, config.deepseekTokenConc)
  const deepseekProvider: ChatProvider | null = config.deepseekKey
    ? {
      label: 'deepseek',
      base: config.deepseekBase,
      key: config.deepseekKey,
      defaultModel: config.deepseekModel,
      allowedModels: config.deepseekAllowedModels,
      bucket: deepseekBucket,
      capacity: deepseekCapacity,
      queueMaxWait: config.deepseekQueueMaxWait,
      retryMax: config.deepseekRetryMax,
      retryBaseMs: config.deepseekRetryBaseMs,
      retryMaxMs: config.deepseekRetryMaxMs,
      prepareBody: prepareDeepSeekChatBody,
      fetchWithRetry: fetchDeepSeekWithRetry,
      RequestError: DeepSeekRequestError,
      deriveUserId: deepseekOpaqueUserId,
    }
    : null
  const deepseekChat: ChatHandler | null = deepseekProvider
    ? createChatHandler(deepseekProvider, fetchImpl, store)
    : null
  const deepseekNativeWebSearch: NativeAnthropicWebSearchHandler | null = deepseekProvider
    ? createNativeAnthropicWebSearchHandler(deepseekProvider, fetchImpl, store)
    : null
  // 视觉桥接:唯一视觉上游是 MiMo v2.5(config.mimoBase/config.mimoKey),绝不用 ARK。只在
  // mimoKey 存在时可用;缺 key 时带图且非原生多模态的请求在路由处显式 503,不把图丢给文本模型猜。
  const visionBridge: VisionBridge | null = config.mimoKey
    ? createVisionBridge({
      mimoBase: config.mimoBase,
      mimoKey: config.mimoKey,
      fetchImpl,
      caps: {
        maxImages: config.visionMaxImages,
        maxImageBytes: config.visionMaxImageBytes,
        maxTotalBytes: config.visionMaxTotalBytes,
        visionTimeoutMs: config.visionTimeoutMs,
        maxConcurrent: config.visionConc,
        queueMax: config.visionQueueMax,
        perRequestConc: config.visionPerRequestConc,
        cacheMax: config.visionCacheMax,
        cacheTtlMs: config.visionCacheTtlMs,
      },
    })
    : null
  const imgBucket = new TokenBucket(config.imgIpm)
  const transcribeBucket = new TokenBucket(config.transcribeRpm)
  const transcribeSem = new AsyncSemaphore(config.transcribeConc)
  const transcribe = deps.transcribeImpl === undefined ? createGatewayTranscriber(env) : deps.transcribeImpl
  async function fetchHandler(request: Request, server?: RequestTimeoutController): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        if (!authenticatedUser(config, request)) return jsonResponse({ ok: true })
        return jsonResponse({
          ok: true,
          limits: {
            qwen_rpm: config.qwenRpm,
            qwen_conc: config.qwenConc,
            qwen_user_conc: config.qwenUserConc,
            mimo_rpm: config.mimoRpm,
            mimo_conc: config.mimoConc,
            mimo_user_conc: config.mimoUserConc,
            deepseek_rpm: config.deepseekRpm,
            deepseek_conc: config.deepseekConc,
            deepseek_user_conc: config.deepseekUserConc,
            img_ipm: config.imgIpm,
            transcribe_rpm: config.transcribeRpm,
            transcribe_conc: config.transcribeConc,
          },
          // Kept for old clients that already read this field. Product-level daily quotas are disabled.
          quota: {},
          capacity: {
            qwen: qwenCapacity.snapshot(),
            mimo: mimoCapacity.snapshot(),
            deepseek: deepseekCapacity.snapshot(),
          },
          features: {
            transcription: transcribe !== null,
            chat_qwen: qwenChat !== null,
            chat_mimo: mimoChat !== null,
            chat_deepseek: deepseekChat !== null,
          },
        })
      }

      if (request.method === 'GET' && url.pathname === '/admin/usage') {
        if (url.searchParams.get('token') !== config.adminToken) throw new HttpError(403, '无权')
        const n = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get('n') ?? '50', 10) || 50))
        return jsonResponse({
          today: todayCst(),
          today_by_model: await store.todayByModel(),
          recent: await store.recent(n),
        })
      }

      // 鉴权后的模型目录:只列出当前真正可路由的上游(缺 key 的上游不出现在目录里),
      // 每项标 owned_by=qwen|mimo 供客户端做"显式 Qwen/MiMo 目录 + 会话级切换"。切换本身复用
      // Agent 的 set_runtime_config → CLI --model,模型名随请求体 model 到网关按上面的路由分流。
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        auth(config, request)
        const data: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = []
        if (qwenChat) for (const id of config.qwenAllowedModels) data.push({ id, object: 'model', created: 0, owned_by: 'qwen' })
        if (mimoChat) for (const id of config.mimoAllowedModels) data.push({ id, object: 'model', created: 0, owned_by: 'mimo' })
        if (deepseekChat) for (const id of config.deepseekAllowedModels) data.push({ id, object: 'model', created: 0, owned_by: 'deepseek' })
        return jsonResponse({ object: 'list', data })
      }

      // DeepSeek officially supports Claude Code's native WebSearchTool over
      // its Anthropic Messages endpoint. This route is intentionally narrow:
      // it accepts only that server-side tool protocol, while ordinary agent
      // chat remains on /v1/chat/completions so the existing Qwen/MiMo routing
      // and image bridge are not bypassed.
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        const user = auth(config, request)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) {
          throw new HttpError(415, '联网检索请求需要 JSON')
        }
        const declaredLength = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declaredLength) && declaredLength > config.visionMaxTotalBytes) {
          throw new HttpError(413, '请求体过大')
        }
        const rawBody = await readRequestBodyBounded(request, config.visionMaxTotalBytes)
        if (!deepseekNativeWebSearch) {
          throw new HttpError(503, 'DeepSeek 模型服务未配置（缺 GW_DEEPSEEK_KEY）')
        }
        return await deepseekNativeWebSearch(request, rawBody, user, readClientId(request))
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const user = auth(config, request)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '模型请求需要 JSON')
        // 请求体大小闸,在任何路由/解析/许可之前:防超大/伪造 Content-Length/chunked body(典型是
        // 图片 base64)打爆内存/上游。先用声明的 Content-Length 做一次读 body 之前的快速拒绝
        // (常规场景零额外开销);真正兜底的上限由 readRequestBodyBounded 按流式真实字节数强制,
        // 不信任可被伪造的头或 chunked 编码。复用视觉桥接的 maxTotalBytes 上限,对所有聊天请求
        // 生效(不止带图请求)。
        const declaredLength = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declaredLength) && declaredLength > config.visionMaxTotalBytes) {
          throw new HttpError(413, '请求体过大')
        }
        const rawBody = await readRequestBodyBounded(request, config.visionMaxTotalBytes)
        // 路由规则(按 model 显式分流,绝不自动跨供应商回退):
        //   命中 DeepSeek 白名单 → 只能走 DeepSeek;命中 MiMo 白名单 → 只能走 MiMo;
        //   两者未配置对应 key 时各自显式 503,绝不改投千问。未命中任何白名单(未知或千问模型)
        //   → 默认千问,千问把白名单外 model 改写为 GW_QWEN_MODEL(供应商内归一,非跨供应商回退)。
        //   DeepSeek/MiMo 白名单都独立于各自 key 加载(始终含默认模型),缺 key 时仍能识别目标并 fail closed。
        const client = readClientId(request)
        // 一次权威路由决策:model 只 trim 一次,native 多模态判定与三家 allowlist 路由共用同一个
        // trim 后的字符串、同一套精确匹配规则,不再各自判断——修复旧 bug(isNativeMultimodal 曾用
        // /i + trim,路由 allowlist 精确匹配、不 trim,"MIMO-V2.5"这类大小写不同的输入会被误判为
        // 原生多模态从而跳过桥接,但 allowlist 又不认,最终落到 Qwen 时带着原始 image_url 发给
        // 纯文本模型)。
        const requestedModel = parseChatModel(rawBody).trim()
        const routesToDeepseek = config.deepseekAllowedModels.has(requestedModel)
        const routesToMimo = !routesToDeepseek && config.mimoAllowedModels.has(requestedModel)
        // mimo-v2.5-pro 等其它 MiMo 白名单模型不算原生多模态,仍需先桥接去图。
        const isNativeMultimodal = routesToMimo && requestedModel === 'mimo-v2.5'
        // 视觉桥接:请求带图且路由到的不是原生多模态(精确的 mimo-v2.5)时,先用 MiMo v2.5 把每张图
        // 读成结构化文本、替换掉 image_url,再把去图后的请求体交给下面按 routesToDeepseek/routesToMimo
        // 路由到的模型。桥接跑在路由/许可之前,调 MiMo 视觉时不占目标文本模型的聊天许可名额。MiMo
        // 失败/超时/429 一律失败关闭(不丢图给文本模型猜、不改投 Qwen);缺 GW_MIMO_KEY 时同样失败关闭为 503。
        const hasImages = containsImageContent(rawBody)
        // Computer Use must read pixel coordinates from the original screenshot. The generic
        // OCR/layout bridge intentionally discards pixels, so screenshot-bearing CU turns are
        // capability-routed to the native multimodal MiMo model. This is an explicit tool
        // capability route, not a failure fallback; ordinary image questions keep the normal
        // MiMo-description -> requested text-model path below.
        if (hasImages && containsComputerUseContext(rawBody)) {
          if (!mimoChat) throw new HttpError(503, 'Computer Use 视觉服务未配置（缺 GW_MIMO_KEY）')
          return await mimoChat(request, rawBody, user, client)
        }

        let effectiveBody = rawBody
        if (!isNativeMultimodal && hasImages) {
          if (!visionBridge) throw new HttpError(503, '图片理解服务未配置（缺 GW_MIMO_KEY）')
          const bridgeStarted = performance.now()
          try {
            const { body, metrics } = await visionBridge.transform(rawBody, { signal: request.signal })
            effectiveBody = body
            await logUsage(store, {
              user,
              model: 'vision',
              ok: true,
              status: 200,
              ms: elapsedMs(bridgeStarted),
              note: `cache_hit=${metrics.cacheHits > 0 ? 1 : 0};img=${metrics.imageCount}`,
            })
          } catch (error) {
            const known = error instanceof VisionBridgeError
            const status = known ? error.status : 502
            const detail = known ? error.publicMessage : '图片理解服务暂时不可用，请稍后重试'
            await logUsage(store, { user, model: 'vision', ok: false, status, ms: elapsedMs(bridgeStarted), note: 'vision_bridge_failed' })
            throw new HttpError(status, detail)
          }
        }
        if (routesToDeepseek) {
          if (!deepseekChat) throw new HttpError(503, 'DeepSeek 模型服务未配置（缺 GW_DEEPSEEK_KEY）')
          return await deepseekChat(request, effectiveBody, user, client)
        }
        if (routesToMimo) {
          if (!mimoChat) throw new HttpError(503, 'MiMo 模型服务未配置（缺 GW_MIMO_KEY）')
          return await mimoChat(request, effectiveBody, user, client)
        }
        if (!qwenChat) throw new HttpError(503, '千问模型服务未配置（缺 GW_QWEN_KEY）')
        return await qwenChat(request, effectiveBody, user, client)
      }

      if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        server?.timeout(request, 0)
        const user = auth(config, request)
        if (!transcribe) throw new HttpError(503, '语音识别服务暂不可用')
        const contentType = request.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, '需要上传音频文件')
        const declaredSize = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declaredSize) && declaredSize > config.transcribeMaxBytes + 1024 * 1024) {
          throw new HttpError(413, '音频文件过大')
        }
        await transcribeBucket.acquire(config.queueMaxWait)
        const started = performance.now()
        return await transcribeSem.run(async () => {
          const queueMs = elapsedMs(started)
          const form = await request.formData().catch(() => null)
          const file = form?.get('file')
          if (!(file instanceof File) || file.size === 0) throw new HttpError(400, '没有收到音频文件')
          if (file.size > config.transcribeMaxBytes) throw new HttpError(413, '音频文件过大')
          if (!supportedAudio(file)) throw new HttpError(415, '不支持这种音频格式')
          const languageRaw = String(form?.get('language') ?? 'zh').trim().toLowerCase()
          const language = /^[a-z]{2,8}$/.test(languageRaw) ? languageRaw : 'zh'
          const formatRaw = String(form?.get('response_format') ?? 'json')
          const responseFormat = formatRaw === 'verbose_json' ? 'verbose_json' : 'json'
          const runStarted = performance.now()
          try {
            const result = await transcribe(file, { language, responseFormat, signal: request.signal })
            const audioSeconds = Number(result.duration)
            const note = [
              `queue_ms=${queueMs}`,
              `run_ms=${elapsedMs(runStarted)}`,
              `bytes=${file.size}`,
              ...(Number.isFinite(audioSeconds) && audioSeconds >= 0 ? [`audio_seconds=${Math.round(audioSeconds * 1000) / 1000}`] : []),
            ].join(';')
            await logUsage(store, { user, model: 'transcribe', ok: true, status: 200, ms: elapsedMs(started), note })
            return jsonResponse(result)
          } catch (error) {
            const status = error instanceof GatewayTranscriptionError ? error.status : 502
            const detail = error instanceof GatewayTranscriptionError ? error.publicMessage : '语音识别失败，请稍后重试'
            const note = `queue_ms=${queueMs};run_ms=${elapsedMs(runStarted)};bytes=${file.size}`
            await logUsage(store, { user, model: 'transcribe', ok: false, status, ms: elapsedMs(started), note })
            throw new HttpError(status, detail)
          }
        })
      }

      // GPT 生图异步任务:提交(短请求,转发到美国 relay 任务服务;慢调用在美国本地跑,绕开跨境长连接 60s 被掐)。
      if (request.method === 'POST' && url.pathname === '/v1/images/tasks') {
        const user = auth(config, request)
        if (!config.relayTasksBase) throw new HttpError(503, 'GPT 生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '生图任务需要 JSON')
        const declaredLength = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declaredLength) && declaredLength > config.imgTaskMaxBodyBytes) {
          throw new HttpError(413, '生图任务请求体过大')
        }
        const rawBody = await readRequestBodyBounded(request, config.imgTaskMaxBodyBytes)
        await imgBucket.acquire(config.queueMaxWait) // 提交计入生图 IPM 限速;短请求不占 imgSem 在途并发
        const started = performance.now()
        try {
          // 把受信任务归属身份传给 relay(relay 据此绑定 owner、越权轮询 403);客户端若带
          // Idempotency-Key 则透传,relay 按 (owner,key) 去重,重复提交只跑一次真实上游。
          const submitHeaders: Record<string, string> = {
            Authorization: `Bearer ${config.relayToken}`,
            'Content-Type': 'application/json',
            'X-Relay-Owner': relayOwner(user, readClientId(request)),
          }
          const idempotencyKey = request.headers.get('idempotency-key')
          if (idempotencyKey) submitHeaders['Idempotency-Key'] = idempotencyKey
          const upstream = await fetchImpl(`${config.relayTasksBase}/images/tasks`, {
            method: 'POST',
            body: rawBody,
            headers: submitHeaders,
          })
          await logUsage(store, { user, model: 'img', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
          return await proxyJsonOrRaw(upstream)
        } catch (err) {
          await logUsage(store, { user, model: 'img', ok: false, status: 599, ms: elapsedMs(started), note: String(err).slice(0, 120) })
          throw new HttpError(502, `生图任务提交出错:${String(err).slice(0, 120)}`)
        }
      }

      if (
        request.method === 'POST'
        && url.pathname.startsWith('/v1/images/tasks/')
        && url.pathname.endsWith('/cancel')
      ) {
        const user = auth(config, request)
        if (!config.relayTasksBase) throw new HttpError(503, 'GPT 生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
        const taskId = url.pathname.slice('/v1/images/tasks/'.length, -'/cancel'.length)
        if (!taskId || taskId.includes('/')) throw new HttpError(400, '无效 task id')
        const upstream = await fetchImpl(
          `${config.relayTasksBase}/images/tasks/${encodeURIComponent(taskId)}/cancel`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.relayToken}`,
              'X-Relay-Owner': relayOwner(user, readClientId(request)),
            },
          },
        )
        return await proxyJsonOrRaw(upstream)
      }

      // GPT 生图异步任务:轮询状态(短请求,不计配额)。带上同一 owner,relay 强制"谁提交谁轮询",
      // 拿别人的 task id 轮询会被 relay 返 403。
      if (request.method === 'GET' && url.pathname.startsWith('/v1/images/tasks/')) {
        const user = auth(config, request)
        if (!config.relayTasksBase) throw new HttpError(503, 'GPT 生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
        const taskId = url.pathname.slice('/v1/images/tasks/'.length)
        if (!taskId || taskId.includes('/')) throw new HttpError(400, '无效 task id')
        const upstream = await fetchImpl(`${config.relayTasksBase}/images/tasks/${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${config.relayToken}`,
            'X-Relay-Owner': relayOwner(user, readClientId(request)),
          },
        })
        return await proxyJsonOrRaw(upstream)
      }

      return jsonError(404, 'not found')
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.status, err.detail)
      if (err instanceof CapacityQueueError || err instanceof QwenRequestError || err instanceof MimoRequestError || err instanceof DeepSeekRequestError) {
        return jsonError(err.status, err.publicMessage)
      }
      console.error('[qfgw] request failed', err)
      return jsonError(500, 'internal server error')
    }
  }

  return fetchHandler
}

function elapsedMs(started: number): number {
  return Math.trunc(performance.now() - started)
}

function modelPublicError(status: number, upstreamDetail = ''): string {
  if (status === 402 || /insufficient[_\s-]?quota|quota[_\s-]?(?:exceeded|exhausted)|credit(?:s)?[_\s-]?(?:depleted|exhausted)|balance[_\s-]?(?:insufficient|depleted)|额度不足|额度已用尽|余额不足|账户欠费/i.test(upstreamDetail)) {
    return '模型服务额度不足，请稍后再试或联系管理员'
  }
  if (status === 429) return '当前使用人数较多，请稍后重试'
  if (status === 408 || status >= 500) return '模型服务暂时不可用，请稍后重试'
  if (status === 401 || status === 403) return '模型服务配置异常，请联系管理员'
  return '模型请求未被服务接受，请检查输入后重试'
}

function parseArgs(argv: string[]): { host: string; port: number } {
  let host = '127.0.0.1'
  let port = 8799
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') host = argv[++i] ?? host
    else if (argv[i] === '--port') {
      const parsed = Number(argv[++i])
      if (Number.isFinite(parsed) && parsed > 0) port = parsed
    }
  }
  return { host, port }
}

export function startGatewayServer(opts: { host?: string; port?: number } = {}) {
  return Bun.serve({
    hostname: opts.host ?? '127.0.0.1',
    port: opts.port ?? 8799,
    fetch: createGatewayFetch(),
  })
}

if (import.meta.main) {
  const { host, port } = parseArgs(process.argv.slice(2))
  const server = startGatewayServer({ host, port })
  console.log(`[qfgw] listening on http://${host}:${server.port}`)
}
