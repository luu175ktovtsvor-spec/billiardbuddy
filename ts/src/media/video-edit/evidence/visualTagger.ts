// B-Roll 五步之四:VLM 看懂每镜头(打标签 + 按营销叙事排序)。
//
// 走网关 VLM(= agent 自己那颗多模态模型),复用 providerConfigFromEnv + 现有模型出口
// (Anthropic content-block 图片,proxy 自动翻 OpenAI image_url),白标、内置 key、用户零配置。
// 离线/无网/无关键帧/含清晰人脸 → 降级到纯启发式排序,保证断网也能出片。
// 隐私护栏:关键帧含可识别人脸(尤其未成年)时不外传,直接走离线启发式(见根 CLAUDE.md 脱敏红线)。

import { existsSync } from 'node:fs'
import type { Model } from '../../../types/model'
import type { ContentBlock, Message } from '../../../types/message'
import { providerConfigFromEnv } from '../../../model/providerConfig'
import { createModelFromProviderConfig } from '../../../model/modelFactory'
import { ffmpegBinFrom, runFfmpegBinary } from './ffmpeg'
import type { Shot } from './shotDetection'

export interface ShotForTag {
  index: number
  mediaId: string
  start: number
  end: number
  durationSec: number
  avgLuma?: number
  avgMotion?: number
  isPortrait?: boolean
  hasFace?: boolean
  thumbBase64?: string
}

export interface BrollPlan {
  /** 叙事顺序(镜头 index 的排列,已去掉 drop 的)。 */
  order: number[]
  /** index → 标签。 */
  tags: Record<number, string>
  /** index → 门店卖点字卡。 */
  captions: Record<number, string>
  /** 建议丢弃的镜头 index。 */
  drop: number[]
  /** 建议统一调色(null=不建议)。 */
  grade: string | null
  usedVlm: boolean
  reason: string
}

export interface TagOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  /** 注入模型(测试用);不给则按 env 构造网关模型。 */
  model?: Model | null
  /** 门店卖点字卡候选池(离线启发式循环用);不给用通用中性池。 */
  captionPool?: string[]
  /** 显式允许把含人脸关键帧发网关(默认 false=保护隐私走离线)。 */
  allowFaces?: boolean
}

const DEFAULT_CAPTION_POOL = [
  '灯光通透的球厅环境',
  '专业台呢台面细节',
  '约上好友来一局',
  '安静舒适的打球空间',
  '干净整洁的器材区',
  '氛围感拉满的夜场',
]

const VLM_SYSTEM = '你是门店短视频剪辑助手。看图给每个镜头打中文标签、排营销叙事顺序、写一句门店卖点字卡。只输出 JSON,不要解释。'

function clampCaption(text: string, max = 16): string {
  const t = text.replace(/\s+/g, '').trim()
  return t.length > max ? `${t.slice(0, max)}` : t
}

/** 组多模态 prompt:文字说明 + 每个有缩略图的镜头一张 image block。纯函数,可单测。 */
export function buildTagMessages(shots: ShotForTag[]): Message[] {
  const withThumb = shots.filter(s => s.thumbBase64)
  const lines = [
    `一共 ${withThumb.length} 个门店镜头,按顺序给你缩略图(第 0 张对应 index=${withThumb[0]?.index ?? 0},以此类推)。`,
    '请输出严格 JSON,形如:',
    '{"shots":[{"index":0,"tag":"台球桌特写","caption":"专业台面细节"}],"order":[0,1,2],"drop":[],"grade":"warm"}',
    '- tag:台球桌特写/球厅环境/顾客打球/吧台器材/灯光氛围/门头招牌 等。',
    '- order:按"门头或环境远景开场→台面器材细节→顾客氛围→高光收尾"的营销叙事排镜头 index。',
    '- caption:每镜头一句 ≤14 字的门店卖点,别用绝对化广告词。',
    '- drop:跑题/重复/不宜的镜头 index(可空)。grade:warm/cool/neutral(可空)。',
  ]
  const content: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const s of withThumb) {
    content.push({ type: 'text', text: `index=${s.index}` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.thumbBase64! } })
  }
  return [{ role: 'user', content }]
}

/** 从模型返回的文本里抠出第一个 JSON 对象。纯函数。 */
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

/**
 * 解析 VLM 返回 → 规范化 BrollPlan。只保留 validIndices 内的 index;
 * order 补齐遗漏的、剔除 drop 的;解析失败返回 null(调用方退启发式)。纯函数,可单测。
 */
export function parseVlmPlan(text: string, validIndices: number[]): Omit<BrollPlan, 'usedVlm' | 'reason'> | null {
  const parsed = extractJson(text)
  if (!parsed || typeof parsed !== 'object') return null
  const root = parsed as Record<string, unknown>
  const valid = new Set(validIndices)
  const tags: Record<number, string> = {}
  const captions: Record<number, string> = {}
  const shotsArr = Array.isArray(root.shots) ? root.shots : []
  for (const raw of shotsArr) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as Record<string, unknown>
    const idx = typeof s.index === 'number' ? s.index : Number(s.index)
    if (!Number.isFinite(idx) || !valid.has(idx)) continue
    if (typeof s.tag === 'string' && s.tag.trim()) tags[idx] = s.tag.trim().slice(0, 12)
    if (typeof s.caption === 'string' && s.caption.trim()) captions[idx] = clampCaption(s.caption)
  }
  const drop = Array.isArray(root.drop)
    ? root.drop.map(v => (typeof v === 'number' ? v : Number(v))).filter(v => Number.isFinite(v) && valid.has(v))
    : []
  const dropSet = new Set(drop)
  const rawOrder = Array.isArray(root.order)
    ? root.order.map(v => (typeof v === 'number' ? v : Number(v))).filter(v => Number.isFinite(v) && valid.has(v) && !dropSet.has(v))
    : []
  const seen = new Set<number>()
  const order: number[] = []
  for (const i of rawOrder) if (!seen.has(i)) { seen.add(i); order.push(i) }
  // 补齐 VLM 漏排的镜头(按原序追加)。
  for (const i of validIndices) if (!dropSet.has(i) && !seen.has(i)) { seen.add(i); order.push(i) }
  const grade = typeof root.grade === 'string' && root.grade.trim() ? root.grade.trim().slice(0, 16) : null
  return { order, tags, captions, drop, grade }
}

