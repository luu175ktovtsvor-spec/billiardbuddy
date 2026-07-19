import { describe, expect, test } from 'bun:test'
import {
  isDeepSeekAnthropicBaseUrl,
  isLikelyClaudeModel,
  isManagedDeepSeekAnthropicProxyUrl,
  isNativeWebSearchProtocolMismatch,
  isWebSearchEnabledForModel,
  markAnthropicNativeUnsupported,
  resolveWebSearchProvider,
} from './backend.js'

describe('WebSearch backend resolver', () => {
  test('detects Claude models by name without trusting an arbitrary provider URL', () => {
    expect(isLikelyClaudeModel('claude-sonnet-4-5')).toBe(true)
    expect(isLikelyClaudeModel('anthropic/claude-3-7-sonnet')).toBe(true)
    expect(isLikelyClaudeModel('MiniMax-M2.7-highspeed')).toBe(false)
  })

  test('uses only documented direct DeepSeek Anthropic and managed QF transports', () => {
    expect(isDeepSeekAnthropicBaseUrl('https://api.deepseek.com/anthropic')).toBe(true)
    expect(isDeepSeekAnthropicBaseUrl('https://api.deepseek.com/anthropic/')).toBe(true)
    expect(isDeepSeekAnthropicBaseUrl('https://api.deepseek.com/v1')).toBe(false)
    expect(isDeepSeekAnthropicBaseUrl('http://api.deepseek.com/anthropic')).toBe(false)

    const managed = 'http://127.0.0.1:4599/proxy/providers/qf-gateway'
    expect(isManagedDeepSeekAnthropicProxyUrl(managed)).toBe(true)
    expect(isManagedDeepSeekAnthropicProxyUrl('http://127.0.0.1:4599/proxy/providers/other')).toBe(false)
    expect(isManagedDeepSeekAnthropicProxyUrl('https://gateway.example/proxy/providers/qf-gateway')).toBe(false)
  })

  test('enables the default managed DeepSeek route and never falls back to external keys', () => {
    const managed = 'http://127.0.0.1:4599/proxy/providers/qf-gateway'
    expect(resolveWebSearchProvider('deepseek-v4-flash', { enabled: true }, {
      anthropicBaseUrl: managed,
    }).provider).toBe('anthropic')
    expect(resolveWebSearchProvider('deepseek-v4-flash', { enabled: true }, {
      anthropicBaseUrl: 'https://example.invalid/anthropic',
    }).provider).toBe('disabled')
    expect(resolveWebSearchProvider('qwen3-coder-plus', { enabled: true }, {
      anthropicBaseUrl: managed,
    }).provider).toBe('disabled')
    expect(resolveWebSearchProvider('deepseek-v4-flash', { enabled: false }, {
      anthropicBaseUrl: managed,
    }).provider).toBe('disabled')
  })

  test('keeps a native protocol mismatch fail-closed for that model', () => {
    const model = 'deepseek-v4-web-search-test'
    const options = { anthropicBaseUrl: 'https://api.deepseek.com/anthropic' }
    expect(resolveWebSearchProvider(model, { enabled: true }, options).provider).toBe('anthropic')
    markAnthropicNativeUnsupported(model)
    expect(resolveWebSearchProvider(model, { enabled: true }, options).provider).toBe('disabled')
    expect(isNativeWebSearchProtocolMismatch(
      new Error('422 Extra inputs are not permitted: web_search_20250305'),
    )).toBe(true)
    expect(isNativeWebSearchProtocolMismatch(new Error('network timeout'))).toBe(false)
  })

  test('reports availability from the native route and the product toggle only', () => {
    expect(isWebSearchEnabledForModel('claude-sonnet-4-5', { enabled: true })).toBe(true)
    expect(isWebSearchEnabledForModel('qwen3-coder', { enabled: true })).toBe(false)
    expect(isWebSearchEnabledForModel('deepseek-v4-flash', { enabled: false }, {
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
    })).toBe(false)
  })
})
