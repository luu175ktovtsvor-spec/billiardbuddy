export const PERSONAL_MODEL_CAPABILITIES = [
  'TextReasoning',
  'VisualEvidence',
] as const

export const PERSONAL_MODEL_CONFIGURATION_CAPABILITY_HEADER = 'X-BB-Personal-Model-Configuration-Capability'
export const PERSONAL_MODEL_CONFIGURATION_UPDATE_PATH = '/internal/personal-model-configuration'
export const PERSONAL_MODEL_CONFIGURATION_MAX_BYTES = 128 * 1024

export type PersonalModelCapability = (typeof PERSONAL_MODEL_CAPABILITIES)[number]
export const PERSONAL_MODEL_PROTOCOLS = [
  'openai-compatible',
  'openai-responses',
  'anthropic-messages',
] as const
export type PersonalModelProtocol = (typeof PERSONAL_MODEL_PROTOCOLS)[number]
export const PERSONAL_MODEL_AUTH_MODES = ['bearer', 'x-api-key', 'api-key'] as const
export type PersonalModelAuthMode = (typeof PERSONAL_MODEL_AUTH_MODES)[number]
export const PERSONAL_MODEL_REASONING_MODES = ['provider-default', 'disabled', 'adaptive', 'enabled'] as const
export type PersonalModelReasoningMode = (typeof PERSONAL_MODEL_REASONING_MODES)[number]
export const PERSONAL_MODEL_REASONING_EFFORTS = ['provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type PersonalModelReasoningEffort = (typeof PERSONAL_MODEL_REASONING_EFFORTS)[number]
export const PERSONAL_MODEL_REASONING_SUMMARIES = ['provider-default', 'auto', 'concise', 'detailed'] as const
export type PersonalModelReasoningSummary = (typeof PERSONAL_MODEL_REASONING_SUMMARIES)[number]
export const PERSONAL_MODEL_ANTHROPIC_THINKING_DISPLAYS = ['provider-default', 'summarized', 'omitted'] as const
export type PersonalModelAnthropicThinkingDisplay = (typeof PERSONAL_MODEL_ANTHROPIC_THINKING_DISPLAYS)[number]
export const PERSONAL_MODEL_TEXT_VERBOSITIES = ['provider-default', 'low', 'medium', 'high'] as const
export type PersonalModelTextVerbosity = (typeof PERSONAL_MODEL_TEXT_VERBOSITIES)[number]
export const PERSONAL_MODEL_OPENAI_SERVICE_TIERS = ['provider-default', 'auto', 'default', 'flex', 'priority'] as const
export type PersonalModelOpenAiServiceTier = (typeof PERSONAL_MODEL_OPENAI_SERVICE_TIERS)[number]
export const PERSONAL_MODEL_CHAT_COMPLETION_TOKEN_LIMIT_FIELDS = ['max_tokens', 'max_completion_tokens', 'provider-default'] as const
export type PersonalModelChatCompletionTokenLimitField = (typeof PERSONAL_MODEL_CHAT_COMPLETION_TOKEN_LIMIT_FIELDS)[number]
export const DEFAULT_PERSONAL_MODEL_CONTEXT_WINDOW = 128_000
export const DEFAULT_PERSONAL_MODEL_MAX_OUTPUT_TOKENS = 8_192
export const DEFAULT_PERSONAL_MODEL_REASONING_BUDGET_TOKENS = 4_096
// Model-specific instructions travel with the frozen Worker route. Keep the
// field comfortably below the private IPC frame and configuration-envelope
// ceilings instead of accepting a value that cannot be launched reliably.
export const PERSONAL_MODEL_INSTRUCTIONS_MAX_CHARS = 32_000

export type PersonalModelProfile = {
  id: string
  label: string
  base_url: string
  model: string
  /** Optional provider/model-specific Agent instructions; the product default is used when omitted. */
  model_instructions?: string
  protocol: PersonalModelProtocol
  auth_mode: PersonalModelAuthMode
  /** The endpoint can accept OpenAI-style function/tool definitions and return tool calls. */
  supports_tool_calls: boolean
  /** The selected model can return more than one tool call from the same model turn. */
  supports_parallel_tool_calls: boolean
  /** The OpenAI-family endpoint accepts a stable prompt_cache_key for routing affinity. */
  supports_openai_prompt_cache_key: boolean
  /** Responses can round-trip assistant commentary/final_answer phase values. */
  supports_openai_assistant_phase: boolean
  /** Chat Completions can return the final usage-only streaming chunk. */
  supports_chat_completion_stream_usage: boolean
  /** The selected model exposes a native thinking/reasoning mode or reasoning stream. */
  supports_reasoning: boolean
  /** Native request mode. The default deliberately leaves provider behavior untouched. */
  reasoning_mode: PersonalModelReasoningMode
  /** Native request effort. Unsupported values are rejected by protocol, never guessed from a model ID. */
  reasoning_effort: PersonalModelReasoningEffort
  /** Responses-only public summary. Raw provider reasoning remains private. */
  reasoning_summary: PersonalModelReasoningSummary
  /** Anthropic-only thinking visibility. Signatures and continuation blocks remain private. */
  anthropic_thinking_display: PersonalModelAnthropicThinkingDisplay
  /** OpenAI native answer-detail control; provider-default omits the field. */
  text_verbosity: PersonalModelTextVerbosity
  /** OpenAI request processing tier; provider-default leaves provider routing untouched. */
  openai_service_tier: PersonalModelOpenAiServiceTier
  /** Chat Completions output-limit field; explicit because compatible providers differ. */
  chat_completion_token_limit_field: PersonalModelChatCompletionTokenLimitField
  /** Anthropic manual-thinking budget; used only when reasoning_mode is enabled. */
  reasoning_budget_tokens: number
  /** Provider-documented total context window used for compaction and admission. */
  context_window_tokens: number
  /** Provider-documented maximum output requested for each model turn. */
  max_output_tokens: number
  capabilities: PersonalModelCapability[]
  api_key: string
}

export type PersonalModelProfileInput = Omit<PersonalModelProfile, 'id' | 'auth_mode' | 'supports_tool_calls' | 'supports_parallel_tool_calls' | 'supports_openai_prompt_cache_key' | 'supports_openai_assistant_phase' | 'supports_chat_completion_stream_usage' | 'supports_reasoning' | 'reasoning_mode' | 'reasoning_effort' | 'reasoning_summary' | 'anthropic_thinking_display' | 'text_verbosity' | 'openai_service_tier' | 'chat_completion_token_limit_field' | 'reasoning_budget_tokens' | 'context_window_tokens' | 'max_output_tokens'> & {
  id?: string
  auth_mode?: PersonalModelAuthMode
  supports_tool_calls?: boolean
  supports_parallel_tool_calls?: boolean
  supports_openai_prompt_cache_key?: boolean
  supports_openai_assistant_phase?: boolean
  supports_chat_completion_stream_usage?: boolean
  supports_reasoning?: boolean
  reasoning_mode?: PersonalModelReasoningMode
  reasoning_effort?: PersonalModelReasoningEffort
  reasoning_summary?: PersonalModelReasoningSummary
  anthropic_thinking_display?: PersonalModelAnthropicThinkingDisplay
  text_verbosity?: PersonalModelTextVerbosity
  openai_service_tier?: PersonalModelOpenAiServiceTier
  chat_completion_token_limit_field?: PersonalModelChatCompletionTokenLimitField
  reasoning_budget_tokens?: number
  context_window_tokens?: number
  max_output_tokens?: number
}

export type PersonalModelKind = 'text' | 'multimodal'

export type PersonalModelConfiguration = {
  version: 1
  profiles: PersonalModelProfile[]
  routes: Partial<Record<PersonalModelCapability, string>>
}

export type PersonalModelProfileSummary = Omit<PersonalModelProfile, 'api_key'> & { configured: true }
export type PersonalModelConfigurationSummary = {
  managed_model: string
  profiles: PersonalModelProfileSummary[]
  routes: Partial<Record<PersonalModelCapability, string>>
}

function canonicalPersonalModelCapabilities(
  value: readonly PersonalModelCapability[],
): PersonalModelCapability[] | null {
  const capabilities = new Set(value)
  if (capabilities.size === 0) return null
  return PERSONAL_MODEL_CAPABILITIES.filter(capability => capabilities.has(capability))
}

export function validPersonalModelProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value)
}

