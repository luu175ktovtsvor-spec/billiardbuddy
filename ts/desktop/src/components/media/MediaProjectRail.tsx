import { Image as ImageIcon, Trash2, Video } from 'lucide-react'

type MediaProjectSummary = {
  id: string
  title: string
  state: string
  updated_at: string
}

type MediaProjectRailProps = {
  kind: 'image' | 'video'
  projects: MediaProjectSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (project: MediaProjectSummary) => void
  deletingId?: string | null
}

const STATE_LABELS: Record<string, string> = {
  draft: '草稿',
  queued: '排队中',
  generating: '生成中',
  ready: '可编辑',
  rendering: '导出中',
  complete: '已完成',
  failed: '失败',
}

export function MediaProjectRail({ kind, projects, activeId, onSelect, onDelete, deletingId }: MediaProjectRailProps) {
  const Icon = kind === 'image' ? ImageIcon : Video
  return (
    <aside className="flex h-full min-h-0 w-[228px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-app-sidebar)]">
      <div className="h-10 shrink-0 border-b border-[var(--color-border)] px-3 text-[12px] font-medium leading-10 text-[var(--color-text-secondary)]">
        项目
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {projects.map(project => {
          const active = project.id === activeId
          return (
            <div
              key={project.id}
              className={`group mb-0.5 flex w-full items-start rounded-[6px] transition-colors ${
                active ? 'bg-[var(--color-surface-selected)]' : 'hover:bg-[var(--color-surface-hover)]'
              }`}
            >
          <button
            type="button"
            aria-label={project.title}
            onClick={() => onSelect(project.id)}
            className="flex min-w-0 flex-1 items-start gap-2 px-2 py-2 text-left"
          >
                <Icon size={15} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-[var(--color-text-primary)]">{project.title}</span>
                  <span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">
                    {STATE_LABELS[project.state] ?? project.state}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(project)}
                disabled={deletingId === project.id}
                className="mr-1 mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-text-tertiary)] opacity-0 hover:bg-[var(--color-error-container)] hover:text-[var(--color-error)] focus:opacity-100 disabled:opacity-40 group-hover:opacity-100"
                aria-label={`删除 ${project.title}`}
                title="删除项目"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
