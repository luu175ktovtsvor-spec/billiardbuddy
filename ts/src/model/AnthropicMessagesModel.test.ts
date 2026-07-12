import { expect, test } from 'bun:test'
import { AnthropicMessagesModel } from './AnthropicMessagesModel'
import { documentBlock, userText, type Message } from '../types/message'
import { MODEL_OUTPUT_TRUNCATED_NOTICE } from '../types/model'
import { StreamProviderError } from '../proxy/streamAccumulate'

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

// 把 SSE 行拼成整段字节流,可在指定 byte 偏移把流劈成多个网络 chunk(考验跨 chunk 缓冲/切断在 data 行中间)。
function sseStream(lines: string[], chunkSplits: number[] = []): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const full = lines.map(l => (l === '' ? '\n' : `data: ${l}\n\n`)).join('')
  const pieces: string[] = []
  let prev = 0
  for (const s of chunkSplits) { pieces.push(full.slice(prev, s)); prev = s }
  pieces.push(full.slice(prev))
  return new ReadableStream({ start(c) { for (const p of pieces) c.enqueue(enc.encode(p)); c.close() } })
}
function sseResp(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
function streamingModel(lines: string[], chunkSplits: number[] = []): AnthropicMessagesModel {
  return new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => sseResp(sseStream(lines, chunkSplits)),
  })
}

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

// —— thinking 默认开、与 reasoningEffort 解耦(掰回 cc claude.ts:1653-1736 的分叉)——

function anthropicModel(cfg: Record<string, unknown>, captureBody: (b: any) => void): AnthropicMessagesModel {
  return new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', stream: false,
    fetchImpl: async (_url: unknown, init?: { body?: unknown }) => {
      captureBody(JSON.parse(init!.body as string))
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
    ...cfg,
  } as any)
}

test('AnthropicMessagesModel:默认(未设 reasoningEffort)→ 现代 Claude 也带 thinking:{type:adaptive}', async () => {
  let sentBody: any
  const model = anthropicModel({ model: 'claude-opus-4-7' }, b => (sentBody = b))
  await model.step({ messages: [userText('问')], tools: [] })
  // 默认开:不选深度思考也发 thinking(掰回分叉——过去未设 reasoningEffort 就不带 thinking)
  expect(sentBody.thinking).toEqual({ type: 'adaptive' })
})

test('AnthropicMessagesModel:默认 → budget 模型带 thinking:{type:enabled,budget_tokens=maxTokens-1}', async () => {
  let sentBody: any
  const model = anthropicModel({ model: 'claude-haiku-4-5', maxTokens: 32_000 }, b => (sentBody = b))
  await model.step({ messages: [userText('问')], tools: [] })
  // budget 模型 → 模型默认预算 = maxTokens-1(与 effort 解耦,不再按 effort 档取值)
  expect(sentBody.thinking).toEqual({ type: 'enabled', budget_tokens: 31_999 })
})

test('AnthropicMessagesModel:reasoningEffort 不再影响 thinking(解耦)——设了 high 仍走模型默认预算', async () => {
  let sentBody: any
  const model = anthropicModel({ model: 'claude-haiku-4-5', maxTokens: 32_000, reasoningEffort: 'high' }, b => (sentBody = b))
  await model.step({ messages: [userText('问')], tools: [] })
  expect(sentBody.thinking).toEqual({ type: 'enabled', budget_tokens: 31_999 })
})

test('AnthropicMessagesModel:CLAUDE_CODE_DISABLE_THINKING=1 → 请求不带 thinking(等价 cc 关闭闸)', async () => {
  const prev = process.env.CLAUDE_CODE_DISABLE_THINKING
  process.env.CLAUDE_CODE_DISABLE_THINKING = '1'
  try {
    let sentBody: any
    const model = anthropicModel({ model: 'claude-opus-4-7' }, b => (sentBody = b))
    await model.step({ messages: [userText('问')], tools: [] })
    expect(sentBody.thinking).toBeUndefined()
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_THINKING
    else process.env.CLAUDE_CODE_DISABLE_THINKING = prev
  }
})

