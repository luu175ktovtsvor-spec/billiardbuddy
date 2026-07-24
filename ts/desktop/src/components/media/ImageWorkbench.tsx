import { useEffect, useMemo, useState } from 'react'
import { Download, ImagePlus, Loader2, Plus, RefreshCw, Sparkles, Undo2, X } from 'lucide-react'
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES_TOTAL_BYTES,
  type ImageCanvasSize,
  type ImageReferenceRole,
  type ImageTextLayer,
  mediaApi,
  mediaUserFacingError,
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

type ReferenceImage = { name: string; dataUrl: string; size: number; role: ImageReferenceRole }

const REFERENCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const IMAGE_SIZE_OPTIONS: Array<{
  value: ImageCanvasSize
  label: string
}> = [
  { value: '1024x1024', label: '方形 1:1 · 1024×1024' },
  { value: '1536x1024', label: '横版 3:2 · 1536×1024' },
  { value: '1024x1536', label: '竖版 2:3 · 1024×1536' },
  { value: '2048x2048', label: '2K 方形 1:1 · 2048×2048' },
  { value: '2048x1152', label: '2K 横版 16:9 · 2048×1152' },
  { value: '3840x2160', label: '4K 横版 16:9 · 3840×2160' },
  { value: '2160x3840', label: '4K 竖版 9:16 · 2160×3840' },
  { value: '2304x1728', label: '2K 横版 4:3 · 2304×1728' },
  { value: '1728x2304', label: '2K 竖版 3:4 · 1728×2304' },
  { value: '2848x1600', label: '2K 宽屏 16:9 · 2848×1600' },
  { value: '1600x2848', label: '2K 短视频 9:16 · 1600×2848' },
  { value: '2496x1664', label: '2K 横版 3:2 · 2496×1664' },
  { value: '1664x2496', label: '2K 竖版 2:3 · 1664×2496' },
  { value: '3136x1344', label: '2K 电影宽屏 21:9 · 3136×1344' },
  { value: '4096x4096', label: '4K 方形 1:1 · 4096×4096' },
  { value: '4704x3520', label: '4K 横版 4:3 · 4704×3520' },
  { value: '3520x4704', label: '4K 竖版 3:4 · 3520×4704' },
  { value: '5504x3040', label: '4K 宽屏 16:9 · 5504×3040' },
  { value: '3040x5504', label: '4K 短视频 9:16 · 3040×5504' },
  { value: '4992x3328', label: '4K 横版 3:2 · 4992×3328' },
  { value: '3328x4992', label: '4K 竖版 2:3 · 3328×4992' },
  { value: '6240x2656', label: '4K 电影宽屏 21:9 · 6240×2656' },
]

const REFERENCE_ROLE_OPTIONS: Array<{ value: ImageReferenceRole; label: string }> = [
  { value: 'unclassified', label: '请选择作用' },
  { value: 'subject', label: '主体' },
  { value: 'style', label: '风格' },
  { value: 'environment', label: '环境' },
  { value: 'brand', label: '品牌' },
  { value: 'logo', label: 'Logo' },
  { value: 'qrcode', label: '二维码' },
]

/**
 * A queued task can sit behind a paid image slot for minutes. Respect the relay's
 * backoff hint and add a stable small jitter so a 500-window burst does not wake up
 * and poll the mainland/US path in one synchronized spike.
 */
export function imageTaskPollDelayMs(
  taskId: string,
  state: string,
  suggestedSeconds?: number,
): number {
  const fallbackSeconds = state === 'generating' ? 3 : 15
  const rawSeconds = typeof suggestedSeconds === 'number' && Number.isFinite(suggestedSeconds)
    ? Math.trunc(suggestedSeconds)
    : fallbackSeconds
  const baseMs = Math.max(2_500, Math.min(60_000, Math.max(1, rawSeconds) * 1_000))
  let hash = 0
  for (let index = 0; index < taskId.length; index += 1) hash = (hash * 31 + taskId.charCodeAt(index)) >>> 0
  const jitterMs = Math.max(250, Math.floor(baseMs * 0.1))
  return baseMs + (hash % jitterMs)
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('无法读取参考图片'))
    reader.onerror = () => reject(new Error('无法读取参考图片，请更换后重试。'))
    reader.readAsDataURL(file)
  })
}

function loadCanvasImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'))
    image.src = url
  })
}

async function renderUpscale(url: string, scale: 2 | 3 | 4) {
  const image = await loadCanvasImage(url)
  const width = image.naturalWidth * scale
  const height = image.naturalHeight * scale
  if (width > 12000 || height > 12000) throw new Error('IMAGE_TOO_LARGE')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('CANVAS_UNAVAILABLE')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  return { rendered_image: canvas.toDataURL('image/png'), width, height }
}

async function renderTextLayers(url: string, copy: string) {
  const image = await loadCanvasImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('CANVAS_UNAVAILABLE')
  context.drawImage(image, 0, 0)
  const lines = copy.split('\n').map(line => line.trim()).filter(Boolean)
  const fontSize = Math.max(24, Math.min(160, Math.round(canvas.width / 14)))
  const lineHeight = Math.round(fontSize * 1.3)
  const startY = Math.round(canvas.height * 0.12)
  const layers: ImageTextLayer[] = lines.map((text, index) => ({
    id: `text_${crypto.randomUUID().replaceAll('-', '')}`,
    text,
    x: Math.round(canvas.width / 2),
    y: startY + index * lineHeight,
    max_width: Math.round(canvas.width * 0.84),
    fill: '#ffffff',
    font_family: 'PingFang SC',
    font_size: fontSize,
    font_weight: 'bold',
    text_align: 'center',
  }))
  context.textBaseline = 'top'
  for (const layer of layers) {
    context.font = `${layer.font_weight} ${layer.font_size}px ${layer.font_family}`
    context.textAlign = layer.text_align
    context.fillStyle = layer.fill
    context.strokeStyle = '#000000'
    context.lineWidth = Math.max(2, Math.round(layer.font_size / 18))
    context.strokeText(layer.text, layer.x, layer.y, layer.max_width)
    context.fillText(layer.text, layer.x, layer.y, layer.max_width)
  }
  return {
    rendered_image: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    text_layers: layers,
  }
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
  const startImageOperation = useMediaWorkbenchStore(state => state.startImageOperation)
  const commitImageVersion = useMediaWorkbenchStore(state => state.commitImageVersion)
  const selectImageVersion = useMediaWorkbenchStore(state => state.selectImageVersion)
  const refreshTask = useMediaWorkbenchStore(state => state.refreshTask)
  const cancelTask = useMediaWorkbenchStore(state => state.cancelTask)
  const deleteProject = useMediaWorkbenchStore(state => state.deleteProject)
  const clearError = useMediaWorkbenchStore(state => state.clearError)
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [size, setSize] = useState<ImageCanvasSize>('1024x1024')
  const [references, setReferences] = useState<ReferenceImage[]>([])
  const [selectedOutput, setSelectedOutput] = useState(0)
  const [operationKind, setOperationKind] = useState<'edit' | 'inpaint'>('edit')
  const [operationInstruction, setOperationInstruction] = useState('')
  const [maskDataUrl, setMaskDataUrl] = useState<string | null>(null)
  const [upscale, setUpscale] = useState<2 | 3 | 4>(2)
  const [textCopy, setTextCopy] = useState('')
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
  const versions = active?.version_history ?? []
  const outputUrls = versions.map(version => version.image_path.startsWith('/api/')
    ? mediaApi.assetUrl(version.image_path)
    : version.image_path)
  const outputUrl = outputUrls[selectedOutput] ?? outputUrls[0]
  const selectedVersion = versions[selectedOutput] ?? versions[0]
  const currentVersion = versions.find(version => version.id === active?.current_version_id)
  const undoVersion = currentVersion?.parent_version_id
    ? versions.find(version => version.id === currentVersion.parent_version_id)
    : undefined
  const redoVersion = currentVersion
    ? [...versions].reverse().find(version => version.parent_version_id === currentVersion.id)
    : undefined
  const storeError = error ? mediaUserFacingError(new Error(error)) : null
  const projectError = active?.error
    ? mediaUserFacingError({ code: active.error_code })
    : null
  const taskError = task?.error
    ? mediaUserFacingError({ code: task.error_code })
    : null
  const [previewWidth, previewHeight] = (active?.size ?? size).split('x').map(Number)

  useEffect(() => {
    void loadProjects('image')
  }, [loadProjects])

  useEffect(() => {
    const currentIndex = active?.current_version_id
      ? versions.findIndex(version => version.id === active.current_version_id)
      : -1
    setSelectedOutput(currentIndex >= 0 ? currentIndex : 0)
    setOperationInstruction('')
    setMaskDataUrl(null)
    setTextCopy(active?.brief?.exact_text.join('\n') ?? '')
  }, [activeId, active?.current_version_id])

  useEffect(() => {
    if (!active || creating) return
    setPrompt(active.brief?.user_request ?? '')
    setSize(active.size)
  }, [active, creating])

  useEffect(() => {
    if (!active?.task_id || active.state === 'ready' || active.state === 'failed') return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      if (stopped) return
      await refreshTask(active.task_id!).catch(() => undefined)
      if (!stopped) {
        timer = window.setTimeout(
          () => void poll(),
          imageTaskPollDelayMs(active.task_id!, active.state, task?.poll_after_seconds),
        )
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [active?.state, active?.task_id, refreshTask, task?.poll_after_seconds])

  const beginNew = () => {
    clearError()
    selectImage(null)
    setPrompt('')
    setSize('1024x1024')
    setReferences([])
    setInputError(null)
    setCreating(true)
  }

  const saveDraft = async () => {
    const value = prompt.trim()
    if (!value) return
    await createImage({
      user_request: value,
      size,
      reference_images: references.map(reference => reference.dataUrl),
      reference_roles: references.map(reference => reference.role),
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
      role: 'unclassified' as const,
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
    && (
      prompt.trim() !== active.brief?.user_request
      || size !== active.size
    ),
  )

  const saveActiveDraft = async (confirmUnknownRetry = false) => {
    if (!active || !prompt.trim()) return active
    if (!hasDraftChanges) return active
    return await saveImageDraft({
      ...active,
      brief: { ...active.brief!, user_request: prompt.trim() },
      size,
    }, confirmUnknownRetry)
  }

  const startGeneration = async () => {
    if (!active) return
    const unknownOutcome = task?.outcome_unknown === true
    const createsNewPaidTask = unknownOutcome && (Boolean(task.remote_task_id) || hasDraftChanges)
    const warnings = [
      unknownOutcome ? (createsNewPaidTask
        ? '上一次任务的结果无法确认，可能已经产生费用。继续会创建一个新的生图任务，可能再次扣费。确认继续吗？'
        : '上一次提交的结果无法确认，可能已经产生费用。继续只会使用原来的提交编号确认状态，不会主动创建第二个任务。') : '',
      `将把已确认的 Brief${active.reference_image_count > 0 ? '和参考图片' : ''}发送到美国 Relay，由当前 ImageGeneration 能力执行。Relay 在任务终态删除输入，结果最多保留 7 天；本次将生成 3 个候选并可能产生费用。进入生成服务后无法撤销，确认继续吗？`,
    ].filter(Boolean).join('\n\n')
    if (!window.confirm(warnings)) return
    const project = await saveActiveDraft(createsNewPaidTask)
    if (!project) return
    await submitImage(project.id, createsNewPaidTask, true)
  }

  const downloadOutput = async () => {
    if (!outputUrl || !active || !selectedVersion) return
    const mime = selectedVersion.mime_type
    const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
    const safeTitle = active.title.replace(/[\\/:*?"<>|]/g, '_').trim() || '图片'
    try {
      const outputPath = await getDesktopHost().dialogs.save({
        title: '保存图片',
        defaultPath: `${safeTitle}-${selectedOutput + 1}.${extension}`,
        filters: [{ name: '图片', extensions: [extension] }],
      })
      if (!outputPath) return
      await mediaApi.saveImageOutput(active.id, { version_id: selectedVersion.id, output_path: outputPath })
      setInputError(null)
    } catch (error) {
      setInputError(mediaUserFacingError(error, '暂时无法保存图片，请检查保存位置后重试。'))
    }
  }

  const chooseVersion = async () => {
    if (!active || !selectedVersion || active.current_version_id === selectedVersion.id) return
    await selectImageVersion(active.id, active.revision, selectedVersion.id)
  }

  const runProviderOperation = async () => {
    if (!active || !selectedVersion || !operationInstruction.trim()) return
    if (operationKind === 'inpaint' && !maskDataUrl) {
      setInputError('局部重绘需要上传与基础版本同尺寸的透明 PNG 蒙版')
      return
    }
    if (!window.confirm('将把当前基础版本、编辑指令和可选蒙版发送到美国 Relay，由 ImageGeneration 能力执行；本次可能产生费用。确认继续吗？')) return
    await startImageOperation(active.id, {
      revision: active.revision,
      base_version_id: selectedVersion.id,
      kind: operationKind,
      instruction: operationInstruction.trim(),
      mask_data_url: operationKind === 'inpaint' ? maskDataUrl ?? undefined : undefined,
      confirm_unknown_retry: task?.outcome_unknown === true,
    }, true)
  }

  const commitUpscale = async () => {
    if (!active || !selectedVersion || !outputUrl) return
    try {
      const rendered = await renderUpscale(outputUrl, upscale)
      await commitImageVersion(active.id, {
        revision: active.revision,
        base_version_id: selectedVersion.id,
        kind: 'upscale',
        scale: upscale,
        text_layers: [],
        ...rendered,
      })
      setInputError(null)
    } catch (error) {
      setInputError(mediaUserFacingError(error, '无法在本机完成图片放大，请换一个版本后重试。'))
    }
  }

  const commitText = async () => {
    if (!active || !selectedVersion || !outputUrl || !textCopy.trim()) return
    try {
      const rendered = await renderTextLayers(outputUrl, textCopy)
      await commitImageVersion(active.id, {
        revision: active.revision,
        base_version_id: selectedVersion.id,
        kind: 'text_layout',
        ...rendered,
      })
      setInputError(null)
    } catch (error) {
      setInputError(mediaUserFacingError(error, '无法在本机完成文字排版，请检查文字后重试。'))
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
            <div
              className="flex max-h-[68vh] w-[min(68vh,70%)] max-w-[720px] items-center justify-center border border-dashed border-[var(--color-border)] bg-[var(--color-app-main)]"
              style={{ aspectRatio: `${previewWidth || 1} / ${previewHeight || 1}` }}
            >
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
                  key={versions[index]?.id ?? `${active?.id ?? 'output'}-${index}`}
                  type="button"
                  onClick={() => setSelectedOutput(index)}
                  className="h-14 w-14 shrink-0 overflow-hidden border bg-[var(--color-app-main)]"
                  style={{ borderColor: index === selectedOutput ? 'var(--color-brand)' : 'var(--color-border)' }}
                  aria-label={`查看版本 ${index + 1}`}
                >
                  <img src={url} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
          {outputUrl && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void chooseVersion()}
                disabled={!selectedVersion || active?.current_version_id === selectedVersion.id || loading}
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-app-main)] px-3 text-[12px] text-[var(--color-text-secondary)] disabled:opacity-45"
              >
                <Undo2 size={14} aria-hidden="true" />
                {active?.current_version_id === selectedVersion?.id ? '当前版本' : '切换到此版本'}
              </button>
              <button
                type="button"
                onClick={() => void downloadOutput()}
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-app-main)] px-3 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
              >
                <Download size={14} aria-hidden="true" />
                导出当前预览
              </button>
            </div>
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
                          <div key={`${reference.name}-${index}`} className="group relative border border-[var(--color-border)]">
                            <div className="relative aspect-square overflow-hidden">
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
                            <select
                              aria-label={`${reference.name} 的作用`}
                              value={reference.role}
                              onChange={event => setReferences(current => current.map((item, itemIndex) => itemIndex === index
                                ? { ...item, role: event.target.value as ImageReferenceRole }
                                : item))}
                              className="h-7 w-full border-t border-[var(--color-border)] bg-[var(--color-input-bg)] px-1 text-[10px]"
                            >
                              {REFERENCE_ROLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                </div>
                <div className="mt-3 grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2 text-[12px]">
                  <label htmlFor="image-size" className="text-[var(--color-text-tertiary)]">画布</label>
                  <select
                    id="image-size"
                    value={size}
                    onChange={event => setSize(event.target.value as typeof size)}
                    className="h-8 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none"
                  >
                    {IMAGE_SIZE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <span className="text-[var(--color-text-tertiary)]">候选</span>
                  <span className="text-[var(--color-text-secondary)]">固定生成 3 张</span>
                </div>
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={loading || !prompt.trim() || references.some(reference => reference.role === 'unclassified')}
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
                        {IMAGE_SIZE_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <span className="text-[var(--color-text-tertiary)]">候选</span>
                      <span className="text-[var(--color-text-secondary)]">固定生成 3 张</span>
                    </div>
                  </>
                ) : (
                  <div className="mb-4">
                    <div className="mb-1 text-[11px] text-[var(--color-text-tertiary)]">画面需求</div>
                    <p className="whitespace-pre-wrap text-[13px] leading-5 text-[var(--color-text-primary)]">{active.brief?.user_request}</p>
                    {active.brief && (
                      <div className="mt-3 space-y-2 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                        {active.brief.must_preserve.length > 0 && <p>必须保留：{active.brief.must_preserve.join('；')}</p>}
                        {active.brief.may_change.length > 0 && <p>允许调整：{active.brief.may_change.join('；')}</p>}
                        {active.brief.missing_information.length > 0 && <p className="text-[var(--color-warning)]">待补信息：{active.brief.missing_information.join('；')}</p>}
                      </div>
                    )}
                  </div>
                )}
                <div className="mb-5 mt-4 grid grid-cols-2 gap-y-2 text-[12px]">
                  {!['draft', 'failed'].includes(active.state) && (
                    <>
                      <span className="text-[var(--color-text-tertiary)]">尺寸</span>
                      <span className="text-right text-[var(--color-text-secondary)]">{active.size}</span>
                      <span className="text-[var(--color-text-tertiary)]">候选</span>
                      <span className="text-right text-[var(--color-text-secondary)]">{active.candidate_count}</span>
                    </>
                  )}
                  <span className="text-[var(--color-text-tertiary)]">方式</span>
                  <span className="text-right text-[var(--color-text-secondary)]">{active.reference_image_count > 0 ? `参考图生成 (${active.reference_image_count})` : '文字生成'}</span>
                </div>
                {currentVersion && (
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => undoVersion && void selectImageVersion(active.id, active.revision, undoVersion.id)}
                      disabled={!undoVersion || loading}
                      className="h-8 rounded-[6px] border border-[var(--color-border)] text-[12px] disabled:opacity-45"
                    >
                      撤销到父版本
                    </button>
                    <button
                      type="button"
                      onClick={() => redoVersion && void selectImageVersion(active.id, active.revision, redoVersion.id)}
                      disabled={!redoVersion || loading}
                      className="h-8 rounded-[6px] border border-[var(--color-border)] text-[12px] disabled:opacity-45"
                    >
                      重做到子版本
                    </button>
                  </div>
                )}
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
                {selectedVersion && active.current_version_id !== selectedVersion.id && !['queued', 'generating'].includes(active.state) && (
                  <p className="mt-4 text-[11px] leading-4 text-[var(--color-text-tertiary)]">先在预览区将这个候选切换为当前版本，再从它继续编辑。</p>
                )}
                {selectedVersion && active.current_version_id === selectedVersion.id && !['queued', 'generating'].includes(active.state) && (
                  <div className="mt-5 border-t border-[var(--color-border)] pt-4">
                    <div className="mb-2 text-[12px] font-medium text-[var(--color-text-primary)]">从所选版本继续</div>
                    <div className="grid grid-cols-2 gap-1 rounded-[6px] bg-[var(--color-surface-container)] p-1">
                      {(['edit', 'inpaint'] as const).map(kind => (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => { setOperationKind(kind); setMaskDataUrl(null) }}
                          className="h-7 rounded-[4px] text-[12px]"
                          style={{ background: operationKind === kind ? 'var(--color-app-main)' : undefined }}
                        >
                          {kind === 'edit' ? '继续编辑' : '局部重绘'}
                        </button>
                      ))}
                    </div>
                    <textarea
                      aria-label="图片编辑指令"
                      value={operationInstruction}
                      onChange={event => setOperationInstruction(event.target.value)}
                      rows={3}
                      placeholder="说明要修改什么，以及必须保持不变的内容"
                      className="mt-2 w-full resize-none rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 py-1.5 text-[12px]"
                    />
                    {operationKind === 'inpaint' && (
                      <label className="mt-2 block text-[11px] text-[var(--color-text-secondary)]">
                        透明 PNG 蒙版（透明区域将被重绘）
                        <input
                          type="file"
                          accept="image/png"
                          onChange={event => {
                            const file = event.target.files?.[0]
                            if (file) void readImage(file).then(setMaskDataUrl)
                          }}
                          className="mt-1 block w-full text-[11px]"
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => void runProviderOperation()}
                      disabled={loading || !operationInstruction.trim() || (operationKind === 'inpaint' && !maskDataUrl)}
                      className="mt-2 h-8 w-full rounded-[6px] bg-[var(--color-brand)] text-[12px] text-white disabled:opacity-45"
                    >
                      {operationKind === 'edit' ? '生成编辑版本' : '生成局部重绘版本'}
                    </button>

                    <div className="mt-4 grid grid-cols-[1fr_72px] gap-2">
                      <select
                        aria-label="放大倍数"
                        value={upscale}
                        onChange={event => setUpscale(Number(event.target.value) as 2 | 3 | 4)}
                        className="h-8 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[12px]"
                      >
                        <option value={2}>本机高质量放大 2×</option>
                        <option value={3}>本机高质量放大 3×</option>
                        <option value={4}>本机高质量放大 4×</option>
                      </select>
                      <button type="button" onClick={() => void commitUpscale()} disabled={loading} className="h-8 rounded-[6px] border border-[var(--color-border)] text-[12px] disabled:opacity-45">放大</button>
                    </div>

                    <textarea
                      aria-label="精确文字图层"
                      value={textCopy}
                      onChange={event => setTextCopy(event.target.value)}
                      rows={4}
                      placeholder="每行生成一个确定性文字图层"
                      className="mt-4 w-full resize-none rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 py-1.5 text-[12px]"
                    />
                    <button type="button" onClick={() => void commitText()} disabled={loading || !textCopy.trim()} className="mt-2 h-8 w-full rounded-[6px] border border-[var(--color-border)] text-[12px] disabled:opacity-45">生成文字排版版本</button>
                  </div>
                )}
              </>
            )}
            {fidelityRisk && (
              <p className="mt-3 text-[12px] leading-5 text-[var(--color-warning)]">{fidelityRisk}</p>
            )}
            {(inputError || storeError || projectError || taskError) && (
              <p role="alert" className="mt-3 text-[12px] leading-5 text-[var(--color-error)]">
                {inputError || storeError || projectError || taskError}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
