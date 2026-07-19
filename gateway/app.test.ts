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
  // RPM 默认值已放开到不再节流正常文字流量。单装机默认按产品的 5 窗口上限，
  // 全局闸与有界队列继续保护上游和网关内存。
  expect(body.limits.qwen_rpm).toBe(100_000)
  expect(body.limits.qwen_conc).toBe(16)
  expect(body.limits.qwen_user_conc).toBe(5)
  expect(body.limits.qwen_token_conc).toBe(16)
  expect(body.limits.qwen_queue_max).toBe(128)
  // The test fixture explicitly makes Qwen queue timeout short; production default is 120s.
  expect(body.limits.qwen_queue_max_wait_seconds).toBe(0.2)
  expect(body.limits.mimo_rpm).toBe(100_000)
  expect(body.limits.mimo_conc).toBe(64)
  expect(body.limits.mimo_user_conc).toBe(1)
  expect(body.limits.mimo_inflight_per_user).toBe(1)
  expect(body.limits.mimo_token_conc).toBe(64)
  expect(body.limits.mimo_queue_max).toBe(64)
  expect(body.limits.mimo_queue_max_wait_seconds).toBe(5)
  expect(body.limits.vision_conc).toBe(12)
  expect(body.limits.vision_queue_max).toBe(24)
  expect(body.limits.vision_queue_max_wait_ms).toBe(3_000)
  expect(body.limits.vision_per_client_conc).toBe(1)
  expect(body.limits.vision_max_inflight_per_client).toBe(1)
  // Default one-slot fairness means a multi-image request is serialized rather than
  // allowing its own first image to reject the second at the shared MiMo gate.
  expect(body.limits.vision_per_request_conc).toBe(1)
  expect(body.limits.img_queue_max).toBe(100)
  expect(body.limits.relay_submit_timeout_ms).toBe(15_000)
  expect(body.limits.ingress_inflight_body_bytes).toBe(256 * 1024 * 1024)
  expect(body.quota).toEqual({})
  expect(body.features.transcription).toBe(false)
  expect(body.features.chat_qwen).toBe(true)
  expect(body.features.chat_mimo).toBe(true)
  expect(body.features.vision_bridge).toBe(true)
  expect(body.capacity.qwen).toMatchObject({ active: 0, queued: 0, maxConcurrent: 16, maxConcurrentPerUser: 5, queueMax: 128, oldestQueueMs: 0 })
  expect(body.capacity.mimo).toMatchObject({ active: 0, queued: 0, maxConcurrent: 64, maxConcurrentPerUser: 1, queueMax: 64, oldestQueueMs: 0 })
  expect(body.capacity.vision).toEqual({
    active: 0,
    queued: 0,
    limit: 12,
    queueMax: 24,
    perClientConc: 1,
    maxInflightPerClient: 1,
    oldestQueueMs: 0,
  })
  expect(body.capacity.ingress_body).toEqual({ reservedBytes: 0, maxBytes: 256 * 1024 * 1024 })
})

test('native Anthropic WebSearchTool reaches DeepSeek directly with server-only credentials', async () => {
  const usage = new MemoryUsageStore()
  const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = []
  const fetch = createGatewayFetch({
    env: env({ GW_DEEPSEEK_BASE: 'https://api.deepseek.com' }),
    usageStore: usage,
    transcribeImpl: null,
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        init,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(
        'event: message_start\ndata: {"type":"message_start"}\n\n'
          + 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"server_tool_use","name":"web_search"}}\n\n'
          + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"web_search_tool_result"}}\n\n',
        { headers: { 'content-type': 'text/event-stream', 'request-id': 'deepseek-request-id' } },
      )
    },
  })

  const response = await fetch(new Request('http://local/v1/messages', authed({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
      'X-QF-Client-ID': 'desktop-install-1234',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      stream: true,
      messages: [{ role: 'user', content: '查一下最新台球赛事' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      metadata: { user_id: 'forged-user', trace: 'safe' },
    }),
  })))

  expect(response.status).toBe(200)
  const streamed = await response.text()
  expect(streamed).toContain('"type":"server_tool_use"')
  expect(streamed).toContain('"type":"web_search_tool_result"')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
  const headers = calls[0]?.init?.headers as Record<string, string>
  expect(headers['x-api-key']).toBe('deepseek-secret')
  expect(headers.Authorization).toBeUndefined()
  expect(headers['anthropic-version']).toBe('2023-06-01')
  expect(headers['anthropic-beta']).toBe('web-search-2025-03-05')
  expect(calls[0]?.body).toMatchObject({
    model: 'deepseek-v4-flash',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    metadata: { trace: 'safe' },
  })
  expect((calls[0]?.body.metadata as Record<string, string>).user_id).toMatch(/^bb_[a-f0-9]{32}$/)
  expect(JSON.stringify(calls[0]?.body)).not.toContain('forged-user')
  expect(usage.rows).toMatchObject([{ user: 'owner-a', model: 'deepseek_web_search', ok: true, status: 200 }])
  expect(JSON.stringify(usage.rows)).not.toContain('deepseek-secret')
})

