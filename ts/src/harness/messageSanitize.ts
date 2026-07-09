import type { Message } from '../types/message'
import { ensureToolResultPairing, normalizeMessagesForAPI } from '../proxy/messagePairing'

/**
 * resume/续接时清洗 transcript 残尾:上一轮被中断/异常留下的"孤儿"消息若直接喂回模型会破坏配对
 * (未配对 tool_use 会被 Anthropic API 拒、纯 thinking/空白 assistant 无意义)。三处共用:主会话 resume、
 * 后台代理 resume、agent 摘要。
 */

/** 去掉"整条都是未配对 tool_use"的 assistant 消息(有对应 tool_result 的保留)。 */
export function filterUnresolvedToolUseMessages(messages: Message[]): Message[] {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id)
    }
  }
  const unresolved = new Set([...toolUseIds].filter(id => !toolResultIds.has(id)))
  if (unresolved.size === 0) return messages
  return messages.filter(message => {
    if (message.role !== 'assistant') return true
    const toolUseBlockIds = message.content
      .filter(block => block.type === 'tool_use')
      .map(block => block.id)
    if (toolUseBlockIds.length === 0) return true
    return !toolUseBlockIds.every(id => unresolved.has(id))
  })
}

/** 去掉整条只有空白文本的 assistant 消息。 */
export function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  return messages.filter(message => {
    if (message.role !== 'assistant' || message.content.length === 0) return true
    return !message.content.every(block => block.type === 'text' && !block.text.trim())
  })
}

/** 去掉整条只有 thinking 块的 assistant 消息(孤儿思考)。 */
export function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  return messages.filter(message => {
    if (message.role !== 'assistant' || message.content.length === 0) return true
    return !message.content.every(block => block.type === 'thinking')
  })
}

/**
 * resume 前统一清洗 → 再修复配对(不只丢、还补):
 *  ① 整条丢:全部 tool_use 未配对的 assistant(对齐 cc filterUnresolvedToolUses——整条 orphan 是被中断的
 *     无用轮,连 text 一起丢)、孤儿 thinking、空白 assistant。
 *  ② 修复剩下的细活(对齐 cc:请求前 normalizeMessagesForAPI + ensureToolResultPairing;这里 resume 预修一遍,
 *     防国产/OpenAI 兼容端点在 resume 那一刻就 400):
 *     - 混合轮(同一 assistant 里部分 tool_use 有结果、部分没有)给缺结果的补 is_error 占位 tool_result,
 *       而不是把有结果的那半也丢掉;
 *     - 开头/中途孤儿 tool_result(没有前置 tool_use)剥掉,避免角色翻转/悬空 result;
 *     - 跨消息重复 tool_use / 重复 tool_result id 去重。
 *     复用 src/proxy/messagePairing.ts,不重复造轮子;normalizeMessagesForAPI 先合并连续同角色(pairing 的前置假设)。
 * 幂等:与请求前那趟 ensureToolResultPairing 叠跑无副作用(已配对不会再补)。
 */
export function sanitizeResumeMessages(messages: Message[]): Message[] {
  const filtered = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUseMessages(messages),
    ),
  )
  return ensureToolResultPairing(normalizeMessagesForAPI(filtered))
}
