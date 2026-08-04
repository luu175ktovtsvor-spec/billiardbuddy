import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  loadGatewayProviderCredentials,
  parseGatewayHttpsBaseUrl,
} from './providerCredentials'

describe('Gateway provider credentials', () => {
  test('只承载已命名 Provider slot，序列化与 inspect 均不泄露 key', () => {
    const secret = 'super-secret-deepseek-key'
    const credentials = loadGatewayProviderCredentials({
      GW_DEEPSEEK_KEY: secret,
      GW_MIMO_KEY: 'mimo-key',
      GW_QWEN_KEY: 'qwen-key',
      GW_FUNASR_KEY: 'funasr-key',
    })
    const rendered = `${JSON.stringify(credentials)}\n${inspect(credentials)}`

    expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain('mimo-key')
    expect(rendered).toContain('GW_DEEPSEEK_KEY')
    expect(credentials.bearerAuthorization('deepseek')).toBe(`Bearer ${secret}`)
    expect(credentials.baseUrl('qwen')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
  })

  test('只接受无认证信息、无查询串的 HTTPS base URL', () => {
    expect(parseGatewayHttpsBaseUrl('https://provider.example.test/v1/', 'GW_DEEPSEEK_BASE', 'https://fallback.example.test'))
      .toBe('https://provider.example.test/v1')
    for (const value of [
      'http://provider.example.test/v1',
      'https://key@provider.example.test/v1',
      'https://provider.example.test/v1?token=nope',
      'not a url',
    ]) {
      expect(() => parseGatewayHttpsBaseUrl(value, 'GW_DEEPSEEK_BASE', 'https://fallback.example.test'))
        .toThrow('GW_DEEPSEEK_BASE')
    }
  })
})
