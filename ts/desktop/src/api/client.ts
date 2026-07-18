const ENV_BASE_URL =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env?.VITE_DESKTOP_SERVER_URL === 'string' &&
  import.meta.env.VITE_DESKTOP_SERVER_URL.length > 0
    ? import.meta.env.VITE_DESKTOP_SERVER_URL
    : undefined

const DEFAULT_BASE_URL = ENV_BASE_URL || 'http://127.0.0.1:3456'

let baseUrl = DEFAULT_BASE_URL
const DIAGNOSTICS_PATH = '/api/diagnostics/events'
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export type ClientDiagnosticEventType =
  | 'client_window_error'
  | 'client_unhandled_rejection'
  | 'client_react_error_boundary'
  | 'client_api_request_failed'

export type ClientDiagnosticEvent = {
  type: ClientDiagnosticEventType
  severity?: 'debug' | 'info' | 'warn' | 'error'
}

function getErrorMessage(status: number, body: unknown) {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return body.message
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return body
  }

  return `API error ${status}`
}

export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, '')
}

export function getBaseUrl() {
  return baseUrl
}

export function getApiUrl(pathOrUrl: string) {
  try {
    return new URL(pathOrUrl).toString()
  } catch {
    const normalizedPath = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
    return `${baseUrl}${normalizedPath}`
  }
}

export function getDefaultBaseUrl() {
  return DEFAULT_BASE_URL
}

export function hasExplicitDefaultBaseUrl() {
  return Boolean(ENV_BASE_URL)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(getErrorMessage(status, body))
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, path: string, body?: unknown, options?: { timeout?: number }): Promise<T> {
  const url = `${baseUrl}${path}`
  const headers = { 'Content-Type': 'application/json' }

  const controller = new AbortController()
  const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const errorBody = await res.json().catch(() => res.text())
      throw new ApiError(res.status, errorBody)
    }

    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  } catch (err) {
    clearTimeout(timeout)
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
      reportApiFailure(path)
      throw timeoutError
    }
    reportApiFailure(path)
    throw err
  }
}

function reportApiFailure(path: string) {
  if (path.startsWith('/api/diagnostics')) return

  void rawRecordDiagnosticEvent({
    type: 'client_api_request_failed',
    severity: 'warn',
  })
}

export function rawRecordDiagnosticEvent(event: ClientDiagnosticEvent) {
  return fetch(`${baseUrl}${DIAGNOSTICS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).catch(() => undefined)
}

export const api = {
  get: <T>(path: string, options?: { timeout?: number }) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: { timeout?: number }) => request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
