import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { createVideoMediaRelayFetch as createVideoMediaRelayFetchImpl, type MediaObjectStore, type VideoMediaProvider } from '../../video-media-relay/app.ts'
import { videoMediaCapacityPolicyFromEnvironment, type VideoMediaAdmissionBackend, type VideoMediaAdmissionScope } from '../../video-media-relay/capacityPolicy.ts'
import { installationAccessTokenHash, issueVideoRemoteConsentClaim, videoMediaOperationByLocalOperationPath, type ProviderExecutionReceipt, type VideoRelayOperationProjection, type VideoRemoteConsentPurpose } from '../../video-media-relay/contracts/relayApi.ts'
import { DashScopeProviderError } from '../../video-media-relay/providers/dashscope.ts'
import { validateVideoMediaRelayEnvironment } from '../../video-media-relay/validate-deployment-env.ts'
import { VideoMediaRelayClient, VideoMediaRelayClientError, videoMediaRelayTransportPolicyFromEnvironment } from '../src/server/video/infrastructure/providers/videoMediaRelayClient.ts'

const token = 'x'.repeat(40)
const hash = `sha256:${'a'.repeat(64)}`
const now = () => new Date('2026-08-03T00:00:00.000Z')
const headers = (key: string) => ({ Authorization: 'Bearer installation-token', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Request-Timestamp': new Date().toISOString() })
const identityFetch = async () => Response.json({ active: true, principal_id: 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', installation_id: 'install_12345678', session_id: 'abcdefghijklmnopqrstuvwx', expires_at: Date.now() + 60_000, owner: 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:install_12345678' })
const remoteConsentSigningKey = 'test-video-remote-consent-signing-key-000000000000000000000000'

function testConsentPurpose(raw: Record<string, unknown>, lease: boolean): VideoRemoteConsentPurpose {
  if (lease) {
    if (raw.purpose === 'visual_frames') return 'visual_evidence'
    if (raw.purpose === 'audio_for_asr') return 'asr'
    return 'planning'
  }
  if (raw.application_role === 'shot_evidence') return 'visual_evidence'
  if (raw.application_role === 'planning') return 'planning'
  if (raw.application_role === 'caption_translation') return 'caption_translation'
  if (raw.application_role === 'asr') return 'asr'
  return 'semantic_search'
}

/** Existing Relay tests exercise storage/recovery concerns. This wrapper gives
 * them the same genuine HMAC claim a Sidecar would send, without making each
 * storage fixture repeat unrelated authorization boilerplate. Dedicated tests
 * below call the implementation directly for forged/expired/cross-owner cases. */
function createVideoMediaRelayFetch(...args: Parameters<typeof createVideoMediaRelayFetchImpl>) {
  const deps = args[0] ?? {}
  const clock = deps.now ?? (() => new Date())
  const handler = createVideoMediaRelayFetchImpl({
    ...deps,
    env: { ...deps.env, VIDEO_MEDIA_REMOTE_CONSENT_SIGNING_KEY: remoteConsentSigningKey },
  })
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const isLease = request.method === 'POST' && url.pathname === '/v1/video-media/object-leases'
    const isOperation = request.method === 'POST' && url.pathname === '/v1/video-media/operations'
    if (!isLease && !isOperation) return await handler(request)
    let raw: Record<string, unknown>
    try {
      const candidate = await request.clone().json()
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return await handler(request)
      raw = candidate as Record<string, unknown>
    } catch {
      return await handler(request)
    }
    if (typeof raw.consent_revision_id !== 'string' || typeof raw.consent_scope_hash !== 'string') return await handler(request)
    if (typeof raw.remote_consent_claim !== 'string') {
      const bearer = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
      const issuedAt = clock().getTime()
      raw.remote_consent_claim = issueVideoRemoteConsentClaim({
        v: 1,
        identity_token_hash: installationAccessTokenHash(bearer),
        project_id: 'vid_consent_test',
        source_ids: ['src_consent_test'],
        purpose: testConsentPurpose(raw, isLease),
        consent_revision_id: String(raw.consent_revision_id),
        consent_scope_hash: String(raw.consent_scope_hash) as `sha256:${string}`,
        region: 'cn-beijing',
        issued_at: issuedAt,
        expires_at: issuedAt + 60_000,
      }, remoteConsentSigningKey)
    }
    return await handler(new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(raw),
      signal: request.signal,
    }))
  }
}

type ClientLeaseInput = Parameters<VideoMediaRelayClient['uploadObject']>[0]
function clientLeaseInput(input: Omit<ClientLeaseInput, 'remote_consent_claim'>): ClientLeaseInput {
  const issuedAt = now().getTime()
  return {
    ...input,
    remote_consent_claim: issueVideoRemoteConsentClaim({
      v: 1,
      identity_token_hash: installationAccessTokenHash('installation-token'),
      project_id: 'vid_consent_test',
      source_ids: ['src_consent_test'],
      purpose: testConsentPurpose({ purpose: input.purpose }, true),
      consent_revision_id: input.consent_revision_id,
      consent_scope_hash: input.consent_scope_hash,
      region: 'cn-beijing',
      issued_at: issuedAt,
      expires_at: issuedAt + 60_000,
    }, remoteConsentSigningKey),
  }
}

function deploymentEnvironment(): Record<string, string> {
  return {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_REMOTE_CONSENT_SIGNING_KEY: remoteConsentSigningKey,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: '/var/lib/video-media-relay/relay.sqlite',
    VIDEO_MEDIA_DASHSCOPE_API_KEY: 'd'.repeat(24),
    VIDEO_MEDIA_OSS_ENDPOINT: 'oss-cn-beijing.aliyuncs.com',
    VIDEO_MEDIA_OSS_BUCKET: 'video-test-bucket',
    VIDEO_MEDIA_OSS_ACCESS_KEY_ID: 'i'.repeat(16),
    VIDEO_MEDIA_OSS_ACCESS_KEY_SECRET: 's'.repeat(16),
    VIDEO_MEDIA_REGION: 'cn-beijing',
    VIDEO_MEDIA_QUOTA_POLICY_REVISION: 'test-v1',
    VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1000',
    VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1000',
    VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS: '8',
    VIDEO_MEDIA_LEASE_TTL_MS: '60000',
    VIDEO_MEDIA_LEASE_MAX_RETENTION_MS: '604800000',
    VIDEO_MEDIA_OUTCOME_UNKNOWN_RETENTION_MS: '3600000',
    VIDEO_MEDIA_CONTROL_BODY_TIMEOUT_MS: '1000',
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TIMEOUT_MS: '1000',
    VIDEO_MEDIA_DASHSCOPE_TIMEOUT_MS: '1000',
    VIDEO_MEDIA_DASHSCOPE_RESPONSE_MAX_BYTES: '1024',
    VIDEO_MEDIA_DASHSCOPE_TRANSCRIPT_MAX_BYTES: '1024',
    VIDEO_MEDIA_CAPACITY_POLICY_REVISION: 'test-v1',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_REF: 'test-account',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_BINDING_REVISION: 'test-v1',
    VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX: '16',
    VIDEO_MEDIA_DASHSCOPE_OWNER_QUEUE_MAX: '4',
    VIDEO_MEDIA_DASHSCOPE_MAX_WAIT_MS: '1000',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_MAX_ACTIVE: '4',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_OWNER_MAX_ACTIVE: '1',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_RPM: '120',
    VIDEO_MEDIA_DASHSCOPE_VISUAL_MAX_ACTIVE: '2',
    VIDEO_MEDIA_DASHSCOPE_VISUAL_OWNER_MAX_ACTIVE: '1',
    VIDEO_MEDIA_DASHSCOPE_VISUAL_RPM: '60',
    VIDEO_MEDIA_DASHSCOPE_REASONING_MAX_ACTIVE: '2',
    VIDEO_MEDIA_DASHSCOPE_REASONING_OWNER_MAX_ACTIVE: '1',
    VIDEO_MEDIA_DASHSCOPE_REASONING_RPM: '60',
    VIDEO_MEDIA_DASHSCOPE_ASR_MAX_ACTIVE: '2',
    VIDEO_MEDIA_DASHSCOPE_ASR_OWNER_MAX_ACTIVE: '1',
    VIDEO_MEDIA_DASHSCOPE_ASR_RPM: '30',
    VIDEO_MEDIA_DASHSCOPE_EMBEDDING_MAX_ACTIVE: '2',
    VIDEO_MEDIA_DASHSCOPE_EMBEDDING_OWNER_MAX_ACTIVE: '1',
    VIDEO_MEDIA_DASHSCOPE_EMBEDDING_RPM: '120',
    VIDEO_MEDIA_OBJECT_VERIFY_MAX_ACTIVE: '2',
    VIDEO_MEDIA_OBJECT_VERIFY_OWNER_MAX_ACTIVE: '1',
    VIDEO_MEDIA_OBJECT_VERIFY_QUEUE_MAX: '16',
    VIDEO_MEDIA_OBJECT_VERIFY_OWNER_QUEUE_MAX: '4',
    VIDEO_MEDIA_OBJECT_VERIFY_MAX_WAIT_MS: '1000',
    VIDEO_MEDIA_OBJECT_VERIFY_TIMEOUT_MS: '1000',
    VIDEO_MEDIA_IDENTITY_MAX_ACTIVE: '2',
    VIDEO_MEDIA_IDENTITY_QUEUE_MAX: '4',
    VIDEO_MEDIA_IDENTITY_MAX_WAIT_MS: '1000',
  }
}

test('Sidecar OSS transport timeout is external and defaults to a cross-border-safe bounded window', () => {
  expect(videoMediaRelayTransportPolicyFromEnvironment({})).toEqual({
    uploadTimeoutMs: 240_000,
    uploadRetries: 3,
    controlTimeoutMs: 15_000,
    resultTimeoutMs: 60_000,
  })
  expect(videoMediaRelayTransportPolicyFromEnvironment({
    BB_VIDEO_MEDIA_UPLOAD_TIMEOUT_MS: '180000',
    BB_VIDEO_MEDIA_UPLOAD_RETRIES: '2',
    BB_VIDEO_MEDIA_CONTROL_TIMEOUT_MS: '30000',
    BB_VIDEO_MEDIA_RESULT_TIMEOUT_MS: '120000',
  })).toEqual({ uploadTimeoutMs: 180_000, uploadRetries: 2, controlTimeoutMs: 30_000, resultTimeoutMs: 120_000 })
  expect(() => videoMediaRelayTransportPolicyFromEnvironment({ BB_VIDEO_MEDIA_UPLOAD_TIMEOUT_MS: '360000' }))
    .toThrow('BB_VIDEO_MEDIA_UPLOAD_TIMEOUT_MS')
})

test('Video Media Relay 只在容器字幕运行时探针成功后声明 readyz 可用于烧录', async () => {
  const unavailable = createVideoMediaRelayFetch({
    env: {
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      VIDEO_MEDIA_RELAY_DB: ':memory:',
    },
    fetchImpl: identityFetch,
    now,
  })
  const unavailableResponse = await unavailable(new Request('http://relay/readyz'))
  expect(unavailableResponse.status).toBe(503)
  expect(await unavailableResponse.json()).toMatchObject({
    ok: false,
    component: 'video-media-relay',
    subtitle_burn_in: { available: false, font_family: 'Noto Sans CJK SC' },
  })

  const ready = createVideoMediaRelayFetch({
    env: {
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      VIDEO_MEDIA_RELAY_DB: ':memory:',
      VIDEO_MEDIA_SUBTITLE_RUNTIME_READY: '1',
    },
    fetchImpl: identityFetch,
    now,
  })
  const readyResponse = await ready(new Request('http://relay/readyz'))
  expect(readyResponse.status).toBe(200)
  expect(await readyResponse.json()).toMatchObject({
    ok: true,
    component: 'video-media-relay',
    subtitle_burn_in: { available: true, font_family: 'Noto Sans CJK SC' },
  })
})

