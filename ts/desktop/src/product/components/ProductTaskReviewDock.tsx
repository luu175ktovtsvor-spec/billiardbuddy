import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { productTasksApi } from '../api/tasks'
import { ProductApiError, productApiUserFacingError } from '../api/client'
import { parseProductTaskReviewDiff } from '../domain/types'
import type {
  ProductTaskReviewComment,
  ProductTaskReviewDiff,
  ProductTaskReviewDiffLine,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
  WorkspaceFileRef,
} from '../domain/types'

type ReviewLoadState = 'loading' | 'ready' | 'error'

type ProductTaskReviewDockProps = {
  taskId: string
  onClose: () => void
}

type CommentTarget = { side: 'old' | 'new'; line: number }

type PendingComment = CommentTarget & {
  body: string
  clientOperationId: string
  fileRef: WorkspaceFileRef
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
    case 'stale':
      return '文件在读取期间发生了变化，请重新选择后审阅。'
    default:
      return '文件内容暂时无法读取。'
  }
}

function diffStateLabel(diff: ProductTaskReviewDiff | null): string | null {
  if (!diff || diff.state === 'ok') return null
  if (diff.state === 'not_versioned') return '当前目录不是 Git 仓库，无法显示差异。'
  if (diff.state === 'missing') return '这个文件已不存在。'
  if (diff.state === 'stale') return '文件版本已变化，请重新选择后审阅。'
  return '差异内容暂时无法读取。'
}

