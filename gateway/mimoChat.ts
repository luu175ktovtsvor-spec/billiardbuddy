export interface MimoRetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export class MimoRequestError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'MimoRequestError'
  }
}

const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/

/**
 * Prepare the dedicated media-workbench request. The caller cannot select a
 * different MiMo model or smuggle an invalid tools shape through the gateway.
 */
export function prepareMimoChatBody(
  rawBody: string,
  allowedModels: ReadonlySet<string>,
  defaultModel: string,
): { body: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new MimoRequestError(400, '媒体理解请求不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new MimoRequestError(400, '媒体理解请求必须是 JSON 对象')
  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    throw new MimoRequestError(400, '媒体理解请求 tools 必须是数组')
  }

  const requested = typeof parsed.model === 'string' ? parsed.model : ''
  const model = allowedModels.has(requested) ? requested : defaultModel
  if (!MODEL_PATTERN.test(model)) throw new MimoRequestError(503, '媒体理解模型未配置')
  return model === requested ? { body: rawBody } : { body: JSON.stringify({ ...parsed, model }) }
}

export async function fetchMimoWithRetry(
  doRequest: (attempt: number) => Promise<Response>,
  opts: MimoRetryOptions,
): Promise<{ response: Response; attempts: number }> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const random = opts.random ?? Math.random

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new MimoRequestError(499, '请求已取消')
    try {
      const response = await doRequest(attempt)
      if (!isRetryableStatus(response.status) || attempt >= opts.maxRetries) {
        return { response, attempts: attempt + 1 }
      }
      try {
        await response.body?.cancel()
      } catch {
        // A retry uses a fresh request; a failed body cancellation is harmless.
      }
      await sleep(retryDelayMs(response.headers.get('retry-after'), attempt, opts, random))
    } catch (error) {
      if (error instanceof MimoRequestError) throw error
      if (attempt >= opts.maxRetries || opts.signal?.aborted || isAbortError(error)) throw error
      await sleep(jitteredBackoff(attempt, opts, random))
    }
  }
}

// 网关只重试"明确可重试的 5xx"。429 一律不重试(直接把限流回传给客户端),避免与 CC CLI
// 自身的重试相乘、把一次逻辑调用放大成对上游的多次请求。连接错误(fetch 抛出)在下面的
// catch 分支重试;调用点把 maxRetries 夹在 [0,1],所以一次逻辑调用最多只额外尝试一次。
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jitteredBackoff(attempt: number, opts: MimoRetryOptions, random: () => number): number {
  const base = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt)
  return Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.25))
}

function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  opts: MimoRetryOptions,
  random: () => number,
): number {
  const parsed = parseRetryAfterMs(retryAfter)
  return parsed ?? jitteredBackoff(attempt, opts, random)
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000)
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, Math.min(60_000, dateMs - Date.now()))
}
