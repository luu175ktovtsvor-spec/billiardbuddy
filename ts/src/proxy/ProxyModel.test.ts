import { test, expect } from 'bun:test'
import { ProxyModel } from './ProxyModel'
import { userText } from '../types/message'

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l === '' ? '\n' : `data: ${l}\n\n`)); c.close() },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const chunk = (o: unknown) => JSON.stringify(o)

test('端到端:SSE 文本 → final AssistantStep,且请求体是 OpenAI chat', async () => {
  let sentBody: any = null
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'test-model',
    fetchImpl: async (_url, init) => { sentBody = JSON.parse((init!.body as string)); return sseResponse([
      chunk({ id: 'x', model: 'test-model', choices: [{ index: 0, delta: { content: '答' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]) },
  })
  const step = await model.step({ system: 'SYS', messages: [userText('问')], tools: [] })
  expect(step).toEqual({ kind: 'final', text: '答' })
  expect(sentBody.model).toBe('test-model')
  expect(sentBody.stream).toBe(true)
  expect(sentBody.messages[0]).toEqual({ role: 'system', content: 'SYS' })
})

test('SSE 工具调用 → tool_calls AssistantStep(退出看 tool_use 不看 finish_reason)', async () => {
  // 故意 finish_reason:'stop' 但带 tool_calls —— 必须判成 tool_calls
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', idFactory: (i) => `call_${i}_X`,
    fetchImpl: async () => sseResponse([
      chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'todo_write', arguments: '{}' } }] }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]),
  })
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(step.kind).toBe('tool_calls')
  expect(step.kind === 'tool_calls' && step.calls).toEqual([{ id: 'call_0_X', name: 'todo_write', input: {} }])
})

test('非 2xx → 抛描述性错误', async () => {
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => new Response('bad request detail', { status: 400 }),
  })
  await expect(model.step({ messages: [userText('x')], tools: [] })).rejects.toThrow('400')
})

test('非 SSE JSON 响应 → 走非流式翻译', async () => {
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: '非流式答' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(step).toEqual({ kind: 'final', text: '非流式答' })
})

test('发请求前跑配对清洗:孤儿 tool_use 会被补占位(不 400)', async () => {
  let sentBody: any = null
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async (_u, init) => { sentBody = JSON.parse(init!.body as string); return sseResponse([
      chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]',
    ]) },
  })
  await model.step({ messages: [
    userText('go'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
  ], tools: [] })
  // 清洗后应有一条 role:tool 承接 c1(合成占位),否则国产上游 400
  const toolMsg = sentBody.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1')
  expect(toolMsg).toBeTruthy()
})
