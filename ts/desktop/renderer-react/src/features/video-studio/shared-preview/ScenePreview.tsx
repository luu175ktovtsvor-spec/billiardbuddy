import { useEffect, useRef } from 'react'
import { videoApi, type VideoProject, type VideoScene } from '../../../api/video'
import { selectedVisualLayer, selectedVisualRange } from '../sceneSelectors'
import { formatDuration } from '../videoStudioModel'

export function ScenePreview({ project, scene }: { project: VideoProject; scene?: VideoScene }) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const range = selectedVisualRange(scene)
  const visualLayer = selectedVisualLayer(scene)
  const source = project.sources.find(item => item.id === range?.source_id)
  const src = source ? videoApi.sourceUrl(project.project_id, source.id) : ''
  const audioRange = scene?.audio_layers.find(layer => layer.enabled && layer.owner && layer.role !== 'music' && layer.source_range)?.source_range
  const audioSource = project.sources.find(item => item.id === audioRange?.source_id)
  const separateAudio = Boolean(audioRange && audioSource && (audioRange.source_id !== range?.source_id || audioRange.in_ms !== range?.in_ms))
  const audioSrc = separateAudio && audioSource ? videoApi.sourceUrl(project.project_id, audioSource.id) : ''

  useEffect(() => {
    const video = ref.current
    if (!video || !range) return
    const seek = () => { video.currentTime = range.in_ms / 1000 }
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
    video.playbackRate = visualLayer?.speed ?? 1
  }, [range?.source_id, range?.in_ms, src, visualLayer?.speed])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audioRange) return
    const seek = () => { audio.currentTime = audioRange.in_ms / 1000 }
    if (audio.readyState >= 1) seek()
    else audio.addEventListener('loadedmetadata', seek, { once: true })
  }, [audioRange?.source_id, audioRange?.in_ms, audioSrc])

  if (!scene || !source || !range) {
    return <div className="flex aspect-video items-center justify-center text-[12px]" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-tertiary)' }}>选择一个 Scene 查看预览</div>
  }
  const visibleGraphics = scene.graphics.filter(item => !item.hidden_reason && item.text)
  const crop = visualLayer?.crop
  const cropCenterX = crop?.focal_x ?? (crop ? crop.x + crop.width / 2 : 0.5)
  const cropCenterY = crop?.focal_y ?? (crop ? crop.y + crop.height / 2 : 0.5)
  const cropZoom = crop ? Math.max(1, 1 / Math.min(crop.width, crop.height)) : 1
  return (
    <div className="relative flex max-h-[52vh] min-h-[260px] items-center justify-center overflow-hidden rounded-md" style={{ background: '#111', aspectRatio: `${project.canvas.width}/${project.canvas.height}` }} data-testid="video-scene-preview">
      <video ref={ref} key={src} src={src} controls muted={separateAudio}
        className={`h-full w-full ${crop?.fit === 'cover' ? 'object-cover' : 'object-contain'}`}
        style={{ transform: cropZoom > 1.001 ? `scale(${cropZoom})` : undefined, transformOrigin: `${cropCenterX * 100}% ${cropCenterY * 100}%` }}
        onPlay={() => { if (audioRef.current) void audioRef.current.play() }}
        onPause={() => audioRef.current?.pause()}
        onSeeking={event => {
          if (!audioRef.current || !audioRange) return
          const elapsed = Math.max(0, event.currentTarget.currentTime - range.in_ms / 1000)
          audioRef.current.currentTime = audioRange.in_ms / 1000 + elapsed
        }}
        onVolumeChange={event => { if (audioRef.current) audioRef.current.volume = event.currentTarget.volume }}
        onTimeUpdate={event => {
          const elapsed = Math.max(0, event.currentTarget.currentTime - range.in_ms / 1000)
          if (audioRef.current && audioRange) {
            const expected = audioRange.in_ms / 1000 + elapsed
            if (Math.abs(audioRef.current.currentTime - expected) > 0.25) audioRef.current.currentTime = expected
          }
          if (event.currentTarget.currentTime >= range.out_ms / 1000) {
            event.currentTarget.pause()
            audioRef.current?.pause()
          }
        }} />
      {audioSrc && <audio ref={audioRef} key={audioSrc} src={audioSrc} preload="metadata" />}
      <div className="pointer-events-none absolute" style={{ inset: `${project.canvas.safe_inset.top * 100}% ${project.canvas.safe_inset.right * 100}% ${project.canvas.safe_inset.bottom * 100}% ${project.canvas.safe_inset.left * 100}%`, border: '1px dashed #ffffff55' }} />
      {scene.dialogue?.state !== 'deleted' && scene.dialogue?.display_text && <div className="pointer-events-none absolute bottom-[12%] left-[8%] right-[8%] text-center text-[14px] font-semibold text-white" style={{ textShadow: '0 1px 4px #000, 0 0 2px #000' }}>{scene.dialogue.display_text}</div>}
      {visibleGraphics.map(graphic => <div key={graphic.id} className={`pointer-events-none absolute left-[8%] right-[8%] text-center font-semibold text-white ${graphic.anchor === 'top' || graphic.anchor === 'upper' ? 'top-[9%]' : 'bottom-[9%]'}`} style={{ textShadow: '0 1px 4px #000' }}>{graphic.text}</div>)}
      {project.brand.logo_path && <img src={videoApi.brandLogoUrl(project.project_id)} alt="" className="pointer-events-none absolute right-[6%] top-[6%] max-h-[14%] max-w-[18%] object-contain" />}
      {project.brand.cta_text && scene.order === project.scenes.filter(item => !item.deleted)[project.scenes.filter(item => !item.deleted).length - 1]?.order && !visibleGraphics.some(graphic => graphic.role === 'cta') && <div className="pointer-events-none absolute bottom-[8%] left-[12%] right-[12%] text-center text-[13px] font-semibold text-white" style={{ textShadow: '0 1px 4px #000' }}>{project.brand.cta_text}</div>}
      <div className="absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: '#0009' }}>{source.name} · {formatDuration(range.out_ms - range.in_ms)}</div>
      {separateAudio && <div className="absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: '#0009' }}>画面覆盖中 · 保留 {audioSource?.name} 音频</div>}
    </div>
  )
}
