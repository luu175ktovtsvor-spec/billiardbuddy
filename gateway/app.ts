import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  createGatewayTranscriber,
  GatewayTranscriptionError,
  type GatewayTranscriber,
} from './transcription'

type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type GatewayConfig = {
  mimoKey: string
  mimoBase: string
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
  mimoRpm: number
  imgIpm: number
  imgConc: number
  qChat: number
  qImg: number
  queueMaxWait: number
  arkChatRpm: number
  qArkChat: number
  arkImgIpm: number
  arkImgConc: number
  qArkImg: number
  qAmap: number
  transcribeRpm: number
  transcribeConc: number
  qTranscribe: number
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
  usedToday(user: string, model: string): number | Promise<number>
  log(entry: UsageEntry): void | Promise<void>
  todayByModel(): Array<{ model: string; total: number; ok: number }> | Promise<Array<{ model: string; total: number; ok: number }>>
  recent(n: number): Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>
}

export interface GatewayDeps {
  env?: Env
  fetchImpl?: FetchLike
  usageStore?: UsageStore
  transcribeImpl?: GatewayTranscriber | null
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

  async acquire(maxWaitSeconds: number): Promise<void> {
    const previous = this.chain
    let release!: () => void
    this.chain = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      const deadline = performance.now() + Math.max(0, maxWaitSeconds) * 1000
      while (true) {
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
        await sleep(Math.min(needMs, 500))
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

  usedToday(user: string, model: string): number {
    const row = this.db
      .query('SELECT COUNT(*) AS n FROM usage WHERE day=? AND user=? AND model=? AND ok=1')
      .get(todayCst(), user, model) as { n?: number } | undefined
    return Number(row?.n ?? 0)
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

  usedToday(user: string, model: string): number {
    const day = todayCst()
    return this.rows.filter(row => row.day === day && row.user === user && row.model === model && row.ok).length
  }

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
    mimoKey: required(env, 'GW_MIMO_KEY'),
    mimoBase: (env.GW_MIMO_BASE ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
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
    mimoRpm: intEnv(env, 'GW_MIMO_RPM', 90),
    imgIpm: intEnv(env, 'GW_IMG_IPM', 18),
    imgConc: intEnv(env, 'GW_IMG_CONC', 12),
    qChat: intEnv(env, 'GW_Q_CHAT', 300),
    qImg: intEnv(env, 'GW_Q_IMG', 20),
    queueMaxWait: floatEnv(env, 'GW_QUEUE_MAX_WAIT', 60),
    arkChatRpm: intEnv(env, 'GW_ARK_CHAT_RPM', 30),
    qArkChat: intEnv(env, 'GW_Q_ARK_CHAT', 500),
    arkImgIpm: intEnv(env, 'GW_ARK_IMG_IPM', 20),
    arkImgConc: intEnv(env, 'GW_ARK_IMG_CONC', 6),
    qArkImg: intEnv(env, 'GW_Q_ARK_IMG', 20),
    qAmap: intEnv(env, 'GW_Q_AMAP', 300),
    transcribeRpm: intEnv(env, 'GW_TRANSCRIBE_RPM', 12),
    transcribeConc: intEnv(env, 'GW_TRANSCRIBE_CONC', 1),
    qTranscribe: intEnv(env, 'GW_Q_TRANSCRIBE', 100),
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
  const header = request.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, '缺少 app 令牌')
  }
  const token = header.slice(7).trim()
  const user = config.appTokens.get(token)
  if (!user) throw new HttpError(401, 'app 令牌无效')
  return user
}

async function quotaCheck(store: UsageStore, user: string, kind: string, limit: number): Promise<void> {
  if (await store.usedToday(user, kind) >= limit) {
    throw new HttpError(429, `今天「${kind}」额度用完了(每天 ${limit} 次),明天再来或找管理员加`)
  }
}

async function logUsage(store: UsageStore, entry: UsageEntry): Promise<void> {
  await store.log(entry)
}

function withStreamLogging(resp: Response, onDone: () => Promise<void>): Response {
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
      controller.enqueue(value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
      await onDone()
    },
  })
  return new Response(stream, { status: resp.status, headers })
}

