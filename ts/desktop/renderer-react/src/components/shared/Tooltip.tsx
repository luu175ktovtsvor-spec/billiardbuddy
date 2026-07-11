// 轻量浮层 tooltip(对齐 Codex 真机:hover 文件名弹出完整路径的圆角小卡+柔和阴影)。
// 纯 CSS hover 显隐,不引 floating-ui(项目未装该依赖,这里只需要"贴在触发元素上方"这一种定位,
// 犯不上为一个 tooltip 引新依赖)。吃 workbuddy-tokens.css 语义 token,明暗双主题自动对。
import type { ReactNode } from 'react'

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  if (!label) return <>{children}</>
  return (
    <span className="group/tip relative inline-flex min-w-0">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 whitespace-normal break-all rounded-lg px-2.5 py-1.5 text-[11px] opacity-0 transition-opacity duration-150 group-hover/tip:opacity-100"
        style={{
          // width 显式 max-content(夹 maxWidth 上限):absolute 定位的元素当爹是 flex 容器时,
          // 默认 align-items:stretch 会把它撑成跟触发元素一样窄(真机踩过的坑),必须显式声明。
          width: 'max-content',
          maxWidth: 380,
          background: 'var(--color-surface)',
          color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border)',
          boxShadow: 'var(--shadow-popover)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {label}
      </span>
    </span>
  )
}
