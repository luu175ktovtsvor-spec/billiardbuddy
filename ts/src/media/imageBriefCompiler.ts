import {
  imageCreativeBriefSchema,
  type ImageAssetReference,
  type ImageCreativeBrief,
  type ImageReferenceRole,
  type PosterBrief,
  type PortraitBrief,
} from '../../shared/contracts/image-workbench'

export interface ImageBriefCompileInput {
  userRequest?: string
  prompt?: string
  description?: string
  scene?: 'poster' | 'portrait'
  intent?: string
  ratio?: string
  quality?: 'draft' | 'standard' | 'final'
  posterText?: Record<string, unknown>
  sceneTemplateId?: string
  referenceAssets?: ImageAssetReference[]
  referenceImagePaths?: string[]
  portraitConsent?: boolean
  portraitAuthorizationConfirmed?: boolean
  brandContext?: string
}

const TEMPLATE_BY_KEYWORD: Array<[string, PosterBrief['template_id']]> = [
  ['开业', 'opening_anniversary'],
  ['新店', 'opening_anniversary'],
  ['充值', 'membership_recharge'],
  ['一卡通', 'membership_recharge'],
  ['器材券', 'membership_recharge'],
  ['抢一', 'tournament_signup'],
  ['组局', 'tournament_signup'],
  ['会员赛', 'tournament_signup'],
  ['赛事', 'tournament_signup'],
  ['比赛', 'tournament_signup'],
  ['报名', 'tournament_signup'],
  ['助教', 'coach_booking'],
  ['教练', 'coach_booking'],
  ['人物', 'coach_booking'],
  ['服务', 'coach_booking'],
  ['陪练', 'coach_booking'],
  ['节日', 'holiday_moments'],
  ['春节', 'holiday_moments'],
  ['端午', 'holiday_moments'],
  ['朋友圈', 'holiday_moments'],
  ['团购', 'weekend_bundle'],
  ['引流', 'weekend_bundle'],
  ['新客', 'weekend_bundle'],
  ['周末', 'weekend_bundle'],
]

const TEMPLATE_LABELS: Record<string, string> = {
  custom_poster: '自由创作',
  opening_anniversary: '开业/焕新',
  membership_recharge: '会员/充值',
  weekend_bundle: '优惠/团购',
  tournament_signup: '比赛/活动',
  coach_booking: '人物/服务',
  holiday_moments: '日常/社媒',
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function firstString(record: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = clean(record?.[key])
    if (value) return value
  }
  return ''
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))]
}

function inferScene(text: string, input: ImageBriefCompileInput): 'poster' | 'portrait' {
  const explicit = input.scene
  const intent = input.intent
  if (explicit === 'portrait' || intent === 'portrait') return 'portrait'
  const hasIdentityReference = input.referenceAssets?.some(ref => ref.role === 'identity_primary' || ref.role === 'identity_supporting') === true
  const hasUnclassifiedImage = (input.referenceImagePaths?.length ?? 0) > 0
  const explicitlyAboutPerson = /人像|肖像|形象照|写真|证件照|人物照|本人|真人照片|助教照片|助教实拍/u.test(text)
  const photoEditWithReference = (hasIdentityReference || hasUnclassifiedImage) && /照片|随拍|实拍|人物|本人|好看|自然|修饰|换服装|换背景|光线|构图/u.test(text)
  return explicitlyAboutPerson || photoEditWithReference ? 'portrait' : 'poster'
}

function inferTemplate(text: string, explicit?: string): PosterBrief['template_id'] {
  if (explicit && explicit in TEMPLATE_LABELS) return explicit as PosterBrief['template_id']
  return TEMPLATE_BY_KEYWORD.find(([keyword]) => text.includes(keyword))?.[1] ?? 'custom_poster'
}

function extractQuoted(text: string): string {
  const match = text.match(/[“"「『《]([^”"」』》]{2,100})[”"」』》]/u)
  return match?.[1]?.trim() ?? ''
}

function extractPrice(text: string): string {
  return text.match(/(?:人民币|价格|售价|优惠价|只要)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块|￥|折)/u)?.[0]?.trim() ?? ''
}

function extractDate(text: string): string {
  return text.match(/(?:\d{4}[年./-])?\d{1,2}[月./-]\d{1,2}(?:日|号)?(?:\s*[至到-]\s*(?:\d{1,2}[月./-])?\d{1,2}(?:日|号)?)?/u)?.[0]?.trim() ?? ''
}

