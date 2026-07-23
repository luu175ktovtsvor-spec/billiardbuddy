export const PROVIDER_CAPABILITIES = [
  'TextReasoning',
  'VisualEvidence',
  'ImageGeneration',
  'SpeechTranscription',
] as const

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number]

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

/** Provider-neutral image-generation capability; it describes a selected model only. */
export interface ImageGenerationProviderContract {
  capability: 'ImageGeneration'
  model_id: string
}

/** Provider-neutral speech-transcription capability; audio transport is out of contract. */
export interface SpeechTranscriptionProviderContract {
  capability: 'SpeechTranscription'
  model_id: string
}

export type ProviderRegistryEntry = {
  model_id: string
  provider: string
  capabilities: ProviderCapability[]
  worker_env_source: ProviderWorkerEnvSource
  verified_context_window: number
  body_caps: ProviderBodyCaps
  compact_threshold: number
  resume_evidence: { path: string; status: 'verified' | 'conservative' }
  contract_version: number
  verification_date: string
}

export type ProviderRuntimeConfigurationError =
  | 'MODEL_CONFIGURATION_INVALID'
  | 'MODEL_CONTRACT_VERSION_MISMATCH'
  | 'MODEL_CONTRACT_HASH_MISMATCH'
  | 'MODEL_CONTRACT_STALE'
