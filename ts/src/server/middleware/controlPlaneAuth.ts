import { timingSafeEqual } from 'node:crypto'
import { controlWebSocketProtocol } from '../../../shared/contracts/desktop-host'

function equalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function bearerToken(req: Request): string | undefined {
  const value = req.headers.get('authorization')
  if (!value) return undefined
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim()
}

export function websocketControlProtocol(token: string): string {
  return controlWebSocketProtocol(token)
}

export function requestedWebSocketControlProtocol(req: Request, expectedToken: string): string | undefined {
  const expected = websocketControlProtocol(expectedToken)
  const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(value => value.trim())
  return protocols.find(protocol => equalToken(protocol, expected))
}

export function hasControlPlaneAccess(
  req: Request,
  expectedToken: string | undefined,
  options: { allowQueryToken?: boolean } = {},
): boolean {
  if (!expectedToken) return true
  if (equalToken(bearerToken(req), expectedToken)) return true
  if (requestedWebSocketControlProtocol(req, expectedToken)) return true
  if (options.allowQueryToken) {
    const queryToken = new URL(req.url).searchParams.get('access_token') ?? undefined
    if (equalToken(queryToken, expectedToken)) return true
  }
  return false
}

export function isTrustedWebSocketOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  if (origin === 'null' || origin === 'file://') return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  } catch {
    return false
  }
}
