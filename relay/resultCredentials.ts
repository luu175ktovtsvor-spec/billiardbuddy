import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { inspect } from 'node:util'

export type ImageRelayResultEnvironment = Readonly<Record<string, string | undefined>>

export const IMAGE_RELAY_PUBLIC_BASE_ENV = 'IMAGE_RELAY_PUBLIC_BASE'
export const IMAGE_RELAY_RESULT_SIGNING_KEY_ENV = 'IMAGE_RELAY_RESULT_SIGNING_KEY'
export const IMAGE_RELAY_RESULT_GRANT_TTL_MS_ENV = 'IMAGE_RELAY_RESULT_GRANT_TTL_MS'

const DEFAULT_GRANT_TTL_MS = 5 * 60_000
const MAX_GRANT_TTL_MS = 15 * 60_000
const SHA256_HEX = /^[a-f0-9]{64}$/

export type ImageRelayResultGrant = {
  v: 1
  task_id: string
  owner_sha256: string
  expires_at: number
}

/**
 * Image-result grants have a credential and lifetime independent from Gateway
 * service authentication. The signing secret remains inside Image Relay; desktop
 * clients receive only one short-lived, owner-bound result URL.
 */
export class ImageRelayResultCredentials {
  #publicBaseUrl: string
  #signingKey: string
  #grantTtlMs: number
  #now: () => number

  constructor(options: {
    publicBaseUrl: string
    signingKey: string
    grantTtlMs?: number
    now?: () => number
  }) {
    this.#publicBaseUrl = parseImageRelayPublicBase(options.publicBaseUrl)
    if (options.signingKey.trim().length < 32) {
      throw new Error(`${IMAGE_RELAY_RESULT_SIGNING_KEY_ENV} must be at least 32 characters`)
    }
    this.#signingKey = options.signingKey.trim()
    this.#grantTtlMs = boundedGrantTtl(options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS)
    this.#now = options.now ?? Date.now
  }

  issue(taskId: string, owner: string): string {
    assertTaskId(taskId)
    if (!owner) throw new Error('image result grant owner is required')
    const payload: ImageRelayResultGrant = {
      v: 1,
      task_id: taskId,
      owner_sha256: sha256(owner),
      expires_at: this.#now() + this.#grantTtlMs,
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${encoded}.${this.#signature(encoded)}`
  }

  verify(grant: string): ImageRelayResultGrant | null {
    const [encoded, suppliedHex, extra] = grant.split('.')
    if (!encoded || !suppliedHex || extra !== undefined || !SHA256_HEX.test(suppliedHex)) return null
    const expected = Buffer.from(this.#signature(encoded), 'hex')
    const supplied = Buffer.from(suppliedHex, 'hex')
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) return null

    let value: unknown
    try {
      value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const payload = value as Record<string, unknown>
    const now = this.#now()
    if (
      payload.v !== 1
      || typeof payload.task_id !== 'string'
      || !validTaskId(payload.task_id)
      || typeof payload.owner_sha256 !== 'string'
      || !SHA256_HEX.test(payload.owner_sha256)
      || typeof payload.expires_at !== 'number'
      || !Number.isSafeInteger(payload.expires_at)
      || payload.expires_at <= now
      || payload.expires_at > now + MAX_GRANT_TTL_MS
    ) return null
    return payload as ImageRelayResultGrant
  }

  isOwner(grant: ImageRelayResultGrant, owner: string): boolean {
    if (!owner) return false
    return timingSafeEqual(
      Buffer.from(grant.owner_sha256, 'hex'),
      Buffer.from(sha256(owner), 'hex'),
    )
  }

  resultUrl(grant: string, outputIndex?: number): string {
    if (outputIndex !== undefined && (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex > 3)) {
      throw new Error('image result output index must be an integer from 0 through 3')
    }
    return `${this.#publicBaseUrl}/v1/images/results/${encodeURIComponent(grant)}${outputIndex === undefined ? '' : `/${outputIndex}`}`
  }

  toJSON(): {
    public_base_url: string
    grant_ttl_ms: number
    signing_key: '[REDACTED]'
  } {
    return {
      public_base_url: this.#publicBaseUrl,
      grant_ttl_ms: this.#grantTtlMs,
      signing_key: '[REDACTED]',
    }
  }

  [inspect.custom](): string {
    return `ImageRelayResultCredentials ${JSON.stringify(this.toJSON())}`
  }

  #signature(encoded: string): string {
    return createHmac('sha256', this.#signingKey).update(encoded).digest('hex')
  }
}

export function loadImageRelayResultCredentials(
  environment: ImageRelayResultEnvironment = process.env,
  options: { now?: () => number } = {},
): ImageRelayResultCredentials {
  const publicBaseUrl = environment[IMAGE_RELAY_PUBLIC_BASE_ENV]
  if (!publicBaseUrl) throw new Error(`${IMAGE_RELAY_PUBLIC_BASE_ENV} is required`)
  const signingKey = environment[IMAGE_RELAY_RESULT_SIGNING_KEY_ENV]
  if (!signingKey) throw new Error(`${IMAGE_RELAY_RESULT_SIGNING_KEY_ENV} is required`)
  const rawTtl = environment[IMAGE_RELAY_RESULT_GRANT_TTL_MS_ENV]?.trim()
  const grantTtlMs = rawTtl === undefined || rawTtl === ''
    ? DEFAULT_GRANT_TTL_MS
    : parseGrantTtl(rawTtl)
  return new ImageRelayResultCredentials({ publicBaseUrl, signingKey, grantTtlMs, ...options })
}

export function parseImageRelayPublicBase(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${IMAGE_RELAY_PUBLIC_BASE_ENV} must be a valid URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${IMAGE_RELAY_PUBLIC_BASE_ENV} must be an HTTPS URL without credentials, query, or fragment`)
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (!path || path === '/') throw new Error(`${IMAGE_RELAY_PUBLIC_BASE_ENV} must include a dedicated path prefix`)
  url.pathname = path
  return url.toString().replace(/\/$/, '')
}

function parseGrantTtl(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${IMAGE_RELAY_RESULT_GRANT_TTL_MS_ENV} must be a positive decimal integer`)
  }
  return boundedGrantTtl(Number(value))
}

function boundedGrantTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_GRANT_TTL_MS) {
    throw new Error(`${IMAGE_RELAY_RESULT_GRANT_TTL_MS_ENV} must be between 1000 and ${MAX_GRANT_TTL_MS}`)
  }
  return value
}

function validTaskId(value: string): boolean {
  return value.length >= 1 && value.length <= 160 && !value.includes('/')
}

function assertTaskId(value: string): void {
  if (!validTaskId(value)) throw new Error('image result grant task id is invalid')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
