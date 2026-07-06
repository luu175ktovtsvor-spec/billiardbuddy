import { expect, test } from 'bun:test'
import { providerConfigFromEnv, redactedProviderSummary } from './providerConfig'

test('providerConfigFromEnv:兼容 bundled.env 的 OpenAI-compatible 网关变量', () => {
  const cfg = providerConfigFromEnv({
    DEEPSEEK_BASE_URL: 'http://gw.example/gw/v1',
    DEEPSEEK_API_KEY: 'secret',
    TEXT_MODEL_NAME: 'mimo-v2.5',
    REASONING_EFFORT: 'max',
    NETWORK_PROXY_MODE: 'system',
  })
  expect(cfg).toMatchObject({
    apiFormat: 'openai_chat',
    baseUrl: 'http://gw.example/gw/v1',
    apiKey: 'secret',
    model: 'mimo-v2.5',
    reasoningEffort: 'high',
    networkSettings: { proxy: { mode: 'system' } },
  })
})

test('providerConfigFromEnv:识别 Anthropic-compatible 直连配置', () => {
  const cfg = providerConfigFromEnv({
    ANTHROPIC_BASE_URL: 'https://api.example/anthropic/v1/',
    ANTHROPIC_AUTH_TOKEN: 'token',
    ANTHROPIC_AUTH_STRATEGY: 'auth_token',
    ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    ANTHROPIC_MAX_TOKENS: '2048',
  })
  expect(cfg).toMatchObject({
    apiFormat: 'anthropic',
    baseUrl: 'https://api.example/anthropic/v1',
    authToken: 'token',
    authStrategy: 'auth_token',
    model: 'claude-sonnet-4-6',
    maxTokens: 2048,
  })
})

test('redactedProviderSummary 不泄露 key', () => {
  const cfg = providerConfigFromEnv({
    OPENAI_BASE_URL: 'https://api.example/v1',
    OPENAI_API_KEY: 'secret',
    TEXT_MODEL_NAME: 'm',
  })!
  expect(JSON.stringify(redactedProviderSummary(cfg))).not.toContain('secret')
  expect(redactedProviderSummary(cfg).hasApiKey).toBe(true)
  expect(redactedProviderSummary(cfg).networkProxyMode).toBe('direct')
})
