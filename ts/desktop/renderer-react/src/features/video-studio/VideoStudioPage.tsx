import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '../../components/shared/PageKit'
import {
  IconAlertCircle,
  IconCheckCircle,
  IconEdit,
  IconFolderOpen,
  IconRefresh,
  IconSparkles,
  IconTarget,
  IconTrash,
} from '../../components/shared/icons'
import { getDesktopHost } from '../../lib/desktopHost'
import { toast } from '../../stores/toastStore'
import {
  pollVideoJob,
  videoApi,
  type VideoAlternative,
  type VideoBriefCompileResponse,
  type VideoContentType,
  type VideoJob,
  type VideoOperation,
  type VideoProject,
  type VideoScene,
  type VideoSourceRole,
} from '../../api/video'
import {
  CLOCK_LABELS,
  STORY_ROLE_LABELS,
  VIDEO_CONTENT_TYPES,
  VIDEO_SOURCE_ROLES,
  formatDuration,
  coverageLabel,
  sceneDuration,
  sourceRoleLabel,
} from './videoStudioModel'

type View = 'talking' | 'ambient'
type CompactPane = 'sources' | 'workspace' | 'inspector'

const inputStyle = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text-primary)',
} as const

const subtleButtonStyle = {
  background: 'var(--color-surface-container)',
  color: 'var(--color-text-secondary)',
} as const

const primaryButtonStyle = {
  background: 'var(--color-brand)',
  color: 'var(--color-on-primary)',
} as const

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '操作失败'
}

function selectedVisualLayer(scene: VideoScene | undefined) {
  if (!scene) return undefined
  return [...scene.video_layers].reverse().find(layer => layer.enabled && layer.role === 'broll')
    ?? scene.video_layers.find(layer => layer.enabled && layer.role === 'primary')
    ?? scene.video_layers[0]
}

function selectedVisualRange(scene: VideoScene | undefined) {
  return selectedVisualLayer(scene)?.source_range ?? scene?.source_ranges[0]
}

function ModeTabs({ value, recommended, onChange }: { value: View; recommended?: View; onChange: (view: View) => void }) {
  return (
    <div className="inline-grid grid-cols-2 gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-surface-container)' }} role="tablist" aria-label="剪辑视图">
      {([
        ['talking', '讲清一件事'],
        ['ambient', '展示环境与氛围'],
      ] as const).map(([view, label]) => {
        const active = value === view
        return (
          <button key={view} type="button" role="tab" aria-selected={active} onClick={() => onChange(view)}
            className="rounded-md px-3 py-1.5 text-[12px] font-medium"
            style={{ background: active ? 'var(--color-surface)' : 'transparent', color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: active ? 'var(--shadow-input)' : undefined }}
            data-testid={`video-view-${view}`}>
            {label}{recommended === view && <span className="ml-1" style={{ color: 'var(--color-brand)' }}>建议</span>}
          </button>
        )
      })}
    </div>
  )
}

function JobBar({ job, onCancel, onRetry }: { job: VideoJob; onCancel: () => void; onRetry: () => void }) {
  const running = !['done', 'done_with_warnings', 'cancelled', 'interrupted', 'error'].includes(job.status)
  const statusLabel: Record<VideoJob['status'], string> = {
    queued: '等待处理', preparing: '正在准备组件', analyzing: '正在分析素材', planning: '正在生成草稿', rendering: '正在导出',
    blocked: '组件尚未就绪', cancelled: '已取消，可继续', interrupted: '应用退出导致中断', error: '处理失败', done: '已完成', done_with_warnings: '已完成，存在提醒',
  }
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }} data-testid="video-job-status">
      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        <span className="min-w-0 flex-1 truncate">{job.stage || statusLabel[job.status]}</span>
        <span>{Math.round(job.progress)}%</span>
        {running ? <button type="button" onClick={onCancel} className="rounded-md px-2 py-1" style={subtleButtonStyle} data-testid="video-cancel-job">取消</button>
          : job.retryable && <button type="button" onClick={onRetry} className="rounded-md px-2 py-1" style={subtleButtonStyle} data-testid="video-retry-job">重试</button>}
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: 'var(--color-surface-container)' }}>
        <div className="h-full transition-all" style={{ width: `${Math.max(3, job.progress)}%`, background: job.status === 'error' ? 'var(--color-error)' : 'var(--color-brand)' }} />
      </div>
      {job.error && <div className="mt-2 text-[11px]" style={{ color: 'var(--color-error)' }}>{job.error.message}</div>}
      {!job.error && job.warnings.slice(0, 2).map(warning => <div key={warning} className="mt-2 text-[11px]" style={{ color: 'var(--color-warning)' }}>{warning}</div>)}
    </div>
  )
}

function ScenePreview({ project, scene }: { project: VideoProject; scene?: VideoScene }) {
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
      {scene.dialogue?.state !== 'deleted' && scene.dialogue?.display_text && (
        <div className="pointer-events-none absolute bottom-[12%] left-[8%] right-[8%] text-center text-[14px] font-semibold text-white" style={{ textShadow: '0 1px 4px #000, 0 0 2px #000' }}>{scene.dialogue.display_text}</div>
      )}
      {visibleGraphics.map(graphic => (
        <div key={graphic.id} className={`pointer-events-none absolute left-[8%] right-[8%] text-center font-semibold text-white ${graphic.anchor === 'top' || graphic.anchor === 'upper' ? 'top-[9%]' : 'bottom-[9%]'}`} style={{ textShadow: '0 1px 4px #000' }}>{graphic.text}</div>
      ))}
      {project.brand.logo_path && <img src={videoApi.brandLogoUrl(project.project_id)} alt="" className="pointer-events-none absolute right-[6%] top-[6%] max-h-[14%] max-w-[18%] object-contain" />}
      {project.brand.cta_text && scene.order === project.scenes.filter(item => !item.deleted)[project.scenes.filter(item => !item.deleted).length - 1]?.order && !visibleGraphics.some(graphic => graphic.role === 'cta') && <div className="pointer-events-none absolute bottom-[8%] left-[12%] right-[12%] text-center text-[13px] font-semibold text-white" style={{ textShadow: '0 1px 4px #000' }}>{project.brand.cta_text}</div>}
      <div className="absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: '#0009' }}>{source.name} · {formatDuration(range.out_ms - range.in_ms)}</div>
      {separateAudio && <div className="absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: '#0009' }}>画面覆盖中 · 保留 {audioSource?.name} 音频</div>}
    </div>
  )
}

