import { IconFolderOpen, IconSparkles, IconTrash } from '../../../components/shared/icons'
import type { VideoContentType, VideoProject } from '../../../api/video'
import { ModeTabs } from '../shared/ModeTabs'
import { VIDEO_CONTENT_TYPES } from '../videoStudioModel'
import { inputStyle, primaryButtonStyle } from '../videoStudioStyles'
import type { VideoStudioView } from '../videoStudioTypes'

export function ProjectEntry({ view, goalText, contentType, ratio, durationSec, exactCopyText, paths, projects, busy, onViewChange, onGoalChange, onContentTypeChange, onRatioChange, onDurationChange, onExactCopyChange, onPickVideos, onRemovePath, onCreateProject, onOpenProject }: {
  view: VideoStudioView
  goalText: string
  contentType: VideoContentType
  ratio: '9:16' | '1:1' | '16:9'
  durationSec: number
  exactCopyText: string
  paths: string[]
  projects: VideoProject[]
  busy: boolean
  onViewChange: (view: VideoStudioView) => void
  onGoalChange: (value: string) => void
  onContentTypeChange: (value: VideoContentType) => void
  onRatioChange: (value: '9:16' | '1:1' | '16:9') => void
  onDurationChange: (value: number) => void
  onExactCopyChange: (value: string) => void
  onPickVideos: () => void
  onRemovePath: (path: string) => void
  onCreateProject: () => void
  onOpenProject: (id: string) => void
}) {
  const canCreate = paths.length > 0 && goalText.trim().length > 0 && !busy
  return <>
    <ModeTabs value={view} onChange={onViewChange} />
    <div className="mt-5 flex flex-col rounded-[22px]" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', boxShadow: 'var(--shadow-input)' }}>
      <textarea value={goalText} onChange={event => onGoalChange(event.target.value)} rows={3} className="resize-none bg-transparent px-4 pt-3.5 text-[13px] leading-relaxed outline-none" style={{ color: 'var(--color-text-primary)' }} placeholder={view === 'talking' ? '说清楚这条视频要讲什么' : '说说希望这批素材呈现什么感觉'} data-testid="video-goal-input" />
      <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5 pt-1.5">
        <select value={contentType} onChange={event => onContentTypeChange(event.target.value as VideoContentType)} className="max-w-[145px] rounded-md bg-transparent px-2 py-1.5 text-[12px] outline-none" style={{ color: 'var(--color-text-secondary)' }} aria-label="内容类型">{VIDEO_CONTENT_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        <button type="button" onClick={onPickVideos} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px]" style={{ color: 'var(--color-text-secondary)' }} data-testid="video-pick-files"><IconFolderOpen size={14} />选择视频</button>
        <span className="min-w-0 flex-1" />
        <button type="button" onClick={onCreateProject} disabled={!canCreate} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium disabled:opacity-35" style={primaryButtonStyle} data-testid="video-create-project"><IconSparkles size={14} />开始分析</button>
      </div>
    </div>
    {paths.length > 0 && <div className="mt-3 space-y-1" data-testid="video-imported-files">{paths.map(path => <div key={path} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-secondary)' }}><span className="min-w-0 flex-1 truncate">{path.split(/[\\/]/).pop()}</span><button type="button" title="移除" onClick={() => onRemovePath(path)}><IconTrash size={13} /></button></div>)}</div>}
    <details className="mt-4 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}><summary className="cursor-pointer text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>输出与硬文字</summary><div className="mt-2 grid grid-cols-1 gap-2 min-[560px]:grid-cols-3"><select value={ratio} onChange={event => onRatioChange(event.target.value as typeof ratio)} className="min-w-0 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle}><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="16:9">16:9</option></select><input type="number" min={3} max={1800} value={durationSec} onChange={event => onDurationChange(Math.max(3, Math.min(1800, Number(event.target.value) || 30)))} className="min-w-0 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="目标时长（秒）" /><input value={exactCopyText} onChange={event => onExactCopyChange(event.target.value)} className="min-w-0 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} placeholder="必须准确显示的文字" /></div></details>
    {projects.length > 0 && <section className="mt-8"><div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>最近项目</div><div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>{projects.slice(0, 8).map(item => <button key={item.project_id} type="button" onClick={() => onOpenProject(item.project_id)} className="flex w-full items-center gap-3 py-2.5 text-left" data-testid="video-project-item"><span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--color-text-primary)' }}>{item.name}</span><span className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>{item.goal === 'talking' ? '口播' : '环境'} · {item.scenes.length} Scenes</span></button>)}</div></section>}
  </>
}
