import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'
import type { GatewayTranscriber } from './transcription'
import { createGatewayWebSearch, GatewayWebSearchError } from './webSearch'

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GW_QWEN_KEY: 'qwen-secret',
    GW_QWEN_BASE: 'https://qwen.example/v1',
    GW_QWEN_MODEL: 'qwen3-coder-plus',
    GW_RELAY_BASE: 'https://relay.example/relay/openai/v1',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_ARK_KEY: 'ark-secret',
    GW_ARK_BASE: 'https://ark.example/api/v3',
    GW_AMAP_KEY: 'amap-secret',
    GW_AMAP_BASE: 'https://amap.example',
    GW_WEBSEARCH_PROVIDER: 'brave',
    GW_WEBSEARCH_KEY: 'search-secret',
    GW_WEBSEARCH_BASE: 'https://search.example/res/v1/web/search',
    GW_APP_TOKENS: JSON.stringify({ 'app-token': 'owner-a' }),
    GW_ADMIN_TOKEN: 'admin-secret',
    GW_Q_CHAT: '2',
    GW_Q_IMG: '1',
    GW_Q_ARK_CHAT: '1',
    GW_Q_ARK_IMG: '1',
    GW_Q_AMAP: '1',
    GW_QUEUE_MAX_WAIT: '0.01',
    GW_QWEN_QUEUE_MAX_WAIT: '0.2',
    ...overrides,
  }
}

function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: 'Bearer app-token',
      ...(init.headers as Record<string, string> | undefined),
    },
  }
}

function makeGateway(overrides: Record<string, string | undefined> = {}, transcribeImpl?: GatewayTranscriber | null) {
  const calls: Array<{ url: string; init?: RequestInit; body?: string }> = []
  const usage = new MemoryUsageStore()
  const fetch = createGatewayFetch({
    env: env(overrides),
    usageStore: usage,
    transcribeImpl,
    fetchImpl: async (input, init) => {
      const url = String(input)
      let body = ''
      if (init?.body instanceof ArrayBuffer) body = Buffer.from(init.body).toString('utf8')
      else if (typeof init?.body === 'string') body = init.body
      calls.push({ url, init, body })
      if (url.includes('/chat/completions')) {
        return new Response('data: hello\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.startsWith('https://amap.example/')) {
        return Response.json({ status: '1', key_seen: new URL(url).searchParams.get('key') })
      }
      if (url.startsWith('https://search.example/')) {
        return Response.json({
          web: {
            results: [
              { title: 'Bun Docs', url: 'https://bun.sh/docs/runtime', description: '<b>Fast</b> JavaScript runtime' },
              { title: 'Blocked', url: 'https://noise.example/post', description: 'noise' },
            ],
          },
        })
      }
      return Response.json({ ok: true, url })
    },
  })
  return { fetch, calls, usage }
}

test('healthz exposes capacity limits and an empty legacy quota object', async () => {
  const { fetch } = makeGateway()
  const publicRes = await fetch(new Request('http://local/healthz'))
  expect(await publicRes.json()).toEqual({ ok: true })
  const res = await fetch(new Request('http://local/healthz', authed()))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.limits.qwen_rpm).toBe(90)
  expect(body.limits.qwen_conc).toBe(16)
  expect(body.limits.qwen_user_conc).toBe(2)
  expect(body.quota).toEqual({})
  expect(body.features.transcription).toBe(false)
  expect(body.features.web_search).toBe(true)
  expect(body.capacity.qwen).toMatchObject({ active: 0, queued: 0, maxConcurrent: 16 })
})

test('web search authenticates, keeps provider key server-side and normalizes filtered results', async () => {
  const { fetch, calls, usage } = makeGateway()
  const response = await fetch(new Request('http://local/v1/web_search', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'Bun runtime', allowed_domains: ['bun.sh'] }),
  })))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    results: [{ title: 'Bun Docs', url: 'https://bun.sh/docs/runtime', snippet: 'Fast JavaScript runtime' }],
  })
  const upstream = calls[0]!
  expect(upstream.url).toContain('https://search.example/res/v1/web/search?q=Bun+runtime')
  expect((upstream.init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('search-secret')
  expect(upstream.body).not.toContain('search-secret')
  expect(usage.rows).toMatchObject([{ user: 'owner-a', model: 'web_search', ok: true, status: 200 }])
})

