import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { AuthAuthority, AuthError } from './installationAuth'
import {
  createGatewayTranscriber,
  GatewayTranscriptionError,
  type GatewayTranscriber,
} from './transcription'
import {
  CapacityQueueError,
  localGatewayCapacityBackendFactory,
  type CapacityPermit,
  type CapacitySnapshot,
  type GatewayCapacityBackendFactory,
  type GatewayCapacityPool,
  type GatewayRateLimiter,
} from './modelCapacity'
import { loadCapacityPolicy } from './capacityPolicy'
import { loadGatewayProviderCredentials } from './providerCredentials'
import { loadGatewayServiceCredentials } from './serviceCredentials'
import { gatewayUsagePolicyFromEnvironment } from './quotaPolicy'
import {
  ManagedResponsesRequestError,
  prepareManagedResponsesBody,
} from './managedResponses'
import { fetchMimoWithRetry, MimoRequestError, prepareMimoChatBody } from './mimoChat'
import { QwenImageReasoningGatewayError, requestQwenImageReasoning } from './qwenImageReasoning'
import {
  containsImageContent,
  createVisionBridge,
  VisionBridgeError,
  type VisionBridge,
} from './visionBridge'
import {
  PROVIDER_REGISTRY,
  PROVIDER_REGISTRY_CONTRACT_VERSION,
  imageAdviceRegistryEntry,
  mediaReasoningRegistryEntry,
  textReasoningRegistryEntry,
  visualEvidenceRegistryEntry,
} from './providerRegistry'
import {
  fileUsageFingerprint,
  MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT,
  SqliteUsageBudgetService,
  UsageBudgetError,
  usageFingerprint,
  usageOperationId,
  type MeteredCapability,
  type UsageAmount,
  type UsageBudgetService,
  type UsageReceipt,
} from './usageBudget'
import {
  GatewayOperationResultError,
  SqliteGatewayOperationResultStore,
  type GatewayOperationResultBinding,
  type GatewayOperationResultStore,
} from './operationResultStore'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
  PROVIDER_OPERATION_ACK_PATH,
  PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER,
  PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER,
  PROVIDER_OPERATION_RESULT_ID_HEADER,
} from '../ts/shared/product/providerGateway'
import {
  SERVICE_INTROSPECTION_AUDIENCE_HEADER,
  SERVICE_INTROSPECTION_PATH,
  SERVICE_INTROSPECTION_TOKEN_HEADER,
  isServiceIntrospectionAudience,
} from '../ts/shared/product/serviceIntrospection'

type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type RequestTimeoutController = { timeout(request: Request, seconds: number): void }

export const PROVIDER_GATEWAY_PROTOCOL_VALUE = PROVIDER_GATEWAY_PROTOCOL.headerValue
const COMPONENT_MANIFEST = {
  component: 'billiardbuddy-gateway',
  protocol: PROVIDER_GATEWAY_PROTOCOL_VALUE,
} as const

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

type ChatProvider = {
  label: string
  base: string
  authorization: string
  endpoint: 'chat/completions' | 'responses'
  defaultModel: string
  allowedModels: ReadonlySet<string>
  bucket: GatewayRateLimiter
  capacity: GatewayCapacityPool
  queueMaxWait: number
  retryMax?: number
  retryBaseMs?: number
  retryMaxMs?: number
  responseTimeoutMs?: number
  prepareBody: (rawBody: string, allowed: ReadonlySet<string>, defaultModel: string) => { body: string }
  fetchWithRetry?: (
    doRequest: (attempt: number) => Promise<Response>,
    opts: ChatRetryOptions,
  ) => Promise<{ response: Response; attempts: number }>
  RequestError: ChatRequestErrorCtor
  retrySleep?: (ms: number) => Promise<void>
  retryRandom?: () => number
}

// Owner is exclusively the verified principal + registration for usage, scheduling, and
// upstream opaque identity. Untrusted client headers never influence those boundaries.
type ChatHandler = (request: Request, rawBody: string, user: string, principalId: string) => Promise<Response>
type GatewayConfig = {
  adminToken: string
  db: string
  bootstrapRpm: number
  bootstrapQueueMax: number
  bootstrapQueueMaxWait: number
  mimoRpm: number
  /** Retained scheduler lane; BB-04C submits only VisualEvidence work. */
  mimoMediaConc: number
  mimoConc: number
  mimoUserConc: number
  mimoInflightPerUser: number
  mimoTokenConc: number
  mimoQueueMax: number
  mimoQueueMaxWait: number
  mimoRetryMax: number
  mimoRetryBaseMs: number
  mimoRetryMaxMs: number
  qwenRpm: number
  qwenEnabled: boolean
  qwenConc: number
  qwenUserConc: number
  qwenTokenConc: number
  qwenInflightPerUser: number
  qwenQueueMax: number
  qwenQueueMaxWait: number
  qwenResponseTimeoutMs: number
  deepseekModel: string
  deepseekRpm: number
  deepseekConc: number
  deepseekUserConc: number
  deepseekTokenConc: number
  deepseekInflightPerUser: number
  deepseekQueueMax: number
  deepseekQueueMaxWait: number
  /** Hard deadline spanning the managed model request and its SSE body. */
  deepseekResponseTimeoutMs: number
  deepseekAllowedModels: ReadonlySet<string>
  // 视觉证据：图片/视频工作台把输入转为结构化证据；它不再进入 Agent TextReasoning。
  visionMaxImages: number
  visionMaxImageBytes: number
  // 同时也是 /v1/visual/evidence 的整体请求体大小闸(在任何路由/解析/许可之前生效)。
  visionMaxTotalBytes: number
  /** One process-wide ingress reservation for Responses, visual evidence and image task bodies. */
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
  queueMaxWait: number
  transcribeRpm: number
  transcribeConc: number
  transcribeUserConc: number
  transcribeTokenConc: number
  transcribeInflightPerUser: number
  transcribeQueueMax: number
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
  usageBudgetService?: UsageBudgetService
  operationResultStore?: GatewayOperationResultStore
  transcribeImpl?: GatewayTranscriber | null
  mimoRetrySleep?: (ms: number) => Promise<void>
  mimoRetryRandom?: () => number
  /** Production keeps the zero-hop in-process backend. Tests and a future
   * multi-instance deployment may replace all account schedulers/rate buckets
   * together through this one construction seam. */
  capacityBackendFactory?: GatewayCapacityBackendFactory
  /** Explicit authority injection is for tests and controlled embedding only. */
  authority?: AuthAuthority
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail)
  }
}

function requireProviderProtocol(request: Request): void {
  if (request.headers.get(PROVIDER_GATEWAY_PROTOCOL_HEADER)?.trim() !== PROVIDER_GATEWAY_PROTOCOL_VALUE) {
    throw new HttpError(426, 'PROVIDER_PROTOCOL_INCOMPATIBLE')
  }
}

/** Tracks process-wide request-body reservations for Gateway-owned model routes. */
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
    this.db.exec('PRAGMA busy_timeout=5000')
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
      let result
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

