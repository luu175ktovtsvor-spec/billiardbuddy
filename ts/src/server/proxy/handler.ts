/**
 * Proxy Handler — protocol-translating reverse proxy for OpenAI-compatible APIs.
 *
 * Receives Anthropic Messages API requests from the CLI, transforms them to
 * OpenAI Chat Completions or Responses API format, forwards to the upstream
 * provider, and transforms the response back to Anthropic format.
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 */

import { ProviderService } from '../services/providerService.js'
import { resolvePromptCacheKey } from './promptCacheKey.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicRequest } from './transform/types.js'
import { getProxyFetchOptions } from '../../utils/proxy.js'
import {
  getNetworkProxyFetchOptions,
  loadNetworkSettings,
  type NetworkSettings,
} from '../services/networkSettings.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import {
  createTraceCallId,
  createTraceBodySnapshot,
  TRACE_STREAM_CAPTURE_BYTES,
  traceCaptureService,
  type TraceBodySnapshot,
  type TraceProviderInfo,
} from '../services/traceCaptureService.js'
import { isQfGatewayProviderId } from '../services/qfGatewayProvider.js'

const providerService = new ProviderService()

type ProxyFetchOptions = ReturnType<typeof getProxyFetchOptions>
type UpstreamRequestInit = RequestInit & ProxyFetchOptions
type ProxyTraceContext = {
  sessionId: string
  provider: TraceProviderInfo
  anthropicRequest: AnthropicRequest
}

const TRACE_RECORDED_ERROR_MARKER = Symbol('billiardbuddy-trace-recorded-error')

function markTraceErrorRecorded(error: unknown): void {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, TRACE_RECORDED_ERROR_MARKER, {
        value: true,
        enumerable: false,
      })
    } catch {
      // Best effort only; proxy error handling must not depend on trace metadata.
    }
  }
}

function wasTraceErrorRecorded(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<symbol, unknown>)[TRACE_RECORDED_ERROR_MARKER])
}

function createTimeoutController(timeoutMs: number): {
  signal: AbortSignal
  clear: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

async function fetchUpstreamWithTimeout(
  url: string,
  init: Omit<UpstreamRequestInit, 'signal'>,
  timeoutMs: number,
  isStream: boolean,
): Promise<Response> {
  if (!isStream) {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  // For streaming requests, this timeout should only cover the connection and
  // response headers. Keeping the signal alive aborts long generations mid-body.
  const timeout = createTimeoutController(timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: timeout.signal,
    })
  } finally {
    timeout.clear()
  }
}

