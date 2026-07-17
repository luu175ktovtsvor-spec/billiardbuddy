import { AppShell } from './components/layout/AppShell'
import { WorkspaceLayout } from './components/shell/WorkspaceLayout'
import { FileTreeColumn } from './components/filetree/FileTreeColumn'
import { WorkspaceColumn } from './components/workspace3/WorkspaceColumn'
import { ConversationColumn } from './components/conversation/ConversationColumn'
import { RailNav } from './components/shell/RailNav'
import { BottomTerminalDock } from './components/shell/BottomTerminalDock'
import { useSessionStore } from './stores/sessionStore'
import { useScheduledTaskDesktopNotifications } from './hooks/useScheduledTaskDesktopNotifications'
import { installDesktopNotificationNavigation } from './lib/desktopNotificationNavigation'
import { useEffect, useState } from 'react'

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

// 临时四栏预览：栏1 RailNav 选会话 → 驱动栏2/3/4（Phase C 接真壳后移除）。
function WorkspaceLayoutPreview({ initialSession }: { initialSession: string }) {
  const [session, setSession] = useState(initialSession)
  const workDir = useSessionStore((s) => s.sessions.find((x) => x.id === session)?.workDir ?? undefined)
  return (
    <WorkspaceLayout
      rail={<RailNav activeSessionId={session || null} onSelectSession={setSession} />}
      conversation={session ? <ConversationColumn sessionId={session} /> : <PlaceholderColumn label="栏2 · 选个会话" />}
      workspace={session ? <WorkspaceColumn sessionId={session} /> : <PlaceholderColumn label="栏3 · 审阅/Diff/预览" />}
      fileTree={session ? <FileTreeColumn sessionId={session} /> : <PlaceholderColumn label="栏4 · 文件树" />}
      terminal={session ? <BottomTerminalDock sessionId={session} cwd={workDir ?? undefined} /> : undefined}
    />
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
    return <WorkspaceLayoutPreview initialSession={previewSession} />
  }
  return <AppShell />
}
