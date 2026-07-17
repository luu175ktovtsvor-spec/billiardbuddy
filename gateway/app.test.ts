import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'
import type { GatewayTranscriber } from './transcription'

function env(overrides: Record<string, string | undefined> = {}) {
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
    GW_RELAY_BASE: 'https://relay.example/relay/openai/v1',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_APP_TOKENS: JSON.stringify({ 'app-token': 'owner-a' }),
    GW_ADMIN_TOKEN: 'admin-secret',
    GW_Q_CHAT: '2',
    GW_Q_IMG: '1',
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
        // 视觉桥接调 MiMo 时用 stream:false + 数组 content(文本+图片)发起非流式请求;
        // 其它一切 /chat/completions 调用(含普通 mimo-v2.5 多模态直连)仍走原来的 SSE 假响应。
        if (url.includes('mimo.example')) {
          let parsedBody: Record<string, unknown> | null = null
          try { parsedBody = JSON.parse(body) } catch { /* ignore */ }
          const messages = Array.isArray(parsedBody?.messages) ? parsedBody!.messages as Array<Record<string, unknown>> : []
          const looksLikeVisionCall = parsedBody?.stream === false && Array.isArray(messages[0]?.content)
          if (looksLikeVisionCall) {
            return Response.json({ choices: [{ message: { content: '图片理解结果：一张测试占位截图，包含一个按钮。' } }] })
          }
        }
        return new Response('data: hello\n\n', { headers: { 'content-type': 'text/event-stream' } })
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
  // RPM 默认值已放开到不再节流正常文字流量;USER_CONC 默认 = CONC(不再单独节流单装机)。
  // GW_*_CONC 全局并发闸不变,仍是保护上游的高水位紧急上限。
  expect(body.limits.qwen_rpm).toBe(100_000)
  expect(body.limits.qwen_conc).toBe(16)
  expect(body.limits.qwen_user_conc).toBe(16)
  expect(body.limits.mimo_rpm).toBe(100_000)
  expect(body.limits.mimo_conc).toBe(16)
  expect(body.limits.mimo_user_conc).toBe(16)
  expect(body.quota).toEqual({})
  expect(body.features.transcription).toBe(false)
  expect(body.features.chat_qwen).toBe(true)
  expect(body.features.chat_mimo).toBe(true)
  expect(body.capacity.qwen).toMatchObject({ active: 0, queued: 0, maxConcurrent: 16 })
  expect(body.capacity.mimo).toMatchObject({ active: 0, queued: 0, maxConcurrent: 16 })
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
  // 千问路由绝不碰 MiMo 上游。
  expect(calls.every(c => !c.url.includes('mimo.example'))).toBe(true)
})

test('chat completions requires a valid app token before any routing or upstream fetch', async () => {
  const { fetch, calls } = makeGateway()
  const missing = await fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus' }),
  }))
  const invalid = await fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5' }),
  }))
  expect(missing.status).toBe(401)
  expect(invalid.status).toBe(401)
  expect(calls).toEqual([])
})

