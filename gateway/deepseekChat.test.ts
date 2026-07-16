import { expect, test } from 'bun:test'
import {
  deepseekOpaqueUserId,
  fetchDeepSeekWithRetry,
  loadDeepSeekAllowedModels,
  prepareDeepSeekChatBody,
  DeepSeekRequestError,
} from './deepseekChat'

test('allowed models always include the default deepseek-v4-flash even without a key', () => {
  expect(loadDeepSeekAllowedModels({}).has('deepseek-v4-flash')).toBe(true)
  const set = loadDeepSeekAllowedModels({ GW_DEEPSEEK_MODEL: 'deepseek-v4-flash', GW_DEEPSEEK_MODELS: 'deepseek-chat, deepseek-reasoner' })
  expect([...set].sort()).toEqual(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'])
})

test('prepareBody coerces an off-whitelist model to the default (no cross-provider escape)', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  const { body } = prepareDeepSeekChatBody(JSON.stringify({ model: 'gpt-4o', messages: [] }), allowed, 'deepseek-v4-flash')
  expect(JSON.parse(body).model).toBe('deepseek-v4-flash')
})

test('prepareBody injects the trusted opaque user_id, dropping any client-sent user/user_id', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  const { body } = prepareDeepSeekChatBody(
    JSON.stringify({ model: 'deepseek-v4-flash', user: 'attacker-spoofed', user_id: 'also-spoofed', messages: [] }),
    allowed,
    'deepseek-v4-flash',
    { userId: 'bb_trusted' },
  )
  const parsed = JSON.parse(body)
  expect(parsed.user_id).toBe('bb_trusted') // official DeepSeek field
  expect(parsed.user).toBeUndefined() // OpenAI-style field removed
})

test('prepareBody passes the thinking toggle and reasoning fields through untouched', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  const { body } = prepareDeepSeekChatBody(
    JSON.stringify({ model: 'deepseek-v4-flash', thinking: { type: 'enabled' }, reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }] }),
    allowed,
    'deepseek-v4-flash',
    { userId: 'bb_x' },
  )
  const parsed = JSON.parse(body)
  expect(parsed.thinking).toEqual({ type: 'enabled' })
  expect(parsed.reasoning_effort).toBe('high')
})

test('prepareBody rejects non-JSON and non-object and bad tools', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  expect(() => prepareDeepSeekChatBody('not json', allowed, 'deepseek-v4-flash')).toThrow(DeepSeekRequestError)
  expect(() => prepareDeepSeekChatBody('[]', allowed, 'deepseek-v4-flash')).toThrow(DeepSeekRequestError)
  expect(() => prepareDeepSeekChatBody(JSON.stringify({ model: 'deepseek-v4-flash', tools: {} }), allowed, 'deepseek-v4-flash')).toThrow(DeepSeekRequestError)
})

test('opaque user id is stable, prefixed, privacy-free, and differs per install', () => {
  const a1 = deepseekOpaqueUserId('beta', 'install-0001')
  const a2 = deepseekOpaqueUserId('beta', 'install-0001')
  const b = deepseekOpaqueUserId('beta', 'install-0002')
  expect(a1).toBe(a2) // stable
  expect(a1).toStartWith('bb_')
  expect(a1).not.toContain('install-0001') // one-way hash, no raw id
  expect(a1).not.toBe(b) // per-install isolation
})

test('does not retry 429 — surfaces the rate limit immediately', async () => {
  let calls = 0
  const result = await fetchDeepSeekWithRetry(async () => {
    calls += 1
    return new Response('busy', { status: 429, headers: { 'retry-after': '1' } })
  }, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 })
  expect(result.response.status).toBe(429)
  expect(result.attempts).toBe(1)
  expect(calls).toBe(1)
})

test('retries a 5xx at most once (one extra attempt) then succeeds', async () => {
  const responses = [new Response('down', { status: 503 }), new Response('ok')]
  const sleeps: number[] = []
  const result = await fetchDeepSeekWithRetry(async () => responses.shift()!, {
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

test('does not retry 4xx request errors', async () => {
  let calls = 0
  const result = await fetchDeepSeekWithRetry(async () => {
    calls += 1
    return new Response('bad', { status: 400 })
  }, { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 })
  expect(result.response.status).toBe(400)
  expect(calls).toBe(1)
})
