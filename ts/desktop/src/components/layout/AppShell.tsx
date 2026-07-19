import { useEffect, useState } from 'react'
import { DesktopSidebar } from './DesktopSidebar'
import { ContentRouter } from './ContentRouter'
import { TopBar } from './TopBar'
import { StartupErrorView } from './StartupErrorView'
import { ToastContainer } from '../shared/Toast'
import { UpdateChecker } from '../shared/UpdateChecker'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore, type SettingsTab } from '../../stores/uiStore'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useElectronWindowDragRegions } from '../../hooks/useElectronWindowDragRegions'
import { initializeDesktopServerUrl } from '../../lib/desktopRuntime'
import { getDesktopHost } from '../../lib/desktopHost'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { TaskSearchModal } from '../../product/components/TaskSearchModal'

/**
 * The only delivered application frame: BilliardBuddy's desktop task shell.
 */
export function AppShell() {
  const fetchSettings = useSettingsStore((state) => state.fetchAll)
  const sidebarOpen = useUIStore((state) => state.sidebarOpen)
  const activeModal = useUIStore((state) => state.activeModal)
  const closeModal = useUIStore((state) => state.closeModal)
  const [ready, setReady] = useState(false)
  const [startupError, setStartupError] = useState<string | null>(null)
  const t = useTranslation()

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      if (!cancelled) {
        setReady(false)
        setStartupError(null)
      }

      try {
        await initializeDesktopServerUrl()
        await fetchSettings()

        if (!cancelled) setReady(true)

        void useTabStore.getState().restoreTabs().catch(() => {})
      } catch (error) {
        if (!cancelled) {
          setStartupError(error instanceof Error ? error.message : String(error))
          setReady(false)
        }
      }
    }

    void bootstrap()
    return () => { cancelled = true }
  }, [fetchSettings])

  useEffect(() => {
    const host = getDesktopHost()
    if (!host.isDesktop) return

    let unlisten: (() => void) | undefined
    host.window.onNativeMenuNavigate((target) => {
      const destination = target as SettingsTab | 'settings'
      if (destination === 'about') {
        useUIStore.getState().setPendingSettingsTab('about')
      }
      useTabStore.getState().openTab(SETTINGS_TAB_ID, 'Settings', 'settings')
    })
      .then((cleanup) => { unlisten = cleanup })
      .catch(() => {})

    return () => { unlisten?.() }
  }, [])

  useKeyboardShortcuts()
  useElectronWindowDragRegions()

  if (startupError) return <StartupErrorView error={startupError} />

  if (!ready) {
    return (
      <div className="app-shell-viewport flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
        {t('app.launching')}
      </div>
    )
  }

  return (
    <div className="app-shell app-shell-viewport flex overflow-hidden bg-[var(--color-surface)]">
      <div
        id="sidebar-shell"
        data-testid="sidebar-shell"
        data-state={sidebarOpen ? 'open' : 'closed'}
        className="sidebar-shell"
      >
        {sidebarOpen ? <DesktopSidebar /> : null}
      </div>
      <main
        id="content-area"
        data-sidebar-state={sidebarOpen ? 'open' : 'closed'}
        className="min-w-0 flex flex-1 flex-col overflow-hidden"
      >
        <TopBar />
        <ContentRouter />
      </main>
      <ToastContainer />
      <UpdateChecker />
      <TaskSearchModal open={activeModal === 'task-search'} onClose={closeModal} />
    </div>
  )
}
