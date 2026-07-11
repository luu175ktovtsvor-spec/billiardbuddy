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
import { initializeDesktopServerUrl } from '../../lib/desktopRuntime'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { useChatStore } from '../../stores/chatStore'
import { openNewConversation, openExistingConversation } from '../../lib/conversations'
import { pickSessionToRestore, readLastConversation } from '../../lib/sessionRecovery'
import { isPreviewMode, applyPreviewSeed } from '../../lib/previewSeed'
import { getDesktopHost } from '../../lib/desktopHost'
import { pickWorkspaceFolder } from '../../lib/workspace'
import { t } from '../../i18n'

type Phase = 'connecting' | 'ready' | 'error'

// 可能改动工作目录文件的工具:完成后触发右侧工作区自动刷新(编辑类 + 跑命令,shell 命令也可能写文件)。
const MUTATING_TOOLS = new Set([
  'edit_file', 'multi_edit_file', 'write_file', 'patch_file', 'patch_files', 'edit_excel',
  'run_command', 'run_command_background',
])

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

  // 工具改文件后自动刷新右侧工作区(文件树 + git 计数),对齐 Codex「改动实时反映到右栏」:
  // 此前 loadWorkspace 只手动触发,agent 改完文件右侧不动。订阅 chatStore 里"已完成的改文件类工具"计数,
  // 增长即防抖重载(仅面板开着时,省流量);会话切换 blocks 清空 → 计数回落自动复位,不误触。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0
    const unsub = useChatStore.subscribe((state) => {
      let n = 0
      for (const b of state.blocks) if (b.kind === 'tool' && b.status === 'ok' && MUTATING_TOOLS.has(b.tool)) n++
      if (n > last && useFilePreviewStore.getState().panelOpen) {
        clearTimeout(timer)
        timer = setTimeout(() => useFilePreviewStore.getState().loadWorkspace(), 400)
      }
      last = n
    })
    return () => { unsub(); clearTimeout(timer) }
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
        {/* 终端 UI 已下架(asar 核实 Codex 终端 = 右面板 tab + xterm.js/node-pty 真交互终端,管手动命令与后台进程;
            AI 一次性命令的过程只在对话流内联显示,不灌终端)。真交互终端落地前不挂任何终端 UI,免得点开是个假的。 */}
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
