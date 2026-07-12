import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, FabricImage, Path, Rect, Textbox, type FabricObject } from 'fabric'
import { PageHeader } from '../../components/shared/PageKit'
import { Tooltip } from '../../components/shared/Tooltip'
import { IconCheckCircle, IconEdit, IconMessage, IconPlus, IconRefresh, IconShareUp, IconSparkles, IconTarget, IconTrash, IconZap } from '../../components/shared/icons'
import { toast } from '../../stores/toastStore'
import { useUiStore } from '../../stores/uiStore'
import {
  assetUrl,
  pickImageUrl,
  pollJob,
  studioApi,
  workbenchApi,
  type ImageAssetReference,
  type ImageIntent,
  type ImageQuality,
  type ImageReferenceRole,
  type ImageWorkbenchAsset,
  type ImageWorkbenchImageLayer,
  type ImageWorkbenchProject,
  type ImageWorkbenchReview,
  type ImageWorkbenchTextLayer,
  type ImageWorkbenchVersion,
  type StudioImage,
  type ImageCreativeBrief,
  type GenerateInput,
  downloadAsset,
  fetchAssetFile,
} from '../../api/studio'

const RATIOS: { id: string; label: string }[] = [
  { id: '9:16', label: '竖屏' },
  { id: '1:1', label: '方图' },
  { id: '3:4', label: '海报' },
  { id: '16:9', label: '横版' },
  { id: '2:5', label: '易拉宝' },
]

const COUNTS = [1, 2, 3, 4]

const POSTER_TYPES: Array<{ id: string; label: string; prompt: string }> = [
  { id: 'custom_poster', label: '自由描述', prompt: '' },
  { id: 'opening_anniversary', label: '新店开业', prompt: '做一张新店开业海报' },
  { id: 'weekend_bundle', label: '引流体验/团购', prompt: '做一张新客引流体验海报' },
  { id: 'membership_recharge', label: '一卡通/器材券', prompt: '做一张一卡通和器材券活动海报' },
  { id: 'tournament_signup', label: '抢一/会员赛', prompt: '做一张抢一大战或会员赛活动海报' },
  { id: 'coach_booking', label: '助教到店/预约', prompt: '做一张助教到店预约海报' },
  { id: 'holiday_moments', label: '门店日常/朋友圈', prompt: '做一张门店朋友圈日常海报' },
]

type MaskMode = 'select' | 'rect' | 'brush'
type MaskItem =
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'brush'; points: Array<{ x: number; y: number }>; size: number }
type WorkbenchAction = 'generate' | 'edit' | 'inpaint' | 'upscale'

type WorkbenchObject = FabricObject & {
  workbenchLayerId?: string
  imageLayerId?: string
  imageLayerType?: ImageWorkbenchImageLayer['type']
  workbenchLayerUrl?: string
  maskRole?: boolean
  backgroundRole?: boolean
}

interface DrawingState {
  mode: Extract<MaskMode, 'rect' | 'brush'>
  start: { x: number; y: number }
  points: Array<{ x: number; y: number }>
  object: WorkbenchObject
}

