import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { PersonalModelProfile } from '../../../shared/product/personalModels'

type JsonObject = Record<string, unknown>

type NativeProviderConfig = {
  id: string
  name: string
  baseUrl: string
  contextWindowTokens: number
  envKey?: string
  envHeaders?: Record<string, string>
  headers?: Record<string, string>
}

export type ManagedCodexModelRoute = {
  kind: 'managed'
  /** The public Billiard Gateway URL, ending at its fixed `/gw` path. */
  gatewayUrl: string
  /**
   * Electron Main supplies the current installation bearer for each upstream
   * request. The Rust child receives only a loopback capability token, so a
   * rotating Gateway session never becomes persisted Agent configuration.
   */
  resolveAccessToken: () => Promise<string>
  model: string
  /** Values come from the trusted managed provider registry. */
  contextWindowTokens: number
}

export type PersonalCodexModelRoute = {
  kind: 'personal'
  profile: PersonalModelProfile
}

export type CodexNativeModelRoute = ManagedCodexModelRoute | PersonalCodexModelRoute

/**
 * One provider configuration for a native Codex App Server process.
 *
 * `environment` is deliberately process-local: callers pass it only to the
 * short-lived App Server child. It must never be merged into the renderer,
 * the Product Server sidecar, or a persisted Codex config file.
 */
export type StartedCodexNativeProvider = {
  model: string
  configOverrides: readonly string[]
  environment: Readonly<Record<string, string>>
  close(): Promise<void>
}

const ENGINE_TOKEN_HEADER = 'X-BilliardBuddy-Engine-Token'
const MAX_ADAPTER_REQUEST_BYTES = 128 * 1024 * 1024
const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function string(value: unknown, max = 1024 * 1024): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

