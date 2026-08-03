import { expect, test } from 'bun:test'
import { createVideoMediaRelayFetch, type MediaObjectStore, type VideoMediaProvider } from '../../video-media-relay/app.ts'
import type { ProviderExecutionReceipt } from '../../video-media-relay/contracts/relayApi.ts'

const token = 'x'.repeat(40)
const hash = `sha256:${'a'.repeat(64)}`
const now = () => new Date('2026-08-03T00:00:00.000Z')
const headers = (key: string) => ({ Authorization: 'Bearer installation-token', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Request-Timestamp': new Date().toISOString() })
const identityFetch = async () => Response.json({ active: true, principal_id: 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', installation_id: 'install_12345678', session_id: 'session_123456789012345678', expires_at: Date.now() + 60_000, owner: 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:install_12345678' })

test('Video Media Relay enforces introspected identity, lease verification, idempotency and ACK', async () => {
  const uploaded = new Map<string, { byte_size: number; content_hash: string; content_type: string }>()
  const objectStore: MediaObjectStore = {
    async createPutUrl(input) { uploaded.set(input.leaseId, { byte_size: input.byteSize, content_hash: input.hash, content_type: input.contentType }); return { put_url: `https://oss.example.test/${input.leaseId}`, required_headers: { 'Content-Type': input.contentType } } },
    async head(leaseId) { return uploaded.get(leaseId) ?? null }, async delete(leaseId) { uploaded.delete(leaseId) },
  }
  const receipt: ProviderExecutionReceipt = { id: 'receipt_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 2, input_bytes: 4, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute() { return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [] } } } }
  const handler = createVideoMediaRelayFetch({ env: { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: identityFetch, objectStore, provider, now })
  const create = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('lease-idempotency-key-0001'), body: JSON.stringify({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  expect(create.status).toBe(201)
  const lease = await create.json() as { lease_id: string }
  const complete = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('complete-idempotency-key-001'), body: '{}' }))
  expect(complete.status).toBe(200)
  const ready = await complete.json() as { object_ref: string }
  const operation = { local_operation_id: 'task_87654321', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'document', items: [{ id: 'fact_12345678', text: '一杆进球' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }
  const first = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-idempotency-key-1'), body: JSON.stringify(operation) }))
  expect(first.status).toBe(202)
  const projection = await first.json() as { id: string; state: string }
  expect(projection.state).toBe('succeeded')
  const replay = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-idempotency-key-1'), body: JSON.stringify(operation) }))
  expect(replay.status).toBe(200)
  expect((await replay.json() as { id: string }).id).toBe(projection.id)
  const result = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/result`, { headers: { Authorization: 'Bearer installation-token' } }))
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({ kind: 'embedding' })
  const conflict = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-idempotency-key-1'), body: JSON.stringify({ ...operation, local_operation_id: 'task_00000000' }) }))
  expect(conflict.status).toBe(409)
  const ack = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/ack`, { method: 'POST', headers: headers('ack-idempotency-key-0000001'), body: JSON.stringify({ result_hashes: [], receipt_id: receipt.id }) }))
  expect(ack.status).toBe(204)
  expect(ready.object_ref).toMatch(/^object_/)
})

test('Video Media Relay fails closed when Gateway introspection is unavailable', async () => {
  const handler = createVideoMediaRelayFetch({ env: { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async () => { throw new Error('offline') }, now })
  const response = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('identity-idempotency-key-001'), body: JSON.stringify({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: 'identity_unavailable' })
})
