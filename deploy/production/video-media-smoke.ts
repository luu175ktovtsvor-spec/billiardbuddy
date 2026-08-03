import { createHash, randomUUID } from 'node:crypto'

const base = (process.env.VIDEO_MEDIA_SMOKE_BASE_URL ?? 'https://zzyppz.cn/video-media').replace(/\/+$/, '')
const token = process.env.VIDEO_MEDIA_SMOKE_ACCESS_TOKEN?.trim()
if (!token || token.length < 16) throw new Error('VIDEO_MEDIA_SMOKE_ACCESS_TOKEN is required and is never persisted by this smoke tool')
if (new URL(base).protocol !== 'https:') throw new Error('VIDEO_MEDIA_SMOKE_BASE_URL must use HTTPS')

const requestId = () => randomUUID().replaceAll('-', '')
const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const control = async (path: string, method: 'POST' | 'DELETE', payload?: unknown): Promise<Response> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
const createLease = async (bytes: Uint8Array, contentType: string, purpose: 'proxy_video' | 'visual_frames', consent: { id: string; scopeHash: string }): Promise<Lease> => {
  const seed = requestId()
  const response = await control('/v1/video-media/object-leases', 'POST', {
    local_operation_id: `task_smoke_${seed}`, purpose, content_hash: sha256(bytes), byte_size: bytes.byteLength, content_type: contentType,
    consent_revision_id: consent.id, consent_scope_hash: consent.scopeHash,
  })
  return await response.json() as Lease
}
const completeLease = async (lease: Lease, parts?: Array<{ part_number: number; etag: string }>): Promise<Lease> => await (await control(`/v1/video-media/object-leases/${lease.lease_id}/complete`, 'POST', parts ? { parts } : {})).json() as Lease
const deleteLease = async (leaseId: string): Promise<void> => { await control(`/v1/video-media/object-leases/${leaseId}`, 'DELETE') }

let multipartLease: Lease | undefined
let imageLease: Lease | undefined
try {
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

  // A tiny valid PNG makes DashScope fetch an OSS signed URL and return an
  // actual provider receipt, while keeping the approved smoke cost minimal.
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6TAAAAABJRU5ErkJggg==', 'base64')
  const operationSeed = requestId()
  const visualConsent = { id: `consent_smoke_${operationSeed}`, scopeHash: sha256(new TextEncoder().encode(`scope_${operationSeed}`)) }
  imageLease = await createLease(image, 'image/png', 'visual_frames', visualConsent)
  if (!imageLease.put_url) throw new Error('Relay did not issue an image PUT lease')
  if (!(await put(imageLease.put_url, imageLease.required_headers, image)).ok) throw new Error('image upload failed')
  const imageReady = await completeLease(imageLease)
  if (!imageReady.object_ref) throw new Error('Relay did not verify the image object')
  const operation = await (await control('/v1/video-media/operations', 'POST', {
    local_operation_id: `task_smoke_${operationSeed}`, consent_revision_id: visualConsent.id, consent_scope_hash: visualConsent.scopeHash, local_budget_reservation_id: `budget_smoke_${operationSeed}`,
    request_hash: sha256(image), capability: 'visual_evidence', application_role: 'shot_evidence',
    input: { object_refs: [imageReady.object_ref], evidence_window_id: `window_smoke_${operationSeed}`, facts_basis_hash: sha256(new TextEncoder().encode(`facts_${operationSeed}`)), language: 'zh', output_schema_version: 1 },
  })).json() as { id: string; state: string; provider_receipt?: { id: string }; result_objects?: Array<{ get_url: string; content_hash: string; byte_size: number }> }
  if (operation.state !== 'succeeded' || !operation.provider_receipt || operation.result_objects?.length !== 1) throw new Error(`DashScope visual smoke did not succeed (${operation.state})`)
  const resultObject = operation.result_objects[0]!
  const result = new Uint8Array(await (await fetch(resultObject.get_url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer())
  if (result.byteLength !== resultObject.byte_size || sha256(result) !== resultObject.content_hash) throw new Error('Relay result integrity check failed')
  JSON.parse(new TextDecoder().decode(result))
  await control(`/v1/video-media/operations/${operation.id}/ack`, 'POST', { result_hashes: [resultObject.content_hash], receipt_id: operation.provider_receipt.id })
  console.log(`VIDEO_MEDIA_SMOKE_OK multipart_lease=${multipartLease.lease_id} receipt=${operation.provider_receipt.id}`)
} finally {
  const cleanupErrors: Error[] = []
  for (const lease of [imageLease, multipartLease]) {
    if (!lease) continue
    try { await deleteLease(lease.lease_id) } catch (error) { cleanupErrors.push(error instanceof Error ? error : new Error('unknown smoke cleanup failure')) }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'VIDEO_MEDIA_SMOKE_CLEANUP_FAILED')
}
