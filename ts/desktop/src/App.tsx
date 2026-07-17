import { AppShell } from './components/layout/AppShell'
import { WorkspaceLayout } from './components/shell/WorkspaceLayout'
import { FileTreeColumn } from './components/filetree/FileTreeColumn'
import { WorkspaceColumn } from './components/workspace3/WorkspaceColumn'
import { useScheduledTaskDesktopNotifications } from './hooks/useScheduledTaskDesktopNotifications'
import { installDesktopNotificationNavigation } from './lib/desktopNotificationNavigation'
import { useEffect } from 'react'

// 临时开发预览：?preview=layout 渲染四栏骨架占位（Phase A2 验证 grid，Phase C 接真栏后移除）。
function isLayoutPreview(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('preview') === 'layout'
  } catch {
    return false
  }
}

function PlaceholderColumn({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-sm font-medium text-[var(--color-text-tertiary)]">
      {label}
    </div>
  )
}

export function App() {
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
  if (isLayoutPreview()) {
    const previewSession = new URLSearchParams(window.location.search).get('session') ?? ''
    return (
      <WorkspaceLayout
        rail={<PlaceholderColumn label="栏1 · 导航 rail" />}
        conversation={<PlaceholderColumn label="栏2 · 会话流 + Composer" />}
        workspace={previewSession ? <WorkspaceColumn sessionId={previewSession} /> : <PlaceholderColumn label="栏3 · 审阅/Diff/预览" />}
        fileTree={previewSession ? <FileTreeColumn sessionId={previewSession} /> : <PlaceholderColumn label="栏4 · 文件树(缺 ?session=)" />}
        terminal={<PlaceholderColumn label="底部 · 终端(横跨栏2–4)" />}
      />
    )
  }
  return <AppShell />
}