test('Video Media Relay 拒绝伪造、过期、跨 bearer 与用途扩大的远程授权声明，并在验签器缺失时失败关闭', async () => {
  const baseEnv = {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_REMOTE_CONSENT_SIGNING_KEY: remoteConsentSigningKey,
  }
  const handler = createVideoMediaRelayFetchImpl({ env: baseEnv, fetchImpl: identityFetch, now })
  const issuedAt = now().getTime()
  const lease = (claim: string) => ({
    local_operation_id: 'task_consent_claim_0001',
    purpose: 'audio_for_asr' as const,
    content_hash: hash,
    byte_size: 4,
    content_type: 'audio/wav',
    consent_revision_id: 'consent_claim_0001',
    consent_scope_hash: hash,
    remote_consent_claim: claim,
  })
  const claim = (overrides: Partial<Parameters<typeof issueVideoRemoteConsentClaim>[0]> = {}) => issueVideoRemoteConsentClaim({
    v: 1,
    identity_token_hash: installationAccessTokenHash('installation-token'),
    project_id: 'project_consent_0001',
    source_ids: ['src_consent_0001'],
    purpose: 'asr',
    consent_revision_id: 'consent_claim_0001',
    consent_scope_hash: hash,
    region: 'cn-beijing',
    issued_at: issuedAt,
    expires_at: issuedAt + 60_000,
    ...overrides,
  }, remoteConsentSigningKey)

  const valid = claim()
  const forged = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`
  const forgedResponse = await handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST', headers: headers('consent-forged-claim-0001'), body: JSON.stringify(lease(forged)),
  }))
  expect(forgedResponse.status).toBe(403)
  expect(await forgedResponse.json()).toMatchObject({ error: 'remote_consent_claim_invalid' })

  const expiredResponse = await handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST', headers: headers('consent-expired-claim-001'),
    body: JSON.stringify(lease(claim({ issued_at: issuedAt - 60_001, expires_at: issuedAt - 1 }))),
  }))
  expect(expiredResponse.status).toBe(403)
  expect(await expiredResponse.json()).toMatchObject({ error: 'remote_consent_claim_invalid' })

  const crossBearerResponse = await handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST',
    headers: { ...headers('consent-cross-bearer-001'), Authorization: 'Bearer another-installation-token' },
    body: JSON.stringify(lease(valid)),
  }))
  expect(crossBearerResponse.status).toBe(403)
  expect(await crossBearerResponse.json()).toMatchObject({ error: 'remote_consent_claim_identity_mismatch' })

  const widenedResponse = await handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST', headers: headers('consent-widen-purpose-001'),
    body: JSON.stringify({ ...lease(claim({ purpose: 'visual_evidence' })), local_operation_id: 'task_consent_claim_0002' }),
  }))
  expect(widenedResponse.status).toBe(422)
  expect(await widenedResponse.json()).toMatchObject({ error: 'remote_consent_claim_purpose_mismatch' })

  const unavailableVerifier = createVideoMediaRelayFetchImpl({
    env: { ...baseEnv, VIDEO_MEDIA_REMOTE_CONSENT_SIGNING_KEY: undefined }, fetchImpl: identityFetch, now,
  })
  const unavailableResponse = await unavailableVerifier(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST', headers: headers('consent-verifier-missing'), body: JSON.stringify(lease(valid)),
  }))
  expect(unavailableResponse.status).toBe(503)
  expect(await unavailableResponse.json()).toMatchObject({ error: 'remote_consent_verifier_unavailable' })
})

test('Video Media Relay creates both concurrency and RPM gates through the replaceable backend', async () => {
  const concurrency: Array<{ maxActive: number; maxQueued: number; scope: VideoMediaAdmissionScope }> = []
  const rates: Array<{ rpm: number; maxQueued: number; scope: VideoMediaAdmissionScope }> = []
  let fenceChecks = 0
  let providerCalls = 0
  const backend: VideoMediaAdmissionBackend = {
    createGate(config, scope) {
      concurrency.push({ maxActive: config.maxActive, maxQueued: config.maxQueued, scope })
      return { async acquire() { return { async assertCurrent() { fenceChecks += 1 }, release() {} } } }
    },
    createRateGate(rpm, maxQueued, scope) {
      rates.push({ rpm, maxQueued, scope })
      return { async acquire() {} }
    },
  }
  const handler = createVideoMediaRelayFetch({
    env: {
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      VIDEO_MEDIA_RELAY_DB: ':memory:',
    },
    admissionBackend: backend,
    fetchImpl: identityFetch,
    provider: { async execute(input) {
      providerCalls += 1
      return {
        state: 'submitted',
        provider_task_id: 'provider_task_capacity_backend',
        receipt: {
          id: 'receipt_capacity_backend', capability: input.capability, model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1,
          prompt_version: 'v1', input_basis_hash: input.request_hash, usage: { requests: 1, total_tokens: 2, input_bytes: 4, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString(),
        },
      }
    } },
    now,
  })
  // Shared account + four workload lanes + Gateway introspection.
  expect(concurrency).toHaveLength(6)
  expect(concurrency.map(({ scope }) => scope)).toEqual([
    { kind: 'provider-account', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1' },
    { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'visual', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:visual' },
    { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'reasoning', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:reasoning' },
    { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'asr', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:asr' },
    { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'embedding', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:embedding' },
    { kind: 'gateway-identity', scope_key: 'video-media-gateway-identity' },
  ])
  // Shared physical account + four workload RPM lanes.
  expect(rates).toEqual([
    { rpm: 120, maxQueued: 32, scope: { kind: 'provider-account', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1' } },
    { rpm: 60, maxQueued: 32, scope: { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'visual', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:visual' } },
    { rpm: 60, maxQueued: 32, scope: { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'reasoning', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:reasoning' } },
    { rpm: 30, maxQueued: 32, scope: { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'asr', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:asr' } },
    { rpm: 240, maxQueued: 32, scope: { kind: 'provider-lane', account_key: 'video-dashscope-account:local-dashscope-account:local-v1', lane: 'embedding', scope_key: 'video-dashscope-account:local-dashscope-account:local-v1:lane:embedding' } },
  ])
  const operation = await handler(new Request('http://relay/v1/video-media/operations', {
    method: 'POST',
    headers: headers('capacity-backend-operation-key'),
    body: JSON.stringify({
      local_operation_id: 'task_capacity_backend', consent_revision_id: 'consent_capacity_backend', consent_scope_hash: hash,
      local_budget_reservation_id: 'budget_capacity_backend', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index',
      input: { embedding_role: 'document', items: [{ id: 'fact_capacity_backend', text: 'capacity fence' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' },
    }),
  }))
  expect(operation.status).toBe(202)
  expect(providerCalls).toBe(1)
  // One authority permit plus the workload lane and the physical account.
  expect(fenceChecks).toBeGreaterThanOrEqual(3)
})

test('Video Media Relay enforces introspected identity, lease verification, idempotency and ACK', async () => {
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  const results = new Map<string, Uint8Array>()
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: { 'Content-Type': input.contentType } } },
    async head(leaseId) { return uploaded.get(leaseId) ?? null }, async delete(leaseId) { uploaded.delete(leaseId) },
    async createReadUrl(input) { return `https://oss.example.test/read/${input.leaseId}` },
    async putResult(input) { results.set(input.objectRef, input.body) },
    async createResultReadUrl(input) { return `https://result.example.test/${input.objectRef}` },
    async deleteResult(ref) { results.delete(ref) },
  }
  const receipt: ProviderExecutionReceipt = { id: 'receipt_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 2, input_bytes: 4, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute() { return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [] } } } }
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async (input, init) => String(input).startsWith('https://result.example.test/') ? new Response(results.get(String(input).split('/').at(-1)!)!) : await identityFetch(input, init), objectStore, provider, now })
  const create = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('lease-idempotency-key-0001'), body: JSON.stringify({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  expect(create.status).toBe(201)
  const lease = await create.json() as { lease_id: string }
  const resumed = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('lease-idempotency-key-0001'), body: JSON.stringify({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  expect(await resumed.json()).toMatchObject({ lease_id: lease.lease_id, state: 'awaiting_upload', put_url: expect.any(String) })
  const complete = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('complete-idempotency-key-001'), body: '{}' }))
  expect(complete.status).toBe(200)
  const ready = await complete.json() as { object_ref: string }
  const operation = { local_operation_id: 'task_87654321', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'document', items: [{ id: 'fact_12345678', text: '一杆进球' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }
  const mismatched = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-consent-mismatch-1'), body: JSON.stringify({ ...operation, capability: 'visual_evidence', application_role: 'shot_evidence', consent_scope_hash: `sha256:${'b'.repeat(64)}`, input: { object_refs: [ready.object_ref], evidence_window_id: 'window_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } }) }))
  expect(mismatched.status).toBe(422)
  expect(await mismatched.json()).toMatchObject({ error: 'object_consent_scope_mismatch' })
  const first = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-idempotency-key-1'), body: JSON.stringify(operation) }))
  expect(first.status).toBe(202)
  const projection = await first.json() as { id: string; state: string }
  expect(projection.state).toBe('succeeded')
  const replay = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-idempotency-key-1'), body: JSON.stringify(operation) }))
  expect(replay.status).toBe(200)
  expect((await replay.json() as { id: string }).id).toBe(projection.id)
  const read = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}`, { headers: { Authorization: 'Bearer installation-token' } }))
  const resultProjection = await read.json() as { result_objects: Array<{ get_url: string; content_hash: string }> }
  expect(resultProjection.result_objects).toHaveLength(1)
  const forgedReceipt = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/ack`, { method: 'POST', headers: headers('ack-forged-receipt-key-01'), body: JSON.stringify({ result_hashes: [resultProjection.result_objects[0]!.content_hash], receipt_id: 'receipt_forged_12345678' }) }))
  expect(forgedReceipt.status).toBe(422)
  expect(await forgedReceipt.json()).toMatchObject({ error: 'receipt_mismatch' })
  const conflict = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-idempotency-key-1'), body: JSON.stringify({ ...operation, local_operation_id: 'task_00000000' }) }))
  expect(conflict.status).toBe(409)
  const ack = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/ack`, { method: 'POST', headers: headers('ack-idempotency-key-0000001'), body: JSON.stringify({ result_hashes: [resultProjection.result_objects[0]!.content_hash], receipt_id: receipt.id }) }))
  expect(ack.status).toBe(204)
  expect(results.size).toBe(0)
  expect(ready.object_ref).toMatch(/^object_/)
})

test('Relay 不会把规划 envelope 发布为 caption_translation 结果对象', async () => {
  let providerCalls = 0
  const receipt: ProviderExecutionReceipt = {
    id: 'receipt_caption_contract_0001',
    capability: 'media_reasoning',
    model_snapshot: 'qwen3.6-flash',
    region: 'cn-beijing',
    request_schema_version: 1,
    prompt_version: 'caption-translation-v1',
    input_basis_hash: hash,
    usage: { requests: 1, total_tokens: 8, input_bytes: 120, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 80 },
    cache_hit: false,
    created_at: now().toISOString(),
  }
  const provider: VideoMediaProvider = {
    async execute() {
      providerCalls += 1
      return { state: 'succeeded', receipt, result: { kind: 'planning', plan: { scenes: [] } } }
    },
  }
  const handler = createVideoMediaRelayFetch({
    env: {
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      VIDEO_MEDIA_RELAY_DB: ':memory:',
    },
    fetchImpl: identityFetch,
    provider,
    now,
  })
  const request = {
    local_operation_id: 'task_caption_contract_0001',
    consent_revision_id: 'consent_caption_contract_0001',
    consent_scope_hash: hash,
    local_budget_reservation_id: 'budget_caption_contract_0001',
    request_hash: hash,
    capability: 'media_reasoning',
    application_role: 'caption_translation',
    input: {
      object_refs: [],
      facts_basis_hash: hash,
      evidence: [{
        id: 'caption_cue_contract_0001',
        kind: 'transcript',
        text: '第一句字幕',
        source_range_id: 'segment_caption_contract_0001',
        confidence: 0.95,
      }],
      language: 'en',
      output_schema_version: 1,
    },
  }
  const rejected = await handler(new Request('http://relay/v1/video-media/operations', {
    method: 'POST',
    headers: headers('caption-translation-contract-key-0001'),
    body: JSON.stringify(request),
  }))
  expect(rejected.status).toBe(502)
  expect(await rejected.json()).toMatchObject({ error: 'caption_translation_result_invalid' })
  expect(providerCalls).toBe(1)
  const lookup = await handler(new Request(`http://relay${videoMediaOperationByLocalOperationPath(request.local_operation_id)}`, {
    headers: { Authorization: 'Bearer installation-token' },
  }))
  expect(lookup.status).toBe(200)
  expect(await lookup.json()).toMatchObject({
    state: 'failed',
    safe_error_code: 'caption_translation_result_invalid',
    provider_receipt: { id: receipt.id },
  })
})

test('Video Media Relay fails closed when Gateway introspection is unavailable', async () => {
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async () => { throw new Error('offline') }, now })
  const response = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('identity-idempotency-key-001'), body: JSON.stringify({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: 'identity_unavailable' })
})

test('Relay deduplicates same-token identity checks and bounds distinct-token Gateway work', async () => {
  let calls = 0
  const releases: Array<() => void> = []
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_IDENTITY_MAX_ACTIVE: '1', VIDEO_MEDIA_IDENTITY_QUEUE_MAX: '2', VIDEO_MEDIA_IDENTITY_MAX_WAIT_MS: '1000',
  }, fetchImpl: async () => {
    calls += 1
    await new Promise<void>(resolve => releases.push(resolve))
    return await identityFetch()
  }, now })
  const lookup = (bearer: string) => handler(new Request('http://relay/v1/video-media/operations/by-local-operation/task_identity_123', { headers: { Authorization: `Bearer ${bearer}` } }))
  const first = lookup('shared-installation-token')
  const sameToken = lookup('shared-installation-token')
  const otherToken = lookup('different-installation-token')
  while (calls !== 1) await Promise.resolve()
  expect(calls).toBe(1)
  releases.shift()!()
  while (calls !== 2) await Promise.resolve()
  releases.shift()!()
  expect((await first).status).toBe(404)
  expect((await sameToken).status).toBe(404)
  expect((await otherToken).status).toBe(404)
})

test('Relay rejects malformed runtime object-lease quota configuration during startup', () => {
  expect(() => createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS: 'not-an-integer',
  }, now })).toThrow('VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS must be an integer')
  expect(() => createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_LEASE_MAX_RETENTION_MS: 'not-an-integer',
  }, now })).toThrow('VIDEO_MEDIA_LEASE_MAX_RETENTION_MS must be an integer')
  expect(() => createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_LEASE_TTL_MS: '120000',
    VIDEO_MEDIA_LEASE_MAX_RETENTION_MS: '60000',
  }, now })).toThrow('VIDEO_MEDIA_LEASE_MAX_RETENTION_MS must be at least VIDEO_MEDIA_LEASE_TTL_MS')
})

test('Video Media Relay deployment validation requires an explicit bounded lease retention policy', () => {
  expect(() => validateVideoMediaRelayEnvironment(deploymentEnvironment())).not.toThrow()
  const missing = deploymentEnvironment()
  delete missing.VIDEO_MEDIA_LEASE_MAX_RETENTION_MS
  expect(() => validateVideoMediaRelayEnvironment(missing))
    .toThrow('VIDEO_MEDIA_LEASE_MAX_RETENTION_MS is required')
  expect(() => validateVideoMediaRelayEnvironment({
    ...deploymentEnvironment(),
    VIDEO_MEDIA_LEASE_TTL_MS: '120000',
    VIDEO_MEDIA_LEASE_MAX_RETENTION_MS: '60000',
  })).toThrow('VIDEO_MEDIA_LEASE_MAX_RETENTION_MS must be at least VIDEO_MEDIA_LEASE_TTL_MS')
})

test('Video Media Relay rejects a missing bearer token before attempting Gateway introspection', async () => {
  let introspectionCalls = 0
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async () => { introspectionCalls += 1; return Response.json({ active: true }) }, now })
  const response = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ error: 'missing_installation_access_token' })
  expect(introspectionCalls).toBe(0)
})

test('Relay rejects an oversized UTF-8 control stream without trusting Content-Length', async () => {
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: identityFetch, now })
  const bytes = new TextEncoder().encode('球'.repeat(800_000))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes.subarray(0, 1_048_576)); controller.enqueue(bytes.subarray(1_048_576)); controller.close() },
  })
  const response = await handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST',
    headers: { Authorization: 'Bearer installation-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'oversized-control-stream-key', 'X-Request-Timestamp': new Date().toISOString() },
    body: stream,
  }))
  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({ error: 'control_body_too_large' })
})

test('Relay bounds a stalled control body, propagates client aborts, and treats invalid UTF-8 as a 400', async () => {
  const handler = createVideoMediaRelayFetchImpl({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_CONTROL_BODY_TIMEOUT_MS: '1000',
  }, fetchImpl: identityFetch, now })
  const stalled = new ReadableStream<Uint8Array>({ start() { /* never produces a body chunk */ } })
  const timedOut = await handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST', headers: headers('stalled-control-stream-key'), body: stalled,
  }))
  expect(timedOut.status).toBe(408)
  expect(await timedOut.json()).toMatchObject({ error: 'control_body_timeout' })

  const aborter = new AbortController()
  let beganReading!: () => void
  const reading = new Promise<void>(resolve => { beganReading = resolve })
  let cancellationCalls = 0
  const pendingBody = new ReadableStream<Uint8Array>({
    pull() { beganReading(); return new Promise(() => {}) },
    cancel() { cancellationCalls += 1 },
  })
  const abortedRequest = handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST', headers: headers('aborted-control-stream-key'), body: pendingBody, signal: aborter.signal,
  }))
  await reading
  aborter.abort(new DOMException('client closed', 'AbortError'))
  const aborted = await abortedRequest
  expect(aborted.status).toBe(499)
  expect(await aborted.json()).toMatchObject({ error: 'request_aborted' })
  expect(cancellationCalls).toBe(1)

  const invalidUtf8 = await handler(new Request('http://relay/v1/video-media/object-leases', {
    method: 'POST', headers: headers('invalid-utf8-control-key'), body: new Uint8Array([0xff]),
  }))
  expect(invalidUtf8.status).toBe(400)
  expect(await invalidUtf8.json()).toMatchObject({ error: 'invalid_json' })
})

test('Relay keeps the standard introspection audience and rejects malformed Gateway bodies as 502', async () => {
  let receivedHeaders: Headers | undefined
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async (_input, init) => {
    receivedHeaders = new Headers(init?.headers)
    return new Response('x'.repeat(16 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })
  }, now })
  const response = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('identity-oversized-body-key'), body: '{}' }))
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ error: 'identity_response_invalid' })
  expect(receivedHeaders?.get('x-bb-introspection-audience')).toBe('video-media-relay')
  expect(receivedHeaders?.get('x-bb-introspection-service-token')).toBe(token)
  expect(receivedHeaders?.get('authorization')).toBe('Bearer installation-token')
  const malformed = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async () => Response.json({ active: true }), now })
  const malformedResponse = await malformed(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('identity-malformed-body-key'), body: '{}' }))
  expect(malformedResponse.status).toBe(502)
  expect(await malformedResponse.json()).toMatchObject({ error: 'identity_response_invalid' })
})

