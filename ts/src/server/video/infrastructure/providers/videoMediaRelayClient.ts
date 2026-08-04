import { createHash } from 'node:crypto'
import {
  VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES,
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

/** Control-plane JSON is deliberately small. Larger model outputs must use a
 * result object, whose declared bytes are independently capped below. */
const DEFAULT_CONTROL_RESPONSE_MAX_BYTES = 1024 * 1024
const LEASE_RENEWAL_SAFETY_MARGIN_MS = 5_000
export const VIDEO_MEDIA_UPLOAD_TIMEOUT_DEFAULT_MS = 4 * 60_000

export type VideoMediaRelayTransportPolicy = {
  uploadTimeoutMs: number
  uploadRetries: number
  controlTimeoutMs: number
  resultTimeoutMs: number
}

function transportInteger(
  environment: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

/** Sidecar transport policy is external configuration, separate from Relay
 * account capacity and product quota. A slow cross-border OSS part therefore
 * does not require changing task, model or server admission code. */
export function videoMediaRelayTransportPolicyFromEnvironment(
  environment: Record<string, string | undefined>,
): VideoMediaRelayTransportPolicy {
  return {
    uploadTimeoutMs: transportInteger(environment, 'BB_VIDEO_MEDIA_UPLOAD_TIMEOUT_MS', VIDEO_MEDIA_UPLOAD_TIMEOUT_DEFAULT_MS, 5_000, 5 * 60_000),
    uploadRetries: transportInteger(environment, 'BB_VIDEO_MEDIA_UPLOAD_RETRIES', 3, 0, 5),
    controlTimeoutMs: transportInteger(environment, 'BB_VIDEO_MEDIA_CONTROL_TIMEOUT_MS', 15_000, 1_000, 60_000),
    resultTimeoutMs: transportInteger(environment, 'BB_VIDEO_MEDIA_RESULT_TIMEOUT_MS', 60_000, 1_000, 5 * 60_000),
  }
}

/** Sidecar-only Relay client. Renderer never receives its installation token. */
export class VideoMediaRelayClient {
  constructor(private readonly options: {
    baseUrl: string
    accessToken: string
    fetchImpl?: FetchLike
    uploadTimeoutMs?: number
    uploadRetries?: number
    /** Testable hard caps; production callers use the safe defaults. */
    controlResponseMaxBytes?: number
    resultMaxBytes?: number
    controlTimeoutMs?: number
    /** Result objects use a separate bounded transfer window; signed URLs can
     * legitimately take longer than control JSON but never indefinitely. */
    resultTimeoutMs?: number
    /** Sidecar cancellation is propagated to Relay control requests; it never
     * lengthens the client's own bounded timeout. */
    signal?: AbortSignal
    /** Shares the service clock with deterministic recovery tests. */
    now?: () => Date
  }) {}

  private uploadTimeoutMs(): number { return Math.max(5_000, Math.min(5 * 60_000, this.options.uploadTimeoutMs ?? VIDEO_MEDIA_UPLOAD_TIMEOUT_DEFAULT_MS)) }
  private uploadRetries(): number { return Math.max(0, Math.min(5, this.options.uploadRetries ?? 3)) }
  private controlResponseMaxBytes(): number { return Math.max(4 * 1024, Math.min(4 * 1024 * 1024, this.options.controlResponseMaxBytes ?? DEFAULT_CONTROL_RESPONSE_MAX_BYTES)) }
  /** The wire contract owns the production result limit. A test/runtime
   * override may only tighten it; a Sidecar cannot silently accept a Relay
   * result the contract has already ruled out. */
  private resultMaxBytes(): number {
    return Math.max(1024 * 1024, Math.min(
      VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES,
      this.options.resultMaxBytes ?? VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES,
    ))
  }
  private controlTimeoutMs(): number { return Math.max(1_000, Math.min(60_000, this.options.controlTimeoutMs ?? 15_000)) }
  private resultTimeoutMs(): number { return Math.max(1_000, Math.min(5 * 60_000, this.options.resultTimeoutMs ?? 60_000)) }
  private nowMs(): number { return (this.options.now?.() ?? new Date()).getTime() }

  private abortError(timedOut: boolean, scope: 'control' | 'result'): VideoMediaRelayClientError {
    return new VideoMediaRelayClientError(timedOut ? 503 : 499, timedOut ? `relay_${scope}_timeout` : `relay_${scope}_cancelled`)
  }

  /** One controller covers connect, headers, and every byte consumed from the
   * body. A fetch mock or a platform stream that ignores AbortSignal is still
   * bounded by readWithDeadline below. */
  private deadline(milliseconds: number): { controller: AbortController; timedOut: () => boolean; cleanup: () => void } {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, milliseconds)
    const abortFromCaller = () => controller.abort()
    this.options.signal?.addEventListener('abort', abortFromCaller, { once: true })
    return {
      controller,
      timedOut: () => timedOut,
      cleanup: () => {
        clearTimeout(timeout)
        this.options.signal?.removeEventListener('abort', abortFromCaller)
      },
    }
  }

  private async readWithDeadline<T>(action: () => Promise<T>, signal: AbortSignal, error: () => VideoMediaRelayClientError): Promise<T> {
    if (signal.aborted) throw error()
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => reject(error())
      signal.addEventListener('abort', aborted, { once: true })
      void action().then(value => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      }, reason => {
        signal.removeEventListener('abort', aborted)
        reject(reason)
      })
    })
  }

  private async pause(milliseconds: number): Promise<void> {
    const signal = this.options.signal
    if (signal?.aborted) throw new VideoMediaRelayClientError(499, 'relay_upload_cancelled')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, milliseconds)
      const cancelled = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(new VideoMediaRelayClientError(499, 'relay_upload_cancelled')) }
      function done() { signal?.removeEventListener('abort', cancelled); resolve() }
      signal?.addEventListener('abort', cancelled, { once: true })
    })
  }

  /** Consume a Response incrementally and refuse oversized bodies before a
   * JSON parser or ArrayBuffer can claim arbitrary Sidecar memory. */
  private async readBoundedBytes(
    response: Response,
    maximum: number,
    overflowCode: string,
    signal?: AbortSignal,
    abortError?: () => VideoMediaRelayClientError,
  ): Promise<Uint8Array> {
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null) {
      const declared = Number(contentLength)
      if (Number.isSafeInteger(declared) && declared >= 0 && declared > maximum) {
        this.cancelResponseBody(response)
        throw new VideoMediaRelayClientError(502, overflowCode)
      }
    }
    if (!response.body) return new Uint8Array()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let completed = false
    try {
      while (true) {
        const next = signal && abortError
          ? await this.readWithDeadline(() => reader.read(), signal, abortError)
          : await reader.read()
        if (next.done) break
        if (!next.value?.byteLength) continue
        total += next.value.byteLength
        if (total > maximum) {
          throw new VideoMediaRelayClientError(502, overflowCode)
        }
        chunks.push(next.value)
      }
      completed = true
    } catch (error) {
      if (error instanceof VideoMediaRelayClientError) throw error
      throw new VideoMediaRelayClientError(503, 'relay_response_unavailable')
    } finally {
      if (!completed) this.cancelReader(reader)
      else reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  }

  /** Cancellation is cleanup, not part of the request's success path. Some
   * platform/custom streams never resolve cancel(), so start it and release
   * the lock without awaiting an untrusted promise. */
  private cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    try {
      const cancellation = reader.cancel()
      void cancellation.catch(() => undefined)
    } catch {
      // Cleanup cannot replace the bounded request failure.
    } finally {
      try { reader.releaseLock() } catch { /* a non-cooperative pending read may still own the lock */ }
    }
  }

  private cancelResponseBody(response: Response): void {
    if (!response.body) return
    this.cancelReader(response.body.getReader())
  }
  private async uploadWithRetry(target: () => Promise<{ put_url: string; required_headers?: Record<string, string> }>, bytes: Uint8Array): Promise<Response> {
    let last: Response | undefined
    for (let attempt = 0; attempt <= this.uploadRetries(); attempt += 1) {
      if (this.options.signal?.aborted) throw new VideoMediaRelayClientError(499, 'relay_upload_cancelled')
      const upload = await target()
      const controller = new AbortController()
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; controller.abort() }, this.uploadTimeoutMs())
      const abortFromCaller = () => controller.abort()
      this.options.signal?.addEventListener('abort', abortFromCaller, { once: true })
      try {
        const response = await (this.options.fetchImpl ?? fetch)(upload.put_url, { method: 'PUT', headers: upload.required_headers, body: bytes as unknown as BodyInit, signal: controller.signal })
        if (response.ok) return response
        last = response
        // Only an explicit throttle proves OSS did not accept these bytes.
        // A timeout/5xx/other response is reconciled through HEAD/ListParts by
        // the caller before any same-part transfer can be attempted again.
        if (response.status !== 429) return response
      } catch {
        if (this.options.signal?.aborted) throw new VideoMediaRelayClientError(499, 'relay_upload_cancelled')
        throw new VideoMediaRelayClientError(503, timedOut ? 'relay_upload_timeout' : 'relay_upload_unavailable')
      } finally {
        clearTimeout(timeout)
        this.options.signal?.removeEventListener('abort', abortFromCaller)
      }
      if (attempt < this.uploadRetries()) await this.pause(250 * (attempt + 1))
    }
    if (last) return last
    throw new VideoMediaRelayClientError(503, 'relay_upload_unavailable')
  }

  private async request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, idempotencyKey?: string): Promise<T> {
    if (this.options.signal?.aborted) throw new VideoMediaRelayClientError(499, 'relay_request_cancelled')
    const deadline = this.deadline(this.controlTimeoutMs())
    try {
      let response: Response
      try {
        response = await this.readWithDeadline(() => (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl.replace(/\/+$/, '')}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(method === 'GET' ? {} : { 'Idempotency-Key': idempotencyKey ?? `video-${createHash('sha256').update(`${method}\0${path}\0${JSON.stringify(body)}`).digest('hex')}`, 'X-Request-Timestamp': new Date().toISOString() }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: deadline.controller.signal,
        }), deadline.controller.signal, () => this.abortError(deadline.timedOut(), 'control'))
      } catch {
        if (deadline.controller.signal.aborted) throw this.abortError(deadline.timedOut(), 'control')
        throw new VideoMediaRelayClientError(503, 'relay_control_unavailable')
      }
      if (response.status === 204) return undefined as T
      let payload: unknown
      try {
        const bytes = await this.readBoundedBytes(
          response,
          this.controlResponseMaxBytes(),
          'relay_control_response_too_large',
          deadline.controller.signal,
          () => this.abortError(deadline.timedOut(), 'control'),
        )
        payload = JSON.parse(new TextDecoder().decode(bytes))
      } catch (error) {
        if (error instanceof VideoMediaRelayClientError) throw error
        throw new VideoMediaRelayClientError(502, 'relay_invalid_response')
      }
      if (!response.ok) throw new VideoMediaRelayClientError(response.status, typeof (payload as { error?: unknown }).error === 'string' ? (payload as { error: string }).error : 'relay_unavailable')
      return payload as T
    } finally {
      deadline.cleanup()
    }
  }

  async createObjectLease(input: CreateMediaObjectLeaseRequest): Promise<MediaObjectLease> {
    const parsed = createMediaObjectLeaseRequestSchema.parse(input)
    return mediaObjectLeaseSchema.parse(await this.request('/v1/video-media/object-leases', 'POST', parsed, `lease-${parsed.local_operation_id}-${parsed.content_hash.slice(7, 31)}`))
  }

  /** Signed OSS capabilities must outlive one complete bounded PUT plus a
   * safety margin. Renewal is scoped to the existing lease and its previous
   * expiry, so a retry cannot create another object or collapse two renewal
   * epochs onto one idempotency record. */
  private async renewObjectLease(lease: MediaObjectLease): Promise<MediaObjectLease> {
    const epoch = createHash('sha256').update(lease.expires_at).digest('hex').slice(0, 24)
    const renewed = mediaObjectLeaseSchema.parse(await this.request(
      `/v1/video-media/object-leases/${encodeURIComponent(lease.lease_id)}/renew`,
      'POST',
      {},
      `renew-${lease.lease_id}-${epoch}`,
    ))
    if (renewed.lease_id !== lease.lease_id) throw new VideoMediaRelayClientError(409, 'relay_upload_lease_changed')
    return renewed
  }

  private async ensureUploadLeaseFresh(lease: MediaObjectLease): Promise<MediaObjectLease> {
    if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease
    const expiresAt = Date.parse(lease.expires_at)
    if (!Number.isFinite(expiresAt)) throw new VideoMediaRelayClientError(502, 'relay_upload_lease_expiry_invalid')
    if (expiresAt - this.nowMs() > this.uploadTimeoutMs() + LEASE_RENEWAL_SAFETY_MARGIN_MS) return lease
    return await this.renewObjectLease(lease)
  }

  /** A direct immutable PUT can have reached OSS even when its response was
   * lost. Let the Relay's same-lease HEAD verification decide that outcome;
   * retrying the PUT would turn a valid forbid-overwrite 409 into false loss. */
  private async reconcileDirectObjectLease(lease: MediaObjectLease): Promise<string | null> {
    try {
      const completed = await this.completeObjectLease(lease.lease_id)
      if ((completed.state === 'ready' || completed.state === 'bound') && completed.object_ref) return completed.object_ref
    } catch (error) {
      if (error instanceof VideoMediaRelayClientError && error.status === 499) throw error
      // A known absent/mismatched object remains a failure; do not create a
      // second lease or blind-repeat the opaque byte transfer.
    }
    try {
      const refreshed = await this.renewObjectLease(lease)
      if ((refreshed.state === 'ready' || refreshed.state === 'bound') && refreshed.object_ref) return refreshed.object_ref
      const completed = await this.completeObjectLease(refreshed.lease_id)
      if ((completed.state === 'ready' || completed.state === 'bound') && completed.object_ref) return completed.object_ref
    } catch (error) {
      if (error instanceof VideoMediaRelayClientError && error.status === 499) throw error
      // Preserve the original safe failure below.
    }
    return null
  }
  /** Upload is intentionally a direct short-lived object URL transfer; no media
   * bytes are ever proxied through the Relay JSON server. */
  async uploadObject(input: CreateMediaObjectLeaseRequest, bytes: Uint8Array): Promise<string> {
    let lease = await this.createObjectLease(input)
    // The deterministic lease key may already have reached ready/bound before
    // the Sidecar crashed. Reusing that immutable object ref is the only safe
    // restart path: uploading again would either fail (no PUT capability) or
    // create a second ASR input for the same local Operation.
    if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease.object_ref
    if (lease.multipart_upload) {
      const multipart = lease.multipart_upload
      const completed = new Map(multipart.uploaded_parts.map(part => [part.part_number, part.etag]))
      for (const part of multipart.parts) {
        if (completed.has(part.part_number)) continue
        const start = (part.part_number - 1) * multipart.part_size
        const end = Math.min(bytes.byteLength, start + multipart.part_size)
        if (start >= end) throw new VideoMediaRelayClientError(502, 'relay_upload_part_range_invalid')
        let response: Response | undefined
        try {
          response = await this.uploadWithRetry(async () => {
            lease = await this.ensureUploadLeaseFresh(lease)
            const current = lease.multipart_upload?.parts.find(item => item.part_number === part.part_number)
            if (!current) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
            return current
          }, bytes.subarray(start, end))
        } catch (error) {
          if (error instanceof VideoMediaRelayClientError && error.status === 499) throw error
        }
        if (!response?.ok) {
          // Refreshing with the same lease idempotency key enumerates the OSS
          // parts already committed before the timeout and re-signs only the
          // fixed object/part capability; it never creates a second object.
          lease = await this.renewObjectLease(lease)
          if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease.object_ref
          const confirmed = lease.multipart_upload?.uploaded_parts.find(item => item.part_number === part.part_number)
          if (confirmed) {
            completed.set(part.part_number, confirmed.etag)
            continue
          }
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
      lease = await this.ensureUploadLeaseFresh(lease)
      if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease.object_ref
      const ready = await this.completeObjectLease(lease.lease_id, parts)
      if (!ready.object_ref) throw new VideoMediaRelayClientError(502, 'relay_upload_unverified')
      return ready.object_ref
    }
    if (!lease.put_url || !lease.required_headers) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
    let response: Response | undefined
    try {
      response = await this.uploadWithRetry(async () => {
        lease = await this.ensureUploadLeaseFresh(lease)
        if (!lease.put_url || !lease.required_headers) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
        return { put_url: lease.put_url, required_headers: lease.required_headers }
      }, bytes)
    } catch (error) {
      if (error instanceof VideoMediaRelayClientError && error.status === 499) throw error
      const recovered = await this.reconcileDirectObjectLease(lease)
      if (recovered) return recovered
      throw new VideoMediaRelayClientError(503, 'relay_upload_rejected')
    }
    if (!response.ok) {
      const recovered = await this.reconcileDirectObjectLease(lease)
      if (recovered) return recovered
      throw new VideoMediaRelayClientError(503, 'relay_upload_rejected')
    }
    lease = await this.ensureUploadLeaseFresh(lease)
    if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease.object_ref
    const ready = await this.completeObjectLease(lease.lease_id)
    if (!ready.object_ref) throw new VideoMediaRelayClientError(502, 'relay_upload_unverified')
    return ready.object_ref
  }
  /**
   * Large media never needs to be materialized as one Buffer. The factory is
   * deliberately restartable: the Relay lease is idempotent and already
   * committed OSS parts are skipped after a reconnect, while the source is
   * re-read only to retain byte-order and end-to-end SHA-256 validation.
   */
  async uploadObjectStream(input: CreateMediaObjectLeaseRequest, sourceFactory: () => ReadableStream<Uint8Array>): Promise<string> {
    let lease = await this.createObjectLease(input)
    if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease.object_ref
    if (!lease.multipart_upload) {
      const bytes = await readExactly(sourceFactory(), input.byte_size, input.content_hash, this.options.signal)
      return await this.uploadObject(input, bytes)
    }
    const multipart = lease.multipart_upload
    const completedParts = new Map(multipart.uploaded_parts.map(part => [part.part_number, part.etag]))
    const stream = new StreamPartReader(sourceFactory().getReader(), this.options.signal); const hash = createHash('sha256'); let remaining = input.byte_size
    let streamCompleted = false
    try {
      for (const part of multipart.parts) {
        const expected = Math.min(multipart.part_size, remaining)
        const bytes = await stream.take(expected)
        remaining -= bytes.byteLength; hash.update(bytes)
        if (completedParts.has(part.part_number)) continue
        let response: Response | undefined
        try {
          response = await this.uploadWithRetry(async () => {
            lease = await this.ensureUploadLeaseFresh(lease)
            const current = lease.multipart_upload?.parts.find(item => item.part_number === part.part_number)
            if (!current) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
            return current
          }, bytes)
        } catch (error) {
          if (error instanceof VideoMediaRelayClientError && error.status === 499) throw error
        }
        if (!response?.ok) {
          lease = await this.renewObjectLease(lease)
          if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease.object_ref
          // A timeout may have reached OSS. The Relay refresh reads ListParts,
          // so a confirmed ETag is the authority here; retrying that part with
          // forbid-overwrite would incorrectly turn a success into a 409.
          const confirmed = lease.multipart_upload?.uploaded_parts.find(item => item.part_number === part.part_number)
          if (confirmed) {
            completedParts.set(part.part_number, confirmed.etag)
            continue
          }
          const replacement = lease.multipart_upload?.parts.find(item => item.part_number === part.part_number)
          if (!replacement) throw new VideoMediaRelayClientError(503, 'relay_upload_lease_unavailable')
          const retried = await this.uploadWithRetry(async () => replacement, bytes)
          if (!retried.ok) throw new VideoMediaRelayClientError(503, 'relay_upload_rejected')
          const etag = retried.headers.get('etag')
          if (!etag) throw new VideoMediaRelayClientError(502, 'relay_upload_part_etag_missing')
          completedParts.set(part.part_number, etag)
          continue
        }
        const etag = response.headers.get('etag')
        if (!etag) throw new VideoMediaRelayClientError(502, 'relay_upload_part_etag_missing')
        completedParts.set(part.part_number, etag)
      }
      if (remaining !== 0 || !(await stream.ended()) || `sha256:${hash.digest('hex')}` !== input.content_hash) throw new VideoMediaRelayClientError(422, 'relay_upload_source_integrity_failed')
      streamCompleted = true
    } finally {
      if (!streamCompleted) stream.cancel()
      stream.release()
    }
    const parts: MultipartUploadedPart[] = [...completedParts.entries()].map(([part_number, etag]) => ({ part_number, etag })).sort((a, b) => a.part_number - b.part_number)
    lease = await this.ensureUploadLeaseFresh(lease)
    if ((lease.state === 'ready' || lease.state === 'bound') && lease.object_ref) return lease.object_ref
    const ready = await this.completeObjectLease(lease.lease_id, parts)
    if (!ready.object_ref) throw new VideoMediaRelayClientError(502, 'relay_upload_unverified')
    return ready.object_ref
  }
  async completeObjectLease(leaseId: string, parts?: MultipartUploadedPart[]): Promise<MediaObjectLease> { return mediaObjectLeaseSchema.parse(await this.request(`/v1/video-media/object-leases/${encodeURIComponent(leaseId)}/complete`, 'POST', parts ? { parts } : {}, `complete-${leaseId}`)) }
  async createOperation(input: CreateVideoRelayOperationRequest): Promise<VideoRelayOperationProjection> { const parsed = createVideoRelayOperationRequestSchema.parse(input); return videoRelayOperationProjectionSchema.parse(await this.request('/v1/video-media/operations', 'POST', parsed, `operation-${parsed.local_operation_id}`)) }
  async operation(id: string): Promise<VideoRelayOperationProjection> { return videoRelayOperationProjectionSchema.parse(await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}`, 'GET')) }
  /** Recover the Relay's durable idempotency record after the local submission
   * fence committed but the returned Relay id did not. Only an authoritative
   * 404 means no durable operation; transport/5xx failures stay unknown. */
  async operationByLocalOperationId(localOperationId: string): Promise<VideoRelayOperationProjection | null> {
    try {
      return videoRelayOperationProjectionSchema.parse(await this.request(`/v1/video-media/operations/by-local-operation/${encodeURIComponent(localOperationId)}`, 'GET'))
    } catch (error) {
      if (error instanceof VideoMediaRelayClientError && error.status === 404 && error.code === 'operation_not_found') return null
      throw error
    }
  }
  async downloadResult<T>(operation: VideoRelayOperationProjection): Promise<{ result: T; hashes: Array<`sha256:${string}`> }> {
    const objects = operation.result_objects
    const object = objects?.[0]
    if (!object || !objects || objects.length !== 1) throw new VideoMediaRelayClientError(409, 'relay_result_not_ready')
    if (object.byte_size > this.resultMaxBytes()) throw new VideoMediaRelayClientError(502, 'relay_result_too_large')
    if (!object.content_type.toLowerCase().startsWith('application/json')) throw new VideoMediaRelayClientError(502, 'relay_result_content_type_invalid')
    if (this.options.signal?.aborted) throw new VideoMediaRelayClientError(499, 'relay_result_cancelled')
    const deadline = this.deadline(this.resultTimeoutMs())
    try {
      let response: Response
      try {
        response = await this.readWithDeadline(
          () => (this.options.fetchImpl ?? fetch)(object.get_url, { signal: deadline.controller.signal, redirect: 'error' }),
          deadline.controller.signal,
          () => this.abortError(deadline.timedOut(), 'result'),
        )
      } catch {
        if (deadline.controller.signal.aborted) throw this.abortError(deadline.timedOut(), 'result')
        throw new VideoMediaRelayClientError(503, 'relay_result_unavailable')
      }
      if (!response.ok) {
        // Error bodies are not part of the signed result protocol and may be
        // arbitrarily slow. Stop them immediately without awaiting a custom
        // stream's cancel promise before releasing the request deadline.
        this.cancelResponseBody(response)
        if ([404, 410].includes(response.status)) throw new VideoMediaRelayClientError(response.status, 'relay_result_retired')
        throw new VideoMediaRelayClientError(503, 'relay_result_unavailable')
      }
      const declared = response.headers.get('content-length')
      if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) !== object.byte_size)) {
        this.cancelResponseBody(response)
        throw new VideoMediaRelayClientError(502, 'relay_result_integrity_failed')
      }
      const bytes = await this.readBoundedBytes(
        response,
        object.byte_size,
        'relay_result_integrity_failed',
        deadline.controller.signal,
        () => this.abortError(deadline.timedOut(), 'result'),
      )
      if (bytes.byteLength !== object.byte_size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== object.content_hash) throw new VideoMediaRelayClientError(502, 'relay_result_integrity_failed')
      try { return { result: JSON.parse(new TextDecoder().decode(bytes)) as T, hashes: objects.map(item => item.content_hash as `sha256:${string}`) } } catch { throw new VideoMediaRelayClientError(502, 'relay_result_invalid') }
    } finally {
      deadline.cleanup()
    }
  }
  async cancel(id: string): Promise<VideoRelayOperationProjection> { return videoRelayOperationProjectionSchema.parse(await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}/cancel`, 'POST', {}, `cancel-${id}`)) }
  async acknowledge(id: string, input: { result_hashes: Array<`sha256:${string}`>; receipt_id: string }): Promise<void> { await this.request(`/v1/video-media/operations/${encodeURIComponent(id)}/ack`, 'POST', operationAcknowledgementSchema.parse(input), `ack-${id}-${input.receipt_id}`) }
}

