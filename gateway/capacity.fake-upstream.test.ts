// 假 upstream 容量证据(不连真上游):证明 50~100 装机、峰值并发下三家独立池的公平调度、隔离、
// 二级 token 闸、以及各类错误/中断路径下不泄漏并发许可。
//
// 手法:一个"闸门 + 分池"假 upstream —— 每个上游调用按 URL 归类到 qwen/mimo/deepseek 池,进入时
// 计数(反映当前占用的并发许可)并挂起在闸门上;测试先在闸门关闭时测峰值(=容量上限),再开闸放行、
// 消费全部响应体、断言全部成功;并用鉴权 healthz 的 capacity 快照断言收尾后 active/queued 归零。

import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GW_QWEN_KEY: 'qwen-secret', GW_QWEN_BASE: 'https://qwen.example/v1', GW_QWEN_MODEL: 'qwen3-coder-plus',
    GW_QWEN_CONC: '16', GW_QWEN_USER_CONC: '2', GW_QWEN_RPM: '1000000', GW_QWEN_QUEUE_MAX_WAIT: '30', GW_QWEN_MAX_RETRIES: '1',
    GW_QWEN_QUEUE_MAX: '512',
    GW_MIMO_KEY: 'mimo-secret', GW_MIMO_BASE: 'https://mimo.example/v1', GW_MIMO_MODEL: 'mimo-v2.5',
    // Keep a dedicated 16-slot native lane while reserving the normal 12 visual slots.
    // This makes the generic scheduler cases explicit rather than relying on the old
    // shared-pool interpretation of GW_MIMO_CONC.
    GW_MIMO_CONC: '28', GW_MIMO_NATIVE_CONC: '16', GW_MIMO_USER_CONC: '2', GW_MIMO_INFLIGHT_PER_USER: '5', GW_MIMO_RPM: '1000000', GW_MIMO_QUEUE_MAX_WAIT: '30', GW_MIMO_MAX_RETRIES: '1',
    GW_MIMO_QUEUE_MAX: '512',
    GW_DEEPSEEK_KEY: 'deepseek-secret', GW_DEEPSEEK_BASE: 'https://deepseek.example', GW_DEEPSEEK_MODEL: 'deepseek-v4-flash',
    GW_DEEPSEEK_CONC: '32', GW_DEEPSEEK_USER_CONC: '2', GW_DEEPSEEK_RPM: '1000000', GW_DEEPSEEK_QUEUE_MAX_WAIT: '30', GW_DEEPSEEK_MAX_RETRIES: '1',
    GW_DEEPSEEK_QUEUE_MAX: '512',
    GW_RELAY_BASE: 'https://relay.example/v1', GW_RELAY_TOKEN: 'relay-secret',
    GW_APP_TOKENS: JSON.stringify({ 'app-token': 'beta' }),
    ...overrides,
  }
}

type Pool = 'qwen' | 'mimo' | 'deepseek'
const POOLS: Array<{ pool: Pool; model: string; conc: number; host: string }> = [
  { pool: 'qwen', model: 'qwen3-coder-plus', conc: 16, host: 'qwen.example' },
  { pool: 'mimo', model: 'mimo-v2.5', conc: 16, host: 'mimo.example' },
  { pool: 'deepseek', model: 'deepseek-v4-flash', conc: 32, host: 'deepseek.example' },
]

/** 闸门分池假 upstream:按 URL 归类到三池,记录每池在途/峰值/调用数,gate 控制放行;cross=错路由。 */
function poolUpstream() {
  const stats = {
    qwen: { inFlight: 0, peak: 0, calls: 0 },
    mimo: { inFlight: 0, peak: 0, calls: 0 },
    deepseek: { inFlight: 0, peak: 0, calls: 0 },
    cross: 0,
  }
  let gateOpen = false
  const waiters: Array<() => void> = []
  const poolOf = (url: string): Pool | null =>
    url.includes('qwen.example') ? 'qwen' : url.includes('mimo.example') ? 'mimo' : url.includes('deepseek.example') ? 'deepseek' : null
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (!url.endsWith('/chat/completions')) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    const pool = poolOf(url)
    if (!pool) { stats.cross += 1; return new Response('{}', { headers: { 'content-type': 'application/json' } }) }
    const s = stats[pool]
    s.calls += 1; s.inFlight += 1; s.peak = Math.max(s.peak, s.inFlight)
    await new Promise<void>(resolve => { if (gateOpen) resolve(); else waiters.push(resolve) })
    s.inFlight -= 1
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetchImpl, stats, open() { gateOpen = true; for (const w of waiters.splice(0)) w() } }
}

