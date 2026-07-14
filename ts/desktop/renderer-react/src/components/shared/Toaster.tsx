// Toast 容器。单条反馈放在工具栏下方右侧，避免遮住工作台的视图切换。
import { useToastStore } from '../../stores/toastStore'

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 top-14 z-[80] flex max-w-[min(360px,calc(100vw-32px))] flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-none max-w-full rounded-lg px-3.5 py-2 text-[13px]"
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
