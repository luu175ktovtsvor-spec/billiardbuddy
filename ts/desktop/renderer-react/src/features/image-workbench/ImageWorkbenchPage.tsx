// 生图页组件：状态接线与布局。纯业务规则在 imageWorkbenchModel，
// 画布操作在 imageWorkbenchCanvas，上传/版本落库在 imageWorkbenchAssets。
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Canvas, Path, Rect, Textbox } from 'fabric'
import { Tooltip } from '../../components/shared/Tooltip'
import { IconAlertCircle, IconCheckCircle, IconChevronRight, IconEdit, IconPlus, IconRefresh, IconShareUp, IconSparkles, IconTarget, IconTrash, IconZap } from '../../components/shared/icons'
import { toast } from '../../stores/toastStore'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  assetUrl,
  brandPackApi,
  pollJob,
  studioApi,
  workbenchApi,
  type ImageAssetReference,
  type ImageBrandPack,
  type ImageIntent,
  type ImageQuality,
  type ImageReferenceRole,
  type ImageWorkbenchAsset,
  type ImageWorkbenchProject,
  type ImageWorkbenchTextLayer,
  type StudioImage,
  type ImageCreativeBrief,
  downloadAsset,
  fetchAssetFile,
} from '../../api/studio'
import {
  COUNTS,
  POSTER_TYPES,
  RATIOS,
  type DrawingState,
  type MaskItem,
  type MaskMode,
  type WorkbenchObject,
} from './imageWorkbenchTypes'
import { buttonPrimaryStyle, buttonSubtleStyle, inputStyle, panelStyle, segStyle } from './imageWorkbenchStyles'
import {
  defaultReferenceRole,
  dimensionFromRatio,
  friendlyImageError,
  friendlyImageStage,
  imagePassesCandidateGate,
  imageReviewLines,
  normalizeColorInput,
  posterBrandImageLayers,
  posterTextLayers,
  referenceRoleOptions,
  reviewFromRecord,
  sourceForEdit,
  sourceForUpscale,
  textAlignFrom,
  versionKindLabel,
} from './imageWorkbenchModel'
import {
  exportCanvasPng,
  extractImageLayers,
  extractTextLayers,
  fitCanvasPreview,
  hydrateCanvas,
  maskDataUrl,
  maskObjectOptions,
  parseTextLayerSnapshot,
  pathFromPoints,
  textLayerSnapshot,
  textLayerToFabric,
  themedColor,
  waitForFonts,
  withAlpha,
} from './imageWorkbenchCanvas'
import { addImageVersionFromJob, brandAssetFromPack, uploadWorkbenchImage } from './imageWorkbenchAssets'
import { CandidatePreview } from './CandidatePreview'
import { executeImageGeneration, type PosterFields } from './imageWorkbenchGeneration'
import { imageWorkbenchTaskReducer, initialImageWorkbenchTaskState } from './imageWorkbenchTaskState'
export function CreationPage() {
  const workspaceRoot = useSettingsStore(state => state.workspaceRoot)
  const [prompt, setPrompt] = useState('')
  const [sceneId, setSceneId] = useState(POSTER_TYPES[0]?.id ?? 'custom_poster')
  const [intent, setIntent] = useState<ImageIntent>('poster_text')
  const [quality, setQuality] = useState<ImageQuality>('standard')
  const [ratio, setRatio] = useState('3:4')
  const [count, setCount] = useState(3)
  const [quickForm, setQuickForm] = useState(false)
  const [posterTitle, setPosterTitle] = useState('')
  const [posterOffer, setPosterOffer] = useState('')
  const [posterPrice, setPosterPrice] = useState('')
  const [posterDate, setPosterDate] = useState('')
  const [posterAddress, setPosterAddress] = useState('')
  const [posterPhone, setPosterPhone] = useState('')
  const [posterCta, setPosterCta] = useState('')
  const [portraitAuthorized, setPortraitAuthorized] = useState(false)
  const [brandPack, setBrandPack] = useState<ImageBrandPack | null>(null)
  const [logoAsset, setLogoAsset] = useState<ImageWorkbenchAsset | null>(null)
  const [qrAsset, setQrAsset] = useState<ImageWorkbenchAsset | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved')
  const [referenceAssets, setReferenceAssets] = useState<ImageWorkbenchAsset[]>([])
  const [referenceRoles, setReferenceRoles] = useState<Record<string, ImageReferenceRole>>({})
  const [taskState, dispatchTask] = useReducer(imageWorkbenchTaskReducer, initialImageWorkbenchTaskState)
  const { busy, progress, stage, activeJobId, lastError, lastFailedAction, pane: compactPane } = taskState
  const [images, setImages] = useState<StudioImage[]>([])
  const [creativeBrief, setCreativeBrief] = useState<ImageCreativeBrief | null>(null)
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [project, setProject] = useState<ImageWorkbenchProject | null>(null)
  const [projects, setProjects] = useState<ImageWorkbenchProject[]>([])
  const [editText, setEditText] = useState('')
  const [maskText, setMaskText] = useState('')
  const [maskMode, setMaskMode] = useState<MaskMode>('select')
  const [brushSize, setBrushSize] = useState(72)
  const [maskItems, setMaskItems] = useState<MaskItem[]>([])
  const [textValue, setTextValue] = useState('')
  const [textColor, setTextColor] = useState('#ffffff')
  const [textSize, setTextSize] = useState(72)
  const [textAlign, setTextAlign] = useState<ImageWorkbenchTextLayer['text_align']>('center')
  const [strokeColor, setStrokeColor] = useState('#111111')
  const [strokeWidth, setStrokeWidth] = useState(1)
  const [activeTextId, setActiveTextId] = useState<string | null>(null)
  const [historyTick, setHistoryTick] = useState(0)
  const [lastExport, setLastExport] = useState<ImageWorkbenchAsset | null>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null)
  const fabricRef = useRef<Canvas | null>(null)
  const projectRef = useRef<ImageWorkbenchProject | null>(null)
  const maskModeRef = useRef(maskMode)
  const brushSizeRef = useRef(brushSize)
  const maskItemsRef = useRef<MaskItem[]>([])
  const drawingRef = useRef<DrawingState | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const textUndoRef = useRef<string[]>([])
  const textRedoRef = useRef<string[]>([])
  const historyLockRef = useRef(false)
  const autosaveSnapshotRef = useRef('')
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const briefHydratingRef = useRef(false)
  const canvasViewportRef = useRef<HTMLDivElement | null>(null)

  const currentVersion = useMemo(() => {
    if (!project) return null
    return project.versions.find((version) => version.id === project.current_version_id) ?? project.versions[project.versions.length - 1] ?? null
  }, [project])

  const compareImages = useMemo(() => {
    const byId = new Map(images.map((img) => [img.generation_id, img]))
    return compareIds.map((id) => byId.get(id)).filter((img): img is StudioImage => Boolean(img))
  }, [compareIds, images])
  const selectedImage = useMemo(
    () => images.find((img) => img.generation_id === selectedImageId) ?? images[0] ?? null,
    [images, selectedImageId],
  )
  const review = currentVersion?.review
  const reviewLines = useMemo(() => imageReviewLines(review), [review])
  const referenceUrls = useMemo(() => referenceAssets.map(asset => asset.url), [referenceAssets])
  const referenceDescriptors = useMemo<ImageAssetReference[]>(() => referenceAssets.map((asset, index) => ({
    asset_id: asset.asset_id,
    role: referenceRoles[asset.asset_id] ?? defaultReferenceRole(intent, index),
    url: asset.url,
    label: intent === 'portrait' ? (index === 0 ? '主照片' : '补充角度') : '参考素材',
  })), [intent, referenceAssets, referenceRoles])
  const projectReferenceDescriptors = useMemo<ImageAssetReference[]>(() => {
    if (referenceDescriptors.length) return referenceDescriptors
    return (project?.reference_assets ?? []).filter((asset): asset is ImageAssetReference => Boolean(asset.url))
  }, [project?.reference_assets, referenceDescriptors])

  function resetTextHistory(canvas: Canvas) {
    textUndoRef.current = [textLayerSnapshot(canvas)]
    textRedoRef.current = []
    setHistoryTick((tick) => tick + 1)
  }

  function pushTextHistory(canvas: Canvas) {
    if (historyLockRef.current) return
    const snapshot = textLayerSnapshot(canvas)
    const undo = textUndoRef.current
    if (undo[undo.length - 1] === snapshot) return
    textUndoRef.current = [...undo, snapshot].slice(-60)
    textRedoRef.current = []
    setHistoryTick((tick) => tick + 1)
  }

  function restoreTextHistory(snapshot: string) {
    const canvas = fabricRef.current
    if (!canvas) return
    const layers = parseTextLayerSnapshot(snapshot)
    historyLockRef.current = true
    canvas.getObjects().forEach((obj) => {
      if (obj instanceof Textbox) canvas.remove(obj)
    })
    for (const layer of layers) canvas.add(textLayerToFabric(layer))
    canvas.discardActiveObject()
    canvas.requestRenderAll()
    setProject((prev) => prev ? { ...prev, canvas: { ...prev.canvas, text_layers: layers, updated_at: new Date().toISOString() } } : prev)
    setActiveTextId(null)
    historyLockRef.current = false
    setHistoryTick((tick) => tick + 1)
  }

  useEffect(() => { projectRef.current = project }, [project])
  useEffect(() => {
    if (project) setIntent(project.intent)
  }, [project?.project_id])
  useEffect(() => { maskModeRef.current = maskMode }, [maskMode])
  useEffect(() => { brushSizeRef.current = brushSize }, [brushSize])
  useEffect(() => { maskItemsRef.current = maskItems }, [maskItems])
  useEffect(() => {
    if (briefHydratingRef.current) {
      briefHydratingRef.current = false
      return
    }
    setCreativeBrief(null)
  }, [prompt, posterTitle, posterOffer, posterPrice, posterDate, posterAddress, posterPhone, posterCta, intent, ratio, quality, sceneId, referenceDescriptors.map(asset => `${asset.asset_id}:${asset.role}`).join('|'), portraitAuthorized])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setProject(null)
        const loaded = await workbenchApi.listProjects(workspaceRoot)
        if (cancelled) return
        setProjects(loaded)
      } catch {
        if (!cancelled) setProjects([])
      }
    })()
    return () => { cancelled = true; abortRef.current?.abort() }
  }, [workspaceRoot])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const loaded = await brandPackApi.get()
      const [logo, qrcode] = await Promise.all([
        brandAssetFromPack(loaded, 'logo'),
        brandAssetFromPack(loaded, 'qrcode'),
      ])
      if (cancelled) return
      setBrandPack(loaded)
      setLogoAsset(logo)
      setQrAsset(qrcode)
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!canvasElement) return
    const canvas = new Canvas(canvasElement, {
      preserveObjectStacking: true,
      selection: true,
      backgroundColor: themedColor('--color-surface-container', '#f3f3f3'),
    })
    canvas.upperCanvasEl.draggable = false
    canvas.upperCanvasEl.addEventListener('dragstart', event => event.preventDefault())
    fabricRef.current = canvas
    const resizeObserver = new ResizeObserver(() => {
      const current = projectRef.current
      if (current) fitCanvasPreview(canvas, current, canvasViewportRef.current)
    })
    if (canvasViewportRef.current) resizeObserver.observe(canvasViewportRef.current)

    const updateActiveText = () => {
      const active = canvas.getActiveObject()
      if (active instanceof Textbox) {
        const obj = active as Textbox & { workbenchLayerId?: string }
        setActiveTextId(obj.workbenchLayerId ?? null)
        setTextValue(obj.text ?? '')
        setTextColor(String(obj.fill ?? '#ffffff'))
        setTextSize(Number(obj.fontSize ?? 72))
        setTextAlign(textAlignFrom(obj.textAlign))
        setStrokeColor(typeof obj.stroke === 'string' ? obj.stroke : '#111111')
        setStrokeWidth(Number(obj.strokeWidth ?? 0))
      } else {
        setActiveTextId(null)
      }
    }

    const sync = () => {
      const layers = extractTextLayers(canvas)
      const imageLayers = extractImageLayers(canvas)
      setProject((prev) => prev ? { ...prev, canvas: { ...prev.canvas, text_layers: layers, image_layers: imageLayers, updated_at: new Date().toISOString() } } : prev)
      pushTextHistory(canvas)
      updateActiveText()
    }

    const onDown = (opt: { e: Event }) => {
      const mode = maskModeRef.current
      if (mode !== 'rect' && mode !== 'brush') return
      const pointer = canvas.getScenePoint(opt.e as never)
      canvas.selection = false
      if (mode === 'rect') {
        const brand = themedColor('--color-brand', '#0a84ff')
        const rect = new Rect(maskObjectOptions({
          left: pointer.x,
          top: pointer.y,
          width: 1,
          height: 1,
          fill: withAlpha(brand, 0.16),
          stroke: withAlpha(brand, 0.88),
          strokeWidth: 3,
        }))
        canvas.add(rect)
        drawingRef.current = { mode, start: pointer, points: [pointer], object: rect as WorkbenchObject }
      } else {
        const brand = themedColor('--color-brand', '#0a84ff')
        const path = new Path(pathFromPoints([pointer]), maskObjectOptions({
          fill: '',
          stroke: withAlpha(brand, 0.72),
          strokeWidth: brushSizeRef.current,
          strokeLineCap: 'round' as CanvasLineCap,
          strokeLineJoin: 'round' as CanvasLineJoin,
        }) as never)
        canvas.add(path)
        drawingRef.current = { mode, start: pointer, points: [pointer], object: path as WorkbenchObject }
      }
    }

    const onMove = (opt: { e: Event }) => {
      const drawing = drawingRef.current
      if (!drawing) return
      const pointer = canvas.getScenePoint(opt.e as never)
      if (drawing.mode === 'rect') {
        const left = Math.min(drawing.start.x, pointer.x)
        const top = Math.min(drawing.start.y, pointer.y)
        drawing.object.set({
          left,
          top,
          width: Math.abs(pointer.x - drawing.start.x),
          height: Math.abs(pointer.y - drawing.start.y),
        })
      } else {
        drawing.points.push(pointer)
        canvas.remove(drawing.object)
        const stroke = typeof drawing.object.stroke === 'string'
          ? drawing.object.stroke
          : withAlpha(themedColor('--color-brand', '#0a84ff'), 0.72)
        const path = new Path(pathFromPoints(drawing.points), maskObjectOptions({
          fill: '',
          stroke,
          strokeWidth: brushSizeRef.current,
          strokeLineCap: 'round' as CanvasLineCap,
          strokeLineJoin: 'round' as CanvasLineJoin,
        }) as never)
        canvas.add(path)
        drawing.object = path as WorkbenchObject
      }
      canvas.requestRenderAll()
    }

    const onUp = () => {
      const drawing = drawingRef.current
      if (!drawing) return
      drawingRef.current = null
      const next = [...maskItemsRef.current]
      if (drawing.mode === 'rect') {
        const rect = drawing.object
        const width = Math.max(0, Number(rect.width ?? 0))
        const height = Math.max(0, Number(rect.height ?? 0))
        if (width > 2 && height > 2) next.push({ type: 'rect', x: Number(rect.left ?? 0), y: Number(rect.top ?? 0), width, height })
        else canvas.remove(rect)
      } else if (drawing.points.length > 1) {
        next.push({ type: 'brush', points: drawing.points, size: brushSizeRef.current })
      } else {
        canvas.remove(drawing.object)
      }
      setMaskItems(next)
      canvas.selection = maskModeRef.current === 'select'
      canvas.requestRenderAll()
    }

    const upperCanvas = canvas.upperCanvasEl
    const onPointerDown = (event: PointerEvent) => {
      const mode = maskModeRef.current
      if (mode !== 'rect' && mode !== 'brush') return
      event.preventDefault()
      upperCanvas.setPointerCapture(event.pointerId)
      onDown({ e: event })
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!drawingRef.current) return
      event.preventDefault()
      onMove({ e: event })
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!drawingRef.current) return
      event.preventDefault()
      onUp()
      if (upperCanvas.hasPointerCapture(event.pointerId)) upperCanvas.releasePointerCapture(event.pointerId)
    }

    canvas.on('selection:created', updateActiveText)
    canvas.on('selection:updated', updateActiveText)
    canvas.on('selection:cleared', updateActiveText)
    canvas.on('object:modified', sync)
    canvas.on('text:changed', sync)
    upperCanvas.addEventListener('pointerdown', onPointerDown)
    upperCanvas.addEventListener('pointermove', onPointerMove)
    upperCanvas.addEventListener('pointerup', onPointerUp)
    upperCanvas.addEventListener('pointercancel', onPointerUp)

    return () => {
      void persistCurrentCanvas().catch(() => undefined)
      upperCanvas.removeEventListener('pointerdown', onPointerDown)
      upperCanvas.removeEventListener('pointermove', onPointerMove)
      upperCanvas.removeEventListener('pointerup', onPointerUp)
      upperCanvas.removeEventListener('pointercancel', onPointerUp)
      resizeObserver.disconnect()
      void canvas.dispose()
      fabricRef.current = null
    }
  }, [canvasElement])

  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas || !project || !currentVersion) return
    let cancelled = false
    void (async () => {
      await hydrateCanvas(canvas, project, currentVersion)
      if (cancelled) return
      fitCanvasPreview(canvas, project, canvasViewportRef.current)
      resetTextHistory(canvas)
      setTextValue('')
      setActiveTextId(null)
      setMaskItems([])
      setLastExport(null)
    })().catch((err) => toast(friendlyImageError(err, '图片加载失败')))
    return () => { cancelled = true }
  }, [canvasElement, currentVersion?.id, project?.project_id])

  useEffect(() => {
    const canvas = fabricRef.current
    if (!canvas) return
    canvas.selection = maskMode === 'select'
    canvas.defaultCursor = maskMode === 'select' ? 'default' : 'crosshair'
    canvas.getObjects().forEach((obj) => {
      const custom = obj as WorkbenchObject
      if (custom.backgroundRole) {
        obj.selectable = false
        obj.evented = false
        return
      }
      if (!custom.maskRole) obj.selectable = maskMode === 'select'
    })
  }, [maskMode])

  const hasCreationGoal = prompt.trim().length > 0 || posterTitle.trim().length > 0 || (intent === 'portrait' && referenceAssets.length > 0)
  const canRun = hasCreationGoal && !busy && (intent !== 'portrait' || (referenceAssets.length > 0 && portraitAuthorized))

  const beginAction = (stageText: string) => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    dispatchTask({ type: 'begin', stage: stageText })
    return ctrl
  }

  const finishAction = (ctrl: AbortController) => {
    if (abortRef.current === ctrl) abortRef.current = null
    dispatchTask({ type: 'finish' })
  }

  const cancelActiveJob = async () => {
    const jobId = activeJobId
    abortRef.current?.abort()
    dispatchTask({ type: 'cancel-requested' })
    if (jobId) {
      await studioApi.cancelJob(jobId).catch(() => undefined)
    }
  }

  const retryLast = () => {
    if (lastFailedAction === 'generate') void run()
    else if (lastFailedAction === 'edit') void wholeEdit()
    else if (lastFailedAction === 'inpaint') void inpaint()
    else if (lastFailedAction === 'upscale') void upscale()
  }

  const selectWorkflow = (next: 'poster' | 'photo_edit') => {
    if (next === 'photo_edit') {
      setIntent('portrait')
      setSceneId('photo_edit')
      setPrompt('')
      setReferenceRoles(Object.fromEntries(referenceAssets.map((asset, index) => [asset.asset_id, defaultReferenceRole('portrait', index)])))
      return
    }
    setIntent('poster_text')
    setSceneId('custom_poster')
    setPrompt('')
  }

  const selectPosterType = (id: string) => {
    const type = POSTER_TYPES.find((item) => item.id === id)
    if (!type) return
    setSceneId(type.id)
    setPrompt(type.prompt)
  }

  const requestText = () => {
    const fields = [
      posterTitle && `标题：${posterTitle}`,
      posterOffer && `优惠：${posterOffer}`,
      posterPrice && `价格：${posterPrice}`,
      posterDate && `日期：${posterDate}`,
      posterAddress && `地址：${posterAddress}`,
      posterPhone && `电话：${posterPhone}`,
      posterCta && `行动提示：${posterCta}`,
    ].filter(Boolean)
    const explicit = [prompt.trim(), ...fields].filter(Boolean).join('，')
    if (explicit) return explicit
    if (intent === 'portrait' && referenceAssets.length > 0) {
      return '把上传的随手拍优化得自然好看，保持正常拍摄的感觉，同时保留本人可辨识特征和自然比例。'
    }
    return ''
  }

  const uploadBrandAsset = async (file: File | undefined, kind: 'logo' | 'qrcode') => {
    if (!file) return
    try {
      const asset = await uploadWorkbenchImage(file)
      if (kind === 'qrcode' && Math.abs(asset.width - asset.height) > 4) {
        throw new Error('二维码请上传清晰的正方形原图')
      }
      const updated = await brandPackApi.update(kind === 'logo'
        ? { logo_url: asset.url, logo_asset_id: asset.asset_id, logo_width: asset.width, logo_height: asset.height }
        : { qrcode_url: asset.url, qrcode_asset_id: asset.asset_id, qrcode_width: asset.width, qrcode_height: asset.height })
      setBrandPack(updated)
      if (kind === 'logo') setLogoAsset(asset)
      else setQrAsset(asset)
      toast(kind === 'logo' ? 'Logo 已添加' : '二维码已添加')
    } catch (err) {
      toast(friendlyImageError(err, `${kind === 'logo' ? 'Logo' : '二维码'}上传失败`))
    }
  }

  const uploadReferences = async (files: FileList | null) => {
    if (!files?.length) return
    const limit = intent === 'portrait' ? 3 : 8
    const available = Math.max(0, limit - referenceAssets.length)
    if (available === 0) {
      toast(intent === 'portrait' ? '真人照片最多使用 3 张' : '最多使用 8 张参考图')
      return
    }
    const next = await Promise.all(Array.from(files).slice(0, available).map(file => uploadWorkbenchImage(file)))
    setReferenceAssets(prev => [...prev, ...next])
    setReferenceRoles(prev => ({
      ...prev,
      ...Object.fromEntries(next.map((asset, index) => [asset.asset_id, defaultReferenceRole(intent, referenceAssets.length + index)])),
    }))
    toast(`已添加 ${next.length} 张参考图`)
  }

  const setReferenceRole = (assetId: string, role: ImageReferenceRole) => {
    setReferenceRoles(previous => {
      const next = { ...previous, [assetId]: role }
      if (role === 'identity_primary' && intent === 'portrait') {
        for (const asset of referenceAssets) {
          if (asset.asset_id !== assetId && next[asset.asset_id] === 'identity_primary') next[asset.asset_id] = 'identity_supporting'
        }
      }
      return next
    })
  }

  const removeReference = (assetId: string) => {
    const remaining = referenceAssets.filter(asset => asset.asset_id !== assetId)
    setReferenceAssets(remaining)
    setReferenceRoles(previous => {
      const next = { ...previous }
      delete next[assetId]
      if (intent === 'portrait' && remaining.length > 0 && !remaining.some(asset => next[asset.asset_id] === 'identity_primary')) {
        next[remaining[0]!.asset_id] = 'identity_primary'
      }
      return next
    })
  }

  const run = async () => {
    const request = requestText()
    if (!request || busy) return
    const ctrl = beginAction(creativeBrief ? '正在开始生成…' : '正在理解你的需求…')
    setImages([])
    try {
      const generated = await executeImageGeneration({
        request,
        sceneId,
        intent,
        quality,
        ratio,
        count,
        posterText: {
          title: posterTitle,
          offer: posterOffer,
          price: posterPrice,
          date: posterDate,
          address: posterAddress,
          phone: posterPhone,
          cta: posterCta,
        },
        referenceUrls,
        referenceAssets: referenceDescriptors,
        portraitAuthorized,
        creativeBrief, conversationId: useSettingsStore.getState().activeConvId ?? undefined, workspaceRoot: workspaceRoot ?? undefined,
      }, {
        signal: ctrl.signal,
        onJobStarted: jobId => dispatchTask({ type: 'job-started', jobId }),
        onProgress: (nextProgress, nextStage) => dispatchTask({ type: 'progress', progress: nextProgress, stage: nextStage }),
        onStage: nextStage => dispatchTask({ type: 'stage', stage: nextStage }),
      })
      const extracted: PosterFields | null = generated.compiledPoster
      const willHydrate = Boolean(extracted && (
        (!posterTitle && extracted.title) || (!posterOffer && extracted.offer) || (!posterPrice && extracted.price)
        || (!posterDate && extracted.date) || (!posterAddress && extracted.address) || (!posterPhone && extracted.phone) || (!posterCta && extracted.cta)
      ))
      if (willHydrate && extracted) {
        briefHydratingRef.current = true
        if (!posterTitle) setPosterTitle(extracted.title)
        if (!posterOffer) setPosterOffer(extracted.offer)
        if (!posterPrice) setPosterPrice(extracted.price)
        if (!posterDate) setPosterDate(extracted.date)
        if (!posterAddress) setPosterAddress(extracted.address)
        if (!posterPhone) setPosterPhone(extracted.phone)
        if (!posterCta) setPosterCta(extracted.cta)
        setQuickForm(true)
      }
      setImages(generated.images)
      setCreativeBrief(generated.creativeBrief)
      setSelectedImageId(generated.recommendedId)
      setCompareIds(generated.compareIds)
      dispatchTask({ type: 'select-pane', pane: 'canvas' })
    } catch (e) {
      if (!ctrl.signal.aborted) {
        const message = friendlyImageError(e, '生成失败')
        dispatchTask({ type: 'failed', message, action: 'generate' })
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }
  const createProjectFromImage = async (img: StudioImage): Promise<ImageWorkbenchProject> => {
    if (img.local_preview === true) {
      throw new Error('这张预览图片暂时无法编辑')
    }
    const width = img.width ?? dimensionFromRatio(img.ratio ?? ratio).width
    const height = img.height ?? dimensionFromRatio(img.ratio ?? ratio).height
    return await workbenchApi.createProject({
      title: creativeBrief?.poster?.title || prompt.trim().slice(0, 80) || '未命名图片',
      conversation_id: useSettingsStore.getState().activeConvId ?? undefined,
      working_dir: workspaceRoot ?? undefined,
      source_generation_id: img.generation_id,
      image_url: img.poster_url,
      width,
      height,
      ratio: img.ratio ?? ratio,
      prompt: creativeBrief?.user_request ?? prompt.trim(),
      user_request: creativeBrief?.user_request ?? prompt.trim(),
      creative_brief: creativeBrief ?? undefined,
      brief_understanding: creativeBrief?.understanding,
      compiler_version: creativeBrief?.compiler_version,
      intent,
      quality,
      quantity: count,
      reference_asset_ids: referenceDescriptors.map(asset => asset.asset_id),
      reference_assets: referenceDescriptors,
      text_layers: intent === 'poster_text' ? posterTextLayers(width, height, {
        title: creativeBrief?.poster?.title ?? posterTitle,
        offer: creativeBrief?.poster?.offer ?? posterOffer,
        price: creativeBrief?.poster?.price ?? posterPrice,
        date: [creativeBrief?.poster?.date, creativeBrief?.poster?.time].filter(Boolean).join(' '),
        phone: creativeBrief?.poster?.phone ?? posterPhone,
        address: creativeBrief?.poster?.address ?? posterAddress,
        cta: creativeBrief?.poster?.cta ?? posterCta,
      }) : [],
      image_layers: intent === 'poster_text' ? posterBrandImageLayers(width, height, logoAsset, qrAsset) : [],
      review: reviewFromRecord(img),
    })
  }

  const openProjectFromImage = async (img: StudioImage) => {
    try {
      if (project?.source_generation_id === img.generation_id) {
        await refreshProject(project)
        dispatchTask({ type: 'select-pane', pane: 'canvas' })
        return
      }
      const next = await createProjectFromImage(img)
      await refreshProject(next)
      dispatchTask({ type: 'select-pane', pane: 'canvas' })
      setProjects((items) => [next, ...items.filter((item) => item.project_id !== next.project_id)])
    } catch (err) {
      toast(friendlyImageError(err, '无法打开图片'))
    }
  }

  const quickDownloadCandidate = async (img: StudioImage) => {
    dispatchTask({ type: 'begin-local', stage: '正在添加固定文字并准备下载…' })
    try {
      await waitForFonts()
      const next = await createProjectFromImage(img)
      const version = next.versions.find(item => item.id === next.current_version_id)
      if (!version) throw new Error('这张图片暂时无法下载')

      // Use the mounted canvas, the same rendering surface used by normal export.
      // Fabric's detached-canvas image loading is not reliable in Electron.
      await refreshProject(next)
      const canvas = await waitForFabricCanvas()
      await hydrateCanvas(canvas, next, version)
      const result = await workbenchApi.exportPng(next.project_id, {
        version_id: version.id,
        data_url: exportCanvasPng(canvas),
        width: next.canvas.width,
        height: next.canvas.height,
        text_layers: extractTextLayers(canvas),
        image_layers: extractImageLayers(canvas),
      })
      setLastExport(result.asset)
      await refreshProject(result.project)
      dispatchTask({ type: 'select-pane', pane: 'canvas' })
      await downloadAsset(result.asset.url, `${next.title}-${new Date().toISOString().slice(0, 10)}`)
      toast('PNG 已下载')
    } catch (err) {
      const message = friendlyImageError(err, '下载失败')
      dispatchTask({ type: 'failed', message })
      toast(message)
    } finally {
      dispatchTask({ type: 'finish' })
    }
  }

  const refreshProject = async (next: ImageWorkbenchProject) => {
    projectRef.current = next
    setProject(next)
    setProjects((items) => [next, ...items.filter((item) => item.project_id !== next.project_id)])
    autosaveSnapshotRef.current = JSON.stringify({ revision: next.autosave_revision, canvas: next.canvas })
    setSaveState(next.save_status)
  }

  const queueCanvasSave = (
    base: ImageWorkbenchProject,
    canvas: Pick<ImageWorkbenchProject['canvas'], 'width' | 'height' | 'text_layers' | 'image_layers'>,
  ): Promise<ImageWorkbenchProject> => {
    setSaveState('saving')
    const run = saveQueueRef.current.then(async () => {
      const live = projectRef.current?.project_id === base.project_id ? projectRef.current : base
      const next = await workbenchApi.saveCanvas(base.project_id, {
        current_version_id: live.current_version_id,
        width: canvas.width,
        height: canvas.height,
        text_layers: canvas.text_layers,
        image_layers: canvas.image_layers,
        revision: live.autosave_revision,
      })
      if (projectRef.current?.project_id === next.project_id) await refreshProject(next)
      return next
    })
    saveQueueRef.current = run.then(() => undefined, () => undefined)
    void run.catch(() => setSaveState('failed'))
    return run
  }

  const persistCurrentCanvas = (): Promise<ImageWorkbenchProject | null> => {
    const base = projectRef.current
    const canvas = fabricRef.current
    if (!base || !canvas) return Promise.resolve(null)
    return queueCanvasSave(base, {
      width: base.canvas.width,
      height: base.canvas.height,
      text_layers: extractTextLayers(canvas),
      image_layers: extractImageLayers(canvas),
    })
  }

  const switchProject = async (next: ImageWorkbenchProject) => {
    if (projectRef.current?.project_id === next.project_id) return
    await persistCurrentCanvas().catch(() => undefined)
    await refreshProject(next)
    dispatchTask({ type: 'select-pane', pane: 'canvas' })
  }

  const waitForFabricCanvas = async (): Promise<Canvas> => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (fabricRef.current) return fabricRef.current
      await new Promise<void>(resolve => window.setTimeout(resolve, 16))
    }
    throw new Error('编辑区尚未准备好')
  }

  const reloadProjects = async () => {
    const loaded = await workbenchApi.listProjects(workspaceRoot)
    setProjects(loaded)
    setProject((prev) => prev ? (loaded.find((item) => item.project_id === prev.project_id) ?? null) : null)
  }

  useEffect(() => {
    if (!project) return
    const snapshot = JSON.stringify({ revision: project.autosave_revision, canvas: project.canvas })
    if (!autosaveSnapshotRef.current) {
      autosaveSnapshotRef.current = snapshot
      return
    }
    if (snapshot === autosaveSnapshotRef.current) return
    setSaveState('saving')
    const timer = window.setTimeout(() => {
      void queueCanvasSave(project, {
        width: project.canvas.width,
        height: project.canvas.height,
        text_layers: project.canvas.text_layers,
        image_layers: project.canvas.image_layers,
      })
    }, 800)
    return () => window.clearTimeout(timer)
  }, [project?.project_id, project?.canvas.updated_at])

  useEffect(() => {
    const flush = () => { void persistCurrentCanvas().catch(() => undefined) }
    const flushWhenHidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
      flush()
    }
  }, [])

  const saveCanvas = async () => {
    if (!projectRef.current || !fabricRef.current) return
    await persistCurrentCanvas()
    toast('项目已保存')
  }

  const addText = () => {
    const canvas = fabricRef.current
    const base = projectRef.current
    if (!canvas || !base) return
    const layerId = `text_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const box = new Textbox('双击编辑文字', {
      left: base.canvas.width * 0.14,
      top: base.canvas.height * 0.12,
      width: base.canvas.width * 0.72,
      fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
      fontSize: Math.max(32, Math.round(base.canvas.width / 15)),
      fill: '#ffffff',
      stroke: '#111111',
      strokeWidth: 1,
      textAlign: 'center',
      objectCaching: false,
    }) as Textbox & { workbenchLayerId?: string }
    box.workbenchLayerId = layerId
    canvas.add(box)
    canvas.setActiveObject(box)
    canvas.requestRenderAll()
    setActiveTextId(layerId)
    setTextValue(box.text ?? '')
    setTextColor('#ffffff')
    setTextSize(Number(box.fontSize ?? 72))
    setTextAlign('center')
    setStrokeColor('#111111')
    setStrokeWidth(1)
    pushTextHistory(canvas)
  }

  const applyTextPatch = (patch: Partial<{ text: string; fill: string; fontSize: number; textAlign: ImageWorkbenchTextLayer['text_align']; stroke: string; strokeWidth: number }>) => {
    const active = fabricRef.current?.getActiveObject()
    if (!(active instanceof Textbox)) return
    active.set(patch)
    active.setCoords()
    fabricRef.current?.requestRenderAll()
    const layers = extractTextLayers(fabricRef.current!)
    setProject((prev) => prev ? { ...prev, canvas: { ...prev.canvas, text_layers: layers, updated_at: new Date().toISOString() } } : prev)
    pushTextHistory(fabricRef.current!)
  }

  const deleteActiveText = () => {
    const canvas = fabricRef.current
    const active = canvas?.getActiveObject()
    if (!canvas || !(active instanceof Textbox)) return
    canvas.remove(active)
    canvas.discardActiveObject()
    canvas.requestRenderAll()
    setActiveTextId(null)
    setProject((prev) => prev ? { ...prev, canvas: { ...prev.canvas, text_layers: extractTextLayers(canvas), updated_at: new Date().toISOString() } } : prev)
    pushTextHistory(canvas)
  }

  const undoText = () => {
    if (textUndoRef.current.length <= 1) return
    const current = textUndoRef.current[textUndoRef.current.length - 1]
    textUndoRef.current = textUndoRef.current.slice(0, -1)
    textRedoRef.current = [...textRedoRef.current, current!].slice(-60)
    restoreTextHistory(textUndoRef.current[textUndoRef.current.length - 1]!)
  }

  const redoText = () => {
    const next = textRedoRef.current[textRedoRef.current.length - 1]
    if (!next) return
    textRedoRef.current = textRedoRef.current.slice(0, -1)
    textUndoRef.current = [...textUndoRef.current, next].slice(-60)
    restoreTextHistory(next)
  }

  const wholeEdit = async () => {
    if (!project || !currentVersion || !editText.trim()) return
    const ctrl = beginAction('正在修改图片…')
    try {
      const { job_id } = await studioApi.edit({
        ...sourceForEdit(currentVersion, editText.trim(), 'edit_content', quality),
        user_request: editText.trim(),
        reference_image_paths: projectReferenceDescriptors.map(asset => asset.url).filter((url): url is string => Boolean(url)),
        reference_assets: projectReferenceDescriptors,
        portrait_consent: portraitAuthorized,
        portrait_authorization_confirmed: portraitAuthorized,
        input_fidelity: projectReferenceDescriptors.length > 0 ? 'high' : undefined, conversation_id: useSettingsStore.getState().activeConvId ?? undefined, working_dir: workspaceRoot ?? undefined,
      })
      dispatchTask({ type: 'job-started', jobId: job_id })
      const job = await pollJob(job_id, { signal: ctrl.signal, intervalMs: 600, onProgress: (p: number, s?: string) => dispatchTask({ type: 'progress', progress: p, stage: friendlyImageStage(s, '正在修改图片…') }) })
      const next = await addImageVersionFromJob(project, currentVersion, job, 'edit', editText.trim())
      await refreshProject(next)
      setEditText('')
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = friendlyImageError(err, '修改失败')
        dispatchTask({ type: 'failed', message, action: 'edit' })
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }

  const inpaint = async () => {
    if (!project || !currentVersion || !maskText.trim()) return
    if (maskItems.length === 0) { toast('先框选或涂抹要修改的区域'); return }
    const ctrl = beginAction('正在准备选中区域…')
    try {
      const dataUrl = maskDataUrl(project.canvas.width, project.canvas.height, maskItems)
      const asset = await workbenchApi.uploadAsset({ kind: 'mask', data_url: dataUrl, width: project.canvas.width, height: project.canvas.height })
      const { job_id } = await studioApi.edit({
        ...sourceForEdit(currentVersion, maskText.trim(), 'inpaint', quality),
        mask_path: asset.url,
        user_request: maskText.trim(),
        reference_image_paths: projectReferenceDescriptors.map(asset => asset.url).filter((url): url is string => Boolean(url)),
        reference_assets: projectReferenceDescriptors,
        portrait_consent: portraitAuthorized,
        portrait_authorization_confirmed: portraitAuthorized,
        input_fidelity: projectReferenceDescriptors.length > 0 ? 'high' : undefined, conversation_id: useSettingsStore.getState().activeConvId ?? undefined, working_dir: workspaceRoot ?? undefined,
      })
      dispatchTask({ type: 'job-started', jobId: job_id })
      const job = await pollJob(job_id, { signal: ctrl.signal, intervalMs: 600, onProgress: (p: number, s?: string) => dispatchTask({ type: 'progress', progress: p, stage: friendlyImageStage(s, '正在修改图片…') }) })
      const next = await addImageVersionFromJob(project, currentVersion, job, 'inpaint', maskText.trim(), asset)
      await refreshProject(next)
      clearMask()
      setMaskText('')
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = friendlyImageError(err, '修改失败')
        dispatchTask({ type: 'failed', message, action: 'inpaint' })
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }

  const upscale = async () => {
    if (!project || !currentVersion) return
    const ctrl = beginAction('正在生成高清图片…')
    try {
      const { job_id } = await studioApi.upscale({ ...sourceForUpscale(currentVersion), conversation_id: useSettingsStore.getState().activeConvId ?? undefined, working_dir: workspaceRoot ?? undefined })
      dispatchTask({ type: 'job-started', jobId: job_id })
      const job = await pollJob(job_id, { signal: ctrl.signal, intervalMs: 600, onProgress: (p: number, s?: string) => dispatchTask({ type: 'progress', progress: p, stage: friendlyImageStage(s, '正在生成高清图片…') }) })
      const next = await addImageVersionFromJob(project, currentVersion, job, 'upscale', '高清放大')
      await refreshProject(next)
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = friendlyImageError(err, '生成高清图片失败')
        dispatchTask({ type: 'failed', message, action: 'upscale' })
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }

  const exportPng = async () => {
    const canvas = fabricRef.current
    if (!project || !currentVersion || !canvas) return
    dispatchTask({ type: 'begin-local', stage: '正在准备 PNG…' })
    try {
      await waitForFonts()
      const layers = extractTextLayers(canvas)
      const imageLayers = extractImageLayers(canvas)
      const dataUrl = exportCanvasPng(canvas)
      const result = await workbenchApi.exportPng(project.project_id, {
        version_id: currentVersion.id,
        data_url: dataUrl,
        width: project.canvas.width,
        height: project.canvas.height,
        text_layers: layers,
        image_layers: imageLayers,
      })
      setLastExport(result.asset)
      await refreshProject(result.project)
      await downloadAsset(result.asset.url, `${project.title}-${new Date().toISOString().slice(0, 10)}`)
      toast(`PNG 已下载（${result.asset.width}x${result.asset.height}）`)
    } catch (err) {
      toast(friendlyImageError(err, '下载失败'))
    } finally {
      dispatchTask({ type: 'finish' })
    }
  }

  const saveToLibrary = async () => {
    if (!project) return
    try {
      const item = await workbenchApi.saveToLibrary(project.project_id, { export_asset_id: lastExport?.asset_id, title: project.title })
      toast(`已保存到图片库：${item.title}`)
    } catch (err) {
      toast(friendlyImageError(err, '保存到图片库失败'))
    }
  }

  const confirmPortrait = async () => {
    if (!project || intent !== 'portrait' || !currentVersion) return
    try {
      const next = await workbenchApi.confirmPortrait(project.project_id, currentVersion.id)
      await refreshProject(next)
      toast('已确认像本人。下载前仍需确认照片授权和用途。')
    } catch (err) {
      toast(friendlyImageError(err, '确认失败'))
    }
  }

  const usePortraitAsPoster = async () => {
    if (!project || project.intent !== 'portrait' || !currentVersion) return
    try {
      const file = await fetchAssetFile(currentVersion.image_url, 'portrait-reference.png')
      const asset = await uploadWorkbenchImage(file)
      setReferenceAssets([asset])
      setReferenceRoles({ [asset.asset_id]: 'identity_primary' })
      setIntent('poster_text')
      setSceneId('custom_poster')
      setPrompt('使用已确认的人物照片作为海报主视觉，具体主题、文字和用途按本次输入决定')
      setCreativeBrief(null)
      toast('已带入人物照片，继续填写你想做的图片')
    } catch (err) {
      toast(friendlyImageError(err, '带入人物照片失败'))
    }
  }

  const clearMask = () => {
    const canvas = fabricRef.current
    if (canvas) {
      canvas.getObjects().forEach((obj) => { if ((obj as WorkbenchObject).maskRole) canvas.remove(obj) })
      canvas.requestRenderAll()
    }
    setMaskItems([])
  }

  const selectMaskMode = (mode: MaskMode) => {
    maskModeRef.current = mode
    setMaskMode(mode)
  }

  const toggleCompare = (id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id)
      return [...prev, id].slice(-2)
    })
  }

  const canUndoText = historyTick >= 0 && textUndoRef.current.length > 1
  const canRedoText = historyTick >= 0 && textRedoRef.current.length > 0
  const hasCandidates = images.length > 0
  const hasProject = Boolean(project)
  const hasWorkbenchStage = hasCandidates || hasProject
  const hasTaskFeedback = busy || Boolean(lastError)
  const hasMainPanel = hasWorkbenchStage || hasTaskFeedback
  const workspaceLayoutClass = compactPane === 'adjust' && hasProject
    ? 'grid min-h-0 grid-cols-1 gap-x-7 gap-y-6 min-[1180px]:grid-cols-[minmax(0,1fr)_300px]'
    : compactPane === 'canvas'
      ? 'mx-auto max-w-[1100px]'
      : 'mx-auto max-w-[760px]'

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="creation-page">
      <div className="mx-auto min-h-full w-full max-w-[1560px] px-4 pb-7 pt-2 min-[840px]:px-6">
        <div className={`${hasMainPanel && compactPane !== 'create' ? 'hidden' : 'mb-4 flex'} items-center justify-between gap-3`}>
          <div className="inline-grid grid-cols-2 gap-1 rounded-lg p-1" style={{ background: 'var(--color-surface-container)' }} role="tablist" aria-label="图片类型">
            <button type="button" role="tab" aria-selected={intent === 'poster_text'} onClick={() => selectWorkflow('poster')}
              className="rounded-md px-3 py-1.5 text-[12px] font-medium" style={segStyle(intent === 'poster_text')} data-testid="image-workflow-poster">
              制作海报
            </button>
            <button type="button" role="tab" aria-selected={intent === 'portrait'} onClick={() => selectWorkflow('photo_edit')}
              className="rounded-md px-3 py-1.5 text-[12px] font-medium" style={segStyle(intent === 'portrait')} data-testid="image-workflow-photo">
              照片优化
            </button>
          </div>
          {saveState !== 'saved' && <span className="text-[11px]" style={{ color: saveState === 'failed' ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
            {saveState === 'saving' ? '正在保存' : '保存失败'}
          </span>}
        </div>

        {hasMainPanel && <div className="mx-auto mb-5 flex max-w-[420px] items-center justify-center border-b" style={{ borderColor: 'var(--color-border)' }} role="tablist" aria-label="图片编辑视图">
          {([
            ['create', '描述'],
            ['canvas', '结果'],
            ['adjust', '修改'],
          ] as const).map(([pane, label]) => (
            (() => {
              const available = pane === 'create' || (pane === 'canvas' ? hasMainPanel : hasProject)
              return (
            <button
              key={pane}
              type="button"
              role="tab"
              aria-selected={compactPane === pane}
              disabled={!available}
              onClick={() => dispatchTask({ type: 'select-pane', pane })}
              className="relative flex-1 px-3 py-2 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
              style={{ color: compactPane === pane && available ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}
            >
              {label}
              {compactPane === pane && available && <span className="absolute inset-x-3 bottom-[-1px] h-0.5 rounded-full" style={{ background: 'var(--color-brand)' }} />}
            </button>
              )
            })()
          ))}
        </div>}

        <div className={workspaceLayoutClass}>
        <aside className={`${compactPane === 'create' ? 'block' : 'hidden'} min-w-0 space-y-5`}>
          <section className="space-y-3">
            {intent === 'poster_text' && (
              <label className="block">
                <span className="mb-1 block text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>你想做什么</span>
                <select value={sceneId} onChange={event => selectPosterType(event.target.value)} className="w-full rounded-md px-2.5 py-2 text-[12px] outline-none" style={inputStyle} data-testid="poster-type-select">
                  {POSTER_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
                </select>
              </label>
            )}

            <div className="rounded-lg p-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-strong)', boxShadow: 'var(--shadow-input)' }}>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                className="w-full resize-none bg-transparent px-4 pt-3.5 text-[13px] leading-relaxed outline-none"
                placeholder={intent === 'portrait' ? '说说想让这张照片变成什么样；不写时只做自然优化' : '说说想做什么海报，需要哪些画面和文字'}
                style={{ color: 'var(--color-text-primary)' }}
                data-testid="image-prompt-input"
              />
              <div className="flex flex-wrap items-center gap-1 px-2.5 pb-2.5 pt-1.5">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }}>
                  <IconPlus size={14} /> {intent === 'portrait' ? '上传照片' : '添加参考图'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="sr-only" data-testid="image-reference-input" onChange={(e) => void uploadReferences(e.target.files).catch((err) => toast(friendlyImageError(err, '上传失败')))} />
                </label>
                {intent === 'poster_text' && <button type="button" onClick={() => setQuickForm(value => !value)} className="rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }} data-testid="toggle-quick-form">
                  {quickForm ? '收起固定文字' : '填写固定文字'}
                </button>}
                <span className="min-w-0 flex-1" />
                <button type="button" onClick={() => void run()} disabled={!canRun}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: 'var(--color-brand)', color: 'var(--color-on-primary)' }} data-testid="image-generate-button">
                  <IconSparkles size={14} /> {busy ? '正在处理' : images.length > 0 ? `再生成 ${count} 张` : `开始生成 ${count} 张`}
                </button>
              </div>
            </div>

            {intent === 'poster_text' && quickForm && (
              <div className="grid grid-cols-2 gap-2" data-testid="poster-quick-form">
                <input value={posterTitle} onChange={e => setPosterTitle(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="主标题" />
                <input value={posterOffer} onChange={e => setPosterOffer(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="优惠内容" />
                <input value={posterPrice} onChange={e => setPosterPrice(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="价格" />
                <input value={posterDate} onChange={e => setPosterDate(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="日期/时间" />
                <input value={posterAddress} onChange={e => setPosterAddress(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="地址" data-testid="poster-address-input" />
                <input value={posterPhone} onChange={e => setPosterPhone(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="预约电话" data-testid="poster-phone-input" />
                <input value={posterCta} onChange={e => setPosterCta(e.target.value)} className="col-span-2 rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="行动提示，例如扫码报名" data-testid="poster-cta-input" />
              </div>
            )}
            {referenceAssets.length > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="image-reference-list">
                {referenceAssets.map((asset, index) => (
                  <div key={asset.asset_id} className="w-[92px] min-w-0">
                    <div className="group relative overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }}>
                      <img src={assetUrl(asset.url)} alt={`参考图 ${index + 1}`} className="aspect-square w-full object-cover" />
                      <button type="button" onClick={() => removeReference(asset.asset_id)} aria-label={`移除参考图 ${index + 1}`} title="移除参考图"
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ background: 'color-mix(in srgb, var(--color-surface) 92%, transparent)', color: 'var(--color-text-secondary)' }}>
                        <IconTrash size={13} />
                      </button>
                    </div>
                    <select
                      aria-label={`参考图 ${index + 1} 用途`}
                      value={referenceRoles[asset.asset_id] ?? defaultReferenceRole(intent, index)}
                      onChange={event => setReferenceRole(asset.asset_id, event.target.value as ImageReferenceRole)}
                      className="mt-1 w-full rounded-md px-1 py-1 text-[12px] outline-none"
                      style={inputStyle}
                    >
                      {referenceRoleOptions(intent).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            )}
            {intent === 'portrait' && (
              <label className="flex items-start gap-2 text-[12px]" data-testid="portrait-authorization">
                <input type="checkbox" checked={portraitAuthorized} onChange={e => setPortraitAuthorized(e.target.checked)} className="mt-0.5" />
                <span style={{ color: 'var(--color-text-secondary)' }}>我拥有这些照片的使用授权，且被拍者同意用于本次生成</span>
              </label>
            )}
            {intent === 'poster_text' && (
              <details className="group border-t" style={{ borderColor: 'var(--color-border)' }}>
                <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-[12px] [&::-webkit-details-marker]:hidden" style={{ color: 'var(--color-text-secondary)' }}>
                  <IconChevronRight size={13} className="transition-transform group-open:rotate-90" />
                  <span>Logo 和二维码</span>
                  {(logoAsset || qrAsset) && <span className="ml-auto text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{[logoAsset && 'Logo', qrAsset && '二维码'].filter(Boolean).join(' · ')}</span>}
                </summary>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <label className="cursor-pointer rounded-md px-2 py-2 text-center text-[12px]" style={inputStyle}>
                    <span>{logoAsset ? '更换 Logo' : '添加 Logo'}</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="brand-logo-input" onChange={e => void uploadBrandAsset(e.target.files?.[0], 'logo')} />
                  </label>
                  <label className="cursor-pointer rounded-md px-2 py-2 text-center text-[12px]" style={inputStyle}>
                    <span>{qrAsset ? '更换二维码' : '添加二维码'}</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid="brand-qrcode-input" onChange={e => void uploadBrandAsset(e.target.files?.[0], 'qrcode')} />
                  </label>
                </div>
                {(brandPack || logoAsset || qrAsset) && (
                  <div className="mt-2 flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5" style={inputStyle} data-testid="brand-pack-preview">
                    {logoAsset && <img src={assetUrl(logoAsset.url)} alt="品牌 Logo" className="h-7 w-9 object-contain" data-testid="brand-logo-preview" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px]" style={{ color: 'var(--color-text-primary)' }}>{brandPack?.name || '品牌素材'}</div>
                      <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
                        {brandPack?.brand_color && <span className="h-2.5 w-2.5 rounded-sm border" style={{ background: normalizeColorInput(brandPack.brand_color), borderColor: 'var(--color-border)' }} />}
                        <span>{[brandPack?.brand_style, logoAsset && 'Logo', qrAsset && '二维码'].filter(Boolean).join(' · ') || '海报确定性图层'}</span>
                      </div>
                    </div>
                    {qrAsset && <img src={assetUrl(qrAsset.url)} alt="品牌二维码" className="h-8 w-8 bg-white object-contain" data-testid="brand-qrcode-preview" />}
                  </div>
                )}
              </details>
            )}

            <details className="group border-t" style={{ borderColor: 'var(--color-border)' }} data-testid="image-output-settings">
              <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-[12px] [&::-webkit-details-marker]:hidden" style={{ color: 'var(--color-text-secondary)' }}>
                <IconChevronRight size={13} className="transition-transform group-open:rotate-90" />
                <span>图片设置</span>
                <span className="ml-auto text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{ratio} · {count} 张 · {quality === 'draft' ? '草稿' : quality === 'final' ? '成稿' : '标准'}</span>
              </summary>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>图片比例</span>
                  <select value={ratio} onChange={event => setRatio(event.target.value)} className="w-full rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} data-testid="image-ratio-select">
                    {RATIOS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>张数</span>
                  <select value={count} onChange={event => setCount(Number(event.target.value))} className="w-full rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} data-testid="image-count-select">
                    {COUNTS.map((item) => <option key={item} value={item}>{item} 张</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>清晰度</span>
                  <select value={quality} onChange={event => setQuality(event.target.value as ImageQuality)} className="w-full rounded-md px-2 py-1.5 text-[11px] outline-none" style={inputStyle} data-testid="image-quality-select">
                    <option value="draft">预览</option>
                    <option value="standard">标准</option>
                    <option value="final">高清</option>
                  </select>
                </label>
              </div>
            </details>

          </section>

          {projects.length > 0 && <details className="border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>
            <summary className="cursor-pointer text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>最近图片</summary>
            <div className="mb-2 mt-2 flex items-center justify-end">
              <button type="button" onClick={() => void reloadProjects().catch((err) => toast(friendlyImageError(err, '刷新失败')))}
                className="rounded px-1.5 py-0.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} data-testid="refresh-workbench-projects">
                {projects.length} · 刷新
              </button>
            </div>
            <div className="max-h-[220px] space-y-1 overflow-auto">
              {projects.map((item) => (
                <button key={item.project_id} type="button" onClick={() => void switchProject(item)}
                  className="block w-full truncate rounded-md px-2 py-1.5 text-left text-[12px]"
                  style={segStyle(project?.project_id === item.project_id)}
                  data-testid="workbench-project-item">
                  {item.title}
                </button>
              ))}
            </div>
          </details>}
        </aside>

        {hasMainPanel && <main className={`${compactPane === 'canvas' ? 'block' : compactPane === 'adjust' ? 'hidden min-[1180px]:block' : 'hidden'} min-w-0 space-y-5`}>
          {creativeBrief && (
            <div className="border-b pb-3 text-[13px] leading-relaxed" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }} data-testid="brief-understanding">
              {creativeBrief.understanding ?? creativeBrief.user_request}
            </div>
          )}
          {busy && (
            <div className="rounded-lg p-3" style={panelStyle} data-testid="workbench-progress">
              <div className="mb-1 flex items-center justify-between text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                <span>{stage || '正在处理…'}</span><span>{progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--color-surface-container)' }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(4, progress)}%`, background: 'var(--color-brand)' }} />
              </div>
              <button type="button" onClick={() => void cancelActiveJob()} className="mt-2 rounded-md px-2 py-1 text-[12px]" style={buttonSubtleStyle} data-testid="cancel-image-job">取消</button>
            </div>
          )}
          {!busy && lastError && (
            <div className="flex items-center justify-between gap-3 rounded-lg p-3 text-[12px]" style={panelStyle} data-testid="workbench-retry">
              <span className="min-w-0 truncate" style={{ color: 'var(--color-text-secondary)' }}>{lastError}</span>
              {lastFailedAction && <button type="button" onClick={retryLast} className="shrink-0 rounded-md px-2 py-1 font-medium" style={buttonSubtleStyle}>重试</button>}
            </div>
          )}

          {images.length > 0 && (
            <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[12px] font-semibold" style={{ color: 'var(--color-text-secondary)' }}>选择喜欢的结果</h2>
                <button type="button" onClick={() => void run()} disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium disabled:opacity-50"
                  style={buttonSubtleStyle}>
                  <IconRefresh size={13} /> 换一批
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-3">
                {images.map((img) => (
                  <div
                    key={img.generation_id}
                    className="overflow-hidden rounded-md transition-colors"
                    style={{
                      border: `1px solid ${selectedImageId === img.generation_id ? 'var(--color-border-strong)' : 'var(--color-border)'}`,
                      boxShadow: selectedImageId === img.generation_id ? 'inset 0 -2px 0 var(--color-brand)' : undefined,
                    }}
                    data-selected={selectedImageId === img.generation_id ? 'true' : 'false'}
                    data-testid="candidate-card"
                  >
                    <button type="button" className="block w-full" onClick={() => setSelectedImageId(img.generation_id)} data-testid="candidate-select">
                      <CandidatePreview image={img} intent={intent} brief={creativeBrief} logoUrl={logoAsset?.url} qrUrl={qrAsset?.url} />
                    </button>
                    <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                      <button type="button" className="text-[11px]" style={{ color: 'var(--color-brand)' }} onClick={() => void openProjectFromImage(img)}>继续编辑</button>
                      <button type="button" className="text-[11px]" style={{ color: compareIds.includes(img.generation_id) ? 'var(--color-brand)' : 'var(--color-text-tertiary)' }} onClick={() => toggleCompare(img.generation_id)}>{compareIds.includes(img.generation_id) ? '已加入对比' : '加入对比'}</button>
                    </div>
                    {!imagePassesCandidateGate(img, intent) && <div className="px-2 pb-1.5 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>有需要确认的细节，建议放大查看</div>}
                  </div>
                  ))}
                </div>
              {selectedImage && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3" style={{ borderColor: 'var(--color-border)' }} data-testid="selected-candidate-preview">
                  <div className="min-w-0">
                    <div className="text-[12px] font-medium" style={{ color: 'var(--color-text-primary)' }}>已选择一张结果</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{selectedImage.width ?? '未知'}x{selectedImage.height ?? '未知'} · 可继续编辑文字和局部画面</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {intent === 'poster_text' && <button type="button" onClick={() => void quickDownloadCandidate(selectedImage)} className="rounded-md px-3 py-1.5 text-[11px]" style={buttonSubtleStyle} data-testid="quick-download-candidate">直接下载</button>}
                    <button type="button" onClick={() => void openProjectFromImage(selectedImage)} className="rounded-md px-3 py-1.5 text-[12px] font-medium" style={buttonPrimaryStyle} data-testid="open-selected-candidate">继续编辑</button>
                  </div>
                </div>
              )}
              {intent === 'portrait' && selectedImage && (referenceDescriptors[0] ?? projectReferenceDescriptors[0])?.url && (
                <div className="mt-3 grid grid-cols-2 gap-3" data-testid="portrait-reference-compare">
                  <figure className="overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }}>
                    <figcaption className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>主照片</figcaption>
                    <img src={assetUrl((referenceDescriptors[0] ?? projectReferenceDescriptors[0])!.url!)} alt="主照片" className="max-h-[320px] w-full object-contain" />
                  </figure>
                  <figure className="overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }}>
                    <figcaption className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>生成结果</figcaption>
                    <img src={assetUrl(selectedImage.poster_url)} alt="生成结果" className="max-h-[320px] w-full object-contain" />
                  </figure>
                </div>
              )}
              {compareImages.length === 2 && (
                <div className="mt-3 grid grid-cols-2 gap-3" data-testid="ab-compare">
                  {compareImages.map((img, index) => (
                    <figure key={img.generation_id} className="overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }}>
                      <figcaption className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{index === 0 ? 'A' : 'B'}</figcaption>
                      <CandidatePreview image={img} intent={intent} brief={creativeBrief} logoUrl={logoAsset?.url} qrUrl={qrAsset?.url} compact={false} />
                    </figure>
                  ))}
                </div>
              )}
            </section>
          )}

          {project && <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-[14px] font-semibold" style={{ color: 'var(--color-text-primary)' }} data-testid="workbench-title">
                  {project ? project.title : '选择一张图片开始编辑'}
                </h2>
                {project && <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{project.canvas.width}x{project.canvas.height} · {project.versions.length} 个版本 · {saveState === 'saving' ? '保存中' : saveState === 'failed' ? '保存失败' : '已保存'}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => void saveCanvas()} disabled={!project} className="rounded-md px-2 py-1 text-[12px] disabled:opacity-50" style={buttonSubtleStyle}>保存</button>
                <button type="button" onClick={() => void exportPng()} disabled={!project || busy} className="rounded-md px-2 py-1 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="export-png-button">下载 PNG</button>
              </div>
            </div>
            <div ref={canvasViewportRef} className="flex max-h-[70vh] justify-center overflow-auto rounded-md p-3" style={{ background: 'var(--color-surface-container)' }} data-testid="workbench-canvas-viewport">
              <canvas ref={setCanvasElement} data-testid="workbench-canvas" />
            </div>
          </section>}
          {project && <section className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }} data-testid="image-quality-status">
            <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>使用前检查</div>
            {reviewLines.length > 0 ? (
              <div>
                {reviewLines.map((line) => (
                  <div key={line} className="flex items-start gap-2 border-b py-2 text-[12px] last:border-b-0" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}>
                    <IconAlertCircle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-tertiary)' }}>尚未自动检查</div>
            )}
            {intent === 'portrait' && project && currentVersion?.review?.portrait_quality_state !== 'user_confirmed' && (
              <button type="button" onClick={() => void confirmPortrait()} disabled={!currentVersion || currentVersion.review?.portrait_quality_state === 'blocked'} className="mt-2 w-full rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonPrimaryStyle} data-testid="confirm-portrait-button">
                确认像本人
              </button>
            )}
            {intent === 'portrait' && currentVersion?.review?.portrait_quality_state === 'user_confirmed' && (
              <>
                <div className="mt-2 rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }} data-testid="portrait-user-confirmed">已确认像本人</div>
                <button type="button" onClick={() => void usePortraitAsPoster()} className="mt-2 w-full rounded-md px-3 py-2 text-[12px] font-medium" style={buttonSubtleStyle} data-testid="portrait-to-poster-button">用这张照片做海报</button>
              </>
            )}
          </section>}
        </main>}

        {project && <aside className={`${compactPane === 'adjust' ? 'block' : 'hidden'} min-w-0 space-y-5 border-t pt-5 min-[1180px]:border-l min-[1180px]:border-t-0 min-[1180px]:pl-6 min-[1180px]:pt-0`} style={{ borderColor: 'var(--color-border)' }}>
          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconEdit size={14} />描述想改的地方</div>
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} className="w-full resize-none rounded-md px-3 py-2 text-[12.5px] outline-none" style={inputStyle} placeholder="说出只想改动的内容" data-testid="whole-edit-input" />
            <button type="button" onClick={() => void wholeEdit()} disabled={!project || !editText.trim() || busy} className="mt-2 w-full rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonPrimaryStyle} data-testid="whole-edit-button">按描述修改</button>
          </section>

          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconTarget size={14} />只改选中区域</div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['select', 'rect', 'brush'] as MaskMode[]).map((mode) => (
                <Tooltip key={mode} label={mode === 'select' ? '选择/编辑文字' : mode === 'rect' ? '矩形选区' : '涂抹笔刷'}>
                  <button type="button" onClick={() => selectMaskMode(mode)} className="rounded-md px-2 py-1 text-[12px]" style={segStyle(maskMode === mode)}>
                    {mode === 'select' ? '移动' : mode === 'rect' ? '框选' : '涂抹'}
                  </button>
                </Tooltip>
              ))}
            </div>
            <label className="mt-2 block text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>涂抹大小 {brushSize}px</label>
            <input type="range" min={16} max={180} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-full" />
            <textarea value={maskText} onChange={(e) => setMaskText(e.target.value)} rows={3} className="mt-2 w-full resize-none rounded-md px-3 py-2 text-[12.5px] outline-none" style={inputStyle} placeholder="例如:把选区里的桌布换成墨绿色" data-testid="inpaint-input" />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void inpaint()} disabled={!project || !maskText.trim() || maskItems.length === 0 || busy} className="flex-1 rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonPrimaryStyle} data-testid="inpaint-button">修改选中区域</button>
              <button type="button" onClick={clearMask} disabled={maskItems.length === 0} className="rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle}>清除</button>
            </div>
          </section>

          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconPlus size={14} />添加与调整文字</div>
            <div className="mb-2 grid grid-cols-4 gap-1.5">
              <button type="button" onClick={addText} disabled={!project} className="rounded-md px-2 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonSubtleStyle} data-testid="add-text-button">添加</button>
              <button type="button" onClick={undoText} disabled={!canUndoText} className="rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="text-undo-button">撤销</button>
              <button type="button" onClick={redoText} disabled={!canRedoText} className="rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="text-redo-button">重做</button>
              <button type="button" onClick={deleteActiveText} disabled={!activeTextId} className="inline-flex items-center justify-center rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="delete-text-button"><IconTrash size={13} /></button>
            </div>
            <input value={textValue} onChange={(e) => { setTextValue(e.target.value); applyTextPatch({ text: e.target.value }) }} disabled={!activeTextId} className="w-full rounded-md px-3 py-2 text-[12.5px] outline-none disabled:opacity-50" style={inputStyle} placeholder="选中文字层后编辑" />
            <div className="mt-2 grid grid-cols-[1fr_76px] gap-2">
              <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>文字颜色<input aria-label="文字颜色" type="color" value={normalizeColorInput(textColor)} onChange={(e) => { setTextColor(e.target.value); applyTextPatch({ fill: e.target.value }) }} disabled={!activeTextId} className="mt-1 block h-9 w-12 rounded-md p-0.5" /></label>
              <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>字号<input aria-label="字号" type="number" value={textSize} min={12} max={512} onChange={(e) => { const next = Number(e.target.value); setTextSize(next); applyTextPatch({ fontSize: next }) }} disabled={!activeTextId} className="mt-1 h-9 w-full rounded-md px-2 text-[12px] outline-none disabled:opacity-50" style={inputStyle} /></label>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {(['left', 'center', 'right', 'justify'] as ImageWorkbenchTextLayer['text_align'][]).map((align) => (
                <button key={align} type="button" onClick={() => { setTextAlign(align); applyTextPatch({ textAlign: align }) }} disabled={!activeTextId}
                  className="rounded-md px-2 py-1.5 text-[12px] disabled:opacity-50" style={segStyle(textAlign === align)} data-testid={`text-align-${align}`}>
                  {align === 'left' ? '左' : align === 'right' ? '右' : align === 'justify' ? '两端' : '中'}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-[1fr_76px] gap-2">
              <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>文字边框<input aria-label="文字边框颜色" type="color" value={normalizeColorInput(strokeColor)} onChange={(e) => { setStrokeColor(e.target.value); applyTextPatch({ stroke: e.target.value }) }} disabled={!activeTextId} className="mt-1 block h-9 w-12 rounded-md p-0.5" /></label>
              <label className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>边框粗细<input aria-label="文字边框粗细" type="number" value={strokeWidth} min={0} max={64} onChange={(e) => { const next = Number(e.target.value); setStrokeWidth(next); applyTextPatch({ strokeWidth: next }) }} disabled={!activeTextId} className="mt-1 h-9 w-full rounded-md px-2 text-[12px] outline-none disabled:opacity-50" style={inputStyle} /></label>
            </div>
          </section>

          <section className="pb-1">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconZap size={14} />版本与下载</div>
            <div className="max-h-[180px] space-y-1 overflow-auto">
              {project?.versions.slice().reverse().map((version) => (
                <button key={version.id} type="button" onClick={() => void workbenchApi.rollback(project.project_id, version.id).then(refreshProject).catch((err) => toast(friendlyImageError(err, '切换版本失败')))}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px]" style={segStyle(version.id === project.current_version_id)} data-testid="version-item">
                  <span className="truncate">{versionKindLabel(version.kind)}</span>
                  {version.id === project.current_version_id && <IconCheckCircle size={13} />}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => void upscale()} disabled={!project || busy} className="rounded-md px-2 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonSubtleStyle}>生成高清图片</button>
              <button type="button" onClick={() => void saveToLibrary()} disabled={!project} className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonSubtleStyle} data-testid="save-library-button"><IconShareUp size={13} />保存到图片库</button>
            </div>
          </section>
        </aside>}
      </div>
    </div>
    </div>
  )
}
