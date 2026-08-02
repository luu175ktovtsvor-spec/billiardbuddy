import { type ReactNode } from 'react'
import {
  Bot,
  Clock,
  Image,
  Moon,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  Sun,
  Video,
} from 'lucide-react'
import { useUIStore, resolveEffectiveTheme } from '../../stores/uiStore'
import {
  IMAGE_WORKBENCH_TAB_ID,
  SCHEDULED_TAB_ID,
  SETTINGS_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  useTabStore,
  type OpenTabType,
} from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { Smiley } from '../shared/Smiley'
import { getDesktopHost } from '../../lib/desktopHost'

function ToolButton({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)]"
    >
      {children}
    </button>
  )
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className="flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ background: active ? 'var(--color-surface-selected)' : undefined }}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center"
        style={{ color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}
      >
        {icon}
      </span>
      <span className="flex-1 truncate text-[13.5px]">{label}</span>
    </button>
  )
}

/**
 * Product navigation deliberately has no ProductTask index or Run projection.
 * Agent history is Rust Thread history; image and video remain peer workbenches.
 */
export function DesktopSidebar() {
  const t = useTranslation()
  const activeTab = useTabStore((state) => state.tabs.find((tab) => tab.sessionId === state.activeTabId))
  const activeTabType = activeTab?.type ?? null
  const openNewNativeAgent = useTabStore((state) => state.openNewNativeAgent)
  const openTab = useTabStore((state) => state.openTab)
  const theme = useUIStore((state) => state.theme)
  const toggleTheme = useUIStore((state) => state.toggleTheme)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)
  const setActiveSettingsTab = useUIStore((state) => state.setActiveSettingsTab)
  const effectiveTheme = resolveEffectiveTheme(theme)
  const host = getDesktopHost()
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  const macTrafficLightPad = host.isDesktop && isMac

  const openTabView = (id: string, title: string, type: OpenTabType) => openTab(id, title, type)
  const openSettings = () => {
    setActiveSettingsTab('general')
    openTabView(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
  }

  return (
    <aside
      data-testid="sidebar"
      className="relative flex h-full w-full min-w-0 shrink-0 flex-col"
      style={{ background: 'var(--color-app-sidebar)', borderRight: '1px solid var(--color-border)' }}
    >
      <div
        data-desktop-drag-region
        className={`flex h-[46px] items-center justify-end px-2 ${macTrafficLightPad ? 'pl-[78px]' : ''}`}
      >
        <ToolButton label={t('sidebar.collapse')} onClick={toggleSidebar}><PanelLeft size={17} /></ToolButton>
      </div>

      <div className="flex items-center gap-2 px-3 pb-2 pt-0.5">
        <Smiley size={20} />
        <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">BilliardBuddy</span>
      </div>

      <nav className="px-2 pb-1" aria-label="产品导航">
        <NavItem icon={<Bot size={17} />} label="Agent" active={activeTabType === 'native-agent'} onClick={() => openNewNativeAgent()} />
        <NavItem icon={<Image size={17} />} label="图片创作" active={activeTabType === 'image-workbench'} onClick={() => openTabView(IMAGE_WORKBENCH_TAB_ID, '图片创作', 'image-workbench')} />
        <NavItem icon={<Video size={17} />} label="视频创作" active={activeTabType === 'video-studio'} onClick={() => openTabView(VIDEO_STUDIO_TAB_ID, '视频创作', 'video-studio')} />
        <NavItem icon={<Clock size={17} />} label={t('sidebar.scheduled')} active={activeTabType === 'scheduled'} onClick={() => openTabView(SCHEDULED_TAB_ID, t('sidebar.scheduled'), 'scheduled')} />
      </nav>

      <div className="min-h-0 flex-1 px-2 pt-4">
        <button
          type="button"
          onClick={() => openNewNativeAgent()}
          className="flex w-full items-center gap-2 rounded-lg bg-[var(--color-surface-selected)] px-3 py-2 text-left text-[13px] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <Plus size={16} className="text-[var(--color-brand)]" />
          新建 Agent 会话
        </button>
        <p className="px-2 pt-3 text-xs leading-5 text-[var(--color-text-tertiary)]">
          会话和执行记录仅保存在本机的 Rust Thread Store。
        </p>
      </div>

      <div className="flex items-center gap-1 px-2 py-2" style={{ borderTop: '1px solid var(--color-border)' }}>
        <button
          type="button"
          onClick={openSettings}
          aria-current={activeTabType === 'settings' ? 'page' : undefined}
          className="flex h-9 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ background: activeTabType === 'settings' ? 'var(--color-surface-selected)' : undefined }}
        >
          <span className="shrink-0 text-[var(--color-text-secondary)]"><SettingsIcon size={17} /></span>
          <span className="text-[13.5px]">{t('sidebar.settings')}</span>
        </button>
        <ToolButton label="切换主题" onClick={toggleTheme}>
          {effectiveTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </ToolButton>
      </div>
    </aside>
  )
}
