// 主区「页面」通用外壳件(已安排 / 插件等非对话视图共用)。照 Codex 页面头范式:
// 大标题 + 一行灰描述 + 右上主/次按钮;左侧图标用圆角方胶囊。
import type { ReactNode } from 'react'

/** 圆角方形图标底(照 Codex 列表项/卡片左侧的图标胶囊)。 */
export function IconTile({ children, muted, size = 36 }: { children: ReactNode; muted?: boolean; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg"
      style={{ width: size, height: size, background: 'var(--color-surface-container)', color: muted ? 'var(--color-text-tertiary)' : 'var(--color-brand)' }}
    >
      {children}
    </span>
  )
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>{title}</h1>
        {subtitle && <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

/** 主按钮(照 Codex 浅蓝主按钮)。 */
export function PrimaryButton({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
      style={{ background: 'var(--color-brand)' }}
    >
      {children}
    </button>
  )
}

/** 次按钮(发丝边中性,照 Codex 次级动作)。 */
export function SecondaryButton({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' }}
    >
      {children}
    </button>
  )
}