test('AnthropicMessagesModel:ANTHROPIC_THINKING_MODE=off → 请求不带 thinking', async () => {
  const prev = process.env.ANTHROPIC_THINKING_MODE
  process.env.ANTHROPIC_THINKING_MODE = 'off'
  try {
    let sentBody: any
    const model = anthropicModel({ model: 'claude-haiku-4-5', maxTokens: 32_000 }, b => (sentBody = b))
    await model.step({ messages: [userText('问')], tools: [] })
    expect(sentBody.thinking).toBeUndefined()
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_THINKING_MODE
    else process.env.ANTHROPIC_THINKING_MODE = prev
  }
})

test('AnthropicMessagesModel:PDF document 块 → 默认回灌文本面包屑(MiMo/MiniMax anthropic 端点不支持 document)', async () => {
  let sentBody: any
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'minimax-m3', stream: false,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  await model.step({ messages: [{ role: 'user', content: [documentBlock('UERGREFUQQ==')] }], tools: [] })
  const blocks = sentBody.messages[0].content
  // 不再静默丢块(此前 return [] → 空 content → 补空 text);现回灌一条纠正性文本面包屑,不发上游不认的 document 块。
  expect(blocks.some((b: any) => b.type === 'document')).toBe(false)
  expect(blocks[0].type).toBe('text')
  expect(blocks[0].text).toContain('PDF')
})

test('AnthropicMessagesModel:ANTHROPIC_SEND_PDF_DOCUMENT=1 → 发真 document 块(供支持的 Anthropic 端点)', async () => {
  const prev = process.env.ANTHROPIC_SEND_PDF_DOCUMENT
  process.env.ANTHROPIC_SEND_PDF_DOCUMENT = '1'
  try {
    let sentBody: any
    const model = new AnthropicMessagesModel({
      baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'claude-opus-4-7', stream: false,
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(init!.body as string)
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      },
    })
    await model.step({ messages: [{ role: 'user', content: [documentBlock('UERGREFUQQ==')] }], tools: [] })
    expect(sentBody.messages[0].content).toEqual([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'UERGREFUQQ==' } },
    ])
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_SEND_PDF_DOCUMENT
    else process.env.ANTHROPIC_SEND_PDF_DOCUMENT = prev
  }
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
  expect(bodies[0].max_tokens).toBe(8000)   // 首发用默认 8k(对齐 cc CAPPED_DEFAULT_MAX_TOKENS)
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

// —— 逐 token 流式(打字机)行为对齐:Anthropic 出口 content_block_delta 增量 → onDelta 逐字增量 ——

test('onDelta:逐 token 吐 text/thinking 增量(顺序对齐 cc,累积结果不变)', async () => {
  const deltas: Array<{ channel: string; text: string }> = []
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
    chunk({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '想' } }),
    chunk({ type: 'content_block_stop', index: 1 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    '[DONE]',
  ])
  const step = await model.step({ messages: [userText('x')], tools: [], onDelta: d => deltas.push(d) })
  expect(deltas).toEqual([{ channel: 'text', text: '你' }, { channel: 'text', text: '好' }, { channel: 'thinking', text: '想' }])
  expect(step).toEqual({ kind: 'final', text: '你好', thinking: '想' })
})

test('空 text_delta 不产 content_delta 事件(空 delta 边界),非空正常吐', async () => {
  const deltas: Array<{ channel: string; text: string }> = []
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    '[DONE]',
  ])
  const step = await model.step({ messages: [userText('x')], tools: [], onDelta: d => deltas.push(d) })
  expect(deltas).toEqual([{ channel: 'text', text: 'A' }])
  expect(step).toEqual({ kind: 'final', text: 'A' })
})

test('content_block_start 携带首段正文也逐 token 吐(不漏),空则不吐', async () => {
  const deltas: Array<{ channel: string; text: string }> = []
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '开头' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '结尾' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    '[DONE]',
  ])
  const step = await model.step({ messages: [userText('x')], tools: [], onDelta: d => deltas.push(d) })
  expect(deltas).toEqual([{ channel: 'text', text: '开头' }, { channel: 'text', text: '结尾' }])
  expect(step).toEqual({ kind: 'final', text: '开头结尾' })
})

