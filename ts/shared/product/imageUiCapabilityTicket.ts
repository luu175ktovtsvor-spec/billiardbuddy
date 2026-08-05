import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Image mutations and protected bytes are never authorised by a renderer-held
 * bearer. Electron Main signs one short-lived, single-use request ticket and
 * the local image sidecar validates the exact request before it reads it.
 */
export const IMAGE_UI_CAPABILITY_TICKET_VERSION = 1
export const IMAGE_UI_CAPABILITY_TICKET_TTL_MS = 20_000
export const IMAGE_UI_CAPABILITY_TICKET_MAX_FUTURE_MS = 30_000

const STANDALONE_OWNER = {
  kind: 'standalone' as const,
  owner_id: 'local_workbench' as const,
}

type ImageUiTicketOwner = typeof STANDALONE_OWNER

export type ImageUiCapabilityTicketClaims = {
  v: typeof IMAGE_UI_CAPABILITY_TICKET_VERSION
  method: string
  path_query: string
  host: string
  origin: string
  body_hash: `sha256:${string}`
  range: string
  owner: ImageUiTicketOwner
  project_id?: string
  resource_ids: string[]
  issued_at: number
  expires_at: number
  nonce: string
}

export type ImageUiTicketRequest = {
  method: string
  url: URL
  body: string
  range?: string | null
}

type ParsedImageUiTicket = {
  claims: ImageUiCapabilityTicketClaims
  payload: string
  signature: string
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    return Buffer.from(value, 'base64url')
  } catch {
    return null
  }
}

function requestPathQuery(url: URL): string {
  return `${url.pathname}${url.search}`
}

function requestHash(body: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
}

function idsForImagePath(url: URL): { project_id?: string; resource_ids: string[] } {
  const parts = url.pathname.split('/').filter(Boolean)
  const staticPart = new Set([
    'api', 'images', 'projects', 'deletions', 'operations', 'commands', 'cancel', 'quick-create',
    'campaigns', 'items', 'estimate', 'confirm', 'confirm-retry', 'start', 'retry', 'brand-kits',
    'templates', 'asset-grants', 'revisions', 'trash', 'inspiration-board', 'references', 'content',
    'remove', 'delivery-spec', 'delivery-specs', 'versions', 'visual-assessments', 'artboards',
    'select-version', 'canvases', 'preflight', 'preflights', 'render', 'renders', 'exports',
    'delivery-sets', 'export-receipts', 'creative-plans', 'understanding', 'generation-rounds',
    'candidate-groups', 'candidates', 'decisions', 'adoptions', 'derivations', 'library', 'projection',
    'brief', 'compile', 'apply-overrides', 'layer-assets', 'outputs', 'export-assets', 'submit',
  ])
  const projectIndex = parts.indexOf('projects')
  const project_id = projectIndex >= 0 ? parts[projectIndex + 1] : undefined
  const resource_ids = parts.filter(part => !staticPart.has(part) && /^[a-z0-9][a-z0-9_-]{7,79}$/.test(part))
  return {
    ...(project_id && /^[a-z0-9][a-z0-9_-]{7,79}$/.test(project_id) ? { project_id } : {}),
    resource_ids,
  }
}

function isClaims(value: unknown): value is ImageUiCapabilityTicketClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const claims = value as Record<string, unknown>
  const owner = claims.owner
  return claims.v === IMAGE_UI_CAPABILITY_TICKET_VERSION
    && typeof claims.method === 'string'
    && typeof claims.path_query === 'string'
    && typeof claims.host === 'string'
    && typeof claims.origin === 'string'
    && typeof claims.body_hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(claims.body_hash)
    && typeof claims.range === 'string'
    && (!('project_id' in claims) || typeof claims.project_id === 'string')
    && Array.isArray(claims.resource_ids) && claims.resource_ids.every(value => typeof value === 'string')
    && Number.isSafeInteger(claims.issued_at)
    && Number.isSafeInteger(claims.expires_at)
    && typeof claims.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(claims.nonce)
    && !!owner && typeof owner === 'object' && !Array.isArray(owner)
    && (owner as Record<string, unknown>).kind === STANDALONE_OWNER.kind
    && (owner as Record<string, unknown>).owner_id === STANDALONE_OWNER.owner_id
}

