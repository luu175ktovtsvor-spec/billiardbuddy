// Toast 容器(顶部居中浮层,照 Codex/常见 chat 的操作反馈)。挂在 AppShell 顶层。
import { useToastStore } from '../../stores/toastStore'

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[80] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-none rounded-lg px-3.5 py-2 text-[13px]"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            boxShadow: 'var(--shadow-popover)',
            color: 'var(--color-text-primary)',
            animation: 'qf-toast-in .18s ease-out both',
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
