import { expect, test } from 'bun:test'
import {
  PROVIDER_REGISTRY,
  buildProviderRegistryRuntimeEnv,
  defaultProviderModel,
  providerManifestSha256,
  providerRegistryEntryForCapability,
  providerRegistrySha256,
  renderProviderContractArtifacts,
  stableProviderJson,
  textReasoningRegistryEntry,
  validateProviderRuntimeConfiguration,
  visualEvidenceRegistryEntry,
  workerTextReasoningEntry,
} from './providerRegistry'

test('registry provides the four neutral capabilities from one conservative source', () => {
  expect(new Set(PROVIDER_REGISTRY.flatMap(entry => entry.capabilities))).toEqual(new Set([
    'TextReasoning', 'VisualEvidence', 'ImageGeneration', 'SpeechTranscription',
  ]))
  expect(PROVIDER_REGISTRY.every(entry => entry.verified_context_window < 1_000_000)).toBe(true)
  expect(PROVIDER_REGISTRY.every(entry => entry.body_caps.CHAT_TEXT_BODY_MAX_BYTES === 24 * 1024 * 1024)).toBe(true)
  expect(PROVIDER_REGISTRY.every(entry => entry.body_caps.VISION_BODY_MAX_BYTES === 24 * 1024 * 1024)).toBe(true)
  expect(PROVIDER_REGISTRY.every(entry => entry.body_caps.IMAGE_GENERATION_BODY_MAX_BYTES === 32 * 1024 * 1024)).toBe(true)
  expect(PROVIDER_REGISTRY
    .filter(entry => entry.capabilities.includes('ImageGeneration'))
    .map(entry => entry.model_id))
    .toEqual(['gpt-image-2', 'doubao-seedream-4-5-251128'])
  expect(textReasoningRegistryEntry()).toBe(providerRegistryEntryForCapability('TextReasoning'))
  expect(visualEvidenceRegistryEntry()).toBe(providerRegistryEntryForCapability('VisualEvidence'))
})

test('both generated artifacts share and cross-reference the canonical digest', () => {
  const artifacts = renderProviderContractArtifacts()
  const contract = artifacts['model-contract.json'] as any
  const manifest = artifacts['worker-capability-manifest.json'] as any
  expect(contract.registry_sha256).toBe(providerRegistrySha256())
  expect(manifest.registry_sha256).toBe(providerRegistrySha256())
  expect(contract.worker_capability_manifest.registry_sha256).toBe(manifest.registry_sha256)
  expect(manifest.model_contract.registry_sha256).toBe(contract.registry_sha256)
  expect(stableProviderJson(artifacts['model-contract.json'])).toBe(stableProviderJson(renderProviderContractArtifacts()['model-contract.json']))
})

test('TextReasoning default selection requires one text entry, one default entry, and matching model IDs', () => {
  const entry = (model_id: string, capabilities: string[], default_model = false) => ({ model_id, capabilities, worker_env_source: default_model ? { default_model: true } : {} })
  const invalidRegistries = [
    [entry('visual', ['VisualEvidence'], true)],
    [entry('text-a', ['TextReasoning'], true), entry('text-b', ['TextReasoning'])],
    [entry('text', ['TextReasoning']), entry('visual', ['VisualEvidence'])],
    [entry('text', ['TextReasoning'], true), entry('visual', ['VisualEvidence'], true)],
    [entry('text', ['TextReasoning']), entry('visual', ['VisualEvidence'], true)],
  ]
  for (const registry of invalidRegistries) {
    expect(workerTextReasoningEntry(registry)).toBeUndefined()
    expect(() => defaultProviderModel(registry)).toThrow('provider registry has no unique TextReasoning default model')
  }
})

test('runtime configuration binds every Core model slot to the unique TextReasoning entry before ready', () => {
  const textReasoning = PROVIDER_REGISTRY.filter(entry => entry.capabilities.includes('TextReasoning'))
  const nonText = PROVIDER_REGISTRY.find(entry => !entry.capabilities.includes('TextReasoning'))!
  expect(textReasoning).toHaveLength(1)
  const textModel = textReasoning[0]!.model_id
  const valid = buildProviderRegistryRuntimeEnv(defaultProviderModel())
  const slots = ['QF_GATEWAY_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'] as const
  expect(slots.map(slot => valid[slot])).toEqual([textModel, textModel, textModel, textModel, textModel])
  expect(validateProviderRuntimeConfiguration(valid)).toBeUndefined()
  expect(validateProviderRuntimeConfiguration(buildProviderRegistryRuntimeEnv(nonText.model_id))).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, QF_GATEWAY_MODEL: nonText.model_id })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, ANTHROPIC_DEFAULT_OPUS_MODEL: nonText.model_id })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, QF_GATEWAY_MODEL: textModel, ANTHROPIC_MODEL: nonText.model_id })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, QF_GATEWAY_MODEL: 'qwen3-coder-plus' })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, ANTHROPIC_DEFAULT_OPUS_MODEL: 'unknown' })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_PROVIDER_REGISTRY_SHA256: '0'.repeat(64) })).toBe('MODEL_CONTRACT_HASH_MISMATCH')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_PROVIDER_CONTRACT_VERSION: '0' })).toBe('MODEL_CONTRACT_VERSION_MISMATCH')
  expect(providerManifestSha256()).toMatch(/^[a-f0-9]{64}$/)
})
