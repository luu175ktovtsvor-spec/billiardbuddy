import { describe, expect, test } from 'bun:test'

import { imageRelayQuotaPolicyFromEnvironment } from './quotaPolicy'

describe('Image Relay paid quota policy', () => {
  test('keeps owner and physical-account daily USD minor limits external and bounded', () => {
    expect(imageRelayQuotaPolicyFromEnvironment({
      RELAY_QUOTA_POLICY_REVISION: 'image-spend-2026-08-04',
      RELAY_OWNER_DAILY_USD_MINOR_LIMIT: '42',
      RELAY_OPENAI_DAILY_USD_MINOR_LIMIT: '420',
      RELAY_SEEDREAM_DAILY_USD_MINOR_LIMIT: '210',
    })).toEqual({
      revision: 'image-spend-2026-08-04',
      owner_daily_usd_minor_limit: 42,
      provider_daily_usd_minor_limit: { openai: 420, seedream: 210 },
    })
    expect(() => imageRelayQuotaPolicyFromEnvironment({ RELAY_OWNER_DAILY_USD_MINOR_LIMIT: '-1' }))
      .toThrow('RELAY_OWNER_DAILY_USD_MINOR_LIMIT')
    expect(() => imageRelayQuotaPolicyFromEnvironment({ RELAY_QUOTA_POLICY_REVISION: 'bad value' }))
      .toThrow('RELAY_QUOTA_POLICY_REVISION')
  })
})
