import {
  imageCreativeBriefSchema,
  type ImageAssetReference,
  type ImageCreativeBrief,
  type ImageReferenceRole,
  type PosterBrief,
  type PortraitBrief,
} from '../../shared/contracts/image-workbench'
import { z } from 'zod'
import type { Model } from '../types/model'
import { userText } from '../types/message'

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

const TEMPLATE_LABELS: Record<string, string> = {
  custom_poster: '自由创作',
  opening_anniversary: '开业/焕新',
  membership_recharge: '会员/充值',
  weekend_bundle: '优惠/团购',
  tournament_signup: '比赛/活动',
  recruitment_role: '招聘/岗位',
  coach_booking: '招聘/岗位',
  daily_social: '日常/社媒',
  holiday_moments: '日常/社媒',
}

const imageBriefEnrichmentSchema = z.object({
  visual_direction: z.object({
    subject: z.string().max(400).optional(),
    action: z.string().max(400).optional(),
    environment: z.string().max(400).optional(),
    style: z.string().max(400).optional(),
    color: z.string().max(240).optional(),
    lighting: z.string().max(240).optional(),
    composition: z.string().max(400).optional(),
  }).default({}),
  portrait_change: z.array(z.string().max(240)).max(12).default([]),
  portrait_preserve: z.array(z.string().max(240)).max(12).default([]),
  understanding: z.string().max(1000).optional(),
})

