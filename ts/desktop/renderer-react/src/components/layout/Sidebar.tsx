// 侧栏(地基只做壳:新对话 + 会话列表 + 主题切换)。Block D 会补富内容(项目视图/任务条/详情/搜索)。
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { openNewConversation, openExistingConversation } from '../../lib/conversations'
import { t } from '../../i18n'

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions)
  const refresh = useSessionStore((s) => s.refresh)
  const activeId = useChatStore((s) => s.conversationId)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const effective = useUiStore((s) => s.effectiveTheme)

  return (
    <aside
      className="flex h-full w-64 shrink-0 flex-col"
      style={{ background: 'var(--color-surface-sidebar)', borderRight: '1px solid var(--color-border)', backdropFilter: 'blur(12px)' }}
      data-testid="sidebar"
    >
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>{t('app.name')}</span>
        <button
          type="button"
          onClick={toggleTheme}
          className="rounded-md px-2 py-1 text-xs"
          style={{ color: 'var(--color-text-tertiary)' }}
          title="切换主题"
        >
          {effective === 'dark' ? '🌙' : '☀️'}
        </button>
      </div>
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => openNewConversation()}
          className="w-full rounded-lg px-3 py-2 text-left text-sm font-medium"
          style={{ background: 'var(--color-surface-glass)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
          data-testid="new-chat"
        >
          + {t('sidebar.newChat')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {sessions.length === 0 ? (
          <div className="px-2 py-3 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{t('sidebar.empty')}</div>
        ) : (
          sessions.map((s) => {
            const active = s.id === activeId
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  openExistingConversation(s.id, s.title)
                  void refresh()
                }}
                className="mb-0.5 w-full rounded-lg px-2 py-1.5 text-left"
                style={{ background: active ? 'var(--color-surface-selected)' : 'transparent' }}
              >
                <div className="truncate text-sm" style={{ color: 'var(--color-text-primary)' }}>{s.title || '新对话'}</div>
                <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{fmtTime(s.updatedAt)}</div>
              </button>
            )
          })
        )}
      </div>
    </aside>
  )
}
