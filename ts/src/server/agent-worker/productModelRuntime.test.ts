import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PROVIDER_GATEWAY_PROTOCOL, PROVIDER_GATEWAY_PROTOCOL_HEADER } from '../../../shared/product/providerGateway.js'
import type { ProductHarnessMessage } from '../../../shared/product/harnessMessages.js'
import { buildProductSystemPrompt } from './productSystemPrompt.js'
import { runProductModel } from './productModelRuntime.js'

const originalFetch = globalThis.fetch
const originalEnvironment = {
  BB_GATEWAY_URL: process.env.BB_GATEWAY_URL,
  BB_GATEWAY_TOKEN: process.env.BB_GATEWAY_TOKEN,
  BB_INSTALLATION_ID: process.env.BB_INSTALLATION_ID,
}

beforeEach(() => {
  process.env.BB_GATEWAY_URL = 'https://gateway.example.test/gw'
  process.env.BB_GATEWAY_TOKEN = 'test-gateway-token'
  process.env.BB_INSTALLATION_ID = 'installation-test'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function stream(frames: unknown[]): Response {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function crlfStream(frames: unknown[]): Response {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const options = { model: 'deepseek-v4-flash' }

describe('BilliardBuddy product model runtime', () => {
  test('sends the product prompt and provider-neutral history directly as OpenAI Chat', async () => {
    let captured: { url: string; init: RequestInit; body: Record<string, unknown> } | undefined
    globalThis.fetch = (async (url, init) => {
      captured = { url: String(url), init: init!, body: JSON.parse(String(init?.body)) }
      return stream([
        { model: 'deepseek-v4-flash', choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } },
      ])
    }) as typeof fetch
    const messages: ProductHarnessMessage[] = [{
      type: 'user', uuid: 'user-1', timestamp: '2026-07-26T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '分析图片' }, { type: 'image', media_type: 'image/png', data: 'AQID' }] },
    }]
    const events = []
    for await (const event of runProductModel({
      messages,
      systemPrompt: buildProductSystemPrompt({ workspace: '/workspace/example', date: '2026-07-26' }),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options,
    })) events.push(event)

    expect(captured?.url).toBe('https://gateway.example.test/gw/v1/chat/completions')
    expect(new Headers(captured?.init.headers).get('Authorization')).toBe('Bearer test-gateway-token')
    expect(new Headers(captured?.init.headers).get(PROVIDER_GATEWAY_PROTOCOL_HEADER)).toBe(PROVIDER_GATEWAY_PROTOCOL.headerValue)
    expect(new Headers(captured?.init.headers).get('X-BB-Installation-ID')).toBeNull()
    const requestMessages = captured?.body.messages as Array<Record<string, unknown>>
    expect(requestMessages[0]).toMatchObject({ role: 'system' })
    expect(String(requestMessages[0]?.content)).toContain('BilliardBuddy')
    expect(String(requestMessages[0]?.content)).not.toContain('Claude Code')
    expect(requestMessages[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: '分析图片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ] })
    expect(events).toEqual([
      { type: 'model_delta', text: '完成' },
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [{ type: 'text', text: '完成' }], usage: { input_tokens: 12, output_tokens: 2 } }) }),
    ])
  })

  test('reassembles streamed function calls into one BilliardBuddy tool call', async () => {
    let capturedBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body))
      return crlfStream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { arguments: 'path":"notes.md"}' } }] }, finish_reason: 'tool_calls' }] },
      ])
    }) as typeof fetch
    const events = []
    for await (const event of runProductModel({
      messages: [],
      systemPrompt: ['You are BilliardBuddy.'],
      thinkingConfig: { type: 'adaptive' },
      tools: [{
        name: 'Read',
        inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        description: async () => 'Read one workspace file',
        prompt: async () => 'Read before editing; stay inside the workspace.',
      } as never],
      signal: new AbortController().signal,
      options,
    })) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: {
        stop_reason: 'tool_call',
        content: [{ type: 'tool_call', id: 'call_1', name: 'Read', arguments: { file_path: 'notes.md' } }],
      },
    })
    expect(capturedBody?.tools).toEqual([{
      type: 'function',
      function: expect.objectContaining({
        name: 'Read',
        description: 'Read one workspace file\n\nRead before editing; stay inside the workspace.',
      }),
    }])
  })

  test('preserves a length stop reason when a streamed tool call looks complete', async () => {
    globalThis.fetch = (async () => stream([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_truncated', function: { name: 'Read', arguments: '{"file_path":"notes.md"}' } }] }, finish_reason: 'length' }] },
    ])) as typeof fetch
    const events = []
    for await (const event of runProductModel({
      messages: [],
      systemPrompt: ['You are BilliardBuddy.'],
      thinkingConfig: { type: 'disabled' },
      tools: [{
        name: 'Read',
        inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
        description: async () => 'Read one workspace file',
      } as never],
      signal: new AbortController().signal,
      options,
    })) events.push(event)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'assistant',
      message: {
        stop_reason: 'length',
        content: [{ type: 'tool_call', id: 'call_truncated', name: 'Read', arguments: { file_path: 'notes.md' } }],
      },
    })
  })
})
