// 生图异步任务服务。受理队列与真实 Provider 执行容量彼此独立，
// 容量由 capacityPolicy 的 small 默认档和受控部署覆盖统一解析。
//
// 背景:GPT Image 2 是 OpenAI 同步接口(images.generate/edit),单张 high 质量要 2.5~4.5 分钟。若从大陆客户机/大陆网关
// 直接握这条跨境长连接死等,连接会被网络在约 60 秒物理掐断——图在 OpenAI 已生成并扣费,却传不回来(图丢+白扣钱)。
//
// 本服务部署在美国服务器(与 OpenAI 同区、网络稳),把"慢调用"收到美国本地跑:
//   图片 Sidecar --短 HTTPS-- 本服务(美国) --Provider 调用-- OpenAI / Seedream
// Relay 只经 Compose 私网回查 Gateway 安装身份；Gateway 不转发图片字节或任务。
// 客户端链路退化成"提交(短)/轮询(短)",不会持有跨境 Provider 长连接。
//
// 私测版加固:
//   - 幂等键:同 (owner, Idempotency-Key) 的重复提交返回原 task_id,只跑一次真实上游、只扣一次费。
//   - 归属绑定:任务绑定提交者 owner(网关注入的受信身份);带 owner 的任务只有同 owner 能轮询,否则 403。
//   - SQLite 持久化任务元数据;大体积输入/结果放 700 目录的 blob 文件,不长期堆在内存/SQLite。
//   - 队列上限:总量、单用户、并发、请求体大小、TTL,全部有界。
//   - 重启恢复:queued 续跑;running 无法确认结果 → failed_unknown,禁止自动重提(避免重复扣费)。
//
// 契约(与 Gateway 和桌面端对齐):
//   POST /v1/images/tasks   {mode:'generate'|'edit', model, prompt, n, size, response_format?, images?:string[](data-uri), reference_controls?, mask?}
//     headers: Authorization: Bearer <desktop access token>; Idempotency-Key: <key>
//                        → 202 {task_id, status:'queued', reused?}   (立即返回,后台跑 OpenAI)
//   GET  /v1/images/tasks/:id  headers: Authorization; direct-v1 returns owner-bound result URLs
//                        → 200 {status:'queued'|'running'|'succeeded'|'failed'|'failed_unknown', data?, error?, created}
//                        → 403 Gateway-introspected owner 不匹配 / 404 未知或过期
//   GET  /v1/images/tasks/by-idempotency/:key  headers: Authorization
//                        → 200 {task_id,status,reused:true} / 404 没有已持久化的远端任务；只查询，绝不代替客户端重提
//   POST /v1/images/tasks/:id/ack  headers: Authorization
//                        → 本机已持久化成功结果后幂等确认，relay 立即删除结果 blob，保留 receipt 元数据
//
// 鉴权:每个受保护请求用安装 bearer 调 Gateway 私网 introspection；Relay 从返回值派生 owner。真 OpenAI/ARK key 只在本服务环境变量,绝不下发。

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultManagedModelForWorkload,
  managedModelById,
  managedModelsForWorkload,
} from '../ts/shared/product/modelCatalog.js'
import {
  CapacityQueueError,
  ProviderAdmissionError,
  ProviderAdmissionGate,
  ProviderRateLimiter,
} from '../ts/shared/kernel/providerAdmission.js'
import {
  IMAGE_RELAY_IDEMPOTENCY_LOOKUP_PATH,
  IMAGE_RELAY_RESULT_HANDOFF_DIRECT_V1,
  IMAGE_RELAY_RESULT_HANDOFF_HEADER,
  IMAGE_RELAY_RESULTS_PATH,
  IMAGE_RELAY_TASKS_PATH,
} from '../ts/shared/product/imageRelayProtocol.js'
import { relayCapacityPolicyFromEnvironment, type RelayCapacityPolicy } from './capacityPolicy.js'
import { loadImageRelayIdentityIntrospector, RelayIdentityIntrospectionError, type ImageRelayIdentity } from './identityIntrospection.js'
import { loadRelayProviderCredentials } from './providerCredentials.js'
import { imageRelayQuotaPolicyFromEnvironment, type ImageRelayQuotaPolicy } from './quotaPolicy.js'
import { loadImageRelayResultCredentials } from './resultCredentials.js'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type RelayConfig = {
  taskTtlMs: number
  dbPath: string
  blobDir: string | null
  retryAfterSeconds: number
  requestBodyTimeoutMs: number
  identityTimeoutMs: number
  resultGlobalConcurrency: number
  resultOwnerConcurrency: number
  resultMaxBytes: number
  quotaLedgerRetentionDays: number
  capacityPolicy: RelayCapacityPolicy
  quotaPolicy: ImageRelayQuotaPolicy
}

type Env = Record<string, string | undefined>

function boundedPositiveIntEnv(env: Env, key: string, fallback: number, max: number): number {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`relay: ${key} 必须是正整数`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(`relay: ${key} 超出允许范围`)
  return parsed
}

export function loadRelayConfig(env: Env): RelayConfig {
  return {
    // Terminal results must survive app restarts and users returning days later.
    // Active queued/running work is never swept regardless of this value.
    taskTtlMs: boundedPositiveIntEnv(env, 'RELAY_TASK_TTL_MS', 7 * 24 * 60 * 60_000, 365 * 24 * 60 * 60_000),
    // 持久化:默认内存 SQLite(测试用);生产设 RELAY_DB=/opt/billiardbuddy-relay/relay.db 以支持重启恢复。
    dbPath: env.RELAY_DB ?? ':memory:',
    // 大体积 blob:设了 RELAY_BLOB_DIR 就落 700 目录的磁盘文件;没设(测试)就放进程内存。
    blobDir: env.RELAY_BLOB_DIR && env.RELAY_BLOB_DIR.trim() ? env.RELAY_BLOB_DIR.trim() : null,
    // 队列满时给网关/调用方明确的退避提示，而不是立刻并发重试放大流量。
    retryAfterSeconds: boundedPositiveIntEnv(env, 'RELAY_RETRY_AFTER_SECONDS', 30, 3600),
    requestBodyTimeoutMs: boundedPositiveIntEnv(env, 'RELAY_REQUEST_BODY_TIMEOUT_MS', 30_000, 120_000),
    // Gateway introspection is a private, short JSON hop. Keep it independently
    // bounded so a stuck identity dependency cannot tie up submit sockets.
    identityTimeoutMs: boundedPositiveIntEnv(env, 'RELAY_IDENTITY_TIMEOUT_MS', 5_000, 60_000),
    // Result bytes are delivered independently from paid generation admission.
    // A direct-v1 URL reads only one persisted candidate while these external
    // limits keep simultaneous base64 responses inside the Relay memory budget.
    resultGlobalConcurrency: boundedPositiveIntEnv(env, 'RELAY_RESULT_GLOBAL_CONC', 4, 64),
    resultOwnerConcurrency: boundedPositiveIntEnv(env, 'RELAY_RESULT_OWNER_CONC', 1, 16),
    resultMaxBytes: boundedPositiveIntEnv(env, 'RELAY_RESULT_MAX_BYTES', 32 * 1024 * 1024, 32 * 1024 * 1024),
    // Daily quota enforcement needs only the active UTC period; retain terminal
    // ledger evidence for a bounded audit window instead of growing forever.
    quotaLedgerRetentionDays: boundedPositiveIntEnv(env, 'RELAY_QUOTA_LEDGER_RETENTION_DAYS', 35, 3650),
    capacityPolicy: relayCapacityPolicyFromEnvironment(env),
    quotaPolicy: imageRelayQuotaPolicyFromEnvironment(env),
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers?: Record<string, string>,
  ) { super(message) }
}

class UpstreamResponseError extends Error {}
class UpstreamOutcomeUnknownError extends Error {}
class UpstreamBodyLimitError extends Error {}

const MAX_PROVIDER_IMAGE_RESPONSE_BYTES = 32 * 1024 * 1024

type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'failed_unknown' | 'cancelled'
type CandidateInvalid = { index: number; safe_error_code: string }
type RelayResultSummary = {
  expected_count: number
  valid_count: number
  invalid: CandidateInvalid[]
  /** Provider records observed before Relay discards any output that was not
   * authorized by the original n. It must never invalidate a valid index. */
  observed_count: number
  /** A result subset is deliverable, but at least one paid Provider attempt
   * cannot be proven complete. Its reservation must stay conservatively held. */
  partial_outcome_unknown: boolean
}
type RelayCandidate = {
  candidate_index: number
  b64_json: string
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
  revised_prompt?: string
}
type ProviderRunResult = {
  outputs: RelayCandidate[]
  summary: RelayResultSummary
}
type InputFidelityCapability = {
  requested: string
  status: 'accepted' | 'unsupported'
  risk?: string
}

type ReferenceControl = {
  image_index: number
  role: 'subject' | 'product' | 'character' | 'style' | 'composition' | 'environment' | 'brand'
  influence_strength: 'low' | 'medium' | 'high'
  preservation: 'may_change' | 'prefer_preserve' | 'must_preserve' | 'exact'
  priority: number
  label?: string
}

type SubmitBody = {
  mode?: 'generate' | 'edit'
  model?: string
  prompt?: string
  n?: number
  size?: string
  response_format?: string
  images?: string[]
  reference_controls?: ReferenceControl[]
  mask?: string
  input_fidelity?: string
}

const IMAGE_MODEL_CATALOG = managedModelsForWorkload('image_generation')
const GPT_IMAGE_MODEL = defaultManagedModelForWorkload('image_generation').model_id
const SEEDREAM_IMAGE_MODEL = IMAGE_MODEL_CATALOG.find(entry => entry.provider === 'bytedance-ark')?.model_id
if (!SEEDREAM_IMAGE_MODEL) throw new Error('relay: model catalog has no Seedream image provider')

const MAX_IMAGE_OUTPUT_COUNT = Math.max(...IMAGE_MODEL_CATALOG.map(entry => entry.image_generation?.max_output_count ?? 0))
const MAX_BASE64_BYTES_PER_IMAGE = Math.ceil(MAX_PROVIDER_IMAGE_RESPONSE_BYTES / 3) * 4
// Provider JSON may legitimately carry up to the catalog's maximum number of
// base64 images. This is still a fixed upper bound, not an unbounded text read.
const MAX_PROVIDER_JSON_RESPONSE_BYTES = MAX_BASE64_BYTES_PER_IMAGE * MAX_IMAGE_OUTPUT_COUNT + 1024 * 1024

function imageModelDescriptor(model: string) {
  const entry = managedModelById(model)
  if (!entry?.workload_bindings.some(binding => (
    binding.workload === 'image_generation' && binding.execution_runtime === 'image-relay'
  )) || !entry.image_generation) return undefined
  return entry
}

function isSeedreamModel(model: string): boolean {
  return model === SEEDREAM_IMAGE_MODEL
}