test('web search rejects malformed requests and fails closed when provider is unavailable', async () => {
  const enabled = makeGateway()
  const malformed = await enabled.fetch(new Request('http://local/v1/web_search', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '', allowed_domains: ['https://bad.example/path'] }),
  })))
  expect(malformed.status).toBe(400)
  expect(enabled.calls).toEqual([])

  const disabled = makeGateway({ GW_WEBSEARCH_PROVIDER: '', GW_WEBSEARCH_KEY: '' })
  const unavailable = await disabled.fetch(new Request('http://local/v1/web_search', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'test' }),
  })))
  expect(unavailable.status).toBe(503)
  expect(disabled.calls).toEqual([])
})

test('legacy web search has rate limiting but no separate daily quota', async () => {
  const { fetch, calls } = makeGateway({ GW_Q_WEBSEARCH: '1' })
  const request = () => new Request('http://local/v1/web_search', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'Bun runtime' }),
  }))
  expect((await fetch(request())).status).toBe(200)
  expect((await fetch(request())).status).toBe(200)
  expect(calls).toHaveLength(2)
})

test('web search adapter hides upstream failures and fails closed on timeout', async () => {
  const baseEnv = {
    GW_WEBSEARCH_PROVIDER: 'brave',
    GW_WEBSEARCH_KEY: 'server-only-secret',
    GW_WEBSEARCH_BASE: 'https://search.example/res/v1/web/search',
  }
  const rateLimited = createGatewayWebSearch(baseEnv, async () => new Response('provider detail', { status: 429 }))!
  try {
    await rateLimited({ query: 'test' })
    throw new Error('expected rate limit')
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayWebSearchError)
    expect(error).toMatchObject({ status: 429, publicMessage: '联网搜索暂时不可用，请稍后重试' })
    expect(String(error)).not.toContain('provider detail')
    expect(String(error)).not.toContain('server-only-secret')
  }

  const timedOut = createGatewayWebSearch({ ...baseEnv, GW_WEBSEARCH_TIMEOUT_MS: '100' }, async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  })!
  try {
    await timedOut({ query: 'test' })
    throw new Error('expected timeout')
  } catch (error) {
    expect(error).toMatchObject({ status: 504, publicMessage: '联网搜索超时，请稍后重试' })
  }
})

test('audio transcription authenticates, validates uploads and records successful usage', async () => {
  const received: Array<{ name: string; language: string; format: string }> = []
  const transcribe: GatewayTranscriber = async (file, opts) => {
    received.push({ name: file.name, language: opts.language, format: opts.responseFormat })
    return {
      text: '今天检查台球桌',
      language: opts.language,
      duration: 1.2,
      segments: [{ id: 0, start: 0, end: 1.2, text: '今天检查台球桌' }],
    }
  }
  const { fetch, usage } = makeGateway({ GW_Q_TRANSCRIBE: '2' }, transcribe)
  const unauthenticated = new FormData()
  unauthenticated.set('file', new File(['audio'], 'voice.webm', { type: 'audio/webm' }))
  expect((await fetch(new Request('http://local/v1/audio/transcriptions', { method: 'POST', body: unauthenticated }))).status).toBe(401)

  const form = new FormData()
  form.set('file', new File(['audio'], 'voice.webm', { type: 'audio/webm' }))
  form.set('language', 'zh')
  form.set('response_format', 'verbose_json')
  const response = await fetch(new Request('http://local/v1/audio/transcriptions', authed({ method: 'POST', body: form })))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ text: '今天检查台球桌', segments: [{ start: 0, end: 1.2 }] })
  expect(received).toEqual([{ name: 'voice.webm', language: 'zh', format: 'verbose_json' }])
  expect(usage.rows).toMatchObject([{ user: 'owner-a', model: 'transcribe', ok: true, status: 200 }])
  expect(usage.rows[0]?.note).toMatch(/^queue_ms=\d+;run_ms=\d+;bytes=5;audio_seconds=1\.2$/)
  expect(usage.rows[0]?.note).not.toContain('今天检查台球桌')
})

test('audio transcription disables the request idle timeout for long-running ASR', async () => {
  const timeoutCalls: number[] = []
  const fetch = createGatewayFetch({
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: async () => ({ text: 'ok' }),
  })
  const form = new FormData()
  form.set('file', new File(['audio'], 'voice.webm', { type: 'audio/webm' }))
  const response = await fetch(
    new Request('http://local/v1/audio/transcriptions', authed({ method: 'POST', body: form })),
    { timeout: (_request, seconds) => { timeoutCalls.push(seconds) } },
  )
  expect(response.status).toBe(200)
  expect(timeoutCalls).toEqual([0])
})

