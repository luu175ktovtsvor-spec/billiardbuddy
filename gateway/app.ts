import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  createGatewayTranscriber,
  GatewayTranscriptionError,
  type GatewayTranscriber,
} from './transcription'
import { CapacityQueueError, FairCapacityScheduler, MimoReservationScheduler, type CapacityPermit, type CapacitySnapshot } from './modelCapacity'
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

type CapacityPool = {
  acquire(user: string, opts: { maxWaitMs: number; signal?: AbortSignal; tokenId?: string }): Promise<CapacityPermit>
  snapshot(): CapacitySnapshot
}

type TokenBucketWaiter = {
  deadlineAt: number
  resolve: () => void
  reject: (error: HttpError) => void
  signal?: AbortSignal
  onAbort?: () => void
  timeout?: ReturnType<typeof setTimeout>
}

// 一个可路由的聊天上游(千问 / MiMo / DeepSeek)。每个上游各自持有独立的凭据、白名单、限速、
// 并发、重试与用量标签;共享的代理逻辑由 createChatHandler 消费本结构,互不串台。
type ChatProvider = {
  label: 'qwen' | 'mimo' | 'deepseek'
  base: string
  key: string
  defaultModel: string
  allowedModels: ReadonlySet<string>
  bucket: TokenBucket
  capacity: CapacityPool
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
  relaySubmitTimeoutMs: number
  adminToken: string
  db: string
  appTokens: Map<string, string>
  qwenRpm: number
  qwenConc: number
  qwenUserConc: number
  qwenTokenConc: number
  qwenQueueMax: number
  qwenQueueMaxWait: number
  qwenRetryMax: number
  qwenRetryBaseMs: number
  qwenRetryMaxMs: number
  qwenAllowedModels: ReadonlySet<string>
  mimoKey: string
  mimoBase: string
  mimoModel: string
  mimoRpm: number
  /** Native MiMo lane; the remaining total capacity is reserved for the visual bridge. */
  mimoNativeConc: number
  mimoConc: number
  mimoUserConc: number
  mimoInflightPerUser: number
  mimoTokenConc: number
  mimoQueueMax: number
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
  deepseekQueueMax: number
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
  /** One process-wide ingress reservation for chat, native Messages and image task bodies. */
  ingressInflightBodyBytes: number
  /** Slowloris guard for public JSON body reads after Bun's request idle timeout is disabled. */
  ingressBodyReadTimeoutMs: number
  visionTimeoutMs: number
  visionConc: number
  visionQueueMax: number
  visionQueueMaxWaitMs: number
  visionPerClientConc: number
  visionMaxInflightPerClient: number
  visionPerRequestConc: number
  visionCacheMax: number
  visionCacheTtlMs: number
  imgIpm: number
  imgQueueMax: number
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
  private waiters: TokenBucketWaiter[] = []
  private wakeTimer?: ReturnType<typeof setTimeout>

  constructor(rpm: number, private readonly queueMax = Infinity) {
    this.capacity = Math.max(1, rpm)
    this.tokens = this.capacity
    this.rate = this.capacity / 60_000
    if (queueMax !== Infinity && (!Number.isInteger(queueMax) || queueMax < 0)) {
      throw new Error('TokenBucket queueMax must be a non-negative integer or Infinity')
    }
  }

  async acquire(maxWaitSeconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new HttpError(499, '请求已取消')
    this.refill()
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    const maxWaitMs = Math.max(0, maxWaitSeconds) * 1000
    if (maxWaitMs <= 0 || this.waiters.length >= this.queueMax) {
      throw new HttpError(429, '现在用的人多,稍等一下再发(已在排队保护)')
    }
    return await new Promise<void>((resolve, reject) => {
      const waiter: TokenBucketWaiter = {
        deadlineAt: performance.now() + maxWaitMs,
        resolve,
        reject,
        signal,
      }
      const rejectAndRemove = (error: HttpError) => {
        if (!this.remove(waiter)) return
        this.cleanup(waiter)
        reject(error)
        this.drain()
      }
      waiter.timeout = setTimeout(
        () => rejectAndRemove(new HttpError(429, '现在用的人多,稍等一下再发(已在排队保护)')),
        maxWaitMs,
      )
      waiter.onAbort = () => rejectAndRemove(new HttpError(499, '请求已取消'))
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
  }

  private refill(now = performance.now()): void {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.ts) * this.rate)
    this.ts = now
  }

  private drain(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = undefined
    }
    this.refill()
    const now = performance.now()
    while (this.waiters.length > 0 && this.waiters[0]!.deadlineAt <= now) {
      const expired = this.waiters.shift()!
      this.cleanup(expired)
      expired.reject(new HttpError(429, '现在用的人多,稍等一下再发(已在排队保护)'))
    }
    while (this.waiters.length > 0 && this.tokens >= 1) {
      const waiter = this.waiters.shift()!
      this.cleanup(waiter)
      this.tokens -= 1
      waiter.resolve()
    }
    if (this.waiters.length > 0) {
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.rate))
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = undefined
        this.drain()
      }, waitMs)
    }
  }

  private remove(waiter: TokenBucketWaiter): boolean {
    const index = this.waiters.indexOf(waiter)
    if (index < 0) return false
    this.waiters.splice(index, 1)
    return true
  }

  private cleanup(waiter: TokenBucketWaiter): void {
    if (waiter.timeout) clearTimeout(waiter.timeout)
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
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

/**
 * Tracks a process-wide reservation for image-task request bodies while qfgw reads,
 * merges, decodes and forwards them. Relay's task queue protects expensive image work,
 * but it cannot protect this gateway from a simultaneous burst of base64 bodies.
 */
class InflightByteBudget {
  private reservedBytes = 0

  constructor(
    private readonly maxBytes: number,
    private readonly overflowMessage = '请求较多，请稍后重试',
  ) {}

  reserve(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid byte reservation')
    if (bytes > this.maxBytes - this.reservedBytes) {
      throw new HttpError(429, this.overflowMessage)
    }
    this.reservedBytes += bytes
  }

  release(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    this.reservedBytes = Math.max(0, this.reservedBytes - bytes)
  }

  snapshot(): { reservedBytes: number; maxBytes: number } {
    return { reservedBytes: this.reservedBytes, maxBytes: this.maxBytes }
  }
}

// `readRequestBodyBounded` retains chunks, one merged Uint8Array and a decoded string.
// Reserving six times observed wire bytes covers chunk/merged/decoded copies plus JSON
// parsing and transient string representation for both
// ordinary chat and image-task forwarding without shrinking either route's per-request cap.
const BUFFERED_BODY_RESERVATION_MULTIPLIER = 6

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
async function readRequestBodyBounded(
  request: Request,
  maxBytes: number,
  onChunk?: (bytes: number) => void,
  readTimeoutMs?: number,
): Promise<string> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let aborted = request.signal?.aborted ?? false
  let readTimedOut = false
  const onAbort = () => {
    aborted = true
    reader.cancel().catch(() => {})
  }
  const timeout = readTimeoutMs && Number.isFinite(readTimeoutMs) && readTimeoutMs > 0
    ? setTimeout(() => {
      readTimedOut = true
      reader.cancel().catch(() => {})
    }, readTimeoutMs)
    : undefined
  if (!aborted) request.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (aborted) throw new HttpError(499, '请求已取消')
      if (readTimedOut) throw new HttpError(408, '请求体读取超时')
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        if (aborted) throw new HttpError(499, '请求已取消')
        if (readTimedOut) throw new HttpError(408, '请求体读取超时')
        throw new HttpError(400, '请求体读取失败')
      }
      // cancel() 触发的 abort 可能让挂起的 read() 以 {done:true} 而非抛错的方式结算，
      // 这里再判一次，不让已取消的请求被当成"正常读完"放行。
      if (aborted) throw new HttpError(499, '请求已取消')
      if (readTimedOut) throw new HttpError(408, '请求体读取超时')
      if (result.done) break
      const value = result.value
      if (value && value.byteLength > 0) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new HttpError(413, '请求体过大')
        }
        // The image-task route uses this hook to reserve global body memory before
        // retaining the chunk. If that budget is full, cancel immediately rather than
        // continuing to buffer a request that cannot be forwarded safely.
        try {
          onChunk?.(value.byteLength)
        } catch (error) {
          await reader.cancel().catch(() => {})
          throw error
        }
        chunks.push(value)
      }
    }
  } finally {
    request.signal?.removeEventListener('abort', onAbort)
    if (timeout) clearTimeout(timeout)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(merged)
}