test('Relay applies the shared account and embedding-lane admission fence at the provider boundary', async () => {
  let started = 0
  let release!: () => void
  const unblock = new Promise<void>(resolve => { release = resolve })
  const receipt: ProviderExecutionReceipt = { id: 'receipt_capacity_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute() { started += 1; await unblock; return { state: 'submitted', provider_task_id: `task_${started}`, receipt } } }
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX: '2', VIDEO_MEDIA_DASHSCOPE_OWNER_QUEUE_MAX: '1', VIDEO_MEDIA_DASHSCOPE_MAX_WAIT_MS: '30000',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_RPM: '1000',
    VIDEO_MEDIA_DASHSCOPE_VISUAL_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_REASONING_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ASR_MAX_ACTIVE: '1',
    VIDEO_MEDIA_DASHSCOPE_EMBEDDING_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_EMBEDDING_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_EMBEDDING_RPM: '1000',
  }, fetchImpl: identityFetch, provider, now })
  const operation = (suffix: string) => ({ local_operation_id: `task_capacity_${suffix}`, consent_revision_id: 'consent_capacity_12345678', consent_scope_hash: hash, local_budget_reservation_id: `budget_capacity_${suffix}`, request_hash: hash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: `fact_capacity_${suffix}`, text: '容量守门' }], model: 'text-embedding-v4' as const, dimension: 768 as const, instruction_version: 'v1' } })
  const first = handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('capacity-first-operation-key'), body: JSON.stringify(operation('first_12345678')) }))
  while (started !== 1) await Promise.resolve()
  const second = handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('capacity-second-operation-key'), body: JSON.stringify(operation('second_12345678')) }))
  await Promise.resolve()
  expect(started).toBe(1)
  release()
  expect((await first).status).toBe(202)
  expect((await second).status).toBe(202)
  expect(started).toBe(2)
})

test('Concurrent first POST retries share one durable submission fence and execute the Provider once', async () => {
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  let enteredReads = 0
  let bothReads!: () => void
  const bothReading = new Promise<void>(resolve => { bothReads = resolve })
  let releaseReads!: () => void
  const holdReads = new Promise<void>(resolve => { releaseReads = resolve })
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: {} } },
    async head(id) { return uploaded.get(id) ?? null }, async delete() {},
    async createReadUrl() { enteredReads += 1; if (enteredReads === 2) bothReads(); await holdReads; return 'https://oss.example.test/read' },
    async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const receipt: ProviderExecutionReceipt = { id: 'receipt_submission_fence_12345678', capability: 'visual_evidence', model_snapshot: 'qwen3-vl-flash', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 1, input_bytes: 4, visual_frames: 1, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  let executions = 0
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: identityFetch, objectStore, provider: { async execute() { executions += 1; return { state: 'succeeded', receipt, result: { kind: 'visual', evidence: { summary: 'one execution' } } } } }, now })
  const leasePayload = { local_operation_id: 'task_submission_fence_12345678', purpose: 'visual_frames', content_hash: hash, byte_size: 4, content_type: 'image/png', consent_revision_id: 'consent_submission_fence_12345678', consent_scope_hash: hash }
  const lease = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('submission-fence-lease-key'), body: JSON.stringify(leasePayload) })).then(response => response.json()) as { lease_id: string }
  const ready = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('submission-fence-complete-key'), body: '{}' })).then(response => response.json()) as { object_ref: string }
  const operation = { local_operation_id: 'task_submission_fence_12345678', consent_revision_id: leasePayload.consent_revision_id, consent_scope_hash: hash, local_budget_reservation_id: 'budget_submission_fence_12345678', request_hash: hash, capability: 'visual_evidence' as const, application_role: 'shot_evidence' as const, input: { object_refs: [ready.object_ref], evidence_window_id: 'window_submission_fence_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } }
  const first = handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('submission-fence-operation-key'), body: JSON.stringify(operation) }))
  while (enteredReads !== 1) await Promise.resolve()
  const second = handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('submission-fence-operation-key'), body: JSON.stringify(operation) }))
  await bothReading
  releaseReads()
  expect((await first).status).toBe(202)
  expect((await second).status).toBe(202)
  expect(executions).toBe(1)
})

test('Relay keeps settled usage in owner and shared-account UTC daily ledgers', async () => {
  let current = now()
  const receipt: ProviderExecutionReceipt = { id: 'receipt_daily_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: current.toISOString() }
  const provider: VideoMediaProvider = { async execute() { return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [] } } } }
  const identityByBearer = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get('authorization') ?? ''
    const installation = bearer.endsWith('owner-b') ? 'install_b_12345678' : bearer.endsWith('owner-c') ? 'install_c_12345678' : 'install_a_12345678'
    return Response.json({ active: true, principal_id: 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', installation_id: installation, session_id: 'abcdefghijklmnopqrstuvwx', expires_at: Date.now() + 60_000, owner: `installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${installation}` })
  }
  const objectStore: MediaObjectStore = { async createPutUrl() { throw new Error('not_needed') }, async head() { return null }, async delete() {}, async createReadUrl() { throw new Error('not_needed') }, async putResult() {}, async createResultReadUrl() { return 'https://result.example.test/daily' }, async deleteResult() {} }
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:', VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '2' }, fetchImpl: identityByBearer, objectStore, provider, now: () => current })
  const operation = (suffix: string) => ({ local_operation_id: `task_daily_${suffix}`, consent_revision_id: 'consent_daily_12345678', consent_scope_hash: hash, local_budget_reservation_id: `budget_daily_${suffix}`, request_hash: hash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: `fact_daily_${suffix}`, text: '按日额度' }], model: 'text-embedding-v4' as const, dimension: 768 as const, instruction_version: 'v1' } })
  const post = (owner: string, suffix: string) => handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: { ...headers(`daily-${owner}-${suffix}-idempotency-key`), Authorization: `Bearer ${owner}` }, body: JSON.stringify(operation(suffix)) }))
  expect((await post('owner-a', 'first_12345678')).status).toBe(202)
  const ownerLimited = await post('owner-a', 'again_12345678')
  expect(ownerLimited.status).toBe(429)
  expect(await ownerLimited.json()).toMatchObject({
    error: 'owner_daily_quota_exceeded',
    capability: 'video',
    scope: 'owner',
    resets_at: '2026-08-04T00:00:00.000Z',
  })
  expect((await post('owner-b', 'first_12345678')).status).toBe(202)
  const accountLimited = await post('owner-c', 'first_12345678')
  expect(accountLimited.status).toBe(429)
  expect(await accountLimited.json()).toMatchObject({
    error: 'account_daily_quota_exceeded',
    capability: 'video',
    scope: 'platform',
    resets_at: '2026-08-04T00:00:00.000Z',
  })
  current = new Date(current.getTime() + 24 * 60 * 60_000)
  expect((await post('owner-c', 'next_day_12345678')).status).toBe(202)
})

test('Relay treats zero daily quota as an intentional owner or platform stop before OSS or Provider work', async () => {
  let providerCalls = 0
  let signedLeaseUrls = 0
  const receipt: ProviderExecutionReceipt = { id: 'receipt_zero_quota_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute() { providerCalls += 1; return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [] } } } }
  const objectStore: MediaObjectStore = {
    async createPutUrl() { signedLeaseUrls += 1; return { put_url: 'https://oss.example.test/zero-quota', required_headers: {} } },
    async head() { return null }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read/zero-quota' },
    async putResult() {}, async createResultReadUrl() { return 'https://result.example.test/zero-quota' }, async deleteResult() {},
  }
  const operation = (suffix: string) => ({ local_operation_id: `task_zero_quota_${suffix}`, consent_revision_id: 'consent_zero_quota_12345678', consent_scope_hash: hash, local_budget_reservation_id: `budget_zero_quota_${suffix}`, request_hash: hash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: `fact_zero_quota_${suffix}`, text: '停用视频额度' }], model: 'text-embedding-v4' as const, dimension: 768 as const, instruction_version: 'v1' } })
  const lease = (suffix: string) => ({ local_operation_id: `task_zero_quota_lease_${suffix}`, purpose: 'audio_for_asr' as const, content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_zero_quota_12345678', consent_scope_hash: hash })
  const createHandler = (limits: Record<string, string>) => createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: ':memory:',
    ...limits,
  }, fetchImpl: identityFetch, objectStore, provider, now })

  for (const value of ['00', '-0', '0e0']) {
    expect(() => createHandler({ VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: value, VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1' }))
      .toThrow('VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS')
    expect(() => createHandler({ VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '0', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: value }))
      .toThrow('VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS')
  }

  const ownerHandler = createHandler({ VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '0', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1' })
  const ownerPaused = await ownerHandler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('zero-owner-daily-quota-key'), body: JSON.stringify(operation('owner_12345678')) }))
  expect(ownerPaused.status).toBe(429)
  expect(await ownerPaused.json()).toMatchObject({ error: 'owner_daily_quota_exceeded', capability: 'video', scope: 'owner' })
  const ownerLease = await ownerHandler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('zero-owner-daily-quota-lease-key'), body: JSON.stringify(lease('owner_12345678')) }))
  expect(ownerLease.status).toBe(429)
  expect(await ownerLease.json()).toMatchObject({ error: 'owner_daily_quota_exceeded', capability: 'video', scope: 'owner' })

  const platformHandler = createHandler({ VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '0', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '0' })
  const platformPaused = await platformHandler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('zero-account-daily-quota-key'), body: JSON.stringify(operation('account_12345678')) }))
  expect(platformPaused.status).toBe(429)
  expect(await platformPaused.json()).toMatchObject({ error: 'account_daily_quota_exceeded', capability: 'video', scope: 'platform' })
  const platformLease = await platformHandler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('zero-account-daily-quota-lease-key'), body: JSON.stringify(lease('account_12345678')) }))
  expect(platformLease.status).toBe(429)
  expect(await platformLease.json()).toMatchObject({ error: 'account_daily_quota_exceeded', capability: 'video', scope: 'platform' })
  expect(signedLeaseUrls).toBe(0)
  expect(providerCalls).toBe(0)
})

test('Relay only marks a submitted operation cancelled after explicit Provider proof and keeps its settled charge', async () => {
  const receipt: ProviderExecutionReceipt = { id: 'receipt_cancel_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  let cancellationCalls = 0
  const provider: VideoMediaProvider = {
    async execute() { return { state: 'submitted', provider_task_id: 'remote-cancel-123', receipt } },
    async cancel() { cancellationCalls += 1; return { cancelled: true, receipt } },
  }
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1',
  }, fetchImpl: identityFetch, provider, now })
  const operation = (suffix: string) => ({ local_operation_id: `task_cancel_${suffix}`, consent_revision_id: 'consent_cancel_12345678', consent_scope_hash: hash, local_budget_reservation_id: `budget_cancel_${suffix}`, request_hash: hash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: `fact_cancel_${suffix}`, text: '明确取消证明' }], model: 'text-embedding-v4' as const, dimension: 768 as const, instruction_version: 'v1' } })
  const created = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('cancel-operation-create-key'), body: JSON.stringify(operation('first_12345678')) }))
  const projection = await created.json() as { id: string; state: string }
  expect(projection.state).toBe('submitted')
  const cancelled = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/cancel`, { method: 'POST', headers: headers('cancel-operation-proof-key'), body: '{}' }))
  expect(cancelled.status).toBe(200)
  expect(await cancelled.json()).toMatchObject({ state: 'cancelled' })
  expect(cancellationCalls).toBe(1)
  const replay = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/cancel`, { method: 'POST', headers: headers('cancel-operation-proof-key'), body: '{}' }))
  expect(replay.status).toBe(200)
  expect(cancellationCalls).toBe(1)
  const repeat = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/cancel`, { method: 'POST', headers: headers('cancel-operation-new-key-01'), body: '{}' }))
  expect(repeat.status).toBe(409)
  const blocked = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('cancel-operation-daily-quota-key'), body: JSON.stringify(operation('second_12345678')) }))
  expect(blocked.status).toBe(429)

  let unprovenPolls = 0
  const unproven = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: identityFetch, provider: { async execute() { return { state: 'submitted', provider_task_id: 'remote-unproven-123', receipt } }, async cancel() { return undefined }, async poll() { unprovenPolls += 1; return { state: 'running', provider_task_id: 'remote-unproven-123', receipt } } }, now })
  const unprovenCreated = await unproven(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('unproven-cancel-create-key'), body: JSON.stringify(operation('unproven_12345678')) }))
  const unprovenProjection = await unprovenCreated.json() as { id: string }
  const denied = await unproven(new Request(`http://relay/v1/video-media/operations/${unprovenProjection.id}/cancel`, { method: 'POST', headers: headers('unproven-cancel-attempt-key'), body: '{}' }))
  expect(denied.status).toBe(409)
  expect(await denied.json()).toMatchObject({ error: 'operation_cancel_unconfirmed' })
  const stillPolling = await unproven(new Request(`http://relay/v1/video-media/operations/${unprovenProjection.id}`, { headers: { Authorization: 'Bearer installation-token' } }))
  expect(await stillPolling.json()).toMatchObject({ state: 'running' })
  expect(unprovenPolls).toBe(2)
})

test('Relay reserves object-lease capacity before signing and rejects purpose, MIME and expired capabilities', async () => {
  let signed = 0
  let current = now()
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { signed += 1; return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: { 'content-type': input.contentType } } },
    async head() { return null }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const env = { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:', VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS: '1', VIDEO_MEDIA_LEASE_TTL_MS: '60000' }
  const handler = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, now: () => current })
  const valid = { local_operation_id: 'task_lease_policy_0001', purpose: 'visual_frames', content_hash: hash, byte_size: 4, content_type: 'image/png', consent_revision_id: 'consent_lease_policy_01', consent_scope_hash: hash }
  const invalid = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('lease-policy-invalid-key'), body: JSON.stringify({ ...valid, local_operation_id: 'task_lease_policy_0002', purpose: 'audio_for_asr', content_type: 'image/png' }) }))
  expect(invalid.status).toBe(422)
  expect(await invalid.json()).toMatchObject({ error: 'lease_purpose_mime_mismatch' })
  expect(signed).toBe(0)
  const first = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('lease-policy-first-key'), body: JSON.stringify(valid) }))
  const lease = await first.json() as { lease_id: string }
  expect(first.status).toBe(201)
  expect(signed).toBe(1)
  const exhausted = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('lease-policy-exhausted-key'), body: JSON.stringify({ ...valid, local_operation_id: 'task_lease_policy_0003' }) }))
  expect(exhausted.status).toBe(429)
  expect(await exhausted.json()).toMatchObject({ error: 'object_lease_quota_exceeded' })
  current = new Date(current.getTime() + 60_001)
  const expired = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('lease-policy-expired-key'), body: '{}' }))
  expect(expired.status).toBe(410)
  const reclaimed = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('lease-policy-reclaimed-key'), body: JSON.stringify({ ...valid, local_operation_id: 'task_lease_policy_0004' }) }))
  expect(reclaimed.status).toBe(201)
  expect(signed).toBe(2)
})

