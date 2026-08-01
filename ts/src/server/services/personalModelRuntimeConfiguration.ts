import { timingSafeEqual } from 'node:crypto'
import {
  parsePersonalModelConfiguration,
  PERSONAL_MODEL_CONFIGURATION_CAPABILITY_HEADER,
  PERSONAL_MODEL_CONFIGURATION_MAX_BYTES,
} from '../../../shared/product/personalModels.js'
import { setPersonalModelRuntimeConfiguration } from './personalModelRuntimeState.js'

export const PERSONAL_MODEL_CONFIGURATION_CAPABILITY_ENV = 'BB_PERSONAL_MODEL_CONFIGURATION_CAPABILITY'

export function consumePersonalModelConfigurationCapability(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const capability = env[PERSONAL_MODEL_CONFIGURATION_CAPABILITY_ENV]?.trim() ?? ''
  delete env[PERSONAL_MODEL_CONFIGURATION_CAPABILITY_ENV]
  return capability
}

function authorized(presented: string, expected: string): boolean {
  const actualBytes = Buffer.from(presented)
  const expectedBytes = Buffer.from(expected)
  return expectedBytes.length >= 32
    && actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes)
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > PERSONAL_MODEL_CONFIGURATION_MAX_BYTES) {
    throw new Error('PERSONAL_MODEL_CONFIGURATION_TOO_LARGE')
  }
  if (!request.body) throw new Error('PERSONAL_MODEL_CONFIGURATION_MISSING')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > PERSONAL_MODEL_CONFIGURATION_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('PERSONAL_MODEL_CONFIGURATION_TOO_LARGE')
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * Apply a Main-owned credential update without restarting the Product Server.
 * Individual provider requests resolve their target once before fetch, so an
 * in-flight request keeps its current endpoint while later calls see this value.
 */
export async function updatePersonalModelRuntimeConfiguration(
  request: Request,
  capability: string,
): Promise<Response> {
  if (request.method !== 'PUT') return new Response('Method Not Allowed', { status: 405 })
  if (!authorized(
    request.headers.get(PERSONAL_MODEL_CONFIGURATION_CAPABILITY_HEADER)?.trim() ?? '',
    capability,
  )) return new Response('Forbidden', { status: 403 })

  try {
    const raw = JSON.parse(await readBoundedBody(request)) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PERSONAL_PROVIDER_CONFIGURATION_INVALID')
    const envelope = raw as { version?: unknown; models?: unknown }
    if (envelope.version !== 1) throw new Error('PERSONAL_PROVIDER_CONFIGURATION_INVALID')
    const models = parsePersonalModelConfiguration(JSON.stringify(envelope.models))
    setPersonalModelRuntimeConfiguration(models)
    return new Response(null, { status: 204 })
  } catch {
    return new Response('Invalid personal model configuration', { status: 400 })
  }
}