function loadConfig(env: Env): GatewayConfig {
  const selectedModel = env.BB_GATEWAY_MODEL?.trim()
  const textModel = selectedModel ? textReasoningRegistryEntry(selectedModel) : textReasoningRegistryEntry()
  if (!textModel) throw new Error('BB_GATEWAY_MODEL must select a registered TextReasoning model')
  if (textModel.provider !== 'deepseek' || textModel.text_reasoning_transport !== 'responses') {
    throw new Error('BilliardBuddy 托管 Agent 仅支持 DeepSeek Responses 协议')
  }
  const capacity = loadCapacityPolicy(env)
  const qwenEnabledRaw = env.GW_QWEN_ENABLED?.trim() ?? '0'
  if (qwenEnabledRaw !== '0' && qwenEnabledRaw !== '1') throw new Error('GW_QWEN_ENABLED must be 0 or 1')
  return {
    adminToken: env.GW_ADMIN_TOKEN ?? 'change-me',
    db: env.GW_DB ?? '/opt/billiardbuddy-gateway/usage.db',
    bootstrapRpm: capacity.bootstrap.rpm,
    bootstrapQueueMax: capacity.bootstrap.queueMax,
    bootstrapQueueMaxWait: capacity.bootstrap.queueMaxWaitMs / 1_000,
    mimoRpm: capacity.mimo.rpm,
    // MediaReasoning and VisualEvidence share one physical account but have hard,
    // separately observable reservations so neither product path can starve the other.
    mimoConc: capacity.mimo.maxConcurrent,
    mimoMediaConc: capacity.mimo.mediaConcurrent,
    mimoUserConc: capacity.mimo.maxConcurrentPerUser,
    mimoInflightPerUser: capacity.mimo.maxInflightPerUser,
    mimoTokenConc: capacity.mimo.maxConcurrentPerToken,
    mimoQueueMax: capacity.mimo.mediaQueueMax,
    mimoQueueMaxWait: capacity.mimo.mediaQueueMaxWaitMs / 1_000,
    // Retained account retry budget allows at most one extra attempt and remains
    // independently bounded.
    mimoRetryMax: Math.max(0, Math.min(1, intEnv(env, 'GW_MIMO_MAX_RETRIES', 1))),
    mimoRetryBaseMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_BASE_MS', 500)),
    mimoRetryMaxMs: Math.max(1, intEnv(env, 'GW_MIMO_RETRY_MAX_MS', 8000)),
    qwenRpm: capacity.qwen.rpm,
    qwenEnabled: qwenEnabledRaw === '1',
    qwenConc: capacity.qwen.maxConcurrent,
    qwenUserConc: capacity.qwen.maxConcurrentPerUser,
    qwenTokenConc: capacity.qwen.maxConcurrentPerToken,
    qwenInflightPerUser: capacity.qwen.maxInflightPerUser,
    qwenQueueMax: capacity.qwen.queueMax,
    qwenQueueMaxWait: capacity.qwen.queueMaxWaitMs / 1_000,
    qwenResponseTimeoutMs: capacity.qwen.responseTimeoutMs,
    // Model choice and capacity are separate: future registered DeepSeek variants
    // share this physical-account pool unless the catalog explicitly binds another one.
    deepseekModel: textModel.model_id,
    deepseekRpm: capacity.deepseek.rpm,
    deepseekConc: capacity.deepseek.maxConcurrent,
    deepseekUserConc: capacity.deepseek.maxConcurrentPerUser,
    deepseekTokenConc: capacity.deepseek.maxConcurrentPerToken,
    deepseekInflightPerUser: capacity.deepseek.maxInflightPerUser,
    deepseekQueueMax: capacity.deepseek.queueMax,
    deepseekQueueMaxWait: capacity.deepseek.queueMaxWaitMs / 1_000,
    // The HTTP idle timeout is disabled for agent SSE. This owns the separate
    // total upstream deadline, including a quiet stream after response headers.
    deepseekResponseTimeoutMs: capacity.deepseek.responseTimeoutMs,
    deepseekAllowedModels: new Set(PROVIDER_REGISTRY.filter(entry => (
      entry.provider === 'deepseek'
      && entry.text_reasoning_transport === 'responses'
      && entry.workload_bindings.some(binding => binding.workload === 'managed_agent_text')
    )).map(entry => entry.model_id)),
    // 视觉桥接上限：超限在调用 Registry-owned VisualEvidence 之前失败关闭。visionMaxTotalBytes 同时也是整个聊天请求体
    // (含非图片请求)的大小闸,在任何路由/许可之前生效——图片 base64 是拖垮请求体积的主因。
    visionMaxImages: Math.max(1, intEnv(env, 'GW_VISION_MAX_IMAGES', 8)),
    visionMaxImageBytes: Math.max(1, intEnv(env, 'GW_VISION_MAX_IMAGE_BYTES', 8 * 1024 * 1024)),
    visionMaxTotalBytes: Math.max(1, intEnv(env, 'GW_VISION_MAX_TOTAL_BYTES', 24 * 1024 * 1024)),
    visionTimeoutMs: capacity.mimo.visionTimeoutMs,
    visionConc: capacity.mimo.visionConcurrent,
    visionQueueMax: capacity.mimo.visionQueueMax,
    visionQueueMaxWaitMs: capacity.mimo.visionQueueMaxWaitMs,
    visionPerClientConc: capacity.mimo.visionMaxConcurrentPerUser,
    visionMaxInflightPerClient: capacity.mimo.visionMaxInflightPerUser,
    visionPerRequestConc: capacity.mimo.visionPerRequestConcurrent,
    visionCacheMax: Math.max(1, intEnv(env, 'GW_VISION_CACHE_MAX', 512)),
    visionCacheTtlMs: Math.max(1, intEnv(env, 'GW_VISION_CACHE_TTL_MS', 600_000)),
    // One bounded Gateway-owned ingress reservation spans managed Responses and
    // visual evidence. Paid image bodies now go straight to Image Relay.
    ingressInflightBodyBytes: capacity.ingress.inflightBodyBytes,
    ingressBodyReadTimeoutMs: capacity.ingress.bodyReadTimeoutMs,
    queueMaxWait: capacity.funasr.queueMaxWaitMs / 1_000,
    transcribeRpm: capacity.funasr.rpm,
    transcribeConc: capacity.funasr.maxConcurrent,
    transcribeUserConc: capacity.funasr.maxConcurrentPerUser,
    transcribeTokenConc: capacity.funasr.maxConcurrentPerToken,
    transcribeInflightPerUser: capacity.funasr.maxInflightPerUser,
    transcribeQueueMax: capacity.funasr.queueMax,
    transcribeMaxBytes: capacity.funasr.maxBytes,
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

type VerifiedInstallation = {
  principalId: string
  installationId: string
  sessionId: string
  expiresAt: number
  owner: string
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get('authorization') ?? ''
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() || undefined : undefined
}

function auth(authority: AuthAuthority, request: Request): VerifiedInstallation {
  const token = bearer(request)
  if (!token) throw new HttpError(401, 'missing_installation_access_token')
  try {
    const verified = authority.verifyAccess(token)
    return {
      principalId: verified.pid,
      installationId: verified.iid,
      sessionId: verified.sid,
      expiresAt: verified.exp,
      owner: `${verified.pid}:${verified.iid}`,
    }
  } catch (error) {
    if (error instanceof AuthError) throw new HttpError(error.status, error.code)
    throw error
  }
}

function hasInstallationAccess(authority: AuthAuthority, request: Request): boolean {
  try { auth(authority, request); return true } catch { return false }
}

async function logUsage(store: UsageStore, entry: UsageEntry): Promise<void> {
  await store.log(entry)
}

function withStreamLogging(
  resp: Response,
  onDone: () => Promise<void>,
  onChunk?: (chunk: Uint8Array) => void,
  abortSignal?: AbortSignal,
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
  let finalized = false
  const abortError = () => {
    const reason = abortSignal?.reason
    return reason instanceof Error ? reason : new Error('upstream response cancelled')
  }
  const finish = async () => {
    if (finalized) return
    finalized = true
    abortSignal?.removeEventListener('abort', abortUpstream)
    await onDone()
  }
  const abortUpstream = () => {
    void reader.cancel(abortSignal?.reason).catch(() => undefined)
  }
  if (abortSignal?.aborted) abortUpstream()
  else abortSignal?.addEventListener('abort', abortUpstream, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (abortSignal?.aborted) {
          controller.error(abortError())
          await finish()
          return
        }
        const { done, value } = await reader.read()
        if (abortSignal?.aborted) {
          controller.error(abortError())
          await finish()
          return
        }
        if (done) {
          controller.close()
          await finish()
          return
        }
        onChunk?.(value)
        controller.enqueue(value)
      } catch (error) {
        // 上游中途断流(reader.read 抛错):既有实现只在 done/cancel 调 onDone,此路径会漏放许可。
        // 显式在这里 error + 释放许可,保证任何终止路径 active/queued 都回落,不泄漏并发名额。
        controller.error(error)
        await finish()
      }
    },
    async cancel(reason) {
      // 客户端断开:释放许可。cancel body 本身失败不应吞掉许可释放。
      try { await reader.cancel(reason) } catch { /* ignore */ }
      await finish()
    },
  })
  return new Response(stream, { status: resp.status, headers })
}

type UpstreamResponseDeadline = {
  signal: AbortSignal
  timedOut(): boolean
  cleanup(): void
}

/**
 * Bun's per-request HTTP timeout is disabled for valid long SSE traffic. Keep a
 * separate provider deadline so an upstream that never answers cannot retain a
 * DeepSeek capacity permit or a fenced operation forever.
 */
function createUpstreamResponseDeadline(request: Request, timeoutMs: number): UpstreamResponseDeadline {
  const controller = new AbortController()
  let timedOut = false
  const abortForClient = () => controller.abort(request.signal.reason)
  if (request.signal.aborted) abortForClient()
  else request.signal.addEventListener('abort', abortForClient, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('upstream model response deadline exceeded'))
  }, timeoutMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  let cleaned = false
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abortForClient)
    },
  }
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

function textReasoningBodyCaps() {
  return textReasoningRegistryEntry().body_caps
}

