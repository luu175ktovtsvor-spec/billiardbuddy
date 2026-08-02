const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/

export class ManagedResponsesRequestError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'ManagedResponsesRequestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  // Force this even if the caller sent true: provider-side storage would make
  // the remote account a second source of conversation truth. Apart from that
  // and the managed model selection, Core's Responses body is forwarded intact.
  const next: Record<string, unknown> = {
    ...parsed,
    model,
    stream: true,
    store: false,
  }
  return { body: JSON.stringify(next) }
}
