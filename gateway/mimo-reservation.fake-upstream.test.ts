import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'
import { gatewayTestAccessToken, gatewayTestAccessTokenFor, gatewayTestAuthority } from './auth/testFixture'

type Lane = 'native' | 'vision' | 'deepseek'
type LaneStat = { calls: number; inFlight: number; peak: number }

const tick = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function eventually(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + label)
    await tick()
  }
}

function gate() {
  let opened = false
  const waiters = new Set<() => void>()
  return {
    wait(): Promise<void> {
      if (opened) return Promise.resolve()
      return new Promise(resolve => waiters.add(resolve))
    },
    open(): void {
      if (opened) return
      opened = true
      for (const resolve of waiters) resolve()
      waiters.clear()
    },
  }
}

function isVisionBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as {
      stream?: unknown
      messages?: Array<{ content?: unknown }>
    }
    return parsed.stream === false && Array.isArray(parsed.messages?.[0]?.content)
  } catch {
    return false
  }
}

function makeUpstream(options: { holdNative?: boolean; holdVision?: boolean } = {}) {
  const nativeGate = gate()
  const visionGate = gate()
  const stats: Record<Lane, LaneStat> = {
    native: { calls: 0, inFlight: 0, peak: 0 },
    vision: { calls: 0, inFlight: 0, peak: 0 },
    deepseek: { calls: 0, inFlight: 0, peak: 0 },
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? init.body : ''
    const lane: Lane = url.includes('deepseek.example')
      ? 'deepseek'
      : isVisionBody(body)
        ? 'vision'
        : 'native'
    const stat = stats[lane]
    stat.calls += 1
    stat.inFlight += 1
    stat.peak = Math.max(stat.peak, stat.inFlight)
    try {
      if (lane === 'native' && options.holdNative) await nativeGate.wait()
      if (lane === 'vision' && options.holdVision) await visionGate.wait()
      if (lane === 'vision') {
        return Response.json({ choices: [{ message: { content: 'fake vision result' } }] })
      }
      return new Response('data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } })
    } finally {
      stat.inFlight -= 1
    }
  }

  return {
    fetchImpl,
    nativeGate,
    visionGate,
    stats,
  }
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
    GW_MIMO_KEY: 'mimo-secret',
    GW_MIMO_BASE: 'https://mimo.example/v1',
    GW_MIMO_MODEL: 'mimo-v2.5',
    GW_MIMO_RPM: '1000000',
    GW_MIMO_CONC: '64',
    GW_MIMO_NATIVE_CONC: '52',
    GW_MIMO_USER_CONC: '1',
    GW_MIMO_INFLIGHT_PER_USER: '1',
    GW_MIMO_TOKEN_CONC: '64',
    GW_MIMO_QUEUE_MAX: '0',
    GW_MIMO_QUEUE_MAX_WAIT: '1',
    GW_DEEPSEEK_KEY: 'deepseek-secret',
    GW_DEEPSEEK_BASE: 'https://deepseek.example',
    GW_DEEPSEEK_MODEL: 'deepseek-v4-flash',
    GW_DEEPSEEK_RPM: '1000000',
    GW_DEEPSEEK_CONC: '64',
    GW_DEEPSEEK_USER_CONC: '1',
    GW_DEEPSEEK_TOKEN_CONC: '64',
    GW_DEEPSEEK_QUEUE_MAX: '0',
    GW_DEEPSEEK_QUEUE_MAX_WAIT: '1',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_APP_TOKENS: JSON.stringify({ gatewayTestAccessToken: 'shared-owner' }),
    GW_VISION_MAX_IMAGES: '1',
    GW_VISION_MAX_IMAGE_BYTES: '2000000',
    GW_VISION_MAX_TOTAL_BYTES: '5000000',
    GW_VISION_TIMEOUT_MS: '10000',
    GW_VISION_CONC: '12',
    GW_VISION_QUEUE_MAX: '1',
    GW_VISION_QUEUE_MAX_WAIT_MS: '3000',
    GW_VISION_PER_CLIENT_CONC: '1',
    GW_VISION_MAX_INFLIGHT_PER_CLIENT: '1',
    GW_VISION_PER_REQUEST_CONC: '1',
    GW_VISION_CACHE_MAX: '1',
    GW_VISION_CACHE_TTL_MS: '1',
    ...overrides,
  }
}

function nativeRequest(client: string, gatewayToken = gatewayTestAccessToken): Request {
  return new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + gatewayTestAccessTokenFor(gatewayToken),
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

function bridgeRequest(client: string, imageIndex: number, gatewayToken = gatewayTestAccessToken): Request {
  const image = Buffer.from('bridge-image-' + imageIndex).toString('base64')
  return new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + gatewayTestAccessTokenFor(gatewayToken),
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
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image } },
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

