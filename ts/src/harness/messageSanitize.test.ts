import { expect, test } from 'bun:test'
import { sanitizeResumeMessages, filterUnresolvedToolUseMessages } from './messageSanitize'
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from '../types/message'

const blocksOf = (messages: Message[]): ContentBlock[] => messages.flatMap(m => m.content)
const toolUses = (messages: Message[]): ToolUseBlock[] =>
  blocksOf(messages).filter((b): b is ToolUseBlock => b.type === 'tool_use')
const toolResults = (messages: Message[]): ToolResultBlock[] =>
  blocksOf(messages).filter((b): b is ToolResultBlock => b.type === 'tool_result')

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
  expect(json).not.toContain('orphan') // 整条全孤儿 tool_use 的 assistant 仍被丢
  expect(json).not.toContain('孤儿思考')
})

test('filterUnresolvedToolUseMessages:全配对时原样返回(no-op)', () => {
  const messages: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ]
  expect(filterUnresolvedToolUseMessages(messages)).toBe(messages)
})

test('sanitizeResumeMessages:混合轮不整条丢,缺结果的补 is_error 占位、有结果的那半保留', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'done', name: 't', input: {} },
        { type: 'tool_use', id: 'nores', name: 't', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'done', content: 'ok' }] },
  ]
  const out = sanitizeResumeMessages(messages)
  const json = JSON.stringify(out)
  // 两个 tool_use 都保留(混合轮没被整条丢)
  expect(json).toContain('done')
  expect(json).toContain('nores')
  // done 的真结果保留
  expect(json).toContain('ok')
  // nores 补了 is_error 占位 tool_result
  const nresResult = toolResults(out).find(b => b.tool_use_id === 'nores')
  expect(nresResult).toBeDefined()
  expect(nresResult?.is_error).toBe(true)
  // 每个 tool_use 都有配对 tool_result(全配对,喂回 API 不会 400)
  const resIds = new Set(toolResults(out).map(b => b.tool_use_id))
  for (const use of toolUses(out)) expect(resIds.has(use.id)).toBe(true)
})

test('sanitizeResumeMessages:开头孤儿 tool_result 被剥掉,首条仍是 user', () => {
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'ghost', content: '孤儿结果' },
        { type: 'text', text: '继续干活' },
      ],
    },
  ]
  const out = sanitizeResumeMessages(messages)
  const json = JSON.stringify(out)
  expect(json).not.toContain('ghost')
  expect(json).not.toContain('孤儿结果')
  expect(json).toContain('继续干活')
  expect(out[0]?.role).toBe('user') // 没有以孤儿 tool_result 开头导致角色翻转
})

test('sanitizeResumeMessages:跨消息重复 tool_use / tool_result id 去重', () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'dup', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'dup', content: 'first' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'dup', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'dup', content: 'second' }] },
  ]
  const out = sanitizeResumeMessages(messages)
  const useCount = toolUses(out).filter(b => b.id === 'dup').length
  const resCount = toolResults(out).filter(b => b.tool_use_id === 'dup').length
  expect(useCount).toBe(1) // 跨消息重复 tool_use id 去重
  expect(resCount).toBe(1) // 对应重复 tool_result 也去重
})
