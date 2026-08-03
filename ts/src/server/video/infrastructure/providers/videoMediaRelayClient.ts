import { createHash } from 'node:crypto'
import {
  createMediaObjectLeaseRequestSchema,
  createVideoRelayOperationRequestSchema,
  mediaObjectLeaseSchema,
  operationAcknowledgementSchema,
  videoRelayOperationProjectionSchema,
  type CreateMediaObjectLeaseRequest,
  type MultipartUploadedPart,
  type CreateVideoRelayOperationRequest,
  type MediaObjectLease,
  type VideoRelayOperationProjection,
} from '../../../../../../video-media-relay/contracts/relayApi.ts'

export class VideoMediaRelayClientError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Sidecar-only Relay client. Renderer never receives its installation token. */
export class VideoMediaRelayClient {
  constructor(private readonly options: { baseUrl: string; accessToken: string; fetchImpl?: FetchLike; uploadTimeoutMs?: number; uploadRetries?: number }) {}

  private uploadTimeoutMs(): number { return Math.max(5_000, Math.min(5 * 60_000, this.options.uploadTimeoutMs ?? 30_000)) }
  private uploadRetries(): number { return Math.max(0, Math.min(5, this.options.uploadRetries ?? 3)) }
  private async pause(milliseconds: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, milliseconds)) }
  private async uploadWithRetry(target: () => Promise<{ put_url: string; required_headers?: Record<string, string> }>, bytes: Uint8Array): Promise<Response> {
    let last: Response | undefined
    for (let attempt = 0; attempt <= this.uploadRetries(); attempt += 1) {
      const upload = await target()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.uploadTimeoutMs())
      try {
        const response = await (this.options.fetchImpl ?? fetch)(upload.put_url, { method: 'PUT', headers: upload.required_headers, body: bytes as unknown as BodyInit, signal: controller.signal })
        if (response.ok) return response
        last = response
        if (![408, 429].includes(response.status) && response.status < 500) break
      } catch {
        // A cross-border TCP timeout has an unknown transfer outcome.  The
        // next signed PUT replaces only this immutable part; OSS multipart
        // state remains the source of truth on a later process restart.
      } finally { clearTimeout(timeout) }
      if (attempt < this.uploadRetries()) await this.pause(250 * (attempt + 1))
    }
    if (last) return last
    throw new VideoMediaRelayClientError(503, 'relay_upload_unavailable')
  }

  private async request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, idempotencyKey?: string): Promise<T> {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'Idempotency-Key': idempotencyKey ?? `video-${createHash('sha256').update(`${method}\0${path}\0${JSON.stringify(body)}`).digest('hex')}`, 'X-Request-Timestamp': new Date().toISOString() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 204) return undefined as T
    let payload: unknown
    try { payload = await response.json() } catch { throw new VideoMediaRelayClientError(502, 'relay_invalid_response') }
    if (!response.ok) throw new VideoMediaRelayClientError(response.status, typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : 'relay_unavailable')
    return payload as T
  }

  async createObjectLease(input: CreateMediaObjectLeaseRequest): Promise<MediaObjectLease> {
    const parsed = createMediaObjectLeaseRequestSchema.parse(input)
    return mediaObjectLeaseSchema.parse(await this.request('/v1/video-media/object-leases', 'POST', parsed, `lease-${parsed.local_operation_id}-${parsed.content_hash.slice(7, 31)}`))
  }
  /** Upload is intentionally a direct short-lived object URL transfer; no media
   * bytes are ever proxied through the Relay JSON server. */
  async uploadObject(input: CreateMediaObjectLeaseRequest, bytes: Uint8Array): Promise<string> {
    let lease = await this.createObjectLease(input)
    if (lease.multipart_upload) {
      const multipart = lease.multipart_upload
      const completed = new Map(multipart.uploaded_parts.map(part => [part.part_number, part.etag]))
      for (const part of multipart.parts) {
        if (completed.has(part.part_number)) continue
        const start = (part.part_number - 1) * multipart.part_size
        const end = Math.min(bytes.byteLength, start + multipart.part_size)
        if (start >= end) throw new VideoMediaRelayClientError(502, 'relay_upload_part_range_invalid')
        const response = await this.uploadWithRetry(async () => {
          const current = lease.multipart_upload?.parts.find(item => item.part_number === part.part_number)
          if (!current) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
          return current
        }, bytes.subarray(start, end))
        if (!response.ok) {
          // Refreshing with the same lease idempotency key enumerates the OSS
          // parts already committed before the timeout and re-signs only the
          // fixed object/part capability; it never creates a second object.
          lease = await this.createObjectLease(input)
          const replacement = lease.multipart_upload?.parts.find(item => item.part_number === part.part_number)
          if (!replacement) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
          const retried = await this.uploadWithRetry(async () => replacement, bytes.subarray(start, end))
          if (!retried.ok) throw new VideoMediaRelayClientError(503, 'relay_upload_rejected')
          const etag = retried.headers.get('etag')
          if (!etag) throw new VideoMediaRelayClientError(502, 'relay_upload_part_etag_missing')
          completed.set(part.part_number, etag)
          continue
        }
        const etag = response.headers.get('etag')
        if (!etag) throw new VideoMediaRelayClientError(502, 'relay_upload_part_etag_missing')
        completed.set(part.part_number, etag)
      }
      const parts: MultipartUploadedPart[] = [...completed.entries()].map(([part_number, etag]) => ({ part_number, etag })).sort((a, b) => a.part_number - b.part_number)
      const ready = await this.completeObjectLease(lease.lease_id, parts)
      if (!ready.object_ref) throw new VideoMediaRelayClientError(502, 'relay_upload_unverified')
      return ready.object_ref
    }
    if (!lease.put_url || !lease.required_headers) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
    const response = await this.uploadWithRetry(async () => ({ put_url: lease.put_url!, required_headers: lease.required_headers! }), bytes)
    if (!response.ok) throw new VideoMediaRelayClientError(503, 'relay_upload_rejected')
    const ready = await this.completeObjectLease(lease.lease_id)
    if (!ready.object_ref) throw new VideoMediaRelayClientError(502, 'relay_upload_unverified')
    return ready.object_ref
  }
  async completeObjectLease(leaseId: string, parts?: MultipartUploadedPart[]): Promise<MediaObjectLease> { return mediaObjectLeaseSchema.parse(await this.request(`/v1/video-media/object-leases/${encodeURIComponent(leaseId)}/complete`, 'POST', parts ? { parts } : {}, `complete-${leaseId}`)) }
  async createOperation(input: CreateVideoRelayOperationRequest): Promise<VideoRelayOperationProjection> { const parsed = createVideoRelayOperationRequestSchema.parse(input); return videoRelayOperationProjectionSchema.parse(await this.request('/v1/video-media/operations', 'POST', parsed, `operation-${parsed.local_operation_id}`)) }
  async operation(id: string): Promise<VideoRelayOperationProjection> { return videoRelayOperationProjectionSchema.parse(await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}`, 'GET')) }
  async downloadResult<T>(operation: VideoRelayOperationProjection): Promise<{ result: T; hashes: Array<`sha256:${string}`> }> {
    const objects = operation.result_objects
    const object = objects?.[0]
    if (!object || !objects || objects.length !== 1) throw new VideoMediaRelayClientError(409, 'relay_result_not_ready')
    let response: Response
    try { response = await (this.options.fetchImpl ?? fetch)(object.get_url) } catch { throw new VideoMediaRelayClientError(503, 'relay_result_unavailable') }
    if (!response.ok) throw new VideoMediaRelayClientError(503, 'relay_result_unavailable')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength !== object.byte_size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== object.content_hash) throw new VideoMediaRelayClientError(502, 'relay_result_integrity_failed')
    try { return { result: JSON.parse(new TextDecoder().decode(bytes)) as T, hashes: objects.map(item => item.content_hash as `sha256:${string}`) } } catch { throw new VideoMediaRelayClientError(502, 'relay_result_invalid') }
  }
  async cancel(id: string): Promise<VideoRelayOperationProjection> { return videoRelayOperationProjectionSchema.parse(await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}/cancel`, 'POST', {}, `cancel-${id}`)) }
  async acknowledge(id: string, input: { result_hashes: Array<`sha256:${string}`>; receipt_id: string }): Promise<void> { await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}/ack`, 'POST', operationAcknowledgementSchema.parse(input), `ack-${id}-${input.receipt_id}`) }
}

export function relayRequestHash(value: unknown): `sha256:${string}` { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` }
