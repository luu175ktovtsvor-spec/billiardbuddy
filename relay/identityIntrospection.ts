import { inspect } from 'node:util'

import {
  SERVICE_INTROSPECTION_AUDIENCE_HEADER,
  SERVICE_INTROSPECTION_INSTALLATION_AUTHORIZATION_HEADER,
  SERVICE_INTROSPECTION_PATH,
  SERVICE_INTROSPECTION_TOKEN_HEADER,
  type ActiveServiceIntrospection,
} from '../ts/shared/product/serviceIntrospection.js'

export type ImageRelayIdentityEnvironment = Readonly<Record<string, string | undefined>>
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export const IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE_ENV = 'IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE'
export const IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN_ENV = 'IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN'

const REDACTED = '[REDACTED]'
const INSTALLATION_ID = /^[A-Za-z0-9._-]{8,128}$/
const SESSION_ID = /^[A-Za-z0-9_-]{24}$/
const PRINCIPAL_ID = /^installation:[A-Za-z0-9_-]{32}$/

export type ImageRelayIdentity = Omit<ActiveServiceIntrospection, 'active'>

export class RelayIdentityIntrospectionError extends Error {
  constructor(readonly status: 401 | 502 | 503, readonly code: 'identity_inactive' | 'identity_response_invalid' | 'identity_unavailable') {
    super(code)
    this.name = 'RelayIdentityIntrospectionError'
  }
}

/**
 * Short-lived internal client. The desktop bearer is an argument to one call,
 * never retained in this object or its health/diagnostic representation.
 */
export class ImageRelayIdentityIntrospector {
  #baseUrl: string
  #serviceToken: string
  #fetch: FetchLike
  #now: () => number

  constructor(options: { baseUrl: string; serviceToken: string; fetchImpl?: FetchLike; now?: () => number }) {
    this.#baseUrl = options.baseUrl
    this.#serviceToken = options.serviceToken
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
  }

  async introspect(installationBearer: string): Promise<ImageRelayIdentity> {
    if (!installationBearer.trim()) throw new RelayIdentityIntrospectionError(401, 'identity_inactive')
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${SERVICE_INTROSPECTION_PATH}`, {
        method: 'POST',
        headers: {
          [SERVICE_INTROSPECTION_INSTALLATION_AUTHORIZATION_HEADER]: `Bearer ${installationBearer}`,
          [SERVICE_INTROSPECTION_AUDIENCE_HEADER]: 'image-relay',
          [SERVICE_INTROSPECTION_TOKEN_HEADER]: this.#serviceToken,
        },
      })
    } catch {
      throw new RelayIdentityIntrospectionError(503, 'identity_unavailable')
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new RelayIdentityIntrospectionError(401, 'identity_inactive')
      if (response.status >= 500) throw new RelayIdentityIntrospectionError(503, 'identity_unavailable')
      throw new RelayIdentityIntrospectionError(502, 'identity_response_invalid')
    }
    let body: unknown
    try {
      const text = await response.text()
      if (text.length > 16 * 1024) throw new Error('too large')
      body = JSON.parse(text) as unknown
    } catch {
      throw new RelayIdentityIntrospectionError(502, 'identity_response_invalid')
    }
    const identity = parseActiveImageRelayIdentity(body, this.#now())
    if (!identity) throw new RelayIdentityIntrospectionError(401, 'identity_inactive')
    return identity
  }

  toJSON(): { gateway_introspection_base: string; service_token: string } {
    return { gateway_introspection_base: this.#baseUrl, service_token: REDACTED }
  }

  [inspect.custom](): string {
    return `ImageRelayIdentityIntrospector ${JSON.stringify(this.toJSON())}`
  }
}

export function loadImageRelayIdentityIntrospector(
  environment: ImageRelayIdentityEnvironment = process.env,
  options: { fetchImpl?: FetchLike; now?: () => number } = {},
): ImageRelayIdentityIntrospector {
  const baseUrl = parseImageRelayGatewayIntrospectionBase(environment[IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE_ENV])
  const token = environment[IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN_ENV]?.trim()
  if (!token || token.length < 32) throw new Error(`${IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN_ENV} must be at least 32 characters`)
  return new ImageRelayIdentityIntrospector({ baseUrl, serviceToken: token, ...options })
}

/** Only an HTTPS service endpoint or the exact private Compose Gateway hop may carry this request. */
export function parseImageRelayGatewayIntrospectionBase(value: string | undefined): string {
  if (!value) throw new Error(`${IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE_ENV} is required`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE_ENV} must be a valid URL`)
  }
  const composeGateway = url.protocol === 'http:' && url.hostname === 'gateway' && url.port === '8799'
  const https = url.protocol === 'https:'
  if ((!https && !composeGateway) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE_ENV} must be HTTPS or http://gateway:8799 without path, credentials, query, or fragment`)
  }
  return url.toString().replace(/\/$/, '')
}

/** Reject malformed or expired claims instead of trusting an owner supplied by the Relay request. */
export function parseActiveImageRelayIdentity(body: unknown, now = Date.now()): ImageRelayIdentity | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (value.active !== true
    || typeof value.principal_id !== 'string' || !PRINCIPAL_ID.test(value.principal_id)
    || typeof value.installation_id !== 'string' || !INSTALLATION_ID.test(value.installation_id)
    || typeof value.session_id !== 'string' || !SESSION_ID.test(value.session_id)
    || typeof value.expires_at !== 'number' || !Number.isSafeInteger(value.expires_at) || value.expires_at <= now
    || typeof value.owner !== 'string' || value.owner !== `${value.principal_id}:${value.installation_id}`) return null
  return {
    principal_id: value.principal_id,
    installation_id: value.installation_id,
    session_id: value.session_id,
    expires_at: value.expires_at,
    owner: value.owner,
  }
}
