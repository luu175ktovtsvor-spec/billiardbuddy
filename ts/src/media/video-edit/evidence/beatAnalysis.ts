// B-Roll 五步之三:音乐卡点(beat sync)。
//
// ⚠️ 不装任何 npm 包(不动 package.json)——手写 Ellis 法节拍检测:
//   ① onset 强度包络(分帧能量的正向差分)→ ② 自相关估 tempo(带 ~120BPM 偏好窗)
//   → ③ 梳状/贪心跟踪把拍点落到 onset 峰上。BGM 抽成 f32le PCM 喂进来。
// 卡点方式:把镜头切点吸附到最近鼓点(snapToBeats),或让每个镜头时长 = 整数拍
//   (planBeatDurations),这样从拍点起播,切点自然落在鼓点上。
// 缺 ffmpeg / 无 BGM / 检测失败 → 返回 null,调用方退"等分/节奏"时长,绝不崩。

import { existsSync } from 'node:fs'
import { ffmpegBinFrom, runFfmpegBinary } from './ffmpeg'

export const PCM_SAMPLE_RATE = 22050
export const ONSET_HOP = 512
export const MIN_BPM = 70
export const MAX_BPM = 180

export interface BeatResult {
  tempo: number
  beats: number[]
  period: number
}

export interface OnsetEnvelope {
  env: number[]
  fps: number
}

export interface BeatDetectOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  timeoutMs?: number
  sampleRate?: number
  hopSize?: number
}

/** 分帧能量的正向差分 = onset 强度包络。纯函数,可单测。 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number, hopSize = ONSET_HOP): OnsetEnvelope {
  const frames = Math.max(0, Math.floor(samples.length / hopSize))
  const energy = new Array<number>(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const base = f * hopSize
    for (let i = 0; i < hopSize; i++) {
      const s = samples[base + i] ?? 0
      sum += s * s
    }
    energy[f] = Math.sqrt(sum / hopSize)
  }
  // 正向差分(half-wave rectified)——只留能量上升,近似起音。
  const env = new Array<number>(frames).fill(0)
  for (let f = 1; f < frames; f++) {
    const diff = (energy[f] ?? 0) - (energy[f - 1] ?? 0)
    env[f] = diff > 0 ? diff : 0
  }
  return { env, fps: sampleRate / hopSize }
}

function autocorrAt(env: number[], lag: number): number {
  let sum = 0
  for (let i = lag; i < env.length; i++) sum += (env[i] ?? 0) * (env[i - lag] ?? 0)
  return sum
}

/**
 * 自相关估 tempo(BPM)。在 [MIN_BPM,MAX_BPM] 对应的 lag 范围找自相关峰,
 * 叠一个以 120BPM 为中心的对数高斯偏好窗(抄 Ellis,避免选到半速/倍速)。纯函数。
 */
export function estimateTempo(env: number[], fps: number, opts: { minBpm?: number; maxBpm?: number } = {}): number {
  const minBpm = opts.minBpm ?? MIN_BPM
  const maxBpm = opts.maxBpm ?? MAX_BPM
  if (env.length < 4 || fps <= 0) return 0
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * fps))
  const maxLag = Math.max(minLag + 1, Math.ceil((60 / minBpm) * fps))
  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag && lag < env.length; lag++) {
    const bpm = (60 * fps) / lag
    // 对数高斯偏好窗,中心 120BPM。
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2))
    const score = autocorrAt(env, lag) * w
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  return Math.round(((60 * fps) / bestLag) * 10) / 10
}

/**
 * 贪心/梳状拍点跟踪:从第一个较强 onset 起,按 tempo 周期前进,每步在期望位置 ±窗内
 * 找 onset 局部峰,落一个拍点。返回拍点秒数组。纯函数。
 */
export function trackBeats(env: number[], fps: number, tempo: number): number[] {
  if (tempo <= 0 || fps <= 0 || env.length < 2) return []
  const period = (60 / tempo) * fps // 每拍多少帧
  if (!(period >= 1)) return []
  const win = Math.max(1, Math.round(period * 0.15))
  // 起点:前 2 拍内最强的 onset。
  let start = 0
  let startVal = -Infinity
  const scanEnd = Math.min(env.length, Math.ceil(period * 2))
  for (let i = 0; i < scanEnd; i++) {
    if ((env[i] ?? 0) > startVal) {
      startVal = env[i] ?? 0
      start = i
    }
  }
  const beats: number[] = []
  let expected = start
  while (expected < env.length) {
    const lo = Math.max(0, Math.round(expected - win))
    const hi = Math.min(env.length - 1, Math.round(expected + win))
    let peak = Math.round(expected)
    let peakVal = -Infinity
    for (let i = lo; i <= hi; i++) {
      if ((env[i] ?? 0) > peakVal) {
        peakVal = env[i] ?? 0
        peak = i
      }
    }
    beats.push(Math.round((peak / fps) * 1000) / 1000)
    // 下一拍以实测峰为基准前进,吸附漂移。
    expected = peak + period
  }
  return beats
}

