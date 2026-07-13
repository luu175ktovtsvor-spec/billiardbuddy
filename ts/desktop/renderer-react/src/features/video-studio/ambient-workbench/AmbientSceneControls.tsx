import type { VideoOperation, VideoProject, VideoScene, VideoSource } from '../../../api/video'
import { CLOCK_LABELS, sourceRoleLabel } from '../videoStudioModel'
import { inputStyle, subtleButtonStyle } from '../videoStudioStyles'

type SceneRange = VideoScene['source_ranges'][number]

export function AmbientSceneControls({ scene, project, primarySourceId, narration, narrationSourceId, narrationRange, narrationSources, rangeFor, onNarrationChange, onNarrationSourceChange, onOperation }: {
  scene: VideoScene
  project: VideoProject
  primarySourceId: string
  narration: string
  narrationSourceId: string
  narrationRange?: SceneRange
  narrationSources: VideoSource[]
  rangeFor: (sourceId: string) => SceneRange
  onNarrationChange: (value: string) => void
  onNarrationSourceChange: (value: string) => void
  onOperation: (operation: VideoOperation) => void
}) {
  return (
    <div className="mt-2 space-y-2" onClick={event => event.stopPropagation()}>
      <select value={primarySourceId} onChange={event => onOperation({ type: 'scene.replace_source', scene_id: scene.id, source_range: rangeFor(event.target.value) })} className="w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="替换 Scene 素材">
        {project.sources.filter(source => !source.excluded).map(source => <option key={source.id} value={source.id}>{source.name} · {sourceRoleLabel(source.role)}</option>)}
      </select>
      {scene.replacement_candidates.length > 0 && <div className="grid gap-1.5 min-[760px]:grid-cols-3" data-testid="video-shot-candidates">{scene.replacement_candidates.map(candidate => <button key={candidate.id} type="button" onClick={() => onOperation({ type: 'scene.replace_source', scene_id: scene.id, source_range: candidate.source_range })} className="rounded-md px-2 py-1.5 text-left text-[10px]" style={subtleButtonStyle}><span className="block truncate" style={{ color: 'var(--color-text-secondary)' }}>{project.sources.find(source => source.id === candidate.source_range.source_id)?.name ?? '候选镜头'}</span><span className="mt-0.5 block leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{candidate.rationale}</span></button>)}</div>}
      <div className="flex gap-1">{(['music', 'action', 'dialogue'] as const).map(clock => <button key={clock} type="button" onClick={() => onOperation({ type: 'scene.set_clock', scene_id: scene.id, edit_clock: clock })} className="rounded-md px-2 py-1 text-[10px]" style={{ background: scene.edit_clock === clock ? 'var(--color-surface-selected)' : 'var(--color-surface-container)', color: scene.edit_clock === clock ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}>{CLOCK_LABELS[clock]}</button>)}</div>
      <div className="flex gap-1.5">
        <input value={narration} onChange={event => onNarrationChange(event.target.value)} placeholder="短旁白" className="min-w-0 flex-1 rounded-md px-2 py-1 text-[11px] outline-none" style={inputStyle} data-testid="video-narration-input" />
        <button type="button" disabled={!narration.trim()} onClick={() => { onOperation({ type: 'scene.add_narration', scene_id: scene.id, text: narration.trim(), source_range: narrationRange }); onNarrationChange('') }} className="rounded-md px-2 py-1 text-[11px] disabled:opacity-35" style={subtleButtonStyle} data-testid="video-add-narration">添加</button>
      </div>
      <select value={narrationSourceId} onChange={event => onNarrationSourceChange(event.target.value)} className="w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="旁白音频素材" data-testid="video-narration-source"><option value="">只保存旁白文字，稍后绑定音频</option>{narrationSources.map(source => <option key={source.id} value={source.id}>{source.name} · 取当前 Scene 时长</option>)}</select>
      {scene.dialogue?.origin === 'narration' && <button type="button" onClick={() => onOperation({ type: 'scene.remove_narration', scene_id: scene.id })} className="rounded-md px-2 py-1 text-[11px]" style={subtleButtonStyle} data-testid="video-remove-narration">移除短旁白</button>}
    </div>
  )
}