async function health(fetch: (request: Request) => Promise<Response>) {
  const response = await fetch(new Request('http://local/healthz', {
    headers: { Authorization: `Bearer ${gatewayTestAccessToken}` },
  }))
  expect(response.status).toBe(200)
  return await response.json() as {
    capacity: {
      mimo: { active: number; queued: number; maxConcurrent: number }
      mimo_native: { active: number; queued: number; maxConcurrent: number }
      mimo_total: {
        active: number
        queued: number
        maxConcurrent: number
        nativeReserved: number
        visionReserved: number
      }
      vision: { active: number; queued: number; limit: number }
    }
  }
}

function client(prefix: string, index: number): string {
  return prefix + '-' + String(index).padStart(3, '0')
}

test('MiMo reserves 52 native slots and 12 bridge slots: a native flood cannot consume the visual lane', async () => {
  const upstream = makeUpstream({ holdNative: true, holdVision: true })
  const fetch = createGatewayFetch({
    authority: gatewayTestAuthority,
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const held: Array<Promise<number>> = []

  try {
    for (let index = 0; index < 52; index++) {
      held.push(status(fetch, nativeRequest(client('native-holder', index))))
    }
    await eventually(() => upstream.stats.native.calls === 52, '52 native MiMo calls')
    expect(upstream.stats.native).toMatchObject({ calls: 52, inFlight: 52, peak: 52 })

    const nativeOverflow = await Promise.all(
      Array.from({ length: 12 }, (_, index) => status(fetch, nativeRequest(client('native-overflow', index)))),
    )
    expect(nativeOverflow).toEqual(Array.from({ length: 12 }, () => 429))
    expect(upstream.stats.native.calls).toBe(52)

    for (let index = 0; index < 12; index++) {
      held.push(status(fetch, bridgeRequest(client('bridge-holder', index), index)))
    }
    await eventually(() => upstream.stats.vision.calls === 12, '12 bridge MiMo calls')
    expect(upstream.stats.vision).toMatchObject({ calls: 12, inFlight: 12, peak: 12 })
    expect(upstream.stats.native.inFlight + upstream.stats.vision.inFlight).toBe(64)

    const busy = await health(fetch)
    expect(busy.capacity.mimo).toMatchObject({ active: 64, queued: 0, maxConcurrent: 64 })
    expect(busy.capacity.mimo_native).toMatchObject({ active: 52, queued: 0, maxConcurrent: 52 })
    expect(busy.capacity.vision).toMatchObject({ active: 12, queued: 0, limit: 12 })
    expect(busy.capacity.mimo_total).toMatchObject({
      active: 64,
      queued: 0,
      maxConcurrent: 64,
      nativeReserved: 52,
      visionReserved: 12,
    })

    upstream.nativeGate.open()
    upstream.visionGate.open()
    expect((await Promise.all(held)).every(value => value === 200)).toBe(true)
    const drained = await health(fetch)
    expect(drained.capacity.mimo_total).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
  } finally {
    upstream.nativeGate.open()
    upstream.visionGate.open()
    await Promise.allSettled(held)
  }
})

test('default one-slot installation limit spans native and bridge MiMo without occupying the other lane', async () => {
  const upstream = makeUpstream({ holdNative: true, holdVision: true })
  const fetch = createGatewayFetch({
    authority: gatewayTestAuthority,
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const sameClient = 'same-installation-0001'
  const native = status(fetch, nativeRequest(sameClient))

  try {
    await eventually(() => upstream.stats.native.calls === 1, 'native request to enter upstream')
    expect(await status(fetch, bridgeRequest(sameClient, 1))).toBe(429)
    expect(upstream.stats.vision.calls).toBe(0)
    expect((await health(fetch)).capacity.mimo_total).toMatchObject({ active: 1, queued: 0 })

    upstream.nativeGate.open()
    expect(await native).toBe(200)
    await eventually(async () => (await health(fetch)).capacity.mimo_total.active === 0, 'native reservation release')

    const heldBridge = status(fetch, bridgeRequest(sameClient, 2))
    await eventually(() => upstream.stats.vision.calls === 1, 'bridge request to enter upstream')
    expect(await status(fetch, nativeRequest(sameClient))).toBe(429)
    expect(upstream.stats.native.calls).toBe(1)

    upstream.visionGate.open()
    expect(await heldBridge).toBe(200)
    expect(await status(fetch, nativeRequest(sameClient))).toBe(200)
    expect(upstream.stats.vision).toMatchObject({ calls: 1, peak: 1 })
    expect(upstream.stats.deepseek).toMatchObject({ calls: 1, peak: 1 })
    expect(upstream.stats.native).toMatchObject({ calls: 2, peak: 1 })
    expect((await health(fetch)).capacity.mimo_total).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
  } finally {
    upstream.nativeGate.open()
    upstream.visionGate.open()
    await Promise.allSettled([native])
  }
})

test('an explicit two-slot installation allowance admits one native and one bridge call, then rejects the third', async () => {
  const upstream = makeUpstream({ holdNative: true, holdVision: true })
  const fetch = createGatewayFetch({
    authority: gatewayTestAuthority,
    env: env({
      GW_MIMO_CONC: '3',
      GW_MIMO_NATIVE_CONC: '2',
      GW_VISION_CONC: '1',
      GW_MIMO_USER_CONC: '2',
      GW_MIMO_INFLIGHT_PER_USER: '2',
      GW_MIMO_TOKEN_CONC: '3',
      GW_VISION_PER_CLIENT_CONC: '2',
      GW_VISION_MAX_INFLIGHT_PER_CLIENT: '2',
      GW_MIMO_QUEUE_MAX: '0',
      GW_VISION_QUEUE_MAX: '0',
      GW_VISION_QUEUE_MAX_WAIT_MS: '20',
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const sameClient = 'two-slot-installation'
  const native = status(fetch, nativeRequest(sameClient))
  const bridge = status(fetch, bridgeRequest(sameClient, 10))

  try {
    await eventually(() => upstream.stats.native.calls === 1 && upstream.stats.vision.calls === 1, 'native and bridge calls')
    expect((await health(fetch)).capacity.mimo_total).toMatchObject({ active: 2, queued: 0, maxConcurrent: 3 })
    expect(await status(fetch, nativeRequest(sameClient))).toBe(429)
    expect(upstream.stats.native.calls).toBe(1)

    upstream.nativeGate.open()
    upstream.visionGate.open()
    expect(await native).toBe(200)
    expect(await bridge).toBe(200)
    expect((await health(fetch)).capacity.mimo_total).toMatchObject({ active: 0, queued: 0 })
  } finally {
    upstream.nativeGate.open()
    upstream.visionGate.open()
    await Promise.allSettled([native, bridge])
  }
})

test('one token cannot bypass its MiMo account ceiling by mixing native and bridge lanes', async () => {
  const upstream = makeUpstream({ holdNative: true, holdVision: true })
  const tokenA = 'token-a'
  const tokenB = 'token-b'
  const fetch = createGatewayFetch({
    authority: gatewayTestAuthority,
    env: env({
      GW_APP_TOKENS: JSON.stringify({ [tokenA]: 'test-principal:test-installation', [tokenB]: 'owner-b' }),
      GW_MIMO_CONC: '4',
      GW_MIMO_NATIVE_CONC: '2',
      GW_VISION_CONC: '2',
      GW_MIMO_USER_CONC: '2',
      GW_MIMO_INFLIGHT_PER_USER: '2',
      GW_MIMO_TOKEN_CONC: '3',
      GW_VISION_PER_CLIENT_CONC: '2',
      GW_VISION_MAX_INFLIGHT_PER_CLIENT: '2',
      GW_MIMO_QUEUE_MAX: '0',
      GW_VISION_QUEUE_MAX: '0',
      GW_VISION_QUEUE_MAX_WAIT_MS: '20',
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const nativeA1 = status(fetch, nativeRequest('a-native-1', tokenA))
  const nativeA2 = status(fetch, nativeRequest('a-native-2', tokenA))
  const bridgeA = status(fetch, bridgeRequest('a-vision-1', 20, tokenA))
  const bridgeB = status(fetch, bridgeRequest('b-vision-1', 21, tokenB))

  try {
    await eventually(() => upstream.stats.native.calls === 2 && upstream.stats.vision.calls === 2, 'cross-token visual admission')
    expect(await status(fetch, bridgeRequest('a-vision-overflow', 22, tokenA))).toBe(429)
    expect(upstream.stats.vision.calls).toBe(2)

    upstream.nativeGate.open()
    upstream.visionGate.open()
    expect((await Promise.all([nativeA1, nativeA2, bridgeA, bridgeB])).every(value => value === 200)).toBe(true)
  } finally {
    upstream.nativeGate.open()
    upstream.visionGate.open()
    await Promise.allSettled([nativeA1, nativeA2, bridgeA, bridgeB])
  }
})
