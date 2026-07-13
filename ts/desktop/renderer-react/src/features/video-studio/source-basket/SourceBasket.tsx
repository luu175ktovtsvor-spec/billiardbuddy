import { IconTrash } from '../../../components/shared/icons'
import type { VideoOperation, VideoProject, VideoSourceRole } from '../../../api/video'
import { formatDuration, friendlyVideoText, VIDEO_SOURCE_ROLES } from '../videoStudioModel'
import { inputStyle, subtleButtonStyle } from '../videoStudioStyles'

export function SourceBasket({ project, onOperation, onRelocate }: { project: VideoProject; onOperation: (operation: VideoOperation) => void; onRelocate: (sourceId: string) => void }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
        <span>已导入视频</span><span style={{ color: 'var(--color-text-tertiary)' }}>{project.sources.length}</span>
      </div>
      <div className="max-h-[58vh] space-y-2 overflow-auto pr-1" data-testid="video-source-basket">
        {project.sources.map(source => (
          <div key={source.id} className="rounded-md p-2" style={{ border: '1px solid var(--color-border)', opacity: source.excluded ? 0.55 : 1 }}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-[12px]" title={source.file_uri} style={{ color: 'var(--color-text-primary)' }}>{source.name}</div>
              <button type="button" title={source.favorite ? '取消优先' : '优先使用'} onClick={() => onOperation({ type: 'source.set_favorite', source_id: source.id, favorite: !source.favorite })} className="rounded px-1 text-[13px]" style={{ color: source.favorite ? 'var(--color-brand)' : 'var(--color-text-tertiary)' }}>★</button>
              <button type="button" title={source.excluded ? '恢复素材' : '暂不使用'} onClick={() => onOperation({ type: 'source.set_excluded', source_id: source.id, excluded: !source.excluded })} className="rounded px-1" style={{ color: 'var(--color-text-tertiary)' }}><IconTrash size={13} /></button>
            </div>
            <div className="mt-1 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{formatDuration(source.duration_ms)}{source.has_audio === false ? ' · 无声音' : ''}{source.missing ? ' · 找不到原视频' : ''}</div>
            <label className="mt-2 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>这段主要是
              <select value={source.role} onChange={event => onOperation({ type: 'source.set_role', source_id: source.id, role: event.target.value as VideoSourceRole })}
                className="mt-1 w-full rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} aria-label={`${source.name} 画面类型`}>
                {VIDEO_SOURCE_ROLES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {source.warnings.slice(0, 2).map(warning => <div key={warning} className="mt-1 text-[12px]" style={{ color: 'var(--color-warning)' }}>{friendlyVideoText(warning)}</div>)}
            {source.missing && <button type="button" onClick={() => onRelocate(source.id)} className="mt-2 rounded-md px-2 py-1.5 text-[12px]" style={subtleButtonStyle}>重新选择原视频</button>}
          </div>
        ))}
      </div>
    </section>
  )
}
