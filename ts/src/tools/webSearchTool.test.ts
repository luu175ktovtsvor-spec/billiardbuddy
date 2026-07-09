import { expect, test } from 'bun:test'
import { applyDomainFilters, normalizeHits, runWebSearch, webSearchTool } from './webSearchTool'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

test('runWebSearch returns an unavailable notice when the gateway is not configured', async () => {
  const out = await runWebSearch({ query: 'bun test runner' }, {}, {})
  expect(out).toContain('status="unavailable"')
  expect(out).toContain('bun test runner')
})

test('runWebSearch routes through the gateway with a bearer token and returns formatted hits', async () => {
  let seenUrl = ''
  let seenAuth = ''
  let seenBody: Record<string, unknown> = {}
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seenUrl = url
    seenAuth = String((init.headers as Record<string, string>).Authorization)
    seenBody = JSON.parse(String(init.body))
    return jsonResponse({ results: [{ title: 'Bun docs', url: 'https://bun.sh/docs', snippet: 'fast runtime' }] })
  }) as unknown as typeof fetch

  const out = await runWebSearch(
    { query: 'bun', allowed_domains: ['bun.sh'] },
    { QF_GATEWAY_URL: 'https://gw.example', QF_GATEWAY_TOKEN: 'secret-token' },
    { fetchImpl },
  )
  expect(seenUrl).toBe('https://gw.example/v1/web_search')
  expect(seenAuth).toBe('Bearer secret-token')
  expect(seenBody.query).toBe('bun')
  expect(seenBody.allowed_domains).toEqual(['bun.sh'])
  expect(out).toContain('Bun docs')
  expect(out).toContain('https://bun.sh/docs')
  // 关键:token 绝不出现在返回给模型的结果里。
  expect(out).not.toContain('secret-token')
})

test('runWebSearch degrades gracefully (no throw) when the gateway errors', async () => {
  const fetchImpl = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  const out = await runWebSearch(
    { query: 'x' },
    { QF_GATEWAY_URL: 'https://gw.example', QF_GATEWAY_TOKEN: 't' },
    { fetchImpl },
  )
  expect(out).toContain('status="unavailable"')
  expect(out).toContain('network down')
})

test('normalizeHits accepts several backend shapes', () => {
  expect(normalizeHits({ results: [{ title: 'A', url: 'https://a.com' }] })).toEqual([{ title: 'A', url: 'https://a.com' }])
  expect(normalizeHits({ data: [{ name: 'B', link: 'https://b.com', description: 'd' }] })).toEqual([{ title: 'B', url: 'https://b.com', snippet: 'd' }])
  expect(normalizeHits({ web: { results: [{ url: 'https://c.com' }] } })).toEqual([{ title: 'https://c.com', url: 'https://c.com' }])
  expect(normalizeHits([{ href: 'https://d.com', heading: 'D' }])).toEqual([{ title: 'D', url: 'https://d.com' }])
  expect(normalizeHits({ nope: 1 })).toEqual([])
})

test('applyDomainFilters honors allowed/blocked domains', () => {
  const hits = [
    { title: '1', url: 'https://a.com/x' },
    { title: '2', url: 'https://www.b.com/y' },
    { title: '3', url: 'https://sub.c.com/z' },
  ]
  expect(applyDomainFilters(hits, { query: 'q', allowed_domains: ['b.com'] }).map(h => h.url)).toEqual(['https://www.b.com/y'])
  expect(applyDomainFilters(hits, { query: 'q', blocked_domains: ['a.com'] }).map(h => h.url)).toEqual(['https://www.b.com/y', 'https://sub.c.com/z'])
  expect(applyDomainFilters(hits, { query: 'q', allowed_domains: ['c.com'] }).map(h => h.url)).toEqual(['https://sub.c.com/z'])
})

test('webSearchTool rejects empty queries', async () => {
  await expect(webSearchTool.execute({ query: '  ' }, { workspace: undefined as never })).rejects.toThrow(/query/)
})