function makeGateway(fetchImpl: (input: RequestInfo | URL) => Promise<Response>, overrides: Record<string, string | undefined> = {}) {
  return makeGatewayWithUsage(fetchImpl, overrides).fetch
}

function makeGatewayWithUsage(fetchImpl: (input: RequestInfo | URL) => Promise<Response>, overrides: Record<string, string | undefined> = {}) {
  const usage = new MemoryUsageStore()
  return {
    fetch: createGatewayFetch({ env: env(overrides), usageStore: usage, transcribeImpl: null, fetchImpl }),
    usage,
  }
}

function chatReq(model: string, client: string | null, token = 'app-token', signal?: AbortSignal): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  if (client) headers['X-QF-Client-ID'] = client
  return new Request('http://local/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, stream: true }), signal })
}

function fire(fetch: (r: Request) => Promise<Response>, model: string, client: string | null, token = 'app-token'): Promise<number> {
  return fetch(chatReq(model, client, token)).then(async res => { await res.text(); return res.status })
}

async function capacity(fetch: (r: Request) => Promise<Response>): Promise<Record<Pool, { active: number; queued: number }>> {
  const res = await fetch(new Request('http://local/healthz', { headers: { Authorization: 'Bearer app-token' } }))
  const cap = (await res.json()).capacity as Record<Pool, { active: number; queued: number }>
  // project just active/queued (snapshot also carries the static max* fields)
  return {
    qwen: { active: cap.qwen.active, queued: cap.qwen.queued },
    mimo: { active: cap.mimo.active, queued: cap.mimo.queued },
    deepseek: { active: cap.deepseek.active, queued: cap.deepseek.queued },
  }
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (check()) return
    await tick(10)
  }
  throw new Error('timed out waiting for fake upstream capacity state')
}

// ── 三池分别:100 装机 × 2 请求 ──────────────────────────────────
for (const p of POOLS) {
  test(`${p.model}: 100 装机×2 请求在全局 ${p.conc} 下峰值不超上限、无饿死、N=N上游、许可不泄漏`, async () => {
    const u = poolUpstream()
    const fetch = makeGateway(u.fetchImpl)
    const reqs: Array<Promise<number>> = []
    for (let i = 0; i < 100; i++) {
      const id = `install-${String(i).padStart(4, '0')}`
      reqs.push(fire(fetch, p.model, id)); reqs.push(fire(fetch, p.model, id))
    }
    await tick()
    expect(u.stats[p.pool].peak).toBe(p.conc)   // 峰值 = 该池全局上限
    expect(u.stats.cross).toBe(0)               // 无错路由
    u.open()
    const statuses = await Promise.all(reqs)
    expect(statuses.every(s => s === 200)).toBe(true) // 全部排空,无饿死
    expect(u.stats[p.pool].calls).toBe(200)     // N 次逻辑 = N 次上游,无放大
    expect(u.stats[p.pool].peak).toBe(p.conc)   // 全程 ≤ 上限
    const cap = await capacity(fetch)
    expect(cap[p.pool]).toEqual({ active: 0, queued: 0 }) // 收尾无许可泄漏
  })
}

test('单装机并发不超过单装机上限(2):一个装机发 5 个请求只有 2 路在途', async () => {
  const u = poolUpstream()
  const fetch = makeGateway(u.fetchImpl)
  const reqs = Array.from({ length: 5 }, () => fire(fetch, 'mimo-v2.5', 'install-solo-0001'))
  await tick()
  expect(u.stats.mimo.peak).toBe(2)
  u.open()
  expect((await Promise.all(reqs)).every(s => s === 200)).toBe(true)
})