/** 是否触发隐私护栏(任一镜头含人脸)。纯函数。 */
export function faceGuardActive(shots: ShotForTag[]): boolean {
  return shots.some(s => s.hasFace)
}

/** 离线启发式排序 + 通用卖点(断网也能出片)。纯函数,可单测。 */
export function heuristicPlan(shots: ShotForTag[], opts: { captionPool?: string[]; reason?: string } = {}): BrollPlan {
  const pool = opts.captionPool && opts.captionPool.length ? opts.captionPool : DEFAULT_CAPTION_POOL
  const indices = shots.map(s => s.index)
  const haveMetrics = shots.some(s => s.avgLuma !== undefined || s.avgMotion !== undefined)
  let order = indices.slice()
  if (haveMetrics && shots.length >= 3) {
    // 开场 = 最亮(通透环境/远景);收尾 = 运动最强(高光);中间按原序。
    const byIndex = new Map(shots.map(s => [s.index, s]))
    const opener = shots.slice().sort((a, b) => (b.avgLuma ?? 0) - (a.avgLuma ?? 0))[0]!.index
    const closer = shots.slice().sort((a, b) => (b.avgMotion ?? 0) - (a.avgMotion ?? 0))[0]!.index
    const middle = indices.filter(i => i !== opener && i !== closer)
    order = closer !== opener ? [opener, ...middle, closer] : [opener, ...middle]
    void byIndex
  }
  const tags: Record<number, string> = {}
  const captions: Record<number, string> = {}
  order.forEach((idx, pos) => {
    tags[idx] = '门店镜头'
    captions[idx] = pool[pos % pool.length]!
  })
  return { order, tags, captions, drop: [], grade: null, usedVlm: false, reason: opts.reason ?? '离线启发式(未走网关 VLM)' }
}

/** 按 env 构造网关 VLM 模型;缺配置 → null。 */
export function buildVlmModel(env: Record<string, string | undefined> | undefined): Model | null {
  const cfg = providerConfigFromEnv(env ?? process.env)
  if (!cfg) return null
  try {
    return createModelFromProviderConfig(cfg)
  } catch {
    return null
  }
}

/**
 * 主入口:给镜头打标签 + 排叙事顺序。
 * 隐私护栏 → 无模型/无关键帧 → 模型报错/无法解析,任一情形都优雅降级到启发式,绝不崩。
 */
export async function tagShots(shots: ShotForTag[], opts: TagOptions = {}): Promise<BrollPlan> {
  if (!shots.length) return { order: [], tags: {}, captions: {}, drop: [], grade: null, usedVlm: false, reason: '无镜头' }
  const validIndices = shots.map(s => s.index)

  if (faceGuardActive(shots) && !opts.allowFaces) {
    return heuristicPlan(shots, { captionPool: opts.captionPool, reason: '关键帧含清晰人脸,为保护隐私走离线启发式(不外传人脸)' })
  }

  const model = opts.model !== undefined ? opts.model : buildVlmModel(opts.env)
  const withThumb = shots.filter(s => s.thumbBase64)
  if (!model || withThumb.length === 0) {
    return heuristicPlan(shots, { captionPool: opts.captionPool, reason: !model ? '网关 VLM 未配置,离线启发式' : '无可用关键帧,离线启发式' })
  }

  try {
    const step = await model.step({ system: VLM_SYSTEM, messages: buildTagMessages(shots), tools: [], signal: opts.signal })
    const text = step.text ?? ''
    const parsed = parseVlmPlan(text, validIndices)
    if (!parsed) return heuristicPlan(shots, { captionPool: opts.captionPool, reason: 'VLM 返回无法解析,退启发式' })
    // 卖点/标签缺的用启发式补位。
    const fallback = heuristicPlan(shots, { captionPool: opts.captionPool })
    const tags = { ...fallback.tags, ...parsed.tags }
    const captions = { ...fallback.captions, ...parsed.captions }
    return { ...parsed, tags, captions, usedVlm: true, reason: '网关 VLM 打标签+排序' }
  } catch {
    return heuristicPlan(shots, { captionPool: opts.captionPool, reason: 'VLM 调用失败,退启发式' })
  }
}

export interface KeyframeOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutMs?: number
  width?: number
}

/** 抽某镜头一张代表帧(seek 到中点)→ 缩到 512px JPEG → base64。缺 ffmpeg / 失败 → null。 */
export async function extractKeyframeBase64(src: string, shot: Shot, opts: KeyframeOptions = {}): Promise<string | null> {
  if (!/^https?:/i.test(src) && !existsSync(src)) return null
  const mid = Math.max(0, (shot.start + shot.end) / 2)
  const width = opts.width ?? 512
  try {
    const res = await runFfmpegBinary(ffmpegBinFrom(opts.env), [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(mid),
      '-i', src,
      '-frames:v', '1',
      '-vf', `scale=${width}:-1`,
      '-f', 'image2', '-c:v', 'mjpeg', '-',
    ], { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 30_000 })
    if (!res.stdout.length) return null
    return res.stdout.toString('base64')
  } catch {
    return null
  }
}
