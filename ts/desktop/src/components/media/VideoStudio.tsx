import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Film,
  FolderOpen,
  FolderPlus,
  Loader2,
  Lock,
  Play,
  Plus,
  Save,
  Scissors,
  Square,
  Sparkles,
  Unlock,
  X,
} from 'lucide-react'
import { mediaApi, mediaUserFacingError, type VideoStudioProject } from '../../api/media'
import { getDesktopHost } from '../../lib/desktopHost'
import { useMediaWorkbenchStore } from '../../stores/mediaWorkbenchStore'
import { MediaProjectRail } from './MediaProjectRail'
import { VoiceInputControl } from '../../product/components/VoiceInputControl'
import { productVoiceApi } from '../../product/api/voice'
import type { VoiceConsumerEvidence } from '../../../../shared/contracts/voice'
import { createVideoTimelineState, videoTimelineReducer } from './videoTimelineState'

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(2)
}

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const OUTPUT_PRESETS = {
  portrait: { label: '竖版 9:16', width: 1080, height: 1920, fps: 30 },
  landscape: { label: '横版 16:9', width: 1920, height: 1080, fps: 30 },
  square: { label: '方形 1:1', width: 1080, height: 1080, fps: 30 },
} as const

type OutputPreset = keyof typeof OUTPUT_PRESETS
type OutputFormat = 'mp4' | 'mov'
type EvidenceKind = VideoStudioProject['evidence'][number]['kind']

const EVIDENCE_KIND_LABELS: Record<EvidenceKind, string> = {
  source_role: '素材事实',
  transcript: '语音转写',
  visual: '画面理解',
  audio: '音频理解',
  shot: '镜头识别',
}

function newClipId(): string {
  return `clip_${crypto.randomUUID().replaceAll('-', '')}`
}

