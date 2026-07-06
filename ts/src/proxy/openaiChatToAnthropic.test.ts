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
