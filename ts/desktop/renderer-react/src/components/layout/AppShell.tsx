// AppShell(对齐 cc:bootstrap → 左 Sidebar | 右 main(TabBar + ContentRouter))。
// bootstrap 顺序:initializeDesktopServerUrl()(IPC 拿 sidecar 地址 + /health)→ 刷会话列表 → 开一个新会话。
import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ContentRouter } from './ContentRouter'
import { FilePreviewPanel } from '../workspace/FilePreviewPanel'
import { SettingsModal } from '../settings/SettingsModal'
import { Toaster } from '../shared/Toaster'
import { CommandPalette } from '../shared/CommandPalette'
import { TerminalPanel } from '../workspace/TerminalPanel'
import { initializeDesktopServerUrl } from '../../lib/desktopRuntime'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { openNewConversation, openExistingConversation } from '../../lib/conversations'
import { pickSessionToRestore, readLastConversation } from '../../lib/sessionRecovery'
import { isPreviewMode, applyPreviewSeed } from '../../lib/previewSeed'
import { getDesktopHost } from '../../lib/desktopHost'
import { pickWorkspaceFolder } from '../../lib/workspace'
import { t } from '../../i18n'

type Phase = 'connecting' | 'ready' | 'error'

export function AppShell() {
  const [phase, setPhase] = useState<Phase>(isPreviewMode() ? 'ready' : 'connecting')

  const [errorMsg, setErrorMsg] = useState('')
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const nav = useUiStore((s) => s.nav)
  const isChat = nav === 'chat'

  useEffect(() => {
    // 预览模式:跳过后端连接,注入示例数据后直接进 ready(仅 ?preview=1)。
    if (isPreviewMode()) {
      applyPreviewSeed()
      setPhase('ready')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        await initializeDesktopServerUrl()
        if (cancelled) return
        await useSessionStore.getState().refresh()
        if (cancelled) return
        // 会话自恢复:优先恢复上次活跃会话(带历史重放),没有可恢复的才开新会话。
        const sessions = useSessionStore.getState().sessions
        const restore = pickSessionToRestore(sessions, readLastConversation())
        if (restore) openExistingConversation(restore.id, restore.title)
        else openNewConversation()
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

  // 全局快捷键:⌘B 开合侧栏 · ⌘\ 开合右侧工作区面板(照 Codex 键盘习惯)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); useUiStore.getState().toggleSidebar() }
      else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); useUiStore.getState().setPaletteOpen(true) }
      else if (e.key === '\\') { e.preventDefault(); useFilePreviewStore.getState().togglePanel() }
      else if (e.key === '`') { e.preventDefault(); useUiStore.getState().toggleTerminal() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 原生菜单动作:「文件 → 选择工作区…」发 'pick-workspace' → 弹文件夹选择器(不接就是死菜单)。
  useEffect(() => {
    getDesktopHost().onMenu?.((action) => {
      if (action === 'pick-workspace') void pickWorkspaceFolder()
    })
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
      {!sidebarCollapsed && <Sidebar />}
      {/* 右侧竖排:上 = 对话 | 右面板(横排),下 = 终端抽屉(全宽,照 Codex 终端在底部)。 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app-main)' }}>
            <TopBar />
            <ContentRouter />
          </main>
          {/* 右侧工作区面板(文件展示 + 工作树)——仅对话视图,由 filePreviewStore.panelOpen 控制。 */}
          {isChat && <FilePreviewPanel />}
        </div>
        {/* 底部终端抽屉(照 Codex:终端在底部、全宽)——仅对话视图,由 uiStore.terminalOpen 控制。 */}
        {isChat && <TerminalPanel />}
      </div>
      {/* 设置弹窗(左栏「设置」按钮触发) */}
      <SettingsModal />
      {/* 命令面板(⌘K / 顶栏搜索/历史) */}
      <CommandPalette />
      {/* 全局 toast(操作反馈) */}
      <Toaster />
    </div>
  )
}