test('工具 input_json_delta 不进打字机(非可见正文),跨 delta 切断的 JSON 照常累积', async () => {
  const deltas: Array<{ channel: string; text: string }> = []
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'u1', name: 'read_file', input: {} } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '.txt"}' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    '[DONE]',
  ])
  const step = await model.step({ messages: [userText('读')], tools: [], onDelta: d => deltas.push(d) })
  expect(deltas).toEqual([]) // 工具入参不吐字
  expect(step).toEqual({ kind: 'tool_calls', calls: [{ id: 'u1', name: 'read_file', input: { path: 'a.txt' } }] })
})

test('跨网络 chunk 切断在 data 行中间的 tool JSON,由 buffer 兜住、还原正确', async () => {
  const lines = [
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'u1', name: 'grep', input: {} } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern":"foo","path":"src"}' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    '[DONE]',
  ]
  // 在整段中点劈成两个网络 chunk(大概率切在某行 data 中间)
  const full = lines.map(l => `data: ${l}\n\n`).join('')
  const model = streamingModel(lines, [Math.floor(full.length / 2)])
  const step = await model.step({ messages: [userText('搜')], tools: [] })
  expect(step).toEqual({ kind: 'tool_calls', calls: [{ id: 'u1', name: 'grep', input: { pattern: 'foo', path: 'src' } }] })
})

test('多工具:两个 tool_use 块按到达顺序返回,各自 input 跨 delta 累积', async () => {
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'u1', name: 'read_file', input: {} } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'u2', name: 'grep', input: {} } }),
    chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"pattern":"x"}' } }),
    chunk({ type: 'content_block_stop', index: 1 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    '[DONE]',
  ])
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(step).toEqual({
    kind: 'tool_calls',
    calls: [
      { id: 'u1', name: 'read_file', input: { path: 'a.txt' } },
      { id: 'u2', name: 'grep', input: { pattern: 'x' } },
    ],
  })
})

test('正文与工具混排:只有正文进打字机,工具照常解析并随 tool_calls 返回', async () => {
  const deltas: Array<{ channel: string; text: string }> = []
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来读' } }),
    chunk({ type: 'content_block_stop', index: 0 }),
    chunk({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'u1', name: 'read_file', input: {} } }),
    chunk({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }),
    chunk({ type: 'content_block_stop', index: 1 }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    '[DONE]',
  ])
  const step = await model.step({ messages: [userText('x')], tools: [], onDelta: d => deltas.push(d) })
  expect(deltas).toEqual([{ channel: 'text', text: '我来读' }])
  expect(step).toEqual({ kind: 'tool_calls', text: '我来读', calls: [{ id: 'u1', name: 'read_file', input: { path: 'a' } }] })
})

test('升级重试不重复 onDelta(截断→escalate 只吐首发增量,防前端打字机重影)', async () => {
  const deltas: Array<{ channel: string; text: string }> = []
  let calls = 0
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm',
    fetchImpl: async () => {
      calls++
      if (calls === 1) return sseResp(sseStream([
        chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '前半' } }),
        chunk({ type: 'content_block_stop', index: 0 }),
        chunk({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
        '[DONE]',
      ]))
      return sseResp(sseStream([
        chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写完' } }),
        chunk({ type: 'content_block_stop', index: 0 }),
        chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        '[DONE]',
      ]))
    },
  })
  const step = await model.step({ messages: [userText('长文')], tools: [], onDelta: d => deltas.push(d) })
  expect(calls).toBe(2)
  expect(deltas).toEqual([{ channel: 'text', text: '前半' }]) // 重试整段不再吐增量
  expect(step).toEqual({ kind: 'final', text: '写完' })
})

