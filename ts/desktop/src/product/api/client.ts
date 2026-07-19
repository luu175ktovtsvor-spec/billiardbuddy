import { getServerBaseUrl } from '../../lib/desktopRuntime'

const DEFAULT_TIMEOUT_MS = 30_000

const PRODUCT_API_FALLBACK_ERROR = 'BilliardBuddy 服务暂时不可用，请稍后重试。'

const PRODUCT_API_SAFE_ERROR_MESSAGES: Record<string, string> = {
  BAD_REQUEST: '请求内容有误，请检查后重试。',
  CONFLICT: '当前内容已发生变化，请刷新后重试。',
  FORBIDDEN: '当前任务不允许执行此操作。',
  METHOD_NOT_ALLOWED: '当前操作暂不支持。',
  NOT_FOUND: '请求的任务或资源已不可用。',
  PRODUCT_TASK_REVIEW_UNAVAILABLE: '当前任务审阅暂时不可用，请稍后重试。',
  PRODUCT_TASK_STORE_ERROR: '任务数据暂时无法读取，请稍后重试。',
  PRODUCT_TASK_THREAD_UNAVAILABLE: '当前任务记录暂时无法读取，请稍后重试。',
  VOICE_TRANSCRIPTION_CANCELLED: '语音转写已取消。',
  VOICE_TRANSCRIPTION_INVALID_AUDIO: '请先录制一段有效音频后重试。',
  VOICE_TRANSCRIPTION_TOO_LARGE: '录音文件过大，请缩短后重试。',
  VOICE_TRANSCRIPTION_UNAVAILABLE: '语音转写暂时不可用，请稍后重试。',
}

function readProductApiErrorCode(body: unknown): string | null {
  if (
    body
    && typeof body === 'object'
    && 'error' in body
    && typeof body.error === 'string'
  ) {
    return body.error
  }
  return null
}

export class ProductApiError extends Error {
  public readonly code: string | null

  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const code = readProductApiErrorCode(body)
    super(readProductApiErrorMessage(code))
    this.name = 'ProductApiError'
    this.code = code
  }
}

export type ProductRequestOptions = {
  timeout?: number
  signal?: AbortSignal
}

function readProductApiErrorMessage(code: string | null): string {
  return code && PRODUCT_API_SAFE_ERROR_MESSAGES[code]
    ? PRODUCT_API_SAFE_ERROR_MESSAGES[code]
    : PRODUCT_API_FALLBACK_ERROR
}

/**
 * Product API responses are not a user-copy boundary: upstream and server
 * messages can contain implementation details. Keep status/code on
 * ProductApiError for callers that need to branch, but only render this copy.
 */
export function productApiUserFacingError(
  error: unknown,
  fallback = PRODUCT_API_FALLBACK_ERROR,
): string {
  return error instanceof ProductApiError ? error.message : fallback
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
  const abortFromCaller = () => controller.abort()
  if (options?.signal?.aborted) {
    abortFromCaller()
  } else {
    options?.signal?.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(), options?.timeout ?? DEFAULT_TIMEOUT_MS)
  const isFormData = body instanceof FormData

  try {
    const response = await fetch(buildProductApiUrl(path), {
      method,
      headers: isFormData ? undefined : buildProductApiHeaders(),
      body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
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
    options?.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export const productApi = {
  get: <T>(path: string, options?: ProductRequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: ProductRequestOptions) => request<T>('POST', path, body, options),
  postForm: <T>(path: string, body: FormData, options?: ProductRequestOptions) => request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: ProductRequestOptions) => request<T>('PATCH', path, body, options),
  delete: <T>(path: string, options?: ProductRequestOptions) => request<T>('DELETE', path, undefined, options),
}
