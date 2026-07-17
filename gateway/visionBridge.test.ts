import { expect, test } from 'bun:test'
import { containsImageContent, createVisionBridge, VisionBridgeError, DefaultVisionCache, VisionSemaphore } from './visionBridge'

// 1x1 透明 PNG,极小,方便测试:约 68 字节解码后。
const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function baseCaps(overrides: Partial<Parameters<typeof createVisionBridge>[0]['caps']> = {}) {
  return {
    maxImages: 4,
    maxImageBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    visionTimeoutMs: 2000,
    maxConcurrent: 4,
    queueMax: 16,
    perRequestConc: 4,
    cacheMax: 16,
    cacheTtlMs: 60_000,
    ...overrides,
  }
}

function chatBodyWithImages(urls: string[]): string {
  return JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        ...urls.map(url => ({ type: 'image_url', image_url: { url } })),
      ],
    }],
  })
}

function fakeMimoOk(visionText: string) {
  const calls: Array<{ url: string; body: string }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url: String(input), body })
    return Response.json({ choices: [{ message: { content: visionText } }] })
  }
  return { calls, fetchImpl }
}

test('detects an image, calls MiMo exactly once, replaces image_url with vision text, and leaves no image_url in the output', async () => {
  const { calls, fetchImpl } = fakeMimoOk('一只猫坐在窗台上。')
  const bridge = createVisionBridge({ mimoBase: 'https://mimo.example/v1', mimoKey: 'mimo-secret', fetchImpl, caps: baseCaps() })
  const rawBody = chatBodyWithImages([PNG_DATA_URI])
  expect(containsImageContent(rawBody)).toBe(true)

  const { body, metrics } = await bridge.transform(rawBody, {})
  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe('https://mimo.example/v1/chat/completions')
  const sent = JSON.parse(calls[0]!.body)
  expect(sent.model).toBe('mimo-v2.5')
  expect(sent.stream).toBe(false)
  expect(sent.thinking).toEqual({ type: 'disabled' })

  expect(body).not.toContain('image_url')
  expect(body).toContain('一只猫坐在窗台上')
  expect(metrics.imageCount).toBe(1)
  expect(metrics.cacheHits).toBe(0)

  const parsed = JSON.parse(body)
  // 全部替换为文本后,单图消息的 content 合并为字符串(对 DeepSeek 更稳)。
  expect(typeof parsed.messages[0].content).toBe('string')
  expect(parsed.messages[0].content).toContain('[图片理解结果 1]')
})

test('a second identical image (same request, and a second request) hits the cache — MiMo is not called again', async () => {
  const { calls, fetchImpl } = fakeMimoOk('同一张图的理解结果。')
  const bridge = createVisionBridge({ mimoBase: 'https://mimo.example/v1', mimoKey: 'mimo-secret', fetchImpl, caps: baseCaps() })

  // 同一请求内两张完全相同的图:只应调用 MiMo 一次(请求内去重)。
  const dupInRequest = chatBodyWithImages([PNG_DATA_URI, PNG_DATA_URI])
  const first = await bridge.transform(dupInRequest, {})
  expect(calls).toHaveLength(1)
  expect(first.metrics.imageCount).toBe(2)
  expect(first.body).not.toContain('image_url')

  // 跨请求复用同一张图:命中缓存,MiMo 总调用数仍是 1。
  const second = await bridge.transform(chatBodyWithImages([PNG_DATA_URI]), {})
  expect(calls).toHaveLength(1)
  expect(second.metrics.cacheHits).toBe(1)
})

test('exceeding maxImages fails closed before calling MiMo', async () => {
  const { calls, fetchImpl } = fakeMimoOk('不应该被调用')
  const bridge = createVisionBridge({ mimoBase: 'https://mimo.example/v1', mimoKey: 'mimo-secret', fetchImpl, caps: baseCaps({ maxImages: 1 }) })
  const rawBody = chatBodyWithImages([PNG_DATA_URI, PNG_DATA_URI])

  await expect(bridge.transform(rawBody, {})).rejects.toBeInstanceOf(VisionBridgeError)
  expect(calls).toHaveLength(0)
})

