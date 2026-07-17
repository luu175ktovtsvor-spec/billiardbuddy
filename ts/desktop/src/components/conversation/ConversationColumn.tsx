import { useEffect } from 'react'
import { MessageList } from '../chat/MessageList'
import { ChatInput } from '../chat/ChatInput'
import { SessionTaskBar } from '../chat/SessionTaskBar'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * 栏2 · 会话流 + Composer（Codex 四栏）。复用现有 chat 叶子（MessageList/ChatInput/SessionTaskBar），
 * 只接现有 chatStore（WS 生命线）+ tabStore（数据零改）。
 *
 * 注意（施工图 R6）：ChatInput 内部认 tabStore.activeTabId（不吃 sessionId prop），
 * 所以挂载即 openTab+setActiveTab(sessionId) 让 Composer 对准本会话，并 connectToSession 建 WS。
 * 切壳阶段（Phase C）由新导航统一管 tabStore 活动会话，这里的协调随之收归。
 */
export function ConversationColumn({ sessionId }: { sessionId: string }) {
  const connectToSession = useChatStore((s) => s.connectToSession)
  const openTab = useTabStore((s) => s.openTab)
  const setActiveTab = useTabStore((s) => s.setActiveTab)
  const title = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.title) ?? '会话'

  useEffect(() => {
    if (!sessionId) return
    openTab(sessionId, title, 'session')
    setActiveTab(sessionId)
    connectToSession(sessionId)
    // title 变化不重连；仅 sessionId 驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, openTab, setActiveTab, connectToSession])

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      {/* 会话头（标题）——Codex 主工具条高度 */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4"
        style={{ height: 'var(--h-toolbar)' }}
      >
        <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold leading-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
          {title}
        </h1>
      </div>

      {/* 会话流 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <MessageList sessionId={sessionId} />
      </div>

      {/* 任务条 + Composer */}
      <SessionTaskBar />
      <ChatInput variant="default" />
    </div>
  )
}