function visualEvidenceBodyCaps() {
  return visualEvidenceRegistryEntry().body_caps
}

function imageAdviceBodyCaps() {
  return imageAdviceRegistryEntry().body_caps
}

function requireTextReasoningModel(rawBody: string): string {
  const model = parseChatModel(rawBody).trim()
  const entry = model ? textReasoningRegistryEntry(model) : undefined
  if (!entry || entry.provider !== 'deepseek') {
    throw new HttpError(400, '内置 Agent 仅支持已登记的 DeepSeek 文本模型')
  }
  if (entry.text_reasoning_transport !== 'responses') {
    throw new HttpError(409, '内置 Agent 模型不支持 Responses 协议')
  }
  return model
}

function requestedOutputUnits(rawBody: string, fallback = 0): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    // Body parsing remains owned by the provider adapter. This is only a
    // provisional quota reservation and never changes the Core request.
    return fallback
  }
  if (!isRecord(parsed)) return fallback
  const requested = parsed.max_output_tokens ?? parsed.max_tokens
  return Number.isSafeInteger(requested) && requested > 0 ? requested : fallback
}

/**
 * Before the upstream finishes, its exact input-token count is unavailable.
 * A UTF-8 request byte is a conservative upper bound for one input token, so
 * this reservation keeps a daily installation quota hard even while a long
 * SSE request is in flight. It is replaced by upstream `total_tokens` once the
 * final Responses event arrives.
 */
function reservedTextTokenUpperBound(inputBytes: number, requestedOutput: number): number {
  const total = inputBytes + requestedOutput
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new HttpError(400, 'max_output_tokens 超出受管额度范围')
  }
  return total
}

type StoredTextReasoningResult = {
  schema: 'bb.text-reasoning-result.v1'
  status: number
  content_type: string
  sse_base64: string
  actual: UsageAmount
}

type StoredImageAdviceResult = {
  schema: 'bb.image-advice-result.v1'
  response: Record<string, unknown>
  actual: UsageAmount
}

/** Persist a fully validated Qwen response before charging it.  The adapter
 * guarantees the public schema; this second check protects durable replay from
 * a malformed or partially written payload. */
function imageAdviceResultPayload(responseBody: string): { payload: string; actual: UsageAmount } {
  let response: unknown
  try { response = JSON.parse(responseBody) } catch { throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE') }
  if (!isRecord(response) || response.provider !== 'qwen' || response.model_id !== 'qwen3-vl-flash' || !isRecord(response.usage)
    || !Number.isSafeInteger(response.usage.input_bytes) || response.usage.input_bytes < 0
    || !Number.isSafeInteger(response.usage.input_tokens) || response.usage.input_tokens < 0
    || !Number.isSafeInteger(response.usage.output_tokens) || response.usage.output_tokens < 0) {
    throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
  }
  const total_tokens = response.usage.input_tokens + response.usage.output_tokens
  if (!Number.isSafeInteger(total_tokens)) throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
  const actual: UsageAmount = {
    requests: 1,
    input_bytes: response.usage.input_bytes,
    output_units: response.usage.output_tokens,
    total_tokens,
  }
  return {
    payload: JSON.stringify({ schema: 'bb.image-advice-result.v1', response, actual } satisfies StoredImageAdviceResult),
    actual,
  }
}

function parseImageAdviceResult(payload: string): StoredImageAdviceResult {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!isRecord(parsed) || parsed.schema !== 'bb.image-advice-result.v1' || !isRecord(parsed.response)) throw new Error('invalid')
    const actual = parseUsageAmount(parsed.actual)
    if (!actual) throw new Error('invalid')
    // Re-run the same response envelope validation used before persistence.
    imageAdviceResultPayload(JSON.stringify(parsed.response))
    return { schema: 'bb.image-advice-result.v1', response: parsed.response, actual }
  } catch {
    throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
  }
}

function parseUsageAmount(value: unknown): UsageAmount | undefined {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.requests) || value.requests < 0
    || !Number.isSafeInteger(value.input_bytes) || value.input_bytes < 0
    || !Number.isSafeInteger(value.output_units) || value.output_units < 0) return undefined
  // Result payloads written before the total-token migration are still safe to
  // replay. Their output count was the only model-token datum retained then.
  const totalTokens = value.total_tokens === undefined
    ? value.output_units
    : Number.isSafeInteger(value.total_tokens) && value.total_tokens >= 0
      ? value.total_tokens
      : undefined
  if (totalTokens === undefined) return undefined
  return {
    requests: value.requests,
    input_bytes: value.input_bytes,
    output_units: value.output_units,
    total_tokens: totalTokens,
  }
}

function parseStoredTextReasoningResult(payload: string): StoredTextReasoningResult {
  try {
    const parsed: unknown = JSON.parse(payload)
    const actual = isRecord(parsed) ? parseUsageAmount(parsed.actual) : undefined
    if (!isRecord(parsed)
      || parsed.schema !== 'bb.text-reasoning-result.v1'
      || !Number.isSafeInteger(parsed.status) || parsed.status < 200 || parsed.status > 299
      || typeof parsed.content_type !== 'string' || !parsed.content_type.toLowerCase().startsWith('text/event-stream')
      || typeof parsed.sse_base64 !== 'string' || !parsed.sse_base64
      || !actual) {
      throw new Error('invalid')
    }
    const bytes = Buffer.from(parsed.sse_base64, 'base64')
    if (!bytes.length || bytes.toString('base64') !== parsed.sse_base64) throw new Error('invalid')
    return {
      schema: 'bb.text-reasoning-result.v1',
      status: parsed.status,
      content_type: parsed.content_type,
      sse_base64: parsed.sse_base64,
      actual,
    }
  } catch {
    throw new GatewayOperationResultError(503, 'OPERATION_RESULT_UNAVAILABLE')
  }
}

function textReasoningResultPayload(
  response: Response,
  chunks: Uint8Array[],
  actual: UsageAmount,
): string {
  return JSON.stringify({
    schema: 'bb.text-reasoning-result.v1',
    status: response.status,
    content_type: response.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    sse_base64: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('base64'),
    actual,
  } satisfies StoredTextReasoningResult)
}

function textReasoningResultUsageObserver() {
  const decoder = new TextDecoder()
  let buffer = ''
  let outputUnits: number | undefined
  let totalTokens: number | undefined
  const observeUsage = (value: unknown) => {
    if (!isRecord(value)) return
    const envelope = isRecord(value.response) ? value.response : value
    if (!isRecord(envelope.usage)) return
    const output = envelope.usage.completion_tokens ?? envelope.usage.output_tokens
    if (Number.isSafeInteger(output) && output >= 0) outputUnits = output
    const reportedTotal = envelope.usage.total_tokens
    if (Number.isSafeInteger(reportedTotal) && reportedTotal >= 0) totalTokens = reportedTotal
    else {
      const input = envelope.usage.prompt_tokens ?? envelope.usage.input_tokens
      if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) {
        const total = input + output
        if (Number.isSafeInteger(total)) totalTokens = total
      }
    }
  }
  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try { observeUsage(JSON.parse(data)) } catch { /* provider payload parsing remains owned by the adapter */ }
        }
      }
    },
    actual(inputBytes: number, reservedOutputUnits: number, reservedTotalTokens: number): UsageAmount {
      const reportedTotal = totalTokens !== undefined && totalTokens >= (outputUnits ?? 0)
        ? totalTokens
        : undefined
      return {
        requests: 1,
        input_bytes: inputBytes,
        // The Gateway requests OpenAI-compatible usage in every managed call. If an
        // upstream breaks that contract, retain the reservation instead of guessing
        // a smaller billable result.
        output_units: outputUnits ?? reservedOutputUnits,
        total_tokens: reportedTotal ?? reservedTotalTokens,
      }
    },
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A narrow provider handler used by the managed DeepSeek Responses route and the
 * separate MiMo media-workbench route.
 * It owns authenticated capacity, rate limits, retries, SSE passthrough, redacted upstream
 * errors, and usage logging without any provider fallback.
 */
