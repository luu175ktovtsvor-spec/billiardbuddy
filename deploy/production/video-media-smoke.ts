import { createHash, randomUUID } from 'node:crypto'

const base = (process.env.VIDEO_MEDIA_SMOKE_BASE_URL ?? 'https://zzyppz.cn/video-media').replace(/\/+$/, '')
const token = process.env.VIDEO_MEDIA_SMOKE_ACCESS_TOKEN?.trim()
if (!token || token.length < 16) throw new Error('VIDEO_MEDIA_SMOKE_ACCESS_TOKEN is required and is never persisted by this smoke tool')
if (new URL(base).protocol !== 'https:') throw new Error('VIDEO_MEDIA_SMOKE_BASE_URL must use HTTPS')

const requestId = () => randomUUID().replaceAll('-', '')
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const authHeaders = () => ({ Authorization: `Bearer ${token}` })
const control = async (path: string, method: 'POST' | 'DELETE', payload?: unknown): Promise<Response> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      'Idempotency-Key': `smoke_${requestId()}`,
      'X-Request-Timestamp': new Date().toISOString(),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`relay ${method} ${path} failed with ${response.status}`)
  return response
}
const readOperation = async (id: string): Promise<Operation> => {
  const response = await fetch(`${base}/v1/video-media/operations/${id}`, { headers: authHeaders(), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`relay GET operation failed with ${response.status}`)
  return await response.json() as Operation
}
const put = async (url: string, headers: Record<string, string> | undefined, bytes: Uint8Array): Promise<Response> => {
  let last: Response | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'PUT', headers, body: bytes, signal: AbortSignal.timeout(60_000) })
      if (response.ok) return response
      last = response
      if (response.status !== 408 && response.status !== 429 && response.status < 500) break
    } catch { /* repeat the immutable signed part */ }
  }
  throw new Error(`OSS PUT failed${last ? ` with ${last.status}` : ''}`)
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
const verifyAndAcknowledge = async (operation: Operation): Promise<unknown> => {
  if (operation.state !== 'succeeded' || !operation.provider_receipt || operation.result_objects?.length !== 1) throw new Error(`DashScope operation did not succeed (${operation.state})`)
  const resultObject = operation.result_objects[0]!
  const response = await fetch(resultObject.get_url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Relay result read failed with ${response.status}`)
  const result = new Uint8Array(await response.arrayBuffer())
  if (result.byteLength !== resultObject.byte_size || sha256(result) !== resultObject.content_hash) throw new Error('Relay result integrity check failed')
  const parsed = JSON.parse(new TextDecoder().decode(result))
  await control(`/v1/video-media/operations/${operation.id}/ack`, 'POST', { result_hashes: [resultObject.content_hash], receipt_id: operation.provider_receipt.id })
  return parsed
}

let multipartLease: Lease | undefined
let imageLease: Lease | undefined
let audioLease: Lease | undefined
try {
  // The relay control plane must reject unauthenticated callers, while the
  // Gateway-only introspection endpoint must remain unreachable on the public
  // origin. These checks create no lease and no provider request.
  const unauthenticated = await fetch(`${base}/v1/video-media/object-leases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30_000) })
  if (unauthenticated.status !== 401) throw new Error(`unauthenticated relay request returned ${unauthenticated.status}`)
  const publicIntrospection = await fetch(new URL('/gw/internal/v1/auth/introspect', base), { method: 'POST', signal: AbortSignal.timeout(30_000) })
  if (publicIntrospection.ok) throw new Error('Gateway introspection endpoint is publicly reachable')

  // Nine MiB exceeds the production default threshold and proves the LA-to-
  // Beijing multipart path without submitting arbitrary bytes to a model.
  const multipartBytes = new Uint8Array(9 * 1024 * 1024)
  const multipartConsent = { id: `consent_smoke_${requestId()}`, scopeHash: sha256(new TextEncoder().encode(requestId())) }
  multipartLease = await createLease(multipartBytes, 'application/octet-stream', 'proxy_video', multipartConsent)
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

  // A 16x16 valid PNG meets the minimum dimensions accepted by the visual
  // model while keeping the approved smoke cost minimal.
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR4nGNQqPj/nxLMMGrAaBiMpoP/wyQMAHDBlh/bs7UxAAAAAElFTkSuQmCC', 'base64')
  const operationSeed = requestId()
  const visualConsent = { id: `consent_smoke_${operationSeed}`, scopeHash: sha256(new TextEncoder().encode(`scope_${operationSeed}`)) }
  imageLease = await createLease(image, 'image/png', 'visual_frames', visualConsent)
  if (!imageLease.put_url) throw new Error('Relay did not issue an image PUT lease')
  if (!(await put(imageLease.put_url, imageLease.required_headers, image)).ok) throw new Error('image upload failed')
  const overwrite = await fetch(imageLease.put_url, { method: 'PUT', headers: imageLease.required_headers, body: image, signal: AbortSignal.timeout(30_000) })
  if (overwrite.status !== 412) throw new Error(`OSS immutable lease overwrite returned ${overwrite.status}`)
  const imageReady = await completeLease(imageLease)
  if (!imageReady.object_ref) throw new Error('Relay did not verify the image object')
  const visual = await (await control('/v1/video-media/operations', 'POST', {
    local_operation_id: `task_smoke_${operationSeed}`, consent_revision_id: visualConsent.id, consent_scope_hash: visualConsent.scopeHash, local_budget_reservation_id: `budget_smoke_${operationSeed}`,
    request_hash: sha256(image), capability: 'visual_evidence', application_role: 'shot_evidence',
    input: { object_refs: [imageReady.object_ref], evidence_window_id: `window_smoke_${operationSeed}`, facts_basis_hash: sha256(new TextEncoder().encode(`facts_${operationSeed}`)), language: 'zh', output_schema_version: 1 },
  })).json() as Operation
  const visualResult = await verifyAndAcknowledge(visual)
  if (!visualResult || typeof visualResult !== 'object') throw new Error('Qwen visual result is not JSON')

  const embeddingSeed = requestId()
  const embedding = await (await control('/v1/video-media/operations', 'POST', {
    local_operation_id: `task_smoke_embedding_${embeddingSeed}`, consent_revision_id: `consent_smoke_embedding_${embeddingSeed}`, consent_scope_hash: sha256(new TextEncoder().encode(`scope_embedding_${embeddingSeed}`)), local_budget_reservation_id: `budget_smoke_embedding_${embeddingSeed}`,
    request_hash: sha256(new TextEncoder().encode(`embedding_${embeddingSeed}`)), capability: 'semantic_embedding', application_role: 'search_index',
    input: { embedding_role: 'document', items: [{ id: `fact_smoke_embedding_${embeddingSeed}`, text: 'BilliardBuddy deployment smoke validates a real semantic embedding.' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'video-media-v1' },
  })).json() as Operation
  const embeddingResult = await verifyAndAcknowledge(embedding) as { kind?: string; vectors?: Array<{ vector?: unknown[] }> }
  if (embeddingResult.kind !== 'embedding' || embeddingResult.vectors?.[0]?.vector?.length !== 768) throw new Error('DashScope embedding result is not a 768-dimensional vector')

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
  const submittedAsr = await (await control('/v1/video-media/operations', 'POST', {
    local_operation_id: `task_smoke_asr_${asrSeed}`, consent_revision_id: asrConsent.id, consent_scope_hash: asrConsent.scopeHash, local_budget_reservation_id: `budget_smoke_asr_${asrSeed}`,
    request_hash: sha256(audio), capability: 'speech_transcription', application_role: 'asr',
    input: { mode: 'long_async', audio_object_ref: audioReady.object_ref, source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, language: 'en', hotwords: [], speaker_diarization: false, sentence_timestamps: true, word_timestamps: true },
  })).json() as Operation
  if (!['submitted', 'running'].includes(submittedAsr.state) || !submittedAsr.provider_task_id) throw new Error(`Fun-ASR did not accept an async task (${submittedAsr.state})`)
  const deadline = Date.now() + 180_000
  let asr: Operation = submittedAsr
  while (Date.now() < deadline && ['submitted', 'running'].includes(asr.state)) {
    await new Promise(resolve => setTimeout(resolve, 2_000))
    asr = await readOperation(submittedAsr.id)
  }
  const asrResult = await verifyAndAcknowledge(asr) as { kind?: string; text?: string }
  if (asrResult.kind !== 'asr' || !asrResult.text?.trim()) throw new Error('Fun-ASR did not return transcript text')
  console.log(`VIDEO_MEDIA_SMOKE_OK multipart_lease=${multipartLease.lease_id} qwen_receipt=${visual.provider_receipt!.id} embedding_receipt=${embedding.provider_receipt!.id} asr_receipt=${asr.provider_receipt!.id}`)
} finally {
  const cleanupErrors: Error[] = []
  for (const lease of [audioLease, imageLease, multipartLease]) {
    if (!lease) continue
    try { await deleteLease(lease.lease_id) } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error('unknown smoke cleanup failure')) }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'VIDEO_MEDIA_SMOKE_CLEANUP_FAILED')
}