test('native Anthropic endpoint rejects non-search tools and fails closed without DeepSeek', async () => {
  const { fetch, calls } = makeGateway()
  const nonSearch = await fetch(new Request('http://local/v1/messages', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      tools: [{ type: 'computer_20241022' }],
    }),
  })))
  expect(nonSearch.status).toBe(400)
  expect(calls).toEqual([])

  const unavailable = makeGateway({ GW_DEEPSEEK_KEY: '' })
  const noKey = await unavailable.fetch(new Request('http://local/v1/messages', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      tools: [{ type: 'web_search_20250305' }],
    }),
  })))
  expect(noKey.status).toBe(503)
  expect(unavailable.calls).toEqual([])
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

test('long-lived chat, native Messages, and every relay image task operation disable Bun idle timeout before forwarding', async () => {
  const timeoutCalls: number[] = []
  const fetch = createGatewayFetch({
    env: env({ GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks' }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: async () => new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  })
  const server = { timeout: (_request: Request, seconds: number) => { timeoutCalls.push(seconds) } }

  const chat = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST', body: JSON.stringify({ model: 'qwen3-coder-plus', messages: [] }),
  })), server)
  expect(chat.status).toBe(200)

  const messages = await fetch(new Request('http://local/v1/messages', authed({
    method: 'POST', body: JSON.stringify({ model: 'deepseek-v4-flash', tools: [{ type: 'computer_20241022' }] }),
  })), server)
  expect(messages.status).toBe(400)

  const image = await fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST', body: JSON.stringify({ prompt: '台球海报' }),
  })), server)
  expect(image.status).toBe(200)

  const poll = await fetch(new Request('http://local/v1/images/tasks/task-1', authed({ method: 'GET' })), server)
  expect(poll.status).toBe(200)

  const cancel = await fetch(new Request('http://local/v1/images/tasks/task-1/cancel', authed({ method: 'POST' })), server)
  expect(cancel.status).toBe(200)

  expect(timeoutCalls).toEqual([0, 0, 0, 0, 0])
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
  const missing = await fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
  }))
  const invalid = await fetch(new Request('http://local/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer nope' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
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
  expect(usage.rows[0]?.note).toMatch(/^queue_ms=\d+;attempts=1$/)
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
  expect(usage.rows[0]?.note).toMatch(/^queue_ms=\d+;attempts=2$/)
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

test('a slowloris-style chat body hits the bounded ingress read deadline after Bun idle timeout is disabled', async () => {
  const { fetch, calls } = makeGateway({ GW_INGRESS_BODY_READ_TIMEOUT_MS: '20' })
  let cancelled = false
  const hangingStream = new ReadableStream<Uint8Array>({
    pull() { return new Promise<void>(() => {}) },
    cancel() { cancelled = true },
  })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: hangingStream,
    duplex: 'half',
    headers: { 'Content-Type': 'application/json' },
  } as RequestInit)))
  expect(res.status).toBe(408)
  expect(cancelled).toBe(true)
  expect(calls).toEqual([])
  const health = await fetch(new Request('http://local/healthz', authed()))
  expect((await health.json()).capacity.ingress_body).toEqual({ reservedBytes: 0, maxBytes: 256 * 1024 * 1024 })
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
  expect(usage.rows[0]?.note).toMatch(/^queue_ms=\d+;attempts=2$/)
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
  expect(usage.rows[0]?.note).toMatch(/^queue_ms=\d+;attempts=1$/)
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

