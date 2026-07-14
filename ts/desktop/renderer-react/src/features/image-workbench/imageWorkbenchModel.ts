// 生图工作台纯业务规则：候选闸门、海报固定图层、编辑请求参数和面向用户的文案归一。
// 只放无 DOM、无 fabric、无网络依赖的纯函数，保持可直接单测。

import type {
  ImageIntent,
  ImageQuality,
  ImageReferenceRole,
  ImageWorkbenchAsset,
  ImageWorkbenchImageLayer,
  ImageWorkbenchReview,
  ImageWorkbenchTextLayer,
  ImageWorkbenchVersion,
  StudioImage,
} from '../../api/studio'

export function defaultReferenceRole(intent: ImageIntent, index: number): ImageReferenceRole {
  if (intent === 'portrait') return index === 0 ? 'identity_primary' : 'identity_supporting'
  return 'environment_reference'
}

export function referenceRoleOptions(intent: ImageIntent): Array<{ value: ImageReferenceRole; label: string }> {
  if (intent === 'portrait') {
    return [
      { value: 'identity_primary', label: '主照片' },
      { value: 'identity_supporting', label: '补充角度' },
    ]
  }
  return [
    { value: 'environment_reference', label: '场景参考' },
    { value: 'style_reference', label: '风格参考' },
    { value: 'identity_primary', label: '人物参考' },
    { value: 'brand_reference', label: '品牌参考' },
    { value: 'source', label: '主体图片' },
  ]
}

function candidateField(image: StudioImage, key: string): unknown {
  return (image as Record<string, unknown>)[key]
}

export function imagePassesCandidateGate(image: StudioImage, intent: ImageIntent): boolean {
  if (intent === 'portrait') {
    return image.portrait_quality_state === 'recommended' && image.portrait_consistency_status === 'preserved'
  }
  return candidateField(image, 'poster_hard_gate_passed') === true
}

export function portraitCandidateHasHardRisk(image: StudioImage): boolean {
  const state = image.portrait_quality_state
  return state === 'blocked' || state === 'risk' || image.portrait_consistency_status === 'drifted'
}

export function chooseThreeCandidates(images: StudioImage[], intent: ImageIntent): StudioImage[] {
  return images
    .slice()
    .sort((left, right) => Number(imagePassesCandidateGate(right, intent)) - Number(imagePassesCandidateGate(left, intent)))
    .slice(0, 3)
}

export function versionKindLabel(kind: ImageWorkbenchVersion['kind']): string {
  return {
    generated: '初次生成',
    imported: '导入图片',
    edit: '整图修改',
    inpaint: '局部修改',
    text_export: '添加文字',
    upscale: '高清大图',
  }[kind]
}

export function dimensionFromRatio(value: string): { width: number; height: number } {
  const [a, b] = value.split(':').map((part) => Number(part))
  if (!a || !b) return { width: 1024, height: 1365 }
  const long = 1365
  if (a >= b) return { width: long, height: Math.max(512, Math.round(long * b / a)) }
  return { width: Math.max(512, Math.round(long * a / b)), height: long }
}

