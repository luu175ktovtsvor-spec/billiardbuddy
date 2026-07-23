import { expect, test } from 'bun:test'
import { PROVIDER_CAPABILITIES, type ProviderRegistryEntry } from './providerContracts'

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