test('exceeding maxImageBytes fails closed before calling MiMo', async () => {
  const { calls, fetchImpl } = fakeMimoOk('不应该被调用')
  // PNG 解码后约 68 字节,把上限设到比它更小,必定超限。
  const bridge = createVisionBridge({ mimoBase: 'https://mimo.example/v1', mimoKey: 'mimo-secret', fetchImpl, caps: baseCaps({ maxImageBytes: 10 }) })
  const rawBody = chatBodyWithImages([PNG_DATA_URI])

  let caught: unknown
  try {
    await bridge.transform(rawBody, {})
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(VisionBridgeError)
  expect((caught as VisionBridgeError).status).toBe(413)
  expect(calls).toHaveLength(0)
})

test('MiMo 400/429/5xx/structurally-invalid responses all fail closed as VisionBridgeError, without leaking upstream detail', async () => {
  const cases: Array<{ label: string; fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; expectStatus?: number }> = [
    { label: '400', fetchImpl: async () => new Response('upstream secret detail 400', { status: 400 }), expectStatus: 502 },
    { label: '429', fetchImpl: async () => new Response('upstream secret detail 429', { status: 429, headers: { 'retry-after': '0' } }), expectStatus: 429 },
    { label: '500', fetchImpl: async () => new Response('upstream secret detail 500', { status: 500 }), expectStatus: 502 },
    { label: 'malformed json', fetchImpl: async () => new Response('not json', { headers: { 'content-type': 'application/json' } }), expectStatus: 502 },
    { label: 'empty content', fetchImpl: async () => Response.json({ choices: [{ message: { content: '' } }] }), expectStatus: 502 },
    { label: 'missing choices', fetchImpl: async () => Response.json({ ok: true }), expectStatus: 502 },
  ]

  for (const testCase of cases) {
    const bridge = createVisionBridge({
      mimoBase: 'https://mimo.example/v1',
      mimoKey: 'mimo-secret',
      fetchImpl: testCase.fetchImpl,
      // 每个 case 用独立 bridge 实例(独立缓存),互不干扰;maxRetries 内部固定为 1,500 会重试一次再失败,可接受更长超时。
      caps: baseCaps({ visionTimeoutMs: 3000 }),
    })
    let caught: unknown
    try {
      await bridge.transform(chatBodyWithImages([PNG_DATA_URI]), {})
    } catch (error) {
      caught = error
    }
    expect(caught, `case ${testCase.label} should throw`).toBeInstanceOf(VisionBridgeError)
    const err = caught as VisionBridgeError
    if (testCase.expectStatus) expect(err.status, `case ${testCase.label} status`).toBe(testCase.expectStatus)
    // 错误消息里绝不能出现图片字节/base64/上游原始细节。
    expect(err.publicMessage).not.toContain('base64')
    expect(err.publicMessage).not.toContain('upstream secret detail')
    expect(err.publicMessage).not.toContain(PNG_DATA_URI)
  }
})

test('a MiMo timeout fails closed with a redacted message and never leaks image bytes', async () => {
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
  }
  const bridge = createVisionBridge({
    mimoBase: 'https://mimo.example/v1',
    mimoKey: 'mimo-secret',
    fetchImpl,
    caps: baseCaps({ visionTimeoutMs: 50 }),
  })
  let caught: unknown
  try {
    await bridge.transform(chatBodyWithImages([PNG_DATA_URI]), {})
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(VisionBridgeError)
  expect((caught as VisionBridgeError).status).toBe(504)
  expect((caught as VisionBridgeError).publicMessage).not.toContain('base64')
})

test('a request with no images passes through unchanged (defensive no-op)', async () => {
  const { calls, fetchImpl } = fakeMimoOk('不应该被调用')
  const bridge = createVisionBridge({ mimoBase: 'https://mimo.example/v1', mimoKey: 'mimo-secret', fetchImpl, caps: baseCaps() })
  const rawBody = JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] })
  expect(containsImageContent(rawBody)).toBe(false)
  const { body, metrics } = await bridge.transform(rawBody, {})
  expect(body).toBe(rawBody)
  expect(metrics.imageCount).toBe(0)
  expect(calls).toHaveLength(0)
})