/**
 * Hold a process-wide body-memory reservation from the first retained chunk until the
 * caller has finished parsing/forwarding the request.  A truthful Content-Length is
 * reserved before reading; missing or dishonest headers are topped up before each chunk
 * is retained.  This is deliberately separate from the per-request maxBytes check: the
 * latter limits one request, while this cap prevents 500 concurrent valid requests from
 * multiplying into an OOM.
 */
async function withBufferedBodyReservation<T>(
  request: Request,
  maxBytes: number,
  budget: InflightByteBudget,
  readTimeoutMs: number,
  fn: (rawBody: string) => Promise<T>,
): Promise<T> {
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, '请求体过大')
  }
  let reservedBytes = 0
  let observedBytes = 0
  const reserveObservedBytes = (wireBytes: number) => {
    const target = wireBytes * BUFFERED_BODY_RESERVATION_MULTIPLIER
    const additional = target - reservedBytes
    if (additional <= 0) return
    budget.reserve(additional)
    reservedBytes = target
  }
  try {
    if (Number.isFinite(declaredLength) && declaredLength > 0) {
      reserveObservedBytes(Math.min(declaredLength, maxBytes))
    }
    const rawBody = await readRequestBodyBounded(request, maxBytes, bytes => {
      observedBytes += bytes
      reserveObservedBytes(observedBytes)
    }, readTimeoutMs)
    return await fn(rawBody)
  } finally {
    budget.release(reservedBytes)
  }
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