export function CreationPage() {
  const setNav = useUiStore((s) => s.setNav)
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
  const [posterPhone, setPosterPhone] = useState('')
  const [portraitAuthorized, setPortraitAuthorized] = useState(false)
  const [logoAsset, setLogoAsset] = useState<ImageWorkbenchAsset | null>(null)
  const [qrAsset, setQrAsset] = useState<ImageWorkbenchAsset | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved')
  const [referenceAssets, setReferenceAssets] = useState<ImageWorkbenchAsset[]>([])
  const [referenceRoles, setReferenceRoles] = useState<Record<string, ImageReferenceRole>>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [lastError, setLastError] = useState('')
  const [lastFailedAction, setLastFailedAction] = useState<WorkbenchAction | null>(null)
  const [compactPane, setCompactPane] = useState<'create' | 'canvas' | 'adjust'>('create')
  const [images, setImages] = useState<StudioImage[]>([])
  const [creativeBrief, setCreativeBrief] = useState<ImageCreativeBrief | null>(null)
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [recommendedImageId, setRecommendedImageId] = useState<string | null>(null)
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
    label: intent === 'portrait' ? (index === 0 ? '助教主照片' : '补充照片') : '参考素材',
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
    setCreativeBrief(null)
  }, [prompt, posterTitle, posterOffer, posterPrice, posterDate, posterPhone, intent, ratio, quality, sceneId, referenceDescriptors.map(asset => `${asset.asset_id}:${asset.role}`).join('|'), portraitAuthorized])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loaded = await workbenchApi.listProjects()
        if (cancelled) return
        setProjects(loaded)
        if (loaded[0]) setProject(loaded[0])
      } catch {
        if (!cancelled) setProjects([])
      }
    })()
    return () => { cancelled = true; abortRef.current?.abort() }
  }, [])

  useEffect(() => {
    if (!canvasElement) return
    const canvas = new Canvas(canvasElement, {
      preserveObjectStacking: true,
      selection: true,
      backgroundColor: themedColor('--color-surface-container', '#f3f3f3'),
    })
    fabricRef.current = canvas

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

    canvas.on('selection:created', updateActiveText)
    canvas.on('selection:updated', updateActiveText)
    canvas.on('selection:cleared', updateActiveText)
    canvas.on('object:modified', sync)
    canvas.on('text:changed', sync)
    canvas.on('mouse:down', onDown)
    canvas.on('mouse:move', onMove)
    canvas.on('mouse:up', onUp)

    return () => {
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
      resetTextHistory(canvas)
      setTextValue('')
      setActiveTextId(null)
      setMaskItems([])
      setLastExport(null)
    })().catch((err) => toast(err instanceof Error ? err.message : '画布加载失败'))
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

  const canRun = (prompt.trim().length > 0 || posterTitle.trim().length > 0) && !busy

  const beginAction = (stageText: string) => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBusy(true)
    setActiveJobId(null)
    setProgress(0)
    setStage(stageText)
    setLastError('')
    setLastFailedAction(null)
    setCompactPane('canvas')
    return ctrl
  }

  const finishAction = (ctrl: AbortController) => {
    if (abortRef.current === ctrl) abortRef.current = null
    setBusy(false)
    setActiveJobId(null)
    setStage('')
  }

  const cancelActiveJob = async () => {
    const jobId = activeJobId
    abortRef.current?.abort()
    setBusy(false)
    setStage('已请求取消')
    setLastError('已取消')
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

  const selectWorkflow = (next: 'poster' | 'assistant_photo') => {
    if (next === 'assistant_photo') {
      setIntent('portrait')
      setSceneId('assistant_photo')
      setPrompt('用已上传的助教实拍照片优化得更好看、自然，没有明显 AI 感；保留本人面部和身形特征。')
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
      posterPhone && `电话：${posterPhone}`,
    ].filter(Boolean)
    return [prompt.trim(), ...fields].filter(Boolean).join('，')
  }

  const uploadBrandAsset = async (file: File | undefined, kind: 'logo' | 'qrcode') => {
    if (!file) return
    try {
      const asset = await uploadWorkbenchImage(file)
      if (kind === 'logo') setLogoAsset(asset)
      else setQrAsset(asset)
      toast(kind === 'logo' ? 'Logo 已加入品牌包' : '二维码已加入品牌包')
    } catch (err) {
      toast(err instanceof Error ? err.message : '品牌素材上传失败')
    }
  }

  const uploadReferences = async (files: FileList | null) => {
    if (!files?.length) return
    const limit = intent === 'portrait' ? 3 : 8
    const available = Math.max(0, limit - referenceAssets.length)
    if (available === 0) {
      toast(intent === 'portrait' ? '助教照片最多使用 3 张' : '最多使用 8 张参考图')
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

  const setReferenceRole = (assetId: string, role: Extract<ImageReferenceRole, 'identity_primary' | 'identity_supporting'>) => {
    setReferenceRoles(previous => {
      const next = { ...previous, [assetId]: role }
      if (role === 'identity_primary') {
        for (const asset of referenceAssets) {
          if (asset.asset_id !== assetId && next[asset.asset_id] === 'identity_primary') next[asset.asset_id] = 'identity_supporting'
        }
      }
      return next
    })
  }

  const prepareBrief = async () => {
    const request = requestText()
    if (!request || busy) return
    setBusy(true)
    setStage('正在理解需求…')
    try {
      const result = await studioApi.compileBrief({
        prompt: request,
        scene: intent === 'portrait' ? 'portrait' : 'poster',
        intent,
        ratio,
        quality,
        scene_template_id: sceneId,
        poster_text: { title: posterTitle, offer: posterOffer, price: posterPrice, date: posterDate, phone: posterPhone },
        reference_assets: referenceDescriptors,
        portrait_authorization_confirmed: portraitAuthorized,
      })
      setCreativeBrief(result.brief)
    } catch (err) {
      toast(err instanceof Error ? err.message : '需求理解失败')
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  const run = async () => {
    const request = requestText()
    if (!request || busy) return
    if (!creativeBrief) {
      await prepareBrief()
      return
    }
    const ctrl = beginAction('正在提交…')
    setImages([])
    try {
      const generateInput: GenerateInput = {
        prompt: request,
        user_request: request,
        scene_template_id: sceneId,
        ratio,
        count,
        intent,
        quality,
        reference_image_paths: referenceUrls,
        reference_assets: referenceDescriptors,
        poster_text: {
          title: posterTitle,
          offer: posterOffer,
          price: posterPrice,
          date: posterDate,
          phone: posterPhone,
        },
        portrait_consent: portraitAuthorized,
        portrait_authorization_confirmed: portraitAuthorized,
        input_fidelity: referenceAssets.length > 0 ? 'high' : undefined,
        creative_brief: creativeBrief,
      }
      const { job_id } = await studioApi.generate(generateInput)
      setActiveJobId(job_id)
      const job = await pollJob(job_id, { signal: ctrl.signal, onProgress: (p: number, s?: string) => { setProgress(p); if (s) setStage(s) }, intervalMs: 600 })
      const result = job.result ?? {}
      if (job.status !== 'done') throw new Error(result.message || job.error || '生成失败')
      if (result.blocked) throw new Error(result.message || '所需组件正在后台准备,稍后再试。')
      let imgs = (result.images ?? []).filter((img) => img.local_preview !== true)
      if ((result.images ?? []).some((img) => img.local_preview === true) && imgs.length === 0) {
        throw new Error('当前只有本地预览占位图，未配置真实生图服务，不能作为正式候选或交付。')
      }
      if (!imgs.length) throw new Error('没有生成图片,换个描述再试试')
      const hardGatePassed = imgs.filter(img => imagePassesCandidateGate(img, intent)).length
      const needsPosterSupplement = intent === 'poster_text' && imgs.length === 3 && hardGatePassed < 2
      const needsPortraitSupplement = intent === 'portrait' && imgs.length === 3 && imgs.every(img => portraitCandidateHasHardRisk(img))
      if (needsPosterSupplement || needsPortraitSupplement) {
        setStage('候选风险较多，正在补生成一批…')
        try {
          const retry = await studioApi.generate(generateInput)
          setActiveJobId(retry.job_id)
          const retryJob = await pollJob(retry.job_id, { signal: ctrl.signal, onProgress: (p: number, s?: string) => { setProgress(p); if (s) setStage(s) }, intervalMs: 600 })
          const retryImages = retryJob.status === 'done' && !retryJob.result?.blocked
            ? (retryJob.result?.images ?? []).filter(img => img.local_preview !== true)
            : []
          imgs = chooseThreeCandidates([...imgs, ...retryImages], intent)
        } catch {
          // Keep the first batch visible with its recorded risks. One retry is
          // the cost ceiling; failures must not erase usable candidate history.
        }
      }
      setImages(imgs)
      setCreativeBrief(result.creative_brief ?? null)
      const recommended = imgs.find(img => imagePassesCandidateGate(img, intent))?.generation_id ??
        (typeof result.recommended_generation_id === 'string' ? result.recommended_generation_id : null)
      setRecommendedImageId(recommended)
      setSelectedImageId(recommended ?? imgs[0]?.generation_id ?? null)
      setCompareIds(imgs.slice(0, 2).map((img) => img.generation_id))
      setCompactPane('canvas')
    } catch (e) {
      if (!ctrl.signal.aborted) {
        const message = e instanceof Error ? e.message : '生成失败'
        setLastError(message)
        setLastFailedAction('generate')
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }

  const createProjectFromImage = async (img: StudioImage): Promise<ImageWorkbenchProject> => {
    if (img.local_preview === true) {
      throw new Error('本地预览占位图不能进入正式项目')
    }
    const width = img.width ?? dimensionFromRatio(img.ratio ?? ratio).width
    const height = img.height ?? dimensionFromRatio(img.ratio ?? ratio).height
    return await workbenchApi.createProject({
      title: creativeBrief?.poster?.title || prompt.trim().slice(0, 80) || '生图工作台项目',
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
      }) : [],
      image_layers: [
        ...(logoAsset ? [{ id: `layer_${logoAsset.asset_id}`, type: 'logo' as const, asset_id: logoAsset.asset_id, url: logoAsset.url, x: width * 0.04, y: height * 0.04, width: width * 0.18, height: width * 0.18, locked: false }] : []),
        ...(qrAsset ? [{ id: `layer_${qrAsset.asset_id}`, type: 'qrcode' as const, asset_id: qrAsset.asset_id, url: qrAsset.url, x: width * 0.78, y: height * 0.82, width: width * 0.16, height: width * 0.16, locked: false }] : []),
      ],
      review: reviewFromRecord(img),
    })
  }

  const openProjectFromImage = async (img: StudioImage) => {
    try {
      if (project?.source_generation_id === img.generation_id) {
        await refreshProject(project)
        setCompactPane('canvas')
        toast('当前候选已经在工作台中')
        return
      }
      const next = await createProjectFromImage(img)
      await refreshProject(next)
      setCompactPane('canvas')
      setProjects((items) => [next, ...items.filter((item) => item.project_id !== next.project_id)])
      toast('已送入工作台')
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建项目失败')
    }
  }

  const quickDownloadCandidate = async (img: StudioImage) => {
    setBusy(true)
    setStage('正在合成确定性文字并导出…')
    try {
      await waitForFonts()
      const next = await createProjectFromImage(img)
      const version = next.versions.find(item => item.id === next.current_version_id)
      if (!version) throw new Error('候选项目没有可导出的版本')

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
      setCompactPane('canvas')
      await downloadAsset(result.asset.url, `${next.title}-${new Date().toISOString().slice(0, 10)}`)
      toast('已生成并下载 PNG 成品')
    } catch (err) {
      const message = err instanceof Error ? err.message : '成品导出失败'
      setLastError(message)
      toast(message)
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  const refreshProject = async (next: ImageWorkbenchProject) => {
    setProject(next)
    setProjects((items) => [next, ...items.filter((item) => item.project_id !== next.project_id)])
    autosaveSnapshotRef.current = JSON.stringify({ revision: next.autosave_revision, canvas: next.canvas })
    setSaveState(next.save_status)
  }

  const waitForFabricCanvas = async (): Promise<Canvas> => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (fabricRef.current) return fabricRef.current
      await new Promise<void>(resolve => window.setTimeout(resolve, 16))
    }
    throw new Error('编辑画布尚未准备好')
  }

  const reloadProjects = async () => {
    const loaded = await workbenchApi.listProjects()
    setProjects(loaded)
    if (loaded[0]) setProject((prev) => prev ? (loaded.find((item) => item.project_id === prev.project_id) ?? loaded[0]!) : loaded[0]!)
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
      void workbenchApi.saveCanvas(project.project_id, {
        current_version_id: project.current_version_id,
        width: project.canvas.width,
        height: project.canvas.height,
        text_layers: project.canvas.text_layers,
        image_layers: project.canvas.image_layers,
        revision: project.autosave_revision,
      }).then(next => {
        autosaveSnapshotRef.current = JSON.stringify({ revision: next.autosave_revision, canvas: next.canvas })
        setProject(next)
        setProjects(items => [next, ...items.filter(item => item.project_id !== next.project_id)])
        setSaveState('saved')
      }).catch(() => setSaveState('failed'))
    }, 800)
    return () => window.clearTimeout(timer)
  }, [project?.project_id, project?.canvas.updated_at])

  const saveCanvas = async () => {
    const canvas = fabricRef.current
    if (!project || !canvas) return
    const next = await workbenchApi.saveCanvas(project.project_id, {
      current_version_id: project.current_version_id,
      width: project.canvas.width,
      height: project.canvas.height,
      text_layers: extractTextLayers(canvas),
      image_layers: extractImageLayers(canvas),
      revision: project.autosave_revision,
    })
    await refreshProject(next)
    toast('项目已保存')
  }

  const addText = () => {
    const canvas = fabricRef.current
    const base = projectRef.current
    if (!canvas || !base) return
    const layerId = `text_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const box = new Textbox('双击编辑中文文字', {
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
    const ctrl = beginAction('正在改图…')
    try {
      const { job_id } = await studioApi.edit({
        ...sourceForEdit(currentVersion, editText.trim(), 'edit_content', quality),
        user_request: editText.trim(),
        reference_image_paths: projectReferenceDescriptors.map(asset => asset.url).filter((url): url is string => Boolean(url)),
        reference_assets: projectReferenceDescriptors,
        portrait_consent: portraitAuthorized,
        portrait_authorization_confirmed: portraitAuthorized,
        input_fidelity: projectReferenceDescriptors.length > 0 ? 'high' : undefined,
      })
      setActiveJobId(job_id)
      const job = await pollJob(job_id, { signal: ctrl.signal, intervalMs: 600, onProgress: (p: number, s?: string) => { setProgress(p); if (s) setStage(s) } })
      const next = await addImageVersionFromJob(project, currentVersion, job, 'edit', editText.trim())
      await refreshProject(next)
      setEditText('')
      toast('已生成整图修改版本')
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = err instanceof Error ? err.message : '改图失败'
        setLastError(message)
        setLastFailedAction('edit')
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }

  const inpaint = async () => {
    if (!project || !currentVersion || !maskText.trim()) return
    if (maskItems.length === 0) { toast('先用矩形或笔刷标出要重绘的区域'); return }
    const ctrl = beginAction('正在生成蒙版…')
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
        input_fidelity: projectReferenceDescriptors.length > 0 ? 'high' : undefined,
      })
      setActiveJobId(job_id)
      const job = await pollJob(job_id, { signal: ctrl.signal, intervalMs: 600, onProgress: (p: number, s?: string) => { setProgress(p); if (s) setStage(s) } })
      const next = await addImageVersionFromJob(project, currentVersion, job, 'inpaint', maskText.trim(), asset)
      await refreshProject(next)
      clearMask()
      setMaskText('')
      toast('局部重绘版本已生成')
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = err instanceof Error ? err.message : '局部重绘失败'
        setLastError(message)
        setLastFailedAction('inpaint')
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }

  const upscale = async () => {
    if (!project || !currentVersion) return
    const ctrl = beginAction('正在高清放大…')
    try {
      const { job_id } = await studioApi.upscale(sourceForUpscale(currentVersion))
      setActiveJobId(job_id)
      const job = await pollJob(job_id, { signal: ctrl.signal, intervalMs: 600, onProgress: (p: number, s?: string) => { setProgress(p); if (s) setStage(s) } })
      const next = await addImageVersionFromJob(project, currentVersion, job, 'upscale', '高清放大')
      await refreshProject(next)
      toast('已生成高清版本')
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const message = err instanceof Error ? err.message : '放大失败'
        setLastError(message)
        setLastFailedAction('upscale')
        toast(message)
      }
    } finally {
      finishAction(ctrl)
    }
  }

  const exportPng = async () => {
    const canvas = fabricRef.current
    if (!project || !currentVersion || !canvas) return
    setBusy(true); setStage('正在导出 PNG…')
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
      toast(`已按 ${result.asset.width}x${result.asset.height} 导出 PNG`)
    } catch (err) {
      toast(err instanceof Error ? err.message : '导出失败')
    } finally {
      setBusy(false); setStage('')
    }
  }

  const saveToLibrary = async () => {
    if (!project) return
    try {
      const item = await workbenchApi.saveToLibrary(project.project_id, { export_asset_id: lastExport?.asset_id, title: project.title })
      toast(`已保存到素材库:${item.title}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存素材库失败')
    }
  }

  const confirmPortrait = async () => {
    if (!project || intent !== 'portrait' || !currentVersion) return
    try {
      const next = await workbenchApi.confirmPortrait(project.project_id, currentVersion.id)
      await refreshProject(next)
      toast('已确认像本人，可以继续导出；这不是法律授权或自动商用保证。')
    } catch (err) {
      toast(err instanceof Error ? err.message : '确认失败')
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
      setSceneId('coach_booking')
      setPrompt('使用已确认的助教照片作为人物素材，制作助教到店预约海报，为标题、价格、日期和二维码预留清晰区域')
      setCreativeBrief(null)
      toast('已带入助教照片，继续确认海报需求')
    } catch (err) {
      toast(err instanceof Error ? err.message : '带入助教照片失败')
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
  const workspaceLayoutClass = hasProject
    ? 'grid min-h-0 grid-cols-1 gap-x-7 gap-y-6 min-[840px]:grid-cols-[minmax(236px,280px)_minmax(0,1fr)] min-[1180px]:grid-cols-[250px_minmax(0,1fr)_280px]'
    : hasMainPanel
      ? 'grid min-h-0 grid-cols-1 gap-x-7 gap-y-6 min-[840px]:grid-cols-[minmax(236px,280px)_minmax(0,1fr)]'
      : 'mx-auto max-w-[760px]'

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="creation-page">
      <div className="mx-auto min-h-full w-full max-w-[1560px] px-5 py-5 min-[840px]:px-8 min-[840px]:py-7">
        <PageHeader
          title="生图工作台"
          action={(
            <button
              type="button"
              onClick={() => setNav('chat')}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
              data-testid="workbench-back-chat"
            >
              <IconMessage size={14} /> 返回对话
            </button>
          )}
        />

        {hasWorkbenchStage && <div className="mb-5 grid grid-cols-3 gap-1 rounded-lg p-1 min-[840px]:hidden" style={{ background: 'var(--color-surface-container)' }} role="tablist" aria-label="工作台视图">
          {([
            ['create', '创作'],
            ['canvas', '挑选'],
            ['adjust', '调整'],
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
              onClick={() => setCompactPane(pane)}
              className="rounded-md px-2 py-1.5 text-[12px] font-medium disabled:cursor-not-allowed disabled:opacity-45"
              style={segStyle(compactPane === pane && available)}
            >
              {label}
            </button>
              )
            })()
          ))}
        </div>}

        <div className={workspaceLayoutClass}>
        <aside className={`${compactPane === 'create' ? 'block' : 'hidden min-[840px]:block'} min-w-0 space-y-5`}>
          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>创作类型</span>
                <select value={intent === 'portrait' ? 'assistant_photo' : 'poster'} onChange={event => selectWorkflow(event.target.value as 'poster' | 'assistant_photo')} className="w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} data-testid="image-workflow-select">
                  <option value="poster">海报</option>
                  <option value="assistant_photo">助教照片</option>
                </select>
              </label>
              {intent === 'poster_text' && (
                <label className="block">
                  <span className="mb-1 block text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>海报类型（可选）</span>
                  <select value={sceneId} onChange={event => selectPosterType(event.target.value)} className="w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} data-testid="poster-type-select">
                    {POSTER_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
                  </select>
                </label>
              )}
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              className="mt-3 w-full resize-none rounded-md px-3 py-2 text-[13px] leading-relaxed outline-none"
              placeholder={intent === 'portrait' ? '上传照片后，说说想要的场景、服装、氛围或状态' : '写下你想做的海报、画面主体和需要保留的文字'}
              style={inputStyle}
              data-testid="image-prompt-input"
            />
            {intent === 'poster_text' && <button type="button" onClick={() => setQuickForm(value => !value)} className="mt-2 px-0 py-1 text-[12px]" style={{ color: 'var(--color-link)' }} data-testid="toggle-quick-form">
              {quickForm ? '收起海报文字' : '添加海报硬文字'}
            </button>}
            {intent === 'poster_text' && quickForm && (
              <div className="mt-2 grid grid-cols-2 gap-2" data-testid="poster-quick-form">
                <input value={posterTitle} onChange={e => setPosterTitle(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="主标题" />
                <input value={posterOffer} onChange={e => setPosterOffer(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="优惠内容" />
                <input value={posterPrice} onChange={e => setPosterPrice(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="价格" />
                <input value={posterDate} onChange={e => setPosterDate(e.target.value)} className="rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="日期/时间" />
                <input value={posterPhone} onChange={e => setPosterPhone(e.target.value)} className="col-span-2 rounded-md px-2 py-1.5 text-[12px] outline-none" style={inputStyle} placeholder="预约电话" />
              </div>
            )}
            <label className="mt-3 block">
              <span className="mb-1 block text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>{intent === 'portrait' ? '助教实拍照片（1-3 张）' : '参考图（可选）'}</span>
              <input type="file" accept="image/*" multiple className="block w-full text-[12px]" onChange={(e) => void uploadReferences(e.target.files).catch((err) => toast(err instanceof Error ? err.message : '上传失败'))} />
            </label>
            {referenceAssets.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {referenceAssets.map((asset, index) => (
                  <div key={asset.asset_id} className="space-y-1">
                    <img src={assetUrl(asset.url)} alt="" className="h-10 w-10 rounded object-cover" />
                    {intent === 'portrait' && (
                      <select
                        aria-label={`参考图 ${index + 1} 角色`}
                        value={referenceRoles[asset.asset_id] ?? defaultReferenceRole(intent, index)}
                        onChange={event => setReferenceRole(asset.asset_id, event.target.value as Extract<ImageReferenceRole, 'identity_primary' | 'identity_supporting'>)}
                        className="w-16 rounded border px-1 py-0.5 text-[10px]"
                        style={inputStyle}
                      >
                        <option value="identity_primary">主照片</option>
                        <option value="identity_supporting">补充</option>
                      </select>
                    )}
                  </div>
                ))}
              </div>
            )}
            {intent === 'portrait' && (
              <label className="mt-3 flex items-start gap-2 border-t pt-3 text-[12px]" style={{ borderColor: 'var(--color-border)' }} data-testid="portrait-authorization">
                <input type="checkbox" checked={portraitAuthorized} onChange={e => setPortraitAuthorized(e.target.checked)} className="mt-0.5" />
                <span style={{ color: 'var(--color-text-secondary)' }}>我拥有这些照片的使用授权，且被拍者同意用于门店宣传</span>
              </label>
            )}
            {intent === 'poster_text' && (
              <details className="mt-3 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>
                <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>添加品牌素材</summary>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <label className="block text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                    <span>Logo</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block w-full text-[10px]" onChange={e => void uploadBrandAsset(e.target.files?.[0], 'logo')} />
                  </label>
                  <label className="block text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
                    <span>二维码</span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="mt-1 block w-full text-[10px]" onChange={e => void uploadBrandAsset(e.target.files?.[0], 'qrcode')} />
                  </label>
                </div>
              </details>
            )}
          </section>

          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>画幅</span>
                <select value={ratio} onChange={event => setRatio(event.target.value)} className="w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} data-testid="image-ratio-select">
                  {RATIOS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>候选</span>
                <select value={count} onChange={event => setCount(Number(event.target.value))} className="w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} data-testid="image-count-select">
                  {COUNTS.map((item) => <option key={item} value={item}>{item} 张</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>精度</span>
                <select value={quality} onChange={event => setQuality(event.target.value as ImageQuality)} className="w-full rounded-md px-2 py-2 text-[12px] outline-none" style={inputStyle} data-testid="image-quality-select">
                  <option value="draft">草稿</option>
                  <option value="standard">标准</option>
                  <option value="final">成稿</option>
                </select>
              </label>
            </div>
            <button type="button" onClick={() => void run()} disabled={!canRun}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-medium disabled:opacity-50"
              style={{ background: 'var(--color-brand)', color: 'var(--color-on-primary)' }} data-testid="image-generate-button">
              <IconSparkles size={15} /> {busy ? '处理中…' : creativeBrief ? `确认并生成 ${count} 张候选` : '理解需求'}
            </button>
            {creativeBrief && (
              <div className="mt-2 rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }} data-testid="brief-understanding">
                {creativeBrief.understanding ?? creativeBrief.user_request}
              </div>
            )}
          </section>

          {projects.length > 0 && <section className="pb-1">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>项目</span>
              <button type="button" onClick={() => void reloadProjects().catch((err) => toast(err instanceof Error ? err.message : '刷新失败'))}
                className="rounded px-1.5 py-0.5 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }} data-testid="refresh-workbench-projects">
                {projects.length} · 刷新
              </button>
            </div>
            <div className="max-h-[220px] space-y-1 overflow-auto">
              {projects.map((item) => (
                <button key={item.project_id} type="button" onClick={() => setProject(item)}
                  className="block w-full truncate rounded-md px-2 py-1.5 text-left text-[12px]"
                  style={segStyle(project?.project_id === item.project_id)}
                  data-testid="workbench-project-item">
                  {item.title}
                </button>
              ))}
            </div>
          </section>}
        </aside>

        {hasMainPanel && <main className={`${compactPane === 'canvas' ? 'block' : 'hidden min-[840px]:block'} min-w-0 space-y-5`}>
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
                <h2 className="text-[12px] font-semibold uppercase" style={{ color: 'var(--color-text-tertiary)' }}>候选图</h2>
                <button type="button" onClick={() => void run()} disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium disabled:opacity-50"
                  style={buttonSubtleStyle}>
                  <IconRefresh size={13} /> 换一批
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-3">
                {images.map((img) => (
                  <div key={img.generation_id} className="overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }} data-testid="candidate-card">
                    <button type="button" className="block w-full" onClick={() => setSelectedImageId(img.generation_id)} data-testid="candidate-select">
                      <div className="relative">
                        <img src={assetUrl(img.poster_url)} alt="" className="aspect-[3/4] w-full object-cover" />
                        {intent === 'poster_text' && <CandidatePosterOverlay brief={creativeBrief} logoUrl={logoAsset?.url} qrUrl={qrAsset?.url} />}
                      </div>
                    </button>
                    <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                      <button type="button" className="text-[11px]" style={{ color: 'var(--color-brand)' }} onClick={() => void openProjectFromImage(img)}>{img.generation_id === recommendedImageId ? '建议候选 · 编辑' : '编辑'}</button>
                      <button type="button" className="text-[11px]" style={{ color: compareIds.includes(img.generation_id) ? 'var(--color-brand)' : 'var(--color-text-tertiary)' }} onClick={() => toggleCompare(img.generation_id)}>A/B</button>
                    </div>
                    {!imagePassesCandidateGate(img, intent) && <div className="px-2 pb-1.5 text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>存在检查风险，请人工比较</div>}
                  </div>
                  ))}
                </div>
              {selectedImage && (
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_120px] gap-3 rounded-md p-2" style={{ border: '1px solid var(--color-border)' }} data-testid="selected-candidate-preview">
                  <img src={assetUrl(selectedImage.poster_url)} alt="" className="max-h-[420px] w-full object-contain" />
                  <div className="flex flex-col justify-between gap-2">
                    <div>
                      <div className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>放大预览</div>
                      <div className="mt-1 text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>{selectedImage.width ?? '未知'}x{selectedImage.height ?? '未知'}</div>
                    </div>
                    <button type="button" onClick={() => void openProjectFromImage(selectedImage)} className="rounded-md px-2 py-2 text-[12px] font-medium" style={buttonPrimaryStyle} data-testid="open-selected-candidate">送入工作台</button>
                    {intent === 'poster_text' && <button type="button" onClick={() => void quickDownloadCandidate(selectedImage)} className="rounded-md px-2 py-1.5 text-[11px]" style={buttonSubtleStyle} data-testid="quick-download-candidate">下载成品</button>}
                  </div>
                </div>
              )}
              {intent === 'portrait' && selectedImage && (referenceDescriptors[0] ?? projectReferenceDescriptors[0])?.url && (
                <div className="mt-3 grid grid-cols-2 gap-3" data-testid="portrait-reference-compare">
                  <figure className="overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }}>
                    <figcaption className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>助教主照片</figcaption>
                    <img src={assetUrl((referenceDescriptors[0] ?? projectReferenceDescriptors[0])!.url!)} alt="助教主照片" className="max-h-[320px] w-full object-contain" />
                  </figure>
                  <figure className="overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }}>
                    <figcaption className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>候选结果</figcaption>
                    <img src={assetUrl(selectedImage.poster_url)} alt="候选结果" className="max-h-[320px] w-full object-contain" />
                  </figure>
                </div>
              )}
              {compareImages.length === 2 && (
                <div className="mt-3 grid grid-cols-2 gap-3" data-testid="ab-compare">
                  {compareImages.map((img, index) => (
                    <figure key={img.generation_id} className="overflow-hidden rounded-md" style={{ border: '1px solid var(--color-border)' }}>
                      <figcaption className="px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{index === 0 ? 'A' : 'B'}</figcaption>
                      <img src={assetUrl(img.poster_url)} alt="" className="max-h-[320px] w-full object-contain" />
                    </figure>
                  ))}
                </div>
              )}
            </section>
          )}

          {project && <section className="rounded-lg p-4" style={panelStyle}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-[14px] font-semibold" style={{ color: 'var(--color-text-primary)' }} data-testid="workbench-title">
                  {project ? project.title : '选择一张候选图开始编辑'}
                </h2>
                {project && <p className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{project.canvas.width}x{project.canvas.height} · {project.versions.length} 个版本 · {saveState === 'saving' ? '保存中' : saveState === 'failed' ? '保存失败' : '已保存'}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => void saveCanvas()} disabled={!project} className="rounded-md px-2 py-1 text-[12px] disabled:opacity-50" style={buttonSubtleStyle}>保存</button>
                <button type="button" onClick={() => void exportPng()} disabled={!project || busy} className="rounded-md px-2 py-1 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="export-png-button">导出 PNG</button>
              </div>
            </div>
            <div className="max-h-[70vh] overflow-auto rounded-md p-3" style={{ background: 'var(--color-surface-container)' }}>
              <canvas ref={setCanvasElement} data-testid="workbench-canvas" />
            </div>
          </section>}
          {project && <section className="border-t pt-4" style={{ borderColor: 'var(--color-border)' }} data-testid="image-quality-status">
            <div className="mb-2 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>投放检查</div>
            {reviewLines.length > 0 ? (
              <div className="space-y-1">
                {reviewLines.map((line) => (
                  <div key={line} className="rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>{line}</div>
                ))}
              </div>
            ) : (
              <div className="rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-tertiary)' }}>未自动质检</div>
            )}
            {intent === 'portrait' && project && currentVersion?.review?.portrait_quality_state !== 'user_confirmed' && (
              <button type="button" onClick={() => void confirmPortrait()} disabled={!currentVersion || currentVersion.review?.portrait_quality_state === 'blocked'} className="mt-2 w-full rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonPrimaryStyle} data-testid="confirm-portrait-button">
                像本人，可以使用
              </button>
            )}
            {intent === 'portrait' && currentVersion?.review?.portrait_quality_state === 'user_confirmed' && (
              <>
                <div className="mt-2 rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }} data-testid="portrait-user-confirmed">已由用户确认像本人</div>
                <button type="button" onClick={() => void usePortraitAsPoster()} className="mt-2 w-full rounded-md px-3 py-2 text-[12px] font-medium" style={buttonSubtleStyle} data-testid="portrait-to-poster-button">用这张照片做海报</button>
              </>
            )}
          </section>}
        </main>}

        {project && <aside className={`${compactPane === 'adjust' ? 'block' : 'hidden min-[840px]:block'} min-w-0 space-y-5 border-t pt-5 min-[840px]:col-span-2 min-[1180px]:col-span-1 min-[1180px]:border-l min-[1180px]:border-t-0 min-[1180px]:pl-6 min-[1180px]:pt-0`} style={{ borderColor: 'var(--color-border)' }}>
          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconEdit size={14} />整图指令修改</div>
            <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={3} className="w-full resize-none rounded-md px-3 py-2 text-[12.5px] outline-none" style={inputStyle} placeholder="例如:背景换成球房实景，整体更高级" data-testid="whole-edit-input" />
            <button type="button" onClick={() => void wholeEdit()} disabled={!project || !editText.trim() || busy} className="mt-2 w-full rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonPrimaryStyle} data-testid="whole-edit-button">生成修改版本</button>
          </section>

          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconTarget size={14} />局部重绘</div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['select', 'rect', 'brush'] as MaskMode[]).map((mode) => (
                <Tooltip key={mode} label={mode === 'select' ? '选择/编辑文字' : mode === 'rect' ? '矩形选区' : '涂抹笔刷'}>
                  <button type="button" onClick={() => setMaskMode(mode)} className="rounded-md px-2 py-1 text-[12px]" style={segStyle(maskMode === mode)}>
                    {mode === 'select' ? '选择' : mode === 'rect' ? '矩形' : '笔刷'}
                  </button>
                </Tooltip>
              ))}
            </div>
            <label className="mt-2 block text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>笔刷 {brushSize}px</label>
            <input type="range" min={16} max={180} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-full" />
            <textarea value={maskText} onChange={(e) => setMaskText(e.target.value)} rows={3} className="mt-2 w-full resize-none rounded-md px-3 py-2 text-[12.5px] outline-none" style={inputStyle} placeholder="例如:把选区里的桌布换成墨绿色" data-testid="inpaint-input" />
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void inpaint()} disabled={!project || !maskText.trim() || maskItems.length === 0 || busy} className="flex-1 rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonPrimaryStyle} data-testid="inpaint-button">局部重绘</button>
              <button type="button" onClick={clearMask} disabled={maskItems.length === 0} className="rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle}>清除</button>
            </div>
          </section>

          <section className="border-b pb-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconPlus size={14} />中文文字层</div>
            <div className="mb-2 grid grid-cols-4 gap-1.5">
              <button type="button" onClick={addText} disabled={!project} className="rounded-md px-2 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonSubtleStyle} data-testid="add-text-button">添加</button>
              <button type="button" onClick={undoText} disabled={!canUndoText} className="rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="text-undo-button">撤销</button>
              <button type="button" onClick={redoText} disabled={!canRedoText} className="rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="text-redo-button">重做</button>
              <button type="button" onClick={deleteActiveText} disabled={!activeTextId} className="inline-flex items-center justify-center rounded-md px-2 py-2 text-[12px] disabled:opacity-50" style={buttonSubtleStyle} data-testid="delete-text-button"><IconTrash size={13} /></button>
            </div>
            <input value={textValue} onChange={(e) => { setTextValue(e.target.value); applyTextPatch({ text: e.target.value }) }} disabled={!activeTextId} className="w-full rounded-md px-3 py-2 text-[12.5px] outline-none disabled:opacity-50" style={inputStyle} placeholder="选中文字层后编辑" />
            <div className="mt-2 grid grid-cols-[1fr_76px] gap-2">
              <input type="color" value={normalizeColorInput(textColor)} onChange={(e) => { setTextColor(e.target.value); applyTextPatch({ fill: e.target.value }) }} disabled={!activeTextId} className="h-9 w-full rounded-md" />
              <input type="number" value={textSize} min={12} max={512} onChange={(e) => { const next = Number(e.target.value); setTextSize(next); applyTextPatch({ fontSize: next }) }} disabled={!activeTextId} className="rounded-md px-2 text-[12px] outline-none disabled:opacity-50" style={inputStyle} />
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {(['left', 'center', 'right', 'justify'] as ImageWorkbenchTextLayer['text_align'][]).map((align) => (
                <button key={align} type="button" onClick={() => { setTextAlign(align); applyTextPatch({ textAlign: align }) }} disabled={!activeTextId}
                  className="rounded-md px-2 py-1.5 text-[12px] disabled:opacity-50" style={segStyle(textAlign === align)} data-testid={`text-align-${align}`}>
                  {align === 'left' ? '左' : align === 'right' ? '右' : align === 'justify' ? '撑' : '中'}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-[1fr_76px] gap-2">
              <input type="color" value={normalizeColorInput(strokeColor)} onChange={(e) => { setStrokeColor(e.target.value); applyTextPatch({ stroke: e.target.value }) }} disabled={!activeTextId} className="h-9 w-full rounded-md" />
              <input type="number" value={strokeWidth} min={0} max={64} onChange={(e) => { const next = Number(e.target.value); setStrokeWidth(next); applyTextPatch({ strokeWidth: next }) }} disabled={!activeTextId} className="rounded-md px-2 text-[12px] outline-none disabled:opacity-50" style={inputStyle} />
            </div>
          </section>

          <section className="pb-1">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--color-text-secondary)' }}><IconZap size={14} />版本与素材</div>
            <div className="max-h-[180px] space-y-1 overflow-auto">
              {project?.versions.slice().reverse().map((version) => (
                <button key={version.id} type="button" onClick={() => void workbenchApi.rollback(project.project_id, version.id).then(refreshProject).catch((err) => toast(err instanceof Error ? err.message : '回滚失败'))}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12px]" style={segStyle(version.id === project.current_version_id)} data-testid="version-item">
                  <span className="truncate">{version.kind}</span>
                  {version.id === project.current_version_id && <IconCheckCircle size={13} />}
                </button>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => void upscale()} disabled={!project || busy} className="rounded-md px-2 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonSubtleStyle}>放大 4x</button>
              <button type="button" onClick={() => void saveToLibrary()} disabled={!project} className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-2 text-[12px] font-medium disabled:opacity-50" style={buttonSubtleStyle} data-testid="save-library-button"><IconShareUp size={13} />素材库</button>
            </div>
          </section>
        </aside>}
      </div>
    </div>
    </div>
  )
}

const panelStyle = {
  border: '1px solid var(--color-border)',
  background: 'var(--color-surface-container-low)',
} as const

const inputStyle = {
  background: 'var(--color-app-main)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
} as const

const buttonPrimaryStyle = {
  background: 'var(--color-brand)',
  color: 'var(--color-on-primary)',
} as const

const buttonSubtleStyle = {
  background: 'var(--color-surface-container)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
} as const

function defaultReferenceRole(intent: ImageIntent, index: number): ImageReferenceRole {
  if (intent === 'portrait') return index === 0 ? 'identity_primary' : 'identity_supporting'
  return 'environment_reference'
}

async function waitForFonts(timeoutMs = 2_000): Promise<void> {
  const ready = document.fonts?.ready
  if (!ready) return
  await Promise.race([ready, new Promise<void>(resolve => window.setTimeout(resolve, timeoutMs))])
}

function candidateField(image: StudioImage, key: string): unknown {
  return (image as Record<string, unknown>)[key]
}

function imagePassesCandidateGate(image: StudioImage, intent: ImageIntent): boolean {
  if (intent === 'portrait') {
    return image.portrait_quality_state === 'recommended' && image.portrait_consistency_status !== 'drifted'
  }
  return candidateField(image, 'poster_hard_gate_passed') === true
}

function portraitCandidateHasHardRisk(image: StudioImage): boolean {
  const state = image.portrait_quality_state
  return state === 'blocked' || state === 'risk' || image.portrait_consistency_status === 'drifted'
}

function chooseThreeCandidates(images: StudioImage[], intent: ImageIntent): StudioImage[] {
  return images
    .slice()
    .sort((left, right) => Number(imagePassesCandidateGate(right, intent)) - Number(imagePassesCandidateGate(left, intent)))
    .slice(0, 3)
}

function CandidatePosterOverlay(props: { brief: ImageCreativeBrief | null; logoUrl?: string; qrUrl?: string }) {
  const poster = props.brief?.poster
  const lines = [poster?.title, poster?.offer, poster?.price, [poster?.date, poster?.time].filter(Boolean).join(' '), poster?.phone].filter((line): line is string => Boolean(line?.trim()))
  if (!lines.length && !props.logoUrl && !props.qrUrl) return null
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2 text-center" aria-hidden="true">
      <div className="flex justify-between gap-2">
        {props.logoUrl ? <img src={assetUrl(props.logoUrl)} alt="" className="h-7 w-7 object-contain" /> : <span />}
        {props.qrUrl ? <img src={assetUrl(props.qrUrl)} alt="" className="h-8 w-8 bg-white p-0.5 object-contain" /> : null}
      </div>
      <div className="space-y-0.5 rounded bg-black/55 px-1 py-1 text-white">
        {lines.slice(0, 5).map((line, index) => <div key={`${index}-${line}`} className={index === 0 ? 'text-[12px] font-semibold' : 'text-[9px]'}>{line}</div>)}
      </div>
    </div>
  )
}

async function uploadWorkbenchImage(file: File): Promise<ImageWorkbenchAsset> {
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) throw new Error('请上传 PNG、JPEG 或 WebP 图片')
  if (file.size > 32 * 1024 * 1024) throw new Error('图片不能超过 32MB')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onerror = () => reject(new Error('图片无法解码'))
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.src = dataUrl
  })
  return await workbenchApi.uploadAsset({
    kind: 'reference',
    data_url: dataUrl,
    filename: file.name,
    width: dimensions.width,
    height: dimensions.height,
  })
}

function segStyle(active: boolean) {
  return {
    background: active ? 'var(--color-brand)' : 'var(--color-surface-container)',
    color: active ? 'var(--color-on-primary)' : 'var(--color-text-secondary)',
    border: `1px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
  } as const
}

function dimensionFromRatio(value: string): { width: number; height: number } {
  const [a, b] = value.split(':').map((part) => Number(part))
  if (!a || !b) return { width: 1024, height: 1365 }
  const long = 1365
  if (a >= b) return { width: long, height: Math.max(512, Math.round(long * b / a)) }
  return { width: Math.max(512, Math.round(long * a / b)), height: long }
}

function posterTextLayers(width: number, height: number, fields: { title: string; offer: string; price: string; date: string; phone: string }): ImageWorkbenchTextLayer[] {
  const entries = [
    { key: 'title', text: fields.title, y: 0.14, size: Math.max(42, Math.round(width / 13)) },
    { key: 'offer', text: fields.offer, y: 0.28, size: Math.max(28, Math.round(width / 24)) },
    { key: 'price', text: fields.price, y: 0.68, size: Math.max(44, Math.round(width / 12)) },
    { key: 'date', text: fields.date, y: 0.78, size: Math.max(24, Math.round(width / 30)) },
    { key: 'phone', text: fields.phone, y: 0.86, size: Math.max(22, Math.round(width / 34)) },
  ]
  return entries.filter(item => item.text.trim()).map((item, index) => ({
    id: `poster_${item.key}_${index}`,
    type: 'text' as const,
    text: item.text.trim(),
    x: width * 0.1,
    y: height * item.y,
    width: width * 0.72,
    scale_x: 1,
    scale_y: 1,
    angle: 0,
    fill: '#ffffff',
    font_family: 'PingFang SC',
    font_size: item.size,
    text_align: 'center' as const,
    stroke: '#111111',
    stroke_width: 1,
    opacity: 1,
  }))
}

async function hydrateCanvas(canvas: Canvas, project: ImageWorkbenchProject, version: ImageWorkbenchVersion): Promise<void> {
  canvas.clear()
  canvas.setDimensions({ width: project.canvas.width, height: project.canvas.height })
  const img = await FabricImage.fromURL(assetUrl(version.image_url), { crossOrigin: 'anonymous' })
  const imgWidth = Number(img.width || project.canvas.width)
  const imgHeight = Number(img.height || project.canvas.height)
  img.set({
    left: 0,
    top: 0,
    scaleX: project.canvas.width / imgWidth,
    scaleY: project.canvas.height / imgHeight,
    selectable: false,
    evented: false,
    objectCaching: false,
  })
  ;(img as WorkbenchObject).backgroundRole = true
  canvas.add(img)
  for (const layer of project.canvas.image_layers ?? []) {
    if (!layer.url) continue
    const layerImage = await FabricImage.fromURL(assetUrl(layer.url), { crossOrigin: 'anonymous' })
    const sourceWidth = Number(layerImage.width || layer.width)
    const sourceHeight = Number(layerImage.height || layer.height)
    layerImage.set({
      left: layer.x,
      top: layer.y,
      scaleX: layer.width / sourceWidth * layer.scale_x,
      scaleY: layer.height / sourceHeight * layer.scale_y,
      angle: layer.angle,
      selectable: !layer.locked,
      evented: !layer.locked,
      objectCaching: false,
    })
    const custom = layerImage as WorkbenchObject
    custom.imageLayerId = layer.id
    custom.imageLayerType = layer.type
    custom.workbenchLayerUrl = layer.url
    canvas.add(layerImage)
  }
  for (const layer of project.canvas.text_layers) canvas.add(textLayerToFabric(layer))
  canvas.requestRenderAll()
}

function textLayerToFabric(layer: ImageWorkbenchTextLayer): Textbox {
  const box = new Textbox(layer.text, {
    left: layer.x,
    top: layer.y,
    width: layer.width,
    height: layer.height,
    scaleX: layer.scale_x,
    scaleY: layer.scale_y,
    angle: layer.angle,
    fill: layer.fill,
    fontFamily: layer.font_family,
    fontSize: layer.font_size,
    fontWeight: layer.font_weight,
    // Fabric's text metrics call toLowerCase() on fontStyle during export.
    // Old projects legitimately omit the optional persisted value.
    fontStyle: fabricFontStyle(layer.font_style) ?? 'normal',
    textAlign: layer.text_align,
    stroke: layer.stroke,
    strokeWidth: layer.stroke_width,
    opacity: layer.opacity,
    objectCaching: false,
  }) as Textbox & { workbenchLayerId?: string }
  box.workbenchLayerId = layer.id
  return box
}

function extractTextLayers(canvas: Canvas): ImageWorkbenchTextLayer[] {
  return canvas.getObjects()
    .filter((obj): obj is Textbox & { workbenchLayerId?: string } => obj instanceof Textbox)
    .map((obj) => ({
      id: obj.workbenchLayerId ?? `text_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type: 'text',
      text: obj.text ?? '',
      x: Number(obj.left ?? 0),
      y: Number(obj.top ?? 0),
      width: Number(obj.width ?? 0) || undefined,
      height: Number(obj.height ?? 0) || undefined,
      scale_x: Number(obj.scaleX ?? 1),
      scale_y: Number(obj.scaleY ?? 1),
      angle: Number(obj.angle ?? 0),
      fill: String(obj.fill ?? '#111111'),
      font_family: String(obj.fontFamily ?? 'PingFang SC'),
      font_size: Number(obj.fontSize ?? 64),
      font_weight: typeof obj.fontWeight === 'string' || typeof obj.fontWeight === 'number' ? String(obj.fontWeight) : undefined,
      font_style: typeof obj.fontStyle === 'string' ? obj.fontStyle : undefined,
      text_align: textAlignFrom(obj.textAlign),
      stroke: typeof obj.stroke === 'string' ? obj.stroke : undefined,
      stroke_width: Number(obj.strokeWidth ?? 0),
      opacity: Number(obj.opacity ?? 1),
    }))
}