test('三池混合流量:各自路由正确、跨供应商调用=0、各池峰值≤各自上限且互不阻塞、全部排空', async () => {
  const u = poolUpstream()
  const fetch = makeGateway(u.fetchImpl)
  const reqs: Array<Promise<number>> = []
  for (let i = 0; i < 40; i++) {
    const n = String(i).padStart(3, '0')
    reqs.push(fire(fetch, 'qwen3-coder-plus', `qw-inst-${n}`))
    reqs.push(fire(fetch, 'mimo-v2.5', `mo-inst-${n}`))
    reqs.push(fire(fetch, 'deepseek-v4-flash', `ds-inst-${n}`))
  }
  await tick()
  expect(u.stats.cross).toBe(0)               // 每个 model 只打到对应 fake upstream
  expect(u.stats.qwen.peak).toBe(16)          // qwen 打满 16
  expect(u.stats.mimo.peak).toBe(16)          // mimo 打满 16(mimo 满不阻塞 qwen/deepseek)
  expect(u.stats.deepseek.peak).toBe(32)      // deepseek 打满 32,三池同时活跃 = 隔离
  u.open()
  expect((await Promise.all(reqs)).every(s => s === 200)).toBe(true)
  expect(u.stats.qwen.calls).toBe(40); expect(u.stats.mimo.calls).toBe(40); expect(u.stats.deepseek.calls).toBe(40)
  const cap = await capacity(fetch)
  for (const k of ['qwen', 'mimo', 'deepseek'] as Pool[]) expect(cap[k]).toEqual({ active: 0, queued: 0 })
})

test('单 token 二级闸:伪造大量 installationId 也拿不到超过 token 级上限,保护其它 token', async () => {
  const u = poolUpstream()
  const fetch = makeGateway(u.fetchImpl, {
    GW_APP_TOKENS: JSON.stringify({ 'token-a': 'userA', 'token-b': 'userB' }),
    GW_QWEN_TOKEN_CONC: '4',
  })
  const aReqs = Array.from({ length: 10 }, (_, i) => fire(fetch, 'qwen3-coder-plus', `fake-inst-${String(i).padStart(2, '0')}`, 'token-a'))
  await tick()
  expect(u.stats.qwen.inFlight).toBe(4) // token-a 被 token 级上限封在 4,伪造 10 装机无效
  const bReqs = [fire(fetch, 'qwen3-coder-plus', 'real-inst-b1', 'token-b'), fire(fetch, 'qwen3-coder-plus', 'real-inst-b2', 'token-b')]
  await tick()
  expect(u.stats.qwen.inFlight).toBe(6) // token-b 拿到 2,未被 token-a 挤死
  u.open()
  expect((await Promise.all([...aReqs, ...bReqs])).every(s => s === 200)).toBe(true)
})

// ── 100 用户 × 8 窗口 = 800 并发(默认 DeepSeek 容量证据,假 upstream;不打真上游) ──
test('默认 DeepSeek profile:100 用户 × 8 窗口=800 请求，全部直接在途、无网关排队，公平、usage 与许可均排空', async () => {
  const u = poolUpstream()
  // The fixture normally pins the old small values so the legacy per-pool tests stay
  // deterministic. Delete those overrides here to exercise the production default.
  const { fetch, usage } = makeGatewayWithUsage(u.fetchImpl, {
    GW_DEEPSEEK_CONC: undefined,
    GW_DEEPSEEK_USER_CONC: undefined,
    GW_DEEPSEEK_TOKEN_CONC: undefined,
    GW_DEEPSEEK_QUEUE_MAX: undefined,
    GW_DEEPSEEK_QUEUE_MAX_WAIT: undefined,
  })
  const reqs: Array<Promise<number>> = []
  for (let user = 0; user < 100; user++) {
    const id = `eightwin-${String(user).padStart(4, '0')}`
    for (let window = 0; window < 8; window++) {
      reqs.push(fire(fetch, 'deepseek-v4-flash', id))
    }
  }

  await waitFor(() => u.stats.deepseek.inFlight === 800, 10_000)
  const health = await fetch(new Request('http://local/healthz', { headers: { Authorization: 'Bearer app-token' } }))
  const body = await health.json()
  expect(body.limits).toMatchObject({
    deepseek_conc: 800,
    deepseek_user_conc: 8,
    deepseek_token_conc: 800,
    deepseek_queue_max: 200,
    deepseek_queue_max_wait_seconds: 15,
  })
  expect(body.capacity.deepseek).toMatchObject({
    active: 800,
    queued: 0,
    maxConcurrent: 800,
    maxConcurrentPerUser: 8,
    maxConcurrentPerToken: 800,
    queueMax: 200,
  })
  expect(body.capacity.deepseek.oldestQueueMs).toBeGreaterThanOrEqual(0)
  expect(u.stats.deepseek.peak).toBe(800)
  expect(u.stats.cross).toBe(0)

  u.open()
  const statuses = await Promise.all(reqs)
  expect(statuses).toHaveLength(800)
  expect(statuses.every(status => status === 200)).toBe(true)
  expect(u.stats.deepseek.calls).toBe(800)
  expect(u.stats.deepseek.peak).toBe(800)
  expect(usage.rows).toHaveLength(800)
  expect(usage.rows.every(row => row.model === 'deepseek' && row.ok && /^queue_ms=\d+;attempts=1;client=/.test(row.note ?? ''))).toBe(true)
  const drained = await fetch(new Request('http://local/healthz', { headers: { Authorization: 'Bearer app-token' } }))
  expect((await drained.json()).capacity.deepseek).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
})

