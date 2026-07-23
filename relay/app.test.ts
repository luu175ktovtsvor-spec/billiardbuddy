import { expect, test } from 'bun:test'
import { createRelayFetch, withRelayRequestTimeout } from './app'

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    RELAY_TOKEN: 'relay-secret',
    RELAY_OPENAI_KEY: 'sk-real',
    RELAY_OPENAI_BASE: 'https://api.openai.example/v1',
    ...overrides,
  }
}

const B64 = Buffer.from('png-bytes').toString('base64')

test('healthz publishes the relay compatibility manifest', async () => {
  const fetch = createRelayFetch({ env: env() })
  expect(await (await fetch(new Request('http://relay/healthz'))).json()).toMatchObject({
    ok: true,
    component_manifest: {
      component: 'qf-relay',
      protocol: 'bb-provider-gateway/1.0',
      requires_gateway_protocol_for_owned_tasks: true,
    },
  })
})

async function pollUntilDone(fetch: (r: Request) => Promise<Response>, id: string): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(new Request(`http://relay/images/tasks/${id}`, { headers: { authorization: 'Bearer relay-secret' } }))
    const body = await res.json()
    if (body.status === 'succeeded' || body.status === 'failed' || body.status === 'failed_unknown') return body
    await new Promise(r => setTimeout(r, 2))
  }
  throw new Error('poll timed out')
}

test('submit generate → background OpenAI call → poll succeeds with data', async () => {
  const calls: string[] = []
  const fetch = createRelayFetch({
    env: env(),
    fetchImpl: async (input, init) => {
      calls.push(String(input))
      // 断言真 key 注入、不跨境(base 是美国 openai)
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-real')
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })
  const submit = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: '海报', n: 1, size: '1024x1024' }),
  }))
  expect(submit.status).toBe(202)
  const { task_id } = await submit.json()
  expect(task_id).toBeTruthy()
  const done = await pollUntilDone(fetch, task_id)
  expect(done.status).toBe('succeeded')
  expect(done.data[0].b64_json).toBe(B64)
  const metadata = await (await fetch(new Request(`http://relay/images/tasks/${task_id}?metadata_only=1`, {
    headers: { authorization: 'Bearer relay-secret' },
  }))).json()
  expect(metadata).toMatchObject({
    status: 'succeeded',
    operation_id: task_id,
    provider: 'OpenAI',
    provider_receipt_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    metadata_only: true,
    result_available: true,
    output_count: 1,
  })
  expect(metadata.data).toBeUndefined()
  expect(calls).toEqual(['https://api.openai.example/v1/images/generations'])
})

test('relay HTTP surface disables Bun idle timeout while sending completed image bytes', async () => {
  const timeoutCalls: number[] = []
  const handler = withRelayRequestTimeout(async () => Response.json({ ok: true }))
  const response = await handler(new Request('http://relay/healthz'), {
    timeout: (_request, seconds) => { timeoutCalls.push(seconds) },
  })
  expect(response.status).toBe(200)
  expect(timeoutCalls).toEqual([0])
})

test('Seedream generate uses the native JSON contract and persists each returned image', async () => {
  const generationBodies: Array<Record<string, unknown>> = []
  let generated = 0
  const fetch = createRelayFetch({
    env: env({
      RELAY_ARK_KEY: 'ark-real',
      RELAY_ARK_BASE: 'https://ark.example/api/v3',
    }),
    fetchImpl: async (input, init) => {
      const url = String(input)
      expect(url).toBe('https://ark.example/api/v3/images/generations')
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ark-real')
      generationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      generated += 1
      return Response.json({
        data: [{ b64_json: Buffer.from(`seedream-${generated}`).toString('base64') }],
      })
    },
  })
  const submit = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'generate',
      model: 'doubao-seedream-4-5-251128',
      prompt: '中文活动海报',
      n: 2,
      size: '1536x2736',
    }),
  }))
  expect(submit.status).toBe(202)
  const { task_id } = await submit.json()
  const done = await pollUntilDone(fetch, task_id)
  expect(done.status).toBe('succeeded')
  expect(done.data).toHaveLength(2)
  expect(done.data[0]).toMatchObject({
    b64_json: Buffer.from('seedream-1').toString('base64'),
    mime_type: 'image/png',
  })
  expect(generationBodies).toEqual([
    {
      model: 'doubao-seedream-4-5-251128',
      prompt: '中文活动海报',
      size: '1536x2736',
      watermark: false,
      response_format: 'b64_json',
    },
    {
      model: 'doubao-seedream-4-5-251128',
      prompt: '中文活动海报',
      size: '1536x2736',
      watermark: false,
      response_format: 'b64_json',
    },
  ])
})

test('Seedream edit sends reference images in JSON instead of OpenAI multipart', async () => {
  let generationBody: Record<string, unknown> | null = null
  const fetch = createRelayFetch({
    env: env({ RELAY_ARK_KEY: 'ark-real', RELAY_ARK_BASE: 'https://ark.example/api/v3' }),
    fetchImpl: async (_input, init) => {
      generationBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })
  const image = `data:image/png;base64,${B64}`
  const submit = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'edit',
      model: 'doubao-seedream-4-5-251128',
      prompt: '把标题改成周五台球夜',
      size: '2048x2048',
      images: [image],
    }),
  }))
  const { task_id } = await submit.json()
  expect((await pollUntilDone(fetch, task_id)).status).toBe('succeeded')
  expect(generationBody).toMatchObject({
    image,
    sequential_image_generation: 'disabled',
    watermark: false,
  })
})

