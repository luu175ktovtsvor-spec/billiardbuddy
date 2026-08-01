import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import type { ProductAssistantMessage, ProductContentBlock, ProductHarnessMessage, ProductModelEvent, ProductTextBlock, ProductToolCallBlock, ProductToolResultBlock, ProductUserMessage } from '../../../shared/product/harnessMessages.js'
import { buildProductTool, type ProductThinkingConfig, type ProductTools } from '../agent-worker/productTool.js'

// Must accommodate the bounded source representation of up to four Host
// attachment images. This loopback request remains capped by the product
// attachment policy and CodexEngineRuntime's aggregate turn-input limit.
const MAX_BRIDGE_REQUEST_BYTES = 128 * 1024 * 1024
const MAX_BRIDGE_INPUT_ITEMS = 32_768
const MAX_BRIDGE_TOOLS = 256
const MAX_BRIDGE_TEXT_CHARS = 8 * 1024 * 1024

type RecordValue = Record<string, unknown>

export type CodexResponsesModelRequest = {
  messages: ProductHarnessMessage[]
  system_prompt: string[]
  tools: ProductTools
  thinking_config: ProductThinkingConfig
  model?: string
}

export type CodexResponsesModelRunner = (request: CodexResponsesModelRequest) => AsyncGenerator<ProductModelEvent, void>

export type CodexResponsesModelBridgeOptions = {
  run_model: CodexResponsesModelRunner
  /** Result receipts must reach the product ledger before `response.completed`. */
  checkpoint_model_result(assistant: ProductAssistantMessage): Promise<void>
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}

function text(value: unknown, limit = MAX_BRIDGE_TEXT_CHARS): string | undefined {
  return typeof value === 'string' && value.length <= limit ? value : undefined
}

function nonEmptyText(value: unknown, limit = 512): string | undefined {
  const result = text(value, limit)
  return result && result.length > 0 ? result : undefined
}

function bridgeError(code: string): Error {
  return new Error(code)
}

function productUser(content: string | ProductContentBlock[]): ProductUserMessage {
  return {
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'user',
    message: { role: 'user', content },
  }
}

function productAssistant(content: Array<ProductTextBlock | ProductToolCallBlock>): ProductAssistantMessage {
  return {
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'assistant',
    message: {
      id: `engine_context_${randomUUID()}`,
      role: 'assistant',
      content,
      model: 'billiardbuddy-engine-context',
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

function parseDataImage(value: unknown): Extract<ProductContentBlock, { type: 'image' }> | undefined {
  const source = text(value, 32 * 1024 * 1024)
  const match = source?.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/)
  return match ? { type: 'image', media_type: match[1] as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: match[2]! } : undefined
}

function parseContent(value: unknown): Array<ProductTextBlock | Extract<ProductContentBlock, { type: 'image' }>> {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value) || value.length > 8_192) throw bridgeError('CODEX_RESPONSES_CONTENT_INVALID')
  const parts: Array<ProductTextBlock | Extract<ProductContentBlock, { type: 'image' }>> = []
  for (const raw of value) {
    const item = record(raw)
    const type = nonEmptyText(item?.type, 128)
    if (!item || !type) throw bridgeError('CODEX_RESPONSES_CONTENT_INVALID')
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const value = text(item.text)
      if (value === undefined) throw bridgeError('CODEX_RESPONSES_CONTENT_INVALID')
      parts.push({ type: 'text', text: value })
      continue
    }
    if (type === 'input_image') {
      const image = parseDataImage(item.image_url ?? item.url)
      if (!image) throw bridgeError('CODEX_RESPONSES_IMAGE_UNSUPPORTED')
      parts.push(image)
      continue
    }
    throw bridgeError('CODEX_RESPONSES_CONTENT_UNSUPPORTED')
  }
  return parts
}

function contentText(parts: readonly ProductTextBlock[]): string {
  return parts.map(part => part.text).join('')
}

function parseArguments(value: unknown): RecordValue {
  const serialized = text(value, 2 * 1024 * 1024)
  if (serialized === undefined) throw bridgeError('CODEX_RESPONSES_FUNCTION_ARGUMENTS_INVALID')
  let parsed: unknown
  try { parsed = JSON.parse(serialized || '{}') } catch { throw bridgeError('CODEX_RESPONSES_FUNCTION_ARGUMENTS_INVALID') }
  const object = record(parsed)
  if (!object) throw bridgeError('CODEX_RESPONSES_FUNCTION_ARGUMENTS_INVALID')
  return object
}

function parseToolOutput(value: unknown): ProductToolResultBlock['content'] {
  if (typeof value === 'string') return value
  const content = parseContent(value)
  return content
}

function parseMessage(item: RecordValue, messages: ProductHarnessMessage[], systemPrompt: string[]): void {
  const role = nonEmptyText(item.role, 64)
  if (!role) throw bridgeError('CODEX_RESPONSES_MESSAGE_INVALID')
  const content = parseContent(item.content)
  if (role === 'user') {
    messages.push(productUser(content))
    return
  }
  if (role === 'assistant') {
    messages.push(productAssistant(content.filter((part): part is ProductTextBlock => part.type === 'text')))
    return
  }
  if (role === 'developer' || role === 'system') {
    const systemText = contentText(content.filter((part): part is ProductTextBlock => part.type === 'text'))
    if (systemText) systemPrompt.push(systemText)
    return
  }
  throw bridgeError('CODEX_RESPONSES_MESSAGE_ROLE_UNSUPPORTED')
}

