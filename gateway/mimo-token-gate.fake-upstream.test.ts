// 这组测试只验证 MiMo 账户 token 的跨物理分区上游上限。原生聊天和图片桥接各有
// 自己的保留槽位；两条路径合起来仍必须服从 GW_MIMO_TOKEN_CONC，不能因伪造多个
// X-QF-Client-ID 而让同一 app token 同时打穿两个分区。

import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'

type MimoLane = 'native' | 'vision'

type LaneStats = {
  calls: number
  inFlight: number
  peak: number
}

const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function eventually(check: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await tick()
  }
}

function heldGate() {
  let open = false
  const waiters = new Set<() => void>()
  return {
    wait(): Promise<void> {
      if (open) return Promise.resolve()
      return new Promise(resolve => waiters.add(resolve))
    },
    open(): void {
      if (open) return
      open = true
      for (const resolve of waiters) resolve()
      waiters.clear()
    },
  }
}

function isVisionBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { stream?: unknown; messages?: Array<{ content?: unknown }> }
    return parsed.stream === false && Array.isArray(parsed.messages?.[0]?.content)
  } catch {
    return false
  }
}

function makeHeldMimoUpstream() {
  const nativeGate = heldGate()
  const visionGate = heldGate()
  let totalPeak = 0
  const stats: Record<MimoLane, LaneStats> = {
    native: { calls: 0, inFlight: 0, peak: 0 },
    vision: { calls: 0, inFlight: 0, peak: 0 },
  }
  const totalInFlight = () => stats.native.inFlight + stats.vision.inFlight

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (!url.includes('mimo.example')) {
      if (url.includes('deepseek.example')) {
        return new Response('data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }

    const lane: MimoLane = isVisionBody(typeof init?.body === 'string' ? init.body : '') ? 'vision' : 'native'
    const laneStats = stats[lane]
    laneStats.calls += 1
    laneStats.inFlight += 1
    laneStats.peak = Math.max(laneStats.peak, laneStats.inFlight)
    totalPeak = Math.max(totalPeak, totalInFlight())
    try {
      await (lane === 'native' ? nativeGate.wait() : visionGate.wait())
      return lane === 'vision'
        ? Response.json({ choices: [{ message: { content: 'fake vision result' } }] })
        : new Response('data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
    } finally {
      laneStats.inFlight -= 1
    }
  }

  return { fetchImpl, nativeGate, visionGate, stats, totalInFlight, totalPeak: () => totalPeak }
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GW_MIMO_KEY: 'mimo-secret',
    GW_MIMO_BASE: 'https://mimo.example/v1',
    GW_MIMO_MODEL: 'mimo-v2.5',
    GW_MIMO_RPM: '1000000',
    // Keep the default physical reservation explicit: native 52 + bridge 12 = account 64.
    // The small token ceiling is intentionally lower so this test exercises the shared gate,
    // rather than either physical lane's own capacity.
    GW_MIMO_CONC: '64',
    GW_MIMO_NATIVE_CONC: '52',
    GW_MIMO_TOKEN_CONC: '5',
    GW_MIMO_USER_CONC: '5',
    GW_MIMO_INFLIGHT_PER_USER: '5',
    GW_MIMO_QUEUE_MAX: '0',
    GW_MIMO_QUEUE_MAX_WAIT: '1',
    GW_MIMO_MAX_RETRIES: '0',
    GW_DEEPSEEK_KEY: 'deepseek-secret',
    GW_DEEPSEEK_BASE: 'https://deepseek.example/v1',
    GW_DEEPSEEK_MODEL: 'deepseek-v4-flash',
    GW_DEEPSEEK_RPM: '1000000',
    GW_DEEPSEEK_CONC: '64',
    GW_DEEPSEEK_USER_CONC: '8',
    GW_DEEPSEEK_TOKEN_CONC: '64',
    GW_DEEPSEEK_QUEUE_MAX: '0',
    GW_DEEPSEEK_QUEUE_MAX_WAIT: '1',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_VISION_MAX_IMAGES: '1',
    GW_VISION_MAX_IMAGE_BYTES: '2000000',
    GW_VISION_MAX_TOTAL_BYTES: '5000000',
    GW_VISION_TIMEOUT_MS: '10000',
    GW_VISION_CONC: '12',
    GW_VISION_QUEUE_MAX: '0',
    // app.ts keeps a one-entry visual queue even when a deployment asks for zero, so
    // use a tiny window here: this test verifies "never reaches the sixth upstream",
    // not a one-second timeout path.
    GW_VISION_QUEUE_MAX_WAIT_MS: '25',
    GW_VISION_PER_CLIENT_CONC: '1',
    GW_VISION_MAX_INFLIGHT_PER_CLIENT: '1',
    GW_VISION_PER_REQUEST_CONC: '1',
    GW_VISION_CACHE_MAX: '1',
    GW_VISION_CACHE_TTL_MS: '1',
    GW_APP_TOKENS: JSON.stringify({ 'shared-app-token': 'same-owner' }),
    ...overrides,
  }
}

function nativeRequest(client: string): Request {
  return new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer shared-app-token',
      'Content-Type': 'application/json',
      'X-QF-Client-ID': client,
    },
    body: JSON.stringify({
      model: 'mimo-v2.5',
      stream: true,
      messages: [{ role: 'user', content: 'native MiMo request' }],
    }),
  })
}

