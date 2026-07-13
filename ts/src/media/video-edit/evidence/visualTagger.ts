// VLM 只补充镜头 evidence。它不写营销文案、不决定用户目标，也不直接生成时间线。
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
  /** 兼容旧响应；V2 不消费模型生成字卡。 */
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
  /** 仅兼容旧调用；没有用户提供文字时保持为空。 */
  captionPool?: string[]
  /** 显式允许把含人脸关键帧发网关(默认 false=保护隐私走离线)。 */
  allowFaces?: boolean
}

const DEFAULT_CAPTION_POOL: string[] = []

const VLM_SYSTEM = '你是视频素材证据分析器。只描述画面中实际可见的主体、景别、动作和技术风险，并给出保守的镜头顺序建议。不得补充营销目标、价格、CTA、人物设定、业务知识或画面中不存在的事实。只输出 JSON。'

function clampCaption(text: string, max = 16): string {
  const t = text.replace(/\s+/g, '').trim()
  return t.length > max ? `${t.slice(0, max)}` : t
}

/** 组多模态 prompt:文字说明 + 每个有缩略图的镜头一张 image block。纯函数,可单测。 */
export function buildTagMessages(shots: ShotForTag[]): Message[] {
  const withThumb = shots.filter(s => s.thumbBase64)
  const lines = [
    `一共 ${withThumb.length} 个用户视频镜头，按 index 提供缩略图。`,
    '请输出严格 JSON,形如:',
    '{"shots":[{"index":0,"tag":"室内全景"}],"order":[0,1,2],"drop":[],"grade":"neutral"}',
    '- tag 只写实际可见证据，例如室内全景、人物交谈、动作近景、物品细节、入口标识；看不清就写不确定。',
    '- order 只按建立关系、动作完整性、视觉连续性和技术可用性建议，不假设视频用途。',
    '- drop 只标明显黑帧、失焦、严重抖动或重复镜头。grade 可为 warm/cool/neutral。',
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
    void captions
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
    tags[idx] = '未分类镜头'
    if (pool.length) captions[idx] = clampCaption(pool[pos % pool.length]!)
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
    // 缺失标签用中性本地证据补位，不补业务文案。
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