export function withStreamIdleTimeout(
  upstream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearIdleTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return new ReadableStream({
    async start(controller) {
      reader = upstream.getReader()
      let timedOut = false

      const armIdleTimer = () => {
        clearIdleTimer()
        timer = setTimeout(() => {
          timedOut = true
          void reader?.cancel('stream idle timeout').catch(() => undefined)
          controller.error(new Error(`Upstream stream idle timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      }

      try {
        armIdleTimer()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (timedOut) break

          controller.enqueue(value)
          armIdleTimer()
        }
        clearIdleTimer()
        if (!timedOut) controller.close()
      } catch (err) {
        clearIdleTimer()
        if (!timedOut) controller.error(err)
      }
    },
    cancel(reason) {
      clearIdleTimer()
      return reader?.cancel(reason)
    },
  })
}

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const providerMatch = url.pathname.match(/^\/proxy\/providers\/([^/]+)\/v1\/messages$/)
  const providerId = providerMatch ? decodeURIComponent(providerMatch[1]!) : undefined
  const isActiveProxyPath = url.pathname === '/proxy/v1/messages'

  // Only handle POST /proxy/v1/messages or POST /proxy/providers/:providerId/v1/messages
  if (req.method !== 'POST' || (!isActiveProxyPath && !providerMatch)) {
    return Response.json(
      {
        error: 'Not Found',
        message: 'Proxy only handles POST /proxy/v1/messages and POST /proxy/providers/:providerId/v1/messages',
      },
      { status: 404 },
    )
  }

  // Read active/default provider config or an explicitly-scoped provider config.
  const config = await providerService.getProviderForProxy(providerId)
  if (!config) {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" is not configured for proxy`
            : 'No active provider configured for proxy',
        },
      },
      { status: 400 },
    )
  }

  if (config.apiFormat === 'anthropic') {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" uses anthropic format — proxy not needed`
            : 'Active provider uses anthropic format — proxy not needed',
        },
      },
      { status: 400 },
    )
  }

  // Parse request body
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch {
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON in request body' } },
      { status: 400 },
    )
  }

  body = {
    ...body,
    model: normalizeModelStringForAPI(body.model),
  }

  // 托管 qf-gateway 上的图片输入一律放行:mimo-v2.5 原生看图,其余模型由服务端网关的视觉桥接
  // (先用 MiMo 把图读成结构化文本再交给原文本模型)处理。本地绝不 400、绝不静默丢图或改投别家 ——
  // 是否能看图、怎么看图完全由网关决定。
  const isManagedGateway = isQfGatewayProviderId(config.id)

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const networkSettings = await loadNetworkSettings()

  // Only Claude Code's native server-side WebSearchTool bypasses the normal
  // Anthropic-to-OpenAI transform. The gateway exchanges the local app token
  // for its DeepSeek key and forwards this exact protocol to /anthropic; all
  // ordinary chat, images, and other tools keep the established product path.
  if (isManagedGateway && isNativeWebSearchToolRequest(body)) {
    return forwardManagedNativeWebSearch(
      body,
      baseUrl,
      config.apiKey,
      req,
      networkSettings,
      config.clientId,
    )
  }

  const traceContext = buildProxyTraceContext(req, config, body)
  const promptCacheKey = resolvePromptCacheKey(body, req.headers.get('x-claude-code-session-id'))

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream, networkSettings, traceContext, isManagedGateway, config.clientId)
    } else {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream, networkSettings, traceContext, promptCacheKey)
    }
  } catch (err) {
    if (traceContext && !wasTraceErrorRecorded(err)) {
      void recordProxyTrace({
        context: traceContext,
        model: body.model,
        upstreamUrl: baseUrl,
        upstreamRequest: null,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        error: err,
      }).catch(() => {})
    }
    console.error('[Proxy] Upstream request failed:', err)
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 502 },
    )
  }
}

const NATIVE_WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'

function isNativeWebSearchToolRequest(body: AnthropicRequest): boolean {
  const tools = (body as Record<string, unknown>).tools
  return Array.isArray(tools)
    && tools.length > 0
    && tools.every(tool => (
      typeof tool === 'object'
      && tool !== null
      && !Array.isArray(tool)
      && (tool as Record<string, unknown>).type === NATIVE_WEB_SEARCH_TOOL_TYPE
    ))
}

