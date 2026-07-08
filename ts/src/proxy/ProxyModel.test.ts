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
  let sentInit: RequestInit | undefined
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'test-model',
    fetchImpl: async (_url, init) => { sentInit = init; sentBody = JSON.parse((init!.body as string)); return sseResponse([
      chunk({ id: 'x', model: 'test-model', choices: [{ index: 0, delta: { content: '答' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]) },
  })
  const step = await model.step({ system: 'SYS', messages: [userText('问')], tools: [] })
  expect(step).toEqual({ kind: 'final', text: '答' })
  expect(sentBody.model).toBe('test-model')
  expect(sentBody.stream).toBe(true)
  expect(sentBody.messages[0]).toEqual({ role: 'system', content: 'SYS' })
  // fetch 的 init 要带对的 headers(鉴权 + JSON content-type),否则国产上游直接拒。
  const headers = sentInit!.headers as Record<string, string>
  expect(headers.authorization).toBe('Bearer k')
  expect(headers['content-type']).toBe('application/json')
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

test('429 瞬时限流 → 退避重试后成功(不冒泡失败)', async () => {
  let calls = 0
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    retry: { sleep: async () => {} }, // no-op sleep 免真等待
    fetchImpl: async () => {
      calls++
      if (calls === 1) return new Response('rate limited', { status: 429 })
      return sseResponse([
        chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '重试后好了' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ])
    },
  })
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(step).toEqual({ kind: 'final', text: '重试后好了' })
  expect(calls).toBe(2)
})

test('400 请求错误不重试,仍立即抛(区别于瞬时错误)', async () => {
  let calls = 0
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    retry: { sleep: async () => {} },
    fetchImpl: async () => { calls++; return new Response('bad', { status: 400 }) },
  })
  await expect(model.step({ messages: [userText('x')], tools: [] })).rejects.toThrow('400')
  expect(calls).toBe(1)
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
  expect(step).toEqual({
    kind: 'final',
    text: '非流式答',
    notices: ['供应商本轮没有按流式返回,已自动按完整响应接回。'],
  })
})

test('非 SSE 200 但 body 非 JSON:降级空 final,不崩 step()(final review finding belt-and-suspenders)', async () => {
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => new Response('不是 JSON 的纯文本', { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(step).toEqual({
    kind: 'final',
    text: '',
    notices: ['供应商本轮返回了非流式但内容不可解析,已安全降级为空响应。'],
  })
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

test('组合顺序:先 normalize 后 pairing(交换会让真实 tool_result 被吞、伪造成错误占位)', async () => {
  // 两条相邻、尚未合并的 assistant 消息横跨一次工具调用:c1 的 tool_use 在第一条,
  // 紧接着一条纯文字 assistant,真正的 tool_result 在其后的 user 消息里。
  // 正确顺序:normalize 先把两条 assistant 合并成一条 → pairing 才能看到
  // "assistant(...tool_use c1...) 紧跟 user(tool_result c1)" → 配对成功、真实结果原样送出。
  // 若顺序被换(pairing 跑在未合并消息上):pairing 处理第一条 assistant 时,
  // 往下看到的是第二条 assistant(不是 user),判定 c1 未应答 → 合成错误占位;
  // 真实的 tool_result 后面被当"孤儿"(指向本轮不存在的 tool_use)悄悄丢弃。
  let sentBody: any = null
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    fetchImpl: async (_u, init) => { sentBody = JSON.parse(init!.body as string); return sseResponse([
      chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), '[DONE]',
    ]) },
  })
  await model.step({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: '继续想' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'real-result' }] },
    ],
    tools: [],
  })
  const toolMsg = sentBody.messages.find((m: any) => m.role === 'tool' && m.tool_call_id === 'c1')
  expect(toolMsg?.content).toBe('real-result')
  expect(toolMsg?.content).not.toBe('[Tool result missing due to internal error]')
})

test('reasoningEffort 会进 OpenAI-compatible 请求体', async () => {
  let sentBody: any = null
  const model = new ProxyModel({
    baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', reasoningEffort: 'high',
    fetchImpl: async (_u, init) => {
      sentBody = JSON.parse(init!.body as string)
      return sseResponse([
        chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        '[DONE]',
      ])
    },
  })
  await model.step({ messages: [userText('x')], tools: [] })
  expect(sentBody.reasoning_effort).toBe('high')
})
