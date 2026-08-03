import { createHash } from 'node:crypto'
import {
  createMediaObjectLeaseRequestSchema,
  createVideoRelayOperationRequestSchema,
  mediaObjectLeaseSchema,
  operationAcknowledgementSchema,
  videoRelayOperationProjectionSchema,
  type CreateMediaObjectLeaseRequest,
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
  constructor(private readonly options: { baseUrl: string; accessToken: string; fetchImpl?: FetchLike }) {}

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
    const lease = await this.createObjectLease(input)
    if (!lease.put_url || !lease.required_headers) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
    let response: Response
    try { response = await (this.options.fetchImpl ?? fetch)(lease.put_url, { method: 'PUT', headers: lease.required_headers, body: bytes as unknown as BodyInit }) } catch { throw new VideoMediaRelayClientError(503, 'relay_upload_unavailable') }
    if (!response.ok) throw new VideoMediaRelayClientError(503, 'relay_upload_rejected')
    const ready = await this.completeObjectLease(lease.lease_id)
    if (!ready.object_ref) throw new VideoMediaRelayClientError(502, 'relay_upload_unverified')
    return ready.object_ref
  }
  async completeObjectLease(leaseId: string): Promise<MediaObjectLease> { return mediaObjectLeaseSchema.parse(await this.request(`/v1/video-media/object-leases/${encodeURIComponent(leaseId)}/complete`, 'POST', {}, `complete-${leaseId}`)) }
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