export function validPersonalModelCapability(value: unknown): value is PersonalModelCapability {
  return typeof value === 'string' && (PERSONAL_MODEL_CAPABILITIES as readonly string[]).includes(value)
}

export function validPersonalModelProtocol(value: unknown): value is PersonalModelProtocol {
  return typeof value === 'string' && (PERSONAL_MODEL_PROTOCOLS as readonly string[]).includes(value)
}

export function validPersonalModelAuthMode(value: unknown): value is PersonalModelAuthMode {
  return typeof value === 'string' && (PERSONAL_MODEL_AUTH_MODES as readonly string[]).includes(value)
}

export function validPersonalModelReasoningMode(value: unknown): value is PersonalModelReasoningMode {
  return typeof value === 'string' && (PERSONAL_MODEL_REASONING_MODES as readonly string[]).includes(value)
}

export function validPersonalModelReasoningEffort(value: unknown): value is PersonalModelReasoningEffort {
  return typeof value === 'string' && (PERSONAL_MODEL_REASONING_EFFORTS as readonly string[]).includes(value)
}

export function validPersonalModelReasoningSummary(value: unknown): value is PersonalModelReasoningSummary {
  return typeof value === 'string' && (PERSONAL_MODEL_REASONING_SUMMARIES as readonly string[]).includes(value)
}

