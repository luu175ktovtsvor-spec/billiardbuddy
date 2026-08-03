import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { createVideoMediaRelayFetch, type MediaObjectStore, type VideoMediaProvider } from '../../video-media-relay/app.ts'
import type { ProviderExecutionReceipt } from '../../video-media-relay/contracts/relayApi.ts'
import { VideoMediaRelayClient } from '../src/server/video/infrastructure/providers/videoMediaRelayClient.ts'

const token = 'x'.repeat(40)
const hash = `sha256:${'a'.repeat(64)}`
const now = () => new Date('2026-08-03T00:00:00.000Z')
const headers = (key: string) => ({ Authorization: 'Bearer installation-token', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Request-Timestamp': new Date().toISOString() })
const identityFetch = async () => Response.json({ active: true, principal_id: 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', installation_id: 'install_12345678', session_id: 'session_123456789012345678', expires_at: Date.now() + 60_000, owner: 'installation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:install_12345678' })

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
  const handler = createVideoMediaRelayFetch({ env: { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async (input, init) => String(input).startsWith('https://result.example.test/') ? new Response(results.get(String(input).split('/').at(-1)!)!) : await identityFetch(input, init), objectStore, provider, now })
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
  const conflict = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('operation-idempotency-key-1'), body: JSON.stringify({ ...operation, local_operation_id: 'task_00000000' }) }))
  expect(conflict.status).toBe(409)
  const ack = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/ack`, { method: 'POST', headers: headers('ack-idempotency-key-0000001'), body: JSON.stringify({ result_hashes: [resultProjection.result_objects[0]!.content_hash], receipt_id: receipt.id }) }))
  expect(ack.status).toBe(204)
  expect(results.size).toBe(0)
  expect(ready.object_ref).toMatch(/^object_/)
})

test('Video Media Relay fails closed when Gateway introspection is unavailable', async () => {
  const handler = createVideoMediaRelayFetch({ env: { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: async () => { throw new Error('offline') }, now })
  const response = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('identity-idempotency-key-001'), body: JSON.stringify({ local_operation_id: 'task_12345678', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: 'identity_unavailable' })
})

test('Relay persists failed OSS result cleanup and retries it on the next authenticated request', async () => {
  let deleteAttempts = 0
  const objectStore: MediaObjectStore = {
    async createPutUrl() { return { put_url: 'https://oss.example.test/put', required_headers: {} } }, async head() { return null }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl(input) { return `https://oss.example.test/result/${input.objectRef}` },
    async deleteResult() { deleteAttempts += 1; if (deleteAttempts === 1) throw new Error('temporary_oss_delete_failure') },
  }
  const receipt: ProviderExecutionReceipt = { id: 'receipt_cleanup_12345678', capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute() { return { state: 'succeeded', receipt, result: { kind: 'embedding', vectors: [] } } } }
  let current = now()
  const handler = createVideoMediaRelayFetch({ env: { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: identityFetch, objectStore, provider, now: () => current })
  const operation = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('cleanup-operation-key-0001'), body: JSON.stringify({ local_operation_id: 'task_cleanup_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'embed_cleanup_12345678', text: '清理重试' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }) }))
  const projection = await operation.json() as { id: string; provider_receipt: { id: string }; result_objects: Array<{ content_hash: `sha256:${string}` }> }
  const acknowledged = await handler(new Request(`http://relay/v1/video-media/operations/${projection.id}/ack`, { method: 'POST', headers: headers('cleanup-ack-key-00000001'), body: JSON.stringify({ receipt_id: projection.provider_receipt.id, result_hashes: projection.result_objects.map(item => item.content_hash) }) }))
  expect(acknowledged.status).toBe(204)
  expect(deleteAttempts).toBe(1)
  current = new Date(current.getTime() + 2_000)
  const retryTrigger = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('cleanup-retry-lease-key'), body: JSON.stringify({ local_operation_id: 'task_cleanup_lease_0001', purpose: 'visual_frames', content_hash: hash, byte_size: 1, content_type: 'image/jpeg', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  expect(retryTrigger.status).toBe(201)
  expect(deleteAttempts).toBe(2)
})

test('Relay keeps a submitted long ASR task and only advances it through GET polling', async () => {
  const objectStore: MediaObjectStore = {
    async createPutUrl() { return { put_url: 'https://oss.example.test/put', required_headers: {} } }, async head() { return { byte_size: 4, content_hash: hash, content_type: 'audio/wav' } }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
  }
  let polls = 0
  const receipt: ProviderExecutionReceipt = { id: 'receipt_12345678', capability: 'speech_transcription', model_snapshot: 'fun-asr', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash, usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 10, estimated_amount_micros: 1 }, cache_hit: false, created_at: now().toISOString() }
  const provider: VideoMediaProvider = { async execute() { return { state: 'submitted', provider_task_id: 'provider-task-1', receipt } }, async poll() { polls += 1; return { state: 'failed', provider_task_id: 'provider-task-1', receipt, safe_error_code: 'asr_task_failed' } } }
  const handler = createVideoMediaRelayFetch({ env: { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:' }, fetchImpl: identityFetch, objectStore, provider, now })
  const leaseResponse = await handler(new Request('http://relay/v1/video-media/object-leases', { method: 'POST', headers: headers('long-asr-lease-key-001'), body: JSON.stringify({ local_operation_id: 'task_87654321', purpose: 'audio_for_asr', content_hash: hash, byte_size: 4, content_type: 'audio/wav', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }) }))
  const lease = await leaseResponse.json() as { lease_id: string }
  const completed = await handler(new Request(`http://relay/v1/video-media/object-leases/${lease.lease_id}/complete`, { method: 'POST', headers: headers('long-asr-complete-key-1'), body: '{}' }))
  const ready = await completed.json() as { object_ref: string }
  const operation = { local_operation_id: 'task_87654321', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'speech_transcription', application_role: 'asr', input: { mode: 'long_async', audio_object_ref: ready.object_ref, source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, hotwords: ['开球'], speaker_diarization: true, sentence_timestamps: true, word_timestamps: true } }
  const created = await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('long-asr-operation-key-1'), body: JSON.stringify(operation) }))
  expect(await created.json()).toMatchObject({ state: 'submitted', provider_task_id: 'provider-task-1' })
  const id = (await handler(new Request('http://relay/v1/video-media/operations', { method: 'POST', headers: headers('long-asr-operation-key-1'), body: JSON.stringify(operation) })).then(response => response.json())) as { id: string }
  const polled = await handler(new Request(`http://relay/v1/video-media/operations/${id.id}`, { headers: { Authorization: 'Bearer installation-token' } }))
  expect(await polled.json()).toMatchObject({ state: 'failed', safe_error_code: 'asr_task_failed' })
  expect(polls).toBe(1)
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
    GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:',
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
  const handler = createVideoMediaRelayFetch({ env: { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: ':memory:', VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(3 * 1024 * 1024) }, fetchImpl: identityFetch, objectStore, now })
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
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token', uploadRetries: 1,
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url === 'https://relay.example.test/v1/video-media/object-leases') return Response.json({
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
  const ref = await client.uploadObject({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: hash, byte_size: 6, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }, new Uint8Array([1, 2, 3, 4, 5, 6]))
  expect(ref).toBe('object_12345678')
  expect(partTwoAttempts).toBe(2)
  expect(completed).toEqual({ parts: [{ part_number: 1, etag: 'etag-one' }, { part_number: 2, etag: 'etag-two' }] })
})

test('Sidecar streams a large source by fixed parts without materializing cross-part chunks', async () => {
  let uploadedPartTwo = 0
  const client = new VideoMediaRelayClient({
    baseUrl: 'https://relay.example.test', accessToken: 'installation-token',
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
  const ref = await client.uploadObjectStream({ local_operation_id: 'task_12345678', purpose: 'proxy_video', content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byte_size: bytes.byteLength, content_type: 'video/mp4', consent_revision_id: 'consent_12345678', consent_scope_hash: hash }, () => new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 4)); controller.enqueue(bytes.subarray(4)); controller.close() } }))
  expect(ref).toBe('object_12345678')
  expect(uploadedPartTwo).toBe(1)
})

test('Relay recovers a multipart initialization committed before the OSS upload id was persisted', async () => {
  const dbPath = join(tmpdir(), `video-relay-init-recovery-${crypto.randomUUID()}.sqlite`)
  const objectStore: MediaObjectStore = {
    async createPutUrl() { throw new Error('single_put_not_expected') }, async head() { return null }, async delete() {}, async createReadUrl() { return 'https://oss.example.test/read' }, async putResult() {}, async createResultReadUrl() { return 'https://oss.example.test/result' }, async deleteResult() {},
    async createMultipartUpload() { return { uploadId: 'upload-created-before-crash' } },
    async findMultipartUploads() { return [{ uploadId: 'upload-recovered-after-crash', initiatedAt: '2026-08-03T00:00:00.000Z' }] },
    async createMultipartPartPutUrl(input) { return { put_url: `https://oss.example.test/part/${input.partNumber}` } }, async listMultipartParts() { return [] }, async completeMultipartUpload() {}, async abortMultipartUpload() {},
  }
  const env = { GW_VIDEO_MEDIA_INTROSPECTION_TOKEN: token, VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway', VIDEO_MEDIA_RELAY_DB: dbPath, VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: String(5 * 1024 * 1024), VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: String(3 * 1024 * 1024) }
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
