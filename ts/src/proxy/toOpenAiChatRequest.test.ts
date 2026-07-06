import { test, expect } from 'bun:test'
import { toOpenAiChatRequest } from './toOpenAiChatRequest'
import type { Message } from '../types/message'

test('system → 头条 system 消息;stream 带 include_usage', () => {
  const r = toOpenAiChatRequest({ model: 'm', system: 'SYS', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], stream: true })
  expect(r.messages[0]).toEqual({ role: 'system', content: 'SYS' })
  expect(r.messages[1]).toEqual({ role: 'user', content: 'hi' })
  expect(r.stream).toBe(true)
  expect(r.stream_options).toEqual({ include_usage: true })
})

test('user 里 tool_result 块 → 独立 role:tool 消息', () => {
  const msgs: Message[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'payload' }] }]
  const r = toOpenAiChatRequest({ model: 'm', messages: msgs })
  expect(r.messages).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'payload' }])
})

test('assistant text+tool_use → content + tool_calls(thinking 丢弃不回灌)', () => {
  const msgs: Message[] = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '内心戏' },
      { type: 'text', text: '我来读文件' },
      { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
    ],
  }]
  const r = toOpenAiChatRequest({ model: 'm', messages: msgs })
  expect(r.messages[0]).toEqual({
    role: 'assistant',
    content: '我来读文件',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
  })
  expect((r.messages[0] as any).reasoning_content).toBeUndefined()
})

test('tools(ToolSpec)→ OpenAI function 工具', () => {
  const r = toOpenAiChatRequest({
    model: 'm', messages: [],
    tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })
  expect(r.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }])
})

test('text_only 模式:图片块替换为占位文本', () => {
  const msgs: Message[] = [{ role: 'user', content: [
    { type: 'text', text: '看这张' },
    { type: 'image' as any, source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } as any,
  ] }]
  const r = toOpenAiChatRequest({ model: 'm', messages: msgs, imageContentMode: 'text_only' })
  expect(typeof r.messages[0]!.content).toBe('string')
  expect(r.messages[0]!.content).toContain('看这张')
  expect(r.messages[0]!.content).toContain('[Image omitted')
})

test('reasoningEffort → reasoning_effort 透传', () => {
  const r = toOpenAiChatRequest({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    reasoningEffort: 'high',
  })
  expect(r.reasoning_effort).toBe('high')
})
