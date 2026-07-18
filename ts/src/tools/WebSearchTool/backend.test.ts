import { describe, expect, test } from 'bun:test'
import {
  getProductWebSearchProxyUrl,
  isLikelyClaudeModel,
  isWebSearchEnabledForModel,
  resolveWebSearchProvider,
  searchWithExternalProvider,
  searchWithProductGateway,
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
      }, { productGatewayUrl: null }).provider,
    ).toBe('anthropic')
  })

  test('auto mode keeps WebSearch available for non-Claude models with fallback keys', () => {
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
        braveApiKey: 'brave-key',
      }, { productGatewayUrl: null }).provider,
    ).toBe('tavily')

    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'auto',
        braveApiKey: 'brave-key',
      }, { productGatewayUrl: null }).provider,
    ).toBe('brave')
  })

  test('explicit provider modes require their API key', () => {
    expect(resolveWebSearchProvider('gpt-5.4', { mode: 'tavily' }, { productGatewayUrl: null }).provider).toBe(
      'disabled',
    )
    expect(
      resolveWebSearchProvider('gpt-5.4', {
        mode: 'brave',
        braveApiKey: 'brave-key',
      }, { productGatewayUrl: null }).provider,
    ).toBe('brave')
  })

  test('isEnabled reflects native Claude or external fallback availability', () => {
    expect(isWebSearchEnabledForModel('claude-sonnet-4-5', { mode: 'auto' }, { productGatewayUrl: null })).toBe(
      true,
    )
    expect(
      isWebSearchEnabledForModel('qwen3-coder', {
        mode: 'auto',
        tavilyApiKey: 'tvly-key',
      }, { productGatewayUrl: null }),
    ).toBe(true)
    expect(isWebSearchEnabledForModel('qwen3-coder', { mode: 'auto' }, { productGatewayUrl: null })).toBe(
      false,
    )
  })

  test('managed runtime resolves only the exact loopback qf route and does not silently use user keys', () => {
    const productUrl = getProductWebSearchProxyUrl(
      'http://127.0.0.1:4599/proxy/providers/qf-gateway',
    )
    expect(productUrl).toBe('http://127.0.0.1:4599/proxy/providers/qf-gateway/v1/web_search')
    expect(getProductWebSearchProxyUrl('https://gateway.example/proxy/providers/qf-gateway')).toBeNull()
    expect(getProductWebSearchProxyUrl('http://127.0.0.1:4599/proxy/providers/other')).toBeNull()

    const resolved = resolveWebSearchProvider('deepseek-v4-flash', {
      mode: 'auto',
      tavilyApiKey: 'tvly-user-key',
      braveApiKey: 'brave-user-key',
    }, { productGatewayUrl: productUrl })
    expect(resolved).toMatchObject({ provider: 'product', productGatewayUrl: productUrl })

    // Legacy local provider choices are ignored in the managed desktop runtime.
    // A gateway failure is therefore reported rather than silently switching
    // upstream.
    expect(resolveWebSearchProvider('deepseek-v4-flash', {
      mode: 'brave',
      braveApiKey: 'brave-user-key',
    }, { productGatewayUrl: productUrl }).provider).toBe('product')

    expect(resolveWebSearchProvider('deepseek-v4-flash', {
      mode: 'disabled',
      braveApiKey: 'brave-user-key',
    }, { productGatewayUrl: productUrl }).provider).toBe('disabled')
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
        allowed_domains: ['Example.com'],
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
      { query: '球房经营', blocked_domains: ['spam.example', 'spam.example'] },
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
      { query: '球房经营', blocked_domains: ['bad path'] },
      'brave-secret',
      signal,
      async () => Response.json({ web: { results: [] } }),
    )).rejects.toThrow('Web search domain filters are invalid.')

    await expect(searchWithExternalProvider(
      'brave',
      { query: '失败' },
      'brave-secret',
      signal,
      async () => new Response('x'.repeat(800), { status: 503 }),
    )).rejects.toThrow('Web search is temporarily unavailable. Please try again.')
  })

  test('product gateway search sends no credential, clamps output, and redacts proxy failures', async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    const output = await searchWithProductGateway(
      { query: ' 球房经营 ', allowed_domains: ['example.com'] },
      new AbortController().signal,
      'http://127.0.0.1:4599/proxy/providers/qf-gateway/v1/web_search',
      async (input, init) => {
        captured = { url: String(input), init }
        return Response.json({
          results: [
            { title: '公开结果', url: 'https://example.com/guide', snippet: 'safe' },
            { title: '坏协议', url: 'javascript:alert(1)' },
            ...Array.from({ length: 10 }, (_, index) => ({
              title: `结果 ${index}`,
              url: `https://example.com/${index}`,
            })),
          ],
          token: 'must-not-flow-through',
        })
      },
    )
    expect(captured?.url).toBe('http://127.0.0.1:4599/proxy/providers/qf-gateway/v1/web_search')
    expect(captured?.init?.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      query: '球房经营',
      allowed_domains: ['example.com'],
    })
    const result = output.results[1]
    expect(typeof result).toBe('object')
    if (result && typeof result === 'object') {
      expect(result.content).toHaveLength(8)
    }
    expect(JSON.stringify(output)).not.toContain('must-not-flow-through')

    await expect(searchWithProductGateway(
      { query: '球房经营' },
      new AbortController().signal,
      'http://127.0.0.1:4599/proxy/providers/qf-gateway/v1/web_search',
      async () => new Response('gateway token=qf-secret', { status: 503 }),
    )).rejects.toThrow('Web search is temporarily unavailable. Please try again.')
  })
})
