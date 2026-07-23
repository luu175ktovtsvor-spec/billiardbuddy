import { expect, test } from 'bun:test'
import {
  PROVIDER_REGISTRY,
  buildProviderRegistryRuntimeEnv,
  defaultProviderModel,
  providerManifestSha256,
  providerRegistrySha256,
  renderProviderContractArtifacts,
  stableProviderJson,
  validateProviderRuntimeConfiguration,
} from './providerRegistry'

test('registry provides the four neutral capabilities from one conservative source', () => {
  expect(new Set(PROVIDER_REGISTRY.flatMap(entry => entry.capabilities))).toEqual(new Set([
    'TextReasoning', 'VisualEvidence', 'ImageGeneration', 'SpeechTranscription',
  ]))
  expect(PROVIDER_REGISTRY.every(entry => entry.verified_context_window < 1_000_000)).toBe(true)
  expect(PROVIDER_REGISTRY.every(entry => entry.body_caps.CHAT_TEXT_BODY_MAX_BYTES === 24 * 1024 * 1024)).toBe(true)
  expect(PROVIDER_REGISTRY.every(entry => entry.body_caps.VISION_BODY_MAX_BYTES === 24 * 1024 * 1024)).toBe(true)
  expect(PROVIDER_REGISTRY.every(entry => entry.body_caps.IMAGE_GENERATION_BODY_MAX_BYTES === 32 * 1024 * 1024)).toBe(true)
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

test('runtime configuration rejects unknown aliases and stale contract bindings before ready', () => {
  const valid = buildProviderRegistryRuntimeEnv(defaultProviderModel())
  expect(validateProviderRuntimeConfiguration(valid)).toBeUndefined()
  expect(validateProviderRuntimeConfiguration({ ...valid, QF_GATEWAY_MODEL: 'qwen3-coder-plus' })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, ANTHROPIC_DEFAULT_OPUS_MODEL: 'unknown' })).toBe('MODEL_CONFIGURATION_INVALID')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_PROVIDER_REGISTRY_SHA256: '0'.repeat(64) })).toBe('MODEL_CONTRACT_HASH_MISMATCH')
  expect(validateProviderRuntimeConfiguration({ ...valid, BB_PROVIDER_CONTRACT_VERSION: '0' })).toBe('MODEL_CONTRACT_VERSION_MISMATCH')
  expect(providerManifestSha256()).toMatch(/^[a-f0-9]{64}$/)
})