function SourceBasket({ project, onOperation, onRelocate }: { project: VideoProject; onOperation: (operation: VideoOperation) => void; onRelocate: (sourceId: string) => void }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>
        <span>素材篮</span><span style={{ color: 'var(--color-text-tertiary)' }}>{project.sources.length}</span>
      </div>
      <div className="max-h-[58vh] space-y-2 overflow-auto pr-1" data-testid="video-source-basket">
        {project.sources.map(source => (
          <div key={source.id} className="rounded-md p-2" style={{ border: '1px solid var(--color-border)', opacity: source.excluded ? 0.55 : 1 }}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-[12px]" title={source.file_uri} style={{ color: 'var(--color-text-primary)' }}>{source.name}</div>
              <button type="button" title={source.favorite ? '取消优先' : '优先使用'} onClick={() => onOperation({ type: 'source.set_favorite', source_id: source.id, favorite: !source.favorite })} className="rounded px-1 text-[13px]" style={{ color: source.favorite ? 'var(--color-brand)' : 'var(--color-text-tertiary)' }}>★</button>
              <button type="button" title={source.excluded ? '恢复素材' : '暂不使用'} onClick={() => onOperation({ type: 'source.set_excluded', source_id: source.id, excluded: !source.excluded })} className="rounded px-1" style={{ color: 'var(--color-text-tertiary)' }}><IconTrash size={13} /></button>
            </div>
            <div className="mt-1 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>{formatDuration(source.duration_ms)}{source.has_audio === false ? ' · 无音轨' : ''}{source.missing ? ' · 素材离线' : ''}</div>
            <select value={source.role} onChange={event => onOperation({ type: 'source.set_role', source_id: source.id, role: event.target.value as VideoSourceRole })}
              className="mt-1.5 w-full rounded-md px-1.5 py-1 text-[11px] outline-none" style={inputStyle} aria-label={`${source.name} 素材角色`}>
              {VIDEO_SOURCE_ROLES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {source.warnings.slice(0, 2).map(warning => <div key={warning} className="mt-1 text-[10px]" style={{ color: 'var(--color-warning)' }}>{warning}</div>)}
            {source.missing && <button type="button" onClick={() => onRelocate(source.id)} className="mt-1.5 rounded-md px-2 py-1 text-[10px]" style={subtleButtonStyle}>重新定位原素材</button>}
          </div>
        ))}
      </div>
    </section>
  )
}

