import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { productTasksApi } from '../api/tasks'
import type {
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
} from '../domain/types'

type ReviewLoadState = 'loading' | 'ready' | 'error'

type ProductTaskReviewDockProps = {
  taskId: string
  onClose: () => void
}

const FILE_STATUS_LABEL: Record<string, string> = {
  modified: '已修改',
  added: '已新增',
  deleted: '已删除',
  renamed: '已重命名',
  untracked: '未跟踪',
  copied: '已复制',
  type_changed: '类型变化',
  unknown: '有变化',
}

function parentPath(value: string): string {
  const parts = value.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

function fileStateLabel(file: ProductTaskReviewFile | null): string | null {
  if (!file || file.state === 'ok') return null
  switch (file.state) {
    case 'binary':
      return '这个文件是二进制内容，无法直接展示文本。'
    case 'too_large':
      if (file.mimeType?.startsWith('video/')) {
        return '视频超过 16 MB 的安全预览限制，无法直接展示。'
      }
      return '这个文件过大，无法直接展示。'
    case 'missing':
      return '这个文件已不存在。'
    default:
      return '文件内容暂时无法读取。'
  }
}

function diffStateLabel(diff: ProductTaskReviewDiff | null): string | null {
  if (!diff || diff.state === 'ok') return null
  if (diff.state === 'not_versioned') return '当前目录不是 Git 仓库，无法显示差异。'
  if (diff.state === 'missing') return '这个文件已不存在。'
  return '差异内容暂时无法读取。'
}

/** A task-scoped file and diff review surface with no Core session transport. */
export function ProductTaskReviewDock({ taskId, onClose }: ProductTaskReviewDockProps) {
  const [loadState, setLoadState] = useState<ReviewLoadState>('loading')
  const [status, setStatus] = useState<ProductTaskReviewStatus | null>(null)
  const [tree, setTree] = useState<ProductTaskReviewTree | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<ProductTaskReviewFile | null>(null)
  const [diff, setDiff] = useState<ProductTaskReviewDiff | null>(null)
  const [isLoadingSelection, setIsLoadingSelection] = useState(false)
  const [videoPreviewError, setVideoPreviewError] = useState(false)
  const initialLoadVersionRef = useRef(0)
  const treeLoadVersionRef = useRef(0)
  const selectionLoadVersionRef = useRef(0)

  const loadTree = useCallback(async (path = ''): Promise<boolean> => {
    const requestVersion = treeLoadVersionRef.current + 1
    treeLoadVersionRef.current = requestVersion
    try {
      const nextTree = await productTasksApi.getReviewTree(taskId, path)
      if (treeLoadVersionRef.current === requestVersion) {
        setTree(nextTree)
      }
      return true
    } catch {
      if (treeLoadVersionRef.current === requestVersion) {
        setTree({ taskId, state: 'unavailable', path, entries: [] })
      }
      return false
    }
  }, [taskId])

  const loadInitial = useCallback(async () => {
    const requestVersion = initialLoadVersionRef.current + 1
    initialLoadVersionRef.current = requestVersion
    // A new task-level load also invalidates file/diff requests from the
    // previous tree, so their late results cannot repopulate this dock.
    treeLoadVersionRef.current += 1
    selectionLoadVersionRef.current += 1
    setLoadState('loading')
    setStatus(null)
    setTree(null)
    setSelectedPath(null)
    setFile(null)
    setDiff(null)
    setIsLoadingSelection(false)
    setVideoPreviewError(false)
    try {
      const [nextStatus, treeLoaded] = await Promise.all([
        productTasksApi.getReviewStatus(taskId),
        loadTree(''),
      ])
      if (initialLoadVersionRef.current !== requestVersion) return
      if (!treeLoaded) {
        setLoadState('error')
        return
      }
      setStatus(nextStatus)
      setLoadState('ready')
    } catch {
      if (initialLoadVersionRef.current !== requestVersion) return
      setLoadState('error')
    }
  }, [loadTree, taskId])

  useEffect(() => {
    void loadInitial()
    return () => {
      initialLoadVersionRef.current += 1
      treeLoadVersionRef.current += 1
      selectionLoadVersionRef.current += 1
    }
  }, [loadInitial])

  const selectFile = useCallback(async (path: string) => {
    const requestVersion = selectionLoadVersionRef.current + 1
    selectionLoadVersionRef.current = requestVersion
    setSelectedPath(path)
    setIsLoadingSelection(true)
    setVideoPreviewError(false)
    try {
      const [nextFile, nextDiff] = await Promise.all([
        productTasksApi.getReviewFile(taskId, path),
        productTasksApi.getReviewDiff(taskId, path),
      ])
      if (selectionLoadVersionRef.current !== requestVersion) return
      setFile(nextFile)
      setDiff(nextDiff)
    } catch {
      if (selectionLoadVersionRef.current !== requestVersion) return
      setFile(null)
      setDiff(null)
    } finally {
      if (selectionLoadVersionRef.current === requestVersion) {
        setIsLoadingSelection(false)
      }
    }
  }, [taskId])

  const changedFiles = useMemo(() => status?.changedFiles ?? [], [status?.changedFiles])
  const currentTreePath = tree?.path ?? ''
  const selectedStateLabel = fileStateLabel(file) ?? diffStateLabel(diff)

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="product-task-review-dock">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-[var(--color-text-primary)]">审阅</h2>
          <p className="truncate text-xs text-[var(--color-text-tertiary)]">
            {status?.repository ? `${status.repository.name}${status.repository.branch ? ` · ${status.repository.branch}` : ''}` : '当前任务的文件与差异'}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)]">关闭</button>
      </header>

      {loadState === 'loading' ? (
        <p role="status" className="p-4 text-sm text-[var(--color-text-secondary)]">正在读取审阅内容…</p>
      ) : null}

      {loadState === 'error' ? (
        <div className="m-3 rounded-xl border border-[var(--color-error)]/30 p-3 text-sm text-[var(--color-text-secondary)]">
          <p>审阅内容暂时无法读取。</p>
          <button type="button" onClick={() => void loadInitial()} className="mt-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">重新读取</button>
        </div>
      ) : null}

      {loadState === 'ready' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {status?.state === 'unavailable' ? (
            <p className="px-3 py-4 text-sm text-[var(--color-text-secondary)]">当前任务暂时没有可用的审阅内容。</p>
          ) : (
            <>
              <div className="shrink-0 border-b border-[var(--color-border)]">
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <p className="text-xs font-medium text-[var(--color-text-secondary)]">有变化的文件</p>
                  <span className="text-xs text-[var(--color-text-tertiary)]">{changedFiles.length}</span>
                </div>
                {changedFiles.length > 0 ? (
                  <div className="max-h-36 overflow-y-auto px-2 pb-2">
                    {changedFiles.map((changedFile) => (
                      <button
                        key={`${changedFile.path}:${changedFile.status}`}
                        type="button"
                        onClick={() => void selectFile(changedFile.path)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-hover)] ${selectedPath === changedFile.path ? 'bg-[var(--color-surface-selected)]' : ''}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{changedFile.path}</span>
                        <span className="shrink-0 text-[var(--color-text-tertiary)]">{FILE_STATUS_LABEL[changedFile.status]}</span>
                        <span className="shrink-0 text-[var(--color-text-tertiary)]">+{changedFile.additions} −{changedFile.deletions}</span>
                      </button>
                    ))}
                  </div>
                ) : <p className="px-3 pb-3 text-xs text-[var(--color-text-tertiary)]">暂未发现文件变化。</p>}
              </div>

              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
                {currentTreePath ? (
                  <button type="button" onClick={() => void loadTree(parentPath(currentTreePath))} className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]">上一级</button>
                ) : null}
                <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-secondary)]">{currentTreePath || '项目文件'}</p>
              </div>
              <div className="shrink-0 border-b border-[var(--color-border)] px-2 py-2">
                {tree?.state === 'unavailable' ? (
                  <div className="px-1 py-2">
                    <p className="text-xs text-[var(--color-text-tertiary)]">当前目录暂时无法读取。</p>
                    <button
                      type="button"
                      onClick={() => void loadTree(currentTreePath)}
                      className="mt-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
                    >
                      重新读取当前目录
                    </button>
                  </div>
                ) : tree?.state === 'ok' && tree.entries.length > 0 ? (
                  <div className="max-h-40 overflow-y-auto">
                    {tree.entries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => entry.isDirectory ? void loadTree(entry.path) : void selectFile(entry.path)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-hover)] ${selectedPath === entry.path ? 'bg-[var(--color-surface-selected)]' : ''}`}
                      >
                        <span aria-hidden="true" className="text-[var(--color-text-tertiary)]">{entry.isDirectory ? '›' : '·'}</span>
                        <span className="min-w-0 truncate text-[var(--color-text-primary)]">{entry.name}</span>
                      </button>
                    ))}
                  </div>
                ) : <p className="px-1 py-2 text-xs text-[var(--color-text-tertiary)]">当前目录没有可展示的文件。</p>}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {isLoadingSelection ? <p role="status" className="text-sm text-[var(--color-text-secondary)]">正在读取文件…</p> : null}
                {!isLoadingSelection && !selectedPath ? <p className="text-sm text-[var(--color-text-secondary)]">选择一个文件以查看内容和差异。</p> : null}
                {!isLoadingSelection && selectedPath && selectedStateLabel ? <p className="text-sm text-[var(--color-text-secondary)]">{selectedStateLabel}</p> : null}
                {!isLoadingSelection && file?.state === 'ok' && file.previewType === 'image' && file.dataUrl ? (
                  <img src={file.dataUrl} alt={file.path} className="max-h-72 max-w-full rounded-lg border border-[var(--color-border)] object-contain" />
                ) : null}
                {!isLoadingSelection && file?.state === 'ok' && file.previewType === 'video' && file.dataUrl ? (
                  <div>
                    <video
                      data-testid="product-task-review-video"
                      controls
                      preload="metadata"
                      src={file.dataUrl}
                      onError={() => setVideoPreviewError(true)}
                      aria-label={`${file.path} 视频预览`}
                      className="max-h-72 max-w-full rounded-lg border border-[var(--color-border)] bg-black object-contain"
                    >
                      当前运行环境不支持视频预览。
                    </video>
                    <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">视频预览仅读取当前任务工作区内不超过 16 MB 的 MP4、WebM、Ogg 或 MOV 文件。</p>
                    {videoPreviewError ? <p role="alert" className="mt-1 text-xs text-[var(--color-text-secondary)]">当前运行环境无法播放这个视频编码。</p> : null}
                  </div>
                ) : null}
                {!isLoadingSelection && file?.state === 'ok' && file.previewType === 'text' && typeof file.content === 'string' ? (
                  <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-app-main)] p-3 text-xs leading-5 text-[var(--color-text-primary)]"><code>{file.content}</code></pre>
                ) : null}
                {!isLoadingSelection && diff?.state === 'ok' && typeof diff.diff === 'string' && diff.diff ? (
                  <>
                    <h3 className="mt-4 text-xs font-medium text-[var(--color-text-secondary)]">差异</h3>
                    <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-app-main)] p-3 text-xs leading-5 text-[var(--color-text-primary)]"><code>{diff.diff}</code></pre>
                  </>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}
