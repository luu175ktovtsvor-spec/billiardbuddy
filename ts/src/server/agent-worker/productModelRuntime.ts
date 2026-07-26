import { randomUUID } from 'node:crypto'
import { PROVIDER_GATEWAY_PROTOCOL, PROVIDER_GATEWAY_PROTOCOL_HEADER } from '../../../shared/product/providerGateway.js'
import type { ProductAssistantMessage, ProductHarnessMessage, ProductModelEvent } from '../../../shared/product/harnessMessages.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { productGatewayTarget } from '../product/productGatewayRuntime.js'
import { emptyProductToolPermissionContext, type ProductThinkingConfig, type ProductToolPermissionContext, type ProductTools } from './productTool.js'

type ProductModelOptions = {
  model: string
}

export type ProductModelRunner = (input: {
  messages: ProductHarnessMessage[]
  systemPrompt: readonly string[]
  thinkingConfig: ProductThinkingConfig
  tools: ProductTools
  signal: AbortSignal
  options: ProductModelOptions
  toolPermissionContext?: ProductToolPermissionContext
}) => AsyncGenerator<ProductModelEvent, void>

type OpenAiMessage = Record<string, unknown>
type ToolAccumulator = { id: string; name: string; arguments: string }
type OpenAiUserPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

function contentParts(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter(value => value && typeof value === 'object') as Array<Record<string, unknown>> : []
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return JSON.stringify(value)
  return value.map(item => typeof item === 'string' ? item : item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text ?? '') : JSON.stringify(item)).join('\n')
}

function toOpenAiMessages(messages: ProductHarnessMessage[]): OpenAiMessage[] {
  const output: OpenAiMessage[] = []
  for (const item of messages) {
    const role = item.message?.role
    const parts = contentParts(item.message?.content)
    if (role === 'assistant') {
      const text = parts.filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('')
      const toolCalls = parts.filter(part => part.type === 'tool_call').map(part => ({
        id: String(part.id ?? ''),
        type: 'function',
        function: { name: String(part.name ?? ''), arguments: JSON.stringify(part.arguments ?? {}) },
      }))
      output.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
      continue
    }
    const toolResults = parts.filter(part => part.type === 'tool_result')
    for (const result of toolResults) output.push({ role: 'tool', tool_call_id: String(result.tool_call_id ?? ''), content: textContent(result.content) })
    const ordinary = parts.filter(part => part.type !== 'tool_result').flatMap<OpenAiUserPart>(part => {
      if (part.type === 'text') return [{ type: 'text', text: String(part.text ?? '') }]
      if (part.type === 'image') return [{ type: 'image_url', image_url: { url: `data:${String(part.media_type)};base64,${String(part.data)}` } }]
      return []
    })
    if (ordinary.length) output.push({ role: 'user', content: ordinary.length === 1 && ordinary[0]?.type === 'text' ? ordinary[0].text : ordinary })
  }
  return output
}

async function gatewayTools(tools: ProductTools, toolPermissionContext: ProductToolPermissionContext): Promise<Array<Record<string, unknown>>> {
  if (tools.length > 256) throw new Error('PRODUCT_MODEL_TOOL_LIMIT')
  return Promise.all(tools.map(async tool => {
    const options = {
      isNonInteractiveSession: true,
      toolPermissionContext,
      tools,
    }
    const description = [
      await tool.description({}, options),
      await tool.prompt?.({ tools }),
    ].filter((value): value is string => Boolean(value?.trim())).join('\n\n').slice(0, 4_000)
    return {
      type: 'function',
      function: {
        name: tool.name,
        description,
        parameters: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),
      },
    }
  }))
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    throw new Error('PRODUCT_MODEL_INVALID_TOOL_ARGUMENTS')
  }
}

