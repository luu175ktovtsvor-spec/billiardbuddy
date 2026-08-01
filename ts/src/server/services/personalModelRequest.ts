import {
  activePersonalModelProfile,
  type PersonalModelCapability,
  type PersonalModelProfile,
} from '../../../shared/product/personalModels.js'
import { runtimePersonalModelProfile } from './personalModelRuntimeState.js'

export type PersonalModelRequestTarget = {
  profile: PersonalModelProfile
  url: string
  headers: Record<string, string>
}

function personalModelEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`
  return url.toString()
}

function personalModelAuthHeader(profile: Pick<PersonalModelProfile, 'api_key' | 'auth_mode'>): Record<string, string> {
  if (profile.auth_mode === 'x-api-key') return { 'x-api-key': profile.api_key }
  if (profile.auth_mode === 'api-key') return { 'api-key': profile.api_key }
  return { Authorization: `Bearer ${profile.api_key}` }
}

type ProviderMessage = {
  role?: unknown
  content?: unknown
  tool_call_id?: unknown
  tool_calls?: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function providerMessages(value: unknown): ProviderMessage[] {
  return Array.isArray(value)
    ? value.filter(item => record(item) !== null) as ProviderMessage[]
    : []
}

function dataUrlImage(value: string): { media_type: string; data: string } | null {
  const match = value.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/)
  return match ? { media_type: match[1]!, data: match[2]! } : null
}

function contentParts(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  return Array.isArray(value)
    ? value.filter(part => record(part) !== null) as Array<Record<string, unknown>>
    : []
}

function responsesContent(value: unknown, output: boolean): Array<Record<string, unknown>> {
  return contentParts(value).flatMap<Record<string, unknown>>(part => {
    if (part.type === 'text') {
      const text = String(part.text ?? '')
      return text ? [{ type: output ? 'output_text' : 'input_text', text }] : []
    }
    const image = record(part.image_url)?.url
    return !output && typeof image === 'string' && image
      ? [{ type: 'input_image', detail: 'auto', image_url: image }]
      : []
  })
}

function responsesTextFormat(value: unknown): Record<string, unknown> | null {
  const responseFormat = record(value)
  if (responseFormat?.type === 'json_object') return { type: 'json_object' }
  if (responseFormat?.type !== 'json_schema') return null
  const jsonSchema = record(responseFormat.json_schema)
  const schema = record(jsonSchema?.schema)
  const name = typeof jsonSchema?.name === 'string' ? jsonSchema.name : ''
  if (!schema || !name) return null
  return {
    type: 'json_schema',
    name,
    schema,
    ...(typeof jsonSchema?.strict === 'boolean' ? { strict: jsonSchema.strict } : {}),
  }
}

function anthropicOutputFormat(value: unknown): Record<string, unknown> | null {
  const responseFormat = record(value)
  if (responseFormat?.type !== 'json_schema') return null
  const jsonSchema = record(responseFormat.json_schema)
  const schema = record(jsonSchema?.schema)
  return schema ? { type: 'json_schema', schema } : null
}

function anthropicContent(value: unknown): Array<Record<string, unknown>> {
  return contentParts(value).flatMap<Record<string, unknown>>(part => {
    if (part.type === 'text') {
      const text = String(part.text ?? '')
      return text ? [{ type: 'text', text }] : []
    }
    const image = record(part.image_url)?.url
    if (typeof image !== 'string' || !image) return []
    const inline = dataUrlImage(image)
    return inline
      ? [{ type: 'image', source: { type: 'base64', ...inline } }]
      : [{ type: 'image', source: { type: 'url', url: image } }]
  })
}

function openAiResponsesBody(
  profile: Pick<PersonalModelProfile, 'model' | 'reasoning_effort' | 'text_verbosity' | 'openai_service_tier'>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = providerMessages(body.messages)
  const instructions = messages
    .filter(message => message.role === 'system')
    .flatMap(message => contentParts(message.content))
    .filter(part => part.type === 'text')
    .map(part => String(part.text ?? ''))
    .filter(Boolean)
    .join('\n\n')
  const input = messages.flatMap(message => {
    if (message.role === 'system') return []
    if (message.role === 'tool') {
      const callId = String(message.tool_call_id ?? '')
      return callId ? [{ type: 'function_call_output', call_id: callId, output: responsesContent(message.content, false) }] : []
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const items: Array<Record<string, unknown>> = []
    const content = responsesContent(message.content, role === 'assistant')
    if (content.length) items.push({ type: 'message', role, content })
    for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const call = record(raw)
      const fn = record(call?.function)
      if (!call || !fn) continue
      items.push({
        type: 'function_call',
        call_id: String(call.id ?? ''),
        name: String(fn.name ?? ''),
        arguments: String(fn.arguments ?? '{}'),
      })
    }
    return items
  })
  const tools = Array.isArray(body.tools) ? body.tools.flatMap(raw => {
    const tool = record(raw)
    const fn = record(tool?.function)
    return fn ? [{
      type: 'function',
      name: String(fn.name ?? ''),
      description: String(fn.description ?? ''),
      parameters: record(fn.parameters) ?? { type: 'object', properties: {} },
      strict: false,
    }] : []
  }) : []
  const textFormat = responsesTextFormat(body.response_format)
  const text = {
    ...(textFormat ? { format: textFormat } : {}),
    ...(profile.text_verbosity !== 'provider-default' ? { verbosity: profile.text_verbosity } : {}),
  }
  return {
    model: profile.model,
    stream: body.stream === true,
    // BilliardBuddy owns durable history. A user's direct Responses request
    // must not silently create a second provider-side conversation store.
    store: false,
    ...(profile.openai_service_tier !== 'provider-default' ? { service_tier: profile.openai_service_tier } : {}),
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools.length ? { tools } : {}),
    ...(typeof body.max_tokens === 'number' ? { max_output_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(Object.keys(text).length ? { text } : {}),
    ...(profile.reasoning_effort !== 'provider-default' ? { reasoning: { effort: profile.reasoning_effort } } : {}),
  }
}

/**
 * Build the provider-neutral Responses request used by a managed route.  It
 * shares the same durable-history conversion as a personal Responses profile,
 * while deliberately omitting every user-owned preference and credential.
 */
export function managedOpenAiResponsesBody(
  model: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return openAiResponsesBody({
    model,
    reasoning_effort: 'provider-default',
    text_verbosity: 'provider-default',
    openai_service_tier: 'provider-default',
  }, body)
}

function anthropicMessagesBody(
  profile: Pick<PersonalModelProfile, 'model' | 'reasoning_mode' | 'reasoning_effort' | 'anthropic_thinking_display' | 'reasoning_budget_tokens'>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const source = providerMessages(body.messages)
  const system = source
    .filter(message => message.role === 'system')
    .flatMap(message => contentParts(message.content))
    .filter(part => part.type === 'text')
    .map(part => String(part.text ?? ''))
    .filter(Boolean)
    .join('\n\n')
  const messages = source.flatMap(message => {
    if (message.role === 'system') return []
    if (message.role === 'tool') {
      const toolCallId = String(message.tool_call_id ?? '')
      return toolCallId ? [{ role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: anthropicContent(message.content),
      }] }] : []
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = anthropicContent(message.content)
    if (role === 'assistant') {
      for (const raw of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const call = record(raw)
        const fn = record(call?.function)
        if (!call || !fn) continue
        let input: Record<string, unknown> = {}
        try { input = record(JSON.parse(String(fn.arguments ?? '{}'))) ?? {} } catch {}
        content.push({ type: 'tool_use', id: String(call.id ?? ''), name: String(fn.name ?? ''), input })
      }
    }
    return content.length ? [{ role, content }] : []
  })
  const tools = Array.isArray(body.tools) ? body.tools.flatMap(raw => {
    const tool = record(raw)
    const fn = record(tool?.function)
    return fn ? [{
      name: String(fn.name ?? ''),
      description: String(fn.description ?? ''),
      input_schema: record(fn.parameters) ?? { type: 'object', properties: {} },
    }] : []
  }) : []
  const outputFormat = anthropicOutputFormat(body.response_format)
  const outputConfig = {
    ...(profile.reasoning_effort !== 'provider-default' ? { effort: profile.reasoning_effort } : {}),
    ...(outputFormat ? { format: outputFormat } : {}),
  }
  return {
    model: profile.model,
    stream: body.stream === true,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 4_096,
    messages,
    ...(system ? { system } : {}),
    ...(tools.length ? { tools } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(profile.reasoning_mode === 'provider-default' ? {} : {
      thinking: profile.reasoning_mode === 'enabled'
        ? {
            type: 'enabled',
            budget_tokens: profile.reasoning_budget_tokens,
            ...(profile.anthropic_thinking_display !== 'provider-default' ? { display: profile.anthropic_thinking_display } : {}),
          }
        : {
            type: profile.reasoning_mode,
            ...(profile.anthropic_thinking_display !== 'provider-default' ? { display: profile.anthropic_thinking_display } : {}),
          },
    }),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  }
}

/**
 * Resolve the user-owned model endpoint inside the trusted local
 * runtime. The API key is never added to renderer state, prompts, logs, remote
 * Gateway headers, or model-triggered subprocess environments.
 */
export function personalModelRequestTarget(
  capability: PersonalModelCapability,
  env?: Record<string, string | undefined>,
): PersonalModelRequestTarget | null {
  const profile = !env || env === process.env
    ? runtimePersonalModelProfile(capability)
    : activePersonalModelProfile(capability, env)
  if (!profile) return null
  return personalModelRequestTargetForProfile(profile)
}

/** Build one immutable request target from the profile selected for this operation. */
export function personalModelRequestTargetForProfile(profile: PersonalModelProfile): PersonalModelRequestTarget {
  const endpoint = profile.protocol === 'openai-compatible'
    ? 'chat/completions'
    : profile.protocol === 'openai-responses'
      ? 'responses'
      : 'messages'
  return {
    profile,
    url: personalModelEndpoint(profile.base_url, endpoint),
    headers: profile.protocol === 'anthropic-messages' ? {
      ...personalModelAuthHeader(profile),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    } : {
      ...personalModelAuthHeader(profile),
      'Content-Type': 'application/json',
    },
  }
}

export function personalModelBody(
  profile: Pick<PersonalModelProfile, 'model' | 'protocol' | 'reasoning_mode' | 'reasoning_effort' | 'anthropic_thinking_display' | 'text_verbosity' | 'openai_service_tier' | 'chat_completion_token_limit_field' | 'reasoning_budget_tokens'>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (profile.protocol === 'openai-responses') return openAiResponsesBody(profile, body)
  if (profile.protocol === 'anthropic-messages') return anthropicMessagesBody(profile, body)
  const normalized: Record<string, unknown> = { ...body, model: profile.model }
  const requestedMaxOutputTokens = typeof body.max_tokens === 'number'
    ? body.max_tokens
    : typeof body.max_completion_tokens === 'number'
      ? body.max_completion_tokens
      : undefined
  delete normalized.max_tokens
  delete normalized.max_completion_tokens
  delete normalized.reasoning_effort
  delete normalized.verbosity
  delete normalized.service_tier
  if (requestedMaxOutputTokens !== undefined && profile.chat_completion_token_limit_field !== 'provider-default') {
    normalized[profile.chat_completion_token_limit_field] = requestedMaxOutputTokens
  }
  if (profile.reasoning_effort !== 'provider-default') normalized.reasoning_effort = profile.reasoning_effort
  if (profile.text_verbosity !== 'provider-default') normalized.verbosity = profile.text_verbosity
  if (profile.openai_service_tier !== 'provider-default') normalized.service_tier = profile.openai_service_tier
  // `thinking` is a provider-specific extension, not part of the unified
  // OpenAI-compatible contract. A provider may expose its own reasoning model
  // through the configured model ID without receiving another vendor's field.
  delete normalized.thinking
  return normalized
}

export function personalModelResponseText(
  profile: Pick<PersonalModelProfile, 'protocol'>,
  envelope: unknown,
): string | null {
  const root = record(envelope)
  if (!root) return null
  if (profile.protocol === 'openai-compatible') {
    const choice = Array.isArray(root.choices) ? record(root.choices[0]) : null
    // A syntactically valid partial JSON body is not a completed media result.
    // Chat Completions can return visible partial content with `length` or a
    // filtering terminal, so only the natural non-tool terminal is consumable.
    if (choice?.finish_reason !== 'stop') throw new Error('PERSONAL_MODEL_RESPONSE_INCOMPLETE')
    const message = record(choice?.message)
    const text = contentParts(message?.content)
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => String(part.text))
      .join('')
    return text.trim() ? text : null
  }
  if (profile.protocol === 'openai-responses') {
    // Responses exposes partial output alongside status=incomplete. Accepting
    // that text would let a token-limited JSON object masquerade as a result.
    if (root.status !== 'completed') throw new Error('PERSONAL_MODEL_RESPONSE_INCOMPLETE')
    if (typeof root.output_text === 'string' && root.output_text.trim()) return root.output_text
    const text = (Array.isArray(root.output) ? root.output : []).flatMap(item => {
      const output = record(item)
      return Array.isArray(output?.content)
        ? output.content.flatMap(part => {
            const content = record(part)
            return content?.type === 'output_text' && typeof content.text === 'string' ? [content.text] : []
          })
        : []
    }).join('')
    return text.trim() ? text : null
  }
  // Messages always supplies a non-null stop_reason in non-streaming mode.
  // This call shape declares no tools or custom stop sequence, so only a
  // natural end_turn proves the structured response is complete.
  if (root.stop_reason !== 'end_turn') throw new Error('PERSONAL_MODEL_RESPONSE_INCOMPLETE')
  const text = (Array.isArray(root.content) ? root.content : []).flatMap(part => {
    const content = record(part)
    return content?.type === 'text' && typeof content.text === 'string' ? [content.text] : []
  }).join('')
  return text.trim() ? text : null
}

export function personalModelHttpError(status: number): string {
  if (status === 401 || status === 403) return 'PERSONAL_MODEL_AUTH_FAILED'
  if (status === 404) return 'PERSONAL_MODEL_ENDPOINT_OR_MODEL_NOT_FOUND'
  if (status === 429) return 'PERSONAL_MODEL_BUSY'
  if ([400, 405, 415, 422].includes(status)) return 'PERSONAL_MODEL_PROTOCOL_OR_CAPABILITY_UNSUPPORTED'
  if (status === 402) return 'PERSONAL_MODEL_BILLING_OR_QUOTA'
  if (status === 413) return 'PERSONAL_MODEL_CONTEXT_LIMIT'
  if (status >= 500) return 'PERSONAL_MODEL_UPSTREAM_UNAVAILABLE'
  return `PERSONAL_MODEL_HTTP_${status}`
}
