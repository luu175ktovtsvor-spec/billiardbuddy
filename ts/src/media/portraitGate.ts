// 肖像授权合规闸(纯逻辑,无 I/O):判定一次生图请求是否属于"对真人肖像照片做优化/重塑",
// 若是则要求用户先确认肖像授权。这是"人像合规"这一类硬闸,不是"花钱审批"——
// 生图默认不弹花钱审批(owner 去钱味),但真人肖像必须先过授权确认(对齐方案文档 R1)。
//
// 口径与 docs/生图-当前能力与设计.md 的“人像质量与授权”一致:
// 授权语义是"我拥有这张照片的使用授权、被拍者同意用于本次生成",所以闸只在**存在真人照片输入**
// (edit 的底图 / generate 的参考图)时触发;纯文字生成一张写实人像(无被拍者)不触发本闸。
//
// 白标:本模块所有面向用户的文案均为自有中文中性文案,不含任何底层模型/供应商名。

const PORTRAIT_KEYWORDS = [
  '人像', '肖像', '头像', '形象照', '写真', '证件照', '艺术照', '人物照', '人物写真',
  '员工照', '个人照', '半身照', '全身照', '大头照', '正脸', '面部', '随手拍', '自拍',
  '美颜', '磨皮', '瘦脸', '妆容', '换装', '精修', '修图', '人物优化', '人像优化', '照片优化', '照片编辑', '人像重塑', '肖像重塑',
  'portrait', 'headshot', 'selfie',
]

// 明显是插画/非真人的关键词——命中则抑制"真人肖像"判定(避免把卡通/logo 当真人)。
const ILLUSTRATION_KEYWORDS = [
  '卡通', '插画', '二次元', '漫画', '手绘', 'q版', 'Q版', '表情包', 'logo', 'LOGO', '图标', 'icon',
  'anime', 'cartoon', 'illustration', 'sticker',
]

const AFFIRMATIVE = new Set([
  'true', '1', 'yes', 'y', 'on', 'ok',
  '已授权', '有授权', '已获授权', '已取得授权', '已获肖像授权', '获得授权',
  '确认', '已确认', '同意', '已同意', '是',
])

function isAffirmative(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'number') return value === 1
  if (typeof value !== 'string') return false
  return AFFIRMATIVE.has(value.trim().toLowerCase())
}

/** 用户是否已确认肖像授权(容忍多种字段名与"已授权/确认/是"等口语确认)。 */
export function portraitConsentGranted(body: Record<string, unknown>): boolean {
  return isAffirmative(body.portrait_consent) ||
    isAffirmative(body.portrait_authorization) ||
    isAffirmative(body._portrait_consent) ||
    isAffirmative(body.consent_portrait)
}

/** body 里是否显式声明这是人像请求(工具可传 portrait:true / is_portrait:true)。 */
export function portraitFlagged(body: Record<string, unknown>): boolean {
  return body.portrait === true || body.is_portrait === true || body.subject === 'portrait'
}

function containsAny(text: string, needles: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return needles.some(n => lower.includes(n.toLowerCase()))
}

export interface PortraitIntent {
  /** 是否命中"对真人肖像做优化/重塑"这一合规敏感场景(需授权闸)。 */
  isPortrait: boolean
  /** 请求是否带真人照片输入(底图/参考图)。 */
  hasInputImage: boolean
  keywordHit: boolean
  /** 输入图人脸检测结果(true/false=已检测,null=未检测/无法检测)。 */
  faceDetected: boolean | null
  signals: string[]
}

/**
 * 判定人像意图。isPortrait = 有真人照片输入 且 (显式人像标记 / 命中人像关键词 / 输入图检出人脸)。
 * 纯函数,可单测。
 */
export function detectPortraitIntent(input: {
  prompt: string
  hasInputImage: boolean
  inputFaceDetected?: boolean | null
  explicitFlag?: boolean
}): PortraitIntent {
  const prompt = input.prompt ?? ''
  const illustration = containsAny(prompt, ILLUSTRATION_KEYWORDS)
  const keywordHit = !illustration && containsAny(prompt, PORTRAIT_KEYWORDS)
  const faceDetected = input.inputFaceDetected ?? null
  const signals: string[] = []
  if (input.explicitFlag) signals.push('explicit_flag')
  if (keywordHit) signals.push('portrait_keyword')
  if (faceDetected === true) signals.push('input_face_detected')
  const portraitSignal = !!input.explicitFlag || keywordHit || faceDetected === true
  const isPortrait = input.hasInputImage && portraitSignal
  return { isPortrait, hasInputImage: input.hasInputImage, keywordHit, faceDetected, signals }
}

/** 未授权时的拦截结果(任务正常完成、非报错,让 agent 读到后向用户要一次授权)。 */
export function portraitConsentRequiredResult(intent: PortraitIntent): Record<string, unknown> {
  return {
    blocked: true,
    block_reason: 'portrait_consent_required',
    portrait_consent_required: true,
    portrait_gate: 'consent_required',
    needs_user_action: true,
    local_preview: false,
    portrait_signals: intent.signals,
    message: '检测到这是一张真人照片。优化照片前需要你先确认一次:你拥有这张照片的使用授权、' +
      '并且被拍的人同意用于本次生成。确认后我再继续(在请求里带上 portrait_consent=true,或直接回复"已获肖像授权")。',
  }
}

export interface InputQualityBlock {
  warnings: string[]
  blockReason: string
}

export function portraitReferenceRequiredResult(): Record<string, unknown> {
  return {
    blocked: true,
    block_reason: 'portrait_reference_required',
    portrait_gate: 'reference_required',
    needs_user_action: true,
    local_preview: false,
    input_qc_status: 'blocked',
    input_qc_warnings: ['人物照片优化需要上传 1-3 张同一人物的已授权参考图。'],
    message: '请先上传 1-3 张同一人物的已授权参考图；系统不会只用外貌文字重建某个人。',
  }
}

export function portraitImpersonationBlockedResult(): Record<string, unknown> {
  return {
    blocked: true,
    block_reason: 'portrait_impersonation_not_supported',
    portrait_gate: 'impersonation_not_supported',
    needs_user_action: true,
    local_preview: false,
    message: '不支持换脸、公众人物代言或身份冒充。请使用本人或已授权人物素材，按本次目标做照片编辑。',
  }
}

export function requestsPortraitImpersonation(prompt: string): boolean {
  return /换脸|深伪|deepfake|冒充|假扮|明星代言|公众人物代言|名人代言|模仿(?:某|明星|名人)/iu.test(prompt)
}

/** 输入图质检不合格时的拦截结果(拦低质,给大白话原因)。 */
export function inputQualityBlockedResult(block: InputQualityBlock): Record<string, unknown> {
  return {
    blocked: true,
    block_reason: 'input_quality',
    input_quality_blocked: true,
    portrait_gate: 'input_quality',
    needs_user_action: true,
    local_preview: false,
    input_qc_status: 'blocked',
    input_qc_warnings: block.warnings,
    message: block.blockReason,
  }
}
