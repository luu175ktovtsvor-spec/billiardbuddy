import { createHash } from 'node:crypto'
import {
  SERVICE_INTROSPECTION_AUDIENCE_HEADER,
  SERVICE_INTROSPECTION_INSTALLATION_AUTHORIZATION_HEADER,
  SERVICE_INTROSPECTION_PATH,
  SERVICE_INTROSPECTION_TOKEN_HEADER,
  type ActiveServiceIntrospection,
} from '../ts/shared/product/serviceIntrospection.js'
import { fetchBoundedResponseText, UpstreamDeadlineExceededError, UpstreamResponseTooLargeError } from './network.ts'
import {
  localVideoMediaAdmissionBackend,
  videoMediaGatewayIdentityScope,
  type VideoMediaAdmissionBackend,
  type VideoMediaAdmissionGate,
  type VideoMediaIdentityAdmissionPolicy,
} from './capacityPolicy.ts'
import { ProviderAdmissionError, type ProviderAdmissionPermit } from '../ts/shared/kernel/providerAdmission.js'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type VideoMediaRelayIdentity = Omit<ActiveServiceIntrospection, 'active'>
export type VideoMediaRelayIdentityEnvironment = Readonly<Record<string, string | undefined>>

export const VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE_ENV = 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE'
export const VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN_ENV = 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN'

export class VideoMediaRelayIdentityError extends Error {
  constructor(readonly status: 401 | 502 | 503, readonly code: 'identity_inactive' | 'identity_response_invalid' | 'identity_unavailable') {
    super(code)
  }
}

/**
 * The relay never accepts a caller-provided owner. It sends the short-lived
 * desktop bearer straight to the private Gateway identity authority together
 * with its independent service proof and derives the stable owner from that
 * response only.
 */
export class VideoMediaRelayIdentityIntrospector {
  private readonly admission: VideoMediaAdmissionGate
  private readonly inFlight = new Map<string, Promise<VideoMediaRelayIdentity>>()
  constructor(
    private readonly options: { baseUrl: string; serviceToken: string; fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number; admissionBackend?: VideoMediaAdmissionBackend; admissionPolicy?: VideoMediaIdentityAdmissionPolicy },
  ) {
    const policy = options.admissionPolicy ?? { max_active: 8, max_queued: 32, max_wait_ms: 10_000 }
    this.admission = (options.admissionBackend ?? localVideoMediaAdmissionBackend).createGate({
      maxActive: policy.max_active,
      maxActivePerOwner: policy.max_active,
      maxQueued: policy.max_queued,
      maxQueuedPerOwner: policy.max_queued,
      maxWaitMs: policy.max_wait_ms,
    }, videoMediaGatewayIdentityScope)
  }

  async introspect(installationBearer: string, options: { signal?: AbortSignal } = {}): Promise<VideoMediaRelayIdentity> {
    if (!installationBearer.trim()) throw new VideoMediaRelayIdentityError(401, 'identity_inactive')
    const fingerprint = createHash('sha256').update(installationBearer).digest('hex')
    let shared = this.inFlight.get(fingerprint)
    if (!shared) {
      shared = this.introspectOnce(installationBearer)
      this.inFlight.set(fingerprint, shared)
      void shared.finally(() => {
        if (this.inFlight.get(fingerprint) === shared) this.inFlight.delete(fingerprint)
      }).catch(() => { /* every caller receives the fail-closed result */ })
    }
    return await awaitIdentity(shared, options.signal)
  }

