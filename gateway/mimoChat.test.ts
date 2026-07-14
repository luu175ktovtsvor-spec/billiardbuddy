import { expect, test } from 'bun:test'
import {
  fetchMimoWithRetry,
  loadMimoAllowedModels,
  loadMimoNativeSearchConfig,
  MimoRequestError,
  MimoUsageTracker,
  prepareMimoChatBody,
} from './mimoChat'

test('native search defaults to 5x5 and clamps server configuration', () => {
  expect(loadMimoNativeSearchConfig({ GW_MIMO_NATIVE_WEB_SEARCH: '1' })).toEqual({
    enabled: true,
    maxKeyword: 5,
    limit: 5,
  })
  expect(loadMimoNativeSearchConfig({
    GW_MIMO_NATIVE_WEB_SEARCH: '1',
    GW_MIMO_WEB_SEARCH_MAX_KEYWORD: '50',
    GW_MIMO_WEB_SEARCH_LIMIT: '50',
  })).toEqual({ enabled: true, maxKeyword: 5, limit: 5 })
})

test('model allowlist defaults to mimo-v2.5 and supports explicit future models', () => {
  expect([...loadMimoAllowedModels({})]).toEqual(['mimo-v2.5'])
  expect([...loadMimoAllowedModels({ GW_MIMO_MODELS: 'mimo-v2.5, future-model, bad model' })]).toEqual([
    'mimo-v2.5',
    'future-model',
  ])
})

test('native search injection preserves function tools and leaves disabled requests byte-for-byte unchanged', () => {
  const raw = JSON.stringify({
    model: 'mimo-v2.5',
    stream: true,
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
  })
  expect(prepareMimoChatBody(raw, { enabled: false, maxKeyword: 5, limit: 5 }, new Set(['mimo-v2.5']))).toEqual({
    body: raw,
    nativeSearchAvailable: false,
  })

  const prepared = prepareMimoChatBody(raw, { enabled: true, maxKeyword: 5, limit: 5 }, new Set(['mimo-v2.5']))
  const body = JSON.parse(prepared.body)
  expect(prepared.nativeSearchAvailable).toBe(true)
  expect(body.tools).toEqual([
    { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
    { type: 'web_search', max_keyword: 5, force_search: false, limit: 5 },
  ])
})

test('native search does not duplicate tools and enforces cost controls', () => {
  const prepared = prepareMimoChatBody(JSON.stringify({
    model: 'mimo-v2.5-pro',
    tools: [{ type: 'web_search', max_keyword: 20, force_search: true, limit: 30, user_location: { city: 'Wuhan' } }],
  }), { enabled: true, maxKeyword: 5, limit: 5 }, new Set(['mimo-v2.5', 'mimo-v2.5-pro']))
  const body = JSON.parse(prepared.body)
  expect(body.tools).toEqual([{
    type: 'web_search',
    max_keyword: 5,
    force_search: false,
    limit: 5,
    user_location: { city: 'Wuhan' },
  }])
})

test('unsupported models and malformed JSON fail closed', () => {
  const raw = '{"model":"other-model","tools":[]}'
  expect(() => prepareMimoChatBody(raw, { enabled: true, maxKeyword: 5, limit: 5 }, new Set(['mimo-v2.5']))).toThrow('当前模型不可用')
  expect(() => prepareMimoChatBody('{', { enabled: true, maxKeyword: 5, limit: 5 }, new Set(['mimo-v2.5']))).toThrow(MimoRequestError)
  expect(() => prepareMimoChatBody('{"model":"mimo-v2.5","tools":{}}', {
    enabled: true,
    maxKeyword: 5,
    limit: 5,
  }, new Set(['mimo-v2.5']))).toThrow('模型请求 tools 必须是数组')
})

test('MiMo retry respects Retry-After and retries 5xx before succeeding', async () => {
  const responses = [
    new Response('busy', { status: 429, headers: { 'retry-after': '1' } }),
    new Response('down', { status: 503 }),
    new Response('ok'),
  ]
  const sleeps: number[] = []
  const result = await fetchMimoWithRetry(async () => responses.shift()!, {
    maxRetries: 3,
    baseDelayMs: 20,
    maxDelayMs: 100,
    sleep: async ms => { sleeps.push(ms) },
    random: () => 0,
  })
  expect(result.response.status).toBe(200)
  expect(result.attempts).toBe(3)
  expect(sleeps).toEqual([1000, 40])
})

test('MiMo retry does not retry request errors', async () => {
  let calls = 0
  const result = await fetchMimoWithRetry(async () => {
    calls += 1
    return new Response('bad', { status: 400 })
  }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 })
  expect(result.response.status).toBe(400)
  expect(calls).toBe(1)
})

test('usage tracker reads split SSE search usage without storing query text', () => {
  const tracker = new MimoUsageTracker()
  const bytes = new TextEncoder().encode('data: {"usage":{"web_search_usage":{"tool_usage":5,"page_usage":12}}}\n\ndata: [DONE]\n\n')
  tracker.observe(bytes.slice(0, 17))
  tracker.observe(bytes.slice(17))
  expect(tracker.finish()).toEqual({ toolUsage: 5, pageUsage: 12 })
})
