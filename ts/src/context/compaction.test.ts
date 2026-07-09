import { describe, expect, test } from 'bun:test'
import { textBlock, toolResultBlock, toolUseBlock, userText, type Message } from '../types/message'
import { AUTOCOMPACT_COOLDOWN_MS, COMPACTION_SYSTEM_PROMPT, MAX_COMPACT_SUMMARY_RETRIES, compactPipeline, estimateMessagesChars, extractCompactionSummary, looksLikeContextOverflow, microcompactReadOnlyToolResults, splitForAutocompact } from './compaction'
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
      postSummaryMessages: [userText('保留已调用技能')],
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
    expect(out.messages[1]).toEqual(userText('保留已调用技能'))
    expect(estimateMessagesChars(out.messages)).toBeLessThan(estimateMessagesChars(messages))
  })

  test('token 触发:真实 input tokens 达窗口比例即压缩(字符估算低、未 force,对齐 cc 真实用量优先)', async () => {
    const messages: Message[] = [
      userText('a'), userText('b'), userText('c'), userText('d'), userText('e'), userText('f'), userText('recent'),
    ]
    let called = 0
    const model: Model = { async step() { called++; return { kind: 'final', text: '摘要' } } }
    const out = await compactPipeline({
      messages, model, system: 'SYS',
      contextWindowTokens: 1000, lastInputTokens: 800, // 800 >= 0.7*1000 → token 路径触发
      readOnlyToolNames: new Set(), keepRecentMessages: 1, minOldMessages: 2, // 不给 contextWindowChars、不 force
    })
    expect(called).toBe(1)
    expect(out.didCompact).toBe(true)
  })

  test('token 未达比例 + 字符低 + 未 force → 不压缩', async () => {
    const messages: Message[] = [userText('a'), userText('b'), userText('c'), userText('recent')]
    let called = 0
    const model: Model = { async step() { called++; return { kind: 'final', text: '摘要' } } }
    const out = await compactPipeline({
      messages, model, system: 'SYS',
      contextWindowTokens: 1000, lastInputTokens: 100, // 100 < 700 → 不触发
      readOnlyToolNames: new Set(), keepRecentMessages: 1, minOldMessages: 2,
    })
    expect(called).toBe(0)
    expect(out.didCompact).toBe(false)
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

  test('摘要请求超限(prompt-too-long)时收缩最旧一截重试,最终仍压缩成功', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    const callSizes: number[] = []
    const model: Model = {
      async step(input) {
        callSizes.push(input.messages.length)
        if (callSizes.length === 1) {
          throw Object.assign(new Error('prompt is too long'), { code: 'context_length_exceeded' })
        }
        return { kind: 'final', text: '收缩后的摘要' }
      },
    }
    const out = await compactPipeline({
      messages,
      model,
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      force: true,
      keepRecentMessages: 1,
      minOldMessages: 2,
    })
    expect(callSizes.length).toBe(2)
    expect(callSizes[1]).toBeLessThan(callSizes[0]!)
    expect(out.didCompact).toBe(true)
    expect(out.note).toContain('收缩重试')
    expect(out.compactionFailures).toBe(0)
  })

  test('摘要请求持续超限、收缩到无法再丢时放弃并降级(保留原消息、失败计数+1)', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    let calls = 0
    const model: Model = {
      async step() {
        calls++
        throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' })
      },
    }
    const out = await compactPipeline({
      messages,
      model,
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      force: true,
      keepRecentMessages: 1,
      minOldMessages: 2,
    })
    // old 段 5 条:5→2→1 条,收缩两次后 shrinkOldMessagesForRetry(1 条) 返回 null,放弃重试。
    expect(calls).toBeGreaterThan(1)
    expect(calls).toBeLessThanOrEqual(MAX_COMPACT_SUMMARY_RETRIES + 1)
    expect(out.didCompact).toBe(false)
    expect(out.messages).toBe(messages)
    expect(out.compactionFailures).toBe(1)
  })

  test('非上下文超限的报错不触发收缩重试,直接降级', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    let calls = 0
    const model: Model = {
      async step() {
        calls++
        throw new Error('network down')
      },
    }
    const out = await compactPipeline({
      messages,
      model,
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      force: true,
      keepRecentMessages: 1,
      minOldMessages: 2,
    })
    expect(calls).toBe(1)
    expect(out.didCompact).toBe(false)
    expect(out.messages).toBe(messages)
    expect(out.compactionFailures).toBe(1)
  })

  test('摘要模型返回空文本时不静默生成占位摘要,而是降级保留原消息', async () => {
    const messages: Message[] = [
      userText('u0' + 'x'.repeat(60)),
      userText('u1' + 'x'.repeat(60)),
      userText('u2' + 'x'.repeat(60)),
      userText('u3' + 'x'.repeat(60)),
      userText('u4' + 'x'.repeat(60)),
      userText('u5' + 'x'.repeat(60)),
      userText('recent'),
    ]
    const model: Model = {
      async step() {
        return { kind: 'final', text: '' }
      },
    }
    const out = await compactPipeline({
      messages,
      model,
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      force: true,
      keepRecentMessages: 1,
      minOldMessages: 2,
    })
    expect(out.didCompact).toBe(false)
    expect(out.messages).toBe(messages)
    expect(out.compactionFailures).toBe(1)
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
