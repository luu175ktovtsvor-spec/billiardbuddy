import { expect, test } from 'bun:test'
import {
  fetchQwenWithRetry,
  loadQwenAllowedModels,
  prepareQwenChatBody,
  QwenRequestError,
} from './qwenChat'

test('allowlist takes GW_QWEN_MODEL as primary plus GW_QWEN_MODELS extras, drops invalid', () => {
  expect([...loadQwenAllowedModels({ GW_QWEN_MODEL: 'qwen3-coder-plus' })]).toEqual(['qwen3-coder-plus'])
  expect([...loadQwenAllowedModels({
    GW_QWEN_MODEL: 'qwen3-coder-plus',
    GW_QWEN_MODELS: 'qwen-max, bad model, qwen-plus',
  })]).toEqual(['qwen3-coder-plus', 'qwen-max', 'qwen-plus'])
  expect([...loadQwenAllowedModels({})]).toEqual([])
})

test('allowed model passes through byte-for-byte; tools/tool_choice/messages untouched (no native search injection)', () => {
  const raw = JSON.stringify({
    model: 'qwen3-coder-plus',
    stream: true,
    tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
  })
  expect(prepareQwenChatBody(raw, new Set(['qwen3-coder-plus']), 'qwen3-coder-plus')).toEqual({ body: raw })
})

test('client cannot bypass the whitelist: unknown or missing model is coerced to the server default', () => {
  const unknown = prepareQwenChatBody(
    JSON.stringify({ model: 'mimo-v2.5', messages: [{ role: 'user', content: 'x' }] }),
    new Set(['qwen3-coder-plus']),
    'qwen3-coder-plus',
  )
  expect(JSON.parse(unknown.body).model).toBe('qwen3-coder-plus')

  const missing = prepareQwenChatBody(
    JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    new Set(['qwen3-coder-plus']),
    'qwen3-coder-plus',
  )
  expect(JSON.parse(missing.body).model).toBe('qwen3-coder-plus')
})

test('malformed JSON, non-object body, and non-array tools fail closed', () => {
  expect(() => prepareQwenChatBody('{', new Set(['qwen3-coder-plus']), 'qwen3-coder-plus')).toThrow(QwenRequestError)
  expect(() => prepareQwenChatBody('[]', new Set(['qwen3-coder-plus']), 'qwen3-coder-plus')).toThrow('模型请求必须是 JSON 对象')
  expect(() => prepareQwenChatBody(
    JSON.stringify({ model: 'qwen3-coder-plus', tools: {} }),
    new Set(['qwen3-coder-plus']),
    'qwen3-coder-plus',
  )).toThrow('模型请求 tools 必须是数组')
})

test('empty server default model fails closed (misconfiguration)', () => {
  expect(() => prepareQwenChatBody(
    JSON.stringify({ model: 'whatever' }),
    new Set<string>(),
    '',
  )).toThrow(QwenRequestError)
})

test('does not retry 429 — the rate limit is surfaced immediately', async () => {
  let calls = 0
  const result = await fetchQwenWithRetry(async () => {
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
  const result = await fetchQwenWithRetry(async () => responses.shift()!, {
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
  const result = await fetchQwenWithRetry(async () => {
    calls += 1
    return new Response('bad', { status: 400 })
  }, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 })
  expect(result.response.status).toBe(400)
  expect(calls).toBe(1)
})