export function validPersonalModelAnthropicThinkingDisplay(value: unknown): value is PersonalModelAnthropicThinkingDisplay {
  return typeof value === 'string' && (PERSONAL_MODEL_ANTHROPIC_THINKING_DISPLAYS as readonly string[]).includes(value)
}

export function validPersonalModelTextVerbosity(value: unknown): value is PersonalModelTextVerbosity {
  return typeof value === 'string' && (PERSONAL_MODEL_TEXT_VERBOSITIES as readonly string[]).includes(value)
}

export function validPersonalModelOpenAiServiceTier(value: unknown): value is PersonalModelOpenAiServiceTier {
  return typeof value === 'string' && (PERSONAL_MODEL_OPENAI_SERVICE_TIERS as readonly string[]).includes(value)
}

export function validPersonalModelChatCompletionTokenLimitField(value: unknown): value is PersonalModelChatCompletionTokenLimitField {
  return typeof value === 'string' && (PERSONAL_MODEL_CHAT_COMPLETION_TOKEN_LIMIT_FIELDS as readonly string[]).includes(value)
}

export function defaultPersonalModelAuthMode(protocol: PersonalModelProtocol): PersonalModelAuthMode {
  return protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer'
}

export function safePersonalModelBaseUrl(value: string, protocol: PersonalModelProtocol): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('PERSONAL_MODEL_BASE_URL_INVALID') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('PERSONAL_MODEL_BASE_URL_INVALID')
  }
  for (const name of url.searchParams.keys()) {
    if (/(?:api[-_]?key|token|secret|signature|credential|authorization|^sig$)/i.test(name)) {
      throw new Error('PERSONAL_MODEL_BASE_URL_CONTAINS_SECRET')
    }
  }
  let pathname = url.pathname.replace(/\/+$/, '')
  const endpointSuffix = protocol === 'openai-compatible'
    ? '/chat/completions'
    : protocol === 'openai-responses'
      ? '/responses'
      : '/messages'
  if (pathname.endsWith(endpointSuffix)) pathname = pathname.slice(0, -endpointSuffix.length)
  url.pathname = pathname || '/v1'
  return url.toString().replace(/\/$/, '')
}

