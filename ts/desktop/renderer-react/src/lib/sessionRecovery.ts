// 会话自恢复:崩溃/重启后不丢用户上下文。记住"上次活跃会话"的 id(localStorage),启动时优先恢复它;
// 不在列表里(比如从没发过消息、没落盘)就回退到最近更新的一条;都没有才开新会话。
import type { SessionSummary } from '../types/chat'

const LAST_KEY = 'qf.desktop.lastConversationId'

/** 记住当前活跃会话(打开/新建/切换会话时调)。 */
export function rememberLastConversation(id: string): void {
  try {
    window?.localStorage?.setItem(LAST_KEY, id)
  } catch {
    // localStorage 不可用(隐私模式/禁用):忽略,恢复退化为"最近一条"。
  }
}

/** 读回上次活跃会话 id(没有则 null)。 */
export function readLastConversation(): string | null {
  try {
    return window?.localStorage?.getItem(LAST_KEY) ?? null
  } catch {
    return null
  }
}

/** 决定启动时恢复哪个会话:上次活跃(仍在列表)→ 最近更新的一条 → null(都没有,开新会话)。
 *  入参 sessions 约定已按 updatedAt 降序(后端 /sessions 保证),故最近一条 = sessions[0]。 */
export function pickSessionToRestore(
  sessions: SessionSummary[] | undefined | null,
  lastId: string | null,
): SessionSummary | null {
  if (!sessions || sessions.length === 0) return null
  if (lastId) {
    const found = sessions.find((s) => s.id === lastId)
    if (found) return found
  }
  return sessions[0] ?? null
}
