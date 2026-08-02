import {
  defaultPersonalModelAuthMode,
  safePersonalModelBaseUrl,
  validPersonalModelAuthMode,
  validPersonalModelProtocol,
  type PersonalModelAuthMode,
  type PersonalModelProtocol,
} from '../../../shared/product/personalModels'
import { personalModelCatalogEntryForEndpoint } from '../../../shared/product/personalModelCatalog'

const DISCOVERY_TIMEOUT_MS = 10_000
const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_DISCOVERED_MODELS = 500

type DiscoveryFailureCode =
  | 'PERSONAL_MODEL_DISCOVERY_AUTH_FAILED'
  | 'PERSONAL_MODEL_DISCOVERY_ENDPOINT_UNSUPPORTED'
  | 'PERSONAL_MODEL_DISCOVERY_TIMEOUT'
  | 'PERSONAL_MODEL_DISCOVERY_RATE_LIMITED'
  | 'PERSONAL_MODEL_DISCOVERY_NETWORK_FAILED'
  | 'PERSONAL_MODEL_DISCOVERY_UPSTREAM_FAILED'
  | 'PERSONAL_MODEL_DISCOVERY_RESPONSE_TOO_LARGE'
  | 'PERSONAL_MODEL_DISCOVERY_INVALID_RESPONSE'

export type PersonalModelDiscoveryInput = {
  base_url: string
  api_key: string
  protocol: PersonalModelProtocol
  auth_mode?: PersonalModelAuthMode
}

export type DiscoveredPersonalModel = {
  id: string
  /** Present only for an exact, direct upstream catalog match. */
  catalog_entry_id?: string
}

export type PersonalModelDiscoveryResult = {
  models: DiscoveredPersonalModel[]
}

function validDiscoveredModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && /^[A-Za-z0-9._:/-]+$/.test(value)
}

function discoveryAuthHeader(apiKey: string, authMode: PersonalModelAuthMode): Record<string, string> {
  if (authMode === 'x-api-key') return { 'x-api-key': apiKey }
  if (authMode === 'api-key') return { 'api-key': apiKey }
  return { Authorization: `Bearer ${apiKey}` }
}

function modelsEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`
  return url.toString()
}

function discoveryFailure(code: DiscoveryFailureCode): Error { return new Error(code) }

function isDiscoveryFailure(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('PERSONAL_MODEL_DISCOVERY_')
}

function responseFailure(response: Response): DiscoveryFailureCode {
  if (response.status === 401 || response.status === 403) return 'PERSONAL_MODEL_DISCOVERY_AUTH_FAILED'
  if (response.status === 404 || response.status === 405) return 'PERSONAL_MODEL_DISCOVERY_ENDPOINT_UNSUPPORTED'
  if (response.status === 408 || response.status === 504) return 'PERSONAL_MODEL_DISCOVERY_TIMEOUT'
  if (response.status === 429) return 'PERSONAL_MODEL_DISCOVERY_RATE_LIMITED'
  return 'PERSONAL_MODEL_DISCOVERY_UPSTREAM_FAILED'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function readDiscoveryBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_DISCOVERY_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw discoveryFailure('PERSONAL_MODEL_DISCOVERY_RESPONSE_TOO_LARGE')
  }
  const reader = response.body?.getReader()
  if (!reader) throw discoveryFailure('PERSONAL_MODEL_DISCOVERY_INVALID_RESPONSE')
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_DISCOVERY_RESPONSE_BYTES) {
        await reader.cancel()
        throw discoveryFailure('PERSONAL_MODEL_DISCOVERY_RESPONSE_TOO_LARGE')
      }
      text += decoder.decode(value, { stream: true })
    }
    return `${text}${decoder.decode()}`
  } finally {
    reader.releaseLock()
  }
}

function parseDiscoveredModelIds(raw: string): string[] {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw discoveryFailure('PERSONAL_MODEL_DISCOVERY_INVALID_RESPONSE') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw discoveryFailure('PERSONAL_MODEL_DISCOVERY_INVALID_RESPONSE')
  }
  const data = (value as { data?: unknown }).data
  if (!Array.isArray(data)) throw discoveryFailure('PERSONAL_MODEL_DISCOVERY_INVALID_RESPONSE')
  return [...new Set(data.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const id = (item as { id?: unknown }).id
    return validDiscoveredModelId(id) ? [id] : []
  }))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_DISCOVERED_MODELS)
}

/**
 * This request is a discovery hint only.  It never saves the Key and it never
 * upgrades a returned model ID into a capacity contract; exact matches are
 * cross-referenced with the independently verified product catalog.
 */
export async function discoverPersonalModels(
  input: PersonalModelDiscoveryInput,
): Promise<PersonalModelDiscoveryResult> {
  const apiKey = input.api_key.trim()
  if (
    typeof input.base_url !== 'string'
    || apiKey.length < 8
    || apiKey.length > 4_096
    || /[\r\n\0]/.test(apiKey)
    || !validPersonalModelProtocol(input.protocol)
  ) throw new Error('PERSONAL_MODEL_DISCOVERY_INPUT_INVALID')
  const authMode = input.auth_mode ?? defaultPersonalModelAuthMode()
  if (!validPersonalModelAuthMode(authMode)) throw new Error('PERSONAL_MODEL_DISCOVERY_INPUT_INVALID')
  const baseUrl = safePersonalModelBaseUrl(input.base_url, input.protocol)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  ;(timeout as unknown as { unref?: () => void }).unref?.()
  let response: Response
  try {
    response = await fetch(modelsEndpoint(baseUrl), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...discoveryAuthHeader(apiKey, authMode),
      },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (error) {
    throw discoveryFailure(isAbortError(error)
      ? 'PERSONAL_MODEL_DISCOVERY_TIMEOUT'
      : 'PERSONAL_MODEL_DISCOVERY_NETWORK_FAILED')
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw discoveryFailure(responseFailure(response))
  }
  let modelIds: string[]
  try {
    modelIds = parseDiscoveredModelIds(await readDiscoveryBody(response))
  } catch (error) {
    throw isDiscoveryFailure(error)
      ? error
      : discoveryFailure('PERSONAL_MODEL_DISCOVERY_INVALID_RESPONSE')
  }
  return {
    models: modelIds.map(id => {
      const catalogEntry = personalModelCatalogEntryForEndpoint({
        base_url: baseUrl,
        model: id,
        protocol: input.protocol,
      })
      return catalogEntry ? { id, catalog_entry_id: catalogEntry.id } : { id }
    }),
  }
}