export function normalizePersonalModelProfile(input: PersonalModelProfileInput, id: string): PersonalModelProfile {
  if (!validPersonalModelProfileId(id)) throw new Error('PERSONAL_MODEL_PROFILE_ID_INVALID')
  const label = input.label.trim()
  const model = input.model.trim()
  const modelInstructions = input.model_instructions?.normalize('NFC').trim() ?? ''
  const apiKey = input.api_key.trim()
  const capabilities = input.capabilities.every(validPersonalModelCapability)
    ? canonicalPersonalModelCapabilities(input.capabilities)
    : null
  if (
    !label
    || label.length > 80
    || !model
    || model.length > 200
    || modelInstructions.length > PERSONAL_MODEL_INSTRUCTIONS_MAX_CHARS
    || /\0/.test(modelInstructions)
    || apiKey.length < 8
    || apiKey.length > 4_096
  ) {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  // Profiles describe what an endpoint can really do. Routes remain separate:
  // a user may choose one tool-capable Agent model and another multimodal model
  // for Agent attachment evidence without forcing either endpoint into the other's job.
  if (/[\r\n\0]/.test(model) || /[\r\n\0]/.test(apiKey) || !capabilities) {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  if (!validPersonalModelProtocol(input.protocol)) throw new Error('PERSONAL_MODEL_PROTOCOL_UNSUPPORTED')
  const authMode = input.auth_mode ?? defaultPersonalModelAuthMode(input.protocol)
  if (!validPersonalModelAuthMode(authMode)) throw new Error('PERSONAL_MODEL_AUTH_MODE_UNSUPPORTED')
  if (input.supports_tool_calls !== undefined && typeof input.supports_tool_calls !== 'boolean') {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  if (input.supports_parallel_tool_calls !== undefined && typeof input.supports_parallel_tool_calls !== 'boolean') {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  if (input.supports_openai_prompt_cache_key !== undefined && typeof input.supports_openai_prompt_cache_key !== 'boolean') {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  if (input.supports_openai_assistant_phase !== undefined && typeof input.supports_openai_assistant_phase !== 'boolean') {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  if (input.supports_chat_completion_stream_usage !== undefined && typeof input.supports_chat_completion_stream_usage !== 'boolean') {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  if (input.supports_reasoning !== undefined && typeof input.supports_reasoning !== 'boolean') {
    throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  }
  const reasoningMode = input.reasoning_mode ?? 'provider-default'
  const reasoningEffort = input.reasoning_effort ?? 'provider-default'
  const reasoningSummary = input.reasoning_summary ?? 'provider-default'
  const anthropicThinkingDisplay = input.anthropic_thinking_display ?? 'provider-default'
  const supportsReasoning = input.supports_reasoning ?? false
  const textVerbosity = input.text_verbosity ?? 'provider-default'
  const openAiServiceTier = input.openai_service_tier ?? 'provider-default'
  const chatCompletionTokenLimitField = input.chat_completion_token_limit_field
    ?? (input.protocol === 'openai-compatible' ? 'max_tokens' : 'provider-default')
  const reasoningBudgetTokens = input.reasoning_budget_tokens ?? DEFAULT_PERSONAL_MODEL_REASONING_BUDGET_TOKENS
  if (!validPersonalModelReasoningMode(reasoningMode) || !validPersonalModelReasoningEffort(reasoningEffort) || !validPersonalModelReasoningSummary(reasoningSummary) || !validPersonalModelAnthropicThinkingDisplay(anthropicThinkingDisplay)) {
    throw new Error('PERSONAL_MODEL_REASONING_CONFIGURATION_INVALID')
  }
  if (!validPersonalModelTextVerbosity(textVerbosity)) throw new Error('PERSONAL_MODEL_TEXT_VERBOSITY_INVALID')
  if (!validPersonalModelOpenAiServiceTier(openAiServiceTier)) throw new Error('PERSONAL_MODEL_OPENAI_SERVICE_TIER_INVALID')
  if (!validPersonalModelChatCompletionTokenLimitField(chatCompletionTokenLimitField)) {
    throw new Error('PERSONAL_MODEL_CHAT_COMPLETION_TOKEN_LIMIT_FIELD_INVALID')
  }
  const contextWindowTokens = input.context_window_tokens ?? DEFAULT_PERSONAL_MODEL_CONTEXT_WINDOW
  const maxOutputTokens = input.max_output_tokens ?? DEFAULT_PERSONAL_MODEL_MAX_OUTPUT_TOKENS
  if (
    !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens < 8_192
    || contextWindowTokens > 2_000_000
    || !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < 1_024
    || maxOutputTokens > 262_144
    || maxOutputTokens >= contextWindowTokens
  ) throw new Error('PERSONAL_MODEL_TOKEN_BUDGET_INVALID')
  if (
    !Number.isSafeInteger(reasoningBudgetTokens)
    || reasoningBudgetTokens < 1_024
    || reasoningBudgetTokens > 262_144
    || (reasoningMode === 'enabled' && reasoningBudgetTokens >= maxOutputTokens)
  ) {
    throw new Error('PERSONAL_MODEL_REASONING_CONFIGURATION_INVALID')
  }
  if (input.protocol === 'openai-compatible' && (reasoningMode !== 'provider-default' || reasoningSummary !== 'provider-default' || anthropicThinkingDisplay !== 'provider-default')) {
    throw new Error('PERSONAL_MODEL_REASONING_CONFIGURATION_UNSUPPORTED')
  }
  if (input.protocol === 'openai-responses' && (reasoningMode !== 'provider-default' || anthropicThinkingDisplay !== 'provider-default')) {
    throw new Error('PERSONAL_MODEL_REASONING_CONFIGURATION_UNSUPPORTED')
  }
  if (input.protocol === 'anthropic-messages' && (['none', 'minimal'].includes(reasoningEffort) || reasoningSummary !== 'provider-default')) {
    throw new Error('PERSONAL_MODEL_REASONING_CONFIGURATION_UNSUPPORTED')
  }
  if (input.protocol === 'anthropic-messages' && anthropicThinkingDisplay !== 'provider-default' && !['adaptive', 'enabled'].includes(reasoningMode)) {
    throw new Error('PERSONAL_MODEL_REASONING_CONFIGURATION_INVALID')
  }
  if (!supportsReasoning && (reasoningMode !== 'provider-default' || reasoningEffort !== 'provider-default' || reasoningSummary !== 'provider-default' || anthropicThinkingDisplay !== 'provider-default')) {
    throw new Error('PERSONAL_MODEL_REASONING_CONFIGURATION_INVALID')
  }
  if (input.protocol === 'anthropic-messages' && textVerbosity !== 'provider-default') {
    throw new Error('PERSONAL_MODEL_TEXT_VERBOSITY_UNSUPPORTED')
  }
  if (input.protocol === 'anthropic-messages' && openAiServiceTier !== 'provider-default') {
    throw new Error('PERSONAL_MODEL_OPENAI_SERVICE_TIER_UNSUPPORTED')
  }
  if (input.protocol === 'anthropic-messages' && input.supports_openai_prompt_cache_key === true) {
    throw new Error('PERSONAL_MODEL_OPENAI_PROMPT_CACHE_KEY_UNSUPPORTED')
  }
  if (input.protocol !== 'openai-responses' && input.supports_openai_assistant_phase === true) {
    throw new Error('PERSONAL_MODEL_OPENAI_ASSISTANT_PHASE_UNSUPPORTED')
  }
  if (input.protocol !== 'openai-compatible' && input.supports_chat_completion_stream_usage === true) {
    throw new Error('PERSONAL_MODEL_CHAT_COMPLETION_STREAM_USAGE_UNSUPPORTED')
  }
  if (input.protocol !== 'openai-compatible' && chatCompletionTokenLimitField !== 'provider-default') {
    throw new Error('PERSONAL_MODEL_CHAT_COMPLETION_TOKEN_LIMIT_FIELD_UNSUPPORTED')
  }
  return {
    id,
    label,
    base_url: safePersonalModelBaseUrl(input.base_url, input.protocol),
    model,
    ...(modelInstructions ? { model_instructions: modelInstructions } : {}),
    protocol: input.protocol,
    auth_mode: authMode,
    // Profiles saved before model feature declarations were introduced already
    // powered the full Agent loop, so preserve that established tool behavior.
    supports_tool_calls: input.supports_tool_calls ?? true,
    supports_parallel_tool_calls: (input.supports_tool_calls ?? true) && (input.supports_parallel_tool_calls ?? true),
    // Existing Responses profiles already received this field before the
    // endpoint capability became configurable, so preserve their behavior.
    supports_openai_prompt_cache_key: input.supports_openai_prompt_cache_key ?? input.protocol === 'openai-responses',
    // This changes replay serialization, so existing profiles stay byte-for-byte
    // compatible until the user explicitly enables the documented capability.
    supports_openai_assistant_phase: input.supports_openai_assistant_phase ?? false,
    supports_chat_completion_stream_usage: input.supports_chat_completion_stream_usage ?? false,
    supports_reasoning: supportsReasoning,
    reasoning_mode: reasoningMode,
    reasoning_effort: reasoningEffort,
    reasoning_summary: reasoningSummary,
    anthropic_thinking_display: anthropicThinkingDisplay,
    text_verbosity: textVerbosity,
    openai_service_tier: openAiServiceTier,
    chat_completion_token_limit_field: chatCompletionTokenLimitField,
    reasoning_budget_tokens: reasoningBudgetTokens,
    context_window_tokens: contextWindowTokens,
    max_output_tokens: maxOutputTokens,
    capabilities,
    api_key: apiKey,
  }
}

export function parsePersonalModelConfiguration(raw: string | undefined | null): PersonalModelConfiguration {
  if (!raw) return { version: 1, profiles: [], routes: {} }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
  const record = value as { version?: unknown; profiles?: unknown; routes?: unknown }
  if (record.version !== 1 || !Array.isArray(record.profiles) || !record.routes || typeof record.routes !== 'object' || Array.isArray(record.routes)) {
    throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
  }
  const profiles = record.profiles.map(rawProfile => {
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
    const profile = rawProfile as PersonalModelProfile & { capabilities?: unknown }
    if (!Array.isArray(profile.capabilities) || !profile.capabilities.every(validPersonalModelCapability)) {
      throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
    }
    const capabilities = profile.capabilities
    return normalizePersonalModelProfile({ ...profile, capabilities }, profile.id)
  })
  if (profiles.length > 20 || new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
  const ids = new Set(profiles.map(profile => profile.id))
  const routes: PersonalModelConfiguration['routes'] = {}
  for (const [capability, profileId] of Object.entries(record.routes)) {
    if (!validPersonalModelCapability(capability) || !validPersonalModelProfileId(profileId) || !ids.has(profileId)) {
      throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
    }
    const profile = profiles.find(candidate => candidate.id === profileId)!
    if (
      !profile.capabilities.includes(capability)
      || (capability === 'TextReasoning' && !profile.supports_tool_calls)
    ) throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
    routes[capability] = profileId
  }
  return { version: 1, profiles, routes }
}

export function activePersonalModelProfile(
  capability: PersonalModelCapability,
  env: Record<string, string | undefined> = process.env,
): PersonalModelProfile | null {
  const config = parsePersonalModelConfiguration(env.BB_PERSONAL_MODEL_CONFIGURATION)
  const id = config.routes[capability]
  return id ? config.profiles.find(profile => profile.id === id) ?? null : null
}

export function personalModelKind(profile: Pick<PersonalModelProfile, 'capabilities'>): PersonalModelKind {
  return profile.capabilities.includes('VisualEvidence') ? 'multimodal' : 'text'
}
