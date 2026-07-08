import { randomUUID } from 'node:crypto'
import type { FetchLike } from '../proxy/ProxyModel'
import type { BridgeRemoteOutboxItem } from './bridgeRemoteState'

export interface BridgeRemoteTransportConfig {
  baseUrl: string
  token: string
  orgUuid?: string
  betaHeader?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

export interface BridgeRemoteTransportResult {
  ok: boolean
  status?: number
  error?: string
}

export type RemoteMessageContent = string | Array<{ type: string; [key: string]: unknown }>

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_BETA_HEADER = 'ccr-byoc-2025-07-29'

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('bridge remote baseUrl is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'))) {
    throw new Error('bridge remote baseUrl must use HTTPS or localhost HTTP')
  }
  return trimmed
}

function sessionIdPath(sessionId: string): string {
  const trimmed = sessionId.trim()
  if (!trimmed) throw new Error('sessionId is required')
  return encodeURIComponent(trimmed)
}

function headersFor(config: BridgeRemoteTransportConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if (config.betaHeader !== '') headers['anthropic-beta'] = config.betaHeader ?? DEFAULT_BETA_HEADER
  if (config.orgUuid) headers['x-organization-uuid'] = config.orgUuid
  return headers
}

function fetchWithTimeout(config: BridgeRemoteTransportConfig, input: string, init: RequestInit): Promise<Response> {
  const doFetch = config.fetchImpl ?? globalThis.fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!timeoutMs) return doFetch(input, init)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return doFetch(input, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

async function postSessionEvents(config: BridgeRemoteTransportConfig, sessionId: string, events: Record<string, unknown>[]): Promise<BridgeRemoteTransportResult> {
  let baseUrl: string
  try {
    baseUrl = normalizeBaseUrl(config.baseUrl)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (!config.token.trim()) return { ok: false, error: 'bridge remote token is required' }
  try {
    const response = await fetchWithTimeout(config, `${baseUrl}/v1/sessions/${sessionIdPath(sessionId)}/events`, {
      method: 'POST',
      headers: headersFor(config),
      body: JSON.stringify({ events }),
    })
    if (response.status === 200 || response.status === 201 || response.status === 202 || response.status === 204) {
      return { ok: true, status: response.status }
    }
    const detail = await response.text().catch(() => '')
    return { ok: false, status: response.status, error: `Remote Control event POST failed ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function createBridgeRemoteTransport(config: BridgeRemoteTransportConfig) {
  return {
    async sendUserMessage(sessionId: string, content: RemoteMessageContent, opts: { uuid?: string } = {}): Promise<BridgeRemoteTransportResult> {
      return postSessionEvents(config, sessionId, [{
        uuid: opts.uuid ?? randomUUID(),
        session_id: sessionId,
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content,
        },
      }])
    },

    async sendOutboxItem(item: BridgeRemoteOutboxItem): Promise<BridgeRemoteTransportResult> {
      return postSessionEvents(config, item.sessionId, [item.payload])
    },
  }
}

export function bridgeRemoteConfigFromEnv(env: Record<string, string | undefined> = process.env): BridgeRemoteTransportConfig | null {
  const baseUrl = env.BRIDGE_REMOTE_BASE_URL ?? env.REMOTE_CONTROL_BASE_URL ?? env.ANTHROPIC_BASE_URL
  const token = env.BRIDGE_REMOTE_TOKEN ?? env.REMOTE_CONTROL_TOKEN ?? env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY
  if (!baseUrl || !token) return null
  return {
    baseUrl,
    token,
    orgUuid: env.BRIDGE_REMOTE_ORG_UUID ?? env.REMOTE_CONTROL_ORG_UUID ?? env.ANTHROPIC_ORG_UUID,
    betaHeader: env.BRIDGE_REMOTE_BETA_HEADER,
    timeoutMs: env.BRIDGE_REMOTE_TIMEOUT_MS ? Number.parseInt(env.BRIDGE_REMOTE_TIMEOUT_MS, 10) : undefined,
  }
}
