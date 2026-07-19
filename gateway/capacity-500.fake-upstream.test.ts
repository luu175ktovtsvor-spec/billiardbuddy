// 100 用户 × 5 窗口基线及 100 用户 × 10 窗口默认 DeepSeek profile 的假 upstream 压测。
//
// 本文件刻意不访问真实 DeepSeek / MiMo 账号：用一个可控的假上游把请求挂住，观察网关
// 实际发出的上游请求峰值、每个可信 token 的额度、取消后的排队回收和 response stream
// 收尾。它证明的是网关本身可承载的调度形状，不把 fake upstream 的零延迟误写成真实模型
// 性能或账号配额证据。

import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'

const USERS = 100
const WINDOWS_PER_USER = 5
const TOTAL = USERS * WINDOWS_PER_USER
const MAX_WINDOWS_PER_USER = 10
const MAX_TOTAL = USERS * MAX_WINDOWS_PER_USER

type UpstreamKind = 'deepseek' | 'mimoText' | 'mimoVision'
type Stat = { calls: number; inFlight: number; peak: number }
type Stats = Record<UpstreamKind, Stat>

const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function eventually(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await tick()
  }
}

function owners(): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: USERS }, (_, index) => [`token-${String(index).padStart(3, '0')}`, `owner-${String(index).padStart(3, '0')}`]),
  )
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GW_QWEN_KEY: 'qwen-secret',
    GW_QWEN_BASE: 'https://qwen.example/v1',
    GW_QWEN_MODEL: 'qwen3-coder-plus',
    GW_QWEN_RPM: '1000000',
    GW_QWEN_CONC: '16',
    GW_QWEN_USER_CONC: '16',
    GW_QWEN_TOKEN_CONC: '16',
    GW_QWEN_QUEUE_MAX_WAIT: '10',
    GW_MIMO_KEY: 'mimo-secret',
    GW_MIMO_BASE: 'https://mimo.example/v1',
    GW_MIMO_MODEL: 'mimo-v2.5',
    GW_MIMO_RPM: '1000000',
    // Explicit 16 native + 12 visual reservation. The generic test profile no longer
    // relies on the pre-partition interpretation where all 16 slots were shared.
    GW_MIMO_CONC: '28',
    GW_MIMO_NATIVE_CONC: '16',
    GW_MIMO_USER_CONC: '16',
    GW_MIMO_INFLIGHT_PER_USER: '16',
    GW_MIMO_TOKEN_CONC: '16',
    GW_MIMO_QUEUE_MAX_WAIT: '10',
    GW_DEEPSEEK_KEY: 'deepseek-secret',
    GW_DEEPSEEK_BASE: 'https://deepseek.example',
    GW_DEEPSEEK_MODEL: 'deepseek-v4-flash',
    GW_DEEPSEEK_RPM: '1000000',
    GW_DEEPSEEK_CONC: '32',
    GW_DEEPSEEK_USER_CONC: '32',
    GW_DEEPSEEK_TOKEN_CONC: '32',
    GW_DEEPSEEK_QUEUE_MAX_WAIT: '10',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_APP_TOKENS: JSON.stringify(owners()),
    GW_VISION_MAX_IMAGES: '1',
    GW_VISION_MAX_IMAGE_BYTES: '2000000',
    GW_VISION_MAX_TOTAL_BYTES: '5000000',
    GW_VISION_TIMEOUT_MS: '10000',
    GW_VISION_CONC: '12',
    GW_VISION_PER_REQUEST_CONC: '1',
    GW_VISION_CACHE_MAX: '1',
    GW_VISION_CACHE_TTL_MS: '1',
    ...overrides,
  }
}

/** 可取消的假 upstream 闸门。真实网关会把 request.signal 传给上游，借此也覆盖排队后
 * 客户端取消时上游不应继续占用连接的路径。 */
