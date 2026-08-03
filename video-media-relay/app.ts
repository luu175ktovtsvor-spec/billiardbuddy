import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Database } from 'bun:sqlite'
import {
  canonicalRelayRequestHash,
  createMediaObjectLeaseRequestSchema,
  createVideoRelayOperationRequestSchema,
  mediaObjectLeaseSchema,
  operationAcknowledgementSchema,
  type CreateVideoRelayOperationRequest,
  type ProviderExecutionReceipt,
} from './contracts/relayApi.ts'

type Env = Record<string, string | undefined>
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Identity = { principal_id: string; installation_id: string; session_id: string; expires_at: number; owner: string }
type ObjectMetadata = { byte_size: number; content_hash: string; content_type: string }
export type MediaObjectStore = {
  createPutUrl(input: { leaseId: string; hash: string; byteSize: number; contentType: string; expiresAt: string }): Promise<{ put_url: string; required_headers?: Record<string, string> }>
  head(leaseId: string): Promise<ObjectMetadata | null>
  delete(leaseId: string): Promise<void>
}
export type VideoMediaProvider = {
  execute(input: CreateVideoRelayOperationRequest, identity: Identity): Promise<{ state: 'succeeded' | 'submitted' | 'running'; provider_task_id?: string; result_object_refs?: string[]; receipt: ProviderExecutionReceipt }>
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

class RelayStore {
  readonly db: Database
  constructor(path: string, private readonly now: () => Date) {
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS video_media_idempotency_v1(owner TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS video_media_leases_v1(id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_operation_id TEXT NOT NULL, purpose TEXT NOT NULL, content_hash TEXT NOT NULL, byte_size INTEGER NOT NULL, content_type TEXT NOT NULL, consent_revision_id TEXT NOT NULL, consent_scope_hash TEXT NOT NULL, state TEXT NOT NULL, object_ref TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS video_media_operations_v1(id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_operation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL, provider_task_id TEXT, result_object_refs TEXT, provider_receipt TEXT, account_quota_reservation_id TEXT NOT NULL, safe_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT, UNIQUE(owner,local_operation_id));
      CREATE TABLE IF NOT EXISTS video_media_quota_v1(owner TEXT NOT NULL, reservation_id TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(owner,reservation_id));`)
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

function defaultObjectStore(): MediaObjectStore {
  return {
    async createPutUrl(input) { return { put_url: `https://object.invalid/video-media/${encodeURIComponent(input.leaseId)}`, required_headers: { 'Content-Type': input.contentType, 'X-Content-SHA256': input.hash } } },
    async head() { return null }, async delete() {},
  }
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
  const objectStore = deps.objectStore ?? defaultObjectStore()
  const provider = deps.provider ?? defaultProvider(now)
  const fetchImpl = deps.fetchImpl ?? fetch
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
      if (request.method === 'POST' && url.pathname === '/v1/video-media/object-leases') {
        const key = requireControlHeaders(request); const raw = createMediaObjectLeaseRequestSchema.parse(await body(request)); const hash = canonicalRelayRequestHash(raw)
        const replay = store.replay(principal.owner, key, hash); if (replay) { const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=?').get(replay) as Row; return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), expires_at: row.expires_at }), 200, id) }
        const leaseId = opaque('lease'); const expiresAt = new Date(now().getTime() + ttl(env)).toISOString(); const signed = await objectStore.createPutUrl({ leaseId, hash: raw.content_hash, byteSize: raw.byte_size, contentType: raw.content_type, expiresAt })
        store.transaction(() => { store.db.query("INSERT INTO video_media_leases_v1 VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?)").run(leaseId, principal.owner, raw.local_operation_id, raw.purpose, raw.content_hash, raw.byte_size, raw.content_type, raw.consent_revision_id, raw.consent_scope_hash, 'awaiting_upload', expiresAt, iso(now)); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId) })
        return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: 'awaiting_upload', ...signed, expires_at: expiresAt }), 201, id)
      }
      const leaseMatch = /^\/v1\/video-media\/object-leases\/([a-z][a-z0-9_]{7,127})\/(complete|renew)$/.exec(url.pathname)
      if (leaseMatch && request.method === 'POST') {
        const key = requireControlHeaders(request); await body(request); const leaseId = leaseMatch[1]!; const action = leaseMatch[2]!; const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(leaseId, principal.owner) as Row | null; if (!row) throw new RelayError(404, 'lease_not_found')
        const hash = canonicalRelayRequestHash({ lease_id: leaseId, action }); const replay = store.replay(principal.owner, key, hash); if (replay) return json(mediaObjectLeaseSchema.parse({ lease_id: row.id, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), expires_at: row.expires_at }), 200, id)
        if (action === 'renew') { if (Date.parse(row.expires_at as string) <= now().getTime() || row.state === 'deleted') throw new RelayError(410, 'lease_expired'); const expiresAt = new Date(now().getTime() + ttl(env)).toISOString(); store.db.query('UPDATE video_media_leases_v1 SET expires_at=? WHERE id=?').run(expiresAt, leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId); return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: row.state, ...(row.object_ref ? { object_ref: row.object_ref } : {}), expires_at: expiresAt }), 200, id) }
        if (Date.parse(row.expires_at as string) <= now().getTime()) throw new RelayError(410, 'lease_expired')
        const actual = await objectStore.head(leaseId); if (!actual || actual.byte_size !== row.byte_size || actual.content_hash !== row.content_hash || actual.content_type !== row.content_type) throw new RelayError(422, 'object_verification_failed')
        const objectRef = opaque('object'); store.transaction(() => { store.db.query("UPDATE video_media_leases_v1 SET state='ready',object_ref=? WHERE id=?").run(objectRef, leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId) })
        return json(mediaObjectLeaseSchema.parse({ lease_id: leaseId, state: 'ready', object_ref: objectRef, expires_at: row.expires_at }), 200, id)
      }
      const deleteLease = /^\/v1\/video-media\/object-leases\/([a-z][a-z0-9_]{7,127})$/.exec(url.pathname)
      if (deleteLease && request.method === 'DELETE') { const key = requireControlHeaders(request); const leaseId = deleteLease[1]!; const row = store.db.query('SELECT * FROM video_media_leases_v1 WHERE id=? AND owner=?').get(leaseId, principal.owner) as Row | null; if (!row) return new Response(null, { status: 204, headers: { 'X-Request-Id': id } }); const hash = canonicalRelayRequestHash({ lease_id: leaseId, action: 'delete' }); const replay = store.replay(principal.owner, key, hash); if (!replay) { await objectStore.delete(leaseId); store.transaction(() => { store.db.query("UPDATE video_media_leases_v1 SET state='deleted' WHERE id=?").run(leaseId); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, leaseId) }) }; return new Response(null, { status: 204, headers: { 'X-Request-Id': id } }) }
      if (request.method === 'POST' && url.pathname === '/v1/video-media/operations') {
        const key = requireControlHeaders(request); const raw = createVideoRelayOperationRequestSchema.parse(await body(request)); const hash = canonicalRelayRequestHash(raw); const replay = store.replay(principal.owner, key, hash); if (replay) return json(store.projection(replay), 200, id)
        const objectRefs = raw.capability === 'visual_evidence' || raw.capability === 'media_reasoning' ? raw.input.object_refs : raw.capability === 'speech_transcription' ? [raw.input.audio_object_ref] : []
        if (objectRefs.some(ref => !(store.db.query("SELECT 1 FROM video_media_leases_v1 WHERE owner=? AND object_ref=? AND state='ready'").get(principal.owner, ref)))) throw new RelayError(422, 'object_not_ready')
        const operationId = opaque('remoteop'); const units = Math.max(1, raw.capability === 'semantic_embedding' ? raw.input.items.length : objectRefs.length || 1); const quota = store.transaction(() => store.reserve(principal.owner, operationId, units, env)); const created = iso(now)
        store.transaction(() => { store.db.query("INSERT INTO video_media_operations_v1 VALUES(?,?,?,?,?,?, 'accepted',NULL,NULL,NULL,?,NULL,?,?,NULL)").run(operationId, principal.owner, raw.local_operation_id, key, hash, JSON.stringify(raw), quota, created, created); store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, operationId) })
        try { const executed = await provider.execute(raw, principal); store.transaction(() => { store.db.query('UPDATE video_media_operations_v1 SET state=?,provider_task_id=?,result_object_refs=?,provider_receipt=?,updated_at=? WHERE id=?').run(executed.state, executed.provider_task_id ?? null, executed.result_object_refs ? JSON.stringify(executed.result_object_refs) : null, JSON.stringify(executed.receipt), iso(now), operationId); store.db.query("UPDATE video_media_quota_v1 SET state='settled' WHERE reservation_id=?").run(quota) }); return json(store.projection(operationId), 202, id) } catch (error) { const unknown = error instanceof RelayError && error.status >= 500; store.db.query('UPDATE video_media_operations_v1 SET state=?,safe_error_code=?,updated_at=? WHERE id=?').run(unknown ? 'outcome_unknown' : 'failed', unknown ? 'provider_outcome_unknown' : error instanceof RelayError ? error.code : 'provider_failed', iso(now), operationId); store.db.query('UPDATE video_media_quota_v1 SET state=? WHERE reservation_id=?').run(unknown ? 'outcome_unknown' : 'released', quota); if (error instanceof RelayError) throw error; throw new RelayError(503, 'provider_outcome_unknown') }
      }
      const operationId = /^\/v1\/video-media\/operations\/([a-z][a-z0-9_]{7,127})(?:\/(cancel|ack))?$/.exec(url.pathname)
      if (operationId) { const idValue = operationId[1]!; const action = operationId[2]; const row = store.db.query('SELECT * FROM video_media_operations_v1 WHERE id=? AND owner=?').get(idValue, principal.owner) as Row | null; if (!row) throw new RelayError(404, 'operation_not_found'); if (request.method === 'GET' && !action) return json(store.projection(idValue), 200, id); if (request.method === 'POST' && action) { const key = requireControlHeaders(request); const parsed = action === 'ack' ? operationAcknowledgementSchema.parse(await body(request)) : (await body(request), {}); const hash = canonicalRelayRequestHash({ operation_id: idValue, action, parsed }); const replay = store.replay(principal.owner, key, hash); if (!replay) { if (action === 'cancel') { if (row.provider_task_id && provider.cancel) await provider.cancel(row.provider_task_id as string); store.db.query("UPDATE video_media_operations_v1 SET state='cancelled',updated_at=? WHERE id=?").run(iso(now), idValue) } else { if (row.state !== 'succeeded') throw new RelayError(409, 'operation_not_acknowledgeable'); store.db.query('UPDATE video_media_operations_v1 SET acknowledged_at=?,updated_at=? WHERE id=?').run(iso(now), iso(now), idValue) }; store.db.query('INSERT INTO video_media_idempotency_v1 VALUES(?,?,?,?)').run(principal.owner, key, hash, idValue) }; return action === 'ack' ? new Response(null, { status: 204, headers: { 'X-Request-Id': id } }) : json(store.projection(idValue), 200, id) } }
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
