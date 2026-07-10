import type { AssistantStep, Model } from '../types/model'
import { textBlock, type Message, type ToolResultBlock, type ToolUseBlock } from '../types/message'

export const CONTEXT_OVERFLOW_RESERVE_CHARS = 48_000
/** 首轮还没真实 token 用量时的字符估算兜底比例(cc 没有字符路径,这是我们的降级估算)。 */
export const AUTOCOMPACT_RATIO = 0.7
/**
 * token 级自动压缩触发阈值 = cc 公式(对齐 cc-haha src/services/compact/autoCompact.ts:30/62/72-91):
 * 有效窗口 = min(窗口, CLAUDE_CODE_AUTO_COMPACT_WINDOW) − min(模型最大输出, 20k);
 * 触发阈值 = 有效窗口 − 13k;按上一轮响应回报的真实 input token 判(比字符估算准)。
 * 例:200k 窗口(输出≥20k)→ 有效 180k → 阈值 167k。旧实现固定 0.7 比例已替换。
 */
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const KEEP_RECENT_MESSAGES = 12
export const MIN_AUTOCOMPACT_OLD_MESSAGES = 6
export const MAX_COMPACTION_FAILURES = 3
export const AUTOCOMPACT_COOLDOWN_MS = 30_000
/**
 * 摘要请求本身超限(prompt-too-long)时的收缩重试上限。
 * 对齐 cc-haha src/services/compact/compact.ts:227 的 MAX_PTL_RETRIES = 3。
 */
export const MAX_COMPACT_SUMMARY_RETRIES = 3
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
  postSummaryMessages?: Message[]
  contextWindowChars?: number
  /** 模型窗口 token 数;配合 lastInputTokens 做 token 级自动压缩触发(cc:真实用量优先于字符估算)。 */
  contextWindowTokens?: number
  /** 模型最大输出 token 数(可选);摘要预留 = min(它, 20k),未提供时按 20k 预留。对齐 cc getMaxOutputTokensForModel。 */
  maxOutputTokens?: number
  /** 上一轮模型响应回报的真实 prompt input tokens(含 cache 命中/创建),用于精准触发压缩。 */
  lastInputTokens?: number
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
  if (block.type === 'image') return Math.min(block.source.data.length, 4096)
  // PDF 文档块:按 base64 长度封顶 4096(与 image 一致),别把整份 PDF base64 计进上下文估算;
  // 也避免落到下方 tool_use 分支的 block.name 访问(document 无 name 会抛错)。
  if (block.type === 'document') return Math.min(block.source.data.length, 4096)
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content.length
    // 多模态 tool_result:文本按字符、图像按 base64 长度封顶 4096(与上面 image 块一致),别把 base64 全算进上下文估算。
    return block.content.reduce((n, b) => n + (b.type === 'text' ? b.text.length : Math.min(b.source.data.length, 4096)), 0)
  }
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
    // 多模态 tool_result(块数组,含图像)不折叠:图像块不能当文本压;只压过长的纯文本只读结果(向后兼容)。
    if (typeof r.content !== 'string') continue
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

/**
 * 摘要请求超限重试专用:砍掉 old 段最旧的一半,并向前挪切点避免让剩余部分以孤儿 tool_result 开头。
 * 挪到没法再丢(只剩 1 条或挪不出进展)时返回 null,调用方据此放弃重试、直接失败降级。
 * 对齐 cc-haha compact.ts:243-291 truncateHeadForPTLRetry"丢最旧的一截、重试"的方向;
 * cc 按 API round 分组丢,本项目没有分组概念,退化为按消息数腰斩。
 */
function shrinkOldMessagesForRetry(old: Message[]): Message[] | null {
  if (old.length <= 1) return null
  let cut = Math.ceil(old.length / 2)
  while (cut > 0) {
    const rest = old.slice(cut)
    const restToolUses = new Set(rest.flatMap(toolUseIds))
    const first = rest[0]
    const orphanAtStart = first ? toolResultIds(first).some(id => !restToolUses.has(id)) : false
    if (!orphanAtStart) break
    cut--
  }
  if (cut <= 0) return null
  return old.slice(cut)
}

function thresholdFor(windowChars: number): number {
  return Math.max(windowChars - CONTEXT_OVERFLOW_RESERVE_CHARS, Math.floor(windowChars * AUTOCOMPACT_RATIO))
}

/**
 * 有效上下文窗口(token)= 窗口 − min(模型最大输出, 20k)。对齐 cc getEffectiveContextWindowSize
 * (autoCompact.ts:33-49)。CLAUDE_CODE_AUTO_COMPACT_WINDOW 为正整数时整体替换窗口(测试/覆盖用)。
 */
export function getEffectiveContextWindowTokens(contextWindowTokens: number, maxOutputTokens?: number): number {
  const reservedTokensForSummary = Math.min(maxOutputTokens ?? MAX_OUTPUT_TOKENS_FOR_SUMMARY, MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  let contextWindow = contextWindowTokens
  const override = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (override) {
    const parsed = parseInt(override, 10)
    if (!isNaN(parsed) && parsed > 0) contextWindow = parsed
  }
  return contextWindow - reservedTokensForSummary
}

/**
 * 自动压缩触发阈值(token)= 有效窗口 − 13k。对齐 cc getAutoCompactThreshold(autoCompact.ts:72-91)。
 * CLAUDE_AUTOCOMPACT_PCT_OVERRIDE(0<pct≤100)存在时,阈值取 min(floor(有效窗口*pct/100), 默认阈值)
 * —— 只会让压缩更早、绝不更晚。
 */
export function getAutoCompactTokenThreshold(contextWindowTokens: number, maxOutputTokens?: number): number {
  const effectiveContextWindow = getEffectiveContextWindowTokens(contextWindowTokens, maxOutputTokens)
  const autocompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(effectiveContextWindow * (parsed / 100))
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }
  return autocompactThreshold
}

