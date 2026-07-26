import { ProductSettingsRepository } from '../product/productSettingsRepository.js'

export type NetworkProxyMode = 'direct' | 'system' | 'manual'

export type NetworkSettings = {
  aiRequestTimeoutMs: number
  proxy: {
    mode: NetworkProxyMode
    url: string
  }
}

// User-facing budget from request start until the first streamed response.
export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 600_000
export const MIN_AI_REQUEST_TIMEOUT_MS = 30_000
export const MAX_AI_REQUEST_TIMEOUT_MS = 1_800_000

const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  aiRequestTimeoutMs: DEFAULT_AI_REQUEST_TIMEOUT_MS,
  proxy: {
    mode: 'direct',
    url: '',
  },
}
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const

function isNetworkProxyMode(value: unknown): value is NetworkProxyMode {
  return value === 'direct' || value === 'system' || value === 'manual'
}

function clampTimeoutMs(value: number): number {
  return Math.min(Math.max(value, MIN_AI_REQUEST_TIMEOUT_MS), MAX_AI_REQUEST_TIMEOUT_MS)
}

function parseTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_NETWORK_SETTINGS.aiRequestTimeoutMs
  }
  return clampTimeoutMs(Math.round(value))
}

function parseProxy(value: unknown): NetworkSettings['proxy'] {
  if (!value || typeof value !== 'object') {
    return DEFAULT_NETWORK_SETTINGS.proxy
  }

  const record = value as Record<string, unknown>
  return {
    mode: isNetworkProxyMode(record.mode) ? record.mode : DEFAULT_NETWORK_SETTINGS.proxy.mode,
    url: typeof record.url === 'string' ? record.url.trim() : '',
  }
}

export function normalizeNetworkSettings(settings: unknown): NetworkSettings {
  if (!settings || typeof settings !== 'object') {
    return DEFAULT_NETWORK_SETTINGS
  }

  const record = settings as Record<string, unknown>
  const rawNetwork = record.network
  const network = rawNetwork && typeof rawNetwork === 'object'
    ? rawNetwork as Record<string, unknown>
    : {}

  return {
    aiRequestTimeoutMs: parseTimeoutMs(network.aiRequestTimeoutMs),
    proxy: parseProxy(network.proxy),
  }
}

export function getManualNetworkProxyUrl(settings: NetworkSettings): string | undefined {
  if (settings.proxy.mode !== 'manual') return undefined
  const url = settings.proxy.url.trim()
  return url || undefined
}

export function mergeLoopbackNoProxy(existing: string | undefined): string {
  const entries = (existing ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
  const lowerEntries = new Set(entries.map(entry => entry.toLowerCase()))

  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!lowerEntries.has(entry.toLowerCase())) entries.push(entry)
  }

  return entries.join(',')
}

export function buildNetworkEnvironment(
  settings: NetworkSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    API_TIMEOUT_MS: String(settings.aiRequestTimeoutMs),
  }

  if (settings.proxy.mode === 'direct') {
    env.HTTP_PROXY = ''
    env.HTTPS_PROXY = ''
    env.http_proxy = ''
    env.https_proxy = ''
    return env
  }

  const proxyUrl = getManualNetworkProxyUrl(settings)

  if (proxyUrl) {
    const noProxy = mergeLoopbackNoProxy(baseEnv.no_proxy || baseEnv.NO_PROXY)
    env.HTTP_PROXY = proxyUrl
    env.HTTPS_PROXY = proxyUrl
    env.http_proxy = proxyUrl
    env.https_proxy = proxyUrl
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }

  return env
}

export function getNetworkProxyFetchOptions(
  settings: NetworkSettings,
  targetUrl: string | URL,
): { proxy?: string } {
  const noProxy = mergeLoopbackNoProxy(process.env.no_proxy || process.env.NO_PROXY)
  const proxyUrl = settings.proxy.mode === 'manual'
    ? getManualNetworkProxyUrl(settings)
    : settings.proxy.mode === 'system'
      ? process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
      : undefined
  return proxyUrl && !shouldBypassProductProxy(targetUrl, noProxy) ? { proxy: proxyUrl } : {}
}

function shouldBypassProductProxy(targetUrl: string | URL, noProxy: string): boolean {
  let url: URL
  try { url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl) } catch { return false }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return noProxy.split(/[,\s]+/).filter(Boolean).some(raw => {
    const entry = raw.trim().toLowerCase()
    if (entry === '*') return true
    const bracketed = entry.match(/^\[(.+)](?::(\d+))?$/)
    if (bracketed) return hostname === bracketed[1] && (!bracketed[2] || bracketed[2] === port)
    const portMatch = entry.match(/^([^:]+):(\d+)$/)
    if (portMatch) return hostname === portMatch[1] && port === portMatch[2]
    const normalized = entry.startsWith('.') ? entry.slice(1) : entry
    return hostname === normalized || (entry.startsWith('.') && hostname.endsWith(entry))
  })
}

export async function loadNetworkSettings(): Promise<NetworkSettings> {
  const settings = await new ProductSettingsRepository().get()
  return normalizeNetworkSettings(settings)
}
