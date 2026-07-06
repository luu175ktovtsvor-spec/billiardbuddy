import type { FetchLike } from '../proxy/ProxyModel'

type ProxyRequestInit = RequestInit & { proxy?: string }

export type NetworkProxyMode = 'direct' | 'system' | 'manual'

export interface NetworkSettings {
  aiRequestTimeoutMs: number
  proxy: {
    mode: NetworkProxyMode
    url: string
  }
}

export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 600_000
export const MIN_AI_REQUEST_TIMEOUT_MS = 30_000
export const MAX_AI_REQUEST_TIMEOUT_MS = 1_800_000

const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'] as const

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseProxyMode(value: unknown): NetworkProxyMode {
  return value === 'system' || value === 'manual' || value === 'direct' ? value : 'direct'
}

function clampTimeoutMs(value: number): number {
  return Math.min(Math.max(Math.round(value), MIN_AI_REQUEST_TIMEOUT_MS), MAX_AI_REQUEST_TIMEOUT_MS)
}

function parseTimeoutMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return clampTimeoutMs(value)
  if (typeof value === 'string' && value.trim()) {
    const n = Number.parseInt(value, 10)
    if (Number.isFinite(n)) return clampTimeoutMs(n)
  }
  return DEFAULT_AI_REQUEST_TIMEOUT_MS
}

function envProxyUrl(env: Record<string, string | undefined>): string {
  return clean(env.https_proxy) || clean(env.HTTPS_PROXY) || clean(env.http_proxy) || clean(env.HTTP_PROXY)
}

export function normalizeNetworkSettings(value: unknown): NetworkSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawNetwork = record.network && typeof record.network === 'object'
    ? record.network as Record<string, unknown>
    : record
  const rawProxy = rawNetwork.proxy && typeof rawNetwork.proxy === 'object'
    ? rawNetwork.proxy as Record<string, unknown>
    : {}

  return {
    aiRequestTimeoutMs: parseTimeoutMs(rawNetwork.aiRequestTimeoutMs ?? rawNetwork.timeoutMs),
    proxy: {
      mode: parseProxyMode(rawProxy.mode ?? rawNetwork.proxyMode),
      url: clean(rawProxy.url ?? rawNetwork.proxyUrl),
    },
  }
}

export function networkSettingsFromEnv(env: Record<string, string | undefined> = process.env): NetworkSettings {
  return normalizeNetworkSettings({
    aiRequestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS ?? env.API_TIMEOUT_MS,
    proxy: {
      mode: env.NETWORK_PROXY_MODE ?? env.PROXY_MODE,
      url: env.NETWORK_PROXY_URL ?? env.PROXY_URL,
    },
  })
}

export function mergeLoopbackNoProxy(existing: string | undefined): string {
  const entries = (existing ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
  const lower = new Set(entries.map(entry => entry.toLowerCase()))
  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!lower.has(entry.toLowerCase())) entries.push(entry)
  }
  return entries.join(',')
}

export function shouldBypassProxy(targetUrl: string | URL, noProxy = ''): boolean {
  const list = noProxy.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean)
  if (list.includes('*')) return true
  let url: URL
  try {
    url = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl))
  } catch {
    return false
  }
  const hostname = url.hostname.replace(/^\[(.*)]$/, '$1').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const pattern of list) {
    if (!pattern) continue
    const bracketed = pattern.match(/^\[(.+)]:(\d+)$/)
    if (bracketed) {
      if (hostname === bracketed[1] && port === bracketed[2]) return true
      continue
    }
    const colonCount = (pattern.match(/:/g) ?? []).length
    if (colonCount === 1 && !pattern.startsWith('.')) {
      if (`${hostname}:${port}` === pattern) return true
      continue
    }
    if (pattern.startsWith('.')) {
      const suffix = pattern.slice(1)
      if (hostname === suffix || hostname.endsWith(pattern)) return true
      continue
    }
    if (hostname === pattern) return true
  }
  return false
}

export function buildNetworkEnvironment(
  settings: NetworkSettings,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    API_TIMEOUT_MS: String(settings.aiRequestTimeoutMs),
  }

  if (settings.proxy.mode === 'direct') {
    for (const key of PROXY_ENV_KEYS) env[key] = ''
    return env
  }

  const noProxy = mergeLoopbackNoProxy(baseEnv.no_proxy || baseEnv.NO_PROXY)
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy

  const proxyUrl = settings.proxy.mode === 'manual' ? settings.proxy.url.trim() : ''
  if (proxyUrl) {
    for (const key of PROXY_ENV_KEYS) env[key] = proxyUrl
  }
  return env
}

function targetUrlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input)
}

function patchEnv<T>(patch: Record<string, string>, env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = new Map<string, string | undefined>()
  for (const key of [...PROXY_ENV_KEYS, ...NO_PROXY_ENV_KEYS, 'API_TIMEOUT_MS']) {
    old.set(key, env[key])
  }
  for (const [key, value] of Object.entries(patch)) {
    env[key] = value
  }
  return fn().finally(() => {
    for (const [key, value] of old) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  })
}

export function createNetworkAwareFetch(
  settings: NetworkSettings,
  fetchImpl: FetchLike = globalThis.fetch,
  env: Record<string, string | undefined> = process.env,
): FetchLike {
  return async (input, init) => {
    const target = targetUrlOf(input)
    const noProxy = mergeLoopbackNoProxy(env.no_proxy || env.NO_PROXY)
    const bypass = shouldBypassProxy(target, noProxy)
    const patch = buildNetworkEnvironment(settings, env)
    const nextInit: ProxyRequestInit = { ...init }

    if (bypass) {
      for (const key of PROXY_ENV_KEYS) patch[key] = ''
    } else if (settings.proxy.mode === 'manual' && settings.proxy.url.trim()) {
      nextInit.proxy = settings.proxy.url.trim()
    } else if (settings.proxy.mode === 'system') {
      const proxyUrl = envProxyUrl(env)
      if (proxyUrl) nextInit.proxy = proxyUrl
    }

    return patchEnv(patch, env, () => fetchImpl(input, nextInit))
  }
}
