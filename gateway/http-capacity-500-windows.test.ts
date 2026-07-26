import { expect, test } from 'bun:test'
import { connect, type Socket } from 'node:net'
import { createGatewayFetch, MemoryUsageStore } from './app'
import { gatewayTestAccessToken, gatewayTestAccessTokenFor, gatewayTestAuthority } from './auth/testFixture'

const USER_COUNT = 100
const WINDOWS_PER_USER = 10
const TARGET_CONCURRENCY = USER_COUNT * WINDOWS_PER_USER
const LOOPBACK_ADMISSION_BATCH = 25

function env(): Record<string, string> {
  return {
    GW_QWEN_KEY: 'qwen-secret',
    GW_QWEN_BASE: 'https://qwen.example/v1',
    GW_QWEN_MODEL: 'qwen3-coder-plus',
    GW_MIMO_KEY: 'mimo-secret',
    GW_MIMO_BASE: 'https://mimo.example/v1',
    GW_MIMO_MODEL: 'mimo-v2.5',
    GW_DEEPSEEK_KEY: 'deepseek-secret',
    GW_DEEPSEEK_BASE: 'https://deepseek.example',
    GW_DEEPSEEK_MODEL: 'deepseek-v4-flash',
    GW_DEEPSEEK_CONC: String(TARGET_CONCURRENCY),
    GW_DEEPSEEK_USER_CONC: String(WINDOWS_PER_USER),
    GW_DEEPSEEK_TOKEN_CONC: String(TARGET_CONCURRENCY),
    GW_DEEPSEEK_QUEUE_MAX: '200',
    GW_DEEPSEEK_QUEUE_MAX_WAIT: '15',
    GW_DEEPSEEK_RPM: '1000000',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_APP_TOKENS: JSON.stringify({ 'shared-desktop-token': 'shared-product-token' }),
  }
}

function makeHeldSseUpstream() {
  let active = 0
  let peak = 0
  let open = false
  const waiters: Array<() => void> = []

  const waitForOpen = async () => {
    if (open) return
    await new Promise<void>(resolve => waiters.push(resolve))
  }

  return {
    stats: () => ({ active, peak }),
    release() {
      open = true
      for (const resolve of waiters.splice(0)) resolve()
    },
    async fetchImpl(input: RequestInfo | URL): Promise<Response> {
      if (!String(input).includes('deepseek.example')) return Response.json({ ok: true })
      active += 1
      peak = Math.max(peak, active)
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        active -= 1
      }
      let sentPreamble = false
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sentPreamble) {
            sentPreamble = true
            controller.enqueue(new TextEncoder().encode('data: connected\n\n'))
            return
          }
          await waitForOpen()
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
          settle()
        },
        cancel() {
          settle()
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  }
}

async function eventually(assertion: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertion()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return assertion()
}

type HeldResponse = {
  status: number
  socket: Socket
}

function chatRequest(port: number, installation: number, window: number, sockets: Set<Socket>): Promise<HeldResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: `load-user-${installation}-window-${window}` }],
    })
    const request = [
      'POST /v1/chat/completions HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Connection: close',
      `Authorization: Bearer ${gatewayTestAccessTokenFor(`http-capacity-${installation}`)}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(payload)}`,
      `X-BB-Installation-ID: desktop-${String(installation).padStart(4, '0')}`,
      'X-BB-Provider-Protocol: bb-provider-gateway/1.0',
      '',
      payload,
    ].join('\r\n')
    const socket = connect({ host: '127.0.0.1', port })
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('connect', () => socket.write(request))
    let responseStarted = false
    socket.once('error', reject)
    socket.on('data', chunk => {
      if (responseStarted) return
      const status = /^HTTP\/1\.1\s+(\d{3})\b/.exec(chunk.toString('latin1'))?.[1]
      if (!status) return
      responseStarted = true
      socket.pause()
      resolve({ status: Number(status), socket })
    })
  })
}

async function consume(response: HeldResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    response.socket.once('error', reject)
    response.socket.once('end', finish)
    response.socket.once('close', finish)
    response.socket.resume()
  })
}

test('loopback HTTP: 100 installations × 10 windows holds 1,000 DeepSeek streams without scheduler loss', async () => {
  const upstream = makeHeldSseUpstream()
  const handler = createGatewayFetch({
    authority: gatewayTestAuthority,
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: upstream.fetchImpl,
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  const baseUrl = `http://127.0.0.1:${server.port}`
  const sockets = new Set<Socket>()

  try {
    // Bun.serve returns before the local socket has necessarily completed its first
    // accept cycle on every supported platform. Start the burst only after that tiny
    // listener warm-up so this measures gateway capacity rather than test-start races.
    await new Promise(resolve => setTimeout(resolve, 25))
    const requests: Array<() => Promise<HeldResponse>> = (
      Array.from({ length: USER_COUNT }, (_, installation) => (
        Array.from({ length: WINDOWS_PER_USER }, (_, window) => () => chatRequest(server.port, installation, window, sockets))
      )).flat()
    )
    const responses: HeldResponse[] = []
    // The domain scheduler sees all 1,000 logical windows in the companion fake-upstream
    // test. Here we deliberately use short 25-connection TCP batches: macOS's loopback
    // accept queue otherwise drops SYNs before Bun runs the handler, which would measure
    // the test host's kernel backlog rather than 1,000 held gateway streams.
    for (let start = 0; start < requests.length; start += LOOPBACK_ADMISSION_BATCH) {
      responses.push(...await Promise.all(requests.slice(start, start + LOOPBACK_ADMISSION_BATCH).map(request => request())))
    }
    expect(responses).toHaveLength(TARGET_CONCURRENCY)
    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(await eventually(() => upstream.stats().peak === TARGET_CONCURRENCY)).toBe(true)
    expect(upstream.stats()).toEqual({ active: TARGET_CONCURRENCY, peak: TARGET_CONCURRENCY })

    upstream.release()
    await Promise.all(responses.map(consume))

    const health = await fetch(`${baseUrl}/healthz`, { headers: { Authorization: `Bearer ${gatewayTestAccessToken}` } })
    const state = await health.json() as { capacity: { deepseek: { active: number; queued: number } } }
    expect(state.capacity.deepseek).toMatchObject({ active: 0, queued: 0 })
    expect(upstream.stats()).toEqual({ active: 0, peak: TARGET_CONCURRENCY })
  } finally {
    upstream.release()
    for (const socket of sockets) socket.destroy()
    server.stop(true)
  }
})
