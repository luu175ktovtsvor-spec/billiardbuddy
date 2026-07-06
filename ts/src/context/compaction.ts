import type { Model } from '../types/model'
import { textBlock, type Message, type ToolResultBlock, type ToolUseBlock } from '../types/message'

export const CONTEXT_OVERFLOW_RESERVE_CHARS = 48_000
export const AUTOCOMPACT_RATIO = 0.7
export const KEEP_RECENT_MESSAGES = 12
export const MIN_AUTOCOMPACT_OLD_MESSAGES = 6
export const MAX_COMPACTION_FAILURES = 3

export interface MicrocompactOptions {
  keepRecentToolResults?: number
  maxResultChars?: number
}

export interface SplitOptions {
  keepRecentMessages?: number
  minOldMessages?: number
}

export interface CompactPipelineInput extends SplitOptions, MicrocompactOptions {
  messages: Message[]
  model: Model
  system?: string
  contextWindowChars?: number
  readOnlyToolNames: ReadonlySet<string>
  compactionFailures?: number
  force?: boolean
}

export interface CompactPipelineOutput {
  messages: Message[]
  didCompact: boolean
  note?: string
  compactionFailures: number
}

function blockChars(block: Message['content'][number]): number {
  if (block.type === 'text') return block.text.length
  if (block.type === 'thinking') return block.thinking.length
  if (block.type === 'tool_result') return block.content.length
  try {
    return block.name.length + JSON.stringify(block.input).length
  } catch {
    return block.name.length + 32
  }
}

export function estimateMessagesChars(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + m.content.reduce((s, b) => s + blockChars(b), 0), 0)
}

function toolUseMap(messages: Message[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') out.set(b.id, b.name)
    }
  }
  return out
}

/**
 * 把旧的只读工具结果折成一行。原地改 content,保持消息数组对象稳定,避免无谓重建前缀。
 */
export function microcompactReadOnlyToolResults(
  messages: Message[],
  readOnlyToolNames: ReadonlySet<string>,
  opts: MicrocompactOptions = {},
): number {
  const keepRecent = opts.keepRecentToolResults ?? 4
  const maxChars = opts.maxResultChars ?? 4_000
  const idToName = toolUseMap(messages)
  const results: ToolResultBlock[] = []
  for (const m of messages) {
    for (const b of m.content) if (b.type === 'tool_result') results.push(b)
  }
  const keep = new Set(results.slice(Math.max(0, results.length - keepRecent)))
  let changed = 0
  for (const r of results) {
    const tool = idToName.get(r.tool_use_id)
    if (!tool || !readOnlyToolNames.has(tool) || keep.has(r) || r.content.length <= maxChars) continue
    r.content = `[已压缩只读工具结果:${tool},原 ${r.content.length} 字符]`
    changed++
  }
  return changed
}

function toolResultIds(message: Message): string[] {
  return message.content.flatMap(b => (b.type === 'tool_result' ? [b.tool_use_id] : []))
}

function toolUseIds(message: Message): string[] {
  return message.content.flatMap(b => (b.type === 'tool_use' ? [b.id] : []))
}

/**
 * 切 old/recent,并把切点向前挪到不破 tool_use/tool_result 配对的位置。
 */
export function splitForAutocompact(messages: Message[], opts: SplitOptions = {}): { old: Message[]; recent: Message[] } | null {
  const keepRecent = opts.keepRecentMessages ?? KEEP_RECENT_MESSAGES
  const minOld = opts.minOldMessages ?? MIN_AUTOCOMPACT_OLD_MESSAGES
  if (messages.length <= keepRecent + minOld) return null
  let cut = Math.max(1, messages.length - keepRecent)

  while (cut > 0) {
    const recent = messages.slice(cut)
    const recentToolUses = new Set(recent.flatMap(toolUseIds))
    const first = recent[0]
    const orphanAtStart = first ? toolResultIds(first).some(id => !recentToolUses.has(id)) : false
    if (!orphanAtStart) break
    cut--
  }

  if (cut < minOld) return null
  return { old: messages.slice(0, cut), recent: messages.slice(cut) }
}

function thresholdFor(windowChars: number): number {
  return Math.max(windowChars - CONTEXT_OVERFLOW_RESERVE_CHARS, Math.floor(windowChars * AUTOCOMPACT_RATIO))
}

function shouldAutocompact(messages: Message[], contextWindowChars: number | undefined, failures: number, force: boolean): boolean {
  if (force) return true
  if (!contextWindowChars || failures >= MAX_COMPACTION_FAILURES) return false
  return estimateMessagesChars(messages) >= thresholdFor(contextWindowChars)
}

export async function compactPipeline(input: CompactPipelineInput): Promise<CompactPipelineOutput> {
  const failures = input.compactionFailures ?? 0
  microcompactReadOnlyToolResults(input.messages, input.readOnlyToolNames, input)
  if (!shouldAutocompact(input.messages, input.contextWindowChars, failures, input.force ?? false)) {
    return { messages: input.messages, didCompact: false, compactionFailures: failures }
  }
  const split = splitForAutocompact(input.messages, input)
  if (!split) return { messages: input.messages, didCompact: false, compactionFailures: failures }

  try {
    const step = await input.model.step({
      system: '把下面旧对话压缩成一段高保真摘要。保留用户目标、关键约束、已完成事项、待办和重要数据。不要调用工具。',
      messages: split.old,
      tools: [],
    })
    const summary = step.kind === 'final' ? step.text : (step.text ?? '旧对话已压缩,继续当前任务。')
    const compacted: Message[] = [
      { role: 'user', content: [textBlock(`[此前对话摘要]\n${summary}`)] },
      ...split.recent,
    ]
    return {
      messages: compacted,
      didCompact: true,
      note: `已压缩旧上下文: ${split.old.length} 条消息 → 1 条摘要。`,
      compactionFailures: 0,
    }
  } catch {
    return { messages: input.messages, didCompact: false, compactionFailures: failures + 1 }
  }
}

export function looksLikeContextOverflow(err: unknown): boolean {
  const parts: string[] = []
  if (err instanceof Error) parts.push(err.message, err.name)
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    for (const k of ['code', 'type', 'message', 'error', 'status']) {
      const v = o[k]
      if (typeof v === 'string' || typeof v === 'number') parts.push(String(v))
    }
  }
  const text = parts.join(' ').toLowerCase()
  return [
    'context_length_exceeded',
    'maximum context length',
    'context length',
    'prompt is too long',
    'too many tokens',
    'input is too long',
  ].some(p => text.includes(p))
}
