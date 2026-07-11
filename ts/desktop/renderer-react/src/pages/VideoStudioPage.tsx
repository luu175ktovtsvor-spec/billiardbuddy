// 剪视频看板(owner:剪视频提供可视化看板)。两条线:B 线引擎干帧级活,这里是 A 线可视化壳。
// 流程 = 导入素材 → 选剪法(口播/氛围/自动)+比例+时长 → 出方案(auto_plan→planEdit 真五步)→ 看方案 → 出片预览。
// v1 导入用粘贴绝对路径(原生文件选择器后续接);出片依赖 ffmpeg/whisper 资产,未就绪会提示"正在准备组件"。
import { useRef, useState } from 'react'
import { PageHeader } from '../components/shared/PageKit'
import { IconSparkles } from '../components/shared/icons'
import { toast } from '../stores/toastStore'
import { pollJob, assetUrl } from '../api/studio'
import { videoApi, pickVideoUrl, type VideoPlanResult } from '../api/video'

const MODES: { id: 'auto' | 'speech' | 'ambient'; label: string }[] = [
  { id: 'auto', label: '自动判' },
  { id: 'speech', label: '口播' },
  { id: 'ambient', label: '环境/氛围' },
]
const RATIOS: { id: string; label: string }[] = [
  { id: '9:16', label: '竖 9:16' },
  { id: '1:1', label: '方 1:1' },
  { id: '16:9', label: '横 16:9' },
  { id: '', label: '原片' },
]

