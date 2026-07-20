import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiUrl } from '../../api/client'
import { productTasksApi } from '../api/tasks'
import type {
  ProductTaskMediaDraft,
  ProductTaskMediaProject,
} from '../domain/types'

const INLINE_MEDIA_POLL_INTERVAL_MS = 3_000

const PROJECT_STATE_LABEL: Record<ProductTaskMediaProject['state'], string> = {
  draft: '草稿',
  queued: '排队中',
  generating: '生成中',
  ready: '已完成',
  failed: '未完成',
  rendering: '导出中',
  complete: '已导出',
}

type ProductTaskInlineMediaProps = {
  taskId?: string
  draft: ProductTaskMediaDraft
  actionPending?: boolean
  onAttach?: (draft: ProductTaskMediaDraft) => void
}

function shouldPoll(project: ProductTaskMediaProject | null): boolean {
  if (!project) return false
  return project.assets.length === 0 && project.state !== 'failed'
}

export function ProductTaskInlineMedia({
  taskId,
  draft,
  actionPending = false,
  onAttach,
}: ProductTaskInlineMediaProps) {
  const [project, setProject] = useState<ProductTaskMediaProject | null>(null)
  const [associated, setAssociated] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const scopeKey = `${taskId ?? ''}:${draft.projectId}`
  const scopeRef = useRef(scopeKey)
  if (scopeRef.current !== scopeKey) scopeRef.current = scopeKey

  const load = useCallback(async () => {
    if (!taskId) return
    const requestedScope = scopeKey
    try {
      const result = await productTasksApi.getMedia(taskId)
      if (scopeRef.current !== requestedScope) return
      if (result.taskId !== taskId) {
        setProject(null)
        setAssociated(false)
        setLoadFailed(true)
        return
      }
      const nextProject = result.projects.find((candidate) => candidate.id === draft.projectId) ?? null
      setProject(nextProject)
      setAssociated(nextProject !== null)
      setLoadFailed(false)
    } catch {
      if (scopeRef.current === requestedScope) setLoadFailed(true)
    }
  }, [draft.projectId, scopeKey, taskId])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    setProject(null)
    setAssociated(false)
    setLoadFailed(false)

    const refresh = async () => {
      if (cancelled) return
      await load()
      if (!cancelled) {
        timer = window.setTimeout(refresh, INLINE_MEDIA_POLL_INTERVAL_MS)
      }
    }

    if (taskId) void refresh()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [load, taskId])

  useEffect(() => {
    if (!actionPending && taskId) void load()
  }, [actionPending, load, taskId])

  const mediaLabel = draft.kind === 'image' ? '图片' : '视频'

  return (
    <article
      className="mx-auto max-w-2xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm text-[var(--color-text-secondary)]"
      data-testid={`product-task-media-draft-${draft.kind}`}
    >
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-[var(--color-text-primary)]">
              {associated ? project?.title ?? `${mediaLabel}项目` : `已准备${mediaLabel}草稿`}
            </p>
            <p className="mt-1 text-xs leading-5">
              {associated && project
                ? `${mediaLabel}项目已关联到当前任务 · ${PROJECT_STATE_LABEL[project.state]}`
                : '尚未生成或导出。关联后会打开对应工作台，后续操作仍需你确认。'}
            </p>
          </div>
          {project ? (
            <span className="shrink-0 rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-xs">
              {PROJECT_STATE_LABEL[project.state]}
            </span>
          ) : null}
        </div>

        {!associated && onAttach ? (
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onAttach(draft)}
            className="mt-3 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
          >
            {actionPending ? '关联中…' : '关联到当前任务并打开工作台'}
          </button>
        ) : !associated ? (
          <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">恢复任务后可以关联这个草稿。</p>
        ) : null}

        {loadFailed && taskId ? (
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 text-xs text-[var(--color-primary)] hover:underline"
          >
            媒体状态暂时无法读取，点击重试
          </button>
        ) : null}
      </div>

      {project?.assets.length ? (
        <div className="grid gap-3 border-t border-[var(--color-border)] p-3">
          {project.assets.map((asset) => {
            const url = getApiUrl(asset.url)
            return asset.kind === 'video' ? (
              <figure key={asset.id}>
                <video
                  src={url}
                  controls
                  preload="metadata"
                  aria-label={`${project.title} 视频预览`}
                  className="max-h-96 w-full rounded-lg border border-[var(--color-border)] bg-black object-contain"
                >
                  当前运行环境不支持视频预览。
                </video>
                <figcaption className="mt-1">
                  <a href={url} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-primary)] hover:underline">打开视频</a>
                </figcaption>
              </figure>
            ) : (
              <figure key={asset.id}>
                <img
                  src={url}
                  alt={`${project.title} 图片结果`}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="max-h-96 w-full rounded-lg border border-[var(--color-border)] object-contain"
                />
                <figcaption className="mt-1">
                  <a href={url} target="_blank" rel="noreferrer" className="text-xs text-[var(--color-primary)] hover:underline">打开原图</a>
                </figcaption>
              </figure>
            )
          })}
        </div>
      ) : associated ? (
        <p className="border-t border-[var(--color-border)] px-4 py-3 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {shouldPoll(project)
            ? `正在等待${mediaLabel}产物，生成或导出完成后会在这里显示。`
            : `${mediaLabel}项目暂时没有可预览的产物。`}
        </p>
      ) : null}
    </article>
  )
}
