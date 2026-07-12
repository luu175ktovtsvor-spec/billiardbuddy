// 生图人像质检(走网关 VLM = agent 自己那颗多模态模型,复用 providerConfigFromEnv + 现有模型出口,
// 白标/内置 key/用户零配置)。避免在 Bun 进程 require .node 的 CV 原生模块(段错误雷),
// 判人脸/质检一律走网关 VLM;网关不可用则优雅降级为"未自动质检、请人工把关",绝不假装通过(R13)。
//
// 输入图质检(生成前)与结果质检(生成后)+ 海报硬文字 OCR 校对都在这里。
// 白标:面向用户的结论均为自有中文文案,并对任何可能夹带的自由文本过一遍 scrubProviderIdentifiers。

import type { Model } from '../types/model'
import type { ContentBlock, Message } from '../types/message'
import { providerConfigFromEnv } from '../model/providerConfig'
import { createModelFromProviderConfig } from '../model/modelFactory'
import { scrubProviderIdentifiers } from '../model/publicModelNames'

export const PORTRAIT_MIN_SHORT_SIDE = 512
export const PORTRAIT_RECOMMENDED_SHORT_SIDE = 768

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface QcImage {
  base64?: string
  mediaType?: ImageMediaType
  width?: number
  height?: number
}

/** 把 content-type 归一成内核 ImageBlock 支持的四种之一(默认 png)。 */
export function normalizeImageMediaType(contentType: string | undefined): ImageMediaType {
  const c = (contentType ?? '').toLowerCase()
  if (c.includes('jpeg') || c.includes('jpg')) return 'image/jpeg'
  if (c.includes('webp')) return 'image/webp'
  if (c.includes('gif')) return 'image/gif'
  return 'image/png'
}

/** 按 env 构造网关 VLM 模型;缺配置/构造失败 → null(调用方降级)。 */
export function buildQcModelFromEnv(env: Record<string, string | undefined> | undefined): Model | null {
  const cfg = providerConfigFromEnv(env ?? process.env)
  if (!cfg) return null
  try {
    return createModelFromProviderConfig(cfg)
  } catch {
    return null
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

function boolOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'yes' || v === '是') return true
    if (v === 'false' || v === 'no' || v === '否') return false
  }
  return null
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : null
}

function imageBlocks(images: QcImage[], limit: number): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const img of images.slice(0, limit)) {
    if (!img.base64) continue
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType ?? 'image/png', data: img.base64 } })
  }
  return blocks
}

async function askVlmJson(model: Model, system: string, promptText: string, images: QcImage[], limit: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const blocks = imageBlocks(images, limit)
  if (blocks.length === 0) return null
  const content: ContentBlock[] = [{ type: 'text', text: promptText }, ...blocks]
  const messages: Message[] = [{ role: 'user', content }]
  const step = await model.step({ system, messages, tools: [], signal })
  const parsed = extractJson(step.text ?? '')
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
}

// --- 输入图质检(生成前) --------------------------------------------------

const INPUT_QC_SYSTEM = '你是人像照片质检助手。只依据图片内容判断,严格输出 JSON,不要解释。'

const INPUT_QC_PROMPT = [
  '判断这张(些)照片是否适合作为"真人形象照/人像优化"的输入。严格输出 JSON,形如:',
  '{"face_count":1,"is_real_person":true,"single_subject":true,"blurry":false,"occluded":false,"low_light":false}',
  '- face_count:能清晰看到的人脸数量(整数)。',
  '- is_real_person:是否真人照片(卡通/插画/明显 AI 生成 = false)。',
  '- single_subject:画面是否只有一个清晰主体人物。',
  '- blurry:是否明显失焦或运动模糊。occluded:脸部关键区域是否被严重遮挡。low_light:是否严重欠曝/过曝/大逆光。',
].join('\n')

export interface InputInspection {
  minShortSide: number | null
  faceCount: number | null
  hasFace: boolean | null
  isRealPerson: boolean | null
  /** 是否真的跑过 VLM 自动质检(false=模型缺位/无字节,降级)。 */
  autoChecked: boolean
  warnings: string[]
  /** 非空 = 输入图硬不合格,应拦下并让用户换图。 */
  blockReason: string | null
}

