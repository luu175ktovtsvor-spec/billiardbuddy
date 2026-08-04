import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  loadRelayProviderCredentials,
  parseRelayHttpsBaseUrl,
} from './providerCredentials'

describe('Relay provider credentials', () => {
  test('将 OpenAI 和 Seedream 的 key 保持在命名 slot 内并在诊断输出中脱敏', () => {
    const openaiKey = 'super-secret-openai-key'
    const seedreamKey = 'super-secret-seedream-key'
    const credentials = loadRelayProviderCredentials({
      RELAY_OPENAI_KEY: openaiKey,
      RELAY_ARK_KEY: seedreamKey,
    })
    const diagnostic = `${JSON.stringify(credentials)}\n${inspect(credentials)}`

    expect(diagnostic).toContain('RELAY_OPENAI_KEY')
    expect(diagnostic).toContain('RELAY_ARK_KEY')
    expect(diagnostic).not.toContain(openaiKey)
    expect(diagnostic).not.toContain(seedreamKey)
    expect(credentials.bearerAuthorization('openai')).toBe(`Bearer ${openaiKey}`)
    expect(credentials.baseUrl('seedream')).toBe('https://ark.cn-beijing.volces.com/api/v3')
  })

  test('provider base URL 必须为没有认证信息或查询参数的 HTTPS URL', () => {
    expect(parseRelayHttpsBaseUrl('https://provider.example.test/v1/', 'RELAY_OPENAI_BASE', 'https://fallback.example.test'))
      .toBe('https://provider.example.test/v1')
    for (const value of [
      'http://provider.example.test/v1',
      'https://key@provider.example.test/v1',
      'https://provider.example.test/v1?key=leak',
      'not a URL',
    ]) {
      expect(() => parseRelayHttpsBaseUrl(value, 'RELAY_OPENAI_BASE', 'https://fallback.example.test'))
        .toThrow('RELAY_OPENAI_BASE')
    }
  })
})