function extractImageLayers(canvas: Canvas): ImageWorkbenchImageLayer[] {
  return canvas.getObjects()
    .filter((obj): obj is FabricImage & WorkbenchObject => Boolean((obj as WorkbenchObject).imageLayerId && obj instanceof FabricImage))
    .map((obj) => ({
      id: obj.imageLayerId!,
      type: obj.imageLayerType ?? 'reference_image',
      asset_id: obj.imageLayerId!.replace(/^layer_/, ''),
      url: obj.workbenchLayerUrl,
      x: Number(obj.left ?? 0),
      y: Number(obj.top ?? 0),
      width: Number(obj.width ?? 0) * Number(obj.scaleX ?? 1),
      height: Number(obj.height ?? 0) * Number(obj.scaleY ?? 1),
      scale_x: 1,
      scale_y: 1,
      angle: Number(obj.angle ?? 0),
      locked: obj.selectable !== true,
      visible: obj.visible !== false,
    }))
}

function textAlignFrom(value: unknown): ImageWorkbenchTextLayer['text_align'] {
  return value === 'left' || value === 'right' || value === 'justify' ? value : 'center'
}

function fabricFontStyle(value: string | undefined): 'normal' | 'italic' | 'oblique' | undefined {
  return value === 'normal' || value === 'italic' || value === 'oblique' ? value : undefined
}