function SceneEditor({
  scene,
  nextScene,
  project,
  view,
  selected,
  onSelect,
  onOperation,
}: {
  scene: VideoScene
  nextScene?: VideoScene
  project: VideoProject
  view: View
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
            <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-tertiary)' }}>{CLOCK_LABELS[scene.edit_clock]}</span>
            {scene.locked_by_user && <span title="已锁定">◆</span>}
          </div>
          <div className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>{currentSource?.name ?? '素材离线'} · {formatDuration(sceneDuration(scene))}</div>
        </button>
        <div className="flex gap-1">
          <button type="button" title="前移" disabled={scene.order === 0} onClick={event => { event.stopPropagation(); onOperation({ type: 'scene.move', scene_id: scene.id, to_index: Math.max(0, scene.order - 1) }) }} className="h-6 w-6 rounded text-[13px] disabled:opacity-30" style={subtleButtonStyle}>↑</button>
          <button type="button" title="后移" disabled={scene.order >= project.scenes.length - 1} onClick={event => { event.stopPropagation(); onOperation({ type: 'scene.move', scene_id: scene.id, to_index: scene.order + 1 }) }} className="h-6 w-6 rounded text-[13px] disabled:opacity-30" style={subtleButtonStyle}>↓</button>
          <button type="button" title={scene.deleted ? '恢复 Scene' : '删除 Scene'} onClick={event => { event.stopPropagation(); onOperation(scene.deleted ? { type: 'scene.restore', scene_id: scene.id } : { type: 'scene.delete', scene_id: scene.id }) }} className="h-6 w-6 rounded text-[13px]" style={subtleButtonStyle} data-testid="video-scene-delete">{scene.deleted ? '＋' : '×'}</button>
        </div>
      </div>

      {view === 'talking' && scene.dialogue && (
        <div className="mt-2" onClick={event => event.stopPropagation()}>
          <div className="rounded-md px-2 py-1.5 text-[11px] leading-relaxed" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-tertiary)' }}><span className="font-medium">识别原文：</span>{scene.dialogue.original_text || '这段没有可用 ASR 原文'}</div>
          <label className="mt-1.5 block text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>修正后的语义文本
            <textarea value={semantic} onChange={event => setSemantic(event.target.value)} rows={2} className="mt-1 w-full resize-none rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} aria-label={`Scene ${scene.order + 1} 语义文本`} />
          </label>
          <label className="mt-1.5 block text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>最终显示字幕
            <textarea value={caption} onChange={event => setCaption(event.target.value)} rows={2} className="mt-1 w-full resize-none rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} aria-label={`Scene ${scene.order + 1} 显示字幕`} />
          </label>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => onOperation({ type: 'dialogue.set_semantic', scene_id: scene.id, semantic_text: semantic })} disabled={semantic === scene.dialogue?.semantic_text} className="rounded-md px-2 py-1 text-[11px] disabled:opacity-35" style={subtleButtonStyle}>保存语义</button>
            <button type="button" onClick={() => onOperation({ type: 'dialogue.set_display', scene_id: scene.id, display_text: caption })} disabled={caption === scene.dialogue?.display_text} className="rounded-md px-2 py-1 text-[11px] disabled:opacity-35" style={subtleButtonStyle}>保存字幕</button>
            {scene.dialogue.origin === 'transcript' && <button type="button" onClick={() => onOperation({ type: 'dialogue.set_state', scene_id: scene.id, state: scene.dialogue?.state === 'deleted' ? 'kept' : 'deleted' })} className="rounded-md px-2 py-1 text-[11px]" style={subtleButtonStyle}>{scene.dialogue.state === 'deleted' ? '恢复段落' : '删除段落'}</button>}
            {scene.dialogue.take_options.length > 0 && <select value={scene.dialogue.take_id ?? ''} onChange={event => event.target.value && onOperation({ type: 'dialogue.select_take', scene_id: scene.id, take_id: event.target.value })} className="rounded-md px-1.5 py-1 text-[11px]" style={inputStyle} aria-label="选择 Take"><option value="">选择 Take</option>{scene.dialogue.take_options.map(take => <option key={take.id} value={take.id}>{take.label}</option>)}</select>}
            <select value={broll?.source_range.source_id ?? ''} onChange={event => onOperation({ type: 'scene.set_broll', scene_id: scene.id, source_range: event.target.value ? rangeFor(event.target.value) : undefined })} className="min-w-0 rounded-md px-1.5 py-1 text-[11px]" style={inputStyle} aria-label="插入环境画面">
              <option value="">不覆盖环境画面</option>
              {project.sources.filter(source => !source.excluded && source.role !== 'talking_take' && source.role !== 'live_longform').map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
          </div>
          {scene.replacement_candidates.length > 0 && <div className="mt-2 grid gap-1.5 min-[760px]:grid-cols-3" data-testid="video-broll-candidates">{scene.replacement_candidates.map(candidate => <button key={candidate.id} type="button" onClick={() => onOperation({ type: 'scene.set_broll', scene_id: scene.id, source_range: candidate.source_range })} className="rounded-md px-2 py-1.5 text-left text-[10px]" style={subtleButtonStyle}><span className="block truncate" style={{ color: 'var(--color-text-secondary)' }}>{project.sources.find(source => source.id === candidate.source_range.source_id)?.name ?? '候选镜头'}</span><span className="mt-0.5 block leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{candidate.rationale}</span></button>)}</div>}
        </div>
      )}

      {view === 'ambient' && (
        <div className="mt-2 space-y-2" onClick={event => event.stopPropagation()}>
          <select value={primary?.source_range.source_id ?? ''} onChange={event => onOperation({ type: 'scene.replace_source', scene_id: scene.id, source_range: rangeFor(event.target.value) })} className="w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="替换 Scene 素材">
            {project.sources.filter(source => !source.excluded).map(source => <option key={source.id} value={source.id}>{source.name} · {sourceRoleLabel(source.role)}</option>)}
          </select>
          {scene.replacement_candidates.length > 0 && <div className="grid gap-1.5 min-[760px]:grid-cols-3" data-testid="video-shot-candidates">{scene.replacement_candidates.map(candidate => <button key={candidate.id} type="button" onClick={() => onOperation({ type: 'scene.replace_source', scene_id: scene.id, source_range: candidate.source_range })} className="rounded-md px-2 py-1.5 text-left text-[10px]" style={subtleButtonStyle}><span className="block truncate" style={{ color: 'var(--color-text-secondary)' }}>{project.sources.find(source => source.id === candidate.source_range.source_id)?.name ?? '候选镜头'}</span><span className="mt-0.5 block leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{candidate.rationale}</span></button>)}</div>}
          <div className="flex gap-1">
            {(['music', 'action', 'dialogue'] as const).map(clock => <button key={clock} type="button" onClick={() => onOperation({ type: 'scene.set_clock', scene_id: scene.id, edit_clock: clock })} className="rounded-md px-2 py-1 text-[10px]" style={{ background: scene.edit_clock === clock ? 'var(--color-surface-selected)' : 'var(--color-surface-container)', color: scene.edit_clock === clock ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}>{CLOCK_LABELS[clock]}</button>)}
          </div>
          <div className="flex gap-1.5">
            <input value={narration} onChange={event => setNarration(event.target.value)} placeholder="短旁白" className="min-w-0 flex-1 rounded-md px-2 py-1 text-[11px] outline-none" style={inputStyle} data-testid="video-narration-input" />
            <button type="button" disabled={!narration.trim()} onClick={() => { onOperation({ type: 'scene.add_narration', scene_id: scene.id, text: narration.trim(), source_range: narrationRange }); setNarration('') }} className="rounded-md px-2 py-1 text-[11px] disabled:opacity-35" style={subtleButtonStyle} data-testid="video-add-narration">添加</button>
          </div>
          <select value={narrationSourceId} onChange={event => setNarrationSourceId(event.target.value)} className="w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="旁白音频素材" data-testid="video-narration-source"><option value="">只保存旁白文字，稍后绑定音频</option>{narrationSources.map(source => <option key={source.id} value={source.id}>{source.name} · 取当前 Scene 时长</option>)}</select>
          {scene.dialogue?.origin === 'narration' && <button type="button" onClick={() => onOperation({ type: 'scene.remove_narration', scene_id: scene.id })} className="rounded-md px-2 py-1 text-[11px]" style={subtleButtonStyle} data-testid="video-remove-narration">移除短旁白</button>}
        </div>
      )}
      {primary && <div className="mt-2 flex flex-wrap items-end gap-1.5 border-t pt-2" style={{ borderColor: 'var(--color-border)' }} onClick={event => event.stopPropagation()}>
        <label className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>入点（秒）<input type="number" min={0} step={0.1} defaultValue={primary.source_range.in_ms / 1000} key={`${scene.id}-${primary.source_range.in_ms}-in`} onBlur={event => trim('in', Number(event.target.value))} className="ml-1 w-16 rounded px-1 py-0.5 text-[10px]" style={inputStyle} /></label>
        <label className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>出点（秒）<input type="number" min={0.2} step={0.1} defaultValue={primary.source_range.out_ms / 1000} key={`${scene.id}-${primary.source_range.out_ms}-out`} onBlur={event => trim('out', Number(event.target.value))} className="ml-1 w-16 rounded px-1 py-0.5 text-[10px]" style={inputStyle} /></label>
        <button type="button" disabled={primary.source_range.out_ms - primary.source_range.in_ms < 1000} onClick={() => onOperation({ type: 'scene.split', scene_id: scene.id, at_source_ms: Math.round((primary.source_range.in_ms + primary.source_range.out_ms) / 2) })} className="rounded px-2 py-1 text-[10px] disabled:opacity-35" style={subtleButtonStyle} data-testid="video-split-scene">从中间拆分</button>
        <button type="button" disabled={!mergeable || !nextScene} onClick={() => nextScene && onOperation({ type: 'scene.merge', scene_id: scene.id, next_scene_id: nextScene.id })} className="rounded px-2 py-1 text-[10px] disabled:opacity-35" style={subtleButtonStyle} data-testid="video-merge-scene">合并下一段</button>
      </div>}
      {scene.needs_review.slice(0, 2).map(item => <div key={item} className="mt-1.5 text-[10px]" style={{ color: 'var(--color-warning)' }}>{item}</div>)}
    </article>
  )
}

function Alternatives({ alternatives, selectedSceneId, onApply }: { alternatives: VideoAlternative[]; selectedSceneId?: string; onApply: (alternative: VideoAlternative, scope: 'whole' | 'scene') => void }) {
  return (
    <section data-testid="video-alternatives">
      <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>候选方案</div>
      <div className="space-y-2">
        {alternatives.map(alternative => (
          <div key={alternative.id} className="rounded-md p-2.5" style={{ border: '1px solid var(--color-border)' }}>
            <div className="text-[12px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{alternative.name}</div>
            <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{alternative.tradeoff}</div>
            <div className="mt-2 flex gap-1.5">
              <button type="button" onClick={() => onApply(alternative, 'whole')} className="rounded-md px-2 py-1 text-[10px]" style={subtleButtonStyle}>采用整版</button>
              {selectedSceneId && alternative.changed_scene_ids.includes(selectedSceneId) && <button type="button" onClick={() => onApply(alternative, 'scene')} className="rounded-md px-2 py-1 text-[10px]" style={subtleButtonStyle}>只采用当前 Scene</button>}
            </div>
          </div>
        ))}
        {!alternatives.length && <div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>生成草稿后会出现 3 个可解释候选。</div>}
      </div>
    </section>
  )
}

function SceneVisualControls({ scene, onOperation }: { scene: VideoScene; onOperation: (operation: VideoOperation) => void }) {
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
    onOperation({
      type: 'scene.set_crop',
      scene_id: scene.id,
      layer_id: layer.id,
      crop: { ...crop, x, y, width, height, focal_x: nextX, focal_y: nextY },
    })
  }
  return (
    <div className="mt-2 space-y-2" data-testid="video-visual-controls">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>画面适配
          <select value={crop.fit} onChange={event => onOperation({ type: 'scene.set_crop', scene_id: scene.id, layer_id: layer.id, crop: { ...crop, fit: event.target.value as 'contain' | 'cover' } })} className="mt-1 w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} data-testid="video-crop-fit"><option value="contain">完整显示</option><option value="cover">铺满画面</option></select>
        </label>
        <label className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>播放速度
          <select value={String(layer.speed)} onChange={event => onOperation({ type: 'scene.set_speed', scene_id: scene.id, layer_id: layer.id, speed: Number(event.target.value) })} className="mt-1 w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} data-testid="video-speed"><option value="0.75">0.75x</option><option value="1">1x 原速</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option></select>
        </label>
      </div>
      <label className="block text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>构图缩放 {zoom.toFixed(2)}x
        <input type="range" min={1} max={2.5} step={0.05} value={zoom} onChange={event => setZoom(Number(event.target.value))} onPointerUp={() => commitCrop()} onKeyUp={event => { if (event.key.startsWith('Arrow')) commitCrop() }} onBlur={() => commitCrop()} className="mt-1 w-full" data-testid="video-crop-zoom" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>左右焦点
          <input type="range" min={0} max={1} step={0.01} value={focalX} onChange={event => setFocalX(Number(event.target.value))} onPointerUp={() => commitCrop()} onKeyUp={event => { if (event.key.startsWith('Arrow')) commitCrop() }} onBlur={() => commitCrop()} className="mt-1 w-full" data-testid="video-crop-x" />
        </label>
        <label className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>上下焦点
          <input type="range" min={0} max={1} step={0.01} value={focalY} onChange={event => setFocalY(Number(event.target.value))} onPointerUp={() => commitCrop()} onKeyUp={event => { if (event.key.startsWith('Arrow')) commitCrop() }} onBlur={() => commitCrop()} className="mt-1 w-full" data-testid="video-crop-y" />
        </label>
      </div>
    </div>
  )
}

export function VideoStudioPage() {
  const [projects, setProjects] = useState<VideoProject[]>([])
  const [project, setProject] = useState<VideoProject | null>(null)
  const [paths, setPaths] = useState<string[]>([])
  const [goalText, setGoalText] = useState('')
  const [view, setViewState] = useState<View>('talking')
  const [contentType, setContentType] = useState<VideoContentType>('freeform')
  const [ratio, setRatio] = useState<'9:16' | '1:1' | '16:9'>('9:16')
  const [durationSec, setDurationSec] = useState(30)
  const [exactCopyText, setExactCopyText] = useState('')
  const [briefResult, setBriefResult] = useState<VideoBriefCompileResponse | null>(null)
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null)
  const [job, setJob] = useState<VideoJob | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [compactPane, setCompactPane] = useState<CompactPane>('workspace')
  const [renderUrl, setRenderUrl] = useState('')
  const [musicLicense, setMusicLicense] = useState('')
  const [briefEditing, setBriefEditing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const scenes = useMemo(() => project?.scenes.slice().sort((a, b) => a.order - b.order) ?? [], [project?.scenes])
  const selectedScene = scenes.find(scene => scene.id === selectedSceneId) ?? scenes.find(scene => !scene.deleted) ?? scenes[0]
  const recommendedView = briefResult?.brief.preferred_view ?? project?.creative_brief?.preferred_view
  const canCreate = paths.length > 0 && goalText.trim().length > 0 && !busy
  const canDraft = Boolean(project?.creative_brief) && !busy

  const reloadProjects = useCallback(async () => {
    const list = await videoApi.listProjects()
    setProjects(list)
    return list
  }, [])

  useEffect(() => { void reloadProjects().catch(() => undefined) }, [reloadProjects])

  const acceptProject = useCallback((next: VideoProject) => {
    setProject(next)
    setProjects(items => [next, ...items.filter(item => item.project_id !== next.project_id)])
    setViewState(next.goal)
    setRatio(next.canvas.ratio)
    setGoalText(next.creative_brief?.user_request ?? '')
    setContentType(next.creative_brief?.content_type ?? 'freeform')
    if (next.creative_brief?.target_duration_ms) setDurationSec(Math.round(next.creative_brief.target_duration_ms / 1000))
    setExactCopyText(next.creative_brief?.exact_copy.join('\n') ?? '')
    setMusicLicense(next.music.license_id ?? '')
    setSelectedSceneId(current => next.scenes.some(scene => scene.id === current) ? current : next.scenes.find(scene => !scene.deleted)?.id ?? next.scenes[0]?.id ?? null)
  }, [])

  const refreshProject = useCallback(async (projectId: string) => {
    const next = await videoApi.getProject(projectId)
    acceptProject(next)
    return next
  }, [acceptProject])

  const compileUnderstanding = useCallback(async (projectId: string) => {
    const result = await videoApi.compileBrief(projectId, {
      base_revision: project?.project_id === projectId ? project.revision : undefined,
      user_request: goalText.trim(),
      content_type: contentType,
      preferred_view: view,
      ratio,
      target_duration_ms: durationSec * 1000,
      exact_copy: exactCopyText.split(/\r?\n|，/).map(item => item.trim()).filter(Boolean),
    })
    setBriefResult(result)
    await refreshProject(projectId)
    return result
  }, [contentType, durationSec, exactCopyText, goalText, project?.project_id, project?.revision, ratio, refreshProject, view])

  const watchJob = useCallback(async (jobId: string, projectId: string) => {
    const controller = new AbortController()
    abortRef.current = controller
    const final = await pollVideoJob(jobId, { signal: controller.signal, onChange: setJob })
    if (abortRef.current === controller) abortRef.current = null
    if (final.status === 'error' || final.status === 'interrupted') throw new Error(final.error?.message ?? final.warnings[0] ?? '视频任务没有完成')
    if (final.status === 'cancelled') return final
    await refreshProject(projectId)
    setJob(null)
    return final
  }, [refreshProject])

  const pickVideos = async () => {
    const selected = await getDesktopHost().pickVideoFiles?.()
    if (selected?.length) setPaths(current => [...new Set([...current, ...selected])])
  }

  const createProject = async () => {
    if (!canCreate) return
    setBusy(true); setError(''); setRenderUrl('')
    try {
      const created = await videoApi.createProject({ name: goalText.trim().slice(0, 80), video_paths: paths, goal: view, user_request: goalText.trim(), content_type: contentType, ratio, target_duration_ms: durationSec * 1000 })
      acceptProject(created.project)
      setJob(await videoApi.getJob(created.analysis_job.job_id))
      await watchJob(created.analysis_job.job_id, created.project.project_id)
      await compileUnderstanding(created.project.project_id)
      setCompactPane('workspace')
    } catch (cause) {
      const message = errorMessage(cause); setError(message); toast(message)
    } finally { setBusy(false) }
  }

  const generateDrafts = async () => {
    if (!project || !canDraft) return
    setBusy(true); setError('')
    try {
      await compileUnderstanding(project.project_id)
      const started = await videoApi.drafts(project.project_id)
      setJob(await videoApi.getJob(started.job_id))
      await watchJob(started.job_id, project.project_id)
      setCompactPane('workspace')
    } catch (cause) {
      const message = errorMessage(cause); setError(message); toast(message)
    } finally { setBusy(false) }
  }

  const applyOperation = async (operation: VideoOperation) => {
    if (!project || busy) return
    setBusy(true); setError('')
    try {
      const result = await videoApi.applyOperations(project.project_id, project.revision, [operation])
      acceptProject(result.project)
    } catch (cause) {
      await refreshProject(project.project_id).catch(() => undefined)
      const message = errorMessage(cause); setError(message); toast(message)
    } finally { setBusy(false) }
  }

  const setView = async (next: View) => {
    setViewState(next)
    if (project && project.goal !== next) await applyOperation({ type: 'project.set_view', goal: next })
  }

  const undoRedo = async (kind: 'undo' | 'redo') => {
    if (!project || busy) return
    setBusy(true)
    try { acceptProject(await videoApi[kind](project.project_id, project.revision)) }
    catch (cause) { toast(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  const applyAlternative = async (alternative: VideoAlternative, scope: 'whole' | 'scene') => {
    if (!project || busy) return
    setBusy(true)
    try { acceptProject(await videoApi.applyAlternative(project.project_id, alternative.id, project.revision, scope, scope === 'scene' ? selectedScene?.id : undefined)) }
    catch (cause) { toast(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  const render = async (preview: boolean) => {
    if (!project || !project.scenes.length || busy) return
    setBusy(true); setError(''); setRenderUrl('')
    try {
      const started = await videoApi.render(project.project_id, { revision: project.revision, preview, scene_id: preview ? selectedScene?.id : undefined, include_music: true, include_subtitles: true })
      setJob(await videoApi.getJob(started.job_id))
      const final = await watchJob(started.job_id, project.project_id)
      const path = typeof final.result?.video_url === 'string' ? final.result.video_url : ''
      if (!path) throw new Error('导出完成但没有返回视频文件')
      setRenderUrl(videoApi.assetUrl(path))
    } catch (cause) {
      const message = errorMessage(cause); setError(message); toast(message)
    } finally { setBusy(false) }
  }

  const cancelJob = async () => {
    if (!job) return
    await videoApi.cancelJob(job.id).then(setJob).catch(() => undefined)
    abortRef.current?.abort()
    setBusy(false)
  }

  const retryJob = async () => {
    if (!job || !project) return
    setBusy(true); setError('')
    try {
      const started = await videoApi.retryJob(job.id)
      setJob(await videoApi.getJob(started.job_id))
      const final = await watchJob(started.job_id, project.project_id)
      if (final.kind === 'render' && typeof final.result?.video_url === 'string') setRenderUrl(videoApi.assetUrl(final.result.video_url))
    } catch (cause) { const message = errorMessage(cause); setError(message); toast(message) }
    finally { setBusy(false) }
  }

  const pickMusic = async () => {
    if (!project) return
    const picked = await getDesktopHost().pickPaths?.()
    const path = picked?.find(item => /\.(mp3|wav|m4a|aac|flac)$/i.test(item))
    if (!path) return toast('请选择一个音频文件')
    if (!musicLicense.trim()) return toast('先填写音乐授权 ID 或来源编号')
    await applyOperation({ type: 'project.set_music', music: { ...project.music, path, license_id: musicLicense.trim(), enabled: true } })
  }

  const relocateSource = async (sourceId: string) => {
    const selected = await getDesktopHost().pickVideoFiles?.()
    const path = selected?.[0]
    if (!path) return
    await applyOperation({ type: 'source.relocate', source_id: sourceId, file_uri: path })
  }

  const pickLogo = async () => {
    if (!project) return
    const picked = await getDesktopHost().pickPaths?.()
    const path = picked?.find(item => /\.(png|jpe?g|webp)$/i.test(item))
    if (!path) return toast('请选择 Logo 图片')
    await applyOperation({ type: 'project.set_brand', brand: { ...project.brand, logo_path: path } })
  }

  const setGraphicText = async (text: string) => {
    if (!selectedScene) return
    const current = selectedScene.graphics.find(item => item.role !== 'subtitle')
    const duration = sceneDuration(selectedScene)
    const graphic = current
      ? { ...current, text }
      : { id: `graphic-${crypto.randomUUID().slice(0, 8)}`, intent: '显示用户确认的文字', role: 'title' as const, text, anchor: 'top' as const, enter_ms: 120, hold_ms: Math.max(400, duration - 240), exit_ms: 120, priority: 80, exclusive_group: 'top-copy', safe_regions: ['top' as const], style_token: 'neutral-readable' }
    const graphics = [...selectedScene.graphics.filter(item => item.id !== current?.id), graphic].filter(item => item.text?.trim())
    await applyOperation({ type: 'scene.set_graphics', scene_id: selectedScene.id, graphics })
  }

  const openProject = async (id: string) => {
    setBusy(true); setError(''); setBriefResult(null); setRenderUrl('')
    try { acceptProject(await videoApi.getProject(id)); setCompactPane('workspace') }
    catch (cause) { toast(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  const newProject = () => {
    setProject(null); setBriefResult(null); setPaths([]); setGoalText(''); setExactCopyText(''); setJob(null); setRenderUrl(''); setError(''); setSelectedSceneId(null); setBriefEditing(false)
  }

  const renderInspector = project && (
    <div className="space-y-5">
      <Alternatives alternatives={project.alternatives} selectedSceneId={selectedScene?.id} onApply={applyAlternative} />
      {selectedScene && <section className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        <div className="mb-2 flex items-center justify-between text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><span>当前 Scene</span><span>{selectedScene.order + 1}</span></div>
        <button type="button" onClick={() => void applyOperation({ type: 'scene.set_locked', scene_id: selectedScene.id, locked: !selectedScene.locked_by_user })} className="w-full rounded-md px-2 py-1.5 text-[11px]" style={subtleButtonStyle}>{selectedScene.locked_by_user ? '解除锁定' : '锁定已确认内容'}</button>
        <label className="mt-2 block text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>图形文字
          <input defaultValue={selectedScene.graphics.find(item => item.role !== 'subtitle')?.text ?? ''} key={`${selectedScene.id}-graphic`} onBlur={event => void setGraphicText(event.target.value.trim())} className="mt-1 w-full rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} placeholder="标题、强调或 CTA" />
        </label>
        <label className="mt-2 block text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>转场
          <select value={selectedScene.transition_in.kind} onChange={event => void applyOperation({ type: 'scene.set_transition', scene_id: selectedScene.id, transition: event.target.value === 'dissolve' ? { kind: 'dissolve', duration_ms: 300, reason: '用户选择柔和连接相邻 Scene' } : { kind: 'cut', duration_ms: 0 } })} className="mt-1 w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle}><option value="cut">直接切</option><option value="dissolve">柔和叠化</option></select>
        </label>
        <SceneVisualControls scene={selectedScene} onOperation={operation => void applyOperation(operation)} />
      </section>}
      <section className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>品牌与音乐</div>
        <label className="block text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>项目名称<input defaultValue={project.name} key={`${project.project_id}-${project.name}`} onBlur={event => event.target.value.trim() && event.target.value.trim() !== project.name && void applyOperation({ type: 'project.set_name', name: event.target.value.trim() })} className="mt-1 w-full rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} /></label>
        <select value={project.brand.preset} onChange={event => void applyOperation({ type: 'project.set_brand', brand: { ...project.brand, preset: event.target.value as 'neutral' | 'clean' | 'energetic' } })} className="w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="品牌样式"><option value="neutral">中性</option><option value="clean">简洁</option><option value="energetic">有活力</option></select>
        <button type="button" onClick={() => void pickLogo()} className="mt-2 w-full rounded-md px-2 py-1.5 text-[11px]" style={subtleButtonStyle}>{project.brand.logo_path ? '更换 Logo' : '添加 Logo'}</button>
        <input defaultValue={project.brand.cta_text ?? ''} key={`${project.project_id}-${project.brand.cta_text ?? ''}`} onBlur={event => event.target.value.trim() !== (project.brand.cta_text ?? '') && void applyOperation({ type: 'project.set_brand', brand: { ...project.brand, cta_text: event.target.value.trim() || undefined } })} placeholder="片尾 CTA（可选）" className="mt-2 w-full rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} />
        <input value={musicLicense} onChange={event => setMusicLicense(event.target.value)} placeholder="音乐授权 ID / 来源编号" className="mt-2 w-full rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} />
        <button type="button" onClick={() => void pickMusic()} className="mt-2 w-full rounded-md px-2 py-1.5 text-[11px]" style={subtleButtonStyle}>{project.music.path ? '更换已授权音乐' : '选择已授权音乐'}</button>
        {project.music.path && <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" onClick={() => void applyOperation({ type: 'project.set_music', music: { ...project.music, enabled: !project.music.enabled } })} className="rounded-md px-2 py-1.5 text-[11px]" style={subtleButtonStyle}>{project.music.enabled ? '关闭音乐' : '启用音乐'}</button><button type="button" onClick={() => void applyOperation({ type: 'project.set_music', music: { energy: project.music.energy, enabled: false } })} className="rounded-md px-2 py-1.5 text-[11px]" style={subtleButtonStyle}>移除音乐</button></div>}
        <select value={project.music.energy} onChange={event => void applyOperation({ type: 'project.set_audio_intent', energy: event.target.value as 'calm' | 'natural' | 'lively' | 'crisp', music_enabled: project.music.enabled })} className="mt-2 w-full rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="音乐能量"><option value="calm">舒缓</option><option value="natural">自然</option><option value="lively">活力</option><option value="crisp">利落</option></select>
      </section>
      <section className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>导出</div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={busy || !scenes.length || !selectedScene} onClick={() => void render(true)} className="rounded-md px-2 py-2 text-[11px] disabled:opacity-40" style={subtleButtonStyle} data-testid="video-preview-render">当前 Scene 精确预览</button>
          <button type="button" disabled={busy || !scenes.length} onClick={() => void render(false)} className="rounded-md px-2 py-2 text-[11px] font-medium disabled:opacity-40" style={primaryButtonStyle} data-testid="video-final-render">正式导出</button>
        </div>
        {renderUrl && <a href={renderUrl} download className="mt-2 block rounded-md px-2 py-2 text-center text-[11px]" style={subtleButtonStyle} data-testid="video-download">下载 MP4</a>}
      </section>
    </div>
  )

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="video-studio-page">
      <div className={`mx-auto min-h-full w-full ${project ? 'max-w-[1600px] px-4 py-5 min-[840px]:px-6' : 'max-w-[860px] px-4 py-7 min-[840px]:px-8'}`}>
        <PageHeader title="剪视频工作台" action={project ? <div className="flex gap-1.5"><button type="button" onClick={() => void undoRedo('undo')} disabled={busy} title="撤销" className="h-8 w-8 rounded-md disabled:opacity-35" style={subtleButtonStyle} data-testid="video-undo">↶</button><button type="button" onClick={() => void undoRedo('redo')} disabled={busy} title="重做" className="h-8 w-8 rounded-md disabled:opacity-35" style={subtleButtonStyle} data-testid="video-redo">↷</button><button type="button" onClick={newProject} className="rounded-md px-2.5 py-1.5 text-[12px]" style={subtleButtonStyle}>新项目</button></div> : undefined} />

        {!project && <>
          <ModeTabs value={view} onChange={next => setViewState(next)} />
          <div className="mt-5 flex flex-col rounded-[22px]" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', boxShadow: 'var(--shadow-input)' }}>
            <textarea value={goalText} onChange={event => setGoalText(event.target.value)} rows={3} className="resize-none bg-transparent px-4 pt-3.5 text-[13px] leading-relaxed outline-none" style={{ color: 'var(--color-text-primary)' }} placeholder={view === 'talking' ? '说清楚这条视频要讲什么' : '说说希望这批素材呈现什么感觉'} data-testid="video-goal-input" />
            <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5 pt-1.5">
              <select value={contentType} onChange={event => setContentType(event.target.value as VideoContentType)} className="max-w-[145px] rounded-md bg-transparent px-2 py-1.5 text-[12px] outline-none" style={{ color: 'var(--color-text-secondary)' }} aria-label="内容类型">{VIDEO_CONTENT_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
              <button type="button" onClick={() => void pickVideos()} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px]" style={{ color: 'var(--color-text-secondary)' }} data-testid="video-pick-files"><IconFolderOpen size={14} />选择视频</button>
              <span className="min-w-0 flex-1" />
              <button type="button" onClick={() => void createProject()} disabled={!canCreate} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium disabled:opacity-35" style={primaryButtonStyle} data-testid="video-create-project"><IconSparkles size={14} />开始分析</button>
            </div>
          </div>
          {paths.length > 0 && <div className="mt-3 space-y-1" data-testid="video-imported-files">{paths.map(path => <div key={path} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-secondary)' }}><span className="min-w-0 flex-1 truncate">{path.split(/[\\/]/).pop()}</span><button type="button" title="移除" onClick={() => setPaths(items => items.filter(item => item !== path))}><IconTrash size={13} /></button></div>)}</div>}
          <details className="mt-4 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}><summary className="cursor-pointer text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>输出与硬文字</summary><div className="mt-2 grid grid-cols-1 gap-2 min-[560px]:grid-cols-3"><select value={ratio} onChange={event => setRatio(event.target.value as typeof ratio)} className="min-w-0 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle}><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="16:9">16:9</option></select><input type="number" min={3} max={1800} value={durationSec} onChange={event => setDurationSec(Math.max(3, Math.min(1800, Number(event.target.value) || 30)))} className="min-w-0 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="目标时长（秒）" /><input value={exactCopyText} onChange={event => setExactCopyText(event.target.value)} className="min-w-0 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} placeholder="必须准确显示的文字" /></div></details>
          {projects.length > 0 && <section className="mt-8"><div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>最近项目</div><div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>{projects.slice(0, 8).map(item => <button key={item.project_id} type="button" onClick={() => void openProject(item.project_id)} className="flex w-full items-center gap-3 py-2.5 text-left" data-testid="video-project-item"><span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: 'var(--color-text-primary)' }}>{item.name}</span><span className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>{item.goal === 'talking' ? '口播' : '环境'} · {item.scenes.length} Scenes</span></button>)}</div></section>}
        </>}

        {project && <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <ModeTabs value={view} recommended={recommendedView} onChange={next => void setView(next)} />
            <div className="flex items-center gap-2"><select value={project.canvas.ratio} onChange={event => void applyOperation({ type: 'project.set_canvas', ratio: event.target.value as '9:16' | '1:1' | '16:9' })} className="rounded-md px-2 py-1 text-[11px]" style={inputStyle} aria-label="项目画幅"><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="16:9">16:9</option></select><div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>revision {project.revision} · {project.status.save_state === 'saved' ? '已保存' : project.status.save_state}</div></div>
          </div>
          <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg p-1 min-[1180px]:hidden" style={{ background: 'var(--color-surface-container)' }} role="tablist" aria-label="视频工作台区域">{([['sources', '素材'], ['workspace', view === 'talking' ? '文字稿' : '故事板'], ['inspector', '调整']] as const).map(([pane, label]) => <button key={pane} type="button" role="tab" aria-selected={compactPane === pane} onClick={() => setCompactPane(pane)} className="rounded-md px-2 py-1.5 text-[12px]" style={{ background: compactPane === pane ? 'var(--color-surface)' : 'transparent', color: 'var(--color-text-secondary)' }}>{label}</button>)}</div>
          {job && <div className="mb-4"><JobBar job={job} onCancel={() => void cancelJob()} onRetry={() => void retryJob()} /></div>}
          {error && <div className="mb-4 flex items-center gap-2 rounded-md px-3 py-2 text-[12px]" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-error)', border: '1px solid var(--color-border)' }}><IconAlertCircle size={14} />{error}</div>}
          <div className="grid min-h-0 grid-cols-1 gap-5 min-[1180px]:grid-cols-[250px_minmax(0,1fr)_290px]">
            <aside className={`${compactPane === 'sources' ? 'block' : 'hidden min-[1180px]:block'} min-w-0 space-y-5`}>
              <div className="flex items-center justify-between"><select value={project.project_id} onChange={event => void openProject(event.target.value)} className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-[11px]" style={inputStyle} aria-label="当前视频项目">{projects.map(item => <option key={item.project_id} value={item.project_id}>{item.name}</option>)}</select><button type="button" title="刷新项目" onClick={() => void refreshProject(project.project_id)} className="ml-1 h-7 w-7 rounded-md" style={subtleButtonStyle}><IconRefresh size={13} /></button></div>
              <SourceBasket project={project} onOperation={operation => void applyOperation(operation)} onRelocate={sourceId => void relocateSource(sourceId)} />
            </aside>
            <main className={`${compactPane === 'workspace' ? 'block' : 'hidden min-[1180px]:block'} min-w-0 space-y-4`}>
              {project.creative_brief && <section className="rounded-md p-3" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }} data-testid="video-brief-understanding"><div className="flex items-start gap-2"><IconCheckCircle size={14} className="mt-0.5" style={{ color: 'var(--color-success)' }} /><div className="min-w-0 flex-1"><div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{project.name}</div><div className="mt-0.5 text-[12px]" style={{ color: 'var(--color-text-primary)' }}>{project.creative_brief.understanding}</div>{(briefResult?.missing_facts ?? (project.creative_brief.content_type === 'offer_conversion' && project.creative_brief.exact_copy.length === 0 ? ['活动价格、权益、时间或 CTA 尚未由用户确认'] : [])).map(item => <div key={item} className="mt-1 text-[10px]" style={{ color: 'var(--color-warning)' }}>{item}</div>)}{project.status.missing_coverage.map(item => <div key={item} className="mt-1 text-[10px]" style={{ color: 'var(--color-warning)' }}>建议补拍或调整结构：{coverageLabel(item)}</div>)}</div><button type="button" onClick={() => setBriefEditing(value => !value)} title="修改内容理解" className="rounded-md px-2 py-1 text-[10px]" style={subtleButtonStyle}><IconEdit size={12} /></button></div>{briefEditing && <div className="mt-3 grid gap-2 border-t pt-3 min-[760px]:grid-cols-2" style={{ borderColor: 'var(--color-border)' }} data-testid="video-brief-editor"><textarea value={goalText} onChange={event => setGoalText(event.target.value)} rows={3} className="min-[760px]:col-span-2 resize-none rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} /><select value={contentType} onChange={event => setContentType(event.target.value as VideoContentType)} className="rounded-md px-2 py-1.5 text-[11px]" style={inputStyle}>{VIDEO_CONTENT_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><input value={exactCopyText} onChange={event => setExactCopyText(event.target.value)} placeholder="必须准确显示的文字，每行一条" className="rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} /><div className="min-[760px]:col-span-2 flex justify-end"><button type="button" disabled={!goalText.trim() || busy} onClick={() => void compileUnderstanding(project.project_id).then(() => setBriefEditing(false))} className="rounded-md px-3 py-1.5 text-[11px] font-medium disabled:opacity-40" style={primaryButtonStyle}>更新理解</button></div></div>}</section>}
              {project.status.warnings.length > 0 && <details className="rounded-md px-3 py-2" style={{ border: '1px solid var(--color-border)' }}><summary className="cursor-pointer text-[11px]" style={{ color: 'var(--color-warning)' }}>项目提醒 {project.status.warnings.length}</summary>{project.status.warnings.map(item => <div key={item} className="mt-1 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>{item}</div>)}</details>}
              {selectedScene && <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}><button type="button" disabled={selectedScene.order <= 0} onClick={() => setSelectedSceneId(scenes[Math.max(0, selectedScene.order - 1)]?.id ?? null)} className="rounded px-2 py-1 disabled:opacity-30" style={subtleButtonStyle}>上一 Scene</button><span>{selectedScene.order + 1}/{scenes.length} · 总时长 {formatDuration(scenes.filter(item => !item.deleted).reduce((sum, item) => sum + sceneDuration(item), 0))}</span><button type="button" disabled={selectedScene.order >= scenes.length - 1} onClick={() => setSelectedSceneId(scenes[Math.min(scenes.length - 1, selectedScene.order + 1)]?.id ?? null)} className="rounded px-2 py-1 disabled:opacity-30" style={subtleButtonStyle}>下一 Scene</button></div>}
              <ScenePreview project={project} scene={selectedScene} />
              {renderUrl && <video src={renderUrl} controls className="max-h-[52vh] w-full rounded-md" style={{ border: '1px solid var(--color-border)' }} data-testid="video-export-preview" />}
              {!scenes.length && <div className="rounded-md py-8 text-center"><button type="button" onClick={() => void generateDrafts()} disabled={!canDraft} className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-[12px] font-medium disabled:opacity-40" style={primaryButtonStyle} data-testid="video-generate-drafts"><IconTarget size={14} />确认理解并生成草稿</button></div>}
              {scenes.length > 0 && <section><div className="mb-2 flex items-center justify-between"><div className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{view === 'talking' ? '文字稿与 Scene' : '故事板'}</div><button type="button" onClick={() => void generateDrafts()} disabled={busy} className="rounded-md px-2 py-1 text-[10px] disabled:opacity-40" style={subtleButtonStyle}>重新生成草稿</button></div><div className="space-y-2" data-testid={view === 'talking' ? 'video-talking-workspace' : 'video-ambient-workspace'}>{scenes.map((scene, index) => <SceneEditor key={scene.id} scene={scene} nextScene={scenes[index + 1]} project={project} view={view} selected={selectedScene?.id === scene.id} onSelect={() => setSelectedSceneId(scene.id)} onOperation={operation => void applyOperation(operation)} />)}</div></section>}
            </main>
            <aside className={`${compactPane === 'inspector' ? 'block' : 'hidden min-[1180px]:block'} min-w-0`}>{renderInspector}</aside>
          </div>
        </>}
      </div>
    </div>
  )
}