test('Seedream submission fails closed before queueing when its server credential is absent', async () => {
  const fetch = createRelayFetch({ env: env(), fetchImpl: async () => Response.json({}) })
  const response = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'generate',
      model: 'doubao-seedream-4-5-251128',
      prompt: '海报',
      size: '2048x2048',
    }),
  }))
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('豆包生图未配置') })
})

test('submit edit uses the GPT Image 2 multipart contract with attached images', async () => {
  let editUrl = ''
  let form: FormData | null = null
  const fetch = createRelayFetch({
    env: env(),
    fetchImpl: async (input, init) => {
      editUrl = String(input)
      form = init?.body as FormData
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })
  const submit = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'edit',
      model: 'gpt-image-2',
      prompt: '改成深绿',
      n: 1,
      response_format: 'b64_json',
      images: [`data:image/png;base64,${B64}`],
    }),
  }))
  const { task_id } = await submit.json()
  const done = await pollUntilDone(fetch, task_id)
  expect(done.status).toBe('succeeded')
  expect(editUrl).toBe('https://api.openai.example/v1/images/edits')
  expect(form).toBeInstanceOf(FormData)
  expect((form as unknown as FormData).getAll('image')).toHaveLength(1)
  expect((form as unknown as FormData).get('response_format')).toBeNull()
})

test('GPT Image 2 omits legacy response_format and input_fidelity parameters', async () => {
  let form: FormData | null = null
  let upstreamCalls = 0
  const fetch = createRelayFetch({
    env: env(),
    fetchImpl: async (_input, init) => {
      upstreamCalls += 1
      form = init?.body as FormData
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })
  const submit = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'edit', model: 'gpt-image-2', prompt: 'portrait', images: [`data:image/png;base64,${B64}`], input_fidelity: 'high' }),
  }))
  const { task_id } = await submit.json()
  const done = await pollUntilDone(fetch, task_id)
  expect(upstreamCalls).toBe(1)
  expect((form as unknown as FormData).get('input_fidelity')).toBeNull()
  expect((form as unknown as FormData).get('response_format')).toBeNull()
  expect(done.status).toBe('succeeded')
  expect(done.input_fidelity_requested).toBeUndefined()
  expect(done.input_fidelity_status).toBeUndefined()
  expect(done.input_fidelity_risk).toBeUndefined()
})

test('OpenAI failure is captured as failed task, not thrown', async () => {
  const fetch = createRelayFetch({
    env: env(),
    fetchImpl: async () => new Response('rate limited', { status: 429 }),
  })
  const submit = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'generate', prompt: '海报' }),
  }))
  const { task_id } = await submit.json()
  const done = await pollUntilDone(fetch, task_id)
  expect(done.status).toBe('failed')
  expect(done.error).toContain('429')
})

test('connection loss, timeout and malformed success stay failed_unknown to prevent blind paid retries', async () => {
  const cases: Array<{ env?: Record<string, string>; fetchImpl: () => Promise<Response> }> = [
    { fetchImpl: async () => { throw new Error('socket reset') } },
    { env: { RELAY_UPSTREAM_TIMEOUT_MS: '10' }, fetchImpl: () => new Promise(() => {}) },
    {
      env: { RELAY_UPSTREAM_TIMEOUT_MS: '10' },
      fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    },
    { fetchImpl: async () => new Response('{broken', { status: 200 }) },
  ]

  for (const scenario of cases) {
    const fetch = createRelayFetch({
      env: env(scenario.env),
      fetchImpl: scenario.fetchImpl,
    })
    const submit = await fetch(new Request('http://relay/images/tasks', {
      method: 'POST',
      headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'generate', prompt: '海报' }),
    }))
    const { task_id } = await submit.json()
    const done = await pollUntilDone(fetch, task_id)
    expect(done.status).toBe('failed_unknown')
    expect(done.error).toMatch(/无法确认|响应内容损坏/)
    expect((await (await fetch(new Request('http://relay/healthz'))).json()).active).toBe(0)
  }
})

test('rejects missing/invalid relay token before any work', async () => {
  const fetch = createRelayFetch({ env: env(), fetchImpl: async () => Response.json({}) })
  const noToken = await fetch(new Request('http://relay/images/tasks', { method: 'POST', body: '{}' }))
  expect(noToken.status).toBe(401)
  const badToken = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}',
  }))
  expect(badToken.status).toBe(401)
})

test('unknown/expired task id returns 404', async () => {
  const fetch = createRelayFetch({ env: env(), fetchImpl: async () => Response.json({}) })
  const res = await fetch(new Request('http://relay/images/tasks/nope', { headers: { authorization: 'Bearer relay-secret' } }))
  expect(res.status).toBe(404)
})

test('expired tasks are swept by TTL', async () => {
  let clock = 1_000_000
  const fetch = createRelayFetch({
    env: env({ RELAY_TASK_TTL_MS: '1000' }),
    now: () => clock,
    fetchImpl: async () => Response.json({ data: [{ b64_json: B64 }] }),
  })
  const submit = await fetch(new Request('http://relay/images/tasks', {
    method: 'POST', headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'generate', prompt: '海报' }),
  }))
  const { task_id } = await submit.json()
  await new Promise(r => setTimeout(r, 5)) // 让后台完成
  clock += 2000 // 超过 TTL
  const res = await fetch(new Request(`http://relay/images/tasks/${task_id}`, { headers: { authorization: 'Bearer relay-secret' } }))
  expect(res.status).toBe(404)
})
