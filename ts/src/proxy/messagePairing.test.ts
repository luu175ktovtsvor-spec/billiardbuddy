import { test, expect } from 'bun:test'
import { normalizeMessagesForAPI, ensureToolResultPairing } from './messagePairing'
import type { Message } from '../types/message'

const SYNTH = '[Tool result missing due to internal error]'

test('normalize 合并连续同角色 user', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'b' }] },
  ]
  expect(normalizeMessagesForAPI(msgs)).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
  ])
})

test('normalize 丢掉 content 全空的消息', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'x' }] },
    { role: 'assistant', content: [] },
  ]
  expect(normalizeMessagesForAPI(msgs)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'x' }] }])
})

test('forward:tool_use 缺 tool_result → 补合成 is_error 占位', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
  ]
  const out = ensureToolResultPairing(msgs)
  const last = out.at(-1)!
  expect(last.role).toBe('user')
  expect(last.content).toContainEqual({ type: 'tool_result', tool_use_id: 'c1', content: SYNTH, is_error: true })
})

test('reverse:孤儿 tool_result(无对应 tool_use)→ 删', () => {
  const msgs: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'ZZZ', content: '孤儿' },
    ] },
  ]
  const out = ensureToolResultPairing(msgs)
  const results = out.at(-1)!.content.filter(b => b.type === 'tool_result')
  expect(results.map(r => (r as any).tool_use_id)).toEqual(['c1'])
})

test('dedup:重复 tool_use id 删后者;重复 tool_result id 删后者', () => {
  const msgs: Message[] = [
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'c1', name: 't', input: {} },
      { type: 'tool_use', id: 'c1', name: 't', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'c1', content: 'dup' },
    ] },
  ]
  const out = ensureToolResultPairing(msgs)
  const asst = out.find(m => m.role === 'assistant')!
  expect(asst.content.filter(b => b.type === 'tool_use').length).toBe(1)
  expect(out.at(-1)!.content.filter(b => b.type === 'tool_result').length).toBe(1)
})

test('起始孤儿 tool_result(前无 assistant)→ 删', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '孤儿' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]
  const out = ensureToolResultPairing(msgs)
  expect(out[0]!.content.some(b => b.type === 'tool_result')).toBe(false)
})