test('Relay persists an absolute lease retention deadline across renew, replay, ready and bound states', async () => {
  const dbPath = join(tmpdir(), `video-relay-lease-retention-${crypto.randomUUID()}.sqlite`)
  let current = now()
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: {} } },
    async head(id) { return uploaded.get(id) ?? null }, async delete(id) { uploaded.delete(id) }, async createReadUrl() { return 'https://oss.example.test/read' },
    async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: dbPath,
    VIDEO_MEDIA_LEASE_TTL_MS: '60000',
    VIDEO_MEDIA_LEASE_MAX_RETENTION_MS: '180000',
  }, fetchImpl: identityFetch, objectStore, now: () => current })
  const payload = { local_operation_id: 'task_retention_12345678', purpose: 'audio_for_asr' as const, content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_retention_12345678', consent_scope_hash: hash }
  try {
    const created = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('retention-create-key-0001'), body: JSON.stringify(payload) }))
    expect(created.status).toBe(201)
    const lease = await created.json() as { lease_id: string; expires_at: string }
    const db = new Database(dbPath)
    expect(db.query('SELECT expires_at,initial_expires_at,max_expires_at FROM video_media_leases_v1 WHERE id=?').get(lease.lease_id)).toEqual({
      expires_at: '2026-08-03T00:01:00.000Z',
      initial_expires_at: '2026-08-03T00:01:00.000Z',
      max_expires_at: '2026-08-03T00:03:00.000Z',
    })
    db.close()

    current = new Date('2026-08-03T00:00:30.000Z')
    const firstRenewal = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/renew`, { method: 'POST', headers: headers('retention-renew-awaiting-key'), body: '{}' }))
    expect(await firstRenewal.json()).toMatchObject({ state: 'awaiting_upload', expires_at: '2026-08-03T00:01:30.000Z' })
    const replay = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/renew`, { method: 'POST', headers: headers('retention-renew-awaiting-key'), body: '{}' }))
    expect(await replay.json()).toMatchObject({ state: 'awaiting_upload', expires_at: '2026-08-03T00:01:30.000Z' })

    const completed = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('retention-complete-key-001'), body: '{}' }))
    expect(await completed.json()).toMatchObject({ state: 'ready', object_ref: expect.any(String) })

    current = new Date('2026-08-03T00:01:00.000Z')
    const readyRenewal = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/renew`, { method: 'POST', headers: headers('retention-renew-ready-key-01'), body: '{}' }))
    expect(await readyRenewal.json()).toMatchObject({ state: 'ready', expires_at: '2026-08-03T00:02:00.000Z' })

    const boundDb = new Database(dbPath)
    boundDb.query("UPDATE video_media_leases_v1 SET state='bound' WHERE id=?").run(lease.lease_id)
    boundDb.close()
    current = new Date('2026-08-03T00:01:30.000Z')
    const boundRenewal = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/renew`, { method: 'POST', headers: headers('retention-renew-bound-key-01'), body: '{}' }))
    expect(await boundRenewal.json()).toMatchObject({ state: 'bound', expires_at: '2026-08-03T00:02:30.000Z' })

    current = new Date('2026-08-03T00:02:00.000Z')
    const renewalAtHardLimit = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/renew`, { method: 'POST', headers: headers('retention-renew-hard-limit'), body: '{}' }))
    expect(await renewalAtHardLimit.json()).toMatchObject({ state: 'bound', expires_at: '2026-08-03T00:03:00.000Z' })
    current = new Date('2026-08-03T00:02:01.000Z')
    const exceedsMaximum = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/renew`, { method: 'POST', headers: headers('retention-renew-over-limit'), body: '{}' }))
    expect(exceedsMaximum.status).toBe(409)
    expect(await exceedsMaximum.json()).toMatchObject({ error: 'lease_retention_limit_reached' })

    current = new Date('2026-08-03T00:03:01.000Z')
    const expiredReplay = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/renew`, { method: 'POST', headers: headers('retention-renew-hard-limit'), body: '{}' }))
    expect(expiredReplay.status).toBe(410)
    expect((await expiredReplay.json() as { error: string }).error).toMatch(/^lease_(expired|deleted)$/)
    const expiredDb = new Database(dbPath)
    const expiredRow = expiredDb.query('SELECT state,max_expires_at FROM video_media_leases_v1 WHERE id=?').get(lease.lease_id) as { state: string; max_expires_at: string }
    expect(expiredRow.max_expires_at).toBe('2026-08-03T00:03:00.000Z')
    expect(['expired', 'deleted']).toContain(expiredRow.state)
    expiredDb.close()
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay fails closed planning object refs and validates purpose, MIME and operation binding before quota or Provider work', async () => {
  const dbPath = join(tmpdir(), `video-relay-object-admission-${crypto.randomUUID()}.sqlite`)
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  let providerCalls = 0
  let readUrlCalls = 0
  const receipt = (capability: ProviderExecutionReceipt['capability']): ProviderExecutionReceipt => ({
    id: 'receipt_object_admission_12345678', capability, model_snapshot: 'qwen3.6-flash', region: 'cn-beijing', request_schema_version: 1,
    prompt_version: 'video-media-v1', input_basis_hash: hash,
    usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString(),
  })
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: {} } },
    async head(id) { return uploaded.get(id) ?? null }, async delete(id) { uploaded.delete(id) }, async createReadUrl() { readUrlCalls += 1; return 'https://oss.example.test/read' },
    async putResult() {}, async createResultReadUrl() { return 'https://result.example.test/object-admission' }, async deleteResult() {},
  }
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: dbPath,
  }, fetchImpl: identityFetch, objectStore, provider: {
    async execute(input) { providerCalls += 1; return { state: 'succeeded', receipt: receipt(input.capability), result: { kind: 'planning', plan: { scenes: [] } } } },
  }, now })
  const createLease = async (key: string, payload: Record<string, unknown>) => {
    const response = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers(key), body: JSON.stringify(payload) }))
    expect(response.status).toBe(201)
    const lease = await response.json() as { lease_id: string }
    const complete = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers(`${key}-complete`), body: '{}' }))
    expect(complete.status).toBe(200)
    return { lease_id: lease.lease_id, ...(await complete.json() as { object_ref: string }) }
  }
  const operationRows = () => {
    const db = new Database(dbPath)
    const rows = db.query('SELECT COUNT(*) AS total FROM video_media_operations_v1').get() as { total: number }
    const quotas = db.query('SELECT COUNT(*) AS total FROM video_media_quota_v1').get() as { total: number }
    db.close()
    return { rows: rows.total, quotas: quotas.total }
  }
  const planning = (localOperationId: string, objectRefs: string[]) => ({
    local_operation_id: localOperationId, consent_revision_id: 'consent_object_admission_12345678', consent_scope_hash: hash,
    local_budget_reservation_id: `budget_${localOperationId.slice(5)}`, request_hash: hash, capability: 'media_reasoning' as const, application_role: 'planning' as const,
    input: { object_refs: objectRefs, facts_basis_hash: hash, evidence: [], language: 'zh', output_schema_version: 1 },
  })
  const visual = (localOperationId: string, objectRef: string) => ({
    local_operation_id: localOperationId, consent_revision_id: 'consent_object_admission_12345678', consent_scope_hash: hash,
    local_budget_reservation_id: `budget_${localOperationId.slice(5)}`, request_hash: hash, capability: 'visual_evidence' as const, application_role: 'shot_evidence' as const,
    input: { object_refs: [objectRef], evidence_window_id: 'window_object_admission_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 },
  })
  try {
    const planningLease = await createLease('object-admission-planning-key', {
      local_operation_id: 'task_planning_object_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 4, content_type: 'video/mp4', consent_revision_id: 'consent_object_admission_12345678', consent_scope_hash: hash,
    })
    const rejectedPlanning = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('object-admission-planning-op'), body: JSON.stringify(planning('task_planning_object_12345678', [planningLease.object_ref])) }))
    expect(rejectedPlanning.status).toBe(422)
    expect(await rejectedPlanning.json()).toMatchObject({ error: 'planning_object_refs_unsupported' })
    expect({ providerCalls, readUrlCalls, ...operationRows() }).toEqual({ providerCalls: 0, readUrlCalls: 0, rows: 0, quotas: 0 })

    const audioLease = await createLease('object-admission-audio-key', {
      local_operation_id: 'task_visual_audio_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_object_admission_12345678', consent_scope_hash: hash,
    })
    const wrongPurpose = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('object-admission-purpose-op'), body: JSON.stringify(visual('task_visual_audio_12345678', audioLease.object_ref)) }))
    expect(wrongPurpose.status).toBe(422)
    expect(await wrongPurpose.json()).toMatchObject({ error: 'object_consent_scope_mismatch' })
    expect({ providerCalls, readUrlCalls, ...operationRows() }).toEqual({ providerCalls: 0, readUrlCalls: 0, rows: 0, quotas: 0 })

    const malformedMimeLease = await createLease('object-admission-mime-key', {
      local_operation_id: 'task_asr_mime_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_object_admission_12345678', consent_scope_hash: hash,
    })
    const tamper = new Database(dbPath)
    tamper.query("UPDATE video_media_leases_v1 SET content_type='image/png' WHERE id=?").run(malformedMimeLease.lease_id)
    tamper.close()
    const wrongMime = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('object-admission-mime-op'), body: JSON.stringify({
      local_operation_id: 'task_asr_mime_12345678', consent_revision_id: 'consent_object_admission_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_asr_mime_12345678', request_hash: hash,
      capability: 'speech_transcription', application_role: 'asr', input: { mode: 'short_sync', audio_object_ref: malformedMimeLease.object_ref, source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, hotwords: [], speaker_diarization: false, sentence_timestamps: true, word_timestamps: true },
    }) }))
    expect(wrongMime.status).toBe(422)
    expect(await wrongMime.json()).toMatchObject({ error: 'object_purpose_mismatch' })
    expect({ providerCalls, readUrlCalls, ...operationRows() }).toEqual({ providerCalls: 0, readUrlCalls: 0, rows: 0, quotas: 0 })

    const crossLease = await createLease('object-admission-cross-key', {
      local_operation_id: 'task_cross_source_12345678', purpose: 'visual_frames', content_hash: hash, byte_size: 4, content_type: 'image/png', consent_revision_id: 'consent_object_admission_12345678', consent_scope_hash: hash,
    })
    const crossReady = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('object-admission-cross-ready'), body: JSON.stringify(visual('task_cross_ready_12345678', crossLease.object_ref)) }))
    expect(crossReady.status).toBe(422)
    expect(await crossReady.json()).toMatchObject({ error: 'object_already_bound' })
    const bind = new Database(dbPath)
    bind.query("UPDATE video_media_leases_v1 SET state='bound' WHERE id=?").run(crossLease.lease_id)
    bind.close()
    const crossBound = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('object-admission-cross-bound'), body: JSON.stringify(visual('task_cross_bound_12345678', crossLease.object_ref)) }))
    expect(crossBound.status).toBe(422)
    expect(await crossBound.json()).toMatchObject({ error: 'object_already_bound' })
    expect({ providerCalls, readUrlCalls, ...operationRows() }).toEqual({ providerCalls: 0, readUrlCalls: 0, rows: 0, quotas: 0 })

    const noObjectPlanning = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('object-admission-empty-plan'), body: JSON.stringify(planning('task_planning_empty_12345678', [])) }))
    expect(noObjectPlanning.status).toBe(202)
    expect(providerCalls).toBe(1)
    expect(operationRows()).toEqual({ rows: 1, quotas: 1 })
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay persists failed OSS result cleanup and retries it on the next authenticated request', async () => {
  let deleteAttempts = 0
  let releaseRetry!: () => void
  const retryBlocked = new Promise<void>(resolve => { releaseRetry = resolve })
  const objectStore: MediaObjectStore = {
    async createPutUrl() { return { put_url: 'https://oss.example.test/put', required_headers: {} } }, async head() { return null }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl(input) { return `https://oss.example.test/result/${input.objectRef}` },
    async deleteResult() { deleteAttempts += 1; if (deleteAttempts === 1) throw new Error('temporary_oss_delete_failure'); if (deleteAttempts === 2) await retryBlocked },
  }
  const receipt: ProviderExecutionReceipt = { id: 'receipt_cleanup_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute() { return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [] } } } }
  let current = now()
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: identityFetch, objectStore, provider, now: () => current })
  const operation = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('cleanup-operation-key-0001'), body: JSON.stringify({ local_operation_id: 'task_cleanup_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'embed_cleanup_12345678', text: '清理重试' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }) }))
  const projection = await operation.json() as { id: string; provider_receipt: { id: string }; result_objects: Array<{ content_hash: `sha256:${string}` }> }
  const acknowledged = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/ack`, { method: 'POST', headers: headers('cleanup-ack-key-00000001'), body: JSON.stringify({ receipt_id: projection.provider_receipt.id, result_hashes: projection.result_objects.map(item => item.content_hash) }) }))
  expect(acknowledged.status).toBe(204)
  expect(deleteAttempts).toBe(1)
  current = new Date(current.getTime() + 2_000)
  const retryPayload = { purpose: 'visual_frames', content_hash: hash, byte_size: 1, content_type: 'image/jpeg', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }
  const retryTrigger = handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('cleanup-retry-lease-key'), body: JSON.stringify({ ...retryPayload, local_operation_id: 'task_cleanup_lease_0001' }) }))
  while (deleteAttempts !== 2) await Promise.resolve()
  const concurrentTrigger = handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('cleanup-concurrent-lease-key'), body: JSON.stringify({ ...retryPayload, local_operation_id: 'task_cleanup_lease_0002' }) }))
  await Promise.resolve()
  expect(deleteAttempts).toBe(2)
  releaseRetry()
  expect((await retryTrigger).status).toBe(201)
  expect((await concurrentTrigger).status).toBe(201)
})

test('provider-bound failures retain conservative daily account usage while ambiguous outcomes retain their lease', async () => {
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  const deleted: string[] = []
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: {} } },
    async head(id) { return uploaded.get(id) ?? null }, async delete(id) { deleted.push(id); uploaded.delete(id) }, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const leasePayload = { local_operation_id: 'task_visual_12345678', purpose: 'visual_frames', content_hash: hash, byte_size: 4, content_type: 'image/png', consent_revision_id: 'consent_visual_12345678', consent_scope_hash: hash }
  const operation = (objectRef: string, suffix: string) => ({ local_operation_id: `task_visual_${suffix}`, consent_revision_id: leasePayload.consent_revision_id, consent_scope_hash: hash, local_budget_reservation_id: `budget_visual_${suffix}`, request_hash: hash, capability: 'visual_evidence' as const, application_role: 'shot_evidence' as const, input: { object_refs: [objectRef], evidence_window_id: `window_visual_${suffix}`, facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } })
  const known = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:', VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1' }, fetchImpl: identityFetch, objectStore, provider: { async execute() { throw new DashScopeProviderError(422, 'provider_rejected') } }, now })
  const lease = await known(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('visual-known-lease-key'), body: JSON.stringify(leasePayload) })).then(response => response.json()) as { lease_id: string }
  const ready = await known(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('visual-known-complete-key'), body: '{}' })).then(response => response.json()) as { object_ref: string }
  // The object contract binds a lease to the same durable local operation;
  // this fixture is exercising a Provider-rejected call, not cross-operation
  // object theft.
  const rejected = await known(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('visual-known-operation-key'), body: JSON.stringify(operation(ready.object_ref, '12345678')) }))
  expect(rejected.status).toBe(422)
  expect(deleted).toEqual([lease.lease_id])
  const released = await known(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('visual-known-release-key'), body: JSON.stringify({ local_operation_id: 'task_embedding_known_12345678', consent_revision_id: 'consent_embedding_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_embedding_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'fact_embedding_12345678', text: 'release after known failure' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }) }))
  expect(released.status).toBe(429)

  const unknown = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:', VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS: '1' }, fetchImpl: identityFetch, objectStore, provider: { async execute() { throw new Error('lost_after_provider_submission') } }, now })
  const unknownLeasePayload = { ...leasePayload, local_operation_id: 'task_visual_unknown_12345678' }
  const unknownLease = await unknown(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('visual-unknown-lease-key'), body: JSON.stringify(unknownLeasePayload) })).then(response => response.json()) as { lease_id: string }
  const unknownReady = await unknown(new Request(`http://relay/v1/video-media/object-leases/${unknownLease.lease_id}/complete`, { method: 'POST', headers: headers('visual-unknown-complete-key'), body: '{}' })).then(response => response.json()) as { object_ref: string }
  const ambiguous = await unknown(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('visual-unknown-operation-key'), body: JSON.stringify(operation(unknownReady.object_ref, 'unknown_12345678')) }))
  expect(ambiguous.status).toBe(503)
  const retainedLease = await unknown(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('visual-unknown-retained-lease-key'), body: JSON.stringify({ ...unknownLeasePayload, local_operation_id: 'task_visual_outcome_retained' }) }))
  expect(retainedLease.status).toBe(429)
  const blocked = await unknown(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('visual-unknown-quota-key'), body: JSON.stringify({ local_operation_id: 'task_embedding_unknown_12345678', consent_revision_id: 'consent_embedding_unknown_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_embedding_unknown_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'fact_embedding_unknown_12345678', text: 'unknown must retain quota' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }) }))
  expect(blocked.status).toBe(429)
  expect(deleted).toEqual([lease.lease_id])
})

test('DashScope 成功响应缺失价格回执时保留逐操作额度，而不是按零费用结算', async () => {
  let dashScopeCalls = 0
  const handler = createVideoMediaRelayFetch({
    env: {
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
      VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      VIDEO_MEDIA_RELAY_DB: ':memory:',
      VIDEO_MEDIA_DASHSCOPE_API_KEY: 'd'.repeat(24),
      VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1',
      VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1',
    },
    fetchImpl: async (input, init) => {
      if (String(input).startsWith('http://gateway:8799')) return await identityFetch(input, init)
      if (String(input).endsWith('/embeddings')) {
        dashScopeCalls += 1
        return Response.json({
          data: [{ embedding: Array.from({ length: 768 }, () => 0.25) }],
          usage: { total_tokens: 3 },
        })
      }
      throw new Error(`unexpected URL: ${String(input)}`)
    },
    now,
  })
  const operation = {
    local_operation_id: 'task_missing_price_0001',
    consent_revision_id: 'consent_missing_price_0001',
    consent_scope_hash: hash,
    local_budget_reservation_id: 'budget_missing_price_0001',
    request_hash: hash,
    capability: 'semantic_embedding' as const,
    application_role: 'search_index' as const,
    input: {
      embedding_role: 'query' as const,
      items: [{ id: 'fact_missing_price_0001', text: '不能按零费用结算' }],
      model: 'text-embedding-v4' as const,
      dimension: 768 as const,
      instruction_version: 'v1',
    },
  }
  const first = await handler(new Request('http://relay/v1/video-media/operations', {
    method: 'POST',
    headers: headers('missing-price-operation-key-0001'),
    body: JSON.stringify(operation),
  }))
  expect(first.status).toBe(503)
  expect(await first.json()).toMatchObject({ error: 'provider_usage_amount_missing' })

  const retained = await handler(new Request(`http://relay${videoMediaOperationByLocalOperationPath(operation.local_operation_id)}`, {
    headers: { Authorization: 'Bearer installation-token' },
  }))
  expect(await retained.json()).toMatchObject({
    state: 'outcome_unknown',
    safe_error_code: 'provider_outcome_unknown',
  })

  const blocked = await handler(new Request('http://relay/v1/video-media/operations', {
    method: 'POST',
    headers: headers('missing-price-operation-key-0002'),
    body: JSON.stringify({
      ...operation,
      local_operation_id: 'task_missing_price_0002',
      local_budget_reservation_id: 'budget_missing_price_0002',
    }),
  }))
  expect(blocked.status).toBe(429)
  expect(dashScopeCalls).toBe(1)
})

test('Relay releases known pre-provider failures, cleans inputs, and replays the terminal operation without a second submission', async () => {
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  const deleted: string[] = []
  let executions = 0
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}` } },
    async head(id) { return uploaded.get(id) ?? null }, async delete(id) { deleted.push(id); uploaded.delete(id) },
    async createReadUrl() { throw new Error('oss_read_unavailable_before_provider') },
    async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS: '1',
  }, fetchImpl: identityFetch, objectStore, provider: { async execute() { executions += 1; throw new Error('must_not_execute') } }, now })
  const leasePayload = { local_operation_id: 'task_pre_provider_12345678', purpose: 'visual_frames', content_hash: hash, byte_size: 4, content_type: 'image/png', consent_revision_id: 'consent_pre_provider_12345678', consent_scope_hash: hash }
  const lease = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('pre-provider-lease-key'), body: JSON.stringify(leasePayload) })).then(response => response.json()) as { lease_id: string }
  const ready = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('pre-provider-complete-key'), body: '{}' })).then(response => response.json()) as { object_ref: string }
  const operation = { local_operation_id: 'task_pre_provider_12345678', consent_revision_id: leasePayload.consent_revision_id, consent_scope_hash: hash, local_budget_reservation_id: 'budget_pre_provider_12345678', request_hash: hash, capability: 'visual_evidence' as const, application_role: 'shot_evidence' as const, input: { object_refs: [ready.object_ref], evidence_window_id: 'window_pre_provider_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } }
  const failed = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-provider-operation-key'), body: JSON.stringify(operation) }))
  expect(failed.status).toBe(503)
  expect(await failed.clone().json()).toMatchObject({ error: 'provider_not_started' })
  const replay = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-provider-operation-key'), body: JSON.stringify(operation) }))
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ state: 'failed', safe_error_code: 'provider_not_started' })
  expect(executions).toBe(0)
  expect(deleted).toEqual([lease.lease_id])
  const releasedQuota = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-provider-released-quota-key'), body: JSON.stringify({
    local_operation_id: 'task_pre_provider_quota_12345678', consent_revision_id: 'consent_pre_provider_quota', consent_scope_hash: hash, local_budget_reservation_id: 'budget_pre_provider_quota', request_hash: hash,
    capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'fact_pre_provider_12345678', text: '额度已释放' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' },
  }) }))
  expect(releasedQuota.status).toBe(503)
})

test('Relay makes pre-fence admission timeout and cancellation terminal known failures', async () => {
  let release!: () => void
  let executions = 0
  const blocked = new Promise<void>(resolve => { release = resolve })
  const receipt: ProviderExecutionReceipt = { id: 'receipt_pre_fence_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX: '1', VIDEO_MEDIA_DASHSCOPE_OWNER_QUEUE_MAX: '1', VIDEO_MEDIA_DASHSCOPE_MAX_WAIT_MS: '10',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_RPM: '1000',
    VIDEO_MEDIA_DASHSCOPE_VISUAL_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_REASONING_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ASR_MAX_ACTIVE: '1',
    VIDEO_MEDIA_DASHSCOPE_EMBEDDING_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_EMBEDDING_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_EMBEDDING_RPM: '1000',
  }, fetchImpl: identityFetch, provider: { async execute() { executions += 1; await blocked; return { state: 'submitted', provider_task_id: 'provider-pre-fence-123', receipt } } }, now })
  const operation = (suffix: string) => ({ local_operation_id: `task_pre_fence_${suffix}`, consent_revision_id: 'consent_pre_fence_12345678', consent_scope_hash: hash, local_budget_reservation_id: `budget_pre_fence_${suffix}`, request_hash: hash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: `fact_pre_fence_${suffix}`, text: '准入前终态' }], model: 'text-embedding-v4', dimension: 768 as const, instruction_version: 'v1' } })
  const first = handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-fence-first-key'), body: JSON.stringify(operation('first_12345678')) }))
  while (executions !== 1) await Promise.resolve()
  const timedOut = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-fence-timeout-key'), body: JSON.stringify(operation('timeout_12345678')) }))
  expect(timedOut.status).toBe(429)
  expect(await timedOut.clone().json()).toMatchObject({ error: 'provider_not_started' })
  const timeoutReplay = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-fence-timeout-key'), body: JSON.stringify(operation('timeout_12345678')) }))
  expect(await timeoutReplay.json()).toMatchObject({ state: 'failed', safe_error_code: 'provider_not_started' })
  const aborter = new AbortController()
  const cancelledRequest = handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-fence-cancel-key'), body: JSON.stringify(operation('cancel_12345678')), signal: aborter.signal }))
  await new Promise(resolve => setTimeout(resolve, 1))
  aborter.abort(new DOMException('client disconnected', 'AbortError'))
  const cancelled = await cancelledRequest
  expect(cancelled.status).toBe(499)
  expect(await cancelled.clone().json()).toMatchObject({ error: 'provider_not_started' })
  const cancelReplay = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('pre-fence-cancel-key'), body: JSON.stringify(operation('cancel_12345678')) }))
  expect(await cancelReplay.json()).toMatchObject({ state: 'failed', safe_error_code: 'provider_not_started' })
  release()
  await first
  expect(executions).toBe(1)
})

test('Relay reads an owner-scoped local-operation recovery projection without side effects', async () => {
  const dbPath = join(tmpdir(), `video-relay-local-lookup-${crypto.randomUUID()}.sqlite`)
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  let executions = 0
  const receipt: ProviderExecutionReceipt = { id: 'receipt_lookup_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}` } },
    async head(id) { return uploaded.get(id) ?? null }, async delete(id) { uploaded.delete(id) },
    async createReadUrl() { throw new Error('lookup_visual_must_fail_before_provider') }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const identityByBearer = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const owner = new Headers(init?.headers).get('authorization')?.endsWith('owner-b') ? 'installation:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:install_b_12345678' : 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:install_a_12345678'
    return Response.json({ active: true, principal_id: owner.slice(0, owner.indexOf(':install_')), installation_id: owner.slice(owner.lastIndexOf(':') + 1), session_id: 'abcdefghijklmnopqrstuvwx', expires_at: Date.now() + 60_000, owner })
  }
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath }, fetchImpl: identityByBearer, objectStore, provider: { async execute() { executions += 1; return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [] } } } }, now })
  const get = (localOperationId: string, bearer = 'owner-a') => handler(new Request(`http://relay${videoMediaOperationByLocalOperationPath(localOperationId)}`, { headers: { Authorization: `Bearer ${bearer}` } }))
  try {
    const operation = { local_operation_id: 'task_lookup_created_12345678', consent_revision_id: 'consent_lookup_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_lookup_12345678', request_hash: hash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const, input: { embedding_role: 'query' as const, items: [{ id: 'fact_lookup_12345678', text: '恢复原操作' }], model: 'text-embedding-v4', dimension: 768 as const, instruction_version: 'v1' } }
    const created = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: { ...headers('lookup-create-key-1234'), Authorization: 'Bearer owner-a' }, body: JSON.stringify(operation) }))
    const projection = await created.json() as { id: string }
    const db = new Database(dbPath)
    const quotaRowsBeforeLookup = (db.query('SELECT COUNT(*) AS total FROM video_media_quota_v1').get() as { total: number }).total
    db.close()
    const recovered = await get(operation.local_operation_id)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ id: projection.id, state: 'succeeded' })
    const after = new Database(dbPath)
    expect((after.query('SELECT COUNT(*) AS total FROM video_media_quota_v1').get() as { total: number }).total).toBe(quotaRowsBeforeLookup)
    after.close()
    expect(executions).toBe(1)
    expect((await get('task_lookup_unknown_12345678')).status).toBe(404)
    expect((await get(operation.local_operation_id, 'owner-b')).status).toBe(404)

    const leasePayload = { local_operation_id: 'task_lookup_failed_12345678', purpose: 'visual_frames', content_hash: hash, byte_size: 4, content_type: 'image/png', consent_revision_id: 'consent_lookup_failed_12345678', consent_scope_hash: hash }
    const lease = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: { ...headers('lookup-failed-lease-key'), Authorization: 'Bearer owner-a' }, body: JSON.stringify(leasePayload) })).then(response => response.json()) as { lease_id: string }
    const ready = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: { ...headers('lookup-failed-complete-key'), Authorization: 'Bearer owner-a' }, body: '{}' })).then(response => response.json()) as { object_ref: string }
    const failedOperation = { local_operation_id: leasePayload.local_operation_id, consent_revision_id: leasePayload.consent_revision_id, consent_scope_hash: hash, local_budget_reservation_id: 'budget_lookup_failed_12345678', request_hash: hash, capability: 'visual_evidence' as const, application_role: 'shot_evidence' as const, input: { object_refs: [ready.object_ref], evidence_window_id: 'window_lookup_failed_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } }
    const failed = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: { ...headers('lookup-failed-operation-key'), Authorization: 'Bearer owner-a' }, body: JSON.stringify(failedOperation) }))
    expect(await failed.json()).toMatchObject({ error: 'provider_not_started' })
    expect(await get(failedOperation.local_operation_id).then(response => response.json())).toMatchObject({ state: 'failed', safe_error_code: 'provider_not_started' })
    expect(executions).toBe(1)
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay startup recovers only aged pre-start accepted orphans before the Provider fence', async () => {
  const dbPath = join(tmpdir(), `video-relay-accepted-orphan-${crypto.randomUUID()}.sqlite`)
  const owner = 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:install_12345678'
  const deleted: string[] = []
  const objectStore: MediaObjectStore = {
    async createPutUrl() { return { put_url: 'https://oss.example.test/put', required_headers: {} } }, async head() { return null }, async delete(leaseId) { deleted.push(leaseId) },
    async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const env = { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath, VIDEO_MEDIA_ACCEPTED_ORPHAN_GRACE_MS: '60000' }
  try {
    createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, now })
    const db = new Database(dbPath)
    const oldAt = '2026-08-02T23:57:00.000Z'
    const startAt = now().toISOString()
    const oldRequest = { local_operation_id: 'task_orphan_old_12345678', consent_revision_id: 'consent_orphan_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_orphan_12345678', request_hash: hash, capability: 'visual_evidence', application_role: 'shot_evidence', input: { object_refs: ['object_orphan_old_12345678'], evidence_window_id: 'window_orphan_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } }
    const currentRequest = { local_operation_id: 'task_orphan_current_12345678', consent_revision_id: 'consent_orphan_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_orphan_current_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'fact_orphan_current_12345678', text: 'current process boundary' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }
    db.query(`INSERT INTO video_media_leases_v1(id,owner,local_operation_id,purpose,content_hash,byte_size,content_type,consent_revision_id,consent_scope_hash,state,object_ref,expires_at,created_at,multipart_upload_id,multipart_part_size,multipart_phase,multipart_parts_json)
      VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?,?,NULL,NULL,NULL,NULL)`).run('lease_orphan_old_12345678', owner, oldRequest.local_operation_id, 'visual_frames', hash, 1, 'image/jpeg', oldRequest.consent_revision_id, hash, 'object_orphan_old_12345678', '2026-08-03T01:00:00.000Z', oldAt)
    db.query("INSERT INTO video_media_lease_quota_v1(owner,lease_id,state,units) VALUES(?,?,'reserved',1)").run(owner, 'lease_orphan_old_12345678')
    const insertQuota = (reservation: string, operationId: string, createdAt: string) => db.query(`INSERT INTO video_media_quota_v1(owner,reservation_id,operation_id,state,units,period,policy_revision,account_key,settled_units,actual_usage_json,created_at,settled_at)
      VALUES(?,?,?,'reserved',1,'2026-08-03','test-v1','video-dashscope-account',0,NULL,?,NULL)`).run(owner, reservation, operationId, createdAt)
    const insertOperation = (id: string, request: typeof oldRequest | typeof currentRequest, reservation: string, createdAt: string) => db.query(`INSERT INTO video_media_operations_v1(id,owner,local_operation_id,idempotency_key,request_hash,request_json,state,provider_task_id,result_object_refs,provider_receipt,account_quota_reservation_id,safe_error_code,created_at,updated_at,acknowledged_at,submission_started_at)
      VALUES(?,?,?,?,?,?,'accepted',NULL,NULL,NULL,?,NULL,?,?,NULL,NULL)`).run(id, owner, request.local_operation_id, `${id}-key`, hash, JSON.stringify(request), reservation, createdAt, createdAt)
    insertQuota('quota_orphan_old_12345678', 'remoteop_orphan_old_12345678', oldAt)
    insertOperation('remoteop_orphan_old_12345678', oldRequest, 'quota_orphan_old_12345678', oldAt)
    insertQuota('quota_orphan_current_12345678', 'remoteop_orphan_current_12345678', startAt)
    insertOperation('remoteop_orphan_current_12345678', currentRequest, 'quota_orphan_current_12345678', startAt)

    createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, now })
    const cleanupDeadline = Date.now() + 1_000
    while (!(db.query('SELECT completed_at FROM video_media_object_cleanup_v1 WHERE lease_id=?').get('lease_orphan_old_12345678') as { completed_at: string | null } | null)?.completed_at) {
      if (Date.now() >= cleanupDeadline) throw new Error('timed out waiting for orphan input cleanup')
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(db.query('SELECT state,safe_error_code FROM video_media_operations_v1 WHERE id=?').get('remoteop_orphan_old_12345678')).toEqual({ state: 'failed', safe_error_code: 'provider_not_started' })
    expect(db.query('SELECT state FROM video_media_quota_v1 WHERE reservation_id=?').get('quota_orphan_old_12345678')).toEqual({ state: 'released' })
    expect(db.query('SELECT state,safe_error_code FROM video_media_operations_v1 WHERE id=?').get('remoteop_orphan_current_12345678')).toEqual({ state: 'accepted', safe_error_code: null })
    expect(db.query('SELECT state FROM video_media_quota_v1 WHERE reservation_id=?').get('quota_orphan_current_12345678')).toEqual({ state: 'reserved' })
    expect(deleted).toEqual(['lease_orphan_old_12345678'])
    db.close()
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay restarts locally, reconciles a persisted long ASR task, and serializes concurrent GET polling', async () => {
  const objectStore: MediaObjectStore = {
    async createPutUrl() { return { put_url: 'https://oss.example.test/put', required_headers: {} } }, async head() { return { byte_size: 4, content_hash: hash, content_type: 'audio/wav' } }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  let polls = 0
  const receipt: ProviderExecutionReceipt = { id: 'receipt_12345678', capability: 'speech_transcription', model_snapshot: 'fun-asr', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 10, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute(input) { return input.capability === 'speech_transcription' ? { state: 'submitted', provider_task_id: 'provider-task-1', receipt } : { state: 'succeeded', receipt: { ...receipt, id: 'receipt_embedding_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4' }, result: { kind: 'embedding', vectors: [] } } }, async poll() { polls += 1; return { state: 'failed', provider_task_id: 'provider-task-1', receipt, safe_error_code: 'asr_task_failed' } } }
  const dbPath = join(tmpdir(), `video-relay-asr-restart-${crypto.randomUUID()}.sqlite`)
  const env = { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath, VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '1', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1' }
  try {
  const handler = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, provider, now })
  const leaseResponse = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('long-asr-lease-key-001'), body: JSON.stringify({ local_operation_id: 'task_87654321', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  const lease = await leaseResponse.json() as { lease_id: string }
  const completed = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('long-asr-complete-key-1'), body: '{}' }))
  const ready = await completed.json() as { object_ref: string }
  const operation = { local_operation_id: 'task_87654321', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'speech_transcription', application_role: 'asr', input: { mode: 'long_async', audio_object_ref: ready.object_ref, source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, hotwords: ['开球'], speaker_diarization: true, sentence_timestamps: true, word_timestamps: true } }
  const created = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('long-asr-operation-key-1'), body: JSON.stringify(operation) }))
  expect(await created.json()).toMatchObject({ state: 'submitted', provider_task_id: 'provider-task-1' })
  const whileSubmitted = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('long-asr-quota-held-key'), body: JSON.stringify({ local_operation_id: 'task_embedding_before_asr_terminal', consent_revision_id: 'consent_embedding_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_embedding_before_asr', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'fact_embedding_12345678', text: 'quota remains reserved' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }) }))
  expect(whileSubmitted.status).toBe(429)
  const id = (await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('long-asr-operation-key-1'), body: JSON.stringify(operation) })).then(response => response.json())) as { id: string }
  const restarted = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, provider, now })
  const polled = await Promise.all(Array.from({ length: 8 }, () => restarted(new Request(`http://relay/v1/video-media/operations/${id.id}`, { headers: { Authorization: 'Bearer installation-token' } }))))
  const polledBodies = await Promise.all(polled.map(response => response.json())) as Array<{ state?: string; safe_error_code?: string }>
  expect(polledBodies).toHaveLength(8)
  expect(polledBodies.every(item => item.state === 'failed' && item.safe_error_code === 'asr_task_failed')).toBe(true)
  expect(polls).toBe(1)
  const afterTerminal = await restarted(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('long-asr-quota-released-key'), body: JSON.stringify({ local_operation_id: 'task_embedding_after_asr_terminal', consent_revision_id: 'consent_embedding_after_123456', consent_scope_hash: hash, local_budget_reservation_id: 'budget_embedding_after_asr', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'fact_embedding_after_123456', text: 'quota released after terminal failure' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }) }))
  expect(afterTerminal.status).toBe(429)
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay treats a timeout after remote multipart completion as an idempotent success', async () => {
  const completed: Array<{ part_number: number; etag: string }> = []
  let objectCompleted = false
  let crashAfterOssCompletion = true
  const objectStore: MediaObjectStore = {
    async createPutUrl() { throw new Error('single_put_not_expected') },
    async head() { return objectCompleted ? { byte_size: 6 * 1024 * 1024, content_hash: hash, content_type: 'video/mp4' } : null },
    async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
    async createMultipartUpload() { return { uploadId: 'upload-123' } },
    async createMultipartPartPutUrl(input) { return { put_url: `https://oss.example.test/part/${input.partNumber}` } },
    async listMultipartParts() { return [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] },
    async completeMultipartUpload(input) { completed.push(...input.parts); objectCompleted = true; if (crashAfterOssCompletion) { crashAfterOssCompletion = false; throw new Error('crash_after_oss_completion') } },
    async abortMultipartUpload() {},
  }
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(3 * 1024 * 1024),
  }, fetchImpl: identityFetch, objectStore, now })
  const payload = { local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6 * 1024 * 1024, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }
  const created = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('multipart-lease-key-0001'), body: JSON.stringify(payload) }))
  expect(created.status).toBe(201)
  const lease = await created.json() as { lease_id: string; multipart_upload: { parts: Array<{ part_number: number }>; uploaded_parts: Array<{ part_number: number }> } }
  expect(lease.multipart_upload.parts).toHaveLength(2)
  expect(lease.multipart_upload.uploaded_parts).toEqual([{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }])
  const replay = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('multipart-lease-key-0001'), body: JSON.stringify(payload) }))
  expect(await replay.json()).toMatchObject({ lease_id: lease.lease_id, multipart_upload: { upload_id: 'upload-123' } })
  const incomplete = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('multipart-complete-key-1'), body: JSON.stringify({ parts: [{ part_number: 1, etag: 'etag-one' }] }) }))
  expect(incomplete.status).toBe(422)
  const completionPayload = { parts: [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] }
  const interrupted = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('multipart-complete-key-2'), body: JSON.stringify(completionPayload) }))
  expect(interrupted.status).toBe(200)
  const complete = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('multipart-complete-key-3'), body: JSON.stringify(completionPayload) }))
  expect(complete.status).toBe(200)
  expect(completed).toEqual([{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }])
})

