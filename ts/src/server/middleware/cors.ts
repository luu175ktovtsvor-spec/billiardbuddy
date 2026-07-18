/**
 * CORS middleware for the local desktop sidecar.
 *
 * The server is loopback-only, and only desktop or loopback browser origins
 * may read its responses. This deliberately leaves no exception for retired
 * LAN/H5 clients.
 */

function baseCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

const LOCAL_DESKTOP_ORIGINS = new Set(['file://'])

function isLocalOrigin(origin: string): boolean {
  return LOCAL_DESKTOP_ORIGINS.has(origin) || isLoopbackBrowserOrigin(origin)
}

function isLoopbackBrowserOrigin(origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false
  }

  const hostname = parsed.hostname
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()

  if (hostname === 'localhost' || hostname === '::1') {
    return true
  }

  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => {
    if (!/^\d+$/.test(part)) return false
    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

export function corsHeaders(origin?: string | null): Record<string, string> {
  const headers = baseCorsHeaders()
  if (origin && isLocalOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export type CorsResolution = {
  allowed: boolean
  rejected: boolean
  headers: Record<string, string>
}

export async function resolveCors(origin?: string | null): Promise<CorsResolution> {
  if (!origin) {
    return {
      allowed: true,
      rejected: false,
      headers: corsHeaders(origin),
    }
  }

  if (isLocalOrigin(origin)) {
    return {
      allowed: true,
      rejected: false,
      headers: corsHeaders(origin),
    }
  }

  return {
    allowed: false,
    rejected: true,
    headers: baseCorsHeaders(),
  }
}
