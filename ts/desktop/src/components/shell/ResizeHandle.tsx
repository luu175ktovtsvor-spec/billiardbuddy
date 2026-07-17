import { useCallback, useRef } from 'react'

/**
 * 四栏之间的列宽拖拽手柄。抽象自旧 ActiveSession.WorkspaceResizeHandle 的 pointer 拖拽原语，
 * 但改为写 CSS 变量（驱动 WorkspaceLayout 的单 grid），偏好落 localStorage。
 *
 * onDelta(dxPx) 每帧回调净水平位移，由父层决定改哪个变量（--conv-fr / --tree-w），
 * 父层用 startValue + 换算 应用并 clamp。
 */
export interface ResizeHandleProps {
  /** 无障碍标签（如「拖动调整会话与工作区宽度」） */
  ariaLabel: string
  /** 按下时记录起始值 */
  onStart: () => void
  /** 拖拽中：相对起始点的净水平位移(px，向右为正) */
  onDelta: (dxPx: number) => void
  /** 松手 */
  onEnd?: () => void
  testId?: string
}

export function ResizeHandle({ ariaLabel, onStart, onDelta, onEnd, testId }: ResizeHandleProps) {
  const startXRef = useRef<number | null>(null)

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      startXRef.current = event.clientX
      onStart()
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    },
    [onStart],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (startXRef.current === null) return
      onDelta(event.clientX - startXRef.current)
    },
    [onDelta],
  )

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (startXRef.current === null) return
      startXRef.current = null
      try {
        ;(event.target as HTMLElement).releasePointerCapture(event.pointerId)
      } catch {
        /* capture 可能已释放 */
      }
      onEnd?.()
    },
    [onEnd],
  )

  // 键盘可达：←/→ 微调 32px（沿用旧手柄的键盘步进）。
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      onStart()
      onDelta(event.key === 'ArrowRight' ? 32 : -32)
      onEnd?.()
    },
    [onStart, onDelta, onEnd],
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className="group relative z-10 flex w-1 shrink-0 cursor-col-resize items-stretch justify-center outline-none"
    >
      {/* 细线，hover/focus 变蓝加粗 */}
      <span className="pointer-events-none block w-px bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-primary)] group-focus-visible:bg-[var(--color-primary)]" />
    </div>
  )
}
