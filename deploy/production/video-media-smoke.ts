import { createHash, randomUUID } from 'node:crypto'

const base = (process.env.VIDEO_MEDIA_SMOKE_BASE_URL ?? 'https://zzyppz.cn/video-media').replace(/\/+$/, '')
const token = process.env.VIDEO_MEDIA_SMOKE_ACCESS_TOKEN?.trim()
const confirmation = process.env.VIDEO_MEDIA_SMOKE_CONFIRMATION
const providerOperationLimit = process.env.VIDEO_MEDIA_SMOKE_MAX_PROVIDER_OPERATIONS
const uploadTimeoutMs = Number(process.env.VIDEO_MEDIA_SMOKE_UPLOAD_TIMEOUT_MS ?? 4 * 60_000)
if (!token || token.length < 16) throw new Error('VIDEO_MEDIA_SMOKE_ACCESS_TOKEN is required and is never persisted by this smoke tool')
if (confirmation !== 'FOUR_BILLED_VIDEO_OPERATIONS') throw new Error('VIDEO_MEDIA_SMOKE_CONFIRMATION must be FOUR_BILLED_VIDEO_OPERATIONS')
if (providerOperationLimit !== '4') throw new Error('VIDEO_MEDIA_SMOKE_MAX_PROVIDER_OPERATIONS must be exactly 4')
if (!Number.isSafeInteger(uploadTimeoutMs) || uploadTimeoutMs < 30_000 || uploadTimeoutMs > 5 * 60_000) throw new Error('VIDEO_MEDIA_SMOKE_UPLOAD_TIMEOUT_MS must be from 30000 to 300000')
if (new URL(base).protocol !== 'https:') throw new Error('VIDEO_MEDIA_SMOKE_BASE_URL must use HTTPS')

