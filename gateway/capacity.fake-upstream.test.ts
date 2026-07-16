// 假 upstream 容量证据(不连真上游):证明 50~100 装机、峰值并发下的公平调度与全局上限。
//
// 关键被测行为:
//  - 装机身份(X-QF-Client-ID)细分单用户公平额度 —— 100 个装机各拿一份,直到打满全局并发上限;
//    而同一 token 不带装机身份时,退化成一份单用户额度(证明"不再把所有安装视为同一用户")。
//  - 全局并发上限对上游是硬边界:无论多少装机同时请求,在途上游调用数永不超过 GW_QWEN_CONC。
//  - 一次逻辑调用只产生一次上游请求(无重试放大),且所有请求最终公平排空、无饿死。
//
// 手法:用一个"闸门"假 upstream —— 每个上游调用进入时计数(反映当前占用的并发许可),然后挂起
// 在闸门上;测试先在闸门关闭时测峰值(=容量上限),再开闸放行、消费全部响应体、断言全部成功。

import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GW_QWEN_KEY: 'qwen-secret',
    GW_QWEN_BASE: 'https://qwen.example/v1',
    GW_QWEN_MODEL: 'qwen3-coder-plus',
    GW_RELAY_BASE: 'https://relay.example/v1',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_APP_TOKENS: JSON.stringify({ 'app-token': 'beta' }),
    // 峰值 20 并发活跃会话、单装机最多 2 路;RPM 拉高,让令牌桶不介入(只测并发公平)。
    GW_QWEN_CONC: '20',
    GW_QWEN_USER_CONC: '2',
    GW_QWEN_RPM: '1000000',
    GW_QWEN_QUEUE_MAX_WAIT: '30',
    GW_QWEN_MAX_RETRIES: '1',
    ...overrides,
  }
}

/** 闸门假 upstream:进入即占用一份"在途",挂起在闸门上;开闸后返回一个可消费的 SSE 响应体。 */
function gatedUpstream() {
  let inFlight = 0
  let peak = 0
  let chatCalls = 0
  let gateOpen = false
  const waiters: Array<() => void> = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (!url.endsWith('/chat/completions')) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    chatCalls += 1
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise<void>(resolve => {
      if (gateOpen) resolve()
      else waiters.push(resolve)
    })
    inFlight -= 1
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  return {
    fetchImpl,
    peak: () => peak,
    inFlight: () => inFlight,
    chatCalls: () => chatCalls,
    open() {
      gateOpen = true
      for (const w of waiters.splice(0)) w()
    },
  }
}

function fireChat(
  fetch: (req: Request) => Promise<Response>,
  clientId: string | null,
): Promise<number> {
  const headers: Record<string, string> = { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' }
  if (clientId) headers['X-QF-Client-ID'] = clientId
  return fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'qwen3-coder-plus', stream: true }),
  })).then(async res => {
    await res.text() // 消费响应体 → 触发流结束 → 释放并发许可
    return res.status
  })
}

const tick = (ms = 25) => new Promise(r => setTimeout(r, ms))

test('100 个装机身份各占一份公平额度,打满全局并发上限(20),不带装机身份则退化为一份', async () => {
  // A 组:100 个不同装机(同一 token),每个各发 1 个请求。
  const a = gatedUpstream()
  const fetchA = createGatewayFetch({ env: env(), usageStore: new MemoryUsageStore(), transcribeImpl: null, webSearchImpl: null, fetchImpl: a.fetchImpl })
  const aReqs = Array.from({ length: 100 }, (_, i) => fireChat(fetchA, `install-${String(i).padStart(4, '0')}`))
  await tick()
  // 100 个装机都想要名额,但全局硬顶 20 → 恰好 20 路在途。
  expect(a.peak()).toBe(20)
  expect(a.inFlight()).toBe(20)
  a.open()
  const aStatuses = await Promise.all(aReqs)
  expect(aStatuses.every(s => s === 200)).toBe(true)
  expect(a.peak()).toBe(20) // 排空过程中在途始终 ≤ 20
  expect(a.chatCalls()).toBe(100) // 一次逻辑调用 = 一次上游调用,无放大

  // B 组:同样 100 个请求、同一 token,但不带 X-QF-Client-ID → 全部落到同一调度身份。
  const b = gatedUpstream()
  const fetchB = createGatewayFetch({ env: env(), usageStore: new MemoryUsageStore(), transcribeImpl: null, webSearchImpl: null, fetchImpl: b.fetchImpl })
  const bReqs = Array.from({ length: 100 }, () => fireChat(fetchB, null))
  await tick()
  // 没有装机身份 → 单用户额度只有 2 → 只有 2 路在途(其余排队)。这就是"不再视为同一用户"的对照。
  expect(b.peak()).toBe(2)
  b.open()
  const bStatuses = await Promise.all(bReqs)
  expect(bStatuses.every(s => s === 200)).toBe(true)
})

test('100 装机 × 每个 2 请求(共 200)在 20 全局并发下全部公平排空,在途永不超上限,无重试放大', async () => {
  const u = gatedUpstream()
  const fetch = createGatewayFetch({ env: env(), usageStore: new MemoryUsageStore(), transcribeImpl: null, webSearchImpl: null, fetchImpl: u.fetchImpl })
  const reqs: Array<Promise<number>> = []
  for (let i = 0; i < 100; i++) {
    const id = `install-${String(i).padStart(4, '0')}`
    reqs.push(fireChat(fetch, id))
    reqs.push(fireChat(fetch, id))
  }
  await tick()
  // 单装机最多 2 路 + 全局 20 → 峰值 20 路在途(约 10 个装机同时活跃)。
  expect(u.peak()).toBe(20)
  u.open()
  const statuses = await Promise.all(reqs)
  expect(statuses).toHaveLength(200)
  expect(statuses.every(s => s === 200)).toBe(true) // 无饿死,全部成功
  expect(u.peak()).toBe(20) // 全程在途 ≤ 全局上限
  expect(u.chatCalls()).toBe(200) // 200 次逻辑调用 = 200 次上游调用
})

test('伪造/畸形装机身份不放大额度:落回按 token 调度(与不带身份同一份额度)', async () => {
  const u = gatedUpstream()
  const fetch = createGatewayFetch({ env: env(), usageStore: new MemoryUsageStore(), transcribeImpl: null, webSearchImpl: null, fetchImpl: u.fetchImpl })
  // 畸形身份(太短/非法字符)一律被网关丢弃 → schedId 退回 token 'beta' → 单用户额度 2。
  const reqs = Array.from({ length: 40 }, (_, i) => fireChat(fetch, i % 2 === 0 ? 'x' : 'has space!!'))
  await tick()
  expect(u.peak()).toBe(2) // 无法靠伪造 id 拿到超过一份单用户额度
  u.open()
  const statuses = await Promise.all(reqs)
  expect(statuses.every(s => s === 200)).toBe(true)
})
