import { describe, expect, test } from 'bun:test'
import { textBlock, toolResultBlock, toolUseBlock, userText, type Message } from '../types/message'
import { compactPipeline, estimateMessagesChars, looksLikeContextOverflow, microcompactReadOnlyToolResults, splitForAutocompact } from './compaction'
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
})

describe('looksLikeContextOverflow', () => {
  test('识别结构码与常见 provider 文案', () => {
    expect(looksLikeContextOverflow({ code: 'context_length_exceeded' })).toBe(true)
    expect(looksLikeContextOverflow(new Error('maximum context length exceeded'))).toBe(true)
    expect(looksLikeContextOverflow({ message: 'prompt is too long' })).toBe(true)
    expect(looksLikeContextOverflow(new Error('network down'))).toBe(false)
  })
})
