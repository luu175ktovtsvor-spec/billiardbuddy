// 可拖拽分栏竖线(Sash)。贴在面板某条边上,鼠标移上去变 col-resize 光标 + 高亮一条细线,拖动改宽度。
// 配合 useResizableWidth 用:面板自己管宽度,这里只负责"那条可抓的竖线"。命中区比视觉线宽(±3px)好抓。
import type { PointerEvent as ReactPointerEvent } from 'react'

export function ResizeHandle({
  side,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  /** 竖线贴在面板的哪条边:'right' 用于左侧栏,'left' 用于右侧面板。 */
  side: 'left' | 'right'
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="group/sash absolute top-0 z-30 h-full"
      style={{ [side]: -3, width: 7, cursor: 'col-resize' }}
    >
      {/* 视觉细线:默认透明,hover/拖动时显中性描边色。 */}
      <div
        className="absolute top-0 h-full opacity-0 transition-opacity duration-150 group-hover/sash:opacity-100"
        style={{ [side === 'left' ? 'right' : 'left']: 3, width: 1, background: 'var(--color-border-strong)' }}
      />
    </div>
  )
}
