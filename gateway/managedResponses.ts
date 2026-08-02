import { textReasoningRegistryEntry } from './providerRegistry'

const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/

export class ManagedResponsesRequestError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'ManagedResponsesRequestError'
  }
}

export type ManagedResponsesRetryOptions = {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function managedOutputLimit(model: string): number {
  const limit = textReasoningRegistryEntry(model)?.managed_max_output_tokens
  if (!Number.isSafeInteger(limit) || limit < 1_024) {
    throw new ManagedResponsesRequestError(503, '模型输出额度未配置')
  }
  return limit
}

/**
 * The Gateway accepts only a streamable, stateless subset of Responses.  The
 * The local Rust Codex App Server owns history and recovery, so provider-side
 * continuation IDs are intentionally rejected instead of becoming a second
 * hidden session store.
 */
export function prepareManagedResponsesBody(
  rawBody: string,
  allowedModels: ReadonlySet<string>,
  defaultModel: string,
): { body: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new ManagedResponsesRequestError(400, 'Responses 请求不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new ManagedResponsesRequestError(400, 'Responses 请求必须是 JSON 对象')
  if (!Array.isArray(parsed.input)) throw new ManagedResponsesRequestError(400, 'Responses 请求必须包含 input 数组')
  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    throw new ManagedResponsesRequestError(400, 'Responses 请求 tools 必须是数组')
  }
  if (parsed.stream !== true) throw new ManagedResponsesRequestError(400, '受管 Responses 请求必须启用流式输出')
  if (parsed.previous_response_id !== undefined || parsed.conversation !== undefined) {
    throw new ManagedResponsesRequestError(400, '受管 Responses 不接受上游会话续接')
  }

  const requested = typeof parsed.model === 'string' ? parsed.model : ''
  const model = allowedModels.has(requested) ? requested : defaultModel
  if (!MODEL_PATTERN.test(model)) throw new ManagedResponsesRequestError(503, '模型服务未配置')
  const outputLimit = managedOutputLimit(model)
  // Older local callers may still use the Chat Completions spelling. Normalize
  // it at the Gateway boundary so quota reservation and the upstream Responses
  // request use one explicit value.
  const requestedOutput = parsed.max_output_tokens ?? parsed.max_tokens
  if (
    requestedOutput !== undefined
    && (typeof requestedOutput !== 'number'
      || !Number.isSafeInteger(requestedOutput)
      || requestedOutput < 1
      || requestedOutput > outputLimit)
  ) {
    throw new ManagedResponsesRequestError(400, 'max_output_tokens 超出受管模型上限')
  }
  const maxOutputTokens = requestedOutput ?? outputLimit

  // Force this even if the caller sent true: provider-side storage would make
  // the remote account a second source of conversation truth. Core currently
  // does not expose a generic output-cap config, so the Gateway owns the
  // explicit bounded request value that also backs quota reservation.
  const { max_tokens: _legacyMaxTokens, ...responsesBody } = parsed
  const next: Record<string, unknown> = {
    ...responsesBody,
    model,
    stream: true,
    store: false,
    max_output_tokens: maxOutputTokens,
  }
  return { body: JSON.stringify(next) }
}

/**
 * A bounded retry belongs beside the only supported managed DeepSeek wire
 * protocol.  The caller supplies the request so every attempt still passes
 * through the same authenticated capacity and usage accounting path.
 */
export async function fetchManagedResponsesWithRetry(
  doRequest: (attempt: number) => Promise<Response>,
  opts: ManagedResponsesRetryOptions,
): Promise<{ response: Response; attempts: number }> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const random = opts.random ?? Math.random

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new ManagedResponsesRequestError(499, '请求已取消')
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
      if (error instanceof ManagedResponsesRequestError) throw error
      if (attempt >= opts.maxRetries || opts.signal?.aborted || isAbortError(error)) throw error
      await sleep(jitteredBackoff(attempt, opts, random))
    }
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function jitteredBackoff(
  attempt: number,
  opts: ManagedResponsesRetryOptions,
  random: () => number,
): number {
  const base = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt)
  return Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.25))
}

function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  opts: ManagedResponsesRetryOptions,
  random: () => number,
): number {
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  return jitteredBackoff(attempt, opts, random)
}
