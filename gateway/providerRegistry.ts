import { createHash } from 'node:crypto'
import type {
  ManagedModelWorkload,
  ProviderRegistryEntry,
  ProviderRuntimeConfigurationError,
  TextReasoningTransport,
} from '../ts/shared/product/providerContracts.js'
import { MANAGED_MODEL_WORKLOADS } from '../ts/shared/product/providerContracts.js'
import {
  MANAGED_MODEL_CATALOG,
  defaultManagedModelForWorkload,
  managedModelById,
} from '../ts/shared/product/modelCatalog.js'

export const PROVIDER_REGISTRY_CONTRACT_VERSION = 5 as const
export const PROVIDER_REGISTRY_VERIFICATION_DATE = '2026-08-04'
export const PROVIDER_RUNTIME_CONTRACT_VERSION_ENV = 'BB_PROVIDER_CONTRACT_VERSION'
export const PROVIDER_RUNTIME_REGISTRY_SHA256_ENV = 'BB_PROVIDER_REGISTRY_SHA256'
export const PROVIDER_RUNTIME_MANIFEST_SHA256_ENV = 'BB_PROVIDER_WORKER_MANIFEST_SHA256'

/** Runtime contract metadata is added here; every model fact lives in the shared catalog. */
export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = MANAGED_MODEL_CATALOG.map(entry => ({
  ...entry,
  contract_version: PROVIDER_REGISTRY_CONTRACT_VERSION,
  verification_date: PROVIDER_REGISTRY_VERIFICATION_DATE,
}))

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
  workload_bindings?: readonly { workload: string; default_for_workload?: boolean }[]
  text_reasoning_transport?: TextReasoningTransport
  worker_env_source: { default_model?: boolean }
}

export function workerTextReasoningEntry(registry: readonly WorkerModelRegistryEntry[] = PROVIDER_REGISTRY): WorkerModelRegistryEntry | undefined {
  const textReasoning = registry.filter(candidate => candidate.capabilities.includes('TextReasoning'))
  const defaults = textReasoning.filter(candidate => candidate.workload_bindings
    ? candidate.workload_bindings.some(binding => binding.workload === 'managed_agent_text' && binding.default_for_workload === true)
    : candidate.worker_env_source.default_model === true)
  if (defaults.length !== 1 || !defaults[0]!.text_reasoning_transport) return undefined
  return defaults[0]
}

export function defaultProviderModel(registry: readonly WorkerModelRegistryEntry[] = PROVIDER_REGISTRY): string {
  const entry = workerTextReasoningEntry(registry)
  if (!entry) throw new Error('provider registry has no unique TextReasoning default model')
  return entry.model_id
}

export function providerRegistryEntry(model: string | undefined): ProviderRegistryEntry | undefined {
  const catalogEntry = managedModelById(model)
  return catalogEntry ? PROVIDER_REGISTRY.find(candidate => candidate.model_id === catalogEntry.model_id) : undefined
}

export function providerRegistryEntryForWorkload(workload: ManagedModelWorkload, model?: string): ProviderRegistryEntry {
  const selected = model?.trim()
    ? providerRegistryEntry(model)
    : providerRegistryEntry(defaultManagedModelForWorkload(workload).model_id)
  if (!selected?.workload_bindings.some(binding => binding.workload === workload)) {
    throw new Error(`provider registry model is not registered for ${workload}`)
  }
  return selected
}

/** Compatibility helper for callers that truly require one capability-wide model.
 * New routing code must use a workload so Qwen image advice cannot replace the
 * unrelated shared visual-evidence contract. */
export function providerRegistryEntryForCapability(capability: ProviderRegistryEntry['capabilities'][number]): ProviderRegistryEntry {
  const entries = PROVIDER_REGISTRY.filter(entry => entry.capabilities.includes(capability))
  if (entries.length !== 1) throw new Error(`provider registry capability ${capability} is ambiguous; select a workload`)
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
  return providerRegistryEntryForWorkload('shared_visual_evidence')
}

export function mediaReasoningRegistryEntry(): ProviderRegistryEntry {
  return providerRegistryEntryForWorkload('media_reasoning')
}