/** 包络 → tempo → 拍点。纯函数聚合。 */
export function detectBeatsFromEnvelope(env: number[], fps: number): BeatResult {
  const tempo = estimateTempo(env, fps)
  const beats = trackBeats(env, fps, tempo)
  const period = tempo > 0 ? Math.round((60 / tempo) * 1000) / 1000 : 0
  return { tempo, beats, period }
}

/** PCM → 拍点。 */
export function detectBeats(samples: Float32Array, sampleRate: number, hopSize = ONSET_HOP): BeatResult {
  const { env, fps } = onsetEnvelope(samples, sampleRate, hopSize)
  return detectBeatsFromEnvelope(env, fps)
}

/** 拍点间隔中位数(比均值抗漏拍/多拍)。纯函数。 */
export function beatPeriodFromBeats(beats: number[]): number {
  if (beats.length < 2) return 0
  const diffs: number[] = []
  for (let i = 1; i < beats.length; i++) diffs.push(beats[i]! - beats[i - 1]!)
  diffs.sort((a, b) => a - b)
  const mid = Math.floor(diffs.length / 2)
  const median = diffs.length % 2 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2
  return Math.round(median * 1000) / 1000
}

/** 把切点吸附到最近鼓点(超出 maxShiftSec 的不动)。纯函数,可单测。 */
export function snapToBeats(cutTimes: number[], beats: number[], maxShiftSec = 0.12): number[] {
  if (!beats.length) return cutTimes.slice()
  return cutTimes.map(t => {
    let best = t
    let bestDist = maxShiftSec
    for (const b of beats) {
      const d = Math.abs(b - t)
      if (d <= bestDist) {
        bestDist = d
        best = b
      }
    }
    return Math.round(best * 1000) / 1000
  })
}

export interface BeatDurationOptions {
  beatsPerShot?: number
  targetDuration?: number
  minDur?: number
  maxDur?: number
}

/**
 * 每个镜头分一个"整数拍"时长(从拍点起播则切点自然落鼓点)。纯函数,可单测。
 * 无节拍信息(period<=0)→ 退等分(targetDuration/shotCount),再 clamp。
 */
export function planBeatDurations(shotCount: number, period: number, opts: BeatDurationOptions = {}): number[] {
  const minDur = opts.minDur ?? 1.2
  const maxDur = opts.maxDur ?? 6
  const beatsPerShot = Math.max(1, Math.round(opts.beatsPerShot ?? 2))
  const clampDur = (d: number) => Math.round(Math.min(maxDur, Math.max(minDur, d)) * 1000) / 1000
  if (shotCount <= 0) return []
  if (period > 0) {
    const dur = clampDur(period * beatsPerShot)
    return new Array<number>(shotCount).fill(dur)
  }
  const target = opts.targetDuration ?? shotCount * 3
  return new Array<number>(shotCount).fill(clampDur(target / shotCount))
}

/** 抽 BGM 的 f32le 单声道 PCM。缺 ffmpeg / 失败 → null。 */
export async function extractPcm(musicPath: string, opts: BeatDetectOptions = {}): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  if (!/^https?:/i.test(musicPath) && !existsSync(musicPath)) return null
  const sampleRate = opts.sampleRate ?? PCM_SAMPLE_RATE
  try {
    const res = await runFfmpegBinary(ffmpegBinFrom(opts.env), [
      '-hide_banner', '-loglevel', 'error',
      '-i', musicPath,
      '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-f', 'f32le', '-',
    ], { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 2 * 60_000 })
    if (!res.stdout.length) return null
    // Buffer → Float32Array(用 readFloatLE 逐个读,避开 Buffer.concat 的非 4 对齐偏移导致 RangeError)。
    const n = Math.floor(res.stdout.length / 4)
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = res.stdout.readFloatLE(i * 4)
    return { samples, sampleRate }
  } catch {
    return null
  }
}

/** 对一首 BGM 检测节拍。缺 ffmpeg / 无音频 / 失败 → null(调用方退等分节奏)。 */
export async function beatsForMusic(musicPath: string, opts: BeatDetectOptions = {}): Promise<BeatResult | null> {
  const pcm = await extractPcm(musicPath, opts)
  if (!pcm) return null
  const result = detectBeats(pcm.samples, pcm.sampleRate, opts.hopSize ?? ONSET_HOP)
  return result.beats.length ? result : null
}
