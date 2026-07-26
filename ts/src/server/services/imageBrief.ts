import type {
  ImageCreativeBrief,
  ImageProjectReference,
} from '../../../shared/contracts/media.js'

const REFERENCE_ROLE_LABELS: Record<ImageProjectReference['role'], string> = {
  unclassified: '参考图角色尚未由用户确认',
  subject: '主体外观与可辨识特征',
  style: '参考风格',
  environment: '参考环境',
  brand: '品牌视觉',
  logo: 'Logo 原样',
  qrcode: '二维码原样且可扫描',
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean))]
}

function exactText(userRequest: string): string[] {
  const values: string[] = []
  for (const match of userRequest.matchAll(/[“"「『《]([^”"」』》]{1,500})[”"」』》]/gu)) {
    if (match[1]) values.push(match[1])
  }
  for (const match of userRequest.matchAll(/(?:标题|文案|文字|写上|显示)[:：]\s*([^，。；;\n]{1,500})/gu)) {
    const value = match[1]?.trim()
    // A quoted value was already captured by the stricter pass above; do not
    // accidentally extend it with the prose that follows the closing quote.
    if (value && !/^[“"「『《]/u.test(value)) values.push(value)
  }
  return unique(values).slice(0, 40)
}

function explicitFacts(userRequest: string): string[] {
  const facts = [
    ...userRequest.matchAll(/(?:价格|日期|时间|地址|地点|电话|联系方式)[:：]?\s*([^，。；;\n]{1,200})/gu),
  ].flatMap(match => match[0] ? [match[0]] : [])
  return unique(facts).slice(0, 40)
}

export function compileImageBrief(
  rawUserRequest: string,
  references: ImageProjectReference[],
): { brief: ImageCreativeBrief; providerPrompt: string } {
  const userRequest = rawUserRequest.replace(/\s+/g, ' ').trim()
  const exact = exactText(userRequest)
  const facts = explicitFacts(userRequest)
  const referencePreserve = references.map(reference => REFERENCE_ROLE_LABELS[reference.role])
  const mustPreserve = unique([
    ...exact.map(text => `精确文字：${text}`),
    ...referencePreserve,
  ])
  const mayChange = /背景|配色|颜色|风格|构图|光线|服装|姿态/u.test(userRequest)
    ? ['仅按用户原话明确要求调整相应视觉元素']
    : ['未明确指定的构图、配色、光线和装饰细节']
  const missingInformation = [
    ...(exact.length === 0 && /海报|宣传图|活动图|招聘图/u.test(userRequest)
      ? ['未提供需要精确排版的文字；如需文字，应在生成后使用确定性文字图层添加']
      : []),
    ...(references.length === 0 && /本人|人物|Logo|二维码|品牌/u.test(userRequest)
      ? ['请求提到需要保持的主体或品牌元素，但尚未提供对应参考图']
      : []),
    ...(references.some(reference => reference.role === 'unclassified')
      ? ['旧项目中的参考图角色尚未确认，请先指定主体、风格、环境、品牌、Logo 或二维码']
      : []),
  ]
  const brief: ImageCreativeBrief = {
    schema_version: 1,
    user_request: userRequest,
    confirmed_facts: facts,
    must_preserve: mustPreserve,
    may_change: mayChange,
    missing_information: missingInformation,
    exact_text: exact,
    compiler_version: 'image-brief-v1',
  }
  return { brief, providerPrompt: providerPromptForImageBrief(brief) }
}

export function providerPromptForImageBrief(brief: ImageCreativeBrief): string {
  return [
    `用户原始需求：${brief.user_request}`,
    brief.confirmed_facts.length ? `已确认事实：${brief.confirmed_facts.join('；')}` : '',
    brief.must_preserve.length ? `必须保留：${brief.must_preserve.join('；')}` : '',
    `允许调整：${brief.may_change.join('；')}`,
    '不得编造价格、日期、地址、联系方式、品牌或活动规则。',
    brief.exact_text.length ? '不要在生成画面中绘制可读文字，为后续确定性文字图层预留清晰区域。' : '',
  ].filter(Boolean).join('\n')
}
