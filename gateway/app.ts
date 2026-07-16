import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  createGatewayTranscriber,
  GatewayTranscriptionError,
  type GatewayTranscriber,
} from './transcription'
import {
  createGatewayWebSearch,
  GatewayWebSearchError,
  type GatewayWebSearch,
} from './webSearch'
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

// 一个可路由的聊天上游(千问 / MiMo)。每个上游各自持有独立的凭据、白名单、限速、
// 并发、重试与用量标签;共享的代理逻辑由 createChatHandler 消费本结构,互不串台。
type ChatProvider = {
  label: 'qwen' | 'mimo'
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
  prepareBody: (rawBody: string, allowed: ReadonlySet<string>, defaultModel: string) => { body: string }
  fetchWithRetry: (
    doRequest: (attempt: number) => Promise<Response>,
    opts: ChatRetryOptions,
  ) => Promise<{ response: Response; attempts: number }>
  RequestError: ChatRequestErrorCtor
  retrySleep?: (ms: number) => Promise<void>
  retryRandom?: () => number
}

type ChatHandler = (request: Request, rawBody: string, user: string) => Promise<Response>

type GatewayConfig = {
  qwenKey: string
  qwenBase: string
  qwenModel: string
  relayBase: string
  relayToken: string
  relayTasksBase: string
  adminToken: string
  db: string
  arkKey: string
  arkBase: string
  amapKey: string
  amapBase: string
  appTokens: Map<string, string>
  qwenRpm: number
  qwenConc: number
  qwenUserConc: number
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
  mimoQueueMaxWait: number
  mimoRetryMax: number
  mimoRetryBaseMs: number
  mimoRetryMaxMs: number
  mimoAllowedModels: ReadonlySet<string>
  imgIpm: number
  imgConc: number
  queueMaxWait: number
  arkChatRpm: number
  arkImgIpm: number
  arkImgConc: number
  transcribeRpm: number
  transcribeConc: number
  transcribeMaxBytes: number
  webSearchRpm: number
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
  webSearchImpl?: GatewayWebSearch | null
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
    relayBase: required(env, 'GW_RELAY_BASE').replace(/\/+$/, ''),
    relayToken: required(env, 'GW_RELAY_TOKEN'),
    // 美国 relay 上的 GPT 生图异步任务服务(relay/app.ts)地址;缺则异步任务端点返回 503,客户端退同步路径。
    relayTasksBase: (env.GW_RELAY_TASKS_BASE ?? '').replace(/\/+$/, ''),
    adminToken: env.GW_ADMIN_TOKEN ?? 'change-me',
    db: env.GW_DB ?? '/opt/qfgw/usage.db',
    arkKey: env.GW_ARK_KEY ?? '',
    arkBase: (env.GW_ARK_BASE ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, ''),
    amapKey: env.GW_AMAP_KEY ?? '',
    amapBase: (env.GW_AMAP_BASE ?? 'https://restapi.amap.com').replace(/\/+$/, ''),
    appTokens: parseAppTokens(env.GW_APP_TOKENS),
    qwenRpm: intEnv(env, 'GW_QWEN_RPM', 90),
    qwenConc: Math.max(1, intEnv(env, 'GW_QWEN_CONC', 16)),
    qwenUserConc: Math.max(1, intEnv(env, 'GW_QWEN_USER_CONC', 2)),
    qwenQueueMaxWait: Math.max(0, floatEnv(env, 'GW_QWEN_QUEUE_MAX_WAIT', 120)),
    qwenRetryMax: Math.max(0, intEnv(env, 'GW_QWEN_MAX_RETRIES', 3)),
    qwenRetryBaseMs: Math.max(1, intEnv(env, 'GW_QWEN_RETRY_BASE_MS', 500)),
    qwenRetryMaxMs: Math.max(1, intEnv(env, 'GW_QWEN_RETRY_MAX_MS', 8000)),
    qwenAllowedModels: loadQwenAllowedModels(env),
    mimoKey: env.GW_MIMO_KEY ?? '',
    mimoBase: (env.GW_MIMO_BASE ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
    mimoModel: env.GW_MIMO_MODEL ?? 'mimo-v2.5',
    mimoRpm: intEnv(env, 'GW_MIMO_RPM', 90),
    mimoConc: Math.max(1, intEnv(env, 'GW_MIMO_CONC', 16)),
    mimoUserConc: Math.max(1, intEnv(env, 'GW_MIMO_USER_CONC', 2)),
    mimoQueueMaxWait: Math.max(0, floatEnv(env, 'GW_MIMO_QUEUE_MAX_WAIT', 120)),
    mimoRetryMax: Math.max(0, intEnv(env, 'GW_MIMO_MAX_RETRIES', 3)),
    mimoRetryBaseMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_BASE_MS', 500)),
    mimoRetryMaxMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_MAX_MS', 8000)),
    mimoAllowedModels: loadMimoAllowedModels(env),
    imgIpm: intEnv(env, 'GW_IMG_IPM', 18),
    imgConc: intEnv(env, 'GW_IMG_CONC', 12),
    queueMaxWait: floatEnv(env, 'GW_QUEUE_MAX_WAIT', 60),
    arkChatRpm: intEnv(env, 'GW_ARK_CHAT_RPM', 30),
    arkImgIpm: intEnv(env, 'GW_ARK_IMG_IPM', 20),
    arkImgConc: intEnv(env, 'GW_ARK_IMG_CONC', 6),
    transcribeRpm: intEnv(env, 'GW_TRANSCRIBE_RPM', 12),
    transcribeConc: intEnv(env, 'GW_TRANSCRIBE_CONC', 1),
    transcribeMaxBytes: intEnv(env, 'GW_TRANSCRIBE_MAX_BYTES', 96 * 1024 * 1024),
    webSearchRpm: intEnv(env, 'GW_WEBSEARCH_RPM', 30),
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
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        await onDone()
        return
      }
      onChunk?.(value)
      controller.enqueue(value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
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
  return async function chatHandler(request: Request, rawBody: string, user: string): Promise<Response> {
    // prepareBody 在拿容量许可之前跑,校验失败(400/503)不会漏掉一个许可名额。
    const prepared = provider.prepareBody(rawBody, provider.allowedModels, provider.defaultModel)
    const permit = await provider.capacity.acquire(user, {
      maxWaitMs: provider.queueMaxWait * 1000,
      signal: request.signal,
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
          note: `attempts=${attempts}`,
        })
        return jsonError(upstream.status, modelPublicError(upstream.status, upstreamDetail))
      }

      let completed = false
      const complete = async () => {
        if (completed) return
        completed = true
        permit.release()
        await logUsage(store, { user, model: provider.label, ok: true, status: upstream.status, ms: elapsedMs(started), note: `attempts=${attempts}` })
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

export function createGatewayFetch(deps: GatewayDeps = {}) {
  const env = deps.env ?? process.env
  const config = loadConfig(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const store = deps.usageStore ?? new SqliteUsageStore(config.db)
  const qwenBucket = new TokenBucket(config.qwenRpm)
  const qwenCapacity = new FairCapacityScheduler(config.qwenConc, config.qwenUserConc)
  const mimoBucket = new TokenBucket(config.mimoRpm)
  const mimoCapacity = new FairCapacityScheduler(config.mimoConc, config.mimoUserConc)
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
  const imgBucket = new TokenBucket(config.imgIpm)
  const imgSem = new AsyncSemaphore(config.imgConc)
  const arkChatBucket = new TokenBucket(config.arkChatRpm)
  const arkImgBucket = new TokenBucket(config.arkImgIpm)
  const arkImgSem = new AsyncSemaphore(config.arkImgConc)
  const transcribeBucket = new TokenBucket(config.transcribeRpm)
  const transcribeSem = new AsyncSemaphore(config.transcribeConc)
  const transcribe = deps.transcribeImpl === undefined ? createGatewayTranscriber(env) : deps.transcribeImpl
  const webSearchBucket = new TokenBucket(config.webSearchRpm)
  const webSearch = deps.webSearchImpl === undefined ? createGatewayWebSearch(env, fetchImpl) : deps.webSearchImpl

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
            img_ipm: config.imgIpm,
            img_conc: config.imgConc,
            ark_chat_rpm: config.arkChatRpm,
            ark_img_ipm: config.arkImgIpm,
            ark_img_conc: config.arkImgConc,
            transcribe_rpm: config.transcribeRpm,
            transcribe_conc: config.transcribeConc,
            web_search_rpm: config.webSearchRpm,
          },
          // Kept for old clients that already read this field. Product-level daily quotas are disabled.
          quota: {},
          capacity: { qwen: qwenCapacity.snapshot(), mimo: mimoCapacity.snapshot() },
          features: {
            transcription: transcribe !== null,
            web_search: webSearch !== null,
            chat_qwen: qwenChat !== null,
            chat_mimo: mimoChat !== null,
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

      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const user = auth(config, request)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '模型请求需要 JSON')
        const rawBody = await request.text()
        // 路由规则:请求 model 命中 MiMo 白名单 → 只能走 MiMo;MiMo 未配置时显式 503,绝不改投千问。
        // 未命中 MiMo 白名单(未知或千问模型)→ 默认千问,千问把白名单外 model 改写为 GW_QWEN_MODEL。
        // MiMo 白名单由 loadMimoAllowedModels 独立于 GW_MIMO_KEY 加载(始终含默认 mimo-v2.5),因此
        // 缺 key 时仍能识别 MiMo 目标模型并 fail closed。两家各用各自凭据/限速/重试,任一失败都不跨模型回退。
        const requestedModel = parseChatModel(rawBody)
        if (config.mimoAllowedModels.has(requestedModel)) {
          if (!mimoChat) throw new HttpError(503, 'MiMo 模型服务未配置（缺 GW_MIMO_KEY）')
          return await mimoChat(request, rawBody, user)
        }
        if (!qwenChat) throw new HttpError(503, '千问模型服务未配置（缺 GW_QWEN_KEY）')
        return await qwenChat(request, rawBody, user)
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

      if (request.method === 'POST' && url.pathname === '/v1/web_search') {
        const user = auth(config, request)
        if (!webSearch) throw new HttpError(503, '联网搜索服务暂不可用')
        await webSearchBucket.acquire(config.queueMaxWait)
        const contentType = request.headers.get('content-type') ?? ''
        if (!isJsonContentType(contentType)) throw new HttpError(415, '联网搜索需要 JSON 请求')
        const body = await request.json().catch(() => null)
        const started = performance.now()
        try {
          const result = await webSearch(body, { signal: request.signal })
          await logUsage(store, { user, model: 'web_search', ok: true, status: 200, ms: elapsedMs(started) })
          return jsonResponse(result)
        } catch (error) {
          const status = error instanceof GatewayWebSearchError ? error.status : 502
          const detail = error instanceof GatewayWebSearchError ? error.publicMessage : '联网搜索暂时不可用，请稍后重试'
          await logUsage(store, { user, model: 'web_search', ok: false, status, ms: elapsedMs(started) })
          throw new HttpError(status, detail)
        }
      }

      if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
        const user = auth(config, request)
        await imgBucket.acquire(config.queueMaxWait)
        return await imgSem.run(async () => {
          const started = performance.now()
          try {
            const upstream = await fetchImpl(`${config.relayBase}/images/generations`, {
              method: 'POST',
              body: await request.arrayBuffer(),
              headers: { Authorization: `Bearer ${config.relayToken}`, 'Content-Type': 'application/json' },
            })
            await logUsage(store, { user, model: 'img', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
            return await proxyJsonOrRaw(upstream)
          } catch (err) {
            await logUsage(store, { user, model: 'img', ok: false, status: 599, ms: elapsedMs(started), note: String(err).slice(0, 120) })
            throw new HttpError(502, `生图上游出错:${String(err).slice(0, 120)}`)
          }
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/images/edits') {
        const user = auth(config, request)
        await imgBucket.acquire(config.queueMaxWait)
        return await imgSem.run(async () => {
          const started = performance.now()
          try {
            const upstream = await fetchImpl(`${config.relayBase}/images/edits`, {
              method: 'POST',
              body: await request.arrayBuffer(),
              headers: {
                Authorization: `Bearer ${config.relayToken}`,
                'Content-Type': request.headers.get('content-type') ?? 'application/octet-stream',
              },
            })
            await logUsage(store, { user, model: 'img', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
            return await proxyJsonOrRaw(upstream)
          } catch (err) {
            await logUsage(store, { user, model: 'img', ok: false, status: 599, ms: elapsedMs(started), note: String(err).slice(0, 120) })
            throw new HttpError(502, `图生图上游出错:${String(err).slice(0, 120)}`)
          }
        })
      }

      // GPT 生图异步任务:提交(短请求,转发到美国 relay 任务服务;慢调用在美国本地跑,绕开跨境长连接 60s 被掐)。
      if (request.method === 'POST' && url.pathname === '/v1/images/tasks') {
        const user = auth(config, request)
        if (!config.relayTasksBase) throw new HttpError(503, 'GPT 生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
        await imgBucket.acquire(config.queueMaxWait) // 提交计入生图 IPM 限速;短请求不占 imgSem 在途并发
        const started = performance.now()
        try {
          const upstream = await fetchImpl(`${config.relayTasksBase}/images/tasks`, {
            method: 'POST',
            body: await request.arrayBuffer(),
            headers: { Authorization: `Bearer ${config.relayToken}`, 'Content-Type': 'application/json' },
          })
          await logUsage(store, { user, model: 'img', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
          return await proxyJsonOrRaw(upstream)
        } catch (err) {
          await logUsage(store, { user, model: 'img', ok: false, status: 599, ms: elapsedMs(started), note: String(err).slice(0, 120) })
          throw new HttpError(502, `生图任务提交出错:${String(err).slice(0, 120)}`)
        }
      }

      // GPT 生图异步任务:轮询状态(短请求,不计配额)。
      if (request.method === 'GET' && url.pathname.startsWith('/v1/images/tasks/')) {
        auth(config, request)
        if (!config.relayTasksBase) throw new HttpError(503, 'GPT 生图异步任务未配置(缺 GW_RELAY_TASKS_BASE)')
        const taskId = url.pathname.slice('/v1/images/tasks/'.length)
        if (!taskId || taskId.includes('/')) throw new HttpError(400, '无效 task id')
        const upstream = await fetchImpl(`${config.relayTasksBase}/images/tasks/${encodeURIComponent(taskId)}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${config.relayToken}` },
        })
        return await proxyJsonOrRaw(upstream)
      }

      if (request.method === 'POST' && url.pathname === '/v1/ark/chat/completions') {
        const user = auth(config, request)
        if (!config.arkKey) throw new HttpError(503, '视觉/文案功能未配置(缺 GW_ARK_KEY)')
        await arkChatBucket.acquire(config.queueMaxWait)
        const started = performance.now()
        try {
          const upstream = await fetchImpl(`${config.arkBase}/chat/completions`, {
            method: 'POST',
            body: await request.arrayBuffer(),
            headers: { Authorization: `Bearer ${config.arkKey}`, 'Content-Type': 'application/json' },
          })
          await logUsage(store, { user, model: 'ark_chat', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
          return await proxyJsonOrRaw(upstream)
        } catch (err) {
          await logUsage(store, { user, model: 'ark_chat', ok: false, status: 599, ms: elapsedMs(started), note: String(err).slice(0, 120) })
          throw new HttpError(502, `视觉/文案上游出错:${String(err).slice(0, 120)}`)
        }
      }

      if (request.method === 'POST' && url.pathname === '/v1/ark/images/generations') {
        const user = auth(config, request)
        if (!config.arkKey) throw new HttpError(503, '生图功能未配置(缺 GW_ARK_KEY)')
        await arkImgBucket.acquire(config.queueMaxWait)
        return await arkImgSem.run(async () => {
          const started = performance.now()
          try {
            const upstream = await fetchImpl(`${config.arkBase}/images/generations`, {
              method: 'POST',
              body: await request.arrayBuffer(),
              headers: { Authorization: `Bearer ${config.arkKey}`, 'Content-Type': 'application/json' },
            })
            await logUsage(store, { user, model: 'ark_img', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
            return await proxyJsonOrRaw(upstream)
          } catch (err) {
            await logUsage(store, { user, model: 'ark_img', ok: false, status: 599, ms: elapsedMs(started), note: String(err).slice(0, 120) })
            throw new HttpError(502, `生图上游出错:${String(err).slice(0, 120)}`)
          }
        })
      }

      const amap = url.pathname.match(/^\/v1\/amap\/(.+)$/)
      if (request.method === 'GET' && amap) {
        const user = auth(config, request)
        if (!config.amapKey) throw new HttpError(503, '地图功能未配置(缺 GW_AMAP_KEY)')
        const params = new URLSearchParams(url.searchParams)
        params.set('key', config.amapKey)
        const started = performance.now()
        try {
          const upstream = await fetchImpl(`${config.amapBase}/${amap[1]}?${params.toString()}`)
          await logUsage(store, { user, model: 'amap', ok: upstream.status < 400, status: upstream.status, ms: elapsedMs(started) })
          return await proxyJsonOrRaw(upstream)
        } catch (err) {
          await logUsage(store, { user, model: 'amap', ok: false, status: 599, ms: elapsedMs(started), note: String(err).slice(0, 120) })
          throw new HttpError(502, `地图上游出错:${String(err).slice(0, 120)}`)
        }
      }

      return jsonError(404, 'not found')
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.status, err.detail)
      if (err instanceof CapacityQueueError || err instanceof QwenRequestError || err instanceof MimoRequestError) {
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
