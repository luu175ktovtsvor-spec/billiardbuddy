import { randomUUID } from 'node:crypto'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
  PROVIDER_OPERATION_ACK_PATH,
  PROVIDER_OPERATION_ID_HEADER,
  PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER,
  PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER,
  PROVIDER_OPERATION_RESULT_ID_HEADER,
} from '../../../shared/product/providerGateway.js'
import type { ProductAssistantMessage, ProductHarnessMessage, ProductModelOperationReceipt } from '../../../shared/product/harnessMessages.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { productGatewayTarget } from '../product/productGatewayRuntime.js'
import {
  personalModelBody,
  personalModelHttpError,
  personalModelRequestTargetForProfile,
} from '../services/personalModelRequest.js'
import {
  beginPersonalModelOperation,
  acknowledgePersonalModelOperation,
  completePersonalModelOperation,
  markPersonalModelOperationOutcomeUnknown,
  personalModelStatusHasDefiniteNoResult,
  releasePersonalModelOperation,
} from '../services/personalModelOperationStore.js'
import { emptyProductToolPermissionContext, type ProductThinkingConfig, type ProductToolPermissionContext, type ProductTools } from './productTool.js'
import type { ProductAgentModelRunner } from './agentModelPort.js'

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

function gatewayOperationReceipt(response: Response): ProductModelOperationReceipt {
  const operationId = response.headers.get(PROVIDER_OPERATION_RESULT_ID_HEADER)?.trim() ?? ''
  const capability = response.headers.get(PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER)?.trim() ?? ''
  const fingerprint = response.headers.get(PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER)?.trim() ?? ''
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)
    || capability !== 'TextReasoning'
    || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('PRODUCT_GATEWAY_OPERATION_RECEIPT_MISSING')
  }
  return { source: 'gateway', capability: 'TextReasoning', operation_id: operationId, fingerprint }
}

async function acknowledgeGatewayOperation(
  target: { baseUrl: string; token: string },
  receipt: ProductModelOperationReceipt,
  signal: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${target.baseUrl}${PROVIDER_OPERATION_ACK_PATH}`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${target.token}`,
        [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        [PROVIDER_OPERATION_RESULT_ID_HEADER]: receipt.operation_id,
        [PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER]: 'TextReasoning',
        [PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER]: receipt.fingerprint,
      },
    })
  } catch {
    throw new Error(signal.aborted ? 'PRODUCT_MODEL_ABORTED' : 'PRODUCT_GATEWAY_RESULT_ACK_UNREACHABLE')
  }
  if (!response.ok) throw new Error(`PRODUCT_GATEWAY_RESULT_ACK_HTTP_${response.status}`)
}

export async function acknowledgeProductModelOperation(
  receipt: ProductModelOperationReceipt,
  signal: AbortSignal,
): Promise<void> {
  if (receipt.source === 'personal') {
    if (signal.aborted) throw new Error('PRODUCT_MODEL_ABORTED')
    acknowledgePersonalModelOperation({
      principal_id: 'billiardbuddy-local-personal-model',
      installation_id: 'billiardbuddy-local-installation',
      operation_id: receipt.operation_id,
      capability: receipt.capability,
      fingerprint: receipt.fingerprint,
    })
    return
  }
  const target = productGatewayTarget()
  if (!target) throw new Error('PRODUCT_GATEWAY_NOT_CONFIGURED')
  await acknowledgeGatewayOperation(target, receipt, signal)
}

