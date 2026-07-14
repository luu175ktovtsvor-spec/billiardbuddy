import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'
import type { GatewayTranscriber } from './transcription'

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GW_MIMO_KEY: 'mimo-secret',
    GW_MIMO_BASE: 'https://mimo.example/v1',
    GW_RELAY_BASE: 'https://relay.example/relay/openai/v1',
    GW_RELAY_TOKEN: 'relay-secret',
    GW_ARK_KEY: 'ark-secret',
    GW_ARK_BASE: 'https://ark.example/api/v3',
    GW_AMAP_KEY: 'amap-secret',
    GW_AMAP_BASE: 'https://amap.example',
    GW_APP_TOKENS: JSON.stringify({ 'app-token': 'owner-a' }),
    GW_ADMIN_TOKEN: 'admin-secret',
    GW_Q_CHAT: '2',
    GW_Q_IMG: '1',
    GW_Q_ARK_CHAT: '1',
    GW_Q_ARK_IMG: '1',
    GW_Q_AMAP: '1',
    GW_QUEUE_MAX_WAIT: '0.01',
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
      return Response.json({ ok: true, url })
    },
  })
  return { fetch, calls, usage }
}

test('healthz exposes limits and quotas', async () => {
  const { fetch } = makeGateway()
  const res = await fetch(new Request('http://local/healthz'))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.limits.mimo_rpm).toBe(90)
  expect(body.quota.img).toBe(1)
  expect(body.features.transcription).toBe(false)
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

test('chat completions stream is proxied with MiMo key and logged after consumption', async () => {
  const { fetch, calls, usage } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({
    method: 'POST',
    body: JSON.stringify({ model: 'mimo-v2.5', stream: true }),
    headers: { Authorization: 'Bearer app-token', 'Content-Type': 'application/json' },
  })))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('data: hello\n\n')
  expect(calls[0]?.url).toBe('https://mimo.example/v1/chat/completions')
  expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer mimo-secret')
  expect(usage.rows).toMatchObject([{ user: 'owner-a', model: 'mimo', ok: true, status: 200 }])
})

test('image generation proxies to relay and daily quota blocks second success', async () => {
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
  expect(second.status).toBe(429)
  expect(calls.map(c => c.url)).toEqual(['https://relay.example/relay/openai/v1/images/generations'])
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

test('ark chat and seedream image routes use ark key and log separate quotas', async () => {
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
