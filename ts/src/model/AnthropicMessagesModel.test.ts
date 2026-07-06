import { expect, test } from 'bun:test'
import { AnthropicMessagesModel } from './AnthropicMessagesModel'
import { userText } from '../types/message'

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const line of lines) c.enqueue(enc.encode(line === '' ? '\n' : `data: ${line}\n\n`))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const chunk = (o: unknown) => JSON.stringify(o)

test('AnthropicMessagesModel:非流式 final,请求使用 messages endpoint 和 x-api-key', async () => {
  let sentUrl = ''
  let sentBody: any
  let sentHeaders: any
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.anthropic.test/v1',
    apiKey: 'k',
    model: 'claude-test',
    stream: false,
    fetchImpl: async (url, init) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init!.body as string)
      sentHeaders = init!.headers
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '答' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const step = await model.step({ system: 'SYS', messages: [userText('问')], tools: [] })
  expect(step).toEqual({ kind: 'final', text: '答' })
  expect(sentUrl).toBe('https://api.anthropic.test/v1/messages')
  expect(sentHeaders['x-api-key']).toBe('k')
  expect(sentHeaders['anthropic-version']).toBe('2023-06-01')
  expect(sentBody.system).toBe('SYS')
  expect(sentBody.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '问' }] })
})

test('AnthropicMessagesModel:auth_token 策略使用 Authorization', async () => {
  let sentHeaders: any
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1',
    authToken: 'tok',
    authStrategy: 'auth_token',
    model: 'm',
    stream: false,
    fetchImpl: async (_url, init) => {
      sentHeaders = init!.headers
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 })
    },
  })
  await model.step({ messages: [userText('x')], tools: [] })
  expect(sentHeaders.authorization).toBe('Bearer tok')
  expect(sentHeaders['x-api-key']).toBeUndefined()
})

test('AnthropicMessagesModel:SSE tool_use 累积 input_json_delta', async () => {
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async () => sseResponse([
      chunk({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'u1', name: 'read_file', input: {} } }),
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } }),
      chunk({ type: 'content_block_stop', index: 0 }),
      chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 3, output_tokens: 4 } }),
      '[DONE]',
    ]),
  })
  const step = await model.step({ messages: [userText('读文件')], tools: [] })
  expect(step).toEqual({ kind: 'tool_calls', calls: [{ id: 'u1', name: 'read_file', input: { path: 'a.txt' } }] })
})
