import { getServerBaseUrl } from '../../lib/desktopRuntime'

const DEFAULT_TIMEOUT_MS = 30_000

export class ProductApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readProductApiErrorMessage(status, body))
    this.name = 'ProductApiError'
  }
}

type ProductRequestOptions = {
  timeout?: number
}

function readProductApiErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return body.message
  }
  if (typeof body === 'string' && body.trim()) return body
  return `产品接口请求失败（${status}）`
}

function buildProductApiUrl(path: string): string {
  const baseUrl = getServerBaseUrl().replace(/\/$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

function buildProductApiHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: ProductRequestOptions,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options?.timeout ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(buildProductApiUrl(path), {
      method,
      headers: buildProductApiHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorBody = await response.json().catch(() => response.text())
      throw new ProductApiError(response.status, errorBody)
    }

    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  } finally {
    clearTimeout(timeout)
  }
}

export const productApi = {
  get: <T>(path: string, options?: ProductRequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: ProductRequestOptions) => request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: ProductRequestOptions) => request<T>('PATCH', path, body, options),
}
