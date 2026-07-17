import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ResizeHandle } from './ResizeHandle'

/**
 * Codex 四栏工作区骨架（单 CSS grid + 变量驱动可拖拽 + 底部横跨终端）。
 *
 * 布局事实源 = Codex 还原源码四栏规格（栏1 rail / 栏2 会话 / 栏3 工作区 / 栏4 文件树 + 底部终端）。
 * 本组件只管**排布与拖拽/折叠**，四个栏与终端的内容由调用方以 slot 传入（Phase B 逐个接真数据）。
 * 数据契约零改：宽度/折叠偏好落 localStorage，不碰任何后端。
 */
const LS = {
  wsW: 'billiardbuddy-layout-workspace-w',
  treeW: 'billiardbuddy-layout-tree-w',
} as const

const WS_MIN = 360
const WS_MAX = 900
const WS_DEFAULT = 560
const TREE_MIN = 200
const TREE_MAX = 360
const TREE_DEFAULT = 260

function readNum(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

function writeNum(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)))
  } catch {
    /* 存储满/禁用 → 忽略 */
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export interface WorkspaceLayoutProps {
  rail: ReactNode
  conversation: ReactNode
  /** 栏3 工作区（审阅/Diff/预览/Browser）。为 null 时该列不占位（宽度归 0）。 */
  workspace?: ReactNode
  /** 栏4 文件树。为 null 时该列不占位。 */
  fileTree?: ReactNode
  /** 底部横跨终端（栏2–4 之下）。为 null 时不占底行。 */
  terminal?: ReactNode
  /** 栏1 收起为 72px 图标轨 */
  railCollapsed?: boolean
}

export function WorkspaceLayout({
  rail,
  conversation,
  workspace,
  fileTree,
  terminal,
  railCollapsed = false,
}: WorkspaceLayoutProps) {
  const [wsW, setWsW] = useState(() => clamp(readNum(LS.wsW, WS_DEFAULT), WS_MIN, WS_MAX))
  const [treeW, setTreeW] = useState(() => clamp(readNum(LS.treeW, TREE_DEFAULT), TREE_MIN, TREE_MAX))
  const startRef = useRef(0)

  const hasWorkspace = workspace != null
  const hasTree = fileTree != null
  const hasTerminal = terminal != null

  const railW = railCollapsed ? 'var(--rail-w-collapsed)' : 'var(--rail-w-expanded)'
  // 栏3 只在有内容时占宽；栏4 同理。会话列(栏2)吃剩余(1fr)。
  const wsCol = hasWorkspace ? `${wsW}px` : '0px'
  const treeCol = hasTree ? `${treeW}px` : '0px'

  const gridTemplateColumns = `${railW} minmax(0, 1fr) ${wsCol} ${treeCol}`
  const gridTemplateRows = hasTerminal ? '1fr auto' : '1fr'

  // 栏2|栏3 边界：向左拖 → 会话变窄、工作区变宽（wsW = start - dx）。
  const onWsStart = useCallback(() => { startRef.current = wsW }, [wsW])
  const onWsDelta = useCallback((dx: number) => {
    setWsW(clamp(startRef.current - dx, WS_MIN, WS_MAX))
  }, [])
  const onWsEnd = useCallback(() => writeNum(LS.wsW, wsW), [wsW])

  // 栏3|栏4 边界：向左拖 → 工作区变宽、文件树变窄（treeW = start - dx）。
  const onTreeStart = useCallback(() => { startRef.current = treeW }, [treeW])
  const onTreeDelta = useCallback((dx: number) => {
    setTreeW(clamp(startRef.current - dx, TREE_MIN, TREE_MAX))
  }, [])
  const onTreeEnd = useCallback(() => writeNum(LS.treeW, treeW), [treeW])

  return (
    <div
      data-testid="workspace-layout"
      className="grid h-full min-h-0 w-full overflow-hidden bg-[var(--color-background)] text-[var(--color-text-primary)]"
      style={{ gridTemplateColumns, gridTemplateRows }}
    >
      {/* 栏1 · 导航 rail（不被底部终端压，跨两行） */}
      <div
        data-testid="col-rail"
        className="relative min-h-0 overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface-sidebar)]"
        style={{ gridColumn: 1, gridRow: hasTerminal ? '1 / 3' : 1 }}
      >
        {rail}
      </div>

      {/* 栏2 · 会话 */}
      <div data-testid="col-conversation" className="relative flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ gridColumn: 2, gridRow: 1 }}>
        {conversation}
      </div>

      {/* 栏3 · 工作区（审阅/Diff/预览/Browser） */}
      {hasWorkspace && (
        <div data-testid="col-workspace" className="relative flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-[var(--color-border)]" style={{ gridColumn: 3, gridRow: 1 }}>
          {/* 栏2|栏3 拖拽手柄（贴左边） */}
          <div className="absolute left-0 top-0 z-10 h-full">
            <ResizeHandle
              ariaLabel="拖动调整会话与工作区宽度"
              testId="resize-conv-workspace"
              onStart={onWsStart}
              onDelta={onWsDelta}
              onEnd={onWsEnd}
            />
          </div>
          {workspace}
        </div>
      )}

      {/* 栏4 · 文件树 */}
      {hasTree && (
        <div data-testid="col-filetree" className="relative flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-[var(--color-border)]" style={{ gridColumn: 4, gridRow: 1 }}>
          <div className="absolute left-0 top-0 z-10 h-full">
            <ResizeHandle
              ariaLabel="拖动调整工作区与文件树宽度"
              testId="resize-workspace-tree"
              onStart={onTreeStart}
              onDelta={onTreeDelta}
              onEnd={onTreeEnd}
            />
          </div>
          {fileTree}
        </div>
      )}

      {/* 底部 · 横跨栏2–4 的终端 dock */}
      {hasTerminal && (
        <div
          data-testid="bottom-terminal-dock"
          className="min-h-0 overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]"
          style={{ gridColumn: '2 / 5', gridRow: 2 }}
        >
          {terminal}
        </div>
      )}
    </div>
  )
}
