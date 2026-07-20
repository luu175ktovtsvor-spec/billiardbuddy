import { createHash } from 'node:crypto'

type Env = Record<string, string | undefined>

export interface DeepSeekRetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export class DeepSeekRequestError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'DeepSeekRequestError'
  }
}

const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

/**
 * Anthropic's native server-side web search schema. The QF gateway handles
 * this one narrow protocol directly so the normal OpenAI-compatible chat and
 * vision-bridge path stays unchanged.
 */
export const DEEPSEEK_NATIVE_WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'

/**
 * 服务器允许的 DeepSeek 模型集合:`GW_DEEPSEEK_MODEL` 为主模型(默认 deepseek-v4-flash),
 * `GW_DEEPSEEK_MODELS`(逗号分隔)可追加更多。与 MiMo 一样,即使没配 `GW_DEEPSEEK_KEY` 也始终
 * 含默认模型 —— 这样网关能识别 DeepSeek 目标模型并在缺 key 时 fail closed(503),而不是静默改投千问。
 */
export function loadDeepSeekAllowedModels(env: Env): ReadonlySet<string> {
  const set = new Set<string>()
  const primary = (env.GW_DEEPSEEK_MODEL ?? '').trim()
  if (MODEL_PATTERN.test(primary)) set.add(primary)
  for (const model of (env.GW_DEEPSEEK_MODELS ?? '').split(',').map(m => m.trim()).slice(0, 16)) {
    if (MODEL_PATTERN.test(model)) set.add(model)
  }
  if (set.size === 0) set.add(DEFAULT_DEEPSEEK_MODEL)
  return set
}

/**
 * 由 token 归属 + 装机身份派生出一个稳定、不含隐私的 opaque user_id 传给 DeepSeek。
 * 用途:调度 / KVCache 命中 / 内容安全隔离。它是单向哈希,既不暴露原始 installationId,
 * 也不参与鉴权或提权 —— 伪造它最多改变自己的 KVCache 分桶,拿不到任何额外权限或额度。
 */
