import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Film,
  FolderOpen,
  FolderPlus,
  Loader2,
  Play,
  Plus,
  Save,
  Scissors,
  Square,
  X,
} from 'lucide-react'
import { mediaApi, mediaUserFacingError, type VideoStudioProject } from '../../api/media'
import { getDesktopHost } from '../../lib/desktopHost'
import { useMediaWorkbenchStore } from '../../stores/mediaWorkbenchStore'
import { MediaProjectRail } from './MediaProjectRail'

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(2)
}

const OUTPUT_PRESETS = {
  portrait: { label: '竖版 9:16', width: 1080, height: 1920, fps: 30 },
  landscape: { label: '横版 16:9', width: 1920, height: 1080, fps: 30 },
  square: { label: '方形 1:1', width: 1080, height: 1080, fps: 30 },
} as const

type OutputPreset = keyof typeof OUTPUT_PRESETS
type OutputFormat = 'mp4' | 'mov'

function newClipId(): string {
  return `clip_${crypto.randomUUID().replaceAll('-', '')}`
}

export function VideoStudio() {
  const projects = useMediaWorkbenchStore(state => state.videoProjects)
  const activeId = useMediaWorkbenchStore(state => state.activeVideoId)
  const tasks = useMediaWorkbenchStore(state => state.tasks)
  const toolchain = useMediaWorkbenchStore(state => state.toolchain)
  const loading = useMediaWorkbenchStore(state => state.loading)
  const error = useMediaWorkbenchStore(state => state.error)
  const loadProjects = useMediaWorkbenchStore(state => state.loadProjects)
  const loadToolchain = useMediaWorkbenchStore(state => state.loadToolchain)
  const selectVideo = useMediaWorkbenchStore(state => state.selectVideo)
  const createVideo = useMediaWorkbenchStore(state => state.createVideo)
  const addVideoSource = useMediaWorkbenchStore(state => state.addVideoSource)
  const saveTimeline = useMediaWorkbenchStore(state => state.saveTimeline)
  const renderVideo = useMediaWorkbenchStore(state => state.renderVideo)
  const cancelTask = useMediaWorkbenchStore(state => state.cancelTask)
  const deleteProject = useMediaWorkbenchStore(state => state.deleteProject)
  const refreshTask = useMediaWorkbenchStore(state => state.refreshTask)
  const clearError = useMediaWorkbenchStore(state => state.clearError)
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [draft, setDraft] = useState<VideoStudioProject | null>(null)
  const [creating, setCreating] = useState(false)
  const [projectTitle, setProjectTitle] = useState('')
  const [outputPreset, setOutputPreset] = useState<OutputPreset>('portrait')
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp4')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const active = useMemo(
    () => projects.find(project => project.id === activeId) ?? null,
    [activeId, projects],
  )
  const selectedSource = active?.sources.find(source => source.id === selectedSourceId) ?? active?.sources[0]
  const task = active?.task_id ? tasks[active.task_id] : undefined
  const rendering = active?.state === 'rendering' || task?.status === 'queued' || task?.status === 'running' || task?.status === 'committing'
  const storeError = error ? mediaUserFacingError(new Error(error)) : null
  const projectError = active?.error
    ? mediaUserFacingError({ code: active.error_code })
    : null
  const taskError = task?.error
    ? mediaUserFacingError({ code: task.error_code })
    : null

  useEffect(() => {
    void loadProjects('video')
    void loadToolchain()
  }, [loadProjects, loadToolchain])

  useEffect(() => {
    setDraft(active)
    setSelectedSourceId(active?.sources[0]?.id ?? null)
  }, [active])

  useEffect(() => {
    if (!active?.task_id || active.state !== 'rendering') return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped) return
      await refreshTask(active.task_id!).catch(() => undefined)
      if (!stopped) timer = window.setTimeout(() => void poll(), 1500)
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [active?.state, active?.task_id, refreshTask])

  const pickSource = async () => {
    if (!active || rendering) return
    const picked = await getDesktopHost().dialogs.open({
      multiple: true,
      title: '选择视频素材',
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'webm'] }],
    })
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
    for (const path of paths) await addVideoSource(active.id, path)
  }

  const startRender = async () => {
    if (!active || !draft || rendering || !toolchain?.ffmpeg.available || !toolchain.ffprobe.available) return
    const outputPath = await getDesktopHost().dialogs.save({
      title: '导出视频',
      defaultPath: `${active.title}.${outputFormat}`,
      filters: outputFormat === 'mov'
        ? [{ name: 'MOV 视频', extensions: ['mov'] }]
        : [{ name: 'MP4 视频', extensions: ['mp4'] }],
    })
    if (!outputPath) return
    const changed = JSON.stringify(draft.timeline) !== JSON.stringify(active.timeline)
    const project = changed ? await saveTimeline(draft) : active
    await renderVideo(project, outputPath)
  }

  const updateClip = (clipId: string, field: 'in_ms' | 'out_ms', value: number) => {
    if (!draft || rendering) return
    setDraft({
      ...draft,
      timeline: draft.timeline.map(clip => {
        if (clip.id !== clipId) return clip
        const source = draft.sources.find(item => item.id === clip.source_id)
        if (field === 'in_ms') return { ...clip, in_ms: Math.max(0, Math.min(value, clip.out_ms - 1)) }
        return { ...clip, out_ms: Math.max(clip.in_ms + 1, Math.min(value, source?.duration_ms ?? value)) }
      }),
    })
  }

  const moveClip = (index: number, direction: -1 | 1) => {
    if (!draft || rendering) return
    const target = index + direction
    if (target < 0 || target >= draft.timeline.length) return
    const timeline = [...draft.timeline]
    const [clip] = timeline.splice(index, 1)
    timeline.splice(target, 0, clip!)
    setDraft({ ...draft, timeline })
  }

  const removeClip = (clipId: string) => {
    if (!draft || rendering) return
    setDraft({ ...draft, timeline: draft.timeline.filter(clip => clip.id !== clipId) })
  }

  const appendClip = (sourceId: string) => {
    if (!draft || rendering) return
    const source = draft.sources.find(item => item.id === sourceId)
    if (!source) return
    setDraft({
      ...draft,
      timeline: [
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
    if (!draft || rendering) return
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
    setDraft({ ...draft, timeline })
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
          deletingId={deletingId}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-surface-container-low)]">
          <div className="flex min-h-0 flex-1 items-center justify-center p-5">
            {active && selectedSource ? (
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
              {draft && active && JSON.stringify(draft.timeline) !== JSON.stringify(active.timeline) && (
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
            <div className="flex h-[170px] items-stretch gap-1 overflow-x-auto p-3">
              {draft?.timeline.map((clip, index) => {
                const source = draft.sources.find(item => item.id === clip.source_id)
                return (
                  <div key={clip.id} className="w-[180px] shrink-0 border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSelectedSourceId(clip.source_id)}
                        disabled={rendering}
                        className="min-w-0 flex-1 truncate text-left text-[12px] font-medium text-[var(--color-text-primary)] disabled:opacity-45"
                      >
                        {index + 1}. {source?.name ?? '素材'}
                      </button>
                      <button type="button" onClick={() => moveClip(index, -1)} disabled={rendering || index === 0} className="flex h-6 w-6 shrink-0 items-center justify-center disabled:opacity-25" aria-label="前移片段"><ArrowLeft size={12} /></button>
                      <button type="button" onClick={() => moveClip(index, 1)} disabled={rendering || index === draft.timeline.length - 1} className="flex h-6 w-6 shrink-0 items-center justify-center disabled:opacity-25" aria-label="后移片段"><ArrowRight size={12} /></button>
                      <button type="button" onClick={() => splitClip(clip.id)} disabled={rendering || clip.out_ms - clip.in_ms < 2} className="flex h-6 w-6 shrink-0 items-center justify-center disabled:opacity-25" aria-label="拆分片段"><Scissors size={12} /></button>
                      <button type="button" onClick={() => removeClip(clip.id)} disabled={rendering} className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-error)] disabled:opacity-25" aria-label="删除片段"><X size={12} /></button>
                    </div>
                    <div className="mt-3 grid grid-cols-[34px_1fr] items-center gap-x-2 gap-y-2 text-[11px] text-[var(--color-text-tertiary)]">
                      <label htmlFor={`${clip.id}-in`}>入点</label>
                      <input
                        id={`${clip.id}-in`}
                        type="number"
                        min={0}
                        step={0.1}
                        disabled={rendering}
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
                        disabled={rendering}
                        value={seconds(clip.out_ms)}
                        onChange={event => updateClip(clip.id, 'out_ms', Math.round(Number(event.target.value) * 1000))}
                        className="h-7 min-w-0 border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1.5 text-[12px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
                      />
                    </div>
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
                  disabled={loading || rendering}
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
                    </button>
                    <button
                      type="button"
                      onClick={() => appendClip(source.id)}
                      disabled={rendering}
                      className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-[var(--color-brand)] hover:bg-[var(--color-app-main)] disabled:opacity-35"
                      aria-label={`将 ${source.name} 加入时间线`}
                      title="再加入一个片段"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                ))}
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
                    disabled={rendering}
                    className="h-8 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none"
                  >
                    <option value="mp4">MP4（推荐）</option>
                    <option value="mov">MOV</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => void startRender()}
                  disabled={loading || rendering || !active.timeline.length || !toolchain?.ffmpeg.available || !toolchain.ffprobe.available}
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
                    取消导出
                  </button>
                )}
                {task && (
                  <div className="mt-2 h-1 overflow-hidden bg-[var(--color-surface-container)]">
                    <div className="h-full bg-[var(--color-brand)]" style={{ width: `${task.progress}%` }} />
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
            {(storeError || projectError || taskError) && (
              <p role="alert" className="mt-3 text-[12px] leading-5 text-[var(--color-error)]">
                {storeError || projectError || taskError}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
