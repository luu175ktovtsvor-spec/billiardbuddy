import type { OpenAIChatImageContentMode } from '../proxy/toOpenAiChatRequest'
import { networkSettingsFromEnv, type NetworkSettings } from './networkSettings'
import { normalizeReasoningEffort, type ReasoningEffort } from './reasoningEffort'

export type ProviderApiFormat = 'anthropic' | 'openai_chat'
export type ProviderAuthStrategy =
  | 'api_key'
  | 'auth_token'
  | 'auth_token_empty_api_key'
  | 'dual_same_token'
  | 'dual_dummy'

export interface RuntimeProviderConfig {
  apiFormat: ProviderApiFormat
  baseUrl: string
  apiKey?: string
  authToken?: string
  authStrategy?: ProviderAuthStrategy
  model: string
  maxTokens?: number
  requestTimeoutMs?: number
  idleTimeoutMs?: number
  reasoningEffort?: ReasoningEffort
  imageContentMode?: OpenAIChatImageContentMode
  networkSettings?: NetworkSettings
}

export interface RuntimeProviderSummary {
  apiFormat: ProviderApiFormat
  baseUrl: string
  model: string
  hasApiKey: boolean
  hasAuthToken: boolean
  reasoningEffort?: ReasoningEffort
  networkProxyMode?: NetworkSettings['proxy']['mode']
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function first(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const c = clean(value)
    if (c) return c
  }
  return undefined
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const raw = clean(value)
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parseTimeoutMs(env: Record<string, string | undefined>): number | undefined {
  const ms = parsePositiveInt(first(env.AI_REQUEST_TIMEOUT_MS, env.API_TIMEOUT_MS))
  if (ms !== undefined) return ms
  const seconds = parsePositiveInt(env.TEXT_PROVIDER_TIMEOUT_SECONDS)
  return seconds !== undefined ? seconds * 1000 : undefined
}

function normalizeApiFormat(value: string | undefined): ProviderApiFormat | undefined {
  const v = clean(value)?.toLowerCase()
  if (v === 'anthropic') return 'anthropic'
  if (v === 'openai_chat' || v === 'openai' || v === 'chat_completions') return 'openai_chat'
  return undefined
}

function normalizeAuthStrategy(value: string | undefined): ProviderAuthStrategy | undefined {
  const v = clean(value)
  if (
    v === 'api_key' ||
    v === 'auth_token' ||
    v === 'auth_token_empty_api_key' ||
    v === 'dual_same_token' ||
    v === 'dual_dummy'
  ) return v
  return undefined
}

function withoutTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * 从运行时 env 生成模型出口配置。优先识别 cc-haha 风格 ANTHROPIC_*；
 * 没有时兼容当前桌面版 bundled.env 的 DEEPSEEK/OPENAI 网关变量。
 */
export function providerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeProviderConfig | null {
  const requestedFormat = normalizeApiFormat(first(env.AGENT_API_FORMAT, env.ANTHROPIC_API_FORMAT, env.TEXT_MODEL_API_FORMAT))
  const common = {
    maxTokens: parsePositiveInt(first(env.ANTHROPIC_MAX_TOKENS, env.MAX_TOKENS)),
    requestTimeoutMs: parseTimeoutMs(env),
    idleTimeoutMs: parsePositiveInt(first(env.STREAM_IDLE_TIMEOUT_MS, env.CLAUDE_STREAM_IDLE_TIMEOUT_MS)),
    reasoningEffort: normalizeReasoningEffort(first(env.REASONING_EFFORT, env.CLAUDE_CODE_REASONING_EFFORT)),
    networkSettings: networkSettingsFromEnv(env),
  }

  const anthropicBase = first(env.ANTHROPIC_BASE_URL)
  const anthropicModel = first(env.ANTHROPIC_MODEL, env.TEXT_MODEL_NAME)
  const anthropicKey = first(env.ANTHROPIC_API_KEY)
  const anthropicToken = first(env.ANTHROPIC_AUTH_TOKEN)
  if (anthropicBase && anthropicModel && (anthropicKey || anthropicToken) && requestedFormat !== 'openai_chat') {
    return {
      apiFormat: 'anthropic',
      baseUrl: withoutTrailingSlash(anthropicBase),
      apiKey: anthropicKey,
      authToken: anthropicToken,
      authStrategy: normalizeAuthStrategy(env.ANTHROPIC_AUTH_STRATEGY),
      model: anthropicModel,
      ...common,
    }
  }

  const openAiBase = first(env.DEEPSEEK_BASE_URL, env.OPENAI_BASE_URL, env.TEXT_MODEL_BASE_URL)
  const openAiKey = first(env.DEEPSEEK_API_KEY, env.OPENAI_API_KEY, env.TEXT_MODEL_API_KEY)
  const openAiModel = first(env.TEXT_MODEL_NAME, env.OPENAI_MODEL, env.DEEPSEEK_MODEL, env.ANTHROPIC_MODEL)
  if (openAiBase && openAiKey && openAiModel) {
    return {
      apiFormat: 'openai_chat',
      baseUrl: withoutTrailingSlash(openAiBase),
      apiKey: openAiKey,
      model: openAiModel,
      imageContentMode: env.OPENAI_CHAT_IMAGE_MODE === 'text_only' ? 'text_only' : 'vision',
      ...common,
    }
  }

  return null
}

export function redactedProviderSummary(config: RuntimeProviderConfig): RuntimeProviderSummary {
  return {
    apiFormat: config.apiFormat,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: !!config.apiKey,
    hasAuthToken: !!config.authToken,
    reasoningEffort: config.reasoningEffort,
    networkProxyMode: config.networkSettings?.proxy.mode,
  }
}
