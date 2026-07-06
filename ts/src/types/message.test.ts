import { test, expect } from 'bun:test'
import { textBlock, toolUseBlock, toolResultBlock, userText } from './message'
import type { Message } from './message'

test('userText 造一条 user 消息、content 是单个 text 块', () => {
  const m: Message = userText('你好')
  expect(m).toEqual({ role: 'user', content: [{ type: 'text', text: '你好' }] })
})

test('toolUseBlock 从 ToolCall 造 tool_use 块', () => {
  expect(toolUseBlock({ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }))
    .toEqual({ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } })
})

test('toolResultBlock:成功不带 is_error;错误带 is_error:true', () => {
  expect(toolResultBlock('c1', 'ok')).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'ok' })
  expect(toolResultBlock('c1', 'boom', true))
    .toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'boom', is_error: true })
})
