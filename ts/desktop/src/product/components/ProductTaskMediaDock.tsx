import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiUrl } from '../../api/client'
import {
  IMAGE_WORKBENCH_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  useTabStore,
} from '../../stores/tabStore'
import { useMediaWorkbenchStore } from '../../stores/mediaWorkbenchStore'
import { productTasksApi } from '../api/tasks'
import type {
  ProductTaskMediaAttachableList,
  ProductTaskMediaProject,
  ProductTaskMediaList,
} from '../domain/types'

type ProductTaskMediaDockProps = {
  taskId: string
  onClose: () => void
}

type LoadState = 'loading' | 'ready' | 'error'
type AttachPickerState = 'idle' | 'loading' | 'ready' | 'error'

const PROJECT_STATE_LABEL: Record<ProductTaskMediaProject['state'], string> = {
  draft: '草稿',
  queued: '排队中',
  generating: '生成中',
  ready: '已完成',
  failed: '未完成',
  rendering: '导出中',
  complete: '已导出',
}

const MEDIA_TASK_STATUS_LABEL = {
  queued: '排队中',
  running: '处理中',
  committing: '正在完成',
  succeeded: '已完成',
  failed: '未完成',
  cancelled: '已取消',
} as const

const MEDIA_POLL_INTERVAL_MS = 3_000

