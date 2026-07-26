import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Columns2, Download, ImagePlus, Layers3, Loader2, Minus, Paintbrush, Plus, RefreshCw, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES_TOTAL_BYTES,
  type ImageBriefOverrides,
  type ImageCanvasSize,
  type ImageProjectReference,
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
type TextLayoutSetting = { x: number; y: number; fontSize: number; fill: string }
type EditableBriefField = keyof ImageBriefOverrides

const EDITABLE_BRIEF_FIELDS: Array<{ field: EditableBriefField; label: string; help: string }> = [
  { field: 'confirmed_facts', label: '已确认事实', help: '价格、日期、地址等只能来自你确认的事实' },
  { field: 'must_preserve', label: '必须保留', help: '主体、品牌、Logo、二维码或其他不能改变的元素' },
  { field: 'may_change', label: '允许调整', help: '模型和编辑工具可以变化的视觉部分' },
  { field: 'exact_text', label: '精确文字', help: '每行一段，生成后由确定性文字图层排版' },
]

function lines(value: string): string[] {
  return [...new Set(value.split('\n').map(item => item.trim()).filter(Boolean))].slice(0, 40)
}

function sameBriefOverrides(left: ImageBriefOverrides, right: ImageBriefOverrides): boolean {
  return EDITABLE_BRIEF_FIELDS.every(({ field }) => JSON.stringify(left[field]) === JSON.stringify(right[field]))
}

function sameReferences(left: ImageProjectReference[], right: ImageProjectReference[]): boolean {
  const project = (reference: ImageProjectReference) => ({
    asset_id: reference.asset_id,
    role: reference.role,
    label: reference.label,
  })
  return JSON.stringify(left.map(project)) === JSON.stringify(right.map(project))
}

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

const REFERENCE_ROLE_LABELS = Object.fromEntries(
  REFERENCE_ROLE_OPTIONS.map(option => [option.value, option.label]),
) as Record<ImageReferenceRole, string>

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