test('chat completions routes an allowlisted MiMo model to the MiMo upstream with the MiMo key and usage label', async () => {
  const { fetch, calls, usage } = makeGateway()
  const rawBody = JSON.stringify({
    model: 'mimo-v2.5',
    stream: true,
    tool_choice: 'auto',
    tools: [
      { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
      { type: 'web_search' },
    ],
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: rawBody,
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toBe('data: hello\n\n')
  // 走 MiMo 上游、用 MiMo 密钥;千问上游一次都没碰(无跨上游回退)。
  expect(calls[0]?.url).toBe('https://mimo.example/v1/chat/completions')
  expect(calls.every(c => !c.url.includes('qwen.example'))).toBe(true)
  expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer mimo-secret')
  // tools/tool_choice 原样透传,网关既不注入隐藏搜索通道也不改写客户端工具。
  const upstreamBody = JSON.parse(calls[0]!.body!)
  expect(upstreamBody.model).toBe('mimo-v2.5')
  expect(upstreamBody.tool_choice).toBe('auto')
  expect(upstreamBody.tools).toEqual([
    { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
    { type: 'web_search' },
  ])
  expect(usage.rows).toMatchObject([{ user: 'owner-a', model: 'mimo', ok: true, status: 200 }])
  // MiMo 密钥只在给上游的 Authorization 头,绝不进入响应或用量日志。
  expect(text).not.toContain('mimo-secret')
  expect(JSON.stringify(usage.rows)).not.toContain('mimo-secret')
})

test('a MiMo upstream 5xx failure never falls back to the Qwen upstream', async () => {
  const usage = new MemoryUsageStore()
  const calls: string[] = []
  const fetch = createGatewayFetch({
    env: env({ GW_MIMO_MAX_RETRIES: '0' }),
    usageStore: usage,
    transcribeImpl: null,
    fetchImpl: async input => {
      const url = String(input)
      calls.push(url)
      if (url.includes('mimo.example')) return new Response('mimo upstream boom', { status: 500 })
      // 若网关错误地回退到千问,这里会返回 200,让断言失败。
      return new Response('data: qwen fallback\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5', stream: true }),
  })))
  expect(res.status).toBe(500)
  const body = await res.json()
  expect(body).toEqual({ detail: '模型服务暂时不可用，请稍后重试' })
  expect(String(body)).not.toContain('mimo upstream boom')
  // 只打了 MiMo 上游一次,千问上游一次都没碰。
  expect(calls).toEqual(['https://mimo.example/v1/chat/completions'])
  expect(usage.rows).toMatchObject([{ model: 'mimo', ok: false, status: 500 }])
})

test('MiMo does not retry a 429 even when retries are configured — it surfaces immediately', async () => {
  const usage = new MemoryUsageStore()
  const bodies: string[] = []
  const fetch = createGatewayFetch({
    // Even with a retry budget, a 429 is never retried (no amplification with the CC CLI).
    env: env({ GW_MIMO_MAX_RETRIES: '1' }),
    usageStore: usage,
    transcribeImpl: null,
    fetchImpl: async (_input, init) => {
      bodies.push(String(init?.body))
      return new Response('provider detail', { status: 429, headers: { 'retry-after': '0' } })
    },
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5', stream: true }),
  })))
  expect(res.status).toBe(429)
  expect(bodies).toHaveLength(1)
  expect(usage.rows[0]?.note).toBe('attempts=1')
  expect(usage.rows[0]?.model).toBe('mimo')
  expect(JSON.stringify(usage.rows)).not.toContain('provider detail')
})

test('MiMo retries a transient 5xx at most once then succeeds, logging the attempt count without leaking detail', async () => {
  const usage = new MemoryUsageStore()
  const bodies: string[] = []
  const sleeps: number[] = []
  const fetch = createGatewayFetch({
    env: env({ GW_MIMO_MAX_RETRIES: '2' }), // clamps to 1 → exactly one extra attempt
    usageStore: usage,
    transcribeImpl: null,
    mimoRetrySleep: async ms => { sleeps.push(ms) },
    mimoRetryRandom: () => 0,
    fetchImpl: async (_input, init) => {
      bodies.push(String(init?.body))
      if (bodies.length === 1) return new Response('provider detail', { status: 503, headers: { 'retry-after': '0' } })
      return new Response('data: done\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5', stream: true }),
  })))
  expect(res.status).toBe(200)
  await res.text()
  expect(bodies).toHaveLength(2)
  expect(sleeps).toEqual([0])
  expect(usage.rows[0]?.note).toBe('attempts=2')
  expect(usage.rows[0]?.model).toBe('mimo')
  expect(JSON.stringify(usage.rows)).not.toContain('provider detail')
})

test('MiMo distinguishes upstream account exhaustion from concurrency limits and redacts detail', async () => {
  const fetch = createGatewayFetch({
    env: env({ GW_MIMO_MAX_RETRIES: '0' }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: async () => Response.json({
      error: { code: 'insufficient_quota', message: 'provider balance and account details' },
    }, { status: 429 }),
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5', messages: [] }),
  })))
  expect(res.status).toBe(429)
  const body = await res.json()
  expect(body).toEqual({ detail: '模型服务额度不足，请稍后再试或联系管理员' })
  expect(JSON.stringify(body)).not.toContain('balance')
})