test('Relay aborts a multipart session and closes the lease when completion really fails', async () => {
  const aborted: Array<{ leaseId: string; uploadId: string }> = []
  const objectStore: MediaObjectStore = {
    async createPutUrl() { throw new Error('single_put_not_expected') }, async head() { return null }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
    async createMultipartUpload() { return { uploadId: 'upload-fails' } }, async createMultipartPartPutUrl() { return { put_url: 'https://oss.example.test/part' } },
    async listMultipartParts() { return [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] }, async completeMultipartUpload() { throw new Error('oss_complete_lost') },
    async abortMultipartUpload(input) { aborted.push(input) },
  }
  const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:', VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(3 * 1024 * 1024) }, fetchImpl: identityFetch, objectStore, now })
  const payload = { local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6 * 1024 * 1024, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }
  const created = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('multipart-fail-lease-key'), body: JSON.stringify(payload) }))
  const lease = await created.json() as { lease_id: string }
  const completion = { parts: [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] }
  const failed = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('multipart-fail-complete-key'), body: JSON.stringify(completion) }))
  expect(failed.status).toBe(503)
  expect(await failed.json()).toMatchObject({ error: 'multipart_completion_failed' })
  expect(aborted).toEqual([{ leaseId: lease.lease_id, uploadId: 'upload-fails' }])
  const retry = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('multipart-fail-complete-retry'), body: JSON.stringify(completion) }))
  expect(retry.status).toBe(410)
  expect(aborted).toHaveLength(1)
})