function parseTicket(value: string): ParsedImageUiTicket | null {
  const match = /^bbimg1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value)
  if (!match) return null
  const encoded = decodeBase64url(match[1]!)
  if (!encoded) return null
  try {
    const claims = JSON.parse(encoded.toString('utf8')) as unknown
    return isClaims(claims) ? { claims, payload: match[1]!, signature: match[2]! } : null
  } catch {
    return null
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/** Main-process-only signing helper. The secret must never cross Preload. */
export function issueImageUiCapabilityTicket(
  secret: string,
  request: ImageUiTicketRequest,
  options: { now?: number; nonce?: string; ttlMs?: number } = {},
): string {
  if (secret.trim().length < 32) throw new Error('Image UI ticket secret is too short')
  const now = options.now ?? Date.now()
  const ttlMs = Math.max(1_000, Math.min(IMAGE_UI_CAPABILITY_TICKET_TTL_MS, options.ttlMs ?? IMAGE_UI_CAPABILITY_TICKET_TTL_MS))
  const ids = idsForImagePath(request.url)
  const claims: ImageUiCapabilityTicketClaims = {
    v: IMAGE_UI_CAPABILITY_TICKET_VERSION,
    method: request.method.toUpperCase(),
    path_query: requestPathQuery(request.url),
    host: request.url.host,
    origin: request.url.origin,
    body_hash: requestHash(request.body),
    // Range is part of the HTTP request identity. Do not normalize it: a
    // proxy or caller must not be able to change the byte range after Main
    // signs the request, even if two forms happen to be semantically similar.
    range: request.range ?? '',
    owner: STANDALONE_OWNER,
    ...ids,
    issued_at: now,
    expires_at: now + ttlMs,
    nonce: options.nonce ?? randomBytes(18).toString('base64url'),
  }
  const payload = base64url(JSON.stringify(claims))
  return `bbimg1.${payload}.${hmac(secret, payload)}`
}

/** In-memory replay ledger scoped to one image sidecar process. */
export class ImageUiCapabilityReplayGuard {
  private readonly used = new Map<string, number>()

  consume(nonce: string, expiresAt: number, now = Date.now()): boolean {
    for (const [candidate, expiry] of this.used) {
      if (expiry < now) this.used.delete(candidate)
    }
    if (this.used.has(nonce)) return false
    this.used.set(nonce, expiresAt)
    return true
  }
}

/** Validate a ticket against the exact raw HTTP request before JSON parsing. */
export function verifyImageUiCapabilityTicket(
  secret: string,
  ticket: string,
  request: ImageUiTicketRequest,
  replayGuard: ImageUiCapabilityReplayGuard,
  now = Date.now(),
): ImageUiCapabilityTicketClaims | null {
  if (secret.trim().length < 32) return null
  const parsed = parseTicket(ticket)
  if (!parsed || !safeEqual(parsed.signature, hmac(secret, parsed.payload))) return null
  const { claims } = parsed
  const ids = idsForImagePath(request.url)
  const requestMethod = request.method.toUpperCase()
  if (
    claims.method !== requestMethod
    || claims.path_query !== requestPathQuery(request.url)
    || claims.host !== request.url.host
    || claims.origin !== request.url.origin
    || claims.body_hash !== requestHash(request.body)
    || claims.range !== (request.range ?? '')
    || claims.owner.kind !== STANDALONE_OWNER.kind
    || claims.owner.owner_id !== STANDALONE_OWNER.owner_id
    || claims.project_id !== ids.project_id
    || JSON.stringify(claims.resource_ids) !== JSON.stringify(ids.resource_ids)
    || claims.issued_at > now
    || claims.expires_at <= now
    || claims.expires_at - claims.issued_at > IMAGE_UI_CAPABILITY_TICKET_TTL_MS
    || claims.expires_at > now + IMAGE_UI_CAPABILITY_TICKET_MAX_FUTURE_MS
  ) return null
  return replayGuard.consume(claims.nonce, claims.expires_at, now) ? claims : null
}
