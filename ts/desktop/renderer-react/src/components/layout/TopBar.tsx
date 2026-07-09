// 主区顶栏(对标真机 WorkBuddy .claw-agent-chat-topbar:高 56px、padding 0 24px、drag 区、
// 左=对话标题、右=图标排[搜索/分享导出/历史/预览面板])。真机 mac 左内边距 87px 留红绿灯,
// 但左栏已占红绿灯位,这里主区不需再留;高度/内边距/图标排对齐真机。
import type { ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { DRAG, NODRAG } from '../../lib/dragRegion'
import { IconSearch, IconShareUp, IconClock, IconPanelRight } from '../shared/icons'
import { t } from '../../i18n'

function IconBtn({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-secondary)', ...NODRAG }}
    >
      {children}
    </button>
  )
}

export function TopBar() {
  const activeTab = useTabStore((s) => s.tabs.find((tb) => tb.id === s.activeTabId) ?? null)
  const title = activeTab?.title || t('sidebar.newChat')

  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between px-6"
      style={DRAG}
      data-testid="topbar"
    >
      <div className="flex min-w-0 items-center" style={NODRAG}>
        <span className="truncate text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>{title}</span>
      </div>
      <div className="flex items-center gap-0.5" style={NODRAG}>
        <IconBtn label={t('topbar.search')}><IconSearch size={18} /></IconBtn>
        <IconBtn label={t('topbar.share')}><IconShareUp size={18} /></IconBtn>
        <IconBtn label={t('topbar.history')}><IconClock size={18} /></IconBtn>
        <IconBtn label={t('topbar.panel')}><IconPanelRight size={18} /></IconBtn>
      </div>
    </header>
  )
}