export function posterTextLayers(width: number, height: number, fields: { title: string; offer: string; price: string; date: string; address: string; phone: string; cta: string }): ImageWorkbenchTextLayer[] {
  const entries = [
    { key: 'title', text: fields.title, y: 0.14, size: Math.max(42, Math.round(width / 13)) },
    { key: 'offer', text: fields.offer, y: 0.28, size: Math.max(28, Math.round(width / 24)) },
    { key: 'price', text: fields.price, y: 0.62, size: Math.max(44, Math.round(width / 12)) },
    { key: 'date', text: fields.date, y: 0.74, size: Math.max(24, Math.round(width / 30)) },
    { key: 'address', text: fields.address, y: 0.80, size: Math.max(20, Math.round(width / 36)) },
    { key: 'phone', text: fields.phone, y: 0.86, size: Math.max(22, Math.round(width / 34)) },
    { key: 'cta', text: fields.cta, y: 0.92, size: Math.max(20, Math.round(width / 36)) },
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

export function posterBrandImageLayers(
  canvasWidth: number,
  canvasHeight: number,
  logo: ImageWorkbenchAsset | null,
  qrcode: ImageWorkbenchAsset | null,
): ImageWorkbenchImageLayer[] {
  const layers: ImageWorkbenchImageLayer[] = []
  if (logo) {
    const maxWidth = canvasWidth * 0.18
    const maxHeight = canvasHeight * 0.12
    const scale = Math.min(maxWidth / logo.width, maxHeight / logo.height)
    const width = logo.width * scale
    const height = logo.height * scale
    layers.push({
      id: `layer_${logo.asset_id}`,
      type: 'logo',
      asset_id: logo.asset_id,
      url: logo.url,
      x: canvasWidth * 0.04,
      y: canvasHeight * 0.04,
      width,
      height,
      scale_x: 1,
      scale_y: 1,
      angle: 0,
      locked: false,
      visible: true,
    })
  }
  if (qrcode) {
    const size = Math.min(canvasWidth * 0.16, canvasHeight * 0.16)
    layers.push({
      id: `layer_${qrcode.asset_id}`,
      type: 'qrcode',
      asset_id: qrcode.asset_id,
      url: qrcode.url,
      x: canvasWidth - size - canvasWidth * 0.04,
      y: canvasHeight - size - canvasHeight * 0.04,
      width: size,
      height: size,
      scale_x: 1,
      scale_y: 1,
      angle: 0,
      locked: false,
      visible: true,
    })
  }
  return layers
}

export function sourceForEdit(version: ImageWorkbenchVersion, description: string, intent: 'edit_content' | 'inpaint', quality: ImageQuality) {
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

export function sourceForUpscale(version: ImageWorkbenchVersion): { source_generation_id?: string; source_image_path?: string; scale: 4 } {
  return {
    source_image_path: version.image_url,
    scale: 4,
  }
}

export function normalizeColorInput(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'
}

export function textAlignFrom(value: unknown): ImageWorkbenchTextLayer['text_align'] {
  return value === 'left' || value === 'right' || value === 'justify' ? value : 'center'
}

export function reviewFromRecord(record: Record<string, unknown>): ImageWorkbenchReview {
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

export function imageReviewLines(review: ImageWorkbenchReview | undefined): string[] {
  if (!review || Object.keys(review).length === 0) return []
  const lines: string[] = []
  if (review.text_quality_status) {
    const suffix = review.text_quality_warning_message ? `。${friendlyReviewMessage(review.text_quality_warning_message)}` : ''
    lines.push(`文字检查：${friendlyCheckStatus(review.text_quality_status)}${suffix}`)
  }
  if (review.poster_quality_state) {
    const labels = { blocked: '有明显问题，暂不建议使用', risk: '有需要确认的细节', recommended: '未发现明显问题', user_confirmed: '已由用户确认', unchecked: '尚未检查' } as const
    lines.push(`画面检查：${labels[review.poster_quality_state]}`)
  }
  for (const warning of review.poster_hard_gate_warnings ?? []) lines.push(`需要确认：${friendlyReviewMessage(warning)}`)
  if (review.portrait_qc_status) {
    const detail = review.portrait_qc_message ? friendlyReviewMessage(review.portrait_qc_message) : ''
    const summary = detail.startsWith('尚未自动检查') ? detail : `${friendlyCheckStatus(review.portrait_qc_status)}${detail ? `。${detail}` : ''}`
    lines.push(`人物照片检查：${summary}`)
  }
  if (review.portrait_quality_state) {
    const labels = { blocked: '有明显问题，暂不建议使用', risk: '有需要确认的细节', recommended: '未发现明显问题，等待本人确认', user_confirmed: '已确认像本人', unchecked: '尚未检查' } as const
    lines.push(`人物照片结果：${labels[review.portrait_quality_state]}`)
  }
  if (review.portrait_consistency_status && review.portrait_consistency_status !== 'not_checked') {
    lines.push(`与原照片对比：${review.portrait_consistency_status === 'preserved' ? '未发现明显变化' : review.portrait_consistency_status === 'drifted' ? '人物特征可能有变化' : '需要并排确认'}`)
  }
  if (review.input_qc_status) lines.push(`参考图检查：${friendlyCheckStatus(review.input_qc_status)}`)
  if (review.input_fidelity?.input_fidelity_status === 'unsupported') lines.push('与参考图对比：当前无法自动保持细节，请对照原图确认')
  else if (review.input_fidelity?.input_fidelity_status === 'unknown') lines.push('与参考图对比：无法自动确认，请对照原图检查')
  else if (review.input_fidelity_risk) lines.push(`参考图提醒：${friendlyReviewMessage(review.input_fidelity_risk)}`)
  if (review.commercial_ready !== undefined) lines.push(review.commercial_ready ? '发布前仍需确认文字、价格和素材授权' : '尚未确认可直接对外使用')
  for (const warning of review.text_quality_missing ?? []) lines.push(`缺失文字：${warning}`)
  for (const warning of review.portrait_qc_warnings ?? []) lines.push(`人物照片提醒：${friendlyReviewMessage(warning)}`)
  for (const warning of review.input_qc_warnings ?? []) lines.push(`参考图提醒：${friendlyReviewMessage(warning)}`)
  for (const warning of review.risk_messages ?? []) lines.push(`提醒：${friendlyReviewMessage(warning)}`)
  return lines
}

export function friendlyCheckStatus(status: string): string {
  const value = status.trim().toLowerCase()
  if (['passed', 'pass', 'ok', 'clean', 'recommended', 'success'].includes(value)) return '未发现明显问题'
  if (['blocked', 'failed', 'fail', 'error'].includes(value)) return '有明显问题'
  if (['risk', 'warning', 'uncertain', 'drifted'].includes(value)) return '有需要确认的细节'
  if (['unchecked', 'not_checked', 'unknown', 'not_requested'].includes(value)) return '尚未检查'
  return '需要确认'
}

export function friendlyImageStage(stage: string | undefined, fallback: string): string {
  const value = stage?.trim() ?? ''
  if (!value) return fallback
  if (/取消/.test(value)) return '正在取消…'
  if (/组件|下载.*资源|准备.*资源/.test(value)) return '正在准备所需组件…'
  if (/排队|等待/.test(value)) return '正在等待处理…'
  if (/超分|放大|高清/.test(value)) return '正在生成高清图片…'
  if (/编辑|修改|重绘|蒙版/.test(value)) return '正在修改图片…'
  if (/保存|落盘|作品库/.test(value)) return '正在保存图片…'
  if (/完成|已生成/.test(value)) return '图片已生成'
  if (/提交|节点|网关|媒体|模型|生成|出图/.test(value)) return '正在生成图片…'
  return fallback
}

export function friendlyImageError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ''
  if (!message) return fallback
  if (/取消/.test(message)) return '已取消'
  if (/超时|timeout/i.test(message)) return '处理超时，请重试'
  if (/组件.*准备|准备.*组件|blocked/i.test(message)) return '所需组件正在准备，请稍后再试'
  if (/参考图|底图|source_image|source_generation/i.test(message)) return '无法读取参考图片，请重新添加后再试'
  if (/网关|端点|provider|model|token|quota|fetch|network|failed|http|\/images\//i.test(message)) return `${fallback}，请稍后重试`
  return message
}

export function friendlyReviewMessage(message: string): string {
  if (/质检模型|质检结果|无可读成图|人工把关/.test(message)) {
    return '尚未自动检查。请确认人物的手、脸和身体是否自然，照片是否过度美化、是否像本人，并确认照片授权和用途。'
  }
  if (/高保真|端点|input.?fidelity/i.test(message)) {
    return '当前无法自动确认参考图细节是否完整保留，请对照原图确认。'
  }
  return message
    .replace(/OCR/gi, '文字检查')
    .replace(/海报硬闸/g, '画面检查')
    .replace(/未自动质检/g, '尚未自动检查')
    .replace(/本地预览占位图/g, '本地预览图片')
    .replace(/正式候选/g, '最终图片')
    .replace(/生图服务/g, '图片生成服务')
    .replace(/高保真(?:图片|输入)?参数?/g, '参考图细节保持')
    .replace(/当前部署端点|当前正式端点|部署端点|正式端点|端点/g, '当前服务')
    .replace(/人工确认/g, '确认')
    .replace(/自动降级为标准图片输入/g, '改用标准参考图处理')
    .replace(/未能从当前服务证明参考图细节保持已接受/g, '无法确认参考图细节是否完整保留')
    .replace(/当前服务不接受手动参考图细节保持/g, '当前无法自动保持参考图细节')
    .replace(/已按当前服务默认图片输入能力处理/g, '已按当前可用方式处理参考图')
    .replace(/请确认参考图一致性/g, '请对照原图确认')
    .replace(/肢体/g, '身体')
    .replace(/可辨识度可能下降\(像换了个人\)/g, '人物特征可能有变化')
    .replace(/投放/g, '发布')
    .replace(/,/g, '，')
    .replace(/:/g, '：')
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
