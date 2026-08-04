import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  ImageRelayResultCredentials,
  loadImageRelayResultCredentials,
  parseImageRelayPublicBase,
} from './resultCredentials'

const SIGNING_KEY = 'result-signing-key-that-is-longer-than-thirty-two-bytes'

describe('ImageRelayResultCredentials', () => {
  test('issues an owner-bound, expiring result URL without exposing its key', () => {
    let now = 1_800_000_000_000
    const credentials = new ImageRelayResultCredentials({
      publicBaseUrl: 'https://example.test/image-generation/',
      signingKey: SIGNING_KEY,
      grantTtlMs: 60_000,
      now: () => now,
    })
    const grant = credentials.issue('task-1', 'principal:installation')
    const payload = credentials.verify(grant)

    expect(payload).toMatchObject({ v: 1, task_id: 'task-1', expires_at: now + 60_000 })
    expect(credentials.isOwner(payload!, 'principal:installation')).toBe(true)
    expect(credentials.isOwner(payload!, 'another-owner')).toBe(false)
    expect(credentials.resultUrl(grant, 1)).toBe(`https://example.test/image-generation/v1/images/results/${grant}/1`)
    expect(JSON.stringify(credentials)).not.toContain(SIGNING_KEY)
    expect(inspect(credentials)).not.toContain(SIGNING_KEY)

    now += 60_001
    expect(credentials.verify(grant)).toBeNull()
  })

  test('rejects tampering, overly broad public bases, weak keys, and unsafe TTL values', () => {
    const credentials = new ImageRelayResultCredentials({
      publicBaseUrl: 'https://example.test/image-generation',
      signingKey: SIGNING_KEY,
      now: () => 1_800_000_000_000,
    })
    const grant = credentials.issue('task-1', 'owner')
    expect(credentials.verify(`${grant.slice(0, -1)}0`)).toBeNull()
    expect(() => parseImageRelayPublicBase('http://example.test/image-generation')).toThrow('HTTPS')
    expect(() => parseImageRelayPublicBase('https://example.test/')).toThrow('dedicated path prefix')
    expect(() => new ImageRelayResultCredentials({
      publicBaseUrl: 'https://example.test/image-generation',
      signingKey: 'weak',
    })).toThrow('at least 32 characters')
    expect(() => credentials.resultUrl(grant, 4)).toThrow('output index')
  })

  test('loads only the dedicated relay result slots and redacts diagnostics', () => {
    const credentials = loadImageRelayResultCredentials({
      IMAGE_RELAY_PUBLIC_BASE: 'https://zzyppz.cn/image-generation',
      IMAGE_RELAY_RESULT_SIGNING_KEY: SIGNING_KEY,
      IMAGE_RELAY_RESULT_GRANT_TTL_MS: '120000',
    })
    expect(credentials.toJSON()).toEqual({
      public_base_url: 'https://zzyppz.cn/image-generation',
      grant_ttl_ms: 120_000,
      signing_key: '[REDACTED]',
    })
    expect(() => loadImageRelayResultCredentials({
      IMAGE_RELAY_PUBLIC_BASE: 'https://zzyppz.cn/image-generation',
      IMAGE_RELAY_RESULT_SIGNING_KEY: SIGNING_KEY,
      IMAGE_RELAY_RESULT_GRANT_TTL_MS: '900001',
    })).toThrow('between 1000 and 900000')
  })
})