function nonEmptyString(value: unknown, max = 1024 * 1024): string | undefined {
  const result = string(value, max)
  return result?.trim() ? result : undefined
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function tomlInlineTable(entries: Record<string, string>): string {
  return `{${Object.entries(entries).map(([key, value]) => `${quoted(key)}=${quoted(value)}`).join(',')}}`
}

function modelContextWindow(contextWindowTokens: unknown, error: string): number {
  if (
    typeof contextWindowTokens !== 'number'
    || !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens < 8_192
    || contextWindowTokens > 2_000_000
  ) {
    throw new Error(error)
  }
  return contextWindowTokens
}

function personalModelContextWindow(profile: PersonalModelProfile): number {
  if (profile.context_limits_source === 'legacy-unverified') {
    throw new Error('CODEX_NATIVE_PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED')
  }
  // Either BilliardBuddy's checked catalog or the user's explicit provider
  // declaration supplies this contract. Core learns the actual full window
  // instead of falling back to its unknown-model default; the native Core
  // keeps sole ownership of output headroom and automatic compaction.
  return modelContextWindow(
    profile.context_window_tokens,
    'CODEX_NATIVE_PERSONAL_MODEL_LIMITS_INVALID',
  )
}

function providerOverrides(input: NativeProviderConfig): string[] {
  const prefix = `model_providers.${input.id}`
  return [
    // BilliardBuddy owns product telemetry and release checks. The embedded
    // App Server must never create an undeclared upstream network path before
    // the selected model route is used.
    'analytics.enabled=false',
    'feedback.enabled=false',
    'check_for_update_on_startup=false',
    // The App Server receives only a revocable loopback capability token.
    // Preserve Codex's native tool/runtime model, but make its built-in
    // KEY/SECRET/TOKEN exclusion mandatory for every shell child so a tool,
    // hook or project command cannot read that capability. This is a CLI
    // override, and therefore wins over a project config file.
    'shell_environment_policy.ignore_default_excludes=false',
    `model_provider=${quoted(input.id)}`,
    `${prefix}.name=${quoted(input.name)}`,
    `${prefix}.base_url=${quoted(input.baseUrl)}`,
    `${prefix}.wire_api=${quoted('responses')}`,
    // Only the provider's real window crosses this boundary. Leaving the
    // compaction threshold unset preserves the Rust Core's native model
    // defaults, headroom and automatic-compaction lifecycle.
    `model_context_window=${input.contextWindowTokens}`,
    ...(input.envKey ? [`${prefix}.env_key=${quoted(input.envKey)}`] : []),
    ...(input.envHeaders && Object.keys(input.envHeaders).length > 0
      ? [`${prefix}.env_http_headers=${tomlInlineTable(input.envHeaders)}`]
      : []),
    ...(input.headers && Object.keys(input.headers).length > 0
      ? [`${prefix}.http_headers=${tomlInlineTable(input.headers)}`]
      : []),
    // Model submissions can incur a charge. The Gateway supplies its own
    // idempotent replay; a child process must not silently issue a second one.
    `${prefix}.request_max_retries=0`,
    `${prefix}.stream_max_retries=0`,
  ]
}

function managedResponsesBaseUrl(gatewayUrl: string): string {
  let url: URL
  try { url = new URL(gatewayUrl) } catch { throw new Error('CODEX_NATIVE_GATEWAY_URL_INVALID') }
  if (url.protocol !== 'https:' || url.pathname.replace(/\/+$/, '') !== '/gw' || url.username || url.password || url.search || url.hash) {
    throw new Error('CODEX_NATIVE_GATEWAY_URL_INVALID')
  }
  url.pathname = '/gw/v1'
  return url.toString().replace(/\/$/, '')
}

function personalModelAuthHeader(profile: Pick<PersonalModelProfile, 'api_key' | 'auth_mode'>): Record<string, string> {
  if (profile.auth_mode === 'x-api-key') return { 'x-api-key': profile.api_key }
  if (profile.auth_mode === 'api-key') return { 'api-key': profile.api_key }
  return { Authorization: `Bearer ${profile.api_key}` }
}

function personalModelEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`
  return url.toString()
}

function adapterFailure(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ error: { code, message: code } }))
}

function sse(response: ServerResponse, type: string, data: JsonObject): void {
  if (!response.writableEnded) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function loopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

async function requestText(request: IncomingMessage): Promise<string> {
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_ADAPTER_REQUEST_BYTES) {
    throw new Error('CODEX_CHAT_ADAPTER_REQUEST_TOO_LARGE')
  }
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_ADAPTER_REQUEST_BYTES) {
        request.destroy()
        reject(new Error('CODEX_CHAT_ADAPTER_REQUEST_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    request.once('error', () => reject(new Error('CODEX_CHAT_ADAPTER_REQUEST_READ_FAILED')))
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function contentParts(value: unknown): JsonObject[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  if (!Array.isArray(value)) return []
  return value.flatMap(item => record(item) ? [record(item)!] : [])
}

function chatContent(value: unknown): string | JsonObject[] {
  if (typeof value === 'string') return value
  const parts: JsonObject[] = []
  for (const part of contentParts(value)) {
    const kind = string(part.type, 128)
    if (kind === 'input_text' || kind === 'output_text' || kind === 'text') {
      const text = string(part.text)
      if (text !== undefined) parts.push({ type: 'text', text })
      continue
    }
    if (kind === 'input_image') {
      const imageUrl = string(part.image_url ?? part.url, 32 * 1024 * 1024)
      if (imageUrl) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: imageUrl,
            ...(typeof part.detail === 'string' ? { detail: part.detail } : {}),
          },
        })
      }
    }
  }
  return parts
}

function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value
  const parts = contentParts(value)
    .filter(part => ['input_text', 'output_text', 'text'].includes(String(part.type)))
    .map(part => string(part.text) ?? '')
    .join('')
  return parts || JSON.stringify(value ?? '')
}

function responseInputToChatMessages(input: unknown, instructions: unknown): JsonObject[] {
  const messages: JsonObject[] = []
  const instructionText = string(instructions, 8 * 1024 * 1024)
  if (instructionText?.trim()) messages.push({ role: 'system', content: instructionText })
  const items = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : Array.isArray(input) ? input : null
  if (!items) throw new Error('CODEX_CHAT_ADAPTER_INPUT_INVALID')
  for (const raw of items) {
    const item = record(raw)
    const type = string(item?.type, 128)
    if (!item || !type) throw new Error('CODEX_CHAT_ADAPTER_INPUT_INVALID')
    if (type === 'message' || type === 'agent_message') {
      const rawRole = type === 'agent_message' ? 'assistant' : string(item.role, 64)
      if (!rawRole || !['system', 'developer', 'user', 'assistant'].includes(rawRole)) {
        throw new Error('CODEX_CHAT_ADAPTER_MESSAGE_ROLE_UNSUPPORTED')
      }
      // `developer` is a Responses-specific hierarchy level. Map it to the
      // broadly supported system role instead of letting compatible Chat
      // providers silently interpret it as an ordinary user message.
      const role = rawRole === 'developer' ? 'system' : rawRole
      messages.push({ role, content: chatContent(item.content) })
      continue
    }
    if (type === 'function_call') {
      const callId = nonEmptyString(item.call_id, 512)
      const name = nonEmptyString(item.name, 512)
      const argumentsValue = string(item.arguments, 8 * 1024 * 1024)
      if (!callId || !name || argumentsValue === undefined) throw new Error('CODEX_CHAT_ADAPTER_FUNCTION_CALL_INVALID')
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name, arguments: argumentsValue } }],
      })
      continue
    }
    if (type === 'function_call_output') {
      const callId = nonEmptyString(item.call_id, 512)
      if (!callId) throw new Error('CODEX_CHAT_ADAPTER_FUNCTION_OUTPUT_INVALID')
      messages.push({ role: 'tool', tool_call_id: callId, content: toolOutputText(item.output) })
      continue
    }
    // These are native Core bookkeeping items. A Chat Completions endpoint has
    // no equivalent encrypted continuation format; durable history remains in
    // the local Codex Thread Store and the visible/tool parts are above.
    if (['reasoning', 'compaction', 'context_compaction', 'compaction_trigger', 'additional_tools'].includes(type)) continue
    throw new Error('CODEX_CHAT_ADAPTER_INPUT_UNSUPPORTED')
  }
  return messages
}

function chatTools(value: unknown): JsonObject[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('CODEX_CHAT_ADAPTER_TOOLS_INVALID')
  const tools: JsonObject[] = []
  for (const raw of value) {
    const tool = record(raw)
    if (!tool || tool.type !== 'function') throw new Error('CODEX_CHAT_ADAPTER_TOOL_UNSUPPORTED')
    const name = nonEmptyString(tool.name, 512)
    const parameters = record(tool.parameters) ?? { type: 'object', properties: {} }
    if (!name) throw new Error('CODEX_CHAT_ADAPTER_TOOL_INVALID')
    tools.push({
      type: 'function',
      function: {
        name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters,
        ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      },
    })
  }
  return tools
}

function chatResponseFormat(value: unknown): JsonObject | undefined {
  const text = record(value)
  const format = record(text?.format)
  if (!format) return undefined
  if (format.type === 'json_object') return { type: 'json_object' }
  if (format.type !== 'json_schema') return undefined
  const name = nonEmptyString(format.name, 512)
  const schema = record(format.schema)
  if (!name || !schema) return undefined
  return {
    type: 'json_schema',
    json_schema: { name, schema, ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}) },
  }
}

function chatRequest(profile: PersonalModelProfile, request: JsonObject): JsonObject {
  const tools = chatTools(request.tools)
  const maxOutputTokens = typeof request.max_output_tokens === 'number' ? request.max_output_tokens : undefined
  const reasoning = record(request.reasoning)
  return {
    model: profile.model,
    stream: true,
    messages: responseInputToChatMessages(request.input, request.instructions),
    ...(tools?.length ? { tools } : {}),
    ...(request.tool_choice !== undefined ? { tool_choice: request.tool_choice } : {}),
    ...(typeof request.parallel_tool_calls === 'boolean'
      ? { parallel_tool_calls: profile.supports_parallel_tool_calls ? request.parallel_tool_calls : false }
      : profile.supports_parallel_tool_calls ? {} : { parallel_tool_calls: false }),
    ...(maxOutputTokens !== undefined && profile.chat_completion_token_limit_field !== 'provider-default'
      ? { [profile.chat_completion_token_limit_field]: maxOutputTokens }
      : {}),
    ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
    ...(profile.reasoning_effort !== 'provider-default'
      ? { reasoning_effort: profile.reasoning_effort }
      : typeof reasoning?.effort === 'string' ? { reasoning_effort: reasoning.effort } : {}),
    ...(chatResponseFormat(request.text) ? { response_format: chatResponseFormat(request.text) } : {}),
  }
}

type ChatToolCall = {
  index: number
  itemId: string
  callId: string
  name: string
  arguments: string
}

type ChatStreamResult = {
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
}

/**
 * Loopback-only adapter for a user-selected Chat Completions model.
 *
 * Codex itself is Responses-only. This adapter is intentionally protocol-only:
 * it has no Thread, state database, Tool Router, approval logic, persistence,
 * retries, or model result cache. The personal key remains in Electron Main
 * memory; the App Server receives only a revocable loopback capability token.
 */
export class ChatCompletionsResponsesAdapter {
  private readonly capabilityToken = randomBytes(32).toString('base64url')
  private readonly sockets = new Set<Socket>()
  private readonly activeRequests = new Set<AbortController>()
  private server?: Server
  private closed = false

  constructor(private readonly profile: PersonalModelProfile) {
    // This is a protocol converter, not a fallback provider. A malformed or
    // future profile must not silently turn into a Chat request merely because
    // it is not the direct Responses variant.
    if (profile.protocol !== 'openai-compatible') {
      throw new Error('CODEX_NATIVE_CHAT_ADAPTER_PROTOCOL_INVALID')
    }
  }

  async start(): Promise<{ baseUrl: string; capabilityToken: string }> {
    if (this.server || this.closed) throw new Error('CODEX_CHAT_ADAPTER_UNAVAILABLE')
    const server = createServer((request, response) => { void this.handle(request, response) })
    server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new Error('CODEX_CHAT_ADAPTER_LISTEN_FAILED')
    }
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, capabilityToken: this.capabilityToken }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const controller of this.activeRequests) controller.abort()
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!loopbackAddress(request.socket.remoteAddress)) return adapterFailure(response, 403, 'CODEX_CHAT_ADAPTER_LOOPBACK_REQUIRED')
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'POST' || url.pathname !== '/v1/responses' || url.search) {
      return adapterFailure(response, 404, 'CODEX_CHAT_ADAPTER_ROUTE_NOT_FOUND')
    }
    if (request.headers[ENGINE_TOKEN_HEADER.toLowerCase()] !== this.capabilityToken) {
      return adapterFailure(response, 401, 'CODEX_CHAT_ADAPTER_UNAUTHORIZED')
    }
    let body: JsonObject
    try {
      body = record(JSON.parse(await requestText(request))) ?? (() => { throw new Error('CODEX_CHAT_ADAPTER_REQUEST_INVALID') })()
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CODEX_CHAT_ADAPTER_REQUEST_INVALID'
      return adapterFailure(response, code === 'CODEX_CHAT_ADAPTER_REQUEST_TOO_LARGE' ? 413 : 400, code)
    }
    if (body.stream !== true) return adapterFailure(response, 400, 'CODEX_CHAT_ADAPTER_STREAM_REQUIRED')
    let upstreamBody: JsonObject
    try { upstreamBody = chatRequest(this.profile, body) } catch (error) {
      return adapterFailure(response, 400, error instanceof Error ? error.message : 'CODEX_CHAT_ADAPTER_REQUEST_INVALID')
    }
    const controller = new AbortController()
    this.activeRequests.add(controller)
    const onAborted = () => controller.abort()
    request.once('aborted', onAborted)
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    try {
      const upstream = await fetch(personalModelEndpoint(this.profile.base_url, 'chat/completions'), {
        method: 'POST',
        headers: {
          ...personalModelAuthHeader(this.profile),
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(upstreamBody),
        redirect: 'error',
        signal: controller.signal,
      })
      if (!upstream.ok || !upstream.body) {
        return adapterFailure(response, upstream.status || 502, `CODEX_CHAT_ADAPTER_UPSTREAM_HTTP_${upstream.status || 502}`)
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      await this.streamResponse(response, upstream, controller.signal)
    } catch (error) {
      if (!response.headersSent) {
        return adapterFailure(response, controller.signal.aborted ? 499 : 502, controller.signal.aborted ? 'CODEX_CHAT_ADAPTER_ABORTED' : 'CODEX_CHAT_ADAPTER_UPSTREAM_UNAVAILABLE')
      }
      sse(response, 'response.failed', {
        response: this.responseBase('failed', {
          error: { code: controller.signal.aborted ? 'CODEX_CHAT_ADAPTER_ABORTED' : 'CODEX_CHAT_ADAPTER_UPSTREAM_UNAVAILABLE' },
        }),
      })
    } finally {
      request.off('aborted', onAborted)
      this.activeRequests.delete(controller)
      if (!response.writableEnded) response.end()
    }
  }

  private responseBase(status: 'in_progress' | 'completed' | 'incomplete' | 'failed', more: JsonObject = {}): JsonObject {
    return { id: `resp_${randomUUID()}`, object: 'response', created_at: Math.floor(Date.now() / 1_000), model: this.profile.model, status, ...more }
  }

  private async streamResponse(response: ServerResponse, upstream: Response, signal: AbortSignal): Promise<void> {
    const responseId = `resp_${randomUUID()}`
    const base = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1_000), model: this.profile.model }
    const output: JsonObject[] = []
    const calls = new Map<number, ChatToolCall>()
    const textItem = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '' }] }
    let textStarted = false
    let text = ''
    let result: ChatStreamResult = {}
    sse(response, 'response.created', { response: { ...base, status: 'in_progress', output: [] } })
    sse(response, 'response.in_progress', { response: { ...base, status: 'in_progress', output: [] } })
    await this.readSse(upstream, signal, data => {
      const choice = Array.isArray(data.choices) ? record(data.choices[0]) : undefined
      if (!choice) {
        const usage = record(data.usage)
        if (typeof usage?.prompt_tokens === 'number') result.inputTokens = usage.prompt_tokens
        if (typeof usage?.completion_tokens === 'number') result.outputTokens = usage.completion_tokens
        return
      }
      const delta = record(choice.delta)
      const content = string(delta?.content)
      if (content) {
        if (!textStarted) {
          textStarted = true
          sse(response, 'response.output_item.added', { output_index: output.length, item: { ...textItem, status: 'in_progress', content: [] } })
          sse(response, 'response.content_part.added', { output_index: output.length, content_index: 0, part: { type: 'output_text', text: '' } })
        }
        text += content
        sse(response, 'response.output_text.delta', { output_index: output.length, content_index: 0, delta: content })
      }
      const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
      for (let position = 0; position < toolCalls.length; position += 1) {
        const call = record(toolCalls[position])
        if (!call) continue
        const index = typeof call.index === 'number' && Number.isSafeInteger(call.index) ? call.index : position
        const functionData = record(call.function)
        const current = calls.get(index) ?? {
          index,
          itemId: `fc_${randomUUID()}`,
          callId: `call_${randomUUID()}`,
          name: '',
          arguments: '',
        }
        const id = nonEmptyString(call.id, 512)
        const name = string(functionData?.name, 512)
        const argumentsDelta = string(functionData?.arguments, 8 * 1024 * 1024)
        if (id) current.callId = id
        // Chat Completions normally emits a tool name once in the first delta.
        // Treat subsequent copies as metadata, not another name fragment.
        if (name && !current.name) current.name = name
        if (argumentsDelta) current.arguments += argumentsDelta
        calls.set(index, current)
      }
      const finishReason = string(choice.finish_reason, 128)
      if (finishReason) result.finishReason = finishReason
    })
    if (!result.finishReason || !['stop', 'tool_calls'].includes(result.finishReason)) {
      const reason = result.finishReason === 'length' ? 'max_output_tokens' : result.finishReason === 'content_filter' ? 'content_filter' : 'unknown'
      sse(response, 'response.incomplete', { response: { ...base, status: 'incomplete', incomplete_details: { reason } } })
      return
    }
    if (textStarted) {
      textItem.content = [{ type: 'output_text', text }]
      sse(response, 'response.output_text.done', { output_index: output.length, content_index: 0, text })
      sse(response, 'response.content_part.done', { output_index: output.length, content_index: 0, part: { type: 'output_text', text } })
      sse(response, 'response.output_item.done', { output_index: output.length, item: textItem })
      output.push(textItem)
    }
    for (const call of [...calls.values()].sort((left, right) => left.index - right.index)) {
      if (!call.name || !call.arguments) throw new Error('CODEX_CHAT_ADAPTER_TOOL_CALL_INCOMPLETE')
      const item = {
        id: call.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      }
      sse(response, 'response.output_item.done', { output_index: output.length, item })
      output.push(item)
    }
    sse(response, 'response.completed', {
      response: {
        ...base,
        status: 'completed',
        output,
        usage: {
          input_tokens: result.inputTokens ?? 0,
          output_tokens: result.outputTokens ?? 0,
          total_tokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
        },
      },
    })
  }

  private async readSse(upstream: Response, signal: AbortSignal, onData: (data: JsonObject) => void): Promise<void> {
    const reader = upstream.body?.getReader()
    if (!reader) throw new Error('CODEX_CHAT_ADAPTER_UPSTREAM_BODY_MISSING')
    const decoder = new TextDecoder()
    let buffer = ''
    const consume = (block: string): void => {
      if (Buffer.byteLength(block) > MAX_SSE_EVENT_BYTES) throw new Error('CODEX_CHAT_ADAPTER_UPSTREAM_EVENT_TOO_LARGE')
      const data = block.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (!data || data === '[DONE]') return
      const parsed = record(JSON.parse(data))
      if (!parsed) throw new Error('CODEX_CHAT_ADAPTER_UPSTREAM_EVENT_INVALID')
      onData(parsed)
    }
    try {
      while (true) {
        if (signal.aborted) throw new Error('CODEX_CHAT_ADAPTER_ABORTED')
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n')
        if (Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES) throw new Error('CODEX_CHAT_ADAPTER_UPSTREAM_EVENT_TOO_LARGE')
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          consume(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) consume(buffer)
    } finally {
      reader.releaseLock()
    }
  }
}

type ResponsesCredentialAdapterOptions = {
  upstreamUrl: string
  failurePrefix: 'CODEX_GATEWAY_ADAPTER' | 'CODEX_PERSONAL_RESPONSES_ADAPTER'
  resolveHeaders(request: IncomingMessage): Promise<Record<string, string>>
}

/**
 * Loopback-only credential bridge for one Responses endpoint.
 *
 * It is intentionally not an Agent service: it owns neither Thread data,
 * turns, tool calls, approvals, retries, result cache nor a durable queue.
 * Electron Main retains the real credential; the App Server receives only a
 * short-lived capability token. Refusing redirects is deliberate: a provider
 * endpoint is part of the saved user contract, not an unverified discovery
 * redirect that may receive its credential.
 */
class ResponsesCredentialAdapter {
  private readonly capabilityToken = randomBytes(32).toString('base64url')
  private readonly sockets = new Set<Socket>()
  private readonly activeRequests = new Set<AbortController>()
  private server?: Server
  private closed = false

  constructor(private readonly options: ResponsesCredentialAdapterOptions) {}

  private code(suffix: string): string { return `${this.options.failurePrefix}_${suffix}` }

  async start(): Promise<{ baseUrl: string; capabilityToken: string }> {
    if (this.server || this.closed) throw new Error(this.code('UNAVAILABLE'))
    const server = createServer((request, response) => { void this.handle(request, response) })
    server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new Error(this.code('LISTEN_FAILED'))
    }
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, capabilityToken: this.capabilityToken }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const controller of this.activeRequests) controller.abort()
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!loopbackAddress(request.socket.remoteAddress)) return adapterFailure(response, 403, this.code('LOOPBACK_REQUIRED'))
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'POST' || url.pathname !== '/v1/responses' || url.search) {
      return adapterFailure(response, 404, this.code('ROUTE_NOT_FOUND'))
    }
    if (request.headers[ENGINE_TOKEN_HEADER.toLowerCase()] !== this.capabilityToken) {
      return adapterFailure(response, 401, this.code('UNAUTHORIZED'))
    }
    let body: string
    try {
      body = await requestText(request)
    } catch {
      return adapterFailure(response, 413, this.code('REQUEST_TOO_LARGE'))
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    this.activeRequests.add(controller)
    try {
      const upstream = await fetch(this.options.upstreamUrl, {
        method: 'POST',
        headers: await this.options.resolveHeaders(request),
        body,
        redirect: 'error',
        signal: controller.signal,
      })
      const headers: Record<string, string> = {}
      const contentType = upstream.headers.get('content-type')
      const cacheControl = upstream.headers.get('cache-control')
      if (contentType) headers['Content-Type'] = contentType
      if (cacheControl) headers['Cache-Control'] = cacheControl
      response.writeHead(upstream.status, headers)
      if (!upstream.body) {
        response.end()
        return
      }
      const reader = upstream.body.getReader()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (!response.write(Buffer.from(next.value))) {
            await new Promise<void>(resolve => response.once('drain', resolve))
          }
        }
      } finally {
        reader.releaseLock()
      }
      response.end()
    } catch {
      if (!response.headersSent) adapterFailure(response, 502, this.code('UPSTREAM_UNAVAILABLE'))
      else if (!response.writableEnded) response.destroy()
    } finally {
      this.activeRequests.delete(controller)
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
    }
  }
}

/** Build the exact source-provider configuration for one private App Server. */
export async function startCodexNativeProvider(route: CodexNativeModelRoute): Promise<StartedCodexNativeProvider> {
  if (route.kind === 'managed') {
    const model = route.model.trim()
    if (!model) throw new Error('CODEX_NATIVE_MANAGED_ROUTE_INVALID')
    const contextWindowTokens = modelContextWindow(
      route.contextWindowTokens,
      'CODEX_NATIVE_MANAGED_MODEL_LIMITS_INVALID',
    )
    const adapter = new ResponsesCredentialAdapter({
      upstreamUrl: `${managedResponsesBaseUrl(route.gatewayUrl)}/responses`,
      failurePrefix: 'CODEX_GATEWAY_ADAPTER',
      resolveHeaders: async request => {
        const accessToken = await route.resolveAccessToken()
        if (!accessToken.trim()) throw new Error('CODEX_GATEWAY_ADAPTER_ACCESS_TOKEN_INVALID')
        const operationId = typeof request.headers['x-bb-operation-id'] === 'string'
          && /^[A-Za-z0-9._:-]{8,200}$/.test(request.headers['x-bb-operation-id'])
          ? request.headers['x-bb-operation-id']
          : undefined
        const idempotencyKey = typeof request.headers['idempotency-key'] === 'string'
          && request.headers['idempotency-key'].length <= 160
          ? request.headers['idempotency-key']
          : undefined
        return {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-BB-Provider-Protocol': 'bb-provider-gateway/1.0',
          ...(operationId ? { 'X-BB-Operation-Id': operationId } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        }
      },
    })
    try {
      const started = await adapter.start()
      const tokenEnv = 'BB_CODEX_GATEWAY_ADAPTER_TOKEN'
      const config = providerOverrides({
        id: 'billiardbuddy',
        name: 'BilliardBuddy managed DeepSeek gateway adapter',
        baseUrl: started.baseUrl,
        contextWindowTokens,
        envHeaders: { [ENGINE_TOKEN_HEADER]: tokenEnv },
      })
      return {
        model,
        configOverrides: config,
        environment: { [tokenEnv]: started.capabilityToken },
        close: async () => await adapter.close(),
      }
    } catch (error) {
      await adapter.close()
      throw error
    }
  }

  const { profile } = route
  const contextWindowTokens = personalModelContextWindow(profile)
  if (profile.protocol === 'openai-responses') {
    const adapter = new ResponsesCredentialAdapter({
      upstreamUrl: personalModelEndpoint(profile.base_url, 'responses'),
      failurePrefix: 'CODEX_PERSONAL_RESPONSES_ADAPTER',
      resolveHeaders: async () => ({
        ...personalModelAuthHeader(profile),
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      }),
    })
    try {
      const started = await adapter.start()
      const tokenEnv = 'BB_CODEX_PERSONAL_RESPONSES_ADAPTER_TOKEN'
      const config = providerOverrides({
        id: 'billiardbuddy',
        name: 'BilliardBuddy local personal Responses adapter',
        baseUrl: started.baseUrl,
        contextWindowTokens,
        envHeaders: { [ENGINE_TOKEN_HEADER]: tokenEnv },
      })
      return {
        model: profile.model,
        configOverrides: config,
        environment: { [tokenEnv]: started.capabilityToken },
        close: async () => await adapter.close(),
      }
    } catch (error) {
      await adapter.close()
      throw error
    }
  }

  if (profile.protocol !== 'openai-compatible') {
    throw new Error('CODEX_NATIVE_PROVIDER_PROTOCOL_UNSUPPORTED')
  }

  const adapter = new ChatCompletionsResponsesAdapter(profile)
  try {
    const started = await adapter.start()
    const tokenEnv = 'BB_CODEX_CHAT_ADAPTER_TOKEN'
    const config = providerOverrides({
      id: 'billiardbuddy',
      name: 'BilliardBuddy local Chat Completions adapter',
      baseUrl: started.baseUrl,
      contextWindowTokens,
      envHeaders: { [ENGINE_TOKEN_HEADER]: tokenEnv },
    })
    return {
      model: profile.model,
      configOverrides: config,
      environment: { [tokenEnv]: started.capabilityToken },
      close: async () => await adapter.close(),
    }
  } catch (error) {
    await adapter.close()
    throw error
  }
}