export async function inspectInputImage(images: QcImage[], opts: { model?: Model | null; signal?: AbortSignal } = {}): Promise<InputInspection> {
  const shortSides = images
    .map(i => (i.width && i.height ? Math.min(i.width, i.height) : null))
    .filter((n): n is number => n != null)
  const minShortSide = shortSides.length ? Math.min(...shortSides) : null

  const warnings: string[] = []
  let blockReason: string | null = null

  if (minShortSide != null) {
    if (minShortSide < PORTRAIT_MIN_SHORT_SIDE) {
      blockReason = `这张照片分辨率偏低(短边约 ${minShortSide}px),做人像优化容易糊。建议换一张更清晰的正脸照片(短边至少 ${PORTRAIT_RECOMMENDED_SHORT_SIDE}px)再试。`
    } else if (minShortSide < PORTRAIT_RECOMMENDED_SHORT_SIDE) {
      warnings.push(`照片短边约 ${minShortSide}px,略低于建议的 ${PORTRAIT_RECOMMENDED_SHORT_SIDE}px,清晰度可能一般。`)
    }
  }

  let faceCount: number | null = null
  let hasFace: boolean | null = null
  let isRealPerson: boolean | null = null
  let autoChecked = false

  const model = opts.model
  if (model && images.some(i => i.base64)) {
    try {
      const parsed = await askVlmJson(model, INPUT_QC_SYSTEM, INPUT_QC_PROMPT, images, 4, opts.signal)
      if (parsed) {
        autoChecked = true
        faceCount = numOrNull(parsed.face_count)
        isRealPerson = boolOrNull(parsed.is_real_person)
        hasFace = faceCount != null ? faceCount > 0 : isRealPerson
        const singleSubject = boolOrNull(parsed.single_subject)
        if (isRealPerson === false) warnings.push('这看起来不是真人照片(可能是卡通/AI 图),人像优化更适合清晰的真人正脸照。')
        if (singleSubject === false || (faceCount != null && faceCount > 1)) warnings.push('照片里不止一个清晰主体,建议用单人正脸照,人像优化效果更稳。')
        if (boolOrNull(parsed.blurry) === true) warnings.push('照片偏模糊/失焦,成图清晰度可能受影响。')
        if (boolOrNull(parsed.occluded) === true) warnings.push('脸部有明显遮挡,建议换一张脸部完整的照片。')
        if (boolOrNull(parsed.low_light) === true) warnings.push('光线偏暗或过曝,建议换一张光线均匀的照片。')
      }
    } catch {
      // 网关不可用 → 降级,不拦、不假装质检。
    }
  }

  if (!blockReason && autoChecked && faceCount === 0) {
    blockReason = '没有在这张照片里检测到清晰人脸。做人像优化需要一张能看清正脸的真人照片,请换一张再试。'
  }

  return {
    minShortSide,
    faceCount,
    hasFace,
    isRealPerson,
    autoChecked,
    warnings: warnings.map(w => scrubProviderIdentifiers(w)),
    blockReason: blockReason ? scrubProviderIdentifiers(blockReason) : null,
  }
}

// --- 结果质检(生成后) ----------------------------------------------------

const RESULT_QC_SYSTEM = '你是 AI 人像成图质检助手。只依据图片内容判断,严格输出 JSON,不要解释。'

const RESULT_QC_PROMPT = [
  '逐张检查这些 AI 生成的人像图有没有明显问题。严格输出 JSON,形如:',
  '{"images":[{"hands_ok":true,"face_ok":true,"limbs_ok":true,"face_count":1,"over_beautified":false,"realistic":true,"unwanted_text":false}]}',
  '- hands_ok:手指数量与形状正常(无多指/少指/畸形手)。face_ok:五官正常(无双瞳/歪脸/糊脸/牙齿糊)。',
  '- limbs_ok:肢体正常(无多肢/断肢/关节反向)。face_count:画面里的人脸数量。',
  '- over_beautified:是否过度磨皮/瘦脸到"换了个人"般失真。realistic:是否自然、不塑料感。unwanted_text:是否出现莫名其妙的文字/水印。',
  '- images 数组顺序与给你的图片顺序一致。',
].join('\n')