test('an out-of-list default model routes to Qwen and is coerced to the Qwen server model', async () => {
  const { fetch, calls, usage } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'unapproved-expensive-model', messages: [{ role: 'user', content: 'hi' }] }),
  })))
  expect(res.status).toBe(200)
  await res.text()
  // 白名单外的 model 交给默认上游千问,并被改写成千问服务器模型;MiMo 一次都没碰。
  expect(calls[0]?.url).toBe('https://qwen.example/v1/chat/completions')
  expect(JSON.parse(calls[0]!.body!).model).toBe('qwen3-coder-plus')
  expect(usage.rows).toMatchObject([{ model: 'qwen', ok: true }])
})

test('a MiMo-allowlisted model with MiMo unconfigured fails closed with 503 and never routes to Qwen', async () => {
  const { fetch, calls, usage } = makeGateway({ GW_MIMO_KEY: '' })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5', messages: [{ role: 'user', content: 'hi' }] }),
  })))
  // 命中 MiMo 白名单但 MiMo 未配置 → 显式 503,绝不改投千问;上游一次都没碰,用量也不记。
  expect(res.status).toBe(503)
  expect(calls).toEqual([])
  expect(usage.rows).toEqual([])
})

test('healthz reports chat_mimo=false but chat_qwen=true when only the MiMo key is missing', async () => {
  const { fetch } = makeGateway({ GW_MIMO_KEY: '' })
  const res = await fetch(new Request('http://local/healthz', authed({ headers: { Authorization: 'Bearer app-token' } })))
  expect(res.status).toBe(200)
  const body = await res.json() as { features: { chat_qwen: boolean; chat_mimo: boolean } }
  expect(body.features.chat_qwen).toBe(true)
  expect(body.features.chat_mimo).toBe(false)
})

test('when the routed default provider (Qwen) is unconfigured, chat fails closed with 503 and no upstream fetch', async () => {
  const { fetch, calls } = makeGateway({ GW_QWEN_KEY: '' })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus', messages: [] }),
  })))
  expect(res.status).toBe(503)
  expect(calls).toEqual([])
})

test('non-stream JSON responses are proxied through unchanged', async () => {
  const fetch = createGatewayFetch({
    env: env(),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
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
  // 客户端传什么工具就原样透传,网关既不追加也不改写。
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

// ── 请求体真正有界(readRequestBodyBounded):不再先把整个 body 读进内存再检查长度 ──────────

test('a declared Content-Length over the limit is rejected with 413 before the body stream is ever read', async () => {
  const { fetch, calls } = makeGateway({ GW_VISION_MAX_TOTAL_BYTES: '100' })
  // 一个"挂起"的 body 流:pull() 什么都不做,既不 enqueue 也不 close。若实现在 Content-Length
  // 预检之后才去读它,这个测试会挂起到超时失败;正确实现应在读 body 之前就基于声明的
  // Content-Length 立即拒绝,拿到 413 且从不触碰这个流。
  const hangingStream = new ReadableStream<Uint8Array>({ pull() { /* 永不 enqueue/close */ } })
  const req = new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: hangingStream,
    duplex: 'half',
    headers: { 'Content-Type': 'application/json', 'content-length': '999999' },
  } as RequestInit))
  const res = await fetch(req)
  expect(res.status).toBe(413)
  expect(calls).toEqual([])
})

test('real streamed body bytes exceeding the limit are rejected with 413 even without a Content-Length header (chunked-style body)', async () => {
  const { fetch, calls } = makeGateway({ GW_VISION_MAX_TOTAL_BYTES: '50' })
  const chunk = new TextEncoder().encode('x'.repeat(40))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk) // 40 字节
      controller.enqueue(chunk) // 累计 80 字节,超过 50 字节上限,且没有 Content-Length 头可依赖
      controller.close()
    },
  })
  const req = new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { 'Content-Type': 'application/json' },
  } as RequestInit))
  const res = await fetch(req)
  expect(res.status).toBe(413)
  expect(calls).toEqual([])
})

