import { expect, test } from 'bun:test'
import {
  PUBLIC_IMAGE_ENGINE,
  publicImageEngineLabel,
  publicProviderSummary,
  publicTextChannelLabel,
  scrubProviderIdentifiers,
  toPublicProviderView,
} from './publicModelNames'
import type { RuntimeProviderConfig } from './providerConfig'

// 白标铁律否定断言用的真实名/供应商/endpoint 黑名单。
const FORBIDDEN = [
  'seedream',
  'doubao',
  '豆包',
  'gpt-image',
  'gpt_image',
  'claude',
  'anthropic',
  'openai',
  'deepseek',
  '火山',
  '方舟',
  'volc',
  'volces',
  'ark',
  'mimo',
  'glm',
]

function assertClean(text: string): void {
  const lower = text.toLowerCase()
  for (const token of FORBIDDEN) {
    expect(lower).not.toContain(token.toLowerCase())
  }
}

test('scrubProviderIdentifiers 清掉真实模型名', () => {
  const cases = [
    'model doubao-seedream-4-5-251128 not found',
    '使用 gpt-image-2 生成失败',
    'claude-sonnet-4-5 rate limited',
    'anthropic api error',
    'deepseek-chat overloaded',
    'GLM-4.6 timeout',
    'MiMo-VL not available',
    '豆包 Seedream 通道故障，火山方舟返回 429',
  ]
  for (const raw of cases) {
    const out = scrubProviderIdentifiers(raw)
    assertClean(out)
  }
})

test('scrubProviderIdentifiers 清掉供应商 endpoint host', () => {
  const cases = [
    'connect ETIMEDOUT api.anthropic.com:443',
    'HTTP 502 from https://api.openai.com/v1/chat/completions',
    'ark.cn-beijing.volces.com refused connection',
    '429 from ark.cn-beijing.volces.com/api/v3/images/generations',
    'https://api.deepseek.com/v1 unreachable',
  ]
  for (const raw of cases) {
    const out = scrubProviderIdentifiers(raw)
    assertClean(out)
    expect(out).not.toContain('.com')
  }
})

test('scrubProviderIdentifiers 不误伤普通英文词', () => {
  // spark/remark 含 ark 子串,但词边界应放过。
  expect(scrubProviderIdentifiers('a spark of remark')).toBe('a spark of remark')
})

test('publicImageEngineLabel 映射到能力档而非真实名', () => {
  expect(publicImageEngineLabel({ provider: 'seedream-gateway', model: 'doubao-seedream-4-5-251128' })).toBe(
    PUBLIC_IMAGE_ENGINE.realistic,
  )
  expect(publicImageEngineLabel({ provider: 'openai-compatible', model: 'gpt-image-2' })).toBe(
    PUBLIC_IMAGE_ENGINE.creative,
  )
  // 兜底切回 seedream 的 reason 也归写实档。
  expect(
    publicImageEngineLabel({ provider: 'seedream-gateway', reason: 'openai_failed_seedream_fallback' }),
  ).toBe(PUBLIC_IMAGE_ENGINE.realistic)
  assertClean(publicImageEngineLabel({ provider: 'seedream-gateway', model: 'doubao-seedream-4-5-251128' }))
  assertClean(publicImageEngineLabel({ provider: 'openai-compatible', model: 'gpt-image-2' }))
})

test('publicTextChannelLabel 按能力档而非厂商', () => {
  expect(publicTextChannelLabel('high')).toBe('增强(深度思考)')
  expect(publicTextChannelLabel('medium')).toBe('标准')
  expect(publicTextChannelLabel(undefined)).toBe('标准')
})

test('publicProviderSummary 删 baseUrl/model/apiFormat,只留能力档', () => {
  const config: RuntimeProviderConfig = {
    apiFormat: 'openai_chat',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'sk-secret',
    model: 'doubao-seedream-4-5-251128',
    reasoningEffort: 'high',
  }
  const summary = publicProviderSummary(config)
  expect(summary).toEqual({ channel: '增强(深度思考)', hasApiKey: true, hasAuthToken: false })
  const json = JSON.stringify(summary)
  assertClean(json)
  expect(json).not.toContain('sk-secret')
  expect(json).not.toContain('baseUrl')
  expect(json).not.toContain('openai_chat')
})

test('toPublicProviderView 去 baseUrl/model,保留身份', () => {
  const view = toPublicProviderView({
    id: 'p1',
    name: 'My Provider',
    enabled: true,
    model: 'doubao-seedream-4-5-251128',
    reasoningEffort: 'low',
    hasApiKey: true,
    hasAuthToken: false,
  })
  expect(view).toMatchObject({ id: 'p1', name: 'My Provider', enabled: true, channel: '标准', hasApiKey: true })
  const json = JSON.stringify(view)
  assertClean(json)
  expect(json).not.toContain('4-5')
})
