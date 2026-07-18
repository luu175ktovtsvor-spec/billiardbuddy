import { expect, test } from 'bun:test'
import {
  createGatewayWebSearch,
  GatewayWebSearchError,
  parseGatewayWebSearchInput,
} from './webSearch'

test('gateway web search validates the small public input contract before contacting Brave', () => {
  expect(parseGatewayWebSearchInput({
    query: ' 台球赛事 ',
    allowed_domains: ['example.com', 'example.com'],
  })).toEqual({
    query: '台球赛事',
    allowed_domains: ['example.com'],
  })

  for (const input of [
    { query: 'x' },
    { query: 'valid', allowed_domains: ['https://example.com/path'] },
    { query: 'valid', allowed_domains: ['example.com'], blocked_domains: ['spam.example'] },
    { query: 'valid', provider: 'other' },
  ]) {
    expect(() => parseGatewayWebSearchInput(input)).toThrow(GatewayWebSearchError)
  }
})

test('gateway Brave adapter sends its key only upstream and filters to eight public http(s) results', async () => {
  let captured: { url: string; init?: RequestInit } | null = null
  const search = createGatewayWebSearch({
    GW_WEBSEARCH_PROVIDER: 'brave',
    GW_WEBSEARCH_KEY: 'brave-secret-value',
    GW_WEBSEARCH_BASE: 'https://search.example/res/v1/web/search',
  }, async (input, init) => {
    captured = { url: String(input), init }
    return Response.json({
      web: {
        results: [
          { title: ' <b>安全结果</b> ', url: 'https://docs.example.com/a', description: '<em>描述</em>' },
          { title: '坏协议', url: 'file:///etc/passwd', description: 'bad' },
          { title: '带密码', url: 'https://user:password@docs.example.com/private', description: 'bad' },
          ...Array.from({ length: 10 }, (_, index) => ({
            title: `结果 ${index}`,
            url: `https://docs.example.com/${index}`,
          })),
        ],
      },
    })
  })

  expect(search).not.toBeNull()
  const response = await search!({ query: 'Bun runtime', allowed_domains: ['example.com'] })
  expect(captured?.url).toContain('https://search.example/res/v1/web/search?q=Bun+runtime')
  expect((captured?.init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-secret-value')
  expect(response.results).toHaveLength(8)
  expect(response.results[0]).toEqual({
    title: '安全结果',
    url: 'https://docs.example.com/a',
    snippet: '描述',
  })
})

test('gateway web search keeps upstream failures opaque', async () => {
  const search = createGatewayWebSearch({
    GW_WEBSEARCH_PROVIDER: 'brave',
    GW_WEBSEARCH_KEY: 'brave-secret-value',
  }, async () => new Response('upstream key=brave-secret-value', { status: 503 }))

  await expect(search!({ query: 'Bun runtime' })).rejects.toMatchObject({
    status: 502,
    publicMessage: '联网搜索暂时不可用，请稍后重试',
  })
})