test('AnthropicMessagesModel:tool_result 块数组(text+image)→ Anthropic image content-block', async () => {
  let sentBody: any
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.anthropic.test/v1',
    apiKey: 'k',
    model: 'claude-test',
    stream: false,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'a.png' } }] },
    { role: 'user', content: [{
      type: 'tool_result',
      tool_use_id: 'u1',
      content: [
        { type: 'text', text: '<file_image format="png"/>' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    }] },
  ]
  await model.step({ messages, tools: [] })
  const userMsg = sentBody.messages.find((m: any) => m.role === 'user')
  expect(userMsg.content[0]).toEqual({
    type: 'tool_result',
    tool_use_id: 'u1',
    content: [
      { type: 'text', text: '<file_image format="png"/>' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ],
  })
})

// —— 流韧性两洞(对齐 ProxyModel 600d34b/8c195d2):SSE 中途 error 帧识别 + 流空闲超时 ——

test('SSE 中途 error 帧(event 形状 type=error)→ 抛 StreamProviderError,不产出空 assistant', async () => {
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分' } }),
    chunk({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
  ])
  let resolved: unknown
  let rejected: unknown
  try {
    resolved = await model.step({ messages: [userText('x')], tools: [] })
  } catch (err) {
    rejected = err
  }
  expect(resolved).toBeUndefined() // 没有静默吞成 final,压根没产出 assistant
  expect(rejected).toBeInstanceOf(StreamProviderError)
  expect((rejected as Error).message).toContain('Overloaded')
})

test('SSE 中途 error 帧(裸 {"error":...} 形状,无 type 字段)也识别', async () => {
  const model = streamingModel([
    chunk({ error: 'upstream unavailable' }),
  ])
  await expect(model.step({ messages: [userText('x')], tools: [] })).rejects.toThrow('upstream unavailable')
})

test('error 帧无 message 字段 → 兜底整包 JSON 化,不吞成空错误', async () => {
  const model = streamingModel([
    chunk({ type: 'error', error: { type: 'api_error' } }),
  ])
  await expect(model.step({ messages: [userText('x')], tools: [] })).rejects.toThrow(StreamProviderError)
})

test('正常帧携带 "error": null 占位字段(部分厂商 JSON 惯例)→ 不误判为错误帧,照常累积', async () => {
  const model = streamingModel([
    chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }, error: null }),
    chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好流' }, error: null }),
    chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, error: null }),
  ])
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(step.kind).toBe('final')
  expect(step.text).toBe('好流')
})

test('正常流(配置了 idleTimeoutMs)不受影响,照常累积完成', async () => {
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', idleTimeoutMs: 5000,
    fetchImpl: async () => sseResponse([
      chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      chunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
      chunk({ type: 'content_block_stop', index: 0 }),
      chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      '[DONE]',
    ]),
  })
  const step = await model.step({ messages: [userText('x')], tools: [] })
  expect(step).toEqual({ kind: 'final', text: '你好' })
})

test('流空闲超时:body 收到 headers 后中途卡死(无新 chunk、不关闭)→ 按 idleTimeoutMs 超时中止并抛可识别错误', async () => {
  const enc = new TextEncoder()
  const stalledBody = new ReadableStream<Uint8Array>({
    start(c) {
      // 只发一个不完整/中间态的事件,之后永不再 enqueue、永不 close,模拟连接卡死。
      c.enqueue(enc.encode(`data: ${chunk({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`))
    },
  })
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', idleTimeoutMs: 30,
    fetchImpl: async () => new Response(stalledBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  await expect(model.step({ messages: [userText('x')], tools: [] })).rejects.toThrow('idle timeout')
})

test('AnthropicMessagesModel:tool_result 字符串 content 原样序列化(向后兼容)', async () => {
  let sentBody: any
  const model = new AnthropicMessagesModel({
    baseUrl: 'https://api.anthropic.test/v1',
    apiKey: 'k',
    model: 'claude-test',
    stream: false,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'grep_files', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'plain text result' }] },
  ]
  await model.step({ messages, tools: [] })
  const userMsg = sentBody.messages.find((m: any) => m.role === 'user')
  expect(userMsg.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'u1', content: 'plain text result' })
})
