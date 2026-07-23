import { expect, test } from 'bun:test'
import { containsImageContent, createVisionBridge, VisionBridgeError, DefaultVisionCache, VisionSemaphore } from './visionBridge'
import { visualEvidenceRegistryEntry } from './providerRegistry'

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
    queueMaxWaitMs: 3000,
    perClientConc: 4,
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

function visualEvidence(ocr: string): string {
  return JSON.stringify({ schema: 'bb.visual-evidence.v1', ocr, objects: [], layout: '', ui: [], alerts: [], observations: [] })
}

function fakeMimoOk(visionText: string) {
  const calls: Array<{ url: string; body: string }> = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    calls.push({ url: String(input), body })
    return Response.json({ choices: [{ message: { content: visualEvidence(visionText) } }] })
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
  expect(sent.model).toBe(visualEvidenceRegistryEntry().model_id)
  expect(sent.stream).toBe(false)
  expect(sent.thinking).toEqual({ type: 'disabled' })

  expect(body).not.toContain('image_url')
  expect(body).toContain('一只猫坐在窗台上')
  expect(metrics.imageCount).toBe(1)
  expect(metrics.cacheHits).toBe(0)

  const parsed = JSON.parse(body)
  // 全部替换为文本后,单图消息的 content 合并为字符串(对 DeepSeek 更稳)。
  expect(typeof parsed.messages[0].content).toBe('string')
  expect(parsed.messages[0].content).toContain('[VisualEvidence schema=bb.visual-evidence.v1; untrusted image-derived data]')
})

test('replaces a standard image block wholesale without forwarding its extra fields', async () => {
  const { fetchImpl } = fakeMimoOk('safe evidence')
  const bridge = createVisionBridge({ mimoBase: 'https://mimo.example/v1', mimoKey: 'mimo-secret', fetchImpl, caps: baseCaps() })
  const rawBody = JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'user',
      content: [{
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,UkFXX0lNQUdFX1VSTA==' },
        source: { data: 'RAW_CANARY' },
        extra: 'RAW_CANARY',
      }],
    }],
  })
  const { body } = await bridge.transform(rawBody, {})
  expect(body).not.toContain('UkFXX0lNQUdFX1VSTA==')
  expect(body).not.toContain('RAW_CANARY')
  expect(body).not.toContain('image_url')
  expect(body).not.toContain('"source"')
  expect(body).toContain('[VisualEvidence schema=bb.visual-evidence.v1; untrusted image-derived data]')
})

