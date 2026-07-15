// 通用菜单(照 Codex 菜单范式:圆角 + 发丝边 + 阴影;项 = 图标 + label + 右对齐快捷键;可分隔、可危险色)。
// 两种用法:
//   <MenuList items>            —— 纯列表,放进任意浮层(下拉/Popover)。
//   <ContextMenu x y items>     —— 右键上下文菜单(定位到光标 + 遮罩兜底关闭 + 视口内钳制)。
import type { ReactNode } from 'react'

export interface MenuItem {
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
  onClick?: () => void
}

export function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  return (
    <div className="min-w-[200px] p-1.5">
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && <div className="mx-1 my-1 h-px" style={{ background: 'var(--color-border)' }} />}
          <button
            type="button"
            disabled={it.disabled}
            onClick={() => { if (!it.disabled) { it.onClick?.(); onClose() } }}
            className="flex min-h-7 w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px] leading-5 transition-colors hover:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-40"
            style={{ color: it.danger ? 'var(--color-error)' : 'var(--color-text-primary)' }}
          >
            {it.icon && (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: it.danger ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
                {it.icon}
              </span>
            )}
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{it.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>
  )
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  // 视口内钳制:菜单约 220×(项数*32),避免贴边溢出。
  const w = 220
  const h = items.length * 30 + 12
  const left = typeof window !== 'undefined' ? Math.min(x, window.innerWidth - w - 8) : x
  const top = typeof window !== 'undefined' ? Math.min(y, window.innerHeight - h - 8) : y
  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        className="fixed z-[61] overflow-hidden rounded-[10px] backdrop-blur-sm"
        style={{ left: Math.max(8, left), top: Math.max(8, top), background: 'color-mix(in oklab, var(--color-surface) 95%, transparent)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
      >
        <MenuList items={items} onClose={onClose} />
      </div>
    </>
  )
}