  private async introspectOnce(installationBearer: string): Promise<VideoMediaRelayIdentity> {
    let permit: ProviderAdmissionPermit
    try {
      permit = await this.admission.acquire('gateway-introspection')
    } catch (error) {
      if (error instanceof ProviderAdmissionError) throw new VideoMediaRelayIdentityError(503, 'identity_unavailable')
      throw error
    }
    try {
      await permit.assertCurrent?.()
      let body: unknown
      try {
        const { response, text } = await fetchBoundedResponseText(this.options.fetchImpl ?? fetch, `${this.options.baseUrl}${SERVICE_INTROSPECTION_PATH}`, {
          method: 'POST',
          headers: {
            [SERVICE_INTROSPECTION_INSTALLATION_AUTHORIZATION_HEADER]: `Bearer ${installationBearer}`,
            [SERVICE_INTROSPECTION_AUDIENCE_HEADER]: 'video-media-relay',
            [SERVICE_INTROSPECTION_TOKEN_HEADER]: this.options.serviceToken,
          },
        }, 16 * 1024, this.options.timeoutMs ?? 10_000)
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) throw new VideoMediaRelayIdentityError(401, 'identity_inactive')
          if (response.status >= 500) throw new VideoMediaRelayIdentityError(503, 'identity_unavailable')
          throw new VideoMediaRelayIdentityError(502, 'identity_response_invalid')
        }
        body = JSON.parse(text) as unknown
      } catch (error) {
        if (error instanceof VideoMediaRelayIdentityError) throw error
        // The Gateway is trusted as an authority, but its response remains an
        // untrusted network payload. A malformed or oversized 2xx response is
        // a bad upstream representation (502), not a temporary outage.
        if (error instanceof UpstreamResponseTooLargeError || error instanceof SyntaxError) {
          throw new VideoMediaRelayIdentityError(502, 'identity_response_invalid')
        }
        if (error instanceof UpstreamDeadlineExceededError) throw new VideoMediaRelayIdentityError(503, 'identity_unavailable')
        throw new VideoMediaRelayIdentityError(503, 'identity_unavailable')
      }
      const identity = parseActiveVideoMediaRelayIdentity(body, this.options.now?.() ?? Date.now())
      if (!identity) {
        // `active:false` is the Gateway's ordinary authentication answer. Any
        // other successful but nonconforming representation is an authority
        // contract failure and must not be misreported as a client 401.
        if (body && typeof body === 'object' && !Array.isArray(body) && (body as { active?: unknown }).active === false) {
          throw new VideoMediaRelayIdentityError(401, 'identity_inactive')
        }
        throw new VideoMediaRelayIdentityError(502, 'identity_response_invalid')
      }
      return identity
    } finally { permit.release() }
  }
}

export function loadVideoMediaRelayIdentityIntrospector(
  environment: VideoMediaRelayIdentityEnvironment = process.env,
  options: { fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number; admissionBackend?: VideoMediaAdmissionBackend; admissionPolicy?: VideoMediaIdentityAdmissionPolicy } = {},
): VideoMediaRelayIdentityIntrospector {
  const baseUrl = parseVideoMediaGatewayIntrospectionBase(environment[VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE_ENV])
  const serviceToken = environment[VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN_ENV]?.trim()
  if (!serviceToken || serviceToken.length < 32) throw new Error(`${VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN_ENV} must be at least 32 characters`)
  return new VideoMediaRelayIdentityIntrospector({ baseUrl, serviceToken, ...options })
}

async function awaitIdentity(task: Promise<VideoMediaRelayIdentity>, signal?: AbortSignal): Promise<VideoMediaRelayIdentity> {
  if (!signal) return await task
  if (signal.aborted) throw new VideoMediaRelayIdentityError(503, 'identity_unavailable')
  return await new Promise<VideoMediaRelayIdentity>((resolve, reject) => {
    const onAbort = () => reject(new VideoMediaRelayIdentityError(503, 'identity_unavailable'))
    signal.addEventListener('abort', onAbort, { once: true })
    void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** The exact Compose Gateway hop or HTTPS only; no path, credentials or query. */
export function parseVideoMediaGatewayIntrospectionBase(value: string | undefined): string {
  if (!value) throw new Error(`${VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE_ENV} is required`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE_ENV} must be a valid URL`)
  }
  const composeGateway = url.protocol === 'http:' && url.hostname === 'gateway' && url.port === '8799'
  if ((!composeGateway && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE_ENV} must be HTTPS or http://gateway:8799 without path, credentials, query, or fragment`)
  }
  return url.toString().replace(/\/$/, '')
}

export function parseActiveVideoMediaRelayIdentity(body: unknown, now = Date.now()): VideoMediaRelayIdentity | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  const principal = typeof value.principal_id === 'string' ? value.principal_id : ''
  const installation = typeof value.installation_id === 'string' ? value.installation_id : ''
  const session = typeof value.session_id === 'string' ? value.session_id : ''
  const expiresAt = value.expires_at
  const owner = typeof value.owner === 'string' ? value.owner : ''
  if (value.active !== true
    || !/^installation:[A-Za-z0-9_-]{32}$/.test(principal)
    || !/^[A-Za-z0-9._-]{8,128}$/.test(installation)
    || !/^[A-Za-z0-9_-]{24}$/.test(session)
    || !Number.isSafeInteger(expiresAt) || (expiresAt as number) <= now
    || owner !== `${principal}:${installation}`) return null
  return {
    principal_id: principal,
    installation_id: installation,
    session_id: session,
    expires_at: expiresAt as number,
    owner,
  }
}