export interface ResultInspection {
  status: 'passed' | 'risk' | 'unchecked'
  autoChecked: boolean
  warnings: string[]
  message: string
  consistencyStatus: 'preserved' | 'uncertain' | 'drifted' | 'not_checked'
}

export async function inspectPortraitResult(images: QcImage[], opts: { model?: Model | null; signal?: AbortSignal; reference?: QcImage } = {}): Promise<ResultInspection> {
  const model = opts.model
  const hasBytes = images.some(i => i.base64)
  if (!model || !hasBytes) {
    return {
      status: 'unchecked',
      autoChecked: false,
      warnings: [],
      message: '未自动质检(质检模型未接入或无可读成图):请人工把关手/脸/肢体是否正常、有没有过度美化、是不是还是本人,再决定是否商用。',
      consistencyStatus: 'not_checked',
    }
  }
  try {
    const parsed = await askVlmJson(model, RESULT_QC_SYSTEM, RESULT_QC_PROMPT, images, 4, opts.signal)
    const arr = parsed && Array.isArray(parsed.images) ? parsed.images : null
    if (!arr || arr.length === 0) {
      return {
        status: 'unchecked',
        autoChecked: false,
        warnings: [],
        message: '未自动质检(质检结果无法解析):请人工把关手/脸/肢体、是否过度美化、是否还是本人,再决定是否商用。',
        consistencyStatus: 'not_checked',
      }
    }
    const warnings: string[] = []
    arr.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return
      const r = raw as Record<string, unknown>
      const tag = arr.length > 1 ? `第 ${i + 1} 张:` : ''
      if (boolOrNull(r.hands_ok) === false) warnings.push(`${tag}手部疑似异常(多指/少指/畸形)。`)
      if (boolOrNull(r.face_ok) === false) warnings.push(`${tag}脸部疑似异常(五官错乱/糊脸)。`)
      if (boolOrNull(r.limbs_ok) === false) warnings.push(`${tag}肢体疑似异常(多肢/断肢/关节反向)。`)
      const faceCount = numOrNull(r.face_count)
      if (faceCount != null && faceCount > 1) warnings.push(`${tag}画面出现多张人脸(${faceCount}),可能不符合单人形象照预期。`)
      if (boolOrNull(r.over_beautified) === true) warnings.push(`${tag}疑似过度美化,可辨识度可能下降(像换了个人)。`)
      if (boolOrNull(r.realistic) === false) warnings.push(`${tag}真实感不足(偏塑料感/AI 味)。`)
      if (boolOrNull(r.unwanted_text) === true) warnings.push(`${tag}出现未要求的文字/水印。`)
    })
    let consistencyStatus: ResultInspection['consistencyStatus'] = 'not_checked'
    if (opts.reference?.base64) {
      try {
        const consistency = await inspectPortraitConsistency(opts.reference, images, { model, signal: opts.signal })
        consistencyStatus = consistency.status
        warnings.push(...consistency.warnings)
      } catch {
        consistencyStatus = 'uncertain'
        warnings.push('参考图与成图的一致性未能自动判断,请并排确认是否像本人。')
      }
    }
    if (warnings.length === 0) {
      return {
        status: 'passed',
        autoChecked: true,
        warnings: [],
        message: '已自动质检:手/脸/肢体未见明显问题。真人成图建议再人工确认可辨识度后投放。',
        consistencyStatus,
      }
    }
    const scrubbed = warnings.map(w => scrubProviderIdentifiers(w))
    return {
      status: 'risk',
      autoChecked: true,
      warnings: scrubbed,
      message: scrubProviderIdentifiers(`自动质检发现风险:${scrubbed.join(' ')} 建议重新生成或人工确认后再用,先不要直接商用。`),
      consistencyStatus,
    }
  } catch {
    return {
      status: 'unchecked',
      autoChecked: false,
      warnings: [],
      message: '未自动质检(质检模型调用失败):请人工把关手/脸/肢体、是否过度美化、是否还是本人,再决定是否商用。',
      consistencyStatus: 'not_checked',
    }
  }
}

export interface PortraitConsistencyInspection {
  status: 'preserved' | 'uncertain' | 'drifted'
  warnings: string[]
}