/** Relay submissions carry an internal relay credential and potentially source images. */
function httpsUrlOrEmpty(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' ? trimmed.replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

function loadConfig(env: Env): GatewayConfig {
  const mimoConc = Math.max(1, intEnv(env, 'GW_MIMO_CONC', 64))
  // Old deployments may have only GW_MIMO_CONC. Derive a valid partition for those
  // small canary profiles instead of injecting 12 visual slots into a two-slot pool.
  // New or explicitly tuned profiles must name values whose sum exactly matches the
  // account ceiling: unused capacity makes health misleading and is not a reservation.
  const implicitVisionConc = Math.min(12, Math.max(1, mimoConc - 1))
  const visionConc = Math.max(1, intEnv(env, 'GW_VISION_CONC', implicitVisionConc))
  const implicitNativeConc = mimoConc - visionConc
  if (implicitNativeConc < 1) {
    throw new Error('GW_MIMO_CONC must leave at least one native and one visual MiMo slot')
  }
  const mimoNativeConc = Math.max(1, intEnv(env, 'GW_MIMO_NATIVE_CONC', implicitNativeConc))
  if (mimoNativeConc + visionConc !== mimoConc) {
    throw new Error('GW_MIMO_NATIVE_CONC + GW_VISION_CONC must equal GW_MIMO_CONC')
  }
  return {
    // 真实上游密钥只在服务端读取,缺失时对应上游 handler 置空(路由到它会 503),绝不回退到另一家。
    qwenKey: env.GW_QWEN_KEY ?? '',
    qwenBase: (env.GW_QWEN_BASE ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    qwenModel: env.GW_QWEN_MODEL ?? 'qwen3-coder-plus',
    relayToken: required(env, 'GW_RELAY_TOKEN'),
    // 美国 relay 上的 GPT 生图异步任务服务(relay/app.ts)地址;缺则异步任务端点返回 503,客户端退同步路径。
    relayTasksBase: httpsUrlOrEmpty(env.GW_RELAY_TASKS_BASE),
    // Relay 只负责快速接受持久化任务；跨境提交异常不能无限占用入口 body reservation。
    relaySubmitTimeoutMs: Math.max(1, intEnv(env, 'GW_RELAY_SUBMIT_TIMEOUT_MS', 15_000)),
    adminToken: env.GW_ADMIN_TOKEN ?? 'change-me',
    db: env.GW_DB ?? '/opt/qfgw/usage.db',
    appTokens: parseAppTokens(env.GW_APP_TOKENS),
    // RPM 默认值抬到不再卡正常文字流量(本地令牌桶曾是"80 并发 p95 17s"的元凶);GW_*_CONC 仍是
    // 保护上游的高水位紧急总闸,真正收紧限速请调小对应 env,不靠这个默认值节流。
    qwenRpm: intEnv(env, 'GW_QWEN_RPM', 100_000),
    qwenConc: Math.max(1, intEnv(env, 'GW_QWEN_CONC', 16)),
    // 产品按“每人最多开 5 个窗口”建模：单装机默认最多同时占 5 个槽，既不把正常多窗口
    // 用户卡成 1 路，也不让先到的一个安装吞掉整池。仍可由 gw.env 对特殊客户显式调整。
    qwenUserConc: Math.max(1, intEnv(env, 'GW_QWEN_USER_CONC', Math.min(5, intEnv(env, 'GW_QWEN_CONC', 16)))),
    // 单 token 名下所有装机合计在途上限:默认=全局并发(共享私测 token 需用满整池)。发独立用户
    // token 后设为低于全局以在 token 间预留 headroom;是防"单 token 伪造多装机独占池"的二级闸。
    qwenTokenConc: Math.max(1, intEnv(env, 'GW_QWEN_TOKEN_CONC', intEnv(env, 'GW_QWEN_CONC', 16))),
    // 有界等待队列与 active 槽分开计数；0 表示池满即 429，不允许无界排队。
    qwenQueueMax: Math.max(0, intEnv(env, 'GW_QWEN_QUEUE_MAX', 128)),
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
    // MiMo has one account-wide ceiling, split into physical native + visual lanes.
    // The 12 visual slots are hard-reserved so native/Computer Use traffic cannot make
    // a DeepSeek→MiMo image bridge wait behind all 64 ordinary MiMo calls.
    // Admit only one active call and one total active-or-queued call per installation;
    // this keeps a sequential five-window burst from letting early desktops fill the
    // 64-entry queue before later installations are admitted. The queue remains only a
    // brief burst absorber, not a hidden multi-minute backlog for 100 users' windows.
    mimoConc,
    mimoNativeConc,
    mimoUserConc: Math.max(1, intEnv(env, 'GW_MIMO_USER_CONC', 1)),
    mimoInflightPerUser: Math.max(1, intEnv(env, 'GW_MIMO_INFLIGHT_PER_USER', 1)),
    mimoTokenConc: Math.max(1, intEnv(env, 'GW_MIMO_TOKEN_CONC', mimoConc)),
    mimoQueueMax: Math.max(0, intEnv(env, 'GW_MIMO_QUEUE_MAX', 64)),
    mimoQueueMaxWait: Math.max(0, floatEnv(env, 'GW_MIMO_QUEUE_MAX_WAIT', 5)),
    // 同 qwen:最多额外一次,硬夹在 [0,1],避免与 CC CLI 重试相乘。
    mimoRetryMax: Math.max(0, Math.min(1, intEnv(env, 'GW_MIMO_MAX_RETRIES', 1))),
    mimoRetryBaseMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_BASE_MS', 500)),
    mimoRetryMaxMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_MAX_MS', 8000)),
    mimoAllowedModels: loadMimoAllowedModels(env),
    // DeepSeek V4 Flash:真 key 只在服务器。受控假上游验证覆盖 100 人 × 10 窗口的 1,000 路
    // 调度，但尚未证明 1,000 路真实 SSE 的尾延迟。因此先固定为每安装最多 10 路、共享 app token
    // 最多 1,000 路；200 个队列槽仅吸收短抖动且最多等 15 秒。这不替代长 SSE、长上下文、
    // CPU 余量与真实混合负载的渐进式验收。DeepSeek 账号的 2500 并发额度不等于单台 Bun 应直接开到
    // 2500；缺 key 时路由到它会 503，绝不改投千问/MiMo。
    deepseekKey: env.GW_DEEPSEEK_KEY ?? '',
    deepseekBase: (env.GW_DEEPSEEK_BASE ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    deepseekModel: env.GW_DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    deepseekRpm: intEnv(env, 'GW_DEEPSEEK_RPM', 100_000),
    deepseekConc: Math.max(1, intEnv(env, 'GW_DEEPSEEK_CONC', 1_000)),
    deepseekUserConc: Math.max(1, intEnv(env, 'GW_DEEPSEEK_USER_CONC', Math.min(10, intEnv(env, 'GW_DEEPSEEK_CONC', 1_000)))),
    deepseekTokenConc: Math.max(1, intEnv(env, 'GW_DEEPSEEK_TOKEN_CONC', intEnv(env, 'GW_DEEPSEEK_CONC', 1_000))),
    deepseekQueueMax: Math.max(0, intEnv(env, 'GW_DEEPSEEK_QUEUE_MAX', 200)),
    deepseekQueueMaxWait: Math.max(0, floatEnv(env, 'GW_DEEPSEEK_QUEUE_MAX_WAIT', 15)),
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
    visionConc,
    // A real 12-call vision ramp showed noticeable tail latency. Keep only 12-active +
    // 24-waiting as a short safety envelope, not a claim of 500-image throughput; shed
    // the remainder rather than turning it into stale work or unbounded request state.
    visionQueueMax: Math.max(1, intEnv(env, 'GW_VISION_QUEUE_MAX', 24)),
    // 视觉属于聊天关键路径，不允许默认 120 秒那样的长等待。生产可在已验证 MiMo
    // 时延后调整，但必须保持有限窗口，避免 500 个带图窗口堆成陈旧请求。
    visionQueueMaxWaitMs: Math.max(1, intEnv(env, 'GW_VISION_QUEUE_MAX_WAIT_MS', 3_000)),
    // Unlike plain text, image understanding is a conservative, unverified MiMo path:
    // one installation gets one active visual slot by default so 12 distinct desktops can
    // make progress. The total active-or-queued cap below is also one, so its follow-up
    // windows cannot fill all 24 brief wait slots before later installations arrive.
    visionPerClientConc: Math.max(1, intEnv(env, 'GW_VISION_PER_CLIENT_CONC', 1)),
    visionMaxInflightPerClient: Math.max(1, intEnv(env, 'GW_VISION_MAX_INFLIGHT_PER_CLIENT', 1)),
    // 一次多图聊天可并发处理的图片数，必须同时服从视觉和共享 MiMo 池的单安装额度。
    // 否则默认 "每安装 1 槽" 下，一个两图请求的第二张会被自己的第一张挤成 429。
    // 运营侧若同时把这四项公平额度提高，才可把 GW_VISION_PER_REQUEST_CONC 提高到 2+。
    visionPerRequestConc: Math.max(1, Math.min(
      intEnv(env, 'GW_VISION_PER_REQUEST_CONC', 2),
      intEnv(env, 'GW_VISION_PER_CLIENT_CONC', 1),
      intEnv(env, 'GW_VISION_MAX_INFLIGHT_PER_CLIENT', 1),
      intEnv(env, 'GW_MIMO_USER_CONC', 1),
      intEnv(env, 'GW_MIMO_INFLIGHT_PER_USER', 1),
    )),
    visionCacheMax: Math.max(1, intEnv(env, 'GW_VISION_CACHE_MAX', 512)),
    visionCacheTtlMs: Math.max(1, intEnv(env, 'GW_VISION_CACHE_TTL_MS', 600_000)),
    // A valid 24/32 MB body can temporarily exist as chunks + merged bytes + decoded
    // text + parsed/rewritten JSON.  One conservative 256 MB ingress reservation spans
    // ordinary chat, vision bridge, native Messages and image submissions so a burst
    // fails quickly instead of multiplying into an OOM.  The two older per-route names
    // remain read-only compatibility fallbacks; a new deployment should set only GW_INGRESS_INFLIGHT_BODY_BYTES.
    ingressInflightBodyBytes: Math.max(1, intEnv(
      env,
      'GW_INGRESS_INFLIGHT_BODY_BYTES',
      intEnv(env, 'GW_CHAT_INFLIGHT_BODY_BYTES', intEnv(env, 'GW_IMG_INFLIGHT_BODY_BYTES', 256 * 1024 * 1024)),
    )),
    ingressBodyReadTimeoutMs: Math.max(1, intEnv(env, 'GW_INGRESS_BODY_READ_TIMEOUT_MS', 30_000)),
    // Image generation itself is queued on relay; qfgw only accepts short submissions.
    // Permit a 100×10 burst to reach relay's idempotent queue instead of throttling it to
    // 18/min here. The byte reservation below is the memory guard for those submissions.
    imgIpm: intEnv(env, 'GW_IMG_IPM', 1_200),
    // RPM 桶耗尽后的短提交等待也必须有硬上限；默认 200 只影响超过首个 1,200/min burst 的流量。
    imgQueueMax: Math.max(0, intEnv(env, 'GW_IMG_QUEUE_MAX', 200)),
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
    // tokenId=user 让"同一 token 名下所有装机"合计受 maxConcurrentPerToken 约束:即使伪造任意多
    // client id,一个 token 也拿不到超过其 token 级上限的在途,防单 token 独占整池。
    const queuedStarted = performance.now()
    let permit: CapacityPermit | undefined
    try {
      permit = await provider.capacity.acquire(schedId, {
        maxWaitMs: provider.queueMaxWait * 1000,
        signal: request.signal,
        tokenId: user,
      })
    } catch (error) {
      permit?.release()
      // Queue-full / timeout / client-cancel used to return before usage logging, making
      // the only evidence of overload disappear. Record the bounded wait, without body
      // content or provider detail, so /admin/usage can be used to tune the pool safely.
      const known = error instanceof CapacityQueueError
      await logUsage(store, {
        user,
        model: provider.label,
        ok: false,
        status: known ? error.status : 502,
        ms: elapsedMs(queuedStarted),
        note: `queue_ms=${elapsedMs(queuedStarted)};queue_rejected=1`,
      })
      throw error
    }
    const queueMs = elapsedMs(queuedStarted)
    const usageNote = (attempts: number) => `queue_ms=${queueMs};attempts=${attempts}${client ? `;client=${client}` : ''}`
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
        permit?.release()
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
        permit?.release()
        await logUsage(store, { user, model: provider.label, ok: true, status: upstream.status, ms: elapsedMs(started), note: usageNote(attempts) })
      }
      return withStreamLogging(upstream, complete)
    } catch (error) {
      permit?.release()
      const known = error instanceof provider.RequestError
      const status = known ? error.status : 502
      const detail = known ? error.publicMessage : '模型服务暂时不可用，请稍后重试'
      await logUsage(store, {
        user,
        model: provider.label,
        ok: false,
        status,
        ms: elapsedMs(started),
        note: `queue_ms=${queueMs};upstream_request_failed`,
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
    const queuedStarted = performance.now()
    let permit: CapacityPermit
    try {
      permit = await provider.capacity.acquire(schedulerId, {
        maxWaitMs: provider.queueMaxWait * 1000,
        signal: request.signal,
        tokenId: user,
      })
    } catch (error) {
      const known = error instanceof CapacityQueueError
      const queueMs = elapsedMs(queuedStarted)
      await logUsage(store, {
        user,
        model: 'deepseek_web_search',
        ok: false,
        status: known ? error.status : 502,
        ms: queueMs,
        note: `queue_ms=${queueMs};queue_rejected=1`,
      })
      throw error
    }
    const queueMs = elapsedMs(queuedStarted)
    const started = performance.now()
    const usageNote = (attempts: number) => `queue_ms=${queueMs};native_web_search;attempts=${attempts}${client ? `;client=${client}` : ''}`

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
        note: `queue_ms=${queueMs};native_web_search_failed`,
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
  const qwenCapacity = new FairCapacityScheduler(config.qwenConc, config.qwenUserConc, config.qwenTokenConc, config.qwenQueueMax)
  const mimoBucket = new TokenBucket(config.mimoRpm)
  const mimoReservations = new MimoReservationScheduler({
    maxConcurrent: config.mimoConc,
    nativeConcurrent: config.mimoNativeConc,
    visionConcurrent: config.visionConc,
    maxConcurrentPerUser: config.mimoUserConc,
    maxConcurrentPerToken: config.mimoTokenConc,
    maxInflightPerUser: config.mimoInflightPerUser,
    nativeQueueMax: config.mimoQueueMax,
    visionQueueMax: config.visionQueueMax,
    visionMaxConcurrentPerUser: config.visionPerClientConc,
    visionMaxInflightPerUser: config.visionMaxInflightPerClient,
  })
  const mimoNativeCapacity = mimoReservations.forLane('native')
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
      capacity: mimoNativeCapacity,
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
  const deepseekCapacity = new FairCapacityScheduler(
    config.deepseekConc,
    config.deepseekUserConc,
    config.deepseekTokenConc,
    config.deepseekQueueMax,
  )
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
      mimoReservations,
      mimoRateLimiter: mimoBucket,
      // Keep a vision call's RPM wait inside its stricter three-second queue budget
      // instead of borrowing the ordinary MiMo chat path's five-second allowance.
      mimoRateLimitMaxWaitSeconds: Math.min(config.mimoQueueMaxWait, config.visionQueueMaxWaitMs / 1000),
      caps: {
        maxImages: config.visionMaxImages,
        maxImageBytes: config.visionMaxImageBytes,
        maxTotalBytes: config.visionMaxTotalBytes,
        visionTimeoutMs: config.visionTimeoutMs,
        maxConcurrent: config.visionConc,
        queueMax: config.visionQueueMax,
        queueMaxWaitMs: config.visionQueueMaxWaitMs,
        perClientConc: config.visionPerClientConc,
        maxInflightPerClient: config.visionMaxInflightPerClient,
        perRequestConc: config.visionPerRequestConc,
        cacheMax: config.visionCacheMax,
        cacheTtlMs: config.visionCacheTtlMs,
      },
  })
    : null
  const imgBucket = new TokenBucket(config.imgIpm, config.imgQueueMax)
  const ingressBodyBudget = new InflightByteBudget(config.ingressInflightBodyBytes, '请求较多，请稍后重试')
  const transcribeBucket = new TokenBucket(config.transcribeRpm)
  const transcribeSem = new AsyncSemaphore(config.transcribeConc)
  const transcribe = deps.transcribeImpl === undefined ? createGatewayTranscriber(env) : deps.transcribeImpl
  async function fetchHandler(request: Request, server?: RequestTimeoutController): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        if (!authenticatedUser(config, request)) return jsonResponse({ ok: true })
        const mimo = mimoReservations.snapshot()
        const nativeMimo = mimoReservations.laneSnapshot('native')
        const reservedVision = mimoReservations.laneSnapshot('vision')
        const vision = visionBridge?.snapshot() ?? {
          active: reservedVision.active,
          queued: reservedVision.queued,
          limit: reservedVision.maxConcurrent,
          queueMax: reservedVision.queueMax,
          perClientConc: config.visionPerClientConc,
          maxInflightPerClient: config.visionMaxInflightPerClient,
          oldestQueueMs: 0,
        }
        return jsonResponse({
          ok: true,
          limits: {
            qwen_rpm: config.qwenRpm,
            qwen_conc: config.qwenConc,
            qwen_user_conc: config.qwenUserConc,
            qwen_token_conc: config.qwenTokenConc,
            qwen_queue_max: config.qwenQueueMax,
            qwen_queue_max_wait_seconds: config.qwenQueueMaxWait,
            mimo_rpm: config.mimoRpm,
            mimo_conc: config.mimoConc,
            mimo_native_conc: config.mimoNativeConc,
            mimo_user_conc: config.mimoUserConc,
            mimo_inflight_per_user: config.mimoInflightPerUser,
            mimo_token_conc: config.mimoTokenConc,
            mimo_queue_max: config.mimoQueueMax,
            mimo_queue_max_wait_seconds: config.mimoQueueMaxWait,
            deepseek_rpm: config.deepseekRpm,
            deepseek_conc: config.deepseekConc,
            deepseek_user_conc: config.deepseekUserConc,
            deepseek_token_conc: config.deepseekTokenConc,
            deepseek_queue_max: config.deepseekQueueMax,
            deepseek_queue_max_wait_seconds: config.deepseekQueueMaxWait,
            vision_conc: config.visionConc,
            vision_queue_max: config.visionQueueMax,
            vision_queue_max_wait_ms: config.visionQueueMaxWaitMs,
            vision_per_client_conc: config.visionPerClientConc,
            vision_max_inflight_per_client: config.visionMaxInflightPerClient,
            vision_per_request_conc: config.visionPerRequestConc,
            img_ipm: config.imgIpm,
            img_queue_max: config.imgQueueMax,
            img_task_max_body_bytes: config.imgTaskMaxBodyBytes,
            relay_submit_timeout_ms: config.relaySubmitTimeoutMs,
            ingress_inflight_body_bytes: config.ingressInflightBodyBytes,
            ingress_body_read_timeout_ms: config.ingressBodyReadTimeoutMs,
            transcribe_rpm: config.transcribeRpm,
            transcribe_conc: config.transcribeConc,
          },
          // Kept for old clients that already read this field. Product-level daily quotas are disabled.
          quota: {},
          capacity: {
            qwen: qwenCapacity.snapshot(),
            // `mimo` remains the backwards-compatible aggregate seen by existing
            // runners. `mimo_native` makes the partition observable without asking
            // consumers to infer it from the total and visual snapshots.
            mimo: {
              ...mimo,
              nativeReserved: config.mimoNativeConc,
              visionReserved: config.visionConc,
            },
            mimo_native: nativeMimo,
            // Explicit alias for dashboards that want to distinguish the historic
            // `mimo` name from the aggregate physical-account view.
            mimo_total: {
              ...mimo,
              nativeReserved: config.mimoNativeConc,
              visionReserved: config.visionConc,
            },
            deepseek: deepseekCapacity.snapshot(),
            vision,
            ingress_body: ingressBodyBudget.snapshot(),
          },
          features: {
            transcription: transcribe !== null,
            chat_qwen: qwenChat !== null,
            chat_mimo: mimoChat !== null,
            chat_deepseek: deepseekChat !== null,
            vision_bridge: visionBridge !== null,
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
        // Bun defaults to a 10 s idle timeout. Native web-search may legitimately wait
        // in the same DeepSeek pool as chat, so disable it before body read/queue wait.
        server?.timeout(request, 0)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) {
          throw new HttpError(415, '联网检索请求需要 JSON')
        }
        return await withBufferedBodyReservation(request, config.visionMaxTotalBytes, ingressBodyBudget, config.ingressBodyReadTimeoutMs, async rawBody => {
          if (!deepseekNativeWebSearch) {
            throw new HttpError(503, 'DeepSeek 模型服务未配置（缺 GW_DEEPSEEK_KEY）')
          }
          return await deepseekNativeWebSearch(request, rawBody, user, readClientId(request))
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const user = auth(config, request)
        // Long DeepSeek queues and quiet SSE streams are valid product behavior. Set
        // this before buffering/vision admission so Bun's 10 s default cannot sever it.
        server?.timeout(request, 0)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '模型请求需要 JSON')
        // 请求体大小闸,在任何路由/解析/许可之前:防超大/伪造 Content-Length/chunked body(典型是
        // 图片 base64)打爆内存/上游。先用声明的 Content-Length 做一次读 body 之前的快速拒绝
        // (常规场景零额外开销);真正兜底的上限由 readRequestBodyBounded 按流式真实字节数强制,
        // 不信任可被伪造的头或 chunked 编码。复用视觉桥接的 maxTotalBytes 上限,对所有聊天请求
        // 生效(不止带图请求)。
        return await withBufferedBodyReservation(request, config.visionMaxTotalBytes, ingressBodyBudget, config.ingressBodyReadTimeoutMs, async rawBody => {
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
            const schedulerId = client ? `${user}#${client}` : user
            const { body, metrics } = await visionBridge.transform(rawBody, {
              signal: request.signal,
              schedulerId,
              tokenId: user,
            })
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
        })
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

      // 生图异步任务:提交短请求到 relay；relay 再按模型调用 GPT Image 或豆包 Seedream。
      if (request.method === 'POST' && url.pathname === '/v1/images/tasks') {
        const user = auth(config, request)
        // Relay forwarding can cross the default Bun 10 s idle window even though image
        // generation itself is asynchronous. Disable it before buffering/rate waiting.
        server?.timeout(request, 0)
        if (!config.relayTasksBase) throw new HttpError(503, '生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '生图任务需要 JSON')
        try {
          return await withBufferedBodyReservation(request, config.imgTaskMaxBodyBytes, ingressBodyBudget, config.ingressBodyReadTimeoutMs, async rawBody => {
            // Submission counts toward the short ingress rate guard, not relay's actual
            // image-generation concurrency. Respect cancellation while waiting so a
            // disconnected client cannot occupy TokenBucket's serialized chain forever.
            await imgBucket.acquire(config.queueMaxWait, request.signal)
            const started = performance.now()
            // 把受信任务归属身份传给 relay(relay 据此绑定 owner、越权轮询 403);客户端若带
            // Idempotency-Key 则透传,relay 按 (owner,key) 去重,重复提交只跑一次真实上游。
            const submitHeaders: Record<string, string> = {
              Authorization: `Bearer ${config.relayToken}`,
              'Content-Type': 'application/json',
              'X-Relay-Owner': relayOwner(user, readClientId(request)),
            }
            const idempotencyKey = request.headers.get('idempotency-key')
            if (idempotencyKey) submitHeaders['Idempotency-Key'] = idempotencyKey
            const relayController = new AbortController()
            let relayTimedOut = false
            const abortForClient = () => relayController.abort()
            if (request.signal.aborted) abortForClient()
            else request.signal.addEventListener('abort', abortForClient, { once: true })
            const relayTimer = setTimeout(() => {
              relayTimedOut = true
              relayController.abort()
            }, config.relaySubmitTimeoutMs)
            try {
              const upstream = await fetchImpl(`${config.relayTasksBase}/images/tasks`, {
                method: 'POST',
                body: rawBody,
                signal: relayController.signal,
                headers: submitHeaders,
              })
              await logUsage(store, { user, model: 'img', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
              return await proxyJsonOrRaw(upstream)
            } catch (error) {
              if (relayTimedOut) {
                await logUsage(store, { user, model: 'img', ok: false, status: 504, ms: elapsedMs(started), note: 'relay_submit_timeout' })
                throw new HttpError(504, '生图任务提交超时，请稍后重试')
              }
              if (request.signal.aborted) {
                await logUsage(store, { user, model: 'img', ok: false, status: 499, ms: elapsedMs(started), note: 'client_cancelled' })
                throw new HttpError(499, '请求已取消')
              }
              throw error
            } finally {
              clearTimeout(relayTimer)
              request.signal.removeEventListener('abort', abortForClient)
            }
          })
        } catch (err) {
          if (err instanceof HttpError) throw err
          // Do not expose raw relay/network details. The usage row keeps only a fixed
          // category; the shared ingress reservation is released by the helper above.
          await logUsage(store, { user, model: 'img', ok: false, status: 599, ms: 0, note: 'image_task_forward_failed' })
          throw new HttpError(502, '生图任务提交出错，请稍后重试')
        }
      }

      if (
        request.method === 'POST'
        && url.pathname.startsWith('/v1/images/tasks/')
        && url.pathname.endsWith('/cancel')
      ) {
        const user = auth(config, request)
        // Cancellation still crosses the mainland/US relay boundary. Disable Bun's
        // 10 s idle timeout before that request so a slow relay acknowledgement is
        // not turned into a client-side socket reset.
        server?.timeout(request, 0)
        if (!config.relayTasksBase) throw new HttpError(503, '生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
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

      // 生图异步任务:轮询状态(短请求,不计配额)。带上同一 owner,relay 强制"谁提交谁轮询",
      // 拿别人的 task id 轮询会被 relay 返 403。
      if (request.method === 'GET' && url.pathname.startsWith('/v1/images/tasks/')) {
        const user = auth(config, request)
        // A status poll also waits on the cross-border relay. Apply this before
        // forwarding so Bun's default 10 s idle timeout cannot reset the client
        // socket while the relay is still responding.
        server?.timeout(request, 0)
        if (!config.relayTasksBase) throw new HttpError(503, '生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
        const taskId = url.pathname.slice('/v1/images/tasks/'.length)
        if (!taskId || taskId.includes('/')) throw new HttpError(400, '无效 task id')
        // The load runner asks only for compact terminal metadata so it never pulls
        // b64 image output merely to observe status. Do not forward arbitrary query
        // parameters from an app client to the internal relay.
        const metadataOnly = url.searchParams.get('metadata_only') === '1'
        const metadataQuery = metadataOnly ? '?metadata_only=1' : ''
        const upstream = await fetchImpl(`${config.relayTasksBase}/images/tasks/${encodeURIComponent(taskId)}${metadataQuery}`, {
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

/**
 * Bun defaults an HTTP connection to a short idle timeout. Chat and thinking
 * streams already disable their per-request timeout in the handler, but the
 * server-level setting also needs enough headroom before the first upstream
 * byte arrives. Bun caps this server-level value at 255 seconds; long-running
 * handlers still explicitly disable their individual request timeout.
 */
export function gatewayServerIdleTimeoutSeconds(env: Env = process.env): number {
  return Math.min(255, Math.max(30, intEnv(env, 'GW_SERVER_IDLE_TIMEOUT_SECONDS', 255)))
}

export function startGatewayServer(opts: { host?: string; port?: number } = {}) {
  return Bun.serve({
    hostname: opts.host ?? '127.0.0.1',
    port: opts.port ?? 8799,
    idleTimeout: gatewayServerIdleTimeoutSeconds(),
    fetch: createGatewayFetch(),
  })
}

if (import.meta.main) {
  const { host, port } = parseArgs(process.argv.slice(2))
  const server = startGatewayServer({ host, port })
  console.log(`[qfgw] listening on http://${host}:${server.port}`)
}
