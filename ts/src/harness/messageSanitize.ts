import type { Message } from '../types/message'

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

/** resume 前统一清洗:去未配对 tool_use → 去孤儿 thinking → 去空白 assistant。 */
export function sanitizeResumeMessages(messages: Message[]): Message[] {
  return filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUseMessages(messages),
    ),
  )
}
