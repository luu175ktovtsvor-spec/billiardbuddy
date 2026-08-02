import { createHash } from 'node:crypto'
import type {
  ProviderRegistryEntry,
  ProviderRuntimeConfigurationError,
  TextReasoningTransport,
} from '../ts/shared/product/providerContracts.js'

export const PROVIDER_REGISTRY_CONTRACT_VERSION = 2 as const
export const PROVIDER_REGISTRY_VERIFICATION_DATE = '2026-07-23'
export const PROVIDER_RUNTIME_CONTRACT_VERSION_ENV = 'BB_PROVIDER_CONTRACT_VERSION'
export const PROVIDER_RUNTIME_REGISTRY_SHA256_ENV = 'BB_PROVIDER_REGISTRY_SHA256'
export const PROVIDER_RUNTIME_MANIFEST_SHA256_ENV = 'BB_PROVIDER_WORKER_MANIFEST_SHA256'

/**
 * The one canonical, non-secret model registry.  Windows are deliberately the
 * project-wide lower bound (16k): repository evidence records larger advertised
 * limits but no end-to-end worker verification of them.
 */
export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    model_id: 'deepseek-v4-flash',
    provider: 'deepseek',
    capabilities: ['TextReasoning'],
    text_reasoning_transport: 'responses',
    worker_env_source: { variable: 'BB_GATEWAY_MODEL', slot_aliases: [], default_model: true },
    verified_context_window: 16_000,
    body_caps: {
      CHAT_TEXT_BODY_MAX_BYTES: 24 * 1024 * 1024,
      VISION_BODY_MAX_BYTES: 24 * 1024 * 1024,
      IMAGE_GENERATION_BODY_MAX_BYTES: 32 * 1024 * 1024,
    },
    compact_threshold: 12_000,
    resume_evidence: { path: 'ts/desktop/electron/services/codexNativeAppServer.ts', status: 'conservative' },
    contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
    verification_date: PROVIDER_REGISTRY_VERIFICATION_DATE,
  },
  {
    model_id: 'mimo-v2.5',
    provider: 'mimo',
    capabilities: ['VisualEvidence', 'MediaReasoning'],
    worker_env_source: { variable: 'GW_MIMO_MODEL', slot_aliases: [] },
    verified_context_window: 16_000,
    body_caps: {
      CHAT_TEXT_BODY_MAX_BYTES: 24 * 1024 * 1024,
      VISION_BODY_MAX_BYTES: 24 * 1024 * 1024,
      IMAGE_GENERATION_BODY_MAX_BYTES: 32 * 1024 * 1024,
    },
    compact_threshold: 12_000,
    resume_evidence: { path: 'gateway/visionBridge.ts', status: 'conservative' },
    contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
    verification_date: PROVIDER_REGISTRY_VERIFICATION_DATE,
  },
  {
    model_id: 'gpt-image-2',
    provider: 'openai',
    capabilities: ['ImageGeneration'],
    worker_env_source: { variable: 'RELAY_IMAGE_MODEL', slot_aliases: [] },
    verified_context_window: 16_000,
    body_caps: {
      CHAT_TEXT_BODY_MAX_BYTES: 24 * 1024 * 1024,
      VISION_BODY_MAX_BYTES: 24 * 1024 * 1024,
      IMAGE_GENERATION_BODY_MAX_BYTES: 32 * 1024 * 1024,
    },
    compact_threshold: 12_000,
    resume_evidence: { path: 'relay/app.ts', status: 'verified' },
    contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
    verification_date: PROVIDER_REGISTRY_VERIFICATION_DATE,
  },
  {
    model_id: 'doubao-seedream-4-5-251128',
    provider: 'bytedance-ark',
    capabilities: ['ImageGeneration'],
    worker_env_source: { variable: 'RELAY_SEEDREAM_MODEL', slot_aliases: [] },
    verified_context_window: 16_000,
    body_caps: {
      CHAT_TEXT_BODY_MAX_BYTES: 24 * 1024 * 1024,
      VISION_BODY_MAX_BYTES: 24 * 1024 * 1024,
      IMAGE_GENERATION_BODY_MAX_BYTES: 32 * 1024 * 1024,
    },
    compact_threshold: 12_000,
    resume_evidence: { path: 'relay/app.ts', status: 'verified' },
    contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
    verification_date: PROVIDER_REGISTRY_VERIFICATION_DATE,
  },
  {
    model_id: 'fun-asr-flash-2026-06-15',
    provider: 'dashscope',
    capabilities: ['SpeechTranscription'],
    worker_env_source: { variable: 'GW_FUNASR_MODEL', slot_aliases: [] },
    verified_context_window: 16_000,
    body_caps: {
      CHAT_TEXT_BODY_MAX_BYTES: 24 * 1024 * 1024,
      VISION_BODY_MAX_BYTES: 24 * 1024 * 1024,
      IMAGE_GENERATION_BODY_MAX_BYTES: 32 * 1024 * 1024,
    },
    compact_threshold: 12_000,
    resume_evidence: { path: 'gateway/transcription.ts', status: 'verified' },
    contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
    verification_date: PROVIDER_REGISTRY_VERIFICATION_DATE,
  },
] as const

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function stable(value: Json): Json {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key]!)]))
  return value
}