test('Sidecar resumes only missing multipart parts and retries a timed-out cross-border PUT', async () => {
  let partTwoAttempts = 0
  let completed: unknown
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadRetries: 1, now,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') return Response.json({
        lease_id: 'lease_12345678', state: 'awaiting_upload', expires_at: '2026-08-03T01:00:00.000Z',
        multipart_upload: { upload_id: 'upload-123', part_size: 3, uploaded_parts: [{ part_number: 1, etag: 'etag-one' }], parts: [{ part_number: 1, put_url: 'https://oss.example.test/part/1' }, { part_number: 2, put_url: 'https://oss.example.test/part/2' }] },
      })
      if (url === 'https://relay.example.test/v1/video-media/object-leases/lease_12345678/renew') return Response.json({
        lease_id: 'lease_12345678', state: 'awaiting_upload', expires_at: '2026-08-03T01:00:00.000Z',
        multipart_upload: { upload_id: 'upload-123', part_size: 3, uploaded_parts: [{ part_number: 1, etag: 'etag-one' }], parts: [{ part_number: 1, put_url: 'https://oss.example.test/part/1' }, { part_number: 2, put_url: 'https://oss.example.test/part/2' }] },
      })
      if (url === 'https://relay.example.test/v1/video-media/object-leases/lease_12345678/complete') {
        completed = JSON.parse(String(init?.body))
        return Response.json({ lease_id: 'lease_12345678', state: 'ready', object_ref: 'object_12345678', expires_at: '2026-08-03T01:00:00.000Z' })
      }
      if (url.endsWith('/part/1')) throw new Error('an already committed part must not be sent again')
      partTwoAttempts += 1
      if (partTwoAttempts === 1) throw new Error('cross-border timeout')
      return new Response(null, { status: 200, headers: { ETag: 'etag-two' } })
    },
  })
  const ref = await client.uploadObject(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), new Uint8Array([1, 2, 3, 4, 5, 6]))
  expect(ref).toBe('object_12345678')
  expect(partTwoAttempts).toBe(2)
  expect(completed).toEqual({ parts: [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] })
})

test('Sidecar accepts a refreshed Relay-confirmed multipart part after an ambiguous 409', async () => {
  let leaseReads = 0
  let firstPartPuts = 0
  let completed: unknown
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadRetries: 0, now,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases' || url.endsWith('/object-leases/lease_12345678/renew')) {
        leaseReads += 1
        return Response.json({
          lease_id: 'lease_12345678', state: 'awaiting_upload', expires_at: '2026-08-03T01:00:00.000Z',
          multipart_upload: {
            upload_id: 'upload-123', part_size: 3,
            uploaded_parts: leaseReads === 1 ? [] : [{ part_number: 1, etag: 'oss-confirmed-etag-one' }],
            parts: [{ part_number: 1, put_url: 'https://oss.example.test/part/1' }, { part_number: 2, put_url: 'https://oss.example.test/part/2' }],
          },
        })
      }
      if (url.endsWith('/complete')) {
        completed = JSON.parse(String(init?.body))
        return Response.json({ lease_id: 'lease_12345678', state: 'ready', object_ref: 'object_12345678', expires_at: '2026-08-03T01:00:00.000Z' })
      }
      if (url.endsWith('/part/1')) { firstPartPuts += 1; return new Response(null, { status: 409 }) }
      return new Response(null, { status: 200, headers: { ETag: 'etag-two' } })
    },
  })
  await expect(client.uploadObject(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), new Uint8Array([1, 2, 3, 4, 5, 6]))).resolves.toBe('object_12345678')
  expect(firstPartPuts).toBe(1)
  expect(leaseReads).toBe(2)
  expect(completed).toEqual({ parts: [{ part_number: 1, etag: 'oss-confirmed-etag-one' }, { part_number: 2, etag: 'etag-two' }] })
})

test('Sidecar reconciles an ambiguous immutable direct PUT through the same Relay lease', async () => {
  let puts = 0
  let completes = 0
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadRetries: 0, now,
    fetchImpl: async input => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') return Response.json({
        lease_id: 'lease_12345678', state: 'awaiting_upload', put_url: 'https://oss.example.test/direct', required_headers: {}, expires_at: '2026-08-03T01:00:00.000Z',
      })
      if (url.endsWith('/complete')) {
        completes += 1
        return Response.json({ lease_id: 'lease_12345678', state: 'ready', object_ref: 'object_12345678', expires_at: '2026-08-03T01:00:00.000Z' })
      }
      puts += 1
      return new Response(null, { status: 409 })
    },
  })
  await expect(client.uploadObject(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), new Uint8Array([1, 2, 3, 4]))).resolves.toBe('object_12345678')
  expect(puts).toBe(1)
  expect(completes).toBe(1)
})

test('Sidecar stream upload accepts Relay-confirmed parts after an ambiguous 409', async () => {
  let leaseReads = 0
  let firstPartPuts = 0
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadRetries: 0, now,
    fetchImpl: async input => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases' || url.endsWith('/object-leases/lease_12345678/renew')) {
        leaseReads += 1
        return Response.json({
          lease_id: 'lease_12345678', state: 'awaiting_upload', expires_at: '2026-08-03T01:00:00.000Z',
          multipart_upload: {
            upload_id: 'upload-123', part_size: 3,
            uploaded_parts: leaseReads === 1 ? [] : [{ part_number: 1, etag: 'oss-confirmed-etag-one' }],
            parts: [{ part_number: 1, put_url: 'https://oss.example.test/part/1' }, { part_number: 2, put_url: 'https://oss.example.test/part/2' }],
          },
        })
      }
      if (url.endsWith('/complete')) return Response.json({ lease_id: 'lease_12345678', state: 'ready', object_ref: 'object_12345678', expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.endsWith('/part/1')) { firstPartPuts += 1; return new Response(null, { status: 409 }) }
      return new Response(null, { status: 200, headers: { ETag: 'etag-two' } })
    },
  })
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
  await expect(client.uploadObjectStream(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byte_size: bytes.byteLength, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))).resolves.toBe('object_12345678')
  expect(firstPartPuts).toBe(1)
  expect(leaseReads).toBe(2)
})

test('Sidecar 在 direct PUT 前以旧到期时间幂等续租同一 lease', async () => {
  const paths: string[] = []
  const renewalKeys: string[] = []
  let oldCapabilityUsed = false
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadTimeoutMs: 5_000, now,
    fetchImpl: async (input, init) => {
      const url = String(input); paths.push(url)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') return Response.json({
        lease_id: 'lease_12345678', state: 'awaiting_upload', put_url: 'https://oss.example.test/direct-old', required_headers: {}, expires_at: '2026-08-03T00:00:09.000Z',
      })
      if (url.endsWith('/object-leases/lease_12345678/renew')) {
        renewalKeys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '')
        return Response.json({ lease_id: 'lease_12345678', state: 'awaiting_upload', put_url: 'https://oss.example.test/direct-new', required_headers: { 'x-oss-epoch': 'renewed' }, expires_at: '2026-08-03T01:00:00.000Z' })
      }
      if (url.endsWith('/direct-old')) { oldCapabilityUsed = true; throw new Error('expired capability must not be used') }
      if (url.endsWith('/direct-new')) {
        expect(new Headers(init?.headers).get('x-oss-epoch')).toBe('renewed')
        return new Response(null, { status: 200 })
      }
      if (url.endsWith('/object-leases/lease_12345678/complete')) return Response.json({ lease_id: 'lease_12345678', state: 'ready', object_ref: 'object_12345678', expires_at: '2026-08-03T01:00:00.000Z' })
      throw new Error(`unexpected request ${url}`)
    },
  })
  await expect(client.uploadObject(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), new Uint8Array([1, 2, 3, 4]))).resolves.toBe('object_12345678')
  expect(oldCapabilityUsed).toBeFalse()
  expect(paths.filter(path => path.endsWith('/renew'))).toHaveLength(1)
  expect(renewalKeys).toHaveLength(1)
  expect(renewalKeys[0]).toStartWith('renew-lease_12345678-')
})

