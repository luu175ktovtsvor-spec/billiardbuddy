type Env = Record<string, string | undefined>

export interface MimoNativeSearchConfig {
  enabled: boolean
  maxKeyword: number
  limit: number
}

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

const SEARCH_MODELS = new Set(['mimo-v2.5', 'mimo-v2.5-pro'])
const DEFAULT_ALLOWED_MODELS = ['mimo-v2.5']
const MAX_KEYWORD_CAP = 5
const RESULT_LIMIT_CAP = 5

export function loadMimoNativeSearchConfig(env: Env): MimoNativeSearchConfig {
  return {
    enabled: env.GW_MIMO_NATIVE_WEB_SEARCH === '1',
    maxKeyword: boundedInt(env.GW_MIMO_WEB_SEARCH_MAX_KEYWORD, 5, 1, MAX_KEYWORD_CAP),
    limit: boundedInt(env.GW_MIMO_WEB_SEARCH_LIMIT, 5, 1, RESULT_LIMIT_CAP),
  }
}

export function loadMimoAllowedModels(env: Env): ReadonlySet<string> {
  const configured = (env.GW_MIMO_MODELS ?? '')
    .split(',')
    .map(model => model.trim())
    .filter(model => /^[A-Za-z0-9._:-]{1,120}$/.test(model))
    .slice(0, 16)
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_MODELS)
}

export function prepareMimoChatBody(
  rawBody: string,
  search: MimoNativeSearchConfig,
  allowedModels: ReadonlySet<string>,
): { body: string; nativeSearchAvailable: boolean } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new MimoRequestError(400, '模型请求不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new MimoRequestError(400, '模型请求必须是 JSON 对象')

  const model = typeof parsed.model === 'string' ? parsed.model : ''
  if (!allowedModels.has(model)) throw new MimoRequestError(400, '当前模型不可用')
  const nativeSearchAvailable = search.enabled && SEARCH_MODELS.has(model)
  if (!nativeSearchAvailable) return { body: rawBody, nativeSearchAvailable: false }

  const rawTools = parsed.tools
  if (rawTools !== undefined && !Array.isArray(rawTools)) {
    throw new MimoRequestError(400, '模型请求 tools 必须是数组')
  }
  const tools = [...(rawTools ?? [])]
  const existingIndex = tools.findIndex(tool => isRecord(tool) && tool.type === 'web_search')
  const existing = existingIndex >= 0 && isRecord(tools[existingIndex]) ? tools[existingIndex] : {}
  const maxKeyword = boundedNumber(existing.max_keyword, search.maxKeyword, 1, search.maxKeyword)
  const limit = boundedNumber(existing.limit, search.limit, 1, search.limit)
  const nativeTool = {
    ...existing,
    type: 'web_search',
    max_keyword: maxKeyword,
    force_search: false,
    limit,
  }
  if (existingIndex >= 0) tools[existingIndex] = nativeTool
  else tools.push(nativeTool)

  return {
    body: JSON.stringify({ ...parsed, tools }),
    nativeSearchAvailable: true,
  }
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

export interface MimoWebSearchUsage {
  toolUsage: number
  pageUsage: number
}

export class MimoUsageTracker {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private usage?: MimoWebSearchUsage

  observe(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.processCompleteLines()
  }

  finish(): MimoWebSearchUsage | undefined {
    this.buffer += this.decoder.decode()
    const tail = this.buffer.trim()
    if (tail) this.processPayload(tail.startsWith('data:') ? tail.slice(5).trim() : tail)
    this.buffer = ''
    return this.usage
  }

  private processCompleteLines(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      this.processPayload(trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed)
    }
  }

  private processPayload(payload: string): void {
    if (!payload || payload === '[DONE]') return
    try {
      const value = JSON.parse(payload) as unknown
      if (!isRecord(value) || !isRecord(value.usage) || !isRecord(value.usage.web_search_usage)) return
      const web = value.usage.web_search_usage
      const toolUsage = nonNegativeInt(web.tool_usage)
      const pageUsage = nonNegativeInt(web.page_usage)
      if (toolUsage !== undefined || pageUsage !== undefined) {
        this.usage = { toolUsage: toolUsage ?? 0, pageUsage: pageUsage ?? 0 }
      }
    } catch {
      // Observability must never affect the proxied response.
    }
  }
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw === undefined ? fallback : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

function boundedNumber(raw: unknown, fallback: number, min: number, max: number): number {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(min, Math.min(max, Math.trunc(raw)))
    : fallback
}

function nonNegativeInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : undefined
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
