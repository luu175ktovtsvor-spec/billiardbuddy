import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'
import { gatewayTestAccessTokenFor, gatewayTestAuthority } from './auth/testFixture'

type Capacity = { active: number; queued: number }
function request(label: string, index: number, signal?: AbortSignal): Request {
  return new Request('http://local/v1/chat/completions', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${gatewayTestAccessTokenFor(`${label}-${index}`)}`, 'Content-Type': 'application/json', 'X-BB-Installation-ID': `${label}-client-${index}`, 'X-BB-Provider-Protocol': 'bb-provider-gateway/1.0' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
  })
}
function gatedGateway(label: string, globalConcurrent: number, queueMax: number) {
  let released = false
  let calls = 0
  let active = 0
  let peak = 0
  const waiters: Array<() => void> = []
  const fetch = createGatewayFetch({
    authority: gatewayTestAuthority,
    env: {
      GW_RELAY_TOKEN: 'relay', GW_DEEPSEEK_KEY: 'key', GW_DEEPSEEK_BASE: 'https://deepseek.example',
      GW_DEEPSEEK_CONC: String(globalConcurrent), GW_DEEPSEEK_USER_CONC: String(globalConcurrent), GW_DEEPSEEK_TOKEN_CONC: String(globalConcurrent),
      GW_DEEPSEEK_QUEUE_MAX: String(queueMax), GW_DEEPSEEK_QUEUE_MAX_WAIT: '10',
    },
    usageStore: new MemoryUsageStore(), transcribeImpl: null,
    fetchImpl: async () => {
      calls++; active++; peak = Math.max(peak, active)
      await new Promise<void>(resolve => released ? resolve() : waiters.push(resolve))
      let settled = false
      const settle = () => { if (!settled) { settled = true; active-- } }
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new TextEncoder().encode('data: done\n\n')); controller.close(); settle() },
        cancel() { settle() },
      }), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const capacity = async (): Promise<Capacity> => {
    const response = await fetch(new Request('http://local/healthz', { headers: { Authorization: `Bearer ${gatewayTestAccessTokenFor(`${label}-health`)}` } }))
    return (await response.json()).capacity.deepseek
  }
  const waitFor = async (predicate: () => Promise<boolean>, message: string) => {
    const deadline = Date.now() + 4_000
    while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  return { fetch, capacity, waitFor, release: () => { released = true; waiters.splice(0).forEach(resolve => resolve()) }, stats: () => ({ calls, active, peak }) }
}
async function runBurst(label: string, count: number, concurrent: number) {
  const gateway = gatedGateway(label, concurrent, count)
  const pending = Array.from({ length: count }, (_, index) => gateway.fetch(request(label, index)))
  await gateway.waitFor(async () => (await gateway.capacity()).active === concurrent, `${label} active=${concurrent}`)
  const before = await gateway.capacity()
  expect(before.active).toBe(concurrent)
  expect(before.queued).toBe(count - concurrent)
  expect(gateway.stats()).toMatchObject({ calls: concurrent, active: concurrent, peak: concurrent })
  gateway.release()
  await Promise.all(pending.map(async promise => { const response = await promise; expect(response.status).toBe(200); await response.text() }))
  expect(gateway.stats()).toMatchObject({ calls: count, active: 0, peak: concurrent })
  expect(await gateway.capacity()).toMatchObject({ active: 0, queued: 0 })
}

test('100 simultaneous distinct-bearer requests admit 32 and queue 68 before release', () => runBurst('burst-100', 100, 32))
test('300 simultaneous distinct-bearer requests admit 64 and queue 236 before release', () => runBurst('burst-300', 300, 64))
test('1000 simultaneous distinct-bearer requests admit 100 and queue 900 before release', () => runBurst('burst-1000', 1000, 100), { timeout: 20_000 })

test('500 simultaneous requests cancel 100 known queued turns; 400 upstream calls drain', async () => {
  const label = 'cancel-500'
  const gateway = gatedGateway(label, 100, 500)
  const controllers = Array.from({ length: 500 }, () => new AbortController())
  const pending = controllers.map((controller, index) => gateway.fetch(request(label, index, controller.signal)))
  await gateway.waitFor(async () => (await gateway.capacity()).queued === 400, '400 queued requests')
  // FIFO admission has already taken indexes 0..99; indexes 400..499 are deterministically queued.
  controllers.slice(400).forEach(controller => controller.abort())
  const cancelled = await Promise.all(pending.slice(400).map(async promise => (await promise).status))
  expect(cancelled).toEqual(Array.from({ length: 100 }, () => 499))
  expect(gateway.stats()).toMatchObject({ calls: 100, active: 100 })
  gateway.release()
  await Promise.all(pending.slice(0, 400).map(async promise => { const response = await promise; expect(response.status).toBe(200); await response.text() }))
  expect(gateway.stats()).toMatchObject({ calls: 400, active: 0, peak: 100 })
  expect(await gateway.capacity()).toMatchObject({ active: 0, queued: 0 })
}, { timeout: 30_000 })