export function VideoStudioPage() {
  const [pathsText, setPathsText] = useState('')
  const [mode, setMode] = useState<'auto' | 'speech' | 'ambient'>('auto')
  const [ratio, setRatio] = useState('9:16')
  const [duration, setDuration] = useState(16)
  const [busy, setBusy] = useState<'' | 'plan' | 'render'>('')
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [plan, setPlan] = useState<VideoPlanResult | null>(null)
  const [project, setProject] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const paths = pathsText.split('\n').map((s) => s.trim()).filter(Boolean)
  const canPlan = paths.length > 0 && !busy

  const doPlan = async () => {
    if (!canPlan) return
    setBusy('plan'); setProgress(0); setStage('正在读素材…'); setPlan(null); setProject(''); setVideoUrl('')
    const ctrl = new AbortController(); abortRef.current = ctrl
    try {
      const start = await videoApi.autoPlan({ video_paths: paths, mode: mode === 'auto' ? undefined : mode, ratio: ratio || undefined, target_duration: duration })
      const job = await pollJob(start.job_id, { signal: ctrl.signal, onProgress: (p, s) => { setProgress(p); if (s) setStage(s) } })
      const result = (job.result ?? {}) as VideoPlanResult
      if (job.status !== 'done') { toast(result.message || job.error || '出方案失败'); return }
      if (result.blocked) { toast(result.message || '所需组件正在后台准备,稍后再试。'); return }
      setPlan(result)
      setProject(result.project ?? start.project ?? '')
    } catch (e) {
      if (!ctrl.signal.aborted) toast(e instanceof Error ? e.message : '出方案失败')
    } finally { setBusy(''); setStage('') }
  }

  const doRender = async (preview: boolean) => {
    if (!project || busy) return
    setBusy('render'); setProgress(0); setStage('正在出片…'); setVideoUrl('')
    const ctrl = new AbortController(); abortRef.current = ctrl
    try {
      const start = await videoApi.render(project, preview)
      const job = await pollJob(start.job_id, { signal: ctrl.signal, onProgress: (p, s) => { setProgress(p); if (s) setStage(s) } })
      const result = job.result ?? {}
      if (job.status !== 'done') { toast((result as { message?: string }).message || job.error || '出片失败'); return }
      if ((result as { blocked?: boolean }).blocked) { toast((result as { message?: string }).message || '所需组件正在后台准备。'); return }
      const url = pickVideoUrl(result)
      if (!url) { toast('出片完成但没拿到成片地址'); return }
      setVideoUrl(assetUrl(url))
    } catch (e) {
      if (!ctrl.signal.aborted) toast(e instanceof Error ? e.message : '出片失败')
    } finally { setBusy(''); setStage('') }
  }

  const pill = (active: boolean) =>
    ({
      background: active ? 'var(--color-brand)' : 'var(--color-surface-container-low)',
      color: active ? '#fff' : 'var(--color-text-secondary)',
      border: `1px solid ${active ? 'var(--color-brand)' : 'var(--color-border)'}`,
    }) as const

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="video-studio-page">
      <div className="mx-auto w-full max-w-[900px] px-8 py-8">
        <PageHeader title="剪视频工作台" subtitle="导入拍好的视频 → 选剪法出方案 → 满意再出片。口播自动配字幕,环境片走视觉挑镜+卡点。" />

        {/* 导入 + 参数 */}
        <div className="rounded-xl p-4" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }}>
          <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>视频素材(每行一个本机绝对路径)</label>
          <textarea
            value={pathsText}
            onChange={(e) => setPathsText(e.target.value)}
            placeholder={'/Users/…/门店视频1.mp4\n/Users/…/门店视频2.mp4'}
            rows={3}
            className="w-full resize-none rounded-lg px-3 py-2.5 text-[12.5px] outline-none"
            style={{ background: 'var(--color-app-main)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', fontFamily: 'var(--font-mono)' }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>剪法</span>
            {MODES.map((m) => (
              <button key={m.id} type="button" onClick={() => setMode(m.id)} className="rounded-md px-2.5 py-1 text-[12px] font-medium" style={pill(mode === m.id)}>{m.label}</button>
            ))}
            <span className="ml-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>比例</span>
            {RATIOS.map((r) => (
              <button key={r.id || 'orig'} type="button" onClick={() => setRatio(r.id)} className="rounded-md px-2.5 py-1 text-[12px] font-medium" style={pill(ratio === r.id)}>{r.label}</button>
            ))}
            <span className="ml-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>时长</span>
            <input type="number" min={3} max={180} value={duration} onChange={(e) => setDuration(Math.max(3, Math.min(180, Number(e.target.value) || 16)))}
              className="h-7 w-16 rounded-md px-2 text-[12px] outline-none" style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }} />
            <span className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>秒</span>
            <div className="ml-auto">
              <button type="button" onClick={() => void doPlan()} disabled={!canPlan}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-50"
                style={{ background: 'var(--color-brand)', color: '#fff' }}>
                <IconSparkles size={15} /> {busy === 'plan' ? '出方案中…' : '出方案'}
              </button>
            </div>
          </div>
        </div>

        {/* 进度 */}
        {busy && (
          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
              <span>{stage || '处理中…'}</span><span>{progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--color-surface-container)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(4, progress)}%`, background: 'var(--color-brand)' }} />
            </div>
          </div>
        )}

        {/* 方案 */}
        {plan && (
          <div className="mt-6 rounded-xl p-4" style={{ border: '1px solid var(--color-border)' }}>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-md px-2 py-0.5 text-[11.5px] font-medium" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
                {plan.route === 'speech' ? '口播路' : plan.route === 'broll' ? '环境/氛围路' : '方案'}
              </span>
              {plan.used_vlm && <span className="text-[11.5px]" style={{ color: 'var(--color-success)' }}>已用视觉看懂画面</span>}
              {typeof plan.candidates?.length === 'number' && <span className="text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{plan.candidates.length} 段素材</span>}
            </div>
            <p className="text-[13px] leading-relaxed" style={{ color: 'var(--color-text-primary)' }}>{plan.report || '方案已生成。'}</p>
            {plan.footage_warnings && plan.footage_warnings.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                {plan.footage_warnings.slice(0, 4).map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => void doRender(true)} disabled={!!busy}
                className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
                style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
                {busy === 'render' ? '出片中…' : '快速预览'}
              </button>
              <button type="button" onClick={() => void doRender(false)} disabled={!!busy}
                className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
                style={{ background: 'var(--color-brand)', color: '#fff' }}>
                出成片
              </button>
            </div>
          </div>
        )}

        {/* 成片预览 */}
        {videoUrl && (
          <div className="mt-6">
            <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>成片预览</h2>
            <video src={videoUrl} controls className="w-full rounded-xl" style={{ border: '1px solid var(--color-border)', maxHeight: 520 }} />
          </div>
        )}

        {/* 空态 */}
        {!busy && !plan && !videoUrl && (
          <div className="mt-10 flex flex-col items-center gap-2 py-12 text-center">
            <IconSparkles size={28} />
            <p className="text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>粘贴你拍的视频路径,选好剪法,点「出方案」。</p>
          </div>
        )}
      </div>
    </div>
  )
}