function validateSubmitBody(body: SubmitBody, arkConfigured: boolean): void {
  const model = String(body.model ?? GPT_IMAGE_MODEL)
  const descriptor = imageModelDescriptor(model)
  const generation = descriptor?.image_generation
  if (!descriptor || !generation) throw new HttpError(400, 'relay: 不支持这个生图模型')
  const outputs = Number(body.n ?? 1)
  if (!Number.isInteger(outputs) || outputs < 1 || outputs > generation.max_output_count) {
    throw new HttpError(400, `relay: 当前模型一次最多生成 ${generation.max_output_count} 张图片`)
  }
  const size = String(body.size ?? (isSeedreamModel(model) ? '2048x2048' : '1024x1024'))
  if (!generation.supported_sizes.includes(size)) throw new HttpError(400, 'relay: 当前模型不支持这个图片尺寸')
  if (isSeedreamModel(model) && !arkConfigured) {
    throw new HttpError(503, 'relay: 豆包生图未配置')
  }
  if (body.mode !== undefined && body.mode !== 'generate' && body.mode !== 'edit') {
    throw new HttpError(400, 'relay: 不支持这个生图方式')
  }
  if (body.mode === 'edit' && (!Array.isArray(body.images) || body.images.length === 0)) {
    throw new HttpError(400, 'relay: 参考图编辑缺少图片')
  }
  if (body.reference_controls !== undefined) {
    if (!Array.isArray(body.images) || !Array.isArray(body.reference_controls) || body.reference_controls.length === 0 || body.reference_controls.length > body.images.length) {
      throw new HttpError(400, 'relay: 参考图控制与图片输入不匹配')
    }
    const roles = new Set<ReferenceControl['role']>(['subject', 'product', 'character', 'style', 'composition', 'environment', 'brand'])
    const influences = new Set<ReferenceControl['influence_strength']>(['low', 'medium', 'high'])
    const preservations = new Set<ReferenceControl['preservation']>(['may_change', 'prefer_preserve', 'must_preserve', 'exact'])
    const indexes = new Set<number>()
    for (const control of body.reference_controls) {
      if (!control || typeof control !== 'object'
        || !Number.isInteger(control.image_index) || control.image_index < 0 || control.image_index >= body.images.length
        || indexes.has(control.image_index)
        || !roles.has(control.role) || !influences.has(control.influence_strength) || !preservations.has(control.preservation)
        || !Number.isInteger(control.priority) || control.priority < 0 || control.priority > 1_000
        || (control.label !== undefined && (typeof control.label !== 'string' || control.label.length === 0 || control.label.length > 120))) {
        throw new HttpError(400, 'relay: 参考图控制无效')
      }
      indexes.add(control.image_index)
    }
  }
}

/** Relay is the last trusted compiler before OpenAI/Ark: controls cannot be dropped after paid admission. */
function providerPrompt(body: SubmitBody): string {
  const prompt = String(body.prompt ?? '')
  const controls = body.reference_controls
  if (!controls?.length) return prompt
  const directives = [...controls]
    .sort((left, right) => right.priority - left.priority || left.image_index - right.image_index)
    .map(control => [
      `参考图 ${control.image_index + 1}`,
      `role=${control.role}`,
      `influence=${control.influence_strength}`,
      `preservation=${control.preservation}`,
      `priority=${control.priority}`,
      ...(control.label ? [`label=${control.label}`] : []),
    ].join('; '))
  return [
    prompt,
    '参考图控制（必须按图像索引逐项执行；priority 越高越优先）：',
    ...directives,
  ].join('\n')
}

/** 大体积输入/结果的存储:磁盘(生产,700 目录)或进程内存(测试)。SQLite 只存元数据+引用。 */
interface BlobStore {
  put(id: string, kind: 'in' | 'out', value: unknown): void
  get(id: string, kind: 'in' | 'out'): unknown | null
  byteLength(id: string, kind: 'in' | 'out'): number | null
  delKind(id: string, kind: 'in' | 'out'): void
  del(id: string): void
  putOutputs(id: string, data: unknown[]): void
  outputCount(id: string): number
  outputAt(id: string, index: number): unknown | null
  allOutputs(id: string): unknown[] | null
}

class MemoryBlobStore implements BlobStore {
  private map = new Map<string, unknown>()
  put(id: string, kind: 'in' | 'out', value: unknown): void { this.map.set(`${id}.${kind}`, value) }
  get(id: string, kind: 'in' | 'out'): unknown | null {
    return this.map.has(`${id}.${kind}`) ? this.map.get(`${id}.${kind}`) : null
  }
  byteLength(id: string, kind: 'in' | 'out'): number | null {
    const value = this.get(id, kind)
    return value === null ? null : Buffer.byteLength(JSON.stringify(value))
  }
  delKind(id: string, kind: 'in' | 'out'): void { this.map.delete(`${id}.${kind}`) }
  del(id: string): void { this.map.delete(`${id}.in`); this.map.delete(`${id}.out`) }
  putOutputs(id: string, data: unknown[]): void { this.put(id, 'out', { data }) }
  outputCount(id: string): number {
    const out = this.get(id, 'out') as { data?: unknown[] } | null
    return Array.isArray(out?.data) ? out.data.length : 0
  }
  outputAt(id: string, index: number): unknown | null {
    const out = this.get(id, 'out') as { data?: unknown[] } | null
    return Array.isArray(out?.data) && index >= 0 && index < out.data.length ? out.data[index]! : null
  }
  allOutputs(id: string): unknown[] | null {
    const out = this.get(id, 'out') as { data?: unknown[] } | null
    return Array.isArray(out?.data) ? out.data : null
  }
}

class DiskBlobStore implements BlobStore {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }) }
  private file(id: string, kind: 'in' | 'out'): string { return join(this.dir, `${id}.${kind}.json`) }
  private outputManifest(id: string): string { return join(this.dir, `${id}.out.manifest.json`) }
  private outputFile(id: string, index: number): string { return join(this.dir, `${id}.out.${index}.json`) }
  put(id: string, kind: 'in' | 'out', value: unknown): void {
    writeFileSync(this.file(id, kind), JSON.stringify(value), { mode: 0o600 })
  }
  get(id: string, kind: 'in' | 'out'): unknown | null {
    if (kind === 'out') {
      const data = this.allOutputs(id)
      return data === null ? null : { data }
    }
    const path = this.file(id, kind)
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  }
  byteLength(id: string, kind: 'in' | 'out'): number | null {
    if (kind === 'out') {
      const manifest = this.manifest(id)
      if (manifest) {
        try { return statSync(this.outputManifest(id)).size } catch { return null }
      }
    }
    const path = this.file(id, kind)
    try { return statSync(path).size } catch { return null }
  }
  delKind(id: string, kind: 'in' | 'out'): void {
    rmSync(this.file(id, kind), { force: true })
    if (kind === 'out') {
      rmSync(this.outputManifest(id), { force: true })
      for (let index = 0; index < 3; index += 1) rmSync(this.outputFile(id, index), { force: true })
    }
  }
  del(id: string): void {
    for (const kind of ['in', 'out'] as const) this.delKind(id, kind)
  }

  private manifest(id: string): { count: number } | null {
    const path = this.outputManifest(id)
    if (!existsSync(path)) return null
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { count?: unknown }
      const count = value?.count
      return typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 3 ? { count } : null
    } catch { return null }
  }

  private legacyOutputs(id: string): unknown[] | null {
    const path = this.file(id, 'out')
    if (!existsSync(path)) return null
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { data?: unknown[] }
      return Array.isArray(value?.data) ? value.data : null
    } catch { return null }
  }

  /** fsync the file before its rename and the containing directory after it.
   * The manifest is written last, so an acknowledged result never points at a
   * candidate whose bytes were only in the process cache at the crash point. */
  private syncFile(path: string): void {
    const descriptor = openSync(path, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }

  private syncDirectory(): void {
    const descriptor = openSync(this.dir, 'r')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }

  private writeJsonAtomically(target: string, value: unknown, temporary: string[]): void {
    const next = `${target}.${crypto.randomUUID()}.tmp`
    temporary.push(next)
    writeFileSync(next, JSON.stringify(value), { mode: 0o600 })
    this.syncFile(next)
    renameSync(next, target)
    temporary.pop()
  }

  putOutputs(id: string, data: unknown[]): void {
    if (data.length === 0 || data.length > 3) throw new Error('relay: result output count is outside the catalog boundary')
    // A manifest means the result set has already committed. Retrying the
    // caller must replay it, never overwrite an ACKable paid result.
    if (existsSync(this.outputManifest(id))) throw new Error('relay: result manifest is already committed')
    const temporary: string[] = []
    try {
      for (let index = 0; index < data.length; index += 1) {
        this.writeJsonAtomically(this.outputFile(id, index), data[index], temporary)
      }
      this.syncDirectory()
      // The manifest is the commit marker. Readers see either the old legacy
      // blob or a complete new output set, never a partially-written group.
      const manifest = this.outputManifest(id)
      this.writeJsonAtomically(manifest, { version: 1, count: data.length }, temporary)
      this.syncDirectory()
      // This new write has committed, so reclaim only its superseded legacy
      // representation. Pre-existing legacy tasks remain readable on their
      // old whole-array path until they are ACKed or swept.
      rmSync(this.file(id, 'out'), { force: true })
    } catch (error) {
      for (const path of temporary) rmSync(path, { force: true })
      for (let index = 0; index < 3; index += 1) rmSync(this.outputFile(id, index), { force: true })
      rmSync(this.outputManifest(id), { force: true })
      throw error
    }
  }

  outputCount(id: string): number {
    const manifest = this.manifest(id)
    if (manifest) return manifest.count
    return this.legacyOutputs(id)?.length ?? 0
  }

  outputAt(id: string, index: number): unknown | null {
    const manifest = this.manifest(id)
    if (manifest) {
      if (index < 0 || index >= manifest.count) return null
      try { return JSON.parse(readFileSync(this.outputFile(id, index), 'utf8')) } catch { return null }
    }
    return this.legacyOutputs(id)?.[index] ?? null
  }

  allOutputs(id: string): unknown[] | null {
    const manifest = this.manifest(id)
    if (!manifest) return this.legacyOutputs(id)
    const values: unknown[] = []
    for (let index = 0; index < manifest.count; index += 1) {
      const item = this.outputAt(id, index)
      if (item === null) return null
      values.push(item)
    }
    return values
  }
}

type TaskRow = {
  id: string
  owner: string // '' = legacy/no-owner (a sentinel, NOT SQL NULL, so the unique idempotency index still dedups)
  idempotency_key: string | null
  status: TaskState
  error: string | null
  input_fidelity: string | null // JSON of InputFidelityCapability, or null
  input_bytes: number
  input_fingerprint: string | null
  provider: string | null
  provider_receipt_hash: string | null
  result_summary: string | null
  acknowledged_at: number | null
  created: number
  updated: number
}

type ImageQuotaProvider = 'openai' | 'seedream'

type TaskQuote = {
  provider: ImageQuotaProvider
  period: string
  policyRevision: string
  pricingRevision: string
  amountMinor: number
}

class ImageQuotaExceededError extends Error {}
class ImageTaskQueueFullError extends Error {}
class ImageIdempotencyConflictError extends Error {}