test('audio transcription rejects unsupported and oversized files before execution', async () => {
  let calls = 0
  const transcribe: GatewayTranscriber = async () => {
    calls += 1
    return { text: 'unexpected' }
  }
  const { fetch } = makeGateway({ GW_TRANSCRIBE_MAX_BYTES: '4' }, transcribe)
  const unsupported = new FormData()
  unsupported.set('file', new File(['abc'], 'notes.txt', { type: 'text/plain' }))
  expect((await fetch(new Request('http://local/v1/audio/transcriptions', authed({ method: 'POST', body: unsupported })))).status).toBe(415)
  const oversized = new FormData()
  oversized.set('file', new File(['12345'], 'voice.wav', { type: 'audio/wav' }))
  expect((await fetch(new Request('http://local/v1/audio/transcriptions', authed({ method: 'POST', body: oversized })))).status).toBe(413)
  expect(calls).toBe(0)
})

test('missing or invalid bearer is rejected before upstream fetch', async () => {
  const { fetch, calls } = makeGateway()
  const missing = await fetch(new Request('http://local/v1/images/generations', {
    method: 'POST',
    body: '{}',
  }))
  const invalid = await fetch(new Request('http://local/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: 'Bearer nope' },
    body: '{}',
  }))
  expect(missing.status).toBe(401)
  expect(invalid.status).toBe(401)
  expect(calls).toEqual([])
})

test('chat completions stream is proxied to Qwen with the server key and logged after consumption', async () => {
  const { fetch, calls, usage } = makeGateway()
  const rawBody = JSON.stringify({ model: 'qwen3-coder-plus', stream: true })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: rawBody,
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toBe('data: hello\n\n')
  expect(calls[0]?.url).toBe('https://qwen.example/v1/chat/completions')
  expect(calls[0]?.body).toBe(rawBody)
  expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer qwen-secret')
  expect(usage.rows).toMatchObject([{ user: 'owner-a', model: 'qwen', ok: true, status: 200 }])
  // 服务器密钥只出现在给上游的 Authorization 头,绝不进入客户端响应或用量日志。
  expect(text).not.toContain('qwen-secret')
  expect(JSON.stringify(usage.rows)).not.toContain('qwen-secret')
})

test('non-stream JSON responses are proxied through unchanged', async () => {
  const fetch = createGatewayFetch({
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    webSearchImpl: null,
    fetchImpl: async () => Response.json({
      id: 'chatcmpl-1', model: 'qwen3-coder-plus',
      choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus', messages: [{ role: 'user', content: 'hi' }] }),
  })))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.choices[0].message.content).toBe('你好')
  expect(body.usage.total_tokens).toBe(5)
})

test('SSE tool_call deltas are streamed through byte-for-byte (tool call increments preserved)', async () => {
  const chunk = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"p"}}]}}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ath\\":1}"}}]},"finish_reason":"tool_calls"}]}\n\n'
    + 'data: [DONE]\n\n'
  const fetch = createGatewayFetch({
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    webSearchImpl: null,
    fetchImpl: async () => new Response(chunk, { headers: { 'content-type': 'text/event-stream' } }),
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus', stream: true, tools: [{ type: 'function', function: { name: 'Read' } }] }),
  })))
  expect(await res.text()).toBe(chunk)
})

test('function tools and tool_choice pass through to Qwen unchanged — no hidden search channel is injected', async () => {
  const { fetch, calls } = makeGateway()
  const response = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-coder-plus',
      stream: true,
      tool_choice: 'auto',
      tools: [
        { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
        { type: 'web_search' },
      ],
    }),
  })))
  await response.text()
  const upstreamBody = JSON.parse(calls[0]!.body!)
  // 客户端传什么工具就原样透传,网关既不追加也不改写(联网搜索走独立 /v1/web_search)。
  expect(upstreamBody.tool_choice).toBe('auto')
  expect(upstreamBody.tools).toEqual([
    { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
    { type: 'web_search' },
  ])
})

test('malformed chat JSON fails closed before capacity or upstream work', async () => {
  const { fetch, calls } = makeGateway()
  const malformed = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  })))
  expect(malformed.status).toBe(400)
  expect(calls).toEqual([])
})

