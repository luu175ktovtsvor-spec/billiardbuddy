// 底部终端抽屉(照 Codex:终端在**底部、全宽**,不是右面板 tab)。可关、可拖高。
// 头:shell 标签(swl@mac-8:~/…)+ 新建 + 关闭;体 = TerminalView(读本会话已执行命令,预留后端实时流)。
import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { TerminalView } from './TerminalView'
import { IconX, IconPlus, IconTerminal } from '../shared/icons'
import { toast } from '../../stores/toastStore'

export function TerminalPanel() {
  const open = useUiStore((s) => s.terminalOpen)
  const toggle = useUiStore((s) => s.toggleTerminal)
  const [height, setHeight] = useState(220)

  function onHandleDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const move = (ev: PointerEvent) => setHeight(Math.max(120, Math.min(560, startH + (startY - ev.clientY))))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!open) return null

  return (
    <div className="relative flex shrink-0 flex-col" style={{ height, borderTop: '1px solid var(--color-border)' }} data-testid="terminal-panel">
      {/* 拖顶边改高 */}
      <div onPointerDown={onHandleDown} className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize" style={{ transform: 'translateY(-50%)' }} />
      {/* 头:shell 标签 + 新建 + 关闭 */}
      <div className="flex items-center gap-1 px-2 py-1" style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }}>
        <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--color-surface-selected)', color: 'var(--color-text-primary)' }}>
          <IconTerminal size={12} />
          <span style={{ fontFamily: 'var(--font-mono)' }}>终端</span>
        </div>
        <button type="button" aria-label="新建终端" onClick={() => toast('多终端即将支持')} className="rounded p-1 transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-tertiary)' }}>
          <IconPlus size={13} />
        </button>
        <div className="flex-1" />
        <button type="button" aria-label="关闭终端" onClick={toggle} className="rounded p-1 transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-tertiary)' }}>
          <IconX size={14} />
        </button>
      </div>
      {/* 体 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <TerminalView />
      </div>
    </div>
  )
}
