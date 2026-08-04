import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Database } from 'bun:sqlite'
import {
  canonicalRelayRequestHash,
  completeMediaObjectLeaseRequestSchema,
  createMediaObjectLeaseRequestSchema,
  createVideoRelayOperationRequestSchema,
  mediaObjectLeaseSchema,
  operationAcknowledgementSchema,
  videoMediaOperationByLocalOperationPath,
  VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS,
  VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES,
  type CreateVideoRelayOperationRequest,
  type ProviderExecutionReceipt,
} from './contracts/relayApi.ts'
import { DashScopeProviderError, DashScopeVideoProvider } from './providers/dashscope.ts'
import { ObjectVerificationError, OssObjectStore, type ObjectMetadata, type ObjectStoreRequest, type ObjectVerificationRequest, type RelayObjectStore } from './objectStore.ts'
import { videoProviderFor } from './providerRegistry.ts'
import { localVideoMediaAdmissionBackend, videoMediaCapacityPolicyFromEnvironment, videoMediaIdentityAdmissionPolicyFromEnvironment, videoMediaLaneForWorkload, videoMediaObjectVerificationPolicyFromEnvironment, videoMediaProviderAccountScope, videoMediaProviderLaneScope, type VideoMediaAdmissionBackend, type VideoMediaAdmissionGate, type VideoMediaCapacityLane, type VideoMediaRateGate } from './capacityPolicy.ts'
import {
  loadVideoMediaRelayIdentityIntrospector,
  VideoMediaRelayIdentityError,
  type VideoMediaRelayIdentity,
} from './identityIntrospection.ts'
import {
  CapacityQueueError,
  ProviderAdmissionError,
  type ProviderAdmissionPermit,
} from '../ts/shared/kernel/providerAdmission.js'

type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Identity = VideoMediaRelayIdentity
export type MediaObjectStore = RelayObjectStore
export type VideoMediaProviderExecutionOptions = {
  signal?: AbortSignal
  /** Long-running providers call this immediately after their upstream task id
   * is parsed. The Relay durably records it before execute() may return. */
  onAccepted?: (accepted: { provider_task_id: string; receipt: ProviderExecutionReceipt }) => Promise<void>
}
export type VideoMediaProvider = {
  execute(input: CreateVideoRelayOperationRequest, identity: Identity, media?: { object_urls: string[]; object_byte_sizes: number[] }, options?: VideoMediaProviderExecutionOptions): Promise<{ state: 'succeeded' | 'submitted' | 'running'; provider_task_id?: string; result_object_refs?: string[]; receipt: ProviderExecutionReceipt; result?: unknown }>
  poll?(input: CreateVideoRelayOperationRequest, providerTaskId: string, identity: Identity, media?: { object_urls: string[]; object_byte_sizes: number[] }, options?: { signal?: AbortSignal }): Promise<{ state: 'succeeded' | 'submitted' | 'running' | 'failed' | 'expired' | 'cancelled'; provider_task_id?: string; receipt: ProviderExecutionReceipt; result?: unknown; safe_error_code?: string }>
  /** A void/network return is deliberately not a cancellation proof. */
  cancel?(providerTaskId: string, options?: { signal?: AbortSignal }): Promise<{ cancelled: true; receipt?: ProviderExecutionReceipt } | void>
}

type RelayDeps = { env?: Env; fetchImpl?: FetchLike; objectStore?: MediaObjectStore; provider?: VideoMediaProvider; now?: () => Date; admissionBackend?: VideoMediaAdmissionBackend }
type Row = Record<string, unknown>
const requestId = () => `req_${randomUUID().replaceAll('-', '')}`
const iso = (now: () => Date) => now().toISOString()
const opaque = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`

class RelayError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
/** Another request owns the durable before-provider fence for this operation. */
class ProviderSubmissionAlreadyFenced extends Error {}
function isOutcomeUnknown(error: unknown): boolean {
  // A typed 4xx response proves that no billable provider outcome was
  // accepted. Every transport/server failure and every unclassified failure
  // is ambiguous: keep its account reservation and its input lease for
  // reconciliation instead of silently releasing either one.
  return !(error instanceof RelayError || error instanceof DashScopeProviderError) || error.status >= 500
}
function safeFailureCode(error: unknown): string {
  return error instanceof RelayError || error instanceof DashScopeProviderError ? error.code : 'provider_outcome_unknown'
}
function json(data: unknown, status = 200, id = requestId()): Response { return Response.json(data, { status, headers: { 'X-Request-Id': id, 'Cache-Control': 'no-store' } }) }
function digest(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}` }
function reconcileProviderReceipt(previous: ProviderExecutionReceipt | null, next: ProviderExecutionReceipt): ProviderExecutionReceipt {
  if (!previous) return next
  // Polling a long ASR task is not a second paid inference. Keep the one
  // operation receipt, carrying forward its actual upload dimensions while
  // accepting final provider-measured duration/cost fields.
  return {
    ...next,
    usage: {
      requests: Math.max(previous.usage.requests, next.usage.requests),
      total_tokens: Math.max(previous.usage.total_tokens, next.usage.total_tokens),
      input_bytes: Math.max(previous.usage.input_bytes, next.usage.input_bytes),
      visual_frames: Math.max(previous.usage.visual_frames, next.usage.visual_frames),
      proxy_seconds: Math.max(previous.usage.proxy_seconds, next.usage.proxy_seconds),
      asr_seconds: Math.max(previous.usage.asr_seconds, next.usage.asr_seconds),
      estimated_amount_micros: Math.max(previous.usage.estimated_amount_micros, next.usage.estimated_amount_micros),
    },
  }
}
function authorization(request: Request): string {
  const value = request.headers.get('authorization') ?? ''
  if (!value.toLowerCase().startsWith('bearer ') || !value.slice(7).trim()) throw new RelayError(401, 'missing_installation_access_token')
  return value.slice(7).trim()
}
function requireControlHeaders(request: Request): string {
  const key = request.headers.get('idempotency-key')?.trim() ?? ''
  const timestamp = request.headers.get('x-request-timestamp')?.trim() ?? ''
  const instant = Date.parse(timestamp)
  if (key.length < 16 || key.length > 160) throw new RelayError(422, 'idempotency_key_required')
  if (!Number.isFinite(instant) || Math.abs(Date.now() - instant) > 5 * 60_000) throw new RelayError(422, 'request_timestamp_invalid')
  return key
}
async function body(request: Request, timeoutMs: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RelayError(415, 'json_content_type_required')
  const maxBytes = 2 * 1024 * 1024
  const contentLength = request.headers.get('content-length')?.trim()
  if (contentLength) {
    if (!/^[0-9]+$/.test(contentLength)) throw new RelayError(400, 'content_length_invalid')
    if (Number(contentLength) > maxBytes) throw new RelayError(413, 'control_body_too_large')
  }
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    if (request.signal.aborted) {
      void reader.cancel(request.signal.reason).catch(() => { /* caller abort stays authoritative */ })
      try { reader.releaseLock() } catch { /* do not replace the 499 */ }
      throw new RelayError(499, 'request_aborted')
    }
    let rejectRead!: (reason: RelayError) => void
    const interrupted = new Promise<never>((_, reject) => { rejectRead = reject })
    const onAbort = () => {
      const aborted = new RelayError(499, 'request_aborted')
      rejectRead(aborted)
      void reader.cancel(aborted).catch(() => { /* caller abort stays authoritative */ })
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      const timeout = new RelayError(408, 'control_body_timeout')
      rejectRead(timeout)
      void reader.cancel(timeout).catch(() => { /* deadline remains authoritative */ })
    }, timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), interrupted])
        if (done) break
        if (!value) continue
        size += value.byteLength
        if (size > maxBytes) {
          try { await reader.cancel() } catch { /* byte cap remains authoritative */ }
          throw new RelayError(413, 'control_body_too_large')
        }
        chunks.push(value)
      }
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', onAbort)
      try { reader.releaseLock() } catch { /* preserve byte/deadline/abort error */ }
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new RelayError(400, 'invalid_json') }
  try { return JSON.parse(raw) } catch { throw new RelayError(400, 'invalid_json') }
}
function ttl(env: Env): number { return Math.max(60_000, Math.min(60 * 60_000, Number(env.VIDEO_MEDIA_LEASE_TTL_MS ?? 15 * 60_000))) }
function outcomeUnknownRetention(env: Env): number { return Math.max(ttl(env), Math.min(7 * 24 * 60 * 60_000, Number(env.VIDEO_MEDIA_OUTCOME_UNKNOWN_RETENTION_MS ?? 72 * 60 * 60_000))) }
function multipartThreshold(env: Env): number { return Math.max(5 * 1024 * 1024, Number(env.VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES ?? 8 * 1024 * 1024)) }
function multipartPartSize(env: Env): number { return Math.max(1024 * 1024, Math.min(512 * 1024 * 1024, Number(env.VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES ?? 8 * 1024 * 1024))) }
function boundedEnvInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}
function controlBodyTimeout(env: Env): number {
  return boundedEnvInt(env, 'VIDEO_MEDIA_CONTROL_BODY_TIMEOUT_MS', 30_000, 1_000, 120_000)
}
type VideoMediaQuotaPolicy = {
  revision: string
  owner_daily_units: number
  account_daily_units: number
  /** Resolved from the deployment-owned physical-account capacity binding. */
  account_key: string
}
function videoMediaQuotaPolicyFromEnvironment(env: Env, accountKey: string): VideoMediaQuotaPolicy {
  const revision = env.VIDEO_MEDIA_QUOTA_POLICY_REVISION?.trim() || 'video-media-small-v1'
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(revision)) throw new Error('VIDEO_MEDIA_QUOTA_POLICY_REVISION is invalid')
  return Object.freeze({
    revision,
    owner_daily_units: boundedEnvInt(env, 'VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS', 50_000, 1, 1_000_000_000),
    account_daily_units: boundedEnvInt(env, 'VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS', 1_000_000, 1, 1_000_000_000),
    account_key: accountKey,
  })
}
function utcDay(now: Date): string { return now.toISOString().slice(0, 10) }
function assertLeasePurposeAndMime(input: { purpose: string; content_type: string }): void {
  const mime = input.content_type.toLowerCase().split(';', 1)[0]!.trim()
  const permitted: Record<string, readonly string[]> = {
    visual_frames: ['image/png', 'image/jpeg', 'image/webp'],
    proxy_video: ['video/mp4', 'video/quicktime'],
    audio_for_asr: ['audio/wav', 'audio/mpeg', 'audio/mp4'],
    transcript_for_reasoning: ['application/json', 'text/plain'],
  }
  if (!permitted[input.purpose]?.includes(mime)) throw new RelayError(422, 'lease_purpose_mime_mismatch')
}

