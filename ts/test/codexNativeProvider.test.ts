import { afterEach, describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import {
  ChatCompletionsResponsesAdapter,
  startCodexNativeProvider,
} from '../desktop/electron/services/codexNativeProvider'
import type { PersonalModelProfile } from '../shared/product/personalModels'

const adapters: ChatCompletionsResponsesAdapter[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()))
  await Promise.all(servers.splice(0).map(async server => {
    server.close()
    await once(server, 'close').catch(() => undefined)
  }))
})

describe('Chat Completions to Responses adapter', () => {
  test('preserves reasoning and tool continuation while returning Responses SSE', async () => {
    let upstreamRequest: Record<string, unknown> | undefined
    let authorization: string | undefined
    const upstream = createServer(async (request, response) => {
      authorization = request.headers.authorization
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      upstreamRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"reasoning_content":"next reasoning"},"finish_reason":null}]}\n\n')
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_next","function":{"name":"read_file","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n')
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n')
      response.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n')
      response.end('data: [DONE]\n\n')
    })
    servers.push(upstream)
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('test upstream address is invalid')

    const profile: PersonalModelProfile = {
      id: 'testprofile1',
      label: 'Test Chat provider',
      base_url: `http://127.0.0.1:${address.port}/v1`,
      model: 'test-reasoning-model',
      protocol: 'openai-compatible',
      auth_mode: 'bearer',
      api_key: 'test-api-key',
    }
    const adapter = new ChatCompletionsResponsesAdapter(profile)
    adapters.push(adapter)
    const started = await adapter.start()
    const response = await fetch(`${started.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-billiardbuddy-engine-token': started.capabilityToken,
      },
      body: JSON.stringify({
        model: profile.model,
        stream: true,
        instructions: 'Keep the native Agent policy.',
        input: [
          { type: 'message', role: 'user', content: [
            { type: 'input_text', text: 'Inspect the file.' },
            { type: 'input_audio', audio_url: 'data:audio/wav;base64,YXVkaW8=' },
          ] },
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'previous reasoning' }] },
          { type: 'function_call', call_id: 'call_previous', name: 'read_file', arguments: '{"path":"README.md"}' },
          { type: 'function_call_output', call_id: 'call_previous', output: [
            { type: 'input_text', text: 'previous result' },
            { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=', detail: 'low' },
          ] },
          // Locked Core local compaction reinserts its summary as an ordinary
          // user message for every BilliardBuddy custom provider.
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Compacted history summary.' }] },
        ],
        tools: [{ type: 'function', name: 'read_file', description: 'Read one file', parameters: { type: 'object' } }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
      }),
    })

    expect(response.status).toBe(200)
    const events = await response.text()
    expect(events).toContain('event: response.created')
    expect(events).toContain('event: response.output_item.done')
    expect(events).toContain('"type":"reasoning"')
    expect(events).toContain('"type":"function_call"')
    expect(events).toContain('"call_id":"call_next"')
    expect(events).toContain('"arguments":"{\\"path\\":\\"README.md\\"}"')
    expect(events).toContain('event: response.completed')
    expect(events).toContain('"input_tokens":12')
    expect(events).toContain('"output_tokens":7')

    expect(authorization).toBe('Bearer test-api-key')
    expect(upstreamRequest?.model).toBe(profile.model)
    expect(upstreamRequest?.tool_choice).toBe('auto')
    expect(upstreamRequest?.parallel_tool_calls).toBe(true)
    const messages = upstreamRequest?.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'Keep the native Agent policy.' })
    expect(messages[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'Inspect the file.' },
      { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
    ] })
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'previous reasoning',
      tool_calls: [{
        id: 'call_previous',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_previous', content: 'previous result' })
    expect(messages[4]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'Media returned by the preceding tool call.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=', detail: 'low' } },
    ] })
    expect(messages[5]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Compacted history summary.' }] })
  })

  test('rejects requests without the private loopback capability', async () => {
    const profile: PersonalModelProfile = {
      id: 'testprofile2',
      label: 'Test Chat provider',
      base_url: 'http://127.0.0.1:9/v1',
      model: 'test-model',
      protocol: 'openai-compatible',
      auth_mode: 'bearer',
      api_key: 'test-api-key',
    }
    const adapter = new ChatCompletionsResponsesAdapter(profile)
    adapters.push(adapter)
    const started = await adapter.start()
    const response = await fetch(`${started.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'hello' }),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'CODEX_CHAT_ADAPTER_UNAUTHORIZED', message: 'CODEX_CHAT_ADAPTER_UNAUTHORIZED' },
    })
  })

  test('disables only the hosted Responses web-search tool for a legacy Chat provider', async () => {
    const profile: PersonalModelProfile = {
      id: 'testprofile3',
      label: 'Legacy Chat provider',
      base_url: 'https://api.example.test/v1',
      model: 'test-model',
      protocol: 'openai-compatible',
      auth_mode: 'bearer',
      api_key: 'test-api-key',
    }
    const started = await startCodexNativeProvider({ kind: 'personal', profile })
    try {
      expect(started.configOverrides).toContain('web_search="disabled"')
      expect(started.configOverrides).toContain('model_providers.billiardbuddy.wire_api="responses"')
    } finally {
      await started.close()
    }
  })

  test('a personal Responses profile calls only its selected upstream, not the hosted Gateway route', async () => {
    let personalRequests = 0
    let authorization: string | undefined
    const upstream = createServer(async (request, response) => {
      personalRequests += 1
      authorization = request.headers.authorization
      expect(request.url).toBe('/v1/responses')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ model: 'personal-test', input: 'hello' })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n')
    })
    servers.push(upstream)
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('test personal upstream address is invalid')

    const profile: PersonalModelProfile = {
      id: 'personalresponses1',
      label: 'Personal Responses provider',
      base_url: `http://127.0.0.1:${address.port}/v1`,
      model: 'personal-test',
      protocol: 'openai-responses',
      auth_mode: 'bearer',
      api_key: 'personal-key-only',
    }
    const started = await startCodexNativeProvider({ kind: 'personal', profile })
    try {
      const baseUrlOverride = started.configOverrides.find(value => value.startsWith('model_providers.billiardbuddy.base_url='))
      if (!baseUrlOverride) throw new Error('missing personal loopback configuration')
      const loopbackBaseUrl = JSON.parse(baseUrlOverride.slice('model_providers.billiardbuddy.base_url='.length)) as string
      const capabilityToken = started.environment.BB_CODEX_PERSONAL_RESPONSES_ADAPTER_TOKEN
      if (!capabilityToken) throw new Error('missing personal loopback capability')
      const response = await fetch(`${loopbackBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-billiardbuddy-engine-token': capabilityToken },
        body: JSON.stringify({ model: 'personal-test', input: 'hello' }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('response.completed')
      expect(personalRequests).toBe(1)
      expect(authorization).toBe('Bearer personal-key-only')
    } finally {
      await started.close()
    }
  })

  test('a direct Responses upstream error cannot echo a personal API key into Rust', async () => {
    const secret = 'personal-key-must-not-cross-loopback'
    const profile: PersonalModelProfile = {
      id: 'personalresponses2',
      label: 'Personal Responses provider',
      base_url: 'https://provider.example.test/v1',
      model: 'personal-test',
      protocol: 'openai-responses',
      auth_mode: 'bearer',
      api_key: secret,
    }
    const started = await startCodexNativeProvider({ kind: 'personal', profile }, {
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${secret}`)
        return new Response(JSON.stringify({ error: { message: `upstream reflected ${secret}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    try {
      const baseUrlOverride = started.configOverrides.find(value => value.startsWith('model_providers.billiardbuddy.base_url='))
      if (!baseUrlOverride) throw new Error('missing personal loopback configuration')
      const loopbackBaseUrl = JSON.parse(baseUrlOverride.slice('model_providers.billiardbuddy.base_url='.length)) as string
      const capabilityToken = started.environment.BB_CODEX_PERSONAL_RESPONSES_ADAPTER_TOKEN
      if (!capabilityToken) throw new Error('missing personal loopback capability')
      const response = await fetch(`${loopbackBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-billiardbuddy-engine-token': capabilityToken },
        body: JSON.stringify({ model: profile.model, input: 'hello' }),
      })
      expect(response.status).toBe(401)
      const body = await response.text()
      expect(body).toContain('CODEX_PERSONAL_RESPONSES_ADAPTER_UPSTREAM_HTTP_401')
      expect(body).not.toContain(secret)
    } finally {
      await started.close()
    }
  })

  test('the built-in DeepSeek route preserves Responses through the private bridge and Gateway', async () => {
    const gatewayRequests: Array<{ url: string; body: string; headers: Headers }> = []
    const started = await startCodexNativeProvider({
      kind: 'managed',
      gatewayUrl: 'https://gateway.example.test/gw',
      model: 'deepseek-v4-flash',
      capabilities: ['TextReasoning'],
      resolveAccessToken: async () => 'managed-access-token',
    }, {
      fetchImpl: async (input, init) => {
        gatewayRequests.push({
          url: input.toString(),
          body: String(init?.body ?? ''),
          headers: new Headers(init?.headers),
        })
        return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        })
      },
    })
    try {
      expect(started.model).toBe('deepseek-v4-flash')
      expect(started.configOverrides).toContain('model_providers.billiardbuddy.wire_api="responses"')
      const baseUrlOverride = started.configOverrides.find(value => value.startsWith('model_providers.billiardbuddy.base_url='))
      if (!baseUrlOverride) throw new Error('missing managed loopback configuration')
      const loopbackBaseUrl = JSON.parse(baseUrlOverride.slice('model_providers.billiardbuddy.base_url='.length)) as string
      const capabilityToken = started.environment.BB_CODEX_GATEWAY_ADAPTER_TOKEN
      if (!capabilityToken) throw new Error('missing managed loopback capability')
      const body = JSON.stringify({
        model: 'deepseek-v4-flash',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep Responses native' }] }],
        stream: true,
      })
      const response = await fetch(`${loopbackBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-billiardbuddy-engine-token': capabilityToken,
          'x-bb-operation-id': 'managed_responses_test_0001',
          'idempotency-key': 'managed-responses-idempotency-0001',
        },
        body,
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('response.completed')
      expect(gatewayRequests).toHaveLength(1)
      expect(gatewayRequests[0]).toMatchObject({
        url: 'https://gateway.example.test/gw/v1/responses',
        body,
      })
      expect(gatewayRequests[0]?.headers.get('authorization')).toBe('Bearer managed-access-token')
      expect(gatewayRequests[0]?.headers.get('x-bb-provider-protocol')).toBe('bb-provider-gateway/1.0')
      expect(gatewayRequests[0]?.headers.get('x-bb-operation-id')).toBe('managed_responses_test_0001')
      expect(gatewayRequests[0]?.headers.get('idempotency-key')).toBe('managed-responses-idempotency-0001')
    } finally {
      await started.close()
    }
  })

  test('the managed text-only route rejects image input before it can reach DeepSeek', async () => {
    let gatewayRequests = 0
    const started = await startCodexNativeProvider({
      kind: 'managed',
      gatewayUrl: 'https://gateway.example.test/gw',
      model: 'deepseek-v4-flash',
      capabilities: ['TextReasoning'],
      resolveAccessToken: async () => 'managed-access-token',
    }, {
      fetchImpl: async () => {
        gatewayRequests += 1
        return new Response('unexpected upstream request')
      },
    })
    try {
      const baseUrlOverride = started.configOverrides.find(value => value.startsWith('model_providers.billiardbuddy.base_url='))
      if (!baseUrlOverride) throw new Error('missing managed loopback configuration')
      const loopbackBaseUrl = JSON.parse(baseUrlOverride.slice('model_providers.billiardbuddy.base_url='.length)) as string
      const capabilityToken = started.environment.BB_CODEX_GATEWAY_ADAPTER_TOKEN
      if (!capabilityToken) throw new Error('missing managed loopback capability')
      const response = await fetch(`${loopbackBaseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-billiardbuddy-engine-token': capabilityToken,
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }],
        }),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          code: 'CODEX_GATEWAY_ADAPTER_IMAGE_INPUT_UNSUPPORTED',
          message: 'CODEX_GATEWAY_ADAPTER_IMAGE_INPUT_UNSUPPORTED',
        },
      })
      expect(gatewayRequests).toBe(0)
    } finally {
      await started.close()
    }
  })
})