function makeCommentOperationId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `review-comment-${crypto.randomUUID()}`
    : `review-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function diffLineClass(line: ProductTaskReviewDiffLine): string {
  if (line.kind === 'addition') return 'bg-emerald-500/10'
  if (line.kind === 'deletion') return 'bg-red-500/10'
  if (line.kind === 'hunk') return 'bg-sky-500/10 text-[var(--color-text-secondary)]'
  return ''
}

/** A task-scoped file and diff review surface with no Core session transport. */
export function ProductTaskReviewDock({ taskId, onClose }: ProductTaskReviewDockProps) {
  const [loadState, setLoadState] = useState<ReviewLoadState>('loading')
  const [status, setStatus] = useState<ProductTaskReviewStatus | null>(null)
  const [tree, setTree] = useState<ProductTaskReviewTree | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [file, setFile] = useState<ProductTaskReviewFile | null>(null)
  const [diff, setDiff] = useState<ProductTaskReviewDiff | null>(null)
  const [comments, setComments] = useState<ProductTaskReviewComment[]>([])
  const [commentsState, setCommentsState] = useState<'idle' | 'loading' | 'ready' | 'stale' | 'error'>('idle')
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null)
  const [commentBody, setCommentBody] = useState('')
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [isSavingComment, setIsSavingComment] = useState(false)
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
    setComments([])
    setCommentsState('idle')
    setCommentTarget(null)
    setCommentBody('')
    setPendingComment(null)
    setCommentError(null)
    setIsSavingComment(false)
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
    setComments([])
    setCommentsState('idle')
    setCommentTarget(null)
    setCommentBody('')
    setPendingComment(null)
    setCommentError(null)
    setIsSavingComment(false)
    try {
      const nextFile = await productTasksApi.getReviewFile(taskId, path)
      if (selectionLoadVersionRef.current !== requestVersion) return
      const nextDiff = await productTasksApi.getReviewDiff(
        taskId,
        path,
        nextFile.fileRef?.revision,
      )
      if (selectionLoadVersionRef.current !== requestVersion) return
      setFile(nextFile)
      setDiff(nextDiff)
      const fileRef = nextDiff.state === 'ok' ? (nextDiff.fileRef ?? nextFile.fileRef) : undefined
      if (fileRef) {
        setCommentsState('loading')
        try {
          const nextComments = await productTasksApi.getReviewComments(taskId, fileRef)
          if (selectionLoadVersionRef.current !== requestVersion) return
          setComments(nextComments.comments)
          setCommentsState('ready')
        } catch (error) {
          if (selectionLoadVersionRef.current !== requestVersion) return
          setCommentsState(error instanceof ProductApiError && error.status === 409 ? 'stale' : 'error')
        }
      }
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
  const fileRef = diff?.state === 'ok' ? (diff.fileRef ?? file?.fileRef) : undefined
  const diffLines = useMemo(() => (
    diff?.state === 'ok' && typeof diff.diff === 'string'
      ? parseProductTaskReviewDiff(diff.diff)
      : []
  ), [diff])

  const chooseCommentTarget = useCallback((target: CommentTarget) => {
    setCommentTarget(target)
    setCommentBody('')
    setPendingComment(null)
    setCommentError(null)
  }, [])

  const saveComment = useCallback(async () => {
    const body = commentBody.trim()
    if (!fileRef || !commentTarget || !body || isSavingComment) return
    const requestVersion = selectionLoadVersionRef.current
    const reusable = pendingComment
      && pendingComment.fileRef.fileId === fileRef.fileId
      && pendingComment.fileRef.revision === fileRef.revision
      && pendingComment.side === commentTarget.side
      && pendingComment.line === commentTarget.line
      && pendingComment.body === body
    const intent: PendingComment = reusable ? pendingComment : {
      ...commentTarget,
      body,
      fileRef,
      clientOperationId: makeCommentOperationId(),
    }
    if (!reusable) setPendingComment(intent)
    setIsSavingComment(true)
    setCommentError(null)
    try {
      const result = await productTasksApi.createReviewComment(taskId, {
        file_ref: {
          file_id: intent.fileRef.fileId,
          path: intent.fileRef.path,
          revision: intent.fileRef.revision,
        },
        side: intent.side,
        line: intent.line,
        body: intent.body,
        client_operation_id: intent.clientOperationId,
      })
      if (selectionLoadVersionRef.current !== requestVersion) return
      setComments(current => current.some(item => item.commentId === result.comment.commentId)
        ? current
        : [...current, result.comment])
      setCommentsState('ready')
      setCommentTarget(null)
      setCommentBody('')
      setPendingComment(null)
    } catch (error) {
      if (selectionLoadVersionRef.current !== requestVersion) return
      setCommentError(error instanceof ProductApiError && error.status === 409
        ? '文件版本已变化，请重新读取后再批注。'
        : productApiUserFacingError(error, '批注暂时无法保存，请重试。'))
    } finally {
      if (selectionLoadVersionRef.current === requestVersion) setIsSavingComment(false)
    }
  }, [commentBody, commentTarget, fileRef, isSavingComment, pendingComment, taskId])

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
                    <div className="mt-2 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-app-main)] text-xs text-[var(--color-text-primary)]">
                      {diffLines.map((line, index) => {
                        const lineComments = comments.filter(comment => (
                          (comment.side === 'old' && comment.line === line.oldLine)
                          || (comment.side === 'new' && comment.line === line.newLine)
                        ))
                        const targetIsHere = commentTarget && (
                          (commentTarget.side === 'old' && commentTarget.line === line.oldLine)
                          || (commentTarget.side === 'new' && commentTarget.line === line.newLine)
                        )
                        return (
                          <div key={`${index}:${line.text}`} className={diffLineClass(line)}>
                            <div className="flex min-w-max leading-5">
                              {line.oldLine === undefined ? (
                                <span className="w-10 shrink-0 border-r border-[var(--color-border)] px-1 text-right text-[var(--color-text-tertiary)]" />
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`在旧文件第 ${line.oldLine} 行添加批注`}
                                  onClick={() => chooseCommentTarget({ side: 'old', line: line.oldLine! })}
                                  className="w-10 shrink-0 border-r border-[var(--color-border)] px-1 text-right text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)]"
                                >{line.oldLine}</button>
                              )}
                              {line.newLine === undefined ? (
                                <span className="w-10 shrink-0 border-r border-[var(--color-border)] px-1 text-right text-[var(--color-text-tertiary)]" />
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`在新文件第 ${line.newLine} 行添加批注`}
                                  onClick={() => chooseCommentTarget({ side: 'new', line: line.newLine! })}
                                  className="w-10 shrink-0 border-r border-[var(--color-border)] px-1 text-right text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)]"
                                >{line.newLine}</button>
                              )}
                              <code className="whitespace-pre px-2">{line.text || ' '}</code>
                            </div>
                            {lineComments.map(comment => (
                              <div key={comment.commentId} className="ml-20 border-t border-[var(--color-border)] px-3 py-2 text-[var(--color-text-secondary)]">
                                <span className="mr-2 text-[10px] text-[var(--color-text-tertiary)]">{comment.side === 'old' ? '旧' : '新'} {comment.line}</span>
                                <span className="whitespace-pre-wrap">{comment.body}</span>
                              </div>
                            ))}
                            {targetIsHere ? (
                              <div className="ml-20 border-t border-[var(--color-border)] p-2">
                                <label className="block text-[11px] text-[var(--color-text-secondary)]" htmlFor="product-task-review-comment">
                                  在{commentTarget.side === 'old' ? '旧' : '新'}文件第 {commentTarget.line} 行添加批注
                                </label>
                                <textarea
                                  id="product-task-review-comment"
                                  value={commentBody}
                                  maxLength={4_000}
                                  autoFocus
                                  onChange={(event) => {
                                    setCommentBody(event.target.value)
                                    setPendingComment(null)
                                    setCommentError(null)
                                  }}
                                  className="mt-1 min-h-16 w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-text-primary)]"
                                />
                                {commentError ? <p role="alert" className="mt-1 text-xs text-[var(--color-error)]">{commentError}</p> : null}
                                <div className="mt-2 flex items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={!commentBody.trim() || isSavingComment}
                                    onClick={() => void saveComment()}
                                    className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs text-white disabled:opacity-50"
                                  >{isSavingComment ? '正在保存…' : pendingComment ? '重试保存' : '保存批注'}</button>
                                  <button
                                    type="button"
                                    disabled={isSavingComment}
                                    onClick={() => {
                                      setCommentTarget(null)
                                      setCommentBody('')
                                      setPendingComment(null)
                                      setCommentError(null)
                                    }}
                                    className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)]"
                                  >取消</button>
                                  {commentError && selectedPath ? (
                                    <button
                                      type="button"
                                      disabled={isSavingComment}
                                      onClick={() => void selectFile(selectedPath)}
                                      className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)]"
                                    >重新读取文件</button>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                    {commentsState === 'loading' ? <p role="status" className="mt-2 text-xs text-[var(--color-text-tertiary)]">正在读取批注…</p> : null}
                    {commentsState === 'error' ? (
                      <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                        <span>批注暂时无法读取。</span>
                        {selectedPath ? <button type="button" onClick={() => void selectFile(selectedPath)} className="ml-2 underline">重新读取</button> : null}
                      </div>
                    ) : null}
                    {commentsState === 'stale' ? (
                      <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                        <span>文件版本已变化，请重新读取后审阅批注。</span>
                        {selectedPath ? <button type="button" onClick={() => void selectFile(selectedPath)} className="ml-2 underline">重新读取</button> : null}
                      </div>
                    ) : null}
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
