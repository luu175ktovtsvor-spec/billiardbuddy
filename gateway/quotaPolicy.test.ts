import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT,
  gatewayUsagePolicyFromEnvironment,
} from './quotaPolicy'

describe('Gateway quota policy', () => {
  test('保留产品默认日额度', () => {
    const policy = gatewayUsagePolicyFromEnvironment({})

    expect(policy.revision).toBe('bb-agent-daily-token-v1')
    expect(policy.capabilities.TextReasoning.installation.total_tokens)
      .toBe(DEFAULT_MANAGED_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT)
    expect(policy.capabilities.VisualEvidence.principal).toEqual({
      requests: 20_000,
      input_bytes: 500 * 1024 ** 3,
      output_units: 20_000_000,
      total_tokens: 1_000_000_000_000,
    })
    expect(policy.capabilities.SpeechTranscription.installation.output_units).toBe(20_000_000)
  })

  test('可按命名环境变量覆盖每个能力、主体和计费轴', () => {
    const policy = gatewayUsagePolicyFromEnvironment({
      GW_QUOTA_POLICY_REVISION: 'gateway-limits-v2',
      GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT: '123456',
      GW_QUOTA_VISUAL_EVIDENCE_PRINCIPAL_REQUESTS: '12',
      GW_QUOTA_MEDIA_REASONING_INSTALLATION_INPUT_BYTES: '34',
      GW_QUOTA_SPEECH_TRANSCRIPTION_PRINCIPAL_OUTPUT_UNITS: '56',
      GW_QUOTA_SPEECH_TRANSCRIPTION_INSTALLATION_TOTAL_TOKENS: '78',
    })

    expect(policy.revision).toBe('gateway-limits-v2')
    expect(policy.capabilities.TextReasoning.installation.total_tokens).toBe(123456)
    expect(policy.capabilities.VisualEvidence.principal.requests).toBe(12)
    expect(policy.capabilities.MediaReasoning.installation.input_bytes).toBe(34)
    expect(policy.capabilities.SpeechTranscription.principal.output_units).toBe(56)
    expect(policy.capabilities.SpeechTranscription.installation.total_tokens).toBe(78)
  })

  test('拒绝含糊或非安全整数的环境覆盖', () => {
    expect(() => gatewayUsagePolicyFromEnvironment({ GW_QUOTA_VISUAL_EVIDENCE_PRINCIPAL_REQUESTS: '1.5' }))
      .toThrow('GW_QUOTA_VISUAL_EVIDENCE_PRINCIPAL_REQUESTS')
    expect(() => gatewayUsagePolicyFromEnvironment({ GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT: '9', GW_QUOTA_TEXT_REASONING_INSTALLATION_TOTAL_TOKENS: '9' }))
      .toThrow('cannot both be set')
    expect(() => gatewayUsagePolicyFromEnvironment({ GW_QUOTA_MEDIA_REASONING_PRINCIPAL_INPUT_BYTES: '9007199254740992' }))
      .toThrow('GW_QUOTA_MEDIA_REASONING_PRINCIPAL_INPUT_BYTES')
  })
})