test('Sidecar 流式 multipart 在下一片签名前续租同一 lease 并沿用已上传分片', async () => {
  let clock = new Date('2026-08-03T00:00:00.000Z')
  let creates = 0
  let renewals = 0
  const putUrls: string[] = []
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
  const lease = (renewed: boolean) => ({
    lease_id: 'lease_12345678', state: 'awaiting_upload', expires_at: renewed ? '2026-08-03T00:02:00.000Z' : '2026-08-03T00:01:00.000Z',
    multipart_upload: {
      upload_id: 'upload-123', part_size: 3,
      uploaded_parts: renewed ? [{ part_number: 1, etag: 'etag-one' }] : [],
      parts: [
        { part_number: 1, put_url: `https://oss.example.test/part/1?epoch=${renewed ? 2 : 1}` },
        { part_number: 2, put_url: `https://oss.example.test/part/2?epoch=${renewed ? 2 : 1}` },
      ],
    },
  })
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadTimeoutMs: 5_000, now: () => clock,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') { creates += 1; return Response.json(lease(false)) }
      if (url.endsWith('/object-leases/lease_12345678/renew')) { renewals += 1; return Response.json(lease(true)) }
      if (url.endsWith('/object-leases/lease_12345678/complete')) return Response.json({ lease_id: 'lease_12345678', state: 'ready', object_ref: 'object_12345678', expires_at: '2026-08-03T00:02:00.000Z' })
      if (url.includes('/part/')) {
        putUrls.push(url)
        if (url.includes('/part/1')) {
          expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(bytes.subarray(0, 3))
          clock = new Date('2026-08-03T00:00:55.000Z')
          return new Response(null, { status: 200, headers: { ETag: 'etag-one' } })
        }
        expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(bytes.subarray(3))
        return new Response(null, { status: 200, headers: { ETag: 'etag-two' } })
      }
      throw new Error(`unexpected request ${url}`)
    },
  })
  await expect(client.uploadObjectStream(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byte_size: bytes.byteLength, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), () => new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }))).resolves.toBe('object_12345678')
  expect({ creates, renewals }).toEqual({ creates: 1, renewals: 1 })
  expect(putUrls).toEqual(['https://oss.example.test/part/1?epoch=1', 'https://oss.example.test/part/2?epoch=2'])
})

test('Sidecar 中止正在进行的 OSS PUT，且不会盲重试或完成 lease', async () => {
  const controller = new AbortController()
  let beganPut!: () => void
  const putStarted = new Promise<void>(resolve => { beganPut = resolve })
  let putAttempts = 0
  let completes = 0
  let putSawAbort = false
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadRetries: 3, signal: controller.signal, now,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') return Response.json({ lease_id: 'lease_12345678', state: 'awaiting_upload', put_url: 'https://oss.example.test/direct', required_headers: {}, expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.endsWith('/complete')) { completes += 1; throw new Error('cancelled upload must not complete') }
      putAttempts += 1; beganPut()
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { putSawAbort = true; reject(new Error('PUT aborted')) }, { once: true }))
    },
  })
  const pending = client.uploadObject(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), new Uint8Array([1, 2, 3, 4]))
  await putStarted
  controller.abort()
  await expect(pending).rejects.toMatchObject({ status: 499, code: 'relay_upload_cancelled' } satisfies Partial<VideoMediaRelayClientError>)
  expect({ putAttempts, completes, putSawAbort }).toEqual({ putAttempts: 1, completes: 0, putSawAbort: true })
})

test('Sidecar 中止等待中的源流读取，不继续读取或发出 OSS PUT', async () => {
  const controller = new AbortController()
  let beganRead!: () => void
  const readStarted = new Promise<void>(resolve => { beganRead = resolve })
  let cancellations = 0
  let puts = 0
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', signal: controller.signal, now,
    fetchImpl: async input => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') return Response.json({ lease_id: 'lease_12345678', state: 'awaiting_upload', expires_at: '2026-08-03T01:00:00.000Z', multipart_upload: { upload_id: 'upload-123', part_size: 3, uploaded_parts: [], parts: [{ part_number: 1, put_url: 'https://oss.example.test/part/1' }, { part_number: 2, put_url: 'https://oss.example.test/part/2' }] } })
      puts += 1
      throw new Error(`unexpected PUT ${url}`)
    },
  })
  const source = () => new ReadableStream<Uint8Array>({
    pull() { beganRead(); return new Promise(() => {}) },
    cancel() { cancellations += 1 },
  })
  const pending = client.uploadObjectStream(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), source)
  await readStarted
  controller.abort()
  await expect(pending).rejects.toMatchObject({ status: 499, code: 'relay_upload_cancelled' } satisfies Partial<VideoMediaRelayClientError>)
  expect(puts).toBe(0)
  expect(cancellations).toBeGreaterThanOrEqual(1)
})

test('Sidecar caps Relay control JSON and validates result object size before buffering', async () => {
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', controlResponseMaxBytes: 4 * 1024, resultMaxBytes: 1024 * 1024,
    fetchImpl: async () => new Response(`{"pad":"${'x'.repeat(4 * 1024)}"}`, { headers: { 'content-type': 'application/json' } }),
  })
  await expect(client.operation('operation_12345678')).rejects.toMatchObject({ code: 'relay_control_response_too_large' } satisfies Partial<VideoMediaRelayClientError>)
  const oversized: VideoRelayOperationProjection = {
    id: 'operation_12345678', state: 'succeeded', account_quota_reservation_id: 'quota_12345678',
    result_objects: [{ object_ref: 'result_12345678', content_hash: hash, byte_size: 1024 * 1024 + 1, content_type: 'application/json', get_url: 'https://result.example.test/large.json', expires_at: '2026-08-03T01:00:00.000Z' }],
    created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
  }
  await expect(client.downloadResult(oversized)).rejects.toMatchObject({ code: 'relay_result_too_large' } satisfies Partial<VideoMediaRelayClientError>)
})

test('Sidecar rejects a truncated Relay result before JSON parsing', async () => {
  const bytes = new TextEncoder().encode('{"kind":"asr"}')
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token',
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'application/json' } }),
  })
  const truncated: VideoRelayOperationProjection = {
    id: 'operation_12345678', state: 'succeeded', account_quota_reservation_id: 'quota_12345678',
    result_objects: [{ object_ref: 'result_12345678', content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byte_size: bytes.byteLength + 1, content_type: 'application/json', get_url: 'https://result.example.test/truncated.json', expires_at: '2026-08-03T01:00:00.000Z' }],
    created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
  }
  await expect(client.downloadResult(truncated)).rejects.toMatchObject({ code: 'relay_result_integrity_failed' } satisfies Partial<VideoMediaRelayClientError>)
})

test('Sidecar 按 local_operation_id 只读恢复 durable Relay Operation，仅 404 表示不存在', async () => {
  let status = 404
  let errorCode = 'operation_not_found'
  const paths: string[] = []
  const projection: VideoRelayOperationProjection = {
    id: 'operation_12345678', state: 'running', provider_task_id: 'provider_12345678', account_quota_reservation_id: 'quota_12345678',
    created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
  }
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token',
    fetchImpl: async input => {
      paths.push(new URL(String(input)).pathname)
      return status === 200 ? Response.json(projection) : Response.json({ error: errorCode }, { status })
    },
  })
  await expect(client.operationByLocalOperationId('task_local_12345678')).resolves.toBeNull()
  errorCode = 'route_not_found'
  await expect(client.operationByLocalOperationId('task_local_12345678')).rejects.toMatchObject({ status: 404, code: 'route_not_found' } satisfies Partial<VideoMediaRelayClientError>)
  status = 503
  errorCode = 'relay_unavailable'
  await expect(client.operationByLocalOperationId('task_local_12345678')).rejects.toMatchObject({ status: 503 } satisfies Partial<VideoMediaRelayClientError>)
  status = 200
  await expect(client.operationByLocalOperationId('task_local_12345678')).resolves.toMatchObject({ id: projection.id })
  expect(paths).toEqual(Array(4).fill('/v1/video-media/operations/by-local-operation/task_local_12345678'))
})

test('Sidecar deadlines cover headers and whole control/result bodies, while preserving cancellation', async () => {
  const timedOut = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', controlTimeoutMs: 1_000,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  })
  await expect(timedOut.operation('operation_12345678')).rejects.toMatchObject({ code: 'relay_control_timeout' } satisfies Partial<VideoMediaRelayClientError>)
  const controller = new AbortController()
  const cancelled = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', signal: controller.signal,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  })
  const request = cancelled.operation('operation_12345678')
  controller.abort()
  await expect(request).rejects.toMatchObject({ code: 'relay_control_cancelled' } satisfies Partial<VideoMediaRelayClientError>)

  const hangingBody = () => new ReadableStream<Uint8Array>({ pull() {} })
  const stalledControl = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', controlTimeoutMs: 1_000,
    fetchImpl: async () => new Response(hangingBody(), { headers: { 'content-type': 'application/json' } }),
  })
  await expect(stalledControl.operation('operation_12345678')).rejects.toMatchObject({ code: 'relay_control_timeout' } satisfies Partial<VideoMediaRelayClientError>)
  const stalledResult = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', resultTimeoutMs: 1_000,
    fetchImpl: async () => new Response(hangingBody(), { headers: { 'content-type': 'application/json' } }),
  })
  const result: VideoRelayOperationProjection = {
    id: 'operation_12345678', state: 'succeeded', account_quota_reservation_id: 'quota_12345678',
    result_objects: [{ object_ref: 'result_12345678', content_hash: hash, byte_size: 1, content_type: 'application/json', get_url: 'https://result.example.test/hang.json', expires_at: '2026-08-03T01:00:00.000Z' }],
    created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
  }
  const stalledResultHeaders = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', resultTimeoutMs: 1_000,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  })
  await expect(stalledResultHeaders.downloadResult(result)).rejects.toMatchObject({ code: 'relay_result_timeout' } satisfies Partial<VideoMediaRelayClientError>)
  await expect(stalledResult.downloadResult(result)).rejects.toMatchObject({ code: 'relay_result_timeout' } satisfies Partial<VideoMediaRelayClientError>)
})

test('Sidecar 在结果 Content-Length 快速拒绝时取消 body 且不等待卡死的 cancel', async () => {
  let cancellationCalls = 0
  const body = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => {}) },
    cancel() { cancellationCalls += 1; return new Promise(() => {}) },
  })
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', resultTimeoutMs: 60_000,
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': '2' } }),
  })
  const result: VideoRelayOperationProjection = {
    id: 'operation_12345678', state: 'succeeded', account_quota_reservation_id: 'quota_12345678',
    result_objects: [{ object_ref: 'result_12345678', content_hash: hash, byte_size: 1, content_type: 'application/json', get_url: 'https://result.example.test/declared-too-large.json', expires_at: '2026-08-03T01:00:00.000Z' }],
    created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
  }
  const startedAt = performance.now()
  await expect(client.downloadResult(result)).rejects.toMatchObject({ code: 'relay_result_integrity_failed' } satisfies Partial<VideoMediaRelayClientError>)
  expect(performance.now() - startedAt).toBeLessThan(500)
  expect(cancellationCalls).toBe(1)

  let errorBodyCancellationCalls = 0
  const errorBody = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => {}) },
    cancel() { errorBodyCancellationCalls += 1; return new Promise(() => {}) },
  })
  const unavailable = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', resultTimeoutMs: 60_000,
    fetchImpl: async () => new Response(errorBody, { status: 503 }),
  })
  const errorStartedAt = performance.now()
  await expect(unavailable.downloadResult(result)).rejects.toMatchObject({ code: 'relay_result_unavailable' } satisfies Partial<VideoMediaRelayClientError>)
  expect(performance.now() - errorStartedAt).toBeLessThan(500)
  expect(errorBodyCancellationCalls).toBe(1)
})

test('Sidecar streams a large source by fixed parts without materializing cross-part chunks', async () => {
  let uploadedPartTwo = 0
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', now,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') return Response.json({ lease_id: 'lease_12345678', state: 'awaiting_upload', expires_at: '2026-08-03T01:00:00.000Z', multipart_upload: { upload_id: 'upload-123', part_size: 3, uploaded_parts: [{ part_number: 1, etag: 'etag-one' }], parts: [{ part_number: 1, put_url: 'https://oss.example.test/part/1' }, { part_number: 2, put_url: 'https://oss.example.test/part/2' }] } })
      if (url.endsWith('/complete')) return Response.json({ lease_id: 'lease_12345678', state: 'ready', object_ref: 'object_12345678', expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.endsWith('/part/1')) throw new Error('completed part must only be read from source')
      uploadedPartTwo += 1
      expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(new Uint8Array([4, 5, 6]))
      return new Response(null, { status: 200, headers: { ETag: 'etag-two' } })
    },
  })
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])
  const ref = await client.uploadObjectStream(clientLeaseInput({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byte_size: bytes.byteLength, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }), () => new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); controller.enqueue(bytes.subarray(4)); controller.close() } }))
  expect(ref).toBe('object_12345678')
  expect(uploadedPartTwo).toBe(1)
})

test('Sidecar reuses a ready or bound deterministic lease after a local restart', async () => {
  let calls = 0
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token',
    fetchImpl: async (input) => {
      calls += 1
      if (String(input) !== 'https://relay.example.test/v1/video-media/object-leases') throw new Error(`unexpected request ${input}`)
      return Response.json({ lease_id: 'lease_12345678', state: calls === 1 ? 'ready' : 'bound', object_ref: 'object_12345678', expires_at: '2026-08-03T01:00:00.000Z' })
    },
  })
  const input = { local_operation_id: 'task_12345678', purpose: 'audio_for_asr' as const, content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }
  expect(await client.uploadObject(clientLeaseInput(input), new Uint8Array([1, 2, 3, 4]))).toBe('object_12345678')
  expect(await client.uploadObjectStream(clientLeaseInput(input), () => { throw new Error('ready/bound lease must not reread audio') })).toBe('object_12345678')
  expect(calls).toBe(2)
})