async function forwardManagedNativeWebSearch(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  request: Request,
  networkSettings: NetworkSettings,
  clientId?: string,
): Promise<Response> {
  const url = `${baseUrl}/v1/messages`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'anthropic-version': request.headers.get('anthropic-version')?.trim() || '2023-06-01',
  }
  const beta = request.headers.get('anthropic-beta')?.trim()
  if (beta) headers['anthropic-beta'] = beta
  const accept = request.headers.get('accept')?.trim()
  if (accept) headers.Accept = accept
  if (clientId) headers['X-QF-Client-ID'] = clientId

  const proxyOptions = getNetworkProxyFetchOptions(networkSettings, url)
  const upstream = await fetchUpstreamWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...proxyOptions,
  }, networkSettings.aiRequestTimeoutMs, body.stream === true)

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {})
    return Response.json({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Native web search is currently unavailable. Please try again.',
      },
    }, { status: upstream.status })
  }

  const responseHeaders = new Headers()
  for (const header of ['content-type', 'cache-control', 'request-id']) {
    const value = upstream.headers.get(header)
    if (value) responseHeaders.set(header, value)
  }
  const responseBody = upstream.body && body.stream === true
    ? withStreamIdleTimeout(upstream.body, networkSettings.aiRequestTimeoutMs)
    : upstream.body
  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  networkSettings: NetworkSettings,
  traceContext: ProxyTraceContext | null,
  isManagedGateway: boolean,
  clientId?: string,
): Promise<Response> {
  const transformed = anthropicToOpenaiChat(body, resolveOpenaiChatCompatOptions(baseUrl, body.model, isManagedGateway))
  const url = `${baseUrl}/v1/chat/completions`
  const upstreamRequestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  // X-QF-Client-ID is set ONLY for the qf-gateway (config.clientId present); it rides on the
  // wire but is deliberately kept OUT of the traced headers so the install id never lands in
  // the local proxy trace/logs. A user's own OpenAI-compat provider has no clientId → no header.
  const fetchHeaders = clientId
    ? { ...upstreamRequestHeaders, 'X-QF-Client-ID': clientId }
    : upstreamRequestHeaders
  const proxyOptions = getNetworkProxyFetchOptions(networkSettings, url)
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, networkSettings.aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      await recordProxyTrace({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        error: err,
      })
      markTraceErrorRecorded(err)
    }
    throw err
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    const errorBody = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      await recordProxyTrace({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        responseStatus: upstream.status,
        upstreamResponseBody: errText,
        anthropicResponseBody: errorBody,
        responseHeaders: upstream.headers,
      })
    }
    return Response.json(
      errorBody,
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        await recordProxyTrace({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
          requestHeaders: upstreamRequestHeaders,
          startedAt,
          startedAtMs,
          error: new Error('Upstream returned no body for stream'),
        })
      }
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const upstreamBody = withStreamIdleTimeout(upstream.body, networkSettings.aiRequestTimeoutMs)
    const anthropicStream = openaiChatStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
            requestHeaders: upstreamRequestHeaders,
            startedAt,
            startedAtMs,
            responseStatus: 200,
            responseBodySnapshot: bodySnapshot,
            responseHeaders: upstream.headers,
            ...(error ? { error } : {}),
          })
        })
      : anthropicStream
    return new Response(tracedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiChatToAnthropic(responseBody, body.model)
  if (traceContext) {
    await recordProxyTrace({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      requestHeaders: upstreamRequestHeaders,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse)
}

/** DeepSeek model ids (deepseek-v4-flash / -pro / -chat / -reasoner) carry "deepseek". */
function isDeepSeekModel(model: string | undefined): boolean {
  return typeof model === 'string' && /(^|[./_-])deepseek([./_-]|$)/i.test(model)
}

function shouldUseDeepSeekReasoningCompat(baseUrl: string, model?: string): boolean {
  return (
    /(^|[./-])deepseek([./-]|$)/i.test(baseUrl) ||
    /(^|[./-])opencode\.ai([:/]|$)/i.test(baseUrl) ||
    isDeepSeekModel(model)
  )
}

function shouldUseTextOnlyOpenAIChatContent(baseUrl: string, model?: string): boolean {
  return shouldUseDeepSeekReasoningCompat(baseUrl, model)
}

/**
 * Resolve the openai_chat transform options from the base URL, the selected model, and
 * whether this request is going through our own managed qf-gateway. This is exported so
 * it can be unit-tested: under the qf-gateway the base URL is our own gateway domain
 * (never contains "deepseek"), so DeepSeek reasoning compat MUST be driven by the model
 * id. Enabling it turns on unconditional reasoning_content round-trip — the safe DeepSeek
 * multi-turn strategy (a prior tool-call turn REQUIRES the reasoning_content back or
 * DeepSeek 400s; a no-tool-call turn tolerates it) — plus the thinking toggle.
 *
 * `imageContentMode` is decoupled from the DeepSeek reasoning compat: on the managed
 * gateway, image content is ALWAYS kept as vision (`image_url`) parts and forwarded as-is —
 * the gateway itself decides how to read it (mimo-v2.5 natively, other models via a
 * server-side vision bridge). Only a user's own directly-connected DeepSeek-compatible
 * provider (not the managed gateway) falls back to text_only, since it has no such bridge.
 */
export function resolveOpenaiChatCompatOptions(
  baseUrl: string,
  model: string | undefined,
  isManagedGateway: boolean = false,
): {
  roundTripReasoningContent: boolean
  passThinkingToggle: boolean
  imageContentMode: 'text_only' | 'vision'
} {
  const deepSeekCompatible = shouldUseDeepSeekReasoningCompat(baseUrl, model)
  return {
    roundTripReasoningContent: deepSeekCompatible,
    passThinkingToggle: deepSeekCompatible,
    imageContentMode: isManagedGateway
      ? 'vision'
      : shouldUseTextOnlyOpenAIChatContent(baseUrl, model) ? 'text_only' : 'vision',
  }
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  networkSettings: NetworkSettings,
  traceContext: ProxyTraceContext | null,
  promptCacheKey?: string,
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body, { cacheKey: promptCacheKey })
  const url = `${baseUrl}/v1/responses`
  const upstreamRequestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  const proxyOptions = getNetworkProxyFetchOptions(networkSettings, url)
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const traceCallId = traceContext
    ? startProxyTraceCall({
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
      })
    : undefined

  let upstream: Response
  try {
    upstream = await fetchUpstreamWithTimeout(url, {
      method: 'POST',
      headers: upstreamRequestHeaders,
      body: JSON.stringify(transformed),
      ...proxyOptions,
    }, networkSettings.aiRequestTimeoutMs, isStream)
  } catch (err) {
    if (traceContext) {
      await recordProxyTrace({
        callId: traceCallId,
        context: traceContext,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        error: err,
      })
      markTraceErrorRecorded(err)
    }
    throw err
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    const errorBody = {
      type: 'error',
      error: {
        type: 'api_error',
        message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
      },
    }
    if (traceContext) {
      await recordProxyTrace({
        context: traceContext,
        callId: traceCallId,
        model: body.model,
        upstreamUrl: url,
        upstreamRequest: transformed,
        requestHeaders: upstreamRequestHeaders,
        startedAt,
        startedAtMs,
        responseStatus: upstream.status,
        upstreamResponseBody: errText,
        anthropicResponseBody: errorBody,
        responseHeaders: upstream.headers,
      })
    }
    return Response.json(
      errorBody,
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      if (traceContext) {
        await recordProxyTrace({
          callId: traceCallId,
          context: traceContext,
          model: body.model,
          upstreamUrl: url,
          upstreamRequest: transformed,
          requestHeaders: upstreamRequestHeaders,
          startedAt,
          startedAtMs,
          error: new Error('Upstream returned no body for stream'),
        })
      }
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const upstreamBody = withStreamIdleTimeout(upstream.body, networkSettings.aiRequestTimeoutMs)
    const anthropicStream = openaiResponsesStreamToAnthropic(upstreamBody, body.model)
    const tracedStream = traceContext
      ? captureTraceStream(anthropicStream, async (bodySnapshot, error) => {
          await recordProxyTrace({
            callId: traceCallId,
            context: traceContext,
            model: body.model,
            upstreamUrl: url,
            upstreamRequest: transformed,
            requestHeaders: upstreamRequestHeaders,
            startedAt,
            startedAtMs,
            responseStatus: 200,
            responseBodySnapshot: bodySnapshot,
            responseHeaders: upstream.headers,
            ...(error ? { error } : {}),
          })
        })
      : anthropicStream
    return new Response(tracedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiResponsesToAnthropic(responseBody, body.model)
  if (traceContext) {
    await recordProxyTrace({
      callId: traceCallId,
      context: traceContext,
      model: body.model,
      upstreamUrl: url,
      upstreamRequest: transformed,
      requestHeaders: upstreamRequestHeaders,
      startedAt,
      startedAtMs,
      responseStatus: 200,
      upstreamResponseBody: responseBody,
      anthropicResponseBody: anthropicResponse,
      responseHeaders: upstream.headers,
    })
  }
  return Response.json(anthropicResponse)
}

function buildProxyTraceContext(
  req: Request,
  config: { id: string; name: string; apiFormat: string },
  anthropicRequest: AnthropicRequest,
): ProxyTraceContext | null {
  const sessionId = req.headers.get('x-claude-code-session-id')?.trim()
  if (!sessionId) return null
  return {
    sessionId,
    provider: {
      id: config.id,
      name: config.name,
      format: config.apiFormat,
    },
    anthropicRequest,
  }
}

function createProxyTraceRequestBody(context: ProxyTraceContext, upstreamRequest: unknown): Record<string, unknown> {
  return upstreamRequest
    ? {
        anthropic: context.anthropicRequest,
        upstream: upstreamRequest,
      }
    : {
        anthropic: context.anthropicRequest,
      }
}

function startProxyTraceCall({
  context,
  model,
  upstreamUrl,
  upstreamRequest,
  requestHeaders,
  startedAt,
}: {
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
  requestHeaders: Record<string, string>
  startedAt: string
}): string {
  const callId = createTraceCallId()
  void traceCaptureService.recordCall({
    id: callId,
    sessionId: context.sessionId,
    source: 'proxy',
    provider: context.provider,
    model,
    status: 'pending',
    startedAt,
    request: {
      method: 'POST',
      url: upstreamUrl,
      headers: requestHeaders,
      bodySnapshot: createTraceBodySnapshot({
        pending: true,
        note: 'proxy request body captured on call completion',
      }),
    },
    metadata: {
      phase: 'upstream_fetch_started',
    },
  })
  void traceCaptureService.recordEvent({
    sessionId: context.sessionId,
    callId,
    source: 'proxy',
    provider: context.provider,
    model,
    timestamp: startedAt,
    phase: 'upstream_fetch_started',
    severity: 'info',
    title: 'Upstream fetch started',
    metadata: {
      url: upstreamUrl,
    },
  })
  return callId
}

async function recordProxyTrace({
  callId,
  context,
  model,
  upstreamUrl,
  upstreamRequest,
  requestHeaders,
  startedAt,
  startedAtMs,
  responseStatus,
  upstreamResponseBody,
  anthropicResponseBody,
  responseBodySnapshot,
  responseHeaders,
  error,
}: {
  callId?: string
  context: ProxyTraceContext
  model: string
  upstreamUrl: string
  upstreamRequest: unknown
  requestHeaders?: Record<string, string>
  startedAt: string
  startedAtMs: number
  responseStatus?: number
  upstreamResponseBody?: unknown
  anthropicResponseBody?: unknown
  responseBodySnapshot?: TraceBodySnapshot
  responseHeaders?: Headers
  error?: unknown
}): Promise<void> {
  const completedAt = new Date().toISOString()
  const requestBody = createProxyTraceRequestBody(context, upstreamRequest)
  const responseBody = anthropicResponseBody === undefined && upstreamResponseBody === undefined
    ? undefined
    : {
        ...(upstreamResponseBody !== undefined ? { upstream: upstreamResponseBody } : {}),
        ...(anthropicResponseBody !== undefined ? { anthropic: anthropicResponseBody } : {}),
      }

  await traceCaptureService.recordCall({
    ...(callId ? { id: callId } : {}),
    sessionId: context.sessionId,
    source: 'proxy',
    provider: context.provider,
    model,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs,
    request: {
      method: 'POST',
      url: upstreamUrl,
      headers: requestHeaders,
      body: requestBody,
    },
    ...(responseStatus !== undefined
      ? {
          response: {
            status: responseStatus,
            headers: responseHeaders,
            ...(responseBodySnapshot ? { bodySnapshot: responseBodySnapshot } : { body: responseBody }),
          },
        }
      : {}),
    ...(error ? { error } : {}),
    metadata: {
      phase: error ? 'upstream_fetch_failed' : 'upstream_fetch_completed',
    },
  })
  await traceCaptureService.recordEvent({
    sessionId: context.sessionId,
    ...(callId ? { callId } : {}),
    source: 'proxy',
    provider: context.provider,
    model,
    timestamp: completedAt,
    phase: error ? 'upstream_fetch_failed' : 'upstream_fetch_completed',
    severity: error ? 'error' : responseStatus !== undefined && responseStatus >= 400 ? 'warning' : 'info',
    title: error ? 'Upstream fetch failed' : 'Upstream fetch completed',
    message: error instanceof Error ? error.message : error ? String(error) : undefined,
    metadata: {
      status: responseStatus,
      url: upstreamUrl,
    },
  })
}

function captureTraceStream(
  stream: ReadableStream<Uint8Array>,
  onComplete: (snapshot: TraceBodySnapshot, error?: unknown) => Promise<void>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let captured = ''
  let bytes = 0
  let truncated = false
  let finalized = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const captureChunk = (chunk: Uint8Array) => {
    bytes += chunk.byteLength
    if (bytes <= TRACE_STREAM_CAPTURE_BYTES) {
      captured += decoder.decode(chunk, { stream: true })
    } else {
      truncated = true
    }
  }

  const finalize = async (error?: unknown) => {
    if (finalized) return
    finalized = true
    captured += decoder.decode()
    const snapshot = createTraceBodySnapshot(captured, { alreadyTruncated: truncated })
    await onComplete(snapshot, error).catch(() => {})
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          captureChunk(value)
          controller.enqueue(value)
        }
        await finalize()
        controller.close()
      } catch (err) {
        await finalize(err)
        controller.error(err)
      } finally {
        reader?.releaseLock()
        reader = null
      }
    },
    async cancel(reason) {
      const error = reason instanceof Error
        ? reason
        : new Error(reason ? `Stream cancelled: ${String(reason)}` : 'Stream cancelled')
      await finalize(error)
      await reader?.cancel(reason).catch(() => undefined)
    },
  })
}