function sameTimeline(
  left: VideoStudioProject['timeline'],
  right: VideoStudioProject['timeline'],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function VideoStudio() {
  const projects = useMediaWorkbenchStore(state => state.videoProjects)
  const deletions = useMediaWorkbenchStore(state => state.deletions)
  const activeId = useMediaWorkbenchStore(state => state.activeVideoId)
  const tasks = useMediaWorkbenchStore(state => state.tasks)
  const toolchain = useMediaWorkbenchStore(state => state.toolchain)
  const loading = useMediaWorkbenchStore(state => state.loading)
  const error = useMediaWorkbenchStore(state => state.error)
  const loadProjects = useMediaWorkbenchStore(state => state.loadProjects)
  const loadDeletions = useMediaWorkbenchStore(state => state.loadDeletions)
  const loadToolchain = useMediaWorkbenchStore(state => state.loadToolchain)
  const selectVideo = useMediaWorkbenchStore(state => state.selectVideo)
  const createVideo = useMediaWorkbenchStore(state => state.createVideo)
  const addVideoSource = useMediaWorkbenchStore(state => state.addVideoSource)
  const saveTimeline = useMediaWorkbenchStore(state => state.saveTimeline)
  const selectVideoTimelineVersion = useMediaWorkbenchStore(state => state.selectVideoTimelineVersion)
  const analyzeVideo = useMediaWorkbenchStore(state => state.analyzeVideo)
  const lockVideoScene = useMediaWorkbenchStore(state => state.lockVideoScene)
  const applyVideoAlternative = useMediaWorkbenchStore(state => state.applyVideoAlternative)
  const previewVideo = useMediaWorkbenchStore(state => state.previewVideo)
  const renderVideo = useMediaWorkbenchStore(state => state.renderVideo)
  const cancelTask = useMediaWorkbenchStore(state => state.cancelTask)
  const deleteProject = useMediaWorkbenchStore(state => state.deleteProject)
  const restoreProject = useMediaWorkbenchStore(state => state.restoreProject)
  const subscribeProjectEvents = useMediaWorkbenchStore(state => state.subscribeProjectEvents)
  const clearError = useMediaWorkbenchStore(state => state.clearError)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [draft, setDraft] = useState<VideoStudioProject | null>(null)
  const [creating, setCreating] = useState(false)
  const [projectTitle, setProjectTitle] = useState('')
  const [outputPreset, setOutputPreset] = useState<OutputPreset>('portrait')
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp4')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [voiceEvidence, setVoiceEvidence] = useState<VoiceConsumerEvidence[]>([])
  const [userGoal, setUserGoal] = useState('')
  const [previewSurface, setPreviewSurface] = useState<'source' | 'program'>('source')
  const [evidenceKind, setEvidenceKind] = useState<'all' | EvidenceKind>('all')
  const [evidenceSourceId, setEvidenceSourceId] = useState('all')
  const [evidenceVisibleCount, setEvidenceVisibleCount] = useState(20)
  const [timelineState, dispatchTimeline] = useReducer(videoTimelineReducer, [], createVideoTimelineState)
  const programVideoRef = useRef<HTMLVideoElement>(null)
  const canonicalProjectRef = useRef<VideoStudioProject | null>(null)
  const draftRef = useRef<VideoStudioProject | null>(null)

  const active = useMemo(
    () => projects.find(project => project.id === activeId) ?? null,
    [activeId, projects],
  )
  const selectedSource = active?.sources.find(source => source.id === selectedSourceId) ?? active?.sources[0]
  const task = active?.task_id ? tasks[active.task_id] : undefined
  const previewTask = active?.preview_task_id ? tasks[active.preview_task_id] : undefined
  const taskRunning = task?.status === 'queued' || task?.status === 'running' || task?.status === 'committing'
  const previewRunning = previewTask?.status === 'queued' || previewTask?.status === 'running' || previewTask?.status === 'committing'
  const analyzing = taskRunning && (task?.kind === 'video.analyze' || task?.kind === 'video.plan')
  const rendering = active?.state === 'rendering' || (taskRunning && task?.kind === 'video.render')
  const busy = analyzing || rendering
  const previewStale = Boolean(active?.preview && active.preview.timeline_version_id !== active.current_timeline_version_id)
  const timelineDuration = timelineState.clips.reduce((total, clip) => total + clip.out_ms - clip.in_ms, 0)
  const timelineVersion = active?.timeline_versions.find(version => version.id === active.current_timeline_version_id)
  const undoTimelineVersion = active?.timeline_versions.find(version => version.id === timelineVersion?.parent_version_id)
  const redoTimelineVersion = active?.timeline_versions
    .filter(version => version.parent_version_id === timelineVersion?.id)
    .at(-1)
  const sceneById = useMemo(
    () => new Map((timelineVersion?.scenes ?? []).map(scene => [scene.id, scene])),
    [timelineVersion],
  )
  const filteredEvidence = useMemo(() => (active?.evidence ?? []).filter(item => (
    (evidenceKind === 'all' || item.kind === evidenceKind)
    && (evidenceSourceId === 'all' || item.source_id === evidenceSourceId)
  )), [active?.evidence, evidenceKind, evidenceSourceId])
  const storeError = error ? mediaUserFacingError(new Error(error)) : null
  const projectError = active?.error
    ? mediaUserFacingError({ code: active.error_code })
    : null
  const taskError = task?.error
    ? mediaUserFacingError({ code: task.error_code })
    : null

  useEffect(() => {
    void loadProjects('video')
    void loadDeletions()
    void loadToolchain()
  }, [loadDeletions, loadProjects, loadToolchain])

  useEffect(() => {
    const previousCanonical = canonicalProjectRef.current
    const localDraft = draftRef.current
    const switchedProject = previousCanonical?.id !== active?.id
    canonicalProjectRef.current = active

    if (!active) {
      draftRef.current = null
      dispatchTimeline({ type: 'cancel' })
      dispatchTimeline({ type: 'replace', clips: [] })
      setDraft(null)
      setSelectedSourceId(null)
      setUserGoal('')
      setEvidenceKind('all')
      setEvidenceSourceId('all')
      setEvidenceVisibleCount(20)
      return
    }

    if (switchedProject || !localDraft || localDraft.id !== active.id) {
      draftRef.current = active
      dispatchTimeline({ type: 'cancel' })
      dispatchTimeline({ type: 'replace', clips: active.timeline })
      setDraft(active)
      setSelectedSourceId(active.sources[0]?.id ?? null)
      setUserGoal(active.brief?.user_goal ?? '')
      setEvidenceKind('all')
      setEvidenceSourceId('all')
      setEvidenceVisibleCount(20)
      return
    }

    const localMatchesLatest = sameTimeline(localDraft.timeline, active.timeline)
    const hasUnsavedTimeline = !sameTimeline(localDraft.timeline, previousCanonical?.timeline ?? active.timeline)
    const nextDraft = hasUnsavedTimeline && !localMatchesLatest
      ? { ...active, timeline: localDraft.timeline }
      : active
    draftRef.current = nextDraft
    setDraft(nextDraft)
    if (!hasUnsavedTimeline || localMatchesLatest) {
      dispatchTimeline({ type: 'cancel' })
      dispatchTimeline({ type: 'replace', clips: active.timeline })
    }
  }, [active])

  useEffect(() => {
    setDraft(current => {
      const next = current && current.timeline !== timelineState.clips
        ? { ...current, timeline: timelineState.clips }
        : current
      draftRef.current = next
      return next
    })
  }, [timelineState.clips])

  useEffect(() => {
    if (programVideoRef.current && timelineState.mode === 'scrubbing') {
      programVideoRef.current.currentTime = timelineState.playhead_ms / 1000
    }
  }, [timelineState.mode, timelineState.playhead_ms])

  useEffect(() => {
    if (timelineState.mode === 'idle') return undefined
    const cancelGesture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatchTimeline({ type: 'cancel' })
    }
    window.addEventListener('keydown', cancelGesture)
    return () => window.removeEventListener('keydown', cancelGesture)
  }, [timelineState.mode])

  useEffect(() => {
    let current = true
    if (!active?.id) {
      setVoiceEvidence([])
      return () => { current = false }
    }
    void productVoiceApi.listEvidence({ kind: 'video_evidence', id: active.id })
      .then(evidence => { if (current) setVoiceEvidence(evidence) })
      .catch(() => { if (current) setVoiceEvidence([]) })
    return () => { current = false }
  }, [active?.id])

  useEffect(() => active?.id
    ? subscribeProjectEvents(active.id, 'video')
    : undefined, [active?.id, subscribeProjectEvents])

  const pickSource = async () => {
    if (!active || busy) return
    const picked = await getDesktopHost().dialogs.open({
      multiple: true,
      title: '选择视频素材',
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'webm'] }],
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    for (const path of paths) await addVideoSource(active.id, path)
  }

  const startRender = async () => {
    if (!active || !draft || busy || previewRunning || !toolchain?.ffmpeg.available || !toolchain.ffprobe.available) return
    const outputPath = await getDesktopHost().dialogs.save({
      title: '导出视频',
      defaultPath: `${active.title}.${outputFormat}`,
      filters: outputFormat === 'mov'
        ? [{ name: 'MOV 视频', extensions: ['mov'] }]
        : [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    if (!outputPath) return
    const changed = !sameTimeline(draft.timeline, active.timeline)
    const project = changed ? await saveTimeline(draft) : active
    await renderVideo(project, outputPath)
  }

  const startPreview = async () => {
    if (!active || !draft || rendering || previewRunning || !draft.timeline.length) return
    const changed = !sameTimeline(draft.timeline, active.timeline)
    const project = changed ? await saveTimeline(draft) : active
    await previewVideo(project)
    setPreviewSurface('program')
  }

  const startAnalysis = async () => {
    if (!active || !draft || busy || !userGoal.trim() || !active.sources.length) return
    const changed = !sameTimeline(draft.timeline, active.timeline)
    const project = changed ? await saveTimeline(draft) : active
    await analyzeVideo(project, userGoal.trim())
  }

  const toggleSceneLock = async (sceneId: string, locked: boolean) => {
    if (!active || !draft || busy) return
    const changed = !sameTimeline(draft.timeline, active.timeline)
    const project = changed ? await saveTimeline(draft) : active
    await lockVideoScene(project, sceneId, locked)
  }

  const updateClip = (clipId: string, field: 'in_ms' | 'out_ms', value: number) => {
    if (!draft || busy) return
    dispatchTimeline({
      type: 'replace',
      clips: draft.timeline.map(clip => {
        if (clip.id !== clipId) return clip
        const source = draft.sources.find(item => item.id === clip.source_id)
        if (field === 'in_ms') return { ...clip, in_ms: Math.max(0, Math.min(value, clip.out_ms - 1)) }
        return { ...clip, out_ms: Math.max(clip.in_ms + 1, Math.min(value, source?.duration_ms ?? value)) }
      }),
    })
  }

  const moveClip = (index: number, direction: -1 | 1) => {
    if (!draft || busy) return
    const target = index + direction
    if (target < 0 || target >= draft.timeline.length) return
    const timeline = [...draft.timeline]
    const [clip] = timeline.splice(index, 1)
    timeline.splice(target, 0, clip!)
    dispatchTimeline({ type: 'replace', clips: timeline })
  }

  const removeClip = (clipId: string) => {
    if (!draft || busy) return
    dispatchTimeline({ type: 'replace', clips: draft.timeline.filter(clip => clip.id !== clipId) })
  }

  const appendClip = (sourceId: string) => {
    if (!draft || busy) return
    const source = draft.sources.find(item => item.id === sourceId)
    if (!source) return
    dispatchTimeline({
      type: 'replace',
      clips: [
        ...draft.timeline,
        {
          id: newClipId(),
          source_id: source.id,
          in_ms: 0,
          out_ms: Math.max(1, source.duration_ms),
        },
      ],
    })
  }

  const splitClip = (clipId: string) => {
    if (!draft || busy) return
    const index = draft.timeline.findIndex(clip => clip.id === clipId)
    const clip = draft.timeline[index]
    if (!clip || clip.out_ms - clip.in_ms < 2) return
    const midpoint = Math.floor((clip.in_ms + clip.out_ms) / 2)
    const timeline = [...draft.timeline]
    timeline.splice(
      index,
      1,
      { ...clip, out_ms: midpoint },
      { ...clip, id: newClipId(), in_ms: midpoint },
    )
    dispatchTimeline({ type: 'replace', clips: timeline })
  }

  const beginClipDrag = (event: React.PointerEvent<HTMLDivElement>, clipId: string, index: number, locked: boolean) => {
    if (busy || (event.target as HTMLElement).closest('button,input')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    dispatchTimeline({ type: 'begin_drag', clip_id: clipId, locked })
    const move = (moveEvent: PointerEvent) => {
      dispatchTimeline({ type: 'drag_to', index: index + Math.round((moveEvent.clientX - startX) / 181) })
    }
    const finish = () => {
      event.currentTarget.removeEventListener('pointermove', move)
      dispatchTimeline({ type: 'commit' })
    }
    const cancel = () => {
      event.currentTarget.removeEventListener('pointermove', move)
      dispatchTimeline({ type: 'cancel' })
    }
    event.currentTarget.addEventListener('pointermove', move)
    event.currentTarget.addEventListener('pointerup', finish, { once: true })
    event.currentTarget.addEventListener('pointercancel', cancel, { once: true })
  }

  const beginClipTrim = (
    event: React.PointerEvent<HTMLButtonElement>,
    clip: VideoStudioProject['timeline'][number],
    edge: 'in' | 'out',
    sourceDuration: number,
    locked: boolean,
  ) => {
    if (busy) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const target = event.currentTarget
    const startX = event.clientX
    const startValue = edge === 'in' ? clip.in_ms : clip.out_ms
    dispatchTimeline({ type: 'begin_trim', clip_id: clip.id, edge, locked })
    const move = (moveEvent: PointerEvent) => {
      dispatchTimeline({
        type: 'trim_to',
        milliseconds: Math.round(startValue + (moveEvent.clientX - startX) / 160 * sourceDuration),
        source_duration_ms: sourceDuration,
      })
    }
    const finish = () => {
      target.removeEventListener('pointermove', move)
      dispatchTimeline({ type: 'commit' })
    }
    const cancel = () => {
      target.removeEventListener('pointermove', move)
      dispatchTimeline({ type: 'cancel' })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', finish, { once: true })
    target.addEventListener('pointercancel', cancel, { once: true })
  }

  const beginNew = () => {
    clearError()
    selectVideo(null)
    setProjectTitle('')
    setOutputPreset('portrait')
    setOutputFormat('mp4')
    setCreating(true)
  }

  const createProject = async () => {
    const preset = OUTPUT_PRESETS[outputPreset]
    await createVideo({
      ...(projectTitle.trim() ? { title: projectTitle.trim() } : {}),
      output: { width: preset.width, height: preset.height, fps: preset.fps },
    })
    setCreating(false)
  }

  const removeProject = async (project: { id: string; title: string }) => {
    if (!window.confirm(`删除“${project.title}”？此操作不会删除原始视频素材。`)) return
    setDeletingId(project.id)
    try {
      await deleteProject(project.id, 'video')
      if (project.id === activeId) setCreating(false)
    } finally {
      setDeletingId(null)
    }
  }

  const restoreDeletedProject = async (projectId: string) => {
    setRestoringId(projectId)
    try {
      await restoreProject(projectId)
      setCreating(false)
    } finally {
      setRestoringId(null)
    }
  }

  const restoreTimelineVersion = async (versionId: string) => {
    if (!active || busy || loading || versionId === active.current_timeline_version_id) return
    if (draft && !sameTimeline(draft.timeline, active.timeline) && !window.confirm('恢复历史版本会放弃尚未保存的时间线修改，是否继续？')) return
    await selectVideoTimelineVersion(active.id, active.revision, versionId)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-app-main)]">
      <header className="flex h-11 shrink-0 items-center border-b border-[var(--color-border)] px-3">
        <h1 className="text-[14px] font-semibold text-[var(--color-text-primary)]">剪视频</h1>
        <div className="ml-auto flex items-center gap-1">
          <span className={`mr-2 text-[11px] ${
            toolchain?.ffmpeg.available && toolchain.ffprobe.available
              ? 'text-[var(--color-success)]'
              : 'text-[var(--color-text-tertiary)]'
          }`}>
            {toolchain?.ffmpeg.available && toolchain.ffprobe.available ? '本地引擎可用' : '本地引擎未就绪'}
          </span>
          <button
            type="button"
            onClick={beginNew}
            className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          >
            <Plus size={14} />
            新项目
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <MediaProjectRail
          kind="video"
          projects={projects}
          activeId={activeId}
          onSelect={id => { clearError(); setCreating(false); selectVideo(id) }}
          onDelete={project => void removeProject(project)}
          deletions={deletions}
          onRestore={projectId => void restoreDeletedProject(projectId)}
          deletingId={deletingId}
          restoringId={restoringId}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-surface-container-low)]">
          <div className="relative flex min-h-0 flex-1 items-center justify-center p-5">
            {active && (
              <div className="absolute left-3 top-3 z-10 flex rounded-[6px] bg-[var(--color-app-main)] p-1 shadow-sm">
                <button type="button" onClick={() => setPreviewSurface('source')} className={`rounded-[4px] px-2 py-1 text-[11px] ${previewSurface === 'source' ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>源素材</button>
                <button type="button" onClick={() => setPreviewSurface('program')} className={`rounded-[4px] px-2 py-1 text-[11px] ${previewSurface === 'program' ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>节目预览</button>
              </div>
            )}
            {active && previewSurface === 'program' && active.preview ? (
              <div className="flex h-full w-full flex-col items-center justify-center">
                <video
                  ref={programVideoRef}
                  key={active.preview.asset_id}
                  src={mediaApi.assetUrl(active.preview.asset_path)}
                  controls
                  className="min-h-0 max-h-full max-w-full bg-black object-contain"
                />
                {previewStale && <p className="mt-2 text-[11px] text-[var(--color-warning)]">这是旧时间线的预览，可继续观看；生成新预览后才会替换。</p>}
              </div>
            ) : active && previewSurface === 'program' ? (
              <div className="text-center text-[12px] text-[var(--color-text-tertiary)]">
                <Film size={34} className="mx-auto mb-2" />
                保存时间线并生成节目预览
              </div>
            ) : active && (selectedSource?.missing || selectedSource?.content_changed) ? (
              <div className="text-center text-[12px] leading-5 text-[var(--color-warning)]">
                {selectedSource.missing
                  ? '该素材已经移动或删除。请移除对应片段，或重新添加素材。'
                  : '该素材内容已经变化。请重新添加素材后再继续编辑。'}
              </div>
            ) : active && selectedSource ? (
              <video
                key={selectedSource.id}
                src={mediaApi.sourceUrl(active.id, selectedSource.id)}
                controls
                className="max-h-full max-w-full bg-black object-contain"
              />
            ) : (
              <Film size={34} className="text-[var(--color-text-tertiary)]" aria-label="没有视频素材" />
            )}
          </div>

          <section className="h-[210px] shrink-0 border-t border-[var(--color-border)] bg-[var(--color-app-main)]">
            <div className="flex h-9 items-center border-b border-[var(--color-border)] px-3">
              <Scissors size={14} className="mr-2 text-[var(--color-text-tertiary)]" />
              <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">时间线</span>
              {draft && active && !sameTimeline(draft.timeline, active.timeline) && (
                <button
                  type="button"
                  onClick={() => void saveTimeline(draft)}
                  className="ml-auto inline-flex h-7 items-center gap-1 rounded-[6px] px-2 text-[12px] text-[var(--color-brand)] hover:bg-[var(--color-surface-hover)]"
                >
                  <Save size={13} />
                  保存
                </button>
              )}
            </div>
            <div className="flex h-7 items-center gap-2 border-b border-[var(--color-border)] px-3">
              <span className="w-12 text-[10px] text-[var(--color-text-tertiary)]">游标</span>
              <input
                aria-label="时间线游标"
                type="range"
                min={0}
                max={Math.max(1, timelineDuration)}
                value={Math.min(timelineState.playhead_ms, Math.max(1, timelineDuration))}
                disabled={!timelineDuration}
                onPointerDown={() => dispatchTimeline({ type: 'begin_scrub' })}
                onChange={event => dispatchTimeline({ type: 'scrub_to', milliseconds: Number(event.target.value), duration_ms: timelineDuration })}
                onPointerUp={() => dispatchTimeline({ type: 'commit' })}
                onPointerCancel={() => dispatchTimeline({ type: 'cancel' })}
                className="min-w-0 flex-1 accent-[var(--color-brand)]"
              />
              <span className="w-14 text-right text-[10px] tabular-nums text-[var(--color-text-tertiary)]">{seconds(timelineState.playhead_ms)}s</span>
            </div>
            <div className="flex h-[143px] items-stretch gap-1 overflow-x-auto p-3">
              {draft?.timeline.map((clip, index) => {
                const source = draft.sources.find(item => item.id === clip.source_id)
                const scene = sceneById.get(clip.id)
                const locked = scene?.locked ?? false
                return (
                  <div
                    key={clip.id}
                    onPointerDown={event => beginClipDrag(event, clip.id, index, locked)}
                    className={`relative w-[180px] shrink-0 border bg-[var(--color-surface-container-lowest)] p-2 ${timelineState.mode === 'dragging' && timelineState.clip_id === clip.id ? 'border-[var(--color-brand)] opacity-80' : 'border-[var(--color-border)]'} ${locked ? '' : 'cursor-grab active:cursor-grabbing'}`}
                  >
                    <button
                      type="button"
                      aria-label={`裁剪 ${source?.name ?? '片段'} 入点`}
                      disabled={busy || locked}
                      onPointerDown={event => beginClipTrim(event, clip, 'in', source?.duration_ms ?? clip.out_ms, locked)}
                      className="absolute inset-y-0 left-0 w-1 cursor-ew-resize bg-[var(--color-brand)] opacity-0 hover:opacity-100 focus:opacity-100 disabled:hidden"
                    />
                    <button
                      type="button"
                      aria-label={`裁剪 ${source?.name ?? '片段'} 出点`}
                      disabled={busy || locked}
                      onPointerDown={event => beginClipTrim(event, clip, 'out', source?.duration_ms ?? clip.out_ms, locked)}
                      className="absolute inset-y-0 right-0 w-1 cursor-ew-resize bg-[var(--color-brand)] opacity-0 hover:opacity-100 focus:opacity-100 disabled:hidden"
                    />
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSelectedSourceId(clip.source_id)}
                        disabled={busy}
                        className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-[var(--color-text-primary)] disabled:opacity-45"
                      >
                        {index + 1}. {source?.name ?? '素材'}
                      </button>
                      {scene && (
                        <button
                          type="button"
                          onClick={() => void toggleSceneLock(scene.id, !locked)}
                          disabled={busy}
                          className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-brand)] disabled:opacity-25"
                          aria-label={locked ? '解锁场景' : '锁定场景'}
                          title={locked ? '解锁后允许方案调整' : '锁定后分析不会覆盖'}
                        >
                          {locked ? <Lock size={12} /> : <Unlock size={12} />}
                        </button>
                      )}
                      <button type="button" onClick={() => moveClip(index, -1)} disabled={busy || locked || index === 0} className="flex h-6 w-6 shrink-0 items-center justify-center disabled:opacity-25" aria-label="前移片段"><ArrowLeft size={12} /></button>
                      <button type="button" onClick={() => moveClip(index, 1)} disabled={busy || locked || index === draft.timeline.length - 1} className="flex h-6 w-6 shrink-0 items-center justify-center disabled:opacity-25" aria-label="后移片段"><ArrowRight size={12} /></button>
                      <button type="button" onClick={() => splitClip(clip.id)} disabled={busy || locked || clip.out_ms - clip.in_ms < 2} className="flex h-6 w-6 shrink-0 items-center justify-center disabled:opacity-25" aria-label="拆分片段"><Scissors size={12} /></button>
                      <button type="button" onClick={() => removeClip(clip.id)} disabled={busy || locked} className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-error)] disabled:opacity-25" aria-label="删除片段"><X size={12} /></button>
                    </div>
                    <div className="mt-3 grid grid-cols-[34px_1fr] items-center gap-x-2 gap-y-2 text-[11px] text-[var(--color-text-tertiary)]">
                      <label htmlFor={`${clip.id}-in`}>入点</label>
                      <input
                        id={`${clip.id}-in`}
                        type="number"
                        min={0}
                        step={0.1}
                        disabled={busy || locked}
                        value={seconds(clip.in_ms)}
                        onChange={event => updateClip(clip.id, 'in_ms', Math.round(Number(event.target.value) * 1000))}
                        className="h-7 min-w-0 border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1.5 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
                      />
                      <label htmlFor={`${clip.id}-out`}>出点</label>
                      <input
                        id={`${clip.id}-out`}
                        type="number"
                        min={0.1}
                        step={0.1}
                        disabled={busy || locked}
                        value={seconds(clip.out_ms)}
                        onChange={event => updateClip(clip.id, 'out_ms', Math.round(Number(event.target.value) * 1000))}
                        className="h-7 min-w-0 border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1.5 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
                      />
                    </div>
                    {scene && (
                      <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-[var(--color-text-tertiary)]" title={scene.rationale}>
                        {scene.story_role} · {scene.evidence_ids.length} 条证据 · {scene.rationale}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </main>

        <aside className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-app-main)]">
          <div className="h-10 shrink-0 border-b border-[var(--color-border)] px-3 text-[12px] font-medium leading-10 text-[var(--color-text-secondary)]">素材与导出</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {creating || !active ? (
              <>
                <label htmlFor="video-project-title" className="mb-1 block text-[12px] text-[var(--color-text-secondary)]">项目名称</label>
                <input
                  id="video-project-title"
                  value={projectTitle}
                  onChange={event => setProjectTitle(event.target.value)}
                  placeholder="新视频"
                  autoFocus
                  className="h-8 w-full rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2.5 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
                />
                <div className="mt-3 text-[12px] text-[var(--color-text-secondary)]">画幅</div>
                <div className="mt-1 grid grid-cols-3 gap-1 rounded-[6px] bg-[var(--color-surface-container)] p-1">
                  {(Object.entries(OUTPUT_PRESETS) as Array<[OutputPreset, typeof OUTPUT_PRESETS[OutputPreset]]>).map(([key, preset]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setOutputPreset(key)}
                      className="flex h-12 flex-col items-center justify-center rounded-[4px] text-[11px]"
                      style={{
                        color: outputPreset === key ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        background: outputPreset === key ? 'var(--color-app-main)' : undefined,
                      }}
                    >
                      <Square size={14} className="mb-1" aria-hidden="true" />
                      {preset.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void createProject()}
                  disabled={loading}
                  className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] bg-[var(--color-brand)] text-[13px] text-white disabled:opacity-45"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  创建项目
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void pickSource()}
                  disabled={loading || busy}
                  className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-border)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-45"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />}
                  添加素材
                </button>
                <div className="my-3 border-t border-[var(--color-border)]" />
                {active.sources.map(source => (
                  <div
                    key={source.id}
                    className={`mb-1 flex items-center rounded-[6px] ${
                      selectedSource?.id === source.id ? 'bg-[var(--color-surface-selected)]' : 'hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedSourceId(source.id)}
                      className="min-w-0 flex-1 px-2 py-2 text-left"
                    >
                      <span className="block truncate text-[12px] text-[var(--color-text-primary)]">{source.name}</span>
                      <span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">
                        {seconds(source.duration_ms)} 秒 · {source.width}×{source.height}
                      </span>
                      {(source.missing || source.content_changed) && (
                        <span className="mt-0.5 block text-[11px] text-[var(--color-warning)]">
                          {source.missing ? '文件不可用' : '内容已变化'}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => appendClip(source.id)}
                      disabled={busy}
                      className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-brand)] hover:bg-[var(--color-app-main)] disabled:opacity-35"
                      aria-label={`将 ${source.name} 加入时间线`}
                      title="再加入一个片段"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                ))}
                <div className="my-3 border-t border-[var(--color-border)]" />
                <label htmlFor="video-analysis-goal" className="block text-[12px] font-medium text-[var(--color-text-secondary)]">
                  剪辑目标
                </label>
                <textarea
                  id="video-analysis-goal"
                  value={userGoal}
                  onChange={event => setUserGoal(event.target.value)}
                  disabled={busy}
                  maxLength={8000}
                  rows={3}
                  placeholder="例如：突出进球瞬间，剪成适合门店社交账号发布的竖屏短片"
                  className="mt-1 w-full resize-y rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2.5 py-2 text-[12px] leading-5 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)] disabled:opacity-45"
                />
                <button
                  type="button"
                  onClick={() => void startAnalysis()}
                  disabled={loading || busy || !active.sources.length || !userGoal.trim()}
                  className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-brand)] text-[13px] text-[var(--color-brand)] hover:bg-[var(--color-surface-hover)] disabled:opacity-45"
                >
                  {analyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {task?.kind === 'video.analyze'
                    ? '正在分析证据'
                    : task?.kind === 'video.plan' && taskRunning
                      ? '正在生成方案'
                      : active.brief
                        ? '重新分析并生成方案'
                        : '分析素材并生成方案'}
                </button>
                {active.brief && (
                  <div className="mt-2 rounded-[6px] bg-[var(--color-surface-container)] p-2 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                    <p className="font-medium text-[var(--color-text-primary)]">{active.brief.recommended_direction}</p>
                    <p className="mt-1">{active.brief.content_type} · {active.brief.output_channel}</p>
                    {active.brief.gaps.length > 0 && <p className="mt-1 text-[var(--color-warning)]">待确认：{active.brief.gaps.join('；')}</p>}
                  </div>
                )}
                {active.evidence.length > 0 && (
                  <details className="mt-2 rounded-[6px] border border-[var(--color-border)] p-2" open>
                    <summary className="cursor-pointer text-[11px] font-medium text-[var(--color-text-secondary)]">
                      已核验 {active.evidence.length} 条 Evidence · 修订 {active.evidence_revision?.slice(7, 15) ?? '未生成'}
                    </summary>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      <select
                        aria-label="证据类型"
                        value={evidenceKind}
                        onChange={event => { setEvidenceKind(event.target.value as 'all' | EvidenceKind); setEvidenceVisibleCount(20) }}
                        className="h-7 min-w-0 rounded-[5px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1.5 text-[10px] text-[var(--color-text-primary)]"
                      >
                        <option value="all">全部类型</option>
                        {(Object.entries(EVIDENCE_KIND_LABELS) as Array<[EvidenceKind, string]>).map(([kind, label]) => (
                          <option key={kind} value={kind}>{label}</option>
                        ))}
                      </select>
                      <select
                        aria-label="证据素材"
                        value={evidenceSourceId}
                        onChange={event => { setEvidenceSourceId(event.target.value); setEvidenceVisibleCount(20) }}
                        className="h-7 min-w-0 rounded-[5px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1.5 text-[10px] text-[var(--color-text-primary)]"
                      >
                        <option value="all">全部素材</option>
                        {active.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
                      </select>
                    </div>
                    <div className="mt-2 space-y-1.5" aria-label="视频证据明细">
                      {filteredEvidence.slice(0, evidenceVisibleCount).map(item => {
                        const source = active.sources.find(candidate => candidate.id === item.source_id)
                        return (
                          <details key={item.id} className="rounded-[5px] bg-[var(--color-surface-container)] px-2 py-1.5">
                            <summary className="cursor-pointer text-[10px] text-[var(--color-text-secondary)]">
                              {EVIDENCE_KIND_LABELS[item.kind]} · {seconds(item.in_ms)}–{seconds(item.out_ms)}s · {Math.round(item.confidence * 100)}%
                            </summary>
                            <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-4 text-[var(--color-text-primary)]">{item.text}</p>
                            <button
                              type="button"
                              onClick={() => { setSelectedSourceId(item.source_id); setPreviewSurface('source') }}
                              className="mt-1 text-left text-[10px] text-[var(--color-brand)] hover:underline"
                            >
                              来源：{source?.name ?? item.source_id} · 指纹 {item.source_fingerprint.slice(7, 15)}
                            </button>
                            {item.warnings.length > 0 && (
                              <p className="mt-1 text-[10px] leading-4 text-[var(--color-warning)]">警告：{item.warnings.join('；')}</p>
                            )}
                          </details>
                        )
                      })}
                      {filteredEvidence.length === 0 && (
                        <p className="py-2 text-center text-[10px] text-[var(--color-text-tertiary)]">没有符合筛选条件的证据</p>
                      )}
                    </div>
                    {filteredEvidence.length > evidenceVisibleCount && (
                      <button
                        type="button"
                        onClick={() => setEvidenceVisibleCount(count => count + 20)}
                        className="mt-2 h-7 w-full rounded-[5px] border border-[var(--color-border)] text-[10px] text-[var(--color-text-secondary)]"
                      >
                        再显示 {Math.min(20, filteredEvidence.length - evidenceVisibleCount)} 条
                      </button>
                    )}
                  </details>
                )}
                {active.alternatives.length > 0 && (
                  <div className="mt-2 space-y-1" aria-label="剪辑备选方案">
                    {active.alternatives.map(alternative => (
                      <div key={alternative.id} className="rounded-[6px] border border-[var(--color-border)] p-2">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-medium text-[var(--color-text-primary)]">{alternative.label}</p>
                            <p className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">{alternative.tradeoff}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void applyVideoAlternative(active, alternative.id)}
                            disabled={busy || !draft || !sameTimeline(draft.timeline, active.timeline)}
                            className="shrink-0 rounded-[5px] px-2 py-1 text-[11px] text-[var(--color-brand)] hover:bg-[var(--color-surface-hover)] disabled:opacity-35"
                          >
                            采用
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {active.timeline_versions.length > 0 && (
                  <div className="mt-3 rounded-[6px] border border-[var(--color-border)] p-2" aria-label="时间线版本历史">
                    <label htmlFor="video-timeline-version" className="block text-[11px] font-medium text-[var(--color-text-secondary)]">
                      时间线版本
                    </label>
                    <select
                      id="video-timeline-version"
                      value={active.current_timeline_version_id}
                      onChange={event => void restoreTimelineVersion(event.target.value)}
                      disabled={busy || loading}
                      className="mt-1 h-8 w-full rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[11px] text-[var(--color-text-primary)] outline-none disabled:opacity-45"
                    >
                      {[...active.timeline_versions].reverse().map((version, index) => (
                        <option key={version.id} value={version.id}>
                          {index === 0 ? '最新 · ' : ''}{new Date(version.created_at).toLocaleString()} · {version.scenes.length} 个片段
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => undoTimelineVersion && void restoreTimelineVersion(undoTimelineVersion.id)}
                        disabled={!undoTimelineVersion || busy || loading}
                        className="h-7 rounded-[5px] border border-[var(--color-border)] text-[11px] text-[var(--color-text-secondary)] disabled:opacity-35"
                      >
                        撤销到父版本
                      </button>
                      <button
                        type="button"
                        onClick={() => redoTimelineVersion && void restoreTimelineVersion(redoTimelineVersion.id)}
                        disabled={!redoTimelineVersion || busy || loading}
                        className="h-7 rounded-[5px] border border-[var(--color-border)] text-[11px] text-[var(--color-text-secondary)] disabled:opacity-35"
                      >
                        重做到子版本
                      </button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
                      恢复只切换当前版本；再次编辑时会从该版本创建新分支，不覆盖历史。
                    </p>
                  </div>
                )}
                <div className="my-3 border-t border-[var(--color-border)]" />
                <div className="flex flex-col items-stretch gap-2">
                  <span className="text-[12px] text-[var(--color-text-secondary)]">语音 Evidence</span>
                  <VoiceInputControl
                    disabled={busy}
                    consumer={{ kind: 'video_evidence', id: active.id }}
                    onTranscript={() => {
                      void productVoiceApi.listEvidence({ kind: 'video_evidence', id: active.id })
                        .then(setVoiceEvidence)
                        .catch(() => undefined)
                    }}
                  />
                </div>
                {voiceEvidence.length > 0 ? (
                  <div className="mt-2 space-y-1" aria-label="已绑定语音 Evidence">
                    {voiceEvidence.map(item => (
                      <p key={item.binding.id} className="rounded-[6px] bg-[var(--color-surface-container)] px-2 py-1.5 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                        {item.revision.text}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">可录音或上传音频，校正后作为视频证据保存。</p>
                )}
                <div className="my-3 border-t border-[var(--color-border)]" />
                <div className="grid grid-cols-2 gap-y-2 text-[12px]">
                  <span className="text-[var(--color-text-tertiary)]">画布</span>
                  <span className="text-right text-[var(--color-text-secondary)]">{active.output.width}×{active.output.height}</span>
                  <span className="text-[var(--color-text-tertiary)]">帧率</span>
                  <span className="text-right text-[var(--color-text-secondary)]">{active.output.fps} fps</span>
                </div>
                <div className="mt-3 grid grid-cols-[72px_1fr] items-center gap-2 text-[12px]">
                  <label htmlFor="video-output-format" className="text-[var(--color-text-tertiary)]">导出格式</label>
                  <select
                    id="video-output-format"
                    value={outputFormat}
                    onChange={event => setOutputFormat(event.target.value as OutputFormat)}
                    disabled={busy}
                    className="h-8 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none"
                  >
                    <option value="mp4">MP4（推荐）</option>
                    <option value="mov">MOV</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => void startPreview()}
                  disabled={loading || rendering || previewRunning || !draft?.timeline.length || !toolchain?.ffmpeg.available || !toolchain.ffprobe.available}
                  className="mt-4 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-brand)] text-[13px] text-[var(--color-brand)] hover:bg-[var(--color-surface-hover)] disabled:opacity-45"
                >
                  {previewRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {previewRunning ? '正在生成节目预览' : active.preview ? '刷新节目预览' : '生成节目预览'}
                </button>
                {previewRunning && active.preview_task_id && (
                  <button
                    type="button"
                    onClick={() => void cancelTask(active.preview_task_id!)}
                    disabled={loading}
                    className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-border)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-45"
                  >
                    <X size={14} />
                    取消预览
                  </button>
                )}
                {previewTask && (
                  <div className="mt-2 h-1 overflow-hidden bg-[var(--color-surface-container)]" aria-label={previewTask.stage}>
                    <div className="h-full bg-[var(--color-brand)]" style={{ width: `${previewTask.progress}%` }} />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void startRender()}
                  disabled={loading || busy || previewRunning || !draft?.timeline.length || !toolchain?.ffmpeg.available || !toolchain.ffprobe.available}
                  className="mt-4 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] bg-[var(--color-brand)] text-[13px] text-white disabled:opacity-45"
                >
                  {active.state === 'rendering' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {active.state === 'rendering' ? '正在导出' : '导出视频'}
                </button>
                {active.task_id && (task?.status === 'queued' || task?.status === 'running') && (
                  <button
                    type="button"
                    onClick={() => void cancelTask(active.task_id!)}
                    disabled={loading}
                    className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-border)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-45"
                  >
                    <X size={14} />
                    {analyzing ? '取消分析' : '取消导出'}
                  </button>
                )}
                {task && (
                  <div className="mt-2 h-1 overflow-hidden bg-[var(--color-surface-container)]">
                    <div className="h-full bg-[var(--color-brand)]" style={{ width: `${task.progress}%` }} />
                  </div>
                )}
                {active.state === 'complete' && active.output_verification && (
                  <div className="mt-3 rounded-[6px] border border-[var(--color-success)]/40 bg-[var(--color-surface-container)] p-2" aria-label="导出校验结果">
                    <p className="text-[11px] font-medium text-[var(--color-success)]">导出已通过本机校验</p>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-[var(--color-text-tertiary)]">
                      <span>时长</span><span className="text-right text-[var(--color-text-secondary)]">{seconds(active.output_verification.duration_ms)} 秒</span>
                      <span>文件大小</span><span className="text-right text-[var(--color-text-secondary)]">{fileSize(active.output_verification.byte_size)}</span>
                      <span>媒体轨</span><span className="text-right text-[var(--color-text-secondary)]">{active.output_verification.video_stream_count} 视频 / {active.output_verification.audio_stream_count} 音频</span>
                      {active.output_verification.width && active.output_verification.height && (
                        <><span>画面</span><span className="text-right text-[var(--color-text-secondary)]">{active.output_verification.width}×{active.output_verification.height}{active.output_verification.fps ? ` · ${active.output_verification.fps} fps` : ''}</span></>
                      )}
                      <span>时间线</span><span className="truncate text-right text-[var(--color-text-secondary)]" title={active.output_verification.timeline_version_id}>{active.output_verification.timeline_version_id.slice(-12)}</span>
                      <span>SHA-256</span><span className="truncate text-right font-mono text-[var(--color-text-secondary)]" title={active.output_verification.content_hash}>{active.output_verification.content_hash.slice(7, 23)}…</span>
                    </div>
                  </div>
                )}
                {active.state === 'complete' && active.output_path && (
                  <button
                    type="button"
                    onClick={() => void getDesktopHost().shell.openPath(active.output_path!)}
                    className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-border)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                  >
                    <FolderOpen size={14} />
                    打开导出视频
                  </button>
                )}
              </>
            )}
            {(storeError || projectError || taskError || previewTask?.error) && (
              <p role="alert" className="mt-3 text-[12px] leading-5 text-[var(--color-error)]">
                {storeError || projectError || taskError || (previewTask?.error ? mediaUserFacingError({ code: previewTask.error_code }) : null)}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