function gate() {
  let opened = false
  const waiters = new Set<() => void>()
  return {
    async wait(signal?: AbortSignal): Promise<void> {
      if (opened) return
      if (signal?.aborted) throw abortError()
      await new Promise<void>((resolve, reject) => {
        const release = () => {
          cleanup()
          resolve()
        }
        const onAbort = () => {
          waiters.delete(release)
          cleanup()
          reject(abortError())
        }
        const cleanup = () => signal?.removeEventListener('abort', onAbort)
        waiters.add(release)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    open(): void {
      if (opened) return
      opened = true
      for (const release of waiters) release()
      waiters.clear()
    },
  }
}

function abortError(): Error {
  const error = new Error('aborted by fake upstream')
  error.name = 'AbortError'
  return error
}

function isVisionCall(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { stream?: unknown; messages?: Array<{ content?: unknown }> }
    return parsed.stream === false && Array.isArray(parsed.messages?.[0]?.content)
  } catch {
    return false
  }
}

function createFakeUpstream(options: { holdText?: boolean; holdVision?: boolean } = {}) {
  const textGate = gate()
  const visionGate = gate()
  const stats: Stats = {
    deepseek: { calls: 0, inFlight: 0, peak: 0 },
    mimoText: { calls: 0, inFlight: 0, peak: 0 },
    mimoVision: { calls: 0, inFlight: 0, peak: 0 },
  }
  const seenByKind: Record<UpstreamKind, string[]> = { deepseek: [], mimoText: [], mimoVision: [] }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    const kind: UpstreamKind = url.includes('deepseek.example')
      ? 'deepseek'
      : isVisionCall(body)
        ? 'mimoVision'
        : 'mimoText'
    const stat = stats[kind]
    stat.calls += 1
    stat.inFlight += 1
    stat.peak = Math.max(stat.peak, stat.inFlight)
    try {
      try {
        const parsed = JSON.parse(body) as { user_id?: unknown; messages?: Array<{ content?: unknown }> }
        const identity = kind === 'deepseek'
          ? parsed.user_id
          : parsed.messages?.[0]?.content
        if (typeof identity === 'string') seenByKind[kind].push(identity.replace(/-window-\d+$/, ''))
      } catch {
        // The gateway should have rejected malformed JSON before reaching this fake upstream.
      }
      if (kind === 'mimoVision' && options.holdVision) await visionGate.wait(init?.signal)
      if (kind !== 'mimoVision' && options.holdText) await textGate.wait(init?.signal)
      if (kind === 'mimoVision') {
        return Response.json({ choices: [{ message: { content: '图片的结构化理解结果' } }] })
      }
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } finally {
      stat.inFlight -= 1
    }
  }

  return {
    fetchImpl,
    stats,
    seenByKind,
    openText: textGate.open,
    openVision: visionGate.open,
  }
}

function token(user: number): string {
  return `token-${String(user).padStart(3, '0')}`
}

function installation(user: number): string {
  return `install-${String(user).padStart(4, '0')}`
}

function dataUri(index: number): string {
  return `data:image/png;base64,${Buffer.from(`fake-image-${index}`).toString('base64')}`
}

function chatRequest(
  model: string,
  user: number,
  window: number,
  options: { image?: boolean; signal?: AbortSignal; gatewayToken?: string } = {},
): Request {
  const content = `user-${String(user).padStart(3, '0')}-window-${window}`
  const message = options.image
    ? { role: 'user', content: [{ type: 'text', text: content }, { type: 'image_url', image_url: { url: dataUri(user * WINDOWS_PER_USER + window) } }] }
    : { role: 'user', content }
  return new Request('http://local/v1/chat/completions', {
    method: 'POST',
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${options.gatewayToken ?? token(user)}`,
      'Content-Type': 'application/json',
      'X-QF-Client-ID': installation(user),
    },
    body: JSON.stringify({ model, stream: true, messages: [message] }),
  })
}

async function status(fetch: (request: Request) => Promise<Response>, request: Request): Promise<number> {
  const response = await fetch(request)
  try { await response.text() } catch { /* Mid-stream errors are covered in the existing gateway suite. */ }
  return response.status
}

async function health(fetch: (request: Request) => Promise<Response>, gatewayToken = token(0)) {
  const response = await fetch(new Request('http://local/healthz', { headers: { Authorization: `Bearer ${gatewayToken}` } }))
  const capacity = (await response.json()).capacity as Record<'deepseek' | 'mimo' | 'mimo_native' | 'mimo_total' | 'vision', { active: number; queued: number }>
  return {
    deepseek: { active: capacity.deepseek.active, queued: capacity.deepseek.queued },
    mimo: { active: capacity.mimo.active, queued: capacity.mimo.queued },
    mimoNative: { active: capacity.mimo_native.active, queued: capacity.mimo_native.queued },
    mimoTotal: { active: capacity.mimo_total.active, queued: capacity.mimo_total.queued },
    vision: { active: capacity.vision.active, queued: capacity.vision.queued },
  }
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

for (const profile of [
  { label: 'DeepSeek 文本池', model: 'deepseek-v4-flash', kind: 'deepseek' as const, env: { GW_DEEPSEEK_CONC: '500', GW_DEEPSEEK_USER_CONC: '5', GW_DEEPSEEK_TOKEN_CONC: '5' } },
  { label: 'MiMo 原生文本池', model: 'mimo-v2.5', kind: 'mimoText' as const, env: { GW_MIMO_CONC: '512', GW_MIMO_NATIVE_CONC: '500', GW_MIMO_USER_CONC: '5', GW_MIMO_INFLIGHT_PER_USER: '5', GW_MIMO_TOKEN_CONC: '5' } },
]) {
  test(`100 用户 × 5 窗口：${profile.label}在 500/5/5 配置下全部同时进入上游，可信身份各占 5 路`, async () => {
    const upstream = createFakeUpstream({ holdText: true })
    const fetch = createGatewayFetch({ env: env(profile.env), usageStore: new MemoryUsageStore(), transcribeImpl: null, fetchImpl: upstream.fetchImpl })
    const requests: Array<Promise<number>> = []
    for (let user = 0; user < USERS; user++) {
      for (let window = 0; window < WINDOWS_PER_USER; window++) {
        requests.push(status(fetch, chatRequest(profile.model, user, window)))
      }
    }

    await eventually(() => upstream.stats[profile.kind].calls === TOTAL, `${profile.label} all ${TOTAL} calls`)
    expect(upstream.stats[profile.kind]).toMatchObject({ calls: TOTAL, inFlight: TOTAL, peak: TOTAL })
    const identityCounts = countBy(upstream.seenByKind[profile.kind])
    expect(identityCounts.size).toBe(USERS)
    expect([...identityCounts.values()].every(count => count === WINDOWS_PER_USER)).toBe(true)
    const pool = profile.kind === 'deepseek' ? 'deepseek' : 'mimo'
    expect((await health(fetch))[pool]).toMatchObject({ active: TOTAL, queued: 0 })

    upstream.openText()
    expect((await Promise.all(requests)).every(value => value === 200)).toBe(true)
    expect((await health(fetch))[pool]).toEqual({ active: 0, queued: 0 })
  })
}

test('当前默认 DeepSeek 配置：共享产品 token 下 100 用户 × 10 窗口为 1,000 实际在途、零网关排队，全部可排空', async () => {
  const sharedToken = 'shared-desktop-token'
  const upstream = createFakeUpstream({ holdText: true })
  const fetch = createGatewayFetch({
    // Deliberately leave DeepSeek capacity variables unset to lock the production default
    // profile rather than smuggling an explicit demonstration profile into this assertion.
    env: env({
      GW_APP_TOKENS: JSON.stringify({ [sharedToken]: 'shared-product-token' }),
      GW_DEEPSEEK_CONC: undefined,
      GW_DEEPSEEK_USER_CONC: undefined,
      GW_DEEPSEEK_TOKEN_CONC: undefined,
      GW_DEEPSEEK_QUEUE_MAX: undefined,
      GW_DEEPSEEK_QUEUE_MAX_WAIT: undefined,
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const requests: Array<Promise<number>> = []
  for (let user = 0; user < USERS; user++) {
    for (let window = 0; window < MAX_WINDOWS_PER_USER; window++) {
      requests.push(status(fetch, chatRequest('deepseek-v4-flash', user, window, { gatewayToken: sharedToken })))
    }
  }

  await eventually(async () => {
    const capacity = await health(fetch, sharedToken)
    return upstream.stats.deepseek.calls === MAX_TOTAL && capacity.deepseek.active === MAX_TOTAL && capacity.deepseek.queued === 0
  }, 'default 1000 active + zero queued DeepSeek calls', 10_000)
  expect(upstream.stats.deepseek).toMatchObject({ calls: MAX_TOTAL, inFlight: MAX_TOTAL, peak: MAX_TOTAL })

  upstream.openText()
  expect((await Promise.all(requests)).every(value => value === 200)).toBe(true)
  const identityCounts = countBy(upstream.seenByKind.deepseek)
  expect(identityCounts.size).toBe(USERS)
  expect([...identityCounts.values()].every(count => count === MAX_WINDOWS_PER_USER)).toBe(true)
  expect((await health(fetch, sharedToken)).deepseek).toEqual({ active: 0, queued: 0 })
})

test('100 用户 × 5 窗口：默认 MiMo 视觉预留只接纳 12 在途 + 24 排队，其余 464 立即429', async () => {
  const upstream = createFakeUpstream({ holdVision: true })
  const fetch = createGatewayFetch({
    env: env({
      GW_DEEPSEEK_CONC: '500', GW_DEEPSEEK_USER_CONC: '5', GW_DEEPSEEK_TOKEN_CONC: '5',
      // Explicitly clear the fixture's small test pool: this assertion locks the
      // production 64=52+12 / 1 / 64 / 64 / 5 MiMo profile rather than a synthetic lane.
      GW_MIMO_CONC: undefined, GW_MIMO_NATIVE_CONC: undefined, GW_MIMO_USER_CONC: undefined, GW_MIMO_TOKEN_CONC: undefined,
      GW_MIMO_INFLIGHT_PER_USER: undefined,
      GW_MIMO_QUEUE_MAX: undefined, GW_MIMO_QUEUE_MAX_WAIT: undefined,
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const requests: Array<Promise<number>> = []
  for (let user = 0; user < USERS; user++) {
    for (let window = 0; window < WINDOWS_PER_USER; window++) {
      requests.push(status(fetch, chatRequest('deepseek-v4-flash', user, window, { image: true })))
    }
  }

  await eventually(() => upstream.stats.mimoVision.calls === 12, 'default 12 visual calls')
  expect((await health(fetch)).mimo).toEqual({ active: 12, queued: 24 })
  expect((await health(fetch)).mimoNative).toEqual({ active: 0, queued: 0 })
  expect((await health(fetch)).vision).toEqual({ active: 12, queued: 24 })
  upstream.openVision()
  const statuses = await Promise.all(requests)
  expect(statuses.filter(value => value === 200)).toHaveLength(36)
  expect(statuses.filter(value => value === 429)).toHaveLength(464)
  expect(upstream.stats.mimoVision.peak).toBe(12)
  expect(upstream.stats.deepseek.calls).toBe(36)
  expect((await health(fetch)).mimo).toEqual({ active: 0, queued: 0 })
  expect((await health(fetch)).mimoNative).toEqual({ active: 0, queued: 0 })
  expect((await health(fetch)).deepseek).toEqual({ active: 0, queued: 0 })
})

test('100 用户 × 5 窗口：显式 50 原生 + 50 视觉硬分区、50/450 视觉阀门后，整批 500 可排空', async () => {
  const upstream = createFakeUpstream({ holdVision: true })
  const fetch = createGatewayFetch({
    env: env({
      GW_DEEPSEEK_CONC: '500', GW_DEEPSEEK_USER_CONC: '5', GW_DEEPSEEK_TOKEN_CONC: '5',
      // This is an explicit canary profile, not the production default: capacity is
      // widened consistently at both layers so the visual semaphore has 50 actual
      // physical reservations instead of borrowing from native traffic.
      GW_MIMO_CONC: '100', GW_MIMO_NATIVE_CONC: '50', GW_MIMO_USER_CONC: '5', GW_MIMO_INFLIGHT_PER_USER: '5', GW_MIMO_TOKEN_CONC: '50',
      GW_MIMO_QUEUE_MAX: '450', GW_MIMO_QUEUE_MAX_WAIT: '10',
      GW_VISION_CONC: '50', GW_VISION_QUEUE_MAX: '450', GW_VISION_QUEUE_MAX_WAIT_MS: '10000',
      GW_VISION_PER_CLIENT_CONC: '1', GW_VISION_MAX_INFLIGHT_PER_CLIENT: '5', GW_VISION_PER_REQUEST_CONC: '1',
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const requests: Array<Promise<number>> = []
  for (let user = 0; user < USERS; user++) {
    for (let window = 0; window < WINDOWS_PER_USER; window++) {
      requests.push(status(fetch, chatRequest('deepseek-v4-flash', user, window, { image: true })))
    }
  }

  await eventually(() => upstream.stats.mimoVision.calls === 50, '50 visual permits')
  expect(upstream.stats.mimoVision).toMatchObject({ calls: 50, inFlight: 50, peak: 50 })
  expect(upstream.stats.mimoText.inFlight + upstream.stats.mimoVision.inFlight).toBe(50)
  upstream.openVision()
  expect((await Promise.all(requests)).every(value => value === 200)).toBe(true)
  expect(upstream.stats.mimoVision).toMatchObject({ calls: TOTAL, inFlight: 0, peak: 50 })
  expect(upstream.stats.deepseek.calls).toBe(TOTAL)
  expect((await health(fetch)).deepseek).toEqual({ active: 0, queued: 0 })
})

test('默认 MiMo profile:同一共享产品 token 的原生文本与视觉桥接硬分为52+12，真实上游合计为64', async () => {
  const upstream = createFakeUpstream({ holdText: true, holdVision: true })
  const sharedToken = 'shared-desktop-token'
  const fetch = createGatewayFetch({
    env: env({
      GW_APP_TOKENS: JSON.stringify({ [sharedToken]: 'shared-product-token' }),
      GW_MIMO_CONC: undefined, GW_MIMO_NATIVE_CONC: undefined, GW_MIMO_USER_CONC: undefined, GW_MIMO_TOKEN_CONC: undefined,
      GW_MIMO_INFLIGHT_PER_USER: undefined,
      GW_MIMO_QUEUE_MAX: undefined, GW_MIMO_QUEUE_MAX_WAIT: undefined,
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  // Reserve 52 native slots and 12 bridge slots across distinct installations. This
  // proves the physical hard partition still totals 64 under one shared app token.
  const text = Array.from({ length: 52 }, (_, index) => status(fetch, chatRequest('mimo-v2.5', index, 0, { gatewayToken: sharedToken })))
  const image = Array.from({ length: 12 }, (_, index) => status(fetch, chatRequest('deepseek-v4-flash', index + 52, 0, { image: true, gatewayToken: sharedToken })))

  await eventually(() => upstream.stats.mimoText.calls === 52 && upstream.stats.mimoVision.calls === 12, 'both shared MiMo paths admitted')
  expect(upstream.stats.mimoText.peak).toBe(52)
  expect(upstream.stats.mimoVision.peak).toBe(12)
  expect(upstream.stats.mimoText.inFlight + upstream.stats.mimoVision.inFlight).toBe(64)
  const busy = await health(fetch, sharedToken)
  expect(busy.mimo).toMatchObject({ active: 64, queued: 0 })
  expect(busy.mimoNative).toMatchObject({ active: 52, queued: 0 })
  expect(busy.vision).toMatchObject({ active: 12, queued: 0 })

  upstream.openText()
  upstream.openVision()
  expect((await Promise.all([...text, ...image])).every(value => value === 200)).toBe(true)
  expect(upstream.stats.mimoText.inFlight + upstream.stats.mimoVision.inFlight).toBe(0)
  expect((await health(fetch, sharedToken)).mimo).toEqual({ active: 0, queued: 0 })
})

test('500 路 DeepSeek 峰值中，100 个排队请求取消后不进入上游、其余 400 路完成且许可归零', async () => {
  const upstream = createFakeUpstream({ holdText: true })
  const fetch = createGatewayFetch({
    env: env({
      GW_DEEPSEEK_CONC: '100',
      GW_DEEPSEEK_USER_CONC: '5',
      GW_DEEPSEEK_TOKEN_CONC: '5',
      // The implementation now has a finite chat queue. This scenario intentionally
      // admits all 400 waiters so that the next assertion exercises abort removal,
      // rather than the separate queue-overflow path.
      GW_DEEPSEEK_QUEUE_MAX: '400',
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  // 先占满 100 个真实上游位，再送入 400 个必然排队的请求；这样取消的 100 路不会误伤
  // 已实际发往上游的请求，专门覆盖 FairCapacityScheduler 的 abort 出队路径。
  const held = Array.from({ length: USERS }, (_, user) => status(fetch, chatRequest('deepseek-v4-flash', user, 0)))
  await eventually(() => upstream.stats.deepseek.calls === USERS, '100 held DeepSeek calls')

  const queued: Array<Promise<number>> = []
  const cancelled: Array<Promise<number>> = []
  const controllers: AbortController[] = []
  for (let user = 0; user < USERS; user++) {
    for (let window = 1; window < WINDOWS_PER_USER; window++) {
      const shouldCancel = (user >= 75 && window === WINDOWS_PER_USER - 1)
        || (user < 75 && window === WINDOWS_PER_USER - 2)
      if (shouldCancel) {
        const controller = new AbortController()
        controllers.push(controller)
        cancelled.push(status(fetch, chatRequest('deepseek-v4-flash', user, window, { signal: controller.signal })))
      } else {
        queued.push(status(fetch, chatRequest('deepseek-v4-flash', user, window)))
      }
    }
  }
  expect(cancelled).toHaveLength(100)
  await eventually(async () => (await health(fetch)).deepseek.queued === 400, '400 queued DeepSeek calls')
  for (const controller of controllers) controller.abort()
  expect((await Promise.all(cancelled)).every(value => value === 499)).toBe(true)
  await eventually(async () => (await health(fetch)).deepseek.queued === 300, '300 remaining queued DeepSeek calls')

  upstream.openText()
  expect((await Promise.all([...held, ...queued])).every(value => value === 200)).toBe(true)
  expect(upstream.stats.deepseek).toMatchObject({ calls: 400, inFlight: 0, peak: 100 })
  expect((await health(fetch)).deepseek).toEqual({ active: 0, queued: 0 })
})
