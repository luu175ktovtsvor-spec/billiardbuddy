import type { VideoStudioView } from '../videoStudioTypes'

export function ModeTabs({ value, recommended, onChange }: { value: VideoStudioView; recommended?: VideoStudioView; onChange: (view: VideoStudioView) => void }) {
  return (
    <div className="inline-grid grid-cols-2 gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-surface-container)' }} role="tablist" aria-label="视频内容方式">
      {([
        ['talking', '有人讲解'],
        ['ambient', '画面为主'],
      ] as const).map(([view, label]) => {
        const active = value === view
        return (
          <button key={view} type="button" role="tab" aria-selected={active} onClick={() => onChange(view)}
            className="rounded-md px-3 py-1.5 text-[12px] font-medium"
            style={{ background: active ? 'var(--color-surface)' : 'transparent', color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: active ? 'var(--shadow-control)' : undefined }}
            data-testid={`video-view-${view}`}>
            {label}{recommended === view && <span className="ml-1" style={{ color: 'var(--color-brand)' }}>推荐</span>}
          </button>
        )
      })}
    </div>
  )
}
