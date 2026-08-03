import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Database } from 'bun:sqlite'
import {
  canonicalRelayRequestHash,
  completeMediaObjectLeaseRequestSchema,
  createMediaObjectLeaseRequestSchema,
  createVideoRelayOperationRequestSchema,
  mediaObjectLeaseSchema,
  operationAcknowledgementSchema,
  type CreateVideoRelayOperationRequest,
  type ProviderExecutionReceipt,
} from './contracts/relayApi.ts'
import { DashScopeProviderError, DashScopeVideoProvider } from './providers/dashscope.ts'
import { OssObjectStore, type RelayObjectStore } from './objectStore.ts'

type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Identity = { principal_id: string; installation_id: string; session_id: string; expires_at: number; owner: string }
export type MediaObjectStore = RelayObjectStore
export type VideoMediaProvider = {
  execute(input: CreateVideoRelayOperationRequest, identity: Identity, media?: { object_urls: string[]; object_byte_sizes: number[] }): Promise<{ state: 'succeeded' | 'submitted' | 'running'; provider_task_id?: string; result_object_refs?: string[]; receipt: ProviderExecutionReceipt; result?: unknown }>
  poll?(input: CreateVideoRelayOperationRequest, providerTaskId: string, identity: Identity, media?: { object_urls: string[]; object_byte_sizes: number[] }): Promise<{ state: 'succeeded' | 'submitted' | 'running' | 'failed' | 'expired'; provider_task_id?: string; receipt: ProviderExecutionReceipt; result?: unknown; safe_error_code?: string }>
  cancel?(providerTaskId: string): Promise<void>
}

type RelayDeps = { env?: Env; fetchImpl?: FetchLike; objectStore?: MediaObjectStore; provider?: VideoMediaProvider; now?: () => Date }
type Row = Record<string, unknown>
const requestId = () => `req_${randomUUID().replaceAll('-', '')}`
const iso = (now: () => Date) => now().toISOString()
const opaque = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`

class RelayError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
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
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RelayError(415, 'json_content_type_required')
  const raw = await request.text()
  if (raw.length > 2 * 1024 * 1024) throw new RelayError(413, 'control_body_too_large')
  try { return JSON.parse(raw) } catch { throw new RelayError(400, 'invalid_json') }
}
function ttl(env: Env): number { return Math.max(60_000, Math.min(60 * 60_000, Number(env.VIDEO_MEDIA_LEASE_TTL_MS ?? 15 * 60_000))) }
function multipartThreshold(env: Env): number { return Math.max(5 * 1024 * 1024, Number(env.VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES ?? 8 * 1024 * 1024)) }
function multipartPartSize(env: Env): number { return Math.max(1024 * 1024, Math.min(512 * 1024 * 1024, Number(env.VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES ?? 8 * 1024 * 1024))) }

class RelayStore {
  readonly db: Database
  constructor(path: string, private readonly now: () => Date) {
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS video_media_idempotency_v1(owner TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS video_media_leases_v1(id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_operation_id TEXT NOT NULL, purpose TEXT NOT NULL, content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL, content_type TEXT NOT NULL, consent_revision_id TEXT NOT NULL, consent_scope_hash TEXT NOT NULL, state TEXT NOT NULL, object_ref TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, multipart_upload_id TEXT, multipart_part_size INTEGER, multipart_phase TEXT, multipart_parts_json TEXT);
      CREATE TABLE IF NOT EXISTS video_media_operations_v1(id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL, provider_task_id TEXT, result_object_refs TEXT, provider_receipt TEXT, account_quota_reservation_id TEXT NOT NULL, safe_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT, UNIQUE(owner,local_operation_id));
      CREATE TABLE IF NOT EXISTS video_media_result_objects_v1(object_ref TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES video_media_operations_v1(id), content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL, content_type TEXT NOT NULL, expires_at TEXT NOT NULL, acknowledged_at TEXT);
      CREATE TABLE IF NOT EXISTS video_media_object_cleanup_v1(id TEXT PRIMARY KEY, object_kind TEXT NOT NULL, lease_id TEXT NOT NULL, object_ref TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, completed_at TEXT, last_error TEXT, UNIQUE(object_kind,lease_id,object_ref));
      CREATE TABLE IF NOT EXISTS video_media_quota_v1(owner TEXT NOT NULL, reservation_id TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(owner,reservation_id));`)
    // Read-only compatibility for operations created by the pre-lease Relay.
    // New code never writes this column and the endpoint below is not part of
    // the new wire contract.
    try { this.db.exec('ALTER TABLE video_media_operations_v1 ADD COLUMN result_json TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_upload_id TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_part_size INTEGER') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_phase TEXT') } catch { /* already present */ }
    try { this.db.exec('ALTER TABLE video_media_leases_v1 ADD COLUMN multipart_parts_json TEXT') } catch { /* already present */ }
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error } }
  replay(owner: string, key: string, hash: string): string | null {
    const row = this.db.query('SELECT request_hash,resource_id FROM video_media_idempotency_v1 WHERE owner=? AND key=?').get(owner, key) as { request_hash: string; resource_id: string } | null
    if (!row) return null
    if (row.request_hash !== hash) throw new RelayError(409, 'idempotency_conflict')
    return row.resource_id
  }
  reserve(owner: string, operationId: string, units: number, env: Env): string {
    const limit = Math.max(1, Number(env.VIDEO_MEDIA_ACCOUNT_QUOTA_UNITS ?? 1_000_000))
    const active = this.db.query("SELECT COALESCE(SUM(units),0) AS total FROM video_media_quota_v1 WHERE owner=? AND state='reserved'").get(owner) as { total: number }
    if (active.total + units > limit) throw new RelayError(429, 'account_quota_exceeded')
    const id = opaque('quota')
    this.db.query("INSERT INTO video_media_quota_v1(owner,reservation_id,operation_id,state,units) VALUES(?,?,?,'reserved',?)").run(owner, id, operationId, units)
    return id
  }
  projection(id: string) {
    const row = this.db.query('SELECT * FROM video_media_operations_v1 WHERE id=?').get(id) as Row | null
    if (!row) throw new RelayError(404, 'operation_not_found')
    return {
      id: row.id, state: row.state, ...(row.provider_task_id ? { provider_task_id: row.provider_task_id } : {}), ...(row.result_object_refs ? { result_object_refs: JSON.parse(row.result_object_refs as string) } : {}), ...(row.provider_receipt ? { provider_receipt: JSON.parse(row.provider_receipt as string) } : {}), account_quota_reservation_id: row.account_quota_reservation_id, ...(row.safe_error_code ? { safe_error_code: row.safe_error_code } : {}), created_at: row.created_at, updated_at: row.updated_at,
    }
  }
}