export function deepseekOpaqueUserId(user: string, client: string): string {
  const seed = client ? `${user}#${client}` : user
  return `bb_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

export type DeepSeekChatContext = { userId?: string }

function normalizeDeepSeekFunctionTools(
  value: unknown[],
): { tools: unknown[]; changed: boolean } {
  let changed = false
  const tools = value.map((tool) => {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
      return tool
    }

    const parameters = isRecord(tool.function.parameters)
      ? tool.function.parameters
      : {}
    if (parameters.type === 'object') return tool

    changed = true
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...parameters,
          type: 'object',
        },
      },
    }
  })
  return { tools, changed }
}

/**
 * The desktop Core runtime represents its enabled setting as `adaptive`, while
 * DeepSeek's OpenAI-compatible endpoint accepts only `enabled` or `disabled`.
 * Normalize that one compatibility spelling at the gateway boundary and reject
 * every other shape before it can become an opaque upstream 400.
 */
function normalizeDeepSeekThinking(value: unknown): { type: 'enabled' | 'disabled' } | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new DeepSeekRequestError(400, 'DeepSeek 思考模式必须是 enabled 或 disabled')
  }
  if (value.type === 'adaptive') return { type: 'enabled' }
  if (value.type === 'enabled' || value.type === 'disabled') return { type: value.type }
  throw new DeepSeekRequestError(400, 'DeepSeek 思考模式必须是 enabled 或 disabled')
}

/**
 * 归一化 DeepSeek 聊天请求体:
 * - 只允许服务器配置的模型;客户端 model 不在白名单时强制改写为 `defaultModel`,客户端不能绕过。
 * - 注入受信 opaque `user_id`(DeepSeek 官方字段名,非 OpenAI 的 `user`;覆盖客户端自带的任何值,
 *   防止伪造),供 DeepSeek 调度/KVCache/内容安全隔离。id 形如 bb_<hex>,匹配官方正则 [a-zA-Z0-9-_]+。
 * - 不做任何原生 web_search 注入 —— 原生检索由单独的 `/v1/messages` 路由处理；本 OpenAI
 *   Chat 请求路径不会伪造工具或绕过现有视觉桥接。
 * - Core 的 `thinking:{type:'adaptive'}` 在这里收敛为 DeepSeek 支持的 `enabled`；其它
 *   非法思考值在到达上游前失败关闭，避免设置页开关悄然失效。
 * 其余字段(messages / tools / tool_choice / stream / reasoning_effort …)原样透传,
 * 保持 OpenAI Chat Completions 请求契约。
 */
export function prepareDeepSeekChatBody(
  rawBody: string,
  allowedModels: ReadonlySet<string>,
  defaultModel: string,
  ctx?: DeepSeekChatContext,
): { body: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new DeepSeekRequestError(400, '模型请求不是合法 JSON')
  }
  if (!isRecord(parsed)) throw new DeepSeekRequestError(400, '模型请求必须是 JSON 对象')

  if (parsed.tools !== undefined && !Array.isArray(parsed.tools)) {
    throw new DeepSeekRequestError(400, '模型请求 tools 必须是数组')
  }
  const normalizedTools = Array.isArray(parsed.tools)
    ? normalizeDeepSeekFunctionTools(parsed.tools)
    : { tools: [], changed: false }

  const requested = typeof parsed.model === 'string' ? parsed.model : ''
  const model = allowedModels.has(requested) ? requested : defaultModel
  if (!MODEL_PATTERN.test(model)) throw new DeepSeekRequestError(503, '模型服务未配置')

  const userId = ctx?.userId
  const hasThinkingInput = parsed.thinking !== undefined
  const thinking = normalizeDeepSeekThinking(parsed.thinking)
  // 无改写(model 不变、无 user_id 注入、无思考参数)时原样透传,避免多一次序列化。
  if (model === requested && !userId && !hasThinkingInput && !normalizedTools.changed) {
    return { body: rawBody }
  }
  const next: Record<string, unknown> = { ...parsed, model }
  if (normalizedTools.changed) next.tools = normalizedTools.tools
  if (hasThinkingInput) {
    if (thinking) next.thinking = thinking
    else delete next.thinking
  }
  // DeepSeek 用 user_id(不是 OpenAI 的 user);删掉客户端可能自带的 user/user_id 再写入受信值,防伪造。
  if (userId) {
    delete next.user
    next.user_id = userId
  }
  return { body: JSON.stringify(next) }
}

/**
 * Checks whether an Anthropic Messages request is exclusively asking for the
 * native server-side web-search tool. The product gateway intentionally does
 * not become a general Anthropic passthrough: normal chat continues through
 * the existing OpenAI-compatible pipeline and its image bridge.
 */
export function isDeepSeekNativeWebSearchRequest(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.tools) || value.tools.length === 0) {
    return false
  }

  return value.tools.every(tool => (
    isRecord(tool) && tool.type === DEEPSEEK_NATIVE_WEB_SEARCH_TOOL_TYPE
  ))
}

/**
 * Validates and prepares the one native Anthropic request the managed gateway
 * supports: Claude Code's server-side WebSearchTool. It keeps the official
 * schema intact, coerces only the server-allowed DeepSeek model, and replaces
 * any client-provided user id with the trusted opaque installation identity.
 */
export function prepareDeepSeekAnthropicWebSearchBody(
  rawBody: string,
  allowedModels: ReadonlySet<string>,
  defaultModel: string,
  ctx?: DeepSeekChatContext,
): { body: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new DeepSeekRequestError(400, '联网检索请求不是合法 JSON')
  }
  if (!isRecord(parsed)) {
    throw new DeepSeekRequestError(400, '联网检索请求必须是 JSON 对象')
  }
  if (!isDeepSeekNativeWebSearchRequest(parsed)) {
    throw new DeepSeekRequestError(400, '仅支持原生联网检索工具请求')
  }

  const requested = typeof parsed.model === 'string' ? parsed.model : ''
  const model = allowedModels.has(requested) ? requested : defaultModel
  if (!MODEL_PATTERN.test(model)) throw new DeepSeekRequestError(503, '模型服务未配置')

  const next: Record<string, unknown> = { ...parsed, model }
  if (ctx?.userId) {
    const metadata = isRecord(parsed.metadata) ? { ...parsed.metadata } : {}
    metadata.user_id = ctx.userId
    next.metadata = metadata
  }
  return { body: JSON.stringify(next) }
}

/** Build the official Anthropic Messages URL from the configured DeepSeek base. */
export function deepSeekAnthropicMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/anthropic')
    ? `${base}/v1/messages`
    : `${base}/anthropic/v1/messages`
}

export async function fetchDeepSeekWithRetry(
  doRequest: (attempt: number) => Promise<Response>,
  opts: DeepSeekRetryOptions,
): Promise<{ response: Response; attempts: number }> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const random = opts.random ?? Math.random

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new DeepSeekRequestError(499, '请求已取消')
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
      if (error instanceof DeepSeekRequestError) throw error
      if (attempt >= opts.maxRetries || opts.signal?.aborted || isAbortError(error)) throw error
      await sleep(jitteredBackoff(attempt, opts, random))
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 与 qwen/mimo 一致:只重试"明确可重试的 5xx",429 一律不重试(避免与 CC CLI 重试相乘)。
// 连接错误在 catch 分支重试;调用点把 maxRetries 夹在 [0,1],一次逻辑调用最多额外尝试一次。
function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function jitteredBackoff(attempt: number, opts: DeepSeekRetryOptions, random: () => number): number {
  const base = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt)
  return Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.25))
}

function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  opts: DeepSeekRetryOptions,
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
