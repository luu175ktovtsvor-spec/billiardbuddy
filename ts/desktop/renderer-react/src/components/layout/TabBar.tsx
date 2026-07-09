// 标签栏(对齐 cc 自研 tab 路由的壳)。地基做最小:显示已开的会话 tab,可切换/关闭。
import { useTabStore } from '../../stores/tabStore'
import { openExistingConversation } from '../../lib/conversations'

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const closeTab = useTabStore((s) => s.closeTab)

  if (tabs.length <= 1) return null

  return (
    <div
      className="flex items-center gap-1 px-2 py-1.5"
      style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)' }}
      data-testid="tabbar"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-sm"
            style={{
              background: active ? 'var(--color-surface-selected)' : 'transparent',
              color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
            }}
          >
            <button
              type="button"
              className="max-w-[160px] truncate"
              onClick={() => {
                if (tab.conversationId) openExistingConversation(tab.conversationId, tab.title)
              }}
            >
              {tab.title}
            </button>
            <button type="button" onClick={() => closeTab(tab.id)} style={{ color: 'var(--color-text-tertiary)' }}>
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
