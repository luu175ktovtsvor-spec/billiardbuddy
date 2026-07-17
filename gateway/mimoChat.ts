type Env = Record<string, string | undefined>

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
const DEFAULT_MIMO_MODEL = 'mimo-v2.5'

/**
 * 服务器允许的 MiMo 模型集合:`GW_MIMO_MODEL` 为主模型,`GW_MIMO_MODELS`(逗号分隔)可追加更多。
 * 都没配时回落到默认 `mimo-v2.5`。客户端请求的 model 若不在集合内会被强制改写为主模型,
 * 客户端无法绕过白名单。
 */
export function loadMimoAllowedModels(env: Env): ReadonlySet<string> {
  const set = new Set<string>()
  const primary = (env.GW_MIMO_MODEL ?? '').trim()
  if (MODEL_PATTERN.test(primary)) set.add(primary)
  for (const model of (env.GW_MIMO_MODELS ?? '').split(',').map(m => m.trim()).slice(0, 16)) {
    if (MODEL_PATTERN.test(model)) set.add(model)
  }
  if (set.size === 0) set.add(DEFAULT_MIMO_MODEL)
  return set
}

/**
 * 归一化 MiMo 聊天请求体:
 * - 只允许服务器配置的模型;客户端 model 不在白名单时强制改写为 `defaultModel`,客户端不能绕过。
 * - **默认关闭 MiMo 思考模式**(`thinking:{type:'disabled'}`),除非客户端已显式带 `thinking`。
 *   原因(官方核实):MiMo 默认思考开,对普通/Agent 请求会先思考几分钟再答(实测单请求 ~360s),
 *   且官方明确"思考 + 工具调用不稳定,tool_calls 会混进 reasoning_content"。MiMo 是产品默认模型、
 *   Agent 工具循环高频调用,所以默认关思考保证快而稳;需要思考时客户端显式传 `thinking:{type:'enabled'}`。
 * - 不做任何原生 web_search 注入 —— Agent 联网搜索走自身 WebSearchTool(用户自有 key)。
 * 其余字段(messages / tools / tool_choice / stream / temperature …)原样透传,保持 OpenAI
 * Chat Completions 请求契约。
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
    throw new MimoRequestError(400, '模型请求不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new MimoRequestError(400, '模型请求必须是 JSON 对象')

  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    throw new MimoRequestError(400, '模型请求 tools 必须是数组')
  }

  const requested = typeof parsed.model === 'string' ? parsed.model : ''
  const model = allowedModels.has(requested) ? requested : defaultModel
  if (!MODEL_PATTERN.test(model)) throw new MimoRequestError(503, '模型服务未配置')
  const injectThinkingOff = parsed.thinking === undefined
  if (model === requested && !injectThinkingOff) return { body: rawBody }
  const next: Record<string, unknown> = { ...parsed, model }
  if (injectThinkingOff) next.thinking = { type: 'disabled' }
  return { body: JSON.stringify(next) }
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
