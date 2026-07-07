import { describe, expect, test } from 'bun:test'
import { textBlock, toolResultBlock, toolUseBlock, userText, type Message } from '../types/message'
import { AUTOCOMPACT_COOLDOWN_MS, COMPACTION_SYSTEM_PROMPT, compactPipeline, estimateMessagesChars, extractCompactionSummary, looksLikeContextOverflow, microcompactReadOnlyToolResults, splitForAutocompact } from './compaction'
import type { Model } from '../types/model'

function msgWithTool(id: string, name: string, result: string): Message[] {
  return [
    { role: 'assistant', content: [toolUseBlock({ id, name, input: {} })] },
    { role: 'user', content: [toolResultBlock(id, result)] },
  ]
}

describe('microcompactReadOnlyToolResults', () => {
  test('只压旧的只读工具结果,保留最近结果不动', () => {
    const messages: Message[] = [
      userText('start'),
      ...msgWithTool('a', 'read_file', 'A'.repeat(80)),
      ...msgWithTool('b', 'write_file', 'B'.repeat(80)),
      ...msgWithTool('c', 'read_file', 'C'.repeat(80)),
    ]
    const changed = microcompactReadOnlyToolResults(messages, new Set(['read_file']), { keepRecentToolResults: 1, maxResultChars: 20 })
    expect(changed).toBeGreaterThan(0)
    const blocks = messages.flatMap(m => m.content)
    const a = blocks.find(b => b.type === 'tool_result' && b.tool_use_id === 'a')
    const b = blocks.find(x => x.type === 'tool_result' && x.type === 'tool_result' && x.tool_use_id === 'b')
    const c = blocks.find(x => x.type === 'tool_result' && x.type === 'tool_result' && x.tool_use_id === 'c')
    expect(a && a.type === 'tool_result' && a.content).toContain('[已压缩只读工具结果')
    expect(b && b.type === 'tool_result' && b.content).toBe('B'.repeat(80))
    expect(c && c.type === 'tool_result' && c.content).toBe('C'.repeat(80))
  })
})

describe('splitForAutocompact', () => {
  test('不会让 recent 以孤儿 tool_result 开头', () => {
    const messages: Message[] = [
      userText('start'),
      ...msgWithTool('a', 'read_file', 'A'),
      userText('middle'),
      ...msgWithTool('b', 'read_file', 'B'),
      userText('end'),
    ]
    const split = splitForAutocompact(messages, { keepRecentMessages: 2, minOldMessages: 2 })
    expect(split).not.toBeNull()
    expect(split!.recent[0]!.role).toBe('assistant')
    expect(split!.recent.flatMap(m => m.content).some(b => b.type === 'tool_use' && b.id === 'b')).toBe(true)
    expect(split!.recent.flatMap(m => m.content).some(b => b.type === 'tool_result' && b.tool_use_id === 'b')).toBe(true)
  })
})

describe('compactPipeline', () => {
  test('窗口超阈值时调用模型生成摘要并替换旧段', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    let called = 0
    const model: Model = {
      async step(input) {
        called++
        expect(input.tools).toEqual([])
        return { kind: 'final', text: '旧对话摘要' }
      },
    }
    const out = await compactPipeline({
      messages,
      model,
      system: 'SYS',
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      force: true,
      keepRecentMessages: 1,
      minOldMessages: 2,
    })
    expect(called).toBe(1)
    expect(out.didCompact).toBe(true)
    expect(out.note).toContain('已压缩旧上下文')
    expect(out.messages[0]!.role).toBe('user')
    const firstText = out.messages[0]!.content[0]
    expect(firstText?.type).toBe('text')
    if (firstText?.type !== 'text') throw new Error('expected summary text block')
    expect(firstText.text).toContain('旧对话摘要')
    expect(estimateMessagesChars(out.messages)).toBeLessThan(estimateMessagesChars(messages))
  })

  test('使用九段结构化 prompt,且只保留 summary 正文', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    let system = ''
    const out = await compactPipeline({
      messages,
      model: {
        async step(input) {
          system = input.system ?? ''
          return { kind: 'final', text: '<analysis>不要回灌这段草稿</analysis>\n<summary>1. 用户目标与硬约束:继续 main。\n9. 下一步建议:跑测试。</summary>' }
        },
      },
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      force: true,
      keepRecentMessages: 1,
      minOldMessages: 2,
    })

    expect(system).toBe(COMPACTION_SYSTEM_PROMPT)
    const summary = out.messages[0]!.content[0]
    expect(summary?.type).toBe('text')
    if (summary?.type !== 'text') throw new Error('expected summary text block')
    expect(summary.text).toContain('用户目标与硬约束')
    expect(summary.text).toContain('跑测试')
    expect(summary.text).not.toContain('不要回灌这段草稿')
  })

  test('自动压缩有冷却期,避免连续轮次反复摘要', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    let called = 0
    const out = await compactPipeline({
      messages,
      model: {
        async step() {
          called++
          return { kind: 'final', text: 'should not run' }
        },
      },
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      keepRecentMessages: 1,
      minOldMessages: 2,
      lastCompactionAtMs: 10_000,
      nowMs: 10_000 + AUTOCOMPACT_COOLDOWN_MS - 1,
    })

    expect(called).toBe(0)
    expect(out.didCompact).toBe(false)
    expect(out.messages).toBe(messages)
  })

  test('自动压缩后没有新增消息时不重复压同一段历史', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    let called = 0
    const out = await compactPipeline({
      messages,
      model: {
        async step() {
          called++
          return { kind: 'final', text: 'should not run' }
        },
      },
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      keepRecentMessages: 1,
      minOldMessages: 2,
      lastCompactedMessageCount: messages.length,
      nowMs: 99_000,
    })

    expect(called).toBe(0)
    expect(out.didCompact).toBe(false)
    expect(out.messages).toBe(messages)
  })
})

describe('extractCompactionSummary', () => {
  test('优先取 summary 标签内容,没有 summary 时剥离 analysis', () => {
    expect(extractCompactionSummary('<analysis>scratch</analysis><summary>usable</summary>')).toBe('usable')
    expect(extractCompactionSummary('<analysis>scratch</analysis>\nplain')).toBe('plain')
    expect(extractCompactionSummary('<analysis>scratch</analysis>')).toBe('旧对话已压缩,继续当前任务。')
  })
})

describe('looksLikeContextOverflow', () => {
  test('识别结构码与常见 provider 文案', () => {
    expect(looksLikeContextOverflow({ code: 'context_length_exceeded' })).toBe(true)
    expect(looksLikeContextOverflow(new Error('maximum context length exceeded'))).toBe(true)
    expect(looksLikeContextOverflow({ message: 'prompt is too long' })).toBe(true)
    expect(looksLikeContextOverflow(new Error('network down'))).toBe(false)
  })
})
