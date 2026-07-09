import type { NetworkSettings } from './networkSettings'
import type { ReasoningEffort } from './reasoningEffort'
import type { RuntimeProviderConfig } from './providerConfig'

/**
 * 白标出口单点：把"底层到底用哪家哪个模型/哪个 endpoint"收敛成"能力档代称"，
 * 绝不向前端/模型可见结果暴露真实供应商名、模型名或 baseUrl。
 *
 * 参考 cc 的 getPublicModelDisplayName（内部 ID→公开名，未知不硬展示）集中映射模式，
 * 我们再收紧一层：公开名不带任何厂商/模型线索，只给能力档。
 *
 * 铁律：`seedream/doubao/豆包/gpt-image/claude/anthropic/openai/火山/方舟/volc/ark`
 * 及供应商 endpoint host 永远不出现在用户可见输出里。
 */

/** 生图能力档代称（后端按真实模型路由，出口只给这两个档）。 */
export const PUBLIC_IMAGE_ENGINE = {
  /** 照片级写实、硬中文字准（Seedream 系）→ 默认档 */
  realistic: '写实生图',
  /** 复杂创意、西文主导、内容编辑（GPT Image 系） */
  creative: '创意生图',
} as const

/** 文字能力档代称（按 reasoningEffort/是否深度思考区分，绝不按厂商）。 */
export const PUBLIC_TEXT_CHANNEL = {
  /** 内置主出口 */
  builtin: '默认通道',
  /** 备用出口（冷却/故障切换时用，不带名不带 endpoint） */
  fallback: '备用通道',
  standard: '标准',
  enhanced: '增强(深度思考)',
} as const

/** 生图失败/兜底统一中性文案（去掉 Seedream/OpenAI 等真实名）。 */
export const PUBLIC_IMAGE_FALLBACK_NOTE = '生图引擎繁忙，已自动切换备用引擎重试。'

/**
 * 把一次生图路由映射成用户可见的"能力档"代称。
 * 只看 provider/model/reason 里是否命中写实档（Seedream 系），否则归创意档。
 */
export function publicImageEngineLabel(input: {
  provider?: string | undefined
  model?: string | undefined
  reason?: string | undefined
}): string {
  const provider = (input.provider ?? '').toLowerCase()
  const model = (input.model ?? '').toLowerCase()
  const reason = (input.reason ?? '').toLowerCase()
  // 兜底切换到 seedream 的 reason（openai_failed_seedream_fallback）最终落在写实档；
  // provider 才是最终真相，优先看 provider/model。
  const realistic =
    provider.includes('seedream') ||
    provider.includes('ark') ||
    provider.includes('doubao') ||
    provider.includes('volc') ||
    model.includes('seedream') ||
    model.includes('doubao') ||
    reason.includes('seedream_fallback') ||
    reason.endsWith('_seedream')
  return realistic ? PUBLIC_IMAGE_ENGINE.realistic : PUBLIC_IMAGE_ENGINE.creative
}

/** 文字出口按 reasoningEffort 归能力档（不显厂商/模型名）。 */
export function publicTextChannelLabel(reasoningEffort?: ReasoningEffort): string {
  return reasoningEffort === 'high' ? PUBLIC_TEXT_CHANNEL.enhanced : PUBLIC_TEXT_CHANNEL.standard
}

// --- 文本脱敏器 -------------------------------------------------------------

const NEUTRAL_TOKEN = 'AI 通道'

