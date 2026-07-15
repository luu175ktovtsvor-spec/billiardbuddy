import { IconFolderOpen, IconSparkles, IconTrash } from '../../../components/shared/icons'
import type { VideoProject } from '../../../api/video'
import { inputStyle, primaryButtonStyle } from '../videoStudioStyles'

export function ProjectEntry({ goalText, ratio, durationSec, exactCopyText, paths, projects, busy, onGoalChange, onRatioChange, onDurationChange, onExactCopyChange, onPickVideos, onRemovePath, onCreateProject, onOpenProject }: {
  goalText: string
  ratio: '9:16' | '1:1' | '16:9'
  durationSec: number
  exactCopyText: string
  paths: string[]
  projects: VideoProject[]
  busy: boolean
  onGoalChange: (value: string) => void
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
    <div className="flex flex-col rounded-lg" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', boxShadow: 'var(--shadow-input)' }}>
      <textarea value={goalText} onChange={event => onGoalChange(event.target.value)} rows={3} className="resize-none bg-transparent px-4 pt-3.5 text-[13px] leading-relaxed outline-none" style={{ color: 'var(--color-text-primary)' }} placeholder="说说想剪成什么样，例如重点展示环境和现场氛围" data-testid="video-goal-input" />
      <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5 pt-1.5">
        <button type="button" onClick={onPickVideos} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px]" style={{ color: 'var(--color-text-secondary)' }} data-testid="video-pick-files"><IconFolderOpen size={14} />添加视频</button>
        <span className="min-w-0 flex-1" />
        <button type="button" onClick={onCreateProject} disabled={!canCreate} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-35" style={primaryButtonStyle} data-testid="video-create-project"><IconSparkles size={14} />开始制作</button>
      </div>
    </div>
    {paths.length > 0 && <div className="mt-3 space-y-1" data-testid="video-imported-files">{paths.map(path => <div key={path} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-secondary)' }}><span className="min-w-0 flex-1 truncate">{path.split(/[\\/]/).pop()}</span><button type="button" title="移除" onClick={() => onRemovePath(path)}><IconTrash size={14} /></button></div>)}</div>}
    <details className="mt-4 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}><summary className="cursor-pointer text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>更多设置</summary><div className="mt-3 grid grid-cols-1 gap-3 min-[560px]:grid-cols-3"><label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>画面比例<select value={ratio} onChange={event => onRatioChange(event.target.value as typeof ratio)} className="mt-1 w-full min-w-0 rounded-md px-2 py-2 text-[12px]" style={inputStyle}><option value="9:16">竖屏 9:16</option><option value="1:1">方形 1:1</option><option value="16:9">横屏 16:9</option></select></label><label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>大约时长（秒）<input type="number" min={3} max={1800} value={durationSec} onChange={event => onDurationChange(Math.max(3, Math.min(1800, Number(event.target.value) || 30)))} className="mt-1 w-full min-w-0 rounded-md px-2 py-2 text-[12px]" style={inputStyle} aria-label="大约时长（秒）" /></label><label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>必须原样显示的文字<input value={exactCopyText} onChange={event => onExactCopyChange(event.target.value)} className="mt-1 w-full min-w-0 rounded-md px-2 py-2 text-[12px]" style={inputStyle} placeholder="价格、日期或片尾文字" /></label></div></details>
    {projects.length > 0 && <section className="mt-8"><div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>最近项目</div><div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>{projects.slice(0, 8).map(item => <button key={item.project_id} type="button" onClick={() => onOpenProject(item.project_id)} className="flex w-full items-center gap-3 py-2.5 text-left" data-testid="video-project-item"><span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{item.name}</span><span className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{item.goal === 'talking' ? '讲解优先' : '氛围优先'} · {item.scenes.length} 个片段</span></button>)}</div></section>}
  </>
}