class StreamPartReader {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array()
  private done = false
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly signal?: AbortSignal) {}
  async take(expected: number): Promise<Uint8Array> {
    const part = new Uint8Array(expected); let offset = 0
    while (offset < expected) {
      if (!this.pending.byteLength) {
        const next = await readStreamChunk(this.reader, this.signal); this.done = next.done
        if (next.done || !next.value) throw new VideoMediaRelayClientError(422, 'relay_upload_source_truncated')
        this.pending = next.value
      }
      const amount = Math.min(expected - offset, this.pending.byteLength)
      part.set(this.pending.subarray(0, amount), offset); offset += amount; this.pending = this.pending.subarray(amount)
    }
    return part
  }
  async ended(): Promise<boolean> { if (this.pending.byteLength) return false; if (this.done) return true; const next = await readStreamChunk(this.reader, this.signal); this.done = next.done; this.pending = next.value ?? new Uint8Array(); return this.done && !this.pending.byteLength }
  cancel(): void {
    try { void this.reader.cancel().catch(() => undefined) } catch { /* cleanup only */ }
  }
  release(): void { try { this.reader.releaseLock() } catch { /* cancellation cleanup only */ } }
}
async function readExactly(stream: ReadableStream<Uint8Array>, expected: number, expectedHash: string, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; const hash = createHash('sha256'); let size = 0
  let completed = false
  try {
    while (true) { const { value, done } = await readStreamChunk(reader, signal); if (done) break; if (!value) continue; size += value.byteLength; if (size > expected) throw new VideoMediaRelayClientError(422, 'relay_upload_source_too_large'); chunks.push(value); hash.update(value) }
    completed = true
  } finally {
    try {
      if (!completed) void reader.cancel().catch(() => undefined)
    } catch {
      // Cleanup cannot replace the source-integrity failure.
    } finally {
      try { reader.releaseLock() } catch { /* cancellation cleanup only */ }
    }
  }
  if (size !== expected || `sha256:${hash.digest('hex')}` !== expectedHash) throw new VideoMediaRelayClientError(422, 'relay_upload_source_integrity_failed')
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }; return result
}

async function readStreamChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!signal) return await reader.read()
  if (signal.aborted) throw new VideoMediaRelayClientError(499, 'relay_upload_cancelled')
  return await new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
    const cancelled = () => {
      try { void reader.cancel().catch(() => undefined) } catch { /* cancellation remains authoritative */ }
      reject(new VideoMediaRelayClientError(499, 'relay_upload_cancelled'))
    }
    signal.addEventListener('abort', cancelled, { once: true })
    void reader.read().then(value => {
      signal.removeEventListener('abort', cancelled)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', cancelled)
      reject(error)
    })
  })
}

export function relayRequestHash(value: unknown): `sha256:${string}` { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` }
