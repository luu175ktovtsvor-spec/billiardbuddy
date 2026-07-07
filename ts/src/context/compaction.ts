import type { Model } from '../types/model'
import { textBlock, type Message, type ToolResultBlock, type ToolUseBlock } from '../types/message'

export const CONTEXT_OVERFLOW_RESERVE_CHARS = 48_000
export const AUTOCOMPACT_RATIO = 0.7
export const KEEP_RECENT_MESSAGES = 12
export const MIN_AUTOCOMPACT_OLD_MESSAGES = 6
export const MAX_COMPACTION_FAILURES = 3
export const AUTOCOMPACT_COOLDOWN_MS = 30_000
export const COMPACTION_SYSTEM_PROMPT = [
  '你是代码代理的长上下文压缩器。把下面旧对话压缩成高保真、可继续执行的中文摘要,不要调用工具。',
  '目标:压缩后下一个模型必须能继续改代码、跑测试、尊重用户约束,不能丢关键事实。',
  '输出格式:',
  '<analysis>可选:先内部整理,这里会被系统丢弃,不要依赖它继续任务。</analysis>',
  '<summary>',
  '1. 用户目标与硬约束:列出用户明确要求、禁止事项、分支/提交/安全/版权/可直接抄等边界。',
  '2. 技术概念与架构判断:记录已经确认的模块关系、实现原则、重要取舍。',
  '3. 文件与代码状态:按路径列出读过/改过/新增/删除的文件,说明关键符号、行为和未保存风险。',
  '4. 错误、失败与修复:记录报错原文、失败命令、原因、已采取修复和仍需注意的风险。',
  '5. 已完成事项:列出已经落地且通过验证的功能点。',
  '6. 用户原话要点:保留会影响后续决策的用户指令或偏好,不要泛化丢失语气强度。',
  '7. 待办清单:保留 pending/in_progress/done 状态,只能基于旧对话,不要新编。',
  '8. 当前工作现场:说明最后正在处理什么、改到哪里、下一步需要从哪个文件/测试继续。',
  '9. 下一步建议:给出最少可执行下一步,包含应跑的测试或验证。',
  '</summary>',
  '规则:保留真实路径、命令、测试结果、错误文本、接口名、模型/provider 名;不知道就写未确认;不要编造。',
].join('\n')

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
  lastCompactionAtMs?: number
  lastCompactedMessageCount?: number
  nowMs?: number
  cooldownMs?: number
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

function shouldAutocompact(input: CompactPipelineInput, failures: number): boolean {
  if (input.force) return true
  const cooldownMs = input.cooldownMs ?? AUTOCOMPACT_COOLDOWN_MS
  const lastAt = input.lastCompactionAtMs ?? 0
  if (lastAt > 0 && cooldownMs > 0 && (input.nowMs ?? Date.now()) - lastAt < cooldownMs) return false
  if (input.lastCompactedMessageCount && input.messages.length <= input.lastCompactedMessageCount) return false
  const contextWindowChars = input.contextWindowChars
  if (!contextWindowChars || failures >= MAX_COMPACTION_FAILURES) return false
  return estimateMessagesChars(input.messages) >= thresholdFor(contextWindowChars)
}

export async function compactPipeline(input: CompactPipelineInput): Promise<CompactPipelineOutput> {
  const failures = input.compactionFailures ?? 0
  microcompactReadOnlyToolResults(input.messages, input.readOnlyToolNames, input)
  if (!shouldAutocompact(input, failures)) {
    return { messages: input.messages, didCompact: false, compactionFailures: failures }
  }
  const split = splitForAutocompact(input.messages, input)
  if (!split) return { messages: input.messages, didCompact: false, compactionFailures: failures }

  try {
    const step = await input.model.step({
      system: COMPACTION_SYSTEM_PROMPT,
      messages: split.old,
      tools: [],
    })
    const rawSummary = step.kind === 'final' ? step.text : (step.text ?? '旧对话已压缩,继续当前任务。')
    const summary = extractCompactionSummary(rawSummary)
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

export function extractCompactionSummary(text: string): string {
  const summaryMatch = text.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)
  if (summaryMatch?.[1]?.trim()) return summaryMatch[1].trim()
  const withoutAnalysis = text.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '').trim()
  return withoutAnalysis || '旧对话已压缩,继续当前任务。'
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