class RelayStore {
  readonly db: Database
  constructor(path: string, private readonly now: () => Date, accountKey: string) {
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS video_media_idempotency_v1(owner TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS video_media_leases_v1(id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_operation_id TEXT NOT NULL, purpose TEXT NOT NULL, content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL, content_type TEXT NOT NULL, consent_revision_id TEXT NOT NULL, consent_scope_hash TEXT NOT NULL, state TEXT NOT NULL, object_ref TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, multipart_upload_id TEXT, multipart_part_size INTEGER, multipart_phase TEXT, multipart_parts_json TEXT);
      CREATE TABLE IF NOT EXISTS video_media_operations_v1(id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL, provider_task_id TEXT, result_object_refs TEXT, provider_receipt TEXT, account_quota_reservation_id TEXT NOT NULL, safe_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT, submission_started_at TEXT, UNIQUE(owner,local_operation_id));
      CREATE TABLE IF NOT EXISTS video_media_result_objects_v1(object_ref TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES video_media_operations_v1(id), content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL, content_type TEXT NOT NULL, expires_at TEXT NOT NULL, acknowledged_at TEXT, state TEXT NOT NULL DEFAULT 'published', publication_state TEXT, publication_provider_task_id TEXT, publication_receipt TEXT, publication_safe_error_code TEXT, payload BLOB);
      CREATE TABLE IF NOT EXISTS video_media_object_cleanup_v1(id TEXT PRIMARY KEY, object_kind TEXT NOT NULL, lease_id TEXT NOT NULL, object_ref TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, completed_at TEXT, last_error TEXT, phase TEXT NOT NULL DEFAULT 'active', UNIQUE(object_kind,lease_id,object_ref));
      CREATE TABLE IF NOT EXISTS video_media_quota_v1(owner TEXT NOT NULL, reservation_id TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL, units INTEGER NOT NULL, period TEXT NOT NULL, policy_revision TEXT NOT NULL, account_key TEXT NOT NULL, settled_units INTEGER NOT NULL DEFAULT 0, actual_usage_json TEXT, created_at TEXT NOT NULL, settled_at TEXT, PRIMARY KEY(owner,reservation_id));
      CREATE TABLE IF NOT EXISTS video_media_lease_quota_v1(owner TEXT NOT NULL, lease_id TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL, units INTEGER NOT NULL);`)
    // Read-only compatibility for operations created by the pre-lease Relay.
    // New code never writes this column and the endpoint below is not part of
    // the new wire contract.
    try { this.db.exec('ALTER TABLE video_media_operations_v1 ADD COLUMN result_json TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_upload_id TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_part_size INTEGER') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_phase TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_parts_json TEXT') } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_result_objects_v1 ADD COLUMN state TEXT NOT NULL DEFAULT 'published'") } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_result_objects_v1 ADD COLUMN publication_state TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_result_objects_v1 ADD COLUMN publication_provider_task_id TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_result_objects_v1 ADD COLUMN publication_receipt TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_result_objects_v1 ADD COLUMN publication_safe_error_code TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_result_objects_v1 ADD COLUMN payload BLOB') } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_object_cleanup_v1 ADD COLUMN phase TEXT NOT NULL DEFAULT 'active'") } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_operations_v1 ADD COLUMN submission_started_at TEXT') } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_quota_v1 ADD COLUMN period TEXT") } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_quota_v1 ADD COLUMN policy_revision TEXT") } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_quota_v1 ADD COLUMN account_key TEXT") } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_quota_v1 ADD COLUMN settled_units INTEGER NOT NULL DEFAULT 0") } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_quota_v1 ADD COLUMN actual_usage_json TEXT") } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_quota_v1 ADD COLUMN created_at TEXT") } catch { /* already present */ }
    try { this.db.exec("ALTER TABLE video_media_quota_v1 ADD COLUMN settled_at TEXT") } catch { /* already present */ }
    // The pre-ledger schema had no timestamp. Preserve every reservation by
    // assigning it the migration UTC day rather than silently dropping it.
    this.db.query("UPDATE video_media_quota_v1 SET period=COALESCE(period,strftime('%Y-%m-%d','now')),policy_revision=COALESCE(policy_revision,'legacy-v1'),account_key=COALESCE(account_key,'video-dashscope-account'),settled_units=CASE WHEN settled_units IS NULL OR settled_units<1 THEN units ELSE settled_units END,created_at=COALESCE(created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE period IS NULL OR policy_revision IS NULL OR account_key IS NULL OR created_at IS NULL").run()
    // `video-dashscope-account` identified every physical account before the
    // binding existed. Upgrade those rows exactly once to the first explicit
    // binding that opens this database; later account moves retain their own
    // historical key instead of being reclassified under the new account.
    this.db.query("UPDATE video_media_quota_v1 SET account_key=? WHERE account_key='video-dashscope-account'").run(accountKey)
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  replay(owner: string, key: string, hash: string): string | null {
    const row = this.db.query('SELECT request_hash,resource_id FROM video_media_idempotency_v1 WHERE owner=? AND key=?').get(owner, key) as { request_hash: string; resource_id: string } | null
    if (!row) return null
    if (row.request_hash !== hash) throw new RelayError(409, 'idempotency_conflict')
    return row.resource_id
  }
  reserve(owner: string, operationId: string, units: number, policy: VideoMediaQuotaPolicy): string {
    const period = utcDay(this.now())
    const charged = "CASE WHEN state='settled' THEN settled_units ELSE units END"
    const ownerTotal = this.db.query(`SELECT COALESCE(SUM(${charged}),0) AS total FROM video_media_quota_v1 WHERE owner=? AND period=? AND state IN ('reserved','outcome_unknown','settled')`).get(owner, period) as { total: number }
    if (ownerTotal.total + units > policy.owner_daily_units) throw new RelayError(429, 'owner_daily_quota_exceeded')
    const accountTotal = this.db.query(`SELECT COALESCE(SUM(${charged}),0) AS total FROM video_media_quota_v1 WHERE account_key=? AND period=? AND state IN ('reserved','outcome_unknown','settled')`).get(policy.account_key, period) as { total: number }
    if (accountTotal.total + units > policy.account_daily_units) throw new RelayError(429, 'account_daily_quota_exceeded')
    const id = opaque('quota')
    this.db.query("INSERT INTO video_media_quota_v1(owner,reservation_id,operation_id,state,units,period,policy_revision,account_key,settled_units,actual_usage_json,created_at,settled_at) VALUES(?,?,?,'reserved',?,?,?,?,0,NULL,?,NULL)")
      .run(owner, id, operationId, units, period, policy.revision, policy.account_key, iso(this.now))
    return id
  }
  settleQuota(reservationId: string, receipt?: ProviderExecutionReceipt): void {
    const row = this.db.query('SELECT units FROM video_media_quota_v1 WHERE reservation_id=?').get(reservationId) as { units: number } | null
    if (!row) throw new RelayError(503, 'quota_reservation_missing')
    // The policy unit is deliberately conservative and provider-neutral. The
    // complete receipt is retained for billing/audit; a settled operation can
    // never consume less than its original durable reservation.
    const actualUnits = Math.max(row.units, receipt?.usage.requests ?? 0)
    const actualUsage = receipt ? JSON.stringify(receipt.usage) : null
    this.db.query("UPDATE video_media_quota_v1 SET state='settled',settled_units=?,actual_usage_json=COALESCE(?,actual_usage_json),settled_at=? WHERE reservation_id=? AND state IN ('reserved','outcome_unknown','settled')")
      .run(actualUnits, actualUsage, iso(this.now), reservationId)
  }
  retainUnknownQuota(reservationId: string): void {
    this.db.query("UPDATE video_media_quota_v1 SET state='outcome_unknown' WHERE reservation_id=? AND state='reserved'").run(reservationId)
  }
  releaseQuota(reservationId: string): void {
    this.db.query("UPDATE video_media_quota_v1 SET state='released' WHERE reservation_id=? AND state='reserved'").run(reservationId)
  }
  reserveLease(owner: string, leaseId: string, limit: number): void {
    const active = this.db.query("SELECT COALESCE(SUM(units),0) AS total FROM video_media_lease_quota_v1 WHERE owner=? AND state IN ('reserved','outcome_unknown')").get(owner) as { total: number }
    if (active.total + 1 > limit) throw new RelayError(429, 'object_lease_quota_exceeded')
    this.db.query("INSERT INTO video_media_lease_quota_v1(owner,lease_id,state,units) VALUES(?,?, 'reserved',1)").run(owner, leaseId)
  }
  releaseLease(leaseId: string): void { this.db.query("UPDATE video_media_lease_quota_v1 SET state='released' WHERE lease_id=? AND state IN ('reserved','outcome_unknown')").run(leaseId) }
  projection(id: string) {
    const row = this.db.query('SELECT * FROM video_media_operations_v1 WHERE id=?').get(id) as Row | null
    if (!row) throw new RelayError(404, 'operation_not_found')
    return {
      id: row.id, state: row.state, ...(row.provider_task_id ? { provider_task_id: row.provider_task_id } : {}), ...(row.result_object_refs ? { result_object_refs: JSON.parse(row.result_object_refs as string) } : {}), ...(row.provider_receipt ? { provider_receipt: JSON.parse(row.provider_receipt as string) } : {}), account_quota_reservation_id: row.account_quota_reservation_id, ...(row.safe_error_code ? { safe_error_code: row.safe_error_code } : {}), created_at: row.created_at, updated_at: row.updated_at,
    }
  }
}

function defaultObjectStore(env: Env, admissionBackend: VideoMediaAdmissionBackend): MediaObjectStore {
  const endpoint = env.VIDEO_MEDIA_OSS_ENDPOINT?.trim()
  const bucket = env.VIDEO_MEDIA_OSS_BUCKET?.trim()
  const accessKeyId = env.VIDEO_MEDIA_OSS_ACCESS_KEY_ID?.trim()
  const accessKeySecret = env.VIDEO_MEDIA_OSS_ACCESS_KEY_SECRET?.trim()
  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
    const unavailable = async (): Promise<never> => { throw new RelayError(503, 'object_store_unavailable') }
    return { createPutUrl: unavailable, head: unavailable, delete: unavailable, createReadUrl: unavailable, putResult: unavailable, createResultReadUrl: unavailable, deleteResult: unavailable, createMultipartUpload: unavailable, createMultipartPartPutUrl: unavailable, listMultipartParts: unavailable, completeMultipartUpload: unavailable, abortMultipartUpload: unavailable }
  }
  return new OssObjectStore({ endpoint, bucket, accessKeyId, accessKeySecret, region: 'oss-cn-beijing', objectVerification: videoMediaObjectVerificationPolicyFromEnvironment(env), admissionBackend })
}
function defaultProvider(now: () => Date): VideoMediaProvider {
  return { async execute(input) {
    const capability = input.capability
    const receipt: ProviderExecutionReceipt = { id: opaque('receipt'), capability, model_snapshot: capability === 'visual_evidence' ? 'qwen3-vl-flash' : capability === 'media_reasoning' ? 'qwen3.6-flash' : capability === 'speech_transcription' ? (input.input.mode === 'short_sync' ? 'fun-asr-flash-2026-06-15' : 'fun-asr') : 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'video-media-v1', input_basis_hash: input.request_hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: capability === 'visual_evidence' ? input.input.object_refs.length : 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: iso(now) }
    // A configured deployment replaces this adapter with provider adapters. It
    // fails closed: no fake evidence, transcript or embedding is persisted.
    throw new RelayError(503, 'provider_not_configured')
  } }
}

export function createVideoMediaRelayFetch(deps: RelayDeps = {}) {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const processStartedAt = iso(now)
  const acceptedOrphanGraceMs = boundedEnvInt(env, 'VIDEO_MEDIA_ACCEPTED_ORPHAN_GRACE_MS', 60_000, 1_000, 10 * 60_000)
  const capacity = videoMediaCapacityPolicyFromEnvironment(env)
  const quotaPolicy = videoMediaQuotaPolicyFromEnvironment(env, capacity.account.account_key)
  const store = new RelayStore(env.VIDEO_MEDIA_RELAY_DB ?? ':memory:', now, capacity.account.account_key)
  const fetchImpl = deps.fetchImpl ?? fetch
  const admissionBackend = deps.admissionBackend ?? localVideoMediaAdmissionBackend
  const objectStore = deps.objectStore ?? defaultObjectStore(env, admissionBackend)
  const objectLeaseQuotaUnits = boundedEnvInt(env, 'VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS', 1_000, 1, 1_000_000)
  const provider = deps.provider ?? (env.VIDEO_MEDIA_DASHSCOPE_API_KEY?.trim()
    ? new DashScopeVideoProvider({
      apiKey: env.VIDEO_MEDIA_DASHSCOPE_API_KEY,
      fetchImpl,
      now,
      asrBaseUrl: env.VIDEO_MEDIA_DASHSCOPE_ASR_BASE_URL?.trim() || undefined,
      timeoutMs: boundedEnvInt(env, 'VIDEO_MEDIA_DASHSCOPE_TIMEOUT_MS', 120_000, 1_000, 10 * 60_000),
      responseMaxBytes: boundedEnvInt(env, 'VIDEO_MEDIA_DASHSCOPE_RESPONSE_MAX_BYTES', 4 * 1024 * 1024, 1_024, 4 * 1024 * 1024),
      transcriptMaxBytes: boundedEnvInt(env, 'VIDEO_MEDIA_DASHSCOPE_TRANSCRIPT_MAX_BYTES', VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES, 1_024, VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES),
    })
    : defaultProvider(now))
  const objectVerification = videoMediaObjectVerificationPolicyFromEnvironment(env)
  const identityAdmission = videoMediaIdentityAdmissionPolicyFromEnvironment(env)
  const accountAdmission = admissionBackend.createGate({
    maxActive: capacity.account.max_active,
    maxActivePerOwner: capacity.account.max_active_per_owner,
    maxQueued: capacity.account.max_queued,
    maxQueuedPerOwner: capacity.account.max_queued_per_owner,
    maxWaitMs: capacity.account.max_wait_ms,
  }, videoMediaProviderAccountScope(capacity.account.account_key))
  const accountRate = admissionBackend.createRateGate(
    capacity.account.requests_per_minute,
    capacity.account.max_queued,
    videoMediaProviderAccountScope(capacity.account.account_key),
  )
  /** Same-process publications are not crash remnants. Startup/periodic
   * recovery skips these entries and only cleans a publishing record after the
   * process that owned it is gone. */
  const activeResultPublications = new Set<string>()
  /** A provider-start marker becomes unrecoverable only after this process is
   * gone. A concurrent GET must not mistake the currently executing request
   * for a crash and change its state underneath it. */
  const activeProviderSubmissions = new Set<string>()
  /** Per-operation in-process fence. SQLite remains the durable/future
   * multi-instance fencing point; this avoids duplicate polls/results in the
   * current single Relay process. */
  const operationLocks = new Map<string, Promise<void>>()
  async function withOperationLock<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const previous = operationLocks.get(operationId) ?? Promise.resolve()
    let unlock!: () => void
    const own = new Promise<void>(resolve => { unlock = resolve })
    const tail = previous.then(() => own)
    operationLocks.set(operationId, tail)
    await previous
    try {
      return await task()
    } finally {
      unlock()
      if (operationLocks.get(operationId) === tail) operationLocks.delete(operationId)
    }
  }
  const laneAdmissions = new Map<VideoMediaCapacityLane, VideoMediaAdmissionGate>()
  const laneRates = new Map<VideoMediaCapacityLane, VideoMediaRateGate>()
  for (const [lane, lanePolicy] of Object.entries(capacity.lanes) as Array<[VideoMediaCapacityLane, typeof capacity.lanes[VideoMediaCapacityLane]]>) {
    laneAdmissions.set(lane, admissionBackend.createGate({
      maxActive: lanePolicy.max_active,
      maxActivePerOwner: lanePolicy.max_active_per_owner,
      maxQueued: lanePolicy.max_queued,
      maxQueuedPerOwner: lanePolicy.max_queued_per_owner,
      maxWaitMs: lanePolicy.max_wait_ms,
    }, videoMediaProviderLaneScope(capacity.account.account_key, lane)))
    laneRates.set(lane, admissionBackend.createRateGate(
      lanePolicy.requests_per_minute,
      lanePolicy.max_queued,
      videoMediaProviderLaneScope(capacity.account.account_key, lane),
    ))
  }
  const capacityFailure = (error: unknown): RelayError => {
    if (error instanceof ProviderAdmissionError) {
      return new RelayError(error.status, error.code === 'ADMISSION_ABORTED' ? 'provider_admission_cancelled' : 'provider_capacity_unavailable')
    }
    if (error instanceof CapacityQueueError) {
      return new RelayError(error.status, error.status === 499 ? 'provider_admission_cancelled' : 'provider_rate_limited')
    }
    return new RelayError(503, 'provider_capacity_unavailable')
  }
  async function acquireProviderCapacity(input: CreateVideoRelayOperationRequest, owner: string, signal?: AbortSignal): Promise<ProviderAdmissionPermit> {
    const descriptor = videoProviderFor(input)
    const lane = videoMediaLaneForWorkload(descriptor.workload)
    if (descriptor.binding.capacity_lane !== lane) throw new RelayError(503, 'provider_capacity_lane_mismatch')
    const laneAdmission = laneAdmissions.get(lane)
    const laneRate = laneRates.get(lane)
    if (!laneAdmission || !laneRate) throw new RelayError(503, 'provider_capacity_unavailable')
    let lanePermit: ProviderAdmissionPermit | undefined
    let accountPermit: ProviderAdmissionPermit | undefined
    try {
      // The lane preserves fair access between owners of a given workload;
      // the account gate remains the real ceiling for the shared DashScope key.
      lanePermit = await laneAdmission.acquire(owner, { signal })
      accountPermit = await accountAdmission.acquire(owner, { signal })
      await laneRate.acquire(Math.ceil(capacity.lanes[lane].max_wait_ms / 1_000), signal)
      await accountRate.acquire(Math.ceil(capacity.account.max_wait_ms / 1_000), signal)
      let released = false
      return {
        async assertCurrent() {
          if (released) throw new ProviderAdmissionError('ADMISSION_CLOSED', 503)
          await lanePermit?.assertCurrent?.()
          await accountPermit?.assertCurrent?.()
        },
        release() {
          released = true
          accountPermit?.release()
          lanePermit?.release()
          accountPermit = undefined
          lanePermit = undefined
        },
      }
    } catch (error) {
      accountPermit?.release()
      lanePermit?.release()
      throw capacityFailure(error)
    }
  }
  const leaseRow = (id: string): Row => {
    const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=?').get(id) as Row | null
    if (!row) throw new RelayError(409, 'lease_recovery_missing')
    return row
  }
  const verificationRequest = (row: Row, signal?: AbortSignal): ObjectVerificationRequest => ({
    owner: row.owner as string,
    signal,
    // Queue wait and stream read are separately bounded.  Supplying one
    // absolute deadline means a caller cannot keep a verification alive after
    // both bounded windows, even if it reconnects or retries a lease endpoint.
    deadlineAt: Date.now() + objectVerification.max_wait_ms + objectVerification.timeout_ms,
    expectedByteSize: row.byte_size as number,
  })
  const objectStoreRequest = (owner: string, signal?: AbortSignal): ObjectStoreRequest => ({
    owner,
    signal,
    deadlineAt: Date.now() + objectVerification.max_wait_ms + objectVerification.timeout_ms,
  })
  function expireLease(row: Row): void {
    store.transaction(() => {
      store.db.query("UPDATE video_media_leases_v1 SET state='expired' WHERE id=? AND state IN ('awaiting_upload','ready','bound')").run(row.id)
      store.releaseLease(row.id as string)
      queueLeaseCleanup(row.id as string)
    })
  }
  const retainOutcomeUnknownInputs = (input: CreateVideoRelayOperationRequest, owner: string): void => {
    const refs = input.capability === 'speech_transcription' ? [input.input.audio_object_ref] : input.capability === 'visual_evidence' || input.capability === 'media_reasoning' ? input.input.object_refs : []
    const expiresAt = new Date(now().getTime() + outcomeUnknownRetention(env)).toISOString()
    for (const ref of refs) {
      store.db.query("UPDATE video_media_leases_v1 SET state='bound',expires_at=? WHERE owner=? AND object_ref=? AND state IN ('ready','bound')").run(expiresAt, owner, ref)
      const lease = store.db.query('SELECT id FROM video_media_leases_v1 WHERE owner=? AND object_ref=?').get(owner, ref) as { id: string } | null
      if (lease) store.db.query("UPDATE video_media_lease_quota_v1 SET state='outcome_unknown' WHERE lease_id=? AND state='reserved'").run(lease.id)
    }
  }
  const verified = (row: Row, actual: Awaited<ReturnType<MediaObjectStore['head']>>): boolean => Boolean(actual && actual.byte_size === row.byte_size && actual.content_hash === row.content_hash && actual.content_type === row.content_type)
  async function abortFailedMultipart(row: Row, uploadId: string, cause: unknown): Promise<never> {
    if (!objectStore.abortMultipartUpload) throw new RelayError(503, 'multipart_abort_unavailable')
    try {
      await objectStore.abortMultipartUpload({ leaseId: row.id as string, uploadId }, verificationRequest(row))
    } catch {
      // Do not pretend the failed session has gone away. A later recovery call
      // will retry abort instead of issuing more part or complete requests.
      store.db.query("UPDATE video_media_leases_v1 SET multipart_phase='aborting' WHERE id=?").run(row.id)
      throw new RelayError(503, 'multipart_abort_failed')
    }
    // CompleteMultipartUpload can have committed an object even though the
    // subsequent HEAD validation failed. Abort only closes the multipart
    // session; delete the object itself through the durable retry queue.
    store.db.query("UPDATE video_media_leases_v1 SET multipart_phase='cleanup_pending' WHERE id=?").run(row.id)
    // Abort was already confirmed above; persist only the subsequent object
    // deletion stage so a retry never mistakes this object for fully cleaned.
    queueCleanup('input', { leaseId: row.id as string }, 'active')
    await retryObjectCleanup()
    if (leaseRow(row.id as string).state !== 'deleted') throw new RelayError(503, 'multipart_object_cleanup_pending')
    if (cause instanceof RelayError) throw cause
    throw new RelayError(503, 'multipart_completion_failed')
  }
  async function recoverMultipart(row: Row, verification?: ObjectVerificationRequest): Promise<Row> {
    const phase = row.multipart_phase as string | null
    if (!phase || !['initializing', 'completing', 'aborting', 'cleanup_pending'].includes(phase)) return row
    let uploadId = row.multipart_upload_id as string | null
    if (phase === 'aborting') {
      if (!uploadId) throw new RelayError(503, 'multipart_abort_missing_upload')
      return await abortFailedMultipart(row, uploadId, new RelayError(503, 'multipart_aborted'))
    }
    if (phase === 'cleanup_pending') {
      queueLeaseCleanup(row.id as string)
      await retryObjectCleanup()
      const cleaned = leaseRow(row.id as string)
      if (cleaned.state !== 'deleted') throw new RelayError(503, 'multipart_object_cleanup_pending')
      return cleaned
    }
    if (phase === 'initializing') {
      if (!uploadId) {
        const request = verification ?? verificationRequest(row)
        const recovered = objectStore.findMultipartUploads ? await objectStore.findMultipartUploads({ leaseId: row.id as string }, request) : []
        uploadId = recovered[0]?.uploadId ?? (await objectStore.createMultipartUpload?.({ leaseId: row.id as string, hash: row.content_hash as string, byteSize: row.byte_size as number, contentType: row.content_type as string }, request))?.uploadId ?? null
        if (!uploadId) throw new RelayError(503, 'object_store_multipart_unavailable')
      }
      store.db.query("UPDATE video_media_leases_v1 SET multipart_upload_id=?,multipart_phase='uploading' WHERE id=?").run(uploadId, row.id)
      return leaseRow(row.id as string)
    }
    if (!uploadId || !row.multipart_parts_json || !objectStore.completeMultipartUpload) throw new RelayError(503, 'multipart_completion_recovery_unavailable')
    try {
      const parts = completeMediaObjectLeaseRequestSchema.parse(JSON.parse(row.multipart_parts_json as string)).parts ?? []
      const request = verification ?? verificationRequest(row)
      let actual = await objectStore.head(row.id as string, request)
      if (!verified(row, actual)) {
        try {
          await objectStore.completeMultipartUpload({ leaseId: row.id as string, uploadId, parts }, request)
        } catch (error) {
          // A timeout can race a successful CompleteMultipartUpload response.
          // Probe the object once before aborting the still-open upload.
          actual = await objectStore.head(row.id as string, request)
          if (!verified(row, actual)) throw error
        }
        actual = await objectStore.head(row.id as string, request)
      }
      if (!verified(row, actual)) throw new RelayError(422, 'object_verification_failed')
    } catch (error) {
      return await abortFailedMultipart(row, uploadId, error)
    }
    const objectRef = (row.object_ref as string | null) ?? opaque('object')
    store.db.query("UPDATE video_media_leases_v1 SET state='ready',object_ref=?,multipart_phase='completed' WHERE id=?").run(objectRef, row.id)
    return leaseRow(row.id as string)
  }
  async function leaseCapabilities(row: Row, verification?: ObjectVerificationRequest) {
    row = await recoverMultipart(row, verification)
    if (row.state !== 'awaiting_upload' || Date.parse(row.expires_at as string) <= now().getTime()) return {}
    const multipartUploadId = row.multipart_upload_id as string | null
    if (!multipartUploadId) {
      return await objectStore.createPutUrl({ leaseId: row.id as string, hash: row.content_hash as string, byteSize: row.byte_size as number, contentType: row.content_type as string, expiresAt: row.expires_at as string })
    }
    if (!objectStore.createMultipartPartPutUrl || !objectStore.listMultipartParts) throw new RelayError(503, 'object_store_multipart_unavailable')
    const partSize = row.multipart_part_size as number
    const partCount = Math.ceil((row.byte_size as number) / partSize)
    if (!Number.isSafeInteger(partCount) || partCount < 1) throw new RelayError(422, 'multipart_size_invalid')
    if (partCount > VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS) throw new RelayError(422, 'multipart_control_response_too_large')
    const uploadedParts = await objectStore.listMultipartParts({ leaseId: row.id as string, uploadId: multipartUploadId }, verification ?? verificationRequest(row))
    const parts = await Promise.all(Array.from({ length: partCount }, async (_, index) => {
      const partNumber = index + 1
      const signed = await objectStore.createMultipartPartPutUrl!({ leaseId: row.id as string, uploadId: multipartUploadId, partNumber, expiresAt: row.expires_at as string })
      return { part_number: partNumber, put_url: signed.put_url, ...(signed.required_headers && Object.keys(signed.required_headers).length ? { required_headers: signed.required_headers } : {}) }
    }))
    return { multipart_upload: { upload_id: multipartUploadId, part_size: partSize, parts, uploaded_parts: uploadedParts } }
  }
  async function projection(operationId: string) {
    const base = store.projection(operationId)
    const rows = store.db.query("SELECT * FROM video_media_result_objects_v1 WHERE operation_id=? AND acknowledged_at IS NULL AND state='published' AND expires_at>? ORDER BY object_ref").all(operationId, iso(now)) as Row[]
    if (!rows.length) return base
    const resultObjects = await Promise.all(rows.map(async row => ({
      object_ref: row.object_ref as string,
      content_hash: row.content_hash as string,
      byte_size: row.byte_size as number,
      content_type: row.content_type as string,
      get_url: await objectStore.createResultReadUrl({ objectRef: row.object_ref as string, expiresAt: row.expires_at as string }),
      expires_at: row.expires_at as string,
    })))
    return { ...base, result_objects: resultObjects }
  }
  type ResultPublication = { provider_task_id?: string; receipt: ProviderExecutionReceipt; safe_error_code?: string }
  function publicationPayload(row: Row): Uint8Array {
    const value = row.payload
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    throw new RelayError(503, 'result_publication_payload_missing')
  }
  function publicationReceipt(row: Row): ProviderExecutionReceipt {
    try { return JSON.parse(String(row.publication_receipt)) as ProviderExecutionReceipt } catch { throw new RelayError(503, 'result_publication_receipt_missing') }
  }
  async function promotePublishingResult(row: Row): Promise<void> {
    const objectRef = row.object_ref as string
    const operation = store.db.query('SELECT owner,account_quota_reservation_id FROM video_media_operations_v1 WHERE id=?').get(row.operation_id) as { owner: string; account_quota_reservation_id: string } | null
    if (!operation) throw new RelayError(503, 'operation_missing_for_result')
    const expected: ObjectMetadata = { byte_size: row.byte_size as number, content_hash: row.content_hash as string, content_type: row.content_type as string }
    const request = objectStoreRequest(operation.owner)
    let actual = objectStore.headResult
      ? await objectStore.headResult(objectRef, { ...request, expectedByteSize: expected.byte_size })
      : null
    if (actual && (actual.byte_size !== expected.byte_size || actual.content_hash !== expected.content_hash || actual.content_type !== expected.content_type)) {
      throw new RelayError(502, 'result_publication_integrity_conflict')
    }
    if (!actual) {
      await objectStore.putResult({ objectRef, body: publicationPayload(row), contentHash: expected.content_hash, contentType: expected.content_type }, request)
      if (objectStore.headResult) {
        actual = await objectStore.headResult(objectRef, { ...request, expectedByteSize: expected.byte_size })
        if (!actual || actual.byte_size !== expected.byte_size || actual.content_hash !== expected.content_hash || actual.content_type !== expected.content_type) {
          throw new RelayError(503, 'result_publication_verification_failed')
        }
      }
    }
    const receipt = publicationReceipt(row)
    if (row.publication_state !== 'succeeded') throw new RelayError(503, 'result_publication_state_invalid')
    store.transaction(() => {
      const result = store.db.query("UPDATE video_media_result_objects_v1 SET state='published',payload=NULL WHERE object_ref=? AND state='publishing'").run(objectRef)
      if (result.changes !== 1) throw new RelayError(409, 'result_publication_changed')
      const operationResult = store.db.query("UPDATE video_media_operations_v1 SET state='succeeded',provider_task_id=?,result_object_refs=?,provider_receipt=?,safe_error_code=?,updated_at=? WHERE id=? AND state IN ('accepted','submitted','running')")
        .run(row.publication_provider_task_id ?? null, JSON.stringify([objectRef]), JSON.stringify(receipt), row.publication_safe_error_code ?? null, iso(now), row.operation_id)
      if (operationResult.changes !== 1) throw new RelayError(409, 'result_publication_operation_changed')
      store.settleQuota(operation.account_quota_reservation_id, receipt)
      // The operation and result become visible atomically before the
      // pre-written cleanup intent is disarmed.
      store.db.query("UPDATE video_media_object_cleanup_v1 SET phase='disarmed' WHERE object_kind='result' AND lease_id='' AND object_ref=? AND phase='publish_pending'").run(objectRef)
    })
  }
  async function recoverPublishingResults(): Promise<void> {
    const rows = store.db.query("SELECT * FROM video_media_result_objects_v1 WHERE state='publishing' ORDER BY object_ref LIMIT 32").all() as Row[]
    for (const row of rows) {
      if (activeResultPublications.has(row.object_ref as string)) continue
      try { await promotePublishingResult(row) } catch {
        // Keep the durable payload and publish_pending intent for the next
        // bounded retry. A paid result must never be swept as orphaned.
      }
    }
  }
  function hasPublishingResult(operationId: string): boolean {
    return Boolean(store.db.query("SELECT 1 FROM video_media_result_objects_v1 WHERE operation_id=? AND state='publishing' LIMIT 1").get(operationId))
  }
  async function persistResult(operationId: string, result: unknown, publication: ResultPublication): Promise<string[]> {
    let encoded: string
    try { encoded = JSON.stringify(result) } catch { throw new RelayError(502, 'provider_result_not_serializable') }
    const bytes = new TextEncoder().encode(encoded)
    if (!bytes.byteLength || bytes.byteLength > VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES) throw new RelayError(502, 'provider_result_too_large')
    const objectRef = opaque('result')
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const expiresAt = new Date(now().getTime() + ttl(env)).toISOString()
    const operation = store.db.query('SELECT id FROM video_media_operations_v1 WHERE id=?').get(operationId) as { id: string } | null
    if (!operation) throw new RelayError(503, 'operation_missing_for_result')
    activeResultPublications.add(objectRef)
    try {
      store.transaction(() => {
        store.db.query("INSERT INTO video_media_result_objects_v1(object_ref,operation_id,content_hash,byte_size,content_type,expires_at,acknowledged_at,state,publication_state,publication_provider_task_id,publication_receipt,publication_safe_error_code,payload) VALUES(?,?,?,?,?,?,NULL,'publishing',?,?,?,?,?)")
          .run(objectRef, operationId, contentHash, bytes.byteLength, 'application/json', expiresAt, 'succeeded', publication.provider_task_id ?? null, JSON.stringify(publication.receipt), publication.safe_error_code ?? null, Buffer.from(bytes))
        store.db.query("INSERT INTO video_media_object_cleanup_v1(id,object_kind,lease_id,object_ref,attempts,next_attempt_at,completed_at,last_error,phase) VALUES(?,?,?, ?,0,?,NULL,NULL,'publish_pending')")
          .run(opaque('cleanup'), 'result', '', objectRef, iso(now))
      })
      await promotePublishingResult(store.db.query('SELECT * FROM video_media_result_objects_v1 WHERE object_ref=?').get(objectRef) as Row)
    } finally {
      activeResultPublications.delete(objectRef)
    }
    return [objectRef]
  }
  function queueCleanup(kind: 'input' | 'result', value: { leaseId?: string; objectRef?: string }, phase: 'active' | 'abort_pending' = 'active'): void {
    const leaseId = value.leaseId ?? ''; const objectRef = value.objectRef ?? ''
    if ((kind === 'input' && !leaseId) || (kind === 'result' && !objectRef)) return
    store.db.query(`INSERT INTO video_media_object_cleanup_v1(id,object_kind,lease_id,object_ref,attempts,next_attempt_at,completed_at,last_error,phase)
      VALUES(?,?,?,?,0,?,NULL,NULL,?)
      ON CONFLICT(object_kind,lease_id,object_ref) DO UPDATE SET
        phase=CASE WHEN video_media_object_cleanup_v1.phase='abort_pending' OR excluded.phase='abort_pending' THEN 'abort_pending' ELSE excluded.phase END,
        completed_at=NULL,next_attempt_at=excluded.next_attempt_at,last_error=NULL`).run(opaque('cleanup'), kind, leaseId, objectRef, iso(now), phase)
  }
  function queueLeaseCleanup(leaseId: string): void {
    const lease = store.db.query('SELECT multipart_upload_id,multipart_phase FROM video_media_leases_v1 WHERE id=?').get(leaseId) as { multipart_upload_id: string | null; multipart_phase: string | null } | null
    // `cleanup_pending` is written only after AbortMultipartUpload was
    // confirmed. Re-queuing that lease must preserve the delete stage instead
    // of upgrading it back to abort_pending and potentially getting stuck on
    // a Provider "NoSuchUpload" response.
    const abortAlreadyResolved = ['completed', 'aborted', 'cleanup_pending'].includes(lease?.multipart_phase ?? '')
    const openMultipart = Boolean(lease && !abortAlreadyResolved && (lease.multipart_upload_id || lease.multipart_phase === 'initializing'))
    queueCleanup('input', { leaseId }, openMultipart ? 'abort_pending' : 'active')
  }
  function queueInputCleanup(input: CreateVideoRelayOperationRequest, owner: string): void {
    const refs = input.capability === 'visual_evidence' || input.capability === 'media_reasoning'
      ? input.input.object_refs
      : input.capability === 'speech_transcription' ? [input.input.audio_object_ref] : []
    for (const ref of refs) {
      const lease = store.db.query("SELECT id FROM video_media_leases_v1 WHERE owner=? AND object_ref=? AND state IN ('ready','bound')").get(owner, ref) as { id: string } | null
      if (lease) queueLeaseCleanup(lease.id)
    }
  }
  async function failBeforeProvider(operationId: string, quotaReservationId: string, input: CreateVideoRelayOperationRequest, owner: string): Promise<boolean> {
    // The operation reservation is created before object-read preparation and
    // provider admission, but neither side effect has crossed the durable
    // submission fence.  A cancellation, queue timeout/full, rate limit, or
    // other explicit pre-fence failure is therefore known not to have reached
    // the provider.  Make that fact durable with the quota release in the
    // same transaction; an idempotent retry then observes the terminal failure
    // and can never submit a second paid operation.
    const transitioned = store.transaction(() => {
      const result = store.db.query("UPDATE video_media_operations_v1 SET state='failed',safe_error_code='provider_not_started',updated_at=? WHERE id=? AND state='accepted' AND submission_started_at IS NULL")
        .run(iso(now), operationId)
      if (result.changes === 1) store.releaseQuota(quotaReservationId)
      return result.changes === 1
    })
    if (transitioned) {
      queueInputCleanup(input, owner)
      await retryObjectCleanup()
    }
    return transitioned
  }
  function queueResultCleanup(operationId: string): void {
    const rows = store.db.query('SELECT object_ref FROM video_media_result_objects_v1 WHERE operation_id=? AND acknowledged_at IS NOT NULL').all(operationId) as Array<{ object_ref: string }>
    for (const row of rows) queueCleanup('result', { objectRef: row.object_ref })
  }
  let cleanupFlight: Promise<void> | undefined
  async function retryObjectCleanup(): Promise<void> {
    if (cleanupFlight) return await cleanupFlight
    const current = (async () => {
      const due = store.db.query(`SELECT * FROM video_media_object_cleanup_v1
        WHERE completed_at IS NULL AND phase IN ('active','abort_pending') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 32`).all(iso(now)) as Row[]
      for (const row of due) {
        try {
          if (row.object_kind === 'input') {
            const lease = store.db.query('SELECT owner,multipart_upload_id,multipart_phase FROM video_media_leases_v1 WHERE id=?').get(row.lease_id) as { owner: string; multipart_upload_id: string | null; multipart_phase: string | null } | null
            const request = objectStoreRequest(lease?.owner ?? 'cleanup')
            if (row.phase === 'abort_pending') {
              const uploadIds = new Set<string>()
              if (lease?.multipart_upload_id) uploadIds.add(lease.multipart_upload_id)
              if (objectStore.findMultipartUploads) {
                for (const upload of await objectStore.findMultipartUploads({ leaseId: row.lease_id as string }, request)) uploadIds.add(upload.uploadId)
              } else if (!uploadIds.size) {
                throw new Error('multipart_recovery_list_unavailable')
              }
              if (uploadIds.size && !objectStore.abortMultipartUpload) throw new Error('multipart_abort_unavailable')
              for (const uploadId of uploadIds) await objectStore.abortMultipartUpload!({ leaseId: row.lease_id as string, uploadId }, request)
              // This durable stage transition is the delete fence: a crash or
              // DeleteObject failure after confirmed abort always resumes at
              // deletion and can never mark an open upload as cleaned.
              store.transaction(() => {
                store.db.query("UPDATE video_media_leases_v1 SET multipart_phase='aborted' WHERE id=? AND multipart_phase NOT IN ('completed','aborted')").run(row.lease_id)
                store.db.query("UPDATE video_media_object_cleanup_v1 SET phase='active',attempts=0,next_attempt_at=?,last_error=NULL WHERE id=? AND phase='abort_pending'").run(iso(now), row.id)
              })
              row.phase = 'active'
              row.attempts = 0
            }
            await objectStore.delete(row.lease_id as string, request)
            store.db.query("UPDATE video_media_leases_v1 SET state='deleted',multipart_phase=CASE WHEN multipart_phase='cleanup_pending' THEN 'aborted' ELSE multipart_phase END WHERE id=? AND state <> 'deleted'").run(row.lease_id)
            store.releaseLease(row.lease_id as string)
          } else {
            const result = store.db.query('SELECT operation.owner FROM video_media_result_objects_v1 result JOIN video_media_operations_v1 operation ON operation.id=result.operation_id WHERE result.object_ref=?').get(row.object_ref) as { owner: string } | null
            await objectStore.deleteResult(row.object_ref as string, objectStoreRequest(result?.owner ?? 'cleanup'))
          }
          store.db.query('UPDATE video_media_object_cleanup_v1 SET completed_at=?,last_error=NULL WHERE id=?').run(iso(now), row.id)
        } catch (error) {
          const attempts = Number(row.attempts) + 1
          const retryMs = Math.min(60 * 60_000, 1_000 * (2 ** Math.min(attempts, 12)))
          const message = error instanceof Error ? error.message.slice(0, 240) : 'cleanup_failed'
          store.db.query('UPDATE video_media_object_cleanup_v1 SET attempts=?,next_attempt_at=?,last_error=? WHERE id=?')
            .run(attempts, new Date(now().getTime() + retryMs).toISOString(), message, row.id)
        }
      }
    })()
    cleanupFlight = current
    try { await current } finally { if (cleanupFlight === current) cleanupFlight = undefined }
  }
  /**
   * Durable expiry and crash recovery. Object stores are deliberately granted
   * no ListObjects permission, so every object reference must be discoverable
   * from SQLite and every uncompleted publication must carry its own cleanup
   * intent before the PUT begins.
   */
  function sweepExpiredResources(): void {
    const current = iso(now)
    const acceptedOrphanCutoff = new Date(now().getTime() - acceptedOrphanGraceMs).toISOString()
    // A null submission marker is known not to have crossed the Provider
    // fence, but only a record created before this process started may be
    // recovered here. The age guard handles a crash just before restart while
    // the fixed process boundary makes current-process preparation untouchable.
    const acceptedOrphans = store.db.query(`SELECT id,owner,local_operation_id,request_json,account_quota_reservation_id
      FROM video_media_operations_v1
      WHERE state='accepted' AND submission_started_at IS NULL AND created_at<? AND updated_at<=?`)
      .all(processStartedAt, acceptedOrphanCutoff) as Array<{ id: string; owner: string; local_operation_id: string; request_json: string; account_quota_reservation_id: string }>
    for (const operation of acceptedOrphans) {
      const transitioned = store.transaction(() => {
        const result = store.db.query(`UPDATE video_media_operations_v1
          SET state='failed',safe_error_code='provider_not_started',updated_at=?
          WHERE id=? AND state='accepted' AND submission_started_at IS NULL AND created_at<? AND updated_at<=?`)
          .run(current, operation.id, processStartedAt, acceptedOrphanCutoff)
        if (result.changes === 1) store.releaseQuota(operation.account_quota_reservation_id)
        return result.changes === 1
      })
      if (!transitioned) continue
      try {
        queueInputCleanup(createVideoRelayOperationRequestSchema.parse(JSON.parse(operation.request_json)), operation.owner)
      } catch {
        // The durable local-operation binding is sufficient to recover inputs
        // even if a legacy request payload can no longer be parsed. It never
        // authorizes Provider work; it only narrows cleanup to this owner and
        // this already-terminal local operation.
        const leases = store.db.query("SELECT id FROM video_media_leases_v1 WHERE owner=? AND local_operation_id=? AND state IN ('awaiting_upload','ready','bound','expired')")
          .all(operation.owner, operation.local_operation_id) as Array<{ id: string }>
        for (const lease of leases) queueLeaseCleanup(lease.id)
      }
    }
    // A publishing result is an already-durable paid outcome.  It must win
    // over the generic before/after-Provider crash marker: recovery will
    // verify or re-upload its immutable bytes and atomically promote it.
    // Marking it outcome_unknown first would make that later promotion reject
    // the Operation state and strand a recoverable result forever.
    const interruptedSubmissions = store.db.query(`SELECT operation.id,operation.account_quota_reservation_id
      FROM video_media_operations_v1 operation
      WHERE operation.state='accepted' AND operation.submission_started_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM video_media_result_objects_v1 result
          WHERE result.operation_id=operation.id AND result.state='publishing'
        )`).all() as Array<{ id: string; account_quota_reservation_id: string }>
    for (const operation of interruptedSubmissions) {
      if (activeProviderSubmissions.has(operation.id)) continue
      store.transaction(() => {
        store.db.query("UPDATE video_media_operations_v1 SET state='outcome_unknown',safe_error_code='provider_submission_interrupted',updated_at=? WHERE id=? AND state='accepted' AND submission_started_at IS NOT NULL")
          .run(current, operation.id)
        store.retainUnknownQuota(operation.account_quota_reservation_id)
      })
    }
    const leases = store.db.query("SELECT id FROM video_media_leases_v1 WHERE expires_at<=? AND state IN ('awaiting_upload','ready','bound')").all(current) as Array<{ id: string }>
    for (const lease of leases) {
      store.transaction(() => {
        store.db.query("UPDATE video_media_leases_v1 SET state='expired' WHERE id=? AND state IN ('awaiting_upload','ready','bound')").run(lease.id)
        store.releaseLease(lease.id)
        queueLeaseCleanup(lease.id)
      })
    }
    const results = store.db.query("SELECT object_ref,operation_id FROM video_media_result_objects_v1 WHERE expires_at<=? AND acknowledged_at IS NULL AND state='published'").all(current) as Array<{ object_ref: string; operation_id: string }>
    for (const result of results) {
      store.transaction(() => {
        store.db.query("UPDATE video_media_result_objects_v1 SET state='expired' WHERE object_ref=? AND state='published' AND acknowledged_at IS NULL").run(result.object_ref)
        store.db.query("UPDATE video_media_operations_v1 SET state='expired',safe_error_code='result_delivery_expired',updated_at=? WHERE id=? AND state='succeeded' AND acknowledged_at IS NULL")
          .run(current, result.operation_id)
      })
      queueCleanup('result', { objectRef: result.object_ref })
    }
  }
  async function refreshOperation(row: Row, principal: Identity, signal?: AbortSignal): Promise<void> {
    if (!['submitted', 'running'].includes(row.state as string) || !row.provider_task_id || !provider.poll) return
    const input = createVideoRelayOperationRequestSchema.parse(JSON.parse(row.request_json as string))
    try {
      const objectRefs = input.capability === 'speech_transcription' ? [input.input.audio_object_ref] : input.capability === 'visual_evidence' || input.capability === 'media_reasoning' ? input.input.object_refs : []
      const objectByteSizes = objectRefs.map(ref => store.db.query("SELECT byte_size FROM video_media_leases_v1 WHERE owner=? AND object_ref=?").get(principal.owner, ref) as { byte_size: number } | null)
      if (objectByteSizes.some(item => !item)) throw new RelayError(503, 'object_read_lease_unavailable')
      const permit = await acquireProviderCapacity(input, principal.owner, signal)
      let polled: Awaited<ReturnType<NonNullable<VideoMediaProvider['poll']>>>
      try {
        await permit.assertCurrent?.()
        polled = await provider.poll(input, row.provider_task_id as string, principal, { object_urls: [], object_byte_sizes: objectByteSizes.map(item => item!.byte_size) }, { signal })
      } finally {
        permit.release()
      }
      const priorReceipt = row.provider_receipt ? JSON.parse(row.provider_receipt as string) as ProviderExecutionReceipt : null
      const receipt = reconcileProviderReceipt(priorReceipt, polled.receipt)
      if (polled.state === 'succeeded' && polled.result === undefined) throw new RelayError(502, 'provider_result_missing')
      if (polled.result !== undefined) {
        if (polled.state !== 'succeeded') throw new RelayError(502, 'provider_result_state_invalid')
        await persistResult(row.id as string, polled.result, {
          provider_task_id: polled.provider_task_id ?? row.provider_task_id as string,
          receipt,
          safe_error_code: polled.safe_error_code,
        })
      } else {
        store.transaction(() => {
          store.db.query('UPDATE video_media_operations_v1 SET state=?,provider_task_id=?,result_object_refs=?,provider_receipt=?,safe_error_code=?,updated_at=? WHERE id=?')
            .run(polled.state, polled.provider_task_id ?? row.provider_task_id, null, JSON.stringify(receipt), polled.safe_error_code ?? null, iso(now), row.id)
          if (polled.state === 'failed' || polled.state === 'expired' || polled.state === 'cancelled') store.settleQuota(row.account_quota_reservation_id, receipt)
        })
      }
      if (['succeeded', 'failed', 'expired', 'cancelled'].includes(polled.state)) queueInputCleanup(input, principal.owner)
    } catch (error) {
      // A known remote task is recoverable by read-only polling. A transient
      // polling outage must never turn it into a permanently unrecoverable
      // unknown operation, and must never authorize a second submission.
      if (row.provider_task_id && isOutcomeUnknown(error)) {
        store.db.query("UPDATE video_media_operations_v1 SET state='submitted',safe_error_code='provider_poll_pending_retry',updated_at=? WHERE id=? AND state IN ('submitted','running')")
          .run(iso(now), row.id)
        return
      }
      const unknown = isOutcomeUnknown(error)
      store.db.query('UPDATE video_media_operations_v1 SET state=?,safe_error_code=?,updated_at=? WHERE id=?')
        .run(unknown ? 'outcome_unknown' : 'failed', unknown ? 'provider_outcome_unknown' : safeFailureCode(error), iso(now), row.id)
      if (unknown) store.retainUnknownQuota(row.account_quota_reservation_id)
      else store.settleQuota(row.account_quota_reservation_id)
      if (unknown) retainOutcomeUnknownInputs(input, principal.owner)
      if (!unknown) {
        queueInputCleanup(input, principal.owner)
        await retryObjectCleanup()
      }
    }
  }
  const identityIntrospector = loadVideoMediaRelayIdentityIntrospector(env, {
    fetchImpl,
    now: () => now().getTime(),
    timeoutMs: boundedEnvInt(env, 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_TIMEOUT_MS', 10_000, 1_000, 60_000),
    admissionBackend,
    admissionPolicy: identityAdmission,
  })
  async function identity(request: Request): Promise<Identity> {
    const accessToken = authorization(request)
    try {
      // Keep the shared authority request independent of one desktop socket:
      // cancelling one caller must not tear down an in-flight deduplicated
      // introspection that other callers are awaiting. Control-body handling
      // still observes the request signal and returns its 499.
      return await identityIntrospector.introspect(accessToken)
    } catch (error) {
      if (request.signal.aborted) throw new RelayError(499, 'request_aborted')
      if (error instanceof VideoMediaRelayIdentityError) throw new RelayError(error.status, error.code)
      throw new RelayError(503, 'identity_unavailable')
    }
  }
  // Run once at process start without waiting for a client request, then keep
  // the bounded cleanup queue moving even when no desktop is open. The timer
  // is unref'd so a test or one-off validator process never stays alive for it.
  sweepExpiredResources()
  void recoverPublishingResults()
  void retryObjectCleanup()
  const sweepTimer = setInterval(() => {
    sweepExpiredResources()
    void recoverPublishingResults()
    void retryObjectCleanup()
  }, 60_000)
  ;(sweepTimer as unknown as { unref?: () => void }).unref?.()
  return async (request: Request): Promise<Response> => {
    const id = requestId()
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/healthz') return json({ ok: true, component: 'video-media-relay' }, 200, id)
      if (request.method === 'GET' && url.pathname === '/readyz') return json({ ok: true, component: 'video-media-relay', identity_configured: Boolean(env.VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN && env.VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE), capacity_policy_revision: capacity.revision }, 200, id)
      const principal = await identity(request)
      const lookupPrefix = videoMediaOperationByLocalOperationPath('')
      if (request.method === 'GET' && url.pathname.startsWith(lookupPrefix)) {
        const encodedLocalOperationId = url.pathname.slice(lookupPrefix.length)
        let localOperationId: string
        try { localOperationId = decodeURIComponent(encodedLocalOperationId) } catch { throw new RelayError(404, 'operation_not_found') }
        if (!/^[a-z][a-z0-9_]{7,127}$/.test(localOperationId)) throw new RelayError(404, 'operation_not_found')
        // This lookup uses the trusted owner and the durable local-operation
        // uniqueness fence only. It is read-only and never falls through to
        // POST admission, quota reservation, object binding, or Provider I/O.
        const operation = store.db.query('SELECT id FROM video_media_operations_v1 WHERE owner=? AND local_operation_id=?').get(principal.owner, localOperationId) as { id: string } | null
        if (!operation) throw new RelayError(404, 'operation_not_found')
        return json(await projection(operation.id), 200, id)
      }
      sweepExpiredResources()
      await recoverPublishingResults()
      await retryObjectCleanup()
      if (request.method === 'POST' && url.pathname === '/v1/video-media/object-leases') {
        const key = requireControlHeaders(request); const raw = createMediaObjectLeaseRequestSchema.parse(await body(request, controlBodyTimeout(env))); assertLeasePurposeAndMime(raw); const hash = canonicalRelayRequestHash(raw)
        const replay = store.replay(principal.owner, key, hash); if (replay) {
          const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(replay, principal.owner) as Row | null
          if (!row) throw new RelayError(409, 'idempotency_resource_missing')
          // A crash after receiving the lease but before completing a direct
          // PUT must be resumable.  Re-signing does not change its immutable
          // hash/size/type/object key and cannot widen the consent scope.
          const signed = await leaseCapabilities(row, verificationRequest(row, request.signal))
          return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), ...signed, expires_at: row.expires_at }), 200, id)
        }
        const leaseId = opaque('lease'); const expiresAt = new Date(now().getTime() + ttl(env)).toISOString()
        const multipart = raw.byte_size >= multipartThreshold(env)
        const partSize = multipart ? multipartPartSize(env) : null
        if (partSize && Math.ceil(raw.byte_size / partSize) > VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS) {
          throw new RelayError(422, 'multipart_control_response_too_large')
        }
        store.transaction(() => {
          // Reserve before returning any signed URL. This isolates direct OSS
          // capability issuance from unbounded client-side upload attempts.
          store.reserveLease(principal.owner, leaseId, objectLeaseQuotaUnits)
          store.db.query(`INSERT INTO video_media_leases_v1(
            id,owner,local_operation_id,purpose,content_hash,byte_size,content_type,consent_revision_id,consent_scope_hash,state,object_ref,expires_at,created_at,multipart_upload_id,multipart_part_size,multipart_phase,multipart_parts_json
          ) VALUES(?,?,?,?,?,?,?,?,?,'awaiting_upload',NULL,?,?,?,? ,?,NULL)`).run(
            leaseId, principal.owner, raw.local_operation_id, raw.purpose, raw.content_hash, raw.byte_size, raw.content_type, raw.consent_revision_id, raw.consent_scope_hash, expiresAt, iso(now), null, partSize, multipart ? 'initializing' : null,
          )
          store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId)
        })
        const row = leaseRow(leaseId)
        return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: 'awaiting_upload', ...await leaseCapabilities(row, verificationRequest(row, request.signal)), expires_at: expiresAt }), 201, id)
      }
      const leaseMatch = /^\/v1\/video-media\/object-leases\/([a-z][a-z0-9_]{7,127})\/(complete|renew)$/.exec(url.pathname)
      if (leaseMatch && request.method === 'POST') {
        const key = requireControlHeaders(request); const leaseId = leaseMatch[1]!; const action = leaseMatch[2]!; const rawBody = await body(request, controlBodyTimeout(env)); const completion = action === 'complete' ? completeMediaObjectLeaseRequestSchema.parse(rawBody) : (rawBody, {})
        let row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(leaseId, principal.owner) as Row | null; if (!row) throw new RelayError(404, 'lease_not_found')
        row = await recoverMultipart(row, verificationRequest(row, request.signal))
        const hash = canonicalRelayRequestHash({ lease_id: leaseId, action, completion }); const replay = store.replay(principal.owner, key, hash); if (replay) return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), ...await leaseCapabilities(row, verificationRequest(row, request.signal)), expires_at: row.expires_at }), 200, id)
        if (action === 'renew') { if (Date.parse(row.expires_at as string) <= now().getTime() || row.state === 'deleted') { expireLease(row); throw new RelayError(410, 'lease_expired') }; const expiresAt = new Date(now().getTime() + ttl(env)).toISOString(); store.db.query('UPDATE video_media_leases_v1 SET expires_at=? WHERE id=?').run(expiresAt, leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId); const renewed = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=?').get(leaseId) as Row; return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), ...await leaseCapabilities(renewed, verificationRequest(renewed, request.signal)), expires_at: expiresAt }), 200, id) }
        if (Date.parse(row.expires_at as string) <= now().getTime()) { expireLease(row); throw new RelayError(410, 'lease_expired') }
        if (row.state === 'deleted') throw new RelayError(410, 'lease_deleted')
        if (row.state === 'ready' || row.state === 'bound') {
          if (action === 'complete') store.db.query('INSERT OR IGNORE INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId)
          return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, object_ref: row.object_ref, expires_at: row.expires_at }), 200, id)
        }
        const uploadId = row.multipart_upload_id as string | null
        if (uploadId) {
          if (!objectStore.listMultipartParts || !objectStore.completeMultipartUpload) throw new RelayError(503, 'object_store_multipart_unavailable')
          const partSize = row.multipart_part_size as number
          const expectedCount = Math.ceil((row.byte_size as number) / partSize)
          const supplied = completion.parts ?? []
          const expectedNumbers = Array.from({ length: expectedCount }, (_, index) => index + 1)
          if (supplied.length !== expectedCount || JSON.stringify(supplied.map(item => item.part_number).sort((a, b) => a - b)) !== JSON.stringify(expectedNumbers)) throw new RelayError(422, 'multipart_parts_incomplete')
          const uploaded = await objectStore.listMultipartParts({ leaseId, uploadId }, verificationRequest(row, request.signal))
          const actualByPart = new Map(uploaded.map(item => [item.part_number, item.etag]))
          if (supplied.some(item => actualByPart.get(item.part_number) !== item.etag)) throw new RelayError(422, 'multipart_parts_unverified')
          store.db.query("UPDATE video_media_leases_v1 SET multipart_phase='completing',multipart_parts_json=? WHERE id=?").run(JSON.stringify({ parts: supplied }), leaseId)
          row = leaseRow(leaseId)
          await recoverMultipart(row, verificationRequest(row, request.signal))
          row = leaseRow(leaseId)
          store.db.query('INSERT OR IGNORE INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId)
          return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), expires_at: row.expires_at }), 200, id)
        } else if (completion.parts?.length) throw new RelayError(422, 'multipart_parts_unexpected')
        const actual = await objectStore.head(leaseId, verificationRequest(row, request.signal)); if (!actual || actual.byte_size !== row.byte_size || actual.content_hash !== row.content_hash || actual.content_type !== row.content_type) throw new RelayError(422, 'object_verification_failed')
        const objectRef = opaque('object'); store.transaction(() => { store.db.query("UPDATE video_media_leases_v1 SET state='ready',object_ref=? WHERE id=?").run(objectRef, leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId) })
        return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: 'ready', object_ref: objectRef, expires_at: row.expires_at }), 200, id)
      }
      const deleteLease = /^\/v1\/video-media\/object-leases\/([a-z][a-z0-9_]{7,127})$/.exec(url.pathname)
      if (deleteLease && request.method === 'DELETE') {
        const key = requireControlHeaders(request); const leaseId = deleteLease[1]!
        const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(leaseId, principal.owner) as Row | null
        if (!row) return new Response(null, { status: 204, headers: { 'X-Request-Id': id } })
        const hash = canonicalRelayRequestHash({ lease_id: leaseId, action: 'delete' })
        const replay = store.replay(principal.owner, key, hash)
        if (!replay) {
          // Persist the abort/delete stages before touching OSS. A failed
          // AbortMultipartUpload remains `abort_pending` and can never fall
          // through to DeleteObject or an idempotent success response.
          queueLeaseCleanup(leaseId)
          await retryObjectCleanup()
          if (leaseRow(leaseId).state !== 'deleted') throw new RelayError(503, 'object_cleanup_pending')
          store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId)
        }
        return new Response(null, { status: 204, headers: { 'X-Request-Id': id } })
      }
      if (request.method === 'POST' && url.pathname === '/v1/video-media/operations') {
        const key = requireControlHeaders(request); const raw = createVideoRelayOperationRequestSchema.parse(await body(request, controlBodyTimeout(env))); const hash = canonicalRelayRequestHash(raw); const replay = store.replay(principal.owner, key, hash)
        let replayRow: Row | null = null
        if (replay) {
          replayRow = store.db.query('SELECT * FROM video_media_operations_v1 WHERE id=? AND owner=?').get(replay, principal.owner) as Row | null
          if (!replayRow) throw new RelayError(409, 'idempotency_resource_missing')
          // Terminal idempotency replays are independent of source-object
          // retention: input cleanup must never turn a completed replay into
          // object_not_ready.
          if (replayRow.state !== 'accepted') return json(await projection(replay), 200, id)
          if (replayRow.submission_started_at) {
            // A durable result publication has already crossed the Provider
            // boundary and carries the exact result bytes. Never turn it into
            // an ambiguous submission or run execute() again; recovery can
            // only verify/re-PUT the immutable object reference.
            if (hasPublishingResult(replay)) {
              await recoverPublishingResults()
              return json(await projection(replay), 202, id)
            }
            // The first in-process caller already owns the durable fence and
            // is about to call (or is calling) the Provider. A same-key retry
            // observes the one Operation; it never treats live work as a
            // crash or invokes a second execution.
            if (activeProviderSubmissions.has(replay)) return json(await projection(replay), 202, id)
            store.transaction(() => {
              store.db.query("UPDATE video_media_operations_v1 SET state='outcome_unknown',safe_error_code='provider_submission_interrupted',updated_at=? WHERE id=? AND state='accepted' AND submission_started_at IS NOT NULL")
                .run(iso(now), replay)
              store.retainUnknownQuota(replayRow!.account_quota_reservation_id as string)
            })
            throw new RelayError(503, 'provider_submission_interrupted')
          }
        }
        const objectRefs = raw.capability === 'visual_evidence' || raw.capability === 'media_reasoning' ? raw.input.object_refs : raw.capability === 'speech_transcription' ? [raw.input.audio_object_ref] : []
        const referencedObjects = objectRefs.map(ref => store.db.query("SELECT consent_revision_id,consent_scope_hash,local_operation_id,state FROM video_media_leases_v1 WHERE owner=? AND object_ref=? AND state IN ('ready','bound')").get(principal.owner, ref) as { consent_revision_id: string; consent_scope_hash: string; local_operation_id: string; state: string } | null)
        if (referencedObjects.some(item => !item)) throw new RelayError(422, 'object_not_ready')
        if (referencedObjects.some(item => item!.consent_revision_id !== raw.consent_revision_id || item!.consent_scope_hash !== raw.consent_scope_hash)) throw new RelayError(422, 'object_consent_scope_mismatch')
        if (referencedObjects.some(item => item!.state === 'bound' && item!.local_operation_id !== raw.local_operation_id)) throw new RelayError(422, 'object_already_bound')
        let operationId: string
        let quota: string
        if (replay) {
          operationId = replay
          quota = replayRow!.account_quota_reservation_id as string
        } else {
          operationId = opaque('remoteop')
          const units = Math.max(1, raw.capability === 'semantic_embedding' ? raw.input.items.length : objectRefs.length || 1)
          const created = iso(now)
          try {
            quota = store.transaction(() => {
              const reservation = store.reserve(principal.owner, operationId, units, quotaPolicy)
              store.db.query(`INSERT INTO video_media_operations_v1(
                id,owner,local_operation_id,idempotency_key,request_hash,request_json,state,provider_task_id,result_object_refs,provider_receipt,account_quota_reservation_id,safe_error_code,created_at,updated_at,acknowledged_at,submission_started_at
              ) VALUES(?,?,?,?,?,?, 'accepted',NULL,NULL,NULL,?,NULL,?,?,NULL,NULL)`).run(operationId, principal.owner, raw.local_operation_id, key, hash, JSON.stringify(raw), reservation, created, created)
              store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, operationId)
              return reservation
            })
          } catch (error) {
            // BEGIN IMMEDIATE rolls the quota insert back with the Operation.
            // If another request won the same idempotency race, return its
            // durable projection; a different key for the same local command
            // is an explicit conflict, never a raw SQLite 500.
            const winner = store.replay(principal.owner, key, hash)
            if (winner) return json(await projection(winner), 200, id)
            const sameLocal = store.db.query('SELECT id FROM video_media_operations_v1 WHERE owner=? AND local_operation_id=?').get(principal.owner, raw.local_operation_id) as { id: string } | null
            if (sameLocal) throw new RelayError(409, 'local_operation_conflict')
            throw error
          }
        }
        let ownsProviderSubmission = false
        try {
          const providerInputExpiry = raw.capability === 'speech_transcription' && raw.input.mode === 'long_async'
            ? new Date(now().getTime() + 48 * 60 * 60_000).toISOString()
            : undefined
          if (providerInputExpiry) {
            // A submitted Fun-ASR task may not fetch the URL immediately. This
            // only extends the already-bound immutable input for this exact
            // local operation; it never widens client upload capability.
            store.db.query("UPDATE video_media_leases_v1 SET state='bound',expires_at=? WHERE owner=? AND object_ref=? AND state='ready' AND local_operation_id=?")
              .run(providerInputExpiry, principal.owner, objectRefs[0], raw.local_operation_id)
          }
          const objectMedia = await Promise.all(objectRefs.map(async ref => {
            const lease = store.db.query("SELECT id,expires_at,byte_size,state,local_operation_id FROM video_media_leases_v1 WHERE owner=? AND object_ref=? AND state IN ('ready','bound')").get(principal.owner, ref) as { id: string; expires_at: string; byte_size: number; state: string; local_operation_id: string } | null
            if (!lease || Date.parse(lease.expires_at) <= now().getTime()) throw new RelayError(503, 'object_read_lease_unavailable')
            if (lease.state === 'bound' && lease.local_operation_id !== raw.local_operation_id) throw new RelayError(422, 'object_already_bound')
            return { url: await objectStore.createReadUrl({ leaseId: lease.id, expiresAt: lease.expires_at }), byte_size: lease.byte_size }
          }))
          // The accepted operation and its request hash exist before the
          // upstream call. The final write immediately before it is a crash
          // fence: a restart may resume only a record still provably before
          // this boundary, never submit the same paid work twice.
          const permit = await acquireProviderCapacity(raw, principal.owner, request.signal)
          let executed: Awaited<ReturnType<VideoMediaProvider['execute']>>
          try {
            await permit.assertCurrent?.()
            store.transaction(() => {
              const fence = store.db.query("UPDATE video_media_operations_v1 SET submission_started_at=?,updated_at=? WHERE id=? AND state='accepted' AND submission_started_at IS NULL")
                .run(iso(now), iso(now), operationId)
              if (fence.changes !== 1) throw new ProviderSubmissionAlreadyFenced()
            })
            activeProviderSubmissions.add(operationId)
            ownsProviderSubmission = true
            executed = await provider.execute(raw, principal, { object_urls: objectMedia.map(item => item.url), object_byte_sizes: objectMedia.map(item => item.byte_size) }, {
              signal: request.signal,
              onAccepted: async accepted => {
                // The provider task id is a recovery authority, not merely a
                // response field. Commit it before execute() can return so a
                // process crash immediately after DashScope acceptance resumes
                // by polling this one task rather than submitting another.
                store.transaction(() => {
                  const updated = store.db.query("UPDATE video_media_operations_v1 SET state='submitted',provider_task_id=?,provider_receipt=?,updated_at=? WHERE id=? AND state='accepted' AND submission_started_at IS NOT NULL")
                    .run(accepted.provider_task_id, JSON.stringify(accepted.receipt), iso(now), operationId)
                  if (updated.changes !== 1) throw new RelayError(409, 'provider_task_publication_changed')
                })
              },
            })
          } finally {
            permit.release()
          }
          if (executed.state === 'succeeded' && executed.result === undefined && !(executed.result_object_refs?.length)) throw new RelayError(502, 'provider_result_missing')
          if (executed.result !== undefined) {
            if (executed.state !== 'succeeded') throw new RelayError(502, 'provider_result_state_invalid')
            await persistResult(operationId, executed.result, { provider_task_id: executed.provider_task_id, receipt: executed.receipt })
          } else {
            const resultRefs = executed.result_object_refs ?? []
            store.transaction(() => {
              store.db.query('UPDATE video_media_operations_v1 SET state=?,provider_task_id=?,result_object_refs=?,provider_receipt=?,updated_at=? WHERE id=?').run(executed.state, executed.provider_task_id ?? null, resultRefs.length ? JSON.stringify(resultRefs) : null, JSON.stringify(executed.receipt), iso(now), operationId)
              if (executed.state === 'succeeded') store.settleQuota(quota, executed.receipt)
            })
          }
          if (ownsProviderSubmission) activeProviderSubmissions.delete(operationId)
          if (executed.state === 'succeeded') {
            queueInputCleanup(raw, principal.owner)
            await retryObjectCleanup()
          }
          return json(await projection(operationId), 202, id)
        } catch (error) {
          if (error instanceof ProviderSubmissionAlreadyFenced) {
            // A same-key request lost the compare-and-set after the original
            // accepted record was committed. Its correct result is the same
            // durable pending projection, never a second provider call.
            return json(await projection(operationId), 202, id)
          }
          const row = store.db.query('SELECT submission_started_at,provider_task_id FROM video_media_operations_v1 WHERE id=?').get(operationId) as { submission_started_at: string | null; provider_task_id: string | null } | null
          const crossedProviderBoundary = Boolean(row?.submission_started_at)
          if (ownsProviderSubmission) activeProviderSubmissions.delete(operationId)
          if (!crossedProviderBoundary) {
            const released = await failBeforeProvider(operationId, quota, raw, principal.owner)
            if (released) {
              const status = error instanceof RelayError || error instanceof DashScopeProviderError ? error.status : 503
              throw new RelayError(status, 'provider_not_started')
            }
            if (error instanceof RelayError || error instanceof DashScopeProviderError) throw new RelayError(error.status, error.code)
            throw new RelayError(503, 'input_preparation_unavailable')
          }
          if (hasPublishingResult(operationId)) {
            // Result payload, hash, receipt and immutable object ref were
            // committed before OSS PUT. Keep that recovery authority intact
            // even if the process dies or this particular upload attempt
            // fails; any later replay/GET resumes publication only.
            throw new RelayError(503, 'result_publication_pending')
          }
          if (row?.provider_task_id) {
            // A long-ASR provider callback durably published its one task id
            // before execute() returned. A later local failure is recoverable
            // polling, not an unknown submission and never a retry POST.
            store.db.query("UPDATE video_media_operations_v1 SET state='submitted',safe_error_code='provider_execute_return_lost',updated_at=? WHERE id=? AND provider_task_id IS NOT NULL")
              .run(iso(now), operationId)
            throw new RelayError(503, 'provider_submission_interrupted')
          }
          const unknown = isOutcomeUnknown(error)
          store.db.query('UPDATE video_media_operations_v1 SET state=?,safe_error_code=?,updated_at=? WHERE id=?').run(unknown ? 'outcome_unknown' : 'failed', unknown ? 'provider_outcome_unknown' : safeFailureCode(error), iso(now), operationId)
          if (unknown) store.retainUnknownQuota(quota)
          else store.settleQuota(quota)
          if (unknown) retainOutcomeUnknownInputs(raw, principal.owner); else { queueInputCleanup(raw, principal.owner); await retryObjectCleanup() }
          if (error instanceof RelayError || error instanceof DashScopeProviderError) throw new RelayError(error.status, error.code)
          throw new RelayError(503, 'provider_outcome_unknown')
        }
      }
      const operationId = /^\/v1\/video-media\/operations\/([a-z][a-z0-9_]{7,127})(?:\/(cancel|ack))?$/.exec(url.pathname)
      const legacyResultId = /^\/v1\/video-media\/operations\/([a-z][a-z0-9_]{7,127})\/result$/.exec(url.pathname)
      if (legacyResultId && request.method === 'GET') {
        const row = store.db.query('SELECT * FROM video_media_operations_v1 WHERE id=? AND owner=?').get(legacyResultId[1]!, principal.owner) as Row | null
        if (!row) throw new RelayError(404, 'operation_not_found')
        if (!row.result_json) throw new RelayError(410, 'legacy_result_unavailable')
        return json(JSON.parse(row.result_json as string), 200, id)
      }
      if (operationId) {
        const idValue = operationId[1]!
        const action = operationId[2]
        if (request.method === 'GET' && !action) {
          return await withOperationLock(idValue, async () => {
            const current = store.db.query('SELECT * FROM video_media_operations_v1 WHERE id=? AND owner=?').get(idValue, principal.owner) as Row | null
            if (!current) throw new RelayError(404, 'operation_not_found')
            await refreshOperation(current, principal, request.signal)
            sweepExpiredResources()
            await retryObjectCleanup()
            return json(await projection(idValue), 200, id)
          })
        }
        if (request.method === 'POST' && action) {
          const key = requireControlHeaders(request)
          const parsed = action === 'ack' ? operationAcknowledgementSchema.parse(await body(request, controlBodyTimeout(env))) : (await body(request, controlBodyTimeout(env)), {})
          const actionHash = canonicalRelayRequestHash({ operation_id: idValue, action, parsed })
          return await withOperationLock(idValue, async () => {
            const row = store.db.query('SELECT * FROM video_media_operations_v1 WHERE id=? AND owner=?').get(idValue, principal.owner) as Row | null
            if (!row) throw new RelayError(404, 'operation_not_found')
            const replay = store.replay(principal.owner, key, actionHash)
            if (replay) return action === 'ack'
              ? new Response(null, { status: 204, headers: { 'X-Request-Id': id } })
              : json(await projection(idValue), 200, id)
            if (action === 'cancel') {
              const input = createVideoRelayOperationRequestSchema.parse(JSON.parse(row.request_json as string))
              if (row.state === 'accepted' && !row.submission_started_at) {
                store.transaction(() => {
                  store.db.query("UPDATE video_media_operations_v1 SET state='cancelled',updated_at=? WHERE id=? AND state='accepted' AND submission_started_at IS NULL").run(iso(now), idValue)
                  store.releaseQuota(row.account_quota_reservation_id as string)
                  store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, actionHash, idValue)
                })
                queueInputCleanup(input, principal.owner)
              } else if (['submitted', 'running'].includes(row.state as string)) {
                if (!row.provider_task_id || !provider.cancel) throw new RelayError(409, 'operation_cancel_unconfirmed')
                const permit = await acquireProviderCapacity(input, principal.owner, request.signal)
                let cancellation: { cancelled: true; receipt?: ProviderExecutionReceipt } | void
                try {
                  await permit.assertCurrent?.()
                  try {
                    cancellation = await provider.cancel(row.provider_task_id as string, { signal: request.signal }) as { cancelled: true; receipt?: ProviderExecutionReceipt } | void
                  } catch (error) {
                    if (error instanceof DashScopeProviderError) throw new RelayError(error.status, error.code)
                    throw new RelayError(503, 'provider_cancel_unavailable')
                  }
                } finally { permit.release() }
                if (!cancellation || cancellation.cancelled !== true) {
                  // Cancel can race a real terminal Provider transition. Poll
                  // once through the ordinary durable path; only an explicit
                  // CANCELED status may satisfy this cancellation request.
                  await refreshOperation(row, principal, request.signal)
                  const refreshed = store.db.query('SELECT state,provider_receipt FROM video_media_operations_v1 WHERE id=?').get(idValue) as { state: string; provider_receipt: string | null } | null
                  if (refreshed?.state !== 'cancelled') throw new RelayError(409, 'operation_cancel_unconfirmed')
                  let receipt: ProviderExecutionReceipt | undefined
                  try { receipt = refreshed.provider_receipt ? JSON.parse(refreshed.provider_receipt) as ProviderExecutionReceipt : undefined } catch { /* cancellation state remains Provider-authoritative */ }
                  cancellation = { cancelled: true, ...(receipt ? { receipt } : {}) }
                }
                store.transaction(() => {
                  store.db.query("UPDATE video_media_operations_v1 SET state='cancelled',updated_at=? WHERE id=? AND state IN ('submitted','running')").run(iso(now), idValue)
                  // Submission already crossed the provider boundary. A
                  // confirmed cancellation is terminal but never erases its
                  // conservative account charge.
                  store.settleQuota(row.account_quota_reservation_id as string, cancellation.receipt)
                  store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, actionHash, idValue)
                })
                queueInputCleanup(input, principal.owner)
              } else {
                throw new RelayError(409, row.state === 'outcome_unknown' ? 'operation_cancel_indeterminate' : 'operation_not_cancellable')
              }
              await retryObjectCleanup()
              return json(await projection(idValue), 200, id)
            }
            if (row.state !== 'succeeded' || row.acknowledged_at) throw new RelayError(409, 'operation_not_acknowledgeable')
            let receipt: ProviderExecutionReceipt
            try { receipt = JSON.parse(row.provider_receipt as string) as ProviderExecutionReceipt } catch { throw new RelayError(422, 'receipt_mismatch') }
            if (!row.provider_receipt || receipt.id !== parsed.receipt_id) throw new RelayError(422, 'receipt_mismatch')
            const results = store.db.query("SELECT * FROM video_media_result_objects_v1 WHERE operation_id=? AND acknowledged_at IS NULL AND state='published'").all(idValue) as Row[]
            const expected = results.map(item => item.content_hash as string).sort()
            if (!results.length || JSON.stringify([...parsed.result_hashes].sort()) !== JSON.stringify(expected)) throw new RelayError(422, 'result_hash_mismatch')
            store.transaction(() => {
              store.db.query('UPDATE video_media_operations_v1 SET acknowledged_at=?,updated_at=? WHERE id=? AND state=\'succeeded\' AND acknowledged_at IS NULL').run(iso(now), iso(now), idValue)
              store.db.query("UPDATE video_media_result_objects_v1 SET acknowledged_at=? WHERE operation_id=? AND state='published' AND acknowledged_at IS NULL").run(iso(now), idValue)
              store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, actionHash, idValue)
            })
            queueResultCleanup(idValue)
            await retryObjectCleanup()
            return new Response(null, { status: 204, headers: { 'X-Request-Id': id } })
          })
        }
      }
      throw new RelayError(404, 'not_found')
    } catch (error) {
      if (error instanceof RelayError) {
        const hostedQuota = error.status === 429
          && (error.code === 'owner_daily_quota_exceeded' || error.code === 'account_daily_quota_exceeded')
        const currentPeriod = utcDay(now())
        return json({
          error: error.code,
          request_id: id,
          ...(hostedQuota ? {
            capability: 'video',
            scope: error.code === 'owner_daily_quota_exceeded' ? 'owner' : 'platform',
            resets_at: new Date(Date.parse(`${currentPeriod}T00:00:00.000Z`) + 24 * 60 * 60_000).toISOString(),
          } : {}),
        }, error.status, id)
      }
      if (error instanceof ObjectVerificationError) {
        const status = error.code === 'OBJECT_VERIFY_ABORTED' ? 499 : error.code === 'OBJECT_VERIFY_CAPACITY' ? 429 : 503
        const code = error.code === 'OBJECT_VERIFY_ABORTED' ? 'object_verification_cancelled' : error.code === 'OBJECT_VERIFY_CAPACITY' ? 'object_verification_capacity_unavailable' : 'object_verification_timeout'
        return json({ error: code, request_id: id }, status, id)
      }
      if (error instanceof Error && error.name === 'ZodError') return json({ error: 'invalid_request', request_id: id }, 422, id)
      return json({ error: 'internal_error', request_id: id }, 500, id)
    }
  }
}

if (import.meta.main) {
  const handler = createVideoMediaRelayFetch()
  Bun.serve({ hostname: process.env.VIDEO_MEDIA_RELAY_HOST ?? '0.0.0.0', port: Number(process.env.VIDEO_MEDIA_RELAY_PORT ?? 8791), fetch: handler })
}