function maskObjectOptions<T extends Record<string, unknown>>(options: T): T & { selectable: false; evented: false; excludeFromExport: true; maskRole: true } {
  return { ...options, selectable: false, evented: false, excludeFromExport: true, maskRole: true }
}

function pathFromPoints(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

function maskDataUrl(width: number, height: number, items: MaskItem[]): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建蒙版画布')
  ctx.fillStyle = 'rgba(0,0,0,1)'
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'destination-out'
  for (const item of items) {
    if (item.type === 'rect') {
      ctx.fillRect(item.x, item.y, item.width, item.height)
    } else {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = item.size
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.beginPath()
      item.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.stroke()
    }
  }
  return canvas.toDataURL('image/png')
}

function exportCanvasPng(canvas: Canvas): string {
  const masked = canvas.getObjects().filter((obj) => (obj as WorkbenchObject).maskRole)
  masked.forEach((obj) => obj.set('visible', false))
  canvas.requestRenderAll()
  const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 1, enableRetinaScaling: false })
  masked.forEach((obj) => obj.set('visible', true))
  canvas.requestRenderAll()
  return dataUrl
}

function sourceForEdit(version: ImageWorkbenchVersion, description: string, intent: 'edit_content' | 'inpaint', quality: ImageQuality) {
  return {
    // A persisted workbench version always has a local upload URL. Prefer it
    // over the ephemeral generation index so reopened/exported projects edit
    // the exact version the user selected.
    source_image_path: version.image_url,
    description,
    ratio: version.ratio,
    intent,
    quality,
  }
}

