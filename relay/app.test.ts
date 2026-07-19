import { expect, test } from 'bun:test'
import { createRelayFetch } from './app'

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    RELAY_TOKEN: 'relay-secret',
    RELAY_OPENAI_KEY: 'sk-real',
    RELAY_OPENAI_BASE: 'https://api.openai.example/v1',
    ...overrides,
  }
}

const B64 = Buffer.from('png-bytes').toString('base64')

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
    metadata_only: true,
    result_available: true,
    output_count: 1,
  })
  expect(metadata.data).toBeUndefined()
  expect(calls).toEqual(['https://api.openai.example/v1/images/generations'])
})

test('submit edit sends multipart b64_json output contract to /images/edits with attached image', async () => {
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
  expect((form as unknown as FormData).get('response_format')).toBe('b64_json')
})

test('submit edit forwards input_fidelity when the deployed endpoint accepts it', async () => {
  let form: FormData | null = null
  const fetch = createRelayFetch({
    env: env(),
    fetchImpl: async (_input, init) => {
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
  expect((form as unknown as FormData).get('input_fidelity')).toBe('high')
  expect(done).toMatchObject({
    input_fidelity_requested: 'high',
    input_fidelity_status: 'accepted',
  })
  expect(done.input_fidelity_risk).toBeUndefined()
})

test('submit edit retries without input_fidelity only after an explicit endpoint rejection', async () => {
  const fidelities: Array<FormDataEntryValue | null> = []
  const fetch = createRelayFetch({
    env: env(),
    fetchImpl: async (_input, init) => {
      const form = init?.body as FormData
      fidelities.push(form.get('input_fidelity'))
      if (fidelities.length === 1) return Response.json({ error: { message: 'unknown parameter input_fidelity' } }, { status: 400 })
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
  expect(fidelities).toEqual(['high', null])
  expect(done).toMatchObject({ input_fidelity_requested: 'high', input_fidelity_status: 'unsupported' })
  expect(done.input_fidelity_risk).toContain('自动降级')
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