function parseResponseInput(value: unknown, systemPrompt: string[]): ProductHarnessMessage[] {
  const rawItems = typeof value === 'string'
    ? [{ type: 'message', role: 'user', content: value }]
    : value
  if (!Array.isArray(rawItems) || rawItems.length > MAX_BRIDGE_INPUT_ITEMS) throw bridgeError('CODEX_RESPONSES_INPUT_INVALID')
  const messages: ProductHarnessMessage[] = []
  for (const raw of rawItems) {
    const item = record(raw)
    const type = nonEmptyText(item?.type, 128)
    if (!item || !type) throw bridgeError('CODEX_RESPONSES_INPUT_INVALID')
    if (type === 'message') {
      parseMessage(item, messages, systemPrompt)
      continue
    }
    if (type === 'agent_message') {
      const content = parseContent(item.content)
      messages.push(productAssistant(content.filter((part): part is ProductTextBlock => part.type === 'text')))
      continue
    }
    if (type === 'function_call' || type === 'custom_tool_call') {
      const id = nonEmptyText(item.call_id)
      const name = nonEmptyText(item.name)
      const argumentsValue = type === 'function_call' ? item.arguments : item.input
      if (!id || !name) throw bridgeError('CODEX_RESPONSES_FUNCTION_CALL_INVALID')
      messages.push(productAssistant([{ type: 'tool_call', id, name, arguments: parseArguments(argumentsValue) }]))
      continue
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const id = nonEmptyText(item.call_id)
      if (!id) throw bridgeError('CODEX_RESPONSES_FUNCTION_OUTPUT_INVALID')
      messages.push(productUser([{ type: 'tool_result', tool_call_id: id, content: parseToolOutput(item.output) }]))
      continue
    }
    // These are engine-internal bookkeeping items. They neither convey a
    // user-visible message nor a completed product tool result to the model.
    if (['reasoning', 'compaction', 'context_compaction', 'compaction_trigger', 'additional_tools'].includes(type)) continue
    throw bridgeError('CODEX_RESPONSES_INPUT_UNSUPPORTED')
  }
  return messages
}

function parseTools(value: unknown): ProductTools {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_BRIDGE_TOOLS) throw bridgeError('CODEX_RESPONSES_TOOLS_INVALID')
  const names = new Set<string>()
  return value.map(raw => {
    const tool = record(raw)
    if (!tool || nonEmptyText(tool.type, 128) !== 'function') throw bridgeError('CODEX_RESPONSES_TOOL_UNSUPPORTED')
    const name = nonEmptyText(tool.name, 128)
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || names.has(name)) throw bridgeError('CODEX_RESPONSES_TOOLS_INVALID')
    names.add(name)
    const description = text(tool.description, 16 * 1024) ?? ''
    const schema = record(tool.parameters ?? tool.input_schema ?? tool.inputSchema) ?? {}
    return buildProductTool({
      name,
      inputSchema: z.object({}).passthrough(),
      inputJSONSchema: schema,
      maxResultSizeChars: 4 * 1024 * 1024,
      description: async () => description,
      call: async () => { throw bridgeError('CODEX_ENGINE_TOOL_HOST_UNAVAILABLE') },
      mapToolResultToToolResultBlockParam: (content, toolUseId) => ({ type: 'tool_result', tool_use_id: toolUseId, content: typeof content === 'string' ? content : JSON.stringify(content) }),
    })
  })
}

function parseModelRequest(value: unknown): CodexResponsesModelRequest {
  const request = record(value)
  if (!request || request.stream !== true) throw bridgeError('CODEX_RESPONSES_STREAM_REQUIRED')
  const systemPrompt: string[] = []
  const instructions = text(request.instructions, MAX_BRIDGE_TEXT_CHARS)
  if (instructions) systemPrompt.push(instructions)
  return {
    messages: parseResponseInput(request.input, systemPrompt),
    system_prompt: systemPrompt,
    tools: parseTools(request.tools),
    thinking_config: request.reasoning === undefined ? { type: 'adaptive' } : { type: 'enabled' },
    ...(text(request.model, 512) ? { model: text(request.model, 512) } : {}),
  }
}

function sse(type: string, data: RecordValue): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
}

function responseFailure(code: string): Response {
  return Response.json({ error: { code, message: code } }, { status: 400 })
}

/**
 * A loopback-only Responses server for the upstream engine. It does not hold
 * model credentials: every model request crosses the supplied BilliardBuddy
 * runner, which keeps Gateway-vs-personal-key routing and operation receipts
 * in the existing trusted server process.
 */
export class CodexResponsesModelBridge {
  private server?: ReturnType<typeof Bun.serve>
  private active = false
  private readonly capabilityToken = randomUUID()

  constructor(private readonly options: CodexResponsesModelBridgeOptions) {}

