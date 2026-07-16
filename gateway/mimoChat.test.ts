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

test('allowed model passes through byte-for-byte; tools/tool_choice/messages untouched (no native search injection)', () => {
  const raw = JSON.stringify({
    model: 'mimo-v2.5',
    stream: true,
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(prepareMimoChatBody(raw, new Set(['mimo-v2.5']), 'mimo-v2.5')).toEqual({ body: raw })
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

test('retry respects Retry-After and retries 5xx before succeeding', async () => {
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

test('retry does not retry 4xx request errors', async () => {
  let calls = 0
  const result = await fetchMimoWithRetry(async () => {
    calls += 1
    return new Response('bad', { status: 400 })
  }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 })
  expect(result.response.status).toBe(400)
  expect(calls).toBe(1)
})
