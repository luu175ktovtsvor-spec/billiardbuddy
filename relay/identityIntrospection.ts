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
const MAX_IDENTITY_RESPONSE_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 60_000

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
  #timeoutMs: number

  constructor(options: { baseUrl: string; serviceToken: string; fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number }) {
    this.#baseUrl = options.baseUrl
    this.#serviceToken = options.serviceToken
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? Date.now
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  async introspect(installationBearer: string): Promise<ImageRelayIdentity> {
    if (!installationBearer.trim()) throw new RelayIdentityIntrospectionError(401, 'identity_inactive')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('identity deadline exceeded'))
      }, this.#timeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      return await Promise.race([(
        async () => {
          const response = await this.#fetch(`${this.#baseUrl}${SERVICE_INTROSPECTION_PATH}`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              [SERVICE_INTROSPECTION_INSTALLATION_AUTHORIZATION_HEADER]: `Bearer ${installationBearer}`,
              [SERVICE_INTROSPECTION_AUDIENCE_HEADER]: 'image-relay',
              [SERVICE_INTROSPECTION_TOKEN_HEADER]: this.#serviceToken,
            },
          })
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) throw new RelayIdentityIntrospectionError(401, 'identity_inactive')
            if (response.status >= 500) throw new RelayIdentityIntrospectionError(503, 'identity_unavailable')
            throw new RelayIdentityIntrospectionError(502, 'identity_response_invalid')
          }
          let body: unknown
          try {
            body = JSON.parse(await readBoundedIdentityText(response, controller.signal)) as unknown
          } catch (error) {
            if (error instanceof RelayIdentityIntrospectionError) throw error
            throw new RelayIdentityIntrospectionError(502, 'identity_response_invalid')
          }
          const identity = parseActiveImageRelayIdentity(body, this.#now())
          if (!identity) throw new RelayIdentityIntrospectionError(401, 'identity_inactive')
          return identity
        }
      )(), deadline])
    } catch (error) {
      if (error instanceof RelayIdentityIntrospectionError) throw error
      throw new RelayIdentityIntrospectionError(503, 'identity_unavailable')
    } finally {
      if (timer) clearTimeout(timer)
    }
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
  options: { fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number } = {},
): ImageRelayIdentityIntrospector {
  const baseUrl = parseImageRelayGatewayIntrospectionBase(environment[IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE_ENV])
  const token = environment[IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN_ENV]?.trim()
  if (!token || token.length < 32) throw new Error(`${IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN_ENV} must be at least 32 characters`)
  return new ImageRelayIdentityIntrospector({ baseUrl, serviceToken: token, ...options })
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`identity timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}`)
  }
  return value
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')?.trim()
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/** Identity is a tiny fixed schema. Stream it so a malicious/failed Gateway
 * cannot force `response.text()` to allocate an unbounded body. */
async function readBoundedIdentityText(response: Response, signal: AbortSignal): Promise<string> {
  if ((declaredContentLength(response) ?? 0) > MAX_IDENTITY_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {})
    throw new RelayIdentityIntrospectionError(502, 'identity_response_invalid')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let detachAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      // Cancellation is deliberately fire-and-forget: a broken upstream stream
      // must not hold the Relay request past its configured whole-body deadline.
      void reader.cancel().catch(() => {})
      reject(new Error('identity response deadline exceeded'))
    }
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      detachAbort = () => signal.removeEventListener('abort', onAbort)
    }
  })
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted])
      if (next.done) break
      const value = next.value
      if (!value || value.byteLength === 0) continue
      if (total + value.byteLength > MAX_IDENTITY_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {})
        throw new RelayIdentityIntrospectionError(502, 'identity_response_invalid')
      }
      chunks.push(value)
      total += value.byteLength
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } finally {
    detachAbort()
    try { reader.releaseLock() } catch {}
  }
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
