import { AppShell } from './components/layout/AppShell'
import { StartupErrorView } from './components/layout/StartupErrorView'
import { ToastContainer } from './components/shared/Toast'
import { useScheduledTaskDesktopNotifications } from './hooks/useScheduledTaskDesktopNotifications'
import { installDesktopNotificationNavigation } from './lib/desktopNotificationNavigation'
import { getDesktopHost } from './lib/desktopHost'
import { initializeDesktopServerUrl } from './lib/desktopRuntime'
import { useSettingsStore } from './stores/settingsStore'
import { ProductTaskPage } from './product/components/ProductTaskPage'
import { parseProductTaskWindowSearch } from '../../shared/product/taskLinks'
import { useEffect, useState } from 'react'
import { RemoteDataEgressConsentGate } from './product/components/RemoteDataEgressConsent'

function MainApp() {
  useScheduledTaskDesktopNotifications()
  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false
    installDesktopNotificationNavigation()
      .then((fn) => {
        if (cancelled) {
          fn()
        } else {
          cleanup = fn
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])
  return <AppShell />
}

function ProductTaskWindowApp({ initialTaskId }: { initialTaskId: string }) {
  const fetchSettings = useSettingsStore((state) => state.fetchAll)
  const [taskId, setTaskId] = useState(initialTaskId)
  const [ready, setReady] = useState(false)
  const [startupFailed, setStartupFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await initializeDesktopServerUrl()
        await fetchSettings()
        if (!cancelled) setReady(true)
      } catch {
        if (!cancelled) setStartupFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [fetchSettings])

  const closeWindow = () => {
    const host = getDesktopHost()
    if (host.capabilities.windowControls) {
      void host.window.close().catch(() => undefined)
    }
  }

  if (startupFailed) {
    return <StartupErrorView error="独立任务窗口暂时无法启动，请关闭后重试。" />
  }

  if (!ready) {
    return (
      <div className="app-shell-viewport flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
        正在打开任务…
      </div>
    )
  }

  return (
    <div className="app-shell app-shell-viewport flex flex-col overflow-hidden bg-[var(--color-surface)]" data-testid="product-task-window">
      <div data-desktop-drag-region className="flex h-[46px] shrink-0 items-center px-3 text-xs text-[var(--color-text-tertiary)]">
        BilliardBuddy · 独立任务
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ProductTaskPage
          key={taskId}
          taskId={taskId}
          onReturnToTaskIndex={closeWindow}
          onOpenTask={(task) => setTaskId(task.id)}
        />
      </div>
      <ToastContainer />
      <RemoteDataEgressConsentGate />
    </div>
  )
}

function currentProductTaskWindowId(): string | null {
  if (typeof window === 'undefined') return null
  return parseProductTaskWindowSearch(window.location.search)
}

export function App() {
  const taskId = currentProductTaskWindowId()
  return taskId ? <ProductTaskWindowApp initialTaskId={taskId} /> : <MainApp />
}
