import { useEffect, useState } from 'react'
import type { VideoOperation, VideoProject, VideoScene } from '../../../api/video'
import { AmbientSceneControls } from '../ambient-workbench/AmbientSceneControls'
import { selectedVisualLayer } from '../sceneSelectors'
import { STORY_ROLE_LABELS, CLOCK_LABELS, formatDuration, friendlyVideoText, sceneDuration } from '../videoStudioModel'
import { inputStyle, subtleButtonStyle } from '../videoStudioStyles'
import type { VideoStudioView } from '../videoStudioTypes'
import { TalkingSceneControls } from '../talking-workbench/TalkingSceneControls'

export function SceneEditor({ scene, nextScene, project, view, selected, onSelect, onOperation }: {
  scene: VideoScene
  nextScene?: VideoScene
  project: VideoProject
  view: VideoStudioView
  selected: boolean
  onSelect: () => void
  onOperation: (operation: VideoOperation) => void
}) {
  const [caption, setCaption] = useState(scene.dialogue?.display_text ?? '')
  const [semantic, setSemantic] = useState(scene.dialogue?.semantic_text ?? '')
  const [narration, setNarration] = useState('')
  const [narrationSourceId, setNarrationSourceId] = useState('')
  useEffect(() => setCaption(scene.dialogue?.display_text ?? ''), [scene.id, scene.dialogue?.display_text])
  useEffect(() => setSemantic(scene.dialogue?.semantic_text ?? ''), [scene.id, scene.dialogue?.semantic_text])
  const primary = scene.video_layers.find(layer => layer.role === 'primary') ?? scene.video_layers[0]
  const broll = scene.video_layers.find(layer => layer.role === 'broll')
  const currentSource = project.sources.find(source => source.id === primary?.source_range.source_id)
  const rangeFor = (sourceId: string) => {
    const source = project.sources.find(item => item.id === sourceId)!
    const duration = Math.max(1, Math.min(source.duration_ms || sceneDuration(scene), sceneDuration(scene)))
    return { source_id: source.id, in_ms: 0, out_ms: duration }
  }
  const narrationSources = project.sources.filter(source => !source.excluded && source.has_audio !== false)
  const narrationRange = narrationSourceId ? rangeFor(narrationSourceId) : undefined
  const mergeable = Boolean(primary && nextScene && (() => {
    const next = nextScene.video_layers.find(layer => layer.role === 'primary') ?? nextScene.video_layers[0]
    return next?.source_range.source_id === primary.source_range.source_id && Math.abs(next.source_range.in_ms - primary.source_range.out_ms) <= 200
  })())
  const trim = (edge: 'in' | 'out', seconds: number) => {
    if (!primary) return
    const value = Math.max(0, Math.round(seconds * 1000))
    const nextRange = edge === 'in'
      ? { ...primary.source_range, in_ms: Math.min(value, primary.source_range.out_ms - 200) }
      : { ...primary.source_range, out_ms: Math.max(value, primary.source_range.in_ms + 200) }
    onOperation({ type: 'scene.replace_source', scene_id: scene.id, source_range: nextRange })
  }
  return (
    <article onClick={onSelect} className="rounded-md p-3" style={{ border: `1px solid ${selected ? 'var(--color-brand)' : 'var(--color-border)'}`, background: selected ? 'var(--color-brand-tint)' : 'var(--color-surface)' }} data-testid="video-scene-card">
      <div className="flex items-start gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
          <div className="flex items-center gap-2 text-[12px] font-medium" style={{ color: 'var(--color-text-primary)' }}>
            <span>{scene.order + 1}. {STORY_ROLE_LABELS[scene.story_role]}</span>
            <span className="rounded px-1.5 py-0.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-tertiary)' }}>{CLOCK_LABELS[scene.edit_clock]}</span>
            {scene.locked_by_user && <span title="已锁定">◆</span>}
          </div>
          <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{currentSource?.name ?? '找不到原视频'} · {formatDuration(sceneDuration(scene))}</div>
        </button>
        <div className="flex gap-1">
          <button type="button" title="前移" disabled={scene.order === 0} onClick={event => { event.stopPropagation(); onOperation({ type: 'scene.move', scene_id: scene.id, to_index: Math.max(0, scene.order - 1) }) }} className="h-6 w-6 rounded text-[13px] disabled:opacity-30" style={subtleButtonStyle}>↑</button>
          <button type="button" title="后移" disabled={scene.order >= project.scenes.length - 1} onClick={event => { event.stopPropagation(); onOperation({ type: 'scene.move', scene_id: scene.id, to_index: scene.order + 1 }) }} className="h-6 w-6 rounded text-[13px] disabled:opacity-30" style={subtleButtonStyle}>↓</button>
          <button type="button" title={scene.deleted ? '恢复片段' : '删除片段'} onClick={event => { event.stopPropagation(); onOperation(scene.deleted ? { type: 'scene.restore', scene_id: scene.id } : { type: 'scene.delete', scene_id: scene.id }) }} className="h-6 w-6 rounded text-[13px]" style={subtleButtonStyle} data-testid="video-scene-delete">{scene.deleted ? '＋' : '×'}</button>
        </div>
      </div>

      {view === 'talking' && scene.dialogue && <TalkingSceneControls
        scene={scene}
        project={project}
        semantic={semantic}
        caption={caption}
        brollSourceId={broll?.source_range.source_id ?? ''}
        rangeFor={rangeFor}
        onSemanticChange={setSemantic}
        onCaptionChange={setCaption}
        onOperation={onOperation}
      />}

      {view === 'ambient' && <AmbientSceneControls
        scene={scene}
        project={project}
        primarySourceId={primary?.source_range.source_id ?? ''}
        narration={narration}
        narrationSourceId={narrationSourceId}
        narrationRange={narrationRange}
        narrationSources={narrationSources}
        rangeFor={rangeFor}
        onNarrationChange={setNarration}
        onNarrationSourceChange={setNarrationSourceId}
        onOperation={onOperation}
      />}
      {primary && <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--color-border)' }} onClick={event => event.stopPropagation()}>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" disabled={primary.source_range.out_ms - primary.source_range.in_ms < 1000} onClick={() => onOperation({ type: 'scene.split', scene_id: scene.id, at_source_ms: Math.round((primary.source_range.in_ms + primary.source_range.out_ms) / 2) })} className="rounded px-2 py-1 text-[12px] disabled:opacity-35" style={subtleButtonStyle} data-testid="video-split-scene">拆成两段</button>
          <button type="button" disabled={!mergeable || !nextScene} onClick={() => nextScene && onOperation({ type: 'scene.merge', scene_id: scene.id, next_scene_id: nextScene.id })} className="rounded px-2 py-1 text-[12px] disabled:opacity-35" style={subtleButtonStyle} data-testid="video-merge-scene">和下一段合并</button>
        </div>
        <details className="mt-2" data-testid="video-advanced-trim">
          <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>精确选择时间</summary>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>从第几秒开始<input type="number" min={0} step={0.1} defaultValue={primary.source_range.in_ms / 1000} key={`${scene.id}-${primary.source_range.in_ms}-in`} onBlur={event => trim('in', Number(event.target.value))} className="ml-1 w-16 rounded px-1 py-0.5 text-[12px]" style={inputStyle} /></label>
            <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>到第几秒结束<input type="number" min={0.2} step={0.1} defaultValue={primary.source_range.out_ms / 1000} key={`${scene.id}-${primary.source_range.out_ms}-out`} onBlur={event => trim('out', Number(event.target.value))} className="ml-1 w-16 rounded px-1 py-0.5 text-[12px]" style={inputStyle} /></label>
          </div>
        </details>
      </div>}
      {scene.needs_review.slice(0, 2).map(item => <div key={item} className="mt-1.5 text-[12px]" style={{ color: 'var(--color-warning)' }}>{friendlyVideoText(item)}</div>)}
    </article>
  )
}