test('bounded model queue rejects overflow, exposes its wait state, and records the rejection', async () => {
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined
  let upstreamCalls = 0
  const usage = new MemoryUsageStore()
  const fetch = createGatewayFetch({
    env: env({
      GW_QWEN_CONC: '1',
      GW_QWEN_USER_CONC: '1',
      GW_QWEN_TOKEN_CONC: '1',
      GW_QWEN_QUEUE_MAX: '1',
      GW_QWEN_QUEUE_MAX_WAIT: '5',
    }),
    usageStore: usage,
    transcribeImpl: null,
    fetchImpl: async () => {
      upstreamCalls += 1
      if (upstreamCalls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { firstController = controller },
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
  const queued = fetch(request())
  await new Promise(resolve => setTimeout(resolve, 20))
  const health = await fetch(new Request('http://local/healthz', authed()))
  const body = await health.json()
  expect(body.capacity.qwen).toMatchObject({ active: 1, queued: 1, queueMax: 1 })
  expect(body.capacity.qwen.oldestQueueMs).toBeGreaterThanOrEqual(0)

  const overflow = await fetch(request())
  expect(overflow.status).toBe(429)
  expect(await overflow.json()).toEqual({ detail: '当前使用人数较多，排队已满，请稍后重试' })
  expect(usage.rows).toContainEqual(expect.objectContaining({
    model: 'qwen',
    ok: false,
    status: 429,
    note: expect.stringMatching(/^queue_ms=\d+;queue_rejected=1$/),
  }))

  firstController?.close()
  await first.text()
  const second = await queued
  await second.text()
  const drained = await fetch(new Request('http://local/healthz', authed()))
  expect((await drained.json()).capacity.qwen).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
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

test('legacy synchronous image endpoints are retired in favor of owned idempotent tasks', async () => {
  const { fetch, calls } = makeGateway()
  for (const path of ['/v1/images/generations', '/v1/images/edits']) {
    const res = await fetch(new Request(`http://local${path}`, authed({
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    })))
    expect(res.status).toBe(404)
  }
  expect(calls).toEqual([])
})

test('retired ark, amap, and standalone web-search routes stay gone', async () => {
  const { fetch, calls } = makeGateway()
  const arkChat = await fetch(new Request('http://local/v1/ark/chat/completions', authed({ method: 'POST', body: '{}' })))
  const amap = await fetch(new Request('http://local/v1/amap/v3/weather/weatherInfo?city=310000', authed()))
  const webSearch = await fetch(new Request('http://local/v1/web_search', authed({
    method: 'POST',
    body: JSON.stringify({ query: 'product search' }),
    headers: { 'Content-Type': 'application/json' },
  })))
  expect(arkChat.status).toBe(404)
  expect(amap.status).toBe(404)
  expect(webSearch.status).toBe(404)
  expect(calls).toEqual([])
})

test('admin usage requires admin token and returns recent rows', async () => {
  const { fetch } = makeGateway({ GW_RELAY_TASKS_BASE: 'https://relay.example/tasks' })
  await fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    body: JSON.stringify({ prompt: 'poster' }),
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
  // 真实短请求爬坡已观察到 800 路可直入；本合成用例锁定调度器不退化，不能替代长 SSE、
  // 长上下文、CPU 余量与真实用户混合负载的持续验收。
  // 仅保留 200 个、最多 15 秒的短等待槽来吸收抖动，尾延迟上升时不会隐藏成长队列。
  expect(body.limits.deepseek_conc).toBe(800)
  expect(body.limits.deepseek_user_conc).toBe(8)
  expect(body.limits.deepseek_token_conc).toBe(800)
  expect(body.limits.deepseek_queue_max).toBe(200)
  expect(body.limits.deepseek_queue_max_wait_seconds).toBe(15)
  expect(body.capacity.deepseek).toMatchObject({
    active: 0,
    queued: 0,
    maxConcurrent: 800,
    maxConcurrentPerUser: 8,
    maxConcurrentPerToken: 800,
    queueMax: 200,
    oldestQueueMs: 0,
  })
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

test('image task submit/poll/cancel proxy to relay tasks base with relay token when configured', async () => {
  const { fetch, calls } = makeGateway({ GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks', GW_Q_IMG: '5' })
  const submit = await fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'x', input_fidelity: 'high' }),
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect(submit.status).toBe(200)
  const poll = await fetch(new Request('http://local/v1/images/tasks/task-1', authed({ method: 'GET' })))
  expect(poll.status).toBe(200)
  const cancel = await fetch(new Request('http://local/v1/images/tasks/task-1/cancel', authed({ method: 'POST' })))
  expect(cancel.status).toBe(200)
  expect(calls.map(c => c.url)).toEqual([
    'https://relay.example/relay/imgtasks/images/tasks',
    'https://relay.example/relay/imgtasks/images/tasks/task-1',
    'https://relay.example/relay/imgtasks/images/tasks/task-1/cancel',
  ])
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer relay-secret')
  expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ input_fidelity: 'high' })
})

test('image task submit enforces its body limit before forwarding declared or streamed bytes', async () => {
  const configured = { GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks', GW_IMG_TASK_MAX_BODY_BYTES: '64' }

  const declared = makeGateway(configured)
  const declaredRes = await declared.fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': '65' },
    body: JSON.stringify({ prompt: 'x' }),
  })))
  expect(declaredRes.status).toBe(413)
  expect(declared.calls).toEqual([])

  const streamed = makeGateway(configured)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"prompt":"'))
      controller.enqueue(new TextEncoder().encode('x'.repeat(80)))
      controller.enqueue(new TextEncoder().encode('"}'))
      controller.close()
    },
  })
  const streamedRes = await streamed.fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })))
  expect(streamedRes.status).toBe(413)
  expect(streamed.calls).toEqual([])
})

