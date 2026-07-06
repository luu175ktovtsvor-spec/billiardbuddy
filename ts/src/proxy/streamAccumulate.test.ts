import { test, expect } from 'bun:test'
import { accumulateOpenAiStream } from './streamAccumulate'

// 把若干 SSE 行拼成一个 ReadableStream(可故意把 JSON 劈到跨 chunk,考验缓冲)
function sse(lines: string[], chunkSplits: number[] = []): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const full = lines.map((l) => (l === '' ? '\n' : `data: ${l}\n\n`)).join('')
  const pieces: string[] = []
  let prev = 0
  for (const s of chunkSplits) { pieces.push(full.slice(prev, s)); prev = s }
  pieces.push(full.slice(prev))
  return new ReadableStream({
    start(c) { for (const p of pieces) c.enqueue(enc.encode(p)); c.close() },
  })
}
const chunk = (o: unknown) => JSON.stringify(o)

test('文本分片累积成整段', async () => {
  const acc = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] }),
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] }),
    '[DONE]',
  ]))
  expect(acc.text).toBe('你好')
  expect(acc.toolCalls).toEqual([])
  expect(acc.finishReason).toBe('stop')
})

test('工具调用分片:id/name/args 跨 chunk 累积', async () => {
  const acc = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }] }),
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]))
  expect(acc.toolCalls).toEqual([{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }])
})

test('国产模型不给 tool_call id → 自造(不静默丢工具)', async () => {
  const acc = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'todo_write', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]), { idFactory: (i) => `call_${i}_FIXED` })
  expect(acc.toolCalls).toEqual([{ id: 'call_0_FIXED', name: 'todo_write', input: {} }])
})

test('reasoning 三方言都归一进 thinking', async () => {
  for (const key of ['reasoning_content', 'reasoning']) {
    const acc = await accumulateOpenAiStream(sse([
      chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { [key]: '想一下' }, finish_reason: null }] }),
      chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '答案' }, finish_reason: 'stop' }] }),
      '[DONE]',
    ]))
    expect(acc.thinking).toBe('想一下')
    expect(acc.text).toBe('答案')
  }
  const acc2 = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { thinking_blocks: [{ type: 'thinking', thinking: 'o系推理' }] }, finish_reason: 'stop' }] }),
    '[DONE]',
  ]))
  expect(acc2.thinking).toBe('o系推理')
})

test('坏 JSON 行跳过、不炸', async () => {
  const acc = await accumulateOpenAiStream(sse([
    '{坏 json',
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    '[DONE]',
  ]))
  expect(acc.text).toBe('ok')
})

// 补充:真实 OpenAI stream_options.include_usage 行为——收尾一个 choices:[] 的空选择帧,usage 单独随后到。
test('usage 随空 choices 的收尾帧到达仍能采集', async () => {
  const acc = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }),
    chunk({ id: 'x', model: 'm', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    '[DONE]',
  ]))
  expect(acc.text).toBe('hi')
  expect(acc.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
})

test('两个并行工具调用(index 0/1)各自成块', async () => {
  const acc = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 't0', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 't1', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]))
  expect(acc.toolCalls.map(t => t.name)).toEqual(['t0', 't1'])
})

// 补充:JSON 行被硬劈成跨 raw-chunk 两截(考验 buffer 缓冲、不能按 chunk 边界解析)。
test('单行 JSON 被劈到两个底层 chunk 之间,缓冲后仍能正确解析', async () => {
  const lines = [
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '完整一段较长的内容用来确保切分点落在中间' }, finish_reason: 'stop' }] }),
    '[DONE]',
  ]
  const enc = new TextEncoder()
  const full = lines.map((l) => `data: ${l}\n\n`).join('')
  const cut = Math.floor(full.indexOf('内容') + 2) // 切在第一行 JSON 内容中间
  const acc = await accumulateOpenAiStream(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(full.slice(0, cut)))
      c.enqueue(enc.encode(full.slice(cut)))
      c.close()
    },
  }))
  expect(acc.text).toBe('完整一段较长的内容用来确保切分点落在中间')
  expect(acc.finishReason).toBe('stop')
})

// 补充:同一 index 的工具调用分片在"缺 id"收尾自造时,同一次累积里不同 index 各自拿到不同编号。
test('多个都缺 id 的工具调用,自造 id 按各自 index 区分', async () => {
  const acc = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { name: 't0', arguments: '{}' } },
      { index: 1, function: { name: 't1', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]), { idFactory: (i) => `auto_${i}` })
  expect(acc.toolCalls).toEqual([
    { id: 'auto_0', name: 't0', input: {} },
    { id: 'auto_1', name: 't1', input: {} },
  ])
})

// 补充:不传 idFactory 时走缺省的模块级计数器 —— 两次独立响应各自缺 id,自造出的 id 不能撞车
// (缺省实现不能只靠 Date.now(),同一毫秒内两次响应会撞;必须是递增计数器)。
test('缺省 idFactory 跨响应自造 id 不撞车(非纯 Date.now)', async () => {
  const missingIdStream = () => sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'todo_write', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ])
  const first = await accumulateOpenAiStream(missingIdStream())
  const second = await accumulateOpenAiStream(missingIdStream())
  expect(first.toolCalls[0]!.id).toBeTruthy()
  expect(second.toolCalls[0]!.id).toBeTruthy()
  expect(first.toolCalls[0]!.id).not.toBe(second.toolCalls[0]!.id)
})

// 补充(review finding 1):合法 JSON 但形状不对(null/数组里塞 null)不该崩整段累积——
// 坏形状跟坏 JSON 一样跳过、后面的正常块照样累积。
test('坏形状(合法 JSON 但结构不对)跳过、不崩:data:null / tool_calls 含 null / thinking_blocks 含 null', async () => {
  const acc = await accumulateOpenAiStream(sse([
    'null', // chunk 本身是 null → handleChunk 里 chunk.usage 会炸
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '一' }, finish_reason: null }] }),
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [null] }, finish_reason: null }] }), // tc.index 会炸
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '二' }, finish_reason: null }] }),
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { thinking_blocks: [null] }, finish_reason: null }] }), // tb[0].type 会炸
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '三' }, finish_reason: 'stop' }] }),
    '[DONE]',
  ]))
  expect(acc.text).toBe('一二三')
  expect(acc.finishReason).toBe('stop')
})

// 补充:最后一块没有末尾换行符(读循环退出时最后一行还留在 buffer 里),验证收尾 `if (buffer) processLine(buffer)` 真起作用。
test('末尾无换行符也能 flush(最后一行留在 buffer 里,读循环结束后仍处理)', async () => {
  const enc = new TextEncoder()
  const payload = `data: ${chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { content: '尾' }, finish_reason: 'stop' }] })}` // 故意不加 \n
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(payload))
      c.close()
    },
  })
  const acc = await accumulateOpenAiStream(stream)
  expect(acc.text).toBe('尾')
  expect(acc.finishReason).toBe('stop')
})

// 补充:工具调用排序按"首次出现顺序"(order 字段),不是数字 index——index 1 先到、index 0 后到时结果仍按到达顺序。
test('工具调用排序按首次出现顺序、非数字 index:index 1 先到后 index 0 到', async () => {
  const acc = await accumulateOpenAiStream(sse([
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [
      { index: 1, id: 'b', function: { name: 't1', arguments: '{}' } },
    ] }, finish_reason: null }] }),
    chunk({ id: 'x', model: 'm', choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 't0', arguments: '{}' } },
    ] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ]))
  expect(acc.toolCalls.map(t => t.name)).toEqual(['t1', 't0'])
})