export const runProductModel: ProductAgentModelRunner = async function* ({ messages, systemPrompt, thinkingConfig, tools, signal, options, toolPermissionContext }) {
  const personalProfile = options.personalProfile ?? null
  const target = personalProfile ? null : productGatewayTarget()
  if (!personalProfile && !target) throw new Error('PRODUCT_GATEWAY_NOT_CONFIGURED')
  const requestId = options.operationId ?? `chat:${randomUUID()}`
  const system = systemPrompt.filter(Boolean).join('\n\n')
  const gatewayBody = {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 16_384,
    messages: [{ role: 'system', content: system }, ...toOpenAiMessages(messages)],
    tools: await gatewayTools(tools, toolPermissionContext ?? emptyProductToolPermissionContext()),
    ...(thinkingConfig.type === 'disabled' ? {} : { thinking: { type: 'enabled' } }),
  }
  const personalTarget = personalProfile ? personalModelRequestTargetForProfile(personalProfile) : null
  const body = personalProfile ? personalModelBody(personalProfile, gatewayBody) : gatewayBody
  const serializedBody = JSON.stringify(body)
  const personalOperation = personalProfile
    ? beginPersonalModelOperation({
        capability: 'TextReasoning',
        operationId: requestId,
        profile: personalProfile,
        requestBody: serializedBody,
      })
    : null
  if (personalOperation?.outcome === 'in_progress') throw new Error('PRODUCT_MODEL_OPERATION_IN_PROGRESS')
  if (personalOperation?.outcome === 'outcome_unknown') throw new Error('PRODUCT_MODEL_OPERATION_OUTCOME_UNKNOWN')
  if (personalOperation?.outcome === 'succeeded') {
    let stored: unknown
    try { stored = JSON.parse(personalOperation.payload) } catch { throw new Error('PRODUCT_MODEL_OPERATION_RESULT_UNAVAILABLE') }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('PRODUCT_MODEL_OPERATION_RESULT_UNAVAILABLE')
    const assistant = (stored as { assistant?: unknown }).assistant
    if (!assistant || typeof assistant !== 'object' || Array.isArray(assistant)) throw new Error('PRODUCT_MODEL_OPERATION_RESULT_UNAVAILABLE')
    yield {
      ...(assistant as ProductAssistantMessage),
      operation_receipt: {
        source: 'personal',
        capability: 'TextReasoning',
        operation_id: personalOperation.binding.operation_id,
        fingerprint: personalOperation.binding.fingerprint,
      },
    }
    return
  }
  const personalHandle = personalOperation?.outcome === 'started' ? personalOperation.handle : null
  const headers: Record<string, string> = personalTarget
    ? personalTarget.headers
    : {
        Authorization: `Bearer ${target!.token}`,
        'Content-Type': 'application/json',
        [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        [PROVIDER_OPERATION_ID_HEADER]: requestId,
      }
  let response: Response
  try {
    response = await fetch(personalTarget?.url ?? `${target!.baseUrl}/v1/chat/completions`, { method: 'POST', headers, body: serializedBody, signal })
  } catch {
    if (personalHandle) markPersonalModelOperationOutcomeUnknown(personalHandle)
    throw new Error(signal.aborted ? 'PRODUCT_MODEL_ABORTED' : personalProfile ? 'PRODUCT_MODEL_OPERATION_OUTCOME_UNKNOWN' : 'PRODUCT_GATEWAY_UNREACHABLE')
  }
  if (!response.ok) {
    if (personalHandle) {
      if (personalModelStatusHasDefiniteNoResult(response.status)) releasePersonalModelOperation(personalHandle)
      else markPersonalModelOperationOutcomeUnknown(personalHandle)
    }
    throw new Error(personalProfile ? personalModelHttpError(response.status) : `PRODUCT_GATEWAY_HTTP_${response.status}`)
  }
  const managedOperationReceipt = personalProfile ? null : gatewayOperationReceipt(response)

  let text = ''
  let model = options.model
  let stopReason: string | null = null
  let usage = { input_tokens: 0, output_tokens: 0 }
  const calls = new Map<number, ToolAccumulator>()
  try {
  for await (const chunk of sseData(response, signal)) {
    if (personalProfile?.protocol === 'openai-responses') {
      const event = typeof chunk.type === 'string' ? chunk.type : ''
      if (event === 'response.output_text.delta' && typeof chunk.delta === 'string') {
        text += chunk.delta
        yield { type: 'model_delta', text: chunk.delta }
      }
      if (event === 'response.output_item.added') {
        const item = chunk.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call') {
          const index = Number(chunk.output_index ?? calls.size)
          calls.set(index, { id: String(item.call_id ?? ''), name: String(item.name ?? ''), arguments: String(item.arguments ?? '') })
        }
      }
      if (event === 'response.function_call_arguments.delta' && typeof chunk.delta === 'string') {
        const index = Number(chunk.output_index ?? 0)
        const current = calls.get(index) ?? { id: String(chunk.call_id ?? ''), name: '', arguments: '' }
        current.arguments += chunk.delta
        calls.set(index, current)
      }
      if (event === 'response.completed' || event === 'response.incomplete') {
        const completed = chunk.response as Record<string, unknown> | undefined
        if (typeof completed?.model === 'string') model = completed.model
        const rawUsage = completed?.usage as Record<string, unknown> | undefined
        if (rawUsage) usage = { input_tokens: Number(rawUsage.input_tokens ?? 0), output_tokens: Number(rawUsage.output_tokens ?? 0) }
        stopReason = event === 'response.completed' ? 'stop' : 'length'
      }
      continue
    }
    if (personalProfile?.protocol === 'anthropic-messages') {
      const event = typeof chunk.type === 'string' ? chunk.type : ''
      if (event === 'message_start') {
        const message = chunk.message as Record<string, unknown> | undefined
        if (typeof message?.model === 'string') model = message.model
        const rawUsage = message?.usage as Record<string, unknown> | undefined
        if (rawUsage) usage.input_tokens = Number(rawUsage.input_tokens ?? 0)
      }
      if (event === 'content_block_start') {
        const index = Number(chunk.index ?? calls.size)
        const block = chunk.content_block as Record<string, unknown> | undefined
        if (block?.type === 'tool_use') calls.set(index, { id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: '' })
      }
      if (event === 'content_block_delta') {
        const delta = chunk.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text
          yield { type: 'model_delta', text: delta.text }
        }
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const index = Number(chunk.index ?? 0)
          const current = calls.get(index) ?? { id: '', name: '', arguments: '' }
          current.arguments += delta.partial_json
          calls.set(index, current)
        }
      }
      if (event === 'message_delta') {
        const delta = chunk.delta as Record<string, unknown> | undefined
        if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason
        const rawUsage = chunk.usage as Record<string, unknown> | undefined
        if (rawUsage) usage.output_tokens = Number(rawUsage.output_tokens ?? 0)
      }
      continue
    }
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
  const assistant: ProductAssistantMessage = {
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
    ...(personalHandle
      ? {
          operation_receipt: {
            source: 'personal' as const,
            capability: 'TextReasoning' as const,
            operation_id: personalHandle.binding.operation_id,
            fingerprint: personalHandle.binding.fingerprint,
          },
        }
      : managedOperationReceipt
        ? { operation_receipt: managedOperationReceipt }
        : {}),
  }
  if (personalHandle) completePersonalModelOperation(personalHandle, JSON.stringify({ assistant }), { awaitingConsumerAck: true })
  yield assistant
  } catch (error) {
    if (personalHandle) {
      try { markPersonalModelOperationOutcomeUnknown(personalHandle) } catch {}
    }
    throw error
  }
}