function defaultObjectStore(env: Env): MediaObjectStore {
  const endpoint = env.VIDEO_MEDIA_OSS_ENDPOINT?.trim()
  const bucket = env.VIDEO_MEDIA_OSS_BUCKET?.trim()
  const accessKeyId = env.VIDEO_MEDIA_OSS_ACCESS_KEY_ID?.trim()
  const accessKeySecret = env.VIDEO_MEDIA_OSS_ACCESS_KEY_SECRET?.trim()
  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
    const unavailable = async (): Promise<never> => { throw new RelayError(503, 'object_store_unavailable') }
    return { createPutUrl: unavailable, head: unavailable, delete: unavailable, createReadUrl: unavailable, putResult: unavailable, createResultReadUrl: unavailable, deleteResult: unavailable, createMultipartUpload: unavailable, createMultipartPartPutUrl: unavailable, listMultipartParts: unavailable, completeMultipartUpload: unavailable, abortMultipartUpload: unavailable }
  }
  return new OssObjectStore({ endpoint, bucket, accessKeyId, accessKeySecret, region: 'oss-cn-beijing' })
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
  const store = new RelayStore(env.VIDEO_MEDIA_RELAY_DB ?? ':memory:', now)
  const fetchImpl = deps.fetchImpl ?? fetch
  const objectStore = deps.objectStore ?? defaultObjectStore(env)
  const provider = deps.provider ?? (env.VIDEO_MEDIA_DASHSCOPE_API_KEY?.trim()
    ? new DashScopeVideoProvider({ apiKey: env.VIDEO_MEDIA_DASHSCOPE_API_KEY, fetchImpl, now, asrBaseUrl: env.VIDEO_MEDIA_DASHSCOPE_ASR_BASE_URL?.trim() || undefined })
    : defaultProvider(now))
  const leaseRow = (id: string): Row => {
    const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=?').get(id) as Row | null
    if (!row) throw new RelayError(409, 'lease_recovery_missing')
    return row
  }
  const verified = (row: Row, actual: Awaited<ReturnType<MediaObjectStore['head']>>): boolean => Boolean(actual && actual.byte_size === row.byte_size && actual.content_hash === row.content_hash && actual.content_type === row.content_type)
  async function abortFailedMultipart(row: Row, uploadId: string, cause: unknown): Promise<never> {
    if (!objectStore.abortMultipartUpload) throw new RelayError(503, 'multipart_abort_unavailable')
    try {
      await objectStore.abortMultipartUpload({ leaseId: row.id as string, uploadId })
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
    queueLeaseCleanup(row.id as string)
    await retryObjectCleanup()
    if (leaseRow(row.id as string).state !== 'deleted') throw new RelayError(503, 'multipart_object_cleanup_pending')
    if (cause instanceof RelayError) throw cause
    throw new RelayError(503, 'multipart_completion_failed')
  }
  async function recoverMultipart(row: Row): Promise<Row> {
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
        const recovered = objectStore.findMultipartUploads ? await objectStore.findMultipartUploads({ leaseId: row.id as string }) : []
        uploadId = recovered[0]?.uploadId ?? (await objectStore.createMultipartUpload?.({ leaseId: row.id as string, hash: row.content_hash as string, byteSize: row.byte_size as number, contentType: row.content_type as string }))?.uploadId ?? null
        if (!uploadId) throw new RelayError(503, 'object_store_multipart_unavailable')
      }
      store.db.query("UPDATE video_media_leases_v1 SET multipart_upload_id=?,multipart_phase='uploading' WHERE id=?").run(uploadId, row.id)
      return leaseRow(row.id as string)
    }
    if (!uploadId || !row.multipart_parts_json || !objectStore.completeMultipartUpload) throw new RelayError(503, 'multipart_completion_recovery_unavailable')
    try {
      const parts = completeMediaObjectLeaseRequestSchema.parse(JSON.parse(row.multipart_parts_json as string)).parts ?? []
      let actual = await objectStore.head(row.id as string)
      if (!verified(row, actual)) {
        try {
          await objectStore.completeMultipartUpload({ leaseId: row.id as string, uploadId, parts })
        } catch (error) {
          // A timeout can race a successful CompleteMultipartUpload response.
          // Probe the object once before aborting the still-open upload.
          actual = await objectStore.head(row.id as string)
          if (!verified(row, actual)) throw error
        }
        actual = await objectStore.head(row.id as string)
      }
      if (!verified(row, actual)) throw new RelayError(422, 'object_verification_failed')
    } catch (error) {
      return await abortFailedMultipart(row, uploadId, error)
    }
    const objectRef = (row.object_ref as string | null) ?? opaque('object')
    store.db.query("UPDATE video_media_leases_v1 SET state='ready',object_ref=?,multipart_phase='completed' WHERE id=?").run(objectRef, row.id)
    return leaseRow(row.id as string)
  }
  async function leaseCapabilities(row: Row) {
    row = await recoverMultipart(row)
    if (row.state !== 'awaiting_upload' || Date.parse(row.expires_at as string) <= now().getTime()) return {}
    const multipartUploadId = row.multipart_upload_id as string | null
    if (!multipartUploadId) {
      return await objectStore.createPutUrl({ leaseId: row.id as string, hash: row.content_hash as string, byteSize: row.byte_size as number, contentType: row.content_type as string, expiresAt: row.expires_at as string })
    }
    if (!objectStore.createMultipartPartPutUrl || !objectStore.listMultipartParts) throw new RelayError(503, 'object_store_multipart_unavailable')
    const partSize = row.multipart_part_size as number
    const partCount = Math.ceil((row.byte_size as number) / partSize)
    if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > 10_000) throw new RelayError(422, 'multipart_size_invalid')
    const uploadedParts = await objectStore.listMultipartParts({ leaseId: row.id as string, uploadId: multipartUploadId })
    const parts = await Promise.all(Array.from({ length: partCount }, async (_, index) => {
      const partNumber = index + 1
      const signed = await objectStore.createMultipartPartPutUrl!({ leaseId: row.id as string, uploadId: multipartUploadId, partNumber, expiresAt: row.expires_at as string })
      return { part_number: partNumber, put_url: signed.put_url, ...(signed.required_headers && Object.keys(signed.required_headers).length ? { required_headers: signed.required_headers } : {}) }
    }))
    return { multipart_upload: { upload_id: multipartUploadId, part_size: partSize, parts, uploaded_parts: uploadedParts } }
  }
  async function projection(operationId: string) {
    const base = store.projection(operationId)
    const rows = store.db.query('SELECT * FROM video_media_result_objects_v1 WHERE operation_id=? AND acknowledged_at IS NULL ORDER BY object_ref').all(operationId) as Row[]
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
  async function persistResult(operationId: string, result: unknown): Promise<string[]> {
    const bytes = new TextEncoder().encode(JSON.stringify(result))
    const objectRef = opaque('result')
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const expiresAt = new Date(now().getTime() + ttl(env)).toISOString()
    await objectStore.putResult({ objectRef, body: bytes, contentHash, contentType: 'application/json' })
    store.db.query('INSERT INTO video_media_result_objects_v1(object_ref,operation_id,content_hash,byte_size,content_type,expires_at,acknowledged_at) VALUES(?,?,?,?,?,?,NULL)')
      .run(objectRef, operationId, contentHash, bytes.byteLength, 'application/json', expiresAt)
    return [objectRef]
  }
  function queueCleanup(kind: 'input' | 'result', value: { leaseId?: string; objectRef?: string }): void {
    const leaseId = value.leaseId ?? ''; const objectRef = value.objectRef ?? ''
    if ((kind === 'input' && !leaseId) || (kind === 'result' && !objectRef)) return
    store.db.query(`INSERT OR IGNORE INTO video_media_object_cleanup_v1(id,object_kind,lease_id,object_ref,attempts,next_attempt_at,completed_at,last_error)
      VALUES(?,?,?,?,0,?,NULL,NULL)`).run(opaque('cleanup'), kind, leaseId, objectRef, iso(now))
  }
  function queueLeaseCleanup(leaseId: string): void { queueCleanup('input', { leaseId }) }
  function queueInputCleanup(input: CreateVideoRelayOperationRequest, owner: string): void {
    const refs = input.capability === 'visual_evidence' || input.capability === 'media_reasoning'
      ? input.input.object_refs
      : input.capability === 'speech_transcription' ? [input.input.audio_object_ref] : []
    for (const ref of refs) {
      const lease = store.db.query("SELECT id FROM video_media_leases_v1 WHERE owner=? AND object_ref=? AND state IN ('ready','bound')").get(owner, ref) as { id: string } | null
      if (lease) queueCleanup('input', { leaseId: lease.id })
    }
  }
  function queueResultCleanup(operationId: string): void {
    const rows = store.db.query('SELECT object_ref FROM video_media_result_objects_v1 WHERE operation_id=? AND acknowledged_at IS NOT NULL').all(operationId) as Array<{ object_ref: string }>
    for (const row of rows) queueCleanup('result', { objectRef: row.object_ref })
  }
  async function retryObjectCleanup(): Promise<void> {
    const due = store.db.query(`SELECT * FROM video_media_object_cleanup_v1
      WHERE completed_at IS NULL AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 32`).all(iso(now)) as Row[]
    for (const row of due) {
      try {
        if (row.object_kind === 'input') {
          await objectStore.delete(row.lease_id as string)
          store.db.query("UPDATE video_media_leases_v1 SET state='deleted',multipart_phase=CASE WHEN multipart_phase='cleanup_pending' THEN 'aborted' ELSE multipart_phase END WHERE id=? AND state <> 'deleted'").run(row.lease_id)
        } else {
          await objectStore.deleteResult(row.object_ref as string)
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
  }
  async function refreshOperation(row: Row, principal: Identity): Promise<void> {
    if (!['submitted', 'running'].includes(row.state as string) || !row.provider_task_id || !provider.poll) return
    const input = createVideoRelayOperationRequestSchema.parse(JSON.parse(row.request_json as string))
    try {
      const objectRefs = input.capability === 'speech_transcription' ? [input.input.audio_object_ref] : input.capability === 'visual_evidence' || input.capability === 'media_reasoning' ? input.input.object_refs : []
      const objectByteSizes = objectRefs.map(ref => store.db.query("SELECT byte_size FROM video_media_leases_v1 WHERE owner=? AND object_ref=?").get(principal.owner, ref) as { byte_size: number } | null)
      if (objectByteSizes.some(item => !item)) throw new RelayError(503, 'object_read_lease_unavailable')
      const polled = await provider.poll(input, row.provider_task_id as string, principal, { object_urls: [], object_byte_sizes: objectByteSizes.map(item => item!.byte_size) })
      const refs = polled.result === undefined ? [] : await persistResult(row.id as string, polled.result)
      const priorReceipt = row.provider_receipt ? JSON.parse(row.provider_receipt as string) as ProviderExecutionReceipt : null
      const receipt = reconcileProviderReceipt(priorReceipt, polled.receipt)
      store.transaction(() => {
        store.db.query('UPDATE video_media_operations_v1 SET state=?,provider_task_id=?,result_object_refs=?,provider_receipt=?,safe_error_code=?,updated_at=? WHERE id=?')
          .run(polled.state, polled.provider_task_id ?? row.provider_task_id, refs.length ? JSON.stringify(refs) : null, JSON.stringify(receipt), polled.safe_error_code ?? null, iso(now), row.id)
        if (polled.state === 'succeeded') store.db.query("UPDATE video_media_quota_v1 SET state='settled' WHERE reservation_id=?").run(row.account_quota_reservation_id)
        if (polled.state === 'failed' || polled.state === 'expired') store.db.query("UPDATE video_media_quota_v1 SET state='released' WHERE reservation_id=?").run(row.account_quota_reservation_id)
      })
      if (['succeeded', 'failed', 'expired'].includes(polled.state)) queueInputCleanup(input, principal.owner)
    } catch (error) {
      const unknown = (error instanceof RelayError && error.status >= 500) || (error instanceof DashScopeProviderError && error.status >= 500)
      if (unknown) store.db.query("UPDATE video_media_operations_v1 SET state='outcome_unknown',safe_error_code='provider_outcome_unknown',updated_at=? WHERE id=?").run(iso(now), row.id)
      if (unknown) store.db.query("UPDATE video_media_quota_v1 SET state='outcome_unknown' WHERE reservation_id=?").run(row.account_quota_reservation_id)
    }
  }
  async function identity(request: Request): Promise<Identity> {
    const service = env.GW_VIDEO_MEDIA_INTROSPECTION_TOKEN?.trim() ?? ''
    const base = env.VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE?.trim() ?? ''
    if (!service || service.length < 32 || !base) throw new RelayError(503, 'identity_unavailable')
    let response: Response
    try { response = await fetchImpl(`${base.replace(/\/+$/, '')}/internal/v1/auth/introspect`, { method: 'POST', headers: { Authorization: `Bearer ${authorization(request)}`, 'X-BB-Video-Media-Introspection': service } }) } catch { throw new RelayError(503, 'identity_unavailable') }
    if (response.status === 401 || response.status === 403) throw new RelayError(response.status, 'identity_rejected')
    if (!response.ok) throw new RelayError(503, 'identity_unavailable')
    const parsed = await response.json() as Identity & { active?: boolean }
    if (!parsed.active || !parsed.owner || !parsed.principal_id || !parsed.installation_id) throw new RelayError(503, 'identity_unavailable')
    return parsed
  }
  return async (request: Request): Promise<Response> => {
    const id = requestId()
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/healthz') return json({ ok: true, component: 'video-media-relay' }, 200, id)
      if (request.method === 'GET' && url.pathname === '/readyz') return json({ ok: true, component: 'video-media-relay', identity_configured: Boolean(env.GW_VIDEO_MEDIA_INTROSPECTION_TOKEN && env.VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE) }, 200, id)
      const principal = await identity(request)
      await retryObjectCleanup()
      if (request.method === 'POST' && url.pathname === '/v1/video-media/object-leases') {
        const key = requireControlHeaders(request); const raw = createMediaObjectLeaseRequestSchema.parse(await body(request)); const hash = canonicalRelayRequestHash(raw)
        const replay = store.replay(principal.owner, key, hash); if (replay) {
          const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(replay, principal.owner) as Row | null
          if (!row) throw new RelayError(409, 'idempotency_resource_missing')
          // A crash after receiving the lease but before completing a direct
          // PUT must be resumable.  Re-signing does not change its immutable
          // hash/size/type/object key and cannot widen the consent scope.
          const signed = await leaseCapabilities(row)
          return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), ...signed, expires_at: row.expires_at }), 200, id)
        }
        const leaseId = opaque('lease'); const expiresAt = new Date(now().getTime() + ttl(env)).toISOString()
        const multipart = raw.byte_size >= multipartThreshold(env)
        store.transaction(() => {
          store.db.query(`INSERT INTO video_media_leases_v1(
            id,owner,local_operation_id,purpose,content_hash,byte_size,content_type,consent_revision_id,consent_scope_hash,state,object_ref,expires_at,created_at,multipart_upload_id,multipart_part_size,multipart_phase,multipart_parts_json
          ) VALUES(?,?,?,?,?,?,?,?,?,'awaiting_upload',NULL,?,?,?,? ,?,NULL)`).run(
            leaseId, principal.owner, raw.local_operation_id, raw.purpose, raw.content_hash, raw.byte_size, raw.content_type, raw.consent_revision_id, raw.consent_scope_hash, expiresAt, iso(now), null, multipart ? multipartPartSize(env) : null, multipart ? 'initializing' : null,
          )
          store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId)
        })
        const row = leaseRow(leaseId)
        return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: 'awaiting_upload', ...await leaseCapabilities(row), expires_at: expiresAt }), 201, id)
      }
      const leaseMatch = /^\/v1\/video-media\/object-leases\/([a-z][a-z0-9_]{7,127})\/(complete|renew)$/.exec(url.pathname)
      if (leaseMatch && request.method === 'POST') {
        const key = requireControlHeaders(request); const leaseId = leaseMatch[1]!; const action = leaseMatch[2]!; const rawBody = await body(request); const completion = action === 'complete' ? completeMediaObjectLeaseRequestSchema.parse(rawBody) : (rawBody, {})
        let row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(leaseId, principal.owner) as Row | null; if (!row) throw new RelayError(404, 'lease_not_found')
        row = await recoverMultipart(row)
        const hash = canonicalRelayRequestHash({ lease_id: leaseId, action, completion }); const replay = store.replay(principal.owner, key, hash); if (replay) return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), ...await leaseCapabilities(row), expires_at: row.expires_at }), 200, id)
        if (action === 'renew') { if (Date.parse(row.expires_at as string) <= now().getTime() || row.state === 'deleted') throw new RelayError(410, 'lease_expired'); const expiresAt = new Date(now().getTime() + ttl(env)).toISOString(); store.db.query('UPDATE video_media_leases_v1 SET expires_at=? WHERE id=?').run(expiresAt, leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId); const renewed = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=?').get(leaseId) as Row; return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), ...await leaseCapabilities(renewed), expires_at: expiresAt }), 200, id) }
        if (Date.parse(row.expires_at as string) <= now().getTime()) throw new RelayError(410, 'lease_expired')
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
          const uploaded = await objectStore.listMultipartParts({ leaseId, uploadId })
          const actualByPart = new Map(uploaded.map(item => [item.part_number, item.etag]))
          if (supplied.some(item => actualByPart.get(item.part_number) !== item.etag)) throw new RelayError(422, 'multipart_parts_unverified')
          store.db.query("UPDATE video_media_leases_v1 SET multipart_phase='completing',multipart_parts_json=? WHERE id=?").run(JSON.stringify({ parts: supplied }), leaseId)
          row = leaseRow(leaseId)
          await recoverMultipart(row)
          row = leaseRow(leaseId)
          store.db.query('INSERT OR IGNORE INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId)
          return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), expires_at: row.expires_at }), 200, id)
        } else if (completion.parts?.length) throw new RelayError(422, 'multipart_parts_unexpected')
        const actual = await objectStore.head(leaseId); if (!actual || actual.byte_size !== row.byte_size || actual.content_hash !== row.content_hash || actual.content_type !== row.content_type) throw new RelayError(422, 'object_verification_failed')
        const objectRef = opaque('object'); store.transaction(() => { store.db.query("UPDATE video_media_leases_v1 SET state='ready',object_ref=? WHERE id=?").run(objectRef, leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId) })
        return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: 'ready', object_ref: objectRef, expires_at: row.expires_at }), 200, id)
      }
      const deleteLease = /^\/v1\/video-media\/object-leases\/([a-z][a-z0-9_]{7,127})$/.exec(url.pathname)
      if (deleteLease && request.method === 'DELETE') { const key = requireControlHeaders(request); const leaseId = deleteLease[1]!; const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(leaseId, principal.owner) as Row | null; if (!row) return new Response(null, { status: 204, headers: { 'X-Request-Id': id } }); const hash = canonicalRelayRequestHash({ lease_id: leaseId, action: 'delete' }); const replay = store.replay(principal.owner, key, hash); if (!replay) { if (row.multipart_upload_id && objectStore.abortMultipartUpload) await objectStore.abortMultipartUpload({ leaseId, uploadId: row.multipart_upload_id as string }); await objectStore.delete(leaseId); store.transaction(() => { store.db.query("UPDATE video_media_leases_v1 SET state='deleted' WHERE id=?").run(leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId) }) }; return new Response(null, { status: 204, headers: { 'X-Request-Id': id } }) }
      if (request.method === 'POST' && url.pathname === '/v1/video-media/operations') {
        const key = requireControlHeaders(request); const raw = createVideoRelayOperationRequestSchema.parse(await body(request)); const hash = canonicalRelayRequestHash(raw); const replay = store.replay(principal.owner, key, hash); if (replay) return json(await projection(replay), 200, id)
        const objectRefs = raw.capability === 'visual_evidence' || raw.capability === 'media_reasoning' ? raw.input.object_refs : raw.capability === 'speech_transcription' ? [raw.input.audio_object_ref] : []
        const referencedObjects = objectRefs.map(ref => store.db.query("SELECT consent_revision_id,consent_scope_hash FROM video_media_leases_v1 WHERE owner=? AND object_ref=? AND state='ready'").get(principal.owner, ref) as { consent_revision_id: string; consent_scope_hash: string } | null)
        if (referencedObjects.some(item => !item)) throw new RelayError(422, 'object_not_ready')
        if (referencedObjects.some(item => item!.consent_revision_id !== raw.consent_revision_id || item!.consent_scope_hash !== raw.consent_scope_hash)) throw new RelayError(422, 'object_consent_scope_mismatch')
        const operationId = opaque('remoteop'); const units = Math.max(1, raw.capability === 'semantic_embedding' ? raw.input.items.length : objectRefs.length || 1); const quota = store.transaction(() => store.reserve(principal.owner, operationId, units, env)); const created = iso(now)
        store.transaction(() => { store.db.query(`INSERT INTO video_media_operations_v1(
          id,owner,local_operation_id,idempotency_key,request_hash,request_json,state,provider_task_id,result_object_refs,provider_receipt,account_quota_reservation_id,safe_error_code,created_at,updated_at,acknowledged_at
        ) VALUES(?,?,?,?,?,?, 'accepted',NULL,NULL,NULL,?,NULL,?,?,NULL)`).run(operationId, principal.owner, raw.local_operation_id, key, hash, JSON.stringify(raw), quota, created, created); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, operationId) })
        const providerInputExpiry = raw.capability === 'speech_transcription' && raw.input.mode === 'long_async'
          ? new Date(now().getTime() + 48 * 60 * 60_000).toISOString()
          : undefined
        if (providerInputExpiry) {
          // A submitted Fun-ASR task may not fetch the URL immediately.  This
          // internal binding extends only the already-bound object read lease;
          // it neither returns a longer client upload capability nor permits a
          // new object/owner/hash to be substituted.
          store.db.query("UPDATE video_media_leases_v1 SET state='bound',expires_at=? WHERE owner=? AND object_ref=? AND state='ready'")
            .run(providerInputExpiry, principal.owner, objectRefs[0])
        }
        const objectMedia = await Promise.all(objectRefs.map(async ref => {
          const lease = store.db.query("SELECT id,expires_at,byte_size FROM video_media_leases_v1 WHERE owner=? AND object_ref=? AND state IN ('ready','bound')").get(principal.owner, ref) as { id: string; expires_at: string; byte_size: number } | null
          if (!lease) throw new RelayError(503, 'object_read_lease_unavailable')
          return { url: await objectStore.createReadUrl({ leaseId: lease.id, expiresAt: lease.expires_at }), byte_size: lease.byte_size }
        }))
        try {
          // The accepted operation and its request hash exist before the
          // upstream call.  A transport failure is therefore never retried as
          // a fresh paid submission; it is reconciled as outcome_unknown.
          const executed = await provider.execute(raw, principal, { object_urls: objectMedia.map(item => item.url), object_byte_sizes: objectMedia.map(item => item.byte_size) })
          const resultRefs = executed.result === undefined ? (executed.result_object_refs ?? []) : await persistResult(operationId, executed.result)
          store.transaction(() => {
            store.db.query('UPDATE video_media_operations_v1 SET state=?,provider_task_id=?,result_object_refs=?,provider_receipt=?,updated_at=? WHERE id=?').run(executed.state, executed.provider_task_id ?? null, resultRefs.length ? JSON.stringify(resultRefs) : null, JSON.stringify(executed.receipt), iso(now), operationId)
            store.db.query("UPDATE video_media_quota_v1 SET state='settled' WHERE reservation_id=?").run(quota)
          })
          if (executed.state === 'succeeded') {
            queueInputCleanup(raw, principal.owner)
            await retryObjectCleanup()
          }
          return json(await projection(operationId), 202, id)
        } catch (error) { const unknown = (error instanceof RelayError && error.status >= 500) || (error instanceof DashScopeProviderError && error.status >= 500); store.db.query('UPDATE video_media_operations_v1 SET state=?,safe_error_code=?,updated_at=? WHERE id=?').run(unknown ? 'outcome_unknown' : 'failed', unknown ? 'provider_outcome_unknown' : error instanceof RelayError || error instanceof DashScopeProviderError ? error.code : 'provider_failed', iso(now), operationId); store.db.query('UPDATE video_media_quota_v1 SET state=? WHERE reservation_id=?').run(unknown ? 'outcome_unknown' : 'released', quota); if (!unknown) { queueInputCleanup(raw, principal.owner); await retryObjectCleanup() }; if (error instanceof RelayError || error instanceof DashScopeProviderError) throw new RelayError(error.status, error.code); throw new RelayError(503, 'provider_outcome_unknown') }
      }
      const operationId = /^\/v1\/video-media\/operations\/([a-z][a-z0-9_]{7,127})(?:\/(cancel|ack))?$/.exec(url.pathname)
      const legacyResultId = /^\/v1\/video-media\/operations\/([a-z][a-z0-9_]{7,127})\/result$/.exec(url.pathname)
      if (legacyResultId && request.method === 'GET') {
        const row = store.db.query('SELECT * FROM video_media_operations_v1 WHERE id=? AND owner=?').get(legacyResultId[1]!, principal.owner) as Row | null
        if (!row) throw new RelayError(404, 'operation_not_found')
        if (!row.result_json) throw new RelayError(410, 'legacy_result_unavailable')
        return json(JSON.parse(row.result_json as string), 200, id)
      }
      if (operationId) { const idValue = operationId[1]!; const action = operationId[2]; const row = store.db.query('SELECT * FROM video_media_operations_v1 WHERE id=? AND owner=?').get(idValue, principal.owner) as Row | null; if (!row) throw new RelayError(404, 'operation_not_found'); if (request.method === 'GET' && !action) { await refreshOperation(row, principal); await retryObjectCleanup(); return json(await projection(idValue), 200, id) } if (request.method === 'POST' && action) { const key = requireControlHeaders(request); const parsed = action === 'ack' ? operationAcknowledgementSchema.parse(await body(request)) : (await body(request), {}); const hash = canonicalRelayRequestHash({ operation_id: idValue, action, parsed }); const replay = store.replay(principal.owner, key, hash); if (!replay) { if (action === 'cancel') { if (row.provider_task_id && provider.cancel) await provider.cancel(row.provider_task_id as string); store.db.query("UPDATE video_media_operations_v1 SET state='cancelled',updated_at=? WHERE id=?").run(iso(now), idValue); queueInputCleanup(createVideoRelayOperationRequestSchema.parse(JSON.parse(row.request_json as string)), principal.owner) } else { if (row.state !== 'succeeded') throw new RelayError(409, 'operation_not_acknowledgeable'); const results = store.db.query('SELECT * FROM video_media_result_objects_v1 WHERE operation_id=? AND acknowledged_at IS NULL').all(idValue) as Row[]; const expected = results.map(item => item.content_hash as string).sort(); if (JSON.stringify([...parsed.result_hashes].sort()) !== JSON.stringify(expected)) throw new RelayError(422, 'result_hash_mismatch'); store.transaction(() => { store.db.query('UPDATE video_media_operations_v1 SET acknowledged_at=?,updated_at=? WHERE id=?').run(iso(now), iso(now), idValue); store.db.query('UPDATE video_media_result_objects_v1 SET acknowledged_at=? WHERE operation_id=?').run(iso(now), idValue); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, idValue) }); queueResultCleanup(idValue) }; if (action === 'cancel') store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, idValue); await retryObjectCleanup() }; return action === 'ack' ? new Response(null, { status: 204, headers: { 'X-Request-Id': id } }) : json(await projection(idValue), 200, id) } }
      throw new RelayError(404, 'not_found')
    } catch (error) {
      if (error instanceof RelayError) return json({ error: error.code, request_id: id }, error.status, id)
      if (error instanceof Error && error.name === 'ZodError') return json({ error: 'invalid_request', request_id: id }, 422, id)
      return json({ error: 'internal_error', request_id: id }, 500, id)
    }
  }
}

if (import.meta.main) {
  const handler = createVideoMediaRelayFetch()
  Bun.serve({ hostname: process.env.VIDEO_MEDIA_RELAY_HOST ?? '0.0.0.0', port: Number(process.env.VIDEO_MEDIA_RELAY_PORT ?? 8791), fetch: handler })
}