function createChatHandler(provider: ChatProvider, fetchImpl: FetchLike, store: UsageStore): ChatHandler {
  return async function chatHandler(request: Request, rawBody: string, user: string, principalId: string): Promise<Response> {
    // prepareBody 在拿容量许可之前跑,校验失败(400/503)不会漏掉一个许可名额。
    let prepared: { body: string }
    try {
      prepared = provider.prepareBody(rawBody, provider.allowedModels, provider.defaultModel)
    } catch (error) {
      if (error instanceof provider.RequestError) throw new HttpError(error.status, error.publicMessage)
      throw error
    }
    const queuedStarted = performance.now()
    let permit: CapacityPermit | undefined
    try {
      permit = await provider.capacity.acquire(user, {
        maxWaitMs: provider.queueMaxWait * 1000,
        signal: request.signal,
        tokenId: principalId,
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
    const usageNote = (attempts: number) => `queue_ms=${queueMs};attempts=${attempts}`
    const started = performance.now()
    const deadline = provider.responseTimeoutMs
      ? createUpstreamResponseDeadline(request, provider.responseTimeoutMs)
      : undefined
    try {
      const requestUpstream = async () => {
        try {
          await provider.bucket.acquire(provider.queueMaxWait, deadline?.signal ?? request.signal)
          await permit?.assertCurrent?.()
        } catch (error) {
          if (error instanceof CapacityQueueError) throw new provider.RequestError(error.status, error.publicMessage)
          throw error
        }
        return await fetchImpl(`${provider.base}/${provider.endpoint}`, {
          method: 'POST',
          body: prepared.body,
          signal: deadline?.signal ?? request.signal,
          headers: {
            Authorization: provider.authorization,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'identity',
          },
        })
      }
      const { response: upstream, attempts } = provider.fetchWithRetry
        ? await provider.fetchWithRetry(requestUpstream, {
          maxRetries: provider.retryMax ?? 0,
          baseDelayMs: provider.retryBaseMs ?? 1,
          maxDelayMs: provider.retryMaxMs ?? 1,
          signal: deadline?.signal ?? request.signal,
          sleep: provider.retrySleep,
          random: provider.retryRandom,
        })
        : { response: await requestUpstream(), attempts: 1 }

      if (!upstream.ok) {
        const upstreamDetail = await upstream.text().catch(() => '')
        deadline?.cleanup()
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
        deadline?.cleanup()
        permit?.release()
        const timedOut = deadline?.timedOut() ?? false
        await logUsage(store, {
          user,
          model: provider.label,
          ok: !timedOut,
          status: timedOut ? 504 : upstream.status,
          ms: elapsedMs(started),
          note: `${usageNote(attempts)}${timedOut ? ';upstream_timeout=1' : ''}`,
        })
      }
      return withStreamLogging(upstream, complete, undefined, deadline?.signal)
    } catch (error) {
      deadline?.cleanup()
      permit?.release()
      const timedOut = deadline?.timedOut() ?? false
      const known = error instanceof provider.RequestError
      const cancelled = request.signal.aborted
      const status = cancelled ? 499 : timedOut ? 504 : known ? error.status : 502
      const detail = cancelled ? '请求已取消' : timedOut ? '模型响应超时，请稍后重试' : known ? error.publicMessage : '模型服务暂时不可用，请稍后重试'
      await logUsage(store, {
        user,
        model: provider.label,
        ok: false,
        status,
        ms: elapsedMs(started),
        note: `queue_ms=${queueMs};upstream_request_failed${timedOut ? ';upstream_timeout=1' : ''}`,
      })
      throw new HttpError(status, detail)
    }
  }
}

export function createGatewayFetch(deps: GatewayDeps = {}) {
  const env = deps.env ?? process.env
  const config = loadConfig(env)
  const capacityPolicy = loadCapacityPolicy(env)
  const providerCredentials = loadGatewayProviderCredentials(env)
  const hasAnyServiceCredential = Boolean(
    env.GW_IMAGE_RELAY_INTROSPECTION_TOKEN?.trim()
    || env.GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN?.trim(),
  )
  const serviceCredentials = hasAnyServiceCredential
    ? loadGatewayServiceCredentials(env)
    : null
  const authority = deps.authority ?? createAuthorityFromEnv(env)
  const fetchImpl = deps.fetchImpl ?? fetch
  const store = deps.usageStore ?? new SqliteUsageStore(config.db)
  const usageBudget = deps.usageBudgetService
    ?? new SqliteUsageBudgetService(
      deps.usageStore ? ':memory:' : config.db,
      gatewayUsagePolicyFromEnvironment(env),
    )
  const operationResults = deps.operationResultStore
    ?? new SqliteGatewayOperationResultStore(deps.usageStore ? ':memory:' : config.db)
  const capacityBackend = (deps.capacityBackendFactory ?? localGatewayCapacityBackendFactory).create({
    mimo: {
      scope: capacityPolicy.mimo.scope,
      reservations: {
        maxConcurrent: config.mimoConc,
        mediaConcurrent: config.mimoMediaConc,
        visionConcurrent: config.visionConc,
        maxConcurrentPerUser: config.mimoUserConc,
        maxConcurrentPerToken: config.mimoTokenConc,
        maxInflightPerUser: config.mimoInflightPerUser,
        mediaQueueMax: config.mimoQueueMax,
        visionQueueMax: config.visionQueueMax,
        visionMaxConcurrentPerUser: config.visionPerClientConc,
        visionMaxInflightPerUser: config.visionMaxInflightPerClient,
      },
      rate: { rpm: config.mimoRpm, queueMax: config.mimoQueueMax + config.visionQueueMax },
    },
    deepseek: {
      scope: capacityPolicy.deepseek.scope,
      capacity: {
        maxConcurrent: config.deepseekConc,
        maxConcurrentPerUser: config.deepseekUserConc,
        maxConcurrentPerToken: config.deepseekTokenConc,
        queueMax: config.deepseekQueueMax,
        maxInflightPerUser: config.deepseekInflightPerUser,
      },
      rate: { rpm: config.deepseekRpm, queueMax: config.deepseekQueueMax },
    },
    qwen: {
      scope: capacityPolicy.qwen.scope,
      capacity: {
        maxConcurrent: config.qwenConc,
        maxConcurrentPerUser: config.qwenUserConc,
        maxConcurrentPerToken: config.qwenTokenConc,
        queueMax: config.qwenQueueMax,
        maxInflightPerUser: config.qwenInflightPerUser,
      },
      rate: { rpm: config.qwenRpm, queueMax: config.qwenQueueMax },
    },
    transcription: {
      scope: capacityPolicy.funasr.scope,
      capacity: {
        maxConcurrent: config.transcribeConc,
        maxConcurrentPerUser: config.transcribeUserConc,
        maxConcurrentPerToken: config.transcribeTokenConc,
        queueMax: config.transcribeQueueMax,
        maxInflightPerUser: config.transcribeInflightPerUser,
      },
      rate: { rpm: config.transcribeRpm, queueMax: config.transcribeQueueMax },
    },
    bootstrap: { scope: capacityPolicy.bootstrap.scope, rate: { rpm: config.bootstrapRpm, queueMax: config.bootstrapQueueMax } },
    ingress: { scope: capacityPolicy.ingress.scope },
  })
  const mimoBucket = capacityBackend.rates.mimo
  const mimoReservations = capacityBackend.mimo
  const deepseekBucket = capacityBackend.rates.deepseek
  const deepseekCapacity = capacityBackend.deepseek
  const deepseekAuthorization = providerCredentials.bearerAuthorization('deepseek')
  const deepseekProvider: ChatProvider | null = deepseekAuthorization
    ? {
      label: 'deepseek',
      base: providerCredentials.baseUrl('deepseek'),
      authorization: deepseekAuthorization,
      endpoint: 'responses',
      defaultModel: config.deepseekModel,
      allowedModels: config.deepseekAllowedModels,
      bucket: deepseekBucket,
      capacity: deepseekCapacity,
      queueMaxWait: config.deepseekQueueMaxWait,
      responseTimeoutMs: config.deepseekResponseTimeoutMs,
      prepareBody: prepareManagedResponsesBody,
      RequestError: ManagedResponsesRequestError,
    }
    : null
  const managedText: ChatHandler | null = deepseekProvider
    ? createChatHandler(deepseekProvider, fetchImpl, store)
    : null
  // The registry-selected VisualEvidence provider is available only with its server key.
  // Missing credentials make image requests fail closed rather than reaching TextReasoning.
  const mimoAuthorization = providerCredentials.bearerAuthorization('mimo')
  const visionBridge: VisionBridge | null = mimoAuthorization
    ? createVisionBridge({
      providerBase: providerCredentials.baseUrl('mimo'),
      providerAuthorization: mimoAuthorization,
      modelId: visualEvidenceRegistryEntry().model_id,
      fetchImpl,
      mimoReservations,
      mimoRateLimiter: mimoBucket,
      // Keep a vision call's RPM wait inside its stricter three-second queue budget
      // instead of extending it to the retained account setting's five-second allowance.
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
  const mimoMediaProvider: ChatProvider | null = mimoAuthorization
    ? {
      label: 'mimo',
      base: providerCredentials.baseUrl('mimo'),
      authorization: mimoAuthorization,
      endpoint: 'chat/completions',
      defaultModel: mediaReasoningRegistryEntry().model_id,
      allowedModels: new Set([mediaReasoningRegistryEntry().model_id]),
      bucket: mimoBucket,
      capacity: mimoReservations.forLane('media'),
      queueMaxWait: config.mimoQueueMaxWait,
      retryMax: config.mimoRetryMax,
      retryBaseMs: config.mimoRetryBaseMs,
      retryMaxMs: config.mimoRetryMaxMs,
      prepareBody: prepareMimoChatBody,
      fetchWithRetry: fetchMimoWithRetry,
      RequestError: MimoRequestError,
    }
    : null
  const mimoMediaReasoning: ChatHandler | null = mimoMediaProvider
    ? createChatHandler(mimoMediaProvider, fetchImpl, store)
    : null
  // Qwen image advice deliberately owns a different physical-account scheduler,
  // rate bucket and quota lane. It must never borrow MiMo's generic visual work.
  const qwenBucket = capacityBackend.rates.qwen
  const qwenCapacity = capacityBackend.qwen
  const qwenAuthorization = config.qwenEnabled ? providerCredentials.bearerAuthorization('qwen') : undefined
  const ingressBodyBudget = new InflightByteBudget(config.ingressInflightBodyBytes, '请求较多，请稍后重试')
  const transcribeBucket = capacityBackend.rates.transcription
  const bootstrapBucket = capacityBackend.rates.bootstrap
  const transcribeCapacity = capacityBackend.transcription
  const transcribe = deps.transcribeImpl === undefined
    ? createGatewayTranscriber(env, providerCredentials)
    : deps.transcribeImpl

  function reserveMetered(
    identity: VerifiedInstallation,
    capability: MeteredCapability,
    accountKey: string,
    operationId: string,
    fingerprint: string,
    amount: UsageAmount,
  ): UsageReceipt {
    try {
      const reservation = usageBudget.reserve({
        operation_id: operationId,
        principal_id: identity.principalId,
        installation_id: identity.installationId,
        capability,
        account_key: accountKey,
        fingerprint,
        amount,
      })
      if (reservation.duplicate) throw new HttpError(409, 'OPERATION_ALREADY_RESERVED')
      return reservation.receipt
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (error instanceof UsageBudgetError) throw new HttpError(error.status, error.code)
      throw new HttpError(503, 'BUDGET_UNAVAILABLE')
    }
  }

  function completeMetered(receipt: UsageReceipt, outcome: 'settled' | 'released' | 'outcome_unknown', actual = receipt.reserved): void {
    if (outcome === 'settled') usageBudget.settle(receipt.operation_id, receipt.fencing_token, actual)
    else if (outcome === 'released') usageBudget.release(receipt.operation_id, receipt.fencing_token)
    else usageBudget.markOutcomeUnknown(receipt.operation_id, receipt.fencing_token)
  }

  function meteredFailure(receipt: UsageReceipt, status: number): void {
    completeMetered(receipt, status === 499 || status >= 500 ? 'outcome_unknown' : 'released')
  }

  function operationResultFailure(error: unknown): never {
    if (error instanceof GatewayOperationResultError) throw new HttpError(error.status, error.code)
    throw new HttpError(503, 'OPERATION_RESULT_UNAVAILABLE')
  }

  function textReasoningBinding(identity: VerifiedInstallation, operationId: string, rawBody: string): GatewayOperationResultBinding {
    return {
      principal_id: identity.principalId,
      installation_id: identity.installationId,
      operation_id: operationId,
      capability: 'TextReasoning',
      fingerprint: usageFingerprint(`TextReasoning\0${rawBody}`),
    }
  }

  function reserveReplayableTextUsage(
    identity: VerifiedInstallation,
    operationId: string,
    fingerprint: string,
    inputBytes: number,
    requestedOutput: number,
  ): { receipt: UsageReceipt; duplicate: boolean } {
    try {
      return usageBudget.reserve({
        operation_id: `${operationId}:text`,
        principal_id: identity.principalId,
        installation_id: identity.installationId,
        capability: 'TextReasoning',
        account_key: capacityPolicy.deepseek.account_key,
        fingerprint,
        amount: {
          requests: 1,
          input_bytes: inputBytes,
          output_units: requestedOutput,
          total_tokens: reservedTextTokenUpperBound(inputBytes, requestedOutput),
        },
      })
    } catch (error) {
      if (error instanceof UsageBudgetError) throw new HttpError(error.status, error.code)
      throw new HttpError(503, 'BUDGET_UNAVAILABLE')
    }
  }

  function withTextReasoningResultHeaders(response: Response, binding: GatewayOperationResultBinding): Response {
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    headers.set('X-BB-Usage-Operation', binding.operation_id)
    headers.set(PROVIDER_OPERATION_RESULT_ID_HEADER, binding.operation_id)
    headers.set(PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER, binding.capability)
    headers.set(PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER, binding.fingerprint)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  function replayTextReasoningResult(
    binding: GatewayOperationResultBinding,
    payload: string,
    usageReceipt: UsageReceipt,
  ): Response {
    const stored = parseStoredTextReasoningResult(payload)
    try {
      completeMetered(usageReceipt, 'settled', stored.actual)
    } catch {
      // The result is already durable. Do not invoke an upstream a second time while
      // the quota ledger is unavailable; surface a retryable ledger failure instead.
      throw new HttpError(503, 'BUDGET_UNAVAILABLE')
    }
    return withTextReasoningResultHeaders(new Response(Buffer.from(stored.sse_base64, 'base64'), {
      status: stored.status,
      headers: { 'Content-Type': stored.content_type },
    }), binding)
  }

  function streamTextReasoningResult(
    response: Response,
    binding: GatewayOperationResultBinding,
    fencingToken: number,
    usageReceipt: UsageReceipt,
  ): Response {
    if (!response.body) {
      try { operationResults.markOutcomeUnknown(binding, fencingToken) } catch {}
      try { completeMetered(usageReceipt, 'outcome_unknown') } catch {}
      throw new HttpError(502, 'MODEL_RESPONSE_STREAM_MISSING')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    const usage = textReasoningResultUsageObserver()
    let resultStored = false
    let terminal = false
    const markUnknown = () => {
      if (terminal || resultStored) return
      terminal = true
      try { operationResults.markOutcomeUnknown(binding, fencingToken) } catch {}
      try { completeMetered(usageReceipt, 'outcome_unknown') } catch {}
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (!done) {
            chunks.push(value)
            usage.push(value)
            controller.enqueue(value)
            return
          }
          const actual = usage.actual(
            usageReceipt.reserved.input_bytes,
            usageReceipt.reserved.output_units,
            usageReceipt.reserved.total_tokens,
          )
          operationResults.complete(binding, fencingToken, textReasoningResultPayload(response, chunks, actual), { awaitingConsumerAck: true })
          resultStored = true
          // Persist the replayable result before charging the exact streamed output.
          // A ledger outage now fails closed and can only be recovered by replaying
          // this same operation; it never triggers another provider request.
          completeMetered(usageReceipt, 'settled', actual)
          terminal = true
          controller.close()
        } catch (error) {
          markUnknown()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason) } catch {}
        markUnknown()
      },
    })
    return withTextReasoningResultHeaders(new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }), binding)
  }

  function withUsageOperationHeader(response: Response, operationId: string): Response {
    const headers = new Headers(response.headers)
    headers.set('X-BB-Usage-Operation', operationId)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  async function runMeteredStream(receipt: UsageReceipt, operationId: string, action: () => Promise<Response>): Promise<Response> {
    try {
      const response = await action()
      if (!response.ok) {
        meteredFailure(receipt, response.status)
        return withUsageOperationHeader(response, operationId)
      }
      return withUsageOperationHeader(withStreamLogging(response, async () => {
        completeMetered(receipt, 'settled')
      }), operationId)
    } catch (error) {
      const status = error instanceof HttpError || error instanceof CapacityQueueError || error instanceof ManagedResponsesRequestError
        ? error.status
        : 500
      meteredFailure(receipt, status)
      throw error
    }
  }

  async function fetchHandler(request: Request, server?: RequestTimeoutController): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        if (!hasInstallationAccess(authority, request)) return jsonResponse({ ok: true, component_manifest: COMPONENT_MANIFEST })
        const identity = auth(authority, request)
        const mimo = mimoReservations.snapshot()
        const mediaMimo = mimoReservations.laneSnapshot('media')
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
          component_manifest: COMPONENT_MANIFEST,
          limits: {
            mimo_rpm: config.mimoRpm,
            mimo_conc: config.mimoConc,
            mimo_media_conc: config.mimoMediaConc,
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
            qwen_rpm: config.qwenRpm,
            qwen_conc: config.qwenConc,
            qwen_user_conc: config.qwenUserConc,
            qwen_token_conc: config.qwenTokenConc,
            qwen_queue_max: config.qwenQueueMax,
            qwen_queue_max_wait_seconds: config.qwenQueueMaxWait,
            vision_conc: config.visionConc,
            vision_queue_max: config.visionQueueMax,
            vision_queue_max_wait_ms: config.visionQueueMaxWaitMs,
            vision_per_client_conc: config.visionPerClientConc,
            vision_max_inflight_per_client: config.visionMaxInflightPerClient,
            vision_per_request_conc: config.visionPerRequestConc,
            ingress_inflight_body_bytes: config.ingressInflightBodyBytes,
            ingress_body_read_timeout_ms: config.ingressBodyReadTimeoutMs,
            transcribe_rpm: config.transcribeRpm,
            transcribe_conc: config.transcribeConc,
            transcribe_queue_max: config.transcribeQueueMax,
          },
          // Kept for old clients that already read this field; the authoritative policy is below.
          quota: {},
          usage_budget: {
            policy_revision: usageBudget.policyRevision(),
            metered_capabilities: ['TextReasoning', 'VisualEvidence', 'MediaReasoning', 'ImageAdvice', 'SpeechTranscription'],
            managed_agent_installation_daily_total_tokens: MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT,
          },
          usage_summary: usageBudget.summary(identity.principalId, identity.installationId),
          governance: {
            model_catalog_contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
            capacity_profile: 'small-v1',
            capacity_policy: capacityPolicy,
            quota_policy_revision: usageBudget.policyRevision(),
            provider_credentials: providerCredentials.toJSON(),
            service_credentials: serviceCredentials?.toJSON() ?? { services: [] },
          },
          capacity: {
            // `mimo` is the account aggregate; each product contract also exposes its
            // own reservation so overload and starvation are attributable.
            mimo: {
              ...mimo,
              mediaReserved: config.mimoMediaConc,
              visionReserved: config.visionConc,
            },
            mimo_media: mediaMimo,
            // Explicit alias for dashboards that want to distinguish the historic
            // `mimo` name from the aggregate physical-account view.
            mimo_total: {
              ...mimo,
              mediaReserved: config.mimoMediaConc,
              visionReserved: config.visionConc,
            },
            deepseek: deepseekCapacity.snapshot(),
            qwen: qwenCapacity.snapshot(),
            vision,
            transcription: transcribeCapacity.snapshot(),
            ingress_body: ingressBodyBudget.snapshot(),
          },
          features: {
            transcription: transcribe !== null,
            managed_text: managedText !== null,
            vision_bridge: visionBridge !== null,
            image_advice: qwenAuthorization !== undefined,
            relay_identity_introspection: serviceCredentials !== null,
          },
        })
      }

      // Relays call this private route only to turn one short-lived desktop bearer
      // into an authoritative scheduling owner. Gateway never proxies paid image or
      // video payloads, status polls, results, cancellation, or acknowledgements.
      if (request.method === 'POST' && url.pathname === SERVICE_INTROSPECTION_PATH) {
        const audienceValue = request.headers.get(SERVICE_INTROSPECTION_AUDIENCE_HEADER)?.trim() ?? ''
        if (!isServiceIntrospectionAudience(audienceValue)) {
          throw new HttpError(403, 'invalid_service_audience')
        }
        const serviceToken = request.headers.get(SERVICE_INTROSPECTION_TOKEN_HEADER)?.trim()
        if (!serviceCredentials?.verify(audienceValue, serviceToken)) {
          throw new HttpError(403, 'invalid_service_credential')
        }
        const token = bearer(request)
        if (!token) throw new HttpError(401, 'missing_installation_access_token')
        try {
          const verified = authority.verifyAccess(token)
          return jsonResponse({
            active: true,
            principal_id: verified.pid,
            installation_id: verified.iid,
            session_id: verified.sid,
            expires_at: verified.exp,
            owner: `${verified.pid}:${verified.iid}`,
          }, { headers: { 'Cache-Control': 'no-store' } })
        } catch (error) {
          if (error instanceof AuthError) throw new HttpError(error.status, error.code)
          throw error
        }
      }

      if (request.method === 'POST' && (url.pathname === '/v1/auth/bootstrap' || url.pathname === '/v1/auth/refresh' || url.pathname === '/v1/auth/logout')) {
        const contentType = request.headers.get('content-type')
        if (!contentType || !isJsonContentType(contentType)) throw new HttpError(415, 'auth_content_type_required')
        const rawBody = await readRequestBodyBounded(request, 4096, undefined, 5_000)
        let body: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(rawBody)
          if (!isRecord(parsed)) throw new Error('not object')
          body = parsed
        } catch { throw new HttpError(400, 'invalid_auth_body') }
        if (url.pathname === '/v1/auth/bootstrap') {
          await bootstrapBucket.acquire(config.bootstrapQueueMaxWait, request.signal)
          const installationId = typeof body.installation_id === 'string' ? body.installation_id : ''
          try { return jsonResponse(authTokensResponse(authority.bootstrap(installationId))) }
          catch (error) { if (error instanceof AuthError) throw new HttpError(error.status, error.code); throw error }
        }
        if (url.pathname === '/v1/auth/refresh') {
          const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : ''
          try { return jsonResponse(authTokensResponse(authority.refresh(refreshToken))) }
          catch (error) { if (error instanceof AuthError) throw new HttpError(error.status, error.code); throw error }
        }
        const access = bearer(request)
        const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : undefined
        if (!access && !refreshToken) throw new HttpError(401, 'missing_session_proof')
        try { authority.logout(access, refreshToken); return new Response(null, { status: 204 }) }
        catch (error) { if (error instanceof AuthError) throw new HttpError(error.status, error.code); throw error }
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

      // 目录只投影 registry 中用户可选的 TextReasoning capability。
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        auth(authority, request)
        const data = PROVIDER_REGISTRY
          .filter(entry => entry.provider === 'deepseek'
            && entry.capabilities.includes('TextReasoning')
            && entry.text_reasoning_transport === 'responses')
          .map(entry => ({ id: entry.model_id, object: 'model' as const, created: 0, owned_by: entry.provider }))
        return jsonResponse({ object: 'list', data })
      }

      if (request.method === 'POST' && url.pathname === PROVIDER_OPERATION_ACK_PATH) {
        const identity = auth(authority, request)
        requireProviderProtocol(request)
        const binding: GatewayOperationResultBinding = {
          principal_id: identity.principalId,
          installation_id: identity.installationId,
          operation_id: request.headers.get(PROVIDER_OPERATION_RESULT_ID_HEADER)?.trim() ?? '',
          capability: request.headers.get(PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER)?.trim() as GatewayOperationResultBinding['capability'],
          fingerprint: request.headers.get(PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER)?.trim() ?? '',
        }
        if (binding.capability !== 'TextReasoning' && binding.capability !== 'ImageAdvice') {
          throw new HttpError(400, 'OPERATION_ACK_CAPABILITY_UNSUPPORTED')
        }
        try {
          const acknowledgement = operationResults.acknowledge(binding)
          if (acknowledgement === 'in_progress') throw new HttpError(409, 'OPERATION_IN_PROGRESS')
          if (acknowledgement === 'outcome_unknown') throw new HttpError(409, 'OPERATION_OUTCOME_UNKNOWN')
          return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
        } catch (error) {
          if (error instanceof HttpError) throw error
          operationResultFailure(error)
        }
      }

      // Media workbenches use MiMo V2.5 directly for visual understanding and
      // evidence-based planning. This route is intentionally separate from Agent
      // chat, which is owned exclusively by managed DeepSeek Responses.
      if (request.method === 'POST' && url.pathname === '/v1/media/reasoning') {
        const identity = auth(authority, request)
        requireProviderProtocol(request)
        const usageOperation = usageOperationId(request)
        server?.timeout(request, 0)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '媒体理解请求需要 JSON')
        return await withBufferedBodyReservation(
          request,
          visualEvidenceBodyCaps().VISION_BODY_MAX_BYTES,
          ingressBodyBudget,
          config.ingressBodyReadTimeoutMs,
          async rawBody => {
            if (!mimoMediaReasoning) throw new HttpError(503, 'MiMo 媒体理解服务未配置')
            const inputBytes = Buffer.byteLength(rawBody, 'utf8')
            const receipt = reserveMetered(
              identity,
              'MediaReasoning',
              capacityPolicy.mimo.account_key,
              `${usageOperation}:media`,
              usageFingerprint(`MediaReasoning\0${rawBody}`),
              {
                requests: 1,
                input_bytes: inputBytes,
                output_units: requestedOutputUnits(rawBody, 4_096),
                total_tokens: 0,
              },
            )
            return await runMeteredStream(
              receipt,
              usageOperation,
              () => mimoMediaReasoning(request, rawBody, identity.owner, identity.principalId),
            )
          },
        )
      }

      // Image Workbench gets a separate, schema-locked Qwen advice boundary.
      // It is intentionally not a generic media route and never grants the model
      // project-write authority or a path to paid image generation.
      if (request.method === 'POST' && url.pathname === '/v1/image/reasoning') {
        const identity = auth(authority, request)
        requireProviderProtocol(request)
        const usageOperation = usageOperationId(request)
        server?.timeout(request, 0)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '图片理解请求需要 JSON')
        return await withBufferedBodyReservation(
          request,
          imageAdviceBodyCaps().VISION_BODY_MAX_BYTES,
          ingressBodyBudget,
          config.ingressBodyReadTimeoutMs,
          async rawBody => {
            if (!qwenAuthorization) throw new HttpError(503, 'Qwen 图片理解服务未配置')
            const binding: GatewayOperationResultBinding = {
              principal_id: identity.principalId,
              installation_id: identity.installationId,
              operation_id: usageOperation,
              capability: 'ImageAdvice',
              fingerprint: usageFingerprint(`ImageAdvice\0${rawBody}`),
            }
            let operation: ReturnType<GatewayOperationResultStore['begin']>
            try { operation = operationResults.begin(binding, { awaitingConsumerAck: true }) }
            catch (error) { operationResultFailure(error) }
            if (operation.outcome === 'in_progress') throw new HttpError(409, 'OPERATION_IN_PROGRESS')
            if (operation.outcome === 'outcome_unknown') throw new HttpError(409, 'OPERATION_OUTCOME_UNKNOWN')
            let reservation: { receipt: UsageReceipt; duplicate: boolean }
            try {
              const inputBytes = Buffer.byteLength(rawBody, 'utf8')
              reservation = usageBudget.reserve({
                operation_id: `${usageOperation}:image-advice`,
                principal_id: identity.principalId,
                installation_id: identity.installationId,
                capability: 'ImageAdvice',
                account_key: capacityPolicy.qwen.account_key,
                fingerprint: binding.fingerprint,
                // Provider input tokens are unavailable pre-call. UTF-8 request bytes
                // are a conservative token ceiling for this bounded JSON/data-URL
                // contract, so the reservation covers input plus max output before
                // any paid call. Settlement later replaces it with provider usage.
                amount: { requests: 1, input_bytes: inputBytes, output_units: 2_000, total_tokens: inputBytes + 2_000 },
              })
            } catch (error) {
              if (operation.outcome === 'started') {
                try { operationResults.release(binding, operation.fencing_token) } catch {}
              }
              if (error instanceof UsageBudgetError) throw new HttpError(error.status, error.code)
              throw new HttpError(503, 'BUDGET_UNAVAILABLE')
            }
            if (operation.outcome === 'started' && reservation.duplicate) {
              try { operationResults.release(binding, operation.fencing_token) } catch {}
              throw new HttpError(409, 'OPERATION_USAGE_CONFLICT')
            }
            const withResultHeaders = (response: Response): Response => {
              const headers = new Headers(response.headers)
              headers.set('Cache-Control', 'no-store')
              headers.set('X-BB-Usage-Operation', usageOperation)
              headers.set(PROVIDER_OPERATION_RESULT_ID_HEADER, binding.operation_id)
              headers.set(PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER, binding.capability)
              headers.set(PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER, binding.fingerprint)
              return new Response(response.body, { status: response.status, headers })
            }
            const settleStored = (payload: string): Response => {
              const stored = parseImageAdviceResult(payload)
              try { completeMetered(reservation.receipt, 'settled', stored.actual) }
              catch { throw new HttpError(503, 'BUDGET_UNAVAILABLE') }
              return withResultHeaders(Response.json(stored.response))
            }
            if (operation.outcome === 'succeeded') return settleStored(operation.payload)

            let permit: CapacityPermit | undefined
            try {
              permit = await qwenCapacity.acquire(identity.owner, {
                maxWaitMs: config.qwenQueueMaxWait * 1_000,
                signal: request.signal,
                tokenId: identity.principalId,
              })
              await qwenBucket.acquire(config.qwenQueueMaxWait, request.signal)
              await permit.assertCurrent?.()
              const response = await requestQwenImageReasoning(rawBody, {
                baseUrl: providerCredentials.baseUrl('qwen'),
                providerAuthorization: qwenAuthorization,
                modelId: imageAdviceRegistryEntry().model_id,
                fetchImpl,
                signal: request.signal,
                timeoutMs: config.qwenResponseTimeoutMs,
                assertCurrent: () => permit?.assertCurrent?.(),
              })
              const responseBody = await response.text()
              const stored = imageAdviceResultPayload(responseBody)
              // The result first becomes replayable, then the ledger settles it.
              operationResults.complete(binding, operation.fencing_token, stored.payload, { awaitingConsumerAck: true })
              completeMetered(reservation.receipt, 'settled', stored.actual)
              return withResultHeaders(new Response(responseBody, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }))
            } catch (error) {
              const status = error instanceof HttpError || error instanceof CapacityQueueError || error instanceof QwenImageReasoningGatewayError
                ? error.status
                : request.signal.aborted ? 499 : 503
              try { completeMetered(reservation.receipt, status === 499 || status >= 500 ? 'outcome_unknown' : 'released') } catch {}
              try {
                if (status === 499 || status >= 500) operationResults.markOutcomeUnknown(binding, operation.fencing_token)
                else operationResults.release(binding, operation.fencing_token)
              } catch {}
              if (error instanceof QwenImageReasoningGatewayError) throw new HttpError(error.status, error.publicMessage)
              if (error instanceof HttpError || error instanceof CapacityQueueError) throw error
              throw new HttpError(status, 'Qwen 图片理解服务暂时不可用')
            } finally {
              permit?.release()
            }
          },
        )
      }

      // Product workbenches request provider-neutral, question-independent visual
      // evidence here. The Host binds the returned items to source IDs and time
      // ranges; image bytes and provider credentials never enter a model planner.
      if (request.method === 'POST' && url.pathname === '/v1/visual/evidence') {
        const identity = auth(authority, request)
        requireProviderProtocol(request)
        const usageOperation = usageOperationId(request)
        server?.timeout(request, 0)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '视觉证据请求需要 JSON')
        return await withBufferedBodyReservation(
          request,
          visualEvidenceBodyCaps().VISION_BODY_MAX_BYTES,
          ingressBodyBudget,
          config.ingressBodyReadTimeoutMs,
          async rawBody => {
            if (!visionBridge) throw new HttpError(503, '视觉证据服务未配置')
            if (!containsImageContent(rawBody)) throw new HttpError(400, '视觉证据请求缺少图片')
            const inputBytes = Buffer.byteLength(rawBody, 'utf8')
            const receipt = reserveMetered(
              identity,
              'VisualEvidence',
              capacityPolicy.mimo.account_key,
              `${usageOperation}:vision`,
              usageFingerprint(`VisualEvidence\0${rawBody}`),
              { requests: 1, input_bytes: inputBytes, output_units: 4_096, total_tokens: 0 },
            )
            return await runMeteredStream(receipt, usageOperation, async () => {
              const result = await visionBridge.transform(rawBody, {
                signal: request.signal,
                schedulerId: identity.owner,
                tokenId: identity.principalId,
              })
              return jsonResponse({
                schema: 'bb.visual-evidence-batch.v1',
                evidence: result.evidence,
                metrics: result.metrics,
              }, { headers: { 'Cache-Control': 'no-store' } })
            })
          },
        )
      }

      if (request.method === 'POST' && url.pathname === '/v1/responses') {
        const identity = auth(authority, request)
        requireProviderProtocol(request)
        const user = identity.owner
        const usageOperation = usageOperationId(request)
        // Long DeepSeek queues and quiet SSE streams are valid product behavior. Set
        // this before buffering so Bun's 10 s default cannot sever it.
        server?.timeout(request, 0)
        const contentType = request.headers.get('content-type')
        if (contentType && !isJsonContentType(contentType)) throw new HttpError(415, '模型请求需要 JSON')
        // 请求体大小闸在任何路由、解析或许可之前生效；Responses 只接收本机
        // 运行时构造的无上游续接请求。
        return await withBufferedBodyReservation(request, textReasoningBodyCaps().CHAT_TEXT_BODY_MAX_BYTES, ingressBodyBudget, config.ingressBodyReadTimeoutMs, async rawBody => {
          requireTextReasoningModel(rawBody)
          if (!managedText) throw new HttpError(503, '托管文本模型服务未配置')
          const inputBytes = Buffer.byteLength(rawBody, 'utf8')
          const requestedOutput = requestedOutputUnits(rawBody)
          const binding = textReasoningBinding(identity, usageOperation, rawBody)
          let operation: ReturnType<GatewayOperationResultStore['begin']>
          try {
            // An unknown operation intentionally remains fenced. This endpoint never
            // turns an interrupted model call into a second upstream request; an
            // explicit recovery policy can be added only with a matching usage-attempt
            // ledger in a later R3 unit.
            operation = operationResults.begin(binding, { awaitingConsumerAck: true })
          } catch (error) {
            operationResultFailure(error)
          }
          if (operation.outcome === 'in_progress') throw new HttpError(409, 'OPERATION_IN_PROGRESS')
          if (operation.outcome === 'outcome_unknown') throw new HttpError(409, 'OPERATION_OUTCOME_UNKNOWN')
          let textReservation: { receipt: UsageReceipt; duplicate: boolean }
          try {
            textReservation = reserveReplayableTextUsage(
              identity,
              usageOperation,
              binding.fingerprint,
              inputBytes,
              requestedOutput,
            )
          } catch (error) {
            if (operation.outcome === 'started') {
              try { operationResults.release(binding, operation.fencing_token) } catch {}
            }
            throw error
          }
          if (operation.outcome === 'started' && textReservation.duplicate) {
            // Result retention may end before the immutable usage ledger. Do not let
            // a recycled operation id turn that old receipt into a free new provider
            // request; callers must use a new user-visible operation instead.
            try { operationResults.release(binding, operation.fencing_token) } catch {}
            throw new HttpError(409, 'OPERATION_USAGE_CONFLICT')
          }
          const textReceipt = textReservation.receipt
          if (operation.outcome === 'succeeded') {
            try {
              return replayTextReasoningResult(binding, operation.payload, textReceipt)
            } catch (error) {
              if (error instanceof HttpError) throw error
              operationResultFailure(error)
            }
          }
          const releaseTextOperation = () => {
            try { operationResults.release(binding, operation.fencing_token) } catch {}
          }
          try {
            const response = await managedText(request, rawBody, user, identity.principalId)
            if (!response.ok) {
              meteredFailure(textReceipt, response.status)
              if (response.status === 499 || response.status >= 500) {
                try { operationResults.markOutcomeUnknown(binding, operation.fencing_token) } catch {}
              } else {
                releaseTextOperation()
              }
              return withUsageOperationHeader(response, usageOperation)
            }
            return streamTextReasoningResult(response, binding, operation.fencing_token, textReceipt)
          } catch (error) {
            const status = error instanceof HttpError || error instanceof CapacityQueueError || error instanceof ManagedResponsesRequestError
              ? error.status
              : 500
            meteredFailure(textReceipt, status)
            if (status === 499 || status >= 500) {
              try { operationResults.markOutcomeUnknown(binding, operation.fencing_token) } catch {}
            } else {
              releaseTextOperation()
            }
            throw error
          }
        })
      }

      if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
        const identity = auth(authority, request)
        requireProviderProtocol(request)
        server?.timeout(request, 0)
        const user = identity.owner
        const usageOperation = usageOperationId(request)
        if (!transcribe) throw new HttpError(503, '语音识别服务暂不可用')
        const contentType = request.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new HttpError(415, '需要上传音频文件')
        const declaredSize = Number(request.headers.get('content-length') ?? '')
        if (Number.isFinite(declaredSize) && declaredSize > config.transcribeMaxBytes + 1024 * 1024) {
          throw new HttpError(413, '音频文件过大')
        }
        const form = await request.formData().catch(() => null)
        const file = form?.get('file')
        if (!(file instanceof File) || file.size === 0) throw new HttpError(400, '没有收到音频文件')
        if (file.size > config.transcribeMaxBytes) throw new HttpError(413, '音频文件过大')
        if (!supportedAudio(file)) throw new HttpError(415, '不支持这种音频格式')
        const languageRaw = String(form?.get('language') ?? 'zh').trim().toLowerCase()
        const language = /^[a-z]{2,8}$/.test(languageRaw) ? languageRaw : 'zh'
        const formatRaw = String(form?.get('response_format') ?? 'json')
        const responseFormat = formatRaw === 'verbose_json' ? 'verbose_json' : 'json'
        const receipt = reserveMetered(
          identity,
          'SpeechTranscription',
          capacityPolicy.funasr.account_key,
          `${usageOperation}:speech`,
          usageFingerprint(`SpeechTranscription\0${await fileUsageFingerprint(file)}\0${language}\0${responseFormat}`),
          { requests: 1, input_bytes: file.size, output_units: 0, total_tokens: 0 },
        )
        const started = performance.now()
        const capacityPermit = await transcribeCapacity.acquire(user, {
          maxWaitMs: config.queueMaxWait * 1_000,
          signal: request.signal,
          tokenId: identity.principalId,
        }).catch(error => {
          completeMetered(receipt, 'released')
          throw error
        })
        try {
          try {
            await transcribeBucket.acquire(config.queueMaxWait, request.signal)
            await capacityPermit.assertCurrent?.()
          } catch (error) {
            completeMetered(receipt, 'released')
            throw error
          }
          const queueMs = elapsedMs(started)
          const runStarted = performance.now()
          try {
            const result = await transcribe(file, {
              language,
              responseFormat,
              signal: request.signal,
              assertCurrent: () => capacityPermit.assertCurrent?.(),
            })
            const audioSeconds = Number(result.duration)
            completeMetered(receipt, 'settled', {
              requests: 1,
              input_bytes: file.size,
              output_units: Number.isFinite(audioSeconds) && audioSeconds >= 0 ? Math.round(audioSeconds * 1_000) : 0,
              total_tokens: 0,
            })
            const note = [
              `queue_ms=${queueMs}`,
              `run_ms=${elapsedMs(runStarted)}`,
              `bytes=${file.size}`,
              ...(Number.isFinite(audioSeconds) && audioSeconds >= 0 ? [`audio_seconds=${Math.round(audioSeconds * 1000) / 1000}`] : []),
            ].join(';')
            await logUsage(store, { user, model: 'transcribe', ok: true, status: 200, ms: elapsedMs(started), note })
            return withUsageOperationHeader(jsonResponse(result), usageOperation)
          } catch (error) {
            const status = error instanceof GatewayTranscriptionError ? error.status : 502
            const detail = error instanceof GatewayTranscriptionError ? error.publicMessage : '语音识别失败，请稍后重试'
            if (status === 499 || status >= 500) completeMetered(receipt, 'outcome_unknown')
            else completeMetered(receipt, 'settled')
            const note = `queue_ms=${queueMs};run_ms=${elapsedMs(runStarted)};bytes=${file.size}`
            await logUsage(store, { user, model: 'transcribe', ok: false, status, ms: elapsedMs(started), note })
            throw new HttpError(status, detail)
          }
        } finally {
          capacityPermit.release()
        }
      }

      return jsonError(404, 'not found')
    } catch (err) {
      if (err instanceof HttpError) return jsonError(err.status, err.detail)
      if (err instanceof CapacityQueueError || err instanceof ManagedResponsesRequestError) {
        return jsonError(err.status, err.publicMessage)
      }
      console.error('[billiardbuddy-gateway] request failed', err)
      return jsonError(500, 'internal server error')
    }
  }

  return fetchHandler
}

function authTokensResponse(tokens: { accessToken: string; refreshToken: string; expiresAt: number; principalId: string; installationId: string }) {
  return { access_token: tokens.accessToken, refresh_token: tokens.refreshToken, expires_at: tokens.expiresAt, token_type: 'Bearer' }
}

function createAuthorityFromEnv(env: Env): AuthAuthority {
  const signingKey = env.GW_AUTH_SIGNING_KEY
  if (!signingKey) throw new Error('Gateway installation sessions require GW_AUTH_SIGNING_KEY')
  return new AuthAuthority({ dbPath: env.GW_DB ?? '/opt/billiardbuddy-gateway/usage.db', signingKey })
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
  return loadCapacityPolicy(env).ingress.serverIdleTimeoutSeconds
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
  console.log(`[billiardbuddy-gateway] listening on http://${host}:${server.port}`)
}
