import { useEffect } from 'react'
import { Smiley } from '../shared/Smiley'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * 栏1 · 项目/任务导航 rail（Codex 四栏）。消费现有 sessionStore（数据零改）。
 * 选中会话 → onSelectSession(id)，由外层把该会话喂给栏2/3/4（跨栏联动源）。
 *
 * 精简版:品牌 + 新建会话 + 会话列表 + 设置 footer。项目分组/72px rail 折叠/搜索为后续增强
 * （施工图 R8），先落最小可用导航。
 */
export function RailNav({
  activeSessionId,
  onSelectSession,
}: {
  activeSessionId: string | null
  onSelectSession: (id: string) => void
}) {
  const sessions = useSessionStore((s) => s.sessions)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const createSession = useSessionStore((s) => s.createSession)

  useEffect(() => {
    void fetchSessions()
  }, [fetchSessions])

  const handleNew = async () => {
    try {
      const id = await createSession()
      onSelectSession(id)
    } catch {
      /* 创建失败 → 忽略(无 provider 时后端可能拒) */
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 品牌 */}
      <div className="flex shrink-0 items-center gap-2.5 px-3" style={{ height: 'var(--h-toolbar)' }}>
        <Smiley size={28} className="shrink-0" />
        <span className="truncate text-[13px] font-semibold tracking-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
          Billiard<span className="text-[var(--color-primary)]">Buddy</span>
        </span>
      </div>

      {/* 新建会话 */}
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={handleNew}
          className="flex w-full items-center gap-2 rounded-[var(--radius-md)] bg-[var(--gradient-btn-primary,var(--color-primary))] px-3 text-left text-[13px] font-medium text-[var(--color-btn-primary-fg,#fff)] transition-opacity hover:opacity-90"
          style={{ height: 'var(--h-nav-row)', background: 'var(--color-primary)' }}
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          新建会话
        </button>
      </div>

      {/* 会话列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="px-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">会话</div>
        {sessions.length === 0 ? (
          <p className="px-1 py-2 text-xs text-[var(--color-text-tertiary)]">暂无会话</p>
        ) : (
          sessions.map((s) => {
            const active = s.id === activeSessionId
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelectSession(s.id)}
                title={s.title || '未命名会话'}
                className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] transition-colors ${
                  active
                    ? 'bg-[var(--color-sidebar-item-active)] text-[var(--color-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                }`}
                style={{ height: 'var(--h-nav-row)' }}
              >
                <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)]">chat_bubble</span>
                <span className="truncate">{s.title || '未命名会话'}</span>
              </button>
            )
          })
        )}
      </div>

      {/* footer */}
      <div className="shrink-0 border-t border-[var(--color-border)] px-2 py-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ height: 'var(--h-nav-row)' }}
        >
          <span className="material-symbols-outlined text-[16px]">settings</span>
          设置
        </button>
      </div>
    </div>
  )
}
