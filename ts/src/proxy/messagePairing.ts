/**
 * 消息配对清洗(不崩·核心):发送模型前保证 tool_use/tool_result 成对,
 * 适配我方扁平 {role, content: ContentBlock[]}。不清洗则国产模型上循环隔三差五 400 卡死(05 清单①)。
 */
import { textBlock, type Message, type ContentBlock, type ToolResultBlock } from '../types/message'

export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER = '[Tool result missing due to internal error]'
export const NO_CONTENT_PLACEHOLDER = '[No content]'

/** 合并连续同角色消息的 content 数组、丢掉 content 全空的消息。 */
export function normalizeMessagesForAPI(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const msg of messages) {
    if (msg.content.length === 0) continue
    const prev = out.at(-1)
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content]
    } else if (msg.role === 'user') {
      out.push({ role: 'user', content: [...msg.content] })
    } else {
      out.push({ role: 'assistant', content: [...msg.content] })
    }
  }
  return out
}

function isToolResult(b: ContentBlock): b is ToolResultBlock {
  return b.type === 'tool_result'
}

/**
 * 补孤儿 tool_use(forward:合成 is_error 占位)+ 删孤儿 tool_result(reverse)+ 去重 tool_use/tool_result id。
 * 假设已先跑过 normalizeMessagesForAPI(连续同角色已合并)。
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  const result: Message[] = []
  const seenToolUseIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.role !== 'assistant') {
      // 前面不是 assistant 的 user 里若有 tool_result,是孤儿 → 删。
      if (result.at(-1)?.role !== 'assistant') {
        const stripped = msg.content.filter((b) => !isToolResult(b))
        if (stripped.length !== msg.content.length) {
          if (stripped.length > 0) {
            result.push({ role: 'user', content: stripped })
          } else if (result.length === 0) {
            // 清空后正好是数组最前一条 → 占位保持以 user 开头,否则直接以 assistant 开头 → 角色翻转 400。
            result.push({ role: 'user', content: [textBlock('[Orphaned tool result removed]')] })
          }
          continue
        }
      }
      result.push(msg)
      continue
    }

    // assistant:去重 tool_use id(跨消息)。
    const keptContent: ContentBlock[] = []
    const thisToolUseIds: string[] = []
    for (const b of msg.content) {
      if (b.type === 'tool_use') {
        if (seenToolUseIds.has(b.id)) continue // 重复 → 删
        seenToolUseIds.add(b.id)
        thisToolUseIds.push(b.id)
      }
      keptContent.push(b)
    }
    if (keptContent.length === 0) keptContent.push({ type: 'text', text: '[Tool use interrupted]' })
    result.push({ role: 'assistant', content: keptContent })

    // 不管本轮 tool_use 是否为空(文字轮/全被跨轮去重删空),都要看下一条 user 有没有孤儿/重复 tool_result 待清——
    // 否则复用 id 被去重删掉的那个 tool_use,其旧 tool_result 会原样滞留、变成指向"本轮不存在的 tool_use"的孤儿。
    const toolUseIdSet = new Set(thisToolUseIds)

    // 看下一条 user 的 tool_result:去重 + 删孤儿(toolUseIdSet 为空时全删)+ 找缺失。
    const next = messages[i + 1]
    const existingResultIds = new Set<string>()
    let cleaned: ContentBlock[] | null = null

    if (next && next.role === 'user') {
      const seenTr = new Set<string>()
      cleaned = next.content.filter((b) => {
        if (!isToolResult(b)) return true
        if (!toolUseIdSet.has(b.tool_use_id)) return false // 孤儿(指向别的/不存在/本轮没有的 tool_use)→ 删
        if (seenTr.has(b.tool_use_id)) return false // 重复 tool_result → 删后者
        seenTr.add(b.tool_use_id)
        existingResultIds.add(b.tool_use_id)
        return true
      })
    }

    const missing = thisToolUseIds.filter((id) => !existingResultIds.has(id))
    const synth: ToolResultBlock[] = missing.map((id) => ({
      type: 'tool_result', tool_use_id: id, content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER, is_error: true,
    }))

    if (cleaned !== null) {
      const merged = [...synth, ...cleaned]
      if (merged.length > 0) {
        result.push({ role: 'user', content: merged })
      } else {
        // 清洗后整条 user 被删空(孤儿/重复占了全部)→ 占位保持 user/assistant 交替,
        // 否则下一条 assistant 紧邻本 assistant → 角色翻转 400。
        result.push({ role: 'user', content: [textBlock(NO_CONTENT_PLACEHOLDER)] })
      }
      i++ // 已消费 next
    } else if (synth.length > 0) {
      // 后面没有 user 消息 → 插一条合成 user 承接(保角色交替)。
      result.push({ role: 'user', content: synth })
    }
  }

  return result
}