const FORBIDDEN_INVENTED_DOMAIN_TERMS = [
  '台球', '球房', '助教', '教练', '会员', '充值', '团购', '开业', '赛事', '比赛', '门店', '优惠', '陪打',
]

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function limitText(value: string, limit: number): string {
  const chars = Array.from(value)
  return chars.length <= limit ? value : `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`
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

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

function shouldUseModel(input: ImageBriefCompileInput): boolean {
  const structuredValues = Object.values(input.posterText ?? {}).some(value => clean(value).length > 0)
  const explicitTemplate = clean(input.sceneTemplateId)
  return !structuredValues && (!explicitTemplate || explicitTemplate === 'custom_poster' || explicitTemplate === 'photo_edit')
}

function containsInventedBusinessFacts(value: unknown, userRequest: string): boolean {
  const text = JSON.stringify(value)
  for (const term of FORBIDDEN_INVENTED_DOMAIN_TERMS) {
    if (text.includes(term) && !userRequest.includes(term)) return true
  }
  const requestNumbers = new Set(userRequest.match(/\d+(?:\.\d+)?/gu) ?? [])
  return (text.match(/\d+(?:\.\d+)?/gu) ?? []).some(number => !requestNumbers.has(number))
}

function inferScene(text: string, input: ImageBriefCompileInput): 'poster' | 'portrait' {
  const explicit = input.scene
  const intent = input.intent
  if (explicit === 'portrait' || intent === 'portrait') return 'portrait'
  const hasIdentityReference = input.referenceAssets?.some(ref => ref.role === 'identity_primary' || ref.role === 'identity_supporting') === true
  const hasUnclassifiedImage = (input.referenceImagePaths?.length ?? 0) > 0
  const explicitlyAboutPerson = /人像|肖像|形象照|写真|证件照|人物照|本人|真人照片/u.test(text)
  const photoEditWithReference = (hasIdentityReference || hasUnclassifiedImage) && /照片|随拍|实拍|人物|本人|好看|自然|修饰|换服装|换背景|光线|构图/u.test(text)
  return explicitlyAboutPerson || photoEditWithReference ? 'portrait' : 'poster'
}

function inferTemplate(explicit?: string): PosterBrief['template_id'] {
  if (explicit && explicit in TEMPLATE_LABELS) return explicit as PosterBrief['template_id']
  return 'custom_poster'
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

function extractAddress(text: string): string {
  return text.match(/(?:地址|地点|门店地址)[:：\s]*([^，。；;]{2,100})/u)?.[1]?.trim() ?? ''
}

function extractCta(text: string): string {
  return text.match(/((?:扫码|立即|马上|点击|进群)[^，。；;]{0,40}(?:报名|预约|咨询|购买|领取|参加))/u)?.[1]?.trim() ?? ''
}

function inferChange(text: string): string[] {
  const items: string[] = []
  if (/背景|场景/u.test(text)) {
    const background = text.match(/(?:换成|改成|改为|换|放在)([^，。；;]{1,40})背景/u)?.[1]?.trim()
    items.push(background ? `背景：${background}` : '背景：按用户本次目标调整')
  }
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
  const templateId = inferTemplate(input.sceneTemplateId)
  const title = firstString(fields, 'title', '主标题', 'headline') || extractQuoted(text)
  const offer = firstString(fields, 'offer', 'subtitle', '副标题', '优惠')
  const price = firstString(fields, 'price', '价格', '售价') || extractPrice(text)
  const date = firstString(fields, 'date', '日期', '活动日期') || extractDate(text)
  const time = firstString(fields, 'time', '时间', '活动时间') || extractTime(text)
  const address = firstString(fields, 'address', '地址', '门店地址') || extractAddress(text)
  const phone = firstString(fields, 'phone', 'telephone', '电话', '预约电话') || extractPhone(text)
  const cta = firstString(fields, 'cta', '行动按钮', '按钮') || extractCta(text)
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

function compactBrandContext(value?: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const context = clean(raw)
  if (!context) return ''
  const name = raw.match(/门店名称[:：]\s*([^\n；;]+)/u)?.[1]?.trim()
  const style = raw.match(/品牌风格[:：]\s*([^\n；;]+)/u)?.[1]?.trim()
  const color = raw.match(/#[0-9a-fA-F]{3,8}\b/u)?.[0]
  const facts = [
    name ? `门店名称:${name}` : '',
    style ? `品牌风格:${style}` : '',
    color ? `品牌主色调呼应 ${color}` : '',
  ].filter(Boolean)
  return facts.length ? facts.join('；') : limitText(context, 96)
}

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
      brandContext ? compactBrandContext(brandContext) : '',
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
    subject: limitText(text, 400),
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
  private readonly modelCache = new Map<string, ImageCreativeBrief>()

  compile(input: ImageBriefCompileInput): ImageCreativeBrief {
    const userRequest = clean(input.userRequest ?? input.prompt ?? input.description)
    if (!userRequest) throw new Error('生图需要一句自然语言描述')
    const key = JSON.stringify({ ...input, userRequest })
    const cached = this.cache.get(key)
    if (cached) return cached
    const scene = inferScene(userRequest, input)
    const refs = referencesFrom(input, scene)
    const posterDraft = scene === 'poster' ? posterBrief(userRequest, input) : undefined
    const posterControl = posterDraft ? posterControls(posterDraft, refs, input.brandContext) : undefined
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
        action: limitText(userRequest, 400),
        style: '按用户本次目标编辑；未指定时保持真实自然、好看且无明显 AI 感',
        lighting: '只按用户要求改变；未指定时保持原照片的自然光线关系',
        composition: '只改变用户明确要求的内容，其余保持；保留真实皮肤质感和自然比例',
      },
      must_preserve: scene === 'poster' ? posterControl?.mustPreserve : portrait?.preserve,
      must_avoid: scene === 'poster' ? posterControl?.mustAvoid : ['额外人物、额外手指或肢体、塑料皮肤、过度磨皮、文字、水印'],
      poster,
      portrait,
      understanding: scene === 'poster'
        ? `${TEMPLATE_LABELS[poster!.template_id]} / ${poster!.title || userRequest}${poster!.price ? ` / ${poster!.price}` : ''}${input.ratio ? ` / ${input.ratio}` : ''}`
        : `照片编辑 / ${limitText(userRequest, 480)} / 保留未要求改变的本人特征`,
    })
    this.cache.set(key, brief)
    return brief
  }

  async compileWithModel(input: ImageBriefCompileInput, model?: Model | null, signal?: AbortSignal): Promise<ImageCreativeBrief> {
    const base = this.compile(input)
    if (!model || !shouldUseModel(input)) return base
    const key = JSON.stringify({ base, compiler: 'model-v1' })
    const cached = this.modelCache.get(key)
    if (cached) return cached
    try {
      const step = await model.step({
        system: [
          '你是图片创作需求编译器。只把用户原话整理成 provider-neutral JSON，不写生图 Prompt。',
          '不得补充用户没有说的行业、场景、人物、人设、价格、日期、电话、CTA、营销打法或品牌事实。',
          'PPT、知识库、领域包和历史运营信息都不是本次输入，不得引用。',
          '只输出 JSON：{"visual_direction":{"subject":"","action":"","environment":"","style":"","color":"","lighting":"","composition":""},"portrait_change":[],"portrait_preserve":[],"understanding":""}。',
          '字段没有依据就省略或留空；understanding 只复述本次用户目标。',
        ].join('\n'),
        messages: [userText(JSON.stringify({
          scene: base.scene,
          user_request: base.user_request,
          ratio: base.ratio,
          reference_roles: base.reference_assets.map(asset => asset.role),
        }))],
        tools: [],
        signal,
      })
      const parsed = imageBriefEnrichmentSchema.safeParse(extractJson(step.text ?? ''))
      if (!parsed.success || containsInventedBusinessFacts(parsed.data, base.user_request)) return base
      const hasEnrichment = Object.values(parsed.data.visual_direction).some(value => clean(value).length > 0)
        || parsed.data.portrait_change.length > 0
        || parsed.data.portrait_preserve.length > 0
        || clean(parsed.data.understanding).length > 0
      if (!hasEnrichment) return base
      const enriched = imageCreativeBriefSchema.parse({
        ...base,
        visual_direction: { ...base.visual_direction, ...parsed.data.visual_direction },
        portrait: base.portrait ? {
          ...base.portrait,
          change: parsed.data.portrait_change.length ? parsed.data.portrait_change : base.portrait.change,
          preserve: unique([...base.portrait.preserve, ...parsed.data.portrait_preserve]),
        } : undefined,
        understanding: clean(parsed.data.understanding) || base.understanding,
        compiler_version: 'image-brief-v1-model',
      })
      this.modelCache.set(key, enriched)
      return enriched
    } catch {
      return base
    }
  }
}

export const imageBriefCompiler = new ImageBriefCompiler()

export function compileImageBrief(input: ImageBriefCompileInput): ImageCreativeBrief {
  return imageBriefCompiler.compile(input)
}

export function compileImageBriefWithModel(input: ImageBriefCompileInput, model?: Model | null, signal?: AbortSignal): Promise<ImageCreativeBrief> {
  return imageBriefCompiler.compileWithModel(input, model, signal)
}