export function createGatewayFetch(deps: GatewayDeps = {}) {
  const env = deps.env ?? process.env
  const config = loadConfig(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const store = deps.usageStore ?? new SqliteUsageStore(config.db)
  const mimoBucket = new TokenBucket(config.mimoRpm)
  const imgBucket = new TokenBucket(config.imgIpm)
  const imgSem = new AsyncSemaphore(config.imgConc)
  const arkChatBucket = new TokenBucket(config.arkChatRpm)
  const arkImgBucket = new TokenBucket(config.arkImgIpm)
  const arkImgSem = new AsyncSemaphore(config.arkImgConc)
  const transcribeBucket = new TokenBucket(config.transcribeRpm)
  const transcribeSem = new AsyncSemaphore(config.transcribeConc)
  const transcribe = deps.transcribeImpl === undefined ? createGatewayTranscriber(env) : deps.transcribeImpl

  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return jsonResponse({
          ok: true,
          limits: {
            mimo_rpm: config.mimoRpm,
            img_ipm: config.imgIpm,
            img_conc: config.imgConc,
            ark_chat_rpm: config.arkChatRpm,
            ark_img_ipm: config.arkImgIpm,
            ark_img_conc: config.arkImgConc,
            transcribe_rpm: config.transcribeRpm,
            transcribe_conc: config.transcribeConc,
          },
          quota: {
            chat: config.qChat,
            img: config.qImg,
            ark_chat: config.qArkChat,
            ark_img: config.qArkImg,
            amap: config.qAmap,
            transcribe: config.qTranscribe,
          },
          features: { transcription: transcribe !== null },
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
        await quotaCheck(store, user, 'mimo', config.qChat)
        await mimoBucket.acquire(config.queueMaxWait)
        const body = await request.arrayBuffer()
        const started = performance.now()
        const upstream = await fetchImpl(`${config.mimoBase}/chat/completions`, {
          method: 'POST',
          body,
          headers: {
            Authorization: `Bearer ${config.mimoKey}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'identity',
          },
        })
        const ok = upstream.status < 400
        return withStreamLogging(upstream, async () => {
          await logUsage(store, { user, model: 'mimo', ok, status: upstream.status, ms: elapsedMs(started) })
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        const user = auth(config, request)
        if (!transcribe) throw new HttpError(503, '语音识别服务暂不可用')
        await quotaCheck(store, user, 'transcribe', config.qTranscribe)
        const contentType = request.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, '需要上传音频文件')
        const declaredSize = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declaredSize) && declaredSize > config.transcribeMaxBytes + 1024 * 1024) {
          throw new HttpError(413, '音频文件过大')
        }
        await transcribeBucket.acquire(config.queueMaxWait)
        const started = performance.now()
        return await transcribeSem.run(async () => {
          const form = await request.formData().catch(() => null)
          const file = form?.get('file')
          if (!(file instanceof File) || file.size === 0) throw new HttpError(400, '没有收到音频文件')
          if (file.size > config.transcribeMaxBytes) throw new HttpError(413, '音频文件过大')
          if (!supportedAudio(file)) throw new HttpError(415, '不支持这种音频格式')
          const languageRaw = String(form?.get('language') ?? 'zh').trim().toLowerCase()
          const language = /^[a-z]{2,8}$/.test(languageRaw) ? languageRaw : 'zh'
          const formatRaw = String(form?.get('response_format') ?? 'json')
          const responseFormat = formatRaw === 'verbose_json' ? 'verbose_json' : 'json'
          try {
            const result = await transcribe(file, { language, responseFormat, signal: request.signal })
            await logUsage(store, { user, model: 'transcribe', ok: true, status: 200, ms: elapsedMs(started) })
            return jsonResponse(result)
          } catch (error) {
            const status = error instanceof GatewayTranscriptionError ? error.status : 502
            const detail = error instanceof GatewayTranscriptionError ? error.publicMessage : '语音识别失败，请稍后重试'
            await logUsage(store, { user, model: 'transcribe', ok: false, status, ms: elapsedMs(started) })
            throw new HttpError(status, detail)
          }
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
        const user = auth(config, request)
        await quotaCheck(store, user, 'img', config.qImg)
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
        await quotaCheck(store, user, 'img', config.qImg)
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
        await quotaCheck(store, user, 'img', config.qImg)
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
        await quotaCheck(store, user, 'ark_chat', config.qArkChat)
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
        await quotaCheck(store, user, 'ark_img', config.qArkImg)
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
        await quotaCheck(store, user, 'amap', config.qAmap)
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
      console.error('[qfgw] request failed', err)
      return jsonError(500, 'internal server error')
    }
  }

  return fetchHandler
}

function elapsedMs(started: number): number {
  return Math.trunc(performance.now() - started)
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