test('默认 DeepSeek profile:超过 800 在途+200 等待的突发会立即 429，而不无界堆积', async () => {
  const u = poolUpstream()
  const { fetch } = makeGatewayWithUsage(u.fetchImpl, {
    GW_DEEPSEEK_CONC: undefined,
    GW_DEEPSEEK_USER_CONC: undefined,
    GW_DEEPSEEK_TOKEN_CONC: undefined,
    GW_DEEPSEEK_QUEUE_MAX: undefined,
    GW_DEEPSEEK_QUEUE_MAX_WAIT: undefined,
  })
  // 126 个安装 × 8 窗口 = 1008：800 个真实上游位 + 200 个队列位，剩余 8 个
  // 必须快速拒绝。使用同一个 app token，覆盖桌面端共享产品 bearer 的实际调度形状。
  const reqs: Array<Promise<number>> = []
  for (let user = 0; user < 126; user++) {
    const id = `overflow-${String(user).padStart(4, '0')}`
    for (let window = 0; window < 8; window++) reqs.push(fire(fetch, 'deepseek-v4-flash', id))
  }

  await waitFor(() => u.stats.deepseek.inFlight === 800, 10_000)
  const health = await fetch(new Request('http://local/healthz', { headers: { Authorization: 'Bearer app-token' } }))
  expect((await health.json()).capacity.deepseek).toMatchObject({ active: 800, queued: 200, queueMax: 200 })
  expect(u.stats.deepseek.peak).toBe(800)

  u.open()
  const statuses = await Promise.all(reqs)
  expect(statuses.filter(status => status === 200)).toHaveLength(1_000)
  expect(statuses.filter(status => status === 429)).toHaveLength(8)
  expect(u.stats.deepseek.calls).toBe(1_000)
  expect((await capacity(fetch)).deepseek).toEqual({ active: 0, queued: 0 })
})

test('默认 MiMo profile:100 用户 × 5 窗口为100个不同安装各保留一席，52 条原生在途 +48 个五秒等待', async () => {
  const u = poolUpstream()
  const { fetch, usage } = makeGatewayWithUsage(u.fetchImpl, {
    GW_MIMO_CONC: undefined,
    GW_MIMO_NATIVE_CONC: undefined,
    GW_MIMO_USER_CONC: undefined,
    GW_MIMO_INFLIGHT_PER_USER: undefined,
    GW_MIMO_TOKEN_CONC: undefined,
    GW_MIMO_QUEUE_MAX: undefined,
    GW_MIMO_QUEUE_MAX_WAIT: undefined,
  })
  const reqs: Array<Promise<number>> = []
  for (let user = 0; user < 100; user++) {
    const id = `mimo-fivewin-${String(user).padStart(4, '0')}`
    for (let window = 0; window < 5; window++) reqs.push(fire(fetch, 'mimo-v2.5', id))
  }

  await waitFor(() => u.stats.mimo.inFlight === 52)
  const health = await fetch(new Request('http://local/healthz', { headers: { Authorization: 'Bearer app-token' } }))
  const body = await health.json()
  expect(body.limits).toMatchObject({ mimo_conc: 64, mimo_native_conc: 52, mimo_user_conc: 1, mimo_inflight_per_user: 1, mimo_token_conc: 64, mimo_queue_max: 64, mimo_queue_max_wait_seconds: 5 })
  expect(body.capacity.mimo).toMatchObject({
    active: 52,
    queued: 48,
    maxConcurrent: 64,
    maxConcurrentPerUser: 1,
    maxConcurrentPerToken: 64,
    queueMax: 88,
    nativeReserved: 52,
    visionReserved: 12,
  })
  expect(body.capacity.mimo_native).toMatchObject({ active: 52, queued: 48, maxConcurrent: 52, maxConcurrentPerUser: 1, queueMax: 64 })
  expect(body.capacity.mimo_total).toMatchObject({ active: 52, queued: 48, maxConcurrent: 64, nativeReserved: 52, visionReserved: 12 })
  expect(body.capacity.mimo_native.oldestQueueMs).toBeGreaterThanOrEqual(0)
  expect(u.stats.mimo.peak).toBe(52)

  u.open()
  const statuses = await Promise.all(reqs)
  expect(statuses.filter(status => status === 200)).toHaveLength(100)
  expect(statuses.filter(status => status === 429)).toHaveLength(400)
  expect(u.stats.mimo.calls).toBe(100)
  expect(u.stats.mimo.peak).toBe(52)
  expect(usage.rows.filter(row => row.model === 'mimo' && row.ok)).toHaveLength(100)
  expect(usage.rows.filter(row => row.model === 'mimo' && row.status === 429 && /queue_rejected=1/.test(row.note ?? ''))).toHaveLength(400)
  const drained = await fetch(new Request('http://local/healthz', { headers: { Authorization: 'Bearer app-token' } }))
  const drainedCapacity = (await drained.json()).capacity
  expect(drainedCapacity.mimo).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
  expect(drainedCapacity.mimo_native).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
})