function updatedAtLabel(value: string): string {
  return value.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function hasActiveMediaTask(media: ProductTaskMediaList | null): boolean {
  return media?.projects.some((project) => (
    project.mediaTask?.status === 'queued'
    || project.mediaTask?.status === 'running'
    || project.mediaTask?.status === 'committing'
    || project.state === 'queued'
    || project.state === 'generating'
    || project.state === 'rendering'
  )) ?? false
}

/**
 * Task media view. Creation, paid image submission, and final video export
 * remain in dedicated desktop workbenches with their existing capability
 * checks. The only mutation here is an explicit user-confirmed association of
 * an existing unowned project.
 */
export function ProductTaskMediaDock({ taskId, onClose }: ProductTaskMediaDockProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [media, setMedia] = useState<ProductTaskMediaList | null>(null)
  const [attachPickerState, setAttachPickerState] = useState<AttachPickerState>('idle')
  const [attachable, setAttachable] = useState<ProductTaskMediaAttachableList | null>(null)
  const [attachingProjectId, setAttachingProjectId] = useState<string | null>(null)
  const loadVersionRef = useRef(0)
  const attachableLoadVersionRef = useRef(0)

  const load = useCallback(async (background = false) => {
    const version = loadVersionRef.current + 1
    loadVersionRef.current = version
    if (!background) {
      setLoadState('loading')
      setMedia(null)
    }
    try {
      const result = await productTasksApi.getMedia(taskId)
      if (loadVersionRef.current !== version) return
      setMedia(result)
      setLoadState('ready')
    } catch {
      if (loadVersionRef.current !== version) return
      if (!background) setLoadState('error')
    }
  }, [taskId])

  useEffect(() => {
    void load()
    return () => {
      loadVersionRef.current += 1
      attachableLoadVersionRef.current += 1
    }
  }, [load])

  useEffect(() => {
    if (!hasActiveMediaTask(media)) return
    const timer = window.setTimeout(() => {
      void load(true)
    }, MEDIA_POLL_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [load, media])

  const loadAttachable = useCallback(async () => {
    const version = attachableLoadVersionRef.current + 1
    attachableLoadVersionRef.current = version
    setAttachPickerState('loading')
    setAttachable(null)
    try {
      const result = await productTasksApi.getAttachableMedia(taskId)
      if (attachableLoadVersionRef.current !== version) return
      setAttachable(result)
      setAttachPickerState('ready')
    } catch {
      if (attachableLoadVersionRef.current !== version) return
      setAttachPickerState('error')
    }
  }, [taskId])

  const closeAttachable = () => {
    attachableLoadVersionRef.current += 1
    setAttachable(null)
    setAttachPickerState('idle')
  }

  const attachProject = async (projectId: string) => {
    setAttachingProjectId(projectId)
    try {
      await productTasksApi.attachMediaProject(taskId, projectId)
      closeAttachable()
      await load(true)
    } catch {
      setAttachPickerState('error')
    } finally {
      setAttachingProjectId(null)
    }
  }

  const openProjectInWorkbench = (project: ProductTaskMediaProject) => {
    if (project.kind === 'image') {
      useMediaWorkbenchStore.getState().selectImage(project.id)
      useTabStore.getState().openTab(IMAGE_WORKBENCH_TAB_ID, '生成图片', 'image-workbench')
      return
    }

    useMediaWorkbenchStore.getState().selectVideo(project.id)
    useTabStore.getState().openTab(VIDEO_STUDIO_TAB_ID, '剪视频', 'video-studio')
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="product-task-media-dock">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-[var(--color-text-primary)]">媒体产物</h2>
          <p className="truncate text-xs text-[var(--color-text-tertiary)]">显示当前任务已关联的真实媒体项目</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => attachPickerState === 'idle' ? void loadAttachable() : closeAttachable()}
            disabled={attachingProjectId !== null}
            className="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] disabled:opacity-50"
          >
            {attachPickerState === 'idle' ? '关联已有项目' : '收起关联'}
          </button>
          <button type="button" onClick={() => void load(true)} className="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)]">刷新</button>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)]">关闭</button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-3 rounded-lg bg-[var(--color-surface-container)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
          此处不会创建、生成或导出媒体；你可以明确关联一个尚未归属任务的已有项目，其他操作仍需在独立媒体工作台中完成。
        </p>

        {attachPickerState !== 'idle' ? (
          <section className="mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="product-task-media-attach-picker">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium text-[var(--color-text-primary)]">关联已有媒体项目</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">只显示尚未关联任何任务的本地项目；点选后才会关联。</p>
              </div>
              <button type="button" onClick={closeAttachable} className="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)]">取消</button>
            </div>

            {attachPickerState === 'loading' ? <p role="status" className="mt-3 text-sm text-[var(--color-text-secondary)]">正在读取可关联项目…</p> : null}
            {attachPickerState === 'error' ? (
              <div className="mt-3 text-sm text-[var(--color-text-secondary)]">
                <p>可关联项目暂时无法读取或已被其他任务关联。</p>
                <button type="button" onClick={() => void loadAttachable()} className="mt-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">重新读取</button>
              </div>
            ) : null}
            {attachPickerState === 'ready' && attachable?.projects.length === 0 ? <p className="mt-3 text-sm text-[var(--color-text-secondary)]">没有可关联的未归属媒体项目。</p> : null}
            {attachPickerState === 'ready' && attachable?.projects.length ? (
              <div className="mt-3 flex flex-col gap-2">
                {attachable.projects.map((project) => (
                  <div key={project.id} data-testid={`product-task-media-attachable-${project.id}`} className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-[var(--color-text-primary)]">{project.title}</p>
                      <p className="text-xs text-[var(--color-text-tertiary)]">{project.kind === 'image' ? '图片项目' : '视频项目'} · {PROJECT_STATE_LABEL[project.state]}</p>
                    </div>
                    <button
                      type="button"
                      disabled={attachingProjectId !== null}
                      onClick={() => void attachProject(project.id)}
                      className="shrink-0 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50"
                    >
                      {attachingProjectId === project.id ? '关联中…' : '关联'}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {loadState === 'loading' ? (
          <p role="status" className="text-sm text-[var(--color-text-secondary)]">正在读取媒体产物…</p>
        ) : null}

        {loadState === 'error' ? (
          <div className="rounded-xl border border-[var(--color-error)]/30 p-3 text-sm text-[var(--color-text-secondary)]">
            <p>媒体产物暂时无法读取。</p>
            <button type="button" onClick={() => void load()} className="mt-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">重新读取</button>
          </div>
        ) : null}

        {loadState === 'ready' && media?.projects.length === 0 ? (
          <p className="text-sm leading-6 text-[var(--color-text-secondary)]">当前任务没有已关联的媒体项目。</p>
        ) : null}

        {loadState === 'ready' ? (
          <div className="flex flex-col gap-3">
            {media?.projects.map((project) => (
              <article
                key={project.id}
                data-testid={`product-task-media-project-${project.id}`}
                className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-app-main)]"
              >
                <header className="border-b border-[var(--color-border)] px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 truncate text-sm font-medium text-[var(--color-text-primary)]">{project.title}</h3>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openProjectInWorkbench(project)}
                        className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                      >
                        {project.kind === 'image' ? '在图片工作台中打开' : '在视频工作台中打开'}
                      </button>
                      <span className="rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">
                        {PROJECT_STATE_LABEL[project.state]}
                      </span>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{project.kind === 'image' ? '图片项目' : '视频项目'} · 更新于 {updatedAtLabel(project.updatedAt)}</p>
                  {project.mediaTask ? (
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                      媒体任务：{MEDIA_TASK_STATUS_LABEL[project.mediaTask.status]} · {project.mediaTask.progress}% · {project.mediaTask.stage}
                      {project.mediaTask.outcomeUnknown ? ' · 结果待确认' : ''}
                    </p>
                  ) : null}
                </header>

                {project.assets.length > 0 ? (
                  <div className="grid gap-3 p-3">
                    {project.assets.map((asset) => {
                      const url = getApiUrl(asset.url)
                      return (
                        <figure key={asset.id}>
                          <img
                            src={url}
                            alt={`${project.title} 图片结果`}
                            className="max-h-72 w-full rounded-lg border border-[var(--color-border)] object-contain"
                          />
                          <figcaption className="mt-1">
                            <a href={url} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-primary)] hover:underline">打开原图</a>
                          </figcaption>
                        </figure>
                      )
                    })}
                  </div>
                ) : (
                  <p className="px-3 py-3 text-xs leading-5 text-[var(--color-text-tertiary)]">
                    {project.kind === 'video'
                      ? '视频导出位于本机选择的位置，任务页不会读取或公开该路径。'
                      : '当前没有可安全预览的本地图片资产。'}
                  </p>
                )}
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