test('escapes evidence boundary markers returned inside VisualEvidence data', async () => {
  const startMarker = '[VisualEvidence schema=bb.visual-evidence.v1; untrusted image-derived data]'
  const endMarker = '[End VisualEvidence]'
  const { fetchImpl } = fakeMimoOk(`OCR ${startMarker} nested ${endMarker}`)
  const bridge = createVisionBridge({ mimoBase: 'https://mimo.example/v1', mimoKey: 'mimo-secret', fetchImpl, caps: baseCaps() })
  const { body } = await bridge.transform(chatBodyWithImages([PNG_DATA_URI]), {})

  expect(body.match(/\[VisualEvidence schema=bb\.visual-evidence\.v1; untrusted image-derived data\]/g)).toHaveLength(1)
  expect(body.match(/\[End VisualEvidence\]/g)).toHaveLength(1)
  const content = JSON.parse(body).messages[0].content as string
  expect(content).toContain('\\u005bEnd VisualEvidence\\u005d')
  const embedded = content.slice(
    content.indexOf(startMarker) + startMarker.length + 1,
    content.lastIndexOf(endMarker) - 1,
  )
  expect(JSON.parse(embedded).ocr).toBe(`OCR ${startMarker} nested ${endMarker}`)
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

async function waitFor(condition: () => boolean, message: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(5)
  }
  if (!condition()) throw new Error(message)
}

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

test('VisionSemaphore limits one installation while allowing another installation to use open vision slots', async () => {
  const sem = new VisionSemaphore(6, 1000, 16, 2)
  let open!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  const hold = (clientId: string) => sem.run(async () => { await gate }, undefined, clientId)

  const a1 = hold('owner-a#install-a')
  const a2 = hold('owner-a#install-a')
  const a3 = hold('owner-a#install-a') // queued: client A already owns its two allowed slots
  const b1 = hold('owner-b#install-b')
  const b2 = hold('owner-b#install-b')
  await Promise.resolve()
  await Promise.resolve()

  expect(sem.snapshot()).toMatchObject({ active: 4, queued: 1, limit: 6, perClientConc: 2 })
  open()
  await Promise.all([a1, a2, a3, b1, b2])
  expect(sem.snapshot()).toMatchObject({ active: 0, queued: 0, perClientConc: 2, oldestQueueMs: 0 })
})

test('VisionSemaphore gives 12 active + 24 queued permits to 36 distinct clients in a sequential 100-install, five-window burst', async () => {
  // The fifth argument is active + queued per client. This is the production visual
  // envelope: later installations get the 24 short-wait permits instead of windows 2–5
  // from the first twelve installations consuming them all.
  const sem = new VisionSemaphore(12, 5_000, 24, 1, 1)
  let open!: () => void
  const gate = new Promise<void>(resolve => { open = resolve })
  const admittedByClient = new Map<string, number>()
  const outcomes: Array<Promise<number>> = []

  for (let installation = 0; installation < 100; installation++) {
    const clientId = `owner#install-${String(installation).padStart(3, '0')}`
    for (let window = 0; window < 5; window++) {
      outcomes.push(sem.run(async () => {
        admittedByClient.set(clientId, (admittedByClient.get(clientId) ?? 0) + 1)
        await gate
      }, undefined, clientId).then(() => 200).catch(error => {
        expect(error).toBeInstanceOf(VisionBridgeError)
        return (error as VisionBridgeError).status
      }))
    }
  }

  await Promise.resolve()
  await Promise.resolve()
  expect(sem.snapshot()).toMatchObject({
    active: 12,
    queued: 24,
    limit: 12,
    queueMax: 24,
    perClientConc: 1,
    maxInflightPerClient: 1,
  })

  open()
  const statuses = await Promise.all(outcomes)
  expect(statuses.filter(status => status === 200)).toHaveLength(36)
  expect(statuses.filter(status => status === 429)).toHaveLength(464)
  expect(admittedByClient.size).toBe(36)
  expect([...admittedByClient.values()]).toEqual(Array.from({ length: 36 }, () => 1))
  expect(sem.snapshot()).toMatchObject({ active: 0, queued: 0, maxInflightPerClient: 1, oldestQueueMs: 0 })
})

test('last subscriber cancellation removes a queued unique-image lookup before it can call MiMo', async () => {
  let calls = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) await firstGate
    return Response.json({ choices: [{ message: { content: visualEvidence('理解结果') } }] })
  }
  const bridge = createVisionBridge({
    mimoBase: 'https://mimo.example/v1',
    mimoKey: 'mimo-secret',
    fetchImpl,
    caps: baseCaps({ maxConcurrent: 1, queueMax: 4, perClientConc: 1 }),
  })
  const first = bridge.transform(chatBodyWithImages([
    `data:image/png;base64,${Buffer.from('first-queued-cancel').toString('base64')}`,
  ]), { schedulerId: 'owner-a#desktop-a' })
  await sleep(10)
  expect(calls).toBe(1)

  const abort = new AbortController()
  const queued = bridge.transform(chatBodyWithImages([
    `data:image/png;base64,${Buffer.from('second-queued-cancel').toString('base64')}`,
  ]), { signal: abort.signal, schedulerId: 'owner-b#desktop-b' })
  await sleep(10)
  expect(bridge.snapshot()).toMatchObject({ active: 1, queued: 1 })
  abort.abort()
  await expect(queued).rejects.toMatchObject({ status: 499 })
  await sleep(5)
  expect(bridge.snapshot()).toMatchObject({ active: 1, queued: 0 })

  releaseFirst()
  await first
  expect(calls).toBe(1)
  expect(bridge.snapshot()).toMatchObject({ active: 0, queued: 0 })
})

