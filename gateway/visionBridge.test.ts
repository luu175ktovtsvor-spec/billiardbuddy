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
