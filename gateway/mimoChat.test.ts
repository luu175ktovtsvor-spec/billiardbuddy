import { expect, test } from 'bun:test'
import {
  fetchMimoWithRetry,
  loadMimoAllowedModels,
  MimoRequestError,
  prepareMimoChatBody,
} from './mimoChat'

test('allowlist defaults to mimo-v2.5, takes GW_MIMO_MODEL as primary plus GW_MIMO_MODELS extras, drops invalid', () => {
  expect([...loadMimoAllowedModels({})]).toEqual(['mimo-v2.5'])
  expect([...loadMimoAllowedModels({ GW_MIMO_MODEL: 'mimo-v2.5' })]).toEqual(['mimo-v2.5'])
  expect([...loadMimoAllowedModels({
    GW_MIMO_MODEL: 'mimo-v2.5',
    GW_MIMO_MODELS: 'mimo-v2.5-pro, bad model, future-model',
  })]).toEqual(['mimo-v2.5', 'mimo-v2.5-pro', 'future-model'])
})

test('passes tools/tool_choice/messages through untouched (no native search injection), injects thinking:disabled', () => {
  const input = {
    model: 'mimo-v2.5',
    stream: true,
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  }
  const out = JSON.parse(prepareMimoChatBody(JSON.stringify(input), new Set(['mimo-v2.5']), 'mimo-v2.5').body)
  expect(out.tools).toEqual(input.tools)
  expect(out.tool_choice).toBe('auto')
  expect(out.messages).toEqual(input.messages)
  expect(out.stream).toBe(true)
  expect(out.thinking).toEqual({ type: 'disabled' }) // MiMo 默认关思考(慢 + 与工具不稳定)
})

test('defaults MiMo thinking OFF, but respects an explicit thinking toggle from the client', () => {
  const allowed = new Set(['mimo-v2.5'])
  const dflt = JSON.parse(prepareMimoChatBody(JSON.stringify({ model: 'mimo-v2.5', messages: [] }), allowed, 'mimo-v2.5').body)
  expect(dflt.thinking).toEqual({ type: 'disabled' })
  const on = JSON.parse(prepareMimoChatBody(JSON.stringify({ model: 'mimo-v2.5', thinking: { type: 'enabled' }, messages: [] }), allowed, 'mimo-v2.5').body)
  expect(on.thinking).toEqual({ type: 'enabled' }) // 显式开启不被覆盖
})

test('client cannot bypass the whitelist: unknown or missing model is coerced to the server default', () => {
  const unknown = prepareMimoChatBody(
    JSON.stringify({ model: 'qwen3-coder-plus', messages: [{ role: 'user', content: 'x' }] }),
    new Set(['mimo-v2.5']),
    'mimo-v2.5',
  )
  expect(JSON.parse(unknown.body).model).toBe('mimo-v2.5')

  const missing = prepareMimoChatBody(
    JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    new Set(['mimo-v2.5']),
    'mimo-v2.5',
  )
  expect(JSON.parse(missing.body).model).toBe('mimo-v2.5')
})

test('malformed JSON, non-object body, and non-array tools fail closed', () => {
  expect(() => prepareMimoChatBody('{', new Set(['mimo-v2.5']), 'mimo-v2.5')).toThrow(MimoRequestError)
  expect(() => prepareMimoChatBody('[]', new Set(['mimo-v2.5']), 'mimo-v2.5')).toThrow('模型请求必须是 JSON 对象')
  expect(() => prepareMimoChatBody(
    JSON.stringify({ model: 'mimo-v2.5', tools: {} }),
    new Set(['mimo-v2.5']),
    'mimo-v2.5',
  )).toThrow('模型请求 tools 必须是数组')
})

test('empty server default model fails closed (misconfiguration)', () => {
  expect(() => prepareMimoChatBody(
    JSON.stringify({ model: 'whatever' }),
    new Set<string>(),
    '',
  )).toThrow(MimoRequestError)
})

test('does not retry 429 — the rate limit is surfaced immediately', async () => {
  let calls = 0
  const result = await fetchMimoWithRetry(async () => {
    calls += 1
    return new Response('busy', { status: 429, headers: { 'retry-after': '1' } })
  }, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 })
  expect(result.response.status).toBe(429)
  expect(result.attempts).toBe(1)
  expect(calls).toBe(1)
})

test('retries a 5xx at most once (one extra attempt) then succeeds', async () => {
  const responses = [
    new Response('down', { status: 503 }),
    new Response('ok'),
  ]
  const sleeps: number[] = []
  const result = await fetchMimoWithRetry(async () => responses.shift()!, {
    maxRetries: 1,
    baseDelayMs: 20,
    maxDelayMs: 100,
    sleep: async ms => { sleeps.push(ms) },
    random: () => 0,
  })
  expect(result.response.status).toBe(200)
  expect(result.attempts).toBe(2)
  expect(sleeps).toEqual([20])
})

test('retry does not retry 4xx request errors', async () => {
  let calls = 0
  const result = await fetchMimoWithRetry(async () => {
    calls += 1
    return new Response('bad', { status: 400 })
  }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 })
  expect(result.response.status).toBe(400)
  expect(calls).toBe(1)
})
