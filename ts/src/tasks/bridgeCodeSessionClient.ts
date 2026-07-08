import type { FetchLike } from '../proxy/ProxyModel'

export interface BridgeCodeSessionClientConfig {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

export interface BridgeCodeSessionCreateOptions {
  title: string
  tags?: string[]
}

export interface BridgeRemoteCredentials {
  workerJwt: string
  apiBaseUrl: string
  expiresIn: number
  workerEpoch: number
}

export type BridgeCodeSessionResult<T> =
  | { ok: true; value: T; status: number }
  | { ok: false; status?: number; error: string }

const DEFAULT_TIMEOUT_MS = 30_000
const ANTHROPIC_VERSION = '2023-06-01'

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('bridge code session baseUrl is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'))) {
    throw new Error('bridge code session baseUrl must use HTTPS or localhost HTTP')
  }
  return trimmed
}

function sessionIdPath(sessionId: string): string {
  const trimmed = sessionId.trim()
  if (!trimmed) throw new Error('sessionId is required')
  return encodeURIComponent(trimmed)
}

function oauthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

function fetchWithTimeout(config: BridgeCodeSessionClientConfig, input: string, init: RequestInit): Promise<Response> {
  const doFetch = config.fetchImpl ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!timeoutMs) return doFetch(input, init)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return doFetch(input, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

async function responseText(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 300)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseSessionId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.session)) return null
  const id = value.session.id
  return typeof id === 'string' && id.startsWith('cse_') ? id : null
}

function parseWorkerEpoch(value: unknown): number | null {
  const epoch = typeof value === 'string' ? Number(value) : value
  return typeof epoch === 'number' && Number.isFinite(epoch) && Number.isSafeInteger(epoch) ? epoch : null
}

function parseCredentials(value: unknown): BridgeRemoteCredentials | null {
  if (!isRecord(value)) return null
  if (typeof value.worker_jwt !== 'string') return null
  if (typeof value.api_base_url !== 'string') return null
  if (typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in)) return null
  const workerEpoch = parseWorkerEpoch(value.worker_epoch)
  if (workerEpoch === null) return null
  return {
    workerJwt: value.worker_jwt,
    apiBaseUrl: value.api_base_url,
    expiresIn: value.expires_in,
    workerEpoch,
  }
}

export function createBridgeCodeSessionClient(config: BridgeCodeSessionClientConfig) {
  return {
    async createCodeSession(options: BridgeCodeSessionCreateOptions): Promise<BridgeCodeSessionResult<string>> {
      let baseUrl: string
      try {
        baseUrl = normalizeBaseUrl(config.baseUrl)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (!config.token.trim()) return { ok: false, error: 'bridge code session token is required' }
      try {
        const response = await fetchWithTimeout(config, `${baseUrl}/v1/code/sessions`, {
          method: 'POST',
          headers: oauthHeaders(config.token),
          body: JSON.stringify({
            title: options.title,
            bridge: {},
            ...(options.tags?.length ? { tags: options.tags } : {}),
          }),
        })
        if (response.status !== 200 && response.status !== 201) {
          const detail = await responseText(response)
          return { ok: false, status: response.status, error: `Code session create failed ${response.status}${detail ? `: ${detail}` : ''}` }
        }
        const id = parseSessionId(await response.json().catch(() => null))
        if (!id) return { ok: false, status: response.status, error: 'Code session create response missing cse_* session.id' }
        return { ok: true, value: id, status: response.status }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async fetchRemoteCredentials(sessionId: string, trustedDeviceToken?: string): Promise<BridgeCodeSessionResult<BridgeRemoteCredentials>> {
      let baseUrl: string
      try {
        baseUrl = normalizeBaseUrl(config.baseUrl)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (!config.token.trim()) return { ok: false, error: 'bridge code session token is required' }
      const headers = oauthHeaders(config.token)
      if (trustedDeviceToken?.trim()) headers['X-Trusted-Device-Token'] = trustedDeviceToken.trim()
      try {
        const response = await fetchWithTimeout(config, `${baseUrl}/v1/code/sessions/${sessionIdPath(sessionId)}/bridge`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        })
        if (response.status !== 200) {
          const detail = await responseText(response)
          return { ok: false, status: response.status, error: `Code session bridge failed ${response.status}${detail ? `: ${detail}` : ''}` }
        }
        const credentials = parseCredentials(await response.json().catch(() => null))
        if (!credentials) return { ok: false, status: response.status, error: 'Code session bridge response missing worker_jwt, api_base_url, expires_in, or worker_epoch' }
        return { ok: true, value: credentials, status: response.status }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
