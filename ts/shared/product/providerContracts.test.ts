import { expect, test } from 'bun:test'
import {
  PROVIDER_CAPABILITIES,
  type ProviderRegistryEntry,
  type ProviderUsageBudgetPolicy,
  type ProviderUsageReceipt,
} from './providerContracts'

test('provider-neutral contracts expose exactly four capabilities without credentials', () => {
  expect(PROVIDER_CAPABILITIES).toEqual([
    'TextReasoning', 'VisualEvidence', 'ImageGeneration', 'SpeechTranscription',
  ])
  const entry: ProviderRegistryEntry = {
    model_id: 'model', provider: 'provider', capabilities: ['TextReasoning'],
    worker_env_source: { variable: 'MODEL', slot_aliases: [] }, verified_context_window: 16_000,
    body_caps: { CHAT_TEXT_BODY_MAX_BYTES: 1, VISION_BODY_MAX_BYTES: 2, IMAGE_GENERATION_BODY_MAX_BYTES: 3 },
    compact_threshold: 1, resume_evidence: { path: 'evidence', status: 'conservative' },
    contract_version: 1, verification_date: '2026-07-23',
  }
  expect(entry.body_caps.CHAT_TEXT_BODY_MAX_BYTES).toBe(1)
})

test('usage budget contracts compose principal and installation without provider fields', () => {
  const policy: ProviderUsageBudgetPolicy = {
    revision: 'test', period: 'utc_day',
    capabilities: Object.fromEntries(PROVIDER_CAPABILITIES
      .filter(capability => capability !== 'ImageGeneration')
      .map(capability => [capability, {
        principal: { requests: 2, input_bytes: 2, output_units: 2 },
        installation: { requests: 1, input_bytes: 1, output_units: 1 },
      }])) as ProviderUsageBudgetPolicy['capabilities'],
  }
  const receipt: ProviderUsageReceipt = {
    operation_id: 'operation', principal_id: 'principal', installation_id: 'installation',
    capability: 'TextReasoning', policy_revision: policy.revision, period: '2026-07-24',
    state: 'reserved', reserved: { requests: 1, input_bytes: 1, output_units: 1 },
    actual: { requests: 0, input_bytes: 0, output_units: 0 }, fencing_token: 1,
  }
  expect(receipt).not.toHaveProperty('provider')
  expect(policy.capabilities.TextReasoning.principal.requests).toBe(2)
})