function extractTime(text: string): string {
  return text.match(/(?:上午|下午|晚上|每日)?\s*\d{1,2}(?::|点)\d{0,2}\s*(?:至到-\s*\d{1,2}(?::|点)\d{0,2})?/u)?.[0]?.trim() ?? ''
}

function extractPhone(text: string): string {
  return text.match(/(?:电话|联系电话|预约电话|咨询电话)?\s*1[3-9]\d{9}/u)?.[0]?.trim() ?? ''
}

function inferChange(text: string): string[] {
  const items: string[] = []
  if (/背景|场景/u.test(text)) items.push(text.match(/(?:换|改成|改为|放在)([^，。；;]{1,40})背景/u)?.[1] ? `背景：${text.match(/(?:换|改成|改为|放在)([^，。；;]{1,40})背景/u)?.[1]}` : '背景')
  if (/服装|衣服|球服/u.test(text)) items.push('服装：按用户指定调整')
  if (/光线|灯光|气质|姿态|构图/u.test(text)) items.push('光线、气质或构图：按用户指定调整')
  if (/好看|自然|无明显\s*AI|无\s*AI\s*感|实拍|照片优化/u.test(text)) items.push('照片质感：自然、好看、无明显 AI 感，保留真实皮肤和自然比例')
  if (items.length === 0) items.push('只改变用户明确提出的场景或视觉方向')
  return unique(items)
}

function referencesFrom(input: ImageBriefCompileInput, scene: 'poster' | 'portrait'): ImageAssetReference[] {
  if (input.referenceAssets?.length) return input.referenceAssets.slice(0, 16)
  return (input.referenceImagePaths ?? []).slice(0, 8).map((_, index) => ({
    asset_id: `reference_${index + 1}`,
    role: (scene === 'portrait'
      ? index === 0 ? 'identity_primary' : 'identity_supporting'
      : 'environment_reference') as ImageReferenceRole,
  }))
}

function posterBrief(text: string, input: ImageBriefCompileInput): PosterBrief {
  const fields = input.posterText
  const templateId = inferTemplate(text, input.sceneTemplateId)
  const title = firstString(fields, 'title', '主标题', 'headline') || extractQuoted(text)
  const offer = firstString(fields, 'offer', 'subtitle', '副标题', '优惠')
  const price = firstString(fields, 'price', '价格', '售价') || extractPrice(text)
  const date = firstString(fields, 'date', '日期', '活动日期') || extractDate(text)
  const time = firstString(fields, 'time', '时间', '活动时间') || extractTime(text)
  const address = firstString(fields, 'address', '地址', '门店地址')
  const phone = firstString(fields, 'phone', 'telephone', '电话', '预约电话') || extractPhone(text)
  const cta = firstString(fields, 'cta', '行动按钮', '按钮')
  const exactCopy = unique([
    title,
    offer,
    price,
    date,
    time,
    address,
    phone,
    cta,
    ...Object.values(fields ?? {}).filter(value => typeof value === 'string').map(value => String(value)),
  ])
  return {
    template_id: templateId,
    title,
    offer,
    price,
    date,
    time,
    address,
    phone,
    cta,
    exact_copy: exactCopy,
    brand_asset_ids: [],
    reserved_regions: [],
  }
}

type PosterRegion = PosterBrief['reserved_regions'][number]

function posterControls(poster: PosterBrief, refs: ImageAssetReference[], brandContext?: string) {
  const regions: PosterRegion[] = []
  const regionLabels: string[] = []
  const addRegion = (region: PosterRegion, label: string) => {
    if (!regions.includes(region)) regions.push(region)
    if (!regionLabels.includes(label)) regionLabels.push(label)
  }
  if (poster.title) addRegion('title', '标题')
  if (poster.price) addRegion('price', '价格')
  if (poster.offer || poster.date || poster.time || poster.address) addRegion('details', '活动信息')
  if (poster.phone || poster.cta) addRegion('contact', '联系方式')

  const hasLogo = refs.some(ref => ref.role === 'logo') || /\bLogo\b/iu.test(brandContext ?? '')
  const hasQrCode = refs.some(ref => ref.role === 'qrcode') || /二维码/iu.test(brandContext ?? '')
  if (hasLogo) addRegion('logo', 'Logo')
  if (hasQrCode) addRegion('qrcode', '二维码')

  const mustPreserve: string[] = []
  if (poster.exact_copy.length) mustPreserve.push('用户明确提供的精确文字由确定性文字层排版')
  if (hasLogo) mustPreserve.push('原始 Logo 不交给模型重绘')
  if (hasQrCode) mustPreserve.push('原始二维码不交给模型重绘')

  return {
    regions,
    composition: [
      regionLabels.length ? `为用户明确提供的${regionLabels.join('、')}预留清晰区域` : '按用户描述安排构图，不额外假设未提供的信息',
      brandContext ? `品牌约束：${brandContext}` : '',
    ].filter(Boolean).join('；'),
    mustPreserve,
    mustAvoid: [
      '未要求的可见文字、乱码、水印或无关标识',
      ...(regions.length ? ['主体不要遮挡用户明确提供的文字或素材区域'] : []),
    ],
  }
}

