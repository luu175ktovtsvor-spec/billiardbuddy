import { expect, test } from 'bun:test'
import {
  DEEPSEEK_NATIVE_WEB_SEARCH_TOOL_TYPE,
  deepSeekAnthropicMessagesUrl,
  deepseekOpaqueUserId,
  fetchDeepSeekWithRetry,
  isDeepSeekNativeWebSearchRequest,
  loadDeepSeekAllowedModels,
  prepareDeepSeekAnthropicWebSearchBody,
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

test('prepareBody normalizes Core adaptive thinking and preserves DeepSeek reasoning effort', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  const { body } = prepareDeepSeekChatBody(
    JSON.stringify({ model: 'deepseek-v4-flash', thinking: { type: 'adaptive' }, reasoning_effort: 'high', messages: [{ role: 'user', content: 'hi' }] }),
    allowed,
    'deepseek-v4-flash',
    { userId: 'bb_x' },
  )
  const parsed = JSON.parse(body)
  expect(parsed.thinking).toEqual({ type: 'enabled' })
  expect(parsed.reasoning_effort).toBe('high')
})

test('prepareBody preserves supported DeepSeek thinking values and rejects unknown ones before upstream', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  for (const type of ['enabled', 'disabled']) {
    const { body } = prepareDeepSeekChatBody(
      JSON.stringify({ model: 'deepseek-v4-flash', thinking: { type }, messages: [] }),
      allowed,
      'deepseek-v4-flash',
    )
    expect(JSON.parse(body).thinking).toEqual({ type })
  }
  expect(() => prepareDeepSeekChatBody(
    JSON.stringify({ model: 'deepseek-v4-flash', thinking: { type: 'maximum' }, messages: [] }),
    allowed,
    'deepseek-v4-flash',
  )).toThrow(DeepSeekRequestError)
})

test('prepareBody rejects non-JSON and non-object and bad tools', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  expect(() => prepareDeepSeekChatBody('not json', allowed, 'deepseek-v4-flash')).toThrow(DeepSeekRequestError)
  expect(() => prepareDeepSeekChatBody('[]', allowed, 'deepseek-v4-flash')).toThrow(DeepSeekRequestError)
  expect(() => prepareDeepSeekChatBody(JSON.stringify({ model: 'deepseek-v4-flash', tools: {} }), allowed, 'deepseek-v4-flash')).toThrow(DeepSeekRequestError)
})

test('prepareBody adds the object type required by DeepSeek while preserving union tool schemas', () => {
  const raw = JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'function',
      function: {
        name: 'MediaWorkbench',
        description: 'Create media',
        parameters: {
          anyOf: [
            { type: 'object', properties: { action: { const: 'image' } }, required: ['action'] },
            { type: 'object', properties: { action: { const: 'video' } }, required: ['action'] },
          ],
        },
      },
    }],
  })

  const { body } = prepareDeepSeekChatBody(
    raw,
    new Set(['deepseek-v4-flash']),
    'deepseek-v4-flash',
  )
  const parsed = JSON.parse(body)
  expect(parsed.tools[0].function.parameters).toEqual({
    anyOf: [
      { type: 'object', properties: { action: { const: 'image' } }, required: ['action'] },
      { type: 'object', properties: { action: { const: 'video' } }, required: ['action'] },
    ],
    type: 'object',
  })
})

test('prepares only the native Anthropic web-search request and injects the trusted metadata user id', () => {
  const allowed = new Set(['deepseek-v4-flash'])
  const { body } = prepareDeepSeekAnthropicWebSearchBody(JSON.stringify({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'search current billiards rules' }],
    tools: [{
      type: DEEPSEEK_NATIVE_WEB_SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: 8,
    }],
    metadata: { user_id: 'attacker-spoofed', keep: 'safe' },
  }), allowed, 'deepseek-v4-flash', { userId: 'bb_trusted' })

  expect(JSON.parse(body)).toEqual({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'search current billiards rules' }],
    tools: [{
      type: DEEPSEEK_NATIVE_WEB_SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: 8,
    }],
    metadata: { user_id: 'bb_trusted', keep: 'safe' },
  })
})

test('rejects non-native or mixed server-tool requests from the narrow Anthropic path', () => {
  expect(isDeepSeekNativeWebSearchRequest({
    tools: [{ type: DEEPSEEK_NATIVE_WEB_SEARCH_TOOL_TYPE }],
  })).toBe(true)
  expect(isDeepSeekNativeWebSearchRequest({
    tools: [{ type: 'computer_20241022' }],
  })).toBe(false)
  expect(isDeepSeekNativeWebSearchRequest({
    tools: [
      { type: DEEPSEEK_NATIVE_WEB_SEARCH_TOOL_TYPE },
      { type: 'computer_20241022' },
    ],
  })).toBe(false)

  expect(() => prepareDeepSeekAnthropicWebSearchBody(JSON.stringify({
    model: 'deepseek-v4-flash',
    tools: [{ type: 'computer_20241022' }],
  }), new Set(['deepseek-v4-flash']), 'deepseek-v4-flash')).toThrow(DeepSeekRequestError)
})

test('builds the official DeepSeek Anthropic Messages endpoint without double appending the path', () => {
  expect(deepSeekAnthropicMessagesUrl('https://api.deepseek.com')).toBe(
    'https://api.deepseek.com/anthropic/v1/messages',
  )
  expect(deepSeekAnthropicMessagesUrl('https://api.deepseek.com/anthropic/')).toBe(
    'https://api.deepseek.com/anthropic/v1/messages',
  )
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