export function stableProviderJson(value: Json): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`
}

export function providerRegistrySha256(): string {
  return createHash('sha256').update(stableProviderJson(PROVIDER_REGISTRY as unknown as Json)).digest('hex')
}

type WorkerModelRegistryEntry = {
  model_id: string
  capabilities: readonly string[]
  text_reasoning_transport?: TextReasoningTransport
  worker_env_source: { default_model?: boolean }
  verified_context_window: number
  compact_threshold: number
}

export function workerTextReasoningEntry(registry: readonly WorkerModelRegistryEntry[] = PROVIDER_REGISTRY): WorkerModelRegistryEntry | undefined {
  const textReasoning = registry.filter(candidate => candidate.capabilities.includes('TextReasoning'))
  const defaults = textReasoning.filter(candidate => candidate.worker_env_source.default_model === true)
  if (defaults.length !== 1 || !defaults[0]!.text_reasoning_transport) return undefined
  return defaults[0]
}

export function defaultProviderModel(registry: readonly WorkerModelRegistryEntry[] = PROVIDER_REGISTRY): string {
  const entry = workerTextReasoningEntry(registry)
  if (!entry) throw new Error('provider registry has no unique TextReasoning default model')
  return entry.model_id
}

export function providerRegistryEntry(model: string | undefined): ProviderRegistryEntry | undefined {
  const normalized = model?.trim()
  return normalized ? PROVIDER_REGISTRY.find(candidate => candidate.model_id === normalized) : undefined
}

export function providerRegistryEntryForCapability(capability: ProviderRegistryEntry['capabilities'][number]): ProviderRegistryEntry {
  const entries = PROVIDER_REGISTRY.filter(entry => entry.capabilities.includes(capability))
  if (entries.length !== 1) throw new Error(`provider registry must contain exactly one ${capability} entry`)
  return entries[0]!
}

export function providerRegistryEntriesForCapability(capability: ProviderRegistryEntry['capabilities'][number]): ProviderRegistryEntry[] {
  return PROVIDER_REGISTRY.filter(entry => entry.capabilities.includes(capability))
}

export function textReasoningRegistryEntry(): ProviderRegistryEntry
export function textReasoningRegistryEntry(model: string): ProviderRegistryEntry | undefined
export function textReasoningRegistryEntry(model?: string): ProviderRegistryEntry | undefined {
  const defaultEntry = workerTextReasoningEntry()
  if (!defaultEntry) {
    if (model === undefined) throw new Error('provider registry has no unique TextReasoning default model')
    return undefined
  }
  if (model === undefined) return providerRegistryEntry(defaultEntry.model_id)
  const entry = providerRegistryEntry(model)
  return entry?.capabilities.includes('TextReasoning') ? entry : undefined
}

export function visualEvidenceRegistryEntry(): ProviderRegistryEntry {
  return providerRegistryEntryForCapability('VisualEvidence')
}

export function mediaReasoningRegistryEntry(): ProviderRegistryEntry {
  return providerRegistryEntryForCapability('MediaReasoning')
}

/** Build the private Worker compatibility manifest from the canonical registry. */
export function renderProviderRuntimeManifest(): Json {
  const registry_sha256 = providerRegistrySha256()
  return {
    schema_version: 1,
    contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
    registry_sha256,
    capabilities: PROVIDER_REGISTRY.map(entry => ({
      model_id: entry.model_id,
      provider: entry.provider,
      capabilities: entry.capabilities,
      ...(entry.text_reasoning_transport ? { text_reasoning_transport: entry.text_reasoning_transport } : {}),
      worker_env_source: entry.worker_env_source,
      verified_context_window: entry.verified_context_window,
      body_caps: entry.body_caps,
      compact_threshold: entry.compact_threshold,
      resume_evidence: entry.resume_evidence,
      contract_version: entry.contract_version,
      verification_date: entry.verification_date,
    })) as unknown as Json[],
  }
}

export function providerManifestSha256(): string {
  return createHash('sha256').update(stableProviderJson(renderProviderRuntimeManifest())).digest('hex')
}

export function buildProviderRegistryRuntimeEnv(model: string | undefined): Record<string, string> {
  const selected = model?.trim() || defaultProviderModel()
  const entry = textReasoningRegistryEntry(selected)
  const contract = {
    [PROVIDER_RUNTIME_CONTRACT_VERSION_ENV]: String(PROVIDER_REGISTRY_CONTRACT_VERSION),
    [PROVIDER_RUNTIME_REGISTRY_SHA256_ENV]: providerRegistrySha256(),
    [PROVIDER_RUNTIME_MANIFEST_SHA256_ENV]: providerManifestSha256(),
    BB_GATEWAY_MODEL: selected,
  }
  if (!entry) return contract
  return {
    ...contract,
    BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS: JSON.stringify({ [selected]: entry.verified_context_window }),
    BILLIARDBUDDY_AUTO_COMPACT_WINDOW: String(entry.compact_threshold),
  }
}

export function validateProviderRegistryEntry(entry: Pick<ProviderRegistryEntry, 'capabilities' | 'text_reasoning_transport' | 'verified_context_window' | 'verification_date' | 'body_caps' | 'resume_evidence'>): ProviderRuntimeConfigurationError | undefined {
  if (!entry.resume_evidence.path || entry.verification_date !== PROVIDER_REGISTRY_VERIFICATION_DATE || entry.verified_context_window >= 1_000_000) return 'MODEL_CONTRACT_STALE'
  const caps = entry.body_caps
  if (caps.CHAT_TEXT_BODY_MAX_BYTES <= 0 || caps.VISION_BODY_MAX_BYTES <= 0 || caps.IMAGE_GENERATION_BODY_MAX_BYTES <= 0) return 'MODEL_CONTRACT_STALE'
  const needsTextTransport = entry.capabilities.includes('TextReasoning')
  if (needsTextTransport !== Boolean(entry.text_reasoning_transport)) return 'MODEL_CONTRACT_STALE'
  if (entry.text_reasoning_transport && !['chat_completions', 'responses'].includes(entry.text_reasoning_transport)) return 'MODEL_CONTRACT_STALE'
  return undefined
}

export function validateProviderRuntimeConfiguration(env: Record<string, string | undefined>): ProviderRuntimeConfigurationError | undefined {
  if (env[PROVIDER_RUNTIME_CONTRACT_VERSION_ENV] !== String(PROVIDER_REGISTRY_CONTRACT_VERSION)) return 'MODEL_CONTRACT_VERSION_MISMATCH'
  if (env[PROVIDER_RUNTIME_REGISTRY_SHA256_ENV] !== providerRegistrySha256() || env[PROVIDER_RUNTIME_MANIFEST_SHA256_ENV] !== providerManifestSha256()) return 'MODEL_CONTRACT_HASH_MISMATCH'
  for (const entry of PROVIDER_REGISTRY) {
    const error = validateProviderRegistryEntry(entry)
    if (error) return error
  }
  const selectedModel = env.BB_GATEWAY_MODEL?.trim()
  const textReasoning = selectedModel ? textReasoningRegistryEntry(selectedModel) : undefined
  if (!textReasoning?.text_reasoning_transport) return 'MODEL_CONFIGURATION_INVALID'
  if (env.BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS !== JSON.stringify({ [textReasoning.model_id]: textReasoning.verified_context_window })) return 'MODEL_CONFIGURATION_INVALID'
  if (env.BILLIARDBUDDY_AUTO_COMPACT_WINDOW !== String(textReasoning.compact_threshold)) return 'MODEL_CONFIGURATION_INVALID'
  return undefined
}