const CONSISTENCY_PROMPT = [
  '第一张图片是本人主参考，后面的图片是候选结果。只判断可见特征是否保持，不做身份认证。严格输出 JSON:',
  '{"images":[{"status":"preserved"}]}',
  'status 只能是 preserved、uncertain、drifted。若候选脸型、五官、年龄观感明显变化，返回 drifted；无法确定返回 uncertain。',
].join('\n')

export async function inspectPortraitConsistency(
  reference: QcImage,
  candidates: QcImage[],
  opts: { model?: Model | null; signal?: AbortSignal } = {},
): Promise<PortraitConsistencyInspection> {
  if (!opts.model || !reference.base64 || !candidates.some(item => item.base64)) {
    return { status: 'uncertain', warnings: ['参考图与成图的一致性未完成自动检查,请并排确认是否像本人。'] }
  }
  const parsed = await askVlmJson(opts.model, '你是参考图一致性风险筛查助手。', CONSISTENCY_PROMPT, [reference, ...candidates], 5, opts.signal)
  const statuses = parsed && Array.isArray(parsed.images)
    ? parsed.images.map(item => item && typeof item === 'object' ? String((item as Record<string, unknown>).status ?? '') : '')
    : []
  if (statuses.includes('drifted')) return { status: 'drifted', warnings: ['参考图与候选的人物特征疑似发生明显漂移,不标推荐。'] }
  if (!statuses.length || statuses.includes('uncertain')) return { status: 'uncertain', warnings: ['参考图与候选的一致性无法完全确认,请并排确认是否像本人。'] }
  return { status: 'preserved', warnings: [] }
}

// --- 海报硬文字 OCR 校对(生成后) ----------------------------------------

const OCR_SYSTEM = '你是海报文字校对助手。只读出图中真实可见的文字,严格输出 JSON,不要翻译、不要解释、不要补全。'

const OCR_PROMPT = [
  '读出图中所有清晰可见的文字,严格输出 JSON,形如:',
  '{"texts":["第一行文字","第二块文字"]}',
  '逐行/逐块列出你实际看到的文字,看不清就不要写。',
].join('\n')

export interface HardTextOcrResult {
  status: 'ocr_matched' | 'ocr_mismatch' | 'pending_ocr'
  found: string[]
  missing: string[]
  message: string
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，。、！？!?.,:;：；]/g, '').toLowerCase()
}

/**
 * 硬文字 OCR 校对:让 VLM 读出成图里的文字,和用户显式要求的文案逐条比对,标出疑似缺字/错字。
 * 模型缺位/读不出 → 退回 pending_ocr(保持"投放前人工核对"的既有口径,不假装已核对)。
 */
export async function proofreadHardText(images: QcImage[], expected: string[], opts: { model?: Model | null; signal?: AbortSignal } = {}): Promise<HardTextOcrResult> {
  const model = opts.model
  const clean = expected.map(e => e.trim()).filter(Boolean)
  if (!model || !images.some(i => i.base64) || clean.length === 0) {
    return { status: 'pending_ocr', found: [], missing: clean, message: '投放前请人工核对海报文字是否正确。' }
  }
  try {
    const parsed = await askVlmJson(model, OCR_SYSTEM, OCR_PROMPT, images, 2, opts.signal)
    const rawTexts = parsed && Array.isArray(parsed.texts) ? parsed.texts : null
    if (!rawTexts) {
      return { status: 'pending_ocr', found: [], missing: clean, message: '未能自动读出海报文字,投放前请人工核对文案是否正确。' }
    }
    const found = rawTexts.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim())
    const foundJoined = normalizeForCompare(found.join(' '))
    const missing = clean.filter(e => !foundJoined.includes(normalizeForCompare(e)))
    if (missing.length === 0) {
      return { status: 'ocr_matched', found, missing: [], message: '已自动核对海报文字,要求的文案均已出现且未见明显缺字。' }
    }
    return {
      status: 'ocr_mismatch',
      found,
      missing,
      message: scrubProviderIdentifiers(`海报文字疑似有出入,请人工核对:${missing.join('、')}`),
    }
  } catch {
    return { status: 'pending_ocr', found: [], missing: clean, message: '文字自动核对失败,投放前请人工核对海报文案是否正确。' }
  }
}