function sourceForUpscale(version: ImageWorkbenchVersion): { source_generation_id?: string; source_image_path?: string; scale: 4 } {
  return {
    source_image_path: version.image_url,
    scale: 4,
  }
}

async function addImageVersionFromJob(
  project: ImageWorkbenchProject,
  parent: ImageWorkbenchVersion,
  job: { status: string; id: string; result?: Record<string, unknown>; error?: string | null },
  kind: Extract<ImageWorkbenchVersion['kind'], 'edit' | 'inpaint' | 'upscale'>,
  instruction: string,
  mask?: ImageWorkbenchAsset,
): Promise<ImageWorkbenchProject> {
  const result = job.result ?? {}
  if (job.status !== 'done') throw new Error(String(result.message ?? job.error ?? '图片任务失败'))
  if (result.blocked) throw new Error(String(result.message ?? '组件正在准备'))
  const img = Array.isArray(result.images) ? result.images[0] as StudioImage | undefined : undefined
  const url = img?.poster_url ?? pickImageUrl(result)
  if (!url) throw new Error('任务完成但没有返回图片')
  return await workbenchApi.addVersion(project.project_id, {
    parent_version_id: parent.id,
    kind,
    image_url: url,
    generation_id: img?.generation_id ?? (typeof result.generation_id === 'string' ? result.generation_id : undefined),
    width: img?.width ?? parent.width,
    height: img?.height ?? parent.height,
    ratio: img?.ratio ?? parent.ratio,
    instruction,
    job_id: job.id,
    mask: mask ? { asset_id: mask.asset_id, url: mask.url, width: mask.width, height: mask.height, mode: 'alpha_transparent_edit' } : undefined,
    review: reviewFromRecord({ ...result, ...(img ?? {}) }),
    set_current: true,
  })
}

