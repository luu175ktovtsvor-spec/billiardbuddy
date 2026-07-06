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

test('起始孤儿 tool_result(前无 assistant)→ 删,且用占位保持以 user 开头(不角色翻转)', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '孤儿' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]
  const out = ensureToolResultPairing(msgs)
  expect(out[0]!.content.some(b => b.type === 'tool_result')).toBe(false)
  // 清空后若直接丢弃这条,数组就以 assistant 开头 → 角色翻转 400;必须占位保持以 user 开头。
  expect(out[0]!.role).toBe('user')
})

test('regression:tool_use id 复用(跨轮去重删)后,旧 tool_result 变孤儿 → 必须删,不能原样滞留(否则重复/指向不存在的 tool_use → 400)', () => {
  const msgs: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok-turn1' }] },
    // 复用同一个 id → 跨轮去重会把这个 tool_use 整个删掉(变成 "[Tool use interrupted]" 占位)
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 't', input: {} }] },
    // 上面 tool_use 已被删,这条 tool_result 现在孤儿(指向本轮不存在的 tool_use)
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok-turn2-orphan' }] },
  ]
  const out = ensureToolResultPairing(msgs)
  const allResults = out.flatMap(m => m.content.filter(b => b.type === 'tool_result'))
  // 全程只应留下第一轮那条合法结果,第二条孤儿必须被删,不能让同一个 id 出现两次
  expect(allResults.length).toBe(1)
  expect((allResults[0] as any).content).toBe('ok-turn1')
})

test('文字轮(零 tool_use)后接孤儿 tool_result → 照样要删;删空后占位保持 user/assistant 交替', () => {
  const msgs: Message[] = [
    { role: 'assistant', content: [{ type: 'text', text: '好的,我看看' }] }, // 零 tool_use
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ZZZ', content: '孤儿(没有对应 tool_use)' }] },
    { role: 'assistant', content: [{ type: 'text', text: '继续' }] },
  ]
  const out = ensureToolResultPairing(msgs)
  // 孤儿必须被删(哪怕本轮 tool_use 集合是空的)
  expect(out.some(m => m.content.some(b => b.type === 'tool_result'))).toBe(false)
  // 交替护栏:不能出现两条相邻的 assistant(否则角色翻转 400)
  for (let i = 0; i < out.length - 1; i++) {
    expect(out[i]!.role === 'assistant' && out[i + 1]!.role === 'assistant').toBe(false)
  }
})