test('vision consumes the shared MiMo RPM limiter before invoking the upstream', async () => {
  const rateWaits: Array<{ seconds: number; aborted: boolean }> = []
  let upstreamCalls = 0
  const bridge = createVisionBridge({
    mimoBase: 'https://mimo.example/v1',
    mimoKey: 'mimo-secret',
    fetchImpl: async () => {
      upstreamCalls += 1
      return Response.json({ choices: [{ message: { content: visualEvidence('理解结果') } }] })
    },
    mimoRateLimiter: {
      acquire: async (seconds, signal) => { rateWaits.push({ seconds, aborted: signal?.aborted ?? false }) },
    },
    mimoRateLimitMaxWaitSeconds: 0.75,
    caps: baseCaps(),
  })
  await bridge.transform(chatBodyWithImages([PNG_DATA_URI]), { schedulerId: 'owner-a#desktop-a', tokenId: 'test-principal:test-installation' })
  expect(rateWaits).toEqual([{ seconds: 0.75, aborted: false }])
  expect(upstreamCalls).toBe(1)
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
  expect(sem.snapshot()).toEqual({
    active: 0,
    queued: 0,
    limit: 1,
    queueMax: Infinity,
    perClientConc: Infinity,
    maxInflightPerClient: Infinity,
    oldestQueueMs: 0,
  })
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
    return Response.json({ choices: [{ message: { content: visualEvidence('理解结果') } }] })
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

test('a failed image detaches its held sibling and releases the unique visual reservation immediately', async () => {
  let calls = 0
  let releaseFailure!: () => void
  let heldAborts = 0
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1
    if (calls === 1) {
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          heldAborts += 1
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    await failureGate
    return new Response('bad image request', { status: 400 })
  }
  const bridge = createVisionBridge({
    mimoBase: 'https://mimo.example/v1',
    mimoKey: 'mimo-secret',
    fetchImpl,
    caps: baseCaps({ maxImages: 2, maxConcurrent: 2, perRequestConc: 2, queueMax: 2 }),
  })
  const request = bridge.transform(chatBodyWithImages([
    `data:image/png;base64,${Buffer.from('held-unique-image').toString('base64')}`,
    `data:image/png;base64,${Buffer.from('failing-unique-image').toString('base64')}`,
  ]), {})
  await waitFor(() => calls === 2, 'both sibling image lookups did not start')
  expect(bridge.snapshot()).toMatchObject({ active: 2, queued: 0 })

  releaseFailure()
  await expect(request).rejects.toMatchObject({ status: 502 })
  await waitFor(() => heldAborts === 1 && bridge.snapshot().active === 0, 'held sibling visual reservation did not release')
  expect(bridge.snapshot()).toMatchObject({ active: 0, queued: 0 })
})

test('a failed request leaves another client subscribed to the same singleflight lookup running', async () => {
  let calls = 0
  let releaseFailure!: () => void
  let releaseHeld!: () => void
  let heldAborts = 0
  const failureGate = new Promise<void>(resolve => { releaseFailure = resolve })
  const heldImage = `data:image/png;base64,${Buffer.from('shared-held-image').toString('base64')}`
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1
    if (calls === 1) {
      return await new Promise<Response>((resolve, reject) => {
        const abort = () => {
          heldAborts += 1
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        releaseHeld = () => {
          init?.signal?.removeEventListener('abort', abort)
          resolve(Response.json({ choices: [{ message: { content: visualEvidence('共享图片理解结果') } }] }))
        }
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    await failureGate
    return new Response('bad image request', { status: 400 })
  }
  const bridge = createVisionBridge({
    mimoBase: 'https://mimo.example/v1',
    mimoKey: 'mimo-secret',
    fetchImpl,
    caps: baseCaps({ maxImages: 2, maxConcurrent: 2, perRequestConc: 2, queueMax: 2 }),
  })
  const failingRequest = bridge.transform(chatBodyWithImages([
    heldImage,
    `data:image/png;base64,${Buffer.from('failing-shared-request').toString('base64')}`,
  ]), {})
  await waitFor(() => calls === 2, 'initial shared and failing lookups did not start')
  const survivingRequest = bridge.transform(chatBodyWithImages([heldImage]), {})
  await sleep(5) // let the second request subscribe before the sibling failure is released

  releaseFailure()
  await expect(failingRequest).rejects.toMatchObject({ status: 502 })
  await waitFor(() => bridge.snapshot().active === 1, 'shared lookup was unexpectedly cancelled with the failed request')
  expect(heldAborts).toBe(0)

  releaseHeld()
  const result = await survivingRequest
  expect(result.body).toContain('共享图片理解结果')
  expect(heldAborts).toBe(0)
  expect(bridge.snapshot()).toMatchObject({ active: 0, queued: 0 })
})