test('client cannot bypass the model whitelist: an out-of-list model is coerced to the server model', async () => {
  const { fetch, calls } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'unapproved-expensive-model', messages: [{ role: 'user', content: 'hi' }] }),
  })))
  expect(res.status).toBe(200)
  // 上游只会收到服务器配置的模型,客户端无法指定别的模型。
  expect(JSON.parse(calls[0]!.body!).model).toBe('qwen3-coder-plus')
})

test('Qwen retries transient upstream responses and records the attempt count without leaking details', async () => {
  const usage = new MemoryUsageStore()
  const calls: string[] = []
  const sleeps: number[] = []
  const fetch = createGatewayFetch({
    env: env({ GW_Q_CHAT: '10', GW_QWEN_MAX_RETRIES: '2' }),
    usageStore: usage,
    transcribeImpl: null,
    webSearchImpl: null,
    qwenRetrySleep: async ms => { sleeps.push(ms) },
    qwenRetryRandom: () => 0,
    fetchImpl: async (_input, init) => {
      calls.push(String(init?.body))
      if (calls.length === 1) return new Response('provider detail', { status: 429, headers: { 'retry-after': '0' } })
      return new Response('data: done\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const response = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus', stream: true }),
  })))
  expect(response.status).toBe(200)
  await response.text()
  expect(calls).toHaveLength(2)
  expect(sleeps).toEqual([0])
  expect(usage.rows[0]?.note).toBe('attempts=2')
  expect(JSON.stringify(usage.rows)).not.toContain('provider detail')
})

test('Qwen distinguishes upstream account exhaustion from temporary concurrency limits and redacts detail', async () => {
  const fetch = createGatewayFetch({
    env: env({ GW_QWEN_MAX_RETRIES: '0' }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    webSearchImpl: null,
    fetchImpl: async () => Response.json({
      error: { code: 'insufficient_quota', message: 'provider balance and account details' },
    }, { status: 429 }),
  })
  const response = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus', messages: [] }),
  })))

  expect(response.status).toBe(429)
  const body = await response.json()
  expect(body).toEqual({ detail: '模型服务额度不足，请稍后再试或联系管理员' })
  // 上游原始错误细节(余额/账户)不外泄给客户端。
  expect(JSON.stringify(body)).not.toContain('balance')
})

test('Qwen concurrency permit is held until the proxied stream completes', async () => {
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined
  let upstreamCalls = 0
  const fetch = createGatewayFetch({
    env: env({
      GW_Q_CHAT: '10',
      GW_QWEN_CONC: '1',
      GW_QWEN_USER_CONC: '1',
      GW_QWEN_QUEUE_MAX_WAIT: '1',
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    webSearchImpl: null,
    fetchImpl: async () => {
      upstreamCalls += 1
      if (upstreamCalls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            firstController = controller
            controller.enqueue(new TextEncoder().encode('data: first\n\n'))
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('data: second\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const request = () => new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus', stream: true }),
  }))

  const first = await fetch(request())
  const secondPromise = fetch(request())
  await Promise.resolve()
  await Promise.resolve()
  expect(upstreamCalls).toBe(1)

  firstController?.close()
  await first.text()
  const second = await secondPromise
  expect(upstreamCalls).toBe(2)
  expect(await second.text()).toBe('data: second\n\n')
})

test('client cancellation aborts the upstream request and fails closed (no hung request)', async () => {
  const controller = new AbortController()
  const fetch = createGatewayFetch({
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    webSearchImpl: null,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      }
      if (init?.signal?.aborted) return abort()
      init?.signal?.addEventListener('abort', abort, { once: true })
    }),
  })
  const pending = fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus', stream: true }),
    signal: controller.signal,
  })))
  controller.abort()
  const res = await pending
  expect(res.status).toBeGreaterThanOrEqual(400)
})