function normalizeColorInput(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'
}

function themedColor(token: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const probe = document.createElement('span')
  probe.style.color = `var(${token})`
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color || fallback
}

function withAlpha(color: string, alpha: number): string {
  const parts = color.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const [r, g, b] = parts
  if (r === undefined || g === undefined || b === undefined) return color
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function textLayerSnapshot(canvas: Canvas): string {
  return JSON.stringify(extractTextLayers(canvas))
}

function parseTextLayerSnapshot(snapshot: string): ImageWorkbenchTextLayer[] {
  try {
    const parsed = JSON.parse(snapshot) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ImageWorkbenchTextLayer => !!item && typeof item === 'object' && (item as { type?: unknown }).type === 'text')
  } catch {
    return []
  }
}

function reviewFromRecord(record: Record<string, unknown>): ImageWorkbenchReview {
  const review: ImageWorkbenchReview = { portrait_user_confirmed: false }
  const textStatus = stringField(record, 'text_quality_status')
  if (textStatus) review.text_quality_status = textStatus
  const textWarning = boolField(record, 'text_quality_warning')
  if (textWarning !== undefined) review.text_quality_warning = textWarning
  const textMessage = stringField(record, 'text_quality_warning_message')
  if (textMessage) review.text_quality_warning_message = textMessage
  const textMissing = stringArrayField(record, 'text_quality_missing')
  if (textMissing) review.text_quality_missing = textMissing
  const posterState = stringField(record, 'poster_quality_state')
  if (posterState === 'blocked' || posterState === 'risk' || posterState === 'recommended' || posterState === 'user_confirmed' || posterState === 'unchecked') review.poster_quality_state = posterState
  const posterGate = boolField(record, 'poster_hard_gate_passed')
  if (posterGate !== undefined) review.poster_hard_gate_passed = posterGate
  const posterWarnings = stringArrayField(record, 'poster_hard_gate_warnings')
  if (posterWarnings) review.poster_hard_gate_warnings = posterWarnings
  const portraitStatus = stringField(record, 'portrait_qc_status')
  if (portraitStatus) review.portrait_qc_status = portraitStatus
  const portraitChecked = boolField(record, 'portrait_qc_auto_checked')
  if (portraitChecked !== undefined) review.portrait_qc_auto_checked = portraitChecked
  const portraitQualityState = stringField(record, 'portrait_quality_state')
  if (portraitQualityState === 'blocked' || portraitQualityState === 'risk' || portraitQualityState === 'recommended' || portraitQualityState === 'user_confirmed' || portraitQualityState === 'unchecked') review.portrait_quality_state = portraitQualityState
  const consistency = stringField(record, 'portrait_consistency_status')
  if (consistency === 'preserved' || consistency === 'uncertain' || consistency === 'drifted' || consistency === 'not_checked') review.portrait_consistency_status = consistency
  const portraitConfirmed = boolField(record, 'portrait_user_confirmed')
  if (portraitConfirmed !== undefined) review.portrait_user_confirmed = portraitConfirmed
  const portraitMessage = stringField(record, 'portrait_qc_message')
  if (portraitMessage) review.portrait_qc_message = portraitMessage
  const portraitWarnings = stringArrayField(record, 'portrait_qc_warnings')
  if (portraitWarnings) review.portrait_qc_warnings = portraitWarnings
  const inputStatus = stringField(record, 'input_qc_status')
  if (inputStatus) review.input_qc_status = inputStatus
  const inputWarnings = stringArrayField(record, 'input_qc_warnings')
  if (inputWarnings) review.input_qc_warnings = inputWarnings
  const fidelity = record.input_fidelity
  if (fidelity && typeof fidelity === 'object' && !Array.isArray(fidelity)) {
    const value = fidelity as Record<string, unknown>
    const requested = stringField(value, 'input_fidelity_requested')
    const status = stringField(value, 'input_fidelity_status')
    if (requested === 'high' || requested === 'standard' || status === 'accepted' || status === 'unsupported' || status === 'unknown' || status === 'not_requested') {
      review.input_fidelity = {
        ...(requested === 'high' || requested === 'standard' ? { input_fidelity_requested: requested } : {}),
        input_fidelity_status: status === 'accepted' || status === 'unsupported' || status === 'unknown' || status === 'not_requested' ? status : 'unknown',
      }
    }
  }
  const fidelityRisk = stringField(record, 'input_fidelity_risk')
  if (fidelityRisk) review.input_fidelity_risk = fidelityRisk
  const fidelityRequested = stringField(record, 'input_fidelity_requested')
  const fidelityStatus = stringField(record, 'input_fidelity_status')
  if (fidelityRequested === 'high' || fidelityRequested === 'standard' || fidelityStatus === 'accepted' || fidelityStatus === 'unsupported' || fidelityStatus === 'unknown' || fidelityStatus === 'not_requested') {
    review.input_fidelity = {
      ...(fidelityRequested === 'high' || fidelityRequested === 'standard' ? { input_fidelity_requested: fidelityRequested } : {}),
      input_fidelity_status: fidelityStatus === 'accepted' || fidelityStatus === 'unsupported' || fidelityStatus === 'unknown' || fidelityStatus === 'not_requested' ? fidelityStatus : 'unknown',
    }
  }
  const commercialReady = boolField(record, 'commercial_ready')
  if (commercialReady !== undefined) review.commercial_ready = commercialReady
  const risks = [
    stringField(record, 'image_engine_warning'),
    ...(stringArrayField(record, 'risk_messages') ?? []),
  ].filter((item): item is string => Boolean(item))
  if (risks.length) review.risk_messages = risks
  return review
}

