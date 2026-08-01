import { timingSafeEqual } from 'node:crypto'
import { GATEWAY_ACCESS_TOKEN_CAPABILITY_HEADER } from '../../../shared/product/providerGateway.js'

export const GATEWAY_ACCESS_TOKEN_CAPABILITY_ENV = 'BB_GATEWAY_ACCESS_TOKEN_CAPABILITY'
const MAX_GATEWAY_ACCESS_TOKEN_BYTES = 4 * 1024
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,4096}\.[A-Za-z0-9_-]{20,256}$/

export function consumeGatewayAccessTokenCapability(env: NodeJS.ProcessEnv = process.env): string {
  const capability = env[GATEWAY_ACCESS_TOKEN_CAPABILITY_ENV]?.trim() ?? ''
  delete env[GATEWAY_ACCESS_TOKEN_CAPABILITY_ENV]
  return capability
}

function authorized(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented)
  const required = Buffer.from(expected)
  return required.length >= 32 && actual.length === required.length && timingSafeEqual(actual, required)
}

/** Rotate the current installation bearer without handing refresh credentials to the Server. */
export async function updateGatewayAccessToken(
  request: Request,
  capability: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  if (request.method !== 'PUT') return new Response('Method Not Allowed', { status: 405 })
  if (!authorized(request.headers.get(GATEWAY_ACCESS_TOKEN_CAPABILITY_HEADER)?.trim() ?? '', capability)) {
    return new Response('Forbidden', { status: 403 })
  }
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_GATEWAY_ACCESS_TOKEN_BYTES) return new Response('Invalid gateway access token', { status: 400 })
  let token: string
  try {
    if (!request.body) throw new Error('missing token')
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > MAX_GATEWAY_ACCESS_TOKEN_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new Error('token too large')
        }
        chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    token = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
  } catch {
    return new Response('Invalid gateway access token', { status: 400 })
  }
  if (Buffer.byteLength(token, 'utf8') > MAX_GATEWAY_ACCESS_TOKEN_BYTES || !ACCESS_TOKEN_PATTERN.test(token)) {
    return new Response('Invalid gateway access token', { status: 400 })
  }
  env.BB_GATEWAY_TOKEN = token
  return new Response(null, { status: 204 })
}