// ── 保留旧 3 窗口回归：小容量显式 env 仍照旧生效 ────────────────────────
test('单装机 3 窗口:同一装机同时只有 2 路在途,第 3 窗口排队(单装机上限)', async () => {
  const u = poolUpstream()
  const fetch = makeGateway(u.fetchImpl)
  const reqs = Array.from({ length: 3 }, () => fire(fetch, 'deepseek-v4-flash', 'solo-user-0001'))
  await tick()
  expect(u.stats.deepseek.peak).toBe(2) // 3 个窗口,单装机只 2 路在途,第 3 个排队
  u.open()
  expect((await Promise.all(reqs)).every(s => s === 200)).toBe(true)
})

test('100 装机 × 每机 3 窗口(300 并发)同池:全局上限封顶、全部排空、N=N、许可归零', async () => {
  const u = poolUpstream()
  const fetch = makeGateway(u.fetchImpl)
  const reqs: Array<Promise<number>> = []
  for (let i = 0; i < 100; i++) {
    const id = `user-${String(i).padStart(4, '0')}`
    reqs.push(fire(fetch, 'deepseek-v4-flash', id))
    reqs.push(fire(fetch, 'deepseek-v4-flash', id))
    reqs.push(fire(fetch, 'deepseek-v4-flash', id)) // 3 窗口
  }
  await tick(80)
  expect(u.stats.deepseek.peak).toBe(32) // 300 想跑,全局硬顶 32,其余排队(伪造装机也超不过)
  expect(u.stats.cross).toBe(0)
  u.open()
  const statuses = await Promise.all(reqs)
  expect(statuses.filter(s => s === 200).length).toBe(300) // 全部排空,无饿死
  expect(u.stats.deepseek.calls).toBe(300) // 300 次逻辑 = 300 次上游,无放大
  expect(u.stats.deepseek.peak).toBe(32) // 全程 ≤ 上限
  expect(await capacity(fetch).then(c => c.deepseek)).toEqual({ active: 0, queued: 0 }) // 无许可泄漏
})

test('100 装机 × 3 窗口混合三池(300 并发):各池独立封顶、跨供应商=0、全部排空、许可归零', async () => {
  const u = poolUpstream()
  const fetch = makeGateway(u.fetchImpl)
  const reqs: Array<Promise<number>> = []
  for (let i = 0; i < 100; i++) {
    const id = `mixuser-${String(i).padStart(4, '0')}`
    reqs.push(fire(fetch, 'qwen3-coder-plus', id))
    reqs.push(fire(fetch, 'mimo-v2.5', id))
    reqs.push(fire(fetch, 'deepseek-v4-flash', id)) // 3 个窗口分别用三家
  }
  await tick(80)
  expect(u.stats.cross).toBe(0)
  expect(u.stats.qwen.peak).toBe(16)      // 三池各自独立封顶,互不阻塞
  expect(u.stats.mimo.peak).toBe(16)
  expect(u.stats.deepseek.peak).toBe(32)
  u.open()
  const statuses = await Promise.all(reqs)
  expect(statuses.filter(s => s === 200).length).toBe(300)
  expect(u.stats.qwen.calls).toBe(100); expect(u.stats.mimo.calls).toBe(100); expect(u.stats.deepseek.calls).toBe(100)
  const cap = await capacity(fetch)
  for (const k of ['qwen', 'mimo', 'deepseek'] as Pool[]) expect(cap[k]).toEqual({ active: 0, queued: 0 })
})

