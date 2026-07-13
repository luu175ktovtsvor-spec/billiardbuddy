import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '../../components/shared/PageKit'
import {
  IconAlertCircle,
  IconCheckCircle,
  IconEdit,
  IconRefresh,
  IconTarget,
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
} from '../../api/video'
import { VideoInspector } from './inspector/VideoInspector'
import { ProjectEntry } from './project-entry/ProjectEntry'
import { JobBar } from './shared/JobBar'
import { ModeTabs } from './shared/ModeTabs'
import { ScenePreview } from './shared-preview/ScenePreview'
import { SourceBasket } from './source-basket/SourceBasket'
import { SceneEditor } from './workbench/SceneEditor'
import { VIDEO_CONTENT_TYPES, coverageLabel, formatDuration, sceneDuration } from './videoStudioModel'
import { inputStyle, primaryButtonStyle, subtleButtonStyle } from './videoStudioStyles'
import type { VideoStudioView as View } from './videoStudioTypes'

type CompactPane = 'sources' | 'workspace' | 'inspector'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '操作失败'
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


  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="video-studio-page">
      <div className={`mx-auto min-h-full w-full ${project ? 'max-w-[1600px] px-4 py-5 min-[840px]:px-6' : 'max-w-[860px] px-4 py-7 min-[840px]:px-8'}`}>
        <PageHeader title="剪视频工作台" action={project ? <div className="flex gap-1.5"><button type="button" onClick={() => void undoRedo('undo')} disabled={busy} title="撤销" className="h-8 w-8 rounded-md disabled:opacity-35" style={subtleButtonStyle} data-testid="video-undo">↶</button><button type="button" onClick={() => void undoRedo('redo')} disabled={busy} title="重做" className="h-8 w-8 rounded-md disabled:opacity-35" style={subtleButtonStyle} data-testid="video-redo">↷</button><button type="button" onClick={newProject} className="rounded-md px-2.5 py-1.5 text-[12px]" style={subtleButtonStyle}>新项目</button></div> : undefined} />

        {!project && <ProjectEntry
          view={view}
          goalText={goalText}
          contentType={contentType}
          ratio={ratio}
          durationSec={durationSec}
          exactCopyText={exactCopyText}
          paths={paths}
          projects={projects}
          busy={busy}
          onViewChange={setViewState}
          onGoalChange={setGoalText}
          onContentTypeChange={setContentType}
          onRatioChange={setRatio}
          onDurationChange={setDurationSec}
          onExactCopyChange={setExactCopyText}
          onPickVideos={() => void pickVideos()}
          onRemovePath={path => setPaths(items => items.filter(item => item !== path))}
          onCreateProject={() => void createProject()}
          onOpenProject={id => void openProject(id)}
        />}

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
            <aside className={`${compactPane === 'inspector' ? 'block' : 'hidden min-[1180px]:block'} min-w-0`}>
              <VideoInspector
                project={project}
                selectedScene={selectedScene}
                sceneCount={scenes.length}
                busy={busy}
                musicLicense={musicLicense}
                renderUrl={renderUrl}
                onMusicLicenseChange={setMusicLicense}
                onApplyAlternative={(alternative, scope) => void applyAlternative(alternative, scope)}
                onOperation={operation => void applyOperation(operation)}
                onSetGraphicText={text => void setGraphicText(text)}
                onPickLogo={() => void pickLogo()}
                onPickMusic={() => void pickMusic()}
                onRender={preview => void render(preview)}
              />
            </aside>
          </div>
        </>}
      </div>
    </div>
  )
}