test('image generation ignores legacy daily quota settings and proxies every capacity-admitted request', async () => {
  const { fetch, calls } = makeGateway()
  const first = await fetch(new Request('http://local/v1/images/generations', authed({
    method: 'POST',
    body: JSON.stringify({ prompt: 'poster' }),
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  const second = await fetch(new Request('http://local/v1/images/generations', authed({
    method: 'POST',
    body: JSON.stringify({ prompt: 'poster 2' }),
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(calls.map(c => c.url)).toEqual([
    'https://relay.example/relay/openai/v1/images/generations',
    'https://relay.example/relay/openai/v1/images/generations',
  ])
})

test('image edits preserves multipart content-type boundary', async () => {
  const { fetch, calls } = makeGateway({ GW_Q_IMG: '3' })
  const res = await fetch(new Request('http://local/v1/images/edits', authed({
    method: 'POST',
    body: 'multipart-body',
    headers: {
      Authorization: 'Bearer app-token',
      'Content-Type': 'multipart/form-data; boundary=abc123',
    },
  })))
  expect(res.status).toBe(200)
  expect(calls[0]?.url).toBe('https://relay.example/relay/openai/v1/images/edits')
  expect((calls[0]?.init?.headers as Record<string, string>)['Content-Type']).toBe('multipart/form-data; boundary=abc123')
})

test('ark chat and seedream image routes use ark key and log usage separately', async () => {
  const { fetch, calls, usage } = makeGateway()
  const chat = await fetch(new Request('http://local/v1/ark/chat/completions', authed({
    method: 'POST',
    body: '{}',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  const image = await fetch(new Request('http://local/v1/ark/images/generations', authed({
    method: 'POST',
    body: '{}',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect(chat.status).toBe(200)
  expect(image.status).toBe(200)
  expect(calls.map(c => c.url)).toEqual([
    'https://ark.example/api/v3/chat/completions',
    'https://ark.example/api/v3/images/generations',
  ])
  expect(usage.rows.map(row => row.model)).toEqual(['ark_chat', 'ark_img'])
})

test('amap route injects key into query and records usage', async () => {
  const { fetch, calls, usage } = makeGateway()
  const res = await fetch(new Request('http://local/v1/amap/v3/weather/weatherInfo?city=310000', authed()))
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ key_seen: 'amap-secret' })
  expect(calls[0]?.url).toBe('https://amap.example/v3/weather/weatherInfo?city=310000&key=amap-secret')
  expect(usage.rows).toMatchObject([{ model: 'amap', ok: true }])
})

test('missing optional Ark and AMap keys return 503 without upstream fetch', async () => {
  const { fetch, calls } = makeGateway({ GW_ARK_KEY: '', GW_AMAP_KEY: '' })
  const arkChat = await fetch(new Request('http://local/v1/ark/chat/completions', authed({ method: 'POST', body: '{}' })))
  const arkImage = await fetch(new Request('http://local/v1/ark/images/generations', authed({ method: 'POST', body: '{}' })))
  const amap = await fetch(new Request('http://local/v1/amap/v3/weather/weatherInfo?city=310000', authed()))
  expect(arkChat.status).toBe(503)
  expect(arkImage.status).toBe(503)
  expect(amap.status).toBe(503)
  expect(calls).toEqual([])
})

test('admin usage requires admin token and returns recent rows', async () => {
  const { fetch } = makeGateway()
  await fetch(new Request('http://local/v1/images/generations', authed({
    method: 'POST',
    body: '{}',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect((await fetch(new Request('http://local/admin/usage?token=bad'))).status).toBe(403)
  const res = await fetch(new Request('http://local/admin/usage?token=admin-secret&n=5'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.today_by_model).toMatchObject([{ model: 'img', total: 1, ok: 1 }])
  expect(body.recent[0]).toMatchObject({ user: 'owner-a', model: 'img', ok: 1 })
})

test('image task submit/poll proxies to relay tasks base with relay token when configured', async () => {
  const { fetch, calls } = makeGateway({ GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks', GW_Q_IMG: '5' })
  const submit = await fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'x', input_fidelity: 'high' }),
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect(submit.status).toBe(200)
  const poll = await fetch(new Request('http://local/v1/images/tasks/task-1', authed({ method: 'GET' })))
  expect(poll.status).toBe(200)
  expect(calls.map(c => c.url)).toEqual([
    'https://relay.example/relay/imgtasks/images/tasks',
    'https://relay.example/relay/imgtasks/images/tasks/task-1',
  ])
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer relay-secret')
  expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ input_fidelity: 'high' })
})

test('image task endpoints return 503 when GW_RELAY_TASKS_BASE unset', async () => {
  const { fetch, calls } = makeGateway()
  const submit = await fetch(new Request('http://local/v1/images/tasks', authed({ method: 'POST', body: '{}' })))
  expect(submit.status).toBe(503)
  const poll = await fetch(new Request('http://local/v1/images/tasks/x', authed({ method: 'GET' })))
  expect(poll.status).toBe(503)
  expect(calls.length).toBe(0)
})
