// 生图工作台(owner:生成图片质量估计没那么好,所以"可视化编辑台/看板"非常重要)。
// 形态照创作引擎 v2 + 竞品三段式:①描述+参数 ②一次出几张 ③网格挑一张放大看。
// 走真后端:POST /studio/generate → 轮询 media-jobs/:id → 展示 poster_url。改图/局部重绘("基于此调整")留后续。
import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '../components/shared/PageKit'
import { IconSparkles } from '../components/shared/icons'
import { toast } from '../stores/toastStore'
import { studioApi, pollJob, assetUrl, pickImageUrl, type StudioImage } from '../api/studio'

const RATIOS: { id: string; label: string }[] = [
  { id: '3:4', label: '竖版 3:4' },
  { id: '1:1', label: '方形 1:1' },
  { id: '2:3', label: '海报 2:3' },
  { id: '4:3', label: '横版 4:3' },
]
const COUNTS = [1, 2, 3, 4]

export function CreationPage() {
  const [prompt, setPrompt] = useState('')
  const [ratio, setRatio] = useState('3:4')
  const [count, setCount] = useState(2)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [images, setImages] = useState<StudioImage[]>([])
  const [enlarged, setEnlarged] = useState<StudioImage | null>(null)
  const [upscalingId, setUpscalingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editingImg, setEditingImg] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const canRun = prompt.trim().length > 0 && !busy

  // 放大(超分):本机 Real-ESRGAN,把选中图放大到印刷级高清,结果插到网格最前(非破坏,原图还在)。
  const upscale = async (img: StudioImage) => {
    if (busy || upscalingId) return
    setUpscalingId(img.generation_id)
    try {
      const { job_id } = await studioApi.upscale({ source_generation_id: img.generation_id, scale: 4 })
      const job = await pollJob(job_id, {})
      const result = job.result ?? {}
      if (job.status !== 'done') { toast(result.message || '放大失败'); return }
      if (result.blocked) { toast(result.message || '放大组件正在后台准备,稍后再试。'); return }
      const url = pickImageUrl(result)
      if (!url) { toast('放大完成但没拿到成图'); return }
      const gid = typeof result.generation_id === 'string' ? result.generation_id : `up-${img.generation_id}`
      setImages((imgs) => [{ ...img, generation_id: gid, poster_url: url }, ...imgs])
      toast('已放大到高清(可点开看大图)')
    } catch (e) {
      toast(e instanceof Error ? e.message : '放大失败')
    } finally { setUpscalingId(null) }
  }

  // 改这张(整图按指令调整;局部重绘的"框选改"要 canvas 蒙版 UI,后续接)。改好的新图非破坏插到最前。
  const editImg = async (img: StudioImage) => {
    const desc = editText.trim()
    if (!desc || editingImg) return
    setEditingImg(true)
    try {
      const { job_id } = await studioApi.edit({ source_generation_id: img.generation_id, description: desc })
      const job = await pollJob(job_id, {})
      const result = job.result ?? {}
      if (job.status !== 'done') { toast(result.message || '改图失败'); return }
      if (result.blocked) { toast(result.message || '组件正在准备,稍后再试。'); return }
      const newImg = result.images?.[0]
      const url = newImg?.poster_url ?? pickImageUrl(result)
      if (!url) { toast('改图完成但没拿到成图'); return }
      const added: StudioImage = { generation_id: newImg?.generation_id ?? `edit-${img.generation_id}`, poster_url: url }
      setImages((imgs) => [added, ...imgs])
      setEnlarged(added); setEditText('')
      toast('已按你的要求改好(新图在最前)')
    } catch (e) {
      toast(e instanceof Error ? e.message : '改图失败')
    } finally { setEditingImg(false) }
  }

  const run = async () => {
    if (!canRun) return
    setBusy(true); setProgress(0); setStage('正在提交…'); setImages([])
    const ctrl = new AbortController(); abortRef.current = ctrl
    try {
      const { job_id } = await studioApi.generate({ prompt: prompt.trim(), ratio, count })
      const job = await pollJob(job_id, { signal: ctrl.signal, onProgress: (p, s) => { setProgress(p); if (s) setStage(s) } })
      const result = job.result ?? {}
      if (job.status !== 'done') { toast(result.message || job.error || '生成失败'); return }
      if (result.blocked) { toast(result.message || '所需组件正在后台准备,稍后再试。'); return }
      const imgs = result.images ?? []
      if (!imgs.length) { toast('没有生成图片,换个描述再试试?'); return }
      setImages(imgs)
    } catch (e) {
      if (!ctrl.signal.aborted) toast(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false); setStage(''); abortRef.current = null
    }
  }

  const pill = (active: boolean) =>
    ({
      background: active ? 'var(--color-brand)' : 'var(--color-surface-container-low)',
      color: active ? '#fff' : 'var(--color-text-secondary)',
      border: `1px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
    }) as const

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="creation-page">
      <div className="mx-auto w-full max-w-[900px] px-8 py-8">
        <PageHeader title="生图工作台" subtitle="描述你要的图,一次出几张,挑中意的。精确文字/二维码建议在描述里写清。" />

        {/* 描述 + 参数 */}
        <div className="rounded-xl p-4" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="例如:台球室开业活动海报,霓虹蓝紫色调,标题「盛大开业 全场5折」,电话 138xxxx8888,竖版"
            rows={3}
            className="w-full resize-none rounded-lg px-3 py-2.5 text-[13.5px] outline-none"
            style={{ background: 'var(--color-app-main)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>比例</span>
            {RATIOS.map((r) => (
              <button key={r.id} type="button" onClick={() => setRatio(r.id)}
                className="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors" style={pill(ratio === r.id)}>
                {r.label}
              </button>
            ))}
            <span className="ml-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>数量</span>
            {COUNTS.map((c) => (
              <button key={c} type="button" onClick={() => setCount(c)}
                className="h-7 w-7 rounded-md text-[12px] font-medium transition-colors" style={pill(count === c)}>
                {c}
              </button>
            ))}
            <div className="ml-auto">
              <button type="button" onClick={() => void run()} disabled={!canRun}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-50"
                style={{ background: 'var(--color-brand)', color: '#fff' }}>
                <IconSparkles size={15} /> {busy ? '生成中…' : '生成'}
              </button>
            </div>
          </div>
        </div>

        {/* 进度 */}
        {busy && (
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
              <span>{stage || '正在生成…'}</span><span>{progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--color-surface-container)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(4, progress)}%`, background: 'var(--color-brand)' }} />
            </div>
          </div>
        )}

        {/* 结果网格 */}
        {images.length > 0 && (
          <>
            <h2 className="mb-2.5 mt-8 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              出图 · 点开看大图
            </h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {images.map((img) => (
                <div key={img.generation_id} className="group relative overflow-hidden rounded-xl" style={{ border: '1px solid var(--color-border)' }}>
                  <img src={assetUrl(img.poster_url)} alt="" className="block h-auto w-full cursor-zoom-in transition-transform group-hover:scale-[1.01]" loading="lazy" onClick={() => setEnlarged(img)} />
                  <button type="button" onClick={() => void upscale(img)} disabled={busy || upscalingId !== null}
                    className="absolute bottom-2 right-2 rounded-md px-2 py-1 text-[11px] font-medium opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60"
                    style={{ background: 'rgba(0,0,0,0.62)', color: '#fff' }}>
                    {upscalingId === img.generation_id ? '放大中…' : '放大 4×'}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 空态 */}
        {!busy && images.length === 0 && (
          <div className="mt-10 flex flex-col items-center gap-2 py-12 text-center">
            <IconSparkles size={28} />
            <p className="text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>写下你要的图,点「生成」。出图后在这里挑。</p>
          </div>
        )}
      </div>

      {/* 放大看 + 「改这张」编辑栏 lightbox */}
      {enlarged && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 p-8" style={{ background: 'rgba(0,0,0,0.8)' }} onClick={() => { setEnlarged(null); setEditText('') }}>
          <img src={assetUrl(enlarged.poster_url)} alt="" className="max-h-[74vh] max-w-full rounded-lg" style={{ objectFit: 'contain' }} onClick={(e) => e.stopPropagation()} />
          <div className="flex w-full max-w-[560px] items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <input
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void editImg(enlarged) }}
              placeholder="想怎么改?如「背景换成球房实景」「标题改成开业大促」「去掉左下角文字」"
              className="flex-1 rounded-lg px-3 py-2 text-[13px] outline-none"
              style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.22)' }}
            />
            <button type="button" onClick={() => void editImg(enlarged)} disabled={editingImg || !editText.trim()}
              className="rounded-lg px-4 py-2 text-[13px] font-medium disabled:opacity-50" style={{ background: 'var(--color-brand)', color: '#fff' }}>
              {editingImg ? '改中…' : '改这张'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
