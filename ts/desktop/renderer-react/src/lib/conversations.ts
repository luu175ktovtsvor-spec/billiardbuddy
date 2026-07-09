// 会话开合的编排小助手(把 tabStore + chatStore 串起来,避免组件里到处 prop 传递)。
import { useChatStore } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { rememberLastConversation } from './sessionRecovery'

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 开一个全新会话(新 conversationId + 新 tab + 起 WS)。 */
export function openNewConversation(): string {
  const id = genId()
  useTabStore.getState().openSession(id, '新对话')
  useChatStore.getState().startConversation(id)
  rememberLastConversation(id) // 记为"上次活跃",下次启动可恢复
  return id
}

/** 打开已有会话:开/聚焦 tab + 起 WS 并请求历史事件重放。 */
export function openExistingConversation(id: string, title?: string): void {
  useTabStore.getState().openSession(id, title)
  useChatStore.getState().startConversation(id, { replay: true })
  rememberLastConversation(id) // 记为"上次活跃",下次启动可恢复
}