async function renderTextLayers(url: string, sourceLayers: ImageTextLayer[]) {
  const image = await loadCanvasImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('CANVAS_UNAVAILABLE')
  context.drawImage(image, 0, 0)
  const layers: ImageTextLayer[] = sourceLayers.map(layer => ({
    ...layer,
    id: `text_${crypto.randomUUID().replaceAll('-', '')}`,
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

function ImageCanvasSurface({
  url,
  title,
  textLayers,
  selectedLayerId,
  onSelectLayer,
  zoom,
  showTextContent = false,
  maskEditing = false,
  maskBrushSize = 128,
  maskDataUrl = null,
  onMaskChange,
}: {
  url: string
  title: string
  textLayers: ImageTextLayer[]
  selectedLayerId: string | null
  onSelectLayer: (id: string | null) => void
  zoom: number
  showTextContent?: boolean
  maskEditing?: boolean
  maskBrushSize?: number
  maskDataUrl?: string | null
  onMaskChange?: (dataUrl: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskBufferRef = useRef<HTMLCanvasElement | null>(null)
  const maskPointerRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 })

  useEffect(() => {
    let active = true
    void loadCanvasImage(url).then(image => {
      if (!active || !canvasRef.current) return
      const canvas = canvasRef.current
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0)
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight })
    })
    return () => { active = false }
  }, [url])

  useEffect(() => {
    if (!maskEditing) return
    let active = true
    void loadCanvasImage(url).then(async image => {
      if (!active || !maskCanvasRef.current) return
      const mask = document.createElement('canvas')
      mask.width = image.naturalWidth
      mask.height = image.naturalHeight
      const maskContext = mask.getContext('2d')
      const overlay = maskCanvasRef.current
      overlay.width = image.naturalWidth
      overlay.height = image.naturalHeight
      const overlayContext = overlay.getContext('2d')
      if (!maskContext || !overlayContext) return
      maskContext.fillStyle = '#ffffff'
      maskContext.fillRect(0, 0, mask.width, mask.height)
      if (maskDataUrl) {
        const persistedMask = await loadCanvasImage(maskDataUrl)
        if (!active) return
        maskContext.clearRect(0, 0, mask.width, mask.height)
        maskContext.drawImage(persistedMask, 0, 0, mask.width, mask.height)
      }
      overlayContext.clearRect(0, 0, overlay.width, overlay.height)
      overlayContext.fillStyle = 'rgba(239, 68, 68, 0.42)'
      overlayContext.fillRect(0, 0, overlay.width, overlay.height)
      overlayContext.globalCompositeOperation = 'destination-out'
      overlayContext.drawImage(mask, 0, 0)
      overlayContext.globalCompositeOperation = 'source-over'
      maskBufferRef.current = mask
    })
    return () => {
      active = false
      maskPointerRef.current = null
    }
  }, [maskDataUrl, maskEditing, url])

  const maskPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = maskCanvasRef.current
    if (!canvas) return null
    const bounds = canvas.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return null
    return {
      x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height,
    }
  }

  const paintMask = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const mask = maskBufferRef.current
    const overlay = maskCanvasRef.current
    const maskContext = mask?.getContext('2d')
    const overlayContext = overlay?.getContext('2d')
    if (!maskContext || !overlayContext) return
    for (const context of [maskContext, overlayContext]) {
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.lineWidth = maskBrushSize
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
    }
    maskContext.globalCompositeOperation = 'destination-out'
    maskContext.stroke()
    maskContext.globalCompositeOperation = 'source-over'
    overlayContext.globalCompositeOperation = 'source-over'
    overlayContext.strokeStyle = 'rgba(239, 68, 68, 0.42)'
    overlayContext.stroke()
  }

  const beginMaskStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = maskPoint(event)
    if (!point || !maskEditing) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    maskPointerRef.current = { id: event.pointerId, ...point }
    paintMask(point, point)
  }

  const continueMaskStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const previous = maskPointerRef.current
    if (!previous || previous.id !== event.pointerId) return
    const point = maskPoint(event)
    if (!point) return
    event.preventDefault()
    paintMask(previous, point)
    maskPointerRef.current = { id: event.pointerId, ...point }
  }

  const finishMaskStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const previous = maskPointerRef.current
    if (!previous || previous.id !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    maskPointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const mask = maskBufferRef.current
    if (mask) onMaskChange?.(mask.toDataURL('image/png'))
  }

  return (
    <div
      className="relative origin-center shadow-[var(--shadow-popover)]"
      style={{ transform: `scale(${zoom})` }}
      data-testid="image-canvas-surface"
    >
      <canvas
        ref={canvasRef}
        aria-label={title}
        className="block max-h-[62vh] max-w-[min(70vw,920px)] bg-white object-contain"
        onClick={() => onSelectLayer(null)}
      />
      {maskEditing && (
        <canvas
          ref={maskCanvasRef}
          aria-label="局部重绘蒙版画布"
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
          onPointerDown={beginMaskStroke}
          onPointerMove={continueMaskStroke}
          onPointerUp={finishMaskStroke}
          onPointerCancel={finishMaskStroke}
        />
      )}
      {textLayers.map(layer => {
        const width = Math.min(100, ((layer.max_width ?? dimensions.width) / dimensions.width) * 100)
        const left = layer.text_align === 'center'
          ? (layer.x / dimensions.width) * 100 - width / 2
          : layer.text_align === 'right'
            ? (layer.x / dimensions.width) * 100 - width
            : (layer.x / dimensions.width) * 100
        return (
          <button
            key={layer.id}
            type="button"
            aria-label={`选择文字图层 ${layer.text}`}
            onClick={event => { event.stopPropagation(); onSelectLayer(layer.id) }}
            className="absolute overflow-hidden border bg-transparent text-center"
            style={{
              left: `${Math.max(0, left)}%`,
              top: `${Math.min(100, (layer.y / dimensions.height) * 100)}%`,
              width: `${width}%`,
              height: `${Math.max(2, (layer.font_size * 1.3 / dimensions.height) * 100)}%`,
              borderColor: selectedLayerId === layer.id ? 'var(--color-brand)' : 'transparent',
            }}
          >
            {showTextContent && (
              <span
                className="block whitespace-nowrap"
                style={{
                  color: layer.fill,
                  fontFamily: layer.font_family,
                  fontSize: `${Math.max(8, (layer.font_size / dimensions.width) * 700)}px`,
                  fontWeight: layer.font_weight,
                }}
              >{layer.text}</span>
            )}
          </button>
        )
      })}
    </div>
  )
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
  const subscribeProjectEvents = useMediaWorkbenchStore(state => state.subscribeProjectEvents)
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
  const [maskBrushSize, setMaskBrushSize] = useState(128)
  const [upscale, setUpscale] = useState<2 | 3 | 4>(2)
  const [textCopy, setTextCopy] = useState('')
  const [textLayoutSettings, setTextLayoutSettings] = useState<Record<number, TextLayoutSetting>>({})
  const [inputError, setInputError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [compareMode, setCompareMode] = useState(false)
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null)
  const [briefOverrides, setBriefOverrides] = useState<ImageBriefOverrides>({})
  const [referenceDraft, setReferenceDraft] = useState<ImageProjectReference[]>([])
  const [pendingReferences, setPendingReferences] = useState<ReferenceImage[]>([])
  const promptRef = useRef(prompt)
  const sizeRef = useRef(size)
  const draftOwnerIdRef = useRef<string | null>(null)
  const draftDirtyRef = useRef(false)

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
  const currentVersionIndex = currentVersion
    ? versions.findIndex(version => version.id === currentVersion.id)
    : -1
  const currentVersionUrl = currentVersionIndex >= 0 ? outputUrls[currentVersionIndex] : undefined
  const draftCanvasWidth = selectedVersion?.width ?? previewWidth ?? 1024
  const draftCanvasHeight = selectedVersion?.height ?? previewHeight ?? 1024
  const draftTextLayers = useMemo<ImageTextLayer[]>(() => textCopy
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((text, index) => {
      const defaults: TextLayoutSetting = {
        x: 50,
        y: Math.min(90, 12 + index * 10),
        fontSize: Math.max(24, Math.min(160, Math.round(draftCanvasWidth / 14))),
        fill: '#ffffff',
      }
      const setting = textLayoutSettings[index] ?? defaults
      return {
        id: `text_preview_${String(index).padStart(4, '0')}`,
        text,
        x: Math.round(draftCanvasWidth * setting.x / 100),
        y: Math.round(draftCanvasHeight * setting.y / 100),
        max_width: Math.round(draftCanvasWidth * 0.84),
        fill: setting.fill,
        font_family: 'PingFang SC',
        font_size: setting.fontSize,
        font_weight: 'bold',
        text_align: 'center',
      }
    }), [draftCanvasHeight, draftCanvasWidth, textCopy, textLayoutSettings])
  const previewingDraftText = Boolean(
    active
    && selectedVersion
    && active.current_version_id === selectedVersion.id
    && selectedVersion.kind !== 'text_layout'
    && draftTextLayers.length > 0,
  )
  const visibleCanvasLayers = previewingDraftText ? draftTextLayers : selectedVersion?.text_layers ?? []
  const maskEditing = Boolean(
    active
    && selectedVersion
    && active.current_version_id === selectedVersion.id
    && operationKind === 'inpaint'
    && !['queued', 'generating'].includes(active.state),
  )

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
    setSelectedLayerId(null)
    setCompareMode(false)
    setZoom(1)
    setTextLayoutSettings({})
    setTextCopy(active?.brief?.exact_text.join('\n') ?? '')
    setBriefOverrides(active?.brief_overrides ?? {})
    setReferenceDraft(active?.references ?? [])
    setPendingReferences([])
  }, [activeId, active?.current_version_id])

  useEffect(() => { promptRef.current = prompt }, [prompt])
  useEffect(() => { sizeRef.current = size }, [size])

  useEffect(() => {
    if (creating) return
    if (!active) return

    const nextPrompt = active.brief?.user_request ?? ''
    const ownsCurrentProject = draftOwnerIdRef.current === active.id
    const localMatchesLatest = promptRef.current.trim() === nextPrompt && sizeRef.current === active.size
    if (!ownsCurrentProject || !draftDirtyRef.current || localMatchesLatest) {
      promptRef.current = nextPrompt
      sizeRef.current = active.size
      draftOwnerIdRef.current = active.id
      draftDirtyRef.current = false
      setPrompt(nextPrompt)
      setSize(active.size)
    }
  }, [active, creating])

  useEffect(() => active?.id
    ? subscribeProjectEvents(active.id, 'image')
    : undefined, [active?.id, subscribeProjectEvents])

  const beginNew = () => {
    clearError()
    selectImage(null)
    setPrompt('')
    setSize('1024x1024')
    draftOwnerIdRef.current = null
    draftDirtyRef.current = false
    setReferences([])
    setBriefOverrides({})
    setReferenceDraft([])
    setPendingReferences([])
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

  const addPendingReferences = async (files: FileList | null) => {
    if (!files?.length) return
    const remaining = Math.max(0, 8 - referenceDraft.length - pendingReferences.length)
    if (files.length > remaining) {
      setInputError('每个项目最多保留 8 张参考图片')
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
    const pendingBytes = pendingReferences.reduce((total, reference) => total + reference.size, 0)
      + selected.reduce((total, file) => total + file.size, 0)
    if (pendingBytes > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
      setInputError(`本次新增参考图片合计不能超过 ${megabytes(MAX_REFERENCE_IMAGES_TOTAL_BYTES)}`)
      return
    }
    const loaded = await Promise.all(selected.map(async file => ({
      name: file.name,
      size: file.size,
      dataUrl: await readImage(file),
      role: 'unclassified' as const,
    })))
    setPendingReferences(current => [...current, ...loaded])
    setInputError(null)
  }

  const hasDraftChanges = Boolean(
    active
    && (
      prompt.trim() !== active.brief?.user_request
      || size !== active.size
      || !sameBriefOverrides(briefOverrides, active.brief_overrides ?? {})
      || !sameReferences(referenceDraft, active.references)
      || pendingReferences.length > 0
    ),
  )

  const saveActiveDraft = async (confirmUnknownRetry = false) => {
    if (!active || !prompt.trim()) return active
    if (pendingReferences.some(reference => reference.role === 'unclassified')) {
      setInputError('请先为每张新增参考图片选择作用')
      return null
    }
    if (!hasDraftChanges) return active
    const saved = await saveImageDraft({
      ...active,
      brief: { ...active.brief!, user_request: prompt.trim() },
      brief_overrides: briefOverrides,
      references: referenceDraft,
      size,
    }, confirmUnknownRetry, pendingReferences)
    setReferenceDraft(saved.references)
    setPendingReferences([])
    return saved
  }

  const startGeneration = async () => {
    if (!active) return
    const unknownOutcome = task?.outcome_unknown === true
    const createsNewRemoteTask = unknownOutcome && (Boolean(task.remote_task_id) || hasDraftChanges)
    if (createsNewRemoteTask && !window.confirm('上一次任务的结果无法确认。继续会创建新的远程操作，而不是重用原提交编号查询状态。确认继续吗？')) return
    const project = await saveActiveDraft(createsNewRemoteTask)
    if (!project) return
    await submitImage(project.id, createsNewRemoteTask)
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
    const confirmUnknownRetry = task?.outcome_unknown === true
    if (confirmUnknownRetry && !window.confirm('上一次远程图片操作的结果无法确认。继续会创建新的付费操作，可能产生重复结果和费用。确认继续吗？')) return
    await startImageOperation(active.id, {
      revision: active.revision,
      base_version_id: selectedVersion.id,
      kind: operationKind,
      instruction: operationInstruction.trim(),
      mask_data_url: operationKind === 'inpaint' ? maskDataUrl ?? undefined : undefined,
      confirm_unknown_retry: confirmUnknownRetry,
    })
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
    if (!active || !selectedVersion || !outputUrl || draftTextLayers.length === 0) return
    try {
      const rendered = await renderTextLayers(outputUrl, draftTextLayers)
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

  const updateTextLayoutSetting = (index: number, patch: Partial<TextLayoutSetting>) => {
    setTextLayoutSettings(current => ({
      ...current,
      [index]: {
        x: 50,
        y: Math.min(90, 12 + index * 10),
        fontSize: Math.max(24, Math.min(160, Math.round(draftCanvasWidth / 14))),
        fill: '#ffffff',
        ...current[index],
        ...patch,
      },
    }))
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

        <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-surface-container-low)]">
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
            <div className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]">
              <Layers3 size={14} aria-hidden="true" />
              画布 · {selectedVersion ? `版本 ${selectedOutput + 1}` : '尚无版本'}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom(value => Math.max(0.5, Number((value - 0.25).toFixed(2))))}
                className="flex h-7 w-7 items-center justify-center rounded-[5px] hover:bg-[var(--color-surface-hover)]"
                aria-label="缩小画布"
              ><Minus size={14} /></button>
              <span className="w-10 text-center text-[11px] text-[var(--color-text-tertiary)]">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom(value => Math.min(2, Number((value + 0.25).toFixed(2))))}
                className="flex h-7 w-7 items-center justify-center rounded-[5px] hover:bg-[var(--color-surface-hover)]"
                aria-label="放大画布"
              ><Plus size={14} /></button>
              <button
                type="button"
                onClick={() => setCompareMode(value => !value)}
                disabled={!outputUrl || !currentVersionUrl || currentVersionUrl === outputUrl}
                className="ml-2 inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
                aria-pressed={compareMode}
              ><Columns2 size={14} />对比当前版本</button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center gap-5 overflow-auto p-6">
            {outputUrl && selectedVersion ? (
              <>
                {compareMode && currentVersionUrl && currentVersion && (
                  <div className="flex min-w-0 flex-col items-center gap-2">
                    <span className="text-[11px] text-[var(--color-text-tertiary)]">当前版本</span>
                    <ImageCanvasSurface
                      url={currentVersionUrl}
                      title={`${active?.title ?? '图片'}当前版本`}
                      textLayers={currentVersion.text_layers}
                      selectedLayerId={null}
                      onSelectLayer={() => undefined}
                      zoom={Math.min(zoom, 1)}
                    />
                  </div>
                )}
                <div className="flex min-w-0 flex-col items-center gap-2">
                  {compareMode && <span className="text-[11px] text-[var(--color-text-tertiary)]">所选候选</span>}
                  <ImageCanvasSurface
                    url={outputUrl}
                    title={active?.title ?? '生成结果'}
                    textLayers={visibleCanvasLayers}
                    selectedLayerId={selectedLayerId}
                    onSelectLayer={setSelectedLayerId}
                    zoom={compareMode ? Math.min(zoom, 1) : zoom}
                    showTextContent={previewingDraftText}
                    maskEditing={maskEditing}
                    maskBrushSize={maskBrushSize}
                    maskDataUrl={maskDataUrl}
                    onMaskChange={setMaskDataUrl}
                  />
                </div>
              </>
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
          </div>

          {outputUrls.length > 0 && (
            <div className="flex h-[76px] shrink-0 items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-app-main)] px-3">
              <span className="mr-1 text-[11px] text-[var(--color-text-tertiary)]">候选 / 版本</span>
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto py-2">
                {outputUrls.map((url, index) => (
                  <button
                    key={versions[index]?.id ?? `${active?.id ?? 'output'}-${index}`}
                    type="button"
                    onClick={() => { setSelectedOutput(index); setSelectedLayerId(null) }}
                    className="relative h-14 w-14 shrink-0 overflow-hidden border-2 bg-[var(--color-app-main)]"
                    style={{ borderColor: index === selectedOutput ? 'var(--color-brand)' : 'var(--color-border)' }}
                    aria-label={`查看版本 ${index + 1}`}
                  >
                    <img src={url} alt="" className="h-full w-full object-cover" />
                    {versions[index]?.id === active?.current_version_id && (
                      <span className="absolute bottom-0 left-0 right-0 bg-black/65 py-0.5 text-[8px] text-white">当前</span>
                    )}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void chooseVersion()}
                disabled={!selectedVersion || active?.current_version_id === selectedVersion.id || loading}
                aria-label={active?.current_version_id === selectedVersion?.id ? '当前版本' : '切换到此版本'}
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] disabled:opacity-45"
              ><Undo2 size={14} />{active?.current_version_id === selectedVersion?.id ? '当前版本' : '设为当前'}</button>
              <button
                type="button"
                onClick={() => void downloadOutput()}
                aria-label="导出当前预览"
                className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)]"
              ><Download size={14} />导出</button>
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
                  onChange={event => {
                    draftOwnerIdRef.current = active?.id ?? null
                    draftDirtyRef.current = true
                    promptRef.current = event.target.value
                    setPrompt(event.target.value)
                  }}
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
                    onChange={event => {
                      draftOwnerIdRef.current = active?.id ?? null
                      draftDirtyRef.current = true
                      const nextSize = event.target.value as typeof size
                      sizeRef.current = nextSize
                      setSize(nextSize)
                    }}
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
                {selectedVersion && (
                  <div className="mb-4 border-b border-[var(--color-border)] pb-4">
                    <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-text-primary)]">
                      <Layers3 size={14} aria-hidden="true" />图层与质检
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedLayerId(null)}
                      className="flex h-8 w-full items-center justify-between rounded-[5px] px-2 text-left text-[11px] hover:bg-[var(--color-surface-hover)]"
                      style={{ color: selectedLayerId === null ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}
                    >
                      <span>基础图像</span><span>{selectedVersion.width ?? '—'} × {selectedVersion.height ?? '—'}</span>
                    </button>
                    {visibleCanvasLayers.map(layer => (
                      <button
                        key={layer.id}
                        type="button"
                        onClick={() => setSelectedLayerId(layer.id)}
                        className="flex h-8 w-full items-center justify-between rounded-[5px] px-2 text-left text-[11px] hover:bg-[var(--color-surface-hover)]"
                        style={{ color: selectedLayerId === layer.id ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}
                      >
                        <span className="truncate">文字 · {layer.text}</span><span>{layer.font_size}px</span>
                      </button>
                    ))}
                    {selectedVersion.quality_assessment ? (
                      <div className="mt-2 rounded-[6px] bg-[var(--color-surface-container)] p-2 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                        <div className="mb-1 font-medium text-[var(--color-text-primary)]">视觉质检 {selectedVersion.quality_assessment.score}/100</div>
                        <p>{selectedVersion.quality_assessment.summary}</p>
                        {selectedVersion.quality_assessment.issues.length > 0 && <p className="mt-1 text-[var(--color-warning)]">问题：{selectedVersion.quality_assessment.issues.join('；')}</p>}
                        {selectedVersion.quality_assessment.suggestions.length > 0 && <p className="mt-1">建议：{selectedVersion.quality_assessment.suggestions.join('；')}</p>}
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">此版本没有可用的视觉质检结果。</p>
                    )}
                  </div>
                )}
                {['draft', 'failed'].includes(active.state) ? (
                  <>
                    <label className="mb-1 block text-[12px] text-[var(--color-text-secondary)]" htmlFor="active-image-prompt">画面需求</label>
                    <textarea
                      id="active-image-prompt"
                      value={prompt}
                      onChange={event => {
                        draftOwnerIdRef.current = active.id
                        draftDirtyRef.current = true
                        promptRef.current = event.target.value
                        setPrompt(event.target.value)
                      }}
                      rows={8}
                      className="w-full resize-none rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2.5 py-2 text-[13px] leading-5 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
                    />
                    <div className="mt-3 grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2 text-[12px]">
                      <label htmlFor="active-image-size" className="text-[var(--color-text-tertiary)]">画布</label>
                      <select
                        id="active-image-size"
                        value={size}
                        onChange={event => {
                          draftOwnerIdRef.current = active.id
                          draftDirtyRef.current = true
                          const nextSize = event.target.value as typeof size
                          sizeRef.current = nextSize
                          setSize(nextSize)
                        }}
                        className="h-8 rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 text-[12px] text-[var(--color-text-primary)] outline-none"
                      >
                        {IMAGE_SIZE_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <span className="text-[var(--color-text-tertiary)]">候选</span>
                      <span className="text-[var(--color-text-secondary)]">固定生成 3 张</span>
                    </div>
                    <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                      <div className="mb-1 text-[12px] font-medium text-[var(--color-text-primary)]">可编辑 Brief</div>
                      <p className="mb-3 text-[10px] leading-4 text-[var(--color-text-tertiary)]">每项一行。你明确填写的内容会持久保存，后续图片理解只能补充其他字段，不能覆盖这些约束。</p>
                      <div className="space-y-3">
                        {EDITABLE_BRIEF_FIELDS.map(({ field, label, help }) => (
                          <label key={field} className="block">
                            <span className="mb-1 block text-[11px] text-[var(--color-text-secondary)]">{label}</span>
                            <textarea
                              aria-label={`Brief ${label}`}
                              value={(briefOverrides[field] ?? active.brief?.[field] ?? []).join('\n')}
                              onChange={event => setBriefOverrides(current => ({
                                ...current,
                                [field]: lines(event.target.value),
                              }))}
                              rows={3}
                              className="w-full resize-y rounded-[6px] border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 py-1.5 text-[11px] leading-4 text-[var(--color-text-primary)]"
                            />
                            <span className="mt-1 block text-[10px] leading-4 text-[var(--color-text-tertiary)]">{help}</span>
                          </label>
                        ))}
                      </div>
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
                {(referenceDraft.length > 0 || pendingReferences.length > 0 || ['draft', 'failed'].includes(active.state)) && (
                  <div className="mb-5 border-t border-[var(--color-border)] pt-4">
                    <div className="mb-2 text-[12px] font-medium text-[var(--color-text-primary)]">参考素材</div>
                    {['draft', 'failed'].includes(active.state) && (
                      <label className="mb-3 block">
                        <span className="sr-only">添加参考图片</span>
                        <input
                          aria-label="添加参考图片"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          multiple
                          disabled={referenceDraft.length + pendingReferences.length >= 8}
                          onChange={event => {
                            void addPendingReferences(event.target.files)
                            event.currentTarget.value = ''
                          }}
                          className="block w-full text-[10px] text-[var(--color-text-secondary)] disabled:opacity-40"
                        />
                      </label>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {referenceDraft.map(reference => (
                        <figure key={reference.asset_id} className="overflow-hidden rounded-[5px] border border-[var(--color-border)] bg-[var(--color-surface-container)]">
                          <img
                            src={mediaApi.assetUrl(reference.image_path)}
                            alt={reference.label ?? `${REFERENCE_ROLE_LABELS[reference.role]}参考图`}
                            className="aspect-square w-full object-cover"
                          />
                          {['draft', 'failed'].includes(active.state) ? (
                            <div className="flex items-center border-t border-[var(--color-border)]">
                              <select
                                aria-label={`${reference.label ?? reference.asset_id} 的参考作用`}
                                value={reference.role}
                                onChange={event => setReferenceDraft(current => current.map(item => item.asset_id === reference.asset_id
                                  ? { ...item, role: event.target.value as ImageReferenceRole }
                                  : item))}
                                className="h-7 min-w-0 flex-1 bg-[var(--color-input-bg)] px-1 text-[10px]"
                              >
                                {REFERENCE_ROLE_OPTIONS.filter(option => option.value !== 'unclassified').map(option => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => setReferenceDraft(current => current.filter(item => item.asset_id !== reference.asset_id))}
                                className="flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-error)]"
                                aria-label={`移除参考素材 ${reference.label ?? REFERENCE_ROLE_LABELS[reference.role]}`}
                              ><X size={12} /></button>
                            </div>
                          ) : (
                            <figcaption className="truncate px-1.5 py-1 text-[10px] text-[var(--color-text-secondary)]">
                              {reference.label ?? REFERENCE_ROLE_LABELS[reference.role]}
                            </figcaption>
                          )}
                        </figure>
                      ))}
                      {pendingReferences.map((reference, index) => (
                        <figure key={`${reference.name}-${index}`} className="overflow-hidden rounded-[5px] border border-dashed border-[var(--color-brand)] bg-[var(--color-surface-container)]">
                          <img src={reference.dataUrl} alt={reference.name} className="aspect-square w-full object-cover" />
                          <div className="flex items-center border-t border-[var(--color-border)]">
                            <select
                              aria-label={`${reference.name} 的新增参考作用`}
                              value={reference.role}
                              onChange={event => setPendingReferences(current => current.map((item, itemIndex) => itemIndex === index
                                ? { ...item, role: event.target.value as ImageReferenceRole }
                                : item))}
                              className="h-7 min-w-0 flex-1 bg-[var(--color-input-bg)] px-1 text-[10px]"
                            >
                              {REFERENCE_ROLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                            <button
                              type="button"
                              onClick={() => setPendingReferences(current => current.filter((_, itemIndex) => itemIndex !== index))}
                              className="flex h-7 w-7 items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-error)]"
                              aria-label={`取消新增 ${reference.name}`}
                            ><X size={12} /></button>
                          </div>
                        </figure>
                      ))}
                    </div>
                  </div>
                )}
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
                      <div className="mt-2 rounded-[6px] bg-[var(--color-surface-container)] p-2 text-[11px] text-[var(--color-text-secondary)]">
                        <div className="flex items-center gap-1.5 font-medium text-[var(--color-text-primary)]">
                          <Paintbrush size={13} aria-hidden="true" />在画布涂抹要重绘的区域
                        </div>
                        <label className="mt-2 grid grid-cols-[52px_1fr_36px] items-center gap-2">
                          <span>笔刷</span>
                          <input
                            aria-label="蒙版笔刷大小"
                            type="range"
                            min={16}
                            max={512}
                            step={8}
                            value={maskBrushSize}
                            onChange={event => setMaskBrushSize(Number(event.target.value))}
                          />
                          <span className="text-right">{maskBrushSize}</span>
                        </label>
                        <div className="mt-2 flex items-center gap-2">
                          <label className="min-w-0 flex-1">
                            <span className="sr-only">上传透明 PNG 蒙版</span>
                            <input
                              aria-label="上传透明 PNG 蒙版"
                              type="file"
                              accept="image/png"
                              onChange={event => {
                                const file = event.target.files?.[0]
                                if (file) void readImage(file).then(setMaskDataUrl)
                                event.currentTarget.value = ''
                              }}
                              className="block w-full text-[10px]"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => setMaskDataUrl(null)}
                            className="inline-flex h-7 items-center gap-1 rounded border border-[var(--color-border)] px-2"
                          ><Trash2 size={12} />清空</button>
                        </div>
                        <p className="mt-1.5 text-[10px] text-[var(--color-text-tertiary)]">红色区域会生成透明蒙版并交给图片编辑能力；未涂抹区域保持不变。</p>
                      </div>
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
                    {draftTextLayers.length > 0 && selectedVersion.kind !== 'text_layout' && (
                      <div className="mt-2 space-y-2 rounded-[6px] bg-[var(--color-surface-container)] p-2">
                        {draftTextLayers.map((layer, index) => {
                          const setting = textLayoutSettings[index] ?? {
                            x: 50,
                            y: Math.min(90, 12 + index * 10),
                            fontSize: layer.font_size,
                            fill: layer.fill,
                          }
                          return (
                            <div key={layer.id} className="grid grid-cols-[1fr_48px_48px_52px_28px] items-center gap-1 text-[10px]">
                              <span className="truncate text-[var(--color-text-secondary)]" title={layer.text}>{layer.text}</span>
                              <input aria-label={`${layer.text} 横向位置`} type="number" min={0} max={100} value={setting.x} onChange={event => updateTextLayoutSetting(index, { x: Math.max(0, Math.min(100, Number(event.target.value))) })} className="h-7 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1" />
                              <input aria-label={`${layer.text} 纵向位置`} type="number" min={0} max={100} value={setting.y} onChange={event => updateTextLayoutSetting(index, { y: Math.max(0, Math.min(100, Number(event.target.value))) })} className="h-7 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1" />
                              <input aria-label={`${layer.text} 字号`} type="number" min={12} max={512} value={setting.fontSize} onChange={event => updateTextLayoutSetting(index, { fontSize: Math.max(12, Math.min(512, Number(event.target.value))) })} className="h-7 rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-1" />
                              <input aria-label={`${layer.text} 颜色`} type="color" value={setting.fill} onChange={event => updateTextLayoutSetting(index, { fill: event.target.value })} className="h-7 w-7" />
                            </div>
                          )
                        })}
                        <p className="text-[10px] text-[var(--color-text-tertiary)]">横向/纵向位置使用画布百分比；调整会立即投影到画布，提交后形成不可变版本。</p>
                      </div>
                    )}
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
