// 可拖拽分栏宽度 hook(对齐 Codex 真机的 SplitView + Sash:栏与栏之间的竖线可随时左右拖动)。
// 通用件:侧栏(拖右边)、右侧预览面板(拖左边)、以及后续任何分栏都复用同一套,别每处各写一遍。
// 用 pointer 事件 + setPointerCapture,拖动时全局 col-resize 光标 + 禁选中,松手即定。宽度夹在 [min,max]。
import { useCallback, useRef, useState } from 'react'

export function useResizableWidth(opts: { initial: number; min: number; max: number; edge: 'left' | 'right' }) {
  const { initial, min, max, edge } = opts
  const [width, setWidth] = useState(initial)
  const drag = useRef<{ startX: number; startW: number } | null>(null)

  const clamp = useCallback((w: number) => Math.min(max, Math.max(min, w)), [min, max])

  const onHandleDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      drag.current = { startX: e.clientX, startW: width }
      const el = e.currentTarget as HTMLElement
      el.setPointerCapture(e.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width],
  )

  const onHandleMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return
      const dx = e.clientX - drag.current.startX
      // 拖右边(侧栏):向右变宽;拖左边(右侧面板):向左变宽,故取反。
      const next = edge === 'right' ? drag.current.startW + dx : drag.current.startW - dx
      setWidth(clamp(next))
    },
    [edge, clamp],
  )

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return
    drag.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已释放 */
    }
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  return { width, onHandleDown, onHandleMove, endDrag, setWidth }
}