async function* sseData(response: Response, signal: AbortSignal): AsyncGenerator<Record<string, unknown>, void> {
  if (!response.body) throw new Error('PRODUCT_MODEL_EMPTY_STREAM')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal.aborted) throw new Error('PRODUCT_MODEL_ABORTED')
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      buffer = buffer.replaceAll('\r\n', '\n')
      if (buffer.length > 4 * 1024 * 1024) throw new Error('PRODUCT_MODEL_STREAM_FRAME_LIMIT')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let parsed: unknown
          try { parsed = JSON.parse(data) } catch { throw new Error('PRODUCT_MODEL_INVALID_STREAM') }
          if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export const runProductModel: ProductModelRunner = async function* ({ messages, systemPrompt, thinkingConfig, tools, signal, options, toolPermissionContext }) {
  const target = productGatewayTarget()
  if (!target) throw new Error('PRODUCT_GATEWAY_NOT_CONFIGURED')
  const requestId = randomUUID()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${target.token}`,
    'Content-Type': 'application/json',
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    'X-BB-Operation-ID': `chat:${requestId}`,
  }
  const system = systemPrompt.filter(Boolean).join('\n\n')
  const body = {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16_384,
    messages: [{ role: 'system', content: system }, ...toOpenAiMessages(messages)],
    tools: await gatewayTools(tools, toolPermissionContext ?? emptyProductToolPermissionContext()),
    ...(thinkingConfig.type === 'disabled' ? {} : { thinking: { type: 'enabled' } }),
  }
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal })
  } catch {
    throw new Error(signal.aborted ? 'PRODUCT_MODEL_ABORTED' : 'PRODUCT_GATEWAY_UNREACHABLE')
  }
  if (!response.ok) throw new Error(`PRODUCT_GATEWAY_HTTP_${response.status}`)

  let text = ''
  let model = options.model
  let stopReason: string | null = null
  let usage = { input_tokens: 0, output_tokens: 0 }
  const calls = new Map<number, ToolAccumulator>()
  for await (const chunk of sseData(response, signal)) {
    if (typeof chunk.model === 'string') model = chunk.model
    const rawUsage = chunk.usage as Record<string, unknown> | undefined
    if (rawUsage) usage = { input_tokens: Number(rawUsage.prompt_tokens ?? 0), output_tokens: Number(rawUsage.completion_tokens ?? 0) }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] as Record<string, unknown> | undefined : undefined
    if (!choice) continue
    if (typeof choice.finish_reason === 'string') stopReason = choice.finish_reason
    const delta = choice.delta as Record<string, unknown> | undefined
    if (typeof delta?.content === 'string' && delta.content) {
      text += delta.content
      yield { type: 'model_delta', text: delta.content }
    }
    for (const raw of Array.isArray(delta?.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : []) {
      const index = Number(raw.index ?? 0)
      const fn = raw.function as Record<string, unknown> | undefined
      const current = calls.get(index) ?? { id: '', name: '', arguments: '' }
      if (typeof raw.id === 'string' && !current.id) current.id = raw.id
      if (typeof fn?.name === 'string') current.name += fn.name
      if (typeof fn?.arguments === 'string') current.arguments += fn.arguments
      calls.set(index, current)
    }
  }
  const content: ProductAssistantMessage['message']['content'] = []
  if (text) content.push({ type: 'text', text })
  for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    if (!call.name) throw new Error('PRODUCT_MODEL_INVALID_TOOL_CALL')
    content.push({ type: 'tool_call', id: call.id || `tool_${randomUUID()}`, name: call.name, arguments: parseArguments(call.arguments) })
  }
  if (!content.length) throw new Error('PRODUCT_MODEL_EMPTY_RESPONSE')
  yield {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: requestId,
      role: 'assistant',
      content,
      model,
      stop_reason: stopReason === 'length'
        ? 'length'
        : calls.size
          ? 'tool_call'
          : stopReason === 'stop'
            ? 'end_turn'
            : stopReason,
      usage,
    },
  }
}