test('a lying (understated) Content-Length does not bypass the real streamed byte-count limit', async () => {
  const { fetch, calls } = makeGateway({ GW_VISION_MAX_TOTAL_BYTES: '50' })
  const chunk = new TextEncoder().encode('y'.repeat(40))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk)
      controller.enqueue(chunk) // 实际 80 字节,远超声明的 Content-Length(10)和上限(50)
      controller.close()
    },
  })
  const req = new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { 'Content-Type': 'application/json', 'content-length': '10' },
  } as RequestInit))
  const res = await fetch(req)
  expect(res.status).toBe(413)
  expect(calls).toEqual([])
})

test('client abort mid body-read fails closed with 499 (never silently treated as a valid/empty body)', async () => {
  const { fetch, calls } = makeGateway()
  const hangingStream = new ReadableStream<Uint8Array>({ pull() { /* 永不 enqueue/close */ } })
  const ac = new AbortController()
  const req = new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: hangingStream,
    duplex: 'half',
    signal: ac.signal,
    headers: { 'Content-Type': 'application/json' },
  } as RequestInit))
  const pending = fetch(req)
  setTimeout(() => ac.abort(), 20)
  const res = await pending
  expect(res.status).toBe(499)
  expect(calls).toEqual([])
})

test('a body stream read error fails closed with 400 (never silently treated as done)', async () => {
  const { fetch, calls } = makeGateway()
  const erroringStream = new ReadableStream<Uint8Array>({
    pull() { throw new Error('simulated read failure') },
  })
  const req = new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: erroringStream,
    duplex: 'half',
    headers: { 'Content-Type': 'application/json' },
  } as RequestInit))
  const res = await fetch(req)
  expect(res.status).toBe(400)
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