  start(): { base_url: string; capability_token: string } {
    if (this.server) throw bridgeError('CODEX_RESPONSES_BRIDGE_ALREADY_STARTED')
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => await this.handle(request),
    })
    return { base_url: `http://127.0.0.1:${this.server.port}/v1`, capability_token: this.capabilityToken }
  }

  stop(): void {
    this.server?.stop(true)
    this.server = undefined
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/v1/responses') return new Response('Not found', { status: 404 })
    if (request.headers.get('X-BilliardBuddy-Engine-Token') !== this.capabilityToken) return new Response('Unauthorized', { status: 401 })
    if (this.active) return new Response('Model request already active', { status: 409 })
    const length = Number(request.headers.get('content-length') ?? 0)
    if (!Number.isFinite(length) || length > MAX_BRIDGE_REQUEST_BYTES) return responseFailure('CODEX_RESPONSES_REQUEST_TOO_LARGE')
    let body: unknown
    try {
      const serialized = await request.text()
      if (Buffer.byteLength(serialized) > MAX_BRIDGE_REQUEST_BYTES) return responseFailure('CODEX_RESPONSES_REQUEST_TOO_LARGE')
      body = JSON.parse(serialized)
    } catch {
      return responseFailure('CODEX_RESPONSES_REQUEST_INVALID')
    }
    let modelRequest: CodexResponsesModelRequest
    try { modelRequest = parseModelRequest(body) } catch (error) {
      return responseFailure(error instanceof Error ? error.message : 'CODEX_RESPONSES_REQUEST_INVALID')
    }
    this.active = true
    const responseId = `resp_${randomUUID()}`
    const stream = new ReadableStream<Uint8Array>({
      start: controller => { void this.streamModelResponse(controller, responseId, modelRequest) },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } })
  }

  private async streamModelResponse(controller: ReadableStreamDefaultController<Uint8Array>, responseId: string, request: CodexResponsesModelRequest): Promise<void> {
    const createdAt = Math.floor(Date.now() / 1_000)
    const write = (type: string, data: RecordValue) => controller.enqueue(sse(type, data))
    const responseBase = { id: responseId, object: 'response', created_at: createdAt, model: request.model ?? 'billiardbuddy-managed' }
    try {
      write('response.created', { response: { ...responseBase, status: 'in_progress', output: [] } })
      write('response.in_progress', { response: { ...responseBase, status: 'in_progress', output: [] } })
      let final: ProductAssistantMessage | undefined
      let streamedText = ''
      const messageId = `msg_${randomUUID()}`
      let textItemStarted = false
      for await (const event of this.options.run_model(request)) {
        if (event.type === 'model_delta') {
          if (!textItemStarted) {
            textItemStarted = true
            write('response.output_item.added', { output_index: 0, item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
            write('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
          }
          streamedText += event.text
          write('response.output_text.delta', { output_index: 0, content_index: 0, delta: event.text })
          continue
        }
        if (final) throw bridgeError('CODEX_RESPONSES_MODEL_RESULT_DUPLICATED')
        final = event
      }
      if (!final) throw bridgeError('CODEX_RESPONSES_MODEL_RESULT_MISSING')
      const textOutput = final.message.content.filter((block): block is ProductTextBlock => block.type === 'text').map(block => block.text).join('')
      if (textOutput && !textItemStarted) {
        textItemStarted = true
        write('response.output_item.added', { output_index: 0, item: { id: messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
        write('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
      }
      if (textOutput.startsWith(streamedText) && textOutput.length > streamedText.length) {
        write('response.output_text.delta', { output_index: 0, content_index: 0, delta: textOutput.slice(streamedText.length) })
      } else if (textOutput !== streamedText && textOutput) {
        throw bridgeError('CODEX_RESPONSES_MODEL_DELTA_MISMATCH')
      }
      const output: RecordValue[] = []
      if (textItemStarted) {
        const message = { id: messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: textOutput }] }
        write('response.output_text.done', { output_index: 0, content_index: 0, text: textOutput })
        write('response.content_part.done', { output_index: 0, content_index: 0, part: { type: 'output_text', text: textOutput } })
        write('response.output_item.done', { output_index: 0, item: message })
        output.push(message)
      }
      const calls = final.message.content.filter((block): block is ProductToolCallBlock => block.type === 'tool_call')
      for (const call of calls) {
        const item = { id: `fc_${randomUUID()}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }
        const outputIndex = output.length
        write('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress' } })
        write('response.output_item.done', { output_index: outputIndex, item })
        output.push(item)
      }
      await this.options.checkpoint_model_result(final)
      write('response.completed', {
        response: {
          ...responseBase,
          status: 'completed',
          output,
          usage: { input_tokens: final.message.usage.input_tokens, output_tokens: final.message.usage.output_tokens, total_tokens: final.message.usage.input_tokens + final.message.usage.output_tokens },
        },
      })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'CODEX_RESPONSES_BRIDGE_FAILED'
      write('response.failed', { response: { ...responseBase, status: 'failed', error: { code, message: code } } })
    } finally {
      this.active = false
      controller.close()
    }
  }
}
