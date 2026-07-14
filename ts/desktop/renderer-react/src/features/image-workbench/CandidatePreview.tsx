// 候选图预览卡：底图 + 海报固定文字与品牌图层的叠加示意。

import { assetUrl, type ImageCreativeBrief, type ImageIntent, type StudioImage } from '../../api/studio'

export function CandidatePreview(props: {
  image: StudioImage
  intent: ImageIntent
  brief: ImageCreativeBrief | null
  logoUrl?: string
  qrUrl?: string
  compact?: boolean
}) {
  const compact = props.compact !== false
  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden ${compact ? 'aspect-[3/4]' : 'min-h-[180px]'}`}
      style={{ background: 'var(--color-surface-container-low)' }}
    >
      <img
        src={assetUrl(props.image.poster_url)}
        alt=""
        className={compact ? 'max-h-full max-w-full object-contain' : 'max-h-[420px] w-full object-contain'}
      />
      {props.intent === 'poster_text' && <CandidatePosterOverlay brief={props.brief} logoUrl={props.logoUrl} qrUrl={props.qrUrl} />}
    </div>
  )
}

function CandidatePosterOverlay(props: { brief: ImageCreativeBrief | null; logoUrl?: string; qrUrl?: string }) {
  const poster = props.brief?.poster
  const lines = [
    poster?.title,
    poster?.offer,
    poster?.price,
    [poster?.date, poster?.time].filter(Boolean).join(' '),
    poster?.address,
    poster?.phone,
    poster?.cta,
  ].filter((line): line is string => Boolean(line?.trim()))
  if (!lines.length && !props.logoUrl && !props.qrUrl) return null
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2 text-center" aria-hidden="true">
      <div className="flex justify-between gap-2">
        {props.logoUrl ? <img src={assetUrl(props.logoUrl)} alt="" className="h-7 w-7 object-contain" /> : <span />}
        {props.qrUrl ? <img src={assetUrl(props.qrUrl)} alt="" className="h-8 w-8 bg-white p-0.5 object-contain" /> : null}
      </div>
      <div className="space-y-0.5 rounded bg-black/55 px-1 py-1 text-white">
        {lines.slice(0, 7).map((line, index) => <div key={`${index}-${line}`} className={index === 0 ? 'text-[12px] font-semibold' : 'text-[9px]'}>{line}</div>)}
      </div>
    </div>
  )
}