const requestId = () => randomUUID().replaceAll('-', '')
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const authHeaders = () => ({ Authorization: `Bearer ${token}` })
const maxProviderOperations = 4
let providerOperationAttempts = 0
const control = async (path: string, method: 'POST' | 'DELETE', payload?: unknown, idempotencyKey = `smoke_${requestId()}`): Promise<Response> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      'Idempotency-Key': idempotencyKey,
      'X-Request-Timestamp': new Date().toISOString(),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`relay ${method} ${path} failed with ${response.status}`)
  return response
}
const uncheckedControl = async (path: string, method: 'POST' | 'DELETE', payload?: unknown, idempotencyKey = `smoke_${requestId()}`): Promise<Response> => await fetch(`${base}${path}`, {
  method,
  headers: { ...authHeaders(), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), 'Idempotency-Key': idempotencyKey, 'X-Request-Timestamp': new Date().toISOString() },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30_000),
})
const readOperation = async (id: string): Promise<Operation> => {
  const response = await fetch(`${base}/v1/video-media/operations/${id}`, { headers: authHeaders(), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`relay GET operation failed with ${response.status}`)
  return await response.json() as Operation
}
const readOperationByLocalOperation = async (localOperationId: string): Promise<Operation | null> => {
  const response = await fetch(`${base}/v1/video-media/operations/by-local-operation/${encodeURIComponent(localOperationId)}`, {
    headers: authHeaders(), signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null }
  if (!response.ok) throw new Error(`relay GET local operation failed with ${response.status}`)
  return await response.json() as Operation
}
const put = async (url: string, headers: Record<string, string> | undefined, bytes: Uint8Array): Promise<Response> => {
  let response: Response
  try {
    // An aborted immutable PUT has an ambiguous outcome. The production
    // Sidecar reconciles it through HEAD/ListParts before retrying; this smoke
    // never blind-repeats the same capability merely to hide a slow link.
    response = await fetch(url, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(uploadTimeoutMs) })
  } catch { throw new Error('OSS PUT failed before a response was available') }
  if (!response.ok) throw new Error(`OSS PUT failed with ${response.status}`)
  return response
}

type Lease = {
  lease_id: string
  object_ref?: string
  put_url?: string
  required_headers?: Record<string, string>
  multipart_upload?: { part_size: number; parts: Array<{ part_number: number; put_url: string; required_headers?: Record<string, string> }>; uploaded_parts: Array<{ part_number: number; etag: string }> }
}
type Operation = { id: string; state: string; provider_task_id?: string; provider_receipt?: { id: string }; result_objects?: Array<{ get_url: string; content_hash: string; byte_size: number }> }
const createLease = async (bytes: Uint8Array, contentType: string, purpose: 'proxy_video' | 'visual_frames' | 'audio_for_asr', consent: { id: string; scopeHash: string }): Promise<Lease> => {
  const seed = requestId()
  const response = await control('/v1/video-media/object-leases', 'POST', {
    local_operation_id: `task_smoke_${seed}`, purpose, content_hash: sha256(bytes), byte_size: bytes.byteLength, content_type: contentType,
    consent_revision_id: consent.id, consent_scope_hash: consent.scopeHash,
  })
  return await response.json() as Lease
}
const completeLease = async (lease: Lease, parts?: Array<{ part_number: number; etag: string }>): Promise<Lease> => await (await control(`/v1/video-media/object-leases/${lease.lease_id}/complete`, 'POST', parts ? { parts } : {})).json() as Lease
const deleteLease = async (leaseId: string): Promise<void> => { await control(`/v1/video-media/object-leases/${leaseId}`, 'DELETE') }
const createOperation = async (payload: unknown, proveReplay = false): Promise<Operation> => {
  providerOperationAttempts += 1
  if (providerOperationAttempts > maxProviderOperations) throw new Error(`Video Relay smoke exceeded its ${maxProviderOperations}-operation billing boundary`)
  const key = `smoke_operation_${requestId()}`
  const first = await (await control('/v1/video-media/operations', 'POST', payload, key)).json() as Operation
  if (!proveReplay) return first
  const replay = await (await control('/v1/video-media/operations', 'POST', payload, key)).json() as Operation
  if (replay.id !== first.id || replay.provider_task_id !== first.provider_task_id || replay.provider_receipt?.id !== first.provider_receipt?.id) {
    throw new Error('Video Relay idempotent replay changed the durable provider operation')
  }
  return first
}
const verifyAndAcknowledge = async (operation: Operation): Promise<unknown> => {
  if (operation.state !== 'succeeded' || !operation.provider_receipt || operation.result_objects?.length !== 1) throw new Error(`DashScope operation did not succeed (${operation.state})`)
  const resultObject = operation.result_objects[0]!
  const response = await fetch(resultObject.get_url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Relay result read failed with ${response.status}`)
  const result = new Uint8Array(await response.arrayBuffer())
  if (result.byteLength !== resultObject.byte_size || sha256(result) !== resultObject.content_hash) throw new Error('Relay result integrity check failed')
  const parsed = JSON.parse(new TextDecoder().decode(result))
  const acknowledgement = { result_hashes: [resultObject.content_hash], receipt_id: operation.provider_receipt.id }
  const acknowledgementKey = `smoke_ack_${requestId()}`
  await control(`/v1/video-media/operations/${operation.id}/ack`, 'POST', acknowledgement, acknowledgementKey)
  await control(`/v1/video-media/operations/${operation.id}/ack`, 'POST', acknowledgement, acknowledgementKey)
  const afterAck = await readOperation(operation.id)
  if (afterAck.result_objects?.length) throw new Error('Video Relay still projected result objects after acknowledgement')
  const cleanupDeadline = Date.now() + 30_000
  let cleaned = false
  while (Date.now() < cleanupDeadline) {
    const removed = await fetch(resultObject.get_url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
    if (removed && [403, 404, 410].includes(removed.status)) { cleaned = true; break }
    if (removed?.ok) await removed.body?.cancel().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  if (!cleaned) throw new Error('Video Relay did not remove acknowledged result bytes')
  return parsed
}

let multipartLease: Lease | undefined
let imageLease: Lease | undefined
let audioLease: Lease | undefined
let asrOperation: Operation | undefined
let asrLocalOperationId: string | undefined
let successSummary: string | undefined
let primaryError: unknown
try {
  // The relay control plane must reject unauthenticated callers, while the
  // Gateway-only introspection endpoint must remain unreachable on the public
  // origin. These checks create no lease and no provider request.
  const unauthenticated = await fetch(`${base}/v1/video-media/object-leases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30_000) })
  if (unauthenticated.status !== 401) throw new Error(`unauthenticated relay request returned ${unauthenticated.status}`)
  const unauthenticatedPayload = await unauthenticated.text()
  if (unauthenticatedPayload.includes(token)) throw new Error('relay authentication response leaked its bearer token')
  const rejectedBearer = await fetch(`${base}/v1/video-media/object-leases`, { method: 'POST', headers: { Authorization: 'Bearer definitely-not-a-valid-installation-token', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30_000) })
  if (![401, 403].includes(rejectedBearer.status)) throw new Error(`invalid bearer returned ${rejectedBearer.status}`)
  const publicIntrospection = await fetch(new URL('/gw/internal/v1/auth/introspect', base), { method: 'POST', signal: AbortSignal.timeout(30_000) })
  const publicIntrospectionStatus = publicIntrospection.status
  await publicIntrospection.body?.cancel().catch(() => {})
  if (publicIntrospectionStatus !== 404) throw new Error(`Gateway introspection endpoint must be public 404, got ${publicIntrospectionStatus}`)

  // Quota ceilings are an external deployment policy, so a live smoke must not
  // assume a fixed lease count or manufacture N temporary objects to exhaust
  // the configured entitlement. Deterministic repository tests prove quota
  // rejection. Here we prove schema/purpose rejection before any OSS URL is
  // signed; the real multipart flow below proves lease lifecycle cleanup.
  const quotaBytes = new Uint8Array([1, 2, 3, 4])
  const quotaConsent = { id: `consent_smoke_quota_${requestId()}`, scopeHash: sha256(new TextEncoder().encode(requestId())) }
  const purposeRejected = await uncheckedControl('/v1/video-media/object-leases', 'POST', {
    local_operation_id: `task_smoke_purpose_${requestId()}`, purpose: 'audio_for_asr', content_hash: sha256(quotaBytes), byte_size: quotaBytes.byteLength, content_type: 'image/png', consent_revision_id: quotaConsent.id, consent_scope_hash: quotaConsent.scopeHash,
  })
  if (purposeRejected.status !== 422) throw new Error(`purpose/MIME rejection returned ${purposeRejected.status}`)

  // Seventeen MiB exceeds the production 8 MiB threshold and 16 MiB part size,
  // proving a real two-part LA-to-Beijing upload without sending these neutral
  // bytes to a model.
  const multipartBytes = new Uint8Array(17 * 1024 * 1024)
  const multipartConsent = { id: `consent_smoke_${requestId()}`, scopeHash: sha256(new TextEncoder().encode(requestId())) }
  multipartLease = await createLease(multipartBytes, 'video/mp4', 'proxy_video', multipartConsent)
  if (!multipartLease.multipart_upload) throw new Error('Relay did not issue a multipart upload lease')
  const uploaded = new Map(multipartLease.multipart_upload.uploaded_parts.map(part => [part.part_number, part.etag]))
  for (const part of multipartLease.multipart_upload.parts) {
    if (uploaded.has(part.part_number)) continue
    const start = (part.part_number - 1) * multipartLease.multipart_upload.part_size
    const response = await put(part.put_url, part.required_headers, multipartBytes.subarray(start, Math.min(multipartBytes.byteLength, start + multipartLease.multipart_upload.part_size)))
    const etag = response.headers.get('etag')
    if (!etag) throw new Error('OSS multipart response omitted ETag')
    uploaded.set(part.part_number, etag)
  }
  await completeLease(multipartLease, [...uploaded.entries()].map(([part_number, etag]) => ({ part_number, etag })).sort((a, b) => a.part_number - b.part_number))
  await deleteLease(multipartLease.lease_id); multipartLease = undefined

  // A 16x16 valid PNG meets the minimum dimensions accepted by the visual
  // model while keeping the approved smoke cost minimal.
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR4nGNQqPj/nxLMMGrAaBiMpoP/wyQMAHDBlh/bs7UxAAAAAElFTkSuQmCC', 'base64')
  const operationSeed = requestId()
  const visualConsent = { id: `consent_smoke_${operationSeed}`, scopeHash: sha256(new TextEncoder().encode(`scope_${operationSeed}`)) }
  imageLease = await createLease(image, 'image/png', 'visual_frames', visualConsent)
  if (!imageLease.put_url) throw new Error('Relay did not issue an image PUT lease')
  if (!(await put(imageLease.put_url, imageLease.required_headers, image)).ok) throw new Error('image upload failed')
  const overwrite = await fetch(imageLease.put_url, { method: 'PUT', headers: imageLease.required_headers, body: image, signal: AbortSignal.timeout(30_000) })
  if (overwrite.status !== 409) throw new Error(`OSS immutable lease overwrite returned ${overwrite.status}`)
  const imageReady = await completeLease(imageLease)
  if (!imageReady.object_ref) throw new Error('Relay did not verify the image object')
  const visualRequest = {
    local_operation_id: `task_smoke_${operationSeed}`, consent_revision_id: visualConsent.id, consent_scope_hash: visualConsent.scopeHash, local_budget_reservation_id: `budget_smoke_${operationSeed}`,
    request_hash: sha256(image), capability: 'visual_evidence', application_role: 'shot_evidence',
    input: { object_refs: [imageReady.object_ref], evidence_window_id: `window_smoke_${operationSeed}`, facts_basis_hash: sha256(new TextEncoder().encode(`facts_${operationSeed}`)), language: 'zh', output_schema_version: 1 },
  }
  const visual = await createOperation(visualRequest, true)
  const visualResult = await verifyAndAcknowledge(visual)
  if (!visualResult || typeof visualResult !== 'object') throw new Error('Qwen visual result is not JSON')
  await deleteLease(imageLease.lease_id); imageLease = undefined

  const embeddingSeed = requestId()
  const embedding = await createOperation({
    local_operation_id: `task_smoke_embedding_${embeddingSeed}`, consent_revision_id: `consent_smoke_embedding_${embeddingSeed}`, consent_scope_hash: sha256(new TextEncoder().encode(`scope_embedding_${embeddingSeed}`)), local_budget_reservation_id: `budget_smoke_embedding_${embeddingSeed}`,
    request_hash: sha256(new TextEncoder().encode(`embedding_${embeddingSeed}`)), capability: 'semantic_embedding', application_role: 'search_index',
    input: { embedding_role: 'document', items: [{ id: `fact_smoke_embedding_${embeddingSeed}`, text: 'BilliardBuddy deployment smoke validates a real semantic embedding.' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'video-media-v1' },
  })
  const embeddingResult = await verifyAndAcknowledge(embedding) as { kind?: string; vectors?: Array<{ vector?: unknown[] }> }
  if (embeddingResult.kind !== 'embedding' || embeddingResult.vectors?.[0]?.vector?.length !== 768) throw new Error('DashScope embedding result is not a 768-dimensional vector')

  const planningSeed = requestId()
  const planning = await createOperation({
    local_operation_id: `task_smoke_planning_${planningSeed}`, consent_revision_id: `consent_smoke_planning_${planningSeed}`, consent_scope_hash: sha256(new TextEncoder().encode(`scope_planning_${planningSeed}`)), local_budget_reservation_id: `budget_smoke_planning_${planningSeed}`,
    request_hash: sha256(new TextEncoder().encode(`planning_${planningSeed}`)), capability: 'media_reasoning', application_role: 'planning',
    input: { object_refs: [], facts_basis_hash: sha256(new TextEncoder().encode(`facts_planning_${planningSeed}`)), evidence: [{ id: `fact_smoke_planning_${planningSeed}`, kind: 'transcript', text: '选取开球后母球走位清晰且击球动作完整的片段。', confidence: 0.9 }], language: 'zh', output_schema_version: 1 },
  })
  const planningResult = await verifyAndAcknowledge(planning) as { kind?: string; plan?: unknown }
  if (planningResult.kind !== 'planning' || !planningResult.plan || typeof planningResult.plan !== 'object') throw new Error('Qwen planning result is not JSON')

  // This is DashScope's public, immutable welcome sample, downloaded only by
  // the controlled smoke tool and re-uploaded through the private OSS lease.
  const asrFixture = await fetch('https://dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3', { signal: AbortSignal.timeout(30_000) })
  if (!asrFixture.ok) throw new Error(`DashScope ASR fixture download failed with ${asrFixture.status}`)
  const audio = new Uint8Array(await asrFixture.arrayBuffer())
  if (audio.byteLength < 4_096 || audio.byteLength > 2 * 1024 * 1024) throw new Error('DashScope ASR fixture size is outside the smoke budget')
  const asrSeed = requestId()
  const asrConsent = { id: `consent_smoke_asr_${asrSeed}`, scopeHash: sha256(new TextEncoder().encode(`scope_asr_${asrSeed}`)) }
  audioLease = await createLease(audio, 'audio/mpeg', 'audio_for_asr', asrConsent)
  if (!audioLease.put_url) throw new Error('Relay did not issue an audio PUT lease')
  if (!(await put(audioLease.put_url, audioLease.required_headers, audio)).ok) throw new Error('audio upload failed')
  const audioReady = await completeLease(audioLease)
  if (!audioReady.object_ref) throw new Error('Relay did not verify the ASR audio object')
  asrLocalOperationId = `task_smoke_asr_${asrSeed}`
  const submittedAsr = await createOperation({
    local_operation_id: asrLocalOperationId, consent_revision_id: asrConsent.id, consent_scope_hash: asrConsent.scopeHash, local_budget_reservation_id: `budget_smoke_asr_${asrSeed}`,
    request_hash: sha256(audio), capability: 'speech_transcription', application_role: 'asr',
    input: { mode: 'long_async', audio_object_ref: audioReady.object_ref, source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, language: 'en', hotwords: [], speaker_diarization: false, sentence_timestamps: true, word_timestamps: true },
  })
  asrOperation = submittedAsr
  if (!['submitted', 'running'].includes(submittedAsr.state) || !submittedAsr.provider_task_id) throw new Error(`Fun-ASR did not accept an async task (${submittedAsr.state})`)
  // Account/owner quota rejection is proven by deterministic repository tests.
  // A live smoke must not manufacture thousands of paid embedding inputs merely
  // to exhaust an operator-selected entitlement profile.
  const deadline = Date.now() + 180_000
  let asr: Operation = submittedAsr
  while (Date.now() < deadline && ['submitted', 'running'].includes(asr.state)) {
    await new Promise(resolve => setTimeout(resolve, 2_000))
    asr = await readOperation(submittedAsr.id)
  }
  asrOperation = asr
  const asrResult = await verifyAndAcknowledge(asr) as { kind?: string; text?: string }
  if (asrResult.kind !== 'asr' || !asrResult.text?.trim()) throw new Error('Fun-ASR did not return transcript text')
  await deleteLease(audioLease.lease_id); audioLease = undefined
  if (providerOperationAttempts !== maxProviderOperations) throw new Error(`Video Relay smoke executed ${providerOperationAttempts} provider operations instead of ${maxProviderOperations}`)
  successSummary = `VIDEO_MEDIA_SMOKE_OK qwen_visual_receipt=${visual.provider_receipt!.id} qwen_planning_receipt=${planning.provider_receipt!.id} embedding_receipt=${embedding.provider_receipt!.id} asr_receipt=${asr.provider_receipt!.id}`
} catch (error) {
  primaryError = error
} finally {
  const cleanupErrors: Error[] = []
  let retainAudioLease = false
  if (!asrOperation && asrLocalOperationId) {
    try {
      const recoveryDeadline = Date.now() + 30_000
      do {
        asrOperation = await readOperationByLocalOperation(asrLocalOperationId)
        if (asrOperation) break
        if (Date.now() < recoveryDeadline) await new Promise(resolve => setTimeout(resolve, 1_000))
      } while (Date.now() < recoveryDeadline)
    } catch (error) {
      retainAudioLease = true
      cleanupErrors.push(error instanceof Error ? error : new Error('unknown ASR local-operation recovery failure'))
    }
  }
  if (asrOperation && ['submitted', 'running'].includes(asrOperation.state)) {
    try {
      const cancel = await uncheckedControl(`/v1/video-media/operations/${asrOperation.id}/cancel`, 'POST', {}, `smoke_cancel_${requestId()}`)
      if (cancel.ok) {
        asrOperation = await cancel.json() as Operation
      } else {
        await cancel.body?.cancel().catch(() => {})
        if (cancel.status !== 409) throw new Error(`Video Relay ASR cleanup cancel failed with ${cancel.status}`)
      }
      const recoveryDeadline = Date.now() + 60_000
      while (Date.now() < recoveryDeadline && ['submitted', 'running'].includes(asrOperation.state)) {
        await new Promise(resolve => setTimeout(resolve, 2_000))
        asrOperation = await readOperation(asrOperation.id)
      }
      if (asrOperation.state === 'succeeded') await verifyAndAcknowledge(asrOperation)
      else if (!['failed', 'cancelled', 'expired'].includes(asrOperation.state)) {
        retainAudioLease = true
        throw new Error(`Video Relay ASR cleanup remained indeterminate (${asrOperation.state})`)
      }
    } catch (error) {
      retainAudioLease = true
      cleanupErrors.push(error instanceof Error ? error : new Error('unknown ASR operation cleanup failure'))
    }
  }
  for (const lease of [audioLease, imageLease, multipartLease]) {
    if (!lease) continue
    if (retainAudioLease && lease === audioLease) continue
    try { await deleteLease(lease.lease_id) } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error('unknown smoke cleanup failure')) }
  }
  if (cleanupErrors.length) {
    throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, 'VIDEO_MEDIA_SMOKE_CLEANUP_FAILED')
  }
}
if (primaryError) throw primaryError
if (!successSummary) throw new Error('Video Relay smoke completed without a success summary')
console.log(successSummary)