export function SceneVisualControls({ scene, onOperation }: { scene: VideoScene; onOperation: (operation: VideoOperation) => void }) {
  const layer = selectedVisualLayer(scene)
  const crop = layer?.crop
  const initialZoom = crop ? Math.max(1, Math.min(2.5, 1 / Math.min(crop.width, crop.height))) : 1
  const initialX = crop?.focal_x ?? (crop ? crop.x + crop.width / 2 : 0.5)
  const initialY = crop?.focal_y ?? (crop ? crop.y + crop.height / 2 : 0.5)
  const [zoom, setZoom] = useState(initialZoom)
  const [focalX, setFocalX] = useState(initialX)
  const [focalY, setFocalY] = useState(initialY)

  useEffect(() => {
    setZoom(initialZoom)
    setFocalX(initialX)
    setFocalY(initialY)
  }, [initialX, initialY, initialZoom, layer?.id])

  if (!layer || !crop) return null
  const commitCrop = (nextZoom = zoom, nextX = focalX, nextY = focalY) => {
    const width = 1 / nextZoom
    const height = 1 / nextZoom
    const x = Math.max(0, Math.min(1 - width, nextX - width / 2))
    const y = Math.max(0, Math.min(1 - height, nextY - height / 2))
    onOperation({ type: 'scene.set_crop', scene_id: scene.id, layer_id: layer.id, crop: { ...crop, x, y, width, height, focal_x: nextX, focal_y: nextY } })
  }
  return (
    <div className="mt-2 space-y-2" data-testid="video-visual-controls">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>画面显示
          <select value={crop.fit} onChange={event => onOperation({ type: 'scene.set_crop', scene_id: scene.id, layer_id: layer.id, crop: { ...crop, fit: event.target.value as 'contain' | 'cover' } })} className="mt-1 w-full rounded-md px-2 py-1.5 text-[12px]" style={inputStyle} data-testid="video-crop-fit"><option value="contain">完整显示</option><option value="cover">铺满画面</option></select>
        </label>
        <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>播放速度
          <select value={String(layer.speed)} onChange={event => onOperation({ type: 'scene.set_speed', scene_id: scene.id, layer_id: layer.id, speed: Number(event.target.value) })} className="mt-1 w-full rounded-md px-2 py-1.5 text-[12px]" style={inputStyle} data-testid="video-speed"><option value="0.75">0.75x</option><option value="1">1x 原速</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option></select>
        </label>
      </div>
      <label className="block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>画面缩放 {zoom.toFixed(2)}x
        <input type="range" min={1} max={2.5} step={0.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} onPointerUp={() => commitCrop()} onKeyUp={event => { if (event.key.startsWith('Arrow')) commitCrop() }} onBlur={() => commitCrop()} className="mt-1 w-full" data-testid="video-crop-zoom" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>左右位置<input type="range" min={0} max={1} step={0.01} value={focalX} onChange={event => setFocalX(Number(event.target.value))} onPointerUp={() => commitCrop()} onKeyUp={event => { if (event.key.startsWith('Arrow')) commitCrop() }} onBlur={() => commitCrop()} className="mt-1 w-full" data-testid="video-crop-x" /></label>
        <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>上下位置<input type="range" min={0} max={1} step={0.01} value={focalY} onChange={event => setFocalY(Number(event.target.value))} onPointerUp={() => commitCrop()} onKeyUp={event => { if (event.key.startsWith('Arrow')) commitCrop() }} onBlur={() => commitCrop()} className="mt-1 w-full" data-testid="video-crop-y" /></label>
      </div>
    </div>
  )
}