// ── 自定义并发/缓存原语的直接回归(对抗审查 MEDIUM #1:这两块最易出 off-by-one/双 settle,补测) ──

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('DefaultVisionCache evicts the oldest entry (FIFO) once maxEntries is exceeded', () => {
  const cache = new DefaultVisionCache(2, 60_000)
  cache.set('a', 'AAA')
  cache.set('b', 'BBB')
  cache.set('c', 'CCC') // 超过容量 2 → 最早写入的 a 被淘汰
  expect(cache.get('a')).toBeUndefined()
  expect(cache.get('b')).toBe('BBB')
  expect(cache.get('c')).toBe('CCC')
})

test('DefaultVisionCache re-setting an existing key refreshes its FIFO position', () => {
  const cache = new DefaultVisionCache(2, 60_000)
  cache.set('a', 'AAA')
  cache.set('b', 'BBB')
  cache.set('a', 'AAA2') // 重写 a → 移到队尾,下一个被淘汰的是 b
  cache.set('c', 'CCC')
  expect(cache.get('b')).toBeUndefined()
  expect(cache.get('a')).toBe('AAA2')
  expect(cache.get('c')).toBe('CCC')
})

test('DefaultVisionCache expires an entry after its TTL and drops it (does not keep occupying a slot)', async () => {
  const cache = new DefaultVisionCache(16, 20) // 20ms TTL
  cache.set('k', 'V')
  expect(cache.get('k')).toBe('V')
  await sleep(40)
  expect(cache.get('k')).toBeUndefined()
  expect(cache.get('k')).toBeUndefined() // 过期后重复取仍 undefined
})

test('VisionSemaphore never exceeds its concurrency limit and returns to 0 active', async () => {
  const sem = new VisionSemaphore(2, 1000)
  let active = 0
  let maxActive = 0
  const task = () => sem.run(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await sleep(20)
    active -= 1
  })
  await Promise.all([task(), task(), task(), task(), task()])
  expect(maxActive).toBeLessThanOrEqual(2)
  expect(active).toBe(0)
})