test('Relay recovers a multipart initialization committed before the OSS upload id was persisted', async () => {
  const dbPath = join(tmpdir(), `video-relay-init-recovery-${crypto.randomUUID()}.sqlite`)
  const objectStore: MediaObjectStore = {
    async createPutUrl() { throw new Error('single_put_not_expected') }, async head() { return null }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
    async createMultipartUpload() { return { uploadId: 'upload-created-before-crash' } },
    async findMultipartUploads() { return [{ uploadId: 'upload-recovered-after-crash', initiatedAt: '2026-08-03T00:00:00.000Z' }] },
    async createMultipartPartPutUrl(input) { return { put_url: `https://oss.example.test/part/${input.partNumber}` } }, async listMultipartParts() { return [] }, async completeMultipartUpload() {}, async abortMultipartUpload() {},
  }
  const env = { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath, VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(3 * 1024 * 1024) }
  const payload = { local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6 * 1024 * 1024, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }
  try {
    const first = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, now })
    const created = await first(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('init-recovery-lease-001'), body: JSON.stringify(payload) }))
    const lease = await created.json() as { lease_id: string }
    const db = new Database(dbPath); db.query("UPDATE video_media_leases_v1 SET multipart_upload_id=NULL,multipart_phase='initializing' WHERE id=?").run(lease.lease_id); db.close()
    const restarted = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, now })
    const resumed = await restarted(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('init-recovery-lease-001'), body: JSON.stringify(payload) }))
    expect(await resumed.json()).toMatchObject({ lease_id: lease.lease_id, multipart_upload: { upload_id: 'upload-recovered-after-crash' } })
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay deletes a completed-but-unverified multipart object and retries cleanup durably', async () => {
  let deletes = 0
  let aborts = 0
  const current = now()
  const objectStore: MediaObjectStore = {
    async createPutUrl() { throw new Error('single_put_not_expected') },
    async head() { return { byte_size: 1, content_hash: hash, content_type: 'video/mp4' } },
    async delete() { deletes += 1; if (deletes === 1) throw new Error('oss_delete_timeout') },
    async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
    async createMultipartUpload() { return { uploadId: 'upload-cleanup' } }, async createMultipartPartPutUrl() { return { put_url: 'https://oss.example.test/part' } },
    async listMultipartParts() { return [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] }, async completeMultipartUpload() {}, async abortMultipartUpload() { aborts += 1 },
  }
  const env = { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:', VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(3 * 1024 * 1024) }
  const handler = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, now: () => current })
  const payload = { local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6 * 1024 * 1024, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }
  const lease = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('cleanup-verify-lease-key'), body: JSON.stringify(payload) })).then(response => response.json()) as { lease_id: string }
  const completion = { parts: [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] }
  const failed = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('cleanup-verify-complete-key'), body: JSON.stringify(completion) }))
  expect(failed.status).toBe(503)
  expect(await failed.json()).toMatchObject({ error: 'multipart_object_cleanup_pending' })
  expect(deletes).toBe(1)
  expect(aborts).toBe(1)
  const retried = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}`, { method: 'DELETE', headers: headers('cleanup-verify-delete-key') }))
  expect(retried.status).toBe(204)
  expect(deletes).toBe(2)
  expect(aborts).toBe(1)
})

test('Relay persists natural multipart expiry as abort-before-delete and retries abort failures', async () => {
  const dbPath = join(tmpdir(), `video-relay-multipart-expiry-${crypto.randomUUID()}.sqlite`)
  let current = now()
  let aborts = 0
  const order: string[] = []
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: {} } },
    async head() { return null },
    async delete() { order.push('delete') },
    async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
    async createMultipartUpload() { return { uploadId: 'upload-expiring' } },
    async createMultipartPartPutUrl() { return { put_url: 'https://oss.example.test/part' } }, async listMultipartParts() { return [] }, async completeMultipartUpload() {},
    async abortMultipartUpload() { aborts += 1; order.push(`abort-${aborts}`); if (aborts === 1) throw new Error('temporary_abort_failure') },
  }
  const env = {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath,
    VIDEO_MEDIA_LEASE_TTL_MS: '60000', VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(3 * 1024 * 1024),
  }
  const multipart = { local_operation_id: 'task_expiring_multipart', purpose: 'proxy_video', content_hash: hash, byte_size: 6 * 1024 * 1024, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }
  const smallLease = (suffix: string) => ({ local_operation_id: `task_cleanup_trigger_${suffix}`, purpose: 'visual_frames', content_hash: hash, byte_size: 1, content_type: 'image/jpeg', consent_revision_id: 'consent_12345678', consent_scope_hash: hash })
  try {
    const handler = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, now: () => current })
    const created = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('multipart-expiry-create-key'), body: JSON.stringify(multipart) }))
    const lease = await created.json() as { lease_id: string }
    expect(created.status).toBe(201)
    current = new Date(current.getTime() + 60_001)
    expect((await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('multipart-expiry-trigger-one'), body: JSON.stringify(smallLease('one_12345678')) }))).status).toBe(201)
    expect(order).toEqual(['abort-1'])
    const db = new Database(dbPath)
    expect(db.query('SELECT phase,attempts,completed_at FROM video_media_object_cleanup_v1 WHERE object_kind=? AND lease_id=?').get('input', lease.lease_id))
      .toMatchObject({ phase: 'abort_pending', attempts: 1, completed_at: null })
    current = new Date(current.getTime() + 2_000)
    expect((await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('multipart-expiry-trigger-two'), body: JSON.stringify(smallLease('two_12345678')) }))).status).toBe(201)
    expect(order).toEqual(['abort-1', 'abort-2', 'delete'])
    expect(db.query('SELECT phase,completed_at FROM video_media_object_cleanup_v1 WHERE object_kind=? AND lease_id=?').get('input', lease.lease_id))
      .toMatchObject({ phase: 'active', completed_at: expect.any(String) })
    expect(db.query('SELECT state,multipart_phase FROM video_media_leases_v1 WHERE id=?').get(lease.lease_id)).toEqual({ state: 'deleted', multipart_phase: 'aborted' })
    db.close()
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay gives the physical DashScope account a versioned external key and migrates the legacy account ledger once', () => {
  const dbPath = join(tmpdir(), `video-relay-account-key-${crypto.randomUUID()}.sqlite`)
  const env = {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token,
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    VIDEO_MEDIA_RELAY_DB: dbPath,
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_REF: 'dashscope-prod-a',
    VIDEO_MEDIA_DASHSCOPE_ACCOUNT_BINDING_REVISION: '2026-08-04',
  }
  try {
    const legacy = new Database(dbPath)
    legacy.exec("CREATE TABLE video_media_quota_v1(owner TEXT NOT NULL, reservation_id TEXT NOT NULL, operation_id TEXT NOT NULL, state TEXT NOT NULL, units INTEGER NOT NULL, period TEXT NOT NULL, policy_revision TEXT NOT NULL, account_key TEXT NOT NULL, settled_units INTEGER NOT NULL DEFAULT 0, actual_usage_json TEXT, created_at TEXT NOT NULL, settled_at TEXT, PRIMARY KEY(owner,reservation_id))")
    legacy.query("INSERT INTO video_media_quota_v1(owner,reservation_id,operation_id,state,units,period,policy_revision,account_key,settled_units,actual_usage_json,created_at,settled_at) VALUES(?,?,?,'settled',1,'2026-08-03','legacy-v1','video-dashscope-account',1,NULL,?,NULL)")
      .run('owner-a', 'quota_legacy_account_123', 'operation_legacy_account_123', now().toISOString())
    legacy.close()

    expect(videoMediaCapacityPolicyFromEnvironment(env).account).toMatchObject({
      account_ref: 'dashscope-prod-a', binding_revision: '2026-08-04', account_key: 'video-dashscope-account:dashscope-prod-a:2026-08-04',
    })
    createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, now })
    const migrated = new Database(dbPath)
    expect(migrated.query('SELECT account_key FROM video_media_quota_v1 WHERE reservation_id=?').get('quota_legacy_account_123')).toEqual({ account_key: 'video-dashscope-account:dashscope-prod-a:2026-08-04' })
    migrated.close()

    createVideoMediaRelayFetch({ env: { ...env, VIDEO_MEDIA_DASHSCOPE_ACCOUNT_REF: 'dashscope-prod-b', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_BINDING_REVISION: '2026-08-05' }, fetchImpl: identityFetch, now })
    const afterRebind = new Database(dbPath)
    expect(afterRebind.query('SELECT account_key FROM video_media_quota_v1 WHERE reservation_id=?').get('quota_legacy_account_123')).toEqual({ account_key: 'video-dashscope-account:dashscope-prod-a:2026-08-04' })
    afterRebind.close()
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay recovers a publishing result from its durable bytes instead of sweeping a paid result', async () => {
  const dbPath = join(tmpdir(), `video-relay-result-publication-${crypto.randomUUID()}.sqlite`)
  const owner = 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:install_12345678'
  const resultBytes = new Map<string, Uint8Array>()
  const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'embedding', vectors: [] }))
  const resultHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const receipt: ProviderExecutionReceipt = { id: 'receipt_publication_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 1, input_bytes: 1, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString() }
  const objectStore: MediaObjectStore = {
    async createPutUrl() { throw new Error('not_needed') }, async head() { return null }, async delete() {}, async createReadUrl() { throw new Error('not_needed') },
    async putResult(input) { resultBytes.set(input.objectRef, input.body) },
    async headResult(ref) { const value = resultBytes.get(ref); return value ? { byte_size: value.byteLength, content_hash: `sha256:${createHash('sha256').update(value).digest('hex')}`, content_type: 'application/json' } : null },
    async createResultReadUrl(input) { return `https://result.example.test/${input.objectRef}` }, async deleteResult(ref) { resultBytes.delete(ref) },
  }
  try {
    const handler = createVideoMediaRelayFetch({ env: { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath }, fetchImpl: identityFetch, objectStore, now })
    const db = new Database(dbPath)
    const request = { local_operation_id: 'task_publication_12345678', consent_revision_id: 'consent_publication_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_publication_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'fact_publication_12345678', text: '恢复结果' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }
    db.query("INSERT INTO video_media_quota_v1(owner,reservation_id,operation_id,state,units,period,policy_revision,account_key,settled_units,actual_usage_json,created_at,settled_at) VALUES(?,?,?,'reserved',1,'2026-08-03','v1','video-dashscope-account:local-dashscope-account:local-v1',0,NULL,?,NULL)")
      .run(owner, 'quota_publication_12345678', 'remoteop_publication_12345678', now().toISOString())
    db.query("INSERT INTO video_media_operations_v1(id,owner,local_operation_id,idempotency_key,request_hash,request_json,state,provider_task_id,result_object_refs,provider_receipt,account_quota_reservation_id,safe_error_code,created_at,updated_at,acknowledged_at,submission_started_at) VALUES(?,?,?,?,?,?,'accepted',NULL,NULL,NULL,?,NULL,?,?,NULL,?)")
      .run('remoteop_publication_12345678', owner, request.local_operation_id, 'publication-key', hash, JSON.stringify(request), 'quota_publication_12345678', now().toISOString(), now().toISOString(), now().toISOString())
    db.query("INSERT INTO video_media_result_objects_v1(object_ref,operation_id,content_hash,byte_size,content_type,expires_at,acknowledged_at,state,publication_state,publication_provider_task_id,publication_receipt,publication_safe_error_code,payload) VALUES(?,?,?,?,'application/json',?,NULL,'publishing','succeeded',NULL,?,NULL,?)")
      .run('result_publication_12345678', 'remoteop_publication_12345678', resultHash, bytes.byteLength, '2026-08-03T00:15:00.000Z', JSON.stringify(receipt), Buffer.from(bytes))
    const response = await handler(new Request('http://relay/v1/video-media/operations/remoteop_publication_12345678', { headers: { Authorization: 'Bearer installation-token' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'succeeded', result_objects: [{ object_ref: 'result_publication_12345678' }] })
    expect(resultBytes.get('result_publication_12345678')).toEqual(bytes)
    expect(db.query('SELECT state,payload FROM video_media_result_objects_v1 WHERE object_ref=?').get('result_publication_12345678')).toEqual({ state: 'published', payload: null })
    db.close()
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay resumes a failed result PUT from the durable publication without repeating the Provider call', async () => {
  const dbPath = join(tmpdir(), `video-relay-result-put-recovery-${crypto.randomUUID()}.sqlite`)
  const resultBytes = new Map<string, Uint8Array>()
  let rejectWrites = true
  let executions = 0
  const receipt: ProviderExecutionReceipt = { id: 'receipt_result_put_recovery', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 1, input_bytes: 1, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString() }
  const objectStore: MediaObjectStore = {
    async createPutUrl() { throw new Error('not_needed') }, async head() { return null }, async delete() {}, async createReadUrl() { throw new Error('not_needed') },
    async putResult(input) { if (rejectWrites) throw new Error('oss_temporarily_unavailable'); resultBytes.set(input.objectRef, input.body) },
    async headResult(ref) { const value = resultBytes.get(ref); return value ? { byte_size: value.byteLength, content_hash: `sha256:${createHash('sha256').update(value).digest('hex')}`, content_type: 'application/json' } : null },
    async createResultReadUrl(input) { return `https://result.example.test/${input.objectRef}` }, async deleteResult(ref) { resultBytes.delete(ref) },
  }
  const provider: VideoMediaProvider = {
    async execute(input) {
      executions += 1
      return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [{ id: 'fact_result_put_recovery', vector: Array<number>(768).fill(0) }] } }
    },
  }
  const env = { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath }
  const operation = {
    local_operation_id: 'task_result_put_recovery', consent_revision_id: 'consent_result_put_recovery', consent_scope_hash: hash,
    local_budget_reservation_id: 'budget_result_put_recovery', request_hash: hash, capability: 'semantic_embedding' as const, application_role: 'search_index' as const,
    input: { embedding_role: 'document' as const, items: [{ id: 'fact_result_put_recovery', text: '持久化结果恢复' }], model: 'text-embedding-v4' as const, dimension: 768 as const, instruction_version: 'v1' },
  }
  try {
    const first = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, provider, now })
    const failed = await first(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('result-put-recovery-key'), body: JSON.stringify(operation) }))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: 'result_publication_pending' })
    const db = new Database(dbPath)
    const pending = db.query("SELECT id,state FROM video_media_operations_v1 WHERE local_operation_id=?").get(operation.local_operation_id) as { id: string; state: string }
    expect(pending.state).toBe('accepted')
    expect(db.query("SELECT state,payload FROM video_media_result_objects_v1 WHERE operation_id=?").get(pending.id)).toMatchObject({ state: 'publishing', payload: expect.any(Uint8Array) })
    db.close()

    rejectWrites = false
    const restarted = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, provider, now })
    const recovered = await restarted(new Request(`http://relay/v1/video-media/operations/${pending.id}`, { headers: { Authorization: 'Bearer installation-token' } }))
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ state: 'succeeded', result_objects: [{ object_ref: expect.any(String) }] })
    expect(executions).toBe(1)
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay persists a long-ASR task callback before a post-accept crash and recovers by poll only', async () => {
  const dbPath = join(tmpdir(), `video-relay-asr-callback-${crypto.randomUUID()}.sqlite`)
  const objectStore: MediaObjectStore = {
    async createPutUrl() { return { put_url: 'https://oss.example.test/put', required_headers: {} } }, async head() { return { byte_size: 4, content_hash: hash, content_type: 'audio/wav' } }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  const receipt: ProviderExecutionReceipt = { id: 'receipt_callback_12345678', capability: 'speech_transcription', model_snapshot: 'fun-asr', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 4, visual_frames: 0, proxy_seconds: 0, asr_seconds: 1, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString() }
  let executions = 0; let polls = 0
  const provider: VideoMediaProvider = {
    async execute(_input, _identity, _media, options) { executions += 1; await options?.onAccepted?.({ provider_task_id: 'provider_callback_12345678', receipt }); throw new Error('crash_after_task_callback') },
    async poll() { polls += 1; return { state: 'failed', provider_task_id: 'provider_callback_12345678', receipt, safe_error_code: 'asr_task_failed' } },
  }
  const env = { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: dbPath }
  try {
    const handler = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, provider, now })
    const lease = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('callback-lease-key'), body: JSON.stringify({ local_operation_id: 'task_callback_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_callback_12345678', consent_scope_hash: hash }) })).then(response => response.json()) as { lease_id: string }
    const ready = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('callback-complete-key'), body: '{}' })).then(response => response.json()) as { object_ref: string }
    const operation = { local_operation_id: 'task_callback_12345678', consent_revision_id: 'consent_callback_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_callback_12345678', request_hash: hash, capability: 'speech_transcription', application_role: 'asr', input: { mode: 'long_async', audio_object_ref: ready.object_ref, source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, hotwords: [], speaker_diarization: false, sentence_timestamps: true, word_timestamps: true } }
    expect((await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('callback-operation-key'), body: JSON.stringify(operation) }))).status).toBe(503)
    const db = new Database(dbPath)
    const row = db.query('SELECT id,state,provider_task_id FROM video_media_operations_v1 WHERE local_operation_id=?').get(operation.local_operation_id) as { id: string; state: string; provider_task_id: string }
    expect(row).toEqual({ id: expect.any(String), state: 'submitted', provider_task_id: 'provider_callback_12345678' })
    const restarted = createVideoMediaRelayFetch({ env, fetchImpl: identityFetch, objectStore, provider, now })
    expect(await restarted(new Request(`http://relay/v1/video-media/operations/${row.id}`, { headers: { Authorization: 'Bearer installation-token' } })).then(response => response.json())).toMatchObject({ state: 'failed', safe_error_code: 'asr_task_failed' })
    expect({ executions, polls }).toEqual({ executions: 1, polls: 1 })
    db.close()
  } finally { try { unlinkSync(dbPath) } catch {} }
})

test('Relay rejects a multipart lease whose signed URL response would exceed the control envelope', async () => {
  const handler = createVideoMediaRelayFetch({ env: {
    VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799', VIDEO_MEDIA_RELAY_DB: ':memory:',
    VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(1024 * 1024),
  }, fetchImpl: identityFetch, now })
  const response = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('multipart-control-cap-key'), body: JSON.stringify({ local_operation_id: 'task_multipart_control_cap', purpose: 'proxy_video', content_hash: hash, byte_size: 513 * 1024 * 1024, content_type: 'video/mp4', consent_revision_id: 'consent_multipart_control_cap', consent_scope_hash: hash }) }))
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ error: 'multipart_control_response_too_large' })
})
