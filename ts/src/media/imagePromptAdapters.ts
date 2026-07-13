import type { ImageCreativeBrief } from '../../shared/contracts/image-workbench'

export type ImageProviderRoute = 'seedream_4_5' | 'gpt_image_2'

export function routeImageBrief(brief: ImageCreativeBrief, mode: 'generate' | 'edit' = 'generate'): ImageProviderRoute {
  if (/错别字|改文字|改文案|文字修正|改个字|text fix|typo/iu.test(brief.user_request)) return 'seedream_4_5'
  if (brief.scene === 'portrait' || mode === 'edit') return 'gpt_image_2'
  if (/复杂创意|高保真|电影感|photorealistic|cinematic|\bEnglish\b/iu.test(brief.user_request)) return 'gpt_image_2'
  return 'seedream_4_5'
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.map(item => item?.trim()).filter(Boolean).join('；')
}

function englishChangeItem(value: string): string {
  const text = value.trim()
  if (!text) return ''
  if (text.startsWith('背景：')) return `Background: ${text.slice('背景：'.length)}`
  if (text.startsWith('服装：')) return `Wardrobe: ${text.slice('服装：'.length)}`
  if (text === '光线、气质或构图：按用户指定调整') return 'Lighting, mood, and composition: adjust only as requested.'
  if (text === '照片质感：自然、好看、无明显 AI 感，保留真实皮肤和自然比例') return 'Photo quality: natural, flattering, and non-AI-looking; preserve real skin texture and natural proportions.'
  if (text === '只改变用户明确提出的场景或视觉方向') return 'Only change the scene or visual direction explicitly requested by the user.'
  return `Requested change: ${text}`
}

function englishPreserveItem(value: string): string {
  const text = value.trim()
  const known: Record<string, string> = {
    '同一位已授权参考人物的可辨识面部特征': 'recognizable identity and natural facial details of the same person in the authorized reference photos',
    '面部可辨识特征': 'recognizable facial identity and natural facial details',
    '发型与发色（除非明确要求改变）': 'hair style and hair color unless explicitly changed',
    '肤色与年龄观感': 'skin tone and apparent age',
    '体型比例': 'body proportions',
    '人物数量为一人': 'exactly one person',
    '门店业务信息由确定性文字层排版': 'business copy is handled by deterministic text layers',
    '原始 Logo 和二维码不交给模型重绘': 'the supplied logo and QR code must not be redrawn',
    '用户明确提供的精确文字由确定性文字层排版': 'exact copy explicitly supplied by the user is handled by deterministic text layers',
    '原始 Logo 不交给模型重绘': 'the supplied logo must not be redrawn',
    '原始二维码不交给模型重绘': 'the supplied QR code must not be redrawn',
  }
  return known[text] ?? `Preserve requirement: ${text}`
}

function englishAvoidItem(value: string): string {
  const text = value.trim()
  const known: Record<string, string> = {
    '未要求的可见文字、乱码、水印或无关标识': 'visible text, gibberish, watermarks, or unrelated marks that the user did not request',
    '主体不要遮挡用户明确提供的文字或素材区域': 'placing the main subject over explicit copy or supplied asset regions',
    '额外人物、额外手指或肢体、塑料皮肤、过度磨皮、文字、水印': 'extra people, extra fingers or limbs, plastic skin, excessive retouching, text, or watermarks',
  }
  return known[text] ?? text
}

function seedreamUseLabel(outputUse: ImageCreativeBrief['output_use']): string {
  const labels: Record<ImageCreativeBrief['output_use'], string> = {
    moments: '朋友圈配图',
    group: '社群配图',
    poster: '海报视觉',
    rollup: '长幅海报视觉',
    profile: '人物照片',
    photo: '自然人物照片',
    other: '用户指定用途',
  }
  return labels[outputUse]
}

export function compileSeedreamPrompt(brief: ImageCreativeBrief, mode: 'generate' | 'edit' = 'generate'): string {
  const direction = brief.visual_direction
  const poster = brief.poster
  const exactCopy = poster?.exact_copy.length ? `业务文字由固定图层排版，不在底图中生成` : undefined
  return joinParts([
    `用途：${seedreamUseLabel(brief.output_use)}`,
    `主体：${direction.subject}`,
    direction.action ? `动作：${direction.action}` : undefined,
    direction.environment ? `环境：${direction.environment}` : undefined,
    direction.style ? `风格：${direction.style}` : undefined,
    direction.color ? `色彩：${direction.color}` : undefined,
    direction.lighting ? `光线：${direction.lighting}` : undefined,
    direction.composition ? `构图：${direction.composition}` : undefined,
    mode === 'edit' ? `仅修改：${brief.user_request}` : undefined,
    brief.reference_assets.length ? brief.scene === 'portrait'
      ? '以已上传的已授权实拍照片作为图像条件，保留同一人的可辨识特征'
      : '以已上传参考图作为图像条件，按其指定角色使用'
      : undefined,
    exactCopy,
    brief.must_avoid.length ? `避免：${brief.must_avoid.join('、')}` : undefined,
  ]).slice(0, 1200)
}

export function compileGptImagePrompt(brief: ImageCreativeBrief, mode: 'generate' | 'edit' = 'generate'): string {
  const preserve = brief.must_preserve.length
    ? brief.must_preserve
    : brief.scene === 'portrait'
      ? ['the identity and natural details of the supplied subject']
      : []
  const change = brief.scene === 'portrait'
    ? brief.portrait?.change ?? [brief.user_request]
    : mode === 'edit'
      ? [brief.user_request]
      : [brief.user_request, brief.visual_direction.style, brief.visual_direction.composition].filter(Boolean)
  const references = brief.reference_assets.map((asset, index) => `Image ${index + 1}: ${asset.role}`).join('; ')
  const avoid = brief.must_avoid.map(englishAvoidItem).filter(Boolean)
  return [
    'Change only:',
    change.filter((item): item is string => Boolean(item)).map(englishChangeItem).filter(Boolean).join('; '),
    '',
    preserve.length ? 'Preserve:' : '',
    preserve.length ? preserve.map(englishPreserveItem).filter(Boolean).join('; ') : '',
    references ? `Reference roles: ${references}.` : '',
    'Do not change anything else.',
    avoid.length ? 'Avoid:' : '',
    avoid.length ? avoid.join('; ') : '',
    brief.poster?.exact_copy.length ? `Keep exact Chinese copy as data only; do not translate or render it in the generated background: ${brief.poster.exact_copy.join(' | ')}` : '',
  ].filter(Boolean).join('\n')
}

export function compileProviderPrompt(brief: ImageCreativeBrief, mode: 'generate' | 'edit'): { route: ImageProviderRoute; prompt: string } {
  const route = routeImageBrief(brief, mode)
  return { route, prompt: route === 'seedream_4_5' ? compileSeedreamPrompt(brief, mode) : compileGptImagePrompt(brief, mode) }
}