type CreateTaskResult = {
  task: TaskRow
  created: boolean
}

type LegacyTaskQuote = (provider: string | null, now: number) => TaskQuote

/** SQLite 任务元数据存储 + 幂等映射。大体积 base64 不进这里,只进 BlobStore。 */
class TaskStore {
  private db: Database
  constructor(
    path: string,
    private readonly now: () => number,
    private readonly quotaPolicy: ImageRelayQuotaPolicy,
    private readonly legacyTaskQuote: LegacyTaskQuote,
  ) {
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA foreign_keys=ON')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS tasks(' +
      'id TEXT PRIMARY KEY, owner TEXT, idempotency_key TEXT, status TEXT NOT NULL, ' +
      'error TEXT, input_fidelity TEXT, input_bytes INTEGER NOT NULL DEFAULT 0, ' +
      'input_fingerprint TEXT, provider TEXT, provider_receipt_hash TEXT, result_summary TEXT, ' +
      'acknowledged_at INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL)'
    )
    // 旧的持久化库没有 input_bytes；CREATE TABLE IF NOT EXISTS 不会自动补列。
    const columns = this.db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'input_bytes')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN input_bytes INTEGER NOT NULL DEFAULT 0')
    }
    for (const column of ['input_fingerprint', 'provider', 'provider_receipt_hash', 'result_summary']) {
      if (!columns.some(existing => existing.name === column)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`)
    }
    if (!columns.some(existing => existing.name === 'acknowledged_at')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN acknowledged_at INTEGER')
    }
    // (owner, key) 唯一 —— 幂等去重;key 为 NULL 的行不参与(旧请求无幂等键,不去重)。
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem ON tasks(owner, idempotency_key) WHERE idempotency_key IS NOT NULL')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)')
    // A released reservation remains as an audit row after a pre-upstream blob
    // failure removes its task. It is deliberately not a foreign key: deleting
    // the transient task must not erase proof that the amount was released.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS image_quota_reservations(' +
      'task_id TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, period TEXT NOT NULL, ' +
      'policy_revision TEXT NOT NULL, pricing_revision TEXT NOT NULL, amount_minor INTEGER NOT NULL, ' +
      "state TEXT NOT NULL CHECK(state IN ('reserved','outcome_unknown','settled','released')), " +
      'upstream_receipt_hash TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
    )
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_image_quota_owner_period ON image_quota_reservations(owner,period) " +
      "WHERE state IN ('reserved','outcome_unknown','settled')",
    )
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_image_quota_provider_period ON image_quota_reservations(provider,period) " +
      "WHERE state IN ('reserved','outcome_unknown','settled')",
    )
    // Existing terminal work predating this table is not retroactively charged:
    // this durable boundary says exactly when the new policy became authoritative.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS image_quota_policy_boundaries(' +
      'policy_revision TEXT NOT NULL, effective_period TEXT NOT NULL, created INTEGER NOT NULL, ' +
      'PRIMARY KEY(policy_revision,effective_period))',
    )
    this.db.query('INSERT OR IGNORE INTO image_quota_policy_boundaries(policy_revision,effective_period,created) VALUES(?,?,?)')
      .run(this.quotaPolicy.revision, utcPeriod(this.now()), this.now())
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private ownerQuotaInPeriod(owner: string, period: string): number {
    const row = this.db.query(
      "SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM image_quota_reservations " +
      "WHERE owner=? AND period=? AND state IN ('reserved','outcome_unknown','settled')",
    ).get(owner, period) as { amount: number | null }
    return Number(row.amount ?? 0)
  }

  private providerQuotaInPeriod(provider: ImageQuotaProvider, period: string): number {
    const row = this.db.query(
      "SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM image_quota_reservations " +
      "WHERE provider=? AND period=? AND state IN ('reserved','outcome_unknown','settled')",
    ).get(provider, period) as { amount: number | null }
    return Number(row.amount ?? 0)
  }

  private insertReservation(task: TaskRow, quote: TaskQuote, state: 'reserved' | 'outcome_unknown'): void {
    const ts = this.now()
    this.db.query(
      'INSERT INTO image_quota_reservations(task_id,owner,provider,period,policy_revision,pricing_revision,amount_minor,state,upstream_receipt_hash,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      task.id,
      task.owner ?? '',
      quote.provider,
      quote.period,
      quote.policyRevision,
      quote.pricingRevision,
      quote.amountMinor,
      state,
      task.provider_receipt_hash,
      ts,
      ts,
    )
  }

  private reservationExists(id: string): boolean {
    return this.db.query('SELECT 1 AS value FROM image_quota_reservations WHERE task_id=?').get(id) !== null
  }

  /** Old queued rows predate the ledger. Before they can reach a Provider they
   * must obtain a new explicit reservation under the current UTC policy. */
  ensureQueuedReservation(id: string, quote: TaskQuote): void {
    this.transaction(() => {
      if (this.reservationExists(id)) return
      const task = this.get(id)
      if (!task || task.status !== 'queued') return
      if (this.ownerQuotaInPeriod(task.owner ?? '', quote.period) + quote.amountMinor > this.quotaPolicy.owner_daily_usd_minor_limit) {
        throw new ImageQuotaExceededError('relay: 生图可用额度已达上限')
      }
      if (this.providerQuotaInPeriod(quote.provider, quote.period) + quote.amountMinor > this.quotaPolicy.provider_daily_usd_minor_limit[quote.provider]) {
        throw new ImageQuotaExceededError('relay: 生图服务可用额度已达上限')
      }
      this.insertReservation(task, quote, 'reserved')
    })
  }

  /** The idempotency lookup, queue check, quota reservation and task write are
   * one SQLite transaction. This prevents two concurrent same-key submissions
   * from reserving twice or starting two paid calls. */
  createWithReservation(input: {
    id: string
    owner: string
    idempotencyKey: string
    inputBytes: number
    inputFingerprint: string
    provider: string
    quote: TaskQuote
    queueMax: number
    ownerTaskMax: number
  }): CreateTaskResult {
    return this.transaction(() => {
      const existing = this.findByIdempotency(input.owner, input.idempotencyKey)
      if (existing) {
        if (!sameOperationBinding(existing, input.inputFingerprint)) throw new ImageIdempotencyConflictError('relay: operation 已绑定不同输入')
        return { task: existing, created: false }
      }
      if (this.countActive() >= input.queueMax) throw new ImageTaskQueueFullError('relay: 生图队列已满,请稍后重试')
      if (this.countActiveByOwner(input.owner) >= input.ownerTaskMax) {
        throw new ImageTaskQueueFullError('relay: 你的生图任务已达上限,请等待前面的完成')
      }
      if (this.ownerQuotaInPeriod(input.owner, input.quote.period) + input.quote.amountMinor > this.quotaPolicy.owner_daily_usd_minor_limit) {
        throw new ImageQuotaExceededError('relay: 生图可用额度已达上限')
      }
      if (this.providerQuotaInPeriod(input.quote.provider, input.quote.period) + input.quote.amountMinor
        > this.quotaPolicy.provider_daily_usd_minor_limit[input.quote.provider]) {
        throw new ImageQuotaExceededError('relay: 生图服务可用额度已达上限')
      }
      const ts = this.now()
      try {
        this.db.query('INSERT INTO tasks(id,owner,idempotency_key,status,error,input_fidelity,input_bytes,input_fingerprint,provider,provider_receipt_hash,result_summary,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(input.id, input.owner, input.idempotencyKey, 'queued', null, null, input.inputBytes, input.inputFingerprint, input.provider, null, null, ts, ts)
      } catch (error) {
        // BEGIN IMMEDIATE normally serializes this path. Preserve the same-key
        // contract if a future driver changes SQLite lock behavior.
        const concurrent = this.findByIdempotency(input.owner, input.idempotencyKey)
        if (concurrent) {
          if (!sameOperationBinding(concurrent, input.inputFingerprint)) throw new ImageIdempotencyConflictError('relay: operation 已绑定不同输入')
          return { task: concurrent, created: false }
        }
        throw error
      }
      this.insertReservation(this.get(input.id)!, input.quote, 'reserved')
      return { task: this.get(input.id)!, created: true }
    })
  }

  setInputBytes(id: string, inputBytes: number): void {
    this.db.query('UPDATE tasks SET input_bytes=?, updated=? WHERE id=?').run(inputBytes, this.now(), id)
  }

  /** Blob persistence is part of accepting paid work. If it fails before any
   * upstream call, remove the task and atomically release the reservation. */
  removeAndRelease(id: string): void {
    this.transaction(() => {
      const ts = this.now()
      this.db.query("UPDATE image_quota_reservations SET state='released', updated=? WHERE task_id=? AND state='reserved'")
        .run(ts, id)
      this.db.query('DELETE FROM tasks WHERE id=?').run(id)
    })
  }

  get(id: string): TaskRow | null {
    return (this.db.query('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | null) ?? null
  }

  // owner is a '' sentinel (never NULL) so `owner = ?` dedups the no-owner path too — SQL
  // would treat NULLs as distinct and silently skip the unique index.
  findByIdempotency(owner: string, key: string): TaskRow | null {
    return (this.db.query('SELECT * FROM tasks WHERE idempotency_key=? AND owner=?').get(key, owner) as TaskRow | null) ?? null
  }

  appendProviderReceipt(id: string, receiptHash: string): void {
    this.transaction(() => {
      const current = this.get(id)?.provider_receipt_hash
      const aggregate = current
        ? createHash('sha256').update(`${current}\0${receiptHash}`).digest('hex')
        : receiptHash
      const ts = this.now()
      this.db.query('UPDATE tasks SET provider_receipt_hash=?, updated=? WHERE id=?').run(aggregate, ts, id)
      // A receipt means the provider may have charged even if a later parser,
      // image download or blob write fails. Never release that reservation.
      this.db.query("UPDATE image_quota_reservations SET state='outcome_unknown', upstream_receipt_hash=?, updated=? WHERE task_id=? AND state IN ('reserved','outcome_unknown')")
        .run(aggregate, ts, id)
    })
  }

  acknowledgeResult(id: string): number {
    const current = this.get(id)
    if (!current) throw new Error('task missing during acknowledgement')
    if (current.acknowledged_at !== null) return current.acknowledged_at
    const acknowledgedAt = this.now()
    this.db.query('UPDATE tasks SET acknowledged_at=?, updated=? WHERE id=?')
      .run(acknowledgedAt, acknowledgedAt, id)
    return acknowledgedAt
  }

  markRunning(id: string): void {
    this.db.query('UPDATE tasks SET status=?, updated=? WHERE id=?').run('running', this.now(), id)
  }

  markSucceeded(id: string, summary: RelayResultSummary): void {
    this.transaction(() => {
      const ts = this.now()
      this.db.query('UPDATE tasks SET status=?, error=?, result_summary=?, updated=? WHERE id=?')
        .run('succeeded', null, JSON.stringify(summary), ts, id)
      const state = summary.partial_outcome_unknown ? 'outcome_unknown' : 'settled'
      this.db.query("UPDATE image_quota_reservations SET state=?, updated=? WHERE task_id=? AND state IN ('reserved','outcome_unknown')")
        .run(state, ts, id)
    })
  }

  /** A crash can land after the durable manifest but before the SQLite terminal
   * projection. The manifest is proof of a deliverable subset, not permission
   * to call the Provider again. Restore it with a conservative unknown ledger. */
  recoverSucceededManifestResult(id: string, summary: RelayResultSummary): boolean {
    return this.transaction(() => {
      const current = this.get(id)
      if (!current || current.status !== 'failed_unknown' || !current.provider_receipt_hash || current.acknowledged_at !== null) return false
      const ts = this.now()
      this.db.query('UPDATE tasks SET status=?, error=?, result_summary=?, updated=? WHERE id=?')
        .run('succeeded', null, JSON.stringify({ ...summary, partial_outcome_unknown: true }), ts, id)
      this.db.query("UPDATE image_quota_reservations SET state='outcome_unknown', updated=? WHERE task_id=? AND state IN ('reserved','outcome_unknown','settled')")
        .run(ts, id)
      return true
    })
  }

  markKnownFailedAndRelease(id: string, error: string): void {
    this.transaction(() => {
      const ts = this.now()
      this.db.query('UPDATE tasks SET status=?, error=?, updated=? WHERE id=?').run('failed', error, ts, id)
      this.db.query("UPDATE image_quota_reservations SET state='released', updated=? WHERE task_id=? AND state='reserved'")
        .run(ts, id)
    })
  }

  markOutcomeUnknown(id: string, error: string): void {
    this.transaction(() => {
      const ts = this.now()
      this.db.query('UPDATE tasks SET status=?, error=?, updated=? WHERE id=?').run('failed_unknown', error, ts, id)
      this.db.query("UPDATE image_quota_reservations SET state='outcome_unknown', updated=? WHERE task_id=? AND state IN ('reserved','outcome_unknown')")
        .run(ts, id)
    })
  }

  cancelQueuedAndRelease(id: string): TaskRow | null {
    return this.transaction(() => {
      const current = this.get(id)
      if (!current || current.status !== 'queued') return null
      const ts = this.now()
      this.db.query('UPDATE tasks SET status=?, error=?, updated=? WHERE id=?').run('cancelled', '任务已在请求上游前取消', ts, id)
      this.db.query("UPDATE image_quota_reservations SET state='released', updated=? WHERE task_id=? AND state='reserved'")
        .run(ts, id)
      return this.get(id)
    })
  }

  countActive(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('queued','running')").get() as { c: number }
    return Number(row.c ?? 0)
  }

  countActiveByOwner(owner: string): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('queued','running') AND owner=?").get(owner) as { c: number }
    return Number(row.c ?? 0)
  }

  countActiveInputBytes(): number {
    const row = this.db.query(
      "SELECT COALESCE(SUM(input_bytes), 0) AS bytes FROM tasks WHERE status IN ('queued','running')",
    ).get() as { bytes: number }
    return Number(row.bytes ?? 0)
  }

  activeCounts(): { queued: number; running: number } {
    const row = this.db.query(
      "SELECT " +
      "SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued, " +
      "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running " +
      "FROM tasks WHERE status IN ('queued','running')",
    ).get() as { queued: number | null; running: number | null }
    return { queued: Number(row.queued ?? 0), running: Number(row.running ?? 0) }
  }

  /** 只删除过期终态任务,活跃任务永不被 TTL 清理。 */
  sweepExpired(cutoff: number): string[] {
    const terminal = "status IN ('succeeded','failed','failed_unknown','cancelled')"
    const rows = this.db.query(`SELECT id FROM tasks WHERE updated < ? AND ${terminal}`).all(cutoff) as Array<{ id: string }>
    if (rows.length) this.db.query(`DELETE FROM tasks WHERE updated < ? AND ${terminal}`).run(cutoff)
    return rows.map(r => r.id)
  }

  sweepQuotaBefore(period: string): void {
    this.db.query(
      "DELETE FROM image_quota_reservations WHERE period < ? AND state IN ('settled','released','outcome_unknown')",
    ).run(period)
  }

  /**
   * 重启恢复:queued 需要续跑;running 无法确认上游是否已完成/扣费 → 标 failed_unknown 且禁止自动重提。
   * 返回待续跑的 queued id 列表(由调用方读 blob 重新入队跑)。
   */
  recover(): { queued: string[]; unknown: string[] } {
    return this.transaction(() => {
      const running = this.db.query("SELECT id FROM tasks WHERE status='running'").all() as Array<{ id: string }>
      if (running.length) {
        const ts = this.now()
        for (const { id } of running) {
          if (this.reservationExists(id)) continue
          const task = this.get(id)
          if (task) this.insertReservation(task, this.legacyTaskQuote(task.provider, ts), 'outcome_unknown')
        }
        this.db.query("UPDATE tasks SET status='failed_unknown', error='服务重启前任务在跑,无法确认结果(不自动重提,避免重复扣费)', updated=? WHERE status='running'")
          .run(ts)
        this.db.query("UPDATE image_quota_reservations SET state='outcome_unknown', updated=? WHERE task_id IN (SELECT id FROM tasks WHERE status='failed_unknown') AND state IN ('reserved','outcome_unknown')")
          .run(ts)
      }
      const queued = this.db.query("SELECT id FROM tasks WHERE status='queued'").all() as Array<{ id: string }>
      return { queued: queued.map(r => r.id), unknown: running.map(r => r.id) }
    })
  }
}

/** data:<ct>;base64,<b64> → File(用于 multipart /images/edits)。 */
function dataUriToFile(uri: string, name: string): File | null {
  const m = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(uri)
  if (!m) return null
  const contentType = m[1] || 'image/png'
  const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  return new File([bytes], name, { type: contentType })
}

/**
 * 按 chunk 读取提交体，并在读取过程中预留全局输入字节预算。不能用 request.arrayBuffer()
 * 再检查：500 个分块的大改图请求会先同时进入 JS 堆，等检查时已经来不及了。
 */
async function readRequestBodyBounded(
  req: Request,
  maxBytes: number,
  timeoutMs: number,
  reserve: (bytes: number) => void,
  release: (bytes: number) => void,
): Promise<{ raw: Uint8Array; release: () => void }> {
  if (!req.body) return { raw: new Uint8Array(), release: () => {} }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let reserved = 0
  let wasReleased = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const releaseReserved = () => {
    if (wasReleased || reserved === 0) return
    wasReleased = true
    release(reserved)
  }

  const read = async () => {
    while (true) {
      let next
      try {
        next = await reader.read()
      } catch {
        throw new HttpError(400, 'relay: 请求体读取失败')
      }
      if (next.done) break
      const value = next.value
      if (!value || value.byteLength === 0) continue
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new HttpError(413, 'relay: 请求体过大')
      }
      reserve(value.byteLength)
      reserved += value.byteLength
      total += value.byteLength
      chunks.push(value)
    }
    const raw = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      raw.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { raw, release: releaseReserved }
  }
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {})
      reject(new HttpError(408, 'relay: 请求体读取超时'))
    }, timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([read(), deadline])
  } catch (error) {
    void reader.cancel().catch(() => {})
    releaseReserved()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    try { reader.releaseLock() } catch {}
  }
}

function outputCount(body: SubmitBody): number {
  const descriptor = imageModelDescriptor(String(body.model ?? GPT_IMAGE_MODEL))
  const max = descriptor?.image_generation?.max_output_count
  const value = Number(body.n ?? 1)
  if (!Number.isInteger(value) || value < 1 || !max || value > max) {
    throw new Error('relay: persisted task has an invalid image output count')
  }
  return value
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function utcPeriod(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')?.trim()
  if (!raw) return undefined
  if (!/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

function maxBase64BytesFor(binaryBytes: number): number {
  return Math.ceil(binaryBytes / 3) * 4 + 8
}

function detectedRelayImageMime(bytes: Buffer, contentType = ''): RelayCandidate['mime_type'] {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (contentType.startsWith('image/jpeg')) return 'image/jpeg'
  if (contentType.startsWith('image/webp')) return 'image/webp'
  return 'image/png'
}

/** Relay does not own image-format validation (the Sidecar verifies bytes into
 * CAS), but it must reject malformed/oversized base64 before a candidate can
 * occupy a result slot. Return a safe reason instead of discarding siblings. */
function normaliseInlineCandidate(item: unknown, candidateIndex: number, binaryLimit: number): { output?: RelayCandidate; invalid?: CandidateInvalid } {
  if (!item || typeof item !== 'object') return { invalid: { index: candidateIndex, safe_error_code: 'IMAGE_RESULT_MISSING' } }
  const source = item as Record<string, unknown>
  const encoded = source.b64_json
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return { invalid: { index: candidateIndex, safe_error_code: source.url ? 'IMAGE_RESULT_INVALID' : 'IMAGE_RESULT_MISSING' } }
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.indexOf('=') >= 0 && encoded.indexOf('=') < encoded.length - 2) {
    return { invalid: { index: candidateIndex, safe_error_code: 'IMAGE_RESULT_INVALID' } }
  }
  if (Buffer.byteLength(encoded, 'ascii') > maxBase64BytesFor(binaryLimit)) {
    return { invalid: { index: candidateIndex, safe_error_code: 'IMAGE_RESULT_TOO_LARGE' } }
  }
  const bytes = Buffer.from(encoded, 'base64')
  const canonical = bytes.toString('base64')
  if (bytes.byteLength === 0 || bytes.byteLength > binaryLimit || (encoded !== canonical && encoded !== canonical.replace(/=+$/, ''))) {
    return { invalid: { index: candidateIndex, safe_error_code: bytes.byteLength > binaryLimit ? 'IMAGE_RESULT_TOO_LARGE' : 'IMAGE_RESULT_INVALID' } }
  }
  return {
    output: {
      candidate_index: candidateIndex,
      b64_json: canonical,
      mime_type: detectedRelayImageMime(bytes),
      ...(typeof source.revised_prompt === 'string' ? { revised_prompt: source.revised_prompt } : {}),
    },
  }
}

function partialSummary(expectedCount: number, outputs: RelayCandidate[], invalid: CandidateInvalid[], partialOutcomeUnknown: boolean, observedCount = outputs.length): RelayResultSummary {
  return {
    expected_count: expectedCount,
    valid_count: outputs.length,
    invalid: invalid.sort((left, right) => left.index - right.index),
    observed_count: observedCount,
    partial_outcome_unknown: partialOutcomeUnknown,
  }
}

class ResultDeliveryGate {
  #active = 0
  #owners = new Map<string, number>()
  constructor(private readonly globalLimit: number, private readonly ownerLimit: number) {}

  tryAcquire(owner: string): (() => void) | null {
    const ownerActive = this.#owners.get(owner) ?? 0
    if (this.#active >= this.globalLimit || ownerActive >= this.ownerLimit) return null
    this.#active += 1
    this.#owners.set(owner, ownerActive + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active = Math.max(0, this.#active - 1)
      const current = (this.#owners.get(owner) ?? 1) - 1
      if (current <= 0) this.#owners.delete(owner)
      else this.#owners.set(owner, current)
    }
  }
}

/** Keep the delivery permit until the response body is consumed or cancelled,
 * not merely until JSON serialization returns to this handler. */
function retainDeliveryPermit(response: Response, release: () => void): Response {
  if (!response.body) {
    release()
    return response
  }
  const reader = response.body.getReader()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    release()
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          close()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        close()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { close() }
    },
  })
  const headers = new Headers(response.headers)
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}

/** A response header is only advisory, so it is a fast rejection rather than
 * the only guard. Chunked bodies are bounded as they stream into memory. */
async function readResponseBytesBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = declaredContentLength(response)
  if (declared !== undefined && declared > maxBytes) {
    // The response is already rejected by its declared size. Do not let a
    // broken peer's never-settling cancel promise hold the worker slot.
    void response.body?.cancel().catch(() => {})
    throw new UpstreamBodyLimitError(`response exceeds ${maxBytes} byte limit`)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const value = next.value
      if (!value || value.byteLength === 0) continue
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new UpstreamBodyLimitError(`response exceeds ${maxBytes} byte limit`)
      }
      chunks.push(value)
      total += value.byteLength
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  } finally {
    // A deadline can win while a hostile stream still owns a pending read.
    // Releasing that lock is cleanup only and must never replace the bounded
    // upstream error with a secondary stream-state exception.
    try { reader.releaseLock() } catch {}
  }
}

function taskProvider(body: SubmitBody): 'OpenAI' | 'ByteDance Ark' {
  return isSeedreamModel(String(body.model ?? GPT_IMAGE_MODEL)) ? 'ByteDance Ark' : 'OpenAI'
}

function taskQuote(body: SubmitBody, policy: ImageRelayQuotaPolicy, now: number): TaskQuote {
  const descriptor = imageModelDescriptor(String(body.model ?? GPT_IMAGE_MODEL))
  const price = descriptor?.image_generation?.price_upper_bound
  if (!price || price.currency !== 'USD' || !Number.isSafeInteger(price.per_output_amount_minor) || price.per_output_amount_minor < 0) {
    throw new HttpError(503, 'relay: 当前模型缺少可执行的付费报价')
  }
  const amountMinor = price.per_output_amount_minor * outputCount(body)
  if (!Number.isSafeInteger(amountMinor)) throw new HttpError(503, 'relay: 当前模型报价超出安全范围')
  return {
    provider: isSeedreamModel(String(body.model ?? GPT_IMAGE_MODEL)) ? 'seedream' : 'openai',
    period: utcPeriod(now),
    policyRevision: policy.revision,
    pricingRevision: price.pricing_revision,
    amountMinor,
  }
}

/** A legacy running task has no persisted model/count quote. Recover it as the
 * most expensive catalog shape for its recorded physical provider, never as a
 * free unknown outcome. Queued legacy rows take the exact path above instead. */
function legacyTaskQuoteForPolicy(policy: ImageRelayQuotaPolicy): LegacyTaskQuote {
  return (provider, now) => {
    const seedream = provider === 'ByteDance Ark'
    const candidates = IMAGE_MODEL_CATALOG.filter(entry => (entry.provider === 'bytedance-ark') === seedream)
    const candidate = candidates
      .map(entry => ({ entry, generation: entry.image_generation! }))
      .sort((left, right) => (
        right.generation.price_upper_bound.per_output_amount_minor * right.generation.max_output_count
        - left.generation.price_upper_bound.per_output_amount_minor * left.generation.max_output_count
      ))[0]
    if (!candidate) throw new Error('relay: catalog has no conservative legacy quote')
    const amountMinor = candidate.generation.price_upper_bound.per_output_amount_minor * candidate.generation.max_output_count
    return {
      provider: seedream ? 'seedream' : 'openai',
      period: utcPeriod(now),
      policyRevision: `${policy.revision}:legacy-active`,
      pricingRevision: `legacy-conservative:${candidate.generation.price_upper_bound.pricing_revision}`,
      amountMinor,
    }
  }
}

function sameOperationBinding(row: TaskRow, fingerprint: string): boolean {
  return row.input_fingerprint === fingerprint
}

export type RelayDeps = {
  env: Env
  /** Provider calls only; identity lookups use identityFetchImpl so tests cannot accidentally conflate them. */
  fetchImpl?: FetchLike
  identityFetchImpl?: FetchLike
  now?: () => number
}

export function createRelayFetch(deps: RelayDeps): (req: Request) => Promise<Response> {
  const config = loadRelayConfig(deps.env)
  const capacity = config.capacityPolicy
  const providerCredentials = loadRelayProviderCredentials(deps.env)
  const configuredOpenAiAuthorization = providerCredentials.bearerAuthorization('openai')
  if (!configuredOpenAiAuthorization) throw new Error('relay: 缺少环境变量 RELAY_OPENAI_KEY')
  const openaiAuthorization: string = configuredOpenAiAuthorization
  const seedreamAuthorization = providerCredentials.bearerAuthorization('seedream')
  const fetchImpl: FetchLike = deps.fetchImpl ?? globalThis.fetch
  const rawIdentityFetch: FetchLike = deps.identityFetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const identityIntrospector = loadImageRelayIdentityIntrospector(deps.env, {
    fetchImpl: rawIdentityFetch,
    now,
    timeoutMs: config.identityTimeoutMs,
  })
  const resultCredentials = loadImageRelayResultCredentials(deps.env, { now })
  const store = new TaskStore(config.dbPath, now, config.quotaPolicy, legacyTaskQuoteForPolicy(config.quotaPolicy))
  const blobs: BlobStore = config.blobDir ? new DiskBlobStore(config.blobDir) : new MemoryBlobStore()
  const openaiAdmission = new ProviderAdmissionGate({
    maxActive: capacity.providers.openai.concurrency,
    maxActivePerOwner: capacity.providers.openai.owner_concurrency,
    maxQueued: capacity.admission.queue_max,
    maxQueuedPerOwner: capacity.admission.owner_task_max,
    maxWaitMs: config.retryAfterSeconds * 1_000,
  })
  const seedreamAdmission = new ProviderAdmissionGate({
    maxActive: capacity.providers.seedream.concurrency,
    maxActivePerOwner: capacity.providers.seedream.owner_concurrency,
    maxQueued: capacity.admission.queue_max,
    maxQueuedPerOwner: capacity.admission.owner_task_max,
    maxWaitMs: config.retryAfterSeconds * 1_000,
  })
  const openaiRate = new ProviderRateLimiter(capacity.providers.openai.requests_per_minute, capacity.admission.queue_max)
  const seedreamRate = new ProviderRateLimiter(capacity.providers.seedream.requests_per_minute, capacity.admission.queue_max)
  const resultDelivery = new ResultDeliveryGate(config.resultGlobalConcurrency, config.resultOwnerConcurrency)
  const admissionControllers = new Map<string, AbortController>()
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 尚未落入 SQLite 的上传体也要计入预算；否则 500 个 chunked 请求可在入队前一起占满内存。
  let pendingInputBytes = 0
  // This cache is updated on task-state transitions, not once for every HTTP chunk. A
  // client can legally split a body into tiny chunks; issuing a SQLite SUM for each byte
  // would turn a 500-upload burst into a database CPU denial of service.
  let activeInputBytes = store.countActiveInputBytes()
  const refreshActiveInputBytes = (): number => {
    activeInputBytes = store.countActiveInputBytes()
    return activeInputBytes
  }

  function reserveInputBytes(bytes: number): void {
    if (pendingInputBytes + bytes > capacity.admission.pending_input_bytes_max) {
      throw queueFull('relay: 同时上传的生图输入数据已达上限,请等待前面的上传完成')
    }
    const used = activeInputBytes + pendingInputBytes
    if (used + bytes > capacity.admission.active_input_bytes_max) {
      throw queueFull('relay: 活跃生图输入数据已达上限,请等待前面的任务完成或取消')
    }
    pendingInputBytes += bytes
  }

  function releaseInputBytes(bytes: number): void {
    pendingInputBytes = Math.max(0, pendingInputBytes - bytes)
  }

  function sweep(): void {
    const cutoff = now() - config.taskTtlMs
    for (const id of store.sweepExpired(cutoff)) blobs.del(id)
    store.sweepQuotaBefore(utcPeriod(now() - config.quotaLedgerRetentionDays * 24 * 60 * 60_000))
  }

  async function identity(req: Request): Promise<ImageRelayIdentity> {
    const header = req.headers.get('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match?.[1]?.trim()) throw new HttpError(401, 'relay: 缺少安装访问令牌')
    try {
      return await identityIntrospector.introspect(match[1].trim())
    } catch (error) {
      if (error instanceof RelayIdentityIntrospectionError) {
        throw new HttpError(error.status, `relay: ${error.code}`)
      }
      throw error
    }
  }

  function queueFull(message: string): HttpError {
    return new HttpError(429, message, {
      'Retry-After': String(config.retryAfterSeconds),
      'Cache-Control': 'no-store',
    })
  }

  async function fetchUpstreamBody<T>(
    provider: 'OpenAI' | 'Seedream',
    input: string,
    init: RequestInit,
    readBody: (response: Response) => Promise<T>,
  ): Promise<{ response: Response; body: T }> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const providerPolicy = provider === 'OpenAI' ? capacity.providers.openai : capacity.providers.seedream
    const timeoutError = () => new UpstreamOutcomeUnknownError(
      `${provider} 请求超过受控上游时限，无法确认是否已经生成或扣费`,
    )
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(timeoutError())
      }, providerPolicy.upstream_timeout_ms)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const requestAndRead = async () => {
      let response: Response
      try {
        response = await fetchImpl(input, { ...init, signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError()
        throw new UpstreamOutcomeUnknownError(`${provider} 连接中断，无法确认结果: ${String(error).slice(0, 160)}`)
      }
      try {
        return { response, body: await readBody(response) }
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError()
        throw response.ok
          ? new UpstreamOutcomeUnknownError(`${provider} 成功响应读取失败，无法确认结果: ${String(error).slice(0, 160)}`)
          : new UpstreamResponseError(`${provider} ${response.status}: 响应读取失败`)
      }
    }
    try {
      return await Promise.race([requestAndRead(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function fetchUpstreamText(
    provider: 'OpenAI' | 'Seedream',
    input: string,
    init: RequestInit,
  ): Promise<{ response: Response; body: string }> {
    return fetchUpstreamBody(provider, input, init, async response => {
      const bytes = await readResponseBytesBounded(response, MAX_PROVIDER_JSON_RESPONSE_BYTES)
      return new TextDecoder().decode(bytes)
    })
  }

  function fetchUpstreamBytes(
    provider: 'OpenAI' | 'Seedream',
    input: string,
    init: RequestInit,
  ): Promise<{ response: Response; body: Uint8Array }> {
    return fetchUpstreamBody(provider, input, init, response => readResponseBytesBounded(response, MAX_PROVIDER_IMAGE_RESPONSE_BYTES))
  }

  function upstreamReceiptHash(provider: 'OpenAI' | 'Seedream', response: Response, body: string): string {
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-tt-logid') ?? ''
    return sha256(`${provider}\0${requestId}\0${sha256(body)}`)
  }

  async function seedreamDataItem(item: unknown, candidateIndex: number): Promise<{ output?: RelayCandidate; invalid?: CandidateInvalid }> {
    if (!item || typeof item !== 'object') return { invalid: { index: candidateIndex, safe_error_code: 'IMAGE_RESULT_MISSING' } }
    const source = item as Record<string, unknown>
    if (typeof source.b64_json === 'string') return normaliseInlineCandidate(source, candidateIndex, config.resultMaxBytes)
    if (typeof source.url !== 'string' || !source.url) return { invalid: { index: candidateIndex, safe_error_code: 'IMAGE_RESULT_MISSING' } }
    let assetUrl: URL
    try {
      assetUrl = new URL(source.url)
    } catch {
      throw new UpstreamOutcomeUnknownError('Seedream 已返回成功状态，但图片地址无效')
    }
    if (assetUrl.protocol !== 'https:') {
      throw new UpstreamOutcomeUnknownError('Seedream 已返回成功状态，但图片地址不是安全链接')
    }
    const { response: imageResponse, body: bytes } = await fetchUpstreamBytes(
      'Seedream',
      assetUrl.toString(),
      // A provider-returned asset URL is not a redirect grant. Do not follow a
      // redirected target which could bypass the HTTPS asset validation above.
      { method: 'GET', redirect: 'error' },
    )
    if (!imageResponse.ok) {
      throw new UpstreamOutcomeUnknownError(`Seedream 已生成图片，但下载结果失败: HTTP ${imageResponse.status}`)
    }
    if (imageResponse.redirected) {
      throw new UpstreamOutcomeUnknownError('Seedream 已生成图片，但下载结果发生重定向')
    }
    if (imageResponse.url) {
      let finalUrl: URL
      try { finalUrl = new URL(imageResponse.url) } catch {
        throw new UpstreamOutcomeUnknownError('Seedream 已生成图片，但下载结果地址无效')
      }
      if (finalUrl.protocol !== 'https:' || finalUrl.origin !== assetUrl.origin) {
        throw new UpstreamOutcomeUnknownError('Seedream 已生成图片，但下载结果越过受信资产来源')
      }
    }
    if (bytes.byteLength === 0) return { invalid: { index: candidateIndex, safe_error_code: 'IMAGE_RESULT_MISSING' } }
    if (bytes.byteLength > config.resultMaxBytes) return { invalid: { index: candidateIndex, safe_error_code: 'IMAGE_RESULT_TOO_LARGE' } }
    const buffer = Buffer.from(bytes)
    const contentType = imageResponse.headers.get('content-type')?.toLowerCase() ?? ''
    return {
      output: {
        candidate_index: candidateIndex,
        b64_json: buffer.toString('base64'),
        mime_type: detectedRelayImageMime(buffer, contentType),
        ...(typeof source.revised_prompt === 'string' ? { revised_prompt: source.revised_prompt } : {}),
      },
    }
  }

  async function runSeedream(body: SubmitBody, recordReceipt: (hash: string) => void): Promise<ProviderRunResult> {
    const model = String(body.model ?? SEEDREAM_IMAGE_MODEL)
    const prompt = providerPrompt(body)
    const size = String(body.size ?? '2048x2048')
    const count = outputCount(body)
    const outputs: RelayCandidate[] = []
    const invalid: CandidateInvalid[] = []
    let partialOutcomeUnknown = false
    let observedCount = 0
    for (let index = 0; index < count; index += 1) {
      const payload: Record<string, unknown> = {
        model,
        prompt,
        size,
        watermark: false,
        response_format: 'b64_json',
      }
      if (body.mode === 'edit') {
        const images = (body.images ?? []).filter(image => typeof image === 'string' && image.startsWith('data:image/'))
        payload.image = images.length === 1 ? images[0] : images
        payload.sequential_image_generation = 'disabled'
      }
      if (!seedreamAuthorization) throw new UpstreamResponseError('Seedream 凭据未配置')
      try {
        const { response, body: text } = await fetchUpstreamText(
          'Seedream',
          `${providerCredentials.baseUrl('seedream')}/images/generations`,
          {
            method: 'POST',
            headers: {
              authorization: seedreamAuthorization,
              'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
          },
        )
        if (!response.ok) {
          if (outputs.length === 0) throw new UpstreamResponseError(`Seedream 请求未被接受: HTTP ${response.status}`)
          invalid.push({ index, safe_error_code: 'IMAGE_PROVIDER_REJECTED' })
          for (let missing = index + 1; missing < count; missing += 1) invalid.push({ index: missing, safe_error_code: 'IMAGE_PROVIDER_NOT_ATTEMPTED' })
          // A preceding Seedream receipt has already crossed the paid boundary.
          // Keep the aggregate reservation unknown rather than treating a later
          // provider failure as a complete known settlement for the whole Round.
          partialOutcomeUnknown = true
          break
        }
        recordReceipt(upstreamReceiptHash('Seedream', response, text))
        let parsed: unknown
        try {
          parsed = text ? JSON.parse(text) : {}
        } catch {
          throw new UpstreamOutcomeUnknownError('Seedream 已返回成功状态，但响应内容损坏，无法确认生成结果')
        }
        const data = parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data)
          ? (parsed as { data: unknown[] }).data
          : []
        observedCount += data.length
        // Seedream is called once per requested candidate. A successful call
        // returning extras is a protocol anomaly, not permission to emit extra
        // candidates or to invalidate the requested one that did verify.
        if (data.length > 1) partialOutcomeUnknown = true
        const normalized = await seedreamDataItem(data[0], index)
        if (normalized.output) outputs.push(normalized.output)
        else if (normalized.invalid) {
          invalid.push(normalized.invalid)
          partialOutcomeUnknown = true
        }
      } catch (error) {
        // Once a preceding candidate is durable, never throw it away merely
        // because a later paid hop has an unprovable outcome. Stop instead of
        // automatically issuing more remote calls under the same Round.
        if (outputs.length === 0) throw error
        invalid.push({ index, safe_error_code: 'IMAGE_RESULT_OUTCOME_UNKNOWN' })
        for (let missing = index + 1; missing < count; missing += 1) invalid.push({ index: missing, safe_error_code: 'IMAGE_PROVIDER_NOT_ATTEMPTED' })
        partialOutcomeUnknown = true
        break
      }
    }
    return { outputs, summary: partialSummary(count, outputs, invalid, partialOutcomeUnknown, observedCount) }
  }

  function scheduleTaskRetry(id: string): void {
    if (retryTimers.has(id) || store.get(id)?.status !== 'queued') return
    const timer = setTimeout(() => {
      retryTimers.delete(id)
      if (store.get(id)?.status === 'queued') void runImageTask(id)
    }, config.retryAfterSeconds * 1_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    retryTimers.set(id, timer)
  }

  /** 后台按模型调用对应图片上游;成功把 data 存 blob,失败/未知存状态。 */
  async function runImageTask(id: string): Promise<void> {
    const initial = store.get(id)
    if (!initial || initial.status !== 'queued' || admissionControllers.has(id)) return
    const owner = initial.owner || 'legacy-unowned'
    const controller = new AbortController()
    admissionControllers.set(id, controller)
    let permit: { release(): void } | undefined
    let retainInputForRetry = false
    try {
      let queuedBody = blobs.get(id, 'in') as SubmitBody | null
      if (!queuedBody) {
        store.markKnownFailedAndRelease(id, '任务在调用上游前丢失输入，已释放额度')
        return
      }
      const model = String(queuedBody.model ?? GPT_IMAGE_MODEL)
      const seedream = isSeedreamModel(model)
      const admission = seedream ? seedreamAdmission : openaiAdmission
      const rate = seedream ? seedreamRate : openaiRate
      // Do not retain a parsed edit body (which can contain many large data URIs)
      // while it waits for a paid upstream slot. The durable blob is the source of
      // truth and is read again only after admission.
      queuedBody = null
      permit = await admission.acquire(owner, { signal: controller.signal })
      await rate.acquire(config.retryAfterSeconds, controller.signal)
      if (store.get(id)?.status !== 'queued') return
      const body = blobs.get(id, 'in') as SubmitBody | null
      if (!body) {
        store.markKnownFailedAndRelease(id, '任务在调用上游前丢失输入，已释放额度')
        return
      }
      // Old queued rows from before the quota migration have no ledger row.
      // They must reserve an exact current-model quote before the first paid hop.
      store.ensureQueuedReservation(id, taskQuote(body, config.quotaPolicy, now()))
      store.markRunning(id)
      if (seedream) {
        const result = await runSeedream(body, receipt => store.appendProviderReceipt(id, receipt))
        if (result.outputs.length === 0) {
          throw new UpstreamOutcomeUnknownError('Seedream 没有可验证候选，已保留可能产生的付费结果为未知状态')
        }
        try {
          blobs.putOutputs(id, result.outputs)
        } catch (error) {
          throw new UpstreamOutcomeUnknownError(`Seedream 已返回图片，但 relay 无法持久化结果: ${String(error).slice(0, 160)}`)
        }
        store.markSucceeded(id, result.summary)
        return
      }
      const prompt = providerPrompt(body)
      const n = outputCount(body)
      const size = body.size ? String(body.size) : undefined
      const requestUpstream = async (): Promise<{ response: Response; body: string }> => {
        if (body.mode === 'edit') {
          const form = new FormData()
          form.set('model', model)
          form.set('prompt', prompt)
          form.set('n', String(n))
          if (size) form.set('size', size)
          const images = Array.isArray(body.images) ? body.images : []
          let attached = 0
          for (const uri of images) {
            const file = dataUriToFile(String(uri), `image-${attached}.png`)
            if (file) { form.append('image', file); attached++ }
          }
          if (attached === 0) throw new Error('改图任务缺少可用底图(images 为空或非法 data-uri)')
          if (body.mask) {
            const mask = dataUriToFile(String(body.mask), 'mask.png')
            if (mask) form.set('mask', mask)
          }
          return await fetchUpstreamText('OpenAI', `${providerCredentials.baseUrl('openai')}/images/edits`, {
            method: 'POST',
            headers: { authorization: openaiAuthorization },
            body: form,
          })
        }
        const payload: Record<string, unknown> = { model, prompt, n }
        if (size) payload.size = size
        return await fetchUpstreamText('OpenAI', `${providerCredentials.baseUrl('openai')}/images/generations`, {
          method: 'POST',
          headers: { authorization: openaiAuthorization, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }

      const { response: resp, body: text } = await requestUpstream()
      if (!resp.ok) throw new UpstreamResponseError(`OpenAI 请求未被接受: HTTP ${resp.status}`)
      store.appendProviderReceipt(id, upstreamReceiptHash('OpenAI', resp, text))
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : {}
      } catch {
        throw new UpstreamOutcomeUnknownError('OpenAI 已返回成功状态，但响应内容损坏，无法确认生成结果')
      }
      const data = parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data)
        ? (parsed as { data: unknown[] }).data
        : []
      const outputs: RelayCandidate[] = []
      const invalid: CandidateInvalid[] = []
      let partialOutcomeUnknown = data.length !== n
      for (let index = 0; index < n; index += 1) {
        const normalized = normaliseInlineCandidate(data[index], index, config.resultMaxBytes)
        if (normalized.output) outputs.push(normalized.output)
        else if (normalized.invalid) {
          invalid.push(normalized.invalid)
          partialOutcomeUnknown = true
        }
      }
      // Extra records cannot become candidates (the request did not authorize
      // them), but their presence is retained as a safe degraded-result fact.
      // Extra Provider records are not authorized candidates. Keep their count
      // as an audit fact, but do not mark a valid requested index invalid.
      const result = { outputs, summary: partialSummary(n, outputs, invalid, partialOutcomeUnknown, data.length) }
      if (result.outputs.length === 0) {
        throw new UpstreamOutcomeUnknownError('OpenAI 已返回成功状态，但没有可验证候选，可能已经产生费用')
      }
      try {
        blobs.putOutputs(id, result.outputs)
      } catch (error) {
        // The provider already returned a successful image. If persistent result storage
        // is full/unavailable, never report a normal failure that invites a paid retry.
        throw new UpstreamOutcomeUnknownError(`OpenAI 已返回图片，但 relay 无法持久化结果: ${String(error).slice(0, 160)}`)
      }
      store.markSucceeded(id, result.summary)
    } catch (err) {
      const current = store.get(id)
      if (current?.status === 'cancelled') return
      if ((err instanceof ProviderAdmissionError || err instanceof CapacityQueueError) && current?.status === 'queued') {
        retainInputForRetry = true
        scheduleTaskRetry(id)
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      // A receipt (notably the first Seedream output of a multi-output request)
      // or any indeterminate network/read result may already have spent money.
      if (current?.provider_receipt_hash || err instanceof UpstreamOutcomeUnknownError) {
        store.markOutcomeUnknown(id, message)
      } else {
        // Explicit provider rejection and local pre-upstream validation are the
        // only known-unspent failures that release a reservation.
        store.markKnownFailedAndRelease(id, message)
      }
    } finally {
      permit?.release()
      if (admissionControllers.get(id) === controller) admissionControllers.delete(id)
      // Reference images and prompts are needed only while queued/running. Terminal tasks retain
      // result blobs and metadata for polling, but not the sensitive original input body.
      if (!retainInputForRetry) {
        try { blobs.delKind(id, 'in') } finally { refreshActiveInputBytes() }
      }
    }
  }

  // 重启恢复:queued 续跑(读 blob 里的原始输入重新入队);running 通常是
  // failed_unknown，但若 manifest 已先落盘，恢复该可验证结果而绝不重提。
  const recovered = store.recover()
  for (const id of recovered.unknown) {
    const body = blobs.get(id, 'in') as SubmitBody | null
    if (body) {
      try {
        const expectedCount = outputCount(body)
        const seen = new Set<number>()
        for (let deliveryIndex = 0; deliveryIndex < blobs.outputCount(id); deliveryIndex += 1) {
          const raw = blobs.outputAt(id, deliveryIndex)
          const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
          const candidateIndex = Number.isInteger(source?.candidate_index) ? source!.candidate_index as number : deliveryIndex
          if (candidateIndex < 0 || candidateIndex >= expectedCount || seen.has(candidateIndex)) continue
          const normalized = normaliseInlineCandidate(raw, candidateIndex, config.resultMaxBytes)
          if (normalized.output) seen.add(candidateIndex)
        }
        if (seen.size > 0) {
          const invalid: CandidateInvalid[] = []
          for (let index = 0; index < expectedCount; index += 1) {
            if (!seen.has(index)) invalid.push({ index, safe_error_code: 'IMAGE_RESULT_RECOVERED_UNKNOWN' })
          }
          store.recoverSucceededManifestResult(id, {
            expected_count: expectedCount,
            valid_count: seen.size,
            invalid,
            observed_count: blobs.outputCount(id),
            partial_outcome_unknown: true,
          })
        }
      } catch {
        // A malformed input/blob pair has no safe result projection. The
        // failed_unknown state from TaskStore.recover remains authoritative.
      }
    }
    blobs.delKind(id, 'in')
  }
  for (const id of recovered.queued) {
    const inputBytes = blobs.byteLength(id, 'in')
    if (inputBytes !== null) {
      // Pre-budget databases receive 0 from the additive SQLite migration. Re-account their
      // durable input size before resuming, but do not deserialize every queued blob at startup.
      if (store.get(id)?.input_bytes === 0) store.setInputBytes(id, inputBytes)
      void runImageTask(id)
    } else {
      store.markKnownFailedAndRelease(id, '重启后找不到原始输入，调用上游前已失败并释放额度')
      blobs.delKind(id, 'in')
    }
  }
  refreshActiveInputBytes()

  function pollAfterSeconds(rec: Pick<TaskRow, 'status'>): number | undefined {
    // Queued image work may legitimately wait behind the paid provider pool. Tell
    // clients to back off instead of multiplying status reads while capacity drains.
    if (rec.status === 'queued') return config.retryAfterSeconds
    if (rec.status === 'running') return 3
    return undefined
  }

  /**
   * Status-only polling is used by controlled load runners. It deliberately omits
   * b64_json output so observing a terminal task never materializes every image
   * in either the caller or Relay. Desktop result delivery is direct-v1 only.
   */
  function pollResponse(
    rec: TaskRow,
    options: { directResultHandoff?: boolean; owner?: string } = {},
  ): Response {
    const outputCount = rec.status === 'succeeded' ? blobs.outputCount(rec.id) : 0
    const directResultHandoff = options.directResultHandoff === true && outputCount > 0 && !!options.owner
    const grant = directResultHandoff ? resultCredentials.issue(rec.id, options.owner!) : undefined
    let fidelity: InputFidelityCapability | null = null
    if (rec.input_fidelity) { try { fidelity = JSON.parse(rec.input_fidelity) } catch { fidelity = null } }
    let resultSummary: RelayResultSummary | null = null
    if (rec.result_summary) {
      try {
        const parsed = JSON.parse(rec.result_summary) as Partial<RelayResultSummary>
        if (Number.isInteger(parsed.expected_count) && (parsed.expected_count ?? 0) > 0
          && Number.isInteger(parsed.valid_count) && (parsed.valid_count ?? -1) >= 0
          && Number.isInteger(parsed.observed_count) && (parsed.observed_count ?? -1) >= 0
          && Array.isArray(parsed.invalid) && typeof parsed.partial_outcome_unknown === 'boolean') {
          resultSummary = parsed as RelayResultSummary
        }
      } catch {}
    }
    const pollAfter = pollAfterSeconds(rec)
    return Response.json({
      status: rec.status,
      ...(directResultHandoff
        ? {
            // result_url is the legacy single-candidate field. It must remain a
            // real candidate handoff, not the metadata-only grant base URL.
            result_url: resultCredentials.resultUrl(grant!, 0),
            result_urls: Array.from({ length: outputCount }, (_unused, index) => resultCredentials.resultUrl(grant!, index)),
            result_count: outputCount,
          }
        : { metadata_only: true, result_available: outputCount > 0, output_count: outputCount }),
      error: rec.error ?? undefined,
      created: rec.created,
      operation_id: rec.id,
      provider: rec.provider ?? undefined,
      provider_receipt_hash: rec.provider_receipt_hash ?? undefined,
      result_acknowledged: rec.acknowledged_at !== null,
      acknowledged_at: rec.acknowledged_at ?? undefined,
      ...(resultSummary ? resultSummary : {}),
      ...(pollAfter ? { poll_after_seconds: pollAfter } : {}),
      ...(fidelity ? {
        input_fidelity_requested: fidelity.requested,
        input_fidelity_status: fidelity.status,
        ...(fidelity.risk ? { input_fidelity_risk: fidelity.risk } : {}),
      } : {}),
    })
  }

  return async function relayFetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const counts = store.activeCounts()
        const active = counts.queued + counts.running
        const currentActiveInputBytes = refreshActiveInputBytes()
        return Response.json({
          ok: true,
          component_manifest: {
            component: 'billiardbuddy-image-relay',
            identity: 'gateway-introspection',
            result_handoff: 'direct-v1',
          },
          active,
          queued: counts.queued,
          running: counts.running,
          queue_available: Math.max(0, capacity.admission.queue_max - active),
          active_input_bytes: currentActiveInputBytes,
          pending_input_bytes: pendingInputBytes,
          pending_input_bytes_max: capacity.admission.pending_input_bytes_max,
          pending_input_bytes_available: Math.max(0, capacity.admission.pending_input_bytes_max - pendingInputBytes),
          active_input_bytes_max: capacity.admission.active_input_bytes_max,
          active_input_bytes_available: Math.max(0, capacity.admission.active_input_bytes_max - currentActiveInputBytes - pendingInputBytes),
          capacity_policy_revision: capacity.revision,
          quota_policy_revision: config.quotaPolicy.revision,
          provider_capacity: {
            openai: {
              ...openaiAdmission.snapshot(),
              rate: openaiRate.snapshot(),
            },
            seedream: {
              configured: providerCredentials.view('seedream').secret_configured,
              ...seedreamAdmission.snapshot(),
              rate: seedreamRate.snapshot(),
            },
          },
          img_conc: capacity.providers.openai.concurrency,
          img_user_conc: capacity.providers.openai.owner_concurrency,
          seedream_configured: providerCredentials.view('seedream').secret_configured,
          seedream_conc: capacity.providers.seedream.concurrency,
          seedream_user_conc: capacity.providers.seedream.owner_concurrency,
          queue_max: capacity.admission.queue_max,
          user_max: capacity.admission.owner_task_max,
          retry_after_seconds: config.retryAfterSeconds,
          result_delivery_global_concurrency: config.resultGlobalConcurrency,
          result_delivery_owner_concurrency: config.resultOwnerConcurrency,
          result_max_bytes: config.resultMaxBytes,
        }, { headers: { 'Cache-Control': 'no-store' } })
      }
      if (req.method === 'POST' && url.pathname === IMAGE_RELAY_TASKS_PATH) {
        const verified = await identity(req)
        sweep()
        const owner = verified.owner
        const idempotencyKey = (req.headers.get('idempotency-key') ?? '').trim() || null
        if (!idempotencyKey || idempotencyKey.length > 160) {
          throw new HttpError(428, 'relay: 缺少有效的 operation id')
        }
        // 请求体大小上限:先看 content-length 快速拒,再按实际字节校验。
        const declared = Number(req.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > capacity.admission.max_body_bytes) throw new HttpError(413, 'relay: 请求体过大')
        const bodyReservation = await readRequestBodyBounded(
          req,
          capacity.admission.max_body_bytes,
          config.requestBodyTimeoutMs,
          reserveInputBytes,
          releaseInputBytes,
        )
        const raw = bodyReservation.raw
        let persisted = false
        try {
          let body: SubmitBody
          try { body = JSON.parse(Buffer.from(raw).toString('utf8')) as SubmitBody } catch { throw new HttpError(400, 'relay: 请求体不是合法 JSON') }
          if (!body || typeof body !== 'object') throw new HttpError(400, 'relay: 请求体必须是对象')
          if (!String(body.prompt ?? '').trim()) throw new HttpError(400, 'relay: 缺少 prompt')
          validateSubmitBody(body, providerCredentials.view('seedream').secret_configured)
          const inputFingerprint = sha256(raw)
          const provider = taskProvider(body)
          const created = store.createWithReservation({
            id: crypto.randomUUID(),
            owner,
            idempotencyKey,
            inputBytes: raw.byteLength,
            inputFingerprint,
            provider,
            quote: taskQuote(body, config.quotaPolicy, now()),
            queueMax: capacity.admission.queue_max,
            ownerTaskMax: capacity.admission.owner_task_max,
          })
          if (!created.created) {
            const pollAfter = pollAfterSeconds(created.task)
            return Response.json({
              task_id: created.task.id,
              status: created.task.status,
              reused: true,
              ...(pollAfter ? { poll_after_seconds: pollAfter } : {}),
            }, { status: 202 })
          }
          const id = created.task.id
          activeInputBytes += raw.byteLength
          try {
            blobs.put(id, 'in', body) // 持久化原始输入,供重启后续跑
          } catch (error) {
            try { blobs.del(id) } catch {}
            store.removeAndRelease(id)
            refreshActiveInputBytes()
            throw error
          }
          persisted = true
          bodyReservation.release() // SQLite 已持久化这段输入字节，转入 active_input_bytes 统计。
          void runImageTask(id)
          return Response.json({ task_id: id, status: 'queued', poll_after_seconds: config.retryAfterSeconds }, { status: 202 })
        } finally {
          if (!persisted) bodyReservation.release()
        }
      }
      if (req.method === 'GET' && url.pathname.startsWith(`${IMAGE_RELAY_RESULTS_PATH}/`)) {
        const verified = await identity(req)
        sweep()
        const [grant, outputIndexRaw, extra] = url.pathname.slice(`${IMAGE_RELAY_RESULTS_PATH}/`.length).split('/')
        if (!grant || extra !== undefined || (outputIndexRaw !== undefined && !/^\d+$/.test(outputIndexRaw))) {
          throw new HttpError(400, 'relay: 无效结果地址')
        }
        const payload = resultCredentials.verify(grant)
        if (!payload) throw new HttpError(403, 'relay: 结果授权无效或已过期')
        const rec = store.get(payload.task_id)
        if (!rec) return Response.json({ status: 'failed', error: '任务不存在或已过期' }, { status: 404 })
        if (!rec.owner || rec.owner !== verified.owner || !resultCredentials.isOwner(payload, verified.owner)) {
          throw new HttpError(403, 'relay: 结果授权与任务归属不匹配')
        }
        if (rec.status !== 'succeeded') throw new HttpError(409, 'relay: 图片结果尚未就绪')
        if (outputIndexRaw === undefined && blobs.outputCount(rec.id) === 0) throw new HttpError(410, 'relay: 图片结果已确认或已清理')
        if (outputIndexRaw !== undefined) {
          // Acquire before touching the per-output file. A saturated delivery
          // path must reject before JSON.parse/base64 can allocate user bytes.
          const release = resultDelivery.tryAcquire(verified.owner)
          if (!release) throw queueFull('relay: 图片结果交付并发已达上限，请稍后重试')
          let handedOff = false
          try {
          const outputIndex = Number.parseInt(outputIndexRaw, 10)
          const output = blobs.outputAt(rec.id, outputIndex)
          if (output === null) throw new HttpError(404, 'relay: 图片候选不存在')
          const wire = JSON.stringify({ status: 'succeeded', operation_id: rec.id, data: [output] })
          if (Buffer.byteLength(wire) > maxBase64BytesFor(config.resultMaxBytes) + 64 * 1024) {
            throw new HttpError(413, 'relay: 图片结果超过受控交付字节上限')
          }
            const response = retainDeliveryPermit(new Response(wire, {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
            },
            }), release)
            handedOff = true
            return response
          } finally {
            if (!handedOff) release()
          }
        }
        const response = pollResponse(rec)
        const headers = new Headers(response.headers)
        headers.set('Cache-Control', 'private, no-store')
        headers.set('X-Content-Type-Options', 'nosniff')
        return new Response(response.body, { status: response.status, headers })
      }
      if (req.method === 'GET' && url.pathname.startsWith(`${IMAGE_RELAY_IDEMPOTENCY_LOOKUP_PATH}/`)) {
        const verified = await identity(req)
        sweep()
        const encodedKey = url.pathname.slice(`${IMAGE_RELAY_IDEMPOTENCY_LOOKUP_PATH}/`.length)
        if (!encodedKey || encodedKey.includes('/')) throw new HttpError(400, 'relay: 无效 operation id')
        let idempotencyKey: string
        try { idempotencyKey = decodeURIComponent(encodedKey).trim() } catch { throw new HttpError(400, 'relay: 无效 operation id') }
        if (!idempotencyKey || idempotencyKey.length > 160) throw new HttpError(400, 'relay: 无效 operation id')
        const rec = store.findByIdempotency(verified.owner, idempotencyKey)
        if (!rec) {
          return Response.json({ status: 'not_found', error: '没有已持久化的远端任务' }, {
            status: 404,
            headers: { 'Cache-Control': 'no-store' },
          })
        }
        const pollAfter = pollAfterSeconds(rec)
        return Response.json({
          task_id: rec.id,
          operation_id: rec.id,
          status: rec.status,
          reused: true,
          ...(pollAfter ? { poll_after_seconds: pollAfter } : {}),
        }, { headers: { 'Cache-Control': 'no-store' } })
      }
      if (req.method === 'GET' && url.pathname.startsWith(`${IMAGE_RELAY_TASKS_PATH}/`)) {
        const verified = await identity(req)
        sweep()
        const id = url.pathname.slice(`${IMAGE_RELAY_TASKS_PATH}/`.length)
        const rec = store.get(id)
        if (!rec) return Response.json({ status: 'failed', error: '任务不存在或已过期' }, { status: 404 })
        if (rec.owner !== verified.owner) throw new HttpError(403, 'relay: 无权访问该任务')
        return pollResponse(rec, {
          directResultHandoff: req.headers.get(IMAGE_RELAY_RESULT_HANDOFF_HEADER)?.trim() === IMAGE_RELAY_RESULT_HANDOFF_DIRECT_V1,
          owner: verified.owner,
        })
      }
      if (req.method === 'POST' && url.pathname.startsWith(`${IMAGE_RELAY_TASKS_PATH}/`) && url.pathname.endsWith('/ack')) {
        const verified = await identity(req)
        sweep()
        const id = url.pathname.slice(`${IMAGE_RELAY_TASKS_PATH}/`.length, -'/ack'.length)
        if (!id || id.includes('/')) throw new HttpError(400, 'relay: 无效任务 ID')
        const rec = store.get(id)
        if (!rec) return Response.json({ status: 'failed', error: '任务不存在或已过期' }, { status: 404 })
        if (rec.owner !== verified.owner) throw new HttpError(403, 'relay: 无权访问该任务')
        if (rec.status !== 'succeeded') throw new HttpError(409, 'relay: 只能确认已成功的图片结果')
        if (rec.acknowledged_at === null && blobs.outputCount(id) === 0) {
          throw new HttpError(409, 'relay: 结果不完整，不能确认')
        }
        const acknowledgedAt = store.acknowledgeResult(id)
        // Metadata and provider receipt remain pollable until TTL. Repeating ack
        // always deletes a leftover blob, including a crash between DB commit and unlink.
        blobs.delKind(id, 'out')
        return Response.json({
          status: 'succeeded',
          operation_id: id,
          result_acknowledged: true,
          acknowledged_at: acknowledgedAt,
        })
      }
      if (req.method === 'POST' && url.pathname.startsWith(`${IMAGE_RELAY_TASKS_PATH}/`) && url.pathname.endsWith('/cancel')) {
        const verified = await identity(req)
        sweep()
        const id = url.pathname.slice(`${IMAGE_RELAY_TASKS_PATH}/`.length, -'/cancel'.length)
        if (!id || id.includes('/')) throw new HttpError(400, 'relay: 无效任务 ID')
        const rec = store.get(id)
        if (!rec) return Response.json({ status: 'failed', error: '任务不存在或已过期' }, { status: 404 })
        if (rec.owner !== verified.owner) throw new HttpError(403, 'relay: 无权访问该任务')
        if (rec.status !== 'queued') throw new HttpError(409, 'relay: 任务已经开始，不能安全取消')
        const cancelled = store.cancelQueuedAndRelease(id)
        if (!cancelled) throw new HttpError(409, 'relay: 任务已经开始，不能安全取消')
        admissionControllers.get(id)?.abort()
        const retryTimer = retryTimers.get(id)
        if (retryTimer) clearTimeout(retryTimer)
        retryTimers.delete(id)
        refreshActiveInputBytes()
        blobs.delKind(id, 'in')
        return pollResponse(cancelled)
      }
      return new Response('Not found', { status: 404 })
    } catch (err) {
      if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status, headers: err.headers })
      if (err instanceof ImageIdempotencyConflictError) return Response.json({ error: err.message }, { status: 409 })
      if (err instanceof ImageTaskQueueFullError || err instanceof ImageQuotaExceededError) {
        return Response.json({ error: err.message }, { status: 429, headers: queueFull(err.message).headers })
      }
      return Response.json({ error: `relay 内部错误:${String(err).slice(0, 200)}` }, { status: 500 })
    }
  }
}

type RelayRequestTimeoutController = { timeout(request: Request, seconds: number): void }

export function withRelayRequestTimeout(
  handler: (request: Request) => Promise<Response>,
): (request: Request, server?: RelayRequestTimeoutController) => Promise<Response> {
  return (request, server) => {
    // Task submission returns quickly, while a successful poll can send a large
    // Base64 result. Disable Bun's short generic idle timer for the whole protected
    // relay surface; upstream/result helpers retain their own bounded deadlines.
    server?.timeout(request, 0)
    return handler(request)
  }
}

if (import.meta.main) {
  const port = Number(process.env.RELAY_PORT ?? 8790)
  // 只监听 loopback(默认 127.0.0.1)，由 Nginx 暴露受 TLS 和入口上限保护的正式路径。
  // 每个业务请求仍须经 Gateway introspection 验证安装 bearer；绝不直接绑定公网口。
  const hostname = process.env.RELAY_HOST ?? '127.0.0.1'
  const handler = createRelayFetch({ env: process.env }) // 配置非法(身份、结果或 Provider 凭据缺失)会在此抛错
  Bun.serve({ hostname, port, fetch: withRelayRequestTimeout(handler) })
  console.log(`[relay] 生图异步任务服务监听 ${hostname}:${port}`)
}
