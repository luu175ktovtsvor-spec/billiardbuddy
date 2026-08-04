export const PROVIDER_CAPABILITIES = [
  'TextReasoning',
  'VisualEvidence',
  'MediaReasoning',
  'ImageGeneration',
  'SpeechTranscription',
  'SemanticEmbedding',
] as const

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number]

/**
 * The managed text wire shape is selected by the trusted provider registry,
 * never by a Renderer request or an Agent prompt.  It deliberately names the
 * product boundary rather than any one SDK.
 */
export const TEXT_REASONING_TRANSPORTS = ['chat_completions', 'responses'] as const
export type TextReasoningTransport = (typeof TEXT_REASONING_TRANSPORTS)[number]

export type ProviderBodyCaps = {
  CHAT_TEXT_BODY_MAX_BYTES: number
  VISION_BODY_MAX_BYTES: number
  IMAGE_GENERATION_BODY_MAX_BYTES: number
}

export type ProviderWorkerEnvSource = {
  variable: string
  slot_aliases: string[]
  default_model?: boolean
}

/** Provider-neutral text reasoning capability; no provider SDK request leaks here. */
export interface TextReasoningProviderContract {
  capability: 'TextReasoning'
  model_id: string
}

/** Provider-neutral visual-evidence capability; image bytes remain gateway-owned. */
export interface VisualEvidenceProviderContract {
  capability: 'VisualEvidence'
  model_id: string
}

/** Provider-neutral media planning/QA capability; it is not the chat visual-evidence bridge. */
export interface MediaReasoningProviderContract {
  capability: 'MediaReasoning'
  model_id: string
}

/** Provider-neutral image-generation capability; it describes a selected model only. */
export interface ImageGenerationProviderContract {
  capability: 'ImageGeneration'
  model_id: string
}

/** Declarative limits consumed by ImageProviderPolicy before any paid POST. */
export type ImageGenerationProviderDescriptor = {
  operation_modes: Array<'generate' | 'edit' | 'inpaint'>
  max_reference_images: number
  reference_roles: Array<'subject' | 'product' | 'character' | 'style' | 'composition' | 'environment' | 'brand' | 'logo' | 'qrcode'>
  reference_preservations: Array<'may_change' | 'prefer_preserve' | 'must_preserve' | 'exact'>
  supported_sizes: string[]
  transparency: boolean
  max_output_count: number
  /** Versioned, non-secret maximum charge for one returned image.  The
   * Sidecar uses this quote before it creates paid work; Relay later records
   * the actual provider usage receipt separately. */
  price_upper_bound: {
    currency: string
    per_output_amount_minor: number
    pricing_revision: string
  }
}

/** Provider-neutral speech-transcription capability; audio transport is out of contract. */
export interface SpeechTranscriptionProviderContract {
  capability: 'SpeechTranscription'
  model_id: string
}

/** The video search index is the only separately-metered embedding capability. */
export interface SemanticEmbeddingProviderContract {
  capability: 'SemanticEmbedding'
  model_id: string
  dimension: 768
}

export type ProviderRegistryEntry = {
  model_id: string
  provider: string
  capabilities: ProviderCapability[]
  /** Required exactly for TextReasoning entries; absent for other capabilities. */
  text_reasoning_transport?: TextReasoningTransport
  /** Present only on ImageGeneration entries. */
  image_generation?: ImageGenerationProviderDescriptor
  worker_env_source: ProviderWorkerEnvSource
  body_caps: ProviderBodyCaps
  resume_evidence: { path: string; status: 'verified' | 'conservative' }
  contract_version: number
  verification_date: string
}

export type ProviderRuntimeConfigurationError =
  | 'MODEL_CONFIGURATION_INVALID'
  | 'MODEL_CONTRACT_VERSION_MISMATCH'
  | 'MODEL_CONTRACT_HASH_MISMATCH'
  | 'MODEL_CONTRACT_STALE'

// Gateway's legacy account policy deliberately excludes video-only embedding;
// Video Media Relay owns that separate provider/account ledger.
export type MeteredProviderCapability = Exclude<ProviderCapability, 'ImageGeneration' | 'SemanticEmbedding'>
export type ProviderUsageAmount = {
  requests: number
  input_bytes: number
  output_units: number
  /**
   * Provider-reported total model tokens.  This is intentionally distinct from
   * request bytes and output units: a managed Agent entitlement is charged by
   * the upstream's input + output token total, not by an approximation of it.
   */
  total_tokens: number
}

export type ProviderUsageBudgetPolicy = {
  revision: string
  period: 'utc_day'
  capabilities: Record<MeteredProviderCapability, {
    principal: ProviderUsageAmount
    installation: ProviderUsageAmount
  }>
}
export type ProviderUsageReceipt = {
  operation_id: string
  principal_id: string
  installation_id: string
  capability: MeteredProviderCapability
  policy_revision: string
  period: string
  state: 'reserved' | 'settled' | 'released' | 'outcome_unknown'
  reserved: ProviderUsageAmount
  actual: ProviderUsageAmount
  fencing_token: number
  upstream_receipt_hash?: string
}
