import { expect, test } from 'bun:test'
import { fetchMimoWithRetry } from './mimoChat'

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
