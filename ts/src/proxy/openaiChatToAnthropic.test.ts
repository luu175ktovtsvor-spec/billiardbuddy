import { test, expect } from 'bun:test'
import { openaiChatResponseToAccumulated } from './openaiChatToAnthropic'

test('文本响应', () => {
  const acc = openaiChatResponseToAccumulated({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
  })
  expect(acc.text).toBe('你好')
  expect(acc.toolCalls).toEqual([])
  expect(acc.finishReason).toBe('stop')
})

test('reasoning_content + tool_calls(args 容错)', () => {
  const acc = openaiChatResponseToAccumulated({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: {
      role: 'assistant', content: null, reasoning_content: '想',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    }, finish_reason: 'tool_calls' }],
  })
  expect(acc.thinking).toBe('想')
  expect(acc.toolCalls).toEqual([{ id: 'c1', name: 'read_file', input: { path: 'a' } }])
})

test('空 choices → 空文本、不炸', () => {
  const acc = openaiChatResponseToAccumulated({ id: 'x', object: '', created: 0, model: 'm', choices: [] })
  expect(acc.text).toBe('')
  expect(acc.toolCalls).toEqual([])
})

// 补充(final review finding):非流式这条冷路径没有流式"按行跳过"的边界能兜,畸形但合法 JSON 的
// 上游响应此前会直接把整轮 agent turn 崩掉——下面四条锁住修复后的逐字段容错。

test('thinking_blocks 含 null 元素:跳过 null、保留有效项、不炸', () => {
  const acc = openaiChatResponseToAccumulated({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: {
      role: 'assistant', content: null,
      thinking_blocks: [null, { type: 'thinking', thinking: 'ok' }],
    }, finish_reason: 'stop' }],
  })
  expect(acc.thinking).toBe('ok')
})

test('tool_calls 碎片缺 function:跳过该碎片、不炸', () => {
  const acc = openaiChatResponseToAccumulated({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'x', type: 'function' }],
    }, finish_reason: 'tool_calls' }],
  })
  expect(acc.toolCalls).toEqual([])
})

test('choice 整体缺 message:不炸、走空结果但保留 finishReason', () => {
  const acc = openaiChatResponseToAccumulated({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, finish_reason: 'stop' }],
  })
  expect(acc.text).toBe('')
  expect(acc.toolCalls).toEqual([])
  expect(acc.finishReason).toBe('stop')
})

test('tool_calls 缺 id:按注入的 idFactory 自造(与流式路径对称,不留 id:undefined)', () => {
  const acc = openaiChatResponseToAccumulated({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: {
      role: 'assistant', content: null,
      tool_calls: [{ type: 'function', function: { name: 't', arguments: '{}' } }],
    }, finish_reason: 'tool_calls' }],
  }, { idFactory: (i) => `call_${i}_X` })
  expect(acc.toolCalls).toEqual([{ id: 'call_0_X', name: 't', input: {} }])
})