export function imageAdviceRegistryEntry(model?: string): ProviderRegistryEntry {
  return providerRegistryEntryForWorkload('image_advice', model)
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
      workload_bindings: entry.workload_bindings,
      ...(entry.text_reasoning_transport ? { text_reasoning_transport: entry.text_reasoning_transport } : {}),
      ...(entry.image_generation ? { image_generation: entry.image_generation } : {}),
      worker_env_source: entry.worker_env_source,
      body_caps: entry.body_caps,
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
  const contract = {
    [PROVIDER_RUNTIME_CONTRACT_VERSION_ENV]: String(PROVIDER_REGISTRY_CONTRACT_VERSION),
    [PROVIDER_RUNTIME_REGISTRY_SHA256_ENV]: providerRegistrySha256(),
    [PROVIDER_RUNTIME_MANIFEST_SHA256_ENV]: providerManifestSha256(),
    BB_GATEWAY_MODEL: selected,
  }
  return contract
}

export function validateProviderRegistryEntry(entry: Pick<ProviderRegistryEntry, 'capabilities' | 'workload_bindings' | 'text_reasoning_transport' | 'image_generation' | 'verification_date' | 'body_caps' | 'resume_evidence'>): ProviderRuntimeConfigurationError | undefined {
  if (
    !entry.resume_evidence.path
    || entry.verification_date !== PROVIDER_REGISTRY_VERIFICATION_DATE
  ) return 'MODEL_CONTRACT_STALE'
  const caps = entry.body_caps
  if (caps.CHAT_TEXT_BODY_MAX_BYTES <= 0 || caps.VISION_BODY_MAX_BYTES <= 0 || caps.IMAGE_GENERATION_BODY_MAX_BYTES <= 0) return 'MODEL_CONTRACT_STALE'
  if (entry.workload_bindings.length === 0 || entry.workload_bindings.some(binding => (
    !binding.workload || !binding.capacity_pool || !binding.quota_bucket
    || !binding.execution_runtime || !binding.credential_slot
  ))) return 'MODEL_CONTRACT_STALE'
  const needsTextTransport = entry.capabilities.includes('TextReasoning')
  if (needsTextTransport !== Boolean(entry.text_reasoning_transport)) return 'MODEL_CONTRACT_STALE'
  if (entry.text_reasoning_transport && !['chat_completions', 'responses'].includes(entry.text_reasoning_transport)) return 'MODEL_CONTRACT_STALE'
  const needsImageDescriptor = entry.capabilities.includes('ImageGeneration')
  if (needsImageDescriptor !== Boolean(entry.image_generation)) return 'MODEL_CONTRACT_STALE'
  if (entry.image_generation && (
    entry.image_generation.operation_modes.length === 0
    || entry.image_generation.max_reference_images < 0
    || entry.image_generation.reference_roles.length === 0
    || entry.image_generation.reference_preservations.length === 0
    || entry.image_generation.supported_sizes.length === 0
    || entry.image_generation.max_output_count < 1
  )) return 'MODEL_CONTRACT_STALE'
  return undefined
}

export function validateProviderRuntimeConfiguration(env: Record<string, string | undefined>): ProviderRuntimeConfigurationError | undefined {
  if (env[PROVIDER_RUNTIME_CONTRACT_VERSION_ENV] !== String(PROVIDER_REGISTRY_CONTRACT_VERSION)) return 'MODEL_CONTRACT_VERSION_MISMATCH'
  if (env[PROVIDER_RUNTIME_REGISTRY_SHA256_ENV] !== providerRegistrySha256() || env[PROVIDER_RUNTIME_MANIFEST_SHA256_ENV] !== providerManifestSha256()) return 'MODEL_CONTRACT_HASH_MISMATCH'
  for (const entry of PROVIDER_REGISTRY) {
    const error = validateProviderRegistryEntry(entry)
    if (error) return error
  }
  for (const workload of MANAGED_MODEL_WORKLOADS) {
    const defaults = PROVIDER_REGISTRY.filter(entry => entry.workload_bindings.some(
      binding => binding.workload === workload && binding.default_for_workload === true,
    ))
    if (defaults.length !== 1) return 'MODEL_CONFIGURATION_INVALID'
  }
  const selectedModel = env.BB_GATEWAY_MODEL?.trim()
  const textReasoning = selectedModel ? textReasoningRegistryEntry(selectedModel) : undefined
  if (!textReasoning?.text_reasoning_transport) return 'MODEL_CONFIGURATION_INVALID'
  return undefined
}
