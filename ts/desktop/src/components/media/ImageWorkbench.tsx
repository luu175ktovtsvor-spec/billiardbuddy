import { useEffect, useMemo, useState } from 'react'
import { Download, ImagePlus, Loader2, Minus, Plus, RefreshCw, Sparkles, X } from 'lucide-react'
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES_TOTAL_BYTES,
  mediaApi,
} from '../../api/media'
import { useMediaWorkbenchStore } from '../../stores/mediaWorkbenchStore'
import { getDesktopHost } from '../../lib/desktopHost'
import { MediaProjectRail } from './MediaProjectRail'

function stateLabel(state: string): string {
  return {
    draft: '草稿',
    queued: '排队中',
    generating: '生成中',
    ready: '已完成',
    failed: '生成失败',
  }[state] ?? state
}

type ReferenceImage = { name: string; dataUrl: string; size: number }

const REFERENCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('无法读取参考图片'))
    reader.onerror = () => reject(reader.error ?? new Error('无法读取参考图片'))
    reader.readAsDataURL(file)
  })
}

export function ImageWorkbench() {
  const projects = useMediaWorkbenchStore(state => state.imageProjects)
  const activeId = useMediaWorkbenchStore(state => state.activeImageId)
  const tasks = useMediaWorkbenchStore(state => state.tasks)
  const loading = useMediaWorkbenchStore(state => state.loading)
  const error = useMediaWorkbenchStore(state => state.error)
  const loadProjects = useMediaWorkbenchStore(state => state.loadProjects)
  const selectImage = useMediaWorkbenchStore(state => state.selectImage)
  const createImage = useMediaWorkbenchStore(state => state.createImage)
  const saveImageDraft = useMediaWorkbenchStore(state => state.saveImageDraft)
  const submitImage = useMediaWorkbenchStore(state => state.submitImage)
  const refreshTask = useMediaWorkbenchStore(state => state.refreshTask)
  const cancelTask = useMediaWorkbenchStore(state => state.cancelTask)
  const deleteProject = useMediaWorkbenchStore(state => state.deleteProject)
  const clearError = useMediaWorkbenchStore(state => state.clearError)
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [mode, setMode] = useState<'generate' | 'edit'>('generate')
  const [size, setSize] = useState<'1024x1024' | '1536x1024' | '1024x1536'>('1024x1024')
  const [count, setCount] = useState(1)
  const [references, setReferences] = useState<ReferenceImage[]>([])
  const [selectedOutput, setSelectedOutput] = useState(0)
  const [inputError, setInputError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const active = useMemo(
    () => projects.find(project => project.id === activeId) ?? null,
    [activeId, projects],
  )
  const task = active?.task_id ? tasks[active.task_id] : undefined
  const fidelityRisk = typeof task?.result?.input_fidelity_risk === 'string'
    ? task.result.input_fidelity_risk
    : active?.notice ?? null
  const outputUrls = active?.outputs.map(output => output.asset_path
    ? mediaApi.assetUrl(output.asset_path)
    : output.url ?? output.data_url ?? '') ?? []
  const outputUrl = outputUrls[selectedOutput] ?? outputUrls[0]

  useEffect(() => {
    void loadProjects('image')
  }, [loadProjects])

  useEffect(() => {
    setSelectedOutput(0)
  }, [activeId])

  useEffect(() => {
    if (!active || creating) return
    setPrompt(active.prompt)
    setSize(active.size)
    setCount(active.count)
  }, [active, creating])

  useEffect(() => {
    if (!active?.task_id || active.state === 'ready' || active.state === 'failed') return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped) return
      await refreshTask(active.task_id!).catch(() => undefined)
      if (!stopped) timer = window.setTimeout(() => void poll(), 2500)
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [active?.state, active?.task_id, refreshTask])

  const beginNew = () => {
    clearError()
    selectImage(null)
    setPrompt('')
    setMode('generate')
    setSize('1024x1024')
    setCount(1)
    setReferences([])
    setInputError(null)
    setCreating(true)
  }

  const saveDraft = async () => {
    const value = prompt.trim()
    if (!value) return
    await createImage({
      prompt: value,
      mode,
      size,
      count,
      reference_images: mode === 'edit' ? references.map(reference => reference.dataUrl) : [],
    })
    setCreating(false)
  }

  const addReferences = async (files: FileList | null) => {
    if (!files?.length) return
    const remaining = Math.max(0, 8 - references.length)
    if (files.length > remaining) {
      setInputError('每个项目最多添加 8 张参考图片')
      return
    }
    const selected = Array.from(files).slice(0, remaining)
    const unsupported = selected.find(file => !REFERENCE_TYPES.has(file.type))
    if (unsupported) {
      setInputError(`${unsupported.name} 不是支持的 PNG、JPEG 或 WebP 图片`)
      return
    }
    const oversized = selected.find(file => file.size > MAX_REFERENCE_IMAGE_BYTES)
    if (oversized) {
      setInputError(`${oversized.name} 超过单张 ${megabytes(MAX_REFERENCE_IMAGE_BYTES)} 限制`)
      return
    }
    const totalBytes = references.reduce((total, reference) => total + reference.size, 0)
      + selected.reduce((total, file) => total + file.size, 0)
    if (totalBytes > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
      setInputError(`参考图片合计不能超过 ${megabytes(MAX_REFERENCE_IMAGES_TOTAL_BYTES)}`)
      return
    }
    const loaded = await Promise.all(selected.map(async file => ({
      name: file.name,
      size: file.size,
      dataUrl: await readImage(file),
    })))
    setInputError(null)
    setReferences(current => [...current, ...loaded].slice(0, 8))
  }

  const removeProject = async (project: { id: string; title: string }) => {
    if (!window.confirm(`删除“${project.title}”？此操作会同时删除本地生成结果。`)) return
    setDeletingId(project.id)
    try {
      await deleteProject(project.id, 'image')
      if (project.id === activeId) setCreating(false)
    } finally {
      setDeletingId(null)
    }
  }

  const hasDraftChanges = Boolean(
    active
    && (prompt.trim() !== active.prompt || size !== active.size || count !== active.count),
  )

  const saveActiveDraft = async (confirmUnknownRetry = false) => {
    if (!active || !prompt.trim()) return active
    if (!hasDraftChanges) return active
    return await saveImageDraft({
      ...active,
      prompt: prompt.trim(),
      size,
      count,
    }, confirmUnknownRetry)
  }

  const startGeneration = async () => {
    if (!active) return
    const unknownOutcome = task?.outcome_unknown === true
    const createsNewPaidTask = unknownOutcome && (Boolean(task.remote_task_id) || hasDraftChanges)
    if (unknownOutcome) {
      const warning = createsNewPaidTask
        ? '上一次任务的结果无法确认，可能已经产生费用。继续会创建一个新的生图任务，可能再次扣费。确认继续吗？'
        : '上一次提交的结果无法确认，可能已经产生费用。继续只会使用原来的提交编号确认状态，不会主动创建第二个任务。确认继续吗？'
      if (!window.confirm(warning)) return
    }
    const project = await saveActiveDraft(createsNewPaidTask)
    if (!project) return
    await submitImage(project.id, createsNewPaidTask)
  }

  const downloadOutput = async () => {
    if (!outputUrl || !active) return
    const output = active.outputs[selectedOutput] ?? active.outputs[0]
    if (!output) return
    const mime = output.mime_type
    const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
    const safeTitle = active.title.replace(/[\\/:*?"<>|]/g, '_').trim() || '图片'
    try {
      const outputPath = await getDesktopHost().dialogs.save({
        title: '保存图片',
        defaultPath: `${safeTitle}-${selectedOutput + 1}.${extension}`,
        filters: [{ name: '图片', extensions: [extension] }],
      })
      if (!outputPath) return
      await mediaApi.saveImageOutput(active.id, { output_id: output.id, output_path: outputPath })
      setInputError(null)
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-app-main)]">
      <header className="flex h-11 shrink-0 items-center border-b border-[var(--color-border)] px-3">
        <h1 className="text-[14px] font-semibold text-[var(--color-text-primary)]">生成图片</h1>
        <button
          type="button"
          onClick={beginNew}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
        >
          <Plus size={14} aria-hidden="true" />
          新项目
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <MediaProjectRail
          kind="image"
          projects={projects}
          activeId={activeId}
          onSelect={id => { clearError(); setInputError(null); setCreating(false); selectImage(id) }}
          onDelete={project => void removeProject(project)}
          deletingId={deletingId}
        />

        <main className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-auto bg-[var(--color-surface-container-low)] p-6">
          {outputUrl ? (
            <img
              src={outputUrl}
              alt={active?.title ?? '生成结果'}
              className="max-h-full max-w-full object-contain shadow-[var(--shadow-popover)]"
            />
          ) : (
            <div className="flex aspect-square w-[min(68vh,70%)] max-w-[720px] items-center justify-center border border-dashed border-[var(--color-border)] bg-[var(--color-app-main)]">
              {active && ['queued', 'generating'].includes(active.state) ? (
                <Loader2 size={28} className="animate-spin text-[var(--color-brand)]" aria-label="生成中" />
              ) : (
                <ImagePlus size={30} className="text-[var(--color-text-tertiary)]" aria-label="尚未生成" />
              )}
            </div>
          )}
          {outputUrls.length > 1 && (
            <div className="mt-3 flex h-14 max-w-full shrink-0 gap-2 overflow-x-auto">
              {outputUrls.map((url, index) => (
                <button
                  key={`${active?.id ?? 'output'}-${index}`}
                  type="button"
                  onClick={() => setSelectedOutput(index)}
                  className="h-14 w-14 shrink-0 overflow-hidden border bg-[var(--color-app-main)]"
                  style={{ borderColor: index === selectedOutput ? 'var(--color-brand)' : 'var(--color-border)' }}
                  aria-label={`查看结果 ${index + 1}`}
                >
                  <img src={url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          {outputUrl && (
            <button
              type="button"
              onClick={() => void downloadOutput()}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-app-main)] px-3 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
            >
              <Download size={14} aria-hidden="true" />
              下载图片
            </button>
          )}
        </main>

        <aside className="flex h-full min-h-0 w-[300px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-app-main)]">
          <div className="h-10 shrink-0 border-b border-[var(--color-border)] px-3 text-[12px] font-medium leading-10 text-[var(--color-text-secondary)]">
            {creating || !active ? '新图片' : '图片设置'}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {creating || !active ? (
              <>
                <label className="mb-1 block text-[12px] text-[var(--color-text-secondary)]" htmlFor="image-prompt">画面需求</label>
                <textarea
                  id="image-prompt"
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  rows={9}
                  autoFocus
                  className="w-full resize-none rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2.5 py-2 text-[13px] leading-5 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
                />
                <div className="mt-3 grid grid-cols-2 gap-1 rounded-[6px] bg-[var(--color-surface-container)] p-1" aria-label="图片模式">
                  {(['generate', 'edit'] as const).map(value => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setMode(value)}
                      className="h-7 rounded-[4px] text-[12px]"
                      style={{
                        color: mode === value ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                        background: mode === value ? 'var(--color-app-main)' : undefined,
                      }}
                    >
                      {value === 'generate' ? '生成新图' : '参考图编辑'}
                    </button>
                  ))}
                </div>
                {mode === 'edit' && (
                  <div className="mt-3">
                    <label className="mb-1 block text-[12px] text-[var(--color-text-secondary)]" htmlFor="image-references">参考图片</label>
                    <input
                      id="image-references"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      onChange={event => { void addReferences(event.target.files); event.currentTarget.value = '' }}
                      className="block w-full text-[12px] text-[var(--color-text-secondary)] file:mr-2 file:rounded-[5px] file:border file:border-[var(--color-border)] file:bg-[var(--color-app-main)] file:px-2 file:py-1.5 file:text-[12px] file:text-[var(--color-text-secondary)]"
                    />
                    {references.length > 0 && (
                      <div className="mt-2 grid grid-cols-4 gap-1.5">
                        {references.map((reference, index) => (
                          <div key={`${reference.name}-${index}`} className="group relative aspect-square overflow-hidden border border-[var(--color-border)]">
                            <img src={reference.dataUrl} alt={reference.name} className="h-full w-full object-cover" />
                            <button
                              type="button"
                              onClick={() => {
                                setReferences(current => current.filter((_, itemIndex) => itemIndex !== index))
                                setInputError(null)
                              }}
                              className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white"
                              aria-label={`移除 ${reference.name}`}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-3 grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2 text-[12px]">
                  <label htmlFor="image-size" className="text-[var(--color-text-tertiary)]">画布</label>
                  <select
                    id="image-size"
                    value={size}
                    onChange={event => setSize(event.target.value as typeof size)}
                    className="h-8 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none"
                  >
                    <option value="1024x1024">方形</option>
                    <option value="1536x1024">横版</option>
                    <option value="1024x1536">竖版</option>
                  </select>
                  <span className="text-[var(--color-text-tertiary)]">数量</span>
                  <div className="flex h-8 items-center justify-between rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)]">
                    <button type="button" onClick={() => setCount(value => Math.max(1, value - 1))} className="flex h-full w-8 items-center justify-center" aria-label="减少数量"><Minus size={13} /></button>
                    <span className="text-[12px] text-[var(--color-text-primary)]">{count}</span>
                    <button type="button" onClick={() => setCount(value => Math.min(4, value + 1))} className="flex h-full w-8 items-center justify-center" aria-label="增加数量"><Plus size={13} /></button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={loading || !prompt.trim() || (mode === 'edit' && references.length === 0)}
                  className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] bg-[var(--color-brand)] px-3 text-[13px] text-white disabled:opacity-45"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  创建草稿
                </button>
              </>
            ) : (
              <>
                <div className="mb-4">
                  <div className="mb-1 text-[11px] text-[var(--color-text-tertiary)]">状态</div>
                  <div className="text-[13px] text-[var(--color-text-primary)]">{stateLabel(active.state)}</div>
                  {task && (
                    <div className="mt-2 h-1 overflow-hidden bg-[var(--color-surface-container)]">
                      <div className="h-full bg-[var(--color-brand)] transition-[width]" style={{ width: `${task.progress}%` }} />
                    </div>
                  )}
                </div>
                {['draft', 'failed'].includes(active.state) ? (
                  <>
                    <label className="mb-1 block text-[12px] text-[var(--color-text-secondary)]" htmlFor="active-image-prompt">画面需求</label>
                    <textarea
                      id="active-image-prompt"
                      value={prompt}
                      onChange={event => setPrompt(event.target.value)}
                      rows={8}
                      className="w-full resize-none rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2.5 py-2 text-[13px] leading-5 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
                    />
                    <div className="mt-3 grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2 text-[12px]">
                      <label htmlFor="active-image-size" className="text-[var(--color-text-tertiary)]">画布</label>
                      <select
                        id="active-image-size"
                        value={size}
                        onChange={event => setSize(event.target.value as typeof size)}
                        className="h-8 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none"
                      >
                        <option value="1024x1024">方形</option>
                        <option value="1536x1024">横版</option>
                        <option value="1024x1536">竖版</option>
                      </select>
                      <span className="text-[var(--color-text-tertiary)]">数量</span>
                      <div className="flex h-8 items-center justify-between rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)]">
                        <button type="button" onClick={() => setCount(value => Math.max(1, value - 1))} className="flex h-full w-8 items-center justify-center" aria-label="减少数量"><Minus size={13} /></button>
                        <span className="text-[12px] text-[var(--color-text-primary)]">{count}</span>
                        <button type="button" onClick={() => setCount(value => Math.min(4, value + 1))} className="flex h-full w-8 items-center justify-center" aria-label="增加数量"><Plus size={13} /></button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="mb-4">
                    <div className="mb-1 text-[11px] text-[var(--color-text-tertiary)]">画面需求</div>
                    <p className="whitespace-pre-wrap text-[13px] leading-5 text-[var(--color-text-primary)]">{active.prompt}</p>
                  </div>
                )}
                <div className="mb-5 mt-4 grid grid-cols-2 gap-y-2 text-[12px]">
                  {!['draft', 'failed'].includes(active.state) && (
                    <>
                      <span className="text-[var(--color-text-tertiary)]">尺寸</span>
                      <span className="text-right text-[var(--color-text-secondary)]">{active.size}</span>
                      <span className="text-[var(--color-text-tertiary)]">数量</span>
                      <span className="text-right text-[var(--color-text-secondary)]">{active.count}</span>
                    </>
                  )}
                  <span className="text-[var(--color-text-tertiary)]">方式</span>
                  <span className="text-right text-[var(--color-text-secondary)]">{active.mode === 'edit' ? `参考图编辑 (${active.reference_image_count})` : '生成新图'}</span>
                </div>
                {active.state === 'draft' && (
                  <button
                    type="button"
                    onClick={() => void startGeneration()}
                    disabled={loading || !prompt.trim()}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] bg-[var(--color-brand)] px-3 text-[13px] text-white disabled:opacity-45"
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    开始生成
                  </button>
                )}
                {active.task_id && ['queued', 'generating'].includes(active.state) && (
                  <button
                    type="button"
                    onClick={() => void refreshTask(active.task_id!)}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-border)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                  >
                    <RefreshCw size={14} />
                    刷新状态
                  </button>
                )}
                {active.task_id && task?.status === 'queued' && task.remote_task_id && (
                  <button
                    type="button"
                    onClick={() => void cancelTask(active.task_id!)}
                    disabled={loading}
                    className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] border border-[var(--color-border)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-45"
                  >
                    <X size={14} />
                    取消排队
                  </button>
                )}
                {active.state === 'failed' && (
                  <button
                    type="button"
                    onClick={() => void startGeneration()}
                    disabled={loading || !prompt.trim()}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[6px] bg-[var(--color-brand)] px-3 text-[13px] text-white disabled:opacity-45"
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    {task?.outcome_unknown
                      ? (task.remote_task_id || hasDraftChanges ? '确认后重新生成' : '确认上次提交')
                      : '重新生成'}
                  </button>
                )}
              </>
            )}
            {fidelityRisk && (
              <p className="mt-3 text-[12px] leading-5 text-[var(--color-warning)]">{fidelityRisk}</p>
            )}
            {(inputError || error || active?.error || task?.error) && (
              <p role="alert" className="mt-3 text-[12px] leading-5 text-[var(--color-error)]">
                {inputError || error || active?.error || task?.error}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
