import { expect, test } from 'bun:test'
import {
  PROVIDER_REGISTRY,
  buildProviderRegistryRuntimeEnv,
  defaultProviderModel,
  providerManifestSha256,
  mediaReasoningRegistryEntry,
  providerRegistryEntryForCapability,
  providerRegistrySha256,
  renderProviderRuntimeManifest,
  stableProviderJson,
  textReasoningRegistryEntry,
  validateProviderRuntimeConfiguration,
  visualEvidenceRegistryEntry,
  workerTextReasoningEntry,
} from './providerRegistry'

test('registry provides the five neutral capabilities from one conservative source', () => {
  expect(new Set(PROVIDER_REGISTRY.flatMap(entry => entry.capabilities))).toEqual(new Set([
    'TextReasoning', 'VisualEvidence', 'MediaReasoning', 'ImageGeneration', 'SpeechTranscription',
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
  expect(mediaReasoningRegistryEntry()).toBe(providerRegistryEntryForCapability('MediaReasoning'))
})

test('the Worker runtime manifest is a deterministic projection of the canonical registry', () => {
  const manifest = renderProviderRuntimeManifest() as any
  expect(manifest.registry_sha256).toBe(providerRegistrySha256())
  expect(manifest.capabilities.map((entry: { model_id: string }) => entry.model_id)).toEqual(
    PROVIDER_REGISTRY.map(entry => entry.model_id),
  )
  expect(stableProviderJson(manifest)).toBe(stableProviderJson(renderProviderRuntimeManifest()))
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

test('runtime configuration binds the Core model and context policy to the unique TextReasoning entry before ready', () => {
  const textReasoning = PROVIDER_REGISTRY.filter(entry => entry.capabilities.includes('TextReasoning'))
  const nonText = PROVIDER_REGISTRY.find(entry => !entry.capabilities.includes('TextReasoning'))!
  expect(textReasoning).toHaveLength(1)
  const textModel = textReasoning[0]!.model_id
  const valid = buildProviderRegistryRuntimeEnv(defaultProviderModel())
  expect(valid.BB_GATEWAY_MODEL).toBe(textModel)
  expect(valid.BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS).toBe(JSON.stringify({ [textModel]: textReasoning[0]!.verified_context_window }))
  expect(valid.BILLIARDBUDDY_AUTO_COMPACT_WINDOW).toBe(String(textReasoning[0]!.compact_threshold))
  expect(validateProviderRuntimeConfiguration(valid)).toBeUndefined()
  expect(validateProviderRuntimeConfiguration(buildProviderRegistryRuntimeEnv(nonText.model_id))).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_GATEWAY_MODEL: nonText.model_id })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS: '{}' })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, BILLIARDBUDDY_AUTO_COMPACT_WINDOW: '1' })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_GATEWAY_MODEL: 'qwen3-coder-plus' })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_PROVIDER_REGISTRY_SHA256: '0'.repeat(64) })).toBe('MODEL_CONTRACT_HASH_MISMATCH')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_PROVIDER_CONTRACT_VERSION: '0' })).toBe('MODEL_CONTRACT_VERSION_MISMATCH')
  expect(providerManifestSha256()).toMatch(/^[a-f0-9]{64}$/)
})
