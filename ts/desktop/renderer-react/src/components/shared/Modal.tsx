// 通用弹窗基件。表面参数对齐 Codex Dialog primitive；头/脚只承载本产品内容。
// 供设置/分享/新建定时任务/添加 MCP 等复用。纯前端,无数据依赖。
import { useEffect, type ReactNode } from 'react'
import { IconX } from './icons'

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 520,
  testId,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  maxWidth?: number
  testId?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-6"
      style={{ background: '#00000022' }}
      onClick={onClose}
      data-testid={testId}
    >
      <div
        className="flex max-h-[80vh] w-full flex-col overflow-hidden rounded-3xl backdrop-blur-xl"
        style={{
          maxWidth,
          background: 'color-mix(in oklab, var(--color-surface) 90%, transparent)',
          boxShadow: 'var(--shadow-popover)',
          outline: '0.5px solid var(--color-border)',
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {title !== undefined && (
          <div className="flex shrink-0 items-center justify-between px-5 py-4">
            <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>{title}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="rounded p-1 leading-none transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              <IconX size={16} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