function makePosterDirection(text: string, composition: string) {
  return {
    subject: text,
    action: '只呈现用户明确提出的动作、关系和数量',
    environment: '仅使用用户描述或参考图明确提供的环境，不补充未要求的业务场景',
    style: '遵循用户描述的视觉风格；未指定时保持重点清晰、自然协调',
    color: text.match(/(?:主色|配色|颜色)[为是]?([^，。；;]{1,20})/u)?.[1]?.trim() ?? undefined,
    lighting: '清晰、自然、有层次的光线',
    composition,
  }
}

export class ImageBriefCompiler {
  private readonly cache = new Map<string, ImageCreativeBrief>()

  compile(input: ImageBriefCompileInput): ImageCreativeBrief {
    const userRequest = clean(input.userRequest ?? input.prompt ?? input.description)
    if (!userRequest) throw new Error('生图需要一句自然语言描述')
    const key = JSON.stringify({ ...input, userRequest })
    const cached = this.cache.get(key)
    if (cached) return cached
    const scene = inferScene(userRequest, input)
    const refs = referencesFrom(input, scene)
    const posterDraft = scene === 'poster' ? posterBrief(userRequest, input) : undefined
    const posterControl = posterDraft ? posterControls(posterDraft, refs, clean(input.brandContext)) : undefined
    const poster = posterDraft && posterControl
      ? { ...posterDraft, reserved_regions: posterControl.regions }
      : undefined
    const portrait: PortraitBrief | undefined = scene === 'portrait'
      ? {
          subject_role: '用户本人或已授权参考人物',
          change: inferChange(userRequest),
          preserve: ['同一位已授权参考人物的可辨识面部特征', '发型与发色（除非明确要求改变）', '肤色与年龄观感', '体型比例', '人物数量为一人'],
          authorization_confirmed: input.portraitAuthorizationConfirmed === true || input.portraitConsent === true,
          primary_reference_asset_id: refs.find(ref => ref.role === 'identity_primary')?.asset_id,
        }
      : undefined
    const brief = imageCreativeBriefSchema.parse({
      schema_version: 1,
      scene,
      user_request: userRequest,
      output_use: scene === 'portrait' ? 'photo' : input.ratio === '2:5' || input.ratio === '5:2' ? 'rollup' : 'poster',
      ratio: input.ratio ?? '3:4',
      quality: input.quality ?? 'standard',
      reference_assets: refs,
      visual_direction: scene === 'poster' && poster && posterControl ? makePosterDirection(userRequest, posterControl.composition) : {
        subject: '已上传实拍照片中的同一位参考人物',
        action: '自然、好看且符合用户描述的真实照片状态',
        environment: userRequest,
        style: '真实自然的人物摄影，无明显 AI 感',
        lighting: '自然、柔和且与现场一致的光线',
        composition: '人物清楚、保留真实皮肤质感和自然比例，避免过度精修、贴图感或商业样片感',
      },
      must_preserve: scene === 'poster' ? posterControl?.mustPreserve : portrait?.preserve,
      must_avoid: scene === 'poster' ? posterControl?.mustAvoid : ['额外人物、额外手指或肢体、塑料皮肤、过度磨皮、文字、水印'],
      poster,
      portrait,
      understanding: scene === 'poster'
        ? `${TEMPLATE_LABELS[poster!.template_id]} / ${poster!.title || userRequest}${poster!.price ? ` / ${poster!.price}` : ''}${input.ratio ? ` / ${input.ratio}` : ''}`
        : `真人照片优化 / ${portrait!.change.join('、')} / 保留本人特征`,
    })
    this.cache.set(key, brief)
    return brief
  }
}

export const imageBriefCompiler = new ImageBriefCompiler()

export function compileImageBrief(input: ImageBriefCompileInput): ImageCreativeBrief {
  return imageBriefCompiler.compile(input)
}
