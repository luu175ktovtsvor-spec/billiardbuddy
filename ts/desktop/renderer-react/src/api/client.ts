// REST 客户端(对齐 cc api/client 的可变 baseUrl 设计)。
// 默认端口 = 我们 sidecar 首选口 8850(实际以 IPC getServerUrl 为准,initializeDesktopServerUrl 会 setBaseUrl)。
const ENV_BASE_URL =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env?.VITE_DESKTOP_SERVER_URL === 'string' &&
  import.meta.env.VITE_DESKTOP_SERVER_URL.length > 0
    ? import.meta.env.VITE_DESKTOP_SERVER_URL
    : undefined

const DEFAULT_BASE_URL = ENV_BASE_URL || 'http://127.0.0.1:8850'
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

let baseUrl = DEFAULT_BASE_URL
let authToken: string | null = null

export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, '')
}
export function getBaseUrl() {
  return baseUrl
}
export function getDefaultBaseUrl() {
  return DEFAULT_BASE_URL
}
export function hasExplicitDefaultBaseUrl() {
  return Boolean(ENV_BASE_URL)
}
export function setAuthToken(token: string | null) {
  const trimmed = token?.trim() ?? ''
  authToken = trimmed.length > 0 ? trimmed : null
}
export function getAuthToken() {
  return authToken
}

export async function fetchBinary(url: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new ApiError(res.status, `文件读取失败 (${res.status})`)
  return await res.blob()
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown) {
    super(typeof body === 'string' && body ? body : `API error ${status}`)
    this.status = status
    this.body = body
    this.name = 'ApiError'
  }
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authToken) headers.Authorization = `Bearer ${authToken}`
  return headers
}

async function request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number }): Promise<T> {
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  const controller = new AbortController()
  const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) {
      const errorBody = await res.json().catch(() => res.text().catch(() => ''))
      throw new ApiError(res.status, errorBody)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  } catch (err) {
    clearTimeout(timeout)
    if (controller.signal.aborted) {
      throw new Error(`请求超时(${Math.round(timeoutMs / 1000)}s)`)
    }
    throw err
  }
}

export const api = {
  get: <T>(path: string, options?: { timeout?: number }) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: { timeout?: number }) => request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
