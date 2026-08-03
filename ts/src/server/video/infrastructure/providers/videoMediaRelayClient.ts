import { createHash, randomUUID } from 'node:crypto'
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

  private async request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'Idempotency-Key': `video-${randomUUID().replaceAll('-', '')}`, 'X-Request-Timestamp': new Date().toISOString() }),
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
    return mediaObjectLeaseSchema.parse(await this.request('/v1/video-media/object-leases', 'POST', createMediaObjectLeaseRequestSchema.parse(input)))
  }
  async completeObjectLease(leaseId: string): Promise<MediaObjectLease> { return mediaObjectLeaseSchema.parse(await this.request(`/v1/video-media/object-leases/${encodeURIComponent(leaseId)}/complete`, 'POST', {})) }
  async createOperation(input: CreateVideoRelayOperationRequest): Promise<VideoRelayOperationProjection> { return videoRelayOperationProjectionSchema.parse(await this.request('/v1/video-media/operations', 'POST', createVideoRelayOperationRequestSchema.parse(input))) }
  async operation(id: string): Promise<VideoRelayOperationProjection> { return videoRelayOperationProjectionSchema.parse(await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}`, 'GET')) }
  async cancel(id: string): Promise<VideoRelayOperationProjection> { return videoRelayOperationProjectionSchema.parse(await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}/cancel`, 'POST', {})) }
  async acknowledge(id: string, input: { result_hashes: Array<`sha256:${string}`>; receipt_id: string }): Promise<void> { await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}/ack`, 'POST', operationAcknowledgementSchema.parse(input)) }
}

export function relayRequestHash(value: unknown): `sha256:${string}` { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` }