function bridgeRequest(client: string, imageIndex: number): Request {
  const image = Buffer.from(`unique-bridge-image-${imageIndex}`).toString('base64')
  return new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer shared-app-token',
      'Content-Type': 'application/json',
      'X-QF-Client-ID': client,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
        ],
      }],
    }),
  })
}

async function status(fetch: (request: Request) => Promise<Response>, request: Request): Promise<number> {
  const response = await fetch(request)
  await response.text()
  return response.status
}

function client(lane: string, index: number): string {
  return `${lane}-desktop-${String(index).padStart(2, '0')}`
}

async function expectRejectedWithoutSixthMimoCall(
  extra: Promise<number>,
  upstream: ReturnType<typeof makeHeldMimoUpstream>,
): Promise<void> {
  let extraStatus: number | undefined
  void extra.then(value => { extraStatus = value })
  // In a broken cross-lane implementation this resolves as soon as the sixth fake MiMo
  // request enters its held upstream. A correct implementation rejects it before any
  // sixth MiMo request is made (after at most the explicitly tiny visual wait window).
  await eventually(
    () => extraStatus !== undefined || upstream.totalInFlight() > 5,
    'cross-lane token gate decision',
  )
  expect(upstream.totalInFlight()).toBeLessThanOrEqual(5)
  expect(upstream.totalPeak()).toBeLessThanOrEqual(5)
  expect(extraStatus).toBe(429)
}

test('GW_MIMO_TOKEN_CONC=5 caps five distinct-client native calls plus a bridge call for the same app token', async () => {
  const upstream = makeHeldMimoUpstream()
  const fetch = createGatewayFetch({
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const held = Array.from({ length: 5 }, (_, index) => status(fetch, nativeRequest(client('native', index))))
  const tracked: Array<Promise<unknown>> = [...held]

  try {
    await eventually(() => upstream.stats.native.inFlight === 5, 'five held native MiMo calls')
    expect(upstream.totalInFlight()).toBe(5)

    const bridgeOverflow = status(fetch, bridgeRequest(client('bridge-overflow', 0), 0))
    tracked.push(bridgeOverflow)
    await expectRejectedWithoutSixthMimoCall(bridgeOverflow, upstream)
    expect(upstream.stats.vision.calls).toBe(0)

    upstream.nativeGate.open()
    expect(await Promise.all(held)).toEqual(Array.from({ length: 5 }, () => 200))
    await eventually(() => upstream.totalInFlight() === 0, 'native MiMo calls to drain')

    // A fresh bridge from the same token must be admitted after the held native calls
    // complete; a unique image avoids the bridge cache masking a missing permit release.
    const recovered = status(fetch, bridgeRequest(client('bridge-recovered', 0), 1))
    tracked.push(recovered)
    await eventually(() => upstream.stats.vision.inFlight === 1, 'recovered bridge MiMo call')
    upstream.visionGate.open()
    expect(await recovered).toBe(200)
    await eventually(() => upstream.totalInFlight() === 0, 'recovered bridge call to drain')
    expect(upstream.totalPeak()).toBeLessThanOrEqual(5)
  } finally {
    upstream.nativeGate.open()
    upstream.visionGate.open()
    await Promise.allSettled(tracked)
  }
})

test('GW_MIMO_TOKEN_CONC=5 caps five distinct-client bridge calls plus a native call for the same app token', async () => {
  const upstream = makeHeldMimoUpstream()
  const fetch = createGatewayFetch({
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const held = Array.from({ length: 5 }, (_, index) => status(fetch, bridgeRequest(client('bridge', index), index)))
  const tracked: Array<Promise<unknown>> = [...held]

  try {
    await eventually(() => upstream.stats.vision.inFlight === 5, 'five held bridge MiMo calls')
    expect(upstream.totalInFlight()).toBe(5)

    const nativeOverflow = status(fetch, nativeRequest(client('native-overflow', 0)))
    tracked.push(nativeOverflow)
    await expectRejectedWithoutSixthMimoCall(nativeOverflow, upstream)
    expect(upstream.stats.native.calls).toBe(0)

    upstream.visionGate.open()
    expect(await Promise.all(held)).toEqual(Array.from({ length: 5 }, () => 200))
    await eventually(() => upstream.totalInFlight() === 0, 'bridge MiMo calls to drain')

    const recovered = status(fetch, nativeRequest(client('native-recovered', 0)))
    tracked.push(recovered)
    await eventually(() => upstream.stats.native.inFlight === 1, 'recovered native MiMo call')
    upstream.nativeGate.open()
    expect(await recovered).toBe(200)
    await eventually(() => upstream.totalInFlight() === 0, 'recovered native call to drain')
    expect(upstream.totalPeak()).toBeLessThanOrEqual(5)
  } finally {
    upstream.nativeGate.open()
    upstream.visionGate.open()
    await Promise.allSettled(tracked)
  }
})
