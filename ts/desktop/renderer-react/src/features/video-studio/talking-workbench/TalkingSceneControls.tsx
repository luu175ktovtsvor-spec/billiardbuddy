import type { VideoOperation, VideoProject, VideoScene } from '../../../api/video'
import { inputStyle, subtleButtonStyle } from '../videoStudioStyles'

type SceneRange = VideoScene['source_ranges'][number]

export function TalkingSceneControls({ scene, project, semantic, caption, brollSourceId, rangeFor, onSemanticChange, onCaptionChange, onOperation }: {
  scene: VideoScene
  project: VideoProject
  semantic: string
  caption: string
  brollSourceId: string
  rangeFor: (sourceId: string) => SceneRange
  onSemanticChange: (value: string) => void
  onCaptionChange: (value: string) => void
  onOperation: (operation: VideoOperation) => void
}) {
  return (
    <div className="mt-2" onClick={event => event.stopPropagation()}>
      <div className="rounded-md px-2 py-1.5 text-[12px] leading-relaxed" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-tertiary)' }}><span className="font-medium">原视频里听到的内容：</span>{scene.dialogue?.original_text || '这段没有识别到可用语音'}</div>
      <label className="mt-2 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>确认听到的内容
        <textarea value={semantic} onChange={event => onSemanticChange(event.target.value)} rows={2} className="mt-1 w-full resize-none rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} aria-label={`片段 ${scene.order + 1} 听到的内容`} />
      </label>
      <label className="mt-2 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>画面上显示的字幕
        <textarea value={caption} onChange={event => onCaptionChange(event.target.value)} rows={2} className="mt-1 w-full resize-none rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} aria-label={`片段 ${scene.order + 1} 显示字幕`} />
      </label>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => onOperation({ type: 'dialogue.set_semantic', scene_id: scene.id, semantic_text: semantic })} disabled={semantic === scene.dialogue?.semantic_text} className="rounded-md px-2 py-1.5 text-[12px] disabled:opacity-35" style={subtleButtonStyle}>保存内容</button>
        <button type="button" onClick={() => onOperation({ type: 'dialogue.set_display', scene_id: scene.id, display_text: caption })} disabled={caption === scene.dialogue?.display_text} className="rounded-md px-2 py-1.5 text-[12px] disabled:opacity-35" style={subtleButtonStyle}>保存字幕</button>
        {scene.dialogue?.origin === 'transcript' && <button type="button" onClick={() => onOperation({ type: 'dialogue.set_state', scene_id: scene.id, state: scene.dialogue?.state === 'deleted' ? 'kept' : 'deleted' })} className="rounded-md px-2 py-1.5 text-[12px]" style={subtleButtonStyle}>{scene.dialogue.state === 'deleted' ? '恢复段落' : '删除段落'}</button>}
        {(scene.dialogue?.take_options.length ?? 0) > 0 && <select value={scene.dialogue?.take_id ?? ''} onChange={event => event.target.value && onOperation({ type: 'dialogue.select_take', scene_id: scene.id, take_id: event.target.value })} className="rounded-md px-1.5 py-1.5 text-[12px]" style={inputStyle} aria-label="更换讲解视频"><option value="">更换讲解视频</option>{scene.dialogue?.take_options.map(take => <option key={take.id} value={take.id}>{take.label}</option>)}</select>}
        <select value={brollSourceId} onChange={event => onOperation({ type: 'scene.set_broll', scene_id: scene.id, source_range: event.target.value ? rangeFor(event.target.value) : undefined })} className="min-w-0 rounded-md px-1.5 py-1.5 text-[12px]" style={inputStyle} aria-label="插入补充画面">
          <option value="">不覆盖环境画面</option>
          {project.sources.filter(source => !source.excluded && source.role !== 'talking_take' && source.role !== 'live_longform').map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
      </div>
      {scene.replacement_candidates.length > 0 && <div className="mt-2 grid gap-1.5 min-[760px]:grid-cols-3" data-testid="video-broll-candidates">{scene.replacement_candidates.map(candidate => <button key={candidate.id} type="button" onClick={() => onOperation({ type: 'scene.set_broll', scene_id: scene.id, source_range: candidate.source_range })} className="rounded-md px-2 py-1.5 text-left text-[12px]" style={subtleButtonStyle}><span className="block truncate" style={{ color: 'var(--color-text-secondary)' }}>{project.sources.find(source => source.id === candidate.source_range.source_id)?.name ?? '可选画面'}</span><span className="mt-0.5 block leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{candidate.rationale}</span></button>)}</div>}
    </div>
  )
}
