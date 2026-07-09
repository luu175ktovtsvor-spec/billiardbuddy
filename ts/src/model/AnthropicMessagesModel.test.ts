import { expect, test } from 'bun:test'
import { AnthropicMessagesModel } from './AnthropicMessagesModel'
import { userText } from '../types/message'
import { MODEL_OUTPUT_TRUNCATED_NOTICE } from '../types/model'

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
  expect(step).toEqual({
    kind: 'tool_calls',
    calls: [{ id: 'u1', name: 'read_file', input: { path: 'a.txt' } }],
    usage: { input_tokens: 3, output_tokens: 4 },
  })
})

// —— 输出撞长度上限的恢复(对齐 cc query.ts:1196-1229 escalate + context.ts:32 ESCALATED_MAX_TOKENS=64k)——

test('stop_reason=max_tokens(无工具调用)→ 升 max_tokens=64000 重试一次,用重试后的完整结果', async () => {
  const bodies: any[] = []
  let calls = 0
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', stream: false,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string)); calls++
      if (calls === 1) return new Response(JSON.stringify({ content: [{ type: 'text', text: '前半段' }], stop_reason: 'max_tokens' }), { status: 200 })
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '升上限后写完' }], stop_reason: 'end_turn' }), { status: 200 })
    },
  })
  const step = await model.step({ messages: [userText('写长文')], tools: [] })
  expect(calls).toBe(2)
  expect(bodies[0].max_tokens).toBe(4096)   // 首发用默认 4k
  expect(bodies[1].max_tokens).toBe(64000)  // 升级重试到 64k(对齐 cc ESCALATED_MAX_TOKENS)
  expect(step).toEqual({ kind: 'final', text: '升上限后写完' })  // 用重试结果,不再带截断提示
})

test('model_context_window_exceeded 也走同一"从断点续写"恢复路径(对齐 cc claude.ts:2448-2461)', async () => {
  let calls = 0
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', stream: false,
    fetchImpl: async () => {
      calls++
      return new Response(JSON.stringify({ content: [{ type: 'text', text: `块${calls}` }], stop_reason: 'model_context_window_exceeded' }), { status: 200 })
    },
  })
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(calls).toBe(2)  // 升级重试恰一次
  expect(step.kind).toBe('final')
  expect(step.notices).toContain(MODEL_OUTPUT_TRUNCATED_NOTICE)  // 仍截断 → 附提示,交主循环续写
})

test('stop_reason=max_tokens 但已带 tool_calls → 不升级重试、不丢工具调用(照常 tool_calls + 截断提示)', async () => {
  let calls = 0
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', stream: false,
    fetchImpl: async () => {
      calls++
      return new Response(JSON.stringify({
        content: [{ type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'a.txt' } }],
        stop_reason: 'max_tokens',
      }), { status: 200 })
    },
  })
  const step = await model.step({ messages: [userText('读文件')], tools: [] })
  expect(calls).toBe(1)  // 不重试:工具调用交主循环配对执行
  expect(step.kind).toBe('tool_calls')
  expect(step.kind === 'tool_calls' && step.calls).toEqual([{ id: 'u1', name: 'read_file', input: { path: 'a.txt' } }])
  expect(step.notices).toContain(MODEL_OUTPUT_TRUNCATED_NOTICE)
})

test('escalatedMaxTokens 可配置', async () => {
  const bodies: any[] = []
  let calls = 0
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', stream: false, escalatedMaxTokens: 16000,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string)); calls++
      const stop = calls === 1 ? 'max_tokens' : 'end_turn'
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'a' }], stop_reason: stop }), { status: 200 })
    },
  })
  await model.step({ messages: [userText('x')], tools: [] })
  expect(bodies[1].max_tokens).toBe(16000)
})
