import { expect, test } from 'bun:test'
import { fetchWithModelRetry, isRetryableStatus } from './fetchRetry'

const noopSleep = async () => {}

test('isRetryableStatus:408/429/5xx 可重试,其余不可', () => {
  for (const s of [408, 429, 500, 502, 503, 599]) expect(isRetryableStatus(s)).toBe(true)
  for (const s of [200, 400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false)
})

test('429 后 200:重试并返回成功,尝试 2 次', async () => {
  let calls = 0
  const resp = await fetchWithModelRetry(async () => {
    calls++
    return calls === 1 ? new Response('rate', { status: 429 }) : new Response('ok', { status: 200 })
  }, { sleep: noopSleep })
  expect(resp.status).toBe(200)
  expect(calls).toBe(2)
})

test('持续 500:重试到上限后返回最后一个 500', async () => {
  let calls = 0
  const resp = await fetchWithModelRetry(async () => {
    calls++
    return new Response('err', { status: 500 })
  }, { sleep: noopSleep, maxRetries: 3 })
  expect(resp.status).toBe(500)
  expect(calls).toBe(4) // 首次 + 3 次重试
})

test('400 不重试,立即返回', async () => {
  let calls = 0
  const resp = await fetchWithModelRetry(async () => {
    calls++
    return new Response('bad', { status: 400 })
  }, { sleep: noopSleep })
  expect(resp.status).toBe(400)
  expect(calls).toBe(1)
})

test('网络错误后 200:重试成功', async () => {
  let calls = 0
  const resp = await fetchWithModelRetry(async () => {
    calls++
    if (calls === 1) throw new Error('ECONNRESET')
    return new Response('ok', { status: 200 })
  }, { sleep: noopSleep })
  expect(resp.status).toBe(200)
  expect(calls).toBe(2)
})

test('超时/中断类抛错不重试,直接冒泡', async () => {
  let calls = 0
  await expect(fetchWithModelRetry(async () => {
    calls++
    throw new Error('模型请求超时 60000ms')
  }, { sleep: noopSleep })).rejects.toThrow('超时')
  expect(calls).toBe(1)
})

test('已中止的 signal:不发请求直接抛', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await expect(fetchWithModelRetry(async () => {
    calls++
    return new Response('ok')
  }, { sleep: noopSleep, signal: controller.signal })).rejects.toThrow('中断')
  expect(calls).toBe(0)
})

test('尊重数字型 Retry-After(秒),用它作退避时长', async () => {
  const slept: number[] = []
  let calls = 0
  await fetchWithModelRetry(async () => {
    calls++
    return calls === 1
      ? new Response('rate', { status: 429, headers: { 'retry-after': '2' } })
      : new Response('ok', { status: 200 })
  }, { sleep: async ms => { slept.push(ms) } })
  expect(slept).toEqual([2000])
})

test('maxRetries=0:不重试', async () => {
  let calls = 0
  const resp = await fetchWithModelRetry(async () => {
    calls++
    return new Response('err', { status: 503 })
  }, { sleep: noopSleep, maxRetries: 0 })
  expect(resp.status).toBe(503)
  expect(calls).toBe(1)
})
