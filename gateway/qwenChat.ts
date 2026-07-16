type Env = Record<string, string | undefined>

export interface QwenRetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export class QwenRequestError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'QwenRequestError'
  }
}

const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/

/**
 * 服务器允许的模型集合:`GW_QWEN_MODEL` 为主模型,`GW_QWEN_MODELS`(逗号分隔)可追加更多。
 * 客户端请求的 model 若不在集合内会被强制改写为主模型,客户端无法绕过白名单。
 */
export function loadQwenAllowedModels(env: Env): ReadonlySet<string> {
  const set = new Set<string>()
  const primary = (env.GW_QWEN_MODEL ?? '').trim()
  if (MODEL_PATTERN.test(primary)) set.add(primary)
  for (const model of (env.GW_QWEN_MODELS ?? '').split(',').map(m => m.trim()).slice(0, 16)) {
    if (MODEL_PATTERN.test(model)) set.add(model)
  }
  return set
}

/**
 * 归一化聊天请求体:
 * - 只允许服务器配置的模型;客户端 model 不在白名单时强制改写为 `defaultModel`,客户端不能绕过。
 * - 不做任何原生 web_search 注入 —— Agent 联网搜索走独立、受管的 `/v1/web_search` 工具。
 * 其余字段(messages / tools / tool_choice / stream / temperature …)原样透传,保持 OpenAI
 * Chat Completions 请求契约。
 */
export function prepareQwenChatBody(
  rawBody: string,
  allowedModels: ReadonlySet<string>,
  defaultModel: string,
): { body: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new QwenRequestError(400, '模型请求不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new QwenRequestError(400, '模型请求必须是 JSON 对象')

  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    throw new QwenRequestError(400, '模型请求 tools 必须是数组')
  }

  const requested = typeof parsed.model === 'string' ? parsed.model : ''
  const model = allowedModels.has(requested) ? requested : defaultModel
  if (!MODEL_PATTERN.test(model)) throw new QwenRequestError(503, '模型服务未配置')
  return model === requested ? { body: rawBody } : { body: JSON.stringify({ ...parsed, model }) }
}

export async function fetchQwenWithRetry(
  doRequest: (attempt: number) => Promise<Response>,
  opts: QwenRetryOptions,
): Promise<{ response: Response; attempts: number }> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const random = opts.random ?? Math.random

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new QwenRequestError(499, '请求已取消')
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
      if (error instanceof QwenRequestError) throw error
      if (attempt >= opts.maxRetries || opts.signal?.aborted || isAbortError(error)) throw error
      await sleep(jitteredBackoff(attempt, opts, random))
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function jitteredBackoff(attempt: number, opts: QwenRetryOptions, random: () => number): number {
  const base = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt)
  return Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.25))
}

function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  opts: QwenRetryOptions,
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