function shouldAutocompact(input: CompactPipelineInput, failures: number): boolean {
  if (input.force) return true
  const cooldownMs = input.cooldownMs ?? AUTOCOMPACT_COOLDOWN_MS
  const lastAt = input.lastCompactionAtMs ?? 0
  if (lastAt > 0 && cooldownMs > 0 && (input.nowMs ?? Date.now()) - lastAt < cooldownMs) return false
  if (input.lastCompactedMessageCount && input.messages.length <= input.lastCompactedMessageCount) return false
  if (failures >= MAX_COMPACTION_FAILURES) return false
  // cc:有上一轮响应回报的真实 input tokens 就按 token 判(真实用量比字符估算准),与字符估算取"谁先超";
  // 首轮还没真实用量时退回字符估算。阈值 = 有效窗口 − 13k(cc getAutoCompactThreshold),而非旧的固定 0.7 比例。
  // 窗口来源:CLAUDE_CODE_AUTO_COMPACT_WINDOW 覆盖 > input.contextWindowTokens;两者都缺时不走 token 路径(避免负阈值误触发)。
  const envAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  const parsedEnvWindow = envAutoCompactWindow ? parseInt(envAutoCompactWindow, 10) : NaN
  const hasWindow = (!isNaN(parsedEnvWindow) && parsedEnvWindow > 0) || (!!input.contextWindowTokens && input.contextWindowTokens > 0)
  if (input.lastInputTokens && input.lastInputTokens > 0 && hasWindow) {
    if (input.lastInputTokens >= getAutoCompactTokenThreshold(input.contextWindowTokens ?? 0, input.maxOutputTokens)) return true
  }
  const contextWindowChars = input.contextWindowChars
  if (!contextWindowChars) return false
  return estimateMessagesChars(input.messages) >= thresholdFor(contextWindowChars)
}

/**
 * 只读预判:本次 compactPipeline 是否真的会执行压缩(供 harness 在压缩前触发 PreCompact 钩,
 * 对齐 cc "只在真压缩时发钩"的语义)。逻辑与 compactPipeline 开头的决策(microcompact →
 * shouldAutocompact → splitForAutocompact)完全一致、不复制阈值常量,避免行为漂移。
 *
 * 说明:内部会跑 microcompactReadOnlyToolResults —— 这与 compactPipeline 无条件在开头跑的那次是同一个
 * 幂等折叠(折过的短结果不会再折),等于把"每次调用 compactPipeline 都会发生"的那次 microcompact 提前一点,
 * 不改变任何压缩行为;随后 compactPipeline 再跑一次即 no-op。
 */
export function compactionWillRun(input: CompactPipelineInput): boolean {
  const failures = input.compactionFailures ?? 0
  microcompactReadOnlyToolResults(input.messages, input.readOnlyToolNames, input)
  if (!shouldAutocompact(input, failures)) return false
  return splitForAutocompact(input.messages, input) !== null
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
    // 摘要请求本身超限(prompt-too-long)时,逐步丢最旧一截重试,而不是一次失败就放弃整轮压缩。
    // 对齐 cc-haha compact.ts:481-523 的重试循环(遇 PROMPT_TOO_LONG 就 truncateHeadForPTLRetry 再试,最多 MAX_PTL_RETRIES 次)。
    let toSummarize = split.old
    let retryAttempts = 0
    let step: AssistantStep
    for (;;) {
      try {
        step = await input.model.step({
          system: COMPACTION_SYSTEM_PROMPT,
          messages: toSummarize,
          tools: [],
        })
        break
      } catch (err) {
        if (!looksLikeContextOverflow(err) || retryAttempts >= MAX_COMPACT_SUMMARY_RETRIES) throw err
        const shrunk = shrinkOldMessagesForRetry(toSummarize)
        if (!shrunk) throw err
        retryAttempts++
        toSummarize = shrunk
      }
    }

    // 模型没吐出任何文本(空响应/被截断成空)不能当压缩成功——那会把旧消息永久丢掉却只留一句占位摘要。
    // 对齐 cc-haha compact.ts:525-538:getAssistantMessageText 拿不到文本就直接 throw('no_summary'),
    // 交给外层 catch 走"保留原消息、失败计数+1"的降级路径,别静默吞掉。
    const summaryText = step.text
    if (!summaryText || !summaryText.trim()) {
      throw new Error('摘要模型未返回可用文本,压缩失败')
    }
    const summary = extractCompactionSummary(summaryText)
    const compacted: Message[] = [
      { role: 'user', content: [textBlock(`[此前对话摘要]\n${summary}`)] },
      ...(input.postSummaryMessages ?? []),
      ...split.recent,
    ]
    return {
      messages: compacted,
      didCompact: true,
      note:
        retryAttempts > 0
          ? `已压缩旧上下文: ${split.old.length} 条消息(摘要请求超限收缩重试 ${retryAttempts} 次,实际摘要 ${toSummarize.length} 条)→ 1 条摘要。`
          : `已压缩旧上下文: ${split.old.length} 条消息 → 1 条摘要。`,
      compactionFailures: 0,
    }
  } catch {
    // 摘要模型调用失败、重试耗尽或返回空文本:整轮压缩降级为"什么都不做",保留原始 messages 原样返回、
    // 只把失败计数 +1(由 shouldAutocompact 里的 MAX_COMPACTION_FAILURES 熔断,对齐 cc-haha
    // autoCompact.ts:70/262-265 的 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES 熔断器),不在这里硬截断历史。
    // cc 的失败路径同样是"这轮不压、下轮再试",没有额外的"保留最近 N 条硬截断"兜底——不自造。
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