function imageReviewLines(review: ImageWorkbenchReview | undefined): string[] {
  if (!review || Object.keys(review).length === 0) return []
  const lines: string[] = []
  if (review.text_quality_status) {
    const suffix = review.text_quality_warning_message ? `: ${review.text_quality_warning_message}` : ''
    lines.push(`OCR/文字: ${review.text_quality_status}${suffix}`)
  }
  if (review.poster_quality_state) lines.push(`海报硬闸: ${review.poster_quality_state === 'recommended' ? '客观检查未发现明显阻断' : review.poster_quality_state === 'risk' ? '有风险，需人工复核' : '未检查'}`)
  for (const warning of review.poster_hard_gate_warnings ?? []) lines.push(`海报风险: ${warning}`)
  if (review.portrait_qc_status) {
    const suffix = review.portrait_qc_message ? `: ${review.portrait_qc_message}` : ''
    lines.push(`人物照片检查: ${review.portrait_qc_status}${suffix}`)
  }
  if (review.portrait_quality_state) {
    const labels = { blocked: '已拦截', risk: '有风险', recommended: '建议候选，等待本人确认', user_confirmed: '用户已确认像本人', unchecked: '未检查' } as const
    lines.push(`人物照片状态: ${labels[review.portrait_quality_state]}`)
  }
  if (review.portrait_consistency_status && review.portrait_consistency_status !== 'not_checked') {
    lines.push(`参考一致性: ${review.portrait_consistency_status === 'preserved' ? '未发现明显漂移' : review.portrait_consistency_status === 'drifted' ? '疑似人物漂移' : '需要并排确认'}`)
  }
  if (review.input_qc_status) lines.push(`参考图检查: ${review.input_qc_status}`)
  if (review.input_fidelity?.input_fidelity_status === 'unsupported') lines.push('高保真图片参数: 当前端点已降级，请人工确认参考图一致性')
  else if (review.input_fidelity?.input_fidelity_status === 'unknown') lines.push('高保真图片参数: 当前端点未能确认，请人工确认参考图一致性')
  if (review.input_fidelity_risk) lines.push(`高保真风险: ${review.input_fidelity_risk}`)
  if (review.commercial_ready !== undefined) lines.push(`投放状态: ${review.commercial_ready ? '需人工终审' : '不会自动宣称可商用'}`)
  for (const warning of review.text_quality_missing ?? []) lines.push(`缺失文字: ${warning}`)
  for (const warning of review.portrait_qc_warnings ?? []) lines.push(`人物照片风险: ${warning}`)
  for (const warning of review.input_qc_warnings ?? []) lines.push(`参考图风险: ${warning}`)
  for (const warning of review.risk_messages ?? []) lines.push(`风险提示: ${warning}`)
  return lines
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boolField(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === 'boolean' ? record[key] : undefined
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return out.length ? out : undefined
}
