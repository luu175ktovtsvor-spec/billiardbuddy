import { describe, expect, test } from 'bun:test'
import { textBlock, toolResultBlock, toolUseBlock, userText, type Message } from '../types/message'
import { COMPACTION_SYSTEM_PROMPT, MAX_COMPACT_SUMMARY_RETRIES, compactPipeline, estimateMessagesChars, extractCompactionSummary, getAutoCompactTokenThreshold, getEffectiveContextWindowTokens, looksLikeContextOverflow, microcompactReadOnlyToolResults, splitForAutocompact } from './compaction'
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

  test('默认(KEEP_RECENT_MESSAGES=0)全量摘要不留逐字近段(对齐 cc auto-compact,近况靠压缩后重贴文件重建)', () => {
    const messages: Message[] = [
      userText('m1'), userText('m2'), userText('m3'), userText('m4'), userText('m5'),
      userText('m6'), userText('m7'), userText('m8'),
    ]
    // 不传 keepRecentMessages → 用默认常量 0
    const split = splitForAutocompact(messages, { minOldMessages: 2 })
    expect(split).not.toBeNull()
    expect(split!.recent).toEqual([])            // 零逐字近段
    expect(split!.old.length).toBe(messages.length) // 全量进摘要
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

  test('token 触发:真实 input tokens 达 cc 阈值(200k 窗口 → 167k)即压缩(字符估算低、未 force)', async () => {
    const messages: Message[] = [
      userText('a'), userText('b'), userText('c'), userText('d'), userText('e'), userText('f'), userText('recent'),
    ]
    let called = 0
    const model: Model = { async step() { called++; return { kind: 'final', text: '摘要' } } }
    const out = await compactPipeline({
      messages, model, system: 'SYS',
      // cc 公式:有效窗口 = 200k − min(maxOutput未知→20k, 20k) = 180k;阈值 = 180k − 13k = 167k。167k 恰达阈值 → 触发。
      contextWindowTokens: 200_000, lastInputTokens: 167_000,
      readOnlyToolNames: new Set(), keepRecentMessages: 1, minOldMessages: 2, // 不给 contextWindowChars、不 force
    })
    expect(called).toBe(1)
    expect(out.didCompact).toBe(true)
  })

  test('token 差 1(166,999 < 167k 阈值)+ 字符低 + 未 force → 不压缩(别过早触发)', async () => {
    const messages: Message[] = [userText('a'), userText('b'), userText('c'), userText('recent')]
    let called = 0
    const model: Model = { async step() { called++; return { kind: 'final', text: '摘要' } } }
    const out = await compactPipeline({
      messages, model, system: 'SYS',
      contextWindowTokens: 200_000, lastInputTokens: 166_999, // 差 1 未达 cc 阈值 → 不触发
      readOnlyToolNames: new Set(), keepRecentMessages: 1, minOldMessages: 2,
    })
    expect(called).toBe(0)
    expect(out.didCompact).toBe(false)
  })

  test('env CLAUDE_CODE_AUTO_COMPACT_WINDOW 覆盖生效:覆盖到小窗口后低 token 也触发压缩', async () => {
    const saved = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '50000' // 覆盖后有效 = 50k − 20k = 30k;阈值 = 30k − 13k = 17k
    try {
      const messages: Message[] = [
        userText('a'), userText('b'), userText('c'), userText('d'), userText('e'), userText('f'), userText('recent'),
      ]
      let called = 0
      const model: Model = { async step() { called++; return { kind: 'final', text: '摘要' } } }
      const out = await compactPipeline({
        messages, model, system: 'SYS',
        // 传入 200k(默认阈值 167k 不会触发),但 env 覆盖窗口为 50k → 阈值 17k → 17k 恰达 → 触发。
        contextWindowTokens: 200_000, lastInputTokens: 17_000,
        readOnlyToolNames: new Set(), keepRecentMessages: 1, minOldMessages: 2,
      })
      expect(called).toBe(1)
      expect(out.didCompact).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = saved
    }
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

  test('cc 对齐:无冷却/消息数压制——刚压过、上下文仍超阈值 → 下一轮立刻再压(允许连续压缩)', async () => {
    const bigText = (tag: string): Message => userText(tag + 'x'.repeat(60))
    let called = 0
    const model: Model = {
      async step() {
        called++
        // 摘要故意返回超长文本:压缩后的 messages 仍超字符阈值,模拟"一次压缩没降到阈值下"。
        return { kind: 'final', text: '摘'.repeat(200) }
      },
    }
    const first = await compactPipeline({
      messages: [bigText('u0'), bigText('u1'), bigText('u2'), bigText('u3'), userText('recent')],
      model,
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      keepRecentMessages: 1,
      minOldMessages: 2,
    })
    expect(first.didCompact).toBe(true)
    // 紧接着(cc 无 30s 冷却)、消息数还比压缩后更少(cc 无"没新增不压"门):仍超阈值就继续压。
    const second = await compactPipeline({
      messages: [...first.messages, userText('recent2')],
      model,
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      keepRecentMessages: 1,
    })
    expect(called).toBe(2)
    expect(second.didCompact).toBe(true)
  })

  test('cc 对齐:少量巨型消息(2 条)也允许压缩——旧值 minOld=6 会拒压放任 413', async () => {
    const messages: Message[] = [userText('giant' + 'x'.repeat(500)), userText('tail')]
    let called = 0
    const model: Model = {
      async step() {
        called++
        return { kind: 'final', text: '摘要' }
      },
    }
    const out = await compactPipeline({
      messages,
      model,
      contextWindowChars: 120,
      readOnlyToolNames: new Set(),
      // 不传 keepRecentMessages/minOldMessages:走默认(KEEP_RECENT=0 全量摘要,MIN_OLD=1)。
    })
    expect(called).toBe(1)
    expect(out.didCompact).toBe(true)
    expect(out.messages.length).toBe(1)
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

describe('getAutoCompactTokenThreshold(cc 数值锁定 + env 覆盖)', () => {
  const ENV_WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
  const ENV_PCT = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {}
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k]
      if (vars[k] === undefined) delete process.env[k]
      else process.env[k] = vars[k]!
    }
    try {
      fn()
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]!
      }
    }
  }

  test('200k 窗口(输出未知→预留 20k)→ 有效 180k → 阈值 167k', () => {
    withEnv({ [ENV_WINDOW]: undefined, [ENV_PCT]: undefined }, () => {
      expect(getEffectiveContextWindowTokens(200_000)).toBe(180_000)
      expect(getAutoCompactTokenThreshold(200_000)).toBe(167_000)
    })
  })

  test('小 maxOutput(8k)→ 预留 min(8k,20k)=8k → 有效 192k → 阈值 179k', () => {
    withEnv({ [ENV_WINDOW]: undefined, [ENV_PCT]: undefined }, () => {
      expect(getEffectiveContextWindowTokens(200_000, 8_000)).toBe(192_000)
      expect(getAutoCompactTokenThreshold(200_000, 8_000)).toBe(179_000)
    })
  })

  test('1M 窗口 → 阈值 967k(旧固定 0.7 会在 700k 早触发 267k,已掰回 cc)', () => {
    withEnv({ [ENV_WINDOW]: undefined, [ENV_PCT]: undefined }, () => {
      expect(getAutoCompactTokenThreshold(1_000_000)).toBe(967_000)
    })
  })

  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW 覆盖窗口(50k)→ 阈值 17k,无视传入 200k', () => {
    withEnv({ [ENV_WINDOW]: '50000', [ENV_PCT]: undefined }, () => {
      expect(getEffectiveContextWindowTokens(200_000)).toBe(30_000)
      expect(getAutoCompactTokenThreshold(200_000)).toBe(17_000)
    })
  })

  test('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 → min(floor(180k*0.5)=90k, 167k)=90k(只更早)', () => {
    withEnv({ [ENV_WINDOW]: undefined, [ENV_PCT]: '50' }, () => {
      expect(getAutoCompactTokenThreshold(200_000)).toBe(90_000)
    })
  })

  test('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=100 被默认阈值封顶(min → 167k,不会更晚)', () => {
    withEnv({ [ENV_WINDOW]: undefined, [ENV_PCT]: '100' }, () => {
      expect(getAutoCompactTokenThreshold(200_000)).toBe(167_000)
    })
  })

  test('非法 PCT_OVERRIDE(0/负/超100/NaN)忽略,回退默认阈值 167k', () => {
    for (const bad of ['0', '-5', '150', 'abc']) {
      withEnv({ [ENV_WINDOW]: undefined, [ENV_PCT]: bad }, () => {
        expect(getAutoCompactTokenThreshold(200_000)).toBe(167_000)
      })
    }
  })

  test('非法 AUTO_COMPACT_WINDOW(0/负/NaN)忽略,回退传入窗口', () => {
    for (const bad of ['0', '-1', 'xyz']) {
      withEnv({ [ENV_WINDOW]: bad, [ENV_PCT]: undefined }, () => {
        expect(getAutoCompactTokenThreshold(200_000)).toBe(167_000)
      })
    }
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

test('P7 触发算法不打架:有真实 token 用量时完全走 token 公式,字符粗估不得抢跑(对齐 cc 纯 token 判)', async () => {
  const fatMessages: Message[] = [
    ...Array.from({ length: 15 }, (_, i) => userText(`m${i}` + 'x'.repeat(50))),
    userText('recent'),
  ]
  const model: Model = {
    async step() {
      return { kind: 'final', text: '旧对话摘要' }
    },
  }
  // 真实 token 在手(远低于阈值 200k−20k−13k=167k)+ 字符估算已超小窗口 → 绝不触发(token 公式独裁)
  const noCompact = await compactPipeline({
    messages: fatMessages,
    model,
    lastInputTokens: 10_000,
    contextWindowTokens: 200_000,
    contextWindowChars: 300, // 字符路径若参与,这个小窗口早就该触发
    readOnlyToolNames: new Set(),
    keepRecentMessages: 1,
    minOldMessages: 2,
  })
  expect(noCompact.didCompact).toBe(false)
  // 同样字符条件、但没有真实 token → 字符兜底路径接管,触发
  const charCompact = await compactPipeline({
    messages: fatMessages,
    model,
    contextWindowChars: 300,
    readOnlyToolNames: new Set(),
    keepRecentMessages: 1,
    minOldMessages: 2,
  })
  expect(charCompact.didCompact).toBe(true)
  // 真实 token 超阈值 → token 公式触发(数值锁定:200k 窗口阈值 = 200k−20k−13k = 167k)
  const tokenCompact = await compactPipeline({
    messages: fatMessages,
    model,
    lastInputTokens: 167_001,
    contextWindowTokens: 200_000,
    readOnlyToolNames: new Set(),
    keepRecentMessages: 1,
    minOldMessages: 2,
  })
  expect(tokenCompact.didCompact).toBe(true)
})
