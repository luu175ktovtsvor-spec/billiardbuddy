// AppShell(对齐 cc:bootstrap → 左 Sidebar | 右 main(TabBar + ContentRouter))。
// bootstrap 顺序:initializeDesktopServerUrl()(IPC 拿 sidecar 地址 + /health)→ 刷会话列表 → 开一个新会话。
import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { TabBar } from './TabBar'
import { ContentRouter } from './ContentRouter'
import { initializeDesktopServerUrl } from '../../lib/desktopRuntime'
import { useSessionStore } from '../../stores/sessionStore'
import { openNewConversation } from '../../lib/conversations'
import { t } from '../../i18n'

type Phase = 'connecting' | 'ready' | 'error'

export function AppShell() {
  const [phase, setPhase] = useState<Phase>('connecting')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await initializeDesktopServerUrl()
        if (cancelled) return
        await useSessionStore.getState().refresh()
        if (cancelled) return
        openNewConversation()
        setPhase('ready')
      } catch (err) {
        if (cancelled) return
        setErrorMsg(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (phase === 'connecting') {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--color-text-tertiary)' }} data-testid="boot-connecting">
        {t('chat.connecting')}
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-8" data-testid="boot-error">
        <div className="max-w-[600px]">
          <h1 className="mb-2 text-lg font-semibold" style={{ color: 'var(--color-text-primary)' }}>后端没连上</h1>
          <p className="mb-3 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            请确认后端服务已启动。反馈时附上下面这段。
          </p>
          <pre className="whitespace-pre-wrap rounded-lg p-3 text-xs" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
            {errorMsg}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full" data-testid="app-shell">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-background)' }}>
        <TabBar />
        <ContentRouter />
      </main>
    </div>
  )
}
