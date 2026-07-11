// 主区顶栏:左=对话标题、右=图标排[搜索/分享/历史/右侧工作区面板开关]。
// 右侧面板按钮 → filePreviewStore.togglePanel(照 Codex 顶右角「显示/隐藏面板」)。
import { useState, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { useUiStore } from '../../stores/uiStore'
import { DRAG, NODRAG } from '../../lib/dragRegion'
import { IconSearch, IconShareUp, IconClock, IconPanelRight, IconPanelLeft, IconTerminal } from '../shared/icons'
import { ShareModal } from '../chat/ShareModal'
import { t } from '../../i18n'

function IconBtn({ label, active, onClick, children }: { label: string; active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', background: active ? 'var(--color-surface-selected)' : undefined, ...NODRAG }}
    >
      {children}
    </button>
  )
}

export function TopBar() {
  const activeTab = useTabStore((s) => s.tabs.find((tb) => tb.id === s.activeTabId) ?? null)
  const panelOpen = useFilePreviewStore((s) => s.panelOpen)
  const togglePanel = useFilePreviewStore((s) => s.togglePanel)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const terminalOpen = useUiStore((s) => s.terminalOpen)
  const toggleTerminal = useUiStore((s) => s.toggleTerminal)
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  const nav = useUiStore((s) => s.nav)
  const [shareOpen, setShareOpen] = useState(false)

  // 标题随主视图:已安排/插件 显示区名,对话显示会话标题。
  const title = nav === 'scheduled' ? t('scheduled.title') : nav === 'plugins' ? t('plugins.title') : activeTab?.title || t('sidebar.newChat')
  const isChat = nav === 'chat'

  return (
    <>
      <header className={`flex h-14 shrink-0 items-center justify-between pr-6 ${collapsed ? 'pl-[80px]' : 'pl-6'}`} style={DRAG} data-testid="topbar">
        <div className="flex min-w-0 items-center gap-1" style={NODRAG}>
          {collapsed && <IconBtn label="展开侧栏" onClick={toggleSidebar}><IconPanelLeft size={18} /></IconBtn>}
          <span className="truncate text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>{title}</span>
        </div>
        {/* 对话专属操作(搜索/分享/历史/终端/面板)只在对话视图显示;已安排/插件页不挂。 */}
        {isChat && (
          <div className="flex items-center gap-0.5" style={NODRAG}>
            <IconBtn label={t('topbar.search')} onClick={() => setPaletteOpen(true)}><IconSearch size={18} /></IconBtn>
            <IconBtn label={t('topbar.share')} onClick={() => setShareOpen(true)}><IconShareUp size={18} /></IconBtn>
            <IconBtn label={t('topbar.history')} onClick={() => setPaletteOpen(true)}><IconClock size={18} /></IconBtn>
            <IconBtn label="终端(⌃`)" active={terminalOpen} onClick={toggleTerminal}><IconTerminal size={18} /></IconBtn>
            <IconBtn label={t('topbar.panel')} active={panelOpen} onClick={togglePanel}><IconPanelRight size={18} /></IconBtn>
          </div>
        )}
      </header>
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} title={activeTab?.title} />
    </>
  )
}