test('Qwen retries a transient 5xx at most once and records the attempt count without leaking details', async () => {
  const usage = new MemoryUsageStore()
  const calls: string[] = []
  const sleeps: number[] = []
  const fetch = createGatewayFetch({
    env: env({ GW_Q_CHAT: '10', GW_QWEN_MAX_RETRIES: '2' }), // clamps to 1
    usageStore: usage,
    transcribeImpl: null,
    qwenRetrySleep: async ms => { sleeps.push(ms) },
    qwenRetryRandom: () => 0,
    fetchImpl: async (_input, init) => {
      calls.push(String(init?.body))
      if (calls.length === 1) return new Response('provider detail', { status: 503, headers: { 'retry-after': '0' } })
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

test('Qwen does not retry a 429 even with a retry budget — surfaces it in one upstream call', async () => {
  const usage = new MemoryUsageStore()
  const calls: string[] = []
  const fetch = createGatewayFetch({
    env: env({ GW_QWEN_MAX_RETRIES: '1' }),
    usageStore: usage,
    transcribeImpl: null,
    fetchImpl: async (_input, init) => {
      calls.push(String(init?.body))
      return new Response('provider detail', { status: 429, headers: { 'retry-after': '0' } })
    },
  })
  const response = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3-coder-plus' }),
  })))
  expect(response.status).toBe(429)
  expect(calls).toHaveLength(1)
  expect(usage.rows[0]?.note).toBe('attempts=1')
})

test('Qwen distinguishes upstream account exhaustion from temporary concurrency limits and redacts detail', async () => {
  const fetch = createGatewayFetch({
    env: env({ GW_QWEN_MAX_RETRIES: '0' }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
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

test('missing optional key routes are gone (ark/amap/web_search removed)', async () => {
  const { fetch, calls } = makeGateway()
  const arkChat = await fetch(new Request('http://local/v1/ark/chat/completions', authed({ method: 'POST', body: '{}' })))
  const amap = await fetch(new Request('http://local/v1/amap/v3/weather/weatherInfo?city=310000', authed()))
  const webSearch = await fetch(new Request('http://local/v1/web_search', authed({ method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })))
  expect(arkChat.status).toBe(404)
  expect(amap.status).toBe(404)
  expect(webSearch.status).toBe(404)
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

test('GET /v1/models requires auth and lists explicit Qwen/MiMo/DeepSeek catalog for configured upstreams', async () => {
  const { fetch } = makeGateway()
  const unauth = await fetch(new Request('http://local/v1/models', { method: 'GET' }))
  expect(unauth.status).toBe(401)
  const res = await fetch(new Request('http://local/v1/models', authed({ method: 'GET' })))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.object).toBe('list')
  const catalog = (body.data as Array<{ id: string; owned_by: string }>).map(m => ({ id: m.id, owned_by: m.owned_by }))
  expect(catalog).toContainEqual({ id: 'qwen3-coder-plus', owned_by: 'qwen' })
  expect(catalog).toContainEqual({ id: 'mimo-v2.5', owned_by: 'mimo' })
  expect(catalog).toContainEqual({ id: 'deepseek-v4-flash', owned_by: 'deepseek' })
})

test('GET /v1/models omits an upstream whose key is missing (honest catalog)', async () => {
  const { fetch } = makeGateway({ GW_DEEPSEEK_KEY: '', GW_MIMO_KEY: '' })
  const res = await fetch(new Request('http://local/v1/models', authed({ method: 'GET' })))
  const body = await res.json()
  const owners = new Set((body.data as Array<{ owned_by: string }>).map(m => m.owned_by))
  expect(owners.has('qwen')).toBe(true)
  expect(owners.has('mimo')).toBe(false)
  expect(owners.has('deepseek')).toBe(false)
})

test('deepseek-v4-flash routes to the DeepSeek upstream and injects a trusted opaque user', async () => {
  const { fetch, calls, usage } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json', 'X-QF-Client-ID': 'install-0001' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })))
  expect(res.status).toBe(200)
  await res.text()
  expect(calls[0].url).toBe('https://deepseek.example/chat/completions')
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer deepseek-secret')
  const sent = JSON.parse(calls[0].body ?? '{}')
  expect(sent.model).toBe('deepseek-v4-flash')
  expect(String(sent.user_id)).toStartWith('bb_') // official user_id field, opaque, not the raw installationId
  expect(String(sent.user_id)).not.toContain('install-0001')
  expect(usage.rows[0]?.model).toBe('deepseek')
})

test('a deepseek model with no GW_DEEPSEEK_KEY returns 503 and never falls back to Qwen', async () => {
  const { fetch, calls } = makeGateway({ GW_DEEPSEEK_KEY: '' })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
  })))
  expect(res.status).toBe(503)
  expect(calls.length).toBe(0) // fail closed — no upstream call at all, no cross-provider fallback
})

test('healthz reports chat_deepseek and deepseek capacity when configured', async () => {
  const { fetch } = makeGateway()
  const res = await fetch(new Request('http://local/healthz', authed({})))
  const body = await res.json()
  expect(body.features.chat_deepseek).toBe(true)
  expect(body.capacity.deepseek).toBeDefined()
  expect(body.limits.deepseek_conc).toBe(32)
  // USER_CONC 默认 = CONC(不再单独节流单装机)。
  expect(body.limits.deepseek_user_conc).toBe(32)
})

test('after relaxing default RPM/concurrency, plain-text chat completions still route to the correct upstream', async () => {
  const { fetch, calls, usage } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '普通文字请求，不带图片' }] }),
  })))
  expect(res.status).toBe(200)
  await res.text()
  expect(calls[0]?.url).toBe('https://deepseek.example/chat/completions')
  // 没有图片,不触发视觉桥接,一次都不碰 MiMo。
  expect(calls.every(c => !c.url.includes('mimo.example'))).toBe(true)
  expect(usage.rows.some(row => row.model === 'vision')).toBe(false)
})

test('a DeepSeek request carrying an image is bridged through MiMo before reaching DeepSeek', async () => {
  const { fetch, calls, usage } = makeGateway()
  const rawBody = JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张截图里是什么' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } },
      ],
    }],
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
    body: rawBody,
  })))
  expect(res.status).toBe(200)
  await res.text()
  const mimoCalls = calls.filter(c => c.url.includes('mimo.example'))
  const deepseekCalls = calls.filter(c => c.url.includes('deepseek.example'))
  expect(mimoCalls).toHaveLength(1)
  expect(deepseekCalls).toHaveLength(1)
  // DeepSeek 收到的是去图后的请求体:无 image_url,含 MiMo 生成的视觉文本。
  expect(deepseekCalls[0]?.body).not.toContain('image_url')
  expect(deepseekCalls[0]?.body).toContain('图片理解结果')
  expect(usage.rows.some(row => row.model === 'vision' && row.ok === true)).toBe(true)
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