test('VisionSemaphore rejects a queued waiter with a 429 VisionBridgeError after queueMaxWaitMs (no long queue)', async () => {
  const sem = new VisionSemaphore(1, 30) // 1 并发,排队最多等 30ms
  let holderReleased = false
  const holder = sem.run(async () => { await sleep(100); holderReleased = true }) // 占住唯一槽 100ms
  let caught: unknown
  try {
    await sem.run(async () => { await sleep(1) }) // 第二个排队者应 ~30ms 后 429,而不是一直等
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(VisionBridgeError)
  expect((caught as VisionBridgeError).status).toBe(429)
  expect(holderReleased).toBe(false) // 排队者超时时占位者还没释放
  await holder // 收尾,避免悬挂 promise
  expect(holderReleased).toBe(true)
})

// ── item 2:队列真正有上限(queueMax)+ abort 立即出队 + 结算路径互斥(对抗审查补测) ──────

test('VisionSemaphore rejects immediately with 429 once the queue itself is full — does not enqueue, does not wait for queueMaxWaitMs', async () => {
  const sem = new VisionSemaphore(1, 5000, 2) // 1 并发、队列上限 2、排队等待窗口故意设得很长(5s)
  const holder = sem.run(async () => { await sleep(200) }) // 占住唯一的并发槽
  await sleep(5)
  const q1 = sem.run(async () => { await sleep(1) }).catch(() => 'q1-rejected')
  const q2 = sem.run(async () => { await sleep(1) }).catch(() => 'q2-rejected') // 队列已满 2
  await sleep(5)
  expect(sem.snapshot()).toMatchObject({ active: 1, queued: 2, limit: 1, queueMax: 2 })

  const start = Date.now()
  let caught: unknown
  try {
    await sem.run(async () => {}) // 第 3 个等待者:队列已满,应立即 429,而不是等 5s 超时
  } catch (error) {
    caught = error
  }
  const elapsedMs = Date.now() - start
  expect(caught).toBeInstanceOf(VisionBridgeError)
  expect((caught as VisionBridgeError).status).toBe(429)
  expect(elapsedMs).toBeLessThan(200) // 远小于 queueMaxWaitMs=5000,证明是"队列满"立即拒绝而非排队超时

  await Promise.all([holder, q1, q2])
  expect(sem.snapshot()).toMatchObject({ active: 0, queued: 0 })
})

test('VisionSemaphore dequeues an aborted waiter immediately via AbortSignal, not waiting for queueMaxWaitMs', async () => {
  const sem = new VisionSemaphore(1, 5000) // 排队超时故意设得很长(5s),证明下面靠的是 abort 而非超时
  const holder = sem.run(async () => { await sleep(200) })
  await sleep(5)
  const ac = new AbortController()
  const start = Date.now()
  let caught: unknown
  const queued = sem.run(async () => {}, ac.signal).catch(error => { caught = error })
  await sleep(5)
  expect(sem.snapshot().queued).toBe(1)

  ac.abort()
  await queued
  const elapsedMs = Date.now() - start
  expect(caught).toBeInstanceOf(VisionBridgeError)
  expect((caught as VisionBridgeError).status).toBe(499)
  expect(elapsedMs).toBeLessThan(200)
  expect(sem.snapshot().queued).toBe(0) // 已出队,不占位

  await holder
  expect(sem.snapshot()).toMatchObject({ active: 0, queued: 0 })
})

test('VisionSemaphore: grant / timeout / abort settle exactly once each (mutually exclusive) and active+queued always return to 0', async () => {
  const sem = new VisionSemaphore(1, 30) // 排队超时 30ms(短),用来触发 timeout 路径
  const holder = sem.run(async () => { await sleep(150) })
  await sleep(5)
  const ac = new AbortController()
  const results: string[] = []
  const willTimeout = sem.run(async () => {}).then(() => results.push('granted')).catch(e => results.push(`timeout:${(e as VisionBridgeError).status}`))
  const willAbort = sem.run(async () => {}, ac.signal).then(() => results.push('granted')).catch(e => results.push(`abort:${(e as VisionBridgeError).status}`))
  await sleep(5)
  ac.abort() // 让第二个排队者走 abort 路径(而不是也等 30ms 超时)
  await Promise.all([willTimeout, willAbort])
  expect(results.sort()).toEqual(['abort:499', 'timeout:429'])

  await holder
  expect(sem.snapshot()).toEqual({ active: 0, queued: 0, limit: 1, queueMax: Infinity })
})

test('a single multi-image request is capped at caps.perRequestConc global vision slots, leaving room for a concurrently arriving request', async () => {
  let gateOpen = false
  const waiters: Array<() => void> = []
  let inFlight = 0
  let peak = 0
  const calls: string[] = []
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push(body)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise<void>(resolve => { if (gateOpen) resolve(); else waiters.push(resolve) })
    inFlight -= 1
    return Response.json({ choices: [{ message: { content: '理解结果' } }] })
  }
  const bridge = createVisionBridge({
    mimoBase: 'https://mimo.example/v1',
    mimoKey: 'mimo-secret',
    fetchImpl,
    caps: baseCaps({ maxImages: 4, maxConcurrent: 4, perRequestConc: 2, queueMax: 16 }),
  })
  // 4 张互不相同的图(不同哈希,不会被请求内去重命中),全局并发上限 4 本可以一次性全占,
  // 但单请求应被 perRequestConc=2 限住。
  const fourDistinctImages = [0, 1, 2, 3].map(i => `data:image/png;base64,${Buffer.from(`unique-image-${i}`).toString('base64')}`)
  const bigRequest = bridge.transform(chatBodyWithImages(fourDistinctImages), {})
  await sleep(20)
  expect(peak).toBeLessThanOrEqual(2) // 单请求最多占 2 个全局槽,不是 4

  // 同时来了另一个只带 1 张新图的小请求:大请求只占了 2/4 个全局槽,小请求应立刻拿到槽,
  // 不必排队等大请求腾地方。
  const smallImage = `data:image/png;base64,${Buffer.from('unique-image-other').toString('base64')}`
  const smallRequest = bridge.transform(chatBodyWithImages([smallImage]), {})
  await sleep(20)
  expect(inFlight).toBe(3) // 2(大请求) + 1(小请求) = 3,都在全局上限 4 之内,小请求没被饿死

  gateOpen = true
  for (const resolve of waiters.splice(0)) resolve()
  await Promise.all([bigRequest, smallRequest])
  expect(calls).toHaveLength(5) // 4(大请求,各不相同不去重) + 1(小请求)
})