// 供应商 endpoint host（含子域）——先清整段域名，避免拆词后残留 volces.com 之类片段。
const ENDPOINT_HOST_RE =
  /\b(?:[a-z0-9-]+\.)*(?:anthropic|openai|volces|volcengine|volcengineapi|deepseek|moonshot|bigmodel|dashscope|siliconflow)\.(?:com|cn|net|ai|io|co)\b(?:[:/][^\s"'<>）】]*)?/gi

// 真实供应商/模型名 token（大小写不敏感；长名在前，避免 seedream 先吃掉 doubao-seedream-*）。
const PROVIDER_TOKEN_RE =
  /(?:doubao[\w.-]*seedream[\w.-]*|seedream[\w.-]*|doubao[\w.-]*|gpt[-_]?image[\w.-]*|deepseek[\w.-]*|claude[\w.-]*|anthropic|openai|volcengine|volces|glm[\w.-]*|mimo[\w.-]*|火山方舟|火山引擎|火山|方舟|豆包)/gi

// 独立的 volc / ark（词边界，避免误伤 spark/remark 等英文词）。
const SHORT_TOKEN_RE = /\b(?:volc|ark)\b/gi

/**
 * 清洗任意文本里的真实模型名/供应商/endpoint，替换成中性词。
 * 用于所有"原始报错/系统旁白/失败提示"出口：模型出口失败提示、生图兜底文案、
 * sanitizeProviderError/sanitizeMediaError 等，保证经它们的原始错都不泄底。
 *
 * 注意：只对系统生成的旁白/错误文案用，不对用户内容/工具结果用
 * （用户完全可能在正当地写 openai/claude 集成代码，不能连那些一起改）。
 */
export function scrubProviderIdentifiers(text: string): string {
  if (!text) return text
  return String(text)
    .replace(ENDPOINT_HOST_RE, NEUTRAL_TOKEN)
    .replace(PROVIDER_TOKEN_RE, NEUTRAL_TOKEN)
    .replace(SHORT_TOKEN_RE, NEUTRAL_TOKEN)
}

// --- 面向前端的出口摘要 -----------------------------------------------------

export interface PublicProviderSummary {
  /** 能力档代称（标准/增强），不带厂商/模型名。 */
  channel: string
  hasApiKey: boolean
  hasAuthToken: boolean
  networkProxyMode?: NetworkSettings['proxy']['mode']
}

/**
 * 面向前端的出口摘要：删 baseUrl + model + apiFormat（apiFormat 值本身含
 * `openai`/`anthropic` 会泄底），model 收敛成能力档代称。
 * 原 redactedProviderSummary 只脱了 key、仍带真实 model+baseUrl，仅供后端内部。
 */
export function publicProviderSummary(config: RuntimeProviderConfig): PublicProviderSummary {
  return {
    channel: publicTextChannelLabel(config.reasoningEffort),
    hasApiKey: !!config.apiKey,
    hasAuthToken: !!config.authToken,
    ...(config.networkSettings?.proxy.mode ? { networkProxyMode: config.networkSettings.proxy.mode } : {}),
  }
}

export interface PublicProviderView {
  id: string
  name: string
  enabled: boolean
  channel: string
  hasApiKey?: boolean
  hasAuthToken?: boolean
  createdAt?: string
  updatedAt?: string
}

/**
 * 前端 providers 列表脱敏：去 baseUrl + model + apiFormat，model 换能力档代称，
 * 只留身份（id/name/enabled）+ 是否配了 key。后端内部用途另走未脱敏取数。
 */
export function toPublicProviderView<
  T extends {
    id: string
    name: string
    enabled: boolean
    model?: string
    reasoningEffort?: ReasoningEffort
    hasApiKey?: boolean
    hasAuthToken?: boolean
    createdAt?: string
    updatedAt?: string
  },
>(provider: T): PublicProviderView {
  return {
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled,
    channel: publicTextChannelLabel(provider.reasoningEffort),
    ...(provider.hasApiKey !== undefined ? { hasApiKey: provider.hasApiKey } : {}),
    ...(provider.hasAuthToken !== undefined ? { hasAuthToken: provider.hasAuthToken } : {}),
    ...(provider.createdAt ? { createdAt: provider.createdAt } : {}),
    ...(provider.updatedAt ? { updatedAt: provider.updatedAt } : {}),
  }
}