test('image gateway admits a 100-user × 5-submit burst to relay while the body budget stays bounded', async () => {
  let relayActive = 0
  let relayPeak = 0
  let openGate!: () => void
  const gate = new Promise<void>(resolve => { openGate = resolve })
  const usage = new MemoryUsageStore()
  const fetch = createGatewayFetch({
    env: env({ GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks' }),
    usageStore: usage,
    transcribeImpl: null,
    fetchImpl: async input => {
      if (!String(input).endsWith('/images/tasks')) return Response.json({ ok: true })
      relayActive += 1
      relayPeak = Math.max(relayPeak, relayActive)
      await gate
      relayActive -= 1
      return Response.json({ task_id: 'relay-task', state: 'queued' }, { status: 202 })
    },
  })
  const submit = (n: number) => fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `burst-${n}` },
    body: JSON.stringify({ mode: 'generate', prompt: `球房海报 ${n}` }),
  }))).then(async response => { await response.text(); return response.status })

  const pending = Array.from({ length: 500 }, (_, n) => submit(n))
  const deadline = performance.now() + 3000
  while (relayActive !== 500 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(relayActive).toBe(500)
  const health = await fetch(new Request('http://local/healthz', authed()))
  const body = await health.json()
  expect(body.limits).toMatchObject({
    img_ipm: 600,
    img_task_max_body_bytes: 32 * 1024 * 1024,
    ingress_inflight_body_bytes: 256 * 1024 * 1024,
  })
  expect(body.capacity.ingress_body.reservedBytes).toBeGreaterThan(0)
  expect(body.capacity.ingress_body.reservedBytes).toBeLessThanOrEqual(256 * 1024 * 1024)

  openGate()
  const statuses = await Promise.all(pending)
  expect(statuses.filter(status => status === 202)).toHaveLength(500)
  expect(relayPeak).toBe(500)
  expect(usage.rows.filter(row => row.model === 'img' && row.ok)).toHaveLength(500)
  const drained = await fetch(new Request('http://local/healthz', authed()))
  expect((await drained.json()).capacity.ingress_body).toEqual({ reservedBytes: 0, maxBytes: 256 * 1024 * 1024 })
})

