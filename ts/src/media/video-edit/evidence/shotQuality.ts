// B-Roll 五步之二:镜头质量 / 美学选段(纯 ffmpeg 启发式,无 ML)。
//
// 每个镜头抽样几帧算 signalstats:YAVG(曝光)+ YDIF(帧间差=运动/生动度),
// 复刻 auto-editor 的 motion + blackdetect 思路:太黑淘汰、冻结/发呆淘汰、
// 曝光偏离中间调扣分、几乎静止扣分、过抖(YDIF 过大)扣分,综合分排序砍差的。
// 全本地零依赖(bundled ffmpeg + 轻量 TS 计算),语义好坏交给第 3 步 VLM。

import { existsSync } from 'node:fs'
import { ffmpegBinFrom, runFfmpegText } from './ffmpeg'
import type { Shot } from './shotDetection'

/** 曝光/运动的判定档(YAVG/YDIF 均为 0~255 尺度)。 */
export const EXPOSURE_MIN = 40
export const EXPOSURE_MAX = 220
export const BLACK_LUMA = 16 // 平均亮度低于此当黑场淘汰
export const MOTION_IDEAL_LOW = 1.5 // 帧间差低于此偏"发呆/静止"
export const MOTION_IDEAL_HIGH = 14 // 高于此偏"手持抖动废镜"
export const FROZEN_MOTION = 0.15 // 帧间差近 0(多帧)判冻结

export interface ShotMetrics {
  avgLuma: number
  avgMotion: number
  frames: number
}

export interface CandidateShot {
  id: string
  mediaId: string
  start: number
  end: number
  index: number
  metrics?: ShotMetrics
}

export interface ScoredShot extends CandidateShot {
  score: number
  keep: boolean
  reason?: string
}

export interface SelectOptions {
  maxShots?: number
  minScore?: number
}

export interface ShotMetricOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutMs?: number
  fps?: number
}

/** 解析 signalstats + metadata=print 的 stderr,收所有 YAVG / YDIF。纯函数,可单测。 */
export function parseSignalstats(stderr: string): { yavg: number[]; ydif: number[] } {
  const yavg: number[] = []
  const ydif: number[] = []
  for (const line of stderr.split(/\r?\n/)) {
    const a = line.match(/lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)/)
    if (a) yavg.push(Number.parseFloat(a[1]!))
    const d = line.match(/lavfi\.signalstats\.YDIF=([0-9]+(?:\.[0-9]+)?)/)
    if (d) ydif.push(Number.parseFloat(d[1]!))
  }
  return { yavg, ydif }
}

function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

/** 把采样到的 YAVG/YDIF 汇成一个镜头的指标。纯函数。 */
export function summarizeMetrics(stats: { yavg: number[]; ydif: number[] }): ShotMetrics {
  return { avgLuma: mean(stats.yavg), avgMotion: mean(stats.ydif), frames: stats.yavg.length }
}

function rampScore(value: number, lo: number, hi: number): number {
  // value 落在 [lo,hi] 内给 1;偏出线性衰减,越远越低(不小于 0)。
  if (value >= lo && value <= hi) return 1
  const span = hi - lo || 1
  const dist = value < lo ? lo - value : value - hi
  return Math.max(0, 1 - dist / span)
}

/** 单镜头综合分(0~1)。无指标 → 中性 0.6(靠后续 VLM/时长节奏决定)。纯函数。 */
export function scoreShot(m: ShotMetrics | undefined): number {
  if (!m || m.frames === 0) return 0.6
  const exposure = rampScore(m.avgLuma, EXPOSURE_MIN, EXPOSURE_MAX)
  const motion = rampScore(m.avgMotion, MOTION_IDEAL_LOW, MOTION_IDEAL_HIGH)
  return Math.round((0.6 * exposure + 0.4 * motion) * 1000) / 1000
}

/** 是否黑场(平均亮度过低)。 */
export function isBlackShot(m: ShotMetrics | undefined): boolean {
  return !!m && m.frames > 0 && m.avgLuma < BLACK_LUMA
}

/** 是否冻结/静止(多帧但帧间差近 0)。 */
export function isFrozenShot(m: ShotMetrics | undefined): boolean {
  return !!m && m.frames >= 3 && m.avgMotion < FROZEN_MOTION
}

/**
 * 打分 + 排序 + 淘汰。黑场/冻结直接淘汰(keep=false);其余按分降序,超 maxShots 的截掉。
 * 纯函数,可单测。返回按分排好的镜头(含被淘汰的,keep 标记),调用方取 keep 的用。
 */
export function selectAndRankShots(shots: CandidateShot[], opts: SelectOptions = {}): ScoredShot[] {
  const scored: ScoredShot[] = shots.map(s => {
    const score = scoreShot(s.metrics)
    if (isBlackShot(s.metrics)) return { ...s, score, keep: false, reason: '黑场淘汰' }
    if (isFrozenShot(s.metrics)) return { ...s, score, keep: false, reason: '画面冻结/发呆淘汰' }
    if (opts.minScore !== undefined && score < opts.minScore) return { ...s, score, keep: false, reason: '质量分过低' }
    return { ...s, score, keep: true }
  })
  const kept = scored.filter(s => s.keep).sort((a, b) => b.score - a.score || a.index - b.index)
  const dropped = scored.filter(s => !s.keep)
  if (opts.maxShots !== undefined && kept.length > opts.maxShots) {
    for (const s of kept.slice(opts.maxShots)) {
      s.keep = false
      s.reason = '超出目标镜头数'
    }
  }
  return [...kept, ...dropped]
}

/** 对一个镜头抽样测指标。缺 ffmpeg / 失败 → undefined(调用方按中性分处理)。 */
export async function measureShot(src: string, shot: Shot, opts: ShotMetricOptions = {}): Promise<ShotMetrics | undefined> {
  if (!/^https?:/i.test(src) && !existsSync(src)) return undefined
  const len = Math.max(0.1, shot.end - shot.start)
  const fps = opts.fps ?? 3
  try {
    const res = await runFfmpegText(ffmpegBinFrom(opts.env), [
      '-hide_banner', '-nostats',
      '-ss', String(Math.max(0, shot.start)),
      '-t', String(len),
      '-i', src,
      '-vf', `fps=${fps},signalstats,metadata=mode=print`,
      '-an', '-f', 'null', '-',
    ], { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 60_000 })
    const stats = parseSignalstats(res.stderr)
    if (!stats.yavg.length) return undefined
    return summarizeMetrics(stats)
  } catch {
    return undefined
  }
}
