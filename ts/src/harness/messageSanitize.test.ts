import { expect, test } from 'bun:test'
import { sanitizeResumeMessages, filterUnresolvedToolUseMessages } from './messageSanitize'
import type { Message } from '../types/message'

test('sanitizeResumeMessages:去未配对 tool_use / 孤儿 thinking / 空白 assistant,保留有效', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'resolved', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'resolved', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 't', input: {} }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '孤儿思考' }] },
    { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    { role: 'assistant', content: [{ type: 'text', text: '真内容' }] },
  ]
  const out = sanitizeResumeMessages(messages)
  expect(out.length).toBe(4) // user hi + resolved tool_use + tool_result + 真内容
  const json = JSON.stringify(out)
  expect(json).toContain('resolved')
  expect(json).toContain('真内容')
  expect(json).not.toContain('orphan')
  expect(json).not.toContain('孤儿思考')
})

test('filterUnresolvedToolUseMessages:全配对时原样返回(no-op)', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ]
  expect(filterUnresolvedToolUseMessages(messages)).toBe(messages)
})