// ── 错误 / 中断路径:许可必须释放(active/queued 回 0) ─────────────
test('429 立即回传不重试,一次逻辑调用只一次上游,许可释放', async () => {
  let calls = 0
  const fetch = makeGateway(async () => { calls += 1; return new Response('busy', { status: 429 }) })
  const res = await fetch(chatReq('mimo-v2.5', 'e-1'))
  expect(res.status).toBe(429)
  expect(calls).toBe(1) // 429 不重试
  expect((await capacity(fetch)).mimo).toEqual({ active: 0, queued: 0 })
})

test('可重试 5xx 最多额外一次(共 2 次)后回传,许可释放', async () => {
  let calls = 0
  const fetch = makeGateway(async () => { calls += 1; return new Response('down', { status: 503 }) })
  const res = await fetch(chatReq('mimo-v2.5', 'e-2'))
  expect(res.status).toBeGreaterThanOrEqual(500)
  expect(calls).toBe(2) // 1 + 最多额外一次
  expect((await capacity(fetch)).mimo).toEqual({ active: 0, queued: 0 })
})

test('连接错误(上游 fetch 抛出)重试后失败,许可释放', async () => {
  let calls = 0
  const fetch = makeGateway(async () => { calls += 1; throw new Error('ECONNRESET') })
  const res = await fetch(chatReq('deepseek-v4-flash', 'e-3'))
  expect(res.status).toBe(502)
  expect(calls).toBe(2) // 连接错误也最多额外一次
  expect((await capacity(fetch)).deepseek).toEqual({ active: 0, queued: 0 })
})

test('上游中途断流:客户端读到错误,许可释放,active/queued 回 0', async () => {
  const fetch = makeGateway(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: partial\n\n')); c.error(new Error('upstream dropped mid-stream')) },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  })
  const res = await fetch(chatReq('mimo-v2.5', 'e-4'))
  expect(res.status).toBe(200)
  try { await res.text() } catch { /* 流中途报错,预期 */ }
  await tick()
  expect((await capacity(fetch)).mimo).toEqual({ active: 0, queued: 0 })
})

test('客户端断开(取消响应体)释放许可', async () => {
  const u = poolUpstream()
  const fetch = makeGateway(u.fetchImpl)
  u.open() // 上游立即返回 SSE 体
  const res = await fetch(chatReq('mimo-v2.5', 'e-5'))
  await res.body?.cancel() // 客户端断开,不读完
  await tick()
  expect((await capacity(fetch)).mimo).toEqual({ active: 0, queued: 0 })
})

test('排队等待超时(池满 + 极短 queue wait)返回 429,许可释放', async () => {
  const u = poolUpstream() // 闸门关:占住的请求一直在途
  const fetch = makeGateway(u.fetchImpl, { GW_MIMO_CONC: '3', GW_MIMO_NATIVE_CONC: '2', GW_VISION_CONC: '1', GW_MIMO_QUEUE_MAX_WAIT: '0.05' })
  const held = [fire(fetch, 'mimo-v2.5', 'h-1'), fire(fetch, 'mimo-v2.5', 'h-2')] // 占满 conc=2
  await tick()
  const timedOut = await fetch(chatReq('mimo-v2.5', 'q-timeout')) // 第三个排队 → 极短超时 → 429
  expect(timedOut.status).toBe(429)
  await timedOut.text()
  expect((await capacity(fetch)).mimo.queued).toBe(0) // 超时的请求已出队,不泄漏
  u.open()
  await Promise.all(held)
  expect((await capacity(fetch)).mimo).toEqual({ active: 0, queued: 0 })
})

test('客户端 abort 排队中的请求:出队释放,active/queued 回落', async () => {
  const u = poolUpstream() // 闸门关
  const fetch = makeGateway(u.fetchImpl, { GW_MIMO_CONC: '3', GW_MIMO_NATIVE_CONC: '2', GW_VISION_CONC: '1' })
  const held = [fire(fetch, 'mimo-v2.5', 'a-1'), fire(fetch, 'mimo-v2.5', 'a-2')] // 占满
  await tick()
  const ac = new AbortController()
  const aborted = fetch(chatReq('mimo-v2.5', 'a-queued', 'app-token', ac.signal)).then(r => r.status).catch(() => 'aborted')
  await tick()
  expect((await capacity(fetch)).mimo.queued).toBe(1) // 已排队
  ac.abort()
  await aborted
  await tick()
  expect((await capacity(fetch)).mimo.queued).toBe(0) // abort 后出队
  u.open()
  await Promise.all(held)
  expect((await capacity(fetch)).mimo).toEqual({ active: 0, queued: 0 })
})
