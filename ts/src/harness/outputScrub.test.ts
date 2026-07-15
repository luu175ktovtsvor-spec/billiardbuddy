import { expect, test } from 'bun:test'
import type { AgentEvent } from '../types/events'
import { createChatOutputScrubber, scrubProseIdentifiers } from './outputScrub'

// 白标黑名单(同 #38):任何真名/供应商/endpoint 都不许出现在用户可见文本里。
const FORBIDDEN = [
  'seedream',
  'doubao',
  '豆包',
  'gpt-image',
  'claude',
  'anthropic',
  'openai',
  'deepseek',
  '火山',
  '方舟',
  'volc',
  'volces',
  'ark',
  'mimo',
  'glm',
]

function assertClean(text: string, label: string): void {
  const lower = text.toLowerCase()
  for (const token of FORBIDDEN) {
    if (lower.includes(token.toLowerCase())) {
      throw new Error(`白标泄露 [${label}]:出现「${token}」 → ${text}`)
    }
  }
}

/** 把一串事件喂进清洗器,收集所有放行的事件(含流末 flush)。 */
function run(events: AgentEvent[]): AgentEvent[] {
  const scrubber = createChatOutputScrubber()
  const out: AgentEvent[] = []
  for (const ev of events) out.push(...scrubber.push(ev))
  out.push(...scrubber.flush())
  return out
}

function deltaText(events: AgentEvent[], channel: 'text' | 'thinking' = 'text'): string {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'content_delta' }> => e.type === 'content_delta' && e.channel === channel)
    .map(e => e.text)
    .join('')
}

function finalText(events: AgentEvent[]): string {
  const f = events.find((e): e is Extract<AgentEvent, { type: 'final' }> => e.type === 'final')
  return f?.text ?? ''
}

test('scrubProseIdentifiers:真名换成散文友好口径「本助手」,不留突兀 token', () => {
  const out = scrubProseIdentifiers('我其实是 Claude,由 Anthropic 训练的')
  assertClean(out, 'prose')
  expect(out).toContain('本助手')
})

test('白标守卫(核心):真名跨两个 content_delta 被切断,流式序列 + final 都不泄露', () => {
  // "Claude" 被拆成 "Clau" + "de";"Anthropic" 拆成 "Anthro" + "pic"。
  const events: AgentEvent[] = [
    { type: 'content_delta', channel: 'text', text: '你好,我用的是 Clau' },
    { type: 'content_delta', channel: 'text', text: 'de 模型,背后是 Anthro' },
    { type: 'content_delta', channel: 'text', text: 'pic 公司训练的。' },
    { type: 'final', text: '你好,我用的是 Claude 模型,背后是 Anthropic 公司训练的。' },
  ]
  const out = run(events)
  const streamed = deltaText(out)
  const final = finalText(out)
  // 关键断言:逐个 delta + 拼起来的流 + final,全都不含任何真名。
  for (const ev of out) {
    if (ev.type === 'content_delta' || ev.type === 'final') assertClean(ev.text, ev.type)
  }
  assertClean(streamed, 'streamed-concat')
  assertClean(final, 'final')
  // 内容仍完整(结构没吞字):流式拼起来 == final。
  expect(streamed).toBe(final)
  expect(final).toContain('本助手')
})

test('白标守卫:单个 delta 里就带整个真名也被清掉', () => {
  const out = run([
    { type: 'content_delta', channel: 'text', text: '我是 GPT-image-2,走 ark.cn-beijing.volces.com' },
    { type: 'final', text: '我是 GPT-image-2,走 ark.cn-beijing.volces.com' },
  ])
  assertClean(deltaText(out), 'delta')
  assertClean(finalText(out), 'final')
  expect(finalText(out)).not.toContain('.com')
})

test('白标守卫:thinking 块(推理)也脱敏', () => {
  const out = run([
    { type: 'thinking', text: '用户想知道我是不是 Claude,不能承认。' },
    { type: 'content_delta', channel: 'thinking', text: '其实底层是 Anthro' },
    { type: 'content_delta', channel: 'thinking', text: 'pic 的模型' },
    { type: 'final', text: '我是管家的助手。' },
  ])
  for (const ev of out) {
    if (ev.type === 'thinking') assertClean(ev.text, 'thinking-block')
    if (ev.type === 'content_delta') assertClean(ev.text, 'thinking-delta')
  }
  assertClean(deltaText(out, 'thinking'), 'thinking-stream')
})

test('公开 commentary 在工具边界放行短流式文本并保持脱敏', () => {
  const scrubber = createChatOutputScrubber()
  const events = [
    ...scrubber.push({ type: 'content_delta', channel: 'text', text: '我先用 Clau' }),
    ...scrubber.push({ type: 'content_delta', channel: 'text', text: 'de 看一下。' }),
    ...scrubber.push({ type: 'commentary', text: '我先用 Claude 看一下。' }),
  ]
  expect(events.some(event => event.type === 'content_delta' && event.channel === 'text')).toBe(true)
  const commentary = events.find((event): event is Extract<AgentEvent, { type: 'commentary' }> => event.type === 'commentary')
  expect(commentary?.text).toBe('我先用本助手看一下。')
  expect(JSON.stringify(events)).not.toContain('Claude')
})

test('正常台球文本不被误伤(无真名 → 原样透传,一字不改)', () => {
  const answer = '推荐乔氏或星牌的台球桌,美团、大众点评上评分都不错;助教走探探、陌陌引流也行。'
  const events: AgentEvent[] = [
    { type: 'content_delta', channel: 'text', text: '推荐乔氏或星牌的台球桌,美团、' },
    { type: 'content_delta', channel: 'text', text: '大众点评上评分都不错;助教走探探、陌陌引流也行。' },
    { type: 'final', text: answer },
  ]
  const out = run(events)
  // 内容零改动:流式拼起来 == final == 原文。
  expect(deltaText(out)).toBe(answer)
  expect(finalText(out)).toBe(answer)
})

test('context_note(系统旁白)沿用 #38 口径脱敏', () => {
  const out = run([
    { type: 'context_note', text: '已从 doubao-seedream 出口切换到备用出口' },
    { type: 'final', text: '好的。' },
  ])
  const note = out.find((e): e is Extract<AgentEvent, { type: 'context_note' }> => e.type === 'context_note')
  expect(note).toBeDefined()
  assertClean(note!.text, 'context_note')
})

test('其它事件类型原样透传(tool_result 不被脱敏,允许含 openai 等技术词)', () => {
  const toolResult: AgentEvent = { type: 'tool_result', tool: 'web_fetch', output: 'openai api docs: ...' }
  const out = run([toolResult, { type: 'final', text: '查完了。' }])
  const passed = out.find(e => e.type === 'tool_result')
  expect(passed).toEqual(toolResult)
})
