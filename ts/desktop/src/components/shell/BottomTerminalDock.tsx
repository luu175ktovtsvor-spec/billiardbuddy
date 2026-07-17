import { TerminalSettings } from '../../pages/TerminalSettings'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'

/**
 * 底部 · 横跨栏2–4 的终端 dock（Codex 四栏）。复用现有 pages/TerminalSettings(docked) +
 * terminalPanelStore（数据零改）。折叠时留一条可点开的标签条；展开时按 store.height 显示真交互终端。
 *
 * 真 PTY 需 electron 宿主(浏览器 vite 无 IPC/PTY)——骨架/开合结构此处验证，PTY 闭环在真机(Phase C)。
 */
export function BottomTerminalDock({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
  const isOpen = useTerminalPanelStore((s) => s.isPanelOpen(sessionId))
  const togglePanel = useTerminalPanelStore((s) => s.togglePanel)
  const height = useTerminalPanelStore((s) => s.height)
  const runtimeId = useTerminalPanelStore((s) => s.getPanelRuntimeId(sessionId))

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => togglePanel(sessionId)}
        className="flex w-full shrink-0 items-center gap-2 px-4 text-left text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ height: '40px' }}
      >
        <span className="material-symbols-outlined text-[16px]">terminal</span>
        终端
        <span className="material-symbols-outlined ml-auto text-[16px]">keyboard_arrow_up</span>
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-col" style={{ height: `${height}px` }}>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-terminal-header)] px-3" style={{ height: '32px' }}>
        <span className="material-symbols-outlined text-[15px] text-[var(--color-terminal-fg)]">terminal</span>
        <span className="text-[12px] text-[var(--color-terminal-fg)]">终端</span>
        <button
          type="button"
          onClick={() => togglePanel(sessionId)}
          aria-label="收起终端"
          className="ml-auto flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-terminal-muted)] hover:text-[var(--color-terminal-fg)]"
        >
          <span className="material-symbols-outlined text-[16px]">keyboard_arrow_down</span>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TerminalSettings active workspace runtimeId={runtimeId} cwd={cwd} testId="fourcol-terminal" />
      </div>
    </div>
  )
}