test('image gateway bounds exhausted-IPM waiters and releases a cancelled waiter immediately', async () => {
  let relayCalls = 0
  let releaseRelay!: () => void
  const fetch = createGatewayFetch({
    env: env({
      GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks',
      GW_IMG_IPM: '1',
      GW_IMG_QUEUE_MAX: '1',
      GW_QUEUE_MAX_WAIT: '60',
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: async (_input, init) => {
      relayCalls += 1
      const signal = init?.signal
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('relay request aborted'), { name: 'AbortError' }))
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        releaseRelay = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
      })
      return Response.json({ task_id: 'relay-task', state: 'queued' }, { status: 202 })
    },
  })
  const submit = (key: string, signal?: AbortSignal) => fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ mode: 'generate', prompt: key }),
  })))

  const first = submit('first')
  const deadline = performance.now() + 1000
  while (relayCalls !== 1 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(relayCalls).toBe(1)
  const secondController = new AbortController()
  const second = submit('second', secondController.signal)
  await new Promise(resolve => setTimeout(resolve, 5))
  const third = await submit('third')
  expect(third.status).toBe(429)
  expect(relayCalls).toBe(1)

  secondController.abort()
  expect((await second).status).toBe(499)
  releaseRelay()
  expect((await first).status).toBe(202)
  const health = await fetch(new Request('http://local/healthz', authed()))
  expect((await health.json()).capacity.ingress_body).toEqual({ reservedBytes: 0, maxBytes: 256 * 1024 * 1024 })
})

test('image gateway aborts a stalled relay submission at its bounded deadline and releases ingress memory', async () => {
  let relayAborted = false
  const usage = new MemoryUsageStore()
  const fetch = createGatewayFetch({
    env: env({
      GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks',
      GW_RELAY_SUBMIT_TIMEOUT_MS: '20',
    }),
    usageStore: usage,
    transcribeImpl: null,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const onAbort = () => {
        relayAborted = true
        reject(Object.assign(new Error('relay request aborted'), { name: 'AbortError' }))
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
    }),
  })
  const response = await fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'generate', prompt: 'stalled relay' }),
  })))
  expect(response.status).toBe(504)
  expect(relayAborted).toBe(true)
  expect(usage.rows).toMatchObject([{ model: 'img', ok: false, status: 504, note: 'relay_submit_timeout' }])
  const health = await fetch(new Request('http://local/healthz', authed()))
  expect((await health.json()).capacity.ingress_body).toEqual({ reservedBytes: 0, maxBytes: 256 * 1024 * 1024 })
})

test('image gateway rejects a body-budget overflow before it can reach relay and releases after forward', async () => {
  let relayCalls = 0
  let openGate!: () => void
  const gate = new Promise<void>(resolve => { openGate = resolve })
  const fetch = createGatewayFetch({
    env: env({
      GW_RELAY_TASKS_BASE: 'https://relay.example/relay/imgtasks',
      GW_IMG_TASK_MAX_BODY_BYTES: '64',
      GW_INGRESS_INFLIGHT_BODY_BYTES: '300',
    }),
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: async () => {
      relayCalls += 1
      await gate
      return Response.json({ task_id: 'relay-task', state: 'queued' }, { status: 202 })
    },
  })
  const payload = JSON.stringify({ prompt: 'x'.repeat(20) })
  const submit = () => fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
  })))

  const accepted = submit()
  const deadline = performance.now() + 1000
  while (relayCalls !== 1 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(relayCalls).toBe(1)
  const rejected = await submit()
  expect(rejected.status).toBe(429)
  expect(await rejected.json()).toEqual({ detail: '请求较多，请稍后重试' })
  expect(relayCalls).toBe(1)

  openGate()
  expect((await accepted).status).toBe(202)
  const health = await fetch(new Request('http://local/healthz', authed()))
  expect((await health.json()).capacity.ingress_body).toEqual({ reservedBytes: 0, maxBytes: 300 })
})

test('image task endpoints return 503 when GW_RELAY_TASKS_BASE unset', async () => {
  const { fetch, calls } = makeGateway()
  const submit = await fetch(new Request('http://local/v1/images/tasks', authed({ method: 'POST', body: '{}' })))
  expect(submit.status).toBe(503)
  const poll = await fetch(new Request('http://local/v1/images/tasks/x', authed({ method: 'GET' })))
  expect(poll.status).toBe(503)
  const cancel = await fetch(new Request('http://local/v1/images/tasks/x/cancel', authed({ method: 'POST' })))
  expect(cancel.status).toBe(503)
  expect(calls.length).toBe(0)
})

test('image task endpoints fail closed when GW_RELAY_TASKS_BASE is clear-text HTTP', async () => {
  const { fetch, calls } = makeGateway({ GW_RELAY_TASKS_BASE: 'http://relay.example/relay/imgtasks' })
  const res = await fetch(new Request('http://local/v1/images/tasks', authed({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '台球馆海报' }),
  })))
  expect(res.status).toBe(503)
  expect(calls).toHaveLength(0)
})
