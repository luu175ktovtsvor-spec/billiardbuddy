import { describe, expect, test } from 'bun:test'
import {
  isLikelyClaudeModel,
  isWebSearchEnabledForModel,
  resolveWebSearchProvider,
  searchWithExternalProvider,
  shouldFallbackFromNativeError,
} from './backend.js'

describe('WebSearch backend resolver', () => {
  test('detects Claude models by model name instead of provider URL', () => {
    expect(isLikelyClaudeModel('claude-sonnet-4-5')).toBe(true)
    expect(isLikelyClaudeModel('anthropic/claude-3-7-sonnet')).toBe(true)
    expect(isLikelyClaudeModel('anthropic.claude-opus-4-1')).toBe(true)
    expect(isLikelyClaudeModel('MiniMax-M2.7-highspeed')).toBe(false)
  })

  test('auto mode prefers native Anthropic web search for Claude model names', () => {
    expect(
      resolveWebSearchProvider('anthropic/claude-3-7-sonnet', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('anthropic')
  })

  test('auto mode keeps WebSearch available for non-Claude models with fallback keys', () => {
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('tavily')

    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('brave')
  })

  test('explicit provider modes require their API key', () => {
    expect(resolveWebSearchProvider('gpt-5.4', { mode: 'tavily' }).provider).toBe(
      'disabled',
    )
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'brave',
        braveApiKey: 'brave-key',
      }).provider,
    ).toBe('brave')
  })

  test('isEnabled reflects native Claude or external fallback availability', () => {
    expect(isWebSearchEnabledForModel('claude-sonnet-4-5', { mode: 'auto' })).toBe(
      true,
    )
    expect(
      isWebSearchEnabledForModel('qwen3-coder', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
      }),
    ).toBe(true)
    expect(isWebSearchEnabledForModel('qwen3-coder', { mode: 'auto' })).toBe(
      false,
    )
  })

  test('falls back on native tool schema/provider mismatch errors', () => {
    expect(
      shouldFallbackFromNativeError(
        new Error('422 Extra inputs are not permitted: web_search_20250305'),
      ),
    ).toBe(true)
    expect(shouldFallbackFromNativeError(new Error('network timeout'))).toBe(
      false,
    )
  })

  test('Tavily sends bounded filters and drops unsafe result URLs', async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    const output = await searchWithExternalProvider(
      'tavily',
      {
        query: '台球赛事',
        allowed_domains: ['Example.com', 'bad.example OR site:evil.test'],
      },
      'tvly-secret',
      new AbortController().signal,
      async (input, init) => {
        captured = { url: String(input), init }
        return Response.json({
          results: [
            { title: '  正常结果  ', url: 'https://example.com/a' },
            { title: '危险结果', url: 'javascript:alert(1)' },
          ],
        })
      },
    )
    expect(captured?.url).toBe('https://api.tavily.com/search')
    expect((captured?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tvly-secret')
    expect(JSON.parse(String(captured?.init?.body))).toMatchObject({ include_domains: ['example.com'] })
    expect(output.results[1]).toMatchObject({ content: [{ title: '正常结果', url: 'https://example.com/a' }] })
  })

  test('Brave encodes normalized allow/block filters and surfaces bounded errors', async () => {
    const calls: string[] = []
    const signal = new AbortController().signal
    const output = await searchWithExternalProvider(
      'brave',
      { query: '球房经营', blocked_domains: ['spam.example', 'spam.example', 'bad path'] },
      'brave-secret',
      signal,
      async (input, init) => {
        calls.push(String(input))
        expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-secret')
        return Response.json({ web: { results: [{ title: '经营建议', url: 'https://guide.example/post' }] } })
      },
    )
    expect(calls[0]).toContain('q=-site%3Aspam.example+%E7%90%83%E6%88%BF%E7%BB%8F%E8%90%A5')
    expect(output.results[1]).toMatchObject({ content: [{ title: '经营建议' }] })

    await expect(searchWithExternalProvider(
      'brave',
      { query: '失败' },
      'brave-secret',
      signal,
      async () => new Response('x'.repeat(800), { status: 503 }),
    )).rejects.toThrow(/^Brave search failed: 503 x{500}$/)
  })
})
